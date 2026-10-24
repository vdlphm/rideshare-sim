import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RouteSchema } from '@rideshare/contracts';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { SignJWT } from 'jose';
import { resolve } from 'node:path';
import request from 'supertest';
import {
  DockerComposeEnvironment,
  Wait,
  type StartedDockerComposeEnvironment,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { OsrmClient } from '../src/osrm.client';

const OSRM_COMPOSE_DIR = resolve(__dirname, '../../../infra/osrm');
// Test-only override that publishes OSRM on a random host port (infra/ stays untouched).
const OSRM_PORT_OVERRIDE = '../../apps/routing/test/osrm-ports.compose.yml';

const PIKE = '47.6097,-122.3422';
const NEEDLE = '47.6205,-122.3493';

let osrmEnv: StartedDockerComposeEnvironment;
let redisContainer: StartedRedisContainer;
let redis: Redis;
let app: INestApplication;
let osrmClient: OsrmClient;

const key = new TextEncoder().encode('any-key-services-do-not-verify');
const token = (role: string) =>
  new SignJWT({ role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(`${role}-1`)
    .setExpirationTime('5m')
    .sign(key);
const bearer = async (role: string) => ({ authorization: `Bearer ${await token(role)}` });

beforeAll(async () => {
  [osrmEnv, redisContainer] = await Promise.all([
    new DockerComposeEnvironment(OSRM_COMPOSE_DIR, ['compose.yml', OSRM_PORT_OVERRIDE])
      .withProjectName('routing-int-osrm')
      .withWaitStrategy('osrm-1', Wait.forHealthCheck())
      .withStartupTimeout(300_000)
      .up(['osrm']),
    new RedisContainer('redis:7.4').start(),
  ]);
  const osrm = osrmEnv.getContainer('osrm-1');
  redis = new Redis(redisContainer.getConnectionUrl());

  const ref = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        PORT: '0',
        OSRM_URL: `http://${osrm.getHost()}:${osrm.getMappedPort(5000)}`,
        REDIS_URL: redisContainer.getConnectionUrl(),
      }),
    ],
  }).compile();
  app = ref.createNestApplication();
  await app.listen(0, '127.0.0.1');
  osrmClient = app.get(OsrmClient);
}, 400_000);

afterAll(async () => {
  await app?.close();
  redis?.disconnect();
  await redisContainer?.stop();
  await osrmEnv?.down({ removeVolumes: true });
}, 120_000);

describe('routing service against real OSRM (Seattle data)', () => {
  it('is ready', async () => {
    const res = await request(app.getHttpServer()).get('/ready').expect(200);
    expect(res.body.checks).toEqual({ redis: 'ok', osrm: 'ok' });
  });

  it('routes Pike Place -> Space Needle, then serves the repeat from cache', async () => {
    await redis.flushall();
    const spy = vi.spyOn(osrmClient, 'route');
    const auth = await bearer('service');

    const first = await request(app.getHttpServer())
      .get('/internal/route')
      .query({ from: PIKE, to: NEEDLE })
      .set(auth)
      .expect(200);
    const route = RouteSchema.parse(first.body);
    expect(route.distanceM).toBeGreaterThan(1500);
    expect(route.distanceM).toBeLessThan(1800); // ~1638 m
    expect(route.durationS).toBeGreaterThan(200);
    expect(route.durationS).toBeLessThan(280);
    expect(route.geometry.length).toBeGreaterThan(10);
    expect(route.durations).toHaveLength(route.geometry.length - 1);
    expect(route.durations.reduce((a, b) => a + b, 0)).toBeCloseTo(route.durationS, 6);
    // geometry is [lng, lat] inside Seattle
    for (const [lng, lat] of route.geometry) {
      expect(lng).toBeGreaterThan(-122.4);
      expect(lng).toBeLessThan(-122.3);
      expect(lat).toBeGreaterThan(47.5);
      expect(lat).toBeLessThan(47.7);
    }
    expect(spy).toHaveBeenCalledTimes(1);

    const cacheKey = 'route:47.60970,-122.34220:47.62050,-122.34930';
    expect(await redis.ttl(`routing:${cacheKey}`)).toBeGreaterThan(3500);

    // Sub-metre difference rounds to the same key -> cache hit, identical body.
    const second = await request(app.getHttpServer())
      .get('/internal/route')
      .query({ from: '47.609700004,-122.3422', to: NEEDLE })
      .set(auth)
      .expect(200);
    expect(second.body).toEqual(first.body);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('answers a 3x1 table', async () => {
    const res = await request(app.getHttpServer())
      .post('/internal/table')
      .set(await bearer('service'))
      .send({
        sources: [
          { lat: 47.6097, lng: -122.3422 },
          { lat: 47.6205, lng: -122.3493 },
          { lat: 47.6062, lng: -122.3321 },
        ],
        destinations: [{ lat: 47.6101, lng: -122.3421 }],
      })
      .expect(200);
    expect(res.body.durations).toHaveLength(3);
    for (const row of res.body.durations) {
      expect(row).toHaveLength(1);
      expect(typeof row[0]).toBe('number');
    }
    expect(res.body.durations[0][0]).toBeLessThan(res.body.durations[1][0]);
  });

  it('snaps a point on a street', async () => {
    const res = await request(app.getHttpServer())
      .get('/internal/nearest')
      .query({ lat: 47.6097, lng: -122.3422 })
      .set(await bearer('service'))
      .expect(200);
    expect(res.body.distanceM).toBeLessThan(20);
    expect(res.body.lat).toBeCloseTo(47.6097, 3);
    expect(res.body.lng).toBeCloseTo(-122.3422, 3);
  });

  it('rejects a point in Elliott Bay (snap > 150 m) with 422', async () => {
    const res = await request(app.getHttpServer())
      .get('/internal/nearest')
      .query({ lat: 47.605, lng: -122.36 })
      .set(await bearer('service'))
      .expect(422);
    expect(res.body.message).toMatch(/away \(max 150 m\)/);
  });

  it('enforces roles and validates input', async () => {
    const server = app.getHttpServer();
    await request(server)
      .get('/internal/route')
      .query({ from: PIKE, to: NEEDLE })
      .set(await bearer('rider'))
      .expect(403);
    await request(server).get('/internal/route').query({ from: PIKE, to: NEEDLE }).expect(401);
    await request(server)
      .get('/route')
      .query({ from: PIKE, to: NEEDLE })
      .set(await bearer('service'))
      .expect(403);
    await request(server)
      .get('/internal/route')
      .query({ from: 'nope', to: NEEDLE })
      .set(await bearer('service'))
      .expect(400);
    await request(server)
      .post('/internal/table')
      .set(await bearer('service'))
      .send({ sources: [], destinations: [] })
      .expect(400);
  });

  it('serves the admin debug routes', async () => {
    const admin = await bearer('admin');
    const route = await request(app.getHttpServer())
      .get('/route')
      .query({ from: PIKE, to: NEEDLE })
      .set(admin)
      .expect(200);
    expect(RouteSchema.safeParse(route.body).success).toBe(true);
    await request(app.getHttpServer())
      .get('/nearest')
      .query({ lat: 47.6097, lng: -122.3422 })
      .set(admin)
      .expect(200);
    await request(app.getHttpServer())
      .get('/nearest')
      .query({ lat: 47.605, lng: -122.36 })
      .set(admin)
      .expect(422);
  });
});
