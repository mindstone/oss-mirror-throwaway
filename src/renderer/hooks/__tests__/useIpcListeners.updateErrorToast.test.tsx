// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '../../test-utils/hookTestHarness';
import { useIpcListeners } from '../useIpcListeners';

type UpdateErrorPayload = Parameters<Window['api']['onUpdateError']>[0] extends (data: infer Payload) => void
  ? Payload
  : never;
type UpdateErrorHandler = (payload: UpdateErrorPayload) => void;

const PERMISSION_COPY =
  "Rebel can't update itself because it was installed somewhere your account can't modify. Ask IT to update Rebel for this device, or reinstall it somewhere your organization allows.";

function installMockApis(): { emitUpdateError: (payload: UpdateErrorPayload) => void } {
  let updateErrorHandler: UpdateErrorHandler | undefined;
  const noopUnsub = () => {};

  const makeAutoStubApi = (): Record<string, unknown> =>
    new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        if (prop === 'onUpdateError') {
          return vi.fn((cb: UpdateErrorHandler) => {
            updateErrorHandler = cb;
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
    emitUpdateError: (payload) => {
      if (!updateErrorHandler) throw new Error('onUpdateError was not subscribed');
      act(() => updateErrorHandler!(payload));
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

describe('useIpcListeners — update:error toast copy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { api?: unknown }).api;
    delete (window as unknown as { cloudApi?: unknown }).cloudApi;
    delete (window as unknown as { miscApi?: unknown }).miscApi;
  });

  it('shows IT remediation copy for permission-category updater errors', () => {
    const { emitUpdateError } = installMockApis();
    const options = buildHookOptions();

    renderHook(() => useIpcListeners(options));
    emitUpdateError({
      category: 'permission',
      code: 'PERMISSION',
      message: 'OSStatus -60006',
      retryable: false,
    });

    expect(options.showToast).toHaveBeenCalledWith({
      title: 'Auto-updates unavailable',
      description: PERMISSION_COPY,
      duration: 10000,
    });
    expect(options.emitLog).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ category: 'permission', code: 'PERMISSION' }),
      level: 'warn',
      message: 'Auto-update error',
    }));
  });

  it('keeps the generic update error message for non-permission payloads', () => {
    const { emitUpdateError } = installMockApis();
    const options = buildHookOptions();

    renderHook(() => useIpcListeners(options));
    emitUpdateError({
      category: 'unknown',
      code: 'UNKNOWN',
      message: 'Update feed returned unexpected metadata',
      retryable: true,
    });

    expect(options.showToast).toHaveBeenCalledWith({
      title: 'Auto-updates unavailable',
      description: 'Update feed returned unexpected metadata',
      duration: 10000,
    });
  });

  it('still shows the update error toast only once per session', () => {
    const { emitUpdateError } = installMockApis();
    const options = buildHookOptions();

    renderHook(() => useIpcListeners(options));
    emitUpdateError({
      category: 'permission',
      code: 'PERMISSION',
      message: 'OSStatus -60006',
      retryable: false,
    });
    emitUpdateError({
      category: 'unknown',
      code: 'UNKNOWN',
      message: 'Second error',
      retryable: true,
    });

    expect(options.showToast).toHaveBeenCalledTimes(1);
    expect(options.showToast).toHaveBeenCalledWith(expect.objectContaining({
      description: PERMISSION_COPY,
    }));
  });
});
