import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { CLOCK } from '../src/clock';
import { DriverStore } from '../src/driver.store';
import { ReconcileJob } from '../src/reconcile.service';
import { StaleSweeper } from '../src/sweeper.service';
import { FakeTripService, FakeUserService } from './fake-services';

const fakeUser = new FakeUserService();
const fakeTrip = new FakeTripService();
let container: StartedRedisContainer;
let raw: Redis;
let app: INestApplication;
let base: string;
const clock = { now: 1_700_000_000_000 };

const key = new TextEncoder().encode('any-key-services-do-not-verify');
const auth = async (sub: string, role = 'driver') =>
  `Bearer ${await new SignJWT({ role }).setProtectedHeader({ alg: 'HS256' }).setSubject(sub).setExpirationTime('1h').sign(key)}`;

const D = { lat: 10.77, lng: 106.7 };
const goOnline = async (id: string) => {
  const res = await request(base)
    .post('/drivers/me/online')
    .set('Authorization', await auth(id))
    .send(D);
  expect(res.status).toBe(200);
};
const offline = async (id: string) =>
  request(base)
    .post('/drivers/me/offline')
    .set('Authorization', await auth(id))
    .send({});
const setStatus = async (id: string, body: object) =>
  request(base)
    .put(`/internal/drivers/${id}/status`)
    .set('Authorization', await auth('trip-service', 'service'))
    .send(body);
const onTrip = async (id: string, tripId: string) => {
  await goOnline(id);
  expect((await setStatus(id, { status: 'ON_TRIP', tripId })).status).toBe(200);
};
const inGeo = async (id: string) => (await raw.zscore('driver:geo:available', id)) !== null;
const hash = (id: string) => raw.hgetall(`driver:state:${id}`);

beforeAll(async () => {
  container = await new RedisContainer('redis:7.4').start();
  await Promise.all([fakeUser.start(), fakeTrip.start()]);
  raw = new Redis(container.getConnectionUrl());
  const ref = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        PORT: '0',
        REDIS_URL: container.getConnectionUrl(),
        REDIS_KEY_PREFIX: 'driver:',
        STALE_AFTER_MS: '60000',
        SWEEP_INTERVAL_MS: '3600000',
        RECONCILE_INTERVAL_MS: '3600000',
        TRIP_URL: fakeTrip.url,
        USER_SERVICE_URL: fakeUser.url,
        DRIVER_CLIENT_SECRET: 'test-secret',
      }),
    ],
  })
    .overrideProvider(CLOCK)
    .useValue(() => clock.now)
    .compile();
  app = ref.createNestApplication();
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await raw?.quit();
  await container?.stop();
  await Promise.all([fakeUser.stop(), fakeTrip.stop()]);
});

beforeEach(async () => {
  fakeTrip.reset();
  // Isolate tests: no driver left online from earlier ones.
  await raw.del('driver:online', 'driver:geo:available');
});

describe('offline while ON_TRIP', () => {
  it('unassigns the MATCHED trip, then the driver is OFFLINE and out of GEO and the online set', async () => {
    const id = randomUUID();
    const tripId = randomUUID();
    await onTrip(id, tripId);
    fakeTrip.unassignStatus.set(tripId, 200);

    const res = await offline(id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'OFFLINE', tripId: null });
    const [call] = fakeTrip.unassigns();
    expect(fakeTrip.unassigns()).toHaveLength(1);
    expect(call).toMatchObject({
      method: 'POST',
      path: `/internal/trips/${tripId}/unassign`,
      body: { reason: 'driver_offline' },
      authorization: 'Bearer fake-service-token',
    });
    expect((await hash(id)).status).toBe('OFFLINE');
    expect(await inGeo(id)).toBe(false);
    expect(await raw.sismember('driver:online', id)).toBe(0);
  });

  it('trip 409 (ARRIVED/IN_PROGRESS) -> 409 and the driver stays ON_TRIP', async () => {
    const id = randomUUID();
    const tripId = randomUUID();
    await onTrip(id, tripId);
    fakeTrip.unassignStatus.set(tripId, 409);
    const res = await offline(id);
    expect(res.status).toBe(409);
    expect(await hash(id)).toMatchObject({ status: 'ON_TRIP', tripId });
    expect(await raw.sismember('driver:online', id)).toBe(1);
  });

  it('trip unreachable -> 502 and the driver stays ON_TRIP', async () => {
    const id = randomUUID();
    const tripId = randomUUID();
    await onTrip(id, tripId);
    fakeTrip.unassignStatus.set(tripId, 503);
    expect((await offline(id)).status).toBe(502);
    expect(await hash(id)).toMatchObject({ status: 'ON_TRIP', tripId });
  });

  it('a driver whose trip changed while unassign was in flight is not taken offline', async () => {
    const id = randomUUID();
    const tripId = randomUUID();
    const other = randomUUID();
    await onTrip(id, tripId);
    fakeTrip.unassignStatus.set(tripId, 200);
    fakeTrip.onUnassign = async () => {
      expect((await setStatus(id, { status: 'ON_TRIP', tripId: other })).status).toBe(200);
    };
    expect((await offline(id)).status).toBe(409);
    expect(await hash(id)).toMatchObject({ status: 'ON_TRIP', tripId: other });
  });

  it('the guarded Lua path refuses a different tripId and accepts the same one', async () => {
    const store = app.get(DriverStore);
    const id = randomUUID();
    const tripId = randomUUID();
    await onTrip(id, tripId);
    const wrong = await store.offlineAfterUnassign(id, randomUUID(), clock.now);
    expect(wrong.code).toBe('CHANGED');
    expect((await hash(id)).status).toBe('ON_TRIP');
    const right = await store.offlineAfterUnassign(id, tripId, clock.now);
    expect(right.code).toBe('OK');
    expect(await hash(id)).toMatchObject({ status: 'OFFLINE', tripId: '' });
  });
});

