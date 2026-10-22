import type { StartedDockerComposeEnvironment } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORDS, startStack } from './stack';

const ROLES = {
  user_service: PASSWORDS.USER_SERVICE_DB_PASSWORD,
  trip_service: PASSWORDS.TRIP_SERVICE_DB_PASSWORD,
  matching_service: PASSWORDS.MATCHING_SERVICE_DB_PASSWORD,
} as const;
type Role = keyof typeof ROLES;
const ROLE_NAMES = Object.keys(ROLES) as Role[];

describe('postgres isolation', () => {
  let env: StartedDockerComposeEnvironment;

  async function psql(role: Role, sql: string): Promise<{ ok: boolean; out: string }> {
    const r = await env
      .getContainer('postgres-1')
      .exec(
        ['psql', '-h', 'postgres', '-U', role, '-d', 'ridesharing', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql],
        { env: { PGPASSWORD: ROLES[role] } },
      );
    return { ok: r.exitCode === 0, out: `${r.stdout}${r.stderr}`.trim() };
  }

  beforeAll(async () => {
    env = await startStack('pg');
  }, 240_000);

  afterAll(async () => {
    await env?.down({ removeVolumes: true });
  }, 120_000);

  it.each(ROLE_NAMES)('%s can create, write and read a table in its own schema', async (role) => {
    expect((await psql(role, `CREATE TABLE ${role}.t (id int, v text)`)).ok).toBe(true);
    expect((await psql(role, `INSERT INTO ${role}.t VALUES (1, 'a')`)).ok).toBe(true);
    expect(await psql(role, 'SELECT v FROM t WHERE id = 1')).toEqual({ ok: true, out: 'a' });
    expect((await psql(role, `CREATE TABLE unqualified_t (id int)`)).ok).toBe(true);
    expect((await psql(role, `SELECT 1 FROM ${role}.unqualified_t`)).ok).toBe(true);
  });

  it.each(
    ROLE_NAMES.flatMap((role) =>
      [...ROLE_NAMES.filter((s) => s !== role), 'public' as const].map((schema) => [role, schema] as const),
    ),
  )('%s gets permission denied on schema %s', async (role, schema) => {
    const read = await psql(role, `SELECT * FROM ${schema}.t`);
    expect(read.ok).toBe(false);
    expect(read.out).toContain('permission denied');
    const create = await psql(role, `CREATE TABLE ${schema}.evil (id int)`);
    expect(create.ok).toBe(false);
    expect(create.out).toContain('permission denied');
  });

  it('trip_service can use PostGIS, via search_path and qualified', async () => {
    expect(await psql('trip_service', 'SELECT ST_AsText(ST_MakePoint(1,2))')).toEqual({
      ok: true,
      out: 'POINT(1 2)',
    });
    expect(await psql('trip_service', 'SELECT postgis.ST_AsText(postgis.ST_MakePoint(1,2))')).toEqual({
      ok: true,
      out: 'POINT(1 2)',
    });
    expect(
      (await psql('trip_service', 'CREATE TABLE places (g geography(Point, 4326))')).ok,
    ).toBe(true);
  });

  it.each(['user_service', 'matching_service'] as const)('%s cannot use PostGIS', async (role) => {
    const r = await psql(role, 'SELECT postgis.ST_AsText(postgis.ST_MakePoint(1,2))');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('permission denied');
    expect((await psql(role, 'SELECT ST_MakePoint(1,2)')).ok).toBe(false);
  });

  it('roles cannot connect to other databases', async () => {
    const r = await env
      .getContainer('postgres-1')
      .exec(['psql', '-h', 'postgres', '-U', 'user_service', '-d', 'postgres', '-c', 'select 1'], {
        env: { PGPASSWORD: ROLES.user_service },
      });
    expect(r.exitCode).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('permission denied');
  });
});
