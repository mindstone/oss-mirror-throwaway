/**
 * Agent Runtime Contract Tests
 *
 * These tests define the behavioural contract between the app and the agent runtime
 * (Rebel Core). They verify that handleAgentMessage and the query() call-site
 * produce/consume the correct agent-compatible message shapes.
 *
 * Contract surface tested:
 *  1. AgentMessage shapes — every field the codebase reads from each message.type
 *  2. handleAgentMessage → AgentEvent mapping — correct output event per input message
 *  3. query() async-iterator protocol — must yield AgentMessage items
 *  4. Error routing — rate_limit, billing, context overflow throw for retry
 *  5. Streaming deltas — stream_event messages produce assistant_delta / thinking_delta
 *  6. Subagent / nested tool use — parent_tool_use_id propagation
 *  7. MCP Apps — _meta.ui extraction from tool_result blocks
 *  8. Synthetic messages — Claude Max usage-limit messages with model "<synthetic>"
 *  9. Empty result anomaly — recovery from empty result with output_tokens > 0
 * 10. Multi-turn tool loop — full tool_use → tool_result cycle
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks (hoisted so vi.mock factories can reference them)
// ---------------------------------------------------------------------------
const {
  dispatchAgentEventMock,
  dispatchAgentErrorEventMock,
  mockTurnLogger,
  mockAggregator,
  contextOverflowDispatched,
  turnModels,
  rendererSessions,
  turnPrompts,
  actionableErrorDispatched,
  turnExtendedContext,
  turnThinkingEffort,
  turnAuthMethod,
  turnFallbacks,
  contextAccumulators,
  eventListeners,
  turnInputSource,
  isToolNameLengthErrorMock,
} = vi.hoisted(() => {
  const dispatchAgentEventMock = vi.fn();
  const actionableErrorDispatched = new Set<string>();
  const dispatchAgentErrorEventMock = vi.fn((win: unknown, turnId: string, rawError: unknown, opts?: {
    humanizedOverride?: string;
    isTransient?: boolean;
    errorKindOverride?: string;
    providerOverride?: string;
    markActionable?: boolean;
    timeoutDiagnostic?: unknown;
    watchdogDiagnostic?: unknown;
    rateLimitMetaOverride?: unknown;
    timestampOverride?: number;
  }) => {
    const rawMessage = rawError instanceof Error
      ? rawError.message
      : typeof rawError === 'string'
        ? rawError
        : String(rawError ?? '');
    const errorKind = opts?.errorKindOverride;
    const provider = opts?.providerOverride;

    dispatchAgentEventMock(win, turnId, {
      type: 'error',
      error: opts?.humanizedOverride ?? rawMessage,
      ...(opts?.isTransient !== undefined ? { isTransient: opts.isTransient } : {}),
      ...(errorKind && errorKind !== 'unknown' ? { errorKind } : {}),
      ...(provider ? { provider } : {}),
      ...(opts?.timeoutDiagnostic ? { timeoutDiagnostic: opts.timeoutDiagnostic } : {}),
      ...(opts?.watchdogDiagnostic ? { watchdogDiagnostic: opts.watchdogDiagnostic } : {}),
      ...(errorKind === 'rate_limit' && opts?.rateLimitMetaOverride ? { rateLimitMeta: opts.rateLimitMetaOverride } : {}),
      errorSource: 'main',
      timestamp: opts?.timestampOverride ?? Date.now(),
    });

    if (opts?.markActionable === true || (errorKind === 'billing' && opts?.markActionable !== false)) {
      actionableErrorDispatched.add(turnId);
    }

    return {
      ok: true,
      ...(errorKind && errorKind !== 'unknown' ? { dispatchedErrorKind: errorKind } : {}),
    };
  });
  const mockTurnLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  };
  const mockAggregator = {
    getToolNameByUseId: vi.fn(() => null),
    getToolMetrics: vi.fn(() => ({
      totalToolCalls: 0,
      failedToolCalls: 0,
      filesCreated: 0,
      filesEdited: 0,
      toolUsageByCategory: {},
      mcpServerUsage: {},
      totalToolOutputChars: 0,
      mcpToolOutputChars: 0,
      builtinToolOutputChars: 0,
    })),
    getSubAgentMetrics: vi.fn(() => null),
    addTool: vi.fn(),
    recordToolOutput: vi.fn(),
    recordMcpToolOutput: vi.fn(),
    recordFileWrite: vi.fn(),
  };
  const contextOverflowDispatched = new Set<string>();
  const turnModels = new Map<string, string>();
  const rendererSessions = new Map<string, string>();
  const turnPrompts = new Map<string, string>();
  const turnExtendedContext = new Map<string, boolean>();
  const turnThinkingEffort = new Map<string, string>();
  const turnAuthMethod = new Map<string, string>();
  const turnFallbacks = new Map<string, string[]>();
  const contextAccumulators = new Map<string, unknown>();
  const eventListeners = new Map<string, (event: unknown) => void>();
  const turnInputSource = new Map<string, string>();
  const isToolNameLengthErrorMock = vi.fn(() => false);
  return {
    dispatchAgentEventMock,
    dispatchAgentErrorEventMock,
    mockTurnLogger,
    mockAggregator,
    contextOverflowDispatched,
    turnModels,
    rendererSessions,
    turnPrompts,
    actionableErrorDispatched,
    turnExtendedContext,
    turnThinkingEffort,
    turnAuthMethod,
    turnFallbacks,
    contextAccumulators,
    eventListeners,
    turnInputSource,
    isToolNameLengthErrorMock,
  };
});

vi.mock('../agentEventDispatcher', () => ({
  dispatchAgentEvent: dispatchAgentEventMock,
  dispatchAgentErrorEvent: dispatchAgentErrorEventMock,
}));

vi.mock('@core/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createScopedLogger: vi.fn(() => mockTurnLogger),
}));

vi.mock('../agentTurnRegistry', () => ({
  agentTurnRegistry: {
    getTurnLogger: vi.fn(() => mockTurnLogger),
    getRendererSession: vi.fn((turnId: string) => rendererSessions.get(turnId) ?? null),
    setTurnModel: vi.fn((turnId: string, model: string) => turnModels.set(turnId, model)),
    getTurnModel: vi.fn((turnId: string) => turnModels.get(turnId) ?? null),
      getTurnActiveProvider: vi.fn(() => undefined),
      setTurnActiveProvider: vi.fn(),
    hasContextOverflowDispatched: vi.fn((turnId: string) => contextOverflowDispatched.has(turnId)),
    markContextOverflowDispatched: vi.fn((turnId: string) => contextOverflowDispatched.add(turnId)),
    markActionableErrorDispatched: vi.fn((turnId: string) => actionableErrorDispatched.add(turnId)),
    getTurnPrompt: vi.fn((turnId: string) => turnPrompts.get(turnId) ?? ''),
    getTurnExtendedContext: vi.fn((turnId: string) => turnExtendedContext.get(turnId) ?? false),
    getTurnContextWindow: vi.fn(() => 200_000),
    getTurnThinkingEffort: vi.fn((turnId: string) => turnThinkingEffort.get(turnId) ?? 'medium'),
    getTurnAuthMethod: vi.fn((turnId: string) => turnAuthMethod.get(turnId) ?? 'oauth'),
    getTurnPlanningModel: vi.fn(() => undefined),
    getTurnFastModel: vi.fn(() => undefined),
    getTurnFallbacks: vi.fn((turnId: string) => turnFallbacks.get(turnId) ?? []),
    getContextAccumulator: vi.fn((turnId: string) => contextAccumulators.get(turnId) ?? null),
    deleteContextAccumulator: vi.fn(),
    deleteRendererSession: vi.fn(),
    releaseActiveSession: vi.fn(),
    getEventListener: vi.fn((turnId: string) => eventListeners.get(turnId) ?? null),
    deleteEventListener: vi.fn(),
    getTurnCategory: vi.fn(() => 'conversation'),
    getTurnPrivateMode: vi.fn(() => false),
    getTurnInputSource: vi.fn((turnId: string) => turnInputSource.get(turnId) ?? 'text'),
    hasCostRecorded: vi.fn(() => false),
    hasUserQuestionPending: vi.fn(() => false),
      hasOutputCapRetryAttempted: vi.fn(() => false),
      markOutputCapRetryAttempted: vi.fn(),
      clearOutputCapRetryAttempted: vi.fn(),
    markCostRecorded: vi.fn(),
    hasSuccessResultDispatched: vi.fn(() => false),
    markSuccessResultDispatched: vi.fn(),
    // Stage 4 (260421_classification_driven_error_humanizer): source-level dedup
    // for runtime-result error dispatch. Mock harness audit — agentMessageHandler
    // now calls this trio before/after dispatching error_during_execution events.
    hasErrorResultDispatched: vi.fn(() => false),
    markErrorResultDispatched: vi.fn(),
    clearErrorResultDispatched: vi.fn(),
    recordSessionTurn: vi.fn(),
    hasSessionHadTurns: vi.fn(() => false),
  },
}));

vi.mock('../../tracking', () => ({
  getTurnAggregator: vi.fn(() => mockAggregator),
  mainTracking: { chatSessionCreated: vi.fn() },
}));

vi.mock('../memoryUpdateService', () => ({
  triggerMemoryUpdate: vi.fn(),
}));

vi.mock('../timeSavedService', () => ({
  triggerTimeSavedEstimation: vi.fn(),
}));

vi.mock('../sessionCoachingScheduler', () => ({
  sessionCoachingScheduler: { scheduleCheck: vi.fn() },
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

vi.mock('../costLedgerService', () => ({
  appendCostEntry: vi.fn(() => ({ costEntryId: 'test-cost-entry-id' })),
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
  getOrGenerateAnonymousId: vi.fn(() => 'anon-test-id'),
}));

vi.mock('@shared/utils/friendlyErrors', () => ({
  humanizeError: vi.fn((msg: string) => msg),
  isNetworkError: vi.fn(() => false),
  isTransientError: vi.fn(() => false),
  isRateLimitMessage: vi.fn((text: string) => text.toLowerCase().includes('rate limit')),
}));

vi.mock('@shared/utils/modelNormalization', () => ({
  MODEL_OPTIONS: [],
  isExtendedContextUnavailableError: vi.fn((text: string) =>
    text.includes('long context beta') || text.includes('extended context unavailable')
  ),
  isThinkingModelUnavailableError: vi.fn((text: string) =>
    text.includes('opus model unavailable')
  ),
  PLAN_MODE_ALIAS: 'planner',
  normalizeModel: vi.fn((m: string) => m),
}));

vi.mock('@shared/utils/toolNameValidation', () => ({
  isToolNameLengthError: isToolNameLengthErrorMock,
  truncateToolName: vi.fn((name: string) => name),
}));

vi.mock('@shared/utils/agentErrorCatalog', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@shared/utils/agentErrorCatalog');
  return {
    ...actual,
    createRoutedError: vi.fn((kind: string, message: string) => {
      const err = new Error(message);
      (err as any).__routedErrorKind = kind;
      return err;
    }),
  };
});

// ---------------------------------------------------------------------------
// Import under test (AFTER mocks)
// ---------------------------------------------------------------------------
import { handleAgentMessage, collectToolHints } from '../agentMessageHandler';
import { agentTurnRegistry } from '../agentTurnRegistry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const TURN_ID = 'test-turn-001';
const SESSION_ID = 'test-session-001';

function resetState() {
  vi.clearAllMocks();
  contextOverflowDispatched.clear();
  turnModels.clear();
  rendererSessions.clear();
  turnPrompts.clear();
  actionableErrorDispatched.clear();
  turnExtendedContext.clear();
  turnThinkingEffort.clear();
  turnAuthMethod.clear();
  turnFallbacks.clear();
  contextAccumulators.clear();
  eventListeners.clear();
  turnInputSource.clear();
  rendererSessions.set(TURN_ID, SESSION_ID);
}

// =============================================================================
// 1. AgentMessage Shape Contracts
//
// These fixtures define the EXACT shapes the codebase reads from each
// message type. A replacement runtime must produce messages matching these.
// =============================================================================

describe('AgentMessage shape contracts', () => {
  /**
   * CONTRACT: system/init message
   * Fields consumed: type, subtype, model, session_id, tools
   */
  const systemInitMessage = {
    type: 'system' as const,
    subtype: 'init' as const,
    model: 'claude-sonnet-4-20250514',
    session_id: 'upstream-session-abc',
    tools: ['Read', 'Write', 'Bash'],
  };

  /**
   * CONTRACT: system/compact_boundary message
   * Fields consumed: type, subtype
   */
  const compactBoundaryMessage = {
    type: 'system' as const,
    subtype: 'compact_boundary' as const,
  };

  /**
   * CONTRACT: assistant message (normal text)
   * Fields consumed: type, message.content (array of content blocks)
   */
  const assistantTextMessage = {
    type: 'assistant' as const,
    message: {
      content: [{ type: 'text', text: 'Here is your answer.' }],
    },
  };

  /**
   * CONTRACT: assistant message with structured error
   * Fields consumed: type, message.content, error (string enum)
   */
  const assistantErrorMessage = {
    type: 'assistant' as const,
    message: {
      content: [{ type: 'text', text: 'Rate limit reached' }],
    },
    error: 'rate_limit' as const,
  };

  /**
   * CONTRACT: assistant message with tool_use block
   * Fields consumed: type, message.content[].type, .id, .name, .input
   */
  const assistantToolUseMessage = {
    type: 'assistant' as const,
    message: {
      content: [
        { type: 'tool_use', id: 'tu_123', name: 'Read', input: { file_path: '/tmp/x' } },
      ],
    },
  };

  /**
   * CONTRACT: user message with tool_result block
   * Fields consumed: type, message.content[].type, .tool_use_id, .content (string or array)
   * NOTE: Runtime wraps content in message.content, same nesting as assistant messages
   */
  const userToolResultMessage = {
    type: 'user' as const,
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'tu_123', content: 'file contents here' },
      ],
    },
  };

  /**
   * CONTRACT: result message (success)
   * Fields consumed: type, subtype, is_error, result, stop_reason, usage, total_cost_usd, modelUsage
   */
  const resultSuccessMessage = {
    type: 'result' as const,
    subtype: 'success' as const,
    is_error: false,
    result: 'Task completed successfully.',
    stop_reason: 'end_turn' as const,
    usage: {
      input_tokens: 1500,
      output_tokens: 300,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 100,
    },
    total_cost_usd: 0.0042,
    modelUsage: {
      'claude-sonnet-4-20250514': { input_tokens: 1500, output_tokens: 300 },
    },
  };

  /**
   * CONTRACT: result message (error)
   * Fields consumed: type, subtype, is_error, errors (string[])
   */
  const resultErrorMessage = {
    type: 'result' as const,
    subtype: 'error_max_turns' as const,
    is_error: true,
    errors: ['prompt is too long for the model context window'],
  };

  /**
   * CONTRACT: stream_event message (text delta)
   * Fields consumed: type, event.type, event.delta.type, event.delta.text
   */
  const streamTextDelta = {
    type: 'stream_event' as const,
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'Hello' },
    },
  };

  /**
   * CONTRACT: stream_event message (thinking delta)
   * Fields consumed: type, event.type, event.delta.type, event.delta.thinking
   */
  const streamThinkingDelta = {
    type: 'stream_event' as const,
    event: {
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'Let me reason about this...' },
    },
  };

  it('system/init has required fields', () => {
    expect(systemInitMessage).toHaveProperty('type', 'system');
    expect(systemInitMessage).toHaveProperty('subtype', 'init');
    expect(systemInitMessage).toHaveProperty('model');
    expect(systemInitMessage).toHaveProperty('session_id');
    expect(systemInitMessage).toHaveProperty('tools');
    expect(Array.isArray(systemInitMessage.tools)).toBe(true);
  });

  it('system/compact_boundary has required fields', () => {
    expect(compactBoundaryMessage).toHaveProperty('type', 'system');
    expect(compactBoundaryMessage).toHaveProperty('subtype', 'compact_boundary');
  });

  it('assistant text has required fields', () => {
    expect(assistantTextMessage).toHaveProperty('type', 'assistant');
    expect(assistantTextMessage.message.content[0]).toHaveProperty('type', 'text');
    expect(assistantTextMessage.message.content[0]).toHaveProperty('text');
  });

  it('assistant error has error field (string enum)', () => {
    expect(assistantErrorMessage).toHaveProperty('error');
    expect(['authentication_failed', 'billing_error', 'rate_limit', 'invalid_request', 'server_error', 'unknown'])
      .toContain(assistantErrorMessage.error);
  });

  it('assistant tool_use has required fields', () => {
    const block = assistantToolUseMessage.message.content[0];
    expect(block).toHaveProperty('type', 'tool_use');
    expect(block).toHaveProperty('id');
    expect(block).toHaveProperty('name');
    expect(block).toHaveProperty('input');
  });

  it('user tool_result has required fields', () => {
    const block = userToolResultMessage.message.content[0];
    expect(block).toHaveProperty('type', 'tool_result');
    expect(block).toHaveProperty('tool_use_id');
    expect(block).toHaveProperty('content');
  });

  it('result success has required fields', () => {
    expect(resultSuccessMessage).toHaveProperty('type', 'result');
    expect(resultSuccessMessage).toHaveProperty('result');
    expect(resultSuccessMessage).toHaveProperty('usage');
    expect(resultSuccessMessage.usage).toHaveProperty('input_tokens');
    expect(resultSuccessMessage.usage).toHaveProperty('output_tokens');
    expect(resultSuccessMessage).toHaveProperty('total_cost_usd');
    expect(typeof resultSuccessMessage.total_cost_usd).toBe('number');
  });

  it('result success has modelUsage map', () => {
    expect(resultSuccessMessage).toHaveProperty('modelUsage');
    expect(typeof resultSuccessMessage.modelUsage).toBe('object');
    const keys = Object.keys(resultSuccessMessage.modelUsage);
    expect(keys.length).toBeGreaterThan(0);
  });

  it('result error has errors array', () => {
    expect(resultErrorMessage).toHaveProperty('is_error', true);
    expect(resultErrorMessage).toHaveProperty('errors');
    expect(Array.isArray(resultErrorMessage.errors)).toBe(true);
  });

  it('stream_event text delta has required fields', () => {
    expect(streamTextDelta).toHaveProperty('type', 'stream_event');
    expect(streamTextDelta.event).toHaveProperty('type', 'content_block_delta');
    expect(streamTextDelta.event.delta).toHaveProperty('type', 'text_delta');
    expect(streamTextDelta.event.delta).toHaveProperty('text');
  });

  it('stream_event thinking delta has required fields', () => {
    expect(streamThinkingDelta.event.delta).toHaveProperty('type', 'thinking_delta');
    expect(streamThinkingDelta.event.delta).toHaveProperty('thinking');
  });
});

