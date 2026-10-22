import { z } from 'zod';
import { baseEnvSchema } from '@rideshare/common';

const url = (def: string) => z.url().default(def);

export const gatewayEnvSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  SERVICE_NAME: z.string().min(1).default('gateway'),
  USER_SERVICE_URL: url('http://user:3001'),
  RIDER_SERVICE_URL: url('http://rider:3002'),
  DRIVER_SERVICE_URL: url('http://driver:3003'),
  TRIP_SERVICE_URL: url('http://trip:3004'),
  MATCHING_SERVICE_URL: url('http://matching:3005'),
  ROUTING_SERVICE_URL: url('http://routing:3006'),
  SIMULATOR_SERVICE_URL: url('http://simulator:3007'),
  /** Upstream response timeout; exceeded -> 504. */
  PROXY_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** Minimum gap between JWKS refetches triggered by an unknown `kid`. */
  JWKS_COOLDOWN_MS: z.coerce.number().int().min(0).default(30_000),
  /** How long a fetched JWKS is trusted before a refetch. */
  JWKS_CACHE_MAX_AGE_MS: z.coerce.number().int().positive().default(300_000),
});

export type GatewayEnv = z.infer<typeof gatewayEnvSchema>;

export const SERVICE_URL_KEYS = {
  user: 'USER_SERVICE_URL',
  rider: 'RIDER_SERVICE_URL',
  driver: 'DRIVER_SERVICE_URL',
  trip: 'TRIP_SERVICE_URL',
  matching: 'MATCHING_SERVICE_URL',
  routing: 'ROUTING_SERVICE_URL',
  simulator: 'SIMULATOR_SERVICE_URL',
} as const satisfies Record<string, keyof GatewayEnv>;
