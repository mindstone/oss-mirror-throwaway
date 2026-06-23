import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';

const {
  appendCostEntryMock,
  conversationScopeResolverMock,
  dispatchAgentEventMock,
  dispatchAgentErrorEventMock,
  getIncrementalSessionStoreMock,
  incrementalSessionStoreMock,
  mockTurnLogger,
  registryMocks,
} = vi.hoisted(() => {
  const appendCostEntryMock = vi.fn((_entry: Record<string, unknown>) => ({ costEntryId: 'test-cost-entry-id-message' }));
  const dispatchAgentEventMock = vi.fn();
  const dispatchAgentErrorEventMock = vi.fn();
  const incrementalSessionStoreMock = {
    getSession: vi.fn<(sessionId: string) => Promise<{ externalContext?: { kind?: string } } | null>>(
      async () => null,
    ),
  };
  const getIncrementalSessionStoreMock = vi.fn(() => incrementalSessionStoreMock);
  const mockTurnLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  };

  return {
    appendCostEntryMock,
    conversationScopeResolverMock: {
      getBinding: vi.fn<
        (conversationId: string) => { conversationId: string; context: { kind: string } } | undefined
      >(() => undefined),
    },
    dispatchAgentEventMock,
    dispatchAgentErrorEventMock,
    getIncrementalSessionStoreMock,
    incrementalSessionStoreMock,
    mockTurnLogger,
    registryMocks: {
      getTurnLogger: vi.fn(() => mockTurnLogger),
      getRendererSession: vi.fn<(turnId: string) => string | null | undefined>(() => null),
      setTurnModel: vi.fn(),
      getTurnModel: vi.fn(() => 'claude-sonnet-4-6'),
      getTurnActiveProvider: vi.fn(() => undefined),
      setTurnActiveProvider: vi.fn(),
      hasContextOverflowDispatched: vi.fn(() => false),
      markContextOverflowDispatched: vi.fn(),
      // Stage 4 (260421): runtime-result error dispatch dedup primitive.
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
      getTurnPlanningModel: vi.fn<() => string | undefined>(() => undefined),
      getTurnFastModel: vi.fn<() => string | undefined>(() => undefined),
      getTurnFallbacks: vi.fn(() => []),
      getContextAccumulator: vi.fn<
        (turnId: string) => { eventsByTurn: Record<string, unknown[]> } | null
      >(() => null),
      deleteContextAccumulator: vi.fn(),
      releaseActiveSession: vi.fn(),
      getTurnCategory: vi.fn(() => 'conversation'),
      getTurnPrivateMode: vi.fn(() => false),
      getTurnInputSource: vi.fn(() => 'text'),
      hasCostRecorded: vi.fn(() => false),
    hasUserQuestionPending: vi.fn(() => false),
      hasOutputCapRetryAttempted: vi.fn(() => false),
      markOutputCapRetryAttempted: vi.fn(),
      clearOutputCapRetryAttempted: vi.fn(),
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

vi.mock('@core/services/externalConversation/conversationScopeResolver', () => ({
  conversationScopeResolver: conversationScopeResolverMock,
}));

vi.mock('@core/services/incrementalSessionStore', () => ({
  getIncrementalSessionStore: getIncrementalSessionStoreMock,
}));

vi.mock('../agentEventDispatcher', () => ({
  dispatchAgentEvent: dispatchAgentEventMock,
  dispatchAgentErrorEvent: dispatchAgentErrorEventMock,
}));

vi.mock('../costLedgerService', () => ({
  appendCostEntry: appendCostEntryMock,
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
  normalizeModel: vi.fn((m: string) => m),
}));

vi.mock('@shared/data/modelProviderPresets', () => ({
  getKnownContextWindowForModel: vi.fn(() => null),
  PROVIDER_PRESETS: { openai: { models: [] }, google: { models: [] } },
}));

vi.mock('@shared/utils/toolNameValidation', () => ({
  isToolNameLengthError: vi.fn(() => false),
  truncateToolName: vi.fn((name: string) => name),
}));

import {
  __resetSlackReplyInvariantStateForTests,
  classifyLargeInputTurnTool,
  handleAgentMessage,
  maybeLogLargeInputTurnBreakdown,
} from '../agentMessageHandler';

beforeEach(() => {
  vi.clearAllMocks();
  __resetSlackReplyInvariantStateForTests();
  conversationScopeResolverMock.getBinding.mockReturnValue(undefined);
  incrementalSessionStoreMock.getSession.mockResolvedValue(null);
  registryMocks.getTurnAuthMethod.mockReturnValue('api-key');
  registryMocks.getTurnPlanningModel.mockReturnValue(undefined);
  initTestPlatformConfig();
});

function makeSuccessfulResultMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Done.',
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 10,
      output_tokens: 5,
    },
    total_cost_usd: 0.001,
    ...overrides,
  } as any;
}

