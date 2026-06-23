import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSessionStore } from '../sessionStore';
import type { AgentSessionWithRuntime } from '../../types';

/**
 * Regression tests for background session compaction (FOX-XXXX).
 *
 * Bug: handleContextOverflow used currentSessionId instead of the turn's
 * sessionId parameter. When a background turn hit context overflow while
 * the user viewed a different conversation, compaction targeted the wrong
 * session — injecting cross-conversation prompts.
 *
 * These tests verify the store-level fix: performCompaction with a
 * targetSessionId correctly updates loadedSessions (not current session),
 * and the new background session helper methods work correctly.
 */

beforeEach(() => {
  vi.stubGlobal('window', {
    sessionsApi: {
      get: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    },
    agentApi: {
      stopTurn: vi.fn().mockResolvedValue(undefined),
    },
  });
});

function createBackgroundSession(store: ReturnType<typeof createSessionStore>, sessionId: string): void {
  store.getState().createBackgroundSession(sessionId, 'manual');
  // Add some messages to simulate a real conversation
  const session = store.getState().loadedSessions.get(sessionId);
  if (!session) throw new Error('Session not created');
  const updated: AgentSessionWithRuntime = {
    ...session,
    messages: [
      { id: 'msg-1', turnId: 'turn-1', role: 'user', text: 'Hello from background', createdAt: 1 },
      { id: 'msg-2', turnId: 'turn-1', role: 'result', text: 'Background response', createdAt: 2 },
    ],
    eventsByTurn: { 'turn-1': [{ type: 'result', text: 'Background response', timestamp: 2 }] },
    activeTurnId: 'turn-1',
    isBusy: false,
  };
  const nextMap = new Map(store.getState().loadedSessions);
  nextMap.set(sessionId, updated);
  store.setState({ loadedSessions: nextMap });
}

describe('performCompaction with background targetSessionId', () => {
  it('updates loadedSessions instead of current session state', () => {
    const store = createSessionStore();
    const bgSessionId = 'bg-session-compact';
    createBackgroundSession(store, bgSessionId);

    const currentSessionBefore = store.getState().currentSessionId;
    const currentMessagesBefore = [...store.getState().messages];

    store.getState().performCompaction('Summary of background conversation', 1, bgSessionId);

    // Current session should be untouched
    expect(store.getState().currentSessionId).toBe(currentSessionBefore);
    expect(store.getState().messages).toEqual(currentMessagesBefore);
    expect(store.getState().compactionBoundaries).toEqual([]);

    // Background session should be compacted
    const bgSession = store.getState().loadedSessions.get(bgSessionId);
    expect(bgSession).toBeDefined();
    expect(bgSession!.eventsByTurn).toEqual({});
    expect(bgSession!.activeTurnId).toBeNull();
    expect(bgSession!.isBusy).toBe(false);
    expect(bgSession!.lastError).toBeNull();
    expect(bgSession!.compactionBoundaries).toHaveLength(1);
    expect(bgSession!.compactionBoundaries![0]).toMatchObject({
      afterMessageIndex: 1,
      summary: 'Summary of background conversation',
      depth: 1,
    });
  });

  it('resets runtime state on background session', () => {
    const store = createSessionStore();
    const bgSessionId = 'bg-session-runtime';
    createBackgroundSession(store, bgSessionId);

    // Simulate active runtime state
    const session = store.getState().loadedSessions.get(bgSessionId)!;
    const nextMap = new Map(store.getState().loadedSessions);
    nextMap.set(bgSessionId, {
      ...session,
      runtime: {
        startedAt: 12345,
        lastActivityAt: 67890,
        activeTurnId: session.runtime?.activeTurnId ?? null,
        terminated: false,
      },
    });
    store.setState({ loadedSessions: nextMap });

    store.getState().performCompaction('Summary', 1, bgSessionId);

    const compacted = store.getState().loadedSessions.get(bgSessionId)!;
    expect(compacted.runtime!.startedAt).toBeNull();
    expect(compacted.runtime!.lastActivityAt).toBeNull();
  });

  it('is a no-op if background session not in loadedSessions', () => {
    const store = createSessionStore();
    const stateBefore = store.getState();

    store.getState().performCompaction('Summary', 1, 'nonexistent-session');

    // Neither background nor foreground state should change
    expect(store.getState().loadedSessions).toBe(stateBefore.loadedSessions);
    expect(store.getState().compactionBoundaries).toEqual([]);
    expect(store.getState().activeTurnId).toBe(stateBefore.activeTurnId);
    expect(store.getState().isBusy).toBe(stateBefore.isBusy);
  });

  it('falls through to foreground path when targetSessionId matches currentSessionId', () => {
    const store = createSessionStore();
    const currentId = store.getState().currentSessionId;

    store.getState().performCompaction('Summary', 1, currentId);

    // Should have compacted current session (foreground behavior)
    expect(store.getState().compactionBoundaries).toHaveLength(1);
    expect(store.getState().activeTurnId).toBeNull();
    expect(store.getState().isBusy).toBe(false);
  });

  it('falls through to foreground path when targetSessionId is undefined', () => {
    const store = createSessionStore();

    store.getState().performCompaction('Summary', 1);

    expect(store.getState().compactionBoundaries).toHaveLength(1);
  });
});

