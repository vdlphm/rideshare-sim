import {
  BadGatewayException,
  Body,
  Controller,
  ConflictException,
  Get,
  HttpCode,
  Post,
  Put,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Roles } from '@rideshare/common';
import {
  AddRiderRequestSchema,
  SimConfigUpdateSchema,
  type AddRiderRequest,
  type AddRiderResponse,
  type BotsSummary,
  type SimConfig,
  type SimConfigUpdate,
} from '@rideshare/contracts';
import { ZodValidationPipe } from 'nestjs-zod';
import { BotRuntime } from './bots/bot-runtime';
import { SimStore, type ClockSnapshot } from './sim-store';

@Controller('sim/config')
export class SimConfigController {
  constructor(private readonly store: SimStore) {}

  @Roles('admin')
  @Get()
  get(): SimConfig {
    return this.store.getConfig();
  }

  @Roles('admin')
  @Put()
  update(@Body(new ZodValidationPipe(SimConfigUpdateSchema)) body: SimConfigUpdate): SimConfig {
    return this.store.update(body);
  }
}

@Controller('sim/riders')
export class SimRidersController {
  constructor(private readonly bots: BotRuntime) {}

  /** Click-to-add: a rider bot for exactly these points; 201 once the ride request succeeded. */
  @Roles('admin')
  @Post()
  @HttpCode(201)
  async add(
    @Body(new ZodValidationPipe(AddRiderRequestSchema)) body: AddRiderRequest,
  ): Promise<AddRiderResponse> {
    const out = await this.bots.addRider(body.pickup, body.dropoff);
    switch (out.kind) {
      case 'ok':
        return { tripId: out.tripId };
      case 'unroutable':
        throw new UnprocessableEntityException(out.message);
      case 'conflict':
        throw new ConflictException('rider account has an active trip');
      case 'noAccount':
        throw new ServiceUnavailableException('no rider account available');
      case 'failed':
        throw new BadGatewayException(out.message);
    }
  }
}

/** Service-to-service endpoints; not exposed through the gateway. */
@Controller('internal')
export class InternalSimController {
  constructor(
    private readonly store: SimStore,
    private readonly bots: BotRuntime,
  ) {}

  @Roles('service')
  @Get('clock')
  clock(): ClockSnapshot {
    return this.store.clock();
  }

  @Roles('service')
  @Get('sim/state')
  state(): { clock: ClockSnapshot; config: SimConfig; bots: BotsSummary } {
    return { clock: this.store.clock(), config: this.store.getConfig(), bots: this.bots.summary() };
  }
}
