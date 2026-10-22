import { Module, type DynamicModule, type InjectionToken } from '@nestjs/common';
import { HttpClient, createHttpClient, type HttpClientOptions } from './http-client';

@Module({})
export class HttpClientModule {
  /**
   * Registers an HttpClient under `token` (default: the HttpClient class), e.g.
   * `HttpClientModule.register({ baseUrl, service: 'pricing' }, PRICING_CLIENT)`.
   * Pass a TokenProvider via `tokenProvider` (task 1.5 will supply a Nest-injected one).
   */
  static register(opts: HttpClientOptions, token: InjectionToken = HttpClient): DynamicModule {
    return {
      module: HttpClientModule,
      providers: [{ provide: token, useFactory: () => createHttpClient(opts) }],
      exports: [token],
    };
  }
}
