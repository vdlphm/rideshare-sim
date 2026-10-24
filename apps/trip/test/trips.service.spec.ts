import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { AuthUser, ConfigService } from '@rideshare/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TripEnv } from '../src/config';
import { computeStats, STATS_WINDOW_SIM_MS } from '../src/trips/stats';
import { TripsService } from '../src/trips/trips.service';
import { MatchingDispatcher } from '../src/upstream/dispatcher.service';
import {
  FakeClock,
  FakeRepo,
  asSimClock,
  dropoff,
  fakeUpstreams,
  pickup,
  uuid,
  type Handler,
} from './support/fakes';

const RIDER = uuid();
const DRIVER = uuid();
const DRIVER_POS = { lat: 47.61, lng: -122.33 };
const config = {
  get: (k: string) => ({ DISPATCH_SWEEP_MS: 10_000, DISPATCH_RETRY_AFTER_SIM_MS: 15_000 })[k],
} as unknown as ConfigService<TripEnv>;

const user = (id: string, role: AuthUser['role']): AuthUser => ({ id, role, exp: 0 });

function setup(handlers: Parameters<typeof fakeUpstreams>[0] = {}) {
  const repo = new FakeRepo();
  const clock = new FakeClock();
  const fake = fakeUpstreams(handlers);
  let real = 0;
  const dispatcher = new MatchingDispatcher(
    repo,
    fake.upstreams,
    asSimClock(clock),
    () => real,
    config,
  );
  const service = new TripsService(repo, fake.upstreams, dispatcher, asSimClock(clock));
  return {
    repo,
    clock,
    fake,
    dispatcher,
    service,
    setReal: (n: number) => (real = n),
  };
}

let current: ReturnType<typeof setup>;
afterEach(async () => {
  await current.fake.close();
});

describe('create', () => {
  it('snaps both points, routes the snapped points, inserts, then dispatches', async () => {
    current = setup();
    const { service, repo, fake, clock } = current;
    const { tripId } = await service.create(RIDER, { pickup, dropoff });

    const trip = repo.trips.get(tripId)!;
    expect(trip).toMatchObject({
      riderId: RIDER,
      status: 'REQUESTED',
      requestedAt: clock.t,
      pickup: { lat: pickup.lat + 0.0001, lng: pickup.lng + 0.0001 },
      dropoff: { lat: dropoff.lat + 0.0001, lng: dropoff.lng + 0.0001 },
    });
    const paths = fake.calls.routing.map((c) => new URL(c.path, 'http://x').pathname);
    expect(paths.sort()).toEqual(['/internal/nearest', '/internal/nearest', '/internal/route']);
    const route = fake.calls.routing.find((c) => c.path.startsWith('/internal/route'))!;
    const q = new URL(route.path, 'http://x').searchParams;
    expect(q.get('from')).toBe(`${pickup.lat + 0.0001},${pickup.lng + 0.0001}`);
    expect(fake.calls.matching).toEqual([
      {
        method: 'POST',
        path: '/internal/match',
        body: { tripId, pickup: trip.pickup },
      },
    ]);
  });

  it('still returns the trip id when matching is down', async () => {
    current = setup({ matching: () => ({ status: 503 }) });
    const { tripId } = await current.service.create(RIDER, { pickup, dropoff });
    expect(current.repo.trips.has(tripId)).toBe(true);
    expect(current.fake.calls.matching.length).toBe(3); // idempotent POST is retried
  });

  it('propagates routing 422 and creates nothing', async () => {
    const routing: Handler = (c) =>
      c.path.startsWith('/internal/nearest')
        ? { status: 422, body: { message: 'point is 900 m from the nearest road' } }
        : { status: 200 };
    current = setup({ routing });
    const err = await current.service.create(RIDER, { pickup, dropoff }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as Error).message).toContain('900 m');
    expect(current.repo.trips.size).toBe(0);
    expect(current.fake.calls.matching).toEqual([]);
  });
});

async function matchedTrip() {
  const { service, repo, fake } = current;
  const { tripId } = await service.create(RIDER, { pickup, dropoff });
  await service.assign(tripId, { driverId: DRIVER, offerId: uuid(), driverPosition: DRIVER_POS });
  fake.calls.routing.length = 0;
  return { tripId, repo, fake, service };
}

