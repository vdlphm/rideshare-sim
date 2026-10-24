import { Body, Controller, Get, Put } from '@nestjs/common';
import { Roles } from '@rideshare/common';
import { SimConfigUpdateSchema, type SimConfig, type SimConfigUpdate } from '@rideshare/contracts';
import { ZodValidationPipe } from 'nestjs-zod';
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

/** Service-to-service endpoints; not exposed through the gateway. */
@Controller('internal')
export class InternalSimController {
  constructor(private readonly store: SimStore) {}

  @Roles('service')
  @Get('clock')
  clock(): ClockSnapshot {
    return this.store.clock();
  }

  @Roles('service')
  @Get('sim/state')
  state(): { clock: ClockSnapshot; config: SimConfig } {
    return { clock: this.store.clock(), config: this.store.getConfig() };
  }
}
