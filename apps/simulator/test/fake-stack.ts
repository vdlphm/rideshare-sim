/* eslint-disable @typescript-eslint/no-explicit-any -- request bodies are untyped JSON in a fake */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

type Pt = { lat: number; lng: number };
interface User {
  id: string;
  email: string;
  password: string;
  role: 'driver' | 'rider';
  vehicle?: unknown;
}
interface DriverRec {
  status: 'OFFLINE' | 'AVAILABLE' | 'ON_TRIP';
  pos: Pt | null;
  heading: number;
  tripId: string | null;
  locations: { pos: Pt; heading: number; tripStatus: string | null }[];
  heartbeats: number;
}
interface Offer {
  id: string;
  tripId: string;
  driverId: string;
}
interface FakeTrip {
  id: string;
  riderId: string;
  driverId: string | null;
  status: 'REQUESTED' | 'MATCHED' | 'ARRIVED' | 'IN_PROGRESS' | 'COMPLETED' | 'NO_DRIVERS';
  pickup: Pt;
  dropoff: Pt;
  pickupRoute: ReturnType<typeof line> | null;
  tripRoute: ReturnType<typeof line>;
  events: { toStatus: string }[];
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
export const jwt = (claims: Record<string, unknown>) =>
  `${b64({ alg: 'none' })}.${b64(claims)}.sig`;

/** Straight 3-point route; `per` seconds per segment. */
function line(a: Pt, b: Pt, per: number) {
  const mid = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
  return {
    distanceM: 1000,
    durationS: per * 2,
    geometry: [
      [a.lng, a.lat],
      [mid.lng, mid.lat],
      [b.lng, b.lat],
    ] as [number, number][],
    durations: [per, per],
  };
}

const listen = (server: Server): Promise<string> =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    );
  });

const readBody = async (req: IncomingMessage): Promise<Record<string, any>> => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : {};
};

const send = (res: ServerResponse, status: number, body?: unknown) => {
  res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
};

/**
 * Tiny in-memory gateway + routing + user service implementing just the endpoints the bots use,
 * with a minimal trip/offer model (first free driver gets the offer).
 */
export class FakeStack {
  users = new Map<string, User>();
  byId = new Map<string, User>();
  drivers = new Map<string, DriverRec>();
  riderPos = new Map<string, Pt>();
  trips = new Map<string, FakeTrip>();
  offers = new Map<string, Offer>(); // by driverId
  refreshTokens = new Map<string, string>();
  log: string[] = [];
  rideRequests: { email: string; body: any }[] = [];
  offlineCalls: string[] = [];
  serviceTokenCalls = 0;
  private servers: Server[] = [];
  gatewayUrl = '';
  routingUrl = '';
  userUrl = '';
  /** Dropoffs with lat above this get 422 (not routable). */
  unroutableAboveLat = 47.7;

