import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { SimClock } from '@rideshare/common';
import { OfferSchema } from '@rideshare/contracts';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { FakeWorld, token, type FakeDriver } from './support/fake-world';

vi.setConfig({ testTimeout: 30_000 });

const INIT_SCRIPT = resolve(__dirname, '../../../infra/postgres/init/01-init.sh');
const MATCHING_PW = 'matching-svc-pw';

let pg: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let admin: Client; // superuser: inspects and cleans tables
let raw: Redis; // unprefixed: sees the real keys
let world: FakeWorld;
let moduleRef: TestingModule;
let app: INestApplication;
let clock: SimClock;
let base = 0; // sim time at the start of the current test
const apps: INestApplication[] = [];

const PICKUP = { lat: 47.6062, lng: -122.3321 };
const DROPOFF = { lat: 47.6205, lng: -122.3493 };
const svc = `Bearer ${token('trip', 'service')}`;
const asDriver = (id: string) => `Bearer ${token(id, 'driver')}`;
const http = () => request(app.getHttpServer());

/** A driver `distanceM` north of the pickup. */
function addDriver(distanceM: number, etaS: number | null): FakeDriver {
  const d: FakeDriver = {
    driverId: randomUUID(),
    lat: PICKUP.lat + distanceM / 111_000,
    lng: PICKUP.lng,
    etaS,
  };
  world.drivers.push(d);
  return d;
}

async function setSimTime(t: number) {
  world.simTime = t;
  await clock.sync();
}

async function waitFor<T>(fn: () => Promise<T | false | undefined | null>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const requestMatch = (tripId: string) =>
  http()
    .post('/internal/match')
    .set('authorization', svc)
    .send({ tripId, pickup: PICKUP, dropoff: DROPOFF });

const myOffer = (driverId: string) =>
  http().get('/offers/me').set('authorization', asDriver(driverId));

/** Waits for the driver's offer to show up on GET /offers/me. */
const awaitOffer = (driverId: string) =>
  waitFor(async () => {
    const r = await myOffer(driverId);
    return r.status === 200 ? OfferSchema.parse(r.body) : false;
  });

const accept = (offerId: string, driverId: string) =>
  http().post(`/offers/${offerId}/accept`).set('authorization', asDriver(driverId));
const decline = (offerId: string, driverId: string) =>
  http().post(`/offers/${offerId}/decline`).set('authorization', asDriver(driverId));

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await admin.query(sql, params)).rows as T[];
}
const jobStatus = async (tripId: string) =>
  (
    await q<{ status: string }>('select status from matching_service.match_jobs where trip_id=$1', [
      tripId,
    ])
  )[0]?.status;
const offersFor = (tripId: string) =>
  q<{ driver_id: string; status: string; attempt: number }>(
    'select driver_id, status, attempt from matching_service.offers where trip_id=$1 order by attempt',
    [tripId],
  );

async function bootApp(extra: Record<string, string> = {}) {
  const ref = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        PORT: '0',
        DATABASE_URL: `postgres://matching_service:${MATCHING_PW}@${pg.getHost()}:${pg.getPort()}/ridesharing`,
        REDIS_URL: redisContainer.getConnectionUrl(),
        SWEEP_INTERVAL_MS: '40',
        IDLE_RETRY_MS: '0',
        ...world.env(),
        ...extra,
      }),
    ],
  }).compile();
  const a = ref.createNestApplication();
  await a.init();
  apps.push(a);
  return { ref, app: a };
}

beforeAll(async () => {
  [pg, redisContainer] = await Promise.all([
    new PostgreSqlContainer('imresamu/postgis:16-3.5')
      .withUsername('postgres')
      .withPassword('pg-admin-pw')
      .withEnvironment({
        USER_SERVICE_DB_PASSWORD: 'user-svc-pw',
        TRIP_SERVICE_DB_PASSWORD: 'trip-svc-pw',
        MATCHING_SERVICE_DB_PASSWORD: MATCHING_PW,
      })
      .withCopyFilesToContainer([
        { source: INIT_SCRIPT, target: '/docker-entrypoint-initdb.d/01-init.sh', mode: 0o755 },
      ])
      .start(),
    new RedisContainer('redis:7.4').start(),
  ]);
  admin = new Client({
    connectionString: `postgres://postgres:pg-admin-pw@${pg.getHost()}:${pg.getPort()}/ridesharing`,
  });
  await admin.connect();
  raw = new Redis(redisContainer.getConnectionUrl());

  world = new FakeWorld();
  await world.start();
  ({ ref: moduleRef, app } = await bootApp());
  clock = moduleRef.get(SimClock);
}, 240_000);

