import { makeConfig } from './vitest.shared';

export default makeConfig({
  include: ['{apps,packages}/**/*.spec.ts'],
  exclude: ['**/*.int.spec.ts', '**/*.e2e.spec.ts'],
});
