// CORE-MOVE-EXEMPT: Stage 2.E.1 transitional split file; canonical move to @core in Stage 2.F.

/**
 * Agent Turn Executor
 *
 * Core execution logic for agent turns. Handles:
 * - Turn initialization and validation
 * - Attachment processing
 * - Runtime query execution
 * - Error handling (context overflow, MCP race conditions, abort)
 * - Turn cleanup and logging
 *
 * Pre-turn assembly timeout & ghost pruning rationale: docs/project/ARCHITECTURE_AGENT_TURN_EXECUTION.md § "Pre-Turn Assembly Timeout"
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import type { EventWindow } from '@core/types';
import { getPlatformConfig, type ProcessMetricSubset } from '@core/platform';
import { getRebelAuthProvider } from '@core/rebelAuth';
import { getAppNavigationService } from '@core/appNavigationService';
import { getScreenshotCaptureService } from '@core/screenshotCaptureService';
import { appendDiagnosticEvent } from '@core/services/diagnosticEventsLedger';
import {
  captureWatchdogAutoAbort,
  captureWatchdogStalled,
  emitWatchdogSelfResolvedTelemetry,
  getWatchdogResolutionTimeBucket,
  type WatchdogReachabilityMarker,
} from '@core/services/turnPipeline/watchdogTelemetry';
import { invalidateOperatorRegistry } from '@core/services/operatorRegistry';
import { bucketAbortDurationMs, type AbortReason } from '@core/services/diagnostics/manifest';
import {
  buildJudgeInput,
  injectionSuspicionLevel,
  judgeWatchdog,
  redactForLog,
  type InjectionSuspicionLevel,
  type WatchdogJudgeFailureCause,
  type WatchdogJudgeResult,
} from '@core/services/watchdogJudge';
import {
  type TurnParams,
  type QueryRouterContext,
} from '@core/rebelCore/queryRouter';
import type { ChatMessage } from '@core/rebelCore/modelTypes';
import { ToolKilledByWatchdogError } from '@core/rebelCore/toolErrors';
import { resolveDefaultModelForRole } from '@core/rebelCore/modelRoleResolver';
import { formatSubagentDisplayName } from '@core/rebelCore/subagentDisplayName';
import type { ProviderRoutePlan, ProviderRouteRuntimeContext } from '@core/rebelCore/providerRoutePlan';
import {
  resolveProviderRoutePlan,
  type ProviderRouterTurnInput,
} from '@core/rebelCore/providerRouting';
import {
  assertNever as assertProviderNever,
  buildRecoverableTerminalRouteError,
  captureRouteInvariantBreach,
  isRecoverableTerminalReason,
  type ProviderCredentialSource,
  type ProviderRouteDecision,
  type RouteRebuildHint,
} from '@core/rebelCore/providerRouteDecision';
import { isTerminalRoutePlan, type DispatchableRoutePlan } from '@core/rebelCore/providerRoutePlanTypes';
import { recordTerminalRouteDecision } from './terminalRouteTelemetry';
import { proxyRuntimeForDecision } from '@core/rebelCore/proxyRuntimeForDecision';
import type { McpErrorInfo, RebelCoreHookMatcher, RebelCoreHooks } from '@core/rebelCore/types';
import type { ModelClient } from '@core/rebelCore/modelClient';
import {
  createClientFromRoutePlan,
} from '@core/rebelCore/clientFactory';
import { ConnectionNotConfiguredError, UnsupportedModelError } from '@shared/utils/connectionCredentials';
import { getDefaultModelForProvider } from '@shared/utils/getDefaultModelForProvider';
import { assertNever } from '@shared/utils/assertNever';
import { superMcpHttpManager } from '@main/services/superMcpHttpManager';
import type { AgentDefinition, HookCallback, HookJSONOutput, McpServers } from '@core/agentRuntimeTypes';
import type {
  AnyAttachmentPayload,
  AgentTurnMessage,
  AppSettings,
} from '@shared/types';
import type { AgentRoutePlanResolvedEvent, TurnAuthLabel } from '@shared/agentEvents';
import { AGENT_ROUTE_PLAN_RESOLVED_CHANNEL } from '@shared/ipc/broadcasts';
import { classifySessionKind } from '@shared/sessionKind';
import { getWorkingModelProfile, type ModelProfile } from '@shared/types';
import { getThinkingProfile, getWorkingProfile } from '@shared/utils/settingsUtils';
import { resolveBtsModel } from '@shared/utils/btsModelResolver';
import { decodeRoutingModelId, type RoutingModelId } from '@shared/utils/modelChoiceCodec';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import {
  completeTurnCleanup,
  cleanupTurnAttempt,
  cleanupProxyRoutes,
  makeSyntheticResult,
  registerPreDispatchGuardDisarm,
  beginTurnAttempt,
  councilTurnIds,
  councilTurnMeta,
  adHocTurnIds,
  adHocTurnMeta,
} from '@main/services/agentTurnCleanup';
import {
  resolveModelConfig,
  stripExtendedContextFromConfig,
  isExtendedContextUnavailableError,
  modelSupportsExtendedContext,
  ENV_THINKING_MODEL,
  ENV_EXECUTION_MODEL,
  PREFERRED_PLANNING_MODEL,
  PLAN_MODE_ALIAS,
  resolvePlanModeTarget,
} from '@shared/utils/modelNormalization';
import { resolveReasoningEffort } from '@shared/utils/reasoningEffortResolver';
import { resolveModelLimits, shouldSuppressProfileReasoning } from '@core/rebelCore/modelLimits';
import { ModelError } from '@core/rebelCore/modelErrors';
import { safeDispatchLearnedLimitsFromError } from '@core/rebelCore/dispatchLearnedLimitsFromError';
import {
  getApiKey,
  getCurrentModel,
  getGlobalThinkingEffort,
  getModelEfforts,
  getOAuthToken,
  getPermissionMode,
  getThinkingModel,
  getThinkingProfileId,
  getWorkingProfileId,
} from '@core/rebelCore/settingsAccessors';
import { acquireBlock } from '@main/services/powerSaveBlockerService';
import type { PreTurnWorker } from '@core/preTurnWorker';
import { buildSdkQueryOptions, type QueryOptionsContext } from '@main/services/queryOptionsBuilder';
import { createScopedLogger, createTurnSessionLogger, logger, runWithTurnContext } from '@core/logger';
import { getTracker } from '@core/tracking';
import { buildProviderFailoverTelemetry, deriveProviderFailoverReason, PROVIDER_FAILOVER_EVENT } from './providerFailoverTelemetry';
import { getSettings } from '@core/services/settingsStore';
import { agentTurnRegistry } from '@main/services/agentTurnRegistry';
import { getIncrementalSessionStore } from '@main/services/incrementalSessionStore';
import { dispatchAgentErrorEvent, dispatchAgentEvent } from '@main/services/agentEventDispatcher';
import { handleError as handleTurnError } from '@main/services/turnPipeline/turnCompletion';
import { runPhase } from '@main/services/turnPipeline/runPhase';
import {
  admit,
  buildTurnCompletionBaseContext,
  createTrackingCounters,
  createWatchdogDiagnostics,
} from '@main/services/turnPipeline/turnAdmission';
import type {
  RuntimePhaseAccumulator,
  TurnCompletionBaseContext,
} from '@main/services/turnPipeline/types';
import { runAgentQuery } from '@main/services/agentQueryRunner';
import {
  appendAttachmentsToPrompt,
  appendBinaryAttachmentsToPrompt,
  appendOfficeAttachmentsToPrompt,
  appendExtractedPdfAttachmentsToPrompt,
  appendTextFileAttachmentsToPrompt,
  resolveSkillModelRecommendations,
  separateAttachments,
  createUserMessageGenerator,
  buildUserMessageContext,
  buildResponseShapeContractForPrompt,
  type UserMessageContextSections,
  getErrorMessage,
} from '@main/utils/agentTurnUtils';
import { validateAndFilterAttachments } from '@main/utils/attachmentValidation';
import {
  formatFrequentToolsContext,
  formatConnectedPackagesContext,
  formatSuggestedToolsContext,
} from '@main/utils/agentTurnFormatters';
import { resolveAttachmentSourcePath } from '@core/services/attachmentTempService';
import { isImageAttachment as _isImageAttachment, isTextAttachment as _isTextAttachment } from '@shared/types';
import {
  setupNodeEnvironment,
} from '@main/utils/systemUtils';
import {
  resolveMcpServers,
  reportMcpError,
  resolveSystemPrompt,
  buildConnectedPackages,
  buildServerAccountMap,
  buildFrequentToolGroups,
  type ResolveSystemPromptOptions,
} from '@main/services/mcpService';
import { resolveCapabilities } from '@core/services/capabilityResolutionService';
import type { SessionType } from '@main/services/promptTemplateService';
import { derivePolicy } from '@core/services/turnPolicy';
import type { TurnPolicy } from '@core/types/turnPolicy';
import {
  buildDesignContext,
  shouldInjectDesignContext,
} from '@main/services/designContextService';
import { enhancePromptWithSemanticContext } from '@main/services/semanticContextService';
import {
  buildOurComponentsContext,
  OurComponentsContextUnavailableError,
  shouldInjectOurComponentsContext,
} from '@main/services/ourComponentsContextService';
import {
  enhancePromptWithConversationContext,
  parseConversationSearchKeyword,
  AUTO_CONVERSATION_THRESHOLD,
  loadFilterAndFormatConversations,
} from '@main/services/conversationContextService';
import { searchConversations as searchConversationsMainProcess } from '@main/services/conversationIndexService';
import {
  buildContinuationContext,
  formatPriorTurnsHeaderEvent,
} from '@core/services/buildContinuationContext';
import { safeStringifyForTelemetry, stripUserValues } from '@main/services/mcpTelemetryUtils';
import { extractUrls, enrichToolSearchQuery, sanitizeUrlsForEmbedding } from '@core/services/urlDetectionService';
import { prefetchDocuments, formatPrefetchedDocumentsContext } from '@core/services/documentPrefetchService';
import { createMcpPrefetchFn, resolveActiveServerInstances } from '@main/services/documentPrefetchAdapter';
import catalogData from '../../../../resources/connector-catalog.json';
import type { ConnectorCatalog } from '@shared/types';

import { sanitizeSurrogates } from '@shared/utils/stringSanitization';
import { searchTools, hasToolIndex, getToolIndexStatus } from '@core/services/toolIndex/toolIndexService';
import {
  WatchdogTracker,
  AUTO_ABORT_MS,
  STREAMING_STALL_ABORT_MS,
  AWAITING_API_STALL_ABORT_MS,
  AWAITING_API_SOFT_STALL_MS,
  AWAITING_API_SOFT_STALL_MESSAGE,
  WATCHDOG_THRESHOLDS,
  WATCHDOG_THRESHOLDS_SUBAGENT,
  formatWatchdogAutoAbortMessage,
  shouldSuppressLevel1WatchdogCapture,
  isAwaitingApiHardStall,
  isAwaitingApiSoftStall,
  type WatchdogCheckResult,
} from '@core/services/watchdog/watchdogTracker';
import { dispatchAwaitingApiTimeoutTerminal } from '@core/services/turnPipeline/awaitingApiTimeoutTerminal';
import type { RuntimeActivityEvent } from '@core/rebelCore/runtimeActivity';
import { serializeRuntimeActivityForTelemetry } from '@core/rebelCore/runtimeActivity';

import { getErrorReporter } from '@core/errorReporter';
import { proxyManager, type CouncilErrorCallback } from '@main/services/localModelProxyServer';
import {
  buildCouncilConfig,
  resolveCouncilLeadModel,
  type CouncilConfig,
  buildAvailableModelsPrompt,
} from '@main/services/councilService';
import {
  detectModelReferences,
  buildAdHocAgentConfig,
  type AdHocAgentConfig,
} from '@main/services/adHocAgentService';
import {
  CLAUDE_MENTION_TARGETS,
  detectClaudeModelReferences,
  buildClaudeSubagentConfig,
  type ClaudeSubagentConfig,
} from '@main/services/claudeMentionAgentService';
import {
  KNOWLEDGE_WORKER_AGENT_NAME,
  KNOWLEDGE_WORKER_AGENT_DESCRIPTION,
} from '@main/constants';
import { createToolSafetyHook, createCanUseTool } from '@main/services/toolSafetyService';
import { buildSessionIntent } from '@core/services/safety/sessionIntentProvider';

import { createMemoryWriteHook, createCheckpointIntegrityHook } from '@main/services/safety/memoryWriteHook';
import {
  buildApprovedNotExecutedStatus,
  createApprovalExecutionGuardHook,
} from '@main/services/safety/approvalExecutionGuardHook';
import {
  currentApprovalSequence,
  hasActionableExecutionExpectations,
} from '@main/services/safety/sessionApprovals';
import { getPendingApprovals, getPendingMemoryApprovals } from '@main/services/safety/pendingApprovalsStore';
import { updateLastApiCallTime, getLastApiCallTime } from '@main/services/promptCacheWarmupService';

import { getBroadcastService } from '@core/broadcastService';
import { createStagedReadHook } from '@main/services/safety/stagedReadHook';
import {
  createSpacePermissionHook,
  getWritableForSpacePath,
} from '@core/services/safety/spacePermissionHook';
import { createSearchToolInterceptHook } from '@core/services/toolIndex/searchToolInterceptHook';
import { createSchemaGateHook, createSchemaGatePostHook } from '@main/services/schemaGateHook';
import { createUserQuestionHook } from '@main/services/userQuestionHook';
import { getTokenSyncCoordinator } from '@core/setTokenSyncCoordinator';
import { getOAuthToolResolver } from '@core/setOAuthToolResolver';
import { createTokenSyncPreflightHook } from '@core/services/tokenSync/createTokenSyncPreflightHook';
import {
  createChiefDesignerVisualToolGuardHook,
  shouldGuardChiefDesignerVisualTools,
} from '@main/services/chiefDesignerVisualToolGuardHook';
import { createFileConversationTrackingHook } from '@main/services/fileConversationTrackingHook';
import { createMcpBuildAutoDetectHook } from '@main/services/mcpBuildAutoDetectHook';
import {
  promoteTestingContributionIfRegistered,
  buildStuckRegistrationReminder,
} from '@main/services/mcpBuildAutoDetectHook';
import { createSkillWriteTrackingHook } from '@main/services/skillWriteTrackingHook';
import { createAutoContinueHook } from '@main/services/autoContinueHook';
import { apiRateLimitCooldown } from '@core/services/apiRateLimitCooldown';
import { providerRateLimitCooldowns } from '@core/services/providerRateLimitCooldowns';
import { diagnoseTimeout, type TimeoutDiagnosticResult } from '@core/services/timeoutDiagnosticsService';
import { delayWithAbort } from '@core/utils/delayWithAbort';
import { detectCloudStorage } from '@core/utils/cloudStorageUtils';
import { getCodexAuthProvider, CODEX_ENDPOINT_URL } from '@core/codexAuth';
import { resolveCodexConnectivity } from '@core/rebelCore/codexConnectivity';
import { hasValidAuth, isUsingOpenRouter, getProviderKeyEnvVars } from '@main/utils/authEnvUtils';
import type { CodexModeConfig } from '@core/rebelCore/codexModeTypes';
import { isCodexSubscriptionProfile, resolveProfileApiKey } from '@shared/utils/providerKeys';
import {
  createProfileConnectivity,
  getFunctionalRoutingProfiles,
  getProfileConnectivityStateFromSettings,
  isConnectionLive,
} from '@shared/utils/connectivityHelpers';
import { hasManagedOpenRouterKey } from '@main/services/openRouterTokenStorage';
import {
  assessCouncilEligibility,
  COUNCIL_BLOCKED_AUTH_COPY,
  getCouncilProfiles as getCouncilCandidateProfiles,
  type ManagedAllowListState,
} from '@shared/utils/councilProfiles';
import { getManagedAllowListState } from '@shared/types/managedProvider';
import { mainTracking } from '@main/tracking';
import { getFrequentTools } from '@main/services/toolUsageStore';
import { aliasMcpServersForClaudeSdk } from '@main/services/mcpServerAlias';
import { getPluginPreTurnContexts } from '@main/services/pluginPreTurnContextStore';
import { mcpAppModelContextStore } from '@main/services/mcpAppModelContextStore';
import { libraryBroadcaster } from '@main/services/libraryBroadcaster';
import type { SpaceInfo } from '@core/services/space/spaceService';
import { getSystemSettingsPath } from '@core/services/systemSettingsSync';
import {
  JUDGE_FIRE_OFFSET_MS,
  AUTOMATION_HARD_CEILING_MS,
  JUDGE_FAIL_OPEN_EXTENSION_MS,
  MAX_CONSECUTIVE_FAIL_OPEN,
  MAX_COMPLETED_TOOLS_THIS_TURN,
  TOOL_CANCEL_GRACE_MS,
  MAX_PER_TOOL_WATCHDOG_CANCELS,
} from './watchdogConstants';

/**
 * Gate for attachment source-path resolution. Only hosts with local
 * filesystem access (desktop) can resolve `originalPath` or write temp
 * files to app data — cloud has no local user filesystem.
 */
export function hasLocalFilesystemAccess(): boolean {
  return getPlatformConfig().capabilities.localFilesystemAccess;
}

/**
 * Reads platform process metrics with graceful degradation.
 *
 * Desktop wires Electron's `app.getAppMetrics()`. Cloud wires `() => []`.
 * Mobile leaves the accessor undefined — the optional-chain handles absence.
 * Exported so unit tests can drive it without the executor harness.
 */
export function collectAppMetricsSafely(): ProcessMetricSubset[] {
  try {
    return getPlatformConfig().getAppMetrics?.() ?? [];
  } catch (err) {
    logger.debug({ err }, 'getAppMetrics threw — degrading gracefully');
    return [];
  }
}

export const UNMAPPED_RUNTIME_ACTIVITY_OBSERVED_CAP = 256;
const unmappedRuntimeActivityObserved = new Set<string>();

/**
 * Coarse liveness deadline over the *pre-dispatch* window
 * (260619_turn-hang-bugmode Stage 2). The agent-silence watchdog is only armed
 * just before model dispatch (`setInterval` ~line 4918); model dispatch is later
 * still (`runAgentQuery` ~line 5733). Everything before the watchdog arms —
 * `getSession`, `buildContinuationContext`, `fs.stat(coreDirectory)`, MCP/system-
 * prompt resolution, provider routing — runs with NO liveness guard. On a dead
 * cloud-storage mount these fs reads queue forever on the exhausted libuv pool
 * and hang WITHOUT throwing, so the turn silently wedges: no watchdog event, and
 * the active-turn latch leaks (`completeTurnCleanup` never runs — the main try
 * has a catch but no finally). This deadline converts that invisible permanent
 * spin into a visible, retryable terminal + a released latch.
 *
 * IMPORTANT (GPT review F4): this is a timer on the event loop, NOT a way to
 * unblock a kernel-wedged libuv worker thread. It cannot cancel the underlying
 * syscall; the wedged fs read may still complete later and resume. The goal is
 * user-visible recovery + latch release, not thread rescue. The stale-turn guard
 * (`preDispatchGuardFired`) + idempotent `completeTurnCleanup` ensure a resumed
 * pre-dispatch await no-ops (no event dispatch, no model call, no double cleanup).
 *
 * Sized well above the 60s `PRE_TURN_ASSEMBLY_TIMEOUT_MS` + the observed ~15s
 * embedding so it never fires on a merely-slow-but-progressing healthy turn; it
 * bounds the silent-hang class to ~2 minutes instead of forever.
 */
export const PRE_DISPATCH_SETUP_TIMEOUT_MS = 120_000;

/**
 * Process-wide monotonic attempt counter (260619_turn-hang-bugmode Stage 2,
 * rework-F3). Every `executeAgentTurn` invocation captures a unique
 * `attemptEpoch` and threads it into every `completeTurnCleanup` call it makes,
 * so the cleanup idempotency marker is ATTEMPT-scoped, not turn-scoped. A
 * same-`turnId` retry is a new invocation with a new epoch, so a stale
 * OLD-attempt continuation that resumes after the retry started carries the OLD
 * epoch and cannot suppress (nor wrongly trigger) the NEW attempt's cleanup.
 */
let _nextTurnAttemptEpoch = 1;

/**
 * Tracks `coreDirectory` values we've already logged as "our-components
 * grounding unavailable", so subsequent ENOENTs for the same workspace stay
 * silent. Reset is not needed in normal runtime — the set scales with the
 * number of distinct workspaces opened per process (typically 1).
 */
const ourComponentsUnavailableLogged = new Set<string>();
export function recordUnmappedActivityObservationOnce(key: string): boolean {
  if (unmappedRuntimeActivityObserved.has(key)) return false;
  if (unmappedRuntimeActivityObserved.size >= UNMAPPED_RUNTIME_ACTIVITY_OBSERVED_CAP) {
    const firstKey = unmappedRuntimeActivityObserved.values().next().value;
    if (firstKey !== undefined) unmappedRuntimeActivityObserved.delete(firstKey);
  }
  unmappedRuntimeActivityObserved.add(key);
  return true;
}
/** @internal test-only — clears the bounded observation set between tests. */
export function __resetUnmappedActivityObservedForTests(): void {
  unmappedRuntimeActivityObserved.clear();
}

export {
  JUDGE_FIRE_OFFSET_MS,
  AUTOMATION_HARD_CEILING_MS,
  JUDGE_FAIL_OPEN_EXTENSION_MS,
  MAX_CONSECUTIVE_FAIL_OPEN,
  MAX_COMPLETED_TOOLS_THIS_TURN,
  TOOL_CANCEL_GRACE_MS,
  MAX_PER_TOOL_WATCHDOG_CANCELS,
};

export type WatchdogAutomationAbortReason = Extract<
  AbortReason,
  | 'watchdog'
  | 'judge_killed'
  | 'consecutive_fail_open_cap'
  | 'tool_cancelled_cap'
  | 'tool_cancel_unresponsive'
  | 'tool_repeated_timeout'
>;

export interface CompletedToolSummary {
  name: string;
  success: boolean;
  durationMs: number;
}

export interface WatchdogJudgeRuntimeState {
  extendedCeilingMs: number | undefined;
  priorExtensionCount: number;
  consecutiveFailOpenCount: number;
  boundToolUseId: string | undefined;
  boundToolName: string | undefined;
  boundHasActiveSubagent: boolean;
}

export interface ResolveWatchdogJudgeCeilingResult {
  state: WatchdogJudgeRuntimeState;
  effectiveCeilingMs: number;
  triggerAtMs: number;
  extensionApplies: boolean;
}

export interface ApplyWatchdogJudgeResultInput {
  state: WatchdogJudgeRuntimeState;
  judgeResult: WatchdogJudgeResult;
  extensionBaseMs: number;
  elapsedMs: number;
  silentMs: number;
  toolName: string | undefined;
  boundToolUseId: string | undefined;
  boundHasActiveSubagent: boolean;
  injectionSuspected?: InjectionSuspicionLevel;
}

export type WatchdogAutoExtendReason =
  | 'auto_extend_first_call_modest_silence'
  | 'auto_extend_active_subagent_recent_activity';

export type WatchdogAutoExtendDecision =
  | {
      extend: true;
      reason: WatchdogAutoExtendReason;
      additionalMs: number;
    }
  | { extend: false };

export interface WatchdogJudgeDecisionDiagnosticData {
  decision: 'extended' | 'failed_extended' | 'tool_cancelled' | 'auto_extended';
  additionalMs?: number;
  cause?: WatchdogJudgeFailureCause;
  reason?: WatchdogAutoExtendReason;
  injectionSuspected?: InjectionSuspicionLevel;
  priorExtensionCount: number;
  elapsedMs: number;
  silentMs: number;
  toolName?: string;
  // Populated for `failed_extended` to surface the underlying parse/transport error
  // (e.g. "additionalMs: invalid enum value", JSON syntax message, timeout text). Without
  // this, log lines only carry the failure category (`cause`) and we cannot tell why the
  // judge response was rejected — the precise driver of the consecutive_fail_open_cap kill.
  errorMessage?: string;
}

export type WatchdogJudgeApplyResult =
  | {
      state: WatchdogJudgeRuntimeState;
      killReason?: undefined;
      decisionDiagnostic?: WatchdogJudgeDecisionDiagnosticData;
    }
  | {
      state: WatchdogJudgeRuntimeState;
      killReason: Extract<AbortReason, 'judge_killed' | 'consecutive_fail_open_cap'>;
      decisionDiagnostic?: WatchdogJudgeDecisionDiagnosticData;
    };

export function resolveWatchdogMessageTimeoutMs(extendedCeilingMs: number | undefined): number {
  return extendedCeilingMs ?? AUTO_ABORT_MS;
}

/**
 * FOX-3251: Diagnostic-aware follow-up message dispatched at watchdog Level 4
 * (5 min silence) once the timeout probes complete. Replaces the user
 * "punishment time" between Level 4 and the 10-min abort with actionable
 * context — so users learn at 5 min that Claude is degraded / they're offline /
 * the stream is stalled but everything's healthy, instead of having to wait
 * the full 10 min for the same information.
 */
export function getDiagnosticAwareLevelFourMessage(diagnostic: TimeoutDiagnosticResult): string {
  switch (diagnostic.kind) {
    case 'anthropic_issue':
      return `Heads-up — Claude looks like it's having trouble (status: ${diagnostic.indicator}). I'll keep waiting, but check status.anthropic.com if it doesn't recover.`;
    case 'internet_unreachable':
      return "Heads-up — I'm having trouble reaching the internet. Check your connection.";
    case 'transient_stall':
    default:
      return "Heads-up — the stream is stalled but everything else looks healthy on this end. I'll keep waiting; if you'd rather not, you can stop and resend your message.";
  }
}

export function appendCompletedToolThisTurn(
  entries: CompletedToolSummary[],
  entry: CompletedToolSummary,
  cap: number = MAX_COMPLETED_TOOLS_THIS_TURN,
): void {
  entries.push(entry);
  if (entries.length > cap) {
    entries.splice(0, entries.length - cap);
  }
}

/**
 * Marker prefix used by `agentLoop.ts` when it converts an
 * `AgentToolTimeoutError` into a synthetic `tool_result { is_error: true }`.
 * The turn executor uses this prefix to detect subagent internal timeouts
 * (per A15) and route them through the shared per-tool cap counter without
 * needing a separate event channel.
 */
export const SUBAGENT_INTERNAL_TIMEOUT_PREFIX = 'Subagent ran out of time:';

/**
 * Returns true when a tool_result content payload was synthesized by the
 * agent loop in response to an `AgentToolTimeoutError`. Accepts either the
 * raw string form (no images) or the array form (`{type:'text', text:'...'}`)
 * that some providers may emit.
 */
export function isSubagentInternalTimeoutResult(content: unknown): boolean {
  if (typeof content === 'string') {
    return content.startsWith(SUBAGENT_INTERNAL_TIMEOUT_PREFIX);
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object') {
        const typed = block as { type?: unknown; text?: unknown };
        if (typed.type === 'text' && typeof typed.text === 'string') {
          return typed.text.startsWith(SUBAGENT_INTERNAL_TIMEOUT_PREFIX);
        }
      }
    }
  }
  return false;
}

export function resetOtherToolCancelCounts(
  counts: Map<string, number>,
  completedToolName: string,
): void {
  if (counts.size > 0) {
    for (const toolName of Array.from(counts.keys())) {
      if (toolName !== completedToolName) {
        counts.delete(toolName);
      }
    }
  }
}

export type RecordToolWatchdogCancelResult =
  | { kind: 'cancelled'; nextCount: number }
  | { kind: 'cap' };

/**
 * Tracks per-turn watchdog cancel / subagent internal timeout counts keyed by
 * tool name (or tool-use id when name is unavailable). Returns 'cap' once the
 * prior count has reached `MAX_PER_TOOL_WATCHDOG_CANCELS`. The counter is
 * mutated only on 'cancelled'; the caller is expected to abort the turn
 * instead of continuing on 'cap'.
 *
 * Per A15 (`docs/plans/260508_tool_level_timeout_and_judge_tuning.md`), this
 * counter is shared between watchdog tool-level cancels (the original surface)
 * and subagent internal timeouts (`AgentToolTimeoutError` recovered to a
 * synthetic tool_result). They share the same cap because both indicate "this
 * tool keeps not finishing" — independent of whether the parent watchdog or
 * the subagent's own internal timer fired first.
 */
export function recordToolWatchdogCancel(
  counts: Map<string, number>,
  cancelCountKey: string,
): RecordToolWatchdogCancelResult {
  const priorCancelCount = counts.get(cancelCountKey) ?? 0;
  if (priorCancelCount >= MAX_PER_TOOL_WATCHDOG_CANCELS) {
    return { kind: 'cap' };
  }
  const nextCount = priorCancelCount + 1;
  counts.set(cancelCountKey, nextCount);
  return { kind: 'cancelled', nextCount };
}

export function resolveWatchdogJudgeCeiling(args: {
  state: WatchdogJudgeRuntimeState;
  baseCeilingMs: number;
  activeToolUseId: string | undefined;
  activeToolName: string | undefined;
  hasActiveSubagent: boolean;
}): ResolveWatchdogJudgeCeilingResult {
  const nextState: WatchdogJudgeRuntimeState = { ...args.state };

  if (nextState.extendedCeilingMs !== undefined) {
    // F7: extension is bound to the SPECIFIC tool/subagent that motivated it.
    // If the originally-bound tool finishes, the extension does NOT carry over
    // to the next tool. A judge that granted +30 min for a long DeepResearchPaper
    // call must not silently extend a subsequent quick Bash call.
    const boundToolStillActive =
      nextState.boundToolUseId !== undefined &&
      args.activeToolUseId === nextState.boundToolUseId;
    const boundSubagentStillActive =
      nextState.boundHasActiveSubagent && args.hasActiveSubagent;

    if (boundToolStillActive) {
      // Refresh metadata for the same tool (name may resolve later in the lifecycle).
      nextState.boundToolName = args.activeToolName ?? nextState.boundToolName;
    } else if (boundSubagentStillActive) {
      // Subagent extensions persist while ANY subagent is active (subagent identity
      // is not currently tracked separately).
      nextState.boundToolName = args.activeToolName ?? nextState.boundToolName;
    } else {
      // Bound tool/subagent is no longer active — clear the extension.
      // Includes: original tool finished without subagent, fall-back to streaming-stall,
      // or transition to a new tool not covered by the original grant.
      nextState.extendedCeilingMs = undefined;
      nextState.boundToolUseId = undefined;
      nextState.boundToolName = undefined;
      nextState.boundHasActiveSubagent = false;
    }
  }

  const extensionApplies =
    args.baseCeilingMs === AUTO_ABORT_MS && nextState.extendedCeilingMs !== undefined;
  const effectiveCeilingMs = extensionApplies
    ? nextState.extendedCeilingMs!
    : args.baseCeilingMs;

  return {
    state: nextState,
    effectiveCeilingMs,
    triggerAtMs: Math.max(effectiveCeilingMs - JUDGE_FIRE_OFFSET_MS, 0),
    extensionApplies,
  };
}

export function shouldFireWatchdogJudge(args: {
  baseCeilingMs: number;
  effectiveCeilingMs: number;
  silentMs: number;
  judgeInFlight: boolean;
}): boolean {
  if (args.judgeInFlight) return false;
  if (args.baseCeilingMs !== AUTO_ABORT_MS) return false;
  const triggerAt = args.effectiveCeilingMs - JUDGE_FIRE_OFFSET_MS;
  return args.silentMs >= triggerAt && args.silentMs < args.effectiveCeilingMs;
}

export function shouldAutoExtend(args: {
  priorExtensionCount: number;
  hasActiveSubagent: boolean;
  silentMs: number;
}): WatchdogAutoExtendDecision {
  // A8 Gate 1: first watchdog extension decision with modest silence.
  if (args.priorExtensionCount === 0 && args.silentMs < 25 * 60_000) {
    return {
      extend: true,
      reason: 'auto_extend_first_call_modest_silence',
      additionalMs: 15 * 60_000,
    };
  }

  // A8 Gate 2: subagent is active and silence is still modest.
  if (args.hasActiveSubagent && args.silentMs < 5 * 60_000) {
    return {
      extend: true,
      reason: 'auto_extend_active_subagent_recent_activity',
      additionalMs: 15 * 60_000,
    };
  }

  return { extend: false };
}

export function shouldEmitWatchdogEscalationSideEffects(escalated: boolean): boolean {
  return escalated;
}

export function shouldApplyWatchdogJudgeResolution(
  signal: AbortSignal,
  turnCompleted = false,
): boolean {
  if (signal.aborted) return false;
  if (turnCompleted) return false;
  return true;
}

export type WatchdogJudgeInjectionDisposition =
  | { level: InjectionSuspicionLevel; override: false }
  | {
      level: 'override';
      override: true;
      decisionDiagnostic: WatchdogJudgeDecisionDiagnosticData;
      nextExtendedCeilingMs: number;
      nextConsecutiveFailOpenCount: number;
    };

export function resolveWatchdogJudgeInjectionDisposition(args: {
  judgeResult: WatchdogJudgeResult;
  priorExtensionCount: number;
  consecutiveFailOpenCount: number;
  extendedCeilingMs: number | undefined;
  elapsedMs: number;
  silentMs: number;
  toolName: string | undefined;
}): WatchdogJudgeInjectionDisposition {
  if (args.judgeResult.kind === 'failed_extended') {
    return { level: 'none', override: false };
  }

  const level = injectionSuspicionLevel(args.judgeResult.reason);
  if (args.judgeResult.kind !== 'kill' || level !== 'override') {
    return {
      level,
      override: false,
    };
  }

  return {
    level: 'override',
    override: true,
    decisionDiagnostic: {
      decision: 'failed_extended',
      additionalMs: JUDGE_FAIL_OPEN_EXTENSION_MS,
      injectionSuspected: 'override',
      priorExtensionCount: args.priorExtensionCount,
      elapsedMs: args.elapsedMs,
      silentMs: args.silentMs,
      ...(args.toolName ? { toolName: args.toolName } : {}),
    },
    nextExtendedCeilingMs: (args.extendedCeilingMs ?? AUTO_ABORT_MS) + JUDGE_FAIL_OPEN_EXTENSION_MS,
    nextConsecutiveFailOpenCount: args.consecutiveFailOpenCount + 1,
  };
}

export function applyWatchdogJudgeInjectionOverride(args: {
  state: WatchdogJudgeRuntimeState;
  disposition: Extract<WatchdogJudgeInjectionDisposition, { override: true }>;
}): WatchdogJudgeApplyResult {
  const nextState: WatchdogJudgeRuntimeState = {
    ...args.state,
    extendedCeilingMs: args.disposition.nextExtendedCeilingMs,
    consecutiveFailOpenCount: args.disposition.nextConsecutiveFailOpenCount,
  };

  if (nextState.consecutiveFailOpenCount >= MAX_CONSECUTIVE_FAIL_OPEN) {
    return {
      state: nextState,
      killReason: 'consecutive_fail_open_cap',
      decisionDiagnostic: args.disposition.decisionDiagnostic,
    };
  }

  return {
    state: nextState,
    decisionDiagnostic: args.disposition.decisionDiagnostic,
  };
}

export function shouldAbortForAutomationHardCeiling(
  hardCeilingMs: number | null,
  elapsedMs: number,
): boolean {
  return hardCeilingMs !== null && elapsedMs >= hardCeilingMs;
}

export function applyWatchdogJudgeResult(
  args: ApplyWatchdogJudgeResultInput,
): WatchdogJudgeApplyResult {
  const nextState: WatchdogJudgeRuntimeState = { ...args.state };

  switch (args.judgeResult.kind) {
    case 'extend': {
      nextState.priorExtensionCount += 1;
      nextState.consecutiveFailOpenCount = 0;
      // extensionBaseMs is silentMs at fire time. The new ceiling lets the tool
      // be silent for `additionalMs` more from fire (minus judge call latency).
      nextState.extendedCeilingMs = args.extensionBaseMs + args.judgeResult.additionalMs;
      nextState.boundToolUseId = args.boundToolUseId;
      nextState.boundToolName = args.toolName;
      nextState.boundHasActiveSubagent = args.boundHasActiveSubagent;
      return {
        state: nextState,
        decisionDiagnostic: {
          decision: 'extended',
          additionalMs: args.judgeResult.additionalMs,
          priorExtensionCount: nextState.priorExtensionCount,
          elapsedMs: args.elapsedMs,
          silentMs: args.silentMs,
          ...(args.injectionSuspected && args.injectionSuspected !== 'none'
            ? { injectionSuspected: args.injectionSuspected }
            : {}),
          ...(args.toolName ? { toolName: args.toolName } : {}),
        },
      };
    }
    case 'kill':
      nextState.consecutiveFailOpenCount = 0;
      return {
        state: nextState,
        killReason: 'judge_killed',
      };
    case 'failed_extended': {
      const nextFailOpenCount = nextState.consecutiveFailOpenCount + 1;
      nextState.consecutiveFailOpenCount = nextFailOpenCount;
      const decisionDiagnostic: WatchdogJudgeDecisionDiagnosticData = {
        decision: 'failed_extended',
        additionalMs: args.judgeResult.additionalMs,
        cause: args.judgeResult.cause,
        priorExtensionCount: nextState.priorExtensionCount,
        elapsedMs: args.elapsedMs,
        silentMs: args.silentMs,
        ...(args.injectionSuspected && args.injectionSuspected !== 'none'
          ? { injectionSuspected: args.injectionSuspected }
          : {}),
        ...(args.toolName ? { toolName: args.toolName } : {}),
        ...(args.judgeResult.errorMessage ? { errorMessage: args.judgeResult.errorMessage } : {}),
      };

      // F11: allow 2 consecutive fail-open extensions (~20 min cushion for transient
      // BTS outages), then hard kill on the 3rd consecutive failure.
      if (nextFailOpenCount >= MAX_CONSECUTIVE_FAIL_OPEN) {
        return {
          state: nextState,
          killReason: 'consecutive_fail_open_cap',
          decisionDiagnostic,
        };
      }

      // Note: extensionBaseMs is the silentMs at fire time. New ceiling = silentMs + N
      // gives the tool exactly N minutes more silence allowance from fire (minus
      // judge call latency, ~25s). This is intentional — the judge granted "N more
      // minutes" and the tool gets exactly that.
      nextState.extendedCeilingMs = args.extensionBaseMs + args.judgeResult.additionalMs;
      nextState.boundToolUseId = args.boundToolUseId;
      nextState.boundToolName = args.toolName;
      nextState.boundHasActiveSubagent = args.boundHasActiveSubagent;
      return {
        state: nextState,
        decisionDiagnostic,
      };
    }
    default: {
      const unreachable: never = args.judgeResult;
      return { state: nextState, decisionDiagnostic: unreachable };
    }
  }
}

