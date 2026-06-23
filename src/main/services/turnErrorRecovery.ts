/**
 * Turn Error Recovery — Named handler functions for the agent turn catch block.
 *
 * Extracted from the ~1,650-line catch block in agentTurnExecutor.ts.
 * Each handler:
 *   - Takes a shared ErrorRecoveryContext
 *   - Returns a typed `HandlerOutcome` discriminated union:
 *       - `kind: 'handled'`     — dispatched events + cleanup; dispatcher returns
 *       - `kind: 'passthrough'` — not my error (continue to next handler)
 *       - `kind: 'soft-failed'` — tried and failed (ctx.error reassigned, continue)
 *
 * The dispatcher (`dispatchErrorRecovery`) calls handlers in the same order
 * as the original catch block's if/else chain.
 *
 * See: docs/plans/260329_agent_turn_executor_hardening.md (Phase 3 § Stage 2)
 * See: docs/plans/260526_hotspot-refactor-roadmap/PLAN.md Stage 3 (HandlerOutcome refactor)
 */

import type {
  TurnParams,
} from '@core/rebelCore/queryRouter';
import {
  materializePlanRuntime,
  type ProviderRoutePlan,
} from '@core/rebelCore/providerRoutePlan';
import { isTerminalRoutePlan } from '@core/rebelCore/providerRoutePlanTypes';
import {
  forTurnWithFallback,
  type ProviderRouterTurnInput,
} from '@core/rebelCore/providerRouting';
import {
  buildRecoverableTerminalRouteError,
  isDispatchableDecision,
  isRecoverableTerminalReason,
  type ProviderCredentialSource,
  type ProviderRouteDecision,
  type RouteRebuildHint,
} from '@core/rebelCore/providerRouteDecision';
import {
  getModelRuntimeRoleMetadata,
  resolveConfiguredRoleFallback,
  toConfiguredFallbackRouteHintTarget,
  type ConfiguredFallbackRole,
  type ConfiguredRoleFallbackAttemptState,
} from '@core/rebelCore/configuredRoleFallback';
import {
  stripExtendedContextFromConfig,
  isExtendedContextUnavailableError,
  isThinkingModelUnavailableError,
  downgradeThinkingModelConfig,
  getModelDisplayName,
  ENV_THINKING_MODEL,
  FALLBACK_PLANNING_MODEL,
} from '@shared/utils/modelNormalization';
import {
  classifyBillingSubtype,
  humanizeProviderServerError,
  isTransientError,
  isRateLimitMessage,
  extractRetryAfterMs,
  isNetworkError,
} from '@shared/utils/friendlyErrors';
import { getErrorKind } from '@shared/utils/agentErrorCatalog';
import { ConnectionNotConfiguredError, UnsupportedModelError } from '@shared/utils/connectionCredentials';
import { isToolNameLengthError } from '@shared/utils/toolNameValidation';
import { completeTurnCleanup, makeSyntheticResult } from './agentTurnCleanup';
import { dispatchAwaitingApiTimeoutTerminal } from '@core/services/turnPipeline/awaitingApiTimeoutTerminal';
import { agentTurnRegistry } from './agentTurnRegistry';
import {
  clearAnswerPhaseStartedSentinel,
  dispatchAgentErrorEvent,
  dispatchAgentEvent,
} from './agentEventDispatcher';
import { getTurnCheckpointManager } from '@core/services/turnCheckpointService';
import { runAgentQuery } from './agentQueryRunner';
import { loadConversationHistory } from './conversationHistoryService';
import { getErrorReporter } from '@core/errorReporter';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
import { isEmptyResultAnomalyError } from '@shared/utils/emptyResultAnomalyError';
import {
  BOOKKEEPING_TOOL_NAMES,
  humanizeAgentError,
  humanizeStructuredOutputSchemaRejection,
  isStructuredOutputSchemaRejection,
} from '@rebel/shared';
import { isChatIncompatibilityError, isToolUseIncompatibilityError, ModelError } from '@core/rebelCore/modelErrors';
import { OFFLINE_FAIL_FAST_MESSAGE } from '@core/rebelCore/clients/offlineFailFast';
import { safeDispatchLearnedLimitsFromError } from '@core/rebelCore/dispatchLearnedLimitsFromError';
import { getSettings, updateSettings } from '@core/services/settingsStore';
import { apiRateLimitCooldown } from '@core/services/apiRateLimitCooldown';
import { providerRateLimitCooldowns } from '@core/services/providerRateLimitCooldowns';
import { getFailoverCredentialCandidates } from '@core/rebelCore/providerRouting';
import { delayWithAbort } from '@core/utils/delayWithAbort';
import { getRateLimitFallbackTarget } from '@core/utils/authEnvUtils';
import { resolveModelLimits } from '@core/rebelCore/modelLimits';
import {
  getApiKey,
  getContextOverflowFallbackModel,
  getContextOverflowFallbackProfileId,
  getThinkingFallback,
} from '@core/rebelCore/settingsAccessors';
import {
  ownerForRecoveryKind,
  type RecoveryOwner,
} from '@core/services/turnErrorRecoveryOwnership';

import { updateLastApiCallTime } from './promptCacheWarmupService';
import { diagnoseTimeout, type TimeoutDiagnosticResult } from '@core/services/timeoutDiagnosticsService';
import {
  getErrorMessage,
  getErrorName,
  getRawErrorMessage,
  getErrorProvider,
} from '../utils/agentTurnUtils';
import { mainTracking } from '../tracking';
import { getRebelAuthProvider } from '@core/rebelAuth';
import {
  type HandlerOutcome,
  handled,
  passthrough,
  softFailed,
} from './turnErrorRecovery/handlerOutcome';
import {
  restartSafetyGate,
  type RestartSafetyGateResult,
  type RestartSafetyGateSource,
} from './turnErrorRecovery/restartSafetyGate';
import { classifyError } from './turnErrorRecovery/errorClassification';

export type { HandlerOutcome } from './turnErrorRecovery/handlerOutcome';


// ---------------------------------------------------------------------------
// Constants — imported from watchdogTracker (single source of truth)
// ---------------------------------------------------------------------------

import { AUTO_ABORT_MS, inferWatchdogPhase } from './watchdogTracker';

import { getDefaultModelForProvider } from '@shared/utils/getDefaultModelForProvider';
import {
  emitTurnFallbackTelemetry,
  deriveCredentialStateFromSettings,
} from '@shared/utils/emitFallbackTelemetry';
import type {
  FallbackTelemetryAuth,
  FallbackTelemetryProvider,
} from '@shared/types/fallbackTelemetry';


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LongContextFallbackTarget =
  | { kind: 'profile'; profileId: string; profileName: string; modelName: string }
  | { kind: 'model'; modelName: string };

export function roleFromDecisionRole(
  decisionRole?: 'execution' | 'planning' | 'bts' | 'subagent',
): 'working' | 'thinking' | 'background' {
  switch (decisionRole) {
    case 'planning':
      return 'thinking';
    case 'bts':
      return 'background';
    case 'execution':
    case 'subagent':
      return 'working';
    case undefined:
      return 'background';
    default: {
      const _exhaustive: never = decisionRole;
      void _exhaustive;
      return 'background';
    }
  }
}

const MAX_EXPECTED_TIMEOUT_SENTRY_KEYS = 500;
const SUBSCRIPTION_RATE_LIMIT_WINDOW_THRESHOLD_MS = 60 * 60 * 1000;
const reportedExpectedTimeoutSentryKeys = new Set<string>();

function getExpectedTimeoutSentryKey(ctx: ErrorRecoveryContext, category: string): string {
  const sessionId = ctx.rendererSessionId ?? agentTurnRegistry.getRendererSession(ctx.turnId) ?? ctx.turnId;
  return `${sessionId}:${category}`;
}

function shouldCaptureExpectedTimeoutToSentry(ctx: ErrorRecoveryContext, category: string): boolean {
  const key = getExpectedTimeoutSentryKey(ctx, category);
  if (reportedExpectedTimeoutSentryKeys.has(key)) {
    return false;
  }

  if (reportedExpectedTimeoutSentryKeys.size >= MAX_EXPECTED_TIMEOUT_SENTRY_KEYS) {
    reportedExpectedTimeoutSentryKeys.clear();
  }

  reportedExpectedTimeoutSentryKeys.add(key);
  return true;
}

// `ErrorRecoveryContext` and `TurnRetryOverrides` are defined in
// `./turnErrorRecovery/types` so helper sibling files (restartSafetyGate,
// errorClassification) can import the context shape without producing a
// circular dep with this orchestrator file. Re-exported here for back-compat
// with external consumers (`turnCompletion.ts`, `turnPipeline.types.test.ts`).
export type { ErrorRecoveryContext, TurnRetryOverrides } from './turnErrorRecovery/types';
import type { ErrorRecoveryContext, TurnRetryOverrides } from './turnErrorRecovery/types';

/**
 * Max same-model fast retries before falling back. Shared by both the legacy
 * Anthropic-framed `handleAltModelFallback` and the flag-gated
 * `handleProviderChainRecoveryFallback` (Stage 3) so the fast-retry budget is
 * identical across both paths (the new handler must not double-count retries
 * relative to the legacy path).
 */
const ALT_MODEL_MAX_RETRIES = 1;

// ---------------------------------------------------------------------------
// Pure helpers (duplicated from executor scope — tiny, not worth a shared import)
// ---------------------------------------------------------------------------

// inferWatchdogPhase is now imported from watchdogTracker.ts (single source of truth)

// Narrows `ctx.error: unknown` to `Error | undefined` for the
// `captureKnownCondition(condition, context, error?: Error)` contract.
// Non-Error throwables (strings, plain objects) become undefined; the
// structured tags/extras still carry the diagnostic payload.
function errorOrUndefined(err: unknown): Error | undefined {
  return err instanceof Error ? err : undefined;
}

async function rebuildFallbackRoutePlan(
  ctx: ErrorRecoveryContext,
  fallbackHint: RouteRebuildHint,
  inputOverrides: Partial<ProviderRouterTurnInput> = {},
): Promise<ProviderRoutePlan> {
  const fallbackInput: ProviderRouterTurnInput = {
    ...ctx.routeInput,
    ...inputOverrides,
    settings: inputOverrides.settings ?? ctx.routeInput.settings,
  };
  const decision = forTurnWithFallback(fallbackInput, fallbackHint, ctx.plan);
  const plan = await materializePlanRuntime(
    decision,
    ctx.routeRuntimeContextForDecision(decision),
  );
  ctx.plan = plan;
  ctx.applyRoutePlan(plan);
  return plan;
}

function configuredRoleFromDecisionRole(
  decisionRole: ProviderRouteDecision['role'] | ProviderRouterTurnInput['role'] | undefined,
): ConfiguredFallbackRole {
  switch (decisionRole) {
    case 'planning':
      return 'thinking';
    case 'execution':
    case 'subagent':
      return 'working';
    case 'bts':
      return 'background';
    case undefined:
      return 'working';
    default: {
      const exhaustive: never = decisionRole;
      void exhaustive;
      return 'working';
    }
  }
}

function resolveConfiguredFallbackRole(ctx: ErrorRecoveryContext): ConfiguredFallbackRole {
  const metadata = getModelRuntimeRoleMetadata(ctx.error);
  if (metadata?.role) return metadata.role;
  return configuredRoleFromDecisionRole(
    ctx.plan?.decision?.role ?? ctx.routeInput?.role,
  );
}

function resolveConfiguredFallbackCurrentTarget(
  ctx: ErrorRecoveryContext,
  role: ConfiguredFallbackRole,
  failedModel?: string,
): { model: string | null; profileId: string | null } {
  switch (role) {
    case 'thinking':
      return {
        model: failedModel
          ?? ctx.thinkingModelOverride
          ?? (ctx.modelConfig.envOverrides?.[ENV_THINKING_MODEL] as string | undefined)
          ?? null,
        profileId: ctx.thinkingProfile?.id ?? null,
      };
    case 'working':
      return {
        model: failedModel
          ?? ctx.requestedModelForTurn
          ?? ctx.plan?.decision?.wireModelId
          ?? null,
        profileId: ctx.workingProfile?.id ?? ctx.plan?.decision?.profileId ?? null,
      };
    case 'background':
      return {
        model: failedModel ?? null,
        profileId: null,
      };
    default: {
      const exhaustive: never = role;
      return exhaustive;
    }
  }
}

function resolveConfiguredFallbackFailedModel(
  ctx: ErrorRecoveryContext,
  role: ConfiguredFallbackRole,
): string | undefined {
  const metadata = getModelRuntimeRoleMetadata(ctx.error);
  if (metadata?.model) return metadata.model;
  if (role === 'thinking') {
    return ctx.thinkingModelOverride
      ?? (ctx.modelConfig.envOverrides?.[ENV_THINKING_MODEL] as string | undefined)
      ?? undefined;
  }
  return ctx.plan?.decision?.wireModelId ?? ctx.requestedModelForTurn ?? undefined;
}

async function previewFallbackRoutePlan(
  ctx: ErrorRecoveryContext,
  fallbackHint: RouteRebuildHint,
): Promise<ProviderRoutePlan> {
  const decision = forTurnWithFallback(ctx.routeInput, fallbackHint, ctx.plan);
  return materializePlanRuntime(
    decision,
    ctx.routeRuntimeContextForDecision(decision),
  );
}

type ConfiguredFallbackSource =
  | 'model-unavailable'
  | 'alt-model-fallback'
  | 'server-error-retry'
  | 'rate-limit';

/**
 * Restart-safety gate for configured-role fallback.
 *
 * The gate normally refuses to fall back once the current turn has emitted any
 * real API output, because retrying mid-turn can produce duplicated assistant
 * text or repeated tool calls (see
 * `docs-private/postmortems/260427_outer_retry_guard_system_init_and_fallback_activity_postmortem.md`).
 *
 * Rate-limit fallback gets a narrow exception: when a provider 429s mid-stream,
 * the user otherwise sees a hard error with no recovery path. We accept the
 * (small) duplicate-delta risk in exchange for resilience, BUT only when:
 *   1. `source === 'rate-limit'`, AND
 *   2. no nested-fallback `runAgentQuery` has run earlier in this same outer
 *      turn (`!nestedFallbackQueryAttempted`). Nested runs forward
 *      `onApiOutput` to bump `messageCount` but do NOT propagate
 *      `lastToolName` / `receivedResultMessage` / the watchdog tool tracker,
 *      so the outer ctx's hard gates would be stale and could miss a tool
 *      execution. Fail-closed.
 *
 * The harder gates (`receivedResultMessage`, `isToolInFlight`, `lastToolName`,
 * `aborted`) still apply unconditionally — retrying after a result has finished,
 * after a tool has executed, or while a tool is in flight produces user-visible
 * breakage (duplicate replies, repeated side-effecting tool calls).
 */
function canAttemptConfiguredFallback(
  ctx: ErrorRecoveryContext,
  options?: { source?: ConfiguredFallbackSource },
): RestartSafetyGateResult {
  const source: RestartSafetyGateSource = {
    kind: 'configured-fallback',
    via: options?.source ?? 'model-unavailable',
  };
  return restartSafetyGate(ctx, source);
}

async function handleConfiguredRoleFallback(
  ctx: ErrorRecoveryContext,
  options: {
    allowRateLimit: boolean;
    source: ConfiguredFallbackSource;
    recoveryOwner: RecoveryOwner;
  },
): Promise<HandlerOutcome> {
  const safetyGate = canAttemptConfiguredFallback(ctx, { source: options.source });
  if (!safetyGate.ok) {
    ctx.turnLogger.info(
      {
        source: options.source,
        reason: safetyGate.reason,
        messageCount: ctx.messageCount,
        receivedResultMessage: ctx.receivedResultMessage,
        lastToolName: ctx.lastToolName,
        nestedFallbackQueryAttempted: ctx.nestedFallbackQueryAttempted,
        errorKind: getErrorKind(ctx.error),
      },
      'Configured role fallback skipped by restart-safety gate',
    );
    return passthrough(`configured-role-fallback-skipped:${safetyGate.reason}`);
  }
  if (options.source === 'rate-limit' && ctx.messageCount > 0) {
    ctx.turnLogger.info(
      {
        source: options.source,
        messageCount: ctx.messageCount,
        errorKind: getErrorKind(ctx.error),
      },
      'Configured role fallback bypassing message-count gate for rate-limit retry',
    );
  }

  const role = resolveConfiguredFallbackRole(ctx);
  if (role === 'background') {
    return passthrough('configured-role-fallback-skipped:role-background');
  }

  const failedModel = resolveConfiguredFallbackFailedModel(ctx, role);
  const currentTarget = resolveConfiguredFallbackCurrentTarget(ctx, role, failedModel);
  const configuredDecision = resolveConfiguredRoleFallback({
    role,
    settings: ctx.settings,
    availableProfiles: ctx.availableProfiles,
    attempted: ctx.turnOptions?.configuredRoleFallbackAttempted?.[role] === true,
    errorKind: getErrorKind(ctx.error),
    errorMessage: getErrorMessage(ctx.error),
    allowRateLimit: options.allowRateLimit,
    currentModel: currentTarget.model,
    currentProfileId: currentTarget.profileId,
  });

  if (configuredDecision.kind !== 'use_fallback') {
    ctx.turnLogger.info(
      {
        source: options.source,
        role,
        reason: configuredDecision.reason,
      },
      'Configured role fallback not applied',
    );
    return passthrough(`configured-role-fallback-not-applied:${configuredDecision.reason}`);
  }

  const fallbackHint: RouteRebuildHint = {
    kind: 'configured-role-fallback',
    role,
    target: toConfiguredFallbackRouteHintTarget(configuredDecision.target),
    ...(failedModel ? { failedModel } : {}),
    ...(getErrorKind(ctx.error) ? { errorKind: getErrorKind(ctx.error) } : {}),
  };

  let previewPlan: ProviderRoutePlan;
  try {
    previewPlan = await previewFallbackRoutePlan(ctx, fallbackHint);
  } catch (previewError) {
    ctx.turnLogger.warn(
      {
        source: options.source,
        role,
        err: previewError,
      },
      'Configured role fallback preview failed — skipping',
    );
    return softFailed({
      activityEmitted: false,
      proofOfObservability: { logged: true, structured: true },
    });
  }

  if (isTerminalRoutePlan(previewPlan)) {
    // FOX-3494 (round-2 F1/F3): build the terminal error through the SAME shared
    // mapper as clientFactory / agentTurnExecute so a recoverable fallback target
    // (e.g. a configured `claude-*` fallback under connected ChatGPT Pro with no
    // Anthropic key) carries the structured detail { invalidReason, wireModel,
    // failedRole }. The dispatcher reads those off the raw error to offer the
    // role-aware "switch to a GPT model" recovery; minting a bare
    // ConnectionNotConfiguredError here silently dropped that detail.
    let terminalError: ConnectionNotConfiguredError | UnsupportedModelError;
    let terminalMessage: { message: string; provider: string };
    if (isRecoverableTerminalReason(previewPlan.decision.invalidReason)) {
      terminalError = buildRecoverableTerminalRouteError(previewPlan.decision);
      // Use the error's display-name provider + message (via
      // buildTerminalReconnectMessage inside the mapper), preserving the prior
      // human-facing provider label (e.g. "OpenRouter", not "openrouter").
      terminalMessage = {
        provider: terminalError.provider ?? previewPlan.decision.provider,
        message: terminalError.message,
      };
    } else {
      // Non-recoverable reason (e.g. proxy-dialect) — keep the prior bare,
      // descriptive terminal; no actionable switch-to-GPT recovery applies.
      terminalMessage = {
        provider: previewPlan.decision.provider,
        message: `Fallback model "${previewPlan.decision.wireModelId}" cannot be used with the current provider settings.`,
      };
      terminalError = new ConnectionNotConfiguredError(
        terminalMessage.message,
        terminalMessage.provider,
      );
    }
    ctx.turnLogger.warn(
      {
        source: options.source,
        role,
        fallbackInvalidReason: previewPlan.decision.invalidReason,
        fallbackTransport: previewPlan.decision.transport,
      },
      'Configured role fallback resolved to terminal route — failing closed',
    );
    dispatchRecoveryErrorEvent(
      ctx,
      terminalError,
      {
        // The recovery ACTIONS (e.g. switch-to-GPT) come from classifyErrorUx,
        // which reads the structured detail off `terminalError` — unaffected by
        // these overrides. humanizedOverride only sets the displayed body copy;
        // keep the terminal message so non-classified surfaces stay unchanged.
        humanizedOverride: terminalMessage.message,
        providerOverride: terminalMessage.provider,
        recoveryOwner: options.recoveryOwner,
      },
    );
    completeTurnCleanup(ctx.turnId, 'connection-not-configured');
    return handled({
      activityEmitted: true,
      proofOfObservability: { logged: true, structured: true },
    });
  }

  const fallbackAttempted: ConfiguredRoleFallbackAttemptState = {
    ...(ctx.turnOptions?.configuredRoleFallbackAttempted ?? {}),
    [role]: true,
  };

  const retryOverrides: TurnRetryOverrides = {
    configuredRoleFallbackAttempted: fallbackAttempted,
    routeRebuildHint: fallbackHint,
    inFlightProviderRoutePlan: ctx.plan,
  };

  if (role === 'working') {
    if (configuredDecision.target.kind === 'model') {
      retryOverrides.modelOverride = configuredDecision.target.model;
      retryOverrides.workingProfileOverrideId = '';
    } else {
      retryOverrides.modelOverride = undefined;
      retryOverrides.workingProfileOverrideId = configuredDecision.target.profileId;
    }
  } else {
    retryOverrides.thinkingModelOverride = '';
    retryOverrides.thinkingProfileOverrideId = undefined;
    if (configuredDecision.target.kind === 'model') {
      retryOverrides.modelOverride = configuredDecision.target.model;
      retryOverrides.workingProfileOverrideId = '';
    } else {
      retryOverrides.modelOverride = undefined;
      retryOverrides.workingProfileOverrideId = configuredDecision.target.profileId;
    }
    ctx.turnLogger.info(
      {
        source: options.source,
        role,
        fallbackTarget: configuredDecision.target.encoded,
      },
      'Configured thinking fallback will retry in explicit single-model mode',
    );
  }

  agentTurnRegistry.addTurnFallback(ctx.turnId, {
    type: 'model',
    from: failedModel ?? 'unknown',
    to: configuredDecision.target.encoded,
    reason: `configured-role-fallback:${role}`,
  });

  dispatchAgentEvent(ctx.win, ctx.turnId, {
    type: 'status',
    message: role === 'thinking'
      ? 'Planner had provider trouble — trying your fallback model.'
      : 'The model hit provider trouble — trying your fallback model.',
    timestamp: Date.now(),
  });

  await ctx.retryTurn(retryOverrides);
  return handled({
    activityEmitted: true,
    proofOfObservability: { logged: true, structured: true },
  });
}

