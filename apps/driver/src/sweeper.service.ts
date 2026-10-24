import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@rideshare/common';
import { CLOCK, type Clock } from './clock';
import type { DriverEnv } from './config';
import { DriverStore } from './driver.store';
import { TripGateway } from './trip.gateway';

export interface SweepResult {
  swept: string[];
  /** Stale ON_TRIP drivers whose trip was unassigned, so they went OFFLINE. */
  unassigned: string[];
  /** Stale ON_TRIP drivers left as they are (trip in progress, or the trip call failed). */
  skippedOnTrip: string[];
}

/** Marks drivers with no recent location OFFLINE. stale ON_TRIP drivers are unassigned from their trip first. */
@Injectable()
export class StaleSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StaleSweeper.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly staleAfterMs: number;
  private readonly intervalMs: number;

  constructor(
    private readonly store: DriverStore,
    private readonly trips: TripGateway,
    @Inject(CLOCK) private readonly clock: Clock,
    config: ConfigService<DriverEnv>,
  ) {
    this.staleAfterMs = config.get('STALE_AFTER_MS');
    this.intervalMs = config.get('SWEEP_INTERVAL_MS');
  }

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.sweepOnce().catch((err) => this.logger.error(`sweep failed: ${String(err)}`));
    }, this.intervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass; skipped if the previous pass is still running. The staleness check runs in Lua. */
  async sweepOnce(): Promise<SweepResult> {
    const result: SweepResult = { swept: [], unassigned: [], skippedOnTrip: [] };
    if (this.running) return result;
    this.running = true;
    try {
      const now = this.clock();
      const ids = await this.store.listOnlineIds();
      const replies = await Promise.all(
        ids.map(async (id) => [id, await this.store.sweep(id, now, this.staleAfterMs)] as const),
      );
      const staleOnTrip: [string, string][] = [];
      for (const [id, r] of replies) {
        if (r.code === 'SWEPT') result.swept.push(id);
        else if (r.code === 'ON_TRIP' && r.state?.tripId && now - r.state.ts > this.staleAfterMs) {
          staleOnTrip.push([id, r.state.tripId]);
        }
      }
      // One failing driver must not block the others.
      await Promise.all(
        staleOnTrip.map(async ([id, tripId]) => {
          try {
            if ((await this.trips.unassign(tripId, 'driver_stale')) === 'CONFLICT') {
              result.skippedOnTrip.push(id);
              this.logger.warn(
                `stale driver ${id} left ON_TRIP: trip ${tripId} is already in progress (known limitation)`,
              );
              return;
            }
            const off = await this.store.offlineAfterUnassign(id, tripId, this.clock());
            if (off.code === 'OK') result.unassigned.push(id);
            else result.skippedOnTrip.push(id);
          } catch (err) {
            result.skippedOnTrip.push(id);
            this.logger.error(`stale ON_TRIP driver ${id}: ${String(err)}; retrying next sweep`);
          }
        }),
      );
      if (result.swept.length > 0)
        this.logger.log(`marked ${result.swept.length} stale driver(s) OFFLINE`);
      if (result.unassigned.length > 0) {
        this.logger.log(
          `unassigned and marked OFFLINE ${result.unassigned.length} stale ON_TRIP driver(s)`,
        );
      }
      return result;
    } finally {
      this.running = false;
    }
  }
}
