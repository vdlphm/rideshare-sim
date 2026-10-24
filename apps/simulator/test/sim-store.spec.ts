import { describe, expect, it } from 'vitest';
import { ConfigService } from '@rideshare/common';
import { defaultSimConfig, simulatorEnvSchema, type SimulatorEnv } from '../src/config';
import { SimStore } from '../src/sim-store';

const REQUIRED = {
  NODE_ENV: 'test',
  SIMULATOR_CLIENT_SECRET: 'secret',
  SIM_BOT_PASSWORD: 'bot-password',
};

function make(env: Record<string, string> = {}) {
  let t = 1_000_000;
  const values = simulatorEnvSchema.parse({ ...REQUIRED, ...env });
  const store = new SimStore(new ConfigService<SimulatorEnv>(values), () => t);
  return { store, advance: (ms: number) => (t += ms), back: (ms: number) => (t -= ms) };
}

describe('SimStore clock', () => {
  it('starts at 0 and advances by realDelta x speed', () => {
    const { store, advance } = make();
    expect(store.now()).toBe(0);
    advance(1000);
    expect(store.now()).toBe(1000);
    store.update({ speed: 4 });
    advance(500);
    expect(store.now()).toBe(3000);
  });

  it('pause freezes, resume continues from the frozen value', () => {
    const { store, advance } = make();
    advance(2000);
    store.update({ paused: true });
    advance(10_000);
    expect(store.now()).toBe(2000);
    expect(store.clock().paused).toBe(true);
    store.update({ paused: false });
    expect(store.now()).toBe(2000);
    advance(1000);
    expect(store.now()).toBe(3000);
  });

  it('speed change mid-run re-bases with no jump', () => {
    const { store, advance } = make();
    advance(1500);
    const before = store.now();
    store.update({ speed: 10 });
    expect(store.now()).toBe(before);
    advance(100);
    expect(store.now()).toBe(before + 1000);
  });

  it('speed 0 freezes', () => {
    const { store, advance } = make();
    advance(1000);
    store.update({ speed: 0 });
    advance(5000);
    expect(store.now()).toBe(1000);
    expect(store.clock()).toEqual({ simTime: 1000, speed: 0, paused: false });
  });

  it('never goes backwards, even if the real clock does', () => {
    const { store, advance, back } = make();
    advance(1000);
    const a = store.now();
    back(400);
    expect(store.now()).toBeGreaterThanOrEqual(a - 1000);
    store.update({ speed: 2 });
    const b = store.now();
    advance(100);
    expect(store.now()).toBeGreaterThanOrEqual(b);
    let prev = -1;
    for (let i = 0; i < 20; i++) {
      advance(i % 3 === 0 ? -50 : 100);
      if (i % 5 === 0) store.update({ speed: (i % 4) + 1 });
      const n = store.now();
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });

  it('notifies subscribers, isolates failures and supports unsubscribe', () => {
    const { store } = make();
    const seen: number[] = [];
    store.onChange(() => {
      throw new Error('boom');
    });
    const off = store.onChange((c) => seen.push(c.config.speed));
    store.update({ speed: 2 });
    off();
    store.update({ speed: 3 });
    expect(seen).toEqual([2]);
  });
});

describe('config defaults', () => {
  it('uses documented defaults', () => {
    const { store } = make();
    expect(store.getConfig()).toEqual({
      driverCount: 50,
      spawnIntervalS: 3,
      speed: 1,
      paused: false,
      acceptProbability: 0.9,
    });
  });

  it('honours env overrides and SIM_START_PAUSED', () => {
    const { store } = make({ SIM_DEFAULT_SPEED: '5', SIM_START_PAUSED: 'true' });
    expect(store.getConfig().speed).toBe(5);
    expect(store.clock().paused).toBe(true);
  });

  it('rejects invalid defaults', () => {
    const bad = (env: Record<string, string>) =>
      defaultSimConfig(simulatorEnvSchema.parse({ ...REQUIRED, ...env }));
    expect(() => bad({ SIM_DEFAULT_SPEED: '11' })).toThrow();
    expect(() => bad({ SIM_DEFAULT_DRIVER_COUNT: '501' })).toThrow();
    expect(() => bad({ SIM_DEFAULT_SPAWN_INTERVAL_S: '0' })).toThrow();
    expect(() => bad({ SIM_DEFAULT_ACCEPT_PROBABILITY: '1.5' })).toThrow();
  });
});
