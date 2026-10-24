import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import {
  DockerComposeEnvironment,
  Wait,
  type StartedDockerComposeEnvironment,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPOSE_DIR, COMPOSE_FILE, PASSWORDS, SERVICE_ENV } from '../infra/stack';

// M3 end to end: gateway + user + rider + driver + routing + redis + osrm, driven through the gateway.
const PROJECT = `rideshare-e2e-m3-${process.pid}`;
const PIKE = { lat: 47.6097, lng: -122.3422 };
// ~200 m and ~1 km from Pike Place.
const NEAR = { lat: 47.6115, lng: -122.3422 };
const FAR = { lat: 47.6187, lng: -122.3422 };

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });

let env: StartedDockerComposeEnvironment;
let base: string;
let composeEnv: NodeJS.ProcessEnv;

interface Actor {
  id: string;
  token: string;
}

const api = (path: string, token: string | undefined, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });

const send = (method: string, path: string, token: string, body?: unknown) =>
  api(path, token, { method, body: body === undefined ? undefined : JSON.stringify(body) });

const compose = (args: string[]): string =>
  execFileSync('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, ...args], {
    cwd: COMPOSE_DIR,
    env: composeEnv,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

const redisCli = (user: string, pw: string, ...cmd: string[]): string =>
  compose([
    'exec',
    '-T',
    'redis',
    'redis-cli',
    '--user',
    user,
    '--pass',
    pw,
    '--no-auth-warning',
    ...cmd,
  ]);

const register = async (role: 'rider' | 'driver', name: string): Promise<Actor> => {
  const email = `${name}-${process.pid}@example.com`;
  const password = 'password-1';
  const body =
    role === 'driver'
      ? {
          email,
          password,
          name,
          role,
          vehicle: { make: 'Toyota', model: 'Prius', color: 'white', plate: `P-${name}` },
        }
      : { email, password, name, role };
  const reg = await send('POST', '/api/users', '', body);
  expect(reg.status).toBe(201);
  const login = await send('POST', '/api/auth/login', '', { email, password });
  expect(login.status).toBe(200);
  const { accessToken } = (await login.json()) as { accessToken: string };
  const me = await api('/api/users/me', accessToken);
  const { id } = (await me.json()) as { id: string };
  return { id, token: accessToken };
};

/** Calls the driver service's internal API from inside the compose network with a service token. */
const nearbyFromInside = (): { driverId: string; distanceM: number }[] => {
  const script = `
    (async () => {
      const t = await fetch('http://user:3001/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: 'matching', clientSecret: process.env.CS }),
      });
      if (!t.ok) throw new Error('token ' + t.status);
      const { accessToken } = await t.json();
      const r = await fetch('http://127.0.0.1:3003/internal/drivers/nearby?lat=${PIKE.lat}&lng=${PIKE.lng}&radiusM=2000&limit=10', {
        headers: { authorization: 'Bearer ' + accessToken },
      });
      if (!r.ok) throw new Error('nearby ' + r.status);
      console.log(JSON.stringify(await r.json()));
    })().catch((e) => { console.error(String(e)); process.exit(1); });
  `;
  const out = compose([
    'exec',
    '-T',
    '-e',
    `CS=${SERVICE_ENV.MATCHING_CLIENT_SECRET}`,
    'driver',
    'node',
    '-e',
    script,
  ]);
  return JSON.parse(out.trim()) as { driverId: string; distanceM: number }[];
};

let d1: Actor;
let d2: Actor;
let rider: Actor;
let admin: string;

beforeAll(async () => {
  const port = await freePort();
  base = `http://localhost:${port}`;
  const vars = { ...PASSWORDS, ...SERVICE_ENV, GATEWAY_HOST_PORT: String(port) };
  composeEnv = { ...process.env, ...vars };
  env = await new DockerComposeEnvironment(COMPOSE_DIR, COMPOSE_FILE)
    .withProjectName(PROJECT)
    .withEnvironment(vars)
    .withBuild()
    .withWaitStrategy('gateway-1', Wait.forHealthCheck())
    .withStartupTimeout(900_000)
    .up(['gateway']);

  d1 = await register('driver', 'dora');
  d2 = await register('driver', 'dan');
  rider = await register('rider', 'rita');
  const login = await send('POST', '/api/auth/login', '', {
    email: SERVICE_ENV.ADMIN_EMAIL,
    password: SERVICE_ENV.ADMIN_PASSWORD,
  });
  expect(login.status).toBe(200);
  admin = ((await login.json()) as { accessToken: string }).accessToken;
}, 1_200_000);

afterAll(async () => {
  await env?.down({ removeVolumes: true, timeout: 20_000 });
}, 120_000);

describe('M3: rider, driver and routing services in compose', { timeout: 60_000 }, () => {
  it('drivers go online, report locations and are AVAILABLE', async () => {
    for (const [d, pos] of [
      [d1, NEAR],
      [d2, FAR],
    ] as const) {
      const on = await send('POST', '/api/drivers/me/online', d.token, pos);
      expect(on.status).toBe(200);
      const loc = await send('POST', '/api/drivers/me/location', d.token, { ...pos, heading: 90 });
      expect(loc.status).toBe(204);
      const me = await api('/api/drivers/me', d.token);
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({ driverId: d.id, status: 'AVAILABLE' });
    }
  });

  it('lists nearby drivers closest-first from inside the network, then drops an offline one', async () => {
    const nearby = nearbyFromInside();
    expect(nearby.map((n) => n.driverId)).toEqual([d1.id, d2.id]);
    expect(nearby[0]!.distanceM).toBeGreaterThan(150);
    expect(nearby[0]!.distanceM).toBeLessThan(250);
    expect(nearby[1]!.distanceM).toBeGreaterThan(900);
    expect(nearby[1]!.distanceM).toBeLessThan(1100);

    const off = await send('POST', '/api/drivers/me/offline', d1.token);
    expect(off.status).toBe(200);
    expect(nearbyFromInside().map((n) => n.driverId)).toEqual([d2.id]);
  });

  it('stores and returns the rider position; rejects a driver token', async () => {
    const set = await send('POST', '/api/riders/me/location', rider.token, PIKE);
    expect(set.status).toBe(204);
    const got = await api('/api/riders/me/location', rider.token);
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ riderId: rider.id, ...PIKE });
    expect((await api('/api/riders/me/location', d2.token)).status).toBe(403);
  });

  it('serves routing to admins only, with real OSRM answers', async () => {
    const res = await api('/api/routing/route?from=47.6097,-122.3422&to=47.6205,-122.3493', admin);
    expect(res.status).toBe(200);
    const route = (await res.json()) as {
      distanceM: number;
      durations: number[];
      geometry: unknown[];
    };
    expect(Math.abs(route.distanceM - 1638)).toBeLessThanOrEqual(50);
    expect(route.durations.length).toBe(route.geometry.length - 1);

    expect((await api('/api/routing/nearest?lat=47.6050&lng=-122.3600', admin)).status).toBe(422);
    expect(
      (await api('/api/routing/route?from=47.6097,-122.3422&to=47.6205,-122.3493', rider.token))
        .status,
    ).toBe(403);
  });

  it('enforces the real Redis ACLs', () => {
    const pw = PASSWORDS.REDIS_DRIVER_PASSWORD;
    expect(redisCli('driver', pw, 'EXISTS', `driver:state:${d2.id}`).trim()).toBe('1');
    expect(redisCli('driver', pw, 'GET', `rider:pos:${rider.id}`)).toContain('NOPERM');
    // The rider position lives under the rider prefix, readable only by the rider user.
    const keys = redisCli(
      'rider',
      PASSWORDS.REDIS_RIDER_PASSWORD,
      'SCAN',
      '0',
      'MATCH',
      'rider:*',
      'COUNT',
      '1000',
    );
    expect(keys).toContain(rider.id);
    expect(
      redisCli('rider', PASSWORDS.REDIS_RIDER_PASSWORD, 'GET', `driver:state:${d2.id}`),
    ).toContain('NOPERM');
  });
});
