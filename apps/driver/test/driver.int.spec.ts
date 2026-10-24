import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { CLOCK } from '../src/clock';
import { StaleSweeper } from '../src/sweeper.service';
import { FakeTripService, FakeUserService } from './fake-services';

const fakeUser = new FakeUserService();
const fakeTrip = new FakeTripService();
let container: StartedRedisContainer;
let raw: Redis; // unprefixed: sees the real keys
let app: INestApplication;
let base: string;
const clock = { now: 1_700_000_000_000 };

const key = new TextEncoder().encode('any-key-services-do-not-verify');
const token = (sub: string, role: string) =>
  new SignJWT({ role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setExpirationTime('1h')
    .sign(key);
const auth = async (sub: string, role = 'driver') => `Bearer ${await token(sub, role)}`;

const D = { lat: 10.77, lng: 106.7 };
// ~111 m per 0.001 deg lat
const at = (dLat: number) => ({ lat: D.lat + dLat, lng: D.lng });

async function post(path: string, who: string, body?: object, role = 'driver') {
  return request(base)
    .post(path)
    .set('Authorization', await auth(who, role))
    .send(body ?? {});
}
async function goOnline(id: string, pos = D) {
  const res = await post('/drivers/me/online', id, pos);
  expect(res.status).toBe(200);
  return res.body;
}
const setStatus = async (id: string, body: object) =>
  request(base)
    .put(`/internal/drivers/${id}/status`)
    .set('Authorization', await auth('trip-service', 'service'))
    .send(body);
const nearby = async (pos: { lat: number; lng: number }, radiusM = 1000, limit = 10) =>
  request(base)
    .get('/internal/drivers/nearby')
    .query({ ...pos, radiusM, limit })
    .set('Authorization', await auth('matching', 'service'));
const inGeo = async (id: string) => (await raw.zscore('driver:geo:available', id)) !== null;

beforeAll(async () => {
  container = await new RedisContainer('redis:7.4').start();
  await Promise.all([fakeUser.start(), fakeTrip.start()]);
  const url = container.getConnectionUrl();
  raw = new Redis(url);
  const ref = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        PORT: '0',
        REDIS_URL: url,
        REDIS_KEY_PREFIX: 'driver:',
        STALE_AFTER_MS: '60000',
        SWEEP_INTERVAL_MS: '3600000', // sweeper driven manually
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

describe('driver service (redis)', () => {
  it('health and readiness', async () => {
    expect((await request(base).get('/health')).status).toBe(200);
    const ready = await request(base).get('/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks.redis).toBe('ok');
  });

  it('online writes hash, GEO and online set under the driver: prefix', async () => {
    const id = randomUUID();
    const state = await goOnline(id);
    expect(state).toMatchObject({
      driverId: id,
      status: 'AVAILABLE',
      tripId: null,
      ...D,
      heading: 0,
      ts: clock.now,
    });
    expect(await raw.hgetall(`driver:state:${id}`)).toMatchObject({
      status: 'AVAILABLE',
      tripId: '',
      ts: String(clock.now),
    });
    expect(await inGeo(id)).toBe(true);
    expect(await raw.sismember('driver:online', id)).toBe(1);
    expect(await raw.exists(`state:${id}`, 'online', 'geo:available')).toBe(0);

    // idempotent
    expect((await post('/drivers/me/online', id, D)).body.status).toBe('AVAILABLE');
    expect(await raw.zcard('driver:geo:available')).toBeGreaterThanOrEqual(1);
  });

  it('location updates the GEO position while AVAILABLE', async () => {
    const id = randomUUID();
    await goOnline(id);
    clock.now += 1000;
    const moved = at(0.01);
    const res = await post('/drivers/me/location', id, { ...moved, heading: 90 });
    expect(res.status).toBe(204);
    const [pos] = (await raw.geopos('driver:geo:available', id)) as [[string, string]];
    expect(Number(pos[1])).toBeCloseTo(moved.lat, 4);
    const me = await request(base)
      .get('/drivers/me')
      .set('Authorization', await auth(id));
    expect(me.body).toMatchObject({ ...moved, heading: 90, ts: clock.now });
  });

  it('location before online is 409; /drivers/me is 404 for an unknown driver', async () => {
    const id = randomUUID();
    const res = await post('/drivers/me/location', id, { ...D, heading: 1 });
    expect(res.status).toBe(409);
    const me = await request(base)
      .get('/drivers/me')
      .set('Authorization', await auth(id));
    expect(me.status).toBe(404);
  });

  it('location after offline is 409 and does not re-add to GEO', async () => {
    const id = randomUUID();
    await goOnline(id);
    const off = await post('/drivers/me/offline', id);
    expect(off.status).toBe(200);
    expect(off.body.status).toBe('OFFLINE');
    expect(await inGeo(id)).toBe(false);
    expect(await raw.sismember('driver:online', id)).toBe(0);
    expect((await post('/drivers/me/location', id, { ...D, heading: 1 })).status).toBe(409);
    expect(await inGeo(id)).toBe(false);
  });

  it('validates bodies', async () => {
    const id = randomUUID();
    expect((await post('/drivers/me/online', id, { lat: 200, lng: 0 })).status).toBe(400);
    expect((await post('/drivers/me/online', id, { lat: 89, lng: 0 })).status).toBe(400);
    expect((await post('/drivers/me/location', id, { ...D, heading: 360 })).status).toBe(400);
  });

  it('nearby returns closest-first with distances and excludes OFFLINE/ON_TRIP/stale', async () => {
    // isolated area far from other tests
    const origin = { lat: -33.0, lng: 151.0 };
    const p = (d: number) => ({ lat: origin.lat + d, lng: origin.lng });
    const [far, mid, close, offline, onTrip, outside, stale] = Array.from(
      { length: 7 },
      randomUUID,
    );
    clock.now += 10 * 60_000; // everything created earlier is stale now
    await goOnline(stale!, p(0.0005));
    clock.now += 61_000; // `stale` is now older than 60 s; later drivers are fresh
    await goOnline(far!, p(0.004));
    await goOnline(close!, p(0.001));
    await goOnline(mid!, p(0.002));
    await goOnline(offline!, p(0.0015));
    await post('/drivers/me/offline', offline!);
    await goOnline(onTrip!, p(0.0012));
    expect((await setStatus(onTrip!, { status: 'ON_TRIP', tripId: randomUUID() })).status).toBe(
      200,
    );
    await goOnline(outside!, p(0.5)); // ~55 km away

    const res = await nearby(origin, 1000);
    expect(res.status).toBe(200);
    expect(res.body.map((d: { driverId: string }) => d.driverId)).toEqual([close, mid, far]);
    const [first, second] = res.body;
    expect(first.distanceM).toBeGreaterThan(100);
    expect(first.distanceM).toBeLessThan(120);
    expect(second.distanceM).toBeGreaterThan(first.distanceM);
    expect(first).toMatchObject({ lat: p(0.001).lat, lng: p(0.001).lng });

    // stale member still in GEO (sweeper has not run) is filtered anyway
    expect(await inGeo(stale!)).toBe(true);

    const limited = await nearby(origin, 1000, 2);
    expect(limited.body.map((d: { driverId: string }) => d.driverId)).toEqual([close, mid]);
    expect((await nearby(origin, 150)).body).toHaveLength(1);
    expect((await nearby(origin, 99999)).status).toBe(400);
  });

  it('status ON_TRIP removes from GEO, AVAILABLE re-adds, repeats are no-ops', async () => {
    const id = randomUUID();
    const tripId = randomUUID();
    await goOnline(id);

    const a = await setStatus(id, { status: 'ON_TRIP', tripId });
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ status: 'ON_TRIP', tripId });
    expect(await inGeo(id)).toBe(false);
    expect(await raw.sismember('driver:online', id)).toBe(1);
    const again = await setStatus(id, { status: 'ON_TRIP', tripId });
    expect(again.body).toEqual(a.body);

    // location while ON_TRIP updates the position but never re-adds to GEO
    expect((await post('/drivers/me/location', id, { ...at(0.002), heading: 5 })).status).toBe(204);
    expect(await inGeo(id)).toBe(false);
    // going online again while ON_TRIP keeps ON_TRIP
    expect((await post('/drivers/me/online', id, at(0.003))).body).toMatchObject({
      status: 'ON_TRIP',
      tripId,
      lat: at(0.003).lat,
    });
    expect(await inGeo(id)).toBe(false);

    const b = await setStatus(id, { status: 'AVAILABLE', tripId: null });
    expect(b.body).toMatchObject({ status: 'AVAILABLE', tripId: null });
    expect(await inGeo(id)).toBe(true);
    expect((await setStatus(id, { status: 'AVAILABLE', tripId: null })).body).toEqual(b.body);
    expect(await raw.zcard('driver:geo:available')).toBeGreaterThan(0);

    const off = await setStatus(id, { status: 'OFFLINE', tripId: null });
    expect(off.body.status).toBe('OFFLINE');
    expect(await inGeo(id)).toBe(false);
    expect(await raw.sismember('driver:online', id)).toBe(0);
    expect((await setStatus(id, { status: 'OFFLINE', tripId: null })).status).toBe(200);
  });

  it('status AVAILABLE does not re-add a driver whose position is stale', async () => {
    const id = randomUUID();
    await goOnline(id);
    await setStatus(id, { status: 'ON_TRIP', tripId: randomUUID() });
    clock.now += 61_000;
    const res = await setStatus(id, { status: 'AVAILABLE', tripId: null });
    expect(res.body.status).toBe('AVAILABLE');
    expect(await inGeo(id)).toBe(false);
  });

  it('status endpoint validation: unknown driver 404, bad id 400, tripId rules 400', async () => {
    expect((await setStatus(randomUUID(), { status: 'AVAILABLE', tripId: null })).status).toBe(404);
    expect((await setStatus('not-a-uuid', { status: 'AVAILABLE', tripId: null })).status).toBe(400);
    const id = randomUUID();
    await goOnline(id);
    expect((await setStatus(id, { status: 'ON_TRIP', tripId: null })).status).toBe(400);
    expect((await setStatus(id, { status: 'AVAILABLE', tripId: randomUUID() })).status).toBe(400);
  });

  it('offline while ON_TRIP is 409 and changes nothing', async () => {
    const id = randomUUID();
    const tripId = randomUUID();
    await goOnline(id);
    await setStatus(id, { status: 'ON_TRIP', tripId });
    const res = await post('/drivers/me/offline', id);
    expect(res.status).toBe(409);
    const me = await request(base)
      .get('/drivers/me')
      .set('Authorization', await auth(id));
    expect(me.body).toMatchObject({ status: 'ON_TRIP', tripId });
    expect(await raw.sismember('driver:online', id)).toBe(1);
  });

  it('online list returns AVAILABLE and ON_TRIP drivers only', async () => {
    const [a, b, c] = Array.from({ length: 3 }, randomUUID);
    await goOnline(a!);
    await goOnline(b!);
    await setStatus(b!, { status: 'ON_TRIP', tripId: randomUUID() });
    await goOnline(c!);
    await post('/drivers/me/offline', c!);
    const res = await request(base)
      .get('/internal/drivers/online')
      .set('Authorization', await auth('gateway', 'service'));
    expect(res.status).toBe(200);
    const byId = new Map(res.body.map((s: { driverId: string }) => [s.driverId, s]));
    expect(byId.get(a!)).toMatchObject({ status: 'AVAILABLE' });
    expect(byId.get(b!)).toMatchObject({ status: 'ON_TRIP' });
    expect(byId.has(c!)).toBe(false);
  });

  it('the sweeper marks a stale AVAILABLE driver OFFLINE and leaves ON_TRIP alone', async () => {
    const stale = randomUUID();
    const busy = randomUUID();
    const fresh = randomUUID();
    await goOnline(stale);
    await goOnline(busy);
    await setStatus(busy, { status: 'ON_TRIP', tripId: randomUUID() });
    clock.now += 61_000;
    await goOnline(fresh);

    const sweeper = app.get(StaleSweeper);
    const res = await sweeper.sweepOnce();
    expect(res.swept).toContain(stale);
    expect(res.swept).not.toContain(fresh);
    expect(res.swept).not.toContain(busy);
    expect(res.skippedOnTrip).toContain(busy);

    expect(await raw.hget(`driver:state:${stale}`, 'status')).toBe('OFFLINE');
    expect(await inGeo(stale)).toBe(false);
    expect(await raw.sismember('driver:online', stale)).toBe(0);
    expect(await raw.hget(`driver:state:${busy}`, 'status')).toBe('ON_TRIP');
    expect(await raw.sismember('driver:online', busy)).toBe(1);
    expect(await raw.hget(`driver:state:${fresh}`, 'status')).toBe('AVAILABLE');
  });

  it('race: concurrent location updates vs ON_TRIP never leave the driver in GEO', async () => {
    for (let round = 0; round < 5; round++) {
      const id = randomUUID();
      await goOnline(id);
      const locations = Array.from({ length: 60 }, (_, i) =>
        post('/drivers/me/location', id, { ...at(0.0001 * i), heading: i % 360 }),
      );
      const statusCall = (async () => {
        await new Promise((r) => setTimeout(r, 5));
        return setStatus(id, { status: 'ON_TRIP', tripId: randomUUID() });
      })();
      const results = await Promise.all([...locations, statusCall]);
      expect(results.every((r) => r.status === 204 || r.status === 200)).toBe(true);
      expect(await inGeo(id)).toBe(false);
      expect(await raw.hget(`driver:state:${id}`, 'status')).toBe('ON_TRIP');
    }
  });

  describe('authorization', () => {
    it('rider token is 403 on driver routes; driver token is 403 on internal routes', async () => {
      const id = randomUUID();
      expect((await post('/drivers/me/online', id, D, 'rider')).status).toBe(403);
      expect((await post('/drivers/me/offline', id, {}, 'admin')).status).toBe(403);
      const get = await request(base)
        .get('/drivers/me')
        .set('Authorization', await auth(id, 'rider'));
      expect(get.status).toBe(403);

      const dr = await auth(id, 'driver');
      expect(
        (await request(base).get('/internal/drivers/online').set('Authorization', dr)).status,
      ).toBe(403);
      expect(
        (
          await request(base)
            .get('/internal/drivers/nearby')
            .query({ ...D, radiusM: 100, limit: 1 })
            .set('Authorization', dr)
        ).status,
      ).toBe(403);
      expect(
        (
          await request(base)
            .put(`/internal/drivers/${id}/status`)
            .set('Authorization', dr)
            .send({ status: 'OFFLINE', tripId: null })
        ).status,
      ).toBe(403);
    });

    it('no token is 401; service token is rejected on driver routes', async () => {
      expect((await request(base).get('/drivers/me')).status).toBe(401);
      expect((await post('/drivers/me/online', randomUUID(), D, 'service')).status).toBe(403);
    });

    it('/drivers/me uses the token sub: a body or path id cannot target another driver', async () => {
      const victim = randomUUID();
      const attacker = randomUUID();
      await goOnline(victim, at(0.5));
      // strict schemas reject a smuggled driverId outright
      const res = await post('/drivers/me/online', attacker, { ...D, driverId: victim });
      expect(res.status).toBe(400);
      const own = await post('/drivers/me/online', attacker, D);
      expect(own.body.driverId).toBe(attacker);
      expect((await post(`/drivers/${victim}/offline`, attacker)).status).toBe(404);
      const forged = await request(base)
        .post('/drivers/me/location')
        .set('Authorization', await auth(attacker))
        .send({ ...D, heading: 3, driverId: victim });
      expect(forged.status).toBe(400);
      expect((await post('/drivers/me/location', attacker, { ...D, heading: 3 })).status).toBe(204);
      expect(await raw.hget(`driver:state:${victim}`, 'lat')).toBe(String(at(0.5).lat));
      expect(await raw.hget(`driver:state:${attacker}`, 'heading')).toBe('3');
    });
  });
});
