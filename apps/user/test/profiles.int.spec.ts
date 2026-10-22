import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';

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

describe('profiles', () => {
  const login = async (email: string, password = 'password-1'): Promise<string> =>
    (await request(base).post('/auth/login').send({ email, password })).body.accessToken;
  const register = async (body: object): Promise<{ id: string; token: string }> => {
    const res = await request(base).post('/users').send(body);
    const { email } = body as { email: string };
    return { id: res.body.userId, token: await login(email) };
  };
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const serviceToken = async () =>
    (
      await request(base)
        .post('/auth/token')
        .send({ clientId: 'trip', clientSecret: 'trip-secret' })
    ).body.accessToken as string;

  it('GET /users/me returns the rider profile without secrets, and the driver with vehicle', async () => {
    const r = await register(rider('me-rider@example.com'));
    const d = await register(driver('me-driver@example.com', 'ME1'));
    const rr = await request(base).get('/users/me').set(bearer(r.token));
    expect(rr.status).toBe(200);
    expect(rr.body).toMatchObject({
      id: r.id,
      email: 'me-rider@example.com',
      name: 'Rita Rider',
      phone: '+12065550100',
      role: 'rider',
    });
    expect(rr.body.vehicle ?? null).toBeNull();
    expect(JSON.stringify(rr.body)).not.toMatch(/password|hash/i);
    const dr = await request(base).get('/users/me').set(bearer(d.token));
    expect(dr.body).toMatchObject({
      id: d.id,
      role: 'driver',
      vehicle: { ...vehicle, plate: 'ME1' },
    });
  });

  it('requires a token (401) and rejects service tokens (403)', async () => {
    expect((await request(base).get('/users/me')).status).toBe(401);
    expect((await request(base).patch('/users/me').send({ name: 'x' })).status).toBe(401);
    expect(
      (
        await request(base)
          .get('/users/me')
          .set(bearer(await serviceToken()))
      ).status,
    ).toBe(403);
  });

  it('PATCH /users/me updates name/phone and bumps updated_at', async () => {
    const r = await register(rider('patch-rider@example.com'));
    const [before] = await q<{ updated_at: Date }>(
      'select updated_at from user_service.users where id=$1',
      [r.id],
    );
    const res = await request(base)
      .patch('/users/me')
      .set(bearer(r.token))
      .send({ name: 'Renamed', phone: '+12065550199' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: r.id, name: 'Renamed', phone: '+12065550199' });
    const [after] = await q<{ name: string; phone: string; updated_at: Date }>(
      'select name, phone, updated_at from user_service.users where id=$1',
      [r.id],
    );
    expect(after).toMatchObject({ name: 'Renamed', phone: '+12065550199' });
    expect(after!.updated_at.getTime()).toBeGreaterThan(before!.updated_at.getTime());
  });

  it('lets a driver change the vehicle', async () => {
    const d = await register(driver('patch-driver@example.com', 'PD1'));
    const v = { make: 'Honda', model: 'Civic', color: 'blue', plate: 'PD2' };
    const res = await request(base).patch('/users/me').set(bearer(d.token)).send({ vehicle: v });
    expect(res.status).toBe(200);
    expect(res.body.vehicle).toEqual(v);
    const rows = await q(
      'select vehicle_plate from user_service.driver_profiles where user_id=$1',
      [d.id],
    );
    expect(rows).toEqual([{ vehicle_plate: 'PD2' }]);
  });

  it('rejects a vehicle from a rider with 400 and changes nothing', async () => {
    const r = await register(rider('rv-rider@example.com'));
    const res = await request(base)
      .patch('/users/me')
      .set(bearer(r.token))
      .send({ name: 'Sneaky', vehicle });
    expect(res.status).toBe(400);
    expect(
      await q('select 1 from user_service.users where id=$1 and name=$2', [r.id, 'Sneaky']),
    ).toHaveLength(0);
  });

  it('rejects a plate used by another driver with 409, rolling back the whole update', async () => {
    await register(driver('plate-a@example.com', 'PLATE-A'));
    const b = await register(driver('plate-b@example.com', 'PLATE-B'));
    const res = await request(base)
      .patch('/users/me')
      .set(bearer(b.token))
      .send({ name: 'Should Roll Back', vehicle: { ...vehicle, plate: 'PLATE-A' } });
    expect(res.status).toBe(409);
    const [row] = await q<{ name: string }>('select name from user_service.users where id=$1', [
      b.id,
    ]);
    expect(row!.name).not.toBe('Should Roll Back');
  });

  it('rejects a body naming another user (strict schema) and leaves that user untouched', async () => {
    const victim = await register(rider('victim@example.com'));
    const attacker = await register(rider('attacker@example.com'));
    const res = await request(base)
      .patch('/users/me')
      .set(bearer(attacker.token))
      .send({ id: victim.id, name: 'Pwned' });
    expect(res.status).toBe(400);
    expect(
      await q('select 1 from user_service.users where id=$1 and name=$2', [victim.id, 'Pwned']),
    ).toHaveLength(0);
    expect(
      (await request(base).patch('/users/me').set(bearer(attacker.token)).send({})).status,
    ).toBe(400);
  });

  it('GET /users/:id is admin-only', async () => {
    const r = await register(rider('byid@example.com'));
    const adminToken = await login('admin@example.com', 'admin-pass-1');
    const ok = await request(base).get(`/users/${r.id}`).set(bearer(adminToken));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ id: r.id, email: 'byid@example.com', role: 'rider' });
    expect(JSON.stringify(ok.body)).not.toMatch(/password|hash/i);
    expect((await request(base).get(`/users/${r.id}`).set(bearer(r.token))).status).toBe(403);
    expect((await request(base).get(`/users/${r.id}`)).status).toBe(401);
    const missing = '00000000-0000-4000-8000-000000000000';
    expect((await request(base).get(`/users/${missing}`).set(bearer(adminToken))).status).toBe(404);
    expect((await request(base).get('/users/not-a-uuid').set(bearer(adminToken))).status).toBe(400);
  });

  it('POST /internal/users/batch returns known ids only, for service tokens only', async () => {
    const r = await register(rider('batch-rider@example.com'));
    const d = await register(driver('batch-driver@example.com', 'BATCH1'));
    const missing = '00000000-0000-4000-8000-000000000001';
    const res = await request(base)
      .post('/internal/users/batch')
      .set(bearer(await serviceToken()))
      .send({ ids: [r.id, d.id, d.id, missing] });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const byId = new Map(res.body.map((u: { id: string }) => [u.id, u]));
    expect(byId.get(r.id)).toMatchObject({ name: 'Rita Rider', role: 'rider' });
    expect(byId.get(d.id)).toMatchObject({
      name: 'Dan Driver',
      role: 'driver',
      vehicle: { ...vehicle, plate: 'BATCH1' },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/email|phone|password/i);

    const asRider = await request(base)
      .post('/internal/users/batch')
      .set(bearer(r.token))
      .send({ ids: [r.id] });
    expect(asRider.status).toBe(403);
    expect(
      (
        await request(base)
          .post('/internal/users/batch')
          .send({ ids: [r.id] })
      ).status,
    ).toBe(401);
    const empty = await request(base)
      .post('/internal/users/batch')
      .set(bearer(await serviceToken()))
      .send({ ids: [] });
    expect(empty.status).toBe(400);
  });
});
