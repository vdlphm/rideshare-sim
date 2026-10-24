import {
  BadGatewayException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { HttpClient, UpstreamError } from '@rideshare/common';
import type { LatLng } from '@rideshare/contracts';
import { haversineM } from '@rideshare/geo';
import { z } from 'zod';

export const OSRM_HTTP = Symbol('OSRM_HTTP');

const OsrmEnvelope = z.looseObject({ code: z.string(), message: z.string().optional() });

const OsrmRoute = z.looseObject({
  code: z.literal('Ok'),
  routes: z
    .array(
      z.looseObject({
        distance: z.number(),
        duration: z.number(),
        geometry: z.looseObject({ coordinates: z.array(z.tuple([z.number(), z.number()])) }),
        legs: z.array(
          z.looseObject({
            annotation: z.looseObject({ duration: z.array(z.number()) }).optional(),
          }),
        ),
      }),
    )
    .min(1),
});

const OsrmTable = z.looseObject({
  code: z.literal('Ok'),
  durations: z.array(z.array(z.number().nullable())),
});

const OsrmNearest = z.looseObject({
  code: z.literal('Ok'),
  waypoints: z
    .array(z.looseObject({ location: z.tuple([z.number(), z.number()]), distance: z.number() }))
    .min(1),
});

export interface OsrmRoute {
  distanceM: number;
  durationS: number;
  geometry: [number, number][];
  /** One entry per geometry segment, summing to `durationS`. */
  durations: number[];
}

export interface OsrmNearest {
  lat: number;
  lng: number;
  distanceM: number;
}

const coord = (p: LatLng) => `${p.lng},${p.lat}`;

/**
 * Spreads `total` over `weights` proportionally (evenly when all weights are zero) so the
 * result sums to `total`.
 */
function distribute(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum > 0) return weights.map((w) => (w * total) / sum);
  return weights.map(() => (weights.length > 0 ? total / weights.length : 0));
}

/** Thin typed wrapper over OSRM's HTTP API. Failures become 422 (bad query) or 502 (OSRM down). */
@Injectable()
export class OsrmClient {
  constructor(@Inject(OSRM_HTTP) private readonly http: HttpClient) {}

  async route(from: LatLng, to: LatLng): Promise<OsrmRoute> {
    const body = await this.call(
      `/route/v1/driving/${coord(from)};${coord(to)}?overview=full&geometries=geojson&annotations=duration&steps=false`,
      OsrmRoute,
    );
    const r = body.routes[0]!;
    let geometry = r.geometry.coordinates;
    if (geometry.length === 1) geometry = [geometry[0]!, geometry[0]!];
    if (geometry.length < 2) throw new BadGatewayException('OSRM returned an empty geometry');

    // OSRM reports one duration per geometry segment for a single-leg route with overview=full
    // (verified against v5.27.1). Its per-edge sum excludes the partial edges at the snapped
    // ends, so it is smaller than the route duration: rescale so the parts add up to the total.
    const annotated = r.legs.length === 1 ? r.legs[0]!.annotation?.duration : undefined;
    const segments = geometry.length - 1;
    let durations: number[];
    if (annotated && annotated.length === segments) {
      durations = distribute(r.duration, annotated);
    } else {
      // Defensive fallback: apportion by segment length.
      const lengths = geometry
        .slice(1)
        .map((p, i) =>
          haversineM({ lat: geometry[i]![1], lng: geometry[i]![0] }, { lat: p[1], lng: p[0] }),
        );
      durations = distribute(r.duration, lengths);
    }
    return { distanceM: r.distance, durationS: r.duration, geometry, durations };
  }

  async table(sources: LatLng[], destinations: LatLng[]): Promise<(number | null)[][]> {
    const all = [...sources, ...destinations].map(coord).join(';');
    const src = sources.map((_, i) => i).join(';');
    const dst = destinations.map((_, i) => sources.length + i).join(';');
    const body = await this.call(
      `/table/v1/driving/${all}?sources=${src}&destinations=${dst}&annotations=duration`,
      OsrmTable,
    );
    const ok =
      body.durations.length === sources.length &&
      body.durations.every((row) => row.length === destinations.length);
    if (!ok) throw new BadGatewayException('OSRM returned a malformed duration table');
    return body.durations;
  }

  async nearest(p: LatLng): Promise<OsrmNearest> {
    const body = await this.call(`/nearest/v1/driving/${coord(p)}?number=1`, OsrmNearest);
    const w = body.waypoints[0]!;
    return { lng: w.location[0], lat: w.location[1], distanceM: w.distance };
  }

  private async call<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
    let raw: unknown;
    try {
      raw = await this.http.get(path);
    } catch (err) {
      if (err instanceof UpstreamError && err.status >= 400 && err.status < 500) {
        throw unprocessable(err.body);
      }
      throw new BadGatewayException('Routing backend (OSRM) is unavailable');
    }
    const envelope = OsrmEnvelope.safeParse(raw);
    if (!envelope.success) throw new BadGatewayException('Unexpected response from OSRM');
    if (envelope.data.code !== 'Ok') throw unprocessable(raw);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new BadGatewayException('Unexpected response from OSRM');
    return parsed.data;
  }
}

function unprocessable(body: unknown): UnprocessableEntityException {
  const env = OsrmEnvelope.safeParse(body);
  const detail = env.success
    ? `${env.data.code}${env.data.message ? `: ${env.data.message}` : ''}`
    : 'rejected';
  return new UnprocessableEntityException(`Cannot route the given coordinates (${detail})`);
}
