import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ConfigModule,
  ConfigService,
  ConfigValidationError,
  InjectConfig,
  baseEnvSchema,
  defineConfig,
} from '../src';

describe('config', () => {
  it('parses valid env with defaults', () => {
    const cfg = defineConfig(baseEnvSchema, { SERVICE_NAME: 'svc', PORT: '8080' });
    expect(cfg).toEqual({
      NODE_ENV: 'development',
      PORT: 8080,
      SERVICE_NAME: 'svc',
      LOG_LEVEL: 'info',
    });
  });

  it('throws listing all invalid keys', () => {
    try {
      defineConfig(baseEnvSchema, { PORT: 'abc', NODE_ENV: 'nope' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigValidationError);
      const msg = (e as Error).message;
      expect(msg).toContain('PORT');
      expect(msg).toContain('NODE_ENV');
      expect(msg).toContain('SERVICE_NAME');
    }
  });

  it('reports root-level issues', () => {
    const schema = z
      .object({})
      .superRefine((_v, ctx) => ctx.addIssue({ code: 'custom', message: 'bad' }));
    expect(() => defineConfig(schema, {})).toThrow('(root)');
  });

  it('defaults to process.env', () => {
    process.env.SERVICE_NAME = 'from-env';
    expect(defineConfig(baseEnvSchema).SERVICE_NAME).toBe('from-env');
  });

  it('is injectable via ConfigService and @InjectConfig', async () => {
    const schema = baseEnvSchema.extend({ EXTRA: z.string().default('x') });
    type Cfg = z.infer<typeof schema>;
    @Injectable()
    class Consumer {
      constructor(@InjectConfig() readonly cfg: Cfg) {}
    }
    const ref = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ schema, env: { SERVICE_NAME: 's' } })],
      providers: [Consumer],
    }).compile();
    expect(ref.get(Consumer).cfg.EXTRA).toBe('x');
    expect(ref.get(ConfigService<Cfg>).get('SERVICE_NAME')).toBe('s');
  });

  it('fails fast at module creation', () => {
    expect(() => ConfigModule.forRoot({ schema: baseEnvSchema, env: {} })).toThrow(
      ConfigValidationError,
    );
  });
});
