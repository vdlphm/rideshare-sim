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

const latLng = (s: string) => {
  const [lat, lng] = s.split(',').map(Number);
  return { lat: lat!, lng: lng! };
};

/** Fake user (token), simulator (clock), routing, driver and matching services. */
export class FakeWorld {
  simTime = 1_000_000;
  /** Number of upcoming driver status calls that fail with 500. */
  driverFailures = 0;
  matchingDown = false;

  readonly user = new FakeServer(() => ({
    status: 200,
    body: { accessToken: 'service-token', expiresIn: 3600 },
  }));
  readonly simulator = new FakeServer(() => ({
    status: 200,
    body: { simTime: this.simTime, speed: 0, paused: true },
  }));
  readonly routing = new FakeServer((_req, url) => {
    if (url.pathname === '/internal/nearest') {
      const lat = Number(url.searchParams.get('lat'));
      if (lat > 80) return { status: 422, body: { message: 'point is too far from a road' } };
      return { status: 200, body: { lat, lng: Number(url.searchParams.get('lng')), distanceM: 5 } };
    }
    const from = latLng(url.searchParams.get('from')!);
    const to = latLng(url.searchParams.get('to')!);
    return {
      status: 200,
      body: {
        distanceM: 1500,
        durationS: 200,
        geometry: [
          [from.lng, from.lat],
          [(from.lng + to.lng) / 2, (from.lat + to.lat) / 2],
          [to.lng, to.lat],
        ],
        durations: [90, 110],
      },
    };
  });
  readonly driver = new FakeServer(() => {
    if (this.driverFailures > 0) {
      this.driverFailures--;
      return { status: 500 };
    }
    return { status: 200, body: {} };
  });
  readonly matching = new FakeServer(() =>
    this.matchingDown ? { status: 503 } : { status: 202, body: {} },
  );

  async start(): Promise<void> {
    await Promise.all(
      [this.user, this.simulator, this.routing, this.driver, this.matching].map((s) => s.start()),
    );
  }

  async stop(): Promise<void> {
    await Promise.all(
      [this.user, this.simulator, this.routing, this.driver, this.matching].map((s) => s.stop()),
    );
  }

  env(): Record<string, string> {
    return {
      USER_SERVICE_URL: this.user.url,
      SIMULATOR_URL: this.simulator.url,
      ROUTING_URL: this.routing.url,
      DRIVER_URL: this.driver.url,
      MATCHING_URL: this.matching.url,
      TRIP_CLIENT_SECRET: 'test-secret',
    };
  }

  /** Calls to the driver status endpoint, as `[driverId, status, tripId]`. */
  driverStatusCalls(): [string, string, string | null][] {
    return this.driver.calls.map((c) => {
      const b = c.body as { status: string; tripId: string | null };
      return [c.path.split('/')[3]!, b.status, b.tripId];
    });
  }
}

/** Unsigned JWT: services only decode (the gateway verifies). */
export function token(sub: string, role: 'rider' | 'driver' | 'admin' | 'service'): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ sub, role, exp: 4_000_000_000 })}.sig`;
}
