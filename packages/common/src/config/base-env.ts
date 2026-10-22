import { z } from 'zod';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** Env vars every service shares. Services extend it: `baseEnvSchema.extend({ ... })`. */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  SERVICE_NAME: z.string().min(1),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;
