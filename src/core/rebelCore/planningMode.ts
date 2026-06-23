import type { ChatMessage, ContentBlock, TokenUsage } from './modelTypes';
import type { RebelCoreThinkingConfig } from './modelLimits';
import { shouldSuppressProfileReasoning, resolveProfileReasoningEffort } from './modelLimits';
import type { JsonSchemaFormat, ModelClient, StreamEvent } from './modelClient';
import { createRoleResolutionModelError, ModelError } from './modelErrors';
import type { RebelCoreTaskStore, RebelCoreTaskStoreInternal } from './taskState';
import { PLAN_MODE_ALIAS, ENV_THINKING_MODEL, ENV_EXECUTION_MODEL } from '@shared/utils/modelNormalization';
import { createScopedLogger } from '@core/logger';
import { getErrorReporter } from '@core/errorReporter';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
import { getPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import { isStructuredOutputSchemaRejection } from '@rebel/shared';
import type { ModelProfile } from '@shared/types';
import {
  type ModelRoleResolverSettings,
  resolveDefaultModelForRole,
  type ModelRole,
  type RoleResolution,
} from './modelRoleResolver';
import { annotateModelRuntimeRole } from './configuredRoleFallback';
import { PARALLEL_AGENT_CAP } from './constants/limits';
import { decodeRoutingModelId, type RoutingModelId } from '@shared/utils/modelChoiceCodec';
import { getModelCapabilityDefaults, modelSupportsReasoning } from '@shared/data/modelProviderPresets';

const log = createScopedLogger({ service: 'planningMode' });

const MISSION_OWNER = 'mission';
const MISSION_GOAL_NOTE = 'goal';
const MISSION_DONE_CRITERIA_NOTE = 'done_criteria';
type MissionTaskNote = typeof MISSION_GOAL_NOTE | typeof MISSION_DONE_CRITERIA_NOTE;

export interface RebelCoreRuntimeModels {
  isPlanMode: boolean;
  displayModel: string;
  executionModel: RoutingModelId;
  planningModel: RoutingModelId | null;
}

export interface DirectAnswerResult {
  answer: string;
  confidence: number;
  reasoning?: string;
}

export interface PlanningPhaseResult {
  planText: string;
  usage: TokenUsage;
  stopReason: string;
  /** Actual model that served the planning request (may differ from requested model due to proxy routing). */
  model?: string;
  /** When present, the planner determined it can answer directly — skip execution. */
  directAnswer?: DirectAnswerResult;
  /** Parsed planning document, when the planner returned valid plan JSON. */
  document?: PlanningDocument;
  /** Parsed routing decision from plan output (adaptive routing). */
  routing?: RoutingDecision;
}

export type PlanningRoutingEffort = 'low' | 'medium' | 'high' | 'xhigh';

export type SubAgentAssignment = {
  task: string;
  model: string;
  effort?: PlanningRoutingEffort;
  context?: 'scoped' | 'contextual';
};

export interface PlanningStep {
  id?: string;
  description?: string;
  success_signal?: string;
  suggested_tools?: string[];
  depends_on?: string[];
  /** Steps sharing this group ID may execute concurrently. Mutually exclusive
   *  with depends_on between siblings: a step cannot list a sibling in the
   *  same parallel_group as a dependency. Malformed values are ignored at
   *  helper-derivation time (logged, run sequentially). */
  parallel_group?: string;
  /** Planner-assigned model for this step (adaptive routing). */
  model?: string;
  /** Planner-assigned reasoning effort for this step (adaptive routing). */
  effort?: PlanningRoutingEffort;
  /** Planner-assigned sub-agent model overrides (adaptive routing). */
  sub_agents?: SubAgentAssignment[];
}

interface RoutingEscalation {
  at_step: string;
  to_model: string;
  to_effort?: PlanningRoutingEffort;
  reason?: string;
}

export interface RoutingDecision {
  default_model: string;
  default_effort?: PlanningRoutingEffort;
  escalation?: RoutingEscalation;
  rationale?: string;
}

export interface PlanningDocument {
  goal?: string;
  assumptions?: string[];
  steps?: PlanningStep[];
  risks?: string[];
  done_criteria?: string[];
  /** Model routing decisions from adaptive routing (optional, plan mode only). */
  routing?: RoutingDecision;
}

interface PlanningPhaseOptions {
  client: ModelClient;
  planningModel: RoutingModelId;
  systemPrompt: string | ContentBlock[];
  messages: ChatMessage[];
  thinking?: RebelCoreThinkingConfig;
  effort?: 'low' | 'medium' | 'high' | 'max';
  signal?: AbortSignal;
  maxTokens?: number;
  onThinkingDelta?: (text: string) => void;
  onTextDelta?: (text: string) => void;
  onRetry?: (params: import('./modelClient').RetryInfo) => void;
  /** When present, inject model routing catalog into planning prompt. */
  routingContext?: {
    eligibleProfiles: Array<{
      id: string;
      name: string;
      model: string;
      costTier?: string;
      reasoning?: boolean;
      reasoningEffort?: string;
      contextWindow?: number;
      modelNotes?: string;
    }>;
    workingModel: string;
    availableAgents?: string[];
  };
}

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

const createAbortError = (message = 'Operation was aborted'): Error => {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
};

const normalizePlanningError = (error: unknown, signal?: AbortSignal): Error => {
  if (signal?.aborted) {
    return createAbortError();
  }

  if (error instanceof ModelError && error.isAbort) {
    return error;
  }

  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return createAbortError();
    }
    return error;
  }

  return new Error(String(error));
};

const stripModelSuffix = (model: string): string => model.replace(/\[1m\]$/i, '');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value);

const isPlanningRoutingEffort = (value: unknown): value is PlanningRoutingEffort =>
  value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh';

const isTaskStoreInternal = (taskStore: RebelCoreTaskStore): taskStore is RebelCoreTaskStoreInternal =>
  typeof (taskStore as Partial<RebelCoreTaskStoreInternal>)._getAllTasks === 'function' &&
  typeof (taskStore as Partial<RebelCoreTaskStoreInternal>)._getNextTaskId === 'function' &&
  typeof (taskStore as Partial<RebelCoreTaskStoreInternal>)._setRawTask === 'function' &&
  typeof (taskStore as Partial<RebelCoreTaskStoreInternal>)._setNextTaskId === 'function' &&
  typeof (taskStore as Partial<RebelCoreTaskStoreInternal>)._refreshBlockedTasks === 'function';

export const hasMissionGoalTask = (taskStore: RebelCoreTaskStore): boolean =>
  taskStore.listTasks().some((task) => task.owner === MISSION_OWNER && task.notes === MISSION_GOAL_NOTE);

const upsertMissionTask = (taskStore: RebelCoreTaskStoreInternal, note: MissionTaskNote, value: string): void => {
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    return;
  }

  const now = Date.now();
  const allTasks = taskStore._getAllTasks();
  for (const task of allTasks.values()) {
    if (task.owner === MISSION_OWNER && task.notes === note) {
      taskStore._setRawTask(task.id, {
        ...task,
        owner: MISSION_OWNER,
        notes: note,
        title: normalizedValue,
        updatedAt: now,
      });
      taskStore._refreshBlockedTasks();
      return;
    }
  }

  const nextTaskId = taskStore._getNextTaskId();
  const taskId = String(nextTaskId);
  taskStore._setRawTask(taskId, {
    id: taskId,
    title: normalizedValue,
    owner: MISSION_OWNER,
    status: 'pending',
    notes: note,
    createdAt: now,
    updatedAt: now,
  });
  taskStore._setNextTaskId(nextTaskId + 1);
  taskStore._refreshBlockedTasks();
};

