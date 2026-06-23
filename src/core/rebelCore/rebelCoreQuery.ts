/**
 * Rebel Core Query — Entry point for the native agent runtime.
 *
 * Produces agent message shapes (AsyncGenerator<AgentMessage>) consumed by
 * the agent message handler, cost tracking, and other downstream code.
 *
 * Events are yielded in real-time as the agent loop produces them (true streaming).
 */
import { randomUUID } from 'node:crypto';
import type { AgentMessage } from '@core/agentRuntimeTypes';
import { createScopedLogger } from '@core/logger';
import { getPlatformConfig } from '@core/platform';
import type { AppSettings } from '@shared/types';
import type { ModelProfile, ThinkingEffort } from '@shared/types/settings';
import { getWorkingModelProfile } from '@shared/types';
import { getThinkingProfile } from '@shared/utils/settingsUtils';
import { computeSupportsReasoningReplay } from '@shared/utils/reasoningCapability';
import { getModelEfforts, getGlobalThinkingEffort, getContextOverflowFallbackModel, getContextOverflowFallbackProfileId } from './settingsAccessors';
import { ENV_THINKING_MODEL, ENV_EXECUTION_MODEL } from '@shared/utils/modelNormalization';
import { resolveReasoningEffort } from '@shared/utils/reasoningEffortResolver';
import {
  getFunctionalCouncilProfiles,
  getFunctionalRoutingProfiles,
  resolveRoutingProfileRef,
  type ProfileConnectivity,
} from '@shared/utils/connectivityHelpers';
import { isProfileSelectable } from '@shared/utils/profileHelpers';
import { decodeRoutingModelId, type RoutingModelId } from '@shared/utils/modelChoiceCodec';
import type { TaskRoutingMetadata } from '@shared/routing/taskRoutingMetadata';
import {
  runAgentLoop,
  ContextOverflowError,
  buildSkeletonMessages,
  estimatePromptTokensForPreflight,
} from './agentLoop';
import { createPerTurnRateLimitState } from './rateLimitStateWiring';
import { ConnectionNotConfiguredError, createClientForModel } from './clientFactory';
import { isProfileReference } from './providerRouteDecision';
import { selectProviderMode } from './providerRouting';
import { ModelError, reclassifyOrRethrow } from './modelErrors';
import { createAgentMessageAdapter, type RebelCoreAgentMessageAdapter } from './agentMessageAdapter';
import { createHookAwareToolExecutor, runStopHooksWithReason } from './hookPipeline';
import { executeRegisteredTool, hasRegisteredTool } from './toolRegistry';
import { createMcpSession, isMcpToolName, type McpSession } from './mcpClient';
import { buildAgentToolDefinition, executeAgentTool } from './agentTool';
import { buildForagerAgentDef, FORAGER_AGENT_NAME, FORAGER_BTS_CATEGORY } from './foragerPrompt';
import {
  MISSION_SET_TOOL_DEFINITION,
  GET_PREVIOUS_TASKS_TOOL_DEFINITION,
  executeBuiltinTool,
  extractMissionContext,
  getBuiltinToolDefinitions,
  isBuiltinToolName,
} from './builtinTools';
import { PARALLEL_AGENT_CAP } from './constants/limits';
import {
  buildExecutionSystemPrompt,
  buildPlanningRoutingPool,
  derivePlanParallelGroups,
  resolveRuntimeModels,
  runPlanningPhase,
  sanitizePlanTextForExecution,
  seedTaskStoreFromPlan,
  hasMissionGoalTask,
  seedMissionGoalTask,
  type PlanningStep,
} from './planningMode';
import { resolveDefaultModelForRole } from './modelRoleResolver';
import { createTaskStore, createScopedTaskStore, type RebelCoreTaskStore, type RebelCoreTaskStoreInternal } from './taskState';
import { loadTaskBoard, saveTaskBoard } from './taskStatePersistence';
import { resolveModelLimits, resolveThinkingConfig, resolveEffortForApi, shouldSuppressProfileReasoning } from './modelLimits';
import type { ModelTokenLimits, RebelCoreThinkingConfig } from './modelLimits';
import type { ModelClient } from './modelClient';
import { recordContextOverflowOnProfile } from './learnedProfileWriter';
import { safeDispatchLearnedLimitsFromError } from './dispatchLearnedLimitsFromError';
import { getBuiltinPluginService } from './pluginServiceProvider';
import { decideCompaction, DEFAULT_COMPACTION_CONFIG } from './contextPolicy';
import { pruneOldToolPairs } from './contextPruning';
import { extractOldToolPairs, updateContextStateViaLLM, contextStateFailureToLedgerReason } from './contextStateUpdate';
import { formatContextStateSummary } from './contextPreservation';
import { appendCostEntry } from '@core/services/costLedgerService';
import { browserConversationScopeRegistry } from '@core/appBridge/server/browserConversationScopeRegistry';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import { isYieldingToUser } from '@core/services/userYieldDetection';
import { appendTranscriptEntry, ensureTranscriptDir, getTranscriptPath, createSeqCounter, serializeError } from '@core/services/transcriptService';
import { getAllowedSymlinkTargets } from '@core/services/workspace/trustedFilesystemRoots';
import type { AppNavigationService } from '@core/appNavigationService';
import type { ScreenshotCaptureService } from '@core/screenshotCaptureService';
import { calculateCostOrWarn } from '@shared/utils/pricingCalculator';
import type { BuiltinToolContext, BuiltinToolName, RebelCoreEvent, AgentToolContext, RebelCoreAgentDefinition, OnMcpErrorCallback, RebelCoreConfig } from './types';
import type { TurnParams } from './turnParams';
import type { ChatMessage, ContentBlock } from './modelTypes';
import { getEffectiveInputTokens } from './modelTypes';
import type { RuntimeActivityEvent } from './runtimeActivity';
import { logProviderRetryTelemetry } from './util/retryTelemetry';

const log = createScopedLogger({ service: 'rebelCoreQuery' });

/**
 * Layer 0 wall-clock sentinel for a single agent turn.
 *
 * The real per-turn ceiling lives in `src/main/services/watchdogTracker.ts`
 * (`AUTO_ABORT_MS`) — that is the value the LLM watchdog enforces and the
 * judge can extend. This Layer 0 deadline is a last-resort sentinel sitting
 * above the watchdog's effective ceiling (including any extensions and the
 * automation hard cap), so it never wins the race against legitimate
 * judge-granted extensions but still terminates a turn whose watchdog and
 * abort plumbing are wedged.
 *
 * Move-together: when this changes, also re-evaluate
 *   - `src/main/services/watchdogTracker.ts` AUTO_ABORT_MS
 *   - `src/core/utils/timeoutAsyncIterator.ts` DEFAULT_HARD_CAP_MS
 *   - `src/core/rebelCore/mcpClient.ts` TOOL_CALL_TIMEOUT
 *   - `super-mcp/src/clients/httpClient.ts` SUPER_MCP_TOOL_TIMEOUT default
 *   - `super-mcp/src/clients/stdioClient.ts` SUPER_MCP_TOOL_TIMEOUT default
 */
const TURN_WALL_CLOCK_DEADLINE_MS = 6 * 60 * 60 * 1000;

/**
 * Build synthetic MissionSet + TaskList messages from seeded task-store state.
 *
 * Called after `seedTaskStoreFromPlan()` so the renderer can display mission context
 * and task checklist immediately, without waiting for the execution model to call
 * task tools explicitly. Payloads match `runMissionSetTool()` / `runTaskListTool()`
 * output exactly so existing extractors work unchanged.
 *
 * Pure function — does not mutate adapter or task-store state.
 */
export function buildSyntheticPlanSeedMessages(
  adapter: RebelCoreAgentMessageAdapter,
  taskStore: RebelCoreTaskStore,
): AgentMessage[] {
  const allTasks = taskStore.listTasks();
  const missionContext = extractMissionContext(allTasks);
  const messages: AgentMessage[] = [];

  // Emit synthetic MissionSet if mission goal was seeded
  if (missionContext.goal) {
    const missionInput = {
      goal: missionContext.goal,
      ...(missionContext.done_criteria ? { done_criteria: missionContext.done_criteria } : {}),
      ...(missionContext.constraints ? { constraints: missionContext.constraints } : {}),
    };
    const updatedKinds = [
      'goal',
      ...(missionContext.done_criteria ? ['done_criteria'] : []),
      ...(missionContext.constraints ? ['constraints'] : []),
    ];
    const missionOutput = JSON.stringify({
      summary: `Mission context updated (${updatedKinds.join(', ')})`,
      mission: missionContext,
    }, null, 2);
    messages.push(...adapter.createSyntheticToolCallPair(
      'MissionSet', randomUUID(), missionInput, missionOutput, false, 'synthetic-plan-seed',
    ));
  }

  // Emit synthetic TaskList with full task snapshot (shared parser filters mission-owned)
  if (allTasks.length > 0) {
    const taskListOutput = JSON.stringify({
      tasks: allTasks,
      summary: `${allTasks.length} task${allTasks.length === 1 ? '' : 's'} in task list`,
    }, null, 2);
    messages.push(...adapter.createSyntheticToolCallPair(
      'TaskList', randomUUID(), {}, taskListOutput, false, 'synthetic-plan-seed',
    ));
  }

  return messages;
}

interface ModelSwitch {
  taskId: string;
  stepId: string;
  toModel: RoutingModelId;
  toEffort: ThinkingEffort | undefined;
  toProfile: ModelProfile | undefined;
  triggered: boolean;
  fallbackIterationThreshold: number | null;
  /**
   * True ONLY for the one-way escalation switch (compiled `source === 'escalation'`).
   * Drives the user-facing status copy: an escalation emits "Escalating to…",
   * every ordinary per-step / back-to-default switch emits the neutral
   * "Routing to…". The machine-readable `routing:model:${model}` status is
   * emitted unconditionally for BOTH (it is the renderer's step-label signal).
   */
  isEscalation: boolean;
}

/**
 * The co-varying parent-execution facts that MUST move together on every model
 * switch (Stage 5). Historically these were independent `let active*` variables
 * mutated piecemeal at two writer sites (initial default-routing + switch
 * application); 4 of this run's bugs came from one of them drifting out of sync
 * with the others (e.g. model advanced but profile/limits stale). Bundling them
 * into ONE type whose `commit` boundary takes the FULL set makes a partial
 * update fail to COMPILE — the bug class is killed by construction, not by test.
 *
 * `profile` is the `ModelProfile` (if any) that produced this state — carried so
 * the model/profile-pairing invariant can be asserted (`profile.model === model`)
 * and so `supportsReasoningReplay`/limits are derived from the SAME profile that
 * names the model. It is intentionally `| undefined` (escalation `to_model` is
 * profile-OPTIONAL, and a bare-model fallback has no profile) but the field is
 * REQUIRED to be present (set it to `undefined` explicitly) so a caller cannot
 * forget it.
 */
export interface ActiveExecutionState {
  readonly model: RoutingModelId;
  readonly client: ModelClient;
  readonly profileId: string | null;
  readonly profile: ModelProfile | undefined;
  readonly limits: ModelTokenLimits;
  readonly effort: 'low' | 'medium' | 'high' | 'max' | undefined;
  readonly thinking: RebelCoreThinkingConfig;
  readonly supportsReasoningReplay: boolean;
}

/**
 * The live agent-loop handle whose `config`/`opts` a mid-turn switch mutates in
 * place so the in-flight loop picks up the new model on its next iteration. Null
 * during the pre-loop pass (no loop config exists yet).
 */
export interface LiveAgentLoopHandle {
  config: RebelCoreConfig;
  opts: { supportsReasoningReplay: boolean };
}

/**
 * Sole-writer transition boundary for {@link ActiveExecutionState} (Stage 5).
 *
 * The holder closes over the canonical state privately; `current` exposes a
 * read-only view (reads stay cheap and ubiquitous), and `commit` is the ONLY
 * code allowed to replace it. Because `commit` takes a full `ActiveExecutionState`,
 * a caller physically cannot advance the model without also supplying the
 * matching client/profile/limits/effort/thinking/replay — the co-varying-mutable
 * drift class (council: GPT-5.5 + DA converged) cannot be expressed.
 *
 * `commit` ALSO derives the dependent surfaces from that single `next`:
 *  - `liveAgentLoop.config` (client/model/thinking/effort/maxTokens/contextWindow)
 *    and `liveAgentLoop.opts.supportsReasoningReplay`, when a live loop exists;
 *  - `agentCtx` parent fields (parentModel/client/parentMaxTokens/parentEffort),
 *    when an agent context exists.
 * So the badge/config/agent surfaces cannot disagree with the active state.
 *
 * Invariant assertions (cheap; throw — surfaced by the turn's catch as an
 * observable failure rather than a silent lie):
 *  (a) `next.profile`, when set, names the same model (`profile.model === next.model`);
 *  (b) after each commit, `liveAgentLoop.config` model/client/maxTokens/
 *      contextWindow/thinking/effort match the committed state.
 * (c) — badge correction/restore keying on parent-route identity — is enforced
 * structurally at the call sites via `parentRouteModelByTaskId` (Stage-2
 * Phase-7 fix) and asserted by the escalation suite; not a per-commit check.
 */
export interface ActiveExecutionStateHolder {
  readonly current: ActiveExecutionState;
  commit(
    next: ActiveExecutionState,
    liveAgentLoop: LiveAgentLoopHandle | null,
    agentCtx: AgentToolContext | null,
  ): void;
}

/** @internal Exported for tests (sole-writer transition boundary, Stage 5). */
export function createActiveExecutionStateHolder(
  initial: ActiveExecutionState,
): ActiveExecutionStateHolder {
  assertActiveExecutionStatePaired(initial);
  let state = initial;
  return {
    get current(): ActiveExecutionState {
      return state;
    },
    commit(next, liveAgentLoop, agentCtx): void {
      assertActiveExecutionStatePaired(next);
      state = next;

      // Derive the in-flight loop config from the single committed state.
      if (liveAgentLoop) {
        liveAgentLoop.config.client = next.client;
        liveAgentLoop.config.model = next.model;
        liveAgentLoop.config.thinking = next.thinking;
        if (next.effort) {
          liveAgentLoop.config.effort = next.effort;
        } else {
          delete liveAgentLoop.config.effort;
        }
        liveAgentLoop.config.maxTokens = next.limits.maxOutputTokens;
        liveAgentLoop.config.contextWindow = next.limits.contextWindow;
        liveAgentLoop.opts.supportsReasoningReplay = next.supportsReasoningReplay;

        // Invariant (b): the live loop config now mirrors the committed state.
        assertLiveLoopMatchesState(liveAgentLoop, next);
      }

      // Derive the agent-tool parent context from the same committed state.
      if (agentCtx) {
        agentCtx.client = next.client;
        agentCtx.parentModel = next.model;
        agentCtx.parentMaxTokens = next.limits.maxOutputTokens;
        if (next.effort) {
          agentCtx.parentEffort = next.effort;
        } else {
          delete agentCtx.parentEffort;
        }
      }
    },
  };
}

/**
 * Carry a profile into {@link ActiveExecutionState} ONLY when it names the given
 * model — otherwise drop it (return undefined). Used at the writer sites so the
 * pairing invariant holds by construction: the escalation `to_model` is
 * profile-OPTIONAL and its matched profile (resolved by the raw `to_model`
 * string) may name a differently-encoded model than the decoded route model;
 * carrying it would falsely trip the invariant. The profile object is only
 * metadata on the state (limits/replay are computed separately and unchanged),
 * so dropping a mismatched one is purely additive.
 */
function pairedExecutionProfile(
  profile: ModelProfile | null | undefined,
  model: RoutingModelId,
): ModelProfile | undefined {
  return profile && profile.model === model ? profile : undefined;
}

/** Invariant (a): a carried profile must name the state's model. */
function assertActiveExecutionStatePaired(state: ActiveExecutionState): void {
  if (state.profile && state.profile.model !== state.model) {
    throw new Error(
      `ActiveExecutionState invariant violated: profile '${state.profile.id}' names model `
        + `'${state.profile.model}' but active model is '${state.model}'`,
    );
  }
}

/** Invariant (b): the live loop config must mirror the committed state. */
function assertLiveLoopMatchesState(
  liveAgentLoop: LiveAgentLoopHandle,
  state: ActiveExecutionState,
): void {
  const c = liveAgentLoop.config;
  if (
    c.client !== state.client
    || c.model !== state.model
    || c.maxTokens !== state.limits.maxOutputTokens
    || c.contextWindow !== state.limits.contextWindow
    || c.thinking !== state.thinking
    || c.effort !== state.effort
    || liveAgentLoop.opts.supportsReasoningReplay !== state.supportsReasoningReplay
  ) {
    throw new Error(
      'ActiveExecutionState invariant violated: liveAgentLoop.config diverged from committed state',
    );
  }
}

// `TaskRoutingMetadata` is the serialized `routing:tasks:` wire shape. It lives
// in `@shared/routing/taskRoutingMetadata` so the renderer parser
// (`turnStepContext.ts`) imports the SAME type — a field rename now fails to
// compile on both sides instead of silently breaking badges. Re-exported here
// for the existing core-side consumers and unit tests.
export type { TaskRoutingMetadata } from '@shared/routing/taskRoutingMetadata';

/**
 * Parent-execution route identity for a task badge write (Stage 8).
 *
 * This is deliberately NOT `TaskRoutingMetadata`: the parent-route writer must be
 * keyed from the compiler's parent route, never from a displayed badge's
 * `.model` field. Sub-agent overlays are a separate display fact and have their
 * own explicit writer method below.
 */
export interface TaskRoutingParentRouteIdentity {
  readonly taskId: string;
  readonly parentRouteModel: string;
  readonly effort: string | undefined;
}

export type ParentRouteTaskRoutingMetadata =
  Omit<TaskRoutingMetadata, 'isSubAgent' | 'subAgentContext'> & {
    readonly isSubAgent?: false | undefined;
    readonly subAgentContext?: never;
  };

export type SubAgentTaskRoutingMetadata =
  TaskRoutingMetadata & { readonly isSubAgent: true };

