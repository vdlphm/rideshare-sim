import { Injectable } from '@nestjs/common';
import { InjectDb, type Db } from '@rideshare/common';
import { and, eq, isNull } from 'drizzle-orm';
import { refreshTokens } from '../db/schema';

export interface RefreshTokenRow {
  id: string;
  userId: string;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface NewRefreshToken {
  userId: string;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
}

/** Operations available inside one atomic unit of work. */
export interface RefreshTokenTx {
  /** Locks the row (when the backend supports it) so concurrent rotations serialize. */
  findByHash(tokenHash: string): Promise<RefreshTokenRow | undefined>;
  revoke(id: string, at: Date): Promise<void>;
  revokeFamily(familyId: string, at: Date): Promise<void>;
  insert(row: NewRefreshToken): Promise<void>;
}

export abstract class RefreshTokenStore {
  abstract insert(row: NewRefreshToken): Promise<void>;
  abstract transaction<T>(fn: (tx: RefreshTokenTx) => Promise<T>): Promise<T>;
}

@Injectable()
export class DrizzleRefreshTokenStore extends RefreshTokenStore {
  constructor(@InjectDb() private readonly db: Db) {
    super();
  }

  async insert(row: NewRefreshToken): Promise<void> {
    await this.db.insert(refreshTokens).values(row);
  }

  transaction<T>(fn: (tx: RefreshTokenTx) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) =>
      fn({
        async findByHash(tokenHash) {
          const [row] = await tx
            .select({
              id: refreshTokens.id,
              userId: refreshTokens.userId,
              familyId: refreshTokens.familyId,
              tokenHash: refreshTokens.tokenHash,
              expiresAt: refreshTokens.expiresAt,
              revokedAt: refreshTokens.revokedAt,
            })
            .from(refreshTokens)
            .where(eq(refreshTokens.tokenHash, tokenHash))
            .for('update');
          return row;
        },
        async revoke(id, at) {
          await tx.update(refreshTokens).set({ revokedAt: at }).where(eq(refreshTokens.id, id));
        },
        async revokeFamily(familyId, at) {
          await tx
            .update(refreshTokens)
            .set({ revokedAt: at })
            .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
        },
        async insert(row) {
          await tx.insert(refreshTokens).values(row);
        },
      }),
    );
  }
}
