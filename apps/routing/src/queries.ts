import { LatLngSchema } from '@rideshare/contracts';
import { z } from 'zod';

const NUM = String.raw`[+-]?\d+(?:\.\d+)?`;
const LAT_LNG = new RegExp(String.raw`^\s*(${NUM})\s*,\s*(${NUM})\s*$`);

/** Query-string point `lat,lng` (e.g. `47.6097,-122.3422`) -> `{lat, lng}` with range checks. */
export const LatLngParamSchema = z
  .string()
  .regex(LAT_LNG, 'expected "lat,lng"')
  .transform((s) => {
    const m = LAT_LNG.exec(s)!;
    return { lat: Number(m[1]), lng: Number(m[2]) };
  })
  .pipe(LatLngSchema);

/** `GET /route?from=lat,lng&to=lat,lng` */
export const RouteParamsSchema = z.object({ from: LatLngParamSchema, to: LatLngParamSchema });
export type RouteParams = z.infer<typeof RouteParamsSchema>;
