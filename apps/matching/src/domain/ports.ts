import type { LatLng } from '@rideshare/contracts';
import type {
  AssignOutcome,
  Candidate,
  MatchJob,
  NewOffer,
  NoDriversOutcome,
  OfferRecord,
} from './types';
import type { OfferStatus } from '@rideshare/contracts';

/** Abstract classes double as Nest DI tokens. */
export abstract class DriversPort {
  /** AVAILABLE, fresh drivers within `radiusM`, closest first. */
  abstract nearby(pos: LatLng, radiusM: number, limit: number): Promise<Candidate[]>;
}

export abstract class RoutingPort {
  /** Drive time in seconds from each source to `destination`; null where not routable. */
  abstract etas(sources: LatLng[], destination: LatLng): Promise<(number | null)[]>;
}

export abstract class TripPort {
  abstract assign(
    tripId: string,
    body: { driverId: string; offerId: string; driverPosition: LatLng },
  ): Promise<AssignOutcome>;
  abstract noDrivers(tripId: string): Promise<NoDriversOutcome>;
}

export abstract class LockStore {
  /** `SET NX PX`; true when this trip now holds the driver's lock. */
  abstract acquire(driverId: string, tripId: string, ttlMs: number): Promise<boolean>;
  /** Releases only if `tripId` still holds the lock. */
  abstract release(driverId: string, tripId: string): Promise<void>;
  /** Extends the lock if `tripId` holds it (re-acquires if it lapsed and is free). */
  abstract refresh(driverId: string, tripId: string, ttlMs: number): Promise<void>;
  abstract addDeclined(tripId: string, driverId: string): Promise<void>;
  abstract declined(tripId: string): Promise<Set<string>>;
}

export abstract class MatchingRepository {
  abstract getJob(tripId: string): Promise<MatchJob | null>;
  /** Inserts an ACTIVE job unless one exists; true if inserted. */
  abstract createJob(job: MatchJob): Promise<boolean>;
  abstract updateJob(
    tripId: string,
    patch: Partial<Pick<MatchJob, 'status' | 'attempt' | 'radiusM' | 'updatedSim'>>,
  ): Promise<void>;
  /** Re-opens a DONE/FAILED job: ACTIVE, attempt 0, started now. */
  abstract restartJob(job: MatchJob): Promise<void>;
  abstract activeJobs(): Promise<MatchJob[]>;

  abstract insertOffer(offer: NewOffer): Promise<OfferRecord>;
  abstract getOffer(id: string): Promise<OfferRecord | null>;
  abstract pendingOffers(): Promise<OfferRecord[]>;
  abstract pendingOfferForDriver(driverId: string): Promise<OfferRecord | null>;
  abstract pendingOfferForTrip(tripId: string): Promise<OfferRecord | null>;
  abstract countOffers(tripId: string): Promise<number>;
  /** Atomic `UPDATE ... WHERE status = 'PENDING'`; true if this call resolved the offer. */
  abstract resolveOffer(id: string, status: OfferStatus, nowSim: number): Promise<boolean>;
}
