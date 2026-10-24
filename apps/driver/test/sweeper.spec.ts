import { describe, expect, it } from 'vitest';
import { NearbyDriversQuerySchema } from '@rideshare/contracts';
import { StaleSweeper } from '../src/sweeper.service';
import type { TripGateway } from '../src/trip.gateway';
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
  function setup(
    replies: Record<string, TransitionResult['code']>,
    now: { t: number },
    unassign: (tripId: string) => Promise<'UNASSIGNED' | 'CONFLICT'> = async () => 'UNASSIGNED',
  ) {
    const calls: [string, number, number][] = [];
    const unassigns: [string, string][] = [];
    const offlined: [string, string][] = [];
    const store = {
      listOnlineIds: async () => Object.keys(replies),
      sweep: async (id: string, n: number, stale: number): Promise<TransitionResult> => {
        calls.push([id, n, stale]);
        return {
          code: replies[id]!,
          state: {
            driverId: id,
            status: 'ON_TRIP',
            tripId: `trip-${id}`,
            lat: 0,
            lng: 0,
            heading: 0,
            ts: 0,
          },
        };
      },
      offlineAfterUnassign: async (id: string, tripId: string): Promise<TransitionResult> => {
        offlined.push([id, tripId]);
        return { code: 'OK', state: null };
      },
    } as unknown as DriverStore;
    const trips = {
      unassign: async (tripId: string, reason: string) => {
        unassigns.push([tripId, reason]);
        return unassign(tripId);
      },
    } as unknown as TripGateway;
    const config = { get: (k: string) => (k === 'STALE_AFTER_MS' ? 60_000 : 5_000) };
    const sweeper = new StaleSweeper(store, trips, () => now.t, config as never);
    return { sweeper, calls, unassigns, offlined };
  }

  it('passes the clock and threshold; unassigns stale ON_TRIP drivers and takes them offline', async () => {
    const now = { t: 100_000 };
    const { sweeper, calls, unassigns, offlined } = setup(
      { a: 'SWEPT', b: 'FRESH', c: 'ON_TRIP' },
      now,
    );
    const res = await sweeper.sweepOnce();
    expect(res).toEqual({ swept: ['a'], unassigned: ['c'], skippedOnTrip: [] });
    expect(calls).toHaveLength(3);
    expect(calls.every(([, n, s]) => n === 100_000 && s === 60_000)).toBe(true);
    expect(unassigns).toEqual([['trip-c', 'driver_stale']]);
    expect(offlined).toEqual([['c', 'trip-c']]);
  });

  it('leaves the driver when the trip answers 409', async () => {
    const { sweeper, offlined } = setup({ c: 'ON_TRIP' }, { t: 100_000 }, async () => 'CONFLICT');
    expect(await sweeper.sweepOnce()).toMatchObject({ unassigned: [], skippedOnTrip: ['c'] });
    expect(offlined).toEqual([]);
  });

  it('one failing driver does not block the others', async () => {
    const { sweeper } = setup({ c: 'ON_TRIP', d: 'ON_TRIP' }, { t: 100_000 }, async (t) => {
      if (t === 'trip-c') throw new Error('down');
      return 'UNASSIGNED';
    });
    expect(await sweeper.sweepOnce()).toMatchObject({ unassigned: ['d'], skippedOnTrip: ['c'] });
  });

  it('does not touch an ON_TRIP driver with a fresh position', async () => {
    const { sweeper, unassigns } = setup({ c: 'ON_TRIP' }, { t: 1_000 });
    expect(await sweeper.sweepOnce()).toEqual({ swept: [], unassigned: [], skippedOnTrip: [] });
    expect(unassigns).toEqual([]);
  });

  it('start/stop of the timer is clean', () => {
    const { sweeper } = setup({}, { t: 0 });
    sweeper.onModuleInit();
    sweeper.onModuleDestroy();
  });
});
