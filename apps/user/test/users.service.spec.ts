import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '@rideshare/common';
import {
  RegisterRequestSchema,
  UpdateMeRequestSchema,
  UsersBatchRequestSchema,
} from '@rideshare/contracts';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { UsersService } from '../src/users/users.service';
import { FakeUsersRepository } from './fakes';

const rider = { email: 'Rider@Example.com', password: 'password-1', name: 'R', role: 'rider' };
const vehicle = { make: 'Toyota', model: 'Prius', color: 'white', plate: 'ABC123' };

const pgError = (constraint: string) =>
  Object.assign(new Error('duplicate key'), { code: '23505', constraint });

describe('UsersService.register', () => {
  it('hashes the password, lowercases the email and returns the new id', async () => {
    const repo = new FakeUsersRepository();
    const res = await new UsersService(repo).register(RegisterRequestSchema.parse(rider));
    expect(res.userId).toBe(repo.users[0]!.id);
    expect(repo.created[0]!.email).toBe('rider@example.com');
    expect(repo.created[0]!.passwordHash).not.toBe('password-1');
    expect(await bcrypt.compare('password-1', repo.created[0]!.passwordHash)).toBe(true);
  });

  it('passes the vehicle through for drivers', async () => {
    const repo = new FakeUsersRepository();
    await new UsersService(repo).register(
      RegisterRequestSchema.parse({ ...rider, role: 'driver', vehicle }),
    );
    expect(repo.created[0]).toMatchObject({ role: 'driver', vehicle });
  });

  it.each([
    ['users_email_unique', 'Email already registered'],
    ['driver_profiles_vehicle_plate_unique', 'Vehicle plate already registered'],
  ])('maps unique violation %s to 409', async (constraint, message) => {
    const repo = new FakeUsersRepository();
    // Drizzle wraps driver errors; the pg error sits on `cause`.
    repo.failWith = Object.assign(new Error('Failed query'), { cause: pgError(constraint) });
    const err = await new UsersService(repo)
      .register(RegisterRequestSchema.parse(rider))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe(message);
  });

  it('rethrows other errors untouched', async () => {
    const repo = new FakeUsersRepository();
    repo.failWith = new Error('connection lost');
    await expect(
      new UsersService(repo).register(RegisterRequestSchema.parse(rider)),
    ).rejects.toThrow('connection lost');
  });
});

describe('register validation (contracts schema)', () => {
  it.each(['admin', 'service'])('rejects self-registering as %s', (role) => {
    expect(RegisterRequestSchema.safeParse({ ...rider, role }).success).toBe(false);
  });
  it('requires a vehicle for drivers', () => {
    expect(RegisterRequestSchema.safeParse({ ...rider, role: 'driver' }).success).toBe(false);
  });
});

describe('UsersService profiles', () => {
  const setup = async () => {
    const repo = new FakeUsersRepository();
    const svc = new UsersService(repo);
    const r = await svc.register(RegisterRequestSchema.parse({ ...rider, phone: '+12065550100' }));
    const d = await svc.register(
      RegisterRequestSchema.parse({ ...rider, email: 'd@example.com', role: 'driver', vehicle }),
    );
    const riderUser: AuthUser = { id: r.userId, role: 'rider', exp: 0 };
    const driverUser: AuthUser = { id: d.userId, role: 'driver', exp: 0 };
    return { repo, svc, riderUser, driverUser };
  };

  it('getMe returns only the caller profile, with vehicle for drivers', async () => {
    const { svc, riderUser, driverUser } = await setup();
    const me = await svc.getMe(riderUser.id);
    expect(me).toMatchObject({ id: riderUser.id, role: 'rider', phone: '+12065550100' });
    expect(me.vehicle).toBeNull();
    expect(me).not.toHaveProperty('passwordHash');
    expect((await svc.getMe(driverUser.id)).vehicle).toEqual(vehicle);
  });

  it('getMe / getById 404 for a missing user', async () => {
    const { svc } = await setup();
    await expect(svc.getMe(randomUUID())).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.getById(randomUUID())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getById returns any user', async () => {
    const { svc, driverUser } = await setup();
    expect((await svc.getById(driverUser.id)).id).toBe(driverUser.id);
  });

  it('updateMe changes name/phone for the caller only', async () => {
    const { svc, riderUser, driverUser } = await setup();
    const res = await svc.updateMe(riderUser, { name: 'New', phone: '+12065550111' });
    expect(res).toMatchObject({ name: 'New', phone: '+12065550111' });
    expect((await svc.getMe(driverUser.id)).name).toBe('R');
  });

  it('lets a driver change the vehicle', async () => {
    const { svc, driverUser } = await setup();
    const v = { ...vehicle, color: 'red', plate: 'ZZZ999' };
    expect((await svc.updateMe(driverUser, { vehicle: v })).vehicle).toEqual(v);
  });

  it.each(['rider', 'admin'] as const)('rejects a vehicle from a %s with 400', async (role) => {
    const { svc, riderUser } = await setup();
    await expect(svc.updateMe({ ...riderUser, role }, { vehicle })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('maps a plate unique violation on update to 409, and rethrows others', async () => {
    const { repo, svc, driverUser } = await setup();
    repo.failWith = Object.assign(new Error('Failed query'), {
      cause: pgError('driver_profiles_vehicle_plate_unique'),
    });
    await expect(svc.updateMe(driverUser, { vehicle })).rejects.toBeInstanceOf(ConflictException);
    repo.failWith = new Error('connection lost');
    await expect(svc.updateMe(driverUser, { vehicle })).rejects.toThrow('connection lost');
  });

  it('updateMe 404s when the user row is gone', async () => {
    const { svc } = await setup();
    await expect(
      svc.updateMe({ id: randomUUID(), role: 'rider', exp: 0 }, { name: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('batchDisplay dedupes ids and skips unknown ones', async () => {
    const { repo, svc, riderUser, driverUser } = await setup();
    const res = await svc.batchDisplay([riderUser.id, riderUser.id, driverUser.id, randomUUID()]);
    expect(repo.batchCalls).toHaveLength(1);
    expect(repo.batchCalls[0]).toHaveLength(3);
    expect(res.map((u) => u.id).sort()).toEqual([riderUser.id, driverUser.id].sort());
    expect(res.find((u) => u.id === driverUser.id)?.vehicle).toEqual(vehicle);
    expect(res[0]).not.toHaveProperty('email');
  });
});

describe('profile validation (contracts schemas)', () => {
  it('rejects an empty update, unknown keys (including id) and an empty batch', () => {
    expect(UpdateMeRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateMeRequestSchema.safeParse({ id: randomUUID(), name: 'x' }).success).toBe(false);
    expect(UsersBatchRequestSchema.safeParse({ ids: [] }).success).toBe(false);
  });
});
