import { Body, Controller, Post } from '@nestjs/common';
import { CurrentUser, Roles, type AuthUser } from '@rideshare/common';
import {
  RideRequestSchema,
  type RideRequest,
  type RideRequestResponse,
} from '@rideshare/contracts';
import { ZodValidationPipe } from 'nestjs-zod';
import { RideRequestsService } from './rides.service';

@Controller('riders/me/rides')
export class RideRequestsController {
  constructor(private readonly rides: RideRequestsService) {}

  @Roles('rider')
  @Post()
  request(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(RideRequestSchema)) body: RideRequest,
  ): Promise<RideRequestResponse> {
    return this.rides.request(user.id, body);
  }
}
