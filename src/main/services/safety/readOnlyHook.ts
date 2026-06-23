/**
 * Read-Only Hook
 *
 * PreToolUse hook that blocks write operations during read-only evaluation mode.
 * Used by error recovery evaluation to ensure the agent can diagnose but not modify.
 *
 * Two layers of enforcement:
 * 1. Skill prompt instructs agent not to write (soft enforcement)
 * 2. This hook blocks write tools at runtime level (hard enforcement)
 */

import type { HookJSONOutput } from '@core/agentRuntimeTypes';
import { createScopedLogger } from '@core/logger';
import { FILE_WRITE_TOOLS } from './constants';

const log = createScopedLogger({ service: 'readOnlyHook' });

/**
 * Patterns for MCP tool names that indicate write operations.
 * MCP tools follow `mcp__servername__toolname` format.
 */
const MCP_WRITE_PATTERNS = [
  /write/i,
  /edit/i,
  /create/i,
  /delete/i,
  /remove/i,
  /update/i,
  /patch/i,
  /insert/i,
  /append/i,
];

/**
 * Shell/execution tools that could perform any operation.
 * Block these in read-only mode as they bypass our controls.
 */
const SHELL_TOOLS = /^(bash|shell|exec|run|execute|terminal|command)$/i;

/**
 * Tools that are explicitly allowed even if they match a write pattern.
 * These are read-only operations that happen to have "write-like" names.
 */
const ALLOWED_TOOL_OVERRIDES = [
  'rebel_diagnostics_export', // Diagnostics export (generates text, doesn't write files)
  'create_search',            // Search creation is a read operation
];

/**
 * Check if a tool name represents a write operation.
 */
export function isWriteOperation(toolName: string): boolean {
  // Check explicit overrides first
  if (ALLOWED_TOOL_OVERRIDES.includes(toolName)) {
    return false;
  }

  // Check built-in tools (exact match, case-sensitive)
  if (FILE_WRITE_TOOLS.includes(toolName as typeof FILE_WRITE_TOOLS[number])) {
    return true;
  }

  // Check shell/execution tools
  if (SHELL_TOOLS.test(toolName)) {
    return true;
  }

  // For MCP tools (mcp__server__tool format), check the tool part
  const parts = toolName.split('__');
  if (parts.length >= 3) {
    const mcpToolName = parts[parts.length - 1];
    
    // Check override for MCP tools too
    if (ALLOWED_TOOL_OVERRIDES.includes(mcpToolName)) {
      return false;
    }
    
    return MCP_WRITE_PATTERNS.some(pattern => pattern.test(mcpToolName));
  }

  return false;
}

export interface ReadOnlyHookOptions {
  /** Turn ID for logging correlation */
  turnId: string;
  /** Callback when a write operation is blocked */
  onBlocked?: (toolName: string) => void;
}

/**
 * Create a PreToolUse hook that blocks write operations.
 *
 * @example
 * ```typescript
 * const readOnlyHook = createReadOnlyHook({ turnId });
 * // Pass to executeAgentTurn via hooks.PreToolUse
 * ```
 */
export function createReadOnlyHook(options: ReadOnlyHookOptions) {
  const { turnId, onBlocked } = options;

  return async (
    input: { tool_name?: string; tool_input?: Record<string, unknown>; tool_use_id?: string },
    _toolUseID: string | undefined,
    _hookOptions: { signal: AbortSignal }
  ): Promise<HookJSONOutput> => {
    const toolName = input.tool_name ?? 'unknown';

    if (isWriteOperation(toolName)) {
      log.info(
        { turnId, toolName, blocked: true },
        'Read-only hook blocked write operation'
      );

      onBlocked?.(toolName);

      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            'Read-only evaluation mode: Write operations are not available during error diagnosis. ' +
            'Your task is to analyze and report findings, not to make changes. ' +
            'If you need to fix something, report what you found and the user can start a fix conversation.',
        },
      };
    }

    // Allow read operations - return empty object (no interference)
    log.debug({ turnId, toolName, allowed: true }, 'Read-only hook allowed tool');
    return {};
  };
}
