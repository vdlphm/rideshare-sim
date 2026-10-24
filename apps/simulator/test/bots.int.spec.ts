import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddRiderResponseSchema, BotsSummarySchema } from '@rideshare/contracts';
import { SignJWT } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { BOT_RNG } from '../src/bots/bot-runtime';
import { FakeStack } from './fake-stack';
import { seeded } from './bots/helpers';

const stack = new FakeStack();
let app: INestApplication;
let base: string;

const key = new TextEncoder().encode('any-key-services-do-not-verify');
const bearer = (sub: string, role: string) =>
  new SignJWT({ sub, role })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(key)
    .then((t) => `Bearer ${t}`);

const state = async () => {
  const res = await request(base)
    .get('/internal/sim/state')
    .set('Authorization', await bearer('svc', 'service'))
    .expect(200);
  return { ...res.body, bots: BotsSummarySchema.parse(res.body.bots) };
};
const put = async (body: object) =>
  request(base)
    .put('/sim/config')
    .set('Authorization', await bearer('adm', 'admin'))
    .send(body)
    .expect(200);

const until = async <T>(
  what: string,
  fn: () => T | undefined | Promise<T | undefined>,
  ms = 20_000,
) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

beforeAll(async () => {
  await stack.start();
  const ref = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        PORT: '0',
        SIMULATOR_CLIENT_SECRET: 'test-secret',
        SIM_BOT_PASSWORD: 'bot-password',
        SIM_BOTS_ENABLED: 'true',
        GATEWAY_URL: stack.gatewayUrl,
        ROUTING_URL: stack.routingUrl,
        USER_SERVICE_URL: stack.userUrl,
        SIM_DEFAULT_SPEED: '10',
        SIM_DEFAULT_DRIVER_COUNT: '3',
        SIM_DEFAULT_SPAWN_INTERVAL_S: '100000', // no random riders until the test asks
        SIM_DEFAULT_ACCEPT_PROBABILITY: '1',
        SIM_MAX_ACTIVE_RIDERS: '1',
      }),
    ],
  })
    .overrideProvider(BOT_RNG)
    .useValue(seeded(42))
    .compile();
  app = ref.createNestApplication();
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
}, 30_000);

afterAll(async () => {
  await app?.close();
  await stack.stop();
});

