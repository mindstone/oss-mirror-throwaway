import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupTranscriptionState,
  ensureRollingTranscriptState,
  getConversationState,
  getRollingTranscript,
} from '../meetingTranscriptionEngine';

const testSessionIds = new Set<string>();

function trackSession(sessionId: string): string {
  testSessionIds.add(sessionId);
  return sessionId;
}

afterEach(() => {
  for (const sessionId of testSessionIds) {
    cleanupTranscriptionState(sessionId);
  }
  testSessionIds.clear();
});

describe('meetingTranscriptionEngine rolling transcript state', () => {
  it('getRollingTranscript returns undefined for unknown session ids', () => {
    expect(getRollingTranscript('unknown-session')).toBeUndefined();
    expect(getConversationState('unknown-session')).toBeUndefined();
  });

  it('ensureRollingTranscriptState creates state idempotently', () => {
    const sessionId = trackSession('meeting-engine-ensure');

    const first = ensureRollingTranscriptState(sessionId);
    first.rollingTranscript = 'Initial transcript text';

    const second = ensureRollingTranscriptState(sessionId);

    expect(second).toBe(first);
    expect(getRollingTranscript(sessionId)).toBe('Initial transcript text');
  });
});
