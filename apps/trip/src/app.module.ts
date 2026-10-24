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
  defineConfig,
  type ReadinessCheck,
} from '@rideshare/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { join } from 'node:path';
import { tripEnvSchema } from './config';
import { DrizzleTripsRepository, TripsRepository } from './trips/trips.repository';

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
        TripHealthModule,
      ],
      providers: [
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        { provide: TripsRepository, useClass: DrizzleTripsRepository },
      ],
    };
  }
}
