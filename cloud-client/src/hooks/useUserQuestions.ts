/**
 * useUserQuestions Hook (cloud-client)
 *
 * Platform-agnostic version of the desktop `useUserQuestions` hook.
 * Manages inline question cards for the Ask User Questions feature.
 *
 * Detects `user_question` events from the agent (via AskUserQuestion tool),
 * tracks pending/answered state, and clears stale batches on conversation
 * truncation. Persistence of "dismissed" batch IDs is delegated to a
 * platform-provided `PersistenceAdapter` (localStorage on desktop, AsyncStorage
 * on mobile).
 *
 * Architecture (deny-and-retry):
 * 1. Agent calls AskUserQuestion → PreToolUse hook denies, dispatches
 *    `user_question` event
 * 2. Event arrives in eventsByTurn → this hook detects it → shows
 *    UserQuestionCard
 * 3. User answers → submitAnswers() → `submitAnswer` (e.g. IPC on desktop,
 *    HTTP/ipcCall on mobile) → cloud/main returns `continuationMessage` →
 *    `startContinuationTurn` is called with the continuation message
 *    (so the turn resumes via the renderer-started continuation pattern).
 *
 * See `src/renderer/features/agent-session/hooks/useUserQuestions.ts` for the
 * desktop wrapper that injects `window.agentApi`, `localStorage`, and
 * analytics tracking.
 *
 * See `docs/plans/260420_user_question_cross_surface_resilience.md` Stage 4.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type {
  AgentEvent,
  AnyAttachmentPayload,
  UserQuestion,
  UserQuestionBatch,
  UserQuestionAnswer,
} from '@shared/types';
import { classifyEventForSession } from '@rebel/shared';
import type { PersistenceAdapter } from '../persistence';

/** Module-level empty Map for memoization safety (avoids new Map() on every render) */
const EMPTY_LOCAL_ANSWERS: Map<string, LocalAnswerState> = new Map();
const QUESTION_PURPOSE_APPROVAL_CLARIFICATION = 'approval_clarification';

/**
 * Module-level dedup set for legacy-event telemetry. We emit a one-time
 * structured warning per `batchId` when we encounter a pre-fix
 * `user_question` / `user_question_answered` event that lacks the
 * authoritative origin `sessionId` field. Dedupping per `batchId`
 * prevents render-loop spam (extractQuestionBatches runs on every
 * eventsByTurn change).
 * See docs-private/investigations/260424_user_question_cross_session_routing_leak.md.
 */
const legacyEventWarningEmittedFor: Set<string> = new Set();
const chatApprovalDropWarningEmittedFor: Set<string> = new Set();

/**
 * Module-level dedup set for cross-session drop warnings. Each unique
 * `(eventType, batchId, eventSessionId, currentSessionId)` tuple emits
 * at most one structured warning per process. The Layer-4 filter still
 * drops every mismatched event on every render — this dedup only
 * prevents log-spam amplification when foreign-stamped events sit in
 * `eventsByTurn` for an extended period (e.g. via persisted-history
 * load, cache-merge, or a sibling unfixed boundary) and are
 * re-iterated on every memo recompute.
 *
 * Surfaced by Sentry REBEL-5D5 (production user, 2026-05-06): ~96 drop
 * warnings in a single 15-minute session driven by ~8 foreign batchIds
 * × multiple call-sites × heavy `eventsByTurn` churn during a long
 * tool-running turn. The drop branch was correct; only the lack of
 * dedup was wrong, drowning Sentry breadcrumbs and (likely)
 * contributing to renderer memory pressure.
 *
 * See docs-private/postmortems/260424_user_question_cross_session_routing_leak_postmortem.md
 * (Layer 4 origin) and the postmortem for this bug.
 *
 * Lifecycle: module-level — wiped on app restart and on Vite HMR in dev,
 * never in production. After restart, persisted foreign events re-warn
 * once per (tuple) on first render; that is the intended behaviour.
 */
const crossSessionDropWarningEmittedFor: Set<string> = new Set();

// ── Persistence layer — dismissed batch IDs ───────────────────────────────
const DISMISSED_STORAGE_PREFIX = 'dismissed-questions:';
type QuestionBatchSemanticPurpose = 'generic' | 'approval_clarification';

type ApprovalClarificationCandidate = {
  purpose?: 'approval_clarification';
  question?: string;
  header?: string;
  context?: string;
  options?: ReadonlyArray<{
    label?: string;
    description?: string;
    inputPlaceholder?: string;
  }>;
};

function textIncludesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function inferApprovalClarificationPurpose(
  question: ApprovalClarificationCandidate,
): 'approval_clarification' | undefined {
  if (question.purpose === QUESTION_PURPOSE_APPROVAL_CLARIFICATION) {
    return QUESTION_PURPOSE_APPROVAL_CLARIFICATION;
  }

  const combinedText = [
    question.question,
    question.header,
    question.context,
    ...(question.options ?? []).flatMap((option) => [
      option.label,
      option.description,
      option.inputPlaceholder,
    ]),
  ]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase();

  const hasApprovalBoundaryLanguage = textIncludesAny(combinedText, [
    /\bnot approval\b/,
    /\bnot permission\b/,
    /\bnot approve\b/,
    /\bbefore any send\b/,
    /\bbefore sending\b/,
    /\bafter draft approval\b/,
    /\bsafety rules\b/,
  ]);

  const mentionsSensitiveAction = textIncludesAny(combinedText, [
    /\bsend(?:ing)?\b/,
    /\bpost(?:ing)?\b/,
    /\bemail\b/,
    /\bslack\b/,
    /\bdm\b/,
    /\bmessage\b/,
    /\bschedul(?:e|ing)\b/,
    /\bpay(?:ing|ment)?\b/,
    /\bdelet(?:e|ing)\b/,
    /\bmodif(?:y|ying)\b/,
  ]);

  return hasApprovalBoundaryLanguage && mentionsSensitiveAction
    ? QUESTION_PURPOSE_APPROVAL_CLARIFICATION
    : undefined;
}

function isApprovalClarificationBatch(
  batch: { questions: ReadonlyArray<ApprovalClarificationCandidate> },
): boolean {
  if (batch.questions.length === 0) return false;
  return batch.questions.every(
    (question) => inferApprovalClarificationPurpose(question) === QUESTION_PURPOSE_APPROVAL_CLARIFICATION,
  );
}

function normalizedOptionLabels(
  question: ApprovalClarificationCandidate,
): Set<string> {
  return new Set(
    (question.options ?? [])
      .map((option) => option.label?.trim().toLowerCase())
      .filter((label): label is string => !!label),
  );
}

function isChatApprovalQuestionBatch(
  batch: { questions: ReadonlyArray<ApprovalClarificationCandidate> },
): boolean {
  if (batch.questions.length === 0) return false;

  return batch.questions.some((question) => {
    const labels = normalizedOptionLabels(question);
    const header = question.header?.trim().toLowerCase() ?? '';
    const prompt = question.question?.trim().toLowerCase() ?? '';
    const hasApprovalHeader = /^(approve|confirm|send)$/.test(header);
    const asksForSensitiveAction = /^(send|post|email|schedule|pay|delete|modify)\b/.test(prompt);
    const hasCommitOption =
      labels.has('send') ||
      labels.has('approve') ||
      labels.has('confirm') ||
      labels.has('go ahead');
    const hasCancelOption = labels.has('cancel') || labels.has('do not send');
    const hasEditOption = labels.has('edit') || labels.has('change');

    return (
      (hasApprovalHeader || asksForSensitiveAction) &&
      hasCommitOption &&
      (hasCancelOption || hasEditOption)
    );
  });
}

const getQuestionBatchSemanticPurpose = (
  batch: Pick<UserQuestionBatch, 'questions'>,
): QuestionBatchSemanticPurpose =>
  isApprovalClarificationBatch(batch) ? 'approval_clarification' : 'generic';

/**
 * Check if a question batch is stale — the conversation has continued past
 * the turn that produced the question without the user answering it.
 * A stale question should not re-appear in the footer when the user returns
 * to the conversation.
 */
export function isQuestionBatchStale(
  batch: UserQuestionBatch,
  eventsByTurn: Record<string, AgentEvent[]>,
): boolean {
  for (const [turnId, events] of Object.entries(eventsByTurn)) {
    if (turnId === batch.turnId) continue;
    for (const event of events) {
      if (event.timestamp > batch.timestamp) return true;
    }
  }
  return false;
}

/** Represents a question batch with its UI state */
export interface QuestionBatchState {
  batch: UserQuestionBatch;
  isAnswered: boolean;
  answers?: UserQuestionAnswer[];
  skipped?: boolean;
  dismissed?: boolean;
  /**
   * Convenience flag derived from `batch.questions[*].purpose`. The hook
   * extracts this so UI consumers don't have to re-implement the
   * `isApprovalClarificationBatch` check at every call site.
   */
  isApprovalClarification?: boolean;
}

export interface AnsweredBatchState {
  answers: UserQuestionAnswer[];
  skipped?: boolean;
}

interface LocalAnswerState {
  answers: UserQuestionAnswer[];
  skipped: boolean;
  continuationAttachments?: AnyAttachmentPayload[];
}

/** Submitted request to the user-question-response handler */
export interface UserQuestionSubmitRequest {
  batchId: string;
  answers: UserQuestionAnswer[];
  skipped?: boolean;
  sessionId: string;
  turnId: string;
  toolUseId: string;
  questions: UserQuestion[];
  queuedBatches?: Array<{
    batchId: string;
    answers: UserQuestionAnswer[];
    skipped?: boolean;
    questions: UserQuestion[];
  }>;
}

