import { makeConfig } from './vitest.shared';

export default makeConfig({
  include: ['{apps,packages}/**/*.int.spec.ts', 'tests/**/*.int.spec.ts'],
});
