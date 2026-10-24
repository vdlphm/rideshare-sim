/** Walks the `cause` chain (Drizzle wraps driver errors) for a Postgres unique violation. */
export function uniqueViolationConstraint(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; current && typeof current === 'object' && depth < 5; depth++) {
    const e = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (e.code === '23505') return typeof e.constraint === 'string' ? e.constraint : '';
    current = e.cause;
  }
  return undefined;
}
