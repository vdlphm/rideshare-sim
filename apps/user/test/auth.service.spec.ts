import { UnauthorizedException } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth/auth.service';
import { KeyService } from '../src/keys/key.service';
import { TokenService, hashRefreshToken } from '../src/tokens/token.service';
import { FakeRefreshStore, FakeServiceClients, FakeUsersRepository } from './fakes';

let dir: string;
let keys: KeyService;
let now = Date.UTC(2026, 9, 23, 12, 0, 0);
let users: FakeUsersRepository;
let clients: FakeServiceClients;
let store: FakeRefreshStore;
let auth: AuthService;
let userId: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'auth-'));
  keys = new KeyService({ KEYS_DIR: dir });
  await keys.init();
});
afterAll(() => rm(dir, { recursive: true, force: true }));

beforeEach(async () => {
  now = Date.UTC(2026, 9, 23, 12, 0, 0);
  users = new FakeUsersRepository();
  clients = new FakeServiceClients();
  store = new FakeRefreshStore();
  const clock = () => now;
  const tokens = new TokenService(
    keys,
    { ACCESS_TOKEN_TTL_S: 900, REFRESH_TOKEN_TTL_S: 7 * 86400 },
    clock,
  );
  auth = new AuthService(users, clients, store, tokens, clock);
  userId = (
    await users.createWithProfile({
      email: 'a@example.com',
      passwordHash: await bcrypt.hash('password-1', 4),
      name: 'A',
      role: 'driver',
    })
  ).id;
  await clients.upsert({
    clientId: 'trip',
    name: 'trip',
    secretHash: await bcrypt.hash('s3cret', 4),
  });
});

describe('login', () => {
  it('returns a pair whose access token carries sub and role; stores only a hash', async () => {
    const pair = await auth.login('A@Example.com ', 'password-1');
    expect(decodeJwt(pair.accessToken)).toMatchObject({ sub: userId, role: 'driver' });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.tokenHash).toBe(hashRefreshToken(pair.refreshToken));
    expect(JSON.stringify(store.rows)).not.toContain(pair.refreshToken);
  });

  it('gives the same 401 for wrong password and unknown email', async () => {
    const wrongPw = await auth.login('a@example.com', 'nope').catch((e) => e);
    const noUser = await auth.login('x@example.com', 'password-1').catch((e) => e);
    for (const e of [wrongPw, noUser]) expect(e).toBeInstanceOf(UnauthorizedException);
    expect(wrongPw.getResponse()).toEqual(noUser.getResponse());
  });
});

describe('refresh', () => {
  it('rotates: revokes the old token and issues a new one in the same family', async () => {
    const first = await auth.login('a@example.com', 'password-1');
    const second = await auth.refresh(first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(decodeJwt(second.accessToken)).toMatchObject({ sub: userId, role: 'driver' });
    const [old, fresh] = store.rows;
    expect(old!.revokedAt).not.toBeNull();
    expect(fresh!.revokedAt).toBeNull();
    expect(fresh!.familyId).toBe(old!.familyId);
  });

  it('treats reuse of a revoked token as theft: 401 and the whole family is revoked', async () => {
    const first = await auth.login('a@example.com', 'password-1');
    const second = await auth.refresh(first.refreshToken);
    await expect(auth.refresh(first.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(store.rows.every((r) => r.revokedAt)).toBe(true);
    await expect(auth.refresh(second.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('does not revoke other families on reuse', async () => {
    const a = await auth.login('a@example.com', 'password-1');
    const b = await auth.login('a@example.com', 'password-1');
    await auth.refresh(a.refreshToken);
    await auth.refresh(a.refreshToken).catch(() => undefined);
    expect(
      store.rows.find((r) => r.tokenHash === hashRefreshToken(b.refreshToken))!.revokedAt,
    ).toBeNull();
  });

  it('rejects unknown and expired tokens', async () => {
    await expect(auth.refresh('unknown')).rejects.toBeInstanceOf(UnauthorizedException);
    const pair = await auth.login('a@example.com', 'password-1');
    now += 7 * 86400_000 + 1;
    await expect(auth.refresh(pair.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('serviceToken', () => {
  it('issues a service token with sub = client id', async () => {
    const res = await auth.serviceToken('trip', 's3cret');
    expect(res.expiresIn).toBe(900);
    expect(decodeJwt(res.accessToken)).toMatchObject({ sub: 'trip', role: 'service' });
  });

  it('rejects a bad secret and an unknown client', async () => {
    await expect(auth.serviceToken('trip', 'bad')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(auth.serviceToken('ghost', 's3cret')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
