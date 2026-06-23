 
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import { EmptyResultAnomalyError } from '@shared/utils/emptyResultAnomalyError';
import { BOOKKEEPING_TOOL_NAMES } from '@rebel/shared';

const {
  dispatchAgentEventMock,
  dispatchAgentErrorEventMock,
  mockTurnLogger,
  registryMocks,
  testState,
} = vi.hoisted(() => {
  const dispatchAgentEventMock = vi.fn();
  const dispatchAgentErrorEventMock = vi.fn();
  const mockTurnLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  };

  const testState = {
    contextAccumulator: null as unknown,
    hasUserQuestionPending: false,
  };

  return {
    dispatchAgentEventMock,
    dispatchAgentErrorEventMock,
    mockTurnLogger,
    testState,
    registryMocks: {
      getTurnLogger: vi.fn(() => mockTurnLogger),
      getRendererSession: vi.fn(() => null),
      setTurnModel: vi.fn(),
      getTurnModel: vi.fn(() => 'claude-sonnet-4-6'),
      getTurnActiveProvider: vi.fn(() => undefined),
      setTurnActiveProvider: vi.fn(),
      hasContextOverflowDispatched: vi.fn(() => false),
      markContextOverflowDispatched: vi.fn(),
      hasErrorResultDispatched: vi.fn(() => false),
      markErrorResultDispatched: vi.fn(),
      clearErrorResultDispatched: vi.fn(() => false),
      markActionableErrorDispatched: vi.fn(),
      hasActionableErrorDispatched: vi.fn(() => false),
      getTurnPrompt: vi.fn(() => ''),
      getTurnExtendedContext: vi.fn(() => false),
      getTurnContextWindow: vi.fn(() => 200_000),
      getTurnThinkingEffort: vi.fn(() => 'medium'),
      getTurnAuthMethod: vi.fn(() => 'api-key'),
      getTurnPlanningModel: vi.fn(() => undefined),
      getTurnFastModel: vi.fn(() => undefined),
      getTurnFallbacks: vi.fn(() => []),
      getContextAccumulator: vi.fn(() => testState.contextAccumulator),
      deleteContextAccumulator: vi.fn(),
      releaseActiveSession: vi.fn(),
      getTurnCategory: vi.fn(() => 'conversation'),
      getTurnPrivateMode: vi.fn(() => false),
      getTurnInputSource: vi.fn(() => 'text'),
      hasCostRecorded: vi.fn(() => false),
      hasUserQuestionPending: vi.fn(() => testState.hasUserQuestionPending),
      markCostRecorded: vi.fn(),
      hasSuccessResultDispatched: vi.fn(() => false),
      markSuccessResultDispatched: vi.fn(),
      recordSessionTurn: vi.fn(),
      hasSessionHadTurns: vi.fn(() => false),
    },
  };
});

vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockTurnLogger,
}));

vi.mock('../agentTurnRegistry', () => ({
  agentTurnRegistry: registryMocks,
}));

vi.mock('../agentEventDispatcher', () => ({
  dispatchAgentEvent: dispatchAgentEventMock,
  dispatchAgentErrorEvent: dispatchAgentErrorEventMock,
}));

vi.mock('../costLedgerService', () => ({
  appendCostEntry: vi.fn(() => ({ costEntryId: 'test-cost-entry-id' })),
}));

vi.mock('../../tracking', () => ({
  getTurnAggregator: () => ({
    getToolNameByUseId: vi.fn(() => null),
    getToolMetrics: vi.fn(() => null),
    getSubAgentMetrics: vi.fn(() => null),
    addTool: vi.fn(),
    recordToolOutput: vi.fn(),
    recordMcpToolOutput: vi.fn(),
    recordFileWrite: vi.fn(),
  }),
  mainTracking: { chatSessionCreated: vi.fn() },
}));

vi.mock('../memoryUpdateService', () => ({
  triggerMemoryUpdate: vi.fn(),
}));

vi.mock('../timeSavedService', () => ({
  triggerTimeSavedEstimation: vi.fn(),
}));

vi.mock('../achievementsStore', () => ({
  updateStreakOnSessionComplete: vi.fn(),
}));

vi.mock('../achievementsEvaluator', () => ({
  evaluateBadgesOnTurnComplete: vi.fn(),
  evaluateJourneyCompletion: vi.fn(),
  evaluateReunionBadge: vi.fn(),
  updateCountersOnSessionComplete: vi.fn(),
  recordToolUseForSession: vi.fn(),
  getCurrentJourneyDay: vi.fn(() => null),
}));

vi.mock('../toolUsageStore', () => ({
  recordToolUsage: vi.fn(),
  isMetaTool: vi.fn(() => false),
}));

vi.mock('../toolIndexService', () => ({
  getToolSchema: vi.fn(() => null),
}));

vi.mock('../../analytics', () => ({
  trackMainEvent: vi.fn(),
  getOrGenerateAnonymousId: vi.fn(() => 'anon-id'),
}));

