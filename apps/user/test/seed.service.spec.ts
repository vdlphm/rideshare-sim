import bcrypt from 'bcryptjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { SeedService } from '../src/seed/seed.service';
import type { UserEnv } from '../src/config';
import { FakeServiceClients, FakeUsersRepository } from './fakes';

const cfg = {
  ADMIN_EMAIL: 'Admin@Example.com',
  ADMIN_PASSWORD: 'admin-pass-1',
  GATEWAY_CLIENT_SECRET: 'g',
  RIDER_CLIENT_SECRET: 'r',
  DRIVER_CLIENT_SECRET: 'd',
  TRIP_CLIENT_SECRET: 't',
  MATCHING_CLIENT_SECRET: 'm',
  SIMULATOR_CLIENT_SECRET: 's',
} as UserEnv;

let users: FakeUsersRepository;
let clients: FakeServiceClients;
beforeEach(() => {
  users = new FakeUsersRepository();
  clients = new FakeServiceClients();
});

describe('SeedService', () => {
  it('seeds the admin and six clients, and is idempotent', async () => {
    const seed = new SeedService(cfg, users, clients);
    await seed.seed();
    const hashes = [...clients.rows.values()].map((c) => c.secretHash);
    await seed.seed();
    expect(users.users).toHaveLength(1);
    expect(users.users[0]).toMatchObject({ role: 'admin', email: 'admin@example.com' });
    expect([...clients.rows.keys()].sort()).toEqual(
      ['driver', 'gateway', 'matching', 'rider', 'simulator', 'trip'].sort(),
    );
    expect(clients.upserts).toBe(6);
    expect([...clients.rows.values()].map((c) => c.secretHash)).toEqual(hashes);
  });

  it('updates hashes when secrets change', async () => {
    await new SeedService(cfg, users, clients).seed();
    await new SeedService(
      { ...cfg, TRIP_CLIENT_SECRET: 'new', ADMIN_PASSWORD: 'new-admin-pw' },
      users,
      clients,
    ).seed();
    expect(await bcrypt.compare('new', clients.rows.get('trip')!.secretHash)).toBe(true);
    expect(await bcrypt.compare('new-admin-pw', users.users[0]!.passwordHash)).toBe(true);
    expect(clients.upserts).toBe(7);
  });

  it('refuses to adopt a non-admin account as the admin', async () => {
    await users.createWithProfile({
      email: 'admin@example.com',
      passwordHash: 'x',
      name: 'x',
      role: 'rider',
    });
    await expect(new SeedService(cfg, users, clients).seed()).rejects.toThrow(/non-admin/);
  });
});
