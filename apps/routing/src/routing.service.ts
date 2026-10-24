import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { InjectConfig } from '@rideshare/common';
import {
  NearestResultSchema,
  RouteSchema,
  TableResponseSchema,
  type LatLng,
  type NearestResult,
  type Route,
  type TableRequest,
  type TableResponse,
} from '@rideshare/contracts';
import type { RoutingEnv } from './config';
import { OsrmClient } from './osrm.client';
import { RoutingCache, nearestKey, roundPoint, routeKey, tableKey } from './routing.cache';

@Injectable()
export class RoutingService {
  constructor(
    private readonly osrm: OsrmClient,
    private readonly cache: RoutingCache,
    @InjectConfig() private readonly cfg: RoutingEnv,
  ) {}

  async route(fromIn: LatLng, toIn: LatLng): Promise<Route> {
    const from = roundPoint(fromIn);
    const to = roundPoint(toIn);
    const key = routeKey(from, to);
    const hit = await this.cache.get(key, RouteSchema);
    if (hit) return hit;
    const route = RouteSchema.parse(await this.osrm.route(from, to));
    await this.cache.set(key, route);
    return route;
  }

  async table(req: TableRequest): Promise<TableResponse> {
    const sources = req.sources.map(roundPoint);
    const destinations = req.destinations.map(roundPoint);
    const key = tableKey(sources, destinations);
    const hit = await this.cache.get(key, TableResponseSchema);
    if (hit) return hit;
    const result: TableResponse = { durations: await this.osrm.table(sources, destinations) };
    await this.cache.set(key, result);
    return result;
  }

  async nearest(pIn: LatLng): Promise<NearestResult> {
    const p = roundPoint(pIn);
    const key = nearestKey(p);
    let result = await this.cache.get(key, NearestResultSchema);
    if (!result) {
      result = NearestResultSchema.parse(await this.osrm.nearest(p));
      await this.cache.set(key, result);
    }
    // Checked after the cache so MAX_SNAP_M changes apply to already-cached snaps.
    if (result.distanceM > this.cfg.MAX_SNAP_M) {
      throw new UnprocessableEntityException(
        `Nearest road is ${Math.round(result.distanceM)} m away (max ${this.cfg.MAX_SNAP_M} m)`,
      );
    }
    return result;
  }
}
