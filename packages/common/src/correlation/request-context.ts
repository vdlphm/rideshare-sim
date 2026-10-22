import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  correlationId: string;
  /** Incoming Authorization header, forwarded by HttpClient when acting for a user. */
  authorization?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export const CORRELATION_HEADER = 'x-correlation-id';

export function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}

export function getCorrelationId(): string | undefined {
  return requestContext.getStore()?.correlationId;
}

export function getAuthorization(): string | undefined {
  return requestContext.getStore()?.authorization;
}