export interface UserQuestionContinuationContext {
  alreadyInjected: true;
  meta: {
    headerIncluded: boolean;
    headerBytes: number;
    historyIncluded: boolean;
    historyBytes: number;
    truncated: boolean;
  };
}

export interface UserQuestionSubmitResponse {
  success: boolean;
  error?: string;
  continuationMessage?: string;
  /**
   * Stage 2 of `docs/plans/260525_cross_turn_awareness_layer1_layer2.md` (F3).
   * When the handler injected `<prior_turns>` + `<conversation_history>` into
   * `continuationMessage`, this signals the caller to thread the marker into
   * the next `agent:turn` so the proactive prepend in `agentTurnExecute`
   * skips its own injection.
   */
  continuationContext?: UserQuestionContinuationContext;
}

/** Optional analytics callbacks. All are best-effort; errors are not surfaced. */
export interface UserQuestionTracking {
  onShown?: (
    batchId: string,
    questionCount: number,
    sessionId: string,
    purpose?: 'approval_clarification',
  ) => void;
  onAnswered?: (
    batchId: string,
    questionCount: number,
    sessionId: string,
    purpose?: 'approval_clarification',
  ) => void;
  onSkipped?: (
    batchId: string,
    questionCount: number,
    sessionId: string,
    purpose?: 'approval_clarification',
  ) => void;
  onDismissed?: (
    batchId: string,
    questionCount: number,
    sessionId: string,
    purpose?: 'approval_clarification',
  ) => void;
}

export interface UseUserQuestionsOptions {
  /** Platform adapter for answering the user-question-response IPC channel. */
  submitAnswer: (request: UserQuestionSubmitRequest) => Promise<UserQuestionSubmitResponse>;
  /**
   * Platform adapter for starting a continuation turn when the handler
   * returns a `continuationMessage`. On desktop this is a thin wrapper
   * around `sendContinuation` / `window.agentApi.turn`; on mobile this
   * wraps `startTurn` from `useAgentTurn` with `isSystemContinuation: true`.
   *
   * Returning a rejected promise triggers a user-facing fallback error
   * ("Answer saved, but Rebel could not continue automatically: …").
   */
  startContinuationTurn: (
    sessionId: string,
    continuationMessage: string,
    attachments?: AnyAttachmentPayload[],
    continuationContext?: UserQuestionContinuationContext,
  ) => Promise<void>;
  /**
   * Persistence adapter for dismissed batch IDs. If omitted, dismissals are
   * in-memory only and do not survive session switches. Desktop provides a
   * localStorage-backed adapter; mobile provides an AsyncStorage-backed one.
   */
  persistence?: PersistenceAdapter | null;
  /** Optional tracking callbacks (shown/answered/skipped/dismissed). */
  tracking?: UserQuestionTracking;
}

export interface UseUserQuestionsReturn {
  questionBatches: QuestionBatchState[];
  submitAnswers: (
    batchId: string,
    answers: UserQuestionAnswer[],
    continuationAttachments?: AnyAttachmentPayload[],
  ) => Promise<void>;
  /**
   * Submit an empty answer set with `skipped: true`. Used by mobile's
   * "Skip all" action. Desktop historically consolidates skip into the
   * submission flow via `SKIPPED_MARKER` freeText, so this method is
   * optional and may be omitted by callers that don't need a distinct
   * skip path.
   */
  skipBatch?: (batchId: string) => Promise<void>;
  dismissBatch: (batchId: string) => void;
  undoDismiss: (batchId: string) => void;
  dismissedBatchIds: Set<string>;
  dismissedBatchIdsLoaded: boolean;
  isSubmitting: boolean;
  submissionError: string | null;
}

/**
 * Extract user_question events from the eventsByTurn record.
 * Reconstructs UserQuestionBatch from event data + turn context.
 *
 * **Cross-session contamination guard:** if an event carries its own
 * authoritative `sessionId` (set by the emitter on the main side, see
 * `src/main/services/userQuestionHook.ts`), and that sessionId doesn't
 * match the caller's `sessionId` argument, we drop the event rather
 * than incorrectly stamping it with the caller's session. This closes
 * the session-switch race where `useDeferredValue` on `eventsByTurn`
 * paired a stale B-session snapshot with a freshly-switched
 * `currentSessionId=A` and caused a B-originated question to be
 * reconstructed as an A-session batch, routing the continuation turn
 * into the wrong conversation.
 *
 * Legacy events (emitted before the fix landed) don't carry
 * `event.sessionId`; for those we fall back to the caller's session ID
 * and emit a one-time warning per batchId for observability.
 *
 * See docs-private/investigations/260424_user_question_cross_session_routing_leak.md.
 */
