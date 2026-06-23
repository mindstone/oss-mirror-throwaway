// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '../../test-utils/hookTestHarness';
import { useIpcListeners } from '../useIpcListeners';

type LibraryChangedEvent = { affectsTree: boolean };
type LibraryChangedHandler = (event: LibraryChangedEvent) => void;

function installMockApis(): {
  emitLibraryChanged: (event: LibraryChangedEvent) => void;
} {
  let libraryChangedHandler: LibraryChangedHandler | undefined;
  const noopUnsub = () => {};

  const apiTarget: Record<string, unknown> = {
    onLibraryChanged: vi.fn((cb: LibraryChangedHandler) => {
      libraryChangedHandler = cb;
      return noopUnsub;
    }),
  };

  const apiProxy = new Proxy(apiTarget, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      if (typeof prop !== 'string') return undefined;
      if (prop.startsWith('on')) return vi.fn(() => noopUnsub);
      if (prop.startsWith('get')) return vi.fn().mockResolvedValue({});
      return vi.fn();
    },
  });

  (window as unknown as { api: Record<string, unknown> }).api = apiProxy;
  (window as unknown as { cloudApi: Record<string, unknown> }).cloudApi = new Proxy(
    {} as Record<string, unknown>,
    {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        if (prop.startsWith('on')) return vi.fn(() => noopUnsub);
        return vi.fn();
      },
    },
  );

  return {
    emitLibraryChanged: (event) => {
      if (!libraryChangedHandler) throw new Error('onLibraryChanged was not subscribed');
      act(() => libraryChangedHandler!(event));
    },
  };
}

function buildHookOptions(refreshLibraryIndex: () => Promise<void>) {
  return {
    emitLog: vi.fn(),
    showToast: vi.fn(),
    refreshLibraryIndex,
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
  };
}

/**
 * Build a refresh fn that resolves after `durationMs` of fake time. Tracks how
 * many times it was called.
 */
function makeRefresh(durationMs: number) {
  const calls: { startedAt: number }[] = [];
  let nextDuration = durationMs;
  const fn = vi.fn(async () => {
    const startedAt = Date.now();
    calls.push({ startedAt });
    const localDuration = nextDuration;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, localDuration);
    });
  });
  return {
    fn,
    calls,
    setNextDuration: (ms: number) => {
      nextDuration = ms;
    },
  };
}

