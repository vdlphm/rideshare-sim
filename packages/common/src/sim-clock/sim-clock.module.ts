import { Module, type DynamicModule } from '@nestjs/common';
import { createHttpClient, TOKEN_PROVIDER, type TokenProvider } from '../http';
import { SimClock } from './sim-clock';

export interface SimClockModuleOptions {
  simulatorUrl: string;
  refreshMs?: number;
}

@Module({})
export class SimClockModule {
  /**
   * Picks up an optional TOKEN_PROVIDER (auth module, task 1.5) for service-to-service calls.
   * Without one the clock is fetched unauthenticated.
   */
  static forRoot(opts: SimClockModuleOptions): DynamicModule {
    return {
      module: SimClockModule,
      global: true,
      providers: [
        {
          provide: SimClock,
          inject: [{ token: TOKEN_PROVIDER, optional: true }],
          useFactory: (tokenProvider?: TokenProvider) => {
            const http = createHttpClient({
              baseUrl: opts.simulatorUrl,
              service: 'simulator',
              tokenProvider,
            });
            return new SimClock(http, {
              refreshMs: opts.refreshMs,
              auth: tokenProvider ? 'service' : 'none',
            });
          },
        },
      ],
      exports: [SimClock],
    };
  }
}
