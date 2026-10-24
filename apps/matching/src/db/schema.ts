import { sql } from 'drizzle-orm';
import { bigint, doublePrecision, index, integer, pgSchema, uuid } from 'drizzle-orm/pg-core';

// `pgSchema` directly so drizzle-kit can load this file without a built @rideshare/common.
export const matchingSchema = pgSchema('matching_service');

export const offerStatus = matchingSchema.enum('offer_status', [
  'PENDING',
  'ACCEPTED',
  'DECLINED',
  'EXPIRED',
]);
export const jobStatus = matchingSchema.enum('job_status', ['ACTIVE', 'DONE', 'FAILED']);

/** Sim-time milliseconds. `number` mode is safe: sim time never nears 2^53. */
const simTime = (name: string) => bigint(name, { mode: 'number' });

export const offers = matchingSchema.table(
  'offers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripId: uuid('trip_id').notNull(),
    driverId: uuid('driver_id').notNull(),
    status: offerStatus('status').notNull(),
    etaS: doublePrecision('eta_s').notNull(),
    attempt: integer('attempt').notNull(),
    /** The candidate's position when the offer was made (becomes assign's driverPosition). */
    driverLat: doublePrecision('driver_lat').notNull(),
    driverLng: doublePrecision('driver_lng').notNull(),
    pickupLat: doublePrecision('pickup_lat').notNull(),
    pickupLng: doublePrecision('pickup_lng').notNull(),
    dropoffLat: doublePrecision('dropoff_lat').notNull(),
    dropoffLng: doublePrecision('dropoff_lng').notNull(),
    createdSim: simTime('created_sim').notNull(),
    expiresSim: simTime('expires_sim').notNull(),
    resolvedSim: simTime('resolved_sim'),
  },
  (t) => [
    index('offers_driver_pending_idx')
      .on(t.driverId)
      .where(sql`${t.status} = 'PENDING'`),
    index('offers_trip_idx').on(t.tripId),
  ],
);

export const matchJobs = matchingSchema.table('match_jobs', {
  tripId: uuid('trip_id').primaryKey(),
  status: jobStatus('status').notNull(),
  /** Steps that found no usable candidate; picks the search radius. */
  attempt: integer('attempt').notNull().default(0),
  radiusM: integer('radius_m').notNull(),
  pickupLat: doublePrecision('pickup_lat').notNull(),
  pickupLng: doublePrecision('pickup_lng').notNull(),
  dropoffLat: doublePrecision('dropoff_lat').notNull(),
  dropoffLng: doublePrecision('dropoff_lng').notNull(),
  startedSim: simTime('started_sim').notNull(),
  updatedSim: simTime('updated_sim').notNull(),
});
