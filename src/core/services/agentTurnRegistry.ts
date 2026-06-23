/**
 * Agent Turn Registry
 *
 * Centralized state management for agent turn lifecycle.
 * Manages turn loggers, session mappings, controllers, event listeners,
 * prompts, context accumulators, and overflow tracking.
 */

import { createScopedLogger } from '@core/logger';
import type { TurnSessionLogger } from '@core/logger';
import type { AgentEvent, ThinkingEffort, TurnFallback } from '@shared/types';
import type { ProviderCredentialSource } from '@shared/types/providerRoute';
import type { ConversationStateShape } from '@shared/utils/conversationState';
import type { CostCategoryKey } from '@shared/costCategories';
import type { ApprovalHandler } from '@core/types/headlessTurnOptions';
import { LazyContextAccumulator } from './lazyContextAccumulator';

const turnIdleEmitterLogger = createScopedLogger({ service: 'agentTurnRegistry' });
/** Cost category used for tracking turn costs. Derived from registry with string escape hatch for forward compat. */
type CostCategory = CostCategoryKey | (string & {});
import { cleanupAutoContinueCache } from './autoContinueCache';
import type { ObservedToolCall } from './safety/types';

/**
 * Discriminator for the two distinct Codex profile-drift warning cases.
 * Each case must dedup independently per-turn so that emitting one cannot
 * silently suppress the other across retries (e.g. attempt 1 emits Case A,
 * attempt 2 rebuilds the route plan and would have legitimately emitted
 * Case B, but the legacy single-set dedup would suppress it).
 *
 * - 'caseA' — rescued `auth: 'codex-subscription'` despite `workingProfileId === null`
 * - 'caseB' — Codex active+connected but route plan resolved to non-subscription auth
 */
export type CodexDriftWarningCase = 'caseA' | 'caseB';

export interface SecurityDenial {
  toolName: string;
  reason: string;
  timestamp: number;
  /** True when the denial was caused by an evaluation error (parse failure, timeout)
   *  rather than a genuine policy violation. Used to filter transient errors. */
  isError?: boolean;
}

class AgentTurnRegistryImpl {
  private turnLoggers = new Map<string, TurnSessionLogger>();
  private rendererSessionByTurn = new Map<string, string>();
  private activeTurnControllers = new Map<string, AbortController>();
  // Reverse mapping: rendererSessionId -> active turnId (for deduplication)
  private activeTurnBySession = new Map<string, string>();
  private turnEventListeners = new Map<string, (event: AgentEvent) => void>();
  // Multi-subscriber turn-event API (complements the single-slot turnEventListeners).
  // Used by the ConversationStreamCoordinator so multiple SSE clients can observe
  // the same turn without competing for the single-slot listener slot.
  private turnEventSubscribers = new Map<string, Set<(event: AgentEvent) => void>>();
  // Session-level turn-start notification (for the ConversationStreamCoordinator to
  // auto-subscribe when a new turn begins on a conversation that has active streams).
  private sessionTurnStartListeners = new Map<string, Set<(turnId: string) => void>>();
  private turnEndedListeners = new Map<string, Set<() => void>>();
  private turnPrompts = new Map<string, string>();
  private turnContextAccumulators = new Map<string, LazyContextAccumulator>();
  private contextOverflowDispatchedForTurn = new Set<string>();
  private outputCapRetryAttempted = new Set<string>();
  // Dedup flag for runtime-result error dispatch (Stage 4 of
  // 260421_classification_driven_error_humanizer). Prevents duplicate
  // `dispatchAgentErrorEvent` calls when the SDK runtime emits `error_during_execution`
  // result twice for the same turn. Mirrors the `contextOverflowDispatchedForTurn` pattern.
  private errorResultDispatchedForTurn = new Set<string>();
  // Security denials: automationScheduler reads+clears before cleanupTurn; cleanupTurn is the safety net
  private securityDenialsByTurn = new Map<string, SecurityDenial[]>();
  // Observed tool calls: automationScheduler reads+clears before cleanupTurn; cleanupTurn is the safety net
  private toolCallsByTurn = new Map<string, ObservedToolCall[]>();
  // Requested model alias from system.init (fallback for UI; actual model from result.modelUsage)
  private turnModels = new Map<string, string>();
  // Extended context (1M) enabled for this turn
  private turnExtendedContext = new Map<string, boolean>();
  // Resolved context window for this turn (from resolveModelLimits — single source of truth for UI)
  private turnContextWindows = new Map<string, number>();
  // Retry count for transient network errors (silent retry)
  private turnRetryCounts = new Map<string, number>();
  // Wall-clock start time of the retry loop (set on first server error)
  private turnRetryStartTimes = new Map<string, number>();
  // Private mode flag per turn (for memory update context)
  private turnPrivateModes = new Map<string, boolean>();
  // Cost category for spend classification
  private turnCategories = new Map<string, CostCategory>();
  // Auto-continue count per turn (for Stop hook loop prevention)
  private autoContinueCounts = new Map<string, number>();
  // Input source for each turn (voice vs text) - used for badge tracking
  private turnInputSources = new Map<string, 'voice' | 'text'>();
  private approvalHandlersByTurn = new Map<string, ApprovalHandler>();

  // REBEL-J1: Track if spawn was delayed due to concurrent turns (for error messaging/Sentry)
  private turnSpawnDelayed = new Map<string, boolean>();
  // Per-turn thinking effort at time of execution (for accurate tooltip display)
  private turnThinkingEfforts = new Map<string, ThinkingEffort>();
  // Per-turn auth method at time of execution (for accurate tooltip display)
  private turnAuthMethods = new Map<string, string>();
  // Per-turn Codex/profile drift warning dedupe, keyed by warning case so that
  // Case A (rescued subscription with null profile) and Case B (Codex active+
  // connected but resolved as non-subscription) cannot mutually suppress each
  // other across retries. Preserved across cleanupForRetry() so each case emits
  // at most once per logical turn; cleared on terminal cleanup.
  private codexProfileDriftWarningTurns = new Map<string, Set<CodexDriftWarningCase>>();
  // Per-turn active provider at time of execution (for error provider attribution)
  private turnActiveProviders = new Map<string, string>();
  // Per-turn planning model at time of execution (for accurate tooltip display)
  private turnPlanningModels = new Map<string, string>();
  // Per-turn configured Behind-the-Scenes (Background/`fast`) model. Authored at executor setup so
  // the result event can surface the configured BTS model even on turns where no BTS call ran.
  private turnFastModels = new Map<string, string>();
  // Degradation events during a turn (auth/model/context fallbacks)
  private turnFallbacks = new Map<string, TurnFallback[]>();