function getSlackReplyInvariantPayloads(level: 'info' | 'warn' | 'error'): Array<Record<string, unknown>> {
  return ((mockTurnLogger[level] as any).mock.calls as unknown[][])
    .map((call) => call[0])
    .filter((payload): payload is Record<string, unknown> =>
      typeof payload === 'object' &&
      payload !== null &&
      (payload as Record<string, unknown>).event === 'slack_reply_invariant',
    );
}

describe('handleAgentMessage model usage forwarding', () => {
  it('forwards normalized single-model usage to result events and records compact ledger model usage', () => {
    handleAgentMessage(null, 'turn-1', {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done.',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
      total_cost_usd: 0.001,
      modelUsage: {
        'claude-sonnet-4-6': {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
      },
    } as any);

    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'turn-1',
      expect.objectContaining({
        type: 'result',
        model: 'claude-sonnet-4-6',
        modelUsage: {
          'claude-sonnet-4-6': {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 10,
            cacheCreationTokens: 5,
            authMethod: 'api-key',
            providersSeen: [],
          },
        },
      }),
    );

    const [entry] = appendCostEntryMock.mock.calls[0];
    expect(entry).toMatchObject({
      m: 'claude-sonnet-4-6',
      inTok: 100,
      outTok: 50,
      cacheReadTok: 10,
      cacheCreateTok: 5,
    });
    expect(entry.mu).toEqual({
      'claude-sonnet-4-6': {
        in: 100,
        out: 50,
        cacheR: 10,
        cacheC: 5,
      },
    });
  });

  it('preserves the context accumulator after a user-question pause result', () => {
    registryMocks.hasUserQuestionPending.mockReturnValue(true);

    handleAgentMessage(null, 'turn-question-pause', {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 100,
        output_tokens: 4,
      },
      total_cost_usd: 0.001,
    } as any);

    expect(registryMocks.deleteContextAccumulator).not.toHaveBeenCalledWith('turn-question-pause');
    expect(registryMocks.releaseActiveSession).toHaveBeenCalledWith('turn-question-pause');
  });

  it('records compact multi-model usage in the ledger and full normalized model usage in events', () => {
    handleAgentMessage(null, 'turn-1', {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done.',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 150,
        output_tokens: 49,
      },
      total_cost_usd: 0.005,
      modelUsage: {
        'claude-sonnet-4-6': {
          inputTokens: 120,
          outputTokens: 40,
          cacheReadInputTokens: 11,
          costUSD: 0.004,
        },
        'claude-haiku-4-5': {
          input_tokens: 30,
          output_tokens: 9,
          cache_creation_input_tokens: 5,
        },
      },
    } as any);

    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'turn-1',
      expect.objectContaining({
        type: 'result',
        model: 'claude-sonnet-4-6 + claude-haiku-4-5',
        modelUsage: {
          'claude-sonnet-4-6': {
            inputTokens: 120,
            outputTokens: 40,
            cacheReadTokens: 11,
            costUsd: 0.004,
            authMethod: 'api-key',
            providersSeen: [],
          },
          'claude-haiku-4-5': {
            inputTokens: 30,
            outputTokens: 9,
            cacheCreationTokens: 5,
            authMethod: 'api-key',
            providersSeen: [],
          },
        },
      }),
    );

    const [entry] = appendCostEntryMock.mock.calls[0];
    expect(entry).toMatchObject({
      m: 'claude-sonnet-4-6 + claude-haiku-4-5',
      inTok: 150,
      outTok: 49,
      cacheReadTok: 11,
      cacheCreateTok: 5,
      mu: {
        'claude-sonnet-4-6': {
          in: 120,
          out: 40,
          cacheR: 11,
          cost: 0.004,
        },
        'claude-haiku-4-5': {
          in: 30,
          out: 9,
          cacheC: 5,
        },
      },
    });
  });

  it('forwards openRouterProvider, providersSeen, and fulfillmentProvider in result model usage', () => {
    handleAgentMessage(null, 'turn-1', {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done.',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 88,
        output_tokens: 21,
      },
      total_cost_usd: 0.003,
      modelUsage: {
        'z-ai/glm-5.1': {
          inputTokens: 88,
          outputTokens: 21,
          openRouterProvider: 'Fireworks',
          providersSeen: ['Fireworks', 'DeepInfra'],
          fulfillmentProvider: {
            name: 'Fireworks',
            transport: 'openrouter',
            source: 'or-body',
            serverHints: {
              'cf-ray': 'abc123',
            },
          },
        },
      },
    } as any);

    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'turn-1',
      expect.objectContaining({
        type: 'result',
        modelUsage: {
          'z-ai/glm-5.1': expect.objectContaining({
            inputTokens: 88,
            outputTokens: 21,
            authMethod: 'api-key',
            openRouterProvider: 'Fireworks',
            providersSeen: ['Fireworks', 'DeepInfra'],
            fulfillmentProvider: {
              name: 'Fireworks',
              transport: 'openrouter',
              source: 'or-body',
              serverHints: {
                'cf-ray': 'abc123',
              },
            },
          }),
        },
      }),
    );
  });

  it('emits roles[] with planner observed + worker/BTS configured-not-used on a direct-answer turn (the Turn Usage tooltip bug)', () => {
    // Plan-mode direct answer: the planner (Opus) ran and produced the only modelUsage entry;
    // the configured worker (DeepSeek Pro) and Background model (DeepSeek Flash) never ran.
    // Crucially the registry planning model and the served modelUsage key are DIFFERENT spellings
    // of the same Opus model — the original bug. They must dedup to ONE observed planner row.
    registryMocks.getTurnPlanningModel.mockReturnValue('anthropic/claude-opus-4-8');
    registryMocks.getTurnModel.mockReturnValue('deepseek/deepseek-v4-pro');
    registryMocks.getTurnFastModel.mockReturnValue('deepseek/deepseek-v4-flash');

    handleAgentMessage(null, 'turn-1', {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Hey Greg!',
      stop_reason: 'end_turn',
      usage: { input_tokens: 2, output_tokens: 151 },
      total_cost_usd: 0.01,
      modelUsage: {
        'anthropic/claude-4.8-opus-20260528': {
          inputTokens: 2,
          outputTokens: 151,
          costUSD: 0.01,
          authMethod: 'openrouter',
          providersSeen: ['anthropic'],
        },
      },
    } as any);

    const resultCall = dispatchAgentEventMock.mock.calls.find((c) => (c[2] as any)?.type === 'result');
    const roles = (resultCall?.[2] as any)?.roles as Array<Record<string, unknown>>;
    expect(roles).toBeDefined();

    // Planner observed — deduped against the served-snapshot spelling (the original bug fix):
    expect(roles.find((r) => r.role === 'thinking')).toMatchObject({
      status: 'observed',
      canonicalModelId: 'claude-opus-4-8',
      modelUsageKey: 'anthropic/claude-4.8-opus-20260528',
    });
    // Worker configured but never ran this turn:
    expect(roles.find((r) => r.role === 'working')).toMatchObject({
      status: 'configured_not_used',
      canonicalModelId: 'deepseek-v4-pro',
    });
    // Background/BTS surfaced for availability even though it didn't run:
    expect(roles.find((r) => r.role === 'fast')).toMatchObject({
      status: 'configured_not_used',
      canonicalModelId: 'deepseek-v4-flash',
    });
    // Exactly ONE observed row — no phantom second Opus row (the diagnosed symptom):
    expect(roles.filter((r) => r.status === 'observed')).toHaveLength(1);

    // Restore registry mock defaults — vi.clearAllMocks() (beforeEach) clears call history but NOT
    // mockReturnValue implementations, so an unrestored override here would leak into later tests.
    registryMocks.getTurnModel.mockReturnValue('claude-sonnet-4-6');
    registryMocks.getTurnPlanningModel.mockReturnValue(undefined);
    registryMocks.getTurnFastModel.mockReturnValue(undefined);
  });

  it('attributes planning model usage to API key auth on Codex subscription turns', () => {
    registryMocks.getTurnAuthMethod.mockReturnValue('codex-subscription');
    registryMocks.getTurnPlanningModel.mockReturnValue('claude-opus-4-7');

    handleAgentMessage(null, 'turn-1', {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done.',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 150,
        output_tokens: 49,
      },
      total_cost_usd: 0.005,
      modelUsage: {
        'claude-opus-4-7': {
          inputTokens: 120,
          outputTokens: 40,
          costUSD: 0.004,
        },
        'gpt-5.5': {
          inputTokens: 30,
          outputTokens: 9,
          costUSD: 0.001,
        },
      },
    } as any);

    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'turn-1',
      expect.objectContaining({
        type: 'result',
        modelUsage: {
          'claude-opus-4-7': {
            inputTokens: 120,
            outputTokens: 40,
            costUsd: 0.004,
            authMethod: 'api-key',
            providersSeen: [],
          },
          'gpt-5.5': {
            inputTokens: 30,
            outputTokens: 9,
            costUsd: 0.001,
            authMethod: 'codex-subscription',
            providersSeen: [],
          },
        },
      }),
    );
  });

  it('records compact multi-model usage for billed error results', () => {
    handleAgentMessage(null, 'turn-1', {
      type: 'result',
      subtype: 'error',
      is_error: true,
      errors: ['Something went wrong'],
      total_cost_usd: 0.01,
      modelUsage: {
        'claude-sonnet-4-6': {
          inputTokens: 80,
          outputTokens: 20,
        },
        'claude-haiku-4-5': {
          input_tokens: 10,
          output_tokens: 5,
          costUSD: 0.001,
        },
      },
    } as any);

    const [entry] = appendCostEntryMock.mock.calls[0];
    expect(entry).toMatchObject({
      cost: 0.01,
      m: 'claude-sonnet-4-6 + claude-haiku-4-5',
      inTok: 90,
      outTok: 25,
      mu: {
        'claude-sonnet-4-6': { in: 80, out: 20 },
        'claude-haiku-4-5': { in: 10, out: 5, cost: 0.001 },
      },
    });
  });

  it('routes runtime error results through dispatchAgentErrorEvent with raw text + providerOverride', () => {
    // 260421 Stage 3: the runtime-result error-dispatch path no longer passes
    // a pre-computed `humanizedOverride`; instead it forwards the raw text and
    // a `providerOverride` derived from the turn's selected model so the
    // dispatcher's canonical `deriveErrorKind` + `humanizeAgentError` chain
    // produces the correct classified copy. The default turn model here is
    // `claude-sonnet-4-6` → maps to "Anthropic".
    handleAgentMessage(null, 'turn-1', {
      type: 'result',
      subtype: 'error',
      is_error: true,
      errors: ['invalid x-api-key provided'],
    } as any);

    expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(
      null,
      'turn-1',
      'invalid x-api-key provided',
      { providerOverride: 'Anthropic' },
    );

    const [, , , opts] = dispatchAgentErrorEventMock.mock.calls[0];
    expect(opts).not.toHaveProperty('humanizedOverride');
  });

  it('falls back to aggregate-only behavior when model usage normalization fails', () => {
    expect(() => handleAgentMessage(null, 'turn-1', {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Recovered.',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 77,
        output_tokens: 22,
        cache_read_input_tokens: 7,
        cache_creation_input_tokens: 3,
      },
      total_cost_usd: 0.01,
      modelUsage: {
        'claude-sonnet-4-6': null,
      },
    } as any)).not.toThrow();

    const [entry] = appendCostEntryMock.mock.calls[0];
    expect(entry).toMatchObject({
      cost: 0.01,
      inTok: 77,
      outTok: 22,
      cacheReadTok: 7,
      cacheCreateTok: 3,
    });
    expect(entry.mu).toBeUndefined();

    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'turn-1',
      expect.objectContaining({
        type: 'result',
        modelUsage: undefined,
      }),
    );
    expect(mockTurnLogger.warn).toHaveBeenCalled();
  });

  it('produces no mu when modelUsage is an empty object', () => {
    handleAgentMessage(null, 'turn-1', {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done.',
      stop_reason: 'end_turn',
      usage: { input_tokens: 50, output_tokens: 20 },
      total_cost_usd: 0.001,
      modelUsage: {},
    } as any);

    const [entry] = appendCostEntryMock.mock.calls[0];
    expect(entry.mu).toBeUndefined();
  });

  it('logs fallback slack reply invariant when slack-thread turn ends without reply_to_slack_thread', () => {
    registryMocks.getRendererSession.mockReturnValue('session-slack');
    conversationScopeResolverMock.getBinding.mockReturnValue({
      conversationId: 'session-slack',
      context: { kind: 'slack-thread' },
    });
    registryMocks.getContextAccumulator.mockImplementation((turnId: string) => ({
      eventsByTurn: { [turnId]: [] },
    }));

    handleAgentMessage(null, 'turn-1', makeSuccessfulResultMessage());

    expect(getSlackReplyInvariantPayloads('error')).toContainEqual(
      expect.objectContaining({
        sessionId: 'session-slack',
        turnId: 'turn-1',
        outcome: 'logged_only',
        toolCallCount: 0,
      }),
    );
  });

  it('falls back to persisted session externalContext when binding is missing', async () => {
    registryMocks.getRendererSession.mockReturnValue('session-slack');
    conversationScopeResolverMock.getBinding.mockReturnValue(undefined);
    incrementalSessionStoreMock.getSession.mockResolvedValue({
      externalContext: { kind: 'slack-thread' },
    });
    registryMocks.getContextAccumulator.mockImplementation((turnId: string) => ({
      eventsByTurn: { [turnId]: [] },
    }));

    handleAgentMessage(null, 'turn-1b', makeSuccessfulResultMessage());
    expect(incrementalSessionStoreMock.getSession).toHaveBeenCalledWith('session-slack');
    await vi.waitFor(() => {
      expect(getSlackReplyInvariantPayloads('error')).toContainEqual(
        expect.objectContaining({
          sessionId: 'session-slack',
          turnId: 'turn-1b',
          outcome: 'logged_only',
          toolCallCount: 0,
        }),
      );
    });
  });

  it('logs satisfied slack reply invariant when reply_to_slack_thread succeeded', () => {
    registryMocks.getRendererSession.mockReturnValue('session-slack');
    conversationScopeResolverMock.getBinding.mockReturnValue({
      conversationId: 'session-slack',
      context: { kind: 'slack-thread' },
    });
    registryMocks.getContextAccumulator.mockImplementation((turnId: string) => ({
      eventsByTurn: {
        [turnId]: [
          {
            type: 'tool',
            stage: 'end',
            toolName: 'reply_to_slack_thread',
            isError: false,
            timestamp: Date.now(),
          },
        ],
      },
    }));

    handleAgentMessage(null, 'turn-2', makeSuccessfulResultMessage());

    expect(getSlackReplyInvariantPayloads('info')).toContainEqual(
      expect.objectContaining({
        sessionId: 'session-slack',
        turnId: 'turn-2',
        outcome: 'satisfied',
        toolCallCount: 1,
      }),
    );
    expect(getSlackReplyInvariantPayloads('error')).toHaveLength(0);
  });

  it('does not emit slack reply invariant logs for non-slack sessions', () => {
    registryMocks.getRendererSession.mockReturnValue('session-browser');
    conversationScopeResolverMock.getBinding.mockReturnValue({
      conversationId: 'session-browser',
      context: { kind: 'browser-tab' },
    });
    registryMocks.getContextAccumulator.mockImplementation((turnId: string) => ({
      eventsByTurn: { [turnId]: [] },
    }));

    handleAgentMessage(null, 'turn-3', makeSuccessfulResultMessage());

    expect(getSlackReplyInvariantPayloads('info')).toHaveLength(0);
    expect(getSlackReplyInvariantPayloads('warn')).toHaveLength(0);
    expect(getSlackReplyInvariantPayloads('error')).toHaveLength(0);
  });

  it('emits continuation_skipped_already_retried after one prior slack invariant trigger', () => {
    registryMocks.getRendererSession.mockReturnValue('session-slack');
    conversationScopeResolverMock.getBinding.mockReturnValue({
      conversationId: 'session-slack',
      context: { kind: 'slack-thread' },
    });
    registryMocks.getContextAccumulator.mockImplementation((turnId: string) => ({
      eventsByTurn: { [turnId]: [] },
    }));

    handleAgentMessage(null, 'turn-4a', makeSuccessfulResultMessage());
    handleAgentMessage(null, 'turn-4b', makeSuccessfulResultMessage());

    expect(getSlackReplyInvariantPayloads('error')).toContainEqual(
      expect.objectContaining({
        turnId: 'turn-4a',
        outcome: 'logged_only',
      }),
    );
    expect(getSlackReplyInvariantPayloads('warn')).toContainEqual(
      expect.objectContaining({
        turnId: 'turn-4b',
        outcome: 'continuation_skipped_already_retried',
      }),
    );
  });
});

