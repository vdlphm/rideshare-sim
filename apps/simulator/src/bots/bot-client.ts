import type { LatLng, Offer, TripDetail, Vehicle } from '@rideshare/contracts';

export type Result<T> =
  { ok: true; status: number; data: T } | { ok: false; status: number; message: string };

/** What the bots need from a driver account (implemented by BotClient, faked in tests). */
export interface DriverApi {
  ensureAccount(): Promise<Result<void>>;
  driverMe(): Promise<Result<DriverMe>>;
  goOnline(pos: LatLng): Promise<Result<void>>;
  goOffline(): Promise<Result<void>>;
  postLocation(pos: LatLng, heading: number): Promise<Result<void>>;
  getOffer(): Promise<Result<Offer | null>>;
  acceptOffer(offerId: string): Promise<Result<{ tripId: string }>>;
  declineOffer(offerId: string): Promise<Result<void>>;
  getTrip(tripId: string): Promise<Result<TripDetail>>;
  arrive(tripId: string): Promise<Result<void>>;
  startTrip(tripId: string): Promise<Result<void>>;
  completeTrip(tripId: string): Promise<Result<void>>;
}

export interface RiderApi {
  ensureAccount(): Promise<Result<void>>;
  riderLocation(pos: LatLng): Promise<Result<void>>;
  requestRide(body: { pickup?: LatLng; dropoff: LatLng }): Promise<Result<{ tripId: string }>>;
  getTrip(tripId: string): Promise<Result<TripDetail>>;
}

export interface DriverMe {
  driverId?: string;
  status: 'OFFLINE' | 'AVAILABLE' | 'ON_TRIP';
  tripId: string | null;
  lat?: number;
  lng?: number;
  heading?: number;
}

export interface Account {
  email: string;
  password: string;
  name: string;
  role: 'driver' | 'rider';
  vehicle?: Vehicle;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface BotClientOptions {
  baseUrl: string;
  account: Account;
  fetch?: FetchLike;
  /** Real clock in ms since epoch. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Refresh when less than this much validity remains. Default 60 000 ms. */
  refreshSkewMs?: number;
  /** Attempts for idempotent calls (network errors / 5xx). Default 3. */
  maxAttempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
}

interface Tokens {
  access: string;
  refresh: string;
  expiresAt: number;
}

interface CallOptions {
  idempotent?: boolean;
  auth?: boolean;
}

const fail = (status: number, message: string): Result<never> => ({ ok: false, status, message });

/** Reads `exp` (seconds) from a JWT payload without verifying it; returns ms or undefined. */
export function jwtExpiryMs(token: string): number | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * HTTP client for ONE bot account, talking to the gateway. Keeps the access token fresh
 * (refresh ~60 s before exp, always storing the rotated refresh token, re-login when the refresh
 * fails), refreshes once on a 401, retries network errors/5xx only for idempotent calls, and
 * returns discriminated results instead of throwing for HTTP errors.
 */
export class BotClient implements DriverApi, RiderApi {
  private readonly base: string;
  private readonly doFetch: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly skewMs: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly timeoutMs: number;
  private tokens?: Tokens;
  private authInflight?: Promise<Result<void>>;
  private ready = false;