describe('addUserMessageToLoadedSession', () => {
  it('appends a user message and sets isBusy=true', () => {
    const store = createSessionStore();
    const bgSessionId = 'bg-session-msg';
    createBackgroundSession(store, bgSessionId);

    const msg = store.getState().addUserMessageToLoadedSession(bgSessionId, 'Compacted prompt');

    expect(msg).not.toBeNull();
    expect(msg!.role).toBe('user');
    expect(msg!.text).toBe('Compacted prompt');

    const session = store.getState().loadedSessions.get(bgSessionId)!;
    expect(session.messages).toHaveLength(3); // 2 original + 1 new
    expect(session.messages[2].text).toBe('Compacted prompt');
    expect(session.isBusy).toBe(true);
    expect(session.lastError).toBeNull();
  });

  it('returns null if session not in loadedSessions', () => {
    const store = createSessionStore();
    const msg = store.getState().addUserMessageToLoadedSession('nonexistent', 'Hello');
    expect(msg).toBeNull();
  });

  it('does not affect current session state', () => {
    const store = createSessionStore();
    const bgSessionId = 'bg-session-no-leak';
    createBackgroundSession(store, bgSessionId);

    const msgsBefore = store.getState().messages.length;
    store.getState().addUserMessageToLoadedSession(bgSessionId, 'Should not appear in current');

    expect(store.getState().messages).toHaveLength(msgsBefore);
  });
});

describe('assignTurnToLoadedSessionMessage', () => {
  it('assigns turnId to message and initializes eventsByTurn', () => {
    const store = createSessionStore();
    const bgSessionId = 'bg-session-assign';
    createBackgroundSession(store, bgSessionId);

    const msg = store.getState().addUserMessageToLoadedSession(bgSessionId, 'Compacted prompt');
    store.getState().assignTurnToLoadedSessionMessage(bgSessionId, msg!.id, 'new-turn-123');

    const session = store.getState().loadedSessions.get(bgSessionId)!;
    const assigned = session.messages.find(m => m.id === msg!.id);
    expect(assigned!.turnId).toBe('new-turn-123');
    expect(session.eventsByTurn['new-turn-123']).toEqual([]);
    expect(session.activeTurnId).toBe('new-turn-123');
  });
});

describe('clearLoadedSessionBusy', () => {
  it('clears isBusy on a loaded session', () => {
    const store = createSessionStore();
    const bgSessionId = 'bg-session-busy';
    createBackgroundSession(store, bgSessionId);

    // Set busy via addUserMessage
    store.getState().addUserMessageToLoadedSession(bgSessionId, 'Compacted');
    expect(store.getState().loadedSessions.get(bgSessionId)!.isBusy).toBe(true);

    store.getState().clearLoadedSessionBusy(bgSessionId);
    expect(store.getState().loadedSessions.get(bgSessionId)!.isBusy).toBe(false);
  });

  it('is a no-op if session not busy', () => {
    const store = createSessionStore();
    const bgSessionId = 'bg-session-not-busy';
    createBackgroundSession(store, bgSessionId);

    const mapBefore = store.getState().loadedSessions;
    store.getState().clearLoadedSessionBusy(bgSessionId);
    // Should be reference-equal (no unnecessary update)
    expect(store.getState().loadedSessions).toBe(mapBefore);
  });

  it('is a no-op if session not in loadedSessions', () => {
    const store = createSessionStore();
    const mapBefore = store.getState().loadedSessions;
    store.getState().clearLoadedSessionBusy('nonexistent');
    expect(store.getState().loadedSessions).toBe(mapBefore);
  });
});

