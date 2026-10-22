export const AUTH_ROLES = ['rider', 'driver', 'admin', 'service'] as const;
export type AuthRole = (typeof AUTH_ROLES)[number];

/** Identity decoded from the (gateway-verified) bearer token. `id` is the JWT `sub`. */
export interface AuthUser {
  id: string;
  role: AuthRole;
  exp: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser | null;
  }
}
