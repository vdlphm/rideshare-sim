import { Test } from '@nestjs/testing';
import { MockAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  HttpClient,
  HttpClientModule,
  getRequestContext,
  getAuthorization,
  UpstreamError,
  createHttpClient,
  requestContext,
  type HttpClientOptions,
} from '../src';

const BASE = 'http://upstream.test';
let agent: MockAgent;
const sleep = vi.fn(async () => undefined);

function client(extra: Partial<HttpClientOptions> = {}): HttpClient {
  return createHttpClient({
    baseUrl: BASE,
    service: 'upstream',
    dispatcher: agent,
    sleep,
    random: () => 0.5,
    ...extra,
  });
}

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  sleep.mockClear();
});
afterEach(async () => {
  await agent.close();
});

const pool = () => agent.get(BASE);
const json = { 'content-type': 'application/json' };

describe('HttpClient', () => {
  it('forwards the correlation id from context', async () => {
    let seen: unknown;
    pool()
      .intercept({ path: '/x', method: 'GET' })
      .reply(
        200,
        (o) => {
          seen = (o.headers as Record<string, string>)['x-correlation-id'];
          return { ok: true };
        },
        { headers: json },
      );
    const res = await requestContext.run({ correlationId: 'cid-1' }, () => client().get('/x'));
    expect(res).toEqual({ ok: true });
    expect(seen).toBe('cid-1');
  });

  it('generates a correlation id outside a request', async () => {
    let seen = '';
    pool()
      .intercept({ path: '/x', method: 'GET' })
      .reply(
        200,
        (o) => {
          seen = (o.headers as Record<string, string>)['x-correlation-id'];
          return {};
        },
        { headers: json },
      );
    await client().get('/x');
    expect(seen).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("auth 'forward' sends the context authorization header", async () => {
    let seen: unknown;
    pool()
      .intercept({ path: '/x', method: 'GET' })
      .reply(
        200,
        (o) => {
          seen = (o.headers as Record<string, string>).authorization;
          return {};
        },
        { headers: json },
      );
    await requestContext.run({ correlationId: 'c', authorization: 'Bearer user' }, () =>
      client().get('/x', { auth: 'forward' }),
    );
    expect(seen).toBe('Bearer user');
  });

  it("auth 'service' uses the TokenProvider; 'none' sends nothing", async () => {
    const seen: unknown[] = [];
    const cb = (o: { headers?: unknown }) => {
      seen.push((o.headers as Record<string, string>).authorization);
      return {};
    };
    pool().intercept({ path: '/a', method: 'GET' }).reply(200, cb, { headers: json });
    pool().intercept({ path: '/b', method: 'GET' }).reply(200, cb, { headers: json });
    const c = client({ tokenProvider: { getToken: async () => 'svc' } });
    await requestContext.run({ correlationId: 'c', authorization: 'Bearer user' }, async () => {
      await c.get('/a', { auth: 'service' });
      await c.get('/b', { auth: 'none' });
    });
    expect(seen).toEqual(['Bearer svc', undefined]);
  });

  it("auth 'service' without a provider fails", async () => {
    await expect(client().get('/a', { auth: 'service' })).rejects.toThrow(/tokenProvider/);
  });

  it('sends JSON bodies and query strings', async () => {
    let body = '';
    pool()
      .intercept({ path: '/p?a=1&c=true', method: 'POST' })
      .reply(
        201,
        (o) => {
          body = String(o.body);
          return { id: 1 };
        },
        { headers: json },
      );
    const res = await client().post('/p', {
      body: { n: 1 },
      query: { a: 1, b: undefined, c: true },
    });
    expect(res).toEqual({ id: 1 });
    expect(JSON.parse(body)).toEqual({ n: 1 });
  });

  it('handles 204 empty responses and plain-text errors', async () => {
    pool().intercept({ path: '/e', method: 'DELETE' }).reply(204, '');
    expect(await client().delete('/e')).toBeUndefined();
    pool().intercept({ path: '/t', method: 'GET' }).reply(400, 'nope');
    await expect(client().get('/t')).rejects.toMatchObject({ status: 400, body: 'nope' });
  });

  it('supports put and patch', async () => {
    pool().intercept({ path: '/r', method: 'PUT' }).reply(200, { m: 'put' }, { headers: json });
    pool().intercept({ path: '/r', method: 'PATCH' }).reply(200, { m: 'patch' }, { headers: json });
    expect(await client().put('r')).toEqual({ m: 'put' });
    expect(await client().patch('/r')).toEqual({ m: 'patch' });
  });

  it('retries GET on 503 then succeeds, with backoff', async () => {
    pool()
      .intercept({ path: '/r', method: 'GET' })
      .reply(503, { e: 1 }, { headers: json })
      .times(2);
    pool().intercept({ path: '/r', method: 'GET' }).reply(200, { ok: 1 }, { headers: json });
    expect(await client().get('/r')).toEqual({ ok: 1 });
    expect(sleep.mock.calls.map((c) => (c as unknown as number[])[0])).toEqual([75, 150]);
  });

  it('does not retry non-transport errors', async () => {
    pool().intercept({ path: '/r', method: 'GET' }).replyWithError(new Error('boom'));
    await expect(client().get('/r')).rejects.toThrow('boom');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries GET on a network error then succeeds', async () => {
    const err = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    pool().intercept({ path: '/r', method: 'GET' }).replyWithError(err);
    pool().intercept({ path: '/r', method: 'GET' }).reply(200, { ok: 1 }, { headers: json });
    expect(await client().get('/r')).toEqual({ ok: 1 });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('gives up after 3 attempts with UpstreamError', async () => {
    pool()
      .intercept({ path: '/r', method: 'GET' })
      .reply(503, { e: 1 }, { headers: json })
      .times(3);
    const err = await client()
      .get('/r')
      .catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err).toMatchObject({
      service: 'upstream',
      method: 'GET',
      path: '/r',
      status: 503,
      body: { e: 1 },
    });
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry 404 or 400', async () => {
    pool().intercept({ path: '/a', method: 'GET' }).reply(404, {});
    pool().intercept({ path: '/b', method: 'GET' }).reply(400, {});
    await expect(client().get('/a')).rejects.toMatchObject({ status: 404 });
    await expect(client().get('/b')).rejects.toMatchObject({ status: 400 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry POST unless idempotent: true', async () => {
    pool().intercept({ path: '/p', method: 'POST' }).reply(503, {});
    await expect(client().post('/p')).rejects.toMatchObject({ status: 503 });
    expect(sleep).not.toHaveBeenCalled();

    pool().intercept({ path: '/p', method: 'POST' }).reply(503, {});
    pool().intercept({ path: '/p', method: 'POST' }).reply(200, { ok: 1 }, { headers: json });
    expect(await client().post('/p', { idempotent: true })).toEqual({ ok: 1 });
  });

  it('times out per the timeout option and retries then fails', async () => {
    pool().intercept({ path: '/slow', method: 'GET' }).reply(200, {}).delay(200).times(2);
    const err = await client({ maxAttempts: 2 })
      .get('/slow', { timeoutMs: 20 })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(['TimeoutError', 'AbortError']).toContain((err as Error).name);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('validates the response with a zod schema', async () => {
    pool()
      .intercept({ path: '/s', method: 'GET' })
      .reply(200, { id: 'x' }, { headers: json })
      .times(2);
    const schema = z.object({ id: z.string() });
    expect(await client().get('/s', { schema })).toEqual({ id: 'x' });
    await expect(client().get('/s', { schema: z.object({ id: z.number() }) })).rejects.toThrow(
      z.ZodError,
    );
    expect(sleep).not.toHaveBeenCalled();
  });

  it('is registrable as a Nest provider', async () => {
    const ref = await Test.createTestingModule({
      imports: [HttpClientModule.register({ baseUrl: BASE, dispatcher: agent })],
    }).compile();
    expect(ref.get(HttpClient)).toBeInstanceOf(HttpClient);
  });

  it('exposes request context helpers', () => {
    expect(getRequestContext()).toBeUndefined();
    requestContext.run({ correlationId: 'c', authorization: 'a' }, () => {
      expect(getRequestContext()?.correlationId).toBe('c');
      expect(getAuthorization()).toBe('a');
    });
  });
});
