import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthContextMiddleware } from './auth-context.middleware';
import { RolesGuard } from './roles.guard';

@Module({
  providers: [{ provide: APP_GUARD, useClass: RolesGuard }],
})
export class AuthContextModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(AuthContextMiddleware)
      .forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
