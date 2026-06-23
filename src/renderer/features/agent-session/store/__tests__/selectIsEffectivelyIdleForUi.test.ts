import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  clearCurrentSessionEvents,
  createSessionStore,
  selectIsEffectivelyIdleForUi,
} from '../sessionStore';
import type { AgentSessionWithRuntime } from '../../types';
import type { AgentSessionSummary, AgentTurnMessage } from '@shared/types';
import type { SessionRuntimeState } from '../../utils/runtimeState';

/**
 * Unit tests for optimistic stop UI behavior.
 * 
 * These tests verify:
 * 1. selectIsEffectivelyIdleForUi correctly derives UI-only idle state
 * 2. openHistorySession resets isStopping to prevent state leakage between sessions
 * 
 * See: docs/plans/finished/260204_optimistic_stop_ui.md
 */

// Mock window APIs required by sessionStore
beforeEach(() => {
  clearCurrentSessionEvents();
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

describe('selectIsEffectivelyIdleForUi', () => {
  describe('basic selector behavior', () => {
    it('returns true when not busy and not stopping', () => {
      const store = createSessionStore();
      
      // Initial state: not busy, not stopping
      expect(selectIsEffectivelyIdleForUi(store.getState())).toBe(true);
    });

    it('returns false when busy and not stopping', () => {
      const store = createSessionStore();
      
      // Simulate agent turn starting
      store.getState().addUserMessage('Test message');
      const turnId = 'test-turn-1';
      store.getState().assignTurnToMessage(store.getState().messages[0].id, turnId, Date.now());
      store.getState().processEvent(turnId, {
        type: 'turn_started',
        timestamp: Date.now(),
      });
      
      // Now isBusy should be true
      expect(store.getState().isBusy).toBe(true);
      expect(store.getState().isStopping).toBe(false);
      expect(selectIsEffectivelyIdleForUi(store.getState())).toBe(false);
    });

    it('returns true when busy AND stopping (optimistic idle)', () => {
      const store = createSessionStore();
      
      // Simulate agent turn starting
      store.getState().addUserMessage('Test message');
      const turnId = 'test-turn-2';
      store.getState().assignTurnToMessage(store.getState().messages[0].id, turnId, Date.now());
      store.getState().processEvent(turnId, {
        type: 'turn_started',
        timestamp: Date.now(),
      });
      
      // Set isStopping (simulates clicking Stop button)
      store.getState().setIsStopping(true);
      
      // Key assertion: even though isBusy is true, effectivelyIdle should be true
      expect(store.getState().isBusy).toBe(true);
      expect(store.getState().isStopping).toBe(true);
      expect(selectIsEffectivelyIdleForUi(store.getState())).toBe(true);
    });

    it('returns true when not busy and stopping (edge case)', () => {
      const store = createSessionStore();
      
      // Edge case: somehow isStopping is true but isBusy is false
      // (could happen if stop completes very quickly)
      store.getState().setIsStopping(true);
      
      expect(store.getState().isBusy).toBe(false);
      expect(store.getState().isStopping).toBe(true);
      expect(selectIsEffectivelyIdleForUi(store.getState())).toBe(true);
    });
  });

  describe('isStopping is set synchronously before IPC', () => {
    it('setIsStopping updates state immediately (no async)', () => {
      const store = createSessionStore();
      
      // setIsStopping should be synchronous
      const before = store.getState().isStopping;
      store.getState().setIsStopping(true);
      const after = store.getState().isStopping;
      
      expect(before).toBe(false);
      expect(after).toBe(true);
    });
  });
});

describe('openHistorySession resets isStopping', () => {
  /**
   * Creates a mock session for testing openHistorySession.
   * The session must be in loadedSessions for openHistorySession to work.
   */
  function createMockSession(id: string): AgentSessionWithRuntime {
    return {
      id,
      title: `Test Session ${id}`,
      messages: [],
      eventsByTurn: {},
      createdAt: Date.now() - 10000,
      updatedAt: Date.now(),
      activeTurnId: null,
      isBusy: false,
      lastError: null,
        resolvedAt: null,
      origin: 'manual',
    } as unknown as AgentSessionWithRuntime;
  }

  function createMockSummary(
    id: string,
    title: string,
    createdAt: number,
    updatedAt: number,
    isBusy = false,
    messageCount = 0,
  ): AgentSessionSummary {
    return {
      id,
      title,
      createdAt,
      updatedAt,
      resolvedAt: null,
      doneAt: null,
      starredAt: null,
      deletedAt: null,
      origin: 'manual',
      isBusy,
      isCorrupted: false,
      preview: '',
      messageCount,
      hasDraft: false,
      totalTokens: null,
      totalCostUsd: null,
    } as unknown as AgentSessionSummary;
  }

  it('resets isStopping to false when switching sessions', () => {
    const store = createSessionStore();
    
    // Start a turn in the current session
    store.getState().addUserMessage('Test message');
    const turnId = 'turn-session-1';
    store.getState().assignTurnToMessage(store.getState().messages[0].id, turnId, Date.now());
    
    // User clicks Stop - isStopping becomes true
    store.getState().setIsStopping(true);
    expect(store.getState().isStopping).toBe(true);
    
    // Create and cache a different session to switch to
    const session2 = createMockSession('session-2');
    store.getState().cacheSession(session2);
    
    // Add session2 to summaries so openHistorySession doesn't reject it
    store.getState().setSessionSummaries([
      createMockSummary('session-2', 'Test Session session-2', session2.createdAt, session2.updatedAt),
    ]);
    
    // Switch to session2
    const result = store.getState().openHistorySession('session-2');
    
    // openHistorySession should succeed
    expect(result).not.toBeNull();
    
    // CRITICAL: isStopping should be reset to false
    // This prevents the new session from appearing "optimistically idle" incorrectly
    expect(store.getState().isStopping).toBe(false);
    expect(store.getState().currentSessionId).toBe('session-2');
  });

  it('new session appears with correct busy state (not affected by previous isStopping)', () => {
    const store = createSessionStore();
    
    // Session 1: busy with active turn, user clicks Stop
    store.getState().addUserMessage('Message in session 1');
    const turnId = 'turn-in-session-1';
    store.getState().assignTurnToMessage(store.getState().messages[0].id, turnId, Date.now());
    store.getState().setIsStopping(true);
    
    // Session 1 state before switch
    expect(store.getState().isBusy).toBe(true);
    expect(store.getState().isStopping).toBe(true);
    expect(selectIsEffectivelyIdleForUi(store.getState())).toBe(true); // Optimistically idle
    
    // Create session 2 (idle session, no active turn)
    const session2 = createMockSession('idle-session');
    store.getState().cacheSession(session2);
    store.getState().setSessionSummaries([
      createMockSummary('idle-session', 'Idle Session', session2.createdAt, session2.updatedAt),
    ]);
    
    // Switch to session 2
    store.getState().openHistorySession('idle-session');
    
    // Session 2 should be properly idle (not "optimistically idle" due to leaked isStopping)
    expect(store.getState().isBusy).toBe(false);
    expect(store.getState().isStopping).toBe(false);
    expect(selectIsEffectivelyIdleForUi(store.getState())).toBe(true); // Truly idle
  });

  it('switching to a busy session preserves its busy state', () => {
    const store = createSessionStore();
    
    // Set isStopping in current session
    store.getState().setIsStopping(true);
    
    // Create a busy session (simulating a session with an active turn)
    const busySession: AgentSessionWithRuntime = {
      id: 'busy-session',
      title: 'Busy Session',
      messages: [{
        id: 'msg-1',
        role: 'user',
        text: 'Test',
        turnId: 'active-turn',
        createdAt: Date.now() - 5000,
      } as unknown as AgentTurnMessage],
      eventsByTurn: {
        'active-turn': [{ type: 'status', message: 'Working...', timestamp: Date.now() }]
      },
      createdAt: Date.now() - 10000,
      updatedAt: Date.now(),
      activeTurnId: 'active-turn',
      isBusy: true,
      lastError: null,
      origin: 'manual',
        resolvedAt: null,
      runtime: {
        startedAt: Date.now() - 5000,
        lastActivityAt: Date.now() - 1000,
        activeTurnId: 'active-turn',
        terminated: false,
      } as SessionRuntimeState,
    };
    
    store.getState().cacheSession(busySession);
    store.getState().setSessionSummaries([
      createMockSummary('busy-session', 'Busy Session', busySession.createdAt, busySession.updatedAt, true, 1),
    ]);
    
    // Switch to busy session
    store.getState().openHistorySession('busy-session');
    
    // Session should be busy, but isStopping should be reset
    expect(store.getState().isBusy).toBe(true);
    expect(store.getState().isStopping).toBe(false);
    // Should NOT be effectively idle (turn is still running)
    expect(selectIsEffectivelyIdleForUi(store.getState())).toBe(false);
  });
});

describe('UI state implications', () => {
  it('thinking indicator uses effectivelyIdle (not raw isBusy)', () => {
    const store = createSessionStore();
    
    // Start a turn
    store.getState().addUserMessage('Long running task');
    const turnId = 'long-turn';
    store.getState().assignTurnToMessage(store.getState().messages[0].id, turnId, Date.now());
    
    // Before stopping: thinking should show
    const showThinkingBefore = store.getState().isBusy && 
                               store.getState().activeTurnId && 
                               !store.getState().isStopping;
    expect(showThinkingBefore).toBe(true);
    
    // User clicks Stop
    store.getState().setIsStopping(true);
    
    // After stopping: thinking should hide immediately (optimistic)
    const showThinkingAfter = store.getState().isBusy && 
                              store.getState().activeTurnId && 
                              !store.getState().isStopping;
    expect(showThinkingAfter).toBe(false);
    
    // But isBusy is still true (backend hasn't confirmed yet)
    expect(store.getState().isBusy).toBe(true);
  });
});
