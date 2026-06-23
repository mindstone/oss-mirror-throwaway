/**
 * TurnParams — The Rebel Core boundary contract for agent turns.
 *
 * Replaces the legacy `Options` shape (originally from the Claude Agent SDK) at the rebelCoreQuery boundary.
 * Only fields that Rebel Core actually needs flow through here;
 * most legacy runtime fields stay in the executor.
 */
import type { ChatMessage, SystemPrompt } from './modelTypes';
import type { RebelCoreHooks, RebelCoreAgentDefinition, BuiltinToolName } from './types';

export interface TurnParams {
  model: string;
  systemPrompt: SystemPrompt;
  prompt: string | AsyncGenerator<unknown, void, unknown>;
  /**
   * Recovery-owned stripped history for resetConversation retries.
   * The executor translates persisted AgentTurnMessage recovery history into
   * Rebel Core ChatMessage entries before crossing this boundary.
   */
  recoveryMessages?: ChatMessage[];
  hooks?: RebelCoreHooks;
  agents?: Record<string, RebelCoreAgentDefinition>;
  abortController?: AbortController;
  cwd?: string;
  permissionMode?: string;
  /**
   * Environment variables for the turn. Carries:
   * - Auth: ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN
   * - Proxy config: ANTHROPIC_BASE_URL, ANTHROPIC_CUSTOM_HEADERS
   * - Model env: ENV_EXECUTION_MODEL, ENV_THINKING_MODEL (see modelNormalization.ts constants)
   * - General process env
   */
  env?: Record<string, string>;
  /**
   * Built-in tool names to suppress for this turn.
   * Computed by capability resolution when MCP alternatives are active.
   * Tools in this list are filtered out of the tool spec before the agent loop runs.
   * Propagated to sub-agents so they inherit the same suppression.
   */
  suppressedBuiltins?: BuiltinToolName[];
  /**
   * Approval-execution guard surrender predicate (FOX-2771 Stage 2).
   *
   * True when an execution-expected single-use approval stored BEFORE this
   * turn started is still unconsumed and has not yet spent its one forced
   * continuation — i.e. the approval-execution guard Stop hook WOULD block
   * the next stop with an approval-specific continuation. The task-board
   * forced-continuation layer (which runs before all Stop hooks) consults
   * this and surrenders its generic injection so the guard's message wins.
   *
   * Injected as a callback because the approval store lives main-side
   * (`@main/services/safety/sessionApprovals`) and Rebel Core must stay
   * platform-agnostic. Wired in `agentTurnExecute.ts`.
   */
  hasPendingApprovalExecutions?: () => boolean;
}
