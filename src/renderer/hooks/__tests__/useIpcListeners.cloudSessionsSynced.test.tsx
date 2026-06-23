// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '../../test-utils/hookTestHarness';
import { useIpcListeners } from '../useIpcListeners';
import { useSessionStore } from '@renderer/features/agent-session/store/sessionStore';

type SessionsSyncedEvent = { upserted: string[]; deleted: string[] };
type SessionsSyncedHandler = (event: SessionsSyncedEvent) => void;

const ACTIVE_SESSION_ID = 'session-active';
const OTHER_SESSION_ID = 'session-other';

function emitListenerCleanup() {
  return vi.fn();
}

function installMockApis(): {
  emitSessionsSynced: (event: SessionsSyncedEvent) => void;
} {
  let sessionsSyncedHandler: SessionsSyncedHandler | undefined;
  const unsub: () => void = emitListenerCleanup();
  const noopUnsub = () => {};

  // Auto-stub any onXxx subscription / getXxx fetcher used by useIpcListeners.
  // Returning a noop cleanup keeps unrelated useEffect hooks inside the listener
  // happy without us having to enumerate every channel they touch.
  const makeAutoStubApi = (): Record<string, unknown> =>
    new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
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

  (window as unknown as { cloudApi: Record<string, unknown> }).cloudApi = {
    onSessionsSynced: vi.fn((cb: SessionsSyncedHandler) => {
      sessionsSyncedHandler = cb;
      return unsub;
    }),
    onWorkspaceConflicts: vi.fn(() => noopUnsub),
    onSessionConflict: vi.fn(() => noopUnsub),
  };

  return {
    emitSessionsSynced: (event) => {
      if (!sessionsSyncedHandler) throw new Error('onSessionsSynced was not subscribed');
      act(() => sessionsSyncedHandler!(event));
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
    setTimeSavedBySession: vi.fn(),
    setCoachingSessionIds: vi.fn(),
    setUpdateAvailable: vi.fn(),
    setIsInstallingUpdate: vi.fn(),
    setSuperMcpReady: vi.fn(),
    reloadSessionSummaries: vi.fn().mockResolvedValue(undefined),
    refreshActiveCloudSession: vi.fn().mockResolvedValue(undefined),
    onWorkspaceConflictsDetected: vi.fn(),
    openWorkspaceConflictDialog: vi.fn(),
    ...overrides,
  };
}

describe('useIpcListeners — cloud:sessions-synced refresh of active session view', () => {
  beforeEach(() => {
    useSessionStore.setState({ currentSessionId: ACTIVE_SESSION_ID });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { api?: unknown }).api;
    delete (window as unknown as { cloudApi?: unknown }).cloudApi;
  });

  it('refreshes the active session when it is among the upserted ids', () => {
    const { emitSessionsSynced } = installMockApis();
    const options = buildHookOptions();
    renderHook(() => useIpcListeners(options));

    emitSessionsSynced({ upserted: [OTHER_SESSION_ID, ACTIVE_SESSION_ID], deleted: [] });

    expect(options.reloadSessionSummaries).toHaveBeenCalledTimes(1);
    expect(options.refreshActiveCloudSession).toHaveBeenCalledTimes(1);
    expect(options.refreshActiveCloudSession).toHaveBeenCalledWith(ACTIVE_SESSION_ID);
  });

  it('does not refresh the active session view when it is not among the upserted ids', () => {
    const { emitSessionsSynced } = installMockApis();
    const options = buildHookOptions();
    renderHook(() => useIpcListeners(options));

    emitSessionsSynced({ upserted: [OTHER_SESSION_ID], deleted: [] });

    expect(options.reloadSessionSummaries).toHaveBeenCalledTimes(1);
    expect(options.refreshActiveCloudSession).not.toHaveBeenCalled();
  });

  it('does nothing when upserted and deleted are both empty', () => {
    const { emitSessionsSynced } = installMockApis();
    const options = buildHookOptions();
    renderHook(() => useIpcListeners(options));

    emitSessionsSynced({ upserted: [], deleted: [] });

    expect(options.reloadSessionSummaries).not.toHaveBeenCalled();
    expect(options.refreshActiveCloudSession).not.toHaveBeenCalled();
  });

  it('still reloads summaries when refreshActiveCloudSession is not provided (back-compat)', () => {
    const { emitSessionsSynced } = installMockApis();
    const options = buildHookOptions({ refreshActiveCloudSession: undefined });
    renderHook(() => useIpcListeners(options));

    emitSessionsSynced({ upserted: [ACTIVE_SESSION_ID], deleted: [] });

    expect(options.reloadSessionSummaries).toHaveBeenCalledTimes(1);
  });

  it('does not refresh when there is no current session', () => {
    useSessionStore.setState({ currentSessionId: '' });
    const { emitSessionsSynced } = installMockApis();
    const options = buildHookOptions();
    renderHook(() => useIpcListeners(options));

    emitSessionsSynced({ upserted: [OTHER_SESSION_ID, ACTIVE_SESSION_ID], deleted: [] });

    expect(options.refreshActiveCloudSession).not.toHaveBeenCalled();
  });
});
