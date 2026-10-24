import { sql } from 'drizzle-orm';
import {
  bigint,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { geographyLineString, geographyPoint } from './geography';

// `pgSchema` directly (not common's `serviceSchema`) so drizzle-kit can load this file
// without a built @rideshare/common.
export const tripSchema = pgSchema('trip_service');

export const tripStatus = tripSchema.enum('trip_status', [
  'REQUESTED',
  'MATCHED',
  'ARRIVED',
  'IN_PROGRESS',
  'COMPLETED',
  'NO_DRIVERS',
]);

/** Sim-time milliseconds. `number` mode is safe: sim time never nears 2^53. */
const simTime = (name: string) => bigint(name, { mode: 'number' });

export const trips = tripSchema.table(
  'trips',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    riderId: uuid('rider_id').notNull(),
    driverId: uuid('driver_id'),
    status: tripStatus('status').notNull(),
    pickup: geographyPoint('pickup').notNull(),
    dropoff: geographyPoint('dropoff').notNull(),
    tripRoute: geographyLineString('trip_route').notNull(),
    pickupRoute: geographyLineString('pickup_route'),
    // Per-segment durations (seconds), parallel to the route geometry's segments. Kept as
    // double precision[] because geography cannot hold them and they are only read back whole.
    tripRouteDurations: doublePrecision('trip_route_durations').array().notNull(),
    pickupRouteDurations: doublePrecision('pickup_route_durations').array(),
    // Pickup-route totals (the trip route's totals are est_distance_m / est_duration_s).
    pickupRouteDistanceM: doublePrecision('pickup_route_distance_m'),
    pickupRouteDurationS: doublePrecision('pickup_route_duration_s'),
    estDistanceM: doublePrecision('est_distance_m').notNull(),
    estDurationS: doublePrecision('est_duration_s').notNull(),
    requestedAt: simTime('requested_at').notNull(),
    matchedAt: simTime('matched_at'),
    arrivedAt: simTime('arrived_at'),
    startedAt: simTime('started_at'),
    completedAt: simTime('completed_at'),
    endedReason: text('ended_reason'),
    version: integer('version').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The DB guarantees one non-terminal trip per rider and one active trip per driver.
    uniqueIndex('trips_rider_non_terminal_uq')
      .on(t.riderId)
      .where(sql`"status" IN ('REQUESTED', 'MATCHED', 'ARRIVED', 'IN_PROGRESS')`),
    uniqueIndex('trips_driver_active_uq')
      .on(t.driverId)
      .where(sql`"status" IN ('MATCHED', 'ARRIVED', 'IN_PROGRESS')`),
    index('trips_status_idx').on(t.status),
    index('trips_requested_at_idx').on(t.requestedAt),
  ],
);

export const tripEvents = tripSchema.table(
  'trip_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    fromStatus: tripStatus('from_status'),
    toStatus: tripStatus('to_status').notNull(),
    atSim: simTime('at_sim').notNull(),
    atReal: timestamp('at_real', { withTimezone: true }).notNull().defaultNow(),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index('trip_events_trip_at_sim_idx').on(t.tripId, t.atSim)],
);
