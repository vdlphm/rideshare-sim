import { describe, expect, it } from 'vitest';
import { interpolateAlongRoute, remainingDurationS, type LngLat } from '../src';

// East 1 deg, then north 1 deg (equator), 10 s each.
const geom: LngLat[] = [
  [0, 0],
  [1, 0],
  [1, 1],
];
const dur = [10, 10];

describe('interpolateAlongRoute', () => {
  it('start', () => {
    const r = interpolateAlongRoute(geom, dur, 0);
    expect(r.position).toEqual({ lat: 0, lng: 0 });
    expect(r).toMatchObject({ segmentIndex: 0, progress: 0, done: false, remainingS: 20 });
  });

  it('mid-segment', () => {
    const r = interpolateAlongRoute(geom, dur, 5);
    expect(r.position.lng).toBeCloseTo(0.5);
    expect(r.position.lat).toBeCloseTo(0);
    expect(r.progress).toBeCloseTo(0.25);
    expect(r.remainingS).toBe(15);
    expect(r.headingDeg).toBeCloseTo(90, 6);
  });

  it('exact vertex moves to the next segment', () => {
    const r = interpolateAlongRoute(geom, dur, 10);
    expect(r.position).toEqual({ lat: 0, lng: 1 });
    expect(r.segmentIndex).toBe(1);
    expect(r.done).toBe(false);
    expect(r.headingDeg).toBeCloseTo(0, 6);
  });

  it('second segment mid', () => {
    const r = interpolateAlongRoute(geom, dur, 15);
    expect(r.position.lat).toBeCloseTo(0.5);
    expect(r.position.lng).toBeCloseTo(1);
  });

  it('end is done', () => {
    const r = interpolateAlongRoute(geom, dur, 20);
    expect(r).toMatchObject({
      position: { lat: 1, lng: 1 },
      progress: 1,
      done: true,
      remainingS: 0,
    });
    expect(r.segmentIndex).toBe(1);
  });

  it('clamps elapsed beyond total', () => {
    const r = interpolateAlongRoute(geom, dur, 999);
    expect(r.position).toEqual({ lat: 1, lng: 1 });
    expect(r.done).toBe(true);
  });

  it('clamps negative elapsed to start', () => {
    const r = interpolateAlongRoute(geom, dur, -5);
    expect(r.position).toEqual({ lat: 0, lng: 0 });
    expect(r).toMatchObject({ progress: 0, done: false, remainingS: 20 });
  });

  it('skips zero-duration segments without NaN', () => {
    const g: LngLat[] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [2, 1],
    ];
    const r = interpolateAlongRoute(g, [0, 10, 0], 5);
    expect(r.segmentIndex).toBe(1);
    expect(r.position.lat).toBeCloseTo(0.5);
    expect(Number.isNaN(r.position.lng)).toBe(false);
    const end = interpolateAlongRoute(g, [0, 10, 0], 10);
    expect(end.done).toBe(true);
    expect(end.position).toEqual({ lat: 1, lng: 2 });
  });

  it('all-zero durations are done immediately, even for negative elapsed', () => {
    const r = interpolateAlongRoute(geom, [0, 0], -1);
    expect(r.done).toBe(true);
    expect(r.progress).toBe(1);
  });

  it('throws on mismatched lengths', () => {
    expect(() => interpolateAlongRoute(geom, [10], 1)).toThrow(/durations length/);
  });

  it('throws on fewer than 2 points', () => {
    expect(() => interpolateAlongRoute([[0, 0]], [], 0)).toThrow(/at least 2/);
    expect(() => interpolateAlongRoute([], [], 0)).toThrow(/at least 2/);
  });
});

describe('remainingDurationS', () => {
  it('computes remaining and clamps', () => {
    expect(remainingDurationS([10, 20], 0)).toBe(30);
    expect(remainingDurationS([10, 20], 12)).toBe(18);
    expect(remainingDurationS([10, 20], 100)).toBe(0);
    expect(remainingDurationS([10, 20], -5)).toBe(30);
    expect(remainingDurationS([], 3)).toBe(0);
  });
});
