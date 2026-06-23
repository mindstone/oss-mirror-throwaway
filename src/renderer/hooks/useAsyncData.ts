import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseAsyncDataOptions<T> {
  fetcher: () => Promise<T>;
  enabled?: boolean;
  autoLoad?: boolean;
  initialLoading?: boolean;
}

export interface UseAsyncDataResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  hasLoaded: boolean;
  refresh: () => Promise<void>;
  /** Ref that always contains the latest data value, updated synchronously on fetch completion.
   *  Useful for reading fresh data immediately after awaiting refresh() in async callbacks. */
  dataRef: React.RefObject<T | null>;
}

/**
 * Generic hook for async data fetching with loading/error state management.
 * Provides consistent patterns for:
 * - Loading state
 * - Error handling
 * - Refresh capability
 * - Optional auto-loading
 * - Conditional fetching (enabled flag)
 */
export function useAsyncData<T>({
  fetcher,
  enabled = true,
  autoLoad = true,
  initialLoading = true,
}: UseAsyncDataOptions<T>): UseAsyncDataResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(initialLoading);
  const [error, setError] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const loadingRef = useRef(false);
  // Store the in-flight promise so callers can await an ongoing refresh
  const pendingPromiseRef = useRef<Promise<void> | null>(null);
  // Ref that's updated synchronously when data changes (for reading fresh data in async callbacks)
  const dataRef = useRef<T | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) {
      dataRef.current = null; // Clear ref synchronously to match disabled state
      setData(null);
      setError(null);
      setHasLoaded(false);
      return;
    }

    // If already loading, return the existing promise so callers can await it
    if (loadingRef.current && pendingPromiseRef.current) {
      return pendingPromiseRef.current;
    }

    loadingRef.current = true;
    setLoading(true);
    setError(null);

    const promise = (async () => {
      try {
        const result = await fetcher();
        dataRef.current = result; // Update ref synchronously before setState
        setData(result);
        setHasLoaded(true);
      } catch (err) {
        dataRef.current = null; // Clear ref synchronously to match error state
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setData(null);
      } finally {
        loadingRef.current = false;
        pendingPromiseRef.current = null;
        setLoading(false);
      }
    })();

    pendingPromiseRef.current = promise;
    return promise;
  }, [enabled, fetcher]);

  useEffect(() => {
    if (!enabled) {
      // Reset load state so re-enabling triggers a fresh auto-load.
      // Without this, hasLoaded stays true from the previous load and
      // the auto-load condition below never fires on re-enable.
      setLoading(false);
      setHasLoaded(false);
      setData(null);
      setError(null);
      dataRef.current = null;
      return;
    }
    if (autoLoad && !hasLoaded && !loadingRef.current) {
      void refresh();
    }
  }, [autoLoad, enabled, hasLoaded, refresh]);

  // Keep dataRef in sync when data changes via other means (e.g., initial value)
  dataRef.current = data;

  return {
    data,
    loading,
    error,
    hasLoaded,
    refresh,
    dataRef,
  };
}
