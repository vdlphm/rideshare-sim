import { z } from 'zod';
import { baseEnvSchema } from '@rideshare/common';

export const matchingEnvSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().min(0).max(65535).default(3005),
  SERVICE_NAME: z.string().min(1).default('matching-service'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  REDIS_KEY_PREFIX: z.string().min(2).default('matching:'),
  USER_SERVICE_URL: z.string().min(1).default('http://user:3001'),
  DRIVER_URL: z.string().min(1).default('http://driver:3003'),
  TRIP_URL: z.string().min(1).default('http://trip:3004'),
  ROUTING_URL: z.string().min(1).default('http://routing:3006'),
  SIMULATOR_URL: z.string().min(1).default('http://simulator:3007'),
  /** Client-credentials secret for service tokens (client id `matching`). */
  MATCHING_CLIENT_SECRET: z.string().min(1),
  /** Real ms between sweeps (offer expiry, lock refresh, waiting jobs). */
  SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(250),
  /** Sim ms a driver has to answer an offer. */
  OFFER_TTL_SIM_MS: z.coerce.number().int().positive().default(15_000),
  /** Sim ms after which a job without a driver gives up (trip -> NO_DRIVERS). */
  GIVE_UP_SIM_MS: z.coerce.number().int().positive().default(60_000),
  /** Real ms TTL of a driver lock; the sweeper refreshes it while the offer is pending. */
  LOCK_TTL_MS: z.coerce.number().int().positive().default(15_000),
  /** Min real ms between retries of a job that is waiting for drivers. */
  IDLE_RETRY_MS: z.coerce.number().int().nonnegative().default(1_000),
});

export type MatchingEnv = z.infer<typeof matchingEnvSchema>;