  async start(): Promise<void> {
    const gateway = createServer((req, res) => this.gateway(req, res).catch(() => send(res, 500)));
    const routing = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== '/internal/nearest') return send(res, 404);
      send(res, 200, {
        lat: Number(url.searchParams.get('lat')),
        lng: Number(url.searchParams.get('lng')),
        distanceM: 3,
      });
    });
    const user = createServer(async (req, res) => {
      await readBody(req);
      this.serviceTokenCalls++;
      send(res, 200, {
        accessToken: jwt({
          sub: 'simulator',
          role: 'service',
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
        expiresIn: 3600,
      });
    });
    this.servers = [gateway, routing, user];
    [this.gatewayUrl, this.routingUrl, this.userUrl] = await Promise.all([
      listen(gateway),
      listen(routing),
      listen(user),
    ]);
  }

  async stop(): Promise<void> {
    await Promise.all(
      this.servers.map(
        (s) =>
          new Promise<void>((r) => {
            s.closeAllConnections();
            s.close(() => r());
          }),
      ),
    );
  }

  private tokens(u: User) {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const refresh = randomUUID();
    this.refreshTokens.set(refresh, u.id);
    return { accessToken: jwt({ sub: u.id, role: u.role, exp }), refreshToken: refresh };
  }

  private authUser(req: IncomingMessage): User | null {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return null;
    try {
      const claims = JSON.parse(Buffer.from(h.slice(7).split('.')[1], 'base64url').toString());
      return this.byId.get(claims.sub) ?? null;
    } catch {
      return null;
    }
  }

  /** Offer the oldest REQUESTED trip to a free AVAILABLE driver. */
  private dispatch(): void {
    for (const trip of this.trips.values()) {
      if (trip.status !== 'REQUESTED') continue;
      if ([...this.offers.values()].some((o) => o.tripId === trip.id)) continue;
      for (const [id, d] of this.drivers) {
        if (d.status === 'AVAILABLE' && !this.offers.has(id)) {
          this.offers.set(id, { id: randomUUID(), tripId: trip.id, driverId: id });
          this.log.push(`offer:${id}`);
          break;
        }
      }
    }
  }

  private async gateway(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const body = ['POST', 'PUT'].includes(method) ? await readBody(req) : {};

    if (method === 'POST' && path === '/api/users') {
      if (this.users.has(body.email)) return send(res, 409, { message: 'exists' });
      if (body.role === 'driver' && !body.vehicle?.plate)
        return send(res, 400, { message: 'vehicle' });
      const u: User = {
        id: randomUUID(),
        email: body.email,
        password: body.password,
        role: body.role,
        vehicle: body.vehicle,
      };
      this.users.set(u.email, u);
      this.byId.set(u.id, u);
      if (u.role === 'driver') {
        this.drivers.set(u.id, {
          status: 'OFFLINE',
          pos: null,
          heading: 0,
          tripId: null,
          locations: [],
          heartbeats: 0,
        });
      }
      return send(res, 201, { id: u.id });
    }
    if (method === 'POST' && path === '/api/auth/login') {
      const u = this.users.get(body.email);
      if (!u || u.password !== body.password) return send(res, 401, { message: 'bad credentials' });
      return send(res, 200, this.tokens(u));
    }
    if (method === 'POST' && path === '/api/auth/refresh') {
      const id = this.refreshTokens.get(body.refreshToken);
      if (!id) return send(res, 401, { message: 'bad refresh' });
      this.refreshTokens.delete(body.refreshToken);
      return send(res, 200, this.tokens(this.byId.get(id) as User));
    }

    const user = this.authUser(req);
    if (!user) return send(res, 401, { message: 'unauthorized' });
    const d = this.drivers.get(user.id);

    // ---- driver ----
    if (path.startsWith('/api/drivers/me')) {
      if (!d) return send(res, 403, { message: 'not a driver' });
      if (method === 'GET' && path === '/api/drivers/me') {
        return send(res, 200, {
          driverId: user.id,
          status: d.status,
          tripId: d.tripId,
          ...(d.pos ?? {}),
          heading: d.heading,
        });
      }
      if (method === 'POST' && path === '/api/drivers/me/online') {
        d.status = d.tripId ? 'ON_TRIP' : 'AVAILABLE';
        d.pos = { lat: body.lat, lng: body.lng };
        this.log.push(`online:${user.email}`);
        this.dispatch();
        return send(res, 200, {});
      }
      if (method === 'POST' && path === '/api/drivers/me/offline') {
        if (d.tripId) return send(res, 409, { message: 'on trip' });
        d.status = 'OFFLINE';
        this.offlineCalls.push(user.email);
        return send(res, 200, {});
      }
      if (method === 'POST' && path === '/api/drivers/me/location') {
        if (d.status === 'OFFLINE') return send(res, 409, { message: 'offline' });
        d.pos = { lat: body.lat, lng: body.lng };
        d.heading = body.heading;
        const trip = d.tripId ? this.trips.get(d.tripId) : undefined;
        d.locations.push({ pos: d.pos, heading: body.heading, tripStatus: trip?.status ?? null });
        if (!trip) d.heartbeats++;
        return send(res, 204);
      }
    }

    // ---- offers ----
    if (method === 'GET' && path === '/api/offers/me') {
      const o = this.offers.get(user.id);
      if (!o) return send(res, 204);
      return send(res, 200, {
        ...o,
        status: 'PENDING',
        etaS: 30,
        attempt: 1,
        expiresSim: 0,
        pickup: this.trips.get(o.tripId)?.pickup,
        dropoff: this.trips.get(o.tripId)?.dropoff,
      });
    }
    let m = /^\/api\/offers\/([^/]+)\/(accept|decline)$/.exec(path);
    if (method === 'POST' && m) {
      const o = this.offers.get(user.id);
      if (!o || o.id !== m[1]) return send(res, 410, { message: 'gone' });
      this.offers.delete(user.id);
      if (m[2] === 'decline') {
        this.log.push(`decline:${user.email}`);
        return send(res, 204);
      }
      const trip = this.trips.get(o.tripId);
      if (!trip || trip.status !== 'REQUESTED' || !d?.pos)
        return send(res, 409, { message: 'gone' });
      trip.status = 'MATCHED';
      trip.driverId = user.id;
      trip.pickupRoute = line(d.pos, trip.pickup, 12);
      trip.events.push({ toStatus: 'MATCHED' });
      d.status = 'ON_TRIP';
      d.tripId = trip.id;
      this.log.push(`accept:${user.email}`);
      return send(res, 200, { tripId: trip.id });
    }

    // ---- trips ----
    m = /^\/api\/trips\/([^/]+)(?:\/(arrive|start|complete))?$/.exec(path);
    if (m) {
      const trip = this.trips.get(m[1]);
      if (!trip) return send(res, 404, { message: 'no trip' });
      if (method === 'GET' && !m[2]) return send(res, 200, trip);
      if (method === 'POST' && m[2]) {
        if (trip.driverId !== user.id) return send(res, 403, { message: 'not yours' });
        const next = { arrive: 'ARRIVED', start: 'IN_PROGRESS', complete: 'COMPLETED' }[
          m[2]
        ] as FakeTrip['status'];
        const from = { arrive: 'MATCHED', start: 'ARRIVED', complete: 'IN_PROGRESS' }[m[2]];
        if (trip.status !== from) return send(res, 409, { message: 'invalid transition' });
        trip.status = next;
        trip.events.push({ toStatus: next });
        this.log.push(`${m[2]}:${user.email}`);
        if (next === 'COMPLETED' && d) {
          d.status = 'AVAILABLE';
          d.tripId = null;
          this.dispatch();
        }
        return send(res, 200, trip);
      }
    }

    // ---- rider ----
    if (method === 'POST' && path === '/api/riders/me/location') {
      this.riderPos.set(user.id, { lat: body.lat, lng: body.lng });
      return send(res, 204);
    }
    if (method === 'POST' && path === '/api/riders/me/rides') {
      this.rideRequests.push({ email: user.email, body });
      const active = [...this.trips.values()].some(
        (t) => t.riderId === user.id && !['COMPLETED', 'NO_DRIVERS'].includes(t.status),
      );
      if (active) return send(res, 409, { message: 'active trip' });
      const raw: Pt | undefined = body.pickup ?? this.riderPos.get(user.id);
      if (!raw) return send(res, 422, { message: 'no pickup' });
      if (body.dropoff.lat > this.unroutableAboveLat)
        return send(res, 422, { message: 'not routable' });
      // trip snaps both points to the road: they differ slightly from what was sent
      const pickup = { lat: raw.lat + 0.00001, lng: raw.lng };
      const dropoff = { lat: body.dropoff.lat + 0.00001, lng: body.dropoff.lng };
      const trip: FakeTrip = {
        id: randomUUID(),
        riderId: user.id,
        driverId: null,
        status: 'REQUESTED',
        pickup,
        dropoff,
        pickupRoute: null,
        tripRoute: line(pickup, dropoff, 12),
        events: [{ toStatus: 'REQUESTED' }],
      };
      this.trips.set(trip.id, trip);
      this.dispatch();
      return send(res, 201, { tripId: trip.id });
    }
    return send(res, 404, { message: `no route ${method} ${path}` });
  }

  /** Test helper: pre-create an active trip for a rider (simulates leftovers from an earlier run). */
  seedActiveTrip(email: string): void {
    const u = this.users.get(email);
    if (!u) throw new Error('unknown user');
    const trip: FakeTrip = {
      id: randomUUID(),
      riderId: u.id,
      driverId: null,
      status: 'IN_PROGRESS',
      pickup: { lat: 47.6, lng: -122.33 },
      dropoff: { lat: 47.61, lng: -122.33 },
      pickupRoute: null,
      tripRoute: line({ lat: 47.6, lng: -122.33 }, { lat: 47.61, lng: -122.33 }, 4),
      events: [],
    };
    this.trips.set(trip.id, trip);
  }
}