  /**
   * Upstream SSE activity timestamps.
   *
   * Note: The Responses API translator routes reasoning summary deltas to the
   * `reasoning_content` channel (via `codexResponsesTranslator.ts`
   * `createStreamTranslator` case `response.reasoning_summary_text.delta`),
   * not to the content/output_text channel. The proxy/RC client still marks
   * upstream activity separately so the watchdog can use
   * `max(lastMessageTime, upstreamActivity)` to detect true stalls vs
   * reasoning phases. See docs/plans/260331_upstream_activity_watchdog_fix.md.
   */
  private upstreamActivityTimestamps = new Map<string, number>();
  // Per-turn "making progress" timestamp used by the active-turn watchdog.
  // Updated from tool calls, upstream activity markers, and dispatcher event
  // classes that indicate forward movement (assistant/tool/result progression).
  private turnLastProgressAt = new Map<string, number>();

  // Turns where exact cost has been recorded via handleAgentMessage result branch.
  // Read by runAgentQuery's finally block to skip estimation when exact cost exists.
  private turnCostRecorded = new Set<string>();

  // Turns where a successful result has been dispatched to the renderer.
  // Post-result assistant/result messages (e.g. from task queue dequeue)
  // are dropped to prevent stale text pollution. Cost tracking is preserved.
  private successResultDispatched = new Set<string>();

  // Force-kill close callbacks: stores a callback that calls Query.close() on the active
  // Agent query iterator. Used for force-kill escalation when graceful abort doesn't terminate.
  private turnCloseCallbacks = new Map<string, () => void>();

  // Per-session safety block counter for automation circuit breaker
  // Tracks how many tool calls have been staged/denied in an automation session
  // Keyed by sessionId (not turnId) because automations typically run as a single turn
  private automationSafetyBlockCounts = new Map<string, number>();

  // Stage 5 (260503): per-turn list of `resolvedAfterMs` for watchdog
  // self-resolutions — i.e. stalls the turn recovered from on its own.
  // The eval harness reads this after each turn to surface
  // `recoveredStalls` in the run summary so operators don't need to grep
  // logs for "Watchdog self-resolved". Production runtime: append-only;
  // cleared in `cleanupTurn` like every other per-turn registry state.
  // Plan reference: docs/plans/260503_kw_eval_infra_robustness.md Stage 5.
  private turnRecoveredStallsMs = new Map<string, number[]>();

  // Turns with a pending user question (AskUserQuestion denied, waiting for user answer).
  // Prevents auto-continue hook from forcing continuation while user input is required.
  private userQuestionPendingTurns = new Set<string>();
  // Authoritative user_question provenance keyed by turn+batch. This is a
  // smaller, purpose-built index for response validation; the full context
  // accumulator remains the continuation-history source but is easier to lose
  // during terminal cleanup/recovery paths.
  private userQuestionProvenanceByTurn = new Map<string, Map<string, Extract<AgentEvent, { type: 'user_question' }>>>();

  // One-shot drain callbacks: fired when activeTurnControllers drops to 0 from >0
  // Used by superMcpHttpManager to defer restarts until active turns complete
  private drainedCallbacks: Array<() => void> = [];

  // Persistent listeners for turn-idle-state transitions (any active turn count
  // crossing 0 in either direction: 0 → ≥1 or ≥1 → 0). Unlike `drainedCallbacks`
  // these are NOT one-shot — they survive across transitions. Used by Stage 6
  // background-work scheduling (indexer/embedder pause) via the main-process
  // `onTurnIdleStateChange` accessor in `visibilityAwareScheduler.ts`.
  // Plan reference: docs/plans/260508_active_work_cpu_gpu_architectural_rebuild.md Stage 1.
  private turnIdleStateChangeListeners = new Set<() => void>();

  // Persistent listeners fired when per-turn module-scoped state held outside
  // the registry needs cleanup. Invoked from `cleanupTurn`, `cleanupForRetry`,
  // and `releaseActiveSession`. Used by `agentEventDispatcher` to clear the
  // `answer_phase_started` sentinel set on every turn-end path (Stage 2 of
  // the 260508 active-work CPU/GPU rebuild — F16 invariant: marker must be
  // re-emittable across retries and recovery loops).
  private turnCleanupListeners = new Set<(turnId: string) => void>();
  // Sessions where extended context (1M) has failed and should be skipped for later turns
  private extendedContextFailedSessions = new Set<string>();

  // Boot-lifetime tracking: sessions that have had at least one turn.
  // Covers the 300ms persistence debounce gap where the session index
  // hasn't been updated yet but the session clearly has context.
  private sessionsWithTurns = new Set<string>();

  // Turn Loggers
  getTurnLogger(turnId: string): TurnSessionLogger | undefined {
    return this.turnLoggers.get(turnId);
  }

  setTurnLogger(turnId: string, logger: TurnSessionLogger): void {
    this.turnLoggers.set(turnId, logger);
  }

  deleteTurnLogger(turnId: string): boolean {
    return this.turnLoggers.delete(turnId);
  }

  // Renderer Session Mapping (turnId -> rendererSessionId)
  getRendererSession(turnId: string): string | undefined {
    return this.rendererSessionByTurn.get(turnId);
  }

  setRendererSession(turnId: string, sessionId: string): void {
    const isNewTurnForSession = this.rendererSessionByTurn.get(turnId) !== sessionId;
    this.rendererSessionByTurn.set(turnId, sessionId);
    this.activeTurnBySession.set(sessionId, turnId);
    // Notify session-level turn-start listeners. Firing only when the turn is new
    // to the session avoids duplicate notifications if this mapping is re-applied.
    if (isNewTurnForSession) {
      const listeners = this.sessionTurnStartListeners.get(sessionId);
      if (listeners && listeners.size > 0) {
        for (const cb of listeners) {
          try {
            cb(turnId);
          } catch {
            // Swallow subscriber errors — one bad listener must not break the turn lifecycle.
            // The event dispatcher logs subscriber failures when events flow; for the
            // registry itself we keep this defensive and silent to avoid pulling in
            // logger imports at this layer.
          }
        }
      }
    }
  }

  deleteRendererSession(turnId: string): boolean {
    const sessionId = this.rendererSessionByTurn.get(turnId);
    if (sessionId) {
      // Only clear the reverse mapping if it still points to this turn
      if (this.activeTurnBySession.get(sessionId) === turnId) {
        this.activeTurnBySession.delete(sessionId);
      }
    }
    return this.rendererSessionByTurn.delete(turnId);
  }

  /**
   * Release session liveness without deleting the turn→session mapping.
   * Called after the result event so a new turn on the same session won't
   * cancel an already-complete turn. The forward map (turnId → sessionId) stays
   * intact for late cleanup code (e.g. proxy cost attribution) and is deleted
   * later by cleanupTurn().
   */
  releaseActiveSession(turnId: string): void {
    const sessionId = this.rendererSessionByTurn.get(turnId);
    if (sessionId && this.activeTurnBySession.get(sessionId) === turnId) {
      this.activeTurnBySession.delete(sessionId);
    }
    this.notifyTurnCleanupListeners(turnId);
  }

