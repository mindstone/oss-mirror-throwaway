import { useCallback, useEffect, useState, useRef } from 'react';
import type { AnyAttachmentPayload } from '@shared/types';
import { createId } from '@renderer/utils/stringUtils';
import type { EmitLogFn } from '@renderer/contexts';
import {
  getRequeueMessageId,
  isTargetBusyRejection,
} from '@shared/utils/agentTurnAdmission';
import { assertNever } from '@shared/utils/assertNever';
import { STALE_TURN_THRESHOLD_MS } from '../utils/runtimeState';

/** Structural slice of AgentSessionSummary consumed by the queue's busy gate. */
export type SessionBusySummaryLike = {
  isBusy?: boolean;
  activeTurnId?: string | null;
  lastActivityAt?: number | null;
};

/**
 * Busy predicate for queue gating on a session SUMMARY (background sessions).
 *
 * Applies staleness AT READ TIME: `applySummaryBusyStaleness` only runs inside
 * `setSessionSummaries` (startup load / cloud-sync reload), so for a local-only
 * user a stuck `isBusy: true` summary would NEVER auto-clear — a queued message
 * would be stranded forever. A summary whose `lastActivityAt` is older than
 * STALE_TURN_THRESHOLD_MS is therefore treated as NOT busy (same predicate as
 * `applySummaryBusyStaleness`, sessionStore.ts). Fail-open is safe: the Stage 2
 * main-process admission guard converts a false-idle dispatch into a typed
 * refusal, never a cancellation. Unknown session (no summary) → not busy
 * (fresh sessions are idle by construction; main guard backstops).
 * See docs/plans/260610_queue-drain-cancels-turn/PLAN.md Stage 1.
 */
export const isSummaryBusyForQueueGate = (
  summary: SessionBusySummaryLike | undefined,
  now: number = Date.now(),
): boolean => {
  if (!summary) return false;
  const lastActivityAt = typeof summary.lastActivityAt === 'number' ? summary.lastActivityAt : null;
  const isStaleBusy = lastActivityAt !== null && now - lastActivityAt > STALE_TURN_THRESHOLD_MS;
  return Boolean(summary.isBusy || summary.activeTurnId) && !isStaleBusy;
};

/** Queue mode: 'queue' waits in line, 'sendNow' jumps to front and interrupts */
export type QueueMode = 'queue' | 'sendNow';
export type QueuedMessageQueueMode = QueueMode | 'sendNow-via-tray';

/** Explicit user interrupts: sendNow (composer / forced edit-rerun) and tray promotion. */
const isInterruptQueueMode = (
  queueMode: QueuedMessageQueueMode | undefined,
): boolean => queueMode === 'sendNow' || queueMode === 'sendNow-via-tray';

/**
 * Single derivation of the admission policy from QUEUE INTENT at dispatch
 * time, shared by BOTH dispatch sites (natural drain + immediate send) so the
 * derivations cannot drift (runtime-safety F11). Deliberately NOT derived from
 * `messageOrigin` (scroll/analytics vocabulary).
 *
 * Only explicit interrupts (sendNow / sendNow-via-tray) keep the legacy
 * supersede backstop (no policy); every other dispatch — 'queue', legacy
 * entries with no recorded mode, system continuations included (no carve-out)
 * — carries 'reject' so the main-process admission guard refuses instead of
 * cancelling the target's active turn on a TOCTOU race.
 *
 * Exhaustive over the closed renderer literal union: a future QueueMode
 * member fails to compile here instead of silently diverging the two sites.
 * (This union never crosses IPC, so exhaustiveness is safe — the open-union
 * caution applies to the `supersedePolicy` field itself, handled main-side.)
 * See docs/plans/260610_queue-drain-cancels-turn/PLAN.md Stage 3.
 */
export const supersedePolicyForQueueMode = (
  queueMode: QueuedMessageQueueMode | undefined,
): 'reject' | undefined => {
  switch (queueMode) {
    case 'sendNow':
    case 'sendNow-via-tray':
      return undefined;
    case 'queue':
    case undefined:
      return 'reject';
    default:
      return assertNever(queueMode, 'supersedePolicyForQueueMode');
  }
};

/**
 * Single-shot fallback retry for a refusal-deferred target (runtime-safety
 * F4): deferral normally lifts when `isSessionBusy` identity changes (summary
 * churn), but if no churn ever arrives the queued message would be stranded.
 * One timer per deferred target clears the deferral and nudges the drain
 * effect to re-evaluate; a premature retry is safe (the main admission guard
 * refuses again at worst, which re-defers and re-arms).
 */
export const DEFERRED_TARGET_RETRY_FALLBACK_MS = 15_000;

