import type { UserDisplay } from '@rideshare/contracts';
import { LiveModel } from './live-model';
import type { LiveUpstreams, TripsSince } from './upstreams';

export interface SessionLog {
  warn(message: string): void;
  debug(message: string): void;
}

export interface LiveSessionOptions {
  upstreams: LiveUpstreams;
  pollIntervalMs: number;
  statsIntervalMs: number;
  endedTripRetentionMs: number;
  userCacheTtlMs: number;
  /** Called after the initial load and after every tick (clients decide what to send). */
  onUpdate: () => void;
  log: SessionLog;
  /** Epoch milliseconds; injectable for tests. */
  now?: () => number;
}

const USER_BATCH = 500;
/** Back-off for user ids that failed to load or do not exist. */
const USER_RETRY_MS = 5000;
const WARN_EVERY_MS = 5000;

/**
 * One upstream call that may outlive the tick that started it. A slow upstream keeps its fetch
 * in flight (never started twice) while the others keep being applied tick after tick; its late
 * result is picked up by whichever tick comes next.
 */
class Fetcher<A extends unknown[], T> {
  private inflight?: Promise<void>;
  private result?: { value: T };

  constructor(
    private readonly name: string,
    private readonly run: (...args: A) => Promise<T>,
    private readonly failed: (name: string, err: unknown) => void,
  ) {}

  /** Starts a fetch unless one is in flight. The returned promise never rejects. */
  launch(...args: A): Promise<void> {
    this.inflight ??= (async () => this.run(...args))().then(
      (value) => {
        this.result = { value };
        this.inflight = undefined;
      },
      (err: unknown) => {
        this.failed(this.name, err);
        this.inflight = undefined;
      },
    );
    return this.inflight;
  }

  get busy(): boolean {
    return this.inflight !== undefined;
  }

  take(): T | undefined {
    const r = this.result;
    this.result = undefined;
    return r?.value;
  }
}

