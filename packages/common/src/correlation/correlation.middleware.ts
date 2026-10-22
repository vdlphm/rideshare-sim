import { randomUUID } from 'node:crypto';
import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { CORRELATION_HEADER, requestContext } from './request-context';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers[CORRELATION_HEADER];
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
  const correlationId = candidate && UUID_V4.test(candidate) ? candidate : randomUUID();
  // Normalise so downstream consumers (e.g. pino-http) see the effective id.
  req.headers[CORRELATION_HEADER] = correlationId;
  res.setHeader(CORRELATION_HEADER, correlationId);
  requestContext.run({ correlationId, authorization: req.headers.authorization }, next);
}

@Module({})
export class CorrelationModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(correlationMiddleware)
      .forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
