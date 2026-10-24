import { Module, type DynamicModule } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import {
  AuthContextModule,
  ConfigModule,
  ErrorsModule,
  HealthController,
  LoggingModule,
  REDIS_READINESS,
  READINESS_CHECKS,
  RedisModule,
  createHttpClient,
  defineConfig,
  type ReadinessCheck,
} from '@rideshare/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { riderEnvSchema } from './config';
import { CLOCK, RiderPositionsService } from './positions.service';
import { InternalRidersController, RidersController } from './riders.controller';
import { RideRequestsController } from './rides.controller';
import { RideRequestsService, TRIP_HTTP } from './rides.service';

/** /health + /ready, with the Redis check from RedisModule. */
@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: READINESS_CHECKS,
      inject: [REDIS_READINESS],
      useFactory: (redis: ReadinessCheck) => [redis],
    },
  ],
})
class RiderHealthModule {}

@Module({})
export class AppModule {
  static forRoot(env: NodeJS.ProcessEnv = process.env): DynamicModule {
    const cfg = defineConfig(riderEnvSchema, env);
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({ schema: riderEnvSchema, env }),
        LoggingModule.forRoot(),
        ErrorsModule,
        AuthContextModule,
        RedisModule.forRoot({ url: cfg.REDIS_URL, keyPrefix: cfg.REDIS_KEY_PREFIX }),
        RiderHealthModule,
      ],
      controllers: [RidersController, InternalRidersController, RideRequestsController],
      providers: [
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        { provide: CLOCK, useValue: () => Date.now() },
        RiderPositionsService,
        {
          provide: TRIP_HTTP,
          // Acts as the rider (forwarded token); ride creation is not idempotent, so no retries.
          useFactory: () =>
            createHttpClient({
              baseUrl: cfg.TRIP_URL,
              service: 'trip',
              auth: 'forward',
              maxAttempts: 1,
            }),
        },
        RideRequestsService,
      ],
      exports: [RiderPositionsService],
    };
  }
}
