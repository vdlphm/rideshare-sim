import { SEATTLE_SPAWN_BBOX, haversineM, isInBbox } from '@rideshare/geo';
import { describe, expect, it } from 'vitest';
import type { Snapper } from '../../src/bots/bot-env';
import { riderPollIntervalMs } from '../../src/bots/rider-bot';
import { AccountPool, RiderSpawner, pickRidePoints } from '../../src/bots/rider-spawner';
import { Scheduler } from '../../src/bots/scheduler';
import { A, B, FakeEnv, FakeRiderApi, err, identitySnapper } from './helpers';

function setup(opts: { snapper?: Snapper; maxActive?: number; seed?: number } = {}) {
  const env = new FakeEnv(opts.seed ?? 7);
  env.cfg.spawnIntervalS = 3;
  const scheduler = new Scheduler();
  const apis = new Map<number, FakeRiderApi>();
  const spawner = new RiderSpawner({
    scheduler,
    env,
    snapper: opts.snapper ?? identitySnapper,
    makeApi: (n) => {
      const a = new FakeRiderApi();
      apis.set(n, a);
      return a;
    },
    maxActive: opts.maxActive ?? 100,
  });
  const tick = async (realMs: number) => {
    env.advance(realMs);
    scheduler.tick();
    // settle spawn + bot jobs
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setImmediate(r));
      await scheduler.stop();
    }
  };
  const totalRequests = () => [...apis.values()].reduce((n, a) => n + a.requests.length, 0);
  return { env, scheduler, spawner, apis, tick, totalRequests };
}

describe('pickRidePoints', () => {
  it('returns snapped points inside the bbox, at least 500 m apart', async () => {
    const env = new FakeEnv(3);
    for (let i = 0; i < 30; i++) {
      const p = await pickRidePoints(env, identitySnapper);
      expect(p).not.toBeNull();
      expect(isInBbox(p!.pickup, SEATTLE_SPAWN_BBOX)).toBe(true);
      expect(haversineM(p!.pickup, p!.dropoff)).toBeGreaterThanOrEqual(500);
    }
  });

  it('draws new points when snapping fails (422), up to 5 attempts', async () => {
    const env = new FakeEnv(3);
    let calls = 0;
    const flaky: Snapper = {
      snap: async (p) => (++calls <= 4 ? null : p), // first two attempts fail (2 snaps each)
    };
    expect(await pickRidePoints(env, flaky)).not.toBeNull();
    expect(calls).toBeGreaterThanOrEqual(6);

    const never: Snapper = { snap: async () => null };
    expect(await pickRidePoints(env, never)).toBeNull();
  });

  it('treats snapper errors like 422', async () => {
    const env = new FakeEnv(3);
    const boom: Snapper = {
      snap: async () => {
        throw new Error('routing down');
      },
    };
    expect(await pickRidePoints(env, boom)).toBeNull();
  });
});

describe('AccountPool', () => {
  it('reuses released accounts and never hands out parked ones', () => {
    const pool = new AccountPool(3);
    expect([pool.acquire(), pool.acquire()]).toEqual([1, 2]);
    pool.release(1);
    expect(pool.acquire()).toBe(1);
    pool.park(2);
    expect(pool.acquire()).toBe(3);
    expect(pool.acquire()).toBeNull();
    pool.release(3);
    expect(pool.acquire()).toBe(3);
  });
});

