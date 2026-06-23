import { afterEach, describe, expect, it } from 'vitest';
import {
  buildMeetingTranscriptContext,
} from '../meetingTranscriptContext';
import {
  cleanupTranscriptionState,
  ensureRollingTranscriptState,
} from '../meetingTranscriptionEngine';

const testSessionIds = new Set<string>();

function registerSession(sessionId: string): string {
  testSessionIds.add(sessionId);
  return sessionId;
}

afterEach(() => {
  for (const sessionId of testSessionIds) {
    cleanupTranscriptionState(sessionId);
  }
  testSessionIds.clear();
});

describe('buildMeetingTranscriptContext', () => {
  it("returns unknown-session(no-meeting-id) when recording is active but session id is missing", () => {
    const result = buildMeetingTranscriptContext({
      recordingActive: true,
      meetingSessionId: undefined,
    });

    expect(result).toEqual({
      kind: 'unknown-session',
      reason: 'no-meeting-id',
    });
  });

  it("returns unknown-session(no-engine-state) when meeting session id is unknown", () => {
    const result = buildMeetingTranscriptContext({
      meetingSessionId: 'missing-session',
      recordingActive: true,
    });

    expect(result).toEqual({
      kind: 'unknown-session',
      reason: 'no-engine-state',
    });
  });

  it('returns empty-transcript when session exists but transcript has no words', () => {
    const meetingSessionId = registerSession('meeting-empty-transcript');
    const state = ensureRollingTranscriptState(meetingSessionId);
    state.rollingTranscript = '   \n  ';

    const result = buildMeetingTranscriptContext({
      meetingSessionId,
      recordingActive: true,
    });

    expect(result).toEqual({ kind: 'empty-transcript' });
  });

  it('returns empty-transcript when transcript has only emoji content', () => {
    const meetingSessionId = registerSession('meeting-emoji-only-transcript');
    const state = ensureRollingTranscriptState(meetingSessionId);
    state.rollingTranscript = '🙂';

    const result = buildMeetingTranscriptContext({
      meetingSessionId,
      recordingActive: true,
    });

    expect(result).toEqual({ kind: 'empty-transcript' });
  });

  it('returns empty-transcript when transcript has only punctuation content', () => {
    const meetingSessionId = registerSession('meeting-punctuation-only-transcript');
    const state = ensureRollingTranscriptState(meetingSessionId);
    state.rollingTranscript = '!!!';

    const result = buildMeetingTranscriptContext({
      meetingSessionId,
      recordingActive: true,
    });

    expect(result).toEqual({ kind: 'empty-transcript' });
  });

  it('returns context text when session has transcript content', () => {
    const meetingSessionId = registerSession('meeting-has-context');
    const state = ensureRollingTranscriptState(meetingSessionId);
    state.rollingTranscript = 'Alice: Launch date is June 12.';
    state.conversationState = {
      currentTopic: 'Launch planning',
      summary: 'Finalized release date',
      openQuestions: ['Do we need a fallback date?'],
      recentDecisions: ['Launch on June 12'],
    };

    const result = buildMeetingTranscriptContext({
      meetingSessionId,
      recordingActive: true,
    });

    expect(result).not.toBeNull();
    expect(result?.kind).toBe('context');
    if (result?.kind !== 'context') return;

    expect(result.text).toContain('[CONVERSATION STATE]');
    expect(result.text).toContain('Topic: Launch planning');
    expect(result.text).toContain('[MEETING TRANSCRIPT SO FAR]');
    expect(result.text).toContain('Alice: Launch date is June 12.');
  });

  it('returns context when transcript has at least one alphanumeric character', () => {
    const meetingSessionId = registerSession('meeting-alphanumeric-and-emoji');
    const state = ensureRollingTranscriptState(meetingSessionId);
    state.rollingTranscript = 'hi 🙂';

    const result = buildMeetingTranscriptContext({
      meetingSessionId,
      recordingActive: true,
    });

    expect(result).not.toBeNull();
    expect(result?.kind).toBe('context');
  });

  it('returns null when no recording context is present', () => {
    const result = buildMeetingTranscriptContext({
      recordingActive: false,
      meetingSessionId: undefined,
    });

    expect(result).toBeNull();
  });
});
