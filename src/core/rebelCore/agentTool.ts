/**
 * Agent Tool — Sub-agent spawning for Rebel Core.
 *
 * When the model calls the Agent tool, we run a nested runAgentLoop with
 * the sub-agent's definition (prompt, tools, model). This is the same
 * architecture inspired by the original Claude Agent SDK's Task/Agent tool, but using direct API calls
 * instead of spawning a subprocess.
 *
 * Sub-agents:
 * - Get their own fresh context (no parent conversation history)
 * - Can use built-in tools + MCP tools
 * - Can delegate to sub-sub-agents up to depth 2
 * - Return only their final accumulated text to the parent
 */
import { createScopedLogger } from '@core/logger';
import { appendTranscriptEntry } from '@core/services/transcriptService';
import type { AppSettings, ModelProfile } from '@shared/types';
import { COST_CATEGORY_REGISTRY, type BtsTaskGroup } from '@shared/costCategories';
import { shortModelName } from '@shared/utils/modelDisplayUtils';
import {
  decodeRoutingModelId,
  normalizeStoredBtsModelValue,
  rejectionReasonLabel,
  type NormalizationRejectionReason,
  type NormalizedBtsModelValue,
  type RoutingModelId,
} from '@shared/utils/modelChoiceCodec';
import { resolveProfileApiKey } from '@shared/utils/providerKeys';
import { resolveRoutingProfileRef } from '@shared/utils/connectivityHelpers';
import { computeSupportsReasoningReplay } from '@shared/utils/reasoningCapability';
import { getErrorKind } from '@shared/utils/agentErrorCatalog';
import { runAgentLoop } from './agentLoop';
import { AgentToolTimeoutError, isAgentToolTimeoutError } from './agentToolErrors';
import { createClientFromRoutePlan } from './clientFactory';
import type { ModelClient } from './modelClient';
import { createRoleResolutionModelError, ModelError } from './modelErrors';
import { resolveThinkingConfig, resolveEffortForApi, resolveModelLimits } from './modelLimits';
import {
  getApiKey,
  getOAuthToken,
} from './settingsAccessors';
import { recordContextOverflowOnProfile } from './learnedProfileWriter';
import { safeDispatchLearnedLimitsFromError } from './dispatchLearnedLimitsFromError';
import { runSubagentStartHooks, runSubagentStopHooks, createHookAwareToolExecutor } from './hookPipeline';
import { executeBuiltinTool, isBuiltinToolName, getBuiltinToolDefinitions, GET_MISSION_CONTEXT_TOOL_DEFINITION, SUMMARIZE_RESULT_TOOL_DEFINITION } from './builtinTools';
import { isMcpToolName } from './mcpClient';
import { createScopedTaskStore, createTaskStore, type RebelCoreTask, type RebelCoreTaskStoreInternal } from './taskState';
import type { SystemPrompt, TextBlock, ToolDefinition, TokenUsage } from './modelTypes';
import { ZERO_TOKEN_USAGE, addUsage } from './types';
import type { AgentToolContext, BuiltinToolName, RebelCoreAgentDefinition, ToolExecutionResult } from './types';
import type { PlanningStep, SubAgentAssignment } from './planningMode';
import { materializePlanRuntime } from './providerRoutePlan';
import { isTerminalRoutePlan, type DispatchableRoutePlan, type TerminalRoutePlan } from './providerRoutePlanTypes';
import { ProviderRouter } from './providerRouting';
import {
  assertNever,
  isNonPassthroughAnthropicTransport,
  isProfileReference,
  isRouteTableScope,
  type CodexConnectivity,
  type ProviderInvalidReason,
  type ProviderRouteScope,
} from './providerRouteDecision';
import { getErrorReporter } from '@core/errorReporter';
import { canonicalizeSubAgentModel } from './subAgentRouting';
import { logProviderRetryTelemetry } from './util/retryTelemetry';
import {
  humanizeRoleResolutionFailure,
  isRoleResolutionFailure,
  makeRoleNotConfiguredStatusMessage,
  resolveDefaultModelForRole,
  type ModelRole,
  type RoleResolutionFailure,
} from './modelRoleResolver';

const log = createScopedLogger({ service: 'rebelCoreAgentTool' });

function decodeSubagentRoutingModelOrThrow(value: string, source: string): RoutingModelId {
  const decoded = decodeRoutingModelId(value);
  if (!decoded) {
    throw new ModelError('invalid_request', `Invalid ${source} model id "${value}"`, 400);
  }
  return decoded;
}

/**
 * Builtin tools that MUST be suppressed for sub-agents. The prior-turns
 * inspection surface (Stage 3 of cross-turn awareness) is intended for the
 * main agent only; sub-agents are scoped to their delegated task and adding
 * an introspection surface confuses them with the larger session history.
 *
 * @see docs/plans/260525_cross_turn_awareness_layer1_layer2.md (D4 / F1)
 */
const SUBAGENT_SUPPRESSED_PRIOR_TURN_BUILTINS: readonly BuiltinToolName[] = [
  'inspect_prior_turns',
  'get_tool_call',
];

function roleForModelAlias(alias: string): ModelRole | null {
  if (alias === 'thinking' || alias === 'opus') return 'thinking';
  if (alias === 'working' || alias === 'sonnet') return 'working';
  if (alias === 'fast' || alias === 'haiku') return 'background';
  return null;
}

export const FAST_MODEL_NOT_CONFIGURED_TOOL_MESSAGE =
  'Sub-agent skipped: the Behind the Scenes model is not configured. Open Settings → Models, assign Behind the Scenes, then retry.';

function roleFailureToModelError(failure: RoleResolutionFailure): ModelError {
  return createRoleResolutionModelError(failure);
}

/**
 * Resolve a sub-agent model alias to the user's configured model for that tier.
 * Deprecated Anthropic aliases still map to semantic roles.
 *
 * @throws ModelError when the role has no configured model.
 */
/** @internal Exported for testing */
export function resolveModelAlias(alias: string, settings: AppSettings): string {
  const role = roleForModelAlias(alias);
  if (!role) return alias;

  if (alias === 'opus') {
    log.debug('Deprecated sub-agent alias "opus" — use "thinking" instead');
  } else if (alias === 'sonnet') {
    log.debug('Deprecated sub-agent alias "sonnet" — use "working" instead');
  } else if (alias === 'haiku') {
    log.debug('Deprecated sub-agent alias "haiku" — use "fast" instead');
  }

  const resolution = resolveDefaultModelForRole(
    role,
    settings,
    settings.localModel?.profiles ?? [],
  );
  if (!resolution.ok) {
    throw roleFailureToModelError(resolution);
  }
  return resolution.model;
}

const MAIN_NAMESPACE = 'main';
const MISSION_OWNER = 'mission';
const MISSION_GOAL_NOTE = 'goal';
const TRACKING_TASK_PROMPT_PREVIEW_CHARS = 100;
const ASSIGNMENT_PROMPT_PREVIEW_CHARS = 200;
const MAX_FULL_TASK_BOARD_CHARS = 40_000;
const MAX_TURNS_BY_DEPTH = [500, 200, 50] as const;
const SUMMARIZE_RESULT_INSTRUCTION = 'Before completing your work, call the SummarizeResult tool with a 2-3 sentence summary of your key findings, decisions, and outcomes.';
const SUBAGENT_ROUTING_STATUS_PREFIX = 'routing:subagent:';

const resolveImageAssetSurface = (
  context: Pick<AgentToolContext, 'imageAssetSurface'>,
): 'desktop' | 'cloud' => {
  if (context.imageAssetSurface) return context.imageAssetSurface;
  return process.env.REBEL_SURFACE === 'cloud' ? 'cloud' : 'desktop';
};

type SubagentRouteScope = Extract<ProviderRouteScope, 'normal-turn' | 'council' | 'ad-hoc'>;

function routeScopeForRoutingMode(
  routingMode: RebelCoreAgentDefinition['routingMode'],
): SubagentRouteScope {
  switch (routingMode) {
    case 'council':
      return 'council';
    case 'ad-hoc':
      return 'ad-hoc';
    case 'subagent':
    case undefined:
      return 'normal-turn';
    default:
      return assertNever(routingMode, 'SubagentRoutingMode');
  }
}

function rebuildNormalizedBtsModelValue(
  normalized: Extract<NormalizedBtsModelValue, { ok: true }>,
): string {
  if (normalized.kind === 'profile') return `profile:${normalized.profileId}`;
  return normalized.modelId;
}

function warnRejectedConfiguredBtsModelValue(
  siteId: string,
  rawValue: unknown,
  reason: NormalizationRejectionReason,
  source: 'override' | 'global',
): void {
  const fallbackMessage = source === 'override'
    ? 'falling through to global'
    : 'returning undefined';
  if (typeof rawValue === 'string' && rawValue.length > 0) {
    log.warn({
      siteId,
      rawTruncated: rawValue.slice(0, 32),
      rejectionReason: reason,
    }, `[resolveConfiguredBtsModel] ${source} rejected by normalizer: ${rejectionReasonLabel(reason)}; ${fallbackMessage}`);
  } else if (rawValue != null && typeof rawValue !== 'string') {
    log.warn({
      siteId,
      rawType: typeof rawValue,
      rejectionReason: reason,
    }, `[resolveConfiguredBtsModel] ${source} rejected non-string input by normalizer: ${rejectionReasonLabel(reason)}; ${fallbackMessage}`);
  }
}

/** @internal Exported for testing. */
export function resolveConfiguredBtsModel(
  settings: AppSettings,
  category: string | undefined,
): string | undefined {
  if (category) {
    const meta = COST_CATEGORY_REGISTRY[category as keyof typeof COST_CATEGORY_REGISTRY];
    const group = (meta && 'btsTaskGroup' in meta)
      ? (meta.btsTaskGroup as BtsTaskGroup | undefined)
      : undefined;
    const categoryOverride = group
      ? settings.behindTheScenesOverrides?.[group]
      : undefined;
    const normalizedOverride = normalizeStoredBtsModelValue(categoryOverride);
    if (normalizedOverride.ok) return rebuildNormalizedBtsModelValue(normalizedOverride);
    warnRejectedConfiguredBtsModelValue(
      'agentTool:resolveConfiguredBtsModel:override',
      categoryOverride,
      normalizedOverride.reason,
      'override',
    );
  }

  const fallbackModelRaw = settings.behindTheScenesModel;
  const normalizedGlobal = normalizeStoredBtsModelValue(fallbackModelRaw);
  if (normalizedGlobal.ok) return rebuildNormalizedBtsModelValue(normalizedGlobal);
  warnRejectedConfiguredBtsModelValue(
    'agentTool:resolveConfiguredBtsModel:global',
    fallbackModelRaw,
    normalizedGlobal.reason,
    'global',
  );
  return undefined;
}