function getOutputCapFromError(error: unknown): number | null {
  if (!(error instanceof ModelError)) return null;
  const outputCap = error.details?.outputCap;
  if (typeof outputCap !== 'number' || !Number.isFinite(outputCap)) return null;
  const normalized = Math.floor(outputCap);
  return normalized > 0 ? normalized : null;
}

function buildOutputCapRetryKey(turnId: string, model: string, profileId: string | null): string {
  return `${turnId}|${model}|${profileId ?? 'no-profile'}`;
}

function resolveCurrentMessageTimeoutMs(ctx: ErrorRecoveryContext): number {
  const timeoutMs = ctx.getMessageTimeoutMs?.();
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : AUTO_ABORT_MS;
}

function mapBillingSubtypeForTracking(
  s: ReturnType<typeof classifyBillingSubtype>,
): 'allowance' | 'spend_cap' {
  if (s === 'key_limit' || s === 'spend_limit') return 'spend_cap';
  return 'allowance';
}

function isCodexUsageLimitBillingError(error: unknown): boolean {
  const message = getRawErrorMessage(error) || getErrorMessage(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes('usage_limit_reached')
    || normalized.includes('usage limit')
  );
}

function hasFarOutSubscriptionResetWindow(resetAtMs: number | undefined): boolean {
  if (typeof resetAtMs !== 'number' || !Number.isFinite(resetAtMs)) {
    return false;
  }
  return (resetAtMs - Date.now()) > SUBSCRIPTION_RATE_LIMIT_WINDOW_THRESHOLD_MS;
}

type DispatchRecoveryErrorOptions = Parameters<typeof dispatchAgentErrorEvent>[3];

function dispatchRecoveryErrorEvent(
  ctx: ErrorRecoveryContext,
  rawError: unknown,
  opts?: DispatchRecoveryErrorOptions,
): ReturnType<typeof dispatchAgentErrorEvent> {
  return dispatchAgentErrorEvent(ctx.win, ctx.turnId, rawError, {
    ...opts,
    credentialSource: opts?.credentialSource ?? ctx.plan.decision.credentialSource,
  });
}

// Activity-tracking note: fallback `runAgentQuery()` calls below pass an
// `onApiOutput` callback that bumps `ctx.messageCount`. The runner itself
// filters synthetic system:* messages via `isApiOutputMessage`, so callers
// just need to increment. Downstream recovery handlers gate retry on
// `ctx.messageCount === 0` to avoid duplicating output. The runner's required
// `onApiOutput` field makes it impossible to forget this wiring — see
// docs-private/postmortems/260427_outer_retry_guard_*.md for the bug class this
// structurally prevents.


// ---------------------------------------------------------------------------
// Handler 1: Abort Errors
// ---------------------------------------------------------------------------

/**
 * Handle watchdog abort, user abort, and upstream (proxy) abort.
 *
 * - Watchdog/user/superseded abort: dispatch events, return `passthrough` —
 *   final cleanup is run by the dispatcher's terminal aborted-state gate
 *   (deliberate split: cleanup-reason discrimination lives in dispatcher).
 * - Upstream abort: dispatch events + completeTurnCleanup, return `handled`.
 */
export function handleAbortErrors(ctx: ErrorRecoveryContext): HandlerOutcome {
  const { error, abortController, abortedByWatchdog, abortedByAwaitingApiStall, turnLogger, win, turnId } = ctx;

  const isControllerAborted = abortController.signal.aborted;
  const isAbortError = getErrorName(error) === 'AbortError';
  const isSuperseded = isControllerAborted && abortController.signal.reason === 'superseded';
  const isUserAbort = isControllerAborted && !abortedByWatchdog && !isSuperseded;
  const isUpstreamAbort = isAbortError && !isControllerAborted;

  if ((isAbortError || isControllerAborted) && abortedByWatchdog && abortedByAwaitingApiStall) {
    // Stage 1a (260617_bricked-state-0448-electron42): the interactive
    // `awaiting_api` hard-stall ceiling tripped, then the turn surfaced here as
    // an AbortError (timeoutAsyncIterator's grace-timeout throw after
    // signal.aborted) rather than via the normal post-loop terminal. This path
    // MUST emit the SAME recognised retryable `message_timeout` terminal as the
    // post-loop branch — otherwise the user gets generic watchdog copy with no
    // "Try again", defeating the whole point of Stage 1a. Shared helper =
    // single source of truth across both exit paths.
    const effectiveAbortMs = ctx.effectiveAbortMs > 0 ? ctx.effectiveAbortMs : AUTO_ABORT_MS;
    const autoAbortMinutes = Math.round(effectiveAbortMs / 60_000);
    const awaitingApiTimeoutCopy = `This turn was unresponsive for ${autoAbortMinutes} minutes and was stopped automatically. You can try sending your message again.`;
    turnLogger.info('Agent turn awaiting_api hard stall (caught as AbortError) — emitting retryable message_timeout terminal');
    dispatchAwaitingApiTimeoutTerminal({
      humanizedOverride: awaitingApiTimeoutCopy,
      watchdogDiagnostic: {
        phase: inferWatchdogPhase(ctx.lastMessageType),
        messageCount: ctx.messageCount,
        rawStreamEventCount: ctx.rawStreamEventCount,
        rawStreamLastEventType: ctx.rawStreamLastEventType,
        rawStreamLastEventAgeMs: ctx.rawStreamLastEventAgeMs,
        watchdogLevel: ctx.watchdogLevel,
        maxWatchdogLevel: ctx.maxWatchdogLevel,
        effectiveAbortMs: ctx.effectiveAbortMs,
        model: ctx.requestedModelForTurn,
      },
      dispatchError: (err, options) => dispatchRecoveryErrorEvent(ctx, err, options),
      dispatchSyntheticErrorResult: () => dispatchAgentEvent(win, turnId, makeSyntheticResult(turnId, '', 'error')),
    });
    // Events dispatched; dispatcher's aborted-state gate runs cleanup with reason 'watchdog-aborted'.
    return passthrough('abort-events-dispatched-awaiting-api-stall-cleanup-deferred-to-dispatcher');
  } else if ((isAbortError || isControllerAborted) && abortedByWatchdog) {
    // Watchdog auto-abort. Use the effective abort threshold (which may
    // include any judge-granted extension) so the copy reflects how long the
    // turn actually had before being stopped — not the static 30-min default.
    const effectiveAbortMs = ctx.effectiveAbortMs > 0 ? ctx.effectiveAbortMs : AUTO_ABORT_MS;
    const autoAbortMinutes = Math.round(effectiveAbortMs / 60_000);
    const autoAbortCopy = `This turn was unresponsive for ${autoAbortMinutes} minutes and was stopped automatically. You can try sending your message again.`;
    turnLogger.info('Agent turn auto-aborted by watchdog (caught as AbortError)');
    dispatchRecoveryErrorEvent(ctx, new Error(autoAbortCopy), {
      humanizedOverride: autoAbortCopy,
      watchdogDiagnostic: {
        phase: inferWatchdogPhase(ctx.lastMessageType),
        messageCount: ctx.messageCount,
        rawStreamEventCount: ctx.rawStreamEventCount,
        rawStreamLastEventType: ctx.rawStreamLastEventType,
        rawStreamLastEventAgeMs: ctx.rawStreamLastEventAgeMs,
        watchdogLevel: ctx.watchdogLevel,
        maxWatchdogLevel: ctx.maxWatchdogLevel,
        effectiveAbortMs: ctx.effectiveAbortMs,
        model: ctx.requestedModelForTurn,
      },
    });
    dispatchAgentEvent(win, turnId, makeSyntheticResult(turnId, '', 'error'));
    // Events dispatched; dispatcher's aborted-state gate runs cleanup with reason 'watchdog-aborted'.
    return passthrough('abort-events-dispatched-watchdog-cleanup-deferred-to-dispatcher');
  } else if (isSuperseded) {
    turnLogger.info('Agent turn superseded by newer turn on same session');
    dispatchAgentEvent(win, turnId, makeSyntheticResult(turnId, '', 'superseded'));
    // Events dispatched; dispatcher's aborted-state gate runs cleanup with reason 'aborted'.
    return passthrough('abort-events-dispatched-superseded-cleanup-deferred-to-dispatcher');
  } else if (isUserAbort) {
    turnLogger.info('Agent turn cancelled by user');
    dispatchAgentEvent(win, turnId, {
      type: 'status',
      message: 'Agent turn stopped by user',
      timestamp: Date.now(),
    });
    dispatchAgentEvent(win, turnId, makeSyntheticResult(turnId, '', 'user_stopped'));
    // Events dispatched; dispatcher's aborted-state gate runs cleanup with reason 'aborted'.
    return passthrough('abort-events-dispatched-user-cleanup-deferred-to-dispatcher');
  } else if (isUpstreamAbort) {
    const upstreamAbortCopy = 'The AI took too long to respond. Your message is safe — try sending it again.';
    turnLogger.warn({ err: error }, 'Upstream model request aborted unexpectedly');
    dispatchRecoveryErrorEvent(ctx, new Error(upstreamAbortCopy), {
      humanizedOverride: upstreamAbortCopy,
      isTransient: true,
    });
    dispatchAgentEvent(win, turnId, makeSyntheticResult(turnId, '', 'error'));
    completeTurnCleanup(turnId, 'upstream-abort');
    return handled({
      activityEmitted: true,
      proofOfObservability: { logged: true, structured: true },
    });
  }

  return passthrough('no-abort-error-detected');
}


// ---------------------------------------------------------------------------
// Handler 1.5: Tool Input Too Large (streaming cap breach)
// ---------------------------------------------------------------------------

/**
 * Handle `ModelError.kind === 'tool_input_too_large'` — the per-tool_use
 * byte cap in the stream loop fired. This is non-transient: auto-retry
 * would re-run the same model on the same inputs and immediately hit the
 * same cap. The user-facing copy picks between two variants depending on
 * whether prior tools in this turn may have mutated external state (so we
 * warn the user to review before retrying).
 *
 * See docs/plans/260423_agent_to_tool_file_ref_sentinel.md § Stage 2.
 */
export function handleToolInputTooLarge(ctx: ErrorRecoveryContext): HandlerOutcome {
  if (!(ctx.error instanceof ModelError) || ctx.error.kind !== 'tool_input_too_large') {
    return passthrough('not-tool-input-too-large');
  }

  const { turnId, win, turnLogger, error } = ctx;

  const details = (error.details ?? {}) as {
    toolName?: string;
    bytesAccumulated?: number;
    capBytes?: number;
  };
  const toolName = typeof details.toolName === 'string' ? details.toolName : 'a tool';
  const bytesAccumulated = typeof details.bytesAccumulated === 'number' ? details.bytesAccumulated : undefined;
  const capBytes = typeof details.capBytes === 'number' ? details.capBytes : undefined;

  // Query the accumulator to decide between cautious vs. safe-retry copy.
  // The accumulator is the same one that was populated throughout this turn.
  const accumulator = agentTurnRegistry.getOrCreateAccumulator(turnId);
  const possiblyMutated = accumulator.hasPossiblyMutatingToolCall();
  const priorToolCount = accumulator.getExecutedToolCalls().length;

  const sizeHint = bytesAccumulated !== undefined && capBytes !== undefined
    ? ` (${(bytesAccumulated / 1024).toFixed(1)} KiB exceeded the ${(capBytes / 1024).toFixed(0)} KiB cap)`
    : '';

  // Wave-1 copy: deliberately does NOT mention the `$rebel_file` sentinel —
  // that capability ships in the Wave-2 follow-up plan. Keep the user-facing
  // guidance actionable with just the tools available today.
  const humanizedCopy = possiblyMutated
    ? `The tool call to ${toolName} was too large to send${sizeHint}. Earlier steps in this turn may have already changed data — please review what was done before retrying. If the input contains a large file, try attaching a smaller one or splitting the content across multiple messages.`
    : `The tool call to ${toolName} was too large to send${sizeHint}. Try attaching a smaller file or splitting the content across multiple messages.`;

  turnLogger.warn(
    {
      toolName,
      bytesAccumulated,
      capBytes,
      priorToolCount,
      possiblyMutated,
    },
    'tool_input_too_large — dispatching recovery error to user',
  );

  dispatchRecoveryErrorEvent(ctx, error, {
    humanizedOverride: humanizedCopy,
    // Not transient — retrying with the same input will hit the cap again.
    isTransient: false,
    // Not an actionable billing/auth error; the user does not need to change settings.
    markActionable: false,
  });
  dispatchAgentEvent(win, turnId, makeSyntheticResult(turnId, '', 'error'));

  captureKnownCondition(
    'recovery_tool_input_too_large',
    {
      toolName,
      possiblyMutated,
      tags: {
        tool_input_too_large: true,
        tool_name: toolName,
        possibly_mutated: possiblyMutated,
      },
      extra: {
        bytesAccumulated,
        capBytes,
        priorToolCount,
      },
    },
    error,
  );

  completeTurnCleanup(turnId, 'tool-input-too-large');
  return handled({
    activityEmitted: true,
    proofOfObservability: { logged: true, structured: true },
  });
}


/**
 * Handle the fail-fast-offline terminal (260618_arthur-offline-resilience Stage 2).
 *
 * `runWithRetry` (Anthropic AND OpenAI clients, via `offlineFailFast.ts`) sets
 * `ModelError.details.offlineFailFast` when an independent reachability probe
 * confirmed the machine is offline and it stopped retrying early. This handler
 * must run BEFORE the alt-model / server-error / transient-retry handlers, which
 * would otherwise re-issue the turn over the dead network. Precise re-storm path:
 * the marked error is `kind: 'server_error'` carrying the offline COPY (not a
 * network-token string), so `isNetworkError()` is false and it would route to
 * `handleServerErrorRetry` (handler 5), re-storming and defeating the whole point
 * of failing fast. (Same conclusion holds even if the copy were network-shaped —
 * it would then hit the handler-9 transient retry — so gating here is required
 * regardless.)
 *
 * It reuses the EXISTING retryable `message_timeout` "Try again" terminal contract
 * (`dispatchAwaitingApiTimeoutTerminal`) so the renderer surfaces the same
 * recovery UX as the interactive awaiting_api hard-stall, with honest offline copy.
 * Origin-agnostic by construction (client layer, below the interactive/automation
 * watchdog gate) so it closes the automation hang too.
 */
export function handleOfflineFailFast(ctx: ErrorRecoveryContext): HandlerOutcome {
  if (!(ctx.error instanceof ModelError) || ctx.error.details?.offlineFailFast !== true) {
    return passthrough('not-offline-fail-fast');
  }

  const { turnId, win, turnLogger, error } = ctx;
  const userMessage = error.message || OFFLINE_FAIL_FAST_MESSAGE;

  turnLogger.warn(
    { provider: error.provider, messageCount: ctx.messageCount },
    'Fail-fast-offline — ending turn as retryable message_timeout terminal (offline confirmed; no retry storm)',
  );

  // Reuse the SINGLE source of truth for the retryable `message_timeout` terminal
  // (error event carrying the actionable Try-again surface + synthetic
  // result('error') to flip the renderer out of busy). NO retry, NO model fallback.
  dispatchAwaitingApiTimeoutTerminal({
    humanizedOverride: userMessage,
    dispatchError: (err, options) => dispatchRecoveryErrorEvent(ctx, err, options),
    dispatchSyntheticErrorResult: () =>
      dispatchAgentEvent(win, turnId, makeSyntheticResult(turnId, '', 'error')),
  });

  completeTurnCleanup(turnId, 'error');
  return handled({
    activityEmitted: true,
    proofOfObservability: { logged: true, structured: true },
  });
}


// ---------------------------------------------------------------------------
// Handler 2: Extended Context Fallback (1M → 200K)
// ---------------------------------------------------------------------------

