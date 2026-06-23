// Agent Message Handler — processes agent messages from Rebel Core

/**
 * Agent Message Handler
 *
 * Processes agent messages (format originally defined by the Claude Agent SDK)
 * from Rebel Core and dispatches appropriate events to the renderer. Handles
 * system init, assistant messages, tool hints, context overflow detection, and
 * result processing.
 */

import type { AgentMessage, AgentModelUsageEntry, AgentAssistantMessageError } from '@core/agentRuntimeTypes';
import type { AgentEvent, ToolAgentEvent, McpAppUiMeta, ModelUsageEntry, ModelRoleBinding, ModelRoleWire, ImageRef, ContentRef } from '@shared/types';
import { FulfillmentProviderSchema } from '@shared/types/providerMetadata';
import { toCanonicalModelId, isSameModel } from '@shared/utils/modelIdentity';
import { getModelPricing } from '@shared/utils/pricingCalculator';
import { assertNever } from '@shared/utils/assertNever';
import {
  MCP_APP_VIEW_SUMMARY_DISPLAY_MAX_CHARS,
  McpAppUiMetaSchema,
} from '@shared/contracts/agentEventManifest';
import type { Logger } from 'pino';
import type { TurnContext } from './memoryUpdateService';
import type { TurnContextForTimeSaved } from './timeSavedService';
import type { EventWindow } from '@core/types';
import { createScopedLogger } from '@core/logger';
import { parseUseToolEnvelopeJson } from '@core/rebelCore/superMcpEnvelope';
import { getErrorReporter } from '@core/errorReporter';
import { ModelError } from '@core/rebelCore/modelErrors';
import { getIncrementalSessionStore } from '@core/services/incrementalSessionStore';
import { conversationScopeResolver } from '@core/services/externalConversation/conversationScopeResolver';
import { agentTurnRegistry } from './agentTurnRegistry';
import { appendCostEntry } from './costLedgerService';
import { appendDiagnosticEvent } from '@core/services/diagnosticEventsLedger';
import { classifyTurnOutcomeFromError, type TurnOutcome } from '@shared/costOutcome';
import { dispatchAgentErrorEvent, dispatchAgentEvent } from './agentEventDispatcher';
import {
  extractTextFromContent,
  extractImageContentFromToolResult,
} from '../utils/agentTurnUtils';
import { getTurnAggregator, mainTracking } from '../tracking';
import { triggerMemoryUpdate } from './memoryUpdateService';
import { triggerTimeSavedEstimation } from './timeSavedService';
import { updateStreakOnSessionComplete } from './achievementsStore';
import { createRoutedError } from '@shared/utils/agentErrorCatalog';
import { isSubAgentTool } from '@shared/utils/eventSanitization';
import { safeParseDetail, safeParseDetailRecord } from '@shared/utils/safeParseDetail';
import { stripLeakedInvokeXml } from '@shared/utils/assistantNarration';
import { computeOutputShapeMetrics } from '@shared/utils/outputShapeMetrics';
import { BOOKKEEPING_TOOL_NAMES } from '@rebel/shared';
import { EmptyResultAnomalyError } from '@shared/utils/emptyResultAnomalyError';
import { isRateLimitMessage } from '@shared/utils/friendlyErrors';
import { inferProviderFromModelId } from '@shared/utils/providerSwitch';
import { isExtendedContextUnavailableError, isThinkingModelUnavailableError, PLAN_MODE_ALIAS } from '@shared/utils/modelNormalization';
import { isToolNameLengthError, truncateToolName } from '@shared/utils/toolNameValidation';
import { classifySessionKind, shouldSkipMemoryUpdate, shouldSkipTimeSaved } from '@shared/sessionKind';
import { recordToolUsage, isMetaTool, type ParamTypeInfo } from './toolUsageStore';
import { getToolSchema } from './toolIndexService';
import { getOrGenerateAnonymousId, trackMainEvent } from '../analytics';
import {
  evaluateBadgesOnTurnComplete,
  evaluateJourneyCompletion,
  evaluateReunionBadge,
  updateCountersOnSessionComplete,
  recordToolUseForSession,
  getCurrentJourneyDay,
  type TurnContext as BadgeTurnContext
} from './achievementsEvaluator';
import { fireAndForget } from '@shared/utils/fireAndForget';

const log = createScopedLogger({ service: 'agentMessageHandler' });
const LARGE_INPUT_TURN_THRESHOLD_TOKENS = 50_000;
type SlackReplyInvariantOutcome =
  | 'satisfied'
  | 'continuation_emitted'
  | 'continuation_skipped_already_retried'
  | 'logged_only';
const SLACK_REPLY_INVARIANT_LRU_MAX = 1000;
const slackReplyInvariantRetriedSessions = new Map<string, true>();

function markSlackReplyInvariantRetried(sessionId: string): void {
  if (slackReplyInvariantRetriedSessions.has(sessionId)) {
    slackReplyInvariantRetriedSessions.delete(sessionId);
  }
  slackReplyInvariantRetriedSessions.set(sessionId, true);

  while (slackReplyInvariantRetriedSessions.size > SLACK_REPLY_INVARIANT_LRU_MAX) {
    const oldestKey = slackReplyInvariantRetriedSessions.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    slackReplyInvariantRetriedSessions.delete(oldestKey);
  }
}

function hasSlackReplyInvariantRetried(sessionId: string): boolean {
  return slackReplyInvariantRetriedSessions.has(sessionId);
}

function clearSlackReplyInvariantRetried(sessionId: string): void {
  slackReplyInvariantRetriedSessions.delete(sessionId);
}

export function __resetSlackReplyInvariantStateForTests(): void {
  slackReplyInvariantRetriedSessions.clear();
}

interface PendingCostOutcomeResolution {
  costEntryId: string;
  ledgerRowTs: number;
  ledgerRowSid?: string;
  ledgerRowTid?: string;
}

const pendingCostOutcomeResolutions = new Map<string, PendingCostOutcomeResolution[]>();

function emitCostOutcomeResolution(input: {
  costEntryId: string | undefined;
  ledgerRowTs: number;
  ledgerRowSid?: string;
  ledgerRowTid?: string;
  outcome: TurnOutcome;
}): void {
  if (!input.costEntryId) return;
  appendDiagnosticEvent({
    kind: 'cost_outcome_resolution',
    data: {
      costEntryId: input.costEntryId,
      ledgerRowTs: input.ledgerRowTs,
      ...(input.ledgerRowSid ? { ledgerRowSid: input.ledgerRowSid } : {}),
      ...(input.ledgerRowTid ? { ledgerRowTid: input.ledgerRowTid } : {}),
      outcome: input.outcome,
    },
  });
}

function enqueueCostOutcomeResolution(turnId: string, resolution: PendingCostOutcomeResolution): void {
  const existing = pendingCostOutcomeResolutions.get(turnId) ?? [];
  existing.push(resolution);
  pendingCostOutcomeResolutions.set(turnId, existing);
}

function flushCostOutcomeResolutions(turnId: string, outcome: TurnOutcome): void {
  const pending = pendingCostOutcomeResolutions.get(turnId);
  if (!pending || pending.length === 0) return;

  for (const resolution of pending) {
    emitCostOutcomeResolution({
      ...resolution,
      outcome,
    });
  }
  pendingCostOutcomeResolutions.delete(turnId);
}

interface LargeInputTurnBreakdown {
  builtinBashChars: number;
  builtinReadChars: number;
  builtinGrepChars: number;
  mcpToolChars: number;
}

const largeInputTurnBreakdowns = new Map<string, LargeInputTurnBreakdown>();

const createEmptyLargeInputTurnBreakdown = (): LargeInputTurnBreakdown => ({
  builtinBashChars: 0,
  builtinReadChars: 0,
  builtinGrepChars: 0,
  mcpToolChars: 0,
});

export const classifyLargeInputTurnTool = (toolName: string): keyof LargeInputTurnBreakdown => {
  if (toolName === 'Bash') return 'builtinBashChars';
  if (toolName === 'Read') return 'builtinReadChars';
  // Both `Grep` and `SearchFiles` are built-in search tools (per
  // `src/core/rebelCore/builtinTools.ts`); bucket them together so the diagnosis
  // gate isn't skewed by `SearchFiles` traffic showing up as MCP.
  if (toolName === 'Grep' || toolName === 'SearchFiles') return 'builtinGrepChars';
  return 'mcpToolChars';
};

const recordLargeInputTurnToolChars = (turnId: string, toolName: string, outputChars: number): void => {
  // Stage 0 telemetry is strictly opt-in. When the diagnosis env var is off we don't
  // record into the per-turn map at all — avoids unbounded growth on terminal paths
  // that don't go through the success-cleanup branch.
  if (process.env.REBEL_BASH_MATERIALIZATION_DIAGNOSIS_LOG !== '1') {
    return;
  }
  const breakdown = largeInputTurnBreakdowns.get(turnId) ?? createEmptyLargeInputTurnBreakdown();
  breakdown[classifyLargeInputTurnTool(toolName)] += outputChars;
  largeInputTurnBreakdowns.set(turnId, breakdown);
};

export function maybeLogLargeInputTurnBreakdown({
  logger,
  turnId,
  sessionId,
  breakdown,
  totalInputTokens,
  model,
}: {
  logger?: Pick<Logger, 'info'> | null;
  turnId: string;
  sessionId?: string | null;
  breakdown: LargeInputTurnBreakdown;
  totalInputTokens: number;
  model?: string;
}): boolean {
  if (process.env.REBEL_BASH_MATERIALIZATION_DIAGNOSIS_LOG !== '1') {
    return false;
  }

  if (totalInputTokens <= LARGE_INPUT_TURN_THRESHOLD_TOKENS) {
    return false;
  }

  logger?.info(
    {
      event: 'large_input_turn_breakdown',
      turnId,
      sessionId,
      builtinBashChars: breakdown.builtinBashChars,
      builtinReadChars: breakdown.builtinReadChars,
      builtinGrepChars: breakdown.builtinGrepChars,
      mcpToolChars: breakdown.mcpToolChars,
      totalInputTokens,
      model,
    },
    'Large-input turn tool-output breakdown'
  );
  return true;
}

type CompactModelUsageEntry = {
  in: number;
  out: number;
  cacheR?: number;
  cacheC?: number;
  cost?: number;
};

function toFiniteNumber(val: unknown, fallback: number): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeModelUsageEntry(raw: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUSD?: number;
} {
  const cacheReadTokens = raw.cacheReadInputTokens ?? raw.cache_read_input_tokens;
  const cacheCreationTokens = raw.cacheCreationInputTokens ?? raw.cache_creation_input_tokens;
  const costUSD = raw.costUSD ?? raw.cost_usd;

  return {
    inputTokens: toFiniteNumber(raw.inputTokens ?? raw.input_tokens, 0),
    outputTokens: toFiniteNumber(raw.outputTokens ?? raw.output_tokens, 0),
    ...(cacheReadTokens != null ? { cacheReadTokens: toFiniteNumber(cacheReadTokens, 0) } : {}),
    ...(cacheCreationTokens != null ? { cacheCreationTokens: toFiniteNumber(cacheCreationTokens, 0) } : {}),
    ...(costUSD != null && Number.isFinite(Number(costUSD)) ? { costUSD: Number(costUSD) } : {}),
  };
}

export function buildCompactModelUsage(
  message: AgentMessage
): Record<string, CompactModelUsageEntry> | undefined {
  const modelUsage = (message as Record<string, unknown>).modelUsage as
    Record<string, AgentModelUsageEntry> | undefined;

  if (!modelUsage || Object.keys(modelUsage).length === 0) {
    return undefined;
  }

  try {
    const result: Record<string, CompactModelUsageEntry> = {};

    for (const [model, entry] of Object.entries(modelUsage)) {
      const normalized = normalizeModelUsageEntry(entry as Record<string, unknown>);
      result[model] = {
        in: normalized.inputTokens,
        out: normalized.outputTokens,
        ...(normalized.cacheReadTokens != null ? { cacheR: normalized.cacheReadTokens } : {}),
        ...(normalized.cacheCreationTokens != null ? { cacheC: normalized.cacheCreationTokens } : {}),
        ...(normalized.costUSD != null ? { cost: normalized.costUSD } : {}),
      };
    }

    return Object.keys(result).length > 0 ? result : undefined;
  } catch (err) {
    log.warn(
      { err, modelUsageKeys: Object.keys(modelUsage) },
      'Failed to build compact model usage for cost ledger'
    );
    return undefined;
  }
}

function resolveEventModelUsageAuthMethod(
  model: string,
  planningModel: string | undefined,
  turnAuthMethod: string | undefined,
): string | undefined {
  if (!turnAuthMethod) return undefined;

  if (
    planningModel &&
    // Canonical comparison (not raw string-eq) so the planner is recognized even when its usage-key
    // spelling differs from the registry planning model — e.g. served `anthropic/claude-4.7-opus-...`
    // vs configured `claude-opus-4-7` on a mixed-provider turn (Stage-3 review F2 / hotspot H8).
    isSameModel(model, planningModel) &&
    isClaudeSdkContextModel(model) &&
    turnAuthMethod === 'codex-subscription'
  ) {
    return 'api-key';
  }

  return turnAuthMethod;
}

function normalizeFulfillmentProvider(raw: unknown): ModelUsageEntry['fulfillmentProvider'] | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (raw === null) {
    return null;
  }

  const parsed = FulfillmentProviderSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function normalizeProvidersSeen(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const providers = raw
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return Array.from(new Set(providers));
}

function buildEventModelUsage(
  message: AgentMessage,
  turnId: string,
): Record<string, ModelUsageEntry> | undefined {
  const modelUsage = (message as Record<string, unknown>).modelUsage as
    Record<string, AgentModelUsageEntry> | undefined;

  if (!modelUsage || Object.keys(modelUsage).length === 0) {
    return undefined;
  }

  try {
    const result: Record<string, ModelUsageEntry> = {};
    const planningModel = agentTurnRegistry.getTurnPlanningModel(turnId);
    const turnAuthMethod = agentTurnRegistry.getTurnAuthMethod(turnId);

    for (const [model, entry] of Object.entries(modelUsage)) {
      const rawEntry = entry as Record<string, unknown>;
      const normalized = normalizeModelUsageEntry(rawEntry);
      const authMethod = resolveEventModelUsageAuthMethod(model, planningModel, turnAuthMethod);
      const openRouterProvider = typeof rawEntry.openRouterProvider === 'string'
        ? rawEntry.openRouterProvider.trim()
        : undefined;
      const providersSeen = normalizeProvidersSeen(rawEntry.providersSeen);
      const fulfillmentProvider = normalizeFulfillmentProvider(rawEntry.fulfillmentProvider);
      result[model] = {
        inputTokens: normalized.inputTokens,
        outputTokens: normalized.outputTokens,
        ...(normalized.cacheReadTokens != null ? { cacheReadTokens: normalized.cacheReadTokens } : {}),
        ...(normalized.cacheCreationTokens != null ? { cacheCreationTokens: normalized.cacheCreationTokens } : {}),
        ...(normalized.costUSD != null ? { costUsd: normalized.costUSD } : {}),
        ...(authMethod ? { authMethod } : {}),
        ...(openRouterProvider ? { openRouterProvider } : {}),
        providersSeen,
        ...(fulfillmentProvider !== undefined ? { fulfillmentProvider } : {}),
      };
    }

    return Object.keys(result).length > 0 ? result : undefined;
  } catch (err) {
    log.warn(
      { err, modelUsageKeys: Object.keys(modelUsage) },
      'Failed to build event model usage for result event'
    );
    return undefined;
  }
}

/**
 * Build the runtime-authored per-role model bindings for the result event.
 *
 * The renderer used to reconstruct roles by string-comparing `model` vs `planningModel`, which
 * mislabeled direct-answer turns and could not dedup two spellings of the same model (the Turn
 * Usage tooltip bug — docs/plans/260601_diagnose-model-tier-tooltip/PLAN.md). Instead we read the
 * FINAL per-role models the runtime recorded in the turn registry (working = getTurnModel, re-set
 * on in-turn fallback; thinking = getTurnPlanningModel; fast = configured BTS) and reconcile each
 * against the actual `modelUsage` keys:
 *   - matches a usage key → `observed` (+ modelUsageKey, per-entry auth/provider, pricingStatus)
 *   - no matching usage   → `configured_not_used` (worker on a direct-answer turn, or BTS that
 *                            did not run) — surfaced for availability, no cost implied.
 * `modelUsage` keys with no matching role (council / sub-agent models) intentionally get NO
 * binding; the renderer still renders them as usage rows, just without a role badge. `roles[]` is
 * an annotation layer over `modelUsage` — it carries no tokens/cost. @see ModelRoleBinding.
 */
