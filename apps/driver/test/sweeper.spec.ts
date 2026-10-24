import { describe, expect, it } from 'vitest';
import { NearbyDriversQuerySchema } from '@rideshare/contracts';
import { StaleSweeper } from '../src/sweeper.service';
import { isStale, toState, type DriverStore, type TransitionResult } from '../src/driver.store';

const ID = '11111111-1111-4111-8111-111111111111';

describe('isStale', () => {
  it('is stale only strictly after the threshold', () => {
    expect(isStale(1000, 61_000, 60_000)).toBe(false);
    expect(isStale(1000, 61_001, 60_000)).toBe(true);
  });
});

describe('toState', () => {
  it('maps an empty hash to null and an empty tripId to null', () => {
    expect(toState(ID, {})).toBeNull();
    expect(
      toState(ID, {
        status: 'AVAILABLE',
        tripId: '',
        lat: '1.5',
        lng: '2.5',
        heading: '90',
        ts: '7',
      }),
    ).toEqual({
      driverId: ID,
      status: 'AVAILABLE',
      tripId: null,
      lat: 1.5,
      lng: 2.5,
      heading: 90,
      ts: 7,
    });
  });
});

describe('nearby query parsing', () => {
  const ok = { lat: '10.77', lng: '106.7', radiusM: '500', limit: '5' };
  it('coerces strings', () => {
    expect(NearbyDriversQuerySchema.parse(ok)).toEqual({
      lat: 10.77,
      lng: 106.7,
      radiusM: 500,
      limit: 5,
    });
  });
  it('rejects out-of-range values', () => {
    expect(NearbyDriversQuerySchema.safeParse({ ...ok, radiusM: '10001' }).success).toBe(false);
    expect(NearbyDriversQuerySchema.safeParse({ ...ok, limit: '51' }).success).toBe(false);
    expect(NearbyDriversQuerySchema.safeParse({ ...ok, lat: '91' }).success).toBe(false);
    expect(NearbyDriversQuerySchema.safeParse({ lat: '1' }).success).toBe(false);
  });
});

describe('StaleSweeper', () => {
  function setup(replies: Record<string, TransitionResult['code']>, now: { t: number }) {
    const calls: [string, number, number][] = [];
    const store = {
      listOnlineIds: async () => Object.keys(replies),
      sweep: async (id: string, n: number, stale: number): Promise<TransitionResult> => {
        calls.push([id, n, stale]);
        return {
          code: replies[id]!,
          state: { driverId: id, status: 'ON_TRIP', tripId: ID, lat: 0, lng: 0, heading: 0, ts: 0 },
        };
      },
    } as unknown as DriverStore;
    const config = { get: (k: string) => (k === 'STALE_AFTER_MS' ? 60_000 : 5_000) };
    const sweeper = new StaleSweeper(store, () => now.t, config as never);
    return { sweeper, calls };
  }

  it('passes the clock and threshold, reports swept and stale on-trip drivers', async () => {
    const now = { t: 100_000 };
    const { sweeper, calls } = setup({ a: 'SWEPT', b: 'FRESH', c: 'ON_TRIP' }, now);
    const res = await sweeper.sweepOnce();
    expect(res).toEqual({ swept: ['a'], skippedOnTrip: ['c'] });
    expect(calls).toHaveLength(3);
    expect(calls.every(([, n, s]) => n === 100_000 && s === 60_000)).toBe(true);
  });

  it('does not report an ON_TRIP driver with a fresh position', async () => {
    const now = { t: 1_000 };
    const { sweeper } = setup({ c: 'ON_TRIP' }, now);
    expect((await sweeper.sweepOnce()).skippedOnTrip).toEqual([]);
  });

  it('start/stop of the timer is clean', () => {
    const { sweeper } = setup({}, { t: 0 });
    sweeper.onModuleInit();
    sweeper.onModuleDestroy();
  });
});
