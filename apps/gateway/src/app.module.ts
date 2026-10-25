import {
  Module,
  RequestMethod,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import {
  ConfigModule,
  correlationMiddleware,
  defineConfig,
  ErrorsModule,
  HealthController,
  LoggingModule,
  READINESS_CHECKS,
  ServiceTokenModule,
  type ReadinessCheck,
} from '@rideshare/common';
import { gatewayEnvSchema } from './config';
import { LiveModule } from './live/live.module';
import { JwtVerifyMiddleware, ProxyMiddleware, RouteMiddleware } from './gateway.middleware';
import { TokenVerifier, TokenVerifierModule } from './token-verifier';

/** /health + /ready; ready means the JWKS endpoint (user service) is reachable. */
@Module({
  imports: [TokenVerifierModule],
  controllers: [HealthController],
  providers: [
    {
      provide: READINESS_CHECKS,
      inject: [TokenVerifier],
      useFactory: (verifier: TokenVerifier): ReadinessCheck[] => [
        {
          name: 'jwks',
          async check() {
            const res = await fetch(verifier.jwksUrl, { signal: AbortSignal.timeout(2000) });
            await res.arrayBuffer();
            if (!res.ok) throw new Error(`JWKS endpoint returned ${res.status}`);
          },
        },
      ],
    },
  ],
})
class GatewayHealthModule {}

/**
 * Mounts the proxy chain. Nest does not guarantee that LoggingModule's correlation middleware runs
 * before another module's, so the chain starts with `correlationMiddleware` itself (idempotent:
 * it reuses the id the other instance already normalised).
 */
@Module({
  imports: [TokenVerifierModule],
  providers: [RouteMiddleware, JwtVerifyMiddleware, ProxyMiddleware],
})
class ProxyModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(correlationMiddleware, RouteMiddleware, JwtVerifyMiddleware, ProxyMiddleware)
      .exclude(
        { path: 'health', method: RequestMethod.GET },
        { path: 'ready', method: RequestMethod.GET },
      )
      .forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}

@Module({})
export class AppModule {
  static forRoot(env: NodeJS.ProcessEnv = process.env): DynamicModule {
    const cfg = defineConfig(gatewayEnvSchema, env);
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({ schema: gatewayEnvSchema, env }),
        ServiceTokenModule.register({
          userServiceUrl: cfg.USER_SERVICE_URL,
          clientId: 'gateway',
          clientSecret: cfg.GATEWAY_CLIENT_SECRET,
        }),
        LoggingModule.forRoot(),
        ErrorsModule,
        GatewayHealthModule,
        ProxyModule,
        LiveModule,
      ],
    };
  }
}