function buildModelRoles(
  turnId: string,
  modelUsage: Record<string, ModelUsageEntry> | undefined,
): ModelRoleBinding[] | undefined {
  const planningModel = agentTurnRegistry.getTurnPlanningModel(turnId);
  const workingModel = agentTurnRegistry.getTurnModel(turnId);
  const fastModel = agentTurnRegistry.getTurnFastModel(turnId);

  // canonical model id -> the actual modelUsage key that ran under it.
  const usageKeyByCanonical = new Map<string, string>();
  if (modelUsage) {
    for (const key of Object.keys(modelUsage)) {
      const { canonical } = toCanonicalModelId(key);
      if (!usageKeyByCanonical.has(canonical)) usageKeyByCanonical.set(canonical, key);
    }
  }

  const bindings: ModelRoleBinding[] = [];
  const boundCanonical = new Set<string>();

  const addRole = (role: ModelRoleWire, rawModel: string | undefined): void => {
    if (!rawModel) return;
    const { canonical } = toCanonicalModelId(rawModel);
    // Skip if the same model is already bound to an earlier role (e.g. a non-split turn where the
    // planning and working models coincide) — avoids a phantom duplicate row.
    if (boundCanonical.has(canonical)) return;
    boundCanonical.add(canonical);

    const pricingStatus: NonNullable<ModelRoleBinding['pricingStatus']> =
      getModelPricing(canonical) ? 'priced' : 'unpriced';
    const usageKey = usageKeyByCanonical.get(canonical);

    if (usageKey) {
      const entry = modelUsage![usageKey];
      const provider = entry.openRouterProvider ?? entry.providersSeen?.[0];
      bindings.push({
        role,
        canonicalModelId: canonical,
        rawModelId: rawModel,
        status: 'observed',
        modelUsageKey: usageKey,
        ...(entry.authMethod ? { authMethod: entry.authMethod } : {}),
        ...(provider ? { provider } : {}),
        pricingStatus,
      });
    } else {
      bindings.push({
        role,
        canonicalModelId: canonical,
        rawModelId: rawModel,
        status: 'configured_not_used',
        pricingStatus,
      });
    }
  };

  // Order matters for the dedup above: planner first (the distinctive role on direct-answer
  // turns), then the working/execution model, then the configured Background model.
  addRole('thinking', planningModel);
  addRole('working', workingModel);
  addRole('fast', fastModel);

  return bindings.length > 0 ? bindings : undefined;
}

/**
 * Aggregate token counts from modelUsage (per-model breakdown).
 * The result's `message.usage` only reflects the LAST API call in a tool-use
 * loop, but `modelUsage` accumulates across ALL API calls in the session.
 * Falls back to `message.usage` when `modelUsage` is empty/absent.
 */
function aggregateTokensFromModelUsage(message: AgentMessage): {
  inTok: number | undefined;
  outTok: number | undefined;
  cacheReadTok: number | undefined;
  cacheCreateTok: number | undefined;
} {
  const modelUsage = (message as Record<string, unknown>).modelUsage as
    Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }> | undefined;

  if (modelUsage && Object.keys(modelUsage).length > 0) {
    try {
      let inTok = 0;
      let outTok = 0;
      let cacheReadTok = 0;
      let cacheCreateTok = 0;

      for (const entry of Object.values(modelUsage)) {
        const normalized = normalizeModelUsageEntry(entry as Record<string, unknown>);
        inTok += normalized.inputTokens;
        outTok += normalized.outputTokens;
        cacheReadTok += normalized.cacheReadTokens ?? 0;
        cacheCreateTok += normalized.cacheCreationTokens ?? 0;
      }

      return {
        inTok: inTok || undefined,
        outTok: outTok || undefined,
        cacheReadTok: cacheReadTok || undefined,
        cacheCreateTok: cacheCreateTok || undefined,
      };
    } catch (err) {
      log.warn({ err }, 'Failed to aggregate tokens from model usage, falling back to message usage');
    }
  }

  // Fallback to message.usage (last-call-only, but better than nothing)
  const usage = 'usage' in message
    ? (message as {
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
      }).usage
    : undefined;

  return {
    inTok: usage?.input_tokens,
    outTok: usage?.output_tokens,
    cacheReadTok: usage?.cache_read_input_tokens,
    cacheCreateTok: usage?.cache_creation_input_tokens,
  };
}

/**
 * Extract OpenRouter upstream provider from modelUsage entries.
 * Returns the first non-empty `openRouterProvider` found (consistent within a turn).
 */
function extractOpenRouterProviderFromModelUsage(message: AgentMessage): string | undefined {
  const modelUsage = (message as Record<string, unknown>).modelUsage as
    Record<string, Record<string, unknown>> | undefined;
  if (!modelUsage) return undefined;
  for (const entry of Object.values(modelUsage)) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    if (typeof entry.openRouterProvider === 'string' && entry.openRouterProvider) {
      return entry.openRouterProvider;
    }
  }
  return undefined;
}

const CLAUDE_CONTEXT_MODELS = new Set([
  'sonnet',
  'opus',
  'opus[1m]',
  'haiku',
  'best',
  PLAN_MODE_ALIAS,
]);

/**
 * Map the lowercase provider key returned by `inferProviderFromModelId` to the
 * Title-Case display form used across the dispatcher + `humanizeAgentError`
 * (e.g. "OpenAI", "Anthropic", "OpenRouter"). `extractProviderFromMessage` in
 * agentEventDispatcher emits the same Title-Case form, so callers that need a
 * `providerOverride` should use this display form to stay consistent with the
 * downstream humanizer / CTA routing logic.
 *
 * Returns `undefined` when the model id matches no known prefix (the
 * dispatcher handles `undefined` gracefully).
 *
 * See docs/plans/260421_classification_driven_error_humanizer.md — Stage 3.
 */
function inferProviderDisplayFromModelId(modelId: string): string | undefined {
  const inferred = inferProviderFromModelId(modelId);
  switch (inferred) {
    case 'anthropic':
      return 'Anthropic';
    case 'openai':
      return 'OpenAI';
    case 'openrouter':
      return 'OpenRouter';
    case undefined:
      return undefined;
    default:
      return assertNever(inferred, 'inferProviderFromModelId result');
  }
}

function isClaudeSdkContextModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized.startsWith('claude-') || CLAUDE_CONTEXT_MODELS.has(normalized);
}

/**
 * Detect if text looks like an API error message rather than normal assistant content.
 * Conservative to avoid false positives — only matches clear API error format.
 */
function isApiErrorInText(text: string): boolean {
  // Match "API Error: NNN {json}" format — this is the runtime's error text format
  if (/^API Error: \d{3}\s*\{/.test(text.trimStart())) return true;

  // Match "API Error: Repeated NNN ..." format — the runtime surfaces exhausted retries this way
  if (/^API Error: Repeated\s+\d{3}\s/i.test(text.trimStart())) return true;

  // Match short text that's clearly an error message (not a long response mentioning errors)
  if (text.length < 300) {
    const lower = text.toLowerCase();
    if (lower.includes('internal server error') && lower.includes('"type":"error"')) return true;
  }

  return false;
}

/**
 * Structured error types for agent assistant messages.
 * These indicate API-level errors that prevented normal response generation.
 *
 * MULTI-PROVIDER STATUS: This enum is still Anthropic-runtime specific, but it
 * now feeds the shared classifier/humanizer seam used across providers. When a
 * non-Claude provider omits this enum, fallback classification routes through
 * provider-aware ModelError/status parsing + shared text matchers.
 */
/**
 * Map runtime error types to user-friendly messages.
 * User-actionable errors (billing, auth, rate_limit) should guide the user to fix them.
 */
const mapAgentErrorToUserMessage = (error: AgentAssistantMessageError): string => {
  switch (error) {
    case 'billing_error':
      return "Your API account needs billing attention. Add credits at your provider's console.";
    case 'authentication_failed':
      return 'Authentication failed. Check your API key in Settings.';
    case 'rate_limit':
      return 'Rate limit reached. Please wait a moment and try again.';
    case 'invalid_request':
      return 'The request was invalid. Try rephrasing or check Settings > Diagnose.';
    case 'server_error':
      return 'The API service encountered an error. Please try again.';
    case 'max_output_tokens':
    case 'unknown':
      return 'An unexpected error occurred. Check Settings > Diagnose for details.';
    default:
      return assertNever(error, 'AgentAssistantMessageError');
  }
};

/**
 * Resolve the effective tool name from a tool event.
 * For super-mcp `use_tool` calls, extracts the inner tool as "package_id/tool_id"
 * and returns the inner tool's args for downstream extraction.
 */
function resolveEffectiveTool(event: { toolName?: string; detail?: string }): {
  name: string;
  useToolArgs?: Record<string, unknown>;
} {
  const rawName = event.toolName ?? 'tool';
  if (rawName.endsWith('use_tool') && event.detail) {
    // BOUNDED via safeParseDetailRecord: malformed, over-budget, OR non-object
    // valid JSON keeps the original tool name (same as the pre-migration
    // try/catch fallback).
    const result = safeParseDetailRecord(event.detail);
    if (result.ok) {
      const input = result.value;
      if (input.package_id && input.tool_id) {
        return {
          name: `${input.package_id as string}/${input.tool_id as string}`,
          useToolArgs: input.args as Record<string, unknown> | undefined,
        };
      }
    }
  }
  return { name: rawName };
}

/**
 * Extract typed parameter info from a tool's inputSchema.
 * Best-effort: returns typed info for params that exist in the schema,
 * bare {name} entries for those that don't.
 *
 * Uses format>type precedence (matching extractParamHints from Stage 2).
 */
function extractParamTypesFromSchema(
  schema: unknown,
  paramNames: string[]
): ParamTypeInfo[] {
  if (!schema || typeof schema !== 'object') {
    return paramNames.map(name => ({ name }));
  }

  const s = schema as Record<string, unknown>;
  const properties = s.properties as Record<string, Record<string, unknown>> | undefined;
  const requiredFields = Array.isArray(s.required) ? new Set(s.required as string[]) : new Set<string>();

  if (!properties) {
    return paramNames.map(name => ({ name }));
  }

  return paramNames.map(name => {
    const prop = properties[name];
    if (!prop) {
      return { name };
    }

    const info: ParamTypeInfo = { name };

    // Extract type
    if (typeof prop.type === 'string') {
      info.type = prop.type;
    }

    // Extract format (takes display precedence over type in the template)
    if (typeof prop.format === 'string') {
      info.format = prop.format;
    }

    // Mark as required if in the required array
    if (requiredFields.has(name)) {
      info.required = true;
    }

    return info;
  });
}

function extractToolEventOrigin(block: unknown): ToolAgentEvent['_origin'] | undefined {
  if (!block || typeof block !== 'object') {
    return undefined;
  }

  const meta = (block as { _meta?: { origin?: unknown } })._meta;
  if (!meta || typeof meta !== 'object') {
    return undefined;
  }

  const origin = meta.origin;
  if (origin === 'real' || origin === 'synthetic-plan-seed' || origin === 'pre-turn-context') {
    return origin;
  }

  return undefined;
}

function extractOutputCharsFromToolResultBlock(block: Record<string, unknown>): number | undefined {
  const raw = block.output_chars ?? block.outputChars;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    return undefined;
  }
  return raw;
}

function isImageRefBlock(value: unknown): value is ImageRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.assetId === 'string'
    && candidate.assetId.length > 0
    && typeof candidate.mimeType === 'string'
    && candidate.mimeType.length > 0
    && typeof candidate.byteSize === 'number'
    && Number.isFinite(candidate.byteSize)
    && candidate.byteSize >= 0
  );
}

function extractImageRefsFromToolResultContent(content: unknown[]): {
  refs: NonNullable<ToolAgentEvent['imageRef']>;
  hasAnyRef: boolean;
} {
  const refs: NonNullable<ToolAgentEvent['imageRef']> = [];
  let hasAnyRef = false;
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    const blockRecord = block as { type?: unknown; imageRef?: unknown };
    if (blockRecord.type !== 'image') {
      continue;
    }
    const imageRef = blockRecord.imageRef;
    const hasImageRefProperty = Object.hasOwn(blockRecord, 'imageRef');
    hasAnyRef ||= hasImageRefProperty;
    if (isImageRefBlock(imageRef)) {
      refs.push(imageRef);
      hasAnyRef = true;
    } else {
      refs.push(null);
    }
  }
  return { refs, hasAnyRef };
}

function extractImageRefsFromToolResultBlock(
  block: Record<string, unknown>,
  toolContent: unknown[],
): NonNullable<ToolAgentEvent['imageRef']> {
  const refsFromContent = extractImageRefsFromToolResultContent(toolContent);
  if (refsFromContent.hasAnyRef) {
    return refsFromContent.refs;
  }

  const topLevelImageRef = block.imageRef;
  if (Array.isArray(topLevelImageRef)) {
    return topLevelImageRef.map((imageRef) => (isImageRefBlock(imageRef) ? imageRef : null));
  }
  if (isImageRefBlock(topLevelImageRef)) {
    return [topLevelImageRef];
  }
  return [];
}

function isContentRefBlock(value: unknown): value is ContentRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.contentId === 'string'
    && candidate.contentId.length > 0
    && typeof candidate.mimeType === 'string'
    && candidate.mimeType.length > 0
    && typeof candidate.byteSize === 'number'
    && Number.isFinite(candidate.byteSize)
    && candidate.byteSize >= 0
  );
}

function extractContentRefsFromToolResultContent(content: unknown[]): {
  refs: NonNullable<ToolAgentEvent['contentRef']>;
  hasAnyRef: boolean;
} {
  const refs: NonNullable<ToolAgentEvent['contentRef']> = [];
  let hasAnyRef = false;
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      refs.push(null);
      continue;
    }
    const blockRecord = block as { type?: unknown; contentRef?: unknown };
    if (blockRecord.type !== 'content_ref') {
      refs.push(null);
      continue;
    }
    const contentRef = blockRecord.contentRef;
    hasAnyRef = true;
    if (isContentRefBlock(contentRef)) {
      refs.push(contentRef);
    } else {
      refs.push(null);
    }
  }
  return { refs, hasAnyRef };
}

function extractContentRefsFromToolResultBlock(
  block: Record<string, unknown>,
  toolContent: unknown[],
): NonNullable<ToolAgentEvent['contentRef']> {
  const refsFromContent = extractContentRefsFromToolResultContent(toolContent);
  if (refsFromContent.hasAnyRef) {
    return refsFromContent.refs;
  }

  const topLevelContentRef = block.contentRef;
  if (Array.isArray(topLevelContentRef)) {
    return topLevelContentRef.map((ref) => (isContentRefBlock(ref) ? ref : null));
  }
  if (isContentRefBlock(topLevelContentRef)) {
    return [topLevelContentRef];
  }
  return [];
}

/**
 * Validate that a value is a usable MCP App resource URI string —
 * shape `ui://<authority>...` with a non-empty authority. Single
 * source of truth for "is this a usable resource URI?": consumed by
 * both the `_meta.ui.resourceUri` shape predicate and the post-strip
 * validation in `extractMcpAppViewResourceUriFromText`.
 *
 * Rejects:
 *   - non-strings (including `undefined`, numbers, etc.)
 *   - empty / whitespace-only / non-`ui://` strings
 *   - bare `ui://` prefix (no authority — see postmortem
 *     260423_method3_bare_ui_resource)
 *   - URIs starting `ui:///` (slash immediately after authority)
 *   - URIs containing C0 control characters (U+0000–U+001F) or DEL
 *     (U+007F) anywhere in the authority + path; null-byte injection
 *     is the original Phase 7 codex DA finding.
 */
function isUsableMcpAppResourceUri(value: unknown): value is string {
  return typeof value === 'string' && /^ui:\/\/[^\s/\u0000-\u001f\u007f]+/.test(value);
}

/**
 * Predicate: is this raw `_meta` value shaped like a usable MCP App
 * UI metadata block — a non-array record whose `.ui` is itself a
 * non-array record with a usable string `resourceUri`?
 *
 * "Usable" means Method 1 downstream (or its outer-block sibling)
 * would actually consume the metadata to build `mcpAppUiMeta`, AND
 * the resourceUri would not collapse downstream into super-mcp's
 * "No package found for resource URI: ui://" branch.
 *
 * Used by `unwrapUseToolEnvelopeMeta` for both inner and outer
 * metadata; consolidating the symmetric predicate prevents drift
 * between the two call sites.
 */
