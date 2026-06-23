/**
 * Fail-fast-offline gate in `AnthropicClient.runWithRetry`
 * (260618_arthur-offline-resilience Stage 2).
 *
 * When a transient error is about to be retried, runWithRetry consults an
 * independent reachability probe. If the machine is CONFIRMED offline it stops
 * retrying immediately and throws a `ModelError` carrying `details.offlineFailFast`
 * (which recovery maps to the existing retryable message_timeout terminal).
 * Otherwise (online OR inconclusive probe) it retries exactly as before.
 *
 * Red→green note: pre-fix, runWithRetry had no probe — an offline transient error
 * would retry N times with sleeps. The `offline ⇒ throws without retrying` test
 * fails against pre-fix code (no offlineFailFast marker; retries occur).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { isMachineOfflineMock } = vi.hoisted(() => ({
  isMachineOfflineMock: vi.fn<(...args: unknown[]) => Promise<boolean>>(),
}));

vi.mock('@core/services/timeoutDiagnosticsService', () => ({
  isMachineOffline: isMachineOfflineMock,
}));

import { AnthropicClient } from '../clients/anthropicClient';
import { ModelError } from '../modelErrors';
import type { CreateResult } from '../modelClient';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';

const BASE_CREATE_PARAMS = {
  model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
  systemPrompt: 'System prompt',
  messages: [{ role: 'user' as const, content: 'Hello' }],
  maxTokens: 256,
};

const CREATE_RESULT: CreateResult = {
  content: [],
  stopReason: 'end_turn',
  usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
};

function makeClient(): AnthropicClient {
  return new AnthropicClient({ apiKey: 'test-key' });
}

describe('AnthropicClient fail-fast-offline gate', () => {
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
    // No retry: doCreate ran exactly once, the backoff onRetry was never called.
    expect(attempts).toBe(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(isMachineOfflineMock).toHaveBeenCalledTimes(1);
  });

  it('online ⇒ retries N times exactly as today (regression guard for slow-but-valid)', async () => {
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
    const onRetry = vi.fn();

    const promise = client.create({ ...BASE_CREATE_PARAMS, onRetry });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(promise).resolves.toEqual(CREATE_RESULT);
    expect(attempts).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    // offlineFailFast marker never attached.
    expect(onRetry.mock.calls.every((c) => (c[0] as { errorKind: string }).errorKind === 'server_error')).toBe(true);
  });

  it('inconclusive probe (returns false) ⇒ fails OPEN, retries as today', async () => {
    vi.useFakeTimers();
    // isMachineOffline already collapses inconclusive→false; the gate must retry.
    isMachineOfflineMock.mockResolvedValue(false);

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
  });

  it('probe is consulted AT MOST ONCE across N retries (cached verdict)', async () => {
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
    // 2 retries occurred, but the probe ran exactly once (cached across the loop).
    expect(attempts).toBe(3);
    expect(isMachineOfflineMock).toHaveBeenCalledTimes(1);
  });

  it('kill-switch (REBEL_OFFLINE_FAILFAST=0) ⇒ never probes, behaves as today', async () => {
    vi.useFakeTimers();
    process.env.REBEL_OFFLINE_FAILFAST = '0';
    // Even if the machine WERE offline, the gate is disabled.
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

  it('does not probe for rate_limit (never retried) — unaffected by the gate', async () => {
    isMachineOfflineMock.mockResolvedValue(true);

    const client = makeClient();
    vi.spyOn(client as unknown as { doCreate: () => Promise<CreateResult> }, 'doCreate').mockImplementation(
      async () => {
        throw new ModelError('rate_limit', 'Rate limited');
      },
    );

    await expect(client.create({ ...BASE_CREATE_PARAMS })).rejects.toThrow('Rate limited');
    expect(isMachineOfflineMock).not.toHaveBeenCalled();
  });

  it('F2: probe THROWS ⇒ defensive fail-OPEN at the call site, retries as today', async () => {
    vi.useFakeTimers();
    // probeOfflineOnce wraps isMachineOffline in try/catch → a throw is treated as
    // online (never breaks a legitimate retry, even if a future probe regresses).
    // mockImplementation (not mockRejectedValue) so the rejection only exists when called.
    isMachineOfflineMock.mockImplementation(async () => {
      throw new Error('probe blew up');
    });

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
  });
});
