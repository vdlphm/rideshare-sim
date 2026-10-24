import type { Job, Task } from './bot-env';

export interface SchedulerOptions {
  tickMs?: number;
  maxInFlight?: number;
  onError?: (err: unknown) => void;
}

/**
 * One loop for all bots. Each tick it asks every task whether work is due and runs the jobs through
 * a global in-flight cap. A task never has two jobs at once (per-bot guard). The start index
 * rotates each tick so a saturated limiter does not starve the same bots.
 */
export class Scheduler {
  private readonly tasks = new Set<Task>();
  private readonly busy = new Set<Task>();
  private readonly inflight = new Set<Promise<void>>();
  private timer?: NodeJS.Timeout;
  private readonly hooks: (() => void)[] = [];
  private offset = 0;
  private readonly tickMs: number;
  readonly maxInFlight: number;

  constructor(private readonly opts: SchedulerOptions = {}) {
    this.tickMs = opts.tickMs ?? 100;
    this.maxInFlight = opts.maxInFlight ?? 20;
  }

  add(task: Task): void {
    this.tasks.add(task);
  }

  remove(task: Task): void {
    this.tasks.delete(task);
  }

  get inFlight(): number {
    return this.inflight.size;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref();
  }

  /** Stops ticking and waits for in-flight jobs to settle. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.inflight]);
  }

  /** Runs synchronously at the start of every tick (e.g. fleet reconcile), regardless of load. */
  addHook(hook: () => void): void {
    this.hooks.push(hook);
  }

  tick(): void {
    for (const hook of this.hooks) {
      try {
        hook();
      } catch (err) {
        this.opts.onError?.(err);
      }
    }
    const list = [...this.tasks];
    if (list.length === 0) return;
    this.offset = (this.offset + 1) % list.length;
    for (let i = 0; i < list.length; i++) {
      const task = list[(i + this.offset) % list.length];
      if (this.busy.has(task) || !this.tasks.has(task)) continue;
      if (this.inflight.size >= this.maxInFlight) break;
      let job: Job | null;
      try {
        job = task.due();
      } catch (err) {
        this.opts.onError?.(err);
        continue;
      }
      if (!job) continue;
      this.busy.add(task);
      const p: Promise<void> = job()
        .catch((err) => this.opts.onError?.(err))
        .finally(() => {
          this.busy.delete(task);
          this.inflight.delete(p);
        });
      this.inflight.add(p);
    }
  }
}
