import { describe, expect, it } from 'vitest';
import {
  ACTIVE_TRIP_STATUSES,
  AcceptOfferResponseSchema,
  AddRiderRequestSchema,
  AssignTripRequestSchema,
  ClockStateSchema,
  CreateTripRequestSchema,
  DriverLocationUpdateSchema,
  DriverStateSchema,
  DriverStatusSchema,
  DriverStatusUpdateSchema,
  ErrorResponseSchema,
  GoOnlineRequestSchema,
  HeadingSchema,
  JwtClaimsSchema,
  LatLngSchema,
  LoginRequestSchema,
  MatchRequestSchema,
  NON_TERMINAL_TRIP_STATUSES,
  NearbyDriverSchema,
  NearbyDriversQuerySchema,
  NearestQuerySchema,
  NearestResultSchema,
  OfferSchema,
  OfferStatusSchema,
  RefreshRequestSchema,
  RegisterRequestSchema,
  RideRequestResponseSchema,
  RideRequestSchema,
  RiderLocationUpdateSchema,
  RiderPositionSchema,
  RoleSchema,
  RouteQuerySchema,
  RouteSchema,
  ServiceTokenRequestSchema,
  ServiceTokenResponseSchema,
  SimConfigSchema,
  SimConfigUpdateSchema,
  SimTimeSchema,
  TableRequestSchema,
  TableResponseSchema,
  TokenPairSchema,
  TripDetailSchema,
  TripEventSchema,
  TripSchema,
  TripStatsSchema,
  TripStatusSchema,
  UpdateMeRequestSchema,
  UserDisplaySchema,
  UserMeSchema,
  UsersBatchRequestSchema,
  UuidSchema,
} from '../src';

const id = '3b241101-e2bb-4255-8caf-4136c566a962';
const id2 = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
const p = { lat: 10.78, lng: 106.7 };
const q = { lat: 10.8, lng: 106.72 };
const vehicle = { make: 'Toyota', model: 'Vios', color: 'white', plate: '51A-12345' };
const route = {
  distanceM: 1000,
  durationS: 120,
  geometry: [
    [106.7, 10.78],
    [106.71, 10.79],
    [106.72, 10.8],
  ],
  durations: [60, 60],
};
const trip = {
  id,
  riderId: id2,
  driverId: null,
  status: 'REQUESTED',
  pickup: p,
  dropoff: q,
  tripRoute: route,
  pickupRoute: null,
  estDistanceM: 1000,
  estDurationS: 120,
  requestedAt: 0,
  matchedAt: null,
  arrivedAt: null,
  startedAt: null,
  completedAt: null,
  endedReason: null,
};
const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) =>
  expect(s.safeParse(v).success).toBe(true);
const bad = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) =>
  expect(s.safeParse(v).success).toBe(false);

describe('common', () => {
  it('validates LatLng ranges', () => {
    ok(LatLngSchema, p);
    ok(LatLngSchema, { lat: -90, lng: 180 });
    bad(LatLngSchema, { lat: 91, lng: 0 });
    bad(LatLngSchema, { lat: 0, lng: -181 });
    bad(LatLngSchema, { lat: 0 });
    bad(LatLngSchema, { lat: '1', lng: 0 });
  });
  it('validates Heading, Uuid, SimTime', () => {
    ok(HeadingSchema, 0);
    ok(HeadingSchema, 359.9);
    bad(HeadingSchema, 360);
    bad(HeadingSchema, -1);
    ok(UuidSchema, id);
    bad(UuidSchema, 'nope');
    ok(SimTimeSchema, 0);
    bad(SimTimeSchema, -1);
  });
  it('validates enums', () => {
    ok(RoleSchema, 'service');
    bad(RoleSchema, 'root');
    ok(TripStatusSchema, 'NO_DRIVERS');
    bad(TripStatusSchema, 'CANCELLED');
    ok(DriverStatusSchema, 'ON_TRIP');
    bad(DriverStatusSchema, 'BUSY');
    ok(OfferStatusSchema, 'EXPIRED');
    bad(OfferStatusSchema, 'WAT');
  });
  it('exposes status helpers', () => {
    expect(ACTIVE_TRIP_STATUSES).toEqual(['MATCHED', 'ARRIVED', 'IN_PROGRESS']);
    expect(NON_TERMINAL_TRIP_STATUSES).toEqual(['REQUESTED', 'MATCHED', 'ARRIVED', 'IN_PROGRESS']);
  });
});

