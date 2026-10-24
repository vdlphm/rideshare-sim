import { UpstreamError, type HttpClient } from '@rideshare/common';
import { NearestResultSchema, type LatLng } from '@rideshare/contracts';
import type { Snapper } from './bot-env';

/** Snaps points via routing's /internal/nearest (service token); 422 means "no road within 150 m". */
export class RoutingSnapper implements Snapper {
  constructor(private readonly http: HttpClient) {}

  async snap(point: LatLng): Promise<LatLng | null> {
    try {
      const res = await this.http.get('/internal/nearest', {
        query: { lat: point.lat, lng: point.lng },
        schema: NearestResultSchema,
      });
      return { lat: res.lat, lng: res.lng };
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 422) return null;
      throw err;
    }
  }
}
