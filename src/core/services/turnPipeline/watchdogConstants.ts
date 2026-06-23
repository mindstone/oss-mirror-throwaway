// Leaf module for watchdog timing constants. Imported by both agentTurnExecute and turnPolicy without creating a cycle.
export const JUDGE_FIRE_OFFSET_MS = 5 * 60_000;
export const AUTOMATION_HARD_CEILING_MS = 90 * 60_000;
export const JUDGE_FAIL_OPEN_EXTENSION_MS = 10 * 60_000;
export const MAX_CONSECUTIVE_FAIL_OPEN = 3;
export const MAX_COMPLETED_TOOLS_THIS_TURN = 50;
export const TOOL_CANCEL_GRACE_MS = 30_000;
export const MAX_PER_TOOL_WATCHDOG_CANCELS = 2;
