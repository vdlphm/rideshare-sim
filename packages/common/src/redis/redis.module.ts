import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import type { ReadinessCheck } from '../health';

export const REDIS = Symbol('REDIS');
export const REDIS_OPTIONS = Symbol('REDIS_OPTIONS');
export const REDIS_READINESS = Symbol('REDIS_READINESS');

export interface RedisOptions {
  url: string;
  /** Per-service key prefix, must end with ':' (e.g. 'trip:'). */
  keyPrefix: string;
}

export const InjectRedis = (): ParameterDecorator & PropertyDecorator => Inject(REDIS);

export function assertKeyPrefix(keyPrefix: string): void {
  if (!keyPrefix.endsWith(':') || keyPrefix.length < 2) {
    throw new Error(`Redis keyPrefix must be non-empty and end with ':' (got "${keyPrefix}")`);
  }
}

export function createRedis(opts: RedisOptions): Redis {
  assertKeyPrefix(opts.keyPrefix);
  return new Redis(opts.url, { keyPrefix: opts.keyPrefix });
}

/**
 * SCAN is not auto-prefixed by ioredis. Matches `pattern` within this client's prefix and
 * returns keys with the prefix stripped (so they can be passed straight back to commands).
 */
export async function scanKeys(redis: Redis, pattern: string, count = 100): Promise<string[]> {
  const prefix = redis.options.keyPrefix ?? '';
  const found = new Set<string>();
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}${pattern}`, 'COUNT', count);
    cursor = next;
    for (const k of keys) found.add(k.startsWith(prefix) ? k.slice(prefix.length) : k);
  } while (cursor !== '0');
  return [...found];
}

/**
 * Registers a Lua script as `redis[name](...keys, ...args)`. ioredis prefixes KEYS (not ARGV)
 * automatically. Call with `(redis as any)[name]` or via `runScript`.
 */
export function defineScript(
  redis: Redis,
  name: string,
  lua: string,
  numberOfKeys: number,
): (...args: (string | number)[]) => Promise<unknown> {
  redis.defineCommand(name, { numberOfKeys, lua });
  return (...args) =>
    (redis as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name](...args);
}

export function redisReadiness(redis: Redis): ReadinessCheck {
  return {
    name: 'redis',
    async check() {
      await redis.ping();
    },
  };
}

@Injectable()
export class RedisLifecycle implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status !== 'end') await this.redis.quit();
  }
}

@Module({})
export class RedisModule {
  static forRoot(opts: RedisOptions): DynamicModule {
    assertKeyPrefix(opts.keyPrefix);
    return {
      module: RedisModule,
      global: true,
      providers: [
        { provide: REDIS_OPTIONS, useValue: opts },
        { provide: REDIS, useFactory: () => createRedis(opts) },
        {
          provide: REDIS_READINESS,
          inject: [REDIS],
          useFactory: (r: Redis) => redisReadiness(r),
        },
        RedisLifecycle,
      ],
      exports: [REDIS, REDIS_READINESS],
    };
  }
}
