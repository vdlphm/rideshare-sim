import { ConflictException, Injectable } from '@nestjs/common';
import { InjectDb, type Db } from '@rideshare/common';
import type { Route, Trip, TripDetail, TripEvent, TripStatus } from '@rideshare/contracts';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { tripEvents, trips } from '../db/schema';
import { transition, type TransitionError, type TripAction } from '../domain/trip-state';
import { uniqueViolationConstraint } from '../pg-errors';
import type { RawStats } from './stats';

export const RIDER_CONSTRAINT = 'trips_rider_non_terminal_uq';
export const DRIVER_CONSTRAINT = 'trips_driver_active_uq';
export const NON_TERMINAL: TripStatus[] = ['REQUESTED', 'MATCHED', 'ARRIVED', 'IN_PROGRESS'];
export const ACTIVE: TripStatus[] = ['MATCHED', 'ARRIVED', 'IN_PROGRESS'];

export interface NewTrip {
  riderId: string;
  pickup: { lat: number; lng: number };
  dropoff: { lat: number; lng: number };
  tripRoute: Route;
  /** Null until a driver is matched. */
  pickupRoute?: Route | null;
  requestedAt: number;
}

type TripRow = typeof trips.$inferSelect;

export function rowToTrip(row: TripRow): Trip {
  const hasPickupRoute =
    row.pickupRoute &&
    row.pickupRouteDurations &&
    row.pickupRouteDistanceM !== null &&
    row.pickupRouteDurationS !== null;
  return {
    id: row.id,
    riderId: row.riderId,
    driverId: row.driverId,
    status: row.status as TripStatus,
    pickup: row.pickup,
    dropoff: row.dropoff,
    tripRoute: {
      distanceM: row.estDistanceM,
      durationS: row.estDurationS,
      geometry: row.tripRoute,
      durations: row.tripRouteDurations,
    },
    pickupRoute: hasPickupRoute
      ? {
          distanceM: row.pickupRouteDistanceM!,
          durationS: row.pickupRouteDurationS!,
          geometry: row.pickupRoute!,
          durations: row.pickupRouteDurations!,
        }
      : null,
    estDistanceM: row.estDistanceM,
    estDurationS: row.estDurationS,
    requestedAt: row.requestedAt,
    matchedAt: row.matchedAt,
    arrivedAt: row.arrivedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    endedReason: row.endedReason,
  };
}

export interface TransitionRequest {
  id: string;
  action: TripAction;
  /** Sim ms used for the timestamp column and the event. */
  nowSim: number;
  /** Set on assign (driver -> pickup route); unassign always clears the pickup route. */
  pickupRoute?: Route;
}

export type TransitionOutcome =
  | { ok: true; trip: TripDetail }
  | { ok: false; error: 'NOT_FOUND' | TransitionError; message: string };

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

async function loadEvents(db: Executor, tripId: string): Promise<TripEvent[]> {
  const rows = await db
    .select()
    .from(tripEvents)
    .where(eq(tripEvents.tripId, tripId))
    .orderBy(asc(tripEvents.atSim), asc(tripEvents.atReal));
  return rows.map((e) => ({
    fromStatus: e.fromStatus,
    toStatus: e.toStatus,
    atSim: e.atSim,
    atReal: e.atReal.toISOString(),
    meta: e.meta,
  }));
}

function conflictFor(err: unknown): ConflictException | undefined {
  const constraint = uniqueViolationConstraint(err);
  if (constraint === RIDER_CONSTRAINT) {
    return new ConflictException('rider already has an active trip');
  }
  if (constraint === DRIVER_CONSTRAINT) {
    return new ConflictException('driver already has an active trip');
  }
  return undefined;
}

export abstract class TripsRepository {
  /** Inserts a REQUESTED trip and its creation event in one transaction (409 if rider busy). */
  abstract insert(input: NewTrip): Promise<Trip>;
  abstract findById(id: string): Promise<Trip | undefined>;
  abstract findDetail(id: string): Promise<TripDetail | undefined>;
  /**
   * The single write path for state changes: `transition()` + optimistic versioned UPDATE +
   * trip_events row in ONE transaction. Throws ConflictException (409) on a lost optimistic
   * race or a rider/driver unique violation.
   */
  abstract applyTransition(req: TransitionRequest): Promise<TransitionOutcome>;
  abstract list(statuses: TripStatus[] | 'all', limit: number): Promise<Trip[]>;
  abstract listActiveForDrivers(driverIds: string[]): Promise<Trip[]>;
  abstract listNonTerminal(): Promise<Trip[]>;
  /** Trips (any status) changed at or after `since`, plus the DB clock to use as next cursor. */
  abstract listChangedSince(since: Date): Promise<{ trips: Trip[]; asOf: Date }>;
  abstract findDispatchable(requestedAtOrBefore: number, limit: number): Promise<Trip[]>;
  abstract rawStats(windowStartSim: number): Promise<RawStats>;
}

@Injectable()
export class DrizzleTripsRepository extends TripsRepository {
  constructor(@InjectDb() private readonly db: Db) {
    super();
  }

