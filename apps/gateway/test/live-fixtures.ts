import { randomUUID } from 'node:crypto';
import type {
  DriverState,
  RiderPosition,
  Trip,
  TripStats,
  UserDisplay,
} from '@rideshare/contracts';
import type { SimState } from '../src/live/live-model';

export const uuid = (): string => randomUUID();

export function driver(over: Partial<DriverState> = {}): DriverState {
  return {
    driverId: uuid(),
    status: 'AVAILABLE',
    tripId: null,
    lat: 10.77,
    lng: 106.7,
    heading: 90,
    ts: 1000,
    ...over,
  };
}

export function rider(over: Partial<RiderPosition> = {}): RiderPosition {
  return { riderId: uuid(), lat: 10.78, lng: 106.69, ts: 1000, ...over };
}

export function trip(over: Partial<Trip> = {}): Trip {
  return {
    id: uuid(),
    riderId: uuid(),
    driverId: null,
    status: 'REQUESTED',
    pickup: { lat: 10.78, lng: 106.69 },
    dropoff: { lat: 10.8, lng: 106.7 },
    tripRoute: {
      distanceM: 100,
      durationS: 10,
      geometry: [
        [106.69, 10.78],
        [106.7, 10.8],
      ],
      durations: [10],
    },
    pickupRoute: null,
    estDistanceM: 100,
    estDurationS: 10,
    requestedAt: 0,
    matchedAt: null,
    arrivedAt: null,
    startedAt: null,
    completedAt: null,
    endedReason: null,
    ...over,
  };
}

export function user(id: string, over: Partial<UserDisplay> = {}): UserDisplay {
  return { id, name: `user-${id.slice(0, 4)}`, role: 'rider', ...over };
}

export function simState(over: Partial<SimState> = {}): SimState {
  return {
    clock: { simTime: 5000, speed: 1, paused: false },
    config: {
      driverCount: 10,
      spawnIntervalS: 5,
      speed: 1,
      paused: false,
      acceptProbability: 0.8,
    },
    bots: {
      drivers: { total: 10, idle: 10, toPickup: 0, atPickup: 0, inTrip: 0 },
      riders: { active: 0, waiting: 0, riding: 0 },
    },
    ...over,
  };
}

export function stats(over: Partial<TripStats> = {}): TripStats {
  return {
    waitingRiders: 0,
    activeTrips: 0,
    completedTrips: 0,
    noDriverTrips: 0,
    avgWaitToMatchS: null,
    avgWaitToPickupS: null,
    matchRate: null,
    ...over,
  };
}
