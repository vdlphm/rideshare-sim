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
import { MAX_ACTIVE_BATCH, TripGateway } from './trip.gateway';

export interface ReconcileResult {
  checked: number;
  /** ON_TRIP with no active trip -> AVAILABLE. */
  released: string[];
  /** Not ON_TRIP but has an active trip -> ON_TRIP. */
  assigned: string[];
  /** ON_TRIP with another tripId than the active trip -> tripId fixed. */
  retargeted: string[];
  /** The trip service could not be reached; nothing was changed this round. */
  skipped: boolean;
}

/** Repairs lost driver<->trip status updates by comparing Redis state with trip's active trips. */
@Injectable()
export class ReconcileJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconcileJob.name);
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
    this.intervalMs = config.get('RECONCILE_INTERVAL_MS');
  }

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.reconcileOnce().catch((err) =>
        this.logger.error(`reconcile failed: ${String(err)}`),
      );
    }, this.intervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async reconcileOnce(): Promise<ReconcileResult> {
    const result: ReconcileResult = {
      checked: 0,
      released: [],
      assigned: [],
      retargeted: [],
      skipped: false,
    };
    if (this.running) return result;
    this.running = true;
    try {
      const ids = await this.store.listOnlineIds();
      for (let i = 0; i < ids.length; i += MAX_ACTIVE_BATCH) {
        const batch = ids.slice(i, i + MAX_ACTIVE_BATCH);
        let active;
        try {
          active = await this.trips.activeTrips(batch);
        } catch (err) {
          this.logger.warn(`trip service unreachable, skipping reconcile round: ${String(err)}`);
          result.skipped = true;
          return result;
        }
        // Read states after the trips so a driver assigned in between is not "fixed" backwards.
        const states = await this.store.getMany(batch);
        const byDriver = new Map(active.map((t) => [t.driverId, t.id]));
        for (const s of states) {
          result.checked++;
          const tripId = byDriver.get(s.driverId);
          try {
            if (s.status === 'ON_TRIP' && !tripId) {
              await this.store.setStatus(
                s.driverId,
                'AVAILABLE',
                null,
                this.clock(),
                this.staleAfterMs,
              );
              result.released.push(s.driverId);
              this.logger.warn(
                `driver ${s.driverId} ON_TRIP without active trip ${s.tripId} -> AVAILABLE`,
              );
            } else if (s.status !== 'ON_TRIP' && tripId) {
              await this.store.setStatus(
                s.driverId,
                'ON_TRIP',
                tripId,
                this.clock(),
                this.staleAfterMs,
              );
              result.assigned.push(s.driverId);
              this.logger.warn(
                `driver ${s.driverId} ${s.status} with active trip ${tripId} -> ON_TRIP`,
              );
            } else if (s.status === 'ON_TRIP' && tripId && s.tripId !== tripId) {
              await this.store.setStatus(
                s.driverId,
                'ON_TRIP',
                tripId,
                this.clock(),
                this.staleAfterMs,
              );
              result.retargeted.push(s.driverId);
              this.logger.warn(`driver ${s.driverId} tripId ${s.tripId} -> ${tripId}`);
            }
          } catch (err) {
            this.logger.error(`reconcile of driver ${s.driverId} failed: ${String(err)}`);
          }
        }
      }
      return result;
    } finally {
      this.running = false;
    }
  }
}