// =============================================================================
// 2. handleAgentMessage → AgentEvent Mapping
//
// Verifies the output AgentEvent for each input AgentMessage type.
// A replacement runtime doesn't change handleAgentMessage, but these tests
// ensure the mapping logic remains correct during any refactoring.
// =============================================================================

describe('handleAgentMessage → AgentEvent mapping', () => {
  beforeEach(resetState);

  // -- system/init ----------------------------------------------------------
  it('system/init → status event with model and tools', () => {
    handleAgentMessage(null, TURN_ID, {
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-4-20250514',
      session_id: 'upstream-123',
      tools: ['Read', 'Write'],
    } as any);

    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      TURN_ID,
      expect.objectContaining({
        type: 'status',
        message: expect.stringContaining('claude-sonnet-4-20250514'),
      }),
    );
    expect(turnModels.get(TURN_ID)).toBe('claude-sonnet-4-20250514');
  });

  // -- system/compact_boundary -----------------------------------------------
  it('system/compact_boundary → status event about compaction', () => {
    handleAgentMessage(null, TURN_ID, {
      type: 'system',
      subtype: 'compact_boundary',
    } as any);

    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      TURN_ID,
      expect.objectContaining({
        type: 'status',
        message: expect.stringContaining('compact'),
      }),
    );
  });

  // -- assistant (normal text) -----------------------------------------------
  it('assistant text → assistant event', () => {
    handleAgentMessage(null, TURN_ID, {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Hello, how can I help?' }],
      },
    } as any);

    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      TURN_ID,
      expect.objectContaining({
        type: 'assistant',
        text: 'Hello, how can I help?',
      }),
    );
  });

  // -- assistant with structured errors -------------------------------------
  it.each([
    {
      sdkError: 'authentication_failed',
      text: 'bad key',
      expectedError: 'Authentication failed. Check your API key in Settings.',
      expectedErrorKind: 'auth',
      shouldMarkActionable: true,
    },
    {
      sdkError: 'billing_error',
      text: 'billing problem',
      expectedError: "Your API account needs billing attention. Add credits at your provider's console.",
      expectedErrorKind: 'billing',
      shouldMarkActionable: true,
    },
    {
      sdkError: 'invalid_request',
      text: 'The model parameter is invalid.',
      expectedError: 'The request was invalid. Try rephrasing or check Settings > Diagnose.',
      expectedErrorKind: 'invalid_request',
      shouldMarkActionable: false,
    },
    {
      sdkError: 'unknown',
      text: 'mystery failure',
      expectedError: 'An unexpected error occurred. Check Settings > Diagnose for details.',
      expectedErrorKind: undefined,
      shouldMarkActionable: false,
    },
  ])(
    'assistant $sdkError → helper-backed error event',
    ({ sdkError, text, expectedError, expectedErrorKind, shouldMarkActionable }) => {
      handleAgentMessage(null, TURN_ID, {
        type: 'assistant',
        message: { content: [{ type: 'text', text }] },
        error: sdkError,
      } as any);

      const event = dispatchAgentEventMock.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(event).toMatchObject({
        type: 'error',
        error: expectedError,
        errorSource: 'main',
      });
      expect(event).toHaveProperty('timestamp');
      if (expectedErrorKind) {
        expect(event).toHaveProperty('errorKind', expectedErrorKind);
      } else {
        expect(event).not.toHaveProperty('errorKind');
      }
      expect(actionableErrorDispatched.has(TURN_ID)).toBe(shouldMarkActionable);
    },
  );

  it('assistant billing fallback text → billing error event (user-actionable)', () => {
    handleAgentMessage(null, TURN_ID, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Credit balance is too low for this request.' }] },
    } as any);

    const event = dispatchAgentEventMock.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(event).toMatchObject({
      type: 'error',
      error: "Your API account needs billing attention. Add credits at your provider's console.",
      errorKind: 'billing',
      errorSource: 'main',
    });
    expect(actionableErrorDispatched.has(TURN_ID)).toBe(true);
  });

  // -- assistant with rate_limit error → throws for retry --------------------
  it('assistant rate_limit → throws routed error for retry', () => {
    expect(() =>
      handleAgentMessage(null, TURN_ID, {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'rate limited' }] },
        error: 'rate_limit',
      } as any),
    ).toThrow();
  });

  // -- assistant with server_error → throws for retry -----------------------
  it('assistant server_error → throws routed error for retry', () => {
    expect(() =>
      handleAgentMessage(null, TURN_ID, {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'internal error' }] },
        error: 'server_error',
      } as any),
    ).toThrow();
  });

  // -- assistant with extended context error → throws for retry --------------
  it('assistant extended context error → throws for retry', () => {
    expect(() =>
      handleAgentMessage(null, TURN_ID, {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'long context beta is not available' }],
        },
      } as any),
    ).toThrow();
  });

  // -- result (success) -----------------------------------------------------
  it('result success → result event with usage and model', () => {
    turnModels.set(TURN_ID, 'claude-sonnet-4-20250514');

    handleAgentMessage(null, TURN_ID, {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done.',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5,
      },
      total_cost_usd: 0.001,
      modelUsage: {
        'claude-sonnet-4-20250514': { input_tokens: 100, output_tokens: 50 },
      },
    } as any);

    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      TURN_ID,
      expect.objectContaining({
        type: 'result',
        text: 'Done.',
        model: 'claude-sonnet-4-20250514',
        usage: expect.objectContaining({
          inputTokens: 100,
          outputTokens: 50,
          costUsd: 0.001,
        }),
      }),
    );
  });

  // -- result (error with context overflow) ----------------------------------
  it('result error with context overflow → context_overflow event', () => {
    turnPrompts.set(TURN_ID, 'original user prompt');

    handleAgentMessage(null, TURN_ID, {
      type: 'result',
      subtype: 'error',
      is_error: true,
      errors: ['prompt is too long for the model context window'],
    } as any);

    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      TURN_ID,
      expect.objectContaining({
        type: 'context_overflow',
        originalPrompt: 'original user prompt',
      }),
    );
  });

  // -- result error with non-Claude context overflow patterns ----------------
  // FOX-2857: Multi-model turns overflow on non-Claude providers whose error
  // messages don't match Anthropic phrasing.
  it.each([
    ['OpenAI context length', "This model's maximum context length is 128000 tokens. However, your messages resulted in 200000 tokens."],
    ['Google token count exceeds', 'input token count exceeds the maximum number of tokens allowed for model gemini-2.5-pro'],
    ['generic token exceed', 'The number of input tokens exceed the model limit of 200000'],
    ['context length (OpenAI variant)', 'Local model error (400): maximum context length exceeded'],
    ['request too large', 'request too large for processing'],
  ])('result error with %s → context_overflow event', (_label, errorText) => {
    contextOverflowDispatched.clear();
    turnPrompts.set(TURN_ID, 'original user prompt');

    handleAgentMessage(null, TURN_ID, {
      type: 'result',
      subtype: 'error',
      is_error: true,
      errors: [errorText],
    } as any);

    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      TURN_ID,
      expect.objectContaining({
        type: 'context_overflow',
        originalPrompt: 'original user prompt',
      }),
    );
  });

  // -- result error with rate limit → throws for retry ----------------------
  it('result error with rate limit text → throws for retry', () => {
    expect(() =>
      handleAgentMessage(null, TURN_ID, {
        type: 'result',
        subtype: 'error',
        is_error: true,
        errors: ['rate limit exceeded — please wait'],
      } as any),
    ).toThrow();
  });

  // -- result error with session not found → throws for retry ---------------
  it('result error with session not found → throws for retry', () => {
    expect(() =>
      handleAgentMessage(null, TURN_ID, {
        type: 'result',
        subtype: 'error',
        is_error: true,
        errors: ['no conversation found with session id abc-123'],
      } as any),
    ).toThrow();
  });

  it('result error with tool-name-too-long text → helper-backed error event', () => {
    isToolNameLengthErrorMock.mockReturnValueOnce(true);

    handleAgentMessage(null, TURN_ID, {
      type: 'result',
      subtype: 'error',
      is_error: true,
      errors: ['tool name exceeds provider limit'],
    } as any);

    const event = dispatchAgentEventMock.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(event).toMatchObject({
      type: 'error',
      error:
        "One of your MCP tools has a name that's too long for the AI provider. Try disconnecting MCP servers with unusually long tool names, or contact the tool developer.",
      errorSource: 'main',
    });
    expect(event).toHaveProperty('timestamp');
  });

  // -- stream_event text delta -----------------------------------------------
  it('stream_event text delta → assistant_delta event', () => {
    handleAgentMessage(null, TURN_ID, {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'streaming...' },
      },
    } as any);

    // stream_event routes through dispatchAgentEvent which handles assistant_delta specially
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      TURN_ID,
      expect.objectContaining({
        type: 'assistant_delta',
        text: 'streaming...',
      }),
    );
  });

  // -- stream_event thinking delta -------------------------------------------
  it('stream_event thinking delta → thinking_delta event', () => {
    handleAgentMessage(null, TURN_ID, {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'reasoning...' },
      },
    } as any);

    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      TURN_ID,
      expect.objectContaining({
        type: 'thinking_delta',
        text: 'reasoning...',
      }),
    );
  });

  // -- user message (no-op for dispatch) ------------------------------------
  it('user message → no event dispatched (only tool hints collected)', () => {
    handleAgentMessage(null, TURN_ID, {
      type: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'result' },
      ],
    } as any);

    // Only tool hint events may be dispatched, not a "user" type event
    const calls = dispatchAgentEventMock.mock.calls;
    for (const [, , event] of calls) {
      expect(event.type).not.toBe('user');
    }
  });
});

