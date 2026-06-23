import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLogInfo, mockLogWarn } = vi.hoisted(() => ({
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: vi.fn().mockReturnValue({
    info: mockLogInfo,
    warn: mockLogWarn,
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

const { mockGetSession } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
}));

vi.mock('@core/services/incrementalSessionStore', () => ({
  getIncrementalSessionStore: vi.fn().mockReturnValue({
    getSession: mockGetSession,
  }),
}));

import {
  buildSessionIntent,
  SESSION_INTENT_MAX_RECENT_MESSAGES,
  SESSION_INTENT_MAX_CHARS_PER_MESSAGE,
  SESSION_INTENT_MAX_TOTAL_CHARS,
} from '../sessionIntentProvider';

interface FakeMsg {
  role: 'user' | 'assistant' | 'result';
  text: string;
  isHidden?: boolean;
  deletedAt?: number;
}

function fakeSession(messages: FakeMsg[]) {
  return { id: 'sess-1', messages };
}

describe('sessionIntentProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for an undefined sessionId without touching the store', async () => {
    const result = await buildSessionIntent(undefined);
    expect(result).toBeNull();
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('returns null when the session has no user messages', async () => {
    mockGetSession.mockResolvedValueOnce(fakeSession([
      { role: 'assistant', text: 'Hello there' },
      { role: 'result', text: 'done' },
    ]));
    const result = await buildSessionIntent('sess-1');
    expect(result).toBeNull();
  });

  it('returns null when the session is missing or has no messages', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    expect(await buildSessionIntent('sess-1')).toBeNull();
    mockGetSession.mockResolvedValueOnce({ id: 'sess-1', messages: [] });
    expect(await buildSessionIntent('sess-1')).toBeNull();
  });

  it('captures only user-role messages, oldest-first', async () => {
    mockGetSession.mockResolvedValueOnce(fakeSession([
      { role: 'user', text: 'first user' },
      { role: 'assistant', text: 'an assistant reply' },
      { role: 'user', text: 'second user' },
      { role: 'user', text: 'third user' },
    ]));
    const result = await buildSessionIntent('sess-1');
    expect(result).not.toBeNull();
    expect(result?.recentUserMessages).toEqual(['first user', 'second user', 'third user']);
  });

  it('keeps only the last N user messages', async () => {
    const N = SESSION_INTENT_MAX_RECENT_MESSAGES;
    const messages: FakeMsg[] = [];
    for (let i = 1; i <= N + 3; i += 1) {
      messages.push({ role: 'user', text: `msg-${i}` });
    }
    mockGetSession.mockResolvedValueOnce(fakeSession(messages));
    const result = await buildSessionIntent('sess-1');
    expect(result?.recentUserMessages).toHaveLength(N);
    expect(result?.recentUserMessages[0]).toBe(`msg-4`);
    expect(result?.recentUserMessages[N - 1]).toBe(`msg-${N + 3}`);
  });

  it('truncates each message to the per-message char cap with U+2026 suffix', async () => {
    const long = 'a'.repeat(SESSION_INTENT_MAX_CHARS_PER_MESSAGE + 100);
    mockGetSession.mockResolvedValueOnce(fakeSession([
      { role: 'user', text: long },
    ]));
    const result = await buildSessionIntent('sess-1');
    expect(result?.recentUserMessages).toHaveLength(1);
    const out = result!.recentUserMessages[0];
    expect(out.length).toBe(SESSION_INTENT_MAX_CHARS_PER_MESSAGE + 1);
    expect(out.endsWith('…')).toBe(true);
  });

  it('drops oldest messages until the total budget fits', async () => {
    const len = SESSION_INTENT_MAX_CHARS_PER_MESSAGE;
    const sample = 'x'.repeat(len);
    mockGetSession.mockResolvedValueOnce(fakeSession([
      { role: 'user', text: sample },
      { role: 'user', text: sample },
      { role: 'user', text: sample },
      { role: 'user', text: sample },
      { role: 'user', text: sample },
    ]));
    const result = await buildSessionIntent('sess-1');
    expect(result).not.toBeNull();
    expect(result!.totalChars).toBeLessThanOrEqual(SESSION_INTENT_MAX_TOTAL_CHARS);
    expect(result!.recentUserMessages.length).toBeLessThanOrEqual(SESSION_INTENT_MAX_RECENT_MESSAGES);
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'safety.session_intent_truncated' }),
      expect.stringContaining('session-intent budget'),
    );
  });

  it('skips hidden, deleted, and empty user messages', async () => {
    mockGetSession.mockResolvedValueOnce(fakeSession([
      { role: 'user', text: 'visible' },
      { role: 'user', text: 'hidden', isHidden: true },
      { role: 'user', text: 'deleted', deletedAt: 1 },
      { role: 'user', text: '   ' },
      { role: 'user', text: 'last' },
    ]));
    const result = await buildSessionIntent('sess-1');
    expect(result?.recentUserMessages).toEqual(['visible', 'last']);
  });

  it('returns null and logs warn when the session store throws', async () => {
    mockGetSession.mockRejectedValueOnce(new Error('store unavailable'));
    const result = await buildSessionIntent('sess-1');
    expect(result).toBeNull();
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'safety.session_intent_provider_error' }),
      expect.stringContaining('Failed to build session intent'),
    );
  });

  it('totalChars matches the sum of trimmed message lengths', async () => {
    mockGetSession.mockResolvedValueOnce(fakeSession([
      { role: 'user', text: 'aaa' },
      { role: 'user', text: 'bbbbb' },
      { role: 'user', text: 'cc' },
    ]));
    const result = await buildSessionIntent('sess-1');
    expect(result?.totalChars).toBe(3 + 5 + 2);
  });
});
