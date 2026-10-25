import { z } from 'zod';
import { baseEnvSchema } from '@rideshare/common';
import { WS_ENDED_TRIP_RETENTION_MS } from '@rideshare/contracts';

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
  /** Secret for the `gateway` service client (service tokens for the live-view poller). */
  GATEWAY_CLIENT_SECRET: z.string().min(1),
  /** Live-view poll cadence for drivers, riders, trips and sim state. */
  WS_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(250),
  /** Live-view stats cadence. */
  WS_STATS_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  /** How long an ended trip stays in the live model before it is removed. */
  WS_ENDED_TRIP_RETENTION_MS: z.coerce.number().int().min(0).default(WS_ENDED_TRIP_RETENTION_MS),
  /** Per-client `bufferedAmount` above which diffs are skipped and a fresh snapshot is owed. */
  WS_BACKPRESSURE_BYTES: z.coerce.number().int().positive().default(1_048_576),
  /** Unreferenced display-info entries are evicted after this long. */
  WS_USER_CACHE_TTL_MS: z.coerce.number().int().positive().default(60_000),
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
