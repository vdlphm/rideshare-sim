import { z } from 'zod';
import { baseEnvSchema } from '@rideshare/common';

export const driverEnvSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().min(0).max(65535).default(3003),
  SERVICE_NAME: z.string().min(1).default('driver-service'),
  REDIS_URL: z.string().min(1),
  REDIS_KEY_PREFIX: z.string().min(2).default('driver:'),
  /** A driver with no location update for this long (real ms) is stale. */
  STALE_AFTER_MS: z.coerce.number().int().positive().default(60_000),
  SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
});

export type DriverEnv = z.infer<typeof driverEnvSchema>;
