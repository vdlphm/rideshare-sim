import { Inject, Injectable, Logger } from '@nestjs/common';
import { UpstreamError, type HttpClient } from '@rideshare/common';
import {
  NearbyDriverSchema,
  TableResponseSchema,
  type LatLng,
  type TableRequest,
} from '@rideshare/contracts';
import { z } from 'zod';
import { DriversPort, RoutingPort, TripPort } from '../domain/ports';
import type { AssignOutcome, Candidate, NoDriversOutcome } from '../domain/types';

export const DRIVER_HTTP = Symbol('DRIVER_HTTP');
export const ROUTING_HTTP = Symbol('ROUTING_HTTP');
export const TRIP_HTTP = Symbol('TRIP_HTTP');

@Injectable()
export class HttpDriversPort extends DriversPort {
  constructor(@Inject(DRIVER_HTTP) private readonly http: HttpClient) {
    super();
  }

  nearby(pos: LatLng, radiusM: number, limit: number): Promise<Candidate[]> {
    return this.http.get('/internal/drivers/nearby', {
      query: { lat: pos.lat, lng: pos.lng, radiusM, limit },
      schema: z.array(NearbyDriverSchema),
    });
  }
}

@Injectable()
export class HttpRoutingPort extends RoutingPort {
  constructor(@Inject(ROUTING_HTTP) private readonly http: HttpClient) {
    super();
  }

  async etas(sources: LatLng[], destination: LatLng): Promise<(number | null)[]> {
    const body: TableRequest = { sources, destinations: [destination] };
    // POST /internal/table is a pure read, so retries are safe.
    const res = await this.http.post('/internal/table', {
      body,
      schema: TableResponseSchema,
      idempotent: true,
    });
    return sources.map((_, i) => res.durations[i]?.[0] ?? null);
  }
}

function message(err: UpstreamError): string {
  const m = (err.body as { message?: unknown } | undefined)?.message;
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.join('; ');
  return '';
}

@Injectable()
export class HttpTripPort extends TripPort {
  private readonly logger = new Logger(HttpTripPort.name);

  constructor(@Inject(TRIP_HTTP) private readonly http: HttpClient) {
    super();
  }

  async assign(
    tripId: string,
    body: { driverId: string; offerId: string; driverPosition: LatLng },
  ): Promise<AssignOutcome> {
    try {
      await this.http.post(`/internal/trips/${tripId}/assign`, { body });
      return 'ok';
    } catch (err) {
      if (err instanceof UpstreamError) {
        if (err.status === 404) return 'trip-gone';
        if (err.status === 409) {
          const m = message(err);
          if (m.includes('driver already has an active trip')) return 'driver-busy';
          if (m.includes('modified concurrently')) return 'conflict';
          if (m.includes('Cannot assign a trip in status')) return 'trip-gone';
          // Unknown conflict: treat as transient and move on to the next candidate.
          return 'conflict';
        }
      }
      this.logger.warn(`assign for trip ${tripId} failed: ${(err as Error).message}`);
      return 'unreachable';
    }
  }

  async noDrivers(tripId: string): Promise<NoDriversOutcome> {
    try {
      await this.http.post(`/internal/trips/${tripId}/no-drivers`, { idempotent: true });
      return 'ok';
    } catch (err) {
      if (err instanceof UpstreamError && (err.status === 404 || err.status === 409)) {
        return 'trip-gone';
      }
      this.logger.warn(`no-drivers for trip ${tripId} failed: ${(err as Error).message}`);
      return 'unreachable';
    }
  }
}
