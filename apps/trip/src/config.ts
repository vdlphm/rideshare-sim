import { z } from 'zod';
import { baseEnvSchema } from '@rideshare/common';

export const tripEnvSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().min(0).max(65535).default(3004),
  SERVICE_NAME: z.string().min(1).default('trip-service'),
  DATABASE_URL: z.string().min(1),
  USER_SERVICE_URL: z.string().min(1).default('http://user:3001'),
  ROUTING_URL: z.string().min(1).default('http://routing:3006'),
  DRIVER_URL: z.string().min(1).default('http://driver:3003'),
  MATCHING_URL: z.string().min(1).default('http://matching:3005'),
  SIMULATOR_URL: z.string().min(1).default('http://simulator:3007'),
  /** Client-credentials secret for service tokens (client id `trip`). */
  TRIP_CLIENT_SECRET: z.string().min(1),
  /** Real ms between dispatcher sweeps. */
  DISPATCH_SWEEP_MS: z.coerce.number().int().positive().default(10_000),
  /** A REQUESTED trip older than this (sim ms) is re-dispatched to matching by the sweep. */
  DISPATCH_RETRY_AFTER_SIM_MS: z.coerce.number().int().nonnegative().default(15_000),
});

export type TripEnv = z.infer<typeof tripEnvSchema>;
