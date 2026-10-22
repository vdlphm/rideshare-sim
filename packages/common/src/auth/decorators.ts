import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthRole, AuthUser } from './auth-user';

export const ROLES_KEY = 'auth:roles';
export const PUBLIC_KEY = 'auth:public';

export const Roles = (...roles: AuthRole[]) => SetMetadata(ROLES_KEY, roles);
export const Public = () => SetMetadata(PUBLIC_KEY, true);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser | null =>
    ctx.switchToHttp().getRequest<Request>().user ?? null,
);
