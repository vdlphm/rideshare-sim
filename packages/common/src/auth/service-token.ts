import { Module, type DynamicModule } from '@nestjs/common';
import type { Dispatcher } from 'undici';
import { z } from 'zod';
import { HttpClient, TOKEN_PROVIDER, type TokenProvider } from '../http/http-client';

export interface ServiceTokenOptions {
  userServiceUrl: string;
  clientId: string;
  clientSecret: string;
  /** Refresh when less than this much validity remains. Default 60 000 ms. */
  refreshSkewMs?: number;
  /** Injectable clock (ms since epoch) for tests. */
  now?: () => number;
  /** undici dispatcher (MockAgent in tests). */
  dispatcher?: Dispatcher;
}

const TokenResponse = z.object({ accessToken: z.string().min(1), expiresIn: z.number() });

/** Client-credentials token for system calls; cached, refreshed early, one in-flight refresh. */
export class ServiceTokenProvider implements TokenProvider {
  private readonly http: HttpClient;
  private readonly skewMs: number;
  private readonly now: () => number;
  private token?: { value: string; expiresAt: number };
  private inflight?: Promise<string>;

  constructor(private readonly opts: ServiceTokenOptions) {
    this.http = new HttpClient({
      baseUrl: opts.userServiceUrl,
      service: 'user-service',
      auth: 'none',
      dispatcher: opts.dispatcher,
    });
    this.skewMs = opts.refreshSkewMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  getToken(): Promise<string> {
    if (this.token && this.token.expiresAt - this.now() >= this.skewMs) {
      return Promise.resolve(this.token.value);
    }
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async refresh(): Promise<string> {
    const res = await this.http.post('/auth/token', {
      body: { clientId: this.opts.clientId, clientSecret: this.opts.clientSecret },
      schema: TokenResponse,
      auth: 'none',
      idempotent: true,
    });
    this.token = { value: res.accessToken, expiresAt: this.now() + res.expiresIn * 1000 };
    return res.accessToken;
  }
}

@Module({})
export class ServiceTokenModule {
  static register(opts: ServiceTokenOptions): DynamicModule {
    return {
      module: ServiceTokenModule,
      // Global: an app has one service identity, and modules without imports (e.g. SimClockModule)
      // must be able to inject TOKEN_PROVIDER.
      global: true,
      providers: [{ provide: TOKEN_PROVIDER, useValue: new ServiceTokenProvider(opts) }],
      exports: [TOKEN_PROVIDER],
    };
  }
}