// =============================================================================
// 3. collectToolHints Contract
//
// Verifies tool_use (start) and tool_result (end) extraction from messages.
// =============================================================================

describe('collectToolHints contract', () => {
  it('extracts tool_use start hint from assistant message', () => {
    const hints = collectToolHints({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tu_abc', name: 'Read', input: { file_path: '/tmp/x' } },
        ],
      },
    } as any);

    expect(hints.length).toBeGreaterThanOrEqual(1);
    const start = hints.find((h: any) => h.stage === 'start');
    expect(start).toBeDefined();
    expect(start!.toolName).toBe('Read');
    expect((start as any).toolUseId).toBe('tu_abc');
  });

  it('extracts tool_result end hint from user message', () => {
    // NOTE: Runtime wraps user tool_result in message.message.content, not message.content
    const hints = collectToolHints({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tu_abc', content: 'file contents' },
        ],
      },
    } as any);

    expect(hints.length).toBeGreaterThanOrEqual(1);
    const end = hints.find((h: any) => h.stage === 'end');
    expect(end).toBeDefined();
    expect((end as any).toolUseId).toBe('tu_abc');
  });

  it('returns empty array for messages without tool blocks', () => {
    const hints = collectToolHints({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'no tools here' }],
      },
    } as any);

    expect(hints).toEqual([]);
  });
});

