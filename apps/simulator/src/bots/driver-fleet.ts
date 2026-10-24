import type { DriverApi } from './bot-client';
import type { BotEnv, Snapper } from './bot-env';
import { DriverBot, type DriverBotOptions } from './driver-bot';
import type { Scheduler } from './scheduler';

export interface DriverCounts {
  total: number;
  idle: number;
  toPickup: number;
  atPickup: number;
  inTrip: number;
}

export interface DriverFleetDeps {
  scheduler: Scheduler;
  env: BotEnv;
  snapper: Snapper;
  /** Builds the API client for driver number `n` (1-based). */
  makeApi: (n: number) => DriverApi;
  botOptions?: DriverBotOptions;
}

/**
 * Keeps the number of driver bots at the target. Growing spawns bots at the lowest free numbers;
 * shrinking only retires IDLE bots (they go offline and stop), and keeps trying on every
 * reconcile until the count matches. A bot that is mid-trip is never touched.
 */
export class DriverFleet {
  private readonly bots = new Map<number, DriverBot>();
  private target = 0;

  constructor(private readonly deps: DriverFleetDeps) {
    deps.scheduler.addHook(() => this.reconcile());
  }

  setTarget(n: number): void {
    this.target = Math.max(0, Math.floor(n));
    this.reconcile();
  }

  get size(): number {
    return this.bots.size;
  }

  /** Drops stopped bots, then spawns or retires toward the target. Idempotent and cheap. */
  reconcile(): void {
    for (const [n, bot] of this.bots) {
      if (bot.phase === 'STOPPED') {
        this.deps.scheduler.remove(bot);
        this.bots.delete(n);
      }
    }
    const staying = [...this.bots.values()].filter((b) => !b.retiring);
    let delta = this.target - staying.length;
    if (delta > 0) {
      // Prefer un-retiring bots that have not gone offline yet over creating new accounts.
      for (const bot of this.bots.values()) {
        if (delta <= 0) break;
        if (bot.retiring) {
          bot.cancelRetire();
          delta--;
        }
      }
      for (let n = 1; delta > 0; n++) {
        if (this.bots.has(n)) continue;
        this.spawn(n);
        delta--;
      }
    } else if (delta < 0) {
      const idle = [...this.bots.entries()]
        .filter(([, b]) => !b.retiring && b.phase === 'IDLE')
        .sort(([a], [b]) => b - a);
      for (const [, bot] of idle) {
        if (delta >= 0) break;
        bot.retire();
        delta++;
      }
    }
  }

  private spawn(n: number): void {
    const bot = new DriverBot(
      n,
      this.deps.makeApi(n),
      this.deps.env,
      this.deps.snapper,
      this.deps.botOptions,
    );
    this.bots.set(n, bot);
    this.deps.scheduler.add(bot);
  }

  counts(): DriverCounts {
    const c: DriverCounts = { total: 0, idle: 0, toPickup: 0, atPickup: 0, inTrip: 0 };
    for (const bot of this.bots.values()) {
      c.total++;
      switch (bot.phase) {
        case 'IDLE':
        case 'OFFERED':
          c.idle++;
          break;
        case 'TO_PICKUP':
          c.toPickup++;
          break;
        case 'AT_PICKUP':
          c.atPickup++;
          break;
        case 'IN_TRIP':
          c.inTrip++;
          break;
      }
    }
    return c;
  }

  /** Best-effort: take idle drivers offline, bounded by `timeoutMs`. */
  async shutdown(timeoutMs = 3000): Promise<void> {
    const offline = Promise.allSettled([...this.bots.values()].map((b) => b.goOfflineNow()));
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([offline, timeout]);
    clearTimeout(timer);
  }
}