  async insert(input: NewTrip): Promise<Trip> {
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(trips)
          .values({
            riderId: input.riderId,
            status: 'REQUESTED',
            pickup: input.pickup,
            dropoff: input.dropoff,
            tripRoute: input.tripRoute.geometry,
            tripRouteDurations: input.tripRoute.durations,
            pickupRoute: input.pickupRoute?.geometry ?? null,
            pickupRouteDurations: input.pickupRoute?.durations ?? null,
            pickupRouteDistanceM: input.pickupRoute?.distanceM ?? null,
            pickupRouteDurationS: input.pickupRoute?.durationS ?? null,
            estDistanceM: input.tripRoute.distanceM,
            estDurationS: input.tripRoute.durationS,
            requestedAt: input.requestedAt,
          })
          .returning();
        await tx.insert(tripEvents).values({
          tripId: row!.id,
          fromStatus: null,
          toStatus: 'REQUESTED',
          atSim: input.requestedAt,
        });
        return rowToTrip(row!);
      });
    } catch (err) {
      throw conflictFor(err) ?? err;
    }
  }

  async findById(id: string): Promise<Trip | undefined> {
    const [row] = await this.db.select().from(trips).where(eq(trips.id, id));
    return row && rowToTrip(row);
  }

  async findDetail(id: string): Promise<TripDetail | undefined> {
    const trip = await this.findById(id);
    if (!trip) return undefined;
    return { ...trip, events: await loadEvents(this.db, id) };
  }

  async applyTransition(req: TransitionRequest): Promise<TransitionOutcome> {
    try {
      return await this.db.transaction(async (tx): Promise<TransitionOutcome> => {
        const [row] = await tx.select().from(trips).where(eq(trips.id, req.id));
        if (!row) return { ok: false, error: 'NOT_FOUND', message: 'Trip not found' };

        const result = transition(
          { status: row.status as TripStatus, driverId: row.driverId },
          req.action,
          req.nowSim,
        );
        if (!result.ok) return result;
        const next = result.next;

        const set: PgUpdateSetSource<typeof trips> = {
          status: next.status,
          driverId: next.driverId,
          version: row.version + 1,
          updatedAt: sql`now()`,
        };
        if (next.timestampField) set[next.timestampField] = req.nowSim;
        if (next.clearTimestampField) set[next.clearTimestampField] = null;
        if (next.endedReason) set.endedReason = next.endedReason;
        if (req.action.type === 'unassign' || req.action.type === 'assign') {
          const r = req.action.type === 'assign' ? req.pickupRoute : undefined;
          set.pickupRoute = r?.geometry ?? null;
          set.pickupRouteDurations = r?.durations ?? null;
          set.pickupRouteDistanceM = r?.distanceM ?? null;
          set.pickupRouteDurationS = r?.durationS ?? null;
        }

        const updated = await tx
          .update(trips)
          .set(set)
          .where(and(eq(trips.id, req.id), eq(trips.version, row.version)))
          .returning();
        if (updated.length === 0) {
          throw new ConflictException('Trip was modified concurrently');
        }
        await tx.insert(tripEvents).values({
          tripId: req.id,
          fromStatus: row.status,
          toStatus: next.status,
          atSim: req.nowSim,
          meta: next.eventMeta ?? {},
        });
        return {
          ok: true,
          trip: { ...rowToTrip(updated[0]!), events: await loadEvents(tx, req.id) },
        };
      });
    } catch (err) {
      throw conflictFor(err) ?? err;
    }
  }

  async list(statuses: TripStatus[] | 'all', limit: number): Promise<Trip[]> {
    const rows = await this.db
      .select()
      .from(trips)
      .where(statuses === 'all' ? undefined : inArray(trips.status, statuses))
      .orderBy(desc(trips.requestedAt))
      .limit(limit);
    return rows.map(rowToTrip);
  }

  async listActiveForDrivers(driverIds: string[]): Promise<Trip[]> {
    if (driverIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(trips)
      .where(and(inArray(trips.driverId, driverIds), inArray(trips.status, ACTIVE)));
    return rows.map(rowToTrip);
  }

  async listNonTerminal(): Promise<Trip[]> {
    const rows = await this.db.select().from(trips).where(inArray(trips.status, NON_TERMINAL));
    return rows.map(rowToTrip);
  }

  async listChangedSince(since: Date): Promise<{ trips: Trip[]; asOf: Date }> {
    const clock = await this.db.execute<{ now: Date }>(sql`select now() as now`);
    const asOf = new Date(clock.rows[0]!.now);
    const rows = await this.db.select().from(trips).where(gte(trips.updatedAt, since));
    return { trips: rows.map(rowToTrip), asOf };
  }

  async findDispatchable(requestedAtOrBefore: number, limit: number): Promise<Trip[]> {
    const rows = await this.db
      .select()
      .from(trips)
      .where(and(eq(trips.status, 'REQUESTED'), lte(trips.requestedAt, requestedAtOrBefore)))
      .orderBy(asc(trips.requestedAt))
      .limit(limit);
    return rows.map(rowToTrip);
  }

  async rawStats(windowStartSim: number): Promise<RawStats> {
    const res = await this.db.execute<{
      waiting: number;
      active: number;
      completed: number;
      no_drivers: number;
      avg_match_ms: number | null;
      avg_pickup_ms: number | null;
    }>(sql`
      select
        count(*) filter (where status = 'REQUESTED')::int as waiting,
        count(*) filter (where status in ('MATCHED', 'ARRIVED', 'IN_PROGRESS'))::int as active,
        count(*) filter (where status = 'COMPLETED')::int as completed,
        count(*) filter (where status = 'NO_DRIVERS')::int as no_drivers,
        (avg(matched_at - requested_at)
          filter (where status = 'COMPLETED' and completed_at >= ${windowStartSim}))::float8
          as avg_match_ms,
        (avg(arrived_at - requested_at)
          filter (where status = 'COMPLETED' and completed_at >= ${windowStartSim}))::float8
          as avg_pickup_ms
      from trips`);
    const r = res.rows[0]!;
    return {
      waiting: r.waiting,
      active: r.active,
      completed: r.completed,
      noDrivers: r.no_drivers,
      avgMatchMs: r.avg_match_ms,
      avgPickupMs: r.avg_pickup_ms,
    };
  }
}
