import { describe, expect, it } from 'vitest';
import { DriverFleet } from '../../src/bots/driver-fleet';
import { Scheduler } from '../../src/bots/scheduler';
import { A, FakeDriverApi, FakeEnv, identitySnapper, ok, offer, trip } from './helpers';

function setup(maxInFlight = 20) {
  const env = new FakeEnv();
  const scheduler = new Scheduler({ maxInFlight });
  const apis = new Map<number, FakeDriverApi>();
  const fleet = new DriverFleet({
    scheduler,
    env,
    snapper: identitySnapper,
    makeApi: (n) => {
      const api = new FakeDriverApi();
      api.me = ok({ status: 'AVAILABLE', tripId: null, driverId: `d${n}`, lat: A.lat, lng: A.lng });
      api.tripResult = ok(trip({ driverId: `d${n}` }));
      apis.set(n, api);
      return api;
    },
  });
  /** One scheduler tick, then let promises settle. */
  const tick = async (realMs = 100) => {
    env.advance(realMs);
    scheduler.tick();
    await scheduler.stop(); // waits for in-flight (does not start a timer)
  };
  return { env, scheduler, fleet, apis, tick };
}

describe('DriverFleet', () => {
  it('scales up to the target with deterministic numbers', async () => {
    const { fleet, apis, tick } = setup();
    fleet.setTarget(3);
    expect(fleet.size).toBe(3);
    expect([...apis.keys()].sort()).toEqual([1, 2, 3]);
    await tick();
    expect(fleet.counts()).toMatchObject({ total: 3, idle: 3 });
    fleet.setTarget(5);
    expect([...apis.keys()].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('shrinks by retiring only idle bots, retrying until the count matches', async () => {
    const { fleet, apis, tick } = setup();
    fleet.setTarget(4);
    await tick();
    // Make driver 4 and 3 busy: offer + accept
    for (const n of [4, 3]) apis.get(n)!.offerQueue.push(offer({ id: `o${n}`, driverId: `d${n}` }));
    for (let i = 0; i < 40; i++) await tick(100);
    const busy = fleet.counts();
    expect(busy.toPickup).toBeGreaterThanOrEqual(2);
    fleet.setTarget(1);
    for (let i = 0; i < 10; i++) await tick(100);
    // Target 1, but 3 and 4 are mid-trip and must not be touched: only the idle 1 and 2 retire.
    expect(apis.get(3)!.count('offline')).toBe(0);
    expect(apis.get(4)!.count('offline')).toBe(0);
    expect(fleet.size).toBe(2);
    expect(fleet.counts().toPickup).toBe(2);
    expect(apis.get(1)!.count('offline') + apis.get(2)!.count('offline')).toBe(2);
  });

  it('re-uses a retiring bot when the target grows again', async () => {
    const { fleet, apis, tick } = setup();
    fleet.setTarget(3);
    await tick();
    fleet.setTarget(1);
    fleet.setTarget(3);
    await tick();
    expect(fleet.size).toBe(3);
    expect([...apis.keys()].sort()).toEqual([1, 2, 3]);
    expect([...apis.values()].every((a) => a.count('offline') === 0)).toBe(true);
  });

  it('shutdown takes idle drivers offline within a bound', async () => {
    const { fleet, apis, tick } = setup();
    fleet.setTarget(2);
    await tick();
    await fleet.shutdown(500);
    expect([...apis.values()].map((a) => a.count('offline'))).toEqual([1, 1]);
  });
});

describe('Scheduler', () => {
  it('caps in-flight jobs and never runs two jobs for one task', async () => {
    const scheduler = new Scheduler({ maxInFlight: 3 });
    let running = 0;
    let peak = 0;
    const perTask = new Map<number, number>();
    const release: (() => void)[] = [];
    for (let i = 0; i < 10; i++) {
      scheduler.add({
        due: () => async () => {
          running++;
          peak = Math.max(peak, running);
          perTask.set(i, (perTask.get(i) ?? 0) + 1);
          await new Promise<void>((r) => release.push(r));
          running--;
        },
      });
    }
    scheduler.tick();
    scheduler.tick(); // same tasks are busy; the cap still holds
    expect(running).toBe(3);
    expect(peak).toBe(3);
    release.splice(0).forEach((r) => r());
    await new Promise((r) => setImmediate(r));
    scheduler.tick();
    // rotation: tasks that did not run before get a turn
    expect(perTask.size).toBeGreaterThan(3);
    release.splice(0).forEach((r) => r());
    await scheduler.stop();
  });

  it('survives failing jobs and tasks', async () => {
    const errors: unknown[] = [];
    const scheduler = new Scheduler({ onError: (e) => errors.push(e) });
    scheduler.add({ due: () => () => Promise.reject(new Error('job')) });
    scheduler.add({
      due: () => {
        throw new Error('due');
      },
    });
    scheduler.tick();
    await scheduler.stop();
    expect(errors).toHaveLength(2);
  });
});
