/**
 * User Question Response Handler
 *
 * Platform-agnostic IPC handler for processing user answers to `AskUserQuestion`
 * batches. Registered via `getHandlerRegistry().register()` so both desktop
 * (Electron IPC) and cloud (HTTP /api/ipc/:channel) surfaces invoke the same code.
 *
 * Flow:
 * 1. Validate payload, dedup already-answered batches.
 * 2. Emit `user_question_answered` agent event(s) so renderer cards update.
 * 3. Build a continuation message from the answers.
 * 4. Inject the original turn's conversation context (from the accumulator) to
 *    preserve thread continuity across the pause.
 * 5. Clear the `hasUserQuestionPending` flag.
 * 6. Return `{ success, continuationMessage }` — the renderer/client then calls
 *    `startTurn` with `isSystemContinuation: true` to open the continuation turn.
 *    The handler does NOT invoke `executeAgentTurn` server-side (see
 *    docs/plans/260414_user_question_renderer_started_continuation.md).
 *
 * Desktop extraction: moved from `src/main/ipc/agentHandlers.ts` (was inline there
 * since March) into core for reuse by cloud-service per
 * docs/plans/260420_user_question_cross_surface_resilience.md.
 */

import { getHandlerRegistry } from '@core/handlerRegistry';
import { createScopedLogger } from '@core/logger';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import { buildContinuationContext } from '@core/services/buildContinuationContext';
import { broadcastSequencedAgentEvent } from '@core/services/agentEventBroadcast';
import type { AgentEvent } from '@shared/types';
import type { SequencedAgentEvent } from '@shared/utils/eventIdentity';
import {
  buildMultiBatchContinuationMessage,
  buildUserQuestionContinuationMessage,
  buildUserQuestionSkipMessage,
} from '@core/services/userQuestionService';
import type { UserQuestion, UserQuestionAnswer, UserQuestionBatch } from '@shared/types/userQuestion';
import {
  QUESTION_PURPOSE_APPROVAL_CLARIFICATION,
  isApprovalClarificationBatch,
} from '@shared/types/userQuestion';

const logger = createScopedLogger({ service: 'userQuestionResponseHandler' });

// Bounded idempotency cache — prevents unbounded growth for the process
// lifetime. FIFO eviction when the cap is reached. One cache per process
// (desktop main and each cloud instance keeps its own — acceptable, since
// the cache only exists to handle near-simultaneous duplicate submissions
// from the same client).
//
// We used to store only the batchId and short-circuit duplicates with
// `{ success: true }`. That was a silent-failure bug: if the first
// response was lost in transit and the client retried, the duplicate was
// acknowledged but no `continuationMessage` was returned, leaving the
// turn stuck forever (docs-private/postmortems/260420_empty_result_anomaly_askuserquestion_deny_postmortem.md
// review Finding: idempotency gap). We now cache the full result so a
// retry replays the original continuation payload.
//
// Cache key is `${sessionId}:${turnId}:${batchId}` (not just `batchId`) —
// defense in depth against the cross-session routing leak fixed in
// docs-private/investigations/260424_user_question_cross_session_routing_leak.md.
// Without this, a retry from the correctly-displayed session would
// replay the first (wrongly-routed) continuation into the correct
// session too.
const MAX_ANSWERED_BATCH_IDS = 200;
const answeredBatchResults = new Map<string, UserQuestionResponseResult>();

const makeCacheKey = (sessionId: string, turnId: string, batchId: string): string =>
  `${sessionId}:${turnId}:${batchId}`;

const trackAnsweredBatch = (
  sessionId: string,
  turnId: string,
  batchId: string,
  result: UserQuestionResponseResult,
): void => {
  answeredBatchResults.set(makeCacheKey(sessionId, turnId, batchId), result);
  if (answeredBatchResults.size > MAX_ANSWERED_BATCH_IDS) {
    const oldest = answeredBatchResults.keys().next().value;
    if (oldest !== undefined) answeredBatchResults.delete(oldest);
  }
};