export interface TaskRoutingMetadataWriter {
  readonly current: Record<string, TaskRoutingMetadata>;
  setParentRouteBadge(parentRoute: TaskRoutingParentRouteIdentity): void;
  fillMissingParentRouteBadge(parentRoute: TaskRoutingParentRouteIdentity): void;
  setSubAgentOverlay(parentRoute: TaskRoutingParentRouteIdentity, overlay: SubAgentTaskRoutingMetadata): void;
  applyPlanProjection(
    compiledRoutes: ReadonlyArray<CompiledStepRoute>,
    plannedTaskRoutingMetadata: Record<string, TaskRoutingMetadata>,
  ): void;
  restoreCanonicalParentRouteBadge(
    parentRoute: TaskRoutingParentRouteIdentity,
    canonical: TaskRoutingMetadata,
  ): void;
  correctFailedParentRouteBadge(
    parentRoute: TaskRoutingParentRouteIdentity,
    runningModel: string,
  ): boolean;
}

/** @internal Exported for tests (sole-writer task-routing metadata boundary, Stage 8). */
export function createTaskRoutingMetadataWriter(
  taskRoutingMetadata: Record<string, TaskRoutingMetadata>,
): TaskRoutingMetadataWriter {
  const assign = (taskId: string, entry: TaskRoutingMetadata): void => {
    // eslint-disable-next-line no-restricted-syntax -- routing-state-writer-justified: taskRoutingMetadata sole-writer assignment chokepoint; all callers must pass typed parent-route identity or explicit sub-agent overlay.
    taskRoutingMetadata[taskId] = entry;
  };

  const parentMetadata = (
    parentRoute: TaskRoutingParentRouteIdentity,
  ): ParentRouteTaskRoutingMetadata => ({
    model: parentRoute.parentRouteModel,
    ...(parentRoute.effort ? { effort: parentRoute.effort } : {}),
  });

  const assertNonSubAgent = (
    entry: TaskRoutingMetadata,
    operation: string,
  ): void => {
    if (entry.isSubAgent) {
      throw new Error(
        `TaskRoutingMetadata invariant violated: ${operation} refused sub-agent overlay for parent-route badge`,
      );
    }
  };

  const assertCanonicalMatchesParentRoute = (
    parentRoute: TaskRoutingParentRouteIdentity,
    canonical: TaskRoutingMetadata,
    operation: string,
  ): void => {
    assertNonSubAgent(canonical, operation);
    if (canonical.model !== parentRoute.parentRouteModel) {
      throw new Error(
        `TaskRoutingMetadata invariant violated: ${operation} canonical model '${canonical.model}' `
          + `does not match parent route '${parentRoute.parentRouteModel}'`,
      );
    }
  };

  const isSubAgentOverlay = (entry: TaskRoutingMetadata): entry is SubAgentTaskRoutingMetadata =>
    entry.isSubAgent === true;

  const toParentRoute = (route: CompiledStepRoute): TaskRoutingParentRouteIdentity => ({
    taskId: route.taskId,
    parentRouteModel: route.model,
    effort: route.effort,
  });

  return {
    get current(): Record<string, TaskRoutingMetadata> {
      return taskRoutingMetadata;
    },

    setParentRouteBadge(parentRoute): void {
      assign(parentRoute.taskId, parentMetadata(parentRoute));
    },

    fillMissingParentRouteBadge(parentRoute): void {
      if (!taskRoutingMetadata[parentRoute.taskId]) {
        assign(parentRoute.taskId, parentMetadata(parentRoute));
      }
    },

    setSubAgentOverlay(parentRoute, overlay): void {
      if (!overlay.isSubAgent) {
        throw new Error('TaskRoutingMetadata invariant violated: sub-agent overlay writer requires isSubAgent=true');
      }
      assign(parentRoute.taskId, overlay);
    },

    applyPlanProjection(compiledRoutes, plannedTaskRoutingMetadata): void {
      const parentRouteByTaskId = new Map(
        compiledRoutes.map((route) => [route.taskId, toParentRoute(route)]),
      );

      for (const [taskId, entry] of Object.entries(plannedTaskRoutingMetadata)) {
        const parentRoute = parentRouteByTaskId.get(taskId);
        if (!parentRoute) {
          throw new Error(
            `TaskRoutingMetadata invariant violated: plan projection has no parent route for task '${taskId}'`,
          );
        }
        if (isSubAgentOverlay(entry)) {
          this.setSubAgentOverlay(parentRoute, entry);
        } else {
          assertCanonicalMatchesParentRoute(parentRoute, entry, 'plan projection');
          assign(parentRoute.taskId, { ...entry, model: parentRoute.parentRouteModel });
        }
      }
    },

    restoreCanonicalParentRouteBadge(parentRoute, canonical): void {
      assertCanonicalMatchesParentRoute(parentRoute, canonical, 'canonical restore');
      assign(parentRoute.taskId, { ...canonical, model: parentRoute.parentRouteModel });
    },

    correctFailedParentRouteBadge(parentRoute, runningModel): boolean {
      const current = taskRoutingMetadata[parentRoute.taskId];
      if (!current) return false;
      assertNonSubAgent(current, 'failed-switch correction');
      assign(parentRoute.taskId, { ...current, model: runningModel });
      return true;
    },
  };
}

/**
 * Mutates `taskRoutingMetadata` in place: adds a `{ model: baselineModel }`
 * entry for every task ID that isn't already present. Preserves existing
 * entries (in particular sub-agent stamps written via the agent tool's
 * `onTaskRoutingMetadataUpdate` callback). Exported for unit tests.
 */
export function mergeBaselineRoutingModel(
  taskRoutingMetadata: Record<string, TaskRoutingMetadata>,
  taskIds: ReadonlyArray<string>,
  baselineModel: string,
): void {
  const metadataWriter = createTaskRoutingMetadataWriter(taskRoutingMetadata);
  for (const taskId of taskIds) {
    metadataWriter.fillMissingParentRouteBadge({
      taskId,
      parentRouteModel: baselineModel,
      effort: undefined,
    });
  }
}

function checkModelSwitchCondition(state: ModelSwitch, taskStore: RebelCoreTaskStore): boolean {
  if (!state.taskId) return false;
  const tasks = taskStore.listTasks();
  const targetTask = tasks.find(t => t.id === state.taskId);
  if (!targetTask) return false;
  return targetTask.status === 'in_progress' || targetTask.status === 'completed';
}

function findRoutingProfile(profiles: ModelProfile[], model: string): ModelProfile | undefined {
  // Parent-execution routing-pool gate: model-string match + routingEligible +
  // enabled + selectable. Funnels through the one shared `resolveRoutingProfileRef`
  // chokepoint. No extra connectivity gate (the pool passed in is already
  // connectivity-filtered by `getFunctionalRoutingProfiles`). The selectability
  // gate keeps auto-created profiles (no `serverUrl`) out of the pool — they live
  // in the AgentsTab "Needs setup" subsection until the user fills credentials in.
  //
  // routeRef (Stage A): `supportsProfileId` lets the planner disambiguate two
  // eligible profiles that share a model id by emitting a `profile:<id>` reference
  // (resolved by id against this same gated pool). A bare model string keeps the
  // existing first-match-by-model behaviour, so legacy plans are unaffected.
  return resolveRoutingProfileRef(model, {
    pool: profiles,
    requireRoutingEligible: true,
    supportsProfileId: true,
  }) ?? undefined;
}

function decodeQueryRoutingModelOrThrow(value: string, source: string): RoutingModelId {
  const decoded = decodeRoutingModelId(value);
  if (!decoded) {
    throw new ModelError('invalid_request', `Invalid ${source} model id "${value}"`, 400);
  }
  return decoded;
}

function resolvePlannerModelAgainstRoutingPool(
  rawModel: string,
  currentModel: RoutingModelId,
  profiles: ModelProfile[],
): { model: RoutingModelId; profile?: ModelProfile } | null {
  if (rawModel === currentModel) {
    return { model: currentModel };
  }
  const profile = findRoutingProfile(profiles, rawModel);
  if (!profile?.model) return null;
  return {
    model: decodeQueryRoutingModelOrThrow(profile.model, 'planner-routed profile'),
    profile,
  };
}

/**
 * One ordered parent-execution effective-route descriptor per seeded plan step.
 *
 * "Parent-execution" is the load-bearing scope: this describes the model the
 * PARENT execution client runs each step on — NOT a step's sub-agent display
 * model (a separate fact resolved on the child dispatch path and stamped at
 * runtime; see `agentTool.ts` `onTaskRoutingMetadataUpdate`). Both the
 * model-switch schedule and the parent-route portion of the UI task metadata
 * are projections of this single list, so they cannot diverge by construction.
 */
export interface CompiledStepRoute {
  stepId: string;
  taskId: string;
  /** Effective parent-execution model for this step (resolved against the pool). */
  model: RoutingModelId;
  effort: ThinkingEffort | undefined;
  /** Resolved routing profile, when one matched. Optional metadata for escalation. */
  profile: ModelProfile | undefined;
  /** Where this route came from — for telemetry/debugging. */
  source: 'default' | 'per-step' | 'escalation' | 'group';
  /** Plan ordinal (1-based) of this step among seeded steps — Stage-2 fallback source. */
  ordinal: number;
}

type EffectiveRoute = {
  model: RoutingModelId;
  effort: ThinkingEffort | undefined;
  profile: ModelProfile | undefined;
  source: CompiledStepRoute['source'];
};

export interface CompileStepRoutesInput {
  routing: import('./planningMode').RoutingDecision;
  steps: PlanningStep[];
  stepIdToTaskIdMap: Map<string, string>;
  /** The routing pool (functional, routing-eligible profiles) for resolution. */
  routingPool: ModelProfile[];
  /**
   * The parent-execution default/working route (the fallback every route
   * inherits). `profile` is the turn's default execution profile (the working
   * model's `ModelProfile`, when there is one) — carried so a switch BACK to the
   * default route reconstructs the SAME client/limits and restores the correct
   * `activeExecution.current.profileId`, instead of dropping profile telemetry by
   * reconstructing the default by bare model string (F2).
   */
  workingRoute: { model: RoutingModelId; effort: ThinkingEffort | undefined; profile?: ModelProfile };
  /** Derived valid parallel-group membership: groupId → ordered member step IDs. */
  parallelGroups: Map<string, string[]>;
}

/**
 * Pure route compiler. Walks the seeded plan steps in order and computes the
 * single parent-execution effective route for each, applying:
 *  - **per-step override**: effective = `step.model ?? default`; unresolved
 *    per-step refs fall back to the PREVIOUS route (with a telemetry log) — no
 *    silent drop, and never a throw mid-turn.
 *  - **escalation (one-way ratchet)**: at `routing.escalation.at_step` the route
 *    becomes `to_model`/`to_effort`. `to_model` stays executable by its DECODED
 *    id even when no routing profile matches — the profile is optional metadata
 *    (locked by `rebelCoreQuery.escalation.test.ts`). Once escalated, the route
 *    stays escalated for every subsequent step (the ratchet) regardless of those
 *    steps' per-step models.
 *  - **parallel-group atomicity**: a group runs one route — the default route
 *    unless ALL members resolve to the same non-default route, in which case
 *    that one. Conflicts are logged. (Siblings dispatch concurrently under one
 *    parent client, so per-sibling switching is physically impossible.)
 */
/** @internal Exported for tests. */
/**
 * The provider-binding identity of a parent route. Two routes dispatch
 * identically only when model, effort, AND the resolved profile match — the
 * profile carries the provider/credential binding (`profileDecision`), so a
 * same-model / different-profile route (the planner's live `profile:<id>`
 * contract) is a real route change, not effort-only. `null` = no resolved
 * profile (bare working route or a decode-to-itself escalation).
 *
 * When there are no same-model profile collisions (the common case) a route's
 * profile id tracks its model 1:1, so keying on this is identical to keying on
 * model alone — it only diverges in exactly the same-model / different-profile
 * case that `profile:<id>` exists to express.
 */
const routeProfileId = (route: { profile?: ModelProfile | undefined } | undefined): string | null =>
  route?.profile?.id ?? null;

export function compileStepRoutes(input: CompileStepRoutesInput): CompiledStepRoute[] {
  const { routing, steps, stepIdToTaskIdMap, routingPool, workingRoute, parallelGroups } = input;
  const defaultModel = workingRoute.model;
  // The turn's default execution profile — carried onto every DEFAULT-source
  // route so a switch BACK to the working model restores the correct profile +
  // limits + activeExecution.current.profileId, rather than reconstructing the default by
  // bare model string and dropping its learned-limit/profile telemetry (F2).
  //
  // INVARIANT (by construction): a working profile is only honoured when it
  // describes the SAME model as the working route. A mismatched pair (e.g. a
  // stale settings working profile paired with a planner-routed default model)
  // would make a switch-back build a client for the PROFILE's model — explicit
  // profile wins in providerRouting — while routing:model: claims the route
  // model, reintroducing the model/UI divergence this refactor exists to kill.
  // On mismatch we DROP the profile (fall back to bare-model-string resolution,
  // the pre-F2 behaviour — correct, never a lie) and log loudly.
  let defaultProfile = workingRoute.profile;
  if (defaultProfile && defaultProfile.model !== defaultModel) {
    log.warn(
      { workingModel: defaultModel, profileModel: defaultProfile.model, profileId: defaultProfile.id },
      'compileStepRoutes: working-route profile model does not match the working model — dropping it to avoid a model/profile mismatch on switch-back',
    );
    defaultProfile = undefined;
  }

  // Reverse index: stepId → groupId, for the steps that belong to a valid group.
  const groupIdByStepId = new Map<string, string>();
  for (const [groupId, memberStepIds] of parallelGroups) {
    for (const memberStepId of memberStepIds) {
      groupIdByStepId.set(memberStepId, groupId);
    }
  }

  // Resolve a single step's per-step/default effective route against the pool.
  // Returns null only when a non-empty per-step ref fails to resolve (caller
  // falls back to the previous route + logs). A model-less step resolves to the
  // working/default route.
  const resolveStepRoute = (step: PlanningStep): EffectiveRoute | null => {
    const rawModel = step.model?.trim();
    const stepEffort = step.effort as ThinkingEffort | undefined;
    if (!rawModel) {
      return { model: defaultModel, effort: workingRoute.effort, profile: defaultProfile, source: 'default' };
    }
    const resolved = resolvePlannerModelAgainstRoutingPool(rawModel, defaultModel, routingPool);
    if (!resolved) return null;
    // routeRef (Stage A): a `profile:<id>` per-step ref that resolved to a profile is an
    // explicit provider-bound route — NOT the default — even when its model string matches
    // the default model (same-model cross-provider switch). A bare ref that resolves to the
    // working model is the default route — carry the working profile so its limits/profile-id
    // are restored on the back-switch.
    const isExplicitProfileStep = isProfileReference(rawModel) && !!resolved.profile;
    const isDefault = !isExplicitProfileStep && resolved.model === defaultModel;
    return {
      model: resolved.model,
      effort: stepEffort,
      profile: isDefault ? defaultProfile : resolved.profile,
      source: isDefault ? 'default' : 'per-step',
    };
  };

  // Pre-compute group routes (group-atomic): default unless ALL members agree
  // on one non-default route.
  const groupRouteByGroupId = new Map<string, EffectiveRoute>();
  for (const [groupId, memberStepIds] of parallelGroups) {
    const memberRoutes: EffectiveRoute[] = [];
    let anyUnresolved = false;
    for (const memberStepId of memberStepIds) {
      const memberStep = steps.find((s) => s.id === memberStepId);
      if (!memberStep) continue;
      const route = resolveStepRoute(memberStep);
      if (!route) {
        anyUnresolved = true;
        continue;
      }
      memberRoutes.push(route);
    }
    // routeRef (route-identity): a member wants a non-default route when the
    // compiler tagged it non-`default` — which INCLUDES a same-model explicit
    // `profile:<id>` route (source 'per-step'), not only a different model.
    // Agreement therefore also compares profile identity: two members on the
    // same model via DIFFERENT profiles disagree, so the group runs on default.
    const nonDefault = memberRoutes.filter((r) => r.source !== 'default');
    const allAgreeNonDefault =
      !anyUnresolved &&
      nonDefault.length === memberRoutes.length &&
      nonDefault.length > 0 &&
      nonDefault.every(
        (r) =>
          r.model === nonDefault[0]?.model
          && r.effort === nonDefault[0]?.effort
          && routeProfileId(r) === routeProfileId(nonDefault[0]),
      );

    if (allAgreeNonDefault && nonDefault[0]) {
      groupRouteByGroupId.set(groupId, { ...nonDefault[0], source: 'group' });
    } else {
      if (nonDefault.length > 0 || anyUnresolved) {
        log.info(
          {
            groupId,
            memberStepIds,
            memberModels: memberRoutes.map((r) => r.model),
            anyUnresolved,
          },
          'compileStepRoutes: parallel group has conflicting/unresolved member routes — running group on the default route',
        );
      }
      groupRouteByGroupId.set(groupId, {
        model: defaultModel,
        effort: workingRoute.effort,
        profile: defaultProfile,
        source: 'group',
      });
    }
  }

  // Escalation target (profile-OPTIONAL: decode-to-itself, never resolve-or-drop).
  //
  // ELIGIBILITY GUARD IS UPSTREAM, NOT HERE (GPT stage-12 review F4): unlike
  // default/step routes — which pass through
  // resolvePlannerModelAgainstRoutingPool() → resolveRoutingProfileRef(...,
  // requireRoutingEligible: true) — the escalation to_model is decoded
  // directly with no pool re-validation in this function. What keeps an
  // un-chipped (e.g. premium always-on) model out of the escalation route is
  // extractRoutingFromPlan() in planningMode.ts, which strips any escalation
  // whose to_model is outside `eligibleModelIds` (routing-eligible profiles +
  // the current working model) before the routing decision ever reaches us.
  // Do NOT remove that upstream strip as "redundant" — it is the ONLY
  // eligibility gate on this path (planningMode.test.ts pins it, including
  // the premium-model case).
  //
  // `engageStep` is the step at which the one-way ratchet actually latches. It is
  // normally the planner's `at_step`, BUT when `at_step` is a MEMBER of a parallel
  // group it is re-pointed to that group's FIRST member so the ENTIRE group runs
  // on the escalation route atomically (Stage 6). Siblings dispatch concurrently
  // under one parent client, so a group must run on ONE route — engaging mid-batch
  // would partially escalate the group, which a single parent client cannot
  // physically honour. Engaging at the group's first member = "escalated from here
  // onward" applied to the whole group, the natural reading of the ratchet.
  // Non-group escalation is UNCHANGED (engageStep === at_step).
  let escalation: { atStep: string; engageStep: string; route: EffectiveRoute } | null = null;
  if (routing.escalation) {
    // routeRef (Stage A): resolve the profile FIRST so a `profile:<id>` escalation ref
    // decodes via the profile's model id (a raw `profile:<id>` is not a valid wire model
    // and would throw in decode). For a bare-model ref the profile is optional metadata
    // (may be undefined) and we decode the ref itself, exactly as before.
    const escalationProfile = findRoutingProfile(routingPool, routing.escalation.to_model);
    const decoded = decodeQueryRoutingModelOrThrow(
      escalationProfile?.model ?? routing.escalation.to_model,
      'planner escalation to_model',
    );
    const atStep = routing.escalation.at_step;
    const escalationGroupId = groupIdByStepId.get(atStep);
    // Re-point engagement to the group's first member when at_step is grouped.
    const engageStep =
      escalationGroupId !== undefined
        ? parallelGroups.get(escalationGroupId)?.[0] ?? atStep
        : atStep;
    if (engageStep !== atStep) {
      log.info(
        { atStep, engageStep, groupId: escalationGroupId },
        'compileStepRoutes: escalation.at_step is inside a parallel group — engaging escalation at the group boundary so the whole group escalates atomically',
      );
    }
    escalation = {
      atStep,
      engageStep,
      route: {
        model: decoded,
        effort: routing.escalation.to_effort as ThinkingEffort | undefined,
        // Profile is optional metadata: present when one happens to match, else undefined.
        profile: findRoutingProfile(routingPool, routing.escalation.to_model),
        source: 'escalation',
      },
    };
  }

  const compiled: CompiledStepRoute[] = [];
  let previous: EffectiveRoute = {
    model: defaultModel,
    effort: workingRoute.effort,
    profile: defaultProfile,
    source: 'default',
  };
  let escalated = false; // one-way ratchet latch
  let ordinal = 0;

  for (const step of steps) {
    if (!step.id) continue;
    const taskId = stepIdToTaskIdMap.get(step.id);
    if (!taskId) continue;
    ordinal += 1;

    let route: EffectiveRoute;
    if (escalated) {
      // Ratchet held: stay on the escalation route for the rest of the turn.
      route = previous;
    } else {
      const groupId = groupIdByStepId.get(step.id);
      const groupRoute = groupId ? groupRouteByGroupId.get(groupId) : undefined;
      if (groupRoute) {
        route = groupRoute;
      } else {
        const resolved = resolveStepRoute(step);
        if (!resolved) {
          // Unresolved per-step ref: fall back to the previous route, never drop.
          log.info(
            { stepId: step.id, rawModel: step.model, fallbackModel: previous.model },
            'compileStepRoutes: per-step model did not resolve against the routing pool — falling back to previous route',
          );
          route = previous;
        } else {
          route = resolved;
        }
      }

      // Engage escalation at its engagement step (overrides the per-step/group
      // route) and latch the ratchet for all subsequent steps. `engageStep` is
      // `at_step` for an ungrouped step, OR the group's FIRST member when
      // `at_step` is grouped — so the whole group escalates atomically: this
      // member takes the escalation route and every later sibling stays on it via
      // the latched ratchet below. No member runs on the pre-escalation route once
      // escalation engages within/at the group.
      if (escalation && step.id === escalation.engageStep) {
        route = escalation.route;
        escalated = true;
      }
    }

    compiled.push({
      stepId: step.id,
      taskId,
      model: route.model,
      effort: route.effort,
      profile: route.profile,
      source: route.source,
      ordinal,
    });
    previous = route;
  }

  return compiled;
}

