import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  ConfigService,
  TOKEN_PROVIDER,
  createHttpClient,
  type TokenProvider,
} from '@rideshare/common';
import type { BotsSummary, LatLng } from '@rideshare/contracts';
import type { SimulatorEnv } from '../config';
import { CLOCK, SimStore, type RealClock } from '../sim-store';
import { BotClient, type Account } from './bot-client';
import type { BotEnv } from './bot-env';
import { driverAccount, riderAccount } from './accounts';
import { DriverFleet } from './driver-fleet';
import { RiderSpawner, type AddRiderResult } from './rider-spawner';
import { RoutingSnapper } from './routing-snapper';
import { Scheduler } from './scheduler';

export const BOT_RNG = Symbol('BOT_RNG');

const ZERO: BotsSummary = {
  drivers: { total: 0, idle: 0, toPickup: 0, atPickup: 0, inTrip: 0 },
  riders: { active: 0, waiting: 0, riding: 0 },
};

/** Owns the bot scheduler, driver fleet and rider spawner; started on bootstrap when enabled. */
@Injectable()
export class BotRuntime implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly log = new Logger('Bots');
  private scheduler?: Scheduler;
  private fleet?: DriverFleet;
  private spawner?: RiderSpawner;
  private off?: () => void;

  constructor(
    private readonly store: SimStore,
    private readonly config: ConfigService<SimulatorEnv>,
    @Inject(TOKEN_PROVIDER) private readonly tokens: TokenProvider,
    @Inject(CLOCK) private readonly realNow: RealClock,
    @Inject(BOT_RNG) private readonly rng: () => number,
  ) {}

  get enabled(): boolean {
    return this.fleet !== undefined;
  }

  onApplicationBootstrap(): void {
    const cfg = this.config.values;
    if (!cfg.SIM_BOTS_ENABLED) return;

    const env: BotEnv = {
      simNow: () => this.store.now(),
      realNow: this.realNow,
      config: () => this.store.getConfig(),
      rng: this.rng,
    };
    const client = (account: Account) =>
      new BotClient({ baseUrl: cfg.GATEWAY_URL, account, now: this.realNow });
    const snapper = new RoutingSnapper(
      createHttpClient({
        baseUrl: cfg.ROUTING_URL,
        service: 'routing',
        auth: 'service',
        tokenProvider: this.tokens,
        maxAttempts: 2,
      }),
    );

    const scheduler = new Scheduler({
      maxInFlight: cfg.SIM_BOT_MAX_IN_FLIGHT,
      onError: (err) => this.log.warn(`bot job failed: ${String(err)}`),
    });
    this.fleet = new DriverFleet({
      scheduler,
      env,
      snapper,
      makeApi: (n) => client(driverAccount(n, cfg.SIM_BOT_PASSWORD)),
      botOptions: { offerTtlSimMs: cfg.OFFER_TTL_SIM_MS },
    });
    this.spawner = new RiderSpawner({
      scheduler,
      env,
      snapper,
      makeApi: (n) => client(riderAccount(n, cfg.SIM_BOT_PASSWORD)),
      maxActive: cfg.SIM_MAX_ACTIVE_RIDERS,
      log: (m) => this.log.debug(m),
    });
    this.scheduler = scheduler;

    this.fleet.setTarget(this.store.getConfig().driverCount);
    this.off = this.store.onChange(({ config }) => this.fleet?.setTarget(config.driverCount));
    scheduler.start();
    this.log.log(`bots started against ${cfg.GATEWAY_URL}`);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.off?.();
    await this.scheduler?.stop();
    await this.fleet?.shutdown(3000);
  }

  summary(): BotsSummary {
    if (!this.fleet || !this.spawner) return ZERO;
    return { drivers: this.fleet.counts(), riders: this.spawner.counts() };
  }

  /** Throws nothing; the controller maps the result to HTTP. */
  async addRider(pickup: LatLng, dropoff: LatLng): Promise<AddRiderResult> {
    if (!this.spawner) return { kind: 'noAccount' };
    return this.spawner.addRider(pickup, dropoff);
  }
}
