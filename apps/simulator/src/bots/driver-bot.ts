import type { LatLng, Offer, TripDetail } from '@rideshare/contracts';
import {
  SEATTLE_SPAWN_BBOX,
  interpolateAlongRoute,
  randomPointInBbox,
  type LngLat,
  type RoutePosition,
} from '@rideshare/geo';
import type { DriverApi, DriverMe, Result } from './bot-client';
import {
  OFFER_TTL_SIM_MS_DEFAULT,
  isRunning,
  randBetween,
  type BotEnv,
  type Job,
  type Snapper,
  type Task,
} from './bot-env';

export type DriverPhase =
  'STARTING' | 'IDLE' | 'OFFERED' | 'TO_PICKUP' | 'AT_PICKUP' | 'IN_TRIP' | 'STOPPED';

export interface RouteLeg {
  geometry: LngLat[];
  durations: number[];
}

export interface DriverState {
  phase: DriverPhase;
  position: LatLng | null;
  heading: number;
  driverId?: string;
  accountReady: boolean;
  retiring: boolean;
  /** Real ms of the last location post / offer poll / failure backoff end. */
  lastLocationReal: number;
  lastPollReal: number;
  retryAtReal: number;
  failures: number;
  offer?: { id: string; answerAtSim: number };
  tripId?: string;
  /** Route being followed (pickup route in TO_PICKUP, trip route in IN_TRIP); unset => fetch trip. */
  leg?: RouteLeg;
  legStartSim: number;
  waitUntilSim: number;
  tripRoute?: RouteLeg;
}

export type DriverAction =
  | { type: 'init' }
  | { type: 'fetchTrip' }
  | { type: 'location'; pos: LatLng; heading: number }
  | { type: 'poll' }
  | { type: 'answer'; accept: boolean }
  | { type: 'arrive' }
  | { type: 'startTrip' }
  | { type: 'complete' }
  | { type: 'offline' };

/** Stale sweeper marks drivers OFFLINE after 60 s real without a location; stay well inside. */
export const HEARTBEAT_MS = 3000;
export const MOVE_POST_MS = 1000;
export const MAX_BACKOFF_MS = 30_000;
export const ACCEPT_DELAY_SIM_MS: [number, number] = [500, 2000];
export const PICKUP_WAIT_SIM_MS: [number, number] = [5000, 15_000];

export const initialDriverState = (): DriverState => ({
  phase: 'STARTING',
  position: null,
  heading: 0,
  accountReady: false,
  retiring: false,
  lastLocationReal: 0,
  lastPollReal: 0,
  retryAtReal: 0,
  failures: 0,
  legStartSim: 0,
  waitUntilSim: 0,
});

/** Real ms between offer polls: fast enough that a 15 sim-s offer is seen well before expiry. */
export function offerPollIntervalMs(
  speed: number,
  offerTtlSimMs = OFFER_TTL_SIM_MS_DEFAULT,
): number {
  const raw = speed > 0 ? offerTtlSimMs / speed / 5 : Number.POSITIVE_INFINITY;
  return Math.min(1500, Math.max(150, raw));
}

export const normalizeHeading = (h: number): number => ((h % 360) + 360) % 360;

/** Position along the current leg at sim time `simNow`; null when there is no leg. */
export function legPosition(s: DriverState, simNow: number): RoutePosition | null {
  if (!s.leg) return null;
  return interpolateAlongRoute(s.leg.geometry, s.leg.durations, (simNow - s.legStartSim) / 1000);
}

const isMoving = (p: DriverPhase): boolean => p === 'TO_PICKUP' || p === 'IN_TRIP';

