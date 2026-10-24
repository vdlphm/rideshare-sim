import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
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

/** Redis GEO only accepts latitudes within this range. */
const GEO_MAX_LAT = 85.05112878;

function assertGeoLat(lat: number): void {
  if (Math.abs(lat) > GEO_MAX_LAT) {
    throw new BadRequestException(`lat must be within +/-${GEO_MAX_LAT}`);
  }
}

@Injectable()
export class DriverService {
  private readonly staleAfterMs: number;

  constructor(
    private readonly store: DriverStore,
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
    const r = await this.store.goOffline(id, this.clock());
    if (r.code === 'ON_TRIP') throw new ConflictException('Finish your trip first');
    return this.ok(r);
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
