import { resolve } from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig, type ViteUserConfig } from 'vitest/config';

const ignored = ['**/node_modules/**', '**/dist/**'];

export function makeConfig(opts: { include: string[]; exclude?: string[] }): ViteUserConfig {
  return defineConfig({
    // SWC emits decorator metadata, which NestJS DI needs (esbuild does not).
    plugins: [
      swc.vite({
        module: { type: 'es6' },
        jsc: {
          target: 'es2022',
          parser: { syntax: 'typescript', decorators: true },
          transform: { legacyDecorator: true, decoratorMetadata: true },
        },
      }),
    ],
    // Resolve workspace packages from source so tests need no prior build.
    resolve: {
      alias: [
        {
          find: /^@rideshare\/([^/]+)$/,
          replacement: resolve(__dirname, 'packages/$1/src/index.ts'),
        },
      ],
    },
    test: {
      globals: false,
      environment: 'node',
      include: opts.include,
      exclude: [...ignored, ...(opts.exclude ?? [])],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'lcov'],
        include: ['apps/*/src/**/*.ts', 'packages/*/src/**/*.ts'],
        exclude: ['**/*.spec.ts', '**/dist/**'],
      },
    },
  });
}
