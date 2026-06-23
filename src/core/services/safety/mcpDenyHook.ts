/**
 * MCP Deny Hook
 *
 * PreToolUse hook that blocks all MCP tool calls.
 *
 * Used during memory-update turns where MCP tool definitions are included
 * for prompt cache alignment but should never be executed.
 * This is a string prefix check — zero latency, no LLM call.
 */

import type { HookJSONOutput } from '@core/agentRuntimeTypes';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'mcpDenyHook' });

/**
 * Create a PreToolUse hook that blocks all MCP tool calls.
 *
 * MCP tools follow the `mcp__servername__toolname` naming convention.
 * Any tool whose name starts with `mcp__` is denied with an informative reason.
 *
 * @example
 * ```typescript
 * const mcpDenyHook = createMcpDenyHook();
 * // Pass to executeAgentTurn via hooks.PreToolUse
 * ```
 */
export function createMcpDenyHook(): (
  input: { tool_name?: string; tool_input?: Record<string, unknown>; tool_use_id?: string },
  toolUseID: string | undefined,
  options: { signal: AbortSignal }
) => Promise<HookJSONOutput> {
  return async (input) => {
    if (input.tool_name?.startsWith('mcp__')) {
      log.warn(
        { tool_name: input.tool_name },
        'Blocked MCP tool call during memory-update turn'
      );
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: 'MCP tools are not available during memory updates',
        },
      };
    }

    return {};
  };
}