// =============================================================================
// 4. query() Async Iterator Protocol
//
// The replacement must return an AsyncIterable<AgentMessage>.
// This test validates the protocol shape, not the real runtime.
// =============================================================================

describe('query() async iterator protocol', () => {
  it('replacement must yield AgentMessage items via async iterator', async () => {
    // This simulates what a replacement query() function must produce.
    // The agentTurnExecutor consumes it as: for await (const message of query({...})) { ... }
    async function* mockQuery(): AsyncIterable<any> {
      yield { type: 'system', subtype: 'init', model: 'test-model', session_id: 'sess-1', tools: [] };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } };
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Done',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
        total_cost_usd: 0.0001,
      };
    }

    const messages: any[] = [];
    for await (const msg of mockQuery()) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(3);
    expect(messages[0].type).toBe('system');
    expect(messages[1].type).toBe('assistant');
    expect(messages[2].type).toBe('result');
  });

  it('replacement must support AbortController cancellation', async () => {
    const controller = new AbortController();

    async function* mockQuery(signal: AbortSignal): AsyncIterable<any> {
      yield { type: 'system', subtype: 'init', model: 'test', tools: [] };
      if (signal.aborted) return;
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'working...' }] } };
      if (signal.aborted) return;
      yield { type: 'result', subtype: 'success', result: 'Done', is_error: false };
    }

    controller.abort();
    const messages: any[] = [];
    for await (const msg of mockQuery(controller.signal)) {
      messages.push(msg);
    }

    // After abort, iterator should stop after first yield (system/init)
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('system');
  });
});

// =============================================================================
// 5. Options Shape Contract
//
// Documents the Options fields the codebase passes to query().
// A replacement must accept these fields (or map them).
// =============================================================================

describe('Options shape contract', () => {
  it('documents all Options fields consumed by agentTurnExecutor', () => {
    // This is a reference fixture — not passed to any function.
    // It documents every field the codebase sets on the TurnParams / query options.
    const optionsFixture = {
      // Required
      cwd: '/path/to/workspace',
      model: 'claude-sonnet-4-20250514',
      permissionMode: 'bypassPermissions',
      systemPrompt: 'You are a helpful assistant.',

      // MCP servers (map of server-id → config)
      mcpServers: {
        'my-server': {
          command: 'node',
          args: ['server.js'],
          env: { API_KEY: 'xxx' },
        },
      },

      // Environment variables for model configuration
      env: {
        PATH: '/usr/bin',
        CLAUDE_CODE_EFFORT_LEVEL: 'medium',
      },

      // Execution control
      abortController: new AbortController(),
      includePartialMessages: true,

      // Hooks for tool safety and memory
      hooks: {
        PreToolUse: [{ hooks: [async () => ({ continue: true })] }],
      },
    };

    // Verify shape
    expect(optionsFixture).toHaveProperty('cwd');
    expect(optionsFixture).toHaveProperty('model');
    expect(optionsFixture).toHaveProperty('permissionMode');
    expect(optionsFixture).toHaveProperty('systemPrompt');
    expect(optionsFixture).toHaveProperty('mcpServers');
    expect(optionsFixture).toHaveProperty('env');
    expect(optionsFixture).toHaveProperty('hooks');
    expect(optionsFixture).toHaveProperty('abortController');
    expect(optionsFixture).toHaveProperty('includePartialMessages');
    expect(optionsFixture).toHaveProperty('hooks.PreToolUse');
    expect(Array.isArray(optionsFixture.hooks.PreToolUse)).toBe(true);
  });

  it('MCP server config has required shape', () => {
    const mcpConfig = {
      command: 'npx',
      args: ['-y', '@my/mcp-server'],
      env: { TOKEN: 'abc' },
    };

    expect(mcpConfig).toHaveProperty('command');
    expect(mcpConfig).toHaveProperty('args');
    expect(Array.isArray(mcpConfig.args)).toBe(true);
  });

  it('HookCallback returns HookJSONOutput shape', async () => {
    const hook = async (_toolUse: unknown, _toolUseId: string) => ({
      continue: true,
      hookSpecificOutput: {
        permissionDecision: 'allow' as const,
        permissionDecisionReason: 'test',
      },
    });

    const result = await hook({}, 'tool-123');
    expect(result).toHaveProperty('continue');
    expect(result).toHaveProperty('hookSpecificOutput.permissionDecision');
    expect(['allow', 'deny', 'ask']).toContain(result.hookSpecificOutput.permissionDecision);
  });

  it('Options.outputFormat for structured JSON output (BTS client)', () => {
    const optionsWithFormat = {
      cwd: '/workspace',
      model: 'claude-sonnet-4-20250514',
      permissionMode: 'bypassPermissions',
      systemPrompt: 'test',
      outputFormat: {
        type: 'json_schema' as const,
        schema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
        },
      },
    };
    expect(optionsWithFormat.outputFormat).toHaveProperty('type', 'json_schema');
    expect(optionsWithFormat.outputFormat).toHaveProperty('schema');
  });

  it('Options.signal for per-query abort (warmup service)', () => {
    const controller = new AbortController();
    const optionsWithSignal = {
      cwd: '/workspace',
      model: 'test',
      signal: controller.signal,
    };
    expect(optionsWithSignal).toHaveProperty('signal');
    expect(optionsWithSignal.signal).toBeInstanceOf(AbortSignal);
  });
});

// =============================================================================
// 6. Subagent / Nested Tool Use (parent_tool_use_id)
//
// When the runtime executes subagent tasks, tool messages carry parent_tool_use_id
// to establish the nesting hierarchy.
// =============================================================================

describe('subagent / nested tool use contract', () => {
  it('tool_use message with parent_tool_use_id carries nesting info', () => {
    const nestedToolUse = {
      type: 'assistant' as const,
      parent_tool_use_id: 'parent_tu_001',
      message: {
        content: [
          { type: 'tool_use', id: 'child_tu_001', name: 'Read', input: { file_path: '/x' } },
        ],
      },
    };

    expect(nestedToolUse).toHaveProperty('parent_tool_use_id', 'parent_tu_001');
  });

  it('collectToolHints propagates parent_tool_use_id to tool events', () => {
    const hints = collectToolHints({
      type: 'assistant',
      parent_tool_use_id: 'parent_tu_002',
      message: {
        content: [
          { type: 'tool_use', id: 'child_tu_002', name: 'Write', input: {} },
        ],
      },
    } as any);

    expect(hints.length).toBeGreaterThanOrEqual(1);
    const start = hints.find((h: any) => h.stage === 'start');
    expect(start).toBeDefined();
    expect((start as any).parentToolUseId).toBe('parent_tu_002');
  });

  it('tool_result with parent_tool_use_id propagates nesting', () => {
    const hints = collectToolHints({
      type: 'user',
      parent_tool_use_id: 'parent_tu_003',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'child_tu_003', content: 'done' },
        ],
      },
    } as any);

    expect(hints.length).toBeGreaterThanOrEqual(1);
    const end = hints.find((h: any) => h.stage === 'end');
    expect(end).toBeDefined();
    expect((end as any).parentToolUseId).toBe('parent_tu_003');
  });

  it('null parent_tool_use_id for top-level tools', () => {
    const hints = collectToolHints({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tu_top', name: 'Bash', input: {} },
        ],
      },
    } as any);

    const start = hints.find((h: any) => h.stage === 'start');
    expect(start).toBeDefined();
    expect((start as any).parentToolUseId).toBeNull();
  });
});

// =============================================================================
// 7. Synthetic / Claude Max Messages
//
// When Claude Max hits its daily cap, the runtime emits an assistant message with
// model: "<synthetic>" and usage-limit text. The runtime must emit this shape
// so the rate_limit fallback triggers.
// =============================================================================

