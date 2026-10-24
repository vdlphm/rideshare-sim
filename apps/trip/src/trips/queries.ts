import { UuidSchema } from '@rideshare/contracts';
import { z } from 'zod';

export const TripListQuerySchema = z.object({
  status: z.enum(['active', 'requested', 'completed', 'all']).default('active'),
});
export type TripListQuery = z.infer<typeof TripListQuerySchema>;

const csvUuids = z
  .string()
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x !== ''),
  )
  .pipe(z.array(UuidSchema).max(500));

export const ActiveTripsQuerySchema = z.object({
  driverIds: csvUuids.optional(),
  updatedSince: z.iso.datetime().optional(),
});
export type ActiveTripsQuery = z.infer<typeof ActiveTripsQuerySchema>;

export const UnassignTripRequestSchema = z.object({ reason: z.string().min(1).max(200) }).strict();
export type UnassignTripRequest = z.infer<typeof UnassignTripRequestSchema>;
