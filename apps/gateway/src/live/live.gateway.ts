import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { WS_CLOSE_FORBIDDEN, WS_CLOSE_UNAUTHORIZED } from '@rideshare/contracts';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { TokenVerifier } from '../token-verifier';
import { LiveService } from './live.service';

export const WS_PATH = '/ws';
/** Close code for "could not check the token right now" (server error; the client may retry). */
export const WS_CLOSE_INTERNAL = 1011;
const HEARTBEAT_MS = 30_000;

/**
 * The admin live-view endpoint: `GET /ws?token=<access token>` upgraded to a WebSocket.
 *
 * It is a plain `ws` server bound to the Nest HTTP server's `upgrade` event, outside the Express
 * middleware chain: the proxy and the route table never see these requests, and any other
 * upgrade path is refused. The handshake is always accepted and credentials are checked right
 * after, because a WebSocket close code (4401/4403) can only be delivered on an open socket.
 */
@Injectable()
export class LiveGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('LiveGateway');
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  private readonly alive = new WeakSet<WebSocket>();
  private server?: Server;
  private heartbeat?: NodeJS.Timeout;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly verifier: TokenVerifier,
    private readonly live: LiveService,
  ) {}

  onApplicationBootstrap(): void {
    this.server = this.adapterHost.httpAdapter.getHttpServer() as Server;
    this.server.on('upgrade', this.onUpgrade);
    this.heartbeat = setInterval(() => this.ping(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  onApplicationShutdown(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.server?.off('upgrade', this.onUpgrade);
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
  }

  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on('error', () => socket.destroy());
    let url: URL;
    try {
      url = new URL(req.url ?? '', 'http://gateway');
    } catch {
      return refuse(socket, 400, 'Bad Request');
    }
    if (url.pathname !== WS_PATH) return refuse(socket, 404, 'Not Found');
    const token = url.searchParams.get('token');
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      // Server -> client only: anything the client sends is ignored (and capped by maxPayload).
      ws.on('error', () => ws.terminate());
      this.alive.add(ws);
      ws.on('pong', () => this.alive.add(ws));
      void this.authenticate(ws, token);
    });
  };

  private async authenticate(ws: WebSocket, token: string | null): Promise<void> {
    if (!token) return ws.close(WS_CLOSE_UNAUTHORIZED, 'missing token');
    // Never log the token (or the URL it came in).
    const result = await this.verifier.verify(token).catch(() => null);
    if (ws.readyState !== ws.OPEN) return;
    if (!result) return ws.close(WS_CLOSE_INTERNAL, 'unable to verify token');
    if (!result.ok) {
      if (result.reason === 'unavailable') {
        return ws.close(WS_CLOSE_INTERNAL, 'unable to verify token');
      }
      return ws.close(WS_CLOSE_UNAUTHORIZED, 'invalid or expired token');
    }
    if (result.token.role !== 'admin') return ws.close(WS_CLOSE_FORBIDDEN, 'admin only');
    this.live.add(ws);
  }

  private ping(): void {
    for (const ws of this.wss.clients) {
      if (!this.alive.has(ws)) {
        ws.terminate();
        continue;
      }
      this.alive.delete(ws);
      ws.ping();
    }
  }
}

function refuse(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
