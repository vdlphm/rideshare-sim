import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { COMPOSE_DIR, COMPOSE_FILE, PASSWORDS, SERVICE_ENV } from './stack';

interface ComposeConfig {
  services: Record<string, { ports?: { target: number; published?: string }[] }>;
}

describe('compose: published host ports', () => {
  const raw = execFileSync('docker', ['compose', '-f', COMPOSE_FILE, 'config', '--format', 'json'], {
    cwd: COMPOSE_DIR,
    env: { ...process.env, ...PASSWORDS, ...SERVICE_ENV },
    encoding: 'utf8',
  });
  const config = JSON.parse(raw) as ComposeConfig;

  it('defines postgres, redis, osrm, user, routing, driver, rider, trip, matching, simulator and gateway', () => {
    expect(Object.keys(config.services)).toEqual(
      expect.arrayContaining(['postgres', 'redis', 'osrm-prep', 'osrm', 'user', 'routing', 'driver', 'rider', 'trip', 'matching', 'simulator', 'gateway']),
    );
  });

  it.each(['postgres', 'redis', 'osrm-prep', 'osrm', 'user', 'routing', 'driver', 'rider', 'trip', 'matching', 'simulator'])('%s publishes no host ports', (name) => {
    expect(config.services[name]?.ports ?? []).toEqual([]);
  });

  it('only gateway and web may publish host ports', () => {
    const publishers = Object.entries(config.services)
      .filter(([, s]) => (s.ports ?? []).length > 0)
      .map(([n]) => n);
    for (const n of publishers) expect(['gateway', 'web']).toContain(n);
  });

  it('gateway is the only publisher and maps container port 8080', () => {
    const publishers = Object.entries(config.services)
      .filter(([, s]) => (s.ports ?? []).length > 0)
      .map(([n]) => n);
    expect(publishers).toEqual(['gateway']);
    expect(config.services.gateway?.ports?.map((p) => p.target)).toEqual([8080]);
  });
});
