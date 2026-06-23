import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockLogInfo } = vi.hoisted(() => ({
  mockLogInfo: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: vi.fn().mockReturnValue({
    info: mockLogInfo,
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  getCachedAllow,
  recordAllow,
  clearSession,
  clearAll,
  invalidateByToolFamily,
  SESSION_TOOL_CACHE_TTL_MS,
  SESSION_TOMBSTONE_TTL_MS,
} from '../sessionToolDecisionCache';
import type { SafetyEvalResult } from '@core/safetyPromptTypes';

const baseAllowResult: SafetyEvalResult = {
  decision: 'allow',
  confidence: 'high',
  reason: 'Original allow reason',
};

const DEFAULT_FAMILY = 'other' as const;

describe('sessionToolDecisionCache', () => {
  beforeEach(() => {
    clearAll();
    mockLogInfo.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearAll();
  });

  it('round-trips a recorded allow', () => {
    recordAllow({
      sessionId: 'sess-1',
      normalizedKey: 'key-A',
      result: baseAllowResult,
      promptVersion: 7,
      toolFamily: DEFAULT_FAMILY,
    });

    const cached = getCachedAllow({
      sessionId: 'sess-1',
      normalizedKey: 'key-A',
      currentPromptVersion: 7,
    });

    expect(cached).not.toBeNull();
    expect(cached?.decision).toBe('allow');
    expect(cached?.reason).toBe('Original allow reason');
    expect(cached?.confidence).toBe('high');
    expect(cached?.promptVersion).toBe(7);
  });

  it('does not cache a recorded block', () => {
    recordAllow({
      sessionId: 'sess-1',
      normalizedKey: 'key-A',
      result: { decision: 'block', confidence: 'high', reason: 'unsafe' },
      promptVersion: 1,
      toolFamily: DEFAULT_FAMILY,
    });
    expect(
      getCachedAllow({ sessionId: 'sess-1', normalizedKey: 'key-A', currentPromptVersion: 1 }),
    ).toBeNull();
  });

  it('does not cache failClosed allows', () => {
    recordAllow({
      sessionId: 'sess-1',
      normalizedKey: 'key-A',
      result: {
        decision: 'allow',
        confidence: 'low',
        reason: 'Allow on failure fallback',
        failClosed: true,
      },
      promptVersion: 1,
      toolFamily: DEFAULT_FAMILY,
    });
    expect(
      getCachedAllow({ sessionId: 'sess-1', normalizedKey: 'key-A', currentPromptVersion: 1 }),
    ).toBeNull();
  });

  it('evicts on TTL expiry and emits ttl eviction log', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    recordAllow({
      sessionId: 'sess-1',
      normalizedKey: 'key-A',
      result: baseAllowResult,
      promptVersion: 1,
      toolFamily: DEFAULT_FAMILY,
    });

    vi.setSystemTime(new Date(Date.now() + SESSION_TOOL_CACHE_TTL_MS + 1_000));

    const cached = getCachedAllow({
      sessionId: 'sess-1',
      normalizedKey: 'key-A',
      currentPromptVersion: 1,
    });

    expect(cached).toBeNull();
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'safety.session_decision_cache_evicted',
        reason: 'ttl',
        sessionId: 'sess-1',
      }),
      expect.stringContaining('TTL'),
    );
  });

  it('evicts and emits log on prompt-version mismatch', () => {
    recordAllow({
      sessionId: 'sess-1',
      normalizedKey: 'key-A',
      result: baseAllowResult,
      promptVersion: 1,
      toolFamily: DEFAULT_FAMILY,
    });

    const cached = getCachedAllow({
      sessionId: 'sess-1',
      normalizedKey: 'key-A',
      currentPromptVersion: 2,
    });
    expect(cached).toBeNull();
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'safety.session_decision_cache_evicted',
        reason: 'prompt_version',
        sessionId: 'sess-1',
      }),
      expect.stringContaining('prompt-version'),
    );

    const reread = getCachedAllow({
      sessionId: 'sess-1',
      normalizedKey: 'key-A',
      currentPromptVersion: 1,
    });
    expect(reread).toBeNull();
  });

  it('clearSession removes only that session entries', () => {
    recordAllow({
      sessionId: 'sess-1',
      normalizedKey: 'key-A',
      result: baseAllowResult,
      promptVersion: 1,
      toolFamily: DEFAULT_FAMILY,
    });
    recordAllow({
      sessionId: 'sess-2',
      normalizedKey: 'key-A',
      result: baseAllowResult,
      promptVersion: 1,
      toolFamily: DEFAULT_FAMILY,
    });

    clearSession('sess-1');

    expect(
      getCachedAllow({ sessionId: 'sess-1', normalizedKey: 'key-A', currentPromptVersion: 1 }),
    ).toBeNull();
    expect(
      getCachedAllow({ sessionId: 'sess-2', normalizedKey: 'key-A', currentPromptVersion: 1 }),
    ).not.toBeNull();
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'safety.session_decision_cache_evicted',
        reason: 'session_clear',
        sessionId: 'sess-1',
      }),
      expect.stringContaining('session clear'),
    );
  });

  it('clearAll empties the cache', () => {
    recordAllow({
      sessionId: 'sess-1',
      normalizedKey: 'key-A',
      result: baseAllowResult,
      promptVersion: 1,
      toolFamily: DEFAULT_FAMILY,
    });
    recordAllow({
      sessionId: 'sess-2',
      normalizedKey: 'key-B',
      result: baseAllowResult,
      promptVersion: 1,
      toolFamily: DEFAULT_FAMILY,
    });

    clearAll();

    expect(
      getCachedAllow({ sessionId: 'sess-1', normalizedKey: 'key-A', currentPromptVersion: 1 }),
    ).toBeNull();
    expect(
      getCachedAllow({ sessionId: 'sess-2', normalizedKey: 'key-B', currentPromptVersion: 1 }),
    ).toBeNull();
  });

  it('emits no eviction log when clearSession is called on an empty session', () => {
    clearSession('never-existed');
    const evictionLogs = mockLogInfo.mock.calls.filter(
      (call) => (call[0] as Record<string, unknown>).event === 'safety.session_decision_cache_evicted',
    );
    expect(evictionLogs).toHaveLength(0);
  });

  describe('zombie session tombstones (Phase 4 fix)', () => {
    it('clearSession followed by recordAllow does not resurrect the session entry', () => {
      recordAllow({
        sessionId: 'sess-zombie',
        normalizedKey: 'key-A',
        result: baseAllowResult,
        promptVersion: 1,
        toolFamily: DEFAULT_FAMILY,
      });
      clearSession('sess-zombie');

      recordAllow({
        sessionId: 'sess-zombie',
        normalizedKey: 'key-B',
        result: baseAllowResult,
        promptVersion: 1,
        toolFamily: DEFAULT_FAMILY,
      });

      expect(
        getCachedAllow({ sessionId: 'sess-zombie', normalizedKey: 'key-B', currentPromptVersion: 1 }),
      ).toBeNull();
    });

    it('getCachedAllow returns null for a tombstoned session even if a stale entry leaks in', () => {
      recordAllow({
        sessionId: 'sess-tomb',
        normalizedKey: 'key-A',
        result: baseAllowResult,
        promptVersion: 1,
        toolFamily: DEFAULT_FAMILY,
      });
      clearSession('sess-tomb');
      expect(
        getCachedAllow({ sessionId: 'sess-tomb', normalizedKey: 'key-A', currentPromptVersion: 1 }),
      ).toBeNull();
    });

    it('tombstones expire after SESSION_TOMBSTONE_TTL_MS so a fresh session id can write again', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      recordAllow({
        sessionId: 'sess-revive',
        normalizedKey: 'key-A',
        result: baseAllowResult,
        promptVersion: 1,
        toolFamily: DEFAULT_FAMILY,
      });
      clearSession('sess-revive');

      vi.setSystemTime(new Date(Date.now() + SESSION_TOMBSTONE_TTL_MS + 1_000));

      recordAllow({
        sessionId: 'sess-revive',
        normalizedKey: 'key-A',
        result: baseAllowResult,
        promptVersion: 1,
        toolFamily: DEFAULT_FAMILY,
      });
      expect(
        getCachedAllow({ sessionId: 'sess-revive', normalizedKey: 'key-A', currentPromptVersion: 1 }),
      ).not.toBeNull();
    });

    it('a fresh clearSession after tombstone expiry behaves correctly', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      recordAllow({
        sessionId: 'sess-cycle',
        normalizedKey: 'key-A',
        result: baseAllowResult,
        promptVersion: 1,
        toolFamily: DEFAULT_FAMILY,
      });
      clearSession('sess-cycle');

      vi.setSystemTime(new Date(Date.now() + SESSION_TOMBSTONE_TTL_MS + 1_000));

      recordAllow({
        sessionId: 'sess-cycle',
        normalizedKey: 'key-A',
        result: baseAllowResult,
        promptVersion: 1,
        toolFamily: DEFAULT_FAMILY,
      });
      clearSession('sess-cycle');
      expect(
        getCachedAllow({ sessionId: 'sess-cycle', normalizedKey: 'key-A', currentPromptVersion: 1 }),
      ).toBeNull();
    });
  });

  describe('invalidateByToolFamily (negation invalidation)', () => {
    it('removes only entries whose toolFamily matches', () => {
      recordAllow({
        sessionId: 'sess-1',
        normalizedKey: 'key-send',
        result: baseAllowResult,
        promptVersion: 1,
        toolFamily: 'send_message',
      });
      recordAllow({
        sessionId: 'sess-1',
        normalizedKey: 'key-image',
        result: baseAllowResult,
        promptVersion: 1,
        toolFamily: 'image_generation',
      });

      const removed = invalidateByToolFamily('sess-1', 'send_message');
      expect(removed).toBe(1);
      expect(
        getCachedAllow({ sessionId: 'sess-1', normalizedKey: 'key-send', currentPromptVersion: 1 }),
      ).toBeNull();
      expect(
        getCachedAllow({ sessionId: 'sess-1', normalizedKey: 'key-image', currentPromptVersion: 1 }),
      ).not.toBeNull();
    });

    it('returns 0 when the session has no entries', () => {
      expect(invalidateByToolFamily('sess-empty', 'send_message')).toBe(0);
    });

    it('does NOT tombstone the session — subsequent recordAllow still writes', () => {
      recordAllow({
        sessionId: 'sess-resume',
        normalizedKey: 'key-send',
        result: baseAllowResult,
        promptVersion: 1,
        toolFamily: 'send_message',
      });
      invalidateByToolFamily('sess-resume', 'send_message');

      recordAllow({
        sessionId: 'sess-resume',
        normalizedKey: 'key-send-2',
        result: baseAllowResult,
        promptVersion: 1,
        toolFamily: 'send_message',
      });
      expect(
        getCachedAllow({
          sessionId: 'sess-resume',
          normalizedKey: 'key-send-2',
          currentPromptVersion: 1,
        }),
      ).not.toBeNull();
    });

    it('emits a negation eviction log when entries are removed', () => {
      recordAllow({
        sessionId: 'sess-1',
        normalizedKey: 'key-send',
        result: baseAllowResult,
        promptVersion: 1,
        toolFamily: 'send_message',
      });
      mockLogInfo.mockClear();
      invalidateByToolFamily('sess-1', 'send_message');
      expect(mockLogInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'safety.session_decision_cache_evicted',
          reason: 'negation',
          sessionId: 'sess-1',
          toolFamily: 'send_message',
        }),
        expect.any(String),
      );
    });
  });
});
