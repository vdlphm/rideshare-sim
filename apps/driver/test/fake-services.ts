import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  authorization: string | undefined;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : undefined;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
}

const close = (server: Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

/** Answers POST /auth/token with a long-lived token (the driver service never verifies it). */
export class FakeUserService {
  private server = createServer((req, res) => {
    void readBody(req).then(() => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ accessToken: 'fake-service-token', expiresIn: 3600 }));
    });
  });
  url = '';
  async start(): Promise<void> {
    this.url = await listen(this.server);
  }
  stop(): Promise<void> {
    return close(this.server);
  }
}

export interface ActiveTripFake {
  id: string;
  driverId: string;
}

/** Fake trip service: records calls, answers are controllable per test. */
export class FakeTripService {
  calls: RecordedCall[] = [];
  /** Status per tripId for unassign; default 409. */
  unassignStatus = new Map<string, number>();
  defaultUnassignStatus = 409;
  /** Runs while an unassign request is in flight (before the response). */
  onUnassign?: (tripId: string) => Promise<void>;
  active: ActiveTripFake[] = [];
  /** When set, GET /internal/trips/active answers this status instead. */
  activeStatus: number | undefined;

  private server = createServer((req, res) => {
    void (async () => {
      const u = new URL(req.url ?? '/', 'http://x');
      const body = await readBody(req);
      this.calls.push({
        method: req.method ?? '',
        path: u.pathname,
        query: u.searchParams,
        body,
        authorization: req.headers.authorization,
      });
      const send = (status: number, json: unknown) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(json));
      };
      const m = /^\/internal\/trips\/([^/]+)\/unassign$/.exec(u.pathname);
      if (req.method === 'POST' && m) {
        const tripId = m[1]!;
        await this.onUnassign?.(tripId);
        const status = this.unassignStatus.get(tripId) ?? this.defaultUnassignStatus;
        return send(
          status,
          status === 200 ? { id: tripId, status: 'REQUESTED' } : { message: 'no' },
        );
      }
      if (req.method === 'GET' && u.pathname === '/internal/trips/active') {
        if (this.activeStatus) return send(this.activeStatus, { message: 'down' });
        const ids = new Set((u.searchParams.get('driverIds') ?? '').split(','));
        return send(
          200,
          this.active.filter((t) => ids.has(t.driverId)).map((t) => ({ ...t, status: 'MATCHED' })),
        );
      }
      send(404, {});
    })();
  });
  url = '';
  async start(): Promise<void> {
    this.url = await listen(this.server);
  }
  stop(): Promise<void> {
    return close(this.server);
  }
  reset(): void {
    this.calls = [];
    this.unassignStatus.clear();
    this.defaultUnassignStatus = 409;
    this.onUnassign = undefined;
    this.active = [];
    this.activeStatus = undefined;
  }
  unassigns(): RecordedCall[] {
    return this.calls.filter((c) => c.path.endsWith('/unassign'));
  }
}
