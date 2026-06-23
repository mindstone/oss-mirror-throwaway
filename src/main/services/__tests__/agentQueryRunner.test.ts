import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted mock refs — create BEFORE module-level vi.mock() calls
// ---------------------------------------------------------------------------
const {
  queryMock,
  handleAgentMessageMock,
  buildCompactModelUsageMock,
  appendCostEntryMock,
  calculateCostMock,
  getErrorKindMock,
  mockTurnLogger,
  registryMocks,
} = vi.hoisted(() => {
  const mockTurnLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  return {
    queryMock: vi.fn(),
    handleAgentMessageMock: vi.fn(),
    buildCompactModelUsageMock: vi.fn(() => undefined) as ReturnType<typeof vi.fn>,
    appendCostEntryMock: vi.fn((_entry: unknown) => ({ costEntryId: 'test-cost-entry-id-agent-query' })),
    calculateCostMock: vi.fn(),
    getErrorKindMock: vi.fn(() => 'unknown' as string),
    mockTurnLogger,
    registryMocks: {
      setTurnCloseCallback: vi.fn(),
      getRendererSession: vi.fn(() => 'session-1'),
      getTurnModel: vi.fn(() => 'claude-sonnet-4-5'),
      getTurnActiveProvider: vi.fn(() => undefined),
      setTurnActiveProvider: vi.fn(),
      getTurnCategory: vi.fn(() => 'conversation' as string | undefined),
      getTurnAuthMethod: vi.fn(() => 'oauth-token' as string | undefined),
      hasCostRecorded: vi.fn(() => false),
    hasUserQuestionPending: vi.fn(() => false),
      hasOutputCapRetryAttempted: vi.fn(() => false),
      markOutputCapRetryAttempted: vi.fn(),
      clearOutputCapRetryAttempted: vi.fn(),
      hasSuccessResultDispatched: vi.fn(() => false),
    },
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

/** Helper: create an async generator from an array of messages. */
function createMockIterator(messages: unknown[]) {
  async function* gen() {
    for (const msg of messages) {
      yield msg;
    }
  }
  const iter = gen() as AsyncGenerator<unknown, void, undefined> & { close: ReturnType<typeof vi.fn> };
  iter.close = vi.fn();
  return iter;
}

vi.mock('@core/rebelCore/queryRouter', () => ({
  queryWithRuntime: queryMock,
}));

vi.mock('../agentMessageHandler', () => ({
  handleAgentMessage: handleAgentMessageMock,
  buildCompactModelUsage: buildCompactModelUsageMock,
}));

vi.mock('../agentTurnRegistry', () => ({
  agentTurnRegistry: registryMocks,
}));

vi.mock('../costLedgerService', () => ({
  appendCostEntry: appendCostEntryMock,
}));

vi.mock('@shared/utils/pricingCalculator', () => ({
  calculateCostOrWarn: calculateCostMock,
}));

vi.mock('@shared/utils/agentErrorCatalog', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@shared/utils/agentErrorCatalog');
  return {
    ...actual,
    getErrorKind: getErrorKindMock,
  };
});

// ---------------------------------------------------------------------------
// Import SUT (after mocks)
// ---------------------------------------------------------------------------

import { runAgentQuery, type AgentQueryConfig } from '../agentQueryRunner';

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AgentQueryConfig> = {}): AgentQueryConfig {
  return {
    queryOptions: { model: 'claude-sonnet-4-5', env: {}, maxTurns: 1 } as unknown as AgentQueryConfig['queryOptions'],
    prompt: 'test prompt',
    abortController: new AbortController(),
    turnId: 'turn-1',
    win: null,
    turnLogger: mockTurnLogger as unknown as AgentQueryConfig['turnLogger'],
    rethrowKinds: new Set<string>(),
    onApiOutput: vi.fn(),
    label: 'test',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  registryMocks.getRendererSession.mockReturnValue('session-1');
  registryMocks.getTurnModel.mockReturnValue('claude-sonnet-4-5');
  registryMocks.getTurnCategory.mockReturnValue('conversation');
  registryMocks.getTurnAuthMethod.mockReturnValue('oauth-token');
  registryMocks.hasCostRecorded.mockReturnValue(false);
  calculateCostMock.mockReturnValue(0.015);
});

// ===========================================================================
// Normal flow (baseline)
// ===========================================================================

describe('runAgentQuery — normal flow', () => {
  it('passes messages through handleAgentMessage without abort', async () => {
    const messages = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
      { type: 'result', total_cost_usd: 0.05, subtype: 'success' },
    ];
    queryMock.mockReturnValue(createMockIterator(messages));

    const config = makeConfig();
    const result = await runAgentQuery(config);

    expect(result.abortedByUser).toBe(false);
    expect(handleAgentMessageMock).toHaveBeenCalledTimes(2);
    // appendCostEntry should NOT be called directly from the runner in normal flow
    expect(appendCostEntryMock).not.toHaveBeenCalled();
  });

  // F4 regression: onApiOutput is the single source of truth for "real API
  // output happened". Synthetic system:* messages must NOT trigger it,
  // otherwise retry guards in turnErrorRecovery.ts misfire and we duplicate
  // assistant output. See docs-private/postmortems/260427_outer_retry_guard_*.md.
  it('invokes onApiOutput only for real API-output messages (filters synthetic system:*)', async () => {
    const systemInit = { type: 'system', subtype: 'init', model: 'claude-sonnet-4-5' };
    const systemStatus = { type: 'system', subtype: 'status', message: 'thinking' };
    const assistantMsg = { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } };
    const userToolResult = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } };
    const resultMsg = { type: 'result', total_cost_usd: 0.01, subtype: 'success' };
    queryMock.mockReturnValue(createMockIterator([systemInit, systemStatus, assistantMsg, userToolResult, resultMsg]));

    const onApiOutput = vi.fn();
    const config = makeConfig({ onApiOutput });
    await runAgentQuery(config);

    // assistant + user(tool_result) + result = 3 API-output messages.
    // Both system:* messages must be filtered out.
    expect(onApiOutput).toHaveBeenCalledTimes(3);
    // Lock exact filtering contract: the 3 calls receive the 3 non-system
    // messages in order, and neither system:init nor system:status appears.
    expect(onApiOutput).toHaveBeenNthCalledWith(1, assistantMsg);
    expect(onApiOutput).toHaveBeenNthCalledWith(2, userToolResult);
    expect(onApiOutput).toHaveBeenNthCalledWith(3, resultMsg);
    expect(onApiOutput).not.toHaveBeenCalledWith(systemInit);
    expect(onApiOutput).not.toHaveBeenCalledWith(systemStatus);
  });
});

