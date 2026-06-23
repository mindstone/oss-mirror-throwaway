// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, flushAsync, createMockWindowApi } from '@renderer/test-utils';
import {
  buildQuestionBatchStates,
  extractAnsweredBatches,
  extractQuestionBatches,
  isQuestionBatchStale,
  useUserQuestions,
  type QuestionBatchState,
  type UseUserQuestionsReturn,
} from '../useUserQuestions';
import type {
  UserQuestionBatch,
  UserQuestionAnswer,
  UserQuestion,
  QuestionOption,
  AgentEvent,
} from '@shared/types';
import {
  appendRendererOptimisticTurnStartedEvent,
  getCurrentSessionEvents,
  getCurrentSessionEventsForTurn,
  getCurrentSessionProjectedLiveness,
  isRendererOptimisticTurnStartedEvent,
  removeRendererOptimisticTurnStartedEvent,
  setCurrentSessionEvents,
  useSessionStore,
} from '../../store/sessionStore';
import {
  registerSystemContinuationOptimisticLifecycleManager,
} from '../useAgentSessionEngine';
import { createId } from '@shared/utils/id';

/**
 * Tests for useUserQuestions hook.
 *
 * Note: Full React hook testing (useState/useEffect behavior) would require
 * @testing-library/react which isn't currently installed.
 * These tests verify exports, type structure, and pure helper logic.
 *
 * To enable full hook behavior testing:
 *   npm install -D @testing-library/react @testing-library/react-hooks
 *
 * Then add tests like:
 *   const { result } = renderHook(() => useUserQuestions(sessionId, eventsByTurn));
 *   expect(result.current.questionBatches).toEqual([]);
 *   act(() => { ... });
 */

// =============================================================================
// Test Helpers
// =============================================================================

function makeOption(id: string, label: string, description: string = ''): QuestionOption {
  return { id, label, description };
}

function makeQuestion(overrides: Partial<UserQuestion> = {}): UserQuestion {
  return {
    id: 'q0',
    question: 'What format do you prefer?',
    header: 'Format',
    options: [
      makeOption('q0-opt0', 'Bullet points', 'Quick scannable overview'),
      makeOption('q0-opt1', 'Paragraphs', 'Detailed narrative format'),
    ],
    multiSelect: false,
    ...overrides,
  };
}

