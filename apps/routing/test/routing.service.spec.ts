import { UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { nearestKey, roundCoord, routeKey, tableKey } from '../src/routing.cache';
import { FakeRedis, NEEDLE, PIKE, fixture, makeService } from './helpers';

let ctx = undefined as unknown as ReturnType<typeof makeService>;
afterEach(async () => {
  await ctx?.osrm.agent.close();
  ctx = undefined as never;
});

describe('cache keys', () => {
  it('rounds coordinates to 5 decimals', () => {
    expect(roundCoord(47.6097049)).toBe(47.6097);
    expect(roundCoord(-0.000001)).toBe(0);
    expect(routeKey({ lat: 47.6097049, lng: -122.3422001 }, NEEDLE)).toBe(
      routeKey({ lat: 47.609704, lng: -122.342200000001 }, NEEDLE),
    );
    expect(routeKey(PIKE, NEEDLE)).toBe('route:47.60970,-122.34220:47.62050,-122.34930');
    expect(nearestKey(PIKE)).toBe('nearest:47.60970,-122.34220');
  });

  it('distinguishes inputs that differ at the 5th decimal', () => {
    expect(routeKey({ lat: 47.60971, lng: -122.3422 }, NEEDLE)).not.toBe(routeKey(PIKE, NEEDLE));
  });

  it('keys tables by sha1 of the normalised sources|destinations', () => {
    const norm = '47.60970,-122.34220|47.62050,-122.34930';
    expect(tableKey([PIKE], [NEEDLE])).toBe(
      `table:${createHash('sha1').update(norm).digest('hex')}`,
    );
    expect(tableKey([{ lat: 47.6097004, lng: -122.3422 }], [NEEDLE])).toBe(
      tableKey([PIKE], [NEEDLE]),
    );
    expect(tableKey([NEEDLE], [PIKE])).not.toBe(tableKey([PIKE], [NEEDLE]));
  });
});

describe('RoutingService caching', () => {
  it('serves a repeated route (and a near-identical one) from cache without calling OSRM', async () => {
    ctx = makeService();
    ctx.osrm.reply('/route/v1/driving/', 200, fixture('route-ok'));
    const first = await ctx.service.route(PIKE, NEEDLE);
    const again = await ctx.service.route(PIKE, NEEDLE);
    const near = await ctx.service.route({ lat: 47.60970004, lng: -122.3422 }, NEEDLE);
    expect(again).toEqual(first);
    expect(near).toEqual(first);
    expect(ctx.osrm.calls).toHaveLength(1);
    expect(ctx.redis.ttls.get(routeKey(PIKE, NEEDLE))).toBe(3600);
  });

  it('queries OSRM with the rounded coordinates', async () => {
    ctx = makeService();
    ctx.osrm.reply('/route/v1/driving/', 200, fixture('route-ok'));
    await ctx.service.route({ lat: 47.6097049, lng: -122.3422001 }, NEEDLE);
    expect(ctx.osrm.calls[0]).toContain('-122.3422,47.6097;');
  });

  it('caches tables and keeps null entries', async () => {
    ctx = makeService();
    ctx.osrm.reply('/table/v1/driving/', 200, fixture('table-nulls'));
    const req = { sources: [PIKE, NEEDLE], destinations: [NEEDLE, PIKE] };
    const a = await ctx.service.table(req);
    const b = await ctx.service.table(req);
    expect(b).toEqual(a);
    expect(b.durations[0]).toEqual([236.7, null]);
    expect(ctx.osrm.calls).toHaveLength(1);
  });

  it('does not cache errors', async () => {
    ctx = makeService();
    ctx.osrm.reply('/route/v1/driving/', 200, fixture('no-route'));
    await expect(ctx.service.route(PIKE, NEEDLE)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    await expect(ctx.service.route(PIKE, NEEDLE)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(ctx.osrm.calls).toHaveLength(2);
    expect(ctx.redis.store.size).toBe(0);
  });

  it('falls through to OSRM when Redis fails', async () => {
    const redis = new FakeRedis();
    redis.fail = true;
    ctx = makeService(redis);
    ctx.osrm.reply('/route/v1/driving/', 200, fixture('route-ok'));
    const route = await ctx.service.route(PIKE, NEEDLE);
    expect(route.distanceM).toBeCloseTo(1638.2, 1);
    await ctx.service.route(PIKE, NEEDLE);
    expect(ctx.osrm.calls).toHaveLength(2);
  });

  it('abandons a Redis call that hangs', async () => {
    const redis = new FakeRedis();
    redis.get = () => new Promise(() => {});
    redis.set = () => new Promise(() => {});
    ctx = makeService(redis, { CACHE_TIMEOUT_MS: '30' });
    ctx.osrm.reply('/route/v1/driving/', 200, fixture('route-ok'));
    await expect(ctx.service.route(PIKE, NEEDLE)).resolves.toMatchObject({ distanceM: 1638.2 });
  });

  it('ignores a corrupt cache entry', async () => {
    ctx = makeService();
    ctx.redis.store.set(routeKey(PIKE, NEEDLE), '{not json');
    ctx.osrm.reply('/route/v1/driving/', 200, fixture('route-ok'));
    await expect(ctx.service.route(PIKE, NEEDLE)).resolves.toMatchObject({ distanceM: 1638.2 });
  });
});

describe('RoutingService.nearest', () => {
  it('returns a snap within MAX_SNAP_M', async () => {
    ctx = makeService();
    ctx.osrm.reply('/nearest/v1/driving/', 200, fixture('nearest-ok'));
    const res = await ctx.service.nearest(PIKE);
    expect(res).toEqual({ lat: 47.609681, lng: -122.342225, distanceM: 2.827300801 });
  });

  it('rejects a snap beyond MAX_SNAP_M with 422, also when served from cache', async () => {
    ctx = makeService();
    ctx.osrm.reply('/nearest/v1/driving/', 200, fixture('nearest-far'));
    const p = { lat: 47.605, lng: -122.36 };
    await expect(ctx.service.nearest(p)).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(ctx.service.nearest(p)).rejects.toThrow(/1007 m away \(max 150 m\)/);
    expect(ctx.osrm.calls).toHaveLength(1);
  });

  it('honours a configured MAX_SNAP_M', async () => {
    ctx = makeService(new FakeRedis(), { MAX_SNAP_M: '2000' });
    ctx.osrm.reply('/nearest/v1/driving/', 200, fixture('nearest-far'));
    await expect(ctx.service.nearest({ lat: 47.605, lng: -122.36 })).resolves.toMatchObject({
      distanceM: 1006.732384607,
    });
  });
});
