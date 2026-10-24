import { Module, type DynamicModule } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import {
  AuthContextModule,
  ConfigModule,
  DatabaseModule,
  ErrorsModule,
  HealthController,
  LoggingModule,
  POSTGRES_READINESS,
  READINESS_CHECKS,
  REDIS_READINESS,
  RedisModule,
  ServiceTokenModule,
  SimClock,
  SimClockModule,
  TOKEN_PROVIDER,
  createHttpClient,
  defineConfig,
  type ReadinessCheck,
  type TokenProvider,
} from '@rideshare/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { join } from 'node:path';
import { matchingEnvSchema } from './config';
import {
  CLOCK,
  ENGINE_OPTIONS,
  MatchingEngine,
  type EngineOptions,
} from './domain/matching.engine';
import { DriversPort, LockStore, MatchingRepository, RoutingPort, TripPort } from './domain/ports';
import { ClockSync } from './matching/clock-sync.service';
import { InternalMatchingController, OffersController } from './matching/matching.controller';
import { DrizzleMatchingRepository } from './matching/matching.repository';
import { RedisLockStore } from './matching/redis-lock-store';
import { MatchingSweeper } from './matching/sweeper.service';
import {
  DRIVER_HTTP,
  HttpDriversPort,
  HttpRoutingPort,
  HttpTripPort,
  ROUTING_HTTP,
  TRIP_HTTP,
} from './upstream/http-ports';

const upstreamClient = (token: symbol, service: string, baseUrl: string) => ({
  provide: token,
  inject: [TOKEN_PROVIDER],
  useFactory: (tokenProvider: TokenProvider) =>
    createHttpClient({ baseUrl, service, auth: 'service', tokenProvider }),
});

/** /health + /ready, with the Postgres and Redis checks. */
@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: READINESS_CHECKS,
      inject: [POSTGRES_READINESS, REDIS_READINESS],
      useFactory: (pg: ReadinessCheck, redis: ReadinessCheck) => [pg, redis],
    },
  ],
})
class MatchingHealthModule {}

@Module({})
export class AppModule {
  static forRoot(env: NodeJS.ProcessEnv = process.env): DynamicModule {
    const cfg = defineConfig(matchingEnvSchema, env);
    const engineOptions: EngineOptions = {
      offerTtlSimMs: cfg.OFFER_TTL_SIM_MS,
      giveUpSimMs: cfg.GIVE_UP_SIM_MS,
      lockTtlMs: cfg.LOCK_TTL_MS,
      idleRetryMs: cfg.IDLE_RETRY_MS,
    };
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({ schema: matchingEnvSchema, env }),
        LoggingModule.forRoot(),
        ErrorsModule,
        AuthContextModule,
        DatabaseModule.forRoot({
          url: cfg.DATABASE_URL,
          schema: 'matching_service',
          // Resolves to apps/matching/drizzle from both src/ (tests) and dist/ (production).
          migrationsFolder: join(__dirname, '..', 'drizzle'),
        }),
        RedisModule.forRoot({ url: cfg.REDIS_URL, keyPrefix: cfg.REDIS_KEY_PREFIX }),
        ServiceTokenModule.register({
          userServiceUrl: cfg.USER_SERVICE_URL,
          clientId: 'matching',
          clientSecret: cfg.MATCHING_CLIENT_SECRET,
        }),
        SimClockModule.forRoot({ simulatorUrl: cfg.SIMULATOR_URL }),
        MatchingHealthModule,
      ],
      controllers: [OffersController, InternalMatchingController],
      providers: [
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        { provide: MatchingRepository, useClass: DrizzleMatchingRepository },
        { provide: LockStore, useClass: RedisLockStore },
        { provide: DriversPort, useClass: HttpDriversPort },
        { provide: RoutingPort, useClass: HttpRoutingPort },
        { provide: TripPort, useClass: HttpTripPort },
        { provide: CLOCK, useExisting: SimClock },
        { provide: ENGINE_OPTIONS, useValue: engineOptions },
        upstreamClient(DRIVER_HTTP, 'driver', cfg.DRIVER_URL),
        upstreamClient(ROUTING_HTTP, 'routing', cfg.ROUTING_URL),
        upstreamClient(TRIP_HTTP, 'trip', cfg.TRIP_URL),
        MatchingEngine,
        MatchingSweeper,
        ClockSync,
      ],
    };
  }
}
