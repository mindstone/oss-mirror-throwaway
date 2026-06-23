import { describe, expect, it } from 'vitest';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  mapAnthropicStreamEvent,
  mapOpenAIChatChunk,
  mapOpenAIResponsesEvent,
  serializeRuntimeActivityForTelemetry,
  type RuntimeActivityEvent,
} from '@core/rebelCore/runtimeActivity';
import {
  WatchdogTracker,
  WATCHDOG_THRESHOLDS,
  WATCHDOG_THRESHOLDS_SUBAGENT,
  AUTO_ABORT_MS,
  STREAMING_STALL_ABORT_MS,
  AWAITING_API_STALL_ABORT_MS,
  AWAITING_API_SOFT_STALL_MS,
  formatWatchdogAutoAbortMessage,
  inferWatchdogPhase,
  shouldSuppressLevel1WatchdogCapture,
  isAwaitingApiHardStall,
  isAwaitingApiSoftStall,
} from '../watchdogTracker';

// Agent message factories
const taskToolUse = (id: string) => ({
  type: 'assistant' as const,
  message: { content: [{ type: 'tool_use', id, name: 'Task', input: {} }] },
});

const agentToolUse = (id: string) => ({
  type: 'assistant' as const,
  message: { content: [{ type: 'tool_use', id, name: 'Agent', input: {} }] },
});

const taskToolResult = (toolUseId: string) => ({
  type: 'user' as const,
  message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'done' }] },
});

const webSearchToolUse = (id: string) => ({
  type: 'assistant' as const,
  message: { content: [{ type: 'tool_use', id, name: 'WebSearch', input: {} }] },
});

const assistantText = () => ({
  type: 'assistant' as const,
  message: { content: [{ type: 'text', text: 'Hello' }] },
});

const resultMsg = () => ({
  type: 'result' as const,
  message: { content: [] },
});

const errorMsg = () => ({
  type: 'error' as const,
  message: { content: [] },
});

