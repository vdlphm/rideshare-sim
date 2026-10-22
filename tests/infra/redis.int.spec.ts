import type { StartedDockerComposeEnvironment } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORDS, startStack } from './stack';

const USERS = {
  rider: PASSWORDS.REDIS_RIDER_PASSWORD,
  driver: PASSWORDS.REDIS_DRIVER_PASSWORD,
  matching: PASSWORDS.REDIS_MATCHING_PASSWORD,
  routing: PASSWORDS.REDIS_ROUTING_PASSWORD,
} as const;
type User = keyof typeof USERS;
const USER_NAMES = Object.keys(USERS) as User[];

describe('redis isolation and persistence', () => {
  let env: StartedDockerComposeEnvironment;

  async function cli(user: string, pass: string, ...args: string[]): Promise<string> {
    const r = await env
      .getContainer('redis-1')
      .exec(['redis-cli', '--user', user, '--pass', pass, '--no-auth-warning', ...args]);
    return `${r.stdout}${r.stderr}`.trim();
  }
  const as = (user: User, ...args: string[]) => cli(user, USERS[user], ...args);

  beforeAll(async () => {
    env = await startStack('redis');
  }, 240_000);

  afterAll(async () => {
    await env?.down({ removeVolumes: true });
  }, 120_000);

  it.each(USER_NAMES)('%s can use its own prefix', async (user) => {
    expect(await as(user, 'SET', `${user}:k`, 'v')).toBe('OK');
    expect(await as(user, 'GET', `${user}:k`)).toBe('v');
    expect(await as(user, 'GEOADD', `${user}:geo`, '-122.33', '47.6', 'a')).toBe('1');
    expect(await as(user, 'GEOSEARCH', `${user}:geo`, 'FROMLONLAT', '-122.33', '47.6', 'BYRADIUS', '1', 'km')).toBe('a');
    expect(await as(user, 'EVAL', "return redis.call('GET', KEYS[1])", '1', `${user}:k`)).toBe('v');
  });

  it.each(USER_NAMES.flatMap((u) => USER_NAMES.filter((o) => o !== u).map((o) => [u, o] as const)))(
    '%s gets NOPERM on prefix of %s',
    async (user, other) => {
      expect(await as(user, 'GET', `${other}:k`)).toContain('NOPERM');
      expect(await as(user, 'SET', `${other}:k`, 'x')).toContain('NOPERM');
      expect(await as(user, 'GEOADD', `${other}:geo`, '1', '1', 'z')).toContain('NOPERM');
      expect(await as(user, 'EVAL', "return redis.call('GET', KEYS[1])", '1', `${other}:k`)).toContain('NOPERM');
    },
  );

  it('dangerous commands are denied', async () => {
    expect(await as('rider', 'FLUSHALL')).toContain('NOPERM');
    expect(await as('rider', 'KEYS', '*')).toContain('NOPERM');
  });

  it.each(Object.keys(USERS) as User[])(
    '%s may run INFO (ioredis ready check needs it)',
    async (user) => {
      expect(await as(user, 'INFO', 'server')).toContain('redis_version');
    },
  );

  it('default user is rejected, with or without a password', async () => {
    const c = env.getContainer('redis-1');
    const noAuth = await c.exec(['redis-cli', 'GET', 'rider:k']);
    expect(`${noAuth.stdout}${noAuth.stderr}`).toContain('NOAUTH');
    for (const pass of ['', 'anything', ...Object.values(USERS)]) {
      const out = await cli('default', pass, 'PING');
      expect(out).toMatch(/WRONGPASS|NOAUTH|invalid/i);
    }
  });

  it('wrong password is rejected', async () => {
    expect(await cli('rider', 'nope', 'PING')).toContain('WRONGPASS');
  });

  it('healthcheck user can only PING', async () => {
    expect(await cli('healthcheck', 'healthcheck', 'PING')).toBe('PONG');
    expect(await cli('healthcheck', 'healthcheck', 'GET', 'rider:k')).toContain('NOPERM');
    expect(await cli('healthcheck', 'healthcheck', 'SET', 'rider:z', '1')).toContain('NOPERM');
  });

  it('AOF: live state survives a redis restart', async () => {
    expect(await as('driver', 'SET', 'driver:state:1', 'ONLINE')).toBe('OK');
    expect(await as('driver', 'GEOADD', 'driver:aof-geo', '-122.3', '47.6', 'd1')).toBe('1');
    expect(await cli('healthcheck', 'healthcheck', 'PING')).toBe('PONG');
    await env.getContainer('redis-1').restart({ timeout: 10 });
    for (let i = 0; i < 30; i++) {
      if ((await cli('healthcheck', 'healthcheck', 'PING')) === 'PONG') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(await as('driver', 'GET', 'driver:state:1')).toBe('ONLINE');
    expect(await as('driver', 'ZCARD', 'driver:aof-geo')).toBe('1');
  }, 60_000);
});
