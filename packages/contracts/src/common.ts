import { z } from 'zod';

export const LatLngSchema = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  })
  .strict();
export type LatLng = z.infer<typeof LatLngSchema>;

export const HeadingSchema = z.number().min(0).lt(360);
export type Heading = z.infer<typeof HeadingSchema>;

export const UuidSchema = z.uuid();
export type Uuid = z.infer<typeof UuidSchema>;

/** Simulated time in milliseconds since sim start. */
export const SimTimeSchema = z.number().nonnegative();
export type SimTime = z.infer<typeof SimTimeSchema>;

export const RoleSchema = z.enum(['rider', 'driver', 'admin', 'service']);
export type Role = z.infer<typeof RoleSchema>;

export const TripStatusSchema = z.enum([
  'REQUESTED',
  'MATCHED',
  'ARRIVED',
  'IN_PROGRESS',
  'COMPLETED',
  'NO_DRIVERS',
]);
export type TripStatus = z.infer<typeof TripStatusSchema>;

export const DriverStatusSchema = z.enum(['OFFLINE', 'AVAILABLE', 'ON_TRIP']);
export type DriverStatus = z.infer<typeof DriverStatusSchema>;

export const OfferStatusSchema = z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED']);
export type OfferStatus = z.infer<typeof OfferStatusSchema>;

export const ACTIVE_TRIP_STATUSES: readonly TripStatus[] = ['MATCHED', 'ARRIVED', 'IN_PROGRESS'];
export const NON_TERMINAL_TRIP_STATUSES: readonly TripStatus[] = [
  'REQUESTED',
  ...ACTIVE_TRIP_STATUSES,
];