describe('WatchdogTracker', () => {
  // =========================================================================
  // Threshold selection — normal vs subagent
  // =========================================================================
  describe('threshold selection', () => {
    it('fires at 30s with normal thresholds when no subagent is active', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      // 25s — below threshold
      let result = wd.check(t0 + 25_000);
      expect(result.escalated).toBe(false);
      expect(result.level).toBe(0);

      // 35s — above 30s threshold
      result = wd.check(t0 + 35_000);
      expect(result.escalated).toBe(true);
      expect(result.level).toBe(1);
      expect(result.hasActiveSubagent).toBe(false);
    });

    it('does NOT fire at 30s when subagent is active (uses extended 120s threshold)', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      // Start a Task subagent
      wd.onMessage(taskToolUse('task-1'), t0 + 100);

      // 35s after last message — below subagent threshold of 120s
      let result = wd.check(t0 + 35_100);
      expect(result.escalated).toBe(false);
      expect(result.level).toBe(0);
      expect(result.hasActiveSubagent).toBe(true);

      // 125s after last message — above subagent threshold
      result = wd.check(t0 + 125_100);
      expect(result.escalated).toBe(true);
      expect(result.level).toBe(1);
      expect(result.hasActiveSubagent).toBe(true);
    });

    it('reverts to normal thresholds after subagent completes', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      // Start and complete a subagent
      wd.onMessage(taskToolUse('task-1'), t0 + 100);
      wd.onMessage(taskToolResult('task-1'), t0 + 200);

      // 35s after last message — uses normal 30s threshold now
      const result = wd.check(t0 + 35_200);
      expect(result.escalated).toBe(true);
      expect(result.level).toBe(1);
      expect(result.hasActiveSubagent).toBe(false);
    });

    it('uses correct thresholds arrays', () => {
      expect(WATCHDOG_THRESHOLDS).toEqual([30_000, 60_000, 120_000, 300_000, 600_000]);
      expect(WATCHDOG_THRESHOLDS_SUBAGENT).toEqual([120_000, 180_000, 240_000, 300_000, 600_000]);
      expect(AUTO_ABORT_MS).toBe(1_800_000);
    });

    it('marks watchdog-cancelled tools settled and re-anchors silence without clearing telemetry', () => {
      const t0 = 1_000_000;
      const wd = new WatchdogTracker(t0);
      wd.onMessage(taskToolUse('task-1'), t0 + 100);
      const fired = wd.check(t0 + 130_000);
      expect(fired.escalated).toBe(true);
      expect(wd.fired).toBe(true);
      expect(wd.firedAt).toBe(t0 + 130_000);
      expect(wd.maxWatchdogLevel).toBe(1);
      expect(wd.toolsInFlightCount).toBe(1);
      expect(wd.hasActiveSubagent).toBe(true);

      wd.markToolCancelledForWatchdog('task-1', t0 + 131_000);

      expect(wd.watchdogLevel).toBe(0);
      expect(wd.toolsInFlightCount).toBe(0);
      expect(wd.hasActiveSubagent).toBe(false);
      expect(wd.fired).toBe(true);
      expect(wd.firedAt).toBe(t0 + 130_000);
      expect(wd.maxWatchdogLevel).toBe(1);
      expect(wd.check(t0 + 132_000).silentMs).toBe(1_000);
    });

    it('does NOT fire at exact threshold boundary (strict > check)', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      // Exactly 30_000ms — should NOT trigger (logic is strict >)
      let result = wd.check(t0 + 30_000);
      expect(result.escalated).toBe(false);
      expect(result.level).toBe(0);

      // 30_001ms — should trigger
      result = wd.check(t0 + 30_001);
      expect(result.escalated).toBe(true);
      expect(result.level).toBe(1);
    });

    it('boundary test for all normal threshold values', () => {
      const t0 = 1000000;
      const thresholds = [30_000, 60_000, 120_000, 300_000, 600_000];

      for (let i = 0; i < thresholds.length; i++) {
        const wd = new WatchdogTracker(t0);
        // Put a tool in flight so streaming stall abort (3 min) doesn't interfere
        // with testing all 5 progressive threshold levels
        wd.onMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'TestTool', id: 'test-1' }] } }, t0);
        // Force level up to i so we can test the next threshold
        for (let j = 0; j < i; j++) {
          wd.check(t0 + thresholds[j] + 1);
        }

        // At exact threshold — should NOT escalate
        const atBoundary = wd.check(t0 + thresholds[i]);
        expect(atBoundary.escalated).toBe(false);

        // Just past threshold — should escalate
        const pastBoundary = wd.check(t0 + thresholds[i] + 1);
        expect(pastBoundary.escalated).toBe(true);
        expect(pastBoundary.level).toBe(i + 1);
      }
    });

    it('boundary test for subagent threshold values', () => {
      const t0 = 1000000;
      const thresholds = [120_000, 180_000, 240_000, 300_000, 600_000];

      for (let i = 0; i < thresholds.length; i++) {
        const wd = new WatchdogTracker(t0);
        wd.onMessage(taskToolUse('task-1'), t0 + 1);
        // Force level up to i
        for (let j = 0; j < i; j++) {
          wd.check(t0 + thresholds[j] + 2);
        }

        // At exact threshold — should NOT escalate
        const atBoundary = wd.check(t0 + thresholds[i] + 1);
        expect(atBoundary.escalated).toBe(false);

        // Just past threshold — should escalate
        const pastBoundary = wd.check(t0 + thresholds[i] + 2);
        expect(pastBoundary.escalated).toBe(true);
        expect(pastBoundary.level).toBe(i + 1);
      }
    });

    it('boundary test for auto-abort threshold (with tool in flight)', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);
      // Put a tool in flight so AUTO_ABORT_MS applies instead of STREAMING_STALL_ABORT_MS
      wd.onMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'TestTool', id: 'test-1' }] } }, t0);

      // At exact AUTO_ABORT_MS — should NOT abort
      let result = wd.check(t0 + AUTO_ABORT_MS);
      expect(result.shouldAbort).toBe(false);

      // Just past — should abort
      result = wd.check(t0 + AUTO_ABORT_MS + 1);
      expect(result.shouldAbort).toBe(true);
    });
  });

  // =========================================================================
  // Subagent tracking
  // =========================================================================
  describe('subagent tracking', () => {
    it('tracks Agent tools in active subagent set', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      wd.onMessage(agentToolUse('agent-a'), t0 + 10);
      wd.onMessage(agentToolUse('agent-b'), t0 + 20);

      expect(wd.hasActiveSubagent).toBe(true);
      expect(wd.activeSubagentCount).toBe(2);
    });

    it('Agent tool_use extends threshold selection like Task', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      wd.onMessage(agentToolUse('agent-1'), t0 + 100);

      // 35s after last message — below subagent threshold of 120s
      let result = wd.check(t0 + 35_100);
      expect(result.escalated).toBe(false);
      expect(result.level).toBe(0);
      expect(result.hasActiveSubagent).toBe(true);

      // 125s after last message — above subagent threshold
      result = wd.check(t0 + 125_100);
      expect(result.escalated).toBe(true);
      expect(result.level).toBe(1);
      expect(result.hasActiveSubagent).toBe(true);
    });

    it('completing an Agent tool removes it from the active subagent set', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      wd.onMessage(agentToolUse('agent-1'), t0 + 100);
      expect(wd.activeSubagentCount).toBe(1);

      wd.onMessage(taskToolResult('agent-1'), t0 + 200);
      expect(wd.hasActiveSubagent).toBe(false);
      expect(wd.activeSubagentCount).toBe(0);
    });

    it('tracks multiple parallel Task tools and decrements correctly', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      // Start 3 parallel Task tools
      wd.onMessage(taskToolUse('task-a'), t0 + 10);
      wd.onMessage(taskToolUse('task-b'), t0 + 20);
      wd.onMessage(taskToolUse('task-c'), t0 + 30);

      expect(wd.hasActiveSubagent).toBe(true);
      expect(wd.activeSubagentCount).toBe(3);

      // Complete one — two should remain
      wd.onMessage(taskToolResult('task-a'), t0 + 40);
      expect(wd.activeSubagentCount).toBe(2);

      // Check uses extended thresholds
      const result = wd.check(t0 + 125_040);
      expect(result.hasActiveSubagent).toBe(true);
      expect(result.activeSubagentCount).toBe(2);
    });

    it('interleaved parallel tasks: ending A leaves B active', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      wd.onMessage(taskToolUse('task-a'), t0 + 10);
      wd.onMessage(taskToolUse('task-b'), t0 + 20);
      wd.onMessage(taskToolResult('task-a'), t0 + 30);

      expect(wd.hasActiveSubagent).toBe(true);
      expect(wd.activeSubagentCount).toBe(1);

      // 35s — should NOT trigger (extended thresholds still active)
      const result = wd.check(t0 + 35_030);
      expect(result.escalated).toBe(false);
    });

    it('non-Task tool_use does not activate subagent tracking', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      wd.onMessage(webSearchToolUse('ws-1'), t0 + 100);
      expect(wd.hasActiveSubagent).toBe(false);
      expect(wd.activeSubagentCount).toBe(0);

      // Normal 30s threshold applies
      const result = wd.check(t0 + 35_100);
      expect(result.escalated).toBe(true);
      expect(result.hasActiveSubagent).toBe(false);
    });

    it('terminal result message clears all active subagents', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      wd.onMessage(taskToolUse('task-a'), t0 + 10);
      wd.onMessage(taskToolUse('task-b'), t0 + 20);
      expect(wd.activeSubagentCount).toBe(2);

      wd.onMessage(resultMsg(), t0 + 30);
      expect(wd.activeSubagentCount).toBe(0);
      expect(wd.hasActiveSubagent).toBe(false);
    });

    it('terminal error message clears all active subagents', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      wd.onMessage(taskToolUse('task-a'), t0 + 10);
      wd.onMessage(errorMsg(), t0 + 20);
      expect(wd.activeSubagentCount).toBe(0);
    });

    it('Task tool with missing id is not tracked as subagent', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      wd.onMessage({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Task', input: {} }] },
      }, t0 + 100);

      // No id → not tracked
      expect(wd.hasActiveSubagent).toBe(false);
    });

    it('tool_result for unknown id does not crash', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      // Should not throw
      wd.onMessage(taskToolResult('nonexistent-id'), t0 + 100);
      expect(wd.hasActiveSubagent).toBe(false);
    });
  });

  // =========================================================================
  // Level progression and reset
  // =========================================================================
  describe('level progression and reset', () => {
    it('escalates progressively through multiple thresholds', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);
      // Put a tool in flight so streaming stall abort (3 min) doesn't interfere
      wd.onMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'TestTool', id: 'test-1' }] } }, t0 + 1);

      // Level 1 at 30s
      let result = wd.check(t0 + 35_000);
      expect(result.escalated).toBe(true);
      expect(result.level).toBe(1);

      // Level 2 at 60s
      result = wd.check(t0 + 65_000);
      expect(result.escalated).toBe(true);
      expect(result.level).toBe(2);

      // Level 3 at 120s
      result = wd.check(t0 + 125_000);
      expect(result.escalated).toBe(true);
      expect(result.level).toBe(3);

      // Level 4 at 300s
      result = wd.check(t0 + 305_000);
      expect(result.escalated).toBe(true);
      expect(result.level).toBe(4);

      // Level 5 at 600s
      result = wd.check(t0 + 605_000);
      expect(result.escalated).toBe(true);
      expect(result.level).toBe(5);
    });

    it('does not re-escalate at same level on subsequent checks', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      const result1 = wd.check(t0 + 35_000);
      expect(result1.escalated).toBe(true);
      expect(result1.level).toBe(1);

      // Same check again — still level 1, but no escalation
      const result2 = wd.check(t0 + 40_000);
      expect(result2.escalated).toBe(false);
      expect(result2.level).toBe(1);
    });

    it('resets level to 0 on message and preserves maxLevel', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      // Escalate to level 2
      wd.check(t0 + 35_000);
      wd.check(t0 + 65_000);
      expect(wd.watchdogLevel).toBe(2);
      expect(wd.maxWatchdogLevel).toBe(2);

      // Message arrives — reset
      const resetResult = wd.onMessage(assistantText(), t0 + 70_000);
      expect(resetResult.levelWasReset).toBe(true);
      expect(resetResult.previousLevel).toBe(2);
      expect(wd.watchdogLevel).toBe(0);
      expect(wd.maxWatchdogLevel).toBe(2); // Never reset
    });

    it('re-triggers at level 1 after reset (not continuing from previous level)', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      // Reach level 2
      wd.check(t0 + 35_000);
      wd.check(t0 + 65_000);

      // Reset with message
      wd.onMessage(assistantText(), t0 + 70_000);
      expect(wd.watchdogLevel).toBe(0);

      // New silence — triggers at level 1 again (not 3)
      const result = wd.check(t0 + 105_000); // 35s after reset
      expect(result.escalated).toBe(true);
      expect(result.level).toBe(1);
    });

    it('preserves fired/firedAt across resets', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      wd.check(t0 + 35_000); // First fire
      expect(wd.fired).toBe(true);
      expect(wd.firedAt).toBe(t0 + 35_000);

      // Reset
      wd.onMessage(assistantText(), t0 + 40_000);

      // fired/firedAt not reset
      expect(wd.fired).toBe(true);
      expect(wd.firedAt).toBe(t0 + 35_000);
    });

    it('isFirstFire is true only on first escalation', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      const first = wd.check(t0 + 35_000);
      expect(first.isFirstFire).toBe(true);

      // Escalate to level 2
      const second = wd.check(t0 + 65_000);
      expect(second.isFirstFire).toBe(false);

      // Reset and re-fire
      wd.onMessage(assistantText(), t0 + 70_000);
      const third = wd.check(t0 + 105_000);
      expect(third.isFirstFire).toBe(false); // Already fired once this turn
    });

    it('no reset logged when level was already 0', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      // No stall yet — message should not report a reset
      const result = wd.onMessage(assistantText(), t0 + 1000);
      expect(result.levelWasReset).toBe(false);
      expect(result.previousLevel).toBe(0);
    });
  });

  // =========================================================================
  // Auto-abort safety net
  // =========================================================================
  describe('auto-abort', () => {
    it('triggers auto-abort at AUTO_ABORT_MS (tool-in-flight ceiling)', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      const result = wd.check(t0 + AUTO_ABORT_MS + 1000);
      expect(result.shouldAbort).toBe(true);
      expect(result.escalated).toBe(true);
      expect(result.level).toBe(WATCHDOG_THRESHOLDS.length + 1); // Level 6
    });

    it('auto-abort triggers even with active subagent', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      wd.onMessage(taskToolUse('task-1'), t0 + 100);

      const result = wd.check(t0 + AUTO_ABORT_MS + 1100);
      expect(result.shouldAbort).toBe(true);
      expect(result.hasActiveSubagent).toBe(true);
    });

    it('does NOT auto-abort before streaming stall threshold (10 min) when no tool in flight', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      const result = wd.check(t0 + 590_000); // 9m50s — under 10min streaming stall threshold
      expect(result.shouldAbort).toBe(false);
    });

    it('auto-aborts after streaming stall threshold (10 min) when no tool in flight', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      const result = wd.check(t0 + 610_000); // 10m10s — over 10min streaming stall threshold
      expect(result.shouldAbort).toBe(true);
    });

    it('does NOT auto-abort before AUTO_ABORT_MS when tool is in flight', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);
      wd.onMessage(webSearchToolUse('ws-1'), t0 + 100);

      const result = wd.check(t0 + AUTO_ABORT_MS - 1000);
      expect(result.shouldAbort).toBe(false);
    });
  });

  // =========================================================================
  // Tool tracking state
  // =========================================================================
  describe('tool tracking', () => {
    it('tracks lastToolName from tool_use messages', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      wd.onMessage(webSearchToolUse('ws-1'), t0 + 100);
      expect(wd.lastToolName).toBe('WebSearch');

      wd.onMessage(taskToolUse('task-1'), t0 + 200);
      expect(wd.lastToolName).toBe('Task');
    });

    it('sets toolInFlightSince on tool_use and clears on tool_result', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      wd.onMessage(webSearchToolUse('ws-1'), t0 + 100);
      expect(wd.toolInFlightSince).toBe(t0 + 100);

      wd.onMessage(taskToolResult('ws-1'), t0 + 200);
      expect(wd.toolInFlightSince).toBeUndefined();
    });

    it('clears toolInFlightSince on result/error messages', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      wd.onMessage(webSearchToolUse('ws-1'), t0 + 100);
      expect(wd.toolInFlightSince).toBe(t0 + 100);

      wd.onMessage(resultMsg(), t0 + 200);
      expect(wd.toolInFlightSince).toBeUndefined();
    });
  });

  // =========================================================================
  // Phase inference
  // =========================================================================
  describe('phase inference', () => {
    it('infers correct phases from message types and tool state', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      // Initial state — no messages yet
      expect(wd.inferPhase()).toBe('awaiting_api');

      // After assistant text message (no tool_use) — streaming
      wd.onMessage(assistantText(), t0 + 100);
      expect(wd.inferPhase()).toBe('streaming');

      // After assistant tool_use — tool is in flight → awaiting_tool
      wd.onMessage(webSearchToolUse('ws-1'), t0 + 200);
      expect(wd.inferPhase()).toBe('awaiting_tool');

      // After user (tool_result) — tool completed, waiting for model → awaiting_api
      wd.onMessage(taskToolResult('ws-1'), t0 + 300);
      expect(wd.inferPhase()).toBe('awaiting_api');

      // After result message — turn complete → processing
      wd.onMessage(resultMsg(), t0 + 400);
      expect(wd.inferPhase()).toBe('processing');
    });

    it('infers streaming phase for stream_event messages', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);
      wd.onMessage({ type: 'stream_event' }, t0 + 100);
      expect(wd.inferPhase()).toBe('streaming');
    });

    it('infers awaiting_api phase for system messages', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);
      wd.onMessage({ type: 'system' }, t0 + 100);
      expect(wd.inferPhase()).toBe('awaiting_api');
    });

    it('infers awaiting_tool when tool is in flight (not based on message.type)', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      // Start a Task tool — should be awaiting_tool
      wd.onMessage(taskToolUse('task-1'), t0 + 100);
      expect(wd.inferPhase()).toBe('awaiting_tool');

      // Start another tool while Task is active — still awaiting_tool
      wd.onMessage(webSearchToolUse('ws-1'), t0 + 200);
      expect(wd.inferPhase()).toBe('awaiting_tool');

      // Complete websearch — Task is still in flight → awaiting_tool
      // (toolsInFlight Map tracks each tool independently by tool_use_id)
      wd.onMessage(taskToolResult('ws-1'), t0 + 300);
      expect(wd.inferPhase()).toBe('awaiting_tool');

      // Complete Task — all tools done → awaiting_api
      wd.onMessage(taskToolResult('task-1'), t0 + 400);
      expect(wd.inferPhase()).toBe('awaiting_api');
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================
  describe('edge cases', () => {
    it('rapid message burst after silence resets level and restarts threshold', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      // Silence to level 1
      wd.check(t0 + 35_000);
      expect(wd.watchdogLevel).toBe(1);

      // Burst of messages
      for (let i = 0; i < 5; i++) {
        wd.onMessage(assistantText(), t0 + 36_000 + i * 10);
      }
      expect(wd.watchdogLevel).toBe(0);

      // 25s after last burst message — still below 30s threshold
      const result = wd.check(t0 + 61_050);
      expect(result.escalated).toBe(false);
      expect(result.level).toBe(0);
    });

    it('subagent extended thresholds escalate progressively', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      wd.onMessage(taskToolUse('task-1'), t0 + 100);

      // Level 1 at 120s
      let result = wd.check(t0 + 125_100);
      expect(result.escalated).toBe(true);
      expect(result.level).toBe(1);

      // Level 2 at 180s
      result = wd.check(t0 + 185_100);
      expect(result.escalated).toBe(true);
      expect(result.level).toBe(2);

      // Level 3 at 240s
      result = wd.check(t0 + 245_100);
      expect(result.escalated).toBe(true);
      expect(result.level).toBe(3);
    });

    it('completing last subagent mid-silence switches thresholds', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      wd.onMessage(taskToolUse('task-1'), t0 + 100);

      // 35s silence — no fire (subagent active)
      let result = wd.check(t0 + 35_100);
      expect(result.escalated).toBe(false);

      // Complete subagent at 40s
      wd.onMessage(taskToolResult('task-1'), t0 + 40_000);

      // Next check at 75s (35s after completion) — should fire on normal threshold
      result = wd.check(t0 + 75_000);
      expect(result.escalated).toBe(true);
      expect(result.level).toBe(1);
      expect(result.hasActiveSubagent).toBe(false);
    });

    it('maxWatchdogLevel tracks highest level even across multiple resets', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      // Escalate to level 3
      wd.check(t0 + 35_000);
      wd.check(t0 + 65_000);
      wd.check(t0 + 125_000);
      expect(wd.maxWatchdogLevel).toBe(3);

      // Reset
      wd.onMessage(assistantText(), t0 + 130_000);

      // Only reach level 1 this time
      wd.check(t0 + 165_000);
      expect(wd.watchdogLevel).toBe(1);
      expect(wd.maxWatchdogLevel).toBe(3); // Still 3
    });

    it('handles empty content arrays gracefully', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      // Empty content
      wd.onMessage({ type: 'assistant', message: { content: [] } }, t0 + 100);
      expect(wd.hasActiveSubagent).toBe(false);

      // No message property
      wd.onMessage({ type: 'assistant' }, t0 + 200);
      expect(wd.hasActiveSubagent).toBe(false);
    });

    it('skipCommit prevents state mutation (approval-wait parity)', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      // Check with skipCommit — should report escalation but NOT mutate state
      const result = wd.check(t0 + 35_000, /* skipCommit */ true);
      expect(result.escalated).toBe(true);
      expect(result.level).toBe(1);

      // Internal state should be unchanged
      expect(wd.watchdogLevel).toBe(0);
      expect(wd.maxWatchdogLevel).toBe(0);
      expect(wd.fired).toBe(false);
    });

    it('commitCheck applies deferred state from skipCommit', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      const result = wd.check(t0 + 35_000, /* skipCommit */ true);
      expect(wd.watchdogLevel).toBe(0); // Not committed yet

      // Now commit
      wd.commitCheck(result, t0 + 35_000);
      expect(wd.watchdogLevel).toBe(1);
      expect(wd.maxWatchdogLevel).toBe(1);
      expect(wd.fired).toBe(true);
    });

    it('skipped commit does not block future checks', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      // Skip commit at 35s
      wd.check(t0 + 35_000, /* skipCommit */ true);
      expect(wd.watchdogLevel).toBe(0);

      // Normal check at 40s — should still escalate since level is still 0
      const result = wd.check(t0 + 40_000);
      expect(result.escalated).toBe(true);
      expect(result.level).toBe(1);
      expect(wd.watchdogLevel).toBe(1);
    });

    it('multiple stall/reset cycles track maxLevel correctly', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      // Cycle 1: escalate to level 3
      wd.check(t0 + 35_000);
      wd.check(t0 + 65_000);
      wd.check(t0 + 125_000);
      expect(wd.maxWatchdogLevel).toBe(3);

      // Reset
      wd.onMessage(assistantText(), t0 + 130_000);

      // Cycle 2: escalate to level 2
      wd.check(t0 + 165_000);
      wd.check(t0 + 195_000);
      expect(wd.watchdogLevel).toBe(2);
      expect(wd.maxWatchdogLevel).toBe(3); // Still 3 from cycle 1

      // Reset
      wd.onMessage(assistantText(), t0 + 200_000);

      // Cycle 3: escalate to level 4 (with tool in flight to use 15-min threshold)
      wd.onMessage(webSearchToolUse('ws-1'), t0 + 200_100);
      wd.check(t0 + 235_000);
      wd.check(t0 + 265_000);
      wd.check(t0 + 325_000);
      wd.check(t0 + 505_000);
      expect(wd.watchdogLevel).toBe(4);
      expect(wd.maxWatchdogLevel).toBe(4); // Updated to 4

      // firedAt should still be from first fire
      expect(wd.firedAt).toBe(t0 + 35_000);
    });

    it('handles content blocks without expected properties', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      // Block with type but no name
      wd.onMessage({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'x' }] },
      }, t0 + 100);
      expect(wd.hasActiveSubagent).toBe(false);

      // Block with null values
      wd.onMessage({
        type: 'user',
        message: { content: [{ type: 'tool_result' }] },
      }, t0 + 200);
      expect(wd.hasActiveSubagent).toBe(false);
    });
  });

  // =========================================================================
  // activityAgeMs — unified liveness support
  // =========================================================================
  describe('activityAgeMs', () => {
    it('shortens silentMs when activityAgeMs is less than message age', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      // 40s since last message (above 30s threshold normally),
      // but activityAgeMs says only 20s since last raw activity
      const result = wd.check(t0 + 40_000, false, 20_000);
      expect(result.silentMs).toBe(20_000);
      expect(result.escalated).toBe(false); // 20s < 30s threshold
      expect(result.level).toBe(0);
    });

    it('does not lengthen silentMs when activityAgeMs exceeds message age', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      // 40s since last message, but activityAgeMs is 60s (stale external data)
      const result = wd.check(t0 + 40_000, false, 60_000);
      expect(result.silentMs).toBe(40_000); // min(40_000, 60_000)
      expect(result.escalated).toBe(true);
      expect(result.level).toBe(1);
    });

    it('does not affect behavior when undefined (backwards compatible)', () => {
      const t0 = 1000000;
      const wd1 = new WatchdogTracker(t0);
      const wd2 = new WatchdogTracker(t0);

      // Check without activityAgeMs
      const result1 = wd1.check(t0 + 40_000);
      // Check with activityAgeMs=undefined (explicit)
      const result2 = wd2.check(t0 + 40_000, false, undefined);

      expect(result1.silentMs).toBe(result2.silentMs);
      expect(result1.level).toBe(result2.level);
      expect(result1.escalated).toBe(result2.escalated);
    });

    it('prevents abort when activityAgeMs keeps silentMs below threshold', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      // 11 min since last message (above 10min streaming stall), but activity is recent
      const result = wd.check(t0 + 660_000, false, 5_000);
      expect(result.silentMs).toBe(5_000);
      expect(result.shouldAbort).toBe(false);
    });

    it('works correctly with skipCommit', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      const result = wd.check(t0 + 40_000, true, 20_000);
      expect(result.silentMs).toBe(20_000);
      expect(result.escalated).toBe(false);
      // State should not be mutated
      expect(wd.watchdogLevel).toBe(0);
    });

    it('interacts correctly with subagent extended thresholds', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);
      wd.onMessage(taskToolUse('task-1'), t0 + 100);

      // 130s since message (above subagent 120s threshold),
      // but activityAgeMs is only 100s (below 120s)
      const result = wd.check(t0 + 130_100, false, 100_000);
      expect(result.silentMs).toBe(100_000);
      expect(result.escalated).toBe(false);
      expect(result.hasActiveSubagent).toBe(true);
    });
  });

  // =========================================================================
  // effectiveAbortMs in check results
  // =========================================================================
  describe('effectiveAbortMs', () => {
    it('returns STREAMING_STALL_ABORT_MS when no tool in flight and no subagent', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      const result = wd.check(t0 + 10_000);
      expect(result.effectiveAbortMs).toBe(STREAMING_STALL_ABORT_MS);
    });

    it('returns AUTO_ABORT_MS when tool is in flight', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);
      wd.onMessage(webSearchToolUse('ws-1'), t0 + 100);

      const result = wd.check(t0 + 10_100);
      expect(result.effectiveAbortMs).toBe(AUTO_ABORT_MS);
    });

    it('returns AUTO_ABORT_MS when subagent is active (even if no tool in flight)', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);
      wd.onMessage(taskToolUse('task-1'), t0 + 100);
      // Complete the tool_use (clears toolInFlightSince) but Task stays active
      // Actually, Task tool_use sets toolInFlightSince, so let's use a scenario
      // where we have an active subagent but tool result clears toolInFlightSince
      // — not possible since the Task is itself the tool in flight.
      // Let's just verify with active subagent:
      const result = wd.check(t0 + 10_100);
      expect(result.effectiveAbortMs).toBe(AUTO_ABORT_MS);
      expect(result.hasActiveSubagent).toBe(true);
    });

    it('transitions from AUTO_ABORT_MS to STREAMING_STALL_ABORT_MS after tool completes', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);
      wd.onMessage(webSearchToolUse('ws-1'), t0 + 100);

      const duringTool = wd.check(t0 + 10_100);
      expect(duringTool.effectiveAbortMs).toBe(AUTO_ABORT_MS);

      // Complete the tool
      wd.onMessage(taskToolResult('ws-1'), t0 + 20_000);

      const afterTool = wd.check(t0 + 30_000);
      expect(afterTool.effectiveAbortMs).toBe(STREAMING_STALL_ABORT_MS);
    });

    it('is consistent with shouldAbort decision', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);

      // Just past streaming stall threshold, no tool in flight
      const result = wd.check(t0 + STREAMING_STALL_ABORT_MS + 1);
      expect(result.effectiveAbortMs).toBe(STREAMING_STALL_ABORT_MS);
      expect(result.shouldAbort).toBe(true);
      expect(result.silentMs).toBeGreaterThan(result.effectiveAbortMs);
    });

    it('uses extendedCeilingMs when it is greater than computed effectiveAbortMs', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);
      wd.onMessage(webSearchToolUse('ws-1'), t0 + 100); // computed ceiling: AUTO_ABORT_MS

      const extendedCeilingMs = AUTO_ABORT_MS + 5 * 60_000;
      const result = wd.check(t0 + 10_100, false, undefined, extendedCeilingMs);
      expect(result.effectiveAbortMs).toBe(extendedCeilingMs);
    });

    it('ignores extendedCeilingMs when it is less than or equal to computed effectiveAbortMs', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);
      wd.onMessage(webSearchToolUse('ws-1'), t0 + 100); // computed ceiling: AUTO_ABORT_MS

      const result = wd.check(t0 + 10_100, false, undefined, AUTO_ABORT_MS - 1);
      expect(result.effectiveAbortMs).toBe(AUTO_ABORT_MS);
    });

    it('keeps behavior unchanged when extendedCeilingMs is undefined', () => {
      const t0 = 1000000;
      const wdWithoutOverride = new WatchdogTracker(t0);
      const wdWithUndefinedOverride = new WatchdogTracker(t0);

      const withoutOverride = wdWithoutOverride.check(t0 + 40_000);
      const withUndefinedOverride = wdWithUndefinedOverride.check(t0 + 40_000, false, undefined, undefined);

      expect(withUndefinedOverride.effectiveAbortMs).toBe(withoutOverride.effectiveAbortMs);
      expect(withUndefinedOverride.shouldAbort).toBe(withoutOverride.shouldAbort);
      expect(withUndefinedOverride.level).toBe(withoutOverride.level);
    });

    it('uses the extended ceiling for shouldAbort decisions', () => {
      const t0 = 1000000;
      const extendedCeilingMs = AUTO_ABORT_MS + 5 * 60_000;

      const wdBeforeExtendedCeiling = new WatchdogTracker(t0);
      wdBeforeExtendedCeiling.onMessage(webSearchToolUse('ws-1'), t0 + 100);
      const beforeExtendedAbort = wdBeforeExtendedCeiling.check(t0 + AUTO_ABORT_MS + 101);
      expect(beforeExtendedAbort.shouldAbort).toBe(true);

      const wdWithExtendedCeiling = new WatchdogTracker(t0);
      wdWithExtendedCeiling.onMessage(webSearchToolUse('ws-1'), t0 + 100);
      const beforeExtendedThreshold = wdWithExtendedCeiling.check(
        t0 + AUTO_ABORT_MS + 101,
        false,
        undefined,
        extendedCeilingMs,
      );
      expect(beforeExtendedThreshold.effectiveAbortMs).toBe(extendedCeilingMs);
      expect(beforeExtendedThreshold.shouldAbort).toBe(false);

      const afterExtendedThreshold = wdWithExtendedCeiling.check(
        t0 + extendedCeilingMs + 101,
        false,
        undefined,
        extendedCeilingMs,
      );
      expect(afterExtendedThreshold.shouldAbort).toBe(true);
    });

    it('reverts to computed threshold when an extension is removed on the next check', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);
      wd.onMessage(webSearchToolUse('ws-1'), t0 + 100); // computed ceiling: AUTO_ABORT_MS
      const extendedCeilingMs = AUTO_ABORT_MS + 5 * 60_000;

      const withExtension = wd.check(t0 + AUTO_ABORT_MS + 101, false, undefined, extendedCeilingMs);
      expect(withExtension.effectiveAbortMs).toBe(extendedCeilingMs);
      expect(withExtension.shouldAbort).toBe(false);

      const withoutExtension = wd.check(t0 + AUTO_ABORT_MS + 101, false, undefined, undefined);
      expect(withoutExtension.effectiveAbortMs).toBe(AUTO_ABORT_MS);
      expect(withoutExtension.shouldAbort).toBe(true);
    });

    it('applies larger extendedCeilingMs even on streaming-stall checks; phase binding is executor-owned', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);
      const extendedCeilingMs = AUTO_ABORT_MS;

      // Stage 0 contract: tracker stays phase-agnostic and applies any larger override.
      // Stage 4 executor wiring decides when a provided extension should be active.
      const result = wd.check(
        t0 + STREAMING_STALL_ABORT_MS + 1,
        false,
        undefined,
        extendedCeilingMs,
      );

      expect(result.effectiveAbortMs).toBe(extendedCeilingMs);
      expect(result.shouldAbort).toBe(false);
    });

    it('treats extendedCeilingMs equal to computed threshold as no-op (strict >)', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);
      wd.onMessage(webSearchToolUse('ws-1'), t0 + 100); // computed ceiling: AUTO_ABORT_MS

      const result = wd.check(t0 + AUTO_ABORT_MS + 101, false, undefined, AUTO_ABORT_MS);
      // equality is treated as no-op since the result is identical
      expect(result.effectiveAbortMs).toBe(AUTO_ABORT_MS);
      expect(result.shouldAbort).toBe(true);
    });

    it('combines extendedCeilingMs with skipCommit=true without mutating tracker state', () => {
      const t0 = 1000000;
      const wd = new WatchdogTracker(t0);
      wd.onMessage(webSearchToolUse('ws-1'), t0 + 100);
      const extendedCeilingMs = AUTO_ABORT_MS + 5 * 60_000;

      const before = wd.watchdogLevel;
      const result = wd.check(t0 + AUTO_ABORT_MS + 101, true, undefined, extendedCeilingMs);

      expect(result.effectiveAbortMs).toBe(extendedCeilingMs);
      expect(result.shouldAbort).toBe(false);
      // skipCommit must keep tracker state untouched
      expect(wd.watchdogLevel).toBe(before);
      expect(wd.fired).toBe(false);
    });
  });
});