// ===========================================================================
// Part A: Late result on abort
// ===========================================================================

describe('runAgentQuery — late result cost recovery on abort', () => {
  it('extracts cost from late result message when aborted', async () => {
    const abortController = new AbortController();
    const messages = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Working...' }], usage: { input_tokens: 100, output_tokens: 50 } } },
      { type: 'result', total_cost_usd: 0.042, subtype: 'success' },
    ];

    // Abort on the result message — simulates abort signal arriving just as
    // the result is being yielded (the "late result" scenario).
    const onMessage = vi.fn((msg: unknown) => {
      if ((msg as { type: string }).type === 'result') {
        abortController.abort();
      }
    });

    queryMock.mockReturnValue(createMockIterator(messages));

    const config = makeConfig({ abortController, onMessage });
    const result = await runAgentQuery(config);

    expect(result.abortedByUser).toBe(true);
    // handleAgentMessage called for assistant (before abort), NOT for result
    expect(handleAgentMessageMock).toHaveBeenCalledTimes(1);
    // appendCostEntry called with exact cost from late result
    expect(appendCostEntryMock).toHaveBeenCalledTimes(1);
    expect(appendCostEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cost: 0.042,
        sid: 'session-1',
        tid: 'turn-1',
        cat: 'conversation',
        m: 'claude-sonnet-4-5',
        auth: 'oauth-token',
      }),
    );
    // Should NOT have est: true (exact cost from server)
    expect(appendCostEntryMock.mock.calls[0][0]).not.toHaveProperty('est');
  });

  it('includes per-model mu when buildCompactModelUsage returns data', async () => {
    const abortController = new AbortController();
    const mockMu = {
      'claude-sonnet-4-5': { in: 100, out: 50, cost: 0.02 },
      'claude-haiku-4-5': { in: 200, out: 100, cost: 0.022 },
    };
    buildCompactModelUsageMock.mockReturnValueOnce(mockMu);

    const messages = [
      { type: 'result', total_cost_usd: 0.042, subtype: 'success' },
    ];
    const onMessage = vi.fn(() => { abortController.abort(); });
    queryMock.mockReturnValue(createMockIterator(messages));

    const config = makeConfig({ abortController, onMessage });
    await runAgentQuery(config);

    expect(appendCostEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cost: 0.042,
        mu: mockMu,
      }),
    );
  });

  it('does NOT call handleAgentMessage for late result on abort', async () => {
    const abortController = new AbortController();
    abortController.abort(); // Pre-abort

    const messages = [
      { type: 'result', total_cost_usd: 0.05, subtype: 'success' },
    ];
    queryMock.mockReturnValue(createMockIterator(messages));

    const config = makeConfig({ abortController });
    await runAgentQuery(config);

    // handleAgentMessage should NEVER be called for the result
    expect(handleAgentMessageMock).not.toHaveBeenCalled();
    // But cost should be recorded
    expect(appendCostEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ cost: 0.05 }),
    );
  });

  it('uses cost_usd when total_cost_usd is absent', async () => {
    const abortController = new AbortController();
    abortController.abort();

    const messages = [
      { type: 'result', cost_usd: 0.033, subtype: 'success' },
    ];
    queryMock.mockReturnValue(createMockIterator(messages));

    const config = makeConfig({ abortController });
    await runAgentQuery(config);

    expect(appendCostEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ cost: 0.033 }),
    );
  });

  it('skips non-result messages on abort', async () => {
    const abortController = new AbortController();
    abortController.abort();

    const messages = [
      { type: 'assistant', message: { content: [], usage: { input_tokens: 100, output_tokens: 50 } } },
    ];
    queryMock.mockReturnValue(createMockIterator(messages));

    const config = makeConfig({ abortController });
    const result = await runAgentQuery(config);

    expect(result.abortedByUser).toBe(true);
    // handleAgentMessage not called (aborted)
    expect(handleAgentMessageMock).not.toHaveBeenCalled();
    // No exact cost entry (no result message), but estimation may fire in finally
    // if output tokens accumulated — but with pre-abort, the assistant message
    // usage IS accumulated before the abort check
    expect(appendCostEntryMock).toHaveBeenCalledTimes(1);
    expect(appendCostEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ est: true }),
    );
  });
});

