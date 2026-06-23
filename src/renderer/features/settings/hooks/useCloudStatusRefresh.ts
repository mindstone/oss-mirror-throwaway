import { useCallback, useEffect, useRef, useState } from 'react';
import type { EmitLogFn } from '@renderer/contexts/AppContext';

type CloudRefreshUpdateStatus =
  | 'idle'
  | 'checking'
  | 'up_to_date'
  | 'update_available'
  | 'applying'
  | 'restarting'
  | 'updated'
  | 'error'
  | 'rate_limited';

export const MANAGED_CLOUD_STATUS_REFRESH_MS = 45_000;
export const MANAGED_CLOUD_STATUS_REFRESH_BACKOFF_MS = 180_000;

const FAILURE_BACKOFF_THRESHOLD = 3;

interface UseCloudStatusRefreshParams {
  cloudUrl?: string;
  isConnected: boolean;
  isManaged: boolean;
  busy: boolean;
  syncInProgress: boolean;
  provisionBusy: boolean;
  switchInProgress: boolean;
  updateStatus: CloudRefreshUpdateStatus;
  refreshStatus: () => Promise<{ success: boolean; error?: string; skipped?: boolean }>;
  emitLog?: EmitLogFn;
}

export function useCloudStatusRefresh({
  cloudUrl,
  isConnected,
  isManaged,
  busy,
  syncInProgress,
  provisionBusy,
  switchInProgress,
  updateStatus,
  refreshStatus,
  emitLog,
}: UseCloudStatusRefreshParams): void {
  const [isVisible, setIsVisible] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState === 'visible',
  );
  const [failureCount, setFailureCount] = useState(0);

  const isOperationInFlight =
    busy ||
    syncInProgress ||
    provisionBusy ||
    switchInProgress ||
    updateStatus === 'checking' ||
    updateStatus === 'applying' ||
    updateStatus === 'restarting';

  const isEnabled = isConnected && isManaged && isVisible && !isOperationInFlight;
  const intervalMs =
    failureCount >= FAILURE_BACKOFF_THRESHOLD
      ? MANAGED_CLOUD_STATUS_REFRESH_BACKOFF_MS
      : MANAGED_CLOUD_STATUS_REFRESH_MS;

  const failureCountRef = useRef(0);
  const refreshInFlightRef = useRef(false);
  const refreshStatusRef = useRef(refreshStatus);
  const wasEnabledRef = useRef(isEnabled);

  const logFailure = useCallback((failCount: number, err?: string) => {
    emitLog?.({
      level: 'warn',
      message: 'Managed cloud refresh failed',
      context: {
        failCount,
        cloudUrl,
        ...(err ? { err } : {}),
      },
      timestamp: Date.now(),
    });
  }, [cloudUrl, emitLog]);

  const runRefresh = useCallback(async () => {
    if (refreshInFlightRef.current) {
      return;
    }

    refreshInFlightRef.current = true;
    try {
      const result = await refreshStatusRef.current();
      if (result.success) {
        if (failureCountRef.current !== 0) {
          failureCountRef.current = 0;
          setFailureCount(0);
        }
        return;
      }

      if (result.skipped) {
        return;
      }

      const nextFailCount = failureCountRef.current + 1;
      failureCountRef.current = nextFailCount;
      setFailureCount(nextFailCount);
      logFailure(nextFailCount, result.error);
    } catch (err) {
      const nextFailCount = failureCountRef.current + 1;
      failureCountRef.current = nextFailCount;
      setFailureCount(nextFailCount);
      logFailure(nextFailCount, err instanceof Error ? err.message : String(err));
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [logFailure]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const handleVisibilityChange = () => {
      setIsVisible(document.visibilityState === 'visible');
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    refreshStatusRef.current = refreshStatus;
  }, [refreshStatus]);

  useEffect(() => {
    const wasEnabled = wasEnabledRef.current;
    wasEnabledRef.current = isEnabled;

    if (isEnabled && !wasEnabled) {
      void runRefresh();
    }
  }, [isEnabled, runRefresh]);

  useEffect(() => {
    if (typeof window === 'undefined' || !isEnabled) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void runRefresh();
    }, intervalMs);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [intervalMs, isEnabled, runRefresh]);
}
