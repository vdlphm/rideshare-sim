import {
  WS_CLOSE_FORBIDDEN,
  WS_CLOSE_UNAUTHORIZED,
  WsServerMessageSchema,
  type DriverState,
  type RiderPosition,
  type Trip,
  type WsDiff,
  type WsServerMessage,
  type WsSnapshot,
} from '@rideshare/contracts';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { driver, rider, simState, stats, trip, user } from './live-fixtures';
import { makeSigner, startGateway, type Env, type Fake, type Signer } from './harness';

const POLL_MS = 40;
const STATS_MS = 400;
const RETENTION_MS = 600;

/** Mutable upstream state served by the fakes. */
const world = {
  drivers: [] as DriverState[],
  riders: [] as RiderPosition[],
  trips: [] as (Trip & { changedAt: number })[],
  sim: simState(),
  stats: stats(),
  userNames: new Map<string, string>(),
  failing: new Set<string>(),
  calls: {} as Record<string, number>,
  tokenFetches: 0,
  unauthenticated: 0,
};

let env: Env;
let signer: Signer;
const sockets: WebSocket[] = [];

function json(res: import('node:http').ServerResponse, body: unknown, headers = {}) {
  res.setHeader('content-type', 'application/json');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v as string);
  res.end(JSON.stringify(body));
  return true;
}

type Route = (
  url: URL,
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  body: string,
) => boolean;

/** Replaces the harness' echo behaviour with routes over the mutable `world` state. */
function serve(fake: Fake, route: Route) {
  fake.server.removeAllListeners('request');
  fake.server.on('request', (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url!, 'http://x');
      if (fake.handler?.(req, res)) return; // e.g. the harness' JWKS endpoint
      const key = `${fake.name}:${req.method} ${url.pathname}`;
      world.calls[key] = (world.calls[key] ?? 0) + 1;
      const internal = url.pathname.startsWith('/internal/');
      if (internal && !req.headers.authorization?.startsWith('Bearer ')) world.unauthenticated++;
      if (world.failing.has(fake.name)) {
        res.statusCode = 500;
        res.end('boom');
        return;
      }
      if (!route(url, req, res, Buffer.concat(chunks).toString('utf8'))) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
}

const calls = (prefix: string) =>
  Object.entries(world.calls)
    .filter(([k]) => k.startsWith(prefix))
    .reduce((n, [, v]) => n + v, 0);
const upstreamCalls = () =>
  calls('driver:') + calls('rider:') + calls('trip:') + calls('simulator:');

beforeAll(async () => {
  signer = await makeSigner('key-ws');
  env = await startGateway(
    {
      WS_POLL_INTERVAL_MS: String(POLL_MS),
      WS_STATS_INTERVAL_MS: String(STATS_MS),
      WS_ENDED_TRIP_RETENTION_MS: String(RETENTION_MS),
    },
    [signer.jwk],
  );
  const f = env.fakes;
  serve(
    f.driver!,
    (url, _q, res) => url.pathname === '/internal/drivers/online' && json(res, world.drivers),
  );
  serve(
    f.rider!,
    (url, _q, res) => url.pathname === '/internal/riders/positions' && json(res, world.riders),
  );
  serve(
    f.simulator!,
    (url, _q, res) => url.pathname === '/internal/sim/state' && json(res, world.sim),
  );
  serve(f.trip!, (url, _q, res) => {
    if (url.pathname === '/internal/trips/stats' || url.pathname === '/trips/stats') {
      return json(res, world.stats);
    }
    if (url.pathname !== '/internal/trips/active') return false;
    const since = url.searchParams.get('updatedSince');
    const strip = (t: Trip & { changedAt: number }): Trip => {
      const { changedAt, ...rest } = t;
      void changedAt;
      return rest;
    };
    if (!since) {
      return json(
        res,
        world.trips.filter((t) => t.status !== 'COMPLETED' && t.status !== 'NO_DRIVERS').map(strip),
      );
    }
    const at = Date.parse(since);
    return json(res, world.trips.filter((t) => t.changedAt >= at).map(strip), {
      'x-server-time': new Date().toISOString(),
    });
  });
  serve(f.user!, (url, req, res, body) => {
    if (url.pathname === '/auth/token' && req.method === 'POST') {
      world.tokenFetches++;
      return json(res, { accessToken: 'svc-token', expiresIn: 600 });
    }
    if (url.pathname === '/internal/users/batch') {
      const { ids } = JSON.parse(body) as { ids: string[] };
      return json(
        res,
        ids
          .filter((id) => world.userNames.has(id))
          .map((id) => user(id, { name: world.userNames.get(id)! })),
      );
    }
    return false;
  });
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  // let the gateway notice the disconnects so the poller stops between tests
  await new Promise((r) => setTimeout(r, POLL_MS * 3));
  world.failing.clear();
});
afterAll(() => env.close());

const waitFor = async (fn: () => boolean, timeoutMs = 3000) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out waiting for condition');
};

