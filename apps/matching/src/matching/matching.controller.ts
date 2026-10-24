import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { CurrentUser, Roles, type AuthUser } from '@rideshare/common';
import {
  MatchRequestSchema,
  type AcceptOfferResponse,
  type MatchRequest,
  type Offer,
} from '@rideshare/contracts';
import type { Response } from 'express';
import { ZodValidationPipe } from 'nestjs-zod';
import { MatchingEngine } from '../domain/matching.engine';
import type { OfferRecord } from '../domain/types';

const uuid = new ParseUUIDPipe();

export function toOffer(o: OfferRecord): Offer {
  return {
    id: o.id,
    tripId: o.tripId,
    driverId: o.driverId,
    status: o.status,
    etaS: o.etaS,
    attempt: o.attempt,
    expiresSim: o.expiresSim,
    pickup: o.pickup,
    dropoff: o.dropoff,
  };
}

/** Driver-facing routes (reached through the gateway as /api/matching/offers/*). */
@Controller('offers')
export class OffersController {
  constructor(private readonly engine: MatchingEngine) {}

  @Roles('driver')
  @Get('me')
  async mine(
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Offer | undefined> {
    const offer = await this.engine.currentOffer(user.id);
    if (!offer) {
      res.status(204);
      return undefined;
    }
    return toOffer(offer);
  }

  @Roles('driver')
  @Post(':id/accept')
  @HttpCode(200)
  accept(
    @Param('id', uuid) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<AcceptOfferResponse> {
    return this.engine.accept(id, user.id);
  }

  @Roles('driver')
  @Post(':id/decline')
  @HttpCode(204)
  async decline(@Param('id', uuid) id: string, @CurrentUser() user: AuthUser): Promise<void> {
    await this.engine.decline(id, user.id);
  }
}

@Controller('internal')
export class InternalMatchingController {
  constructor(private readonly engine: MatchingEngine) {}

  /** Idempotent per tripId; matching continues in the background. */
  @Roles('service')
  @Post('match')
  @HttpCode(202)
  async match(
    @Body(new ZodValidationPipe(MatchRequestSchema)) body: MatchRequest,
  ): Promise<{ accepted: true }> {
    await this.engine.requestMatch(body);
    return { accepted: true };
  }
}
