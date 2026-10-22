---
phase: requirements
title: Requirements & Problem Understanding
description: Clarify the problem space, gather requirements, and define success criteria
---

# Requirements & Problem Understanding

## Problem Statement

**What problem are we solving?**

- Ride-hailing platforms are a canonical distributed-systems problem: geo-indexing, real-time location streams, matching under contention, a long-lived trip state machine, and push updates to clients. Reading about these patterns is not the same as building and watching them work.
- This project is a **learning / portfolio** system: a locally runnable ride-share backend built as independent microservices, plus a live map simulation that makes the system's behavior visible (riders appearing, drivers being matched, cars driving real Seattle streets to pickup and dropoff).
- Audience: the author (learning) and reviewers of the portfolio (who should be able to `docker compose up` and watch it run).

## Goals & Objectives

**Primary goals**

- Backend as separate TypeScript/Node services, each owning its own data: **API Gateway, User, Rider, Driver, Trip, Matching, Routing**, plus a **Simulator** service.
- Each service owns its data: **User** holds all identity and profile data (and handles authentication) for riders, drivers and admins; **Rider** and **Driver** hold only live state — current position, status — in **Redis** and use it for matching and position streaming; Trip and Matching own their own Postgres schemas (PostGIS where location queries help); Redis also for caching and locks.
- A rider's or driver's ID is their **user ID** (from the User service), taken from the verified JWT (`sub`) — never supplied by the client.
- **HTTP-only communication** between services (public routes via the gateway, `/internal/*` routes service-to-service). No message broker until a concrete fan-out / async need appears.
- **Routing on real streets** via an OSRM container loaded with a downtown Seattle OSM extract (clipped from a Geofabrik Washington extract and committed to the repo), wrapped by the Routing service with a Redis cache.
- **Matching**: nearby available drivers (from the Driver service's Redis GEO index) → ranked by OSRM ETA → offer to best driver with accept timeout → fall back to next candidate.
- **Simulator bots call the real APIs**: bot drivers and riders register/log in through the User service, go online, stream GPS, request rides, accept offers, and move along OSRM route geometry.
- **Web UI** (map of downtown Seattle) showing drivers, riders, and their routes from request to completion, updated live over WebSocket.
- Whole stack starts with one `docker compose up`.

**Secondary goals**

- Structured JSON logs with a correlation ID propagated across service-to-service HTTP calls; `/health` on every service.
- Clean, readable code that demonstrates patterns: explicit trip state machine, distributed lock for offers, DB-enforced driver/rider exclusivity, idempotent internal endpoints with retries.

**Non-goals (out of scope)**

- Message broker / event-driven messaging (Kafka, Redpanda, etc.) — removed by user decision; revisit only when a real use case appears.
- Pricing, fares, surge, payments.
- Real mobile apps or real user sign-up flows beyond what bots and the admin UI need.
- Full observability stack (OpenTelemetry, Prometheus, Grafana) — may be added later.
- Cloud / Kubernetes deployment, horizontal autoscaling, multi-region.
- Ride pooling, scheduled rides, ratings, cancellations-with-fees.
- Multiple countries / regions, country fields in data, and cross-border rider travel — deferred (single city: Seattle). Kept open by design: identity is global (tokens not tied to a location) and timestamps are UTC.
- Production-grade security hardening (secrets management, rate limiting beyond basics).

## User Stories & Use Cases

**Viewer / operator (admin UI)**

- As a viewer, I want to log in to the admin UI with the seeded admin account (credentials documented in the README) so that only admins can control the simulation.
- As a viewer, I want to see a map of downtown Seattle with all online drivers and waiting riders so I can understand the system state at a glance.
- As a viewer, I want new riders to appear at random pickup points with random dropoffs at a configurable spawn rate (in sim time).
- As a viewer, I want to set the number of online driver bots so I can observe supply/demand effects.
- As a viewer, I want to click the map twice (pickup, then dropoff) to create a specific rider.
- As a viewer, I want to change simulation speed (pause, 1x–10x) so trips don't take real-world minutes.
- As a viewer, I want to watch a matched driver drive the route to the pickup, then to the dropoff, with the route drawn on the map.
- As a viewer, I want to click a driver or rider to inspect the trip: state, route, ETA, timeline of state changes.
- As a viewer, I want a stats panel: online/available drivers, waiting riders, active trips, completed trips, average wait-to-match and wait-to-pickup time (sim time), match success rate.

**Bot rider (simulator, via API)**

- Registers/logs in as role `rider` (profile stored in User service), posts its current position, requests a ride with pickup/dropoff, polls for match and status updates, is picked up and dropped off.

**Bot driver (simulator, via API)**

- Registers/logs in as role `driver` (profile + vehicle stored in User service), goes online, streams location every tick, polls for trip offers and accepts (configurable acceptance probability), follows route to pickup and dropoff, reports pickup/dropoff, becomes available again.

**Key workflow (happy path)**

1. Rider requests ride → Trip created `REQUESTED` → Trip asks Matching (HTTP) to find a driver.
2. Matching finds candidates (Redis GEO), ranks by OSRM ETA, offers to best driver (lock driver in Redis).
3. Driver accepts → Trip `MATCHED` (driver en route to pickup) → `ARRIVED` → `IN_PROGRESS` → `COMPLETED`.
4. Driver becomes available; UI shows every transition live.

**Edge cases**

- No drivers within search radius → widen radius in steps; after max attempts/time trip becomes `NO_DRIVERS` (rider bot may retry).
- Driver declines or offer times out → next candidate; declined driver not re-offered the same trip.
- Two trips race for the same driver → only one offer lock wins.
- Driver goes offline mid-offer → removed from the available set immediately; the pending offer expires at its timeout and matching moves to the next candidate (no push from Driver to Matching).
- Pickup/dropoff not routable (e.g., clicked in Elliott Bay or Lake Union) → snap to nearest road via OSRM; reject if no road within 150 m.
- Driver goes offline with a `MATCHED` trip → trip returns to `REQUESTED` and is rematched.
- Service restart mid-trip → state recoverable from Trip DB; internal endpoints idempotent so callers can retry safely.
- Sim paused → bots stop moving and offer timeouts are measured in sim time.

## Success Criteria

**Acceptance criteria**

- `docker compose up` starts all services, infra, and UI with no manual steps and no network download for map data (OSRM graph built automatically from the committed Seattle extract); UI reachable on `http://localhost:5173` (or documented port).
- With default settings (e.g., 50 drivers, 1 rider every 3 sim-seconds), the UI shows riders spawning and trips progressing through every state to `COMPLETED` on real Seattle streets.
- **One Postgres database with a schema per service** (`user_service`, `trip_service`, `matching_service`); each service connects with its own role that can only access its own schema, so no service can read another service's tables (enforced, verified by test). Same for Redis: **one instance, one key prefix per service** (`rider:`, `driver:`, `matching:`, `routing:`) with a per-service ACL user restricted to its prefix, so each service can later move to its own Redis by changing only its connection URL. Rider/driver profile data exists only in the User service.
- Services communicate only over HTTP (no broker); every internal call is documented in the design.
- Every API except register, login, refresh, JWKS and health requires a valid JWT, verified once at the gateway; services decode the token through one shared decorator and never re-verify; only the gateway and web UI ports are reachable from the host. Role checks enforced (e.g., only drivers accept offers, only admin controls sim). Rider/driver IDs are always taken from the token; a request body cannot act on behalf of another user (verified by test).
- A driver is never assigned to two active trips at once (verified by test).
- Offer timeout and decline fall back to the next candidate (verified by test).
- Clicking a vehicle shows its current trip state and route; stats panel updates live.
- Sim speed and pause visibly affect movement.

**Performance benchmarks (local laptop)**

- Sustain 200 online drivers and 100 concurrent trips without UI lag (UI updates ≥ 2 fps on map).
- Median time from ride request to offer sent < 1 s (sim time excluded).
- Route requests for repeated origin/destination pairs served from cache.

## Constraints & Assumptions

**Technical constraints**

- TypeScript on Node 22; backend services in **NestJS** (default Express platform), UI in React; monorepo.
- Docker Compose for local orchestration; must run on a macOS laptop (Docker Desktop, ~8 GB RAM available to Docker).
- Map tiles from a free source (OSM tiles at low volume or a free MapLibre style) — acceptable for local/demo use only.

**Assumptions (named, overridable)**

- **A1** No message broker (user decision 2026-10-21). Live UI updates come from the gateway polling services and pushing over WebSocket; bots poll for offers/trip state.
- **A2** Scale target ~200 drivers / ~100 concurrent trips.
- **A3** UI uses **React + Vite + MapLibre GL**.
- **A4** Map data: Geofabrik `washington-latest.osm.pbf` (2023-10-23) clipped to a Seattle bbox (lng −122.42…−122.27, lat 47.57…47.67, ~10 MB) and committed; spawns limited to downtown (~3×4 km); OSRM `car` profile. Data age is acceptable for simulation.
- **A5** Simulation time is controlled centrally by the Simulator; bots compute movement from route geometry and sim speed rather than real GPS.
- **A6** Single instance of each service. Matching runs jobs in-process, so scaling it out (job leasing) is out of scope.
- **A7** Admin UI logs in as a seeded `admin` user.
- **A8** Rider/Driver live state is Redis-only (AOF on); no location history is persisted.

## Questions & Open Items

- None blocking. Assumptions A1–A8 are accepted for design; revisit A3 if the user prefers alternatives.
- Deferred: message broker; multi-country/regions; location history; full observability stack; pricing; cancellations by rider/driver mid-trip (beyond offline/timeout handling).
