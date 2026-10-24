import { describe, expect, it } from 'vitest';
import { BotClient, jwtExpiryMs, type Account, type FetchLike } from '../../src/bots/bot-client';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (expSec: number) => `${b64({ alg: 'none' })}.${b64({ exp: expSec })}.sig`;

const driver: Account = {
  email: 'driver-001@sim.local',
  password: 'pw-12345',
  name: 'Sim Driver 001',
  role: 'driver',
  vehicle: { make: 'Toyota', model: 'Prius', color: 'white', plate: 'SIM-001' },
};

interface Call {
  method: string;
  path: string;
  body: unknown;
  auth?: string;
}

function setup(handler: (c: Call, n: number) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  let now = 1_000_000_000_000;
  const fetchFn: FetchLike = async (url, init) => {
    const call: Call = {
      method: init.method as string,
      path: new URL(url).pathname,
      body: init.body ? JSON.parse(init.body as string) : undefined,
      auth: (init.headers as Record<string, string>).authorization,
    };
    calls.push(call);
    const r = handler(call, calls.length);
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), {
      status: r.status,
    });
  };
  const client = new BotClient({
    baseUrl: 'http://gw/',
    account: driver,
    fetch: fetchFn,
    now: () => now,
    sleep: async () => {},
  });
  return { client, calls, advance: (ms: number) => (now += ms), now: () => now };
}

describe('jwtExpiryMs', () => {
  it('reads exp without verifying', () => {
    expect(jwtExpiryMs(jwt(123))).toBe(123_000);
    expect(jwtExpiryMs('garbage')).toBeUndefined();
  });
});

