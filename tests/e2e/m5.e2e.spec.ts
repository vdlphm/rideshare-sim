import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import {
  DockerComposeEnvironment,
  Wait,
  type StartedDockerComposeEnvironment,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEATTLE_SPAWN_BBOX, haversineM, isInBbox } from '@rideshare/geo';
import { COMPOSE_DIR, COMPOSE_FILE, PASSWORDS, SERVICE_ENV } from '../infra/stack';

// M5 headless end to end: the full stack with the simulator bots ENABLED and no scripted
// actions. Drivers go online, riders spawn, offers are accepted and trips complete by themselves.
const PROJECT = `rideshare-e2e-m5-${process.pid}`;
const DRIVERS = 10;

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });

type LngLat = [number, number];
interface Route {
  geometry: LngLat[];
  durations: number[];
  distanceM: number;
}
interface TripView {
  id: string;
  status: string;
  driverId: string | null;
  pickup: { lat: number; lng: number };
  dropoff: { lat: number; lng: number };
  pickupRoute: Route | null;
  tripRoute: Route;
  estDurationS: number;
  requestedAt: number;
  matchedAt: number | null;
  arrivedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  events: { fromStatus: string | null; toStatus: string; atSim: number }[];
}
interface Stats {
  waitingRiders: number;
  activeTrips: number;
  completedTrips: number;
  noDriverTrips: number;
}
interface DriverState {
  driverId: string;
  status: string;
  tripId: string | null;
  lat: number;
  lng: number;
  ts: number;
}
interface SimState {
  clock: { speed: number; paused: boolean };
  config: Record<string, unknown>;
  bots: {
    drivers: { total: number; idle: number; toPickup: number; atPickup: number; inTrip: number };
    riders: { active: number; waiting: number; riding: number };
  };
}

let env: StartedDockerComposeEnvironment;
let base: string;
let composeEnv: NodeJS.ProcessEnv;
let admin: string;
let upAt = 0;

const compose = (args: string[]): string =>
  execFileSync('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, ...args], {
    cwd: COMPOSE_DIR,
    env: composeEnv,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) =>
  process.stdout.write(`[m5 +${Math.round((Date.now() - upAt) / 1000)}s] ${msg}\n`);

const poll = async <T>(
  what: string,
  fn: () => Promise<T | undefined>,
  timeoutMs: number,
  everyMs = 1000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
};

const gateway = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const adminGet = async <T>(path: string): Promise<T> => {
  const res = await gateway('GET', path, admin);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
};

const putConfig = async (patch: Record<string, unknown>) => {
  const res = await gateway('PUT', '/api/sim/config', admin, patch);
  expect(res.status).toBe(200);
};

/** GET an internal (service-token) URL from inside the network, via the simulator container. */
const internal = (url: string): unknown => {
  const script =
    `const s=process.env.SIMULATOR_CLIENT_SECRET;` +
    `fetch('http://user:3001/auth/token',{method:'POST',headers:{'content-type':'application/json'},` +
    `body:JSON.stringify({clientId:'simulator',clientSecret:s})}).then(r=>r.json())` +
    `.then(t=>fetch(process.argv[1],{headers:{authorization:'Bearer '+t.accessToken}}))` +
    `.then(r=>r.text()).then(t=>process.stdout.write(t))`;
  return JSON.parse(compose(['exec', '-T', 'simulator', 'node', '-e', script, url]));
};
const simState = () => internal('http://localhost:3007/internal/sim/state') as SimState;
const onlineDrivers = () => internal('http://driver:3003/internal/drivers/online') as DriverState[];
/** Wall clock inside the stack: Docker Desktop's VM clock can be skewed from the host's. */
const stackNow = (): number =>
  Number(
    compose(['exec', '-T', 'simulator', 'node', '-e', 'process.stdout.write(String(Date.now()))']),
  );
const stats = () => adminGet<Stats>('/api/trips/stats');

const psql = (sql: string): string =>
  compose([
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'postgres',
    '-d',
    'ridesharing',
    '-At',
    '-c',
    sql,
  ]);

