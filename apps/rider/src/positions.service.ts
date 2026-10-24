import { Inject, Injectable } from '@nestjs/common';
import { ConfigService, InjectRedis } from '@rideshare/common';
import type { LatLng, RiderPosition } from '@rideshare/contracts';
import type { Redis } from 'ioredis';
import type { RiderEnv } from './config';
import { POSITION_INDEX_KEY, positionKey, pruneCutoff, toPosition } from './positions';

export const CLOCK = Symbol('CLOCK');
export type Clock = () => number;

@Injectable()
export class RiderPositionsService {
  private readonly ttlS: number;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    @Inject(CLOCK) private readonly now: Clock,
    config: ConfigService<RiderEnv>,
  ) {
    this.ttlS = config.get('POSITION_TTL_S');
  }

  /** Atomically stores the position hash (with TTL) and its index entry. */
  async set(riderId: string, { lat, lng }: LatLng): Promise<void> {
    const ts = this.now();
    const res = await this.redis
      .multi()
      .hset(positionKey(riderId), { lat: String(lat), lng: String(lng), ts: String(ts) })
      .expire(positionKey(riderId), this.ttlS)
      .zadd(POSITION_INDEX_KEY, String(ts), riderId)
      .exec();
    for (const [err] of res ?? []) if (err) throw err;
  }

  /** The rider's current position, or null if none / expired. */
  async get(riderId: string): Promise<RiderPosition | null> {
    return toPosition(riderId, await this.redis.hgetall(positionKey(riderId)));
  }

  /** All riders with a non-expired position; prunes stale and dangling index members. */
  async listActive(): Promise<RiderPosition[]> {
    const cutoff = pruneCutoff(this.now(), this.ttlS);
    await this.redis.zremrangebyscore(POSITION_INDEX_KEY, '-inf', `(${cutoff}`);
    const ids = await this.redis.zrange(POSITION_INDEX_KEY, '0', '-1');
    if (ids.length === 0) return [];
    const replies = await this.redis.pipeline(ids.map((id) => ['hgetall', positionKey(id)])).exec();
    const out: RiderPosition[] = [];
    const dangling: string[] = [];
    ids.forEach((id, i) => {
      const [err, hash] = replies?.[i] ?? [new Error('missing reply'), null];
      if (err) throw err;
      const pos = toPosition(id, hash as Record<string, string>);
      if (pos) out.push(pos);
      else dangling.push(id);
    });
    if (dangling.length > 0) await this.redis.zrem(POSITION_INDEX_KEY, ...dangling);
    return out;
  }
}
