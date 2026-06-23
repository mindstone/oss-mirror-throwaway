import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppSettings } from '@shared/types';
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

vi.mock('../openRouterTokenStorage', () => ({
  hasManagedOpenRouterKey: vi.fn(() => true),
}));

// F1 (plan 260422 routing-follow-ups): mock shape centralised in
// `createAuthEnvUtilsMock`. Individual tests override `hasValidAuth` per-test
// via `vi.mocked(hasValidAuth)`.
vi.mock('@core/utils/authEnvUtils', () => createAuthEnvUtilsMock());

import { callWithModelAuthAware } from '../behindTheScenesClient';
import * as coreBehindTheScenesClient from '@core/services/behindTheScenesClient';
import { hasValidAuth } from '@core/utils/authEnvUtils';
import { appendCostEntry } from '@core/services/costLedgerService';

describe('callWithModelAuthAware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hasValidAuth).mockReturnValue(true);
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves wrapper hasManagedKey injection when delegating to core BTS client', async () => {
    const coreSpy = vi.spyOn(coreBehindTheScenesClient, 'callWithModelAuthAware').mockResolvedValue({
      content: [{ type: 'text', text: '{"risk":"low"}' }],
      model: 'claude-haiku-4-5',
    });

    const settings = {
      models: {
        apiKey: 'fake-test-key-123',
        authMethod: 'api-key',
      },
      coreDirectory: '/tmp/test',
    } as AppSettings;

    await callWithModelAuthAware(
      settings,
      'claude-haiku-4-5',
      { messages: [{ role: 'user', content: 'test' }] },
    );

    expect(coreSpy).toHaveBeenCalledTimes(1);
    expect(coreSpy.mock.calls[0][0]).toEqual(expect.objectContaining({ hasManagedKey: true }));
  });

  it('uses API key fetch path for API key user', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '{"risk":"low"}' }],
          model: 'claude-haiku-4-5',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const settings = {
      models: {
        apiKey: 'fake-test-key-123',
        authMethod: 'api-key',
      },
      coreDirectory: '/tmp/test',
    } as AppSettings;

    const response = await callWithModelAuthAware(
      settings,
      'claude-haiku-4-5',
      {
        messages: [{ role: 'user' as const, content: 'test' }],
        signal: new AbortController().signal,
        timeout: 10000,
      }
    );

    expect(global.fetch).toHaveBeenCalled();
    expect(response.content[0].text).toBe('{"risk":"low"}');
  });

  it('maps BTS outcomePolicy to turn-bearing versus auxiliary outcomes', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '{"risk":"low"}' }],
          model: 'claude-haiku-4-5',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const settings = {
      models: {
        apiKey: 'fake-test-key-123',
        authMethod: 'api-key',
      },
      coreDirectory: '/tmp/test',
    } as AppSettings;

    await callWithModelAuthAware(
      settings,
      'claude-haiku-4-5',
      { messages: [{ role: 'user', content: 'test' }] },
      { category: 'safety', outcomePolicy: 'turn_bearing' },
    );

    expect(appendCostEntry).toHaveBeenLastCalledWith(expect.objectContaining({
      outcome: { kind: 'success' },
    }));

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '{"risk":"low"}' }],
          model: 'claude-haiku-4-5',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await callWithModelAuthAware(
      settings,
      'claude-haiku-4-5',
      { messages: [{ role: 'user', content: 'test' }] },
      { category: 'metadata' },
    );

    expect(appendCostEntry).toHaveBeenLastCalledWith(expect.objectContaining({
      outcome: { kind: 'auxiliary_success' },
    }));
  });
});
