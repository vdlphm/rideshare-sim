import { ConflictException, BadGatewayException } from '@nestjs/common';
import type { DriverState } from '@rideshare/contracts';
import { describe, expect, it } from 'vitest';
import { DriverService } from '../src/driver.service';
import type { DriverStore, TransitionResult } from '../src/driver.store';
import type { TripGateway, UnassignOutcome } from '../src/trip.gateway';

const ID = '11111111-1111-4111-8111-111111111111';
const TRIP = '22222222-2222-4222-8222-222222222222';

const state = (over: Partial<DriverState> = {}): DriverState => ({
  driverId: ID,
  status: 'ON_TRIP',
  tripId: TRIP,
  lat: 1,
  lng: 2,
  heading: 0,
  ts: 5,
  ...over,
});

function setup(opts: {
  current: DriverState | null;
  unassign?: () => Promise<UnassignOutcome>;
  guarded?: TransitionResult;
}) {
  const log: string[] = [];
  const store = {
    get: async () => opts.current,
    goOffline: async (): Promise<TransitionResult> => {
      log.push('offline');
      return { code: 'OK', state: state({ status: 'OFFLINE', tripId: null }) };
    },
    offlineAfterUnassign: async (_id: string, tripId: string): Promise<TransitionResult> => {
      log.push(`guarded:${tripId}`);
      return opts.guarded ?? { code: 'OK', state: state({ status: 'OFFLINE', tripId: null }) };
    },
  } as unknown as DriverStore;
  const trips = {
    unassign: async (tripId: string, reason: string) => {
      log.push(`unassign:${tripId}:${reason}`);
      return (opts.unassign ?? (async () => 'UNASSIGNED' as const))();
    },
  } as unknown as TripGateway;
  const svc = new DriverService(store, trips, () => 0, { get: () => 60_000 } as never);
  return { svc, log };
}

describe('DriverService.goOffline with a trip', () => {
  it('unassigns a MATCHED trip then goes OFFLINE', async () => {
    const { svc, log } = setup({ current: state() });
    expect((await svc.goOffline(ID)).status).toBe('OFFLINE');
    expect(log).toEqual([`unassign:${TRIP}:driver_offline`, `guarded:${TRIP}`]);
  });

  it('409 from trip -> 409 and no state change', async () => {
    const { svc, log } = setup({ current: state(), unassign: async () => 'CONFLICT' });
    await expect(svc.goOffline(ID)).rejects.toBeInstanceOf(ConflictException);
    expect(log).toEqual([`unassign:${TRIP}:driver_offline`]);
  });

  it('trip unreachable -> 502 and no state change', async () => {
    const { svc, log } = setup({
      current: state(),
      unassign: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await expect(svc.goOffline(ID)).rejects.toBeInstanceOf(BadGatewayException);
    expect(log).toEqual([`unassign:${TRIP}:driver_offline`]);
  });

  it('a driver that moved to another trip meanwhile is not taken offline', async () => {
    const { svc, log } = setup({
      current: state(),
      guarded: { code: 'CHANGED', state: state({ tripId: 'other' }) },
    });
    await expect(svc.goOffline(ID)).rejects.toBeInstanceOf(ConflictException);
    expect(log).not.toContain('offline');
  });

  it('a driver already released to AVAILABLE meanwhile goes offline normally', async () => {
    const { svc, log } = setup({
      current: state(),
      guarded: { code: 'CHANGED', state: state({ status: 'AVAILABLE', tripId: null }) },
    });
    expect((await svc.goOffline(ID)).status).toBe('OFFLINE');
    expect(log.at(-1)).toBe('offline');
  });

  it('does not call trip when the driver is not ON_TRIP', async () => {
    const { svc, log } = setup({ current: state({ status: 'AVAILABLE', tripId: null }) });
    await svc.goOffline(ID);
    expect(log).toEqual(['offline']);
  });
});
