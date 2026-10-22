import {
  BadRequestException,
  Controller,
  Get,
  Logger as NestLogger,
  INestApplication,
  Module,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Writable } from 'node:stream';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { Logger } from 'nestjs-pino';
import {
  ConfigModule,
  CorrelationModule,
  ErrorsModule,
  HealthModule,
  LoggingModule,
  baseEnvSchema,
  getCorrelationId,
  type ReadinessCheck,
} from '../src';

@Controller('t')
class TestController {
  @Get('id')
  id() {
    return { id: getCorrelationId() };
  }
  @Get('bad')
  bad() {
    throw new BadRequestException('nope');
  }
  @Get('boom')
  boom() {
    throw new Error('secret internals');
  }
  @Get('log')
  log() {
    new NestLogger(TestController.name).log('inside handler');
    return { ok: true };
  }
}

let app: INestApplication;
afterEach(async () => app?.close());

async function boot(imports: unknown[] = []): Promise<INestApplication> {
  @Module({
    imports: [
      ConfigModule.forRoot({
        schema: baseEnvSchema,
        env: { SERVICE_NAME: 'test-svc', LOG_LEVEL: 'silent' },
      }),
      ...(imports as []),
    ],
    controllers: [TestController],
  })
  class AppModule {}
  const ref = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = ref.createNestApplication();
  await app.init();
  return app;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('correlation middleware', () => {
  it('reuses an incoming id and sets the response header', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    await boot([CorrelationModule]);
    const res = await request(app.getHttpServer()).get('/t/id').set('x-correlation-id', id);
    expect(res.headers['x-correlation-id']).toBe(id);
    expect(res.body.id).toBe(id);
  });

  it('generates one when missing or invalid', async () => {
    await boot([CorrelationModule]);
    const a = await request(app.getHttpServer()).get('/t/id');
    expect(a.headers['x-correlation-id']).toMatch(UUID);
    expect(a.body.id).toBe(a.headers['x-correlation-id']);
    const b = await request(app.getHttpServer()).get('/t/id').set('x-correlation-id', 'not valid');
    expect(b.headers['x-correlation-id']).toMatch(UUID);
  });
});

describe('error filter', () => {
  it('passes HttpException through', async () => {
    await boot([CorrelationModule, ErrorsModule]);
    const res = await request(app.getHttpServer()).get('/t/bad');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ statusCode: 400, error: 'Bad Request', message: 'nope' });
    expect(res.body.correlationId).toBe(res.headers['x-correlation-id']);
  });

  it('maps 404 and unknown errors without leaking', async () => {
    await boot([CorrelationModule, ErrorsModule]);
    const nf = await request(app.getHttpServer()).get('/missing');
    expect(nf.status).toBe(404);
    const res = await request(app.getHttpServer()).get('/t/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal server error',
      correlationId: res.headers['x-correlation-id'],
    });
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});

describe('health', () => {
  it('/health is always 200', async () => {
    await boot([HealthModule.forRoot()]);
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('/ready is 200 when all checks pass', async () => {
    const ok: ReadinessCheck = { name: 'db', check: async () => undefined };
    await boot([HealthModule.forRoot({ checks: [ok] })]);
    expect((await request(app.getHttpServer()).get('/ready')).status).toBe(200);
  });

  it('/ready is 200 with no checks', async () => {
    await boot([HealthModule.forRoot()]);
    expect((await request(app.getHttpServer()).get('/ready')).status).toBe(200);
  });

  it('/ready is 503 naming the failed check', async () => {
    const checks: ReadinessCheck[] = [
      { name: 'db', check: async () => undefined },
      { name: 'redis', check: async () => Promise.reject(new Error('down')) },
    ];
    await boot([HealthModule.forRoot({ checks })]);
    const res = await request(app.getHttpServer()).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.failed).toEqual(['redis']);
    expect(res.body.checks).toEqual({ db: 'ok', redis: 'failed' });
  });
});

describe('logging', () => {
  it('logs service + correlationId and redacts authorization', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(...String(chunk).split('\n').filter(Boolean));
        cb();
      },
    });
    @Module({
      imports: [
        ConfigModule.forRoot({
          schema: baseEnvSchema,
          env: { SERVICE_NAME: 'log-svc', LOG_LEVEL: 'info' },
        }),
        LoggingModule.forRoot({ stream }),
      ],
      controllers: [TestController],
    })
    class AppModule {}
    const ref = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = ref.createNestApplication({ bufferLogs: true });
    app.useLogger(app.get(Logger));
    await app.init();

    const id = '22222222-2222-4222-8222-222222222222';
    await request(app.getHttpServer())
      .get('/t/log')
      .set('x-correlation-id', id)
      .set('authorization', 'Bearer topsecret')
      .set('cookie', 'sid=abc');
    await new Promise((r) => setTimeout(r, 50));

    expect(lines.length).toBeGreaterThan(0);
    const parsed = lines.map((l) => JSON.parse(l));
    const inRequest = parsed.filter((l) => l.msg === 'inside handler' || l.req);
    expect(inRequest.map((l) => l.msg)).toEqual(['inside handler', 'request completed']);
    for (const l of parsed) expect(l.service).toBe('log-svc');
    for (const l of inRequest) {
      expect(l.service).toBe('log-svc');
      expect(l.correlationId).toBe(id);
    }
    const all = lines.join('\n');
    expect(all).not.toContain('topsecret');
    expect(all).not.toContain('sid=abc');
    expect(all).toContain('[Redacted]');
  });
});
