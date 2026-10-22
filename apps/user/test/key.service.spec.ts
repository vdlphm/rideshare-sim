import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calculateJwkThumbprint } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { KeyService, PRIVATE_KEY_FILE } from '../src/keys/key.service';

const dirs: string[] = [];
async function tmp() {
  const d = await mkdtemp(join(tmpdir(), 'keys-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('KeyService', () => {
  it('generates a key on first boot with a 0600 private file and RFC 7638 kid', async () => {
    const dir = join(await tmp(), 'nested');
    const svc = new KeyService({ KEYS_DIR: dir });
    await svc.init();

    const mode = (await stat(join(dir, PRIVATE_KEY_FILE))).mode & 0o777;
    expect(mode).toBe(0o600);
    const { kid, alg, use, ...jwk } = svc.publicJwk;
    expect(alg).toBe('RS256');
    expect(use).toBe('sig');
    expect(kid).toBe(await calculateJwkThumbprint(jwk, 'sha256'));
    expect(svc.publicJwk).not.toHaveProperty('d');
  });

  it('reuses the persisted key on the next boot', async () => {
    const dir = await tmp();
    const a = new KeyService({ KEYS_DIR: dir });
    await a.init();
    const b = new KeyService({ KEYS_DIR: dir });
    await b.init();
    expect(b.kid).toBe(a.kid);
    expect(b.publicJwk.n).toBe(a.publicJwk.n);
  });

  it('tightens loose permissions on an existing private key', async () => {
    const dir = await tmp();
    await new KeyService({ KEYS_DIR: dir }).init();
    const { chmod } = await import('node:fs/promises');
    await chmod(join(dir, PRIVATE_KEY_FILE), 0o644);
    await new KeyService({ KEYS_DIR: dir }).init();
    expect((await stat(join(dir, PRIVATE_KEY_FILE))).mode & 0o777).toBe(0o600);
  });

  it('throws when used before init', () => {
    expect(() => new KeyService({ KEYS_DIR: '/nope' }).kid).toThrow(/not initialised/);
  });
});
