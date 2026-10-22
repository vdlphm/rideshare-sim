import { describe, expect, it } from 'vitest';
import { isAllowed, normalizePath, resolveRoute, ROUTES } from '../src/routes';

const r = (method: string, path: string) => resolveRoute(method, path);

describe('route table', () => {
  const cases: [string, string, string, string, string][] = [
    // method, path, service, upstream path, access
    ['POST', '/api/users', 'user', '/users', 'public'],
    ['POST', '/api/auth/login', 'user', '/auth/login', 'public'],
    ['POST', '/api/auth/refresh', 'user', '/auth/refresh', 'public'],
    ['GET', '/api/users/me', 'user', '/users/me', 'rider,driver,admin'],
    ['PATCH', '/api/users/me', 'user', '/users/me', 'rider,driver,admin'],
    ['GET', '/api/users/abc-123', 'user', '/users/abc-123', 'admin'],
    ['POST', '/api/riders/me/rides', 'rider', '/riders/me/rides', 'rider'],
    ['GET', '/api/riders/me/location', 'rider', '/riders/me/location', 'rider'],
    ['POST', '/api/drivers/me/online', 'driver', '/drivers/me/online', 'driver'],
    ['GET', '/api/offers/me', 'matching', '/offers/me', 'driver'],
    ['POST', '/api/offers/o1/accept', 'matching', '/offers/o1/accept', 'driver'],
    ['GET', '/api/trips', 'trip', '/trips', 'admin'],
    ['GET', '/api/trips/stats', 'trip', '/trips/stats', 'admin'],
    ['GET', '/api/trips/t1', 'trip', '/trips/t1', 'rider,driver,admin'],
    ['POST', '/api/trips/t1/arrive', 'trip', '/trips/t1/arrive', 'driver'],
    ['POST', '/api/trips/t1/start', 'trip', '/trips/t1/start', 'driver'],
    ['POST', '/api/trips/t1/complete', 'trip', '/trips/t1/complete', 'driver'],
    ['GET', '/api/routing/route', 'routing', '/route', 'admin'],
    ['GET', '/api/routing/nearest', 'routing', '/nearest', 'admin'],
    ['GET', '/api/sim/config', 'simulator', '/sim/config', 'admin'],
    ['PUT', '/api/sim/config', 'simulator', '/sim/config', 'admin'],
    ['POST', '/api/sim/riders', 'simulator', '/sim/riders', 'admin'],
  ];

  it.each(cases)('%s %s', (method, path, service, upstream, access) => {
    const res = r(method, path)!;
    expect(res).not.toBeNull();
    expect(res.service).toBe(service);
    expect(res.upstreamPath).toBe(upstream);
    expect(res.access === 'public' ? 'public' : res.access.join(',')).toBe(access);
  });

  it.each([
    ['POST', '/api/auth/token'],
    ['GET', '/api/auth/login'],
    ['GET', '/api/users'],
    ['DELETE', '/api/users/me'],
    ['POST', '/api/users/me'],
    ['POST', '/api/trips'],
    ['POST', '/api/trips/stats'],
    ['GET', '/api/trips/t1/arrive'],
    ['GET', '/api/trips/t1/extra/more'],
    ['GET', '/api/unknown'],
    ['GET', '/api'],
    ['GET', '/'],
    ['GET', '/users/me'],
    ['GET', '/api/.well-known/jwks.json'],
    ['GET', '/api/riders-evil/x'],
  ])('%s %s is not routable', (method, path) => {
    expect(r(method, path)).toBeNull();
  });

  it('first match wins: /users/me is not treated as /users/:id', () => {
    expect(r('GET', '/api/users/me')!.rule.access).toEqual(['rider', 'driver', 'admin']);
  });

  it('matches /** with zero extra segments and tolerates one trailing slash', () => {
    expect(r('GET', '/api/riders')!.upstreamPath).toBe('/riders');
    expect(r('GET', '/api/trips/')!.upstreamPath).toBe('/trips');
    expect(r('GET', '/api/trips//')).toBeNull();
  });

  it('every non-public rule has at least one role and none grants service', () => {
    for (const rule of ROUTES) {
      if (rule.access !== 'public') {
        expect(rule.access.length).toBeGreaterThan(0);
        expect(rule.access as readonly string[]).not.toContain('service');
      }
    }
  });
});

describe('/internal/ and path tricks', () => {
  it.each([
    '/api/trips/internal/x',
    '/api/internal/trips',
    '/api/%69nternal/users/batch',
    '/api/%49NTERNAL/users',
    '/api/Internal/x',
    '/api/users/../internal/users/batch',
    '/api/users/%2e%2e/internal/users/batch',
    '/api/users/%2E%2E/me',
    '/api/users/./me',
    '/api/sim/%2Finternal/state',
    '/api/sim/..%2Finternal/state',
    '/api/sim/%5cinternal',
    '/api/sim/a%5Cb',
    '/api/sim/%252e%252e/x',
    '/api/sim/%00',
    '/api/sim/%zz',
    '/api//sim/config',
    '/api/sim;x/config',
    '/api/routing/internal/table',
    '/api/routing/%2e%2e/%2e%2e/internal/clock',
  ])('%s -> not routable', (path) => {
    expect(r('GET', path)).toBeNull();
    expect(r('POST', path)).toBeNull();
  });

  it('normalizePath decodes safe encodings and rejects ambiguous ones', () => {
    expect(normalizePath('/api/a%20b')).toEqual(['api', 'a b']);
    expect(normalizePath('/api/a%2Fb')).toBeNull();
    expect(normalizePath('no-slash')).toBeNull();
  });

  it('re-encodes the upstream path from decoded segments', () => {
    expect(r('GET', '/api/users/a%20b')!.upstreamPath).toBe('/users/a%20b');
  });
});

describe('isAllowed', () => {
  it('public accepts anyone; role lists are exact; service is never implied', () => {
    expect(isAllowed('public', 'rider')).toBe(true);
    expect(isAllowed(['admin'], 'admin')).toBe(true);
    expect(isAllowed(['admin'], 'rider')).toBe(false);
    expect(isAllowed(['rider', 'driver', 'admin'], 'service')).toBe(false);
    expect(isAllowed(['driver'], 'Driver')).toBe(false);
  });
});
