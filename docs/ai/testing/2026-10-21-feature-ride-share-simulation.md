---
phase: testing
title: Testing Strategy
description: Define testing approach, test cases, and quality assurance
---

# Testing Strategy

## Test Coverage Goals

- Unit: 100% of pure domain logic (trip state machine, matching ranking/fallback, SimClock, geo interpolation, API contracts, auth token logic); ≥ 80% lines per service overall.
- Integration: each service against real Postgres/Redis via Testcontainers, with downstream services stubbed over HTTP — critical paths and error handling.
- End-to-end: full compose stack, simulator-driven trip reaches `COMPLETED`.
- Every acceptance criterion in the requirements doc maps to at least one test below.

## Unit Tests

### packages/common — SimClock
- [ ] Advances by `realDelta × speed`; frozen while paused
- [ ] Client extrapolates between `/internal/clock` fetches; corrects on new fetch (no backwards jumps); falls back to last value if simulator unreachable

### packages/common — HTTP client
- [ ] Forwards correlation id; retries idempotent calls on network error/5xx with backoff; no retry on 4xx; times out at 2 s

### packages/geo
- [ ] Polyline/GeoJSON decode round-trip
- [ ] `interpolateAlongRoute(geometry, durations, elapsed)` — start, mid-segment, end, elapsed > total clamps to end
- [ ] Random point stays within bbox; haversine against known distances

### packages/contracts
- [ ] Schemas accept valid payloads; reject out-of-range coordinates, unknown status, missing fields

### user (profiles + authentication)
- [ ] Register hashes password; duplicate email → 409; role `admin`/`service` not self-registrable
- [ ] Driver registration creates user + driver profile (vehicle) in one transaction; missing vehicle → 400; duplicate plate → 409
- [ ] `GET/PATCH /users/me` returns/updates only the caller's profile; riders cannot set vehicle
- [ ] `/internal/users/batch` returns display info for known ids, skips unknown
- [ ] Login wrong password → 401; tokens contain `sub`, `role`, `exp`
- [ ] Refresh rotates and revokes old token; reused revoked token → 401
- [ ] JWKS exposes public key that verifies issued tokens

### packages/common — auth module (AuthContextMiddleware, @CurrentUser, RolesGuard)
- [ ] Decodes bearer token → `request.user {id: sub, role, exp}` without verifying signature
- [ ] Missing / malformed token → `req.user = null`; `@Roles` route → 401; `@Public` route → allowed
- [ ] Wrong role → 403; matching role passes
- [ ] `/internal/*` with `@Roles('service')` rejects rider/driver tokens
- [ ] `@CurrentUser()` returns decoded user in a controller (tested via `Test.createTestingModule` + `supertest`)

### gateway — verification & route permissions
- [ ] Valid token proxied with original `Authorization` header
- [ ] Expired / bad signature / unknown `kid` → 401, not proxied
- [ ] Route-permission table: e.g. rider on `/api/sim/*` → 403; driver on `POST /api/offers/:id/accept` → proxied
- [ ] `/api/users` (register) and `/api/auth/login|refresh` allowed without token
- [ ] `/internal/*` paths → 404 from gateway
- [ ] JWKS cached; refetched on unknown `kid`

### trip — state machine
- [ ] Every valid transition succeeds (REQUESTED→MATCHED→ARRIVED→IN_PROGRESS→COMPLETED; REQUESTED→NO_DRIVERS; MATCHED→REQUESTED)
- [ ] Every invalid transition rejected (e.g., REQUESTED→IN_PROGRESS, COMPLETED→anything)
- [ ] Only assigned driver may arrive/start/complete
- [ ] Transition sets correct timestamps and records a `trip_events` row

### matching — algorithm
- [ ] Ranks candidates by ETA, not straight-line distance
- [ ] Excludes declined drivers and locked drivers
- [ ] Widens radius 1000→2000→4000 m when no candidates
- [ ] Gives up → no-drivers after max attempts / 60 sim-s
- [ ] Offer expiry measured in sim time (paused clock never expires)

### routing
- [ ] Cache key rounding; cache hit avoids OSRM call
- [ ] OSRM `NoRoute`/`NoSegment` → 422
- [ ] `nearest` snap farther than 150 m → 422; within 150 m → snapped point

### simulator
- [ ] Spawn scheduler honors interval in sim time; jitter bounded
- [ ] Driver bot state machine: idle → offered → accepted → to pickup → arrived → in trip → idle
- [ ] Accept probability 0 always declines; 1 always accepts
- [ ] Reducing driverCount retires only idle bots

## Integration Tests

