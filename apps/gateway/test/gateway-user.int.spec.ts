import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule as UserAppModule } from '../../user/src/app.module';
import { AppModule as GatewayAppModule } from '../src/app.module';

// A real user service (real Postgres, real signing keys) behind the real gateway.
const INIT_SCRIPT = resolve(__dirname, '../../../infra/postgres/init/01-init.sh');
const DB_PASSWORD = 'user-svc-pw';

let container: StartedPostgreSqlContainer;
let keysDir: string;
let userApp: INestApplication;
let gwApp: INestApplication;
let userBase: string;
let gw: string;

const login = async (email: string, password: string) =>
  (await request(gw).post('/api/auth/login').send({ email, password })).body as {
    accessToken: string;
    refreshToken: string;
  };

beforeAll(async () => {
  container = await new PostgreSqlContainer('imresamu/postgis:16-3.5')
    .withUsername('postgres')
    .withPassword('pg-admin-pw')
    .withEnvironment({
      USER_SERVICE_DB_PASSWORD: DB_PASSWORD,
      TRIP_SERVICE_DB_PASSWORD: 'trip-pw',
      MATCHING_SERVICE_DB_PASSWORD: 'matching-pw',
    })
    .withCopyFilesToContainer([
      { source: INIT_SCRIPT, target: '/docker-entrypoint-initdb.d/01-init.sh', mode: 0o755 },
    ])
    .start();
  keysDir = await mkdtemp(join(tmpdir(), 'gw-int-keys-'));
  const userEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PORT: '0',
    DATABASE_URL: `postgres://user_service:${DB_PASSWORD}@${container.getHost()}:${container.getPort()}/ridesharing`,
    KEYS_DIR: keysDir,
    ADMIN_EMAIL: 'admin@example.com',
    ADMIN_PASSWORD: 'admin-pass-1',
    GATEWAY_CLIENT_SECRET: 'gateway-secret',
    RIDER_CLIENT_SECRET: 'rider-secret',
    DRIVER_CLIENT_SECRET: 'driver-secret',
    TRIP_CLIENT_SECRET: 'trip-secret',
    MATCHING_CLIENT_SECRET: 'matching-secret',
    SIMULATOR_CLIENT_SECRET: 'simulator-secret',
  };
  const userRef = await Test.createTestingModule({
    imports: [UserAppModule.forRoot(userEnv)],
  }).compile();
  userApp = userRef.createNestApplication();
  await userApp.listen(0, '127.0.0.1');
  userBase = await userApp.getUrl();

  const gwRef = await Test.createTestingModule({
    imports: [
      GatewayAppModule.forRoot({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        PORT: '0',
        USER_SERVICE_URL: userBase,
      }),
    ],
  }).compile();
  gwApp = gwRef.createNestApplication({ bodyParser: false });
  await gwApp.listen(0, '127.0.0.1');
  gw = await gwApp.getUrl();
}, 240_000);

afterAll(async () => {
  await gwApp?.close();
  await userApp?.close();
  await container?.stop();
  if (keysDir) await rm(keysDir, { recursive: true, force: true });
});

describe('gateway in front of the real user service', () => {
  it('registers, logs in and reads the profile with a real token', async () => {
    const reg = await request(gw)
      .post('/api/users')
      .send({ email: 'rita@example.com', password: 'password-1', name: 'Rita', role: 'rider' });
    expect(reg.status).toBe(201);
    const { accessToken, refreshToken } = await login('rita@example.com', 'password-1');
    const me = await request(gw).get('/api/users/me').set('Authorization', `Bearer ${accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email: 'rita@example.com', name: 'Rita', role: 'rider' });
    expect(me.headers['x-correlation-id']).toBeTruthy();

    const refreshed = await request(gw).post('/api/auth/refresh').send({ refreshToken });
    expect(refreshed.status).toBe(200);
    const again = await request(gw)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${refreshed.body.accessToken}`);
    expect(again.status).toBe(200);
  });

  it('enforces roles on real tokens (admin-only /users/:id)', async () => {
    const reg = await request(gw)
      .post('/api/users')
      .send({ email: 'ron@example.com', password: 'password-1', name: 'Ron', role: 'rider' });
    const rider = await login('ron@example.com', 'password-1');
    const admin = await login('admin@example.com', 'admin-pass-1');
    const path = `/api/users/${reg.body.userId}`;
    expect(
      (await request(gw).get(path).set('Authorization', `Bearer ${rider.accessToken}`)).status,
    ).toBe(403);
    const ok = await request(gw).get(path).set('Authorization', `Bearer ${admin.accessToken}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ id: reg.body.userId, name: 'Ron' });
  });

  it('rejects a real service token and does not expose /auth/token or /internal', async () => {
    const svc = await request(userBase)
      .post('/auth/token')
      .send({ clientId: 'trip', clientSecret: 'trip-secret' });
    expect(svc.status).toBeLessThan(300);
    const token = svc.body.accessToken ?? svc.body.access_token;
    expect(token).toBeDefined();
    const res = await request(gw).get('/api/users/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect((await request(gw).post('/api/auth/token').send({})).status).toBe(404);
    expect(
      (await request(gw).post('/api/users/../internal/users/batch').send({ ids: [] })).status,
    ).toBe(404);
  });

  it('is ready once the real JWKS endpoint answers', async () => {
    expect((await request(gw).get('/ready')).status).toBe(200);
  });
});
