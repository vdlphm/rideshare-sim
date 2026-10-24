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
  defineConfig,
  type ReadinessCheck,
} from '@rideshare/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { CLOCK } from './clock';
import { driverEnvSchema } from './config';
import { DriversController, InternalDriversController } from './driver.controller';
import { DriverService } from './driver.service';
import { DriverStore } from './driver.store';
import { StaleSweeper } from './sweeper.service';

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
class DriverHealthModule {}

@Module({})
export class AppModule {
  static forRoot(env: NodeJS.ProcessEnv = process.env): DynamicModule {
    const cfg = defineConfig(driverEnvSchema, env);
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({ schema: driverEnvSchema, env }),
        LoggingModule.forRoot(),
        ErrorsModule,
        AuthContextModule,
        RedisModule.forRoot({ url: cfg.REDIS_URL, keyPrefix: cfg.REDIS_KEY_PREFIX }),
        DriverHealthModule,
      ],
      controllers: [DriversController, InternalDriversController],
      providers: [
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        { provide: CLOCK, useValue: () => Date.now() },
        DriverStore,
        DriverService,
        StaleSweeper,
      ],
    };
  }
}