export const seedMissionGoalTask = (taskStore: RebelCoreTaskStoreInternal, goal: string): void => {
  upsertMissionTask(taskStore, MISSION_GOAL_NOTE, goal);
};

const seedMissionDoneCriteriaTask = (taskStore: RebelCoreTaskStoreInternal, doneCriteria: string[]): void => {
  const normalizedDoneCriteria = doneCriteria
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .join('; ');

  if (!normalizedDoneCriteria) {
    return;
  }

  upsertMissionTask(taskStore, MISSION_DONE_CRITERIA_NOTE, normalizedDoneCriteria);
};

/**
 * Get the planning instructions (lazy access via prompt file service).
 */
function getPlanningInstructions(): string {
  return getPrompt(PROMPT_IDS.AGENT_PLANNING_INSTRUCTIONS);
}

/**
 * The routing catalogue injected into the planner prompt (the eligible model
 * pool + the working model). Named alias over the inline `PlanningPhaseOptions`
 * shape so the pool-builder and its tests can reference it directly.
 */
export type PlanningRoutingContext = NonNullable<PlanningPhaseOptions['routingContext']>;

/** A single entry in the planner's routing catalogue (one model the planner may pick). */
export type PlanningRoutingCatalogEntry = PlanningRoutingContext['eligibleProfiles'][number];

/**
 * Inputs for {@link buildPlanningRoutingPool}. All routing/override gating is the
 * caller's responsibility: `routingEligibleProfiles` is already the
 * connectivity-filtered, adaptive-routing-gated set (empty when routing is
 * disabled or a per-conversation override is active), so this function performs
 * NO eligibility decision — it only assembles the catalogue and applies the
 * `>=2`-models gate. Keeping the function pure (plain data in, plain data out)
 * is what makes it unit-testable away from the agent-turn hot path.
 */
export interface PlanningRoutingPoolInput {
  /**
   * Routing-eligible profiles, already connectivity-filtered AND adaptive-routing
   * gated by the caller (i.e. `getFunctionalRoutingProfiles(...)` when adaptive
   * routing is on and not overridden, else `[]`). Profiles without a `model` are
   * skipped here, mirroring the previous inline behaviour.
   */
  routingEligibleProfiles: readonly ModelProfile[];
  /** The effective execution/working model — always added to the pool as the default/fallback. */
  workingModel: string;
  /**
   * Whether the working model's active profile suppresses reasoning — i.e. its
   * auto-detected `thinkingCompatibility` is `'incompatible'`. The caller computes
   * this via `shouldSuppressProfileReasoning(activeProfile)`.
   */
  workingReasoningSuppressed: boolean;
  /** The working model's cost tier (from the active profile), if any. */
  workingCostTier?: string;
  /** The working model's reasoning-effort setting, if any. */
  workingReasoningEffort?: string;
  /** The working model's context window, if known. */
  workingContextWindow?: number;
  /** Names of the sub-agents available this turn (`Object.keys(agents)`). */
  availableAgents: readonly string[];
}

/** Result of {@link buildPlanningRoutingPool}. */
export interface PlanningRoutingPool {
  /**
   * The assembled catalogue: eligible profiles (with a `model`) plus the working
   * model (appended as the synthetic `__working__` entry when not already present
   * via a profile). Exposed even when routing is skipped so the caller can log
   * the collapsed pool size.
   */
  profileEntries: PlanningRoutingCatalogEntry[];
  /**
   * The routing context to pass to the planner, or `undefined` when the pool has
   * fewer than 2 models — a single-model "choice" wastes tokens, so routing is
   * skipped (the `>=2`-models invariant). When `undefined`, the caller should
   * emit the "routing skipped" observability log.
   */
  routingContext: PlanningRoutingContext | undefined;
}

/**
 * PURE assembler for the plan-mode routing catalogue. Extracted verbatim from
 * the `rebelCoreQuery` plan-mode branch so the logic is unit-testable and so the
 * documented future filters (per-conversation model allow-list, provider
 * enable/disable, provider priority — see
 * `docs/plans/260614_smart-model-routing/PLAN.md` § "Eligibility / pool
 * extension points") land as localized changes here rather than as hot-path
 * surgery. Behaviour-preserving: same mapping, same `__working__` synthesis,
 * same `>=2`-models gate.
 *
 * Invariants any future filter MUST preserve:
 *  - the working model is ALWAYS referenceable (appended unless a profile already
 *    carries it), and is the default/fallback;
 *  - routing is injected ONLY when `profileEntries.length >= 2`.
 */
export function buildPlanningRoutingPool(input: PlanningRoutingPoolInput): PlanningRoutingPool {
  const profileEntries: PlanningRoutingCatalogEntry[] = input.routingEligibleProfiles.flatMap((profile) => {
    if (!profile.model) return [];
    const defaults = getModelCapabilityDefaults(profile.model);
    const mergedLegacy = [profile.strengths, profile.weaknesses].filter(Boolean).join('. ') || undefined;
    return [{
      id: profile.id,
      name: profile.name,
      model: profile.model,
      costTier: profile.costTier,
      // Honour the suppression verdict (`thinkingCompatibility === 'incompatible'`),
      // so a suppressed profile isn't advertised to the routing LLM as
      // reasoning-capable when its egress won't actually send a thinking param.
      // Same gate the wire uses — see @shared/utils/reasoningSuppression.
      reasoning: !shouldSuppressProfileReasoning(profile),
      reasoningEffort: resolveProfileReasoningEffort(profile),
      contextWindow: profile.contextWindow,
      modelNotes: profile.modelNotes || defaults?.modelNotes || mergedLegacy,
    }];
  });

  // Include the working model in the catalog if not already present via a profile
  // (it's the default/fallback and must be valid in routing).
  const workingModelAlreadyIncluded = profileEntries.some((p) => p.model === input.workingModel);
  if (!workingModelAlreadyIncluded) {
    const workingDefaults = getModelCapabilityDefaults(input.workingModel);
    // Derive `reasoning` from the working model's actual capability rather than
    // hardcoding `true`: a non-reasoning working model would otherwise be
    // advertised to the planner as supporting thinking effort. Honour profile
    // reasoning suppression (manual "Off" or auto-detected incompatible) first,
    // then fall back to the model catalog's capability default.
    const workingReasoning = input.workingReasoningSuppressed
      ? false
      : modelSupportsReasoning(input.workingModel);
    profileEntries.push({
      id: '__working__',
      name: 'Working model',
      model: input.workingModel,
      costTier: input.workingCostTier,
      reasoning: workingReasoning,
      reasoningEffort: input.workingReasoningEffort,
      contextWindow: input.workingContextWindow,
      modelNotes: workingDefaults?.modelNotes,
    });
  }

  // Only inject routing when there are at least 2 models to choose between.
  // A single-model pool wastes tokens on a "choice" with one option.
  const routingContext: PlanningRoutingContext | undefined = profileEntries.length >= 2
    ? {
        eligibleProfiles: profileEntries,
        workingModel: input.workingModel,
        availableAgents: [...input.availableAgents],
      }
    : undefined;

  return { profileEntries, routingContext };
}

