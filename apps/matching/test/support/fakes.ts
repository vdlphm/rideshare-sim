import type { LatLng, OfferStatus } from '@rideshare/contracts';
import { randomUUID } from 'node:crypto';
import {
  CANDIDATE_LIMIT,
  MatchingEngine,
  type EngineOptions,
} from '../../src/domain/matching.engine';
import {
  DriversPort,
  LockStore,
  MatchingRepository,
  RoutingPort,
  TripPort,
} from '../../src/domain/ports';
import type {
  AssignOutcome,
  Candidate,
  MatchJob,
  NewOffer,
  NoDriversOutcome,
  OfferRecord,
} from '../../src/domain/types';

export const PICKUP: LatLng = { lat: 47.6062, lng: -122.3321 };
export const DROPOFF: LatLng = { lat: 47.6205, lng: -122.3493 };

export class FakeClock {
  t = 1_000_000;
  now(): number {
    return this.t;
  }
}

export class FakeDrivers extends DriversPort {
  /** All drivers the driver service would know about. */
  available: Candidate[] = [];
  calls: { radiusM: number; limit: number }[] = [];
  failing = false;

  async nearby(_pos: LatLng, radiusM: number, limit: number): Promise<Candidate[]> {
    this.calls.push({ radiusM, limit });
    if (this.failing) throw new Error('driver down');
    return this.available
      .filter((d) => d.distanceM <= radiusM)
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, limit);
  }
}

export class FakeRouting extends RoutingPort {
  etaByDriver = new Map<string, number | null>();
  failing = false;
  calls = 0;
  private readonly byPos = new Map<string, string>();

  register(c: Candidate, etaS: number | null): void {
    this.byPos.set(`${c.lat},${c.lng}`, c.driverId);
    this.etaByDriver.set(c.driverId, etaS);
  }

  async etas(sources: LatLng[]): Promise<(number | null)[]> {
    this.calls++;
    if (this.failing) throw new Error('routing down');
    return sources.map((s) => this.etaByDriver.get(this.byPos.get(`${s.lat},${s.lng}`)!) ?? null);
  }
}

export class FakeTrip extends TripPort {
  assignOutcome: AssignOutcome = 'ok';
  noDriversOutcome: NoDriversOutcome = 'ok';
  assigns: { tripId: string; driverId: string; offerId: string; driverPosition: LatLng }[] = [];
  noDriversCalls: string[] = [];

  async assign(
    tripId: string,
    body: { driverId: string; offerId: string; driverPosition: LatLng },
  ) {
    this.assigns.push({ tripId, ...body });
    return this.assignOutcome;
  }
  async noDrivers(tripId: string): Promise<NoDriversOutcome> {
    this.noDriversCalls.push(tripId);
    return this.noDriversOutcome;
  }
}

export class FakeLocks extends LockStore {
  readonly held = new Map<string, string>();
  readonly declinedSets = new Map<string, Set<string>>();
  refreshed: string[] = [];

  async acquire(driverId: string, tripId: string): Promise<boolean> {
    if (this.held.has(driverId)) return false;
    this.held.set(driverId, tripId);
    return true;
  }
  async release(driverId: string, tripId: string): Promise<void> {
    if (this.held.get(driverId) === tripId) this.held.delete(driverId);
  }
  async refresh(driverId: string, tripId: string): Promise<void> {
    this.refreshed.push(`${driverId}:${tripId}`);
    if (!this.held.has(driverId)) this.held.set(driverId, tripId);
  }
  async addDeclined(tripId: string, driverId: string): Promise<void> {
    const s = this.declinedSets.get(tripId) ?? new Set<string>();
    s.add(driverId);
    this.declinedSets.set(tripId, s);
  }
  async declined(tripId: string): Promise<Set<string>> {
    return new Set(this.declinedSets.get(tripId) ?? []);
  }
}

export class InMemoryRepo extends MatchingRepository {
  readonly jobs = new Map<string, MatchJob>();
  readonly offers = new Map<string, OfferRecord>();

  async getJob(tripId: string) {
    const j = this.jobs.get(tripId);
    return j ? { ...j } : null;
  }
  async createJob(job: MatchJob) {
    if (this.jobs.has(job.tripId)) return false;
    this.jobs.set(job.tripId, { ...job });
    return true;
  }
  async updateJob(tripId: string, patch: Partial<MatchJob>) {
    Object.assign(this.jobs.get(tripId)!, patch);
  }
  async restartJob(job: MatchJob) {
    this.jobs.set(job.tripId, { ...job });
  }
  async activeJobs() {
    return [...this.jobs.values()].filter((j) => j.status === 'ACTIVE').map((j) => ({ ...j }));
  }
  async insertOffer(o: NewOffer) {
    const rec: OfferRecord = { ...o, id: randomUUID(), status: 'PENDING', resolvedSim: null };
    this.offers.set(rec.id, rec);
    return { ...rec };
  }
  async getOffer(id: string) {
    const o = this.offers.get(id);
    return o ? { ...o } : null;
  }
  private pending() {
    return [...this.offers.values()].filter((o) => o.status === 'PENDING');
  }
  async pendingOffers() {
    return this.pending().map((o) => ({ ...o }));
  }
  async pendingOfferForDriver(driverId: string) {
    return this.pending().find((o) => o.driverId === driverId) ?? null;
  }
  async pendingOfferForTrip(tripId: string) {
    return this.pending().find((o) => o.tripId === tripId) ?? null;
  }
  async countOffers(tripId: string) {
    return [...this.offers.values()].filter((o) => o.tripId === tripId).length;
  }
  async resolveOffer(id: string, status: OfferStatus, nowSim: number) {
    const o = this.offers.get(id);
    if (!o || o.status !== 'PENDING') return false;
    o.status = status;
    o.resolvedSim = nowSim;
    return true;
  }
}

export function driver(distanceM: number, etaS: number | null, routing?: FakeRouting): Candidate {
  const c: Candidate = {
    driverId: randomUUID(),
    lat: PICKUP.lat + distanceM / 111_000,
    lng: PICKUP.lng,
    distanceM,
  };
  routing?.register(c, etaS);
  return c;
}

export function setup(opts: Partial<EngineOptions> = {}) {
  const clock = new FakeClock();
  const drivers = new FakeDrivers();
  const routing = new FakeRouting();
  const trip = new FakeTrip();
  const locks = new FakeLocks();
  const repo = new InMemoryRepo();
  const engine = new MatchingEngine(drivers, routing, trip, locks, repo, clock, {
    offerTtlSimMs: 15_000,
    giveUpSimMs: 60_000,
    lockTtlMs: 15_000,
    idleRetryMs: 0,
    ...opts,
  });
  const add = (distanceM: number, etaS: number | null) => {
    const c = driver(distanceM, etaS, routing);
    drivers.available.push(c);
    return c;
  };
  /** Requests a match and waits for the first step to finish. */
  const start = async (tripId: string) => {
    await engine.requestMatch({ tripId, pickup: PICKUP, dropoff: DROPOFF });
    await engine.step(tripId);
  };
  const pending = (tripId: string) =>
    [...repo.offers.values()].filter((o) => o.tripId === tripId && o.status === 'PENDING');
  return {
    clock,
    drivers,
    routing,
    trip,
    locks,
    repo,
    engine,
    add,
    start,
    pending,
    CANDIDATE_LIMIT,
  };
}
