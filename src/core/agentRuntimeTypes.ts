/**
 * Agent Runtime Type Hub
 *
 * Local runtime type definitions used across the app.
 *
 * This file previously re-exported types from the legacy Claude Agent SDK package.
 * Types are now defined locally so consumer code stays unchanged while the runtime
 * package is fully removed.
 */

export interface McpServerConfigEntry {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;
  description?: string;
  catalogId?: string;
  email?: string;
  workspace?: string;
  lastConnectedAt?: number;
  [key: string]: unknown;
}

/** Map of MCP server ID to server configuration. */
export type McpServers = Record<string, McpServerConfigEntry> | undefined;

export interface SystemPromptBlock {
  type: string;
  text?: string;
  cache_control?: unknown;
  [key: string]: unknown;
}

/** System prompt: plain string or structured content blocks with cache control. */
export type SystemPrompt = string | SystemPromptBlock[];

/**
 * Minimum options surface retained for consumers that derive MCP/system types.
 */
export interface Options {
  model?: string;
  cwd?: string;
  systemPrompt?: SystemPrompt;
  mcpServers?: McpServers;
  permissionMode?: string;
  includePartialMessages?: boolean;
  hooks?: Record<string, unknown>;
  env?: Record<string, string>;
  [key: string]: unknown;
}

export type AgentMcpServerSpec = string | McpServerConfigEntry | NonNullable<McpServers>;

export interface AgentDefinition {
  description: string;
  prompt: string;
  model?: string;
  routedModel?: string;
  maxTurns?: number;
  tools?: string[];
  mcpServers?: AgentMcpServerSpec[];
  lightweight?: boolean;
  [key: string]: unknown;
}

export interface PermissionUpdate {
  type?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  [key: string]: unknown;
}

export type PermissionResult =
  | { behavior: 'allow'; message?: string; [key: string]: unknown }
  | { behavior: 'deny'; message: string; [key: string]: unknown };

export interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  stop_hook_active?: boolean;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  [key: string]: unknown;
}

export interface HookSpecificOutput {
  hookEventName?: string;
  permissionDecision?: 'allow' | 'deny' | 'ask' | string;
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;
  replaceResult?: {
    output: string;
    isError: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SyncHookJSONOutput {
  continue?: boolean;
  decision?: 'block' | 'approve' | string;
  reason?: string;
  stopReason?: string;
  suppressOutput?: boolean;
  hookSpecificOutput?: HookSpecificOutput;
  [key: string]: unknown;
}

export interface AsyncHookJSONOutput {
  async: true;
  [key: string]: unknown;
}

export type HookJSONOutput = SyncHookJSONOutput | AsyncHookJSONOutput;

export type HookCallback = (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<HookJSONOutput>;

export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: PermissionUpdate[];
    blockedPath?: string;
    decisionReason?: string;
    toolUseID: string;
    agentID?: string;
    [key: string]: unknown;
  },
) => Promise<PermissionResult>;

export interface AgentUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [key: string]: unknown;
}

export interface AgentModelUsageEntry {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  webSearchRequests?: number;
  costUSD?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  [key: string]: unknown;
}

export interface AgentMessageBase {
  type: 'system' | 'assistant' | 'user' | 'result' | 'stream_event';
  parent_tool_use_id?: string | null;
  session_id?: string;
  uuid?: string;
  [key: string]: unknown;
}

export interface AgentSystemMessage extends AgentMessageBase {
  type: 'system';
  subtype?: string;
  model?: string;
  tools?: string[];
  status?: string | null;
  message?: string;
}

export interface AgentContentBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  [key: string]: unknown;
}

export type AgentAssistantMessageError =
  | 'authentication_failed'
  | 'billing_error'
  | 'rate_limit'
  | 'invalid_request'
  | 'server_error'
  | 'max_output_tokens'
  | 'unknown';

export interface AgentAssistantMessage extends AgentMessageBase {
  type: 'assistant';
  message: {
    content: AgentContentBlock[];
    model?: string;
    usage?: AgentUsage;
    [key: string]: unknown;
  };
  error?: AgentAssistantMessageError;
}

export interface AgentUserMessage extends AgentMessageBase {
  type: 'user';
  message: {
    role: 'user' | 'assistant';
    content: AgentContentBlock[] | string;
    [key: string]: unknown;
  };
}

export interface AgentResultMessage extends AgentMessageBase {
  type: 'result';
  subtype?: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  total_cost_usd?: number;
  cost_usd?: number;
  usage?: AgentUsage;
  modelUsage?: Record<string, AgentModelUsageEntry>;
  stop_reason?: string | null;
  num_turns?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  permission_denials?: unknown[];
  /**
   * Output tokens from the final API call only (vs `usage.output_tokens` which
   * is loop-total across all turns). Used by the empty_result_anomaly detector
   * to avoid false positives when earlier tool-use turns consumed tokens but
   * the final turn was legitimately empty ("model done after tools").
   *
   * Emitted by the Rebel Core runtime adapter; absent on legacy/SDK paths, in
   * which case the anomaly detector falls back to `usage.output_tokens`.
   *
   * See: docs/plans/260417_empty_result_anomaly_resilience.md
   */
  last_turn_output_tokens?: number;
  /**
   * Raw count of tool calls emitted by the executor itself (excludes synthetic
   * seed tools from planners). Used to verify the final model actually performed
   * work before returning 0 tokens.
   */
  executor_tool_count?: number;
}

export interface AgentStreamEventMessage extends AgentMessageBase {
  type: 'stream_event';
  event: Record<string, unknown>;
}

export type AgentMessage =
  | AgentSystemMessage
  | AgentAssistantMessage
  | AgentUserMessage
  | AgentResultMessage
  | AgentStreamEventMessage;

/**
 * Type guard to narrow `HookJSONOutput` to `SyncHookJSONOutput`.
 * `AsyncHookJSONOutput` always carries `{ async: true }`, so its absence
 * reliably identifies the sync variant.
 */
export const isSyncHookOutput = (output: HookJSONOutput): output is SyncHookJSONOutput =>
  !('async' in output);

/**
 * Extract text from an agent assistant message's content blocks.
 *
 * AgentAssistantMessage has NO `.text` property — text lives in
 * `message.message.content` (array of content blocks). This helper
 * is the canonical way to extract text; never access `.text` directly.
 *
 * See: docs-private/postmortems/260329_sdk_text_extraction_postmortem.md
 */
export function extractAgentAssistantText(msg: AgentAssistantMessage): string {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return '';
  const textBlocks: string[] = [];
  for (const block of content) {
    if (block != null && typeof block === "object") {
      const blockRecord = block as Record<string, unknown>;
      if (blockRecord.type !== "text") {
        continue;
      }
      const text = blockRecord.text;
      if (typeof text === "string") {
        textBlocks.push(text);
      }
    }
  }
  return textBlocks.join("\n").trim();
}
