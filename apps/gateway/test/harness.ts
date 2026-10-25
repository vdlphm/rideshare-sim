import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type CryptoKey } from 'jose';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AppModule } from '../src/app.module';

export interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface Fake {
  name: string;
  url: string;
  seen: Seen[];
  server: Server;
  /** Optional per-request override (e.g. to stall). */
  handler?: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => boolean;
  close(): Promise<void>;
}

export async function startFake(name: string): Promise<Fake> {
  const fake: Fake = { name, url: '', seen: [], server: undefined as never, close: async () => {} };
  fake.server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (fake.handler?.(req, res)) return;
      const seen = {
        method: req.method!,
        url: req.url!,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      fake.seen.push(seen);
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-upstream', name);
      res.end(JSON.stringify(seen));
    });
  });
  await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', r));
  fake.url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  fake.close = () =>
    new Promise<void>((r) => {
      fake.server.closeAllConnections();
      fake.server.close(() => r());
    });
  return fake;
}

export interface Signer {
  kid: string;
  privateKey: CryptoKey;
  jwk: JWK;
  sign(
    claims?: Record<string, unknown>,
    opts?: { kid?: string; issuer?: string; exp?: string | number; typ?: string },
  ): Promise<string>;
}

export async function makeSigner(kid: string): Promise<Signer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return {
    kid,
    privateKey,
    jwk,
    sign: (claims = { sub: 'u1', role: 'rider' }, opts = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? kid, typ: opts.typ ?? 'JWT' })
        .setIssuer(opts.issuer ?? 'rideshare-user-service')
        .setIssuedAt()
        .setExpirationTime(opts.exp ?? '5m')
        .sign(privateKey),
  };
}

export const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

export const SERVICES = ['user', 'rider', 'driver', 'trip', 'matching', 'routing', 'simulator'];

export interface Env {
  fakes: Record<string, Fake>;
  /** JWKS served by the fake user service; mutate to rotate keys. */
  jwks: { keys: JWK[] };
  jwksHits: () => number;
  app: INestApplication;
  base: string;
  close(): Promise<void>;
}

export async function startGateway(extra: NodeJS.ProcessEnv = {}, keys: JWK[] = []): Promise<Env> {
  const fakes: Record<string, Fake> = {};
  for (const s of SERVICES) fakes[s] = await startFake(s);
  const jwks = { keys };
  let hits = 0;
  fakes.user!.handler = (req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      hits++;
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'public, max-age=300');
      res.end(JSON.stringify(jwks));
      return true;
    }
    return false;
  };
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PORT: '0',
    JWKS_COOLDOWN_MS: '0',
    GATEWAY_CLIENT_SECRET: 'test-secret',
    ...Object.fromEntries(SERVICES.map((s) => [`${s.toUpperCase()}_SERVICE_URL`, fakes[s]!.url])),
    ...extra,
  };
  const ref = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
  const app = ref.createNestApplication({ bodyParser: false });
  await app.listen(0, '127.0.0.1');
  return {
    fakes,
    jwks,
    jwksHits: () => hits,
    app,
    base: await app.getUrl(),
    close: async () => {
      await app.close();
      await Promise.all(Object.values(fakes).map((f) => f.close()));
    },
  };
}
