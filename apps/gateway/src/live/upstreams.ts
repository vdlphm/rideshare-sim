import { Inject, Injectable } from '@nestjs/common';
import {
  ConfigService,
  createHttpClient,
  TOKEN_PROVIDER,
  type HttpClient,
  type TokenProvider,
} from '@rideshare/common';
import type {
  DriverState,
  RiderPosition,
  Trip,
  TripStats,
  UserDisplay,
} from '@rideshare/contracts';
import type { GatewayEnv } from '../config';
import type { SimState } from './live-model';

/** Per-request upstream timeout. A slow service must never hold the poll loop for longer. */
export const UPSTREAM_TIMEOUT_MS = 2000;

export interface TripsSince {
  trips: Trip[];
  /** The trip service's `x-server-time` for this response: the next cursor. Null if absent. */
  serverTime: string | null;
}

/** What the live view needs from the rest of the system (all service-token internal endpoints). */
export interface LiveUpstreams {
  drivers(): Promise<DriverState[]>;
  riders(): Promise<RiderPosition[]>;
  sim(): Promise<SimState>;
  stats(): Promise<TripStats>;
  /** All non-terminal trips. */
  activeTrips(): Promise<Trip[]>;
  /** Trips changed since `cursor` (ISO), including just-ended ones. */
  tripsSince(cursor: string): Promise<TripsSince>;
  /** 1..500 ids. */
  users(ids: string[]): Promise<UserDisplay[]>;
}

export const LIVE_UPSTREAMS = Symbol('LIVE_UPSTREAMS');

@Injectable()
export class HttpLiveUpstreams implements LiveUpstreams {
  private readonly driver: HttpClient;
  private readonly rider: HttpClient;
  private readonly simulator: HttpClient;
  private readonly user: HttpClient;
  private readonly tripBase: string;

  constructor(
    config: ConfigService<GatewayEnv>,
    @Inject(TOKEN_PROVIDER) private readonly tokens: TokenProvider,
  ) {
    // One attempt, short timeout: the poller itself retries on the next tick.
    const make = (service: string, baseUrl: string) =>
      createHttpClient({
        baseUrl,
        service,
        auth: 'service',
        tokenProvider: tokens,
        timeoutMs: UPSTREAM_TIMEOUT_MS,
        maxAttempts: 1,
      });
    this.driver = make('driver', config.get('DRIVER_SERVICE_URL'));
    this.rider = make('rider', config.get('RIDER_SERVICE_URL'));
    this.simulator = make('simulator', config.get('SIMULATOR_SERVICE_URL'));
    this.user = make('user', config.get('USER_SERVICE_URL'));
    this.tripBase = config.get('TRIP_SERVICE_URL').replace(/\/+$/, '');
  }

  drivers(): Promise<DriverState[]> {
    return this.driver.get('/internal/drivers/online');
  }

  riders(): Promise<RiderPosition[]> {
    return this.rider.get('/internal/riders/positions');
  }

  sim(): Promise<SimState> {
    return this.simulator.get('/internal/sim/state');
  }

  stats(): Promise<TripStats> {
    return this.tripJson<TripStats>('/internal/trips/stats').then((r) => r.body);
  }

  activeTrips(): Promise<Trip[]> {
    return this.tripJson<Trip[]>('/internal/trips/active').then((r) => r.body);
  }

  async tripsSince(cursor: string): Promise<TripsSince> {
    const r = await this.tripJson<Trip[]>(
      `/internal/trips/active?updatedSince=${encodeURIComponent(cursor)}`,
    );
    return { trips: r.body, serverTime: r.serverTime };
  }

  users(ids: string[]): Promise<UserDisplay[]> {
    return this.user.post('/internal/users/batch', { body: { ids }, idempotent: true });
  }

  /**
   * The shared HttpClient returns only bodies, and the trip cursor lives in a response header,
   * so trip calls use fetch with the same service token.
   */
  private async tripJson<T>(path: string): Promise<{ body: T; serverTime: string | null }> {
    const res = await fetch(`${this.tripBase}${path}`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${await this.tokens.getToken()}`,
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined);
      throw new Error(`trip service ${path.split('?')[0]} returned ${res.status}`);
    }
    return { body: (await res.json()) as T, serverTime: res.headers.get('x-server-time') };
  }
}