export function extractQuestionBatches(
  eventsByTurn: Record<string, AgentEvent[]>,
  sessionId: string,
): UserQuestionBatch[] {
  const batches: UserQuestionBatch[] = [];
  for (const [turnId, events] of Object.entries(eventsByTurn)) {
    for (const event of events) {
      if (event.type !== 'user_question') continue;
      const classification = classifyEventForSession(event, sessionId);
      if (classification.kind === 'rejected-foreign') {
        // Renderer breadcrumb capture per AGENTS.md § Debugging — load-bearing
        // per "Silent failure is a bug". Dedupped per
        // (batchId, eventSessionId, currentSessionId) so a foreign event
        // sitting in eventsByTurn doesn't re-warn on every render.
        const dedupKey = `question:${event.batchId}:${classification.eventSessionId}:${sessionId}`;
        if (!crossSessionDropWarningEmittedFor.has(dedupKey)) {
          crossSessionDropWarningEmittedFor.add(dedupKey);
          console.warn('[extractQuestionBatches] dropped cross-session user_question event', {
            eventSessionId: classification.eventSessionId,
            currentSessionId: sessionId,
            batchId: event.batchId,
            turnId,
          });
        }
        continue;
      }
      if (classification.kind === 'accepted-legacy' && !legacyEventWarningEmittedFor.has(event.batchId)) {
        // The shared classifier treats an empty-string sessionId as missing.
        // That degenerate value is accepted as legacy to match desktop
        // validator semantics instead of preserving a cloud-only drop rule.
        legacyEventWarningEmittedFor.add(event.batchId);
        console.warn(
          '[extractQuestionBatches] legacy user_question event without sessionId — using caller sessionId',
          { batchId: event.batchId, callerSessionId: sessionId },
        );
      }
      if (isChatApprovalQuestionBatch(event)) {
        if (!chatApprovalDropWarningEmittedFor.has(event.batchId)) {
          chatApprovalDropWarningEmittedFor.add(event.batchId);
          console.warn('[extractQuestionBatches] dropped approval-like user_question event', {
            batchId: event.batchId,
            turnId,
            sessionId: event.sessionId ?? sessionId,
          });
        }
        continue;
      }
      batches.push({
        batchId: event.batchId,
        toolUseId: event.toolUseId,
        turnId,
        // Kept events are 'own' (event.sessionId === caller sessionId) or
        // 'accepted-legacy' (missing/empty/malformed provenance, used with the
        // caller session). Use the caller `sessionId` for both: `?? sessionId`
        // would leak a malformed empty-string `event.sessionId` ('' is not
        // nullish) into the batch.
        sessionId,
        questions: event.questions,
        timestamp: event.timestamp,
      });
    }
  }
  return batches;
}

/**
 * Merge persisted user-question events (from a session fetch) with live
 * user-question events (from the turn WS) into a single `eventsByTurn`
 * record suitable for {@link extractQuestionBatches} / {@link extractAnsweredBatches}.
 *
 * Dedup key is `(turnId, type, batchId)`. Live events win on conflict — they
 * are processed FIRST so later persisted entries for the same key are
 * skipped. This keeps in-session optimistic answered state (from
 * `submitAnswers` -> localAnswers merge) dominant while still letting the
 * persisted snapshot seed cards that the user answered before a force-quit.
 *
 * See docs/plans/260420_user_question_cross_surface_resilience.md (Stage 7).
 */
export function mergeUserQuestionEvents(
  liveEventsByTurn: Record<string, AgentEvent[]>,
  persistedEventsByTurn: Record<string, AgentEvent[]> | undefined,
): Record<string, AgentEvent[]> {
  if (!persistedEventsByTurn || Object.keys(persistedEventsByTurn).length === 0) {
    return liveEventsByTurn;
  }

  const merged: Record<string, AgentEvent[]> = {};
  const seen = new Map<string, Set<string>>();

  const pushUnique = (turnId: string, event: AgentEvent): void => {
    const batchId = (event as { batchId?: string }).batchId;
    if (!batchId) return;
    const key = `${event.type}:${batchId}`;
    let seenForTurn = seen.get(turnId);
    if (!seenForTurn) {
      seenForTurn = new Set();
      seen.set(turnId, seenForTurn);
    }
    if (seenForTurn.has(key)) return;
    seenForTurn.add(key);
    if (!merged[turnId]) merged[turnId] = [];
    merged[turnId].push(event);
  };

  for (const [turnId, events] of Object.entries(liveEventsByTurn)) {
    for (const event of events) pushUnique(turnId, event);
  }
  for (const [turnId, events] of Object.entries(persistedEventsByTurn)) {
    for (const event of events) pushUnique(turnId, event);
  }

  return merged;
}

