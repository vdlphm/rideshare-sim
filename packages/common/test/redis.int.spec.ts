import { Test } from '@nestjs/testing';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  REDIS,
  REDIS_READINESS,
  RedisModule,
  defineScript,
  scanKeys,
  type ReadinessCheck,
} from '../src';

let container: StartedRedisContainer;
let raw: Redis;
let redis: Redis;
let app: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>;

beforeAll(async () => {
  container = await new RedisContainer('redis:7.4').start();
  const url = container.getConnectionUrl();
  raw = new Redis(url);
  app = await Test.createTestingModule({
    imports: [RedisModule.forRoot({ url, keyPrefix: 'trip:' })],
  }).compile();
  await app.init();
  redis = app.get(REDIS);
}, 120_000);

afterAll(async () => {
  await app.close();
  await raw.quit();
  await container.stop();
});

describe('RedisModule', () => {
  it('prefixes SET/HSET/GEOADD/GEOSEARCH', async () => {
    await redis.set('driver:state:1', 'x');
    await redis.hset('driver:h:1', 'a', '1');
    await redis.geoadd('driver:geo:available', 106.7, 10.77, 'd1');
    expect(await raw.get('trip:driver:state:1')).toBe('x');
    expect(await raw.hget('trip:driver:h:1', 'a')).toBe('1');
    expect(await raw.zcard('trip:driver:geo:available')).toBe(1);
    const found = await redis.geosearch(
      'driver:geo:available',
      'FROMLONLAT',
      106.7,
      10.77,
      'BYRADIUS',
      1,
      'km',
    );
    expect(found).toEqual(['d1']);
  });

  it('prefixes Lua KEYS but not ARGV', async () => {
    const run = defineScript(
      redis,
      'setIfAbsent',
      `return redis.call('SETNX', KEYS[1], ARGV[1])`,
      1,
    );
    expect(await run('lock:1', 'v')).toBe(1);
    expect(await run('lock:1', 'v2')).toBe(0);
    expect(await raw.get('trip:lock:1')).toBe('v');
  });

  it('scanKeys returns only own-prefix keys, unprefixed', async () => {
    await raw.set('other:driver:state:9', 'y');
    const keys = await scanKeys(redis, 'driver:state:*');
    expect(keys).toEqual(['driver:state:1']);
    expect(await redis.get(keys[0])).toBe('x');
  });

  it('readiness check passes', async () => {
    const check = app.get<ReadinessCheck>(REDIS_READINESS);
    expect(check.name).toBe('redis');
    await expect(check.check()).resolves.toBeUndefined();
  });
});
