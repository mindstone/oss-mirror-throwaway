/**
 * Stage 2 observability (Josh operational-specialist F2): every terminal `failed`
 * transition must emit a structured, auditable record so "failed" can never
 * silently mean a recoverable transcript (saved/live path still present) was
 * abandoned. We assert the log fires with the required fields:
 *   botId, saveAttempts, retryWindowStartedAt, lastRetryAt, terminalReason,
 *   terminalClass, hasSavedPath, hasLiveTranscriptPath.
 *
 * Covers BOTH terminal sites:
 *   - markExhaustedTranscriptsAsFailed (sets status directly)
 *   - updatePendingTranscriptStatus(..., 'failed', ...) (the 403/404/stale path)
 * and asserts no transcript CONTENT/secrets leak (paths logged as booleans only).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingTranscript } from '@shared/ipc/channels/meetingBot';

type PendingTranscriptsState = {
  version: number;
  transcripts: PendingTranscript[];
};

const mockStoreState = vi.hoisted(() => ({
  state: { version: 1, transcripts: [] as PendingTranscript[] },
}));

const logMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
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
  createScopedLogger: () => logMock,
}));

import {
  addPendingTranscript,
  markExhaustedTranscriptsAsFailed,
  updatePendingTranscriptStatus,
} from '../pendingTranscriptsStore';

/** Find the most recent `log.warn` call whose message marks a terminal failed state. */
function lastTerminalWarn(): { fields: Record<string, unknown>; message: string } | undefined {
  for (let i = logMock.warn.mock.calls.length - 1; i >= 0; i -= 1) {
    const [fields, message] = logMock.warn.mock.calls[i] as [Record<string, unknown>, string];
    if (typeof message === 'string' && message.includes('terminal failed state')) {
      return { fields, message };
    }
  }
  return undefined;
}

const REQUIRED_AUDIT_FIELDS = [
  'botId',
  'saveAttempts',
  'retryWindowStartedAt',
  'lastRetryAt',
  'terminalReason',
  'terminalClass',
  'hasSavedPath',
  'hasLiveTranscriptPath',
] as const;

describe('pendingTranscriptsStore terminal-failed audit log (Stage 2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-17T12:00:00.000Z'));
    mockStoreState.state = { version: 1, transcripts: [] };
    logMock.warn.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('markExhaustedTranscriptsAsFailed emits the audit record on attempts exhaustion', () => {
    addPendingTranscript({
      botId: 'bot-attempts',
      meetingUrl: 'https://example.com/m',
      meetingTitle: 'Attempts exhausted',
      scheduledAt: new Date('2026-06-17T11:00:00.000Z').toISOString(),
      status: 'ready',
      saveAttempts: 6,
    });
    // Give it a live transcript path so the recoverability audit is exercised.
    mockStoreState.state.transcripts = mockStoreState.state.transcripts.map((t) =>
      t.botId === 'bot-attempts'
        ? { ...t, liveTranscriptPath: '/secret/path/to/live.md', lastRetryAt: new Date('2026-06-17T11:30:00.000Z').toISOString() }
        : t,
    );

    expect(markExhaustedTranscriptsAsFailed()).toBe(1);

    const warn = lastTerminalWarn();
    expect(warn).toBeDefined();
    for (const field of REQUIRED_AUDIT_FIELDS) {
      expect(warn!.fields).toHaveProperty(field);
    }
    expect(warn!.fields.botId).toBe('bot-attempts');
    expect(warn!.fields.saveAttempts).toBe(6);
    expect(warn!.fields.terminalClass).toBe('attempts_exhausted');
    // Recoverability audit: a live transcript path still exists → flagged true.
    expect(warn!.fields.hasLiveTranscriptPath).toBe(true);
    expect(warn!.fields.hasSavedPath).toBe(false);
    // No path STRING / content leaked — only the boolean presence.
    expect(JSON.stringify(warn!.fields)).not.toContain('/secret/path');
  });

  it('markExhaustedTranscriptsAsFailed emits the audit record on retry-window exhaustion', () => {
    addPendingTranscript({
      botId: 'bot-window',
      meetingUrl: 'https://example.com/m',
      meetingTitle: 'Window exhausted',
      scheduledAt: new Date('2026-06-15T11:00:00.000Z').toISOString(),
      status: 'ready',
      saveAttempts: 1,
    });
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    mockStoreState.state.transcripts = mockStoreState.state.transcripts.map((t) =>
      t.botId === 'bot-window' ? { ...t, retryWindowStartedAt: twentyFiveHoursAgo } : t,
    );

    expect(markExhaustedTranscriptsAsFailed()).toBe(1);

    const warn = lastTerminalWarn();
    expect(warn).toBeDefined();
    expect(warn!.fields.terminalClass).toBe('retry_window_exhausted');
    expect(warn!.fields.retryWindowStartedAt).toBe(twentyFiveHoursAgo);
  });

  it('updatePendingTranscriptStatus(..., "failed") emits the audit record (403/permanent path)', () => {
    addPendingTranscript({
      botId: 'bot-403',
      meetingUrl: 'https://example.com/m',
      meetingTitle: 'Permanent failure',
      scheduledAt: new Date('2026-06-17T11:00:00.000Z').toISOString(),
      status: 'ready',
      saveAttempts: 2,
    });

    updatePendingTranscriptStatus('bot-403', 'failed', 'Bot expired on Recall side (403)');

    const warn = lastTerminalWarn();
    expect(warn).toBeDefined();
    expect(warn!.fields.botId).toBe('bot-403');
    expect(warn!.fields.terminalClass).toBe('permanent');
    expect(warn!.fields.terminalReason).toBe('Bot expired on Recall side (403)');
    for (const field of REQUIRED_AUDIT_FIELDS) {
      expect(warn!.fields).toHaveProperty(field);
    }
  });

  it('does NOT emit a terminal audit log for a non-failed status transition', () => {
    addPendingTranscript({
      botId: 'bot-ok',
      meetingUrl: 'https://example.com/m',
      meetingTitle: 'Still going',
      scheduledAt: new Date('2026-06-17T11:00:00.000Z').toISOString(),
      status: 'ready',
      saveAttempts: 0,
    });

    updatePendingTranscriptStatus('bot-ok', 'processing');

    expect(lastTerminalWarn()).toBeUndefined();
  });
});
