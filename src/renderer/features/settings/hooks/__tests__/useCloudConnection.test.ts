// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, flushAsync, renderHook } from '@renderer/test-utils';
import type { AppSettings, CloudInstanceConfig } from '@shared/types';
import { useCloudConnection } from '../useCloudConnection';

type HookProps = Parameters<typeof useCloudConnection>[0];

const originalCloudApi = window.cloudApi;
const originalCloudContinuityApi = window.cloudContinuityApi;
const originalSettingsApi = window.settingsApi;

function createCloudInstance(overrides: Partial<CloudInstanceConfig> = {}): CloudInstanceConfig {
  return {
    mode: 'cloud',
    cloudUrl: 'https://managed.example.com',
    cloudToken: 'token-123',
    providerId: 'mindstone',
    provisionMode: 'managed',
    lastKnownStatus: 'running',
    ...overrides,
  };
}

function createSettings(cloudInstance: CloudInstanceConfig | undefined): AppSettings {
  return {
    cloudInstance,
  } as AppSettings;
}

function createHookProps(overrides: Partial<HookProps> = {}): HookProps {
  return {
    cloudInstance: createCloudInstance(),
    updateDraft: vi.fn(),
    ...overrides,
  };
}

describe('useCloudConnection.refreshCloudStatus', () => {
  let latestSettings: AppSettings;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    latestSettings = createSettings(createCloudInstance());
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'ok',
        version: '1.0.0',
        buildCommit: 'abcdef1',
        buildDate: '2026-04-23T10:00:00.000Z',
        uptime: 42,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    Object.defineProperty(window, 'cloudApi', {
      configurable: true,
      writable: true,
      value: {
        outboxStatus: vi.fn().mockResolvedValue({ pending: 0, failed: 0 }),
        onOutboxChanged: vi.fn().mockReturnValue(() => {}),
        onContinuityChanged: vi.fn().mockReturnValue(() => {}),
        status: vi.fn().mockResolvedValue({ status: 'running' }),
        reconcile: vi.fn().mockResolvedValue({ outcome: { result: 'success' } }),
        destroy: vi.fn(),
      } as unknown as typeof window.cloudApi,
    });
    Object.defineProperty(window, 'cloudContinuityApi', {
      configurable: true,
      writable: true,
      value: {
        getAll: vi.fn().mockResolvedValue({}),
      } as unknown as typeof window.cloudContinuityApi,
    });
    Object.defineProperty(window, 'settingsApi', {
      configurable: true,
      writable: true,
      value: {
        get: vi.fn(async () => latestSettings),
        update: vi.fn().mockResolvedValue(undefined),
      } as unknown as typeof window.settingsApi,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, 'cloudApi', {
      configurable: true,
      writable: true,
      value: originalCloudApi,
    });
    Object.defineProperty(window, 'cloudContinuityApi', {
      configurable: true,
      writable: true,
      value: originalCloudContinuityApi,
    });
    Object.defineProperty(window, 'settingsApi', {
      configurable: true,
      writable: true,
      value: originalSettingsApi,
    });
  });

  it('abandons a refresh result when the user switches to a different cloud instance mid-request', async () => {
    let resolveReconcile: ((value: { outcome: { result: 'success' } }) => void) | null = null;
    const reconcileMock = vi.fn().mockImplementation(
      () => new Promise<{ outcome: { result: 'success' } }>((resolve) => { resolveReconcile = resolve; }),
    );
    window.cloudApi.reconcile = reconcileMock;

    const updateDraft = vi.fn();
    const initialCloud = createCloudInstance();
    const { result, rerender, unmount } = renderHook((props: HookProps) => useCloudConnection(props), {
      initialProps: createHookProps({
        cloudInstance: initialCloud,
        updateDraft,
      }),
    });

    await flushAsync();

    const refreshPromise = result.current.refreshCloudStatus();

    const switchedCloud = createCloudInstance({
      cloudUrl: 'https://replacement.example.com',
      cloudToken: 'replacement-token',
    });
    latestSettings = createSettings(switchedCloud);
    rerender(createHookProps({
      cloudInstance: switchedCloud,
      updateDraft,
    }));

    await act(async () => {
      resolveReconcile?.({ outcome: { result: 'success' } });
      await refreshPromise;
    });

    await expect(refreshPromise).resolves.toEqual({
      success: false,
      skipped: true,
    });
    expect(window.settingsApi.update).not.toHaveBeenCalled();
    expect(updateDraft).not.toHaveBeenCalled();

    unmount();
  });
});
