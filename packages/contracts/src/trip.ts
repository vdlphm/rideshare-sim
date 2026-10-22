import { z } from 'zod';
import { LatLngSchema, SimTimeSchema, TripStatusSchema, UuidSchema } from './common';
import { RouteSchema } from './routing';

export const CreateTripRequestSchema = z
  .object({ pickup: LatLngSchema, dropoff: LatLngSchema })
  .strict();
export type CreateTripRequest = z.infer<typeof CreateTripRequestSchema>;

export const TripSchema = z.object({
  id: UuidSchema,
  riderId: UuidSchema,
  driverId: UuidSchema.nullable(),
  status: TripStatusSchema,
  pickup: LatLngSchema,
  dropoff: LatLngSchema,
  tripRoute: RouteSchema,
  pickupRoute: RouteSchema.nullable(),
  estDistanceM: z.number().nonnegative(),
  estDurationS: z.number().nonnegative(),
  requestedAt: SimTimeSchema,
  matchedAt: SimTimeSchema.nullable(),
  arrivedAt: SimTimeSchema.nullable(),
  startedAt: SimTimeSchema.nullable(),
  completedAt: SimTimeSchema.nullable(),
  endedReason: z.string().nullable(),
});
export type Trip = z.infer<typeof TripSchema>;

export const TripEventSchema = z.object({
  fromStatus: TripStatusSchema.nullable(),
  toStatus: TripStatusSchema,
  atSim: SimTimeSchema,
  atReal: z.iso.datetime(),
  meta: z.record(z.string(), z.unknown()),
});
export type TripEvent = z.infer<typeof TripEventSchema>;

export const TripDetailSchema = TripSchema.extend({ events: z.array(TripEventSchema) });
export type TripDetail = z.infer<typeof TripDetailSchema>;

export const AssignTripRequestSchema = z
  .object({ driverId: UuidSchema, offerId: UuidSchema })
  .strict();
export type AssignTripRequest = z.infer<typeof AssignTripRequestSchema>;

export const TripStatsSchema = z
  .object({
    waitingRiders: z.number().int().nonnegative(),
    activeTrips: z.number().int().nonnegative(),
    completedTrips: z.number().int().nonnegative(),
    noDriverTrips: z.number().int().nonnegative(),
    avgWaitToMatchS: z.number().nonnegative().nullable(),
    avgWaitToPickupS: z.number().nonnegative().nullable(),
    matchRate: z.number().min(0).max(1).nullable(),
  })
  .strict();
export type TripStats = z.infer<typeof TripStatsSchema>;
