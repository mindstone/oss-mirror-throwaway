/**
 * Shared types for the `turnErrorRecovery` package.
 *
 * Extracted out of `turnErrorRecovery.ts` to break the type-level circular
 * import that arose once `restartSafetyGate.ts` (and future helper siblings
 * such as `errorClassification.ts`) needed to read `ErrorRecoveryContext`.
 *
 * `turnErrorRecovery.ts` re-exports `ErrorRecoveryContext` and
 * `TurnRetryOverrides` from here, so external consumers
 * (`turnCompletion.ts`, `turnPipeline.types.test.ts`) continue to import
 * from `@main/services/turnErrorRecovery` unchanged.
 *
 * No runtime values; type-only module.
 */

import type { EventWindow } from '@core/types';
import type {
  TurnParams,
  QueryRouterContext,
} from '@core/rebelCore/queryRouter';
import type { TurnSessionLogger } from '@core/logger';
import type {
  ProviderRoutePlan,
  ProviderRouteRuntimeContext,
} from '@core/rebelCore/providerRoutePlan';
import type {
  ProviderRouterTurnInput,
} from '@core/rebelCore/providerRouting';
import type {
  ProviderRouteDecision,
  RouteRebuildHint,
} from '@core/rebelCore/providerRouteDecision';
import type {
  ConfiguredRoleFallbackAttemptState,
} from '@core/rebelCore/configuredRoleFallback';
import type { AppSettings } from '@shared/types';
import type { ModelProfile } from '@shared/types/settings';
import type { resolveModelConfig } from '@shared/utils/modelNormalization';

/** Typed subset of executor turnOptions that error recovery handlers can pass to retryTurn(). */
export interface TurnRetryOverrides {
  resetConversation?: boolean;
  modelOverride?: string;
  thinkingModelOverride?: string;
  /** Empty string suppresses configured working profile use for this retry. */
  workingProfileOverrideId?: string;
  /** Empty string suppresses configured thinking profile use for this retry. */
  thinkingProfileOverrideId?: string;
  longContextFallbackAttempted?: boolean;
  rateLimitFallbackAttempted?: boolean;
  configuredRoleFallbackAttempted?: ConfiguredRoleFallbackAttemptState;
  activeProviderOverride?: import('@shared/types/settings').ActiveProvider;
  routeRebuildHint?: RouteRebuildHint;
  inFlightProviderRoutePlan?: ProviderRoutePlan;
  existingAbortController?: AbortController;
  /**
   * Stage 4b — multi-provider rate-limit failover guard.
   * Accumulates the credential sources that have already 429'd in this logical
   * turn (across retries). Distinct from `rateLimitFallbackAttempted` (the
   * Codex-waterfall boolean). JSON-serializable array.
   */
  rateLimitAttemptedCredentialSources?: import('@shared/types/providerRoute').ProviderCredentialSource[];
  /**
   * Stage 3 (provider-agnostic recovery "C") — multi-provider server/transient
   * failover guard. Accumulates the credential sources that have already failed
   * with a server/transient (alt-model-owned) error in this logical turn.
   * Deliberately SEPARATE from `rateLimitAttemptedCredentialSources`: server and
   * transient errors are NOT rate limits, so they must not write or read
   * rate-limit cooldown/telemetry state. JSON-serializable array.
   */
  serverTransientAttemptedCredentialSources?: import('@shared/types/providerRoute').ProviderCredentialSource[];
}

/**
 * All state the error recovery handlers need from the executor's scope.
 * Fields marked "mutable" are updated by handlers (e.g., error reassignment).
 */
export interface ErrorRecoveryContext {
  /** The caught error — mutable: handlers may reassign when a fallback itself fails. */
  error: unknown;

  // Turn infrastructure
  turnId: string;
  win: EventWindow | null;
  turnLogger: TurnSessionLogger;
  abortController: AbortController;
  settings: AppSettings;
  rendererSessionId: string | null;

  // Model state — mutable: handlers update on fallback
  modelConfig: ReturnType<typeof resolveModelConfig>;
  extendedContextEnabled: boolean;
  queryOptions: Omit<TurnParams, 'prompt'>;
  buildQueryOptions: (mc?: ReturnType<typeof resolveModelConfig>) => Omit<TurnParams, 'prompt'>;
  createPromptOrGenerator: (conversationContext?: string) => TurnParams['prompt'];
  routerContext: QueryRouterContext | undefined;
  thinkingModelOverride: string | undefined;
  plan: ProviderRoutePlan;
  routeInput: ProviderRouterTurnInput;
  routeRuntimeContextForDecision: (decision: ProviderRouteDecision) => ProviderRouteRuntimeContext;
  applyRoutePlan: (plan: ProviderRoutePlan) => void;

