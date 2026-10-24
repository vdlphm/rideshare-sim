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
  /** Bots log in through the gateway; /ready never depends on it (the gateway waits for us). */
  GATEWAY_URL: z.string().min(1).default('http://gateway:8080'),
  ROUTING_URL: z.string().min(1).default('http://routing:3006'),
  USER_SERVICE_URL: z.string().min(1).default('http://user:3001'),
  SIMULATOR_CLIENT_SECRET: z.string().min(1),
  /** Shared password of all sim bot accounts (min 8 chars: registration requires it). */
  SIM_BOT_PASSWORD: z.string().min(8),
  SIM_BOTS_ENABLED: boolish.default(true),
  SIM_MAX_ACTIVE_RIDERS: z.coerce.number().int().positive().default(100),
  SIM_BOT_MAX_IN_FLIGHT: z.coerce.number().int().positive().default(20),
  OFFER_TTL_SIM_MS: z.coerce.number().int().positive().default(15_000),
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