export function buildRoutingPromptAddendum(ctx: NonNullable<PlanningPhaseOptions['routingContext']>): string {
  // routeRef (Stage A): detect model ids shared by more than one entry in the pool. Only those
  // are ambiguous when referenced by bare name, so we surface a `profile:<id>` handle (and the
  // routing guideline) ONLY when a collision exists — keeping the prompt clean in the common,
  // no-collision case where bare model names resolve unambiguously.
  const modelIdCounts = new Map<string, number>();
  for (const profile of ctx.eligibleProfiles) {
    modelIdCounts.set(profile.model, (modelIdCounts.get(profile.model) ?? 0) + 1);
  }
  const hasSharedModelIds = [...modelIdCounts.values()].some((count) => count > 1);

  const modelEntries = ctx.eligibleProfiles
    .map((profile) => {
      const reasoning =
        profile.reasoning !== false ? `reasoning=${profile.reasoningEffort ?? 'default'}` : 'no-reasoning';
      const cost = profile.costTier ?? 'unknown';
      const contextWindow = profile.contextWindow ? `${Math.round(profile.contextWindow / 1000)}K ctx` : '';
      const header = `- **${profile.model}** [${cost}] ${reasoning}${contextWindow ? ` ${contextWindow}` : ''}`;
      const details: string[] = [];
      if (profile.modelNotes) details.push(`  Notes: ${profile.modelNotes}`);
      // Surface a stable provider-bound handle only for a model id that collides with another
      // entry — and never for the synthetic working entry (id `__working__`), which is the
      // default and is referenced by its bare model name.
      if (profile.id && profile.id !== '__working__' && (modelIdCounts.get(profile.model) ?? 0) > 1) {
        details.push(`  Ref: "profile:${profile.id}" — use this exact value to pick THIS one (${profile.name ?? profile.model}).`);
      }
      return [header, ...details].join('\n');
    })
    .join('\n');
  const availableAgents = ctx.availableAgents?.length
    ? ctx.availableAgents.map((agentName) => `- ${agentName}`).join('\n')
    : '- None available';

  return `
<adaptive_routing>
You must choose which model executes each step. Optimise for quality — but default to the cheapest model that handles a step well, and reserve more capable models for steps that genuinely need them.

Available models:
${modelEntries}

Available sub-agents:
${availableAgents}

Add a "routing" field to your JSON output:
{"routing":{"default_model":"model-id","default_effort":"low|medium|high|xhigh","rationale":"brief explanation"}}

For each step, you may specify "model" and "effort" to override the default when that specific step needs a different model:
{"steps":[{"id":"s1","description":"...","model":"cheap-model","effort":"low"},{"id":"s2","description":"...","model":"cheap-model","effort":"low"},{"id":"s3","description":"...","model":"capable-model","effort":"high"}]}

If the task genuinely needs a more capable model or higher reasoning effort partway through the turn, add an optional one-way escalation ratchet:
{"routing":{"default_model":"model-id","default_effort":"low|medium|high|xhigh","escalation":{"at_step":"s5","to_model":"model-id","to_effort":"high","reason":"brief explanation"}}}

For any step that should delegate to sub-agents, add a "sub_agents" array on that step:
{"steps":[{"id":"s1","description":"...","sub_agents":[{"task":"Use <actual-agent-name> to ...","model":"model-id","effort":"low|medium|high|xhigh","context":"scoped|contextual"}]}]}

Guidelines:
- Match the model to the task: use cheaper models for tool calls, data gathering, lookups, formatting, and routine steps. Use more capable models for synthesis, complex reasoning, nuanced writing, and multi-source analysis.
- Read each model's notes carefully — they describe what the model is actually good and bad at.
- Effort levels control reasoning depth: "low" (quick/shallow), "medium" (balanced), "high" (thorough), "xhigh" (maximum depth). Only applicable to models that support reasoning.
- Group consecutive steps using the same model when possible — switching models loses cache benefit.
- Use per-step "model" and "effort" when a specific step needs a different model from the default.
- Escalation is optional. Use it only when early steps can run cheaply but later steps genuinely need a stronger model or higher effort. Once escalation triggers at the named step, execution stays escalated for the rest of the turn.
- Use actual agent names from the available sub-agents list in each sub_agents[].task field (for example, "Use researcher-gpt5.5-high to ...") so runtime dispatch can match the assignment reliably.
- Sub-agent context modes: "scoped" means task-focused context only (no full user context, cheaper); "contextual" means full user context (current behavior, use when the user context matters).
- Omit sub_agents when no delegation is useful for a step.
- The routing field is required when multiple models are available.${hasSharedModelIds ? `
- Two entries above can share the same model name but be different providers/configs. To pick a specific one, use its "Ref" value (e.g. "profile:abc") as the model — a bare model name resolves to an arbitrary one of the duplicates. Bare names are fine for any model that appears only once.` : ''}
</adaptive_routing>`.trim();
}

const FALLBACK_PLAN_FOR_REJECTED_DIRECT_ANSWER =
  '{"type":"plan","confidence":null,"answer":null,"reasoning":null,"goal":"Execute the user request","assumptions":[],"steps":[],"risks":["Planning model attempted direct answer but confidence was below threshold"],"done_criteria":["Complete the user request using tool results and evidence"],"routing":null}';

const EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh'] as const;

/**
 * Canonical JSON schema for the planner's response. Encodes the same unified
 * flat-discriminator shape documented in
 * `rebel-system/prompts/agent/planning-instructions.md` plus the routing
 * extensions injected by `buildRoutingPromptAddendum`. This schema uses a
 * universal subset accepted by Anthropic (`output_config.format`) and Cohere
 * OpenAI-compat:
 *
 *  - Root is `type:'object'` with `additionalProperties: false`. The two
 *    output variants (direct_answer vs plan) are discriminated by the
 *    `type` property's enum, NOT by root `anyOf`. This matches the OpenAI
 *    strict dialect (`PLAN_RESPONSE_SCHEMA_OPENAI_STRICT`) so the planning
 *    prompt can ship a single unified shape spec to all providers.
 *  - Every nullable field uses `anyOf: [{ type: '<T>' }, { type: 'null' }]`
 *    (never `type: ['<T>', 'null']`). This is the Anthropic-compatible
 *    nullability encoding — Anthropic's constrained-decoding validator
 *    rejects the array-`type` + `enum` combo (`2feaa34a-…` postmortem).
 *  - Every object sets `additionalProperties: false`.
 *  - Every property listed in `properties` is also listed in `required`.
 *  - Variant-irrelevant fields are nullable / empty-array-shaped — the
 *    prompt instructs the model to populate them as `null` (or `[]`) for
 *    the inactive variant; consumer-side validation in
 *    `normalizePlanningDocument` honours the discriminator and discards
 *    spurious cross-variant fields.
 *
 * **OpenAI strict mode is fed `PLAN_RESPONSE_SCHEMA_OPENAI_STRICT` (below)
 * instead of this schema** — it has the same flat-discriminator shape but
 * uses `type: ['T', 'null']` for nullability (which OpenAI accepts and
 * `text/format` supports natively). `openaiClient.toOpenAIResponseFormat`
 * swaps to the dialect when the OutputConfig name matches `PLAN_OUTPUT_FORMAT_NAME`.
 * See `docs/plans/260508_planner_schema_openai_strict_flatten_discriminator.md`.
 *
 * Routing fields are always present in the schema regardless of the
 * `adaptiveRoutingEnabled` flag — the prompt addendum controls whether the
 * planner is asked to populate them; the schema only constrains the shape.
 */
