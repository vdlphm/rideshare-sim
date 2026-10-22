import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  type NestMiddleware,
} from '@nestjs/common';
import { ConfigService, CORRELATION_HEADER } from '@rideshare/common';
import type { NextFunction, Request, Response } from 'express';
import { createProxyMiddleware, type RequestHandler } from 'http-proxy-middleware';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SERVICE_URL_KEYS, type GatewayEnv } from './config';
import { isAllowed, resolveRoute, type ResolvedRoute } from './routes';
import { bearerToken, TokenVerifier } from './token-verifier';

const resolved = new WeakMap<IncomingMessage, ResolvedRoute>();

/** Matches the request against the route table. Unknown or `/internal/` paths never get further. */
@Injectable()
export class RouteMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const rawPath = (req.originalUrl ?? req.url).split('?')[0]!;
    const route = resolveRoute(req.method, rawPath);
    if (!route) throw new NotFoundException('Not Found');
    resolved.set(req, route);
    next();
  }
}

/** The only place tokens are verified. Public routes skip it but never forward credentials. */
@Injectable()
export class JwtVerifyMiddleware implements NestMiddleware {
  constructor(private readonly verifier: TokenVerifier) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const route = resolved.get(req);
    if (!route) throw new NotFoundException('Not Found');
    const header = req.headers.authorization;

    if (route.access === 'public') {
      // Credentials are meaningless here. A valid service token is refused (internal use only);
      // anything else is dropped so unverified claims can never reach a service.
      const jwt = bearerToken(header);
      if (jwt) {
        const result = await this.verifier.verify(jwt);
        if (result.ok && result.token.role === 'service') {
          throw new ForbiddenException('Service tokens are not accepted on public routes');
        }
      }
      delete req.headers.authorization;
      return next();
    }

    const jwt = bearerToken(header);
    if (!jwt) throw new UnauthorizedException('Missing or malformed bearer token');
    const result = await this.verifier.verify(jwt);
    if (!result.ok) {
      if (result.reason === 'unavailable') {
        throw new ServiceUnavailableException('Unable to verify token');
      }
      throw new UnauthorizedException('Invalid or expired token');
    }
    if (!isAllowed(route.access, result.token.role)) {
      throw new ForbiddenException('Insufficient role for this route');
    }
    next();
  }
}

function sendError(
  res: ServerResponse,
  status: number,
  error: string,
  message: string,
  id: string,
) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ statusCode: status, error, message, correlationId: id }));
}

const timedOut = new WeakSet<IncomingMessage>();
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT']);

@Injectable()
export class ProxyMiddleware implements NestMiddleware {
  private readonly targets: Record<string, string>;
  private readonly handler: RequestHandler;

  constructor(config: ConfigService<GatewayEnv>) {
    this.targets = Object.fromEntries(
      Object.entries(SERVICE_URL_KEYS).map(([svc, key]) => [svc, config.get(key)]),
    );
    const timeout = config.get('PROXY_TIMEOUT_MS');
    this.handler = createProxyMiddleware({
      target: this.targets.user, // overridden per request by `router`
      router: (req) => this.targets[resolved.get(req)!.service],
      pathRewrite: (_path, req) => resolved.get(req)!.upstreamPath + queryOf(req),
      changeOrigin: true,
      xfwd: true, // set x-forwarded-* from the real connection
      followRedirects: false,
      proxyTimeout: timeout,
      on: {
        proxyReq: (proxyReq, req) => {
          const id = req.headers[CORRELATION_HEADER] as string;
          proxyReq.setHeader(CORRELATION_HEADER, id);
          // httpxy destroys the request on proxyTimeout, which surfaces as a plain ECONNRESET;
          // remember the timeout so the error handler can answer 504 instead of 502.
          proxyReq.once('timeout', () => timedOut.add(req));
        },
        proxyRes: (proxyRes, req) => {
          proxyRes.headers[CORRELATION_HEADER] = req.headers[CORRELATION_HEADER] as string;
        },
        error: (err, req, res) => {
          const id = String(req.headers[CORRELATION_HEADER] ?? '');
          if (!('writeHead' in res)) return void res.destroy();
          const code = (err as NodeJS.ErrnoException).code ?? '';
          if (timedOut.has(req) || TIMEOUT_CODES.has(code)) {
            sendError(res, 504, 'Gateway Timeout', 'Upstream service timed out', id);
          } else {
            sendError(res, 502, 'Bad Gateway', 'Upstream service unavailable', id);
          }
        },
      },
    });
  }

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!resolved.has(req)) throw new NotFoundException('Not Found');
    // Never trust client-supplied forwarding headers; the proxy re-adds its own.
    for (const h of Object.keys(req.headers)) {
      if (h.startsWith('x-forwarded-') || h === 'forwarded' || h === 'x-real-ip') {
        delete req.headers[h];
      }
    }
    await this.handler(req, res, next);
  }
}

function queryOf(req: IncomingMessage): string {
  const url = (req as Request).originalUrl ?? req.url ?? '';
  const i = url.indexOf('?');
  return i === -1 ? '' : url.slice(i);
}
