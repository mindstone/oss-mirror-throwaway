/**
 * Bookkeeping tool names — single source of truth.
 *
 * Tools whose end events represent planning/bookkeeping artifacts rather than
 * meaningful user-facing execution. Used by:
 *
 * - `agentMessageHandler.ts` — "Model done after tools" synthesis gate to
 *   avoid synthesizing "Done." when the only tools that ran were bookkeeping
 *   (e.g. MissionSet/TaskList/TodoWrite from a planning seed).
 * - `turnErrorRecovery.ts` — graceful-degradation tool-recovery path to
 *   avoid showing "completed some actions" when only bookkeeping ran.
 * - Cloud-client + renderer task/mission UI helpers — to de-emphasize tool
 *   rows when a promoted mission/task display is visible.
 *
 * These are read-only or in-process planning tools with no external side
 * effects. Their absence in a turn means the turn produced no meaningful
 * action; the model owes the user real text or real work.
 *
 * NOTE: This is distinct from `toolSafetyService.ts`'s `SKIP_TOOL_NAMES`,
 * which is a broader allowlist of tools that bypass LLM safety classification
 * (includes Task/Agent/AskUserQuestion/etc).
 *
 * If a future planning bookkeeping tool is added, update this list.
 */
export const BOOKKEEPING_TOOL_NAMES: ReadonlySet<string> = new Set([
  'MissionSet',
  'TaskList',
  'TaskCreate',
  'TaskUpdate',
  'TaskGet',
  'TodoWrite',
]);

/** Type guard helper. */
export const isBookkeepingTool = (toolName: string): boolean =>
  BOOKKEEPING_TOOL_NAMES.has(toolName);
