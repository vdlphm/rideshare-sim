import { createHttpClient, type SimClock } from '@rideshare/common';
import type { Route, Trip, TripDetail, TripStatus } from '@rideshare/contracts';
import { MockAgent } from 'undici';
import { transition } from '../../src/domain/trip-state';
import type { RawStats } from '../../src/trips/stats';
import {
  TripsRepository,
  type NewTrip,
  type TransitionOutcome,
  type TransitionRequest,
} from '../../src/trips/trips.repository';
import { Upstreams } from '../../src/upstream/upstreams.service';

export const pickup = { lat: 47.6062, lng: -122.3321 };
export const dropoff = { lat: 47.6205, lng: -122.3493 };

export const makeRoute = (from: { lat: number; lng: number }, to: typeof from): Route => ({
  distanceM: 1000,
  durationS: 100,
  geometry: [
    [from.lng, from.lat],
    [to.lng, to.lat],
  ],
  durations: [100],
});

export class FakeClock {
  t = 1_000_000;
  now = () => this.t;
  sync = async () => {};
}
export const asSimClock = (c: FakeClock) => c as unknown as SimClock;

let seq = 0;
export const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

/** In-memory repository running the real state machine. */
export class FakeRepo extends TripsRepository {
  trips = new Map<string, TripDetail>();
  lastStatsWindow: number | undefined;
  rawStatsResult: RawStats = {
    waiting: 0,
    active: 0,
    completed: 0,
    noDrivers: 0,
    avgMatchMs: null,
    avgPickupMs: null,
  };

  async insert(input: NewTrip): Promise<Trip> {
    const id = uuid();
    const t: TripDetail = {
      id,
      riderId: input.riderId,
      driverId: null,
      status: 'REQUESTED',
      pickup: input.pickup,
      dropoff: input.dropoff,
      tripRoute: input.tripRoute,
      pickupRoute: null,
      estDistanceM: input.tripRoute.distanceM,
      estDurationS: input.tripRoute.durationS,
      requestedAt: input.requestedAt,
      matchedAt: null,
      arrivedAt: null,
      startedAt: null,
      completedAt: null,
      endedReason: null,
      events: [],
    };
    this.trips.set(id, t);
    return t;
  }
  async findById(id: string) {
    return this.trips.get(id);
  }
  async findDetail(id: string) {
    return this.trips.get(id);
  }
  async applyTransition(req: TransitionRequest): Promise<TransitionOutcome> {
    const t = this.trips.get(req.id);
    if (!t) return { ok: false, error: 'NOT_FOUND', message: 'Trip not found' };
    const r = transition(t, req.action, req.nowSim);
    if (!r.ok) return r;
    const n = r.next;
    const updated: TripDetail = {
      ...t,
      status: n.status,
      driverId: n.driverId,
      pickupRoute: req.action.type === 'assign' ? (req.pickupRoute ?? null) : null,
      endedReason: n.endedReason ?? t.endedReason,
    };
    if (n.timestampField) updated[n.timestampField] = req.nowSim;
    if (n.clearTimestampField) updated[n.clearTimestampField] = null;
    this.trips.set(req.id, updated);
    return { ok: true, trip: updated };
  }
  async list(statuses: TripStatus[] | 'all') {
    return [...this.trips.values()].filter(
      (t) => statuses === 'all' || statuses.includes(t.status),
    );
  }
  async listActiveForDrivers() {
    return [];
  }
  async listNonTerminal() {
    return [];
  }
  async listChangedSince() {
    return { trips: [], asOf: new Date() };
  }
  async findDispatchable(requestedAtOrBefore: number) {
    return [...this.trips.values()].filter(
      (t) => t.status === 'REQUESTED' && t.requestedAt <= requestedAtOrBefore,
    );
  }
  async rawStats(windowStartSim: number) {
    this.lastStatsWindow = windowStartSim;
    return this.rawStatsResult;
  }
}

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

export interface Handler {
  (call: Call): { status: number; body?: unknown };
}

/** Fake routing/driver/matching services behind an undici MockAgent. */
export function fakeUpstreams(handlers: {
  routing?: Handler;
  driver?: Handler;
  matching?: Handler;
}) {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const calls: Record<'routing' | 'driver' | 'matching', Call[]> = {
    routing: [],
    driver: [],
    matching: [],
  };
  const defaults: Required<typeof handlers> = {
    routing: (c) => {
      const url = new URL(c.path, 'http://x');
      if (url.pathname === '/internal/nearest') {
        // Snap by nudging so tests can tell snapped from raw coordinates.
        return {
          status: 200,
          body: {
            lat: Number(url.searchParams.get('lat')) + 0.0001,
            lng: Number(url.searchParams.get('lng')) + 0.0001,
            distanceM: 11,
          },
        };
      }
      const [fl, fg] = url.searchParams.get('from')!.split(',').map(Number);
      const [tl, tg] = url.searchParams.get('to')!.split(',').map(Number);
      return { status: 200, body: makeRoute({ lat: fl!, lng: fg! }, { lat: tl!, lng: tg! }) };
    },
    driver: () => ({ status: 200, body: {} }),
    matching: () => ({ status: 202, body: {} }),
  };
  const origins = {
    routing: 'http://routing.test',
    driver: 'http://driver.test',
    matching: 'http://matching.test',
  };
  for (const name of ['routing', 'driver', 'matching'] as const) {
    const h = handlers[name] ?? defaults[name];
    agent
      .get(origins[name])
      .intercept({ path: () => true, method: () => true })
      .reply((opts) => {
        const call: Call = {
          method: String(opts.method),
          path: String(opts.path),
          body: opts.body ? JSON.parse(String(opts.body)) : undefined,
        };
        calls[name].push(call);
        const r = h(call);
        return {
          statusCode: r.status,
          data: JSON.stringify(r.body ?? {}),
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      })
      .persist();
  }
  const client = (name: keyof typeof origins) =>
    createHttpClient({
      baseUrl: origins[name],
      service: name,
      auth: 'none',
      dispatcher: agent,
      sleep: async () => {},
    });
  const upstreams = new Upstreams(client('routing'), client('driver'), client('matching'));
  let closed = false;
  return {
    upstreams,
    calls,
    close: async () => {
      if (!closed) await agent.close();
      closed = true;
    },
  };
}
