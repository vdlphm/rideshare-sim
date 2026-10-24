import type { TripStats } from '@rideshare/contracts';

/** Averages are over trips completed in the last 30 sim-minutes. */
export const STATS_WINDOW_SIM_MS = 30 * 60 * 1000;

export interface RawStats {
  waiting: number;
  active: number;
  completed: number;
  noDrivers: number;
  avgMatchMs: number | null;
  avgPickupMs: number | null;
}

/** Pure StatsPanel formulas (design doc); null when there is no data. */
export function computeStats(raw: RawStats): TripStats {
  const served = raw.completed + raw.active;
  const denominator = served + raw.noDrivers;
  return {
    waitingRiders: raw.waiting,
    activeTrips: raw.active,
    completedTrips: raw.completed,
    noDriverTrips: raw.noDrivers,
    avgWaitToMatchS: raw.avgMatchMs === null ? null : raw.avgMatchMs / 1000,
    avgWaitToPickupS: raw.avgPickupMs === null ? null : raw.avgPickupMs / 1000,
    matchRate: denominator === 0 ? null : served / denominator,
  };
}
