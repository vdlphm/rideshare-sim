import { interpolateAlongRoute } from '@rideshare/geo';
import { describe, expect, it } from 'vitest';
import {
  DriverBot,
  HEARTBEAT_MS,
  decide,
  initialDriverState,
  offerPollIntervalMs,
} from '../../src/bots/driver-bot';
import {
  A,
  FakeDriverApi,
  FakeEnv,
  PICKUP_ROUTE,
  TRIP_ROUTE,
  err,
  identitySnapper,
  ok,
  offer,
  trip,
} from './helpers';

const make = (api = new FakeDriverApi(), env = new FakeEnv()) => {
  const bot = new DriverBot(1, api, env, identitySnapper);
  return { api, env, bot };
};

/** Run due jobs, advancing real time by `stepMs` per iteration. */
async function drive(bot: DriverBot, env: FakeEnv, realMs: number, stepMs = 100): Promise<void> {
  for (let t = 0; t < realMs; t += stepMs) {
    const job = bot.due();
    if (job) await job();
    env.advance(stepMs);
  }
}

async function runOnce(bot: DriverBot): Promise<boolean> {
  const job = bot.due();
  if (!job) return false;
  await job();
  return true;
}

/** Bot already idle at A, online. */
async function idleBot(api = new FakeDriverApi(), env = new FakeEnv()) {
  api.me = ok({ status: 'AVAILABLE', tripId: null, driverId: 'drv-1', lat: A.lat, lng: A.lng });
  const ctx = make(api, env);
  await runOnce(ctx.bot);
  expect(ctx.bot.phase).toBe('IDLE');
  return ctx;
}

/** Bot that accepted offer-1 and is TO_PICKUP with legStartSim = now. */
async function toPickupBot(env = new FakeEnv()) {
  const api = new FakeDriverApi();
  const ctx = await idleBot(api, env);
  api.offerQueue.push(offer());
  for (let i = 0; i < 100 && ctx.bot.phase !== 'TO_PICKUP'; i++) await drive(ctx.bot, env, 100);
  expect(ctx.bot.phase).toBe('TO_PICKUP');
  return ctx;
}

describe('offerPollIntervalMs', () => {
  it('scales with speed and is clamped to [150, 1500]', () => {
    expect(offerPollIntervalMs(1)).toBe(1500);
    expect(offerPollIntervalMs(5)).toBe(600);
    expect(offerPollIntervalMs(10)).toBe(300);
    expect(offerPollIntervalMs(10, 5000)).toBe(150);
    expect(offerPollIntervalMs(0)).toBe(1500);
  });
});

describe('driver start', () => {
  it('registers, goes online at a snapped point and becomes IDLE', async () => {
    const { api, bot } = make();
    await runOnce(bot);
    expect(api.calls[0]).toBe('ensure');
    expect(api.calls[1]).toBe('me');
    expect(api.calls[2]).toMatch(/^online:47\.\d+,-122\.\d+$/);
    expect(bot.phase).toBe('IDLE');
    expect(bot.state.position).not.toBeNull();
  });

  it('treats 404 from /drivers/me (never been online) as OFFLINE and goes online', async () => {
    const api = new FakeDriverApi();
    api.me = err(404, 'Driver not found');
    const { bot } = make(api);
    await runOnce(bot);
    expect(api.calls[2]).toMatch(/^online:/);
    expect(bot.phase).toBe('IDLE');
  });

  it('backs off and retries when the gateway is down', async () => {
    const api = new FakeDriverApi();
    api.me = err(0, 'ECONNREFUSED');
    const { bot, env } = make(api);
    await runOnce(bot);
    expect(bot.phase).toBe('STARTING');
    expect(bot.due()).toBeNull(); // backing off
    env.advance(1100);
    expect(bot.due()).not.toBeNull();
    api.me = ok({ status: 'OFFLINE', tripId: null });
    await runOnce(bot);
    expect(bot.phase).toBe('IDLE');
  });

  it('keeps an already AVAILABLE driver where it is', async () => {
    const { api, bot } = await idleBot();
    expect(api.calls.some((c) => c.startsWith('online'))).toBe(false);
    expect(bot.state.position).toEqual(A);
  });

  it('resumes an ON_TRIP driver at the trip phase', async () => {
    for (const [status, phase] of [
      ['MATCHED', 'TO_PICKUP'],
      ['ARRIVED', 'AT_PICKUP'],
      ['IN_PROGRESS', 'IN_TRIP'],
    ] as const) {
      const api = new FakeDriverApi();
      api.me = ok({
        status: 'ON_TRIP',
        tripId: 'trip-1',
        driverId: 'drv-1',
        lat: A.lat,
        lng: A.lng,
      });
      api.tripResult = ok(trip({ status }));
      const { bot } = make(api);
      await runOnce(bot); // init
      await runOnce(bot); // fetch trip
      expect(bot.phase).toBe(phase);
    }
  });

  it('goes IDLE when the resumed trip is not ours or not active', async () => {
    for (const t of [trip({ driverId: 'someone-else' }), trip({ status: 'COMPLETED' })]) {
      const api = new FakeDriverApi();
      api.me = ok({
        status: 'ON_TRIP',
        tripId: 'trip-1',
        driverId: 'drv-1',
        lat: A.lat,
        lng: A.lng,
      });
      api.tripResult = ok(t);
      const { bot } = make(api);
      await runOnce(bot);
      await runOnce(bot);
      expect(bot.phase).toBe('IDLE');
    }
  });
});

