import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  DatabaseLifecycle,
  DatabaseModule,
  PG_POOL,
  RedisLifecycle,
  RedisModule,
  REDIS,
  InjectRedis,
  SimClock,
  SimClockModule,
  TOKEN_PROVIDER,
  createPool,
  createRedis,
  defineScript,
  postgresReadiness,
  redisReadiness,
  scanKeys,
  runMigrations,
  type Db,
} from '../src';
import type { Redis } from 'ioredis';

function fakeRedis(pages: [string, string[]][], prefix = 'p:') {
  const scan = vi.fn();
  for (const p of pages) scan.mockResolvedValueOnce(p);
  return {
    options: { keyPrefix: prefix },
    scan,
    defineCommand: vi.fn(),
    ping: vi.fn().mockResolvedValue('PONG'),
    quit: vi.fn().mockResolvedValue('OK'),
    status: 'ready',
    myScript: vi.fn().mockResolvedValue(7),
  };
}

describe('redis helpers', () => {
  it('scanKeys prefixes the pattern, follows the cursor, strips and dedupes', async () => {
    const r = fakeRedis([
      ['5', ['p:a:1', 'p:a:2']],
      ['0', ['p:a:2', 'other']],
    ]);
    const keys = await scanKeys(r as unknown as Redis, 'a:*');
    expect(keys).toEqual(['a:1', 'a:2', 'other']);
    expect(r.scan).toHaveBeenNthCalledWith(1, '0', 'MATCH', 'p:a:*', 'COUNT', 100);
    expect(r.scan).toHaveBeenNthCalledWith(2, '5', 'MATCH', 'p:a:*', 'COUNT', 100);
  });

  it('scanKeys works without a prefix', async () => {
    const r = fakeRedis([['0', ['x']]]);
    (r.options as { keyPrefix?: string }).keyPrefix = undefined;
    expect(await scanKeys(r as unknown as Redis, '*')).toEqual(['x']);
  });

  it('defineScript registers a command and invokes it', async () => {
    const r = fakeRedis([]);
    const run = defineScript(r as unknown as Redis, 'myScript', 'return 1', 2);
    expect(r.defineCommand).toHaveBeenCalledWith('myScript', { numberOfKeys: 2, lua: 'return 1' });
    expect(await run('k1', 'k2', 'arg')).toBe(7);
    expect(r.myScript).toHaveBeenCalledWith('k1', 'k2', 'arg');
  });

  it('readiness pings, lifecycle quits once', async () => {
    const r = fakeRedis([]);
    await redisReadiness(r as unknown as Redis).check();
    expect(r.ping).toHaveBeenCalled();
    const life = new RedisLifecycle(r as unknown as Redis);
    await life.onApplicationShutdown();
    expect(r.quit).toHaveBeenCalledTimes(1);
    r.status = 'end';
    await life.onApplicationShutdown();
    expect(r.quit).toHaveBeenCalledTimes(1);
  });

  it('createRedis builds a prefixed client', () => {
    const r = createRedis({ url: 'redis://127.0.0.1:1', keyPrefix: 'x:' });
    r.on('error', () => undefined);
    expect(r.options.keyPrefix).toBe('x:');
    r.disconnect();
  });
});

describe('RedisModule', () => {
  it('forRoot wires a prefixed client and closes it', async () => {
    const mod = await Test.createTestingModule({
      imports: [RedisModule.forRoot({ url: 'redis://127.0.0.1:1', keyPrefix: 'svc:' })],
    }).compile();
    const r = mod.get<Redis>(REDIS);
    r.on('error', () => undefined);
    expect(r.options.keyPrefix).toBe('svc:');
    expect(typeof InjectRedis()).toBe('function');
    await mod.close();
    r.disconnect();
  });
});

describe('database helpers', () => {
  it('createPool sets search_path and validates schema', async () => {
    const pool = createPool({ url: 'postgres://u:p@127.0.0.1:1/db', schema: 'trip' });
    expect((pool.options as { options?: string }).options).toBe('-c search_path=trip');
    await pool.end();
    expect(() => createPool({ url: 'postgres://x', schema: 'bad-name' })).toThrow();
  });

  it('postgresReadiness runs SELECT 1', async () => {
    const query = vi.fn().mockResolvedValue({});
    await postgresReadiness({ query } as unknown as Pool).check();
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });

  it('lifecycle skips migrations without a folder and ends the pool on shutdown', async () => {
    const end = vi.fn().mockResolvedValue(undefined);
    const life = new DatabaseLifecycle({ end } as unknown as Pool, {} as Db, {
      url: 'x',
      schema: 'trip',
    });
    await life.onModuleInit();
    await life.onApplicationShutdown();
    expect(end).toHaveBeenCalled();
  });

  it('lifecycle runs migrations when a folder is given', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const db = { transaction: (fn: (tx: unknown) => Promise<void>) => fn({ execute }) } as Db;
    const life = new DatabaseLifecycle({} as Pool, db, {
      url: 'x',
      schema: 'trip',
      migrationsFolder: `${__dirname}/fixtures/migrations`,
    });
    await life.onModuleInit();
    // lock, create journal, select last, create widgets, insert journal row
    expect(execute).toHaveBeenCalledTimes(5);
  });

  it('runMigrations skips already-applied migrations and rejects bad names', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [{ created_at: '9999999999999' }] });
    const db = { transaction: (fn: (tx: unknown) => Promise<void>) => fn({ execute }) } as Db;
    await runMigrations(db, {
      migrationsFolder: `${__dirname}/fixtures/migrations`,
      schema: 'trip',
      table: 'm',
    });
    expect(execute).toHaveBeenCalledTimes(3);
    await expect(
      runMigrations(db, { migrationsFolder: 'x', schema: 'trip', table: 'bad;' }),
    ).rejects.toThrow(/Invalid/);
  });

  it('DatabaseModule.forRoot wires the pool', async () => {
    const mod = await Test.createTestingModule({
      imports: [DatabaseModule.forRoot({ url: 'postgres://u:p@127.0.0.1:1/db', schema: 'trip' })],
    }).compile();
    await mod.init();
    expect(mod.get(PG_POOL)).toBeDefined();
    await mod.close();
  });
});

describe('SimClockModule', () => {
  it('provides a SimClock without a token provider', async () => {
    const mod = await Test.createTestingModule({
      imports: [SimClockModule.forRoot({ simulatorUrl: 'http://sim.test' })],
    }).compile();
    expect(mod.get(SimClock)).toBeInstanceOf(SimClock);
  });

  it('provides a SimClock with a token provider', async () => {
    const mod = await Test.createTestingModule({
      imports: [SimClockModule.forRoot({ simulatorUrl: 'http://sim.test', refreshMs: 500 })],
      providers: [{ provide: TOKEN_PROVIDER, useValue: { getToken: async () => 't' } }],
    }).compile();
    expect(mod.get(SimClock)).toBeInstanceOf(SimClock);
  });
});
