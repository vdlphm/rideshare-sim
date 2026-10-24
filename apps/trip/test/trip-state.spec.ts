import { TripStatusSchema, type TripStatus } from '@rideshare/contracts';
import { describe, expect, it } from 'vitest';
import {
  NO_DRIVERS_REASON,
  TRIP_TRANSITIONS,
  toMermaid,
  transition,
  type TripAction,
  type TripActionType,
} from '../src/domain/trip-state';

const DRIVER = 'driver-1';
const OTHER = 'driver-2';
const STATUSES = TripStatusSchema.options as readonly TripStatus[];
const ACTION_TYPES: TripActionType[] = [
  'assign',
  'arrive',
  'start',
  'complete',
  'noDrivers',
  'unassign',
];

function action(type: TripActionType, driverId = DRIVER): TripAction {
  switch (type) {
    case 'assign':
      return { type, driverId, offerId: 'offer-1' };
    case 'arrive':
    case 'start':
    case 'complete':
      return { type, driverId };
    case 'noDrivers':
      return { type };
    case 'unassign':
      return { type, reason: 'driver offline' };
  }
}

/** A trip as it would be in `status`: assigned unless still REQUESTED / NO_DRIVERS. */
const tripIn = (status: TripStatus) => ({
  status,
  driverId: status === 'REQUESTED' || status === 'NO_DRIVERS' ? null : DRIVER,
});

describe('transitions table', () => {
  it('has no duplicate (from, action) pairs', () => {
    const keys = TRIP_TRANSITIONS.map((r) => `${r.from}:${r.action}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('never leaves a terminal state', () => {
    for (const r of TRIP_TRANSITIONS) expect(['COMPLETED', 'NO_DRIVERS']).not.toContain(r.from);
  });

  it('renders every edge in the mermaid diagram', () => {
    const diagram = toMermaid();
    for (const r of TRIP_TRANSITIONS) expect(diagram).toContain(`${r.from} --> ${r.to}`);
  });
});

describe('transition: valid', () => {
  it.each(TRIP_TRANSITIONS.map((r) => [`${r.from} -${r.action}-> ${r.to}`, r] as const))(
    '%s',
    (_name, rule) => {
      const res = transition(tripIn(rule.from), action(rule.action), 1234);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.next.status).toBe(rule.to);
      expect(res.next.timestampField).toBe(rule.timestampField);
      expect(res.next.clearTimestampField).toBe(rule.clearTimestampField);
    },
  );

  it('stamps the documented timestamp column', () => {
    const stamp = (from: TripStatus, type: TripActionType) => {
      const r = transition(tripIn(from), action(type), 1);
      return r.ok ? r.next.timestampField : 'ERR';
    };
    expect(stamp('REQUESTED', 'assign')).toBe('matchedAt');
    expect(stamp('MATCHED', 'arrive')).toBe('arrivedAt');
    expect(stamp('ARRIVED', 'start')).toBe('startedAt');
    expect(stamp('IN_PROGRESS', 'complete')).toBe('completedAt');
  });

  it('assign sets the driver and records the offer', () => {
    const res = transition({ status: 'REQUESTED', driverId: null }, action('assign'), 1);
    expect(res).toMatchObject({
      ok: true,
      next: { driverId: DRIVER, eventMeta: { offerId: 'offer-1' } },
    });
  });

  it('unassign clears the driver and matched_at', () => {
    const res = transition(tripIn('MATCHED'), action('unassign'), 1);
    expect(res).toMatchObject({
      ok: true,
      next: { status: 'REQUESTED', driverId: null, clearTimestampField: 'matchedAt' },
    });
  });

  it('noDrivers ends the trip with a reason', () => {
    const res = transition(tripIn('REQUESTED'), action('noDrivers'), 1);
    expect(res).toMatchObject({
      ok: true,
      next: { status: 'NO_DRIVERS', endedReason: NO_DRIVERS_REASON },
    });
  });

  it('keeps the driver through arrive, start and complete', () => {
    for (const [from, type] of [
      ['MATCHED', 'arrive'],
      ['ARRIVED', 'start'],
      ['IN_PROGRESS', 'complete'],
    ] as const) {
      const res = transition(tripIn(from), action(type), 1);
      expect(res).toMatchObject({ ok: true, next: { driverId: DRIVER } });
    }
  });
});

describe('transition: invalid (exhaustive)', () => {
  const valid = new Set(TRIP_TRANSITIONS.map((r) => `${r.from}:${r.action}`));
  const invalid = STATUSES.flatMap((s) =>
    ACTION_TYPES.filter((a) => !valid.has(`${s}:${a}`)).map((a) => [s, a] as const),
  );

  it('covers the full status x action matrix', () => {
    expect(invalid.length + TRIP_TRANSITIONS.length).toBe(STATUSES.length * ACTION_TYPES.length);
  });

  it.each(invalid)('%s + %s is INVALID_TRANSITION', (status, type) => {
    const res = transition(tripIn(status), action(type), 1);
    expect(res).toMatchObject({ ok: false, error: 'INVALID_TRANSITION' });
  });

  it.each(['COMPLETED', 'NO_DRIVERS'] as const)('%s accepts nothing', (status) => {
    for (const type of ACTION_TYPES) {
      expect(transition(tripIn(status), action(type), 1)).toMatchObject({
        ok: false,
        error: 'INVALID_TRANSITION',
      });
    }
  });
});

describe('transition: assigned driver only', () => {
  it.each(TRIP_TRANSITIONS.filter((r) => r.requiresAssignedDriver))(
    '$from -$action-> rejects another driver',
    (rule) => {
      const res = transition(tripIn(rule.from), action(rule.action, OTHER), 1);
      expect(res).toMatchObject({ ok: false, error: 'NOT_ASSIGNED_DRIVER' });
    },
  );

  it('rejects when the trip has no driver', () => {
    const res = transition({ status: 'MATCHED', driverId: null }, action('arrive'), 1);
    expect(res).toMatchObject({ ok: false, error: 'NOT_ASSIGNED_DRIVER' });
  });

  it('reports an invalid status before a wrong driver', () => {
    const res = transition(tripIn('REQUESTED'), action('arrive', OTHER), 1);
    expect(res).toMatchObject({ ok: false, error: 'INVALID_TRANSITION' });
  });
});
