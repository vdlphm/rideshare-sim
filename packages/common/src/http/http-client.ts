import { randomUUID } from 'node:crypto';
import { request, type Dispatcher } from 'undici';
import type { ZodType } from 'zod';
import { UpstreamError } from '../errors/upstream-error';
import { CORRELATION_HEADER, getAuthorization, getCorrelationId } from '../correlation';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
export type AuthMode = 'forward' | 'service' | 'none';

/** Supplies service-to-service bearer tokens (implemented by the auth module, task 1.5). */
export interface TokenProvider {
  getToken(): Promise<string>;
}

export const TOKEN_PROVIDER = Symbol('TOKEN_PROVIDER');

export interface HttpClientOptions {
  baseUrl: string;
  /** Name used in UpstreamError; defaults to baseUrl. */
  service?: string;
  /** Per-attempt timeout, default 2000 ms. */
  timeoutMs?: number;
  /** Total attempts including the first, default 3. */
  maxAttempts?: number;
  /** Backoff base, default 100 ms: delay = base * 2^(attempt-1) * (0.5 + random/2). */
  baseDelayMs?: number;
  /**
   * Default auth mode. Default 'forward': sends the current request's Authorization header
   * if there is one (no header otherwise), so user-initiated calls act as the user.
   */
  auth?: AuthMode;
  tokenProvider?: TokenProvider;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** undici dispatcher (MockAgent in tests). */
  dispatcher?: Dispatcher;
}

export interface RequestOptions<T = unknown> {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  /** Zod schema used to parse (and type) the response body. */
  schema?: ZodType<T>;
  timeoutMs?: number;
  auth?: AuthMode;
  /** Override idempotency: true allows retries for e.g. POST, false disables them for GET. */
  idempotent?: boolean;
}

const IDEMPOTENT: ReadonlySet<string> = new Set(['GET', 'PUT', 'DELETE', 'HEAD']);

export class HttpClient {
  private readonly base: string;
  private readonly service: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly opts: HttpClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.service = opts.service ?? opts.baseUrl;
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 100;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
  }

  get<T = unknown>(path: string, o?: RequestOptions<T>): Promise<T> {
    return this.send('GET', path, o);
  }
  post<T = unknown>(path: string, o?: RequestOptions<T>): Promise<T> {
    return this.send('POST', path, o);
  }
  put<T = unknown>(path: string, o?: RequestOptions<T>): Promise<T> {
    return this.send('PUT', path, o);
  }
  patch<T = unknown>(path: string, o?: RequestOptions<T>): Promise<T> {
    return this.send('PATCH', path, o);
  }
  delete<T = unknown>(path: string, o?: RequestOptions<T>): Promise<T> {
    return this.send('DELETE', path, o);
  }

  private async send<T>(method: HttpMethod, path: string, o: RequestOptions<T> = {}): Promise<T> {
    const idempotent = o.idempotent ?? IDEMPOTENT.has(method);
    const attempts = idempotent ? this.maxAttempts : 1;
    const timeoutMs = o.timeoutMs ?? this.timeoutMs;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) await this.sleep(this.backoff(attempt - 1));
      try {
        // Headers are rebuilt per attempt so a refreshed service token is picked up.
        const headers = await this.buildHeaders(o);
        const res = await request(this.url(path, o.query), {
          method,
          headers,
          body: o.body === undefined ? undefined : JSON.stringify(o.body),
          signal: AbortSignal.timeout(timeoutMs),
          dispatcher: this.opts.dispatcher,
        });
        const text = await res.body.text();
        const body = parseBody(text);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          return o.schema ? o.schema.parse(body) : (body as T);
        }
        const err = new UpstreamError({
          service: this.service,
          method,
          path,
          status: res.statusCode,
          body,
        });
        if (res.statusCode < 500) throw err;
        lastError = err;
      } catch (err) {
        if (err instanceof UpstreamError && err.status < 500) throw err;
        if (!isTransport(err) && !(err instanceof UpstreamError)) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  private backoff(retry: number): number {
    return this.baseDelayMs * 2 ** (retry - 1) * (0.5 + this.random() / 2);
  }

  private url(path: string, query?: RequestOptions['query']): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, String(v));
    const q = qs.toString();
    return `${this.base}${path.startsWith('/') ? path : `/${path}`}${q ? `?${q}` : ''}`;
  }

  private async buildHeaders(o: RequestOptions): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...o.headers,
      [CORRELATION_HEADER]: getCorrelationId() ?? randomUUID(),
    };
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    const mode = o.auth ?? this.opts.auth ?? 'forward';
    if (mode === 'forward') {
      const authorization = getAuthorization();
      if (authorization) headers.authorization = authorization;
    } else if (mode === 'service') {
      if (!this.opts.tokenProvider) throw new Error("auth: 'service' requires a tokenProvider");
      headers.authorization = `Bearer ${await this.opts.tokenProvider.getToken()}`;
    }
    return headers;
  }
}

function parseBody(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Network errors, timeouts and aborts from undici / fetch. */
function isTransport(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code ?? '';
  return (
    err.name === 'TimeoutError' ||
    err.name === 'AbortError' ||
    code.startsWith('UND_ERR') ||
    /^E[A-Z]+$/.test(code)
  );
}

export function createHttpClient(opts: HttpClientOptions): HttpClient {
  return new HttpClient(opts);
}