export const PLAN_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['direct_answer', 'plan'] },

    // Direct-answer variant fields — nullable (populated when type='direct_answer').
    confidence: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    answer: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    reasoning: { anyOf: [{ type: 'string' }, { type: 'null' }] },

    // Plan variant fields — nullable / empty-array (populated when type='plan').
    goal: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    assumptions: { type: 'array', items: { type: 'string' } },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          success_signal: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
          },
          suggested_tools: { type: 'array', items: { type: 'string' } },
          depends_on: { type: 'array', items: { type: 'string' } },
          parallel_group: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
          },
          model: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
          },
          effort: {
            anyOf: [{ type: 'string', enum: EFFORT_VALUES }, { type: 'null' }],
          },
          sub_agents: {
            anyOf: [
              {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    task: { type: 'string' },
                    model: { type: 'string' },
                    effort: {
                      anyOf: [{ type: 'string', enum: EFFORT_VALUES }, { type: 'null' }],
                    },
                    context: {
                      anyOf: [{ type: 'string', enum: ['scoped', 'contextual'] }, { type: 'null' }],
                    },
                  },
                  required: ['task', 'model', 'effort', 'context'],
                },
              },
              { type: 'null' },
            ],
          },
        },
        required: [
          'id',
          'description',
          'success_signal',
          'suggested_tools',
          'depends_on',
          'parallel_group',
          'model',
          'effort',
          'sub_agents',
        ],
      },
    },
    risks: { type: 'array', items: { type: 'string' } },
    done_criteria: { type: 'array', items: { type: 'string' } },
    routing: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            default_model: { type: 'string' },
            default_effort: {
              anyOf: [{ type: 'string', enum: EFFORT_VALUES }, { type: 'null' }],
            },
            escalation: {
              anyOf: [
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    at_step: { type: 'string' },
                    to_model: { type: 'string' },
                    to_effort: {
                      anyOf: [{ type: 'string', enum: EFFORT_VALUES }, { type: 'null' }],
                    },
                    reason: {
                      anyOf: [{ type: 'string' }, { type: 'null' }],
                    },
                  },
                  required: ['at_step', 'to_model', 'to_effort', 'reason'],
                },
                { type: 'null' },
              ],
            },
            rationale: { type: 'string' },
          },
          required: ['default_model', 'default_effort', 'escalation', 'rationale'],
        },
        { type: 'null' },
      ],
    },
  },
  required: [
    'type',
    'confidence',
    'answer',
    'reasoning',
    'goal',
    'assumptions',
    'steps',
    'risks',
    'done_criteria',
    'routing',
  ],
};

const EFFORT_ENUM = ['low', 'medium', 'high', 'xhigh', null] as const;

// TODO(Doc-B): Replace this transitional OpenAI-only dialect fork with typed
// ProviderCapabilities-driven schema emission when the provider capability
// matrix lands. See docs/plans/260505_typed_provider_capability_matrix.md.
//
// OpenAI strict mode forbids root `anyOf`/`oneOf`/`allOf`/`not`/`enum`
// UNCONDITIONALLY (even with sibling `type:'object'`). This dialect uses a
// flat root `type:'object'` with a nested `type` discriminator enum
// (`['direct_answer', 'plan']`) in `properties`, and merges all variant
// fields at the top level. Variant-irrelevant fields are nullable
// (`type:['T','null']`) and the prompt instructs the model to populate them
// as `null` (or an empty array) for the inactive variant. Consumer-side
// validation in `normalizePlanningDocument` honours the discriminator and
// discards spurious cross-variant fields.
//
// See:
//   - docs/plans/260508_planner_schema_openai_strict_flatten_discriminator.md
//   - docs/project/REBEL_CORE.md:171-203 (canonical strict-mode rule)
//   - docs-private/postmortems/260505_planner_universal_subset_rewrite_broke_openai_strict_postmortem.md
//   - docs-private/postmortems/260506_planning_schema_provider_compat_postmortem.md
export const PLAN_RESPONSE_SCHEMA_OPENAI_STRICT: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // Discriminator — always present, drives consumer-side variant selection.
    type: { type: 'string', enum: ['direct_answer', 'plan'] },

    // Direct-answer variant fields — populated when type:'direct_answer',
    // null when type:'plan'.
    confidence: { type: ['number', 'null'] },
    answer: { type: ['string', 'null'] },
    reasoning: { type: ['string', 'null'] },

    // Plan variant fields — populated when type:'plan'; null/empty when
    // type:'direct_answer'.
    goal: { type: ['string', 'null'] },
    assumptions: { type: 'array', items: { type: 'string' } },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          success_signal: { type: ['string', 'null'] },
          suggested_tools: { type: 'array', items: { type: 'string' } },
          depends_on: { type: 'array', items: { type: 'string' } },
          parallel_group: { type: ['string', 'null'] },
          model: { type: ['string', 'null'] },
          effort: { type: ['string', 'null'], enum: EFFORT_ENUM },
          sub_agents: {
            type: ['array', 'null'],
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                task: { type: 'string' },
                model: { type: 'string' },
                effort: { type: ['string', 'null'], enum: EFFORT_ENUM },
                context: {
                  type: ['string', 'null'],
                  enum: ['scoped', 'contextual', null],
                },
              },
              required: ['task', 'model', 'effort', 'context'],
            },
          },
        },
        required: [
          'id',
          'description',
          'success_signal',
          'suggested_tools',
          'depends_on',
          'parallel_group',
          'model',
          'effort',
          'sub_agents',
        ],
      },
    },
    risks: { type: 'array', items: { type: 'string' } },
    done_criteria: { type: 'array', items: { type: 'string' } },
    routing: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        default_model: { type: 'string' },
        default_effort: { type: ['string', 'null'], enum: EFFORT_ENUM },
        escalation: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: {
            at_step: { type: 'string' },
            to_model: { type: 'string' },
            to_effort: { type: ['string', 'null'], enum: EFFORT_ENUM },
            reason: { type: ['string', 'null'] },
          },
          required: ['at_step', 'to_model', 'to_effort', 'reason'],
        },
        rationale: { type: 'string' },
      },
      required: ['default_model', 'default_effort', 'escalation', 'rationale'],
    },
  },
  required: [
    'type',
    'confidence',
    'answer',
    'reasoning',
    'goal',
    'assumptions',
    'steps',
    'risks',
    'done_criteria',
    'routing',
  ],
};

/**
 * Stable discriminator for the planner's structured-output format. Used by
 * `openaiClient.toOpenAIResponseFormat` to detect planner calls and swap the
 * canonical universal-subset schema for the OpenAI-strict dialect. Exported
 * so consumers gate on a typed constant rather than a magic string.
 */
export const PLAN_OUTPUT_FORMAT_NAME = 'rebel_plan' as const;

/** Provider-neutral structured-output format for the planner. Exported for tests. */
export const PLAN_OUTPUT_FORMAT: JsonSchemaFormat = {
  type: 'json_schema',
  name: PLAN_OUTPUT_FORMAT_NAME,
  schema: PLAN_RESPONSE_SCHEMA,
};

export const normalizePlanningSubAgents = (value: unknown): PlanningStep['sub_agents'] => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const subAgents = value.filter(isRecord).flatMap((subAgent) => {
    if (typeof subAgent.task !== 'string' || typeof subAgent.model !== 'string') {
      return [];
    }
    if (subAgent.effort != null && !isPlanningRoutingEffort(subAgent.effort)) {
      return [];
    }
    const context: SubAgentAssignment['context'] =
      subAgent.context === 'scoped' || subAgent.context === 'contextual' ? subAgent.context : undefined;

    return [
      {
        task: subAgent.task,
        model: subAgent.model,
        effort: isPlanningRoutingEffort(subAgent.effort) ? subAgent.effort : undefined,
        context,
      },
    ];
  });

  return subAgents.length > 0 ? subAgents : undefined;
};

const normalizeRoutingEscalation = (value: unknown): RoutingEscalation | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.at_step !== 'string' || typeof value.to_model !== 'string') {
    return undefined;
  }
  if (value.to_effort != null && !isPlanningRoutingEffort(value.to_effort)) {
    return undefined;
  }

  return {
    at_step: value.at_step,
    to_model: value.to_model,
    to_effort: isPlanningRoutingEffort(value.to_effort) ? value.to_effort : undefined,
    reason: typeof value.reason === 'string' ? value.reason : undefined,
  };
};

