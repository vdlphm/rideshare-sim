import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SimClock } from '@rideshare/common';
import { TripDetailSchema, TripStatsSchema } from '@rideshare/contracts';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { TripsRepository } from '../src/trips/trips.repository';
import { MatchingDispatcher } from '../src/upstream/dispatcher.service';
import { FakeWorld, token } from './support/fake-world';

const INIT_SCRIPT = resolve(__dirname, '../../../infra/postgres/init/01-init.sh');
const TRIP_PW = 'trip-svc-pw';

let container: StartedPostgreSqlContainer;
let admin: Client;
let moduleRef: TestingModule;
let app: INestApplication;
let world: FakeWorld;
let clock: SimClock;
let repo: TripsRepository;

const A = { lat: 47.6062, lng: -122.3321 };
const B = { lat: 47.6205, lng: -122.3493 };
const DRIVER_POS = { lat: 47.61, lng: -122.33 };

const svc = token('trip-caller', 'service');
const asRider = (id: string) => `Bearer ${token(id, 'rider')}`;
const asDriver = (id: string) => `Bearer ${token(id, 'driver')}`;
const asAdmin = `Bearer ${token(randomUUID(), 'admin')}`;
const asService = `Bearer ${svc}`;
const http = () => request(app.getHttpServer());

async function setSimTime(t: number) {
  world.simTime = t;
  await clock.sync();
}

async function createTrip(riderId = randomUUID(), body: object = { pickup: A, dropoff: B }) {
  const res = await http()
    .post('/internal/trips')
    .set('authorization', asRider(riderId))
    .send(body);
  return { res, riderId, tripId: res.body.tripId as string };
}

const assign = (tripId: string, driverId: string) =>
  http()
    .post(`/internal/trips/${tripId}/assign`)
    .set('authorization', asService)
    .send({ driverId, offerId: randomUUID(), driverPosition: DRIVER_POS });

const driverStep = (tripId: string, driverId: string, step: 'arrive' | 'start' | 'complete') =>
  http().post(`/trips/${tripId}/${step}`).set('authorization', asDriver(driverId));

const getTrip = (tripId: string, auth: string) =>
  http().get(`/trips/${tripId}`).set('authorization', auth);

beforeAll(async () => {
  container = await new PostgreSqlContainer('imresamu/postgis:16-3.5')
    .withUsername('postgres')
    .withPassword('pg-admin-pw')
    .withEnvironment({
      USER_SERVICE_DB_PASSWORD: 'user-svc-pw',
      TRIP_SERVICE_DB_PASSWORD: TRIP_PW,
      MATCHING_SERVICE_DB_PASSWORD: 'matching-pw',
    })
    .withCopyFilesToContainer([
      { source: INIT_SCRIPT, target: '/docker-entrypoint-initdb.d/01-init.sh', mode: 0o755 },
    ])
    .start();
  admin = new Client({
    connectionString: `postgres://postgres:pg-admin-pw@${container.getHost()}:${container.getPort()}/ridesharing`,
  });
  await admin.connect();

  world = new FakeWorld();
  await world.start();

  moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        PORT: '0',
        DATABASE_URL: `postgres://trip_service:${TRIP_PW}@${container.getHost()}:${container.getPort()}/ridesharing`,
        DISPATCH_SWEEP_MS: '3600000', // sweeps are driven manually
        ...world.env(),
      }),
    ],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  clock = moduleRef.get(SimClock);
  repo = moduleRef.get(TripsRepository);
}, 240_000);

afterAll(async () => {
  await app?.close();
  await world?.stop();
  await admin?.end();
  await container?.stop();
});

beforeEach(async () => {
  world.driverFailures = 0;
  world.matchingDown = false;
  world.driver.calls.length = 0;
  world.matching.calls.length = 0;
  await setSimTime(1_000_000);
});

