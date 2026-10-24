import { RiderLocationUpdateSchema } from '@rideshare/contracts';
import { describe, expect, it } from 'vitest';
import { positionKey, pruneCutoff, toPosition } from '../src/positions';

const ID = '3f2b8c1e-6d4a-4b1f-9a77-0c1d2e3f4a5b';

describe('toPosition', () => {
  it('maps hash strings to numbers', () => {
    expect(toPosition(ID, { lat: '47.6', lng: '-122.33', ts: '1700000000000' })).toEqual({
      riderId: ID,
      lat: 47.6,
      lng: -122.33,
      ts: 1700000000000,
    });
  });
  it('returns null for empty, partial or malformed hashes', () => {
    expect(toPosition(ID, {})).toBeNull();
    expect(toPosition(ID, null)).toBeNull();
    expect(toPosition(ID, { lat: '1', lng: '2' })).toBeNull();
    expect(toPosition(ID, { lat: 'x', lng: '2', ts: '3' })).toBeNull();
  });
  it('builds the key', () => expect(positionKey(ID)).toBe(`pos:${ID}`));
});

describe('pruneCutoff', () => {
  it('is now minus the TTL in ms', () => {
    const now = () => 1_700_000_600_000;
    expect(pruneCutoff(now(), 600)).toBe(1_700_000_000_000);
    expect(pruneCutoff(now(), 1)).toBe(1_700_000_599_000);
  });
});

describe('RiderLocationUpdateSchema', () => {
  it('accepts lat/lng', () => {
    expect(RiderLocationUpdateSchema.safeParse({ lat: 1, lng: 2 }).success).toBe(true);
  });
  it('rejects an extra riderId (strict)', () => {
    expect(RiderLocationUpdateSchema.safeParse({ lat: 1, lng: 2, riderId: ID }).success).toBe(
      false,
    );
  });
  it('rejects out-of-range and missing values', () => {
    expect(RiderLocationUpdateSchema.safeParse({ lat: 91, lng: 2 }).success).toBe(false);
    expect(RiderLocationUpdateSchema.safeParse({ lat: 1 }).success).toBe(false);
  });
});