// =============================================================================
// formatWatchdogAutoAbortMessage — derives minute count from AUTO_ABORT_MS
// =============================================================================
describe('formatWatchdogAutoAbortMessage', () => {
  it('renders the minute count derived from AUTO_ABORT_MS by default', () => {
    const expectedMinutes = Math.floor(AUTO_ABORT_MS / 60_000);
    expect(formatWatchdogAutoAbortMessage()).toBe(
      `This turn has been silent for ${expectedMinutes} minutes. Stopping as a safety measure.`,
    );
  });

  it('renders the minute count for an explicit override', () => {
    expect(formatWatchdogAutoAbortMessage(45 * 60_000)).toBe(
      'This turn has been silent for 45 minutes. Stopping as a safety measure.',
    );
  });
});

// =============================================================================
// Standalone inferWatchdogPhase (exported function)
// =============================================================================
describe('inferWatchdogPhase (standalone)', () => {
  it('returns awaiting_tool when toolInFlightSince is set', () => {
    expect(inferWatchdogPhase('assistant', 1000)).toBe('awaiting_tool');
    expect(inferWatchdogPhase('user', 1000)).toBe('awaiting_tool');
    expect(inferWatchdogPhase(undefined, 1000)).toBe('awaiting_tool');
  });

  it('returns awaiting_api for user message type (tool_result delivered)', () => {
    expect(inferWatchdogPhase('user')).toBe('awaiting_api');
  });

  it('returns streaming for assistant message type', () => {
    expect(inferWatchdogPhase('assistant')).toBe('streaming');
  });

  it('returns streaming for stream_event message type', () => {
    expect(inferWatchdogPhase('stream_event')).toBe('streaming');
  });

  it('returns awaiting_api for system message type', () => {
    expect(inferWatchdogPhase('system')).toBe('awaiting_api');
  });

  it('returns awaiting_api when msgType is undefined', () => {
    expect(inferWatchdogPhase(undefined)).toBe('awaiting_api');
    expect(inferWatchdogPhase()).toBe('awaiting_api');
  });

  it('returns processing for result/error message types', () => {
    expect(inferWatchdogPhase('result')).toBe('processing');
    expect(inferWatchdogPhase('error')).toBe('processing');
  });

  it('matches class inferPhase() behavior exactly', () => {
    const t0 = 1000000;
    const wd = new WatchdogTracker(t0);

    // Initial: no messages → both should return awaiting_api
    expect(inferWatchdogPhase(undefined, undefined)).toBe(wd.inferPhase());

    // After assistant text → streaming
    wd.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }, t0 + 100);
    expect(inferWatchdogPhase('assistant', undefined)).toBe(wd.inferPhase());

    // After tool_use → awaiting_tool
    wd.onMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Foo' }] } }, t0 + 200);
    expect(inferWatchdogPhase('assistant', t0 + 200)).toBe(wd.inferPhase());

    // After tool_result → awaiting_api
    wd.onMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] } }, t0 + 300);
    expect(inferWatchdogPhase('user', undefined)).toBe(wd.inferPhase());
  });
});