function hasUsableMcpAppUiMeta(metaRaw: unknown): boolean {
  if (
    metaRaw === null
    || typeof metaRaw !== 'object'
    || Array.isArray(metaRaw)
  ) {
    return false;
  }
  const ui = (metaRaw as { ui?: unknown }).ui;
  if (
    ui === null
    || typeof ui !== 'object'
    || Array.isArray(ui)
  ) {
    return false;
  }
  const resourceUri = (ui as { resourceUri?: unknown }).resourceUri;
  return isUsableMcpAppResourceUri(resourceUri);
}

/**
 * Canary: detects `presentation: 'primary'` MCP App envelopes whose typed
 * `structuredFallback.payload` has no content-bearing fields. The renderer
 * will faithfully embed the iframe and post empty values to it, producing
 * a blank form with no error surfaced to the user.
 *
 * Common cause: an MCP server handler permissively defaulting missing
 * required arguments to `[]` / `""` instead of returning `isError: true`
 * (REBEL-5MF: google-workspace `compose_workspace_email` r2e pre-fix).
 *
 * Returns the matched fallback `kind` when the envelope qualifies, or null.
 */
function isPrimaryViewWithEmptyFallback(
  meta: McpAppUiMeta | undefined,
): NonNullable<McpAppUiMeta['structuredFallback']>['kind'] | null {
  if (!meta || meta.presentation !== 'primary') return null;
  const fallback = meta.structuredFallback;
  if (!fallback) return null;
  switch (fallback.kind) {
    case 'email-draft': {
      const p = fallback.payload;
      const empty =
        p.to.length === 0 &&
        (p.cc?.length ?? 0) === 0 &&
        (p.bcc?.length ?? 0) === 0 &&
        p.subject.trim().length === 0 &&
        p.body.trim().length === 0;
      return empty ? 'email-draft' : null;
    }
    case 'plain': {
      return fallback.payload.markdown.trim().length === 0 ? 'plain' : null;
    }
    case 'calendar-pick': {
      return fallback.payload.options.length === 0 ? 'calendar-pick' : null;
    }
    case 'document-outline': {
      return fallback.payload.sections.length === 0 ? 'document-outline' : null;
    }
    default:
      return null;
  }
}

/**
 * Extract the MCP App resource URI from a `[View: ui://...]`
 * marker. Used by Method 0 (inner content text) and Method 3
 * (outer envelope text). Centralised so the regex doesn't drift.
 */
function extractMcpAppViewResourceUriFromText(text: string): string | null {
  const match = text.match(/\[View:\s*(ui:\/\/[^\s\]\),;]+)/);
  if (!match?.[1]) {
    return null;
  }

  // Strip trailing sentence punctuation, then validate via the shared
  // `isUsableMcpAppResourceUri` predicate so Method 0's `_meta.ui.resourceUri`
  // shape rule and Method 3's text-extraction shape rule cannot drift.
  // See postmortem 260423_method3_bare_ui_resource.
  const resourceUri = match[1].replace(/[.;,]+$/, '');
  return isUsableMcpAppResourceUri(resourceUri) ? resourceUri : null;
}

type UseToolEnvelopeHeuristicRejectReason = 'non_json_text' | 'missing_package_id_prefix';

const loggedUseToolEnvelopeHeuristicRejectReasons = new Set<UseToolEnvelopeHeuristicRejectReason>();

/**
 * Keep in sync with docs/project/SUPER_MCP_PASSTHROUGH_CONTRACT.md:
 * Super-MCP use_tool envelopes serialize top-level `package_id` near the
 * beginning of content[0].text, giving Method 0 a bounded pre-parse guard.
 */
export const SUPER_MCP_ENVELOPE_PREFIX_MARKER = '"package_id"';
export const SUPER_MCP_ENVELOPE_PREFIX_WINDOW_CHARS = 64;

function logUseToolEnvelopeHeuristicRejectOnce(args: {
  toolUseId: string | undefined;
  reason: UseToolEnvelopeHeuristicRejectReason;
  textLength: number;
}): void {
  if (loggedUseToolEnvelopeHeuristicRejectReasons.has(args.reason)) {
    return;
  }
  loggedUseToolEnvelopeHeuristicRejectReasons.add(args.reason);
  log.debug(
    {
      toolUseId: args.toolUseId,
      reason: args.reason,
      textLength: args.textLength,
    },
    'Super-MCP use_tool envelope rejected by pre-parse heuristic; skipping JSON parse'
  );
}

type StructuredContentShape =
  | { kind: 'object'; keys: string[] }
  | { kind: 'array'; length: number; elementShape: string }
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'null' }
  | { kind: 'undefined' };

function getStructuredContentElementShape(value: unknown): string {
  if (Array.isArray(value)) {
    return 'array';
  }
  if (value === null) {
    return 'null';
  }
  const valueType = typeof value;
  if (
    valueType === 'string' ||
    valueType === 'number' ||
    valueType === 'boolean' ||
    valueType === 'undefined'
  ) {
    return valueType;
  }
  if (valueType === 'object') {
    return 'object';
  }
  return 'non_json';
}

function getStructuredContentShape(value: unknown): StructuredContentShape {
  if (Array.isArray(value)) {
    return {
      kind: 'array',
      length: value.length,
      elementShape: value.length > 0 ? getStructuredContentElementShape(value[0]) : 'empty',
    };
  }
  if (value === null) {
    return { kind: 'null' };
  }
  if (typeof value === 'object') {
    return {
      kind: 'object',
      keys: Object.keys(value as Record<string, unknown>).sort().slice(0, 10),
    };
  }
  if (typeof value === 'string') {
    return { kind: 'string' };
  }
  if (typeof value === 'number') {
    return { kind: 'number' };
  }
  if (typeof value === 'boolean') {
    return { kind: 'boolean' };
  }
  return { kind: 'undefined' };
}

function getPresentationDeclared(rawMeta: unknown): boolean {
  return Boolean(
    rawMeta !== null &&
    typeof rawMeta === 'object' &&
    !Array.isArray(rawMeta) &&
    (rawMeta as { presentation?: unknown }).presentation === 'primary',
  );
}

function getRawViewSummaryLength(rawMeta: unknown): number | null {
  if (rawMeta === null || typeof rawMeta !== 'object' || Array.isArray(rawMeta)) {
    return null;
  }
  const viewSummary = (rawMeta as { viewSummary?: unknown }).viewSummary;
  return typeof viewSummary === 'string' ? viewSummary.trim().length : null;
}

function projectMcpAppUiMeta(
  rawMeta: unknown,
  context: {
    toolUseId?: string;
    toolName?: string;
    method: 'Method 0' | 'Method 1' | 'Method 2' | 'Method 3';
  },
): McpAppUiMeta | null {
  if (rawMeta === null || typeof rawMeta !== 'object' || Array.isArray(rawMeta)) {
    return null;
  }

  const result = McpAppUiMetaSchema.safeParse(rawMeta);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const presentationDeclared = getPresentationDeclared(rawMeta);
    const sourcePackageId = (rawMeta as { sourcePackageId?: unknown }).sourcePackageId;
    log.warn(
      {
        toolUseId: context.toolUseId,
        toolName: context.toolName,
        ...(typeof sourcePackageId === 'string' ? { sourcePackageId } : {}),
        method: context.method,
        fieldPath: firstIssue?.path ?? [],
        reason: firstIssue?.message ?? 'Unknown schema validation error',
        presentationDeclared,
        primaryPresentationRejected: presentationDeclared,
        issues: result.error.issues.map((issue) => ({
          fieldPath: issue.path,
          reason: issue.message,
        })),
      },
      'MCP App _meta.ui rejected at schema boundary; tool view will not render as primary'
    );
    return null;
  }
  const originalViewSummaryLength = getRawViewSummaryLength(rawMeta);
  if (
    typeof originalViewSummaryLength === 'number' &&
    result.data.viewSummary &&
    originalViewSummaryLength > result.data.viewSummary.length
  ) {
    log.debug(
      {
        toolUseId: context.toolUseId,
        toolName: context.toolName,
        originalLength: originalViewSummaryLength,
        truncatedLength: result.data.viewSummary.length,
        maxChars: MCP_APP_VIEW_SUMMARY_DISPLAY_MAX_CHARS,
        source: 'schema',
      },
      'MCP App viewSummary truncated at schema boundary'
    );
  }
  return result.data;
}

function areStructuredContentShapesEqual(
  left: StructuredContentShape,
  right: StructuredContentShape,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'object') {
    return (
      right.kind === 'object' &&
      left.keys.length === right.keys.length &&
      left.keys.every((key, index) => key === right.keys[index])
    );
  }
  if (left.kind === 'array') {
    return (
      right.kind === 'array' &&
      left.length === right.length &&
      left.elementShape === right.elementShape
    );
  }
  return true;
}

/**
 * Method 0 — Defense-in-depth unwrap of a Super-MCP `use_tool` JSON envelope.
 *
 * **Post-contract role (2026-05-09 onwards):** Super-MCP's `use_tool` handler
 * now hoists `_meta.ui` and `structuredContent` onto the OUTER tool_result
 * block per `docs/project/SUPER_MCP_PASSTHROUGH_CONTRACT.md`. For all
 * post-contract sessions, Method 0 finds the metadata on the outer block via
 * the "outer wins" precedence below and `adoptedFromEnvelope` is false.
 *
 * Method 0 is RETAINED as legacy fallback for:
 *   1. Replay of pre-contract conversations whose stored envelope predates the
 *      hoist — the outer block has no `_meta.ui` / `structuredContent` but the
 *      inner envelope text still does.
 *   2. Direct-MCP / runtime-bypass scenarios where the super-mcp wrap is not
 *      in play but a downstream tool still surfaces MCP App metadata buried
 *      inside a wrapped JSON payload.
 *
 * `adoptedFromEnvelope === true` in the structured log indicates the legacy
 * fallback fired; correlating these on a post-contract build is a regression
 * signal.
 *
 * Known no-metadata-expected envelope shapes are skipped silently
 * (return outer values, no metadata surfaced):
 *   - `result.status === 'oversized_output'` (Super-MCP truncation
 *     safety net)
 *   - `result.status === 'materialized'` (Super-MCP dehydrate-to-
 *     disk placeholder)
 *   - `result.dry_run === true` (Super-MCP dry-run preview)
 *
 * `silentFailureRisk` is true ONLY when the envelope has an
 * affirmative MCP App intent signal (`[View: ui://...]` marker
 * in inner content text) but the inner metadata that would let
 * the renderer populate the form is missing — see D3.
 */
function unwrapUseToolEnvelopeMeta(
  block: Record<string, unknown>,
  toolContent: Array<Record<string, unknown>>,
  toolUseId: string | undefined,
): {
  effective: {
    blockMeta?: { ui?: Record<string, unknown> };
    structuredContent?: unknown;
  };
  envelope?: {
    packageId: string;
    toolId: string;
    innerStatus?: unknown;
    hasInnerMetaUi: boolean;
    hasInnerStructuredContent: boolean;
    hasInnerViewMarker: boolean;
    adoptedFromEnvelope: boolean;
    silentFailureRisk: boolean;
    divergenceDetected: boolean;
  };
} {
  const outerMeta = block._meta as { ui?: Record<string, unknown> } | undefined;
  const outerStructured = (block as { structuredContent?: unknown }).structuredContent;
  // Outer metadata is "usable" iff the same shared predicate that gates inner
  // adoption also accepts it. Post-R1 live sessions carry outer `_meta`, so a
  // truthy-but-malformed outer `_meta.ui` must not suppress the silent-failure
  // canary or shadow usable inner metadata — same bug class as `hasInnerMetaUi`,
  // applied symmetrically via the shared `hasUsableMcpAppUiMeta` predicate.
  const hasOuterMetaUi = hasUsableMcpAppUiMeta(block._meta);
  const baseEffective = { blockMeta: outerMeta, structuredContent: outerStructured };

  const first = toolContent[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    return { effective: baseEffective };
  }

  const trimmed = first.text.trimStart();
  if (!trimmed.startsWith('{')) {
    logUseToolEnvelopeHeuristicRejectOnce({
      toolUseId,
      reason: 'non_json_text',
      textLength: first.text.length,
    });
    return { effective: baseEffective };
  }
  const markerSearchPrefix = trimmed.slice(
    0,
    SUPER_MCP_ENVELOPE_PREFIX_WINDOW_CHARS + SUPER_MCP_ENVELOPE_PREFIX_MARKER.length,
  );
  const markerIndex = markerSearchPrefix.indexOf(SUPER_MCP_ENVELOPE_PREFIX_MARKER);
  if (
    trimmed.length > SUPER_MCP_ENVELOPE_PREFIX_WINDOW_CHARS &&
    (markerIndex === -1 || markerIndex >= SUPER_MCP_ENVELOPE_PREFIX_WINDOW_CHARS)
  ) {
    logUseToolEnvelopeHeuristicRejectOnce({
      toolUseId,
      reason: 'missing_package_id_prefix',
      textLength: first.text.length,
    });
    return { effective: baseEffective };
  }

  const parsed = parseUseToolEnvelopeJson<{
    package_id?: unknown;
    tool_id?: unknown;
    result?: unknown;
  }>(trimmed);
  if (
    !parsed ||
    typeof parsed.package_id !== 'string' ||
    typeof parsed.tool_id !== 'string' ||
    parsed.result === null ||
    typeof parsed.result !== 'object' ||
    Array.isArray(parsed.result)
  ) {
    return { effective: baseEffective };
  }

  const inner = parsed.result as {
    _meta?: { ui?: Record<string, unknown> };
    structuredContent?: unknown;
    content?: Array<{ type?: unknown; text?: unknown }>;
    status?: unknown;
    dry_run?: unknown;
  };

  // Detect MCP App intent (the affirmative signal — see D3).
  let hasInnerViewMarker = false;
  if (Array.isArray(inner.content)) {
    for (const c of inner.content) {
      if (c?.type === 'text' && typeof c.text === 'string') {
        if (extractMcpAppViewResourceUriFromText(c.text) !== null) {
          hasInnerViewMarker = true;
          break;
        }
      }
    }
  }

  // Known no-metadata-expected envelope shapes — skip metadata
  // adoption silently.
  const isKnownPlaceholder =
    inner.status === 'oversized_output' ||
    inner.status === 'materialized' ||
    inner.dry_run === true;

  if (isKnownPlaceholder) {
    return {
      effective: baseEffective,
      envelope: {
        packageId: parsed.package_id,
        toolId: parsed.tool_id,
        innerStatus: inner.status,
        hasInnerMetaUi: false,
        hasInnerStructuredContent: false,
        hasInnerViewMarker,
        adoptedFromEnvelope: false,
        silentFailureRisk: false,
        divergenceDetected: false,
      },
    };
  }

  // hasInnerMetaUi is true ONLY when inner._meta.ui is shaped like a usable
  // MCP App UI metadata record — i.e. when Method 1 downstream would actually
  // consume it AND the resourceUri would not collapse into super-mcp's bare
  // `ui://` rejection branch. A truthy-but-malformed _meta.ui (e.g. {}, [],
  // primitive, missing/non-string/whitespace/bare-prefix resourceUri) must
  // NOT suppress silentFailureRisk, since the renderer would still see an
  // empty form. See AGENTS.md "Silent failure is a bug" and postmortem
  // 260423_method3_bare_ui_resource.
  const hasInnerMetaUi = hasUsableMcpAppUiMeta(inner._meta);
  const hasInnerStructuredContent = inner.structuredContent !== undefined;
  let divergenceDetected = false;

  if (hasOuterMetaUi && hasInnerMetaUi) {
    const outerResourceUri = ((block._meta as { ui: { resourceUri: string } }).ui).resourceUri;
    const innerResourceUri = ((inner._meta as { ui: { resourceUri: string } }).ui).resourceUri;
    if (outerResourceUri !== innerResourceUri) {
      divergenceDetected = true;
      log.warn(
        {
          toolUseId,
          packageId: parsed.package_id,
          toolId: parsed.tool_id,
          outerResourceUri,
          innerResourceUri,
        },
        'super-mcp passthrough divergence: outer _meta.ui.resourceUri differs from inner — outer wins per contract; investigate super-mcp hoist correctness'
      );
    }
  }

  if (outerStructured !== undefined && hasInnerStructuredContent) {
    const outerStructuredShape = getStructuredContentShape(outerStructured);
    const innerStructuredContentShape = getStructuredContentShape(inner.structuredContent);
    if (!areStructuredContentShapesEqual(outerStructuredShape, innerStructuredContentShape)) {
      divergenceDetected = true;
      log.warn(
        {
          toolUseId,
          packageId: parsed.package_id,
          toolId: parsed.tool_id,
          outerStructuredShape,
          innerStructuredContentShape,
        },
        'super-mcp passthrough divergence: outer structuredContent shape differs from inner — outer wins per contract; investigate super-mcp hoist correctness'
      );
    }
  }

  // Outer-wins precedence: only adopt inner if outer is absent OR malformed.
  // hasOuterMetaUi gates the "outer wins" path on the same usable-record
  // predicate as hasInnerMetaUi, so a malformed outer `_meta.ui` no longer
  // shadows usable inner metadata and no longer suppresses silentFailureRisk.
  const effectiveBlockMeta =
    hasOuterMetaUi ? outerMeta : (hasInnerMetaUi ? inner._meta : outerMeta);
  const effectiveStructuredContent =
    outerStructured !== undefined ? outerStructured : inner.structuredContent;

  const adoptedFromEnvelope =
    effectiveBlockMeta !== outerMeta || effectiveStructuredContent !== outerStructured;

  // Silent-failure-risk gate: affirmative MCP App intent
  // (`[View:]` marker present) but the metadata to render the
  // form is missing — and outer doesn't carry usable metadata either.
  const silentFailureRisk =
    hasInnerViewMarker &&
    !hasInnerMetaUi &&
    !hasInnerStructuredContent &&
    !hasOuterMetaUi &&
    outerStructured === undefined;

  return {
    effective: {
      blockMeta: effectiveBlockMeta,
      structuredContent: effectiveStructuredContent,
    },
    envelope: {
      packageId: parsed.package_id,
      toolId: parsed.tool_id,
      innerStatus: inner.status,
      hasInnerMetaUi,
      hasInnerStructuredContent,
      hasInnerViewMarker,
      adoptedFromEnvelope,
      silentFailureRisk,
      divergenceDetected,
    },
  };
}

