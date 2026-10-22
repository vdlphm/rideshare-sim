import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { sql } from 'drizzle-orm';
import { pgSchema } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import type { ReadinessCheck } from '../health';

export const DRIZZLE = Symbol('DRIZZLE');
export const PG_POOL = Symbol('PG_POOL');
export const DATABASE_OPTIONS = Symbol('DATABASE_OPTIONS');
export const POSTGRES_READINESS = Symbol('POSTGRES_READINESS');

export type Db = NodePgDatabase;

export interface DatabaseOptions {
  url: string;
  /** The service's Postgres schema; becomes the connection search_path. */
  schema: string;
  /** Folder of Drizzle migrations; when set they run on startup. */
  migrationsFolder?: string;
  /** Default `__drizzle_migrations`, always stored in `schema`. */
  migrationsTable?: string;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

export function assertSchemaName(schema: string): void {
  if (!IDENT.test(schema)) throw new Error(`Invalid Postgres schema name: "${schema}"`);
}

/** Declare service tables with `serviceSchema('trip').table('trips', {...})`. */
export function serviceSchema(name: string) {
  assertSchemaName(name);
  return pgSchema(name);
}

export const InjectDb = (): ParameterDecorator & PropertyDecorator => Inject(DRIZZLE);

export function createPool(opts: DatabaseOptions): Pool {
  assertSchemaName(opts.schema);
  return new Pool({ connectionString: opts.url, options: `-c search_path=${opts.schema}` });
}

/**
 * Drizzle-compatible migrator (same journal table layout as drizzle's `migrate`) that never
 * issues `CREATE SCHEMA`: drizzle's own migrator does, which a least-privileged service role
 * (no CREATE on the database) is not allowed to run even when the schema exists.
 */
export async function runMigrations(
  db: Db,
  opts: { migrationsFolder: string; schema: string; table: string },
): Promise<void> {
  assertSchemaName(opts.schema);
  assertSchemaName(opts.table);
  const journal = sql.raw(`"${opts.schema}"."${opts.table}"`);
  const migrations = readMigrationFiles({ migrationsFolder: opts.migrationsFolder });
  await db.transaction(async (tx) => {
    // Serialize concurrent starters (e.g. several replicas) on this schema's migrations.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${opts.schema + '.' + opts.table}))`,
    );
    await tx.execute(
      sql`create table if not exists ${journal} (id serial primary key, hash text not null, created_at bigint)`,
    );
    const last = await tx.execute<{ created_at: string }>(
      sql`select created_at from ${journal} order by created_at desc limit 1`,
    );
    const lastAt = last.rows[0] ? Number(last.rows[0].created_at) : -1;
    for (const m of migrations) {
      if (m.folderMillis <= lastAt) continue;
      for (const stmt of m.sql) await tx.execute(sql.raw(stmt));
      await tx.execute(
        sql`insert into ${journal} (hash, created_at) values (${m.hash}, ${m.folderMillis})`,
      );
    }
  });
}

@Injectable()
export class DatabaseLifecycle implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(DATABASE_OPTIONS) private readonly opts: DatabaseOptions,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.opts.migrationsFolder) return;
    await runMigrations(this.db, {
      migrationsFolder: this.opts.migrationsFolder,
      schema: this.opts.schema,
      table: this.opts.migrationsTable ?? '__drizzle_migrations',
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

export function postgresReadiness(pool: Pool): ReadinessCheck {
  return {
    name: 'postgres',
    async check() {
      await pool.query('SELECT 1');
    },
  };
}

@Module({})
export class DatabaseModule {
  static forRoot(opts: DatabaseOptions): DynamicModule {
    return {
      module: DatabaseModule,
      global: true,
      providers: [
        { provide: DATABASE_OPTIONS, useValue: opts },
        { provide: PG_POOL, useFactory: () => createPool(opts) },
        { provide: DRIZZLE, inject: [PG_POOL], useFactory: (pool: Pool) => drizzle(pool) },
        {
          provide: POSTGRES_READINESS,
          inject: [PG_POOL],
          useFactory: (pool: Pool) => postgresReadiness(pool),
        },
        DatabaseLifecycle,
      ],
      exports: [DRIZZLE, PG_POOL, POSTGRES_READINESS],
    };
  }
}
