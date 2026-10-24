import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService, SimClock } from '@rideshare/common';
import type { LatLng } from '@rideshare/contracts';
import type { TripEnv } from '../config';
import { TripsRepository } from '../trips/trips.repository';
import { Upstreams } from './upstreams.service';

/** Real-time clock in ms (injectable for tests). */
export const REAL_NOW = Symbol('REAL_NOW');

const BATCH = 100;

/**
 * Sends trips to matching, and periodically re-sends REQUESTED trips that matching has not
 * picked up (it was down at creation, or lost them). `/internal/match` is idempotent per
 * tripId, so re-sending is safe.
 */
@Injectable()
export class MatchingDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MatchingDispatcher.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly lastDispatched = new Map<string, number>();
  private readonly intervalMs: number;
  private readonly retryAfterSimMs: number;

  constructor(
    private readonly repo: TripsRepository,
    private readonly upstreams: Upstreams,
    private readonly clock: SimClock,
    @Inject(REAL_NOW) private readonly realNow: () => number,
    config: ConfigService<TripEnv>,
  ) {
    this.intervalMs = config.get('DISPATCH_SWEEP_MS');
    this.retryAfterSimMs = config.get('DISPATCH_RETRY_AFTER_SIM_MS');
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

  /** Posts one match request; failures are logged (the sweep retries). */
  async dispatch(trip: { id: string; pickup: LatLng }): Promise<boolean> {
    const ok = await this.upstreams.requestMatch({ tripId: trip.id, pickup: trip.pickup });
    if (ok) this.lastDispatched.set(trip.id, this.realNow());
    return ok;
  }

  /** One pass; returns the ids re-dispatched. Skipped if the previous pass is still running. */
  async sweepOnce(): Promise<string[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const nowReal = this.realNow();
      for (const [id, at] of this.lastDispatched) {
        if (nowReal - at >= this.intervalMs) this.lastDispatched.delete(id);
      }
      const candidates = await this.repo.findDispatchable(
        this.clock.now() - this.retryAfterSimMs,
        BATCH,
      );
      const due = candidates.filter((t) => !this.lastDispatched.has(t.id));
      const results = await Promise.all(due.map((t) => this.dispatch(t)));
      const sent = due.filter((_, i) => results[i]).map((t) => t.id);
      if (sent.length > 0) this.logger.log(`re-dispatched ${sent.length} REQUESTED trip(s)`);
      return sent;
    } finally {
      this.running = false;
    }
  }
}