// ===========================================================================
// Part B: Usage accumulation
// ===========================================================================

describe('runAgentQuery — usage accumulation', () => {
  it('sums tokens from multiple assistant messages', async () => {
    const abortController = new AbortController();

    const messages = [
      { type: 'assistant', message: { content: [], usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 } } },
      { type: 'assistant', message: { content: [], usage: { input_tokens: 200, output_tokens: 80, cache_creation_input_tokens: 20, cache_read_input_tokens: 15 } } },
    ];

    // Abort after processing messages
    let msgCount = 0;
    const onMessage = vi.fn(() => {
      msgCount++;
      if (msgCount === 2) abortController.abort();
    });

    queryMock.mockReturnValue(createMockIterator(messages));

    const config = makeConfig({ abortController, onMessage });
    await runAgentQuery(config);

    // Estimation should use accumulated totals
    expect(calculateCostMock).toHaveBeenCalledWith(
      'claude-sonnet-4-5',
      300,  // 100 + 200
      130,  // 50 + 80
      expect.anything(), // turnLogger
      'agent-query',
      30,   // 10 + 20
      20,   // 5 + 15
    );
    expect(appendCostEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        est: true,
        inTok: 300,
        outTok: 130,
        cacheCreateTok: 30,
        cacheReadTok: 20,
      }),
    );
  });

  it('handles assistant messages with missing usage gracefully', async () => {
    const abortController = new AbortController();

    const messages = [
      { type: 'assistant', message: { content: [] } }, // no usage
      { type: 'assistant', message: { content: [], usage: { input_tokens: 100, output_tokens: 50 } } },
    ];

    let msgCount = 0;
    const onMessage = vi.fn(() => {
      msgCount++;
      if (msgCount === 2) abortController.abort();
    });

    queryMock.mockReturnValue(createMockIterator(messages));
    const config = makeConfig({ abortController, onMessage });
    await runAgentQuery(config);

    // Should only have tokens from second message
    expect(calculateCostMock).toHaveBeenCalledWith(
      'claude-sonnet-4-5',
      100,
      50,
      expect.anything(), // turnLogger
      'agent-query',
      undefined, // 0 → falsy → undefined
      undefined,
    );
  });
});

