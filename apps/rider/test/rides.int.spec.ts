import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';

interface Seen {
  method?: string;
  url?: string;
  authorization?: string;
  body: Record<string, unknown>;
}

const TRIP_ID = '22222222-2222-4222-8222-222222222222';
let container: StartedTestContainer;
let app: INestApplication;
let base: string;
let tripServer: Server;
let seen: Seen[] = [];
let tripReply: { status: number; body: unknown } = { status: 201, body: { tripId: TRIP_ID } };

const key = new TextEncoder().encode('any-key-services-do-not-verify');
const token = (sub: string, role: string) =>
  new SignJWT({ sub, role })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(key)
    .then((t) => `Bearer ${t}`);

const dropoff = { lat: 47.62, lng: -122.35 };

beforeAll(async () => {
  tripServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: raw ? JSON.parse(raw) : {},
      });
      res.writeHead(tripReply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(tripReply.body));
    });
  });
  await new Promise<void>((r) => tripServer.listen(0, '127.0.0.1', r));
  const tripUrl = `http://127.0.0.1:${(tripServer.address() as AddressInfo).port}`;

  container = await new GenericContainer('redis:7.4').withExposedPorts(6379).start();
  const url = `redis://${container.getHost()}:${container.getMappedPort(6379)}/0`;
  const ref = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        PORT: '0',
        REDIS_URL: url,
        REDIS_KEY_PREFIX: 'rider:',
        TRIP_URL: tripUrl,
      }),
    ],
  }).compile();
  app = ref.createNestApplication();
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await new Promise((r) => tripServer?.close(r));
  await container?.stop();
});

beforeEach(() => {
  seen = [];
  tripReply = { status: 201, body: { tripId: TRIP_ID } };
});

describe('rider ride request', () => {
  it('without pickup uses the stored position and forwards the rider token', async () => {
    const auth = await token(randomUUID(), 'rider');
    await request(base)
      .post('/riders/me/location')
      .set('Authorization', auth)
      .send({ lat: 47.6, lng: -122.3 })
      .expect(204);
    const res = await request(base)
      .post('/riders/me/rides')
      .set('Authorization', auth)
      .send({ dropoff })
      .expect(201);
    expect(res.body).toEqual({ tripId: TRIP_ID });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: '/internal/trips',
      authorization: auth,
      body: { pickup: { lat: 47.6, lng: -122.3 }, dropoff },
    });
  });

  it('uses an explicit pickup', async () => {
    const auth = await token(randomUUID(), 'rider');
    const pickup = { lat: 47.5, lng: -122.2 };
    await request(base)
      .post('/riders/me/rides')
      .set('Authorization', auth)
      .send({ pickup, dropoff })
      .expect(201);
    expect(seen[0]!.body).toEqual({ pickup, dropoff });
    expect(seen[0]!.authorization).toBe(auth);
  });

  it('no position and no pickup is 422 and trip is not called', async () => {
    await request(base)
      .post('/riders/me/rides')
      .set('Authorization', await token(randomUUID(), 'rider'))
      .send({ dropoff })
      .expect(422);
    expect(seen).toHaveLength(0);
  });

  it('passes trip 409 through', async () => {
    tripReply = { status: 409, body: { message: 'rider already has an active trip' } };
    const res = await request(base)
      .post('/riders/me/rides')
      .set('Authorization', await token(randomUUID(), 'rider'))
      .send({ pickup: dropoff, dropoff })
      .expect(409);
    expect(res.body.message).toBe('rider already has an active trip');
  });

  it('rejects a body with riderId (400)', async () => {
    await request(base)
      .post('/riders/me/rides')
      .set('Authorization', await token(randomUUID(), 'rider'))
      .send({ pickup: dropoff, dropoff, riderId: randomUUID() })
      .expect(400);
    expect(seen).toHaveLength(0);
  });

  it('forbids a driver token', async () => {
    await request(base)
      .post('/riders/me/rides')
      .set('Authorization', await token(randomUUID(), 'driver'))
      .send({ pickup: dropoff, dropoff })
      .expect(403);
    expect(seen).toHaveLength(0);
  });
});
