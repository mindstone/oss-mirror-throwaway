import { useEffect, useState, useCallback, useRef } from 'react';

export interface ProvisioningProgress {
  phase: string;
  message: string;
  progress: number;
  failedStep?: number;
}

const TERMINAL_PHASES = new Set(['complete', 'failed']);
const AUTO_CLEAR_DELAY_MS = 5_000;

/**
 * Subscribes to live provisioning progress events from the main process.
 * Auto-clears progress after a terminal phase (complete/failed) with a delay.
 * Returns current progress state and a manual reset function.
 */
export function useProvisioningProgress() {
  const [progress, setProgress] = useState<ProvisioningProgress | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reset = useCallback(() => {
    if (clearTimerRef.current) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
    setProgress(null);
  }, []);

  useEffect(() => {
    const onProgress = window.cloudApi?.onProvisioningProgress;
    if (!onProgress) return;

    const unsubscribe = onProgress((step: ProvisioningProgress) => {
      if (clearTimerRef.current) {
        clearTimeout(clearTimerRef.current);
        clearTimerRef.current = null;
      }

      setProgress(step);

      if (TERMINAL_PHASES.has(step.phase)) {
        clearTimerRef.current = setTimeout(() => {
          setProgress(null);
          clearTimerRef.current = null;
        }, AUTO_CLEAR_DELAY_MS);
      }
    });

    return () => {
      unsubscribe();
      if (clearTimerRef.current) {
        clearTimeout(clearTimerRef.current);
        clearTimerRef.current = null;
      }
    };
  }, []);

  return { progress, reset } as const;
}
