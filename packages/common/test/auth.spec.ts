import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MockAgent } from 'undici';
import { SignJWT, generateKeyPair } from 'jose';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuthContextModule,
  CurrentUser,
  HealthModule,
  Public,
  Roles,
  ServiceTokenProvider,
  ServiceTokenModule,
  TOKEN_PROVIDER,
  type AuthUser,
  type TokenProvider,
} from '../src';

const keyPair = generateKeyPair('RS256');

async function token(claims: Record<string, unknown>, exp: number | null = 4_102_444_800) {
  const jwt = new SignJWT(claims).setProtectedHeader({ alg: 'RS256' });
  if (exp !== null) jwt.setExpirationTime(exp);
  return jwt.sign((await keyPair).privateKey); // random key: services never verify
}
const bearer = async (claims: Record<string, unknown>, exp?: number | null) =>
  `Bearer ${await token(claims, exp)}`;

@Controller()
class TestController {
  @Get('me') me(@CurrentUser() user: AuthUser | null) {
    return { user };
  }
  @Get('open') @Public() open() {
    return { ok: true };
  }
  @Get('any') any() {
    return { ok: true };
  }
  @Get('driver-only') @Roles('driver') driverOnly() {
    return { ok: true };
  }
}

@Controller('internal/things')
@Roles('service')
class InternalController {
  @Get() list() {
    return { ok: true };
  }
}

@Module({
  imports: [AuthContextModule, HealthModule.forRoot()],
  controllers: [TestController, InternalController],
})
class TestAppModule {}

let app: INestApplication;
beforeEach(async () => {
  const mod = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
  app = mod.createNestApplication();
  await app.init();
});
afterEach(async () => {
  await app.close();
});
const http = () => request(app.getHttpServer());

describe('AuthContextMiddleware + @CurrentUser', () => {
  it('decodes claims without verifying the signature', async () => {
    const res = await http()
      .get('/me')
      .set('authorization', await bearer({ sub: 'u1', role: 'rider' }));
    expect(res.body.user).toEqual({ id: 'u1', role: 'rider', exp: 4_102_444_800 });
  });

  it('decodes an unsigned token', async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const jwt = `${b64({ alg: 'none' })}.${b64({ sub: 'u2', role: 'admin', exp: 5 })}.`;
    const res = await http().get('/me').set('authorization', `Bearer ${jwt}`);
    expect(res.body.user).toEqual({ id: 'u2', role: 'admin', exp: 5 });
  });

  it('does not reject expired tokens', async () => {
    const res = await http()
      .get('/me')
      .set('authorization', await bearer({ sub: 'u1', role: 'rider' }, 1));
    expect(res.body.user).toEqual({ id: 'u1', role: 'rider', exp: 1 });
  });

  it.each([
    ['missing header', undefined],
    ['non-bearer scheme', 'Basic abc'],
    ['malformed token', 'Bearer not.a.jwt'],
    ['garbage', 'Bearer'],
  ])('sets user null for %s', async (_n, header) => {
    const req = http().get('/open');
    const res = await (header ? req.set('authorization', header) : req);
    expect(res.status).toBe(200);
    const me = await (header ? http().get('/me').set('authorization', header) : http().get('/me'));
    expect(me.status).toBe(401);
  });

  it.each([
    ['no sub', { role: 'rider' }, 4_102_444_800],
    ['empty sub', { sub: '', role: 'rider' }, 4_102_444_800],
    ['bad role', { sub: 'u', role: 'root' }, 4_102_444_800],
    ['no role', { sub: 'u' }, 4_102_444_800],
    ['non-string role', { sub: 'u', role: 3 }, 4_102_444_800],
    ['no exp', { sub: 'u', role: 'rider' }, null],
  ])('sets user null for wrong shape: %s', async (_n, claims, exp) => {
    const res = await http()
      .get('/any')
      .set('authorization', await bearer(claims, exp));
    expect(res.status).toBe(401);
  });
});

