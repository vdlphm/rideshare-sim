import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AuthRole } from './auth-user';
import { PUBLIC_KEY, ROLES_KEY } from './decorators';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_KEY, targets)) return true;

    const user = ctx.switchToHttp().getRequest<Request>().user;
    if (!user) throw new UnauthorizedException('Authentication required');

    const roles = this.reflector.getAllAndOverride<AuthRole[] | undefined>(ROLES_KEY, targets);
    if (roles && roles.length > 0 && !roles.includes(user.role)) {
      throw new ForbiddenException('Insufficient role');
    }
    return true;
  }
}