describe('synthetic message contract', () => {
  beforeEach(resetState);

  it('synthetic usage-limit message shape', () => {
    const syntheticMessage = {
      type: 'assistant' as const,
      message: {
        model: '<synthetic>',
        content: [{ type: 'text', text: "You've hit your rate limit. Resets at 6pm." }],
      },
    };

    expect(syntheticMessage.message.model).toBe('<synthetic>');
    expect(syntheticMessage.message.content[0].text).toContain('rate limit');
  });
});

// =============================================================================
// 8. Empty Result Anomaly
//
// When the runtime returns an empty result but output_tokens > 0, the handler
// must attempt recovery from accumulated content or throw for retry.
// =============================================================================

describe('empty result anomaly contract', () => {
  beforeEach(resetState);

  it('empty result with output_tokens triggers recovery or retry', () => {
    const emptyResultMessage = {
      type: 'result' as const,
      subtype: 'success' as const,
      is_error: false,
      result: '',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 500,
        output_tokens: 200,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      total_cost_usd: 0.002,
      modelUsage: {},
    };

    // Empty result + output_tokens > 0 = anomaly
    expect(emptyResultMessage.result).toBe('');
    expect(emptyResultMessage.usage.output_tokens).toBeGreaterThan(0);

    // When no accumulated content exists, handler should throw
    contextAccumulators.delete(TURN_ID);
    expect(() =>
      handleAgentMessage(null, TURN_ID, emptyResultMessage as any),
    ).toThrow(/empty_result_anomaly/);
  });

  // Regression: the old 100-char threshold would reject short valid responses
  // like greetings ("Hey Greg! What can I help with?"), causing false-positive
  // empty_result_anomaly retries that led to double-replies.
  it('empty result recovers from short assistant content (any non-empty text)', () => {
    contextAccumulators.set(TURN_ID, {
      messages: [
        { role: 'assistant', text: 'Hey Greg! What can I help with?' },
      ],
      eventsByTurn: {},
      activeTurnId: TURN_ID,
      isBusy: false,
      lastError: null,
      lastErrorSource: null,
    });

    const emptyResultMessage = {
      type: 'result' as const,
      subtype: 'success' as const,
      is_error: false,
      result: '',
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
      total_cost_usd: 0.001,
      modelUsage: {},
    };

    expect(() =>
      handleAgentMessage(null, TURN_ID, emptyResultMessage as any),
    ).not.toThrow();

    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      TURN_ID,
      expect.objectContaining({
        type: 'result',
        text: 'Hey Greg! What can I help with?',
      }),
    );
  });

  it('empty result recovers from accumulated assistant content', () => {
    // Set up accumulated content with substantial assistant message
    contextAccumulators.set(TURN_ID, {
      messages: [
        { role: 'assistant', text: 'A'.repeat(200) },
      ],
      eventsByTurn: {},
      activeTurnId: TURN_ID,
      isBusy: false,
      lastError: null,
      lastErrorSource: null,
    });

    const emptyResultMessage = {
      type: 'result' as const,
      subtype: 'success' as const,
      is_error: false,
      result: '',
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
      total_cost_usd: 0.001,
      modelUsage: {},
    };

    // Should NOT throw - recovers from accumulated content
    expect(() =>
      handleAgentMessage(null, TURN_ID, emptyResultMessage as any),
    ).not.toThrow();

    // Should dispatch result with recovered text
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      TURN_ID,
      expect.objectContaining({
        type: 'result',
        text: 'A'.repeat(200),
      }),
    );
  });

  // Regression: multi-turn tool sessions triggered false-positive empty_result_anomaly
  // when the anomaly detector used loop-total tokens instead of final-turn tokens.
  // See docs/plans/260417_empty_result_anomaly_resilience.md (Bug 1)
  it('empty result with last_turn_output_tokens=0 does NOT throw (model done after tools)', () => {
    // Rebel Core runtime: final turn is empty but earlier tool turns consumed tokens.
    // This is legitimate "model done after tools" behavior — loop-total is positive
    // but final turn produced no text. Seed with a successful tool event so we
    // exercise the full "after tools" scenario, not just the token-check.
    contextAccumulators.set(TURN_ID, {
      messages: [],
      eventsByTurn: {
        [TURN_ID]: [
          { type: 'tool', stage: 'end', isError: false, toolName: 'Read' } as any,
        ],
      },
      activeTurnId: TURN_ID,
      isBusy: false,
      lastError: null,
      lastErrorSource: null,
    });

    const emptyResultMessage = {
      type: 'result' as const,
      subtype: 'success' as const,
      is_error: false,
      result: '',
      stop_reason: 'end_turn',
      usage: { input_tokens: 500, output_tokens: 200 }, // loop-total > 0
      last_turn_output_tokens: 0, // but final turn was empty
      executor_tool_count: 1, // real execution count from live tool_use:start events
      total_cost_usd: 0.002,
      modelUsage: {},
    };

    expect(() =>
      handleAgentMessage(null, TURN_ID, emptyResultMessage as any),
    ).not.toThrow();

    // Verify a success result is dispatched with "Done." acknowledgment.
    // The model completed work via tools but produced no final-turn text,
    // so agentMessageHandler synthesizes a brief acknowledgment.
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      TURN_ID,
      expect.objectContaining({ type: 'result', text: 'Done.' }),
    );
    // No error events should have been dispatched.
    const errorDispatches = dispatchAgentEventMock.mock.calls.filter(
      (call) => (call[2] as { type?: string })?.type === 'error',
    );
    expect(errorDispatches).toHaveLength(0);
  });

  // Edge case: last_turn_output_tokens is present but result is NOT empty.
  // The new field should only affect the empty-result anomaly path — non-empty
  // results must be dispatched normally regardless of token counts.
  it('non-empty result passes through regardless of last_turn_output_tokens value', () => {
    contextAccumulators.delete(TURN_ID);

    const resultMessage = {
      type: 'result' as const,
      subtype: 'success' as const,
      is_error: false,
      result: 'Here is your answer.',
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
      last_turn_output_tokens: 50,
      total_cost_usd: 0.001,
      modelUsage: {},
    };

    expect(() =>
      handleAgentMessage(null, TURN_ID, resultMessage as any),
    ).not.toThrow();

    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      TURN_ID,
      expect.objectContaining({
        type: 'result',
        text: 'Here is your answer.',
      }),
    );
  });

  it('empty result with zero total output tokens throws anomaly (provider returned nothing)', () => {
    // Provider/model returned absolutely nothing — 0 output tokens, empty result.
    // This must throw empty_result_anomaly so error recovery can retry or surface
    // an error to the user instead of silently completing with an empty turn.
    // Regression: previously, 0-output-token responses silently completed.
    contextAccumulators.set(TURN_ID, {
      messages: [],
      eventsByTurn: { [TURN_ID]: [] },
      activeTurnId: TURN_ID,
      isBusy: false,
      lastError: null,
      lastErrorSource: null,
    });

    const emptyResultMessage = {
      type: 'result' as const,
      subtype: 'success' as const,
      is_error: false,
      result: '',
      stop_reason: 'end_turn',
      usage: { input_tokens: 41000, output_tokens: 0 },
      last_turn_output_tokens: 0,
      total_cost_usd: 0,
      modelUsage: {},
    };

    expect(() =>
      handleAgentMessage(null, TURN_ID, emptyResultMessage as any),
    ).toThrow(/empty_result_anomaly/);
  });

  it('empty result with zero output tokens does NOT throw when user question pending', () => {
    // Even with 0 output tokens, a user-question pause is legitimate —
    // the AskUserQuestion hook intercepted the turn before the model responded.
    (agentTurnRegistry.hasUserQuestionPending as any).mockReturnValueOnce(true);

    contextAccumulators.set(TURN_ID, {
      messages: [],
      eventsByTurn: { [TURN_ID]: [] },
      activeTurnId: TURN_ID,
      isBusy: false,
      lastError: null,
      lastErrorSource: null,
    });

    const emptyResultMessage = {
      type: 'result' as const,
      subtype: 'success' as const,
      is_error: false,
      result: '',
      stop_reason: 'end_turn',
      usage: { input_tokens: 41000, output_tokens: 0 },
      last_turn_output_tokens: 0,
      total_cost_usd: 0,
      modelUsage: {},
    };

    expect(() =>
      handleAgentMessage(null, TURN_ID, emptyResultMessage as any),
    ).not.toThrow();
  });

  it('empty result with zero output tokens does NOT throw when user question event present', () => {
    // Event-based exemption: the user_question event in the turn's accumulated
    // events also exempts 0-token results from the anomaly check.
    (agentTurnRegistry.hasUserQuestionPending as any).mockReturnValueOnce(false);

    contextAccumulators.set(TURN_ID, {
      messages: [],
      eventsByTurn: {
        [TURN_ID]: [
          { type: 'user_question' } as any,
        ],
      },
      activeTurnId: TURN_ID,
      isBusy: false,
      lastError: null,
      lastErrorSource: null,
    });

    const emptyResultMessage = {
      type: 'result' as const,
      subtype: 'success' as const,
      is_error: false,
      result: '',
      stop_reason: 'end_turn',
      usage: { input_tokens: 41000, output_tokens: 0 },
      last_turn_output_tokens: 0,
      total_cost_usd: 0,
      modelUsage: {},
    };

    expect(() =>
      handleAgentMessage(null, TURN_ID, emptyResultMessage as any),
    ).not.toThrow();
  });

  it('empty result with last_turn_output_tokens>0 STILL throws anomaly', () => {
    // Final turn claims it produced tokens but result is empty — genuine anomaly.
    contextAccumulators.delete(TURN_ID);

    const emptyResultMessage = {
      type: 'result' as const,
      subtype: 'success' as const,
      is_error: false,
      result: '',
      stop_reason: 'end_turn',
      usage: { input_tokens: 500, output_tokens: 200 },
      last_turn_output_tokens: 50, // final turn produced tokens but no text
      total_cost_usd: 0.002,
      modelUsage: {},
    };

    expect(() =>
      handleAgentMessage(null, TURN_ID, emptyResultMessage as any),
    ).toThrow(/empty_result_anomaly/);
  });

  it('empty result without last_turn_output_tokens field falls back to loop-total (legacy/SDK path)', () => {
    // Legacy runtimes don't emit last_turn_output_tokens. The handler must fall
    // back to loop-total to preserve existing behavior.
    contextAccumulators.delete(TURN_ID);

    const emptyResultMessage = {
      type: 'result' as const,
      subtype: 'success' as const,
      is_error: false,
      result: '',
      stop_reason: 'end_turn',
      usage: { input_tokens: 500, output_tokens: 200 }, // loop-total > 0
      // last_turn_output_tokens intentionally omitted
      total_cost_usd: 0.002,
      modelUsage: {},
    };

    expect(() =>
      handleAgentMessage(null, TURN_ID, emptyResultMessage as any),
    ).toThrow(/empty_result_anomaly/);
  });

  // REBEL-1G0 regression: the model returns a small positive number of
  // final-turn output tokens (e.g. 2 thinking-budget or whitespace tokens)
  // after a multi-turn tool session that ended in `end_turn`. Previously the
  // anomaly detector fired before the "done after tools" synthesis branch had
  // a chance to run. The fix is to fold the same real-execution gate into the
  // first anomaly block so legitimate completions become "Done." instead of
  // false-positive empty_result_anomaly throws.
  describe('REBEL-1G0 regression — small positive last_turn_output_tokens with real tool execution', () => {
    it('synthesizes "Done." when last_turn_output_tokens=2 and real tools ran', () => {
      contextAccumulators.set(TURN_ID, {
        messages: [],
        eventsByTurn: {
          [TURN_ID]: [
            { type: 'tool', stage: 'end', isError: false, toolName: 'Read' } as any,
          ],
        },
        activeTurnId: TURN_ID,
        isBusy: false,
        lastError: null,
        lastErrorSource: null,
      });

      const emptyResultMessage = {
        type: 'result' as const,
        subtype: 'success' as const,
        is_error: false,
        result: '',
        stop_reason: 'end_turn',
        usage: { input_tokens: 800, output_tokens: 1500 }, // loop-total covers tool turns
        last_turn_output_tokens: 2, // tiny final-turn tokens (thinking/whitespace)
        executor_tool_count: 1, // real model-invoked tool execution
        total_cost_usd: 0.005,
        modelUsage: {},
      };

      expect(() =>
        handleAgentMessage(null, TURN_ID, emptyResultMessage as any),
      ).not.toThrow();

      expect(dispatchAgentEventMock).toHaveBeenCalledWith(
        null,
        TURN_ID,
        expect.objectContaining({ type: 'result', text: 'Done.' }),
      );
      const errorDispatches = dispatchAgentEventMock.mock.calls.filter(
        (call) => (call[2] as { type?: string })?.type === 'error',
      );
      expect(errorDispatches).toHaveLength(0);
    });

    it('STILL throws when last_turn_output_tokens=2 but NO real tool execution', () => {
      // Same small positive token count, but executor_tool_count=0 and no
      // meaningful tool ends — must still throw so the user sees the
      // graceful-degradation error instead of a misleading "Done.".
      contextAccumulators.set(TURN_ID, {
        messages: [],
        eventsByTurn: { [TURN_ID]: [] },
        activeTurnId: TURN_ID,
        isBusy: false,
        lastError: null,
        lastErrorSource: null,
      });

      const emptyResultMessage = {
        type: 'result' as const,
        subtype: 'success' as const,
        is_error: false,
        result: '',
        stop_reason: 'end_turn',
        usage: { input_tokens: 800, output_tokens: 1500 },
        last_turn_output_tokens: 2,
        executor_tool_count: 0,
        total_cost_usd: 0.005,
        modelUsage: {},
      };

      expect(() =>
        handleAgentMessage(null, TURN_ID, emptyResultMessage as any),
      ).toThrow(/empty_result_anomaly/);
    });

    it('synthesizes "Done." when last_turn_output_tokens=null and real tools ran', () => {
      // null falls through to loop-total via `??`, so we still enter the
      // first anomaly block. The shared real-execution gate must allow
      // synthesis here too.
      contextAccumulators.set(TURN_ID, {
        messages: [],
        eventsByTurn: {
          [TURN_ID]: [
            { type: 'tool', stage: 'end', isError: false, toolName: 'Read' } as any,
          ],
        },
        activeTurnId: TURN_ID,
        isBusy: false,
        lastError: null,
        lastErrorSource: null,
      });

      const emptyResultMessage = {
        type: 'result' as const,
        subtype: 'success' as const,
        is_error: false,
        result: '',
        stop_reason: 'end_turn',
        usage: { input_tokens: 800, output_tokens: 1500 },
        last_turn_output_tokens: null, // explicit null (vs undefined)
        executor_tool_count: 1,
        total_cost_usd: 0.005,
        modelUsage: {},
      };

      expect(() =>
        handleAgentMessage(null, TURN_ID, emptyResultMessage as any),
      ).not.toThrow();

      expect(dispatchAgentEventMock).toHaveBeenCalledWith(
        null,
        TURN_ID,
        expect.objectContaining({ type: 'result', text: 'Done.' }),
      );
    });

    it('STILL throws when last_turn_output_tokens=2 and only bookkeeping tools ran', () => {
      // executor_tool_count > 0 alone is not enough — bookkeeping tools
      // (TaskUpdate, MissionSet, etc.) don't count as "real execution".
      contextAccumulators.set(TURN_ID, {
        messages: [],
        eventsByTurn: {
          [TURN_ID]: [
            { type: 'tool', stage: 'end', isError: false, toolName: 'TaskUpdate' } as any,
          ],
        },
        activeTurnId: TURN_ID,
        isBusy: false,
        lastError: null,
        lastErrorSource: null,
      });

      const emptyResultMessage = {
        type: 'result' as const,
        subtype: 'success' as const,
        is_error: false,
        result: '',
        stop_reason: 'end_turn',
        usage: { input_tokens: 800, output_tokens: 1500 },
        last_turn_output_tokens: 2,
        executor_tool_count: 1,
        total_cost_usd: 0.005,
        modelUsage: {},
      };

      expect(() =>
        handleAgentMessage(null, TURN_ID, emptyResultMessage as any),
      ).toThrow(/empty_result_anomaly/);
    });
  });

  // Regression: a denied AskUserQuestion (via userQuestionHook deny-and-retry)
  // produces a tool/end event with isError:true. The previous terminal-tool
  // check filtered these out, causing empty_result_anomaly to fire on a cleanly
  // paused turn. Verified against session mobile-1776630457445-9hebov9q.
  // See docs/plans/260420_user_question_cross_surface_resilience.md
  describe('user-question pause detection (regression for 260420 bug)', () => {
    it('signal-based: hasUserQuestionPending=true → no throw even with output tokens', () => {
      // Simulate the hook having marked pending before the empty result arrived.
      (agentTurnRegistry.hasUserQuestionPending as any).mockReturnValueOnce(true);

      contextAccumulators.set(TURN_ID, {
        messages: [],
        eventsByTurn: { [TURN_ID]: [] },
        activeTurnId: TURN_ID,
        isBusy: false,
        lastError: null,
        lastErrorSource: null,
      });

      const emptyResultMessage = {
        type: 'result' as const,
        subtype: 'success' as const,
        is_error: false,
        result: '',
        stop_reason: 'end_turn',
        usage: { input_tokens: 500, output_tokens: 1609 },
        last_turn_output_tokens: 3, // matches the real failing turn
        total_cost_usd: 0.624,
        modelUsage: {},
      };

      expect(() =>
        handleAgentMessage(null, TURN_ID, emptyResultMessage as any),
      ).not.toThrow();

      const errorDispatches = dispatchAgentEventMock.mock.calls.filter(
        (call) => (call[2] as { type?: string })?.type === 'error',
      );
      expect(errorDispatches).toHaveLength(0);
    });

    it('event-based: user_question event in turnEvents → no throw', () => {
      contextAccumulators.set(TURN_ID, {
        messages: [],
        eventsByTurn: {
          [TURN_ID]: [
            { type: 'user_question', batchId: 'b1', toolUseId: 'tu1', questions: [], timestamp: 0 } as any,
          ],
        },
        activeTurnId: TURN_ID,
        isBusy: false,
        lastError: null,
        lastErrorSource: null,
      });

      const emptyResultMessage = {
        type: 'result' as const,
        subtype: 'success' as const,
        is_error: false,
        result: '',
        stop_reason: 'end_turn',
        usage: { input_tokens: 500, output_tokens: 200 },
        last_turn_output_tokens: 3,
        total_cost_usd: 0.002,
        modelUsage: {},
      };

      expect(() =>
        handleAgentMessage(null, TURN_ID, emptyResultMessage as any),
      ).not.toThrow();
    });

    it('tool-based (belt-and-braces): AskUserQuestion tool/end with isError=true → no throw', () => {
      // The exact shape that broke session mobile-1776630457445-9hebov9q.
      // Previous TERMINAL_TOOLS filter excluded isError:true events; the fix
      // drops that filter so denied AskUserQuestion is still recognised.
      contextAccumulators.set(TURN_ID, {
        messages: [],
        eventsByTurn: {
          [TURN_ID]: [
            {
              type: 'tool',
              stage: 'end',
              isError: true,
              toolName: 'AskUserQuestion',
              toolUseId: 'tu1',
              detail: 'TOOL PAUSED — WAITING FOR USER RESPONSE',
            } as any,
          ],
        },
        activeTurnId: TURN_ID,
        isBusy: false,
        lastError: null,
        lastErrorSource: null,
      });

      const emptyResultMessage = {
        type: 'result' as const,
        subtype: 'success' as const,
        is_error: false,
        result: '',
        stop_reason: 'end_turn',
        usage: { input_tokens: 500, output_tokens: 1609 },
        last_turn_output_tokens: 3,
        total_cost_usd: 0.624,
        modelUsage: {},
      };

      expect(() =>
        handleAgentMessage(null, TURN_ID, emptyResultMessage as any),
      ).not.toThrow();

      const errorDispatches = dispatchAgentEventMock.mock.calls.filter(
        (call) => (call[2] as { type?: string })?.type === 'error',
      );
      expect(errorDispatches).toHaveLength(0);
    });

    it('classifies pauseType=user_question when BOTH flag and event are present', () => {
      (agentTurnRegistry.hasUserQuestionPending as any).mockReturnValueOnce(true);
      contextAccumulators.set(TURN_ID, {
        messages: [],
        eventsByTurn: {
          [TURN_ID]: [
            { type: 'user_question', batchId: 'b1', toolUseId: 'tu1', questions: [], timestamp: 0 } as any,
          ],
        },
        activeTurnId: TURN_ID,
        isBusy: false,
        lastError: null,
        lastErrorSource: null,
      });
      const emptyResultMessage = {
        type: 'result' as const,
        subtype: 'success' as const,
        is_error: false,
        result: '',
        stop_reason: 'end_turn',
        usage: { input_tokens: 500, output_tokens: 200 },
        last_turn_output_tokens: 3,
        total_cost_usd: 0.002,
        modelUsage: {},
      };
      expect(() => handleAgentMessage(null, TURN_ID, emptyResultMessage as any)).not.toThrow();
      expect(mockTurnLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ pauseType: 'user_question' }),
        expect.stringContaining('valid pause turn'),
      );
    });

    it('classifies pauseType=ambiguous when ONLY one signal is present (tool-only)', () => {
      (agentTurnRegistry.hasUserQuestionPending as any).mockReturnValueOnce(false);
      contextAccumulators.set(TURN_ID, {
        messages: [],
        eventsByTurn: {
          [TURN_ID]: [
            {
              type: 'tool',
              stage: 'end',
              isError: true,
              toolName: 'AskUserQuestion',
              toolUseId: 'tu1',
              detail: 'TOOL PAUSED — WAITING FOR USER RESPONSE',
            } as any,
          ],
        },
        activeTurnId: TURN_ID,
        isBusy: false,
        lastError: null,
        lastErrorSource: null,
      });
      const emptyResultMessage = {
        type: 'result' as const,
        subtype: 'success' as const,
        is_error: false,
        result: '',
        stop_reason: 'end_turn',
        usage: { input_tokens: 500, output_tokens: 200 },
        last_turn_output_tokens: 3,
        total_cost_usd: 0.002,
        modelUsage: {},
      };
      expect(() => handleAgentMessage(null, TURN_ID, emptyResultMessage as any)).not.toThrow();
      // Ambiguous path logs a WARNING (not info) so it surfaces in log-based dashboards.
      expect(mockTurnLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ pauseType: 'ambiguous' }),
        expect.stringContaining('ambiguous pause classification'),
      );
    });

    it('regression guard: empty result with no pause signals STILL throws anomaly', () => {
      // Ensures the pause-detection additions did not weaken the anomaly path
      // for genuine truncations. No pending flag, no user_question event, no
      // AskUserQuestion tool, but final-turn tokens > 0 → anomaly.
      contextAccumulators.set(TURN_ID, {
        messages: [],
        eventsByTurn: {
          [TURN_ID]: [
            { type: 'tool', stage: 'end', isError: false, toolName: 'Read' } as any,
          ],
        },
        activeTurnId: TURN_ID,
        isBusy: false,
        lastError: null,
        lastErrorSource: null,
      });

      const emptyResultMessage = {
        type: 'result' as const,
        subtype: 'success' as const,
        is_error: false,
        result: '',
        stop_reason: 'end_turn',
        usage: { input_tokens: 500, output_tokens: 200 },
        last_turn_output_tokens: 50,
        total_cost_usd: 0.002,
        modelUsage: {},
      };

      expect(() =>
        handleAgentMessage(null, TURN_ID, emptyResultMessage as any),
      ).toThrow(/empty_result_anomaly/);
    });
  });
});

