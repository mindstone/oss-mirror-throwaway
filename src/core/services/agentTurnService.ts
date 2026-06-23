/**
 * Agent Turn Service
 *
 * Shared orchestration logic for starting and stopping agent turns.
 * Called by both the IPC handler (local desktop) and the cloud HTTP/WS handler.
 *
 * This is a pure extraction from the `agent:turn` IPC handler — all behavior
 * is identical. The IPC handler becomes a thin wrapper that calls startAgentTurn().
 */

import { randomUUID } from 'node:crypto';
import type { EventWindow } from '@core/types';
import { logger } from '@core/logger';
import type { AgentEvent, AgentTurnRequest, AgentSession } from '@shared/types';
import { dispatchAgentErrorEvent } from './agentEventDispatcher';
import { agentTurnRegistry } from './agentTurnRegistry';
import { startupScheduler } from './startupScheduler';
import { clearTurnQuipCache } from './quipGeneratorService';
import { localTurnLimiter } from './turnConcurrencyLimiter';
import type { SessionType } from './promptTemplateService';
import type { AgentLoopOptions } from './recovery/recoveryAdapter';
import { derivePolicy } from './turnPolicy';
import type { TurnPolicy } from '@core/types/turnPolicy';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { createTargetBusyRejectionError } from '@shared/utils/agentTurnAdmission';

type InternalAgentTurnRequest = AgentTurnRequest & {
  watchdogCeilingMs?: number;
};

/**
 * Dependencies injected by the caller (IPC handler, cloud socket shim, etc.).
 * This avoids direct imports from `electron` for non-window-dependent logic.
 */
export interface AgentTurnServiceDeps {
  executeAgentTurn: (
    win: EventWindow | null,
    turnId: string,
    prompt: string,
    options: {
      resetConversation?: boolean;
      sessionId: string;
      attachments?: AgentTurnRequest['attachments'];
      privateMode?: boolean;
      modelOverride?: string;
      thinkingModelOverride?: string;
      workingProfileOverrideId?: string;
      thinkingProfileOverrideId?: string;
      thinkingEffortOverride?: import('@shared/types').ThinkingEffort;
      loadSessions?: () => AgentSession[];
      unleashedMode?: boolean;
      finishLine?: string;
      councilMode?: boolean;
      activeSpacePath?: string | null;
      existingAbortController?: AbortController;
      sessionType?: SessionType;
      policy?: TurnPolicy;
      bypassToolSafety?: boolean;
      getMeetingCompanionContext?: (sessionId: string) => Promise<{
        currentCoachPath: string | null;
        lastInjectedCoachPath: string | null | undefined;
        coachSkillContent?: string;
      } | null>;
      setLastInjectedCoachPath?: (sessionId: string, coachPath: string | null) => void;
      getFocusContext?: (sessionId: string, origin?: string) => Promise<string | null>;
      origin?: string;
    }
  ) => Promise<void>;
  /** Surface-injected recovery executor. Desktop wires desktopRecoveryAdapter;
   * cloud Stage 4b wires cloudRecoveryAdapter. Undefined preserves direct
   * executeAgentTurn behavior for tests and harnesses. */
  executeAgentTurnWithRecovery?: (
    win: EventWindow | null,
    turnId: string,
    prompt: string,
    options: AgentLoopOptions,
  ) => Promise<void>;
  dispatchAgentEvent: (
    win: EventWindow | null,
    turnId: string,
    event: Exclude<AgentEvent, { type: 'error' | 'answer_phase_started' }>
  ) => void;
  deleteRendererSessionByTurn: (turnId: string) => void;
  cancelExistingTurnForSession: (sessionId: string) => string | undefined;
  /**
   * Surface-owned probe for the session's active turn (same source of truth
   * as `cancelExistingTurnForSession` on each surface — the registry's
   * session→turn mapping). Required whenever a request can carry
   * `supersedePolicy: 'reject'`: the admission guard fails loud if a
   * reject-policy request arrives and this probe is unwired, rather than
   * silently falling through to the supersede path it exists to prevent.
   * See docs/plans/260610_queue-drain-cancels-turn/PLAN.md Stage 2.
   */
  getActiveTurnForSession?: (sessionId: string) => string | undefined;
  /**
   * Optional surface-owned active-turn probe used to prevent canonical id
   * collisions when adopting clientTurnId at admission.
   */
  isActiveTurnId?: (id: string) => boolean;
  loadAgentSessions?: () => AgentSession[];
  /**
   * Surface-owned PreToolUse hook for headless/bootstrap callers that need to
   * block a tool family before the normal tool-safety chain runs (for example,
   * eval bash blocking or memory-update MCP denial). Forwarded to
   * AgentLoopOptions.mcpDenyHook; opaque to core.
   */
  mcpDenyHook?: AgentLoopOptions['mcpDenyHook'];
  /**
   * Surface-owned memory-write PreToolUse hook. Background memory turns and
   * headless surfaces use this to preserve the production memory-write safety
   * chain when execution is routed through the shared bootstrap.
   */
  memoryWriteHook?: AgentLoopOptions['memoryWriteHook'];
  getMeetingCompanionContext?: (sessionId: string) => Promise<{
    currentCoachPath: string | null;
    lastInjectedCoachPath: string | null | undefined;
    coachSkillContent?: string;
  } | null>;
  setLastInjectedCoachPath?: (sessionId: string, coachPath: string | null) => void;
  /** Get Focus context for first-turn injection (calendar + goals). Returns null for non-focus or non-first-turn sessions. */
  getFocusContext?: (sessionId: string, origin?: string) => Promise<string | null>;
  /** Optional callback to mark a session as active (e.g., coaching scheduler on desktop). */
  onSessionActive?: (sessionId: string) => void;
}