function makeBatch(overrides: Partial<UserQuestionBatch> = {}): UserQuestionBatch {
  return {
    batchId: 'batch-1',
    toolUseId: 'tool-1',
    turnId: 'turn-1',
    sessionId: 'session-1',
    questions: [makeQuestion()],
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeAnswer(questionId: string, selectedOptionIds: string[], freeText?: string): UserQuestionAnswer {
  return { questionId, selectedOptionIds, freeText };
}

function makeUserQuestionEvent(batch: UserQuestionBatch): Extract<AgentEvent, { type: 'user_question' }> {
  return {
    type: 'user_question',
    batchId: batch.batchId,
    toolUseId: batch.toolUseId,
    questions: batch.questions,
    timestamp: batch.timestamp,
  };
}

function makeUserQuestionAnsweredEvent(
  batchId: string,
  answers: UserQuestionAnswer[],
  skipped = false,
  timestamp = Date.now(),
): AgentEvent {
  return {
    type: 'user_question_answered',
    batchId,
    answers,
    skipped: skipped || undefined,
    timestamp,
  } as AgentEvent;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type ContinuationLifecycleHarness = {
  clearOptimisticStartForRealTurn: (realTurnId: string) => void;
  unregister: () => void;
};

function registerContinuationLifecycleHarnessForTests(): ContinuationLifecycleHarness {
  const pendingOptimisticStartByClientTurnId = new Set<string>();
  const optimisticTurnIdByRealTurnId = new Map<string, string>();
  const preAckRealTurnSeen = new Set<string>();

  const clearOptimisticStartById = (optimisticTurnId: string | null): void => {
    if (!optimisticTurnId) return;
    removeRendererOptimisticTurnStartedEvent(optimisticTurnId);
    pendingOptimisticStartByClientTurnId.delete(optimisticTurnId);
    for (const [realTurnId, linkedOptimisticTurnId] of optimisticTurnIdByRealTurnId.entries()) {
      if (linkedOptimisticTurnId === optimisticTurnId) {
        optimisticTurnIdByRealTurnId.delete(realTurnId);
      }
    }
  };

  registerSystemContinuationOptimisticLifecycleManager({
    getActiveSessionId: () => null,
    pushOptimisticStartForSession: (targetSessionId, activeSessionId) => {
      if (targetSessionId !== activeSessionId) {
        return null;
      }
      const clientTurnId = createId();
      appendRendererOptimisticTurnStartedEvent(clientTurnId);
      pendingOptimisticStartByClientTurnId.add(clientTurnId);
      return clientTurnId;
    },
    bindOptimisticStartToRealTurn: (realTurnId, optimisticTurnId) => {
      if (!optimisticTurnId) return;
      if (!pendingOptimisticStartByClientTurnId.has(optimisticTurnId)) {
        return;
      }
      optimisticTurnIdByRealTurnId.set(realTurnId, optimisticTurnId);
      if (preAckRealTurnSeen.has(realTurnId)) {
        clearOptimisticStartById(optimisticTurnId);
        preAckRealTurnSeen.delete(realTurnId);
      }
    },
    clearOptimisticStartById,
  });

  return {
    clearOptimisticStartForRealTurn: (realTurnId: string) => {
      const optimisticTurnId = optimisticTurnIdByRealTurnId.get(realTurnId);
      if (!optimisticTurnId) {
        preAckRealTurnSeen.add(realTurnId);
        return;
      }
      clearOptimisticStartById(optimisticTurnId);
    },
    unregister: () => {
      registerSystemContinuationOptimisticLifecycleManager(null);
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('useUserQuestions', () => {
  let continuationLifecycleHarness: ContinuationLifecycleHarness;

  beforeEach(() => {
    continuationLifecycleHarness?.unregister();
    vi.restoreAllMocks();
    localStorage.clear();
    setCurrentSessionEvents({});
    useSessionStore.setState({ dismissedQuestionBatchIdsBySessionId: {} });
    continuationLifecycleHarness = registerContinuationLifecycleHarnessForTests();
    createMockWindowApi('agentApi', {
      userQuestionResponse: vi.fn().mockResolvedValue({ success: true, continuationMessage: 'test-continuation-default' }),
      turn: vi.fn().mockResolvedValue({ turnId: 'fallback-turn-123' }),
    });
  });

  describe('exports and types', () => {
    it('exports useUserQuestions function', () => {
      expect(typeof useUserQuestions).toBe('function');
    });

    it('can import QuestionBatchState type', () => {
      const batch = makeBatch();
      const state: QuestionBatchState = {
        batch,
        isAnswered: false,
        answers: undefined,
      };
      expect(state.batch).toBe(batch);
      expect(state.isAnswered).toBe(false);
      expect(state.answers).toBeUndefined();
    });

    it('can import UseUserQuestionsReturn type', () => {
      const mockReturn: UseUserQuestionsReturn = {
        questionBatches: [],
        submitAnswers: async () => {},
        dismissBatch: () => {},
        undoDismiss: () => {},
        dismissedBatchIds: new Set(),
        dismissedBatchIdsLoaded: true,
        isSubmitting: false,
        submissionError: null,
      };
      expect(mockReturn.questionBatches).toEqual([]);
      expect(typeof mockReturn.submitAnswers).toBe('function');
      expect(typeof mockReturn.dismissBatch).toBe('function');
      expect(typeof mockReturn.undoDismiss).toBe('function');
      expect(mockReturn.dismissedBatchIds).toBeInstanceOf(Set);
      expect(mockReturn.isSubmitting).toBe(false);
      expect(mockReturn.submissionError).toBeNull();
    });
  });

  describe('UseUserQuestionsReturn type structure', () => {
    it('has questionBatches array property', () => {
      const mockReturn: UseUserQuestionsReturn = {
        questionBatches: [],
        submitAnswers: async () => {},
        dismissBatch: () => {},
        undoDismiss: () => {},
        dismissedBatchIds: new Set(),
        dismissedBatchIdsLoaded: true,
        isSubmitting: false,
        submissionError: null,
      };
      expect(Array.isArray(mockReturn.questionBatches)).toBe(true);
    });

    it('has submitAnswers async function', () => {
      const mockReturn: UseUserQuestionsReturn = {
        questionBatches: [],
        submitAnswers: async (_batchId: string, _answers: UserQuestionAnswer[]) => {},
        dismissBatch: () => {},
        undoDismiss: () => {},
        dismissedBatchIds: new Set(),
        dismissedBatchIdsLoaded: true,
        isSubmitting: false,
        submissionError: null,
      };
      expect(typeof mockReturn.submitAnswers).toBe('function');
    });

    it('has dismissBatch synchronous function (renderer-only, no IPC)', () => {
      const mockReturn: UseUserQuestionsReturn = {
        questionBatches: [],
        submitAnswers: async () => {},
        dismissBatch: (_batchId: string) => {},
        undoDismiss: () => {},
        dismissedBatchIds: new Set(),
        dismissedBatchIdsLoaded: true,
        isSubmitting: false,
        submissionError: null,
      };
      expect(typeof mockReturn.dismissBatch).toBe('function');
    });

    it('has undoDismiss synchronous function', () => {
      const mockReturn: UseUserQuestionsReturn = {
        questionBatches: [],
        submitAnswers: async () => {},
        dismissBatch: () => {},
        undoDismiss: (_batchId: string) => {},
        dismissedBatchIds: new Set(),
        dismissedBatchIdsLoaded: true,
        isSubmitting: false,
        submissionError: null,
      };
      expect(typeof mockReturn.undoDismiss).toBe('function');
    });

    it('has dismissedBatchIds Set property', () => {
      const mockReturn: UseUserQuestionsReturn = {
        questionBatches: [],
        submitAnswers: async () => {},
        dismissBatch: () => {},
        undoDismiss: () => {},
        dismissedBatchIds: new Set(['batch-1']),
        dismissedBatchIdsLoaded: true,
        isSubmitting: false,
        submissionError: null,
      };
      expect(mockReturn.dismissedBatchIds).toBeInstanceOf(Set);
      expect(mockReturn.dismissedBatchIds.has('batch-1')).toBe(true);
    });

    it('has isSubmitting boolean flag', () => {
      const mockReturn: UseUserQuestionsReturn = {
        questionBatches: [],
        submitAnswers: async () => {},
        dismissBatch: () => {},
        undoDismiss: () => {},
        dismissedBatchIds: new Set(),
        dismissedBatchIdsLoaded: true,
        isSubmitting: true,
        submissionError: null,
      };
      expect(typeof mockReturn.isSubmitting).toBe('boolean');
    });

    it('has submissionError nullable string', () => {
      const errorReturn: UseUserQuestionsReturn = {
        questionBatches: [],
        submitAnswers: async () => {},
        dismissBatch: () => {},
        undoDismiss: () => {},
        dismissedBatchIds: new Set(),
        dismissedBatchIdsLoaded: true,
        isSubmitting: false,
        submissionError: 'Something went wrong',
      };
      expect(typeof errorReturn.submissionError).toBe('string');

      const noErrorReturn: UseUserQuestionsReturn = {
        questionBatches: [],
        submitAnswers: async () => {},
        dismissBatch: () => {},
        undoDismiss: () => {},
        dismissedBatchIds: new Set(),
        dismissedBatchIdsLoaded: true,
        isSubmitting: false,
        submissionError: null,
      };
      expect(noErrorReturn.submissionError).toBeNull();
    });

    it('exposes skipBatch as an optional member (re-added for mobile)', () => {
      // Desktop never constructs the return shape manually, so omission is
      // still valid (skipBatch is optional). Mobile's "Skip all" button uses
      // this method. See docs/plans/260420_user_question_cross_surface_resilience.md Stage 4.
      const withoutSkip: UseUserQuestionsReturn = {
        questionBatches: [],
        submitAnswers: async () => {},
        dismissBatch: () => {},
        undoDismiss: () => {},
        dismissedBatchIds: new Set(),
        dismissedBatchIdsLoaded: true,
        isSubmitting: false,
        submissionError: null,
      };
      expect(withoutSkip).not.toHaveProperty('skipBatch');

      const withSkip: UseUserQuestionsReturn = {
        questionBatches: [],
        submitAnswers: async () => {},
        skipBatch: async () => {},
        dismissBatch: () => {},
        undoDismiss: () => {},
        dismissedBatchIds: new Set(),
        dismissedBatchIdsLoaded: true,
        isSubmitting: false,
        submissionError: null,
      };
      expect(typeof withSkip.skipBatch).toBe('function');
    });
  });

  describe('notification dismissal mirror', () => {
    it('mirrors dismissed batch ids into the shared session store', async () => {
      const batch = makeBatch({
        batchId: 'batch-notification-dismiss',
        turnId: 'turn-notification-dismiss',
        sessionId: 'session-notification-dismiss',
        timestamp: 1000,
      });
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-notification-dismiss': [
          {
            ...makeUserQuestionEvent(batch),
            sessionId: batch.sessionId,
          },
        ],
      };

      const { result, unmount } = renderHook(() =>
        useUserQuestions(batch.sessionId, eventsByTurn),
      );

      await flushAsync();

      act(() => {
        result.current.dismissBatch(batch.batchId);
      });
      await flushAsync();

      expect(
        useSessionStore.getState().dismissedQuestionBatchIdsBySessionId[batch.sessionId],
      ).toEqual([batch.batchId]);

      unmount();
    });

    it('does not mirror the previous session dismissal set during session switch', async () => {
      const sessionA = 'session-mirror-a';
      const sessionB = 'session-mirror-b';
      const batchA = makeBatch({
        batchId: 'batch-a-dismissed',
        turnId: 'turn-a',
        sessionId: sessionA,
        timestamp: 1000,
      });
      const batchB = makeBatch({
        batchId: 'batch-b-visible',
        turnId: 'turn-b',
        sessionId: sessionB,
        timestamp: 2000,
      });
      const eventsBySession: Record<string, Record<string, AgentEvent[]>> = {
        [sessionA]: {
          'turn-a': [{ ...makeUserQuestionEvent(batchA), sessionId: sessionA }],
        },
        [sessionB]: {
          'turn-b': [{ ...makeUserQuestionEvent(batchB), sessionId: sessionB }],
        },
      };

      const { result, rerender, unmount } = renderHook(
        ({ sessionId }: { sessionId: string }) =>
          useUserQuestions(sessionId, eventsBySession[sessionId]),
        { initialProps: { sessionId: sessionA } },
      );

      await flushAsync();
      act(() => {
        result.current.dismissBatch(batchA.batchId);
      });
      await flushAsync();

      rerender({ sessionId: sessionB });

      expect(
        useSessionStore.getState().dismissedQuestionBatchIdsBySessionId[sessionB],
      ).toBeUndefined();

      await flushAsync();
      expect(
        useSessionStore.getState().dismissedQuestionBatchIdsBySessionId[sessionA],
      ).toEqual([batchA.batchId]);
      expect(
        useSessionStore.getState().dismissedQuestionBatchIdsBySessionId[sessionB],
      ).toBeUndefined();

      unmount();
    });
  });

  describe('submission behavior', () => {
    it('keeps a single pending batch visible while submit IPC is still in flight', async () => {
      const deferred = createDeferred<{ success: boolean; error?: string }>();
      createMockWindowApi('agentApi', {
        userQuestionResponse: vi.fn(() => deferred.promise),
      });

      const batch = makeBatch({ batchId: 'batch-pending', turnId: 'turn-pending', timestamp: 1000 });
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-pending': [makeUserQuestionEvent(batch)],
      };

      const { result, unmount } = renderHook(() => useUserQuestions('session-1', eventsByTurn));

      expect(result.current.questionBatches).toHaveLength(1);
      expect(result.current.questionBatches[0].isAnswered).toBe(false);

      act(() => {
        void result.current.submitAnswers(batch.batchId, [makeAnswer('q0', ['q0-opt0'])]);
      });

      await flushAsync();

      expect(result.current.isSubmitting).toBe(true);
      expect(result.current.questionBatches).toHaveLength(1);
      expect(result.current.questionBatches[0].isAnswered).toBe(false);

      deferred.resolve({ success: true });
      await flushAsync();
      unmount();
    });

    it('renderer continuation contract: sendContinuation receives continuationMessage (main does not start the turn)', async () => {
      createMockWindowApi('agentApi', {
        userQuestionResponse: vi.fn().mockResolvedValue({ success: true, continuationMessage: 'Continue with user answers' }),
        turn: vi.fn().mockResolvedValue({ turnId: 'fallback-turn' }),
      });

      const batch = makeBatch({ batchId: 'batch-cb', turnId: 'turn-cb', sessionId: 'session-cb', timestamp: 1000 });
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-cb': [makeUserQuestionEvent(batch)],
      };

      const sendContinuation = vi.fn();
      const { result, unmount } = renderHook(() =>
        useUserQuestions('session-cb', eventsByTurn, sendContinuation),
      );

      await act(async () => {
        await result.current.submitAnswers(batch.batchId, [makeAnswer('q0', ['q0-opt0'])]);
      });

      expect(sendContinuation).toHaveBeenCalledOnce();
      expect(sendContinuation).toHaveBeenCalledWith(
        'session-cb',
        'Continue with user answers',
        undefined,
        undefined,
      );
      // Direct window.agentApi.turn() should NOT be called when sendContinuation is provided
      expect(window.agentApi.turn).not.toHaveBeenCalled();
      unmount();
    });

    it('routes continuation attachments through sendContinuation when provided', async () => {
      createMockWindowApi('agentApi', {
        userQuestionResponse: vi.fn().mockResolvedValue({ success: true, continuationMessage: 'Continue with uploaded brief' }),
        turn: vi.fn().mockResolvedValue({ turnId: 'fallback-turn' }),
      });

      const batch = makeBatch({ batchId: 'batch-attach', turnId: 'turn-attach', sessionId: 'session-attach', timestamp: 1000 });
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-attach': [makeUserQuestionEvent(batch)],
      };

      const sendContinuation = vi.fn();
      const { result, unmount } = renderHook(() =>
        useUserQuestions('session-attach', eventsByTurn, sendContinuation),
      );

      await act(async () => {
        await result.current.submitAnswers(
          batch.batchId,
          [{
            questionId: 'q0',
            selectedOptionIds: [],
            attachments: [{ id: 'att-1', name: 'brief.pdf', type: 'binary', mimeType: 'application/pdf' }],
          }],
          [{
            id: 'att-1',
            name: 'brief.pdf',
            type: 'binary',
            mimeType: 'application/pdf',
            sizeBytes: 1024,
            originalPath: '/tmp/brief.pdf',
          }],
        );
      });

      expect(sendContinuation).toHaveBeenCalledOnce();
      expect(sendContinuation).toHaveBeenCalledWith(
        'session-attach',
        'Continue with uploaded brief',
        [expect.objectContaining({ name: 'brief.pdf' })],
        undefined,
      );
      expect(window.agentApi.turn).not.toHaveBeenCalled();
      unmount();
    });

    it('preserves continuation attachments when falling back after sendContinuation fails', async () => {
      createMockWindowApi('agentApi', {
        userQuestionResponse: vi.fn().mockResolvedValue({ success: true, continuationMessage: 'Continue with uploaded brief' }),
        turn: vi.fn().mockResolvedValue({ turnId: 'fallback-turn' }),
      });

      const batch = makeBatch({ batchId: 'batch-attach-fallback', turnId: 'turn-attach-fallback', sessionId: 'session-attach-fallback', timestamp: 1000 });
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-attach-fallback': [makeUserQuestionEvent(batch)],
      };
      const attachment = {
        id: 'att-1',
        name: 'brief.pdf',
        type: 'binary' as const,
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        originalPath: '/tmp/brief.pdf',
      };
      const sendContinuation = vi.fn().mockRejectedValue(new Error('Queue failed'));
      const { result, unmount } = renderHook(() =>
        useUserQuestions('session-attach-fallback', eventsByTurn, sendContinuation),
      );

      await act(async () => {
        await result.current.submitAnswers(
          batch.batchId,
          [{
            questionId: 'q0',
            selectedOptionIds: [],
            attachments: [{ id: 'att-1', name: 'brief.pdf', type: 'binary', mimeType: 'application/pdf' }],
          }],
          [attachment],
        );
      });

      expect(sendContinuation).toHaveBeenCalledWith(
        'session-attach-fallback',
        'Continue with uploaded brief',
        [attachment],
        undefined,
      );
      expect(window.agentApi.turn).toHaveBeenCalledWith({
        sessionId: 'session-attach-fallback',
        prompt: 'Continue with uploaded brief',
        attachments: [attachment],
        clientTurnId: expect.any(String),
        isSystemContinuation: true,
      });
      unmount();
    });

    it('sendContinuation receives the continuation payload — caller is responsible for isHidden/messageOrigin via sendMessageToSession options', async () => {
      // This test locks in the contract: useUserQuestions delegates the continuation
      // payload to sendContinuation. The isHidden flag is applied by
      // handleQuestionSendContinuation in SessionSurfaceContent.tsx.
      createMockWindowApi('agentApi', {
        userQuestionResponse: vi.fn().mockResolvedValue({ success: true, continuationMessage: '<conversation_history>context</conversation_history>\nThe user answered your questions: answer' }),
        turn: vi.fn().mockResolvedValue({ turnId: 'fallback-turn' }),
      });

      const batch = makeBatch({ batchId: 'batch-hidden', turnId: 'turn-hidden', sessionId: 'session-hidden', timestamp: 1000 });
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-hidden': [makeUserQuestionEvent(batch)],
      };

      const sendContinuation = vi.fn();
      const { result, unmount } = renderHook(() =>
        useUserQuestions('session-hidden', eventsByTurn, sendContinuation),
      );

      await act(async () => {
        await result.current.submitAnswers(batch.batchId, [makeAnswer('q0', ['q0-opt0'])]);
      });

      expect(sendContinuation).toHaveBeenCalledOnce();
      // Only (sessionId, message) — no isHidden arg; that's the caller's responsibility.
      // 4th arg is `continuationContext` (F3) — undefined when the response
      // handler did not inject `<prior_turns>`/`<conversation_history>`.
      expect(sendContinuation).toHaveBeenCalledWith(
        'session-hidden',
        expect.stringContaining('<conversation_history>'),
        undefined,
        undefined,
      );
      expect(sendContinuation.mock.calls[0]).toHaveLength(4);
      unmount();
    });

    it('falls back through the shared optimistic lifecycle and prevents running re-prime after supersede + terminal', async () => {
      createMockWindowApi('agentApi', {
        userQuestionResponse: vi.fn().mockResolvedValue({ success: true, continuationMessage: 'Continue with user answers' }),
        turn: vi.fn().mockResolvedValue({ turnId: 'real-turn-123' }),
      });

      const batch = makeBatch({ batchId: 'batch-fb', turnId: 'turn-fb', sessionId: 'session-fb', timestamp: 1000 });
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-fb': [makeUserQuestionEvent(batch)],
      };

      // No sendContinuation provided — should use direct IPC fallback
      const { result, unmount } = renderHook(() =>
        useUserQuestions('session-fb', eventsByTurn),
      );

      await act(async () => {
        await result.current.submitAnswers(batch.batchId, [makeAnswer('q0', ['q0-opt0'])]);
      });

      expect(window.agentApi.turn).toHaveBeenCalledOnce();
      expect(window.agentApi.turn).toHaveBeenCalledWith({
        sessionId: 'session-fb',
        prompt: 'Continue with user answers',
        clientTurnId: expect.any(String),
        isSystemContinuation: true,
      });
      const clientTurnId = (window.agentApi.turn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.clientTurnId as string | undefined;
      expect(clientTurnId).toBeTruthy();
      expect(
        getCurrentSessionEventsForTurn(clientTurnId!).some(isRendererOptimisticTurnStartedEvent),
      ).toBe(true);

      // Mirror engine real-event supersede path: when the first real event for the
      // correlated turn lands, the optimistic start must be removed.
      continuationLifecycleHarness.clearOptimisticStartForRealTurn('real-turn-123');
      expect(
        getCurrentSessionEventsForTurn(clientTurnId!).some(isRendererOptimisticTurnStartedEvent),
      ).toBe(false);

      setCurrentSessionEvents({
        ...getCurrentSessionEvents(),
        'real-turn-123': [
          { type: 'turn_started', timestamp: 2_000 } as AgentEvent,
          { type: 'result', text: 'done', timestamp: 3_000 } as AgentEvent,
        ],
      });
      expect(getCurrentSessionProjectedLiveness(null).status).not.toBe('running');
      unmount();
    });

    it('clears optimistic fallback marker when direct continuation start fails', async () => {
      createMockWindowApi('agentApi', {
        userQuestionResponse: vi.fn().mockResolvedValue({ success: true, continuationMessage: 'Continue with user answers' }),
        turn: vi.fn().mockRejectedValue(new Error('fallback turn failed')),
      });

      const batch = makeBatch({ batchId: 'batch-fb-error', turnId: 'turn-fb-error', sessionId: 'session-fb-error', timestamp: 1000 });
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-fb-error': [makeUserQuestionEvent(batch)],
      };

      const { result, unmount } = renderHook(() =>
        useUserQuestions('session-fb-error', eventsByTurn),
      );

      await act(async () => {
        await result.current.submitAnswers(batch.batchId, [makeAnswer('q0', ['q0-opt0'])]);
      });

      const clientTurnId = (window.agentApi.turn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.clientTurnId as string | undefined;
      expect(clientTurnId).toBeTruthy();
      expect(
        getCurrentSessionEventsForTurn(clientTurnId!).some(isRendererOptimisticTurnStartedEvent),
      ).toBe(false);
      unmount();
    });

    it('does not start continuation when no continuationMessage (dedup case)', async () => {
      createMockWindowApi('agentApi', {
        userQuestionResponse: vi.fn().mockResolvedValue({ success: true }),
        turn: vi.fn().mockResolvedValue({ turnId: 'should-not-happen' }),
      });

      const batch = makeBatch({ batchId: 'batch-dedup', turnId: 'turn-dedup', sessionId: 'session-dedup', timestamp: 1000 });
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-dedup': [makeUserQuestionEvent(batch)],
      };

      const sendContinuation = vi.fn();
      const { result, unmount } = renderHook(() =>
        useUserQuestions('session-dedup', eventsByTurn, sendContinuation),
      );

      await act(async () => {
        await result.current.submitAnswers(batch.batchId, [makeAnswer('q0', ['q0-opt0'])]);
      });

      expect(sendContinuation).not.toHaveBeenCalled();
      expect(window.agentApi.turn).not.toHaveBeenCalled();
      unmount();
    });

    it('does not start continuation when IPC response indicates failure', async () => {
      createMockWindowApi('agentApi', {
        userQuestionResponse: vi.fn().mockResolvedValue({ success: false, error: 'Something broke' }),
        turn: vi.fn().mockResolvedValue({ turnId: 'should-not-happen' }),
      });

      const batch = makeBatch({ batchId: 'batch-fail', turnId: 'turn-fail', sessionId: 'session-fail', timestamp: 1000 });
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-fail': [makeUserQuestionEvent(batch)],
      };

      const sendContinuation = vi.fn();
      const { result, unmount } = renderHook(() =>
        useUserQuestions('session-fail', eventsByTurn, sendContinuation),
      );

      await act(async () => {
        await result.current.submitAnswers(batch.batchId, [makeAnswer('q0', ['q0-opt0'])]);
      });

      expect(sendContinuation).not.toHaveBeenCalled();
      expect(window.agentApi.turn).not.toHaveBeenCalled();
      unmount();
    });

    it('falls back to direct turn start when sendContinuation throws', async () => {
      createMockWindowApi('agentApi', {
        userQuestionResponse: vi.fn().mockResolvedValue({ success: true, continuationMessage: 'Continue...' }),
        turn: vi.fn().mockResolvedValue({ turnId: 'fallback-turn' }),
      });

      const sendContinuation = vi.fn().mockImplementation(() => {
        throw new Error('Queue failure');
      });

      const batch = makeBatch({ batchId: 'batch-cont-fail', turnId: 'turn-cont-fail', sessionId: 'session-cont-fail', timestamp: 1000 });
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-cont-fail': [makeUserQuestionEvent(batch)],
      };

      const { result, unmount } = renderHook(() =>
        useUserQuestions('session-cont-fail', eventsByTurn, sendContinuation),
      );

      await act(async () => {
        await result.current.submitAnswers(batch.batchId, [makeAnswer('q0', ['q0-opt0'])]);
      });

      expect(sendContinuation).toHaveBeenCalledOnce();
      expect(window.agentApi.turn).toHaveBeenCalledWith({
        sessionId: 'session-cont-fail',
        prompt: 'Continue...',
        clientTurnId: expect.any(String),
        isSystemContinuation: true,
      });
      expect(result.current.submissionError).toBeNull();
      unmount();
    });

    it('falls back to direct turn start when sendContinuation rejects asynchronously', async () => {
      createMockWindowApi('agentApi', {
        userQuestionResponse: vi.fn().mockResolvedValue({ success: true, continuationMessage: 'Continue...' }),
        turn: vi.fn().mockResolvedValue({ turnId: 'fallback-turn-async' }),
      });

      const sendContinuation = vi.fn().mockRejectedValue(new Error('Async queue failure'));

      const batch = makeBatch({ batchId: 'batch-async-fail', turnId: 'turn-async-fail', sessionId: 'session-async-fail', timestamp: 1000 });
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-async-fail': [makeUserQuestionEvent(batch)],
      };

      const { result, unmount } = renderHook(() =>
        useUserQuestions('session-async-fail', eventsByTurn, sendContinuation),
      );

      await act(async () => {
        await result.current.submitAnswers(batch.batchId, [makeAnswer('q0', ['q0-opt0'])]);
      });

      expect(sendContinuation).toHaveBeenCalledOnce();
      expect(window.agentApi.turn).toHaveBeenCalledWith({
        sessionId: 'session-async-fail',
        prompt: 'Continue...',
        clientTurnId: expect.any(String),
        isSystemContinuation: true,
      });
      expect(result.current.submissionError).toBeNull();
      unmount();
    });

    it('surfaces a submissionError when both continuation paths fail', async () => {
      createMockWindowApi('agentApi', {
        userQuestionResponse: vi.fn().mockResolvedValue({ success: true, continuationMessage: 'Continue...' }),
        turn: vi.fn().mockRejectedValue(new Error('Direct continuation failed')),
      });

      const sendContinuation = vi.fn().mockRejectedValue(new Error('Queue failure'));

      const batch = makeBatch({ batchId: 'batch-double-fail', turnId: 'turn-double-fail', sessionId: 'session-double-fail', timestamp: 1000 });
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-double-fail': [makeUserQuestionEvent(batch)],
      };

      const { result, unmount } = renderHook(() =>
        useUserQuestions('session-double-fail', eventsByTurn, sendContinuation),
      );

      await act(async () => {
        await result.current.submitAnswers(batch.batchId, [makeAnswer('q0', ['q0-opt0'])]);
      });

      expect(sendContinuation).toHaveBeenCalledOnce();
      expect(window.agentApi.turn).toHaveBeenCalledWith({
        sessionId: 'session-double-fail',
        prompt: 'Continue...',
        clientTurnId: expect.any(String),
        isSystemContinuation: true,
      });
      expect(result.current.submissionError).toContain('Answer saved, but Rebel could not continue automatically');
      unmount();
    });
  });

  describe('answered-state derivation', () => {
    it('derives answered batches from user_question_answered events in eventsByTurn', () => {
      const answers = [makeAnswer('q0', ['q0-opt0'], 'Extra context')];
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [makeUserQuestionAnsweredEvent('batch-1', answers)],
        'turn-2': [makeUserQuestionAnsweredEvent('batch-2', [], true)],
      };

      const answeredBatches = extractAnsweredBatches(eventsByTurn);

      expect(answeredBatches.get('batch-1')).toEqual({
        answers,
        skipped: undefined,
      });
      expect(answeredBatches.get('batch-2')).toEqual({
        answers: [],
        skipped: true,
      });
      expect(answeredBatches.size).toBe(2);
    });

    it('reconstructs answered cards on session reload when both question and answered events exist', () => {
      const batch = makeBatch({
        batchId: 'batch-reload',
        turnId: 'turn-reload',
        sessionId: 'session-reload',
      });
      const answers = [makeAnswer('q0', ['q0-opt1'])];
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-reload': [
          makeUserQuestionEvent(batch),
          makeUserQuestionAnsweredEvent(batch.batchId, answers, false, batch.timestamp + 1),
        ],
      };

      const eventBatches = extractQuestionBatches(eventsByTurn, batch.sessionId);
      const answeredBatches = extractAnsweredBatches(eventsByTurn);
      const questionBatches = buildQuestionBatchStates(eventBatches, answeredBatches);

      expect(questionBatches).toHaveLength(1);
      expect(questionBatches[0].batch).toMatchObject({
        batchId: 'batch-reload',
        turnId: 'turn-reload',
        sessionId: 'session-reload',
      });
      expect(questionBatches[0].isAnswered).toBe(true);
      expect(questionBatches[0].answers).toEqual(answers);
    });

    it('treats batches as answered even when pendingBatchIds still contains the batchId', () => {
      const batch = makeBatch({ batchId: 'batch-pending-and-answered' });
      const answers = [makeAnswer('q0', ['q0-opt0'])];
      const eventsByTurn: Record<string, AgentEvent[]> = {
        [batch.turnId]: [
          makeUserQuestionEvent(batch),
          makeUserQuestionAnsweredEvent(batch.batchId, answers),
        ],
      };

      const eventBatches = extractQuestionBatches(eventsByTurn, batch.sessionId);
      const answeredBatches = extractAnsweredBatches(eventsByTurn);
      const questionBatches = buildQuestionBatchStates(
        eventBatches,
        answeredBatches,
      );

      expect(questionBatches).toHaveLength(1);
      expect(questionBatches[0].isAnswered).toBe(true);
      expect(questionBatches[0].answers).toEqual(answers);
    });

    it('passes skipped flag through to QuestionBatchState', () => {
      const batch = makeBatch({ batchId: 'batch-skipped' });
      const eventsByTurn: Record<string, AgentEvent[]> = {
        [batch.turnId]: [
          makeUserQuestionEvent(batch),
          makeUserQuestionAnsweredEvent(batch.batchId, [], true),
        ],
      };

      const eventBatches = extractQuestionBatches(eventsByTurn, batch.sessionId);
      const answeredBatches = extractAnsweredBatches(eventsByTurn);
      const questionBatches = buildQuestionBatchStates(eventBatches, answeredBatches);

      expect(questionBatches).toHaveLength(1);
      expect(questionBatches[0].isAnswered).toBe(true);
      expect(questionBatches[0].skipped).toBe(true);
      expect(questionBatches[0].answers).toEqual([]);
    });

    it('does not set skipped flag for normally answered batches', () => {
      const batch = makeBatch({ batchId: 'batch-answered' });
      const answers = [makeAnswer('q0', ['q0-opt0'])];
      const eventsByTurn: Record<string, AgentEvent[]> = {
        [batch.turnId]: [
          makeUserQuestionEvent(batch),
          makeUserQuestionAnsweredEvent(batch.batchId, answers, false),
        ],
      };

      const eventBatches = extractQuestionBatches(eventsByTurn, batch.sessionId);
      const answeredBatches = extractAnsweredBatches(eventsByTurn);
      const questionBatches = buildQuestionBatchStates(eventBatches, answeredBatches);

      expect(questionBatches).toHaveLength(1);
      expect(questionBatches[0].isAnswered).toBe(true);
      expect(questionBatches[0].skipped).toBeUndefined();
      expect(questionBatches[0].answers).toEqual(answers);
    });

    it('ignores answered events for unknown batches gracefully', () => {
      const batch = makeBatch({ batchId: 'known-batch' });
      const eventsByTurn: Record<string, AgentEvent[]> = {
        [batch.turnId]: [
          makeUserQuestionEvent(batch),
          makeUserQuestionAnsweredEvent('unknown-batch', [makeAnswer('qX', ['opt-x'])]),
        ],
      };

      const eventBatches = extractQuestionBatches(eventsByTurn, batch.sessionId);
      const answeredBatches = extractAnsweredBatches(eventsByTurn);
      const questionBatches = buildQuestionBatchStates(
        eventBatches,
        answeredBatches,
      );

      expect(questionBatches).toHaveLength(1);
      expect(questionBatches[0].batch.batchId).toBe('known-batch');
      expect(questionBatches[0].isAnswered).toBe(false);
      expect(questionBatches[0].answers).toBeUndefined();
    });
  });

  describe('event shape', () => {
    it('user_question event contains batch data for reconstruction', () => {
      const batch = makeBatch({
        batchId: 'batch-42',
        toolUseId: 'tool-42',
        questions: [
          makeQuestion({ id: 'q0', header: 'Format' }),
          makeQuestion({ id: 'q1', header: 'Detail', question: 'How detailed?' }),
        ],
      });
      const event = makeUserQuestionEvent(batch);

      expect(event.type).toBe('user_question');
      expect((event as { batchId: string }).batchId).toBe('batch-42');
      expect((event as { toolUseId: string }).toolUseId).toBe('tool-42');
      expect((event as { questions: UserQuestion[] }).questions).toHaveLength(2);
    });

    it('eventsByTurn record maps turnId to events array', () => {
      const batch = makeBatch({ turnId: 'turn-5' });
      const event = makeUserQuestionEvent(batch);
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-5': [event],
      };

      expect(eventsByTurn['turn-5']).toHaveLength(1);
      expect(eventsByTurn['turn-5'][0].type).toBe('user_question');
    });

    it('user_question_answered event contains persisted answer data', () => {
      const answers = [makeAnswer('q0', ['q0-opt0'], 'Custom answer')];
      const event = makeUserQuestionAnsweredEvent('batch-42', answers);

      expect(event.type).toBe('user_question_answered');
      expect((event as { batchId: string }).batchId).toBe('batch-42');
      expect((event as { answers: UserQuestionAnswer[] }).answers).toEqual(answers);
    });

    it('empty eventsByTurn produces no question batches or answers to detect', () => {
      const eventsByTurn: Record<string, AgentEvent[]> = {};
      expect(extractQuestionBatches(eventsByTurn, 'session-1')).toEqual([]);
      expect(extractAnsweredBatches(eventsByTurn).size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // buildQuestionBatchStates — dismissed state
  // ---------------------------------------------------------------------------

  describe('buildQuestionBatchStates with dismissedBatchIds', () => {
    it('marks batch as dismissed when batchId is in dismissedBatchIds set', () => {
      const batch = makeBatch({ batchId: 'batch-dismissed' });
      const eventBatches = [batch];
      const answeredBatches = new Map<string, { answers: UserQuestionAnswer[]; skipped?: boolean }>();
      const dismissedBatchIds = new Set(['batch-dismissed']);

      const states = buildQuestionBatchStates(eventBatches, answeredBatches, { dismissedBatchIds });

      expect(states).toHaveLength(1);
      expect(states[0].dismissed).toBe(true);
      expect(states[0].isAnswered).toBe(false);
    });

    it('does not mark non-dismissed batches as dismissed', () => {
      const batch = makeBatch({ batchId: 'batch-normal' });
      const eventBatches = [batch];
      const answeredBatches = new Map<string, { answers: UserQuestionAnswer[]; skipped?: boolean }>();
      const dismissedBatchIds = new Set(['other-batch']);

      const states = buildQuestionBatchStates(eventBatches, answeredBatches, { dismissedBatchIds });

      expect(states).toHaveLength(1);
      expect(states[0].dismissed).toBeUndefined();
      expect(states[0].isAnswered).toBe(false);
    });

    it('answered takes precedence over dismissed (answered + dismissed = answered, not dismissed)', () => {
      const batch = makeBatch({ batchId: 'batch-both' });
      const answers = [makeAnswer('q0', ['q0-opt0'])];
      const eventBatches = [batch];
      const answeredBatches = new Map([['batch-both', { answers, skipped: undefined }]]);
      const dismissedBatchIds = new Set(['batch-both']);

      const states = buildQuestionBatchStates(eventBatches, answeredBatches, { dismissedBatchIds });

      expect(states).toHaveLength(1);
      expect(states[0].isAnswered).toBe(true);
      expect(states[0].dismissed).toBeUndefined();
      expect(states[0].answers).toEqual(answers);
    });

    it('works correctly without dismissedBatchIds option (backwards compatible)', () => {
      const batch = makeBatch({ batchId: 'batch-compat' });
      const eventBatches = [batch];
      const answeredBatches = new Map<string, { answers: UserQuestionAnswer[]; skipped?: boolean }>();

      // Call without opts (the old 2-arg API)
      const states = buildQuestionBatchStates(eventBatches, answeredBatches);

      expect(states).toHaveLength(1);
      expect(states[0].dismissed).toBeUndefined();
      expect(states[0].isAnswered).toBe(false);
    });

    it('dismissed batch excluded from queue — multi-batch same turn', () => {
      // Scenario: 2 batches in same turn. A is answered, B is dismissed.
      // A should be answerable (not blocked by B), B excluded from payload.
      const batchA = makeBatch({ batchId: 'batch-A', turnId: 'turn-shared', timestamp: 1000 });
      const batchB = makeBatch({ batchId: 'batch-B', turnId: 'turn-shared', timestamp: 1001 });
      const answersA = [makeAnswer('q0', ['q0-opt0'])];

      const eventBatches = [batchA, batchB];
      const answeredBatches = new Map<string, { answers: UserQuestionAnswer[]; skipped?: boolean }>();
      const dismissedBatchIds = new Set(['batch-B']);

      const states = buildQuestionBatchStates(eventBatches, answeredBatches, { dismissedBatchIds });

      // A: not answered, not dismissed → pending
      expect(states[0].batch.batchId).toBe('batch-A');
      expect(states[0].isAnswered).toBe(false);
      expect(states[0].dismissed).toBeUndefined();

      // B: dismissed
      expect(states[1].batch.batchId).toBe('batch-B');
      expect(states[1].dismissed).toBe(true);

      // Now simulate answering A with local answers
      const statesWithLocalAnswer = buildQuestionBatchStates(
        eventBatches,
        answeredBatches,
        {
          localAnswers: new Map([['batch-A', { answers: answersA, skipped: false }]]),
          dismissedBatchIds,
        },
      );

      // A should now be answered
      expect(statesWithLocalAnswer[0].isAnswered).toBe(true);
      // B should still be dismissed
      expect(statesWithLocalAnswer[1].dismissed).toBe(true);
    });

    it('all batches dismissed produces no answered batches', () => {
      const batchA = makeBatch({ batchId: 'batch-A', turnId: 'turn-all-dismissed' });
      const batchB = makeBatch({ batchId: 'batch-B', turnId: 'turn-all-dismissed' });

      const eventBatches = [batchA, batchB];
      const answeredBatches = new Map<string, { answers: UserQuestionAnswer[]; skipped?: boolean }>();
      const dismissedBatchIds = new Set(['batch-A', 'batch-B']);

      const states = buildQuestionBatchStates(eventBatches, answeredBatches, { dismissedBatchIds });

      expect(states).toHaveLength(2);
      expect(states[0].dismissed).toBe(true);
      expect(states[1].dismissed).toBe(true);
      expect(states.every(s => !s.isAnswered)).toBe(true);
    });

    it('undoDismiss restores batch to pending (by removing from dismissedBatchIds)', () => {
      const batch = makeBatch({ batchId: 'batch-undo' });
      const eventBatches = [batch];
      const answeredBatches = new Map<string, { answers: UserQuestionAnswer[]; skipped?: boolean }>();

      // First: dismissed
      const dismissedStates = buildQuestionBatchStates(eventBatches, answeredBatches, {
        dismissedBatchIds: new Set(['batch-undo']),
      });
      expect(dismissedStates[0].dismissed).toBe(true);

      // After undo: batch removed from set → pending again
      const undoneStates = buildQuestionBatchStates(eventBatches, answeredBatches, {
        dismissedBatchIds: new Set(), // empty after undo
      });
      expect(undoneStates[0].dismissed).toBeUndefined();
      expect(undoneStates[0].isAnswered).toBe(false);
    });

    it('dismissed + localAnswers: local answer on non-dismissed batch is marked answered', () => {
      const batch = makeBatch({ batchId: 'batch-local' });
      const answers = [makeAnswer('q0', ['q0-opt0'])];
      const eventBatches = [batch];
      const answeredBatches = new Map<string, { answers: UserQuestionAnswer[]; skipped?: boolean }>();
      const localAnswers = new Map([['batch-local', { answers, skipped: false }]]);

      const states = buildQuestionBatchStates(eventBatches, answeredBatches, {
        localAnswers,
        dismissedBatchIds: new Set(), // not dismissed
      });

      expect(states[0].isAnswered).toBe(true);
      expect(states[0].answers).toEqual(answers);
      expect(states[0].dismissed).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // isQuestionBatchStale — stale detection
  // ---------------------------------------------------------------------------

  describe('isQuestionBatchStale', () => {
    it('returns false when the question turn is the only turn', () => {
      const batch = makeBatch({ turnId: 'turn-1', timestamp: 1000 });
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [makeUserQuestionEvent(batch)],
      };

      expect(isQuestionBatchStale(batch, eventsByTurn)).toBe(false);
    });

    it('returns false when other turns have earlier timestamps only', () => {
      const batch = makeBatch({ turnId: 'turn-2', timestamp: 2000 });
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [{ type: 'result', text: 'done', timestamp: 500 } as AgentEvent],
        'turn-2': [makeUserQuestionEvent(batch)],
      };

      expect(isQuestionBatchStale(batch, eventsByTurn)).toBe(false);
    });

    it('returns true when a later turn has events after the question', () => {
      const batch = makeBatch({ turnId: 'turn-1', timestamp: 1000 });
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [makeUserQuestionEvent(batch)],
        'turn-2': [{ type: 'result', text: 'continued', timestamp: 2000 } as AgentEvent],
      };

      expect(isQuestionBatchStale(batch, eventsByTurn)).toBe(true);
    });

    it('ignores events in the same turn (does not flag intra-turn activity)', () => {
      const batch = makeBatch({ turnId: 'turn-1', timestamp: 1000 });
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [
          makeUserQuestionEvent(batch),
          { type: 'result', text: 'same turn later', timestamp: 1500 } as AgentEvent,
        ],
      };

      expect(isQuestionBatchStale(batch, eventsByTurn)).toBe(false);
    });

    it('detects staleness across many subsequent turns', () => {
      const batch = makeBatch({ turnId: 'turn-1', timestamp: 1000 });
      const eventsByTurn: Record<string, AgentEvent[]> = {
        'turn-1': [makeUserQuestionEvent(batch)],
        'turn-2': [{ type: 'result', text: '', timestamp: 2000 } as AgentEvent],
        'turn-3': [{ type: 'result', text: '', timestamp: 3000 } as AgentEvent],
        'turn-4': [{ type: 'result', text: '', timestamp: 4000 } as AgentEvent],
      };

      expect(isQuestionBatchStale(batch, eventsByTurn)).toBe(true);
    });
  });
});
