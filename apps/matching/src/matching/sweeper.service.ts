import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@rideshare/common';
import type { MatchingEnv } from '../config';
import { MatchingEngine } from '../domain/matching.engine';

/**
 * Drives the engine's sweep every SWEEP_INTERVAL_MS (real ms). The first pass runs at boot,
 * which resumes ACTIVE jobs that were in flight when the previous instance stopped.
 */
@Injectable()
export class MatchingSweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MatchingSweeper.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private inflight: Promise<void> | undefined;
  private readonly intervalMs: number;

  constructor(
    private readonly engine: MatchingEngine,
    @Inject(ConfigService) config: ConfigService<MatchingEnv>,
  ) {
    this.intervalMs = config.get('SWEEP_INTERVAL_MS');
  }

  onApplicationBootstrap(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  /** Stops the timer and lets in-flight work finish before the DB/Redis connections close. */
  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.inflight;
    await this.engine.idle();
  }

  /** One pass; skipped while the previous one is still running. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.inflight = this.engine
      .sweep()
      .then(() => undefined)
      .catch((err: unknown) => this.logger.error(`sweep failed: ${String(err)}`))
      .finally(() => {
        this.running = false;
      });
    await this.inflight;
  }
}