describe('bots against a fake gateway', () => {
  it('/ready does not depend on the gateway', async () => {
    await request(base).get('/ready').expect(200);
  });

  it('driver bots register with deterministic accounts, go online and heartbeat', async () => {
    await until('3 drivers idle', async () => (await state()).bots.drivers.idle === 3 || undefined);
    expect([...stack.users.keys()].sort()).toEqual([
      'driver-001@sim.local',
      'driver-002@sim.local',
      'driver-003@sim.local',
    ]);
    expect(
      [...stack.users.values()].every((u) =>
        (u.vehicle as { plate: string }).plate.startsWith('SIM-'),
      ),
    ).toBe(true);
    expect(stack.serviceTokenCalls).toBeGreaterThan(0); // routing snap used a service token
    expect([...stack.drivers.values()].every((d) => d.status === 'AVAILABLE' && d.pos)).toBe(true);
    // idle drivers keep posting their location (stale sweeper in the real stack is 60 s)
    await until(
      'heartbeats',
      () => [...stack.drivers.values()].every((d) => d.heartbeats >= 1) || undefined,
      8000,
    );
  }, 15_000);

  it('a spawned rider gets a trip; a driver accepts, drives both legs and completes', async () => {
    const seen = { toPickup: 0, atPickup: 0, inTrip: 0, riding: 0, waiting: 0, active: 0 };
    const sampler = setInterval(() => {
      void state().then((s) => {
        seen.toPickup = Math.max(seen.toPickup, s.bots.drivers.toPickup);
        seen.atPickup = Math.max(seen.atPickup, s.bots.drivers.atPickup);
        seen.inTrip = Math.max(seen.inTrip, s.bots.drivers.inTrip);
        seen.riding = Math.max(seen.riding, s.bots.riders.riding);
        seen.waiting = Math.max(seen.waiting, s.bots.riders.waiting);
        seen.active = Math.max(seen.active, s.bots.riders.active);
      });
    }, 40);
    try {
      await put({ spawnIntervalS: 2 }); // ~0.2 s real at speed 10 (+-30%)
      const trip = await until('a completed trip', () =>
        [...stack.trips.values()].find((t) => t.status === 'COMPLETED'),
      );
      // The rider request went without `pickup`: default-to-position path.
      expect(stack.rideRequests[0].body).not.toHaveProperty('pickup');
      expect(stack.rideRequests[0].email).toBe('rider-001@sim.local');

      const driver = stack.drivers.get(trip.driverId as string)!;
      const email = stack.byId.get(trip.driverId as string)!.email;
      // order of driver actions for this trip
      const mine = stack.log.filter(
        (l) => l.endsWith(`:${email}`) && /^(accept|arrive|start|complete)/.test(l),
      );
      expect(mine.slice(0, 4)).toEqual([
        `accept:${email}`,
        `arrive:${email}`,
        `start:${email}`,
        `complete:${email}`,
      ]);
      expect(trip.events.map((e) => e.toStatus)).toEqual([
        'REQUESTED',
        'MATCHED',
        'ARRIVED',
        'IN_PROGRESS',
        'COMPLETED',
      ]);

      // locations along the pickup route while MATCHED, and along the trip route while IN_PROGRESS
      const matched = driver.locations.filter((l) => l.tripStatus === 'MATCHED');
      const inProgress = driver.locations.filter((l) => l.tripStatus === 'IN_PROGRESS');
      expect(matched.length).toBeGreaterThanOrEqual(2);
      expect(inProgress.length).toBeGreaterThanOrEqual(2);
      const within = (
        p: { lat: number; lng: number },
        a: { lat: number; lng: number },
        b: { lat: number; lng: number },
      ) =>
        p.lat >= Math.min(a.lat, b.lat) - 1e-9 &&
        p.lat <= Math.max(a.lat, b.lat) + 1e-9 &&
        p.lng >= Math.min(a.lng, b.lng) - 1e-9 &&
        p.lng <= Math.max(a.lng, b.lng) + 1e-9;
      const pr = trip.pickupRoute!.geometry;
      const [p0, p2] = [pr[0], pr[2]];
      for (const l of matched) {
        expect(within(l.pos, { lat: p0[1], lng: p0[0] }, { lat: p2[1], lng: p2[0] })).toBe(true);
      }
      for (const l of inProgress) expect(within(l.pos, trip.pickup, trip.dropoff)).toBe(true);
      // the rider bot frees up: the same account requests again once the trip completed
      await until(
        'rider account reuse',
        () =>
          stack.rideRequests.filter((r) => r.email === 'rider-001@sim.local').length >= 2 ||
          undefined,
      );
      expect(new Set(stack.rideRequests.map((r) => r.email))).toEqual(
        new Set(['rider-001@sim.local']),
      );
    } finally {
      clearInterval(sampler);
    }
    expect(seen.toPickup).toBeGreaterThanOrEqual(1);
    expect(seen.atPickup).toBeGreaterThanOrEqual(1);
    expect(seen.inTrip).toBeGreaterThanOrEqual(1);
    expect(seen.riding).toBeGreaterThanOrEqual(1);
    expect(seen.active).toBeLessThanOrEqual(1); // SIM_MAX_ACTIVE_RIDERS
    await put({ spawnIntervalS: 100000 });
  }, 30_000);

  it('PUT /sim/config {driverCount} scales the fleet up and down', async () => {
    await until('quiet fleet', async () => {
      const s = await state();
      return (
        (s.bots.riders.active === 0 && s.bots.drivers.idle === s.bots.drivers.total) || undefined
      );
    });
    await put({ driverCount: 5 });
    await until('5 drivers', async () => (await state()).bots.drivers.idle === 5 || undefined);
    expect(stack.users.has('driver-005@sim.local')).toBe(true);

    await put({ driverCount: 2 });
    await until('2 drivers', async () => {
      const s = await state();
      return s.bots.drivers.total === 2 || undefined;
    });
    expect(stack.offlineCalls.length).toBe(3);
    expect(stack.offlineCalls.sort()).toEqual([
      'driver-003@sim.local',
      'driver-004@sim.local',
      'driver-005@sim.local',
    ]);
  }, 30_000);

  it('POST /sim/riders returns {tripId}; 422 and 409 pass through; admin only', async () => {
    const admin = await bearer('adm', 'admin');
    const pickup = { lat: 47.605, lng: -122.335 };
    const dropoff = { lat: 47.615, lng: -122.325 };
    const res = await request(base)
      .post('/sim/riders')
      .set('Authorization', admin)
      .send({ pickup, dropoff })
      .expect(201);
    const { tripId } = AddRiderResponseSchema.parse(res.body);
    const trip = stack.trips.get(tripId)!;
    // trip snapped the points slightly: compare with tolerance
    expect(Math.abs(trip.pickup.lat - pickup.lat)).toBeLessThan(1e-3);
    // the click-to-add rider sends the exact pickup
    expect(stack.rideRequests.at(-1)!.body.pickup).toEqual(pickup);

    await request(base)
      .post('/sim/riders')
      .set('Authorization', admin)
      .send({ pickup, dropoff: { lat: 47.9, lng: -122.3 } })
      .expect(422);

    await request(base)
      .post('/sim/riders')
      .set('Authorization', await bearer('r', 'rider'))
      .send({ pickup, dropoff })
      .expect(403);
    await request(base)
      .post('/sim/riders')
      .set('Authorization', admin)
      .send({ pickup })
      .expect(400);
  }, 20_000);

  it('a leftover active trip (409) parks that rider account and another is used', async () => {
    // Next free pool account becomes conflicted: seed an active trip for it.
    const used = new Set(stack.rideRequests.map((r) => r.email));
    const next = `rider-${String(used.size + 1).padStart(3, '0')}@sim.local`;
    // register it as the bot would, via the real API, then seed a stuck trip
    await fetch(`${stack.gatewayUrl}/api/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: next, password: 'bot-password', name: 'x', role: 'rider' }),
    });
    stack.seedActiveTrip(next);
    await until(
      'previous rider done',
      async () => (await state()).bots.riders.active === 0 || undefined,
    );
    const admin = await bearer('adm', 'admin');
    const before = stack.rideRequests.length;
    const res = await request(base)
      .post('/sim/riders')
      .set('Authorization', admin)
      .send({ pickup: { lat: 47.605, lng: -122.335 }, dropoff: { lat: 47.615, lng: -122.325 } });
    expect(res.status).toBe(201);
    const emails = stack.rideRequests.slice(before).map((r) => r.email);
    expect(emails.length).toBeGreaterThanOrEqual(1);
    expect(emails.at(-1)).not.toBe(next);
  }, 20_000);
});