/**
 * Full-sequence integration tests for background compaction.
 *
 * These cover the exact bug seam from the 260331 cross-conversation compaction
 * postmortem: the 3-step sequence (performCompaction → addUserMessageToLoadedSession
 * → assignTurnToLoadedSessionMessage) targeting a background session while the
 * current session must remain untouched.
 */
describe('full background compaction sequence', () => {
  /** Populates the current (foreground) session with realistic messages and events. */
  function populateCurrentSession(store: ReturnType<typeof createSessionStore>): void {
    store.setState({
      messages: [
        { id: 'current-msg-1', turnId: 'current-turn-1', role: 'user', text: 'Hello from current session', createdAt: 100 },
        { id: 'current-msg-2', turnId: 'current-turn-1', role: 'result', text: 'Response in current session', createdAt: 200 },
        { id: 'current-msg-3', turnId: 'current-turn-2', role: 'user', text: 'Follow-up in current session', createdAt: 300 },
      ],
      activeTurnId: 'current-turn-2',
      isBusy: false,
    });
  }

  it('preserves current session when compacting a background session', () => {
    const store = createSessionStore();
    const bgSessionId = 'bg-full-sequence';

    populateCurrentSession(store);
    createBackgroundSession(store, bgSessionId);

    // Snapshot current session state before compaction
    const snapshot = {
      currentSessionId: store.getState().currentSessionId,
      messages: [...store.getState().messages],
      compactionBoundaries: [...store.getState().compactionBoundaries],
      activeTurnId: store.getState().activeTurnId,
      isBusy: store.getState().isBusy,
    };

    // Step 1: Compact background session
    store.getState().performCompaction('Summary of background conversation', 1, bgSessionId);

    // Step 2: Add compacted retry message to background session
    const retryMsg = store.getState().addUserMessageToLoadedSession(
      bgSessionId,
      '[COMPACTION_DEPTH:1]\n=== SUMMARY ===\nSummary of background conversation\n=== CONTINUE ===\nRetry prompt'
    );
    expect(retryMsg).not.toBeNull();

    // Step 3: Bind the retry message to a new turn
    store.getState().assignTurnToLoadedSessionMessage(bgSessionId, retryMsg!.id, 'retry-turn-bg');

    // Current session must be IDENTICAL to snapshot
    expect(store.getState().currentSessionId).toBe(snapshot.currentSessionId);
    expect(store.getState().messages).toEqual(snapshot.messages);
    expect(store.getState().compactionBoundaries).toEqual(snapshot.compactionBoundaries);
    expect(store.getState().activeTurnId).toBe(snapshot.activeTurnId);
    expect(store.getState().isBusy).toBe(snapshot.isBusy);

    // Background session should have compacted state
    const bgSession = store.getState().loadedSessions.get(bgSessionId)!;
    expect(bgSession).toBeDefined();
    expect(bgSession.compactionBoundaries).toHaveLength(1);
    expect(bgSession.compactionBoundaries![0]).toMatchObject({
      afterMessageIndex: 1, // original messages had index 0 and 1
      summary: 'Summary of background conversation',
      depth: 1,
    });
    // Old events cleared by performCompaction, new turn entry created by assignTurnToLoadedSessionMessage
    expect(bgSession.eventsByTurn).toEqual({ 'retry-turn-bg': [] });
    // Retry message present with correct text and turn binding
    const retryInSession = bgSession.messages.find(m => m.id === retryMsg!.id);
    expect(retryInSession).toBeDefined();
    expect(retryInSession!.text).toContain('COMPACTION_DEPTH:1');
    expect(retryInSession!.text).toContain('Summary of background conversation');
    expect(retryInSession!.turnId).toBe('retry-turn-bg');
    // Active turn updated
    expect(bgSession.activeTurnId).toBe('retry-turn-bg');
    // isBusy set by addUserMessageToLoadedSession (still true — clearLoadedSessionBusy not called)
    expect(bgSession.isBusy).toBe(true);
  });

  it('compacts multiple background sessions independently without cross-contamination', () => {
    const store = createSessionStore();
    const bgSessionB = 'bg-multi-B';
    const bgSessionC = 'bg-multi-C';

    populateCurrentSession(store);
    createBackgroundSession(store, bgSessionB);
    createBackgroundSession(store, bgSessionC);

    // Snapshot current session
    const currentSnapshot = {
      messages: [...store.getState().messages],
      compactionBoundaries: [...store.getState().compactionBoundaries],
      activeTurnId: store.getState().activeTurnId,
    };

    // Compact session B
    store.getState().performCompaction('Summary of session B', 1, bgSessionB);
    const msgB = store.getState().addUserMessageToLoadedSession(bgSessionB, 'Retry prompt for B');
    expect(msgB).not.toBeNull();

    // Compact session C
    store.getState().performCompaction('Summary of session C', 2, bgSessionC);
    const msgC = store.getState().addUserMessageToLoadedSession(bgSessionC, 'Retry prompt for C');
    expect(msgC).not.toBeNull();

    // Current session A untouched
    expect(store.getState().messages).toEqual(currentSnapshot.messages);
    expect(store.getState().compactionBoundaries).toEqual(currentSnapshot.compactionBoundaries);
    expect(store.getState().activeTurnId).toBe(currentSnapshot.activeTurnId);

    // Session B has its own compaction
    const sessionB = store.getState().loadedSessions.get(bgSessionB)!;
    expect(sessionB.compactionBoundaries).toHaveLength(1);
    expect(sessionB.compactionBoundaries![0].summary).toBe('Summary of session B');
    expect(sessionB.compactionBoundaries![0].depth).toBe(1);
    expect(sessionB.messages.find(m => m.id === msgB!.id)!.text).toBe('Retry prompt for B');
    // No contamination from C
    expect(sessionB.messages.find(m => m.text === 'Retry prompt for C')).toBeUndefined();

    // Session C has its own compaction
    const sessionC = store.getState().loadedSessions.get(bgSessionC)!;
    expect(sessionC.compactionBoundaries).toHaveLength(1);
    expect(sessionC.compactionBoundaries![0].summary).toBe('Summary of session C');
    expect(sessionC.compactionBoundaries![0].depth).toBe(2);
    expect(sessionC.messages.find(m => m.id === msgC!.id)!.text).toBe('Retry prompt for C');
    // No contamination from B
    expect(sessionC.messages.find(m => m.text === 'Retry prompt for B')).toBeUndefined();
  });

  it('regression guard: compaction targeting currentSessionId compacts the active session (protection is at hook level)', () => {
    const store = createSessionStore();
    const bgSessionId = 'bg-regression-guard';

    populateCurrentSession(store);
    createBackgroundSession(store, bgSessionId);

    const currentSessionId = store.getState().currentSessionId;
    const bgSessionBefore = { ...store.getState().loadedSessions.get(bgSessionId)! };

    // Deliberately target the CURRENT session ID — simulates the pre-fix bug path
    store.getState().performCompaction('Summary of current', 1, currentSessionId);

    // Current session IS compacted (foreground path triggered)
    expect(store.getState().compactionBoundaries).toHaveLength(1);
    expect(store.getState().compactionBoundaries[0]).toMatchObject({
      summary: 'Summary of current',
      depth: 1,
    });
    expect(store.getState().activeTurnId).toBeNull();
    expect(store.getState().isBusy).toBe(false);

    // Background session is completely untouched
    const bgSessionAfter = store.getState().loadedSessions.get(bgSessionId)!;
    expect(bgSessionAfter.messages).toEqual(bgSessionBefore.messages);
    expect(bgSessionAfter.eventsByTurn).toEqual(bgSessionBefore.eventsByTurn);
    expect(bgSessionAfter.compactionBoundaries).toEqual(bgSessionBefore.compactionBoundaries ?? []);
    expect(bgSessionAfter.activeTurnId).toBe(bgSessionBefore.activeTurnId);
  });
});