/**
 * Extract tool hint events from agent messages.
 * Handles both tool_use (start) and tool_result (end) blocks.
 */
export const collectToolHints = (message: AgentMessage): ToolAgentEvent[] => {
  try {
    const parentToolUseId = (message as Record<string, unknown>).parent_tool_use_id as string | null ?? null;

    if (message.type === 'assistant') {
      const content = message.message.content;
      if (!Array.isArray(content)) return [];
      return content
        .filter((block) => block && typeof block === 'object' && block.type === 'tool_use')
        .map((block) => {
          try {
            const origin = extractToolEventOrigin(block);
            // Truncate tool name to Anthropic API limit (200 chars). The Claude model can
            // occasionally produce malformed tool_use blocks where the tool arguments are
            // serialized into the name field (e.g. 'Task" prompt="..."' at 700+ chars).
            // Without truncation these corrupt names get stored in eventsByTurn and break
            // conversation resume (API rejects names > 200 chars on every retry).
            return {
              type: 'tool' as const,
              toolName: truncateToolName(block.name ?? 'tool'),
              toolUseId: block.id,
              parentToolUseId,
              detail: JSON.stringify(block.input ?? {}, null, 2),
              stage: 'start' as const,
              timestamp: Date.now(),
              ...(origin ? { _origin: origin } : {}),
            };
          } catch (blockError) {
            const origin = extractToolEventOrigin(block);
            log.debug(
              { err: blockError, blockName: block?.name },
              'Error processing tool_use block'
            );
            return {
              type: 'tool' as const,
              toolName: truncateToolName(block?.name ?? 'tool'),
              toolUseId: block?.id,
              parentToolUseId,
              detail: 'Error processing tool input',
              stage: 'start' as const,
              timestamp: Date.now(),
              ...(origin ? { _origin: origin } : {}),
            };
          }
        });
    }

    if (message.type === 'user') {
      const content = (message.message as unknown as Record<string, unknown>).content;
      if (!Array.isArray(content)) return [];
      return content
        .filter((block) => block && typeof block === 'object' && block.type === 'tool_result')
        .map((block: Record<string, unknown>) => {
          try {
            const origin = extractToolEventOrigin(block);
            // Agent tool_result.content can be string or array - normalize to array
            const toolContent = Array.isArray(block.content)
              ? block.content
              : typeof block.content === 'string'
                ? [{ type: 'text', text: block.content }]
                : [];
            const imageContent = extractImageContentFromToolResult(toolContent);
            const imageRef = extractImageRefsFromToolResultBlock(block, toolContent);
            const contentRef = extractContentRefsFromToolResultBlock(block, toolContent);
            const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined;
            const outputChars = extractOutputCharsFromToolResultBlock(block);
            const event: ToolAgentEvent = {
              type: 'tool' as const,
              toolName: toolUseId ?? 'tool',
              toolUseId,
              parentToolUseId,
              detail: extractTextFromContent(toolContent) || 'completed',
              stage: 'end' as const,
              isError: block.is_error === true,
              ...(outputChars != null ? { outputChars } : {}),
              timestamp: Date.now(),
              ...(origin ? { _origin: origin } : {}),
            };
            if (imageContent.length > 0) {
              event.imageContent = imageContent;
              log.debug(
                { toolUseId: block.tool_use_id, imageCount: imageContent.length },
                'Extracted image content from tool result'
              );
            }
            if (imageRef.length > 0) {
              event.imageRef = imageRef;
              log.debug(
                { toolUseId: block.tool_use_id, imageRefCount: imageRef.length },
                'Extracted image refs from tool result',
              );
            }
            if (contentRef.length > 0) {
              event.contentRef = contentRef;
              log.debug(
                { toolUseId: block.tool_use_id, contentRefCount: contentRef.length },
                'Extracted content refs from tool result',
              );
            }
            // Extract MCP Apps UI metadata from tool result
            // This enables rendering interactive Views for UI-capable tools
            // 
            // MCP Apps can deliver UI metadata in multiple ways:
            // 1. Via _meta.ui on the tool_result block (if runtime preserves it)
            // 2. Via resource content blocks with mimeType "text/html;profile=mcp-app"
            // 3. Via text content containing ui:// URIs (fallback detection)
            // All three methods preserve the UI metadata contract; Method 3
            // must NOT promote to 'primary'. See
            // docs/plans/260507_unified_interactive_ui_architecture.md § Phase A3.
            
            // Debug: Log block structure to diagnose MCP Apps detection
            if (toolContent.length > 0 || block._meta) {
              log.debug(
                { 
                  toolUseId: block.tool_use_id,
                  hasBlockMeta: !!block._meta,
                  blockMetaKeys: block._meta ? Object.keys(block._meta) : [],
                  contentTypes: toolContent.map((c: Record<string, unknown>) => c?.type),
                  contentMimeTypes: toolContent.map((c: Record<string, unknown>) => c?.mimeType).filter(Boolean),
                },
                'Tool result block structure (MCP Apps detection)'
              );
            }

            // Method 0: Unwrap Super-MCP `use_tool` envelopes as a legacy
            // fallback. Post-R1 live sessions usually arrive with outer
            // _meta.ui / structuredContent already populated; this helper
            // preserves outer-wins precedence and only adopts inner metadata
            // when the outer fields are absent or malformed. See
            // unwrapUseToolEnvelopeMeta() above for shape detection, skip
            // rules, and the silent-failure-risk predicate.
            const {
              effective: {
                blockMeta: effectiveBlockMeta,
                structuredContent: effectiveStructuredContent,
              },
              envelope,
            } = unwrapUseToolEnvelopeMeta(block, toolContent, toolUseId);

            if (envelope) {
              // Production observability — see D3 logging policy.
              // log.info ONLY for the affirmative-intent-but-missing-metadata
              // case (silentFailureRisk). All other envelope shape matches
              // stay at log.debug to avoid noise from common non-MCP-Apps
              // use_tool traffic (gmail/list, slack/post, drive/search, Read,
              // Bash, ...).
              if (envelope.silentFailureRisk) {
                log.info(
                  { toolUseId: block.tool_use_id, ...envelope },
                  'Super-MCP use_tool envelope shaped like an MCP App (has [View:] marker) but inner _meta.ui / structuredContent missing — possible silent-failure regression'
                );
              } else {
                log.debug(
                  { toolUseId: block.tool_use_id, ...envelope },
                  'Super-MCP use_tool envelope detected; metadata adoption status logged'
                );
              }
            }
            
            // Method 1: Check _meta.ui on the block
            const metaUi = effectiveBlockMeta?.ui;
            const projectedMetaUi = projectMcpAppUiMeta(metaUi, {
              toolUseId,
              toolName: event.toolName,
              method: envelope?.adoptedFromEnvelope ? 'Method 0' : 'Method 1',
            });
            if (projectedMetaUi) {
              event.mcpAppUiMeta = projectedMetaUi;
              log.debug(
                { toolUseId: block.tool_use_id, resourceUri: projectedMetaUi.resourceUri },
                'Found MCP Apps UI metadata via _meta.ui'
              );
            }
            
            // Method 2: Check for resource content blocks with MCP Apps mime type
            if (!event.mcpAppUiMeta) {
              const appResource = toolContent.find(
                (c: Record<string, unknown>) => c?.type === 'resource' && 
                  (c?.mimeType === 'text/html;profile=mcp-app' || c?.mimeType === 'text/html+mcp')
              );
              if (appResource?.uri) {
                const appResourceMetaUi =
                  appResource._meta !== null
                  && typeof appResource._meta === 'object'
                  && !Array.isArray(appResource._meta)
                    ? (appResource._meta as { ui?: unknown }).ui
                    : undefined;
                const projectedResourceMeta = projectMcpAppUiMeta({
                  ...(appResourceMetaUi !== null && typeof appResourceMetaUi === 'object' && !Array.isArray(appResourceMetaUi)
                    ? appResourceMetaUi
                    : {}),
                  resourceUri: appResource.uri,
                }, {
                  toolUseId,
                  toolName: event.toolName,
                  method: 'Method 2',
                });
                if (projectedResourceMeta) {
                  event.mcpAppUiMeta = projectedResourceMeta;
                  log.debug(
                    { toolUseId: block.tool_use_id, resourceUri: appResource.uri },
                    'Found MCP Apps UI metadata via resource content block'
                  );
                }
              }
            }
            
            // Method 3: Check for ui:// URIs in text content (fallback)
            // Only match URIs in [View: ...] format to avoid false positives
            // Allows dots inside URIs (e.g. compose-email.html) but strips trailing punctuation
            if (!event.mcpAppUiMeta) {
              const textContent = toolContent.find((c: Record<string, unknown>) => c?.type === 'text' && typeof c?.text === 'string');
              if (textContent?.text) {
                const resourceUri = extractMcpAppViewResourceUriFromText(textContent.text);
                if (resourceUri) {
                  const projectedMarkerMeta = projectMcpAppUiMeta({
                    resourceUri,
                    presentation: 'inline',
                  }, {
                    toolUseId,
                    toolName: event.toolName,
                    method: 'Method 3',
                  });
                  if (projectedMarkerMeta) {
                    event.mcpAppUiMeta = projectedMarkerMeta;
                    log.debug(
                      { toolUseId: block.tool_use_id, resourceUri },
                      'Found MCP Apps UI metadata via [View: ui://...] marker in text content'
                    );
                  }
                }
              }
            }
            if (event.mcpAppUiMeta) {
              const toolResult: NonNullable<ToolAgentEvent['toolResult']> = {};
              if (toolContent.length > 0) {
                toolResult.content = toolContent;
              }
              if (effectiveStructuredContent !== undefined) {
                toolResult.structuredContent = effectiveStructuredContent;
              }
              if (toolResult.content || Object.prototype.hasOwnProperty.call(toolResult, 'structuredContent')) {
                event.toolResult = toolResult;
              }

              const emptyFallbackKind = isPrimaryViewWithEmptyFallback(event.mcpAppUiMeta);
              if (emptyFallbackKind) {
                log.warn(
                  {
                    toolUseId: block.tool_use_id,
                    toolName: event.toolName,
                    resourceUri: event.mcpAppUiMeta?.resourceUri,
                    structuredFallbackKind: emptyFallbackKind,
                    sourcePackageId: event.mcpAppUiMeta?.sourcePackageId,
                  },
                  'Primary MCP App envelope with empty structuredFallback payload — iframe will render a blank view. Likely silent failure in the MCP server handler defaulting missing required args to empty values. See REBEL-5MF.'
                );
              }
            }
            return event;
          } catch (blockError) {
            log.debug(
              { err: blockError, toolId: block?.tool_use_id },
              'Error processing tool_result block'
            );
            const fallbackToolUseId = typeof block?.tool_use_id === 'string' ? block.tool_use_id : undefined;
            return {
              type: 'tool' as const,
              toolName: fallbackToolUseId ?? 'tool',
              toolUseId: fallbackToolUseId,
              parentToolUseId,
              detail: 'Error processing tool result',
              stage: 'end' as const,
              timestamp: Date.now(),
            };
          }
        });
    }

    return [];
  } catch (error) {
    log.error({ err: error, messageType: message.type }, 'Error in collectToolHints');
    return [];
  }
};

/**
 * Determine whether an empty result with `stop_reason === 'end_turn'` is a
 * legitimate "model done after tools" outcome that should produce a brief
 * "Done." synthesis instead of an `EmptyResultAnomalyError`.
 *
 * Strict gate — both conditions must hold:
 *   1. `executor_tool_count > 0` — i.e. the live agent loop saw at least one
 *      real model-issued `tool_use:start` (excludes synthetic plan seeds and
 *      pre-turn context events; see `agentMessageAdapter.actualToolCount`).
 *   2. At least one meaningful, non-bookkeeping, non-error, non-synthetic
 *      tool end event in the accumulator. Bookkeeping tool names
 *      (`MissionSet`, `TaskList`, `TaskCreate`, `TaskUpdate`, `TaskGet`,
 *      `TodoWrite`) and synthetic/pre-turn-context origins are filtered out
 *      so planning-only / bookkeeping-only turns don't qualify.
 *
 * Without BOTH gates, planning-only turns or turns with only bookkeeping
 * tool calls would be misclassified as legitimate. The caller is responsible
 * for the user-question pause check (this helper assumes the turn is NOT
 * paused on a user question).
 *
 * Used by both empty-result anomaly paths in the result handler:
 *   (a) the small-positive-final-turn-tokens path (REBEL-1G0, e.g. 2 thinking
 *       tokens with real tool work but no final text), and
 *   (b) the legacy "done after tools" path where `last_turn_output_tokens`
 *       is `0` or `undefined` but loop-total tokens > 0.
 */
function isLegitimateDoneAfterTools(args: {
  turnEvents: readonly AgentEvent[];
  executorToolCount: number;
  stopReason: string | null | undefined;
}): { ok: boolean; meaningfulToolEnds: number } {
  if (args.stopReason !== 'end_turn') {
    return { ok: false, meaningfulToolEnds: 0 };
  }
  if (args.executorToolCount <= 0) {
    return { ok: false, meaningfulToolEnds: 0 };
  }
  const meaningfulToolEnds = args.turnEvents.filter(
    (e) =>
      e.type === 'tool' &&
      e.stage === 'end' &&
      !e.isError &&
      !BOOKKEEPING_TOOL_NAMES.has(e.toolName) &&
      (e._origin === undefined || e._origin === 'real'),
  ).length;
  return { ok: meaningfulToolEnds > 0, meaningfulToolEnds };
}

function evaluateSlackReplyInvariant(args: {
  sessionId: string | undefined;
  stopReason: string | null | undefined;
  turnEvents: readonly AgentEvent[];
}): { outcome: SlackReplyInvariantOutcome; toolCallCount: number } | null | Promise<{ outcome: SlackReplyInvariantOutcome; toolCallCount: number } | null> {
  const sessionId = args.sessionId;
  if (!sessionId) return null;

  const binding = conversationScopeResolver.getBinding(sessionId);
  const evaluateWithExternalContextKind = (
    externalContextKind: string | undefined,
  ): { outcome: SlackReplyInvariantOutcome; toolCallCount: number } | null => {
    if (externalContextKind !== 'slack-thread') {
      return null;
    }

    const replyToolEvents = args.turnEvents.filter(
      (event): event is Extract<AgentEvent, { type: 'tool' }> =>
        event.type === 'tool' &&
        event.stage === 'end' &&
        event.toolName === 'reply_to_slack_thread',
    );
    const successfulReplyCount = replyToolEvents.filter((event) => !event.isError).length;
    const toolCallCount = replyToolEvents.length;

    if (args.stopReason !== 'end_turn' || successfulReplyCount > 0) {
      clearSlackReplyInvariantRetried(sessionId);
      return { outcome: 'satisfied', toolCallCount };
    }

    if (hasSlackReplyInvariantRetried(sessionId)) {
      return { outcome: 'continuation_skipped_already_retried', toolCallCount };
    }

    // Fallback path: we don't enqueue a continuation yet if clean wiring is unclear.
    markSlackReplyInvariantRetried(sessionId);
    return { outcome: 'logged_only', toolCallCount };
  };

  if (binding) {
    return evaluateWithExternalContextKind(binding.context.kind);
  }

  return getIncrementalSessionStore().getSession(sessionId)
    .then((session) => evaluateWithExternalContextKind(session?.externalContext?.kind))
    .catch((err) => {
      log.warn({ err, sessionId }, 'slack_reply_invariant_session_lookup_failed');
      return null;
    });
}

