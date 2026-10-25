import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveSession } from '../src/live/live-session';
import type { LiveUpstreams, TripsSince } from '../src/live/upstreams';
import { driver, rider, simState, stats, trip, user } from './live-fixtures';

function fakeUpstreams() {
  const state = {
    drivers: [driver()],
    riders: [rider()],
    trips: [trip()],
    serverTime: '2026-01-01T00:00:00.000Z',
  };
  const fail = new Set<string>();
  const calls: Record<string, number> = {};
  const sinceArgs: string[] = [];
  const hit = (n: string) => {
    calls[n] = (calls[n] ?? 0) + 1;
    if (fail.has(n)) throw new Error(`${n} down`);
  };
  const up: LiveUpstreams = {
    drivers: async () => (hit('drivers'), state.drivers),
    riders: async () => (hit('riders'), state.riders),
    sim: async () => (hit('sim'), simState()),
    stats: async () => (hit('stats'), stats()),
    activeTrips: async () => (hit('active'), state.trips),
    tripsSince: async (c): Promise<TripsSince> => {
      hit('since');
      sinceArgs.push(c);
      return { trips: [], serverTime: state.serverTime };
    },
    users: async (ids) => (hit('users'), ids.map((id) => user(id))),
  };
  return { up, state, fail, calls, sinceArgs };
}

const log = { warn: () => {}, debug: () => {} };
const mk = (up: LiveUpstreams, onUpdate = () => {}) =>
  new LiveSession({
    upstreams: up,
    pollIntervalMs: 20,
    statsIntervalMs: 1_000_000,
    endedTripRetentionMs: 10_000,
    userCacheTtlMs: 60_000,
    onUpdate,
    log,
  });

afterEach(() => vi.useRealTimers());

describe('LiveSession', () => {
  it('init builds the model, takes the cursor from x-server-time and loads users', async () => {
    const f = fakeUpstreams();
    const onUpdate = vi.fn();
    const s = mk(f.up, onUpdate);
    await s.init();
    expect(s.model.ready).toBe(true);
    expect(s.tripCursor).toBe(f.state.serverTime);
    expect(s.model.counts()).toMatchObject({ drivers: 1, riders: 1, trips: 1, users: 3 });
    expect(s.model.takeDiff()).toBeNull(); // initial load is delivered as a snapshot
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('a failed init part leaves the model not ready', async () => {
    const f = fakeUpstreams();
    f.fail.add('riders');
    const s = mk(f.up);
    await expect(s.init()).rejects.toThrow('riders down');
    expect(s.model.ready).toBe(false);
  });

  it('tick polls trips with the previous cursor and advances it', async () => {
    const f = fakeUpstreams();
    const s = mk(f.up);
    await s.init();
    f.state.serverTime = '2026-01-01T00:00:01.000Z';
    await s.tick();
    expect(f.sinceArgs.at(-1)).toBe('2026-01-01T00:00:00.000Z');
    expect(s.tripCursor).toBe('2026-01-01T00:00:01.000Z');
    await s.tick();
    expect(f.sinceArgs.at(-1)).toBe('2026-01-01T00:00:01.000Z');
  });

  it('a failing upstream does not break the tick: others apply, failed data is kept', async () => {
    const f = fakeUpstreams();
    const s = mk(f.up);
    await s.init();
    s.model.takeDiff();
    f.fail.add('drivers');
    f.state.riders = [{ ...f.state.riders[0]!, lat: 11 }];
    await s.tick();
    const diff = s.model.takeDiff()!;
    expect(diff.riders.upsert).toHaveLength(1);
    expect(diff.drivers).toEqual({ upsert: [], remove: [] });
    expect(s.model.counts().drivers).toBe(1);
    f.fail.delete('drivers');
    f.state.drivers = [];
    await s.tick();
    expect(s.model.takeDiff()!.drivers.remove).toHaveLength(1);
  });

  it('fetches stats on their own cadence', async () => {
    const f = fakeUpstreams();
    const s = new LiveSession({
      upstreams: f.up,
      pollIntervalMs: 5,
      statsIntervalMs: 50,
      endedTripRetentionMs: 10_000,
      userCacheTtlMs: 60_000,
      onUpdate: () => {},
      log,
    });
    await s.init();
    const before = f.calls.stats!;
    await s.tick();
    expect(f.calls.stats).toBe(before);
    await new Promise((r) => setTimeout(r, 60));
    await s.tick();
    expect(f.calls.stats).toBe(before + 1);
  });

  it('a slow upstream neither stalls the others nor gets a second request while in flight', async () => {
    const f = fakeUpstreams();
    const s = mk(f.up);
    await s.init();
    s.model.takeDiff();
    let release!: () => void;
    f.up.riders = () =>
      new Promise((r) => {
        f.calls.slowRiders = (f.calls.slowRiders ?? 0) + 1;
        release = () => r([]);
      });
    f.state.drivers = [{ ...f.state.drivers[0]!, ts: 2000 }];
    const t0 = Date.now();
    await s.tick();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(s.model.takeDiff()!.drivers.upsert).toHaveLength(1);
    await s.tick();
    expect(f.calls.slowRiders).toBe(1);
    release();
    await s.tick();
    expect(s.model.takeDiff()!.riders.remove).toHaveLength(1);
  });

  it('chunks user lookups at 500 and backs off unknown ids', async () => {
    const f = fakeUpstreams();
    f.state.drivers = Array.from({ length: 1100 }, () => driver());
    f.state.riders = [];
    f.state.trips = [];
    const sizes: number[] = [];
    f.up.users = async (ids) => {
      sizes.push(ids.length);
      return ids.slice(1).map((id) => user(id)); // first id of every chunk is "unknown"
    };
    const s = mk(f.up);
    await s.init();
    expect(sizes.sort((a, b) => a - b)).toEqual([100, 500, 500]);
    expect(s.model.counts().users).toBe(1097);
    sizes.length = 0;
    await s.tick(); // unknown ids are in back-off: no new lookups
    expect(sizes).toEqual([]);
  });

  it('start/stop: the loop runs and stops polling once stopped', async () => {
    const f = fakeUpstreams();
    const s = mk(f.up);
    s.start();
    await vi.waitFor(() => expect(f.calls.drivers).toBeGreaterThan(3), { timeout: 2000 });
    s.stop();
    await new Promise((r) => setTimeout(r, 50));
    const n = f.calls.drivers;
    await new Promise((r) => setTimeout(r, 100));
    expect(f.calls.drivers).toBe(n);
  });
});