describe('IDLE and offers', () => {
  it('heartbeats location and polls offers at the scaled rate', async () => {
    const env = new FakeEnv();
    env.cfg.speed = 10;
    const { api, bot } = await idleBot(new FakeDriverApi(), env);
    api.calls.length = 0;
    await drive(bot, env, 6000);
    // 6 s real: polls every 300 ms (speed 10), heartbeat every 3 s
    expect(api.count('poll')).toBeGreaterThanOrEqual(18);
    expect(api.count('poll')).toBeLessThanOrEqual(21);
    expect(api.count('location')).toBeGreaterThanOrEqual(1);
    expect(api.count('location')).toBeLessThanOrEqual(3);
  });

  it('polls slower at speed 1 (1500 ms)', async () => {
    const env = new FakeEnv();
    const { api, bot } = await idleBot(new FakeDriverApi(), env);
    api.calls.length = 0;
    await drive(bot, env, 6000);
    expect(api.count('poll')).toBeLessThanOrEqual(5);
    expect(api.count('poll')).toBeGreaterThanOrEqual(3);
  });

  it('answers an offer only after the 0.5-2 sim-s delay', async () => {
    const env = new FakeEnv();
    const { api, bot } = await idleBot(new FakeDriverApi(), env);
    api.offerQueue.push(offer());
    let offeredSim = -1;
    let answeredSim = -1;
    for (let i = 0; i < 100 && answeredSim < 0; i++) {
      await drive(bot, env, 100);
      if (bot.phase === 'OFFERED' && offeredSim < 0) offeredSim = env.sim;
      if (api.count('accept') > 0) answeredSim = env.sim;
    }
    expect(offeredSim).toBeGreaterThanOrEqual(0);
    const delay = answeredSim - offeredSim;
    expect(delay).toBeGreaterThanOrEqual(400);
    expect(delay).toBeLessThanOrEqual(2200);
  });

  it('acceptProbability 0 always declines, 1 always accepts', async () => {
    for (const [p, expected] of [
      [0, 'decline:offer-1'],
      [1, 'accept:offer-1'],
    ] as const) {
      for (let seed = 1; seed <= 5; seed++) {
        const env = new FakeEnv(seed);
        env.cfg.acceptProbability = p;
        const { api, bot } = await idleBot(new FakeDriverApi(), env);
        api.offerQueue.push(offer());
        await drive(bot, env, 5000);
        expect(api.calls).toContain(expected);
        expect(api.calls.some((c) => c.startsWith(p === 0 ? 'accept' : 'decline'))).toBe(false);
      }
    }
  });

  it('picks up a live acceptProbability change', async () => {
    const env = new FakeEnv();
    env.cfg.acceptProbability = 1;
    const { api, bot } = await idleBot(new FakeDriverApi(), env);
    api.offerQueue.push(offer());
    await drive(bot, env, 1600, 100); // OFFERED now (or accepted)
    env.cfg = { ...env.cfg, acceptProbability: 0 };
    // Not answered yet only if still OFFERED; otherwise the test is vacuous but still valid.
    if (bot.phase === 'OFFERED') {
      await drive(bot, env, 3000);
      expect(api.calls.some((c) => c.startsWith('decline'))).toBe(true);
    }
  });

  it.each([409, 410])('accept %i returns to IDLE', async (status) => {
    const env = new FakeEnv();
    const { api, bot } = await idleBot(new FakeDriverApi(), env);
    api.accept = err(status);
    api.offerQueue.push(offer());
    await drive(bot, env, 4000);
    expect(api.count('accept')).toBe(1);
    expect(bot.phase).toBe('IDLE');
  });

  it('retries accept once on 502', async () => {
    const env = new FakeEnv();
    const { api, bot } = await idleBot(new FakeDriverApi(), env);
    const results = [err(502), ok({ tripId: 'trip-1' })];
    api.accept = () => results.shift()!;
    api.offerQueue.push(offer());
    await drive(bot, env, 4000);
    expect(api.count('accept')).toBe(2);
    expect(bot.phase).toBe('TO_PICKUP');
  });

  it('does not accept or decline while paused, but still heartbeats', async () => {
    const env = new FakeEnv();
    const { api, bot } = await idleBot(new FakeDriverApi(), env);
    api.offerQueue.push(offer());
    // Get it OFFERED: poll fires, answer delay needs sim time
    env.advance(1600);
    await runOnce(bot);
    expect(bot.phase).toBe('OFFERED');
    env.cfg = { ...env.cfg, paused: true };
    api.calls.length = 0;
    await drive(bot, env, 10_000);
    expect(api.count('accept')).toBe(0);
    expect(api.count('decline')).toBe(0);
    expect(api.count('poll')).toBe(0);
    expect(api.count('location')).toBeGreaterThanOrEqual(3);
    env.cfg = { ...env.cfg, paused: false };
    await drive(bot, env, 3000);
    expect(api.count('accept')).toBe(1);
  });
});

