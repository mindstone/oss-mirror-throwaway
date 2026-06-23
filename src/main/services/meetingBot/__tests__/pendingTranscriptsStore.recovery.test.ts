import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingTranscript } from '@shared/ipc/channels/meetingBot';

type PendingTranscriptsState = {
  version: number;
  transcripts: PendingTranscript[];
};

const mockStoreState = vi.hoisted(() => ({
  state: { version: 1, transcripts: [] as PendingTranscript[] },
}));

vi.mock('@core/storeFactory', () => ({
  createStore: vi.fn(() => ({
    get store() {
      return mockStoreState.state;
    },
    set store(next: PendingTranscriptsState) {
      mockStoreState.state = next;
    },
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
  })),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  addPendingTranscript,
  ensureRetryWindowStarted,
  getPendingTranscript,
  getTranscriptsNeedingSave,
  markExhaustedTranscriptsAsFailed,
  resetTransientFailedTranscripts,
  setNextRetryTime,
  updateLastRetryAt,
  updatePendingTranscriptStatus,
} from '../pendingTranscriptsStore';

describe('pendingTranscriptsStore recovery contract', () => {
  beforeEach(() => {
    mockStoreState.state = { version: 1, transcripts: [] };
  });

  it('resets recent failed transcripts to ready and requeues them for saving', () => {
    addPendingTranscript({
      botId: 'bot-reset',
      meetingUrl: 'https://example.com/meeting',
      meetingTitle: 'Recovery test',
      scheduledAt: new Date('2026-05-30T16:00:00.000Z').toISOString(),
      status: 'ready',
      saveAttempts: 4,
    });
    updatePendingTranscriptStatus('bot-reset', 'failed', 'Exceeded max save attempts (4)');

    expect(getPendingTranscript('bot-reset')?.status).toBe('failed');
    expect(getPendingTranscript('bot-reset')?.saveAttempts).toBe(4);

    const resetCount = resetTransientFailedTranscripts();
    expect(resetCount).toBe(1);

    const updated = getPendingTranscript('bot-reset');
    expect(updated?.status).toBe('ready');
    expect(updated?.saveAttempts).toBe(0);
    expect(updated?.failureReason).toBeUndefined();
    expect(updated?.errorMessage).toBeUndefined();

    expect(getTranscriptsNeedingSave().map((transcript) => transcript.botId)).toContain('bot-reset');
  });

  it('treats reset after code fix as fresh retry window', () => {
    addPendingTranscript({
      botId: 'bot-reset-window',
      meetingUrl: 'https://example.com/meeting-window',
      meetingTitle: 'Recovery window test',
      scheduledAt: new Date('2026-05-28T16:00:00.000Z').toISOString(),
      status: 'ready',
      saveAttempts: 6,
    });
    updatePendingTranscriptStatus('bot-reset-window', 'failed', 'Exceeded max save attempts (6)');

    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    mockStoreState.state = {
      ...mockStoreState.state,
      transcripts: mockStoreState.state.transcripts.map((transcript) =>
        transcript.botId === 'bot-reset-window'
          ? {
              ...transcript,
              createdAt: twoDaysAgo,
              lastRetryAt: oneHourAgo,
            }
          : transcript,
      ),
    };

    const resetCount = resetTransientFailedTranscripts();
    expect(resetCount).toBe(1);

    const updated = getPendingTranscript('bot-reset-window');
    expect(updated?.status).toBe('ready');
    expect(updated?.saveAttempts).toBe(0);

    expect(getTranscriptsNeedingSave().map((transcript) => transcript.botId)).toContain(
      'bot-reset-window',
    );
  });

  // Regression for the recovery bug found in dogfooding: after reset, the first retry
  // re-sets lastRetryAt. Without rebaselining the retry-duration window, markExhausted...
  // would immediately re-fail a >24h-old transcript ("Exceeded max retry duration"),
  // collapsing recovery. With retryWindowStartedAt set on reset, it must survive.
  it('does not re-fail a reset transcript whose retry then sets lastRetryAt (rebaselined window)', () => {
    addPendingTranscript({
      botId: 'bot-rebaseline',
      meetingUrl: 'https://example.com/rebaseline',
      meetingTitle: 'Rebaseline test',
      scheduledAt: new Date('2026-05-28T16:00:00.000Z').toISOString(),
      status: 'ready',
      saveAttempts: 6,
    });
    updatePendingTranscriptStatus('bot-rebaseline', 'failed', 'Exceeded max save attempts (6)');

    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    mockStoreState.state = {
      ...mockStoreState.state,
      transcripts: mockStoreState.state.transcripts.map((transcript) =>
        transcript.botId === 'bot-rebaseline'
          ? { ...transcript, createdAt: twoDaysAgo }
          : transcript,
      ),
    };

    resetTransientFailedTranscripts();
    // Simulate a retry attempt re-setting lastRetryAt (as processAndSaveTranscript does).
    updateLastRetryAt('bot-rebaseline');

    // The retry-age cap must NOT fire — retryWindowStartedAt was rebaselined to ~now on reset.
    expect(markExhaustedTranscriptsAsFailed()).toBe(0);
    expect(getPendingTranscript('bot-rebaseline')?.status).toBe('ready');
    expect(getTranscriptsNeedingSave().map((t) => t.botId)).toContain('bot-rebaseline');
  });

  // Converse: a transcript that was NEVER reset (no retryWindowStartedAt) and is older than
  // the retry-duration cap still gets capped — preserving the original anti-infinite-loop intent.
  it('still caps a never-reset transcript older than the retry-duration window', () => {
    addPendingTranscript({
      botId: 'bot-old-noreset',
      meetingUrl: 'https://example.com/old',
      meetingTitle: 'Old no-reset test',
      scheduledAt: new Date('2026-05-28T16:00:00.000Z').toISOString(),
      status: 'ready',
      saveAttempts: 1,
    });

    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    mockStoreState.state = {
      ...mockStoreState.state,
      transcripts: mockStoreState.state.transcripts.map((transcript) =>
        transcript.botId === 'bot-old-noreset'
          ? { ...transcript, createdAt: twoDaysAgo, lastRetryAt: oneHourAgo }
          : transcript,
      ),
    };

    expect(markExhaustedTranscriptsAsFailed()).toBe(1);
    expect(getPendingTranscript('bot-old-noreset')?.status).toBe('failed');
    expect(getPendingTranscript('bot-old-noreset')?.failureReason).toContain('max retry duration');
  });
});

// Bug B (DNS-starvation amplifier) retry-window fixes: the window must be anchored
// to the FIRST failure (set once, never moved forward), preserved across restarts
// (so the MAX_RETRY_HOURS cap actually elapses), and only rebaselined as a genuine
// second-chance once the prior window has already exhausted.
describe('pendingTranscriptsStore retry-window anchoring (Bug B)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-17T12:00:00.000Z'));
    mockStoreState.state = { version: 1, transcripts: [] };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ensureRetryWindowStarted anchors once and never moves the window forward', () => {
    addPendingTranscript({
      botId: 'bot-anchor',
      meetingUrl: 'https://example.com/anchor',
      meetingTitle: 'Anchor test',
      scheduledAt: new Date('2026-06-17T11:00:00.000Z').toISOString(),
      status: 'ready',
      saveAttempts: 0,
    });

    ensureRetryWindowStarted('bot-anchor');
    const firstAnchor = getPendingTranscript('bot-anchor')?.retryWindowStartedAt;
    expect(firstAnchor).toBeTruthy();

    // Advance time and re-anchor — the window must NOT move (idempotent).
    vi.advanceTimersByTime(3 * 60 * 60 * 1000); // +3h
    ensureRetryWindowStarted('bot-anchor');
    expect(getPendingTranscript('bot-anchor')?.retryWindowStartedAt).toBe(firstAnchor);
  });

  it('resetTransientFailedTranscripts PRESERVES a non-exhausted window (does not rebaseline)', () => {
    addPendingTranscript({
      botId: 'bot-preserve',
      meetingUrl: 'https://example.com/preserve',
      meetingTitle: 'Preserve window test',
      scheduledAt: new Date('2026-06-17T11:00:00.000Z').toISOString(),
      status: 'ready',
      saveAttempts: 0,
    });

    // Window anchored 2h ago (well under MAX_RETRY_HOURS=24h), transcript failed.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    mockStoreState.state = {
      ...mockStoreState.state,
      transcripts: mockStoreState.state.transcripts.map((t) =>
        t.botId === 'bot-preserve'
          ? { ...t, status: 'failed', retryWindowStartedAt: twoHoursAgo }
          : t,
      ),
    };

    expect(resetTransientFailedTranscripts()).toBe(1);

    const updated = getPendingTranscript('bot-preserve');
    expect(updated?.status).toBe('ready');
    // The window is PRESERVED (still 2h ago) — NOT rebaselined to now.
    expect(updated?.retryWindowStartedAt).toBe(twoHoursAgo);
  });

  it('grants a genuine second-chance window only once the prior window already exhausted', () => {
    addPendingTranscript({
      botId: 'bot-second-chance',
      meetingUrl: 'https://example.com/second',
      meetingTitle: 'Second chance test',
      scheduledAt: new Date('2026-06-15T11:00:00.000Z').toISOString(),
      status: 'ready',
      saveAttempts: 0,
    });

    // Window anchored 25h ago (> MAX_RETRY_HOURS=24h) → already exhausted.
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    mockStoreState.state = {
      ...mockStoreState.state,
      transcripts: mockStoreState.state.transcripts.map((t) =>
        t.botId === 'bot-second-chance'
          ? { ...t, status: 'failed', retryWindowStartedAt: twentyFiveHoursAgo }
          : t,
      ),
    };

    expect(resetTransientFailedTranscripts()).toBe(1);

    const updated = getPendingTranscript('bot-second-chance');
    expect(updated?.status).toBe('ready');
    // Prior window was exhausted → fresh window granted (~now).
    expect(updated?.retryWindowStartedAt).not.toBe(twentyFiveHoursAgo);
    expect(new Date(updated!.retryWindowStartedAt!).getTime()).toBe(Date.now());
  });

  // The storm-kill core: a still-`ready` transcript whose first-failure window is
  // past MAX_RETRY_HOURS survives a simulated restart (resetTransientFailedTranscripts
  // is a no-op on non-failed transcripts → window NOT rebaselined) and then gets
  // marked `failed` by markExhaustedTranscriptsAsFailed. RED before (the window was
  // rebaselined to now on every restart → it never exhausted → infinite retry storm).
  it('a ready transcript past MAX_RETRY_HOURS is not rebaselined by restart and exhausts to failed', () => {
    addPendingTranscript({
      botId: 'bot-exhaust',
      meetingUrl: 'https://example.com/exhaust',
      meetingTitle: 'Exhaust window test',
      scheduledAt: new Date('2026-06-15T11:00:00.000Z').toISOString(),
      status: 'ready',
      saveAttempts: 0,
    });

    // First failure anchored the window 25h ago; transcript is still 'ready' (it was
    // being retried every poll without ever exhausting — the storm).
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    mockStoreState.state = {
      ...mockStoreState.state,
      transcripts: mockStoreState.state.transcripts.map((t) =>
        t.botId === 'bot-exhaust'
          ? { ...t, retryWindowStartedAt: twentyFiveHoursAgo }
          : t,
      ),
    };

    // Simulated restart: reset is a NO-OP on a 'ready' transcript → window preserved.
    resetTransientFailedTranscripts();
    expect(getPendingTranscript('bot-exhaust')?.retryWindowStartedAt).toBe(twentyFiveHoursAgo);

    // Exhaustion fires off the preserved window even though lastRetryAt is unset.
    expect(markExhaustedTranscriptsAsFailed()).toBe(1);
    expect(getPendingTranscript('bot-exhaust')?.status).toBe('failed');
    expect(getPendingTranscript('bot-exhaust')?.failureReason).toContain('max retry duration');
    // And it stops being offered for save.
    expect(getTranscriptsNeedingSave().map((t) => t.botId)).not.toContain('bot-exhaust');
  });
});

describe('pendingTranscriptsStore nextRetryAt liveness', () => {
  const POLL_INTERVAL_MS = 5 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T12:00:00.000Z'));
    mockStoreState.state = { version: 1, transcripts: [] };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Mirrors offlineQueue self-progress: deferred by setNextRetryTime must become eligible
  // when time advances — the 5-min poll (meetingBotService) needs no manual wake.
  it('excludes a backoff-deferred transcript until nextRetryAt, then re-eligible for poll', () => {
    addPendingTranscript({
      botId: 'bot-backoff',
      meetingUrl: 'https://example.com/backoff',
      meetingTitle: 'Backoff liveness test',
      scheduledAt: new Date('2026-06-10T11:00:00.000Z').toISOString(),
      status: 'ready',
      saveAttempts: 0,
    });

    setNextRetryTime('bot-backoff');

    expect(getTranscriptsNeedingSave().map((t) => t.botId)).not.toContain('bot-backoff');

    vi.advanceTimersByTime(POLL_INTERVAL_MS + 1);

    expect(getTranscriptsNeedingSave().map((t) => t.botId)).toContain('bot-backoff');
  });
});
