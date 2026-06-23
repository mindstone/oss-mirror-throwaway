// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '../../test-utils/hookTestHarness';
import { useIpcListeners } from '../useIpcListeners';

type PendingUpdatePayload = { paths: string[] };
type PendingUpdateHandler = (payload: PendingUpdatePayload) => void;

// Source-neutral copy: a pending update can come from a teammate, the user's own
// phone/web edit, or Rebel's own agent — provenance is unknowable, so the copy
// must NOT assert "you" or "another device". REBEL-696 false-positive follow-up.
const FORBIDDEN_ATTRIBUTION = [
  /you edited/i,
  /another device/i,
  /multiple devices/i,
  /both your devices/i,
  /on more than one device/i,
];

function installMockApis(): {
  emitPendingUpdates: (payload: PendingUpdatePayload) => void;
} {
  let pendingUpdatesHandler: PendingUpdateHandler | undefined;
  const noopUnsub = () => {};

  const makeAutoStubApi = (): Record<string, unknown> =>
    new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
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
    onWorkspacePendingUpdates: vi.fn((cb: PendingUpdateHandler) => {
      pendingUpdatesHandler = cb;
      return noopUnsub;
    }),
  };

  return {
    emitPendingUpdates: (payload) => {
      if (!pendingUpdatesHandler) throw new Error('onWorkspacePendingUpdates was not subscribed');
      act(() => pendingUpdatesHandler!(payload));
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
    openWorkspaceConflictDialog: vi.fn(),
    ...overrides,
  };
}

describe('useIpcListeners — pending-update toast copy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { api?: unknown }).api;
    delete (window as unknown as { cloudApi?: unknown }).cloudApi;
    delete (window as unknown as { miscApi?: unknown }).miscApi;
  });

  it('uses source-neutral copy that does not attribute authorship to the user/device', () => {
    const { emitPendingUpdates } = installMockApis();
    const options = buildHookOptions();

    renderHook(() => useIpcListeners(options));
    emitPendingUpdates({ paths: ['notes/plan.md'] });

    expect(options.showToast).toHaveBeenCalledTimes(1);
    const arg = (options.showToast as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      title: string;
      description: string;
    };

    for (const pattern of FORBIDDEN_ATTRIBUTION) {
      expect(arg.title).not.toMatch(pattern);
      expect(arg.description).not.toMatch(pattern);
    }
    expect(arg.description).toBe('A newer version is available from your synced workspace.');
  });

  it('re-toasts a path after an empty broadcast resets the dedup set', () => {
    const { emitPendingUpdates } = installMockApis();
    const options = buildHookOptions();

    renderHook(() => useIpcListeners(options));
    emitPendingUpdates({ paths: ['notes/plan.md'] });
    expect(options.showToast).toHaveBeenCalledTimes(1);

    // Same path again without a reset: deduped, no second toast.
    emitPendingUpdates({ paths: ['notes/plan.md'] });
    expect(options.showToast).toHaveBeenCalledTimes(1);

    // Empty broadcast resets the dedup set (mirrors the main-side broadcast
    // emitted after a stale apply clears the record).
    emitPendingUpdates({ paths: [] });

    // A later legitimately-new pending update for the same path toasts again.
    emitPendingUpdates({ paths: ['notes/plan.md'] });
    expect(options.showToast).toHaveBeenCalledTimes(2);
  });
});
