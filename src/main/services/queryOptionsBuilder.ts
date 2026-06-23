/**
 * Query Options Builder
 *
 * Extracted from agentTurnExecutor.ts — builds the runtime query options object
 * from an explicit context instead of closing over 22+ executor-scope variables.
 *
 * The context object is mutable by reference: error recovery can update
 * `ctx.modelConfig` and the next `buildSdkQueryOptions(ctx)` call picks up
 * the change. Provider routing/auth/proxy state is projected from the
 * ProviderRoutePlan built at turn start.
 */

import type { TurnParams } from '@core/rebelCore/queryRouter';
import type { ChatMessage } from '@core/rebelCore/modelTypes';
import type { ProviderRoutePlan } from '@core/rebelCore/providerRoutePlan';
import { applyAuthPlanToEnv } from '@core/rebelCore/providerAuthPlan';
import type { RebelCoreAgentDefinition, RebelCoreHooks, BuiltinToolName } from '@core/rebelCore/types';
import type { AgentDefinition, McpServers } from '@core/agentRuntimeTypes';
import type { ModelConfig } from '@shared/utils/modelNormalization';
import type { CapabilityResolution } from '@core/services/capabilityResolutionService';
import type { CouncilConfig } from './councilService';
import type { AdHocAgentConfig } from './adHocAgentService';
import type { ClaudeSubagentConfig } from './claudeMentionAgentService';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'queryOptionsBuilder' });

// ---------------------------------------------------------------------------
// Context interface
// ---------------------------------------------------------------------------

export interface QueryOptionsContext {
  // Turn identification
  turnId: string;

  // Turn basics
  coreDirectory: string;
  effectivePath: string;
  effectiveThinkingEffort: string;

  // Model (mutable — error recovery updates this via reference)
  modelConfig: ModelConfig;
  getEffectiveModel: () => string;
  plan: ProviderRoutePlan;

  // Prompt — TWO prompts needed
  rawSystemPrompt: string;       // for knowledge-worker agent prompt (original, pre-council augmentation)
  finalSystemPrompt: string;     // for top-level systemPrompt option (includes council/capability augmentation)
  recoveryMessages?: ChatMessage[];

  // Hooks
  turnHooks: RebelCoreHooks;

  // MCP
  mcpServers: McpServers | undefined;
  capabilityResolution: CapabilityResolution;
  agentMcpSpecs: AgentDefinition['mcpServers'];

  // Agents (from setupModelRoutes output)
  councilConfig: CouncilConfig | null;
  adHocConfig: AdHocAgentConfig | null;
  claudeSubagentConfig: ClaudeSubagentConfig | null;

  // Provider key env is orthogonal to route auth: it exposes third-party keys
  // to subprocess shells when the user has opted in.
  getProviderKeyEnv: () => Record<string, string>;  // handles exposeProviderKeysInShell gating internally

  // Settings subset
  permissionMode: string;

  // Agent naming
  knowledgeWorkerAgentName: string;
  knowledgeWorkerAgentDescription: string;

  /**
   * Approval-execution guard surrender predicate (FOX-2771 Stage 2) —
   * threaded through to `TurnParams.hasPendingApprovalExecutions` so the
   * task-board continuation layer in rebelCoreQuery yields to the guard's
   * Stop hook when an approved-but-unexecuted operation is pending.
   */
  hasPendingApprovalExecutions?: () => boolean;

