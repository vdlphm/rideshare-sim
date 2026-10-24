import { Module, type DynamicModule } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import {
  AuthContextModule,
  ConfigModule,
  CONFIG_VALUES,
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
import { routingEnvSchema, type RoutingEnv } from './config';
import { OSRM_HTTP, OsrmClient } from './osrm.client';
import { RoutingCache } from './routing.cache';
import { AdminRoutingController, InternalRoutingController } from './routing.controller';
import { RoutingService } from './routing.service';

/** A point in central Seattle; a tiny nearest query proves OSRM is up and has the graph loaded. */
const OSRM_PROBE = { lat: 47.6097, lng: -122.3422 };

@Module({
  providers: [
    {
      provide: OSRM_HTTP,
      inject: [CONFIG_VALUES],
      useFactory: (c: RoutingEnv) =>
        createHttpClient({
          baseUrl: c.OSRM_URL,
          service: 'osrm',
          timeoutMs: c.OSRM_TIMEOUT_MS,
          auth: 'none',
        }),
    },
    OsrmClient,
  ],
  exports: [OsrmClient],
})
class OsrmModule {}

/** /health + /ready: Redis and OSRM must both answer. */
@Module({
  imports: [OsrmModule],
  controllers: [HealthController],
  providers: [
    {
      provide: READINESS_CHECKS,
      inject: [REDIS_READINESS, OsrmClient],
      useFactory: (redis: ReadinessCheck, osrm: OsrmClient): ReadinessCheck[] => [
        redis,
        {
          name: 'osrm',
          async check() {
            await osrm.nearest(OSRM_PROBE);
          },
        },
      ],
    },
  ],
})
class RoutingHealthModule {}

@Module({})
export class AppModule {
  static forRoot(env: NodeJS.ProcessEnv = process.env): DynamicModule {
    const cfg = defineConfig(routingEnvSchema, env);
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({ schema: routingEnvSchema, env }),
        LoggingModule.forRoot(),
        ErrorsModule,
        AuthContextModule,
        RedisModule.forRoot({ url: cfg.REDIS_URL, keyPrefix: cfg.REDIS_KEY_PREFIX }),
        OsrmModule,
        RoutingHealthModule,
      ],
      controllers: [InternalRoutingController, AdminRoutingController],
      providers: [{ provide: APP_PIPE, useClass: ZodValidationPipe }, RoutingCache, RoutingService],
    };
  }
}
