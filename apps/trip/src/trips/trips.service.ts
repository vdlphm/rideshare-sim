import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SimClock, type AuthUser } from '@rideshare/common';
import type {
  AssignTripRequest,
  CreateTripRequest,
  Route,
  Trip,
  TripDetail,
  TripStats,
  TripStatus,
} from '@rideshare/contracts';
import type { TripAction } from '../domain/trip-state';
import { MatchingDispatcher } from '../upstream/dispatcher.service';
import { Upstreams } from '../upstream/upstreams.service';
import type { ActiveTripsQuery, TripListQuery } from './queries';
import { computeStats, STATS_WINDOW_SIM_MS } from './stats';
import { ACTIVE, TripsRepository, type TransitionOutcome } from './trips.repository';

const LIST_LIMIT = 500;

const LIST_STATUSES: Record<TripListQuery['status'], TripStatus[] | 'all'> = {
  active: ACTIVE,
  requested: ['REQUESTED'],
  completed: ['COMPLETED'],
  all: 'all',
};

export interface ActiveTripsResult {
  trips: Trip[];
  /** DB clock at read time; use as the next `updatedSince` cursor when set. */
  asOf?: Date;
}

@Injectable()
export class TripsService {
  private readonly logger = new Logger(TripsService.name);

  constructor(
    private readonly repo: TripsRepository,
    private readonly upstreams: Upstreams,
    private readonly dispatcher: MatchingDispatcher,
    private readonly clock: SimClock,
  ) {}

  private nowSim(): number {
    try {
      return this.clock.now();
    } catch {
      throw new ServiceUnavailableException('Simulation clock unavailable');
    }
  }

  private unwrap(outcome: TransitionOutcome): TripDetail {
    if (outcome.ok) return outcome.trip;
    switch (outcome.error) {
      case 'NOT_FOUND':
        throw new NotFoundException(outcome.message);
      case 'NOT_ASSIGNED_DRIVER':
        throw new ForbiddenException(outcome.message);
      default:
        throw new ConflictException(outcome.message);
    }
  }

  private async apply(id: string, action: TripAction, pickupRoute?: Route): Promise<TripDetail> {
    return this.unwrap(
      await this.repo.applyTransition({ id, action, nowSim: this.nowSim(), pickupRoute }),
    );
  }

  /** Rider creates a trip (token forwarded by the rider service). */
  async create(riderId: string, body: CreateTripRequest): Promise<{ tripId: string }> {
    // OSRM snaps route endpoints anywhere, so verify both points are on the road network first.
    const [pickup, dropoff] = await Promise.all([
      this.upstreams.snap(body.pickup),
      this.upstreams.snap(body.dropoff),
    ]);
    const tripRoute = await this.upstreams.route(pickup, dropoff);
    const trip = await this.repo.insert({
      riderId,
      pickup,
      dropoff,
      tripRoute,
      requestedAt: this.nowSim(),
    });
    // After commit; a failure is logged and the dispatcher sweep retries.
    await this.dispatcher.dispatch(trip);
    return { tripId: trip.id };
  }

  async get(id: string, user: AuthUser): Promise<TripDetail> {
    const trip = await this.repo.findDetail(id);
    const visible =
      trip &&
      (user.role === 'admin' ||
        (user.role === 'rider' && trip.riderId === user.id) ||
        (user.role === 'driver' && trip.driverId === user.id));
    if (!trip || !visible) throw new NotFoundException('Trip not found');
    return trip;
  }

  /** Driver-driven transitions. */
  async driverAction(
    id: string,
    driverId: string,
    type: 'arrive' | 'start' | 'complete',
  ): Promise<TripDetail> {
    const detail = await this.apply(id, { type, driverId });
    if (type === 'complete') {
      // Committed above; failure is logged inside and repaired by driver reconcile (4.7).
      await this.upstreams.setDriverStatus(driverId, 'AVAILABLE', null);
    }
    return detail;
  }

  async assign(id: string, body: AssignTripRequest): Promise<TripDetail> {
    const trip = await this.repo.findById(id);
    if (!trip) throw new NotFoundException('Trip not found');
    if (trip.status !== 'REQUESTED') {
      throw new ConflictException(`Cannot assign a trip in status ${trip.status}`);
    }
    const pickupRoute = await this.upstreams.route(body.driverPosition, trip.pickup);
    const detail = await this.apply(
      id,
      { type: 'assign', driverId: body.driverId, offerId: body.offerId },
      pickupRoute,
    );
    const ok = await this.upstreams.setDriverStatus(body.driverId, 'ON_TRIP', id);
    if (!ok) this.logger.error(`trip ${id} MATCHED but driver ${body.driverId} not ON_TRIP yet`);
    return detail;
  }

  async noDrivers(id: string): Promise<TripDetail> {
    const existing = await this.repo.findDetail(id);
    if (existing?.status === 'NO_DRIVERS') return existing;
    return this.apply(id, { type: 'noDrivers' });
  }

  async unassign(id: string, reason: string): Promise<TripDetail> {
    const detail = await this.apply(id, { type: 'unassign', reason });
    await this.dispatcher.dispatch(detail);
    return detail;
  }

  async list(query: TripListQuery): Promise<Trip[]> {
    return this.repo.list(LIST_STATUSES[query.status], LIST_LIMIT);
  }

  async activeTrips(query: ActiveTripsQuery): Promise<ActiveTripsResult> {
    if (query.driverIds) return { trips: await this.repo.listActiveForDrivers(query.driverIds) };
    if (query.updatedSince) {
      return this.repo.listChangedSince(new Date(query.updatedSince));
    }
    return { trips: await this.repo.listNonTerminal() };
  }

  async stats(): Promise<TripStats> {
    return computeStats(await this.repo.rawStats(this.nowSim() - STATS_WINDOW_SIM_MS));
  }
}
