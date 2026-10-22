import { MockAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SimClock, advanceSimTime, createHttpClient } from '../src';

const BASE = 'http://sim.test';
let agent: MockAgent;
let real = 0;
let clock: SimClock;
let calls = 0;

function reply(simTime: number, speed: number, paused = false, times = 1) {
  agent
    .get(BASE)
    .intercept({ path: '/internal/clock', method: 'GET' })
    .reply(() => {
      calls++;
      return { statusCode: 200, data: { simTime, speed, paused } };
    })
    .times(times);
}
function fail() {
  agent
    .get(BASE)
    .intercept({ path: '/internal/clock', method: 'GET' })
    .reply(() => {
      calls++;
      return { statusCode: 500, data: 'boom' };
    })
    .persist();
}

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  real = 10_000;
  calls = 0;
  const http = createHttpClient({
    baseUrl: BASE,
    dispatcher: agent,
    maxAttempts: 1,
    sleep: async () => undefined,
  });
  clock = new SimClock(http, { refreshMs: 1000, realNow: () => real, auth: 'none' });
});
afterEach(async () => {
  await agent.close();
});

describe('advanceSimTime', () => {
  it('scales by speed', () => {
    expect(advanceSimTime(1000, 500, 10, false)).toBe(6000);
    expect(advanceSimTime(1000, 500, 0.5, false)).toBe(1250);
  });
  it('freezes when paused', () => {
    expect(advanceSimTime(1000, 500, 10, true)).toBe(1000);
  });
});

describe('SimClock', () => {
  it('throws before the first sync', () => {
    reply(0, 1);
    expect(() => clock.now()).toThrow(/not synced/);
  });

  it('extrapolates between fetches and exposes speed/paused', async () => {
    reply(100_000, 10);
    await clock.sync();
    expect(clock.speed).toBe(10);
    expect(clock.paused).toBe(false);
    real += 200;
    expect(clock.now()).toBe(102_000);
    expect(calls).toBe(1);
  });

  it('freezes while paused', async () => {
    reply(5000, 10, true);
    await clock.sync();
    real += 5000;
    expect(clock.now()).toBe(5000);
  });

  it('fetches at most once per refreshMs and corrects without going backwards', async () => {
    reply(100_000, 10);
    await clock.sync();
    real += 500;
    expect(clock.now()).toBe(105_000);
    for (let i = 0; i < 5; i++) clock.now();
    expect(calls).toBe(1);

    // server says time is behind our extrapolation
    reply(101_000, 10);
    real += 600; // 1100 since attempt
    const before = clock.now(); // triggers a refresh in the background
    expect(before).toBe(111_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(2);
    expect(clock.now()).toBe(111_000); // clamped, not 101_000 + ~0
    real += 1500;
    expect(clock.now()).toBeGreaterThan(111_000);
  });

  it('keeps extrapolating and warns when the simulator fails', async () => {
    reply(1000, 2);
    await clock.sync();
    fail();
    real += 1500;
    clock.now();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(2);
    real += 100;
    expect(clock.now()).toBe(1000 + 1600 * 2);
  });

  it('shares one in-flight fetch between concurrent syncs', async () => {
    reply(1, 1);
    await Promise.all([clock.sync(), clock.sync()]);
    expect(calls).toBe(1);
  });
});
