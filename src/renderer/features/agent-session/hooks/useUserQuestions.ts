/**
 * useUserQuestions Hook — Desktop Wrapper
 *
 * Thin wrapper around the platform-agnostic `useUserQuestions` hook in
 * `cloud-client`. Injects:
 *   - `submitAnswer` backed by `window.agentApi.userQuestionResponse()`
 *   - `startContinuationTurn` that tries the queue-based `sendContinuation`
 *     first and falls back to `window.agentApi.turn({ isSystemContinuation: true })`
 *   - A `localStorage`-backed `PersistenceAdapter` for dismissed batch IDs
 *   - Desktop analytics via `tracking.userQuestions.*`
 *
 * See `cloud-client/src/hooks/useUserQuestions.ts` for the lifted hook that
 * mobile also consumes (via its own MMKV/AsyncStorage adapter + HTTP submit).
 *
 * See `docs/plans/260420_user_question_cross_surface_resilience.md` Stage 4.
 */

import { useEffect, useMemo, useRef } from 'react';
import type {
  AgentEvent,
  AnyAttachmentPayload,
  UserQuestionAnswer,
} from '@shared/types';
import type { PersistenceAdapter } from '@rebel/cloud-client';
import {
  useUserQuestions as useUserQuestionsCore,
  type UseUserQuestionsReturn,
  type UserQuestionTracking,
} from '@rebel/cloud-client';
import { tracking } from '@renderer/src/tracking';
import {
  useSessionStore,
} from '../store/sessionStore';
import { startSystemContinuationTurnWithOptimisticLifecycle } from './useAgentSessionEngine';

export type {
  QuestionBatchState,
  AnsweredBatchState,
  UseUserQuestionsReturn,
  UserQuestionSubmitRequest,
  UserQuestionSubmitResponse,
} from '@rebel/cloud-client';

export {
  buildQuestionBatchStates,
  extractQuestionBatches,
  extractAnsweredBatches,
  isQuestionBatchStale,
} from '@rebel/cloud-client';

/**
 * localStorage-backed PersistenceAdapter for the desktop surface.
 *
 * Implements the `PersistenceAdapter` contract with synchronous localStorage
 * calls wrapped in promises. Errors (quota, unavailable) degrade silently,
 * matching the original hook's behavior.
 */
const desktopLocalStoragePersistence: PersistenceAdapter = {
  getItem: async (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: async (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // quota/unavailable — degrade silently
    }
  },
  removeItem: async (key) => {
    try {
      localStorage.removeItem(key);
    } catch {
      // unavailable — degrade silently
    }
  },
};

/**
 * Desktop tracking glue — forwards to the existing `tracking.userQuestions.*`
 * analytics API.
 */
const desktopTracking: UserQuestionTracking = {
  onShown: (batchId, count, sessionId, purpose) =>
    tracking.userQuestions.shown(batchId, count, sessionId, purpose),
  onAnswered: (batchId, count, sessionId, purpose) =>
    tracking.userQuestions.answered(batchId, count, sessionId, purpose),
  onSkipped: (batchId, count, sessionId, purpose) =>
    tracking.userQuestions.skipped(batchId, count, sessionId, purpose),
  onDismissed: (batchId, count, sessionId, purpose) =>
    tracking.userQuestions.dismissed(batchId, count, sessionId, purpose),
};

export function useUserQuestions(
  currentSessionId: string | null,
  eventsByTurn: Record<string, AgentEvent[]>,
  sendContinuation?: (
    sessionId: string,
    message: string,
    attachments?: AnyAttachmentPayload[],
    continuationContext?: import('@rebel/cloud-client').UserQuestionContinuationContext,
  ) => Promise<void> | void,
): UseUserQuestionsReturn {
  const options = useMemo(
    () => ({
      submitAnswer: async (request: Parameters<NonNullable<typeof window.agentApi.userQuestionResponse>>[0]) => {
        const result = await window.agentApi.userQuestionResponse(request);
        return {
          success: result.success,
          error: result.error,
          continuationMessage: result.continuationMessage,
          continuationContext: result.continuationContext,
        };
      },
      /**
       * Prefer the queue-based continuation when provided (used by the
       * conversation pane draft preservation pipeline). On failure, fall
       * back to a direct `agent:turn` call with `isSystemContinuation: true`
       * so the renderer-started continuation still starts the next turn.
       *
       * `continuationContext` is the F3 anti-double-injection marker — when
       * present the `agentTurnExecute` proactive prepend skips its own
       * `<prior_turns>`/`<conversation_history>` injection. See
       * `docs/plans/260525_cross_turn_awareness_layer1_layer2.md`.
       */
      startContinuationTurn: async (
        sessionId: string,
        continuationMessage: string,
        attachments?: AnyAttachmentPayload[],
        continuationContext?: import('@rebel/cloud-client').UserQuestionContinuationContext,
      ) => {
        if (sendContinuation) {
          try {
            await Promise.resolve(
              sendContinuation(sessionId, continuationMessage, attachments, continuationContext),
            );
            return;
          } catch (continuationErr) {
            console.warn(
              '[useUserQuestions] Queue-based continuation failed — falling back to direct turn start',
              { sessionId, err: continuationErr },
            );
          }
        }
        // Route direct fallback through the engine-shared optimistic lifecycle
        // path so real-event supersede and send-failure cleanup stay unified.
        await startSystemContinuationTurnWithOptimisticLifecycle({
          sessionId,
          prompt: continuationMessage,
          attachments,
          continuationContext,
        });
      },
      persistence: desktopLocalStoragePersistence,
      tracking: desktopTracking,
    }),
    [sendContinuation],
  );

  const result = useUserQuestionsCore(currentSessionId, eventsByTurn, options);
  const mirroredSessionIdRef = useRef<string | null>(currentSessionId);
  const setDismissedQuestionBatchIdsForSession = useSessionStore(
    (state) => state.setDismissedQuestionBatchIdsForSession,
  );

  useEffect(() => {
    if (!currentSessionId) return;
    const sessionChanged = mirroredSessionIdRef.current !== currentSessionId;
    mirroredSessionIdRef.current = currentSessionId;
    if (sessionChanged) {
      return;
    }
    if (!result.dismissedBatchIdsLoaded && result.dismissedBatchIds.size === 0) {
      return;
    }
    setDismissedQuestionBatchIdsForSession(
      currentSessionId,
      [...result.dismissedBatchIds],
    );
  }, [
    currentSessionId,
    result.dismissedBatchIds,
    result.dismissedBatchIdsLoaded,
    setDismissedQuestionBatchIdsForSession,
  ]);

  // Desktop callers historically only took `submitAnswers`/`dismissBatch`/
  // `undoDismiss`; expose the lifted hook's return shape unchanged.
  return result;
}

/**
 * Legacy alias — some tests and callers import `submitAnswers` as
 * `submitAnswers(batchId, answers)`. The lifted hook keeps the same
 * signature, so the wrapper return shape is compatible.
 */
export type { UserQuestionAnswer };
