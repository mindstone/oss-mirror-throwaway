import { describe, expect, it } from 'vitest';
import { sanitizeLoadedState } from '../sanitizeLoadedState';

const base = {
  sessionId: 's1',
  status: 'recording',
  meetingStartTime: 123,
  startedAt: 'start',
  updatedAt: 'update',
  chunks: [],
};

describe('sanitizeLoadedState', () => {
  it('accepts a valid state', () => {
    expect(sanitizeLoadedState(base)).toMatchObject(base);
  });

  it('rejects missing session id', () => {
    expect(sanitizeLoadedState({ ...base, sessionId: '' })).toBeNull();
  });

  it('rejects unsupported statuses', () => {
    expect(sanitizeLoadedState({ ...base, status: 'paused' })).toBeNull();
  });

  it('filters invalid chunks while preserving valid chunks', () => {
    const state = sanitizeLoadedState({
      ...base,
      chunks: [
        { index: 0, idempotencyKey: 'k', hash: 'h', receivedAt: 'r', fileName: 'chunk_0.m4a', sizeBytes: 12 },
        { index: -1, idempotencyKey: 'bad', hash: 'h', receivedAt: 'r', fileName: 'x', sizeBytes: 1 },
      ],
    });
    expect(state?.chunks).toHaveLength(1);
    expect(state?.chunks[0]?.index).toBe(0);
  });

  it('preserves explicit null companionSessionId values', () => {
    const state = sanitizeLoadedState({
      ...base,
      companionSessionId: null,
    });
    expect(state?.companionSessionId).toBeNull();
  });
});
