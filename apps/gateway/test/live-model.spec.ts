import { describe, expect, it } from 'vitest';
import { LiveModel } from '../src/live/live-model';
import { driver, rider, simState, stats, trip, user } from './live-fixtures';

const model = (retention = 10_000) =>
  new LiveModel({ endedTripRetentionMs: retention, userCacheTtlMs: 60_000 });

function loaded() {
  const m = model();
  const d = driver();
  const r = rider();
  const t = trip({ riderId: r.riderId });
  m.applyDrivers([d]);
  m.applyRiders([r]);
  m.applySim(simState());
  m.applyStats(stats());
  m.applyTripsFull([t], 0);
  m.discardDiff();
  m.ready = true;
  return { m, d, r, t };
}

describe('LiveModel diffs', () => {
  it('reports nothing when nothing changed', () => {
    const { m, d, r, t } = loaded();
    m.applyDrivers([{ ...d }]);
    m.applyRiders([{ ...r }]);
    m.applySim(simState());
    m.applyStats(stats());
    m.applyTrips([{ ...t }], 5);
    expect(m.takeDiff()).toBeNull();
  });

  it('upserts only changed items and counts a heartbeat ts as a change', () => {
    const { m, d } = loaded();
    const other = driver();
    m.applyDrivers([d, other]);
    m.takeDiff();
    m.applyDrivers([{ ...d, ts: d.ts + 250 }, other]);
    const diff = m.takeDiff()!;
    expect(diff.drivers.upsert).toEqual([{ ...d, ts: d.ts + 250 }]);
    expect(diff.drivers.remove).toEqual([]);
    expect(diff.riders).toEqual({ upsert: [], remove: [] });
    expect(diff.clock).toBeUndefined();
    expect(diff.stats).toBeUndefined();
  });

  it('removes ids that disappeared and upserts new ones', () => {
    const { m, d, r } = loaded();
    const fresh = rider();
    m.applyDrivers([]);
    m.applyRiders([fresh]);
    const diff = m.takeDiff()!;
    expect(diff.drivers.remove).toEqual([d.driverId]);
    expect(diff.riders).toEqual({ upsert: [fresh], remove: [r.riderId] });
  });

  it('includes clock, config, bots and stats only when they changed', () => {
    const { m } = loaded();
    const s = simState();
    m.applySim({ ...s, config: { ...s.config, speed: 3 } });
    m.applyStats(stats({ completedTrips: 4 }));
    const diff = m.takeDiff()!;
    expect(diff.config?.speed).toBe(3);
    expect(diff.stats?.completedTrips).toBe(4);
    expect(diff.clock).toBeUndefined();
    expect(diff.bots).toBeUndefined();
  });
});

describe('LiveModel trips', () => {
  it('upserts a completed trip once, keeps it for the retention, then removes it', () => {
    const { m, t } = loaded();
    const done = { ...t, status: 'COMPLETED' as const, completedAt: 9 };
    m.applyTrips([done], 1000);
    expect(m.takeDiff()!.trips.upsert).toEqual([done]);
    // delivered again unchanged: no new diff
    m.applyTrips([done], 2000);
    expect(m.takeDiff()).toBeNull();
    m.expire(10_999);
    expect(m.takeDiff()).toBeNull();
    m.expire(11_000);
    expect(m.takeDiff()!.trips).toEqual({ upsert: [], remove: [t.id] });
    // a late re-delivery cannot revive it
    m.applyTrips([done], 12_000);
    expect(m.takeDiff()).toBeNull();
  });

  it('a trip first seen already ended is upserted once and still retired', () => {
    const { m } = loaded();
    const t = trip({ status: 'NO_DRIVERS' });
    m.applyTrips([t], 100);
    expect(m.takeDiff()!.trips.upsert).toEqual([t]);
    m.expire(100 + 10_000);
    expect(m.takeDiff()!.trips.remove).toEqual([t.id]);
  });
});

describe('LiveModel users', () => {
  it('lists missing referenced users and honours the retry back-off', () => {
    const { m, d, r } = loaded();
    const t2 = trip();
    m.applyTrips([t2], 0);
    expect(new Set(m.missingUserIds(0))).toEqual(new Set([d.driverId, r.riderId, t2.riderId]));
    m.addUsers([user(d.driverId)], 0);
    m.deferUsers([r.riderId], 5000);
    expect(m.missingUserIds(100)).toEqual([t2.riderId]);
    expect(new Set(m.missingUserIds(5000))).toEqual(new Set([r.riderId, t2.riderId]));
  });

  it('returns each user only for clients that have not received it', () => {
    const { m, d, r } = loaded();
    m.addUsers([user(d.driverId), user(r.riderId), user('unreferenced-id')], 0);
    const sent = new Set<string>([d.driverId]);
    expect(m.usersNotIn(sent).map((u) => u.id)).toEqual([r.riderId]);
    expect(
      m
        .snapshot(1)
        .users.map((u) => u.id)
        .sort(),
    ).toEqual([d.driverId, r.riderId].sort());
  });

  it('evicts unreferenced users after the cache ttl only', () => {
    const { m, d } = loaded();
    m.addUsers([user(d.driverId), user('gone')], 0);
    m.expire(59_999);
    m.expire(60_000);
    expect(m.counts().users).toBe(1);
  });
});
