import { makeConfig } from './vitest.shared';

export default makeConfig({ include: ['{apps,packages,tests}/**/*.e2e.spec.ts'] });
