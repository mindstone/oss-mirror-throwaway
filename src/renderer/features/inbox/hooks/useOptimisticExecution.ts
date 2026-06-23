import { useState, useEffect, useCallback } from 'react';

export type ExecutionStatus = 'idle' | 'queued' | 'running';

/**
 * Bridges the gap between a user clicking "Go" and the real execution status
 * propagating back from the backend. Sets a local "starting" flag immediately
 * on click, which clears once the real status arrives or after a safety timeout.
 *
 * Also prevents double-clicks: `isActive` is true from the moment the user
 * clicks, before any IPC round-trip completes.
 */
export function useOptimisticExecution(executionStatus: ExecutionStatus) {
  const [isPending, setIsPending] = useState(false);

  useEffect(() => {
    if (executionStatus !== 'idle') {
      setIsPending(false);
    }
  }, [executionStatus]);

  useEffect(() => {
    if (!isPending) return;
    const timer = setTimeout(() => setIsPending(false), 8000);
    return () => clearTimeout(timer);
  }, [isPending]);

  const markPending = useCallback(() => setIsPending(true), []);

  const isActive = isPending || executionStatus !== 'idle';

  const statusLabel = isPending
    ? 'Starting\u2026'
    : executionStatus === 'queued'
      ? 'Queued'
      : 'Running';

  return { isPending, isActive, statusLabel, markPending };
}