/**
 * @internal Exported for testing — gated `profile:<id>` lookup uses the same
 * selectability rules as the model-string branch.
 *
 * Resolves the agent's OWN configured/default model (BTS category, `agentDef.model`).
 * Intentionally does NOT require `routingEligible` and does NOT apply a connectivity
 * gate — this is NOT a planner-routing-pool reference, so it must remain reachable
 * even for profiles outside the adaptive-routing pool. The planner-ASSIGNED
 * sub-agent model is resolved separately via `resolveAssignedSubAgentProfile`,
 * which DOES apply those gates (the routing pool gate the parent execution path
 * enforces). Both funnel through the one `resolveRoutingProfileRef` chokepoint.
 */
export function findSelectableProfileForModel(settings: AppSettings, model: string): ModelProfile | null {
  return resolveRoutingProfileRef(model, {
    pool: settings.localModel?.profiles ?? [],
    requireRoutingEligible: false,
    supportsProfileId: true,
  });
}

/**
 * Resolve a planner-ASSIGNED sub-agent model reference against the routing pool
 * gates — i.e. the same eligibility + connectivity gates the parent-execution
 * routing path applies (`getFunctionalRoutingProfiles`). Previously the
 * sub-agent path reused `findSelectableProfileForModel`, which ignored
 * `routingEligible` and connectivity, so the planner could route a sub-agent to
 * a non-routing-eligible or dead-connection profile that the parent path would
 * have rejected (Stage-3 bug fix). Connectivity is taken from the parent turn's
 * `AgentToolContext.connectivity` snapshot.
 */
export function resolveAssignedSubAgentProfile(
  ctx: AgentToolContext,
  model: string,
): ModelProfile | null {
  return resolveRoutingProfileRef(model, {
    pool: ctx.settings.localModel?.profiles ?? [],
    requireRoutingEligible: true,
    connectivity: ctx.connectivity,
    supportsProfileId: true,
  });
}

function inferCodexConnectivity(ctx: AgentToolContext): CodexConnectivity {
  if (ctx.codexConnectivity) return ctx.codexConnectivity;
  if (ctx.proxyConfig?.defaultHeaders?.['x-codex-turn'] === 'true') return 'connected';
  return 'unknown';
}

function createSubagentRoutingError(
  message: string,
  kind: 'auth' | 'routing' = 'auth',
): Error {
  const error = new Error(message) as Error & { __agentErrorKind?: string };
  error.__agentErrorKind = kind;
  return error;
}

function throwSubagentTerminalPlan(
  plan: TerminalRoutePlan,
  agentName: string,
): never {
  const invalidReason: Exclude<ProviderInvalidReason, 'none'> = plan.decision.invalidReason;
  switch (invalidReason) {
    // `missing-anthropic-credentials-for-claude-model` is primary-turn-only by
    // construction (providerRouting scopes it via isPrimaryTurnRole); sub-agents
    // keep `missing-anthropic-credentials`. Mapped defensively so a hypothetical
    // scope regression still yields a sensible message, not an assertNever throw.
    case 'missing-anthropic-credentials':
    case 'missing-anthropic-credentials-for-claude-model':
      throw createSubagentRoutingError('Rebel needs an Anthropic API key. Please add one in Settings.');
    case 'missing-openrouter-credentials':
      throw createSubagentRoutingError(
        'OpenRouter is not connected. Reconnect OpenRouter in Settings or choose a different model for this sub-agent.',
      );
    case 'missing-mindstone-credentials':
      throw createSubagentRoutingError(
        "Your Mindstone subscription isn't ready. Check your subscription status in Settings or choose a different model for this sub-agent.",
      );
    case 'missing-codex-connection':
    case 'codex-disconnected-bts-blocked':
      throw createSubagentRoutingError(
        'ChatGPT Pro is not connected. Reconnect ChatGPT Pro in Settings or choose a different model for this sub-agent.',
      );
    case 'codex-unsupported-model':
      throw createSubagentRoutingError(
        `ChatGPT Pro does not support model "${plan.decision.wireModelId}" for this sub-agent.`,
      );
    case 'missing-profile-credentials':
      throw createSubagentRoutingError(
        `Sub-agent "${agentName}" cannot dispatch: missing credentials for the selected model profile.`,
      );
    case 'proxy-dialect-in-direct-anthropic':
      throw createSubagentRoutingError(
        `Sub-agent "${agentName}" cannot dispatch: model "${plan.decision.wireModelId}" cannot be sent directly to Anthropic.`,
        'routing',
      );
    default:
      return assertNever(invalidReason, 'TerminalRouteDecision.invalidReason');
  }
}

declare const subAgentDispatchDescriptorBrand: unique symbol;

type SubAgentDispatchPlanBinding<TPlan extends DispatchableRoutePlan> = {
  readonly [subAgentDispatchDescriptorBrand]: TPlan;
};

export type SubAgentDispatchClient<TPlan extends DispatchableRoutePlan = DispatchableRoutePlan> =
  ModelClient & SubAgentDispatchPlanBinding<TPlan>;

export type SubAgentDispatchBodyModel<TPlan extends DispatchableRoutePlan = DispatchableRoutePlan> =
  RoutingModelId & SubAgentDispatchPlanBinding<TPlan>;

export type SubAgentDispatchDescriptor<TPlan extends DispatchableRoutePlan = DispatchableRoutePlan> = {
  readonly client: SubAgentDispatchClient<TPlan>;
  readonly bodyModel: SubAgentDispatchBodyModel<TPlan>;
  readonly transport: TPlan['decision']['transport'];
};

function resolveSubAgentDispatchBodyModel<TPlan extends DispatchableRoutePlan>(
  plan: TPlan,
  resolvedModel: RoutingModelId,
): SubAgentDispatchBodyModel<TPlan> {
  // REBEL-5N8 (Stage 1, GATED — DA critique 260608_091731 F3): only on
  // route-table scope do we stream the plan's route-table-safe `wireModelId`
  // as the body model. Outside route-table scope `wireModelId` is derived by a
  // DIFFERENT resolution path (`resolveInputModel`→`normalizeOrModelId`, which
  // applies LEGACY_OR_MODEL_REMAP) than the streamed `resolvedModel`
  // (`decodeRoutingModelId`, no remap), so an unconditional swap would silently
  // change the streamed model for legacy-OpenRouter-id delegations. Gating
  // keeps the change strictly scoped to the buggy route-table path.
  //
  // DO NOT "simplify" this to an unconditional `bodyModel = wireModelId`. The
  // all-paths spike (260608_subagent-body-model-all-paths) verified that
  // LEGACY_OR_MODEL_REMAP contains CROSS-MODEL version bumps, not just spelling
  // fixes — e.g. `x-ai/grok-3` → `x-ai/grok-4.20`, `minimax/minimax-m2.5` →
  // `minimax-m2.7` (see openRouterModels `legacyIds`). On the `openrouter-proxy`
  // passthrough path the body model is sent VERBATIM upstream, so dropping the
  // gate would silently run a different, pricier model and misbill the user.
  // The gate is correct, not a limitation. The descriptor returned below is the
  // structural all-paths kill: every sub-agent dispatch consumer receives the
  // body model paired with the client minted from this same dispatchable plan.
  let bodyModel: RoutingModelId = resolvedModel;
  if (isRouteTableScope(plan.decision.routeScope)) {
    // Route the plan's route-table-safe `wireModelId` through the sanctioned
    // decode chokepoint rather than a last-mile raw-string forge (the forge
    // helper is confined to codec internals + tests by
    // `check-no-routing-model-forge`). `decodeSubagentRoutingModelOrThrow`
    // wraps `decodeRoutingModelId` (decode + throw-on-null), so this is
    // behaviour-identical for the bare route-table alias (e.g. `working`)
    // while passing the guard.
    bodyModel = decodeSubagentRoutingModelOrThrow(
      plan.decision.wireModelId,
      'route-table sub-agent body model',
    );
  }
  // eslint-disable-next-line bts-flow-shape/no-model-brand-casts -- this function IS the owning minter: SubAgentDispatchBodyModel is declared in this module and this is its sole branded-construction site (pinned to exactly one mint by check-agent-tool-body-model-source).
  return bodyModel as SubAgentDispatchBodyModel<TPlan>;
}

function createSubAgentDispatchDescriptor<TPlan extends DispatchableRoutePlan>(params: {
  readonly plan: TPlan;
  readonly settings: AppSettings;
  readonly resolvedModel: RoutingModelId;
  readonly codexMode: AgentToolContext['codexMode'];
  readonly routeProfile: ModelProfile | null;
}): SubAgentDispatchDescriptor<TPlan> {
  const bodyModel = resolveSubAgentDispatchBodyModel(params.plan, params.resolvedModel);
  const client = createClientFromRoutePlan(params.plan, params.settings, {
    codexMode: params.codexMode,
    routeProfile: params.routeProfile,
  });
  return {
    client: client as SubAgentDispatchClient<TPlan>,
    bodyModel,
    transport: params.plan.decision.transport,
  };
}

function createAbortError(timedOut: boolean, maxDurationMs?: number): Error {
  if (timedOut) {
    const timeoutSuffix = typeof maxDurationMs === 'number' ? ` after ${maxDurationMs}ms` : '';
    return new AgentToolTimeoutError(`Sub-agent timed out${timeoutSuffix}`, maxDurationMs);
  }

  const error = new Error('AbortError');
  error.name = 'AbortError';
  return error;
}

