// @vitest-environment happy-dom

/**
 * C-F1 (billing honesty) tests for `useCloudProvisioning.handleDestroyOrphanedManaged`.
 *
 * Background: for an already-Forgotten managed orphan, a
 * `local-only-remote-uncertain` result is a LOCAL no-op (local config was
 * already wiped by the prior Forget) and is NOT proof the remote DELETE landed.
 * The follow-up discovery can also collapse a backend error to `exists:false`
 * (with a `managed.error`). The OLD gate treated a local clear as success and
 * hid the orphan recovery banner in exactly these cases → the orphan keeps
 * billing while the user thinks it's gone.
 *
 * Contract under test (red on the old code, green after the fix):
 *   - Destroy resolves `local-only-remote-uncertain` AND discovery comes back
 *     `{managed:{exists:false, error:'HTTP 503'}}` (could-not-check)
 *     → the orphan banner (`orphanedManaged`) MUST remain visible + `reattachError`
 *     set.
 *   - Destroy resolves `remote-removed` → banner clears (green path).
 *   - Destroy fails but discovery returns a CLEAN `{managed:{exists:false}}`
 *     (no error = authoritative 404) → banner clears (confirmed gone).
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

interface DiscoveryResult {
  managed: { exists: boolean; cloudUrl?: string; error?: string };
  byok: { exists: boolean; healthy: boolean };
  conflict: boolean;
  activeInSettings: 'managed' | 'byok' | 'none';
}

/**
 * Install the cloudApi/settingsApi mocks. `initialDiscovery` is returned by the
 * mount discovery (establishing the orphan), then `discoveryQueue` items are
 * returned by subsequent `discoverInstances()` calls (the post-destroy
 * re-discovery), falling back to the last entry.
 */
function installCloudApiMock(opts: {
  initialDiscovery: DiscoveryResult;
  postDestroyDiscovery: DiscoveryResult | Error;
  deprovisionResult: DeprovisionResult;
}) {
  let discoverCall = 0;
  const discoverInstances = vi.fn().mockImplementation(() => {
    discoverCall += 1;
    if (discoverCall === 1) return Promise.resolve(opts.initialDiscovery);
    if (opts.postDestroyDiscovery instanceof Error) {
      return Promise.reject(opts.postDestroyDiscovery);
    }
    return Promise.resolve(opts.postDestroyDiscovery);
  });

  const api = {
    measureFootprint: vi.fn().mockResolvedValue({
      kind: 'measured_zero', totalBytes: 0, workspaceBytes: 0, appDataBytes: 0, durationMs: 1,
    }),
    discoverInstances,
    doOauthStatus: vi.fn().mockResolvedValue({ connected: false }),
    checkUpdate: vi.fn().mockResolvedValue({ success: true, updateAvailable: false, rateLimited: false }),
    hasFlyToken: vi.fn().mockResolvedValue({ hasToken: false }),
    deprovision: vi.fn().mockResolvedValue(opts.deprovisionResult),
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
    draftSettings: { managedCloudEnabled: true } as AppSettings,
    cloudInstance: undefined,
    updateDraft: vi.fn(),
    isConnected: false,
    isFlyByok: false,
    isAutoProvisioned: false,
    isManaged: false,
    cloudHealth: null,
    setCloudHealth: vi.fn(),
  } as const;
}

const ORPHAN: DiscoveryResult = {
  managed: { exists: true, cloudUrl: 'https://orphan.example.dev' },
  byok: { exists: false, healthy: false },
  conflict: false,
  activeInSettings: 'none',
};

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* noop */ });
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('useCloudProvisioning — orphan destroy honesty (C-F1)', () => {
  it('RED→GREEN: failed remote DELETE + could-not-check discovery keeps the orphan banner visible', async () => {
    // Main returns local-only-remote-uncertain on remote failure; discovery
    // collapses the backend error to exists:false WITH an error string
    // (could-not-check).
    installCloudApiMock({
      initialDiscovery: ORPHAN,
      postDestroyDiscovery: {
        managed: { exists: false, error: 'HTTP 503' },
        byok: { exists: false, healthy: false },
        conflict: false,
        activeInSettings: 'none',
      },
      deprovisionResult: {
        kind: 'local-only-remote-uncertain',
        error: "Cleared on this device, but Mindstone Cloud couldn't remove the instance (HTTP 503). It may still be running.",
      },
    });

    const { useCloudProvisioning } = await import('../useCloudProvisioning');
    const { result, unmount } = await renderHookAsync(() => useCloudProvisioning(baseProps()));

    // Orphan detected on mount.
    expect(result.current.orphanedManaged).toBe(true);

    await act(async () => {
      await result.current.handleDestroyOrphanedManaged();
    });

    // The remote was NOT confirmed gone (the local-only result is a no-op;
    // discovery could-not-check). Banner must remain so the possibly-billing
    // orphan stays surfaced; error must be shown in-banner.
    expect(result.current.orphanedManaged).toBe(true);
    expect(result.current.reattachError).toBeTruthy();
    unmount();
  });

  it('GREEN: confirmed remote removal (success:true) clears the banner', async () => {
    installCloudApiMock({
      initialDiscovery: ORPHAN,
      postDestroyDiscovery: {
        managed: { exists: false },
        byok: { exists: false, healthy: false },
        conflict: false,
        activeInSettings: 'none',
      },
      deprovisionResult: { kind: 'remote-removed' },
    });

    const { useCloudProvisioning } = await import('../useCloudProvisioning');
    const { result, unmount } = await renderHookAsync(() => useCloudProvisioning(baseProps()));

    expect(result.current.orphanedManaged).toBe(true);

    await act(async () => {
      await result.current.handleDestroyOrphanedManaged();
    });

    expect(result.current.orphanedManaged).toBe(false);
    expect(result.current.reattachError).toBeNull();
    unmount();
  });

  it('GREEN: failed DELETE but CLEAN discovery (exists:false, no error) clears the banner', async () => {
    // DELETE errored, but the status endpoint authoritatively says it's gone
    // (clean 404, no managed.error) → treat as confirmed removal.
    installCloudApiMock({
      initialDiscovery: ORPHAN,
      postDestroyDiscovery: {
        managed: { exists: false },
        byok: { exists: false, healthy: false },
        conflict: false,
        activeInSettings: 'none',
      },
      deprovisionResult: {
        kind: 'local-only-remote-uncertain',
        error: 'Cleared on this device, but Mindstone Cloud returned an error.',
      },
    });

    const { useCloudProvisioning } = await import('../useCloudProvisioning');
    const { result, unmount } = await renderHookAsync(() => useCloudProvisioning(baseProps()));

    expect(result.current.orphanedManaged).toBe(true);

    await act(async () => {
      await result.current.handleDestroyOrphanedManaged();
    });

    expect(result.current.orphanedManaged).toBe(false);
    unmount();
  });

  it('RED→GREEN: failed DELETE + discovery throws (cannot check) keeps the banner', async () => {
    installCloudApiMock({
      initialDiscovery: ORPHAN,
      postDestroyDiscovery: new Error('discovery network error'),
      deprovisionResult: { kind: 'local-only-remote-uncertain', error: 'remote unreachable' },
    });

    const { useCloudProvisioning } = await import('../useCloudProvisioning');
    const { result, unmount } = await renderHookAsync(() => useCloudProvisioning(baseProps()));

    expect(result.current.orphanedManaged).toBe(true);

    await act(async () => {
      await result.current.handleDestroyOrphanedManaged();
    });

    expect(result.current.orphanedManaged).toBe(true);
    expect(result.current.reattachError).toBeTruthy();
    unmount();
  });
});
