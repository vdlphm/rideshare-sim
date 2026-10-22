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
import type { UserDisplay, Vehicle } from '@rideshare/contracts';
import type {
  NewUser,
  ProfileUpdate,
  UserProfile,
  UserRecord,
  UsersRepository,
} from '../src/users/users.repository';

export class FakeUsersRepository implements UsersRepository {
  users: UserRecord[] = [];
  created: NewUser[] = [];
  failWith?: unknown;
  phones = new Map<string, string>();
  vehicles = new Map<string, Vehicle>();
  batchCalls: string[][] = [];

  private profile(u: UserRecord): UserProfile {
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      phone: this.phones.get(u.id) ?? null,
      role: u.role,
      vehicle: this.vehicles.get(u.id) ?? null,
    };
  }
  async findProfileById(id: string) {
    const u = this.users.find((x) => x.id === id);
    return u && this.profile(u);
  }
  async updateProfile(id: string, update: ProfileUpdate) {
    if (this.failWith) throw this.failWith;
    const u = this.users.find((x) => x.id === id);
    if (!u) return undefined;
    if (update.name !== undefined) u.name = update.name;
    if (update.phone !== undefined) this.phones.set(id, update.phone);
    if (update.vehicle) this.vehicles.set(id, update.vehicle);
    return this.profile(u);
  }
  async findDisplayByIds(ids: string[]): Promise<UserDisplay[]> {
    this.batchCalls.push(ids);
    return this.users
      .filter((u) => ids.includes(u.id))
      .map((u) => ({
        id: u.id,
        name: u.name,
        role: u.role,
        vehicle: this.vehicles.get(u.id) ?? null,
      }));
  }

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
    if (input.phone) this.phones.set(id, input.phone);
    if (input.vehicle) this.vehicles.set(id, input.vehicle);
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
