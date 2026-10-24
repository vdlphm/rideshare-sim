import { makeConfig } from './vitest.shared';

export default makeConfig({
  include: ['{apps,packages,tests}/**/*.e2e.spec.ts'],
  // Each e2e file starts a full compose stack; running them in parallel exhausts the Docker VM
  // on a laptop (observed stalls), so run one stack at a time.
  fileParallelism: false,
});