describe('lifecycle', () => {
  it('REQUESTED -> MATCHED -> ARRIVED -> IN_PROGRESS -> COMPLETED with events and driver calls', async () => {
    const driverId = randomUUID();
    await setSimTime(2_000_000);
    const { res, riderId, tripId } = await createTrip();
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ tripId });
    expect(world.matching.calls).toHaveLength(1);
    expect(world.matching.calls[0]!.body).toEqual({ tripId, pickup: A, dropoff: B });

    await setSimTime(2_005_000);
    const assigned = await assign(tripId, driverId);
    expect(assigned.status).toBe(200);
    expect(assigned.body).toMatchObject({ status: 'MATCHED', driverId, matchedAt: 2_005_000 });
    expect(assigned.body.pickupRoute.geometry[0]).toEqual([DRIVER_POS.lng, DRIVER_POS.lat]);
    expect(world.driverStatusCalls()).toEqual([[driverId, 'ON_TRIP', tripId]]);

    await setSimTime(2_060_000);
    expect((await driverStep(tripId, driverId, 'arrive')).body.status).toBe('ARRIVED');
    await setSimTime(2_090_000);
    expect((await driverStep(tripId, driverId, 'start')).body.status).toBe('IN_PROGRESS');
    await setSimTime(2_300_000);
    const done = await driverStep(tripId, driverId, 'complete');
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      status: 'COMPLETED',
      requestedAt: 2_000_000,
      matchedAt: 2_005_000,
      arrivedAt: 2_060_000,
      startedAt: 2_090_000,
      completedAt: 2_300_000,
    });
    expect(world.driverStatusCalls()).toEqual([
      [driverId, 'ON_TRIP', tripId],
      [driverId, 'AVAILABLE', null],
    ]);

    const detail = await getTrip(tripId, asRider(riderId));
    expect(detail.status).toBe(200);
    expect(() => TripDetailSchema.parse(detail.body)).not.toThrow();
    expect(
      detail.body.events.map((e: { fromStatus: string; toStatus: string; atSim: number }) => [
        e.fromStatus,
        e.toStatus,
        e.atSim,
      ]),
    ).toEqual([
      [null, 'REQUESTED', 2_000_000],
      ['REQUESTED', 'MATCHED', 2_005_000],
      ['MATCHED', 'ARRIVED', 2_060_000],
      ['ARRIVED', 'IN_PROGRESS', 2_090_000],
      ['IN_PROGRESS', 'COMPLETED', 2_300_000],
    ]);
    expect(detail.body.events[1].meta).toHaveProperty('offerId');
  });

  it('snaps the points, 422s an unroutable one and rejects riderId in the body', async () => {
    const bad = await createTrip(randomUUID(), { pickup: { lat: 85, lng: 0 }, dropoff: B });
    expect(bad.res.status).toBe(422);
    expect(bad.res.body.message).toMatch(/too far/);

    const strict = await createTrip(randomUUID(), { pickup: A, dropoff: B, riderId: randomUUID() });
    expect(strict.res.status).toBe(400);

    const driverOnly = await http()
      .post('/internal/trips')
      .set('authorization', asDriver(randomUUID()))
      .send({ pickup: A, dropoff: B });
    expect(driverOnly.status).toBe(403);
  });
});

describe('create exclusivity', () => {
  it('409s a second create while active and allows one after completion', async () => {
    const { riderId, tripId } = await createTrip();
    const again = await createTrip(riderId);
    expect(again.res.status).toBe(409);
    expect(again.res.body.message).toBe('rider already has an active trip');

    const driverId = randomUUID();
    await assign(tripId, driverId);
    await driverStep(tripId, driverId, 'arrive');
    await driverStep(tripId, driverId, 'start');
    await driverStep(tripId, driverId, 'complete');
    expect((await createTrip(riderId)).res.status).toBe(201);
  });
});