// =============================================================================
// Stage 1 (260502): shouldSuppressLevel1WatchdogCapture — closed-form predicate
// over the typed RuntimeActivityEvent union for the executor's level-1
// Sentry-capture gate. Each closed-union case is classified explicitly; unknown
// is fail-closed.
// =============================================================================
describe('shouldSuppressLevel1WatchdogCapture (Stage 1, 260502)', () => {
  it('returns false when activity is null (no stream activity yet)', () => {
    expect(shouldSuppressLevel1WatchdogCapture(null)).toBe(false);
  });

  it('returns true for token-delta/text', () => {
    const activity: RuntimeActivityEvent = {
      kind: 'token-delta', subkind: 'text', rawEventType: 'text_delta',
    };
    expect(shouldSuppressLevel1WatchdogCapture(activity)).toBe(true);
  });

  it('returns true for token-delta/thinking', () => {
    const activity: RuntimeActivityEvent = {
      kind: 'token-delta', subkind: 'thinking', rawEventType: 'thinking_delta',
    };
    expect(shouldSuppressLevel1WatchdogCapture(activity)).toBe(true);
  });

  it('returns true for token-delta/tool-input', () => {
    const activity: RuntimeActivityEvent = {
      kind: 'token-delta', subkind: 'tool-input', rawEventType: 'input_json_delta',
    };
    expect(shouldSuppressLevel1WatchdogCapture(activity)).toBe(true);
  });

  it('returns true for tool-event/tool-call-in-progress', () => {
    const activity: RuntimeActivityEvent = {
      kind: 'tool-event',
      subkind: 'tool-call-in-progress',
      rawEventType: 'response.code_interpreter_call.in_progress',
    };
    expect(shouldSuppressLevel1WatchdogCapture(activity)).toBe(true);
  });

  it('returns false for tool-event/tool-call-completed', () => {
    const activity: RuntimeActivityEvent = {
      kind: 'tool-event',
      subkind: 'tool-call-completed',
      rawEventType: 'response.code_interpreter_call.completed',
    };
    expect(shouldSuppressLevel1WatchdogCapture(activity)).toBe(false);
  });

  it('returns false for lifecycle (boundary events)', () => {
    expect(shouldSuppressLevel1WatchdogCapture({
      kind: 'lifecycle', subkind: 'message-start', rawEventType: 'message_start',
    })).toBe(false);
    expect(shouldSuppressLevel1WatchdogCapture({
      kind: 'lifecycle', subkind: 'message-stop', rawEventType: 'message_stop',
    })).toBe(false);
    expect(shouldSuppressLevel1WatchdogCapture({
      kind: 'lifecycle', subkind: 'chat-chunk-final', rawEventType: 'chat.completion.chunk',
    })).toBe(false);
    expect(shouldSuppressLevel1WatchdogCapture({
      kind: 'lifecycle', subkind: 'response-completed', rawEventType: 'response.completed',
    })).toBe(false);
    expect(shouldSuppressLevel1WatchdogCapture({
      kind: 'lifecycle', subkind: 'response-failed', rawEventType: 'response.failed',
    })).toBe(false);
  });

  it('returns false for lifecycle/cancelled', () => {
    expect(shouldSuppressLevel1WatchdogCapture({
      kind: 'lifecycle', subkind: 'cancelled', rawEventType: 'turn.cancelled',
    })).toBe(false);
  });

  it('returns false for lifecycle/aborted', () => {
    expect(shouldSuppressLevel1WatchdogCapture({
      kind: 'lifecycle', subkind: 'aborted', rawEventType: 'turn.aborted',
    })).toBe(false);
  });

  it('returns false for lifecycle/superseded', () => {
    expect(shouldSuppressLevel1WatchdogCapture({
      kind: 'lifecycle', subkind: 'superseded', rawEventType: 'turn.superseded',
    })).toBe(false);
  });

  it('returns false for unknown (FAIL-CLOSED — better captured than missed)', () => {
    const activity: RuntimeActivityEvent = {
      kind: 'unknown', rawEventType: 'vendor.unknown.event',
    };
    expect(shouldSuppressLevel1WatchdogCapture(activity)).toBe(false);
  });
});