/**
 * Extract answered state from user_question_answered events across all turns.
 *
 * When `sessionId` is provided, events carrying an origin `sessionId` that
 * mismatches the caller's session are dropped (defense-in-depth against
 * the cross-session routing leak — see extractQuestionBatches docstring
 * and docs-private/investigations/260424_user_question_cross_session_routing_leak.md).
 * Legacy events without `event.sessionId` are accepted with a one-time
 * telemetry warning per batchId.
 *
 * `sessionId` is optional so existing test call-sites that don't care
 * about cross-session filtering can keep passing events directly.
 */
export function extractAnsweredBatches(
  eventsByTurn: Record<string, AgentEvent[]>,
  sessionId?: string,
): Map<string, AnsweredBatchState> {
  const answeredBatches = new Map<string, AnsweredBatchState>();
  for (const [turnId, events] of Object.entries(eventsByTurn)) {
    for (const event of events) {
      if (event.type !== 'user_question_answered') continue;
      if (sessionId !== undefined) {
        const classification = classifyEventForSession(event, sessionId);
        if (classification.kind === 'rejected-foreign') {
          // Dedupped per (batchId, eventSessionId, currentSessionId) — see
          // crossSessionDropWarningEmittedFor docstring.
          const dedupKey = `answered:${event.batchId}:${classification.eventSessionId}:${sessionId}`;
          if (!crossSessionDropWarningEmittedFor.has(dedupKey)) {
            crossSessionDropWarningEmittedFor.add(dedupKey);
            console.warn('[extractAnsweredBatches] dropped cross-session user_question_answered event', {
              eventSessionId: classification.eventSessionId,
              currentSessionId: sessionId,
              batchId: event.batchId,
              turnId,
            });
          }
          continue;
        }
        if (
          classification.kind === 'accepted-legacy' &&
          !legacyEventWarningEmittedFor.has(`answered:${event.batchId}`)
        ) {
          // Empty-string provenance is aligned with desktop as legacy/missing;
          // keep the render-path warning dedup local to the cloud-client hook.
          legacyEventWarningEmittedFor.add(`answered:${event.batchId}`);
          console.warn(
            '[extractAnsweredBatches] legacy user_question_answered event without sessionId — using caller sessionId',
            { batchId: event.batchId, callerSessionId: sessionId },
          );
        }
      }
      answeredBatches.set(event.batchId, {
        answers: event.answers,
        skipped: event.skipped,
      });
    }
  }
  return answeredBatches;
}

export function buildQuestionBatchStates(
  eventBatches: UserQuestionBatch[],
  answeredBatches: Map<string, AnsweredBatchState>,
  opts?: { localAnswers?: Map<string, LocalAnswerState>; dismissedBatchIds?: Set<string> },
): QuestionBatchState[] {
  const localAnswers = opts?.localAnswers ?? EMPTY_LOCAL_ANSWERS;
  const dismissedBatchIds = opts?.dismissedBatchIds;

  return eventBatches
    .map((batch) => {
      const answeredState = answeredBatches.get(batch.batchId);
      const localAnsweredState = localAnswers.get(batch.batchId);
      const answerState = answeredState ?? (
        localAnsweredState
          ? {
            answers: localAnsweredState.answers,
            skipped: localAnsweredState.skipped ? true : undefined,
          }
          : undefined
      );

      const isApprovalClarification = isApprovalClarificationBatch(batch);

      return {
        batch,
        isAnswered: answerState !== undefined,
        answers: answerState?.answers,
        skipped: answerState?.skipped,
        isApprovalClarification: isApprovalClarification ? true : undefined,
        dismissed: dismissedBatchIds?.has(batch.batchId) && answerState === undefined ? true : undefined,
      };
    });
}

