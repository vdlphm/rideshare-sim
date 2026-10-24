import {
  BadGatewayException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { UpstreamError, type HttpClient } from '@rideshare/common';
import {
  NearestResultSchema,
  RouteSchema,
  type DriverStatus,
  type LatLng,
  type MatchRequest,
  type Route,
} from '@rideshare/contracts';

export const ROUTING_HTTP = Symbol('ROUTING_HTTP');
export const DRIVER_HTTP = Symbol('DRIVER_HTTP');
export const MATCHING_HTTP = Symbol('MATCHING_HTTP');

const fmt = (p: LatLng) => `${p.lat},${p.lng}`;

function upstreamMessage(err: UpstreamError): string {
  const body = err.body as { message?: unknown } | undefined;
  const m = body?.message;
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.join('; ');
  return err.message;
}

/** Routing 422 (not routable) passes through; every other upstream failure becomes 502/503. */
export function mapUpstreamError(err: unknown): never {
  if (err instanceof UpstreamError) {
    if (err.service === 'routing' && err.status === 422) {
      throw new UnprocessableEntityException(upstreamMessage(err));
    }
    throw new BadGatewayException(`${err.service} responded ${err.status}`);
  }
  throw new ServiceUnavailableException(`upstream unreachable: ${(err as Error).message}`);
}

/** Thin typed wrappers over the routing, driver and matching services. */
@Injectable()
export class Upstreams {
  private readonly logger = new Logger(Upstreams.name);

  constructor(
    @Inject(ROUTING_HTTP) private readonly routing: HttpClient,
    @Inject(DRIVER_HTTP) private readonly driver: HttpClient,
    @Inject(MATCHING_HTTP) private readonly matching: HttpClient,
  ) {}

  /** Snaps a point to the road network; throws 422 when it is not routable. */
  async snap(point: LatLng): Promise<LatLng> {
    try {
      const r = await this.routing.get('/internal/nearest', {
        query: { lat: point.lat, lng: point.lng },
        schema: NearestResultSchema,
      });
      return { lat: r.lat, lng: r.lng };
    } catch (err) {
      return mapUpstreamError(err);
    }
  }

  async route(from: LatLng, to: LatLng): Promise<Route> {
    try {
      return await this.routing.get('/internal/route', {
        query: { from: fmt(from), to: fmt(to) },
        schema: RouteSchema,
      });
    } catch (err) {
      return mapUpstreamError(err);
    }
  }

  /** Idempotent on the driver side; the client retries transient failures. */
  async setDriverStatus(
    driverId: string,
    status: DriverStatus,
    tripId: string | null,
  ): Promise<boolean> {
    try {
      await this.driver.put(`/internal/drivers/${driverId}/status`, { body: { status, tripId } });
      return true;
    } catch (err) {
      this.logger.error(
        `driver ${driverId} -> ${status} (trip ${tripId}) failed: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /** POST /internal/match is idempotent per tripId, so retries are safe. Never throws. */
  async requestMatch(req: MatchRequest): Promise<boolean> {
    try {
      await this.matching.post('/internal/match', { body: req, idempotent: true });
      return true;
    } catch (err) {
      this.logger.warn(`match request for trip ${req.tripId} failed: ${(err as Error).message}`);
      return false;
    }
  }
}
