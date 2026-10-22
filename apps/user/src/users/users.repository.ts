import { Injectable } from '@nestjs/common';
import { InjectDb, type Db } from '@rideshare/common';
import type { Role, Vehicle } from '@rideshare/contracts';
import { eq } from 'drizzle-orm';
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
}