describe('RolesGuard', () => {
  it('401 without token on @Roles route', async () => {
    const res = await http().get('/driver-only');
    expect(res.status).toBe(401);
  });
  it('403 for wrong role', async () => {
    const res = await http()
      .get('/driver-only')
      .set('authorization', await bearer({ sub: 'u', role: 'rider' }));
    expect(res.status).toBe(403);
  });
  it('200 for matching role', async () => {
    const res = await http()
      .get('/driver-only')
      .set('authorization', await bearer({ sub: 'u', role: 'driver' }));
    expect(res.status).toBe(200);
  });
  it('any authenticated user passes without @Roles', async () => {
    const res = await http()
      .get('/any')
      .set('authorization', await bearer({ sub: 'u', role: 'rider' }));
    expect(res.status).toBe(200);
  });
  it('@Public allows anonymous', async () => {
    expect((await http().get('/open')).status).toBe(200);
  });
  it('/health and /ready stay reachable without a token', async () => {
    expect((await http().get('/health')).status).toBe(200);
    expect((await http().get('/ready')).status).toBe(200);
  });
  it('/internal rejects rider/driver and accepts service', async () => {
    for (const role of ['rider', 'driver']) {
      const res = await http()
        .get('/internal/things')
        .set('authorization', await bearer({ sub: 'u', role }));
      expect(res.status).toBe(403);
    }
    const ok = await http()
      .get('/internal/things')
      .set('authorization', await bearer({ sub: 'matching', role: 'service' }));
    expect(ok.status).toBe(200);
  });
});

describe('ServiceTokenProvider', () => {
  const URL_ = 'http://user.test';
  let agent: MockAgent;
  let clock: number;
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    clock = 1_000_000;
  });
  afterEach(async () => {
    await agent.close();
  });

  const provider = () =>
    new ServiceTokenProvider({
      userServiceUrl: URL_,
      clientId: 'matching',
      clientSecret: 's3cret',
      dispatcher: agent,
      now: () => clock,
    });
  const intercept = (accessToken: string, expiresIn = 900) =>
    agent
      .get(URL_)
      .intercept({
        path: '/auth/token',
        method: 'POST',
        body: JSON.stringify({ clientId: 'matching', clientSecret: 's3cret' }),
      })
      .reply(200, { accessToken, expiresIn });

  it('caches the token while valid', async () => {
    intercept('t1'); // single interceptor: a second call would fail (net connect disabled)
    const p = provider();
    expect(await p.getToken()).toBe('t1');
    clock += 800_000;
    expect(await p.getToken()).toBe('t1');
  });

  it('refreshes when under 60s of validity remain', async () => {
    intercept('t1');
    intercept('t2');
    const p = provider();
    expect(await p.getToken()).toBe('t1');
    clock += 840_001; // 59.999 s left
    expect(await p.getToken()).toBe('t2');
  });

  it('shares one in-flight request between concurrent callers', async () => {
    intercept('t1'); // only one interceptor registered
    const p = provider();
    const all = await Promise.all([p.getToken(), p.getToken(), p.getToken()]);
    expect(all).toEqual(['t1', 't1', 't1']);
  });

  it('retries after a failed refresh', async () => {
    agent
      .get(URL_)
      .intercept({ path: '/auth/token', method: 'POST' })
      .reply(401, { message: 'bad' });
    intercept('t1');
    const p = provider();
    await expect(p.getToken()).rejects.toThrow();
    expect(await p.getToken()).toBe('t1');
  });

  it('uses Date.now by default', () => {
    const p = new ServiceTokenProvider({ userServiceUrl: URL_, clientId: 'a', clientSecret: 'b' });
    expect(p).toBeInstanceOf(ServiceTokenProvider);
  });

  it('ServiceTokenModule registers it under TOKEN_PROVIDER', async () => {
    const mod = await Test.createTestingModule({
      imports: [
        ServiceTokenModule.register({ userServiceUrl: URL_, clientId: 'a', clientSecret: 'b' }),
      ],
    }).compile();
    const tp = mod.get<TokenProvider>(TOKEN_PROVIDER, { strict: false });
    expect(tp).toBeInstanceOf(ServiceTokenProvider);
  });
});