type QueuedMessage = {
  id: string;
  text: string;
  timestamp: number;
  source: 'text' | 'voice';
  attachments?: AnyAttachmentPayload[];
  editTargetMessageId?: string;
  existingMessageId?: string;
  targetSessionId?: string;
  /** Override the model for this turn only (e.g., Haiku for simple directive tasks) */
  modelOverride?: string;
  /** Override thinking model for this turn only ('' suppresses plan mode) */
  thinkingModelOverride?: string;
  /** Mark the session as done after this turn completes successfully */
  doneAfterComplete?: boolean;
  /** Enable unleashed mode for fire-and-forget inbox tasks */
  unleashedMode?: boolean;
  /** Session type: 'manual' for interactive UI, 'automation' for background tasks */
  sessionType?: 'manual' | 'automation';
  /** Bypass tool safety evaluation (for automation sessions that use their own safety gate) */
  bypassToolSafety?: boolean;
  /** Mark as system continuation (e.g., approval retry) — skips coaching scheduler */
  isSystemContinuation?: boolean;
  /**
   * 260622 Stage 4: bypass the Chief-of-Staff admission gate for this one turn
   * (the "Run without my instructions" recovery escape). Forwarded onto the
   * `agent:turn` request; never persisted on the session.
   */
  proceedWithoutChiefOfStaff?: boolean;
  /** Hide the user message from conversation UI (still sent to LLM) */
  isHidden?: boolean;
  /** Optional display-friendly message text persisted on the user message */
  displayText?: string;
  /** Queue entry mode at enqueue/promote time (used for drain-time origin stamping) */
  queueMode?: QueuedMessageQueueMode;
  /** Original message origin at enqueue time (resolved at drain time for queued sends) */
  messageOrigin?: import('@shared/types').AgentTurnMessage['messageOrigin'];
  /**
   * Stage 2 of `docs/plans/260525_cross_turn_awareness_layer1_layer2.md` (F3).
   * Threaded by `userQuestionResponseHandler` via `handleInboxSendMessage` →
   * `submitQueuedMessage`. When present, the renderer forwards it onto the
   * next `agent:turn` so `agentTurnExecute` skips its proactive prepend.
   */
  continuationContext?: import('@shared/types').AgentTurnRequest['continuationContext'];
  /**
   * Per-message callback fired after this message's dispatch resolves successfully
   * (i.e. after `processMessage` / `rerunEditedMessage` await returns). It is NEVER
   * fired on removal (`removeFromQueue`, `clearQueueForSession`, session delete),
   * rejection, or app-restart. The closure is garbage-collected with the QueuedMessage.
   *
   * Throws (sync) and rejected promises (async) from the callback are caught
   * and logged at `error` level — they never propagate to the caller of
   * `handleUserMessage` nor abort subsequent queue processing. Fire-and-forget:
   * async callbacks are NOT awaited, so queue drain latency is unaffected.
   *
   * See `docs/project/ARCHITECTURE_MESSAGE_QUEUE.md` for full semantics. Used by
   * document-annotation "Send to Rebel" flow to clear staged annotations only when
   * the message actually dispatches.
   */
  onCommit?: () => void | Promise<void>;
};

/**
 * Invoke a QueuedMessage's `onCommit` callback (if any) with error isolation.
 *
 * Handles both synchronous throws AND rejected promises from async callbacks:
 * both are caught and logged at `error` level, but NEVER propagate to the
 * caller. Fire-and-forget — the queue does NOT await the callback, so drain
 * latency is not impacted by slow clean-up work. Silent failure is forbidden —
 * every throw/rejection is observable via the emitted log.
 */
function invokeOnCommitSafely(message: QueuedMessage, emitLog: EmitLogFn): void {
  const callback = message.onCommit;
  if (!callback) return;
  const logFailure = (error: unknown, phase: 'threw' | 'rejected') => {
    emitLog({
      level: 'error',
      message: `Message queue onCommit callback ${phase}`,
      context: {
        sessionId: message.targetSessionId,
        callbackType: 'onCommit',
        error: error instanceof Error ? error.message : String(error)
      },
      timestamp: Date.now()
    });
  };
  try {
    const result = callback();
    if (result && typeof (result as Promise<void>).then === 'function') {
      (result as Promise<void>).catch((error: unknown) => logFailure(error, 'rejected'));
    }
  } catch (error) {
    logFailure(error, 'threw');
  }
}

type UseMessageQueueOptions = {
  isBusy: boolean;
  isStopping: boolean;
  activeTurnId?: string | null;
  currentSessionId: string;
  /**
   * Busy probe for sessions OTHER than the current one (the current session
   * uses the fresher projected-liveness `isBusy` prop). REQUIRED — no
   * optional-with-fallback: a silent fallback to the viewed-session gate is
   * exactly the bug that let a queued message cancel a background session's
   * active turn (incident f6b3e9b0, plan 260610_queue-drain-cancels-turn).
   */
  isSessionBusy: (sessionId: string) => boolean;
  stopActiveTurn: () => Promise<void>;
  processMessage: (
    text: string,
    source: 'text' | 'voice',
    attachments?: AnyAttachmentPayload[],
    existingMessageId?: string,
    targetSessionId?: string,
    options?: { isSystemContinuation?: boolean; proceedWithoutChiefOfStaff?: boolean; modelOverride?: string; thinkingModelOverride?: string; doneAfterComplete?: boolean; unleashedMode?: boolean; sessionType?: 'manual' | 'automation'; bypassToolSafety?: boolean; isHidden?: boolean; displayText?: string; messageOrigin?: import('@shared/types').AgentTurnMessage['messageOrigin']; continuationContext?: import('@shared/types').AgentTurnRequest['continuationContext']; supersedePolicy?: import('@shared/types').AgentTurnRequest['supersedePolicy'] }
  ) => Promise<void>;
  rerunEditedMessage: (
    targetMessageId: string,
    newText: string,
    source: 'text' | 'voice',
    attachments?: AnyAttachmentPayload[]
  ) => Promise<void>;
  emitLog: EmitLogFn;
  showToast: (options: { title: string }) => void;
  onUserSubmit?: () => void;
};

