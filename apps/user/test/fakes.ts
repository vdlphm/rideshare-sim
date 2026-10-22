import { randomUUID } from 'node:crypto';
import type {
  NewRefreshToken,
  RefreshTokenRow,
  RefreshTokenStore,
  RefreshTokenTx,
} from '../src/auth/refresh-token.store';
import type {
  ServiceClientRecord,
  ServiceClientsRepository,
} from '../src/auth/service-clients.repository';
import type { NewUser, UserRecord, UsersRepository } from '../src/users/users.repository';

export class FakeUsersRepository implements UsersRepository {
  users: UserRecord[] = [];
  created: NewUser[] = [];
  failWith?: unknown;

  async createWithProfile(input: NewUser) {
    if (this.failWith) throw this.failWith;
    this.created.push(input);
    const id = randomUUID();
    this.users.push({
      id,
      email: input.email,
      passwordHash: input.passwordHash,
      role: input.role,
      name: input.name,
    });
    return { id };
  }
  async findByEmail(email: string) {
    return this.users.find((u) => u.email === email);
  }
  async findById(id: string) {
    return this.users.find((u) => u.id === id);
  }
  async createAdmin(input: { email: string; passwordHash: string; name: string }) {
    const id = randomUUID();
    this.users.push({ id, role: 'admin', ...input });
    return { id };
  }
  async updatePasswordHash(id: string, passwordHash: string) {
    const u = this.users.find((x) => x.id === id);
    if (u) u.passwordHash = passwordHash;
  }
}

export class FakeServiceClients implements ServiceClientsRepository {
  rows = new Map<string, ServiceClientRecord>();
  upserts = 0;
  async find(clientId: string) {
    return this.rows.get(clientId);
  }
  async upsert(c: ServiceClientRecord) {
    this.upserts++;
    this.rows.set(c.clientId, c);
  }
}

export class FakeRefreshStore implements RefreshTokenStore {
  rows: RefreshTokenRow[] = [];

  async insert(row: NewRefreshToken) {
    this.rows.push({ id: randomUUID(), revokedAt: null, ...row });
  }
  async transaction<T>(fn: (tx: RefreshTokenTx) => Promise<T>): Promise<T> {
    const rows = this.rows;
    return fn({
      findByHash: async (h) => rows.find((r) => r.tokenHash === h),
      revoke: async (id, at) => {
        const r = rows.find((x) => x.id === id);
        if (r) r.revokedAt = at;
      },
      revokeFamily: async (f, at) => {
        for (const r of rows) if (r.familyId === f && !r.revokedAt) r.revokedAt = at;
      },
      insert: async (row) => {
        rows.push({ id: randomUUID(), revokedAt: null, ...row });
      },
    });
  }
}