export async function handleExtendedContextFallback(ctx: ErrorRecoveryContext): Promise<HandlerOutcome> {
  if (!isExtendedContextUnavailableError(ctx.error)) {
    return passthrough('not-extended-context-unavailable');
  }

  const {
    turnId, win, turnLogger, abortController,
    rendererSessionId, buildQueryOptions,
    createPromptOrGenerator, routerContext,
  } = ctx;

  // Record that 1M failed for this session
  if (rendererSessionId) {
    agentTurnRegistry.markExtendedContextFailed(rendererSessionId);
  }

  turnLogger.warn({ err: ctx.error }, 'Extended context (1M) not available for current subscription');

  // Try with 200K context
  turnLogger.info('1M not available - trying with 200K context');
  dispatchAgentEvent(win, turnId, {
    type: 'status',
    message: '1M context not available on your plan. Using 200K context...',
    timestamp: Date.now(),
  });

  ctx.modelConfig = stripExtendedContextFromConfig(ctx.modelConfig);
  agentTurnRegistry.setTurnExtendedContext(turnId, false);
  const fallbackLimits = resolveModelLimits({
    model: ctx.modelConfig.model,
    extendedContext: false,
    allProfiles: getSettings().localModel?.profiles ?? [],
  });
  agentTurnRegistry.setTurnContextWindow(turnId, fallbackLimits.contextWindow);
  ctx.queryOptions = buildQueryOptions(ctx.modelConfig);

  try {
    agentTurnRegistry.setTurnModel(turnId, ctx.modelConfig.model);
    const max200kPromptOrGenerator = createPromptOrGenerator();

    ctx.nestedFallbackQueryAttempted = true;
    const { abortedByUser: max200kAbortedByUser } = await runAgentQuery({
      queryOptions: ctx.queryOptions, prompt: max200kPromptOrGenerator, abortController, routerContext,
      turnId, win, turnLogger,
      getLastActivityAgeMs: ctx.getLastActivityAgeMs,
      // F20: keep Layer 1 aligned with the watchdog (Layer 2) tool-in-flight ceiling.
      messageTimeoutMs: resolveCurrentMessageTimeoutMs(ctx),
      getMessageTimeoutMs: ctx.getMessageTimeoutMs,
      ...(ctx.isToolInFlight && { isToolInFlight: ctx.isToolInFlight }),
      onApiOutput: () => { ctx.messageCount++; },
      rethrowKinds: new Set(['rate_limit', 'server_error', 'invalid_request', 'tool_name_corrupt']),
      label: 'Max 200K fallback',
    });

    if (max200kAbortedByUser) {
      turnLogger.info('Agent turn aborted by user during Max 200K fallback');
      dispatchAgentEvent(win, turnId, {
        type: 'status',
        message: 'Agent turn stopped by user',
        timestamp: Date.now(),
      });
      dispatchAgentEvent(win, turnId, makeSyntheticResult(turnId, '', 'user_stopped'));
    }

    turnLogger.info('Agent turn completed with Max 200K fallback');
    if (!max200kAbortedByUser) {
      agentTurnRegistry.addTurnFallback(turnId, {
        type: 'context', from: '1M', to: '200K', reason: 'extended-context-unavailable',
      });
      updateLastApiCallTime();
    }
    completeTurnCleanup(turnId, max200kAbortedByUser ? 'aborted' : 'completed-max-200k-fallback');
    return handled({
      activityEmitted: true,
      proofOfObservability: { logged: true, structured: true },
    });
  } catch (max200kError: unknown) {
    if (abortController.signal.aborted) {
      turnLogger.info('Agent turn aborted during Max 200K fallback');
      dispatchAgentEvent(win, turnId, {
        type: 'status',
        message: 'Agent turn stopped by user',
        timestamp: Date.now(),
      });
      dispatchAgentEvent(win, turnId, makeSyntheticResult(turnId, '', 'user_stopped'));
      completeTurnCleanup(turnId, 'aborted');
      return handled({
        activityEmitted: true,
        proofOfObservability: { logged: true, structured: true },
      });
    }
    turnLogger.warn({ err: max200kError }, 'Max 200K fallback also failed');
    ctx.error = max200kError;
  }

  // Soft-failed: nested 200K fallback ran but errored; ctx.error reassigned and dispatcher
  // continues to the next handler. Activity may have been emitted via onApiOutput.
  return softFailed({
    activityEmitted: ctx.messageCount > 0,
    proofOfObservability: { logged: true, structured: true },
  });
}


// ---------------------------------------------------------------------------
// Handler 3: Thinking Model Downgrade
// When the preferred planning model is unavailable (e.g., user's plan doesn't
// include it), downgrades to FALLBACK_PLANNING_MODEL (see modelNormalization.ts).
// The actual fallback target is defined by downgradeThinkingModelConfig() in
// modelNormalization.ts — update there when models change.
// ---------------------------------------------------------------------------

export async function handleThinkingModelFallback(ctx: ErrorRecoveryContext): Promise<HandlerOutcome> {
  const isLegacyThinkingUnavailable = isThinkingModelUnavailableError(ctx.error);
  const isModelUnavailable = getErrorKind(ctx.error) === 'model_unavailable';
  if (!isLegacyThinkingUnavailable && !isModelUnavailable) {
    return passthrough('not-thinking-model-unavailable');
  }

  const configuredOutcome = await handleConfiguredRoleFallback(ctx, {
    allowRateLimit: false,
    source: 'model-unavailable',
    recoveryOwner: 'thinking_model_fallback_handler',
  });
  if (configuredOutcome.kind === 'handled') {
    return configuredOutcome;
  }

  if (!isLegacyThinkingUnavailable && resolveConfiguredFallbackRole(ctx) !== 'thinking') {
    return passthrough('model-unavailable-non-thinking-role-without-configured-fallback');
  }

  const {
    turnId, win, turnLogger, abortController,
    buildQueryOptions, createPromptOrGenerator, routerContext,
    rendererSessionId,
  } = ctx;

  const newModelConfig = downgradeThinkingModelConfig(ctx.modelConfig);

  // Check if config actually changed to prevent infinite loop
  const configChanged =
    newModelConfig.model !== ctx.modelConfig.model ||
    newModelConfig.envOverrides?.[ENV_THINKING_MODEL] !== ctx.modelConfig.envOverrides?.[ENV_THINKING_MODEL];

  if (!configChanged) {
    // An unchanged config means the model has no entry in the downgrade
    // ladder — which is NOT the same as "already on fallback" (a custom or
    // non-Claude thinking model was never on the ladder to begin with).
    // Log honestly per case (Fable 5 Stage 6 piece 4).
    const currentThinkingModel = ctx.modelConfig.envOverrides?.[ENV_THINKING_MODEL] ?? ctx.modelConfig.model;
    const isOnTerminalFallback = currentThinkingModel.replace(/\[1m\]$/i, '') === FALLBACK_PLANNING_MODEL;
    turnLogger.error(
      { err: ctx.error, currentModel: currentThinkingModel },
      isOnTerminalFallback
        ? 'Thinking model unavailable and already on fallback'
        : 'Thinking model unavailable and no downgrade path defined for it — soft-failing without a model downgrade'
    );
    return softFailed({
      activityEmitted: false,
      proofOfObservability: { logged: true, structured: true },
    });
  }

  const fallbackModel = newModelConfig.envOverrides?.[ENV_THINKING_MODEL] ?? newModelConfig.model;
  // REBEL-655 (MA2): the unavailable model is the planning model that just failed,
  // NOT necessarily the Claude sentinel. With a non-Claude thinking profile the
  // failed model is the user's real (proxy-backed) thinking model — reference it
  // by name rather than hard-coding "Opus".
  const unavailableModel = ctx.modelConfig.envOverrides?.[ENV_THINKING_MODEL] ?? ctx.modelConfig.model;
  turnLogger.warn(
    { err: ctx.error, fallbackModel },
    `Thinking model not available for subscription - falling back to ${getModelDisplayName(fallbackModel)}`
  );

  dispatchAgentEvent(win, turnId, {
    type: 'status',
    message: `Using ${getModelDisplayName(fallbackModel)} (${getModelDisplayName(unavailableModel)} not available on your plan).`,
    timestamp: Date.now(),
  });

  ctx.modelConfig = newModelConfig;
  try {
    await rebuildFallbackRoutePlan(
      ctx,
      { kind: 'thinking-downgrade', reason: 'thinking-not-supported' },
      { model: fallbackModel, profile: null },
    );
    ctx.queryOptions = buildQueryOptions(ctx.modelConfig);
  } catch (rebuildErr: unknown) {
    if (rebuildErr instanceof ConnectionNotConfiguredError) {
      turnLogger.warn(
        {
          err: rebuildErr,
          provider: rebuildErr.provider,
          fallbackKind: 'thinking-downgrade',
        },
        'Fallback route plan resolved to recoverable terminal — dispatching friendly reconnect error',
      );
      dispatchRecoveryErrorEvent(ctx, rebuildErr, {
        recoveryOwner: 'thinking_model_fallback_handler',
      });
      completeTurnCleanup(turnId, 'connection-not-configured');
      return handled({
        activityEmitted: true,
        proofOfObservability: { logged: true, structured: true },
      });
    }
    throw rebuildErr;
  }

  const fallbackConversationContext = await loadConversationHistory(rendererSessionId, turnLogger, 'thinking model fallback', ctx.effectiveResetConversation);

  try {
    agentTurnRegistry.setTurnModel(turnId, ctx.modelConfig.model);
    const fallbackPromptOrGenerator = createPromptOrGenerator(fallbackConversationContext);

    ctx.nestedFallbackQueryAttempted = true;
    const { abortedByUser: fallbackAbortedByUser } = await runAgentQuery({
      queryOptions: ctx.queryOptions, prompt: fallbackPromptOrGenerator, abortController, routerContext,
      turnId, win, turnLogger,
      getLastActivityAgeMs: ctx.getLastActivityAgeMs,
      // F20: keep Layer 1 aligned with the watchdog (Layer 2) tool-in-flight ceiling.
      messageTimeoutMs: resolveCurrentMessageTimeoutMs(ctx),
      getMessageTimeoutMs: ctx.getMessageTimeoutMs,
      ...(ctx.isToolInFlight && { isToolInFlight: ctx.isToolInFlight }),
      onApiOutput: () => { ctx.messageCount++; },
      rethrowKinds: new Set(['rate_limit', 'server_error', 'invalid_request', 'tool_name_corrupt']),
      rethrowPredicates: [isExtendedContextUnavailableError],
      label: 'thinking model fallback',
    });

    if (fallbackAbortedByUser) {
      turnLogger.info('Agent turn aborted by user during thinking model fallback');
      dispatchAgentEvent(win, turnId, {
        type: 'status',
        message: 'Agent turn stopped by user',
        timestamp: Date.now(),
      });
      dispatchAgentEvent(win, turnId, makeSyntheticResult(turnId, '', 'user_stopped'));
    }

    turnLogger.info('Agent turn completed after thinking model fallback');
    if (!fallbackAbortedByUser) {
      const fallbackRole = roleFromDecisionRole(ctx.plan?.decision?.role);
      const fallbackFrom = getDefaultModelForProvider(ctx.settings, fallbackRole);
      agentTurnRegistry.addTurnFallback(turnId, {
        type: 'model',
        from: fallbackFrom,
        to: newModelConfig.envOverrides?.[ENV_THINKING_MODEL] ?? newModelConfig.model,
        reason: 'model-unavailable',
      });
      // Stage 4: emit the turn-context fallback breadcrumb for the matrix runner.
      // The four join-keys are all derivable from `ctx` so the type contract is
      // satisfied without synthesising placeholders.
      const telemetryProvider: FallbackTelemetryProvider =
        ctx.plan?.decision?.provider === 'openrouter' || ctx.plan?.decision?.provider === 'codex'
          ? ctx.plan.decision.provider
          : 'anthropic';
      const credentialSource = ctx.plan?.decision?.credentialSource;
      const telemetryAuth: FallbackTelemetryAuth =
        credentialSource === 'codex-subscription' || credentialSource === 'missing-codex'
          ? 'codexCli'
          : credentialSource === 'anthropic-oauth-token' || credentialSource === 'openrouter-oauth-token' || credentialSource === 'missing-openrouter'
            ? 'oauth'
            : 'apiKey';
      emitTurnFallbackTelemetry({
        site: 'turnErrorRecovery:thinkingModelFallback',
        provider: telemetryProvider,
        role: fallbackRole,
        resolvedModel: fallbackFrom,
        credentialState: deriveCredentialStateFromSettings({
          activeProvider: ctx.settings.activeProvider,
          apiKey: getApiKey(ctx.settings) ?? null,
          openRouter: ctx.settings.openRouter
            ? {
                oauthToken: ctx.settings.openRouter.oauthToken ?? null,
                enabled: ctx.settings.openRouter.enabled ?? null,
              }
            : null,
          codex: null,
        }),
        providerFallbackReason: 'tier-unavailable',
        turnId,
        sessionId: ctx.rendererSessionId ?? turnId,
        auth: telemetryAuth,
        resolvedAuthLabel: credentialSource ?? 'unknown',
      });
      updateLastApiCallTime();
    }
    completeTurnCleanup(turnId, fallbackAbortedByUser ? 'aborted' : 'completed-thinking-model-fallback');
    return handled({
      activityEmitted: true,
      proofOfObservability: { logged: true, structured: true },
    });
  } catch (fallbackError: unknown) {
    if (abortController.signal.aborted) {
      turnLogger.info('Agent turn aborted during thinking model fallback (in catch)');
      dispatchAgentEvent(win, turnId, {
        type: 'status',
        message: 'Agent turn stopped by user',
        timestamp: Date.now(),
      });
      dispatchAgentEvent(win, turnId, makeSyntheticResult(turnId, '', 'user_stopped'));
      completeTurnCleanup(turnId, 'aborted');
      return handled({
        activityEmitted: true,
        proofOfObservability: { logged: true, structured: true },
      });
    }

    turnLogger.error({ err: fallbackError }, 'Thinking model fallback also failed');
    ctx.error = fallbackError;
  }

  // Soft-failed: nested thinking-model fallback ran but errored; ctx.error reassigned
  // and dispatcher continues to next handler. Activity may have been emitted.
  return softFailed({
    activityEmitted: ctx.messageCount > 0,
    proofOfObservability: { logged: true, structured: true },
  });
}


// ---------------------------------------------------------------------------
// Handler 3.5: Provider-chain recovery "C" (server/transient → provider chain)
// Stage 3 (260622_provider-routing-prodflip-prep) — flag-gated pre-handler.
//
// Routes direct-role-profile server_error / transient (alt-model-owned) recovery
// through the SAME enabledProviders failover chain that the 429 path (Stage-4b)
// already uses, instead of the legacy Anthropic-framed `handleAltModelFallback`
// (which retries the same model once, then falls back through the SAME
// activeProvider). Keyed by errorKind × providerCapabilities.
//
// HARD INVARIANT (flag-OFF byte-identical): the FIRST statement reads the flag
// and returns `passthrough` when OFF — nothing else executes (no state read, no
// candidate enumeration, no telemetry, no retryTurn). When OFF, control flows to
// `handleAltModelFallback` exactly as today.
//
// Q1 (locked): passthrough when ≤1 usable candidate so single-provider users keep
//   EXACT legacy alt-model behaviour even flag-ON (flag-ON is a strict superset —
//   only multi-provider users see any change).
// Q2 (locked): terminal honesty ≥ FOX-3494 — a recoverable terminal dispatches the
//   RAW error via classifyErrorUx (no humanizedOverride); only genuine
//   all-providers-exhausted uses the new non-429 exhaustion copy.
// This handler does NOT call recordRateLimit (server/transient are not rate limits)
// and uses its OWN `serverTransientAttemptedCredentialSources` field so it never
// contaminates 429 cooldown/telemetry state.
// ---------------------------------------------------------------------------

