import type { LatLng } from '@rideshare/contracts';
import type { RiderApi } from './bot-client';
import type { BotEnv, Job, Task } from './bot-env';

export type RideOutcome =
  | { kind: 'ok'; tripId: string }
  | { kind: 'conflict' }
  | { kind: 'unroutable'; message: string }
  | { kind: 'failed'; status: number; message: string };

export type RiderDoneReason =
  'completed' | 'no_drivers' | 'gone' | 'timeout' | 'conflict' | 'failed';

export type RiderPhase = 'STARTING' | 'WAITING' | 'DONE';

/** A rider that waits longer than this (sim ms) for a terminal trip status is abandoned. */
export const RIDER_MAX_WAIT_SIM_MS = 30 * 60_000;

/** Real ms between trip polls: ~2 s, scaled down at high speed. */
export const riderPollIntervalMs = (speed: number): number =>
  Math.max(300, 2000 / Math.max(1, speed));

export interface RiderBotOptions {
  pickup: LatLng;
  dropoff: LatLng;
  /** true: send `pickup` in the ride request; false: omit it so it defaults to the rider position. */
  explicitPickup: boolean;
  onRequest: (outcome: RideOutcome) => void;
  onDone: (reason: RiderDoneReason) => void;
}

/** One rider: register/login, post location at pickup, request, then poll until the trip ends. */
export class RiderBot implements Task {
  phase: RiderPhase = 'STARTING';
  riding = false;
  tripId?: string;
  private nextPollReal = 0;
  private requestedSim = 0;

  constructor(
    readonly account: number,
    private readonly api: RiderApi,
    private readonly env: BotEnv,
    private readonly opts: RiderBotOptions,
  ) {}

  due(): Job | null {
    if (this.phase === 'STARTING') return () => this.start();
    if (this.phase === 'WAITING' && this.env.realNow() >= this.nextPollReal)
      return () => this.poll();
    return null;
  }

  private finish(reason: RiderDoneReason): void {
    this.phase = 'DONE';
    this.opts.onDone(reason);
  }

  private fail(outcome: RideOutcome, reason: RiderDoneReason): void {
    this.opts.onRequest(outcome);
    this.finish(reason);
  }

  private async start(): Promise<void> {
    const failed = (status: number, message: string) =>
      this.fail({ kind: 'failed', status, message }, 'failed');
    const acct = await this.api.ensureAccount();
    if (!acct.ok) return failed(acct.status, acct.message);
    const loc = await this.api.riderLocation(this.opts.pickup);
    if (!loc.ok) return failed(loc.status, loc.message);
    const res = await this.api.requestRide(
      this.opts.explicitPickup
        ? { pickup: this.opts.pickup, dropoff: this.opts.dropoff }
        : { dropoff: this.opts.dropoff },
    );
    if (res.ok) {
      this.tripId = res.data.tripId;
      this.requestedSim = this.env.simNow();
      this.nextPollReal = this.env.realNow() + riderPollIntervalMs(this.env.config().speed);
      this.phase = 'WAITING';
      this.opts.onRequest({ kind: 'ok', tripId: res.data.tripId });
      return;
    }
    if (res.status === 409) return this.fail({ kind: 'conflict' }, 'conflict');
    if (res.status === 422)
      return this.fail({ kind: 'unroutable', message: res.message }, 'failed');
    return failed(res.status, res.message);
  }

  private async poll(): Promise<void> {
    this.nextPollReal = this.env.realNow() + riderPollIntervalMs(this.env.config().speed);
    const res = await this.api.getTrip(this.tripId as string);
    if (res.ok) {
      const status = res.data.status;
      this.riding = status === 'IN_PROGRESS';
      if (status === 'COMPLETED') return this.finish('completed');
      if (status === 'NO_DRIVERS') return this.finish('no_drivers');
    } else if (res.status === 404 || res.status === 403) {
      return this.finish('gone');
    }
    if (this.env.simNow() - this.requestedSim > RIDER_MAX_WAIT_SIM_MS) this.finish('timeout');
  }
}
