/**
 * Sub-agent dispatcher tool names.
 *
 * Mirrored deliberately to break the agentTool.ts ⇄ agentLoop.ts circular
 * import (agentTool imports runAgentLoop). Adding a third-party module is
 * the cycle-free way to share these constants.
 *
 * If you add or rename a sub-agent dispatcher tool, update this file AND
 * the SUB_AGENT_TOOL_NAMES_DRIFT_GUARD test that asserts parity with
 * AGENT_TOOL_DEFINITION.name.
 */
export const SUB_AGENT_TOOL_NAMES = ['Agent', 'Task'] as const;
export type SubAgentToolName = typeof SUB_AGENT_TOOL_NAMES[number];

export function isSubAgentToolName(name: string): name is SubAgentToolName {
  return (SUB_AGENT_TOOL_NAMES as readonly string[]).includes(name);
}
