import { Inject, Injectable } from '@nestjs/common';
import { InjectConfig } from '@rideshare/common';
import type { Role } from '@rideshare/contracts';
import { SignJWT } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { CLOCK, type Clock } from '../clock';
import type { UserEnv } from '../config';
import { KeyService, SIGNING_ALG } from '../keys/key.service';

export const ISSUER = 'rideshare-user-service';

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class TokenService {
  constructor(
    private readonly keys: KeyService,
    @InjectConfig()
    private readonly cfg: Pick<UserEnv, 'ACCESS_TOKEN_TTL_S' | 'REFRESH_TOKEN_TTL_S'>,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** RS256 access token: header `kid`; claims `sub`, `role`, `iss`, `iat`, `exp`. */
  async signAccessToken(sub: string, role: Role): Promise<{ token: string; expiresIn: number }> {
    const iat = Math.floor(this.clock() / 1000);
    const expiresIn = this.cfg.ACCESS_TOKEN_TTL_S;
    const token = await new SignJWT({ role })
      .setProtectedHeader({ alg: SIGNING_ALG, kid: this.keys.kid, typ: 'JWT' })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setIssuedAt(iat)
      .setExpirationTime(iat + expiresIn)
      .sign(this.keys.privateKey);
    return { token, expiresIn };
  }

  /** Opaque 32-byte random token; only its SHA-256 hash is ever stored. */
  newRefreshToken(): { token: string; hash: string; expiresAt: Date } {
    const token = randomBytes(32).toString('base64url');
    return {
      token,
      hash: hashRefreshToken(token),
      expiresAt: new Date(this.clock() + this.cfg.REFRESH_TOKEN_TTL_S * 1000),
    };
  }
}
