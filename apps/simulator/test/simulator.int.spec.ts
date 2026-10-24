import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { clockResponseSchema } from '@rideshare/common';
import { SimConfigSchema } from '@rideshare/contracts';
import { SignJWT } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { CLOCK } from '../src/sim-store';

let app: INestApplication;
let base: string;
let now = 5_000_000;

const key = new TextEncoder().encode('any-key-services-do-not-verify');
const token = (sub: string, role: string) =>
  new SignJWT({ sub, role })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(key)
    .then((t) => `Bearer ${t}`);

beforeAll(async () => {
  const ref = await Test.createTestingModule({
    imports: [AppModule.forRoot({ NODE_ENV: 'test', LOG_LEVEL: 'silent', PORT: '0' })],
  })
    .overrideProvider(CLOCK)
    .useValue(() => now)
    .compile();
  app = ref.createNestApplication();
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
}, 30_000);

afterAll(async () => {
  await app?.close();
});

const clock = async () =>
  request(base)
    .get('/internal/clock')
    .set('Authorization', await token('svc', 'service'));

const put = async (body: unknown) =>
  request(base)
    .put('/sim/config')
    .set('Authorization', await token('adm', 'admin'))
    .send(body as object);

describe('simulator', () => {
  it('health and ready are public', async () => {
    await request(base).get('/health').expect(200);
    await request(base).get('/ready').expect(200);
  });

  it('GET /internal/clock matches clockResponseSchema and moves forward', async () => {
    const a = await clock();
    expect(a.status).toBe(200);
    const pa = clockResponseSchema.parse(a.body);
    now += 2000;
    const pb = clockResponseSchema.parse((await clock()).body);
    expect(pb.simTime - pa.simTime).toBe(2000);
    expect(pb.paused).toBe(false);
  });

  it('GET /internal/sim/state returns clock and config', async () => {
    const res = await request(base)
      .get('/internal/sim/state')
      .set('Authorization', await token('svc', 'service'))
      .expect(200);
    clockResponseSchema.parse(res.body.clock);
    SimConfigSchema.parse(res.body.config);
  });

  it('PUT {speed: 10} scales subsequent time without a jump', async () => {
    const before = (await clock()).body.simTime;
    const res = await put({ speed: 10 });
    expect(res.status).toBe(200);
    expect(SimConfigSchema.parse(res.body).speed).toBe(10);
    expect((await clock()).body.simTime).toBe(before);
    now += 1000;
    expect((await clock()).body.simTime).toBe(before + 10_000);
    await put({ speed: 1 });
  });

  it('PUT {paused: true} freezes, resume continues', async () => {
    await put({ paused: true }).then((r) => expect(r.body.paused).toBe(true));
    const a = (await clock()).body;
    now += 5000;
    const b = (await clock()).body;
    expect(b.simTime).toBe(a.simTime);
    expect(b.paused).toBe(true);
    await put({ paused: false });
    now += 1000;
    expect((await clock()).body.simTime).toBe(a.simTime + 1000);
  });

  it('GET /sim/config returns the config for admin', async () => {
    const res = await request(base)
      .get('/sim/config')
      .set('Authorization', await token('adm', 'admin'))
      .expect(200);
    SimConfigSchema.parse(res.body);
  });

  it('rejects invalid updates with 400', async () => {
    expect((await put({ speed: 11 })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    expect((await put({ bogus: 1 })).status).toBe(400);
  });

  it('enforces roles', async () => {
    for (const role of ['rider', 'service']) {
      await request(base)
        .get('/sim/config')
        .set('Authorization', await token('x', role))
        .expect(403);
      await request(base)
        .put('/sim/config')
        .set('Authorization', await token('x', role))
        .send({ speed: 2 })
        .expect(403);
    }
    await request(base)
      .get('/internal/clock')
      .set('Authorization', await token('adm', 'admin'))
      .expect(403);
    await request(base).get('/internal/clock').expect(401);
    await request(base).get('/sim/config').expect(401);
  });
});
