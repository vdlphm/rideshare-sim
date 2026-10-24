import { z } from 'zod';
import { baseEnvSchema } from '@rideshare/common';

export const riderEnvSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().min(0).max(65535).default(3002),
  SERVICE_NAME: z.string().min(1).default('rider-service'),
  REDIS_URL: z.string().min(1),
  REDIS_KEY_PREFIX: z.string().min(2).default('rider:'),
  POSITION_TTL_S: z.coerce.number().int().positive().default(600),
});

export type RiderEnv = z.infer<typeof riderEnvSchema>;