describe('assign', () => {
  it('lets exactly one of two concurrent assigns win', async () => {
    const { tripId } = await createTrip();
    const results = await Promise.all([assign(tripId, randomUUID()), assign(tripId, randomUUID())]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const detail = await getTrip(tripId, asAdmin);
    expect(detail.body.status).toBe('MATCHED');
    expect(
      detail.body.events.filter((e: { toStatus: string }) => e.toStatus === 'MATCHED'),
    ).toHaveLength(1);
  });

  it('409s a driver who already has an active trip and leaves the trip REQUESTED', async () => {
    const driverId = randomUUID();
    const first = await createTrip();
    expect((await assign(first.tripId, driverId)).status).toBe(200);
    const second = await createTrip();
    const res = await assign(second.tripId, driverId);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('driver already has an active trip');
    expect((await getTrip(second.tripId, asAdmin)).body.status).toBe('REQUESTED');
  });

  it('409s a trip that is not REQUESTED and 404s an unknown trip', async () => {
    const { tripId } = await createTrip();
    await assign(tripId, randomUUID());
    expect((await assign(tripId, randomUUID())).status).toBe(409);
    expect((await assign(randomUUID(), randomUUID())).status).toBe(404);
  });

  it('retries a transiently failing driver status call; the trip stays committed', async () => {
    const driverId = randomUUID();
    const { tripId } = await createTrip();
    world.driverFailures = 2;
    const res = await assign(tripId, driverId);
    expect(res.status).toBe(200);
    expect(world.driver.calls).toHaveLength(3);
    expect((await getTrip(tripId, asAdmin)).body.status).toBe('MATCHED');
  });

  it('keeps the trip MATCHED when the driver status call keeps failing', async () => {
    const { tripId } = await createTrip();
    world.driverFailures = 99;
    const res = await assign(tripId, randomUUID());
    world.driverFailures = 0;
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('MATCHED');
  });

  it('requires the service role and driverPosition', async () => {
    const { tripId } = await createTrip();
    const noPos = await http()
      .post(`/internal/trips/${tripId}/assign`)
      .set('authorization', asService)
      .send({ driverId: randomUUID(), offerId: randomUUID() });
    expect(noPos.status).toBe(400);
    const asRiderRes = await http()
      .post(`/internal/trips/${tripId}/assign`)
      .set('authorization', asRider(randomUUID()))
      .send({ driverId: randomUUID(), offerId: randomUUID(), driverPosition: DRIVER_POS });
    expect(asRiderRes.status).toBe(403);
  });
});

describe('driver actions', () => {
  it('403s the wrong driver and 409s an invalid transition', async () => {
    const driverId = randomUUID();
    const { tripId } = await createTrip();
    await assign(tripId, driverId);
    expect((await driverStep(tripId, randomUUID(), 'arrive')).status).toBe(403);
    expect((await driverStep(tripId, driverId, 'start')).status).toBe(409);
    expect((await driverStep(tripId, driverId, 'complete')).status).toBe(409);
    expect((await driverStep(randomUUID(), driverId, 'arrive')).status).toBe(404);
    expect((await driverStep(tripId, driverId, 'arrive')).status).toBe(200);
    expect((await driverStep(tripId, driverId, 'arrive')).status).toBe(409);
  });

  it('rejects non-drivers', async () => {
    const { tripId, riderId } = await createTrip();
    const res = await http().post(`/trips/${tripId}/arrive`).set('authorization', asRider(riderId));
    expect(res.status).toBe(403);
  });
});

describe('unassign / no-drivers', () => {
  it('MATCHED -> REQUESTED clears the pickup route and re-dispatches', async () => {
    const driverId = randomUUID();
    const { tripId } = await createTrip();
    await assign(tripId, driverId);
    world.matching.calls.length = 0;

    const res = await http()
      .post(`/internal/trips/${tripId}/unassign`)
      .set('authorization', asService)
      .send({ reason: 'DRIVER_OFFLINE' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'REQUESTED',
      driverId: null,
      pickupRoute: null,
      matchedAt: null,
    });
    const last = res.body.events.at(-1);
    expect(last).toMatchObject({
      fromStatus: 'MATCHED',
      toStatus: 'REQUESTED',
      meta: { reason: 'DRIVER_OFFLINE', previousDriverId: driverId },
    });
    expect(world.matching.calls.map((c) => (c.body as { tripId: string }).tripId)).toEqual([
      tripId,
    ]);

    // The freed driver can take another trip, and this one can be assigned again.
    expect((await assign(tripId, randomUUID())).status).toBe(200);
  });

  it('409s unassign once the driver is IN_PROGRESS', async () => {
    const driverId = randomUUID();
    const { tripId } = await createTrip();
    await assign(tripId, driverId);
    await driverStep(tripId, driverId, 'arrive');
    expect(
      (
        await http()
          .post(`/internal/trips/${tripId}/unassign`)
          .set('authorization', asService)
          .send({ reason: 'x' })
      ).status,
    ).toBe(409);
    await driverStep(tripId, driverId, 'start');
    const res = await http()
      .post(`/internal/trips/${tripId}/unassign`)
      .set('authorization', asService)
      .send({ reason: 'x' });
    expect(res.status).toBe(409);
  });

  it('REQUESTED -> NO_DRIVERS, repeatable, 409 from MATCHED', async () => {
    const { tripId } = await createTrip();
    const url = `/internal/trips/${tripId}/no-drivers`;
    const first = await http().post(url).set('authorization', asService);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'NO_DRIVERS', endedReason: 'NO_DRIVERS_FOUND' });
    const again = await http().post(url).set('authorization', asService);
    expect(again.status).toBe(200);
    expect(again.body.events).toHaveLength(2);

    const other = await createTrip();
    await assign(other.tripId, randomUUID());
    const res = await http()
      .post(`/internal/trips/${other.tripId}/no-drivers`)
      .set('authorization', asService);
    expect(res.status).toBe(409);
  });
});

