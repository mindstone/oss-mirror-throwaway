import type {
  AgentEvent,
  AgentSession,
  AgentTurnMessage,
  AgentTurnRequest,
  AppSettings,
  ThinkingEffort,
} from '@shared/types';
import type { TurnPolicy } from '@core/types/turnPolicy';
import { redactAndTruncateRawError } from '@core/utils/redactRawError';

import type { LongContextFallbackTarget } from './recoveryStateMachine';
import type { RecoveryOutboundEvent } from './recoveryEvents';

export interface TurnFallbackInfo {
  type: 'model' | 'profile';
  from: string;
  to: string;
  reason: 'context-overflow-long-context-fallback' | 'context-overflow-recovery-model';
}

export interface RecoveryProfile {
  id: string;
  name: string;
  model: string;
  supportsLargeContext?: boolean;
  rateLimited?: boolean;
}

export interface RecoverySettingsSlice {
  recoveryModelProfileId?: string | null;
}

export interface AgentLoopOptions {
  // Identity
  sessionId: string;
  resetConversation?: boolean;

  // Model & profile overrides (foreground + background)
  modelOverride?: string;
  thinkingModelOverride?: string;
  workingProfileOverrideId?: string;
  thinkingProfileOverrideId?: string;
  thinkingEffortOverride?: ThinkingEffort;

  // User-mode flags (foreground)
  privateMode?: boolean;
  unleashedMode?: boolean;
  councilMode?: boolean;
  /** User-set success criterion resolved at turn admission. See `docs/plans/260515_finish_line.md`. */
  finishLine?: string;
  /**
   * Internal headless/eval override for the watchdog streaming-stall ceiling.
   * Omitted for normal app turns; when present it is used as a floor for the
   * executor's dynamic watchdog timeout path without changing global constants.
   */
  watchdogCeilingMs?: number;

  // Attachments + context (foreground + cloud)
  attachments?: AgentTurnRequest['attachments'];
  loadSessions?: () => AgentSession[];
  getMeetingCompanionContext?: (sessionId: string) => Promise<{
    currentCoachPath: string | null;
    lastInjectedCoachPath: string | null | undefined;
    coachSkillContent?: string;
  } | null>;
  setLastInjectedCoachPath?: (sessionId: string, coachPath: string | null) => void;
  getFocusContext?: (sessionId: string, origin?: string) => Promise<string | null>;

  // Background safety hooks. These are surface-owned hook functions; core keeps
  // them opaque so recovery retries can preserve them without importing main.
  bypassToolSafety?: boolean;
  memoryWriteHook?: unknown;
  mcpDenyHook?: unknown;
  inboundSafetyHook?: unknown;

  // Session classification
  sessionType?: 'interactive' | 'automation' | string;
  /** Resolved policy object carried across retries; already derived at admission. */
  policy?: TurnPolicy;

  // Lifecycle
  existingAbortController?: AbortController;
  origin?: string;
  inputSource?: 'voice' | 'text';

  /**
   * Marks a turn that runs on a real desktop window but is NOT a user-initiated
   * interactive conversation turn (live-meeting coach proactive check). The
   * Chief-of-Staff admission gate keys off this so it never blocks / pops
   * recovery UI on a turn the user didn't initiate. See `turnAdmission.admit`
   * (260622 Stage 3).
   */
  nonInteractiveTurn?: boolean;
  /**
   * True when this turn is a system continuation (a tool/memory approval retry
   * dispatched by the app on the user's behalf, NOT a fresh user-typed message).
   * Threaded from `AgentTurnRequest.isSystemContinuation` so the Chief-of-Staff
   * admission gate does not block / pop recovery UI on a continuation the user
   * didn't initiate. See `turnAdmission.admit` (260622 Stage 3 refinement).
   */
  isSystemContinuation?: boolean;

  /**
   * Turn-scoped system-prompt prefix prepended to the resolved composite
   * system prompt. Populated by main process for the first turn of an
   * Operator personalisation conversation only — never persisted on the
   * session, never replayed on subsequent turns. The trusted source lives
   * in main-side `pendingPersonalisationPrefixes` and is validated at the
   * `agent:turn` IPC boundary; cloud-pushed broadcasts cannot inject one.
   */
  systemPromptPrefix?: string;