export async function handleProviderChainRecoveryFallback(
  ctx: ErrorRecoveryContext,
): Promise<HandlerOutcome> {
  // FLAG GATE — must be the first statement. When OFF, return immediately so the
  // flag-OFF path is byte-for-byte identical to today (no state read below runs).
  if (ctx.settings.experimental?.multiProviderRoutingEnabled !== true) {
    return passthrough('provider-chain-recovery:flag-off');
  }

  // Remaining gate (all required, flag-ON). Computed AFTER the flag check so a
  // flag-OFF turn never touches any of this.
  if (!ctx.isDirectRoleProfile) {
    return passthrough('provider-chain-recovery:not-direct-role');
  }
  // Mirror the Stage-4b gate (:1950): profile routes win before the provider-choice
  // seam and must not be transparently re-routed. Only settings-resolved routes
  // auto-failover.
  if (ctx.plan.decision.resolvedFrom !== 'settings') {
    return passthrough('provider-chain-recovery:not-settings-resolved');
  }
  if (ctx.altModelFallbackAttempted) {
    return passthrough('provider-chain-recovery:alt-model-already-attempted');
  }
  if (ctx.abortController.signal.aborted) {
    return passthrough('provider-chain-recovery:already-aborted');
  }

  // Server/transient alt-model-owned kind — computed IDENTICALLY to the dispatcher
  // (:3315-3321 / :3322-3323 sans the isDirectRoleProfile/altModelFallbackAttempted
  // factors, which are already gated above).
  const errorMessage = getErrorMessage(ctx.error);
  const errorKind = getErrorKind(ctx.error);
  const isNetworkFailure = errorKind === 'network' || (errorKind === 'unknown' && isNetworkError(errorMessage));
  const recoveryOwner: RecoveryOwner = ownerForRecoveryKind(errorKind);
  const isServerErrorRetry = recoveryOwner === 'alt_model_then_server_error_retry' && !isNetworkFailure;
  const isTransientForAltModel = recoveryOwner === 'alt_model_then_transient_retry'
    && !isNetworkFailure
    && isTransientError(errorMessage, errorKind, { logger: ctx.turnLogger });
  if (!isServerErrorRetry && !isTransientForAltModel) {
    return passthrough('provider-chain-recovery:not-server-or-transient');
  }

  const { turnId, win, turnLogger } = ctx;
  const credentialSource = ctx.plan.decision.credentialSource;

  // Enumerate failover candidates the SAME way Stage-4b does. NOTE: use
  // `ctx.routeInput.settings` (has hasManagedKey injected), NEVER `ctx.settings`
  // (the Stage-4b trap flagged at :1955).
  const failoverCandidates = getFailoverCredentialCandidates(
    ctx.routeInput.settings,
    { codexConnectivity: ctx.routeInput.codexConnectivity },
  );

  // Q1: ≤1 usable candidate → passthrough so single-provider users keep the EXACT
  // legacy alt-model behaviour (fast retry + same-provider fallback + FOX-3494
  // reconnect guard) even flag-ON. Flag-ON is a strict superset.
  if (failoverCandidates.size <= 1) {
    return passthrough('provider-chain-recovery:single-provider');
  }

  // Same-model fast retry — preserved exactly from the legacy alt-model path
  // (:1269-1311): same ALT_MODEL_MAX_RETRIES budget, same registry retry counter,
  // same restart-safety gate, same "Hit a snag" status, same jittered delay.
  const altRetryCount = agentTurnRegistry.getRetryCount(turnId);
  if (altRetryCount < ALT_MODEL_MAX_RETRIES) {
    const fastRetryGate = restartSafetyGate(ctx, { kind: 'multi-provider-server-error-fallback' });
    if (!fastRetryGate.ok) {
      turnLogger.warn(
        { messageCount: ctx.messageCount, gateReason: fastRetryGate.reason },
        'Provider-chain recovery fast retry skipped — agent activity already occurred, falling through to provider chain',
      );
    } else {
      const nextRetry = agentTurnRegistry.incrementRetryCount(turnId);
      const delayMs = 1000 + Math.random() * 500;
      turnLogger.info(
        { retryCount: nextRetry, maxRetries: ALT_MODEL_MAX_RETRIES, delayMs: Math.round(delayMs), errorKind },
        'Provider-chain recovery — server/transient error, fast retry before provider switch...',
      );
      dispatchAgentEvent(win, turnId, {
        type: 'status',
        message: 'Hit a snag. Retrying...',
        timestamp: Date.now(),
      });
      if (await delayWithAbort(delayMs, ctx.abortController.signal)) {
        turnLogger.info('Provider-chain recovery fast retry cancelled — turn was aborted');
        completeTurnCleanup(turnId, 'aborted');
        return handled({
          activityEmitted: false,
          proofOfObservability: { logged: true, structured: true },
        });
      }
      await ctx.retryTurn();
      return handled({
        activityEmitted: false,
        proofOfObservability: { logged: true, structured: true },
      });
    }
  }

  // Fast retry exhausted (or gate blocked it). Honor the user's configured per-role
  // fallback FIRST (parity with the 429/alt-model/server handlers — explicit
  // configured fallback outranks provider auto-failover).
  const configuredOutcome = await handleConfiguredRoleFallback(ctx, {
    allowRateLimit: false,
    source: 'server-error-retry',
    recoveryOwner,
  });
  if (configuredOutcome.kind === 'handled') {
    return configuredOutcome;
  }

  // Drive the provider chain, analogous to Stage-4b (:1952-2059) but WITHOUT any
  // rate-limit cooldown writes/telemetry (server/transient are not 429s).
  const failoverGate = restartSafetyGate(ctx, { kind: 'multi-provider-server-error-fallback' });

  // Codex-divert credential (FIX-2, mirror Stage-4b :1972-1973): when the route was a
  // Codex→native-Claude→Anthropic divert (Codex picked, native Claude model, Anthropic
  // creds present), the Codex pre-divert credential ('codex-subscription') is also
  // exhausted — re-picking Codex would just re-divert to the same just-failed Anthropic
  // credential (one doomed "switching providers" hop). Mark it attempted so the skip
  // union excludes Codex on the next hop.
  const codexDivertCredential = isCodexDivertedToAnthropic(ctx.plan.decision);

  // The accumulator we WRITE back: only the server/transient-attempted credentials (the
  // prior set + this hop's credential + any codex divert). We deliberately do NOT fold
  // the rate-limit set into this field (that would contaminate 429 attribution); the
  // rate-limit field rides along untouched via the executor's retryTurn spread.
  const serverTransientAttempted = new Set(
    ctx.turnOptions?.serverTransientAttemptedCredentialSources ?? [],
  );
  serverTransientAttempted.add(credentialSource);
  if (codexDivertCredential !== null) serverTransientAttempted.add(codexDivertCredential);

  // FIX-1 (mixed-episode union exhaustion): the skip/exhaustion/hard-stop decision READS
  // the UNION of BOTH attempted fields. The route-skip union (agentTurnExecute.ts) plus
  // the router's pickProviderMode head-fallback mean that, in a mixed episode like
  // A(429)→B(server_error), the rate-limit-attempted credential A is still excluded by
  // route selection but would NOT be counted here if we only read the server/transient
  // set — letting this handler re-drive into the just-429'd A instead of terminating.
  // So termination considers both fields; we still WRITE only the server/transient field
  // above (never the rate-limit field, never recordRateLimit) so 429 state stays clean.
  const attempted = new Set([
    ...serverTransientAttempted,
    ...(ctx.turnOptions?.rateLimitAttemptedCredentialSources ?? []),
  ]);
  // alreadyTriedThisCredential = the credential that just failed was already in the
  // PRIOR union (i.e. the router re-picked an exhausted credential → hard-stop).
  const priorUnion = new Set([
    ...(ctx.turnOptions?.serverTransientAttemptedCredentialSources ?? []),
    ...(ctx.turnOptions?.rateLimitAttemptedCredentialSources ?? []),
  ]);
  const alreadyTriedThisCredential = priorUnion.has(credentialSource);
  const remaining = [...failoverCandidates].filter((c) => !attempted.has(c));

  if (failoverGate.ok && remaining.length > 0 && !alreadyTriedThisCredential) {
    // Mid-handler abort check (mirror :1991-2004): if the user cancelled after the
    // gate passed but before we dispatch/retry, surface user_stopped + cleanup.
    if (ctx.abortController.signal.aborted) {
      turnLogger.info('Agent turn aborted before multi-provider server/transient failover retry');
      dispatchAgentEvent(win, turnId, {
        type: 'status',
        message: 'Agent turn stopped by user',
        timestamp: Date.now(),
      });
      dispatchAgentEvent(win, turnId, makeSyntheticResult(turnId, '', 'user_stopped'));
      completeTurnCleanup(turnId, 'aborted');
      return handled({
        activityEmitted: true,
        proofOfObservability: { logged: true, structured: true },
      });
    }

    dispatchAgentEvent(win, turnId, {
      type: 'status',
      message: 'Provider had trouble — switching providers...',
      timestamp: Date.now(),
    });
    agentTurnRegistry.addTurnFallback(turnId, {
      type: 'provider',
      from: credentialSource,
      to: 'auto-failover',
      reason: 'multi-provider-server-error-failover',
    });
    turnLogger.info(
      { from: credentialSource, attempted: [...attempted], serverTransientAttempted: [...serverTransientAttempted], remaining, errorKind },
      'Multi-provider server/transient failover — retrying on next usable provider',
    );
    const retryOverrides: TurnRetryOverrides = {
      routeRebuildHint: undefined,            // clear inherited hint — force fresh re-resolution
      inFlightProviderRoutePlan: undefined,
      // Write ONLY the server/transient set (the rate-limit field rides along via spread).
      serverTransientAttemptedCredentialSources: [...serverTransientAttempted],
    };
    await ctx.retryTurn(retryOverrides);
    return handled({
      activityEmitted: false,
      proofOfObservability: { logged: true, structured: true },
    });
  }

  // Exhausted (all usable credentials attempted OR re-picked credential = hard-stop)
  // OR gate blocked (partial output) → honest terminal error.
  // NO apiRateLimitCooldown / providerRateLimitCooldowns writes — server/transient
  // are not rate limits.
  const exhausted = remaining.length === 0 || alreadyTriedThisCredential;
  turnLogger.info(
    { attempted: [...attempted], exhausted, gateOk: failoverGate.ok, errorKind },
    'Multi-provider server/transient failover finished — showing terminal error',
  );

  if (exhausted && failoverGate.ok) {
    // FIX-4: emit a PII-safe categorical structured log on the genuine
    // all-providers-exhausted terminal so a fully-exhausted (potentially paid) chain is
    // QUERYABLE for the prod-flip's observability gate — symmetric with the 429
    // terminal's failoverReason log. Categorical-only (credential-source enums, errorKind,
    // small int hopCount), NO model strings / prompts / PII. Keyed off `event` so log
    // queries don't depend on message text.
    turnLogger.info(
      {
        event: 'multi_provider_server_error_failover_exhausted',
        // The server/transient credentials this handler drove + the cross-class union
        // that informed termination (both categorical enum sets).
        serverTransientAttempted: [...serverTransientAttempted],
        attemptedUnion: [...attempted],
        hopCount: attempted.size,
        errorKind,
      },
      'Multi-provider server/transient failover exhausted — every connected provider failed',
    );
    // Genuine all-providers-exhausted: use the new non-429 exhaustion copy.
    // Must NOT use failoverReason:'all-providers-rate-limited' (429-only vocab).
    dispatchRecoveryErrorEvent(ctx, ctx.error, {
      recoveryOwner,
      providerOverride: getErrorProvider(ctx.error),
      humanizedOverride:
        'Every connected provider ran into trouble, even after switching. Your message is safe — try again in a moment.',
    });
    completeTurnCleanup(turnId, 'error');
  } else {
    // Recoverable-terminal sub-case (Q2): partial-output gate blocked the re-drive,
    // or the router re-picked an already-attempted credential. Dispatch the RAW
    // error via classifyErrorUx with NO humanizedOverride so the dispatcher's
    // classification-first pipeline produces the subtype/provider-aware copy
    // (mirrors :1402 / :1523 — terminal honesty ≥ FOX-3494).
    dispatchRecoveryErrorEvent(ctx, ctx.error, {
      recoveryOwner,
      providerOverride: getErrorProvider(ctx.error),
    });
    completeTurnCleanup(turnId, 'error');
  }
  return handled({
    activityEmitted: true,
    proofOfObservability: { logged: true, structured: true },
  });
}


// ---------------------------------------------------------------------------
// Handler 4: Alt-Model Proxy Fallback (proxy error → retry → Claude)
// ---------------------------------------------------------------------------

export async function handleAltModelFallback(
  ctx: ErrorRecoveryContext,
  isAltModelError: boolean,
): Promise<HandlerOutcome> {
  if (!isAltModelError || ctx.abortController.signal.aborted) {
    return passthrough(
      !isAltModelError ? 'not-alt-model-error' : 'alt-model-skipped:already-aborted',
    );
  }

  const {
    turnId, win, turnLogger, abortController, modelConfig,
    buildQueryOptions, createPromptOrGenerator, routerContext,
    activeProfile, thinkingProfile, workingProfile,
    rendererSessionId,
  } = ctx;

  const errorKind = getErrorKind(ctx.error);
  const isServerError = errorKind === 'server_error';
  const isRateLimitError = errorKind === 'rate_limit';
  const recoveryOwner: RecoveryOwner = isServerError
    ? 'alt_model_then_server_error_retry'
    : 'alt_model_then_transient_retry';

  const altModelId = activeProfile?.model ?? workingProfile?.model ?? thinkingProfile?.model ?? 'unknown';

  const altRetryCount = agentTurnRegistry.getRetryCount(turnId);

  if (altRetryCount < ALT_MODEL_MAX_RETRIES) {
    // Guard: skip same-model retry if real API output (assistant text,
    // tool_use/tool_result, result) has already been streamed — retrying
    // after output was dispatched would cause duplicate replies.
    // Synthetic system:* messages do NOT bump messageCount (filtered at the
    // runner via isApiOutputMessage(); callers receive only API-output via
    // onApiOutput).
    const fastRetryGate = restartSafetyGate(ctx, { kind: 'alt-model-fast-retry' });
    if (!fastRetryGate.ok) {
      turnLogger.warn(
        { messageCount: ctx.messageCount, model: altModelId, gateReason: fastRetryGate.reason },
        'Alt-model fast retry skipped — agent activity already occurred, falling through to model fallback'
      );
    } else {
      const nextRetry = agentTurnRegistry.incrementRetryCount(turnId);
      const delayMs = 1000 + Math.random() * 500;

      turnLogger.info(
        { retryCount: nextRetry, maxRetries: ALT_MODEL_MAX_RETRIES, delayMs: Math.round(delayMs), model: altModelId },
        'Alt-model proxy error, fast retry before fallback...'
      );

      dispatchAgentEvent(win, turnId, {
        type: 'status',
        message: 'Hit a snag. Retrying...',
        timestamp: Date.now(),
      });

      if (await delayWithAbort(delayMs, abortController.signal)) {
        turnLogger.info('Alt-model retry cancelled - turn was aborted');
        completeTurnCleanup(turnId, 'aborted');
        return handled({
          activityEmitted: false,
          proofOfObservability: { logged: true, structured: true },
        });
      }

      await ctx.retryTurn();
      return handled({
        activityEmitted: false,
        proofOfObservability: { logged: true, structured: true },
      });
    }
  }

  // Retry exhausted — fall back to Claude.
  // Guard: if real API output was already received, the alt-model may have already
  // dispatched assistant/tool events. Running Claude fallback (runAgentQuery) on the
  // same turnId would append more events, creating duplicate/mixed output.
  // Synthetic system:* messages do NOT bump messageCount (filtered at the
  // runner via isApiOutputMessage(); callers receive only API-output via
  // onApiOutput). messageCount reflects activity from any prior fallback
  // runAgentQuery() in this recovery chain too — runner-level filtering
  // applies uniformly across all sites.
  const claudeFallbackGate = restartSafetyGate(ctx, { kind: 'alt-model-claude-fallback' });
  if (!claudeFallbackGate.ok) {
    const provider = getErrorProvider(ctx.error);
    turnLogger.warn(
      { messageCount: ctx.messageCount, model: altModelId, gateReason: claudeFallbackGate.reason },
      'Alt-model fallback skipped — agent activity already occurred, dispatching error to user'
    );
    if (isRateLimitError) {
      dispatchRecoveryErrorEvent(ctx, ctx.error, {
        providerOverride: provider,
        errorKindOverride: 'rate_limit',
        recoveryOwner,
      });
    } else {
      const midConversationCopy = isServerError
        ? humanizeProviderServerError(provider)
        : 'Something went wrong mid-conversation. Your work so far is saved — try sending your message again to pick up where I left off.';
      dispatchRecoveryErrorEvent(ctx, ctx.error, {
        humanizedOverride: midConversationCopy,
        providerOverride: provider,
        recoveryOwner,
      });
    }
    completeTurnCleanup(turnId, 'alt-model-error');
    return handled({
      activityEmitted: true,
      proofOfObservability: { logged: true, structured: true },
    });
  }

  const altConfiguredOutcome = await handleConfiguredRoleFallback(ctx, {
    allowRateLimit: false,
    source: 'alt-model-fallback',
    recoveryOwner,
  });
  if (altConfiguredOutcome.kind === 'handled') {
    return altConfiguredOutcome;
  }

  ctx.altModelFallbackAttempted = true;
  const toModel = modelConfig.model;
  const fallbackStartMs = Date.now();

  // Prove the fallback route is actually runnable for THIS user BEFORE announcing a
  // backup or recording fallback telemetry. Recovery historically assumed a runnable
  // Claude safety net always existed; when the fallback target isn't reachable (e.g. a
  // Claude target for a user with no Anthropic credential — a mixed-credential state),
  // the old ordering dispatched "Switching to a backup" plus a fallback Sentry/registry
  // record FIRST and only discovered the route was terminal afterwards — a doomed,
  // mislabelled attempt the user saw fail. We now rebuild the route first and announce
  // only once it is known-dispatchable. (Proactively selecting a runnable ALTERNATIVE
  // across providers is the picker's job — provider eligibility is bound to the active
  // provider — so it rides on the routeRef work, not this recovery gate.)
  const altFallbackConversationContext = await loadConversationHistory(
    rendererSessionId, turnLogger, 'alt-model fallback', ctx.effectiveResetConversation
  );

  let claudeQueryOptions: Omit<TurnParams, 'prompt'>;
  try {
    await rebuildFallbackRoutePlan(
      ctx,
      { kind: 'alt-model', model: toModel },
      { model: toModel, profile: null },
    );

    // Rebuild query options from the fallback plan. The explicit model assignment
    // preserves the legacy bypass of direct role-profile model selection.
    claudeQueryOptions = { ...buildQueryOptions(ctx.modelConfig) };
    claudeQueryOptions.model = toModel;
  } catch (rebuildErr: unknown) {
    if (rebuildErr instanceof ConnectionNotConfiguredError) {
      turnLogger.warn(
        {
          err: rebuildErr,
          provider: rebuildErr.provider,
          fallbackKind: 'alt-model',
        },
        'Fallback route plan resolved to recoverable terminal — dispatching friendly reconnect error (no backup announced)',
      );
      dispatchRecoveryErrorEvent(ctx, rebuildErr, {
        recoveryOwner,
      });
      completeTurnCleanup(turnId, 'connection-not-configured');
      return handled({
        activityEmitted: true,
        proofOfObservability: { logged: true, structured: true },
      });
    }
    throw rebuildErr;
  }

  // Route is viable — now it is honest to tell the user and record the fallback.
  turnLogger.warn(
    { fromModel: altModelId, toModel, reason: isServerError ? 'server-error' : 'transient-error' },
    'Alt-model fallback triggered — switching to fallback model'
  );

  dispatchAgentEvent(win, turnId, {
    type: 'status',
    message: 'Switching to a backup. Picking up where I left off.',
    timestamp: Date.now(),
  });

  agentTurnRegistry.addTurnFallback(turnId, {
    type: 'model',
    from: altModelId,
    to: toModel,
    reason: isServerError ? 'proxy-server-error' : 'proxy-transient-error',
  });

  getErrorReporter().captureMessage('Alt-model fallback', {
    level: 'warning',
    tags: {
      area: 'agent-turn',
      component: 'alt-model-fallback',
      from_model: altModelId,
      to_model: toModel,
    },
    extra: {
      turnId,
      fromModel: altModelId,
      toModel,
      reason: isServerError ? 'server-error' : 'transient-error',
      retryCount: agentTurnRegistry.getRetryCount(turnId),
    },
  });

  turnLogger.info(
    { rendererSessionId },
    'Alt-model fallback — sessions may be proxy-scoped'
  );

  agentTurnRegistry.setTurnModel(turnId, toModel);
  const claudePromptOrGenerator = createPromptOrGenerator(altFallbackConversationContext);

  try {
    ctx.nestedFallbackQueryAttempted = true;
    const { abortedByUser: claudeAbortedByUser } = await runAgentQuery({
      queryOptions: claudeQueryOptions, prompt: claudePromptOrGenerator, abortController, routerContext,
      turnId, win, turnLogger,
      getLastActivityAgeMs: ctx.getLastActivityAgeMs,
      // F20: keep Layer 1 aligned with the watchdog (Layer 2) tool-in-flight ceiling.
      messageTimeoutMs: resolveCurrentMessageTimeoutMs(ctx),
      getMessageTimeoutMs: ctx.getMessageTimeoutMs,
      ...(ctx.isToolInFlight && { isToolInFlight: ctx.isToolInFlight }),
      onApiOutput: () => { ctx.messageCount++; },
      rethrowKinds: new Set(['rate_limit', 'server_error', 'invalid_request']),
      label: 'alt-model fallback',
    });

    if (claudeAbortedByUser) {
      turnLogger.info('Agent turn aborted by user during alt-model fallback');
      dispatchAgentEvent(win, turnId, {
        type: 'status',
        message: 'Agent turn stopped by user',
        timestamp: Date.now(),
      });
      dispatchAgentEvent(win, turnId, makeSyntheticResult(turnId, '', 'user_stopped'));
    }

    const fallbackElapsedMs = Date.now() - fallbackStartMs;
    turnLogger.info({ fallbackElapsedMs }, 'Agent turn completed after alt-model fallback');
    if (!claudeAbortedByUser) {
      updateLastApiCallTime();
    }
    completeTurnCleanup(turnId, claudeAbortedByUser ? 'aborted' : 'completed-altmodel-fallback');
    return handled({
      activityEmitted: true,
      proofOfObservability: { logged: true, structured: true },
    });
  } catch (claudeFallbackError: unknown) {
    if (abortController.signal.aborted) {
      turnLogger.info('Agent turn aborted during alt-model fallback (in catch)');
      dispatchAgentEvent(win, turnId, {
        type: 'status',
        message: 'Agent turn stopped by user',
        timestamp: Date.now(),
      });
      dispatchAgentEvent(win, turnId, makeSyntheticResult(turnId, '', 'user_stopped'));
      completeTurnCleanup(turnId, 'aborted');
      return handled({
        activityEmitted: true,
        proofOfObservability: { logged: true, structured: true },
      });
    }

    // Claude fallback also failed — dispatch error and return cleanly.
    turnLogger.error({ err: claudeFallbackError }, 'Alt-model fallback also failed');
    const isClaudeFallbackRateLimit = getErrorKind(claudeFallbackError) === 'rate_limit';
    if (isClaudeFallbackRateLimit) {
      const rawMessage = getRawErrorMessage(claudeFallbackError);
      const retryAfterMs = extractRetryAfterMs(rawMessage);
      apiRateLimitCooldown.recordRateLimit(retryAfterMs);
    }
    // Stage 5 (260421_classification_driven_error_humanizer): dispatch the raw
    // error and let `humanizeAgentError` (via the dispatcher's Stage 2
    // classification-first pipeline) produce the subtype/provider-aware copy.
    // The previous `humanizedOverride: humanizeError(rawMessage) || <fallback>`
    // pattern was the exact "classification-blind substring cascade + hard-coded
    // fallback" class that this Scope C refactor eliminates.
    dispatchRecoveryErrorEvent(ctx, claudeFallbackError, {
      recoveryOwner,
    });
    completeTurnCleanup(turnId, 'altmodel-fallback-failed');
    return handled({
      activityEmitted: true,
      proofOfObservability: { logged: true, structured: true },
    });
  }
}


// ---------------------------------------------------------------------------
// Handler 6: Server Error Retry (exponential backoff, max 2)
// ---------------------------------------------------------------------------

