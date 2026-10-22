import { Controller, Get, Inject, Module, Res, type DynamicModule } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/decorators';

export interface ReadinessCheck {
  name: string;
  check(): Promise<void>;
}

export const READINESS_CHECKS = Symbol('READINESS_CHECKS');

@Public()
@Controller()
export class HealthController {
  constructor(@Inject(READINESS_CHECKS) private readonly checks: ReadinessCheck[]) {}

  @Get('health')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const results = await Promise.all(
      this.checks.map(async (c) => {
        try {
          await c.check();
          return { name: c.name, ok: true as const };
        } catch (err) {
          return { name: c.name, ok: false as const, error: (err as Error).message };
        }
      }),
    );
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) res.status(503);
    return {
      status: failed.length > 0 ? 'unavailable' : 'ok',
      checks: Object.fromEntries(results.map((r) => [r.name, r.ok ? 'ok' : 'failed'])),
      failed: failed.map((f) => f.name),
    };
  }
}

@Module({})
export class HealthModule {
  static forRoot(opts: { checks?: ReadinessCheck[] } = {}): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [{ provide: READINESS_CHECKS, useValue: opts.checks ?? [] }],
    };
  }
}