  // Active space — propagated to executor for space-aware operator routing.
  activeSpacePath?: string | null;

  // Executor-internal retry/routing fields. Kept here so recovery remains a
  // transparent wrapper around executeAgentTurn options.
  longContextFallbackAttempted?: boolean;
  rateLimitFallbackAttempted?: boolean;
  activeProviderOverride?: import('@shared/types/settings').ActiveProvider;
  routeRebuildHint?: unknown;
  inFlightProviderRoutePlan?: unknown;
  voiceActive?: boolean;

  // Free-form metadata for telemetry
  metadata?: Record<string, unknown>;

  // Recovery-owned message history for resetConversation retries. The surface
  // adapter/executor may use this to seed the next attempt without carrying
  // unsafe tool/thinking/image blocks across the reset boundary.
  recoveryMessages?: AgentTurnMessage[];

  /**
   * Stage 2 of `docs/plans/260525_cross_turn_awareness_layer1_layer2.md` (F3).
   * When set, an upstream accumulator (e.g. `userQuestionResponseHandler`)
   * already injected `<prior_turns>` + `<conversation_history>` into the
   * prompt; the executor must skip its proactive prepend.
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

export interface AgentLoopSuccessOutcome {
  kind: 'success';
  result?: string;
}

export interface AgentLoopOverflowOutcome {
  kind: 'overflow';
  originalPrompt?: string;
  messages?: AgentTurnMessage[];
  toolSuggestions?: Array<{ toolName: string; currentSize: number; suggestedLimit: number }>;
}

export interface AgentLoopErrorOutcome {
  kind: 'error_non_overflow';
  error: unknown;
  /**
   * Diagnostic fields lifted off the underlying `{ type: 'error' }` event by
   * the surface adapter (REBEL-5BM). Optional — present only for in-band error
   * events that carry classification; absent on the raw rejection path. Never
   * fabricated. `errorKind` is the structural `AgentErrorKind` (typed `string`
   * here to avoid coupling core to the catalog). `rawError` is already
   * redacted + 4 KB-capped by `dispatchAgentErrorEvent`.
   */
  errorKind?: string;
  provider?: string;
  rawError?: string;
}

export type AgentLoopOutcome =
  | AgentLoopSuccessOutcome
  | AgentLoopOverflowOutcome
  | AgentLoopErrorOutcome;

export interface ErrorContext {
  turnId: string;
  sessionId: string;
  depth: number;
  attempt: number;
  exhaustedReason?: string;
  phase?: string;
  /**
   * Diagnostic fields threaded from the failing agent-loop error event so the
   * known-condition capture carries the real underlying cause (REBEL-5BM).
   * Optional — omitted when absent (never fabricated).
   */
  errorKind?: string;
  provider?: string;
  rawError?: string;
}

// See docs/project/ARCHITECTURE_CONTEXT_OVERFLOW_RECOVERY.md — Intent & Design Rationale (REBEL-5BM).
/**
 * Normalized recovery error for known-condition capture (REBEL-5BM). The
 * pipeline resolves the failing agent-loop outcome with either a string
 * (in-band `event.error`) or an `Error` (the raw rejection path). Sentry's
 * `captureKnownCondition` 3rd arg is typed `Error`, and any raw string we put
 * into `extra` or into a synthesized `Error` must be redacted + truncated
 * first. This single helper is used by BOTH surface adapters so the
 * string-dropped-before-Sentry bug cannot recur per-site.
 */
export interface NormalizedRecoveryError {
  /**
   * Real `Error` for the capture's 3rd arg, or `undefined` when no usable
   * error form was supplied (callers then let `captureKnownCondition`
   * synthesize its own placeholder, preserving prior behaviour).
   */
  error: Error | undefined;
  /** Redacted + truncated error string for `extra.error`. Omitted when absent. */
  errorString?: string;
  errorKind?: string;
  provider?: string;
  rawError?: string;
}