describe('user', () => {
  const rider = { email: 'a@b.com', password: 'password1', name: 'A', role: 'rider' };
  it('accepts rider and driver registration', () => {
    ok(RegisterRequestSchema, rider);
    ok(RegisterRequestSchema, { ...rider, phone: '+84901234567' });
    ok(RegisterRequestSchema, { ...rider, role: 'driver', vehicle });
  });
  it('rejects bad registrations', () => {
    bad(RegisterRequestSchema, { ...rider, role: 'admin' });
    bad(RegisterRequestSchema, { ...rider, role: 'service' });
    bad(RegisterRequestSchema, { ...rider, role: 'driver' });
    bad(RegisterRequestSchema, { ...rider, password: 'short' });
    bad(RegisterRequestSchema, { ...rider, email: 'x' });
    bad(RegisterRequestSchema, { ...rider, phone: '0901234567' });
    bad(RegisterRequestSchema, { ...rider, extra: 1 });
    bad(RegisterRequestSchema, { email: 'a@b.com' });
  });
  it('validates auth payloads', () => {
    ok(LoginRequestSchema, { email: 'a@b.com', password: 'x' });
    bad(LoginRequestSchema, { email: 'a@b.com' });
    ok(TokenPairSchema, { accessToken: 'a', refreshToken: 'b' });
    bad(TokenPairSchema, { accessToken: 'a' });
    ok(RefreshRequestSchema, { refreshToken: 'b' });
    ok(ServiceTokenRequestSchema, { clientId: 'c', clientSecret: 's' });
    bad(ServiceTokenRequestSchema, { clientId: 'c' });
    ok(ServiceTokenResponseSchema, { accessToken: 'a', expiresIn: 900 });
    bad(ServiceTokenResponseSchema, { accessToken: 'a', expiresIn: -1 });
  });
  it('validates profile payloads', () => {
    ok(UserMeSchema, { id, email: 'a@b.com', name: 'A', role: 'driver', vehicle });
    ok(UserMeSchema, { id, email: 'a@b.com', name: 'A', role: 'rider', phone: null });
    bad(UserMeSchema, { id, email: 'a@b.com', name: 'A' });
    ok(UpdateMeRequestSchema, { name: 'B' });
    ok(UpdateMeRequestSchema, { vehicle, phone: '+14155550123' });
    bad(UpdateMeRequestSchema, {});
    bad(UpdateMeRequestSchema, { name: 'B', role: 'admin' });
    ok(UserDisplaySchema, { id, name: 'A', role: 'driver', vehicle });
    ok(UserDisplaySchema, { id, name: 'A', role: 'rider' });
    bad(UserDisplaySchema, { id, name: 'A' });
  });
  it('validates batch and claims', () => {
    ok(UsersBatchRequestSchema, { ids: [id] });
    bad(UsersBatchRequestSchema, { ids: [] });
    bad(UsersBatchRequestSchema, { ids: ['x'] });
    bad(UsersBatchRequestSchema, { ids: Array.from({ length: 501 }, () => id) });
    ok(UsersBatchRequestSchema, { ids: Array.from({ length: 500 }, () => id) });
    ok(JwtClaimsSchema, { sub: id, role: 'rider', iat: 1, exp: 2 });
    ok(JwtClaimsSchema, { sub: 'matching-svc', role: 'service', iat: 1, exp: 2 });
    bad(JwtClaimsSchema, { sub: id, role: 'rider', iat: 1 });
    bad(JwtClaimsSchema, { sub: id, role: 'nope', iat: 1, exp: 2 });
  });
});

describe('rider', () => {
  it('validates rider payloads', () => {
    ok(RiderLocationUpdateSchema, p);
    bad(RiderLocationUpdateSchema, { lat: 100, lng: 0 });
    ok(RiderPositionSchema, { riderId: id, ...p, ts: 5 });
    bad(RiderPositionSchema, { ...p, ts: 5 });
    ok(RideRequestSchema, { dropoff: q });
    ok(RideRequestSchema, { pickup: p, dropoff: q });
    bad(RideRequestSchema, { pickup: p });
    bad(RideRequestSchema, { dropoff: { lat: 99, lng: 0 } });
    ok(RideRequestResponseSchema, { tripId: id });
    bad(RideRequestResponseSchema, { tripId: 'x' });
  });
  it('rejects acting on behalf of another user', () => {
    expect(() => RideRequestSchema.parse({ dropoff: q, riderId: id })).toThrow();
    expect(() => CreateTripRequestSchema.parse({ pickup: p, dropoff: q, riderId: id })).toThrow();
  });
});

