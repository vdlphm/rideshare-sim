import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CurrentUser, Roles, type AuthUser } from '@rideshare/common';
import {
  DriverLocationUpdateSchema,
  DriverStatusUpdateSchema,
  GoOnlineRequestSchema,
  NearbyDriversQuerySchema,
  type DriverLocationUpdate,
  type DriverState,
  type DriverStatusUpdate,
  type GoOnlineRequest,
  type NearbyDriver,
  type NearbyDriversQuery,
} from '@rideshare/contracts';
import { ZodValidationPipe } from 'nestjs-zod';
import { DriverService } from './driver.service';

/** The driver id is always the token `sub`; never taken from the body or path. */
@Controller('drivers/me')
export class DriversController {
  constructor(private readonly drivers: DriverService) {}

  @Roles('driver')
  @Post('online')
  @HttpCode(200)
  online(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(GoOnlineRequestSchema)) body: GoOnlineRequest,
  ): Promise<DriverState> {
    return this.drivers.goOnline(user.id, body);
  }

  @Roles('driver')
  @Post('offline')
  @HttpCode(200)
  offline(@CurrentUser() user: AuthUser): Promise<DriverState> {
    return this.drivers.goOffline(user.id);
  }

  @Roles('driver')
  @Post('location')
  @HttpCode(204)
  async location(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(DriverLocationUpdateSchema)) body: DriverLocationUpdate,
  ): Promise<void> {
    await this.drivers.updateLocation(user.id, body);
  }

  @Roles('driver')
  @Get()
  me(@CurrentUser() user: AuthUser): Promise<DriverState> {
    return this.drivers.me(user.id);
  }
}

/** Service-to-service endpoints; not exposed through the gateway. */
@Controller('internal/drivers')
export class InternalDriversController {
  constructor(private readonly drivers: DriverService) {}

  @Roles('service')
  @Get('nearby')
  nearby(
    @Query(new ZodValidationPipe(NearbyDriversQuerySchema)) query: NearbyDriversQuery,
  ): Promise<NearbyDriver[]> {
    return this.drivers.nearby(query);
  }

  @Roles('service')
  @Get('online')
  online(): Promise<DriverState[]> {
    return this.drivers.online();
  }

  @Roles('service')
  @Put(':id/status')
  @HttpCode(200)
  setStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(DriverStatusUpdateSchema)) body: DriverStatusUpdate,
  ): Promise<DriverState> {
    return this.drivers.setStatus(id, body);
  }
}