afterAll(async () => {
  for (const a of apps) await a.close().catch(() => undefined);
  await world?.stop();
  await admin?.end();
  raw?.disconnect();
  await redisContainer?.stop();
  await pg?.stop();
});

beforeEach(async () => {
  world.reset();
  // SimClock never goes backwards, so every test starts later than the previous one ended.
  base = world.simTime + 1_000_000;
  await setSimTime(base);
  await q('truncate matching_service.offers, matching_service.match_jobs');
  await raw.flushall();
});

afterEach(async () => {
  // Quiesce so a late background step cannot leak into the next test's clean slate.
  await new Promise((r) => setTimeout(r, 60));
});

describe('matching flow', () => {
  it('match -> offer to the best-ETA driver -> /offers/me -> accept -> assign -> 200, job DONE, lock gone', async () => {
    const slowNear = addDriver(200, 400);
    const fast = addDriver(800, 90);
    const tripId = randomUUID();

    const res = await requestMatch(tripId);
    expect(res.status).toBe(202);

    const offer = await awaitOffer(fast.driverId);
    expect(offer).toMatchObject({
      tripId,
      driverId: fast.driverId,
      status: 'PENDING',
      etaS: 90,
      attempt: 1,
      pickup: PICKUP,
      dropoff: DROPOFF,
      expiresSim: base + 15_000,
    });
    expect((await myOffer(slowNear.driverId)).status).toBe(204);
    expect(await raw.get(`matching:lock:driver:${fast.driverId}`)).toBe(tripId);

    const acc = await accept(offer.id, fast.driverId);
    expect(acc.status).toBe(200);
    expect(acc.body).toEqual({ tripId });

    const assigns = world.assignCalls();
    expect(assigns).toHaveLength(1);
    expect(assigns[0]!.path).toBe(`/internal/trips/${tripId}/assign`);
    expect(assigns[0]!.body).toEqual({
      driverId: fast.driverId,
      offerId: offer.id,
      driverPosition: { lat: fast.lat, lng: fast.lng },
    });
    expect(await jobStatus(tripId)).toBe('DONE');
    expect((await offersFor(tripId)).map((o) => o.status)).toEqual(['ACCEPTED']);
    expect(await raw.exists(`matching:lock:driver:${fast.driverId}`)).toBe(0);
    expect((await myOffer(fast.driverId)).status).toBe(204);
  });

  it('decline -> the next candidate gets an offer, the decliner does not', async () => {
    const a = addDriver(100, 30);
    const b = addDriver(300, 60);
    const tripId = randomUUID();
    await requestMatch(tripId);

    const first = await awaitOffer(a.driverId);
    expect((await decline(first.id, a.driverId)).status).toBe(204);

    const second = await awaitOffer(b.driverId);
    expect(second).toMatchObject({ tripId, attempt: 2 });
    expect(await raw.exists(`matching:lock:driver:${a.driverId}`)).toBe(0);
    expect(await raw.sismember(`matching:trip:${tripId}:declined`, a.driverId)).toBe(1);
    expect((await myOffer(a.driverId)).status).toBe(204);
    expect((await offersFor(tripId)).map((o) => o.status)).toEqual(['DECLINED', 'PENDING']);
  });

  it('timeout (sim clock advances) -> offer EXPIRED -> the next candidate', async () => {
    const a = addDriver(100, 30);
    const b = addDriver(300, 60);
    const tripId = randomUUID();
    await requestMatch(tripId);
    const first = await awaitOffer(a.driverId);

    await setSimTime(base + 14_000); // not yet
    await new Promise((r) => setTimeout(r, 200));
    expect((await myOffer(a.driverId)).status).toBe(200);

    await setSimTime(base + 15_000);
    await awaitOffer(b.driverId);
    expect((await offersFor(tripId)).map((o) => o.status)).toEqual(['EXPIRED', 'PENDING']);
    expect((await accept(first.id, a.driverId)).status).toBe(410);
    expect(await raw.exists(`matching:lock:driver:${a.driverId}`)).toBe(0);
  });

  it('a paused clock never expires an offer and the lock survives past its TTL', async () => {
    const [short] = await (async () => {
      const b = await bootApp({ LOCK_TTL_MS: '400' });
      return [b];
    })();
    const prev = app;
    app = short.app; // drive this instance for the test
    try {
      const a = addDriver(100, 30);
      const tripId = randomUUID();
      await requestMatch(tripId);
      await awaitOffer(a.driverId);
      await new Promise((r) => setTimeout(r, 1200)); // 3x the lock TTL, sim time frozen
      expect((await myOffer(a.driverId)).status).toBe(200);
      expect(await raw.get(`matching:lock:driver:${a.driverId}`)).toBe(tripId);
    } finally {
      app = prev;
      await short.app.close();
    }
  });

  it('two trips racing for one driver -> exactly one PENDING offer for that driver', async () => {
    const only = addDriver(100, 30);
    const t1 = randomUUID();
    const t2 = randomUUID();
    await Promise.all([requestMatch(t1), requestMatch(t2)]);

    await awaitOffer(only.driverId);
    await new Promise((r) => setTimeout(r, 400)); // both jobs keep retrying meanwhile
    const pending = await q(
      "select trip_id from matching_service.offers where driver_id=$1 and status='PENDING'",
      [only.driverId],
    );
    expect(pending).toHaveLength(1);
    const all = await q('select * from matching_service.offers where driver_id=$1', [
      only.driverId,
    ]);
    expect(all).toHaveLength(1);
    // The loser keeps waiting (ACTIVE) and is served once the driver frees up.
    const loser = pending[0]!.trip_id === t1 ? t2 : t1;
    expect(await jobStatus(loser)).toBe('ACTIVE');
    const offer = await awaitOffer(only.driverId);
    await decline(offer.id, only.driverId);
    // The winner declined this driver, so the loser's trip is the one that gets offered now.
    const next = await awaitOffer(only.driverId);
    expect(next.tripId).toBe(loser);
  });

  it('double /internal/match -> one job, one offer', async () => {
    const a = addDriver(100, 30);
    addDriver(200, 40);
    const tripId = randomUUID();
    const [r1, r2] = await Promise.all([requestMatch(tripId), requestMatch(tripId)]);
    expect([r1.status, r2.status]).toEqual([202, 202]);
    await requestMatch(tripId);
    await awaitOffer(a.driverId);
    await new Promise((r) => setTimeout(r, 200));
    expect(
      await q('select 1 from matching_service.match_jobs where trip_id=$1', [tripId]),
    ).toHaveLength(1);
    expect(await offersFor(tripId)).toHaveLength(1);
  });

  it('validates /internal/match and requires the service role', async () => {
    const bad = await http()
      .post('/internal/match')
      .set('authorization', svc)
      .send({ tripId: randomUUID(), pickup: PICKUP });
    expect(bad.status).toBe(400);
    const driverToken = await http()
      .post('/internal/match')
      .set('authorization', asDriver(randomUUID()))
      .send({ tripId: randomUUID(), pickup: PICKUP, dropoff: DROPOFF });
    expect(driverToken.status).toBe(403);
    const anon = await http().post('/internal/match').send({});
    expect(anon.status).toBe(401);
  });

  it('restarting the app resumes an ACTIVE job', async () => {
    const tripId = randomUUID();
    // Job created while no one is around, then the instance goes away.
    const first = await bootApp();
    const prev = app;
    app = first.app;
    await requestMatch(tripId);
    await waitFor(async () => (await jobStatus(tripId)) === 'ACTIVE');
    await first.app.close();
    app = prev;

    const a = addDriver(100, 30);
    const second = await bootApp();
    app = second.app;
    try {
      const offer = await awaitOffer(a.driverId);
      expect(offer.tripId).toBe(tripId);
    } finally {
      app = prev;
      await second.app.close(); // a second live instance would race the main one
    }
  });

  it('no drivers for 60 sim-s -> trip gets no-drivers and the job is FAILED', async () => {
    const tripId = randomUUID();
    await requestMatch(tripId);
    await waitFor(async () => world.driver.calls.length > 0);
    expect(world.noDriversCalls()).toHaveLength(0);

    await setSimTime(base + 59_000);
    await new Promise((r) => setTimeout(r, 200));
    expect(world.noDriversCalls()).toHaveLength(0);

    await setSimTime(base + 60_001);
    await waitFor(async () => (await jobStatus(tripId)) === 'FAILED');
    const calls = world.noDriversCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe(`/internal/trips/${tripId}/no-drivers`);
    // Widened to the max radius while waiting.
    const radii = new Set(
      world.driver.calls.map((c) => new URL(c.path, 'http://x').searchParams.get('radiusM')),
    );
    expect([...radii].sort()).toEqual(['1000', '2000', '4000']);
  });

  it('a FAILED job is restarted by a new /internal/match (rematch)', async () => {
    const tripId = randomUUID();
    await requestMatch(tripId);
    await setSimTime(base + 61_000);
    await waitFor(async () => (await jobStatus(tripId)) === 'FAILED');

    const a = addDriver(100, 30);
    expect((await requestMatch(tripId)).status).toBe(202);
    await awaitOffer(a.driverId);
    expect(await jobStatus(tripId)).toBe('ACTIVE');
  });

  it('a driver who goes offline mid-offer -> offer expires -> next candidate', async () => {
    const a = addDriver(100, 30);
    const b = addDriver(300, 60);
    const tripId = randomUUID();
    await requestMatch(tripId);
    await awaitOffer(a.driverId);

    world.drivers = world.drivers.filter((d) => d.driverId !== a.driverId); // offline
    await new Promise((r) => setTimeout(r, 150));
    expect((await myOffer(a.driverId)).status).toBe(200); // still pending until it times out

    await setSimTime(base + 15_000);
    await awaitOffer(b.driverId);
    expect((await offersFor(tripId)).map((o) => [o.driver_id, o.status])).toEqual([
      [a.driverId, 'EXPIRED'],
      [b.driverId, 'PENDING'],
    ]);
  });
});

