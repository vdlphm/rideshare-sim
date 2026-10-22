import { describe, expect, it } from 'vitest';
import { bearingDeg, haversineM } from '../src';

describe('haversineM', () => {
  it('Pike Place Market to Space Needle matches independent value within 10 m', () => {
    const pike = { lat: 47.6097, lng: -122.3422 };
    const needle = { lat: 47.6205, lng: -122.3493 };
    // Independent: spherical law of cosines, R = 6371008.8 m => 1313.549 m
    expect(Math.abs(haversineM(pike, needle) - 1313.55)).toBeLessThan(10);
    expect(haversineM(pike, needle)).toBeCloseTo(haversineM(needle, pike), 6);
  });

  it('is 0 for identical points', () => {
    expect(haversineM({ lat: 47.6, lng: -122.3 }, { lat: 47.6, lng: -122.3 })).toBe(0);
  });

  it('one degree of latitude is about 111.2 km', () => {
    const d = haversineM({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    expect(d).toBeGreaterThan(111_150);
    expect(d).toBeLessThan(111_250);
  });

  it('antipodal points are half the circumference without NaN', () => {
    const d = haversineM({ lat: 0, lng: 0 }, { lat: 0, lng: 180 });
    expect(d).toBeCloseTo(Math.PI * 6_371_008.8, 0);
  });
});

describe('bearingDeg', () => {
  const o = { lat: 47.6, lng: -122.3 };
  it('due north is 0', () => {
    expect(bearingDeg(o, { lat: 47.7, lng: -122.3 })).toBeCloseTo(0, 6);
  });
  it('due east is ~90', () => {
    expect(bearingDeg({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(90, 6);
  });
  it('due south is 180 and due west is 270', () => {
    expect(bearingDeg(o, { lat: 47.5, lng: -122.3 })).toBeCloseTo(180, 6);
    expect(bearingDeg({ lat: 0, lng: 0 }, { lat: 0, lng: -1 })).toBeCloseTo(270, 6);
  });
  it('always lies in [0, 360)', () => {
    const b = bearingDeg(o, { lat: 47.65, lng: -122.4 });
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(360);
  });
});
