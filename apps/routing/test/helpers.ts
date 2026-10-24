import { Logger } from '@nestjs/common';
import { createHttpClient, defineConfig } from '@rideshare/common';
import type { Redis } from 'ioredis';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MockAgent } from 'undici';
import { routingEnvSchema, type RoutingEnv } from '../src/config';
import { OsrmClient } from '../src/osrm.client';
import { RoutingCache } from '../src/routing.cache';
import { RoutingService } from '../src/routing.service';

// Expected cache-failure warnings would otherwise flood the unit test output.
Logger.overrideLogger(false);

// Recorded OSRM JSON, deliberately loose: tests tweak fields freely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const fixture = (name: string): Record<string, any> =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', `${name}.json`), 'utf8'));

export const PIKE = { lat: 47.6097, lng: -122.3422 };
export const NEEDLE = { lat: 47.6205, lng: -122.3493 };

export function makeConfig(extra: NodeJS.ProcessEnv = {}): RoutingEnv {
  return defineConfig(routingEnvSchema, {
    REDIS_URL: 'redis://localhost:6379/0',
    LOG_LEVEL: 'silent',
    ...extra,
  });
}

export interface FakeOsrm {
  agent: MockAgent;
  client: OsrmClient;
  /** Requests received, by OSRM path. */
  calls: string[];
  /** Replies to every request whose path starts with `prefix`. */
  reply(prefix: string, status: number, body: unknown): void;
}

export function makeOsrm(): FakeOsrm {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const calls: string[] = [];
  const pool = agent.get('http://osrm:5000');
  const http = createHttpClient({
    baseUrl: 'http://osrm:5000',
    service: 'osrm',
    auth: 'none',
    maxAttempts: 1,
    dispatcher: agent,
  });
  return {
    agent,
    client: new OsrmClient(http),
    calls,
    reply(prefix, status, body) {
      pool
        .intercept({ path: (p: string) => p.startsWith(prefix) })
        .reply((opts) => {
          calls.push(opts.path);
          return { statusCode: status, data: JSON.stringify(body) };
        })
        .persist();
    },
  };
}

/** In-memory stand-in for the ioredis calls RoutingCache makes. */
export class FakeRedis {
  readonly store = new Map<string, string>();
  readonly ttls = new Map<string, number>();
  fail = false;
  async get(key: string): Promise<string | null> {
    if (this.fail) throw new Error('redis down');
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string, _ex: 'EX', ttl: number): Promise<'OK'> {
    if (this.fail) throw new Error('redis down');
    this.store.set(key, value);
    this.ttls.set(key, ttl);
    return 'OK';
  }
}

export function makeService(redis = new FakeRedis(), extra: NodeJS.ProcessEnv = {}) {
  const osrm = makeOsrm();
  const cfg = makeConfig(extra);
  const cache = new RoutingCache(redis as unknown as Redis, cfg);
  return { osrm, redis, cfg, service: new RoutingService(osrm.client, cache, cfg) };
}
