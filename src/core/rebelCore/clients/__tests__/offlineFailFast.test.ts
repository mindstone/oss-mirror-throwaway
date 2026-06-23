/**
 * Shared fail-fast-offline helper (`offlineFailFast.ts`) — unit coverage for the
 * cross-client gate primitives (Stage 2 refinement: F2 process-tolerance +
 * defensive call-site fail-open; once-per-invocation caching).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { isMachineOfflineMock, mockLoggerMethods } = vi.hoisted(() => ({
  isMachineOfflineMock: vi.fn<(...args: unknown[]) => Promise<boolean>>(),
  mockLoggerMethods: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: vi.fn(() => mockLoggerMethods),
}));

vi.mock('@core/services/timeoutDiagnosticsService', () => ({
  isMachineOffline: isMachineOfflineMock,
}));

import {
  OFFLINE_FAIL_FAST_MESSAGE,
  buildOfflineFailFastError,
  isOfflineFailFastEnabled,
  probeOfflineOnce,
} from '../offlineFailFast';
import { ModelError } from '../../modelErrors';

describe('isOfflineFailFastEnabled', () => {
  const original = process.env.REBEL_OFFLINE_FAILFAST;
  afterEach(() => {
    if (original === undefined) delete process.env.REBEL_OFFLINE_FAILFAST;
    else process.env.REBEL_OFFLINE_FAILFAST = original;
  });

  it('defaults ON when the env var is unset', () => {
    delete process.env.REBEL_OFFLINE_FAILFAST;
    expect(isOfflineFailFastEnabled()).toBe(true);
  });

  it('is disabled only by the exact "0" kill-switch', () => {
    process.env.REBEL_OFFLINE_FAILFAST = '0';
    expect(isOfflineFailFastEnabled()).toBe(false);
    process.env.REBEL_OFFLINE_FAILFAST = '1';
    expect(isOfflineFailFastEnabled()).toBe(true);
  });

  it('F2: tolerates a missing global `process` (cross-surface @core safety) — defaults ON', () => {
    const saved = globalThis.process;
    try {
      // Simulate a mobile/cloud runtime where `process` is absent.
      (globalThis as { process?: unknown }).process = undefined;
      expect(isOfflineFailFastEnabled()).toBe(true);
    } finally {
      (globalThis as { process?: unknown }).process = saved;
    }
  });
});

describe('buildOfflineFailFastError', () => {
  it('preserves kind/status/upstream + raw message, attaches the offlineFailFast marker', () => {
    const base = new ModelError('server_error', 'OpenRouter passthrough failed', 500, 'OpenRouter', {
      rawMessage: 'getaddrinfo ENOTFOUND openrouter.ai',
      upstreamProvider: 'Anthropic',
      details: { someOther: 1 },
    });

    const out = buildOfflineFailFastError(base, 'OpenRouter');

    expect(out).toBeInstanceOf(ModelError);
    expect(out.kind).toBe('server_error');
    expect(out.isTransient).toBe(true);
    expect(out.status).toBe(500);
    expect(out.provider).toBe('OpenRouter');
    expect(out.upstreamProvider).toBe('Anthropic');
    expect(out.message).toBe(OFFLINE_FAIL_FAST_MESSAGE);
    expect(out.__rawMessage).toBe('getaddrinfo ENOTFOUND openrouter.ai');
    expect(out.details?.offlineFailFast).toBe(true);
    expect(out.details?.someOther).toBe(1);
  });
});

describe('probeOfflineOnce', () => {
  beforeEach(() => isMachineOfflineMock.mockReset());

  it('returns the cached verdict WITHOUT probing when already known', async () => {
    expect(await probeOfflineOnce(undefined, true)).toBe(true);
    expect(await probeOfflineOnce(undefined, false)).toBe(false);
    expect(isMachineOfflineMock).not.toHaveBeenCalled();
  });

  it('probes when verdict is undefined and returns the probe result', async () => {
    isMachineOfflineMock.mockResolvedValue(true);
    expect(await probeOfflineOnce(undefined, undefined)).toBe(true);
    expect(isMachineOfflineMock).toHaveBeenCalledTimes(1);
  });

  // F2 (defensive fail-OPEN when the probe THROWS) is exercised end-to-end through
  // the real gate in `anthropicClient.offlineFailFast.test.ts` ("F2: probe THROWS
  // ⇒ defensive fail-OPEN at the call site, retries as today"). Asserting it here
  // by calling the mocked async dep directly trips a vitest mock-tracking artifact
  // (the recorded rejected promise surfaces as unhandled even though probeOfflineOnce
  // catches it), so the behavior is pinned at the integration layer instead.
});
