import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { Roles } from '@rideshare/common';
import {
  NearestQuerySchema,
  TableRequestSchema,
  type NearestQuery,
  type NearestResult,
  type Route,
  type TableRequest,
  type TableResponse,
} from '@rideshare/contracts';
import { ZodValidationPipe } from 'nestjs-zod';
import { RouteParamsSchema, type RouteParams } from './queries';
import { RoutingService } from './routing.service';

/** Service-to-service endpoints (trip, matching); the gateway does not expose `/internal`. */
@Controller('internal')
export class InternalRoutingController {
  constructor(private readonly routing: RoutingService) {}

  @Roles('service')
  @Get('route')
  route(@Query(new ZodValidationPipe(RouteParamsSchema)) q: RouteParams): Promise<Route> {
    return this.routing.route(q.from, q.to);
  }

  @Roles('service')
  @Post('table')
  @HttpCode(200) // a read, not a create
  table(
    @Body(new ZodValidationPipe(TableRequestSchema)) body: TableRequest,
  ): Promise<TableResponse> {
    return this.routing.table(body);
  }

  @Roles('service')
  @Get('nearest')
  nearest(
    @Query(new ZodValidationPipe(NearestQuerySchema)) q: NearestQuery,
  ): Promise<NearestResult> {
    return this.routing.nearest(q);
  }
}

/** Admin debug routes (`/api/routing/route`, `/api/routing/nearest` through the gateway). */
@Controller()
export class AdminRoutingController {
  constructor(private readonly routing: RoutingService) {}

  @Roles('admin')
  @Get('route')
  route(@Query(new ZodValidationPipe(RouteParamsSchema)) q: RouteParams): Promise<Route> {
    return this.routing.route(q.from, q.to);
  }

  @Roles('admin')
  @Get('nearest')
  nearest(
    @Query(new ZodValidationPipe(NearestQuerySchema)) q: NearestQuery,
  ): Promise<NearestResult> {
    return this.routing.nearest(q);
  }
}
