import type { ZodObject, ZodRawShape, z } from 'zod';

export class ConfigValidationError extends Error {
  constructor(readonly issues: { key: string; message: string }[]) {
    super(
      `Invalid environment configuration:\n${issues.map((i) => `  - ${i.key}: ${i.message}`).join('\n')}`,
    );
    this.name = 'ConfigValidationError';
  }
}

/** Validates `env` against the schema; throws a readable ConfigValidationError listing bad keys. */
export function defineConfig<S extends ZodObject<ZodRawShape>>(
  schema: S,
  env: NodeJS.ProcessEnv = process.env,
): z.infer<S> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigValidationError(
      result.error.issues.map((i) => ({ key: i.path.join('.') || '(root)', message: i.message })),
    );
  }
  return result.data as z.infer<S>;
}
