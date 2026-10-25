import type { WebSocket } from 'ws';

export interface LiveClient {
  socket: WebSocket;
  /** User ids whose display info this connection has already received. */
  sentUsers: Set<string>;
  /**
   * True until the client holds a complete, current picture: before its first snapshot, and after
   * a diff was skipped for backpressure. A client owing a snapshot never receives diffs.
   */
  needsSnapshot: boolean;
}

export type SendDecision =
  /** Nothing to deliver. */
  | 'idle'
  /** Send a diff. */
  | 'diff'
  /** Send a fresh snapshot (the client was behind or is new). */
  | 'snapshot'
  /** Too much unsent data buffered: drop this update and owe the client a snapshot. */
  | 'skip';

/**
 * Decides what a client gets this tick. Diffs are only ever sent to a client that is current and
 * drained, so a client can never apply diffs out of order or across a gap.
 */
export function decideSend(input: {
  bufferedAmount: number;
  limitBytes: number;
  needsSnapshot: boolean;
  hasChange: boolean;
}): SendDecision {
  const congested = input.bufferedAmount > input.limitBytes;
  if (input.needsSnapshot) return congested ? 'idle' : 'snapshot';
  if (!input.hasChange) return 'idle';
  return congested ? 'skip' : 'diff';
}
