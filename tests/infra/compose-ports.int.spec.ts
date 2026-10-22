import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { COMPOSE_DIR, COMPOSE_FILE, PASSWORDS } from './stack';

interface ComposeConfig {
  services: Record<string, { ports?: unknown[] }>;
}

describe('compose: published host ports', () => {
  const raw = execFileSync('docker', ['compose', '-f', COMPOSE_FILE, 'config', '--format', 'json'], {
    cwd: COMPOSE_DIR,
    env: { ...process.env, ...PASSWORDS },
    encoding: 'utf8',
  });
  const config = JSON.parse(raw) as ComposeConfig;

  it('defines postgres, redis and osrm', () => {
    expect(Object.keys(config.services)).toEqual(
      expect.arrayContaining(['postgres', 'redis', 'osrm-prep', 'osrm']),
    );
  });

  it.each(['postgres', 'redis', 'osrm-prep', 'osrm'])('%s publishes no host ports', (name) => {
    expect(config.services[name]?.ports ?? []).toEqual([]);
  });

  it('only gateway and web may publish host ports', () => {
    const publishers = Object.entries(config.services)
      .filter(([, s]) => (s.ports ?? []).length > 0)
      .map(([n]) => n);
    for (const n of publishers) expect(['gateway', 'web']).toContain(n);
  });
});
