import { resolve } from 'node:path';
import { DockerComposeEnvironment, Wait, type StartedDockerComposeEnvironment } from 'testcontainers';

export const COMPOSE_DIR = resolve(__dirname, '../../infra');
export const COMPOSE_FILE = 'docker-compose.yml';

export const PASSWORDS = {
  POSTGRES_PASSWORD: 'pg-admin-test',
  USER_SERVICE_DB_PASSWORD: 'pg-user-test',
  TRIP_SERVICE_DB_PASSWORD: 'pg-trip-test',
  MATCHING_SERVICE_DB_PASSWORD: 'pg-matching-test',
  REDIS_RIDER_PASSWORD: 'rd-rider-test',
  REDIS_DRIVER_PASSWORD: 'rd-driver-test',
  REDIS_MATCHING_PASSWORD: 'rd-matching-test',
  REDIS_ROUTING_PASSWORD: 'rd-routing-test',
} as const;

/** Test values for everything the application services need from the environment. */
export const SERVICE_ENV = {
  ADMIN_EMAIL: 'admin@example.com',
  ADMIN_PASSWORD: 'admin-pass-1',
  GATEWAY_CLIENT_SECRET: 'gateway-secret',
  RIDER_CLIENT_SECRET: 'rider-secret',
  DRIVER_CLIENT_SECRET: 'driver-secret',
  TRIP_CLIENT_SECRET: 'trip-secret',
  MATCHING_CLIENT_SECRET: 'matching-secret',
  SIMULATOR_CLIENT_SECRET: 'simulator-secret',
  SIM_BOT_PASSWORD: 'sim-bot-password',
  // Scripted tests drive the API themselves; the bot E2E turns this back on.
  SIM_BOTS_ENABLED: 'false',
} as const;

/**
 * Starts only postgres and redis from the real compose file. No host ports are published,
 * so tests run psql / redis-cli with `exec` inside the containers instead of using a
 * port-publishing override: the file under test stays exactly what ships.
 */
export async function startStack(suffix: string): Promise<StartedDockerComposeEnvironment> {
  return new DockerComposeEnvironment(COMPOSE_DIR, COMPOSE_FILE)
    .withProjectName(`rideshare-it-${suffix}-${process.pid}`)
    .withEnvironment({ ...PASSWORDS, ...SERVICE_ENV })
    .withWaitStrategy('postgres-1', Wait.forHealthCheck())
    .withWaitStrategy('redis-1', Wait.forHealthCheck())
    .withStartupTimeout(180_000)
    .up(['postgres', 'redis']);
}