function toSingleLinePreview(text: string, maxChars: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function getCommandersIntent(taskStoreInternal: RebelCoreTaskStoreInternal): string {
  const missionGoal = taskStoreInternal
    .listTasks()
    .find((task) => task.owner === MISSION_OWNER && task.notes === MISSION_GOAL_NOTE);

  return missionGoal?.title ?? '(No mission goal set)';
}

function serializeTaskBoardJson(tasks: RebelCoreTask[]): string {
  return JSON.stringify({ tasks }, null, 2);
}

function serializeMissionBriefing(
  taskStoreInternal: RebelCoreTaskStoreInternal,
  agentName: string,
  prompt: string,
  namespace: string,
): string {
  const tasks = taskStoreInternal.listTasks();
  const fullTaskBoardJson = serializeTaskBoardJson(tasks);
  const degradedTasks = tasks.map((task) => {
    if (task.status !== 'completed' || task.notes === undefined) {
      return task;
    }

    return {
      ...task,
      notes: undefined,
    };
  });
  const degradedTaskBoardJson = serializeTaskBoardJson(degradedTasks);
  const taskBoardJson = fullTaskBoardJson.length > MAX_FULL_TASK_BOARD_CHARS
    ? degradedTaskBoardJson
    : fullTaskBoardJson;

  return [
    '<mission_context>',
    '## Commander\'s Intent',
    getCommandersIntent(taskStoreInternal),
    '',
    '## Your Assignment',
    `Agent: ${agentName}`,
    `Namespace: ${namespace}`,
    `Task: ${toSingleLinePreview(prompt, ASSIGNMENT_PROMPT_PREVIEW_CHARS)}`,
    '',
    '## Current Task Board',
    taskBoardJson,
    '',
    '## Collaboration Rules',
    '- The task board is shared across all agents. Other agents\' tasks give context about what is already done or in progress — check before duplicating work.',
    '- You can read the full task board via TaskList or GetMissionContext.',
    `- You can only create/update tasks in your namespace (${namespace}).`,
    '- Update task status as you work — the coordinating agent sees your progress in real time.',
    '- Before completing, call SummarizeResult to share your key findings, decisions, and anything that affects sibling tasks.',
    '</mission_context>',
  ].join('\n');
}

function serializeLightweightMissionBriefing(
  taskStoreInternal: RebelCoreTaskStoreInternal,
  agentName: string,
  prompt: string,
  namespace: string,
): string {
  return [
    '<mission_context>',
    '## Commander\'s Intent',
    getCommandersIntent(taskStoreInternal),
    '',
    '## Your Assignment',
    `Agent: ${agentName}`,
    `Namespace: ${namespace}`,
    `Task: ${toSingleLinePreview(prompt, ASSIGNMENT_PROMPT_PREVIEW_CHARS)}`,
    '</mission_context>',
  ].join('\n');
}

function createDelegationTrackingTask(
  taskStoreInternal: RebelCoreTaskStoreInternal,
  ownerNamespace: string,
  agentName: string,
  prompt: string,
  routedModel: string | null,
): string {
  const nextTaskId = taskStoreInternal._getNextTaskId();
  const now = Date.now();
  const taskId = String(nextTaskId);
  const routingLabel = shortModelName(routedModel ?? agentName);
  const trackingTask: RebelCoreTask = {
    id: taskId,
    title: `Delegated to ${routingLabel}: ${toSingleLinePreview(prompt, TRACKING_TASK_PROMPT_PREVIEW_CHARS)}`,
    owner: ownerNamespace,
    status: 'in_progress',
    kind: 'orchestration',
    createdAt: now,
    updatedAt: now,
  };

  taskStoreInternal._setRawTask(taskId, trackingTask);
  taskStoreInternal._setNextTaskId(nextTaskId + 1);
  taskStoreInternal._refreshBlockedTasks();

  return taskId;
}

function markTrackingTaskBlocked(
  taskStoreInternal: RebelCoreTaskStoreInternal | undefined,
  trackingTaskId: string | undefined,
  notes: string,
): void {
  if (!taskStoreInternal || !trackingTaskId) return;
  try {
    const existingTask = taskStoreInternal._getRawTask(trackingTaskId);
    if (!existingTask) return;
    taskStoreInternal._setRawTask(trackingTaskId, {
      ...existingTask,
      status: 'blocked',
      notes,
      updatedAt: Date.now(),
    });
    taskStoreInternal._refreshBlockedTasks();
  } catch {
    // Fail-open — never mask the original sub-agent failure.
  }
}



/** @internal Exported for testing */
export function resolveSubagentModel(
  agentModel: RebelCoreAgentDefinition['model'],
  parentModel: RoutingModelId,
  settings: AppSettings,
): RoutingModelId {
  if (!agentModel || agentModel === 'inherit') return parentModel;
  return decodeSubagentRoutingModelOrThrow(resolveModelAlias(agentModel, settings), 'sub-agent');
}

function buildScopedSystemPrompt(): SystemPrompt {
  return [
    {
      type: 'text' as const,
      text: 'You are a focused task executor. Complete the following task precisely and efficiently.\nUse the available tools as needed. Return your result directly.',
      cache_control: { type: 'ephemeral' as const },
    },
  ];
}

const SUB_AGENT_MATCH_STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'into',
  'onto',
  'that',
  'this',
  'those',
  'these',
  'use',
  'using',
  'agent',
  'sub',
  'task',
  'step',
  'please',
  'about',
  'your',
  'you',
  'are',
  'will',
  'can',
  'should',
  'would',
]);

function tokenizeAssignmentText(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [];
  return new Set(tokens.filter((token) => !SUB_AGENT_MATCH_STOP_WORDS.has(token)));
}

/**
 * Minimum prompt-token overlap required to confidently claim an assignment.
 * Shared by the multi-candidate exact-name path, the single exact-name path
 * (Stage 4: previously had NO overlap floor — the over-claim path), and the
 * keyword-overlap fallback path, so the confidence bar is identical everywhere.
 */
const SUB_AGENT_MATCH_MIN_OVERLAP_COUNT = 2;
const SUB_AGENT_MATCH_MIN_OVERLAP_RATIO = 0.25;

function clearsOverlapFloor(match: ScoredSubAgentAssignmentCandidate | null): boolean {
  return Boolean(
    match
      && match.overlapCount >= SUB_AGENT_MATCH_MIN_OVERLAP_COUNT
      && match.overlapRatio >= SUB_AGENT_MATCH_MIN_OVERLAP_RATIO,
  );
}

/**
 * True iff `agentName` appears as a whole word in `taskText`.
 *
 * Stage 4 (bug #6): replaces the previous `task.includes(agentName)` substring
 * test, which over-claimed when the agent name was merely a substring of a
 * larger word (e.g. agent "researcher" matching a task mentioning
 * "researchers" or "research" embedded in another token). The name must sit on
 * word boundaries (non-`[a-z0-9_]` on each side). Multi-word agent names are
 * supported (the name is matched literally, only its internal regex
 * metacharacters escaped). Word characters here mirror the tokenizer's
 * alphabet so e.g. `code-reviewer` matches as a unit.
 */
function taskMentionsAgentNameAsWord(taskText: string, normalizedAgentName: string): boolean {
  if (!normalizedAgentName) return false;
  const escaped = normalizedAgentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // \b is unreliable around hyphens/underscores, so assert non-word-char (or
  // string edge) on each side, where "word char" matches the tokenizer alphabet.
  const boundaryPattern = new RegExp(`(?<![a-z0-9_])${escaped}(?![a-z0-9_])`);
  return boundaryPattern.test(taskText.toLowerCase());
}

function collectSubAgentAssignments(
  planSteps: PlanningStep[] | undefined,
  consumedAssignments: Set<string>,
): Array<{ key: string; assignment: SubAgentAssignment }> {
  if (!planSteps?.length) return [];

  return planSteps.flatMap((step, stepIndex) => {
    if (!step.sub_agents?.length) return [];
    return step.sub_agents.flatMap((assignment, subAgentIndex) => {
      const key = `${stepIndex}:${subAgentIndex}`;
      return consumedAssignments.has(key) ? [] : [{ key, assignment }];
    });
  });
}

export interface SubAgentAssignmentClaim {
  readonly assignment: SubAgentAssignment;
  /** Commit the claim. After commit(), release() becomes a no-op. */
  commit(): void;
  /**
   * Release the pending claim by removing its key from consumedAssignments.
   * Valid only before commit() and before runAgentLoop entry.
   * After commit() or runAgentLoop entry, release() is a no-op.
   *
   * Released keys become available again for any subsequent sync-prefix
   * matching, including sibling Agent calls in the same assistant message
   * that were queued behind the Stage 2a pLimit cap.
   */
  release(): void;
}

type ScoredSubAgentAssignmentCandidate = {
  key: string;
  assignment: SubAgentAssignment;
  overlapCount: number;
  overlapRatio: number;
};

function scoreSubAgentAssignmentCandidates(
  candidates: Array<{ key: string; assignment: SubAgentAssignment }>,
  promptTokens: Set<string>,
): ScoredSubAgentAssignmentCandidate | null {
  let bestMatch: ScoredSubAgentAssignmentCandidate | null = null;

  for (const candidate of candidates) {
    const taskTokens = tokenizeAssignmentText(candidate.assignment.task);

    let overlapCount = 0;
    for (const token of taskTokens) {
      if (promptTokens.has(token)) {
        overlapCount++;
      }
    }

    const overlapRatioDenominator = Math.min(taskTokens.size, promptTokens.size);
    const overlapRatio = overlapRatioDenominator > 0 ? overlapCount / overlapRatioDenominator : 0;
    const isBetterMatch = !bestMatch
      || overlapCount > bestMatch.overlapCount
      || (overlapCount === bestMatch.overlapCount && overlapRatio > bestMatch.overlapRatio);

    if (isBetterMatch) {
      bestMatch = {
        key: candidate.key,
        assignment: candidate.assignment,
        overlapCount,
        overlapRatio,
      };
    }
  }

  return bestMatch;
}

function createSubAgentAssignmentClaim(
  candidate: { key: string; assignment: SubAgentAssignment },
  consumedAssignments: Set<string>,
): SubAgentAssignmentClaim {
  // Claim immediately so same-message sibling Agent calls in the synchronous
  // prefix cannot double-claim the assignment. If a pre-dispatch failure occurs,
  // release() returns the key to the unconsumed pool for any subsequent
  // sync-prefix claim attempt (including queued same-message siblings).
  consumedAssignments.add(candidate.key);

  let status: 'pending' | 'committed' | 'released' = 'pending';

  return {
    assignment: candidate.assignment,
    commit() {
      if (status !== 'pending') return;
      status = 'committed';
    },
    release() {
      if (status !== 'pending') return;
      consumedAssignments.delete(candidate.key);
      status = 'released';
    },
  };
}