const normalizeRoutingDecision = (value: unknown): RoutingDecision | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.default_model !== 'string') {
    return undefined;
  }
  if (value.default_effort != null && !isPlanningRoutingEffort(value.default_effort)) {
    return undefined;
  }

  const escalation = value.escalation == null ? undefined : normalizeRoutingEscalation(value.escalation);

  return {
    default_model: value.default_model,
    default_effort: isPlanningRoutingEffort(value.default_effort) ? value.default_effort : undefined,
    escalation,
    rationale: typeof value.rationale === 'string' ? value.rationale : undefined,
  };
};

const normalizePlanningDocument = (value: unknown): PlanningDocument | null => {
  if (!isRecord(value)) {
    return null;
  }

  // Discriminator-aware normalisation. The flat-discriminator OpenAI strict
  // schema (and the unified planning prompt) emit `type ∈ {'direct_answer',
  // 'plan'}` in every output, with variant-irrelevant fields populated as
  // `null` or empty. When the discriminator says `direct_answer`, plan-shape
  // fields are spurious and discarded — `parseDirectAnswer` (called upstream)
  // is the canonical consumer for direct-answer outputs, and seeding tasks
  // from a direct-answer would be wrong. See
  // `docs/plans/260508_planner_schema_openai_strict_flatten_discriminator.md`.
  if (value.type === 'direct_answer') {
    return {
      goal: undefined,
      assumptions: undefined,
      steps: undefined,
      risks: undefined,
      done_criteria: undefined,
      routing: undefined,
    };
  }

  return {
    goal: typeof value.goal === 'string' ? value.goal : undefined,
    assumptions: Array.isArray(value.assumptions)
      ? value.assumptions.filter((item): item is string => typeof item === 'string')
      : undefined,
    steps: Array.isArray(value.steps)
      ? value.steps.filter(isRecord).map((step) => ({
          id: typeof step.id === 'string' ? step.id : undefined,
          description: typeof step.description === 'string' ? step.description : undefined,
          success_signal: typeof step.success_signal === 'string' ? step.success_signal : undefined,
          suggested_tools: Array.isArray(step.suggested_tools)
            ? step.suggested_tools.filter((tool): tool is string => typeof tool === 'string')
            : undefined,
          depends_on: Array.isArray(step.depends_on)
            ? step.depends_on.filter((dependency): dependency is string => typeof dependency === 'string')
            : undefined,
          parallel_group:
            typeof step.parallel_group === 'string' && step.parallel_group.trim().length > 0
              ? step.parallel_group
              : undefined,
          model: typeof step.model === 'string' ? step.model : undefined,
          effort: isPlanningRoutingEffort(step.effort) ? step.effort : undefined,
          sub_agents: normalizePlanningSubAgents(step.sub_agents),
        }))
      : undefined,
    risks: Array.isArray(value.risks)
      ? value.risks.filter((item): item is string => typeof item === 'string')
      : undefined,
    done_criteria: Array.isArray(value.done_criteria)
      ? value.done_criteria.filter((item): item is string => typeof item === 'string')
      : undefined,
    routing: normalizeRoutingDecision(value.routing),
  };
};

/**
 * Build the set of model ids the planner is allowed to route to: the
 * routing-eligible profile models plus the working model. This is the SINGLE
 * SOURCE OF TRUTH for the eligible pool — the runtime (above) and the planner
 * eval both call it, so the eval can never drift from the production rule it
 * claims to mirror. `extractRoutingFromPlan` validates the planner's decision
 * against exactly this set.
 */
export function buildEligibleRoutingModelIds(
  routingContext:
    | { eligibleProfiles: ReadonlyArray<{ model: string; id?: string }>; workingModel: string }
    | undefined,
): Set<string> {
  if (!routingContext) return new Set<string>();
  const eligible = new Set<string>([
    ...routingContext.eligibleProfiles.map((profile) => profile.model),
    routingContext.workingModel,
  ]);
  // routeRef (Stage A): also accept a provider-bound `profile:<id>` reference for each
  // eligible profile, so the planner can disambiguate two profiles that share a model id.
  // Bare model strings remain valid (legacy first-match resolution), so this is additive.
  // EXCLUDE the synthetic working-model entry (id `__working__`): it is not a real routing
  // profile, so a `profile:__working__` ref would pass validation here but fail to resolve at
  // dispatch (silent fallback). The working model is always referenceable by its bare model id.
  for (const profile of routingContext.eligibleProfiles) {
    if (profile.id && profile.id !== '__working__') eligible.add(`profile:${profile.id}`);
  }
  return eligible;
}

export function extractRoutingFromPlan(
  parsed: PlanningDocument,
  eligibleModelIds: Set<string>,
): RoutingDecision | undefined {
  if (!parsed.routing) {
    return undefined;
  }

  const routing = parsed.routing;
  if (typeof routing.default_model !== 'string' || !eligibleModelIds.has(routing.default_model)) {
    log.warn({ routing }, 'Plan routing references unknown model — ignoring routing');
    return undefined;
  }

  if (routing.escalation) {
    if (typeof routing.escalation.at_step !== 'string' || typeof routing.escalation.to_model !== 'string') {
      return {
        default_model: routing.default_model,
        default_effort: routing.default_effort,
        rationale: routing.rationale,
      };
    }
    if (!eligibleModelIds.has(routing.escalation.to_model)) {
      return {
        default_model: routing.default_model,
        default_effort: routing.default_effort,
        rationale: routing.rationale,
      };
    }
  }

  return routing;
}

/**
 * Returns groupId → ordered list of unique member step IDs, preserving plan
 * order. Includes all groups, including singletons and malformed groups.
 */
function collectRawParallelGroups(
  steps: PlanningStep[] | undefined,
): Map<string, string[]> {
  const groups = new Map<string, Set<string>>();
  if (!steps?.length) return new Map<string, string[]>();

  for (const step of steps) {
    if (!step.id || !step.parallel_group) continue;
    const members = groups.get(step.parallel_group) ?? new Set<string>();
    members.add(step.id);
    groups.set(step.parallel_group, members);
  }

  return new Map(
    Array.from(groups.entries(), ([groupId, members]) => [groupId, Array.from(members)]),
  );
}

/**
 * Returns groupId → ordered list of step IDs, preserving plan order.
 * Filters singletons (groups with < 2 members emit no parallelism) and
 * malformed groups (any member listing a sibling or the own group id in
 * its own depends_on).
 * Logs but does not throw on malformed input.
 */
export function derivePlanParallelGroups(
  steps: PlanningStep[] | undefined,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  if (!steps?.length) return groups;

  const rawGroups = collectRawParallelGroups(steps);

  // Pass 2: validate each group, drop singletons + malformed.
  for (const [groupId, members] of rawGroups) {
    if (members.length < 2) continue;
    const memberSet = new Set(members);
    const offending = members.find((id) => {
      const step = steps.find((s) => s.id === id);
      return step?.depends_on?.some((dep) => memberSet.has(dep) || dep === groupId) ?? false;
    });
    if (offending) {
      log.warn(
        { groupId, members, offendingStepId: offending },
        'Parallel group has a member listing a sibling or own group as a dependency — ignoring group',
      );
      continue;
    }
    groups.set(groupId, members);
  }

  return groups;
}