  // Direct role-profile / fallback state
  activeProfile: (ModelProfile & { id?: string }) | null | undefined;
  isDirectRoleProfile: boolean;
  altModelFallbackAttempted: boolean;
  /**
   * Set to true the moment any nested-fallback handler kicks off its inner
   * `runAgentQuery` (Max-200K, thinking-model, or alt-model Claude fallback).
   *
   * Those nested runs only forward `onApiOutput` (bumps `ctx.messageCount`) —
   * they do NOT update the outer `lastToolName`, `receivedResultMessage`, or
   * the watchdog's tool-in-flight state. So if a nested run uses a tool and
   * then 429s (rethrown), the outer ctx's hard safety gates are stale.
   *
   * Used by the rate-limit-source `messageCount` bypass in
   * `canAttemptConfiguredFallback` to refuse the bypass when nested activity
   * may have polluted state. The right long-term fix is to wire `onMessage`
   * into the nested calls; until then, fail-closed is the safe choice.
   */
  nestedFallbackQueryAttempted: boolean;
  thinkingProfile: ModelProfile | null;
  workingProfile: ModelProfile | null;
  availableProfiles: ModelProfile[];
  requestedModelForTurn: string;

  // Execution tracking
  messageCount: number;
  receivedResultMessage: boolean;
  lastMessageType: string | undefined;
  lastToolName: string | undefined;
  mcpMode: string | undefined;
  hasMedia: boolean;

  // Watchdog state
  abortedByWatchdog: boolean;
  /**
   * Stage 1a (260617_bricked-state-0448-electron42): true when the abort was the
   * interactive `awaiting_api` hard-stall ceiling. Sub-case of
   * `abortedByWatchdog`. `handleAbortErrors` uses it to emit the recognised
   * retryable `message_timeout` terminal instead of generic watchdog copy.
   */
  abortedByAwaitingApiStall: boolean;
  watchdogFired: boolean;
  watchdogFiredAt: number | undefined;
  maxWatchdogLevel: number;
  watchdogLevel: number;
  effectiveAbortMs: number;

  // Raw stream diagnostics (from agentTurnExecutor's rawStreamTracker)
  rawStreamEventCount: number;
  rawStreamLastEventType: string | null;
  rawStreamLastEventAgeMs: number | null;

  /** The computed resetConversation decision from the executor (may differ from turnOptions). */
  effectiveResetConversation: boolean;

  // Turn options (subset needed by handlers)
  turnOptions: {
    resetConversation?: boolean;
    modelOverride?: string;
    longContextFallbackAttempted?: boolean;
    rateLimitFallbackAttempted?: boolean;
    configuredRoleFallbackAttempted?: ConfiguredRoleFallbackAttemptState;
    /** Stage 4b — accumulated credential sources that have already 429'd this logical turn. */
    rateLimitAttemptedCredentialSources?: import('@shared/types/providerRoute').ProviderCredentialSource[];
    /** Stage 3 — accumulated credential sources that have already failed with a server/transient error this logical turn. */
    serverTransientAttemptedCredentialSources?: import('@shared/types/providerRoute').ProviderCredentialSource[];
  } | undefined;
  prompt: string;

  /** Callback for recursive retry — executor wires this to call executeAgentTurn. */
  retryTurn: (overrides?: TurnRetryOverrides) => Promise<void>;

  /** Returns the age in ms since the last upstream activity (raw SSE + registry).
   *  Passed through to runAgentQuery for activity-aware timeout re-arming. */
  getLastActivityAgeMs?: () => number;
  /** Returns the current per-turn message timeout ceiling (extended ceiling or default).
   *  F20: keeps Layer 1 (timeoutAsyncIterator) aligned with the watchdog (Layer 2)
   *  so Layer 1 never preempts the watchdog or LLM judge during a dynamic raise. */
  getMessageTimeoutMs?: () => number;

  /** Returns true while a tool (or subagent Task) is in flight. Wired from the
   *  watchdog (`watchdogTracker.toolInFlightSince`). Passed through to
   *  runAgentQuery so Layer 1 (timeoutAsyncIterator) does not fire MessageTimeoutError
   *  during long MCP tool calls. Defense-in-depth alongside the dynamic ceiling.
   *  See REBEL-1AF and docs/plans/260506_layer1_layer2_tool_in_flight_alignment.md. */
  isToolInFlight?: () => boolean;
}