  // Process env (injectable for testability; defaults to process.env in production)
  processEnv?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Return type alias
// ---------------------------------------------------------------------------

export type SdkQueryOptions = Omit<TurnParams, 'prompt'> & { mcpServers?: McpServers };

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build query options from an explicit context.
 *
 * This is a deterministic, side-effect-free function: given the same context,
 * it produces the same options. All dynamic state (auth tokens, proxy URLs,
 * model config after error recovery) is accessed through getters on the
 * context object, so repeated calls pick up mutations.
 */
export function buildSdkQueryOptions(ctx: QueryOptionsContext): SdkQueryOptions {
  const env = ctx.processEnv ?? process.env as Record<string, string>;

  return {
    cwd: ctx.coreDirectory,
    model: ctx.getEffectiveModel(),
    permissionMode: ctx.permissionMode,
    systemPrompt: ctx.finalSystemPrompt,
    ...(ctx.recoveryMessages?.length ? { recoveryMessages: ctx.recoveryMessages } : {}),

    // Root-level MCP servers (separate from agent-level mcpServers)
    ...(ctx.mcpServers ? { mcpServers: ctx.mcpServers } : {}),

    // Suppress built-in tools when MCP alternatives are active.
    // Only suppress when mcpServers is truthy (if MCP is degraded, keep all builtins).
    // The cast is safe because capabilityResolutionService only produces known builtin names.
    ...(ctx.mcpServers && ctx.capabilityResolution.disallowedTools.length > 0
      ? { suppressedBuiltins: ctx.capabilityResolution.disallowedTools as BuiltinToolName[] }
      : {}),

    // Approval-execution guard surrender predicate (FOX-2771 Stage 2).
    ...(ctx.hasPendingApprovalExecutions
      ? { hasPendingApprovalExecutions: ctx.hasPendingApprovalExecutions }
      : {}),

    env: applyAuthPlanToEnv(ctx.plan, {
      ...env,
      ...ctx.modelConfig.envOverrides,
      PATH: ctx.effectivePath,
      // Claude Code adaptive thinking effort level (low/medium/high)
      CLAUDE_CODE_EFFORT_LEVEL: ctx.effectiveThinkingEffort,
      // Expose third-party provider API keys (OpenAI, Google, etc.) as env vars when user opts in
      // (the getter handles exposeProviderKeysInShell gating internally)
      ...ctx.getProviderKeyEnv(),
    }),

    hooks: ctx.turnHooks,

    // Register agents: knowledge-worker + council members + ad-hoc models + Claude subagents (when active)
    // Type assertion bridges AgentDefinition (model: string) ↔ RebelCoreAgentDefinition (model: literal union).
    // Both types are structurally compatible at runtime.
    ...(typeof ctx.rawSystemPrompt === 'string' && ctx.rawSystemPrompt.trim().length > 0
      ? {
          agents: {
            [ctx.knowledgeWorkerAgentName]: {
              description: ctx.knowledgeWorkerAgentDescription,
              prompt: ctx.rawSystemPrompt.trim(),
              mcpServers: ctx.agentMcpSpecs,
            } satisfies AgentDefinition,
            ...injectRoutingMode(ctx.councilConfig?.agents, 'council'),
            ...injectRoutingMode(ctx.adHocConfig?.agents, 'ad-hoc'),
            ...(ctx.claudeSubagentConfig ? ctx.claudeSubagentConfig.agents : {}),
          } as Record<string, RebelCoreAgentDefinition>,
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Stamps route-scope-aware `routingMode` onto every agent definition.
 * Used at the queryOptionsBuilder boundary so council/ad-hoc agents carry
 * explicit routing metadata that agentTool.ts can inspect without parsing prompts.
 * Claude-native subagents are intentionally excluded (routingMode stays undefined).
 */
function injectRoutingMode(
  agents: Record<string, AgentDefinition> | undefined,
  mode: 'council' | 'ad-hoc',
): Record<string, AgentDefinition & { routingMode: 'council' | 'ad-hoc' }> {
  if (!agents) return {};

  const missingRoutedModelAgents = Object.entries(agents)
    .filter(([, v]) => typeof v.routedModel !== 'string' || v.routedModel.trim().length === 0)
    .map(([agentName]) => agentName);

  if (missingRoutedModelAgents.length > 0) {
    log.error(
      { mode, missingRoutedModelAgents, totalAgents: Object.keys(agents).length },
      'Route-table agent definitions missing routedModel; refusing to build query options',
    );
    throw new Error(
      `Route-table agent definitions missing routedModel for ${mode}: ${missingRoutedModelAgents.join(', ')}`,
    );
  }

  return Object.fromEntries(
    Object.entries(agents).map(([k, v]) => [k, { ...v, routingMode: mode }]),
  );
}