const getCachedResult = (
  sessionId: string,
  turnId: string,
  batchId: string,
): UserQuestionResponseResult | undefined =>
  answeredBatchResults.get(makeCacheKey(sessionId, turnId, batchId));

// Exposed for testing only — resets the cache between test cases.
// eslint-disable-next-line @typescript-eslint/naming-convention -- `_testing_` prefix is the convention for test-only public hooks; preferred over a parallel internal module
export const _testing_resetAnsweredBatches = (): void => {
  answeredBatchResults.clear();
};

export interface UserQuestionResponseRequest {
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

export interface UserQuestionResponseResult {
  success: boolean;
  error?: string;
  continuationMessage?: string;
  /**
   * Stage 2 of `docs/plans/260525_cross_turn_awareness_layer1_layer2.md` (F3).
   * When this handler injected `<prior_turns>` + `<conversation_history>` into
   * `continuationMessage`, the renderer threads this back into the next
   * `agent:turn` so the proactive prepend in `agentTurnExecute` skips its
   * own injection.
   */
  continuationContext?: {
    alreadyInjected: true;
    meta: {
      headerIncluded: boolean;
      headerBytes: number;
      historyIncluded: boolean;
      historyBytes: number;
      truncated: boolean;
    };
  };
}

interface UserQuestionResponseBatch {
  batchId: string;
  answers: UserQuestionAnswer[];
  skipped?: boolean;
  questions: UserQuestion[];
}

/**
 * Persistence hook for `user_question_answered` events. Injected by surfaces
 * that need server-side rehydration (cloud), a no-op on desktop where the
 * renderer's session store already persists via the `agent:event` broadcast.
 *
 * The handler invokes this AFTER appending to the in-memory accumulator and
 * BEFORE returning the continuation. Failures are logged but do not block
 * the response — the user's answer is still honored; only cross-session
 * visibility is degraded. See:
 *   docs-private/postmortems/260420_empty_result_anomaly_askuserquestion_deny_postmortem.md
 *   docs/plans/260420_user_question_cross_surface_resilience.md (Stage 7)
 *
 * The `event` parameter is typed as `SequencedAgentEvent<…>` (the branded
 * stamped form) so passing the raw `answeredEvent` literal is a TypeScript
 * error — only events returned by `LazyContextAccumulator.appendEvent` are
 * assignable. This eliminates the variable-swap bug class fixed in
 * `d154d6146`. See:
 *   docs-private/postmortems/260502_persist_user_question_answered_unstamped_postmortem.md
 */
export type PersistUserQuestionAnsweredFn = (
  sessionId: string,
  turnId: string,
  event: SequencedAgentEvent<Extract<AgentEvent, { type: 'user_question_answered' }>>,
) => void | Promise<void>;

export type ResolveUserQuestionProvenanceFn = (
  sessionId: string,
  turnId: string,
  batchId: string,
) =>
  | Extract<AgentEvent, { type: 'user_question' }>
  | undefined
  | Promise<Extract<AgentEvent, { type: 'user_question' }> | undefined>;

let persistAnsweredEventImpl: PersistUserQuestionAnsweredFn | undefined;
let resolveQuestionProvenanceImpl: ResolveUserQuestionProvenanceFn | undefined;

/**
 * Register a platform-specific persister for `user_question_answered` events.
 * Called at boot from the cloud bootstrap; desktop leaves this unset and
 * relies on the renderer's session store.
 */
export function setUserQuestionAnsweredPersister(fn: PersistUserQuestionAnsweredFn | undefined): void {
  persistAnsweredEventImpl = fn;
}

/**
 * Register a platform-specific resolver for authoritative persisted
 * `user_question` provenance. Used when an approval-context card survives
 * beyond the in-memory turn accumulator/provenance index (for example an
 * already-rendered desktop card after main-process reload). The resolver must
 * read from trusted session storage, not from the client submit payload.
 */
export function setUserQuestionProvenanceResolver(fn: ResolveUserQuestionProvenanceFn | undefined): void {
  resolveQuestionProvenanceImpl = fn;
}

// Exposed for testing only — resets the persister between test cases.
// eslint-disable-next-line @typescript-eslint/naming-convention -- `_testing_` prefix is the convention for test-only public hooks
export const _testing_resetAnsweredPersister = (): void => {
  persistAnsweredEventImpl = undefined;
};

// Exposed for testing only — resets the provenance resolver between test cases.
// eslint-disable-next-line @typescript-eslint/naming-convention -- intentional `_testing_*` test-seam naming; matches the adjacent `_testing_resetAnsweredPersister` export above
export const _testing_resetQuestionProvenanceResolver = (): void => {
  resolveQuestionProvenanceImpl = undefined;
};

export function findPersistedUserQuestionProvenance(
  turnEvents: readonly AgentEvent[],
  sessionId: string,
  batchId: string,
): Extract<AgentEvent, { type: 'user_question' }> | undefined {
  return turnEvents.find(
    (event): event is Extract<AgentEvent, { type: 'user_question' }> =>
      event.type === 'user_question' && event.batchId === batchId,
  );
}

/**
 * Find the authoritative stored `user_question` event for a given batch in
 * the turn's context accumulator. When present, the stored sessionId is used
 * for the cross-session routing guard. Missing provenance is not a special
 * approval-clarification rejection path; the answer still only resumes the
 * conversation and normal approval remains required later.
 */
async function findStoredQuestionEvent(
  batchTurnId: string,
  batchId: string,
  sessionId: string,
): Promise<Extract<AgentEvent, { type: 'user_question' }> | undefined> {
  const indexedEvent = agentTurnRegistry.getUserQuestionProvenance(batchTurnId, batchId);
  if (indexedEvent) return indexedEvent;

  const accumulator = agentTurnRegistry.getContextAccumulator(batchTurnId);
  const turnEvents = accumulator?.eventsByTurn[batchTurnId] ?? [];
  const accumulatedEvent = turnEvents.find(
    (evt): evt is Extract<AgentEvent, { type: 'user_question' }> =>
      evt.type === 'user_question' && evt.batchId === batchId,
  );
  if (accumulatedEvent) return accumulatedEvent;

  return resolveQuestionProvenanceImpl?.(sessionId, batchTurnId, batchId);
}

async function validateResponseBatchSession(
  responseBatch: UserQuestionResponseBatch,
  sessionId: string,
  batchTurnId: string,
): Promise<UserQuestionResponseResult | undefined> {
  const storedQuestionEvent = await findStoredQuestionEvent(
    batchTurnId,
    responseBatch.batchId,
    sessionId,
  );

  if (
    storedQuestionEvent?.sessionId &&
    storedQuestionEvent.sessionId !== sessionId
  ) {
    logger.warn(
      {
        batchId: responseBatch.batchId,
        batchTurnId,
        requestSessionId: sessionId,
        storedSessionId: storedQuestionEvent.sessionId,
      },
      'user_question queued response session mismatch — rejected',
    );
    return { success: false, error: 'Session mismatch for user question batch' };
  }

  return undefined;
}

/**
 * Handle a user-question response. Platform-agnostic — no Electron imports,
 * no HTTP imports. The calling surface (desktop IPC / cloud HTTP) is
 * responsible only for transporting the request and response.
 */
export async function handleUserQuestionResponse(
  request: UserQuestionResponseRequest,
): Promise<UserQuestionResponseResult> {
  const {
    batchId,
    answers,
    skipped,
    sessionId,
    turnId: batchTurnId,
    toolUseId,
    questions,
    queuedBatches,
  } = request;

  if (!batchId || typeof batchId !== 'string') {
    logger.error({ batchId }, 'Invalid batchId in user question response');
    return { success: false, error: 'Invalid batch ID' };
  }

  const queuedResponseBatches: UserQuestionResponseBatch[] = queuedBatches ?? [];
  const hasQueuedBatches = queuedResponseBatches.length > 0;

  // Guard against duplicate submissions (e.g., double-click race or
  // retry-after-lost-response). Replay the cached result before the
  // approval-context provenance guard below: successful approval-context
  // answers delete the accumulator, so a lost HTTP/IPC response
  // would otherwise retry into the stricter no-provenance rejection.
  // Cache key includes sessionId + turnId + batchId, preserving the
  // cross-session safety boundary.
  if (hasQueuedBatches) {
    const allQueuedBatchIdsAnswered = queuedResponseBatches.every(
      (queuedBatch) => getCachedResult(sessionId, batchTurnId, queuedBatch.batchId) !== undefined,
    );
    if (allQueuedBatchIdsAnswered) {
      const cached = getCachedResult(sessionId, batchTurnId, batchId);
      logger.warn(
        {
          batchId,
          queuedBatchIds: queuedResponseBatches.map((queuedBatch) => queuedBatch.batchId),
          hasCachedContinuation: cached?.continuationMessage !== undefined,
        },
        'Duplicate queued user question response — replaying cached continuation',
      );
      return cached ?? { success: true };
    }
  } else {
    const cached = getCachedResult(sessionId, batchTurnId, batchId);
    if (cached !== undefined) {
      logger.warn(
        { batchId, hasCachedContinuation: cached.continuationMessage !== undefined },
        'Duplicate user question response — replaying cached continuation',
      );
      return cached;
    }
  }

  // Use stored provenance when available for the cross-session routing guard.
  // `approval_clarification` is intentionally lightweight here: it affects UI,
  // copy, and tracking, but answering it is still just a conversation continuation.
  // The normal approval flow remains the authority before any sensitive action executes.
  const storedLeadQuestionEvent = batchTurnId && batchId
    ? await findStoredQuestionEvent(batchTurnId, batchId, sessionId)
    : undefined;
  const leadIsApprovalClarification =
    storedLeadQuestionEvent !== undefined &&
    isApprovalClarificationBatch(storedLeadQuestionEvent);
  const requestQuestionsAreApprovalClarification = isApprovalClarificationBatch({ questions });
  const requestIsApprovalClarification =
    storedLeadQuestionEvent !== undefined
      ? leadIsApprovalClarification
      : requestQuestionsAreApprovalClarification;

  // Cross-session routing guard (fail-closed).
  //
  // The client attaches `request.sessionId`, but that field raced with
  // session switches in the renderer (stale eventsByTurn snapshot paired
  // with the fresh currentSessionId), which caused a B-session question's
  // answer to be routed as a continuation turn into unrelated session A.
  // We now validate `request.sessionId` against the authoritative origin
  // sessionId stamped on the `user_question` event when it was emitted,
  // which is stored in the turn's context accumulator. The accumulator
  // persists beyond the ephemeral rendererSessionByTurn map (which
  // `agentTurnRegistry.cleanupTurn` deletes), so this check survives
  // most cleanup paths.
  //
  // Policy for generic questions:
  // - Stored event with mismatching sessionId → reject.
  // - No stored event (post-restart, accumulator GC'd, or legacy event
  //   without sessionId) → allow with telemetry. Documented intentional
  //   policy, not a silent pass.
  //
  // Approval clarification intentionally follows the same session guard as
  // generic questions. Missing provenance no longer rejects the answer because
  // clarification is not an approval object or execution channel.
  //
  // See docs-private/investigations/260424_user_question_cross_session_routing_leak.md
  // and docs/plans/260518_reduce_approval_clarification_branch_scope.md Stage 2.
  if (sessionId && batchId && batchTurnId) {
    if (storedLeadQuestionEvent) {
      if (
        storedLeadQuestionEvent.sessionId &&
        storedLeadQuestionEvent.sessionId !== sessionId
      ) {
        logger.warn(
          {
            requestSessionId: sessionId,
            storedSessionId: storedLeadQuestionEvent.sessionId,
            batchId,
            batchTurnId,
          },
          'user_question response session mismatch — rejected',
        );
        return { success: false, error: 'Session mismatch for user question batch' };
      }
      if (!storedLeadQuestionEvent.sessionId) {
        // Legacy event emitted before this fix landed — no authoritative
        // sessionId to validate against. Log explicitly so the legacy
        // allow-path is observable (CLAUDE.md: "Silent failure is a bug").
        logger.warn(
          { batchId, batchTurnId, requestSessionId: sessionId },
          'user_question validation: stored event missing sessionId (legacy pre-fix) — allowing with telemetry',
        );
      }
    } else {
      logger.info(
        {
          batchId,
          batchTurnId,
          sessionId,
          purpose: requestIsApprovalClarification
            ? QUESTION_PURPOSE_APPROVAL_CLARIFICATION
            : undefined,
        },
        'user_question validation: no provenance event in accumulator — allowing with telemetry',
      );
    }
  }

  const responseBatches = hasQueuedBatches
    ? queuedResponseBatches
    : [{ batchId, answers, skipped, questions }];

  const skippedBatchWithAnswers = responseBatches.find(
    (responseBatch) => responseBatch.skipped && responseBatch.answers.length > 0,
  );
  if (skippedBatchWithAnswers) {
    logger.warn(
      { batchId: skippedBatchWithAnswers.batchId },
      'Cannot provide answers when skipping',
    );
    return { success: false, error: 'Cannot provide answers when skipping' };
  }

  if (!sessionId || !batchTurnId || !toolUseId || !questions) {
    logger.warn({ batchId }, 'Missing required batch context in request');
    return { success: false, error: 'Question batch context missing or incomplete' };
  }

  for (const responseBatch of responseBatches) {
    if (responseBatch.batchId === batchId) {
      continue;
    }
    const validationError = await validateResponseBatchSession(
      responseBatch,
      sessionId,
      batchTurnId,
    );
    if (validationError) return validationError;
  }

  const responseTimestamp = Date.now();

  let continuationMessage: string;
  let logData: Record<string, unknown>;

  if (hasQueuedBatches) {
    const accumulator = agentTurnRegistry.getOrCreateAccumulator(batchTurnId, sessionId);
    const queuedResponses = responseBatches.map((responseBatch) => ({
      batch: {
        batchId: responseBatch.batchId,
        sessionId,
        turnId: batchTurnId,
        toolUseId,
        questions: responseBatch.questions,
        timestamp: responseTimestamp,
      },
      answers: responseBatch.answers,
      skipped: responseBatch.skipped,
    }));

    for (const responseBatch of responseBatches) {
      const answeredEvent: Extract<AgentEvent, { type: 'user_question_answered' }> = {
        type: 'user_question_answered',
        batchId: responseBatch.batchId,
        answers: responseBatch.answers,
        ...(responseBatch.skipped ? { skipped: true } : {}),
        // Stamp the authoritative origin sessionId so downstream consumers
        // (extractAnsweredBatches, session-rehydration replay) don't rely on
        // render-props that can race with session switches. See
        // docs-private/investigations/260424_user_question_cross_session_routing_leak.md.
        sessionId,
        timestamp: responseTimestamp,
      };

      // appendEvent returns SequencedAgentEvent<Extract<...>> — the brand
      // is required by persistAnsweredEventImpl below, so passing the raw
      // unstamped `answeredEvent` would be a TypeScript error. See
      // docs-private/postmortems/260502_persist_user_question_answered_unstamped_postmortem.md.
      const stampedAnsweredEvent = accumulator.appendEvent(answeredEvent, sessionId);

      // Emit answered events for all queued batches so renderer cards update
      // together. Desktop receives this via IPC broadcast; cloud's event
      // broadcaster currently excludes `agent:event`, so cloud clients rely
      // on the optimistic `localAnswers` state in `useUserQuestions` to flip
      // the card to answered. See multi-model review Finding A for the
      // structural fix (persisting user_question events through to session
      // rehydration on restart), tracked separately.
      broadcastSequencedAgentEvent({
        turnId: batchTurnId,
        sessionId,
        event: stampedAnsweredEvent,
      });

      // Platform-specific persistence (cloud only — see
      // setUserQuestionAnsweredPersister). Fire-and-forget: the user's
      // answer is already honored in-memory; persistence failures only
      // affect cross-session rehydration, which we log but don't surface
      // as a user-visible error.
      //
      // Persist the STAMPED event so cloud/mobile rehydration sees the
      // sequenced shape (matches the broadcast above and the I14/I17
      // invariant that persisted events carry seq).
      if (persistAnsweredEventImpl) {
        try {
          await persistAnsweredEventImpl(sessionId, batchTurnId, stampedAnsweredEvent);
        } catch (err) {
          logger.warn(
            { batchId: responseBatch.batchId, sessionId, err: err instanceof Error ? err.message : String(err) },
            'Failed to persist user_question_answered event to session',
          );
        }
      }
    }

    continuationMessage = buildMultiBatchContinuationMessage(queuedResponses);
    logData = {
      batchId,
      sessionId,
      batchCount: responseBatches.length,
      answerCount: responseBatches.reduce(
        (sum, responseBatch) => sum + responseBatch.answers.length,
        0,
      ),
      skippedBatchCount: responseBatches.filter((responseBatch) => responseBatch.skipped).length,
    };
    logger.info(logData, 'Processing queued user question responses — sending continuation');
  } else {
    const accumulator = agentTurnRegistry.getOrCreateAccumulator(batchTurnId, sessionId);
    const batch: UserQuestionBatch = {
      batchId,
      sessionId,
      turnId: batchTurnId,
      toolUseId,
      questions,
      timestamp: responseTimestamp, // Fallback for timestamp since we don't send it via IPC
    };

    const answeredEvent: Extract<AgentEvent, { type: 'user_question_answered' }> = {
      type: 'user_question_answered',
      batchId,
      answers,
      ...(skipped ? { skipped: true } : {}),
      // See multi-batch path above — authoritative origin sessionId for
      // cross-session-leak defense.
      sessionId,
      timestamp: responseTimestamp,
    };

    // appendEvent returns SequencedAgentEvent<Extract<...>>; the brand is
    // required by persistAnsweredEventImpl below.
    const stampedAnsweredEvent = accumulator.appendEvent(answeredEvent, sessionId);

    // Emit answered event so the renderer can update the UI. Desktop
    // receives this via IPC broadcast; cloud's event broadcaster excludes
    // `agent:event` (see cloudEventBroadcaster.ts EXCLUDED_CHANNELS), so
    // cloud clients rely on the optimistic `localAnswers` state in
    // `useUserQuestions` to flip the card to answered in-session.
    broadcastSequencedAgentEvent({
      turnId: batch.turnId,
      sessionId: batch.sessionId,
      event: stampedAnsweredEvent,
    });

    // Platform-specific persistence (cloud only — see comment above).
    // Persist the STAMPED event (carries seq) for cross-surface rehydration
    // parity with the broadcast site and the I14/I17 invariant.
    if (persistAnsweredEventImpl) {
      try {
        await persistAnsweredEventImpl(sessionId, batch.turnId, stampedAnsweredEvent);
      } catch (err) {
        logger.warn(
          { batchId, sessionId, err: err instanceof Error ? err.message : String(err) },
          'Failed to persist user_question_answered event to session',
        );
      }
    }

    continuationMessage = skipped
      ? buildUserQuestionSkipMessage(batch)
      : buildUserQuestionContinuationMessage(batch, answers);
    logData = { batchId, sessionId, answerCount: answers.length, skipped: !!skipped };
    logger.info(
      logData,
      `Processing user question ${skipped ? 'skip' : 'response'} — sending continuation`,
    );
  }

  // Build conversation context from the original turn's context accumulator.
  // The renderer's session persistence is debounced (~300ms), so if the user
  // answers quickly the disk snapshot may be empty. The main process accumulator
  // has the original turn's events and can reconstruct context without disk I/O.
  // This prevents the continuation turn from losing all conversation context and
  // having to rebuild from scratch (which causes a perceived multi-minute stall).
  //
  // Stage 2 of `docs/plans/260525_cross_turn_awareness_layer1_layer2.md`:
  // routes through the canonical `buildContinuationContext` so the
  // continuation prompt also gets a `<prior_turns>` header (when enabled),
  // and threads `continuationContext: { alreadyInjected: true }` back to
  // the renderer so `agentTurnExecute` skips its proactive prepend (F3).
  let contextPrefix = '';
  let continuationContextHandoff: UserQuestionResponseResult['continuationContext'];
  const originalAccumulated = agentTurnRegistry.getContextAccumulator(batchTurnId);
  if (originalAccumulated) {
    // currentTurnId is `undefined` here, NOT `batchTurnId`. The continuation
    // produces a logical next turn whose id has not been issued yet, so the
    // batch's own id is a PRIOR turn from the next turn's perspective —
    // filtering it out would drop the most relevant summary and defeat the
    // bda78829 redo-suppression scenario this feature exists to fix.
    const builtContext = await buildContinuationContext({
      sessionId,
      currentTurnId: undefined,
      scope: 'main',
      resetConversation: false,
      modeInput: {
        mode: 'continuation-accumulator',
        accumulator: { messages: originalAccumulated.messages },
      },
      turnLogger: logger,
    });
    contextPrefix = builtContext.prefix;
    if (builtContext.prefix.length > 0) {
      continuationContextHandoff = {
        alreadyInjected: true,
        meta: builtContext.meta,
      };
      logger.info(
        {
          batchId,
          sessionId,
          contextLength: contextPrefix.length,
          headerIncluded: builtContext.meta.headerIncluded,
          historyIncluded: builtContext.meta.historyIncluded,
        },
        'Injected conversation context from accumulator into continuation prompt',
      );
    }
    agentTurnRegistry.deleteContextAccumulator(batchTurnId);
  }
  // Always clear the pending flag after extraction (or absence) so it doesn't
  // leak if the user answers but the accumulator was already gone.
  agentTurnRegistry.clearUserQuestionProvenance(batchTurnId);
  agentTurnRegistry.clearUserQuestionPending(batchTurnId);

  const fullContinuationMessage = contextPrefix + continuationMessage;

  logger.info(
    { batchId, sessionId, continuationLength: fullContinuationMessage.length },
    'User question response processed — returning continuation message',
  );

  const finalResult: UserQuestionResponseResult = {
    success: true,
    continuationMessage: fullContinuationMessage,
    ...(continuationContextHandoff ? { continuationContext: continuationContextHandoff } : {}),
  };

  // Cache the full result (including continuation) for every batchId we
  // just satisfied, so a duplicate retry replays the same continuation
  // payload instead of receiving a bare success acknowledgement that
  // would silently strand the turn.
  //
  // Cache key includes sessionId + turnId so a retry from a different
  // session (cross-session leak scenario) cannot replay the continuation
  // into the wrong session. See
  // docs-private/investigations/260424_user_question_cross_session_routing_leak.md.
  for (const responseBatch of responseBatches) {
    trackAnsweredBatch(sessionId, batchTurnId, responseBatch.batchId, finalResult);
  }

  return finalResult;
}

/**
 * Register the `agent:user-question-response` handler with the current
 * HandlerRegistry. Called at boot from:
 *   - desktop: `src/main/ipc/agentHandlers.ts`
 *   - cloud:   `cloud-service/src/bootstrap.ts`
 *
 * The channel is cloud-routable: it is registered in the cloud IPC allowlist
 * (`cloud-service/src/routes/ipc.ts`).
 */
export function registerUserQuestionResponseHandler(): void {
  getHandlerRegistry().register(
    'agent:user-question-response',
    async (_event: unknown, ...args: unknown[]): Promise<UserQuestionResponseResult> => {
      const request = args[0] as UserQuestionResponseRequest;
      return handleUserQuestionResponse(request);
    },
  );
}
