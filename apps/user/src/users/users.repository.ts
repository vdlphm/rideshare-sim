import { Injectable } from '@nestjs/common';
import { InjectDb, type Db } from '@rideshare/common';
import type { Role, UserDisplay, UserMe, Vehicle } from '@rideshare/contracts';
import { eq, inArray } from 'drizzle-orm';
import { driverProfiles, riderProfiles, users } from '../db/schema';

export interface NewUser {
  email: string;
  passwordHash: string;
  name: string;
  phone?: string;
  role: 'rider' | 'driver';
  vehicle?: Vehicle;
}

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  name: string;
}

/** A user's profile as exposed to the API: no password hash, vehicle only for drivers. */
export interface UserProfile extends UserMe {
  phone: string | null;
  vehicle: Vehicle | null;
}

export interface ProfileUpdate {
  name?: string;
  phone?: string;
  vehicle?: Vehicle;
}

export abstract class UsersRepository {
  /** Inserts the user and its rider/driver profile in one transaction. */
  abstract createWithProfile(input: NewUser): Promise<{ id: string }>;
  abstract findByEmail(email: string): Promise<UserRecord | undefined>;
  abstract findById(id: string): Promise<UserRecord | undefined>;
  abstract createAdmin(input: {
    email: string;
    passwordHash: string;
    name: string;
  }): Promise<{ id: string }>;
  abstract updatePasswordHash(id: string, passwordHash: string): Promise<void>;
  abstract findProfileById(id: string): Promise<UserProfile | undefined>;
  /**
   * Updates users (and driver_profiles when a vehicle is given) in one transaction and
   * returns the new profile, or undefined if the user doesn't exist.
   */
  abstract updateProfile(id: string, update: ProfileUpdate): Promise<UserProfile | undefined>;
  /** Display info for the ids that exist, in one query. Order is not guaranteed. */
  abstract findDisplayByIds(ids: string[]): Promise<UserDisplay[]>;
}

const profileColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  phone: users.phone,
  role: users.role,
  make: driverProfiles.vehicleMake,
  model: driverProfiles.vehicleModel,
  color: driverProfiles.vehicleColor,
  plate: driverProfiles.vehiclePlate,
};

type ProfileRow = {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  role: Role;
  make: string | null;
  model: string | null;
  color: string | null;
  plate: string | null;
};

function toVehicle(r: ProfileRow): Vehicle | null {
  if (r.make === null || r.model === null || r.color === null || r.plate === null) return null;
  return { make: r.make, model: r.model, color: r.color, plate: r.plate };
}

function toProfile(r: ProfileRow): UserProfile {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    phone: r.phone,
    role: r.role,
    vehicle: toVehicle(r),
  };
}

const userColumns = {
  id: users.id,
  email: users.email,
  passwordHash: users.passwordHash,
  role: users.role,
  name: users.name,
};

@Injectable()
export class DrizzleUsersRepository extends UsersRepository {
  constructor(@InjectDb() private readonly db: Db) {
    super();
  }

  createWithProfile(input: NewUser): Promise<{ id: string }> {
    return this.db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          email: input.email,
          passwordHash: input.passwordHash,
          role: input.role,
          name: input.name,
          phone: input.phone ?? null,
        })
        .returning({ id: users.id });
      if (!user) throw new Error('insert into users returned no row');
      if (input.role === 'driver') {
        const v = input.vehicle;
        if (!v) throw new Error('driver registration requires a vehicle');
        await tx.insert(driverProfiles).values({
          userId: user.id,
          vehicleMake: v.make,
          vehicleModel: v.model,
          vehicleColor: v.color,
          vehiclePlate: v.plate,
        });
      } else {
        await tx.insert(riderProfiles).values({ userId: user.id });
      }
      return { id: user.id };
    });
  }

  async findByEmail(email: string): Promise<UserRecord | undefined> {
    const [row] = await this.db.select(userColumns).from(users).where(eq(users.email, email));
    return row;
  }

  async findById(id: string): Promise<UserRecord | undefined> {
    const [row] = await this.db.select(userColumns).from(users).where(eq(users.id, id));
    return row;
  }

  async createAdmin(input: {
    email: string;
    passwordHash: string;
    name: string;
  }): Promise<{ id: string }> {
    const [row] = await this.db
      .insert(users)
      .values({ ...input, role: 'admin' })
      .returning({ id: users.id });
    if (!row) throw new Error('insert into users returned no row');
    return row;
  }

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, id));
  }

  async findProfileById(id: string): Promise<UserProfile | undefined> {
    const [row] = await this.db
      .select(profileColumns)
      .from(users)
      .leftJoin(driverProfiles, eq(driverProfiles.userId, users.id))
      .where(eq(users.id, id));
    return row && toProfile(row);
  }

  updateProfile(id: string, update: ProfileUpdate): Promise<UserProfile | undefined> {
    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(users)
        .set({
          updatedAt: new Date(),
          ...(update.name !== undefined && { name: update.name }),
          ...(update.phone !== undefined && { phone: update.phone }),
        })
        .where(eq(users.id, id))
        .returning({ id: users.id });
      if (!updated) return undefined;
      if (update.vehicle) {
        const v = update.vehicle;
        await tx
          .update(driverProfiles)
          .set({
            vehicleMake: v.make,
            vehicleModel: v.model,
            vehicleColor: v.color,
            vehiclePlate: v.plate,
          })
          .where(eq(driverProfiles.userId, id));
      }
      const [row] = await tx
        .select(profileColumns)
        .from(users)
        .leftJoin(driverProfiles, eq(driverProfiles.userId, users.id))
        .where(eq(users.id, id));
      return row && toProfile(row);
    });
  }

  async findDisplayByIds(ids: string[]): Promise<UserDisplay[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select(profileColumns)
      .from(users)
      .leftJoin(driverProfiles, eq(driverProfiles.userId, users.id))
      .where(inArray(users.id, ids));
    return rows.map((r) => ({ id: r.id, name: r.name, role: r.role, vehicle: toVehicle(r) }));
  }
}
