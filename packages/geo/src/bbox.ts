import type { Bbox, LatLng } from './types';

/** Uniform random point inside the bbox; inject `rng` (returns [0,1)) for determinism. */
export function randomPointInBbox(bbox: Bbox, rng: () => number = Math.random): LatLng {
  const lng = bbox.minLng + rng() * (bbox.maxLng - bbox.minLng);
  const lat = bbox.minLat + rng() * (bbox.maxLat - bbox.minLat);
  return { lat, lng };
}

export function isInBbox(point: LatLng, bbox: Bbox): boolean {
  return (
    point.lng >= bbox.minLng &&
    point.lng <= bbox.maxLng &&
    point.lat >= bbox.minLat &&
    point.lat <= bbox.maxLat
  );
}
