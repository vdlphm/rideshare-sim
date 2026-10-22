import { describe, expect, it } from 'vitest';
import { RedisModule, assertKeyPrefix, assertSchemaName, serviceSchema } from '../src';

describe('keyPrefix validation', () => {
  it('accepts prefixes ending with ":"', () => {
    expect(() => assertKeyPrefix('trip:')).not.toThrow();
  });
  it.each(['trip', '', ':'])('rejects "%s"', (p) => {
    expect(() => assertKeyPrefix(p)).toThrow(/keyPrefix/);
    expect(() => RedisModule.forRoot({ url: 'redis://x', keyPrefix: p })).toThrow();
  });
});

describe('schema names', () => {
  it('validates identifiers and builds a pgSchema', () => {
    expect(serviceSchema('trip').schemaName).toBe('trip');
    expect(() => assertSchemaName('x; drop')).toThrow(/Invalid/);
    expect(() => assertSchemaName('Trip')).toThrow();
  });
});
