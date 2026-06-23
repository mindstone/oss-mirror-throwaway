import { afterEach, describe, expect, it, vi } from 'vitest';

// Fail-fast-offline gate (Stage 2): runWithRetry consults isMachineOffline on the
// retry path. These tests exercise the ONLINE/transient-retry behavior, so stub
// the probe to "online" (false) — otherwise the real fetch to api.anthropic.com
// runs in the unit environment and non-deterministically trips the offline gate.
vi.mock('@core/services/timeoutDiagnosticsService', () => ({
  isMachineOffline: vi.fn(async () => false),
}));

import { AnthropicClient } from '../clients/anthropicClient';
import { ModelError } from '../modelErrors';
import type { CreateResult, StreamResult } from '../modelClient';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';

const BASE_CREATE_PARAMS = {
  model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
  systemPrompt: 'System prompt',
  messages: [{ role: 'user' as const, content: 'Hello' }],
  maxTokens: 256,
};

const BASE_STREAM_PARAMS = {
  model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
  systemPrompt: 'System prompt',
  messages: [{ role: 'user' as const, content: 'Hello' }],
  maxTokens: 256,
};

describe('AnthropicClient retry callbacks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('calls create onRetry before each retry backoff', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const client = new AnthropicClient({ apiKey: 'test-key' });
    const createResult: CreateResult = {
      content: [],
      stopReason: 'end_turn',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    };

    let attempts = 0;
    vi.spyOn(client as any, 'doCreate').mockImplementation(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new ModelError('server_error', 'Server error');
      }
      return createResult;
    });

    const onRetry = vi.fn();
    const createPromise = client.create({
      ...BASE_CREATE_PARAMS,
      onRetry,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(createPromise).resolves.toEqual(createResult);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, {
      attempt: 1,
      maxRetries: 3,
      delayMs: 1_000,
      errorKind: 'server_error',
      provider: 'Anthropic',
    });
    expect(onRetry).toHaveBeenNthCalledWith(2, {
      attempt: 2,
      maxRetries: 3,
      delayMs: 2_000,
      errorKind: 'server_error',
      provider: 'Anthropic',
    });
  });

  it('calls stream onRetry before retrying transient errors', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const client = new AnthropicClient({ apiKey: 'test-key' });
    const streamResult: StreamResult = {
      content: [],
      stopReason: 'end_turn',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    };

    let attempts = 0;
    vi.spyOn(client as any, 'doStream').mockImplementation(async () => {
      attempts += 1;
      if (attempts < 2) {
        throw new ModelError('server_error', 'Temporary outage');
      }
      return streamResult;
    });

    const onRetry = vi.fn();
    const streamPromise = client.stream(
      {
        ...BASE_STREAM_PARAMS,
        onRetry,
      },
      () => {},
    );

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(streamPromise).resolves.toEqual(streamResult);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith({
      attempt: 1,
      maxRetries: 3,
      delayMs: 1_000,
      errorKind: 'server_error',
      provider: 'Anthropic',
    });
  });

  it('does not retry rate_limit errors', async () => {
    const client = new AnthropicClient({ apiKey: 'test-key' });

    vi.spyOn(client as any, 'doCreate').mockImplementation(async () => {
      throw new ModelError('rate_limit', 'Rate limited');
    });

    const onRetry = vi.fn();
    await expect(
      client.create({ ...BASE_CREATE_PARAMS, onRetry }),
    ).rejects.toThrow('Rate limited');
    expect(onRetry).not.toHaveBeenCalled();
  });
});
