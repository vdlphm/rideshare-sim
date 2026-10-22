import { Global, Inject, Injectable, Module, type DynamicModule } from '@nestjs/common';
import type { ZodObject, ZodRawShape } from 'zod';
import { defineConfig } from './define-config';

export const CONFIG_VALUES = Symbol('CONFIG_VALUES');

/** Injects the whole validated config object: `@InjectConfig() cfg: AppConfig`. */
export const InjectConfig = (): ParameterDecorator => Inject(CONFIG_VALUES);

@Injectable()
export class ConfigService<T extends object = Record<string, unknown>> {
  constructor(@Inject(CONFIG_VALUES) readonly values: T) {}

  get<K extends keyof T>(key: K): T[K] {
    return this.values[key];
  }
}

@Global()
@Module({})
export class ConfigModule {
  /** Validates process.env at module creation (startup) and fails fast. */
  static forRoot<S extends ZodObject<ZodRawShape>>(opts: {
    schema: S;
    env?: NodeJS.ProcessEnv;
  }): DynamicModule {
    const values = defineConfig(opts.schema, opts.env);
    return {
      module: ConfigModule,
      providers: [{ provide: CONFIG_VALUES, useValue: values }, ConfigService],
      exports: [CONFIG_VALUES, ConfigService],
    };
  }
}
