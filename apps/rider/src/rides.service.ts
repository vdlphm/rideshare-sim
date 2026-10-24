import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { UpstreamError, type HttpClient } from '@rideshare/common';
import {
  RideRequestResponseSchema,
  type LatLng,
  type RideRequest,
  type RideRequestResponse,
} from '@rideshare/contracts';
import { RiderPositionsService } from './positions.service';

export const TRIP_HTTP = Symbol('TRIP_HTTP');

function upstreamMessage(err: UpstreamError, fallback: string): string {
  const m = (err.body as { message?: unknown } | undefined)?.message;
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.join('; ');
  return fallback;
}

/** Trip's 400/409/422 pass through with its message; anything else is a generic 502. */
export function mapTripError(err: unknown): never {
  if (err instanceof UpstreamError) {
    if (err.status === 400)
      throw new BadRequestException(upstreamMessage(err, 'Invalid ride request'));
    if (err.status === 409)
      throw new ConflictException(upstreamMessage(err, 'Rider already has an active trip'));
    if (err.status === 422)
      throw new UnprocessableEntityException(upstreamMessage(err, 'Locations are not routable'));
  }
  throw new BadGatewayException('trip service unavailable');
}

@Injectable()
export class RideRequestsService {
  constructor(
    private readonly positions: RiderPositionsService,
    @Inject(TRIP_HTTP) private readonly trip: HttpClient,
  ) {}

  /** Creates a trip for the rider; the rider's own token is forwarded, never a riderId. */
  async request(riderId: string, body: RideRequest): Promise<RideRequestResponse> {
    let pickup: LatLng | undefined = body.pickup;
    if (!pickup) {
      const pos = await this.positions.get(riderId);
      if (pos) pickup = { lat: pos.lat, lng: pos.lng };
    }
    if (!pickup) {
      throw new UnprocessableEntityException('no pickup given and no current position');
    }
    try {
      return await this.trip.post('/internal/trips', {
        body: { pickup, dropoff: body.dropoff },
        schema: RideRequestResponseSchema,
        idempotent: false,
      });
    } catch (err) {
      return mapTripError(err);
    }
  }
}