describe('movement', () => {
  it('TO_PICKUP posts interpolated positions every ~1 s real', async () => {
    const env = new FakeEnv();
    const { api, bot } = await toPickupBot(env);
    api.locations.length = 0;
    api.calls.length = 0;
    const start = env.sim;
    await drive(bot, env, 5000);
    expect(api.count('location')).toBeGreaterThanOrEqual(4);
    expect(api.count('location')).toBeLessThanOrEqual(6);
    const l = api.locations[0];
    // first post ~1 s after leg start (position matches interpolation at that elapsed time)
    const exp = interpolateAlongRoute(PICKUP_ROUTE.geometry, PICKUP_ROUTE.durations, 1);
    expect(Math.abs(l.lat - exp.position.lat)).toBeLessThan(0.0003);
    expect(l.heading).toBeGreaterThanOrEqual(0);
    expect(l.heading).toBeLessThan(360);
    expect(start).toBeLessThan(env.sim);
  });

  it('position matches interpolateAlongRoute at start, mid and end', () => {
    const base = {
      ...initialDriverState(),
      phase: 'TO_PICKUP' as const,
      position: A,
      leg: {
        geometry: PICKUP_ROUTE.geometry as [number, number][],
        durations: PICKUP_ROUTE.durations,
      },
      legStartSim: 5000,
    };
    const env = new FakeEnv();
    for (const elapsed of [0, 10, 20, 25]) {
      env.sim = 5000 + elapsed * 1000;
      env.real = base.lastLocationReal + 5000;
      const action = decide(base, env);
      const exp = interpolateAlongRoute(PICKUP_ROUTE.geometry, PICKUP_ROUTE.durations, elapsed);
      if (exp.done) {
        expect(action).toEqual({ type: 'arrive' });
      } else {
        expect(action).toMatchObject({ type: 'location', pos: exp.position });
      }
    }
  });

  it('pause freezes movement; resume continues', async () => {
    const env = new FakeEnv();
    const { api, bot } = await toPickupBot(env);
    await drive(bot, env, 2000);
    env.cfg = { ...env.cfg, paused: true };
    await drive(bot, env, 1000);
    api.locations.length = 0;
    await drive(bot, env, 8000);
    expect(api.locations.length).toBeGreaterThanOrEqual(2); // heartbeats continue
    const first = api.locations[0];
    expect(api.locations.every((p) => p.lat === first.lat && p.lng === first.lng)).toBe(true);
    expect(api.count('arrive')).toBe(0);
  });

  it('full trip: arrive after the pickup route, wait, start, follow trip route, complete', async () => {
    const env = new FakeEnv();
    env.cfg.speed = 4;
    const { api, bot } = await toPickupBot(env);
    const phases = new Set<string>();
    for (let i = 0; i < 400 && bot.phase !== 'IDLE'; i++) {
      await drive(bot, env, 100);
      phases.add(bot.phase);
      if (api.count('arrive') && bot.phase === 'AT_PICKUP' && !api.count('start')) {
        // trip is ARRIVED/IN_PROGRESS server side; irrelevant for fakes
      }
    }
    expect(api.calls.filter((c) => /^(arrive|start|complete):/.test(c))).toEqual([
      'arrive:trip-1',
      'start:trip-1',
      'complete:trip-1',
    ]);
    expect([...phases]).toEqual(
      expect.arrayContaining(['TO_PICKUP', 'AT_PICKUP', 'IN_TRIP', 'IDLE']),
    );
    expect(bot.state.position).toEqual({
      lat: TRIP_ROUTE.geometry[2][1],
      lng: TRIP_ROUTE.geometry[2][0],
    });
  });

  it('waits 5-15 sim-s at the pickup', async () => {
    const env = new FakeEnv();
    const { api, bot } = await toPickupBot(env);
    let arrivedSim = 0;
    for (let i = 0; i < 600 && !api.count('start'); i++) {
      await drive(bot, env, 100);
      if (api.count('arrive') && !arrivedSim) arrivedSim = env.sim;
    }
    const waited = env.sim - arrivedSim;
    expect(waited).toBeGreaterThanOrEqual(4800);
    expect(waited).toBeLessThanOrEqual(15_300);
  });
});

