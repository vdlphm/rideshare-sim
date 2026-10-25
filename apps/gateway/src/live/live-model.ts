import type {
  BotsSummary,
  ClockState,
  DriverState,
  RiderPosition,
  SimConfig,
  Trip,
  TripStats,
  UserDisplay,
  WsDiff,
  WsSnapshot,
} from '@rideshare/contracts';

export interface SimState {
  clock: ClockState;
  config: SimConfig;
  bots: BotsSummary;
}

/** Collection diff as sent on the wire. */
export interface CollectionDiff<T> {
  upsert: T[];
  remove: string[];
}

/** Everything in a diff that does not depend on the receiving client (users are per client). */
export type BaseDiff = Omit<WsDiff, 'type' | 'at' | 'users'>;

/**
 * A keyed set that records what changed since the last `drain()`. Items are compared by their
 * JSON form, so "unchanged" means byte-identical (a driver's `ts` moving counts as a change).
 */
class Tracked<T> {
  private readonly items = new Map<string, { item: T; key: string }>();
  private readonly upserts = new Map<string, T>();
  private readonly removes = new Set<string>();

  get size(): number {
    return this.items.size;
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  values(): T[] {
    return [...this.items.values()].map((e) => e.item);
  }

  ids(): IterableIterator<string> {
    return this.items.keys();
  }

  set(id: string, item: T): boolean {
    const key = JSON.stringify(item);
    if (this.items.get(id)?.key === key) return false;
    this.items.set(id, { item, key });
    this.upserts.set(id, item);
    this.removes.delete(id);
    return true;
  }

  delete(id: string): boolean {
    if (!this.items.delete(id)) return false;
    this.upserts.delete(id);
    this.removes.add(id);
    return true;
  }

  /** Makes the collection exactly `list` (upserting changes, removing what disappeared). */
  replace(list: readonly T[], idOf: (t: T) => string): void {
    const seen = new Set<string>();
    for (const item of list) {
      const id = idOf(item);
      seen.add(id);
      this.set(id, item);
    }
    for (const id of [...this.items.keys()]) if (!seen.has(id)) this.delete(id);
  }

  drain(): CollectionDiff<T> {
    const out = { upsert: [...this.upserts.values()], remove: [...this.removes] };
    this.upserts.clear();
    this.removes.clear();
    return out;
  }
}

/** A single value that records a change. */
class Slot<T> {
  value?: T;
  private key?: string;
  private changed = false;

  set(value: T): void {
    const key = JSON.stringify(value);
    if (key === this.key) return;
    this.key = key;
    this.value = value;
    this.changed = true;
  }

  drain(): T | undefined {
    if (!this.changed) return undefined;
    this.changed = false;
    return this.value;
  }
}

const isTerminal = (t: Trip): boolean => t.status === 'COMPLETED' || t.status === 'NO_DRIVERS';

/** How long the id of a removed ended trip is remembered, so a late re-delivery cannot revive it. */
const TOMBSTONE_MS = 60_000;

export interface LiveModelOptions {
  endedTripRetentionMs: number;
  userCacheTtlMs: number;
}

/**
 * The gateway's picture of the world, built from upstream polls. Pure and synchronous: callers
 * feed it data and ask for the diff since the previous `takeDiff()`.
 */
export class LiveModel {
  /** True once the first full fetch has been applied. */
  ready = false;

  private readonly drivers = new Tracked<DriverState>();
  private readonly riders = new Tracked<RiderPosition>();
  private readonly trips = new Tracked<Trip>();
  private readonly clock = new Slot<ClockState>();
  private readonly config = new Slot<SimConfig>();
  private readonly bots = new Slot<BotsSummary>();
  private readonly stats = new Slot<TripStats>();
  /** Ended trips: id -> gateway time (ms) at which we first saw them ended. */
  private readonly endedAt = new Map<string, number>();
  private readonly tombstones = new Map<string, number>();
  private readonly users = new Map<string, { user: UserDisplay; at: number }>();
  /** User id -> time (ms) before which it is not fetched again (failed or unknown). */
  private readonly userRetryAt = new Map<string, number>();

  constructor(private readonly opts: LiveModelOptions) {}

  applyDrivers(list: readonly DriverState[]): void {
    this.drivers.replace(list, (d) => d.driverId);
  }

  applyRiders(list: readonly RiderPosition[]): void {
    this.riders.replace(list, (r) => r.riderId);
  }

  applySim(sim: SimState): void {
    this.clock.set(sim.clock);
    this.config.set(sim.config);
    this.bots.set(sim.bots);
  }

  applyStats(stats: TripStats): void {
    this.stats.set(stats);
  }

