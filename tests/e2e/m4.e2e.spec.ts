import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import {
  DockerComposeEnvironment,
  Wait,
  type StartedDockerComposeEnvironment,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPOSE_DIR, COMPOSE_FILE, PASSWORDS, SERVICE_ENV } from '../infra/stack';

// M4 end to end: the full stack (gateway, user, rider, driver, trip, matching, simulator, routing,
// redis, postgres, osrm) driven through the gateway by a scripted rider and drivers (no bots yet).
const PROJECT = `rideshare-e2e-m4-${process.pid}`;
const PIKE = { lat: 47.6097, lng: -122.3422 };
const NEEDLE = { lat: 47.6205, lng: -122.3493 };
// ~300 m, ~200 m and ~1 km from Pike Place.
const D_300M = { lat: 47.6124, lng: -122.3422 };
const D_NEAR = { lat: 47.6115, lng: -122.3422 };
const D_FAR = { lat: 47.6187, lng: -122.3422 };

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });

let env: StartedDockerComposeEnvironment;
let base: string;
let composeEnv: NodeJS.ProcessEnv;
let admin: string;
let seq = 0;

interface Actor {
  id: string;
  token: string;
}
interface Offer {
  id: string;
  tripId: string;
  driverId: string;
  etaS: number;
  pickup: { lat: number; lng: number };
  dropoff: { lat: number; lng: number };
}
interface TripView {
  id: string;
  status: string;
  driverId: string | null;
  pickupRoute: { geometry: unknown[]; durations: number[]; distanceM: number } | null;
  requestedAt: number;
  matchedAt: number | null;
  arrivedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  events: { fromStatus: string | null; toStatus: string; atSim: number }[];
}

const api = (path: string, token: string | undefined, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });

const send = (method: string, path: string, token: string, body?: unknown) =>
  api(path, token, { method, body: body === undefined ? undefined : JSON.stringify(body) });

