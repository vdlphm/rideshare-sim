import { z } from 'zod';
import { DriverStatusSchema, HeadingSchema, LatLngSchema, UuidSchema } from './common';

const { lat, lng } = LatLngSchema.shape;

export const GoOnlineRequestSchema = LatLngSchema;
export type GoOnlineRequest = z.infer<typeof GoOnlineRequestSchema>;

export const DriverLocationUpdateSchema = z.object({ lat, lng, heading: HeadingSchema }).strict();
export type DriverLocationUpdate = z.infer<typeof DriverLocationUpdateSchema>;

export const DriverStateSchema = z
  .object({
    driverId: UuidSchema,
    status: DriverStatusSchema,
    tripId: UuidSchema.nullable(),
    lat,
    lng,
    heading: HeadingSchema,
    ts: z.number().nonnegative(),
  })
  .strict();
export type DriverState = z.infer<typeof DriverStateSchema>;

/** Query-string schema: values arrive as strings, hence coerce. */
export const NearbyDriversQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusM: z.coerce.number().min(1).max(10000),
  limit: z.coerce.number().int().min(1).max(50),
});
export type NearbyDriversQuery = z.infer<typeof NearbyDriversQuerySchema>;

export const NearbyDriverSchema = z
  .object({ driverId: UuidSchema, lat, lng, distanceM: z.number().nonnegative() })
  .strict();
export type NearbyDriver = z.infer<typeof NearbyDriverSchema>;

export const DriverStatusUpdateSchema = z
  .object({ status: DriverStatusSchema, tripId: UuidSchema.nullable() })
  .strict();
export type DriverStatusUpdate = z.infer<typeof DriverStatusUpdateSchema>;
