import { z } from 'zod';
import { LatLngSchema, UuidSchema } from './common';

export const RiderLocationUpdateSchema = LatLngSchema;
export type RiderLocationUpdate = z.infer<typeof RiderLocationUpdateSchema>;

export const RiderPositionSchema = z
  .object({
    riderId: UuidSchema,
    lat: LatLngSchema.shape.lat,
    lng: LatLngSchema.shape.lng,
    ts: z.number().nonnegative(),
  })
  .strict();
export type RiderPosition = z.infer<typeof RiderPositionSchema>;

export const RideRequestSchema = z
  .object({ pickup: LatLngSchema.optional(), dropoff: LatLngSchema })
  .strict();
export type RideRequest = z.infer<typeof RideRequestSchema>;

export const RideRequestResponseSchema = z.object({ tripId: UuidSchema }).strict();
export type RideRequestResponse = z.infer<typeof RideRequestResponseSchema>;
