import { describe, expect, it } from 'vitest';
import { decideSend } from '../src/live/live-client';

const base = { limitBytes: 100, needsSnapshot: false, hasChange: true };

describe('decideSend (backpressure)', () => {
  it('sends a diff to a drained, current client', () => {
    expect(decideSend({ ...base, bufferedAmount: 0 })).toBe('diff');
    expect(decideSend({ ...base, bufferedAmount: 100 })).toBe('diff');
  });
  it('is idle without changes', () => {
    expect(decideSend({ ...base, bufferedAmount: 0, hasChange: false })).toBe('idle');
  });
  it('skips (and the caller owes a snapshot) above the threshold', () => {
    expect(decideSend({ ...base, bufferedAmount: 101 })).toBe('skip');
  });
  it('never sends diffs to a client that owes a snapshot; snapshots once drained', () => {
    expect(decideSend({ ...base, needsSnapshot: true, bufferedAmount: 500 })).toBe('idle');
    expect(decideSend({ ...base, needsSnapshot: true, bufferedAmount: 0 })).toBe('snapshot');
    expect(decideSend({ ...base, needsSnapshot: true, bufferedAmount: 0, hasChange: false })).toBe(
      'snapshot',
    );
  });
});
