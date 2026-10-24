import { Injectable } from '@nestjs/common';
import { InjectDb, type Db } from '@rideshare/common';
import type { Route, Trip, TripStatus } from '@rideshare/contracts';
import { eq } from 'drizzle-orm';
import { tripEvents, trips } from '../db/schema';

export interface NewTrip {
  riderId: string;
  pickup: { lat: number; lng: number };
  dropoff: { lat: number; lng: number };
  tripRoute: Route;
  /** Null until a driver is matched. */
  pickupRoute?: Route | null;
  requestedAt: number;
}

type TripRow = typeof trips.$inferSelect;

export function rowToTrip(row: TripRow): Trip {
  const hasPickupRoute =
    row.pickupRoute &&
    row.pickupRouteDurations &&
    row.pickupRouteDistanceM !== null &&
    row.pickupRouteDurationS !== null;
  return {
    id: row.id,
    riderId: row.riderId,
    driverId: row.driverId,
    status: row.status as TripStatus,
    pickup: row.pickup,
    dropoff: row.dropoff,
    tripRoute: {
      distanceM: row.estDistanceM,
      durationS: row.estDurationS,
      geometry: row.tripRoute,
      durations: row.tripRouteDurations,
    },
    pickupRoute: hasPickupRoute
      ? {
          distanceM: row.pickupRouteDistanceM!,
          durationS: row.pickupRouteDurationS!,
          geometry: row.pickupRoute!,
          durations: row.pickupRouteDurations!,
        }
      : null,
    estDistanceM: row.estDistanceM,
    estDurationS: row.estDurationS,
    requestedAt: row.requestedAt,
    matchedAt: row.matchedAt,
    arrivedAt: row.arrivedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    endedReason: row.endedReason,
  };
}

export abstract class TripsRepository {
  /** Inserts a REQUESTED trip and its creation event in one transaction. */
  abstract insert(input: NewTrip): Promise<Trip>;
  abstract findById(id: string): Promise<Trip | undefined>;
}

@Injectable()
export class DrizzleTripsRepository extends TripsRepository {
  constructor(@InjectDb() private readonly db: Db) {
    super();
  }

  async insert(input: NewTrip): Promise<Trip> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(trips)
        .values({
          riderId: input.riderId,
          status: 'REQUESTED',
          pickup: input.pickup,
          dropoff: input.dropoff,
          tripRoute: input.tripRoute.geometry,
          tripRouteDurations: input.tripRoute.durations,
          pickupRoute: input.pickupRoute?.geometry ?? null,
          pickupRouteDurations: input.pickupRoute?.durations ?? null,
          pickupRouteDistanceM: input.pickupRoute?.distanceM ?? null,
          pickupRouteDurationS: input.pickupRoute?.durationS ?? null,
          estDistanceM: input.tripRoute.distanceM,
          estDurationS: input.tripRoute.durationS,
          requestedAt: input.requestedAt,
        })
        .returning();
      await tx.insert(tripEvents).values({
        tripId: row!.id,
        fromStatus: null,
        toStatus: 'REQUESTED',
        atSim: input.requestedAt,
      });
      return rowToTrip(row!);
    });
  }

  async findById(id: string): Promise<Trip | undefined> {
    const [row] = await this.db.select().from(trips).where(eq(trips.id, id));
    return row && rowToTrip(row);
  }
}