/**
 * Match an Agent tool invocation to a planner sub_agent assignment.
 *
 * MUST be called as the FIRST synchronous operation in `executeAgentTool`.
 * Any `await` between function entry and this call breaks concurrent-sibling
 * consume safety. This function is intentionally non-async.
 *
 * Strategy:
 * - "Exact-name" candidates are assignments whose task text mentions the agent
 *   name as a WHOLE WORD (Stage 4: word-boundary match, not a substring — the
 *   name must not be embedded in a larger word).
 * - For ANY exact-name candidate (single OR multiple), score by prompt-token
 *   overlap and claim only when the best candidate clears the shared confidence
 *   floor; otherwise return null (Stage 4: the single exact-name path no longer
 *   claims without an overlap check — that was the over-claim path).
 * - If no exact-name candidate exists, fall back to keyword-overlap matching
 *   under the same floor.
 *
 * @internal Exported for testing
 */
export function claimSubAgentAssignment(
  agentName: string,
  prompt: string,
  planSteps: PlanningStep[] | undefined,
  consumedAssignments: Set<string>,
): SubAgentAssignmentClaim | null {
  const candidates = collectSubAgentAssignments(planSteps, consumedAssignments);
  if (candidates.length === 0) return null;

  const normalizedAgentName = agentName.trim().toLowerCase();
  const promptTokens = tokenizeAssignmentText(prompt);

  if (normalizedAgentName) {
    const exactNameCandidates = candidates.filter(({ assignment }) =>
      taskMentionsAgentNameAsWord(assignment.task, normalizedAgentName)
    );

    // Stage 4: a (single or multi) exact-name candidate must still clear the
    // shared prompt-overlap floor — the agent name alone is not enough
    // confidence to claim. If the floor isn't cleared we return null so the
    // caller falls back to the default route (the over-claim fix).
    if (exactNameCandidates.length > 0) {
      const bestExactNameMatch = scoreSubAgentAssignmentCandidates(exactNameCandidates, promptTokens);
      if (clearsOverlapFloor(bestExactNameMatch) && bestExactNameMatch) {
        return createSubAgentAssignmentClaim(bestExactNameMatch, consumedAssignments);
      }
      return null;
    }
  }

  if (promptTokens.size === 0) return null;

  const bestMatch = scoreSubAgentAssignmentCandidates(candidates, promptTokens);
  if (clearsOverlapFloor(bestMatch) && bestMatch) {
    return createSubAgentAssignmentClaim(bestMatch, consumedAssignments);
  }

  return null;
}

export const AGENT_TOOL_DEFINITION: ToolDefinition = {
  name: 'Agent',
  description:
    'Delegate a task to a specialized sub-agent that runs in its own context. ' +
    'Each sub-agent has specific expertise defined by its description. ' +
    'The sub-agent works independently and returns its final response.',
  input_schema: {
    type: 'object',
    properties: {
      agent: {
        type: 'string',
        description: 'Name of the agent to invoke.',
      },
      prompt: {
        type: 'string',
        description: 'The task or question to delegate to the agent.',
      },
    },
    required: ['agent', 'prompt'],
  },
};

export function buildAgentToolDefinition(
  agents: Record<string, RebelCoreAgentDefinition>,
): ToolDefinition {
  const agentNames = Object.keys(agents);
  const agentDescriptions = agentNames
    .map(name => `${name} — ${agents[name].description ?? 'No description'}`)
    .join('; ');

  return {
    name: 'Agent',
    description:
      'Delegate a task to a specialized sub-agent that runs in its own context. ' +
      'Each sub-agent has specific expertise defined by its description. ' +
      'The sub-agent works independently and returns its final response.',
    input_schema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          enum: agentNames.length > 0 ? agentNames : undefined,
          description: agentNames.length > 0
            ? `Name of the agent to invoke. Available agents: ${agentDescriptions}`
            : 'Name of the agent to invoke.',
        },
        prompt: {
          type: 'string',
          description: 'The task or question to delegate to the agent.',
        },
      },
      required: ['agent', 'prompt'],
    },
  };
}


function resolveSubagentTools(
  agentDef: RebelCoreAgentDefinition,
  allBuiltinTools: ToolDefinition[],
  mcpToolDefs: ToolDefinition[],
  depth: number,
): ToolDefinition[] {
  if (!agentDef.tools) {
    const tools: ToolDefinition[] = [
      ...allBuiltinTools,
      ...mcpToolDefs,
    ];

    if (depth < 2 && !tools.some((tool) => tool.name === AGENT_TOOL_DEFINITION.name)) {
      tools.push(AGENT_TOOL_DEFINITION);
    }

    return tools;
  }

  const allowed = new Set(agentDef.tools);
  if (depth >= 2) {
    allowed.delete('Agent');
    allowed.delete('Task');
  }

  const tools: ToolDefinition[] = [];

  for (const tool of allBuiltinTools) {
    if (allowed.has(tool.name)) {
      tools.push(tool);
    }
  }

  for (const tool of mcpToolDefs) {
    if (allowed.has(tool.name)) {
      tools.push(tool);
    }
  }

  if (
    depth < 2
    && (allowed.has(AGENT_TOOL_DEFINITION.name) || allowed.has('Task'))
    && !tools.some((tool) => tool.name === AGENT_TOOL_DEFINITION.name)
  ) {
    tools.push(AGENT_TOOL_DEFINITION);
  }

  return tools;
}

/** Maximum number of tool events forwarded per sub-agent execution to prevent UI lockup */
const MAX_FORWARDED_EVENTS_PER_SUBAGENT = 200;

