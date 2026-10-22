import { index, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// `pgSchema` directly (not common's `serviceSchema`) so drizzle-kit can load this file
// without a built @rideshare/common.
export const userSchema = pgSchema('user_service');

export const userRole = userSchema.enum('user_role', ['rider', 'driver', 'admin', 'service']);

export const users = userSchema.table('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: userRole('role').notNull(),
  name: text('name').notNull(),
  phone: text('phone'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const riderProfiles = userSchema.table('rider_profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const driverProfiles = userSchema.table('driver_profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  vehicleMake: text('vehicle_make').notNull(),
  vehicleModel: text('vehicle_model').notNull(),
  vehicleColor: text('vehicle_color').notNull(),
  vehiclePlate: text('vehicle_plate').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const refreshTokens = userSchema.table(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** All tokens descended from one login share a family, for reuse detection. */
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('refresh_tokens_family_id_idx').on(t.familyId)],
);

export const serviceClients = userSchema.table('service_clients', {
  clientId: text('client_id').primaryKey(),
  secretHash: text('secret_hash').notNull(),
  name: text('name').notNull(),
});
