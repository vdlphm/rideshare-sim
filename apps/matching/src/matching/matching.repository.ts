import { Injectable } from '@nestjs/common';
import { InjectDb, type Db } from '@rideshare/common';
import type { OfferStatus } from '@rideshare/contracts';
import { and, count, eq, sql } from 'drizzle-orm';
import { MatchingRepository } from '../domain/ports';
import type { MatchJob, NewOffer, OfferRecord } from '../domain/types';
import { matchJobs, offers } from '../db/schema';

type JobRow = typeof matchJobs.$inferSelect;
type OfferRow = typeof offers.$inferSelect;

const toJob = (r: JobRow): MatchJob => ({
  tripId: r.tripId,
  status: r.status,
  attempt: r.attempt,
  radiusM: r.radiusM,
  pickup: { lat: r.pickupLat, lng: r.pickupLng },
  dropoff: { lat: r.dropoffLat, lng: r.dropoffLng },
  startedSim: r.startedSim,
  updatedSim: r.updatedSim,
});

const toOffer = (r: OfferRow): OfferRecord => ({
  id: r.id,
  tripId: r.tripId,
  driverId: r.driverId,
  status: r.status,
  etaS: r.etaS,
  attempt: r.attempt,
  driverPosition: { lat: r.driverLat, lng: r.driverLng },
  pickup: { lat: r.pickupLat, lng: r.pickupLng },
  dropoff: { lat: r.dropoffLat, lng: r.dropoffLng },
  createdSim: r.createdSim,
  expiresSim: r.expiresSim,
  resolvedSim: r.resolvedSim,
});

const jobValues = (j: MatchJob) => ({
  tripId: j.tripId,
  status: j.status,
  attempt: j.attempt,
  radiusM: j.radiusM,
  pickupLat: j.pickup.lat,
  pickupLng: j.pickup.lng,
  dropoffLat: j.dropoff.lat,
  dropoffLng: j.dropoff.lng,
  startedSim: j.startedSim,
  updatedSim: j.updatedSim,
});

@Injectable()
export class DrizzleMatchingRepository extends MatchingRepository {
  constructor(@InjectDb() private readonly db: Db) {
    super();
  }

  async getJob(tripId: string): Promise<MatchJob | null> {
    const [row] = await this.db.select().from(matchJobs).where(eq(matchJobs.tripId, tripId));
    return row ? toJob(row) : null;
  }

  async createJob(job: MatchJob): Promise<boolean> {
    const rows = await this.db
      .insert(matchJobs)
      .values(jobValues(job))
      .onConflictDoNothing()
      .returning({ tripId: matchJobs.tripId });
    return rows.length > 0;
  }

  async updateJob(
    tripId: string,
    patch: Partial<Pick<MatchJob, 'status' | 'attempt' | 'radiusM' | 'updatedSim'>>,
  ): Promise<void> {
    await this.db.update(matchJobs).set(patch).where(eq(matchJobs.tripId, tripId));
  }

  async restartJob(job: MatchJob): Promise<void> {
    const values: Partial<ReturnType<typeof jobValues>> = jobValues(job);
    delete values.tripId;
    await this.db.update(matchJobs).set(values).where(eq(matchJobs.tripId, job.tripId));
  }

  async activeJobs(): Promise<MatchJob[]> {
    const rows = await this.db.select().from(matchJobs).where(eq(matchJobs.status, 'ACTIVE'));
    return rows.map(toJob);
  }

  async insertOffer(o: NewOffer): Promise<OfferRecord> {
    const [row] = await this.db
      .insert(offers)
      .values({
        tripId: o.tripId,
        driverId: o.driverId,
        status: 'PENDING',
        etaS: o.etaS,
        attempt: o.attempt,
        driverLat: o.driverPosition.lat,
        driverLng: o.driverPosition.lng,
        pickupLat: o.pickup.lat,
        pickupLng: o.pickup.lng,
        dropoffLat: o.dropoff.lat,
        dropoffLng: o.dropoff.lng,
        createdSim: o.createdSim,
        expiresSim: o.expiresSim,
      })
      .returning();
    return toOffer(row!);
  }

  async getOffer(id: string): Promise<OfferRecord | null> {
    const [row] = await this.db.select().from(offers).where(eq(offers.id, id));
    return row ? toOffer(row) : null;
  }

  async pendingOffers(): Promise<OfferRecord[]> {
    const rows = await this.db.select().from(offers).where(eq(offers.status, 'PENDING'));
    return rows.map(toOffer);
  }

  async pendingOfferForDriver(driverId: string): Promise<OfferRecord | null> {
    const [row] = await this.db
      .select()
      .from(offers)
      .where(and(eq(offers.driverId, driverId), eq(offers.status, 'PENDING')))
      .limit(1);
    return row ? toOffer(row) : null;
  }

  async pendingOfferForTrip(tripId: string): Promise<OfferRecord | null> {
    const [row] = await this.db
      .select()
      .from(offers)
      .where(and(eq(offers.tripId, tripId), eq(offers.status, 'PENDING')))
      .limit(1);
    return row ? toOffer(row) : null;
  }

  async countOffers(tripId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(offers)
      .where(eq(offers.tripId, tripId));
    return row?.n ?? 0;
  }

  async resolveOffer(id: string, status: OfferStatus, nowSim: number): Promise<boolean> {
    const rows = await this.db
      .update(offers)
      .set({ status, resolvedSim: nowSim })
      .where(and(eq(offers.id, id), sql`${offers.status} = 'PENDING'`))
      .returning({ id: offers.id });
    return rows.length > 0;
  }
}
