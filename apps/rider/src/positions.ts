import type { RiderPosition } from '@rideshare/contracts';

export const POSITION_INDEX_KEY = 'pos:index';
export const positionKey = (riderId: string): string => `pos:${riderId}`;

/** Index scores older than this (ms epoch) belong to positions whose hash has expired. */
export function pruneCutoff(nowMs: number, ttlS: number): number {
  return nowMs - ttlS * 1000;
}

/** Maps a Redis hash (string values) to a RiderPosition; null when missing or malformed. */
export function toPosition(
  riderId: string,
  hash: Record<string, string> | null | undefined,
): RiderPosition | null {
  if (!hash || hash.lat === undefined || hash.lng === undefined || hash.ts === undefined) {
    return null;
  }
  const lat = Number(hash.lat);
  const lng = Number(hash.lng);
  const ts = Number(hash.ts);
  if (![lat, lng, ts].every(Number.isFinite)) return null;
  return { riderId, lat, lng, ts };
}
