import { describe, expect, it } from 'vitest';
import {
  SEATTLE_MAP_BBOX,
  SEATTLE_SPAWN_BBOX,
  isInBbox,
  randomPointInBbox,
  type Bbox,
} from '../src';

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('bbox constants', () => {
  it.each([
    ['spawn', SEATTLE_SPAWN_BBOX],
    ['map', SEATTLE_MAP_BBOX],
  ])('%s bbox is valid', (_n, b: Bbox) => {
    expect(b.minLng).toBeLessThan(b.maxLng);
    expect(b.minLat).toBeLessThan(b.maxLat);
  });

  it('spawn bbox lies within the map bbox and matches the design', () => {
    expect(SEATTLE_SPAWN_BBOX).toEqual({
      minLng: -122.355,
      minLat: 47.595,
      maxLng: -122.315,
      maxLat: 47.63,
    });
    expect(SEATTLE_MAP_BBOX).toEqual({
      minLng: -122.42,
      minLat: 47.57,
      maxLng: -122.27,
      maxLat: 47.67,
    });
    expect(
      isInBbox(
        { lat: SEATTLE_SPAWN_BBOX.minLat, lng: SEATTLE_SPAWN_BBOX.minLng },
        SEATTLE_MAP_BBOX,
      ),
    ).toBe(true);
    expect(
      isInBbox(
        { lat: SEATTLE_SPAWN_BBOX.maxLat, lng: SEATTLE_SPAWN_BBOX.maxLng },
        SEATTLE_MAP_BBOX,
      ),
    ).toBe(true);
  });
});

describe('randomPointInBbox', () => {
  it('always inside the bbox over many seeded samples', () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 5000; i++) {
      expect(isInBbox(randomPointInBbox(SEATTLE_SPAWN_BBOX, rng), SEATTLE_SPAWN_BBOX)).toBe(true);
    }
  });

  it('maps rng values deterministically (lng first, then lat)', () => {
    const vals = [0, 1];
    const p = randomPointInBbox(SEATTLE_SPAWN_BBOX, () => vals.shift() as number);
    expect(p).toEqual({ lng: SEATTLE_SPAWN_BBOX.minLng, lat: SEATTLE_SPAWN_BBOX.maxLat });
  });

  it('defaults to Math.random', () => {
    expect(isInBbox(randomPointInBbox(SEATTLE_MAP_BBOX), SEATTLE_MAP_BBOX)).toBe(true);
  });
});

describe('isInBbox', () => {
  it('rejects points outside on each side', () => {
    const b = SEATTLE_SPAWN_BBOX;
    const mid = { lat: 47.61, lng: -122.33 };
    expect(isInBbox(mid, b)).toBe(true);
    expect(isInBbox({ ...mid, lng: b.minLng - 0.001 }, b)).toBe(false);
    expect(isInBbox({ ...mid, lng: b.maxLng + 0.001 }, b)).toBe(false);
    expect(isInBbox({ ...mid, lat: b.minLat - 0.001 }, b)).toBe(false);
    expect(isInBbox({ ...mid, lat: b.maxLat + 0.001 }, b)).toBe(false);
  });
});