export async function executeAgentTool(
  input: unknown,
  ctx: AgentToolContext,
  parentToolUseId: string = '',
): Promise<ToolExecutionResult> {
  const startTime = Date.now();
  const params = input as { agent?: string; prompt?: string };

  if (!params.agent || !params.prompt) {
    return { output: 'Agent tool requires both "agent" and "prompt" parameters.', isError: true };
  }

  // Strip leading "ultrathink" from subagent prompts — redundant in Rebel Core
  // where thinking level is controlled via API parameters, not prompt keywords.
  params.prompt = params.prompt.replace(/^\s*ultrathink[\s.,;:!?\n]*/i, '').trim() || params.prompt;

  const agentDef = ctx.agents[params.agent];
  if (!agentDef) {
    const available = Object.keys(ctx.agents).join(', ');
    return {
      output: `Unknown agent "${params.agent}". Available agents: ${available || 'none'}`,
      isError: true,
    };
  }

  // MUST remain in the synchronous prefix of executeAgentTool (before any await).
  // See claimSubAgentAssignment() doc comment for race-safety invariant details.
  let claim: SubAgentAssignmentClaim | null = null;
  let matchedAssignment: SubAgentAssignment | undefined;
  if (ctx.planRouting && ctx.settings.experimental?.adaptiveRoutingEnabled) {
    if (!ctx.consumedAssignments) {
      log.warn(
        {
          planRoutingPresent: !!ctx.planRouting,
          adaptiveRouting: !!ctx.settings.experimental?.adaptiveRoutingEnabled,
        },
        'AgentToolContext.consumedAssignments missing despite planRouting being active — sibling consume safety may be silently disabled. This indicates a context-wiring bug.',
      );
    }
    const consumedAssignments = ctx.consumedAssignments ?? new Set<string>();
    claim = claimSubAgentAssignment(
      params.agent,
      params.prompt,
      ctx.planSteps,
      consumedAssignments,
    );
    matchedAssignment = claim?.assignment;
  }

  try {
    if (
      !claim
      && ctx.planRouting
      && ctx.settings.experimental?.adaptiveRoutingEnabled
    ) {
      log.warn(
        {
          agent: params.agent,
          promptPrefix: params.prompt.slice(0, 80),
          planStepCount: ctx.planSteps?.length ?? 0,
          assignmentCount: ctx.planSteps?.reduce((sum, step) => sum + (step.sub_agents?.length ?? 0), 0) ?? 0,
        },
        'Sub-agent invocation did not match any planner assignment despite active plan routing — falling back to default model. This may indicate ambiguous prompts or a generic agent name.',
      );
    }
    const parentDepth = ctx.depth ?? 0;
    const childDepth = parentDepth + 1;
    const parentNamespace = ctx.agentNamespace ?? MAIN_NAMESPACE;
    const childNamespace = `${parentNamespace}/${params.agent}`;
    const sharedTaskStore = ctx.taskStoreInternal;

    const trackingTaskId = sharedTaskStore
      ? createDelegationTrackingTask(
        sharedTaskStore,
        childNamespace,
        params.agent,
        params.prompt,
        agentDef.routedModel?.trim() || null,
      )
      : undefined;

    log.info(
      {
        agent: params.agent,
        promptLength: params.prompt.length,
        parentDepth,
        childDepth,
        parentNamespace,
        childNamespace,
        trackingTaskId,
      },
      'Spawning sub-agent',
    );
    if (ctx.planRouting) {
      log.info(
        {
          agent: params.agent,
          defaultModel: ctx.planRouting.default_model,
          hasEscalation: !!ctx.planRouting.escalation,
        },
        'Adaptive routing context available for sub-agent',
      );
    }

    const contextMode = matchedAssignment?.context ?? 'contextual';
    const isScopedContext = contextMode === 'scoped';

    // Lightweight agents keep prompts minimal by skipping dynamic prompt injections.
    let additionalContext: string | undefined;
    if (!isScopedContext && !agentDef.lightweight && ctx.hooks?.SubagentStart) {
      additionalContext = await runSubagentStartHooks(ctx.hooks.SubagentStart, ctx.hookContext);
    }

  // Build sub-agent system prompt as TextBlock[] for explicit cache breakpoints.
  // Block 1: stable agent definition prompt (with cache_control for reuse across invocations)
  // Block 2: dynamic parts (additionalContext, missionBriefing, summarize instruction)
  // When agentDef.prompt is empty, fall back to a plain string (no TextBlock[]).
  const dynamicParts: string[] = [];

  if (additionalContext) {
    dynamicParts.push(additionalContext);
  }

  if (!isScopedContext && !agentDef.lightweight && sharedTaskStore) {
    const missionBriefing = childDepth === 2
      ? serializeLightweightMissionBriefing(sharedTaskStore, params.agent, params.prompt, childNamespace)
      : serializeMissionBriefing(sharedTaskStore, params.agent, params.prompt, childNamespace);
    dynamicParts.push(missionBriefing);
  }

  // Instruct non-lightweight and scoped sub-agents to summarize their work before completing.
  if (!agentDef.lightweight || isScopedContext) {
    dynamicParts.push(SUMMARIZE_RESULT_INSTRUCTION);
  }

  let systemPrompt: SystemPrompt;
  if (isScopedContext) {
    const scopedPrompt = buildScopedSystemPrompt() as TextBlock[];
    if (dynamicParts.length > 0) {
      systemPrompt = [
        ...scopedPrompt,
        {
          type: 'text' as const,
          text: dynamicParts.join('\n\n'),
        },
      ];
    } else {
      systemPrompt = scopedPrompt;
    }
    log.info(
      { agent: params.agent, contextMode },
      'Sub-agent running in scoped mode (minimal prompt, full tools)',
    );
  } else if (agentDef.prompt) {
    // Structured prompt: stable block gets cache breakpoint, dynamic block does not.
    // Block 1 text ends with \n because openaiTranslators.translateMessagesToOpenAI()
    // joins TextBlock[] with .join('\n'). The trailing \n + joiner \n = \n\n, preserving
    // the double-newline separator the original string concatenation produced.
    // See: subAgentPromptCaching.test.ts "first block text ends with \\n"
    const stableBlock: TextBlock = {
      type: 'text' as const,
      text: `${agentDef.prompt}\n`,
      cache_control: { type: 'ephemeral' as const },
    };
    if (dynamicParts.length > 0) {
      const dynamicBlock: TextBlock = {
        type: 'text' as const,
        text: dynamicParts.join('\n\n'),
      };
      systemPrompt = [stableBlock, dynamicBlock];
    } else {
      systemPrompt = [stableBlock];
    }
  } else {
    // Empty agent prompt — fall back to plain string
    systemPrompt = dynamicParts.join('\n\n');
  }

  const routeScope = routeScopeForRoutingMode(agentDef.routingMode);
  let model: RoutingModelId;
  let routeModel: string;
  let routeProfile: ModelProfile | null = null;
  try {
    if (agentDef.btsCategory) {
      const configuredBtsModel = resolveConfiguredBtsModel(ctx.settings, agentDef.btsCategory);
      if (!configuredBtsModel) {
        const fastResolution = resolveDefaultModelForRole(
          'background',
          ctx.settings,
          ctx.settings.localModel?.profiles ?? [],
        );
        if (!fastResolution.ok) {
          throw roleFailureToModelError(fastResolution);
        }
        routeModel = fastResolution.model;
      } else {
        routeModel = configuredBtsModel;
      }

      routeProfile = findSelectableProfileForModel(ctx.settings, routeModel);
      const rawModel = routeProfile?.model
        ?? (isProfileReference(routeModel) ? '' : routeModel);
      const decodedRouteModel = rawModel
        ? decodeSubagentRoutingModelOrThrow(rawModel, 'sub-agent route')
        : null;
      if (!decodedRouteModel?.trim()) {
        const fastResolution = resolveDefaultModelForRole(
          'background',
          ctx.settings,
          ctx.settings.localModel?.profiles ?? [],
        );
        if (!fastResolution.ok) {
          throw roleFailureToModelError(fastResolution);
        }
        routeModel = fastResolution.model;
        routeProfile = findSelectableProfileForModel(ctx.settings, routeModel);
        model = routeProfile?.model
          ? decodeSubagentRoutingModelOrThrow(routeProfile.model, 'fast sub-agent profile')
          : fastResolution.model;
      } else {
        model = decodedRouteModel;
      }
    } else {
      model = resolveSubagentModel(agentDef.model, ctx.parentModel, ctx.settings);
      // Council/ad-hoc agents intentionally preserve the semantic model alias
      // ("working" in generated route-table agents). The concrete routed backend
      // model is carried separately via agentDef.routedModel.
      routeModel = isRouteTableScope(routeScope) && agentDef.model && agentDef.model !== 'inherit'
        ? agentDef.model
        : model;
      routeProfile = isRouteTableScope(routeScope)
        ? null
        : findSelectableProfileForModel(ctx.settings, routeModel);
    }
  } catch (error) {
    const roleFailure = error instanceof ModelError
      ? error.details?.roleResolutionFailure
      : undefined;
    if (isRoleResolutionFailure(roleFailure) && roleFailure.role === 'background') {
      const warningMessage = humanizeRoleResolutionFailure(roleFailure);
      log.warn(
        {
          agent: params.agent,
          role: roleFailure.role,
          reason: roleFailure.reason,
          profileId: roleFailure.profileId ?? null,
          trackingTaskId,
        },
        'Sub-agent skipped because fast role is not configured',
      );
      if (ctx.onSubAgentEvent && parentToolUseId) {
        try {
          ctx.onSubAgentEvent(
            {
              type: 'status',
              message: makeRoleNotConfiguredStatusMessage('background'),
            },
            parentToolUseId,
          );
        } catch (eventError) {
          log.warn(
            {
              agent: params.agent,
              parentToolUseId,
              role: 'background',
              error: eventError instanceof Error ? eventError.message : String(eventError),
            },
            'Failed to emit fast role-not-configured status event',
          );
        }
      }
      markTrackingTaskBlocked(sharedTaskStore, trackingTaskId, warningMessage);
      if (!isScopedContext && ctx.hooks?.SubagentStop) {
        await runSubagentStopHooks(ctx.hooks.SubagentStop, ctx.hookContext);
      }
      return {
        output: FAST_MODEL_NOT_CONFIGURED_TOOL_MESSAGE,
        isError: true,
      };
    }
    throw error;
  }
  let routedModelForTransport = agentDef.routedModel?.trim() || null;
  // Resolve thinking config for the sub-agent's actual model
  const requestedSubMaxTokens = ctx.parentMaxTokens ?? 32_768;
  const subEffort = ctx.parentEffort;
  // Map API effort back to ThinkingEffort for resolveThinkingConfig
  let effortAsThinking = subEffort === 'max' ? 'xhigh' as const
    : subEffort === 'high' ? 'high' as const
      : subEffort === 'medium' ? 'medium' as const
        : subEffort === 'low' ? 'low' as const : undefined;

  if (matchedAssignment) {
    if (isRouteTableScope(routeScope)) {
      const { canonicalSlug, warnings } = canonicalizeSubAgentModel(matchedAssignment.model, ctx);
      if (canonicalSlug == null) {
        log.warn(
          {
            agent: params.agent,
            assignedModel: matchedAssignment.model,
            matchedTask: matchedAssignment.task,
            warnings,
            availableAgents: Object.keys(ctx.agents),
          },
          'Sub-agent assignment unrecognized; falling back to default route',
        );
      } else {
        const targetAgent = ctx.agents[canonicalSlug];
        const assignedRouteModel = targetAgent?.routedModel?.trim() || null;
        if (assignedRouteModel) {
          // Route-table scope: `assignedRouteModel` is the GENERATED route-table
          // agent's own configured `routedModel`, not a free planner model
          // string — the agent dispatches on it regardless of whether a profile
          // matches (see the `?? assignedRouteModel` fallback below). Resolving
          // it keeps the agent-OWN-model gate (no routingEligible / connectivity
          // gate) — the same gate the BTS/default-route path uses. The
          // routing-pool gate applies only to the planner-ASSIGNED model in the
          // non-route-table branch below.
          const assignedProfile = findSelectableProfileForModel(ctx.settings, assignedRouteModel);
          const resolvedAssignedModel = assignedProfile?.model ?? assignedRouteModel;
          model = decodeSubagentRoutingModelOrThrow(resolvedAssignedModel, 'assigned sub-agent route');
          routeModel = resolvedAssignedModel;
          routeProfile = assignedProfile ?? null;
          routedModelForTransport = assignedRouteModel;
          effortAsThinking = matchedAssignment.effort;
          log.info(
            {
              agent: params.agent,
              assignedModel: matchedAssignment.model,
              canonicalSlug,
              routedModel: assignedRouteModel,
              resolvedModel: resolvedAssignedModel,
              assignedEffort: matchedAssignment.effort,
              matchedTask: matchedAssignment.task,
              context: matchedAssignment.context,
            },
            'Sub-agent routing: matched plan assignment',
          );
        } else {
          log.warn(
            {
              agent: params.agent,
              assignedModel: matchedAssignment.model,
              canonicalSlug,
              matchedTask: matchedAssignment.task,
            },
            'Sub-agent assignment resolved to agent without routedModel; falling back to default route',
          );
        }
      }
    } else {
      const assignedProfile = resolveAssignedSubAgentProfile(ctx, matchedAssignment.model);
      if (assignedProfile?.model) {
        model = decodeSubagentRoutingModelOrThrow(assignedProfile.model, 'assigned sub-agent profile');
        routeModel = assignedProfile.model;
        routeProfile = assignedProfile;
        effortAsThinking = matchedAssignment.effort;
        log.info(
          {
            agent: params.agent,
            assignedModel: model,
            assignedEffort: matchedAssignment.effort,
            matchedTask: matchedAssignment.task,
            context: matchedAssignment.context,
          },
          'Sub-agent routing: matched plan assignment',
        );
      } else {
        log.warn(
          {
            agent: params.agent,
            assignedModel: matchedAssignment.model,
            matchedTask: matchedAssignment.task,
          },
          'Sub-agent routing: assigned model profile not found — using default sub-agent route',
        );
      }
    }
  }

  if (isRouteTableScope(routeScope) && (!routedModelForTransport || routedModelForTransport.trim().length === 0)) {
    routedModelForTransport = model;
  }

  // Clamp subMaxTokens to the sub-agent model's actual maxOutputTokens.
  // Without this clamp, a parent on a high-output model (e.g. GPT-5.5 / Opus 4.7
  // at 128K) would push max_tokens=128000 down to a sub-agent on a lower-output
  // model (e.g. Haiku 4.5 at 64K), and Anthropic rejects with a 400
  // invalid_request_error.
  //
  // The cap MUST key on the CONCRETE routed backend that actually runs, not the
  // body/alias model. For route-table scopes (council + ad-hoc) `model` is the
  // alias-resolved working placeholder (e.g. `'working'` → GPT-5.5/128K), while
  // the concrete backend (e.g. Haiku 4.5/64K) rides separately in
  // `routedModelForTransport` (and is sent via the `x-routed-model` header).
  // Resolving the cap against `model` there silently fails to clamp whenever the
  // backend's cap is lower than the parent's. For normal-turn (`subagent`) scope
  // `model` IS the concrete backend, so we key on it directly. The
  // `routeProfile`-based profile inputs are kept unchanged: on route-table scopes
  // `routeProfile` is null (harmless); on the assigned-plan branch it corresponds
  // to the routed model.
  const subModelForLimits = isRouteTableScope(routeScope)
    ? (routedModelForTransport ?? model)
    : model;
  const subModelLimits = resolveModelLimits({
    model: subModelForLimits,
    profileMaxOutput: routeProfile?.maxOutputTokens,
    profileMaxOutputSource: routeProfile?.outputTokensSource,
    profileContextWindow: routeProfile?.contextWindow,
    profileContextWindowSource: routeProfile?.contextWindowSource,
    allProfiles: ctx.settings.localModel?.profiles ?? [],
  });
  const subMaxTokens = Math.min(requestedSubMaxTokens, subModelLimits.maxOutputTokens);
  if (subMaxTokens < requestedSubMaxTokens) {
    log.info(
      {
        agent: params.agent,
        subModel: model,
        subModelForLimits,
        parentMaxTokens: requestedSubMaxTokens,
        subModelMaxOutput: subModelLimits.maxOutputTokens,
        clampedTo: subMaxTokens,
      },
      'Sub-agent maxTokens clamped to sub-model output limit',
    );
  }
  // INTENTIONALLY keyed on `model` (the alias), NOT the concrete routed backend
  // (`subModelForLimits`), unlike the max_tokens clamp above. Two reasons, verified
  // by cross-family research (260613_subagent-capability-model-class):
  //   1. Inert on the wire for route-table scopes. `max_tokens` is forwarded
  //      verbatim upstream, but `thinking`/`effort` are NOT: a turn-scoped route-table
  //      dispatch always resolves-or-400s to a concrete profile in the proxy
  //      (resolveRouteProfile Step 1, localModelProxyServer.ts — the turn route table
  //      never falls through to the verbatim passthrough), which rebuilds the request
  //      from `profile.reasoningEffort` and drops the inbound `thinking`/`output_config`.
  //      So keying these on the concrete backend would change nothing on the wire.
  //   2. `subApiEffort` ALSO feeds the user-facing effort badge / routing telemetry
  //      below (`routingMeta.effort`, getExecutionRoute, the task badge), where the
  //      requested working-tier effort (the alias) is the correct thing to show.
  // Do NOT "fix" these to `subModelForLimits` — that's a wire-neutral change that
  // would regress the effort badge. The clean home for splitting wire-capability
  // from display-capability is the descriptor redesign (SPIN OUT in the plan).
  const subThinking = resolveThinkingConfig(effortAsThinking, model, subMaxTokens);
  const subApiEffort = resolveEffortForApi(effortAsThinking, model);

  const routingMeta = matchedAssignment
    ? {
      model,
      contextMode,
      ...(subApiEffort ? { effort: subApiEffort } : {}),
    }
    : undefined;

  if (routingMeta && ctx.onSubAgentEvent && parentToolUseId) {
    const requestedModel = matchedAssignment?.model ?? model;
    const requestedEffort = matchedAssignment?.effort ?? 'default';
    const resolvedEffort = routingMeta.effort ?? 'default';
    const routingMismatch = requestedModel !== model || requestedEffort !== resolvedEffort;
    ctx.onSubAgentEvent(
      {
        type: 'status',
        message: `${SUBAGENT_ROUTING_STATUS_PREFIX}${[
          encodeURIComponent(parentToolUseId),
          encodeURIComponent(routingMeta.model),
          encodeURIComponent(routingMeta.contextMode),
          encodeURIComponent(resolvedEffort),
          encodeURIComponent(requestedModel),
          encodeURIComponent(requestedEffort),
          encodeURIComponent(routingMismatch ? '1' : '0'),
        ].join(':')}`,
      },
      parentToolUseId,
    );
  }

  // Stamp the delegation tracking task with the resolved sub-agent routing so
  // MissionProgressCard renders the sub-agent name + Bot icon + model badge.
  // Fires regardless of plan mode — this is what restores per-task badges for
  // agent-emitted tasks when no planner phase ran. Uses subApiEffort (post-clamp)
  // and contextMode (the actual context propagated to the sub-agent), not the
  // plan-time matchedAssignment alternatives.
  if (trackingTaskId && ctx.onTaskRoutingMetadataUpdate) {
    ctx.onTaskRoutingMetadataUpdate(trackingTaskId, {
      model,
      ...(subApiEffort ? { effort: subApiEffort } : {}),
      isSubAgent: true,
      subAgentContext: contextMode,
    });
  }

  // Per-sub-agent dispatch descriptor: create the client and the body model it
  // speaks together instead of carrying independent `subClient` + `bodyModel`
  // variables through the seam.
  let subAgentDispatch: SubAgentDispatchDescriptor;
  try {
    const baseDecision = ProviderRouter.forSubagent({
      model: routeModel,
      ...(routeProfile ? { profile: routeProfile } : {}),
      settings: ctx.settings,
      routeScope,
      routedModel: routedModelForTransport,
      codexConnectivity: inferCodexConnectivity(ctx),
    });
    const agentName = params.agent;
    const runtimeContext = {
      turnId: ctx.turnId ?? ctx.transcriptTurnId ?? null,
      agentId: agentName,
      routedModel: routedModelForTransport,
      proxyAuthToken: ctx.proxyConfig?.defaultHeaders?.['x-proxy-auth'] ?? null,
      proxyBaseURL: ctx.proxyConfig?.baseURL ?? null,
      anthropicApiKey: getApiKey(ctx.settings) ?? null,
      anthropicOAuthToken: getOAuthToken(ctx.settings) ?? null,
      openRouterOAuthToken: ctx.settings.openRouter?.oauthToken ?? null,
      profileApiKey: routeProfile
        ? resolveProfileApiKey(routeProfile, ctx.settings.providerKeys, ctx.settings.customProviders)
        : null,
      codexAuthProvider: ctx.codexAuthProvider ?? null,
      processEnv: process.env as Record<string, string>,
    };
    const plan = await materializePlanRuntime(baseDecision, runtimeContext);
    if (isTerminalRoutePlan(plan)) {
      throwSubagentTerminalPlan(plan, agentName);
    }
    const dispatchablePlan = plan;
    subAgentDispatch = createSubAgentDispatchDescriptor({
      plan: dispatchablePlan,
      settings: ctx.settings,
      resolvedModel: model,
      codexMode: ctx.codexMode,
      routeProfile,
    });
  } catch (clientError) {
    const msg = clientError instanceof Error ? clientError.message : String(clientError);
    log.warn({ agent: params.agent, model, err: msg }, 'Sub-agent client creation failed');
    // Mark tracking task as blocked
    if (trackingTaskId && sharedTaskStore) {
      try {
        const existingTask = sharedTaskStore._getRawTask(trackingTaskId);
        if (existingTask) {
          sharedTaskStore._setRawTask(trackingTaskId, {
            ...existingTask,
            status: 'blocked',
            notes: `Client creation failed: ${msg}`,
            updatedAt: Date.now(),
          });
          sharedTaskStore._refreshBlockedTasks();
        }
      } catch { /* silent */ }
    }
    return {
      output: `Sub-agent "${params.agent}" failed to initialize: ${msg}. The model "${model}" may require credentials that are not configured.`,
      isError: true,
    };
  }

  let timedOut = false;
  let composedSignal = ctx.signal;
  const maxDurationMs = agentDef.maxDurationMs;
  if (maxDurationMs && maxDurationMs > 0) {
    const timeoutSignal = AbortSignal.timeout(maxDurationMs);
    timeoutSignal.addEventListener('abort', () => { timedOut = true; }, { once: true });
    composedSignal = ctx.signal
      ? AbortSignal.any([ctx.signal, timeoutSignal])
      : timeoutSignal;
  }

  // Filter suppressed builtins so sub-agents inherit parent's capability
  // suppression AND drop the prior-turns inspection surface unconditionally
  // (F1 — the inspection tools are main-agent only; see comment on
  // SUBAGENT_SUPPRESSED_PRIOR_TURN_BUILTINS above).
  const allBuiltinTools = getBuiltinToolDefinitions();
  const suppressedSet = new Set<BuiltinToolName>([
    ...(ctx.suppressedBuiltins ?? []),
    ...SUBAGENT_SUPPRESSED_PRIOR_TURN_BUILTINS,
  ]);
  const builtinTools = allBuiltinTools.filter(
    (t) => !suppressedSet.has(t.name as BuiltinToolName),
  );
  const mcpTools = ctx.mcpToolDefs ?? [];
  const tools = resolveSubagentTools(agentDef, builtinTools, mcpTools, childDepth);

  if (childDepth === 2 && !tools.some((tool) => tool.name === GET_MISSION_CONTEXT_TOOL_DEFINITION.name)) {
    tools.push(GET_MISSION_CONTEXT_TOOL_DEFINITION);
  }

  // Add SummarizeResult for non-lightweight and scoped sub-agents so they can share findings.
  if (
    (!agentDef.lightweight || isScopedContext)
    && !tools.some((tool) => tool.name === SUMMARIZE_RESULT_TOOL_DEFINITION.name)
  ) {
    tools.push(SUMMARIZE_RESULT_TOOL_DEFINITION);
  }

  // Build sub-agent tool executor (built-in + MCP + depth-limited Agent delegation)
  const childTaskStore = sharedTaskStore
    ? createScopedTaskStore(sharedTaskStore, childNamespace, childDepth)
    : createTaskStore();

  const mcpSession = ctx.mcpSession;
  const subagentCodexConnectivity = inferCodexConnectivity(ctx);
  const subagentToolContext = {
    ...(ctx.transcriptSessionId ? { sessionId: ctx.transcriptSessionId } : {}),
    ...(ctx.transcriptTurnId ? { currentTurnId: ctx.transcriptTurnId } : {}),
    ...(ctx.surfaceCapability ? { surfaceCapability: ctx.surfaceCapability } : {}),
    ...(ctx.wasExplicitCouncilIntent !== undefined ? { wasExplicitCouncilIntent: ctx.wasExplicitCouncilIntent } : {}),
    cwd: ctx.cwd,
    ...(ctx.homePath ? { homePath: ctx.homePath } : {}),
    ...(ctx.userDataPath ? { userDataPath: ctx.userDataPath } : {}),
    ...(ctx.allowedSymlinkTargets ? { allowedSymlinkTargets: ctx.allowedSymlinkTargets } : {}),
    signal: composedSignal,
    taskStore: childTaskStore,
    ...(sharedTaskStore ? { taskStoreInternal: sharedTaskStore } : {}),
    agentNamespace: childNamespace,
    depth: childDepth,
    getExecutionRoute: () => ({
      model,
      profileId: routeProfile?.id ?? null,
      ...(subApiEffort ? { effort: subApiEffort } : {}),
      codexConnectivity: subagentCodexConnectivity,
    }),
    executeMcpTool: mcpSession ? (name: string, input: unknown) => mcpSession.executeTool(name, input) : null,
    captureRebelWindow: ctx.captureRebelWindow,
    navigateApp: ctx.navigateApp,
    ...(ctx.visualVerificationNavigation ? { visualVerificationNavigation: ctx.visualVerificationNavigation } : {}),
    ...(ctx.visualVerificationNavigationState
      ? { visualVerificationNavigationState: ctx.visualVerificationNavigationState }
      : {}),
    onFileChanged: ctx.onFileChanged,
    // Share the parent's per-turn rate limit state so sub-agents don't each
    // get their own WebSearch/WebFetch budget. Without this propagation, a
    // single turn could issue 5*(N subagents+1) WebSearch calls against DDG
    // and bypass the per-task Sentry dedupe in webSearchTool.ts.
    ...(ctx.rateLimitState ? { rateLimitState: ctx.rateLimitState } : {}),
    ...(ctx.transcriptSessionId && ctx.transcriptTurnId && ctx.nextToolResultEventSeq ? {
      imageAssetContext: {
        sessionId: ctx.transcriptSessionId,
        turnId: ctx.transcriptTurnId,
        nextToolResultEventSeq: ctx.nextToolResultEventSeq,
        surface: resolveImageAssetSurface(ctx),
      },
    } : {}),
  };

  const childCanSpawn = childDepth < 2;
  const childAgentCtx: AgentToolContext | null = childCanSpawn
    ? {
      agents: ctx.agents,
      client: subAgentDispatch.client,
      settings: ctx.settings,
      parentModel: model,
      parentMaxTokens: ctx.parentMaxTokens,
      parentEffort: ctx.parentEffort,
      ...(ctx.planRouting ? { planRouting: ctx.planRouting } : {}),
      ...(ctx.planSteps ? { planSteps: ctx.planSteps } : {}),
      ...(ctx.consumedAssignments ? { consumedAssignments: ctx.consumedAssignments } : {}),
      ...(ctx.proxyConfig ? { proxyConfig: ctx.proxyConfig } : {}),
      ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
      codexConnectivity: ctx.codexConnectivity,
      ...(ctx.connectivity ? { connectivity: ctx.connectivity } : {}),
      ...(ctx.codexAuthProvider ? { codexAuthProvider: ctx.codexAuthProvider } : {}),
      depth: childDepth,
      agentNamespace: childNamespace,
      ...(sharedTaskStore ? { taskStoreInternal: sharedTaskStore } : {}),
      cwd: ctx.cwd,
      ...(ctx.homePath ? { homePath: ctx.homePath } : {}),
      ...(ctx.userDataPath ? { userDataPath: ctx.userDataPath } : {}),
      ...(ctx.allowedSymlinkTargets ? { allowedSymlinkTargets: ctx.allowedSymlinkTargets } : {}),
      signal: composedSignal,
      captureRebelWindow: ctx.captureRebelWindow,
      navigateApp: ctx.navigateApp,
      ...(ctx.visualVerificationNavigation ? { visualVerificationNavigation: ctx.visualVerificationNavigation } : {}),
      ...(ctx.visualVerificationNavigationState
        ? { visualVerificationNavigationState: ctx.visualVerificationNavigationState }
        : {}),
      hooks: ctx.hooks,
      hookContext: ctx.hookContext,
      mcpSession: ctx.mcpSession,
      mcpToolDefs: ctx.mcpToolDefs,
      onSubAgentEvent: ctx.onSubAgentEvent,
      // Propagate so nested sub-agent delegations (depth >= 2) also stamp
      // their tracking tasks with sub-agent routing metadata. Same shared
      // taskRoutingMetadata map closure target as the top-level main agent.
      onTaskRoutingMetadataUpdate: ctx.onTaskRoutingMetadataUpdate,
      onFileChanged: ctx.onFileChanged,
      suppressedBuiltins: Array.from(suppressedSet),
      ...(ctx.rateLimitState ? { rateLimitState: ctx.rateLimitState } : {}),
      ...(ctx.surfaceCapability ? { surfaceCapability: ctx.surfaceCapability } : {}),
      ...(ctx.wasExplicitCouncilIntent !== undefined ? { wasExplicitCouncilIntent: ctx.wasExplicitCouncilIntent } : {}),
      ...(ctx.transcriptSessionId ? {
        transcriptSessionId: ctx.transcriptSessionId,
        transcriptTurnId: ctx.transcriptTurnId,
        transcriptSeqCounter: ctx.transcriptSeqCounter,
        nextToolResultEventSeq: ctx.nextToolResultEventSeq,
        imageAssetSurface: resolveImageAssetSurface(ctx),
      } : {}),
    }
    : null;

  const maxTurnsCap = MAX_TURNS_BY_DEPTH[childDepth] ?? MAX_TURNS_BY_DEPTH[MAX_TURNS_BY_DEPTH.length - 1];
  const maxTurns = Math.min(agentDef.maxTurns ?? maxTurnsCap, maxTurnsCap);

  const baseExecute = async (
    toolName: string,
    toolInput: unknown,
    _id: string,
    toolSignal: AbortSignal,
  ) => {
    const subagentToolContextWithSignal = { ...subagentToolContext, signal: toolSignal };

    if ((toolName === 'Agent' || toolName === 'Task') && childAgentCtx) {
      return executeAgentTool(toolInput, { ...childAgentCtx, signal: toolSignal }, _id);
    }

    if (isBuiltinToolName(toolName)) {
      return executeBuiltinTool(toolName, toolInput, subagentToolContextWithSignal);
    }
    if (isMcpToolName(toolName) && ctx.mcpSession) {
      return ctx.mcpSession.executeTool(toolName, toolInput, _id, toolSignal);
    }
    return { output: `Unknown tool: ${toolName}`, isError: true };
  };

  // Sub-agents get PreToolUse/PostToolUse hooks from parent
  const toolExecutor = createHookAwareToolExecutor(
    baseExecute,
    ctx.hooks ? { PreToolUse: ctx.hooks.PreToolUse, PostToolUse: ctx.hooks.PostToolUse } : undefined,
    ctx.hookContext,
  );

  // Run the nested agent loop
  let accumulatedText = '';
  let forwardedEventCount = 0;
  const subAgentUsageByModel = new Map<string, TokenUsage>();

  try {
    if (composedSignal?.aborted) {
      throw createAbortError(timedOut, maxDurationMs);
    }
    const subAgentProfileIdForCallback = routeProfile?.id ?? null;
    // Key reasoning-replay capability on the CONCRETE routed backend, not the alias
    // `model`. This is a DESTINATION-capability bit: it drives local thinking-block
    // retention between turns (agentLoop.ts; 50 turns for DeepSeek/DS4 vs 2) AND
    // OpenAI-compatible `reasoning_content` replay in assistant history — so it must
    // describe the model that actually runs. For a route-table dispatch `model` is the
    // alias (e.g. `'working'`), while the request runs on `subModelForLimits`
    // (= `routedModelForTransport`); alias-keying is wrong in both directions
    // (non-DeepSeek alias → DeepSeek backend strips/replays wrong; DeepSeek alias →
    // non-DeepSeek backend over-retains). This aligns agentTool with the proxy's own
    // concrete replay recomputation on the resolved profile. The `routeProfile` arm
    // (local:ds4 presetKey) is preserved.
    //
    // STAGE0 (REBEL-5N8): this is the STREAMING HOT PATH. Capability is keyed on the concrete
    // backend model directly via `computeSupportsReasoningReplay` (concrete-keyed on
    // `subModelForLimits`). The former multi-axis `resolveModelCapabilities()` read-model was an
    // unconsumed orphan and has been removed; routing through it would have added a per-dispatch
    // catalog/limit resolve on the latency-sensitive path for no behavioural gain. The
    // concrete-keying invariant (must pass `subModelForLimits`, never the alias `model`) is pinned
    // by scripts/check-capability-resolution-dispatch-seam.ts — DO NOT change the 2nd argument.
    const supportsReasoningReplay = computeSupportsReasoningReplay(routeProfile, subModelForLimits);
    // REBEL-5N8 (Stage 3/5 — fail-closed seam backstop, DA critique 260608_091731
    // F6): because Stage 1's body-model derivation is GATED (runtime-reachable,
    // not structurally unreachable), this MUST be a real runtime branch, not an
    // assertNever.
    //
    // Stage 5 BROADENED the discriminant (F1 cross-family must-address) to fire for
    // ANY non-OpenRouter-passthrough Anthropic client when the body model carries a
    // foreign (slash) slug. The membership check now lives in the SHARED
    // `isNonPassthroughAnthropicTransport` predicate (Stage 3 class-killer), which
    // covers `codex-proxy` | `anthropic-compatible-local-proxy` | `anthropic-direct`
    // — the same set enforced at the shared `createClientFromRoutePlan` seam. The
    // shared seam already front-runs this for non-route-table dispatch (the client is
    // built there), so this is now defense-in-depth at the sub-agent door for the
    // streamed BODY model (which can diverge from the plan's wireModelId in gated
    // body-model derivation, REBEL-5N8 Stage 1). We keep the richer sub-agent message
    // (agent name) here. We do NOT fire for `openrouter-proxy` (passthrough,
    // slash-tolerated). The enclosing catch tags this `area=sub-agent-dispatch`.
    if (
      isNonPassthroughAnthropicTransport(subAgentDispatch.transport)
      && subAgentDispatch.bodyModel.includes('/')
    ) {
      throw createSubagentRoutingError(
        `Sub-agent "${params.agent}" routing mismatch: non-passthrough Anthropic dispatch (transport "${subAgentDispatch.transport}") resolved a foreign body model "${subAgentDispatch.bodyModel}" (resolved model "${model}"). A slash-namespaced id is not valid for a direct-Anthropic-dialect client; the concrete backend belongs in the x-routed-model header (route-table) or requires an OpenRouter-passthrough route.`,
        'routing',
      );
    }
    // LAST synchronous operation before runAgentLoop entry.
    claim?.commit();
    await runAgentLoop(
      {
        client: subAgentDispatch.client,
        model: subAgentDispatch.bodyModel,
        systemPrompt,
        messages: [{ role: 'user', content: params.prompt }],
        tools,
        maxTokens: subMaxTokens,
        maxTurns,
        signal: composedSignal,
        ...(ctx.transcriptSessionId ? {
          sessionId: ctx.transcriptSessionId,
          turnId: ctx.transcriptTurnId,
          nextToolResultEventSeq: ctx.nextToolResultEventSeq,
          imageAssetSurface: resolveImageAssetSurface(ctx),
        } : {}),
        suppressLoopComplete: true,
        ...(subThinking.type !== 'disabled' ? { thinking: subThinking } : {}),
        ...(subApiEffort ? { effort: subApiEffort } : {}),
        onRetry: (retryInfo) => {
          logProviderRetryTelemetry(retryInfo, 'sub-agent');
        },
        onContextOverflow: ({ lastKnownInputTokens }) => {
          recordContextOverflowOnProfile({
            model,
            profileId: subAgentProfileIdForCallback,
            lastKnownInputTokens,
          });
        },
      },
      toolExecutor,
      (event) => {
        // Accumulate text for the tool result (existing behavior — MUST remain)
        if (event.type === 'assistant:text') {
          accumulatedText += event.text;
        }

        if (event.type === 'turn:complete') {
          const reportedModelRaw = typeof event.model === 'string' ? event.model.trim() : '';
          const turnModel = reportedModelRaw || model;
          const existing = subAgentUsageByModel.get(turnModel) ?? { ...ZERO_TOKEN_USAGE };
          subAgentUsageByModel.set(turnModel, addUsage(existing, event.usage));

          if (turnModel !== model) {
            log.warn(
              {
                mismatch: true,
                agent: params.agent,
                parentToolUseId: parentToolUseId || null,
                routeResolvedModel: model,
                runtimeReportedModel: turnModel,
                routedModelForTransport,
                assignmentModel: matchedAssignment?.model ?? null,
                turnId: ctx.turnId ?? ctx.transcriptTurnId ?? null,
              },
              'routing:subagent:model-mismatch',
            );
          }
        }

        // Forward tool events to parent's stream for live sub-agent visibility
        if (
          ctx.onSubAgentEvent
          && (event.type === 'tool_use:start' || event.type === 'tool_use:result')
        ) {
          if (forwardedEventCount < MAX_FORWARDED_EVENTS_PER_SUBAGENT) {
            if (event.type === 'tool_use:start' && routingMeta) {
              const augmentedInput = typeof event.input === 'object' && event.input !== null
                ? { ...event.input, _routingMeta: routingMeta }
                : { _original: event.input, _routingMeta: routingMeta };
              ctx.onSubAgentEvent({ ...event, input: augmentedInput }, parentToolUseId);
            } else {
              ctx.onSubAgentEvent(event, parentToolUseId);
            }
            forwardedEventCount++;
          } else if (forwardedEventCount === MAX_FORWARDED_EVENTS_PER_SUBAGENT) {
            log.warn(
              { agent: params.agent, parentToolUseId, cap: MAX_FORWARDED_EVENTS_PER_SUBAGENT },
              'Sub-agent event forwarding cap reached — suppressing further events',
            );
            forwardedEventCount++; // Increment past cap to avoid repeat warnings
          }
        }

        // Log sub-agent events to transcript (fail-open, skip streaming deltas)
        if (ctx.transcriptSessionId && ctx.transcriptSeqCounter) {
          try {
            if (event.type !== 'assistant:text' && event.type !== 'assistant:thinking') {
              appendTranscriptEntry({
                v: 1,
                ts: Date.now(),
                sid: ctx.transcriptSessionId,
                tid: ctx.transcriptTurnId!,
                seq: ctx.transcriptSeqCounter.next(),
                depth: childDepth,
                ns: childNamespace,
                event: { kind: 'core', event },
              });
            }
          } catch { /* fail-open */ }
        }
      },
      { supportsReasoningReplay },
    );
  } catch (error) {
    // best-effort: a learned-limits write failure must not mask the original error.
    void safeDispatchLearnedLimitsFromError(error, {
      turnId: ctx.turnId ?? ctx.transcriptTurnId ?? 'unknown-turn',
      model,
      profileId: routeProfile?.id ?? null,
    }, log);

    const isAbort = timedOut
      || (error instanceof ModelError
        ? error.isAbort
        : isAgentToolTimeoutError(error) || (error instanceof Error && error.name === 'AbortError'));
    const msg = error instanceof Error ? error.message : String(error);

    if (!isAbort) {
      log.warn({ err: msg, errorKind: getErrorKind(error), agent: params.agent, trackingTaskId }, 'Sub-agent failed');
      try {
        getErrorReporter().captureExceptionWithScope?.(
          error instanceof Error ? error : new Error(msg),
          (scope) => {
            scope.setTag('area', 'sub-agent-dispatch');
            scope.setTag('agent', params.agent ?? 'unknown');
            scope.setTag('model', model);
            // Classified kind tag: sub-agent failures fold into a tool-result
            // string (below) and never reach the dispatcher's errorKind
            // pipeline, so without this tag the kind is unqueryable in Sentry.
            // Load-bearing for `image_input_unsupported`: route-table alias
            // legs fail the image-capability gate open BY DESIGN, and this tag
            // is the revisit signal for the deferred bodyModel/capabilityModel
            // split (docs/plans/260610_image-unsupported-by-model/PLAN.md
            // Discovered Improvements).
            scope.setTag('errorKind', getErrorKind(error));
            scope.setContext('subAgent', {
              agent: params.agent ?? 'unknown',
              model,
              trackingTaskId: trackingTaskId ?? null,
              promptPrefix: params.prompt?.slice(0, 200) ?? '',
            });
          },
        );
      } catch {
        // Fail-open — never mask the original sub-agent failure.
      }
    }

    // Update tracking task to blocked on failure/abort
    if (trackingTaskId && sharedTaskStore) {
      try {
        const existingTask = sharedTaskStore._getRawTask(trackingTaskId);
        if (existingTask) {
          sharedTaskStore._setRawTask(trackingTaskId, {
            ...existingTask,
            status: 'blocked',
            notes: isAbort ? 'Aborted' : `Error: ${msg}`,
            updatedAt: Date.now(),
          });
          sharedTaskStore._refreshBlockedTasks();
        }
      } catch {
        // Silent — don't mask original error
      }
    }

    if (isAbort) {
      if (timedOut) {
        const elapsed = Date.now() - startTime;
        log.warn(
          { agent: params.agent, model, maxDurationMs, elapsed, trackingTaskId,
            partialUsageModels: [...subAgentUsageByModel.keys()] },
          'Sub-agent timed out',
        );

        // Bubble partial usage (try/catch to avoid breaking parent turn)
        try {
          if (ctx.onSubAgentComplete && subAgentUsageByModel.size > 0) {
            ctx.onSubAgentComplete(subAgentUsageByModel);
          }
        } catch (e) {
          log.warn({ err: e }, 'Failed to merge sub-agent usage after timeout');
        }

        throw new AgentToolTimeoutError(`Sub-agent "${params.agent}" timed out after ${elapsed}ms`, maxDurationMs);
      }

      // Bubble partial usage before re-throwing abort (try/catch to avoid masking the abort)
      try {
        if (ctx.onSubAgentComplete && subAgentUsageByModel.size > 0) {
          ctx.onSubAgentComplete(subAgentUsageByModel);
        }
      } catch (e) {
        log.warn({ err: e }, 'Failed to merge sub-agent usage on abort');
      }

      throw error;
    }

    try {
      if (ctx.onSubAgentComplete && subAgentUsageByModel.size > 0) {
        ctx.onSubAgentComplete(subAgentUsageByModel);
      }
    } catch (e) {
      log.warn({ err: e }, 'Failed to merge sub-agent usage on non-abort error');
    }

    // Run SubagentStop hooks even on error
    if (!isScopedContext && ctx.hooks?.SubagentStop) {
      await runSubagentStopHooks(ctx.hooks.SubagentStop, ctx.hookContext);
    }

    return { output: `Sub-agent "${params.agent}" failed: ${msg}`, isError: true };
  }

  // Update tracking task to completed on success
  if (trackingTaskId && sharedTaskStore) {
    try {
      const existingTask = sharedTaskStore._getRawTask(trackingTaskId);
      if (existingTask) {
        sharedTaskStore._setRawTask(trackingTaskId, {
          ...existingTask,
          status: 'completed',
          notes: accumulatedText.slice(0, 500),
          updatedAt: Date.now(),
        });
        sharedTaskStore._refreshBlockedTasks();
      }
    } catch (e) {
      // Don't let rollup failure mask agent output
      log.warn({ err: e, agent: params.agent }, 'Failed to update tracking task');
    }
  }

  try {
    if (ctx.onSubAgentComplete && subAgentUsageByModel.size > 0) {
      ctx.onSubAgentComplete(subAgentUsageByModel);
    }
  } catch (e) {
    log.warn({ err: e }, 'Failed to merge sub-agent usage on completion');
  }

  // Run SubagentStop hooks
  if (!isScopedContext && ctx.hooks?.SubagentStop) {
    await runSubagentStopHooks(ctx.hooks.SubagentStop, ctx.hookContext);
  }

  log.info(
    { agent: params.agent, resultLength: accumulatedText.length, trackingTaskId },
    'Sub-agent completed',
  );

  return {
    output: accumulatedText || '(Sub-agent produced no output)',
    isError: false,
  };
  } finally {
    claim?.release();
  }
}
