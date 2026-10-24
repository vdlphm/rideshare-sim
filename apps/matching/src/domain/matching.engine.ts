import {
  BadGatewayException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { LatLng } from '@rideshare/contracts';
import { DriversPort, LockStore, MatchingRepository, RoutingPort, TripPort } from './ports';
import type { Candidate, Clock, MatchJob, MatchRequestInput, OfferRecord } from './types';

export const CLOCK = Symbol('MATCHING_CLOCK');
export const ENGINE_OPTIONS = Symbol('MATCHING_ENGINE_OPTIONS');

export const RADII_M = [1000, 2000, 4000] as const;
export const CANDIDATE_LIMIT = 10;

export interface EngineOptions {
  offerTtlSimMs: number;
  giveUpSimMs: number;
  lockTtlMs: number;
  /** Min real ms between sweeper-driven retries of one waiting job (0 = every sweep). */
  idleRetryMs: number;
  /** Real-time clock in ms (injectable for tests). */
  realNow?: () => number;
}

export interface SweepStats {
  expired: number;
  stepped: number;
}

/**
 * The matching algorithm. All collaborators are injected ports, so it is unit-testable with
 * fakes. Work for one trip is serialized by an in-process mutex (single instance by design);
 * every offer status change is additionally an atomic `WHERE status = 'PENDING'` update.
 */
@Injectable()
export class MatchingEngine {
  private readonly logger = new Logger(MatchingEngine.name);
  private readonly tails = new Map<string, Promise<void>>();
  private readonly queuedSteps = new Set<string>();
  private readonly lastIdleStep = new Map<string, number>();
  private readonly realNow: () => number;

  constructor(
    private readonly drivers: DriversPort,
    private readonly routing: RoutingPort,
    private readonly trip: TripPort,
    private readonly locks: LockStore,
    private readonly repo: MatchingRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENGINE_OPTIONS) private readonly opts: EngineOptions,
  ) {
    this.realNow = opts.realNow ?? Date.now;
  }

  // ---- internal API ----

  /**
   * Idempotent per trip: no job -> create + start; ACTIVE -> no-op; DONE/FAILED -> restart
   * (the declined set is kept). Returns once the job row is written; matching runs in the
   * background.
   */
  async requestMatch(req: MatchRequestInput): Promise<'started' | 'restarted' | 'noop'> {
    const outcome = await this.withTrip(req.tripId, async () => {
      const now = this.clock.now();
      const fresh: MatchJob = {
        tripId: req.tripId,
        status: 'ACTIVE',
        attempt: 0,
        radiusM: RADII_M[0],
        pickup: req.pickup,
        dropoff: req.dropoff,
        startedSim: now,
        updatedSim: now,
      };
      if (await this.repo.createJob(fresh)) return 'started' as const;
      const job = await this.repo.getJob(req.tripId);
      if (!job || job.status === 'ACTIVE') return 'noop' as const;
      await this.repo.restartJob(fresh);
      return 'restarted' as const;
    });
    if (outcome !== 'noop') this.stepInBackground(req.tripId);
    return outcome;
  }

  // ---- driver API ----

  /** The driver's PENDING, unexpired offer. */
  async currentOffer(driverId: string): Promise<OfferRecord | null> {
    const offer = await this.repo.pendingOfferForDriver(driverId);
    return offer && offer.expiresSim > this.clock.now() ? offer : null;
  }

  /** Returns the trip id; throws the HTTP exceptions of the accept contract. */
  async accept(offerId: string, driverId: string): Promise<{ tripId: string }> {
    const found = await this.ownedOffer(offerId, driverId);
    let followUp = false;
    try {
      return await this.withTrip(found.tripId, async () => {
        const offer = (await this.repo.getOffer(offerId))!;
        if (offer.status !== 'PENDING' || offer.expiresSim <= this.clock.now()) {
          throw new GoneException('offer is no longer available');
        }
        const outcome = await this.trip.assign(offer.tripId, {
          driverId,
          offerId,
          driverPosition: offer.driverPosition,
        });
        const now = this.clock.now();
        switch (outcome) {
          case 'ok':
            await this.repo.resolveOffer(offerId, 'ACCEPTED', now);
            await this.repo.updateJob(offer.tripId, { status: 'DONE', updatedSim: now });
            await this.locks.release(driverId, offer.tripId);
            return { tripId: offer.tripId };
          case 'trip-gone':
            await this.repo.resolveOffer(offerId, 'EXPIRED', now);
            await this.repo.updateJob(offer.tripId, { status: 'DONE', updatedSim: now });
            await this.locks.release(driverId, offer.tripId);
            throw new ConflictException('trip no longer available');
          case 'driver-busy':
          case 'conflict':
            await this.closeOffer(offer, 'EXPIRED', now);
            followUp = true;
            throw new ConflictException(
              outcome === 'driver-busy'
                ? 'driver already has an active trip'
                : 'trip was modified, offer withdrawn',
            );
          case 'unreachable':
            throw new BadGatewayException('trip service unavailable, try again');
        }
      });
    } finally {
      if (followUp) this.stepInBackground(found.tripId);
    }
  }

  async decline(offerId: string, driverId: string): Promise<void> {
    const found = await this.ownedOffer(offerId, driverId);
    await this.withTrip(found.tripId, async () => {
      const offer = (await this.repo.getOffer(offerId))!;
      if (offer.status !== 'PENDING') throw new GoneException('offer is no longer available');
      await this.closeOffer(offer, 'DECLINED', this.clock.now());
    });
    this.stepInBackground(found.tripId);
  }

  // ---- background work ----

  /** One sweeper pass: refresh locks, expire due offers, re-step idle ACTIVE jobs. */
  async sweep(): Promise<SweepStats> {
    const now = this.clock.now();
    const pending = await this.repo.pendingOffers();
    const stats: SweepStats = { expired: 0, stepped: 0 };

    for (const o of pending) {
      if (o.expiresSim > now) {
        await this.guard(`refresh lock ${o.driverId}`, () =>
          this.locks.refresh(o.driverId, o.tripId, this.opts.lockTtlMs),
        );
      }
    }
    for (const o of pending.filter((x) => x.expiresSim <= now)) {
      await this.guard(`expire offer ${o.id}`, async () => {
        const expired = await this.withTrip(o.tripId, async () => {
          const fresh = await this.repo.getOffer(o.id);
          if (!fresh || fresh.status !== 'PENDING') return false;
          await this.closeOffer(fresh, 'EXPIRED', this.clock.now());
          return true;
        });
        if (expired) {
          stats.expired++;
          await this.step(o.tripId);
        }
      });
    }

    const waiting = new Set((await this.repo.pendingOffers()).map((o) => o.tripId));
    const realNow = this.realNow();
    const active = await this.repo.activeJobs();
    const activeIds = new Set(active.map((j) => j.tripId));
    for (const id of this.lastIdleStep.keys()) if (!activeIds.has(id)) this.lastIdleStep.delete(id);
    for (const job of active) {
      if (waiting.has(job.tripId)) continue;
      const last = this.lastIdleStep.get(job.tripId);
      if (last !== undefined && realNow - last < this.opts.idleRetryMs) continue;
      this.lastIdleStep.set(job.tripId, realNow);
      stats.stepped++;
      await this.guard(`step ${job.tripId}`, () => this.step(job.tripId));
    }
    return stats;
  }

  /** Runs one matching step for the trip, serialized with other work on that trip. */
  async step(tripId: string): Promise<void> {
    // A queued step reads fresh state when it runs, so a second one adds nothing.
    if (this.queuedSteps.has(tripId)) return;
    this.queuedSteps.add(tripId);
    await this.withTrip(tripId, async () => {
      this.queuedSteps.delete(tripId);
      await this.stepLocked(tripId);
    });
  }

  /** Resolves once all queued per-trip work has finished (used on shutdown). */
  async idle(): Promise<void> {
    while (this.tails.size > 0) await Promise.all([...this.tails.values()]);
  }

  // ---- internals ----

  private stepInBackground(tripId: string): void {
    void this.step(tripId).catch((err: unknown) =>
      this.logger.error(`step for trip ${tripId} failed: ${String(err)}`),
    );
  }

  private async guard(what: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.error(`${what} failed: ${String(err)}`);
    }
  }

  private async ownedOffer(offerId: string, driverId: string): Promise<OfferRecord> {
    const offer = await this.repo.getOffer(offerId);
    // Same answer for "no such offer" and "someone else's offer": no existence oracle.
    if (!offer || offer.driverId !== driverId) throw new NotFoundException('offer not found');
    return offer;
  }

  /** Resolves a PENDING offer, marks the driver declined for the trip and frees the lock. */
  private async closeOffer(
    offer: OfferRecord,
    status: 'DECLINED' | 'EXPIRED',
    now: number,
  ): Promise<void> {
    await this.repo.resolveOffer(offer.id, status, now);
    await this.locks.addDeclined(offer.tripId, offer.driverId);
    await this.locks.release(offer.driverId, offer.tripId);
  }

  private async stepLocked(tripId: string): Promise<void> {
    const job = await this.repo.getJob(tripId);
    if (!job || job.status !== 'ACTIVE') return;
    if (await this.repo.pendingOfferForTrip(tripId)) return;

    const now = this.clock.now();
    if (now - job.startedSim > this.opts.giveUpSimMs) return this.giveUp(job, now);

    const declined = await this.locks.declined(tripId);
    for (let i = Math.min(job.attempt, RADII_M.length - 1); i < RADII_M.length; i++) {
      const radius = RADII_M[i]!;
      let candidates: Candidate[];
      try {
        candidates = await this.drivers.nearby(job.pickup, radius, CANDIDATE_LIMIT);
      } catch (err) {
        this.logger.warn(`nearby drivers unavailable for trip ${tripId}: ${String(err)}`);
        return;
      }
      candidates = candidates.filter((c) => !declined.has(c.driverId));
      if (candidates.length === 0) continue;

      let ranked: { c: Candidate; etaS: number }[];
      try {
        ranked = await this.rank(candidates, job.pickup);
      } catch (err) {
        this.logger.warn(`routing unavailable for trip ${tripId}: ${String(err)}`);
        return;
      }
      for (const { c, etaS } of ranked) {
        if (await this.offer(job, c, etaS, now, i, radius)) return;
      }
    }
    // Nobody usable at any radius: stay at the widest radius and retry on later sweeps.
    const last = RADII_M.length - 1;
    if (job.attempt !== last) {
      await this.repo.updateJob(tripId, { attempt: last, radiusM: RADII_M[last], updatedSim: now });
    }
  }

  private async rank(
    candidates: Candidate[],
    pickup: LatLng,
  ): Promise<{ c: Candidate; etaS: number }[]> {
    const etas = await this.routing.etas(
      candidates.map((c) => ({ lat: c.lat, lng: c.lng })),
      pickup,
    );
    return candidates
      .map((c, i) => ({ c, etaS: etas[i] ?? null }))
      .filter((x): x is { c: Candidate; etaS: number } => x.etaS !== null)
      .sort((a, b) => a.etaS - b.etaS);
  }

  /** Locks the driver and records a PENDING offer; false if the driver is not free. */
  private async offer(
    job: MatchJob,
    c: Candidate,
    etaS: number,
    now: number,
    radiusIdx: number,
    radius: number,
  ): Promise<boolean> {
    if (!(await this.locks.acquire(c.driverId, job.tripId, this.opts.lockTtlMs))) return false;
    try {
      // Belt and braces: never two PENDING offers for one driver, even if a lock lapsed.
      if (await this.repo.pendingOfferForDriver(c.driverId)) {
        await this.locks.release(c.driverId, job.tripId);
        return false;
      }
      await this.repo.insertOffer({
        tripId: job.tripId,
        driverId: c.driverId,
        etaS,
        attempt: (await this.repo.countOffers(job.tripId)) + 1,
        driverPosition: { lat: c.lat, lng: c.lng },
        pickup: job.pickup,
        dropoff: job.dropoff,
        createdSim: now,
        expiresSim: now + this.opts.offerTtlSimMs,
      });
      await this.repo.updateJob(job.tripId, {
        attempt: radiusIdx,
        radiusM: radius,
        updatedSim: now,
      });
      return true;
    } catch (err) {
      await this.locks.release(c.driverId, job.tripId);
      throw err;
    }
  }

  private async giveUp(job: MatchJob, now: number): Promise<void> {
    const outcome = await this.trip.noDrivers(job.tripId);
    if (outcome === 'unreachable') return; // retried on the next sweep
    await this.repo.updateJob(job.tripId, {
      status: outcome === 'ok' ? 'FAILED' : 'DONE',
      updatedSim: now,
    });
    this.lastIdleStep.delete(job.tripId);
  }

  private async withTrip<T>(tripId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(tripId) ?? Promise.resolve();
    const run = prev.then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(tripId, tail);
    void tail.then(() => {
      if (this.tails.get(tripId) === tail) this.tails.delete(tripId);
    });
    return run;
  }
}
