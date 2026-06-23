// @vitest-environment happy-dom

/**
 * C-F3 (persistent partial-failure banner) test for
 * `useCloudProvisioning.handleDeprovision`.
 *
 * A partial deprovision (`local-only-remote-uncertain`) means the local config
 * was wiped but the remote may still be running (still billing). The old code
 * routed this signal to `connectError`, which only renders inside the collapsed
 * "Connect manually" disclosure on a now-different (post-wipe) screen.
 *
 * Contract under test (red on the old code, green after the fix):
 *   - On a partial deprovision, the persistent `provisionError` banner is set
 *     with `severity:'warning'` (it renders near the deprovision / post-wipe
 *     setup surface, not gated on `isAutoProvisioned`).
 *   - `connectError` is cleared (not buried behind the disclosure).
 *   - A clean success leaves `provisionError` null.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import type { AppSettings } from '@shared/types';
import type { DeprovisionResult } from '@shared/ipc/channels/cloud';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HookResult<T> = {
  result: { current: T };
  unmount: () => void;
};

async function renderHookAsync<T>(hookFn: () => T): Promise<HookResult<T>> {
  const result = { current: undefined as unknown as T };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  const TestComponent = () => {
    result.current = hookFn();
    return null;
  };

  await act(async () => {
    root.render(React.createElement(TestComponent));
  });

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  return {
    result,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function installCloudApiMock(deprovisionResult: DeprovisionResult) {
  const api = {
    measureFootprint: vi.fn().mockResolvedValue({
      kind: 'measured_zero', totalBytes: 0, workspaceBytes: 0, appDataBytes: 0, durationMs: 1,
    }),
    discoverInstances: vi.fn().mockResolvedValue({
      managed: { exists: false },
      byok: { exists: false, healthy: false },
      conflict: false,
      activeInSettings: 'none',
    }),
    doOauthStatus: vi.fn().mockResolvedValue({ connected: false }),
    checkUpdate: vi.fn().mockResolvedValue({ success: true, updateAvailable: false, rateLimited: false }),
    hasFlyToken: vi.fn().mockResolvedValue({ hasToken: false }),
    syncNow: vi.fn().mockResolvedValue({ success: true }),
    deprovision: vi.fn().mockResolvedValue(deprovisionResult),
  };

  const settingsApi = {
    update: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue({ cloudInstance: undefined }),
  };

  const g = globalThis as unknown as {
    window?: { cloudApi?: unknown; settingsApi?: unknown };
  };
  g.window = g.window ?? {};
  g.window.cloudApi = api;
  g.window.settingsApi = settingsApi;

  return api;
}

function baseProps() {
  return {
    draftSettings: { managedCloudEnabled: false } as AppSettings,
    cloudInstance: { mode: 'cloud', cloudUrl: 'https://x.fly.dev', cloudToken: 't', provisionMode: 'byok', providerId: 'fly' } as unknown as AppSettings['cloudInstance'],
    updateDraft: vi.fn(),
    isConnected: true,
    isFlyByok: false,
    isAutoProvisioned: true,
    isManaged: false,
    cloudHealth: null,
    setCloudHealth: vi.fn(),
  } as const;
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* noop */ });
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('useCloudProvisioning — partial deprovision banner (C-F3)', () => {
  it('RED→GREEN: partial deprovision sets a persistent warning-severity provisionError and clears connectError', async () => {
    installCloudApiMock({
      kind: 'local-only-remote-uncertain',
      error: 'Cleared on this device, but the cloud may still be running.',
    });

    const { useCloudProvisioning } = await import('../useCloudProvisioning');
    const { result, unmount } = await renderHookAsync(() => useCloudProvisioning(baseProps()));

    const setBusy = vi.fn();
    const setConnectError = vi.fn();
    const clearSyncResults = vi.fn();

    // First call arms the confirm.
    await act(async () => {
      await result.current.handleDeprovision({ setBusy, setConnectError, clearSyncResults });
    });
    expect(result.current.confirmDeprovision).toBe(true);

    // Second call performs the deprovision.
    await act(async () => {
      await result.current.handleDeprovision({ setBusy, setConnectError, clearSyncResults });
    });

    // Persistent warning banner is set (red on old code, which routed to connectError).
    expect(result.current.provisionError).not.toBeNull();
    expect(result.current.provisionError?.severity).toBe('warning');
    expect(result.current.provisionError?.userMessage).toBeTruthy();

    // connectError is cleared, not populated with the partial message.
    expect(setConnectError).toHaveBeenCalledWith(null);
    expect(setConnectError).not.toHaveBeenCalledWith(expect.stringContaining('still be running'));
    unmount();
  });

  it('GREEN: clean success does not set provisionError', async () => {
    installCloudApiMock({ kind: 'remote-removed' });

    const { useCloudProvisioning } = await import('../useCloudProvisioning');
    const { result, unmount } = await renderHookAsync(() => useCloudProvisioning(baseProps()));

    const setBusy = vi.fn();
    const setConnectError = vi.fn();
    const clearSyncResults = vi.fn();

    await act(async () => {
      await result.current.handleDeprovision({ setBusy, setConnectError, clearSyncResults });
    });
    await act(async () => {
      await result.current.handleDeprovision({ setBusy, setConnectError, clearSyncResults });
    });

    expect(result.current.provisionError).toBeNull();
    unmount();
  });
});