const compose = (args: string[]): string =>
  execFileSync('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, ...args], {
    cwd: COMPOSE_DIR,
    env: composeEnv,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until `fn` returns a value (not undefined) or the deadline passes. */
const poll = async <T>(
  what: string,
  fn: () => Promise<T | undefined>,
  timeoutMs = 30_000,
  everyMs = 150,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
};

const register = async (role: 'rider' | 'driver', name: string): Promise<Actor> => {
  const n = `${name}${++seq}`;
  const email = `${n}-${process.pid}@example.com`;
  const password = 'password-1';
  const body =
    role === 'driver'
      ? {
          email,
          password,
          name: n,
          role,
          vehicle: { make: 'Toyota', model: 'Prius', color: 'white', plate: `P-${n}` },
        }
      : { email, password, name: n, role };
  expect((await send('POST', '/api/users', '', body)).status).toBe(201);
  const login = await send('POST', '/api/auth/login', '', { email, password });
  expect(login.status).toBe(200);
  const { accessToken } = (await login.json()) as { accessToken: string };
  const me = await api('/api/users/me', accessToken);
  const { id } = (await me.json()) as { id: string };
  return { id, token: accessToken };
};

const goOnline = async (d: Actor, pos: { lat: number; lng: number }) => {
  expect((await send('POST', '/api/drivers/me/online', d.token, pos)).status).toBe(200);
  expect(
    (await send('POST', '/api/drivers/me/location', d.token, { ...pos, heading: 90 })).status,
  ).toBe(204);
};

const goOffline = async (d: Actor) => {
  const res = await send('POST', '/api/drivers/me/offline', d.token);
  expect(res.status).toBe(200);
};

const driverStatus = async (d: Actor): Promise<string> => {
  const res = await api('/api/drivers/me', d.token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { status: string }).status;
};

const waitDriverStatus = (d: Actor, status: string) =>
  poll(`driver ${d.id} ${status}`, async () =>
    (await driverStatus(d)) === status ? true : undefined,
  );

const requestRide = async (rider: Actor, body: unknown): Promise<string> => {
  const res = await send('POST', '/api/riders/me/rides', rider.token, body);
  expect(res.status).toBe(201);
  return ((await res.json()) as { tripId: string }).tripId;
};

const getTrip = async (who: Actor, id: string): Promise<TripView> => {
  const res = await api(`/api/trips/${id}`, who.token);
  expect(res.status).toBe(200);
  return (await res.json()) as TripView;
};

const waitTrip = (who: Actor, id: string, status: string, timeoutMs = 30_000) =>
  poll(
    `trip ${id} ${status}`,
    async () => {
      const t = await getTrip(who, id);
      return t.status === status ? t : undefined;
    },
    timeoutMs,
  );

const waitOffer = (d: Actor, tripId?: string, timeoutMs = 30_000): Promise<Offer> =>
  poll(
    `offer for ${d.id}`,
    async () => {
      const res = await api('/api/offers/me', d.token);
      if (res.status === 204) return undefined;
      expect(res.status).toBe(200);
      const offer = (await res.json()) as Offer;
      return tripId === undefined || offer.tripId === tripId ? offer : undefined;
    },
    timeoutMs,
    100,
  );

const accept = async (d: Actor, offer: Offer): Promise<string> => {
  const res = await send('POST', `/api/offers/${offer.id}/accept`, d.token);
  expect(res.status).toBe(200);
  const { tripId } = (await res.json()) as { tripId: string };
  expect(tripId).toBe(offer.tripId);
  return tripId;
};

const step = async (d: Actor, tripId: string, action: 'arrive' | 'start' | 'complete') => {
  const res = await send('POST', `/api/trips/${tripId}/${action}`, d.token);
  expect(res.status).toBeLessThan(300);
};

/** arrive -> start -> complete, then wait for the driver to be AVAILABLE again. */
const finishTrip = async (d: Actor, tripId: string) => {
  await step(d, tripId, 'arrive');
  await step(d, tripId, 'start');
  await step(d, tripId, 'complete');
  await waitDriverStatus(d, 'AVAILABLE');
};

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

beforeAll(async () => {
  const port = await freePort();
  base = `http://localhost:${port}`;
  const vars = { ...PASSWORDS, ...SERVICE_ENV, GATEWAY_HOST_PORT: String(port) };
  composeEnv = { ...process.env, ...vars };
  env = await new DockerComposeEnvironment(COMPOSE_DIR, COMPOSE_FILE)
    .withProjectName(PROJECT)
    .withEnvironment(vars)
    .withBuild()
    .withWaitStrategy('gateway-1', Wait.forHealthCheck())
    .withStartupTimeout(1_200_000)
    .up(['gateway']);

  const login = await send('POST', '/api/auth/login', '', {
    email: SERVICE_ENV.ADMIN_EMAIL,
    password: SERVICE_ENV.ADMIN_PASSWORD,
  });
  expect(login.status).toBe(200);
  admin = ((await login.json()) as { accessToken: string }).accessToken;
  // Speed 10 makes sim-time timeouts (offer TTL 15 s, give-up 60 s) pass 10x faster.
  const cfg = await send('PUT', '/api/sim/config', admin, { speed: 10 });
  expect(cfg.status).toBe(200);
  expect(await cfg.json()).toMatchObject({ speed: 10 });
}, 1_500_000);

afterAll(async () => {
  await env?.down({ removeVolumes: true, timeout: 20_000 });
}, 120_000);

describe('M4: trip lifecycle through the gateway', { timeout: 120_000 }, () => {
  it('happy path: request, offer, accept, arrive, start, complete', async () => {
    const driver = await register('driver', 'hd');
    const rider = await register('rider', 'hr');
    await goOnline(driver, D_300M);
    expect((await send('POST', '/api/riders/me/location', rider.token, PIKE)).status).toBe(204);

    const requested = await requestRide(rider, { dropoff: NEEDLE });
    const offer = await waitOffer(driver, requested);
    expect(offer.tripId).toBe(requested);
    expect(offer.driverId).toBe(driver.id);
    // Pickup and dropoff are snapped to the road network by the trip service (< ~50 m).
    expect(offer.pickup.lat).toBeCloseTo(PIKE.lat, 3);
    expect(offer.pickup.lng).toBeCloseTo(PIKE.lng, 3);
    expect(offer.dropoff.lat).toBeCloseTo(NEEDLE.lat, 3);
    expect(offer.dropoff.lng).toBeCloseTo(NEEDLE.lng, 3);
    expect(offer.etaS).toBeGreaterThan(0);

    const tripId = await accept(driver, offer);
    const matched = await getTrip(driver, tripId);
    expect(matched.status).toBe('MATCHED');
    expect(matched.driverId).toBe(driver.id);
    expect(matched.pickupRoute).not.toBeNull();
    expect(matched.pickupRoute!.geometry.length).toBeGreaterThanOrEqual(2);
    expect(matched.pickupRoute!.durations.length).toBe(matched.pickupRoute!.geometry.length - 1);
    expect(matched.pickupRoute!.distanceM).toBeGreaterThan(0);
    await waitDriverStatus(driver, 'ON_TRIP');

    await step(driver, tripId, 'arrive');
    expect((await getTrip(driver, tripId)).status).toBe('ARRIVED');
    await step(driver, tripId, 'start');
    expect((await getTrip(driver, tripId)).status).toBe('IN_PROGRESS');
    await step(driver, tripId, 'complete');

    const done = await getTrip(rider, tripId);
    expect(done.status).toBe('COMPLETED');
    const times = [
      done.requestedAt,
      done.matchedAt,
      done.arrivedAt,
      done.startedAt,
      done.completedAt,
    ];
    expect(times.every((t) => typeof t === 'number')).toBe(true);
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!);
    expect(done.events.map((e) => e.toStatus)).toEqual([
      'REQUESTED',
      'MATCHED',
      'ARRIVED',
      'IN_PROGRESS',
      'COMPLETED',
    ]);

    await waitDriverStatus(driver, 'AVAILABLE');
    const stats = await api('/api/trips/stats', admin);
    expect(stats.status).toBe(200);
    expect(
      ((await stats.json()) as { completedTrips: number }).completedTrips,
    ).toBeGreaterThanOrEqual(1);

    // The rider is free again.
    const second = await requestRide(rider, { dropoff: NEEDLE });
    expect(second).not.toBe(tripId);
    await waitOffer(driver, second);
    await goOffline(driver);
  });

  it('no drivers: the trip ends as NO_DRIVERS', async () => {
    // Nobody is online (earlier tests clean up), so matching gives up after 60 sim-s (~6 s).
    const rider = await register('rider', 'nr');
    expect((await send('POST', '/api/riders/me/location', rider.token, PIKE)).status).toBe(204);
    const tripId = await requestRide(rider, { dropoff: NEEDLE });
    const trip = await waitTrip(rider, tripId, 'NO_DRIVERS', 60_000);
    expect(trip.driverId).toBeNull();
    expect(trip.events.map((e) => e.toStatus)).toEqual(['REQUESTED', 'NO_DRIVERS']);
  });

  it('decline: the closer driver declines, the next driver gets the same trip', async () => {
    const near = await register('driver', 'dn');
    const far = await register('driver', 'df');
    const rider = await register('rider', 'dr');
    await goOnline(near, D_NEAR);
    await goOnline(far, D_FAR);
    expect((await send('POST', '/api/riders/me/location', rider.token, PIKE)).status).toBe(204);

    const tripId = await requestRide(rider, { dropoff: NEEDLE });
    const first = await waitOffer(near, tripId);
    expect(first.driverId).toBe(near.id);
    const declined = await send('POST', `/api/offers/${first.id}/decline`, near.token);
    expect(declined.status).toBe(204);

    const second = await waitOffer(far, tripId);
    expect(second.driverId).toBe(far.id);
    expect(second.etaS).toBeGreaterThan(first.etaS);
    expect(await accept(far, second)).toBe(tripId);
    expect((await getTrip(rider, tripId)).driverId).toBe(far.id);

    await finishTrip(far, tripId);
    await goOffline(far);
    await goOffline(near);
  });

  it('driver offline while MATCHED re-matches; offline while IN_PROGRESS is a 409', async () => {
    const a = await register('driver', 'oa');
    const b = await register('driver', 'ob');
    const rider = await register('rider', 'or');
    await goOnline(a, D_NEAR);
    await goOnline(b, D_FAR);
    expect((await send('POST', '/api/riders/me/location', rider.token, PIKE)).status).toBe(204);

    const tripId = await requestRide(rider, { dropoff: NEEDLE });
    const offerA = await waitOffer(a, tripId);
    expect(await accept(a, offerA)).toBe(tripId);
    expect((await getTrip(rider, tripId)).status).toBe('MATCHED');

    await goOffline(a);
    const offerB = await waitOffer(b, tripId);
    expect(offerB.driverId).toBe(b.id);
    const requestedAgain = await getTrip(rider, tripId);
    expect(requestedAgain.status).toBe('REQUESTED');
    expect(requestedAgain.driverId).toBeNull();

    expect(await accept(b, offerB)).toBe(tripId);
    await step(b, tripId, 'arrive');
    await step(b, tripId, 'start');
    expect((await send('POST', '/api/drivers/me/offline', b.token)).status).toBe(409);
    expect((await getTrip(rider, tripId)).status).toBe('IN_PROGRESS');
    await step(b, tripId, 'complete');
    await waitDriverStatus(b, 'AVAILABLE');
    await goOffline(b);
  });

  it('invariant: no driver has two non-terminal trips', () => {
    const out = psql(
      `SELECT driver_id, count(*) FROM trip_service.trips ` +
        `WHERE driver_id IS NOT NULL AND status IN ('MATCHED','ARRIVED','IN_PROGRESS') ` +
        `GROUP BY driver_id HAVING count(*) > 1`,
    );
    expect(out.trim()).toBe('');
    const total = psql('SELECT count(*) FROM trip_service.trips');
    expect(Number(total.trim())).toBeGreaterThanOrEqual(4);
  });
});
