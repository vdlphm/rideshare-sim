import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { b64, makeSigner, startGateway, type Env, type Signer } from './harness';

let env: Env;
let signer: Signer;
let other: Signer;
const UUID = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

const token = (role: string, sub = 'user-1') => signer.sign({ sub, role });
const seenAnywhere = () => Object.values(env.fakes).flatMap((f) => f.seen.filter(isProxied));
const isProxied = (s: { url: string }) => s.url !== '/.well-known/jwks.json';
const bearer = (t: string) => `Bearer ${t}`;

beforeAll(async () => {
  signer = await makeSigner('key-1');
  other = await makeSigner('key-other');
  env = await startGateway({}, [signer.jwk]);
});
afterAll(() => env.close());
beforeEach(() => {
  for (const f of Object.values(env.fakes)) f.seen.length = 0;
  env.jwks.keys = [signer.jwk];
});

describe('proxying', () => {
  it('proxies a valid token with original Authorization, rewritten path, query and correlation id', async () => {
    const t = await token('admin');
    const cid = '8f14e45f-ceea-467a-9575-1c6e1f3f5a11';
    const res = await request(env.base)
      .get('/api/trips?status=active&x=a%20b')
      .set('Authorization', bearer(t))
      .set('x-correlation-id', cid);
    expect(res.status).toBe(200);
    expect(res.headers['x-upstream']).toBe('trip');
    expect(res.headers['x-correlation-id']).toBe(cid);
    expect(res.body.url).toBe('/trips?status=active&x=a%20b');
    expect(res.body.headers.authorization).toBe(bearer(t));
    expect(res.body.headers['x-correlation-id']).toBe(cid);
  });

  it('generates a correlation id when the client sends none', async () => {
    const res = await request(env.base)
      .get('/api/users/me')
      .set('Authorization', bearer(await token('rider')));
    expect(res.body.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['x-correlation-id']).toBe(res.body.headers['x-correlation-id']);
  });

  it('delivers a POST JSON body intact (no body parser in the way)', async () => {
    const payload = { pickup: { lat: 1.5, lng: -2.25 }, dropoff: { lat: 3, lng: 4 }, n: 'é✓' };
    const res = await request(env.base)
      .post('/api/riders/me/rides')
      .set('Authorization', bearer(await token('rider')))
      .send(payload);
    expect(res.status).toBe(200);
    expect(res.body.method).toBe('POST');
    expect(res.body.url).toBe('/riders/me/rides');
    expect(JSON.parse(res.body.body)).toEqual(payload);
    expect(res.body.headers['content-type']).toContain('application/json');
  });

  it('delivers large bodies intact', async () => {
    const big = 'x'.repeat(500_000);
    const res = await request(env.base)
      .put('/api/sim/config')
      .set('Authorization', bearer(await token('admin')))
      .send({ big });
    expect(JSON.parse(res.body.body).big).toHaveLength(500_000);
  });

  it('routes each service to its own upstream and maps routing paths', async () => {
    const admin = bearer(await token('admin'));
    const driver = bearer(await token('driver'));
    const rider = bearer(await token('rider'));
    const get = (p: string, a: string) => request(env.base).get(p).set('Authorization', a);
    const r1 = await get('/api/routing/route?from=1,2&to=3,4', admin);
    expect([r1.headers['x-upstream'], r1.body.url]).toEqual(['routing', '/route?from=1,2&to=3,4']);
    const r2 = await get('/api/routing/nearest?lat=1&lng=2', admin);
    expect([r2.headers['x-upstream'], r2.body.url]).toEqual(['routing', '/nearest?lat=1&lng=2']);
    expect((await get('/api/sim/config', admin)).headers['x-upstream']).toBe('simulator');
    expect((await get('/api/drivers/me', driver)).headers['x-upstream']).toBe('driver');
    expect((await get('/api/riders/me/location', rider)).headers['x-upstream']).toBe('rider');
    expect((await get('/api/offers/me', driver)).headers['x-upstream']).toBe('matching');
    expect((await get(`/api/users/${UUID}`, admin)).body.url).toBe(`/users/${UUID}`);
    expect((await get(`/api/trips/${UUID}`, rider)).headers['x-upstream']).toBe('trip');
  });

  it('strips spoofed x-forwarded-* headers and sets its own', async () => {
    const res = await request(env.base)
      .get('/api/users/me')
      .set('Authorization', bearer(await token('rider')))
      .set('x-forwarded-for', '6.6.6.6')
      .set('x-forwarded-host', 'evil.example')
      .set('x-real-ip', '6.6.6.6');
    expect(res.body.headers['x-forwarded-for']).not.toContain('6.6.6.6');
    expect(res.body.headers['x-forwarded-host']).not.toBe('evil.example');
    expect(res.body.headers['x-real-ip']).toBeUndefined();
  });

  it('does not follow upstream redirects', async () => {
    env.fakes.trip!.handler = (_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', `${env.fakes.user!.url}/elsewhere`);
      res.end();
      return true;
    };
    try {
      const res = await request(env.base)
        .get('/api/trips')
        .set('Authorization', bearer(await token('admin')))
        .redirects(0);
      expect(res.status).toBe(302);
      expect(env.fakes.user!.seen.filter(isProxied)).toHaveLength(0);
    } finally {
      env.fakes.trip!.handler = undefined;
    }
  });
});

