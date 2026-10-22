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
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { DrizzleRefreshTokenStore, RefreshTokenStore } from './auth/refresh-token.store';
import {
  DrizzleServiceClientsRepository,
  ServiceClientsRepository,
} from './auth/service-clients.repository';
import { CLOCK } from './clock';
import { userEnvSchema } from './config';
import { KeyService } from './keys/key.service';
import { SeedService } from './seed/seed.service';
import { TokenService } from './tokens/token.service';
import { UsersController } from './users/users.controller';
import { DrizzleUsersRepository, UsersRepository } from './users/users.repository';
import { UsersService } from './users/users.service';

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
class UserHealthModule {}

@Module({})
export class AppModule {
  static forRoot(env: NodeJS.ProcessEnv = process.env): DynamicModule {
    const cfg = defineConfig(userEnvSchema, env);
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({ schema: userEnvSchema, env }),
        LoggingModule.forRoot(),
        ErrorsModule,
        AuthContextModule,
        DatabaseModule.forRoot({
          url: cfg.DATABASE_URL,
          schema: 'user_service',
          // Resolves to apps/user/drizzle from both src/ (tests) and dist/ (production).
          migrationsFolder: join(__dirname, '..', 'drizzle'),
        }),
        UserHealthModule,
      ],
      controllers: [UsersController, AuthController],
      providers: [
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        { provide: CLOCK, useValue: () => Date.now() },
        { provide: UsersRepository, useClass: DrizzleUsersRepository },
        { provide: ServiceClientsRepository, useClass: DrizzleServiceClientsRepository },
        { provide: RefreshTokenStore, useClass: DrizzleRefreshTokenStore },
        KeyService,
        TokenService,
        UsersService,
        AuthService,
        SeedService,
      ],
    };
  }
}
