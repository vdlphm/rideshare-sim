import type { LngLat } from './types';

export interface LineString {
  type: 'LineString';
  coordinates: LngLat[];
}

export function toLineString(points: LngLat[]): LineString {
  return { type: 'LineString', coordinates: points.map(([lng, lat]) => [lng, lat]) };
}

export function fromLineString(line: LineString): LngLat[] {
  return line.coordinates.map(([lng, lat]) => [lng, lat]);
}