export function sanitizePlanTextForExecution(
  planText: string,
  validParallelGroupIds: ReadonlySet<string>,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(planText);
  } catch {
    return planText;
  }

  if (!isRecord(parsed)) {
    return planText;
  }

  const steps = parsed.steps;
  if (!Array.isArray(steps)) {
    return planText;
  }

  let changed = false;
  for (const step of steps) {
    if (!isRecord(step) || !Object.prototype.hasOwnProperty.call(step, 'parallel_group')) {
      continue;
    }

    const parallelGroup = step['parallel_group'];
    if (parallelGroup === null) {
      continue;
    }

    if (typeof parallelGroup === 'string' && validParallelGroupIds.has(parallelGroup)) {
      continue;
    }

    step['parallel_group'] = null;
    changed = true;
  }

  return changed ? JSON.stringify(parsed, null, 2) : planText;
}

type RuntimeModelResolver = (
  role: ModelRole,
  settings: ModelRoleResolverSettings,
  profiles: readonly ModelProfile[],
) => RoleResolution;

function resolveRoleModelForRuntime(params: {
  role: ModelRole;
  settings?: ModelRoleResolverSettings;
  resolver?: RuntimeModelResolver;
}): RoutingModelId {
  const settings = params.settings;
  if (!settings) {
    throw new ModelError('invalid_request', `Missing settings while resolving ${params.role} model`, 400);
  }

  const resolver = params.resolver ?? resolveDefaultModelForRole;
  const profiles = settings.localModel?.profiles ?? [];
  const resolution = resolver(params.role, settings, profiles);
  if (!resolution.ok) {
    throw createRoleResolutionModelError(resolution);
  }
  return resolution.model;
}

function decodeRuntimeModelOrThrow(value: string, source: string): RoutingModelId {
  const decoded = decodeRoutingModelId(stripModelSuffix(value));
  if (!decoded) {
    throw new ModelError(
      'invalid_request',
      `Invalid ${source} model id "${value}"`,
      400,
    );
  }
  return decoded;
}

export function resolveRuntimeModels(params: {
  model?: string;
  env?: Record<string, string>;
  settings?: ModelRoleResolverSettings;
  resolveModelForRole?: RuntimeModelResolver;
}): RebelCoreRuntimeModels {
  const requestedModel = params.model;
  if (requestedModel && requestedModel !== PLAN_MODE_ALIAS) {
    const resolved = decodeRuntimeModelOrThrow(requestedModel, 'requested');
    return {
      isPlanMode: false,
      displayModel: resolved,
      executionModel: resolved,
      planningModel: null,
    };
  }

  if (!requestedModel || requestedModel.trim().length === 0) {
    const executionModel = decodeRuntimeModelOrThrow(
      resolveRoleModelForRuntime({
        role: 'working',
        settings: params.settings,
        resolver: params.resolveModelForRole,
      }),
      'working role',
    );
    return {
      isPlanMode: false,
      displayModel: executionModel,
      executionModel,
      planningModel: null,
    };
  }

  const env = params.env;
  const planningModel = decodeRuntimeModelOrThrow(
    env?.[ENV_THINKING_MODEL]
      || resolveRoleModelForRuntime({
        role: 'thinking',
        settings: params.settings,
        resolver: params.resolveModelForRole,
      }),
    env?.[ENV_THINKING_MODEL] ? ENV_THINKING_MODEL : 'thinking role',
  );
  const executionModel = decodeRuntimeModelOrThrow(
    env?.[ENV_EXECUTION_MODEL]
      || resolveRoleModelForRuntime({
        role: 'working',
        settings: params.settings,
        resolver: params.resolveModelForRole,
      }),
    env?.[ENV_EXECUTION_MODEL] ? ENV_EXECUTION_MODEL : 'working role',
  );

  return {
    isPlanMode: true,
    displayModel: executionModel,
    executionModel,
    planningModel,
  };
}

export function buildExecutionSystemPrompt(
  baseSystemPrompt: string | ContentBlock[],
  planText: string,
  planningModel: string,
  seededTasksText?: string,
  routingInfo?: {
    model: string;
    profileName?: string;
    escalation?: { atStep: string; toModel: string; reason?: string };
  },
  parallelGroups?: Array<{
    groupId: string;
    memberStepIds: string[];
    suggestedTools: string[];
  }>,
): string | ContentBlock[] {
  const executionInstructions = [
    'You are now in execution mode.',
    `A planning model (${planningModel}) generated the following execution plan.`,
    'Use it as strong guidance, but adapt if tool results or new evidence require it.',
    'If you adapt, preserve the same overall goal and done criteria.',
    'For multi-step work, maintain explicit progress with TaskCreate, TaskUpdate, and TaskList instead of relying on implicit conversational state.',
    'Before ending your turn, verify the execution tasks you created are marked completed and done_criteria are satisfied.',
    ...(seededTasksText
      ? [
          'The task list has already been seeded from the planning steps below.',
          'Update that existing task list instead of recreating duplicate tasks unless the plan materially changes.',
          '<rebel_core_seeded_tasks>',
          seededTasksText,
          '</rebel_core_seeded_tasks>',
        ]
      : []),
    ...(routingInfo
      ? [
          '',
          'MODEL ROUTING: You are running on a cost-optimized model selected by the planner.',
          `Current model: ${routingInfo.model}${routingInfo.profileName ? ` (${routingInfo.profileName})` : ''}.`,
          ...(routingInfo.escalation
            ? [
                `At step ${routingInfo.escalation.atStep}, the planner recommends escalating to ${routingInfo.escalation.toModel}${routingInfo.escalation.reason ? ` because: ${routingInfo.escalation.reason}` : ''}.`,
                'Focus on executing your assigned steps efficiently.',
              ]
            : []),
        ]
      : []),
    // This summary section should align with the filtered groups represented in the
    // <rebel_core_execution_plan> JSON payload passed by the caller.
    ...(parallelGroups && parallelGroups.length > 0
      ? [
          '',
          'PARALLEL EXECUTION:',
          'The plan declares the following parallel groups. When you reach a parallel',
          'group, emit ALL the group\'s work in a SINGLE assistant message:',
          '  - One tool call per sibling (for example Read, Search, or Agent), and',
          '  - One TaskUpdate(taskId, status=\'in_progress\') call per sibling, in that same message.',
          'The runtime dispatches all calls concurrently. Do NOT process group members',
          'one at a time across multiple turns; doing so causes per-task status indicators',
          'to flicker between in_progress and pending and misrepresents the work as serial.',
          '',
          'If results from a parallel group invalidate plans for follow-up steps, you',
          'may pivot in subsequent turns — describe the pivot and adjust task',
          'statuses accordingly.',
          '',
          `The runtime caps concurrent sub-agent dispatches at ${PARALLEL_AGENT_CAP} per turn; if a group`,
          `declares more than ${PARALLEL_AGENT_CAP} Agent calls, dispatch all of them in one message and`,
          'the runtime will queue the overflow.',
          '',
          'Groups:',
          ...parallelGroups.map((group) => {
            const details: string[] = [];
            if (group.suggestedTools.length > 0) {
              details.push(`suggested tools: ${group.suggestedTools.join(', ')}`);
            }
            const detailsText = details.length > 0 ? ` (${details.join(', ')})` : '';
            return `- ${group.groupId}: steps ${group.memberStepIds.join(', ')}${detailsText}`;
          }),
        ]
      : []),
    'IMPORTANT: Never output the execution plan, its JSON, or its structure in your response to the user. Your response should describe what you DID and the outcome, not what you PLANNED to do.',
    '<rebel_core_execution_plan>',
    planText,
    '</rebel_core_execution_plan>',
  ].join('\n');

  if (typeof baseSystemPrompt === 'string') {
    return baseSystemPrompt ? `${baseSystemPrompt}\n\n${executionInstructions}` : executionInstructions;
  }

  return [
    ...baseSystemPrompt,
    {
      type: 'text',
      text: executionInstructions,
    } satisfies ContentBlock,
  ];
}

