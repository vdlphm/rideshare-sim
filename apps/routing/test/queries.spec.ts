import { describe, expect, it } from 'vitest';
import { LatLngParamSchema, RouteParamsSchema } from '../src/queries';

describe('lat,lng query parsing', () => {
  it('parses lat,lng with optional whitespace and signs', () => {
    expect(LatLngParamSchema.parse('47.6097,-122.3422')).toEqual({ lat: 47.6097, lng: -122.3422 });
    expect(LatLngParamSchema.parse(' 47 , -122 ')).toEqual({ lat: 47, lng: -122 });
  });

  it.each(['', 'abc', '47.6', '47.6,', '1,2,3', '47.6;-122.3', '91,0', '0,181', 'NaN,1', '1e2,1'])(
    'rejects %j',
    (input) => {
      expect(LatLngParamSchema.safeParse(input).success).toBe(false);
    },
  );

  it('parses from/to', () => {
    expect(RouteParamsSchema.parse({ from: '1,2', to: '3,4' })).toEqual({
      from: { lat: 1, lng: 2 },
      to: { lat: 3, lng: 4 },
    });
    expect(RouteParamsSchema.safeParse({ from: '1,2' }).success).toBe(false);
  });
});
