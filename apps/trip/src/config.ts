import { z } from 'zod';
import { baseEnvSchema } from '@rideshare/common';

export const tripEnvSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().min(0).max(65535).default(3004),
  SERVICE_NAME: z.string().min(1).default('trip-service'),
  DATABASE_URL: z.string().min(1),
});

export type TripEnv = z.infer<typeof tripEnvSchema>;
