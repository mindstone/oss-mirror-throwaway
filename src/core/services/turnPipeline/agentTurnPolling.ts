// CORE-MOVE-EXEMPT: Stage 2.E.1 transitional split chunk pending Stage 2.F core move.

export {
  AUTOMATION_HARD_CEILING_MS,
  JUDGE_FAIL_OPEN_EXTENSION_MS,
  JUDGE_FIRE_OFFSET_MS,
  MAX_COMPLETED_TOOLS_THIS_TURN,
  MAX_CONSECUTIVE_FAIL_OPEN,
  MAX_PER_TOOL_WATCHDOG_CANCELS,
  resolveWatchdogJudgeCeiling,
  shouldFireWatchdogJudge,
  shouldAutoExtend,
  shouldApplyWatchdogJudgeResolution,
  shouldAbortForAutomationHardCeiling,
  applyWatchdogJudgeResult,
  applyWatchdogApprovalWaitCommitGate,
  resolveWatchdogMessageTimeoutMs,
} from './agentTurnExecute';
