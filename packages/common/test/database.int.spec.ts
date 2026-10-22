import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE, DatabaseModule, POSTGRES_READINESS, type Db, type ReadinessCheck } from '../src';

let container: StartedPostgreSqlContainer;
let admin: Client;
let app: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>;
let db: Db;

const tables = async (schema: string) =>
  (
    await admin.query('select table_name from information_schema.tables where table_schema=$1', [
      schema,
    ])
  ).rows.map((r) => r.table_name as string);

beforeAll(async () => {
  container = await new PostgreSqlContainer('imresamu/postgis:16-3.5').start();
  admin = new Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await admin.query(`
    CREATE ROLE svc_a LOGIN PASSWORD 'pw';
    CREATE SCHEMA svc_a AUTHORIZATION svc_a;
    CREATE SCHEMA svc_b;
    CREATE TABLE svc_b.secret (id int);
    ALTER ROLE svc_a SET search_path = svc_a;
  `);
  const url = new URL(container.getConnectionUri());
  url.username = 'svc_a';
  url.password = 'pw';
  app = await Test.createTestingModule({
    imports: [
      DatabaseModule.forRoot({
        url: url.toString(),
        schema: 'svc_a',
        migrationsFolder: join(__dirname, 'fixtures/migrations'),
      }),
    ],
  }).compile();
  await app.init();
  db = app.get(DRIZZLE);
}, 180_000);

afterAll(async () => {
  await app.close();
  await admin.end();
  await container.stop();
});

describe('DatabaseModule', () => {
  it('runs migrations inside the service schema, not public', async () => {
    expect(await tables('svc_a')).toEqual(
      expect.arrayContaining(['widgets', '__drizzle_migrations']),
    );
    expect(await tables('public')).not.toContain('widgets');
    expect(await tables('public')).not.toContain('__drizzle_migrations');
    expect(await tables('drizzle')).toEqual([]);
  });

  it('uses the schema as search_path and hides other schemas by default', async () => {
    const sp = await db.execute(sql`show search_path`);
    expect(sp.rows[0]).toEqual({ search_path: 'svc_a' });
    await db.execute(sql`insert into widgets (name) values ('w')`);
    await expect(db.execute(sql`select * from secret`)).rejects.toThrow();
  });

  it('readiness check passes', async () => {
    const check = app.get<ReadinessCheck>(POSTGRES_READINESS);
    expect(check.name).toBe('postgres');
    await expect(check.check()).resolves.toBeUndefined();
  });
});