describe('driver routes', () => {
  it('wrong driver accepting/declining -> 404, offer unaffected; double accept -> 410', async () => {
    const a = addDriver(100, 30);
    const other = randomUUID();
    const tripId = randomUUID();
    await requestMatch(tripId);
    const offer = await awaitOffer(a.driverId);

    expect((await accept(offer.id, other)).status).toBe(404);
    expect((await decline(offer.id, other)).status).toBe(404);
    expect((await accept(randomUUID(), a.driverId)).status).toBe(404);
    expect((await accept('not-a-uuid', a.driverId)).status).toBe(400);
    expect((await myOffer(a.driverId)).status).toBe(200);
    expect(world.assignCalls()).toHaveLength(0);

    expect((await accept(offer.id, a.driverId)).status).toBe(200);
    expect((await accept(offer.id, a.driverId)).status).toBe(410);
    expect((await decline(offer.id, a.driverId)).status).toBe(410);
    expect(world.assignCalls()).toHaveLength(1);
  });

  it('concurrent double accept assigns once', async () => {
    const a = addDriver(100, 30);
    await requestMatch(randomUUID());
    const offer = await awaitOffer(a.driverId);
    const [r1, r2] = await Promise.all([
      accept(offer.id, a.driverId),
      accept(offer.id, a.driverId),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 410]);
    expect(world.assignCalls()).toHaveLength(1);
  });

  it('only drivers may use the offer routes', async () => {
    const rider = await http()
      .get('/offers/me')
      .set('authorization', `Bearer ${token(randomUUID(), 'rider')}`);
    expect(rider.status).toBe(403);
    expect((await http().get('/offers/me')).status).toBe(401);
  });

  it('trip 409 "driver already has an active trip" -> 409 and the next candidate is offered', async () => {
    const a = addDriver(100, 30);
    const b = addDriver(300, 60);
    world.assignReply = (body) =>
      body.driverId === a.driverId
        ? { status: 409, body: { message: 'driver already has an active trip' } }
        : { status: 200 };
    const tripId = randomUUID();
    await requestMatch(tripId);
    const offer = await awaitOffer(a.driverId);

    const res = await accept(offer.id, a.driverId);
    expect(res.status).toBe(409);
    const next = await awaitOffer(b.driverId);
    expect(next.tripId).toBe(tripId);
    expect((await offersFor(tripId)).map((o) => o.status)).toEqual(['EXPIRED', 'PENDING']);
    expect(await jobStatus(tripId)).toBe('ACTIVE');
    expect(await raw.exists(`matching:lock:driver:${a.driverId}`)).toBe(0);
    expect((await accept(next.id, b.driverId)).status).toBe(200);
  });

  it('trip 409 "Trip was modified concurrently" -> 409 and the next candidate', async () => {
    const a = addDriver(100, 30);
    const b = addDriver(300, 60);
    let first = true;
    world.assignReply = () => {
      if (first) {
        first = false;
        return { status: 409, body: { message: 'Trip was modified concurrently' } };
      }
      return { status: 200 };
    };
    await requestMatch(randomUUID());
    const offer = await awaitOffer(a.driverId);
    expect((await accept(offer.id, a.driverId)).status).toBe(409);
    await awaitOffer(b.driverId);
  });

  it('trip 409 "Cannot assign a trip in status X" -> 409, job DONE, no more offers', async () => {
    const a = addDriver(100, 30);
    addDriver(300, 60);
    world.assignReply = () => ({
      status: 409,
      body: { message: 'Cannot assign a trip in status NO_DRIVERS' },
    });
    const tripId = randomUUID();
    await requestMatch(tripId);
    const offer = await awaitOffer(a.driverId);
    const res = await accept(offer.id, a.driverId);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('trip no longer available');
    expect(await jobStatus(tripId)).toBe('DONE');
    await new Promise((r) => setTimeout(r, 300));
    expect(await offersFor(tripId)).toHaveLength(1);
  });

  it('trip unreachable -> 502 and the offer stays pending so the driver can retry', async () => {
    const a = addDriver(100, 30);
    world.assignReply = () => ({ status: 503 });
    const tripId = randomUUID();
    await requestMatch(tripId);
    const offer = await awaitOffer(a.driverId);
    expect((await accept(offer.id, a.driverId)).status).toBe(502);
    expect((await myOffer(a.driverId)).status).toBe(200);
    world.assignReply = () => ({ status: 200 });
    expect((await accept(offer.id, a.driverId)).body).toEqual({ tripId });
  }, 20_000);
});