/** Pure decision: which single action (if any) is due now. */
export function decide(
  s: DriverState,
  env: BotEnv,
  offerTtlSimMs = OFFER_TTL_SIM_MS_DEFAULT,
): DriverAction | null {
  if (s.phase === 'STOPPED') return null;
  const real = env.realNow();
  const sim = env.simNow();
  const running = isRunning(env);
  const retryOk = real >= s.retryAtReal;

  if (s.phase === 'STARTING') return retryOk ? { type: 'init' } : null;

  const moving = isMoving(s.phase);
  const interval = moving && running ? MOVE_POST_MS : HEARTBEAT_MS;
  const here = s.position as LatLng;
  const locationDue = s.position !== null && real - s.lastLocationReal >= interval;
  const heartbeat = (): DriverAction | null =>
    locationDue ? { type: 'location', pos: here, heading: s.heading } : null;

  switch (s.phase) {
    case 'IDLE': {
      const hb = heartbeat();
      if (hb) return hb;
      if (s.retiring) return retryOk ? { type: 'offline' } : null;
      if (
        running &&
        retryOk &&
        real - s.lastPollReal >= offerPollIntervalMs(env.config().speed, offerTtlSimMs)
      ) {
        return { type: 'poll' };
      }
      return null;
    }
    case 'OFFERED': {
      if (running && retryOk && s.offer && (s.retiring || sim >= s.offer.answerAtSim)) {
        return {
          type: 'answer',
          accept: !s.retiring && env.rng() < env.config().acceptProbability,
        };
      }
      return heartbeat();
    }
    case 'AT_PICKUP': {
      if (running && retryOk && sim >= s.waitUntilSim) return { type: 'startTrip' };
      return heartbeat();
    }
    case 'TO_PICKUP':
    case 'IN_TRIP': {
      const pos = legPosition(s, sim);
      if (!pos) {
        if (retryOk) return { type: 'fetchTrip' };
        return heartbeat();
      }
      if (running && retryOk && pos.done) {
        return { type: s.phase === 'TO_PICKUP' ? 'arrive' : 'complete' };
      }
      return locationDue
        ? { type: 'location', pos: pos.position, heading: normalizeHeading(pos.headingDeg) }
        : null;
    }
  }
  return null;
}

// ---- pure transitions -------------------------------------------------------------------

export function toIdle(s: DriverState): DriverState {
  return {
    ...s,
    phase: 'IDLE',
    offer: undefined,
    tripId: undefined,
    leg: undefined,
    tripRoute: undefined,
    lastPollReal: 0,
    failures: 0,
    retryAtReal: 0,
  };
}

export function withBackoff(s: DriverState, real: number): DriverState {
  const failures = s.failures + 1;
  return {
    ...s,
    failures,
    retryAtReal: real + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (failures - 1)),
  };
}

export function offerReceived(s: DriverState, offer: Offer, env: BotEnv): DriverState {
  return {
    ...s,
    phase: 'OFFERED',
    driverId: s.driverId ?? offer.driverId,
    offer: {
      id: offer.id,
      answerAtSim: env.simNow() + randBetween(env, ...ACCEPT_DELAY_SIM_MS),
    },
  };
}

const legOf = (r: { geometry: LngLat[]; durations: number[] }): RouteLeg => ({
  geometry: r.geometry,
  durations: r.durations,
});

/** Phase for a freshly fetched trip, or null when the trip is not ours / not active. */
export function tripLoaded(s: DriverState, trip: TripDetail, env: BotEnv): DriverState | null {
  if (s.driverId && trip.driverId && trip.driverId !== s.driverId) return null;
  const sim = env.simNow();
  const tripRoute = legOf(trip.tripRoute);
  switch (trip.status) {
    case 'MATCHED':
      if (!trip.pickupRoute) return null;
      return {
        ...s,
        phase: 'TO_PICKUP',
        tripId: trip.id,
        leg: legOf(trip.pickupRoute),
        tripRoute,
        legStartSim: sim,
        failures: 0,
        retryAtReal: 0,
      };
    case 'ARRIVED':
      return {
        ...s,
        phase: 'AT_PICKUP',
        tripId: trip.id,
        leg: undefined,
        tripRoute,
        waitUntilSim: sim + randBetween(env, ...PICKUP_WAIT_SIM_MS),
        failures: 0,
        retryAtReal: 0,
      };
    case 'IN_PROGRESS':
      return {
        ...s,
        phase: 'IN_TRIP',
        tripId: trip.id,
        leg: tripRoute,
        tripRoute,
        legStartSim: sim,
        failures: 0,
        retryAtReal: 0,
      };
    default:
      return null;
  }
}

