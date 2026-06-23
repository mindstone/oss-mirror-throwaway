// @vitest-environment happy-dom

/**
 * Footprint-related behaviour of `useCloudProvisioning`.
 *
 * Verifies the Stage 3 contract:
 *   - Hook calls `window.cloudApi.measureFootprint()` on mount.
 *   - `measured_nonzero` → `volumeSizeGb` auto-derived via `recommendVolumeGb`.
 *   - `measured_zero`    → `volumeSizeGb = 10` ("starting at 10 GB" copy).
 *   - `unknown_partial`  → `volumeSizeGb = 15` (auto-default, no dialog).
 *   - IPC failure        → treated as `unknown_partial(mount_error)` with
 *                          auto-default (no dialog).
 *
 * See planning doc:
 *   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
 *   (Stage 3 — Hook changes in useCloudProvisioning)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import type { AppSettings, CloudInstanceConfig } from '@shared/types';

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

  // Flush the useEffect that fires measureFootprint/discoverInstances.
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

// ---------------------------------------------------------------------------
// window.cloudApi mock — only the methods the hook calls on mount
// ---------------------------------------------------------------------------

interface CloudApiMock {
  measureFootprint: ReturnType<typeof vi.fn>;
  discoverInstances: ReturnType<typeof vi.fn>;
  doOauthStatus: ReturnType<typeof vi.fn>;
  checkUpdate: ReturnType<typeof vi.fn>;
}

function installCloudApiMock(measureResult: unknown, shouldRejectMeasure = false): CloudApiMock {
  const measureFootprint = shouldRejectMeasure
    ? vi.fn().mockRejectedValue(measureResult)
    : vi.fn().mockResolvedValue(measureResult);

  const api: CloudApiMock = {
    measureFootprint,
    discoverInstances: vi.fn().mockResolvedValue({
      managed: { exists: false },
      byok: { exists: false, healthy: false },
      conflict: false,
      activeInSettings: 'none',
    }),
    doOauthStatus: vi.fn().mockResolvedValue({ connected: false }),
    checkUpdate: vi.fn().mockResolvedValue({ success: true, updateAvailable: false, rateLimited: false }),
  };

  // Attach to window — the hook reads from window.cloudApi.
  const g = globalThis as unknown as {
    window?: {
      cloudApi?: unknown;
      settingsApi?: unknown;
    };
  };
  g.window = g.window ?? {};
  g.window.cloudApi = api;
  g.window.settingsApi = { update: vi.fn().mockResolvedValue({}) };

  return api;
}

function baseProps(overrides?: {
  cloudInstance?: CloudInstanceConfig;
  isFlyByok?: boolean;
}) {
  return {
    draftSettings: {
      managedCloudEnabled: false,
    } as AppSettings,
    cloudInstance: overrides?.cloudInstance,
    updateDraft: vi.fn(),
    isConnected: false,
    isFlyByok: overrides?.isFlyByok ?? false,
    isAutoProvisioned: false,
    isManaged: false,
    cloudHealth: null,
    setCloudHealth: vi.fn(),
  } as const;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Silence the console.warn fallback path so test output stays readable.
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* noop */ });
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('useCloudProvisioning — footprint measurement on mount', () => {
  it('calls cloudApi.measureFootprint() once on mount', async () => {
    const api = installCloudApiMock({
      kind: 'measured_zero',
      totalBytes: 0,
      workspaceBytes: 0,
      appDataBytes: 0,
      durationMs: 3,
    });

    const { useCloudProvisioning } = await import('../useCloudProvisioning');
    const { unmount } = await renderHookAsync(() => useCloudProvisioning(baseProps()));

    expect(api.measureFootprint).toHaveBeenCalledOnce();
    unmount();
  });

  it('measured_nonzero → auto-sets volumeSizeGb via recommendVolumeGb', async () => {
    const GB = 1024 ** 3;
    installCloudApiMock({
      kind: 'measured_nonzero',
      totalBytes: 4 * GB, // recommend → 15
      workspaceBytes: 3.9 * GB,
      appDataBytes: 0.1 * GB,
      durationMs: 42,
    });

    const { useCloudProvisioning } = await import('../useCloudProvisioning');
    const { result, unmount } = await renderHookAsync(() => useCloudProvisioning(baseProps()));

    expect(result.current.footprint?.kind).toBe('measured_nonzero');
    expect(result.current.volumeSizeGb).toBe(15);
    expect(result.current.showUnknownPartialDialog).toBe(false);
    expect(result.current.footprintLoading).toBe(false);
    unmount();
  });

  it('measured_nonzero (40 GB) → recommends 120 GB', async () => {
    const GB = 1024 ** 3;
    installCloudApiMock({
      kind: 'measured_nonzero',
      totalBytes: 40 * GB,
      workspaceBytes: 35 * GB,
      appDataBytes: 5 * GB,
      durationMs: 500,
    });

    const { useCloudProvisioning } = await import('../useCloudProvisioning');
    const { result, unmount } = await renderHookAsync(() => useCloudProvisioning(baseProps()));

    expect(result.current.volumeSizeGb).toBe(120);
    unmount();
  });

  it('measured_zero → sets volumeSizeGb = 10 ("starting at 10 GB" copy)', async () => {
    installCloudApiMock({
      kind: 'measured_zero',
      totalBytes: 0,
      workspaceBytes: 0,
      appDataBytes: 0,
      durationMs: 5,
    });

    const { useCloudProvisioning } = await import('../useCloudProvisioning');
    const { result, unmount } = await renderHookAsync(() => useCloudProvisioning(baseProps()));

    expect(result.current.footprint?.kind).toBe('measured_zero');
    expect(result.current.volumeSizeGb).toBe(10);
    expect(result.current.showUnknownPartialDialog).toBe(false);
    unmount();
  });

  it('unknown_partial → auto-defaults volumeSizeGb to 15 (no dialog)', async () => {
    installCloudApiMock({
      kind: 'unknown_partial',
      partialBytes: 500_000_000,
      reason: 'permission',
      durationMs: 80,
    });

    const { useCloudProvisioning } = await import('../useCloudProvisioning');
    const { result, unmount } = await renderHookAsync(() => useCloudProvisioning(baseProps()));

    expect(result.current.footprint?.kind).toBe('unknown_partial');
    expect(result.current.volumeSizeGb).toBe(15);
    expect(result.current.showUnknownPartialDialog).toBe(false);
    unmount();
  });

  it('IPC failure → auto-defaults volumeSizeGb to 15 (no dialog)', async () => {
    installCloudApiMock(new Error('IPC broken'), true);

    const { useCloudProvisioning } = await import('../useCloudProvisioning');
    const { result, unmount } = await renderHookAsync(() => useCloudProvisioning(baseProps()));

    expect(result.current.footprint?.kind).toBe('unknown_partial');
    if (result.current.footprint?.kind === 'unknown_partial') {
      expect(result.current.footprint.reason).toBe('mount_error');
    }
    expect(result.current.volumeSizeGb).toBe(15);
    expect(result.current.showUnknownPartialDialog).toBe(false);
    unmount();
  });
});



