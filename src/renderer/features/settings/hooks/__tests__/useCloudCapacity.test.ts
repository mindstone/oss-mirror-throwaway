// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import type { AppSettings } from '@shared/types';
import { useCloudCapacity } from '../useCloudCapacity';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HookResult<T> = {
  result: { current: T };
  rerender: () => Promise<void>;
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

  act(() => {
    root.render(React.createElement(TestComponent));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  return {
    result,
    rerender: async () => {
      act(() => {
        root.render(React.createElement(TestComponent));
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const statusOk = {
  kind: 'ok' as const,
  sizeGb: 10,
  totalBytes: 10 * 1024 ** 3,
  usedBytes: 4 * 1024 ** 3,
  availableBytes: 6 * 1024 ** 3,
  lastCheckedAt: 1000,
};

const cloudInstance: AppSettings['cloudInstance'] = {
  mode: 'cloud',
  cloudUrl: 'https://byok.fly.dev',
  cloudToken: 'cloud-token',
  providerId: 'fly',
  provisionMode: 'byok',
  flyAppName: 'app',
  flyMachineId: 'machine',
  flyVolumeId: 'volume',
};

function installCloudApiMock() {
  const api = {
    getVolumeStatus: vi.fn().mockResolvedValue(statusOk),
    resizeVolume: vi.fn().mockResolvedValue({
      success: true,
      applied: true,
      healthVerified: true,
      sizeVerified: true,
      sizeGbAfter: 15,
    }),
  };
  (globalThis as unknown as { window: { cloudApi: typeof api } }).window.cloudApi = api;
  return api;
}

const originalCloudApi = window.cloudApi;
const originalAppApi = window.api;
const originalMiscApi = window.miscApi;

function installObservabilityMocks() {
  const logEvent = vi.fn();
  const captureMessage = vi.fn().mockResolvedValue({ eventId: 'event-1' });
  (window as unknown as { api: { logEvent: typeof logEvent } }).api = { logEvent };
  (window as unknown as { miscApi: { captureMessage: typeof captureMessage } }).miscApi = { captureMessage };
  return { logEvent, captureMessage };
}

function setVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => value,
  });
}

describe('useCloudCapacity', () => {
  beforeEach(() => {
    setVisibility('visible');
    vi.spyOn(window, 'setInterval').mockImplementation(() => 1 as unknown as ReturnType<typeof window.setInterval>);
    vi.spyOn(window, 'clearInterval').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (window as unknown as { cloudApi: Window['cloudApi'] }).cloudApi = originalCloudApi;
    (window as unknown as { api: Window['api'] }).api = originalAppApi;
    (window as unknown as { miscApi: Window['miscApi'] }).miscApi = originalMiscApi;
  });

  it('polls on mount and persists cache into the draft', async () => {
    const api = installCloudApiMock();
    const updateDraft = vi.fn();

    const { result, unmount } = await renderHookAsync(() => useCloudCapacity({
      cloudInstance,
      enabled: true,
      updateDraft,
    }));

    expect(api.getVolumeStatus).toHaveBeenCalledOnce();
    expect(result.current.volume).toMatchObject({ kind: 'ok', sizeGb: 10 });
    expect(updateDraft).toHaveBeenCalledWith('cloudInstance', expect.objectContaining({
      flyVolumeSizeGb: 10,
      lastVolumeUsedBytes: statusOk.usedBytes,
      lastVolumeAvailableBytes: statusOk.availableBytes,
      lastVolumeUsageCheckedAt: 1000,
    }));
    unmount();
  });

  it('keeps pollNow stable across cloudInstance identity-only rerenders', async () => {
    const api = installCloudApiMock();
    const updateDraft = vi.fn();
    let currentCloudInstance = {
      ...cloudInstance,
      flyVolumeSizeGb: 10,
      lastVolumeUsedBytes: statusOk.usedBytes,
      lastVolumeAvailableBytes: statusOk.availableBytes,
      lastVolumeUsageCheckedAt: statusOk.lastCheckedAt,
    };

    const { rerender, unmount } = await renderHookAsync(() => useCloudCapacity({
      cloudInstance: currentCloudInstance,
      enabled: true,
      updateDraft,
    }));
    expect(api.getVolumeStatus).toHaveBeenCalledOnce();

    currentCloudInstance = { ...currentCloudInstance };
    await rerender();

    expect(api.getVolumeStatus).toHaveBeenCalledOnce();
    unmount();
  });

  it('polls when document becomes visible', async () => {
    const api = installCloudApiMock();
    const updateDraft = vi.fn();
    const { unmount } = await renderHookAsync(() => useCloudCapacity({
      cloudInstance,
      enabled: true,
      updateDraft,
    }));
    api.getVolumeStatus.mockClear();

    setVisibility('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(api.getVolumeStatus).not.toHaveBeenCalled();

    setVisibility('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(api.getVolumeStatus).toHaveBeenCalledOnce();
    unmount();
  });

  it('reschedules by polling after resize completion', async () => {
    const api = installCloudApiMock();
    const updateDraft = vi.fn();
    const { result, unmount } = await renderHookAsync(() => useCloudCapacity({
      cloudInstance,
      enabled: true,
      updateDraft,
    }));
    api.getVolumeStatus.mockClear();

    await act(async () => {
      await result.current.resize(15);
    });

    expect(api.resizeVolume).toHaveBeenCalledWith({ targetSizeGb: 15 });
    expect(api.getVolumeStatus).toHaveBeenCalledOnce();
    unmount();
  });

  it('tracks tier-change success Notice state across re-renders and clears on dismiss', async () => {
    installCloudApiMock();
    const updateDraft = vi.fn();
    const { result, rerender, unmount } = await renderHookAsync(() => useCloudCapacity({
      cloudInstance,
      enabled: true,
      updateDraft,
    }));

    act(() => {
      result.current.recordTierChangeSuccess('Faster');
    });
    expect(result.current.lastTierChangeSuccess).toEqual({ tierLabel: 'Faster' });

    await rerender();
    expect(result.current.lastTierChangeSuccess).toEqual({ tierLabel: 'Faster' });

    act(() => {
      result.current.dismissTierChangeNotice();
    });
    expect(result.current.lastTierChangeSuccess).toBeNull();
    unmount();
  });

  it('logs threshold state on poll without storage byte counts', async () => {
    installCloudApiMock();
    const { logEvent } = installObservabilityMocks();
    const updateDraft = vi.fn();

    const { unmount } = await renderHookAsync(() => useCloudCapacity({
      cloudInstance,
      enabled: true,
      updateDraft,
    }));

    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Cloud storage threshold state polled',
      context: expect.objectContaining({
        area: 'cloud-capacity',
        thresholdState: 'calm',
        sizeGb: 10,
      }),
    }));
    expect(logEvent.mock.calls[0]?.[0]?.context).not.toHaveProperty('usedBytes');
    expect(logEvent.mock.calls[0]?.[0]?.context).not.toHaveProperty('totalBytes');
    unmount();
  });

  it('clamps usedBytes greater than totalBytes and reports the divergence', async () => {
    const api = installCloudApiMock();
    api.getVolumeStatus.mockResolvedValueOnce({
      ...statusOk,
      totalBytes: 10 * 1024 ** 3,
      usedBytes: 12 * 1024 ** 3,
      availableBytes: -2 * 1024 ** 3,
    });
    const { captureMessage } = installObservabilityMocks();
    const updateDraft = vi.fn();

    const { result, unmount } = await renderHookAsync(() => useCloudCapacity({
      cloudInstance,
      enabled: true,
      updateDraft,
    }));

    expect(result.current.volume).toMatchObject({
      kind: 'ok',
      usedBytes: 10 * 1024 ** 3,
      availableBytes: 0,
    });
    expect(captureMessage).toHaveBeenCalledWith(expect.objectContaining({
      message: 'cloud-storage-usage-exceeded-total',
      context: expect.objectContaining({
        area: 'cloud-capacity',
        reason: 'storage_usage_counter_diverged',
      }),
    }));
    unmount();
  });
});