type RuntimeActivityExpectation = RuntimeActivityEvent & {
  expectedSuppress: boolean;
};

function anthropicDeltaActivity(rawEventType: string): RuntimeActivityEvent {
  return mapAnthropicStreamEvent({
    type: 'content_block_delta',
    index: 0,
    delta: { type: rawEventType },
  } as unknown as RawMessageStreamEvent);
}

function anthropicStreamActivity(rawEventType: string): RuntimeActivityEvent {
  return mapAnthropicStreamEvent({ type: rawEventType } as unknown as RawMessageStreamEvent);
}

function expectRuntimeActivity(
  actual: RuntimeActivityEvent,
  expected: RuntimeActivityExpectation,
): void {
  const { expectedSuppress: _expectedSuppress, ...expectedActivity } = expected;
  void _expectedSuppress;
  expect(actual).toEqual(expectedActivity);
}

const canonicalWatchdogCases: Array<{
  name: string;
  activity: RuntimeActivityEvent;
  expected: RuntimeActivityExpectation;
}> = [
  {
    name: 'Anthropic text_delta',
    activity: anthropicDeltaActivity('text_delta'),
    expected: { kind: 'token-delta', subkind: 'text', rawEventType: 'text_delta', expectedSuppress: true },
  },
  {
    name: 'Anthropic input_json_delta',
    activity: anthropicDeltaActivity('input_json_delta'),
    expected: { kind: 'token-delta', subkind: 'tool-input', rawEventType: 'input_json_delta', expectedSuppress: true },
  },
  {
    name: 'Anthropic thinking_delta',
    activity: anthropicDeltaActivity('thinking_delta'),
    expected: { kind: 'token-delta', subkind: 'thinking', rawEventType: 'thinking_delta', expectedSuppress: true },
  },
  {
    name: 'Anthropic signature_delta',
    activity: anthropicDeltaActivity('signature_delta'),
    expected: { kind: 'token-delta', subkind: 'signature', rawEventType: 'signature_delta', expectedSuppress: true },
  },
  {
    name: 'Anthropic citations_delta',
    activity: anthropicDeltaActivity('citations_delta'),
    expected: { kind: 'token-delta', subkind: 'citations', rawEventType: 'citations_delta', expectedSuppress: true },
  },
  {
    name: 'Anthropic message_start',
    activity: anthropicStreamActivity('message_start'),
    expected: { kind: 'lifecycle', subkind: 'message-start', rawEventType: 'message_start', expectedSuppress: false },
  },
  {
    name: 'Anthropic message_delta',
    activity: anthropicStreamActivity('message_delta'),
    expected: { kind: 'lifecycle', subkind: 'message-delta', rawEventType: 'message_delta', expectedSuppress: false },
  },
  {
    name: 'Anthropic message_stop',
    activity: anthropicStreamActivity('message_stop'),
    expected: { kind: 'lifecycle', subkind: 'message-stop', rawEventType: 'message_stop', expectedSuppress: false },
  },
  {
    name: 'Anthropic content_block_start',
    activity: anthropicStreamActivity('content_block_start'),
    expected: {
      kind: 'lifecycle', subkind: 'content-block-start', rawEventType: 'content_block_start', expectedSuppress: false,
    },
  },
  {
    name: 'Anthropic content_block_stop',
    activity: anthropicStreamActivity('content_block_stop'),
    expected: {
      kind: 'lifecycle', subkind: 'content-block-stop', rawEventType: 'content_block_stop', expectedSuppress: false,
    },
  },
  {
    name: 'OpenAI response.output_text.delta',
    activity: mapOpenAIResponsesEvent('response.output_text.delta'),
    expected: {
      kind: 'token-delta', subkind: 'text', rawEventType: 'response.output_text.delta', expectedSuppress: true,
    },
  },
  {
    name: 'OpenAI response.reasoning_summary_text.delta',
    activity: mapOpenAIResponsesEvent('response.reasoning_summary_text.delta'),
    expected: {
      kind: 'token-delta',
      subkind: 'thinking',
      rawEventType: 'response.reasoning_summary_text.delta',
      expectedSuppress: true,
    },
  },
  {
    name: 'OpenAI response.reasoning.delta',
    activity: mapOpenAIResponsesEvent('response.reasoning.delta'),
    expected: {
      kind: 'token-delta', subkind: 'thinking', rawEventType: 'response.reasoning.delta', expectedSuppress: true,
    },
  },
  {
    name: 'OpenAI response.function_call_arguments.delta',
    activity: mapOpenAIResponsesEvent('response.function_call_arguments.delta'),
    expected: {
      kind: 'token-delta',
      subkind: 'tool-input',
      rawEventType: 'response.function_call_arguments.delta',
      expectedSuppress: true,
    },
  },
  {
    name: 'OpenAI response.function_call.arguments.delta',
    activity: mapOpenAIResponsesEvent('response.function_call.arguments.delta'),
    expected: {
      kind: 'token-delta',
      subkind: 'tool-input',
      rawEventType: 'response.function_call.arguments.delta',
      expectedSuppress: true,
    },
  },
  {
    name: 'OpenAI response.created',
    activity: mapOpenAIResponsesEvent('response.created'),
    expected: { kind: 'lifecycle', subkind: 'response-created', rawEventType: 'response.created', expectedSuppress: false },
  },
  {
    name: 'OpenAI response.in_progress',
    activity: mapOpenAIResponsesEvent('response.in_progress'),
    expected: {
      kind: 'lifecycle', subkind: 'response-in-progress', rawEventType: 'response.in_progress', expectedSuppress: false,
    },
  },
  {
    name: 'OpenAI response.completed',
    activity: mapOpenAIResponsesEvent('response.completed'),
    expected: {
      kind: 'lifecycle', subkind: 'response-completed', rawEventType: 'response.completed', expectedSuppress: false,
    },
  },
  {
    name: 'OpenAI response.failed',
    activity: mapOpenAIResponsesEvent('response.failed'),
    expected: { kind: 'lifecycle', subkind: 'response-failed', rawEventType: 'response.failed', expectedSuppress: false },
  },
  {
    name: 'OpenAI response.code_interpreter_call.in_progress',
    activity: mapOpenAIResponsesEvent('response.code_interpreter_call.in_progress'),
    expected: {
      kind: 'tool-event',
      subkind: 'tool-call-in-progress',
      rawEventType: 'response.code_interpreter_call.in_progress',
      expectedSuppress: true,
    },
  },
  {
    name: 'OpenAI response.code_interpreter_call.completed',
    activity: mapOpenAIResponsesEvent('response.code_interpreter_call.completed'),
    expected: {
      kind: 'tool-event',
      subkind: 'tool-call-completed',
      rawEventType: 'response.code_interpreter_call.completed',
      expectedSuppress: false,
    },
  },
  {
    name: 'OpenAI response.web_search_call.in_progress',
    activity: mapOpenAIResponsesEvent('response.web_search_call.in_progress'),
    expected: {
      kind: 'tool-event',
      subkind: 'tool-call-in-progress',
      rawEventType: 'response.web_search_call.in_progress',
      expectedSuppress: true,
    },
  },
  {
    name: 'OpenAI response.web_search_call.completed',
    activity: mapOpenAIResponsesEvent('response.web_search_call.completed'),
    expected: {
      kind: 'tool-event',
      subkind: 'tool-call-completed',
      rawEventType: 'response.web_search_call.completed',
      expectedSuppress: false,
    },
  },
  {
    name: 'OpenAI chat.completion.chunk active chunk',
    activity: mapOpenAIChatChunk({ choices: [{ finish_reason: null }] }),
    expected: {
      kind: 'token-delta', subkind: 'text', rawEventType: 'chat.completion.chunk', expectedSuppress: true,
    },
  },
  {
    name: 'OpenAI chat.completion.chunk final chunk',
    activity: mapOpenAIChatChunk({ choices: [{ finish_reason: 'stop' }] }),
    expected: {
      kind: 'lifecycle', subkind: 'chat-chunk-final', rawEventType: 'chat.completion.chunk', expectedSuppress: false,
    },
  },
];

