/**
 * The gateway's route table: the single source of truth for what is reachable from outside and
 * who may call it. Order matters (first match wins). Anything not matched is a 404, and anything
 * with an `internal` path segment is rejected before the table is consulted.
 */

export type Role = 'rider' | 'driver' | 'admin';
export const ROLES: readonly string[] = ['rider', 'driver', 'admin', 'service'];

export type ServiceName =
  'user' | 'rider' | 'driver' | 'trip' | 'matching' | 'routing' | 'simulator';

export type Access = 'public' | readonly Role[];

export interface RouteRule {
  /** HTTP methods, or '*' for any. */
  methods: readonly string[] | '*';
  /** Path pattern: literal segments, `:param` (exactly one segment) and a trailing `**` (zero or more). */
  pattern: string;
  service: ServiceName;
  access: Access;
  /** Prefix removed from the path before forwarding (default `/api`). */
  strip?: string;
}

const ANY_USER: readonly Role[] = ['rider', 'driver', 'admin'];

export const ROUTES: readonly RouteRule[] = [
  // user service
  { methods: ['POST'], pattern: '/api/users', service: 'user', access: 'public' },
  { methods: ['POST'], pattern: '/api/auth/login', service: 'user', access: 'public' },
  { methods: ['POST'], pattern: '/api/auth/refresh', service: 'user', access: 'public' },
  // NOTE: POST /api/auth/token (service tokens) is deliberately absent: it is not exposed.
  { methods: ['GET', 'PATCH'], pattern: '/api/users/me', service: 'user', access: ANY_USER },
  { methods: ['GET'], pattern: '/api/users/:id', service: 'user', access: ['admin'] },
  // rider / driver / matching
  { methods: '*', pattern: '/api/riders/**', service: 'rider', access: ['rider'] },
  { methods: '*', pattern: '/api/drivers/**', service: 'driver', access: ['driver'] },
  { methods: '*', pattern: '/api/offers/**', service: 'matching', access: ['driver'] },
  // trip
  { methods: ['GET'], pattern: '/api/trips', service: 'trip', access: ['admin'] },
  { methods: ['GET'], pattern: '/api/trips/stats', service: 'trip', access: ['admin'] },
  { methods: ['GET'], pattern: '/api/trips/:id', service: 'trip', access: ANY_USER },
  {
    methods: ['POST'],
    pattern: '/api/trips/:id/arrive',
    service: 'trip',
    access: ['driver'],
  },
  { methods: ['POST'], pattern: '/api/trips/:id/start', service: 'trip', access: ['driver'] },
  { methods: ['POST'], pattern: '/api/trips/:id/complete', service: 'trip', access: ['driver'] },
  // admin-only debug / simulator
  {
    methods: '*',
    pattern: '/api/routing/**',
    service: 'routing',
    access: ['admin'],
    strip: '/api/routing',
  },
  { methods: '*', pattern: '/api/sim/**', service: 'simulator', access: ['admin'] },
];

export interface ResolvedRoute {
  rule: RouteRule;
  service: ServiceName;
  access: Access;
  /** Normalised, re-encoded path to request upstream (query string not included). */
  upstreamPath: string;
}

/**
 * Splits and canonicalises a raw request path. Returns null when the path is not acceptable:
 * malformed or ambiguous encodings, dot segments, backslashes, empty segments, NULs and any
 * `internal` segment. Rejecting (rather than "fixing") means the table and the upstream can
 * never disagree about what a path means.
 */
export function normalizePath(rawPath: string): string[] | null {
  if (!rawPath.startsWith('/')) return null;
  if (rawPath.includes('\\') || rawPath.includes(';')) return null;
  const rawSegments = rawPath.slice(1).split('/');
  // A single trailing slash is tolerated.
  if (rawSegments.length > 1 && rawSegments[rawSegments.length - 1] === '') rawSegments.pop();
  const out: string[] = [];
  for (const raw of rawSegments) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (seg === '' && rawSegments.length > 1) return null;
    // After one decode a segment must not hide a slash, backslash, NUL, control char, dot
    // segment or a second layer of percent-encoding.
    // eslint-disable-next-line no-control-regex
    if (/[/\\\x00-\x1f\x7f%;]/.test(seg)) return null;
    if (seg === '.' || seg === '..') return null;
    if (seg.toLowerCase() === 'internal') return null;
    out.push(seg);
  }
  return out;
}

function matchPattern(pattern: string, segments: string[]): boolean {
  const pat = pattern.slice(1).split('/');
  const rest = pat[pat.length - 1] === '**';
  const fixed = rest ? pat.slice(0, -1) : pat;
  if (rest ? segments.length < fixed.length : segments.length !== fixed.length) return false;
  return fixed.every((p, i) => p.startsWith(':') || p === segments[i]);
}

export function resolveRoute(
  method: string,
  rawPath: string,
  table: readonly RouteRule[] = ROUTES,
): ResolvedRoute | null {
  const segments = normalizePath(rawPath);
  if (!segments) return null;
  const m = method.toUpperCase();
  for (const rule of table) {
    if (rule.methods !== '*' && !rule.methods.includes(m)) continue;
    if (!matchPattern(rule.pattern, segments)) continue;
    const strip = (rule.strip ?? '/api').slice(1).split('/').length;
    const upstream = '/' + segments.slice(strip).map(encodeURIComponent).join('/');
    return { rule, service: rule.service, access: rule.access, upstreamPath: upstream };
  }
  return null;
}

/** True when `roles` (from a verified token) satisfies the route. `service` never does. */
export function isAllowed(access: Access, role: string): boolean {
  return access === 'public' || (access as readonly string[]).includes(role);
}
