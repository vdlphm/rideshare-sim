import { Module, type DynamicModule } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import {
  AuthContextModule,
  ConfigModule,
  ErrorsModule,
  HealthController,
  LoggingModule,
  READINESS_CHECKS,
  ServiceTokenModule,
} from '@rideshare/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { simulatorEnvSchema } from './config';
import { BOT_RNG, BotRuntime } from './bots/bot-runtime';
import { defineConfig } from '@rideshare/common';
import { InternalSimController, SimConfigController, SimRidersController } from './sim.controller';
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
    const cfg = defineConfig(simulatorEnvSchema, env);
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({ schema: simulatorEnvSchema, env }),
        LoggingModule.forRoot(),
        ErrorsModule,
        AuthContextModule,
        ServiceTokenModule.register({
          userServiceUrl: cfg.USER_SERVICE_URL,
          clientId: 'simulator',
          clientSecret: cfg.SIMULATOR_CLIENT_SECRET,
        }),
        SimulatorHealthModule,
      ],
      controllers: [SimConfigController, SimRidersController, InternalSimController],
      providers: [
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        { provide: CLOCK, useValue: () => Date.now() },
        { provide: BOT_RNG, useValue: Math.random },
        SimStore,
        BotRuntime,
      ],
      exports: [SimStore, BotRuntime],
    };
  }
}