/** Resolves when `p` settles or after `ms`, whichever comes first (timer is always cleared). */
function within(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void p.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Polls the upstream services and keeps a `LiveModel` current. Runs from `start()` to `stop()`
 * (the gateway runs one only while an admin client is connected). Ticks are strictly sequential.
 */
export class LiveSession {
  readonly model: LiveModel;
  private readonly now: () => number;
  private stopped = false;
  private started = false;
  private timer?: NodeJS.Timeout;
  private wake?: () => void;
  private cursor: string | null = null;
  private lastStatsAt = 0;
  private readonly lastWarn = new Map<string, number>();

  private readonly drivers: Fetcher<[], Awaited<ReturnType<LiveUpstreams['drivers']>>>;
  private readonly riders: Fetcher<[], Awaited<ReturnType<LiveUpstreams['riders']>>>;
  private readonly sim: Fetcher<[], Awaited<ReturnType<LiveUpstreams['sim']>>>;
  private readonly stats: Fetcher<[], Awaited<ReturnType<LiveUpstreams['stats']>>>;
  private readonly trips: Fetcher<[string], TripsSince>;
  private readonly users: Fetcher<[string[]], { users: UserDisplay[]; unresolved: string[] }>;

  constructor(private readonly opts: LiveSessionOptions) {
    this.now = opts.now ?? Date.now;
    this.model = new LiveModel({
      endedTripRetentionMs: opts.endedTripRetentionMs,
      userCacheTtlMs: opts.userCacheTtlMs,
    });
    const up = opts.upstreams;
    const failed = (name: string, err: unknown) => this.warn(name, err);
    this.drivers = new Fetcher('drivers', () => up.drivers(), failed);
    this.riders = new Fetcher('riders', () => up.riders(), failed);
    this.sim = new Fetcher('sim', () => up.sim(), failed);
    this.stats = new Fetcher('stats', () => up.stats(), failed);
    this.trips = new Fetcher('trips', (c: string) => up.tripsSince(c), failed);
    this.users = new Fetcher('users', (ids: string[]) => this.fetchUsers(ids), failed);
  }

  get running(): boolean {
    return this.started && !this.stopped;
  }

  /** The trip cursor (for tests/diagnostics). */
  get tripCursor(): string | null {
    return this.cursor;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.wake?.();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const began = Date.now();
      try {
        if (this.model.ready) await this.tick();
        else await this.init();
      } catch (err) {
        this.warn('loop', err);
      }
      if (this.stopped) return;
      await this.sleep(Math.max(0, this.opts.pollIntervalMs - (Date.now() - began)));
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve;
      this.timer = setTimeout(resolve, ms);
    });
  }

  private warn(what: string, err: unknown): void {
    const now = Date.now();
    if (now - (this.lastWarn.get(what) ?? 0) < WARN_EVERY_MS) return;
    this.lastWarn.set(what, now);
    const msg = err instanceof Error ? err.message : String(err);
    this.opts.log.warn(`live ${what} update failed: ${msg}`);
  }

  /**
   * The first full fetch. Every part must succeed (a snapshot needs all of them); on failure the
   * loop simply tries again on its next iteration.
   */
  async init(): Promise<void> {
    const up = this.opts.upstreams;
    const now = this.now();
    // `x-server-time` is only returned for `updatedSince` queries, so take the cursor from a
    // query for "changes since now" (cheap and empty) BEFORE the full fetch: anything that
    // changes in between is re-delivered by the first tick (idempotent), never lost.
    const tripsInit = async () => {
      const probe = await up.tripsSince(new Date(now).toISOString());
      const full = await up.activeTrips();
      return { probe, full };
    };
    const [drivers, riders, sim, stats, trips] = await Promise.all([
      up.drivers(),
      up.riders(),
      up.sim(),
      up.stats(),
      tripsInit(),
    ]);
    if (this.stopped) return;
    this.cursor = trips.probe.serverTime ?? new Date(now - 2000).toISOString();
    if (!trips.probe.serverTime) this.warn('trips', new Error('missing x-server-time header'));
    this.model.applyDrivers(drivers);
    this.model.applyRiders(riders);
    this.model.applySim(sim);
    this.model.applyStats(stats);
    this.model.applyTripsFull(trips.full, now);
    this.lastStatsAt = now;
    await this.loadUsers(this.model.missingUserIds(now), true);
    if (this.stopped) return;
    this.model.discardDiff();
    this.model.ready = true;
    this.opts.onUpdate();
  }

  /** One poll: fetch in parallel, apply what arrived, build and publish one diff. */
  async tick(): Promise<void> {
    const { pollIntervalMs, statsIntervalMs } = this.opts;
    const launched = [
      this.drivers.launch(),
      this.riders.launch(),
      this.sim.launch(),
      this.trips.launch(this.cursor ?? new Date(this.now() - 2000).toISOString()),
    ];
    if (this.now() - this.lastStatsAt >= statsIntervalMs) {
      this.lastStatsAt = this.now();
      launched.push(this.stats.launch());
    }
    // Wait for everyone, but not longer than one poll interval: a slow upstream keeps its fetch
    // in flight and is applied by a later tick, without delaying the others.
    await within(Promise.all(launched), pollIntervalMs);
    if (this.stopped) return;

    const now = this.now();
    const m = this.model;
    const drivers = this.drivers.take();
    if (drivers) m.applyDrivers(drivers);
    const riders = this.riders.take();
    if (riders) m.applyRiders(riders);
    const sim = this.sim.take();
    if (sim) m.applySim(sim);
    const stats = this.stats.take();
    if (stats) m.applyStats(stats);
    const trips = this.trips.take();
    if (trips) {
      m.applyTrips(trips.trips, now);
      if (trips.serverTime) this.cursor = trips.serverTime;
      else this.warn('trips', new Error('missing x-server-time header'));
    }
    this.applyUsers(now);
    m.expire(now);

    // Display info for newly referenced users travels with the diff that introduces them,
    // unless the user service is slow (then it follows in a later diff).
    await this.loadUsers(m.missingUserIds(now), false);
    if (this.stopped) return;
    this.applyUsers(this.now());
    this.opts.onUpdate();
  }

  private applyUsers(now: number): void {
    const res = this.users.take();
    if (!res) return;
    this.model.addUsers(res.users, now);
    this.model.deferUsers(res.unresolved, now + USER_RETRY_MS);
  }

  private async loadUsers(ids: string[], initial: boolean): Promise<void> {
    if (ids.length === 0 || this.users.busy) return;
    const p = this.users.launch(ids);
    if (initial) await p;
    else await within(p, this.opts.pollIntervalMs);
    if (initial) this.applyUsers(this.now());
  }

  /** Chunked batch lookups, run in parallel; ids that did not come back are reported. */
  private async fetchUsers(ids: string[]): Promise<{ users: UserDisplay[]; unresolved: string[] }> {
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += USER_BATCH) chunks.push(ids.slice(i, i + USER_BATCH));
    const results = await Promise.allSettled(chunks.map((c) => this.opts.upstreams.users(c)));
    const users: UserDisplay[] = [];
    results.forEach((r) => {
      if (r.status === 'fulfilled') users.push(...r.value);
    });
    const got = new Set(users.map((u) => u.id));
    const failure = results.find((r) => r.status === 'rejected');
    if (failure) this.warn('users', (failure as PromiseRejectedResult).reason);
    return { users, unresolved: ids.filter((id) => !got.has(id)) };
  }
}
