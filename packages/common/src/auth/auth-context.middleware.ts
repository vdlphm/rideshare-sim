import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { decodeJwt } from 'jose';
import { AUTH_ROLES, type AuthRole, type AuthUser } from './auth-user';

const BEARER = /^Bearer\s+(\S+)$/i;

/** Decodes the bearer token WITHOUT verifying it (the gateway already did). Never throws. */
export function decodeAuthUser(header: string | undefined): AuthUser | null {
  const match = header ? BEARER.exec(header) : null;
  if (!match) return null;
  try {
    const { sub, role, exp } = decodeJwt(match[1]!);
    if (typeof sub !== 'string' || sub === '') return null;
    if (typeof role !== 'string' || !AUTH_ROLES.includes(role as AuthRole)) return null;
    if (typeof exp !== 'number') return null;
    return { id: sub, role: role as AuthRole, exp };
  } catch {
    return null;
  }
}

@Injectable()
export class AuthContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    req.user = decodeAuthUser(req.headers.authorization);
    next();
  }
}