  /**
   * Get the currently active turn for a session (if any).
   * Used for deduplication - to cancel existing turn before starting new one.
   */
  getActiveTurnForSession(sessionId: string): string | undefined {
    return this.activeTurnBySession.get(sessionId);
  }

  /**
   * Cancel any existing turn for this session and return the cancelled turnId (if any).
   * Call this before starting a new turn to prevent duplicate execution.
   */
  cancelExistingTurnForSession(sessionId: string): string | undefined {
    const existingTurnId = this.activeTurnBySession.get(sessionId);
    if (!existingTurnId) return undefined;

    const controller = this.activeTurnControllers.get(existingTurnId);
    if (controller && !controller.signal.aborted) {
      controller.abort('superseded');
      return existingTurnId;
    }
    return undefined;
  }

  // Active Turn Controllers
  getActiveTurnController(turnId: string): AbortController | undefined {
    return this.activeTurnControllers.get(turnId);
  }

  setActiveTurnController(turnId: string, controller: AbortController): void {
    const wasIdle = this.activeTurnControllers.size === 0;
    const isNew = !this.activeTurnControllers.has(turnId);
    this.activeTurnControllers.set(turnId, controller);
    if (wasIdle && isNew) {
      this.notifyTurnIdleStateChangeListeners();
    }
  }

  deleteActiveTurnController(turnId: string): boolean {
    const removed = this.activeTurnControllers.delete(turnId);
    if (removed && this.activeTurnControllers.size === 0) {
      this.notifyTurnIdleStateChangeListeners();
    }
    return removed;
  }

  getActiveTurnCount(): number {
    return this.activeTurnControllers.size;
  }

  /**
   * Register a one-shot callback that fires when active turn count drops to 0 from >0.
   * Callbacks are cleared after firing. Multiple listeners are supported.
   * Used by superMcpHttpManager.scheduleRestartWhenIdle() to defer restarts.
   */
  onDrained(callback: () => void): void {
    this.drainedCallbacks.push(callback);
  }

  /**
   * Check if a specific session has an active turn running
   */
  hasActiveTurnForSession(sessionId: string): boolean {
    return this.activeTurnBySession.has(sessionId);
  }

  /**
   * Check if any active turn is currently in flight (any category).
   *
   * Counterpart to `hasInteractiveTurn()` which filters to category
   * `'conversation'`. Use `hasAnyActiveTurn()` for system-wide
   * "anywhere is busy" checks (e.g. background-work scheduling in Stage 6
   * indexer/embedder pause). Use `hasInteractiveTurn()` to gate work that
   * should defer only behind user-driven conversation turns and continue
   * running through automation turns.
   *
   * Plan reference: docs/plans/260508_active_work_cpu_gpu_architectural_rebuild.md Stage 1 (F4 + R2-2).
   */
  hasAnyActiveTurn(): boolean {
    return this.activeTurnControllers.size > 0;
  }