describe('assign', () => {
  beforeEach(() => {
    current = setup();
  });

  it('routes driverPosition to the trip pickup and marks the driver ON_TRIP', async () => {
    const { service, repo, fake } = current;
    const { tripId } = await service.create(RIDER, { pickup, dropoff });
    const offerId = uuid();
    const detail = await service.assign(tripId, {
      driverId: DRIVER,
      offerId,
      driverPosition: DRIVER_POS,
    });

    expect(detail).toMatchObject({ status: 'MATCHED', driverId: DRIVER });
    expect(detail.pickupRoute!.geometry[0]).toEqual([DRIVER_POS.lng, DRIVER_POS.lat]);
    const trip = repo.trips.get(tripId)!;
    const route = fake.calls.routing.at(-1)!;
    const q = new URL(route.path, 'http://x').searchParams;
    expect(q.get('from')).toBe(`${DRIVER_POS.lat},${DRIVER_POS.lng}`);
    expect(q.get('to')).toBe(`${trip.pickup.lat},${trip.pickup.lng}`);
    expect(fake.calls.driver).toEqual([
      {
        method: 'PUT',
        path: `/internal/drivers/${DRIVER}/status`,
        body: { status: 'ON_TRIP', tripId },
      },
    ]);
  });

  it('is 409 when the trip is not REQUESTED and 404 when unknown', async () => {
    const { tripId, service } = await matchedTrip();
    await expect(
      service.assign(tripId, { driverId: uuid(), offerId: uuid(), driverPosition: DRIVER_POS }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.assign(uuid(), { driverId: uuid(), offerId: uuid(), driverPosition: DRIVER_POS }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('keeps the trip MATCHED when the driver status call keeps failing', async () => {
    current = setup({ driver: () => ({ status: 500 }) });
    const { service, repo } = current;
    const { tripId } = await service.create(RIDER, { pickup, dropoff });
    const detail = await service.assign(tripId, {
      driverId: DRIVER,
      offerId: uuid(),
      driverPosition: DRIVER_POS,
    });
    expect(detail.status).toBe('MATCHED');
    expect(repo.trips.get(tripId)!.status).toBe('MATCHED');
  });
});

describe('driver actions', () => {
  beforeEach(() => {
    current = setup();
  });

  it('completing frees the driver (AVAILABLE, tripId null); earlier steps do not', async () => {
    const { tripId, service, fake } = await matchedTrip();
    fake.calls.driver.length = 0;
    await service.driverAction(tripId, DRIVER, 'arrive');
    await service.driverAction(tripId, DRIVER, 'start');
    expect(fake.calls.driver).toEqual([]);
    const done = await service.driverAction(tripId, DRIVER, 'complete');
    expect(done.status).toBe('COMPLETED');
    expect(done.completedAt).not.toBeNull();
    expect(fake.calls.driver).toEqual([
      {
        method: 'PUT',
        path: `/internal/drivers/${DRIVER}/status`,
        body: { status: 'AVAILABLE', tripId: null },
      },
    ]);
  });

  it('maps the wrong driver to 403 and an invalid transition to 409', async () => {
    const { tripId, service } = await matchedTrip();
    await expect(service.driverAction(tripId, uuid(), 'arrive')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.driverAction(tripId, DRIVER, 'start')).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(service.driverAction(uuid(), DRIVER, 'arrive')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('noDrivers / unassign', () => {
  beforeEach(() => {
    current = setup();
  });

  it('no-drivers is idempotent on an already NO_DRIVERS trip, 409 otherwise', async () => {
    const { service } = current;
    const { tripId } = await service.create(RIDER, { pickup, dropoff });
    expect((await service.noDrivers(tripId)).status).toBe('NO_DRIVERS');
    expect((await service.noDrivers(tripId)).status).toBe('NO_DRIVERS');
    const other = await matchedTrip();
    await expect(service.noDrivers(other.tripId)).rejects.toBeInstanceOf(ConflictException);
  });

  it('unassign returns the trip to REQUESTED and re-dispatches it', async () => {
    const { tripId, service, fake, repo } = await matchedTrip();
    fake.calls.matching.length = 0;
    const detail = await service.unassign(tripId, 'DRIVER_OFFLINE');
    expect(detail).toMatchObject({ status: 'REQUESTED', driverId: null, pickupRoute: null });
    expect(repo.trips.get(tripId)!.matchedAt).toBeNull();
    expect(fake.calls.matching.map((c) => (c.body as { tripId: string }).tripId)).toEqual([tripId]);
  });

  it('unassign is 409 once the driver has arrived', async () => {
    const { tripId, service } = await matchedTrip();
    await service.driverAction(tripId, DRIVER, 'arrive');
    await expect(service.unassign(tripId, 'x')).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('GET visibility', () => {
  it('rider/driver see only their own trips, admin sees all, others get 404', async () => {
    current = setup();
    const { tripId, service } = await matchedTrip();
    for (const u of [user(RIDER, 'rider'), user(DRIVER, 'driver'), user(uuid(), 'admin')]) {
      expect((await service.get(tripId, u)).id).toBe(tripId);
    }
    for (const u of [
      user(uuid(), 'rider'),
      user(uuid(), 'driver'),
      user(DRIVER, 'rider'), // right id, wrong role
      user(RIDER, 'driver'),
    ]) {
      await expect(service.get(tripId, u)).rejects.toBeInstanceOf(NotFoundException);
    }
    await expect(service.get(uuid(), user(uuid(), 'admin'))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('stats', () => {
  it('returns nulls when there is no data', () => {
    expect(
      computeStats({
        waiting: 0,
        active: 0,
        completed: 0,
        noDrivers: 0,
        avgMatchMs: null,
        avgPickupMs: null,
      }),
    ).toEqual({
      waitingRiders: 0,
      activeTrips: 0,
      completedTrips: 0,
      noDriverTrips: 0,
      avgWaitToMatchS: null,
      avgWaitToPickupS: null,
      matchRate: null,
    });
  });

  it('applies the StatsPanel formulas', () => {
    expect(
      computeStats({
        waiting: 2,
        active: 1,
        completed: 5,
        noDrivers: 2,
        avgMatchMs: 4500,
        avgPickupMs: 90_000,
      }),
    ).toMatchObject({ avgWaitToMatchS: 4.5, avgWaitToPickupS: 90, matchRate: 6 / 8 });
    // only failures -> rate 0, not null
    expect(
      computeStats({
        waiting: 0,
        active: 0,
        completed: 0,
        noDrivers: 3,
        avgMatchMs: null,
        avgPickupMs: null,
      }).matchRate,
    ).toBe(0);
  });

  it('asks the repository for the last 30 sim-minutes', async () => {
    current = setup();
    await current.service.stats();
    expect(current.repo.lastStatsWindow).toBe(current.clock.t - STATS_WINDOW_SIM_MS);
  });
});

describe('dispatcher sweep', () => {
  it('re-dispatches only old REQUESTED trips not dispatched within the sweep window', async () => {
    current = setup({ matching: () => ({ status: 503 }) });
    const { service, repo, clock, fake, dispatcher } = current;
    const old = (await service.create(RIDER, { pickup, dropoff })).tripId;
    fake.calls.matching.length = 0;

    // Too young: requested_at is newer than now - 15 s.
    clock.t += 10_000;
    expect(await dispatcher.sweepOnce()).toEqual([]);

    clock.t += 10_000; // 20 s old; matching still down -> attempted, not recorded
    expect(await dispatcher.sweepOnce()).toEqual([]);
    expect(fake.calls.matching.length).toBe(3);

    // Matching recovers: re-dispatched once...
    await fake.close();
    current = setup();
    const c = current;
    c.repo.trips = repo.trips;
    c.clock.t = clock.t;
    expect(await c.dispatcher.sweepOnce()).toEqual([old]);
    // ...but not again inside the same sweep window.
    c.setReal(5_000);
    expect(await c.dispatcher.sweepOnce()).toEqual([]);
    c.setReal(10_000);
    expect(await c.dispatcher.sweepOnce()).toEqual([old]);

    // Matched trips are never re-dispatched.
    await c.service.assign(old, { driverId: DRIVER, offerId: uuid(), driverPosition: DRIVER_POS });
    c.setReal(60_000);
    expect(await c.dispatcher.sweepOnce()).toEqual([]);
  });
});