export function useUserQuestions(
  currentSessionId: string | null,
  eventsByTurn: Record<string, AgentEvent[]>,
  options: UseUserQuestionsOptions,
): UseUserQuestionsReturn {
  const { submitAnswer, startContinuationTurn, persistence, tracking } = options;

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [localAnswers, setLocalAnswers] = useState<Map<string, LocalAnswerState>>(new Map());
  const [dismissedBatchIds, setDismissedBatchIds] = useState<Set<string>>(new Set());
  const [dismissedBatchIdsLoaded, setDismissedBatchIdsLoaded] = useState(false);
  const dismissedBatchIdsRef = useRef<Set<string>>(new Set());

  // Track previous session for change detection
  const prevSessionIdRef = useRef<string | null>(null);

  // Load persisted dismissed state asynchronously on session change.
  useEffect(() => {
    if (prevSessionIdRef.current === currentSessionId) return;
    prevSessionIdRef.current = currentSessionId;

    setSubmissionError(null);
    setLocalAnswers(new Map());
    dismissedBatchIdsRef.current = new Set();
    setDismissedBatchIds(new Set());
    setDismissedBatchIdsLoaded(false);

    if (!currentSessionId || !persistence) {
      setDismissedBatchIdsLoaded(true);
      return;
    }

    let cancelled = false;
    void (async () => {
      let ids = new Set<string>();
      try {
        const stored = await persistence.getItem(`${DISMISSED_STORAGE_PREFIX}${currentSessionId}`);
        if (stored) {
          const parsed = JSON.parse(stored) as unknown;
          if (Array.isArray(parsed)) {
            ids = new Set<string>(parsed.filter((id): id is string => typeof id === 'string'));
          }
        }
      } catch {
        // Corrupt payload or adapter error — silently fall back to empty set
      }
      if (cancelled || prevSessionIdRef.current !== currentSessionId) return;
      dismissedBatchIdsRef.current = ids;
      setDismissedBatchIds(ids);
      setDismissedBatchIdsLoaded(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [currentSessionId, persistence]);

  const persistDismissed = useCallback(
    (sessionId: string, ids: Set<string>) => {
      if (!persistence) return;
      const key = `${DISMISSED_STORAGE_PREFIX}${sessionId}`;
      void (async () => {
        try {
          if (ids.size === 0) {
            await persistence.removeItem(key);
          } else {
            await persistence.setItem(key, JSON.stringify([...ids]));
          }
        } catch {
          // Persistence full/unavailable — silently degrade (matches desktop localStorage behavior).
        }
      })();
    },
    [persistence],
  );

  const eventBatches = useMemo(
    () => (currentSessionId ? extractQuestionBatches(eventsByTurn, currentSessionId) : []),
    [eventsByTurn, currentSessionId],
  );
  const answeredBatches = useMemo(
    () => extractAnsweredBatches(eventsByTurn, currentSessionId ?? undefined),
    [eventsByTurn, currentSessionId],
  );

  // Clear local answer bridge state once authoritative answered events arrive.
  useEffect(() => {
    setLocalAnswers((previous) => {
      if (previous.size === 0) {
        return previous;
      }

      const activeBatchIds = new Set(eventBatches.map((batch) => batch.batchId));
      let changed = false;
      const next = new Map(previous);

      for (const batchId of previous.keys()) {
        if (!activeBatchIds.has(batchId) || answeredBatches.has(batchId)) {
          next.delete(batchId);
          changed = true;
        }
      }

      return changed ? next : previous;
    });
  }, [eventBatches, answeredBatches]);

  // Track "shown" events once per batch (fires tracking.onShown callback).
  const shownBatchIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (eventBatches.length === 0) return;
    for (const batch of eventBatches) {
      if (!answeredBatches.has(batch.batchId)) {
        if (!shownBatchIdsRef.current.has(batch.batchId)) {
          shownBatchIdsRef.current.add(batch.batchId);
          // Stage 2 of docs/plans/260518_reduce_approval_clarification_branch_scope.md:
          // pass through purpose so analytics can split shown/answered
          // by approval-context vs generic without re-deriving.
          const purpose = isApprovalClarificationBatch(batch)
            ? 'approval_clarification'
            : undefined;
          tracking?.onShown?.(batch.batchId, batch.questions.length, batch.sessionId, purpose);
        }
      }
    }
  }, [eventBatches, answeredBatches, tracking]);

  // In-flight guard keyed by batchId. Prevents rapid double-taps (mobile) or
  // double-clicks (desktop) from sending two submit requests before
  // `setIsSubmitting(true)` reaches the next render and re-renders disable
  // the submit button. React state updates are batched/async, so the
  // button-disabled state cannot be relied on to serialize calls.
  // See: multi-model review Finding "mobile double-tap race".
  const inFlightBatchIdsRef = useRef<Set<string>>(new Set());

  const submitBatchResponse = useCallback(async (
    batchId: string,
    response: LocalAnswerState,
    failureMessage: string,
  ) => {
    if (inFlightBatchIdsRef.current.has(batchId)) {
      // Another submit for this batch is already in flight. Drop the retry
      // silently — the in-flight request will deliver the same outcome.
      return;
    }
    inFlightBatchIdsRef.current.add(batchId);

    setIsSubmitting(true);
    setSubmissionError(null);

    try {
      const batch = eventBatches.find((b) => b.batchId === batchId);
      if (!batch) throw new Error('Batch not found');

      const nextLocalAnswers = new Map(localAnswers);
      nextLocalAnswers.set(batchId, response);

      const batchPurpose = getQuestionBatchSemanticPurpose(batch);
      const turnBatches = eventBatches
        .filter((eventBatch) =>
          eventBatch.turnId === batch.turnId &&
          getQuestionBatchSemanticPurpose(eventBatch) === batchPurpose,
        )
        .sort((a, b) => a.timestamp - b.timestamp);

      const currentDismissedIds = dismissedBatchIdsRef.current;

      const hasUnansweredBatches = turnBatches.some((turnBatch) => {
        if (turnBatch.batchId === batchId) return false;
        if (currentDismissedIds.has(turnBatch.batchId)) return false;
        return !answeredBatches.has(turnBatch.batchId) && !nextLocalAnswers.has(turnBatch.batchId);
      });

      if (hasUnansweredBatches) {
        setLocalAnswers(nextLocalAnswers);
        return;
      }

      const queuedResponses = turnBatches
        .filter((turnBatch) =>
          !currentDismissedIds.has(turnBatch.batchId) &&
          !answeredBatches.has(turnBatch.batchId),
        )
        .map((turnBatch) => {
          const localAnswerState = nextLocalAnswers.get(turnBatch.batchId);
          if (!localAnswerState) {
            throw new Error(`Missing local answer state for batch: ${turnBatch.batchId}`);
          }
          return {
            batch: turnBatch,
            answers: localAnswerState.answers,
            skipped: localAnswerState.skipped ? true : undefined,
            continuationAttachments: localAnswerState.continuationAttachments,
          };
        });

      if (queuedResponses.length === 0) {
        return;
      }

      const [firstResponse] = queuedResponses;
      if (!firstResponse) {
        throw new Error('No queued responses available for submission');
      }

      const result = await submitAnswer({
        batchId: firstResponse.batch.batchId,
        answers: firstResponse.answers,
        ...(firstResponse.skipped ? { skipped: true } : {}),
        sessionId: firstResponse.batch.sessionId,
        turnId: firstResponse.batch.turnId,
        toolUseId: firstResponse.batch.toolUseId,
        questions: firstResponse.batch.questions,
        ...(queuedResponses.length > 1
          ? {
            queuedBatches: queuedResponses.map((queuedResponse) => ({
              batchId: queuedResponse.batch.batchId,
              answers: queuedResponse.answers,
              ...(queuedResponse.skipped ? { skipped: true } : {}),
              questions: queuedResponse.batch.questions,
            })),
          }
          : {}),
      });

      if (!result.success) {
        setSubmissionError(result.error ?? failureMessage);
        setLocalAnswers((previous) => {
          const reverted = new Map(previous);
          for (const queuedResponse of queuedResponses) {
            reverted.delete(queuedResponse.batch.batchId);
          }
          return reverted;
        });
        return;
      }

      // Optimistically record the submitted answers in localAnswers so the
      // card flips to "answered" immediately on every surface, without
      // depending on a `user_question_answered` agent event reaching the
      // client. Desktop receives the authoritative event via IPC broadcast
      // and the `localAnswers`-clearing effect then hands ownership to
      // `answeredBatches`. Cloud/mobile clients currently never receive
      // that event (agent:event is excluded from the cloud event
      // broadcaster; see docs/plans/260420_user_question_cross_surface_resilience.md
      // Stage 6 Finding A), so this local entry is what makes the UI move.
      //
      // Single-batch case (hasUnansweredBatches === false) previously
      // fell through here without persisting localAnswers, which left the
      // mobile card stuck in its pending state forever — this block fixes
      // that regression.
      setLocalAnswers((previous) => {
        const next = new Map(previous);
        for (const queuedResponse of queuedResponses) {
          next.set(queuedResponse.batch.batchId, {
            answers: queuedResponse.answers,
            skipped: queuedResponse.skipped === true,
            continuationAttachments: queuedResponse.continuationAttachments,
          });
        }
        return next;
      });

      for (const queuedResponse of queuedResponses) {
        const purpose = isApprovalClarificationBatch(queuedResponse.batch)
          ? 'approval_clarification'
          : undefined;
        if (queuedResponse.skipped) {
          tracking?.onSkipped?.(
            queuedResponse.batch.batchId,
            queuedResponse.batch.questions.length,
            queuedResponse.batch.sessionId,
            purpose,
          );
        } else {
          tracking?.onAnswered?.(
            queuedResponse.batch.batchId,
            queuedResponse.batch.questions.length,
            queuedResponse.batch.sessionId,
            purpose,
          );
        }
      }

      const continuationMessage =
        typeof result.continuationMessage === 'string' ? result.continuationMessage : undefined;
      if (!continuationMessage) return;

      const continuationAttachments = queuedResponses.flatMap(
        (queuedResponse) => queuedResponse.continuationAttachments ?? [],
      );

      try {
        await startContinuationTurn(
          batch.sessionId,
          continuationMessage,
          continuationAttachments.length > 0 ? continuationAttachments : undefined,
          result.continuationContext,
        );
      } catch (continuationErr) {
        const message = continuationErr instanceof Error
          ? continuationErr.message
          : 'Automatic continuation failed';
        setSubmissionError(`Answer saved, but Rebel could not continue automatically: ${message}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setSubmissionError(message);
      const batch = eventBatches.find((b) => b.batchId === batchId);
      if (batch) {
        const turnBatchIds = eventBatches
          .filter((b) => b.turnId === batch.turnId)
          .map((b) => b.batchId);
        setLocalAnswers((previous) => {
          const reverted = new Map(previous);
          for (const id of turnBatchIds) {
            reverted.delete(id);
          }
          return reverted;
        });
      }
    } finally {
      inFlightBatchIdsRef.current.delete(batchId);
      setIsSubmitting(false);
    }
  }, [answeredBatches, eventBatches, localAnswers, submitAnswer, startContinuationTurn, tracking]);

  const submitAnswers = useCallback(async (
    batchId: string,
    answers: UserQuestionAnswer[],
    continuationAttachments?: AnyAttachmentPayload[],
  ) => {
    await submitBatchResponse(
      batchId,
      { answers, skipped: false, continuationAttachments },
      'Failed to submit answers',
    );
  }, [submitBatchResponse]);

  const skipBatch = useCallback(async (batchId: string) => {
    await submitBatchResponse(batchId, { answers: [], skipped: true }, 'Failed to skip batch');
  }, [submitBatchResponse]);

  const dismissBatch = useCallback((batchId: string) => {
    const batch = eventBatches.find((b) => b.batchId === batchId);
    if (!batch) return;

    const nextDismissedIds = new Set(dismissedBatchIdsRef.current);
    nextDismissedIds.add(batchId);

    dismissedBatchIdsRef.current = nextDismissedIds;
    setDismissedBatchIds(nextDismissedIds);

    if (currentSessionId) {
      persistDismissed(currentSessionId, nextDismissedIds);
    }

    const purpose = isApprovalClarificationBatch(batch)
      ? 'approval_clarification'
      : undefined;
    tracking?.onDismissed?.(batchId, batch.questions.length, batch.sessionId, purpose);

    // Flush-if-ready: if a sibling batch in the same turn is already locally
    // answered, its submission was gated by this now-dismissed batch.
    const turnBatches = eventBatches.filter((b) => b.turnId === batch.turnId);
    for (const turnBatch of turnBatches) {
      if (turnBatch.batchId === batchId) continue;
      if (nextDismissedIds.has(turnBatch.batchId)) continue;
      if (answeredBatches.has(turnBatch.batchId)) continue;
      const localAnswer = localAnswers.get(turnBatch.batchId);
      if (localAnswer) {
        void submitBatchResponse(turnBatch.batchId, localAnswer, 'Failed to submit answers');
        break;
      }
    }
  }, [eventBatches, answeredBatches, localAnswers, submitBatchResponse, currentSessionId, persistDismissed, tracking]);

  const undoDismiss = useCallback((batchId: string) => {
    if (answeredBatches.has(batchId)) return;

    const batch = eventBatches.find((b) => b.batchId === batchId);
    if (batch) {
      const hasSiblingAnswered = eventBatches.some(
        (b) => b.turnId === batch.turnId && b.batchId !== batchId && answeredBatches.has(b.batchId),
      );
      if (hasSiblingAnswered) return;
    }

    setDismissedBatchIds((prev) => {
      if (!prev.has(batchId)) return prev;
      const next = new Set(prev);
      next.delete(batchId);
      dismissedBatchIdsRef.current = next;
      if (currentSessionId) {
        persistDismissed(currentSessionId, next);
      }
      return next;
    });
  }, [answeredBatches, eventBatches, currentSessionId, persistDismissed]);

  // Auto-detect stale batches — unanswered questions from turns the
  // conversation has moved past.
  const staleBatchIds = useMemo(() => {
    const ids = new Set<string>();
    for (const batch of eventBatches) {
      if (answeredBatches.has(batch.batchId)) continue;
      if (isQuestionBatchStale(batch, eventsByTurn)) {
        ids.add(batch.batchId);
      }
    }
    return ids;
  }, [eventBatches, answeredBatches, eventsByTurn]);

  const effectiveDismissedBatchIds = useMemo(() => {
    if (staleBatchIds.size === 0) return dismissedBatchIds;
    const merged = new Set(dismissedBatchIds);
    for (const id of staleBatchIds) merged.add(id);
    return merged;
  }, [dismissedBatchIds, staleBatchIds]);

  const questionBatches = useMemo((): QuestionBatchState[] => {
    if (!currentSessionId) return [];
    return buildQuestionBatchStates(eventBatches, answeredBatches, { localAnswers, dismissedBatchIds: effectiveDismissedBatchIds });
  }, [currentSessionId, eventBatches, answeredBatches, localAnswers, effectiveDismissedBatchIds]);

  return {
    questionBatches,
    submitAnswers,
    skipBatch,
    dismissBatch,
    undoDismiss,
    dismissedBatchIds: effectiveDismissedBatchIds,
    dismissedBatchIdsLoaded,
    isSubmitting,
    submissionError,
  };
}