describe('large_input_turn_breakdown', () => {
  const originalDiagnosisLog = process.env.REBEL_BASH_MATERIALIZATION_DIAGNOSIS_LOG;

  beforeEach(() => {
    delete process.env.REBEL_BASH_MATERIALIZATION_DIAGNOSIS_LOG;
  });

  afterEach(() => {
    if (originalDiagnosisLog == null) {
      delete process.env.REBEL_BASH_MATERIALIZATION_DIAGNOSIS_LOG;
    } else {
      process.env.REBEL_BASH_MATERIALIZATION_DIAGNOSIS_LOG = originalDiagnosisLog;
    }
  });

  it('does not emit when the diagnosis env var is not set', () => {
    const logger = { info: vi.fn() };

    const emitted = maybeLogLargeInputTurnBreakdown({
      logger,
      turnId: 'turn-1',
      sessionId: 'session-1',
      breakdown: {
        builtinBashChars: 10,
        builtinReadChars: 20,
        builtinGrepChars: 30,
        mcpToolChars: 40,
      },
      totalInputTokens: 50_001,
      model: 'model-a',
    });

    expect(emitted).toBe(false);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('emits with classified tool totals when env is set and tokens exceed 50K', () => {
    process.env.REBEL_BASH_MATERIALIZATION_DIAGNOSIS_LOG = '1';
    const logger = { info: vi.fn() };
    // Both `Grep` and `SearchFiles` are built-in search tools and should aggregate
    // into `builtinGrepChars`; only true MCP traffic counts as `mcpToolChars`.
    const toolOutputs = [
      { toolName: 'Bash', chars: 100 },
      { toolName: 'Read', chars: 200 },
      { toolName: 'Grep', chars: 300 },
      { toolName: 'SearchFiles', chars: 50 },
      { toolName: 'mcp__google_drive_search', chars: 400 },
      { toolName: 'GoogleWorkspace/search', chars: 500 },
    ];
    const breakdown = {
      builtinBashChars: 0,
      builtinReadChars: 0,
      builtinGrepChars: 0,
      mcpToolChars: 0,
    };

    for (const { toolName, chars } of toolOutputs) {
      breakdown[classifyLargeInputTurnTool(toolName)] += chars;
    }

    const emitted = maybeLogLargeInputTurnBreakdown({
      logger,
      turnId: 'turn-1',
      sessionId: 'session-1',
      breakdown,
      totalInputTokens: 50_001,
      model: 'model-a',
    });

    expect(emitted).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      {
        event: 'large_input_turn_breakdown',
        turnId: 'turn-1',
        sessionId: 'session-1',
        builtinBashChars: 100,
        builtinReadChars: 200,
        builtinGrepChars: 350,
        mcpToolChars: 900,
        totalInputTokens: 50_001,
        model: 'model-a',
      },
      'Large-input turn tool-output breakdown',
    );
  });

  it('classifies SearchFiles into builtinGrepChars (built-in search bucket)', () => {
    expect(classifyLargeInputTurnTool('SearchFiles')).toBe('builtinGrepChars');
  });
});
