import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

export interface Reply {
  status: number;
  body?: unknown;
}

type Handler = (req: Recorded, url: URL) => Reply;

class FakeServer {
  readonly calls: Recorded[] = [];
  private server!: Server;
  url = '';

  constructor(private readonly handler: Handler) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let text = '';
    for await (const chunk of req) text += String(chunk);
    const url = new URL(req.url ?? '/', 'http://x');
    const rec: Recorded = {
      method: req.method ?? '',
      path: url.pathname + url.search,
      body: text ? JSON.parse(text) : undefined,
    };
    this.calls.push(rec);
    const r = this.handler(rec, url);
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.body ?? {}));
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }
}

export interface FakeDriver {
  driverId: string;
  lat: number;
  lng: number;
  /** Drive time to the pickup, null = not routable. */
  etaS: number | null;
}

/** Metres per degree of latitude (close enough for fixtures). */
const M_PER_DEG = 111_000;

/** Fake user (token), simulator (clock), driver, routing and trip services. */
export class FakeWorld {
  simTime = 1_000_000;
  /** Drivers the driver service reports as AVAILABLE. */
  drivers: FakeDriver[] = [];
  /** Reply of trip `assign`; default 200. */
  assignReply: (body: { driverId: string }) => Reply = () => ({ status: 200, body: {} });
  noDriversReply: Reply = { status: 200, body: {} };

  readonly user = new FakeServer(() => ({
    status: 200,
    body: { accessToken: 'service-token', expiresIn: 3600 },
  }));
  readonly simulator = new FakeServer(() => ({
    status: 200,
    body: { simTime: this.simTime, speed: 0, paused: true },
  }));
  readonly driver = new FakeServer((_req, url) => {
    const lat = Number(url.searchParams.get('lat'));
    const radiusM = Number(url.searchParams.get('radiusM'));
    const limit = Number(url.searchParams.get('limit'));
    const found = this.drivers
      .map((d) => ({
        driverId: d.driverId,
        lat: d.lat,
        lng: d.lng,
        distanceM: Math.abs(d.lat - lat) * M_PER_DEG,
      }))
      .filter((d) => d.distanceM <= radiusM)
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, limit);
    return { status: 200, body: found };
  });
  readonly routing = new FakeServer((req) => {
    const { sources } = req.body as { sources: { lat: number; lng: number }[] };
    const durations = sources.map((s) => {
      const d = this.drivers.find((x) => x.lat === s.lat && x.lng === s.lng);
      return [d?.etaS ?? null];
    });
    return { status: 200, body: { durations } };
  });
  readonly trip = new FakeServer((req) => {
    if (req.path.endsWith('/no-drivers')) return this.noDriversReply;
    return this.assignReply(req.body as { driverId: string });
  });

  private all = () => [this.user, this.simulator, this.driver, this.routing, this.trip];

  async start(): Promise<void> {
    await Promise.all(this.all().map((s) => s.start()));
  }

  async stop(): Promise<void> {
    await Promise.all(this.all().map((s) => s.stop()));
  }

  reset(): void {
    this.drivers = [];
    this.assignReply = () => ({ status: 200, body: {} });
    this.noDriversReply = { status: 200, body: {} };
    for (const s of this.all()) s.calls.length = 0;
  }

  env(): Record<string, string> {
    return {
      USER_SERVICE_URL: this.user.url,
      SIMULATOR_URL: this.simulator.url,
      DRIVER_URL: this.driver.url,
      ROUTING_URL: this.routing.url,
      TRIP_URL: this.trip.url,
      MATCHING_CLIENT_SECRET: 'test-secret',
    };
  }

  assignCalls() {
    return this.trip.calls.filter((c) => c.path.endsWith('/assign'));
  }
  noDriversCalls() {
    return this.trip.calls.filter((c) => c.path.endsWith('/no-drivers'));
  }
}

/** Unsigned JWT: services only decode (the gateway verifies). */
export function token(sub: string, role: 'rider' | 'driver' | 'admin' | 'service'): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ sub, role, exp: 4_000_000_000 })}.sig`;
}