/** @internal */
export function applyWatchdogApprovalWaitCommitGate(args: {
  watchdog: WatchdogTracker;
  checkResult: WatchdogCheckResult;
  now: number;
  isWaitingForUser: boolean;
  watchdogAbortsDuringApprovalWait: boolean;
}): boolean {
  const { watchdog, checkResult, now, isWaitingForUser, watchdogAbortsDuringApprovalWait } = args;
  if (!checkResult.escalated) return false;
  const shouldSkipForApprovalWait = isWaitingForUser && !watchdogAbortsDuringApprovalWait;
  if (!shouldSkipForApprovalWait) {
    watchdog.commitCheck(checkResult, now);
  }
  return shouldSkipForApprovalWait;
}

export type { TurnAuthLabel } from '@shared/agentEvents';

/** @internal Exported for invariant-breach unit coverage (S4). */
export function assertDispatchableQueryOptionsPlan(plan: ProviderRoutePlan): asserts plan is DispatchableRoutePlan {
  if (!isTerminalRoutePlan(plan)) return;
  if (isRecoverableTerminalReason(plan.decision.invalidReason)) {
    if (plan.decision.invalidReason === 'missing-anthropic-credentials-for-claude-model') {
      // T-1 runtime invariant (FOX-3494): this reason is a runtime cross-product
      // (codex connected × no anthropic key × primary turn) the type system can't
      // express, so the producer (providerRouting) is the only guard. Assert here
      // that it never escapes to a BTS/subagent role — if it does, the producer
      // scope regressed (would mean an actionable copy on a background turn).
      if (plan.decision.role === 'bts' || plan.decision.role === 'subagent') {
        captureRouteInvariantBreach(
          plan.decision,
          'Invariant breach: missing-anthropic-credentials-for-claude-model on non-primary role',
          { subInvariant: 'claude-divert-actionable-on-non-primary' },
        );
      }
    }
    // FOX-3494: all recoverable terminal reasons go through the single shared
    // mapper (providerRouteDecision.buildRecoverableTerminalRouteError) so this
    // site, clientFactory, and the configured-role fallback agree on the error
    // class AND the structured detail. The claude-under-codex reason stays a
    // ConnectionNotConfiguredError carrying { invalidReason, wireModel,
    // failedRole } so existing `instanceof` gates keep surfacing it and the
    // renderer can lead with "switch to a GPT model".
    throw buildRecoverableTerminalRouteError(plan.decision);
  }
  captureRouteInvariantBreach(
    plan.decision,
    'Impossible state: terminal route plan reached buildSdkQueryOptions',
    { subInvariant: 'terminal-plan-reached' },
  );
  throw new Error(
    `Cannot build SDK query options for terminal route plan (transport=${plan.decision.transport}, invalidReason=${plan.decision.invalidReason}).`,
  );
}

function resolveTurnAuthLabelFromRoutePlan(plan: ProviderRoutePlan): TurnAuthLabel {
  // The route plan is the source of truth for turn auth tagging. Its auth label
  // intentionally collapses profile-direct and no-credential local routes to
  // "api-key" for env materialization, so preserve the ledger/UI-facing labels
  // from the route decision's credential source.
  const credentialSource: ProviderCredentialSource = plan.decision.credentialSource;
  switch (credentialSource) {
    case 'codex-subscription':
    case 'missing-codex':
      return 'codex-subscription';
    case 'openrouter-oauth-token':
    case 'missing-openrouter':
      return 'openrouter';
    case 'mindstone-managed-key':
    case 'missing-mindstone':
      return 'mindstone';
    case 'anthropic-api-key':
    case 'missing-anthropic':
      return 'api-key';
    case 'anthropic-oauth-token':
      return 'oauth-token';
    case 'local-none':
      return 'local';
    case 'profile-api-key':
    case 'openai-api-key':
    case 'missing-profile':
      return 'profile-direct';
    default:
      return assertProviderNever(credentialSource, 'ProviderCredentialSource');
  }
}

/** @internal */
export type RawStreamTrackerState = {
  lastActivity: RuntimeActivityEvent | null;
  lastEventType: string | null;
  lastTimestamp: number | null;
  eventCount: number;
  /**
   * Epoch ms of the FIRST raw-stream activity this turn (set once, never
   * overwritten). Drives the Stage-3a `timeToFirstTokenMs` stall enrichment —
   * `null` while no token/byte has streamed yet (the `awaiting_api` stall
   * class we're trying to make self-diagnosing). See
   * docs/plans/260617_bricked-state-0448-electron42/PLAN.md Stage 3.
   */
  firstActivityTimestamp: number | null;
};

/** @internal */
export function recordTerminalLifecycleActivity(args: {
  rawStreamTracker: RawStreamTrackerState;
  abortedByWatchdog: boolean;
  abortedByUser: boolean;
  supersededByNewerTurn?: boolean;
  watchdogAbortReason?: WatchdogAutomationAbortReason;
  now?: number;
  /**
   * Optional turn start timestamp (epoch ms). When provided, drives the
   * `abort_event` diagnostic emit's `durationBucketMs`. Omitted in tests
   * that exercise the helper directly without a real turn lifecycle —
   * in that case no diagnostic event is emitted.
   */
  turnStartedAt?: number;
}): void {
  const {
    rawStreamTracker,
    abortedByWatchdog,
    abortedByUser,
    supersededByNewerTurn,
    watchdogAbortReason = 'watchdog',
    now = Date.now(),
    turnStartedAt,
  } = args;

  if (abortedByWatchdog) {
    // eslint-disable-next-line no-restricted-syntax -- terminal-lifecycle-emission-justified: canonical helper recordTerminalLifecycleActivity (S7 single-emission-site invariant)
    const terminalActivity: RuntimeActivityEvent = {
      kind: 'lifecycle',
      subkind: 'aborted',
      rawEventType: 'turn.aborted',
    };
    rawStreamTracker.lastActivity = terminalActivity;
    rawStreamTracker.lastEventType = serializeRuntimeActivityForTelemetry(terminalActivity);
    rawStreamTracker.lastTimestamp = now;
    rawStreamTracker.eventCount++;
    if (typeof turnStartedAt === 'number') {
      appendDiagnosticEvent({
        kind: 'abort_event',
        data: {
          reason: watchdogAbortReason,
          durationBucketMs: bucketAbortDurationMs(now - turnStartedAt),
        },
      });
    }
  } else if (abortedByUser) {
    let terminalActivity: RuntimeActivityEvent;
    if (supersededByNewerTurn) {
      // eslint-disable-next-line no-restricted-syntax -- terminal-lifecycle-emission-justified: canonical helper recordTerminalLifecycleActivity (S7 single-emission-site invariant)
      terminalActivity = {
        kind: 'lifecycle',
        subkind: 'superseded',
        rawEventType: 'turn.superseded',
      };
    } else {
      // eslint-disable-next-line no-restricted-syntax -- terminal-lifecycle-emission-justified: canonical helper recordTerminalLifecycleActivity (S7 single-emission-site invariant)
      terminalActivity = {
        kind: 'lifecycle',
        subkind: 'cancelled',
        rawEventType: 'turn.cancelled',
      };
    }
    rawStreamTracker.lastActivity = terminalActivity;
    rawStreamTracker.lastEventType = serializeRuntimeActivityForTelemetry(terminalActivity);
    rawStreamTracker.lastTimestamp = now;
    rawStreamTracker.eventCount++;
    if (typeof turnStartedAt === 'number') {
      appendDiagnosticEvent({
        kind: 'abort_event',
        data: {
          reason: supersededByNewerTurn ? 'superseded' : 'user_cancel',
          durationBucketMs: bucketAbortDurationMs(now - turnStartedAt),
        },
      });
    }
  }
}

/** @internal */
export type SemanticContextFileSource = {
  relativePath: string;
  score: number;
};

/** @internal */
export function buildSpaceInfosFromSettings(settings: AppSettings): SpaceInfo[] {
  return (settings.spaces ?? []).map(sc => ({
    name: sc.name,
    path: sc.path,
    absolutePath: path.join(settings.coreDirectory ?? '', sc.path),
    type: sc.type ?? 'other',
    isSymlink: sc.isSymlink ?? false,
    hasReadme: sc.hasReadme ?? false,
    sharing: sc.sharing,
  }));
}

/** @internal */
export function extractSemanticContextFiles(
  files: Array<{ relativePath: string; score: number }> | undefined
): SemanticContextFileSource[] {
  if (!files || files.length === 0) return [];
  return files.map(f => ({ relativePath: f.relativePath, score: f.score }));
}



async function buildFileSearchSources(files: SemanticContextFileSource[], settings: AppSettings): Promise<Array<{
  relativePath: string;
  score: number;
  spaceName: string | undefined;
  spaceDisplayName: string | undefined;
  sharing: string;
}>> {
  if (files.length === 0) {
    return [];
  }

  const { matchPathToSpace } = await import('@main/services/safety/memoryWriteHook');
  const spaceInfos = buildSpaceInfosFromSettings(settings);
  const coreDirectory = settings.coreDirectory ?? '';

  return files.map((f) => {
    const space = matchPathToSpace(f.relativePath, spaceInfos, coreDirectory);
    return {
      relativePath: f.relativePath,
      score: f.score,
      spaceName: space?.name,
      spaceDisplayName: space?.displayName ?? space?.name,
      sharing: space?.sharing ?? 'private',
    };
  });
}

// Lazy lookup for pre-turn worker boundary.
let _preTurnWorker: PreTurnWorker | null = null;
let _preTurnWorkerLoaded = false;

async function getPreTurnWorker() {
  if (!_preTurnWorkerLoaded) {
    try {
      const boundary = await import('@core/preTurnWorker');
      _preTurnWorker = boundary.getPreTurnWorker();
    } catch {
      _preTurnWorker = null;
    }
    _preTurnWorkerLoaded = true;
  }
  return _preTurnWorker;
}


/**
 * Format suggested skills for prompt injection.
 * @param skills - Array of skill results from semantic search
 * @internal
 */
export function formatSuggestedSkillsContext(
  skills: Array<{ relativePath: string; skillName: string; description: string; score: number }>
): string | undefined {
  if (skills.length === 0) return undefined;

  const entries = skills.map((s, i) =>
    `${i + 1}. **${s.skillName}** (${(s.score * 100).toFixed(0)}% match)\n   Path: \`${s.relativePath}\`\n   ${s.description}`
  ).join('\n\n');

  return `<suggested-skills>\n## Potentially Relevant Skills\n\nThese skills from your Library may help with this task. Mention a skill by name to activate it.\n\n${entries}\n</suggested-skills>`;
}

/**
 * Derives whether the user explicitly overrode the working model/profile for THIS turn —
 * i.e. a per-conversation override on top of the default working profile.
 *
 * Returns false when the user is on the default working profile (even if
 * `workingProfileOverrideId` is set to the default profile's id, which is idempotent).
 *
 * Used by Stage 8's runtime gate to disable Smart picking for the turn when the
 * user picked a model on purpose. Distinct from `executionModelOverride`, which
 * is also set for default working profiles when a direct (non-proxy) execution
 * client is injected.
 *
 * @internal
 */
export function derivePerConversationModelOverride(
  turnOptions: { modelOverride?: string; workingProfileOverrideId?: string } | undefined,
  configuredWorkingProfile: { id: string } | null | undefined,
): boolean {
  if (!turnOptions) return false;
  const modelOverride = turnOptions.modelOverride?.trim();
  if (modelOverride && modelOverride.length > 0) return true;
  const workingProfileOverrideId = turnOptions.workingProfileOverrideId;
  if (
    workingProfileOverrideId
    && workingProfileOverrideId !== configuredWorkingProfile?.id
  ) {
    return true;
  }
  return false;
}

function decodeTurnRoutingModelOrThrow(value: string, source: string): RoutingModelId {
  const decoded = decodeRoutingModelId(value);
  if (!decoded) {
    throw new ModelError('invalid_request', `Invalid ${source} model id "${value}"`, 400);
  }
  return decoded;
}

/** @internal */
export function resolveActiveProfileForTurn(
  workingProfile: ReturnType<typeof getWorkingModelProfile> | null | undefined,
  settings: AppSettings,
  turnOptions: { workingProfileOverrideId?: string; modelOverride?: string } | undefined,
): ReturnType<typeof getWorkingModelProfile> | null {
  if (workingProfile) return workingProfile;
  if (turnOptions?.workingProfileOverrideId === '') return null;
  return getWorkingModelProfile(settings);
}

function toRecoveryChatMessages(messages: readonly AgentTurnMessage[] | undefined): ChatMessage[] {
  if (!messages?.length) return [];

  return messages.flatMap((message): ChatMessage[] => {
    const text = message.text?.trim();
    if (!text) return [];
    return [{
      role: message.role === 'user' ? 'user' : 'assistant',
      content: text,
    }];
  });
}

export function formatWatchdogJudgeAbortMessage(
  reason: WatchdogAutomationAbortReason,
  elapsedSinceTurnStartMs: number,
  isAutomationHardCap: boolean,
): string {
  if (reason === 'tool_cancelled_cap' || reason === 'tool_repeated_timeout') {
    return 'This tool kept getting stuck, so this turn was stopped automatically. Try sending the message again.';
  }
  if (reason === 'tool_cancel_unresponsive') {
    return "This tool couldn't be stopped cleanly, so this turn was stopped automatically. Try sending the message again.";
  }
  if (reason === 'consecutive_fail_open_cap') {
    return "Couldn't reach the time check after several attempts. Stopping this turn — you can try sending the message again.";
  }
  if (isAutomationHardCap) {
    return "Automation turn reached its 90-minute limit and was stopped.";
  }
  const minutes = Math.floor(elapsedSinceTurnStartMs / 60_000);
  if (reason === 'judge_killed') {
    return `This turn went silent for over ${minutes} minutes and was stopped automatically. Try sending the message again.`;
  }
  // Default watchdog reason (streaming stall or static ceiling without judge involvement).
  return `This turn was unresponsive for ${minutes} minutes and was stopped automatically. You can try sending your message again.`;
}

/**
 * Execute an agent turn with the Rebel runtime pipeline.
 */