function resetWorld() {
  const d = driver();
  const r = rider();
  const t = trip({ riderId: r.riderId, status: 'REQUESTED' });
  world.drivers = [d];
  world.riders = [r];
  world.trips = [{ ...t, changedAt: Date.now() }];
  world.sim = simState();
  world.stats = stats({ waitingRiders: 1 });
  world.userNames = new Map([
    [d.driverId, 'Dana Driver'],
    [r.riderId, 'Rita Rider'],
  ]);
  world.calls = {};
  world.unauthenticated = 0;
  return { d, r, t };
}

interface Conn {
  ws: WebSocket;
  messages: WsServerMessage[];
  times: number[];
  closed: Promise<{ code: number; reason: string }>;
}

async function connect(token: string | null | Promise<string>, path = '/ws'): Promise<Conn> {
  const t = await token;
  const url = `${env.base.replace('http', 'ws')}${path}${t === null ? '' : `?token=${encodeURIComponent(t)}`}`;
  const ws = new WebSocket(url);
  sockets.push(ws);
  const conn: Conn = {
    ws,
    messages: [],
    times: [],
    closed: new Promise((resolve) =>
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
    ),
  };
  ws.on('message', (data) => {
    // every frame must satisfy the published contract
    conn.messages.push(WsServerMessageSchema.parse(JSON.parse(data.toString())));
    conn.times.push(Date.now());
  });
  await new Promise<void>((resolve) => {
    ws.on('open', () => resolve());
    ws.on('error', () => resolve());
    ws.on('close', () => resolve());
  });
  return conn;
}

const adminToken = () => signer.sign({ sub: 'admin-1', role: 'admin' });
const diffs = (c: Conn) => c.messages.filter((m): m is WsDiff => m.type === 'diff');
const nextDiff = async (c: Conn, pred: (d: WsDiff) => boolean = () => true, from = 0) => {
  let found: WsDiff | undefined;
  await waitFor(() => {
    found = diffs(c).slice(from).find(pred);
    return !!found;
  });
  return found!;
};