describe('driver', () => {
  it('validates driver payloads', () => {
    ok(GoOnlineRequestSchema, p);
    ok(DriverLocationUpdateSchema, { ...p, heading: 90 });
    bad(DriverLocationUpdateSchema, { ...p, heading: 360 });
    bad(DriverLocationUpdateSchema, p);
    const state = { driverId: id, status: 'AVAILABLE', tripId: null, ...p, heading: 0, ts: 1 };
    ok(DriverStateSchema, state);
    ok(DriverStateSchema, { ...state, tripId: id2 });
    bad(DriverStateSchema, { ...state, status: 'BUSY' });
    bad(DriverStateSchema, { ...state, tripId: undefined });
    ok(NearbyDriverSchema, { driverId: id, ...p, distanceM: 10 });
    bad(NearbyDriverSchema, { driverId: id, ...p });
    ok(DriverStatusUpdateSchema, { status: 'ON_TRIP', tripId: id });
    ok(DriverStatusUpdateSchema, { status: 'OFFLINE', tripId: null });
    bad(DriverStatusUpdateSchema, { status: 'OFFLINE' });
  });
  it('coerces nearby query strings', () => {
    const r = NearbyDriversQuerySchema.parse({
      lat: '10.5',
      lng: '106.5',
      radiusM: '500',
      limit: '5',
    });
    expect(r).toEqual({ lat: 10.5, lng: 106.5, radiusM: 500, limit: 5 });
    bad(NearbyDriversQuerySchema, { lat: '10', lng: '106', radiusM: '0', limit: '5' });
    bad(NearbyDriversQuerySchema, { lat: '10', lng: '106', radiusM: '10001', limit: '5' });
    bad(NearbyDriversQuerySchema, { lat: '10', lng: '106', radiusM: '5', limit: '51' });
    bad(NearbyDriversQuerySchema, { lat: '10', lng: '106', radiusM: '5', limit: '1.5' });
    bad(NearbyDriversQuerySchema, { lat: '95', lng: '106', radiusM: '5', limit: '5' });
    bad(NearbyDriversQuerySchema, { lat: 'abc', lng: '106', radiusM: '5', limit: '5' });
  });
});

describe('routing', () => {
  it('validates route query/table/nearest', () => {
    ok(RouteQuerySchema, { from: p, to: q });
    bad(RouteQuerySchema, { from: p });
    ok(TableRequestSchema, { sources: [p], destinations: [p, q] });
    bad(TableRequestSchema, { sources: [], destinations: [p] });
    bad(TableRequestSchema, { sources: [p], destinations: Array.from({ length: 26 }, () => p) });
    ok(TableResponseSchema, { durations: [[1, null]] });
    bad(TableResponseSchema, { durations: [['x']] });
    expect(NearestQuerySchema.parse({ lat: '1', lng: '2' })).toEqual({ lat: 1, lng: 2 });
    bad(NearestQuerySchema, { lat: '1', lng: '200' });
    ok(NearestResultSchema, { ...p, distanceM: 3 });
    bad(NearestResultSchema, p);
  });
  it('validates Route and its durations refinement', () => {
    ok(RouteSchema, route);
    bad(RouteSchema, { ...route, durations: [60] });
    bad(RouteSchema, { ...route, durations: [60, 60, 60] });
    bad(RouteSchema, { ...route, geometry: [[106.7, 10.78]], durations: [] });
    bad(RouteSchema, { ...route, geometry: [[10.78, 106.7], ...route.geometry.slice(1)] });
    bad(RouteSchema, { ...route, distanceM: undefined });
  });
});