describe('authentication (401, never proxied)', () => {
  const hit = (auth?: string) => {
    const r = request(env.base).get('/api/users/me');
    return auth === undefined ? r : r.set('Authorization', auth);
  };

  it.each([
    ['no header', undefined],
    ['not bearer', 'Basic abc'],
    ['empty bearer', 'Bearer '],
    ['garbage', 'Bearer not-a-jwt'],
    ['lowercase scheme', 'bearer a.b.c'],
  ])('%s', async (_n, auth) => {
    const res = await hit(auth);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ statusCode: 401, error: 'Unauthorized' });
    expect(res.body.correlationId).toBeDefined();
    expect(seenAnywhere()).toHaveLength(0);
  });

  it('expired token', async () => {
    const t = await signer.sign(
      { sub: 'u', role: 'rider' },
      { exp: Math.floor(Date.now() / 1000) - 60 },
    );
    expect((await hit(bearer(t))).status).toBe(401);
    expect(seenAnywhere()).toHaveLength(0);
  });

  it('token without exp', async () => {
    const { SignJWT } = await import('jose');
    const t = await new SignJWT({ sub: 'u', role: 'rider' })
      .setProtectedHeader({ alg: 'RS256', kid: signer.kid, typ: 'JWT' })
      .setIssuer('rideshare-user-service')
      .setIssuedAt()
      .sign(signer.privateKey);
    expect((await hit(bearer(t))).status).toBe(401);
    expect(seenAnywhere()).toHaveLength(0);
  });

  it('tampered payload (bad signature)', async () => {
    const t = await token('rider');
    const [h, , s] = t.split('.');
    const forged = `${h}.${b64({ sub: 'u1', role: 'admin', iss: 'rideshare-user-service', iat: 1, exp: 9999999999 })}.${s}`;
    expect((await hit(bearer(forged))).status).toBe(401);
    expect(seenAnywhere()).toHaveLength(0);
  });

  it('known kid but signed by a different key', async () => {
    const t = await other.sign({ sub: 'u', role: 'admin' }, { kid: signer.kid });
    expect((await hit(bearer(t))).status).toBe(401);
    expect(seenAnywhere()).toHaveLength(0);
  });

  it('unknown kid (signed by a key the user service never published)', async () => {
    const t = await other.sign({ sub: 'u', role: 'admin' });
    expect((await hit(bearer(t))).status).toBe(401);
    expect(seenAnywhere()).toHaveLength(0);
  });

  it('alg none', async () => {
    const t = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'u', role: 'admin', iss: 'rideshare-user-service', iat: 1, exp: 9999999999 })}.`;
    expect((await hit(bearer(t))).status).toBe(401);
    expect(seenAnywhere()).toHaveLength(0);
  });

  it('HS256 token using the public key material as secret', async () => {
    const { SignJWT } = await import('jose');
    const t = await new SignJWT({ sub: 'u', role: 'admin' })
      .setProtectedHeader({ alg: 'HS256', kid: signer.kid, typ: 'JWT' })
      .setIssuer('rideshare-user-service')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(JSON.stringify(signer.jwk)));
    expect((await hit(bearer(t))).status).toBe(401);
    expect(seenAnywhere()).toHaveLength(0);
  });

  it('wrong issuer', async () => {
    const t = await signer.sign({ sub: 'u', role: 'rider' }, { issuer: 'someone-else' });
    expect((await hit(bearer(t))).status).toBe(401);
    expect(seenAnywhere()).toHaveLength(0);
  });

  it.each([
    ['missing role', { sub: 'u' }],
    ['unknown role', { sub: 'u', role: 'superuser' }],
    ['non-string role', { sub: 'u', role: ['admin'] }],
    ['missing sub', { role: 'rider' }],
    ['empty sub', { sub: '', role: 'rider' }],
    ['non-string sub', { sub: 42, role: 'rider' }],
  ])('%s', async (_n, claims) => {
    const t = await signer.sign(claims);
    expect((await hit(bearer(t))).status).toBe(401);
    expect(seenAnywhere()).toHaveLength(0);
  });

  it('does not echo the token in an error body', async () => {
    const res = await hit('Bearer aaa.bbb.ccc');
    expect(JSON.stringify(res.body)).not.toContain('aaa.bbb.ccc');
  });
});

describe('authorization (403, never proxied)', () => {
  it('rider on /api/sim/config', async () => {
    const res = await request(env.base)
      .get('/api/sim/config')
      .set('Authorization', bearer(await token('rider')));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ statusCode: 403, error: 'Forbidden' });
    expect(seenAnywhere()).toHaveLength(0);
  });

  it('driver on POST /api/offers/:id/accept is proxied', async () => {
    const res = await request(env.base)
      .post(`/api/offers/${UUID}/accept`)
      .set('Authorization', bearer(await token('driver')));
    expect(res.status).toBe(200);
    expect(res.body.url).toBe(`/offers/${UUID}/accept`);
  });

  it.each([
    ['rider', 'GET', '/api/drivers/me'],
    ['driver', 'GET', '/api/riders/me/location'],
    ['rider', 'POST', `/api/offers/${UUID}/accept`],
    ['rider', 'POST', `/api/trips/${UUID}/arrive`],
    ['driver', 'GET', '/api/trips'],
    ['rider', 'GET', '/api/trips/stats'],
    ['driver', 'GET', `/api/users/${UUID}`],
    ['driver', 'GET', '/api/routing/route'],
    ['admin', 'POST', '/api/riders/me/rides'],
  ])('%s %s %s', async (role, method, path) => {
    const res = await request(env.base)
      [method.toLowerCase() as 'get' | 'post'](path)
      .set('Authorization', bearer(await token(role)));
    expect(res.status).toBe(403);
    expect(seenAnywhere()).toHaveLength(0);
  });

  it('service-role token is refused on every kind of public API route', async () => {
    const auth = bearer(await token('service', 'trip'));
    for (const [m, p] of [
      ['get', '/api/users/me'],
      ['get', '/api/sim/config'],
      ['post', '/api/trips/x/start'],
      ['post', '/api/users'],
      ['post', '/api/auth/login'],
      ['post', '/api/auth/refresh'],
    ] as const) {
      const res = await request(env.base)[m](p).set('Authorization', auth);
      expect(res.status, `${m} ${p}`).toBe(403);
    }
    expect(seenAnywhere()).toHaveLength(0);
  });
});

describe('public routes', () => {
  it.each([
    ['/api/users', '/users'],
    ['/api/auth/login', '/auth/login'],
    ['/api/auth/refresh', '/auth/refresh'],
  ])('POST %s works without a token', async (path, up) => {
    const res = await request(env.base).post(path).send({ a: 1 });
    expect(res.status).toBe(200);
    expect(res.headers['x-upstream']).toBe('user');
    expect(res.body.url).toBe(up);
    expect(JSON.parse(res.body.body)).toEqual({ a: 1 });
  });

  it('never forwards an Authorization header on a public route', async () => {
    const bad = await request(env.base)
      .post('/api/auth/refresh')
      .set('Authorization', 'Bearer forged.token.here')
      .send({});
    expect(bad.status).toBe(200);
    expect(bad.body.headers.authorization).toBeUndefined();
    const real = await request(env.base)
      .post('/api/auth/login')
      .set('Authorization', bearer(await token('admin')))
      .send({});
    expect(real.body.headers.authorization).toBeUndefined();
  });
});

describe('unexposed and internal paths (404, never proxied)', () => {
  it('POST /api/auth/token is not exposed', async () => {
    const res = await request(env.base).post('/api/auth/token').send({ clientId: 'x' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ statusCode: 404, error: 'Not Found' });
    expect(seenAnywhere()).toHaveLength(0);
  });

  it.each([
    '/api/trips/internal/x',
    '/api/internal/clock',
    '/api/%69nternal/users/batch',
    '/api/users/../internal/users/batch',
    '/api/users/%2e%2e/internal/users/batch',
    '/api/sim/%2Finternal/state',
    '/api/sim/..%2Finternal/state',
    '/api/routing/internal/table',
    '/internal/clock',
    '/api/unknown',
    '/api/.well-known/jwks.json',
  ])('%s', async (path) => {
    for (const t of [await token('admin'), await token('service')]) {
      const res = await request(env.base).get(path).set('Authorization', bearer(t));
      expect(res.status, path).toBe(404);
    }
    const anon = await request(env.base).post(path).send({});
    expect(anon.status).toBe(404);
    expect(seenAnywhere()).toHaveLength(0);
  });

  it('404s before authentication, so unknown paths leak nothing about tokens', async () => {
    expect((await request(env.base).get('/api/unknown')).status).toBe(404);
  });
});

describe('JWKS handling', () => {
  it('fetches the JWKS once and caches it across requests, then refetches for a new kid', async () => {
    const fresh = await startGateway({ JWKS_COOLDOWN_MS: '0' }, [signer.jwk]);
    try {
      const call = async (t: string) =>
        request(fresh.base).get('/api/users/me').set('Authorization', bearer(t));
      expect(fresh.jwksHits()).toBe(0);
      for (let i = 0; i < 5; i++) expect((await call(await token('rider'))).status).toBe(200);
      expect(fresh.jwksHits()).toBe(1);

      // key rotation: new key published, old one retired
      const rotated = await makeSigner('key-2');
      fresh.jwks.keys = [rotated.jwk];
      const t2 = await rotated.sign({ sub: 'u', role: 'rider' });
      expect((await call(t2)).status).toBe(200);
      expect(fresh.jwksHits()).toBe(2);
      expect((await call(t2)).status).toBe(200);
      expect(fresh.jwksHits()).toBe(2);
    } finally {
      await fresh.close();
    }
  });

  it('rate-limits refetches triggered by unknown kids (cooldown)', async () => {
    const fresh = await startGateway({ JWKS_COOLDOWN_MS: '60000' }, [signer.jwk]);
    try {
      const call = async (t: string) =>
        request(fresh.base).get('/api/users/me').set('Authorization', bearer(t));
      await call(await token('rider'));
      for (let i = 0; i < 5; i++) {
        const rogue = await makeSigner(`rogue-${i}`);
        expect((await call(await rogue.sign({ sub: 'u', role: 'admin' }))).status).toBe(401);
      }
      expect(fresh.jwksHits()).toBe(1);
    } finally {
      await fresh.close();
    }
  });

  it('fails closed with 503 (not 401, not proxied) when the JWKS endpoint is down', async () => {
    const fresh = await startGateway({}, [signer.jwk]);
    try {
      await fresh.fakes.user!.close();
      const res = await request(fresh.base)
        .get('/api/users/me')
        .set('Authorization', bearer(await token('rider')));
      expect(res.status).toBe(503);
      expect(fresh.fakes.rider!.seen).toHaveLength(0);
    } finally {
      await fresh.close();
    }
  });
});

describe('upstream failures', () => {
  it('upstream down -> 502 in the common error format', async () => {
    const down = await startGateway({}, [signer.jwk]);
    try {
      await down.fakes.trip!.close();
      const cid = '8f14e45f-ceea-467a-9575-1c6e1f3f5a11';
      const res = await request(down.base)
        .get('/api/trips')
        .set('Authorization', bearer(await token('admin')))
        .set('x-correlation-id', cid);
      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({ statusCode: 502, error: 'Bad Gateway', correlationId: cid });
    } finally {
      await down.close();
    }
  });

  it('upstream timeout -> 504', async () => {
    const slow = await startGateway({ PROXY_TIMEOUT_MS: '300' }, [signer.jwk]);
    try {
      slow.fakes.trip!.handler = () => true; // accept and never answer
      const res = await request(slow.base)
        .get('/api/trips')
        .set('Authorization', bearer(await token('admin')));
      expect(res.status).toBe(504);
      expect(res.body).toMatchObject({ statusCode: 504, error: 'Gateway Timeout' });
    } finally {
      await slow.close();
    }
  });
});

describe('health', () => {
  it('/health is public and answered by the gateway itself', async () => {
    const res = await request(env.base).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(seenAnywhere()).toHaveLength(0);
  });

  it('/ready is ok when the JWKS endpoint is reachable and 503 when it is not', async () => {
    expect((await request(env.base).get('/ready')).status).toBe(200);
    const fresh = await startGateway({}, [signer.jwk]);
    try {
      await fresh.fakes.user!.close();
      const res = await request(fresh.base).get('/ready');
      expect(res.status).toBe(503);
      expect(res.body.failed).toEqual(['jwks']);
    } finally {
      await fresh.close();
    }
  });

  it('only exact GET /health and /ready are special', async () => {
    expect((await request(env.base).post('/health').send({})).status).toBe(404);
    expect((await request(env.base).get('/health/x')).status).toBe(404);
  });
});
