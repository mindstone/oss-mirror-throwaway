// @vitest-environment happy-dom

/**
 * Stage 5 provisioning passthrough tests for `useCloudProvisioning`.
 *
 * Verifies the contract:
 *   - `handleProvision({ vmTierId })` includes `vmTierId` in the provision IPC
 *     payload **only** when the selected provider is Fly (BYOK).
 *   - The vmTierId persisted by the backend (returned in `provision()` result)
 *     survives the renderer's settings write — i.e. `cloudInstance.vmTierId`
 *     reflects the provisioned value rather than getting clobbered to undefined.
 *   - Non-Fly providers do NOT get `vmTierId` in the IPC payload, even when
 *     callers (incorrectly) pass it.
 *   - Managed (mindstone) provisions do NOT get `vmTierId` in the IPC payload.
 *
 * See planning doc:
 *   docs/plans/260503_cloud_robustness_vm_tiers_and_data_hygiene.md (Stage 5)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import type { AppSettings } from '@shared/types';

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

interface CloudApiMock {
  measureFootprint: ReturnType<typeof vi.fn>;
  discoverInstances: ReturnType<typeof vi.fn>;
  doOauthStatus: ReturnType<typeof vi.fn>;
  checkUpdate: ReturnType<typeof vi.fn>;
  provision: ReturnType<typeof vi.fn>;
  reconcile: ReturnType<typeof vi.fn>;
}

function installCloudApiMock(provisionResult: unknown): CloudApiMock {
  const api: CloudApiMock = {
    measureFootprint: vi.fn().mockResolvedValue({
      kind: 'measured_zero',
      totalBytes: 0,
      workspaceBytes: 0,
      appDataBytes: 0,
      durationMs: 1,
    }),
    discoverInstances: vi.fn().mockResolvedValue({
      managed: { exists: false },
      byok: { exists: false, healthy: false },
      conflict: false,
      activeInSettings: 'none',
    }),
    doOauthStatus: vi.fn().mockResolvedValue({ connected: false }),
    checkUpdate: vi.fn().mockResolvedValue({ success: true, updateAvailable: false, rateLimited: false }),
    provision: vi.fn().mockResolvedValue(provisionResult),
    reconcile: vi.fn().mockResolvedValue({ success: true }),
  };

  const settingsApi = {
    update: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue({ cloudInstance: undefined }),
  };

  const g = globalThis as unknown as {
    window?: {
      cloudApi?: unknown;
      settingsApi?: unknown;
    };
  };
  g.window = g.window ?? {};
  g.window.cloudApi = api;
  g.window.settingsApi = settingsApi;

  return api;
}

function baseProps(overrides?: { managedCloudEnabled?: boolean }) {
  return {
    draftSettings: {
      managedCloudEnabled: overrides?.managedCloudEnabled ?? false,
    } as AppSettings,
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

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* noop */ });
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('useCloudProvisioning — vmTierId passthrough (Stage 5)', () => {
  it('Fly BYOK: includes vmTierId in the provision IPC payload', async () => {
    const api = installCloudApiMock({
      success: true,
      cloudUrl: 'https://rebel-cloud-test.fly.dev',
      cloudToken: 'tok',
      appName: 'rebel-cloud-test',
      machineId: 'machine-1',
      volumeId: 'vol-1',
      region: 'iad',
      vmTierId: 'faster',
    });

    const { useCloudProvisioning } = await import('../useCloudProvisioning');
    const { result, unmount } = await renderHookAsync(() => useCloudProvisioning(baseProps()));

    // selectedProvider defaults to 'fly' for non-managed.
    await act(async () => {
      result.current.setProviderTokenInput('fly-test-token');
    });

    let provisionResult: { success: boolean } | undefined;
    await act(async () => {
      provisionResult = await result.current.handleProvision({ vmTierId: 'faster' });
    });

    expect(provisionResult?.success).toBe(true);
    expect(api.provision).toHaveBeenCalledOnce();
    const payload = api.provision.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      providerId: 'fly',
      flyApiToken: 'fly-test-token',
      vmTierId: 'faster',
    });
    unmount();
  });

  it('Fly BYOK: passthrough survives renderer settings write — vmTierId preserved on cloudInstance', async () => {
    installCloudApiMock({
      success: true,
      cloudUrl: 'https://rebel-cloud-test.fly.dev',
      cloudToken: 'tok',
      appName: 'rebel-cloud-test',
      machineId: 'machine-1',
      volumeId: 'vol-1',
      region: 'iad',
      vmTierId: 'heavy-work',
    });

    const settingsUpdate = (globalThis as unknown as {
      window: { settingsApi: { update: ReturnType<typeof vi.fn> } };
    }).window.settingsApi.update;

    const { useCloudProvisioning } = await import('../useCloudProvisioning');
    const { result, unmount } = await renderHookAsync(() => useCloudProvisioning(baseProps()));

    await act(async () => {
      result.current.setProviderTokenInput('fly-test-token');
    });

    await act(async () => {
      await result.current.handleProvision({ vmTierId: 'heavy-work' });
    });

    expect(settingsUpdate).toHaveBeenCalled();
    const writtenSettings = settingsUpdate.mock.calls[0][0] as {
      cloudInstance?: { vmTierId?: string; provisionMode?: string; providerId?: string };
    };
    expect(writtenSettings.cloudInstance).toMatchObject({
      providerId: 'fly',
      provisionMode: 'byok',
      vmTierId: 'heavy-work',
    });
    unmount();
  });

  it('Fly BYOK without vmTierId opt: payload omits the field entirely', async () => {
    const api = installCloudApiMock({
      success: true,
      cloudUrl: 'https://rebel-cloud-test.fly.dev',
      cloudToken: 'tok',
      appName: 'rebel-cloud-test',
      machineId: 'machine-1',
      volumeId: 'vol-1',
      region: 'iad',
    });

    const { useCloudProvisioning } = await import('../useCloudProvisioning');
    const { result, unmount } = await renderHookAsync(() => useCloudProvisioning(baseProps()));

    await act(async () => {
      result.current.setProviderTokenInput('fly-test-token');
    });

    await act(async () => {
      await result.current.handleProvision();
    });

    const payload = api.provision.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({ providerId: 'fly', flyApiToken: 'fly-test-token' });
    expect(payload).not.toHaveProperty('vmTierId');
    unmount();
  });

  it('Managed (mindstone): vmTierId is NOT included in the IPC payload even if a caller passes it', async () => {
    const api = installCloudApiMock({
      success: true,
      cloudUrl: 'https://my-managed-cloud.fly.dev',
      cloudToken: 'tok',
      appName: 'rebel-managed-test',
      machineId: 'machine-1',
      volumeId: 'vol-1',
      region: 'iad',
    });

    const { useCloudProvisioning } = await import('../useCloudProvisioning');
    const { result, unmount } = await renderHookAsync(() =>
      useCloudProvisioning(baseProps({ managedCloudEnabled: true })),
    );

    await act(async () => {
      // Even passing vmTierId — it must be filtered out for managed.
      await result.current.handleProvision({ vmTierId: 'faster' });
    });

    expect(api.provision).toHaveBeenCalledOnce();
    const payload = api.provision.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('vmTierId');
    expect(payload.providerId).toBe('mindstone');
    unmount();
  });
});