/**
 * Projection: emit a `ModelSwitch` on every parent-route CHANGE (model, effort,
 * OR resolved profile), including back-to-default transitions on sparse
 * overrides and the escalation step. Escalation is merged into this same
 * schedule — there is no mutually-exclusive per-step-vs-escalation branch.
 *
 * Consumes a single `CompiledStepRoute[]` so the compiler runs ONCE at the
 * orchestration site (shared with `buildTaskRoutingMetadata`) — its diagnostics
 * (unresolved-ref / group-conflict logs) emit once, not per projection.
 *
 * `defaultProfileId` is the working route's profile id (or `null`), the baseline
 * the first step is compared against so a same-model / different-profile first
 * step still emits a switch.
 *
 * `fallbackIterationThreshold` is sourced from the route's **plan ordinal**
 * (1-based position among seeded steps) — the iteration-count backstop for when
 * the task store never marks the switch's step `in_progress`/`completed`. This
 * replaces the old digit-scraping of trailing step-id digits (DA-F7).
 *
 * @internal Exported for tests.
 */
export function buildModelSwitchSchedule(
  compiled: CompiledStepRoute[],
  defaultModel: RoutingModelId,
  defaultEffort: ThinkingEffort | undefined,
  defaultProfileId: string | null,
): ModelSwitch[] {
  const switches: ModelSwitch[] = [];
  let previousModel = defaultModel;
  let previousEffort = defaultEffort;
  let previousProfileId = defaultProfileId;

  for (const route of compiled) {
    const profileId = routeProfileId(route);
    if (route.model === previousModel && route.effort === previousEffort && profileId === previousProfileId) {
      continue;
    }
    switches.push({
      taskId: route.taskId,
      stepId: route.stepId,
      toModel: route.model,
      toEffort: route.effort,
      toProfile: route.profile,
      triggered: false,
      fallbackIterationThreshold: route.ordinal,
      // Escalation copy is reserved for the actual one-way escalation switch.
      isEscalation: route.source === 'escalation',
    });
    previousModel = route.model;
    previousEffort = route.effort;
    previousProfileId = profileId;
  }

  return switches;
}

/**
 * Projection: the PARENT-route portion of the per-task UI metadata, derived
 * from the same compiler output the switch schedule uses. The sub-agent overlay
 * (planner first-sub-agent model/effort/context, `isSubAgent`, and the runtime
 * stamp written via `onTaskRoutingMetadataUpdate`) is layered ON TOP of this
 * unchanged by the caller — it is a different fact and is NOT flattened here.
 */
function buildTaskRoutingMetadata(
  compiled: CompiledStepRoute[],
  steps: PlanningStep[] | undefined,
  stepIdToTaskIdMap: Map<string, string>,
  routing: import('./planningMode').RoutingDecision | undefined,
): Record<string, TaskRoutingMetadata> {
  if (!steps?.length || !routing) {
    return {};
  }

  const routeByStepId = new Map(compiled.map((route) => [route.stepId, route]));

  const modelByTaskId: Record<string, TaskRoutingMetadata> = {};
  for (const step of steps) {
    if (!step.id) continue;
    const taskId = stepIdToTaskIdMap.get(step.id);
    if (!taskId) continue;

    // Parent-route projection (the parity-scoped fact).
    const parentRoute = routeByStepId.get(step.id);
    const parentModel: string | undefined = parentRoute?.model ?? step.model ?? routing.default_model;
    const parentEffort = parentRoute?.effort ?? (step.effort ?? routing.default_effort);

    // Sub-agent overlay (a separate fact — layered on top, NOT flattened).
    const firstSubAgent = step.sub_agents?.find((subAgent) => subAgent.model);
    const isSubAgent = Boolean(step.sub_agents?.length);
    const subAgentContext = firstSubAgent?.context;

    // For sub-agent steps the badge shows the (plan-time) child model/effort —
    // preserving the historical behaviour; the runtime stamp later overwrites
    // this in-place with the actually-resolved child model.
    const model = firstSubAgent?.model ?? parentModel;
    if (!model) continue;
    const effort = firstSubAgent?.effort ?? parentEffort;

    modelByTaskId[taskId] = {
      model,
      ...(effort ? { effort } : {}),
      ...(isSubAgent ? { isSubAgent: true } : {}),
      ...(subAgentContext ? { subAgentContext } : {}),
    };
  }

  return modelByTaskId;
}

interface RebelCoreQueryContext {
  settings: AppSettings;
  cwd?: string;
  /**
   * User home directory, used to authorize writes under
   * `<homePath>/mcp-servers/<project>/` for the build-custom-mcp-server skill.
   * See `src/core/rebelCore/toolPathResolver.ts`. When absent, only paths
   * under `cwd` are writable (pre-2026-04-20 behaviour).
   */
  homePath?: string;
  /** App user-data directory — threaded to Bash guard for dynamic MCP config path matching. */
  userDataPath?: string;
  /**
   * Bundled rebel-system directory (`getSystemSettingsPath()` on desktop —
   * dev: submodule clone; prod: `process.resourcesPath/rebel-system`).
   * Treated as a trusted symlink target so reads/edits through the
   * `<workspace>/rebel-system/` workspace symlink resolve cleanly through
   * `verifyNoSymlinkEscape`. When absent (cloud/mobile), the symlink is
   * not present, so this is irrelevant on those surfaces.
   */
  rebelSystemRoot?: string;
  sessionId?: string;
  origin?: string;
  /** Turn ID from the executor — used for transcript logging. Falls back to randomUUID() if absent. */
  turnId?: string;
  superMcpUrl?: string | null;
  proxyConfig?: { baseURL?: string; defaultHeaders?: Record<string, string> };
  onMcpError?: OnMcpErrorCallback;
  /** Desktop-only capability. Undefined on cloud/mobile. */
  captureRebelWindow?: ScreenshotCaptureService['captureRebelWindow'];
  /** Desktop-only internal app navigation capability. Undefined on cloud/mobile. */
  navigateApp?: AppNavigationService['navigateApp'];
  getCacheAgeMs?: () => number;
  onStreamActivity?: (event: RuntimeActivityEvent) => void;
  onToolDispatch?: (toolUseId: string, controller: AbortController) => void;
  onToolSettle?: (toolUseId: string) => void;
  onFileChanged?: (filePath: string) => void;
  getLatestSuperMcpUrl?: () => string | null;
  /** Pre-built execution client — bypasses internal client creation when provided. */
  executionClient?: import('./modelClient').ModelClient;
  /** Pre-built planning client — bypasses internal planning client creation when provided. */
  planningClient?: import('./modelClient').ModelClient;
  /** Actual execution model name — overrides the Claude model from env vars when an injected executionClient uses a different model. */
  executionModelOverride?: RoutingModelId;
  /** Actual planning model name — overrides the Claude model from env vars when an injected planningClient uses a different model. */
  planningModelOverride?: RoutingModelId;
  /**
   * True iff the user explicitly overrode the model/profile for THIS turn (per-conversation override),
   * NOT for users on a default working profile. Used to disable Smart picking for the turn so the user's
   * pick is honoured exactly. Distinct from `executionModelOverride`, which is set whenever a direct
   * (non-proxy) execution client is injected — including for default working profiles.
   */
  perConversationModelOverride?: boolean;
  /** Codex OAuth mode — forwarded to createClientForModel for fallback/subagent client creation */
  codexMode?: import('./codexModeTypes').CodexModeConfig;
  /** Optional connection liveness snapshot for connection-managed profiles. */
  connectivity?: ProfileConnectivity;
  /** Host surface for built-in tools that must gate desktop-only filesystem capabilities. */
  surfaceCapability?: 'desktop' | 'cloud';
  /** Stage 1 default is false; later stages thread explicit Operator/council intent. */
  wasExplicitCouncilIntent?: boolean;
}

/**
 * Async channel that bridges callback-based event emission with async generator consumption.
 * The agent loop pushes events; the generator yields them as they arrive.
 */
class AsyncChannel<T> {
  private queue: T[] = [];
  private resolve: (() => void) | null = null;
  private done = false;
  private error: Error | null = null;

  push(value: T): void {
    this.queue.push(value);
    this.resolve?.();
    this.resolve = null;
  }

  finish(): void {
    this.done = true;
    this.resolve?.();
    this.resolve = null;
  }

  fail(err: Error): void {
    this.error = err;
    this.done = true;
    this.resolve?.();
    this.resolve = null;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    while (true) {
      while (this.queue.length > 0) {
        // Queue is guaranteed non-empty by the while condition above
        yield this.queue.shift() as T;
      }

      if (this.error) {
        throw this.error;
      }

      if (this.done) {
        return;
      }

      await new Promise<void>((r) => {
        this.resolve = r;
      });
    }
  }
}

/**
 * Resolve the prompt to API-compatible message params.
 * String prompts become a single user message.
 * AsyncGenerator prompts (used for attachment injection) are consumed
 * and their content blocks collected into user messages.
 */