const GONE = new Set([403, 404, 409, 410]);
const lastPoint = (leg: RouteLeg): LatLng => {
  const [lng, lat] = leg.geometry[leg.geometry.length - 1];
  return { lat, lng };
};

export interface DriverBotOptions {
  offerTtlSimMs?: number;
  log?: (msg: string) => void;
}

/** Effects around the pure core: executes the due action against the API and applies the result. */
export class DriverBot implements Task {
  private s: DriverState = initialDriverState();
  private readonly ttl: number;

  constructor(
    readonly index: number,
    private readonly api: DriverApi,
    private readonly env: BotEnv,
    private readonly snapper: Snapper,
    private readonly opts: DriverBotOptions = {},
  ) {
    this.ttl = opts.offerTtlSimMs ?? OFFER_TTL_SIM_MS_DEFAULT;
  }

  get state(): Readonly<DriverState> {
    return this.s;
  }
  get phase(): DriverPhase {
    return this.s.phase;
  }
  get retiring(): boolean {
    return this.s.retiring;
  }
  retire(): void {
    this.s = { ...this.s, retiring: true };
  }
  cancelRetire(): void {
    this.s = { ...this.s, retiring: false };
  }

  due(): Job | null {
    const action = decide(this.s, this.env, this.ttl);
    return action ? () => this.perform(action) : null;
  }

  async perform(action: DriverAction): Promise<void> {
    const real = this.env.realNow();
    switch (action.type) {
      case 'init':
        return this.init();
      case 'location': {
        const res = await this.api.postLocation(action.pos, action.heading);
        this.s = {
          ...this.s,
          position: action.pos,
          heading: action.heading,
          lastLocationReal: this.env.realNow(),
        };
        // Swept OFFLINE (e.g. while the process was starved): go online again.
        if (
          !res.ok &&
          res.status === 409 &&
          (this.s.phase === 'IDLE' || this.s.phase === 'OFFERED')
        ) {
          this.s = { ...toIdle(this.s), phase: 'STARTING' };
        }
        return;
      }
      case 'poll': {
        this.s = { ...this.s, lastPollReal: real };
        const res = await this.api.getOffer();
        if (res.ok && res.data && this.s.phase === 'IDLE') {
          this.s = offerReceived(this.s, res.data, this.env);
        }
        return;
      }
      case 'answer':
        return this.answer(action.accept);
      case 'fetchTrip':
        return this.fetchTrip();
      case 'arrive': {
        const res = await this.api.arrive(this.s.tripId as string);
        if (res.ok) {
          const pos = this.s.leg ? lastPoint(this.s.leg) : this.s.position;
          this.s = {
            ...this.s,
            phase: 'AT_PICKUP',
            position: pos,
            leg: undefined,
            waitUntilSim: this.env.simNow() + randBetween(this.env, ...PICKUP_WAIT_SIM_MS),
            failures: 0,
            retryAtReal: 0,
          };
        } else this.tripFailure(res);
        return;
      }
      case 'startTrip': {
        const res = await this.api.startTrip(this.s.tripId as string);
        if (res.ok && this.s.tripRoute) {
          this.s = {
            ...this.s,
            phase: 'IN_TRIP',
            leg: this.s.tripRoute,
            legStartSim: this.env.simNow(),
            failures: 0,
            retryAtReal: 0,
          };
        } else if (res.ok) {
          this.s = { ...this.s, phase: 'IN_TRIP', leg: undefined };
        } else this.tripFailure(res);
        return;
      }
      case 'complete': {
        const res = await this.api.completeTrip(this.s.tripId as string);
        if (res.ok) {
          const pos = this.s.leg ? lastPoint(this.s.leg) : this.s.position;
          this.s = { ...toIdle(this.s), position: pos };
        } else this.tripFailure(res);
        return;
      }
      case 'offline': {
        const res = await this.api.goOffline();
        this.s = res.ok ? { ...this.s, phase: 'STOPPED' } : withBackoff(this.s, this.env.realNow());
        return;
      }
    }
  }