describe('RiderSpawner', () => {
  it('spawns on the sim-time interval with bounded jitter', async () => {
    const { env, tick, apis, totalRequests } = setup();
    const times: number[] = [];
    let seen = 0;
    for (let i = 0; i < 400; i++) {
      await tick(100); // speed 1: 40 sim-s total
      if (totalRequests() > seen) {
        seen = totalRequests();
        times.push(env.sim);
      }
    }
    expect(times.length).toBeGreaterThanOrEqual(10);
    expect(times.length).toBeLessThanOrEqual(19);
    for (let i = 1; i < times.length; i++) {
      const gap = times[i] - times[i - 1];
      expect(gap).toBeGreaterThanOrEqual(3000 * 0.7 - 150);
      expect(gap).toBeLessThanOrEqual(3000 * 1.3 + 250);
    }
    // ride requests omit pickup (defaults to the rider position) and post location first
    const any = [...apis.values()][0];
    expect(any.requests[0]).not.toHaveProperty('pickup');
    expect(any.calls.slice(0, 3).map((c) => c.split(':')[0])).toEqual([
      'ensure',
      'location',
      'request',
    ]);
  });

  it('scales with speed (sim time)', async () => {
    const { env, tick, totalRequests } = setup();
    env.cfg.speed = 10;
    for (let i = 0; i < 100; i++) await tick(100); // 10 real s = 100 sim-s
    expect(totalRequests()).toBeGreaterThanOrEqual(25);
  });

  it('pause stops spawning', async () => {
    const { env, tick, totalRequests } = setup();
    for (let i = 0; i < 100; i++) await tick(100);
    env.cfg = { ...env.cfg, paused: true };
    for (let i = 0; i < 5; i++) await tick(100); // let in-flight spawns land
    const before = totalRequests();
    for (let i = 0; i < 200; i++) await tick(100);
    expect(totalRequests()).toBe(before);
    env.cfg = { ...env.cfg, paused: false };
    for (let i = 0; i < 100; i++) await tick(100);
    expect(totalRequests()).toBeGreaterThan(before);
  });

  it('respects the active rider cap and frees accounts when trips end', async () => {
    const { env, tick, apis, totalRequests, spawner } = setup({ maxActive: 2 });
    env.cfg.speed = 10;
    for (let i = 0; i < 60; i++) await tick(100);
    expect(totalRequests()).toBe(2);
    expect(spawner.counts()).toEqual({ active: 2, waiting: 2, riding: 0 });
    apis.get(1)!.tripStatus = 'IN_PROGRESS';
    for (let i = 0; i < 10; i++) await tick(100);
    expect(spawner.counts()).toEqual({ active: 2, waiting: 1, riding: 1 });
    apis.get(1)!.tripStatus = 'COMPLETED';
    for (let i = 0; i < 20; i++) await tick(100);
    // account 1 is reused for the next ride
    expect(apis.get(1)!.requests.length).toBeGreaterThanOrEqual(2);
    expect(apis.size).toBe(2);
  });

  it('frees the bot on NO_DRIVERS too', async () => {
    const { env, tick, apis, spawner } = setup({ maxActive: 1 });
    env.cfg.speed = 10;
    for (let i = 0; i < 40; i++) await tick(100);
    expect(spawner.counts().active).toBe(1);
    apis.get(1)!.tripStatus = 'NO_DRIVERS';
    for (let i = 0; i < 10; i++) await tick(100);
    expect(apis.get(1)!.requests.length).toBeGreaterThanOrEqual(2);
  });

  it('a 409 parks the account and uses another', async () => {
    const { env, tick, apis, spawner } = setup({ maxActive: 5 });
    env.cfg.speed = 10;
    const res = spawner.addRider(A, B);
    // account 1's api exists now, make it conflict on its request
    await Promise.resolve();
    expect(apis.size).toBe(1);
    apis.get(1)!.requestResult = err(409, 'active trip');
    for (let i = 0; i < 10; i++) await tick(100);
    const out = await res;
    expect(out.kind).toBe('ok');
    expect(apis.get(2)!.requests).toHaveLength(1);
    expect(spawner.parkedAccounts).toBe(1);
    // account 1 stays parked: later spawns never use it
    for (let i = 0; i < 100; i++) await tick(100);
    expect(apis.get(1)!.requests).toHaveLength(1);
  });

  it('click-to-add sends the exact pickup and passes errors through', async () => {
    const { env, tick, apis, spawner } = setup();
    env.cfg.speed = 10;
    const ok1 = spawner.addRider(A, B);
    await tick(100);
    expect((await ok1).kind).toBe('ok');
    expect(apis.get(1)!.requests[0]).toEqual({ pickup: A, dropoff: B });

    const unroutable = spawner.addRider(A, B);
    await Promise.resolve();
    apis.get(2)!.requestResult = err(422, 'not routable');
    await tick(100);
    expect(await unroutable).toEqual({ kind: 'unroutable', message: 'not routable' });
  });

  it('click-to-add reports no free account', async () => {
    const { tick, spawner } = setup({ maxActive: 1 });
    const pool = 1 * 2 + 20;
    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < pool; i++) pending.push(spawner.addRider(A, B));
    expect(await spawner.addRider(A, B)).toEqual({ kind: 'noAccount' });
    for (let i = 0; i < 5; i++) await tick(100);
    await Promise.all(pending);
  });
});

describe('riderPollIntervalMs', () => {
  it('is ~2 s at speed 1 and scales down to 300 ms', () => {
    expect(riderPollIntervalMs(1)).toBe(2000);
    expect(riderPollIntervalMs(4)).toBe(500);
    expect(riderPollIntervalMs(10)).toBe(300);
  });
});