describe('GET /trips/:id visibility', () => {
  it('shows a trip to its rider, its driver and admin only', async () => {
    const driverId = randomUUID();
    const { tripId, riderId } = await createTrip();
    await assign(tripId, driverId);

    expect((await getTrip(tripId, asRider(riderId))).status).toBe(200);
    expect((await getTrip(tripId, asDriver(driverId))).status).toBe(200);
    expect((await getTrip(tripId, asAdmin)).status).toBe(200);
    expect((await getTrip(tripId, asRider(randomUUID()))).status).toBe(404);
    expect((await getTrip(tripId, asDriver(randomUUID()))).status).toBe(404);
    expect((await getTrip(randomUUID(), asAdmin)).status).toBe(404);
    expect((await getTrip('not-a-uuid', asAdmin)).status).toBe(400);
    expect((await http().get(`/trips/${tripId}`)).status).toBe(401);
  });
});

describe('GET /internal/trips/active', () => {
  it('filters by driverIds and by updatedSince, including trips that just ended', async () => {
    const d1 = randomUUID();
    const d2 = randomUUID();
    const t1 = (await createTrip()).tripId;
    const t2 = (await createTrip()).tripId;
    const queued = (await createTrip()).tripId;
    await assign(t1, d1);
    await assign(t2, d2);
    const get = (qs: string) =>
      http().get(`/internal/trips/active${qs}`).set('authorization', asService);

    const forD1 = await get(`?driverIds=${d1},${randomUUID()}`);
    expect(forD1.status).toBe(200);
    expect(forD1.body.map((t: { id: string }) => t.id)).toEqual([t1]);
    expect(forD1.headers['x-server-time']).toBeUndefined();

    const nonTerminal = (await get('')).body.map((t: { id: string }) => t.id);
    expect(nonTerminal).toEqual(expect.arrayContaining([t1, t2, queued]));

    const snapshot = await get(`?updatedSince=${new Date(0).toISOString()}`);
    const cursor = snapshot.headers['x-server-time'] as string;
    expect(Number.isNaN(Date.parse(cursor))).toBe(false);

    await driverStep(t1, d1, 'arrive');
    await driverStep(t1, d1, 'start');
    await driverStep(t1, d1, 'complete');
    const diff = await get(`?updatedSince=${encodeURIComponent(cursor)}`);
    expect(diff.body.map((t: { id: string; status: string }) => [t.id, t.status])).toEqual([
      [t1, 'COMPLETED'],
    ]);

    // The completed trip is gone from the non-terminal list and from driverIds queries.
    expect((await get('')).body.map((t: { id: string }) => t.id)).not.toContain(t1);
    expect((await get(`?driverIds=${d1}`)).body).toEqual([]);

    expect((await get('?driverIds=nope')).status).toBe(400);
    expect((await get('?updatedSince=yesterday')).status).toBe(400);
    expect(
      (await http().get('/internal/trips/active').set('authorization', asDriver(d1))).status,
    ).toBe(403);
  });
});