  /** Best-effort offline for shutdown; only meaningful when idle. */
  async goOfflineNow(): Promise<void> {
    if (this.s.phase === 'IDLE' || this.s.phase === 'OFFERED') {
      await this.api.goOffline();
    }
  }

  private tripFailure(res: Result<unknown>): void {
    if (!res.ok && GONE.has(res.status)) this.s = toIdle(this.s);
    else this.s = withBackoff(this.s, this.env.realNow());
  }

  private async pickStart(): Promise<LatLng | null> {
    for (let i = 0; i < 5; i++) {
      const snapped = await this.snapper
        .snap(randomPointInBbox(SEATTLE_SPAWN_BBOX, this.env.rng))
        .catch(() => null);
      if (snapped) return snapped;
    }
    return null;
  }

  private async init(): Promise<void> {
    const fail = () => {
      this.s = withBackoff(this.s, this.env.realNow());
    };
    if (!this.s.accountReady) {
      const acct = await this.api.ensureAccount();
      if (!acct.ok) return fail();
      this.s = { ...this.s, accountReady: true };
    }
    const res = await this.api.driverMe();
    // The driver service has no state for an account that never went online: it answers 404.
    const me: Result<DriverMe> =
      !res.ok && res.status === 404
        ? { ok: true, status: 200, data: { status: 'OFFLINE', tripId: null } }
        : res;
    if (!me.ok) return fail();
    const { status, tripId, lat, lng } = me.data;
    const known = typeof lat === 'number' && typeof lng === 'number' ? { lat, lng } : null;
    this.s = { ...this.s, driverId: me.data.driverId ?? this.s.driverId };

    if (status === 'ON_TRIP' && tripId) {
      // Simulator restarted mid-trip: resume at whatever phase the trip is in.
      this.s = {
        ...this.s,
        phase: 'TO_PICKUP',
        tripId,
        leg: undefined,
        position: known ?? this.s.position,
        heading: me.data.heading ?? this.s.heading,
        lastLocationReal: this.env.realNow(),
        failures: 0,
        retryAtReal: 0,
      };
      return;
    }
    if (status === 'AVAILABLE' && known) {
      this.s = {
        ...toIdle(this.s),
        position: known,
        heading: me.data.heading ?? 0,
        lastLocationReal: this.env.realNow(),
      };
      return;
    }
    const pos = this.s.position ?? (await this.pickStart());
    if (!pos) return fail();
    const online = await this.api.goOnline(pos);
    if (!online.ok) return fail();
    this.s = {
      ...toIdle(this.s),
      position: pos,
      heading: Math.floor(this.env.rng() * 360),
      lastLocationReal: this.env.realNow(),
    };
  }

  private async answer(accept: boolean): Promise<void> {
    const offer = this.s.offer;
    if (!offer) {
      this.s = toIdle(this.s);
      return;
    }
    if (!accept) {
      await this.api.declineOffer(offer.id);
      this.s = toIdle(this.s);
      return;
    }
    let res = await this.api.acceptOffer(offer.id);
    if (!res.ok && res.status === 502) res = await this.api.acceptOffer(offer.id);
    if (!res.ok) {
      this.s = toIdle(this.s);
      return;
    }
    this.s = {
      ...this.s,
      phase: 'TO_PICKUP',
      offer: undefined,
      tripId: res.data.tripId,
      leg: undefined,
    };
    await this.fetchTrip();
  }

  private async fetchTrip(): Promise<void> {
    const tripId = this.s.tripId;
    if (!tripId) {
      this.s = toIdle(this.s);
      return;
    }
    const res = await this.api.getTrip(tripId);
    if (!res.ok) {
      this.tripFailure(res);
      return;
    }
    this.s = tripLoaded(this.s, res.data, this.env) ?? toIdle(this.s);
  }
}