describe('admin live view', () => {
  it('sends a valid snapshot first, with the data and its users', async () => {
    const { d, r, t } = resetWorld();
    const c = await connect(adminToken());
    await waitFor(() => c.messages.length > 0);
    const snap = c.messages[0] as WsSnapshot;
    expect(snap.type).toBe('snapshot');
    expect(snap.drivers).toEqual([d]);
    expect(snap.riders).toEqual([r]);
    expect(snap.trips.map((x) => x.id)).toEqual([t.id]);
    expect(snap.stats.waitingRiders).toBe(1);
    expect(snap.config).toEqual(world.sim.config);
    expect(Object.fromEntries(snap.users.map((u) => [u.id, u.name]))).toEqual({
      [d.driverId]: 'Dana Driver',
      [r.riderId]: 'Rita Rider',
    });
    expect(world.unauthenticated).toBe(0);
    expect(world.tokenFetches).toBeGreaterThan(0);
  });

  it('streams exactly the changes as diffs, retires ended trips, and sends stats on their own cadence', async () => {
    const { d, t } = resetWorld();
    const c = await connect(adminToken());
    await waitFor(() => c.messages.length > 0);
    const t0 = Date.now();

    // quiet world: only the (advancing) nothing -> no diffs at all
    await new Promise((r) => setTimeout(r, POLL_MS * 5));
    expect(diffs(c)).toHaveLength(0);

    // move the driver
    world.drivers = [{ ...d, lat: d.lat + 0.01, ts: d.ts + 250 }];
    const moved = await nextDiff(c, (x) => x.drivers.upsert.length > 0);
    expect(moved.drivers).toEqual({ upsert: [world.drivers[0]], remove: [] });
    expect(moved.riders).toEqual({ upsert: [], remove: [] });
    expect(moved.trips).toEqual({ upsert: [], remove: [] });
    expect(moved.config).toBeUndefined();
    expect(moved.users).toEqual([]);

    // new rider: diff carries the rider and its display info
    const r2 = rider();
    world.userNames.set(r2.riderId, 'New Rider');
    world.riders = [...world.riders, r2];
    const added = await nextDiff(c, (x) => x.riders.upsert.length > 0);
    expect(added.riders).toEqual({ upsert: [r2], remove: [] });
    expect(added.users.map((u) => u.name)).toEqual(['New Rider']);

    // sim config change
    world.sim = { ...world.sim, config: { ...world.sim.config, speed: 4 } };
    const cfg = await nextDiff(c, (x) => !!x.config);
    expect(cfg.config?.speed).toBe(4);
    expect(cfg.drivers.upsert).toEqual([]);

    // trip completes: upserted once, removed after the retention
    const doneAt = Date.now();
    world.trips = [{ ...world.trips[0]!, status: 'COMPLETED', completedAt: 9, changedAt: doneAt }];
    const ended = await nextDiff(c, (x) => x.trips.upsert.length > 0);
    expect(ended.trips.upsert[0]).toMatchObject({ id: t.id, status: 'COMPLETED' });
    const gone = await nextDiff(c, (x) => x.trips.remove.length > 0);
    expect(gone.trips.remove).toEqual([t.id]);
    expect(Date.now() - doneAt).toBeGreaterThanOrEqual(RETENTION_MS - 50);
    // ... and was not upserted again in between
    expect(diffs(c).filter((x) => x.trips.upsert.some((u) => u.id === t.id))).toHaveLength(1);

    // stats: absent from most diffs, arrive on change at their own cadence
    world.stats = stats({ waitingRiders: 0, completedTrips: 1 });
    const st = await nextDiff(c, (x) => !!x.stats);
    expect(st.stats?.completedTrips).toBe(1);
    const withStats = diffs(c).filter((x) => x.stats);
    expect(withStats).toHaveLength(1);

    const secs = (Date.now() - t0) / 1000;
    console.log(
      `[live] ${c.messages.length} messages in ${secs.toFixed(2)}s (~${(c.messages.length / secs).toFixed(1)}/s) at poll=${POLL_MS}ms`,
    );
  });

  it('rejects non-admin tokens with 4403 and missing or garbage tokens with 4401', async () => {
    resetWorld();
    for (const role of ['rider', 'driver', 'service']) {
      const c = await connect(signer.sign({ sub: 'u', role }));
      expect((await c.closed).code).toBe(WS_CLOSE_FORBIDDEN);
      expect(c.messages).toEqual([]);
    }
    expect((await (await connect(null)).closed).code).toBe(WS_CLOSE_UNAUTHORIZED);
    expect((await (await connect('garbage')).closed).code).toBe(WS_CLOSE_UNAUTHORIZED);
    const expired = await connect(
      signer.sign({ sub: 'a', role: 'admin' }, { exp: Math.floor(Date.now() / 1000) - 60 }),
    );
    expect((await expired.closed).code).toBe(WS_CLOSE_UNAUTHORIZED);
    const other = await makeSigner('unknown-key');
    expect((await (await connect(other.sign({ sub: 'a', role: 'admin' }))).closed).code).toBe(
      WS_CLOSE_UNAUTHORIZED,
    );
    expect(upstreamCalls()).toBe(0); // rejected clients never start the poller
  });

  it('closes 1011 when the key set cannot be fetched', async () => {
    resetWorld();
    const lone = await makeSigner('key-ws-2'); // unknown kid forces a JWKS refetch
    const prev = env.fakes.user!.handler;
    const token = await lone.sign({ sub: 'a', role: 'admin' });
    env.fakes.user!.server.closeAllConnections();
    env.jwks.keys = [];
    env.fakes.user!.handler = (req, res) => {
      if (req.url === '/.well-known/jwks.json') {
        res.statusCode = 503;
        res.end();
        return true;
      }
      return prev?.(req, res) ?? false;
    };
    try {
      const c = await connect(token);
      expect((await c.closed).code).toBe(1011);
    } finally {
      env.fakes.user!.handler = prev;
      env.jwks.keys = [signer.jwk];
    }
  });

  it('refuses other upgrade paths and does not proxy them', async () => {
    resetWorld();
    for (const path of ['/api/trips', '/internal/trips/active', '/']) {
      const c = await connect(adminToken(), path);
      expect((await c.closed).code).toBe(1006);
    }
    expect(upstreamCalls()).toBe(0);
    expect(env.fakes.trip!.seen.length).toBe(0);
  });

  it('gives a second client a snapshot mid-stream', async () => {
    const { d } = resetWorld();
    const a = await connect(adminToken());
    await waitFor(() => a.messages.length > 0);
    world.drivers = [{ ...d, lat: d.lat + 0.5, ts: d.ts + 1 }];
    await nextDiff(a, (x) => x.drivers.upsert.length > 0);
    const b = await connect(adminToken());
    await waitFor(() => b.messages.length > 0);
    const snap = b.messages[0] as WsSnapshot;
    expect(snap.type).toBe('snapshot');
    expect(snap.drivers[0]!.lat).toBe(d.lat + 0.5);
    expect(snap.users.length).toBe(2);
    // each connection receives a user at most once
    const r2 = rider();
    world.userNames.set(r2.riderId, 'Late');
    world.riders = [...world.riders, r2];
    await nextDiff(b, (x) => x.users.length > 0);
    await nextDiff(a, (x) => x.users.length > 0);
    const seen = (c: Conn) => c.messages.flatMap((m) => m.users.map((u) => u.id));
    for (const c of [a, b]) expect(new Set(seen(c)).size).toBe(seen(c).length);
  });

  it('survives an upstream returning 500 for a few ticks and recovers', async () => {
    const { d } = resetWorld();
    const c = await connect(adminToken());
    await waitFor(() => c.messages.length > 0);
    world.failing.add('driver');
    const rider2 = rider();
    world.userNames.set(rider2.riderId, 'During outage');
    world.riders = [...world.riders, rider2];
    // rider data still flows while the driver service is down
    await nextDiff(c, (x) => x.riders.upsert.length > 0);
    await new Promise((r) => setTimeout(r, POLL_MS * 5));
    world.failing.clear();
    world.drivers = [{ ...d, ts: d.ts + 1000 }];
    const back = await nextDiff(c, (x) => x.drivers.upsert.length > 0);
    expect(back.drivers.upsert[0]!.ts).toBe(d.ts + 1000);
    expect(back.drivers.remove).toEqual([]); // failure never looked like "all drivers left"
  });

  it('stops polling after the last client leaves and resumes with a full fetch', async () => {
    resetWorld();
    const c = await connect(adminToken());
    await waitFor(() => c.messages.length > 0);
    await waitFor(() => calls('driver:') > 3);
    c.ws.close();
    await c.closed;
    await new Promise((r) => setTimeout(r, POLL_MS * 4)); // let an in-flight tick finish
    const settled = upstreamCalls();
    await new Promise((r) => setTimeout(r, POLL_MS * 8));
    expect(upstreamCalls()).toBe(settled);

    const full = calls('trip:GET /internal/trips/active');
    const again = await connect(adminToken());
    await waitFor(() => again.messages.length > 0);
    expect(again.messages[0]!.type).toBe('snapshot');
    expect(upstreamCalls()).toBeGreaterThan(settled);
    expect(calls('trip:GET /internal/trips/active')).toBeGreaterThan(full);
  });
});

describe('http proxy is unaffected', () => {
  it('still proxies /api routes and hides /internal', async () => {
    const t = await signer.sign({ sub: 'a', role: 'admin' });
    const ok = await request(env.base).get('/api/trips/stats').set('Authorization', `Bearer ${t}`);
    expect(ok.status).toBe(200);
    expect((await request(env.base).get('/internal/trips/active')).status).toBe(404);
    expect(
      (
        await request(env.base)
          .get('/api/internal/trips/active')
          .set('Authorization', `Bearer ${t}`)
      ).status,
    ).toBe(404);
  });
});
