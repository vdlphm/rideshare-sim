import { Inject, Injectable } from '@nestjs/common';
import { advanceSimTime, ConfigService } from '@rideshare/common';
import type { SimConfig, SimConfigUpdate } from '@rideshare/contracts';
import { defaultSimConfig, type SimulatorEnv } from './config';

/** Real-time source in ms; injectable so tests can control time. */
export const CLOCK = Symbol('CLOCK');
export type RealClock = () => number;

export interface ClockSnapshot {
  simTime: number;
  speed: number;
  paused: boolean;
}

export interface SimChange {
  config: SimConfig;
  previous: SimConfig;
  clock: ClockSnapshot;
}
export type SimChangeListener = (change: SimChange) => void;

/**
 * In-memory (single instance) holder of the sim config and clock.
 *
 * The clock keeps (baseSimTime, baseRealTime, speed, paused) and computes now()
 * lazily with advanceSimTime; no timer. Speed/pause changes re-base first so sim
 * time is continuous. simTime is ms since boot.
 *
 * Subscribing (for M5 bots): `const off = store.onChange(({config, previous, clock}) => ...)`.
 * Listeners run synchronously after every successful update(); errors thrown by a
 * listener are swallowed so one subscriber cannot break the PUT. Call `off()` to
 * unsubscribe. Read current values with getConfig() / clock().
 */
@Injectable()
export class SimStore {
  private config: SimConfig;
  private baseSim = 0;
  private high = 0;
  private baseReal: number;
  private readonly listeners = new Set<SimChangeListener>();

  constructor(
    config: ConfigService<SimulatorEnv>,
    @Inject(CLOCK) private readonly realNow: RealClock,
  ) {
    this.config = defaultSimConfig(config.values);
    this.baseReal = realNow();
  }

  getConfig(): SimConfig {
    return { ...this.config };
  }

  /** Current sim time (ms since start), speed and paused flag. */
  clock(): ClockSnapshot {
    return { simTime: this.now(), speed: this.config.speed, paused: this.config.paused };
  }

  now(real: number = this.realNow()): number {
    const delta = Math.max(0, real - this.baseReal);
    const t = advanceSimTime(this.baseSim, delta, this.config.speed, this.config.paused);
    // High-water mark: sim time never goes backwards, even if the real clock does.
    this.high = Math.max(this.high, t);
    return this.high;
  }

  update(patch: SimConfigUpdate): SimConfig {
    const previous = this.config;
    // Re-base before changing speed/paused so sim time stays continuous.
    const real = this.realNow();
    this.baseSim = this.now(real); // same instant as baseReal: no lost time
    this.baseReal = real;
    this.config = { ...previous, ...patch };
    const change: SimChange = {
      config: this.getConfig(),
      previous: { ...previous },
      clock: this.clock(),
    };
    for (const l of this.listeners) {
      try {
        l(change);
      } catch {
        // isolate subscribers
      }
    }
    return this.getConfig();
  }

  onChange(listener: SimChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
