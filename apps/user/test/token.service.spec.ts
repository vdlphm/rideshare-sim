import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey } from 'node:crypto';
import { decodeProtectedHeader, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KeyService } from '../src/keys/key.service';
import { ISSUER, TokenService, hashRefreshToken } from '../src/tokens/token.service';

let dir: string;
let keys: KeyService;
const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const svc = () =>
  new TokenService(keys, { ACCESS_TOKEN_TTL_S: 900, REFRESH_TOKEN_TTL_S: 7 * 86400 }, () => NOW);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tok-'));
  keys = new KeyService({ KEYS_DIR: dir });
  await keys.init();
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('TokenService', () => {
  it('signs RS256 access tokens with kid header and the expected claims', async () => {
    const { token, expiresIn } = await svc().signAccessToken('user-1', 'rider');
    expect(expiresIn).toBe(900);
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'RS256', kid: keys.kid });

    const { payload } = await jwtVerify(token, createPublicKey(keys.privateKey), {
      issuer: ISSUER,
      currentDate: new Date(NOW),
    });
    expect(payload).toMatchObject({
      sub: 'user-1',
      role: 'rider',
      iss: ISSUER,
      iat: NOW / 1000,
      exp: NOW / 1000 + 900,
    });
  });

  it('rejects an expired token', async () => {
    const { token } = await svc().signAccessToken('u', 'admin');
    await expect(
      jwtVerify(token, createPublicKey(keys.privateKey), {
        currentDate: new Date(NOW + 901_000),
      }),
    ).rejects.toThrow(/exp/);
  });

  it('issues opaque 32-byte refresh tokens stored only as a sha256 hash, valid 7 days', () => {
    const a = svc().newRefreshToken();
    const b = svc().newRefreshToken();
    expect(Buffer.from(a.token, 'base64url')).toHaveLength(32);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(hashRefreshToken(a.token));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).not.toContain(a.token);
    expect(a.expiresAt.getTime()).toBe(NOW + 7 * 86400_000);
  });
});