describe('useIpcListeners — adaptive library-refresh cooldown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (window as unknown as { api?: unknown }).api;
    delete (window as unknown as { cloudApi?: unknown }).cloudApi;
  });

  it('uses the 500ms base debounce on the first event after a quiet period', async () => {
    const { emitLibraryChanged } = installMockApis();
    const refresh = makeRefresh(50);
    const options = buildHookOptions(refresh.fn);
    renderHook(() => useIpcListeners(options));

    emitLibraryChanged({ affectsTree: true });

    await vi.advanceTimersByTimeAsync(499);
    expect(refresh.fn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    expect(refresh.fn).toHaveBeenCalledTimes(1);
  });

  it('ignores events when affectsTree is false', async () => {
    const { emitLibraryChanged } = installMockApis();
    const refresh = makeRefresh(50);
    const options = buildHookOptions(refresh.fn);
    renderHook(() => useIpcListeners(options));

    emitLibraryChanged({ affectsTree: false });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(refresh.fn).not.toHaveBeenCalled();
  });

  it('does not start a second walk while one is in flight', async () => {
    const { emitLibraryChanged } = installMockApis();
    const refresh = makeRefresh(10_000); // slow walk
    const options = buildHookOptions(refresh.fn);
    renderHook(() => useIpcListeners(options));

    // First event -> walk starts at +500
    emitLibraryChanged({ affectsTree: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(refresh.fn).toHaveBeenCalledTimes(1);

    // While the walk is still running, fire many more events. The cooldown
    // logic should never schedule a second concurrent walk.
    for (let i = 0; i < 20; i++) {
      emitLibraryChanged({ affectsTree: true });
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(refresh.fn).toHaveBeenCalledTimes(1);
  });

  it('extends cooldown to the duration of the last walk during sustained activity', async () => {
    const { emitLibraryChanged } = installMockApis();
    const refresh = makeRefresh(10_000); // each walk takes 10s
    const options = buildHookOptions(refresh.fn);
    renderHook(() => useIpcListeners(options));

    // Trigger walk #1, wait for it to complete
    emitLibraryChanged({ affectsTree: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(refresh.fn).toHaveBeenCalledTimes(1);
    const walkOneStartedAt = refresh.calls[0].startedAt;
    await vi.advanceTimersByTimeAsync(10_000);

    // Drive a continuous storm. With base debounce alone, walk #2 would start
    // ~500ms after each event. With adaptive cooldown >=10s, walk #2 should
    // wait until at least 10s have elapsed since walk #1 started.
    for (let i = 0; i < 30; i++) {
      emitLibraryChanged({ affectsTree: true });
      await vi.advanceTimersByTimeAsync(300);
    }
    // Allow any deferred timer to fire after the storm settles.
    await vi.advanceTimersByTimeAsync(2_000);

    expect(refresh.fn).toHaveBeenCalledTimes(2);
    const walkTwoStartedAt = refresh.calls[1].startedAt;
    expect(walkTwoStartedAt - walkOneStartedAt).toBeGreaterThanOrEqual(10_000);
  });

  it('caps cooldown at 60 seconds even when last walk took longer', async () => {
    const { emitLibraryChanged } = installMockApis();
    const refresh = makeRefresh(120_000); // pathological 2-minute walk
    const options = buildHookOptions(refresh.fn);
    renderHook(() => useIpcListeners(options));

    // Walk #1 runs for 120s. Without the cap, cooldown would equal lastDuration
    // (= 120s), meaning the user couldn't get walk #2 for two full minutes.
    emitLibraryChanged({ affectsTree: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(refresh.fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000); // walk #1 completes
    const walkOneEndedAt = Date.now();

    // A single coalesced emit (representing what the broadcaster forwards
    // after its own debounce) should schedule walk #2 within 60s of walk #1's
    // end thanks to the cap.
    emitLibraryChanged({ affectsTree: true });
    await vi.advanceTimersByTimeAsync(60_500);

    expect(refresh.fn).toHaveBeenCalledTimes(2);
    const walkTwoStartedAt = refresh.calls[1].startedAt;
    expect(walkTwoStartedAt - walkOneEndedAt).toBeLessThanOrEqual(60_500);
  });

  it('shrinks cooldown when walks become fast again (auto-recovery)', async () => {
    const { emitLibraryChanged } = installMockApis();
    const refresh = makeRefresh(10_000); // first walk slow
    const options = buildHookOptions(refresh.fn);
    renderHook(() => useIpcListeners(options));

    // Walk #1: slow (10s)
    emitLibraryChanged({ affectsTree: true });
    await vi.advanceTimersByTimeAsync(500 + 10_000);
    expect(refresh.fn).toHaveBeenCalledTimes(1);

    // Walk #2: fast (100ms) — sustained activity is over, the next walk
    // measures fresh and resets the cooldown.
    refresh.setNextDuration(100);
    emitLibraryChanged({ affectsTree: true });
    await vi.advanceTimersByTimeAsync(10_000); // crosses the 10s cooldown
    await vi.advanceTimersByTimeAsync(200); // walk #2 finishes (100ms)
    expect(refresh.fn).toHaveBeenCalledTimes(2);
    const walkTwoEndedAt = refresh.calls[1].startedAt + 100;

    // After walk #2, lastDuration is ~100ms so cooldown collapses to the 500ms
    // base. A fresh event should schedule walk #3 near the base debounce, not
    // the previous 10s cooldown.
    refresh.setNextDuration(100);
    emitLibraryChanged({ affectsTree: true });
    await vi.advanceTimersByTimeAsync(700); // 500ms base + slack
    expect(refresh.fn).toHaveBeenCalledTimes(3);
    const walkThreeStartedAt = refresh.calls[2].startedAt;
    expect(walkThreeStartedAt - walkTwoEndedAt).toBeLessThan(2_000);
  });
});