- [ ] user: register → login → refresh → JWKS verify (Postgres container)
- [ ] db isolation: after `init.sql`, each service role can read/write its own schema and gets `permission denied` on the other schemas and `public`
- [ ] migrations: each service's migrations create tables only in its own schema; running one service's migrations doesn't touch others
- [ ] driver: live state keyed by JWT `sub`; location POST updates Redis hash; GEO set contains driver only while AVAILABLE; `nearby` returns closest-first within radius
- [ ] driver: `PUT /internal/drivers/:id/status` ON_TRIP removes from GEO, AVAILABLE re-adds; repeated call is no-op
- [ ] driver: going offline with a MATCHED trip calls Trip `unassign`
- [ ] driver: status change updates hash, GEO set and online set atomically (Lua); stale driver (no location 60 s) swept to OFFLINE
- [ ] driver/rider: live state survives Redis restart with AOF enabled
- [ ] redis isolation: with `users.acl`, each service user can read/write its own prefix and gets `NOPERM` on another service's prefix; `default` user rejected
- [ ] RedisModule: keys written via the client land under the configured prefix (incl. Lua `KEYS[]` and GEO commands); wrapped `SCAN` only returns own-prefix keys
- [ ] rider: location POST stores `rider:pos:{sub}` with TTL; ride request forwards the rider token to Trip; a `riderId` in the body is ignored/rejected
- [ ] trip: create trip takes `riderId` from forwarded token `sub`
- [ ] rider: ride request without `pickup` uses `rider:pos:{sub}`; no pickup and no position → 422
- [ ] driver: offline with `MATCHED` trip → Trip unassign → trip `REQUESTED` and rematched; offline with `ARRIVED`/`IN_PROGRESS` trip → 409
- [ ] trip: stats formulas (wait-to-match, wait-to-pickup, match rate) on a seeded set of trips
- [ ] compose: only gateway (8080) and web (5173) publish host ports; services unreachable from host
- [ ] driver: reconcile job fixes a driver stuck ON_TRIP with no active trip
- [ ] trip: create trip calls Routing (snap + route) and Matching `/internal/match`; Routing 422 → 422 to caller
- [ ] trip: concurrent `assign` for same trip with two drivers → exactly one 200, one 409 (optimistic version)
- [ ] trip: assigning a driver who already has an active trip → 409 (partial unique index)
- [ ] trip: Driver status call fails transiently → retried; trip state still committed
- [ ] matching: `/internal/match` called twice for same trip → one job (idempotent)
- [ ] matching: two trips racing for one driver → only one offer created (Redis lock)
- [ ] matching: restart with ACTIVE job → job resumes
- [ ] matching: decline → next candidate offered; timeout → next candidate offered
- [ ] matching: driver goes OFFLINE mid-offer → offer expires at timeout, next candidate offered; offline driver not in `nearby` results
- [ ] rider: second ride request while trip active → 409
- [ ] gateway: unauthenticated → 401; `/internal/*` not routable; correlation id propagated to downstream logs
- [ ] gateway WS: admin receives snapshot then diffs; non-admin token rejected; poller stops when no clients connected
- [ ] matching: `GET /offers/me` returns only the calling driver's pending offer
- [ ] routing: against OSRM container with the committed Seattle data — Pike Place → Space Needle returns geometry + per-segment durations; point in Elliott Bay (−122.3600, 47.6050) → 422 (nearest road ~1 km)

## End-to-End Tests

- [ ] Compose up → health of all services green → simulator with 10 drivers, 1 rider every 5 s, speed 10x → within 2 real minutes ≥ 3 trips `COMPLETED`
- [ ] Invariant check during E2E run: no driver ever has two non-terminal trips (query `trip_service.trips`)
- [ ] Admin click-to-add rider → trip appears and completes
- [ ] Pause → no location changes for 5 s; resume → movement continues
- [ ] Driver count 0 → new trips end `NO_DRIVERS`

## Test Data

- Fixed Seattle coordinates fixture (e.g., Pike Place Market, Space Needle, Pioneer Square, Capitol Hill/Broadway, Westlake Center) for routing and matching tests.
- Recorded OSRM responses for unit tests of routing wrapper (no OSRM needed).
- Testcontainers per suite; migrations run at container start; seeded admin + service client.
- HTTP stubs for downstream services (e.g., `undici` MockAgent) in per-service integration tests.
- Fake SimClock for deterministic time in matching/simulator unit tests.

## Test Reporting & Coverage

- `npm test` (workspace-wide Vitest), `npm run test:coverage` with v8 coverage; thresholds enforced per package in `vitest.config.ts`.
- `npm run test:integration` (requires Docker); `npm run test:e2e` (runs against compose).
- Gaps and rationale recorded here after the testing phase.

## Manual Testing

- UI: admin login (bad credentials message, token refresh keeps session alive past 15 min); drivers/riders/routes render; colors distinguish status; inspector + stats update; controls take effect; click-to-add flow (two clicks, cancel with Esc).
- Keyboard focus for controls; readable contrast; works in latest Chrome/Firefox/Safari.
- Smoke after `docker compose up` on a fresh clone (including OSRM prep).

## Performance Testing

- Simulator at 200 drivers, rider every 1 s, speed 5x for 10 min: gateway p95 < 100 ms for location POST; request→offer median < 1 s; UI ≥ 2 fps; gateway poller cycle stays < 250 ms.

## Bug Tracking

- Track in GitHub issues; severity: blocker (trip stuck / double assignment), major (UI desync), minor (visual).
- Every fixed bug gets a regression test at the lowest level that reproduces it.
