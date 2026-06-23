import { useEffect, useRef, type DependencyList } from 'react';

/**
 * Subscribe to an IPC event with automatic cleanup on unmount or when the
 * resubscribe trigger array changes.
 *
 * The third argument (`resubscribeDeps`) is NOT a React-style closure-deps array
 * — it controls re-subscription only. The handler always sees the latest closure
 * values via an internal ref (`handlerRef.current = handler`), so passing `[]`
 * is correct for the common case of "just subscribe once, but always run the
 * latest handler". Pass values here only when you need the underlying IPC
 * subscription to be torn down and re-established.
 *
 * Handles optional APIs gracefully — if `subscribe` is undefined,
 * the effect is a no-op.
 *
 * @example
 * useIpcEvent(window.api.onDemoModeChange, (data) => {
 *   setIsActive(data.active);
 * }, []);
 */
export function useIpcEvent<Args extends unknown[]>(
  subscribe: ((handler: (...args: Args) => void) => (() => void)) | undefined,
  handler: (...args: Args) => void,
  resubscribeDeps: DependencyList = [],
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const cleanup = subscribe?.((...args: Args) => handlerRef.current(...args));
    return () => cleanup?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: handler is omitted because handlerRef supplies the latest closure without resubscribing
  }, [subscribe, ...resubscribeDeps]);
}
