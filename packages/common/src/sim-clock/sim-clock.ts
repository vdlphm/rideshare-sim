import { Logger } from '@nestjs/common';
import { z } from 'zod';
import type { AuthMode, HttpClient } from '../http';

export const clockResponseSchema = z.object({
  simTime: z.number(),
  speed: z.number().min(0),
  paused: z.boolean(),
});
export type ClockState = z.infer<typeof clockResponseSchema>;

/** Pure: sim time (ms) after `realDeltaMs` of wall time. Frozen when paused. */
export function advanceSimTime(
  prev: number,
  realDeltaMs: number,
  speed: number,
  paused: boolean,
): number {
  if (paused) return prev;
  return prev + realDeltaMs * speed;
}

export interface SimClockOptions {
  /** Minimum real ms between fetches, default 1000. */
  refreshMs?: number;
  /** Real-time clock in ms, injectable for tests. */
  realNow?: () => number;
  /** Auth mode for the clock request, default 'service'. */
  auth?: AuthMode;
}

export class SimClock {
  private readonly logger = new Logger(SimClock.name);
  private readonly refreshMs: number;
  private readonly realNow: () => number;
  private readonly auth: AuthMode;
  private state?: ClockState;
  private fetchedAt = 0;
  private lastReturned = Number.NEGATIVE_INFINITY;
  private inflight?: Promise<void>;
  private lastAttempt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly http: Pick<HttpClient, 'get'>,
    opts: SimClockOptions = {},
  ) {
    this.refreshMs = opts.refreshMs ?? 1000;
    this.realNow = opts.realNow ?? Date.now;
    this.auth = opts.auth ?? 'service';
  }

  /** Extrapolated sim time (epoch ms). Never decreases. Throws if never synced. */
  now(): number {
    this.maybeRefresh();
    if (!this.state) throw new Error('SimClock not synced yet; call sync() first');
    const t = advanceSimTime(
      this.state.simTime,
      this.realNow() - this.fetchedAt,
      this.state.speed,
      this.state.paused,
    );
    this.lastReturned = Math.max(this.lastReturned, t);
    return this.lastReturned;
  }

  get speed(): number | undefined {
    return this.state?.speed;
  }

  get paused(): boolean | undefined {
    return this.state?.paused;
  }

  /** Fetches the clock now (bypassing the refresh interval) and resolves when done. */
  async sync(): Promise<void> {
    await this.refresh();
  }

  private maybeRefresh(): void {
    if (this.inflight || this.realNow() - this.lastAttempt < this.refreshMs) return;
    void this.refresh();
  }

  private refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.lastAttempt = this.realNow();
    this.inflight = this.http
      .get('/internal/clock', { auth: this.auth, schema: clockResponseSchema })
      .then((s) => {
        this.state = s;
        this.fetchedAt = this.realNow();
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `Simulator clock unreachable, extrapolating from last value: ${(err as Error).message}`,
        );
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }
}
