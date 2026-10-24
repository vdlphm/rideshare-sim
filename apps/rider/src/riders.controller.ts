import { Body, Controller, Get, HttpCode, NotFoundException, Post } from '@nestjs/common';
import { CurrentUser, Roles, type AuthUser } from '@rideshare/common';
import {
  RiderLocationUpdateSchema,
  type RiderLocationUpdate,
  type RiderPosition,
} from '@rideshare/contracts';
import { ZodValidationPipe } from 'nestjs-zod';
import { RiderPositionsService } from './positions.service';

@Controller('riders/me/location')
export class RidersController {
  constructor(private readonly positions: RiderPositionsService) {}

  @Roles('rider')
  @Post()
  @HttpCode(204)
  async update(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(RiderLocationUpdateSchema)) body: RiderLocationUpdate,
  ): Promise<void> {
    await this.positions.set(user.id, body);
  }

  @Roles('rider')
  @Get()
  async current(@CurrentUser() user: AuthUser): Promise<RiderPosition> {
    const pos = await this.positions.get(user.id);
    if (!pos) throw new NotFoundException('No current location for this rider');
    return pos;
  }
}

/** Service-to-service endpoints; not exposed through the gateway. */
@Controller('internal/riders')
export class InternalRidersController {
  constructor(private readonly positions: RiderPositionsService) {}

  @Roles('service')
  @Get('positions')
  list(): Promise<RiderPosition[]> {
    return this.positions.listActive();
  }
}