describe('infrastructure', () => {
  it('uses only the matching: key prefix in Redis', async () => {
    const a = addDriver(100, 30);
    const tripId = randomUUID();
    await requestMatch(tripId);
    const offer = await awaitOffer(a.driverId);
    await decline(offer.id, a.driverId);
    const keys = await raw.keys('*');
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.startsWith('matching:'))).toBe(true);
    expect(keys).toContain(`matching:trip:${tripId}:declined`);
    const ttl = await raw.ttl(`matching:trip:${tripId}:declined`);
    expect(ttl).toBeGreaterThan(3500);
    expect(ttl).toBeLessThanOrEqual(3600);
  });

  it('connects as matching_service and keeps its tables in that schema', async () => {
    const rows = await q<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema='matching_service' and table_name in ('offers','match_jobs')",
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual(['match_jobs', 'offers']);
    const idx = await q<{ indexdef: string }>(
      "select indexdef from pg_indexes where schemaname='matching_service' and indexname='offers_driver_pending_idx'",
    );
    expect(idx[0]!.indexdef).toContain("'PENDING'");
  });

  it('serves /health and /ready (Postgres + Redis)', async () => {
    expect((await http().get('/health')).status).toBe(200);
    const ready = await http().get('/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toEqual({ postgres: 'ok', redis: 'ok' });
  });
});