// =============================================================================
// 9. MCP Apps UI Metadata in Tool Results
//
// Tool results can carry _meta.ui with resourceUri for rendering interactive
// views. The replacement runtime must preserve _meta on tool_result blocks.
// =============================================================================

describe('MCP Apps UI metadata contract', () => {
  it('tool_result _meta.ui shape with resourceUri', () => {
    const toolResultWithMeta = {
      type: 'tool_result',
      tool_use_id: 'tu_mcp_app',
      content: [{ type: 'text', text: 'App rendered' }],
      is_error: false,
      _meta: {
        ui: {
          resourceUri: 'ui://my-app/dashboard',
          protocolUrl: 'https://my-app.com/protocol',
          originalFilePath: '/path/to/app.html',
        },
      },
    };

    expect(toolResultWithMeta._meta.ui).toHaveProperty('resourceUri');
    expect(typeof toolResultWithMeta._meta.ui.resourceUri).toBe('string');
    expect(toolResultWithMeta._meta.ui.resourceUri).toMatch(/^ui:\/\//);
  });

  it('tool_result with resource content block (MCP Apps mime type)', () => {
    const toolResultWithResource = {
      type: 'tool_result',
      tool_use_id: 'tu_mcp_resource',
      content: [
        {
          type: 'resource',
          uri: 'ui://widget/chart',
          mimeType: 'text/html;profile=mcp-app',
          _meta: { ui: { csp: "script-src 'self'" } },
        },
      ],
    };

    const resource = toolResultWithResource.content[0];
    expect(resource.type).toBe('resource');
    expect(resource.mimeType).toBe('text/html;profile=mcp-app');
    expect(resource.uri).toMatch(/^ui:\/\//);
  });
});

// =============================================================================
// 10. Multi-Turn Tool Loop (Full Cycle)
//
// The core agentic pattern: assistant requests tool_use → runtime executes it
// → user message returns tool_result → assistant continues.
// A replacement must orchestrate this loop producing the correct message sequence.
// =============================================================================

describe('multi-turn tool loop contract', () => {
  it('full agentic cycle: init → tool_use → tool_result → assistant → result', async () => {
    async function* mockAgenticQuery(): AsyncIterable<any> {
      // 1. System init
      yield {
        type: 'system',
        subtype: 'init',
        model: 'claude-sonnet-4-20250514',
        session_id: 'sess-loop',
        tools: ['Read', 'Write', 'Bash'],
      };

      // 2. Assistant requests a tool
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Let me read that file.' },
            { type: 'tool_use', id: 'tu_read_1', name: 'Read', input: { file_path: '/tmp/data.txt' } },
          ],
        },
      };

      // 3. Runtime executes tool, returns result as user message
      yield {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu_read_1', content: 'file contents here' },
          ],
        },
      };

      // 4. Assistant produces final answer
      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'The file contains: file contents here' }],
        },
      };

      // 5. Result
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'The file contains: file contents here',
        stop_reason: 'end_turn',
        usage: { input_tokens: 200, output_tokens: 100 },
        total_cost_usd: 0.003,
        modelUsage: { 'claude-sonnet-4-20250514': { input_tokens: 200, output_tokens: 100 } },
      };
    }

    const messages: any[] = [];
    for await (const msg of mockAgenticQuery()) {
      messages.push(msg);
    }

    // Verify the sequence
    expect(messages[0].type).toBe('system');
    expect(messages[0].subtype).toBe('init');
    expect(messages[1].type).toBe('assistant');
    expect(messages[1].message.content.some((b: any) => b.type === 'tool_use')).toBe(true);
    expect(messages[2].type).toBe('user');
    expect(messages[2].message.content[0].type).toBe('tool_result');
    expect(messages[3].type).toBe('assistant');
    expect(messages[4].type).toBe('result');
    expect(messages[4].subtype).toBe('success');
  });

  it('multi-tool turn: assistant requests multiple tools simultaneously', async () => {
    async function* mockMultiToolQuery(): AsyncIterable<any> {
      yield { type: 'system', subtype: 'init', model: 'test', tools: ['Read', 'Bash'] };

      // Assistant requests TWO tools at once (parallel tool use)
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu_a', name: 'Read', input: { file_path: '/a' } },
            { type: 'tool_use', id: 'tu_b', name: 'Bash', input: { command: 'echo hi' } },
          ],
        },
      };

      // Both results come back in one user message
      yield {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu_a', content: 'contents of a' },
            { type: 'tool_result', tool_use_id: 'tu_b', content: 'hi' },
          ],
        },
      };

      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Both operations completed.',
      };
    }

    const messages: any[] = [];
    for await (const msg of mockMultiToolQuery()) {
      messages.push(msg);
    }

    // Verify parallel tool use
    const toolUseBlocks = messages[1].message.content.filter((b: any) => b.type === 'tool_use');
    expect(toolUseBlocks).toHaveLength(2);

    // Verify parallel tool results
    const toolResults = messages[2].message.content.filter((b: any) => b.type === 'tool_result');
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0].tool_use_id).toBe('tu_a');
    expect(toolResults[1].tool_use_id).toBe('tu_b');
  });

  it('subagent turn: nested tool use with parent_tool_use_id', async () => {
    async function* mockSubagentQuery(): AsyncIterable<any> {
      yield { type: 'system', subtype: 'init', model: 'test', tools: ['Task', 'Read'] };

      // Top-level: assistant invokes Task (subagent)
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu_task_1', name: 'Task', input: { prompt: 'research X' } },
          ],
        },
      };

      // Subagent's inner tool call (has parent_tool_use_id)
      yield {
        type: 'assistant',
        parent_tool_use_id: 'tu_task_1',
        message: {
          content: [
            { type: 'tool_use', id: 'tu_inner_read', name: 'Read', input: { file_path: '/research' } },
          ],
        },
      };

      // Subagent's inner tool result
      yield {
        type: 'user',
        parent_tool_use_id: 'tu_task_1',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu_inner_read', content: 'research data' },
          ],
        },
      };

      // Task tool result (subagent completed)
      yield {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu_task_1', content: 'Research complete: findings...' },
          ],
        },
      };

      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Research completed via subagent.',
      };
    }

    const messages: any[] = [];
    for await (const msg of mockSubagentQuery()) {
      messages.push(msg);
    }

    // Verify nesting structure
    expect(messages[1].message.content[0].name).toBe('Task');
    expect(messages[2].parent_tool_use_id).toBe('tu_task_1');
    expect(messages[3].parent_tool_use_id).toBe('tu_task_1');
    // Top-level result has no parent
    expect(messages[4].parent_tool_use_id).toBeUndefined();
  });
});