describe('canonical taxonomy walk — watchdog suppression (F16)', () => {
  it.each(canonicalWatchdogCases)('$name maps to the expected activity and suppress decision', ({ activity, expected }) => {
    expectRuntimeActivity(activity, expected);
    expect(serializeRuntimeActivityForTelemetry(activity)).toBe(expected.rawEventType);
    expect(shouldSuppressLevel1WatchdogCapture(activity)).toBe(expected.expectedSuppress);
  });
});

// =============================================================================
// Stage 1a (260617_bricked-state-0448-electron42): isAwaitingApiHardStall —
// pure predicate for the earlier, INTERACTIVE-only `awaiting_api` hard-stall
// terminal (request sent to the provider, no first token / stream byte).
//
// Returns true ONLY when: interactive AND phase==='awaiting_api' AND no
// raw-stream activity AND silentMs >= AWAITING_API_STALL_ABORT_MS. The
// conservative 5-min ceiling is below the 10-min STREAMING_STALL_ABORT_MS and
// must never trip for a producing turn, a non-awaiting_api phase, an automation
// turn, or a turn below threshold.
// =============================================================================
describe('isAwaitingApiHardStall (Stage 1a, 260617)', () => {
  const base = {
    phase: 'awaiting_api' as const,
    silentMs: AWAITING_API_STALL_ABORT_MS,
    hasRawStreamActivity: false,
    interactive: true,
  };

  it('exposes a conservative ceiling below the 10-min streaming ceiling', () => {
    expect(AWAITING_API_STALL_ABORT_MS).toBe(300_000);
    expect(AWAITING_API_STALL_ABORT_MS).toBeLessThan(STREAMING_STALL_ABORT_MS);
  });

  it('returns true at the threshold for an interactive awaiting_api turn with no stream activity', () => {
    expect(isAwaitingApiHardStall(base)).toBe(true);
  });

  it('returns true above the threshold', () => {
    expect(isAwaitingApiHardStall({ ...base, silentMs: AWAITING_API_STALL_ABORT_MS + 60_000 })).toBe(true);
  });

  it('returns FALSE below the threshold', () => {
    expect(isAwaitingApiHardStall({ ...base, silentMs: AWAITING_API_STALL_ABORT_MS - 1 })).toBe(false);
  });

  it('returns FALSE for the streaming phase (first token already arrived)', () => {
    expect(isAwaitingApiHardStall({ ...base, phase: 'streaming' })).toBe(false);
  });

  it('returns FALSE for the awaiting_tool phase', () => {
    expect(isAwaitingApiHardStall({ ...base, phase: 'awaiting_tool' })).toBe(false);
  });

  it('returns FALSE for the processing phase', () => {
    expect(isAwaitingApiHardStall({ ...base, phase: 'processing' })).toBe(false);
  });

  it('returns FALSE when raw-stream activity is present (turn is producing)', () => {
    expect(isAwaitingApiHardStall({ ...base, hasRawStreamActivity: true })).toBe(false);
  });

  it('returns FALSE for an automation / non-interactive turn (no user to retry)', () => {
    expect(isAwaitingApiHardStall({ ...base, interactive: false })).toBe(false);
  });

  it('returns FALSE for an automation turn even far past the threshold', () => {
    expect(
      isAwaitingApiHardStall({
        ...base,
        interactive: false,
        silentMs: STREAMING_STALL_ABORT_MS + 60_000,
      }),
    ).toBe(false);
  });

  // Regression: the earlier awaiting_api ceiling must NOT shorten the existing
  // 10-min STREAMING_STALL_ABORT_MS streaming-phase ceiling. A streaming-phase
  // stall is still governed by the 600s ceiling (the tracker's effectiveAbortMs),
  // and the new predicate never fires for it — even when the silent time has
  // crossed the awaiting_api threshold.
  it('does NOT shorten the streaming-phase ceiling — predicate stays false for streaming at the awaiting_api threshold', () => {
    expect(
      isAwaitingApiHardStall({
        phase: 'streaming',
        silentMs: AWAITING_API_STALL_ABORT_MS + 1,
        hasRawStreamActivity: false,
        interactive: true,
      }),
    ).toBe(false);
  });

  it('streaming-phase tracker still aborts at the 600s ceiling, not earlier (regression)', () => {
    const t0 = 1_000_000;
    const wd = new WatchdogTracker(t0);
    // Assistant text → phase streaming; effectiveAbortMs = STREAMING_STALL_ABORT_MS.
    wd.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }, t0 + 100);

    // At the (earlier) awaiting_api threshold the streaming turn is NOT yet aborting.
    const atAwaitingApiThreshold = wd.check(t0 + 100 + AWAITING_API_STALL_ABORT_MS + 1);
    expect(atAwaitingApiThreshold.phase).toBe('streaming');
    expect(atAwaitingApiThreshold.effectiveAbortMs).toBe(STREAMING_STALL_ABORT_MS);
    expect(atAwaitingApiThreshold.shouldAbort).toBe(false);

    // Only past the 600s streaming ceiling does it abort.
    const pastStreamingCeiling = wd.check(t0 + 100 + STREAMING_STALL_ABORT_MS + 1);
    expect(pastStreamingCeiling.shouldAbort).toBe(true);
    expect(pastStreamingCeiling.effectiveAbortMs).toBe(STREAMING_STALL_ABORT_MS);
  });
});

