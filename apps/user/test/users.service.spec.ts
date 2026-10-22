import { ConflictException } from '@nestjs/common';
import { RegisterRequestSchema } from '@rideshare/contracts';
import bcrypt from 'bcryptjs';
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