function isPromiseLike<T>(value: T | PromiseLike<T> | null): value is PromiseLike<T> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

/**
 * Process an agent message and dispatch appropriate events.
 * Handles system init, assistant messages, tool hints, context overflow, and results.
 */
export const handleAgentMessage = (
  win: EventWindow | null,
  turnId: string,
  message: AgentMessage
): void => {
  const turnLogger = agentTurnRegistry.getTurnLogger(turnId);
  const rendererSessionId = agentTurnRegistry.getRendererSession(turnId);
  const timestamp = Date.now();
  turnLogger?.trace({ messageType: message.type }, 'Processing agent message');

  // Post-result guard: after a successful result has been dispatched for this turn,
  // drop ALL subsequent messages to prevent stale text, phantom tool events, and
  // duplicate side effects (e.g. from task queue dequeue).
  // Cost is NOT re-recorded here because total_cost_usd is cumulative — recording
  // it again would double-count. The first result already captured the primary cost.
  if (agentTurnRegistry.hasSuccessResultDispatched(turnId)) {
    turnLogger?.warn(
      { turnId, messageType: message.type },
      'Dropping post-result message (success result already dispatched for this turn)'
    );
    return;
  }

  // Isolate tool hint collection errors to prevent state corruption
  const aggregator = getTurnAggregator(turnId);
  try {
    for (const toolEvent of collectToolHints(message)) {
      // For tool end events, the toolName from collectToolHints is the tool_use_id (wrong).
      // Look up the correct tool name from the aggregator before dispatching.
      if (toolEvent.stage === 'end' && toolEvent.toolUseId) {
        const resolvedName = aggregator.getToolNameByUseId(toolEvent.toolUseId);
        if (resolvedName) {
          toolEvent.toolName = resolvedName;

          // Inject sourcePackageId into mcpAppUiMeta for resource routing.
          // Resolved name format: "PackageId/tool_name" — extract the package ID prefix.
          if (toolEvent.mcpAppUiMeta) {
            const slashIdx = resolvedName.indexOf('/');
            if (slashIdx > 0) {
              toolEvent.mcpAppUiMeta.sourcePackageId = resolvedName.substring(0, slashIdx);
            }
          }
        }
      }

      dispatchAgentEvent(win, turnId, toolEvent);

      // Aggregate tool metrics for this turn
      if (toolEvent.stage === 'start') {
        // For MCP router use_tool calls, extract the inner tool (package_id/tool_id) from input
        const resolved = resolveEffectiveTool(toolEvent);
        const effectiveToolName = resolved.name;
        let toolParams: string[] | undefined;
        const _useToolArgs = resolved.useToolArgs;

        // Extract param names from tool input.
        // BOUNDED via safeParseDetail: malformed OR over-budget detail leaves
        // toolParams undefined (same as a parse failure).
        if (!toolParams && toolEvent.detail) {
          const parsedDetail = safeParseDetail(toolEvent.detail);
          if (parsedDetail.ok) {
            const input = parsedDetail.value as Record<string, unknown>;
            if (input && typeof input === 'object' && !Array.isArray(input)) {
              // For use_tool, extract params from args; otherwise from input directly
              const paramsSource = (input.args && typeof input.args === 'object' ? input.args : input) as Record<string, unknown>;
              toolParams = Object.keys(paramsSource);
            }
          }
        }

        // Normalize tool name for consistent tracking:
        // - Replace spaces with hyphens
        // - PRESERVE CASING: Super-MCP package IDs are case-sensitive (e.g., GoogleWorkspace, not googleworkspace)
        const normalizedToolName = effectiveToolName.replace(/\s+/g, '-');

        // Track tool usage for personalized shortcuts (exclude meta-tools)
        // Wrapped in try/catch to prevent store errors from breaking message handling
        const isMeta = isMetaTool(normalizedToolName);
        log.debug(
          { originalTool: toolEvent.toolName, effectiveTool: effectiveToolName, normalizedTool: normalizedToolName, isMeta, paramCount: toolParams?.length ?? 0 },
          'Tool usage tracking decision'
        );
        if (!isMeta) {
          // Async fire-and-forget: look up schema for typed params, then record usage.
          // Schema lookup is async and best-effort — falls back to bare param names.
          fireAndForget((async () => {
            try {
              let paramTypes: ParamTypeInfo[] | undefined;

              // Extract serverId/toolId from normalizedToolName (format: "serverId/toolId")
              const slashIdx = normalizedToolName.indexOf('/');
              if (slashIdx > 0 && toolParams && toolParams.length > 0) {
                const serverId = normalizedToolName.substring(0, slashIdx);
                const toolId = normalizedToolName.substring(slashIdx + 1);
                try {
                  const schema = await getToolSchema(serverId, toolId);
                  if (schema && typeof schema === 'object') {
                    paramTypes = extractParamTypesFromSchema(schema, toolParams);
                  }
                } catch {
                  // Schema lookup is best-effort — proceed with bare params
                }
              }

              recordToolUsage(normalizedToolName, toolParams, paramTypes);
              // Track for session-scoped badge evaluation
              if (rendererSessionId) {
                recordToolUseForSession(rendererSessionId, normalizedToolName);
              }
            } catch {
              // Silently ignore - tool tracking is non-critical
            }
          })(), 'agentMessageHandler.line1906');
        }
        
        // Log subagent tool calls (Task and Agent) for debugging MCP inheritance
        if (isSubAgentTool(toolEvent.toolName)) {
          // BOUNDED via safeParseDetailRecord: malformed, over-budget, OR
          // non-object valid JSON logs the "could not parse input" branch (same
          // as the pre-migration try/catch fallback). No detail → empty record.
          const parseResult = toolEvent.detail
            ? safeParseDetailRecord(toolEvent.detail)
            : ({ ok: true, value: {} } as const);
          if (parseResult.ok) {
            const taskInput = parseResult.value as Record<string, unknown> & {
              subagent_type?: string;
              agent?: string;
              description?: string;
              prompt?: string;
            };
            turnLogger?.info(
              {
                toolName: toolEvent.toolName,
                subagentType: taskInput.subagent_type ?? taskInput.agent,
                taskDescription: taskInput.description,
                promptLength: taskInput.prompt?.length ?? 0,
                parentToolUseId: toolEvent.parentToolUseId,
              },
              'SUBAGENT: Sub-agent tool invoked - spawning sub-agent (check if sub-agent receives MCP tools)'
            );
          } else {
            turnLogger?.info(
              { toolName: toolEvent.toolName },
              'SUBAGENT: Sub-agent tool invoked (could not parse input)'
            );
          }
        }
        
        aggregator.recordToolStartWithDetail(effectiveToolName, toolEvent.toolUseId, toolEvent.parentToolUseId, toolEvent.detail ?? '');
      } else if (toolEvent.stage === 'end') {
        // For MCP router responses, extract package_id/tool_id and output_chars from the response
        let effectiveToolName = toolEvent.toolUseId 
          ? (aggregator.getToolNameByUseId(toolEvent.toolUseId) ?? toolEvent.toolName)
          : toolEvent.toolName;
        let effectiveOutputSize = toolEvent.outputChars ?? toolEvent.detail?.length ?? 0;
        
        // Try to parse Super-MCP response format for more accurate tracking.
        // BOUNDED via safeParseDetailRecord: malformed, over-budget, OR
        // non-object valid JSON uses the raw values (same as the pre-migration
        // try/catch fallback).
        if (toolEvent.detail) {
          const result = safeParseDetailRecord(toolEvent.detail);
          if (result.ok) {
            const output = result.value as {
              package_id?: string;
              tool_id?: string;
              telemetry?: { output_chars?: number };
            };
            // Super-MCP use_tool response has package_id, tool_id, and telemetry
            if (output.package_id && output.tool_id) {
              effectiveToolName = `${output.package_id}/${output.tool_id}`;
              // Use telemetry.output_chars if available (more accurate than raw length)
              if (output.telemetry?.output_chars) {
                effectiveOutputSize = output.telemetry.output_chars;
              }
            }
          }
        }
        
        // Use the structured is_error flag (set in collectToolHints from tool_result.is_error)
        // instead of the previous substring heuristic which had false positives
        const isError = toolEvent.isError ?? false;
        aggregator.recordToolEndWithSize(effectiveToolName, effectiveOutputSize, isError, toolEvent.toolUseId, toolEvent.detail);
        recordLargeInputTurnToolChars(turnId, effectiveToolName, effectiveOutputSize);
        
        // Log Task tool completion (subagent results) for debugging MCP inheritance
        const originalToolName = toolEvent.toolUseId 
          ? aggregator.getToolNameByUseId(toolEvent.toolUseId)
          : toolEvent.toolName;
        if (originalToolName && isSubAgentTool(originalToolName)) {
          const resultSnippet = toolEvent.detail?.slice(0, 500) ?? '';
          const hasToolErrors = resultSnippet.toLowerCase().includes('tool') && resultSnippet.toLowerCase().includes('error');
          const hasMcpErrors = resultSnippet.toLowerCase().includes('mcp');
          turnLogger?.info(
            {
              toolUseId: toolEvent.toolUseId,
              resultLength: toolEvent.detail?.length ?? 0,
              hasToolErrors,
              hasMcpErrors,
              resultSnippet: resultSnippet.slice(0, 200),
            },
            'SUBAGENT: Task tool completed - check result for MCP/tool access issues'
          );
        }
      }

      turnLogger?.debug(
        {
          stage: toolEvent.stage,
          toolName: toolEvent.toolName,
          detailLength: toolEvent.detail?.length ?? 0,
        },
        'Tool event dispatched to renderer'
      );

      // Monitor for MCP race condition indicators
      if (toolEvent.stage === 'start' && toolEvent.toolName.startsWith('mcp__')) {
        const activeTurns = agentTurnRegistry.getActiveTurnCount();
        if (activeTurns > 1) {
          turnLogger?.info(
            {
              toolName: toolEvent.toolName,
              turnId,
              activeConcurrentTurns: activeTurns,
              mcpMode: 'http',
            },
            'MCP tool call with concurrent agent turns detected - monitoring for race conditions'
          );
        }
      }
    }
  } catch (toolHintError: unknown) {
    turnLogger?.error(
      { err: toolHintError, messageType: message.type },
      'Error collecting tool hints from message'
    );
  }

  switch (message.type) {
    case 'system': {
      if ((message.subtype as string) === 'warning') {
        // Warning from Rebel Core — dispatch as non-blocking warning event
        const msgRec = message as Record<string, unknown>;
        const warningMessage = (msgRec.warningMessage as string) ?? 'An issue occurred';
        const category = msgRec.category as string | undefined;
        dispatchAgentEvent(win, turnId, {
          type: 'warning',
          message: warningMessage,
          category,
          timestamp,
        });
        turnLogger?.info(
          { category, warningMessage },
          'Warning event dispatched to renderer',
        );
        break;
      }
      if (message.subtype === 'init') {
        // Store the model used for this turn (for inclusion in result event).
        // When tier routing is active, the executor already set the actual user-facing
        // model (e.g. 'gpt-5.5') — don't overwrite with the base Claude model name
        // that the runtime reports (the proxy is transparent to the runtime).
        const existingModel = agentTurnRegistry.getTurnModel(turnId);
        if (message.model && !existingModel) {
          agentTurnRegistry.setTurnModel(turnId, message.model);
        }
        const toolList = Array.isArray(message.tools)
          ? message.tools.join(', ')
          : 'unknown tools';
        // Use the registry model (may be the actual routed model from tier routing)
        // rather than the runtime-reported model (which is always the base Claude name).
        const displayModel = agentTurnRegistry.getTurnModel(turnId) || message.model;
        dispatchAgentEvent(win, turnId, {
          type: 'status',
          message: `Agent initialized with model ${displayModel} (tools: ${toolList})${message.session_id ? ` • Session ${message.session_id}` : ''}`,
          timestamp,
        });
        turnLogger?.info(
          {
            model: message.model,
            displayModel,
            sessionId: message.session_id,
            tools: message.tools,
          },
          'Agent session initialized'
        );
      } else if (message.subtype === 'compact_boundary') {
        dispatchAgentEvent(win, turnId, {
          type: 'status',
          message: 'Context compacted to manage token limits.',
          timestamp,
        });
        turnLogger?.debug('Agent context compacted');
      } else if (message.subtype === 'status') {
        const statusRec = message as Record<string, unknown>;
        const statusMessage = typeof statusRec.message === 'string'
          ? statusRec.message
          : message.status === 'compacting'
            ? 'Context compacting to keep things moving.'
            : 'Working on it...';
        dispatchAgentEvent(win, turnId, {
          type: 'status',
          message: statusMessage,
          timestamp,
        });
        turnLogger?.debug({ status: message.status, statusMessage }, 'Agent status update');
      }
      break;
    }

    case 'assistant': {
      // FIRST: Extract text content to check for retriable errors BEFORE dispatching any error events
      // This ensures extended context errors throw to trigger retry without showing error to user
      const text = extractTextFromContent(message.message.content ?? []);
      
      // Check for extended context error FIRST - this is retriable and should NOT dispatch error event
      // The agentTurnExecutor has fallback logic to retry with API key or 200K context
      if (text && isExtendedContextUnavailableError(text)) {
        turnLogger?.warn(
          { preview: text.slice(0, 200) },
          'Long context beta error in assistant message - throwing to trigger retry (NOT dispatching error event)'
        );
        throw new Error(text);
      }
      
      // Check for thinking model permission error - throw to trigger fallback
      if (text && isThinkingModelUnavailableError(text)) {
        turnLogger?.warn(
          { preview: text.slice(0, 200) },
          'Opus model permission error in assistant message - throwing to trigger fallback'
        );
        throw new Error(text);
      }
      
      // Check for structured error from runtime (deterministic, preferred over text matching)
      // The runtime may populate message.error for API-level errors like billing, auth, rate limits
      const sdkError = message.error;
      if (sdkError) {
        // For 'unknown' errors, try to detect the actual error type from assistant text
        // The runtime often sends 'unknown' for 500/api_error instead of 'server_error'
        let effectiveError: AgentAssistantMessageError = sdkError;
        if (sdkError === 'unknown' && text) {
          const lowerText = text.toLowerCase();
          if (lowerText.includes('api_error') || lowerText.includes('internal server error') ||
              /^api error: \d{3}\s*\{/.test(lowerText)) {
            effectiveError = 'server_error';
          }
        }

        const errorMessage = mapAgentErrorToUserMessage(effectiveError);
        const errorDispatchOptions = (() => {
          switch (effectiveError) {
            case 'authentication_failed':
              return { errorKindOverride: 'auth' as const, markActionable: true };
            case 'billing_error':
              return { errorKindOverride: 'billing' as const, markActionable: true };
            case 'invalid_request':
              return { errorKindOverride: 'invalid_request' as const, markActionable: false };
            // rate_limit / server_error / max_output_tokens preserved the prior
            // default behavior (generic 'unknown' kind, non-actionable). Grouped
            // explicitly so the assertNever default keeps the switch exhaustive.
            case 'rate_limit':
            case 'server_error':
            case 'max_output_tokens':
            case 'unknown':
              return { errorKindOverride: 'unknown' as const, markActionable: false };
            default:
              return assertNever(effectiveError, 'AgentAssistantMessageError');
          }
        })();
        const isActionable = errorDispatchOptions.markActionable;

        turnLogger?.warn(
          { sdkError, effectiveError, isActionable, mapped: errorMessage },
          'Agent assistant message has structured error'
        );

        // Track for product analytics (all errors go to RudderStack)
        trackMainEvent({
          anonymousId: getOrGenerateAnonymousId(),
          event: 'SDK Assistant Error', // Historical analytics event name — kept for continuity
          properties: { errorType: sdkError as string, effectiveErrorType: effectiveError as string, isUserActionable: isActionable },
        });

        // Rate limit errors are retriable - throw to trigger fallback to API key in agentTurnExecutor
        // This allows users on OAuth (Claude Max) to fall back to their own API key
        if (effectiveError === 'rate_limit') {
          turnLogger?.warn(
            { sdkError },
            'Rate limit error - throwing to trigger API key fallback (if available)'
          );
          throw createRoutedError('rate_limit', errorMessage);
        }

        // Server errors are transient - throw to trigger automatic retry in agentTurnExecutor
        if (effectiveError === 'server_error') {
          turnLogger?.warn(
            { sdkError },
            'Server error - throwing to trigger automatic retry'
          );
          throw createRoutedError('server_error', errorMessage);
        }

        // Request-too-large errors (413) arrive as structured invalid_request from the runtime.
        // These indicate the accumulated session payload exceeds the upstream size limit.
        // Throw so turnErrorRecovery classifies this as context_overflow and triggers
        // session-clearing recovery (compaction + retry without resume).
        if (effectiveError === 'invalid_request' && text) {
          const lowerText = text.toLowerCase();
          if (lowerText.includes('request too large') || lowerText.includes('request_too_large') ||
              (lowerText.includes('413') && lowerText.includes('request'))) {
            turnLogger?.warn(
              { sdkError, preview: text.slice(0, 200) },
              'Request-too-large detected in structured runtime error — throwing to trigger session recovery'
            );
            throw createRoutedError('invalid_request', text);
          }
          if (
            lowerText.includes('image exceeds') &&
            lowerText.includes('maximum') &&
            lowerText.includes('bytes')
          ) {
            const imageSizeCopy =
              'One of your images is over the 5 MB per-image limit. Try a smaller or lower-resolution version.';
            turnLogger?.warn(
              { sdkError, preview: text.slice(0, 200) },
              'Anthropic per-image size limit hit — dispatching user-friendly error'
            );
            trackMainEvent({
              anonymousId: getOrGenerateAnonymousId(),
              event: 'SDK Assistant Error',
              properties: {
                errorType: 'invalid_request',
                effectiveErrorType: 'attachment_size',
                isUserActionable: true,
                detectedVia: 'anthropic_image_size_text',
              },
            });
            dispatchAgentErrorEvent(win, turnId, new Error(imageSizeCopy), {
              humanizedOverride: imageSizeCopy,
              errorKindOverride: 'invalid_request',
              markActionable: true,
              timestampOverride: timestamp,
            });
            break;
          }
        }

        // Dispatch as error event (not assistant text)
        dispatchAgentErrorEvent(win, turnId, new Error(errorMessage), {
          humanizedOverride: errorMessage,
          errorKindOverride: errorDispatchOptions.errorKindOverride,
          markActionable: errorDispatchOptions.markActionable,
          timestampOverride: timestamp,
        });

        // Don't also dispatch as assistant text - the error IS the message
        break;
      }

      // Normal assistant message handling
      if (text) {

        // FALLBACK: Check for specific billing error patterns in text
        // Only trigger on patterns that would ONLY appear in API error messages, not in normal conversation
        // e.g., "Credit balance is too low" is runtime-specific, while "credit balance" alone is too vague
        // This is a conservative fallback in case the runtime doesn't populate the error field
        const lowerText = text.toLowerCase();
        const isSdkBillingError =
          lowerText.includes('credit balance is too low') || // Exact runtime error phrase
          lowerText.includes('insufficient_credit') || // API error code format
          (text.length < 200 && lowerText.includes('billing error')); // Short msg with billing error = likely runtime error

        if (isSdkBillingError) {
          turnLogger?.warn(
            { preview: text.slice(0, 200), textLength: text.length },
            'Billing error detected via text fallback - error field was not populated'
          );

          // Track for product analytics
          trackMainEvent({
            anonymousId: getOrGenerateAnonymousId(),
            event: 'SDK Assistant Error', // Historical analytics event name — kept for continuity
            properties: { errorType: 'billing_error', isUserActionable: true, detectedVia: 'text_fallback' },
          });

          // Dispatch as error event with actionable message
          const billingErrorCopy =
            "Your API account needs billing attention. Add credits at your provider's console.";
          dispatchAgentErrorEvent(win, turnId, new Error(billingErrorCopy), {
            humanizedOverride: billingErrorCopy,
            errorKindOverride: 'billing',
            timestampOverride: timestamp,
          });
          break;
        }

        // Check for synthetic usage-limit messages from Claude Max.
        // MULTI-PROVIDER NOTE: `<synthetic>` is currently Claude Max-specific.
        // If other providers emit synthetic usage-cap assistants, add provider-
        // specific markers at this seam instead of widening this predicate.
        // When the subscription hits its daily cap the runtime emits an assistant message with
        // model "<synthetic>" and text like "You've hit your limit · resets 6pm ...".
        // These bypass the structured error field, so we detect them via text + model marker
        // and throw a routed rate-limit error to trigger API key fallback in agentTurnExecutor.
        const assistantModel = (message.message as unknown as Record<string, unknown>)?.model;
        if (assistantModel === '<synthetic>' && isRateLimitMessage(text)) {
          turnLogger?.warn(
            { preview: text.slice(0, 200), model: assistantModel },
            'Synthetic usage-limit message from Claude Max - throwing to trigger API key fallback'
          );
          throw new ModelError('rate_limit', text, 429, 'Anthropic', {
            limitScope: 'plan',
          });
        }

        // Check for tool name length error in assistant text (synthetic API error text).
        // During resume, corrupted tool names (>200 chars) in the upstream session cause
        // 400 errors on every attempt. The runtime may surface these as assistant text rather than
        // structured errors. When resuming, throw a routed tool_name_corrupt error to trigger session
        // recovery in agentTurnExecutor (clear corrupt session, rebuild context from disk).
        // See: rebel://conversation/963ed81f-6ba8-4774-ade3-72fd9ede76f7 for the original case.
        if (isToolNameLengthError(text)) {
          // Genuine MCP config error; fall through to dispatch as assistant text.
        }

        // Check if assistant text is actually an API error being returned as text
        // Use routed invalid_request so agentTurnExecutor's inner catch re-throws to outer catch
        // where humanizeError() converts it to a user-friendly message
        if (isApiErrorInText(text)) {
          turnLogger?.warn(
            { preview: text.slice(0, 200) },
            'API error detected in assistant text - throwing to trigger error handling'
          );
          throw createRoutedError('invalid_request', text);
        }

        // Always dispatch assistant messages as-is. Context overflow detection via text
        // pattern matching caused false positives when Claude naturally mentioned terms
        // like "context limit" in conversation. Context overflow is handled via:
        // 1. Auto-compaction (signaled by compact_boundary message)
        // 2. API errors caught in agentTurnExecutor.ts error handler
        // Strip leaked <invoke> XML that the model sometimes emits as text
        // instead of structured tool_use blocks.
        const sanitizedText = stripLeakedInvokeXml(text);
        dispatchAgentEvent(win, turnId, {
          type: 'assistant',
          text: sanitizedText,
          timestamp,
        });
        turnLogger?.debug({ preview: sanitizedText.slice(0, 120) }, 'Assistant message received');
      }
      break;
    }

    case 'result': {
      // Check if this is an error result from the runtime
      const isErrorResult = message.subtype !== 'success' && message.is_error;

      if (isErrorResult) {
        // Runtime returned a structured error - check the errors array for context overflow
        const errors = (message as Record<string, unknown>).errors as string[] | undefined;
        const errorText = errors?.join('\n') ?? '';
        const lowerErrorText = errorText.toLowerCase();
        const errorOutcome = classifyTurnOutcomeFromError(errorText);

        // Track cost for error results (Anthropic bills regardless of success/failure).
        // Must be before any throw statements to ensure cost is always captured.
        if (message.total_cost_usd != null) {
          const errorCategory = agentTurnRegistry.getTurnCategory(turnId);
          const errorAuthMethod = agentTurnRegistry.getTurnAuthMethod(turnId);
          const errorModelUsageKeys = message.modelUsage ? Object.keys(message.modelUsage) : [];
          const errorCostModel = errorModelUsageKeys.length > 0
            ? errorModelUsageKeys.join(' + ')
            : agentTurnRegistry.getTurnModel(turnId);
          const errorTokens = aggregateTokensFromModelUsage(message);
          const errorModelUsageMap = buildCompactModelUsage(message);
          const errorToolCalls = getTurnAggregator(turnId)?.getToolMetrics()?.totalToolCalls;
          const errorOrProvider = extractOpenRouterProviderFromModelUsage(message);
          appendCostEntry({
            ts: timestamp,
            cost: message.total_cost_usd,
            sid: rendererSessionId ?? undefined,
            tid: turnId,
            cat: errorCategory ?? 'error',
            m: errorCostModel,
            mu: errorModelUsageMap,
            auth: errorAuthMethod ?? undefined,
            outcome: errorOutcome,
            ...errorTokens,
            ...(errorToolCalls != null ? { toolCalls: errorToolCalls } : {}),
            ...(errorOrProvider ? { orProvider: errorOrProvider } : {}),
          });
          agentTurnRegistry.markCostRecorded(turnId);
        }
        flushCostOutcomeResolutions(turnId, errorOutcome);

        // Check for rate limit patterns in runtime error messages
        // Rate limits can arrive via result.errors in addition to assistant.message.error
        // MULTI-PROVIDER STATUS: `isRateLimitMessage()` now covers the common
        // OpenAI/OpenRouter/Gemini text markers (`rate_limit*`, 429, and
        // `resource_exhausted`) while structured provider errors remain the
        // primary path. Keep this as a conservative text fallback only.
        const isRateLimitError = isRateLimitMessage(errorText);

        if (isRateLimitError) {
          turnLogger?.warn(
            { subtype: message.subtype, errors },
            'Rate limit detected in result message - throwing to trigger API key fallback'
          );
          throw createRoutedError('rate_limit', 'Rate limit reached. Please wait a moment and try again.');
        }

        // Check for stale/expired session resume failures
        // The runtime returns this when trying to resume a session that no longer exists server-side
        // (e.g., session expired, or auth context changed). Throw to trigger retry without resume.
        const isSessionNotFoundError = lowerErrorText.includes('no conversation found with session id');
        if (isSessionNotFoundError) {
          turnLogger?.warn(
            { subtype: message.subtype, errors },
            'Session not found - throwing to trigger retry without resume'
          );
          throw createRoutedError('session_not_found', errorText);
        }

        // Check for context overflow patterns in error messages.
        // Must match both Anthropic and non-Claude provider phrasings (multi-model turns).
        // OpenAI: "maximum context length is X tokens"
        // Google: "input token count exceeds the maximum number of tokens allowed"
        // Anthropic: "prompt is too long", "request too large"
        const isContextOverflowError =
          (lowerErrorText.includes('prompt') &&
            (lowerErrorText.includes('too long') || lowerErrorText.includes('too large'))) ||
          (lowerErrorText.includes('context') &&
            (lowerErrorText.includes('limit') || lowerErrorText.includes('exceed') || lowerErrorText.includes('length'))) ||
          (lowerErrorText.includes('token') &&
            (lowerErrorText.includes('exceed') || lowerErrorText.includes('maximum'))) ||
          lowerErrorText.includes('request too large');

        if (isContextOverflowError) {
          // Don't double-dispatch if already handled by error path in agentTurnExecutor
          if (!agentTurnRegistry.hasContextOverflowDispatched(turnId)) {
            agentTurnRegistry.markContextOverflowDispatched(turnId);
            const originalPrompt = agentTurnRegistry.getTurnPrompt(turnId) ?? '';
            turnLogger?.warn(
              { subtype: message.subtype, errors, originalPromptLength: originalPrompt.length },
              'Context overflow detected in result message'
            );
            dispatchAgentEvent(win, turnId, {
              type: 'context_overflow',
              originalPrompt,
              timestamp,
            });
          }
        } else if (isToolNameLengthError(errorText)) {
          turnLogger?.warn(
            { subtype: message.subtype, errors },
            'Tool name too long detected in result message'
          );
          const toolNameTooLongCopy =
            "One of your MCP tools has a name that's too long for the AI provider. Try disconnecting MCP servers with unusually long tool names, or contact the tool developer.";
          dispatchAgentErrorEvent(win, turnId, new Error(toolNameTooLongCopy), {
            humanizedOverride: toolNameTooLongCopy,
            timestampOverride: timestamp,
          });
        } else {
          // Suppress benign runtime internal errors that don't affect user work
          // "only prompt commands are supported in streaming mode" can occur after
          // a successful result when the runtime encounters internal state inconsistencies
          const isBenignRuntimeError = lowerErrorText.includes('only prompt commands are supported in streaming mode');

          if (isBenignRuntimeError) {
            turnLogger?.debug(
              { subtype: message.subtype, errors },
              'Suppressing benign runtime error (turn already completed successfully)'
            );
          } else {
            // Non-overflow runtime error — dispatch as error event.
            //
            // Classification-first (Stage 3 of 260421_classification_driven_error_humanizer):
            // Previously this site passed a pre-computed `humanizedOverride` via the
            // classification-blind `humanizeError()` ladder, which short-circuited the
            // dispatcher's canonical `deriveErrorKind` chain (metadata → HTTP → billing →
            // rate_limit → auth). That broke conversation 82d61626 — an OpenAI 429
            // `insufficient_quota` body matched the generic `exceed` branch and showed
            // "That request was too large" instead of the correct billing copy.
            //
            // The fix is structural: hand the raw error text to `dispatchAgentErrorEvent`
            // so its classifier runs against the raw text (now with extended
            // `isBillingMessage` patterns), and pass a `providerOverride` derived from the
            // turn's selected model so CTA routing + humanizer copy pick up the right
            // provider when the raw body omits provider tags.
            // Dedup guard (Stage 4 of 260421_classification_driven_error_humanizer):
            // The SDK runtime can emit `error_during_execution` twice for the same turn
            // (observed in conversation 82d61626). Stage 3 made the first dispatch carry
            // the correct classification; Stage 4 suppresses any subsequent duplicate so
            // a stale classification-free event cannot overwrite the correct one.
            //
            // Mark-AFTER-success semantics: only latch the flag if
            // `dispatchAgentErrorEvent` returns `{ok: true}`. If the dispatch fails
            // (throws or returns `{ok: false}`), the flag is NOT latched — otherwise a
            // dispatcher failure would silence every subsequent error for the turn and
            // leave the user in a stuck-busy state.
            // Resolve turn context early so it can enrich suppression telemetry too.
            // (See lens-operational R1 finding: breadcrumbs without turnModel/provider
            // make production diagnosis harder than it needs to be.)
            const turnModel = agentTurnRegistry.getTurnModel(turnId);
            const activeProvider = agentTurnRegistry.getTurnActiveProvider(turnId);
            // Mindstone subscription routes through OpenRouter with claude-* models.
            // Model-based inference would map claude-* → "Anthropic", but the user
            // never configured an Anthropic key — attribute the error to Mindstone.
            const providerOverride = activeProvider === 'mindstone'
              ? 'Mindstone'
              : turnModel
                ? inferProviderDisplayFromModelId(turnModel)
                : undefined;

            if (agentTurnRegistry.hasErrorResultDispatched(turnId)) {
              turnLogger?.warn(
                { subtype: message.subtype, errors, turnModel, provider: providerOverride },
                'Suppressing duplicate runtime-result error dispatch for turn (already dispatched)'
              );
              getErrorReporter().addBreadcrumb({
                category: 'agent.error.dedup',
                level: 'warning',
                message: 'Suppressed duplicate runtime-result error dispatch',
                data: { turnId, subtype: message.subtype, turnModel, provider: providerOverride },
              });
              // Aggregate observability: tracker event wrapped in try/catch — a tracker
              // failure must not break error handling.
              try {
                trackMainEvent({
                  anonymousId: getOrGenerateAnonymousId(),
                  event: 'ai_error_dispatch_dedup_suppressed',
                  properties: {
                    subtype: String(message.subtype),
                    ...(turnModel ? { turnModel } : {}),
                    ...(providerOverride ? { provider: providerOverride } : {}),
                  },
                });
              } catch (trackingError) {
                turnLogger?.debug(
                  { err: trackingError },
                  'trackMainEvent failed for dedup suppression'
                );
              }
              return;
            }

            turnLogger?.error(
              { subtype: message.subtype, errors },
              'Runtime returned error result'
            );
            const dispatchResult = dispatchAgentErrorEvent(
              win,
              turnId,
              errorText || `Agent error: ${message.subtype}`,
              providerOverride ? { providerOverride } : undefined,
            );
            if (dispatchResult?.ok === true) {
              agentTurnRegistry.markErrorResultDispatched(turnId);
            }
          }
        }
      } else {
        // Success result - but first check if it's actually an API error returned as text
        let resultText = (message as Record<string, unknown>).result as string ?? '';

        // Append to cost ledger early (fire-and-forget).
        // Placed before throw-based retry/fallback checks below so that costs for
        // billed-but-retried attempts (extended context, Opus fallback, API error in
        // text, empty_result_anomaly) are always captured. Anthropic bills regardless
        // of whether we treat the result as success or throw for retry.
        if (message.total_cost_usd != null) {
          const successCategory = agentTurnRegistry.getTurnCategory(turnId);
          const successAuthMethod = agentTurnRegistry.getTurnAuthMethod(turnId);
          // Prefer actual model(s) from modelUsage over the requested alias from the registry.
          // When the proxy routes to a non-Claude model, modelUsage keys reflect what actually served.
          const costModelUsageKeys = message.modelUsage ? Object.keys(message.modelUsage) : [];
          const costModel = costModelUsageKeys.length > 0
            ? costModelUsageKeys.join(' + ')
            : agentTurnRegistry.getTurnModel(turnId);
          // Use modelUsage for token aggregates — message.usage only reflects the
          // LAST API call in a tool-use loop, not the full session total.
          const successTokens = aggregateTokensFromModelUsage(message);
          const successModelUsageMap = buildCompactModelUsage(message);
          const successToolCalls = getTurnAggregator(turnId)?.getToolMetrics()?.totalToolCalls;
          const successOrProvider = extractOpenRouterProviderFromModelUsage(message);
          const appendResult = appendCostEntry({
            ts: timestamp,
            cost: message.total_cost_usd,
            sid: rendererSessionId ?? undefined,
            tid: turnId,
            cat: successCategory,
            m: costModel,
            mu: successModelUsageMap,
            auth: successAuthMethod ?? undefined,
            ...successTokens,
            ...(successToolCalls != null ? { toolCalls: successToolCalls } : {}),
            ...(successOrProvider ? { orProvider: successOrProvider } : {}),
          });
          if (appendResult?.costEntryId) {
            enqueueCostOutcomeResolution(turnId, {
              costEntryId: appendResult.costEntryId,
              ledgerRowTs: timestamp,
              ...(rendererSessionId ? { ledgerRowSid: rendererSessionId } : {}),
              ledgerRowTid: turnId,
            });
          }
          agentTurnRegistry.markCostRecorded(turnId);
        }

        // Check if the result text is actually a long context beta error
        // The runtime sometimes returns API errors as successful results with the error in the text
        if (isExtendedContextUnavailableError(resultText)) {
          turnLogger?.warn(
            { resultPreview: resultText.slice(0, 200) },
            'Long context beta error detected in result text - throwing to trigger retry'
          );
          // Throw to trigger retry logic in agentTurnExecutor.ts
          throw new Error(resultText);
        }
        
        // Check for thinking model permission error in result text
        if (isThinkingModelUnavailableError(resultText)) {
          turnLogger?.warn(
            { resultPreview: resultText.slice(0, 200) },
            'Opus model permission error detected in result text - throwing to trigger fallback'
          );
          throw new Error(resultText);
        }

        // Check if the result text is actually an API error (e.g., "API Error: 500 {...}")
        // The runtime sometimes returns API errors as successful results
        // Use routed invalid_request so agentTurnExecutor's inner catch re-throws to outer catch
        // where humanizeError() converts it to a user-friendly message
        if (resultText && isApiErrorInText(resultText)) {
          turnLogger?.warn(
            { resultPreview: resultText.slice(0, 200) },
            'API error detected in result text - throwing to trigger error handling'
          );
          throw createRoutedError('invalid_request', resultText);
        }

        // Check for tool name length error in result text (corrupt resumed session).
        // Surface API validation errors that arrive in successful result text.
        if (isToolNameLengthError(resultText)) {
          turnLogger?.warn(
            { resultPreview: resultText.slice(0, 200) },
            'Tool name length error in result text - treating as MCP configuration issue'
          );
        }

        // Check for empty result anomaly.
        //
        // IMPORTANT: Use last_turn_output_tokens (final API call only), NOT
        // message.usage.output_tokens (which is the LOOP TOTAL across all turns).
        // A normal multi-turn tool session can have 1000+ loop-total tokens from
        // tool-use turns but 0 final-turn tokens when the model has nothing more
        // to say — that's legitimate, not an anomaly.
        //
        // See: docs/plans/260417_empty_result_anomaly_resilience.md
        const lastTurnOutputTokens = message.last_turn_output_tokens;
        const loopTotalOutputTokens = message.usage?.output_tokens ?? 0;
        // Use final-turn tokens when available (Rebel Core runtime); fall back to
        // loop total for legacy/SDK paths where the field isn't present.
        const anomalyTokens = lastTurnOutputTokens ?? loopTotalOutputTokens;

        if (!resultText && anomalyTokens > 0) {
          // Try to recover from accumulated content first.
          // The accumulator contains assistant messages that were already streamed
          // to the user, so using them avoids expensive retries and duplicate tool execution.
          const accumulated = agentTurnRegistry.getContextAccumulator(turnId);
          const assistantMessages = accumulated?.messages?.filter(
            (m) => m.role === 'assistant' && m.text && m.text.trim().length > 0
          ) ?? [];
          const lastAssistantMessage = assistantMessages.length > 0
            ? assistantMessages[assistantMessages.length - 1]
            : undefined;
          
          // Recover if we have any non-trivial content. Any non-empty trimmed text
          // is valid recovery material since it was already streamed to the user.
          // See: rebel://conversation/c75180b3-a3c3-4aa3-b637-0efa162f9fa1
          const hasSubstantialContent = lastAssistantMessage?.text &&
            lastAssistantMessage.text.trim().length > 0;
          
          if (hasSubstantialContent) {
            turnLogger?.info(
              {
                lastTurnOutputTokens,
                loopTotalOutputTokens,
                recoveredTextLength: lastAssistantMessage.text.length,
                assistantMessageCount: assistantMessages.length,
              },
              'Empty result with tokens - recovering from accumulated assistant content (avoiding retry)'
            );
            resultText = lastAssistantMessage.text;
          } else {
            // Classify "pause" turns — turns that ended cleanly because the agent
            // is waiting for the user (e.g. AskUserQuestion was intercepted by
            // userQuestionHook, which denies the tool via permissionDecision:'deny'
            // and dispatches a user_question event).
            //
            // Three signals with explicit pause_type classification:
            //
            //   1. Signal-based (primary): agentTurnRegistry.hasUserQuestionPending
            //      is set synchronously by userQuestionHook BEFORE the hook returns
            //      { continue: false }.
            //
            //   2. Event-based (primary): the same hook dispatches a user_question
            //      AgentEvent, which lands in the turn's accumulated events.
            //
            //   3. Tool-based (tertiary, ambiguous): the AskUserQuestion tool ended
            //      this turn. We intentionally do NOT filter by !isError here — a
            //      deny-and-retry produces tool/end with isError: true, still a
            //      legitimate terminal signal. (Original bug site; see 260420
            //      postmortem.) BUT: if BOTH primary signals are absent, something
            //      upstream has regressed (the hook didn't set the flag AND didn't
            //      emit the event) — we still classify the turn as a pause to
            //      avoid re-breaking the conversation, but we tag it `ambiguous`
            //      and capture it in Sentry so the regression is observable.
            //
            // Classification logic: if BOTH primary signals are set, `user_question`.
            // If only the tool signal is set, `ambiguous` (still treated as pause).
            // If no signal is set, raise empty_result_anomaly.
            const TERMINAL_TOOLS = new Set(['AskUserQuestion']);
            const turnEvents = accumulated?.eventsByTurn[turnId] ?? [];
            const hasUserQuestionPending = agentTurnRegistry.hasUserQuestionPending(turnId);
            const hasUserQuestionEvent = turnEvents.some((e) => e.type === 'user_question');
            const toolEvents = turnEvents
              .filter((e): e is Extract<typeof e, { type: 'tool' }> =>
                e.type === 'tool' && 'stage' in e && e.stage === 'end');
            const lastTool = toolEvents.at(-1);
            const lastToolName = lastTool && 'toolName' in lastTool
              ? (lastTool.toolName as string) : '';
            const isTerminalToolTurn = !!(lastTool && TERMINAL_TOOLS.has(lastToolName));

            let pauseType: 'user_question' | 'ambiguous' | 'none' = 'none';
            if (hasUserQuestionPending && hasUserQuestionEvent) {
              pauseType = 'user_question';
            } else if (hasUserQuestionPending || hasUserQuestionEvent || isTerminalToolTurn) {
              // Exactly one of the three signals is present. Treat as pause
              // (safer than re-breaking the turn) but flag the asymmetry.
              pauseType = 'ambiguous';
            }

            if (pauseType === 'ambiguous') {
              turnLogger?.warn(
                {
                  lastTurnOutputTokens,
                  loopTotalOutputTokens,
                  pauseType,
                  hasUserQuestionPending,
                  hasUserQuestionEvent,
                  terminalTool: isTerminalToolTurn ? lastToolName : undefined,
                },
                'Empty result — ambiguous pause classification (only one of three user_question signals matched)'
              );
              try {
                getErrorReporter().captureMessage(
                  'empty_result_ambiguous_pause_classification',
                  {
                    level: 'warning',
                    tags: {
                      source: 'rebel-core-runtime',
                      sdk_error_category: 'empty_result_pause',
                      pause_type: 'ambiguous',
                      regression: 'pause_signal_mismatch',
                    },
                    extra: {
                      turnId,
                      hasUserQuestionPending,
                      hasUserQuestionEvent,
                      isTerminalToolTurn,
                      terminalToolName: lastToolName,
                    },
                  }
                );
              } catch {
                // Error reporter unavailable (e.g., unit tests without bootstrap);
                // log path above already preserves the signal for manual triage.
              }
            } else if (pauseType === 'user_question') {
              turnLogger?.info(
                {
                  lastTurnOutputTokens,
                  loopTotalOutputTokens,
                  pauseType,
                  hasUserQuestionPending,
                  hasUserQuestionEvent,
                  terminalTool: isTerminalToolTurn ? lastToolName : undefined,
                },
                'Empty result — user question pending, valid pause turn (not anomaly)'
              );
            } else {
              // No pause signals. Before throwing, check if this is a legitimate
              // "done after tools" outcome: the model completed real tool work and
              // returned end_turn with only minimal final-turn tokens (e.g.
              // thinking-budget tokens or formatting whitespace) but no text.
              // This catches the REBEL-1G0 case where lastTurnOutputTokens > 0 is
              // small but the turn had genuine execution. Without this exemption
              // the user sees "I completed some actions but the final response was
              // lost" on a turn that actually completed normally.
              // See: docs-private/postmortems/260430_*  and REBEL-1G0.
              const doneAfterTools = isLegitimateDoneAfterTools({
                turnEvents,
                executorToolCount: message.executor_tool_count ?? 0,
                stopReason: message.stop_reason,
              });

              if (doneAfterTools.ok) {
                turnLogger?.info(
                  {
                    lastTurnOutputTokens,
                    loopTotalOutputTokens,
                    executorToolCount: message.executor_tool_count ?? 0,
                    meaningfulToolEnds: doneAfterTools.meaningfulToolEnds,
                    stopReason: message.stop_reason,
                  },
                  'Model done after tools (small final-turn tokens) — synthesizing brief acknowledgment so the turn is user-visible'
                );
                resultText = 'Done.';
              } else {
                const anomalyModel = agentTurnRegistry.getTurnModel(turnId) ?? 'unknown';
                const anomalyModelUsageKeys = message.modelUsage
                  ? Object.keys(message.modelUsage as Record<string, unknown>)
                  : [];
                turnLogger?.warn(
                  {
                    lastTurnOutputTokens,
                    loopTotalOutputTokens,
                    costUsd: message.total_cost_usd,
                    hasAccumulated: !!accumulated,
                    assistantMessageCount: assistantMessages.length,
                    lastMessageLength: lastAssistantMessage?.text?.length ?? 0,
                    model: anomalyModel,
                    modelUsageKeys: anomalyModelUsageKeys,
                    stopReason: message.stop_reason,
                    numTurns: message.num_turns,
                    executorToolCount: message.executor_tool_count ?? 0,
                    meaningfulToolEnds: doneAfterTools.meaningfulToolEnds,
                  },
                  'Empty result despite output tokens - throwing empty_result_anomaly'
                );
                throw new EmptyResultAnomalyError({
                  lastTurnOutputTokens,
                  loopTotalOutputTokens,
                  model: anomalyModel,
                  stopReason: message.stop_reason,
                });
              }
            }
          }
        }

        // "Model done after tools" — safety net for the
        // `lastTurnOutputTokens === 0` case (`anomalyTokens` is 0 above so the
        // first block was skipped). The first block already handles the
        // `undefined`/`null`/positive-tokens cases via `isLegitimateDoneAfterTools`.
        // Kept here so legacy/SDK paths and runtimes that report exactly 0
        // final-turn tokens after real tool work still get a "Done." synthesis
        // (or the anomaly throw when execution wasn't real).
        if (!resultText && loopTotalOutputTokens > 0 && (lastTurnOutputTokens === 0 || lastTurnOutputTokens === undefined) && message.stop_reason === 'end_turn') {
          const accumulated = agentTurnRegistry.getContextAccumulator(turnId);
          const turnEvents = accumulated?.eventsByTurn[turnId] ?? [];
          const hasUserQuestionPending = agentTurnRegistry.hasUserQuestionPending(turnId);
          const hasUserQuestionEvent = turnEvents.some((e) => e.type === 'user_question');

          // Don't synthesize "Done." when the turn is paused waiting for a user
          // question response — the AskUserQuestion card is already displayed.
          if (!hasUserQuestionPending && !hasUserQuestionEvent) {
            const executorToolCount = message.executor_tool_count ?? 0;
            const doneAfterTools = isLegitimateDoneAfterTools({
              turnEvents,
              executorToolCount,
              stopReason: message.stop_reason,
            });

            if (doneAfterTools.ok) {
              turnLogger?.info(
                {
                  lastTurnOutputTokens,
                  loopTotalOutputTokens,
                  executorToolCount,
                  meaningfulToolEnds: doneAfterTools.meaningfulToolEnds,
                  stopReason: message.stop_reason,
                },
                'Model done after tools — synthesizing brief acknowledgment so the turn is user-visible'
              );
              resultText = 'Done.';
            } else {
              const anomalyModel = agentTurnRegistry.getTurnModel(turnId) ?? 'unknown';
              turnLogger?.warn(
                {
                  lastTurnOutputTokens,
                  loopTotalOutputTokens,
                  executorToolCount,
                  meaningfulToolEnds: doneAfterTools.meaningfulToolEnds,
                  stopReason: message.stop_reason,
                  model: anomalyModel,
                  costUsd: message.total_cost_usd,
                },
                'Empty result with planning tokens but no real execution — throwing empty_result_anomaly'
              );
              throw new EmptyResultAnomalyError({
                lastTurnOutputTokens,
                loopTotalOutputTokens,
                model: anomalyModel,
                stopReason: message.stop_reason,
              });
            }
          }
        }

        // Zero output tokens with no result text — the provider/model returned
        // nothing at all. This is distinct from the anomaly check above (which
        // requires tokens > 0) and from "done after tools" (which requires
        // loopTotalOutputTokens > 0). When the provider gives us absolutely
        // nothing, surface it as an anomaly so error recovery can retry or show
        // a user-facing error instead of silently completing with an empty turn.
        // Still exempt user-question pauses (AskUserQuestion tool intercepted).
        if (!resultText && loopTotalOutputTokens === 0 && (lastTurnOutputTokens === 0 || lastTurnOutputTokens === undefined)) {
          const accumulated = agentTurnRegistry.getContextAccumulator(turnId);
          const turnEvents = accumulated?.eventsByTurn[turnId] ?? [];
          const hasUserQuestionPending = agentTurnRegistry.hasUserQuestionPending(turnId);
          const hasUserQuestionEvent = turnEvents.some((e) => e.type === 'user_question');

          if (!hasUserQuestionPending && !hasUserQuestionEvent) {
            const anomalyModel = agentTurnRegistry.getTurnModel(turnId) ?? 'unknown';
            turnLogger?.warn(
              {
                lastTurnOutputTokens,
                loopTotalOutputTokens,
                model: anomalyModel,
                stopReason: message.stop_reason,
                costUsd: message.total_cost_usd,
              },
              'Zero output tokens — provider/model returned no content, throwing empty_result_anomaly'
            );
            throw new EmptyResultAnomalyError({
              lastTurnOutputTokens,
              loopTotalOutputTokens,
              model: anomalyModel,
              stopReason: message.stop_reason,
            });
          }
        }

        // Mid-turn refusal (Fable 5 Stage 6): the provider's safety classifier
        // stopped the response after some text was already produced. Surface it
        // honestly via a status event — the partial text itself is dispatched
        // untouched below (no message mutation). Empty-text refusals never
        // reach here: they throw EmptyResultAnomalyError above (with the typed
        // stopReason field) and get the no-retry recovery path instead.
        if (message.stop_reason === 'refusal' && resultText) {
          turnLogger?.warn(
            {
              stopReason: message.stop_reason,
              resultTextLength: resultText.length,
              model: agentTurnRegistry.getTurnModel(turnId) ?? 'unknown',
              outputTokens: message.usage?.output_tokens,
            },
            'Result completed with stop_reason refusal — provider safety system stopped the response mid-turn'
          );
          dispatchAgentEvent(win, turnId, {
            type: 'status',
            message: "Anthropic's safety system stopped this response partway through.",
            timestamp,
          });
        }

        // Log stop_reason for diagnostics only. Currently stop_reason is null on
        // most/all result messages — it is NOT a reliable truncation signal.
        // The continuation machinery in agentTurnExecutor remains available if a
        // future runtime update exposes a meaningful stop_reason value.
        if (message.stop_reason !== 'end_turn') {
          turnLogger?.debug(
            { stopReason: message.stop_reason, outputTokens: message.usage?.output_tokens },
            'Result stop_reason (informational only)'
          );
        }

        flushCostOutcomeResolutions(turnId, { kind: 'success' });
        
        // Include tool metrics from the turn aggregator
        const aggregator = getTurnAggregator(turnId);
        const toolMetrics = aggregator?.getToolMetrics();
        const subAgentMetrics = aggregator?.getSubAgentMetrics();
        for (const artifact of aggregator?.getCreatedWorkArtifacts?.() ?? []) {
          mainTracking.workArtifactCreated({
            filePath: artifact.filePath,
            source: 'agent_tool',
            shared: artifact.shared,
            sessionId: rendererSessionId,
            turnId,
          });
        }
        
        // Derive the actual model(s) used from the result's modelUsage (ground truth)
        // rather than system.init which only reports the requested model alias.
        // This correctly reflects fallbacks (e.g., Opus 4.7 -> 4.6) and multi-model
        // turns (plan mode uses thinking model for planning + working model for execution).
        const modelUsageKeys = message.modelUsage ? Object.keys(message.modelUsage) : [];
        const actualModels = modelUsageKeys.length > 0
          ? modelUsageKeys
          : [agentTurnRegistry.getTurnModel(turnId)].filter((value): value is string => Boolean(value));
        const actualModel = actualModels.length > 0
          ? actualModels.join(' + ')
          : undefined;
        const modelUsageForEvent = buildEventModelUsage(message, turnId);

        if (!actualModel) {
          turnLogger?.warn(
            { turnId, modelUsageKeys, registryModel: agentTurnRegistry.getTurnModel(turnId) },
            'Null model on successful result — pricing audit gap'
          );
        }
        
        // Read the resolved context window from the turn registry (set by agentTurnExecutor
        // from resolveModelLimits — single source of truth, no shadow re-derivation).
        const contextWindow = agentTurnRegistry.getTurnContextWindow(turnId);
        
        // Total prompt tokens = input + cache creation + cache read (all are input tokens)
        const totalPromptTokens = (message.usage?.input_tokens ?? 0) +
          (message.usage?.cache_creation_input_tokens ?? 0) +
          (message.usage?.cache_read_input_tokens ?? 0);
        // Clamp to 100% max (can exceed if tokens > window due to edge cases)
        const contextUtilization = contextWindow && contextWindow > 0
          ? Math.min(100, Math.round((totalPromptTokens / contextWindow) * 100))
          : null;

        const diagnosisTokens = aggregateTokensFromModelUsage(message);
        const diagnosisTotalInputTokens = (diagnosisTokens.inTok ?? 0)
          + (diagnosisTokens.cacheReadTok ?? 0)
          + (diagnosisTokens.cacheCreateTok ?? 0);
        maybeLogLargeInputTurnBreakdown({
          logger: turnLogger ?? log,
          turnId,
          sessionId: rendererSessionId,
          breakdown: largeInputTurnBreakdowns.get(turnId) ?? createEmptyLargeInputTurnBreakdown(),
          totalInputTokens: diagnosisTotalInputTokens,
          model: actualModel,
        });
        largeInputTurnBreakdowns.delete(turnId);
        
        // Read per-turn settings snapshot from registry (set in agentTurnExecutor)
        const turnThinkingEffort = agentTurnRegistry.getTurnThinkingEffort(turnId);
        const turnAuthMethod = agentTurnRegistry.getTurnAuthMethod(turnId);
        const turnFallbacks = agentTurnRegistry.getTurnFallbacks(turnId);

        const finalResultText = stripLeakedInvokeXml(resultText);
        const outputShapeMetrics = computeOutputShapeMetrics(finalResultText);
        const turnEventsForInvariant = agentTurnRegistry.getContextAccumulator(turnId)?.eventsByTurn[turnId] ?? [];
        const emitSlackReplyInvariantLog = (
          slackReplyInvariant: { outcome: SlackReplyInvariantOutcome; toolCallCount: number } | null,
        ): void => {
          if (!slackReplyInvariant || !rendererSessionId) {
            return;
          }

          const invariantPayload = {
            event: 'slack_reply_invariant',
            sessionId: rendererSessionId,
            turnId,
            outcome: slackReplyInvariant.outcome,
            toolCallCount: slackReplyInvariant.toolCallCount,
          } as const;

          if (slackReplyInvariant.outcome === 'logged_only') {
            log.error(invariantPayload, 'slack_reply_invariant');
          } else if (slackReplyInvariant.outcome === 'continuation_skipped_already_retried') {
            log.warn(invariantPayload, 'slack_reply_invariant');
          } else {
            log.info(invariantPayload, 'slack_reply_invariant');
          }
        };

        const slackReplyInvariant = evaluateSlackReplyInvariant({
          sessionId: rendererSessionId,
          stopReason: message.stop_reason,
          turnEvents: turnEventsForInvariant,
        });

        if (isPromiseLike(slackReplyInvariant)) {
          void Promise.resolve(slackReplyInvariant)
            .then((resolvedInvariant) => {
              emitSlackReplyInvariantLog(resolvedInvariant);
            })
            .catch((err) => {
              log.warn({ err, sessionId: rendererSessionId, turnId }, 'slack_reply_invariant_evaluation_failed');
            });
        } else {
          emitSlackReplyInvariantLog(slackReplyInvariant);
        }

        dispatchAgentEvent(win, turnId, {
          type: 'result',
          text: finalResultText,
          model: actualModel,
          planningModel: agentTurnRegistry.getTurnPlanningModel(turnId),
          modelUsage: modelUsageForEvent,
          roles: buildModelRoles(turnId, modelUsageForEvent),
          usage: {
            inputTokens: message.usage?.input_tokens ?? null,
            outputTokens: message.usage?.output_tokens ?? null,
            cacheCreationTokens: message.usage?.cache_creation_input_tokens ?? null,
            cacheReadTokens: message.usage?.cache_read_input_tokens ?? null,
            costUsd: message.total_cost_usd ?? null,
            contextUtilization,
            contextWindow,
          },
          toolMetrics: toolMetrics ? {
            totalToolCalls: toolMetrics.totalToolCalls,
            failedToolCalls: toolMetrics.failedToolCalls,
            filesCreated: toolMetrics.filesCreated,
            filesEdited: toolMetrics.filesEdited,
            toolUsageByCategory: toolMetrics.toolUsageByCategory,
            mcpServerUsage: toolMetrics.mcpServerUsage,
            totalToolOutputChars: toolMetrics.totalToolOutputChars,
            mcpToolOutputChars: toolMetrics.mcpToolOutputChars,
            builtinToolOutputChars: toolMetrics.builtinToolOutputChars,
          } : undefined,
          outputShapeMetrics,
          subAgentMetrics: subAgentMetrics ? {
            usedSubAgents: subAgentMetrics.usedSubAgents,
            subAgentCount: subAgentMetrics.subAgentCount,
            subAgentToolCount: subAgentMetrics.subAgentToolCount,
          } : undefined,
          thinkingEffort: turnThinkingEffort,
          authMethod: turnAuthMethod,
          ...(turnFallbacks.length > 0 ? { fallbacks: turnFallbacks } : {}),
          turnEndReason: 'completed' as const,
          timestamp,
        });
        turnLogger?.info(
          {
            resultPreview: (((message as Record<string, unknown>).result as string) ?? '').slice(0, 160),
            model: actualModel,
            usage: message.usage,
            totalCostUsd: message.total_cost_usd,
            contextWindow,
            contextUtilization,
            totalPromptTokens,
            totalToolCalls: toolMetrics?.totalToolCalls ?? 0,
          },
          'Agent turn produced result'
        );

        // Mark that a successful result has been dispatched for this turn.
        // All subsequent messages (e.g. from task queue dequeue) will be
        // dropped by the top-level post-result guard at the start of handleAgentMessage.
        agentTurnRegistry.markSuccessResultDispatched(turnId);

        // Trigger memory update for successful turns (fire-and-forget)
        // Skip for: memory updates (recursion), use case discovery (internal), CLI (command-line)
        const sessionId = agentTurnRegistry.getRendererSession(turnId);
        const sessionKind = sessionId ? classifySessionKind(sessionId) : null;
        const shouldSkipMemory = sessionKind ? shouldSkipMemoryUpdate(sessionKind) : false;

        // Additional skip patterns for time-saved estimation:
        // - automation-*: all automations (including calendar-sync)
        // - calendar-sync: legacy calendar sync (for transition period)
        // - meeting-qa-*: meeting bot Q&A sessions
        // - meeting-analysis-*: meeting transcript analysis sessions
        const shouldSkipTimeSavedTracking = shouldSkipMemory
          || (sessionKind ? shouldSkipTimeSaved(sessionKind) : false);

        if (!shouldSkipMemory) {
          const accumulatedContext = agentTurnRegistry.getContextAccumulator(turnId);
          const userPrompt = agentTurnRegistry.getTurnPrompt(turnId);
          if (accumulatedContext && userPrompt && sessionId) {
            const turnContext: TurnContext = {
              originalTurnId: turnId,
              originalSessionId: sessionId,
              userPrompt,
              messages: accumulatedContext.messages,
              eventsByTurn: accumulatedContext.eventsByTurn,
              privateMode: agentTurnRegistry.getTurnPrivateMode(turnId),
            };
            fireAndForget(triggerMemoryUpdate(turnContext), 'agentMessageHandler.line3158');

            // Calculate duration for time-saved and badges (both need it)
            const allEvents = Object.values(accumulatedContext.eventsByTurn).flat();
            const firstEventTime = allEvents.length > 0 ? allEvents[0].timestamp : Date.now();
            const durationSeconds = Math.round((Date.now() - firstEventTime) / 1000);

            // Trigger time saved estimation (fire-and-forget)
            // Skip for system sessions that don't create UI-visible conversations
            if (!shouldSkipTimeSavedTracking) {
              const resultText = ((message as Record<string, unknown>).result as string) ?? '';
              const toolEvents = Object.values(accumulatedContext.eventsByTurn)
                .flat()
                .filter((e) => e.type === 'tool');
              const toolSummary = toolEvents.length > 0
                ? `${toolEvents.length} tool calls`
                : 'No tools used';

              const timeSavedContext: TurnContextForTimeSaved = {
                turnId,
                sessionId: sessionId ?? turnId, // Fallback to turnId if no session
                userPrompt,
                finalSummary: resultText.slice(0, 2000),
                toolSummary,
                durationSeconds
              };
              fireAndForget(triggerTimeSavedEstimation(timeSavedContext), 'agentMessageHandler.line3184');
            }
            // Note: Session coaching evaluation is handled by periodic scanner in sessionCoachingScheduler

            // Check for reunion badge BEFORE streak update (need to detect 30+ day gap)
            evaluateReunionBadge();
            
            // Update streak on turn completion (fire-and-forget)
            // Uses same skip patterns as memory/time-saved for internal sessions
            updateStreakOnSessionComplete();
            
            // Evaluate badges on turn completion (fire-and-forget)
            try {
              const toolEvents = Object.values(accumulatedContext.eventsByTurn)
                .flat()
                .filter((e) => e.type === 'tool');
              // Resolve effective tool names once per event (avoids repeated JSON.parse)
              const resolvedNames = toolEvents.map((e) => resolveEffectiveTool(e).name);
              const toolNames = resolvedNames.filter(Boolean);
              
              // Check for specific signals in tool usage
              // Memory write: look for memory-related tools or file writes to memory paths
              const memoryWriteOccurred = toolEvents.some((e, i) => {
                const name = resolvedNames[i].toLowerCase();
                const detail = e.detail?.toLowerCase() ?? '';
                return name.includes('memory') || 
                       name.includes('write_file') || 
                       name.includes('create_file') ||
                       detail.includes('/memory/');
              });
              
              // Skill invocation: check for @ mentions in prompt and extract skill name
              const skillMatch = userPrompt.match(/@([\w-]+(?:\/[\w-]+)*)/);
              const skillInvoked = !!skillMatch;
              const skillNameInvoked = skillMatch?.[1]; // e.g., "meeting-prep" or "interview-me-to-look-for-ai-automations"
              
              // Voice: get from turn registry (set in agentHandlers when turn started)
              const voiceUsed = agentTurnRegistry.getTurnInputSource(turnId) === 'voice';
              
              // Automation created: look for automation-related tool calls
              const automationCreated = toolEvents.some((_, i) => {
                const name = resolvedNames[i].toLowerCase();
                return name.includes('automation') || name.includes('schedule');
              });
              
              if (!sessionId) throw new Error('sessionId unavailable for badge context');
              const badgeContext: BadgeTurnContext = {
                sessionId,
                hadMeaningfulActivity: toolEvents.length > 0, // Tools used = meaningful activity
                toolsUsedThisTurn: toolNames,
                memoryWriteOccurred,
                skillInvoked,
                skillNameInvoked,
                voiceUsed,
                automationCreated,
                timeSavedMinutes: 0, // Will be updated async by timeSavedService
                sessionDurationMinutes: Math.round(durationSeconds / 60)
              };
              
              evaluateBadgesOnTurnComplete(badgeContext);
              updateCountersOnSessionComplete(sessionId, voiceUsed, 0, memoryWriteOccurred, skillInvoked, automationCreated);
              
              // Evaluate journey day completion (auto-detection for days 1-3, 5, 8-11)
              const currentDay = getCurrentJourneyDay();
              if (currentDay) {
                evaluateJourneyCompletion(badgeContext, currentDay);
              }
            } catch (badgeError) {
              // Don't let badge errors disrupt the turn pipeline
              log.debug({ err: badgeError }, 'Badge evaluation error (non-critical)');
            }
          }
        }

        // Cost ledger append was moved to the top of the success branch (before
        // throw-based retry checks) to capture costs for billed-but-retried attempts.
        // See the early appendCostEntry block above.

        // Preserve the accumulator for deny-and-retry question pauses. The
        // response handler needs the stored `user_question` event as
        // authoritative provenance for approval-context clarification.
        if (!agentTurnRegistry.hasUserQuestionPending(turnId)) {
          agentTurnRegistry.deleteContextAccumulator(turnId);
        }
      }

      // Release session liveness so a new turn won't cancel this completed one.
      // The forward mapping (turnId → sessionId) is preserved for late cleanup
      // code (proxy cost attribution) and deleted by cleanupTurn().
      agentTurnRegistry.releaseActiveSession(turnId);
      break;
    }

    case 'user':
    default:
      // Also handles custom Rebel Core runtime types ('compact_boundary',
      // 'permission_denial') that are NOT in the AgentMessage union — they must
      // no-op here; assertNever/invariant would throw on those valid runtime values.
      // eslint-disable-next-line rebel-switch-exhaustiveness/no-bare-default-bypass -- intentional no-op for out-of-union runtime types (see comment above).
      break;

    case 'stream_event': {
      // Handle streaming deltas from the runtime (when includePartialMessages: true)
      const streamEvent = message as {
        type: 'stream_event';
        event?: {
          type: string;
          delta?: {
            type: string;
            text?: string;
            thinking?: string;
          };
        };
      };
      
      // Handle content block deltas - both text and thinking (extended thinking mode)
      if (streamEvent.event?.type === 'content_block_delta') {
        const delta = streamEvent.event.delta;
        // Text deltas - normal assistant output
        if (delta?.type === 'text_delta' && delta.text) {
          dispatchAgentEvent(win, turnId, {
            type: 'assistant_delta',
            text: delta.text,
            timestamp: Date.now(),
          });
        }
        // Thinking deltas - extended thinking mode (provides progress during reasoning)
        // Dispatched as separate 'thinking_delta' type so UI can display distinctly from final answer
        if (delta?.type === 'thinking_delta' && delta.thinking) {
          dispatchAgentEvent(win, turnId, {
            type: 'thinking_delta',
            text: delta.thinking,
            timestamp: Date.now(),
          });
        }
      }
      break;
    }
  }
};
