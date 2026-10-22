import { describe, expect, it } from 'vitest';
import { decodePolyline, encodePolyline, fromLineString, toLineString, type LngLat } from '../src';

const GOOGLE = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
// Google's example lists (lat, lng); ours are [lng, lat].
const GOOGLE_POINTS: LngLat[] = [
  [-120.2, 38.5],
  [-120.95, 40.7],
  [-126.453, 43.252],
];

describe('polyline', () => {
  it('decodes the canonical Google example', () => {
    expect(decodePolyline(GOOGLE)).toEqual(GOOGLE_POINTS);
  });

  it('encodes the canonical Google example', () => {
    expect(encodePolyline(GOOGLE_POINTS)).toBe(GOOGLE);
  });

  it.each([5, 6])('round-trips at precision %i', (precision) => {
    const pts: LngLat[] = [
      [-122.33207, 47.60621],
      [-122.3493, 47.6205],
      [-122.0, 47.0],
      [-122.41999, 47.57001],
    ];
    expect(decodePolyline(encodePolyline(pts, precision), precision)).toEqual(pts);
  });

  it('precision 6 differs from precision 5 encoding', () => {
    expect(encodePolyline(GOOGLE_POINTS, 6)).not.toBe(GOOGLE);
  });

  it('handles empty input', () => {
    expect(encodePolyline([])).toBe('');
    expect(decodePolyline('')).toEqual([]);
  });
});

describe('LineString', () => {
  it('round-trips', () => {
    const pts: LngLat[] = [
      [-122.3, 47.6],
      [-122.31, 47.61],
    ];
    const line = toLineString(pts);
    expect(line).toEqual({ type: 'LineString', coordinates: pts });
    expect(fromLineString(line)).toEqual(pts);
  });
});
