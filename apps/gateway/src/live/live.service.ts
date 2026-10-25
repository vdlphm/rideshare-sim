import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@rideshare/common';
import type { WsDiff } from '@rideshare/contracts';
import { WebSocket } from 'ws';
import type { GatewayEnv } from '../config';
import { decideSend, type LiveClient } from './live-client';
import { LiveSession } from './live-session';
import { LIVE_UPSTREAMS, type LiveUpstreams } from './upstreams';

/**
 * Owns the connected admin clients and the poller. The poller (a `LiveSession`) exists only
 * while at least one client is connected: the first client starts it (with a full fetch), the
 * last one to leave stops it and discards the model.
 */
@Injectable()
export class LiveService implements OnApplicationShutdown {
  private readonly log = new Logger('Live');
  private readonly clients = new Set<LiveClient>();
  private session?: LiveSession;

  constructor(
    private readonly config: ConfigService<GatewayEnv>,
    @Inject(LIVE_UPSTREAMS) private readonly upstreams: LiveUpstreams,
  ) {}

  get clientCount(): number {
    return this.clients.size;
  }

  /** Registers an authenticated admin socket. */
  add(socket: WebSocket): void {
    const client: LiveClient = { socket, sentUsers: new Set(), needsSnapshot: true };
    this.clients.add(client);
    const drop = () => this.remove(client);
    socket.on('close', drop);
    socket.on('error', drop);
    if (!this.session) {
      this.session = this.createSession();
      this.session.start();
    } else if (this.session.model.ready) {
      this.flushClient(client, null);
    }
  }

  onApplicationShutdown(): void {
    this.session?.stop();
    this.session = undefined;
    for (const c of this.clients) c.socket.terminate();
    this.clients.clear();
  }

  private remove(client: LiveClient): void {
    if (!this.clients.delete(client)) return;
    if (this.clients.size === 0 && this.session) {
      this.session.stop();
      this.session = undefined;
      this.log.log('last live-view client left; poller stopped');
    }
  }

  private createSession(): LiveSession {
    this.log.log('first live-view client connected; poller starting');
    return new LiveSession({
      upstreams: this.upstreams,
      pollIntervalMs: this.config.get('WS_POLL_INTERVAL_MS'),
      statsIntervalMs: this.config.get('WS_STATS_INTERVAL_MS'),
      endedTripRetentionMs: this.config.get('WS_ENDED_TRIP_RETENTION_MS'),
      userCacheTtlMs: this.config.get('WS_USER_CACHE_TTL_MS'),
      log: { warn: (m) => this.log.warn(m), debug: (m) => this.log.debug(m) },
      onUpdate: () => this.publish(),
    });
  }

  /** Called by the session after each load/tick: one diff, drained once, fanned out. */
  private publish(): void {
    const session = this.session;
    if (!session) return;
    const base = session.model.takeDiff();
    for (const client of this.clients) this.flushClient(client, base);
  }

  private flushClient(
    client: LiveClient,
    base: Omit<WsDiff, 'type' | 'at' | 'users'> | null,
  ): void {
    const model = this.session!.model;
    const { socket } = client;
    if (socket.readyState !== WebSocket.OPEN) return;
    const users = client.needsSnapshot ? [] : model.usersNotIn(client.sentUsers);
    const decision = decideSend({
      bufferedAmount: socket.bufferedAmount,
      limitBytes: this.config.get('WS_BACKPRESSURE_BYTES'),
      needsSnapshot: client.needsSnapshot,
      hasChange: base !== null || users.length > 0,
    });
    switch (decision) {
      case 'idle':
        return;
      case 'skip':
        client.needsSnapshot = true;
        this.log.debug('live client congested; will resync with a snapshot');
        return;
      case 'snapshot': {
        const snap = model.snapshot(Date.now());
        client.sentUsers = new Set(snap.users.map((u) => u.id));
        client.needsSnapshot = false;
        this.send(client, snap);
        return;
      }
      case 'diff': {
        const diff: WsDiff = {
          type: 'diff',
          at: Date.now(),
          drivers: { upsert: [], remove: [] },
          riders: { upsert: [], remove: [] },
          trips: { upsert: [], remove: [] },
          ...base,
          users,
        };
        for (const u of users) client.sentUsers.add(u.id);
        this.send(client, diff);
      }
    }
  }

  private send(client: LiveClient, message: unknown): void {
    client.socket.send(JSON.stringify(message), (err) => {
      if (err) client.socket.terminate();
    });
  }
}
