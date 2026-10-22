import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectConfig } from '@rideshare/common';
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  calculateJwkThumbprint,
  exportJWK,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  type JWK,
} from 'jose';
import type { UserEnv } from '../config';

export const PRIVATE_KEY_FILE = 'private.pem';
export const PUBLIC_KEY_FILE = 'public.pem';
export const SIGNING_ALG = 'RS256';

export interface PublicJwk extends JWK {
  kid: string;
  alg: typeof SIGNING_ALG;
  use: 'sig';
}

/** Owns the RS256 signing key pair: generated on first boot, persisted as PEM, reused after. */
@Injectable()
export class KeyService implements OnModuleInit {
  private readonly logger = new Logger(KeyService.name);
  private privateKeyObject?: KeyObject;
  private jwk?: PublicJwk;

  constructor(@InjectConfig() private readonly cfg: Pick<UserEnv, 'KEYS_DIR'>) {}

  async onModuleInit(): Promise<void> {
    await this.init();
  }

  async init(): Promise<void> {
    const dir = this.cfg.KEYS_DIR;
    const privatePath = join(dir, PRIVATE_KEY_FILE);
    let pem: string;
    try {
      pem = await readFile(privatePath, 'utf8');
      await chmod(privatePath, 0o600);
      this.logger.log(`Loaded signing key from ${privatePath}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      await mkdir(dir, { recursive: true });
      const { privateKey, publicKey } = await generateKeyPair(SIGNING_ALG, {
        modulusLength: 2048,
        extractable: true,
      });
      pem = await exportPKCS8(privateKey);
      // Write to a temp file then rename so a crash never leaves a truncated key behind.
      const tmp = `${privatePath}.${process.pid}.tmp`;
      await writeFile(tmp, pem, { mode: 0o600 });
      await rename(tmp, privatePath);
      await writeFile(join(dir, PUBLIC_KEY_FILE), await exportSPKI(publicKey), { mode: 0o644 });
      this.logger.log(`Generated a new signing key in ${dir}`);
    }
    this.privateKeyObject = createPrivateKey(pem);
    const publicJwk = await exportJWK(createPublicKey(this.privateKeyObject));
    const kid = await calculateJwkThumbprint(publicJwk, 'sha256');
    this.jwk = { ...publicJwk, kid, alg: SIGNING_ALG, use: 'sig' };
  }

  get privateKey(): KeyObject {
    if (!this.privateKeyObject) throw new Error('KeyService not initialised');
    return this.privateKeyObject;
  }

  get kid(): string {
    return this.publicJwk.kid;
  }

  get publicJwk(): PublicJwk {
    if (!this.jwk) throw new Error('KeyService not initialised');
    return this.jwk;
  }
}