/**
 * Extract JSON from model output that may be wrapped in markdown fences or
 * preceded/followed by commentary. Models are instructed to return raw JSON,
 * but many (especially non-Anthropic providers) wrap output in ```json ... ```
 * or add preamble text. This is the single recovery path for that mismatch.
 */
export const extractJsonFromModelOutput = (raw: string): string | null => {
  // Try raw first -- cheapest path
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return trimmed;

  // Strip markdown fences: ```json ... ``` or ``` ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch?.[1]) {
    const inner = fenceMatch[1].trim();
    if (inner.startsWith('{')) return inner;
  }

  // Last resort: find the first { ... } block in the output
  const braceStart = trimmed.indexOf('{');
  const braceEnd = trimmed.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    return trimmed.slice(braceStart, braceEnd + 1);
  }

  return null;
};

/**
 * Attempt to parse a direct-answer response from the planning model output.
 * Returns a validated DirectAnswerResult if the output is a high-confidence
 * direct answer, or null if it's a normal plan or fails validation.
 */
export const parseDirectAnswer = (raw: string): DirectAnswerResult | null => {
  const jsonText = extractJsonFromModelOutput(raw);
  if (!jsonText) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  if (parsed.type !== 'direct_answer') return null;

  const { confidence, answer, reasoning } = parsed;

  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return null;
  if (confidence < 0.95 || confidence > 1.0) return null;
  if (typeof answer !== 'string' || answer.trim().length === 0) return null;

  return {
    answer: answer.trim(),
    confidence,
    ...(typeof reasoning === 'string' ? { reasoning } : {}),
  };
};

export function seedTaskStoreFromPlan(
  planText: string,
  taskStore: RebelCoreTaskStore,
): {
  seededCount: number;
  seededTasksText: string | null;
  stepIdToTaskIdMap: Map<string, string>;
} {
  const emptyStepIdToTaskIdMap = new Map<string, string>();
  if (hasMissionGoalTask(taskStore)) {
    return {
      seededCount: 0,
      seededTasksText: null,
      stepIdToTaskIdMap: emptyStepIdToTaskIdMap,
    };
  }

  let parsed: PlanningDocument | null = null;

  const jsonText = extractJsonFromModelOutput(planText);
  if (!jsonText) {
    log.warn(
      {
        planTextLength: planText.length,
        planTextPreview: planText.slice(0, 300),
      },
      'Planning model returned non-JSON output — task seeding skipped, execution model will create tasks manually',
    );
    return {
      seededCount: 0,
      seededTasksText: null,
      stepIdToTaskIdMap: emptyStepIdToTaskIdMap,
    };
  }

  try {
    parsed = normalizePlanningDocument(JSON.parse(jsonText));
  } catch (err) {
    log.warn(
      {
        planTextLength: planText.length,
        planTextPreview: planText.slice(0, 300),
        error: String(err),
      },
      'Failed to parse planning model JSON — task seeding skipped, execution model will create tasks manually',
    );
    return {
      seededCount: 0,
      seededTasksText: null,
      stepIdToTaskIdMap: emptyStepIdToTaskIdMap,
    };
  }

  if (!parsed?.steps || parsed.steps.length === 0) {
    log.warn(
      { hasGoal: !!parsed?.goal, planTextPreview: planText.slice(0, 300) },
      'Planning model returned valid JSON but no steps — task seeding skipped',
    );
    return {
      seededCount: 0,
      seededTasksText: null,
      stepIdToTaskIdMap: emptyStepIdToTaskIdMap,
    };
  }

  const groupIdToMemberStepIds = collectRawParallelGroups(parsed.steps);
  const validParallelGroupIds = new Set(derivePlanParallelGroups(parsed.steps).keys());
  const plannerStepIdToTaskId = new Map<string, string>();
  const expandedGroupKeys = new Set<string>();
  let expandedBlockerCount = 0;

  // Pass 1: create all tasks and step→task mappings so forward references resolve.
  const seededTaskDrafts = parsed.steps.map((step, index) => {
    const rawParallelGroup = typeof step.parallel_group === 'string'
      ? step.parallel_group.trim()
      : '';
    const parallelGroup = rawParallelGroup.length > 0 && validParallelGroupIds.has(rawParallelGroup)
      ? rawParallelGroup
      : '';
    const task = taskStore.createTask({
      title: step.description ?? `Planned step ${index + 1}`,
      status: 'pending',
      notes: step.success_signal,
      ...(parallelGroup.length > 0 ? { parallelGroup } : {}),
    });

    if (step.id) {
      plannerStepIdToTaskId.set(step.id, task.id);
    }

    return { step, index, taskId: task.id };
  });

  const unresolvedDependencyIds: Array<{ stepId: string | undefined; dependencyId: string }> = [];

  // Pass 2: expand dependencies (including group IDs) and finalize blocker/status state.
  const seededTasks = seededTaskDrafts.map(({ step, index, taskId }) => {
    const blockers = step.depends_on?.flatMap((dependencyId) => {
      const memberStepIds = groupIdToMemberStepIds.get(dependencyId);
      if (memberStepIds) {
        // A malformed plan can put a step in parallel_group "g1" and depends_on ["g1"].
        // Raw group expansion would include the step's own task ID and self-block forever.
        // Strip self-reference here; derivePlanParallelGroups already emits the warning signal.
        const expandedMemberBlockers = memberStepIds
          .map((memberStepId) => plannerStepIdToTaskId.get(memberStepId) ?? memberStepId)
          .filter((blockerId) => blockerId !== taskId);
        expandedGroupKeys.add(dependencyId);
        expandedBlockerCount += expandedMemberBlockers.length;
        return expandedMemberBlockers;
      }
      const resolvedTaskId = plannerStepIdToTaskId.get(dependencyId);
      if (!resolvedTaskId) {
        unresolvedDependencyIds.push({ stepId: step.id, dependencyId });
      }
      return [resolvedTaskId ?? dependencyId];
    });

    const dedupedBlockers = blockers && blockers.length > 0 ? Array.from(new Set(blockers)) : undefined;
    const task = taskStore.updateTask(taskId, {
      status: index === 0 && (!dedupedBlockers || dedupedBlockers.length === 0) ? 'in_progress' : 'pending',
      blockers: dedupedBlockers,
    });

    const resolvedTask = task ?? taskStore.getTask(taskId);
    if (!resolvedTask) {
      throw new Error(`Seeded task disappeared during planning task seeding: ${taskId}`);
    }

    return {
      id: resolvedTask.id,
      title: resolvedTask.title,
      status: resolvedTask.status,
      ...(resolvedTask.blockers ? { blockers: resolvedTask.blockers } : {}),
      ...(step.suggested_tools && step.suggested_tools.length > 0 ? { suggested_tools: step.suggested_tools } : {}),
      ...(step.success_signal ? { success_signal: step.success_signal } : {}),
    };
  });

  if (expandedGroupKeys.size > 0) {
    log.info(
      {
        expandedGroupKeys: Array.from(expandedGroupKeys),
        expandedBlockerCount,
      },
      'Expanded parallel-group dependencies during task seeding',
    );
  }

  if (unresolvedDependencyIds.length > 0) {
    log.warn(
      {
        unresolvedDependencyCount: unresolvedDependencyIds.length,
        sample: unresolvedDependencyIds.slice(0, 5),
        knownStepIds: Array.from(plannerStepIdToTaskId.keys()).slice(0, 20),
        knownGroupIds: Array.from(groupIdToMemberStepIds.keys()),
      },
      'Plan depends_on references unknown step or group IDs — task may run before its prerequisites because missing blockers are treated as resolved',
    );
  }

  if (isTaskStoreInternal(taskStore)) {
    if (parsed.goal) {
      seedMissionGoalTask(taskStore, parsed.goal);
    }
    if (parsed.done_criteria && parsed.done_criteria.length > 0) {
      seedMissionDoneCriteriaTask(taskStore, parsed.done_criteria);
    }
  }

  log.info(
    {
      seededCount: seededTasks.length,
      hasGoal: !!parsed.goal,
      hasDoneCriteria: !!parsed.done_criteria?.length,
    },
    'Seeded task store from planning model output',
  );

  return {
    seededCount: seededTasks.length,
    seededTasksText: JSON.stringify({ tasks: seededTasks }, null, 2),
    stepIdToTaskIdMap: plannerStepIdToTaskId,
  };
}

