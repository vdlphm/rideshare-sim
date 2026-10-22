import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { JwtClaimsSchema } from '@rideshare/contracts';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { ISSUER } from '../src/tokens/token.service';

const INIT_SCRIPT = resolve(__dirname, '../../../infra/postgres/init/01-init.sh');
const DB_PASSWORD = 'user-svc-pw';

let container: StartedPostgreSqlContainer;
let admin: Client;
let keysDir: string;
let envBase: NodeJS.ProcessEnv;
const apps = new Set<INestApplication>();
let base: string;

async function boot(): Promise<{ app: INestApplication; base: string }> {
  const ref = await Test.createTestingModule({ imports: [AppModule.forRoot(envBase)] }).compile();
  const a = ref.createNestApplication();
  await a.listen(0, '127.0.0.1');
  apps.add(a);
  return { app: a, base: await a.getUrl() };
}

const rider = (email: string) => ({
  email,
  password: 'password-1',
  name: 'Rita Rider',
  phone: '+12065550100',
  role: 'rider',
});
const vehicle = { make: 'Toyota', model: 'Prius', color: 'white', plate: 'ABC123' };
const driver = (email: string, plate = vehicle.plate) => ({
  email,
  password: 'password-1',
  name: 'Dan Driver',
  role: 'driver',
  vehicle: { ...vehicle, plate },
});

const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await admin.query<T>(sql, params)).rows;

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

  const host = container.getHost();
  const port = container.getPort();
  admin = new Client({
    connectionString: `postgres://postgres:pg-admin-pw@${host}:${port}/ridesharing`,
  });
  await admin.connect();

  keysDir = await mkdtemp(join(tmpdir(), 'user-int-keys-'));
  envBase = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PORT: '0',
    DATABASE_URL: `postgres://user_service:${DB_PASSWORD}@${host}:${port}/ridesharing`,
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
  ({ base } = await boot());
}, 240_000);

afterAll(async () => {
  await Promise.all([...apps].map((a) => a.close()));
  await admin?.end();
  await container?.stop();
  if (keysDir) await rm(keysDir, { recursive: true, force: true });
});

describe('schema', () => {
  it('creates the tables in user_service, none in public', async () => {
    const rows = await q<{ table_schema: string; table_name: string }>(
      `select table_schema, table_name from information_schema.tables
       where table_schema in ('user_service','public') and table_type='BASE TABLE'`,
    );
    const names = (s: string) =>
      rows
        .filter((r) => r.table_schema === s)
        .map((r) => r.table_name)
        .sort();
    expect(names('user_service')).toEqual(
      [
        '__drizzle_migrations',
        'driver_profiles',
        'refresh_tokens',
        'rider_profiles',
        'service_clients',
        'users',
      ].sort(),
    );
    expect(names('public')).toEqual([]);
  });
});

