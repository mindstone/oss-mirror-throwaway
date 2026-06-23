import { useCallback, useEffect, useMemo, useRef } from 'react';

export interface UseTimeoutRefResult {
  /** Set a timeout, clearing any existing one first */
  set: (callback: () => void, delay: number) => void;
  /** Clear the current timeout if any */
  clear: () => void;
  /** Direct access to the ref (for checking if timeout is pending) */
  ref: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
}

/**
 * Hook for managing a timeout ref with automatic cleanup on unmount.
 * Replaces the common pattern of useRef + clearTimeout + cleanup useEffect.
 */
export function useTimeoutRef(): UseTimeoutRefResult {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const set = useCallback(
    (callback: () => void, delay: number) => {
      clear();
      timeoutRef.current = setTimeout(callback, delay);
    },
    [clear]
  );

  // Auto-cleanup on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, []);

  // Return a stable object reference to prevent infinite loops in dependent effects
  return useMemo(() => ({ set, clear, ref: timeoutRef }), [set, clear]);
}
