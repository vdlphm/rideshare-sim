import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { ServiceTokenResponse, TokenPair } from '@rideshare/contracts';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { CLOCK, type Clock } from '../clock';
import { TokenService, hashRefreshToken } from '../tokens/token.service';
import { BCRYPT_COST } from '../users/users.service';
import { UsersRepository } from '../users/users.repository';
import { normalizeEmail } from './email';
import { RefreshTokenStore } from './refresh-token.store';
import { ServiceClientsRepository } from './service-clients.repository';

// Compared against when the account/client is unknown so timing doesn't reveal existence.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_COST);

const invalidCredentials = () => new UnauthorizedException('Invalid credentials');
const invalidRefresh = () => new UnauthorizedException('Invalid refresh token');

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersRepository,
    private readonly clients: ServiceClientsRepository,
    private readonly refreshTokens: RefreshTokenStore,
    private readonly tokens: TokenService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async login(email: string, password: string): Promise<TokenPair> {
    const user = await this.users.findByEmail(normalizeEmail(email));
    const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw invalidCredentials();
    return this.issuePair(user.id, user.role, randomUUID());
  }

  /** Rotation: a valid token is revoked and replaced; a revoked one signals theft. */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const next = this.tokens.newRefreshToken();
    const now = new Date(this.clock());
    const outcome = await this.refreshTokens.transaction(async (tx) => {
      const current = await tx.findByHash(hashRefreshToken(refreshToken));
      if (!current) return { kind: 'invalid' as const };
      if (current.revokedAt) {
        await tx.revokeFamily(current.familyId, now);
        return { kind: 'reuse' as const };
      }
      if (current.expiresAt.getTime() <= now.getTime()) return { kind: 'invalid' as const };
      await tx.revoke(current.id, now);
      await tx.insert({
        userId: current.userId,
        familyId: current.familyId,
        tokenHash: next.hash,
        expiresAt: next.expiresAt,
      });
      return { kind: 'ok' as const, userId: current.userId };
    });
    if (outcome.kind !== 'ok') throw invalidRefresh();

    const user = await this.users.findById(outcome.userId);
    if (!user) throw invalidRefresh();
    const access = await this.tokens.signAccessToken(user.id, user.role);
    return { accessToken: access.token, refreshToken: next.token };
  }

  async serviceToken(clientId: string, clientSecret: string): Promise<ServiceTokenResponse> {
    const client = await this.clients.find(clientId);
    const ok = await bcrypt.compare(clientSecret, client?.secretHash ?? DUMMY_HASH);
    if (!client || !ok) throw invalidCredentials();
    const access = await this.tokens.signAccessToken(client.clientId, 'service');
    return { accessToken: access.token, expiresIn: access.expiresIn };
  }

  private async issuePair(
    userId: string,
    role: 'rider' | 'driver' | 'admin' | 'service',
    familyId: string,
  ): Promise<TokenPair> {
    const refresh = this.tokens.newRefreshToken();
    await this.refreshTokens.insert({
      userId,
      familyId,
      tokenHash: refresh.hash,
      expiresAt: refresh.expiresAt,
    });
    const access = await this.tokens.signAccessToken(userId, role);
    return { accessToken: access.token, refreshToken: refresh.token };
  }
}
