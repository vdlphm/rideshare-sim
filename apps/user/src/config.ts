import { z } from 'zod';
import { baseEnvSchema } from '@rideshare/common';

const secret = z.string().min(1);

export const userEnvSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().min(0).max(65535).default(3001),
  SERVICE_NAME: z.string().min(1).default('user-service'),
  DATABASE_URL: z.string().min(1),
  KEYS_DIR: z.string().min(1),
  ACCESS_TOKEN_TTL_S: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_S: z.coerce
    .number()
    .int()
    .positive()
    .default(7 * 24 * 3600),
  ADMIN_EMAIL: z.email(),
  ADMIN_PASSWORD: z.string().min(8),
  GATEWAY_CLIENT_SECRET: secret,
  RIDER_CLIENT_SECRET: secret,
  DRIVER_CLIENT_SECRET: secret,
  TRIP_CLIENT_SECRET: secret,
  MATCHING_CLIENT_SECRET: secret,
  SIMULATOR_CLIENT_SECRET: secret,
});

export type UserEnv = z.infer<typeof userEnvSchema>;

/** Internal callers that may obtain service tokens, with the env var holding each secret. */
export const SERVICE_CLIENTS = [
  ['gateway', 'GATEWAY_CLIENT_SECRET'],
  ['rider', 'RIDER_CLIENT_SECRET'],
  ['driver', 'DRIVER_CLIENT_SECRET'],
  ['trip', 'TRIP_CLIENT_SECRET'],
  ['matching', 'MATCHING_CLIENT_SECRET'],
  ['simulator', 'SIMULATOR_CLIENT_SECRET'],
] as const satisfies readonly (readonly [string, keyof UserEnv])[];