export async function handleServerErrorRetry(
  ctx: ErrorRecoveryContext,
  isServerErrorRetry: boolean,
  isAltModelError: boolean,
): Promise<HandlerOutcome> {
  if (!isServerErrorRetry || isAltModelError) {
    return passthrough(
      !isServerErrorRetry ? 'not-server-error' : 'server-error-deferred-to-alt-model-handler',
    );
  }

  const { turnId, turnLogger, abortController, win } = ctx;
  const MAX_SERVER_ERROR_RETRIES = 2;
  const TOTAL_RETRY_BUDGET_MS = 240_000; // 4 minutes — circuit breaker for long retry sequences
  const serverRetryCount = agentTurnRegistry.getRetryCount(turnId);

  // Track wall-clock start time from the first server error
  if (serverRetryCount === 0) {
    agentTurnRegistry.setRetryStartTime(turnId, Date.now());
  }

  // Guard: skip retry if real API output (assistant text, tool_use/tool_result,
  // result) has already been streamed — retrying after output was dispatched
  // would cause duplicate replies. Synthetic system:* messages do NOT bump
  // messageCount (filtered at the runner via isApiOutputMessage()).
  // ctx.messageCount also reflects activity from any prior fallback
  // runAgentQuery() in this recovery chain — every site uses the runner's
  // required onApiOutput callback to bump ctx.messageCount.
  const serverRetryGate = restartSafetyGate(ctx, { kind: 'server-error-retry' });
  if (!serverRetryGate.ok) {
    turnLogger.warn(
      { messageCount: ctx.messageCount, gateReason: serverRetryGate.reason },
      'Server error retry skipped — real API output already dispatched'
    );
  } else if (serverRetryCount < MAX_SERVER_ERROR_RETRIES && !abortController.signal.aborted) {
    // Check wall-clock budget before attempting another retry
    const retryStartTime = agentTurnRegistry.getRetryStartTime(turnId);
    const elapsedMs = retryStartTime ? Date.now() - retryStartTime : 0;
    if (elapsedMs > TOTAL_RETRY_BUDGET_MS) {
      const elapsedSec = Math.round(elapsedMs / 1000);
      const serverUnavailableCopy = `The AI service has been unavailable for ${elapsedSec}s. Your message is safe — try again in a moment.`;
      turnLogger.error(
        { elapsedMs, budgetMs: TOTAL_RETRY_BUDGET_MS, retryCount: serverRetryCount },
        'Server error retry budget exceeded — stopping retries'
      );
      dispatchRecoveryErrorEvent(ctx, ctx.error, {
        humanizedOverride: serverUnavailableCopy,
        providerOverride: getErrorProvider(ctx.error),
        recoveryOwner: 'alt_model_then_server_error_retry',
      });
      completeTurnCleanup(turnId, 'server-error');
      return handled({
        activityEmitted: true,
        proofOfObservability: { logged: true, structured: true },
      });
    }

    const nextRetry = agentTurnRegistry.incrementRetryCount(turnId);
    const delayMs = 2000 * Math.pow(2, serverRetryCount) + Math.random() * 1000;
    const elapsedSec = retryStartTime ? Math.round((Date.now() - retryStartTime) / 1000) : 0;

    turnLogger.info(
      { retryCount: nextRetry, maxRetries: MAX_SERVER_ERROR_RETRIES, delayMs, elapsedMs },
      'API server error, retrying automatically...'
    );

    dispatchAgentEvent(win, turnId, {
      type: 'status',
      message: `API service error — retrying automatically (attempt ${nextRetry} of ${MAX_SERVER_ERROR_RETRIES}, ${elapsedSec}s elapsed)...`,
      timestamp: Date.now(),
    });

    if (await delayWithAbort(delayMs, abortController.signal)) {
      turnLogger.info('Server error retry cancelled - turn was aborted by user');
      completeTurnCleanup(turnId, 'aborted');
      return handled({
        activityEmitted: false,
        proofOfObservability: { logged: true, structured: true },
      });
    }

    await ctx.retryTurn();
    return handled({
      activityEmitted: false,
      proofOfObservability: { logged: true, structured: true },
    });
  }

  // Retries exhausted or guard triggered — dispatch error to user
  if (!abortController.signal.aborted) {
    const serverConfiguredOutcome = await handleConfiguredRoleFallback(ctx, {
      allowRateLimit: false,
      source: 'server-error-retry',
      recoveryOwner: 'alt_model_then_server_error_retry',
    });
    if (serverConfiguredOutcome.kind === 'handled') {
      return serverConfiguredOutcome;
    }

    const retryStartTime = agentTurnRegistry.getRetryStartTime(turnId);
    const elapsedSec = retryStartTime ? Math.round((Date.now() - retryStartTime) / 1000) : 0;
    const retryExhaustedCopy = elapsedSec > 0
      ? `The AI service had a rough patch for ${elapsedSec}s despite several retries. Your message is safe — try again in a moment.`
      : 'The AI service had a rough patch despite several retries. Your message is safe — try again in a moment.';
    turnLogger.error(
      { retryCount: agentTurnRegistry.getRetryCount(turnId), maxRetries: MAX_SERVER_ERROR_RETRIES, elapsedSec },
      'Server error retries exhausted - showing error to user'
    );
    dispatchRecoveryErrorEvent(ctx, ctx.error, {
      humanizedOverride: retryExhaustedCopy,
      providerOverride: getErrorProvider(ctx.error),
      recoveryOwner: 'alt_model_then_server_error_retry',
    });
  }
  completeTurnCleanup(turnId, abortController.signal.aborted ? 'aborted' : 'server-error');
  return handled({
    activityEmitted: !abortController.signal.aborted,
    proofOfObservability: { logged: true, structured: true },
  });
}


// ---------------------------------------------------------------------------
// Handler 6.4: Managed model not allowed (must precede billing)
// See: docs/plans/260513a_subscription_consumer_audit_gaps.md § G3
// ---------------------------------------------------------------------------

/**
 * Handle 403 managed-tier model-not-allowed errors from the Mindstone proxy.
 *
 * Non-retryable: the active model is outside the user's subscription tier
 * allow-list, so switching credentials or waiting won't help. The renderer
 * banner surfaces `requested` + `allowed` so the user can pick a valid model
 * or upgrade their tier.
 *
 * Must run BEFORE handleBillingError because:
 *   - Both surface as 4xx from the same proxy; we want the model-not-allowed
 *     subtype to win over generic billing classification.
 *   - Billing handler's analytics gate (subscription_credit_limit_hit) doesn't
 *     apply here; this is an allow-list miss, not a quota exhaustion.
 */
export async function handleManagedModelNotAllowed(ctx: ErrorRecoveryContext): Promise<HandlerOutcome> {
  if (getErrorKind(ctx.error) !== 'managed_model_not_allowed') {
    return passthrough('not-managed-model-not-allowed');
  }

  const { turnId, turnLogger } = ctx;
  const provider = getErrorProvider(ctx.error) ?? 'unknown';
  const upstreamProvider = ctx.error instanceof ModelError ? ctx.error.upstreamProvider : undefined;
  const managedModelMetaOverride =
    ctx.error instanceof ModelError ? ctx.error.details?.managedModelNotAllowed : undefined;
  const requested = managedModelMetaOverride?.requested;
  const allowed = managedModelMetaOverride?.allowed;

  turnLogger.info(
    { provider, requested, allowedCount: allowed?.length ?? 0 },
    'Managed-tier model not allowed — non-retryable'
  );

  captureKnownCondition(
    'recovery_managed_model_not_allowed',
    {
      provider,
      tags: {
        error_kind: 'managed_model_not_allowed',
        provider,
        ...(upstreamProvider ? { upstream_provider: upstreamProvider } : {}),
      },
      extra: { turnId, requested, allowed },
    },
    errorOrUndefined(ctx.error),
  );

  dispatchRecoveryErrorEvent(ctx, ctx.error, {
    errorKindOverride: 'managed_model_not_allowed',
    ...(managedModelMetaOverride ? { managedModelMetaOverride } : {}),
    recoveryOwner: 'managed_model_not_allowed_handler',
  });

  completeTurnCleanup(turnId, 'managed-model-not-allowed');
  return handled({
    activityEmitted: true,
    proofOfObservability: { logged: true, structured: true, sentryClass: 'managed_model_not_allowed' },
  });
}


// ---------------------------------------------------------------------------
// Handler 6.5: Billing Error (must precede rate limit)
// ---------------------------------------------------------------------------

/**
 * Handle billing/quota errors — non-retryable.
 *
 * Must run BEFORE handleRateLimitFallback to prevent text-based
 * `isRateLimitMessage()` matching from misclassifying a 429 billing
 * error as a transient rate limit.
 */
export async function handleBillingError(ctx: ErrorRecoveryContext): Promise<HandlerOutcome> {
  const isBillingError = getErrorKind(ctx.error) === 'billing';
  if (!isBillingError) {
    return passthrough('not-billing-error');
  }

  const { turnId, turnLogger } = ctx;
  const rawMessage = getRawErrorMessage(ctx.error);
  const errorKind = getErrorKind(ctx.error);
  const provider = getErrorProvider(ctx.error) ?? 'unknown';
  const upstreamProvider = ctx.error instanceof ModelError ? ctx.error.upstreamProvider : undefined;
  const billingSubtype = errorKind === 'billing'
    ? classifyBillingSubtype(rawMessage || getErrorMessage(ctx.error))
    : undefined;

  turnLogger.info(
    { provider },
    'Billing/quota error — non-retryable'
  );

  captureKnownCondition(
    'recovery_billing_quota',
    {
      provider,
      tags: {
        error_kind: errorKind,
        provider,
        ...(billingSubtype ? { billing_subtype: billingSubtype } : {}),
        ...(upstreamProvider ? { upstream_provider: upstreamProvider } : {}),
      },
      extra: { turnId },
    },
    errorOrUndefined(ctx.error),
  );

  // Route-aware lookups for both the dispatcher's `billingMeta.managedSubscription`
  // (Stage E2: see docs/plans/260513a_subscription_consumer_audit_gaps.md § E)
  // and the gated `subscription_credit_limit_hit` analytics below. Hoisted
  // above `dispatchAgentErrorEvent` so the dispatcher can mirror the same
  // tier/source signal into the error event.
  const credentialSource = ctx.plan.decision.credentialSource;
  const subState = getRebelAuthProvider().getSubscriptionState();
  const managedAllowanceResetsAt = getRebelAuthProvider().getManagedAllowanceResetsAt();
  const billingManagedSubscription =
    credentialSource === 'mindstone-managed-key' && subState?.tier
      ? { tier: subState.tier, resetsAt: managedAllowanceResetsAt }
      : undefined;
  const limitScopeOverride =
    billingManagedSubscription
      ? 'plan'
      : (credentialSource === 'codex-subscription' && isCodexUsageLimitBillingError(ctx.error))
          ? 'plan'
          : undefined;
  const billingOverrideCopy = billingManagedSubscription
    ? humanizeAgentError({
        kind: 'classified',
        errorKind: 'billing',
        rawMessage: rawMessage || getErrorMessage(ctx.error),
        provider: provider === 'unknown' ? undefined : provider,
        billingMeta: {
          subtype: billingSubtype ?? 'unknown',
          ...(upstreamProvider ? { upstreamProviderName: upstreamProvider } : {}),
          ...(rawMessage ? { rawError: rawMessage } : {}),
          managedSubscription: billingManagedSubscription,
        },
      })
    : undefined;

  // Stage H2: managed-subscription billing copy is pinned at dispatch time via
  // `humanizedOverride` so persisted-history hydration cannot re-interpolate the
  // date differently. BYO routes keep the default dispatcher humanization path.
  if (billingManagedSubscription) {
    dispatchRecoveryErrorEvent(ctx, ctx.error, {
      billingManagedSubscription,
      ...(limitScopeOverride ? { limitScopeOverride } : {}),
      ...(billingOverrideCopy ? { humanizedOverride: billingOverrideCopy } : {}),
      recoveryOwner: 'billing_handler',
    });
  } else {
    dispatchRecoveryErrorEvent(ctx, ctx.error, {
      ...(limitScopeOverride ? { limitScopeOverride } : {}),
      recoveryOwner: 'billing_handler',
    });
  }

  // Gate `subscription_credit_limit_hit` analytics to Mindstone-managed routes only.
  // Plan § E2 requires this event reflect the Mindstone subscription managed cap,
  // not BYO key spend caps or other providers that happen to bubble billing errors
  // through the recovery pipeline.
  if (subState && billingSubtype && credentialSource === 'mindstone-managed-key') {
    mainTracking.subscription.creditLimitHit({
      tier: subState.tier,
      subtype: mapBillingSubtypeForTracking(billingSubtype),
    });
  } else if (billingSubtype && credentialSource !== 'mindstone-managed-key') {
    turnLogger.debug(
      { credentialSource, billingSubtype },
      'Skipping subscription_credit_limit_hit tracking — non-Mindstone credential source'
    );
  }

  completeTurnCleanup(turnId, 'billing-error');
  return handled({
    activityEmitted: true,
    proofOfObservability: { logged: true, structured: true },
  });
}


// ---------------------------------------------------------------------------
// F1 fix helper — Codex→native-Claude divert detection (file-private)
// ---------------------------------------------------------------------------

/**
 * F1 fix: detect the Codex→native-Claude divert pattern.
 *
 * When the router picks `codex` as the provider mode but the final dispatched
 * decision uses Anthropic credentials (because the model is a native Claude and
 * Anthropic creds are present), both the Anthropic credential AND the Codex
 * pre-divert credential are implicitly exhausted by the same attempt.
 *
 * Returns the Codex pre-divert credentialSource ('codex-subscription') when
 * the divert occurred, or `null` otherwise.
 *
 * Detection: the decision was dispatched as `provider: 'anthropic'` with an
 * Anthropic credentialSource, AND Codex connectivity was `connected` at route
 * time. NOTE: `connected` proves Codex was *available*, not that it was the
 * *selected* head. We accept that: a `provider: 'anthropic'` decision implies a
 * native-Claude model, and Codex always diverts native-Claude → the same
 * Anthropic credential — so on a genuinely Anthropic-headed route (Codex also
 * connected) marking `codex-subscription` attempted is benign-or-correct (Codex
 * could only re-divert to the just-cooled Anthropic credential, never a distinct
 * fallback). The guard's real job is to skip the no-Codex case where the extra
 * mark is pointless.
 *
 * Codex always resolves to codex-subscription (no credential variation), so we
 * hard-code it here rather than exporting/calling providerModeFor. The comment
 * in providerRouting.ts confirms the unconditional mapping.
 *
 * Note: BTS/subagent routes go through the same routeDecision switch and could
 * exhibit the same pattern, but those paths currently flow to the Codex waterfall
 * rather than the multi-provider failover branch — latent, not active today.
 */
function isCodexDivertedToAnthropic(
  decision: ProviderRouteDecision,
): ProviderCredentialSource | null {
  if (!isDispatchableDecision(decision)) return null;
  if (decision.provider !== 'anthropic') return null;
  if (
    decision.credentialSource !== 'anthropic-api-key' &&
    decision.credentialSource !== 'anthropic-oauth-token'
  ) return null;
  // Codex connectivity 'connected' is the guard: if Codex was not connected it
  // could not have diverted, so marking codex-subscription attempted would be
  // pointless. When connected, the mark is benign-or-correct even on an
  // Anthropic-headed route (see the doc comment above).
  if (decision.codexConnectivity !== 'connected') return null;
  // Codex always resolves to codex-subscription (unconditional mapping).
  // If Codex was connected AND we dispatched to Anthropic, the Codex candidate
  // is implicitly exhausted — it would re-divert to the same cooled Anthropic credential.
  return 'codex-subscription';
}

// ---------------------------------------------------------------------------
// Handler 7: Rate Limit (with single-pick fallback for Codex)
// See: docs/plans/260415_codex_rate_limit_fallback.md
// ---------------------------------------------------------------------------

