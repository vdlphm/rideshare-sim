import type { TripStatus } from '@rideshare/contracts';

export type TripAction =
  | { type: 'assign'; driverId: string; offerId?: string }
  | { type: 'arrive'; driverId: string }
  | { type: 'start'; driverId: string }
  | { type: 'complete'; driverId: string }
  | { type: 'noDrivers' }
  | { type: 'unassign'; reason: string };

export type TripActionType = TripAction['type'];

/** Sim-time timestamp columns of `trips` that a transition can set. */
export type TimestampField = 'matchedAt' | 'arrivedAt' | 'startedAt' | 'completedAt';

export interface TransitionRule {
  from: TripStatus;
  action: TripActionType;
  to: TripStatus;
  /** Column stamped with `nowSim` on success. */
  timestampField?: TimestampField;
  /** Column reset to null on success. */
  clearTimestampField?: TimestampField;
  /** Only `trip.driverId` may perform the action. */
  requiresAssignedDriver: boolean;
  /** Mermaid edge label; the single source for docs. */
  label: string;
}

/** The one source of truth for the trip state machine (code, tests, docs). */
export const TRIP_TRANSITIONS: readonly TransitionRule[] = [
  {
    from: 'REQUESTED',
    action: 'assign',
    to: 'MATCHED',
    timestampField: 'matchedAt',
    requiresAssignedDriver: false,
    label: 'driver accepts (assign)',
  },
  {
    from: 'REQUESTED',
    action: 'noDrivers',
    to: 'NO_DRIVERS',
    requiresAssignedDriver: false,
    label: 'max attempts / time exceeded',
  },
  {
    from: 'MATCHED',
    action: 'arrive',
    to: 'ARRIVED',
    timestampField: 'arrivedAt',
    requiresAssignedDriver: true,
    label: 'driver at pickup',
  },
  {
    from: 'MATCHED',
    action: 'unassign',
    to: 'REQUESTED',
    clearTimestampField: 'matchedAt',
    requiresAssignedDriver: false,
    label: 'driver offline (rematch)',
  },
  {
    from: 'ARRIVED',
    action: 'start',
    to: 'IN_PROGRESS',
    timestampField: 'startedAt',
    requiresAssignedDriver: true,
    label: 'rider picked up',
  },
  {
    from: 'IN_PROGRESS',
    action: 'complete',
    to: 'COMPLETED',
    timestampField: 'completedAt',
    requiresAssignedDriver: true,
    label: 'at dropoff',
  },
];

export const NO_DRIVERS_REASON = 'NO_DRIVERS_FOUND';

export interface TripSnapshot {
  status: TripStatus;
  driverId: string | null;
}

export interface TripNextState {
  status: TripStatus;
  driverId: string | null;
  /** Set this sim-time column to `nowSim`. */
  timestampField?: TimestampField;
  /** Set this sim-time column to null. */
  clearTimestampField?: TimestampField;
  endedReason?: string;
  /** Extra detail for the trip_events row. */
  eventMeta?: Record<string, unknown>;
}

export type TransitionError = 'INVALID_TRANSITION' | 'NOT_ASSIGNED_DRIVER';

export type TransitionResult =
  { ok: true; next: TripNextState } | { ok: false; error: TransitionError; message: string };

export function findRule(status: TripStatus, action: TripActionType): TransitionRule | undefined {
  return TRIP_TRANSITIONS.find((r) => r.from === status && r.action === action);
}

/** Pure state machine step. `nowSim` is accepted for API symmetry; the caller stamps it. */
export function transition(
  trip: TripSnapshot,
  action: TripAction,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _nowSim?: number,
): TransitionResult {
  const rule = findRule(trip.status, action.type);
  if (!rule) {
    return {
      ok: false,
      error: 'INVALID_TRANSITION',
      message: `Cannot ${action.type} a trip in status ${trip.status}`,
    };
  }
  if (rule.requiresAssignedDriver) {
    const actor = 'driverId' in action ? action.driverId : undefined;
    if (trip.driverId === null || actor !== trip.driverId) {
      return {
        ok: false,
        error: 'NOT_ASSIGNED_DRIVER',
        message: 'Only the assigned driver may perform this action',
      };
    }
  }

  const next: TripNextState = { status: rule.to, driverId: trip.driverId };
  if (rule.timestampField) next.timestampField = rule.timestampField;
  if (rule.clearTimestampField) next.clearTimestampField = rule.clearTimestampField;
  switch (action.type) {
    case 'assign':
      next.driverId = action.driverId;
      if (action.offerId) next.eventMeta = { offerId: action.offerId };
      break;
    case 'unassign':
      next.driverId = null;
      next.eventMeta = { reason: action.reason, previousDriverId: trip.driverId };
      break;
    case 'noDrivers':
      next.endedReason = NO_DRIVERS_REASON;
      break;
  }
  return { ok: true, next };
}

/** Mermaid `stateDiagram-v2` generated from the table, for docs. */
export function toMermaid(): string {
  const lines = ['stateDiagram-v2', '  [*] --> REQUESTED'];
  for (const r of TRIP_TRANSITIONS) lines.push(`  ${r.from} --> ${r.to}: ${r.label}`);
  lines.push('  NO_DRIVERS --> [*]', '  COMPLETED --> [*]');
  return lines.join('\n');
}
