import { Injectable } from '@nestjs/common';
import { InjectRedis, defineScript } from '@rideshare/common';
import type { DriverState, DriverStatus, NearbyDriver } from '@rideshare/contracts';
import type { Redis } from 'ioredis';
import { DRIVER_TRANSITION_LUA } from './driver.scripts';

export type TransitionCode =
  'OK' | 'NOT_FOUND' | 'NOT_ONLINE' | 'ON_TRIP' | 'SWEPT' | 'FRESH' | 'SKIPPED';

export interface TransitionResult {
  code: TransitionCode;
  state: DriverState | null;
}

export const keys = {
  state: (id: string) => `state:${id}`,
  geo: 'geo:available',
  online: 'online',
} as const;

/** Stale-after rule shared by the Lua script and the JS-side nearby filter. */
export function isStale(ts: number, now: number, staleAfterMs: number): boolean {
  return now - ts > staleAfterMs;
}

type Fields = Record<string, string>;

export function toState(driverId: string, h: Fields): DriverState | null {
  if (!h['status']) return null;
  return {
    driverId,
    status: h['status'] as DriverStatus,
    tripId: h['tripId'] ? h['tripId'] : null,
    lat: Number(h['lat']),
    lng: Number(h['lng']),
    heading: Number(h['heading'] ?? 0),
    ts: Number(h['ts']),
  };
}

@Injectable()
export class DriverStore {
  private readonly transition: (...args: (string | number)[]) => Promise<unknown>;

  constructor(@InjectRedis() private readonly redis: Redis) {
    this.transition = defineScript(redis, 'driverTransition', DRIVER_TRANSITION_LUA, 3);
  }

  private async run(
    id: string,
    op: string,
    now: number,
    staleAfterMs: number,
    ...args: (string | number)[]
  ): Promise<TransitionResult> {
    const reply = (await this.transition(
      keys.state(id),
      keys.geo,
      keys.online,
      op,
      id,
      now,
      staleAfterMs,
      ...args,
    )) as string[];
    const [code, status, tripId, lat, lng, heading, ts] = reply as [string, ...string[]];
    const state = toState(id, {
      status: status!,
      tripId: tripId!,
      lat: lat!,
      lng: lng!,
      heading: heading!,
      ts: ts!,
    });
    return { code: code as TransitionCode, state };
  }

  goOnline(id: string, lat: number, lng: number, now: number) {
    return this.run(id, 'online', now, 0, lat, lng);
  }
  goOffline(id: string, now: number) {
    return this.run(id, 'offline', now, 0);
  }
  updateLocation(id: string, lat: number, lng: number, heading: number, now: number) {
    return this.run(id, 'location', now, 0, lat, lng, heading);
  }
  setStatus(
    id: string,
    status: DriverStatus,
    tripId: string | null,
    now: number,
    staleAfterMs: number,
  ) {
    return this.run(id, 'status', now, staleAfterMs, status, tripId ?? '');
  }
  sweep(id: string, now: number, staleAfterMs: number) {
    return this.run(id, 'sweep', now, staleAfterMs);
  }

  async get(id: string): Promise<DriverState | null> {
    return toState(id, await this.redis.hgetall(keys.state(id)));
  }

  listOnlineIds(): Promise<string[]> {
    return this.redis.smembers(keys.online);
  }

  async listOnline(): Promise<DriverState[]> {
    const ids = await this.listOnlineIds();
    return this.getMany(ids);
  }

  private async getMany(ids: string[]): Promise<DriverState[]> {
    if (ids.length === 0) return [];
    const pipe = this.redis.pipeline();
    for (const id of ids) pipe.hgetall(keys.state(id));
    const rows = (await pipe.exec()) ?? [];
    const out: DriverState[] = [];
    rows.forEach(([err, h], i) => {
      if (err) throw err;
      const s = toState(ids[i]!, h as Fields);
      if (s) out.push(s);
    });
    return out;
  }

  /** Closest-first drivers within the radius whose position is fresh. */
  async nearby(
    lat: number,
    lng: number,
    radiusM: number,
    limit: number,
    now: number,
    staleAfterMs: number,
  ): Promise<NearbyDriver[]> {
    // Over-fetch a little so a few not-yet-swept stale members don't shrink the page.
    const count = limit * 2 + 10;
    const found = (await this.redis.geosearch(
      keys.geo,
      'FROMLONLAT',
      lng,
      lat,
      'BYRADIUS',
      radiusM,
      'm',
      'ASC',
      'COUNT',
      count,
      'WITHDIST',
    )) as [string, string][];
    if (found.length === 0) return [];
    const states = new Map(
      (await this.getMany(found.map(([id]) => id))).map((s) => [s.driverId, s]),
    );
    const out: NearbyDriver[] = [];
    for (const [id, dist] of found) {
      const s = states.get(id);
      if (!s || s.status !== 'AVAILABLE' || isStale(s.ts, now, staleAfterMs)) continue;
      out.push({ driverId: id, lat: s.lat, lng: s.lng, distanceM: Number(dist) });
      if (out.length === limit) break;
    }
    return out;
  }
}