  /**
   * Check if any active turn is an interactive conversation (user-initiated).
   * Used by automation deferral to avoid running LLM automations
   * while a user conversation is in progress.
   */
  hasInteractiveTurn(): boolean {
    for (const [turnId, category] of this.turnCategories) {
      if (category === 'conversation' && this.activeTurnControllers.has(turnId)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Snapshot of currently-active turn IDs. Defensive copy — callers must not
   * mutate the returned array. Used by Stage 6 background-consumer-latch
   * structured logging (R2-7) so degraded-mode entry can record the leaked
   * turn IDs without reaching into private state.
   */
  getActiveTurnIds(): string[] {
    return Array.from(this.activeTurnControllers.keys());
  }

  setApprovalHandler(turnId: string, handler: ApprovalHandler): void {
    this.approvalHandlersByTurn.set(turnId, handler);
  }

  getApprovalHandler(turnId: string): ApprovalHandler | undefined {
    return this.approvalHandlersByTurn.get(turnId);
  }

  deleteApprovalHandler(turnId: string): boolean {
    return this.approvalHandlersByTurn.delete(turnId);
  }

  /**
   * Subscribe to turn-idle-state transitions. Listener fires when the active
   * turn count crosses zero in either direction (0 → ≥1 or ≥1 → 0). Listeners
   * persist across transitions (NOT one-shot, unlike `onDrained`) and must be
   * removed via the returned unsubscribe function.
   *
   * Listeners are invoked synchronously from inside the registry mutation that
   * caused the transition. Errors thrown by individual listeners are caught and
   * logged via the structured logger so one bad listener cannot break the turn
   * lifecycle (AGENTS.md "Silent failure is a bug" — observable, not swallowed).
   *
   * Plan reference: docs/plans/260508_active_work_cpu_gpu_architectural_rebuild.md Stage 1.
   */
  subscribeTurnIdleStateChange(listener: () => void): () => void {
    this.turnIdleStateChangeListeners.add(listener);
    return () => {
      this.turnIdleStateChangeListeners.delete(listener);
    };
  }

  private notifyTurnIdleStateChangeListeners(): void {
    if (this.turnIdleStateChangeListeners.size === 0) return;
    const snapshot = Array.from(this.turnIdleStateChangeListeners);
    for (const listener of snapshot) {
      try {
        listener();
      } catch (error) {
        turnIdleEmitterLogger.error(
          {
            error,
            listenerCount: snapshot.length,
            source: 'turn-idle-emitter',
          },
          'turnIdleStateChange listener threw an error',
        );
      }
    }
  }

  /**
   * Subscribe to turn-cleanup notifications. Listener receives `turnId` and is
   * invoked synchronously inside `cleanupTurn`, `cleanupForRetry`, and
   * `releaseActiveSession`. Persistent (NOT one-shot). Errors are caught so
   * one bad listener cannot break turn lifecycle. See the
   * `turnCleanupListeners` field doc-comment for the design rationale.
   */
  subscribeTurnCleanup(listener: (turnId: string) => void): () => void {
    this.turnCleanupListeners.add(listener);
    return () => {
      this.turnCleanupListeners.delete(listener);
    };
  }

  private notifyTurnCleanupListeners(turnId: string): void {
    if (this.turnCleanupListeners.size === 0) return;
    const snapshot = Array.from(this.turnCleanupListeners);
    for (const listener of snapshot) {
      try {
        listener(turnId);
      } catch (error) {
        turnIdleEmitterLogger.error(
          {
            error,
            turnId,
            listenerCount: snapshot.length,
            source: 'turn-cleanup-emitter',
          },
          'turnCleanup listener threw an error',
        );
      }
    }
  }

  abortAllTurns(): void {
    for (const controller of this.activeTurnControllers.values()) {
      try {
        controller.abort();
      } catch {
        // Ignore abort errors during shutdown
      }
    }
  }

  // Turn Close Callbacks (for force-kill via Query.close())
  getTurnCloseCallback(turnId: string): (() => void) | undefined {
    return this.turnCloseCallbacks.get(turnId);
  }

  setTurnCloseCallback(turnId: string, cb: () => void): void {
    this.turnCloseCallbacks.set(turnId, cb);
  }

  deleteTurnCloseCallback(turnId: string): boolean {
    return this.turnCloseCallbacks.delete(turnId);
  }

  // Turn Event Listeners
  getEventListener(turnId: string): ((event: AgentEvent) => void) | undefined {
    return this.turnEventListeners.get(turnId);
  }

  setEventListener(turnId: string, listener: (event: AgentEvent) => void): void {
    this.turnEventListeners.set(turnId, listener);
  }

  deleteEventListener(turnId: string): boolean {
    return this.turnEventListeners.delete(turnId);
  }

  /**
   * Subscribe to all events for a turn. Multiple subscribers supported.
   *
   * Complements the single-slot `setEventListener` / `getEventListener` /
   * `deleteEventListener` API (used by the automation drain path). The event
   * dispatcher invokes the single-slot listener AND iterates subscribers added
   * via this method, each wrapped in its own try/catch so one failing
   * subscriber can't break others or the single-slot listener.
   *
   * Returns an unsubscribe function. Automatically cleaned up by
   * `cleanupTurn()` / `cleanupForRetry()` when the turn ends.
   */
  subscribeTurnEvents(turnId: string, listener: (event: AgentEvent) => void): () => void {
    const existing = this.turnEventSubscribers.get(turnId) ?? new Set<(event: AgentEvent) => void>();
    existing.add(listener);
    this.turnEventSubscribers.set(turnId, existing);
    return () => {
      const current = this.turnEventSubscribers.get(turnId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.turnEventSubscribers.delete(turnId);
      }
    };
  }

  /**
   * Get the current subscriber set for a turn. Intended for the event
   * dispatcher to iterate and fan out events. Returns `undefined` when
   * there are no subscribers (common fast path).
   */
  getEventSubscribers(turnId: string): Set<(event: AgentEvent) => void> | undefined {
    return this.turnEventSubscribers.get(turnId);
  }

  /**
   * Subscribe to turn-start notifications for a given renderer session.
   *
   * Fired from `setRendererSession(turnId, sessionId)` when a new turn is
   * mapped to the session. The ConversationStreamCoordinator uses this to
   * auto-attach per-turn subscribers when new turns begin on a conversation
   * that has active SSE clients.
   *
   * Returns an unsubscribe function. Listeners persist across turn
   * cleanup — the subscription is session-scoped, not turn-scoped.
   */
  onTurnStartedForSession(sessionId: string, listener: (turnId: string) => void): () => void {
    const existing = this.sessionTurnStartListeners.get(sessionId) ?? new Set<(turnId: string) => void>();
    existing.add(listener);
    this.sessionTurnStartListeners.set(sessionId, existing);
    return () => {
      const current = this.sessionTurnStartListeners.get(sessionId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.sessionTurnStartListeners.delete(sessionId);
      }
    };
  }

  onTurnEnded(turnId: string, listener: () => void): () => void {
    const listeners = this.turnEndedListeners.get(turnId) ?? new Set<() => void>();
    listeners.add(listener);
    this.turnEndedListeners.set(turnId, listeners);
    return () => {
      const current = this.turnEndedListeners.get(turnId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.turnEndedListeners.delete(turnId);
      }
    };
  }

  // Turn Prompts
  getTurnPrompt(turnId: string): string | undefined {
    return this.turnPrompts.get(turnId);
  }

  setTurnPrompt(turnId: string, prompt: string): void {
    this.turnPrompts.set(turnId, prompt);
  }

  deleteTurnPrompt(turnId: string): boolean {
    return this.turnPrompts.delete(turnId);
  }

  // Context Accumulators (lazy — events pushed O(1), shape derived on demand)
  getOrCreateAccumulator(turnId: string, sessionId?: string): LazyContextAccumulator {
    let accumulator = this.turnContextAccumulators.get(turnId);
    if (!accumulator) {
      const resolvedSessionId = sessionId ?? this.getRendererSession(turnId);
      accumulator = new LazyContextAccumulator(turnId, resolvedSessionId);
      this.turnContextAccumulators.set(turnId, accumulator);
      return accumulator;
    }

    const resolvedSessionId = sessionId ?? this.getRendererSession(turnId);
    if (resolvedSessionId) {
      accumulator.setSessionId(resolvedSessionId);
    }
    return accumulator;
  }

  getContextAccumulator(turnId: string): ConversationStateShape | undefined {
    const accumulator = this.turnContextAccumulators.get(turnId);
    return accumulator?.getConversationShape();
  }

  peekAccumulator(turnId: string): LazyContextAccumulator | undefined {
    return this.turnContextAccumulators.get(turnId);
  }

  deleteContextAccumulator(turnId: string): boolean {
    return this.turnContextAccumulators.delete(turnId);
  }

  // Context Overflow Tracking
  hasContextOverflowDispatched(turnId: string): boolean {
    return this.contextOverflowDispatchedForTurn.has(turnId);
  }

  markContextOverflowDispatched(turnId: string): void {
    this.contextOverflowDispatchedForTurn.add(turnId);
  }

  clearContextOverflowDispatched(turnId: string): boolean {
    return this.contextOverflowDispatchedForTurn.delete(turnId);
  }

  hasOutputCapRetryAttempted(key: string): boolean {
    return this.outputCapRetryAttempted.has(key);
  }

  markOutputCapRetryAttempted(key: string): void {
    this.outputCapRetryAttempted.add(key);
  }

  clearOutputCapRetryAttempted(turnId: string): void {
    for (const key of this.outputCapRetryAttempted) {
      if (key.startsWith(`${turnId}|`)) {
        this.outputCapRetryAttempted.delete(key);
      }
    }
  }

  // Runtime-Result Error Dispatch Tracking (Stage 4 of 260421_classification_driven_error_humanizer)
  // Prevents duplicate runtime-result error dispatch when the SDK fires
  // `error_during_execution` twice for the same turn. Mark-AFTER-success semantics:
  // only latch the flag after `dispatchAgentErrorEvent` returns `{ok: true}`, so
  // a dispatch failure cannot silence every subsequent error for the turn.
  hasErrorResultDispatched(turnId: string): boolean {
    return this.errorResultDispatchedForTurn.has(turnId);
  }

  markErrorResultDispatched(turnId: string): void {
    this.errorResultDispatchedForTurn.add(turnId);
  }

  clearErrorResultDispatched(turnId: string): boolean {
    return this.errorResultDispatchedForTurn.delete(turnId);
  }

  // Actionable Error Tracking (billing, auth, rate_limit)
  // When these errors are dispatched, we don't want to show generic "tool connection failed"
  // or send to Sentry (these are user-fixable, not bugs)
  private actionableErrorDispatchedForTurn = new Set<string>();

  hasActionableErrorDispatched(turnId: string): boolean {
    return this.actionableErrorDispatchedForTurn.has(turnId);
  }

  markActionableErrorDispatched(turnId: string): void {
    this.actionableErrorDispatchedForTurn.add(turnId);
  }

  clearActionableErrorDispatched(turnId: string): boolean {
    return this.actionableErrorDispatchedForTurn.delete(turnId);
  }

  // Security Denial Tracking (for headless/automation mode)
  // Note: These are NOT cleaned up in cleanupTurn() - callers must explicitly clear
  recordSecurityDenial(turnId: string, toolName: string, reason: string, isError?: boolean): void {
    const denials = this.securityDenialsByTurn.get(turnId) ?? [];
    denials.push({ toolName, reason, timestamp: Date.now(), ...(isError ? { isError } : {}) });
    this.securityDenialsByTurn.set(turnId, denials);
  }

  getSecurityDenials(turnId: string): SecurityDenial[] {
    return this.securityDenialsByTurn.get(turnId) ?? [];
  }

  clearSecurityDenials(turnId: string): boolean {
    return this.securityDenialsByTurn.delete(turnId);
  }

  // Automation Safety Block Counter (circuit breaker)
  incrementAutomationSafetyBlock(sessionId: string): number {
    const current = this.automationSafetyBlockCounts.get(sessionId) ?? 0;
    const next = current + 1;
    this.automationSafetyBlockCounts.set(sessionId, next);
    return next;
  }

  getAutomationSafetyBlockCount(sessionId: string): number {
    return this.automationSafetyBlockCounts.get(sessionId) ?? 0;
  }

  clearAutomationSafetyBlockCount(sessionId: string): boolean {
    return this.automationSafetyBlockCounts.delete(sessionId);
  }

  // Tool Call Observation Tracking (for access rules generation)
  recordToolCall(turnId: string, toolName: string, toolInput: Record<string, unknown>): void {
    const calls = this.toolCallsByTurn.get(turnId) ?? [];
    calls.push({ toolName, toolInput, timestamp: Date.now() });
    this.toolCallsByTurn.set(turnId, calls);
    this.markTurnProgress(turnId);
  }

  getToolCalls(turnId: string): ObservedToolCall[] {
    return this.toolCallsByTurn.get(turnId) ?? [];
  }

  clearToolCalls(turnId: string): boolean {
    return this.toolCallsByTurn.delete(turnId);
  }

  // Turn Model Tracking (model used, captured from system.init)
  getTurnModel(turnId: string): string | undefined {
    return this.turnModels.get(turnId);
  }

  setTurnModel(turnId: string, model: string): void {
    this.turnModels.set(turnId, model);
  }

  deleteTurnModel(turnId: string): boolean {
    return this.turnModels.delete(turnId);
  }

  // Extended Context Tracking (1M context window)
  getTurnExtendedContext(turnId: string): boolean {
    return this.turnExtendedContext.get(turnId) ?? false;
  }

  setTurnExtendedContext(turnId: string, enabled: boolean): void {
    this.turnExtendedContext.set(turnId, enabled);
  }

  deleteTurnExtendedContext(turnId: string): boolean {
    return this.turnExtendedContext.delete(turnId);
  }

  // Resolved context window (from resolveModelLimits — authoritative for UI)
  getTurnContextWindow(turnId: string): number | null {
    return this.turnContextWindows.get(turnId) ?? null;
  }

  setTurnContextWindow(turnId: string, contextWindow: number): void {
    this.turnContextWindows.set(turnId, contextWindow);
  }

  deleteTurnContextWindow(turnId: string): boolean {
    return this.turnContextWindows.delete(turnId);
  }

  // Extended Context Session Failure Tracking (renderer session-level)
  markExtendedContextFailed(rendererSessionId: string): void {
    this.extendedContextFailedSessions.add(rendererSessionId);
  }

  hasExtendedContextFailed(rendererSessionId: string): boolean {
    return this.extendedContextFailedSessions.has(rendererSessionId);
  }

  clearExtendedContextFailed(rendererSessionId: string): boolean {
    return this.extendedContextFailedSessions.delete(rendererSessionId);
  }

  // Boot-lifetime session turn tracking (covers 300ms persistence debounce gap)
  recordSessionTurn(sessionId: string): void {
    this.sessionsWithTurns.add(sessionId);
  }

  hasSessionHadTurns(sessionId: string): boolean {
    return this.sessionsWithTurns.has(sessionId);
  }

  // Retry Count Tracking (for silent network error retries)
  getRetryCount(turnId: string): number {
    return this.turnRetryCounts.get(turnId) ?? 0;
  }

  incrementRetryCount(turnId: string): number {
    const current = this.getRetryCount(turnId);
    const next = current + 1;
    this.turnRetryCounts.set(turnId, next);
    return next;
  }

  deleteRetryCount(turnId: string): boolean {
    return this.turnRetryCounts.delete(turnId);
  }

  // Retry Start Time Tracking (wall-clock budget for server error retries)
  getRetryStartTime(turnId: string): number | undefined {
    return this.turnRetryStartTimes.get(turnId);
  }

  setRetryStartTime(turnId: string, timestamp: number): void {
    this.turnRetryStartTimes.set(turnId, timestamp);
  }

  deleteRetryStartTime(turnId: string): boolean {
    return this.turnRetryStartTimes.delete(turnId);
  }

  // Private Mode Tracking (for memory update context)
  getTurnPrivateMode(turnId: string): boolean {
    return this.turnPrivateModes.get(turnId) ?? false;
  }

  setTurnPrivateMode(turnId: string, privateMode: boolean): void {
    this.turnPrivateModes.set(turnId, privateMode);
  }

  deleteTurnPrivateMode(turnId: string): boolean {
    return this.turnPrivateModes.delete(turnId);
  }

  // Cost Category Tracking (for spend classification)
  getTurnCategory(turnId: string): CostCategory | undefined {
    return this.turnCategories.get(turnId);
  }

  setTurnCategory(turnId: string, category: CostCategory): void {
    this.turnCategories.set(turnId, category);
  }

  deleteTurnCategory(turnId: string): boolean {
    return this.turnCategories.delete(turnId);
  }

  // Auto-Continue Count Tracking (for Stop hook loop prevention)
  getAutoContinueCount(turnId: string): number {
    return this.autoContinueCounts.get(turnId) ?? 0;
  }

  incrementAutoContinueCount(turnId: string): number {
    const current = this.getAutoContinueCount(turnId);
    const next = current + 1;
    this.autoContinueCounts.set(turnId, next);
    return next;
  }

  resetAutoContinueCount(turnId: string): void {
    this.autoContinueCounts.delete(turnId);
  }

  // User Question Pending Tracking (for auto-continue suppression)
  hasUserQuestionPending(turnId: string): boolean {
    return this.userQuestionPendingTurns.has(turnId);
  }

  markUserQuestionPending(turnId: string): void {
    this.userQuestionPendingTurns.add(turnId);
  }

  clearUserQuestionPending(turnId: string): boolean {
    return this.userQuestionPendingTurns.delete(turnId);
  }

  recordUserQuestionProvenance(
    turnId: string,
    event: Extract<AgentEvent, { type: 'user_question' }>,
  ): void {
    let provenanceForTurn = this.userQuestionProvenanceByTurn.get(turnId);
    if (!provenanceForTurn) {
      provenanceForTurn = new Map<string, Extract<AgentEvent, { type: 'user_question' }>>();
      this.userQuestionProvenanceByTurn.set(turnId, provenanceForTurn);
    }
    provenanceForTurn.set(event.batchId, event);
  }

  getUserQuestionProvenance(
    turnId: string,
    batchId: string,
  ): Extract<AgentEvent, { type: 'user_question' }> | undefined {
    return this.userQuestionProvenanceByTurn.get(turnId)?.get(batchId);
  }

  clearUserQuestionProvenance(turnId: string, batchId?: string): void {
    if (batchId === undefined) {
      this.userQuestionProvenanceByTurn.delete(turnId);
      return;
    }

    const provenanceForTurn = this.userQuestionProvenanceByTurn.get(turnId);
    if (!provenanceForTurn) return;
    provenanceForTurn.delete(batchId);
    if (provenanceForTurn.size === 0) {
      this.userQuestionProvenanceByTurn.delete(turnId);
    }
  }

  // Input Source Tracking (voice vs text) - for badge evaluation
  getTurnInputSource(turnId: string): 'voice' | 'text' {
    return this.turnInputSources.get(turnId) ?? 'text';
  }

  setTurnInputSource(turnId: string, source: 'voice' | 'text'): void {
    this.turnInputSources.set(turnId, source);
  }

  deleteTurnInputSource(turnId: string): boolean {
    return this.turnInputSources.delete(turnId);
  }

  // REBEL-J1: Spawn Delay Tracking (for concurrent turn race condition mitigation)
  getTurnSpawnDelayed(turnId: string): boolean {
    return this.turnSpawnDelayed.get(turnId) ?? false;
  }

  setTurnSpawnDelayed(turnId: string, delayed: boolean): void {
    this.turnSpawnDelayed.set(turnId, delayed);
  }

  deleteTurnSpawnDelayed(turnId: string): boolean {
    return this.turnSpawnDelayed.delete(turnId);
  }

  // Thinking Effort Tracking (per-turn snapshot for accurate tooltip)
  getTurnThinkingEffort(turnId: string): ThinkingEffort | undefined {
    return this.turnThinkingEfforts.get(turnId);
  }

  setTurnThinkingEffort(turnId: string, effort: ThinkingEffort): void {
    this.turnThinkingEfforts.set(turnId, effort);
  }

  deleteTurnThinkingEffort(turnId: string): boolean {
    return this.turnThinkingEfforts.delete(turnId);
  }

  // Auth Method Tracking (per-turn snapshot for accurate tooltip)
  getTurnAuthMethod(turnId: string): string | undefined {
    return this.turnAuthMethods.get(turnId);
  }

  setTurnAuthMethod(turnId: string, method: string): void {
    this.turnAuthMethods.set(turnId, method);
  }

  deleteTurnAuthMethod(turnId: string): boolean {
    return this.turnAuthMethods.delete(turnId);
  }

  // Active Provider Tracking (per-turn snapshot for error attribution)
  getTurnActiveProvider(turnId: string): string | undefined {
    return this.turnActiveProviders.get(turnId);
  }

  setTurnActiveProvider(turnId: string, provider: string): void {
    this.turnActiveProviders.set(turnId, provider);
  }

  deleteTurnActiveProvider(turnId: string): boolean {
    return this.turnActiveProviders.delete(turnId);
  }

  hasCodexProfileDriftWarningEmitted(turnId: string, kase: CodexDriftWarningCase): boolean {
    return this.codexProfileDriftWarningTurns.get(turnId)?.has(kase) ?? false;
  }

  markCodexProfileDriftWarningEmitted(turnId: string, kase: CodexDriftWarningCase): void {
    let set = this.codexProfileDriftWarningTurns.get(turnId);
    if (!set) {
      set = new Set<CodexDriftWarningCase>();
      this.codexProfileDriftWarningTurns.set(turnId, set);
    }
    set.add(kase);
  }

  // Planning Model Tracking (per-turn snapshot for accurate tooltip)
  getTurnPlanningModel(turnId: string): string | undefined {
    return this.turnPlanningModels.get(turnId);
  }

  setTurnPlanningModel(turnId: string, model: string): void {
    this.turnPlanningModels.set(turnId, model);
  }

  deleteTurnPlanningModel(turnId: string): boolean {
    return this.turnPlanningModels.delete(turnId);
  }

  // Configured Behind-the-Scenes (Background/`fast`) model for the turn (per-turn snapshot).
  getTurnFastModel(turnId: string): string | undefined {
    return this.turnFastModels.get(turnId);
  }

  setTurnFastModel(turnId: string, model: string): void {
    this.turnFastModels.set(turnId, model);
  }

  deleteTurnFastModel(turnId: string): boolean {
    return this.turnFastModels.delete(turnId);
  }

  // Fallback Tracking (degradation events during a turn)
  addTurnFallback(turnId: string, fallback: TurnFallback): void {
    const existing = this.turnFallbacks.get(turnId) ?? [];
    existing.push(fallback);
    this.turnFallbacks.set(turnId, existing);
  }

  getTurnFallbacks(turnId: string): TurnFallback[] {
    return this.turnFallbacks.get(turnId) ?? [];
  }

  /**
   * Patch the destination of a pending provider failover record.
   *
   * The Stage-4b 429 failover writes a `type: 'provider'` fallback with the
   * placeholder `to: 'auto-failover'` — the real destination is only known once
   * the RETRY re-resolves a fresh route. This rewrites the LAST such pending
   * record's `to` (the real credential source we landed on) and `billingSource`
   * ("who pays").
   *
   * MULTI-HOP: targets only the most-recent still-pending `'auto-failover'`
   * provider record. Called at each failover-retry route-resolution seam, so for
   * A→B(429)→C the B-resolution patches A's placeholder to B and the C-resolution
   * patches B's placeholder to C (final state A→B, B→C) — every hop attributed,
   * including an intermediate hop that lands then itself 429s.
   *
   * ABORT/never-lands: called from the route-resolution seam, so a turn that never
   * re-resolves (e.g. abort before any resolution) leaves `'auto-failover'` in place
   * — the honest "we tried to fail over but couldn't confirm where" state.
   *
   * `to` is a `ProviderCredentialSource` (the credential the retry resolved to) so
   * a caller can't patch in a non-credential-source string the UI would then misread
   * as never-landed.
   *
   * No-op if there is no pending record (e.g. already patched, or the turn's
   * fallbacks were cleaned up).
   */
  updatePendingProviderFallbackDestination(
    turnId: string,
    update: { to: ProviderCredentialSource; billingSource: TurnFallback['billingSource'] },
  ): void {
    const existing = this.turnFallbacks.get(turnId);
    if (!existing) return;
    for (let i = existing.length - 1; i >= 0; i--) {
      const fb = existing[i];
      if (fb.type === 'provider' && fb.to === 'auto-failover') {
        existing[i] = { ...fb, to: update.to, billingSource: update.billingSource };
        return;
      }
    }
  }

  deleteTurnFallbacks(turnId: string): boolean {
    return this.turnFallbacks.delete(turnId);
  }

  // Cost Recorded Flag (cross-boundary signal: handleAgentMessage → runAgentQuery finally)
  markCostRecorded(turnId: string): void {
    this.turnCostRecorded.add(turnId);
  }

  hasCostRecorded(turnId: string): boolean {
    return this.turnCostRecorded.has(turnId);
  }

  // Success Result Dispatched Flag (post-result guard: agentMessageHandler)
  // Prevents task queue dequeue from polluting the user's result with stale text.
  markSuccessResultDispatched(turnId: string): void {
    this.successResultDispatched.add(turnId);
  }

  hasSuccessResultDispatched(turnId: string): boolean {
    return this.successResultDispatched.has(turnId);
  }

  markTurnProgress(turnId: string): void {
    this.turnLastProgressAt.set(turnId, Date.now());
  }

  getLastProgressAt(turnId: string): number | null {
    return this.turnLastProgressAt.get(turnId) ?? null;
  }

  getActiveTurnProgressSnapshot(): Array<{ turnId: string; lastProgressAt: number | null }> {
    const snapshot: Array<{ turnId: string; lastProgressAt: number | null }> = [];
    for (const turnId of this.activeTurnControllers.keys()) {
      snapshot.push({
        turnId,
        lastProgressAt: this.turnLastProgressAt.get(turnId) ?? null,
      });
    }
    return snapshot;
  }

  // Upstream Activity Tracking (for watchdog stall detection during reasoning phases)
  markUpstreamActivity(turnId: string): void {
    this.upstreamActivityTimestamps.set(turnId, Date.now());
    this.markTurnProgress(turnId);
  }

  getUpstreamActivity(turnId: string): number | undefined {
    return this.upstreamActivityTimestamps.get(turnId);
  }

  // Stage 5 (260503): Watchdog self-resolution telemetry surface.
  // See `turnRecoveredStallsMs` doc-comment for context.
  recordWatchdogSelfResolution(turnId: string, resolvedAfterMs: number): void {
    const existing = this.turnRecoveredStallsMs.get(turnId) ?? [];
    existing.push(resolvedAfterMs);
    this.turnRecoveredStallsMs.set(turnId, existing);
  }

  getRecoveredStallsMs(turnId: string): number[] {
    // Defensive copy — callers must not mutate the registry's internal storage.
    return [...(this.turnRecoveredStallsMs.get(turnId) ?? [])];
  }

  /**
   * Get diagnostic info about registry state for memory debugging.
   * Returns counts and estimated sizes of major data structures.
   */
  getDiagnostics(): {
    turnCount: number;
    contextAccumulatorCount: number;
    contextAccumulatorTotalEvents: number;
    largestContextAccumulatorEvents: number;
    securityDenialCount: number;
    toolCallCount: number;
  } {
    let totalEvents = 0;
    let largestEvents = 0;
    for (const acc of this.turnContextAccumulators.values()) {
      const count = acc.getEventCount();
      totalEvents += count;
      if (count > largestEvents) largestEvents = count;
    }
    return {
      turnCount: this.activeTurnControllers.size,
      contextAccumulatorCount: this.turnContextAccumulators.size,
      contextAccumulatorTotalEvents: totalEvents,
      largestContextAccumulatorEvents: largestEvents,
      securityDenialCount: this.securityDenialsByTurn.size,
      toolCallCount: this.toolCallsByTurn.size,
    };
  }

  /**
   * Clean up turn state for retry, preserving retry count.
   * Use this before recursively calling executeAgentTurn for retry attempts.
   * Unlike cleanupTurn(), this preserves the retry counter so we can track retry attempts.
   * If an AskUserQuestion turn is already waiting on the user, preserve the
   * pending flag and question provenance just like cleanupTurn(); otherwise a
   * retry cleanup can strand an already-rendered question card.
   */
  cleanupForRetry(turnId: string): void {
    // Preserves retry count - we're about to retry
    // Clean up reverse session mapping
    const sessionId = this.rendererSessionByTurn.get(turnId);
    if (sessionId && this.activeTurnBySession.get(sessionId) === turnId) {
      this.activeTurnBySession.delete(sessionId);
    }
    this.rendererSessionByTurn.delete(turnId);
    this.turnPrompts.delete(turnId);
    this.contextOverflowDispatchedForTurn.delete(turnId);
    this.errorResultDispatchedForTurn.delete(turnId);
    this.actionableErrorDispatchedForTurn.delete(turnId);
    this.securityDenialsByTurn.delete(turnId);
    this.toolCallsByTurn.delete(turnId);
    this.turnModels.delete(turnId);
    const wasActive = this.activeTurnControllers.delete(turnId);
    if (wasActive && this.activeTurnControllers.size === 0) {
      this.notifyTurnIdleStateChangeListeners();
    }
    this.turnCloseCallbacks.delete(turnId);
    // NOTE: Do NOT delete turnEventListeners on retry. The single-slot listener
    // is owned by the logical turn (turnId), not by an individual attempt.
    // Consumers (eval harness, cloud route handler, headless runner, automation
    // drain path) register the listener once via setEventListener(turnId, ...)
    // and have no mechanism to re-register after a retry. Deleting it here
    // silently breaks the "one terminal event per turnId" contract — the
    // dispatcher fan-out (line 832 of agentEventDispatcher) finds no listener
    // and the caller's promise never settles. The eval harness then hangs for
    // the full 15-minute turn timeout, the abort signal is also unobservable
    // (no listener to receive the resulting error event), and the 30s abort
    // grace expires too. Verified root cause of Bundle 4's stochastic 900s
    // timeouts (status×4, tool×2, turn_started×1 signature) on 2026-05-12.
    // turnEventSubscribers (multi-slot) intentionally still cleared — fan-out
    // re-subscription semantics are a separate concern owned by callers.
    this.turnEventSubscribers.delete(turnId);
    this.turnEndedListeners.delete(turnId);
    this.turnExtendedContext.delete(turnId);
    this.turnContextWindows.delete(turnId);
    this.turnPrivateModes.delete(turnId);
    this.turnCategories.delete(turnId);
    this.autoContinueCounts.delete(turnId);
    if (!this.userQuestionPendingTurns.has(turnId)) {
      this.userQuestionProvenanceByTurn.delete(turnId);
      this.userQuestionPendingTurns.delete(turnId);
    }
    this.turnSpawnDelayed.delete(turnId); // Re-evaluate on retry
    this.turnThinkingEfforts.delete(turnId);
    this.turnAuthMethods.delete(turnId);
    this.turnActiveProviders.delete(turnId);
    // Intentionally preserve codexProfileDriftWarningTurns across retries.
    this.turnPlanningModels.delete(turnId);
    this.turnFastModels.delete(turnId);
    this.turnCostRecorded.delete(turnId); // Retry starts fresh cost tracking
    this.successResultDispatched.delete(turnId); // Retry starts fresh result tracking
    this.upstreamActivityTimestamps.delete(turnId); // Retry starts fresh upstream tracking
    this.turnLastProgressAt.delete(turnId); // Retry starts fresh progress tracking
    // NOTE: Do NOT delete turnFallbacks - they represent real degradation events
    // from the same logical turn and must be preserved across retries.
    // NOTE: Do NOT delete retry count or input source - we're about to retry
    // NOTE: Do NOT delete approvalHandlersByTurn - the handler belongs to the logical turn
    // and these values won't be re-set by the IPC handler
    // NOTE: Do NOT delete turnRetryStartTimes - the wall-clock budget window
    // spans the entire retry sequence, not individual attempts
    this.notifyTurnCleanupListeners(turnId);
  }

  /**
   * Clean up all state associated with a turn.
   * Call this when a turn completes or errors.
   *
   * Security denials and tool calls are also cleaned here. The automation scheduler
   * reads and clears them before completeTurnCleanup runs, so this is a safety net
   * for interactive (non-automation) turns where the scheduler never runs.
   */
  cleanupTurn(turnId: string): void {
    // Clean up reverse session mapping
    const sessionId = this.rendererSessionByTurn.get(turnId);
    if (sessionId && this.activeTurnBySession.get(sessionId) === turnId) {
      this.activeTurnBySession.delete(sessionId);
    }
    this.turnLoggers.delete(turnId);
    this.rendererSessionByTurn.delete(turnId);
    const wasActive = this.activeTurnControllers.delete(turnId);
    const turnEndedListeners = this.turnEndedListeners.get(turnId);
    this.turnEndedListeners.delete(turnId);

    // Fire drain callbacks when the last active turn completes (transition from >0 to 0).
    // Uses queueMicrotask to batch after synchronous cleanup and allow
    // consumers to re-verify activeTurnCount before acting (TOCTOU safety).
    if (wasActive && this.activeTurnControllers.size === 0 && this.drainedCallbacks.length > 0) {
      const callbacks = this.drainedCallbacks.splice(0);
      for (const cb of callbacks) {
        queueMicrotask(cb);
      }
    }
    if (wasActive && this.activeTurnControllers.size === 0) {
      this.notifyTurnIdleStateChangeListeners();
    }
    if (turnEndedListeners && turnEndedListeners.size > 0) {
      for (const cb of turnEndedListeners) {
        queueMicrotask(cb);
      }
    }

    this.turnCloseCallbacks.delete(turnId);
    this.turnEventListeners.delete(turnId);
    this.turnEventSubscribers.delete(turnId);
    this.turnPrompts.delete(turnId);
    // Preserve the context accumulator when a user question is pending so the
    // continuation turn (after the user answers) can inject conversation history
    // from the accumulator instead of relying on stale/empty disk persistence.
    const preserveForUserQuestion = this.userQuestionPendingTurns.has(turnId);
    if (!preserveForUserQuestion) {
      this.turnContextAccumulators.delete(turnId);
      this.userQuestionProvenanceByTurn.delete(turnId);
    }
    this.contextOverflowDispatchedForTurn.delete(turnId);
    this.errorResultDispatchedForTurn.delete(turnId);
    this.actionableErrorDispatchedForTurn.delete(turnId);
    this.securityDenialsByTurn.delete(turnId);
    this.toolCallsByTurn.delete(turnId);
    this.turnModels.delete(turnId);
    this.turnExtendedContext.delete(turnId);
    this.turnContextWindows.delete(turnId);
    this.clearOutputCapRetryAttempted(turnId);
    this.turnRetryCounts.delete(turnId);
    this.turnRetryStartTimes.delete(turnId);
    this.turnPrivateModes.delete(turnId);
    this.turnCategories.delete(turnId);
    this.autoContinueCounts.delete(turnId);
    if (!preserveForUserQuestion) {
      this.userQuestionPendingTurns.delete(turnId);
    }
    this.turnInputSources.delete(turnId);
    this.approvalHandlersByTurn.delete(turnId);
    this.turnSpawnDelayed.delete(turnId);
    this.turnThinkingEfforts.delete(turnId);
    this.turnAuthMethods.delete(turnId);
    this.turnActiveProviders.delete(turnId);
    this.codexProfileDriftWarningTurns.delete(turnId);
    this.turnPlanningModels.delete(turnId);
    this.turnFastModels.delete(turnId);
    this.turnFallbacks.delete(turnId);
    this.turnCostRecorded.delete(turnId);
    this.successResultDispatched.delete(turnId);
    this.upstreamActivityTimestamps.delete(turnId);
    this.turnLastProgressAt.delete(turnId);
    this.turnRecoveredStallsMs.delete(turnId);
    // Clean up automation safety block counter for the session associated with this turn
    if (sessionId) {
      this.automationSafetyBlockCounts.delete(sessionId);
    }
    cleanupAutoContinueCache(turnId);
    this.notifyTurnCleanupListeners(turnId);
  }
}

// Singleton instance
export const agentTurnRegistry = new AgentTurnRegistryImpl();