describe('health', () => {
  it('serves /health and /ready without a token', async () => {
    expect((await request(base).get('/health')).body).toEqual({ status: 'ok' });
    const ready = await request(base).get('/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toEqual({ postgres: 'ok' });
  });
});

describe('register', () => {
  it('registers a rider with a rider profile and a hashed password', async () => {
    const res = await request(base).post('/users').send(rider('rita@example.com'));
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ userId: expect.any(String) });
    const [u] = await q<{ role: string; password_hash: string; phone: string }>(
      'select role, password_hash, phone from user_service.users where id=$1',
      [res.body.userId],
    );
    expect(u).toMatchObject({ role: 'rider', phone: '+12065550100' });
    expect(u!.password_hash).toMatch(/^\$2[aby]\$/);
    expect(
      await q('select 1 from user_service.rider_profiles where user_id=$1', [res.body.userId]),
    ).toHaveLength(1);
  });

  it('registers a driver with a driver profile', async () => {
    const res = await request(base).post('/users').send(driver('dan@example.com'));
    expect(res.status).toBe(201);
    const rows = await q(
      'select vehicle_make, vehicle_plate from user_service.driver_profiles where user_id=$1',
      [res.body.userId],
    );
    expect(rows).toEqual([{ vehicle_make: 'Toyota', vehicle_plate: 'ABC123' }]);
  });

  it('rejects a duplicate email (any case) with 409', async () => {
    await request(base).post('/users').send(rider('dup@example.com')).expect(201);
    const res = await request(base).post('/users').send(rider('DUP@example.com'));
    expect(res.status).toBe(409);
  });

  it('rejects a duplicate plate with 409 and leaves no orphan user', async () => {
    await request(base).post('/users').send(driver('p1@example.com', 'PLATE1')).expect(201);
    const res = await request(base).post('/users').send(driver('p2@example.com', 'PLATE1'));
    expect(res.status).toBe(409);
    expect(await q("select 1 from user_service.users where email='p2@example.com'")).toHaveLength(
      0,
    );
  });

  it.each(['admin', 'service'])('rejects role %s with 400', async (role) => {
    const res = await request(base)
      .post('/users')
      .send({ ...rider('x@example.com'), role });
    expect(res.status).toBe(400);
  });

  it('rejects a driver without a vehicle with 400', async () => {
    const noVehicle: Record<string, unknown> = { ...driver('nv@example.com') };
    delete noVehicle.vehicle;
    expect((await request(base).post('/users').send(noVehicle)).status).toBe(400);
  });
});

