import { z } from 'zod';
import { LatLngSchema, OfferStatusSchema, SimTimeSchema, UuidSchema } from './common';

export const MatchRequestSchema = z
  .object({ tripId: UuidSchema, pickup: LatLngSchema, dropoff: LatLngSchema })
  .strict();
export type MatchRequest = z.infer<typeof MatchRequestSchema>;

export const OfferSchema = z.object({
  id: UuidSchema,
  tripId: UuidSchema,
  driverId: UuidSchema,
  status: OfferStatusSchema,
  etaS: z.number().nonnegative(),
  attempt: z.number().int().positive(),
  expiresSim: SimTimeSchema,
  pickup: LatLngSchema,
  dropoff: LatLngSchema,
});
export type Offer = z.infer<typeof OfferSchema>;

export const AcceptOfferResponseSchema = z.object({ tripId: UuidSchema }).strict();
export type AcceptOfferResponse = z.infer<typeof AcceptOfferResponseSchema>;
