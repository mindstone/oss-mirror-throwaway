// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '../../test-utils/hookTestHarness';
import {
  useDebouncedOnlineStatus,
  SUSTAINED_OFFLINE_MS,
  LONG_SUSTAINED_OFFLINE_MS,
} from '../useDebouncedOnlineStatus';

/**
 * Tests the asymmetric-debounce contract that is the whole point of the hook:
 *  - a brief blip (< sustained threshold) shows NOTHING;
 *  - a sustained outage shows offline (then long-sustained later);
 *  - reconnect clears INSTANTLY (no debounce on the clear);
 *  - timers freeze while the window is hidden.
 */

function setOnline(value: boolean) {
  // navigator.onLine is a getter in happy-dom — override via defineProperty.
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    get: () => value,
  });
}

function fireOnlineEvent(value: boolean) {
  // useOnlineStatus listens for the browser online/offline events.
  window.dispatchEvent(new Event(value ? 'online' : 'offline'));
}

function setVisibility(state: 'visible' | 'hidden') {
  act(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => state,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('useDebouncedOnlineStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setOnline(true);
    setVisibility('visible');
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    setOnline(true);
  });

  it('reports online at rest', () => {
    const { result } = renderHook(() => useDebouncedOnlineStatus());
    expect(result.current).toEqual({
      isOnline: true,
      isSustainedOffline: false,
      isLongSustainedOffline: false,
    });
  });

  it('ignores a brief blip shorter than the sustained threshold', () => {
    const { result } = renderHook(() => useDebouncedOnlineStatus());

    // Drop offline for less than the sustained window, then recover.
    act(() => {
      setOnline(false);
      fireOnlineEvent(false);
    });
    advance(SUSTAINED_OFFLINE_MS - 1_000);
    // A blip must be invisible the entire time it is below threshold.
    expect(result.current.isSustainedOffline).toBe(false);
    expect(result.current.isOnline).toBe(true);

    act(() => {
      setOnline(true);
      fireOnlineEvent(true);
    });
    // Recovered before the threshold — never showed anything.
    expect(result.current).toEqual({
      isOnline: true,
      isSustainedOffline: false,
      isLongSustainedOffline: false,
    });
  });

  it('shows sustained-offline only after the sustained threshold', () => {
    const { result } = renderHook(() => useDebouncedOnlineStatus());

    act(() => {
      setOnline(false);
      fireOnlineEvent(false);
    });

    advance(SUSTAINED_OFFLINE_MS - 100);
    expect(result.current.isSustainedOffline).toBe(false);

    advance(200);
    expect(result.current.isSustainedOffline).toBe(true);
    expect(result.current.isOnline).toBe(false);
    expect(result.current.isLongSustainedOffline).toBe(false);
  });

  it('escalates to long-sustained after the longer threshold', () => {
    const { result } = renderHook(() => useDebouncedOnlineStatus());

    act(() => {
      setOnline(false);
      fireOnlineEvent(false);
    });

    advance(SUSTAINED_OFFLINE_MS + 100);
    expect(result.current.isSustainedOffline).toBe(true);
    expect(result.current.isLongSustainedOffline).toBe(false);

    advance(LONG_SUSTAINED_OFFLINE_MS - SUSTAINED_OFFLINE_MS);
    expect(result.current.isLongSustainedOffline).toBe(true);
    expect(result.current.isSustainedOffline).toBe(true);
  });

  it('clears INSTANTLY on reconnect with no debounce', () => {
    const { result } = renderHook(() => useDebouncedOnlineStatus());

    act(() => {
      setOnline(false);
      fireOnlineEvent(false);
    });
    advance(LONG_SUSTAINED_OFFLINE_MS + 1_000);
    expect(result.current.isLongSustainedOffline).toBe(true);

    // Reconnect: the state must flip to online in the same tick, no advance.
    act(() => {
      setOnline(true);
      fireOnlineEvent(true);
    });
    expect(result.current).toEqual({
      isOnline: true,
      isSustainedOffline: false,
      isLongSustainedOffline: false,
    });
  });

  it('does not advance offline timers while the window is hidden', () => {
    const { result } = renderHook(() => useDebouncedOnlineStatus());

    act(() => {
      setOnline(false);
      fireOnlineEvent(false);
    });
    // Hide the window almost immediately, before the sustained threshold.
    advance(1_000);
    setVisibility('hidden');

    // Time passes well beyond the threshold while hidden — must NOT alarm.
    advance(LONG_SUSTAINED_OFFLINE_MS + 5_000);
    expect(result.current.isSustainedOffline).toBe(false);

    // Becoming visible again restarts the debounce from now (still offline).
    setVisibility('visible');
    advance(SUSTAINED_OFFLINE_MS - 100);
    expect(result.current.isSustainedOffline).toBe(false);
    advance(200);
    expect(result.current.isSustainedOffline).toBe(true);
  });

  it('clears on reconnect that happened while hidden, on re-show', () => {
    const { result } = renderHook(() => useDebouncedOnlineStatus());

    act(() => {
      setOnline(false);
      fireOnlineEvent(false);
    });
    advance(SUSTAINED_OFFLINE_MS + 100);
    expect(result.current.isSustainedOffline).toBe(true);

    // Hide, reconnect while hidden (the browser fires an online event even when
    // the tab is hidden), then re-show. The signal must already be cleared.
    setVisibility('hidden');
    act(() => {
      setOnline(true);
      fireOnlineEvent(true);
    });
    setVisibility('visible');

    expect(result.current.isOnline).toBe(true);
    expect(result.current.isSustainedOffline).toBe(false);
  });

  it('honours overridden thresholds', () => {
    const { result } = renderHook(() =>
      useDebouncedOnlineStatus({ sustainedMs: 1_000, longSustainedMs: 3_000 }),
    );

    act(() => {
      setOnline(false);
      fireOnlineEvent(false);
    });
    advance(1_100);
    expect(result.current.isSustainedOffline).toBe(true);
    expect(result.current.isLongSustainedOffline).toBe(false);
    advance(2_000);
    expect(result.current.isLongSustainedOffline).toBe(true);
  });

  it('clears its timers and listeners on unmount — no stale timer fires after', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { result, unmount } = renderHook(() => useDebouncedOnlineStatus());

    // Baseline timer count while online (any timers here are React-internal, not
    // ours — the hook arms nothing until it goes offline).
    const onlineTimerCount = vi.getTimerCount();

    // Go offline so both the sustained + long timers are pending.
    act(() => {
      setOnline(false);
      fireOnlineEvent(false);
    });
    // Our two timers are now pending on top of any React-internal ones.
    expect(vi.getTimerCount()).toBe(onlineTimerCount + 2);

    unmount();

    // The effect cleanup cleared OUR two timers (back to the online baseline)...
    expect(vi.getTimerCount()).toBe(onlineTimerCount);
    // ...and removed the visibilitychange listener it registered.
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));

    const stateBeforeAdvance = result.current;
    // Advancing past every threshold must NOT throw (no setState-after-unmount)
    // and must not flip the last-rendered state.
    expect(() => {
      vi.advanceTimersByTime(LONG_SUSTAINED_OFFLINE_MS + 5_000);
    }).not.toThrow();
    expect(result.current).toBe(stateBeforeAdvance);

    removeSpy.mockRestore();
  });

  it('handles rapid offline -> online -> offline flapping without a stale timer firing', () => {
    const { result } = renderHook(() => useDebouncedOnlineStatus());

    // First offline window starts, then we recover before the threshold.
    act(() => {
      setOnline(false);
      fireOnlineEvent(false);
    });
    advance(SUSTAINED_OFFLINE_MS - 2_000);
    act(() => {
      setOnline(true);
      fireOnlineEvent(true);
    });
    // Reconnect must have cleared the first offline window's timers.
    expect(vi.getTimerCount()).toBe(0);
    expect(result.current.isSustainedOffline).toBe(false);

    // Drop again immediately (a second, distinct offline window).
    act(() => {
      setOnline(false);
      fireOnlineEvent(false);
    });

    // Advancing to just before the threshold (measured from the SECOND drop):
    // the stale first-window timer must not fire and flip us offline early.
    advance(SUSTAINED_OFFLINE_MS - 100);
    expect(result.current.isSustainedOffline).toBe(false);

    // Crossing the threshold from the second drop alarms exactly once.
    advance(200);
    expect(result.current.isSustainedOffline).toBe(true);
  });
});