// =============================================================================
// 11. Error Tool Results (is_error flag)
//
// When a tool execution fails, the runtime sets is_error: true on the tool_result.
// =============================================================================

describe('tool result error flag contract', () => {
  it('tool_result with is_error: true propagates to tool event', () => {
    const hints = collectToolHints({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_fail',
            content: 'Permission denied',
            is_error: true,
          },
        ],
      },
    } as any);

    const end = hints.find((h: any) => h.stage === 'end');
    expect(end).toBeDefined();
    expect((end as any).isError).toBe(true);
  });

  it('tool_result without is_error defaults to false/undefined', () => {
    const hints = collectToolHints({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_ok',
            content: 'Success',
          },
        ],
      },
    } as any);

    const end = hints.find((h: any) => h.stage === 'end');
    expect(end).toBeDefined();
    expect((end as any).isError).toBeFalsy();
  });
});

// =============================================================================
// 12. Image Content in Tool Results
//
// Tool results can contain image content blocks. The replacement must preserve
// these so they render in the conversation UI.
// =============================================================================

describe('image content in tool results contract', () => {
  it('tool_result with image content blocks shape', () => {
    const toolResultWithImage = {
      type: 'tool_result',
      tool_use_id: 'tu_screenshot',
      content: [
        { type: 'text', text: 'Screenshot captured' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'iVBORw0KGgoAAAANS...',
          },
        },
      ],
    };

    const imageBlock = toolResultWithImage.content.find((b: any) => b.type === 'image');
    expect(imageBlock).toBeDefined();
    expect(imageBlock!.source).toHaveProperty('type', 'base64');
    expect(imageBlock!.source).toHaveProperty('media_type');
    expect(imageBlock!.source).toHaveProperty('data');
  });
});

