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
  ServiceTokenModule,
  SimClockModule,
  TOKEN_PROVIDER,
  createHttpClient,
  defineConfig,
  type TokenProvider,
  type ReadinessCheck,
} from '@rideshare/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { join } from 'node:path';
import { tripEnvSchema } from './config';
import { InternalTripsController, TripsController } from './trips/trips.controller';
import { DrizzleTripsRepository, TripsRepository } from './trips/trips.repository';
import { TripsService } from './trips/trips.service';
import { ClockSync } from './upstream/clock-sync.service';
import { MatchingDispatcher, REAL_NOW } from './upstream/dispatcher.service';
import { DRIVER_HTTP, MATCHING_HTTP, ROUTING_HTTP, Upstreams } from './upstream/upstreams.service';

const upstreamClient = (token: symbol, service: string, baseUrl: string) => ({
  provide: token,
  inject: [TOKEN_PROVIDER],
  useFactory: (tokenProvider: TokenProvider) =>
    createHttpClient({ baseUrl, service, auth: 'service', tokenProvider }),
});

/** /health + /ready, with the Postgres check from DatabaseModule. */
@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: READINESS_CHECKS,
      inject: [POSTGRES_READINESS],
      useFactory: (pg: ReadinessCheck) => [pg],
    },
  ],
})
class TripHealthModule {}

@Module({})
export class AppModule {
  static forRoot(env: NodeJS.ProcessEnv = process.env): DynamicModule {
    const cfg = defineConfig(tripEnvSchema, env);
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({ schema: tripEnvSchema, env }),
        LoggingModule.forRoot(),
        ErrorsModule,
        AuthContextModule,
        DatabaseModule.forRoot({
          url: cfg.DATABASE_URL,
          schema: 'trip_service',
          // Resolves to apps/trip/drizzle from both src/ (tests) and dist/ (production).
          migrationsFolder: join(__dirname, '..', 'drizzle'),
        }),
        ServiceTokenModule.register({
          userServiceUrl: cfg.USER_SERVICE_URL,
          clientId: 'trip',
          clientSecret: cfg.TRIP_CLIENT_SECRET,
        }),
        SimClockModule.forRoot({ simulatorUrl: cfg.SIMULATOR_URL }),
        TripHealthModule,
      ],
      controllers: [TripsController, InternalTripsController],
      providers: [
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        { provide: TripsRepository, useClass: DrizzleTripsRepository },
        { provide: REAL_NOW, useValue: () => Date.now() },
        upstreamClient(ROUTING_HTTP, 'routing', cfg.ROUTING_URL),
        upstreamClient(DRIVER_HTTP, 'driver', cfg.DRIVER_URL),
        upstreamClient(MATCHING_HTTP, 'matching', cfg.MATCHING_URL),
        Upstreams,
        MatchingDispatcher,
        TripsService,
        ClockSync,
      ],
    };
  }
}