export const useMessageQueue = ({
  isBusy,
  isStopping,
  activeTurnId,
  currentSessionId,
  isSessionBusy,
  stopActiveTurn,
  processMessage,
  rerunEditedMessage,
  emitLog,
  showToast,
  onUserSubmit,
}: UseMessageQueueOptions) => {
  const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>([]);
  const [_isProcessingQueue, setIsProcessingQueue] = useState(false);
  const [pendingInputSource, setPendingInputSource] = useState<'voice' | 'text' | null>(null);
  // Use a ref for synchronous lock to prevent race conditions.
  // React state updates are async, so the useEffect could re-trigger before
  // isProcessingQueue state is updated, causing duplicate processNextInQueue calls.
  const isProcessingRef = useRef(false);

  // Targets whose dispatch was refused at admission (typed target-busy
  // rejection, Stage 3 of plan 260610_queue-drain-cancels-turn). Anti-hot-loop
  // (DA F6): a refusal requeues the message, which mutates the queue and would
  // re-fire the drain effect immediately — without deferral it would re-reject
  // until the winning turn's summary flips busy. Deferred targets are treated
  // as busy by targetBusy() for NON-interrupt entries; the set is cleared
  // whenever `isSessionBusy` identity changes (App wires it on
  // [sessionSummaries], and background terminal/busy events always produce a
  // new summaries array), so the retry happens exactly when new busy
  // information arrives. Backstop: each deferred target also arms ONE
  // single-shot fallback timer (DEFERRED_TARGET_RETRY_FALLBACK_MS) so a
  // churn-less app cannot strand the message forever (runtime-safety F4).
  const deferredTargetsRef = useRef<Set<string>>(new Set());
  const deferralRetryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Bumped by the fallback timer to wake the drain effect (refs alone don't).
  const [deferralRetryNonce, setDeferralRetryNonce] = useState(0);

  // Sessions whose queue was purged (session delete / explicit clear), with
  // the purge timestamp. Consulted by the refusal catches: a dispatch that was
  // in flight when its target was cleared must DROP on refusal instead of
  // requeueing — otherwise the requeue resurrects a message the delete just
  // purged (runtime-safety F6). Entries are inert once no dispatch predates
  // them (the catch compares against its own dispatch start time).
  const clearedTargetsRef = useRef<Map<string, number>>(new Map());
  // Global sibling for clearQueue() (clear-ALL): same hazard, different entry
  // point — an in-flight refusal must not resurrect a message the user just
  // cleared via clear-all either.
  const clearedAllAtRef = useRef<number | null>(null);

  // Single F6 predicate shared by both refusal catches (drain + immediate) so
  // the per-session and global tombstone checks can't drift.
  const wasTargetPurgedMidFlight = useCallback(
    (sessionId: string, dispatchStartedAt: number): boolean => {
      const clearedAt = clearedTargetsRef.current.get(sessionId);
      if (clearedAt !== undefined && clearedAt >= dispatchStartedAt) return true;
      const clearedAllAt = clearedAllAtRef.current;
      return clearedAllAt !== null && clearedAllAt >= dispatchStartedAt;
    },
    []
  );

  const deferTarget = useCallback((sessionId: string) => {
    deferredTargetsRef.current.add(sessionId);
    if (!deferralRetryTimersRef.current.has(sessionId)) {
      const handle = setTimeout(() => {
        deferralRetryTimersRef.current.delete(sessionId);
        deferredTargetsRef.current.delete(sessionId);
        // New state → drain effect re-evaluates; the main guard makes a
        // premature retry safe (worst case: refused again → re-defer/re-arm).
        setDeferralRetryNonce((nonce) => nonce + 1);
      }, DEFERRED_TARGET_RETRY_FALLBACK_MS);
      deferralRetryTimersRef.current.set(sessionId, handle);
    }
  }, []);

  // Explicit interrupt (sendNow / tray promotion) must never be blocked by
  // deferral state (GPT F1 / runtime-safety F5): clear both the deferral and
  // its fallback timer for the target.
  const clearDeferralForTarget = useCallback((sessionId: string) => {
    deferredTargetsRef.current.delete(sessionId);
    const handle = deferralRetryTimersRef.current.get(sessionId);
    if (handle !== undefined) {
      clearTimeout(handle);
      deferralRetryTimersRef.current.delete(sessionId);
    }
  }, []);

  useEffect(() => {
    // New busy information → lift all deferrals (and their fallback timers);
    // declared BEFORE the drain effect below so a wake-up sees the cleared
    // set in the same pass. The returned cleanup also covers unmount.
    const timers = deferralRetryTimersRef.current;
    const clearAll = () => {
      deferredTargetsRef.current.clear();
      for (const handle of timers.values()) clearTimeout(handle);
      timers.clear();
    };
    clearAll();
    return clearAll;
  }, [isSessionBusy]);

  // Per-TARGET busy resolution (Stage 1, plan 260610_queue-drain-cancels-turn).
  // The current session uses the projected-liveness `isBusy` prop exactly as
  // the old gate did (fresher than summaries; keeps sendNow drain timing
  // identical, and deliberately ignores isStopping — drain-gate parity).
  // Any other session uses the summary-backed isSessionBusy probe.
  // Refusal deferral applies only to NON-interrupt entries: a sendNow /
  // sendNow-via-tray entry carries no supersedePolicy, so it can never be
  // refused (never hot-loops) — and it is the user's explicit zombie-turn
  // escape hatch, which stale deferral state must not delay (GPT F1 / RS F5).
  // NOTE: Do NOT use effectivelyIdle for the current session - that would
  // drain while the old turn is still alive.
  const targetBusy = useCallback(
    (sessionId: string, queueMode?: QueuedMessageQueueMode) =>
      (!isInterruptQueueMode(queueMode) && deferredTargetsRef.current.has(sessionId))
      || (sessionId === currentSessionId ? isBusy : isSessionBusy(sessionId)),
    [currentSessionId, isBusy, isSessionBusy]
  );

  const processNextInQueue = useCallback(async () => {
    // Check ref first for synchronous lock - prevents race condition where
    // the effect re-triggers before React state update is applied
    if (messageQueue.length === 0 || isProcessingRef.current) {
      return;
    }

    // First-eligible selection: FIFO per target session, skip-ahead across
    // targets. A busy-target head must not starve other targets; messages for
    // the same target never reorder (once a target's head is skipped, every
    // later message for that target is pinned via skippedTargets, even if the
    // busy probe were to flicker mid-scan).
    const skippedTargets = new Set<string>();
    let firstEligible: QueuedMessage | undefined;
    for (const candidate of messageQueue) {
      const candidateTarget = candidate.targetSessionId ?? currentSessionId;
      if (skippedTargets.has(candidateTarget) || targetBusy(candidateTarget, candidate.queueMode)) {
        skippedTargets.add(candidateTarget);
        continue;
      }
      firstEligible = candidate;
      break;
    }
    if (!firstEligible) {
      return;
    }
    const nextMessage = firstEligible;

    // Set ref immediately (synchronous) to prevent concurrent calls
    isProcessingRef.current = true;
    setIsProcessingQueue(true);

    emitLog({
      level: 'info',
      message: 'Processing next queued message',
      context: {
        queueLength: messageQueue.length,
        messageSource: nextMessage.source,
        targetSessionId: nextMessage.targetSessionId,
        skippedBusyTargets: skippedTargets.size
      },
      timestamp: Date.now()
    });

    // Remove by id, not slice(1): the picked message may not be the head
    // (skip-ahead across busy targets).
    setMessageQueue((prev) => prev.filter((m) => m.id !== nextMessage.id));

    // Captured so the refusal catch can tell whether the target's queue was
    // purged WHILE this dispatch was in flight (runtime-safety F6).
    const dispatchStartedAt = Date.now();

    try {
      if (nextMessage.editTargetMessageId) {
        await rerunEditedMessage(
          nextMessage.editTargetMessageId,
          nextMessage.text,
          nextMessage.source,
          nextMessage.attachments
        );
      } else {
        const options: { isSystemContinuation?: boolean; proceedWithoutChiefOfStaff?: boolean; modelOverride?: string; thinkingModelOverride?: string; doneAfterComplete?: boolean; unleashedMode?: boolean; sessionType?: 'manual' | 'automation'; bypassToolSafety?: boolean; isHidden?: boolean; displayText?: string; messageOrigin?: import('@shared/types').AgentTurnMessage['messageOrigin']; continuationContext?: import('@shared/types').AgentTurnRequest['continuationContext']; supersedePolicy?: import('@shared/types').AgentTurnRequest['supersedePolicy'] } = {};
        if (nextMessage.modelOverride) options.modelOverride = nextMessage.modelOverride;
        if (nextMessage.thinkingModelOverride !== undefined) options.thinkingModelOverride = nextMessage.thinkingModelOverride;
        if (nextMessage.doneAfterComplete) options.doneAfterComplete = nextMessage.doneAfterComplete;
        if (nextMessage.unleashedMode) options.unleashedMode = nextMessage.unleashedMode;
        if (nextMessage.sessionType) options.sessionType = nextMessage.sessionType;
        if (nextMessage.bypassToolSafety) options.bypassToolSafety = nextMessage.bypassToolSafety;
        if (nextMessage.isSystemContinuation) options.isSystemContinuation = nextMessage.isSystemContinuation;
        if (nextMessage.proceedWithoutChiefOfStaff) options.proceedWithoutChiefOfStaff = nextMessage.proceedWithoutChiefOfStaff;
        if (nextMessage.isHidden) options.isHidden = nextMessage.isHidden;
        if (nextMessage.displayText !== undefined) options.displayText = nextMessage.displayText;
        if (nextMessage.continuationContext) options.continuationContext = nextMessage.continuationContext;
        // Preserve 'system-continuation' origin when the enqueuer explicitly set it
        // (e.g. AskUserQuestion / approval continuations). Explicit send-now drains
        // use user-typed semantics; natural queue drains use queue-drain semantics.
        const messageOriginToUse = nextMessage.messageOrigin === 'system-continuation'
          ? 'system-continuation'
          : isInterruptQueueMode(nextMessage.queueMode)
            ? 'user-typed'
            : 'queue-drain';
        options.messageOrigin = messageOriginToUse;

        // Admission policy from QUEUE INTENT at dispatch time — single shared
        // derivation with the immediate-send site (see
        // supersedePolicyForQueueMode docstring for the full contract).
        const supersedePolicy = supersedePolicyForQueueMode(nextMessage.queueMode);
        if (supersedePolicy !== undefined) {
          options.supersedePolicy = supersedePolicy;
        }

        const sourceQueueMode = nextMessage.queueMode ?? 'unknown';

        emitLog({
          level: 'info',
          message: 'Processing next queued message',
          context: {
            queuedMessageId: nextMessage.id,
            stampedOrigin: messageOriginToUse,
            sourceQueueMode,
            isHidden: nextMessage.isHidden ?? false,
          },
          timestamp: Date.now()
        });

        // Re-check targetSessionId at drain time: if the target now matches the
        // current session, pass undefined so processMessage uses the normal
        // addUserMessage path (same-session). This prevents the cross-session
        // branch from being taken when the user simply switched away and back.
        const effectiveTarget = nextMessage.targetSessionId === currentSessionId
          ? undefined
          : nextMessage.targetSessionId;
        await processMessage(
          nextMessage.text,
          nextMessage.source,
          nextMessage.attachments,
          nextMessage.existingMessageId,
          effectiveTarget,
          options,
        );
      }
      // Dispatch resolved successfully — fire the per-message onCommit hook (if any).
      // Failures inside the callback are isolated (logged, never re-thrown) so a
      // misbehaving clean-up hook can't break the queue. Never reached on reject/throw
      // because we're past the `await`.
      invokeOnCommitSafely(nextMessage, emitLog);
    } catch (error) {
      if (isTargetBusyRejection(error)) {
        // Typed admission refusal (target busy, reject-policy dispatch): the
        // message is NOT lost — re-enqueue the same QueuedMessage at the FRONT
        // (it was the earliest eligible; preserves per-target FIFO, keeps
        // attachments/onCommit/metadata) and defer the target until new busy
        // information arrives. No error toast; onCommit deliberately not fired
        // (it only fires on successful dispatch — we're in the catch).
        // Same-session refusals carry the persisted message id so the
        // re-drain dedups instead of duplicating (FMM 9).
        const requeueTarget = nextMessage.targetSessionId ?? currentSessionId;
        if (wasTargetPurgedMidFlight(requeueTarget, dispatchStartedAt)) {
          // The target's queue was purged (session delete / per-session clear
          // / global clear-all) while this dispatch was in flight — requeueing
          // would resurrect a message the purge already removed
          // (runtime-safety F6). Drop it instead.
          emitLog({
            level: 'info',
            message: 'Queued message refused at admission but target session was cleared mid-flight — dropping (no requeue)',
            context: {
              queuedMessageId: nextMessage.id,
              targetSessionId: requeueTarget,
            },
            timestamp: Date.now()
          });
        } else {
          const requeueMessageId = getRequeueMessageId(error);
          const requeuedMessage: QueuedMessage = {
            ...nextMessage,
            existingMessageId: requeueMessageId ?? nextMessage.existingMessageId,
          };
          deferTarget(requeueTarget);
          setMessageQueue((prev) => [requeuedMessage, ...prev]);
          emitLog({
            level: 'info',
            message: 'Queued message refused at admission (target busy) — requeued at front',
            context: {
              queuedMessageId: nextMessage.id,
              targetSessionId: requeueTarget,
              existingMessageId: requeuedMessage.existingMessageId,
            },
            timestamp: Date.now()
          });
        }
      } else {
        emitLog({
          level: 'error',
          message: 'Failed to process queued message',
          context: {
            error: error instanceof Error ? error.message : String(error)
          },
          timestamp: Date.now()
        });
        showToast({ title: '⚠️ Failed to process queued message' });
      }
    } finally {
      setPendingInputSource(null);
      setIsProcessingQueue(false);
      isProcessingRef.current = false;
    }
  }, [currentSessionId, deferTarget, emitLog, messageQueue, processMessage, rerunEditedMessage, setPendingInputSource, showToast, targetBusy, wasTargetPurgedMidFlight]);

  useEffect(() => {
    // Use ref for the processing check to avoid race conditions.
    // The ref is updated synchronously in processNextInQueue, while state is async.
    // Drain fires when ANY queued message's TARGET session is idle (per-target
    // gate) — not when the viewed session goes idle: draining on the viewed
    // session's state is what cancelled a background session's active turn in
    // incident f6b3e9b0. isSessionBusy identity changes on every meaningful
    // summary change (App wires it on [sessionSummaries]), so a background
    // target completing re-fires this effect via targetBusy.
    if (messageQueue.length === 0 || isProcessingRef.current) {
      return;
    }
    const eligibleMessage = messageQueue.find(
      (m) => !targetBusy(m.targetSessionId ?? currentSessionId, m.queueMode)
    );
    if (eligibleMessage) {
      emitLog({
        level: 'info',
        message: 'Queue drain triggered: idle target session has a queued message',
        context: {
          queueLength: messageQueue.length,
          eligibleMessageId: eligibleMessage.id,
          eligibleTargetSessionId: eligibleMessage.targetSessionId,
          currentSessionId,
          currentSessionBusy: isBusy,
          // Distinguishes fallback-timer wake-ups (runtime-safety F4) from
          // queue/summary-churn wake-ups in the drain logs.
          deferralRetryNonce
        },
        timestamp: Date.now()
      });
      void processNextInQueue();
    }
    // NOTE: one dispatch per wake-up (no chaining dep on the processing
    // state): a dispatch starts a turn whose summary/busy churn produces the
    // next isSessionBusy identity change, which re-fires this effect — the
    // same wake-up model the plan's later stages (deferredTargets) rely on.
    // deferralRetryNonce is the single-shot fallback timer's wake-up channel.
  }, [currentSessionId, deferralRetryNonce, emitLog, isBusy, messageQueue, processNextInQueue, targetBusy]);

  const handleUserMessage = useCallback(
    async (
      text: string,
      source: 'text' | 'voice' = 'text',
      attachments?: AnyAttachmentPayload[],
      options?: {
        editTargetMessageId?: string;
        existingMessageId?: string;
        targetSessionId?: string;
        queueMode?: QueueMode;
        /** Override the model for this turn only (e.g., Haiku for simple directive tasks) */
        modelOverride?: string;
        /** Override thinking model for this turn only ('' suppresses plan mode) */
        thinkingModelOverride?: string;
        /** Mark the session as done after this turn completes successfully */
        doneAfterComplete?: boolean;
        /** Enable unleashed mode for fire-and-forget inbox tasks */
        unleashedMode?: boolean;
        /** Session type: 'manual' for interactive UI, 'automation' for background tasks */
        sessionType?: 'manual' | 'automation';
        /** Bypass tool safety evaluation (for automation sessions) */
        bypassToolSafety?: boolean;
        /** Mark as system continuation (e.g., approval retry) — skips coaching scheduler */
        isSystemContinuation?: boolean;
        /**
         * 260622 Stage 4: bypass the Chief-of-Staff admission gate for this one
         * turn (the "Run without my instructions" recovery escape).
         */
        proceedWithoutChiefOfStaff?: boolean;
        /** Hide the user message from conversation UI (still sent to LLM) */
        isHidden?: boolean;
        /** Optional display-friendly message text persisted on the user message */
        displayText?: string;
        /** Message origin for scroll/analytics behavior */
        messageOrigin?: import('@shared/types').AgentTurnMessage['messageOrigin'];
        /**
         * F3 anti-double-injection marker. When the user-question response
         * handler already injected `<prior_turns>` + `<conversation_history>`
         * into the continuation prompt, this signals the next `agent:turn` to
         * skip the proactive prepend in `agentTurnExecute`.
         */
        continuationContext?: import('@shared/types').AgentTurnRequest['continuationContext'];
        /**
         * Callback fired after this specific message's dispatch resolves successfully.
         * Never fires on rejection, removal, session delete, or app-restart. Supports
         * sync and async callbacks; throws/rejections are caught, logged at `error`,
         * and never propagate. See the `QueuedMessage.onCommit` docstring and
         * `ARCHITECTURE_MESSAGE_QUEUE.md` for the full contract. Callers should use
         * this for clean-up hooks tied to the "message actually went out" commit
         * point (e.g. clearing staged document annotations on real dispatch rather
         * than on the Send button click).
         */
        onCommit?: () => void | Promise<void>;
      }
    ) => {
      const trimmedText = text.trim();
      if (!trimmedText) return;
      onUserSubmit?.();

      // CRITICAL FIX: Default targetSessionId to currentSessionId at ENQUEUE time, not dequeue time.
      // This ensures messages queued without explicit target go to the session that was active
      // when they were queued, not whichever session is active when the queue drains.
      // This fixes the bug where queued text messages would go to the wrong session if user
      // switched sessions while the queue was waiting.
      const effectiveTargetSessionId = options?.targetSessionId ?? currentSessionId;

      // Queue mode: 'sendNow' jumps to front and interrupts, 'queue' waits in line
      // INVARIANT: Edit/retry operations always use sendNow semantics regardless of callsite request.
      // When editing a previous message, the user is explicitly rewriting history - queueing makes no
      // sense because rerunEditedMessage() truncates the conversation. Letting the current run finish
      // would produce output against history the user is invalidating.
      const queueMode: QueueMode = options?.editTargetMessageId
        ? 'sendNow'
        : (options?.queueMode ?? 'queue'); // Default to FIFO queue — safe for all callers

      // Explicit interrupt (composer sendNow / forced edit-rerun) must never
      // be blocked by stale refusal-deferral state (GPT F1 / RS F5): the user
      // is asking to supersede, which is exactly the zombie-turn escape hatch.
      // Clearing also lets queued messages behind it retry after the interrupt.
      if (isInterruptQueueMode(queueMode)) {
        clearDeferralForTarget(effectiveTargetSessionId);
      }

      const queuedMessage: QueuedMessage = {
        id: createId(),
        text: trimmedText,
        timestamp: Date.now(),
        source,
        attachments: attachments && attachments.length > 0 ? attachments : undefined,
        editTargetMessageId: options?.editTargetMessageId,
        existingMessageId: options?.existingMessageId,
        targetSessionId: effectiveTargetSessionId,
        modelOverride: options?.modelOverride,
        thinkingModelOverride: options?.thinkingModelOverride,
        doneAfterComplete: options?.doneAfterComplete,
        unleashedMode: options?.unleashedMode,
        sessionType: options?.sessionType,
        bypassToolSafety: options?.bypassToolSafety,
        isSystemContinuation: options?.isSystemContinuation,
        proceedWithoutChiefOfStaff: options?.proceedWithoutChiefOfStaff,
        isHidden: options?.isHidden,
        displayText: options?.displayText,
        queueMode,
        messageOrigin: options?.messageOrigin ?? 'user-typed',
        continuationContext: options?.continuationContext,
        onCommit: options?.onCommit,
      };

      const enqueueMessage = (atFront: boolean = false) => {
        setMessageQueue((prev) =>
          atFront ? [queuedMessage, ...prev] : [...prev, queuedMessage]
        );
        return messageQueue.length + 1;
      };

      // Determine if we should interrupt the current run.
      // If targeting a different session, don't interrupt - just queue and wait.
      // This prevents voice transcripts from session A from interrupting session B's run.
      const targetsDifferentSession = effectiveTargetSessionId !== currentSessionId;

      // Skip interrupt logic if we're processing a message that was already added to the store
      // (existingMessageId means the caller used optimistic UI in a fresh session - nothing to interrupt)
      // targetBusy(effectiveTargetSessionId): a cross-session send to a BUSY
      // target must enqueue even when the viewed session is idle — dispatching
      // would supersede (cancel) the target's active turn at admission.
      // Same-session behavior is unchanged (targetBusy(current) === isBusy).
      // queueMode is passed so an explicit sendNow ignores refusal-deferral
      // state (it was cleared above; the mode-aware check is belt-and-braces).
      if ((isBusy || isStopping || targetBusy(effectiveTargetSessionId, queueMode)) && !options?.existingMessageId) {
        // 'sendNow' inserts at front (priority), 'queue' appends to back (FIFO)
        // Cross-session messages always use FIFO to avoid "priority leak" across sessions
        const insertAtFront = queueMode === 'sendNow' && !targetsDifferentSession;
        const newQueueLength = enqueueMessage(insertAtFront);

        emitLog({
          level: 'info',
          message: 'Message queued while run active',
          context: {
            queueLength: newQueueLength,
            isStopping,
            source,
            queueMode,
            insertAtFront,
            targetSessionId: options?.targetSessionId,
            targetsDifferentSession
          },
          timestamp: Date.now()
        });

        // Only set pendingInputSource when in sendNow mode (stop in progress).
        // In queue mode, users can queue multiple messages without the UI blocking.
        if (queueMode === 'sendNow' && !targetsDifferentSession) {
          setPendingInputSource(source);
        }

        // If targeting a different session, don't interrupt - just wait for current run to finish
        if (targetsDifferentSession) {
          return;
        }

        // Queue mode: just queue and wait, don't interrupt
        if (queueMode === 'queue') {
          return;
        }

        if (isStopping) {
          return;
        }

        // sendNow mode: interrupt and send next (no toast - UI shows queued messages tray)

        try {
          await stopActiveTurn();
        } catch (error) {
          emitLog({
            level: 'error',
            message: 'Failed to stop run for queued message',
            context: { error: error instanceof Error ? error.message : String(error) },
            timestamp: Date.now()
          });
          showToast({ title: '⚠️ Failed to stop run - message will send when ready' });
        }
        return;
      }

      // Captured so the refusal catch can tell whether the target's queue was
      // purged WHILE this dispatch was in flight (runtime-safety F6).
      const dispatchStartedAt = Date.now();

      try {
        if (queuedMessage.editTargetMessageId) {
          await rerunEditedMessage(
            queuedMessage.editTargetMessageId,
            queuedMessage.text,
            queuedMessage.source,
            queuedMessage.attachments
          );
        } else {
          // Use effectiveTargetSessionId for consistency with queued path
          const messageOptions: { isSystemContinuation?: boolean; proceedWithoutChiefOfStaff?: boolean; modelOverride?: string; thinkingModelOverride?: string; doneAfterComplete?: boolean; unleashedMode?: boolean; sessionType?: 'manual' | 'automation'; bypassToolSafety?: boolean; isHidden?: boolean; displayText?: string; messageOrigin?: import('@shared/types').AgentTurnMessage['messageOrigin']; continuationContext?: import('@shared/types').AgentTurnRequest['continuationContext']; supersedePolicy?: import('@shared/types').AgentTurnRequest['supersedePolicy'] } = {};
          if (queuedMessage.modelOverride) messageOptions.modelOverride = queuedMessage.modelOverride;
          if (queuedMessage.thinkingModelOverride !== undefined) messageOptions.thinkingModelOverride = queuedMessage.thinkingModelOverride;
          if (queuedMessage.doneAfterComplete) messageOptions.doneAfterComplete = queuedMessage.doneAfterComplete;
          if (queuedMessage.unleashedMode) messageOptions.unleashedMode = queuedMessage.unleashedMode;
          if (queuedMessage.sessionType) messageOptions.sessionType = queuedMessage.sessionType;
          if (queuedMessage.bypassToolSafety) messageOptions.bypassToolSafety = queuedMessage.bypassToolSafety;
          if (queuedMessage.isSystemContinuation) messageOptions.isSystemContinuation = queuedMessage.isSystemContinuation;
          if (queuedMessage.proceedWithoutChiefOfStaff) messageOptions.proceedWithoutChiefOfStaff = queuedMessage.proceedWithoutChiefOfStaff;
          if (queuedMessage.isHidden) messageOptions.isHidden = queuedMessage.isHidden;
          if (queuedMessage.displayText !== undefined) messageOptions.displayText = queuedMessage.displayText;
          if (queuedMessage.messageOrigin) messageOptions.messageOrigin = queuedMessage.messageOrigin;
          if (queuedMessage.continuationContext) messageOptions.continuationContext = queuedMessage.continuationContext;
          // Admission policy from queue intent — single shared derivation
          // with the drain site (see supersedePolicyForQueueMode docstring).
          // The immediate path only dispatches when everything LOOKS idle, so
          // 'reject' here is pure race insurance — without it a queue-mode
          // send passing a stale-false busy gate would still cancel the
          // target's active turn at admission. sendNow (and forced-sendNow
          // edit/rerun, which takes the branch above) keeps the legacy
          // supersede backstop by carrying no policy.
          const supersedePolicy = supersedePolicyForQueueMode(queueMode);
          if (supersedePolicy !== undefined) {
            messageOptions.supersedePolicy = supersedePolicy;
          }
          await processMessage(
            trimmedText,
            source,
            attachments,
            queuedMessage.existingMessageId,
            effectiveTargetSessionId,
            Object.keys(messageOptions).length > 0 ? messageOptions : undefined
          );
        }
        // Dispatch resolved successfully — fire the per-message onCommit hook (if any).
        // Failures inside the callback are isolated (logged, never re-thrown) so a
        // misbehaving clean-up hook can't break the caller's send path. Never reached
        // on reject/throw because we're past the `await`.
        invokeOnCommitSafely(queuedMessage, emitLog);
      } catch (error) {
        if (isTargetBusyRejection(error)) {
          // Typed admission refusal on the immediate path (TOCTOU race: the
          // target's turn started between the renderer busy check and
          // admission). Mirror the drain path's no-loss contract: enqueue the
          // already-constructed QueuedMessage at the BACK (it was never in the
          // queue — normal FIFO append), defer the target, no toast, no
          // onCommit. Same-session refusals carry the persisted message id so
          // the eventual drain dedups (FMM 9).
          if (wasTargetPurgedMidFlight(effectiveTargetSessionId, dispatchStartedAt)) {
            // The target's queue was purged (session delete / per-session
            // clear / global clear-all) while this dispatch was in flight —
            // enqueueing now would resurrect a message for a purged session
            // (runtime-safety F6). Drop it.
            emitLog({
              level: 'info',
              message: 'Immediate send refused at admission but target session was cleared mid-flight — dropping (no requeue)',
              context: {
                queuedMessageId: queuedMessage.id,
                targetSessionId: effectiveTargetSessionId,
              },
              timestamp: Date.now()
            });
          } else {
            const requeueMessageId = getRequeueMessageId(error);
            const requeuedMessage: QueuedMessage = {
              ...queuedMessage,
              existingMessageId: requeueMessageId ?? queuedMessage.existingMessageId,
            };
            deferTarget(effectiveTargetSessionId);
            setMessageQueue((prev) => [...prev, requeuedMessage]);
            emitLog({
              level: 'info',
              message: 'Immediate send refused at admission (target busy) — message queued',
              context: {
                queuedMessageId: queuedMessage.id,
                targetSessionId: effectiveTargetSessionId,
                existingMessageId: requeuedMessage.existingMessageId,
              },
              timestamp: Date.now()
            });
          }
        } else {
          // Non-refusal errors keep the existing contract: propagate to the
          // caller (initiateAgentTurn already handled user-facing reporting).
          throw error;
        }
      } finally {
        setPendingInputSource(null);
      }
    },
    [
      clearDeferralForTarget,
      currentSessionId,
      deferTarget,
      emitLog,
      isBusy,
      isStopping,
      messageQueue.length,
      processMessage,
      rerunEditedMessage,
      setPendingInputSource,
      showToast,
      stopActiveTurn,
      targetBusy,
      wasTargetPurgedMidFlight,
      onUserSubmit,
    ]
  );

  const clearQueue = useCallback(() => {
    // Global tombstone (clear-ALL sibling of clearQueueForSession's
    // per-session one, runtime-safety F6): a dispatch in flight right now is
    // not in the queue, so setMessageQueue([]) can't remove it — if it is then
    // refused at admission, the refusal catch must drop it instead of
    // resurrecting a message the user just cleared.
    clearedAllAtRef.current = Date.now();
    setMessageQueue([]);
    setPendingInputSource(null);
  }, []);

  /**
   * Clear only messages targeting a specific session.
   * Useful when deleting a session or clearing the current session's queue
   * without affecting messages queued for other sessions.
   */
  const clearQueueForSession = useCallback(
    (sessionId: string) => {
      // Tombstone: a dispatch for this session that is currently in flight is
      // NOT in the queue, so the filter below can't remove it — if it is then
      // refused at admission, the refusal catch must drop it instead of
      // resurrecting it (runtime-safety F6). The timestamp lets the catch
      // ignore purges that predate its own dispatch.
      clearedTargetsRef.current.set(sessionId, Date.now());
      setMessageQueue((prev) => prev.filter((m) => m.targetSessionId !== sessionId));
      // Reset pendingInputSource if we cleared the current session's queue
      // (This prevents UI staying in "pending" state with empty tray)
      if (sessionId === currentSessionId) {
        setPendingInputSource(null);
      }
    },
    [currentSessionId]
  );

  const removeFromQueue = useCallback(
    (id: string) => {
      // Check current queue state from closure (not inside updater to keep it pure)
      const currentIndex = messageQueue.findIndex((m) => m.id === id);

      if (currentIndex === -1) {
        emitLog({
          level: 'warn',
          message: 'Attempted to remove non-existent message from queue',
          context: { id },
          timestamp: Date.now()
        });
        return;
      }

      // Race condition safeguard: if we're currently processing and the message
      // being removed is the first one, it may already be processing
      if (isProcessingRef.current && currentIndex === 0) {
        emitLog({
          level: 'warn',
          message: 'Removing message that may already be processing',
          context: { id, isProcessing: isProcessingRef.current },
          timestamp: Date.now()
        });
      }

      emitLog({
        level: 'info',
        message: 'Removed message from queue',
        context: { id, remainingCount: messageQueue.length - 1 },
        timestamp: Date.now()
      });

      // Keep the updater pure - just filter
      setMessageQueue((prev) => prev.filter((m) => m.id !== id));
    },
    [emitLog, messageQueue]
  );

  /**
   * Promote a queued message to the front of the queue and trigger interrupt.
   * Preserves the original message metadata (attachments, editTargetMessageId, etc.)
   * to avoid creating a new ID or losing data.
   */
  const sendQueuedMessageNow = useCallback(
    async (id: string) => {
      // Find message and validate - derive from current messageQueue for validation
      const message = messageQueue.find((m) => m.id === id);
      if (!message) {
        emitLog({
          level: 'warn',
          message: 'Attempted to send-now non-existent queued message',
          context: { id },
          timestamp: Date.now()
        });
        return;
      }

      // Don't allow send-now for messages targeting a different session
      // (we can't interrupt a different session's turn)
      const targetsDifferentSession =
        message.targetSessionId && message.targetSessionId !== currentSessionId;
      if (targetsDifferentSession) {
        emitLog({
          level: 'warn',
          message: 'Cannot send-now message targeting different session',
          context: { id, targetSessionId: message.targetSessionId, currentSessionId },
          timestamp: Date.now()
        });
        showToast({ title: 'Cannot send now - message is for a different conversation' });
        return;
      }

      // Capture source before state update (used for pending state)
      const messageSource = message.source;

      // Explicit interrupt: stale refusal-deferral state must never block the
      // promoted message (GPT F1 / RS F5). Without this, a prior typed refusal
      // could hold the user's send-now hostage until the next summary churn —
      // exactly the zombie-busy state send-now exists to escape. The promoted
      // entry also bypasses deferral by mode in targetBusy(); clearing here
      // additionally frees same-target queued messages once the interrupt's
      // supersede clears the zombie.
      clearDeferralForTarget(message.targetSessionId ?? currentSessionId);

      emitLog({
        level: 'info',
        message: 'Promoting queued message to front (send now)',
        context: { id, queueLength: messageQueue.length },
        timestamp: Date.now()
      });

      // Move message to front of queue - derive from `prev` to avoid stale closure issues.
      // If the message was removed between click and state update, we do nothing.
      setMessageQueue((prev) => {
        const idx = prev.findIndex((m) => m.id === id);
        if (idx === -1) {
          // Message no longer exists - don't resurrect it
          return prev;
        }
        const promotedMessage: QueuedMessage = {
          ...prev[idx],
          queueMode: 'sendNow-via-tray',
        };
        const rest = prev.filter((m) => m.id !== id);
        return [promotedMessage, ...rest];
      });

      // Set pending state and trigger interrupt
      setPendingInputSource(messageSource);

      if (isBusy && !isStopping) {
        emitLog({
          level: 'info',
          message: 'Send-now-via-tray will supersede active turn',
          context: {
            queuedMessageId: id,
            activeTurnId: activeTurnId ?? null,
            isBusy,
            queueLength: messageQueue.length,
          },
          timestamp: Date.now()
        });
        try {
          await stopActiveTurn();
        } catch (error) {
          emitLog({
            level: 'error',
            message: 'Failed to stop run for send-now queued message',
            context: { error: error instanceof Error ? error.message : String(error) },
            timestamp: Date.now()
          });
          showToast({ title: '⚠️ Failed to stop run - message will send when ready' });
        }
      }
      // If not busy, the useEffect will process it automatically
    },
    [activeTurnId, clearDeferralForTarget, currentSessionId, emitLog, isBusy, isStopping, messageQueue, setPendingInputSource, showToast, stopActiveTurn]
  );

  return {
    handleUserMessage,
    pendingInputSource,
    setPendingInputSource,
    messageQueue,
    clearQueue,
    clearQueueForSession,
    removeFromQueue,
    sendQueuedMessageNow
  } as const;
};