export function normalizeRecoveryError(input: {
  error?: unknown;
  errorKind?: string;
  provider?: string;
  rawError?: string;
}): NormalizedRecoveryError {
  const { error, errorKind, provider, rawError } = input;
  // Redact `rawError` here too so the helper's contract is self-contained and
  // does not depend on the caller having pre-sanitized it (even though
  // `event.rawError` is already redacted + 4 KB-capped upstream by
  // `dispatchAgentErrorEvent` — double-redaction is idempotent/cheap).
  const redactedRawError = redactAndTruncateRawError(rawError);
  const diagnostics = {
    ...(errorKind ? { errorKind } : {}),
    ...(provider ? { provider } : {}),
    ...(redactedRawError ? { rawError: redactedRawError } : {}),
  };

  if (error instanceof Error) {
    const redactedMessage = redactAndTruncateRawError(error.message);
    // Build a REDACTED Error for the capture's 3rd arg. The original Error's
    // `.message` (and its stack's first line, which repeats the message) can
    // carry un-redacted content (e.g. a provider 4xx body with an API key in a
    // URL), so we must not hand the raw Error to `captureException`. Grouping is
    // unaffected — `captureKnownCondition` sets an explicit fingerprint.
    const safeError = new Error(redactedMessage ?? error.message);
    safeError.name = error.name;
    // Copy a redacted stack rather than reconstructing (which would lose the
    // real frames). The stack's first line repeats the message, so it must be
    // redacted too. Fall back to the freshly-constructed stack if absent.
    if (error.stack) {
      safeError.stack = redactAndTruncateRawError(error.stack) ?? safeError.stack;
    }
    return {
      error: safeError,
      ...(redactedMessage ? { errorString: redactedMessage } : {}),
      ...diagnostics,
    };
  }

  if (typeof error === 'string') {
    const redacted = redactAndTruncateRawError(error);
    return {
      // Redact BEFORE constructing the Error so no raw string leaks via the
      // synthesized Error's message either.
      error: new Error(redacted ?? error),
      ...(redacted ? { errorString: redacted } : {}),
      ...diagnostics,
    };
  }

  // Non-Error, non-string (e.g. a raw object): no usable error form. Return
  // `error: undefined` (callers let captureKnownCondition synthesize a
  // placeholder) and never stringify the raw object into `extra`.
  return {
    error: undefined,
    ...diagnostics,
  };
}

export interface SummaryOptions {
  settings: Pick<AppSettings, 'claude'> & Partial<AppSettings>;
  taskContext: string;
  depth: number;
}

export interface SkeletonOptions {
  originalPrompt: string;
  depth: number;
}