describe('admin list and stats', () => {
  beforeEach(async () => {
    await admin.query('truncate trip_service.trips cascade');
  });

  it('returns nulls on an empty database', async () => {
    const res = await http().get('/trips/stats').set('authorization', asAdmin);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      waitingRiders: 0,
      activeTrips: 0,
      completedTrips: 0,
      noDriverTrips: 0,
      avgWaitToMatchS: null,
      avgWaitToPickupS: null,
      matchRate: null,
    });
  });

  it('computes the StatsPanel numbers on a seeded set and filters the list', async () => {
    await setSimTime(10_000_000); // window starts at 8_200_000
    const seed = async (
      req: number,
      steps: { assign?: number; arrive?: number; complete?: number; noDrivers?: number },
    ) => {
      const trip = await repo.insert({
        riderId: randomUUID(),
        pickup: A,
        dropoff: B,
        tripRoute: {
          distanceM: 1,
          durationS: 1,
          geometry: [
            [0, 0],
            [1, 1],
          ],
          durations: [1],
        },
        requestedAt: req,
      });
      const driverId = randomUUID();
      const act = (action: object, nowSim: number) =>
        repo.applyTransition({ id: trip.id, action: action as never, nowSim });
      if (steps.noDrivers !== undefined) await act({ type: 'noDrivers' }, steps.noDrivers);
      if (steps.assign !== undefined) await act({ type: 'assign', driverId }, steps.assign);
      if (steps.arrive !== undefined) await act({ type: 'arrive', driverId }, steps.arrive);
      if (steps.complete !== undefined) {
        await act({ type: 'start', driverId }, steps.complete - 1);
        await act({ type: 'complete', driverId }, steps.complete);
      }
      return trip.id;
    };
    // completed inside the window: wait-to-match 4 s / 6 s, wait-to-pickup 60 s / 100 s
    await seed(9_000_000, { assign: 9_004_000, arrive: 9_060_000, complete: 9_500_000 });
    await seed(9_100_000, { assign: 9_106_000, arrive: 9_200_000, complete: 9_600_000 });
    // completed long ago: counted, but not in the averages
    await seed(100_000, { assign: 101_000, arrive: 500_000, complete: 1_000_000 });
    await seed(9_800_000, { assign: 9_801_000 }); // MATCHED
    await seed(9_900_000, {}); // REQUESTED
    await seed(9_700_000, { noDrivers: 9_710_000 });

    const expected = {
      waitingRiders: 1,
      activeTrips: 1,
      completedTrips: 3,
      noDriverTrips: 1,
      avgWaitToMatchS: 5,
      avgWaitToPickupS: 80,
      matchRate: 4 / 5,
    };
    const viaAdmin = await http().get('/trips/stats').set('authorization', asAdmin);
    expect(viaAdmin.status).toBe(200);
    expect(TripStatsSchema.parse(viaAdmin.body)).toEqual(expected);
    const viaInternal = await http().get('/internal/trips/stats').set('authorization', asService);
    expect(viaInternal.body).toEqual(expected);
    expect(
      (await http().get('/trips/stats').set('authorization', asRider(randomUUID()))).status,
    ).toBe(403);

    const list = async (qs: string) =>
      (await http().get(`/trips${qs}`).set('authorization', asAdmin)).body as { status: string }[];
    expect((await list('')).map((t) => t.status)).toEqual(['MATCHED']);
    expect((await list('?status=requested')).map((t) => t.status)).toEqual(['REQUESTED']);
    expect(await list('?status=completed')).toHaveLength(3);
    expect(await list('?status=all')).toHaveLength(6);
    expect((await http().get('/trips?status=bogus').set('authorization', asAdmin)).status).toBe(
      400,
    );
  });
});

describe('dispatcher sweep', () => {
  it('re-dispatches an old REQUESTED trip when matching was down at creation', async () => {
    world.matchingDown = true;
    await setSimTime(20_000_000); // SimClock never goes backwards
    const { res, tripId } = await createTrip();
    expect(res.status).toBe(201);
    const dispatcher = moduleRef.get(MatchingDispatcher);

    // Too young yet.
    expect(await dispatcher.sweepOnce()).not.toContain(tripId);

    await setSimTime(20_020_000);
    world.matchingDown = false;
    world.matching.calls.length = 0;
    const sent = await dispatcher.sweepOnce();
    expect(sent).toContain(tripId);
    expect(world.matching.calls.map((c) => (c.body as { tripId: string }).tripId)).toContain(
      tripId,
    );
  });
});
