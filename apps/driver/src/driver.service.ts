import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@rideshare/common';
import type {
  DriverLocationUpdate,
  DriverState,
  DriverStatusUpdate,
  GoOnlineRequest,
  NearbyDriver,
  NearbyDriversQuery,
} from '@rideshare/contracts';
import { CLOCK, type Clock } from './clock';
import type { DriverEnv } from './config';
import { DriverStore, type TransitionResult } from './driver.store';
import { TripGateway } from './trip.gateway';

/** Redis GEO only accepts latitudes within this range. */
const GEO_MAX_LAT = 85.05112878;

function assertGeoLat(lat: number): void {
  if (Math.abs(lat) > GEO_MAX_LAT) {
    throw new BadRequestException(`lat must be within +/-${GEO_MAX_LAT}`);
  }
}

@Injectable()
export class DriverService {
  private readonly logger = new Logger(DriverService.name);
  private readonly staleAfterMs: number;

  constructor(
    private readonly store: DriverStore,
    private readonly trips: TripGateway,
    @Inject(CLOCK) private readonly clock: Clock,
    config: ConfigService<DriverEnv>,
  ) {
    this.staleAfterMs = config.get('STALE_AFTER_MS');
  }

  private ok(r: TransitionResult): DriverState {
    if (r.code === 'NOT_FOUND') throw new NotFoundException('Driver not found');
    return r.state!;
  }

  async goOnline(id: string, body: GoOnlineRequest): Promise<DriverState> {
    assertGeoLat(body.lat);
    return this.ok(await this.store.goOnline(id, body.lat, body.lng, this.clock()));
  }

  async goOffline(id: string): Promise<DriverState> {
    const current = await this.store.get(id);
    if (current?.status === 'ON_TRIP' && current.tripId) {
      return this.offlineFromTrip(id, current.tripId);
    }
    const r = await this.store.goOffline(id, this.clock());
    if (r.code === 'ON_TRIP') throw new ConflictException('Finish your trip first');
    return this.ok(r);
  }

  /** ON_TRIP: Trip must release the driver first (MATCHED only); then OFFLINE if nothing changed. */
  private async offlineFromTrip(id: string, tripId: string): Promise<DriverState> {
    let outcome;
    try {
      outcome = await this.trips.unassign(tripId, 'driver_offline');
    } catch (err) {
      this.logger.warn(`trip unassign failed for driver ${id}, trip ${tripId}: ${String(err)}`);
      throw new BadGatewayException('Trip service unavailable');
    }
    if (outcome === 'CONFLICT') throw new ConflictException('Finish your trip first');
    const r = await this.store.offlineAfterUnassign(id, tripId, this.clock());
    if (r.code === 'OK') return this.ok(r);
    // The driver changed meanwhile. If the released trip already freed it, go offline normally.
    if (r.state && r.state.status !== 'ON_TRIP') {
      return this.ok(await this.store.goOffline(id, this.clock()));
    }
    throw new ConflictException('Finish your trip first');
  }

  async updateLocation(id: string, body: DriverLocationUpdate): Promise<void> {
    assertGeoLat(body.lat);
    const r = await this.store.updateLocation(id, body.lat, body.lng, body.heading, this.clock());
    if (r.code === 'NOT_FOUND' || r.code === 'NOT_ONLINE') {
      throw new ConflictException('Go online first');
    }
  }

  async me(id: string): Promise<DriverState> {
    const s = await this.store.get(id);
    if (!s) throw new NotFoundException('Driver not found');
    return s;
  }

  nearby(q: NearbyDriversQuery): Promise<NearbyDriver[]> {
    return this.store.nearby(q.lat, q.lng, q.radiusM, q.limit, this.clock(), this.staleAfterMs);
  }

  online(): Promise<DriverState[]> {
    return this.store.listOnline();
  }

  async setStatus(id: string, body: DriverStatusUpdate): Promise<DriverState> {
    if (body.status === 'ON_TRIP' && body.tripId === null) {
      throw new BadRequestException('tripId is required for ON_TRIP');
    }
    if (body.status !== 'ON_TRIP' && body.tripId !== null) {
      throw new BadRequestException('tripId must be null unless status is ON_TRIP');
    }
    return this.ok(
      await this.store.setStatus(id, body.status, body.tripId, this.clock(), this.staleAfterMs),
    );
  }
}