export async function handleRateLimitFallback(ctx: ErrorRecoveryContext): Promise<HandlerOutcome> {
  const isRateLimitRetryError = getErrorKind(ctx.error) === 'rate_limit' ||
    isRateLimitMessage(getErrorMessage(ctx.error));

  if (!isRateLimitRetryError) {
    return passthrough('not-rate-limit-error');
  }

  const rateLimitConfiguredOutcome = await handleConfiguredRoleFallback(ctx, {
    allowRateLimit: true,
    source: 'rate-limit',
    recoveryOwner: 'rate_limit_handler',
  });
  if (rateLimitConfiguredOutcome.kind === 'handled') {
    return rateLimitConfiguredOutcome;
  }

  const {
    turnId, win, turnLogger, settings,
  } = ctx;

  const rawMessage = getRawErrorMessage(ctx.error);
  const retryAfterMs = extractRetryAfterMs(rawMessage);
  const provider = getErrorProvider(ctx.error);
  const resetAtMs = ctx.error instanceof ModelError ? ctx.error.resetAtMs : undefined;
  const credentialSource = ctx.plan.decision.credentialSource;
  const limitScopeOverride =
    credentialSource === 'codex-subscription' && hasFarOutSubscriptionResetWindow(resetAtMs)
      ? 'plan'
      : undefined;

  // --- Stage 4b: Multi-provider rate-limit failover ---
  // Gate: flag on + route resolved from settings (not a profile route, which wins BEFORE the
  // provider-choice seam and cannot be transparently re-routed by changing provider).
  // GPT trap #1: profile routes bypass the provider-choice seam — do NOT failover for them.
  // Runs BEFORE the Codex waterfall (GPT trap #5/e) so Codex-specific paths are only
  // reached when the multi-provider branch doesn't apply.
  // Runs AFTER `handleConfiguredRoleFallback` (which fires first) — that is deliberate:
  // user's explicit configured-role fallback takes priority over provider auto-failover.
  // `ProviderResolvedFrom` has other values: 'explicit-profile'/'working-profile' are live
  // (profile routes win before the provider-choice seam, can't be transparently re-routed);
  // 'model-string'/'bts-model' etc. are unreachable in production today. We only auto-failover
  // for settings-resolved routes (the normal non-profile path).
  const isMultiProviderFailover =
    settings.experimental?.multiProviderRoutingEnabled === true &&
    ctx.plan.decision.resolvedFrom === 'settings';

  if (isMultiProviderFailover) {
    const failoverGate = restartSafetyGate(ctx, { kind: 'multi-provider-rate-limit-fallback' });
    const failoverCandidates = getFailoverCredentialCandidates(
      ctx.routeInput.settings,           // NOTE: routeInput.settings has hasManagedKey injected; ctx.settings does not
      { codexConnectivity: ctx.routeInput.codexConnectivity },
    );

    // MUST-FIX-1(b): defensive hard-stop — if the router re-picked a credential that was
    // already attempted this turn (e.g. cooldown expired between hops), abort immediately
    // rather than entering an unbounded retry loop.
    const priorAttempted = new Set(ctx.turnOptions?.rateLimitAttemptedCredentialSources ?? []);
    const alreadyTriedThisCredential = priorAttempted.has(credentialSource);

    const attempted = new Set(priorAttempted);
    attempted.add(credentialSource);
    // F1 fix: when the route was a Codex→Anthropic divert (Codex picked, native Claude model,
    // Anthropic creds present), the Codex pre-divert credential ('codex-subscription') is also
    // exhausted — re-picking Codex would just re-divert to the same cooled Anthropic credential.
    // Add it to the attempted set so the skip union excludes Codex on the next hop.
    // BTS/subagent path is latent (today BTS 429s go through the Codex waterfall, not here).
    const codexDivertCredential = isCodexDivertedToAnthropic(ctx.plan.decision);
    if (codexDivertCredential !== null) attempted.add(codexDivertCredential);
    const remaining = [...failoverCandidates].filter((c) => !attempted.has(c));

    // Always record the per-credential cooldown for the credential that just 429'd.
    providerRateLimitCooldowns.recordRateLimit(credentialSource, retryAfterMs);

    if (failoverGate.ok && remaining.length > 0 && !alreadyTriedThisCredential) {
      // Transparent failover retry — re-resolves fresh (no hint / inFlightPlan so the
      // selection seam can pick the next usable provider after cooling this one).
      // GPT trap #2: clear any inherited routeRebuildHint so the fallback rebuild path
      // doesn't re-engage. Both fields must be explicitly undefined (spread semantics).

      // MUST-FIX-2: abort check — if the user cancelled while we were in the rate-limit
      // handler (after the gate passed but before we dispatch/retry), do not show the
      // "switching providers" status or fire a retry on a dead turn. Match the canonical
      // mid-handler abort pattern used elsewhere in this file (Max-200K / thinking-model
      // catch blocks): surface the user_stopped terminal + run cleanup so the turn ends
      // observably rather than silently.
      if (ctx.abortController.signal.aborted) {
        turnLogger.info('Agent turn aborted before multi-provider failover retry');
        dispatchAgentEvent(win, turnId, {
          type: 'status',
          message: 'Agent turn stopped by user',
          timestamp: Date.now(),
        });
        dispatchAgentEvent(win, turnId, makeSyntheticResult(turnId, '', 'user_stopped'));
        completeTurnCleanup(turnId, 'aborted');
        return handled({
          activityEmitted: true,
          proofOfObservability: { logged: true, structured: true },
        });
      }

      dispatchAgentEvent(win, turnId, {
        type: 'status',
        message: 'Rate limit hit — switching providers...',
        timestamp: Date.now(),
      });
      agentTurnRegistry.addTurnFallback(turnId, {
        type: 'provider',
        from: credentialSource,
        to: 'auto-failover',
        reason: 'multi-provider-rate-limit-failover',
      });
      turnLogger.info(
        { from: credentialSource, attempted: [...attempted], remaining },
        'Multi-provider rate-limit failover — retrying on next usable provider',
      );
      const retryOverrides: TurnRetryOverrides = {
        routeRebuildHint: undefined,           // GPT trap #2: clear inherited hint
        inFlightProviderRoutePlan: undefined,  // force fresh re-resolution
        rateLimitAttemptedCredentialSources: [...attempted],
      };
      await ctx.retryTurn(retryOverrides);
      return handled({
        activityEmitted: false,
        proofOfObservability: { logged: true, structured: true },
      });
    }

    // Exhausted (all usable credentials attempted OR re-picked credential = hard-stop)
    // OR gate blocked (partial output) → honest terminal error.
    // Record the global backstop cooldown now that we terminate.
    // Only-extend semantics: if a prior hop recorded a longer cooldown, this call is a no-op for the global backstop.
    // Per-credential cooldowns (already recorded above per hop) have the correct individual durations.
    apiRateLimitCooldown.recordRateLimit(retryAfterMs);
    const exhausted = remaining.length === 0 || alreadyTriedThisCredential;
    const failoverReason: 'all-providers-rate-limited' | 'partial-output' | 'all-providers-rate-limited-after-partial' =
      exhausted && failoverGate.ok ? 'all-providers-rate-limited'
      : !exhausted && !failoverGate.ok ? 'partial-output'
      : 'all-providers-rate-limited-after-partial';
    turnLogger.info(
      { attempted: [...attempted], failoverReason },
      'Multi-provider rate-limit failover exhausted — showing terminal error',
    );
    dispatchRecoveryErrorEvent(ctx, ctx.error, {
      ...(limitScopeOverride ? { limitScopeOverride } : {}),
      recoveryOwner: 'rate_limit_handler',
      rateLimitProvider: credentialSource,
      failoverReason,
    });
    completeTurnCleanup(turnId, 'rate-limit');
    return handled({
      activityEmitted: true,
      proofOfObservability: { logged: true, structured: true },
    });
  }

  // --- Single-pick fallback for Codex rate limits ---
  // Waterfall: tier fallback → OpenRouter → Anthropic → error
  const isCodex = settings.activeProvider === 'codex';
  const alreadyAttempted = !!ctx.turnOptions?.rateLimitFallbackAttempted;
  const codexRateLimitGate = restartSafetyGate(ctx, { kind: 'codex-rate-limit-fallback' });
  const canFallback = isCodex && !alreadyAttempted && codexRateLimitGate.ok;

  if (canFallback) {
    const target = getRateLimitFallbackTarget(settings);

    if (target) {
      const targetLabel = target.kind === 'tier_model'
        ? `fallback model (${target.rawValue})`
        : `${target.provider === 'openrouter' ? 'OpenRouter' : 'Anthropic'} (${target.model})`;

      turnLogger.info(
        { fallbackKind: target.kind, target: target.kind === 'provider' ? target.provider : target.rawValue },
        `Codex rate limit — falling back to ${targetLabel}`
      );

      dispatchAgentEvent(win, turnId, {
        type: 'status',
        message: `Rate limit hit — switching to ${targetLabel}...`,
        timestamp: Date.now(),
      });

      // Build retry overrides based on fallback target kind
      const retryOverrides: TurnRetryOverrides = {
        rateLimitFallbackAttempted: true,
        inFlightProviderRoutePlan: ctx.plan,
      };

      if (target.kind === 'tier_model') {
        const thinkingFallback = getThinkingFallback(settings);
        retryOverrides.routeRebuildHint = {
          kind: 'codex-rate-limit-tier',
          tier: target.rawValue === thinkingFallback ? 'priority' : 'standard',
        };
        if (target.modelOverride) retryOverrides.modelOverride = target.modelOverride;
        if (target.profileOverrideId) retryOverrides.workingProfileOverrideId = target.profileOverrideId;
        if (target.provider === 'anthropic' || target.provider === 'openrouter') {
          retryOverrides.activeProviderOverride = target.provider;
        }
      } else {
        retryOverrides.routeRebuildHint = {
          kind: 'codex-rate-limit-provider',
          forceNonCodexTransport: true,
        };
        retryOverrides.activeProviderOverride = target.provider;
        retryOverrides.modelOverride = target.model;
      }

      // Record the fallback for turn telemetry
      agentTurnRegistry.addTurnFallback(turnId, {
        type: target.kind === 'tier_model' ? 'tier_model' : 'provider',
        from: `codex/${provider ?? 'unknown'}`,
        to: target.kind === 'provider' ? target.provider : (target.rawValue ?? 'unknown'),
        reason: 'codex-rate-limit',
      });

      apiRateLimitCooldown.recordRateLimit(retryAfterMs);
      await ctx.retryTurn(retryOverrides);
      return handled({
        activityEmitted: false,
        proofOfObservability: { logged: true, structured: true },
      });
    }

    // Nothing configured — show error with guidance to connect a backup
    turnLogger.info('Codex rate limit hit — no fallback providers configured');
    apiRateLimitCooldown.recordRateLimit(retryAfterMs);
    dispatchRecoveryErrorEvent(ctx, ctx.error, {
      humanizedOverride: 'ChatGPT Pro hit a rate limit. Connect OpenRouter or add an Anthropic API key in Settings as a backup provider to keep working.',
      intentionalCopyOverrideForKind: 'rate_limit',
      errorKindOverride: 'rate_limit',
      providerOverride: provider ?? undefined,
      rateLimitMetaOverride: {
        rawError: rawMessage || undefined,
        retryAfterMs,
        ...(resetAtMs ? { resetAtMs } : {}),
      },
      ...(limitScopeOverride ? { limitScopeOverride } : {}),
      recoveryOwner: 'rate_limit_handler',
    });
    completeTurnCleanup(turnId, 'rate-limit');
    return handled({
      activityEmitted: true,
      proofOfObservability: { logged: true, structured: true },
    });
  }

  // --- Default rate limit handling (non-Codex, or fallback already attempted, or partial output) ---
  if (isCodex && alreadyAttempted) {
    turnLogger.info('Rate limit on fallback provider (already attempted once) — showing error');
  } else {
    turnLogger.info('Rate limit hit (no fallback available)');
  }

  apiRateLimitCooldown.recordRateLimit(retryAfterMs);
  // Stage 5 (260421_classification_driven_error_humanizer): dispatch raw error
  // and let the dispatcher's Stage 2 classification-first pipeline produce the
  // provider-aware rate-limit copy via `humanizeAgentError`. `humanizeRateLimit`
  // (packages/shared/src/utils/humanizeAgentError.ts) already inspects the
  // provider label and produces OpenAI-specific long-reset copy (mentioning the
  // rolling window + backup provider guidance) vs the generic short-reset copy
  // for other providers — richer than the prior hardcoded fallback while
  // preserving the provider-branching behaviour.
  dispatchRecoveryErrorEvent(ctx, ctx.error, {
    ...(limitScopeOverride ? { limitScopeOverride } : {}),
    recoveryOwner: 'rate_limit_handler',
  });
  completeTurnCleanup(turnId, 'rate-limit');
  return handled({
    activityEmitted: true,
    proofOfObservability: { logged: true, structured: true },
  });
}


// ---------------------------------------------------------------------------
// Handler 8: Post-Fallback Server Error Retry
// ---------------------------------------------------------------------------

export async function handlePostFallbackServerError(
  ctx: ErrorRecoveryContext,
  isServerErrorRetry: boolean,
  isNetworkFailure: boolean,
): Promise<HandlerOutcome> {
  const isServerErrorAfterFallback = !isServerErrorRetry && !isNetworkFailure && getErrorKind(ctx.error) === 'server_error';
  if (!isServerErrorAfterFallback || ctx.abortController.signal.aborted) {
    return passthrough(
      !isServerErrorAfterFallback
        ? 'not-server-error-after-fallback'
        : 'post-fallback-server-error-skipped:already-aborted',
    );
  }

  const { turnId, turnLogger, abortController, win } = ctx;
  const MAX_SERVER_ERROR_RETRIES = 2;
  const serverRetryCount = agentTurnRegistry.getRetryCount(turnId);

  // Guard: skip retry if real API output (assistant text, tool_use/tool_result,
  // result) has already been streamed — retrying after output was dispatched
  // would cause duplicate replies. Synthetic system:* messages do NOT bump
  // messageCount (filtered at the runner via isApiOutputMessage()).
  // ctx.messageCount also reflects activity from any prior fallback
  // runAgentQuery() in this recovery chain — every site uses the runner's
  // required onApiOutput callback to bump ctx.messageCount.
  const postFallbackGate = restartSafetyGate(ctx, { kind: 'post-fallback-server-error-retry' });
  if (!postFallbackGate.ok) {
    turnLogger.warn(
      { messageCount: ctx.messageCount, context: 'post-fallback', gateReason: postFallbackGate.reason },
      'Post-fallback server error retry skipped — real API output already dispatched'
    );
  } else if (serverRetryCount < MAX_SERVER_ERROR_RETRIES) {
    const nextRetry = agentTurnRegistry.incrementRetryCount(turnId);
    const delayMs = 2000 * Math.pow(2, serverRetryCount) + Math.random() * 1000;

    turnLogger.info(
      { retryCount: nextRetry, maxRetries: MAX_SERVER_ERROR_RETRIES, delayMs, context: 'post-fallback' },
      'Server error post-fallback, retrying automatically...'
    );

    dispatchAgentEvent(win, turnId, {
      type: 'status',
      message: `API service error — retrying automatically (attempt ${nextRetry} of ${MAX_SERVER_ERROR_RETRIES})...`,
      timestamp: Date.now(),
    });

    if (await delayWithAbort(delayMs, abortController.signal)) {
      turnLogger.info('Server error retry cancelled (post-fallback) - turn was aborted by user');
      completeTurnCleanup(turnId, 'aborted');
      return handled({
        activityEmitted: false,
        proofOfObservability: { logged: true, structured: true },
      });
    }

    await ctx.retryTurn();
    return handled({
      activityEmitted: false,
      proofOfObservability: { logged: true, structured: true },
    });
  }

  // Retries exhausted or guard triggered
  turnLogger.error(
    { retryCount: agentTurnRegistry.getRetryCount(turnId), maxRetries: MAX_SERVER_ERROR_RETRIES, context: 'post-fallback' },
    'Server error retries exhausted (post-fallback) - showing error to user'
  );
  dispatchRecoveryErrorEvent(ctx, ctx.error, {
    humanizedOverride: 'The AI service had a rough patch despite several retries. Your message is safe — try again in a moment.',
    providerOverride: getErrorProvider(ctx.error),
    recoveryOwner: 'alt_model_then_server_error_retry',
  });
  completeTurnCleanup(turnId, 'server-error');
  return handled({
    activityEmitted: true,
    proofOfObservability: { logged: true, structured: true },
  });
}


// ---------------------------------------------------------------------------
// Handler 9: Transient Retry
// ---------------------------------------------------------------------------

export async function handleTransientAndProcessExitRetry(ctx: ErrorRecoveryContext): Promise<HandlerOutcome> {
  const { turnId, turnLogger, abortController, messageCount, win } = ctx;

  const errorMessage = getErrorMessage(ctx.error);
  const errorKind = getErrorKind(ctx.error);
  const isTransient = isTransientError(errorMessage, errorKind, { logger: turnLogger });
  const MAX_SILENT_RETRIES = 3;
  const retryCount = agentTurnRegistry.getRetryCount(turnId);

  // Transient error retry — network errors get longer backoff and status events.
  // Empty-result anomalies get one fresh-turn retry before Sentry capture/user
  // messaging so provider-side blank responses do not surface as cryptic errors.
  // Guard: skip retry if real API output has already been streamed (messageCount > 0).
  // Synthetic system:* messages (init/status/warning) do NOT bump messageCount —
  // they're filtered at the runner via isApiOutputMessage(), so a transient error
  // after only "Planning approach..." or similar progress events still gets
  // silently retried. The guard only fires for real assistant content / tool
  // calls / tool results, which would be duplicated by a retry.
  // See: rebel://conversation/10d9eec1-18ea-4591-8b0e-39cf19c9a36d.
  const isEmptyResultAnomaly = errorMessage.includes('empty_result_anomaly');
  // Refusal-shaped empty results are NOT transient: the provider's safety
  // classifier declined the request (stop_reason: 'refusal', e.g. Fable 5),
  // so retrying the identical content is guaranteed to be refused again.
  // Branch on the typed stopReason field — the `empty_result_anomaly`
  // message substring and template must stay untouched (source-text-assertion
  // class; see emptyResultAnomalyError.ts).
  const isRefusalEmptyResult = isEmptyResultAnomalyError(ctx.error) && ctx.error.stopReason === 'refusal';
  if (isEmptyResultAnomaly && !isRefusalEmptyResult && retryCount < 1) {
    const nextRetry = agentTurnRegistry.incrementRetryCount(turnId);
    turnLogger.warn(
      { retryCount: nextRetry, maxRetries: 1, messageCount, errorMessage },
      'empty_result_anomaly — retrying once with a fresh turn before reporting'
    );

    dispatchAgentEvent(win, turnId, {
      type: 'status',
      message: 'Rebel hit a blank response — trying once more...',
      timestamp: Date.now(),
    });

    await ctx.retryTurn({ resetConversation: true });
    return handled({
      activityEmitted: false,
      proofOfObservability: { logged: true, structured: true },
    });
  }

  const transientRetryGate = restartSafetyGate(ctx, { kind: 'transient-retry' });
  if (isTransient && !isEmptyResultAnomaly && transientRetryGate.ok && retryCount < MAX_SILENT_RETRIES) {
    const nextRetry = agentTurnRegistry.incrementRetryCount(turnId);
    const isNetwork = isNetworkError(errorMessage);

    // Network errors need longer delays: WiFi reconnect 5-15s, mobile handoff 10-30s.
    // Non-network transient errors (503, overloaded) keep short delays.
    const baseDelay = isNetwork ? 5000 : 1000;
    const maxDelay = isNetwork ? 30_000 : 8_000;
    const jitter = Math.random() * (isNetwork ? 1000 : 500);
    const delayMs = Math.min(baseDelay * Math.pow(2, retryCount) + jitter, maxDelay);

    turnLogger.info(
      { retryCount: nextRetry, maxRetries: MAX_SILENT_RETRIES, delayMs: Math.round(delayMs), errorMessage, isNetwork },
      isNetwork ? 'Network error — retrying with extended backoff' : 'Transient error, retrying silently...'
    );

    // Surface network retries to the user (non-network retries remain silent)
    if (isNetwork) {
      dispatchAgentEvent(win, turnId, {
        type: 'status',
        message: `Network connection issue — retrying (attempt ${nextRetry} of ${MAX_SILENT_RETRIES})...`,
        timestamp: Date.now(),
      });
    }

    if (!await delayWithAbort(delayMs, abortController.signal)) {
      // Stop main-process checkpointing for THIS attempt before the registry
      // wipes the session mapping. `executeAgentTurn` will re-arm checkpointing
      // for the retry. Idempotent + synchronous.
      getTurnCheckpointManager()?.stopCheckpointing(turnId);
      agentTurnRegistry.cleanupForRetry(turnId);
      await ctx.retryTurn();
      return handled({
        activityEmitted: false,
        proofOfObservability: { logged: true, structured: true },
      });
    }
  } else if (isRefusalEmptyResult) {
    turnLogger.info(
      { messageCount, retryCount, errorMessage, errorCategory: 'empty_result_anomaly', stopReason: 'refusal' },
      'empty_result_anomaly with stop_reason refusal — skipping the futile auto-retry, falling through to graceful degradation (Handler 10)'
    );
  } else if (isEmptyResultAnomaly) {
    turnLogger.info(
      { messageCount, retryCount, errorMessage, errorCategory: 'empty_result_anomaly' },
      'empty_result_anomaly retry already attempted — falling through to graceful degradation (Handler 10)'
    );
  } else if (isTransient && messageCount > 0) {
    turnLogger.warn(
      { messageCount, errorMessage },
      'Transient error retry skipped — agent activity already occurred'
    );
  }

  // No retry was issued. Either: not a transient error (passthrough); or transient
  // retry was skipped because messageCount > 0 / aborted-during-delay / empty-result
  // already retried — in those cases ctx state is untouched and we let the next
  // handler (classifyAndDispatchError) take over.
  return passthrough(
    isRefusalEmptyResult
      ? 'transient-empty-result-anomaly-refusal-no-retry'
      : isEmptyResultAnomaly
      ? 'transient-empty-result-anomaly-already-retried'
      : isTransient
        ? messageCount > 0
          ? 'transient-retry-skipped:message-count'
          : 'transient-retry-skipped:retry-budget-exhausted-or-aborted'
        : 'not-transient-error',
  );
}


// ---------------------------------------------------------------------------
// Handler 10: Error Classification, Sentry, and User Messaging
// ---------------------------------------------------------------------------

/**
 * Final catch-all handler. Classifies the error, captures to Sentry,
 * and dispatches user-facing error messages. Returns `handled` only when
 * it does its own cleanup+return (for example, long context fallback retry,
 * empty-result-anomaly recovery, output-cap retry). The default tail path
 * dispatches the error event but defers cleanup to the dispatcher's terminal
 * step, so it returns `passthrough` with a descriptive reason.
 */