export interface StartAgentTurnResult {
  turnId: string;
}

function resolveCanonicalTurnId(
  clientTurnId: string | undefined,
  isActiveTurnId?: (id: string) => boolean,
): string {
  if (typeof clientTurnId !== 'string') {
    return randomUUID();
  }
  const trimmedClientTurnId = clientTurnId.trim();
  if (trimmedClientTurnId.length > 0) {
    // Deterministic guard: never reuse an id that is already live.
    if (isActiveTurnId?.(trimmedClientTurnId)) {
      return randomUUID();
    }
    return trimmedClientTurnId;
  }
  return randomUUID();
}

/**
 * Start an agent turn — shared orchestration logic.
 *
 * Performs all pre-execution setup:
 * 1. Validates sessionId; refuses admission (typed AGENT_TURN_TARGET_BUSY
 *    error) when `supersedePolicy === 'reject'` and the session has an
 *    active turn — queue-mode sends never abort an active turn
 * 2. Cancels existing turn for same session (dedup; default/supersede policy)
 * 3. Dispatches turn_superseded event if a turn was cancelled
 * 4. Records user activity (pauses automation catch-ups)
 * 5. Marks session active (coaching scheduler)
 * 6. Logs the request
 * 7. Stores input source (voice/text badge tracking)
 * 8. Creates & registers AbortController + eagerly records the session→turn
 *    mapping (closes the admission-window race for both probe and cancel)
 * 9. Queues executeAgentTurn() via queueMicrotask
 *
 * @param deps - Injected dependencies (no direct Electron imports needed)
 * @param request - The agent turn request from the renderer or cloud bridge
 * @param win - The EventWindow for event dispatch (null for cloud turns)
 */
