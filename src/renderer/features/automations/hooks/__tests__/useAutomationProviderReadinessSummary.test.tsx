// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, flushAsync } from '@renderer/test-utils';
import type { AutomationAdmissionBlock, AutomationProviderReadinessSummary } from '@shared/types';
import { useAutomationProviderReadinessSummary } from '../useAutomationProviderReadinessSummary';

const CODEX_CAUSE: AutomationAdmissionBlock = {
  source: 'provider-readiness',
  code: 'codex_disconnected',
  errorKind: 'connection-not-configured',
  headlineClass: 'auth',
  provider: 'codex',
  message: 'ChatGPT Pro is disconnected. Reconnect it in Settings, or switch to another provider.',
};

const makeSummary = (
  overrides: Partial<AutomationProviderReadinessSummary> = {},
): AutomationProviderReadinessSummary => ({
  readiness: 'ready',
  affectedAutomationCount: 0,
  affectedAutomationIds: [],
  blockedRunCount: 0,
  sinceMs: null,
  cause: null,
  ...overrides,
});

describe('useAutomationProviderReadinessSummary', () => {
  let onAutomationStateHandler: (() => void) | undefined;
  let onSettingsExternalUpdateHandler: (() => void) | undefined;

  beforeEach(() => {
    onAutomationStateHandler = undefined;
    onSettingsExternalUpdateHandler = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refetches provider readiness summary when settings:external-update fires', async () => {
    const blocked = makeSummary({
      readiness: 'blocked',
      affectedAutomationCount: 2,
      affectedAutomationIds: ['auto-1', 'auto-2'],
      blockedRunCount: 3,
      sinceMs: Date.now() - 60_000,
      cause: CODEX_CAUSE,
    });
    const ready = makeSummary();

    const providerReadinessSummary = vi
      .fn()
      .mockResolvedValueOnce(blocked)
      .mockResolvedValueOnce(ready);

    Object.assign(window, {
      automationsApi: {
        providerReadinessSummary,
      },
      api: {
        onAutomationState: vi.fn((handler: () => void) => {
          onAutomationStateHandler = handler;
          return () => undefined;
        }),
        onSettingsExternalUpdate: vi.fn((handler: () => void) => {
          onSettingsExternalUpdateHandler = handler;
          return () => undefined;
        }),
      },
    });

    const { result, unmount } = renderHook(() => useAutomationProviderReadinessSummary());

    await flushAsync();
    await flushAsync();

    expect(onAutomationStateHandler).toBeTypeOf('function');
    expect(onSettingsExternalUpdateHandler).toBeTypeOf('function');
    expect(providerReadinessSummary).toHaveBeenCalledTimes(1);
    expect(result.current.providerReadinessSummary.readiness).toBe('blocked');
    expect(result.current.providerWaitCauseCount).toBe(1);

    await act(async () => {
      onSettingsExternalUpdateHandler?.();
      await flushAsync();
      await flushAsync();
    });

    expect(providerReadinessSummary).toHaveBeenCalledTimes(2);
    expect(result.current.providerReadinessSummary.readiness).toBe('ready');
    expect(result.current.providerWaitCauseCount).toBe(0);

    unmount();
  });
});
