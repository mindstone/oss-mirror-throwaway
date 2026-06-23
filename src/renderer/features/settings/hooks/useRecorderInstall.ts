import { useCallback, useEffect, useRef, useState } from 'react';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

/**
 * Drives the one-click meeting-recorder install flow for the Meetings settings
 * dialog: idle → installing → success (restart prompt) / failure (retry + copy).
 *
 * The actual install runs in the main process (`meeting-bot:install-recorder`),
 * so this hook owns only the UI phase + the messages the main process returns.
 * Cancellation goes through a dedicated main-owned channel — a renderer-held
 * AbortController cannot reach an `invoke()`. If the user navigates away and
 * back mid-install, we reconnect to the running install via
 * `is-recorder-installing` rather than stranding the UI in idle.
 */

export type RecorderInstallPhase = 'idle' | 'installing' | 'success' | 'failure';

const RECONNECT_POLL_MS = 1500;
const UNEXPECTED_ERROR =
  'Something went wrong installing the recorder. You can try again, or run the command below yourself.';

export interface UseRecorderInstall {
  phase: RecorderInstallPhase;
  /** Friendly failure message (from the main process), or null. */
  errorMessage: string | null;
  /** True when the failure is "Recall has no build for this OS" rather than a fixable error. */
  unsupportedPlatform: boolean;
  install: () => void;
  cancel: () => void;
  restart: () => void;
  reset: () => void;
}

export function useRecorderInstall(onInstalled?: () => void): UseRecorderInstall {
  const [phase, setPhase] = useState<RecorderInstallPhase>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [unsupportedPlatform, setUnsupportedPlatform] = useState(false);

  const mountedRef = useRef(true);
  const pollRef = useRef<number | null>(null);
  // Set when the user cancels, so the reconnect poll (which has no result object)
  // maps the next "not installing" tick to idle rather than a spurious failure.
  const cancelRequestedRef = useRef(false);
  const onInstalledRef = useRef(onInstalled);
  onInstalledRef.current = onInstalled;

  const clearPoll = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const applyResult = useCallback(
    (result: {
      success: boolean;
      unsupportedPlatform?: boolean;
      cancelled?: boolean;
      error?: string;
    }) => {
      if (!mountedRef.current) return;
      if (result.success) {
        setPhase('success');
        onInstalledRef.current?.();
        return;
      }
      if (result.cancelled) {
        setPhase('idle');
        return;
      }
      setUnsupportedPlatform(Boolean(result.unsupportedPlatform));
      setErrorMessage(result.error ?? UNEXPECTED_ERROR);
      setPhase('failure');
    },
    [],
  );

  const install = useCallback(() => {
    cancelRequestedRef.current = false;
    setErrorMessage(null);
    setUnsupportedPlatform(false);
    setPhase('installing');
    void window.meetingBotApi
      .installRecorder()
      .then(applyResult)
      .catch(() => {
        if (!mountedRef.current) return;
        setErrorMessage(UNEXPECTED_ERROR);
        setUnsupportedPlatform(false);
        setPhase('failure');
      });
  }, [applyResult]);

  const cancel = useCallback(() => {
    // Fire-and-forget: the in-flight install() promise settles with a cancelled
    // result, which applyResult maps back to idle. The ref covers the reconnect
    // path, which polls state rather than awaiting the result object.
    cancelRequestedRef.current = true;
    void window.meetingBotApi.cancelRecorderInstall().catch((error) =>
      ignoreBestEffortCleanup(error, {
        operation: 'cancelRecorderInstall',
        reason: 'cancel is fire-and-forget; the in-flight install resolves to a cancelled result',
      }),
    );
  }, []);

  const restart = useCallback(() => {
    void window.appApi.relaunch();
  }, []);

  const reset = useCallback(() => {
    clearPoll();
    cancelRequestedRef.current = false;
    setPhase('idle');
    setErrorMessage(null);
    setUnsupportedPlatform(false);
  }, [clearPoll]);

  // Reconnect to an install already running in the main process (e.g. the user
  // left the Meetings tab and came back). Poll until it finishes, then reflect
  // the resulting installed state.
  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    const poll = (): void => {
      pollRef.current = window.setTimeout(async () => {
        try {
          const { installing } = await window.meetingBotApi.isRecorderInstalling();
          if (cancelled || !mountedRef.current) return;
          if (installing) {
            poll();
            return;
          }
          // The user cancelled while reconnected: return to idle, not failure.
          if (cancelRequestedRef.current) {
            cancelRequestedRef.current = false;
            setPhase('idle');
            return;
          }
          const { installed } = await window.meetingBotApi.isRecorderInstalled();
          if (cancelled || !mountedRef.current) return;
          if (installed) {
            setPhase('success');
            onInstalledRef.current?.();
          } else {
            setErrorMessage(UNEXPECTED_ERROR);
            setPhase('failure');
          }
        } catch (error) {
          ignoreBestEffortCleanup(error, {
            operation: 'recorderInstallReconnectPoll',
            reason: 'best-effort reconnect; leave the UI as-is on a transient query error',
          });
        }
      }, RECONNECT_POLL_MS);
    };

    void (async () => {
      try {
        const { installing } = await window.meetingBotApi.isRecorderInstalling();
        if (cancelled || !mountedRef.current) return;
        if (installing) {
          setPhase('installing');
          poll();
        }
      } catch (error) {
        ignoreBestEffortCleanup(error, {
          operation: 'recorderInstallReconnect',
          reason: 'nothing to reconnect to if the installing-state query fails on mount',
        });
      }
    })();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      clearPoll();
    };
  }, [clearPoll]);

  return { phase, errorMessage, unsupportedPlatform, install, cancel, restart, reset };
}