export async function runPlanningPhase(options: PlanningPhaseOptions): Promise<PlanningPhaseResult> {
  const maxTokens = Math.min(options.maxTokens ?? 2_048, 4_096);
  const thinking =
    options.thinking?.type === 'enabled'
      ? maxTokens <= 1_024
        ? { type: 'disabled' as const }
        : {
            ...options.thinking,
            budget_tokens: Math.min(options.thinking.budget_tokens, maxTokens - 1),
          }
      : options.thinking;

  const baseInstructions = getPlanningInstructions();
  const routingAddendum = options.routingContext ? `\n\n${buildRoutingPromptAddendum(options.routingContext)}` : '';

  const planningMessages: ChatMessage[] = [
    ...options.messages,
    {
      role: 'user',
      content: baseInstructions + routingAddendum,
    },
  ];

  try {
    const buildStreamParams = (withOutputConfig: boolean) => ({
      model: options.planningModel,
      systemPrompt: options.systemPrompt,
      messages: planningMessages,
      maxTokens,
      thinking,
      effort: options.effort,
      ...(withOutputConfig ? { outputConfig: { format: PLAN_OUTPUT_FORMAT } } : {}),
      signal: options.signal,
      ...(options.onRetry ? { onRetry: options.onRetry } : {}),
    });

    const handleStreamEvent = (event: StreamEvent) => {
      if (event.type === 'thinking_delta' && options.onThinkingDelta) {
        options.onThinkingDelta(event.thinking);
      }
      if (event.type === 'text_delta' && options.onTextDelta) {
        options.onTextDelta(event.text);
      }
    };

    let result: Awaited<ReturnType<typeof options.client.stream>>;
    try {
      result = await options.client.stream(
        buildStreamParams(true),
        handleStreamEvent,
      );
    } catch (streamError) {
      if (isStructuredOutputSchemaRejection(streamError)) {
        const modelErr = streamError instanceof ModelError ? streamError : undefined;
        const provider = modelErr?.provider ?? 'unknown';
        const status = modelErr?.status;
        const rawMessage = modelErr?.__rawMessage;
        log.error(
          {
            provider,
            status,
            rawMessage,
            schemaName: PLAN_OUTPUT_FORMAT.name,
          },
          'Planner structured-output schema rejected by provider — retrying once without outputConfig (prompt-level schema fallback)',
        );
        try {
          if (modelErr) {
            captureKnownCondition(
              'model_error',
              {
                kind: modelErr.kind,
                provider: modelErr.provider,
                upstreamProvider: modelErr.upstreamProvider,
                tags: {
                  sdk_error_category: 'structured_output_schema_rejected',
                  schema_name: PLAN_OUTPUT_FORMAT.name,
                  provider,
                  recovered: 'pending',
                },
                extra: {
                  status: status ?? null,
                  schemaSurface: 'planner.outputConfig.format',
                  fallback: 'prompt-level schema retry',
                },
              },
              modelErr,
            );
          } else {
            getErrorReporter().captureException(streamError, {
              tags: {
                sdk_error_category: 'structured_output_schema_rejected',
                schema_name: PLAN_OUTPUT_FORMAT.name,
                provider,
                recovered: 'pending',
              },
              extra: {
                status: status ?? null,
                schemaSurface: 'planner.outputConfig.format',
                fallback: 'prompt-level schema retry',
              },
            });
          }
        } catch {
          // Telemetry failure must never block the runtime fallback retry.
        }
        result = await options.client.stream(
          buildStreamParams(false),
          handleStreamEvent,
        );
      } else {
        throw streamError;
      }
    }

    const planText = result.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    if (!planText) {
      // Log-classification only (Fable 5 Stage 6): a pre-output refusal from
      // the planning model (stop_reason: 'refusal', empty content) degrades to
      // the same plan-less fallback as any other empty plan — the execution
      // model proceeds without a seeded plan — but the cause is recorded
      // distinctly so refusals don't masquerade as generic empty output.
      log.warn(
        {
          stopReason: result.stopReason,
          model: result.model,
          classification: result.stopReason === 'refusal' ? 'provider_refusal' : 'empty_output',
        },
        result.stopReason === 'refusal'
          ? 'Planning model response refused by provider safety classifier — degrading to plan-less execution'
          : 'Planning model returned empty output — degrading to plan-less execution',
      );
      return {
        planText:
          '{"goal":"Execute the task","assumptions":[],"steps":[],"risks":["Planning model returned empty output"],"done_criteria":["Complete the user request using tool results and evidence"]}',
        usage: result.usage,
        stopReason: result.stopReason,
        model: result.model,
      };
    }

    // Check for direct-answer escape hatch
    const directAnswer = parseDirectAnswer(planText);
    if (directAnswer) {
      return {
        planText,
        usage: result.usage,
        stopReason: result.stopReason,
        model: result.model,
        directAnswer,
      };
    }

    let parsedDocument: PlanningDocument | null = null;

    // Check if the model attempted a direct answer but failed validation
    // (e.g., confidence below threshold). Replace with fallback plan so
    // the execution model doesn't receive a non-plan JSON payload.
    const jsonText = extractJsonFromModelOutput(planText);
    if (jsonText) {
      try {
        const parsed = JSON.parse(jsonText);
        if (isRecord(parsed) && parsed.type === 'direct_answer') {
          log.warn(
            {
              confidence: parsed.confidence,
              planTextPreview: planText.slice(0, 300),
            },
            'Planning model returned direct answer that failed validation — using fallback plan',
          );
          return {
            planText: FALLBACK_PLAN_FOR_REJECTED_DIRECT_ANSWER,
            usage: result.usage,
            stopReason: result.stopReason,
            model: result.model,
          };
        }
        parsedDocument = normalizePlanningDocument(parsed);
      } catch {
        // JSON parse failure — not a direct answer, fall through to normal plan path
      }
    }

    let routing: RoutingDecision | undefined;
    if (parsedDocument) {
      const eligibleModelIds = buildEligibleRoutingModelIds(options.routingContext);
      routing = extractRoutingFromPlan(parsedDocument, eligibleModelIds);
      if (routing) {
        log.info({ routing }, 'Adaptive routing decision extracted from plan');
      }
    }

    return {
      planText,
      usage: result.usage,
      stopReason: result.stopReason,
      model: result.model,
      ...(parsedDocument ? { document: parsedDocument } : {}),
      routing,
    };
  } catch (error) {
    const normalizedError = normalizePlanningError(error, options.signal);
    throw annotateModelRuntimeRole(normalizedError, {
      role: 'thinking',
      model: options.planningModel,
      phase: 'planning',
    });
  }
}

export const EMPTY_USAGE = ZERO_USAGE;
