import { ConflictException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DRIZZLE, type Db } from '@rideshare/common';
import { TripSchema, type Route } from '@rideshare/contracts';
import { sql } from 'drizzle-orm';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { trips } from '../src/db/schema';
import { TripsRepository, type NewTrip } from '../src/trips/trips.repository';

const INIT_SCRIPT = resolve(__dirname, '../../../infra/postgres/init/01-init.sh');
const TRIP_PW = 'trip-svc-pw';
const USER_PW = 'user-svc-pw';

let container: StartedPostgreSqlContainer;
let admin: Client;
let moduleRef: TestingModule;
let repo: TripsRepository;
let db: Db;
let host: string;
let port: number;

const pickup = { lat: 47.6062, lng: -122.3321 };
const dropoff = { lat: 47.6205, lng: -122.3493 };
const route = (from: typeof pickup, to: typeof pickup, extra = 0): Route => ({
  distanceM: 2345.6 + extra,
  durationS: 321.5 + extra,
  geometry: [
    [from.lng, from.lat],
    [(from.lng + to.lng) / 2, (from.lat + to.lat) / 2],
    [to.lng, to.lat],
  ],
  durations: [100.25, 221.25 + extra],
});

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

const newTrip = (riderId = uuid(), withPickupRoute = false): NewTrip => ({
  riderId,
  pickup,
  dropoff,
  tripRoute: route(pickup, dropoff),
  pickupRoute: withPickupRoute ? route(dropoff, pickup, 5) : null,
  requestedAt: 1000,
});

const setStatus = (id: string, status: string, driverId: string | null = null) =>
  db.execute(
    sql`update trips set status = ${status}::trip_status, driver_id = ${driverId} where id = ${id}`,
  );

const haversineM = (a: typeof pickup, b: typeof pickup) => {
  const r = 6371008.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
};

function uniqueViolation(err: unknown): { code?: string; constraint?: string } {
  let cur: unknown = err;
  while (cur && typeof cur === 'object') {
    const e = cur as { code?: string; constraint?: string; cause?: unknown };
    if (e.code === '23505') return e;
    cur = e.cause;
  }
  return {};
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('imresamu/postgis:16-3.5')
    .withUsername('postgres')
    .withPassword('pg-admin-pw')
    .withEnvironment({
      USER_SERVICE_DB_PASSWORD: USER_PW,
      TRIP_SERVICE_DB_PASSWORD: TRIP_PW,
      MATCHING_SERVICE_DB_PASSWORD: 'matching-pw',
    })
    .withCopyFilesToContainer([
      { source: INIT_SCRIPT, target: '/docker-entrypoint-initdb.d/01-init.sh', mode: 0o755 },
    ])
    .start();
  host = container.getHost();
  port = container.getPort();
  admin = new Client({
    connectionString: `postgres://postgres:pg-admin-pw@${host}:${port}/ridesharing`,
  });
  await admin.connect();

  moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        PORT: '0',
        DATABASE_URL: `postgres://trip_service:${TRIP_PW}@${host}:${port}/ridesharing`,
        TRIP_CLIENT_SECRET: 'test-secret',
        // Unreachable on purpose: the repository tests do not call any upstream.
        USER_SERVICE_URL: 'http://127.0.0.1:1',
        SIMULATOR_URL: 'http://127.0.0.1:1',
      }),
    ],
  }).compile();
  await moduleRef.init(); // runs the migrations as the trip_service role
  repo = moduleRef.get(TripsRepository);
  db = moduleRef.get<Db>(DRIZZLE);
}, 240_000);

afterAll(async () => {
  await moduleRef?.close();
  await admin?.end();
  await container?.stop();
});

describe('migrations', () => {
  it('create all tables, the enum and the indexes in trip_service only', async () => {
    const tables = await admin.query(
      `select table_schema, table_name from information_schema.tables
       where table_schema in ('trip_service','public') and table_type = 'BASE TABLE'
       order by 1, 2`,
    );
    expect(tables.rows.map((r) => `${r.table_schema}.${r.table_name}`)).toEqual([
      'trip_service.__drizzle_migrations',
      'trip_service.trip_events',
      'trip_service.trips',
    ]);

    const enums = await admin.query(
      `select n.nspname, t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
       where t.typtype = 'e'`,
    );
    expect(enums.rows).toEqual([{ nspname: 'trip_service', typname: 'trip_status' }]);

    const idx = await admin.query(
      `select schemaname, indexname from pg_indexes where tablename in ('trips','trip_events')`,
    );
    expect(new Set(idx.rows.map((r) => r.schemaname))).toEqual(new Set(['trip_service']));
    expect(idx.rows.map((r) => r.indexname)).toEqual(
      expect.arrayContaining([
        'trips_rider_non_terminal_uq',
        'trips_driver_active_uq',
        'trips_status_idx',
        'trips_requested_at_idx',
        'trip_events_trip_at_sim_idx',
      ]),
    );

    const owner = await admin.query(
      `select tableowner from pg_tables where schemaname='trip_service' and tablename='trips'`,
    );
    expect(owner.rows[0].tableowner).toBe('trip_service');
  });
});

