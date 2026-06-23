import { useEffect, useRef, type DependencyList } from 'react';

/**
 * A hook that manages a setInterval with visibility awareness.
 * Switches between different rates when the document is visible vs hidden.
 *
 * Features:
 * - Runs callback at `foregroundMs` when visible, `backgroundMs` when hidden
 * - Pass `backgroundMs: null` to pause completely when hidden
 * - Runs callback immediately when transitioning from hidden → visible (catch-up)
 * - Stores callback in a ref to avoid stale closures
 * - SSR-safe: handles `typeof document === 'undefined'`
 *
 * @param callback - Function to call on each interval tick
 * @param foregroundMs - Interval in ms when document is visible
 * @param backgroundMs - Interval in ms when document is hidden, or null to pause
 * @param deps - Optional dependency array (callback is always stored in a ref)
 * @param enabled - When false, the interval is completely paused (no ticks, no listeners)
 *
 * @example
 * // Poll every 500ms visible, 1000ms hidden
 * useVisibilityAwareInterval(() => checkStatus(), 500, 1000);
 *
 * // Poll every 2s visible, pause when hidden
 * useVisibilityAwareInterval(() => fetchData(), 2000, null);
 *
 * // Conditionally enable based on surface visibility
 * useVisibilityAwareInterval(() => fetchData(), 2000, null, [], isActive);
 */
export function useVisibilityAwareInterval(
  callback: () => void,
  foregroundMs: number,
  backgroundMs: number | null,
  deps: DependencyList = [],
  enabled: boolean = true
): void {
  // Store callback in a ref to avoid stale closures
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  // Store interval ref for cleanup
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    // SSR safety check
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return;
    }

    // When disabled, tear down everything and skip setup
    if (!enabled) {
      return;
    }

    const tick = () => {
      callbackRef.current();
    };

    const clear = () => {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };

    const start = (ms: number) => {
      clear();
      intervalRef.current = window.setInterval(tick, ms);
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        // Transitioning to hidden: switch to background rate or pause
        clear();
        if (backgroundMs !== null) {
          intervalRef.current = window.setInterval(tick, backgroundMs);
        }
      } else {
        // Transitioning to visible: catch-up immediately, then restart at foreground rate
        tick();
        start(foregroundMs);
      }
    };

    // Initial setup: run immediately, then start interval based on current visibility
    tick();
    if (document.hidden) {
      if (backgroundMs !== null) {
        intervalRef.current = window.setInterval(tick, backgroundMs);
      }
      // else: stay paused (no interval)
    } else {
      start(foregroundMs);
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clear();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: custom deps parameter controls interval restarts; callback changes are captured by callbackRef
  }, [foregroundMs, backgroundMs, enabled, ...deps]);
}
