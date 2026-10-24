import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { ServiceTokenModule } from '../src/auth';
import { TOKEN_PROVIDER } from '../src/http';
import { SimClock, SimClockModule } from '../src/sim-clock';

describe('ServiceTokenModule visibility', () => {
  it('is global, so SimClockModule (no imports) fetches the clock with a service token', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ServiceTokenModule.register({
          userServiceUrl: 'http://user.test',
          clientId: 'trip',
          clientSecret: 'secret',
        }),
        SimClockModule.forRoot({ simulatorUrl: 'http://simulator.test' }),
      ],
    }).compile();

    expect(moduleRef.get(TOKEN_PROVIDER)).toBeDefined();
    // The clock decides its auth mode from whether a token provider was injected.
    expect((moduleRef.get(SimClock) as unknown as { auth: string }).auth).toBe('service');
  });
});
