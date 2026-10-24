import { Module, type DynamicModule } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import {
  AuthContextModule,
  ConfigModule,
  ErrorsModule,
  HealthController,
  LoggingModule,
  READINESS_CHECKS,
} from '@rideshare/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { simulatorEnvSchema } from './config';
import { InternalSimController, SimConfigController } from './sim.controller';
import { CLOCK, SimStore } from './sim-store';

/** /health + /ready; no dependencies yet, so always ready. */
@Module({
  controllers: [HealthController],
  providers: [{ provide: READINESS_CHECKS, useValue: [] }],
})
class SimulatorHealthModule {}

@Module({})
export class AppModule {
  static forRoot(env: NodeJS.ProcessEnv = process.env): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({ schema: simulatorEnvSchema, env }),
        LoggingModule.forRoot(),
        ErrorsModule,
        AuthContextModule,
        SimulatorHealthModule,
      ],
      controllers: [SimConfigController, InternalSimController],
      providers: [
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        { provide: CLOCK, useValue: () => Date.now() },
        SimStore,
      ],
      exports: [SimStore],
    };
  }
}
