import { Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@rideshare/common';
import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import type { GatewayEnv } from './config';
import { ROLES } from './routes';

export const ISSUER = 'rideshare-user-service';

export interface VerifiedToken {
  sub: string;
  role: string;
}

export type VerifyResult =
  | { ok: true; token: VerifiedToken }
  | { ok: false; reason: 'invalid' }
  /** The key set could not be obtained: fail closed, but tell the caller it is not their fault. */
  | { ok: false; reason: 'unavailable' };

// Failures that mean "this token is bad" (401). Anything else (JWKS fetch problems) is 503.
const TOKEN_ERRORS = [
  errors.JWTClaimValidationFailed,
  errors.JWTExpired,
  errors.JWTInvalid,
  errors.JWSInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JOSEAlgNotAllowed,
  errors.JWKSNoMatchingKey,
  errors.JWKSMultipleMatchingKeys,
];

@Injectable()
export class TokenVerifier {
  readonly jwksUrl: URL;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(config: ConfigService<GatewayEnv>) {
    this.jwksUrl = new URL('/.well-known/jwks.json', config.get('USER_SERVICE_URL'));
    this.jwks = createRemoteJWKSet(this.jwksUrl, {
      cooldownDuration: config.get('JWKS_COOLDOWN_MS'),
      cacheMaxAge: config.get('JWKS_CACHE_MAX_AGE_MS'),
      timeoutDuration: 5000,
    });
  }

  async verify(jwt: string): Promise<VerifyResult> {
    try {
      const { payload } = await jwtVerify(jwt, this.jwks, {
        algorithms: ['RS256'],
        issuer: ISSUER,
        typ: 'JWT',
        requiredClaims: ['exp', 'iat', 'sub', 'role'],
      });
      const { sub, role } = payload;
      if (typeof sub !== 'string' || sub.length === 0) return { ok: false, reason: 'invalid' };
      if (typeof role !== 'string' || !ROLES.includes(role))
        return { ok: false, reason: 'invalid' };
      return { ok: true, token: { sub, role } };
    } catch (err) {
      if (TOKEN_ERRORS.some((E) => err instanceof E)) return { ok: false, reason: 'invalid' };
      return { ok: false, reason: 'unavailable' };
    }
  }
}

/** Extracts the token from `Authorization: Bearer <jwt>`; null when absent or malformed. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)$/.exec(header);
  return m ? m[1]! : null;
}

/** Single shared instance so there is one JWKS cache for the whole app. */
@Module({ providers: [TokenVerifier], exports: [TokenVerifier] })
export class TokenVerifierModule {}
