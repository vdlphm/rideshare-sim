import { Injectable } from '@nestjs/common';
import { InjectRedis, defineScript } from '@rideshare/common';
import type { Redis } from 'ioredis';
import { LockStore } from '../domain/ports';

const DECLINED_TTL_S = 3600;

/** Delete only if we still own the lock. KEYS[1] lock; ARGV[1] tripId. */
const RELEASE_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end
return 0`;

/** Extend our lock; re-take it if it lapsed and is free; never touch someone else's. */
const REFRESH_LUA = `
local cur = redis.call('get', KEYS[1])
if cur == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) end
if not cur then redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2]) return 1 end
return 0`;

const lockKey = (driverId: string) => `lock:driver:${driverId}`;
const declinedKey = (tripId: string) => `trip:${tripId}:declined`;

@Injectable()
export class RedisLockStore extends LockStore {
  private readonly releaseScript: ReturnType<typeof defineScript>;
  private readonly refreshScript: ReturnType<typeof defineScript>;

  constructor(@InjectRedis() private readonly redis: Redis) {
    super();
    this.releaseScript = defineScript(redis, 'releaseDriverLock', RELEASE_LUA, 1);
    this.refreshScript = defineScript(redis, 'refreshDriverLock', REFRESH_LUA, 1);
  }

  async acquire(driverId: string, tripId: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.set(lockKey(driverId), tripId, 'PX', ttlMs, 'NX')) === 'OK';
  }

  async release(driverId: string, tripId: string): Promise<void> {
    await this.releaseScript(lockKey(driverId), tripId);
  }

  async refresh(driverId: string, tripId: string, ttlMs: number): Promise<void> {
    await this.refreshScript(lockKey(driverId), tripId, ttlMs);
  }

  async addDeclined(tripId: string, driverId: string): Promise<void> {
    await this.redis
      .multi()
      .sadd(declinedKey(tripId), driverId)
      .expire(declinedKey(tripId), DECLINED_TTL_S)
      .exec();
  }

  async declined(tripId: string): Promise<Set<string>> {
    return new Set(await this.redis.smembers(declinedKey(tripId)));
  }
}
