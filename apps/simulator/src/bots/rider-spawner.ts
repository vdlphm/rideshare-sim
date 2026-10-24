import type { LatLng } from '@rideshare/contracts';
import { SEATTLE_SPAWN_BBOX, haversineM, randomPointInBbox } from '@rideshare/geo';
import type { RiderApi } from './bot-client';
import { isRunning, type BotEnv, type Job, type Snapper, type Task } from './bot-env';
import { RiderBot, type RideOutcome, type RiderDoneReason } from './rider-bot';
import type { Scheduler } from './scheduler';

export const MIN_TRIP_M = 500;
export const SPAWN_JITTER = 0.3;
export const MAX_POINT_ATTEMPTS = 5;
const CONFLICT_RETRIES = 3;

/** Pickup/dropoff at least MIN_TRIP_M apart, both snapped to roads; null after 5 failed tries. */
export async function pickRidePoints(
  env: BotEnv,
  snapper: Snapper,
): Promise<{ pickup: LatLng; dropoff: LatLng } | null> {
  for (let i = 0; i < MAX_POINT_ATTEMPTS; i++) {
    const a = randomPointInBbox(SEATTLE_SPAWN_BBOX, env.rng);
    const b = randomPointInBbox(SEATTLE_SPAWN_BBOX, env.rng);
    if (haversineM(a, b) < MIN_TRIP_M) continue;
    const [pickup, dropoff] = await Promise.all([
      snapper.snap(a).catch(() => null),
      snapper.snap(b).catch(() => null),
    ]);
    if (!pickup || !dropoff) continue; // 422: not near a road, draw new points
    if (haversineM(pickup, dropoff) < MIN_TRIP_M) continue;
    return { pickup, dropoff };
  }
  return null;
}

/** Rider accounts 1..size, reused after a bot finishes; parked ones are never handed out again. */
export class AccountPool {
  private readonly used = new Set<number>();
  private readonly parked = new Set<number>();
  constructor(readonly size: number) {}

  acquire(): number | null {
    for (let n = 1; n <= this.size; n++) {
      if (!this.used.has(n) && !this.parked.has(n)) {
        this.used.add(n);
        return n;
      }
    }
    return null;
  }
  release(n: number): void {
    this.used.delete(n);
  }
  park(n: number): void {
    this.used.delete(n);
    this.parked.add(n);
  }
  get parkedCount(): number {
    return this.parked.size;
  }
}

export type AddRiderResult = RideOutcome | { kind: 'noAccount' };

export interface RiderSpawnerDeps {
  scheduler: Scheduler;
  env: BotEnv;
  snapper: Snapper;
  makeApi: (n: number) => RiderApi;
  maxActive: number;
  poolSize?: number;
  log?: (msg: string) => void;
}

export interface RiderCounts {
  active: number;
  waiting: number;
  riding: number;
}

/** Spawns rider bots every spawnIntervalS sim-seconds (+-30%), and on demand for click-to-add. */
export class RiderSpawner implements Task {
  private readonly bots = new Set<RiderBot>();
  private readonly pool: AccountPool;
  private readonly apis = new Map<number, RiderApi>();
  private lastSpawnSim?: number;
  private jitter: number;

  constructor(private readonly deps: RiderSpawnerDeps) {
    this.pool = new AccountPool(deps.poolSize ?? deps.maxActive * 2 + 20);
    this.jitter = this.newJitter();
    deps.scheduler.add(this);
  }

  private newJitter(): number {
    return 1 + SPAWN_JITTER * (this.deps.env.rng() * 2 - 1);
  }

  /** Next spawn = last spawn + current interval * jitter, so interval changes apply immediately. */
  due(): Job | null {
    const { env } = this.deps;
    if (!isRunning(env)) return null;
    const sim = env.simNow();
    this.lastSpawnSim ??= sim;
    const next = this.lastSpawnSim + env.config().spawnIntervalS * 1000 * this.jitter;
    if (sim < next || this.bots.size >= this.deps.maxActive) return null;
    this.lastSpawnSim = sim;
    this.jitter = this.newJitter();
    return () => this.spawnRandom();
  }

  private async spawnRandom(): Promise<void> {
    const points = await pickRidePoints(this.deps.env, this.deps.snapper);
    if (!points) {
      this.deps.log?.('rider spawn skipped: no routable points');
      return;
    }
    // Fire and forget; the bot runs on the scheduler from here.
    void this.launchWithRetry(points.pickup, points.dropoff, false).then((out) => {
      if (out.kind !== 'ok') this.deps.log?.(`rider spawn failed: ${out.kind}`);
    });
  }

  /** Click-to-add: a rider for exactly these points (trip snaps them). */
  addRider(pickup: LatLng, dropoff: LatLng): Promise<AddRiderResult> {
    return this.launchWithRetry(pickup, dropoff, true);
  }

  private async launchWithRetry(
    pickup: LatLng,
    dropoff: LatLng,
    explicitPickup: boolean,
  ): Promise<AddRiderResult> {
    let out: AddRiderResult = { kind: 'conflict' };
    for (let i = 0; i < CONFLICT_RETRIES; i++) {
      out = await this.launch(pickup, dropoff, explicitPickup);
      if (out.kind !== 'conflict') return out;
    }
    return out;
  }

  private launch(
    pickup: LatLng,
    dropoff: LatLng,
    explicitPickup: boolean,
  ): Promise<AddRiderResult> {
    const n = this.pool.acquire();
    if (n === null) return Promise.resolve({ kind: 'noAccount' });
    let api = this.apis.get(n);
    if (!api) {
      api = this.deps.makeApi(n);
      this.apis.set(n, api);
    }
    return new Promise<AddRiderResult>((resolve) => {
      const bot: RiderBot = new RiderBot(n, api, this.deps.env, {
        pickup,
        dropoff,
        explicitPickup,
        onRequest: resolve,
        onDone: (reason: RiderDoneReason) => {
          this.bots.delete(bot);
          this.deps.scheduler.remove(bot);
          // A leftover active trip (409) or a stuck one (timeout) poisons the account: park it.
          if (reason === 'conflict' || reason === 'timeout') this.pool.park(n);
          else this.pool.release(n);
        },
      });
      this.bots.add(bot);
      this.deps.scheduler.add(bot);
    });
  }

  counts(): RiderCounts {
    let riding = 0;
    for (const b of this.bots) if (b.riding) riding++;
    return { active: this.bots.size, waiting: this.bots.size - riding, riding };
  }

  get parkedAccounts(): number {
    return this.pool.parkedCount;
  }
}
