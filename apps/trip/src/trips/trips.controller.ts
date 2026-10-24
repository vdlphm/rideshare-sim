import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { CurrentUser, Roles, type AuthUser } from '@rideshare/common';
import {
  AssignTripRequestSchema,
  CreateTripRequestSchema,
  type AssignTripRequest,
  type CreateTripRequest,
  type Trip,
  type TripDetail,
  type TripStats,
} from '@rideshare/contracts';
import type { Response } from 'express';
import { ZodValidationPipe } from 'nestjs-zod';
import {
  ActiveTripsQuerySchema,
  TripListQuerySchema,
  UnassignTripRequestSchema,
  type ActiveTripsQuery,
  type TripListQuery,
  type UnassignTripRequest,
} from './queries';
import { TripsService } from './trips.service';

const uuid = new ParseUUIDPipe();

@Controller('trips')
export class TripsController {
  constructor(private readonly trips: TripsService) {}

  // Declared before `:id` so `stats` is not parsed as an id.
  @Roles('admin')
  @Get('stats')
  stats(): Promise<TripStats> {
    return this.trips.stats();
  }

  @Roles('admin')
  @Get()
  list(@Query(new ZodValidationPipe(TripListQuerySchema)) query: TripListQuery): Promise<Trip[]> {
    return this.trips.list(query);
  }

  @Roles('rider', 'driver', 'admin')
  @Get(':id')
  get(@Param('id', uuid) id: string, @CurrentUser() user: AuthUser): Promise<TripDetail> {
    return this.trips.get(id, user);
  }

  @Roles('driver')
  @Post(':id/arrive')
  @HttpCode(200)
  arrive(@Param('id', uuid) id: string, @CurrentUser() user: AuthUser): Promise<TripDetail> {
    return this.trips.driverAction(id, user.id, 'arrive');
  }

  @Roles('driver')
  @Post(':id/start')
  @HttpCode(200)
  start(@Param('id', uuid) id: string, @CurrentUser() user: AuthUser): Promise<TripDetail> {
    return this.trips.driverAction(id, user.id, 'start');
  }

  @Roles('driver')
  @Post(':id/complete')
  @HttpCode(200)
  complete(@Param('id', uuid) id: string, @CurrentUser() user: AuthUser): Promise<TripDetail> {
    return this.trips.driverAction(id, user.id, 'complete');
  }
}

/** Service-to-service endpoints; not exposed through the gateway. */
@Controller('internal/trips')
export class InternalTripsController {
  constructor(private readonly trips: TripsService) {}

  /** Called by the rider service with the forwarded rider token; riderId is the token `sub`. */
  @Roles('rider')
  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateTripRequestSchema)) body: CreateTripRequest,
  ): Promise<{ tripId: string }> {
    return this.trips.create(user.id, body);
  }

  @Roles('service')
  @Get('active')
  async active(
    @Query(new ZodValidationPipe(ActiveTripsQuerySchema)) query: ActiveTripsQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Trip[]> {
    const { trips, asOf } = await this.trips.activeTrips(query);
    if (asOf) res.setHeader('x-server-time', asOf.toISOString());
    return trips;
  }

  @Roles('service')
  @Get('stats')
  @Header('cache-control', 'no-store')
  stats(): Promise<TripStats> {
    return this.trips.stats();
  }

  @Roles('service')
  @Post(':id/assign')
  @HttpCode(200)
  assign(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(AssignTripRequestSchema)) body: AssignTripRequest,
  ): Promise<TripDetail> {
    return this.trips.assign(id, body);
  }

  @Roles('service')
  @Post(':id/no-drivers')
  @HttpCode(200)
  noDrivers(@Param('id', uuid) id: string): Promise<TripDetail> {
    return this.trips.noDrivers(id);
  }

  @Roles('service')
  @Post(':id/unassign')
  @HttpCode(200)
  unassign(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(UnassignTripRequestSchema)) body: UnassignTripRequest,
  ): Promise<TripDetail> {
    return this.trips.unassign(id, body.reason);
  }
}
