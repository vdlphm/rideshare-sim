import {
  BadGatewayException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHttpClient, requestContext } from '@rideshare/common';
import { MockAgent } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';
import type { RiderPositionsService } from '../src/positions.service';
import { RideRequestsService } from '../src/rides.service';

const TRIP_ID = '11111111-1111-4111-8111-111111111111';
const AUTH = 'Bearer rider.token.here';
const dropoff = { lat: 47.62, lng: -122.35 };
const stored = { lat: 47.6, lng: -122.3 };

interface Seen {
  headers: Record<string, string>;
  body: Record<string, unknown>;
  path: string;
}

let agent: MockAgent;
afterEach(() => agent.close());

function setup(reply: { status: number; body?: unknown } | 'error', position: unknown = null) {
  agent = new MockAgent();
  agent.disableNetConnect();
  const seen: Seen[] = [];
  const pool = agent.get('http://trip.test').intercept({ path: () => true, method: () => true });
  if (reply === 'error') pool.replyWithError(new Error('boom')).persist();
  else
    pool
      .reply((o) => {
        seen.push({
          headers: o.headers as Record<string, string>,
          body: JSON.parse(String(o.body)),
          path: String(o.path),
        });
        return {
          statusCode: reply.status,
          data: JSON.stringify(reply.body ?? {}),
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      })
      .persist();
  const http = createHttpClient({
    baseUrl: 'http://trip.test',
    service: 'trip',
    auth: 'forward',
    maxAttempts: 1,
    dispatcher: agent,
  });
  const positions = { get: async () => position } as unknown as RiderPositionsService;
  const service = new RideRequestsService(positions, http);
  const run = <T>(fn: () => Promise<T>) =>
    requestContext.run({ correlationId: 'c1', authorization: AUTH }, fn);
  return { seen, service, run };
}

describe('RideRequestsService', () => {
  it('forwards an explicit pickup, the incoming Authorization and no riderId', async () => {
    const { seen, service, run } = setup(
      { status: 201, body: { tripId: TRIP_ID } },
      {
        riderId: 'r',
        ...stored,
        ts: 1,
      },
    );
    const pickup = { lat: 1, lng: 2 };
    const res = await run(() => service.request('r', { pickup, dropoff }));
    expect(res).toEqual({ tripId: TRIP_ID });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe('/internal/trips');
    expect(seen[0]!.body).toEqual({ pickup, dropoff });
    expect(seen[0]!.headers.authorization).toBe(AUTH);
  });

  it('falls back to the stored position', async () => {
    const { seen, service, run } = setup(
      { status: 201, body: { tripId: TRIP_ID } },
      {
        riderId: 'r',
        ...stored,
        ts: 5,
      },
    );
    await run(() => service.request('r', { dropoff }));
    expect(seen[0]!.body).toEqual({ pickup: stored, dropoff });
    expect(seen[0]!.body).not.toHaveProperty('riderId');
  });

  it('422 and no trip call when there is neither pickup nor position', async () => {
    const { seen, service, run } = setup({ status: 201, body: { tripId: TRIP_ID } });
    await expect(run(() => service.request('r', { dropoff }))).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(seen).toHaveLength(0);
  });

  it('passes trip 409 through', async () => {
    const { service, run } = setup(
      {
        status: 409,
        body: { message: 'rider already has an active trip' },
      },
      stored,
    );
    const err = await run(() => service.request('r', { dropoff })).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe('rider already has an active trip');
  });

  it('passes trip 422 and 400 through', async () => {
    let s = setup({ status: 422, body: { message: 'pickup not routable' } }, stored);
    let err = await s.run(() => s.service.request('r', { dropoff })).catch((e) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect(err.message).toBe('pickup not routable');
    await agent.close();
    s = setup({ status: 400, body: { message: 'bad body' } }, stored);
    err = await s.run(() => s.service.request('r', { dropoff })).catch((e) => e);
    expect(err.getStatus()).toBe(400);
    expect(err.message).toBe('bad body');
  });

  it('maps 5xx and network failure to a generic 502', async () => {
    let s = setup({ status: 503, body: { message: 'secret internals' } }, stored);
    let err = await s.run(() => s.service.request('r', { dropoff })).catch((e) => e);
    expect(err).toBeInstanceOf(BadGatewayException);
    expect(err.message).toBe('trip service unavailable');
    expect(s.seen).toHaveLength(1); // no retries
    await agent.close();
    s = setup('error', stored);
    err = await s.run(() => s.service.request('r', { dropoff })).catch((e) => e);
    expect(err).toBeInstanceOf(BadGatewayException);
  });
});
