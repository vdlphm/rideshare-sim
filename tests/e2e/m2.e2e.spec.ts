import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import {
  DockerComposeEnvironment,
  Wait,
  type StartedDockerComposeEnvironment,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPOSE_DIR, COMPOSE_FILE, PASSWORDS, SERVICE_ENV } from '../infra/stack';

// M2 end to end: the real compose stack (built images), driven only through the gateway.
const PROJECT = `rideshare-e2e-${process.pid}`;

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

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// `compose logs` returns what has been logged so far (the Testcontainers log stream follows forever).
const readLogs = (service: string): string =>
  execFileSync(
    'docker',
    ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, 'logs', '--no-color', service],
    {
      cwd: COMPOSE_DIR,
      env: composeEnv,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );

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
    .withStartupTimeout(600_000)
    .up(['gateway']);
}, 900_000);

afterAll(async () => {
  await env?.down({ removeVolumes: true, timeout: 20_000 });
}, 120_000);

describe('M2: gateway + user service in compose', { timeout: 60_000 }, () => {
  const email = `rita-${process.pid}@example.com`;
  const password = 'password-1';

  it('registers, logs in, reads the profile and refreshes through the gateway', async () => {
    const reg = await post('/api/users', { email, password, name: 'Rita', role: 'rider' });
    expect(reg.status).toBe(201);

    const login = await post('/api/auth/login', { email, password });
    expect(login.status).toBe(200);
    const tokens = (await login.json()) as { accessToken: string; refreshToken: string };
    expect(tokens.accessToken).toBeTruthy();

    const me = await fetch(`${base}/api/users/me`, {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email, role: 'rider' });

    const refreshed = await post('/api/auth/refresh', { refreshToken: tokens.refreshToken });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { accessToken: string; refreshToken: string };
    expect(next.accessToken).toBeTruthy();
    expect(next.refreshToken).not.toBe(tokens.refreshToken);
  });

  it('rejects a request without a token', async () => {
    expect((await fetch(`${base}/api/users/me`)).status).toBe(401);
  });

  it('does not expose service-token issuance', async () => {
    expect((await post('/api/auth/token', {})).status).toBe(404);
  });

  it('keeps the user service off the host network', () => {
    const args = ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, 'port', 'user', '3001'];
    let published = '';
    try {
      published = execFileSync('docker', args, {
        cwd: COMPOSE_DIR,
        env: composeEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      // A non-zero exit means nothing is published, which is what we want.
    }
    expect(published).toBe('');
  });

  it('propagates the correlation id from the gateway to the user service', async () => {
    const res = await post('/api/auth/login', { email, password });
    const id = res.headers.get('x-correlation-id');
    expect(id).toBeTruthy();
    const logs = readLogs('user');
    expect(logs).toContain(id);
  });
});
