import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryUpdateStatus, TimeSavedStatus } from '@shared/types';
import { hashSessionIdForBreadcrumb } from '@shared/utils/hashSessionIdForBreadcrumb';
import { createSessionStore } from '../sessionStore';

vi.stubGlobal('window', {
  sessionsApi: { upsert: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) },
});

describe('sessionStore status setter cross-session guards', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('allows same-session memory status writes', () => {
    const store = createSessionStore();
    store.setState({
      currentSessionId: 'session-active',
      memoryUpdateStatusByTurn: {},
    });

    const status: MemoryUpdateStatus = {
      originalTurnId: 'turn-memory-apply',
      originalSessionId: 'session-active',
      status: 'running',
      timestamp: Date.now(),
    };

    store.getState().setMemoryUpdateStatus(status);

    expect(store.getState().memoryUpdateStatusByTurn['turn-memory-apply']).toEqual(status);
  });

  it('no-ops and warns once per turn on cross-session memory status writes', () => {
    const store = createSessionStore();
    store.setState({
      currentSessionId: 'session-active',
      memoryUpdateStatusByTurn: {},
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const status: MemoryUpdateStatus = {
      originalTurnId: 'turn-memory-drop',
      originalSessionId: 'session-other',
      status: 'success',
      timestamp: Date.now(),
    };

    store.getState().setMemoryUpdateStatus(status);
    store.getState().setMemoryUpdateStatus(status);

    expect(store.getState().memoryUpdateStatusByTurn['turn-memory-drop']).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[sessionStore] Ignored cross-session memory-update status setter call',
      expect.objectContaining({
        kind: 'memory-update',
        turnIdHash: hashSessionIdForBreadcrumb('turn-memory-drop'),
        currentSessionIdHash: hashSessionIdForBreadcrumb('session-active'),
        originalSessionIdHash: hashSessionIdForBreadcrumb('session-other'),
        stack: expect.any(String),
      }),
    );
  });

  it('no-ops and warns once per turn on cross-session time-saved status writes', () => {
    const store = createSessionStore();
    store.setState({
      currentSessionId: 'session-active',
      timeSavedStatusByTurn: {},
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const status: TimeSavedStatus = {
      turnId: 'turn-time-saved-drop',
      originalSessionId: 'session-other',
      status: 'error',
      error: 'cross-session',
      timestamp: Date.now(),
    };

    store.getState().setTimeSavedStatus(status);
    store.getState().setTimeSavedStatus(status);

    expect(store.getState().timeSavedStatusByTurn['turn-time-saved-drop']).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[sessionStore] Ignored cross-session time-saved status setter call',
      expect.objectContaining({
        kind: 'time-saved',
        turnIdHash: hashSessionIdForBreadcrumb('turn-time-saved-drop'),
        currentSessionIdHash: hashSessionIdForBreadcrumb('session-active'),
        originalSessionIdHash: hashSessionIdForBreadcrumb('session-other'),
        stack: expect.any(String),
      }),
    );
  });

  it('setActivitySummaryForSession writes the top-level map for the current session', () => {
    const store = createSessionStore();
    store.setState({
      currentSessionId: 'session-active',
      activitySummaryByTurn: {},
    });

    store.getState().setActivitySummaryForSession('session-active', 'turn-1', 'Pulled your Q3 numbers and drafted the update.');

    expect(store.getState().activitySummaryByTurn['turn-1']).toBe('Pulled your Q3 numbers and drafted the update.');
  });

  it('setActivitySummaryForSession patches a loaded (off-screen) session map without touching the current map', () => {
    const store = createSessionStore();
    const loaded = {
      id: 'session-other',
      title: 'Other',
      messages: [],
      eventsByTurn: {},
      createdAt: 1,
      updatedAt: 1,
      activitySummaryByTurn: { 'turn-existing': 'kept' },
    } as unknown as Parameters<ReturnType<typeof createSessionStore>['setState']>[0];
    store.setState({
      currentSessionId: 'session-active',
      activitySummaryByTurn: {},
      loadedSessions: new Map([['session-other', loaded as never]]),
    });

    store.getState().setActivitySummaryForSession('session-other', 'turn-2', 'Searched Slack and replied.');

    // Current session map untouched.
    expect(store.getState().activitySummaryByTurn['turn-2']).toBeUndefined();
    // Loaded session map patched additively (existing entry preserved).
    const updated = store.getState().loadedSessions.get('session-other') as { activitySummaryByTurn?: Record<string, string> };
    expect(updated?.activitySummaryByTurn).toEqual({ 'turn-existing': 'kept', 'turn-2': 'Searched Slack and replied.' });
  });

  it('setActivitySummaryForSession is a no-op when the session is neither current nor loaded', () => {
    const store = createSessionStore();
    store.setState({
      currentSessionId: 'session-active',
      activitySummaryByTurn: {},
      loadedSessions: new Map(),
    });

    store.getState().setActivitySummaryForSession('session-ghost', 'turn-x', 'should not land');

    expect(store.getState().activitySummaryByTurn['turn-x']).toBeUndefined();
    expect(store.getState().loadedSessions.has('session-ghost')).toBe(false);
  });

  it('refuses idle compaction error transitions for unmatched recovery turns', () => {
    const store = createSessionStore();
    store.setState({ currentSessionId: 'session-active' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    store.getState().setCompactionError(
      'Recovery failed: agent_loop_error_before_recovery',
      'turn-without-compaction',
      'session-active',
    );

    expect(store.getState().compaction.phase).toBe('idle');
    expect(warnSpy).toHaveBeenCalledWith(
      '[sessionStore] Ignored compaction error while compaction was idle',
      expect.objectContaining({
        incomingTurnIdHash: hashSessionIdForBreadcrumb('turn-without-compaction'),
        compactionTurnIdHash: null,
        currentSessionIdHash: hashSessionIdForBreadcrumb('session-active'),
        originalSessionIdHash: hashSessionIdForBreadcrumb('session-active'),
      }),
    );
  });

  it('refuses idle compaction error transitions even when the stale turn id matches', () => {
    const store = createSessionStore();
    store.setState({
      currentSessionId: 'session-active',
      compaction: {
        ...store.getState().compaction,
        phase: 'idle',
        originalSessionId: 'session-active',
        turnId: 'turn-stale-idle',
      },
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    store.getState().setCompactionError(
      'Recovery failed: summary_generation_failed',
      'turn-stale-idle',
      'session-active',
    );

    expect(store.getState().compaction.phase).toBe('idle');
    expect(warnSpy).toHaveBeenCalledWith(
      '[sessionStore] Ignored compaction error while compaction was idle',
      expect.objectContaining({
        incomingTurnIdHash: hashSessionIdForBreadcrumb('turn-stale-idle'),
        compactionTurnIdHash: hashSessionIdForBreadcrumb('turn-stale-idle'),
        currentSessionIdHash: hashSessionIdForBreadcrumb('session-active'),
        originalSessionIdHash: hashSessionIdForBreadcrumb('session-active'),
      }),
    );
  });

  it('treats repeated same-turn compaction errors during continuing as idempotent no-ops', () => {
    const store = createSessionStore();
    store.setState({ currentSessionId: 'session-active' });
    store.getState().startCompaction(1, 'session-active', 'turn-repeat');
    store.getState().markCompactionRetrying('turn-repeat', 'session-active');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const compactionBefore = store.getState().compaction;

    store.getState().setCompactionError(
      'Recovery failed: summary_generation_failed',
      'turn-repeat',
      'session-active',
    );
    store.getState().setCompactionError(
      'Recovery failed: summary_generation_failed',
      'turn-repeat',
      'session-active',
    );

    expect(store.getState().compaction).toBe(compactionBefore);
    expect(store.getState().compaction.phase).toBe('continuing');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('preserves the continuing-phase guard even when an exhausted reason is supplied (REBEL-5BM Stage 2)', () => {
    const store = createSessionStore();
    store.setState({ currentSessionId: 'session-active' });
    store.getState().startCompaction(1, 'session-active', 'turn-continuing');
    store.getState().completeCompaction('turn-continuing', 'session-active');
    expect(store.getState().compaction.phase).toBe('continuing');
    const compactionBefore = store.getState().compaction;

    // The new optional reason arg must not weaken the continuing guard: a late
    // recovery:failed for a turn already in `continuing` is still a no-op.
    store.getState().setCompactionError(
      'Recovery failed: agent_loop_error_after_recovery',
      'turn-continuing',
      'session-active',
      'agent_loop_error_after_recovery',
    );

    expect(store.getState().compaction).toBe(compactionBefore);
    expect(store.getState().compaction.phase).toBe('continuing');
    expect(store.getState().compaction.reason).toBeNull();
  });
});