describe('repository round-trip', () => {
  it('stores and loads pickup, dropoff and both routes unchanged', async () => {
    const input = newTrip(uuid(), true);
    const created = await repo.insert(input);
    const loaded = await repo.findById(created.id);

    expect(loaded).toEqual(created);
    expect(() => TripSchema.parse(loaded)).not.toThrow();
    expect(loaded).toMatchObject({
      status: 'REQUESTED',
      driverId: null,
      requestedAt: 1000,
      matchedAt: null,
      estDistanceM: input.tripRoute.distanceM,
      estDurationS: input.tripRoute.durationS,
    });
    expect(loaded!.pickup).toEqual(pickup);
    expect(loaded!.dropoff).toEqual(dropoff);
    expect(loaded!.tripRoute).toEqual(input.tripRoute);
    expect(loaded!.pickupRoute).toEqual(input.pickupRoute);
  });

  it('loads a trip without a pickup route and writes the creation event', async () => {
    const created = await repo.insert(newTrip());
    expect(created.pickupRoute).toBeNull();
    expect(TripSchema.safeParse(created).success).toBe(true);
    const events = await admin.query(
      `select from_status, to_status, at_sim from trip_service.trip_events where trip_id = $1`,
      [created.id],
    );
    expect(events.rows).toEqual([{ from_status: null, to_status: 'REQUESTED', at_sim: '1000' }]);
    expect(await repo.findById(uuid())).toBeUndefined();
  });
});

describe('partial unique indexes', () => {
  it('allows one non-terminal trip per rider, and a new one after completion', async () => {
    const riderId = uuid();
    const first = await repo.insert(newTrip(riderId));

    const err = await repo.insert(newTrip(riderId)).then(
      () => undefined,
      (e: unknown) => e,
    );
    // The repository maps the rider unique violation to a 409.
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toBe('rider already has an active trip');

    await setStatus(first.id, 'COMPLETED');
    await expect(repo.insert(newTrip(riderId))).resolves.toBeDefined();
  });

  it('also treats NO_DRIVERS as terminal', async () => {
    const riderId = uuid();
    const first = await repo.insert(newTrip(riderId));
    await setStatus(first.id, 'NO_DRIVERS');
    await expect(repo.insert(newTrip(riderId))).resolves.toBeDefined();
  });

  it('allows one active trip per driver, and another after completion', async () => {
    const driverId = uuid();
    const a = await repo.insert(newTrip());
    const b = await repo.insert(newTrip());
    await setStatus(a.id, 'MATCHED', driverId);

    const err = await setStatus(b.id, 'MATCHED', driverId).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(uniqueViolation(err)).toMatchObject({
      code: '23505',
      constraint: 'trips_driver_active_uq',
    });

    await setStatus(a.id, 'COMPLETED', driverId);
    await expect(setStatus(b.id, 'MATCHED', driverId)).resolves.toBeDefined();
  });

  it('does not limit REQUESTED trips per driver (driver_id is null there)', async () => {
    await repo.insert(newTrip());
    await expect(repo.insert(newTrip())).resolves.toBeDefined();
  });
});

describe('PostGIS access and isolation', () => {
  it('trip_service can call PostGIS on stored geography', async () => {
    const created = await repo.insert(newTrip());
    const res = await db.execute<{ d: number; wkt: string }>(
      sql`select postgis.ST_Distance(pickup, dropoff) as d, postgis.ST_AsText(pickup) as wkt
          from trips where id = ${created.id}`,
    );
    const { d, wkt } = res.rows[0]!;
    expect(wkt).toBe(`POINT(${pickup.lng} ${pickup.lat})`);
    const expected = haversineM(pickup, dropoff);
    expect(Math.abs(d - expected) / expected).toBeLessThan(0.005);
  });

  it('can run a spatial query over trips', async () => {
    const rows = await db
      .select({ id: trips.id })
      .from(trips)
      .where(
        sql`postgis.ST_DWithin(${trips.pickup}, postgis.ST_MakePoint(${pickup.lng}, ${pickup.lat})::postgis.geography, 10)`,
      )
      .limit(1);
    expect(rows.length).toBe(1);
  });

  it('user_service cannot read trip_service.trips', async () => {
    const user = new Client({
      connectionString: `postgres://user_service:${USER_PW}@${host}:${port}/ridesharing`,
    });
    await user.connect();
    try {
      await expect(user.query('select * from trip_service.trips')).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await user.end();
    }
  });
});
