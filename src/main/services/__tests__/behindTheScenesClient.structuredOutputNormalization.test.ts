import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAuthEnvUtilsMock } from '@core/utils/__tests__/authEnvUtilsMock';

vi.mock('@anthropic-ai/sdk', () => ({
  Anthropic: class MockAnthropic {
    messages = {
      create: vi.fn(),
    };
  },
}));

vi.mock('@core/services/costLedgerService', () => ({
  appendCostEntry: vi.fn(() => ({ costEntryId: 'test-cost-entry-id' })),
}));

 
vi.mock('@core/services/codexAuthCore', () => ({
  isCodexConnected: vi.fn(() => false),
}));

// F1 (plan 260422 routing-follow-ups): mock shape centralised in
// `createAuthEnvUtilsMock`. Individual tests override `hasValidAuth` per-test
// via `vi.mocked(hasValidAuth)`.
vi.mock('@core/utils/authEnvUtils', () => createAuthEnvUtilsMock());

import { hasValidAuth } from '@core/utils/authEnvUtils';

describe('callBehindTheScenesWithAuth structured output normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hasValidAuth).mockReturnValue(true);
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses JSON text output into structured_output for API key requests', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '{"risk":"low","reason":"hello"}' }],
          model: 'claude-haiku-4-20250514',
          usage: { input_tokens: 6, output_tokens: 4 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const { callBehindTheScenesWithAuth } = await import('../behindTheScenesClient');

    const settings = {
      models: { apiKey: 'fake-ant-test-key', authMethod: 'api-key' },
    } as never;

    const response = await callBehindTheScenesWithAuth(settings, {
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 16,
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      timeout: 1000,
    });

    expect(global.fetch).toHaveBeenCalled();
    expect(response.structured_output).toEqual({ risk: 'low', reason: 'hello' });
    expect(response.content?.[0]?.type).toBe('text');
    expect(response.content?.[0]?.text).toBe('{"risk":"low","reason":"hello"}');
  });
});