describe('trip', () => {
  it('validates trip payloads', () => {
    ok(CreateTripRequestSchema, { pickup: p, dropoff: q });
    bad(CreateTripRequestSchema, { pickup: p });
    ok(TripSchema, trip);
    ok(TripSchema, {
      ...trip,
      status: 'MATCHED',
      driverId: id,
      pickupRoute: route,
      matchedAt: 5,
    });
    bad(TripSchema, { ...trip, status: 'LOST' });
    bad(TripSchema, { ...trip, requestedAt: -1 });
    bad(TripSchema, { ...trip, riderId: undefined });
    const event = {
      fromStatus: null,
      toStatus: 'REQUESTED',
      atSim: 0,
      atReal: '2026-10-21T10:00:00.000Z',
      meta: {},
    };
    ok(TripEventSchema, event);
    ok(TripEventSchema, { ...event, fromStatus: 'REQUESTED', toStatus: 'MATCHED', meta: { a: 1 } });
    bad(TripEventSchema, { ...event, atReal: 'yesterday' });
    ok(TripDetailSchema, { ...trip, events: [event] });
    bad(TripDetailSchema, trip);
    const driverPosition = { lat: 47.6, lng: -122.3 };
    ok(AssignTripRequestSchema, { driverId: id, offerId: id2, driverPosition });
    bad(AssignTripRequestSchema, { driverId: id, offerId: id2 });
    bad(AssignTripRequestSchema, { driverId: id, driverPosition });
    bad(AssignTripRequestSchema, {
      driverId: id,
      offerId: id2,
      driverPosition: { lat: 91, lng: 0 },
    });
    const stats = {
      waitingRiders: 0,
      activeTrips: 1,
      completedTrips: 2,
      noDriverTrips: 0,
      avgWaitToMatchS: null,
      avgWaitToPickupS: 3.5,
      matchRate: 0.5,
    };
    ok(TripStatsSchema, stats);
    bad(TripStatsSchema, { ...stats, matchRate: 1.5 });
    bad(TripStatsSchema, { ...stats, waitingRiders: -1 });
  });
});

describe('matching', () => {
  it('validates matching payloads', () => {
    ok(MatchRequestSchema, { tripId: id, pickup: p });
    bad(MatchRequestSchema, { tripId: id });
    const offer = {
      id,
      tripId: id2,
      driverId: id,
      status: 'PENDING',
      etaS: 30,
      attempt: 1,
      expiresSim: 15000,
      pickup: p,
      dropoff: q,
    };
    ok(OfferSchema, offer);
    bad(OfferSchema, { ...offer, status: 'MAYBE' });
    bad(OfferSchema, { ...offer, attempt: 0 });
    bad(OfferSchema, { ...offer, dropoff: undefined });
    ok(AcceptOfferResponseSchema, { tripId: id });
    bad(AcceptOfferResponseSchema, {});
  });
});

describe('sim', () => {
  const cfg = {
    driverCount: 20,
    spawnIntervalS: 5,
    speed: 1,
    paused: false,
    acceptProbability: 0.8,
  };
  it('validates SimConfig', () => {
    ok(SimConfigSchema, cfg);
    bad(SimConfigSchema, { ...cfg, driverCount: 501 });
    bad(SimConfigSchema, { ...cfg, driverCount: 1.5 });
    bad(SimConfigSchema, { ...cfg, spawnIntervalS: 0 });
    bad(SimConfigSchema, { ...cfg, speed: 11 });
    bad(SimConfigSchema, { ...cfg, acceptProbability: 1.1 });
    bad(SimConfigSchema, { ...cfg, paused: 'no' });
    bad(SimConfigSchema, { driverCount: 1 });
  });
  it('validates SimConfigUpdate', () => {
    ok(SimConfigUpdateSchema, { speed: 2 });
    ok(SimConfigUpdateSchema, cfg);
    bad(SimConfigUpdateSchema, {});
    bad(SimConfigUpdateSchema, { speed: 20 });
    bad(SimConfigUpdateSchema, { bogus: 1 });
  });
  it('validates clock and add rider', () => {
    ok(ClockStateSchema, { simTime: 100, speed: 1, paused: false });
    bad(ClockStateSchema, { simTime: -1, speed: 1, paused: false });
    ok(AddRiderRequestSchema, { pickup: p, dropoff: q });
    bad(AddRiderRequestSchema, { pickup: p });
  });
});

describe('errors', () => {
  it('validates ErrorResponse', () => {
    ok(ErrorResponseSchema, { statusCode: 400, error: 'Bad Request', message: 'x' });
    ok(ErrorResponseSchema, {
      statusCode: 400,
      error: 'Bad Request',
      message: ['a', 'b'],
      correlationId: 'abc',
    });
    bad(ErrorResponseSchema, { error: 'x', message: 'y' });
  });
});
