import type { Offer, SimConfig, TripDetail } from '@rideshare/contracts';
import type { DriverApi, DriverMe, Result, RiderApi } from '../../src/bots/bot-client';
import type { BotEnv, Snapper } from '../../src/bots/bot-env';

export const ok = <T>(data: T, status = 200): Result<T> => ({ ok: true, status, data });
export const err = (status: number, message = 'err'): Result<never> => ({
  ok: false,
  status,
  message,
});

/** Mulberry32: tiny seeded RNG. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class FakeEnv implements BotEnv {
  sim = 0;
  real = 1_000_000;
  cfg: SimConfig = {
    driverCount: 5,
    spawnIntervalS: 3,
    speed: 1,
    paused: false,
    acceptProbability: 1,
  };
  rng: () => number;
  constructor(seed = 1) {
    this.rng = seeded(seed);
  }
  simNow = () => this.sim;
  realNow = () => this.real;
  config = () => this.cfg;
  /** Advances real time; sim time follows (unless paused) scaled by speed. */
  advance(realMs: number): void {
    this.real += realMs;
    if (!this.cfg.paused) this.sim += realMs * this.cfg.speed;
  }
}

export const identitySnapper: Snapper = { snap: async (p) => p };

export const A = { lat: 47.6, lng: -122.34 };
export const B = { lat: 47.61, lng: -122.33 };
export const C = { lat: 47.62, lng: -122.32 };

export const route = (pts: [number, number][], per: number) => ({
  distanceM: 1000,
  durationS: per * (pts.length - 1),
  geometry: pts,
  durations: pts.slice(1).map(() => per),
});

export const PICKUP_ROUTE = route(
  [
    [-122.34, 47.6],
    [-122.34, 47.601],
    [-122.34, 47.602],
  ],
  10,
);
export const TRIP_ROUTE = route(
  [
    [-122.34, 47.602],
    [-122.33, 47.603],
    [-122.32, 47.604],
  ],
  20,
);

export const trip = (over: Partial<TripDetail> = {}): TripDetail =>
  ({
    id: 'trip-1',
    riderId: 'rider-1',
    driverId: 'drv-1',
    status: 'MATCHED',
    pickup: A,
    dropoff: B,
    tripRoute: TRIP_ROUTE,
    pickupRoute: PICKUP_ROUTE,
    events: [],
    ...over,
  }) as unknown as TripDetail;

export const offer = (over: Partial<Offer> = {}): Offer =>
  ({
    id: 'offer-1',
    tripId: 'trip-1',
    driverId: 'drv-1',
    status: 'PENDING',
    etaS: 30,
    attempt: 1,
    expiresSim: 15000,
    pickup: A,
    dropoff: B,
    ...over,
  }) as Offer;

type Handler<T> = Result<T> | (() => Result<T>);
const run = <T>(h: Handler<T>): Result<T> => (typeof h === 'function' ? h() : h);

/** Scriptable driver API recording every call as `name:arg`. */
export class FakeDriverApi implements DriverApi {
  calls: string[] = [];
  locations: { lat: number; lng: number; heading: number }[] = [];
  me: Handler<DriverMe> = ok({ status: 'OFFLINE', tripId: null, driverId: 'drv-1' });
  online: Handler<void> = ok(undefined);
  offline: Handler<void> = ok(undefined);
  location: Handler<void> = ok(undefined, 204);
  offerQueue: (Offer | null)[] = [];
  accept: Handler<{ tripId: string }> = ok({ tripId: 'trip-1' });
  decline: Handler<void> = ok(undefined, 204);
  tripResult: Handler<TripDetail> = ok(trip());
  arriveR: Handler<void> = ok(undefined);
  startR: Handler<void> = ok(undefined);
  completeR: Handler<void> = ok(undefined);

  count = (prefix: string) => this.calls.filter((c) => c.startsWith(prefix)).length;

  async ensureAccount() {
    this.calls.push('ensure');
    return ok(undefined);
  }
  async driverMe() {
    this.calls.push('me');
    return run(this.me);
  }
  async goOnline(pos: { lat: number; lng: number }) {
    this.calls.push(`online:${pos.lat},${pos.lng}`);
    return run(this.online);
  }
  async goOffline() {
    this.calls.push('offline');
    return run(this.offline);
  }
  async postLocation(pos: { lat: number; lng: number }, heading: number) {
    this.calls.push('location');
    this.locations.push({ ...pos, heading });
    return run(this.location);
  }
  async getOffer() {
    this.calls.push('poll');
    const next = this.offerQueue.shift();
    return ok(next ?? null, next ? 200 : 204);
  }
  async acceptOffer(id: string) {
    this.calls.push(`accept:${id}`);
    return run(this.accept);
  }
  async declineOffer(id: string) {
    this.calls.push(`decline:${id}`);
    return run(this.decline);
  }
  async getTrip(id: string) {
    this.calls.push(`trip:${id}`);
    return run(this.tripResult);
  }
  async arrive(id: string) {
    this.calls.push(`arrive:${id}`);
    return run(this.arriveR);
  }
  async startTrip(id: string) {
    this.calls.push(`start:${id}`);
    return run(this.startR);
  }
  async completeTrip(id: string) {
    this.calls.push(`complete:${id}`);
    return run(this.completeR);
  }
}

export class FakeRiderApi implements RiderApi {
  calls: string[] = [];
  requests: { pickup?: unknown; dropoff: unknown }[] = [];
  requestResult: Handler<{ tripId: string }> = () =>
    ok({ tripId: `trip-${this.requests.length}` }, 201);
  tripStatus: TripDetail['status'] = 'REQUESTED';
  async ensureAccount() {
    this.calls.push('ensure');
    return ok(undefined);
  }
  async riderLocation(pos: { lat: number; lng: number }) {
    this.calls.push(`location:${pos.lat},${pos.lng}`);
    return ok(undefined, 204);
  }
  async requestRide(body: { pickup?: unknown; dropoff: unknown }) {
    this.calls.push('request');
    this.requests.push(body);
    return run(this.requestResult);
  }
  async getTrip(id: string) {
    this.calls.push(`trip:${id}`);
    return ok(trip({ id, status: this.tripStatus }));
  }
}
