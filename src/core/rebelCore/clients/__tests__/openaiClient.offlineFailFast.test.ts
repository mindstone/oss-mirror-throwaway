/**
 * Fail-fast-offline gate in `OpenAIClient.runWithRetry`
 * (260618_arthur-offline-resilience Stage 2 refinement — coverage extension).
 *
 * The same shared gate (`offlineFailFast.ts`) that protects AnthropicClient also
 * covers OpenAI BYOK / OpenAI-compatible custom gateways / local models / Codex
 * subscription. When offline, an OpenAIClient transient turn fails fast with the
 * `offlineFailFast` marker instead of churning retries → watchdog hang.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { isMachineOfflineMock } = vi.hoisted(() => ({
  isMachineOfflineMock: vi.fn<(...args: unknown[]) => Promise<boolean>>(),
}));

vi.mock('@core/services/timeoutDiagnosticsService', () => ({
  isMachineOffline: isMachineOfflineMock,
}));

import { OpenAIClient } from '../openaiClient';
import { ModelError } from '../../modelErrors';
import type { CreateResult } from '../../modelClient';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';

const BASE_CREATE_PARAMS = {
  model: unsafeAssertRoutingModelId('gpt-5.5'),
  systemPrompt: 'System prompt',
  messages: [{ role: 'user' as const, content: 'Hello' }],
  maxTokens: 256,
};

const CREATE_RESULT: CreateResult = {
  content: [],
  stopReason: 'end_turn',
  usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
};

function makeClient(): OpenAIClient {
  return new OpenAIClient({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: 'test-key',
    provider: 'OpenRouter',
    providerType: 'other',
  });
}

describe('OpenAIClient fail-fast-offline gate', () => {
  beforeEach(() => {
    isMachineOfflineMock.mockReset();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    delete process.env.REBEL_OFFLINE_FAILFAST;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete process.env.REBEL_OFFLINE_FAILFAST;
  });

  it('offline ⇒ throws WITHOUT retrying, carrying the offlineFailFast marker', async () => {
    isMachineOfflineMock.mockResolvedValue(true);

    let attempts = 0;
    const client = makeClient();
    vi.spyOn(client as unknown as { doCreate: () => Promise<CreateResult> }, 'doCreate').mockImplementation(
      async () => {
        attempts += 1;
        throw new ModelError('server_error', 'Server error');
      },
    );
    const onRetry = vi.fn();

    const error = await client.create({ ...BASE_CREATE_PARAMS, onRetry }).catch((e) => e);

    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).details?.offlineFailFast).toBe(true);
    expect(attempts).toBe(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(isMachineOfflineMock).toHaveBeenCalledTimes(1);
  });

  it('online ⇒ retries N times exactly as today', async () => {
    vi.useFakeTimers();
    isMachineOfflineMock.mockResolvedValue(false);

    let attempts = 0;
    const client = makeClient();
    vi.spyOn(client as unknown as { doCreate: () => Promise<CreateResult> }, 'doCreate').mockImplementation(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new ModelError('server_error', 'Server error');
        return CREATE_RESULT;
      },
    );

    const promise = client.create({ ...BASE_CREATE_PARAMS });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(promise).resolves.toEqual(CREATE_RESULT);
    expect(attempts).toBe(3);
    // Probe consulted at most once across the retries (cached verdict).
    expect(isMachineOfflineMock).toHaveBeenCalledTimes(1);
  });

  it('kill-switch (REBEL_OFFLINE_FAILFAST=0) ⇒ never probes', async () => {
    vi.useFakeTimers();
    process.env.REBEL_OFFLINE_FAILFAST = '0';
    isMachineOfflineMock.mockResolvedValue(true);

    let attempts = 0;
    const client = makeClient();
    vi.spyOn(client as unknown as { doCreate: () => Promise<CreateResult> }, 'doCreate').mockImplementation(
      async () => {
        attempts += 1;
        if (attempts < 2) throw new ModelError('server_error', 'Server error');
        return CREATE_RESULT;
      },
    );

    const promise = client.create({ ...BASE_CREATE_PARAMS });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(promise).resolves.toEqual(CREATE_RESULT);
    expect(attempts).toBe(2);
    expect(isMachineOfflineMock).not.toHaveBeenCalled();
  });
});
