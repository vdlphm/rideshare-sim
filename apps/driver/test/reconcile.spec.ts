import type { DriverState } from '@rideshare/contracts';
import { describe, expect, it } from 'vitest';
import type { DriverStore } from '../src/driver.store';
import { ReconcileJob } from '../src/reconcile.service';
import type { ActiveTrip, TripGateway } from '../src/trip.gateway';

const st = (id: string, status: DriverState['status'], tripId: string | null): DriverState => ({
  driverId: id,
  status,
  tripId,
  lat: 0,
  lng: 0,
  heading: 0,
  ts: 0,
});

function setup(states: DriverState[], active: ActiveTrip[] | Error) {
  const sets: [string, string, string | null, number, number][] = [];
  const batches: string[][] = [];
  const store = {
    listOnlineIds: async () => states.map((s) => s.driverId),
    getMany: async (ids: string[]) => states.filter((s) => ids.includes(s.driverId)),
    setStatus: async (
      id: string,
      status: string,
      tripId: string | null,
      now: number,
      stale: number,
    ) => {
      sets.push([id, status, tripId, now, stale]);
    },
  } as unknown as DriverStore;
  const trips = {
    activeTrips: async (ids: string[]) => {
      batches.push(ids);
      if (active instanceof Error) throw active;
      return active.filter((t) => ids.includes(t.driverId));
    },
  } as unknown as TripGateway;
  const job = new ReconcileJob(store, trips, () => 99, {
    get: (k: string) => (k === 'STALE_AFTER_MS' ? 60_000 : 30_000),
  } as never);
  return { job, sets, batches };
}

describe('ReconcileJob', () => {
  it('ON_TRIP without an active trip -> AVAILABLE', async () => {
    const { job, sets } = setup([st('a', 'ON_TRIP', 't1')], []);
    expect(await job.reconcileOnce()).toMatchObject({ released: ['a'] });
    expect(sets).toEqual([['a', 'AVAILABLE', null, 99, 60_000]]);
  });

  it('AVAILABLE with an active trip -> ON_TRIP with that trip', async () => {
    const { job, sets } = setup([st('a', 'AVAILABLE', null)], [{ id: 't1', driverId: 'a' }]);
    expect(await job.reconcileOnce()).toMatchObject({ assigned: ['a'] });
    expect(sets).toEqual([['a', 'ON_TRIP', 't1', 99, 60_000]]);
  });

  it('ON_TRIP with a different tripId -> tripId fixed', async () => {
    const { job, sets } = setup([st('a', 'ON_TRIP', 'old')], [{ id: 'new', driverId: 'a' }]);
    expect(await job.reconcileOnce()).toMatchObject({ retargeted: ['a'] });
    expect(sets[0]).toEqual(['a', 'ON_TRIP', 'new', 99, 60_000]);
  });

  it('leaves consistent drivers alone', async () => {
    const { job, sets } = setup(
      [st('a', 'ON_TRIP', 't1'), st('b', 'AVAILABLE', null)],
      [{ id: 't1', driverId: 'a' }],
    );
    const res = await job.reconcileOnce();
    expect(sets).toEqual([]);
    expect(res.checked).toBe(2);
  });

  it('skips the round when trip is unreachable', async () => {
    const { job, sets } = setup([st('a', 'ON_TRIP', 't1')], new Error('down'));
    expect(await job.reconcileOnce()).toMatchObject({ skipped: true, released: [] });
    expect(sets).toEqual([]);
  });

  it('batches at most 500 drivers per trip call', async () => {
    const states = Array.from({ length: 1201 }, (_, i) => st(`d${i}`, 'AVAILABLE', null));
    const { job, batches } = setup(states, []);
    const res = await job.reconcileOnce();
    expect(batches.map((b) => b.length)).toEqual([500, 500, 201]);
    expect(res.checked).toBe(1201);
  });

  it('timer start/stop is clean', () => {
    const { job } = setup([], []);
    job.onModuleInit();
    job.onModuleDestroy();
  });
});