export async function classifyAndDispatchError(ctx: ErrorRecoveryContext): Promise<HandlerOutcome> {
  const {
    turnId, win, turnLogger, abortController, settings,
    hasMedia, mcpMode, rendererSessionId,
    lastMessageType, lastToolName, messageCount,
    extendedContextEnabled, abortedByWatchdog,
    watchdogFired, watchdogFiredAt,
    requestedModelForTurn, workingProfile, availableProfiles, activeProfile, modelConfig,
    isDirectRoleProfile,
    turnOptions,
  } = ctx;

  const retryCountBeforeCleanup = agentTurnRegistry.getRetryCount(turnId);
  agentTurnRegistry.deleteRetryCount(turnId);

  const learnedLimitsModel = modelConfig.model || requestedModelForTurn || 'unknown';
  const learnedLimitsProfileId = activeProfile?.id ?? workingProfile?.id ?? null;
  const learnedLimitWriteResult = safeDispatchLearnedLimitsFromError(ctx.error, {
    turnId,
    model: learnedLimitsModel,
    profileId: learnedLimitsProfileId,
  }, turnLogger);
  const outputCap = getOutputCapFromError(ctx.error);
  if (outputCap !== null) {
    const retryKey = buildOutputCapRetryKey(turnId, learnedLimitsModel, learnedLimitsProfileId);
    const retryAlreadyAttempted = agentTurnRegistry.hasOutputCapRetryAttempted(retryKey);
    const outputCapRetryGate = restartSafetyGate(ctx, { kind: 'output-cap-retry' });
    const canRetryOutputCap = learnedLimitWriteResult?.ok === true
      && outputCapRetryGate.ok
      && !retryAlreadyAttempted;

    if (canRetryOutputCap) {
      agentTurnRegistry.markOutputCapRetryAttempted(retryKey);
      turnLogger.info(
        { retryKey, outputCap, model: learnedLimitsModel, profileId: learnedLimitsProfileId },
        'Output-cap learned from provider 400 — retrying once',
      );
      await ctx.retryTurn();
      return handled({
        activityEmitted: false,
        proofOfObservability: { logged: true, structured: true },
      });
    }

    if (!canRetryOutputCap) {
      const skipReason = learnedLimitWriteResult?.ok !== true
        ? learnedLimitWriteResult?.reason ?? 'no-write'
        : retryAlreadyAttempted
          ? 'retry-latch'
          : messageCount > 0
            ? 'message-count'
            : abortController.signal.aborted
              ? 'aborted'
              : 'unknown';
      turnLogger.info(
        { retryKey, outputCap, model: learnedLimitsModel, profileId: learnedLimitsProfileId, skipReason },
        'Output-cap retry skipped',
      );
    }
  }

  // Graceful degradation for empty result anomaly
  const errorMessage = getErrorMessage(ctx.error);
  if (errorMessage.includes('empty_result_anomaly')) {
    const accumulated = agentTurnRegistry.getContextAccumulator(turnId);

    // Stage 2 guardrail: if a user-question pause signal is still live, the
    // primary pause detection in agentMessageHandler.ts must have regressed —
    // reaching this path with the flag set means we classified a clean pause
    // as an anomaly. Coerce to pause + flag the regression loudly.
    //
    // We require BOTH primary signals (pending flag AND user_question event)
    // to coerce with `pause_type: user_question`. If only the flag is set
    // (event missing), we still coerce — user-visible recovery > false
    // anomaly — but tag it `ambiguous` so the regression is observable in
    // Sentry. See: docs/plans/260420_user_question_cross_surface_resilience.md
    // Stage 2 and multi-model review Finding B.
    if (agentTurnRegistry.hasUserQuestionPending(turnId)) {
      const accumulated = agentTurnRegistry.getContextAccumulator(turnId);
      const turnEvents = accumulated?.eventsByTurn[turnId] ?? [];
      const hasUserQuestionEvent = turnEvents.some((e) => e.type === 'user_question');
      const pauseType: 'user_question' | 'ambiguous' = hasUserQuestionEvent
        ? 'user_question'
        : 'ambiguous';

      turnLogger.error(
        {
          turnId,
          model: requestedModelForTurn || 'unknown',
          provider: workingProfile?.providerType,
          pauseType,
          hasUserQuestionEvent,
        },
        `REGRESSION: empty_result_anomaly reached error recovery despite hasUserQuestionPending (pause_type: ${pauseType}) — Stage 1 pause detection missed it. Coercing to clean pause.`
      );
      captureKnownCondition(
        'recovery_pause_detection_missed',
        {
          tags: {
            source: 'rebel-core-runtime',
            sdk_error_category: 'empty_result_anomaly',
            pause_type: pauseType,
            regression: 'pause_detection_missed',
            model: requestedModelForTurn || 'unknown',
            ...(workingProfile?.providerType ? { provider: workingProfile.providerType } : {}),
          },
          extra: {
            turnId,
            originalError: errorMessage,
            hasUserQuestionEvent,
          },
        },
        new Error('empty_result_anomaly_despite_user_question_pending'),
      );
      // Dispatch a clean empty result so the renderer treats the turn as
      // cleanly paused (the user-question card is already displayed via the
      // user_question event dispatched earlier by userQuestionHook).
      dispatchAgentEvent(win, turnId, makeSyntheticResult(turnId, '', 'awaiting_user'));
      completeTurnCleanup(turnId, 'completed-pause-coerced');
      return handled({
        activityEmitted: true,
        proofOfObservability: {
          logged: true,
          structured: true,
          sentryClass: 'empty_result_anomaly_despite_user_question_pending',
        },
      });
    }

    // Identify the model for diagnostic context (included in Sentry + user message)
    const degradationModel = requestedModelForTurn || 'unknown';
    const degradationProvider = workingProfile?.providerType;

    // Extract typed token diagnostics from EmptyResultAnomalyError (if present).
    // These become searchable Sentry extras so we can confirm the fix's hypothesis:
    // genuine anomalies should have lastTurnOutputTokens > 0 or undefined (legacy).
    // See: docs/plans/260417_empty_result_anomaly_resilience.md
    const anomalyDiagnostics = isEmptyResultAnomalyError(ctx.error)
      ? {
          last_turn_output_tokens: ctx.error.lastTurnOutputTokens ?? null,
          loop_total_output_tokens: ctx.error.loopTotalOutputTokens,
          stop_reason: ctx.error.stopReason ?? null,
        }
      : undefined;

    // Refusal classification (Fable 5 Stage 6): the provider's safety
    // classifier declined the request, so "try asking again" would be
    // dishonest advice — an identical re-ask is guaranteed to be re-refused.
    // Branch on the typed stopReason field (never the message string).
    const isRefusalAnomaly = isEmptyResultAnomalyError(ctx.error) && ctx.error.stopReason === 'refusal';
    const REFUSAL_DEGRADATION_MESSAGE =
      `Anthropic's safety system declined this request. Rephrasing might help; asking again as-is won't.`;

    // Priority 1: recover from accumulated assistant text (most useful for the user)
    if (accumulated && accumulated.messages.length > 0) {
      const lastAssistantMessage = accumulated.messages
        .filter((m: { role: string }) => m.role === 'assistant')
        .pop();

      if (lastAssistantMessage?.text) {
        turnLogger.info(
          { messageCount: accumulated.messages.length, model: degradationModel, provider: degradationProvider },
          'Using accumulated content as graceful degradation for empty result'
        );

        captureKnownCondition(
          'recovery_empty_result_anomaly',
          {
            classification: 'text_recovery',
            tags: {
              source: 'rebel-core-runtime',
              sdk_error_category: 'empty_result_anomaly',
              empty_result_classification: 'text_recovery',
              degradation_type: 'text_recovery',
              model: degradationModel,
              ...(degradationProvider ? { provider: degradationProvider } : {}),
            },
            extra: {
              turnId,
              messageCount: accumulated.messages.length,
              ...anomalyDiagnostics,
            },
          },
          errorOrUndefined(ctx.error),
        );

        dispatchAgentEvent(win, turnId, makeSyntheticResult(
          turnId,
          lastAssistantMessage.text +
            '\n\n[Note: Response was partially recovered due to a connection issue]',
          'error',
        ));

        completeTurnCleanup(turnId, 'completed-graceful-degradation');
        return handled({
          activityEmitted: true,
          proofOfObservability: { logged: true, structured: true },
        });
      }
    }

    // Priority 2: no assistant text, but tools ran successfully — acknowledge partial work.
    // This check is outside the messages.length guard because the accumulator may have
    // tool events in eventsByTurn without any messages entries (tool events don't create messages).
    //
    // Guard: Only use tool-recovery when the model actually produced output tokens.
    // When loopTotalOutputTokens === 0, any tool events in the accumulator are from
    // framework/setup tools (e.g. MissionSet, file_search) that run before the model
    // responds — not from model-invoked actions. Showing "completed some actions" for
    // these is misleading. Fall through to the generic error path instead.
    const canUseToolRecovery =
      !isEmptyResultAnomalyError(ctx.error) ||
      ctx.error.loopTotalOutputTokens > 0;
    if (canUseToolRecovery && accumulated) {
      const turnEvents = accumulated.eventsByTurn[turnId] ?? [];
      // A tool event counts as "real execution" only when it represents
      // user-visible model-invoked work — not bookkeeping (MissionSet/TaskList/etc)
      // and not synthetic plan-seed or pre-turn-context events. Without both
      // gates, planning artifacts trick the recovery path into emitting
      // "completed some actions" when nothing meaningful actually happened.
      const isMeaningfulToolEnd = (e: typeof turnEvents[number]): boolean =>
        e.type === 'tool'
        && e.stage === 'end'
        && !e.isError
        && !BOOKKEEPING_TOOL_NAMES.has(e.toolName)
        && (e._origin === undefined || e._origin === 'real');
      const successfulToolCount = turnEvents.filter(isMeaningfulToolEnd).length;
      if (successfulToolCount > 0) {
        // Summarize which tools ran for diagnostics
        const toolNames = turnEvents
          .filter(isMeaningfulToolEnd)
          .map((e) => ('toolName' in e ? (e.toolName as string) : 'unknown'));
        turnLogger.warn(
          { successfulToolCount, messageCount: accumulated.messages.length, model: degradationModel, provider: degradationProvider, toolNames },
          'Tool-result graceful degradation — tools completed but no assistant text'
        );

        captureKnownCondition(
          'recovery_empty_result_anomaly',
          {
            classification: 'tool_recovery',
            tags: {
              source: 'rebel-core-runtime',
              sdk_error_category: 'empty_result_anomaly',
              empty_result_classification: 'tool_recovery',
              degradation_type: 'tool_recovery',
              model: degradationModel,
              ...(degradationProvider ? { provider: degradationProvider } : {}),
            },
            extra: {
              turnId,
              successfulToolCount,
              toolNames,
              ...anomalyDiagnostics,
            },
          },
          errorOrUndefined(ctx.error),
        );

        const providerHint = degradationProvider
          ? ` This may be caused by an incomplete response from your model provider.`
          : '';
        dispatchAgentEvent(win, turnId, makeSyntheticResult(
          turnId,
          `I completed some actions but the final response was lost.${providerHint} Please resend your message so I can finish up.`,
          'error',
        ));

        completeTurnCleanup(turnId, 'completed-graceful-degradation-from-tools');
        return handled({
          activityEmitted: true,
          proofOfObservability: { logged: true, structured: true },
        });
      }
    }

    // Priority 3: zero-output anomaly with no recoverable content.
    // The model returned 0 tokens (provider glitch or empty response). No text
    // or tool-based recovery is possible. Show a clear, non-technical message
    // instead of falling through to the generic error handler.
    if (isEmptyResultAnomalyError(ctx.error) && ctx.error.loopTotalOutputTokens === 0) {
      turnLogger.warn(
        { model: degradationModel, provider: degradationProvider, retryAttempted: retryCountBeforeCleanup > 0, refusal: isRefusalAnomaly },
        isRefusalAnomaly
          ? 'Pre-output refusal (stop_reason: refusal) with no recoverable content — showing refusal message'
          : 'Zero-output anomaly with no recoverable content — showing dedicated retry message'
      );

      captureKnownCondition(
        'recovery_empty_result_anomaly',
        {
          classification: isRefusalAnomaly ? 'refusal' : 'zero_output_no_recovery',
          tags: {
            source: 'rebel-core-runtime',
            sdk_error_category: 'empty_result_anomaly',
            empty_result_classification: isRefusalAnomaly ? 'refusal' : 'zero_output_no_recovery',
            empty_result_retry_attempted: String(retryCountBeforeCleanup > 0),
            model: degradationModel,
            ...(degradationProvider ? { provider: degradationProvider } : {}),
          },
          extra: { turnId, ...anomalyDiagnostics },
        },
        errorOrUndefined(ctx.error),
      );

      dispatchAgentEvent(win, turnId, makeSyntheticResult(
        turnId,
        isRefusalAnomaly
          ? REFUSAL_DEGRADATION_MESSAGE
          : `Rebel couldn't complete that thought. Try asking again.`,
        'error',
      ));

      completeTurnCleanup(turnId, 'completed-zero-output-no-recovery');
      return handled({
        activityEmitted: true,
        proofOfObservability: { logged: true, structured: true },
      });
    }

    turnLogger.warn(
      { model: degradationModel, provider: degradationProvider, retryAttempted: retryCountBeforeCleanup > 0, refusal: isRefusalAnomaly },
      isRefusalAnomaly
        ? 'Refusal (stop_reason: refusal) with no recoverable content — showing refusal message'
        : 'Empty-result anomaly with no recoverable content — showing friendly retry message'
    );

    captureKnownCondition(
      'recovery_empty_result_anomaly',
      {
        classification: isRefusalAnomaly ? 'refusal' : 'retry_failed_no_recovery',
        tags: {
          source: 'rebel-core-runtime',
          sdk_error_category: 'empty_result_anomaly',
          empty_result_classification: isRefusalAnomaly ? 'refusal' : 'retry_failed_no_recovery',
          empty_result_retry_attempted: String(retryCountBeforeCleanup > 0),
          model: degradationModel,
          ...(degradationProvider ? { provider: degradationProvider } : {}),
        },
        extra: {
          turnId,
          ...anomalyDiagnostics,
        },
      },
      errorOrUndefined(ctx.error),
    );

    dispatchAgentEvent(win, turnId, makeSyntheticResult(
      turnId,
      isRefusalAnomaly
        ? REFUSAL_DEGRADATION_MESSAGE
        : `Rebel couldn't complete that thought. Try asking again.`,
      'error',
    ));

    completeTurnCleanup(turnId, 'completed-empty-result-no-recovery');
    return handled({
      activityEmitted: true,
      proofOfObservability: { logged: true, structured: true },
    });
  }

  // Detect specific error types for user messaging.
  // The substring cascade that previously lived inline is now `classifyError`
  // (`turnErrorRecovery/errorClassification.ts`); this site composes the typed
  // result with `hasMedia` and `outputCap` to derive the same booleans.
  const currentErrorMessage = getErrorMessage(ctx.error);
  const classification = classifyError(ctx.error);

  const isStreamClosedError = classification.kind === 'stream-closed';
  const isRequestTooLargeError = classification.kind === 'request-too-large';
  const isAnthropicImageSizeError = classification.kind === 'image-exceeds-limit';
  const isAttachmentSizeError =
    (isRequestTooLargeError && hasMedia) || isAnthropicImageSizeError;

  const isOutputCapError = outputCap !== null;
  const isPromptTooLongError =
    !isAttachmentSizeError && classification.kind === 'prompt-too-long';
  const isContextOverflowError =
    !isAttachmentSizeError &&
    !isOutputCapError &&
    (classification.kind === 'context-overflow' ||
      (classification.kind === 'request-too-large' && classification.alsoContextOverflow));

  const isSchemaValidationError = classification.kind === 'schema-validation';
  const isStructuredOutputSchemaRejected = isStructuredOutputSchemaRejection(ctx.error);
  const isToolNameTooLongError = isToolNameLengthError(currentErrorMessage);

  const isMessageTimeout = ctx.error instanceof Error && ctx.error.name === 'MessageTimeoutError';

  // Determine error category for Sentry tagging.
  // Fine-grained heuristics first (Sentry subcategories finer than AgentErrorKind),
  // then fall back to getErrorKind() for structured classification (billing, auth, rate_limit, etc.).
  let errorCategory: string = 'unknown';
  if (isStreamClosedError) errorCategory = 'stream_closed';
  else if (isAttachmentSizeError) errorCategory = 'attachment_size';
  else if (isPromptTooLongError || isContextOverflowError) errorCategory = 'context_overflow';
  else if (isMessageTimeout) errorCategory = 'message_timeout';
  else if (classification.kind === 'process-exit') errorCategory = 'process_exit';
  else if (classification.kind === 'transport-not-ready') errorCategory = 'transport_not_ready';
  else if (isStructuredOutputSchemaRejected) errorCategory = 'structured_output_schema_rejected';
  else if (isSchemaValidationError) errorCategory = 'schema_validation';
  else if (isToolNameTooLongError) errorCategory = 'tool_name_too_long';
  else {
    const structuredKind = getErrorKind(ctx.error);
    if (structuredKind !== 'unknown') errorCategory = structuredKind;
  }

  turnLogger.error(
    {
      err: ctx.error,
      isStreamClosedError,
      isAttachmentSizeError,
      isPromptTooLongError,
      isOutputCapError,
      isContextOverflowError,
      isSchemaValidationError,
      isStructuredOutputSchemaRejected,
      isToolNameTooLongError,
      errorCategory,
      hasMedia,
      raceConditionDetected: isStreamClosedError,
      activeConcurrentTurns: agentTurnRegistry.getActiveTurnCount(),
      mcpMode: mcpMode ?? 'unknown',
    },
    isStreamClosedError
      ? 'RACE CONDITION: Agent turn failed with stream closed error'
      : isAttachmentSizeError
        ? 'ATTACHMENT SIZE: Agent turn failed due to oversized attachment'
        : isPromptTooLongError || isContextOverflowError
          ? 'CONTEXT OVERFLOW: Agent turn failed due to prompt/context size'
          : isStructuredOutputSchemaRejected
            ? 'STRUCTURED OUTPUT SCHEMA REJECTED: Provider rejected our planner response_format/output_config schema (provider-dialect drift; see planSchemaProviderCompat.test.ts)'
            : isSchemaValidationError
              ? 'SCHEMA VALIDATION: Agent turn failed - MCP tool has invalid JSON schema (check MCP server compatibility)'
              : isToolNameTooLongError
                ? 'TOOL NAME TOO LONG: Agent turn failed - MCP tool name exceeds API limit (check MCP server tool names)'
                : 'Agent turn failed'
  );

  // Sentry capture. For empty_result_anomaly errors that fell through both
  // recovery branches (no accumulator content), include typed token diagnostics
  // and tag as "no_recovery" so it's distinguishable from recoverable cases.
  const fallthroughAnomalyDiagnostics = isEmptyResultAnomalyError(ctx.error)
    ? {
        last_turn_output_tokens: ctx.error.lastTurnOutputTokens ?? null,
        loop_total_output_tokens: ctx.error.loopTotalOutputTokens,
        stop_reason: ctx.error.stopReason ?? null,
      }
    : undefined;

  // For empty_result_anomaly no-recovery events, override sdk_error_category to
  // preserve continuity with Sentry searches/dashboards that key on
  // sdk_error_category=empty_result_anomaly. Without this override, no-recovery
  // events would land under 'unknown' while the recovery branches still use
  // 'empty_result_anomaly', fracturing the tag space.
  const fallthroughCategory = fallthroughAnomalyDiagnostics
    ? 'empty_result_anomaly'
    : errorCategory;
  const fallthroughModel = isEmptyResultAnomalyError(ctx.error) ? ctx.error.model : undefined;

  const isExpectedTimeoutForSentry = isMessageTimeout || classification.kind === 'expected-operational-timeout';
  const shouldCaptureToSentry = !isExpectedTimeoutForSentry ||
    shouldCaptureExpectedTimeoutToSentry(ctx, fallthroughCategory);

  if (shouldCaptureToSentry) {
    // REBEL-1AR: ModelError messages contain raw 400 JSON bodies with request_id,
    // per-variant strategy names (e.g. 'compact_20260112'), and other high-cardinality
    // tokens that fragment Sentry grouping into hundreds of near-duplicate issues.
    // Route through captureKnownCondition('model_error', ...) so the fingerprint
    // ['model-error', kind, provider ?? 'unknown', upstreamProvider ?? 'none']
    // is owned by the registry and stays consistent across capture sites.
    const sentryTags = {
      source: 'rebel-core-runtime',
      sdk_error_category: fallthroughCategory,
      mcp_mode: mcpMode ?? 'unknown',
      ...(fallthroughAnomalyDiagnostics
        ? {
            empty_result_classification: 'no_recovery',
            ...(fallthroughModel ? { model: fallthroughModel } : {}),
          }
        : {}),
    } as const;
    const sentryExtra = {
      turnId,
      activeConcurrentTurns: agentTurnRegistry.getActiveTurnCount(),
      errorCode: (ctx.error as Record<string, unknown>)?.code,
      errorErrno: (ctx.error as Record<string, unknown>)?.errno,
      errorSyscall: (ctx.error as Record<string, unknown>)?.syscall,
      ...fallthroughAnomalyDiagnostics,
    };

    if (ctx.error instanceof ModelError) {
      captureKnownCondition(
        'model_error',
        {
          kind: ctx.error.kind,
          provider: ctx.error.provider,
          upstreamProvider: ctx.error.upstreamProvider,
          tags: sentryTags,
          extra: sentryExtra,
        },
        ctx.error,
      );
    } else {
      captureKnownCondition(
        'recovery_unknown_error',
        {
          tags: sentryTags,
          extra: sentryExtra,
        },
        errorOrUndefined(ctx.error),
      );
    }
  } else {
    turnLogger.info(
      { fallthroughCategory, rendererSessionId, turnId },
      'Expected timeout already reported for this session; suppressing duplicate Sentry capture',
    );
  }

  // Track watchdog outcome when turn fails after watchdog fired
  if (watchdogFired && watchdogFiredAt && !abortedByWatchdog) {
    const stallDurationMs = Date.now() - watchdogFiredAt;
    const phase = inferWatchdogPhase(lastMessageType);
    const effectiveIsAbortError = abortController.signal.aborted;
    const outcome = effectiveIsAbortError ? 'aborted' : 'error';
    turnLogger.warn(
      { stallDurationMs, outcome, phase, lastMessageType, lastToolName },
      'Watchdog was active when turn failed'
    );
  }

  // Dispatch user-facing error messages by category
  if (isAttachmentSizeError) {
    const attachmentSizeCopy = isAnthropicImageSizeError
      ? 'One of your images is over the 5 MB per-image limit. Try a smaller or lower-resolution version.'
      : 'Your attachment exceeds the 32MB API limit. Please use a smaller file and try again.';
    turnLogger.info(
      { hasMedia, errorCategory, isAnthropicImageSizeError },
      'Attachment size error - dispatching user-friendly error (not context_overflow)'
    );
    dispatchRecoveryErrorEvent(ctx, new Error(attachmentSizeCopy), {
      humanizedOverride: attachmentSizeCopy,
      recoveryOwner: 'classify_and_dispatch_tail',
    });
  } else if (isPromptTooLongError || isContextOverflowError) {
    const resolveLongContextFallbackTarget = (): LongContextFallbackTarget | null => {
      const fallbackProfileId = getContextOverflowFallbackProfileId(settings);
      if (fallbackProfileId) {
        const profile = availableProfiles.find((p) => p.id === fallbackProfileId);
        if (profile?.model) {
          return {
            kind: 'profile',
            profileId: profile.id,
            profileName: profile.name,
            modelName: profile.model,
          };
        }
      }
      const fallbackModel = getContextOverflowFallbackModel(settings);
      return fallbackModel ? { kind: 'model', modelName: fallbackModel } : null;
    };

    const longContextFallbackTarget = resolveLongContextFallbackTarget();
    const alreadyTriedLongContextFallback = turnOptions?.longContextFallbackAttempted === true;
    const fallbackIsCurrentTarget =
      longContextFallbackTarget?.kind === 'profile'
        ? workingProfile?.id === longContextFallbackTarget.profileId
        : longContextFallbackTarget?.kind === 'model'
          ? longContextFallbackTarget.modelName === requestedModelForTurn
          : true;
    // Guard: skip long-context fallback if agent messages were already received.
    // retryTurn() re-runs the full pipeline on the same turnId without clearing
    // prior output, so already-dispatched events would be duplicated.
    const longContextFallbackGate = restartSafetyGate(ctx, { kind: 'long-context-fallback' });
    const canTryLongContextFallback =
      !!longContextFallbackTarget &&
      !fallbackIsCurrentTarget &&
      !alreadyTriedLongContextFallback &&
      longContextFallbackGate.ok;

    if (!canTryLongContextFallback && longContextFallbackTarget && !alreadyTriedLongContextFallback) {
      const reason = messageCount > 0
        ? 'Agent activity already occurred — retrying would duplicate output'
        : fallbackIsCurrentTarget
          ? 'fallback target is same as current model'
          : 'turn was aborted';
      turnLogger.info(
        { fallbackTarget: longContextFallbackTarget, reason },
        'Long-context fallback configured but skipped - proceeding to compaction'
      );
    }

    if (canTryLongContextFallback) {
      const toLabel = longContextFallbackTarget.kind === 'profile'
        ? longContextFallbackTarget.profileName
        : longContextFallbackTarget.modelName;
      const fromLabel = workingProfile?.name ?? requestedModelForTurn;
      turnLogger.warn(
        { fromModel: fromLabel, toModel: toLabel },
        'Context overflow detected - retrying once with configured long-context fallback model'
      );
      dispatchAgentEvent(win, turnId, {
        type: 'status',
        message: `Context limit reached. Switching to ${toLabel}...`,
        timestamp: Date.now(),
      });
      agentTurnRegistry.addTurnFallback(turnId, {
        type: 'model',
        from: fromLabel,
        to: toLabel,
        reason: 'context-overflow-long-context-fallback',
      });
      // 260508 Stage 2 (R2-3): re-arm the renderer's `answer_phase_started`
      // barrier marker before the legacy long-context fallback fires. Some
      // call paths reach this branch outside `recoveryPipeline` (turn-error
      // recovery owns its own legacy ladder), so we clear the sentinel
      // directly here. Idempotent — `clearAnswerPhaseStartedSentinel` is a
      // safe no-op when the turn never emitted a delta.
      clearAnswerPhaseStartedSentinel(turnId);

      if (longContextFallbackTarget.kind === 'profile') {
        await ctx.retryTurn({
          workingProfileOverrideId: longContextFallbackTarget.profileId,
          modelOverride: undefined,
          longContextFallbackAttempted: true,
          routeRebuildHint: {
            kind: 'long-context-profile',
            profileId: longContextFallbackTarget.profileId,
          },
          inFlightProviderRoutePlan: ctx.plan,
          existingAbortController: abortController,
        });
      } else {
        await ctx.retryTurn({
          modelOverride: longContextFallbackTarget.modelName,
          longContextFallbackAttempted: true,
          routeRebuildHint: {
            kind: 'alt-model',
            model: longContextFallbackTarget.modelName,
          },
          inFlightProviderRoutePlan: ctx.plan,
          existingAbortController: abortController,
        });
      }
      return handled({
        activityEmitted: true,
        proofOfObservability: { logged: true, structured: true },
      });
    }

    // Handle context overflow — dispatch recovery event for compaction
    if (agentTurnRegistry.hasContextOverflowDispatched(turnId)) {
      turnLogger.info('Context overflow already dispatched for this turn, skipping duplicate');
    } else {
      agentTurnRegistry.markContextOverflowDispatched(turnId);
      const originalPrompt = agentTurnRegistry.getTurnPrompt(turnId) ?? '';
      turnLogger.info(
        { originalPromptLength: originalPrompt.length, extendedContextEnabled },
        'Context overflow error - dispatching recovery event for compaction'
      );
      dispatchAgentEvent(win, turnId, {
        type: 'context_overflow',
        originalPrompt,
        timestamp: Date.now(),
      });
    }
  } else if (isStructuredOutputSchemaRejected) {
    const copy = humanizeStructuredOutputSchemaRejection();
    turnLogger.error(
      {
        errorCategory,
        provider: getErrorProvider(ctx.error),
        rawMessage: getRawErrorMessage(ctx.error),
      },
      'STRUCTURED OUTPUT SCHEMA REJECTED: provider rejected planner response_format/output_config schema'
    );
    dispatchRecoveryErrorEvent(ctx, ctx.error, {
      humanizedOverride: copy,
      recoveryOwner: 'classify_and_dispatch_tail',
    });
  } else if (isSchemaValidationError) {
    const invalidConfigCopy = 'One of your connected tools has an invalid configuration. Try disabling recently added MCP servers in Settings, or check Settings > Diagnose for details.';
    turnLogger.info({ errorCategory }, 'Schema validation error - dispatching user-friendly error for MCP tool configuration issue');
    dispatchRecoveryErrorEvent(ctx, new Error(invalidConfigCopy), {
      humanizedOverride: invalidConfigCopy,
      recoveryOwner: 'classify_and_dispatch_tail',
    });
  } else if (isMessageTimeout) {
    const isAnthropicTurn = !isDirectRoleProfile;
    const timeoutReason = (ctx.error as { reason?: string }).reason;
    const timeoutRearmCount = (ctx.error as { rearmCount?: number }).rearmCount;
    const timeoutMs = (ctx.error as { timeoutMs?: number }).timeoutMs;
    const timeoutMinutes = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)
      ? Math.max(1, Math.round(timeoutMs / 60_000))
      : 10;
    const isHardCap = timeoutReason === 'hard_cap';

    // Skip network/API diagnostics for hard_cap timeouts -- the stream was actively
    // receiving data, it just exceeded the absolute maximum wait time.
    let diagnostic: TimeoutDiagnosticResult = { kind: 'transient_stall' };
    if (!isHardCap && isAnthropicTurn) {
      try {
        diagnostic = await diagnoseTimeout();
      } catch (err) {
        turnLogger.warn({ err }, 'Timeout diagnostics failed — defaulting to transient_stall');
      }
    }

    const hasToolActivity = messageCount > 0;
    const postToolSuffix = hasToolActivity
      ? ' Please review anything it changed, then retry.'
      : '';

    let userMessage: string;
    if (isHardCap) {
      userMessage = `The response took too long to complete (over ${timeoutMinutes} minutes). Your message is safe — try again or simplify the request.${postToolSuffix}`;
    } else {
      switch (diagnostic.kind) {
        case 'anthropic_issue':
          userMessage = `Claude seems to be having a moment (status: ${diagnostic.indicator}). This is on their side — check status.anthropic.com for updates.${postToolSuffix}`;
          break;
        case 'internet_unreachable':
          userMessage = `I couldn't reach the internet just now. Check your connection, then try again.${postToolSuffix}`;
          break;
        case 'transient_stall':
        default:
          userMessage = `Rebel was thinking but didn't respond for ${timeoutMinutes} minutes. Your message is safe — try sending it again.${postToolSuffix}`;
          break;
      }
    }

    turnLogger.info(
      { errorCategory, messageCount, diagnosticKind: isHardCap ? 'hard_cap' : diagnostic.kind, hasToolActivity, isAnthropicTurn, timeoutReason, timeoutRearmCount },
      isHardCap ? 'Message timeout: hard cap exceeded (stream was active but exceeded absolute maximum)' : 'Message timeout with diagnostics',
    );

    dispatchRecoveryErrorEvent(ctx, ctx.error, {
      humanizedOverride: userMessage,
      isTransient: true,
      errorKindOverride: 'message_timeout',
      timeoutDiagnostic: {
        kind: diagnostic.kind,
        ...(diagnostic.kind === 'anthropic_issue' ? {
          indicator: diagnostic.indicator,
          description: diagnostic.description,
        } : {}),
      },
      recoveryOwner: 'classify_and_dispatch_tail',
    });
  } else if (isToolNameTooLongError) {
    const toolNameTooLongCopy = "One of your MCP tools has a name that's too long for the AI provider. Try disconnecting MCP servers with unusually long tool names, or contact the tool developer.";
    turnLogger.info({ errorCategory, rendererSessionId }, 'Tool name too long error - dispatching user-friendly error for MCP tool name length issue');
    dispatchRecoveryErrorEvent(ctx, new Error(toolNameTooLongCopy), {
      humanizedOverride: toolNameTooLongCopy,
      recoveryOwner: 'classify_and_dispatch_tail',
    });
  } else {
    const rawMessage = getErrorMessage(ctx.error) || 'Unknown agent error.';
    const errorKind = getErrorKind(ctx.error);
    const isTransient = isTransientError(rawMessage, errorKind, { logger: turnLogger });
    const userManagedProfile = activeProfile ?? workingProfile;
    const hasUserManagedOutputCap =
      outputCap !== null
      && (
        userManagedProfile?.outputTokensSource === 'user'
        || (learnedLimitWriteResult?.ok === false && learnedLimitWriteResult.reason === 'user-source')
      );

    if (hasUserManagedOutputCap) {
      const userManagedCopy =
        `This model maxes at ${outputCap} output tokens. Lower the cap in Settings → Models, or remove your override to let Rebel auto-detect.`;
      dispatchRecoveryErrorEvent(ctx, ctx.error, {
        humanizedOverride: userManagedCopy,
        isTransient,
        recoveryOwner: 'classify_and_dispatch_tail',
      });
    } else {
      dispatchRecoveryErrorEvent(ctx, ctx.error, {
        isTransient,
        recoveryOwner: 'classify_and_dispatch_tail',
      });
    }
  }

  // Tail path: an error event was dispatched (or scheduled to be dispatched
  // earlier in this branch ladder). Final completeTurnCleanup happens at the
  // end of `dispatchErrorRecovery` with reason 'error' / 'aborted' /
  // 'watchdog-aborted'. We return passthrough so the dispatcher continues to
  // its terminal cleanup step rather than returning early.
  return passthrough('error-event-dispatched-cleanup-deferred-to-dispatcher-terminal');
}