describe('stale ON_TRIP sweeping', () => {
  it('unassigns with driver_stale and takes the driver OFFLINE; 409 leaves the driver alone', async () => {
    const gone = randomUUID();
    const busy = randomUUID();
    const goneTrip = randomUUID();
    const busyTrip = randomUUID();
    await onTrip(gone, goneTrip);
    await onTrip(busy, busyTrip);
    fakeTrip.unassignStatus.set(goneTrip, 200);
    fakeTrip.unassignStatus.set(busyTrip, 409);
    clock.now += 61_000;

    const res = await app.get(StaleSweeper).sweepOnce();
    expect(res.unassigned).toEqual([gone]);
    expect(res.skippedOnTrip).toEqual([busy]);
    expect(fakeTrip.unassigns().map((c) => c.body)).toEqual(
      expect.arrayContaining([{ reason: 'driver_stale' }]),
    );
    expect((await hash(gone)).status).toBe('OFFLINE');
    expect(await raw.sismember('driver:online', gone)).toBe(0);
    expect(await hash(busy)).toMatchObject({ status: 'ON_TRIP', tripId: busyTrip });
  });
});

describe('reconcile', () => {
  it('ON_TRIP without an active trip -> AVAILABLE and back in GEO (fresh position)', async () => {
    const id = randomUUID();
    await onTrip(id, randomUUID());
    expect(await inGeo(id)).toBe(false);
    const res = await app.get(ReconcileJob).reconcileOnce();
    expect(res.released).toEqual([id]);
    expect(await hash(id)).toMatchObject({ status: 'AVAILABLE', tripId: '' });
    expect(await inGeo(id)).toBe(true);
    expect(
      fakeTrip.calls.find((c) => c.path === '/internal/trips/active')?.query.get('driverIds'),
    ).toBe(id);
  });

  it('ON_TRIP without an active trip but a stale position -> AVAILABLE, not in GEO', async () => {
    const id = randomUUID();
    await onTrip(id, randomUUID());
    clock.now += 61_000;
    await app.get(ReconcileJob).reconcileOnce();
    expect((await hash(id)).status).toBe('AVAILABLE');
    expect(await inGeo(id)).toBe(false);
  });

  it('AVAILABLE with an active trip -> ON_TRIP with that trip, out of GEO', async () => {
    const id = randomUUID();
    const tripId = randomUUID();
    await goOnline(id);
    fakeTrip.active = [{ id: tripId, driverId: id }];
    const res = await app.get(ReconcileJob).reconcileOnce();
    expect(res.assigned).toEqual([id]);
    expect(await hash(id)).toMatchObject({ status: 'ON_TRIP', tripId });
    expect(await inGeo(id)).toBe(false);
  });

  it('tripId mismatch -> fixed to the active trip', async () => {
    const id = randomUUID();
    const tripId = randomUUID();
    await onTrip(id, randomUUID());
    fakeTrip.active = [{ id: tripId, driverId: id }];
    const res = await app.get(ReconcileJob).reconcileOnce();
    expect(res.retargeted).toEqual([id]);
    expect(await hash(id)).toMatchObject({ status: 'ON_TRIP', tripId });
  });

  it('trip unreachable -> the round is skipped and nothing changes', async () => {
    const id = randomUUID();
    const tripId = randomUUID();
    await onTrip(id, tripId);
    fakeTrip.activeStatus = 503;
    const res = await app.get(ReconcileJob).reconcileOnce();
    expect(res.skipped).toBe(true);
    expect(await hash(id)).toMatchObject({ status: 'ON_TRIP', tripId });
  });
});
