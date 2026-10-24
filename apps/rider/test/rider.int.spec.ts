import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { CLOCK } from '../src/positions.service';

let container: StartedTestContainer;
let raw: Redis; // unprefixed
let app: INestApplication;
let base: string;
let now = Date.now();

const key = new TextEncoder().encode('any-key-services-do-not-verify');
const token = (sub: string, role: string) =>
  new SignJWT({ sub, role })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(key)
    .then((t) => `Bearer ${t}`);

beforeAll(async () => {
  container = await new GenericContainer('redis:7.4').withExposedPorts(6379).start();
  const url = `redis://${container.getHost()}:${container.getMappedPort(6379)}/0`;
  raw = new Redis(url);
  const ref = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        PORT: '0',
        REDIS_URL: url,
        REDIS_KEY_PREFIX: 'rider:',
        POSITION_TTL_S: '600',
      }),
    ],
  })
    .overrideProvider(CLOCK)
    .useValue(() => now)
    .compile();
  app = ref.createNestApplication();
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
}, 120_000);

afterAll(async () => {
  await app?.close();
  raw?.disconnect();
  await container?.stop();
});

describe('rider location', () => {
  it('POST stores the prefixed hash with TTL and an index entry; GET returns it', async () => {
    const id = randomUUID();
    now = Date.now();
    await request(base)
      .post('/riders/me/location')
      .set('Authorization', await token(id, 'rider'))
      .send({ lat: 47.6, lng: -122.3 })
      .expect(204);

    expect(await raw.hgetall(`rider:pos:${id}`)).toEqual({
      lat: '47.6',
      lng: '-122.3',
      ts: String(now),
    });
    const ttl = await raw.ttl(`rider:pos:${id}`);
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);
    expect(await raw.zscore('rider:pos:index', id)).toBe(String(now));

    const res = await request(base)
      .get('/riders/me/location')
      .set('Authorization', await token(id, 'rider'))
      .expect(200);
    expect(res.body).toEqual({ riderId: id, lat: 47.6, lng: -122.3, ts: now });
  });

  it('GET without a position is 404', async () => {
    await request(base)
      .get('/riders/me/location')
      .set('Authorization', await token(randomUUID(), 'rider'))
      .expect(404);
  });

  it('rejects a body with riderId (400) and writes nothing', async () => {
    const me = randomUUID();
    const other = randomUUID();
    await request(base)
      .post('/riders/me/location')
      .set('Authorization', await token(me, 'rider'))
      .send({ lat: 1, lng: 2, riderId: other })
      .expect(400);
    expect(await raw.exists(`rider:pos:${other}`, `rider:pos:${me}`)).toBe(0);
    expect(await raw.zscore('rider:pos:index', other)).toBeNull();
  });

  it('enforces roles', async () => {
    const id = randomUUID();
    const driver = await token(id, 'driver');
    const rider = await token(id, 'rider');
    const service = await token('matching', 'service');
    await request(base)
      .post('/riders/me/location')
      .set('Authorization', driver)
      .send({ lat: 1, lng: 2 })
      .expect(403);
    await request(base).get('/riders/me/location').set('Authorization', driver).expect(403);
    await request(base).get('/internal/riders/positions').set('Authorization', rider).expect(403);
    await request(base).get('/internal/riders/positions').set('Authorization', service).expect(200);
    await request(base).get('/internal/riders/positions').expect(401);
  });

  it('internal list returns active riders, omits and prunes expired ones', async () => {
    await raw.flushall();
    now = Date.now();
    const [a, b, c, stale] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const post = async (id: string, lat: number) =>
      request(base)
        .post('/riders/me/location')
        .set('Authorization', await token(id, 'rider'))
        .send({ lat, lng: 10 })
        .expect(204);
    await post(a, 1);
    await post(b, 2);
    await post(c, 3);
    // stale: index entry older than the TTL, hash gone
    await raw.zadd('rider:pos:index', String(now - 601_000), stale);
    // b: hash expired early (Redis dropped it) but index entry still fresh
    await raw.del(`rider:pos:${b}`);

    const res = await request(base)
      .get('/internal/riders/positions')
      .set('Authorization', await token('gateway', 'service'))
      .expect(200);
    expect(res.body).toHaveLength(2);
    expect(res.body).toEqual(
      expect.arrayContaining([
        { riderId: a, lat: 1, lng: 10, ts: now },
        { riderId: c, lat: 3, lng: 10, ts: now },
      ]),
    );
    const members = await raw.zrange('rider:pos:index', '0', '-1');
    expect(members.sort()).toEqual([a, c].sort());
  });

  it('serves /health and /ready', async () => {
    await request(base).get('/health').expect(200);
    await request(base).get('/ready').expect(200);
  });
});