/** Distance in meters from p to the polyline (local equirectangular projection). */
const distToRouteM = (p: { lat: number; lng: number }, route: LngLat[]): number => {
  const kx = Math.cos((p.lat * Math.PI) / 180) * 111_320;
  const ky = 110_540;
  let best = Infinity;
  for (let i = 0; i < route.length - 1; i++) {
    const ax = (route[i]![0] - p.lng) * kx;
    const ay = (route[i]![1] - p.lat) * ky;
    const bx = (route[i + 1]![0] - p.lng) * kx;
    const by = (route[i + 1]![1] - p.lat) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
};

// Allowance for road snapping of pickup/dropoff points.
const SNAP_M = 300;
const inSpawnBbox = (p: { lat: number; lng: number }) => {
  const pad = 0.003; // ~300 m
  return isInBbox(p, {
    minLng: SEATTLE_SPAWN_BBOX.minLng - pad,
    maxLng: SEATTLE_SPAWN_BBOX.maxLng + pad,
    minLat: SEATTLE_SPAWN_BBOX.minLat - pad,
    maxLat: SEATTLE_SPAWN_BBOX.maxLat + pad,
  });
};

beforeAll(async () => {
  const port = await freePort();
  base = `http://localhost:${port}`;
  const vars = {
    ...PASSWORDS,
    ...SERVICE_ENV,
    SIM_BOTS_ENABLED: 'true',
    SIM_DEFAULT_SPEED: '10',
    SIM_DEFAULT_DRIVER_COUNT: String(DRIVERS),
    SIM_DEFAULT_SPAWN_INTERVAL_S: '5',
    SIM_DEFAULT_ACCEPT_PROBABILITY: '1',
    SIM_MAX_ACTIVE_RIDERS: '30',
    GATEWAY_HOST_PORT: String(port),
  };
  composeEnv = { ...process.env, ...vars };
  env = await new DockerComposeEnvironment(COMPOSE_DIR, COMPOSE_FILE)
    .withProjectName(PROJECT)
    .withEnvironment(vars)
    .withBuild()
    .withWaitStrategy('gateway-1', Wait.forHealthCheck())
    .withStartupTimeout(1_200_000)
    .up(['gateway']);
  upAt = Date.now();

  const login = await gateway('POST', '/api/auth/login', undefined, {
    email: SERVICE_ENV.ADMIN_EMAIL,
    password: SERVICE_ENV.ADMIN_PASSWORD,
  });
  expect(login.status).toBe(200);
  admin = ((await login.json()) as { accessToken: string }).accessToken;
}, 1_500_000);

afterAll(async () => {
  await env?.down({ removeVolumes: true, timeout: 20_000 });
}, 120_000);

describe('M5: the bots run the system headless', { timeout: 360_000 }, () => {
  let driversUpAt = 0;

  it('bots come up: 10 drivers online with fresh positions in Seattle', async () => {
    const online = await poll(
      `${DRIVERS} drivers online`,
      async () => {
        const s = simState();
        log(`bots ${JSON.stringify(s.bots)}`);
        if (s.bots.drivers.total !== DRIVERS) return undefined;
        const list = onlineDrivers();
        return list.length === DRIVERS ? list : undefined;
      },
      180_000,
      2000,
    );
    driversUpAt = Date.now();
    log(`drivers up: ${online.length}`);
    expect(new Set(online.map((d) => d.driverId)).size).toBe(DRIVERS);
    const now = stackNow();
    log(`host/stack clock skew ${Date.now() - now} ms`);
    for (const d of online) {
      expect(inSpawnBbox(d)).toBe(true);
      expect(Math.abs(now - d.ts)).toBeLessThan(60_000);
    }
    expect(simState().config).toMatchObject({ speed: 10, driverCount: DRIVERS });
  });

  it('runs by itself: >= 3 trips COMPLETED within 2 real minutes', async () => {
    const final = await poll(
      'completedTrips >= 3',
      async () => {
        const st = await stats();
        log(`stats ${JSON.stringify(st)} bots ${JSON.stringify(simState().bots)}`);
        return st.completedTrips >= 3 ? st : undefined;
      },
      Math.max(5_000, driversUpAt + 120_000 - Date.now()),
      4000,
    );
    log(`completed ${final.completedTrips} trips after ${(Date.now() - driversUpAt) / 1000}s`);
    expect(final.completedTrips).toBeGreaterThanOrEqual(3);
  });

  it('trips look real, and drivers move along the trip route', async () => {
    const list = await adminGet<{ id: string }[]>('/api/trips?status=completed');
    expect(list.length).toBeGreaterThanOrEqual(3);
    const t = await adminGet<TripView>(`/api/trips/${list[0]!.id}`);
    expect(t.status).toBe('COMPLETED');
    expect(inSpawnBbox(t.pickup)).toBe(true);
    expect(inSpawnBbox(t.dropoff)).toBe(true);
    expect(haversineM(t.pickup, t.dropoff)).toBeGreaterThanOrEqual(500 - 2 * SNAP_M);
    const times = [t.requestedAt, t.matchedAt, t.arrivedAt, t.startedAt, t.completedAt];
    expect(times.every((x) => typeof x === 'number')).toBe(true);
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!);
    expect(times[4]!).toBeGreaterThan(times[0]!);
    expect(t.events.map((e) => e.toStatus)).toEqual([
      'REQUESTED',
      'MATCHED',
      'ARRIVED',
      'IN_PROGRESS',
      'COMPLETED',
    ]);
    for (const r of [t.pickupRoute!, t.tripRoute]) {
      expect(r).not.toBeNull();
      expect(r.geometry.length).toBeGreaterThanOrEqual(2);
      expect(r.durations.length).toBe(r.geometry.length - 1);
    }

    // Sample drivers while a trip is IN_PROGRESS.
    const running = await poll(
      'an IN_PROGRESS trip with a driver',
      async () => {
        const active = await adminGet<TripView[]>('/api/trips?status=active');
        const trips = active.filter((a) => a.status === 'IN_PROGRESS' && a.driverId);
        trips.sort((a, b) => b.estDurationS - a.estDurationS);
        return trips[0];
      },
      60_000,
      500,
    );
    const samples: DriverState[] = [];
    for (let i = 0; i < 4; i++) {
      const now = await adminGet<TripView[]>('/api/trips?status=active');
      if (!now.some((a) => a.id === running.id && a.status === 'IN_PROGRESS')) break;
      const d = onlineDrivers().find((x) => x.driverId === running.driverId);
      if (d && d.tripId === running.id) samples.push(d);
      await sleep(1000);
    }
    log(`in-progress samples ${JSON.stringify(samples.map((s) => [s.lat, s.lng]))}`);
    expect(samples.length).toBeGreaterThanOrEqual(2);
    for (const s of samples) expect(distToRouteM(s, running.tripRoute.geometry)).toBeLessThan(100);
    const moved = samples.some((s, i) => i > 0 && haversineM(s, samples[i - 1]!) > 1);
    expect(moved).toBe(true);
  });

  it('pause freezes the world: positions fixed, heartbeats continue', async () => {
    await putConfig({ paused: true });
    try {
      // A moving bot's first heartbeat after the pause (<= 3 s) posts the position at the freeze
      // instant, so let every driver settle there before taking the baseline.
      await sleep(5000);
      const before = onlineDrivers();
      expect(before.length).toBe(DRIVERS);
      await sleep(5000);
      const after = onlineDrivers();
      expect(after.length).toBe(DRIVERS);
      const byId = new Map(before.map((d) => [d.driverId, d]));
      let advanced = 0;
      for (const a of after) {
        const b = byId.get(a.driverId)!;
        expect(b).toBeDefined();
        expect([a.lat, a.lng]).toEqual([b.lat, b.lng]);
        if (a.ts > b.ts) advanced++;
      }
      log(`paused: ${advanced}/${DRIVERS} drivers' ts advanced`);
      expect(advanced).toBe(DRIVERS);
    } finally {
      await putConfig({ paused: false });
    }
  });

  it('driverCount 0 retires the fleet; new trips end NO_DRIVERS', async () => {
    await putConfig({ driverCount: 0 });
    await poll(
      'fleet retired',
      async () => {
        const s = simState();
        log(`retiring ${JSON.stringify(s.bots)}`);
        return s.bots.drivers.total === 0 && onlineDrivers().length === 0 ? true : undefined;
      },
      120_000,
      3000,
    );
    const before = await stats();
    const after = await poll(
      'noDriverTrips to increase',
      async () => {
        const st = await stats();
        log(`stats ${JSON.stringify(st)}`);
        return st.noDriverTrips > before.noDriverTrips ? st : undefined;
      },
      90_000,
      3000,
    );
    expect(after.noDriverTrips).toBeGreaterThan(before.noDriverTrips);
  });

  it('invariant: no driver has two non-terminal trips', () => {
    const dup = psql(
      `SELECT driver_id, count(*) FROM trip_service.trips ` +
        `WHERE driver_id IS NOT NULL AND status IN ('MATCHED','ARRIVED','IN_PROGRESS') ` +
        `GROUP BY driver_id HAVING count(*) > 1`,
    );
    expect(dup.trim()).toBe('');
    const distinct = psql(
      `SELECT count(*) = count(DISTINCT driver_id) FROM trip_service.trips ` +
        `WHERE driver_id IS NOT NULL AND status IN ('MATCHED','ARRIVED','IN_PROGRESS')`,
    );
    expect(distinct.trim()).toBe('t');
    log(
      `trips by status: ${psql('SELECT status, count(*) FROM trip_service.trips GROUP BY 1').trim().replace(/\n/g, ' ')}`,
    );
  });
});
