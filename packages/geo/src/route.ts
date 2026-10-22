import { bearingDeg } from './distance';
import type { LatLng, LngLat } from './types';

export interface RoutePosition {
  position: LatLng;
  headingDeg: number;
  segmentIndex: number;
  /** Fraction (0..1) of total route duration elapsed. */
  progress: number;
  done: boolean;
  remainingS: number;
}

const toLatLng = ([lng, lat]: LngLat): LatLng => ({ lat, lng });
const sum = (xs: number[]): number => xs.reduce((acc, x) => acc + x, 0);

/** Total duration left after `elapsedS` seconds (clamped to [0, total]). */
export function remainingDurationS(durations: number[], elapsedS: number): number {
  return Math.max(0, sum(durations) - Math.max(0, elapsedS));
}

/**
 * Position along an OSRM route after `elapsedS` seconds, interpolating linearly
 * within each segment by its duration. `durations[i]` is the time of the segment
 * from `geometry[i]` to `geometry[i + 1]`.
 */
export function interpolateAlongRoute(
  geometry: LngLat[],
  durations: number[],
  elapsedS: number,
): RoutePosition {
  if (geometry.length < 2) {
    throw new Error('geometry must contain at least 2 points');
  }
  if (durations.length !== geometry.length - 1) {
    throw new Error(
      `durations length (${durations.length}) must equal geometry length - 1 (${geometry.length - 1})`,
    );
  }
  const lastSeg = durations.length - 1;
  const total = sum(durations);

  const elapsed = Math.max(0, elapsedS);

  if (elapsed >= total) {
    return {
      position: toLatLng(geometry[lastSeg + 1]),
      headingDeg: bearingDeg(toLatLng(geometry[lastSeg]), toLatLng(geometry[lastSeg + 1])),
      segmentIndex: lastSeg,
      progress: 1,
      done: true,
      remainingS: 0,
    };
  }

  // Here elapsed < total, so the segment found below has a positive duration.
  let seg = 0;
  let before = 0;
  while (seg < lastSeg && elapsed >= before + durations[seg]) {
    before += durations[seg];
    seg++;
  }
  const a = toLatLng(geometry[seg]);
  const b = toLatLng(geometry[seg + 1]);
  const t = Math.min(1, (elapsed - before) / durations[seg]);
  return {
    position: { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t },
    headingDeg: bearingDeg(a, b),
    segmentIndex: seg,
    progress: elapsed / total,
    done: false,
    remainingS: total - elapsed,
  };
}