  constructor(private readonly opts: BotClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.doFetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.skewMs = opts.refreshSkewMs ?? 60_000;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 200;
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  // ---- account / auth ------------------------------------------------------------------

  /** Registers the account; on 409 (already exists) logs in instead. Cheap once done. */
  async ensureAccount(): Promise<Result<void>> {
    if (this.ready && this.tokens) return { ok: true, status: 200, data: undefined };
    const { email, password, name, role, vehicle } = this.opts.account;
    const res = await this.raw('POST', '/api/users', {
      email,
      password,
      name,
      role,
      ...(role === 'driver' ? { vehicle } : {}),
    });
    if (!res.ok && res.status !== 409) return res;
    const login = await this.login();
    if (login.ok) this.ready = true;
    return login;
  }

  private login(): Promise<Result<void>> {
    return this.singleFlightAuth(async () => {
      const { email, password } = this.opts.account;
      return this.storeTokens(await this.raw('POST', '/api/auth/login', { email, password }));
    });
  }

  private async refreshOrLogin(): Promise<Result<void>> {
    return this.singleFlightAuth(async () => {
      if (this.tokens) {
        const res = await this.raw('POST', '/api/auth/refresh', {
          refreshToken: this.tokens.refresh,
        });
        const stored = this.storeTokens(res);
        if (stored.ok) return stored;
      }
      const { email, password } = this.opts.account;
      return this.storeTokens(await this.raw('POST', '/api/auth/login', { email, password }));
    });
  }

  private singleFlightAuth(fn: () => Promise<Result<void>>): Promise<Result<void>> {
    this.authInflight ??= fn().finally(() => {
      this.authInflight = undefined;
    });
    return this.authInflight;
  }

  private storeTokens(res: Result<unknown>): Result<void> {
    if (!res.ok) return res;
    const body = res.data as { accessToken?: string; refreshToken?: string } | undefined;
    if (!body?.accessToken || !body.refreshToken) return fail(502, 'malformed token response');
    this.tokens = {
      access: body.accessToken,
      refresh: body.refreshToken,
      expiresAt: jwtExpiryMs(body.accessToken) ?? this.now() + 10 * 60_000,
    };
    return { ok: true, status: res.status, data: undefined };
  }

  private async ensureToken(): Promise<Result<void>> {
    if (!this.tokens) return this.login();
    if (this.tokens.expiresAt - this.now() < this.skewMs) return this.refreshOrLogin();
    return { ok: true, status: 200, data: undefined };
  }

  // ---- request core --------------------------------------------------------------------

  /** Single HTTP exchange without auth handling or retries. */
  private async raw(
    method: string,
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<Result<unknown>> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.base}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      return fail(0, err instanceof Error ? err.message : String(err));
    }
    const text = await res.text().catch(() => '');
    let data: unknown;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, data };
    const message =
      typeof data === 'object' && data !== null && 'message' in data
        ? String((data as { message: unknown }).message)
        : text || res.statusText || `HTTP ${res.status}`;
    return fail(res.status, message);
  }

  private async call<T = void>(
    method: string,
    path: string,
    body?: unknown,
    { idempotent = false, auth = true }: CallOptions = {},
  ): Promise<Result<T>> {
    const attempts = idempotent ? this.maxAttempts : 1;
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      let token: string | undefined;
      if (auth) {
        const ok = await this.ensureToken();
        if (!ok.ok) return ok;
        token = this.tokens?.access;
      }
      const res = await this.raw(method, path, body, token);
      if (!res.ok && res.status === 401 && auth && !refreshed) {
        refreshed = true;
        const again = await this.refreshOrLogin();
        if (!again.ok) return again;
        attempt--; // the 401 retry does not consume a retry attempt
        continue;
      }
      const retryable = !res.ok && (res.status === 0 || res.status >= 500);
      if (retryable && attempt < attempts) {
        await this.sleep(this.baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random() / 2));
        continue;
      }
      return res as Result<T>;
    }
  }

  private void_<T>(res: Result<T>): Result<void> {
    return res.ok ? { ok: true, status: res.status, data: undefined } : res;
  }

  // ---- driver --------------------------------------------------------------------------

  async driverMe(): Promise<Result<DriverMe>> {
    return this.call<DriverMe>('GET', '/api/drivers/me', undefined, { idempotent: true });
  }

  async goOnline(pos: LatLng): Promise<Result<void>> {
    return this.void_(await this.call('POST', '/api/drivers/me/online', pos, { idempotent: true }));
  }

  async goOffline(): Promise<Result<void>> {
    return this.void_(
      await this.call('POST', '/api/drivers/me/offline', undefined, { idempotent: true }),
    );
  }

  async postLocation(pos: LatLng, heading: number): Promise<Result<void>> {
    return this.void_(
      await this.call(
        'POST',
        '/api/drivers/me/location',
        { lat: pos.lat, lng: pos.lng, heading },
        { idempotent: true },
      ),
    );
  }

  /** 200 -> the pending offer, 204 -> null. */
  async getOffer(): Promise<Result<Offer | null>> {
    const res = await this.call<Offer | undefined>('GET', '/api/offers/me', undefined, {
      idempotent: true,
    });
    if (!res.ok) return res;
    return { ok: true, status: res.status, data: res.status === 204 ? null : (res.data ?? null) };
  }

  acceptOffer(offerId: string): Promise<Result<{ tripId: string }>> {
    return this.call('POST', `/api/offers/${offerId}/accept`);
  }

  async declineOffer(offerId: string): Promise<Result<void>> {
    return this.void_(await this.call('POST', `/api/offers/${offerId}/decline`));
  }

  getTrip(tripId: string): Promise<Result<TripDetail>> {
    return this.call('GET', `/api/trips/${tripId}`, undefined, { idempotent: true });
  }

  async arrive(tripId: string): Promise<Result<void>> {
    return this.void_(await this.call('POST', `/api/trips/${tripId}/arrive`));
  }

  async startTrip(tripId: string): Promise<Result<void>> {
    return this.void_(await this.call('POST', `/api/trips/${tripId}/start`));
  }

  async completeTrip(tripId: string): Promise<Result<void>> {
    return this.void_(await this.call('POST', `/api/trips/${tripId}/complete`));
  }

  // ---- rider ---------------------------------------------------------------------------

  async riderLocation(pos: LatLng): Promise<Result<void>> {
    return this.void_(
      await this.call('POST', '/api/riders/me/location', pos, { idempotent: true }),
    );
  }

  requestRide(body: { pickup?: LatLng; dropoff: LatLng }): Promise<Result<{ tripId: string }>> {
    return this.call('POST', '/api/riders/me/rides', body);
  }
}