describe('isAwaitingApiSoftStall (Stage 1b, 260617)', () => {
  const base = {
    phase: 'awaiting_api' as const,
    silentMs: AWAITING_API_SOFT_STALL_MS,
    hasRawStreamActivity: false,
    interactive: true,
  };

  it('exposes a conservative soft threshold below the hard ceiling', () => {
    expect(AWAITING_API_SOFT_STALL_MS).toBe(30_000);
    expect(AWAITING_API_SOFT_STALL_MS).toBeLessThan(AWAITING_API_STALL_ABORT_MS);
    expect(AWAITING_API_SOFT_STALL_MS).toBeLessThan(STREAMING_STALL_ABORT_MS);
  });

  it('returns true at the soft threshold for an interactive awaiting_api turn with no stream activity', () => {
    expect(isAwaitingApiSoftStall(base)).toBe(true);
  });

  it('returns true above the soft threshold', () => {
    expect(isAwaitingApiSoftStall({ ...base, silentMs: AWAITING_API_SOFT_STALL_MS + 5_000 })).toBe(true);
  });

  it('returns FALSE below the soft threshold', () => {
    expect(isAwaitingApiSoftStall({ ...base, silentMs: AWAITING_API_SOFT_STALL_MS - 1 })).toBe(false);
  });

  it('returns FALSE for the streaming phase (turn is producing — must stay in State A)', () => {
    expect(isAwaitingApiSoftStall({ ...base, phase: 'streaming' })).toBe(false);
  });

  it('returns FALSE for the awaiting_tool phase', () => {
    expect(isAwaitingApiSoftStall({ ...base, phase: 'awaiting_tool' })).toBe(false);
  });

  it('returns FALSE for the processing phase', () => {
    expect(isAwaitingApiSoftStall({ ...base, phase: 'processing' })).toBe(false);
  });

  it('returns FALSE when raw-stream activity is present (first token already streaming)', () => {
    expect(isAwaitingApiSoftStall({ ...base, hasRawStreamActivity: true })).toBe(false);
  });

  it('returns FALSE for an automation / non-interactive turn (no user to reassure)', () => {
    expect(isAwaitingApiSoftStall({ ...base, interactive: false })).toBe(false);
  });

  it('returns FALSE for an automation turn even far past the soft threshold', () => {
    expect(
      isAwaitingApiSoftStall({
        ...base,
        interactive: false,
        silentMs: AWAITING_API_STALL_ABORT_MS + 60_000,
      }),
    ).toBe(false);
  });

  // Invariant: a slowly-STREAMING turn must NEVER trip the soft surface, even
  // when the silent time crosses the soft threshold — the user is watching text
  // appear and must never be told it's "still waiting" (chief-designer brief §2).
  it('does NOT fire for streaming at the soft threshold (no "still waiting" while text appears)', () => {
    expect(
      isAwaitingApiSoftStall({
        phase: 'streaming',
        silentMs: AWAITING_API_SOFT_STALL_MS + 1,
        hasRawStreamActivity: false,
        interactive: true,
      }),
    ).toBe(false);
  });

  // The soft threshold is strictly below the hard ceiling, so an interactive
  // awaiting_api turn that has reached the hard ceiling has ALSO satisfied the
  // soft predicate (the soft surface precedes the hard terminal in time).
  it('a turn at the hard ceiling also satisfies the soft predicate (soft precedes hard)', () => {
    const atHard = { ...base, silentMs: AWAITING_API_STALL_ABORT_MS };
    expect(isAwaitingApiSoftStall(atHard)).toBe(true);
    expect(isAwaitingApiHardStall(atHard)).toBe(true);
  });
});