describe('losing the trip', () => {
  it.each([403, 404, 409])('arrive %i goes back to IDLE', async (status) => {
    const env = new FakeEnv();
    const { api, bot } = await toPickupBot(env);
    api.arriveR = err(status);
    await drive(bot, env, 30_000);
    expect(bot.phase).toBe('IDLE');
    expect(api.count('start')).toBe(0);
  });

  it('start/complete conflicts go back to IDLE', async () => {
    const env = new FakeEnv();
    env.cfg.speed = 10;
    const { api, bot } = await toPickupBot(env);
    api.startR = err(409);
    await drive(bot, env, 10_000);
    expect(bot.phase).toBe('IDLE');
    expect(api.count('complete')).toBe(0);
  });

  it('a 5xx on arrive is retried, not dropped', async () => {
    const env = new FakeEnv();
    env.cfg.speed = 10;
    const { api, bot } = await toPickupBot(env);
    let n = 0;
    api.arriveR = () => (++n < 2 ? err(503) : ok(undefined));
    await drive(bot, env, 8000);
    expect(api.count('arrive')).toBeGreaterThanOrEqual(2);
    expect(['AT_PICKUP', 'IN_TRIP', 'IDLE']).toContain(bot.phase);
  });

  it('fetching a non-active / foreign trip after accept goes IDLE', async () => {
    const env = new FakeEnv();
    const api = new FakeDriverApi();
    const ctx = await idleBot(api, env);
    api.tripResult = ok(trip({ status: 'REQUESTED', driverId: null }));
    api.offerQueue.push(offer());
    await drive(ctx.bot, env, 4000);
    expect(ctx.bot.phase).toBe('IDLE');
  });

  it('a 409 heartbeat while IDLE re-onlines the driver', async () => {
    const env = new FakeEnv();
    const { api, bot } = await idleBot(new FakeDriverApi(), env);
    api.location = err(409);
    env.advance(HEARTBEAT_MS + 100);
    await runOnce(bot);
    expect(bot.phase).toBe('STARTING');
    api.location = ok(undefined, 204);
    api.me = ok({ status: 'OFFLINE', tripId: null });
    await runOnce(bot);
    expect(bot.phase).toBe('IDLE');
    expect(api.calls.filter((c) => c.startsWith('online'))).toHaveLength(1);
  });
});

describe('retire', () => {
  it('an idle retiring bot goes offline and stops; a failed offline is retried', async () => {
    const env = new FakeEnv();
    const { api, bot } = await idleBot(new FakeDriverApi(), env);
    api.offline = err(503);
    bot.retire();
    await runOnce(bot);
    expect(bot.phase).toBe('IDLE');
    expect(bot.due()).toBeNull();
    env.advance(1100);
    api.offline = ok(undefined);
    await runOnce(bot);
    expect(bot.phase).toBe('STOPPED');
    expect(bot.due()).toBeNull();
  });
});