  /** Full set of non-terminal trips (initial fetch). */
  applyTripsFull(list: readonly Trip[], now: number): void {
    this.applyTrips(list, now);
  }

  /**
   * Trips changed since the cursor (including just-ended ones). Terminal trips are upserted once
   * and kept until the retention elapses (see `expire`).
   */
  applyTrips(list: readonly Trip[], now: number): void {
    for (const t of list) {
      if (this.tombstones.has(t.id)) continue;
      this.trips.set(t.id, t);
      if (isTerminal(t)) {
        if (!this.endedAt.has(t.id)) this.endedAt.set(t.id, now);
      } else {
        this.endedAt.delete(t.id);
      }
    }
  }

  /** Removes ended trips past retention and evicts stale unreferenced display info. */
  expire(now: number): void {
    for (const [id, at] of this.endedAt) {
      if (now - at < this.opts.endedTripRetentionMs) continue;
      this.endedAt.delete(id);
      this.trips.delete(id);
      this.tombstones.set(id, now + TOMBSTONE_MS);
    }
    for (const [id, until] of this.tombstones) if (until <= now) this.tombstones.delete(id);
    const referenced = this.referencedIds();
    for (const [id, e] of this.users) {
      if (!referenced.has(id) && now - e.at >= this.opts.userCacheTtlMs) this.users.delete(id);
    }
    for (const [id, until] of this.userRetryAt) if (until <= now) this.userRetryAt.delete(id);
  }

  /** Drivers, riders and trip participants: the users a client may need to render. */
  referencedIds(): Set<string> {
    const ids = new Set<string>(this.drivers.ids());
    for (const id of this.riders.ids()) ids.add(id);
    for (const t of this.trips.values()) {
      ids.add(t.riderId);
      if (t.driverId) ids.add(t.driverId);
    }
    return ids;
  }

  /** Referenced ids with no cached display info that are not in a retry back-off. */
  missingUserIds(now: number): string[] {
    const out: string[] = [];
    for (const id of this.referencedIds()) {
      if (this.users.has(id)) continue;
      if ((this.userRetryAt.get(id) ?? 0) > now) continue;
      out.push(id);
    }
    return out;
  }

  addUsers(list: readonly UserDisplay[], now: number): void {
    for (const user of list) {
      this.users.set(user.id, { user, at: now });
      this.userRetryAt.delete(user.id);
    }
  }

  /** Back off fetching these ids until `until` (they failed to load or do not exist). */
  deferUsers(ids: readonly string[], until: number): void {
    for (const id of ids) this.userRetryAt.set(id, until);
  }

  /**
   * Cached display info for referenced users that `sent` does not contain yet. Does not mutate
   * `sent`; the caller records what it actually delivered.
   */
  usersNotIn(sent: ReadonlySet<string>): UserDisplay[] {
    const out: UserDisplay[] = [];
    for (const id of this.referencedIds()) {
      const e = this.users.get(id);
      if (e && !sent.has(id)) out.push(e.user);
    }
    return out;
  }

  /** The changes since the previous call, or null when nothing changed. */
  takeDiff(): BaseDiff | null {
    const drivers = this.drivers.drain();
    const riders = this.riders.drain();
    const trips = this.trips.drain();
    const clock = this.clock.drain();
    const config = this.config.drain();
    const bots = this.bots.drain();
    const stats = this.stats.drain();
    const empty = (c: CollectionDiff<unknown>) => c.upsert.length === 0 && c.remove.length === 0;
    if (empty(drivers) && empty(riders) && empty(trips) && !clock && !config && !bots && !stats) {
      return null;
    }
    return {
      ...(clock && { clock }),
      ...(config && { config }),
      ...(bots && { bots }),
      ...(stats && { stats }),
      drivers,
      riders,
      trips,
    };
  }

  /** Forgets accumulated changes (used after the initial load, which is delivered as a snapshot). */
  discardDiff(): void {
    this.takeDiff();
  }

  snapshot(at: number, sent: ReadonlySet<string> = new Set()): WsSnapshot {
    return {
      type: 'snapshot',
      at,
      clock: this.clock.value!,
      config: this.config.value!,
      bots: this.bots.value!,
      stats: this.stats.value!,
      drivers: this.drivers.values(),
      riders: this.riders.values(),
      trips: this.trips.values(),
      users: this.usersNotIn(sent),
    };
  }

  counts(): { drivers: number; riders: number; trips: number; users: number } {
    return {
      drivers: this.drivers.size,
      riders: this.riders.size,
      trips: this.trips.size,
      users: this.users.size,
    };
  }
}
