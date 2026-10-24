import type { LatLng, SimConfig } from '@rideshare/contracts';

/** Everything bots read from the outside world; faked in unit tests. */
export interface BotEnv {
  /** Sim ms (frozen while paused, scaled by speed). Never Date.now(). */
  simNow(): number;
  /** Real ms. */
  realNow(): number;
  config(): SimConfig;
  /** Uniform [0, 1). */
  rng(): number;
}

/** Snaps a point to the nearest road; null when it is not near any road. */
export interface Snapper {
  snap(point: LatLng): Promise<LatLng | null>;
}

export const OFFER_TTL_SIM_MS_DEFAULT = 15_000;

export const isRunning = (env: BotEnv): boolean => {
  const c = env.config();
  return !c.paused && c.speed > 0;
};

export const randBetween = (env: BotEnv, min: number, max: number): number =>
  min + env.rng() * (max - min);

/** A unit of work for the scheduler: run it, and the bot is busy until it settles. */
export type Job = () => Promise<void>;

/** Something the scheduler polls every tick; `due()` is synchronous and cheap. */
export interface Task {
  due(): Job | null;
}