// ===========================================================================
// Part C: Estimation on abort
// ===========================================================================

describe('runAgentQuery — estimation on abort', () => {
  it('estimates cost when aborted with accumulated tokens and no result', async () => {
    const abortController = new AbortController();

    const messages = [
      { type: 'assistant', message: { content: [], usage: { input_tokens: 500, output_tokens: 200 } } },
    ];

    const onMessage = vi.fn(() => abortController.abort());
    queryMock.mockReturnValue(createMockIterator(messages));
    calculateCostMock.mockReturnValue(0.015);

    const config = makeConfig({ abortController, onMessage });
    await runAgentQuery(config);

    expect(calculateCostMock).toHaveBeenCalledWith(
      'claude-sonnet-4-5', 500, 200, expect.anything(), 'agent-query', undefined, undefined,
    );
    expect(appendCostEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cost: 0.015,
        est: true,
        tid: 'turn-1',
        sid: 'session-1',
        cat: 'conversation',
        m: 'claude-sonnet-4-5',
        auth: 'oauth-token',
      }),
    );
  });

  it('skips estimation when costRecorded is true (late result was captured)', async () => {
    const abortController = new AbortController();

    // Assistant message accumulates tokens, then result arrives on abort
    const messages = [
      { type: 'assistant', message: { content: [], usage: { input_tokens: 100, output_tokens: 50 } } },
      { type: 'result', total_cost_usd: 0.042, subtype: 'success' },
    ];

    // Abort on the result message — late result is captured inline,
    // which sets costRecorded = true and prevents estimation in finally.
    const onMessage = vi.fn((msg: unknown) => {
      if ((msg as { type: string }).type === 'result') abortController.abort();
    });
    queryMock.mockReturnValue(createMockIterator(messages));

    const config = makeConfig({ abortController, onMessage });
    await runAgentQuery(config);

    // Only exact cost entry, no estimation
    expect(appendCostEntryMock).toHaveBeenCalledTimes(1);
    expect(appendCostEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ cost: 0.042 }),
    );
    expect(appendCostEntryMock.mock.calls[0][0]).not.toHaveProperty('est');
    // calculateCost should NOT be called
    expect(calculateCostMock).not.toHaveBeenCalled();
  });

  it('skips estimation when registry hasCostRecorded returns true (handleAgentMessage recorded cost)', async () => {
    const abortController = new AbortController();
    registryMocks.hasCostRecorded.mockReturnValue(true);

    const messages = [
      { type: 'assistant', message: { content: [], usage: { input_tokens: 500, output_tokens: 200 } } },
    ];

    const onMessage = vi.fn(() => abortController.abort());
    queryMock.mockReturnValue(createMockIterator(messages));

    const config = makeConfig({ abortController, onMessage });
    await runAgentQuery(config);

    expect(calculateCostMock).not.toHaveBeenCalled();
    expect(appendCostEntryMock).not.toHaveBeenCalled();
  });

  it('skips estimation when output tokens are zero', async () => {
    const abortController = new AbortController();

    // Only input tokens, no output
    const messages = [
      { type: 'assistant', message: { content: [], usage: { input_tokens: 500, output_tokens: 0 } } },
    ];

    const onMessage = vi.fn(() => abortController.abort());
    queryMock.mockReturnValue(createMockIterator(messages));

    const config = makeConfig({ abortController, onMessage });
    await runAgentQuery(config);

    expect(calculateCostMock).not.toHaveBeenCalled();
    expect(appendCostEntryMock).not.toHaveBeenCalled();
  });

  it('skips estimation when calculateCost returns null (unknown model)', async () => {
    const abortController = new AbortController();

    const messages = [
      { type: 'assistant', message: { content: [], usage: { input_tokens: 500, output_tokens: 200 } } },
    ];

    const onMessage = vi.fn(() => abortController.abort());
    queryMock.mockReturnValue(createMockIterator(messages));
    calculateCostMock.mockReturnValue(null);

    const config = makeConfig({ abortController, onMessage });
    await runAgentQuery(config);

    expect(calculateCostMock).toHaveBeenCalled();
    expect(appendCostEntryMock).not.toHaveBeenCalled();
  });

  it('skips estimation when model is undefined in registry', async () => {
    const abortController = new AbortController();
    registryMocks.getTurnModel.mockReturnValue(undefined as unknown as string);

    const messages = [
      { type: 'assistant', message: { content: [], usage: { input_tokens: 500, output_tokens: 200 } } },
    ];

    const onMessage = vi.fn(() => abortController.abort());
    queryMock.mockReturnValue(createMockIterator(messages));

    const config = makeConfig({ abortController, onMessage });
    await runAgentQuery(config);

    // No model → skip estimation entirely
    expect(calculateCostMock).not.toHaveBeenCalled();
    expect(appendCostEntryMock).not.toHaveBeenCalled();
  });

  it('does not estimate when not aborted', async () => {
    const messages = [
      { type: 'assistant', message: { content: [], usage: { input_tokens: 500, output_tokens: 200 } } },
      { type: 'result', total_cost_usd: 0.05, subtype: 'success' },
    ];
    queryMock.mockReturnValue(createMockIterator(messages));

    const config = makeConfig();
    await runAgentQuery(config);

    // Normal flow: no estimation, handleAgentMessage handles everything
    expect(calculateCostMock).not.toHaveBeenCalled();
    // appendCostEntry not called directly from runner (handleAgentMessage does it)
    expect(appendCostEntryMock).not.toHaveBeenCalled();
  });

  it('swallows errors in estimation (best-effort)', async () => {
    const abortController = new AbortController();

    const messages = [
      { type: 'assistant', message: { content: [], usage: { input_tokens: 500, output_tokens: 200 } } },
    ];

    const onMessage = vi.fn(() => abortController.abort());
    queryMock.mockReturnValue(createMockIterator(messages));
    calculateCostMock.mockImplementation(() => { throw new Error('pricing boom'); });

    const config = makeConfig({ abortController, onMessage });

    // Should NOT throw
    const result = await runAgentQuery(config);
    expect(result.abortedByUser).toBe(true);
    expect(appendCostEntryMock).not.toHaveBeenCalled();
  });

  it('swallows errors in late result extraction (best-effort)', async () => {
    const abortController = new AbortController();
    abortController.abort();

    // Result message where appendCostEntry throws
    const messages = [
      { type: 'result', total_cost_usd: 0.05, subtype: 'success' },
    ];
    queryMock.mockReturnValue(createMockIterator(messages));
    appendCostEntryMock.mockImplementation(() => { throw new Error('ledger boom'); });

    const config = makeConfig({ abortController });

    // Should NOT throw
    const result = await runAgentQuery(config);
    expect(result.abortedByUser).toBe(true);
  });

  it('skips late result with total_cost_usd: 0', async () => {
    const abortController = new AbortController();
    abortController.abort();

    const messages = [
      { type: 'result', total_cost_usd: 0, subtype: 'success' },
    ];
    queryMock.mockReturnValue(createMockIterator(messages));

    const config = makeConfig({ abortController });
    await runAgentQuery(config);

    // Zero cost should not be recorded as exact
    expect(appendCostEntryMock).not.toHaveBeenCalled();
  });

  it('skips estimation when calculateCost returns 0', async () => {
    const abortController = new AbortController();

    const messages = [
      { type: 'assistant', message: { content: [], usage: { input_tokens: 500, output_tokens: 200 } } },
    ];

    const onMessage = vi.fn(() => abortController.abort());
    queryMock.mockReturnValue(createMockIterator(messages));
    calculateCostMock.mockReturnValue(0);

    const config = makeConfig({ abortController, onMessage });
    await runAgentQuery(config);

    expect(calculateCostMock).toHaveBeenCalled();
    expect(appendCostEntryMock).not.toHaveBeenCalled();
  });
});