describe('login + JWKS', () => {
  it('issues an access token that verifies against /.well-known/jwks.json', async () => {
    const reg = await request(base).post('/users').send(rider('login@example.com'));
    const res = await request(base)
      .post('/auth/login')
      .send({ email: 'login@example.com', password: 'password-1' });
    expect(res.status).toBe(200);

    const jwks = createRemoteJWKSet(new URL('/.well-known/jwks.json', base));
    const { payload, protectedHeader } = await jwtVerify(res.body.accessToken, jwks, {
      issuer: ISSUER,
    });
    expect(protectedHeader.alg).toBe('RS256');
    expect(payload).toMatchObject({ sub: reg.body.userId, role: 'rider' });
    expect(payload.exp! - payload.iat!).toBe(900);
    expect(JwtClaimsSchema.safeParse(payload).success).toBe(true);

    const doc = (await request(base).get('/.well-known/jwks.json')).body;
    expect(doc.keys).toHaveLength(1);
    expect(doc.keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' });
    expect(doc.keys[0].kid).toBe(decodeProtectedHeader(res.body.accessToken).kid);
    expect(doc.keys[0]).not.toHaveProperty('d');
  });

  it('logs the seeded admin in with role admin', async () => {
    const res = await request(base)
      .post('/auth/login')
      .send({ email: 'admin@example.com', password: 'admin-pass-1' });
    expect(res.status).toBe(200);
    const jwks = createRemoteJWKSet(new URL('/.well-known/jwks.json', base));
    const { payload } = await jwtVerify(res.body.accessToken, jwks);
    expect(payload.role).toBe('admin');
  });

  it('answers wrong password and unknown email with the same 401', async () => {
    await request(base).post('/users').send(rider('wp@example.com')).expect(201);
    const wrong = await request(base)
      .post('/auth/login')
      .send({ email: 'wp@example.com', password: 'nope-nope' });
    const unknown = await request(base)
      .post('/auth/login')
      .send({ email: 'ghost@example.com', password: 'nope-nope' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const strip = (body: Record<string, unknown>) => ({ ...body, correlationId: undefined });
    expect(strip(wrong.body)).toEqual(strip(unknown.body));
  });
});

describe('refresh', () => {
  const login = async (email: string) => {
    await request(base).post('/users').send(rider(email)).expect(201);
    return (await request(base).post('/auth/login').send({ email, password: 'password-1' })).body;
  };

  it('rotates; reusing the old token is 401 and revokes the whole family', async () => {
    const first = await login('rot@example.com');
    const second = await request(base)
      .post('/auth/refresh')
      .send({ refreshToken: first.refreshToken });
    expect(second.status).toBe(200);
    expect(second.body.refreshToken).not.toBe(first.refreshToken);
    expect(second.body.accessToken).toEqual(expect.any(String));

    const replay = await request(base)
      .post('/auth/refresh')
      .send({ refreshToken: first.refreshToken });
    expect(replay.status).toBe(401);

    const newest = await request(base)
      .post('/auth/refresh')
      .send({ refreshToken: second.body.refreshToken });
    expect(newest.status).toBe(401);

    const rows = await q<{ revoked_at: Date | null }>(
      `select rt.revoked_at from user_service.refresh_tokens rt
       join user_service.users u on u.id = rt.user_id where u.email = 'rot@example.com'`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.revoked_at)).toBe(true);
  });

  it('stores only a hash of the token', async () => {
    const first = await login('hash@example.com');
    const rows = await q<{ token_hash: string }>(
      `select token_hash from user_service.refresh_tokens where token_hash = $1`,
      [first.refreshToken],
    );
    expect(rows).toHaveLength(0);
  });

  it('rejects unknown and expired tokens', async () => {
    expect(
      (await request(base).post('/auth/refresh').send({ refreshToken: 'unknown' })).status,
    ).toBe(401);
    const first = await login('exp@example.com');
    await q(
      `update user_service.refresh_tokens set expires_at = now() - interval '1 minute'
       where user_id = (select id from user_service.users where email='exp@example.com')`,
    );
    expect(
      (await request(base).post('/auth/refresh').send({ refreshToken: first.refreshToken })).status,
    ).toBe(401);
  });
});

describe('service tokens', () => {
  it('issues a service token for a seeded client', async () => {
    const res = await request(base)
      .post('/auth/token')
      .send({ clientId: 'trip', clientSecret: 'trip-secret' });
    expect(res.status).toBe(200);
    expect(res.body.expiresIn).toBe(900);
    const jwks = createRemoteJWKSet(new URL('/.well-known/jwks.json', base));
    const { payload } = await jwtVerify(res.body.accessToken, jwks);
    expect(payload).toMatchObject({ sub: 'trip', role: 'service' });
  });

  it('rejects a bad secret and an unknown client with 401', async () => {
    const bad = await request(base)
      .post('/auth/token')
      .send({ clientId: 'trip', clientSecret: 'wrong' });
    const ghost = await request(base)
      .post('/auth/token')
      .send({ clientId: 'ghost', clientSecret: 'x' });
    expect(bad.status).toBe(401);
    expect(ghost.status).toBe(401);
  });
});

describe('seeding', () => {
  it('is idempotent across boots, keeps the same key, and rotates changed secrets', async () => {
    const before = await q(
      'select client_id, secret_hash from user_service.service_clients order by 1',
    );
    const kidBefore = (await request(base).get('/.well-known/jwks.json')).body.keys[0].kid;
    expect(before).toHaveLength(6);

    const second = await boot();
    const after = await q(
      'select client_id, secret_hash from user_service.service_clients order by 1',
    );
    expect(after).toEqual(before);
    expect(
      await q("select 1 from user_service.users where role='admin' and email='admin@example.com'"),
    ).toHaveLength(1);
    expect((await request(second.base).get('/.well-known/jwks.json')).body.keys[0].kid).toBe(
      kidBefore,
    );
    await second.app.close();
    apps.delete(second.app);

    const prev = envBase;
    envBase = { ...envBase, TRIP_CLIENT_SECRET: 'rotated-secret' };
    const third = await boot();
    envBase = prev;
    const ok = await request(third.base)
      .post('/auth/token')
      .send({ clientId: 'trip', clientSecret: 'rotated-secret' });
    const old = await request(third.base)
      .post('/auth/token')
      .send({ clientId: 'trip', clientSecret: 'trip-secret' });
    expect(ok.status).toBe(200);
    expect(old.status).toBe(401);
    expect(await q('select 1 from user_service.service_clients')).toHaveLength(6);
  });
});
