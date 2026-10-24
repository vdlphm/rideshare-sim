import { Injectable, type OnModuleInit } from '@nestjs/common';
import { SimClock } from '@rideshare/common';

/** Fetches the sim clock before the app starts serving (`now()` throws until synced). */
@Injectable()
export class ClockSync implements OnModuleInit {
  constructor(private readonly clock: SimClock) {}

  async onModuleInit(): Promise<void> {
    await this.clock.sync();
  }
}
