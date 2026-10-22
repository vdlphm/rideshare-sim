import { z } from 'zod';
import { LatLngSchema } from './common';

const { lat, lng } = LatLngSchema.shape;

export const RouteQuerySchema = z.object({ from: LatLngSchema, to: LatLngSchema }).strict();
export type RouteQuery = z.infer<typeof RouteQuerySchema>;

/** [lng, lat] in GeoJSON order. */
export const GeoPointSchema = z.tuple([lng, lat]);

export const RouteSchema = z
  .object({
    distanceM: z.number().nonnegative(),
    durationS: z.number().nonnegative(),
    geometry: z.array(GeoPointSchema).min(2),
    durations: z.array(z.number().nonnegative()),
  })
  .refine((r) => r.durations.length === r.geometry.length - 1, {
    message: 'durations.length must equal geometry.length - 1',
    path: ['durations'],
  });
export type Route = z.infer<typeof RouteSchema>;

export const TableRequestSchema = z
  .object({
    sources: z.array(LatLngSchema).min(1).max(25),
    destinations: z.array(LatLngSchema).min(1).max(25),
  })
  .strict();
export type TableRequest = z.infer<typeof TableRequestSchema>;

export const TableResponseSchema = z
  .object({ durations: z.array(z.array(z.number().nullable())) })
  .strict();
export type TableResponse = z.infer<typeof TableResponseSchema>;

/** Query-string schema: values arrive as strings, hence coerce. */
export const NearestQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});
export type NearestQuery = z.infer<typeof NearestQuerySchema>;

export const NearestResultSchema = z
  .object({ lat, lng, distanceM: z.number().nonnegative() })
  .strict();
export type NearestResult = z.infer<typeof NearestResultSchema>;
