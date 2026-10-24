import { Injectable } from '@nestjs/common';
import type { HttpClient } from '@rideshare/common';
import { UpstreamError } from '@rideshare/common';
import { z } from 'zod';

export const TRIP_HTTP = Symbol('TRIP_HTTP');

export interface ActiveTrip {
  id: string;
  driverId: string;
}

export type UnassignOutcome = 'UNASSIGNED' | 'CONFLICT';

/** Port to the trip service; the decision logic depends only on this. */
export abstract class TripGateway {
  /** UNASSIGNED on 200, CONFLICT on 409 (trip not MATCHED); throws if the trip is unreachable/failing. */
  abstract unassign(tripId: string, reason: string): Promise<UnassignOutcome>;
  /** Active (MATCHED/ARRIVED/IN_PROGRESS) trips of up to MAX_ACTIVE_BATCH drivers. */
  abstract activeTrips(driverIds: string[]): Promise<ActiveTrip[]>;
}

export const MAX_ACTIVE_BATCH = 500;

const ActiveTripsSchema = z.array(
  z.looseObject({ id: z.string().min(1), driverId: z.string().min(1).nullable() }),
);

@Injectable()
export class HttpTripGateway extends TripGateway {
  constructor(private readonly http: HttpClient) {
    super();
  }

  async unassign(tripId: string, reason: string): Promise<UnassignOutcome> {
    try {
      // POST is not retried: a retry after a lost 200 would see 409 and misreport the outcome.
      await this.http.post(`/internal/trips/${encodeURIComponent(tripId)}/unassign`, {
        body: { reason },
        auth: 'service',
      });
      return 'UNASSIGNED';
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 409) return 'CONFLICT';
      throw err;
    }
  }

  async activeTrips(driverIds: string[]): Promise<ActiveTrip[]> {
    if (driverIds.length === 0) return [];
    const trips = await this.http.get('/internal/trips/active', {
      query: { driverIds: driverIds.join(',') },
      auth: 'service',
      schema: ActiveTripsSchema,
    });
    return trips.flatMap((t) => (t.driverId ? [{ id: t.id, driverId: t.driverId }] : []));
  }
}