export const executeAgentTurn = async (
  win: EventWindow | null,
  turnId: string,
  prompt: string,
  turnOptions?: {
    resetConversation?: boolean;
    sessionId?: string;
    /** Stripped recovery history used when resetConversation would otherwise drop all prior context. */
    recoveryMessages?: AgentTurnMessage[];
    attachments?: AnyAttachmentPayload[];
    /** Skip tool safety evaluation (for background tasks that use their own safety gate) */
    bypassToolSafety?: boolean;
    /** Memory write hook for intercepting file writes during memory updates */
    memoryWriteHook?: (
      input: { tool_name?: string; tool_input?: Record<string, unknown>; tool_use_id?: string },
      toolUseID: string | undefined,
      options: { signal: AbortSignal }
    ) => Promise<HookJSONOutput>;
    /** Private mode: forces cautious tool safety + cautious memory safety (always ask before actions/writes) */
    privateMode?: boolean;
    /** MCP deny hook for blocking MCP tool calls (for memory-update turns where MCP tools are included for cache alignment) */
    mcpDenyHook?: (
      input: { tool_name?: string; tool_input?: Record<string, unknown>; tool_use_id?: string },
      toolUseID: string | undefined,
      options: { signal: AbortSignal }
    ) => Promise<HookJSONOutput>;
    /** Override the model for this turn only. Falls back to configured model settings. */
    modelOverride?: string;
    /** Override the thinking model for this turn only. Empty string suppresses thinking model usage. */
    thinkingModelOverride?: string;
    /** Internal guard: true when long-context fallback model was already attempted for this logical turn */
    longContextFallbackAttempted?: boolean;
    /** Internal guard: true when rate-limit provider fallback was already attempted for this logical turn */
    rateLimitFallbackAttempted?: boolean;
    /**
     * Stage 4b — multi-provider rate-limit failover guard.
     * Accumulates the credential sources that have already 429'd in this logical
     * turn. Distinct from `rateLimitFallbackAttempted` (the Codex-waterfall boolean).
     * JSON-serializable array of `ProviderCredentialSource`.
     */
    rateLimitAttemptedCredentialSources?: import('@shared/types/providerRoute').ProviderCredentialSource[];
    /**
     * Stage 3 (provider-agnostic recovery "C") — multi-provider server/transient
     * failover guard. Accumulates the credential sources that have already failed
     * with a server/transient (alt-model-owned) error this logical turn. Distinct
     * from `rateLimitAttemptedCredentialSources` so server/transient failover never
     * writes or reads rate-limit cooldown/telemetry state.
     */
    serverTransientAttemptedCredentialSources?: import('@shared/types/providerRoute').ProviderCredentialSource[];
    /** Internal guard: tracks one configured fallback retry attempt per role for this logical turn */
    configuredRoleFallbackAttempted?: Partial<Record<'working' | 'thinking' | 'background', boolean>>;
    /** Override the active provider for this turn only (used by rate-limit fallback to switch from Codex to OpenRouter/Anthropic) */
    activeProviderOverride?: import('@shared/types/settings').ActiveProvider;
    /** Internal fallback rebuild hint used to rebuild provider routing from the in-flight plan snapshot. */
    routeRebuildHint?: RouteRebuildHint;
    /** In-flight route plan whose connectivity snapshot should be reused by routeRebuildHint. */
    inFlightProviderRoutePlan?: ProviderRoutePlan;
    /** Internal override for one retry attempt using a specific working profile; empty string suppresses configured profile use. */
    workingProfileOverrideId?: string;
    /** Internal override for one retry attempt using a specific thinking profile; empty string suppresses configured profile use. */
    thinkingProfileOverrideId?: string;
    /** Per-conversation thinking effort override. Slots after shell env but before profile/skills/per-model/global. */
    thinkingEffortOverride?: import('@shared/types').ThinkingEffort;
    /** Lazy loader for agent sessions (for @conversations context injection) - only called if @conversations keyword is detected */
    loadSessions?: () => import('@shared/types').AgentSession[];
    /** 
     * Get meeting companion context for tool hint injection.
     * Returns null if not a companion session or not actively recording.
     */
    getMeetingCompanionContext?: (sessionId: string) => Promise<{
      /** Current coach skill path (if coach selected) */
      currentCoachPath: string | null;
      /** Last injected coach path (null = first turn, '' = no coach, 'path' = specific coach) */
      lastInjectedCoachPath: string | null | undefined;
      /** Coach skill content (only provided when injection is needed) */
      coachSkillContent?: string;
    } | null>;
    /** Callback to update lastInjectedCoachPath after injection */
    setLastInjectedCoachPath?: (sessionId: string, coachPath: string | null) => void;
    /** Session type for agent context awareness (interactive, automation, cli, mcp_server) */
    sessionType?: SessionType;
    /** Resolved per-turn policy; when provided, executor/recovery retries MUST reuse this exact object. */
    policy?: TurnPolicy;
    /** Optional caller-side policy overrides merged into defaults when `policy` is not provided. */
    policyOverrides?: Partial<TurnPolicy>;
    /** Whether voice input/output is active (hints for response format) */
    voiceActive?: boolean;
    /** Enable unleashed mode (looser auto-continue stopping criteria) for fire-and-forget tasks */
    unleashedMode?: boolean;
    /** User-set success criterion resolved at turn admission. See `docs/plans/260515_finish_line.md`. */
    finishLine?: string;
    /**
     * Internal headless/eval override for the watchdog streaming-stall ceiling.
     * Omitted for normal app turns; when present it is used as a floor for the
     * executor's dynamic watchdog timeout path without changing global constants.
     */
    watchdogCeilingMs?: number;
    /** Activate council mode for this turn (dispatch parallel subagents on different model providers) */
    councilMode?: boolean;
    /** Active Space path for prompt-time Operator discovery scoping. */
    activeSpacePath?: string | null;
    /** Pre-created AbortController (from IPC handler to eliminate race condition) */
    existingAbortController?: AbortController;
    /** Adapter-provided PreToolUse safety hook for inbound triggers (opaque to the executor) */
    inboundSafetyHook?: (...args: unknown[]) => Promise<unknown>;
    /** Get Focus context for first-turn injection (calendar + goals). Returns null for non-focus or non-first-turn sessions. */
    getFocusContext?: (sessionId: string, origin?: string) => Promise<string | null>;
    /** Session origin hint from the turn request (e.g., 'focus'). Used for server-side context injection detection. */
    origin?: string;
    /**
     * Marks a turn that runs on a real desktop window but is NOT a user-initiated
     * interactive conversation turn — the live-meeting coach (proactive). The
     * Chief-of-Staff admission gate (260622 Stage 3) keys off this so it never
     * blocks / pops recovery UI on a turn the user didn't initiate. See
     * `turnAdmission.admit`.
     */
    nonInteractiveTurn?: boolean;
    /**
     * True when this turn is a system continuation (tool/memory approval retry
     * dispatched on the user's behalf). The Chief-of-Staff admission gate treats
     * it like a non-interactive turn (never blocks). See `turnAdmission.admit`.
     */
    isSystemContinuation?: boolean;
    /**
     * 260622 Stage 4: the "Run without my instructions" recovery escape. When
     * set, the Chief-of-Staff admission gate SKIPS the block and logs a
     * structured WARN, admitting the turn on the generic template (observable,
     * never silent). Per-turn only. See `turnAdmission.admit`.
     */
    proceedWithoutChiefOfStaff?: boolean;
    /**
     * Stage 2 of `docs/plans/260525_cross_turn_awareness_layer1_layer2.md` (F3).
     * When set, an upstream accumulator (e.g. `userQuestionResponseHandler`)
     * has already injected `<prior_turns>` + `<conversation_history>` into
     * `prompt`. The proactive prepend below MUST skip its own injection.
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
    /**
     * Turn-scoped system-prompt prefix forwarded from `AgentTurnRequest` /
     * `AgentLoopOptions`. Used by Operator personalisation for the first
     * turn only; not persisted on the session.
     */
    systemPromptPrefix?: string;
  }
): Promise<void> => {
  // Captured at the very top so both terminal-lifecycle call sites can compute
  // a coarse-bucketed durationBucketMs for the abort_event diagnostic emit.
  const turnStartedAt = Date.now();
  // Per-attempt epoch (rework-F3): unique per executeAgentTurn invocation. Threaded
  // into every completeTurnCleanup call below so cleanup idempotency is
  // attempt-scoped — a same-turnId retry's stale old-attempt continuation cannot
  // suppress the new attempt's cleanup. See _nextTurnAttemptEpoch.
  const attemptEpoch = _nextTurnAttemptEpoch++;
  // Record THIS attempt as the turn's live attempt the instant the epoch is
  // minted — before ANY await — so the completeTurnCleanup live-epoch gate is
  // authoritative by construction: a same-turnId retry (new epoch) immediately
  // supersedes the old one, and a stale old-attempt cleanup can never match
  // (rework-final-F3). The disarm callback is registered later, once the guard
  // timer exists (registerPreDispatchGuardDisarm is epoch-checked).
  beginTurnAttempt(turnId, attemptEpoch);
  // Use existing controller if provided (from IPC handler), otherwise create new one.
  // The IPC handler creates the controller before returning turnId to eliminate a race
  // where renderer could try to stop before the controller exists.
  const abortController = turnOptions?.existingAbortController ?? new AbortController();
  // ALWAYS register the controller - even if existingAbortController was provided.
  // This is critical for retry paths: cleanupForRetry() deletes the controller from
  // the registry, so we must re-register on recursive executeAgentTurn calls.
  // Without this, stop requests during retries return "not found" causing "Failed to stop run".
  agentTurnRegistry.setActiveTurnController(turnId, abortController);

  // Prevent the system from sleeping while an agent turn is active.
  // Only acquire on the first attempt — retries re-enter executeAgentTurn
  // via cleanupForRetry() without releasing, so re-acquiring would leak refs.
  // Gated behind Settings > Advanced > Prevent Sleep (default: off).
  if (agentTurnRegistry.getRetryCount(turnId) === 0 && getSettings().preventSleepDuringTurns) {
    try {
      acquireBlock(`turn:${turnId}`);
    } catch {
      // Power save blocker is best-effort
    }
  }

  const rendererSessionId =
    typeof turnOptions?.sessionId === 'string' && turnOptions.sessionId.trim().length > 0
      ? turnOptions.sessionId.trim()
      : null;

  // Approval-store sequence snapshot for the approval-execution guard
  // (FOX-2771 Stage 2). Sequence (not wall-clock) so same-millisecond
  // approve-then-start ordering is exact (review F3). Captured at function
  // entry — not after admission/pre-turn assembly — so an approval stored
  // while this turn is being set up counts as mid-turn and gets its own
  // continuation turn (confirm-round concern).
  const approvalSeqAtTurnStart = currentApprovalSequence();

  // Wrap turn execution with AsyncLocalStorage context for automatic log correlation.
  // All services called within this context will automatically include turnId in their logs.
  return runWithTurnContext(
    { turnId, sessionId: rendererSessionId ?? undefined },
    async () => {
  const turnLogger = createTurnSessionLogger(
    {
      turnId,
      rendererSessionId: rendererSessionId ?? undefined,
    },
    {
      turnId,
      rendererSessionId: rendererSessionId ?? undefined,
    }
  );
  // NOTE: `agentTurnRegistry.setTurnLogger(turnId, turnLogger)` is intentionally
  // deferred — admission registers the logger as one of its registry mutations
  // to preserve the monolith's ordering (setTurnLogger fires AFTER
  // setTurnCategory, just before the "Initializing agent turn" log). See
  // docs/plans/260429_r1_stage2_turnadmission_extraction_plan.md § F.3.

  // Emit pre-turn worker stats snapshot at the start of every turn
  try {
    const preTurnWorker = await getPreTurnWorker();
    if (preTurnWorker) {
      appendDiagnosticEvent({
        kind: 'worker_stats_pre_turn',
        data: preTurnWorker.getPreTurnWorkerStats(),
      });
    }
  } catch (err) {
    turnLogger.warn({ err }, 'Failed to emit pre-turn worker stats snapshot');
  }

  const effectivePolicy =
    turnOptions?.policy
    ?? derivePolicy(turnOptions?.sessionType, turnOptions?.policyOverrides, turnLogger);

  const trackingCounters = createTrackingCounters();
  const watchdogDiagnostics = createWatchdogDiagnostics();
  const staticWatchdogCeilingMs = typeof turnOptions?.watchdogCeilingMs === 'number'
    && Number.isFinite(turnOptions.watchdogCeilingMs)
    && turnOptions.watchdogCeilingMs > 0
    ? turnOptions.watchdogCeilingMs
    : undefined;
  let extendedCeilingMs: number | undefined = undefined;
  const getMessageTimeoutMs = (): number => {
    const dynamicCeilingMs = resolveWatchdogMessageTimeoutMs(extendedCeilingMs);
    return staticWatchdogCeilingMs !== undefined && staticWatchdogCeilingMs > dynamicCeilingMs
      ? staticWatchdogCeilingMs
      : dynamicCeilingMs;
  };
  // FOX-3251: Run timeout diagnostics once at watchdog Level 4 (5 min silence)
  // so users get a diagnostic-aware status event 5 minutes before the abort
  // fires, instead of having to wait the full 10 min for the same information.
  let levelFourDiagnosticInvoked = false;
  let retryEffectiveResetConversation = turnOptions?.resetConversation;
  const retryTurn: TurnCompletionBaseContext['retryTurn'] = async (overrides) => {
    cleanupTurnAttempt(turnId);
    agentTurnRegistry.cleanupForRetry(turnId);
    const retryOptions = {
      ...turnOptions,
      policy: effectivePolicy,
      ...(retryEffectiveResetConversation !== undefined
        ? { resetConversation: retryEffectiveResetConversation }
        : {}),
      ...overrides,
    };
    return executeAgentTurn(win, turnId, prompt, retryOptions);
  };
  // Snapshot settings ONCE here so the pre-dispatch liveness guard can read
  // `coreDirectory` from this in-memory value WITHOUT a fresh getSettings() call
  // at fire time (GPT F1): on desktop the settings adapter cache is lazy and a
  // cache miss reads the settings file via fs.readFileSync — a disk read inside a
  // guard that fires *because* I/O is degraded is exactly the smell this bug is
  // about. We pre-capture the plain string at arm time and never touch settings
  // again inside the timeout callback. See PLAN.md Stage 3.
  const preDispatchSettings = getSettings();
  const coreDirectoryForPreDispatchTelemetry = preDispatchSettings.coreDirectory ?? '';
  let base = buildTurnCompletionBaseContext({
    turnId,
    win,
    turnLogger,
    abortController,
    settings: preDispatchSettings,
    rendererSessionId,
    turnOptions,
    prompt,
    retryTurn,
    trackingCounters,
    watchdogDiagnostics,
    effectiveResetConversation: false,
    getMessageTimeoutMs,
  });
  let accumulator: RuntimePhaseAccumulator = { stage: 'pre-runtime' };

  // ===== PRE-DISPATCH LIVENESS GUARD (260619_turn-hang-bugmode Stage 2) =====
  // Arm a coarse deadline over the pre-dispatch window so a turn that wedges on
  // an unbounded fs read (dead cloud-storage mount starving the libuv pool)
  // becomes a VISIBLE, RETRYABLE terminal + releases the active-turn latch,
  // instead of silently spinning forever. See PRE_DISPATCH_SETUP_TIMEOUT_MS.
  //
  // `preDispatchGuardFired` is the stale-turn flag (GPT review F4): once the
  // deadline fires + cleans up, any later-resolving pre-dispatch await must
  // detect it and no-op (the abort-checks + `bailIfPreDispatchStale()` below).
  // (The turn's live attempt was registered via beginTurnAttempt at the very top,
  // right after attemptEpoch capture — see there.)
  let preDispatchGuardFired = false;
  let preDispatchDeadlineTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    // Already torn down by a normal pre-dispatch exit (abort checkpoint / early
    // return cleared the timer) — nothing to do.
    if (preDispatchGuardFired) return;
    preDispatchGuardFired = true;
    preDispatchDeadlineTimer = undefined;

    // Best-effort: abort the controller so any pre-dispatch await that DOES
    // resume promptly (e.g. a delayWithAbort, or a checkpoint reached after the
    // wedge clears) short-circuits. Cannot unblock a kernel-wedged syscall (F4).
    try {
      abortController.abort('pre_turn_setup_timeout');
    } catch (err) {
      ignoreBestEffortCleanup(err, {
        operation: 'preDispatchGuard.abort',
        reason: 'AbortController.abort never throws, but stay defensive',
      });
    }

    // Telemetry — make this stop being invisible (no watchdog is armed yet).
    turnLogger.warn(
      { turnId, rendererSessionId, timeoutMs: PRE_DISPATCH_SETUP_TIMEOUT_MS },
      'Pre-turn setup exceeded liveness deadline — ending turn as retryable (likely unresponsive cloud-storage mount starving the I/O pool)',
    );
    // Cloud-workspace suspicion signal (turn-hang follow-up, Stage 3): tag the
    // terminal so we can falsify the dead-cloud-mount hypothesis — do these
    // pre-dispatch timeouts correlate with cloud-backed workspaces? Computed from
    // the PRE-CAPTURED coreDirectory string (never a fresh settings read here —
    // see the arm-time snapshot above; GPT F1) via the PURE, SYNCHRONOUS,
    // I/O-free `detectCloudStorage(...).isCloud` string match. Deliberately uses
    // ONLY `.isCloud` and NOT `detectInPlaceCloudDocuments` (an xattr read) — a
    // blocking read inside a guard that fires because I/O is wedged would be
    // self-defeating. This is intentionally NARROWER than the watcher's
    // `isCloudRoot` (which can xattr-detect in-place iCloud ~/Documents): the tag
    // is a *suspicion* signal, so false-negatives on in-place iCloud are
    // acceptable. try/catch → default false (Sentry tags must be string|number|boolean).
    let cloudWorkspaceSuspected = false;
    try {
      cloudWorkspaceSuspected = detectCloudStorage(coreDirectoryForPreDispatchTelemetry).isCloud;
    } catch (err) {
      ignoreBestEffortCleanup(err, {
        operation: 'preDispatchGuard.cloudWorkspaceSuspected',
        reason: 'detectCloudStorage is a pure string match and should not throw; stay defensive so the guard always reports',
      });
    }
    try {
      getErrorReporter().addBreadcrumb({
        category: 'turn-lifecycle',
        level: 'warning',
        message: '[pre-dispatch-guard] pre-turn setup timed out',
        data: { turnId, timeoutMs: PRE_DISPATCH_SETUP_TIMEOUT_MS, cloudWorkspaceSuspected },
      });
      getErrorReporter().captureException(
        new Error('Pre-turn setup liveness deadline exceeded'),
        { tags: { area: 'turn-pre-dispatch', reason: 'pre_turn_setup_timeout', cloudWorkspaceSuspected } },
      );
    } catch (err) {
      ignoreBestEffortCleanup(err, {
        operation: 'preDispatchGuard.telemetry',
        reason: 'Sentry SDK failure must not crash the liveness guard',
      });
    }

    // Retryable terminal: reuse the existing `message_timeout` machinery so the
    // renderer surfaces the same "Try again" affordance, then a synthetic
    // result('error') to clear `isBusy`. Mirrors the awaiting_api stall terminal.
    //
    // F5: tag the error-event `watchdogDiagnostic.phase` as `pre_dispatch_setup`
    // so analytics can separate this pre-dispatch dead-mount timeout from a real
    // awaiting-API no-first-token stall (both surface as the retryable
    // `message_timeout` kind, which the renderer's Try-again UX depends on).
    try {
      dispatchAwaitingApiTimeoutTerminal({
        humanizedOverride:
          'This is taking longer than expected to get started — possibly an unresponsive cloud-storage folder. Try again.',
        watchdogDiagnostic: {
          phase: 'pre_dispatch_setup',
          messageCount: 0,
          rawStreamEventCount: 0,
          rawStreamLastEventType: null,
          rawStreamLastEventAgeMs: null,
          watchdogLevel: 0,
          maxWatchdogLevel: 0,
          effectiveAbortMs: PRE_DISPATCH_SETUP_TIMEOUT_MS,
        },
        dispatchError: (error, options) => dispatchAgentErrorEvent(win, turnId, error, options),
        dispatchSyntheticErrorResult: () => dispatchAgentEvent(win, turnId, makeSyntheticResult(turnId, '', 'error')),
      });
    } catch (err) {
      turnLogger.warn({ err, turnId }, 'Pre-dispatch guard: failed to dispatch retryable terminal');
    }

    // Release the leaked active-turn latch. completeTurnCleanup is idempotent
    // (F4) so a later normal exit path that also calls it is a safe no-op.
    completeTurnCleanup(turnId, 'pre_turn_setup_timeout', attemptEpoch);
  }, PRE_DISPATCH_SETUP_TIMEOUT_MS);
  // Don't let this timer hold the event loop / process open on quit.
  if (typeof preDispatchDeadlineTimer.unref === 'function') {
    preDispatchDeadlineTimer.unref();
  }

  /** Disarm the pre-dispatch deadline (the watchdog owns liveness from here on). */
  const clearPreDispatchGuard = (): void => {
    if (preDispatchDeadlineTimer) {
      clearTimeout(preDispatchDeadlineTimer);
      preDispatchDeadlineTimer = undefined;
    }
  };
  // Funnel disarm through completeTurnCleanup so EVERY terminal/early-return
  // path stops the deadline timer without sprinkling clearTimeout across the
  // dozen in-window exit sites (success, error, abort, council/proxy bail-outs).
  // Keyed by (turnId, attemptEpoch): a stale old attempt can never overwrite or
  // invoke the live retry's disarm (rework-final-F3).
  registerPreDispatchGuardDisarm(turnId, attemptEpoch, clearPreDispatchGuard);

  /**
   * Stale-turn guard (GPT review F4): true once the pre-dispatch deadline fired
   * and tore the turn down. Call after any pre-dispatch await that could have
   * been the wedged one; if it returns true the caller MUST `return` immediately
   * WITHOUT dispatching events, starting a model call, or re-running cleanup —
   * the guard already emitted the terminal and released the latch.
   */
  const bailIfPreDispatchStale = (site: string): boolean => {
    if (!preDispatchGuardFired) return false;
    turnLogger.warn(
      { turnId, site },
      'Pre-dispatch await resumed after the liveness deadline already fired — discarding stale turn continuation',
    );
    return true;
  };

  // Capture session-level finishLine as a fallback for admission's finishLine
  // resolution (`turnOptions.finishLine ?? session.finishLine`). Loaded once
  // before admission so spawn paths that don't lift session.finishLine onto
  // the turn request (CLI, MCP, recovery retries) still honour the user's
  // criterion. See `docs/plans/260515_finish_line.md`.
  let sessionFinishLine: string | undefined;
  if (rendererSessionId) {
    try {
      const session = await getIncrementalSessionStore().getSession(rendererSessionId);
      sessionFinishLine = session?.finishLine;
    } catch (err) {
      turnLogger.warn({ err, rendererSessionId }, 'Failed to load session for finishLine fallback');
    }
  }
  // Stale-turn guard (F4): getSession is one of the unbounded fs reads that can
  // wedge on a dead cloud mount. If the pre-dispatch deadline fired while we
  // were parked here, the turn was already terminated + cleaned up — abandon
  // this resumed continuation rather than proceeding into admission.
  if (bailIfPreDispatchStale('finishLine-getSession')) return;

  // Admission owns the first real abort checkpoint so it can preserve the
  // synthetic-result event ordering from the monolith before cleanup. The
  // wrapper signal is therefore only for phase-boundary logging/throw mapping.
  const admissionBoundarySignal = new AbortController().signal;
  const admissionTurnOptions = turnOptions
    ? { ...turnOptions, policy: effectivePolicy }
    : { policy: effectivePolicy };
  const admissionResult = await runPhase(
    'admission',
    admit,
    {
      turnId,
      win,
      prompt,
      abortController,
      turnOptions: admissionTurnOptions,
      rendererSessionId,
      sessionFinishLine,
    },
    {
      logger: turnLogger,
      signal: admissionBoundarySignal,
      base,
      accumulator,
      attempt: agentTurnRegistry.getRetryCount(turnId) + 1,
    },
  );

  switch (admissionResult.status) {
    case 'terminal':
      completeTurnCleanup(turnId, admissionResult.reason, attemptEpoch);
      return;
    case 'failed-terminal': {
      const cause = admissionResult.error.cause instanceof Error
        ? admissionResult.error.cause
        : new Error(admissionResult.error.message ?? String(admissionResult.error.cause ?? 'Admission failed'));
      dispatchAgentErrorEvent(win, turnId, cause);
      completeTurnCleanup(turnId, admissionResult.completion.reason, attemptEpoch);
      return;
    }
    case 'failed-recoverable':
      throw new Error('unreachable: admission yielded failed-recoverable');
    case 'ok':
      break;
    default:
      return assertNever(admissionResult);
  }

  const admittedTurn = admissionResult.value;
  base = buildTurnCompletionBaseContext({
    turnId,
    win,
    turnLogger,
    abortController,
    settings: admittedTurn.settings,
    rendererSessionId,
    turnOptions,
    prompt,
    retryTurn,
    trackingCounters,
    watchdogDiagnostics,
    effectiveResetConversation: admittedTurn.effectiveResetConversation,
    getMessageTimeoutMs,
  });

  const admittedCoreDirectory = admittedTurn.settings.coreDirectory;
  if (!admittedCoreDirectory) {
    throw new Error('unreachable: admission returned ok without a core directory');
  }
  const settings: AppSettings & { coreDirectory: string } = {
    ...admittedTurn.settings,
    coreDirectory: admittedCoreDirectory,
  };
  const codexAuthProvider = getCodexAuthProvider();
  const codexConnectedAtTurnStart = admittedTurn.codexConnectedAtTurnStart;
  const profileConnectivity = createProfileConnectivity(
    getProfileConnectivityStateFromSettings(settings, { codexConnected: codexConnectedAtTurnStart }),
  );
  const effectiveResetConversation = admittedTurn.effectiveResetConversation;
  retryEffectiveResetConversation = effectiveResetConversation;
  const unleashedMode = admittedTurn.unleashedMode;
  const finishLine = admittedTurn.finishLine;
  if (finishLine !== undefined) {
    turnLogger.info(
      { turnId, finishLine: true, source: 'turn-admission' },
      'Finish line resolved for turn',
    );
  }
  const councilModeEnabled = admittedTurn.councilModeRequested;
  const {
    promptWithoutOurComponents,
    promptWithoutOurComponentsOrUnleashed,
    explicitDesignContextRequested,
    explicitOurComponentsRequested,
  } = admittedTurn.prompts;

  // Helper: determine TurnEndReason from abort signal (superseded vs user_stopped)
  const abortEndReason = () => abortController.signal.reason === 'superseded' ? 'superseded' as const : 'user_stopped' as const;

  // Extract URLs from the user message for URL-aware tool search enrichment.
  // This runs before pre-turn assembly so domain hints can improve smart query generation.
  // Zero overhead when no URLs are present. See docs/plans/260403_document_prefetch_pipeline.md Stage 2.
  const extractedUrls = extractUrls(promptWithoutOurComponentsOrUnleashed);
  const urlDomainHints = extractedUrls.length > 0 ? enrichToolSearchQuery(extractedUrls) : undefined;
  if (urlDomainHints) {
    turnLogger.debug({ urlCount: extractedUrls.length, urlDomainHints }, 'Extracted URLs for tool search enrichment');
  }

  // Enhance prompt with semantic context from indexed workspace files + suggested tools
  // Uses utilityProcess worker to avoid blocking main process (UI stays responsive)
  //
  // New conversations: full pre-turn assembly (file search + tool search + conversation search)
  // Continuation turns: lightweight file search with higher threshold (0.80) to catch topic pivots
  // Automation sessions: skip entirely to reduce latency
  let effectivePrompt = promptWithoutOurComponents;
  
  // Collect context sections for XML-tagged assembly via buildUserMessageContext()
  const contextSections: UserMessageContextSections = {};
  let suggestedToolsCollected = false;
  
  // Track semantic context separately (avoids fragile string replacement in fallback path)
  let assembledSemanticContext: string | undefined;
  
  // Run pre-turn context assembly for non-automation sessions
  // New conversations get full assembly; continuation turns get file search only (higher threshold)
  let workerSuggestedConversations: Array<{ sessionId: string; title: string; score: number; createdAt: number; messageCount: number }> | undefined;
  let workerConversationSearchStatus: 'ok' | 'unavailable' | undefined;
  let workerToolSearchStatus: 'ok' | 'skipped' | 'unavailable' | undefined;

  const PRE_TURN_ASSEMBLY_TIMEOUT_MS = 60_000;
  const PRE_TURN_ASSEMBLY_TIMEOUT_ERROR_MESSAGE = 'Pre-turn context assembly timed out';
  let assemblyTimedOut = false;
  let assemblyPhase = 'init';
  let preTurnAssemblyTimeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      (async () => {
        const isAssemblyStillActive = () => !assemblyTimedOut;

        // Launch document prefetch in parallel with semantic search (non-blocking)
        let prefetchPromise: Promise<void> | undefined;
        if (extractedUrls.length > 0 && effectivePolicy.prefetchUrls) {
          prefetchPromise = (async () => {
            try {
              assemblyPhase = 'prefetch-init';
              const [activeInstances, prefetchFn] = await Promise.all([
                resolveActiveServerInstances(settings),
                Promise.resolve(createMcpPrefetchFn()),
              ]);
              if (!isAssemblyStillActive()) return;

              assemblyPhase = 'prefetch-fetch';
              const results = await prefetchDocuments(
                extractedUrls,
                catalogData as ConnectorCatalog,
                activeInstances,
                prefetchFn,
                { signal: abortController?.signal },
              );
              if (!isAssemblyStillActive()) return;

              const formattedContext = formatPrefetchedDocumentsContext(results);
              if (formattedContext) {
                contextSections.prefetchedDocuments = formattedContext;
                const fetchedCount = results.filter(r => r.status === 'fetched').length;
                const materializedCount = results.filter(r => r.status === 'materialized').length;
                turnLogger.info(
                  { fetchedCount, materializedCount, totalUrls: results.length },
                  'Prefetched documents for pre-turn context'
                );
                if (isAssemblyStillActive()) {
                  dispatchAgentEvent(win, turnId, {
                    type: 'tool',
                    toolName: 'document_prefetch',
                    toolUseId: `doc-prefetch-${turnId}`,
                    stage: 'end',
                    detail: JSON.stringify({
                      action: 'prefetch',
                      summary: `Prefetched ${fetchedCount + materializedCount} document${fetchedCount + materializedCount === 1 ? '' : 's'}`,
                      fetchedCount,
                      materializedCount,
                      failedCount: results.filter(r => r.status === 'failed').length,
                    }),
                    timestamp: Date.now(),
                    _origin: 'pre-turn-context',
                  });
                }
              }
            } catch (err) {
              turnLogger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Document prefetch failed');
            }
          })();
        }

        if (effectivePolicy.semanticContext === 'sync') {
          // Try to use worker for non-blocking pre-turn work (semantic search + tool search + conversation search)
          assemblyPhase = 'worker-init';
          const preTurnWorker = await getPreTurnWorker();
          if (!isAssemblyStillActive()) return;
          const useWorker = (preTurnWorker?.isWorkerAvailable() ?? false) ||
            (preTurnWorker != null && !preTurnWorker.getWorkerStatus().permanentlyDisabled);

          if (useWorker && settings.coreDirectory && preTurnWorker) {
            try {
              turnLogger.debug('Using pre-turn worker for context assembly');
              assemblyPhase = 'worker-assembly';
              const preTurnToolIndexGeneration = getToolIndexStatus().freshnessGeneration ?? 0;
              const workerResult = await preTurnWorker.assemblePreTurnContext(settings.coreDirectory, {
                prompt: promptWithoutOurComponentsOrUnleashed,
                toolIndexUsable: hasToolIndex(),
              }, urlDomainHints);
              if (!isAssemblyStillActive()) return;

              // Apply semantic context if found
              if (workerResult.semanticContext) {
                if (!isAssemblyStillActive()) return;
                assembledSemanticContext = workerResult.semanticContext.formattedContext;
                contextSections.relevantFiles = workerResult.semanticContext.formattedContext;
                turnLogger.info({ fileCount: workerResult.semanticContext.fileCount }, 'Added semantic context to prompt (via worker)');
                const sources = await buildFileSearchSources(
                  extractSemanticContextFiles(workerResult.semanticContext?.files),
                  settings,
                );
                if (!isAssemblyStillActive()) return;
                const fileNames = sources.slice(0, 8).map(s => s.relativePath.split('/').pop() ?? s.relativePath);
                const fileSummaryLine = `Found ${workerResult.semanticContext.fileCount} relevant file${workerResult.semanticContext.fileCount === 1 ? '' : 's'}`;
                const fileTooltipLines = fileNames.length > 0
                  ? [fileSummaryLine, ...fileNames, ...(sources.length > 8 ? [`+${sources.length - 8} more`] : [])]
                  : [fileSummaryLine];
                dispatchAgentEvent(win, turnId, {
                  type: 'tool',
                  toolName: 'file_search',
                  toolUseId: `file-search-${turnId}`,
                  stage: 'end',
                  detail: JSON.stringify({
                    action: 'search',
                    summary: fileTooltipLines.join('\n'),
                    fileCount: workerResult.semanticContext.fileCount,
                    sources,
                  }),
                  timestamp: Date.now(),
                  _origin: 'pre-turn-context',
                });
              }

              // Apply suggested tools if found
              if (workerResult.suggestedTools && workerResult.suggestedTools.length > 0) {
                const currentToolIndexGeneration = getToolIndexStatus().freshnessGeneration ?? 0;
                if (!hasToolIndex() || currentToolIndexGeneration !== preTurnToolIndexGeneration) {
                  turnLogger.info(
                    {
                      resultToolCount: workerResult.suggestedTools.length,
                      preTurnToolIndexGeneration,
                      currentToolIndexGeneration,
                    },
                    'Discarding worker suggested tools because tool index freshness changed',
                  );
                } else {
                  // Build server account map for multi-account disambiguation (fast, main process only)
                  const serverAccountMap = await buildServerAccountMap();
                  if (!isAssemblyStillActive()) return;
                  // Parse inputSchema from JSON string (worker returns stringified schemas)
                  const toolsWithSchema = workerResult.suggestedTools.map(t => {
                    let parsed: unknown = {};
                    try { parsed = typeof t.inputSchema === 'string' ? JSON.parse(t.inputSchema) : t.inputSchema; } catch { /* keep empty */ }
                    return { ...t, inputSchema: parsed };
                  });
                  const toolsContext = formatSuggestedToolsContext(toolsWithSchema, serverAccountMap);
                  if (toolsContext) {
                    if (!isAssemblyStillActive()) return;
                    contextSections.suggestedTools = toolsContext;
                    suggestedToolsCollected = true;
                    turnLogger.info({ toolCount: workerResult.suggestedTools.length }, 'Added suggested tools to prompt (via worker)');
                    if (!isAssemblyStillActive()) return;
                    const toolNamesList = toolsWithSchema.slice(0, 8).map(t => t.toolId);
                    const toolSummaryLine = `Found ${toolsWithSchema.length} relevant tool${toolsWithSchema.length === 1 ? '' : 's'}`;
                    const toolTooltipLines = toolNamesList.length > 0
                      ? [toolSummaryLine, ...toolNamesList, ...(toolsWithSchema.length > 8 ? [`+${toolsWithSchema.length - 8} more`] : [])]
                      : [toolSummaryLine];
                    dispatchAgentEvent(win, turnId, {
                      type: 'tool',
                      toolName: 'tool_search',
                      toolUseId: `tool-search-${turnId}`,
                      stage: 'end',
                      detail: JSON.stringify({
                        action: 'search',
                        summary: toolTooltipLines.join('\n'),
                        toolCount: toolsWithSchema.length,
                      }),
                      timestamp: Date.now(),
                      _origin: 'pre-turn-context',
                    });
                  }
                }
              }
              // Apply suggested skills if found
              if (workerResult.suggestedSkills && workerResult.suggestedSkills.length > 0) {
                const skillsContext = formatSuggestedSkillsContext(workerResult.suggestedSkills);
                if (skillsContext && isAssemblyStillActive()) {
                  effectivePrompt = `${skillsContext}\n\n${effectivePrompt}`;
                  turnLogger.info({ skillCount: workerResult.suggestedSkills.length }, 'Added suggested skills to prompt (via worker)');
                  if (isAssemblyStillActive()) {
                    const skillNamesList = workerResult.suggestedSkills.slice(0, 8).map(s => s.skillName);
                    const skillSummaryLine = `Found ${workerResult.suggestedSkills.length} relevant skill${workerResult.suggestedSkills.length === 1 ? '' : 's'}`;
                    const skillTooltipLines = skillNamesList.length > 0
                      ? [skillSummaryLine, ...skillNamesList, ...(workerResult.suggestedSkills.length > 8 ? [`+${workerResult.suggestedSkills.length - 8} more`] : [])]
                      : [skillSummaryLine];
                    dispatchAgentEvent(win, turnId, {
                      type: 'tool',
                      toolName: 'skill_search',
                      toolUseId: `skill-search-${turnId}`,
                      stage: 'end',
                      detail: JSON.stringify({
                        action: 'search',
                        summary: skillTooltipLines.join('\n'),
                        skillCount: workerResult.suggestedSkills.length,
                      }),
                      timestamp: Date.now(),
                      _origin: 'pre-turn-context',
                    });
                  }
                }
              }
              // Capture conversation and tool search status for fallback decisions below
              if (!isAssemblyStillActive()) return;
              workerSuggestedConversations = workerResult.suggestedConversations;
              workerConversationSearchStatus = workerResult.conversationSearchStatus;
              workerToolSearchStatus = workerResult.toolSearchStatus;
            } catch (workerError) {
              if (!isAssemblyStillActive()) return;
              turnLogger.warn({ err: workerError }, 'Pre-turn worker failed, falling back to main process');
              // Fall through to main-process fallback below
            }
          }

          if (!isAssemblyStillActive()) return;
          // Fallback: use main-process implementation if worker didn't provide results
          assemblyPhase = 'semantic-fallback';
          if (!assembledSemanticContext) {
            try {
              const { contextAdded, fileCount, formattedContext, files } = await enhancePromptWithSemanticContext(promptWithoutOurComponentsOrUnleashed, {
                enabled: true,
                settings,
                backgroundModel: resolveBtsModel(settings),

              });
              if (!isAssemblyStillActive()) return;
              if (contextAdded && formattedContext) {
                if (!isAssemblyStillActive()) return;
                assembledSemanticContext = formattedContext;
                contextSections.relevantFiles = formattedContext;
                turnLogger.info({ fileCount }, 'Added semantic context to prompt (main process fallback)');
                const sources = await buildFileSearchSources(files, settings);
                if (!isAssemblyStillActive()) return;
                const fbFileNames = sources.slice(0, 8).map(s => s.relativePath.split('/').pop() ?? s.relativePath);
                const fbFileSummary = `Found ${fileCount} relevant file${fileCount === 1 ? '' : 's'}`;
                const fbFileTooltip = fbFileNames.length > 0
                  ? [fbFileSummary, ...fbFileNames, ...(sources.length > 8 ? [`+${sources.length - 8} more`] : [])]
                  : [fbFileSummary];
                dispatchAgentEvent(win, turnId, {
                  type: 'tool',
                  toolName: 'file_search',
                  toolUseId: `file-search-${turnId}`,
                  stage: 'end',
                  detail: JSON.stringify({
                    action: 'search',
                    summary: fbFileTooltip.join('\n'),
                    fileCount,
                    sources,
                  }),
                  timestamp: Date.now(),
                  _origin: 'pre-turn-context',
                });
              } else {
                turnLogger.debug('No semantic context added (no results above threshold)');
              }
            } catch (error) {
              if (!isAssemblyStillActive()) return;
              turnLogger.warn({ err: error }, 'Failed to enhance prompt with semantic context');
            }
          }

          // Tool search fallback (only for new conversations, only if worker didn't provide tools,
          // and only when the worker couldn't perform the search — not when it intentionally skipped).
          // Also runs when worker returned 'ok' but found zero tools above threshold (embedding
          // dilution can cause vector-only search to miss relevant tools; the main-process hybrid
          // FTS+vector+RRF search is stronger and may find them).
          assemblyPhase = 'tool-search-fallback';
          const TOOL_SEARCH_FALLBACK_TIMEOUT_MS = 5_000;
          if (
            hasToolIndex() && !suggestedToolsCollected
            && workerToolSearchStatus !== 'skipped'
          ) {
            const fallbackReason = workerToolSearchStatus === 'ok' ? 'worker_zero_results'
              : workerToolSearchStatus === 'unavailable' ? 'worker_unavailable'
              : 'worker_status_missing';
            turnLogger.info({ fallbackReason, workerToolSearchStatus }, 'Running main-process tool search fallback');
            try {
              const toolSearchResult = await Promise.race([
                Promise.all([buildServerAccountMap(), searchTools(sanitizeUrlsForEmbedding(promptWithoutOurComponents), 10, 0.35, 5)]),
                new Promise<null>(resolve => setTimeout(() => resolve(null), TOOL_SEARCH_FALLBACK_TIMEOUT_MS)),
              ]);
              if (!isAssemblyStillActive()) return;

              if (toolSearchResult === null) {
                turnLogger.warn('Tool search fallback timed out — proceeding without suggested tools');
              } else {
                const [serverAccountMap, suggestedTools] = toolSearchResult;
                if (suggestedTools.length > 0) {
                  const toolsContext = formatSuggestedToolsContext(suggestedTools, serverAccountMap);
                  if (toolsContext) {
                    if (!isAssemblyStillActive()) return;
                    contextSections.suggestedTools = toolsContext;
                    suggestedToolsCollected = true;
                    turnLogger.info({ toolCount: suggestedTools.length }, 'Added suggested tools to prompt (main process fallback)');
                    if (!isAssemblyStillActive()) return;
                    const fbToolNames = suggestedTools.slice(0, 8).map(t => t.name);
                    const fbToolSummary = `Found ${suggestedTools.length} relevant tool${suggestedTools.length === 1 ? '' : 's'}`;
                    const fbToolTooltip = fbToolNames.length > 0
                      ? [fbToolSummary, ...fbToolNames, ...(suggestedTools.length > 8 ? [`+${suggestedTools.length - 8} more`] : [])]
                      : [fbToolSummary];
                    dispatchAgentEvent(win, turnId, {
                      type: 'tool',
                      toolName: 'tool_search',
                      toolUseId: `tool-search-${turnId}`,
                      stage: 'end',
                      detail: JSON.stringify({
                        action: 'search',
                        summary: fbToolTooltip.join('\n'),
                        toolCount: suggestedTools.length,
                      }),
                      timestamp: Date.now(),
                      _origin: 'pre-turn-context',
                    });
                  }
                }
              }
            } catch (error) {
              if (!isAssemblyStillActive()) return;
              turnLogger.warn({ err: error }, 'Failed to search for suggested tools');
            }
          }
        } else {
          turnLogger.debug('Skipped semantic context for automation session (latency optimization)');
        }

        // Await prefetch if it was launched (runs in parallel with all the above)
        if (prefetchPromise) {
          await prefetchPromise;
        }
      })(),
      new Promise<never>((_resolve, reject) => {
        preTurnAssemblyTimeoutId = setTimeout(() => {
          assemblyTimedOut = true;
          reject(new Error(PRE_TURN_ASSEMBLY_TIMEOUT_ERROR_MESSAGE));
        }, PRE_TURN_ASSEMBLY_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message === PRE_TURN_ASSEMBLY_TIMEOUT_ERROR_MESSAGE) {
      assemblyTimedOut = true;
      turnLogger.warn(
        { timeoutMs: PRE_TURN_ASSEMBLY_TIMEOUT_MS, assemblyPhase },
        'Pre-turn context assembly timed out — proceeding without context'
      );
      dispatchAgentEvent(win, turnId, {
        type: 'status',
        message: 'Context search took longer than expected — continuing with limited workspace context.',
        timestamp: Date.now(),
      });
    } else {
      throw error;
    }
  } finally {
    if (preTurnAssemblyTimeoutId) {
      clearTimeout(preTurnAssemblyTimeoutId);
    }
  }

  // ABORT CHECKPOINT 2: After semantic search + tool search (3-10s cumulative).
  if (abortController.signal.aborted) {
    // If the pre-dispatch liveness guard fired, the abort is ours: the retryable
    // terminal + cleanup already ran. Bail silently rather than emitting a
    // misleading user_stopped/superseded synthetic result (F4).
    if (bailIfPreDispatchStale('abort-checkpoint-2')) return;
    turnLogger.info('Turn aborted during setup (post-context-assembly)');
    dispatchAgentEvent(win, turnId, makeSyntheticResult(turnId, '', abortEndReason()));
    completeTurnCleanup(turnId, 'aborted', attemptEpoch);
    return;
  }

  // ===== AUTO-INJECT RELEVANT PAST CONVERSATIONS =====
  // Parse keyword from raw user prompt (not effectivePrompt) to avoid false positives
  // from injected file context that might contain literal "@conversations"
  let autoConversationsInjected = false;
  const conversationKeywordResult = parseConversationSearchKeyword(promptWithoutOurComponents);

  if (!conversationKeywordResult.hasConversationSearch && effectivePolicy.autoInjectPastConversations) {
    // Worker path: use pre-fetched conversation candidates
    if (workerSuggestedConversations && workerSuggestedConversations.length > 0 && workerConversationSearchStatus !== 'unavailable') {
      try {
        const autoResult = await loadFilterAndFormatConversations(workerSuggestedConversations, rendererSessionId ?? undefined, turnLogger);
        if (bailIfPreDispatchStale('auto-conversation-worker')) return; // rework-F1
        if (autoResult) {
          contextSections.relevantConversations = autoResult.formattedContext;
          autoConversationsInjected = true;
          turnLogger.info({ conversationCount: autoResult.count, totalChars: autoResult.totalChars, topScore: autoResult.topScore }, 'Auto-injected relevant conversation context');
          dispatchAgentEvent(win, turnId, {
            type: 'tool', toolName: 'conversation_search', toolUseId: `conversation-search-auto-${turnId}`, stage: 'end',
            detail: JSON.stringify({ action: 'search', trigger: 'auto', summary: `Found ${autoResult.count} relevant conversation${autoResult.count === 1 ? '' : 's'}`, conversationCount: autoResult.count }),
            timestamp: Date.now(),
            _origin: 'pre-turn-context',
          });
        }
      } catch (error) {
        turnLogger.warn({ err: error }, 'Failed to auto-inject conversation context');
      }
    }

    // Main-process fallback: only when worker couldn't access the conversation index
    if (
      !autoConversationsInjected &&
      (workerConversationSearchStatus === 'unavailable' || workerConversationSearchStatus === undefined)
    ) {
      try {
        turnLogger.debug('Attempting main process fallback for conversation auto-injection');
        const fallbackResults = await searchConversationsMainProcess(promptWithoutOurComponents, {
          limit: 5,
          threshold: AUTO_CONVERSATION_THRESHOLD,
        });
        if (bailIfPreDispatchStale('auto-conversation-fallback-search')) return; // rework-F1
        if (fallbackResults.length > 0) {
          const autoResult = await loadFilterAndFormatConversations(fallbackResults, rendererSessionId ?? undefined, turnLogger);
          if (bailIfPreDispatchStale('auto-conversation-fallback-load')) return; // rework-F1
          if (autoResult) {
            contextSections.relevantConversations = autoResult.formattedContext;
            autoConversationsInjected = true;
            turnLogger.info({ conversationCount: autoResult.count, totalChars: autoResult.totalChars, topScore: autoResult.topScore }, 'Auto-injected relevant conversation context (main process fallback)');
            dispatchAgentEvent(win, turnId, {
              type: 'tool', toolName: 'conversation_search', toolUseId: `conversation-search-auto-fallback-${turnId}`, stage: 'end',
              detail: JSON.stringify({ action: 'search', trigger: 'auto-fallback', summary: `Found ${autoResult.count} relevant conversation${autoResult.count === 1 ? '' : 's'}`, conversationCount: autoResult.count }),
              timestamp: Date.now(),
              _origin: 'pre-turn-context',
            });
          }
        }
      } catch (error) {
        turnLogger.warn({ err: error }, 'Failed to auto-inject conversation context (main process fallback)');
      }
    }
  }

  // Enhance prompt with conversation context when @conversations keyword is used
  // Parse from promptForContext (raw user input) to avoid false positives from injected context
  // Uses lazy session loading to avoid ~480ms sync disk I/O for every turn
  // Always check for and strip @conversations keyword, even if loadSessions isn't available
  // (e.g., background tasks) to prevent the raw keyword from leaking to the model
  try {
    if (conversationKeywordResult.hasConversationSearch) {
      // Strip keyword from effectivePrompt to prevent it leaking to the model
      const { sanitizedPrompt } = parseConversationSearchKeyword(effectivePrompt);
      effectivePrompt = sanitizedPrompt;

      if (turnOptions?.loadSessions) {
        const sessions = turnOptions.loadSessions();

        if (sessions.length > 0) {
          const {
            contextAdded: convContextAdded,
            conversationCount,
            formattedContext: convFormattedContext,
          } = await enhancePromptWithConversationContext(effectivePrompt, sessions);

          if (bailIfPreDispatchStale('enhance-conversation-context')) return; // rework-F1
          if (convContextAdded && convFormattedContext) {
            contextSections.relevantConversations = convFormattedContext;
            turnLogger.info({ conversationCount }, 'Added conversation context to prompt');
            dispatchAgentEvent(win, turnId, {
              type: 'tool',
              toolName: 'conversation_search',
              toolUseId: `conversation-search-${turnId}`,
              stage: 'end',
              detail: JSON.stringify({
                action: 'search',
                summary: `Found ${conversationCount} relevant conversation${conversationCount === 1 ? '' : 's'}`,
                conversationCount,
              }),
              timestamp: Date.now(),
              _origin: 'pre-turn-context',
            });
            turnLogger.debug({ turnId }, 'Dispatched conversation_search tool event');
          } else {
            turnLogger.debug('Conversation search keyword detected but no results found');
          }
        } else {
          turnLogger.debug('Conversation search keyword detected but no sessions available');
        }
      } else {
        turnLogger.debug('Conversation search keyword detected but loadSessions not available - stripped keyword');
      }
    }
  } catch (error) {
    turnLogger.warn({ err: error }, 'Failed to enhance prompt with conversation context');
  }

  // ===== MEETING COMPANION CONTEXT =====
  // For meeting companion sessions, inject context based on what's needed:
  // - First turn (or coach changed): full context (coach skill + tool hint)
  // - Subsequent turns: brief reminder to use the tool
  if (rendererSessionId && turnOptions?.getMeetingCompanionContext) {
    try {
      const companionContext = await turnOptions.getMeetingCompanionContext(rendererSessionId);
      // Stale-turn guard (rework-F1): a guard-fired attempt must not mutate
      // contextSections / meeting-coach state or dispatch after the deadline.
      if (bailIfPreDispatchStale('meeting-companion-context')) return;
      if (companionContext) {
        const { currentCoachPath, lastInjectedCoachPath, coachSkillContent } = companionContext;
        
        // Determine if we need full injection or just a reminder
        // Normalize "no coach" values: null, undefined, and '' are all considered "no coach"
        const normalizeCoachPath = (p: string | null | undefined): string | null => 
          (p === undefined || p === '' || p === null) ? null : p;
        const normalizedCurrent = normalizeCoachPath(currentCoachPath);
        const normalizedLast = normalizeCoachPath(lastInjectedCoachPath);
        
        const isFirstTurn = lastInjectedCoachPath === undefined;
        const coachChanged = !isFirstTurn && normalizedCurrent !== normalizedLast;
        const needsFullInjection = isFirstTurn || coachChanged;
        
        if (needsFullInjection) {
          const contextParts: string[] = [
            '**[MEETING COMPANION SESSION]**',
            '',
            'You are assisting the user during a LIVE MEETING that is currently in progress.',
            'The user\'s questions likely relate to what\'s being discussed in this meeting.',
            '',
            '**IMPORTANT**: Before answering, use the `rebel_meetings_live_transcript` tool to get the current meeting transcript.',
            'This gives you context about what\'s being discussed right now.',
            '',
            'If the user asks you to send a message to the meeting chat, use the `rebel_meetings_live_send_chat` tool.',
          ];
          
          const coachContentInjected = !!(coachSkillContent && currentCoachPath);
          
          if (coachContentInjected) {
            contextParts.push('');
            contextParts.push('**Your coaching role:**');
            contextParts.push(coachSkillContent);
          }
          
          contextSections.meetingContext = contextParts.join('\n');
          
          // Only update lastInjectedCoachPath if:
          // - No coach selected (null) - always safe to record
          // - Coach selected AND content was successfully loaded - prevents "sticking" on read failures
          const shouldUpdateLastInjected = !currentCoachPath || coachContentInjected;
          if (turnOptions.setLastInjectedCoachPath && shouldUpdateLastInjected) {
            turnOptions.setLastInjectedCoachPath(rendererSessionId, currentCoachPath);
          }
          
          turnLogger.info(
            { isFirstTurn, coachChanged, hasCoach: !!currentCoachPath, coachContentInjected },
            'Injected full meeting companion context'
          );
        } else {
          contextSections.meetingContext = `[MEETING IN PROGRESS - Use \`rebel_meetings_live_transcript\` tool to get the latest transcript before answering.]`;
          turnLogger.debug('Added meeting companion reminder to prompt');
        }
      }
    } catch (error) {
      turnLogger.warn({ err: error }, 'Failed to get meeting companion context');
    }
  }

  // ===== FOCUS CONTEXT =====
  // For Focus-origin sessions on the first turn, inject calendar + goals context.
  // Detection uses the origin hint from the turn request (avoids async session lookup race).
  if (rendererSessionId && turnOptions?.getFocusContext) {
    try {
      const focusContent = await turnOptions.getFocusContext(rendererSessionId, turnOptions.origin);
      if (bailIfPreDispatchStale('focus-context')) return; // rework-F1
      if (focusContent) {
        contextSections.focusContext = focusContent;
        turnLogger.info('Injected Focus context into first turn');
      }
    } catch (error) {
      turnLogger.warn({ err: error }, 'Failed to get Focus context');
    }
  }

  if (
    settings.coreDirectory &&
    shouldInjectDesignContext(
      promptWithoutOurComponents,
      turnOptions?.attachments ?? [],
      explicitDesignContextRequested,
    )
  ) {
    try {
      const designContext = await buildDesignContext({
        prompt: promptWithoutOurComponents,
        coreDirectory: settings.coreDirectory,
        attachments: turnOptions?.attachments ?? [],
        explicitRequested: explicitDesignContextRequested,
      });
      if (bailIfPreDispatchStale('design-context')) return; // rework-F1
      contextSections.designContext = designContext;
      turnLogger.info(
        { explicitRequested: explicitDesignContextRequested },
        'Injected design-context grounding'
      );
    } catch (error) {
      turnLogger.warn({ err: error }, 'Failed to build design-context grounding');
    }
  }

  if (
    settings.coreDirectory &&
    shouldInjectOurComponentsContext(
      promptWithoutOurComponents,
      turnOptions?.attachments ?? [],
      explicitOurComponentsRequested,
    )
  ) {
    try {
      const ourComponentsContext = await buildOurComponentsContext({
        prompt: promptWithoutOurComponents,
        coreDirectory: settings.coreDirectory,
        attachments: turnOptions?.attachments ?? [],
        explicitRequested: explicitOurComponentsRequested,
      });
      if (bailIfPreDispatchStale('our-components-context')) return; // rework-F1
      contextSections.ourComponents = ourComponentsContext;
      turnLogger.info(
        { explicitRequested: explicitOurComponentsRequested },
        'Injected our-components design context'
      );
    } catch (error) {
      // The our-components grounding files only live in the Rebel git repo,
      // not in a typical user workspace. Treat the unavailable case as info
      // (and log only the first time per coreDirectory per process) so we
      // don't flood the diagnostics with the same expected ENOENT.
      if (error instanceof OurComponentsContextUnavailableError) {
        if (!ourComponentsUnavailableLogged.has(error.coreDirectory)) {
          ourComponentsUnavailableLogged.add(error.coreDirectory);
          turnLogger.info(
            { coreDirectory: error.coreDirectory, missingPath: error.missingPath },
            'Our-components design context unavailable (grounding files not present in this workspace) — skipping'
          );
        }
      } else {
        turnLogger.warn({ err: error }, 'Failed to build our-components context');
      }
    }
  }

  // ===== ASSEMBLE FINAL USER MESSAGE =====
  // Combine all collected context sections with the user's prompt using XML tags.
  // Order: focus-context > meeting-context > relevant-conversations > suggested-tools > prefetched-documents > design-context > our-components > relevant-files > response-shape-contract > user-request
  const responseShapeContract = buildResponseShapeContractForPrompt(promptWithoutOurComponents);
  if (responseShapeContract) {
    contextSections.responseShapeContract = responseShapeContract;
    turnLogger.info(
      { contract: 'review-confirmation-brief' },
      'Injected local response-shape contract for review/confirmation request'
    );
  }

  // Diagnostic: log prompt section metadata before assembly
  {
    const sectionSizes: Record<string, number> = {};
    for (const [key, value] of Object.entries(contextSections)) {
      if (value) {
        sectionSizes[key] = typeof value === 'string' ? value.length : JSON.stringify(value).length;
      }
    }
    const totalSectionChars = Object.values(sectionSizes).reduce((sum, size) => sum + size, 0);
    turnLogger.info(
      {
        sections: sectionSizes,
        sectionCount: Object.keys(sectionSizes).length,
        totalSectionChars,
        promptLengthBeforeAssembly: effectivePrompt.length,
      },
      'Pre-turn context sections assembled'
    );
  }

  effectivePrompt = buildUserMessageContext(contextSections, effectivePrompt);

  // Self-block follow-on (260427) — sub-stage C. Inject the
  // stuck-registration nudge as a `<system-reminder>` preamble when the
  // post-turn sweep flagged a contribution that was built+tested but
  // never registered. See `buildStuckRegistrationReminder` for the
  // predicate and the SKILL.md anti-pattern callout this references.
  try {
    const stuckRegistrationReminder = buildStuckRegistrationReminder(rendererSessionId ?? undefined);
    if (stuckRegistrationReminder) {
      effectivePrompt = `${stuckRegistrationReminder}\n\n${effectivePrompt}`;
      turnLogger.info(
        { breadcrumb: 'stuck-registration-reminder-injected' },
        'Stuck-registration system-reminder injected into agent turn preamble',
      );
    }
  } catch (err) {
    turnLogger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to build stuck-registration reminder (non-fatal)',
    );
  }

  const requestedAttachments = turnOptions?.attachments ?? [];

  // Separate text, image, document, extracted PDF, office, text file, and binary attachments
  const {
    textAttachments: rawTextAttachments,
    imageAttachments: rawImageAttachments,
    documentAttachments: rawDocumentAttachments,
    extractedPdfAttachments: rawExtractedPdfAttachments,
    officeAttachments: rawOfficeAttachments,
    textFileAttachments: rawTextFileAttachments,
    binaryAttachments: rawBinaryAttachments,
  } = separateAttachments(requestedAttachments);

  // Validate and filter all attachment types (count limits, size limits, path resolution)
  const {
    textAttachmentPayload,
    imageAttachmentPayload,
    documentAttachmentPayload,
    extractedPdfAttachmentPayload,
    officeAttachmentPayload,
    textFileAttachmentPayload,
    binaryAttachmentPayload,
    skillModelRecommendations,
    skillEffortRecommendations,
  } = validateAndFilterAttachments({
    rawTextAttachments,
    rawImageAttachments,
    rawDocumentAttachments,
    rawExtractedPdfAttachments,
    rawOfficeAttachments,
    rawTextFileAttachments,
    rawBinaryAttachments,
    coreDirectory: settings.coreDirectory,
    turnLogger,
  });

  // Resolve source paths for all attachments (originalPath or temp file)
  const sourcePathMap = new Map<string, string>();

  if (hasLocalFilesystemAccess()) {
    const allAttachmentsForPaths: AnyAttachmentPayload[] = [
      ...imageAttachmentPayload,
      ...documentAttachmentPayload,
      ...extractedPdfAttachmentPayload,
      ...officeAttachmentPayload,
      ...textFileAttachmentPayload,
      ...binaryAttachmentPayload,
    ];

    await Promise.all(
      allAttachmentsForPaths.map(async (attachment) => {
        try {
          const sourcePath = await resolveAttachmentSourcePath(attachment);
          if (sourcePath) {
            sourcePathMap.set(attachment.id, sourcePath);
          }
        } catch (error) {
          turnLogger.warn(
            { error, name: attachment.name },
            'Failed to resolve attachment source path'
          );
        }
      })
    );

    if (bailIfPreDispatchStale('attachment-source-paths')) return; // rework-F1
    if (sourcePathMap.size > 0) {
      turnLogger.info({ resolvedPaths: sourcePathMap.size }, 'Resolved attachment source paths');
    }
  }

  // Store the user's raw prompt BEFORE history injection so overflow recovery
  // and memory writes get the actual user request, not the system-enriched version.
  // This eliminates <conversation_history> duplication in compaction at the source.
  agentTurnRegistry.setTurnPrompt(turnId, effectivePrompt);
  const recoveryMessages = effectiveResetConversation
    ? toRecoveryChatMessages(turnOptions?.recoveryMessages)
    : [];

  // Inject conversation context from disk whenever the turn is associated with a
  // renderer session so follow-up turns keep their prior context.
  //
  // Stage 2 of `docs/plans/260525_cross_turn_awareness_layer1_layer2.md`:
  // routes through `buildContinuationContext`, which (a) prepends a
  // deterministic `<prior_turns>` header (when enabled) so follow-ups know
  // what prior turns already did, and (b) honours the F3 anti-double-inject
  // contract — when `turnOptions.continuationContext.alreadyInjected` is
  // true, an upstream accumulator already attached header + history to the
  // prompt and we skip the proactive prepend entirely.
  if (turnOptions?.continuationContext?.alreadyInjected === true) {
    turnLogger?.info(
      {
        rendererSessionId,
        ...formatPriorTurnsHeaderEvent(
          turnOptions.continuationContext.meta,
          'continuation-passthrough',
        ),
      },
      'Skipping proactive context injection — continuation accumulator already injected',
    );
  } else if (rendererSessionId) {
    // Auxiliary kinds (memory-update, automation, meeting-qa, etc.) routinely
    // run as single-turn flows with no prior history — empty history is correct
    // and expected for them, so log at info. Only user-facing kinds
    // (`conversation`, `meeting-companion`) get warn-level for the empty case.
    const sessionKind = classifySessionKind(rendererSessionId);
    const isAuxiliaryKind = sessionKind !== 'conversation' && sessionKind !== 'meeting-companion';
    turnLogger?.info(
      { rendererSessionId, sessionKind, resetConversation: effectiveResetConversation },
      'Injecting disk-based conversation history for agent turn context'
    );
    const built = await buildContinuationContext({
      sessionId: rendererSessionId,
      currentTurnId: turnId,
      scope: 'main',
      resetConversation: effectiveResetConversation === true,
      modeInput: { mode: 'proactive-main' },
      turnLogger: turnLogger ?? createScopedLogger({ service: 'agentTurnExecute' }),
    });
    // Stale-turn guard (F4): buildContinuationContext reads conversation history
    // from disk (the logforensics prime-suspect wedge site). If the pre-dispatch
    // deadline fired while parked here, the turn was already terminated — abandon
    // this resumed continuation before we mutate the prompt or dispatch anything.
    if (bailIfPreDispatchStale('buildContinuationContext')) return;
    if (recoveryMessages.length > 0) {
      turnLogger?.info(
        { rendererSessionId, recoveryMessageCount: recoveryMessages.length },
        'Using stripped recovery message history for reset retry'
      );
    } else if (built.prefix) {
      effectivePrompt = built.prefix + effectivePrompt;
    } else if (isAuxiliaryKind) {
      turnLogger?.info(
        { rendererSessionId, sessionKind },
        'History injection returned empty (expected for auxiliary session kind)'
      );
    } else {
      turnLogger?.warn(
        { rendererSessionId, sessionKind },
        'History injection returned empty — turn will have NO conversation context'
      );
    }
  }

  // For text-only turns, use the original string prompt approach
  // For turns with media (images or documents), we'll use the async generator
  const hasMedia = imageAttachmentPayload.length > 0 || documentAttachmentPayload.length > 0;

  // Build prompt with text and office attachments
  let promptWithAttachments = hasMedia
    ? effectivePrompt // Don't append text attachments here; the generator will handle it
    : appendAttachmentsToPrompt(effectivePrompt, textAttachmentPayload, sourcePathMap);

  // Office attachments are always appended to prompt (extracted text, not API content blocks)
  promptWithAttachments = appendOfficeAttachmentsToPrompt(
    promptWithAttachments,
    officeAttachmentPayload,
    sourcePathMap
  );

  // Extracted PDF attachments are always appended to prompt (text extraction from large PDFs)
  promptWithAttachments = appendExtractedPdfAttachmentsToPrompt(
    promptWithAttachments,
    extractedPdfAttachmentPayload,
    sourcePathMap
  );

  // Text file attachments are always appended to prompt (similar to office attachments)
  promptWithAttachments = appendTextFileAttachmentsToPrompt(
    promptWithAttachments,
    textFileAttachmentPayload,
    sourcePathMap
  );

  // Binary attachments include metadata and source path only (no extracted content)
  promptWithAttachments = appendBinaryAttachmentsToPrompt(
    promptWithAttachments,
    binaryAttachmentPayload,
    sourcePathMap
  );

  const totalAttachments =
    textAttachmentPayload.length +
    imageAttachmentPayload.length +
    documentAttachmentPayload.length +
    extractedPdfAttachmentPayload.length +
    officeAttachmentPayload.length +
    textFileAttachmentPayload.length +
    binaryAttachmentPayload.length;
  turnLogger.info(
    {
      promptLength: promptWithAttachments.length,
      resetConversation: effectiveResetConversation,
      textAttachments: textAttachmentPayload.length,
      imageAttachments: imageAttachmentPayload.length,
      documentAttachments: documentAttachmentPayload.length,
      extractedPdfAttachments: extractedPdfAttachmentPayload.length,
      officeAttachments: officeAttachmentPayload.length,
      textFileAttachments: textFileAttachmentPayload.length,
      binaryAttachments: binaryAttachmentPayload.length,
      hasMedia,
    },
    'Agent turn requested'
  );
  if (turnLogger.sessionLogPath) {
    logger.info(
      { turnId, sessionLogPath: turnLogger.sessionLogPath },
      'Agent turn session log created'
    );
  }

  // Declare variables that need to be accessible in catch block for retry logic
  let modelConfig!: ReturnType<typeof resolveModelConfig>;
  let queryOptions!: Omit<TurnParams, 'prompt'> & { mcpServers?: McpServers };
  let buildQueryOptions!: () => Omit<TurnParams, 'prompt'> & { mcpServers?: McpServers };
  let promptOrGenerator: string | AsyncGenerator<unknown, void, unknown>;
  // Factory function for creating prompt/generator - declared here so catch block can use it for retries
  // (generators can only be consumed once, so retries need a fresh generator)
  let createPromptOrGenerator!: (conversationContext?: string) => typeof promptOrGenerator;
  // FOX-2656: Alt-model state — hoisted so the catch block can access them.
  // activeProfile/councilConfig/adHocConfig are assigned inside the try block;
  // the catch block uses them to decide whether to fall back to Claude.
  let activeProfile: ReturnType<typeof getWorkingModelProfile> | undefined;
  let councilConfig: CouncilConfig | null = null;
  let adHocConfig: AdHocAgentConfig | null = null;
  let claudeSubagentConfig: ClaudeSubagentConfig | null = null;
  let routeInput!: ProviderRouterTurnInput;
  let routeRuntimeContextForDecision!: (decision: ProviderRouteDecision) => ProviderRouteRuntimeContext;
  let isDirectRoleProfile = false;
  const altModelFallbackAttempted = false;
  const nestedFallbackQueryAttempted = false;
  // Role-based routing for Thinking/Working profiles
  const configuredThinkingProfile = getThinkingProfile(settings);
  const configuredWorkingProfile = getWorkingProfile(settings);
  const availableProfiles = settings.localModel?.profiles ?? [];
  const skillModelResolution = resolveSkillModelRecommendations(
    skillModelRecommendations,
    availableProfiles
  );
  if (skillModelResolution.unresolvedModels.length > 0) {
    turnLogger.warn(
      { unresolvedModels: skillModelResolution.unresolvedModels },
      'Skill model recommendations could not be resolved to Claude aliases or local profiles; using annotation only'
    );
  }
  const rawThinkingProfile = turnOptions?.thinkingProfileOverrideId !== undefined
    ? (turnOptions.thinkingProfileOverrideId
        ? availableProfiles.find((p) => p.id === turnOptions.thinkingProfileOverrideId) ?? null
        : null)
    : configuredThinkingProfile;
  const rawWorkingProfile = turnOptions?.workingProfileOverrideId !== undefined
    ? (turnOptions.workingProfileOverrideId
        ? availableProfiles.find((p) => p.id === turnOptions.workingProfileOverrideId) ?? null
        : null)
    : configuredWorkingProfile;
  // Guard: profiles without a model name can't be routed — the proxy would send
  // a literal "default" model name to the upstream, causing 400 errors.
  const thinkingProfile = rawThinkingProfile?.model?.trim() ? rawThinkingProfile : null;
  const workingProfile = rawWorkingProfile?.model?.trim() ? rawWorkingProfile : null;
  if (rawThinkingProfile && !thinkingProfile) {
    turnLogger.warn({ profileId: rawThinkingProfile.id, profileName: rawThinkingProfile.name }, 'Thinking profile has no model name — skipping role routing for this role');
  }
  if (rawWorkingProfile && !workingProfile) {
    turnLogger.warn({ profileId: rawWorkingProfile.id, profileName: rawWorkingProfile.name }, 'Working profile has no model name — skipping role routing for this role');
  }
  const configuredWorkingModel = getCurrentModel(settings) ?? getDefaultModelForProvider(settings, 'working');
  const effectiveWorkingProfile = workingProfile;
  const effectiveThinkingProfile = thinkingProfile;
  const routeSettings: AppSettings & { coreDirectory: string } = settings;
  const diagnosticWorkingModel = configuredWorkingModel;
  const effectiveThinkingEffort = resolveReasoningEffort({
    envEffort: process.env.CLAUDE_CODE_EFFORT_LEVEL,
    sessionEffort: turnOptions?.thinkingEffortOverride,
    modelId: configuredWorkingModel,
    modelEfforts: getModelEfforts(settings),
    globalEffort: getGlobalThinkingEffort(settings),
    profileEffort: effectiveThinkingProfile?.reasoningEffort,
    skillEfforts: skillEffortRecommendations,
    defaultEffort: 'high',
  });
  // Direct role clients — declared here (hoisted) so the routerContext assignment
  // and catch block can access them. Built inside the try block after activeProfile
  // and councilConfig are resolved.
  let directExecutionClient: ModelClient | undefined;
  let directPlanningClient: ModelClient | undefined;

  // Agent silence watchdog interval ref for cleanup in catch block
  let watchdogInterval: ReturnType<typeof setInterval> | undefined;

  // mcpMode needs to be declared outside try block so it's accessible in catch for error reporting
  let mcpMode: string | undefined;
  // messageCount needs to be declared outside try block so it's accessible in catch for safe retry logic
  let messageCount = 0;
  let receivedResultMessage = false;
  let extendedContextEnabled = false;
  // Watchdog tracker — owns silence thresholds, level progression, tool/subagent tracking,
  // and phase inference. Orchestration (Sentry, UI dispatch, abort) stays in the executor.
  const watchdog = new WatchdogTracker();
  let abortedByWatchdog = false; // Track watchdog auto-abort distinctly from user abort
  // Stage 1a (260617_bricked-state-0448-electron42): set when the EARLIER,
  // interactive-gated `awaiting_api` hard-stall ceiling trips (request sent, no
  // first token). The post-loop terminal uses this to dispatch a recognised
  // retryable `message_timeout` terminal (errorKindOverride) so the renderer
  // surfaces the existing "Try again" affordance, instead of the generic
  // watchdog auto-abort copy. Distinct from the 10-min streaming ceiling and the
  // automation 90-min hard cap, both of which keep their existing behaviour.
  let abortedByAwaitingApiStall = false;
  // Stage 1b (260617_bricked-state-0448-electron42): one-shot latch for the SOFT,
  // non-destructive "still waiting" affordance. Set when the soft awaiting_api
  // threshold (`AWAITING_API_SOFT_STALL_MS`, ~30s) first trips so we dispatch the
  // `status.stall` event exactly once per stall episode; reset on activity-resume
  // (the `watchdog.onMessage` levelWasReset path) so a turn that resumes and stalls
  // again can re-surface. Does NOT end the turn — the spinner keeps running.
  let awaitingApiSoftStallDispatched = false;
  let watchdogAbortReason: WatchdogAutomationAbortReason = 'watchdog';
  let watchdogAutoAbortMs = 0; // The auto-abort threshold that was used (for diagnostics)
  let watchdogAbortIsAutomationHardCap = false; // Distinguishes the automation 90-min cap from other watchdog/judge kills (used by user-facing copy)
  let watchdogAbortElapsedSinceTurnStartMs = 0; // Real elapsed time at abort, used for "silent for over N minutes" copy
  let judgeInFlight = false;
  let priorExtensionCount = 0;
  let consecutiveFailOpenCount = 0;
  let extensionBoundToolUseId: string | undefined;
  let extensionBoundToolName: string | undefined;
  let extensionBoundHasActiveSubagent = false;
  // Set to true when the turn enters cleanup (success or error). Prevents an
  // in-flight watchdog judge promise from applying state changes after the
  // turn already completed.
  let turnCompleted = false;
  const completedToolsThisTurn: CompletedToolSummary[] = [];
  const toolCallStateByUseId = new Map<string, { name: string; startedAt: number; input: unknown }>();
  const activeChildACByToolUseId = new Map<string, AbortController>();
  const toolCancelGraceTimerByToolUseId = new Map<string, ReturnType<typeof setTimeout>>();
  const hasRuntimeToolInFlight = (): boolean =>
    watchdog.toolInFlightSince !== undefined || activeChildACByToolUseId.size > 0;
  // Per-turn cap counter keyed by tool name (or tool-use id when name is
  // unavailable). Shared between watchdog tool-level cancels and subagent
  // internal timeouts (per A15 in
  // `docs/plans/260508_tool_level_timeout_and_judge_tuning.md`): both
  // increment the same counter, and `MAX_PER_TOOL_WATCHDOG_CANCELS` covers
  // both surfaces.
  const toolWatchdogCancelCountByName = new Map<string, number>();
  let abortByWatchdogForToolCancel: ((reason: WatchdogAutomationAbortReason, autoAbortMs: number) => void) | undefined;
  let requestedModelForTurn = turnOptions?.modelOverride ?? configuredWorkingModel;
  
  // Get progressive watchdog message based on level and phase (Rebel voice)
  // Copy matches Rebel's dry, witty persona - confident but not robotic
  // `effectiveAbortMs` is the phase-aware ceiling (e.g., 10min streaming-stall vs
  // 30min tool-in-flight); the level-6 message renders the actual minute count.
  const getWatchdogMessage = (level: number, phase: string, _elapsedSeconds: number, effectiveAbortMs?: number): string => {
    // Phase-specific context for level 1 (first trigger)
    const getPhaseContext = (): string => {
      switch (phase) {
        case 'awaiting_tool': return 'Tool is running. Standing by for results.';
        case 'awaiting_api': return 'Awaiting response from the model.';
        case 'streaming': return 'Response in progress, waiting for more.';
        default: return 'Deep thought in progress. Give it a moment.';
      }
    };
    
    // Progressive messages with Rebel's dry wit
    switch (level) {
      case 1: // 30s - reassure, explain what's happening
        return getPhaseContext();
      case 2: // 1min
        return 'The model is taking its time. Some inquiries require deliberation.';
      case 3: // 2min
        return 'Extended silence from the API. You can stop and retry if patience has its limits.';
      case 4: // 5min
        return 'Five minutes of radio silence. If this is a complex request, it may need more time — otherwise, stopping and retrying might help.';
      case 5: // 10min
        return 'Ten minutes without a word. This likely warrants your attention.';
      case 6: // safety-net auto-abort — derive minute count from the actual phase-effective ceiling
        return formatWatchdogAutoAbortMessage(effectiveAbortMs);
      default:
        return 'Still working on this...';
    }
  };
  
  const getOldestActiveTool = (): { toolUseId: string; name: string; input: unknown } | undefined => {
    let oldestToolUseId: string | undefined;
    let oldestStartedAt = Number.POSITIVE_INFINITY;
    for (const [toolUseId, state] of toolCallStateByUseId.entries()) {
      if (state.startedAt < oldestStartedAt) {
        oldestStartedAt = state.startedAt;
        oldestToolUseId = toolUseId;
      }
    }
    if (!oldestToolUseId) {
      const fallbackToolUseId = activeChildACByToolUseId.keys().next().value;
      if (typeof fallbackToolUseId !== 'string') return undefined;
      return {
        toolUseId: fallbackToolUseId,
        name: watchdog.lastToolName ?? 'tool',
        input: undefined,
      };
    }
    const state = toolCallStateByUseId.get(oldestToolUseId);
    if (!state) return undefined;
    return {
      toolUseId: oldestToolUseId,
      name: state.name,
      input: state.input,
    };
  };

  const clearToolCancelGraceTimer = (toolUseId: string): void => {
    const timer = toolCancelGraceTimerByToolUseId.get(toolUseId);
    if (timer) {
      clearTimeout(timer);
      toolCancelGraceTimerByToolUseId.delete(toolUseId);
    }
  };

  const cancelActiveToolForWatchdog = (args: {
    toolUseId: string;
    toolName: string | undefined;
    judgeReason: string;
    silentMs: number;
    elapsedMs: number;
    effectiveAbortMs: number;
    injectionSuspected?: InjectionSuspicionLevel;
  }): 'cancelled' | 'cap' | 'missing' => {
    const controller = activeChildACByToolUseId.get(args.toolUseId);
    if (!controller || controller.signal.aborted) {
      return 'missing';
    }

    const cancelCountKey = args.toolName ?? args.toolUseId;
    const cancelOutcome = recordToolWatchdogCancel(toolWatchdogCancelCountByName, cancelCountKey);
    if (cancelOutcome.kind === 'cap') {
      return 'cap';
    }

    const nowForCancel = Date.now();
    const priorExtensionCountAtCancel = priorExtensionCount;
    const error = new ToolKilledByWatchdogError({
      cancelledAtMs: Math.max(0, nowForCancel - turnStartedAt),
      judgeReason: args.judgeReason,
      priorExtensionCount: priorExtensionCountAtCancel,
    });
    controller.abort(error);

    watchdog.markToolCancelledForWatchdog(args.toolUseId, nowForCancel);
    extensionBoundToolUseId = undefined;
    extensionBoundToolName = undefined;
    extensionBoundHasActiveSubagent = false;
    priorExtensionCount = 0;
    extendedCeilingMs = undefined;

    appendDiagnosticEvent({
      kind: 'watchdog_judge_decision',
      data: {
        decision: 'tool_cancelled',
        priorExtensionCount: priorExtensionCountAtCancel,
        elapsedMs: args.elapsedMs,
        silentMs: args.silentMs,
        ...(args.injectionSuspected && args.injectionSuspected !== 'none'
          ? { injectionSuspected: args.injectionSuspected }
          : {}),
        ...(args.toolName ? { toolName: args.toolName } : {}),
      },
    });

    dispatchAgentEvent(win, turnId, {
      type: 'status',
      message: 'Stopped that tool — continuing with your request.',
      timestamp: nowForCancel,
    });

    clearToolCancelGraceTimer(args.toolUseId);
    const timer = setTimeout(() => {
      if (!activeChildACByToolUseId.has(args.toolUseId)) {
        toolCancelGraceTimerByToolUseId.delete(args.toolUseId);
        return;
      }
      turnLogger.error(
        {
          toolUseId: args.toolUseId,
          toolName: args.toolName,
          graceMs: TOOL_CANCEL_GRACE_MS,
        },
        'Watchdog-cancelled tool did not settle within grace window',
      );
      if (abortByWatchdogForToolCancel) {
        abortByWatchdogForToolCancel('tool_cancel_unresponsive', args.effectiveAbortMs);
      } else {
        turnLogger.error(
          {
            toolUseId: args.toolUseId,
            toolName: args.toolName,
          },
          'Watchdog tool-cancel fallback fired before abort helper was ready',
        );
        abortedByWatchdog = true;
        watchdogAbortReason = 'tool_cancel_unresponsive';
        watchdogAutoAbortMs = args.effectiveAbortMs;
        watchdogAbortElapsedSinceTurnStartMs = Math.max(0, Date.now() - turnStartedAt);
        abortController.abort();
      }
      toolCancelGraceTimerByToolUseId.delete(args.toolUseId);
    }, TOOL_CANCEL_GRACE_MS);
    toolCancelGraceTimerByToolUseId.set(args.toolUseId, timer);

    return 'cancelled';
  };

  // A15: per-tool-name cap shared with watchdog cancels. When a subagent's
  // internal timeout fires (`AgentToolTimeoutError`) and the agent loop has
  // already converted it into a synthetic `tool_result { is_error: true }`,
  // this handler increments the same counter `cancelActiveToolForWatchdog`
  // uses, emits a status event with the chief-designer-settled copy, and
  // emits a `subagent_internal_timeout_recovered` diagnostic. On cap, falls
  // back to a turn-level abort with `tool_repeated_timeout`.
  const handleSubagentInternalTimeout = (args: {
    toolUseId: string;
    toolName: string;
    startedAt: number | undefined;
    messageNow: number;
  }): void => {
    const cancelCountKey = args.toolName;
    const priorTimeoutCount = toolWatchdogCancelCountByName.get(cancelCountKey) ?? 0;
    const cancelOutcome = recordToolWatchdogCancel(toolWatchdogCancelCountByName, cancelCountKey);

    const elapsedMs = args.startedAt !== undefined
      ? Math.max(0, args.messageNow - args.startedAt)
      : Math.max(0, args.messageNow - turnStartedAt);

    if (cancelOutcome.kind === 'cap') {
      const fallbackAbortMs = watchdogAutoAbortMs > 0 ? watchdogAutoAbortMs : AUTO_ABORT_MS;
      turnLogger.warn(
        {
          toolUseId: args.toolUseId,
          toolName: args.toolName,
          priorTimeoutCount,
        },
        'Subagent timeout cap reached — aborting turn',
      );
      if (abortByWatchdogForToolCancel) {
        abortByWatchdogForToolCancel('tool_repeated_timeout', fallbackAbortMs);
      } else {
        abortedByWatchdog = true;
        watchdogAbortReason = 'tool_repeated_timeout';
        watchdogAutoAbortMs = fallbackAbortMs;
        watchdogAbortElapsedSinceTurnStartMs = Math.max(0, args.messageNow - turnStartedAt);
        abortController.abort();
      }
      return;
    }

    const displayName = formatSubagentDisplayName(args.toolName);
    const statusText = displayName
      ? `${displayName} ran out of time — continuing with your request.`
      : 'A subagent ran out of time — continuing with your request.';
    dispatchAgentEvent(win, turnId, {
      type: 'status',
      message: statusText,
      timestamp: args.messageNow,
    });

    appendDiagnosticEvent({
      kind: 'subagent_internal_timeout_recovered',
      data: {
        toolUseId: args.toolUseId,
        ...(args.toolName && args.toolName !== 'tool' ? { agentName: args.toolName } : {}),
        elapsedMs,
        priorTimeoutCount,
      },
    });
  };

  let routerContext: QueryRouterContext | undefined;
  let queryOptionsCtx!: QueryOptionsContext;
  let providerRoutePlan!: ProviderRoutePlan;

  // Raw Anthropic stream activity tracker — updated on every SSE event (including thinking_delta).
  // Used by getLastActivityAgeMs() which feeds BOTH the timeoutAsyncIterator (Layer 1) and
  // the watchdog (Layer 2) to prevent false stalls during extended thinking.
  // Also provides diagnostic context in logs and error reports.
  // `lastActivity` carries the typed RuntimeActivityEvent that drives the level-1
  // watchdog Sentry-capture gate via `shouldSuppressLevel1WatchdogCapture`.
  // `lastEventType` mirrors `serializeRuntimeActivityForTelemetry(lastActivity)` so
  // Sentry extras and IPC schemas (`rawStreamLastEventType: string | null`) keep
  // their existing shape unchanged.
  const rawStreamTracker: RawStreamTrackerState = {
    lastActivity: null,
    lastEventType: null,
    lastTimestamp: null,
    eventCount: 0,
    firstActivityTimestamp: null,
  };

  // Activity-aware timeout callback: uses both rawStreamTracker (direct Anthropic SSE)
  // and agentTurnRegistry upstream activity (proxy/Responses paths) to prevent false
  // MessageTimeoutError during extended thinking. See docs/plans/260409_activity_aware_streaming_timeout.md
  const getLastActivityAgeMs = (): number => {
    const now = Date.now();
    const rawTs = rawStreamTracker.lastTimestamp ?? 0;
    const registryTs = agentTurnRegistry.getUpstreamActivity(turnId) ?? 0;
    const lastActivity = Math.max(rawTs, registryTs);
    if (lastActivity === 0) return Infinity;
    return now - lastActivity;
  };
  // REBEL-1AF / 260506: Layer 1 (timeoutAsyncIterator) needs the same
  // tool-in-flight signal Layer 2 (watchdog) keys on, including runtime
  // dispatch when assistant-message tracking has not landed yet. Otherwise
  // long MCP tool calls trip MessageTimeoutError at 10 min even though
  // the watchdog would correctly wait 15 min for them.
  // See docs/plans/260506_layer1_layer2_tool_in_flight_alignment.md.
  // Named `getIsToolInFlight` to avoid shadowing the per-tick boolean
  // `isToolInFlight` computed inside the watchdog setInterval callback below.
  const getIsToolInFlight = (): boolean => hasRuntimeToolInFlight();
  base = { ...base, getLastActivityAgeMs, isToolInFlight: getIsToolInFlight };

  const syncTurnCompletionMutableBags = (): void => {
    trackingCounters.messageCount = messageCount;
    trackingCounters.receivedResultMessage = receivedResultMessage;
    trackingCounters.lastMessageType = watchdog.lastMessageType;
    trackingCounters.lastToolName = watchdog.lastToolName;
    trackingCounters.mcpMode = mcpMode;
    trackingCounters.hasMedia = hasMedia;

    watchdogDiagnostics.abortedByWatchdog = abortedByWatchdog;
    watchdogDiagnostics.abortedByAwaitingApiStall = abortedByAwaitingApiStall;
    watchdogDiagnostics.watchdogFired = watchdog.fired;
    watchdogDiagnostics.watchdogFiredAt = watchdog.firedAt;
    watchdogDiagnostics.maxWatchdogLevel = watchdog.maxWatchdogLevel;
    watchdogDiagnostics.watchdogLevel = watchdog.watchdogLevel;
    watchdogDiagnostics.effectiveAbortMs = watchdogAutoAbortMs;
    watchdogDiagnostics.rawStreamEventCount = rawStreamTracker.eventCount;
    watchdogDiagnostics.rawStreamLastEventType = rawStreamTracker.lastEventType;
    watchdogDiagnostics.rawStreamLastEventAgeMs = rawStreamTracker.lastTimestamp !== null
      ? Date.now() - rawStreamTracker.lastTimestamp
      : null;
  };

  try {
    dispatchAgentEvent(win, turnId, {
      type: 'status',
      message: 'Starting agent turn...',
      timestamp: Date.now(),
    });
    if (textAttachmentPayload.length > 0) {
      dispatchAgentEvent(win, turnId, {
        type: 'status',
        message: `Attached ${textAttachmentPayload.length} workspace file${textAttachmentPayload.length === 1 ? '' : 's'}.`,
        timestamp: Date.now(),
      });
    }
    if (imageAttachmentPayload.length > 0) {
      dispatchAgentEvent(win, turnId, {
        type: 'status',
        message: `Attached ${imageAttachmentPayload.length} image${imageAttachmentPayload.length === 1 ? '' : 's'}.`,
        timestamp: Date.now(),
      });
    }
    if (documentAttachmentPayload.length > 0) {
      dispatchAgentEvent(win, turnId, {
        type: 'status',
        message: `Attached ${documentAttachmentPayload.length} document${documentAttachmentPayload.length === 1 ? '' : 's'}.`,
        timestamp: Date.now(),
      });
    }
    if (officeAttachmentPayload.length > 0) {
      const wordCount = officeAttachmentPayload.filter((a) => a.officeType === 'word').length;
      const excelCount = officeAttachmentPayload.filter((a) => a.officeType === 'excel').length;
      const pptxCount = officeAttachmentPayload.filter((a) => a.officeType === 'powerpoint').length;
      const rtfCount = officeAttachmentPayload.filter((a) => a.officeType === 'rtf').length;
      const parts: string[] = [];
      if (wordCount > 0) parts.push(`${wordCount} Word`);
      if (excelCount > 0) parts.push(`${excelCount} Excel`);
      if (pptxCount > 0) parts.push(`${pptxCount} PowerPoint`);
      if (rtfCount > 0) parts.push(`${rtfCount} RTF`);
      dispatchAgentEvent(win, turnId, {
        type: 'status',
        message: `Extracted text from ${parts.join(' and ')} document${officeAttachmentPayload.length === 1 ? '' : 's'}.`,
        timestamp: Date.now(),
      });
    }
    if (extractedPdfAttachmentPayload.length > 0) {
      dispatchAgentEvent(win, turnId, {
        type: 'status',
        message: `Extracted text from ${extractedPdfAttachmentPayload.length} large PDF${extractedPdfAttachmentPayload.length === 1 ? '' : 's'} (images not included).`,
        timestamp: Date.now(),
      });
    }
    if (textFileAttachmentPayload.length > 0) {
      dispatchAgentEvent(win, turnId, {
        type: 'status',
        message: `Attached ${textFileAttachmentPayload.length} text file${textFileAttachmentPayload.length === 1 ? '' : 's'}.`,
        timestamp: Date.now(),
      });
    }
    turnLogger.info('Starting agent turn');

    const augmentedPath = await setupNodeEnvironment();
    // Stale-turn guard (rework-final sweep completeness): bail if the deadline
    // fired while setupNodeEnvironment was pending, before any downstream work.
    if (bailIfPreDispatchStale('setupNodeEnvironment')) return;

    // Build system prompt with session mode context
    const pluginContexts = getPluginPreTurnContexts();
    const mcpAppContexts = rendererSessionId
      ? mcpAppModelContextStore.getContextsForConversation(rendererSessionId)
      : [];
    const promptOptions: ResolveSystemPromptOptions = {
      sessionType: turnOptions?.sessionType,
      promptSessionMode: effectivePolicy.promptSessionMode,
      privacyMode: turnOptions?.privateMode,
      voiceActive: turnOptions?.voiceActive,
      sessionId: rendererSessionId ?? undefined,
      activeSpacePath: turnOptions?.activeSpacePath ?? null,
      ...(finishLine ? { finishLine } : {}),
      ...(pluginContexts.length > 0 ? { pluginContexts } : {}),
      ...(mcpAppContexts.length > 0 ? { mcpAppContexts } : {}),
      ...(turnOptions?.systemPromptPrefix ? { systemPromptPrefix: turnOptions.systemPromptPrefix } : {}),
      // 260622 Stage 3 (F2): on a DESKTOP turn the admission gate already read the
      // Chief-of-Staff body via the single killable bounder; thread it here so
      // resolveSystemPrompt does NOT re-read (kills the double-read / TOCTOU window).
      ...(admittedTurn.prefetchedChiefOfStaffContent !== undefined
        ? { prefetchedChiefOfStaffContent: admittedTurn.prefetchedChiefOfStaffContent }
        : {}),
    };

    // Resolve MCP servers with graceful degradation for Super-MCP not running.
    // Returns a result object on success or graceful degradation, re-throws other errors.
    const safeMcpResolve = async (): Promise<{
      servers: Record<string, unknown> | undefined;
      mode: string;
      upstreamCount: number | undefined;
      configPath: string | undefined;
    }> => {
      // Wrap MCP resolution in try/catch to handle Super-MCP startup failures gracefully
      // (Stage 2 of robust startup: don't block agent turns when tools aren't ready)
      try {
        const mcpResult = await resolveMcpServers(settings);
        return {
          servers: mcpResult.servers,
          mode: mcpResult.mode,
          upstreamCount: mcpResult.upstreamCount,
          configPath: mcpResult.configPath,
        };
      } catch (mcpError: unknown) {
        // Check if this is a "Super-MCP not running" error
        const errorMessage = getErrorMessage(mcpError);
        const isSuperMcpNotRunning = errorMessage.includes('Super-MCP') && 
          (errorMessage.includes('not running') || errorMessage.includes('is not running'));
        
        if (isSuperMcpNotRunning) {
          // Graceful degradation: proceed without tools
          turnLogger.warn(
            { err: mcpError },
            'Super-MCP not running - proceeding without tools for this turn'
          );
          
          // Inform the user that tools are unavailable for this turn
          // (Message is neutral - could be due to startup delay, Safe Mode, or other issues).
          // Stale-turn guard (rework2-F1): resolveMcpServers can wedge on a dead
          // mount; if the pre-dispatch deadline fired while parked here, suppress
          // this stale status dispatch (the guard already terminalized the turn).
          if (!preDispatchGuardFired) {
            dispatchAgentEvent(win, turnId, {
              type: 'status',
              message: 'Tools are temporarily unavailable. Running without tools for this message.',
              timestamp: Date.now(),
            });
          }
          return { servers: undefined, mode: 'unavailable', upstreamCount: undefined, configPath: undefined };
        }
        // Re-throw non-Super-MCP errors (e.g., config file issues)
        throw mcpError;
      }
    };

    // Run system prompt and MCP server resolution in parallel.
    // These operations are independent and parallelizing them reduces turn startup latency.
    const preTurnResolveStart = Date.now();
    let systemPromptMs = 0;
    let mcpResolveMs = 0;
    const [systemPrompt, mcpResolveResult] = await Promise.all([
      (async () => { const s = Date.now(); const r = await resolveSystemPrompt(settings, promptOptions); systemPromptMs = Date.now() - s; return r; })(),
      (async () => { const s = Date.now(); const r = await safeMcpResolve(); mcpResolveMs = Date.now() - s; return r; })(),
    ]);
    turnLogger.info(
      {
        preTurnResolveMs: Date.now() - preTurnResolveStart,
        systemPromptMs,
        mcpResolveMs,

      },
      'Pre-turn resolution timing (systemPrompt + MCP)'
    );

    // ABORT CHECKPOINT 3: After system prompt + MCP resolution.
    // This is the single most impactful checkpoint — covers the biggest async delay.
    if (abortController.signal.aborted) {
      // Pre-dispatch guard's abort: terminal + cleanup already ran — bail silently (F4).
      if (bailIfPreDispatchStale('abort-checkpoint-3')) return;
      turnLogger.info('Turn aborted during setup (post-MCP-resolution)');
      dispatchAgentEvent(win, turnId, makeSyntheticResult(turnId, '', abortEndReason()));
      completeTurnCleanup(turnId, 'aborted', attemptEpoch);
      return;
    }

    let mcpServers = mcpResolveResult.servers;
    mcpMode = mcpResolveResult.mode;
    const upstreamServerCount = mcpResolveResult.upstreamCount ?? 0;
    const resolvedMcpConfigPath = mcpResolveResult.configPath;

    // Direct MCP mode can generate extremely long tool names once the runtime namespaces
    // tools with the server ID, triggering Anthropic's 200-char tool name limit.
    // To keep direct-mode usable for diagnostics, alias long server IDs before
    // passing them into the runtime.
    if (mcpMode === 'direct' && mcpServers && Object.keys(mcpServers).length > 0) {
      const aliased = aliasMcpServersForClaudeSdk(
        mcpServers as Parameters<typeof aliasMcpServersForClaudeSdk>[0],
      );
      if (Object.keys(aliased.aliasMap).length > 0) {
        turnLogger.warn(
          {
            aliasedCount: Object.keys(aliased.aliasMap).length,
            aliasedIds: Object.values(aliased.aliasMap),
          },
          'Aliased long MCP server IDs for direct mode (tool name length guard)'
        );
      }
      mcpServers = aliased.servers;
    }

    // Log MCP configuration for sub-agent troubleshooting
    const mcpServerNames = mcpServers ? Object.keys(mcpServers) : [];
    // Build full MCP server specs for subagent inheritance.
    // String references (["server-name"]) are NOT resolved by the runtime —
    // we must pass full config objects so subagents get actual MCP tool access.
    const agentMcpSpecs: AgentDefinition['mcpServers'] =
      mcpServers && Object.keys(mcpServers).length > 0
        ? ([mcpServers] as AgentDefinition['mcpServers'])
        : undefined;
    const mcpServerDetails = mcpServers
      ? Object.entries(mcpServers).map(([name, config]) => ({
          name,
          type: (config as Record<string, unknown>).type ?? 'stdio',
          hasUrl: !!(config as Record<string, unknown>).url,
          hasCommand: !!(config as Record<string, unknown>).command,
        }))
      : [];
    turnLogger.info(
      {
        mcpMode,
        mcpServerCount: mcpServerNames.length,
        mcpServerNames,
        mcpServerDetails,
        upstreamServerCount,
        resolvedMcpConfigPath,
      },
      'MCP configuration resolved for agent runtime (this config should be inherited by sub-agents)'
    );
    const effectivePath = augmentedPath;

    const coreDirectory = settings.coreDirectory;
    try {
      const coreDirStat = await fs.stat(coreDirectory);
      if (!coreDirStat.isDirectory()) {
        throw new Error('Core directory is not a directory');
      }
    } catch (error) {
      const invalidCoreDirectoryCopy = `Core directory does not exist or is not accessible: ${coreDirectory}`;
      turnLogger.warn({ err: error, coreDirectory }, 'Core directory is not accessible');
      // errorKindOverride: 'unknown' prevents deriveErrorKind from drifting to
      // auth/billing/rate_limit if the user-chosen `coreDirectory` path
      // happens to contain substrings like '429', 'monthly limit', or 'api key'
      // (low-probability but possible). Without the override, a drifted 'billing'
      // classification would silently auto-mark the turn actionable-error-dispatched.
      // Stale-turn guard (F4): a wedged fs.stat does NOT throw — it hangs — so a
      // late rejection/resolution here may land AFTER the pre-dispatch deadline
      // already terminated the turn. Don't emit a second (misleading) error.
      if (bailIfPreDispatchStale('fs.stat-coreDirectory-catch')) return;
      dispatchAgentErrorEvent(win, turnId, new Error(invalidCoreDirectoryCopy), {
        humanizedOverride: invalidCoreDirectoryCopy,
        errorKindOverride: 'unknown',
      });
      completeTurnCleanup(turnId, 'invalid-core-directory', attemptEpoch);
      return;
    }
    // Stale-turn guard (F4): fs.stat(coreDirectory) is the canonical cloud-mount
    // wedge site (coreDirectory IS the dead Google Drive mount in the repro). If
    // the deadline fired while parked here, abandon the resumed continuation
    // before proceeding toward model dispatch.
    if (bailIfPreDispatchStale('fs.stat-coreDirectory')) return;

    // Use model override if provided, otherwise use settings
    const requestedModel =
      turnOptions?.modelOverride ??
      configuredWorkingModel;
    requestedModelForTurn = requestedModel;
    // thinkingModelOverride semantics:
    // - undefined → inherit from settings/profile (default)
    // - '' (empty string) → suppress thinking model (single-model mode)
    // - model string → use that specific thinking model
    const thinkingModelOverride = turnOptions?.thinkingModelOverride;
    const effectiveThinking = thinkingModelOverride !== undefined
      ? thinkingModelOverride
      : (effectiveThinkingProfile ? effectiveThinkingProfile.model : getThinkingModel(settings));
    // The typed plan-mode target is the SINGLE authority for "is plan mode on".
    // hasThinkingModel/planModeEnabled/extendedContextEnabled and resolveModelConfig
    // all derive from `planModeTarget !== null` — never a raw string compare — so a
    // synthetic Claude sentinel can no longer masquerade as a servable thinking model.
    const planModeTarget = resolvePlanModeTarget({
      workingModel: requestedModel,
      thinkingModelOverride,
      thinkingProfileModel: effectiveThinkingProfile?.model,
      settingsThinkingModel: getThinkingModel(settings),
    });
    // Always request maximum Claude context when available.
    // Runtime fallback paths still downgrade to 200K when the account/session cannot use 1M.
    const modelSupports1M = modelSupportsExtendedContext(requestedModel);
    const hasThinkingModel = planModeTarget !== null;
    extendedContextEnabled = modelSupports1M || hasThinkingModel;
    const planModeEnabled = hasThinkingModel;

    // Track extended context for this turn (used by agentMessageHandler for context window calculation)
    agentTurnRegistry.setTurnExtendedContext(turnId, extendedContextEnabled);

    // Store resolved context window (authoritative for UI — replaces the shadow
    // resolution in agentMessageHandler's resolveTurnContextWindow)
    const turnLimitsProfile = effectiveThinking ? effectiveThinkingProfile : effectiveWorkingProfile;
    const turnLimits = resolveModelLimits({
      model: effectiveThinking || requestedModel,
      extendedContext: extendedContextEnabled,
      profileMaxOutput: turnLimitsProfile?.maxOutputTokens,
      profileMaxOutputSource: turnLimitsProfile?.outputTokensSource,
      profileContextWindow: turnLimitsProfile?.contextWindow,
      profileContextWindowSource: turnLimitsProfile?.contextWindowSource,
      allProfiles: settings.localModel?.profiles ?? [],
    });
    agentTurnRegistry.setTurnContextWindow(turnId, turnLimits.contextWindow);

    // Tag per-turn settings for accurate tooltip and cost attribution. SKIP recording
    // when the profile that OWNS this effort suppresses reasoning (REBEL-5RJ): the wire
    // then carries no reasoning_effort, so recording the configured cascade value would
    // make the usage tooltip + diagnostics claim thinking that never happened. A missing
    // entry reads as "no thinking" downstream, which is correct. `effectiveThinkingEffort`
    // is derived from the thinking/planning profile when present (see the
    // resolveReasoningEffort call above), so gate on `effectiveThinkingProfile` and fall
    // back to the working profile — both already resolved (override-aware). Skip rather
    // than record `undefined` (the registry stores a bare ThinkingEffort).
    const effortOwningProfile = effectiveThinkingProfile ?? effectiveWorkingProfile;
    if (!(effortOwningProfile && shouldSuppressProfileReasoning(effortOwningProfile))) {
      agentTurnRegistry.setTurnThinkingEffort(turnId, effectiveThinkingEffort);
    }

    // Capture profile context for route diagnostics. Auth tagging happens after
    // resolveProviderRoutePlan(), where the actual transport is known.
    const profile = getWorkingModelProfile(settings);

    turnLogger.info({
      activeProvider: routeSettings.activeProvider ?? 'anthropic',
      workingProfileId: profile?.id,
      workingModel: profile?.model ?? diagnosticWorkingModel,
    }, 'Turn provider routing inputs');

    turnLogger.info({
      planModeEnabled,
      extendedContextEnabled,
      selectedModel: diagnosticWorkingModel,
      modelOverride: turnOptions?.modelOverride,
      requestedModel,
      // Codex diagnostics: trace exactly what plan mode / profile routing sees
      activeProvider: routeSettings.activeProvider,
      thinkingProfileId: getThinkingProfileId(settings) ?? null,
      thinkingModel: getThinkingModel(settings) ?? null,
      thinkingProfileResolved: effectiveThinkingProfile ? { id: effectiveThinkingProfile.id, model: effectiveThinkingProfile.model } : null,
      workingProfileResolved: effectiveWorkingProfile ? { id: effectiveWorkingProfile.id, model: effectiveWorkingProfile.model } : null,
    }, 'Model configuration inputs');
    // REBEL-655: Pass the REAL resolved thinking model to resolveModelConfig —
    // NEVER a synthetic Claude sentinel. Previously this substituted
    // PREFERRED_PLANNING_MODEL (claude-opus-4-8) whenever ANY thinking profile
    // existed, which leaked a Claude planning model for Codex/OpenRouter users
    // (working profile == thinking profile == codex-gpt-5.5) → Anthropic-direct
    // route → no key → misleading "Credentials need attention" toast.
    // Now: thinking == working → single-model mode (no plan mode, no leak);
    // a distinct thinking model names the real (proxy-backed) model so
    // rebelCoreQuery routes the planning client via the same provider/proxy.
    // The typed plan-mode target (resolved above) is the single source of truth.
    // It already names the REAL thinking model (never the Claude sentinel) and is
    // null when thinking == working (single-model mode).
    const effectiveThinkingModel = planModeTarget?.thinkingModel ?? null;
    // Codex diagnostic: trace planning model decision
    turnLogger.info({
      effectiveThinkingModel,
      thinkingModelOverride,
      hasThinkingProfile: !!effectiveThinkingProfile,
      wouldTriggerPlanMode: planModeTarget !== null,
    }, '[CODEX-DIAG] Planning model decision');
    modelConfig = resolveModelConfig(
      requestedModel,
      planModeTarget,
      extendedContextEnabled
    );
    agentTurnRegistry.setTurnModel(turnId, modelConfig.model);
    turnLogger.info({
      resolvedModel: modelConfig.model,
      resolvedThinkingModel: modelConfig.envOverrides?.[ENV_THINKING_MODEL],
      hasEnvOverrides: !!modelConfig.envOverrides,
      envOverrides: modelConfig.envOverrides,
    }, 'Model configuration resolved');

    // Session memory: skip 1M if it already failed in this conversation.
    // This intentionally suppresses the full fallback chain (including API key + 1M)
    // on subsequent turns — we prefer flat-rate Max at 200K over pay-per-use API at 1M.
    // See ARCHITECTURE_1M_CONTEXT_AND_AUTH_FALLBACK.md for the full trade-off rationale.
    if (extendedContextEnabled && rendererSessionId
      && agentTurnRegistry.hasExtendedContextFailed(rendererSessionId)) {
      turnLogger.info('1M context previously failed in this session — using 200K');
      extendedContextEnabled = false;
      modelConfig = stripExtendedContextFromConfig(modelConfig);
      agentTurnRegistry.setTurnExtendedContext(turnId, false);
      const fallbackLimits = resolveModelLimits({
        model: modelConfig.model,
        extendedContext: false,
        allProfiles: settings.localModel?.profiles ?? [],
      });
      agentTurnRegistry.setTurnContextWindow(turnId, fallbackLimits.contextWindow);
      agentTurnRegistry.addTurnFallback(turnId, {
        type: 'context', from: '1M', to: '200K', reason: 'session-memory',
      });
    }
    // Note: The context-1m beta header is no longer manually set here.
    // For Opus 4.8 / 4.7 / Sonnet 4.6: 1M context is GA (March 2026) — no header needed.
    // For older models with [1m] suffix: model normalization handles compatibility.

    // Tool safety configuration
    // Background tasks (memory updates, automations) can bypass tool safety if they have their own safety gate
    const bypassToolSafety = turnOptions?.bypassToolSafety ?? false;
    const globalToolSafetyLevel = settings.toolSafetyLevel ?? 'balanced';
    // Private mode forces 'cautious' safety level (always ask before taking actions)
    const effectiveToolSafetyLevel = turnOptions?.privateMode
      ? 'cautious'
      : globalToolSafetyLevel;
    const userSafetyInstructions = settings.userSafetyInstructions;
    const trustedTools = settings.trustedTools;
    const safetyModel = resolveBtsModel(settings, 'safety');
    const hasAuth = hasValidAuth(settings);
    // A4: this snapshot field is the *requested* safety model ref (a `profile:`
    // alias or concrete id from settings), NOT the model/transport actually
    // dispatched — the resolved-model+transport is now logged at dispatch time
    // in btsSafetyEvalService. Relabel to stop the misleading triage read.
    turnLogger.info({ globalToolSafetyLevel, effectiveToolSafetyLevel, privateMode: turnOptions?.privateMode, hasAuth, userSafetyInstructions: !!userSafetyInstructions, trustedToolsCount: trustedTools?.length ?? 0, requestedSafetyModelRef: safetyModel, bypassToolSafety }, 'Tool safety config');
    // Use promptWithoutUnleashed so //unleashed keyword doesn't leak into tool safety evaluation
    const toolSafetyHook = hasAuth && effectiveToolSafetyLevel && !bypassToolSafety
      ? createToolSafetyHook(
          promptWithoutOurComponentsOrUnleashed,
          settings,
          effectiveToolSafetyLevel,
          userSafetyInstructions,
          trustedTools,
          turnLogger,
          win as Electron.BrowserWindow | null,
          turnId,
          rendererSessionId ?? undefined,
          settings.systemSkills,
          safetyModel,
          turnOptions?.privateMode,
          {
            getSessionIntent: (sid) => buildSessionIntent(sid ?? rendererSessionId ?? undefined),
            // Cost-escalation gate must resolve `profile:<id>` refs against
            // the LIVE store — the same `getSettings()` the settings bridge
            // validates/writes against — not this turn's snapshot, or a
            // same-turn profile edit onto a premium model slips past the
            // gate (GPT stage-13 review F2 race).
            getLiveSettings: () => getSettings(),
          },
        )
      : undefined;
    turnLogger.info({ hookCreated: !!toolSafetyHook, bypassToolSafety }, 'Tool safety hook status');

    // Inbound trigger safety hook (adapter-provided, opaque to the executor).
    // Each adapter can provide its own safety hook (e.g., Slack checks for PII
    // in public channel replies, HubSpot might gate CRM writes).
    const inboundSafetyHook = turnOptions?.inboundSafetyHook ?? null;

    // MCP deny hook (blocks MCP tool calls during memory-update turns for cache alignment)
    const mcpDenyHook = turnOptions?.mcpDenyHook ?? null;

    // Space permission hook (blocks writes to read-only cloud spaces)
    const spacePermissionHook = coreDirectory
      ? createSpacePermissionHook({
          getWritableForPath: (filePath: string) =>
            getWritableForSpacePath(filePath, settings.spaces ?? [], coreDirectory),
        })
      : undefined;

    // Memory write hook
    // - Background memory turns pass their own hook via turnOptions.memoryWriteHook
    // - Main conversation turns create one here (when not bypassing tool safety)
    // Memory safety now uses 3-tier resolution from settings (private/shared defaults + overrides)
    let memoryWriteHook = turnOptions?.memoryWriteHook;
    if (!memoryWriteHook && !bypassToolSafety && coreDirectory) {
      // Create memory write hook for main conversation turns
      // sessionId: turnId for session-scoped approvals (interactive)
      //   or rendererSessionId for automation turns (so access rules detection works)
      // originalSessionId: rendererSessionId for tracking in "What Rebel Knows"
      const rendererSessionKind = rendererSessionId ? classifySessionKind(rendererSessionId) : null;
      const isAutomationSession = rendererSessionKind === 'automation' || rendererSessionKind === 'automation-insight';
      const memoryHookSessionId = isAutomationSession && rendererSessionId ? rendererSessionId : turnId;
      memoryWriteHook = createMemoryWriteHook({
        turnId,
        sessionId: memoryHookSessionId,
        originalTurnId: turnId,
        originalSessionId: rendererSessionId ?? turnId,
        coreDirectory,
        privateMode: turnOptions?.privateMode,
        // Stage 2 (260529_memory_write_intent_context_parity.md) — give the
        // memory-write evaluator the same authorising intent context the
        // tool-safety hook already receives. Single shared-core wiring point
        // covers desktop + cloud main turns. Background memory-update hooks
        // are intentionally not wired (system-initiated, no user request).
        userMessage: promptWithoutOurComponentsOrUnleashed,
        getSessionIntent: (sid) => buildSessionIntent(sid ?? rendererSessionId ?? undefined),
      });
    }
    turnLogger.info({ 
      hasMemoryWriteHook: !!memoryWriteHook,
      memoryWriteHookSource: turnOptions?.memoryWriteHook ? 'passed' : (memoryWriteHook ? 'created' : 'none'),
      privateMode: turnOptions?.privateMode,
    }, 'Memory write hook status');

    // Checkpoint integrity hook (PostToolUse, Layer 3)
    // Verifies checkpoint-locked shared skill files were not modified by any tool
    const checkpointIntegrityHook = memoryWriteHook && coreDirectory
      ? createCheckpointIntegrityHook(turnId, coreDirectory)
      : undefined;

    // File-conversation tracking hook (PostToolUse)
    // Tracks which files are written by which conversations for smart annotation routing
    const fileConversationTrackingHook = rendererSessionId && coreDirectory
      ? createFileConversationTrackingHook({
          sessionId: rendererSessionId,
          sessionTitle: rendererSessionId, // Will be updated with actual title when available
          coreDirectory,
        })
      : undefined;
    // MCP build auto-detect hook (PostToolUse)
    // Intercepts rebel_mcp_add_server to auto-create contribution records for MCPBuildCard
    const mcpBuildAutoDetectHook = rendererSessionId
      ? createMcpBuildAutoDetectHook({ sessionId: rendererSessionId })
      : undefined;
    const _skillWriteTrackingHook = coreDirectory
      ? createSkillWriteTrackingHook({ coreDirectory })
      : undefined;
    
    const _canUseTool = win ? createCanUseTool(win as Electron.BrowserWindow, turnId) : undefined;
    
    // Auto-continue hook (Stop hook)
    // Detects rhetorical questions ("Should I continue?") and incomplete skill execution
    // Only runs in agent mode - chat mode doesn't support hooks
    // unleashedMode: when //unleashed keyword is present, use looser stopping criteria
    // Use promptWithoutUnleashed (not effectivePrompt) so LLM evaluation sees the actual user request,
    // not the semantic context that gets prepended to effectivePrompt
    const autoContinueHook = hasAuth && !bypassToolSafety
      ? createAutoContinueHook(turnId, promptWithoutOurComponentsOrUnleashed, settings, unleashedMode, finishLine, abortController.signal)
      : undefined;
    turnLogger.info(
      // Conditionally include `finishLine` only when set so existing replay
      // corpus byte-equivalence on the "Auto-continue hook status" log row
      // stays intact for sessions that don't use the feature.
      finishLine !== undefined
        ? { hasAutoContinueHook: !!autoContinueHook, unleashedMode, finishLine: true }
        : { hasAutoContinueHook: !!autoContinueHook, unleashedMode },
      'Auto-continue hook status',
    );

    // Approval-execution guard (Stop hook) — deterministic check that a
    // legacy-approved (non-staged) tool call / memory write actually executed
    // during the continuation turn; forces exactly one stronger follow-up
    // continuation when not, then surfaces "approved but not executed".
    // See src/main/services/safety/approvalExecutionGuardHook.ts (FOX-2771 Stage 2).
    const approvalExecutionGuardHook = rendererSessionId && !bypassToolSafety
      ? createApprovalExecutionGuardHook({
          sessionId: rendererSessionId,
          approvalSeqAtTurnStart,
          abortSignal: abortController.signal,
          // Mirror autoContinueHook's user-question suppression: never force a
          // continuation past a stop that is waiting for user input (review F2).
          isAwaitingUserInput: () => agentTurnRegistry.hasUserQuestionPending(turnId),
          onApprovedNotExecuted: (items) => {
            dispatchAgentEvent(win, turnId, {
              type: 'status',
              message: buildApprovedNotExecutedStatus(items),
              timestamp: Date.now(),
            });
          },
        })
      : undefined;
    // Surrender predicate for the task-board continuation layer (review F1 +
    // confirm-round F1): rebelCoreQuery's deterministic task-board injection
    // runs BEFORE all Stop hooks, so it must yield while the guard still has
    // work to do — the forced continuation AND the follow-up surfacing pass —
    // otherwise the generic task-board continuation preempts them.
    const hasPendingApprovalExecutions = approvalExecutionGuardHook && rendererSessionId
      ? () => hasActionableExecutionExpectations(rendererSessionId, approvalSeqAtTurnStart)
      : undefined;
    
    // Helper to build query options (used for initial request and potential retry)
    // When using alternative model proxy, use the profile's model name for display
    activeProfile = resolveActiveProfileForTurn(effectiveWorkingProfile, settings, turnOptions);

    // Fail-fast: abort before API call if the active profile is known chat-incompatible
    if (activeProfile?.chatCompatibility === 'incompatible') {
      const profileIncompatibleCopy = `Your model "${activeProfile.name}" doesn't support chat conversations. Go to Settings → Your Models to choose a different model or retest.`;
      turnLogger.warn({ profileId: activeProfile.id, profileName: activeProfile.name }, 'Profile is chat-incompatible — aborting turn');
      // errorKindOverride: 'unknown' prevents deriveErrorKind from drifting to
      // auth/billing/rate_limit if the user-chosen profile name contains
      // substrings like 'monthly limit', '429', 'api key', etc. Power users
      // commonly name profiles after provider errors or models under test.
      dispatchAgentErrorEvent(win, turnId, new Error(profileIncompatibleCopy), {
        humanizedOverride: profileIncompatibleCopy,
        errorKindOverride: 'unknown',
      });
      dispatchAgentEvent(win, turnId, makeSyntheticResult(turnId, '', 'error'));
      completeTurnCleanup(turnId, 'profile-incompatible', attemptEpoch);
      return;
    }

    // Council mode: build council config and start multi-route proxy
    // Council agents use direct model names (no env var alias hijacking), so no
    // conflict with plan mode. The lead agent uses a full model name — normally
    // Claude, but a non-Claude model for non-Anthropic providers / a non-Claude
    // thinking profile (REBEL-655). See CouncilConfig.leadModel.
    councilConfig = null;
    let councilProxyUrl: string | null = null;
    if (councilModeEnabled) {
      const councilCandidates = getCouncilCandidateProfiles(settings);
      let managedAllowListState: ManagedAllowListState = { kind: 'unavailable' };
      if (routeSettings.activeProvider === 'mindstone') {
        try {
          // Use the registered auth boundary rather than a desktop-only dynamic import so missing-provider failures are logged, not silent.
          const authConfig = getRebelAuthProvider().getCachedAuthConfig();
          if (authConfig === null) {
            // Common pre-init / cloud-sentinel / first-fetch-in-flight path. Amendment A1.1
            // (Phase 6 fix per Behavioral-Safety F1): make the null short-circuit observable
            // instead of silently treating council as 'unavailable'. Behaviour preserved.
            turnLogger.warn(
              {},
              'Auth config unavailable for council managed allow-list (provider uninitialized, cloud sentinel, or first fetch in-flight). Treating as unavailable.',
            );
          }
          managedAllowListState = getManagedAllowListState(authConfig?.managedProvider);
        } catch (err) {
          turnLogger.warn(
            { err },
            'Failed to resolve managed allow-list state for council eligibility. Treating as unavailable.',
          );
          managedAllowListState = { kind: 'unavailable' };
        }
      }

      const eligibility = assessCouncilEligibility(
        councilCandidates,
        settings,
        managedAllowListState,
      );

      if (eligibility.kind === 'blocked') {
        dispatchAgentErrorEvent(win, turnId, new Error(COUNCIL_BLOCKED_AUTH_COPY), {
          errorKindOverride: 'auth',
          humanizedOverride: COUNCIL_BLOCKED_AUTH_COPY,
        });
        mainTracking.council.blocked({
          reason: eligibility.reason,
          hadAnthropicKey: eligibility.hadAnthropicKey,
          candidateCount: eligibility.candidateCount,
        });
        turnLogger.warn(
          {
            candidateCount: eligibility.candidateCount,
            hadAnthropicKey: eligibility.hadAnthropicKey,
          },
          'council.blocked',
        );
        completeTurnCleanup(turnId, 'council_blocked', attemptEpoch);
        return;
      }

      if (eligibility.skipped.length > 0) {
        for (const skipped of eligibility.skipped) {
          mainTracking.council.skippedMember({ skipReason: skipped.reason });
          turnLogger.warn({ skipReason: skipped.reason }, 'council.skippedMember');
        }
      }

      const councilSettings = {
        ...settings,
        localModel: {
          ...settings.localModel,
          activeProfileId: settings.localModel?.activeProfileId ?? null,
          profiles: (settings.localModel?.profiles ?? []).filter(profile =>
            eligibility.kept.some(kept => kept.id === profile.id)
          ),
        },
      };

      councilConfig = buildCouncilConfig(
        councilSettings,
        typeof systemPrompt === 'string' ? systemPrompt : '',
        resolveCouncilLeadModel(modelConfig, settings),
        agentMcpSpecs,
        profileConnectivity,
      );
      if (councilConfig) {
        const activeCouncilConfig = councilConfig;
        // Real-time error callback: surface council member failures as status events.
        // Deduplicate by model name (first failure per model per turn).
        const notifiedModels = new Set<string>();
        const onCouncilError: CouncilErrorCallback = (modelName, errorMessage) => {
          if (notifiedModels.has(modelName)) return;
          // Guard against late callbacks after turn cleanup has started
          if (!councilTurnIds.has(turnId)) return;
          notifiedModels.add(modelName);
          const displayName = activeCouncilConfig.routeTable.routes.get(modelName)?.name ?? modelName;
          turnLogger.warn({ modelName, displayName, errorMessage }, 'Council member error (real-time)');
          dispatchAgentEvent(win, turnId, {
            type: 'status',
            message: 'One of the AI models hit an issue. Continuing with the others.',
            timestamp: Date.now(),
          });
        };

        try {
          // Add council routes to the persistent proxy (auto-starts if not running).
          // This doesn't disturb the base alt-model profile.
          await proxyManager.addRoutes(
            turnId,
            activeCouncilConfig.routeTable,
            onCouncilError,
            undefined,
            isUsingOpenRouter(routeSettings),
            codexConnectedAtTurnStart,
          );
          // Stale-turn guard (F4/GPT-stage2-F1, rework2-F2): a late-resolving
          // addRoutes after the pre-dispatch deadline fired must NOT add council
          // state / dispatch. Crucially it must also NOT call cleanupProxyRoutes —
          // proxy routes are keyed only by turnId, and a same-turnId RETRY may now
          // own freshly-added routes; removing them would clobber the retry. The
          // guard's own completeTurnCleanup already cleaned this attempt's routes
          // at guard-fire time. So: just abandon, touch no turn-keyed state.
          if (preDispatchGuardFired) {
            turnLogger.warn({ turnId }, 'Council addRoutes resumed after pre-dispatch deadline — abandoning (no turn-keyed cleanup, may belong to a retry)');
            return;
          }
          councilProxyUrl = proxyManager.getUrl();
        } catch (proxyStartErr) {
          // Stale-turn guard (GPT-stage2-F2, rework2-F2): a late addRoutes
          // REJECTION must NOT dispatch a second terminal NOR remove turn-keyed
          // proxy routes a retry may own. Abandon silently (see above).
          if (preDispatchGuardFired) {
            ignoreBestEffortCleanup(proxyStartErr, {
              operation: 'council-addRoutes-after-predispatch-deadline',
              reason: 'guard already terminalized; suppress duplicate + skip turn-keyed proxy cleanup',
            });
            return;
          }
          const councilProxyStartCopy = 'Multi-model setup couldn\'t start. Try sending your message again.';
          // Fail fast: council mode requires a working proxy. Don't continue ambiguously.
          turnLogger.error({ err: proxyStartErr }, 'Council proxy startup failed — cannot proceed');
          dispatchAgentErrorEvent(win, turnId, new Error(councilProxyStartCopy), {
            humanizedOverride: councilProxyStartCopy,
          });
          // addRoutes failed — clean up the partially-added route entry.
          // No need to restore anything: the base profile was never disturbed.
          cleanupProxyRoutes(turnId);
          completeTurnCleanup(turnId, 'council-proxy-failed', attemptEpoch);
          return;
        }

        // Fail fast if proxy started but auth token is missing (should not happen,
        // but guard against it to avoid the runtime silently sending unauthenticated requests)
        if (!councilProxyUrl || !proxyManager.getAuthToken()) {
          const councilProxyInitCopy = 'Multi-model setup couldn\'t initialize. Try sending your message again.';
          turnLogger.error(
            { hasProxyUrl: !!councilProxyUrl, hasAuthToken: !!proxyManager.getAuthToken() },
            'Council proxy started but URL or auth token missing — cannot proceed'
          );
          dispatchAgentErrorEvent(win, turnId, new Error(councilProxyInitCopy), {
            humanizedOverride: councilProxyInitCopy,
          });
          // Clean up the added routes. No need to stop/restore — proxy is persistent.
          cleanupProxyRoutes(turnId);
          completeTurnCleanup(turnId, 'council-proxy-missing-auth', attemptEpoch);
          return;
        }

        // Build model→display name mapping for user-facing failure attribution
        const modelDisplayNames = new Map<string, string>();
        for (const [modelName, profile] of councilConfig.routeTable.routes) {
          modelDisplayNames.set(modelName, profile.name || modelName);
        }

        councilTurnIds.add(turnId);
        councilTurnMeta.set(turnId, {
          modelDisplayNames,
          win,
        });

        turnLogger.info(
          {
            memberCount: Object.keys(councilConfig.agents).length,
            leadModel: councilConfig.leadModel,
            proxyUrl: councilProxyUrl,
          },
          'Council mode activated — routes added to persistent proxy'
        );
        dispatchAgentEvent(win, turnId, {
          type: 'status',
          message: `Council mode: ${Object.keys(councilConfig.agents).length} model${Object.keys(councilConfig.agents).length === 1 ? '' : 's'} assembled...`,
          timestamp: Date.now(),
        });
      } else {
        turnLogger.info('Council mode requested but no council members configured');
        dispatchAgentEvent(win, turnId, {
          type: 'status',
          message: 'Council mode: no council members configured. Proceeding with single model.',
          timestamp: Date.now(),
        });
      }
    }

    // Pre-register Smart-picking profiles + ad-hoc @-mentioned profiles as subagents.
    // Merged into one buildAdHocAgentConfig() call and one addRoutes() call to avoid
    // route overwrites (addRoutes overwrites, not merges).
    // Council membership is intentionally NOT the gate here — `councilEnabled` only
    // governs `//council` parallel fan-out; sub-agent eligibility comes from the
    // Smart-picking pool (`routingEligible`).
    // See docs/plans/260331_always_register_model_profiles.md (original design) and
    // the follow-up that retied this to Smart picking to match the UI tooltip.
    adHocConfig = null;
    let adHocProxyUrl: string | null = null;
    let preRegistrableProfiles: ModelProfile[] = [];
    let allRegisteredProfiles: ModelProfile[] = [];
    if (!councilModeEnabled && availableProfiles.length > 0) {
      const enabledProfiles = availableProfiles.filter(p =>
        p.enabled !== false && isConnectionLive(p, profileConnectivity),
      );

      // 1. Always-on pre-registration: Smart-picking profiles
      preRegistrableProfiles = getFunctionalRoutingProfiles(settings, profileConnectivity);

      // 2. Ad-hoc: user @-mentioned models (only non-pre-registered ones)
      const promptMatchedProfiles = detectModelReferences(promptWithoutOurComponents, enabledProfiles);
      const preRegisteredModelNames = new Set(preRegistrableProfiles.map(p => p.model));
      const adHocOnlyProfiles = promptMatchedProfiles.filter(p => !preRegisteredModelNames.has(p.model));

      // 3. Merge into one unified list (pre-registered first, then ad-hoc extras)
      allRegisteredProfiles = [...preRegistrableProfiles, ...adHocOnlyProfiles];

      if (allRegisteredProfiles.length > 0) {
        adHocConfig = buildAdHocAgentConfig(
          allRegisteredProfiles,
          typeof systemPrompt === 'string' ? systemPrompt : '',
          agentMcpSpecs,
        );
        if (adHocConfig) {
          const activeAdHocConfig = adHocConfig;
          // Real-time error callback (same pattern as council)
          const notifiedModels = new Set<string>();
          const onAdHocError: CouncilErrorCallback = (modelName, errorMessage) => {
            if (notifiedModels.has(modelName)) return;
            if (!adHocTurnIds.has(turnId)) return;
            notifiedModels.add(modelName);
            const displayName = activeAdHocConfig.modelDisplayNames.get(modelName) ?? modelName;
            turnLogger.warn({ modelName, displayName, errorMessage }, 'Ad-hoc model error (real-time)');
            dispatchAgentEvent(win, turnId, {
              type: 'status',
              message: 'One of the AI models hit an issue. Continuing with the default.',
              timestamp: Date.now(),
            });
          };

          try {
            await proxyManager.addRoutes(
              turnId,
              activeAdHocConfig.routeTable,
              onAdHocError,
              undefined,
              isUsingOpenRouter(routeSettings),
              codexConnectedAtTurnStart,
            );
            adHocProxyUrl = proxyManager.getUrl();
          } catch (proxyStartErr) {
            // Stale-turn guard (rework2-F2): a late addRoutes rejection after the
            // guard fired must abandon BEFORE cleanupProxyRoutes — the routes are
            // turn-keyed and may now belong to a same-turnId retry. Check FIRST.
            if (preDispatchGuardFired) {
              ignoreBestEffortCleanup(proxyStartErr, {
                operation: 'adhoc-addRoutes-after-predispatch-deadline',
                reason: 'guard already terminalized; skip turn-keyed proxy cleanup (may belong to a retry)',
              });
              return;
            }
            turnLogger.error({ err: proxyStartErr }, 'Ad-hoc model proxy startup failed — skipping ad-hoc dispatch');
            // addRoutes stores routes before ensureRunning — clean up stale entries on failure
            cleanupProxyRoutes(turnId);
            adHocConfig = null;
          }

          // Stale-turn guard (GPT-stage2-F3, rework2-F2): a late-resolving ad-hoc
          // addRoutes after the deadline must NOT add adHocTurnIds/Meta NOR touch
          // turn-keyed proxy routes (a retry may own them). Abandon before the
          // auth-check cleanup below.
          if (preDispatchGuardFired) {
            turnLogger.warn({ turnId }, 'Ad-hoc addRoutes resumed after pre-dispatch deadline — abandoning (no turn-keyed cleanup, may belong to a retry)');
            return;
          }

          if (adHocConfig && (!adHocProxyUrl || !proxyManager.getAuthToken())) {
            turnLogger.error(
              { hasProxyUrl: !!adHocProxyUrl, hasAuthToken: !!proxyManager.getAuthToken() },
              'Ad-hoc proxy started but URL or auth token missing — skipping ad-hoc dispatch',
            );
            cleanupProxyRoutes(turnId);
            adHocConfig = null;
          }

          if (adHocConfig) {
            adHocTurnIds.add(turnId);
            adHocTurnMeta.set(turnId, {
              modelDisplayNames: adHocConfig.modelDisplayNames,
              win,
            });

            turnLogger.info(
              {
                preRegistered: preRegistrableProfiles.map(p => p.model),
                adHocOnly: adHocOnlyProfiles.map(p => p.model),
                agentCount: Object.keys(adHocConfig.agents).length,
                turnId,
              },
              'Unified model dispatch: registered routes (pre-registered + ad-hoc)',
            );
          }
        }
      }
    }

    // Claude model @-mention detection: detect Claude model references in the prompt
    // and build native subagent definitions. Unlike third-party ad-hoc agents, Claude
    // subagents use native Anthropic aliases ('haiku', 'sonnet', 'opus') — no proxy needed.
    // Runs even when council mode is active (user can mention Claude models alongside council).
    claudeSubagentConfig = null;
    {
      const promptClaudeMatches = detectClaudeModelReferences(promptWithoutOurComponents);
      const claudeMatches = [...promptClaudeMatches];
      const seenClaudeAliases = new Set(promptClaudeMatches.map((target) => target.modelAlias));

      for (const alias of skillModelResolution.claudeAliases) {
        const aliasTarget = CLAUDE_MENTION_TARGETS.find((target) => target.modelAlias === alias);
        if (!aliasTarget || seenClaudeAliases.has(aliasTarget.modelAlias)) continue;
        seenClaudeAliases.add(aliasTarget.modelAlias);
        claudeMatches.push(aliasTarget);
      }

      if (claudeMatches.length > 0) {
        claudeSubagentConfig = buildClaudeSubagentConfig(claudeMatches, settings);
        if (claudeSubagentConfig) {
          turnLogger.info(
            {
              models: claudeMatches.map(t => t.modelValue),
              modelAliases: claudeMatches.map(t => t.modelAlias),
              agentCount: Object.keys(claudeSubagentConfig.agents).length,
            },
            'Claude subagent dispatch: registered native agents',
          );
        }
      }
    }

    // Build direct role clients (bypassing proxy for non-council/non-Gemini roles).
    // When a role profile resolves to a non-proxy target (OpenAI-compatible or direct Anthropic),
    // the executor creates the client here and injects it into Rebel Core. This avoids the
    // proxy translation layer for direct-routable providers.
    //
    // Codex OAuth: When the turn started with Codex connected and the selected profile
    // is tagged for Codex subscription routing, inject codexMode so the OpenAIClient
    // uses the Codex Responses endpoint instead of shared OpenAI API keys.
    const turnCodexMode: CodexModeConfig | undefined = codexConnectedAtTurnStart
      ? {
          endpointUrl: CODEX_ENDPOINT_URL,
          isConnected: codexAuthProvider.isConnected,
          getAccessToken: codexAuthProvider.getAccessToken,
          getAccountId: codexAuthProvider.getAccountId,
          forceRefreshToken: codexAuthProvider.forceRefreshToken,
        }
      : undefined;

    const codexModeForProfile = (
      profile: import('@shared/types/settings').ModelProfile,
      codexConnected: boolean,
    ): CodexModeConfig | undefined => {
      if (!isCodexSubscriptionProfile(profile)) return undefined;
      if (!codexConnected) {
        turnLogger.warn({ profile, codexConnected: false }, 'codex-profile-no-route');
        return undefined;
      }
      if (profile.providerType !== 'openai') return undefined;
      return turnCodexMode;
    };

    const preflightRuntimeContextForDecision = (
      decision: ProviderRouteDecision,
      routeProfile: ModelProfile | null | undefined,
    ): ProviderRouteRuntimeContext => {
      const decisionProfile = decision.profileId
        ? availableProfiles.find((profile) => profile.id === decision.profileId) ?? null
        : routeProfile ?? null;
      return {
        proxyBaseURL: null,
        proxyAuthToken: null,
        routedModel: null,
        turnId,
        anthropicApiKey: getApiKey(routeSettings),
        anthropicOAuthToken: getOAuthToken(routeSettings),
        openRouterOAuthToken: routeSettings.openRouter?.oauthToken,
        profileApiKey: decisionProfile
          ? resolveProfileApiKey(decisionProfile, routeSettings.providerKeys, routeSettings.customProviders)
          : null,
        endpointBaseURL: decisionProfile?.serverUrl ?? null,
        codexAuthProvider,
        processEnv: process.env as Record<string, string>,
      };
    };

    // Discriminated preflight result — kills the overloaded `null` that meant
    // BOTH "proxy-required (fall through to proxy)" and "couldn't build a direct
    // client". The three arms keep those states distinct so each call site can
    // preserve its own throw-vs-degrade policy (F4 / invariants #4, #10):
    //   - 'client'         → a direct client was built; use it.
    //   - 'proxy-required' → leave the direct client undefined and let
    //                        rebelCoreQuery build via the SAME proxy (REBEL-655,
    //                        invariant #4). Carries the typed routing model.
    //   - 'unavailable'    → the route is terminal / a client could not be built;
    //                        carries the ORIGINAL error so each call site keeps
    //                        its existing decision (fail-closed sites rethrow it,
    //                        the degrade site disables plan mode). NOT a catch-all.
    // Closed, locally-defined union (no IPC / `as`-cast entry point) → assertNever
    // is safe here.
    type PreflightClientResult =
      | { kind: 'client'; client: ModelClient }
      | { kind: 'proxy-required'; routingModel: RoutingModelId }
      | { kind: 'unavailable'; error: unknown };

    const createDirectPreflightClient = async (args: {
      model: string;
      profile?: ModelProfile | null;
      codexMode?: CodexModeConfig;
      role: NonNullable<ProviderRouterTurnInput['role']>;
    }): Promise<PreflightClientResult> => {
      const routeProfile = args.profile ?? null;
      const preflightRouteInput: ProviderRouterTurnInput = {
        model: args.model,
        ...(routeProfile ? { profile: routeProfile } : {}),
        settings: routeSettings,
        routeScope: 'normal-turn',
        codexConnectivity: resolveCodexConnectivity(codexConnectedAtTurnStart),
        role: args.role,
        // Stage 4b: thread the cooldown snapshot so the preflight route resolution
        // also skips rate-limited credentials (mirrors the main route input below).
        // Union with rateLimitAttemptedCredentialSources so in-turn retries hard-skip
        // every credential already tried this turn, even if cooldown has expired.
        // Stage 3: also union serverTransientAttemptedCredentialSources so a
        // server/transient failover re-drive can't re-pick a credential that just
        // 5xx'd this turn (server/transient errors never write a cooldown).
        cooledDownCredentialSources: new Set([
          ...providerRateLimitCooldowns.cooledDownSources(),
          ...(turnOptions?.rateLimitAttemptedCredentialSources ?? []),
          ...(turnOptions?.serverTransientAttemptedCredentialSources ?? []),
        ]),
      };
      try {
        const plan = await resolveProviderRoutePlan(
          { kind: 'forTurn', input: preflightRouteInput },
          // One-shot: derive the runtime context from the SAME decision the plan
          // is materialized from, rather than re-running ProviderRouter.forTurn.
          (decision) => preflightRuntimeContextForDecision(decision, routeProfile),
        );
        assertDispatchableQueryOptionsPlan(plan);
        if (plan.proxyRequired) {
          return {
            kind: 'proxy-required',
            routingModel: decodeTurnRoutingModelOrThrow(args.model, 'preflight proxy-required'),
          };
        }
        const client = createClientFromRoutePlan(plan, settings, {
          codexMode: args.codexMode,
          routeProfile,
        });
        return { kind: 'client', client };
      } catch (error) {
        // The original terminal/route error (ConnectionNotConfiguredError,
        // UnsupportedModelError, auth/routing errors from createClientFromRoutePlan)
        // is carried verbatim so the call site preserves its current policy.
        return { kind: 'unavailable', error };
      }
    };

    const activeProfileModel = activeProfile?.model?.trim();
    const activeProfileRoutingModel = activeProfileModel
      ? decodeTurnRoutingModelOrThrow(activeProfileModel, 'active profile')
      : undefined;
    if (activeProfile && activeProfileModel && !councilConfig) {
      const profileCodexMode = codexModeForProfile(activeProfile, codexConnectedAtTurnStart);
      const result = await createDirectPreflightClient({
        model: activeProfileModel,
        profile: activeProfile,
        codexMode: profileCodexMode,
        role: 'execution',
      });
      if (bailIfPreDispatchStale('direct-preflight-client')) return; // rework-F1
      switch (result.kind) {
        case 'client':
          // Gemini and other proxy-backed targets still need the proxy — only create direct client
          // for non-proxy targets (anthropic-direct, openai-compatible)
          directExecutionClient = result.client;
          break;
        case 'proxy-required':
          // Proxy-backed execution target — leave directExecutionClient undefined
          // and fall through to the proxy (invariant #4).
          break;
        case 'unavailable': {
          // Fail-closed policy preserved: terminal credential/model errors rethrow;
          // anything else falls back to the proxy/Anthropic with a warning.
          const err = result.error;
          if (err instanceof ConnectionNotConfiguredError || err instanceof UnsupportedModelError) throw err;
          turnLogger.warn({ err, profile: activeProfile.name }, 'Failed to create direct execution client — will fall back to proxy/Anthropic');
          break;
        }
        default:
          assertNever(result);
      }
    }

    const thinkingProfileModel = effectiveThinkingProfile?.model?.trim();
    const thinkingProfileRoutingModel = thinkingProfileModel
      ? decodeTurnRoutingModelOrThrow(thinkingProfileModel, 'thinking profile')
      : undefined;
    // Track the routing model the directPlanningClient was created for (read at
    // :planningModelOverride below). May differ from thinkingProfileModel when
    // fallback paths create the client.
    let directPlanningRoutingModel: RoutingModelId | undefined;
    if (effectiveThinkingProfile && thinkingProfileModel && !councilConfig) {
      const profileCodexMode = codexModeForProfile(effectiveThinkingProfile, codexConnectedAtTurnStart);
      const result = await createDirectPreflightClient({
        model: thinkingProfileModel,
        profile: effectiveThinkingProfile,
        codexMode: profileCodexMode,
        role: 'planning',
      });
      if (bailIfPreDispatchStale('direct-preflight-client')) return; // rework-F1
      switch (result.kind) {
        case 'client':
          directPlanningClient = result.client;
          directPlanningRoutingModel = thinkingProfileRoutingModel;
          break;
        case 'proxy-required':
          // REBEL-655: a proxy-required route (e.g. a distinct Codex/OpenRouter
          // thinking profile). We intentionally leave directPlanningClient
          // undefined and let rebelCoreQuery build the planning client via the
          // SAME proxy (invariant #4). This is safe because ENV_THINKING_MODEL
          // already names the REAL thinking model (resolvePlanningThinkingModel
          // above), never the Claude sentinel — so the proxy serves it under
          // proxyHandlesAuth and the Anthropic-direct leak can no longer occur
          // for a proxy-backed thinking profile.
          break;
        case 'unavailable': {
          // Fail-closed policy preserved: terminal credential/model errors rethrow.
          const err = result.error;
          if (err instanceof ConnectionNotConfiguredError || err instanceof UnsupportedModelError) throw err;
          turnLogger.warn({ err, profile: effectiveThinkingProfile.name }, 'Failed to create direct planning client — will fall back to proxy/Anthropic');
          dispatchAgentEvent(win, turnId, {
            type: 'status',
            message: `Planner "${effectiveThinkingProfile.name}" unavailable — using Claude Opus 4.8 instead`,
            timestamp: Date.now(),
          });
          agentTurnRegistry.addTurnFallback(turnId, {
            type: 'model',
            from: thinkingProfileModel,
            to: PREFERRED_PLANNING_MODEL,
            reason: 'thinking-profile-auth-failure',
          });
          // Also try to create a direct Anthropic client for the fallback model
          // to prevent it from leaking through the Codex proxy.
          const fallbackResult = await createDirectPreflightClient({
            model: PREFERRED_PLANNING_MODEL,
            profile: undefined,
            role: 'planning',
          });
          if (bailIfPreDispatchStale('direct-preflight-client')) return; // rework-F1
          switch (fallbackResult.kind) {
            case 'client':
              directPlanningClient = fallbackResult.client;
              directPlanningRoutingModel = decodeTurnRoutingModelOrThrow(PREFERRED_PLANNING_MODEL, 'planning fallback');
              turnLogger.info({ model: PREFERRED_PLANNING_MODEL }, 'Created direct planning client for thinking profile fallback');
              break;
            case 'proxy-required':
              // Preserves the prior null-return behaviour: leave directPlanningClient
              // undefined and fall through (rebelCoreQuery builds via the proxy).
              break;
            case 'unavailable': {
              // REBEL-540: synthetic PREFERRED_PLANNING_MODEL ('claude-opus-4-8') is
              // injected into modelConfig at line ~1944 whenever a thinkingProfile is
              // configured. If we cannot build a direct planning client (no Anthropic
              // creds, etc.), `rebelCoreQuery.ts` will rebuild via createClientForModel
              // with the synthetic Claude name + active proxyConfig — which under
              // Codex used to silently remap to gpt-5.5 (REBEL-540) and now throws a
              // classified auth error. Disable plan mode for this turn so the
              // executor degrades gracefully instead of forcing the rebuild path.
              turnLogger.warn({ err: fallbackResult.error }, 'Cannot create direct planning client for thinking profile fallback — disabling plan mode');
              dispatchAgentEvent(win, turnId, {
                type: 'status',
                message: 'Planner requires API credentials — using single model for this turn',
                timestamp: Date.now(),
              });
              modelConfig = resolveModelConfig(requestedModel, null, extendedContextEnabled);
              agentTurnRegistry.setTurnModel(turnId, modelConfig.model);
              break;
            }
            default:
              assertNever(fallbackResult);
          }
          break;
        }
        default:
          assertNever(result);
      }
    }

    // Fallback: bare thinkingModel (no profile) — create direct client for Claude models.
    // This prevents Claude planning models from being silently remapped by the Codex proxy.
    //
    // REBEL-655 (MA1): gate on `!thinkingProfile`. This block reads the RAW
    // `thinkingModel` setting; without the guard it also fired when a distinct
    // proxy-backed thinking PROFILE was active whose direct preflight returned
    // null (proxy-required) — so a stale raw `claude-*` `thinkingModel` setting
    // would hijack the selected planner: either silently disabling plan mode (no
    // Anthropic key) or injecting a Claude planning client + patching env to the
    // wrong (Claude) model. When a thinking profile exists, the profile branch
    // above is authoritative and `resolvePlanningThinkingModel` already set
    // ENV_THINKING_MODEL to the real proxy-backed model — so we fall through to
    // rebelCoreQuery and route via the proxy, never the Claude sentinel.
    if (!directPlanningClient && !councilConfig && !effectiveThinkingProfile) {
      const bareThinkingModel = (thinkingModelOverride !== undefined
        ? thinkingModelOverride
        : getThinkingModel(settings))?.trim();

      // Type the bare-setting producer (F3 site 5 — the known "second producer"):
      // brand the bare thinking model to a typed RoutingModelId up front so this
      // producer is off the raw-string path. The branded id (not a raw string) is
      // what creates the planning client and patches ENV_THINKING_MODEL below.
      // Firing condition is preserved exactly (bare claude-* setting present).
      const bareThinkingRoutingModel = bareThinkingModel
        ? decodeRoutingModelId(bareThinkingModel)
        : null;
      if (bareThinkingRoutingModel && bareThinkingRoutingModel.startsWith('claude-')) {
        const result = await createDirectPreflightClient({
          model: bareThinkingRoutingModel,
          profile: undefined,
          role: 'planning',
        });
        if (bailIfPreDispatchStale('direct-preflight-client')) return; // rework-F1
        switch (result.kind) {
          case 'client':
            directPlanningClient = result.client;
            directPlanningRoutingModel = bareThinkingRoutingModel;
            // Patch env overrides so rebelCoreQuery uses the correct model name.
            if (modelConfig.envOverrides?.[ENV_THINKING_MODEL]) {
              modelConfig = {
                ...modelConfig,
                envOverrides: {
                  ...modelConfig.envOverrides,
                  [ENV_THINKING_MODEL]: bareThinkingRoutingModel,
                },
              };
            }
            turnLogger.info({ model: bareThinkingRoutingModel }, 'Created direct planning client for bare Claude thinking model');
            break;
          case 'proxy-required':
            // Preserves the prior null-return behaviour: leave directPlanningClient
            // undefined and fall through (rebelCoreQuery builds via the proxy).
            break;
          case 'unavailable':
            // Degrade policy preserved: no Anthropic credentials available — disable
            // plan mode for this turn (never a silent route).
            turnLogger.warn({ err: result.error, model: bareThinkingModel }, 'Cannot create direct planning client for bare thinking model — disabling plan mode');
            dispatchAgentEvent(win, turnId, {
              type: 'status',
              message: `Planner "${bareThinkingModel}" requires API credentials — using single model for this turn`,
              timestamp: Date.now(),
            });
            // Rebuild modelConfig without plan mode.
            modelConfig = resolveModelConfig(requestedModel, null, extendedContextEnabled);
            agentTurnRegistry.setTurnModel(turnId, modelConfig.model);
            break;
          default:
            assertNever(result);
        }
      }
    }

    // When a direct non-Claude role client is injected, plan mode env vars still carry
    // Claude model names (e.g., EXECUTION_MODEL='claude-sonnet-4-6'). Patch them to
    // the profile's actual model name so the injected client receives a model it recognizes.
    // Without this, an OpenAI client gets 'claude-sonnet-4-6' → "model does not exist".
    if (directExecutionClient && activeProfileModel
        && !activeProfileModel.startsWith('claude-')
        && modelConfig.envOverrides?.[ENV_EXECUTION_MODEL]) {
      modelConfig = {
        ...modelConfig,
        envOverrides: {
          ...modelConfig.envOverrides,
          [ENV_EXECUTION_MODEL]: activeProfileModel,
        },
      };
    }
    if (directPlanningClient && thinkingProfileModel
        && !thinkingProfileModel.startsWith('claude-')
        && modelConfig.envOverrides?.[ENV_THINKING_MODEL]) {
      modelConfig = {
        ...modelConfig,
        envOverrides: {
          ...modelConfig.envOverrides,
          [ENV_THINKING_MODEL]: thinkingProfileModel,
        },
      };
    }

    // FOX-2656: Detect when a non-Claude role profile is active for base execution.
    // Used in the catch block to trigger fallback-to-Claude when the role-profile API fails.
    // Pre-registered ad-hoc profiles don't affect this — they're subagent routes, not base model.
    isDirectRoleProfile = (!!activeProfile || !!directExecutionClient) && !councilConfig;

    // Resolve the final model: council mode forces a full model name for the lead agent
    // (normally Claude, but may be non-Claude for non-Anthropic providers / a non-Claude
    // thinking profile — REBEL-655; see CouncilConfig.leadModel).
    // Use a getter so fallback paths (e.g. 200K context) that update modelConfig are reflected.
    // Reads queryOptionsCtx.modelConfig (not the closure-captured modelConfig) so that error
    // recovery only needs to update queryOptionsCtx.modelConfig for the builder AND this getter
    // to stay consistent. The closure-captured modelConfig is still updated for ErrorRecoveryContext.
    // Precedence: council > plan mode alias > active profile > base model.
    // Plan mode alias MUST pass through to resolveRuntimeModels() even when a Working
    // profile is active — the profile routes via direct client injection, not the model string.
    // See docs/plans/260408_role_based_direct_client_routing.md Key Design Decision #3.
    const getEffectiveModel = (): string =>
      councilConfig ? resolveCouncilLeadModel(queryOptionsCtx.modelConfig, settings)
        : queryOptionsCtx.modelConfig.model === PLAN_MODE_ALIAS ? PLAN_MODE_ALIAS
          : (activeProfileModel || queryOptionsCtx.modelConfig.model);

    // Record the routed profile model in the registry when an active profile overrides the
    // configured base. Previously gated on `directExecutionClient && activeProfileModel`, which
    // skipped the proxy-required route (directExecutionClient undefined for managed flat-fee /
    // proxy-backed targets like DeepSeek) — the registry then kept the configured alias from :3240
    // and buildModelRoles() mislabeled the working role (FOX-3436). Dropping the directExecutionClient
    // precondition records the routed model on the proxy path too. activeProfileModel is always a real
    // model id (never PLAN_MODE_ALIAS, which is modelConfig.model), and the no-profile default path is
    // unchanged (base model already recorded at :3240) — so no fixture churn and no sentinel guard.
    if (activeProfileModel) {
      agentTurnRegistry.setTurnModel(turnId, activeProfileModel);
    }
    // Build the final system prompt: append council/ad-hoc instructions if active
    let finalSystemPrompt = councilConfig && typeof systemPrompt === 'string'
      ? systemPrompt + councilConfig.systemPromptSuffix
      : systemPrompt;
    if (adHocConfig && typeof finalSystemPrompt === 'string') {
      // Build <available_models> section for all registered profiles (pre-registered + ad-hoc).
      // When pre-registered profiles exist, this replaces the generic ad-hoc systemPromptHint
      // with richer metadata (provider, cost tier, context window).
      if (preRegistrableProfiles.length > 0) {
        // Deduplicate by model name (matches buildAdHocAgentConfig first-wins behavior)
        const seenModels = new Set<string>();
        const dedupedProfiles = allRegisteredProfiles.filter(p => {
          if (!p.model || seenModels.has(p.model)) return false;
          seenModels.add(p.model);
          return true;
        });
        const availableModelsSection = buildAvailableModelsPrompt(
          adHocConfig.agents,
          dedupedProfiles,
        );
        if (availableModelsSection) {
          adHocConfig = { ...adHocConfig, systemPromptHint: availableModelsSection };
        }
      }
      finalSystemPrompt = finalSystemPrompt + adHocConfig.systemPromptHint;
    }
    if (claudeSubagentConfig && typeof finalSystemPrompt === 'string') {
      finalSystemPrompt = finalSystemPrompt + claudeSubagentConfig.systemPromptHint;
    }

    // Resolve MCP capabilities (suppresses built-in tools when superior MCP alternatives are connected).
    // Only suppress when MCP servers are actually available for this turn — if MCP degraded
    // (e.g. Super-MCP not running), keep built-in tools so the agent isn't left without any search.
    const connectedPackages = await buildConnectedPackages();
    if (bailIfPreDispatchStale('buildConnectedPackages')) return; // rework-F1
    const capabilityResolution = mcpServers
      ? resolveCapabilities(connectedPackages)
      : { disallowedTools: [], promptGuidance: [], activeCapabilities: [] };

    // Append capability guidance to the system prompt only when MCP is actually available.
    // This runs AFTER both resolveSystemPrompt() and safeMcpResolve() have completed, so
    // we know the MCP state. The guidance is NOT injected during prompt rendering (which runs
    // in parallel with MCP resolution) to avoid telling the agent to use MCP tools when they
    // aren't attached for the turn.
    if (capabilityResolution.promptGuidance.length > 0 && typeof finalSystemPrompt === 'string') {
      const guidanceBlock = capabilityResolution.promptGuidance.map(g => `- ${g}`).join('\n');
      finalSystemPrompt = `${finalSystemPrompt}\n\n**Active capability upgrades:**\n${guidanceBlock}`;
    }

    // Build hooks in RebelCoreHooks format (typed, not legacy Options.hooks)
    const guardChiefDesignerVisualTools = shouldGuardChiefDesignerVisualTools(
      promptWithoutOurComponents,
      explicitOurComponentsRequested,
    );
    const chiefDesignerVisualToolGuardHook = guardChiefDesignerVisualTools
      ? createChiefDesignerVisualToolGuardHook(true, promptWithoutOurComponents)
      : null;
    // Shared session id for the schema-gate Pre/Post hooks. Computed ONCE so the
    // PreToolUse enforcer and the PostToolUse hydration-recorder share the same
    // state — on the eval fallback path `eval-${Date.now()}` would otherwise
    // diverge between the two calls and the gate would never see a hydrated tool.
    const schemaGateSessionId = rendererSessionId ?? `eval-${Date.now()}`;
    const turnHooks = {
      // PreToolUse hooks: MCP deny + tool safety + memory write + staged read
      PreToolUse: [
        // MCP deny hook (blocks MCP tool calls during memory-update turns, deny fast before other hooks)
        ...(mcpDenyHook ? [{ hooks: [mcpDenyHook] }] : []),
        // Chief Designer in-app visual reviews must use Rebel-native capture, not browser/dev-app screenshots.
        ...(chiefDesignerVisualToolGuardHook
          ? [{ hooks: [chiefDesignerVisualToolGuardHook] }]
          : []),
        // OAuth preflight hook (best-effort token sync before OAuth-backed MCP tools).
        { hooks: [createTokenSyncPreflightHook({
          coordinator: getTokenSyncCoordinator(),
          resolver: getOAuthToolResolver(),
        })] },
        // Search tool intercept (routes search_tools to LanceDB hybrid search instead of Super-MCP BM25)
        { hooks: [createSearchToolInterceptHook()] },
        // Schema gate: ensures model has called get_tool_details before use_tool
        { hooks: [createSchemaGateHook(schemaGateSessionId)] },
        // Tool safety hook (for regular turns, skipped when bypassToolSafety)
        ...(toolSafetyHook ? [{ hooks: [toolSafetyHook] }] : []),
        // Inbound trigger safety hook (adapter-provided, e.g., PII check for public Slack channels)
        ...(inboundSafetyHook ? [{ hooks: [inboundSafetyHook as HookCallback] }] : []),
        // Space permission hook (blocks writes to read-only cloud spaces)
        ...(spacePermissionHook ? [{ hooks: [spacePermissionHook] }] : []),
        // Memory write hook (for memory update turns, intercepts Edit/Create)
        ...(memoryWriteHook ? [{ hooks: [memoryWriteHook] }] : []),
        // Staged read hook (returns staged content for files pending approval)
        // Only active when staged writes enabled (setting or env var) and memory write hook is active
        ...(memoryWriteHook && (settings.enableStagedWrites || process.env.REBEL_ENABLE_STAGED_WRITES === '1')
          ? [{ hooks: [createStagedReadHook({ sessionId: rendererSessionId ?? undefined })] }]
          : []),
        // User question hook (intercepts AskUserQuestion, persists batch, dispatches event, ends turn)
        ...(rendererSessionId ? [{ hooks: [createUserQuestionHook(rendererSessionId, turnId)] }] : []),
      ] as RebelCoreHookMatcher[],
      // Inject frequent tools, connected packages, and capability guidance into all subagents
      SubagentStart: [{
        hooks: [async () => {
          // Build contexts (async for connectedPackages)
          const frequentTools = getFrequentTools();
          const connectedPackages = await buildConnectedPackages();
          const frequentToolGroups = buildFrequentToolGroups(frequentTools, connectedPackages);

          const frequentToolsContext = formatFrequentToolsContext(frequentToolGroups);
          const connectedPackagesContext = formatConnectedPackagesContext(connectedPackages);

          // Reuse turn-level capability resolution (avoids recomputing; same input = same result)
          const capabilityContext = capabilityResolution.promptGuidance.length > 0
            ? `\n\n**Active capability upgrades:**\n${capabilityResolution.promptGuidance.map(g => `- ${g}`).join('\n')}`
            : '';
          const fullPackagesContext = [connectedPackagesContext, capabilityContext].filter(Boolean).join('') || undefined;

          // Combine contexts, filtering out empty ones
          const contextParts = [frequentToolsContext, fullPackagesContext].filter(Boolean);
          // Hooks MUST return an object (even empty {}), not undefined
          if (contextParts.length === 0) return {};

          const additionalContext = contextParts.join('\n\n');
          return {
            hookSpecificOutput: {
              hookEventName: 'SubagentStart' as const,
              additionalContext,
            },
          };
        }],
      }] as RebelCoreHookMatcher[],
      // PostToolUse hooks: checkpoint integrity verification + file-conversation tracking + MCP build auto-detect
      PostToolUse: [
        ...(chiefDesignerVisualToolGuardHook ? [{ hooks: [chiefDesignerVisualToolGuardHook] }] : []),
        // Schema gate (F3): record get_tool_details hydration only on SUCCESS.
        { hooks: [createSchemaGatePostHook(schemaGateSessionId)] },
        ...(checkpointIntegrityHook ? [{ hooks: [checkpointIntegrityHook] }] : []),
        ...(fileConversationTrackingHook ? [{ hooks: [fileConversationTrackingHook] }] : []),
        ...(mcpBuildAutoDetectHook ? [{ hooks: [mcpBuildAutoDetectHook] }] : []),
      ] as RebelCoreHookMatcher[],
      // Stop hooks: auto-continue for rhetorical questions and incomplete skills.
      // Approval-execution guard runs FIRST (deterministic before behavioral —
      // first block wins in runStopHooksWithReason).
      Stop: [
        ...(chiefDesignerVisualToolGuardHook ? [{ hooks: [chiefDesignerVisualToolGuardHook] }] : []),
        ...(approvalExecutionGuardHook ? [{ hooks: [approvalExecutionGuardHook] }] : []),
        ...(autoContinueHook ? [{ hooks: [autoContinueHook] }] : []),
      ] as RebelCoreHookMatcher[],
      // SubagentStop hooks: same auto-continue behavior for subagents
      SubagentStop: [
        ...(autoContinueHook ? [{ hooks: [autoContinueHook] }] : []),
      ] as RebelCoreHookMatcher[],
    } as RebelCoreHooks;

    // OpenRouter / Codex: start proxy so env builders can resolve a URL.
    // Council/ad-hoc modes start the proxy themselves; this covers the default
    // single-model path where the SDK just needs ANTHROPIC_BASE_URL → local proxy.
    const needsProxyForProvider = (
      isUsingOpenRouter(routeSettings)
      || (routeSettings.activeProvider === 'codex' && codexConnectedAtTurnStart)
    ) && !councilConfig && !adHocConfig;
    turnLogger.info({
      needsProxyForProvider,
      activeProvider: routeSettings.activeProvider,
      isOpenRouter: isUsingOpenRouter(routeSettings),
      hasCouncil: !!councilConfig,
      hasAdHoc: !!adHocConfig,
    }, '[CODEX-DIAG] Proxy routing decision');
    if (needsProxyForProvider) {
      try {
        await proxyManager.addRoutes(turnId, { routes: new Map() }, undefined, undefined, undefined, codexConnectedAtTurnStart);
        // Stale-turn guard (GPT-stage2-F4, rework2-F2): a late-resolving
        // provider-proxy start after the deadline must abandon WITHOUT touching
        // turn-keyed proxy routes (a same-turnId retry may own them; the guard's
        // own cleanup already removed this attempt's routes at guard-fire time).
        if (preDispatchGuardFired) {
          turnLogger.warn({ turnId }, 'Provider proxy addRoutes resumed after pre-dispatch deadline — abandoning (no turn-keyed cleanup, may belong to a retry)');
          return;
        }
        turnLogger.info(
          { proxyUrl: proxyManager.getUrl(), provider: routeSettings.activeProvider },
          'Provider proxy started for direct turn routing',
        );
      } catch (proxyStartErr) {
        // Stale-turn guard (GPT-stage2-F4, rework2-F2): late rejection after the
        // guard fired must NOT dispatch a duplicate terminal NOR remove turn-keyed
        // proxy routes (may belong to a retry). Abandon silently.
        if (preDispatchGuardFired) {
          ignoreBestEffortCleanup(proxyStartErr, {
            operation: 'provider-proxy-addRoutes-after-predispatch-deadline',
            reason: 'guard already terminalized; suppress duplicate + skip turn-keyed proxy cleanup',
          });
          return;
        }
        const providerProxyStartCopy = 'Failed to start provider proxy. Please try again.';
        turnLogger.error({ err: proxyStartErr }, 'Provider proxy startup failed');
        cleanupProxyRoutes(turnId);
        // Preserve Sentry coverage. Without explicit capture here, renderer-side Sentry
        // would be suppressed by helper's errorSource: 'main' and helper does not call
        // Sentry for provider-proxy-startup errors.
        getErrorReporter().captureException(new Error('Provider proxy failed to start'), {
          tags: { area: 'agent-turn', component: 'provider-proxy' },
          extra: { turnId, provider: routeSettings.activeProvider },
        });
        dispatchAgentErrorEvent(win, turnId, new Error(providerProxyStartCopy), {
          humanizedOverride: providerProxyStartCopy,
        });
        completeTurnCleanup(turnId, 'openrouter-proxy-failed', attemptEpoch);
        return;
      }
    }

    const routeScope = councilConfig ? 'council' : adHocConfig ? 'ad-hoc' : 'normal-turn';
    const routeProfile = councilConfig ? null : activeProfile ?? null;
    const initialRouteModel = councilConfig ? resolveCouncilLeadModel(modelConfig, settings)
      : modelConfig.model === PLAN_MODE_ALIAS ? PLAN_MODE_ALIAS
        : (activeProfileModel || modelConfig.model);
    const routeProxyBaseURL = councilProxyUrl ?? adHocProxyUrl ?? (
      needsProxyForProvider || routeProfile?.providerType === 'google'
        ? proxyManager.getUrl()
        : null
    );
    routeInput = {
      settings: { ...routeSettings, hasManagedKey: hasManagedOpenRouterKey() },
      model: initialRouteModel,
      ...(routeProfile ? { profile: routeProfile } : {}),
      codexConnectivity: resolveCodexConnectivity(codexConnectedAtTurnStart),
      routeScope,
      role: 'execution',
      // Stage 4b: thread the cooldown snapshot so the route-decision selection seam
      // skips rate-limited credentials on retry. Behaviour-preserving today (store
      // is empty until step 4b records; empty set → isUsableProviderMode ignores).
      // Union with rateLimitAttemptedCredentialSources so in-turn retries hard-skip
      // every credential already tried this turn, even if cooldown has expired.
      // Stage 3: also union serverTransientAttemptedCredentialSources so a
      // server/transient failover re-drive can't re-pick a credential that just
      // 5xx'd this turn (server/transient errors never write a cooldown).
      cooledDownCredentialSources: new Set([
        ...providerRateLimitCooldowns.cooledDownSources(),
        ...(turnOptions?.rateLimitAttemptedCredentialSources ?? []),
        ...(turnOptions?.serverTransientAttemptedCredentialSources ?? []),
      ]),
    };
    routeRuntimeContextForDecision = (decision: ProviderRouteDecision): ProviderRouteRuntimeContext => {
      const decisionProfile = decision.profileId
        ? availableProfiles.find((profile) => profile.id === decision.profileId) ?? null
        : routeProfile;
      const decisionProxyRuntime = proxyRuntimeForDecision(decision, {
        baseURL: routeProxyBaseURL,
        authToken: routeProxyBaseURL ? proxyManager.getAuthToken() : null,
      });
      return {
        proxyBaseURL: decisionProxyRuntime.proxyBaseURL,
        proxyAuthToken: decisionProxyRuntime.proxyAuthToken,
        routedModel: decisionProxyRuntime.routedModel,
        turnId,
        anthropicApiKey: getApiKey(routeSettings),
        anthropicOAuthToken: getOAuthToken(routeSettings),
        openRouterOAuthToken: routeSettings.openRouter?.oauthToken,
        profileApiKey: decisionProfile
          ? resolveProfileApiKey(decisionProfile, routeSettings.providerKeys, routeSettings.customProviders)
          : null,
        endpointBaseURL: decisionProfile?.serverUrl ?? null,
        codexAuthProvider,
        processEnv: process.env as Record<string, string>,
      };
    };
    providerRoutePlan = await resolveProviderRoutePlan(
      {
        kind: 'forTurn',
        input: routeInput,
        ...(turnOptions?.routeRebuildHint && turnOptions.inFlightProviderRoutePlan
          ? {
              fallback: {
                fallbackHint: turnOptions.routeRebuildHint,
                inFlightPlan: turnOptions.inFlightProviderRoutePlan,
              },
            }
          : {}),
      },
      // One-shot: derive the runtime context from the SAME decision the plan is
      // materialized from (including any fallback rebuild), rather than re-running
      // ProviderRouter.forTurn here. The request above carries the identical
      // fallback options, so decisionForRequest reproduces the same decision once.
      routeRuntimeContextForDecision,
    );

    // Stale-turn guard (GPT-stage2-F5): the final route-plan resolution is the
    // last unbounded await before the watchdog-arm chokepoint. If the pre-dispatch
    // deadline fired while resolving, the turn was already terminated — abandon
    // before mutating registry auth/provider state or broadcasting a stale
    // route-plan-resolved event to the renderer.
    if (bailIfPreDispatchStale('resolveProviderRoutePlan-final')) return;

    const effectiveAuth = resolveTurnAuthLabelFromRoutePlan(providerRoutePlan);
    agentTurnRegistry.setTurnAuthMethod(turnId, effectiveAuth);
    agentTurnRegistry.setTurnActiveProvider(turnId, routeSettings.activeProvider ?? 'anthropic');
    if (rendererSessionId) {
      const decisionProfile = providerRoutePlan.decision.profileId
        ? availableProfiles.find((p) => p.id === providerRoutePlan.decision.profileId)
        : null;
      getBroadcastService().sendToAllWindows(AGENT_ROUTE_PLAN_RESOLVED_CHANNEL, {
        sessionId: rendererSessionId,
        turnAuthLabel: effectiveAuth,
        resolvedAt: Date.now(),
        ...(decisionProfile?.name ? { profileName: decisionProfile.name } : {}),
      } satisfies AgentRoutePlanResolvedEvent);
    }

    const isCodexActiveAndConnected =
      routeSettings.activeProvider === 'codex' && codexConnectedAtTurnStart === true;
    if (isCodexActiveAndConnected) {
      const warningPayload = {
        workingProfileId: getWorkingProfileId(settings),
        profileId: profile?.id,
        profileType: profile?.providerType,
        codexConnected: codexConnectedAtTurnStart,
        activeProvider: routeSettings.activeProvider,
        model: getCurrentModel(settings),
        resolvedAuthLabel: effectiveAuth,
        credentialSource: providerRoutePlan.decision.credentialSource,
      };

      if (effectiveAuth === 'codex-subscription' && !profile) {
        if (!agentTurnRegistry.hasCodexProfileDriftWarningEmitted(turnId, 'caseA')) {
          turnLogger.warn(
            warningPayload,
            'Codex profile state rescued: route plan tagged subscription despite null working profile',
          );
          agentTurnRegistry.markCodexProfileDriftWarningEmitted(turnId, 'caseA');
        }
      } else if (effectiveAuth !== 'codex-subscription') {
        if (!agentTurnRegistry.hasCodexProfileDriftWarningEmitted(turnId, 'caseB')) {
          turnLogger.warn(
            warningPayload,
            'Codex active+connected but route did not resolve to subscription (model or profile mismatch)',
          );
          agentTurnRegistry.markCodexProfileDriftWarningEmitted(turnId, 'caseB');
        }
      }
    }

    turnLogger.info({
      activeProvider: routeSettings.activeProvider ?? 'anthropic',
      effectiveAuth,
      workingProfileId: profile?.id,
      workingModel: profile?.model ?? diagnosticWorkingModel,
      routeProfileId: providerRoutePlan.decision.profileId,
      routeTransport: providerRoutePlan.decision.transport,
      decisionKind: providerRoutePlan.decision.kind,
      decisionDispatchPath: providerRoutePlan.decision.dispatchPath,
      routeCredentialSource: providerRoutePlan.decision.credentialSource,
    }, 'Turn provider routing resolved');

    // Terminal-route observability (Pathologist rec #1): a RECOVERABLE terminal
    // route decision (e.g. `missing-mindstone-credentials` on cloud/mobile)
    // blocks the turn pre-dispatch → no model call → no assistant response. This
    // used to be telemetry-silent (the cross-surface managed-key gap went
    // unnoticed for ~27 days). Emit a distinct, greppable log + a thresholded
    // Sentry signal (surface/activeProvider/credentialSource/invalidReason/
    // wireModel — no secrets) so a fleet monitor can rate-alert on the class.
    recordTerminalRouteDecision({
      decision: providerRoutePlan.decision,
      activeProvider: routeSettings.activeProvider,
      logger: turnLogger,
    });

    // Paid-fallback indicator (docs/plans/260621_paid-fallback-indicator/):
    // patch-back + per-hop telemetry at the route-RESOLUTION seam. Guarded on a
    // non-empty attempted set so it fires ONLY on a Stage-4b failover RETRY (never
    // the initial turn). The Stage-4b write records a placeholder `to:'auto-failover'`
    // BEFORE the retry; the real destination is only known here, once the fresh route
    // resolves. Patching at resolution (not the final-success block) attributes EVERY
    // hop — including an intermediate hop that lands then itself 429s: for A→B(429)→C,
    // the B-resolution patches A's placeholder to B, and the C-resolution patches B's
    // placeholder to C (final state A→B, B→C). A turn that never re-resolves (e.g.
    // abort before any resolution) correctly keeps 'auto-failover'.
    // Stage 3: the patch-back + telemetry must ALSO fire for server/transient
    // failover (provider-agnostic recovery "C"), not just 429 failover — otherwise a
    // server-error-triggered switch to a PAID backup lands with no billing indicator
    // and no telemetry (pre-flip gate item #3 violation). Pass the UNION of both
    // attempted sets, and tag the reason by which class drove the switch.
    const rateLimitAttempted = turnOptions?.rateLimitAttemptedCredentialSources ?? [];
    const serverTransientAttempted = turnOptions?.serverTransientAttemptedCredentialSources ?? [];
    if (rateLimitAttempted.length > 0 || serverTransientAttempted.length > 0) {
      const resolvedCredential = providerRoutePlan.decision.credentialSource;
      const resolvedBillingSource = providerRoutePlan.decision.billingSource ?? null;
      // Rewrites the LAST pending placeholder only (multi-hop safe); a no-op if the
      // retry resolved without a pending record (defensive).
      agentTurnRegistry.updatePendingProviderFallbackDestination(turnId, {
        to: resolvedCredential,
        billingSource: resolvedBillingSource,
      });

      // Union of both attempted sets (dedup) so per-hop analytics reflect every
      // credential tried this turn regardless of failure class.
      const attemptedCredentialSourcesUnion = [
        ...new Set([...rateLimitAttempted, ...serverTransientAttempted]),
      ];
      // FIX-3: a mixed episode (BOTH classes) is now reported as
      // 'mixed-rate-limit-and-server-error' so analytics doesn't silently under-count
      // server-error switches. A pure 429 episode stays 'rate-limit-failover'
      // (byte-identical to pre-Stage-3); a pure server/transient episode is
      // 'server-error-failover'.
      const failoverReason = deriveProviderFailoverReason({
        rateLimitCount: rateLimitAttempted.length,
        serverTransientCount: serverTransientAttempted.length,
      });

      // PII-safe, categorical-only analytics for the paid-fallback class. One event
      // per hop = correct per-hop analytics. Fail-open: telemetry must never break a
      // turn (AGENTS.md "silent failure is a bug" — observable catch, not swallowed).
      try {
        getTracker().track(PROVIDER_FAILOVER_EVENT, {
          ...buildProviderFailoverTelemetry({
            attemptedCredentialSources: attemptedCredentialSourcesUnion,
            resolvedCredentialSource: resolvedCredential,
            resolvedBillingSource,
            reason: failoverReason,
          }),
        });
      } catch (telemetryError) {
        turnLogger.warn(
          { err: telemetryError },
          'Provider Failover Observed telemetry emit failed — continuing',
        );
      }
    }

    // Build context for the extracted query options builder.
    // The context is a mutable reference: error recovery can update ctx.modelConfig
    // and the next buildSdkQueryOptions(ctx) call picks up the change.
    queryOptionsCtx = {
      turnId,
      coreDirectory,
      effectivePath,
      effectiveThinkingEffort,
      modelConfig,
      getEffectiveModel,
      plan: providerRoutePlan,
      rawSystemPrompt: systemPrompt as string,
      finalSystemPrompt: finalSystemPrompt as string,
      recoveryMessages,
      turnHooks,
      mcpServers: mcpServers as QueryOptionsContext['mcpServers'],
      capabilityResolution,
      agentMcpSpecs,
      councilConfig,
      adHocConfig,
      claudeSubagentConfig,
      getProviderKeyEnv: () => routeSettings.exposeProviderKeysInShell
        ? (getProviderKeyEnvVars(routeSettings.providerKeys) ?? {})
        : {},
      permissionMode: getPermissionMode(settings) ?? 'bypassPermissions',
      knowledgeWorkerAgentName: KNOWLEDGE_WORKER_AGENT_NAME,
      knowledgeWorkerAgentDescription: KNOWLEDGE_WORKER_AGENT_DESCRIPTION,
      // Task-board surrender predicate for the approval-execution guard (FOX-2771 Stage 2).
      ...(hasPendingApprovalExecutions ? { hasPendingApprovalExecutions } : {}),
    };

    buildQueryOptions = () => {
      assertDispatchableQueryOptionsPlan(queryOptionsCtx.plan);
      return buildSdkQueryOptions(queryOptionsCtx);
    };
    queryOptions = buildQueryOptions();

    accumulator = {
      stage: 'runtime-ready',
      error: undefined,
      modelConfig,
      extendedContextEnabled,
      queryOptions,
      buildQueryOptions: (mc) => {
        if (mc) {
          modelConfig = mc;
          queryOptionsCtx.modelConfig = mc;
        }
        assertDispatchableQueryOptionsPlan(queryOptionsCtx.plan);
        return buildSdkQueryOptions(queryOptionsCtx);
      },
      // The outer let bindings `createPromptOrGenerator` and `routerContext`
      // are assigned later (~lines 2894 and 2977). The accumulator must be
      // built here so that errors in the intervening setup (Codex env logging,
      // MCP attach, attachment sanitisation) hit the `runtime-ready` catch arm.
      // Capture by closure (wrapper / getter), not property shorthand, so
      // recovery handlers see the real values when invoked from the catch path.
      createPromptOrGenerator: (cc?: string) => createPromptOrGenerator(cc),
      get routerContext() { return routerContext; },
      thinkingModelOverride,
      plan: providerRoutePlan,
      routeInput,
      routeRuntimeContextForDecision,
      applyRoutePlan: (plan) => {
        providerRoutePlan = plan;
        queryOptionsCtx.plan = plan;
      },
      activeProfile,
      isDirectRoleProfile,
      altModelFallbackAttempted,
      nestedFallbackQueryAttempted,
    };

    // Codex diagnostic: log the critical env vars that control proxy routing
    if (routeSettings.activeProvider === 'codex') {
      const envSnapshot = queryOptions.env ?? {};
      // Redact authorization/bearer values from custom headers before logging.
      // The raw value contains JWTs with email, account IDs, and session tokens.
      const rawHeaders = envSnapshot.ANTHROPIC_CUSTOM_HEADERS ?? '(not set)';
      const redactedHeaders = typeof rawHeaders === 'string'
        ? rawHeaders.replace(/(?:authorization|x-proxy-auth|x-api-key):\s*[^\n]+/gi, (match) => {
          const colonIdx = match.indexOf(':');
          return `${match.slice(0, colonIdx)}: ***REDACTED***`;
        })
        : rawHeaders;
      turnLogger.info({
        ANTHROPIC_BASE_URL: envSnapshot.ANTHROPIC_BASE_URL ?? '(not set)',
        ANTHROPIC_API_KEY_SET: !!envSnapshot.ANTHROPIC_API_KEY,
        ANTHROPIC_API_KEY_LENGTH: envSnapshot.ANTHROPIC_API_KEY?.length ?? 0,
        ANTHROPIC_CUSTOM_HEADERS: redactedHeaders,
        model: queryOptions.model,
        hasDirectExecutionClient: !!directExecutionClient,
        hasDirectPlanningClient: !!directPlanningClient,
      }, '[CODEX-DIAG] Query options env snapshot');
    }

    // Log sub-agent and MCP configuration for troubleshooting
    const registeredAgents = queryOptions.agents ? Object.keys(queryOptions.agents) : [];
    const queryMcpServers = queryOptions.mcpServers ? Object.keys(queryOptions.mcpServers) : [];
    turnLogger.info(
      {
        registeredAgents,
        agentCount: registeredAgents.length,
        hasSystemPrompt: typeof systemPrompt === 'string' && systemPrompt.trim().length > 0,
        systemPromptLength: typeof systemPrompt === 'string' ? systemPrompt.length : 0,
        // MCP servers being passed to agent query (Rebel's explicit config only, no settingSources merging)
        queryMcpServerCount: queryMcpServers.length,
        queryMcpServerNames: queryMcpServers,
        hasMcpServers: !!queryOptions.mcpServers,
        // MCP inheritance: which agents have mcpServers set
        agentMcpInheritance: queryOptions.agents
          ? Object.fromEntries(
              Object.entries(queryOptions.agents).map(([name, def]) => [
                name,
                ((def as AgentDefinition).mcpServers ?? []).length,
              ]),
            )
          : {},
      },
      'Agent query options - MCP configuration (agents inherit mcpServers)'
    );

    if (capabilityResolution.activeCapabilities.length > 0) {
      turnLogger.info(
        {
          activeCapabilities: capabilityResolution.activeCapabilities,
          disallowedTools: capabilityResolution.disallowedTools,
        },
        'MCP capabilities active — built-in tools suppressed'
      );
    }

    if (mcpMode === 'super-mcp') {
      const configLabel = resolvedMcpConfigPath
        ? ` (${path.basename(resolvedMcpConfigPath)})`
        : '';
      const upstreamLabel =
        upstreamServerCount > 0
          ? ` with ${upstreamServerCount} upstream server${upstreamServerCount === 1 ? '' : 's'}`
          : '';
      dispatchAgentEvent(win, turnId, {
        type: 'status',
        message: `Attaching Super-MCP router${configLabel}${upstreamLabel}...`,
        timestamp: Date.now(),
      });
      turnLogger.debug(
        { mcpMode, upstreamServerCount, resolvedMcpConfigPath },
        'Attaching Super-MCP router'
      );
    } else if (mcpMode === 'direct' && upstreamServerCount > 0) {
      dispatchAgentEvent(win, turnId, {
        type: 'status',
        message: `Attaching ${upstreamServerCount} MCP server${upstreamServerCount === 1 ? '' : 's'}...`,
        timestamp: Date.now(),
      });
      turnLogger.debug({ mcpMode, upstreamServerCount }, 'Attaching MCP servers');
    }

    // Use async generator for media attachments (required for streaming input mode)
    // Otherwise use string prompt for text-only turns (simpler, more efficient)
    // Note: Office, extracted PDF, and text file attachments are always appended to the text prompt (they're extracted text, not API content blocks)
    let basePromptForGenerator = appendOfficeAttachmentsToPrompt(
      effectivePrompt,
      officeAttachmentPayload,
      sourcePathMap
    );
    basePromptForGenerator = appendExtractedPdfAttachmentsToPrompt(
      basePromptForGenerator,
      extractedPdfAttachmentPayload,
      sourcePathMap
    );
    basePromptForGenerator = appendTextFileAttachmentsToPrompt(
      basePromptForGenerator,
      textFileAttachmentPayload,
      sourcePathMap
    );
    basePromptForGenerator = appendBinaryAttachmentsToPrompt(
      basePromptForGenerator,
      binaryAttachmentPayload,
      sourcePathMap
    );
    // Sanitize prompts to remove unpaired UTF-16 surrogates that would produce invalid JSON
    // This can happen when .slice() operations cut between emoji surrogate pairs
    const sanitizedBasePrompt = sanitizeSurrogates(basePromptForGenerator);
    const sanitizedPromptWithAttachments = sanitizeSurrogates(promptWithAttachments);
    
    // Assign factory function (declared in outer scope so catch block can access it).
    // IMPORTANT: Generators can only be consumed once, so retries need a fresh generator.
    // This factory is used by the OAuth→API key fallback to recreate the generator.
    createPromptOrGenerator = (conversationContext?: string): typeof promptOrGenerator => {
      const safeContext = conversationContext ? sanitizeSurrogates(conversationContext) : '';
      if (safeContext && hasMedia) {
        turnLogger.debug(
          { contextLength: safeContext.length },
          'Injecting conversation context into media generator prompt'
        );
      }
      return hasMedia
        ? createUserMessageGenerator(
            safeContext + sanitizedBasePrompt,
            textAttachmentPayload,
            imageAttachmentPayload,
            documentAttachmentPayload,
            sourcePathMap
          )
        : safeContext
          ? safeContext + sanitizedPromptWithAttachments
          : sanitizedPromptWithAttachments;
    };
    
    promptOrGenerator = createPromptOrGenerator();

    // REBEL-NA: Memory guard removed — os.freemem() is unreliable on macOS.
    // It reports only truly "free" pages, not reclaimable cache/inactive/purgeable pages.
    // macOS routinely shows < 200MB "free" on 32GB machines while having 36%+ actually
    // available. Any threshold causes false positives. The improved Sentry diagnostics
    // (memory data on ALL process_exit events) will help identify genuine OOM patterns
    // for a future platform-aware guard if needed.

    // REBEL-J1: Add spawn delay when concurrent turns are detected to reduce transport race conditions.
    // Concurrent startup can still race on shared resources; adding a short delay lets the first turn
    // stabilize before the next turn continues.
    // NOTE: getActiveTurnCount() includes THIS turn, so > 1 means other turns exist.
    const CONCURRENT_SPAWN_DELAY_MS = 750;
    const activeTurns = agentTurnRegistry.getActiveTurnCount();
    if (activeTurns > 1) {
      agentTurnRegistry.setTurnSpawnDelayed(turnId, true);
      turnLogger.info(
        { activeTurns, delayMs: CONCURRENT_SPAWN_DELAY_MS },
        'Concurrent turn detected - adding spawn delay to avoid runtime race condition'
      );
      const abortedDuringSpawnDelay = await delayWithAbort(CONCURRENT_SPAWN_DELAY_MS, abortController.signal);
      // Stale-turn guard (rework-F2): the pre-dispatch deadline aborts via the
      // SAME controller, so delayWithAbort returns aborted=true when the guard
      // fired. The guard already emitted the retryable terminal + ran cleanup —
      // bail silently instead of dispatching a duplicate user_stopped terminal.
      if (bailIfPreDispatchStale('concurrent-spawn-delay')) return;
      if (abortedDuringSpawnDelay) {
        turnLogger.info('Turn aborted during concurrent spawn delay');
        const spawnAbortReason = abortEndReason();
        if (spawnAbortReason !== 'superseded') {
          dispatchAgentEvent(win, turnId, {
            type: 'status',
            message: 'Agent turn stopped by user',
            timestamp: Date.now(),
          });
        }
        dispatchAgentEvent(win, turnId, makeSyntheticResult(turnId, '', spawnAbortReason));
        completeTurnCleanup(turnId, 'aborted', attemptEpoch);
        return;
      }
    }

    // If a recent turn hit a rate limit, wait for the cooldown to expire before
    // sending another request. This prevents concurrent turns from independently
    // retrying into the same rate-limited provider and exhausting the budget.
    // Skip cooldown when a rate-limit fallback retry is active — the cooldown was recorded
    // for the original (rate-limited) provider, not the fallback target.
    // Covers both provider overrides (OpenRouter/Anthropic) and tier-model fallbacks.
    // Stage 4b: also skip the global cooldown wait when a multi-provider failover
    // retry is in progress (routing to a different credential — its global cooldown
    // was not the one that fired). `rateLimitAttemptedCredentialSources` being
    // non-empty means we're on a retry hop; the global cooldown applies to the
    // original credential's provider, not the failover target.
    const isRateLimitFallbackRetry = !!turnOptions?.activeProviderOverride || !!turnOptions?.rateLimitFallbackAttempted
      || (turnOptions?.rateLimitAttemptedCredentialSources?.length ?? 0) > 0;
    const rateLimitWaitMs = isRateLimitFallbackRetry ? 0 : apiRateLimitCooldown.remainingMs();
    if (rateLimitWaitMs > 0) {
      turnLogger.info({ waitMs: rateLimitWaitMs }, 'Waiting for API rate-limit cooldown before starting query');
      dispatchAgentEvent(win, turnId, {
        type: 'status',
        message: `Rate limit active — waiting ${Math.ceil(rateLimitWaitMs / 1000)}s before retrying...`,
        timestamp: Date.now(),
      });
      const abortedDuringRateLimitWait = await delayWithAbort(rateLimitWaitMs, abortController.signal);
      // Stale-turn guard (rework-F2): same as the spawn delay above.
      if (bailIfPreDispatchStale('rate-limit-cooldown-wait')) return;
      if (abortedDuringRateLimitWait) {
        turnLogger.info('Turn aborted during rate-limit cooldown wait');
        completeTurnCleanup(turnId, 'aborted', attemptEpoch);
        return;
      }
    }

    const smState = superMcpHttpManager.getState();
    // Safe access: getPlatformConfig() throws if not initialised (e.g. in unit tests
    // that partially mock the executor). homePath/userDataPath are optional in the
    // router context — the agent runtime treats them as hints, not requirements.
    let platformHomePath: string | undefined;
    let platformUserDataPath: string | undefined;
    let platformSurfaceCapability: 'desktop' | 'cloud' = 'desktop';
    try {
      const pc = getPlatformConfig();
      platformHomePath = pc.homePath;
      platformUserDataPath = pc.userDataPath;
      platformSurfaceCapability = pc.surface === 'cloud' ? 'cloud' : 'desktop';
    } catch {
      // PlatformConfig not initialised — leave paths undefined
    }
    routerContext = {
      superMcpUrl: smState.isRunning ? smState.url : null,
      sessionId: rendererSessionId ?? undefined,
      ...(turnOptions?.origin ? { origin: turnOptions.origin } : {}),
      turnId,
      homePath: platformHomePath,
      userDataPath: platformUserDataPath,
      surfaceCapability: platformSurfaceCapability,
      wasExplicitCouncilIntent: councilModeEnabled,
      // The `<workspace>/rebel-system/` symlink resolves to the bundled
      // platform dir (dev: submodule clone; prod: process.resourcesPath).
      // Threading this path through allowedSymlinkTargets lets Read/Edit
      // succeed through the canonical workspace symlink — without it,
      // the agent can't load any SKILL.md or bundled prompt via the
      // standard path. Cloud/mobile do not create this symlink, so they
      // legitimately leave this undefined.
      rebelSystemRoot: getSystemSettingsPath(),
      captureRebelWindow: getScreenshotCaptureService()?.captureRebelWindow,
      navigateApp: getAppNavigationService()?.navigateApp,
      onFileChanged: (filePath: string) => {
        // Operator registry stale-card guard: when the agent writes an
        // OPERATOR.md (during Personalise or any other tool-driven edit),
        // invalidate the registry cache so the next list/get reflects the
        // freshly-written persona. Match by basename so any path shape
        // counts (`<space>/operators/<slug>/OPERATOR.md`).
        if (path.basename(filePath) === 'OPERATOR.md') {
          try {
            invalidateOperatorRegistry();
          } catch (err) {
            turnLogger.warn(
              { err: err instanceof Error ? err.message : String(err), filePath },
              'operators:registry_invalidate_after_agent_write_failed',
            );
          }
        }

        // Route through the single source-aware chokepoint. The 'user'
        // (synchronous leading-edge) path emits immediately with no debounce
        // and normalizes the workspace-relative path itself, producing a
        // byte-identical payload to the previous direct emit.
        libraryBroadcaster.broadcast({
          affectsTree: false,
          writerKind: 'agent',
          changedPath: filePath,
        }, 'user');
      },
      getCacheAgeMs: () => {
        const lastCall = getLastApiCallTime();
        return lastCall ? Date.now() - lastCall : Infinity;
      },
      getLatestSuperMcpUrl: () => {
        const currentState = superMcpHttpManager.getState();
        return currentState.isRunning ? currentState.url : null;
      },
      onMcpError: (info: McpErrorInfo) => {
        try {
          if (info.requestSignalAborted === true) {
            turnLogger.debug(
              {
                operation: info.operation,
                toolName: info.toolName,
                errorKind: info.errorKind,
                code: info.code,
              },
              'Suppressing MCP telemetry for locally aborted request signal',
            );
            return;
          }

          const sanitizedData = info.data ? stripUserValues(info.data) : undefined;
          const truncatedData = sanitizedData ? safeStringifyForTelemetry(sanitizedData, 1000) : undefined;
          const mcpToolTag = info.toolName
            ? info.toolName.toLowerCase().replace(/[^a-z0-9_.:-]/g, '_').slice(0, 48)
            : undefined;
          const extraTags = {
            ...(info.errorKind && { mcp_error_kind: info.errorKind }),
            ...(mcpToolTag && { mcp_tool: mcpToolTag }),
          };
          const fingerprintDiscriminators = [
            info.errorKind ? `kind:${info.errorKind}` : null,
            info.code !== undefined ? `code:${info.code}` : null,
          ].filter((entry): entry is string => Boolean(entry));
          // Use clean Error to avoid Sentry auto-serializing raw error.data (may contain user values).
          // Prefix errorKind onto the message so Sentry breadcrumbs are scannable
          // before drilling into extras.
          const kindPrefix = info.errorKind ? `[${info.errorKind}] ` : '';
          const cleanError = new Error(`${kindPrefix}${info.message}`);
          reportMcpError(cleanError, info.operation, {
            level: 'warning',
            ...(Object.keys(extraTags).length > 0 && { extraTags }),
            ...(fingerprintDiscriminators.length > 0 && { fingerprintDiscriminators }),
            extra: {
              toolName: info.toolName,
              code: info.code,
              ...(info.toolUseId && { toolUseId: info.toolUseId }),
              ...(info.callGeneration !== undefined && { callGeneration: info.callGeneration }),
              ...(info.sessionGeneration !== undefined && { sessionGeneration: info.sessionGeneration }),
              ...(info.mcpSessionId && { mcpSessionId: info.mcpSessionId }),
              ...(info.connectionAgeMs !== undefined && { connectionAgeMs: info.connectionAgeMs }),
              ...(info.lastTransportSeverance && { lastTransportSeverance: info.lastTransportSeverance }),
              ...(truncatedData && { data: truncatedData }),
            },
          });
        } catch {
          // telemetry must not break the turn
        }
      },
      onStreamActivity: (event: RuntimeActivityEvent) => {
        const activityNow = Date.now();
        rawStreamTracker.lastActivity = event;
        rawStreamTracker.lastEventType = serializeRuntimeActivityForTelemetry(event);
        rawStreamTracker.lastTimestamp = activityNow;
        rawStreamTracker.eventCount++;
        // Stage 3a: record the first genuine stream byte/token timestamp once,
        // so the stall telemetry can report time-to-first-token. Only real
        // upstream activity counts here — the synthetic terminal-lifecycle
        // activity (recordTerminalLifecycleActivity) is deliberately NOT
        // first-token data.
        if (rawStreamTracker.firstActivityTimestamp === null) {
          rawStreamTracker.firstActivityTimestamp = activityNow;
        }
      },
      onToolDispatch: (toolUseId: string, controller: AbortController) => {
        activeChildACByToolUseId.set(toolUseId, controller);
      },
      onToolSettle: (toolUseId: string) => {
        activeChildACByToolUseId.delete(toolUseId);
        clearToolCancelGraceTimer(toolUseId);
      },
      executionClient: directExecutionClient,
      planningClient: directPlanningClient,
      // Propagate actual model names so rebelCoreQuery uses them instead of Claude env var names.
      // Only set when a direct client is injected — otherwise resolveRuntimeModels() names are correct.
      executionModelOverride: directExecutionClient ? activeProfileRoutingModel : undefined,
      planningModelOverride: directPlanningClient ? (directPlanningRoutingModel ?? thinkingProfileRoutingModel) : undefined,
      // Stage 8: per-conversation working-model override gates Smart picking off for the turn.
      // True ONLY when the user explicitly picked a model/profile for this turn — not for users
      // on a default working profile that happens to use a direct execution client.
      perConversationModelOverride: derivePerConversationModelOverride(
        turnOptions,
        configuredWorkingProfile,
      ),
      // Propagate Codex mode so fallback/subagent client creation can route through Codex
      codexMode: turnCodexMode,
      connectivity: profileConnectivity,
    };
    // Store planning model in turn registry for result event emission.
    if (routerContext?.planningModelOverride) {
      agentTurnRegistry.setTurnPlanningModel(turnId, routerContext.planningModelOverride);
    } else if (modelConfig.envOverrides?.[ENV_THINKING_MODEL]) {
      agentTurnRegistry.setTurnPlanningModel(turnId, modelConfig.envOverrides[ENV_THINKING_MODEL] as string);
    }

    // Author the GLOBAL Behind-the-Scenes (`background`) role so the result event can surface the model BTS
    // calls will actually run (Turn Usage tooltip — Q2, docs/plans/260601_diagnose-model-tier-tooltip/PLAN.md).
    // Use the runtime role resolver (NOT raw `resolveBtsModel`, which returns the ENCODED `profile:`/`model:`
    // string): `resolveDefaultModelForRole('background', ...)` decodes profile refs to the underlying model and
    // applies the DEFAULT_AUXILIARY_MODEL fallback, so the displayed id is the bare model that will run — never
    // a `profile:`/`model:` codec string. On a typed failure (broken/disconnected profile config) we omit the
    // row rather than display a broken value. Honest ceiling: a runtime provider remap / structured-output or
    // operational fallback INSIDE a BTS call can still diverge — not knowable at setup, and no BTS usage record
    // exists to reconcile against (that's the deferred Tier B; tokens/spend remain out of scope).
    const fastRole = resolveDefaultModelForRole('background', settings, availableProfiles);
    if (fastRole.ok) {
      agentTurnRegistry.setTurnFastModel(turnId, fastRole.model);
    }

    // Final stale-turn chokepoint (F4): this is the single point every
    // successful pre-dispatch path passes through before the model is dispatched.
    // If the pre-dispatch deadline fired ANYWHERE in the window (incl. awaits
    // between abort-checkpoint-3 and here — provider routing / proxy addRoutes —
    // that have no dedicated bail), the turn was already terminated + cleaned up;
    // abandon this resumed continuation rather than arming the watchdog and
    // dispatching a model call on a torn-down turn.
    if (bailIfPreDispatchStale('pre-watchdog-arm')) return;
    // Pre-dispatch window is over — the agent-silence watchdog (below) now owns
    // liveness through model dispatch and streaming. Disarm the coarse
    // pre-dispatch deadline so it can't fire during a legitimately long model
    // response (260619_turn-hang-bugmode Stage 2).
    clearPreDispatchGuard();

    // Agent silence watchdog: delegates to WatchdogTracker for threshold evaluation and state.
    // Orchestration (Sentry, UI dispatch, abort, approval checks) stays here.
    const NO_OUTPUT_TIMEOUT_MS = 30_000; // 30 seconds (used in Sentry diagnostics)
    const SUBAGENT_NO_OUTPUT_TIMEOUT_MS = 120_000; // 120 seconds when subagent (Task) is active (FOX-2810)
    const WATCHDOG_CHECK_INTERVAL_MS = 10_000; // Check every 10 seconds
    
    watchdogInterval = setInterval(() => {
      if (abortController.signal.aborted) return;

      const now = Date.now();
      const elapsedTurnMs = now - turnStartedAt;
      const activityAgeMs = getLastActivityAgeMs();
      const upstreamActivity = agentTurnRegistry.getUpstreamActivity(turnId);
      const hasActiveToolExecution = hasRuntimeToolInFlight();
      const hasActiveWorkBeforeCheck = hasActiveToolExecution || watchdog.hasActiveSubagent;
      const watchdogOverrideCeilingMs = staticWatchdogCeilingMs !== undefined
        && staticWatchdogCeilingMs > (hasActiveWorkBeforeCheck ? (extendedCeilingMs ?? AUTO_ABORT_MS) : STREAMING_STALL_ABORT_MS)
        ? staticWatchdogCeilingMs
        : (hasActiveWorkBeforeCheck ? (extendedCeilingMs ?? AUTO_ABORT_MS) : undefined);
      const result = watchdog.check(
        now,
        true,
        activityAgeMs,
        watchdogOverrideCeilingMs,
      );

      // Check if we're waiting for user approval BEFORE dispatching status or auto-aborting.
      // This prevents misleading "Stopping automatically" messages during approval waits.
      // Note: We use turn-scoped checks to avoid false positives from other turns' approvals.
      // Exception: automation sessions run headlessly — no user can approve, so the watchdog
      // must still be able to abort to prevent indefinite hangs.
      const pendingToolApprovals = getPendingApprovals().filter(p => p.turnId === turnId);
      const pendingMemoryApprovals = getPendingMemoryApprovals().filter(p => p.turnId === turnId);
      const isWaitingForUser = pendingToolApprovals.length > 0 || pendingMemoryApprovals.length > 0;
      const skippedForApprovalWait = applyWatchdogApprovalWaitCommitGate({
        watchdog,
        checkResult: result,
        now,
        isWaitingForUser,
        watchdogAbortsDuringApprovalWait: effectivePolicy.watchdogAbortsDuringApprovalWait,
      });

      if (skippedForApprovalWait) {
        turnLogger.info(
          { 
            pendingToolApprovals: pendingToolApprovals.length, 
            pendingMemoryApprovals: pendingMemoryApprovals.length,
            silentMs: result.silentMs,
            level: result.level,
          },
          'Watchdog triggered but waiting for user approval - skipping status/abort/Sentry'
        );
        return;
      }

      // Destructure check result for logging/Sentry context
      const { phase, silentMs, level: newLevel, hasActiveSubagent, activeSubagentCount } = result;
      const activeTool = getOldestActiveTool();
      const baseCeilingMs = (hasActiveToolExecution || hasActiveSubagent)
        ? AUTO_ABORT_MS
        : STREAMING_STALL_ABORT_MS;
      const ceilingResolution = resolveWatchdogJudgeCeiling({
        state: {
          extendedCeilingMs,
          priorExtensionCount,
          consecutiveFailOpenCount,
          boundToolUseId: extensionBoundToolUseId,
          boundToolName: extensionBoundToolName,
          boundHasActiveSubagent: extensionBoundHasActiveSubagent,
        },
        baseCeilingMs,
        activeToolUseId: activeTool?.toolUseId,
        activeToolName: activeTool?.name ?? watchdog.lastToolName,
        hasActiveSubagent,
      });
      extendedCeilingMs = ceilingResolution.state.extendedCeilingMs;
      extensionBoundToolUseId = ceilingResolution.state.boundToolUseId;
      extensionBoundToolName = ceilingResolution.state.boundToolName;
      extensionBoundHasActiveSubagent = ceilingResolution.state.boundHasActiveSubagent;
      const effectiveAbortMs = staticWatchdogCeilingMs !== undefined
        && staticWatchdogCeilingMs > ceilingResolution.effectiveCeilingMs
        ? staticWatchdogCeilingMs
        : ceilingResolution.effectiveCeilingMs;
      const isToolInFlight = hasActiveToolExecution;
      const isComplexTurn = extendedContextEnabled || messageCount > 500;
      const isAwaitingFirstResponse = phase === 'awaiting_api';
      const elapsedSeconds = Math.round(silentMs / 1000);
      const thresholds = hasActiveSubagent ? WATCHDOG_THRESHOLDS_SUBAGENT : WATCHDOG_THRESHOLDS;
      // For level-6 (auto-abort), use the per-tick effectiveAbortMs from the result so
      // the logged threshold reflects the active phase (streaming-stall vs tool-in-flight)
      // and any judge-applied extension; AUTO_ABORT_MS is just the raw constant.
      const threshold = newLevel <= thresholds.length ? thresholds[newLevel - 1] : effectiveAbortMs;
      const abortByWatchdog = (
        reason: WatchdogAutomationAbortReason,
        autoAbortMs: number,
        opts?: { isAutomationHardCap?: boolean },
      ): void => {
        abortedByWatchdog = true;
        watchdogAbortReason = reason;
        watchdogAutoAbortMs = autoAbortMs;
        watchdogAbortIsAutomationHardCap = opts?.isAutomationHardCap === true;
        watchdogAbortElapsedSinceTurnStartMs = elapsedTurnMs;
        const toolInFlightMs = watchdog.toolInFlightSince ? now - watchdog.toolInFlightSince : undefined;
        turnLogger.error(
          { silentMs, level: newLevel, phase, lastMessageType: watchdog.lastMessageType, lastToolName: watchdog.lastToolName, messageCount, mcpMode, autoAbortMs: watchdogAutoAbortMs, toolInFlightMs, isToolInFlight, isComplexTurn, isAwaitingFirstResponse, hasActiveSubagent, activeSubagentCount, upstreamActivity, rawStreamLastEvent: rawStreamTracker.lastEventType, rawStreamLastEventAgeMs: rawStreamTracker.lastTimestamp !== null ? now - rawStreamTracker.lastTimestamp : null, rawStreamEventCount: rawStreamTracker.eventCount, watchdogAbortReason: reason },
          `Watchdog auto-aborting turn after ${Math.round(watchdogAutoAbortMs / 1000)}s of silence (REBEL-NQ)`
        );
        // Registry-owned warning capture (260610 improve-sentry-noise Stage 2).
        captureWatchdogAutoAbort({
          silentMs,
          phase,
          mcpMode,
          lastMessageType: watchdog.lastMessageType,
          lastToolName: watchdog.lastToolName,
          messageCount,
          model: agentTurnRegistry.getTurnModel(turnId),
          extendedContext: agentTurnRegistry.getTurnExtendedContext(turnId),
          autoAbortMs: watchdogAutoAbortMs,
          toolInFlightMs,
          isToolInFlight,
          isComplexTurn,
          isAwaitingFirstResponse,
          hasActiveSubagent,
          activeSubagentCount,
          upstreamActivity,
          rawStreamLastEvent: rawStreamTracker.lastEventType,
          rawStreamLastEventAgeMs: rawStreamTracker.lastTimestamp !== null ? now - rawStreamTracker.lastTimestamp : null,
          rawStreamEventCount: rawStreamTracker.eventCount,
          watchdogAbortReason: reason,
        });
        abortController.abort();
        const WATCHDOG_FORCE_KILL_DELAY_MS = 10_000;
        setTimeout(() => {
          const closeCallback = agentTurnRegistry.getTurnCloseCallback(turnId);
          if (closeCallback) {
            try {
              turnLogger.warn('Watchdog force-killing via Query.close() after abort timeout');
              closeCallback();
            } catch { /* ignore */ }
          }
        }, WATCHDOG_FORCE_KILL_DELAY_MS);
      };
      abortByWatchdogForToolCancel = (reason, autoAbortMs) => {
        abortByWatchdog(reason, autoAbortMs);
      };

      const watchdogHardCeilingMs = effectivePolicy.watchdogHardCeilingMs;
      if (
        watchdogHardCeilingMs !== null
        && shouldAbortForAutomationHardCeiling(watchdogHardCeilingMs, elapsedTurnMs)
      ) {
        abortByWatchdog('watchdog', watchdogHardCeilingMs, { isAutomationHardCap: true });
        return;
      }

      // Stage 1a (260617_bricked-state-0448-electron42): earlier, INTERACTIVE-only
      // ceiling for an `awaiting_api` stall (request sent to the provider, no first
      // token / stream byte received). The 10-min `STREAMING_STALL_ABORT_MS` ceiling
      // is far too long for the "send a prompt, nothing comes back" symptom; this
      // ends the turn at a conservative 5-min ceiling as a recognised retryable
      // `message_timeout` terminal (dispatched below / and on the AbortError catch
      // path via handleAbortErrors) so the user gets a clean "Try again".
      // Interactive gate = `origin === 'manual'`, which is interactive + cli +
      // mcp_server (TurnPolicy.origin is only 'manual' | 'automation'; cli and
      // mcp_server resolve to 'manual' — see turnPolicy.ts). That's the right call:
      // a stalled cli/mcp_server turn also ends cleanly + retryably at 5 min rather
      // than dangling to 10. ONLY `origin === 'automation'` is excluded — it keeps
      // the 10-min streaming ceiling + 90-min hard cap, since there is no user to
      // retry. Gated on the SAME no-raw-stream-activity signal as the level-1
      // capture gate so a producing turn never trips it. Placed AFTER the
      // approval-wait gate (which returns early) so an interactive approval wait
      // can't trip it. One-shot: `abortByWatchdog` flips `abortController.signal.aborted`,
      // and the tick's leading guard (`if (abortController.signal.aborted) return`)
      // prevents re-entry.
      //
      // DELIBERATELY pre-empts judge auto-extension (the `shouldAutoExtend` block
      // below). This is intentional, not an oversight: (1) judge auto-extension was
      // already INERT for awaiting_api — `shouldAutoExtend` Gate 1 would set
      // `extendedCeilingMs`, but that ceiling only takes effect when
      // `baseCeilingMs === AUTO_ABORT_MS` (a tool/subagent in flight; see
      // `resolveWatchdogJudgeCeiling`'s `extensionApplies`), and an awaiting_api
      // stall has neither — so before this change the turn still aborted at the 600s
      // streaming ceiling while emitting a misleading `auto_extended` diagnostic each
      // tick; (2) the watchdog judge itself never fires for awaiting_api
      // (`shouldFireWatchdogJudge` returns false when `baseCeilingMs !== AUTO_ABORT_MS`).
      // A 5-min no-first-token stall isn't producing anything, so a clean retryable
      // terminal that lets the user retry beats prolonging a frozen spinner with an
      // LLM-judge round-trip that wouldn't move the effective ceiling anyway.
      const isInteractiveTurn = effectivePolicy.origin === 'manual';
      const hasRawStreamActivity = shouldSuppressLevel1WatchdogCapture(rawStreamTracker.lastActivity);

      // Stage 1b (260617_bricked-state-0448-electron42): SOFT, NON-DESTRUCTIVE
      // "still waiting" affordance. Fires at the earlier ~30s soft threshold
      // (well before the 5-min hard ceiling above) and is NOT terminal — it only
      // dispatches a one-shot `status` event carrying an optional `stall` marker
      // so the renderer can surface an early calm "this is taking longer than
      // usual / Try again / Stop" affordance (State B) while the spinner keeps
      // running. Same interactive + no-raw-stream-activity + awaiting_api gate as
      // the hard stall, so it can NEVER fire while a turn is producing tokens.
      // One-shot per stall episode (`awaitingApiSoftStallDispatched`); reset on
      // activity-resume in the `watchdog.onMessage` levelWasReset path so a turn
      // that resumes and re-stalls can re-surface. Placed BEFORE the hard check:
      // the hard check `return`s when it trips, but the soft dispatch falls
      // through so the rest of the tick (level status / judge / auto-extend) runs
      // exactly as before — the soft surface is purely additive.
      if (
        !awaitingApiSoftStallDispatched &&
        isAwaitingApiSoftStall({
          phase,
          silentMs,
          hasRawStreamActivity,
          interactive: isInteractiveTurn,
        })
      ) {
        awaitingApiSoftStallDispatched = true;
        turnLogger.info(
          { silentMs, phase, threshold: AWAITING_API_SOFT_STALL_MS, lastMessageType: watchdog.lastMessageType, messageCount, rawStreamEventCount: rawStreamTracker.eventCount },
          'Watchdog: interactive awaiting_api soft stall — surfacing non-destructive "still waiting" affordance',
        );
        try {
          dispatchAgentEvent(win, turnId, {
            type: 'status',
            message: AWAITING_API_SOFT_STALL_MESSAGE,
            timestamp: now,
            stall: { phase: 'awaiting_api', sinceMs: silentMs },
          });
        } catch (dispatchErr) {
          turnLogger.warn({ err: dispatchErr }, 'Failed to dispatch awaiting_api soft-stall status event');
        }
      }

      if (
        isAwaitingApiHardStall({
          phase,
          silentMs,
          hasRawStreamActivity,
          interactive: isInteractiveTurn,
        })
      ) {
        abortedByAwaitingApiStall = true;
        turnLogger.warn(
          { silentMs, phase, threshold: AWAITING_API_STALL_ABORT_MS, lastMessageType: watchdog.lastMessageType, messageCount, rawStreamEventCount: rawStreamTracker.eventCount },
          'Watchdog: interactive awaiting_api hard stall — ending turn as retryable message_timeout',
        );
        abortByWatchdog('watchdog', AWAITING_API_STALL_ABORT_MS);
        return;
      }

      const autoExtend = shouldAutoExtend({
        priorExtensionCount,
        hasActiveSubagent: extensionBoundHasActiveSubagent || hasActiveSubagent,
        silentMs,
      });

      if (autoExtend.extend) {
        const priorExtensionCountBeforeAutoExtend = priorExtensionCount;
        const autoExtendToolName = activeTool?.name ?? watchdog.lastToolName;
        extendedCeilingMs = (extendedCeilingMs ?? AUTO_ABORT_MS) + autoExtend.additionalMs;
        priorExtensionCount += 1;
        consecutiveFailOpenCount = 0;
        extensionBoundToolUseId = activeTool?.toolUseId;
        extensionBoundToolName = autoExtendToolName;
        extensionBoundHasActiveSubagent = extensionBoundHasActiveSubagent || hasActiveSubagent;

        appendDiagnosticEvent({
          kind: 'watchdog_judge_decision',
          data: {
            decision: 'auto_extended',
            additionalMs: autoExtend.additionalMs,
            reason: autoExtend.reason,
            priorExtensionCount: priorExtensionCountBeforeAutoExtend,
            elapsedMs: elapsedTurnMs,
            silentMs,
            ...(autoExtendToolName ? { toolName: autoExtendToolName } : {}),
          },
        });

        turnLogger.info(
          {
            reason: autoExtend.reason,
            additionalMs: autoExtend.additionalMs,
            priorExtensionCount: priorExtensionCountBeforeAutoExtend,
            elapsedMs: elapsedTurnMs,
            silentMs,
            toolName: autoExtendToolName,
          },
          'Watchdog auto-extended turn without judge call',
        );
        return;
      }

      if (shouldFireWatchdogJudge({
        baseCeilingMs,
        effectiveCeilingMs: effectiveAbortMs,
        silentMs,
        judgeInFlight,
      })) {
        judgeInFlight = true;
        const judgeElapsedMs = elapsedTurnMs;
        const judgeSilentMs = silentMs;
        const judgeToolUseId = activeTool?.toolUseId;
        const judgeToolName = activeTool?.name ?? watchdog.lastToolName;
        const judgeHasActiveSubagent = hasActiveSubagent;
        const judgeToolInput = activeTool?.input;
        const judgePriorExtensionCount = priorExtensionCount;
        turnLogger.debug({
          elapsedMs: judgeElapsedMs,
          silentMs: judgeSilentMs,
          toolName: judgeToolName,
          hasActiveSubagent: judgeHasActiveSubagent,
          priorExtensionCount: judgePriorExtensionCount,
        }, 'Watchdog judge firing');
        dispatchAgentEvent(win, turnId, {
          type: 'status',
          message: 'Still working on this — running a quick time check…',
          timestamp: Date.now(),
        });
        void (async () => {
          const judgeInput = buildJudgeInput({
            turnId,
            sessionId: rendererSessionId ?? undefined,
            userPrompt: prompt,
            toolName: judgeToolName,
            toolInput: judgeToolInput,
            completedToolsThisTurn,
            elapsedMs: judgeElapsedMs,
            silentMs: judgeSilentMs,
            rawStreamLastEventType: rawStreamTracker.lastEventType,
            rawStreamLastEventAgeMs: rawStreamTracker.lastTimestamp !== null ? now - rawStreamTracker.lastTimestamp : null,
            priorExtensionCount: judgePriorExtensionCount,
            hasActiveSubagent: judgeHasActiveSubagent,
            isAutomation: effectivePolicy.watchdogHardCeilingMs !== null,
            remainingAutomationBudgetMs: effectivePolicy.watchdogHardCeilingMs
              ? Math.max(effectivePolicy.watchdogHardCeilingMs - judgeElapsedMs, 0)
              : undefined,
          });

          const judgeResult = await judgeWatchdog(
            settings,
            judgeInput,
            agentTurnRegistry.getTurnAuthMethod(turnId) ?? 'unknown',
            { signal: abortController.signal },
          );

          if (!shouldApplyWatchdogJudgeResolution(abortController.signal, turnCompleted)) {
            turnLogger.debug(
              { aborted: abortController.signal.aborted, turnCompleted },
              'Watchdog judge result ignored — turn already aborted or completed',
            );
            return;
          }

          const boundToolController = judgeToolUseId !== undefined
            ? activeChildACByToolUseId.get(judgeToolUseId)
            : undefined;
          const boundToolStillActive = boundToolController !== undefined
            && !boundToolController.signal.aborted;

          if (judgeToolUseId !== undefined && !boundToolStillActive) {
            turnLogger.info(
              { boundToolUseId: judgeToolUseId, decision: judgeResult.kind },
              'Watchdog judge decision stale — bound tool already resolved',
            );
            appendDiagnosticEvent({
              kind: 'judge_decision_stale_skip',
              data: {
                boundToolUseId: judgeToolUseId,
                decision: judgeResult.kind,
              },
            });
            return;
          }

          const injectionDisposition = resolveWatchdogJudgeInjectionDisposition({
            judgeResult,
            priorExtensionCount: judgePriorExtensionCount,
            consecutiveFailOpenCount,
            extendedCeilingMs,
            elapsedMs: judgeElapsedMs,
            silentMs: judgeSilentMs,
            toolName: judgeToolName,
          });

          if (judgeResult.kind === 'extend' && injectionDisposition.level !== 'none') {
            turnLogger.warn(
              {
                level: injectionDisposition.level,
                reasonPreview: redactForLog(judgeResult.reason),
              },
              'Judge response shows injection-pattern suspicion (extend) — telemetry only',
            );
          } else if (judgeResult.kind === 'kill' && injectionDisposition.override) {
            turnLogger.error(
              { reasonPreview: redactForLog(judgeResult.reason) },
              'Judge response triggers injection-suspicion override — forcing fail-open extend instead of kill',
            );
            const overrideApplyResult = applyWatchdogJudgeInjectionOverride({
              state: {
                extendedCeilingMs,
                priorExtensionCount,
                consecutiveFailOpenCount,
                boundToolUseId: extensionBoundToolUseId,
                boundToolName: extensionBoundToolName,
                boundHasActiveSubagent: extensionBoundHasActiveSubagent,
              },
              disposition: injectionDisposition,
            });
            extendedCeilingMs = overrideApplyResult.state.extendedCeilingMs;
            priorExtensionCount = overrideApplyResult.state.priorExtensionCount;
            consecutiveFailOpenCount = overrideApplyResult.state.consecutiveFailOpenCount;
            extensionBoundToolUseId = overrideApplyResult.state.boundToolUseId;
            extensionBoundToolName = overrideApplyResult.state.boundToolName;
            extensionBoundHasActiveSubagent = overrideApplyResult.state.boundHasActiveSubagent;

            if (overrideApplyResult.decisionDiagnostic) {
              appendDiagnosticEvent({
                kind: 'watchdog_judge_decision',
                data: overrideApplyResult.decisionDiagnostic,
              });
            }

            if (overrideApplyResult.killReason === 'consecutive_fail_open_cap') {
              turnLogger.error(
                {
                  consecutiveFailOpenCount: overrideApplyResult.state.consecutiveFailOpenCount,
                  elapsedMs: judgeElapsedMs,
                  silentMs: judgeSilentMs,
                  toolName: judgeToolName,
                },
                'Watchdog judge injection override fail-open cap reached — killing turn',
              );
              abortByWatchdog('consecutive_fail_open_cap', effectiveAbortMs);
              return;
            }
            return;
          } else if (judgeResult.kind === 'kill' && injectionDisposition.level === 'warn') {
            turnLogger.warn(
              { reasonPreview: redactForLog(judgeResult.reason) },
              'Judge response shows injection-pattern suspicion (kill) — proceeding but capturing telemetry',
            );
          }

          const judgeApplyResult = applyWatchdogJudgeResult({
            state: {
              extendedCeilingMs,
              priorExtensionCount,
              consecutiveFailOpenCount,
              boundToolUseId: extensionBoundToolUseId,
              boundToolName: extensionBoundToolName,
              boundHasActiveSubagent: extensionBoundHasActiveSubagent,
            },
            judgeResult,
            extensionBaseMs: judgeSilentMs,
            elapsedMs: judgeElapsedMs,
            silentMs: judgeSilentMs,
            toolName: judgeToolName,
            boundToolUseId: judgeToolUseId,
            boundHasActiveSubagent: judgeHasActiveSubagent,
            injectionSuspected: injectionDisposition.level,
          });

          extendedCeilingMs = judgeApplyResult.state.extendedCeilingMs;
          priorExtensionCount = judgeApplyResult.state.priorExtensionCount;
          consecutiveFailOpenCount = judgeApplyResult.state.consecutiveFailOpenCount;
          extensionBoundToolUseId = judgeApplyResult.state.boundToolUseId;
          extensionBoundToolName = judgeApplyResult.state.boundToolName;
          extensionBoundHasActiveSubagent = judgeApplyResult.state.boundHasActiveSubagent;

          if (judgeApplyResult.decisionDiagnostic) {
            appendDiagnosticEvent({
              kind: 'watchdog_judge_decision',
              data: judgeApplyResult.decisionDiagnostic,
            });
            const decision = judgeApplyResult.decisionDiagnostic.decision;
            const logFields = {
              decision,
              additionalMs: judgeApplyResult.decisionDiagnostic.additionalMs,
              cause: judgeApplyResult.decisionDiagnostic.cause,
              reason: judgeApplyResult.decisionDiagnostic.reason,
              injectionSuspected: judgeApplyResult.decisionDiagnostic.injectionSuspected,
              priorExtensionCount: judgeApplyResult.decisionDiagnostic.priorExtensionCount,
              elapsedMs: judgeApplyResult.decisionDiagnostic.elapsedMs,
              silentMs: judgeApplyResult.decisionDiagnostic.silentMs,
              toolName: judgeApplyResult.decisionDiagnostic.toolName,
              errorMessage: judgeApplyResult.decisionDiagnostic.errorMessage,
            };
            if (decision === 'extended') {
              turnLogger.info(logFields, 'Watchdog judge extended turn');
              const additionalMs = judgeApplyResult.decisionDiagnostic.additionalMs ?? 15 * 60_000;
              const nMinutes = Math.round(additionalMs / 60_000);
              let message = `Looks like genuine progress. Continuing for another ${nMinutes} minutes.`;
              if (effectivePolicy.watchdogHardCeilingMs !== null) {
                const mMinutes = Math.round(Math.max(effectivePolicy.watchdogHardCeilingMs - judgeElapsedMs, 0) / 60_000);
                message = `Continuing for another ${nMinutes} minutes (automation budget: ${mMinutes} minutes left).`;
              }
              dispatchAgentEvent(win, turnId, {
                type: 'status',
                message,
                timestamp: Date.now(),
              });
            } else if (decision === 'failed_extended') {
              turnLogger.warn(logFields, 'Watchdog judge failed — falling back to default extension');
              dispatchAgentEvent(win, turnId, {
                type: 'status',
                message: 'Time check didn\'t come back. Granting another 10 minutes anyway — you can stop at any time.',
                timestamp: Date.now(),
              });
            }
          }

          if (judgeApplyResult.killReason === 'judge_killed') {
            turnLogger.warn({
              elapsedMs: judgeElapsedMs,
              silentMs: judgeSilentMs,
              toolName: judgeToolName,
              priorExtensionCount: judgePriorExtensionCount,
            }, 'Watchdog judge decided to kill turn');
          } else if (judgeApplyResult.killReason === 'consecutive_fail_open_cap') {
            turnLogger.error({
              consecutiveFailOpenCount: judgeApplyResult.state.consecutiveFailOpenCount,
              elapsedMs: judgeElapsedMs,
              silentMs: judgeSilentMs,
              toolName: judgeToolName,
            }, 'Watchdog judge fail-open cap reached — killing turn');
          }

          if (judgeApplyResult.killReason) {
            if (judgeApplyResult.killReason === 'judge_killed' && judgeToolUseId !== undefined && boundToolStillActive) {
              const cancelOutcome = cancelActiveToolForWatchdog({
                toolUseId: judgeToolUseId,
                toolName: judgeToolName,
                judgeReason: judgeResult.kind === 'kill' ? judgeResult.reason : judgeApplyResult.killReason,
                silentMs: judgeSilentMs,
                elapsedMs: judgeElapsedMs,
                effectiveAbortMs,
                injectionSuspected: injectionDisposition.level,
              });
              if (cancelOutcome === 'cancelled') {
                return;
              }
              if (cancelOutcome === 'cap') {
                abortByWatchdog('tool_cancelled_cap', effectiveAbortMs);
                return;
              }
            }
            abortByWatchdog(judgeApplyResult.killReason, effectiveAbortMs);
          }
        })()
          .catch((judgeError) => {
            turnLogger.warn({ err: judgeError }, 'Unexpected error while applying watchdog judge result');
          })
          .finally(() => {
            judgeInFlight = false;
          });
      }

      // F1: status side effects are independent from judge firing.
      if (!shouldEmitWatchdogEscalationSideEffects(result.escalated)) {
        if (silentMs >= effectiveAbortMs) {
          abortByWatchdog('watchdog', effectiveAbortMs);
        }
        return;
      }

      // Log each level transition
      turnLogger.warn(
        { silentMs, threshold, level: newLevel, phase, lastMessageType: watchdog.lastMessageType, lastToolName: watchdog.lastToolName, messageCount, mcpMode, isToolInFlight, isComplexTurn, isAwaitingFirstResponse, hasActiveSubagent, activeSubagentCount, upstreamActivity, rawStreamLastEvent: rawStreamTracker.lastEventType, rawStreamLastEventAgeMs: rawStreamTracker.lastTimestamp !== null ? now - rawStreamTracker.lastTimestamp : null, rawStreamEventCount: rawStreamTracker.eventCount },
        `Agent turn watchdog: Level ${newLevel} stall detected`
      );

      // Dispatch progressive status message to renderer
      try {
        const message = getWatchdogMessage(newLevel, phase, elapsedSeconds, effectiveAbortMs);
        dispatchAgentEvent(win, turnId, {
          type: 'status',
          message,
          timestamp: now,
        });
      } catch (dispatchErr) {
        turnLogger.warn({ err: dispatchErr }, 'Failed to dispatch watchdog status event');
      }

      // FOX-3251: At Level 4 (5 min silence) for genuinely stalled Anthropic-
      // routed streams (no tool/subagent running, not currently aborted), kick
      // off the timeout diagnostic probes early. The result is surfaced as a
      // follow-up status event so users see "Anthropic is degraded" / "internet
      // is offline" / "stream stalled but everything looks healthy" 5 min
      // sooner — without changing the abort thresholds or watchdog escalation
      // ladder. Probe is one-shot per turn (bounded cost) and async (does not
      // block the tick). Provider gate mirrors `turnErrorRecovery.ts:2405` —
      // diagnostic probes hit Anthropic-specific endpoints, so direct role
      // profiles (Codex / OpenRouter / etc.) skip this enhancement.
      if (
        newLevel === 4 &&
        !levelFourDiagnosticInvoked &&
        !isDirectRoleProfile &&
        !isToolInFlight &&
        !hasActiveSubagent &&
        !abortController.signal.aborted &&
        !turnCompleted
      ) {
        levelFourDiagnosticInvoked = true;
        fireAndForget(
          (async () => {
            let diagnostic: TimeoutDiagnosticResult;
            try {
              diagnostic = await diagnoseTimeout(abortController.signal);
            } catch (probeErr) {
              turnLogger.warn({ err: probeErr }, 'Level-4 diagnostic probe threw — skipping follow-up status event');
              return;
            }
            // Re-check stall conditions after the probe (~2s budget). If the
            // turn aborted, completed, the stream resumed, a tool started, or
            // a subagent kicked off during the probe, the diagnostic-aware
            // copy would be stale — skip the dispatch.
            if (
              abortController.signal.aborted ||
              turnCompleted ||
              hasRuntimeToolInFlight() ||
              watchdog.hasActiveSubagent
            ) {
              turnLogger.info(
                {
                  diagnosticKind: diagnostic.kind,
                  aborted: abortController.signal.aborted,
                  turnCompleted,
                  toolStartedDuringProbe: hasRuntimeToolInFlight(),
                  subagentStartedDuringProbe: watchdog.hasActiveSubagent,
                },
                'Level-4 diagnostic probe completed but turn state moved on — suppressing stale status event',
              );
              return;
            }
            turnLogger.info(
              { diagnosticKind: diagnostic.kind, level: 4, silentMs },
              'Level-4 diagnostic probe completed — dispatching diagnostic-aware status event',
            );
            try {
              dispatchAgentEvent(win, turnId, {
                type: 'status',
                message: getDiagnosticAwareLevelFourMessage(diagnostic),
                timestamp: Date.now(),
              });
            } catch (dispatchErr) {
              turnLogger.warn({ err: dispatchErr }, 'Failed to dispatch Level-4 diagnostic status event');
            }
          })(),
          'agentTurnExecute.level4DiagnosticProbe',
        );
      }

      if (silentMs >= effectiveAbortMs) {
        abortByWatchdog('watchdog', effectiveAbortMs);
        return;
      }

      // Only capture to Sentry on first trigger (level 1) to avoid noise.
      // REBEL-1AD: Skip Sentry capture when a tool is in flight — MCP tools routinely
      // take >30s and this was generating ~5500 events/day of non-actionable noise.
      // User-facing status messages still fire at 30s (above). Auto-abort and
      // self-resolved captures are unaffected.
      //
      // REBEL-1AD (Apr 27, third regression): Also skip when the model is actively
      // emitting a streaming delta of any kind — `input_json_delta` (tool args),
      // `thinking_delta` (extended thinking), `text_delta` (assistant text),
      // `signature_delta`, OpenAI `response.*.delta`, `chat.completion.chunk`, …
      // Reasoning models (minimax-m2.7, opus-4-6, gpt-5 high-effort) emit these
      // in bursts with multi-tens-of-seconds gaps of internal computation, which
      // is normal upstream latency, not an app bug. Auto-abort at the
      // phase-aware ceiling (10 min streaming-stall / 30 min tool-in-flight)
      // still captures a truly-frozen stream with full context.
      const suppressLevel1Capture = shouldSuppressLevel1WatchdogCapture(rawStreamTracker.lastActivity);
      if (newLevel === 1 && !isToolInFlight && !suppressLevel1Capture) {
        const lastActivity = rawStreamTracker.lastActivity;
        const unmappedActivity = lastActivity?.kind === 'unknown';
        const inferredProvider: 'anthropic' | 'openai' = lastActivity
          ? lastActivity.rawEventType.includes('.') || lastActivity.rawEventType === 'chat.completion.chunk'
            ? 'openai'
            : 'anthropic'
          : 'anthropic';
        if (unmappedActivity && lastActivity) {
          const observationKey = lastActivity.rawEventType;
          if (recordUnmappedActivityObservationOnce(observationKey)) {
            try {
              getErrorReporter().addBreadcrumb({
                category: 'runtime-activity',
                level: 'warning',
                message: '[runtime-activity] unmapped event observed',
                data: {
                  provider: inferredProvider,
                  rawEventType: lastActivity.rawEventType,
                },
              });
            } catch { /* defensive — Sentry SDK failure must not crash gate */ }
          }
        }
        const collectAndReportDiagnostics = async () => {
          try {
            const appMetrics = collectAppMetricsSafely();
            const processMetrics = appMetrics.map((p) => ({
              type: p.type,
              pid: p.pid,
              cpu: p.cpu.percentCPUUsage,
              memory: p.memory.workingSetSize,
              name: p.name,
            }));
            const highMemoryProcesses = processMetrics.filter((p) => p.memory > 500 * 1024 * 1024);

            const turnModel = agentTurnRegistry.getTurnModel(turnId);
            const extendedContext = agentTurnRegistry.getTurnExtendedContext(turnId);

            // Stage 3a stall-debuggability enrichment (260617 bricked-state plan):
            // time-to-first-token, first-byte bool, provider/route, and a cheap,
            // time-boxed reachability marker — the data that will let us
            // confirm/deny the DNS-threadpool-starvation class (fb7f72095) the
            // next time an `awaiting_api` stall lands in the wild.
            const firstByteReceived = rawStreamTracker.eventCount > 0;
            const timeToFirstTokenMs = rawStreamTracker.firstActivityTimestamp !== null
              ? Math.max(0, rawStreamTracker.firstActivityTimestamp - turnStartedAt)
              : null;
            const provider = agentTurnRegistry.getTurnActiveProvider(turnId);

            // Reachability marker: run the ALREADY-bounded `diagnoseTimeout`
            // one-shot (its own 2s budget + AbortSignal) ONLY when this is a
            // genuine no-first-token stall on an Anthropic route (the probe
            // hits Anthropic endpoints — direct role profiles / non-Anthropic
            // transports would get a misleading signal). It is awaited inside
            // this fire-and-forget collector, so it never blocks the watchdog
            // tick; if the turn moved on or it throws, we record `not_probed`.
            // S3-Env mitigation: the probe is the bounded `diagnoseTimeout`, so
            // even DNS-threadpool starvation (the very thing we measure) can't
            // hang it past its budget.
            let reachabilityMarker: WatchdogReachabilityMarker = 'not_probed';
            if (
              !firstByteReceived &&
              !isDirectRoleProfile &&
              inferredProvider === 'anthropic' &&
              !abortController.signal.aborted &&
              !turnCompleted
            ) {
              try {
                const diagnostic = await diagnoseTimeout(abortController.signal);
                reachabilityMarker = diagnostic.kind === 'anthropic_issue'
                  ? 'anthropic_issue'
                  : diagnostic.kind === 'internet_unreachable'
                    ? 'internet_unreachable'
                    : 'transient_stall';
              } catch (probeErr) {
                turnLogger.debug({ err: probeErr }, 'Stall reachability probe threw — recording not_probed');
              }
            }

            // Registry-owned warning capture (260610 improve-sentry-noise
            // Stage 2) — the rich diagnostics extras are preserved verbatim.
            captureWatchdogStalled({
              silentMs,
              threshold: hasActiveSubagent ? SUBAGENT_NO_OUTPUT_TIMEOUT_MS : NO_OUTPUT_TIMEOUT_MS,
              turnId,
              phase,
              mcpMode,
              lastMessageType: watchdog.lastMessageType,
              lastToolName: watchdog.lastToolName,
              messageCount,
              upstreamServerCount,
              hasMedia,
              totalAttachments,
              model: turnModel,
              extendedContext,
              hasActiveSubagent,
              activeSubagentCount,
              upstreamActivity,
              mainProcessMemory: process.memoryUsage(),
              processCount: appMetrics.length,
              highMemoryProcesses,
              totalAppMemory: processMetrics.reduce((sum, p) => sum + p.memory, 0),
              rawStreamLastEvent: rawStreamTracker.lastEventType,
              rawStreamLastEventAgeMs: rawStreamTracker.lastTimestamp !== null ? now - rawStreamTracker.lastTimestamp : null,
              rawStreamEventCount: rawStreamTracker.eventCount,
              timeToFirstTokenMs,
              firstByteReceived,
              provider,
              route: inferredProvider,
              reachabilityMarker,
              ...(unmappedActivity && lastActivity
                ? {
                    unmappedActivity: {
                      kind: lastActivity.kind,
                      rawEventType: lastActivity.rawEventType,
                    },
                  }
                : {}),
            });
            
            turnLogger.info(
              { processCount: appMetrics.length, highMemoryProcesses, totalAppMemory: processMetrics.reduce((sum, p) => sum + p.memory, 0) },
              'Watchdog diagnostics collected'
            );
          } catch (diagErr) {
            turnLogger.debug({ err: diagErr }, 'Failed to collect watchdog diagnostics');
          }
        };
        fireAndForget(collectAndReportDiagnostics(), 'agentTurnExecute.watchdogDiagnostics');
      }
    }, WATCHDOG_CHECK_INTERVAL_MS);

    receivedResultMessage = false; // Reset for this try block iteration (retries)
    // Stage 5 (260503 robustness plan): per-TURN record-once latch for
    // watchdog self-resolution. We record at most one self-resolution per
    // turn (the first fire's first level-reset). Subsequent fire/resume
    // cycles within the same turn are intentionally not recorded — the
    // signal is a binary "this turn recovered itself at least once" rather
    // than a per-fire counter, which is enough for the eval reliability
    // check this drives. If we ever need per-fire telemetry, switch to an
    // array and reset on each `watchdog.fire()` rather than reusing this
    // latch.
    //
    // Recording happens inside the runner's onMessage callback
    // (synchronous, before handleAgentMessage dispatches the terminal
    // `result` event), so eval listeners see the value when they read the
    // registry inside their per-turn `result`/`error` listener.
    let turnSelfResolutionRecorded = false;
    const primaryResult = await runAgentQuery({
      queryOptions, prompt: promptOrGenerator, abortController, routerContext,
      turnId, win, turnLogger,
      getLastActivityAgeMs,
      // F20: align Layer 1 per-message timeout with the watchdog (Layer 2) tool-in-flight
      // ceiling so Layer 1 never preempts the watchdog (or, in later stages, the LLM judge).
      // Layer 2 still catches streaming stalls early via STREAMING_STALL_ABORT_MS.
      messageTimeoutMs: getMessageTimeoutMs(),
      getMessageTimeoutMs,
      // REBEL-1AF defense-in-depth: also surface tool-in-flight directly so the
      // iterator's isStillProcessing path has an explicit observable signal.
      isToolInFlight: getIsToolInFlight,
      rethrowKinds: new Set(['rate_limit', 'server_error', 'invalid_request', 'session_not_found', 'tool_name_corrupt']),
      rethrowPredicates: [
        isExtendedContextUnavailableError,
        (e: unknown) => getErrorMessage(e).includes('empty_result_anomaly'),
      ],
      onMessage: (message) => {
        const msg = message as { type?: string; message?: { content?: unknown }; subtype?: string };
        const messageNow = Date.now();
        // Delegate watchdog message processing (resets level, tracks tools/subagents)
        const { levelWasReset, previousLevel } = watchdog.onMessage(
          message as { type: string; message?: { content?: unknown[] } },
          messageNow,
        );
        if (levelWasReset) {
          turnLogger.debug(
            { previousLevel, messageType: msg.type },
            'Watchdog level reset on resumed activity'
          );
          // Stage 1b: re-arm the one-shot soft "still waiting" affordance when the
          // turn resumes activity, so a turn that stalls → resumes → stalls again
          // can re-surface the affordance. The renderer also clears State B when it
          // observes output / a non-stall status / a terminal, so this stays in
          // sync with the renderer-side clear. (The soft surface itself was never
          // a terminal, so there is nothing to undo — just the latch.)
          awaitingApiSoftStallDispatched = false;
          // Stage 5 (260503 robustness plan): record self-resolution at the
          // moment of activity-resume after a fire. Recording here (inside the
          // synchronous onMessage callback) is BEFORE handleAgentMessage runs
          // for the same message, which is BEFORE the renderer/eval-listener
          // receives any subsequent terminal event for this turn. Recording
          // post-loop (where the SAME data is already used for the existing
          // log + Sentry breadcrumb) would be too late: on the success path
          // the `result` event is dispatched inside handleAgentMessage during
          // iteration, so eval listeners reading after `result` settles
          // would see an empty array. We record at most once per TURN (the
          // first fire's first level-reset is the self-resolution);
          // subsequent fires/resumes within the same turn are intentional
          // no-ops — see the latch comment above.
          if (watchdog.fired && watchdog.firedAt && !turnSelfResolutionRecorded) {
            turnSelfResolutionRecorded = true;
            agentTurnRegistry.recordWatchdogSelfResolution(turnId, Date.now() - watchdog.firedAt);
          }
        }

        const contentBlocks = (message as { message?: { content?: unknown[] } }).message?.content;
        if (Array.isArray(contentBlocks)) {
          if (msg.type === 'assistant') {
            for (const block of contentBlocks) {
              const record = block as Record<string, unknown>;
              if (record?.type === 'tool_use' && typeof record.id === 'string') {
                toolCallStateByUseId.set(record.id, {
                  name: typeof record.name === 'string' ? record.name : 'tool',
                  startedAt: messageNow,
                  input: record.input,
                });
              }
            }
          }

          if (msg.type === 'user') {
            for (const block of contentBlocks) {
              const record = block as Record<string, unknown>;
              if (record?.type === 'tool_result' && typeof record.tool_use_id === 'string') {
                const tracked = toolCallStateByUseId.get(record.tool_use_id);
                toolCallStateByUseId.delete(record.tool_use_id);
                const completedToolName = tracked?.name ?? extensionBoundToolName ?? watchdog.lastToolName ?? 'tool';
                const completedSuccessfully = record.is_error !== true;

                appendCompletedToolThisTurn(completedToolsThisTurn, {
                  name: completedToolName,
                  success: completedSuccessfully,
                  durationMs: tracked ? Math.max(0, messageNow - tracked.startedAt) : 0,
                });

                if (completedSuccessfully) {
                  resetOtherToolCancelCounts(toolWatchdogCancelCountByName, completedToolName);
                } else if (
                  record.is_error === true &&
                  isSubagentInternalTimeoutResult(record.content)
                ) {
                  handleSubagentInternalTimeout({
                    toolUseId: record.tool_use_id,
                    toolName: completedToolName,
                    startedAt: tracked?.startedAt,
                    messageNow,
                  });
                }
              }
            }
          }
        }

        if (msg.type === 'result' || msg.type === 'error') {
          toolCallStateByUseId.clear();
          for (const toolUseId of toolCancelGraceTimerByToolUseId.keys()) {
            clearToolCancelGraceTimer(toolUseId);
          }
          activeChildACByToolUseId.clear();
        }

        // Track if we received the result message (needed for hook continue:false handling)
        if (msg.type === 'result') {
          receivedResultMessage = true;
        }
      },
      // Activity counter — bumped only for real API output (assistant text,
      // tool_use/tool_result, result). The runner filters synthetic system:*
      // messages via isApiOutputMessage so they cannot trip retry guards.
      // Origin: rebel://conversation/10d9eec1-18ea-4591-8b0e-39cf19c9a36d
      // (transient OpenRouter Connection error after provider switch surfaced
      // as a hard error because system:init alone tripped messageCount > 0).
      onApiOutput: () => {
        messageCount++;
      },
      onContinueError: (messageError, message) => {
        // Extended error logging for primary loop — Stream closed detection, Sentry, renderer notification
        const messageErrorText = getErrorMessage(messageError);
        const isStreamClosedError = messageErrorText.includes('Stream closed');
        const messageErrorMetadata = messageError as { code?: unknown; errno?: unknown; syscall?: unknown };
        const logLevel = isStreamClosedError ? 'error' : 'warn';
        const msg = message as Record<string, unknown>;

        turnLogger[logLevel](
          {
            err: messageError,
            messageType: msg.type,
            messageSubtype: msg.subtype,
            isStreamClosedError,
            raceConditionDetected: isStreamClosedError,
            activeConcurrentTurns: agentTurnRegistry.getActiveTurnCount(),
            mcpMode: mcpMode ?? 'unknown',
          },
          isStreamClosedError
            ? 'RACE CONDITION DETECTED: Stream closed error - indicates concurrent MCP tool usage conflict'
            : 'Error processing agent message - continuing with next message'
        );

        getErrorReporter().captureException(messageError, {
          tags: {
            source: 'rebel-core-runtime',
            sdk_error_category: isStreamClosedError ? 'stream_closed' : 'unknown',
            mcp_mode: mcpMode ?? 'unknown',
          },
          extra: {
            turnId,
            messageType: msg.type,
            messageSubtype: msg.subtype,
            activeConcurrentTurns: agentTurnRegistry.getActiveTurnCount(),
            errorCode: messageErrorMetadata.code,
            errorErrno: messageErrorMetadata.errno,
            errorSyscall: messageErrorMetadata.syscall,
          },
        });

        dispatchAgentEvent(win, turnId, {
          type: 'status',
          message: isStreamClosedError
            ? `Warning: MCP race condition detected (${agentTurnRegistry.getActiveTurnCount()} concurrent turns) - consider enabling HTTP mode`
            : `Warning: Error processing message (${messageErrorText || 'unknown error'}) - continuing...`,
          timestamp: Date.now(),
        });
      },
      label: 'primary',
    });
    // Map runAgentQuery abort detection to original semantics (watchdog vs user)
    const abortedByUser = primaryResult.abortedByUser && !abortedByWatchdog;
    if (primaryResult.abortedByUser) {
      if (abortedByWatchdog) {
        turnLogger.info('Agent turn auto-aborted by watchdog');
      } else {
        turnLogger.info('Agent turn aborted by user');
      }
    }

    // Clean up watchdog interval
    clearInterval(watchdogInterval);
    for (const toolUseId of toolCancelGraceTimerByToolUseId.keys()) {
      clearToolCancelGraceTimer(toolUseId);
    }
    activeChildACByToolUseId.clear();
    // Prevent in-flight watchdog judge promise from applying state after the
    // turn completes successfully (it would otherwise emit diagnostics or
    // touch counters for a turn that's already done).
    turnCompleted = true;

    // S7 Stage 2: Synthesize terminal lifecycle event so rawStreamTracker.lastActivity
    // reflects the cancellation/abort cause rather than the last upstream event before
    // stall. Single emission site (intentionally NOT per-client) — see
    // docs/plans/260503_s7_runtime_activity_event_migration_completion.md Phase 2 finding 3.
    recordTerminalLifecycleActivity({
      rawStreamTracker,
      abortedByWatchdog,
      abortedByUser,
      supersededByNewerTurn: abortEndReason() === 'superseded',
      watchdogAbortReason,
      turnStartedAt,
    });

    // Enhanced watchdog outcome tracking for pattern analysis
    // If watchdog fired, log the outcome (resolved, aborted_user, or failed)
    if (watchdog.fired && watchdog.firedAt) {
      const resolvedAfterMs = Date.now() - watchdog.firedAt;
      const phase = watchdog.inferPhase();
      const turnModel = agentTurnRegistry.getTurnModel(turnId);
      const extendedContext = agentTurnRegistry.getTurnExtendedContext(turnId);

      // Low-cardinality resolution-time bucket for aggregation (logged below;
      // the analytics emit in emitWatchdogSelfResolvedTelemetry re-derives it).
      const resolutionTimeBucket = getWatchdogResolutionTimeBucket(resolvedAfterMs);
      
      if (!abortController.signal.aborted) {
        // Self-resolved: turn completed successfully after stall.
        // Note: Stage 5 (260503 robustness plan) recording for `recoveredStalls`
        // is done INSIDE the runner's onMessage callback at the moment of
        // activity-resume (see turnSelfResolutionRecorded latch above), NOT here —
        // this post-loop block runs AFTER `handleAgentMessage` has already
        // dispatched the terminal `result` event, so eval listeners would
        // miss the value if we recorded here. The log + Sentry breadcrumb
        // below stay here because they are diagnostic-only.
        turnLogger.info(
          { resolvedAfterMs, threshold: NO_OUTPUT_TIMEOUT_MS, phase, resolutionTimeBucket, maxLevel: watchdog.maxWatchdogLevel },
          'Watchdog self-resolved - turn completed successfully after stall'
        );
        // Success telemetry — analytics + diagnostic ledger ONLY, deliberately
        // no Sentry capture (was REBEL-N4, 11.5k info events/14d of noise).
        // The structured log line above still reaches Sentry as a breadcrumb
        // on the next real event. 260610 improve-sentry-noise Stage 2.
        emitWatchdogSelfResolvedTelemetry({
          resolvedAfterMs,
          phase,
          mcpMode,
          model: turnModel,
          extendedContext,
          lastToolName: watchdog.lastToolName,
          maxWatchdogLevel: watchdog.maxWatchdogLevel,
          messageCount,
        });
      } else if (abortedByWatchdog) {
        // Auto-aborted by watchdog (REBEL-NQ)
        turnLogger.info(
          { resolvedAfterMs, threshold: NO_OUTPUT_TIMEOUT_MS, phase, maxLevel: watchdog.maxWatchdogLevel },
          'Watchdog auto-aborted turn after sustained silence'
        );
        // Sentry event already captured in the watchdog interval (auto-abort block)
      } else {
        // Aborted by user while watchdog was active — log-only, no Sentry.
        // User-initiated aborts are expected behavior, not actionable telemetry (REBEL-NQ).
        turnLogger.info(
          { resolvedAfterMs, threshold: NO_OUTPUT_TIMEOUT_MS, phase, maxLevel: watchdog.maxWatchdogLevel },
          'Watchdog turn aborted by user during stall'
        );
      }
    }

    if (abortedByWatchdog && abortedByAwaitingApiStall) {
      // Stage 1a (260617_bricked-state-0448-electron42): the EARLIER, interactive
      // `awaiting_api` ceiling tripped (request sent, no first token). End the turn
      // as a RECOGNISED retryable `message_timeout` terminal so the renderer
      // surfaces the existing "Try again" affordance, rather than the generic
      // watchdog auto-abort copy. The explicit `errorKindOverride: 'message_timeout'`
      // is REQUIRED — the dispatcher only derives `message_timeout` from a
      // `MessageTimeoutError` name or this override, and `isTransient` alone will
      // not produce the Try-again copy/action (agentEventDispatcher.ts:733-769,
      // agentErrorCatalog.ts:151-154). Preserve the synthetic `result('error')`
      // after the error event so the renderer clears `isBusy`.
      const awaitingApiTimeoutCopy = formatWatchdogJudgeAbortMessage(
        watchdogAbortReason,
        watchdogAbortElapsedSinceTurnStartMs,
        watchdogAbortIsAutomationHardCap,
      );
      turnLogger.info('Sending awaiting_api stall retryable (message_timeout) completion events to renderer');
      dispatchAwaitingApiTimeoutTerminal({
        humanizedOverride: awaitingApiTimeoutCopy,
        watchdogDiagnostic: {
          phase: watchdog.inferPhase(),
          messageCount,
          rawStreamEventCount: rawStreamTracker.eventCount,
          rawStreamLastEventType: rawStreamTracker.lastEventType,
          rawStreamLastEventAgeMs: rawStreamTracker.lastTimestamp !== null ? Date.now() - rawStreamTracker.lastTimestamp : null,
          watchdogLevel: watchdog.watchdogLevel,
          maxWatchdogLevel: watchdog.maxWatchdogLevel,
          effectiveAbortMs: watchdogAutoAbortMs,
          model: requestedModelForTurn,
        },
        dispatchError: (error, options) => dispatchAgentErrorEvent(win, turnId, error, options),
        dispatchSyntheticErrorResult: () => dispatchAgentEvent(win, turnId, makeSyntheticResult(turnId, '', 'error')),
      });
    } else if (abortedByWatchdog) {
      // REBEL-NQ / REBEL-RD: Auto-aborted by watchdog - send distinct error message
      const autoAbortCopy = formatWatchdogJudgeAbortMessage(
        watchdogAbortReason,
        watchdogAbortElapsedSinceTurnStartMs,
        watchdogAbortIsAutomationHardCap,
      );
      turnLogger.info('Sending watchdog auto-abort completion events to renderer');
      dispatchAgentErrorEvent(win, turnId, new Error(autoAbortCopy), {
        humanizedOverride: autoAbortCopy,
        watchdogDiagnostic: {
          phase: watchdog.inferPhase(),
          messageCount,
          rawStreamEventCount: rawStreamTracker.eventCount,
          rawStreamLastEventType: rawStreamTracker.lastEventType,
          rawStreamLastEventAgeMs: rawStreamTracker.lastTimestamp !== null ? Date.now() - rawStreamTracker.lastTimestamp : null,
          watchdogLevel: watchdog.watchdogLevel,
          maxWatchdogLevel: watchdog.maxWatchdogLevel,
          effectiveAbortMs: watchdogAutoAbortMs,
          model: requestedModelForTurn,
        },
      });
      dispatchAgentEvent(win, turnId, makeSyntheticResult(turnId, '', 'error'));
    } else if (abortedByUser) {
      const postLoopAbortReason = abortEndReason();
      if (postLoopAbortReason === 'superseded') {
        turnLogger.info('Sending superseded completion events to renderer');
        dispatchAgentEvent(win, turnId, makeSyntheticResult(turnId, '', 'superseded'));
      } else {
        turnLogger.info('Sending stop completion events to renderer');
        dispatchAgentEvent(win, turnId, {
          type: 'status',
          message: 'Agent turn stopped by user',
          timestamp: Date.now(),
        });
        dispatchAgentEvent(win, turnId, makeSyntheticResult(turnId, '', 'user_stopped'));
      }
    } else if (!receivedResultMessage) {
      // Agent iterator completed without sending a result message.
      // This happens when a hook returns continue:false (e.g., tool safety approval required).
      // Dispatch an empty result to clear the busy state in the renderer.
      turnLogger.info('Agent iterator completed without result message (hook returned continue:false) - dispatching empty result');
      dispatchAgentEvent(win, turnId, makeSyntheticResult(turnId, '', 'awaiting_user'));
    }

    turnLogger.info('Agent turn iterator completed');
    // Update prompt cache warmup timestamp on successful turn completion
    if (!abortedByUser && !abortedByWatchdog) {
      updateLastApiCallTime();
      apiRateLimitCooldown.recordSuccess();
      // Stage 4b: clear any per-credential cooldown for the credential that just
      // succeeded, so it can be re-selected within the session after recovery.
      providerRateLimitCooldowns.recordSuccess(providerRoutePlan.decision.credentialSource);
      // Stage-4b multi-provider rate-limit failover success is observed at the
      // route-resolution seam (one event + one patch-back per hop, attributing
      // intermediate hops that subsequently 429), NOT here — the success block runs
      // only on the FINAL landing hop and so cannot attribute an intermediate
      // destination an earlier placeholder actually landed on. See the patch-back
      // at the "Turn provider routing resolved" log.
      // Stage 3: the success log must ALSO fire for server/transient failover, not
      // just 429 — pass the union of both attempted sets and tag the reason.
      const successRateLimitAttempted = turnOptions?.rateLimitAttemptedCredentialSources ?? [];
      const successServerTransientAttempted = turnOptions?.serverTransientAttemptedCredentialSources ?? [];
      if (successRateLimitAttempted.length > 0 || successServerTransientAttempted.length > 0) {
        // FIX-3: same three-way derivation as the patch-back emit (shared helper) —
        // mixed episodes report 'mixed-rate-limit-and-server-error'; pure 429 stays
        // 'rate-limit-failover' (byte-identical).
        const successFailoverReason = deriveProviderFailoverReason({
          rateLimitCount: successRateLimitAttempted.length,
          serverTransientCount: successServerTransientAttempted.length,
        });
        turnLogger.info(
          {
            event: 'multi_provider_failover_success',
            // Credentials marked attempted this turn — includes any implicit divert
            // skips (e.g. codex-subscription), not only credentials that made an upstream request.
            attemptedCredentials: [
              ...new Set([...successRateLimitAttempted, ...successServerTransientAttempted]),
            ],
            resolvedCredential: providerRoutePlan.decision.credentialSource,
            resolvedProvider: providerRoutePlan.decision.provider,
            resolvedBillingSource: providerRoutePlan.decision.billingSource ?? null,
            reason: successFailoverReason,
          },
          'Multi-provider failover succeeded — turn completed on fallback provider',
        );
      }
    }

    // Post-turn: promote testing contributions if connector was registered via non-standard path
    if (rendererSessionId) {
      fireAndForget(promoteTestingContributionIfRegistered(rendererSessionId), 'agentTurnExecute.promoteTestingContribution');
    }

    const cleanupReason = abortedByWatchdog ? 'watchdog-aborted' : abortedByUser ? 'aborted' : (receivedResultMessage ? 'completed' : 'hook-stopped');
    completeTurnCleanup(turnId, cleanupReason, attemptEpoch);
  } catch (error: unknown) {
    if (watchdogInterval) {
      clearInterval(watchdogInterval);
    }
    for (const toolUseId of toolCancelGraceTimerByToolUseId.keys()) {
      clearToolCancelGraceTimer(toolUseId);
    }
    activeChildACByToolUseId.clear();
    // Stale-turn guard (GPT-stage2-F5): if the pre-dispatch deadline already fired
    // (emitting the retryable terminal + running cleanup), a synchronous THROW from
    // a late-resumed pre-dispatch await must NOT route through handleTurnError —
    // that would emit a SECOND terminal. Cleanup already ran (idempotent), so just
    // mark complete and return without re-dispatching.
    if (preDispatchGuardFired) {
      turnCompleted = true;
      ignoreBestEffortCleanup(error, {
        operation: 'pre-dispatch-await-throw-after-deadline',
        reason: 'guard already emitted the retryable terminal; suppress duplicate error terminal',
      });
      return;
    }
    // Match the success path: prevent late-arriving judge promise from
    // applying state after the turn entered the error-handling cleanup.
    turnCompleted = true;
    // S7 Stage 2: Cover the abort-induced exception path. timeoutAsyncIterator
    // throws DOMException('AbortError') after a 5s grace timeout when a producer
    // doesn't honor signal.aborted. Record terminal lifecycle activity before
    // handleTurnError so rawStreamTracker reflects the cancellation cause.
    //
    // Predicate is intentionally local-signal only (not error.name === 'AbortError'):
    // timeoutAsyncIterator's grace-timeout error is only scheduled AFTER signal.aborted
    // becomes true (see timeoutAsyncIterator.ts onAbort handler), so signal.aborted
    // covers all legitimate watchdog/user-cancel cases. Honoring a name-only AbortError
    // would misclassify upstream/foreign aborts as turn.cancelled.
    // signal.aborted remains the admission gate for this synthetic terminal event;
    // signal.reason only classifies admitted aborts as superseded vs cancelled.
    if (abortController.signal.aborted) {
      recordTerminalLifecycleActivity({
        rawStreamTracker,
        abortedByWatchdog,
        abortedByUser: !abortedByWatchdog,
        supersededByNewerTurn: abortEndReason() === 'superseded',
        watchdogAbortReason,
        turnStartedAt,
      });
    }

    const learnedLimitsModel = accumulator.stage === 'runtime-ready'
      ? accumulator.modelConfig.model
      : requestedModelForTurn;
    const learnedLimitsProfileId = accumulator.stage === 'runtime-ready'
      ? (accumulator.activeProfile?.id ?? effectiveWorkingProfile?.id ?? null)
      : (effectiveWorkingProfile?.id ?? null);
    const learnedLimitWriteResult = safeDispatchLearnedLimitsFromError(error, {
      turnId,
      model: learnedLimitsModel,
      profileId: learnedLimitsProfileId,
    }, turnLogger);
    const outputCap = error instanceof ModelError && typeof error.details?.outputCap === 'number'
      ? Math.floor(error.details.outputCap)
      : null;
    const outputCapRetryKey = `${turnId}|${learnedLimitsModel}|${learnedLimitsProfileId ?? 'no-profile'}`;
    const outputCapRetryAlreadyAttempted = agentTurnRegistry.hasOutputCapRetryAttempted(outputCapRetryKey);
    const canRetryOutputCap = outputCap !== null
      && outputCap > 0
      && learnedLimitWriteResult?.ok === true
      && !outputCapRetryAlreadyAttempted
      && !abortController.signal.aborted
      && trackingCounters.messageCount === 0;

    if (canRetryOutputCap) {
      agentTurnRegistry.markOutputCapRetryAttempted(outputCapRetryKey);
      turnLogger.info(
        { outputCap, retryKey: outputCapRetryKey, model: learnedLimitsModel, profileId: learnedLimitsProfileId },
        'Output-cap learned from provider 400 at turn-level catch — retrying once',
      );
      await retryTurn();
      return;
    }

    syncTurnCompletionMutableBags();
    await handleTurnError(base, accumulator, {
      phase: 'primaryQueryShell',
      error,
      recoverable: false,
    });
  }
  }
  );
};