vi.mock('@shared/utils/agentErrorCatalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/utils/agentErrorCatalog')>();
  return {
    ...actual,
    createRoutedError: (kind: string, message: string) => {
      const error = new Error(message);
      (error as Error & { errorKind?: string }).errorKind = kind;
      return error;
    },
  };
});

vi.mock('@shared/utils/eventSanitization', () => ({
  isSubAgentTool: vi.fn(() => false),
}));

vi.mock('@shared/utils/friendlyErrors', () => ({
  humanizeError: vi.fn((message: string) => message),
  isRateLimitMessage: vi.fn(() => false),
}));

vi.mock('@shared/utils/modelNormalization', () => ({
  MODEL_OPTIONS: [],
  isExtendedContextUnavailableError: vi.fn(() => false),
  isThinkingModelUnavailableError: vi.fn(() => false),
  PLAN_MODE_ALIAS: 'planner',
}));

vi.mock('@shared/data/modelProviderPresets', () => ({
  getKnownContextWindowForModel: vi.fn(() => null),
  PROVIDER_PRESETS: { openai: { models: [] }, google: { models: [] } },
}));

vi.mock('@shared/utils/toolNameValidation', () => ({
  isToolNameLengthError: vi.fn(() => false),
  truncateToolName: vi.fn((name: string) => name),
}));

import { handleAgentMessage } from '../agentMessageHandler';

type ToolEventOrigin = Extract<AgentEvent, { type: 'tool' }>['_origin'];

function makeToolEndEvent(toolName: string, origin?: ToolEventOrigin): Extract<AgentEvent, { type: 'tool' }> {
  return {
    type: 'tool',
    toolName,
    stage: 'end',
    detail: 'completed',
    isError: false,
    timestamp: Date.now(),
    ...(origin ? { _origin: origin } : {}),
  };
}

function setTurnEvents(turnId: string, events: AgentEvent[]): void {
  testState.contextAccumulator = {
    eventsByTurn: {
      [turnId]: events,
    },
    messages: [],
  };
}

function makeResultMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result' as const,
    subtype: 'success',
    is_error: false,
    result: '',
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 20,
      output_tokens: 1348,
    },
    last_turn_output_tokens: 0,
    executor_tool_count: 0,
    ...overrides,
  };
}

function getDispatchedResultText(turnId: string): string | undefined {
  const call = dispatchAgentEventMock.mock.calls.find(
    (args: unknown[]) =>
      args[1] === turnId &&
      typeof args[2] === 'object' &&
      args[2] != null &&
      (args[2] as { type?: string }).type === 'result',
  );
  return (call?.[2] as { text?: string } | undefined)?.text;
}

beforeEach(() => {
  vi.clearAllMocks();
  initTestPlatformConfig();
  testState.contextAccumulator = null;
  testState.hasUserQuestionPending = false;
});