export function startAgentTurn(
  deps: AgentTurnServiceDeps,
  request: AgentTurnRequest,
  win: EventWindow | null,
): StartAgentTurnResult {
  const {
    executeAgentTurn,
    dispatchAgentEvent,
    deleteRendererSessionByTurn,
    cancelExistingTurnForSession,
    getActiveTurnForSession,
    isActiveTurnId,
    loadAgentSessions,
    mcpDenyHook,
    memoryWriteHook,
    getMeetingCompanionContext,
    setLastInjectedCoachPath,
    getFocusContext,
    onSessionActive,
  } = deps;

  const turnId = resolveCanonicalTurnId(request.clientTurnId, isActiveTurnId);
  const {
    prompt,
    resetConversation,
    sessionId,
    attachments,
    privateMode,
    isSystemContinuation,
    proceedWithoutChiefOfStaff,
    modelOverride,
    thinkingModelOverride,
    workingProfileOverrideId,
    thinkingProfileOverrideId,
    thinkingEffortOverride,
    unleashedMode,
    finishLine,
    councilMode,
    activeSpacePath,
    inputSource,
    sessionType,
    bypassToolSafety,
    origin,
    continuationContext,
    systemPromptPrefix,
    watchdogCeilingMs,
  } = request as InternalAgentTurnRequest;

  // 1. Validate sessionId
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new Error('Renderer session ID is required for agent turns.');
  }

  const rendererSessionId = sessionId.trim();

  // 1b. Admission policy guard: a non-interrupt (queue-mode) send must never
  // abort an active turn. When the request carries `supersedePolicy: 'reject'`
  // and the target session has an active turn, refuse admission with the
  // typed AGENT_TURN_TARGET_BUSY error — no cancel, no turn_superseded, no
  // controller registration, no execution. The renderer detects the refusal
  // and re-queues the message (Stage 3 of the planning doc).
  //
  // Open union over IPC (FMM 13): anything other than the literal 'reject'
  // (absent, 'supersede', or a future/unknown value from a version-skewed
  // client) falls through to the legacy supersede path below — deliberately
  // no exhaustiveness assertion here.
  if (request.supersedePolicy === 'reject') {
    if (!getActiveTurnForSession) {
      // Fail loud rather than silently superseding: a missing probe on a
      // reject-policy request would reintroduce the exact cancellation this
      // policy exists to prevent (mirrors the codexAuth/btsProxy
      // fail-loud-on-unwired pattern).
      throw new Error(
        "startAgentTurn: supersedePolicy 'reject' requires the getActiveTurnForSession dep; "
        + 'wire it (agentTurnRegistry.getActiveTurnForSession) where AgentTurnServiceDeps is constructed.',
      );
    }
    const activeTurnId = getActiveTurnForSession(rendererSessionId);
    if (activeTurnId) {
      logger.info(
        {
          turnId,
          sessionId: rendererSessionId,
          activeTurnId,
          reason: 'queue-message-target-busy',
        },
        'Refused agent turn admission: target session has an active turn and request policy is reject',
      );
      throw createTargetBusyRejectionError(rendererSessionId, activeTurnId);
    }
  }

  // 2. Cancel any existing turn for this session (server-side dedup)
  const cancelledTurnId = cancelExistingTurnForSession(rendererSessionId);
  if (cancelledTurnId) {
    logger.warn(
      { cancelledTurnId, newTurnSessionId: rendererSessionId },
      'Cancelled existing turn for session before starting new turn'
    );
    // 3. Notify renderer that the old turn was superseded (not an error)
    dispatchAgentEvent(win, cancelledTurnId, {
      type: 'turn_superseded',
      newTurnId: turnId,
      timestamp: Date.now(),
    });
  }

  // 4. Record user activity to pause automation catch-ups during active conversations
  startupScheduler.recordUserActivity();

  // 5. Mark session as active — clears any pending coaching (user is resuming conversation)
  // Skip for system continuations (memory approval, tool approval retries) to preserve coaching
  if (!isSystemContinuation) {
    onSessionActive?.(rendererSessionId);
  }

  // 6. Log the request
  logger.info(
    {
      channel: 'ipc',
      turnId,
      promptLength: prompt?.length ?? 0,
      resetConversation: Boolean(resetConversation),
      rendererSessionId,
      attachments: attachments?.length ?? 0,
      unleashedMode: unleashedMode ?? false,
      inputSource: inputSource ?? 'text',
    },
    'Agent turn request received'
  );

  // 7. Store input source for badge tracking (voice vs text)
  if (inputSource) {
    agentTurnRegistry.setTurnInputSource(turnId, inputSource);
  }

  // 8. Create and register AbortController BEFORE returning turnId.
  // This eliminates a race condition where the caller could try to stop a turn
  // before executeAgentTurn has created the controller.
  const abortController = new AbortController();
  agentTurnRegistry.setActiveTurnController(turnId, abortController);

  // 8b. Eagerly record the session→turn mapping at admission time. The
  // pipeline previously recorded it only inside `turnAdmission` — behind a
  // queued microtask and the concurrency limiter — leaving a window where
  // both the 'reject' probe and the supersede cancel saw the session as idle
  // and admitted two concurrent turns (FMM 15, the 260115 bug shape).
  // `setRendererSession` is idempotent for the pipeline's later re-apply
  // (same turnId+sessionId → listeners do not re-fire), and every existing
  // cleanup path (error catch below, cleanupTurn, cleanupForRetry,
  // releaseActiveSession) already clears this mapping.
  agentTurnRegistry.setRendererSession(turnId, rendererSessionId);

  // 9. Queue execution via queueMicrotask with concurrency limiting.
  // When multiple turns fire simultaneously (e.g., "Allow all" approving tools
  // across 4 sessions), the limiter queues excess turns instead of running them
  // all at once, preventing resource exhaustion on both local and cloud.
  // Map renderer sessionType to executor sessionType
  // 'manual' -> 'interactive' (user is actively watching/interacting)
  // 'automation' -> 'automation' (background task, skip heavy pre-turn logic)
  const executorSessionType: SessionType | undefined =
    sessionType === 'manual' ? 'interactive' : sessionType as SessionType | undefined;

  const effectivePolicy = derivePolicy(executorSessionType);
  const lane = effectivePolicy.lane;

  const microtaskWork = async (): Promise<void> => {
    const release = await localTurnLimiter.acquire(rendererSessionId, lane);
    try {
      const agentLoopOptions: AgentLoopOptions = {
        resetConversation,
        sessionId: rendererSessionId,
        attachments: attachments && attachments.length > 0 ? attachments : undefined,
        privateMode,
        modelOverride,
        thinkingModelOverride,
        workingProfileOverrideId,
        thinkingProfileOverrideId,
        thinkingEffortOverride,
        loadSessions: loadAgentSessions,
        mcpDenyHook,
        memoryWriteHook,
        getMeetingCompanionContext,
        setLastInjectedCoachPath,
        getFocusContext,
        unleashedMode,
        finishLine,
        watchdogCeilingMs,
        councilMode,
        activeSpacePath,
        existingAbortController: abortController,
        sessionType: executorSessionType,
        policy: effectivePolicy,
        bypassToolSafety,
        origin,
        inputSource,
        continuationContext,
        // Thread the system-continuation flag through to admission so the
        // Chief-of-Staff gate never blocks a turn the user didn't initiate
        // (approval/tool retry). See turnAdmission.admit (260622 Stage 3).
        ...(isSystemContinuation ? { isSystemContinuation: true } : {}),
        // 260622 Stage 4: the "Run without my instructions" recovery escape sets
        // this per-turn so the Chief-of-Staff admission gate admits on the
        // template (logged, never silent). See turnAdmission.admit.
        ...(proceedWithoutChiefOfStaff ? { proceedWithoutChiefOfStaff: true } : {}),
        ...(systemPromptPrefix ? { systemPromptPrefix } : {}),
      };
      if (deps.executeAgentTurnWithRecovery) {
        await deps.executeAgentTurnWithRecovery(win, turnId, prompt, agentLoopOptions);
      } else {
        await executeAgentTurn(win, turnId, prompt, {
          ...agentLoopOptions,
          sessionType: executorSessionType,
        });
      }
      clearTurnQuipCache(turnId);
    } catch (error) {
      logger.error({ err: error, turnId }, 'Agent turn execution error');
      // Derive a user-facing copy from whichever shape the thrown value takes.
      // - `new Error('msg')`       -> `'msg'`
      // - `new Error()`            -> `''` -> falls back (empty banner guard)
      // - `throw 'raw string'`     -> `'raw string'` (preserves the signal)
      // - `throw { … }` / null / undefined -> `''` -> falls back
      // `||` (rather than `??`) so empty strings route to the fallback copy
      // instead of emitting a blank error banner.
      const extracted =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : '';
      dispatchAgentErrorEvent(win, turnId, error, {
        humanizedOverride: extracted || 'Agent turn aborted.',
      });
      deleteRendererSessionByTurn(turnId);
      clearTurnQuipCache(turnId);
    } finally {
      release();
    }
  };
  queueMicrotask(() => fireAndForget(microtaskWork(), 'agentTurnService.microtaskWork'));

  return { turnId };
}

