import { Injectable, Logger } from '@nestjs/common';
import { InjectConfig, InjectRedis } from '@rideshare/common';
import type { LatLng } from '@rideshare/contracts';
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { ZodType } from 'zod';
import type { RoutingEnv } from './config';

const DECIMALS = 5;

/** Rounds to 5 decimals (~1 m); the rounded value is what is queried and cached. */
export function roundCoord(n: number): number {
  const r = Number(n.toFixed(DECIMALS));
  return r === 0 ? 0 : r; // normalise -0
}

export const roundPoint = (p: LatLng): LatLng => ({
  lat: roundCoord(p.lat),
  lng: roundCoord(p.lng),
});

const fmt = (p: LatLng) =>
  `${p.lat.toFixed(DECIMALS)},${p.lng.toFixed(DECIMALS)}`.replace(/-0\.00000/g, '0.00000');

export const routeKey = (from: LatLng, to: LatLng) => `route:${fmt(from)}:${fmt(to)}`;
export const nearestKey = (p: LatLng) => `nearest:${fmt(p)}`;
export function tableKey(sources: LatLng[], destinations: LatLng[]): string {
  const norm = `${sources.map(fmt).join(';')}|${destinations.map(fmt).join(';')}`;
  return `table:${createHash('sha1').update(norm).digest('hex')}`;
}

/** Best-effort JSON cache: any Redis failure or slowness is logged and treated as a miss. */
@Injectable()
export class RoutingCache {
  private readonly logger = new Logger(RoutingCache.name);

  constructor(
    @InjectRedis() private readonly redis: Redis,
    @InjectConfig() private readonly cfg: RoutingEnv,
  ) {}

  async get<T>(key: string, schema: ZodType<T>): Promise<T | undefined> {
    try {
      const raw = await this.bounded(this.redis.get(key));
      if (raw === null) return undefined;
      const parsed = schema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
      this.logger.warn(`Ignoring malformed cache entry ${key}`);
    } catch (err) {
      this.logger.warn(`Cache read failed for ${key}: ${(err as Error).message}`);
    }
    return undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    try {
      await this.bounded(
        this.redis.set(key, JSON.stringify(value), 'EX', this.cfg.ROUTE_CACHE_TTL_S),
      );
    } catch (err) {
      this.logger.warn(`Cache write failed for ${key}: ${(err as Error).message}`);
    }
  }

  private bounded<T>(op: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${this.cfg.CACHE_TIMEOUT_MS} ms`)),
        this.cfg.CACHE_TIMEOUT_MS,
      );
    });
    op.catch(() => undefined); // a late failure after the timeout must not be unhandled
    return Promise.race([op, timeout]).finally(() => clearTimeout(timer));
  }
}
