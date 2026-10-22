import { Module, type DynamicModule } from '@nestjs/common';
import type { DestinationStream } from 'pino';
import { LoggerModule } from 'nestjs-pino';
import type { Options } from 'pino-http';
import { ConfigService, type BaseEnv } from '../config';
import { CorrelationModule, getCorrelationId } from '../correlation';

@Module({})
export class LoggingModule {
  /** Requires ConfigModule.forRoot with a schema extending baseEnvSchema. */
  static forRoot(opts: { stream?: DestinationStream } = {}): DynamicModule {
    return {
      module: LoggingModule,
      imports: [
        // Mounted first so the correlation context exists before pino-http runs.
        CorrelationModule,
        LoggerModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (config: ConfigService<BaseEnv>) => {
            const options: Options = {
              level: config.get('LOG_LEVEL'),
              base: { service: config.get('SERVICE_NAME') },
              mixin: () => ({ correlationId: getCorrelationId() }),
              redact: {
                paths: ['req.headers.authorization', 'req.headers.cookie'],
                censor: '[Redacted]',
              },
            };
            return { pinoHttp: opts.stream ? [options, opts.stream] : options };
          },
        }),
      ],
      exports: [LoggerModule],
    };
  }
}