export interface RecoveryAdapter {
  recordFallback(turnId: string, fallback: TurnFallbackInfo): void;
  clearAccumulator(turnId: string): void;
  /**
   * Clear the desktop-renderer-IPC-only `answer_phase_started` barrier marker
   * sentinel for this turn. After a long-context fallback or recovery-model
   * retry the renderer must see a fresh `answer_phase_started` event on the
   * next answer phase so the thinking buffer is cleared at the correct
   * moment (R2-3, Stage 2 of the 260508 active-work CPU/GPU rebuild).
   *
   * Desktop adapter: clears `answerPhaseStartedTurnIds` (also folded into
   * `clearAccumulator` defensively).
   * Cloud adapter: no-op — cloud surface never emits the marker.
   * The renderer also runs an idempotent R2-5 fallback (`clearThinkingBuffer`
   * on the first `assistant` event of a turn) that covers the post-recovery
   * remount race where neither this clear nor the next marker reach the
   * renderer.
   */
  clearRendererBarrierMarker(turnId: string): void;
  dispatchEvent(turnId: string, event: RecoveryOutboundEvent): void;
  /** Forward a non-recovery event back to the caller's onEvent listener.
   * Used only for enableRecovery=false short-circuit paths so existing callers
   * (notably memory-update) keep their terminal-event semantics.
   *
   * The `event` param is narrowed to exclude `{ type: 'error' }` so a raw,
   * classification-blind error event can no longer be hand-built and pushed
   * through this seam (the F3-class bypass closed in Stage 1 of
   * docs/plans/260529_error-emit-funnel/PLAN.md). Error events MUST route
   * through `dispatchAgentErrorEvent` so they are classified
   * (errorKind / isTransient derived) by the funnel before they surface.
   * This mirrors the compile-time type-wall on `dispatchAgentEvent`. */
  forwardOriginalEvent(turnId: string, event: Exclude<AgentEvent, { type: 'error' }>): void;
  getSettings(): Pick<AppSettings, 'claude'> & Partial<AppSettings> & { recovery?: RecoverySettingsSlice };
  getAvailableProfiles(): ReadonlyArray<RecoveryProfile>;
  resolveLongContextFallbackTarget(): LongContextFallbackTarget | null;
  getRecoveryProfilePreference(): { profileId: string | null; configuredId: string | null };
  invokeAgentLoop(
    prompt: string,
    options: AgentLoopOptions,
    onEvent: (event: AgentEvent) => void,
  ): Promise<AgentLoopOutcome>;
  reportError(err: unknown, ctx: ErrorContext): void;
  /**
   * Stable-fingerprint capture for the recovery pipeline's terminal classes.
   * Mirrors the Stage 5 `captureKnownCondition` migration in
   * `src/main/services/turnErrorRecovery.ts`: the recovery pipeline is a
   * known-condition surface, so terminal failures route through the wrapper
   * instead of `reportError` to avoid Sentry grouping fragmentation.
   * `aborted` and `recovery_disabled` are deliberately not captured (they're
   * expected control-flow outcomes, not failures worth a fingerprint).
   */
  reportKnownCondition(
    condition:
      | 'recovery_pipeline_summary_generation_failed'
      | 'recovery_pipeline_agent_loop_error_before_recovery'
      | 'recovery_pipeline_agent_loop_error_after_recovery'
      | 'recovery_pipeline_long_context_fallback_failed'
      | 'recovery_pipeline_depth_limit_reached'
      | 'recovery_pipeline_attempt_limit_reached'
      | 'recovery_pipeline_no_qualifying_profile'
      | 'recovery_pipeline_rate_limited'
      | 'recovery_pipeline_no_messages_to_compact',
    ctx: ErrorContext & { error?: unknown },
  ): void;
  emitTelemetryCounter(
    counter: 'recovery_depth_4_invocation' | 'recovery_skipped' | 'recovery_terminal_failure',
    tags: Record<string, string | number>,
  ): void;
  /**
   * Returns true if the BTS-shared rate-limit cooldown is currently active for
   * the given recovery profile. Used by the pipeline to gate depth-4 attempts —
   * if the recovery model rides on the same shared rate-limit pool that already
   * tripped, we skip rather than fire a guaranteed-fail call. Per Stage 6 §RC9 +
   * F23 in `docs/plans/260503_unified_recovery_pipeline.md`.
   */
  isSharedCooldownActiveFor(profile: RecoveryProfile): boolean;
  /**
   * Emit a structured cost-estimate log line just before a depth-4 last-resort
   * recovery attempt fires. Lets on-call observe cost spikes without requiring
   * a full Posthog roundtrip. Per Stage 6 A2.H11 in
   * `docs/plans/260503_unified_recovery_pipeline.md`.
   */
  emitCostEstimate(payload: {
    model: string;
    profileId: string;
    estimatedCost: 'high';
    recoveryDepth: 4;
  }): void;
  generateIntelligentSummary(
    messages: AgentTurnMessage[],
    options: SummaryOptions,
  ): Promise<{ olderSummary: string | null; recentMessages: AgentTurnMessage[] }>;
  generateLegacyCompactionSummary(
    messages: AgentTurnMessage[],
    largeToolNames: string[],
  ): Promise<string | null>;
  buildSkeletonMessages(
    messages: AgentTurnMessage[],
    options: SkeletonOptions,
  ): AgentTurnMessage[];
}
