import { describe, expect, it } from 'vitest';
import { driverAccount, driverEmail, riderAccount, vehicleFor } from '../../src/bots/accounts';

describe('bot accounts', () => {
  it('are deterministic and zero-padded', () => {
    expect(driverEmail(7)).toBe('driver-007@sim.local');
    expect(driverAccount(7, 'pw-12345')).toEqual(driverAccount(7, 'pw-12345'));
    expect(riderAccount(12, 'pw-12345').email).toBe('rider-012@sim.local');
    expect(riderAccount(12, 'pw-12345').role).toBe('rider');
  });

  it('give every driver a unique plate and a full vehicle', () => {
    const plates = new Set<string>();
    for (let n = 1; n <= 500; n++) {
      const v = vehicleFor(n);
      expect(v.make && v.model && v.color).toBeTruthy();
      plates.add(v.plate);
    }
    expect(plates.size).toBe(500);
  });
});
