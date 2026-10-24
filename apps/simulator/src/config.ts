import { z } from 'zod';
import { baseEnvSchema } from '@rideshare/common';
import { SimConfigSchema, type SimConfig } from '@rideshare/contracts';

const boolish = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((v) => v === true || v === 'true');

export const simulatorEnvSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().min(0).max(65535).default(3007),
  SERVICE_NAME: z.string().min(1).default('simulator'),
  SIM_DEFAULT_SPEED: z.coerce.number().default(1),
  SIM_DEFAULT_DRIVER_COUNT: z.coerce.number().default(50),
  SIM_DEFAULT_SPAWN_INTERVAL_S: z.coerce.number().default(3),
  SIM_DEFAULT_ACCEPT_PROBABILITY: z.coerce.number().default(0.9),
  SIM_START_PAUSED: boolish.default(false),
});

export type SimulatorEnv = z.infer<typeof simulatorEnvSchema>;

/** Builds the initial SimConfig from env, validated against the shared contract. */
export function defaultSimConfig(env: SimulatorEnv): SimConfig {
  return SimConfigSchema.parse({
    driverCount: env.SIM_DEFAULT_DRIVER_COUNT,
    spawnIntervalS: env.SIM_DEFAULT_SPAWN_INTERVAL_S,
    speed: env.SIM_DEFAULT_SPEED,
    paused: env.SIM_START_PAUSED,
    acceptProbability: env.SIM_DEFAULT_ACCEPT_PROBABILITY,
  });
}