async function resolvePromptMessages(
  prompt: string | AsyncGenerator<unknown, void, unknown>,
): Promise<ChatMessage[]> {
  const isChatRole = (value: unknown): value is ChatMessage['role'] =>
    value === 'user' || value === 'assistant';
  const isMessageContent = (value: unknown): value is ChatMessage['content'] =>
    typeof value === 'string' || Array.isArray(value);

  if (typeof prompt === 'string') {
    if (!prompt) return [];
    return [{ role: 'user' as const, content: prompt }];
  }

  // AsyncGenerator prompt — consume all yielded values.
  // The user message generator (createUserMessageGenerator) yields objects shaped as
  // { type: 'user', message: { role: 'user', content: ContentBlock[] } }.
  // We must extract the actual message rather than treating the wrapper as a content block.
  const messages: ChatMessage[] = [];
  try {
    for await (const chunk of prompt) {
      if (typeof chunk === 'string') {
        messages.push({ role: 'user' as const, content: chunk });
      } else if (chunk && typeof chunk === 'object') {
        const obj = chunk as Record<string, unknown>;
        const msg = obj.message;
        if (msg && typeof msg === 'object') {
          const msgObj = msg as { role?: unknown; content?: unknown };
          if (isChatRole(msgObj.role) && isMessageContent(msgObj.content)) {
            messages.push({ role: msgObj.role, content: msgObj.content });
            continue;
          }
        }

        if (isChatRole(obj.role) && isMessageContent(obj.content)) {
          messages.push({ role: obj.role, content: obj.content });
        } else {
          // Fallback for non-standard prompt generator chunks.
          messages.push({ role: 'user' as const, content: [obj as unknown as ContentBlock] });
        }
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      // Generator aborted during turn cancellation — expected, not an error
    } else {
      log.warn({ err }, 'Prompt generator failed unexpectedly — turn may proceed with partial prompt');
    }
  }

  return messages;
}

const getRetryStatusMessage = (attempt: number, maxRetries: number, provider?: string): string | null => {
  const who = provider || 'The API';
  if (attempt === 1) return `${who} needs a moment. Trying again shortly.`;
  if (attempt === 2) return `Still waiting on ${who}. These things happen.`;
  if (attempt >= maxRetries) return `One last try with ${who} — hang tight.`;
  return null;
};

export { logProviderRetryTelemetry };

const isAbortError = (error: unknown): boolean => {
  if (error instanceof ModelError && error.isAbort) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === 'AbortError' || /aborted/i.test(error.message);
};

function createTurnSettingsSnapshot(settings: AppSettings): AppSettings {
  return {
    ...settings,
    // eslint-disable-next-line no-restricted-properties -- Turn snapshot copies raw settings; model semantics are still resolved through accessors downstream.
    models: settings.models ? { ...settings.models } : settings.models,
    experimental: settings.experimental ? { ...settings.experimental } : settings.experimental,
    localModel: settings.localModel
      ? {
          ...settings.localModel,
          profiles: (settings.localModel.profiles ?? []).map((profile) => ({ ...profile })),
        }
      : settings.localModel,
  } as AppSettings;
}

export async function* rebelCoreQuery(
  params: TurnParams,
  context: RebelCoreQueryContext,
): AsyncGenerator<AgentMessage, void, undefined> {
  const { prompt } = params;
  const {
    settings: liveSettings,
    cwd,
    sessionId,
    superMcpUrl,
    proxyConfig,
    onMcpError,
  } = context;
  const settings = createTurnSettingsSnapshot(liveSettings);

  // --- Transcript logging setup (fail-open) ---
  // Narrow sessionId to string for transcript helpers (avoids non-null assertions).
  const transcriptSessionId: string | null = sessionId ?? null;
  let transcriptEnabled = !!transcriptSessionId;
  if (transcriptEnabled) {
    try {
      ensureTranscriptDir();
    } catch (e) {
      log.warn({ err: e }, 'Transcript dir creation failed — disabling transcript for this turn');
      transcriptEnabled = false;
    }
  }
  const transcriptTurnId = context.turnId ?? randomUUID();
  const seqCounter = createSeqCounter();
  const imageAssetSurface: 'desktop' | 'cloud' = process.env.REBEL_SURFACE === 'cloud' ? 'cloud' : 'desktop';
  const surfaceCapability: 'desktop' | 'cloud' = context.surfaceCapability
    ?? (() => {
      try {
        return getPlatformConfig().surface === 'cloud' ? 'cloud' : 'desktop';
      } catch {
        return process.env.REBEL_SURFACE === 'cloud' ? 'cloud' : 'desktop';
      }
    })();
  let toolResultEventSeq = 0;
  const nextToolResultEventSeq = (): number => toolResultEventSeq++;

  const logCore = (transcriptEnabled && transcriptSessionId)
    ? (event: RebelCoreEvent) => {
      try {
        appendTranscriptEntry({
          v: 1, ts: Date.now(), sid: transcriptSessionId, tid: transcriptTurnId,
          seq: seqCounter.next(), depth: 0, ns: 'main',
          event: { kind: 'core', event },
        });
      } catch { /* fail-open */ }
    }
    : () => {};

  const logSynthetic = (transcriptEnabled && transcriptSessionId)
    ? (tag: string, data: unknown) => {
      try {
        appendTranscriptEntry({
          v: 1, ts: Date.now(), sid: transcriptSessionId, tid: transcriptTurnId,
          seq: seqCounter.next(), depth: 0, ns: 'main',
          event: { kind: 'synthetic', tag, data },
        });
      } catch { /* fail-open */ }
    }
    : () => {};

  const logError = (transcriptEnabled && transcriptSessionId)
    ? (err: unknown) => {
      try {
        appendTranscriptEntry({
          v: 1, ts: Date.now(), sid: transcriptSessionId, tid: transcriptTurnId,
          seq: seqCounter.next(), depth: 0, ns: 'main',
          event: serializeError(err),
        });
      } catch { /* fail-open */ }
    }
    : () => {};

  // Resolve models first so we can use the execution model for routing decisions
  const runtimeModels = resolveRuntimeModels({
    model: params.model,
    env: params.env,
    settings,
    resolveModelForRole: resolveDefaultModelForRole,
  });
  const model = runtimeModels.executionModel;

  // Create execution client (used for main agent loop + betweenTurns compaction).
  // When the executor pre-builds a direct role client, use it directly.
  // Otherwise fall back to internal creation:
  // model.startsWith('claude-') is the correct signal here: the resolved model from
  // env vars matches the user's configured model. Non-Anthropic users get non-Claude
  // model names, so they fall through to createModelClient() which routes via profile.
  // When proxy is bypassed and the model IS Claude, force direct Anthropic to prevent
  // profile-based routing to an OpenAI-compatible provider that doesn't recognize
  // Claude model IDs.
  // Provider-identity headers — set by queryOptionsBuilder, parsed by queryRouter.
  // These flow into createModelClient() which uses them to bypass Anthropic auth
  // (the proxy handles auth injection). If these are missing, createModelClient()
  // calls getAnthropicAuth() which throws for users without an Anthropic API key.
  // See: clientFactory.ts PRECEDENCE 1, queryOptionsBuilder.ts proxy env builders.
  const isCodex = proxyConfig?.defaultHeaders?.['x-codex-turn'] === 'true';
  // Codex diagnostic: trace client creation path
  if (isCodex) {
    log.info({
      executionModel: model,
      planningModel: runtimeModels.planningModel,
      isPlanMode: runtimeModels.isPlanMode,
      hasProxyBaseURL: !!proxyConfig?.baseURL,
      hasInjectedExecutionClient: !!context.executionClient,
      hasInjectedPlanningClient: !!context.planningClient,
      proxyHeaders: proxyConfig?.defaultHeaders ? Object.keys(proxyConfig.defaultHeaders) : [],
    }, '[CODEX-DIAG] rebelCoreQuery client routing');
  }
  // R2 (plan 260422) defense-in-depth: if the resolved execution model is
  // proxy-dialect (contains '/') but we have no proxy config, the `else` branch
  // below would fall into createModelClient's PRECEDENCE 2 direct-Anthropic path
  // (clientFactory.ts:175-189) and 404 against Anthropic's native API. Fail
  // loudly now with the same classified error shape as createDirectAnthropicClient.
  // Closes the residual R2 gap surfaced in Phase 2 Batch 4 review.
  if (!context.executionClient && !proxyConfig?.baseURL && model.includes('/')) {
    // R2 (plan 260422) + F2 (plan 260422_routing_followups_mock_and_kind):
    // classify as 'routing' (first-class AgentErrorKind). `__routingCause`
    // carries the sub-cause for telemetry.
    const routingError = new Error(
      `rebelCoreQuery: proxy-dialect model "${model}" cannot be routed without a proxy config. ` +
      'This indicates a routing bug: a proxy-format model string reached the direct-Anthropic path. ' +
      'Please report with your Settings → Models config.',
    ) as Error & { __agentErrorKind?: string; __routingCause?: string };
    routingError.__agentErrorKind = 'routing';
    routingError.__routingCause = 'proxy-dialect-without-proxy-config';
    throw routingError;
  }

  const executionClient = context.executionClient
    ?? await createClientForModel({
      model,
      settings,
      proxyConfig,
      context: 'execution',
      codexMode: context.codexMode,
    });

  // Create planning client only when needed and model differs from execution.
  // If planning model is the same as execution model, reuse the execution client.
  // When the executor pre-builds a direct planning client, use it directly.
  let planningClient: import('./modelClient').ModelClient | null = null;
  if (context.planningClient) {
    planningClient = context.planningClient;
  } else if (runtimeModels.isPlanMode && runtimeModels.planningModel && runtimeModels.planningModel !== model) {
    if (isCodex) {
      log.info({
        planningModel: runtimeModels.planningModel,
        executionModel: model,
      }, '[CODEX-DIAG] Creating separate planning client for plan mode');
    }
    try {
      planningClient = await createClientForModel({
        model: runtimeModels.planningModel,
        settings,
        proxyConfig,
        context: 'planning',
        codexMode: context.codexMode,
      });
    } catch (planClientError) {
      // Planning failure = hard fail. If user requested plan mode, silently
      // skipping planning would produce bad results.
      const msg = planClientError instanceof Error ? planClientError.message : String(planClientError);
      if (isCodex) {
        log.error({
          planningModel: runtimeModels.planningModel,
          errorMessage: msg,
        }, '[CODEX-DIAG] Planning client creation FAILED — this will throw');
      }
      reclassifyOrRethrow(
        planClientError,
        'auth',
        `Cannot initialize planning model "${runtimeModels.planningModel}": ${msg}`,
        undefined,
        runtimeModels.planningModel,
      );
    }
  }
  // If no separate planning client needed, reuse execution client
  const effectivePlanningClient = planningClient ?? executionClient;

  // When an injected client carries a non-Claude model, override the resolved runtime names.
  // resolveRuntimeModels() still drives isPlanMode detection and PLAN_MODE_ALIAS semantics.
  // These effective names are only used by downstream consumers
  // (runAgentLoop, resolveModelLimits, agentCtx, adapter, etc.).
  const effectiveExecutionModel = context.executionModelOverride || runtimeModels.executionModel;
  const effectivePlanningModel = context.planningModelOverride || runtimeModels.planningModel;
  const effectiveDisplayModel = context.executionModelOverride || runtimeModels.displayModel;

  log.info(
    { injectedExecution: !!context.executionClient, injectedPlanning: !!context.planningClient },
    'Client source for turn',
  );
  const systemPrompt = params.systemPrompt || '';
  const hooks = params.hooks ?? {};
  const abortController = params.abortController ?? new AbortController();
  const signal = abortController.signal;

  log.info(
    {
      model: effectiveExecutionModel,
      planningModel: effectivePlanningModel,
      planMode: runtimeModels.isPlanMode,
      hasHooks: !!params.hooks,
      cwd,
    },
    'Starting Rebel Core agent turn',
  );

  // Parallel turn init: MCP session, prompt messages, and task board are independent.
  // MCP failure is non-fatal — agent continues without MCP tools.
  let mcpSession: McpSession | null = null;
  let mcpConnectionFailed = false;
  const browserConversationSessionId =
    sessionId && (context.origin === 'browser-extension' || browserConversationScopeRegistry.get(sessionId))
      ? sessionId
      : undefined;

  const initStart = Date.now();
  const [mcpResult, promptMessages] = await Promise.all([
    createMcpSession(superMcpUrl ?? null, {
      onMcpError,
      getLatestUrl: context.getLatestSuperMcpUrl,
      ...(browserConversationSessionId ? { sessionId: browserConversationSessionId } : {}),
    }).catch(() => {
      mcpConnectionFailed = true;
      return null;
    }),
    resolvePromptMessages(prompt),
  ]);
  mcpSession = mcpResult;
  const messages = params.recoveryMessages?.length
    ? [...params.recoveryMessages, ...promptMessages]
    : promptMessages;

  if (superMcpUrl && !mcpSession) {
    mcpConnectionFailed = true;
    log.warn('MCP session creation failed — agent will run without MCP tools');
  }

  try {
    const builtinTools = getBuiltinToolDefinitions();
    const mcpToolDefs = mcpSession ? await mcpSession.listTools() : [];
    log.debug({ initMs: Date.now() - initStart }, 'Turn initialization complete');

    // Transcript: turn-start synthetic (after MCP tools are resolved)
    logSynthetic('turn-start', { model: effectiveExecutionModel, planMode: runtimeModels.isPlanMode, toolCount: mcpToolDefs.length });

    if (superMcpUrl && mcpToolDefs.length === 0) {
      log.warn(
        { mcpConnectionFailed },
        'MCP tools unavailable for this turn — continuing without MCP tools',
      );
    }

    // Extract agent definitions from params (if any) and always register the built-in
    // forager agent. This means hasAgents is always true and the Agent tool is always
    // available in the tool spec — intentional, so the orchestrator can dispatch foraging
    // tasks without conditional setup (~50 tokens overhead per turn).
    const agents = { ...(params.agents ?? {}) } as Record<string, RebelCoreAgentDefinition>;
    const foragerDef = buildForagerAgentDef();
    foragerDef.btsCategory = FORAGER_BTS_CATEGORY;
    const mcpToolNames = mcpToolDefs.map((toolDef) => toolDef.apiToolName);
    foragerDef.tools = ['Read', ...mcpToolNames];
    if (agents[FORAGER_AGENT_NAME]) {
      log.warn('Caller-provided forager agent overridden by built-in forager definition');
    }
    agents[FORAGER_AGENT_NAME] = foragerDef;
    const hasAgents = Object.keys(agents).length > 0;

    // Build suppression set from capability resolution (MCP alternatives override builtins).
    const suppressedSet = new Set<BuiltinToolName>(params.suppressedBuiltins ?? []);

    const allToolNames = [
      ...builtinTools.map((t) => t.name),
      ...mcpToolDefs.map((t) => t.apiToolName),
      ...(hasAgents ? ['Agent'] : []),
      'MissionSet',
      'GetPreviousTasks',
    ].filter((name) => !suppressedSet.has(name as BuiltinToolName));

    // Resolve token limits from profile settings (or known-model fallback)
    const activeProfile = getWorkingModelProfile(settings);
    // Reasoning-replay is keyed on the concrete backend model directly via the shared single source
    // `computeSupportsReasoningReplay`; this is the main-turn execution model (alias == concrete
    // here). A multi-axis `resolveModelCapabilities()` read-model that composed the same helper was
    // never consumed in production and has been removed. See STAGE0_PLAN.md + the dispatch-seam guard
    // (scripts/check-capability-resolution-dispatch-seam.ts) for the concrete-keying invariant.
    const initialSupportsReasoningReplay = computeSupportsReasoningReplay(
      activeProfile,
      activeProfile?.model ?? effectiveExecutionModel,
    );
    const hasExtendedContext = !!params.env?.[ENV_EXECUTION_MODEL]?.includes?.('[1m]')
      || !!params.env?.[ENV_THINKING_MODEL]?.includes?.('[1m]')
      || !!params.model?.includes?.('[1m]');

    const executionLimits = resolveModelLimits({
      model: effectiveExecutionModel,
      profileMaxOutput: activeProfile?.maxOutputTokens,
      profileMaxOutputSource: activeProfile?.outputTokensSource,
      profileContextWindow: activeProfile?.contextWindow,
      profileContextWindowSource: activeProfile?.contextWindowSource,
      allProfiles: settings.localModel?.profiles ?? [],
      extendedContext: hasExtendedContext,
    });

    const planningProfile = effectivePlanningModel ? getThinkingProfile(settings) : null;
    const planningLimits = effectivePlanningModel
      ? resolveModelLimits({
        model: effectivePlanningModel,
        profileMaxOutput: planningProfile?.maxOutputTokens,
        profileMaxOutputSource: planningProfile?.outputTokensSource,
        profileContextWindow: planningProfile?.contextWindow,
        profileContextWindowSource: planningProfile?.contextWindowSource,
        allProfiles: settings.localModel?.profiles ?? [],
        extendedContext: hasExtendedContext,
      })
      : executionLimits;

    const adapter = createAgentMessageAdapter({
      model: effectiveDisplayModel,
      tools: allToolNames,
      sessionId,
      cwd: cwd ?? params.cwd,
      permissionMode: (params.permissionMode ?? 'default') as Parameters<typeof createAgentMessageAdapter>[0]['permissionMode'],
      contextWindow: executionLimits.contextWindow,
      maxOutputTokens: executionLimits.maxOutputTokens,
    });

    yield adapter.createInitMessage();

    const channel = new AsyncChannel<AgentMessage>();
    const taskStore: RebelCoreTaskStoreInternal = createTaskStore();
    let effectiveSystemPrompt = systemPrompt;

    const emitEvent = (event: RebelCoreEvent) => {
      // Log to transcript (skip streaming deltas — full content is in assistant:message)
      if (event.type !== 'assistant:text' && event.type !== 'assistant:thinking') {
        logCore(event);
      }
      const sdkMessages = adapter.handleEvent(event);
      for (const msg of sdkMessages) {
        channel.push(msg);
      }
    };

    if (sessionId) {
      const { recoveredCount } = await loadTaskBoard(sessionId, taskStore);
      if (recoveredCount > 0) {
        emitEvent({
          type: 'status',
          message: `task:recovery:orphans-marked:${JSON.stringify({ count: recoveredCount })}`,
        });
      }
    }

    // Archive previous turn's tasks — current turn starts with a clean store.
    // No-op when empty (first turn or fresh session).
    const priorTaskCount = taskStore.listTasks().length;
    taskStore.archiveTurn();
    if (priorTaskCount > 0) {
      log.info({ archivedTaskCount: priorTaskCount, sessionId }, 'Archived previous turn tasks into history');
    }

    // Emit user-visible warning when MCP tools are unavailable
    if (superMcpUrl && mcpToolDefs.length === 0) {
      emitEvent({
        type: 'warning',
        category: 'mcp',
        message: "I couldn't connect to your apps and tools for this turn. Try Settings → Advanced.",
      });
    }

    // Resolve thinking config per model (env override > per-model effort > global)
    const planModel = effectivePlanningModel || effectiveExecutionModel;
    const execModel = effectiveExecutionModel;
    const modelEfforts = getModelEfforts(settings);
    const globalEffort = getGlobalThinkingEffort(settings);
    const planningEffort = resolveReasoningEffort({
      envEffort: params.env?.CLAUDE_CODE_EFFORT_LEVEL,
      modelId: planModel,
      modelEfforts,
      globalEffort,
    });
    const executionEffortSetting = resolveReasoningEffort({
      envEffort: params.env?.CLAUDE_CODE_EFFORT_LEVEL,
      modelId: execModel,
      modelEfforts,
      globalEffort,
    });
    const planningThinking = resolveThinkingConfig(
      planningEffort,
      planModel,
      planningLimits.maxOutputTokens,
    );
    const executionThinking = resolveThinkingConfig(
      executionEffortSetting,
      execModel,
      executionLimits.maxOutputTokens,
    );
    const executionEffort = resolveEffortForApi(executionEffortSetting, execModel);
    // Stage 5: the co-varying parent-execution facts (model, client, profile id,
    // profile, limits, effort, thinking, supportsReasoningReplay) are no longer
    // independent `let active*` variables — they live in ONE state object behind
    // a sole-writer holder. The old piecemeal `activeExecutionModel = …` /
    // `activeExecutionProfileId = …` writes at the two writer sites (initial
    // default-routing + switch application) are replaced by a single
    // `activeExecution.commit({ …full state… }, liveAgentLoop, agentCtx)` — TS
    // forces every field to be supplied, so a partial update cannot compile.
    // Reads go through `activeExecution.current.<field>` (read-only view).
    // `activeProfile?.id` seeds `profileId`; `activeProfile` itself is NOT carried
    // as `profile` because it may name the working model while the seeded `model`
    // is `effectiveExecutionModel` (they agree at turn start, but the working
    // profile can describe a different model in edge configs) — the pairing
    // invariant would reject a mismatch. We carry `undefined` and let the
    // default-routing block supply the paired routed profile.
    const activeExecution = createActiveExecutionStateHolder({
      model: effectiveExecutionModel,
      client: executionClient,
      profileId: activeProfile?.id ?? null,
      profile: undefined,
      limits: executionLimits,
      effort: executionEffort,
      thinking: executionThinking,
      supportsReasoningReplay: initialSupportsReasoningReplay,
    });
    let routedProfileName: string | undefined;
    let planRouting: import('./planningMode').RoutingDecision | undefined;
    let planSteps: PlanningStep[] | undefined;
    let stepIdToTaskIdMap = new Map<string, string>();
    let modelSwitchSchedule: ModelSwitch[] = [];
    // Stable reference held by the agent-tool callback closure. Mutate in place
    // only through taskRoutingMetadataWriter — never reassign — so sub-agent
    // metadata writes from agentCtx.onTaskRoutingMetadataUpdate land on the same
    // object the emit site reads without reintroducing a second badge writer.
    const taskRoutingMetadata: Record<string, TaskRoutingMetadata> = {};
    const taskRoutingMetadataWriter = createTaskRoutingMetadataWriter(taskRoutingMetadata);
    // Canonical plan-time PARENT-route metadata projection (the exact entries
    // buildTaskRoutingMetadata produced, sub-agent overlay INCLUDED). On a failed
    // switch we transiently rewrite affected badges to the still-running model; on
    // a later successful RETRY we restore from THIS snapshot so the badge tracks
    // execution again — re-deriving from the projection rather than blind-writing
    // the switch target keeps the parent-route / sub-agent-overlay split intact
    // (a sub-agent step with a per-step model keeps its overlay model).
    const canonicalTaskRoutingMetadata: Record<string, TaskRoutingMetadata> = {};
    // PARENT-route model per taskId, straight from the compiler — the source of
    // truth for switch correction/restore. The displayed `taskRoutingMetadata`
    // `.model` is NOT this for a sub-agent task (it shows the child/overlay model),
    // so switch correction must key on THIS map, never the display field, and must
    // never touch a sub-agent-overlaid badge (sub-agent badges are OUTSIDE
    // parent-execution parity — Stage-1 invariant).
    const parentRouteModelByTaskId = new Map<string, RoutingModelId>();
    // Tasks whose badge was failure-corrected away from canonical. A successful
    // switch restores ONLY these (closes the over-rewrite edge, Claude-F8) and
    // clears them once restored. Only ever contains NON-sub-agent (parent-route)
    // tasks by construction.
    const failureCorrectedTaskIds = new Set<string>();

    if (runtimeModels.isPlanMode && effectivePlanningModel) {
      if (settings.experimental?.adaptiveRoutingEnabled && context.perConversationModelOverride) {
        log.info(
          {
            adaptiveRoutingEnabled: true,
            skipReason: 'per-conversation-model-override',
            overrideModel: context.executionModelOverride || effectiveExecutionModel,
          },
          'Smart picking skipped: per-conversation override active',
        );
      }
      log.info({
        routingEligibleCount: getFunctionalRoutingProfiles(settings, context.connectivity).length,
        councilEnabledCount: getFunctionalCouncilProfiles(settings, context.connectivity).length,
        profilesEnabledCount: settings.localModel?.profiles?.filter((profile) => profile.enabled !== false).length ?? 0,
        workingProfileId: getWorkingModelProfile(settings)?.id ?? null,
        adaptiveRoutingEnabled: !!settings.experimental?.adaptiveRoutingEnabled,
        perConversationModelOverride: !!context.perConversationModelOverride,
      }, 'Planning start: settings snapshot');
      const routingEligible = (
        settings.experimental?.adaptiveRoutingEnabled
        && !context.perConversationModelOverride
      )
        ? getFunctionalRoutingProfiles(settings, context.connectivity)
        : [];
      // Build routing catalog: routing-eligible profiles + the working model (always included
      // so the planner can reference it — it's the default/fallback and must be valid in routing).
      // Pure assembly + the `>=2`-models gate live in `buildPlanningRoutingPool`
      // (planningMode.ts) so the logic is unit-testable and future pool filters
      // (per-conversation allow-list, provider enable/disable/priority) land there
      // as localized changes rather than as hot-path surgery here.
      const { profileEntries, routingContext } = buildPlanningRoutingPool({
        routingEligibleProfiles: routingEligible,
        workingModel: effectiveExecutionModel,
        workingReasoningSuppressed: activeProfile ? shouldSuppressProfileReasoning(activeProfile) : false,
        workingCostTier: activeProfile?.costTier,
        workingReasoningEffort: executionEffortSetting,
        workingContextWindow: executionLimits.contextWindow,
        availableAgents: Object.keys(agents),
      });

      // Observability for the common "why didn't smart picking engage?" question:
      // adaptive routing was on, but the eligible pool collapsed to <2 models, so
      // routing is skipped. Diagnosable without changing control flow.
      if (
        settings.experimental?.adaptiveRoutingEnabled
        && !context.perConversationModelOverride
        && !routingContext
      ) {
        log.info(
          { eligibleCount: profileEntries.length, workingModel: effectiveExecutionModel },
          'Adaptive routing enabled but <2 eligible models — routing skipped',
        );
      }

      emitEvent({ type: 'status', message: 'Planning approach...' });
      const plan = await runPlanningPhase({
        client: effectivePlanningClient,
        planningModel: effectivePlanningModel,
        systemPrompt,
        messages,
        thinking: planningThinking,
        maxTokens: planningLimits.maxOutputTokens,
        signal,
        onThinkingDelta: (text: string) => emitEvent({ type: 'assistant:thinking', thinking: text }),
        // Plan text is internal — consumed by the execution phase system prompt,
        // not shown to the user. Omit onTextDelta to prevent plan JSON from
        // streaming into the conversation and accumulating in the final result.
        routingContext,
        onRetry: (retryInfo) => {
          logProviderRetryTelemetry(retryInfo, 'planner');
          const { attempt, maxRetries, provider } = retryInfo;
          const retryStatusMessage = getRetryStatusMessage(attempt, maxRetries, provider);
          if (retryStatusMessage) {
            emitEvent({ type: 'status', message: retryStatusMessage });
          }
        },
      });

      // Direct-answer escape hatch: planner answered from context — skip execution phase
      if (plan.directAnswer) {
        log.info(
          { confidence: plan.directAnswer.confidence, model: plan.model, reasoning: plan.directAnswer.reasoning },
          'Planning model returned direct answer — skipping execution phase',
        );

        // Emit turn:complete for the planning phase (usage tracking)
        emitEvent({
          type: 'turn:complete',
          usage: plan.usage,
          stopReason: plan.stopReason,
          model: plan.model ?? effectivePlanningModel,
        });

        // Stream the answer
        emitEvent({ type: 'assistant:text', text: plan.directAnswer.answer });

        // Transcript: capture direct-answer (assistant:text is skipped by logCore)
        logSynthetic('direct-answer', { answer: plan.directAnswer.answer, confidence: plan.directAnswer.confidence });

        // Emit loop:complete to produce the final result AgentMessage
        emitEvent({ type: 'loop:complete', totalUsage: plan.usage });

        // Save task board (empty active store is correct)
        try { if (sessionId) await saveTaskBoard(sessionId, taskStore); } catch { /* best effort */ }

        channel.finish();
        yield* channel;
        return;
      }

      // Store routing decision for execution phase.
      planRouting = plan.routing;
      planSteps = plan.document?.steps;
      if (planRouting) {
        log.info({ planRouting }, 'Plan includes adaptive routing decision');
      }

      // Apply adaptive routing — switch execution client if plan routes to a different model.
      const routingDecision = planRouting;
      if (routingDecision && settings.experimental?.adaptiveRoutingEnabled) {
        const routingProfiles = getFunctionalRoutingProfiles(settings, context.connectivity);
        const resolvedDefaultRoute = resolvePlannerModelAgainstRoutingPool(
          routingDecision.default_model,
          effectiveExecutionModel,
          routingProfiles,
        );
        const isProfileRefRoute = isProfileReference(routingDecision.default_model);
        // routeRef (Stage A): an explicit `profile:<id>` that resolved to a real profile is a
        // provider-bound target. It must be applied even when its model string EQUALS the
        // working model — the same-model cross-provider switch (two providers offering one
        // model id) is the whole point of route refs. Only bare/working refs keep the
        // "stay on the working client" optimisation.
        const hasExplicitProfileRoute = isProfileRefRoute && !!resolvedDefaultRoute?.profile;
        const isWorkingModel =
          !hasExplicitProfileRoute && resolvedDefaultRoute?.model === effectiveExecutionModel;
        let routedProfile: ModelProfile | undefined;
        if (!isWorkingModel && resolvedDefaultRoute) {
          if (isProfileRefRoute) {
            // Honour the exact profile `resolvePlannerModelAgainstRoutingPool` resolved by id,
            // rather than re-deriving by bare-model first-match (which collapses two profiles
            // that share a model id).
            routedProfile = resolvedDefaultRoute.profile;
          } else {
            // Legacy bare-model reference: first selectable match wins (unchanged).
            const candidates = routingProfiles.filter(
              p => p.model === routingDecision.default_model
                && isProfileSelectable(p),
            );
            if (candidates.length > 1) {
              log.warn(
                { model: routingDecision.default_model, count: candidates.length },
                'Adaptive routing: multiple profiles match routed model — using first match (emit a profile:<id> route ref to disambiguate)',
              );
            }
            routedProfile = candidates[0];
          }
        }

        if (isWorkingModel || resolvedDefaultRoute?.model) {
          const targetModel = isWorkingModel ? effectiveExecutionModel : resolvedDefaultRoute!.model;
          // A same-model route still needs a fresh client when it targets a DIFFERENT profile
          // (different provider / credentials / serverUrl), so an explicit profile route is
          // never treated as "same model" for the keep-existing-client shortcut.
          const isSameModel = !hasExplicitProfileRoute && targetModel === effectiveExecutionModel;
          const routedEffortSetting = (routingDecision.default_effort ?? (isWorkingModel ? executionEffortSetting : routedProfile?.reasoningEffort)) as ThinkingEffort | undefined;
          const routedLimits = isWorkingModel
            ? executionLimits
            : resolveModelLimits({
                model: targetModel,
                profileMaxOutput: routedProfile?.maxOutputTokens,
                profileMaxOutputSource: routedProfile?.outputTokensSource,
                profileContextWindow: routedProfile?.contextWindow,
                profileContextWindowSource: routedProfile?.contextWindowSource,
                allProfiles: settings.localModel?.profiles ?? [],
              });
          let routingApplied = true;
          // The new execution client for a cross-model route. On `isSameModel`
          // (working-model default) we keep the existing client; on a failed
          // build we fall back to it. `routedClient` is then folded into ONE
          // atomic state commit below (the sole-writer boundary) instead of the
          // old piecemeal `activeExecution* = …` writes.
          let routedClient = activeExecution.current.client;

          if (!isSameModel) {
            try {
              routedClient = await createClientForModel({
                model: targetModel,
                profile: routedProfile,
                settings,
                proxyConfig,
                context: 'routed-execution',
                codexMode: context.codexMode,
              });
            } catch (routingErr) {
              if (routingErr instanceof ConnectionNotConfiguredError) {
                throw routingErr;
              }
              log.warn(
                { model: routingDecision.default_model, error: String(routingErr) },
                'Adaptive routing: failed to create routed client — falling back to default',
              );
              routingApplied = false;
            }
          }

          if (routingApplied) {
            routedProfileName = isWorkingModel ? effectiveExecutionModel : routedProfile!.name;
            // The profile that PRODUCED this route, carried only when it names
            // the routed model (invariant: profile.model === model). For the
            // working-model default we keep the seeded working profile id but do
            // not carry a possibly-mismatched profile object.
            const routedProfileId = isWorkingModel
              ? activeProfile?.id ?? null
              : routedProfile?.id ?? null;
            const pairedProfile = pairedExecutionProfile(
              isWorkingModel ? activeProfile : routedProfile,
              targetModel,
            );
            // SOLE-WRITER commit: model/client/profileId/profile/limits/effort/
            // thinking/replay all replaced together. No liveAgentLoop / agentCtx
            // exist yet at this pre-loop point (null, null) — the first
            // agentLoopConfig build + agentCtx construction read the committed
            // state directly.
            activeExecution.commit(
              {
                model: targetModel,
                client: routedClient,
                profileId: routedProfileId,
                profile: pairedProfile,
                limits: routedLimits,
                effort: resolveEffortForApi(routedEffortSetting, targetModel),
                thinking: resolveThinkingConfig(
                  routedEffortSetting,
                  targetModel,
                  routedLimits.maxOutputTokens,
                ),
                supportsReasoningReplay: computeSupportsReasoningReplay(
                  isWorkingModel ? activeProfile : routedProfile,
                  targetModel,
                ),
              },
              null,
              null,
            );

            log.info(
              { routedModel: activeExecution.current.model, routedEffort: routedEffortSetting, profileName: routedProfileName, sameModel: isSameModel },
              'Adaptive routing: applied routing decision',
            );
            if (!isSameModel) {
              emitEvent({ type: 'status', message: `Routing to ${routedProfileName}` });
              // Keep the turn registry coupled to the sole-writer execution model so
              // buildModelRoles() binds the working role to the routed model rather than the
              // configured alias (FOX-3436 same-class kill). Skip on isSameModel no-ops and when
              // no real turn id is present (eval path uses a random UUID → harmless to skip).
              if (context.turnId) {
                agentTurnRegistry.setTurnModel(context.turnId, targetModel);
              }
            }
          }
        }
      }

      const seededTasks = seedTaskStoreFromPlan(plan.planText, taskStore);
      stepIdToTaskIdMap = seededTasks.stepIdToTaskIdMap;
      const derivedParallelGroups = derivePlanParallelGroups(planSteps);
      const validParallelGroupIds = new Set(derivedParallelGroups.keys());
      const parallelGroupSummaries = Array.from(derivedParallelGroups.entries()).map(
        ([groupId, memberStepIds]) => ({
          groupId,
          memberStepIds,
          memberTaskIds: memberStepIds.flatMap((stepId) => {
            const taskId = stepIdToTaskIdMap.get(stepId);
            return taskId ? [taskId] : [];
          }),
        }),
      );
      if (parallelGroupSummaries.length > 0) {
        const totalMembers = parallelGroupSummaries.reduce(
          (sum, group) => sum + group.memberStepIds.length,
          0,
        );
        log.info(
          {
            turnId: transcriptTurnId,
            groups: parallelGroupSummaries,
            totalMembers,
            cap: PARALLEL_AGENT_CAP,
          },
          'parallel-groups: detected post-seeding',
        );
      }

      // Always populate baseline model metadata so every planning step shows
      // the execution model badge — even without adaptive routing.
      for (const [, taskId] of stepIdToTaskIdMap) {
        taskRoutingMetadataWriter.setParentRouteBadge({
          taskId,
          parentRouteModel: activeExecution.current.model,
          effort: undefined,
        });
      }

      if (planRouting && settings.experimental?.adaptiveRoutingEnabled) {
        const routingProfiles = getFunctionalRoutingProfiles(settings, context.connectivity);
        const planDefaultEffort = planRouting.default_effort as ThinkingEffort | undefined;
        // Working-route profile for the compiler (F2): so a switch BACK to the
        // default route restores the correct profile id + limits instead of
        // reconstructing the default by bare model string and dropping profile
        // telemetry. CRITICAL — it MUST describe the SAME target as
        // `activeExecution.current.model`: the planner's `routing.default_model` may have
        // re-pointed the turn default to a model different from the settings
        // working model (the default-routing block above mutates
        // activeExecution.current.model + activeExecution.current.profileId, but NOT the original
        // `activeProfile`). So we source the working profile from the CURRENT
        // active execution profile (id === activeExecution.current.profileId) and pass it
        // ONLY when its `.model` matches `activeExecution.current.model`. A mismatched
        // model/profile pair would make a back-switch build a client for the
        // profile's OWN model (explicit profile wins in providerRouting) while
        // routing:model: claims the routed default — the exact divergence this
        // refactor kills. Mismatch (or no profile) → undefined: createClientForModel
        // re-resolves by bare model string (the pre-F2 behaviour), never a lie.
        const activeWorkingProfile = (() => {
          if (!activeExecution.current.profileId) return undefined;
          const candidate = settings.localModel?.profiles?.find(
            (p) => p.id === activeExecution.current.profileId,
          );
          return candidate?.model === activeExecution.current.model ? candidate : undefined;
        })();
        // Compile the plan into parent-execution effective routes ONCE here. Both
        // the switch schedule AND the parent-route portion of the UI metadata are
        // pure projections of this single output, so they cannot diverge by
        // construction AND the compiler's diagnostics (unresolved-ref /
        // group-conflict logs) emit exactly once. The sub-agent overlay is layered
        // on top of the metadata projection inside buildTaskRoutingMetadata
        // (planner fields) and later via the runtime onTaskRoutingMetadataUpdate
        // stamp — both UNCHANGED.
        const compiledRoutes = planSteps
          ? compileStepRoutes({
              routing: planRouting,
              steps: planSteps,
              stepIdToTaskIdMap,
              routingPool: routingProfiles,
              workingRoute: {
                model: activeExecution.current.model,
                effort: planDefaultEffort,
                ...(activeWorkingProfile ? { profile: activeWorkingProfile } : {}),
              },
              parallelGroups: derivedParallelGroups,
            })
          : [];
        const plannedTaskRoutingMetadata = buildTaskRoutingMetadata(
          compiledRoutes,
          planSteps,
          stepIdToTaskIdMap,
          planRouting,
        );
        taskRoutingMetadataWriter.applyPlanProjection(compiledRoutes, plannedTaskRoutingMetadata);
        // Snapshot the canonical parent-route projection so a successful retry
        // after a failed switch can restore the affected badges (see
        // canonicalTaskRoutingMetadata declaration).
        Object.assign(canonicalTaskRoutingMetadata, plannedTaskRoutingMetadata);
        // Record the PARENT-route model per task (NOT the displayed/overlay model)
        // so switch correction/restore keys on parent-route identity.
        for (const route of compiledRoutes) {
          parentRouteModelByTaskId.set(route.taskId, route.model);
        }
        // The schedule emits a switch on EVERY parent-route change (incl.
        // back-to-default on sparse overrides) and merges escalation in — no
        // mutually-exclusive per-step-vs-escalation branch. Escalation `to_model`
        // stays executable by decoded id even when no profile matches (the
        // profile is optional metadata), per the compiler's policy.
        modelSwitchSchedule = buildModelSwitchSchedule(
          compiledRoutes,
          activeExecution.current.model,
          planDefaultEffort,
          // Baseline profile identity for the first-step comparison: the working
          // route's profile (dropped by the compiler if its model mismatches).
          activeWorkingProfile && activeWorkingProfile.model === activeExecution.current.model
            ? activeWorkingProfile.id
            : null,
        );

        if (modelSwitchSchedule.length > 0) {
          log.info(
            {
              switches: modelSwitchSchedule.map((sw) => ({
                stepId: sw.stepId,
                taskId: sw.taskId,
                fallbackIterationThreshold: sw.fallbackIterationThreshold,
                toModel: sw.toModel,
                toEffort: sw.toEffort,
              })),
            },
            'Adaptive routing: initialized model switch schedule',
          );
        }
      }
      const parallelGroupsForPrompt = Array.from(derivedParallelGroups.entries()).map(
        ([groupId, memberStepIds]) => {
          const memberStepIdSet = new Set(memberStepIds);
          const memberSteps = planSteps?.filter((step) => step.id && memberStepIdSet.has(step.id)) ?? [];
          const suggestedTools = Array.from(new Set(memberSteps.flatMap((step) => step.suggested_tools ?? [])));

          return {
            groupId,
            memberStepIds,
            suggestedTools,
          };
        },
      );
      const sanitizedPlanText = sanitizePlanTextForExecution(plan.planText, validParallelGroupIds);

      effectiveSystemPrompt = buildExecutionSystemPrompt(
        systemPrompt,
        sanitizedPlanText,
        effectivePlanningModel,
        seededTasks.seededTasksText ?? undefined,
        planRouting && routedProfileName ? {
          model: activeExecution.current.model,
          profileName: routedProfileName,
          escalation: planRouting.escalation ? {
            atStep: planRouting.escalation.at_step,
            toModel: planRouting.escalation.to_model,
            reason: planRouting.escalation.reason,
          } : undefined,
        } : undefined,
        parallelGroupsForPrompt,
      );

      emitEvent({
        type: 'turn:complete',
        usage: plan.usage,
        stopReason: plan.stopReason,
        model: plan.model ?? effectivePlanningModel,
      });

      // Emit synthetic MissionSet + TaskList events so the renderer can display
      // mission context and task checklist immediately after planning completes.
      if (seededTasks.seededCount > 0) {
        const syntheticMsgs = buildSyntheticPlanSeedMessages(adapter, taskStore);
        for (const msg of syntheticMsgs) channel.push(msg);
        // Transcript: plan-seed synthetic
        logSynthetic('plan-seed', { taskCount: seededTasks.seededCount });
      }
    }

    // Seed mission context from user prompt in non-plan mode (if not already set).
    // Emits a synthetic MissionSet event so the renderer can display the mission/goal card.
    // In plan mode, buildSyntheticPlanSeedMessages() handles this after planning completes.
    if (!runtimeModels.isPlanMode && !hasMissionGoalTask(taskStore) && messages.length > 0) {
      const firstMessage = messages[0];
      if (firstMessage?.role === 'user' && typeof firstMessage.content === 'string' && firstMessage.content.trim()) {
        seedMissionGoalTask(taskStore, firstMessage.content.slice(0, 500));
        const missionContext = extractMissionContext(taskStore.listTasks());
        if (missionContext.goal) {
          const missionInput = {
            goal: missionContext.goal,
            ...(missionContext.done_criteria ? { done_criteria: missionContext.done_criteria } : {}),
            ...(missionContext.constraints ? { constraints: missionContext.constraints } : {}),
          };
          const missionOutput = JSON.stringify({
            summary: `Mission context updated (goal)`,
            mission: missionContext,
          }, null, 2);
          const msgs = adapter.createSyntheticToolCallPair(
            'MissionSet', randomUUID(), missionInput, missionOutput, false, 'synthetic-plan-seed',
          );
          for (const msg of msgs) channel.push(msg);
          // Transcript: mission-seed synthetic (non-plan mode)
          logSynthetic('mission-seed', { goal: missionContext.goal });
        }
      }
    }

    const hookContext = { signal, sessionId, transcriptPath: (transcriptEnabled && transcriptSessionId) ? getTranscriptPath(transcriptSessionId) : '', cwd: cwd ?? params.cwd, permissionMode: params.permissionMode };
    const mainScopedStore = createScopedTaskStore(taskStore, 'main', 0);

    // Per-turn rate limit counters, shared with sub-agents via context propagation.
    // Drives WebSearch/WebFetch rate limits and the per-task Sentry dedupe WeakMaps
    // in those tools. Must be a fresh Map per turn so counters reset between turns
    // and sub-agents can dedupe against the same task-scoped Map as the parent.
    // Routed through a named factory so tests can spy on it to prove this wiring
    // is actually invoked — the original bug was that the Map was documented in
    // the plan but never created at runtime.
    // See docs-private/postmortems/260421_websearch_ddg_captcha_postmortem.md.
    const rateLimitState = createPerTurnRateLimitState();
    const consumedAssignments = new Set<string>();
    const visualVerificationNavigationState = {};

    // Space symlink targets: spaces configured as symlinks have a sourcePath
    // pointing to an external folder (e.g. Google Drive). These must be
    // treated as trusted zones so verifyNoSymlinkEscape doesn't reject
    // reads/writes through those symlinks.
    //
    // The bundled rebel-system directory is also added when present:
    // `<workspace>/rebel-system/` is a system-managed symlink (created by
    // createLibrarySymlink in systemSettingsSync.ts) pointing to either the
    // dev submodule clone or `process.resourcesPath/rebel-system` in prod.
    // Without this entry, every Read/Edit through the canonical workspace
    // path (e.g. SKILL.md, AGENTS.md, bundled prompts) is rejected by
    // verifyNoSymlinkEscape. See the contribution-flow self-block follow-up
    // (docs/plans/260427_contribution_flow_followon_self_block_at_registration.md).
    const allowedSymlinkTargets = getAllowedSymlinkTargets(settings, {
      ...(context.rebelSystemRoot ? { rebelSystemRoot: context.rebelSystemRoot } : {}),
    });

    const executionCodexConnectivity = proxyConfig?.defaultHeaders?.['x-codex-turn'] === 'true'
      ? 'connected'
      : 'unknown';
    const toolContext: BuiltinToolContext = {
      ...(transcriptSessionId ? { sessionId: transcriptSessionId } : {}),
      currentTurnId: transcriptTurnId,
      surfaceCapability,
      wasExplicitCouncilIntent: context.wasExplicitCouncilIntent ?? false,
      cwd: cwd ?? params.cwd,
      ...(context.homePath ? { homePath: context.homePath } : {}),
      ...(context.userDataPath ? { userDataPath: context.userDataPath } : {}),
      ...(allowedSymlinkTargets.length > 0 ? { allowedSymlinkTargets } : {}),
      signal,
      taskStore: mainScopedStore,
      taskStoreInternal: taskStore,
      agentNamespace: 'main',
      depth: 0,
      getExecutionRoute: () => ({
        model: activeExecution.current.model,
        profileId: activeExecution.current.profileId,
        ...(activeExecution.current.effort ? { effort: activeExecution.current.effort } : {}),
        codexConnectivity: executionCodexConnectivity,
      }),
      pluginService: getBuiltinPluginService(),
      executeMcpTool: mcpSession ? (name: string, input: unknown) => mcpSession.executeTool(name, input) : null,
      captureRebelWindow: context.captureRebelWindow ?? undefined,
      navigateApp: context.navigateApp ?? undefined,
      visualVerificationNavigationState,
      onFileChanged: context.onFileChanged,
      rateLimitState,
      ...(transcriptSessionId ? {
        imageAssetContext: {
          sessionId: transcriptSessionId,
          turnId: transcriptTurnId,
          nextToolResultEventSeq,
          surface: imageAssetSurface,
        },
      } : {}),
    };

    // Agent tool context (only built if agents are defined)
    const agentCtx: AgentToolContext | null = hasAgents ? {
      agents,
      client: activeExecution.current.client,
      settings,
      parentModel: activeExecution.current.model,
      parentMaxTokens: activeExecution.current.limits.maxOutputTokens,
      ...(activeExecution.current.effort ? { parentEffort: activeExecution.current.effort } : {}),
      ...(planRouting ? { planRouting } : {}),
      ...(planSteps ? { planSteps } : {}),
      consumedAssignments,
      ...(proxyConfig ? { proxyConfig } : {}),
      turnId: transcriptTurnId,
      codexConnectivity: executionCodexConnectivity,
      // Thread the parent-turn connection-liveness snapshot so a planner-assigned
      // sub-agent model is gated on the same routing-pool connectivity the parent
      // execution path uses (see resolveAssignedSubAgentProfile).
      ...(context.connectivity ? { connectivity: context.connectivity } : {}),
      cwd: cwd ?? params.cwd,
      ...(context.homePath ? { homePath: context.homePath } : {}),
      ...(context.userDataPath ? { userDataPath: context.userDataPath } : {}),
      ...(allowedSymlinkTargets.length > 0 ? { allowedSymlinkTargets } : {}),
      signal,
      hooks,
      hookContext,
      mcpSession,
      mcpToolDefs: mcpToolDefs.map((t) => t.tool),
      captureRebelWindow: context.captureRebelWindow ?? undefined,
      navigateApp: context.navigateApp ?? undefined,
      visualVerificationNavigationState,
      depth: 0,
      agentNamespace: 'main',
      taskStoreInternal: taskStore,
      ...(suppressedSet.size > 0 ? { suppressedBuiltins: params.suppressedBuiltins } : {}),
      rateLimitState,
      ...(context.codexMode ? { codexMode: context.codexMode } : {}),
      transcriptSessionId: transcriptSessionId ?? undefined,
      transcriptTurnId: transcriptTurnId,
      transcriptSeqCounter: seqCounter,
      nextToolResultEventSeq,
      imageAssetSurface,
      surfaceCapability,
      wasExplicitCouncilIntent: context.wasExplicitCouncilIntent ?? false,
      onSubAgentEvent: (event, parentToolUseId) => {
        const msgs = event.type === 'status'
          ? adapter.handleEvent(event)
          : adapter.handleSubAgentEvent(event, parentToolUseId);
        for (const msg of msgs) {
          channel.push(msg);
        }
      },
      onSubAgentComplete: (usageByModel) => {
        for (const [subModel, usage] of usageByModel) {
          adapter.mergeSubAgentUsage(subModel, usage);
        }
      },
      onTaskRoutingMetadataUpdate: (taskId, info) => {
        taskRoutingMetadataWriter.setSubAgentOverlay({
          taskId,
          parentRouteModel: parentRouteModelByTaskId.get(taskId) ?? activeExecution.current.model,
          effort: undefined,
        }, info);
      },
      onFileChanged: context.onFileChanged,
    } : null;

    const baseExecuteTool = async (
      toolName: string,
      input: unknown,
      _toolUseId: string,
      toolSignal: AbortSignal,
    ) => {
      const toolContextWithSignal: BuiltinToolContext = { ...toolContext, signal: toolSignal };

      // Agent/Task tool — delegate to sub-agent
      if ((toolName === 'Agent' || toolName === 'Task') && agentCtx) {
        return executeAgentTool(input, { ...agentCtx, signal: toolSignal }, _toolUseId);
      }
      if (hasRegisteredTool(toolName)) {
        return executeRegisteredTool(toolName, input, toolContextWithSignal);
      }
      if (isBuiltinToolName(toolName)) {
        return executeBuiltinTool(toolName, input, toolContextWithSignal);
      }
      if (isMcpToolName(toolName) && mcpSession) {
        return mcpSession.executeTool(toolName, input, _toolUseId, toolSignal);
      }
      return { output: `Unknown tool: ${toolName}`, isError: true };
    };

    const toolExecutor = createHookAwareToolExecutor(
      baseExecuteTool,
      hooks,
      hookContext,
    );

    const allTools = [
      ...builtinTools,
      ...mcpToolDefs.map((t) => t.tool),
      ...(hasAgents ? [buildAgentToolDefinition(agents)] : []),
      MISSION_SET_TOOL_DEFINITION,
      GET_PREVIOUS_TASKS_TOOL_DEFINITION,
    ].filter((t) => !suppressedSet.has(t.name as BuiltinToolName));

    const runWithStopHooks = async () => {
      const maxStopHookRetries = 3;
      const turnStartTime = Date.now();
      let currentMessages = messages;
      let lastResult: Awaited<ReturnType<typeof runAgentLoop>> | undefined;
      let betweenTurnIterationCount = 0;
      // Last-emitted routing:tasks: payload — replaces the prior "emit once per
      // turn" boolean gate. Re-emission is allowed whenever the metadata content
      // changes (new tasks created mid-turn via TaskCreate / MissionSet / Agent),
      // and the renderer's parseModelByTaskId picks the latest event via findLast.
      let lastEmittedTaskRoutingHash: string | null = null;

      // Fill in baseline routing metadata for every task in the store that
      // doesn't have one yet, using the active execution model. Covers tasks
      // created mid-turn outside the planner: TaskCreate, MissionSet, and the
      // Agent tool's delegation tracking task before its sub-agent stamp lands.
      const syncBaselineRoutingMetadata = () => {
        mergeBaselineRoutingModel(
          taskRoutingMetadata,
          taskStore.listTasks().map((t) => t.id),
          activeExecution.current.model,
        );
      };

      // Sync + emit routing:tasks: when content changed since the last emit.
      // Called both BEFORE runAgentLoop (so the renderer sees baseline + plan
      // routing immediately) AND AFTER runAgentLoop returns (so tool-created
      // tasks — TaskCreate, MissionSet, Agent delegation — also surface).
      const maybeEmitTaskRoutingMetadata = () => {
        syncBaselineRoutingMetadata();
        if (Object.keys(taskRoutingMetadata).length === 0) return;
        const taskRoutingPayload = JSON.stringify(taskRoutingMetadata);
        if (taskRoutingPayload === lastEmittedTaskRoutingHash) return;
        lastEmittedTaskRoutingHash = taskRoutingPayload;
        emitEvent({
          type: 'status',
          message: `routing:tasks:${taskRoutingPayload}`,
        });
      };

      // Live agent-loop config/opts handle, set inside the attempt loop so a
      // mid-turn switch (betweenTurns) updates the in-flight loop config too. Null
      // during the pre-loop pass (no loop config exists yet) — there, the
      // committed active state is what the first agentLoopConfig build picks up.
      // `activeExecution.commit` derives this handle's config/opts from the
      // committed state (sole-writer), so the in-flight loop cannot diverge.
      let liveAgentLoop: LiveAgentLoopHandle | null = null;

      // Switch-application: applies every DUE, untriggered model switch in the
      // schedule. Extracted so it runs BOTH once pre-loop (any switch whose task
      // is already in_progress/completed at turn start — fixes the first-step
      // timing gap where the seeded-in_progress first task previously had to wait
      // a full iteration) AND from betweenTurns. Task-store-driven; `triggered`
      // guards against double-apply. On a `createClientForModel` failure the
      // switch is NOT marked triggered, execution stays on the prior model, and
      // the failure is logged AND the task badge is corrected so the
      // routing:tasks: snapshot never advertises a model execution never ran on
      // (GPT-F3 parity invariant).
      const applyDueModelSwitches = async (): Promise<void> => {
        for (const modelSwitch of modelSwitchSchedule) {
          if (modelSwitch.triggered) continue;

          const reachedByTaskStore = checkModelSwitchCondition(modelSwitch, taskStore);
          const reachedByIteration = !reachedByTaskStore
            && modelSwitch.fallbackIterationThreshold !== null
            && betweenTurnIterationCount >= modelSwitch.fallbackIterationThreshold;

          if (!reachedByTaskStore && !reachedByIteration) continue;

          const current = activeExecution.current;
          const fromModel = current.model;
          // routeRef (route-identity): an effort-only switch keeps the live
          // client/profile. A same-model switch that names an EXPLICIT, different
          // profile (the `profile:<id>` contract) carries a different
          // provider/credential, so it must rebuild the client like a model switch.
          // BUT a switch with NO resolved profile (`toProfile == null` — a bare
          // effort escalation or a decode-to-itself escalation) is
          // profile-agnostic: rebuilding it would make `createClientForModel` fall
          // back to "first enabled profile for the bare model", needlessly
          // cold-starting (or crossing providers). So null-profile same-model
          // switches stay effort-only and keep the current client (Codex review).
          const isEffortOnlySwitch =
            modelSwitch.toModel === fromModel
            && (modelSwitch.toProfile == null
              || (modelSwitch.toProfile.id ?? null) === current.profileId);
          const switchedLimits = isEffortOnlySwitch
            ? current.limits
            : resolveModelLimits({
                model: modelSwitch.toModel,
                profileMaxOutput: modelSwitch.toProfile?.maxOutputTokens,
                profileMaxOutputSource: modelSwitch.toProfile?.outputTokensSource,
                profileContextWindow: modelSwitch.toProfile?.contextWindow,
                profileContextWindowSource: modelSwitch.toProfile?.contextWindowSource,
                allProfiles: settings.localModel?.profiles ?? [],
              });
          const switchedThinking = resolveThinkingConfig(
            modelSwitch.toEffort,
            modelSwitch.toModel,
            switchedLimits.maxOutputTokens,
          );
          const switchedEffort = resolveEffortForApi(
            modelSwitch.toEffort,
            modelSwitch.toModel,
          );

          // Build the FULL next execution state. For an effort-only switch the
          // model/client/profile carry over unchanged (only thinking/effort/limits
          // move); for a model switch they advance to the switch target. Either
          // way the SOLE-WRITER commit below replaces every field at once and
          // derives liveAgentLoop.config + agentCtx — no piecemeal `active* = …`.
          let nextState: ActiveExecutionState;
          if (isEffortOnlySwitch) {
            // Effort-only switch: no client construction can fail, so mark
            // triggered up-front.
            modelSwitch.triggered = true;
            nextState = {
              model: current.model,
              client: current.client,
              profileId: current.profileId,
              profile: current.profile,
              limits: switchedLimits,
              effort: switchedEffort,
              thinking: switchedThinking,
              supportsReasoningReplay: computeSupportsReasoningReplay(
                modelSwitch.toProfile,
                modelSwitch.toModel,
              ),
            };
            log.info(
              {
                stepId: modelSwitch.stepId,
                fromModel,
                toModel: modelSwitch.toModel,
                toEffort: modelSwitch.toEffort,
                reachedByTaskStore,
                reachedByIteration,
              },
              'Adaptive routing model switch triggered — updating execution effort',
            );
          } else {
            // Model switch: construct the client FIRST. Only mark triggered +
            // commit the new active state once construction succeeds, so a failure
            // leaves execution on the prior model AND leaves the switch eligible to
            // retry on a later iteration. A throw here is caught by the caller,
            // which logs the failure and corrects the task badge.
            const newClient = await createClientForModel({
              model: modelSwitch.toModel,
              ...(modelSwitch.toProfile ? { profile: modelSwitch.toProfile } : {}),
              settings,
              proxyConfig,
              context: 'escalated-execution',
              codexMode: context.codexMode,
            });
            modelSwitch.triggered = true;
            nextState = {
              model: modelSwitch.toModel,
              client: newClient,
              profileId: modelSwitch.toProfile?.id ?? null,
              profile: pairedExecutionProfile(modelSwitch.toProfile, modelSwitch.toModel),
              limits: switchedLimits,
              effort: switchedEffort,
              thinking: switchedThinking,
              supportsReasoningReplay: computeSupportsReasoningReplay(
                modelSwitch.toProfile,
                modelSwitch.toModel,
              ),
            };
            log.info(
              {
                stepId: modelSwitch.stepId,
                fromModel,
                toModel: modelSwitch.toModel,
                toEffort: modelSwitch.toEffort,
                reachedByTaskStore,
                reachedByIteration,
              },
              'Adaptive routing model switch triggered — switching execution model',
            );
          }

          // SOLE-WRITER: atomically replace active state and derive the in-flight
          // loop config + agent-tool parent context from that single state.
          activeExecution.commit(nextState, liveAgentLoop, agentCtx);

          // Keep the turn registry coupled to the sole-writer execution model on a real model
          // switch so buildModelRoles() binds the working role to the switched model (FOX-3436
          // same-class kill). Skip effort-only switches (isEffortOnlySwitch → model unchanged) and
          // the no-turn eval path (random UUID transcriptTurnId → harmless to skip).
          if (!isEffortOnlySwitch && context.turnId) {
            agentTurnRegistry.setTurnModel(context.turnId, modelSwitch.toModel);
          }

          emitEvent({ type: 'status', message: `routing:model:${modelSwitch.toModel}` });
          // Escalation copy ONLY for the one-way escalation switch; ordinary
          // per-step switches and switch-backs are neutral routing, not escalations.
          emitEvent({
            type: 'status',
            message: modelSwitch.isEscalation
              ? `Escalating to ${modelSwitch.toModel}`
              : `Routing to ${modelSwitch.toModel}`,
          });

          // Retry-after-failure badge restore: a prior failed switch may have
          // transiently rewritten PARENT-ROUTE task badges away from their
          // canonical parent route to the then-running model. Now that a model
          // switch SUCCEEDED, restore each corrected badge whose PARENT-route model
          // is the model we just switched TO (i.e. execution now actually runs that
          // task's intended model) — re-deriving from the canonical projection so
          // the sub-agent overlay is preserved. Badges whose parent route is some
          // OTHER still-unapplied target stay corrected to the running model (they
          // would otherwise lie). Keyed on parentRouteModelByTaskId, never the
          // display field; failureCorrectedTaskIds only ever holds non-sub-agent
          // tasks by construction, and we re-guard isSubAgent defensively. Re-emit
          // so the routing:tasks: snapshot tracks the live execution model again —
          // closing the fail-then-succeed stale-badge divergence.
          if (!isEffortOnlySwitch && failureCorrectedTaskIds.size > 0) {
            let restored = false;
            for (const taskId of Array.from(failureCorrectedTaskIds)) {
              const canonical = canonicalTaskRoutingMetadata[taskId];
              const parentRouteModel = parentRouteModelByTaskId.get(taskId);
              if (
                canonical
                && !canonical.isSubAgent
                && parentRouteModel === activeExecution.current.model
              ) {
                taskRoutingMetadataWriter.restoreCanonicalParentRouteBadge({
                  taskId,
                  parentRouteModel,
                  effort: canonical.effort,
                }, canonical);
                failureCorrectedTaskIds.delete(taskId);
                restored = true;
              }
            }
            if (restored) {
              log.info(
                { activeExecutionModel: activeExecution.current.model },
                'Adaptive routing: restored canonical task badges after a successful switch retry',
              );
              maybeEmitTaskRoutingMetadata();
            }
          }
        }
      };

      // Runs `applyDueModelSwitches`, translating a failed switch into observable,
      // never-silently-misleading degraded routing: the failure is logged AND any
      // task badge still advertising the unapplied target model is corrected to
      // the model execution is actually running on, then re-emitted. The
      // routing:tasks: snapshot and the active execution model therefore cannot
      // disagree silently (GPT-F3).
      const applyDueModelSwitchesObservably = async (): Promise<void> => {
        try {
          await applyDueModelSwitches();
        } catch (error) {
          if (error instanceof ConnectionNotConfiguredError) {
            throw error;
          }
          // best-effort: a learned-limits write failure must not mask the original error.
          void safeDispatchLearnedLimitsFromError(error, {
            turnId: transcriptTurnId,
            model: activeExecution.current.model,
            profileId: activeExecution.current.profileId,
          }, log);
          const pendingSwitches = modelSwitchSchedule.filter((sw) => !sw.triggered);
          log.warn(
            {
              err: error instanceof Error ? error.message : String(error),
              activeExecutionModel: activeExecution.current.model,
              pendingSwitches: pendingSwitches.map((sw) => ({
                stepId: sw.stepId,
                toModel: sw.toModel,
                toEffort: sw.toEffort,
              })),
            },
            'Adaptive routing model switch failed — continuing with current execution model',
          );
          // Badge correction: a switch is constructed before it is marked
          // triggered, so on failure no active* state advanced — but the
          // plan-time task metadata may already advertise the target model for
          // the failing (and any later) tasks. Rewrite every PARENT-ROUTE task
          // badge still claiming an unapplied (pending-switch) target to the model
          // execution is actually running on, so the snapshot cannot lie. Then
          // re-emit.
          //
          // CRITICAL (parent/overlay split, Stage-1 invariant): key on the
          // PARENT-route model per task (parentRouteModelByTaskId), NOT the
          // displayed `.model` field — for a sub-agent task the display field is
          // the child/overlay model and is OUTSIDE parent-execution parity. Skip
          // any sub-agent-overlaid badge entirely: a sub-agent task's badge
          // legitimately shows the child model even if a parent switch failed.
          const unappliedTargets = new Set(pendingSwitches.map((sw) => sw.toModel as string));
          let corrected = false;
          for (const taskId of Object.keys(taskRoutingMetadata)) {
            const entry = taskRoutingMetadata[taskId];
            if (!entry || entry.isSubAgent) continue; // never touch a sub-agent overlay
            const parentRouteModel = parentRouteModelByTaskId.get(taskId);
            if (
              parentRouteModel
              && parentRouteModel !== activeExecution.current.model
              && unappliedTargets.has(parentRouteModel)
            ) {
              taskRoutingMetadataWriter.correctFailedParentRouteBadge({
                taskId,
                parentRouteModel,
                effort: entry.effort,
              }, activeExecution.current.model);
              // Remember the correction so a later successful retry can restore
              // this badge to its canonical parent route.
              failureCorrectedTaskIds.add(taskId);
              corrected = true;
            }
          }
          if (corrected) {
            log.info(
              { activeExecutionModel: activeExecution.current.model, unappliedTargets: Array.from(unappliedTargets) },
              'Adaptive routing: corrected parent-route task badges to the active model after a failed switch',
            );
            maybeEmitTaskRoutingMetadata();
          }
        }
      };

      // Pre-loop pass: apply any switch whose task is ALREADY in_progress/completed
      // at turn start (the first task is seeded in_progress before the loop). This
      // closes the first-step timing gap — without it, a first-step override could
      // not engage until after the first iteration ran on the prior model.
      // betweenTurnIterationCount is still 0 here, so the iteration fallback cannot
      // fire pre-loop; only task-store-satisfied switches apply. `triggered` then
      // prevents betweenTurns from double-applying.
      await applyDueModelSwitchesObservably();

      for (let attempt = 0; attempt <= maxStopHookRetries; attempt++) {
        const isLastAttempt = attempt === maxStopHookRetries || !hooks.Stop?.length;
        const agentLoopOpts = {
          supportsReasoningReplay: activeExecution.current.supportsReasoningReplay,
        };
        const agentLoopConfig: RebelCoreConfig = {
          client: activeExecution.current.client,
          model: activeExecution.current.model,
          systemPrompt: effectiveSystemPrompt,
          messages: currentMessages,
          tools: allTools,
          maxTokens: activeExecution.current.limits.maxOutputTokens,
          signal,
          thinking: activeExecution.current.thinking,
          ...(activeExecution.current.effort ? { effort: activeExecution.current.effort } : {}),
          contextWindow: activeExecution.current.limits.contextWindow,
          ...(transcriptSessionId ? {
            sessionId: transcriptSessionId,
            turnId: transcriptTurnId,
            nextToolResultEventSeq,
            imageAssetSurface,
          } : {}),
          onContextOverflow: ({ lastKnownInputTokens }) => {
            recordContextOverflowOnProfile({
              model: activeExecution.current.model,
              profileId: activeExecution.current.profileId,
              lastKnownInputTokens,
            });
          },
          onRetry: (retryInfo) => {
            logProviderRetryTelemetry(retryInfo, 'executor');
            const { attempt, maxRetries, provider } = retryInfo;
            const retryStatusMessage = getRetryStatusMessage(attempt, maxRetries, provider);
            if (retryStatusMessage) {
              emitEvent({ type: 'status', message: retryStatusMessage });
            }
          },
          onStreamActivity: context.onStreamActivity,
          onToolDispatch: context.onToolDispatch,
          onToolSettle: context.onToolSettle,
          suppressLoopComplete: !isLastAttempt,
          // Flush routing:tasks at the end of each iteration so per-task model
          // badges surface as soon as MissionSet/TaskCreate/TaskUpdate land —
          // without waiting for the loop to finish. Dedup hash inside
          // maybeEmitTaskRoutingMetadata prevents redundant emits when the
          // metadata snapshot hasn't changed.
          onIterationEnd: () => {
            maybeEmitTaskRoutingMetadata();
          },
          betweenTurns: async (messageHistory, lastUsage) => {
            betweenTurnIterationCount += 1;
            // Apply any switch now due (task-store-driven, with the iteration-count
            // fallback). Shares the extracted applier with the pre-loop pass;
            // failed switches are logged + badge-corrected, never silently
            // misleading. `liveAgentLoop` (set below) lets it update the in-flight
            // loop config/opts.
            await applyDueModelSwitchesObservably();

              const cacheAgeMs = context.getCacheAgeMs ? context.getCacheAgeMs() : Infinity;

              // Use effective tokens (input + cache) for accurate utilization measurement
              const effectiveInputTokens = getEffectiveInputTokens(lastUsage);

              const decision = decideCompaction(
                effectiveInputTokens,
                activeExecution.current.limits.contextWindow,
                cacheAgeMs,
                DEFAULT_COMPACTION_CONFIG,
                activeExecution.current.client.capabilities
              );

              // Log-only decisions (server-side handling)
              if (decision.action === 'clear_tool_uses') {
                log.debug('Server-side clear_tool_uses active (Anthropic handles this)');
                return;
              }
              if (decision.action === 'native_compact') {
                log.debug('Server-side native compaction active (Anthropic handles this)');
                return;
              }
              if (decision.action === 'none') return;

              // Deferred BTS: log and defer to next turn via taskStore flag
              if (decision.action === 'bts_deferred') {
                const wasPreviouslyDeferred = taskStore.getCompactionDeferred?.() ?? false;
                if (wasPreviouslyDeferred) {
                  log.info('BTS compaction deferred previously — escalating to immediate');
                  // Fall through to BTS immediate below
                } else {
                  log.info({ reason: (decision as { reason?: string }).reason }, 'BTS compaction deferred (cache warm)');
                  taskStore.setCompactionDeferred?.(true);
                  return;
                }
              }

              // Client-side pruning (75% tier) and BTS compaction (90%+ tier)
              const isBts = decision.action === 'bts_immediate' || decision.action === 'bts_deferred';
              const keepRecent = isBts ? 5 : 10;
              const statusMessage = isBts ? 'Compacting context (high utilization)...' : 'Condensing context...';

              log.info({ action: decision.action, keepRecent }, 'Client-side compaction triggered');
              const pairsToSummarize = extractOldToolPairs(messageHistory, keepRecent);
              if (pairsToSummarize.length === 0) return;

              const currentState = taskStore.getContextState();
              // Use execution model (not planning model) for compaction — avoids thinking model cost
              // in plan mode. Full BTS routing (Haiku) deferred to Stage 11 Step 2.
              const summaryModel = activeExecution.current.model;

              emitEvent({ type: 'status', message: statusMessage });

              try {
                const updateResult = await updateContextStateViaLLM(
                  activeExecution.current.client,
                  summaryModel,
                  currentState,
                  pairsToSummarize,
                  signal,
                );

                if (updateResult.usage) {
                  const u = updateResult.usage;
                  const stateUpdateCost = calculateCostOrWarn(
                    summaryModel,
                    u.inputTokens,
                    u.outputTokens,
                    log,
                    'context-state-update',
                    u.cacheCreationTokens || undefined,
                    u.cacheReadTokens || undefined,
                  );
                  if (stateUpdateCost != null && stateUpdateCost > 0) {
                    // Compaction runs on the parent turn's client, so attribute its
                    // cost to the parent turn's auth method + renderer session — the
                    // same resolved-auth source normal turn cost entries use
                    // (cf. agentMessageHandler success path). Without this, these rows
                    // land in the 'unknown' bucket and are mis-counted as out-of-pocket
                    // rather than subscription-covered. Forward-only.
                    appendCostEntry({
                      ts: Date.now(),
                      cost: stateUpdateCost,
                      cat: 'compaction-bts',
                      m: summaryModel,
                      sid: context.turnId ? agentTurnRegistry.getRendererSession(context.turnId) : undefined,
                      auth: context.turnId ? agentTurnRegistry.getTurnAuthMethod(context.turnId) : undefined,
                      inTok: u.inputTokens,
                      outTok: u.outputTokens,
                      cacheReadTok: u.cacheReadTokens || undefined,
                      cacheCreateTok: u.cacheCreationTokens || undefined,
                      est: true,
                      outcome: updateResult.ok
                        ? { kind: 'auxiliary_success' }
                        : { kind: 'auxiliary_failed', reason: contextStateFailureToLedgerReason(updateResult.failureReason) },
                    });
                  }
                }

                if (!updateResult.ok) {
                  log.warn('Context state update failed — skipping prune to prevent data loss');
                  return;
                }

                taskStore.updateContextState(updateResult.state);
                const removedCount = pruneOldToolPairs(messageHistory, keepRecent);
                log.info({ removedCount, action: decision.action }, 'Pruned old tool pairs');

                // Clear deferred flag after successful compaction
                taskStore.setCompactionDeferred?.(false);

                // Eagerly persist so context state survives app crash/restart
                if (sessionId) {
                  try {
                    await saveTaskBoard(sessionId, taskStore);
                  } catch (saveErr) {
                    log.debug({ err: saveErr instanceof Error ? saveErr.message : String(saveErr) }, 'Eager context state save failed');
                  }
                }

                const summary = isBts
                  ? formatContextStateSummary(updateResult.state)
                  : JSON.stringify(updateResult.state, null, 2);

                messageHistory.push({
                  role: 'user',
                  content: `[System: Context ${isBts ? 'Compacted' : 'Pruned'}] ${removedCount} old tool interactions were ${isBts ? 'summarized and removed' : 'removed'} to manage token limits.\n\n${summary}`
                });
              } catch (error) {
                log.warn(
                  { err: error instanceof Error ? error.message : String(error), action: decision.action },
                  'BTS compaction failed — continuing without compaction'
                );
              }
          },
        };

        // Publish the in-flight loop config/opts so betweenTurns switch
        // application mutates the LIVE objects (mid-turn model swap takes effect
        // on the next iteration).
        liveAgentLoop = { config: agentLoopConfig, opts: agentLoopOpts };

        // Emit execution model for renderer per-step labels. The routing:model:
        // event may have fired earlier for adaptive routing; this ensures it's
        // always emitted (for non-routed turns too, so the UI always shows model).
        emitEvent({ type: 'status', message: `routing:model:${activeExecution.current.model}` });

        // Pre-loop emit: surfaces planner-seeded tasks + plan-routing entries +
        // any tasks already in the store from prior stop-hook attempts. The
        // post-loop emit (after runAgentLoop returns, see below) is what catches
        // tasks created INSIDE this iteration via TaskCreate / MissionSet / Agent.
        maybeEmitTaskRoutingMetadata();

        const result = await runAgentLoop(
          agentLoopConfig,
          toolExecutor,
          emitEvent,
          agentLoopOpts,
        );

        lastResult = result;

        // Post-loop emit: tasks created during this iteration via TaskCreate /
        // MissionSet / Agent tools are now in the store, and sub-agent
        // delegation stamps from onTaskRoutingMetadataUpdate are now in the
        // metadata map. This is the emit that restores per-task badges for
        // turns running without plan mode (the originally-reported regression).
        maybeEmitTaskRoutingMetadata();

        // === Task-board completion check (deterministic, runs before stop hooks) ===
        // Only check main agent's own tasks that were created or updated this turn.
        // Includes plan-seeded tasks that the model touched (updatedAt >= turnStartTime).
        // Excludes mission metadata, subagent tasks, untouched pre-existing tasks, and blocked tasks.
        // Guard: only run when loop:complete was suppressed (i.e., not the last attempt),
        // otherwise we'd emit duplicate loop:complete events on continuation.
        if (!isLastAttempt && attempt < maxStopHookRetries) {
          // Skip task-board continuation when waiting for user to answer AskUserQuestion.
          // The auto-continue stop hook also checks this, but task-board runs first.
          if (agentTurnRegistry.hasUserQuestionPending(transcriptTurnId)) {
            log.info({ attempt }, 'User question pending — skipping task-board continuation');
          } else {
            const incompleteTasks = taskStore.listTasks().filter((t) =>
              (t.owner === undefined || t.owner === 'main')
              && (t.status === 'in_progress' || t.status === 'pending')
              && (t.createdAt >= turnStartTime || t.updatedAt >= turnStartTime)
            );

            if (incompleteTasks.length > 0 && params.hasPendingApprovalExecutions?.()) {
              // FOX-2771 Stage 2 (review F1 + confirm-round F1): an
              // approved-but-unexecuted operation is pending and the
              // approval-execution guard Stop hook still has work to do at
              // this stop — its single forced approval-specific continuation,
              // or the "approved but not executed" surfacing pass that
              // follows it. Surrender the generic task-board injection so the
              // Stop-hook chain runs — this layer runs BEFORE all Stop hooks,
              // so injecting here would preempt the guard (first pass: break
              // the "exactly one approval-specific continuation" contract;
              // post-forced pass: swallow the surfacing leg entirely, because
              // the last attempt skips Stop hooks). Starvation stays bounded:
              // the predicate is true at most twice per approval (forced +
              // surfacing passes), then flips false and normal task-board
              // behavior resumes.
              log.info(
                { attempt, incompleteTasks: incompleteTasks.length },
                'Pending approval execution — task-board continuation yielding to Stop-hook chain',
              );
            } else if (incompleteTasks.length > 0) {
              // FOX-3097: exempt legitimate plain-text yields from forced
              // continuation. `hasUserQuestionPending` above covers structured
              // AskUserQuestion; this covers skills that ask a plain-text
              // question and wait (e.g. build-custom-mcp-server Phase 0.0).
              // Shared predicate consulted by `autoContinueHook` fast paths
              // for a single source of truth.
              //
              // Phase 7b: source `lastAssistantText` directly from the just-
              // returned `result.messageHistory` rather than via the
              // agentTurnRegistry accumulator. The accumulator is populated
              // asynchronously by the main-process consumer path
              // (`handleAgentMessage` → `dispatchAgentEvent`), so reading it
              // here would depend on microtask ordering we don't control.
              // `result.messageHistory` is populated synchronously by
              // `runAgentLoop` before it returns, so the last assistant
              // message is guaranteed to be present here.
              const lastAssistantMsg = [...result.messageHistory]
                .reverse()
                .find((m) => m.role === 'assistant');
              const lastAssistantText = lastAssistantMsg
                ? (typeof lastAssistantMsg.content === 'string'
                  ? lastAssistantMsg.content
                  : lastAssistantMsg.content
                      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                      .map((b) => b.text)
                      .join('\n\n'))
                : '';
              // `turnEvents` is only used by the side-effect detector inside
              // `hasLegitimateYieldSignal` — if the accumulator isn't ready
              // yet, an empty array is a safe default (the regex-based signal
              // checks still run).
              const turnEvents = agentTurnRegistry
                .getContextAccumulator(transcriptTurnId)
                ?.eventsByTurn[transcriptTurnId] ?? [];

              if (isYieldingToUser({
                lastAssistantText,
                tasks: taskStore.listTasks(),
                turnStartTime,
                turnEvents,
              })) {
                log.info(
                  { attempt, incompleteTasks: incompleteTasks.length },
                  'Legitimate user yield detected — skipping task-board continuation',
                );
              } else {
                const taskList = incompleteTasks.map((t) => `#${t.id} ('${t.title}')`).join(', ');
                log.info(
                  {
                    attempt,
                    taskBoardContinuation: true,
                    incompleteTasks: incompleteTasks.length,
                    taskIds: incompleteTasks.map((t) => t.id),
                  },
                  'Task-board forced continuation — incomplete tasks detected',
                );
                currentMessages = [
                  ...result.messageHistory,
                  {
                    role: 'user' as const,
                    content: `[System: auto-continue] Tasks ${taskList} are still incomplete. Continue working on them.`,
                  },
                ];
                continue;
              }
            }
          }
        }

        // === Stop hooks (behavioral check — lazy stops, permission-seeking) ===
        if (hooks.Stop && hooks.Stop.length > 0 && attempt < maxStopHookRetries) {
          const stopHookResult = await runStopHooksWithReason(hooks.Stop, {
            signal,
            sessionId,
            cwd: cwd ?? params.cwd,
            permissionMode: params.permissionMode,
            stopHookActive: attempt > 0,
          });

          if (stopHookResult.shouldContinue) {
            log.info({ attempt }, 'Stop hook requested continuation');
            // Use the accumulated message history from the completed loop
            // so the model has full context of what it already did.
            currentMessages = [
              ...result.messageHistory,
              {
                role: 'user' as const,
                content: stopHookResult.reason
                  ? `[System: auto-continue]\n${stopHookResult.reason}`
                  : 'Continue from where you left off.',
              },
            ];
            continue;
          }

          // Stop hook did NOT request continuation, but loop:complete was
          // suppressed (suppressLoopComplete: true) because we weren't sure
          // if this was the last attempt. Emit it now so downstream receives
          // the result message and the turn finalizes correctly.
          if (!isLastAttempt) {
            emitEvent({ type: 'loop:complete', totalUsage: result.totalUsage });
          }
        }

        return result;
      }

      return lastResult;
    };

    // Wall-clock sentinel (Layer 0): the watchdog (Layer 2) is the real per-turn
    // ceiling; this only fires if every other layer is wedged. See the
    // TURN_WALL_CLOCK_DEADLINE_MS doc comment for the move-together list.
    // Uses the existing AbortController so the signal propagates to sub-agents automatically.
    const wallClockTimer = setTimeout(() => {
      if (!signal.aborted) {
        log.warn('Turn exceeded wall-clock deadline (Layer 0 sentinel) — aborting');
        abortController.abort(new Error('Turn exceeded wall-clock deadline (Layer 0 sentinel)'));
      }
    }, TURN_WALL_CLOCK_DEADLINE_MS);

    const loopPromise = runWithStopHooks();

    loopPromise
      .then(async () => {
        clearTimeout(wallClockTimer);
        if (sessionId) {
          await saveTaskBoard(sessionId, taskStore);
        }
        channel.finish();
      })
      .catch(async (err) => {
        clearTimeout(wallClockTimer);
        // best-effort: a learned-limits write failure must not mask the original error.
        void safeDispatchLearnedLimitsFromError(err, {
          turnId: transcriptTurnId,
          model: activeExecution.current.model,
          profileId: activeExecution.current.profileId ?? null,
        }, log);

        // Context overflow after loop compaction exhausted — try fallback model.
        // ContextOverflowError carries already-compacted messages from the loop.
        // No turn:error was emitted yet — we emit it only if fallback also fails.
        if (err instanceof ContextOverflowError) {
          const fallbackModel = getContextOverflowFallbackModel(settings);
          const fallbackProfileId = getContextOverflowFallbackProfileId(settings);
          let skeletonAttempted = false;

          // Resolve fallback client based on configured fallback source:
          // 1. Profile ID → explicit profile override (supports non-Anthropic providers)
          // 2. Model name + Anthropic auth → direct Anthropic client (legacy path)
          // 3. Neither viable → skip fallback entirely
          let fallbackClient: import('./modelClient').ModelClient | null = null;
          let resolvedFallbackModel = fallbackModel
            ? decodeQueryRoutingModelOrThrow(fallbackModel, 'context-overflow fallback')
            : null;
          let resolvedFallbackProfile: ModelProfile | undefined;

          if (fallbackProfileId) {
            const fallbackProfile = settings.localModel?.profiles?.find(
              (p) => p.id === fallbackProfileId,
            );
            if (fallbackProfile) {
              resolvedFallbackProfile = fallbackProfile;
              // Use the profile's model name if the model-name fallback isn't configured
              resolvedFallbackModel = fallbackModel
                ? decodeQueryRoutingModelOrThrow(fallbackModel, 'context-overflow fallback')
                : fallbackProfile.model
                  ? decodeQueryRoutingModelOrThrow(fallbackProfile.model, 'context-overflow fallback profile')
                  : activeExecution.current.model;
              // createClientForModel handles provider-aware routing: explicit profile
              // takes precedence over Claude-prefix heuristics, so custom providers
              // (LiteLLM, Bedrock, etc.) route to their own serverUrl even with
              // Claude model names. Gemini gets proxy for thought signatures.
              fallbackClient = await createClientForModel({
                model: resolvedFallbackModel,
                profile: fallbackProfile,
                settings,
                proxyConfig,
                context: 'execution',
                codexMode: context.codexMode,
              });
            } else {
              log.warn({ fallbackProfileId }, 'Configured fallback profile not found — skipping fallback');
            }
          } else if (fallbackModel) {
            const providerMode = selectProviderMode(settings);
            if (providerMode.credentialSource.startsWith('missing-')) {
              log.warn(
                { providerMode },
                `[ROUTER] model-name fallback declined: provider-shape='${providerMode.provider}/${providerMode.credentialSource}'`,
              );
            } else {
              const fallbackModelForClient = resolvedFallbackModel ?? decodeQueryRoutingModelOrThrow(fallbackModel, 'context-overflow fallback');
              // Model-name fallback must respect the active provider shape. OpenRouter/Codex
              // users with lingering Anthropic keys route through their active provider's
              // resolver path instead of silently falling back to direct Anthropic.
              fallbackClient = await createClientForModel({
                model: fallbackModelForClient,
                settings,
                proxyConfig,
                context: 'execution',
                codexMode: context.codexMode,
              });
            }
          }
          // else: no fallback configured or no viable auth — skip fallback

          if (fallbackClient && resolvedFallbackModel && resolvedFallbackModel !== activeExecution.current.model) {
            const fallbackWallClockTimer = setTimeout(() => {
              if (!signal.aborted) {
                log.warn('Fallback turn exceeded wall-clock deadline (Layer 0 sentinel) — aborting');
                abortController.abort(new Error('Fallback turn exceeded wall-clock deadline (Layer 0 sentinel)'));
              }
            }, TURN_WALL_CLOCK_DEADLINE_MS);

            try {
              emitEvent({ type: 'recovery:fallback', message: `Switching to ${resolvedFallbackModel}...`, fallbackModel: resolvedFallbackModel });

              const fallbackLimits = resolveModelLimits({
                model: resolvedFallbackModel,
                profileMaxOutput: resolvedFallbackProfile?.maxOutputTokens,
                profileMaxOutputSource: resolvedFallbackProfile?.outputTokensSource,
                profileContextWindow: resolvedFallbackProfile?.contextWindow,
                profileContextWindowSource: resolvedFallbackProfile?.contextWindowSource,
                allProfiles: settings.localModel?.profiles ?? [],
              });
              const fallbackSupportsReasoningReplay = computeSupportsReasoningReplay(
                resolvedFallbackProfile,
                resolvedFallbackModel,
              );

              const fallbackProfileIdForCallback = resolvedFallbackProfile?.id ?? null;
              const fallbackResult = await runAgentLoop(
                {
                  client: fallbackClient,
                  model: resolvedFallbackModel,
                  systemPrompt: effectiveSystemPrompt,
                  messages: err.compactedMessages,
                  tools: allTools,
                  maxTokens: fallbackLimits.maxOutputTokens,
                  signal,
                  thinking: activeExecution.current.thinking,
                  ...(activeExecution.current.effort ? { effort: activeExecution.current.effort } : {}),
                  contextWindow: fallbackLimits.contextWindow,
                  ...(transcriptSessionId ? {
                    sessionId: transcriptSessionId,
                    turnId: transcriptTurnId,
                    nextToolResultEventSeq,
                    imageAssetSurface,
                  } : {}),
                  onContextOverflow: ({ lastKnownInputTokens }) => {
                    recordContextOverflowOnProfile({
                      model: resolvedFallbackModel,
                      profileId: fallbackProfileIdForCallback,
                      lastKnownInputTokens,
                    });
                  },
                  onRetry: (retryInfo) => {
                    logProviderRetryTelemetry(retryInfo, 'fallback-executor');
                    const { attempt, maxRetries, provider } = retryInfo;
                    const retryStatusMessage = getRetryStatusMessage(attempt, maxRetries, provider);
                    if (retryStatusMessage) {
                      emitEvent({ type: 'status', message: retryStatusMessage });
                    }
                  },
                  onStreamActivity: context.onStreamActivity,
                  onToolDispatch: context.onToolDispatch,
                  onToolSettle: context.onToolSettle,
                },
                toolExecutor,
                emitEvent,
                { supportsReasoningReplay: fallbackSupportsReasoningReplay },
              );

              log.info(
                { fallbackModel: resolvedFallbackModel, turns: fallbackResult.turns },
                'Fallback model succeeded after context overflow',
              );

              clearTimeout(fallbackWallClockTimer);
              if (sessionId) await saveTaskBoard(sessionId, taskStore);
              channel.finish();
              return;
            } catch (fallbackErr) {
              clearTimeout(fallbackWallClockTimer);
              // best-effort: a learned-limits write failure must not mask the original error.
              void safeDispatchLearnedLimitsFromError(fallbackErr, {
                turnId: transcriptTurnId,
                model: resolvedFallbackModel,
                profileId: resolvedFallbackProfile?.id ?? null,
              }, log);
              logError(fallbackErr);
              log.warn({ err: fallbackErr, fallbackModel: resolvedFallbackModel }, 'Fallback model also failed');
            }
          }

          if (!signal.aborted) {
            if (skeletonAttempted) {
              channel.fail(err);
              return;
            }
            skeletonAttempted = true;

            try {
              const skeleton = buildSkeletonMessages(err.compactedMessages);

              logSynthetic('recovery:skeleton:start', {
                model: activeExecution.current.model,
                fallbackModel: resolvedFallbackModel ?? fallbackModel,
                originalMessageCount: err.compactedMessages.length,
                skeletonMessageCount: skeleton.messages.length,
                droppedToolResultCount: skeleton.droppedToolResultCount,
                droppedToolUseCount: skeleton.droppedToolUseCount,
                droppedThinkingCount: skeleton.droppedThinkingCount,
                droppedImageCount: skeleton.droppedImageCount,
                userTextPreserved: skeleton.userTextPreserved,
              });

              log.warn(
                {
                  sessionId,
                  turnId: transcriptTurnId,
                  model: activeExecution.current.model,
                  fallbackModel: resolvedFallbackModel ?? fallbackModel,
                  originalMessageCount: err.compactedMessages.length,
                  skeletonMessageCount: skeleton.messages.length,
                  droppedToolResultCount: skeleton.droppedToolResultCount,
                  droppedToolUseCount: skeleton.droppedToolUseCount,
                  droppedThinkingCount: skeleton.droppedThinkingCount,
                  droppedImageCount: skeleton.droppedImageCount,
                  userTextPreserved: skeleton.userTextPreserved,
                },
                'Recovery: skeleton mode engaged after fallback failure',
              );

              emitEvent({
                type: 'recovery:skeleton',
                message: 'Context was getting unwieldy, so I trimmed earlier tool work to keep going. Older lookups, screenshots, and intermediate steps were dropped. Ask me to redo any of them if you need the detail.',
                droppedToolResultCount: skeleton.droppedToolResultCount,
                droppedToolUseCount: skeleton.droppedToolUseCount,
                droppedThinkingCount: skeleton.droppedThinkingCount,
                droppedImageCount: skeleton.droppedImageCount,
                userTextPreserved: skeleton.userTextPreserved,
              });

              const skeletonPreflightTokens = estimatePromptTokensForPreflight({
                systemPrompt: effectiveSystemPrompt,
                messages: skeleton.messages,
                tools: allTools,
              });
              const skeletonRunawayCap = activeExecution.current.limits.contextWindow && activeExecution.current.limits.contextWindow > 0
                ? Math.min(1_000_000, activeExecution.current.limits.contextWindow * 2)
                : 1_000_000;
              if (skeletonPreflightTokens > skeletonRunawayCap) {
                log.warn(
                  {
                    sessionId,
                    turnId: transcriptTurnId,
                    model: activeExecution.current.model,
                    skeletonPreflightTokens,
                    skeletonRunawayCap,
                  },
                  'Skeleton preflight exceeded runaway cap; failing',
                );
                channel.fail(new Error(
                  'Even a stripped-down retry exceeded the model\'s context. The current request may be too large; please start a new conversation.',
                ));
                return;
              }

              const skeletonWallClockTimer = setTimeout(() => {
                if (!signal.aborted) {
                  log.warn('Skeleton turn exceeded wall-clock deadline (Layer 0 sentinel) — aborting');
                  abortController.abort(new Error('Skeleton turn exceeded wall-clock deadline (Layer 0 sentinel)'));
                }
              }, TURN_WALL_CLOCK_DEADLINE_MS);

              try {
                const skeletonProfile = activeExecution.current.profileId
                  ? settings.localModel?.profiles?.find((profile) => profile.id === activeExecution.current.profileId)
                  : undefined;
                const skeletonSupportsReasoningReplay = computeSupportsReasoningReplay(
                  skeletonProfile,
                  activeExecution.current.model,
                );
                const skeletonResult = await runAgentLoop(
                  {
                    client: activeExecution.current.client,
                    model: activeExecution.current.model,
                    systemPrompt: effectiveSystemPrompt,
                    messages: skeleton.messages,
                    tools: allTools,
                    maxTokens: activeExecution.current.limits.maxOutputTokens,
                    signal,
                    thinking: activeExecution.current.thinking,
                    ...(activeExecution.current.effort ? { effort: activeExecution.current.effort } : {}),
                    contextWindow: activeExecution.current.limits.contextWindow,
                    ...(transcriptSessionId ? {
                      sessionId: transcriptSessionId,
                      turnId: transcriptTurnId,
                      nextToolResultEventSeq,
                      imageAssetSurface,
                    } : {}),
                    onContextOverflow: ({ lastKnownInputTokens }) => {
                      recordContextOverflowOnProfile({
                        model: activeExecution.current.model,
                        profileId: activeExecution.current.profileId,
                        lastKnownInputTokens,
                      });
                    },
                    onRetry: (retryInfo) => {
                      logProviderRetryTelemetry(retryInfo, 'skeleton-executor');
                      const { attempt, maxRetries, provider } = retryInfo;
                      const retryStatusMessage = getRetryStatusMessage(attempt, maxRetries, provider);
                      if (retryStatusMessage) {
                        emitEvent({ type: 'status', message: retryStatusMessage });
                      }
                    },
                    onStreamActivity: context.onStreamActivity,
                    onToolDispatch: context.onToolDispatch,
                    onToolSettle: context.onToolSettle,
                  },
                  toolExecutor,
                  emitEvent,
                  { supportsReasoningReplay: skeletonSupportsReasoningReplay },
                );

                log.info(
                  { model: activeExecution.current.model, turns: skeletonResult.turns },
                  'Skeleton recovery succeeded after context overflow',
                );

                if (sessionId) await saveTaskBoard(sessionId, taskStore);
                channel.finish();
                return;
              } finally {
                clearTimeout(skeletonWallClockTimer);
              }
            } catch (skeletonErr) {
              // best-effort: a learned-limits write failure must not mask the original error.
              void safeDispatchLearnedLimitsFromError(skeletonErr, {
                turnId: transcriptTurnId,
                model: activeExecution.current.model,
                profileId: activeExecution.current.profileId ?? null,
              }, log);
              if (signal.aborted || isAbortError(skeletonErr)) {
                log.info(
                  { sessionId, turnId: transcriptTurnId },
                  'Skeleton attempt aborted',
                );
                channel.finish();
                return;
              }

              const wrappedSkeletonError = skeletonErr instanceof Error
                ? skeletonErr
                : new Error(String(skeletonErr));
              const wrappedWithCause = wrappedSkeletonError as Error & { cause?: unknown };
              if (!('cause' in wrappedWithCause) || wrappedWithCause.cause == null) {
                wrappedWithCause.cause = err;
              }

              log.error(
                {
                  sessionId,
                  turnId: transcriptTurnId,
                  model: activeExecution.current.model,
                  fallbackModel: resolvedFallbackModel ?? fallbackModel,
                  skeletonError: wrappedSkeletonError.message,
                  originalOverflowMessage: err.message,
                },
                'Recovery: skeleton mode failed',
              );
              logError(wrappedSkeletonError);
              channel.fail(wrappedSkeletonError);
              return;
            }
          }
        }

        if (sessionId) {
          try {
            await saveTaskBoard(sessionId, taskStore);
          } catch {
            // best effort only
          }
        }

        // Transcript: capture turn:error (this path bypasses emitEvent)
        logError(err);

        const errorMessages = adapter.handleEvent({
          type: 'turn:error',
          error: err instanceof Error ? err : new Error(String(err)),
        });
        for (const msg of errorMessages) {
          channel.push(msg);
        }

        if ((err instanceof ModelError && err.isAbort) || err?.name === 'AbortError') {
          channel.finish();
        } else {
          channel.fail(err instanceof Error ? err : new Error(String(err)));
        }
      });

    yield* channel;
  } finally {
    await mcpSession?.close();
  }
}
