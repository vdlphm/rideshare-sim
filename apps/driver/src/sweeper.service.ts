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

export interface SweepResult {
  swept: string[];
  skippedOnTrip: string[];
}

/** Marks drivers with no recent location OFFLINE. ON_TRIP drivers are only logged (task 4.7). */
@Injectable()
export class StaleSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StaleSweeper.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly staleAfterMs: number;
  private readonly intervalMs: number;

  constructor(
    private readonly store: DriverStore,
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
    const result: SweepResult = { swept: [], skippedOnTrip: [] };
    if (this.running) return result;
    this.running = true;
    try {
      const now = this.clock();
      const ids = await this.store.listOnlineIds();
      const replies = await Promise.all(
        ids.map(async (id) => [id, await this.store.sweep(id, now, this.staleAfterMs)] as const),
      );
      for (const [id, r] of replies) {
        if (r.code === 'SWEPT') result.swept.push(id);
        else if (r.code === 'ON_TRIP' && r.state && now - r.state.ts > this.staleAfterMs) {
          result.skippedOnTrip.push(id);
        }
      }
      if (result.swept.length > 0)
        this.logger.log(`marked ${result.swept.length} stale driver(s) OFFLINE`);
      if (result.skippedOnTrip.length > 0) {
        this.logger.warn(
          `stale ON_TRIP driver(s) left untouched: ${result.skippedOnTrip.join(',')}`,
        );
      }
      return result;
    } finally {
      this.running = false;
    }
  }
}