describe('handleAgentMessage synthesis gate (plan-mode false done regression)', () => {
  it('throws EmptyResultAnomalyError when only synthetic/pre-turn tool events exist and executor_tool_count=0', () => {
    const turnId = 'turn-synth-only';
    setTurnEvents(turnId, [
      makeToolEndEvent('file_search', 'pre-turn-context'),
      makeToolEndEvent('conversation_search', 'pre-turn-context'),
      makeToolEndEvent('MissionSet', 'synthetic-plan-seed'),
      makeToolEndEvent('TaskList', 'synthetic-plan-seed'),
    ]);

    expect(() =>
      handleAgentMessage(null, turnId, makeResultMessage()),
    ).toThrow(EmptyResultAnomalyError);
    expect(dispatchAgentEventMock).not.toHaveBeenCalled();
  });

  it('throws EmptyResultAnomalyError when executor_tool_count>0 but only TaskUpdate completed', () => {
    const turnId = 'turn-taskupdate-only';
    setTurnEvents(turnId, [
      makeToolEndEvent('TaskUpdate'),
    ]);

    expect(() =>
      handleAgentMessage(null, turnId, makeResultMessage({ executor_tool_count: 1 })),
    ).toThrow(EmptyResultAnomalyError);
    expect(dispatchAgentEventMock).not.toHaveBeenCalled();
  });

  it('synthesizes "Done." when executor_tool_count>0 and a meaningful real tool completed', () => {
    const turnId = 'turn-real-tool';
    setTurnEvents(turnId, [
      makeToolEndEvent('Read'),
    ]);

    expect(() =>
      handleAgentMessage(null, turnId, makeResultMessage({ executor_tool_count: 1 })),
    ).not.toThrow();

    expect(getDispatchedResultText(turnId)).toBe('Done.');
  });

  it('does not throw or synthesize when hasUserQuestionPending=true', () => {
    const turnId = 'turn-user-question-pending';
    testState.hasUserQuestionPending = true;
    setTurnEvents(turnId, [
      makeToolEndEvent('file_search', 'pre-turn-context'),
      makeToolEndEvent('MissionSet', 'synthetic-plan-seed'),
    ]);

    expect(() =>
      handleAgentMessage(null, turnId, makeResultMessage()),
    ).not.toThrow();

    expect(getDispatchedResultText(turnId)).toBe('');
  });

  it('throws on loopTotalOutputTokens===0 via the zero-output anomaly path', () => {
    const turnId = 'turn-zero-loop-output';
    setTurnEvents(turnId, [
      makeToolEndEvent('file_search', 'pre-turn-context'),
      makeToolEndEvent('MissionSet', 'synthetic-plan-seed'),
    ]);

    let thrown: unknown;
    try {
      handleAgentMessage(
        null,
        turnId,
        makeResultMessage({
          usage: { input_tokens: 20, output_tokens: 0 },
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(EmptyResultAnomalyError);
    expect((thrown as EmptyResultAnomalyError).loopTotalOutputTokens).toBe(0);
    expect(dispatchAgentEventMock).not.toHaveBeenCalled();
  });

  // Parametric coverage: every bookkeeping tool name MUST be filtered out of
  // the "meaningful tool ends" count. If a future bookkeeping tool is added to
  // BOOKKEEPING_TOOL_NAMES but a code path forgets to gate on it, this catches
  // the regression. See packages/shared/src/utils/bookkeepingToolNames.ts.
  describe.each(Array.from(BOOKKEEPING_TOOL_NAMES))(
    'bookkeeping-only turn — %s',
    (toolName) => {
      it(`throws EmptyResultAnomalyError when only ${toolName} ran (no real tool execution)`, () => {
        const turnId = `turn-bookkeeping-${toolName}`;
        setTurnEvents(turnId, [makeToolEndEvent(toolName)]);

        expect(() =>
          handleAgentMessage(null, turnId, makeResultMessage({ executor_tool_count: 1 })),
        ).toThrow(EmptyResultAnomalyError);
        expect(dispatchAgentEventMock).not.toHaveBeenCalled();
      });
    },
  );

  it('synthesizes "Done." when a real sub-agent tool completed alongside bookkeeping', () => {
    // A sub-agent dispatch (Task tool) is real model-invoked execution. Even
    // when bookkeeping tools also ran, the presence of a real tool end with
    // no _origin marker (or `_origin === 'real'`) should pass the gate and
    // produce the synthesized "Done." acknowledgment.
    const turnId = 'turn-subagent-with-bookkeeping';
    setTurnEvents(turnId, [
      makeToolEndEvent('MissionSet', 'synthetic-plan-seed'),
      makeToolEndEvent('Task'),
      makeToolEndEvent('TaskUpdate'),
    ]);

    expect(() =>
      handleAgentMessage(null, turnId, makeResultMessage({ executor_tool_count: 2 })),
    ).not.toThrow();

    expect(getDispatchedResultText(turnId)).toBe('Done.');
  });
});

describe('handleAgentMessage mid-turn refusal status (Fable 5 Stage 6)', () => {
  // A mid-turn refusal completes with partial text and stop_reason 'refusal'.
  // The handler must surface an honest status event (provider safety system
  // stopped the response) WITHOUT mutating the partial text itself. Empty-text
  // refusals are covered by the EmptyResultAnomalyError path instead.
  it('dispatches a safety-stop status event when stop_reason is refusal and text exists', () => {
    const turnId = 'turn-mid-refusal';

    handleAgentMessage(null, turnId, makeResultMessage({
      result: 'Here is the first part of the answer—',
      stop_reason: 'refusal',
      last_turn_output_tokens: 42,
    }));

    const statusCall = dispatchAgentEventMock.mock.calls.find(
      (args: unknown[]) =>
        args[1] === turnId &&
        (args[2] as { type?: string })?.type === 'status' &&
        typeof (args[2] as { message?: unknown }).message === 'string' &&
        ((args[2] as { message: string }).message).includes('safety system'),
    );
    expect(statusCall).toBeDefined();

    // No message mutation: the partial text is dispatched untouched.
    expect(getDispatchedResultText(turnId)).toBe('Here is the first part of the answer—');
  });

  it('does NOT dispatch the safety-stop status event for non-refusal stop reasons', () => {
    const turnId = 'turn-no-refusal';

    handleAgentMessage(null, turnId, makeResultMessage({
      result: 'A complete answer.',
      stop_reason: 'end_turn',
      last_turn_output_tokens: 42,
    }));

    const statusCall = dispatchAgentEventMock.mock.calls.find(
      (args: unknown[]) =>
        args[1] === turnId &&
        (args[2] as { type?: string })?.type === 'status' &&
        typeof (args[2] as { message?: unknown }).message === 'string' &&
        ((args[2] as { message: string }).message).includes('safety system'),
    );
    expect(statusCall).toBeUndefined();
    expect(getDispatchedResultText(turnId)).toBe('A complete answer.');
  });
});