// ---------------------------------------------------------------------------
// Stop Agent Turn — shared abort + force-kill escalation
// ---------------------------------------------------------------------------

const FORCE_KILL_DELAY_MS = 10_000;

export type StopAgentTurnResult =
  | { status: 'not_found' }
  | { status: 'stopped' }
  | { status: 'force_killed' };

/**
 * Stop an agent turn — shared abort + force-kill escalation logic.
 *
 * 1. If the turn doesn't exist, returns `not_found`.
 * 2. If the turn is already aborted (re-stop), escalates to force-kill
 *    via Query.close() immediately and returns `force_killed`.
 * 3. Otherwise, aborts the controller and schedules a 10s force-kill
 *    timer as a safety net, then returns `stopped`.
 *
 * The timer is single-shot and safe: if the turn completes before 10s,
 * getActiveTurnController returns undefined (cleaned up by completeTurnCleanup)
 * and the callback no-ops. Query.close() is idempotent so multiple calls
 * (timer + re-stop) are safe.
 *
 * Callers (IPC handler, cloud HTTP handler) map the result to their own
 * response format (IPC result object, HTTP status code, etc.).
 */
export function stopAgentTurn(turnId: string): StopAgentTurnResult {
  const controller = agentTurnRegistry.getActiveTurnController(turnId);
  if (!controller) {
    return { status: 'not_found' };
  }

  if (controller.signal.aborted) {
    logger.warn({ turnId }, 'Re-stop requested on already-aborted turn — force-killing via Query.close()');
    const closeCallback = agentTurnRegistry.getTurnCloseCallback(turnId);
    if (closeCallback) {
      try { closeCallback(); } catch { /* ignore close errors */ }
    }
    return { status: 'force_killed' };
  }

  logger.info({ turnId }, 'Stopping agent turn');
  controller.abort();

  // Force-kill escalation: if turn is still active after 10s, call Query.close()
  // which sends SIGTERM then SIGKILL after 5s (agent runtime internal escalation).
  setTimeout(() => {
    const stillActive = agentTurnRegistry.getActiveTurnController(turnId);
    if (stillActive) {
      logger.warn({ turnId }, 'Graceful abort timed out — escalating to force-kill via Query.close()');
      const closeCallback = agentTurnRegistry.getTurnCloseCallback(turnId);
      if (closeCallback) {
        try { closeCallback(); } catch { /* ignore close errors */ }
      }
    }
  }, FORCE_KILL_DELAY_MS);

  return { status: 'stopped' };
}
