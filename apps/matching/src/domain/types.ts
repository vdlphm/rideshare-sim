import type { LatLng, NearbyDriver, OfferStatus } from '@rideshare/contracts';

export type JobStatus = 'ACTIVE' | 'DONE' | 'FAILED';

export interface MatchJob {
  tripId: string;
  status: JobStatus;
  /** Index of the widest search radius reached so far (0 = first radius). */
  attempt: number;
  radiusM: number;
  pickup: LatLng;
  dropoff: LatLng;
  startedSim: number;
  updatedSim: number;
}

export interface OfferRecord {
  id: string;
  tripId: string;
  driverId: string;
  status: OfferStatus;
  etaS: number;
  /** 1-based count of offers made for this trip. */
  attempt: number;
  /** The candidate's position when the offer was made; sent to Trip as `driverPosition`. */
  driverPosition: LatLng;
  pickup: LatLng;
  dropoff: LatLng;
  createdSim: number;
  expiresSim: number;
  resolvedSim: number | null;
}

export type NewOffer = Omit<OfferRecord, 'id' | 'status' | 'resolvedSim'>;

export type Candidate = NearbyDriver;

export interface Clock {
  now(): number;
}

export type AssignOutcome =
  | 'ok'
  /** Trip is no longer REQUESTED (or unknown): stop the job. */
  | 'trip-gone'
  /** The driver already holds an active trip. */
  | 'driver-busy'
  /** Trip was modified concurrently: try the next step. */
  | 'conflict'
  | 'unreachable';

export type NoDriversOutcome = 'ok' | 'trip-gone' | 'unreachable';

export interface MatchRequestInput {
  tripId: string;
  pickup: LatLng;
  dropoff: LatLng;
}
