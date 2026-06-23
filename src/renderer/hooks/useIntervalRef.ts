import { useCallback, useEffect, useMemo, useRef } from 'react';

export interface UseIntervalRefResult {
  /** Set an interval, clearing any existing one first */
  set: (callback: () => void, delay: number) => void;
  /** Clear the current interval if any */
  clear: () => void;
  /** Direct access to the ref (for checking if interval is active) */
  ref: React.MutableRefObject<number | null>;
}

/**
 * A hook that manages a setInterval with automatic cleanup on unmount.
 * Similar to useTimeoutRef but for intervals.
 *
 * @example
 * const interval = useIntervalRef();
 * interval.set(() => tick(), 1000);  // Start interval
 * interval.clear();                   // Manual clear
 * // Auto-cleanup on unmount
 */
export function useIntervalRef(): UseIntervalRefResult {
  const ref = useRef<number | null>(null);

  const clear = useCallback(() => {
    if (ref.current !== null) {
      window.clearInterval(ref.current);
      ref.current = null;
    }
  }, []);

  const set = useCallback(
    (callback: () => void, delay: number) => {
      clear();
      ref.current = window.setInterval(callback, delay);
    },
    [clear]
  );

  // Auto-cleanup on unmount
  useEffect(() => {
    return () => {
      if (ref.current !== null) {
        window.clearInterval(ref.current);
      }
    };
  }, []);

  // Return a stable object reference to prevent infinite loops in dependent effects
  return useMemo(() => ({ set, clear, ref }), [set, clear]);
}