// ---------------------------------------------------------------------------
// Main Dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch error recovery for a failed agent turn.
 * Called from the executor's catch block. Mirrors the original handler chain.
 *
 * Each handler returns a typed `HandlerOutcome`:
 *   - `kind: 'handled'`     → dispatcher returns immediately (cleanup done).
 *   - `kind: 'passthrough'` → dispatcher continues to next handler (or, for the
 *                             abort/terminal-error tail, lets a downstream
 *                             gate run cleanup with the right reason).
 *   - `kind: 'soft-failed'` → handler tried & failed; ctx.error reassigned;
 *                             dispatcher continues to next handler.
 */
export async function dispatchErrorRecovery(ctx: ErrorRecoveryContext): Promise<void> {
  // 1. Abort handling — dispatches user-facing events for all abort types.
  //    Returns `handled` only for upstream abort (has its own cleanup).
  //    Watchdog/user/superseded paths return `passthrough` so the next gate
  //    (aborted-state) runs the right-reasoned cleanup.
  if ((handleAbortErrors(ctx)).kind === 'handled') return;

  // Watchdog/user abort: events already dispatched above, skip to final cleanup
  if (ctx.abortController.signal.aborted || getErrorName(ctx.error) === 'AbortError') {
    const cleanupReason = ctx.abortedByWatchdog ? 'watchdog-aborted' : 'aborted';
    completeTurnCleanup(ctx.turnId, cleanupReason);
    return;
  }

  // 1.5. Tool input too large — the stream cap fired. Terminal: no retry,
  // no model fallback (same input would re-hit the cap). Must run before
  // context/rate-limit/alt-model handlers so they don't mis-classify it.
  if (handleToolInputTooLarge(ctx).kind === 'handled') return;

  // 1.6. Fail-fast-offline — runWithRetry's reachability probe confirmed the
  // machine is offline and stopped retrying. Terminal: no retry, no model
  // fallback (the network is down; switching providers/retrying re-storms).
  // MUST precede alt-model / server-error / transient-retry handlers, which
  // would otherwise re-issue this `message_timeout`-class error over the dead
  // network. See handleOfflineFailFast.
  if (handleOfflineFailFast(ctx).kind === 'handled') return;

  // 2. Extended context fallback
  if ((await handleExtendedContextFallback(ctx)).kind === 'handled') return;

  // 2.5. Chat-incompatibility auto-mark — fire-and-forget before ThinkingModel handler
  // which also catches model_unavailable. This persists the incompatible verdict so
  // subsequent turns/BTS calls fail fast instead of hitting the provider repeatedly.
  if (isChatIncompatibilityError(ctx.error) && ctx.activeProfile?.id) {
    const activeProfileId = ctx.activeProfile.id;
    try {
      const settings = getSettings();
      const localModel = settings.localModel;
      const profiles = localModel?.profiles;
      if (profiles) {
        const target = profiles.find(p => p.id === activeProfileId);
        if (target && target.chatCompatibility !== 'incompatible') {
          const updatedProfiles = profiles.map(p =>
            p.id === activeProfileId
              ? { ...p, chatCompatibility: 'incompatible' as const, chatCompatibilityCheckedAt: new Date().toISOString() }
              : p
          );
          updateSettings({ localModel: { ...localModel, profiles: updatedProfiles } });
          ctx.turnLogger.info(
            { profileId: activeProfileId },
            'Auto-marked profile as chat-incompatible after runtime error'
          );
        }
      }
    } catch {
      // Non-fatal — the error will still be dispatched to the user
    }
  }

  // 2.6. Tool-use-incompatibility auto-mark (Gemini thought_signature; REBEL-5RJ
  // variant 2) — fire-and-forget, mirroring the chat-incompat mark above. Persists
  // the verdict so the profile shows the "No Tools" badge and a future routing
  // consumer can steer away; the actionable banner still fires this turn. The
  // gateway can't round-trip the tool-call signature, so this is record-not-fix.
  if (isToolUseIncompatibilityError(ctx.error) && ctx.activeProfile?.id) {
    const activeProfileId = ctx.activeProfile.id;
    try {
      const settings = getSettings();
      const localModel = settings.localModel;
      const profiles = localModel?.profiles;
      if (profiles) {
        const target = profiles.find(p => p.id === activeProfileId);
        if (target && target.toolUseCompatibility !== 'incompatible') {
          const updatedProfiles = profiles.map(p =>
            p.id === activeProfileId
              ? { ...p, toolUseCompatibility: 'incompatible' as const, toolUseCompatibilityCheckedAt: new Date().toISOString() }
              : p
          );
          updateSettings({ localModel: { ...localModel, profiles: updatedProfiles } });
          ctx.turnLogger.info(
            { profileId: activeProfileId },
            'Auto-marked profile as tool-use-incompatible after runtime error'
          );
        }
      }
    } catch {
      // Non-fatal — the error will still be dispatched to the user
    }
  }

  // 3. Thinking model fallback
  if ((await handleThinkingModelFallback(ctx)).kind === 'handled') return;

  // 4-5. Alt-model and server error handlers share routing variables.
  //      Compute from (potentially modified) ctx.error.
  //      Network errors bypass alt-model fallback and server-error handlers —
  //      switching providers doesn't help when the user's connection is down.
  //      The minted kind is authoritative; the string check remains a fallback
  //      only for un-minted legacy/network-shaped errors. They flow to handler 9
  //      (transient retry), which has more retries and longer backoff.
  const errorMessage = getErrorMessage(ctx.error);
  const errorKind = getErrorKind(ctx.error);
  const isNetworkFailure = errorKind === 'network' || (errorKind === 'unknown' && isNetworkError(errorMessage));
  const recoveryOwner = ownerForRecoveryKind(errorKind);
  const rawIsServerError = recoveryOwner === 'alt_model_then_server_error_retry';
  const isServerErrorRetry = rawIsServerError && !isNetworkFailure;
  // Stage 1 carve-out: rate_limit ownership is explicit in RECOVERY_OWNER_BY_KIND,
  // so direct-role 429s now bypass alt-model and flow to handleRateLimitFallback.
  const isTransientForAltModel = recoveryOwner === 'alt_model_then_transient_retry'
    && !isNetworkFailure
    && isTransientError(errorMessage, errorKind, { logger: ctx.turnLogger });
  const isAltModelError = (isServerErrorRetry || isTransientForAltModel)
    && ctx.isDirectRoleProfile && !ctx.altModelFallbackAttempted;

  if (isNetworkFailure && ctx.isDirectRoleProfile) {
    ctx.turnLogger.info(
      { errorMessage, rawIsServerError },
      'Network error detected — bypassing alt-model fallback, routing to transient retry handler'
    );
  }

  // 4.4. Managed-tier model not allowed — must precede billing handler. Both surface as
  // 4xx from the Mindstone proxy; the model-not-allowed subtype must win over generic
  // billing classification so the renderer banner shows the allow-list rather than
  // generic billing copy. Non-retryable, no alt-model fallback (user must pick a model
  // in their tier or upgrade). See § G3 in planning doc.
  if ((await handleManagedModelNotAllowed(ctx)).kind === 'handled') return;

  // 4.5. Billing error — must precede alt-model fallback, server error retry, and rate limit
  // handlers. Billing/quota errors are permanent (non-retryable), so no fallback or retry
  // should be attempted. This prevents text-based heuristics from misclassifying billing
  // errors as transient rate limits.
  if ((await handleBillingError(ctx)).kind === 'handled') return;

  // 4.6. Provider-chain recovery "C" (Stage 3, flag-gated) — routes direct-role
  // server/transient recovery through the enabledProviders failover chain when
  // `multiProviderRoutingEnabled` is ON. Its first statement reads the flag and
  // returns `passthrough` when OFF, so the flag-OFF path falls straight through to
  // the legacy alt-model handler below — byte-for-byte unchanged.
  if ((await handleProviderChainRecoveryFallback(ctx)).kind === 'handled') return;

  if ((await handleAltModelFallback(ctx, isAltModelError)).kind === 'handled') return;
  if ((await handleServerErrorRetry(ctx, isServerErrorRetry, isAltModelError)).kind === 'handled') return;

  // 6. Rate limit fallback (may modify ctx.error)
  if ((await handleRateLimitFallback(ctx)).kind === 'handled') return;

  // 7. Post-fallback server error (catches server errors introduced by rate limit fallback)
  //    Recompute isNetworkFailure — handler 7 may have reassigned ctx.error
  const postFallbackNetworkFailure = isNetworkError(getErrorMessage(ctx.error));
  if ((await handlePostFallbackServerError(ctx, isServerErrorRetry, postFallbackNetworkFailure)).kind === 'handled') return;

  // 8-9. Re-check abort in case error was reassigned from retry failure
  const effectiveIsAbortError = ctx.abortController.signal.aborted;
  if (!effectiveIsAbortError) {
    if ((await handleTransientAndProcessExitRetry(ctx)).kind === 'handled') return;
    if ((await classifyAndDispatchError(ctx)).kind === 'handled') return;
  }

  // Final cleanup — always runs unless a handler returned early
  const cleanupReason = ctx.abortedByWatchdog ? 'watchdog-aborted' : effectiveIsAbortError ? 'aborted' : 'error';
  completeTurnCleanup(ctx.turnId, cleanupReason);
}