describe('BotClient', () => {
  it('registers a driver with its vehicle, then logs in', async () => {
    const exp = Math.floor(1_000_000_000_000 / 1000) + 900;
    const { client, calls } = setup((c) =>
      c.path === '/api/users'
        ? { status: 201, body: {} }
        : { status: 200, body: { accessToken: jwt(exp), refreshToken: 'r1' } },
    );
    expect((await client.ensureAccount()).ok).toBe(true);
    expect(calls.map((c) => c.path)).toEqual(['/api/users', '/api/auth/login']);
    expect(calls[0].body).toMatchObject({ role: 'driver', vehicle: driver.vehicle });
    // second call is a no-op
    await client.ensureAccount();
    expect(calls).toHaveLength(2);
  });

  it('logs in when registration says 409', async () => {
    const exp = Math.floor(1_000_000_000_000 / 1000) + 900;
    const { client, calls } = setup((c) =>
      c.path === '/api/users'
        ? { status: 409, body: { message: 'exists' } }
        : { status: 200, body: { accessToken: jwt(exp), refreshToken: 'r1' } },
    );
    expect((await client.ensureAccount()).ok).toBe(true);
    expect(calls.map((c) => c.path)).toEqual(['/api/users', '/api/auth/login']);
  });

  it('refreshes ~60 s before exp and stores the rotated refresh token', async () => {
    const t0 = Math.floor(1_000_000_000_000 / 1000);
    let issued = 0;
    const refreshBodies: unknown[] = [];
    const { client, calls, advance } = setup((c) => {
      if (c.path === '/api/auth/login') {
        return { status: 200, body: { accessToken: jwt(t0 + 100), refreshToken: 'r1' } };
      }
      if (c.path === '/api/auth/refresh') {
        refreshBodies.push(c.body);
        issued++;
        return {
          status: 200,
          body: { accessToken: jwt(t0 + 100 + issued * 100), refreshToken: `r${issued + 1}` },
        };
      }
      return { status: 200, body: { status: 'AVAILABLE', tripId: null } };
    });
    await client.ensureAccount().catch(() => {});
    await client.driverMe(); // token valid (100 s left)
    expect(calls.some((c) => c.path === '/api/auth/refresh')).toBe(false);
    advance(50_000); // 50 s left < 60 s skew
    await client.driverMe();
    expect(refreshBodies).toEqual([{ refreshToken: 'r1' }]);
    advance(50_000); // new token valid to t0+200, now t0+100: 100 s left
    await client.driverMe();
    expect(refreshBodies).toHaveLength(1);
    advance(50_000);
    await client.driverMe();
    expect(refreshBodies).toEqual([{ refreshToken: 'r1' }, { refreshToken: 'r2' }]);
  });

  it('on 401 refreshes once and retries the request once', async () => {
    const t0 = Math.floor(1_000_000_000_000 / 1000);
    let meCalls = 0;
    const { client, calls } = setup((c) => {
      if (c.path === '/api/auth/login') {
        return { status: 200, body: { accessToken: jwt(t0 + 900), refreshToken: 'r1' } };
      }
      if (c.path === '/api/auth/refresh') {
        return { status: 200, body: { accessToken: jwt(t0 + 900), refreshToken: 'r2' } };
      }
      meCalls++;
      return meCalls === 1
        ? { status: 401, body: { message: 'expired' } }
        : { status: 200, body: { status: 'AVAILABLE', tripId: null } };
    });
    const res = await client.driverMe();
    expect(res.ok).toBe(true);
    expect(calls.map((c) => c.path)).toEqual([
      '/api/auth/login',
      '/api/drivers/me',
      '/api/auth/refresh',
      '/api/drivers/me',
    ]);
  });

  it('a second 401 is returned, not retried forever', async () => {
    const t0 = Math.floor(1_000_000_000_000 / 1000);
    const { client, calls } = setup((c) =>
      c.path.startsWith('/api/auth')
        ? { status: 200, body: { accessToken: jwt(t0 + 900), refreshToken: 'r' } }
        : { status: 401, body: { message: 'nope' } },
    );
    const res = await client.driverMe();
    expect(res).toMatchObject({ ok: false, status: 401 });
    expect(calls.filter((c) => c.path === '/api/drivers/me')).toHaveLength(2);
  });

  it('falls back to login when the refresh fails', async () => {
    const t0 = Math.floor(1_000_000_000_000 / 1000);
    let logins = 0;
    const { client, calls, advance } = setup((c) => {
      if (c.path === '/api/auth/login') {
        logins++;
        return { status: 200, body: { accessToken: jwt(t0 + 100), refreshToken: `l${logins}` } };
      }
      if (c.path === '/api/auth/refresh') return { status: 401, body: { message: 'revoked' } };
      return { status: 200, body: { status: 'OFFLINE', tripId: null } };
    });
    await client.driverMe();
    advance(60_000);
    expect((await client.driverMe()).ok).toBe(true);
    expect(logins).toBe(2);
    expect(calls.map((c) => c.path)).toContain('/api/auth/refresh');
  });

  it('retries idempotent calls on 5xx and network errors, not POSTs', async () => {
    const t0 = Math.floor(1_000_000_000_000 / 1000);
    let n = 0;
    const { client, calls } = setup((c) => {
      if (c.path === '/api/auth/login') {
        return { status: 200, body: { accessToken: jwt(t0 + 900), refreshToken: 'r' } };
      }
      n++;
      return n < 3 ? { status: 503 } : { status: 200, body: { status: 'OFFLINE', tripId: null } };
    });
    expect((await client.driverMe()).ok).toBe(true);
    expect(calls.filter((c) => c.path === '/api/drivers/me')).toHaveLength(3);

    n = 0;
    const res = await client.acceptOffer('o1');
    expect(res).toMatchObject({ ok: false, status: 503 });
    expect(calls.filter((c) => c.path === '/api/offers/o1/accept')).toHaveLength(1);
  });

  it('returns 4xx as results and maps 204 offers to null', async () => {
    const t0 = Math.floor(1_000_000_000_000 / 1000);
    const { client } = setup((c) => {
      if (c.path === '/api/auth/login') {
        return { status: 200, body: { accessToken: jwt(t0 + 900), refreshToken: 'r' } };
      }
      if (c.path === '/api/offers/me') return { status: 204 };
      return { status: 409, body: { message: 'busy' } };
    });
    expect(await client.getOffer()).toMatchObject({ ok: true, data: null });
    expect(await client.arrive('t1')).toEqual({ ok: false, status: 409, message: 'busy' });
  });

  it('reports network failures as status 0', async () => {
    const client = new BotClient({
      baseUrl: 'http://gw',
      account: driver,
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
      sleep: async () => {},
    });
    expect(await client.ensureAccount()).toMatchObject({ ok: false, status: 0 });
  });
});
