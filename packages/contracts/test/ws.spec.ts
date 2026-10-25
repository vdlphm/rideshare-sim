import { describe, expect, it } from 'vitest';
import { WsDiffSchema, WsServerMessageSchema, WsSnapshotSchema } from '../src';

const clock = { simTime: 1000, speed: 1, paused: false };
const config = {
  driverCount: 10,
  spawnIntervalS: 3,
  speed: 1,
  paused: false,
  acceptProbability: 0.9,
};
const bots = {
  drivers: { total: 1, idle: 1, toPickup: 0, atPickup: 0, inTrip: 0 },
  riders: { active: 0, waiting: 0, riding: 0 },
};
const stats = {
  waitingRiders: 0,
  activeTrips: 0,
  completedTrips: 0,
  noDriverTrips: 0,
  avgWaitToMatchS: null,
  avgWaitToPickupS: null,
  matchRate: null,
};
const driverId = '11111111-1111-4111-8111-111111111111';
const driver = {
  driverId,
  status: 'AVAILABLE',
  tripId: null,
  lat: 47.6097,
  lng: -122.3422,
  heading: 90,
  ts: 1,
};
const emptyDiff = { upsert: [], remove: [] };

describe('ws', () => {
  it('accepts a snapshot', () => {
    const msg = {
      type: 'snapshot',
      at: 1,
      clock,
      config,
      bots,
      stats,
      drivers: [driver],
      riders: [],
      trips: [],
      users: [{ id: driverId, name: 'Dee', role: 'driver', vehicle: null }],
    };
    expect(WsSnapshotSchema.parse(msg).drivers).toHaveLength(1);
    expect(WsServerMessageSchema.parse(msg).type).toBe('snapshot');
  });

  it('accepts a diff with only changed parts', () => {
    const msg = {
      type: 'diff',
      at: 2,
      clock,
      drivers: { upsert: [driver], remove: [] },
      riders: emptyDiff,
      trips: { upsert: [], remove: ['some-trip-id'] },
      users: [],
    };
    const parsed = WsDiffSchema.parse(msg);
    expect(parsed.config).toBeUndefined();
    expect(WsServerMessageSchema.parse(msg).type).toBe('diff');
  });

  it('rejects unknown message types and malformed collections', () => {
    expect(() => WsServerMessageSchema.parse({ type: 'hello', at: 1 })).toThrow();
    expect(() =>
      WsDiffSchema.parse({
        type: 'diff',
        at: 1,
        drivers: { upsert: [] },
        riders: emptyDiff,
        trips: emptyDiff,
        users: [],
      }),
    ).toThrow();
  });
});
