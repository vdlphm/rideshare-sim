import { z } from 'zod';
import { baseEnvSchema } from '@rideshare/common';

export const routingEnvSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().min(0).max(65535).default(3006),
  SERVICE_NAME: z.string().min(1).default('routing-service'),
  OSRM_URL: z.url().default('http://osrm:5000'),
  /** Per-attempt OSRM timeout. */
  OSRM_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  /** e.g. redis://routing:<password>@redis:6379/0 (ACL user `routing`). */
  REDIS_URL: z.string().min(1),
  REDIS_KEY_PREFIX: z.string().regex(/^.+:$/, "must end with ':'").default('routing:'),
  ROUTE_CACHE_TTL_S: z.coerce.number().int().positive().default(3600),
  /** Nearest-road snaps farther than this are rejected with 422. */
  MAX_SNAP_M: z.coerce.number().positive().default(150),
  /** A cache read/write slower than this is abandoned (Redis down must not stall routing). */
  CACHE_TIMEOUT_MS: z.coerce.number().int().positive().default(250),
});

export type RoutingEnv = z.infer<typeof routingEnvSchema>;