describe('SF5 pre-compaction durability gate', () => {
  it('persists pre-compaction state before clearing events for background sessions', () => {
    const store = createSessionStore();
    const bgSessionId = 'bg-durability-gate';
    createBackgroundSession(store, bgSessionId);

    // Clear mock to isolate from createBackgroundSession's upsert calls
    (window.sessionsApi.upsert as ReturnType<typeof vi.fn>).mockClear();

    store.getState().performCompaction('Summary', 1, bgSessionId);

    // Should have been called with pre-compaction state (events present)
    expect(window.sessionsApi.upsert).toHaveBeenCalled();
    const firstCall = (window.sessionsApi.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    // Pre-compaction session should have events from turn-1
    expect(firstCall.eventsByTurn).toHaveProperty('turn-1');
  });

  it('does not fire pre-compaction persist for foreground compaction', () => {
    const store = createSessionStore();
    (window.sessionsApi.upsert as ReturnType<typeof vi.fn>).mockClear();

    store.getState().performCompaction('Summary', 1);

    // Foreground compaction should NOT trigger pre-compaction persist
    expect(window.sessionsApi.upsert).not.toHaveBeenCalled();
  });

  it('completes compaction even when pre-compaction persist fails', () => {
    const store = createSessionStore();
    const bgSessionId = 'bg-persist-fail';
    createBackgroundSession(store, bgSessionId);

    // Make upsert reject
    (window.sessionsApi.upsert as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Disk full'));

    // Should not throw
    store.getState().performCompaction('Summary', 1, bgSessionId);

    // Compaction should still have happened
    const bgSession = store.getState().loadedSessions.get(bgSessionId);
    expect(bgSession).toBeDefined();
    expect(bgSession!.eventsByTurn).toEqual({});
    expect(bgSession!.compactionBoundaries).toHaveLength(1);
  });

  it('completes compaction when pre-compaction persist returns success:false', () => {
    const store = createSessionStore();
    const bgSessionId = 'bg-persist-soft-fail';
    createBackgroundSession(store, bgSessionId);

    // Make upsert resolve with failure (not rejection)
    (window.sessionsApi.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({ success: false, error: 'ENOSPC' });

    store.getState().performCompaction('Summary', 1, bgSessionId);

    const bgSession = store.getState().loadedSessions.get(bgSessionId);
    expect(bgSession).toBeDefined();
    expect(bgSession!.eventsByTurn).toEqual({});
    expect(bgSession!.compactionBoundaries).toHaveLength(1);
  });

  it('does not persist when background session is not in loadedSessions', () => {
    const store = createSessionStore();
    (window.sessionsApi.upsert as ReturnType<typeof vi.fn>).mockClear();

    store.getState().performCompaction('Summary', 1, 'nonexistent-session');

    // Neither persist nor compaction should occur for nonexistent session
    expect(window.sessionsApi.upsert).not.toHaveBeenCalled();
  });
});

describe('persistLoadedSession', () => {
  it('calls window.sessionsApi.upsert with stripped runtime', () => {
    const store = createSessionStore();
    const bgSessionId = 'bg-session-persist';
    createBackgroundSession(store, bgSessionId);

    // Clear mock to isolate persistLoadedSession from createBackgroundSession's upsert
    (window.sessionsApi.upsert as ReturnType<typeof vi.fn>).mockClear();

    store.getState().persistLoadedSession(bgSessionId);

    expect(window.sessionsApi.upsert).toHaveBeenCalledTimes(1);
    expect(window.sessionsApi.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: bgSessionId })
    );
    // Should NOT contain runtime key (stripped)
    const persisted = (window.sessionsApi.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(persisted).not.toHaveProperty('runtime');
  });

  it('is a no-op if session not in loadedSessions', () => {
    const store = createSessionStore();
    const callsBefore = (window.sessionsApi.upsert as ReturnType<typeof vi.fn>).mock.calls.length;

    store.getState().persistLoadedSession('nonexistent');

    expect((window.sessionsApi.upsert as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
  });
});
