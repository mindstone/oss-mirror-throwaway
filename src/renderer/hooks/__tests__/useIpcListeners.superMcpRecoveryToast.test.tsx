// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '../../test-utils/hookTestHarness';
import { useIpcListeners } from '../useIpcListeners';

type StartupFailedPayload = Parameters<Window['api']['onSuperMcpStartupFailed']>[0] extends (
  data: infer Payload,
) => void
  ? Payload
  : never;
type StartupFailedHandler = (payload: StartupFailedPayload) => void;

type SuperMcpReadyPayload = Parameters<Window['api']['onSuperMcpReady']>[0] extends (
  data: infer Payload,
) => void
  ? Payload
  : never;
type SuperMcpReadyHandler = (payload: SuperMcpReadyPayload) => void;

function installMockApis(): {
  emitStartupFailed: (payload: StartupFailedPayload) => void;
  emitSuperMcpReady: (payload: SuperMcpReadyPayload) => void;
} {
  let startupFailedHandler: StartupFailedHandler | undefined;
  let superMcpReadyHandler: SuperMcpReadyHandler | undefined;
  const noopUnsub = () => {};

  const makeAutoStubApi = (): Record<string, unknown> =>
    new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        if (prop === 'onSuperMcpStartupFailed') {
          return vi.fn((cb: StartupFailedHandler) => {
            startupFailedHandler = cb;
            return noopUnsub;
          });
        }
        if (prop === 'onSuperMcpReady') {
          return vi.fn((cb: SuperMcpReadyHandler) => {
            superMcpReadyHandler = cb;
            return noopUnsub;
          });
        }
        if (prop === 'getTimeSavedBySession') {
          return vi.fn().mockResolvedValue({});
        }
        if (prop === 'getCoachingSessions') {
          return vi.fn().mockResolvedValue({ sessionIds: [] });
        }
        if (prop.startsWith('on')) {
          return vi.fn(() => noopUnsub);
        }
        if (prop.startsWith('get')) {
          return vi.fn().mockResolvedValue({});
        }
        return vi.fn();
      },
    });

  (window as unknown as { api: Record<string, unknown> }).api = makeAutoStubApi();
  (window as unknown as { miscApi: Record<string, unknown> }).miscApi = {
    getPendingDownloaded: vi.fn().mockResolvedValue({ pending: null }),
  };
  (window as unknown as { cloudApi: Record<string, unknown> }).cloudApi = {
    onOutboxChanged: vi.fn(() => noopUnsub),
    onSessionConflict: vi.fn(() => noopUnsub),
    onSessionsSynced: vi.fn(() => noopUnsub),
    onWorkspaceConflicts: vi.fn(() => noopUnsub),
  };

  return {
    emitStartupFailed: (payload) => {
      if (!startupFailedHandler) throw new Error('onSuperMcpStartupFailed was not subscribed');
      act(() => startupFailedHandler!(payload));
    },
    emitSuperMcpReady: (payload) => {
      if (!superMcpReadyHandler) throw new Error('onSuperMcpReady was not subscribed');
      act(() => superMcpReadyHandler!(payload));
    },
  };
}

function buildHookOptions(overrides: Partial<Parameters<typeof useIpcListeners>[0]> = {}) {
  return {
    emitLog: vi.fn(),
    showToast: vi.fn(),
    refreshLibraryIndex: vi.fn().mockResolvedValue(undefined),
    refreshMcpSummary: vi.fn().mockResolvedValue(undefined),
    refreshSettings: vi.fn().mockResolvedValue(undefined),
    setCoachingSessionIds: vi.fn(),
    setIsInstallingUpdate: vi.fn(),
    setSuperMcpReady: vi.fn(),
    setTimeSavedBySession: vi.fn(),
    setUpdateAvailable: vi.fn(),
    ...overrides,
  };
}

describe('useIpcListeners — Super-MCP recovery toast', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { api?: unknown }).api;
    delete (window as unknown as { cloudApi?: unknown }).cloudApi;
    delete (window as unknown as { miscApi?: unknown }).miscApi;
  });

  it('shows one recovery toast after a surfaced startup failure and recovered ready event', () => {
    const { emitStartupFailed, emitSuperMcpReady } = installMockApis();
    const options = buildHookOptions();
    const showToast = options.showToast as ReturnType<typeof vi.fn>;

    renderHook(() => useIpcListeners(options));
    emitStartupFailed({ failureCategory: 'unknown', attempts: 4 });
    showToast.mockClear();

    emitSuperMcpReady({ success: true, port: 3200, recovered: true });

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith({ title: 'Tools are back online.' });
  });

  it('does not show a recovery toast when ready recovered arrives without a prior failure', () => {
    const { emitSuperMcpReady } = installMockApis();
    const options = buildHookOptions();
    const showToast = options.showToast as ReturnType<typeof vi.fn>;

    renderHook(() => useIpcListeners(options));
    emitSuperMcpReady({ success: true, port: 3200, recovered: true });

    expect(showToast).not.toHaveBeenCalled();
  });

  it('does not repeat the recovery toast for the same failure episode', () => {
    const { emitStartupFailed, emitSuperMcpReady } = installMockApis();
    const options = buildHookOptions();
    const showToast = options.showToast as ReturnType<typeof vi.fn>;

    renderHook(() => useIpcListeners(options));
    emitStartupFailed({ failureCategory: 'unknown', attempts: 4 });
    showToast.mockClear();

    emitSuperMcpReady({ success: true, port: 3200, recovered: true });
    emitSuperMcpReady({ success: true, port: 3200, recovered: true });

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith({ title: 'Tools are back online.' });
  });
});
