/**
 * Debounce utility - delays function execution until after wait period of inactivity.
 *
 * Unlike throttle, debounce only calls the function AFTER the caller stops invoking it
 * for the specified delay period. This is ideal for scenarios like:
 * - Draft sync: only save after user stops typing
 * - Search: only search after user stops typing
 *
 * Features:
 * - flush(): immediately invoke pending debounced call
 * - cancel(): cancel any pending debounced call
 *
 * Performance: No unnecessary allocations in the hot path.
 */
export function debounce<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  delay: number
): ((...args: TArgs) => void) & { flush: () => void; cancel: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: TArgs | null = null;

  const debounced = ((...args: TArgs) => {
    lastArgs = args;
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      timeoutId = null;
      if (lastArgs) {
        fn(...lastArgs);
        lastArgs = null;
      }
    }, delay);
  }) as ((...args: TArgs) => void) & { flush: () => void; cancel: () => void };

  debounced.flush = () => {
    if (timeoutId && lastArgs) {
      clearTimeout(timeoutId);
      timeoutId = null;
      fn(...lastArgs);
      lastArgs = null;
    }
  };

  debounced.cancel = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
      lastArgs = null;
    }
  };

  return debounced;
}