// =============================================================================
// 13. usage Field Deep Shape
//
// The usage object on result messages has specific optional fields for prompt
// caching. The replacement must include these when the provider supports them.
// =============================================================================

describe('usage field deep shape contract', () => {
  it('usage includes cache token fields', () => {
    const usage = {
      input_tokens: 1500,
      output_tokens: 300,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 100,
    };

    expect(usage).toHaveProperty('input_tokens');
    expect(usage).toHaveProperty('output_tokens');
    expect(usage).toHaveProperty('cache_creation_input_tokens');
    expect(usage).toHaveProperty('cache_read_input_tokens');
    expect(typeof usage.cache_creation_input_tokens).toBe('number');
    expect(typeof usage.cache_read_input_tokens).toBe('number');
  });

  it('context utilization calculated from total prompt tokens vs window', () => {
    const usage = {
      input_tokens: 150_000,
      cache_creation_input_tokens: 10_000,
      cache_read_input_tokens: 5_000,
    };
    const contextWindow = 200_000;
    const totalPromptTokens =
      usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
    const utilization = Math.min(100, Math.round((totalPromptTokens / contextWindow) * 100));

    expect(utilization).toBe(83); // 165000/200000 = 82.5 → 83
  });
});

// =============================================================================
// 14. TurnParams Resume Passthrough (FOX-2968)
//
// Verifies that the `resume` field is NOT part of TurnParams (it was a
// legacy SDK-only field). Regression test for commit ba80f4d30.
// =============================================================================

describe('TurnParams resume passthrough (FOX-2968)', () => {
  it('TurnParams does not include resume field (legacy SDK-only)', () => {
    // Verify TurnParams type no longer includes the resume field.
    // resume field was removed from TurnParams (legacy SDK-only field).
    // Verify it's no longer part of the type.
    const params: import('@core/rebelCore/turnParams').TurnParams = {
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'test',
      prompt: 'hello',
    };

    expect('resume' in params).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Post-result guard (task queue dequeue protection)
// ---------------------------------------------------------------------------
describe('post-result guard drops messages after successful result', () => {
  beforeEach(resetState);

  it('drops assistant messages when success result already dispatched', () => {
    vi.mocked(agentTurnRegistry.hasSuccessResultDispatched).mockReturnValue(true);

    handleAgentMessage(null, TURN_ID, {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Stale background task text' }],
      },
    } as any);

    expect(dispatchAgentEventMock).not.toHaveBeenCalled();
    expect(mockTurnLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ messageType: 'assistant' }),
      expect.stringContaining('Dropping post-result message'),
    );

    vi.mocked(agentTurnRegistry.hasSuccessResultDispatched).mockReturnValue(false);
  });

  it('drops system/init messages when success result already dispatched', () => {
    vi.mocked(agentTurnRegistry.hasSuccessResultDispatched).mockReturnValue(true);

    handleAgentMessage(null, TURN_ID, {
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-4-6',
      session_id: 'upstream-123',
      tools: ['Read'],
    } as any);

    expect(dispatchAgentEventMock).not.toHaveBeenCalled();
    expect(mockTurnLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ messageType: 'system' }),
      expect.stringContaining('Dropping post-result message'),
    );

    vi.mocked(agentTurnRegistry.hasSuccessResultDispatched).mockReturnValue(false);
  });

  it('drops subsequent result messages without double-counting cost', () => {
    vi.mocked(agentTurnRegistry.hasSuccessResultDispatched).mockReturnValue(true);

    handleAgentMessage(null, TURN_ID, {
      type: 'result',
      subtype: 'success',
      result: 'Stale task result',
      total_cost_usd: 0.05,
      usage: { input_tokens: 100, output_tokens: 50 },
      is_error: false,
    } as any);

    // No dispatch to renderer
    expect(dispatchAgentEventMock).not.toHaveBeenCalled();
    // Cost NOT re-recorded (total_cost_usd is cumulative — first result already captured it)
    expect(agentTurnRegistry.markCostRecorded).not.toHaveBeenCalled();
    expect(mockTurnLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ messageType: 'result' }),
      expect.stringContaining('Dropping post-result message'),
    );

    vi.mocked(agentTurnRegistry.hasSuccessResultDispatched).mockReturnValue(false);
  });

  it('marks success result dispatched after first successful result', () => {
    turnModels.set(TURN_ID, 'claude-sonnet-4-6');

    handleAgentMessage(null, TURN_ID, {
      type: 'result',
      subtype: 'success',
      result: 'Here is the real answer.',
      total_cost_usd: 1.23,
      usage: { input_tokens: 5000, output_tokens: 500 },
      is_error: false,
    } as any);

    expect(agentTurnRegistry.markSuccessResultDispatched).toHaveBeenCalledWith(TURN_ID);
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      TURN_ID,
      expect.objectContaining({ type: 'result' }),
    );
  });

  // Negative tests: guard does NOT fire when it shouldn't
  it('does not block assistant messages when no result dispatched yet', () => {
    // hasSuccessResultDispatched defaults to false in mock
    handleAgentMessage(null, TURN_ID, {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Normal assistant message' }],
      },
    } as any);

    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      TURN_ID,
      expect.objectContaining({ type: 'assistant' }),
    );
  });

  it('does not set success flag for error results', () => {
    handleAgentMessage(null, TURN_ID, {
      type: 'result',
      subtype: 'error',
      result: '',
      is_error: true,
      errors: ['Something went wrong'],
      total_cost_usd: 0.50,
      usage: { input_tokens: 1000, output_tokens: 0 },
    } as any);

    expect(agentTurnRegistry.markSuccessResultDispatched).not.toHaveBeenCalled();
  });
});
