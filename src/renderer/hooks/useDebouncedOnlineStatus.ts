import { useEffect, useRef, useState } from 'react';
import { useOnlineStatus } from './useOnlineStatus';

/**
 * Single, calm, debounced connectivity signal for the renderer — the source of
 * truth for BOTH offline surfaces (the header dot and the banner). See the
 * design rationale in
 * docs/plans/260618_arthur-offline-resilience/subagent_reports/260618_chief-designer_offline-ux.md
 * (Surface 2).
 *
 * Asymmetric debounce is the key interaction rule:
 *  - SLOW to alarm: only report offline after a sustained outage (a brief blip
 *    must be invisible — `navigator.onLine` flickers on every ~5s network blip,
 *    and is documented false-positive-prone in Electron).
 *  - INSTANT to clear: recovery is good news, so reconnect clears immediately
 *    with no debounce.
 *
 * Visibility-aware: we do not churn timers while the window is hidden (mirrors
 * CloudSyncIndicator's `document.visibilitychange` pattern). When the window
 * becomes visible again we re-evaluate against the current raw status.
 *
 * Backend `connectivityState` is intentionally out of scope here — debounced
 * `navigator.onLine` is the in-scope signal (PLAN Stage 3). If a shared
 * cross-process signal is later promoted, this hook is the single seam to
 * repoint.
 */

/** Sustained-offline threshold: time offline before the calm header dot shows. */
export const SUSTAINED_OFFLINE_MS = 6_000;
/** Long-sustained threshold: time offline before the full-width banner shows. */
export const LONG_SUSTAINED_OFFLINE_MS = 45_000;

export interface DebouncedOnlineStatus {
  /** Debounced online verdict: false only once offline is sustained. */
  isOnline: boolean;
  /** Offline has persisted past SUSTAINED_OFFLINE_MS — drives the header dot. */
  isSustainedOffline: boolean;
  /** Offline has persisted past LONG_SUSTAINED_OFFLINE_MS — drives the banner. */
  isLongSustainedOffline: boolean;
}

export interface UseDebouncedOnlineStatusOptions {
  /** Override the sustained-offline threshold (testing / tuning). */
  sustainedMs?: number;
  /** Override the long-sustained threshold (testing / tuning). */
  longSustainedMs?: number;
}

const ONLINE_STATE: DebouncedOnlineStatus = {
  isOnline: true,
  isSustainedOffline: false,
  isLongSustainedOffline: false,
};

export function useDebouncedOnlineStatus(
  options?: UseDebouncedOnlineStatusOptions,
): DebouncedOnlineStatus {
  const sustainedMs = options?.sustainedMs ?? SUSTAINED_OFFLINE_MS;
  const longSustainedMs = options?.longSustainedMs ?? LONG_SUSTAINED_OFFLINE_MS;

  // Raw, event-driven navigator.onLine (flickery — this is what we debounce).
  const rawOnline = useOnlineStatus();

  const [state, setState] = useState<DebouncedOnlineStatus>(ONLINE_STATE);

  const sustainedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clearTimers = () => {
      if (sustainedTimerRef.current) {
        clearTimeout(sustainedTimerRef.current);
        sustainedTimerRef.current = null;
      }
      if (longTimerRef.current) {
        clearTimeout(longTimerRef.current);
        longTimerRef.current = null;
      }
    };

    const goOnline = () => {
      // Instant clear on reconnect — no debounce. Recovery should feel immediate.
      clearTimers();
      setState((prev) => (prev.isOnline ? prev : ONLINE_STATE));
    };

    const armOfflineTimers = () => {
      // Already counting down or already offline — don't restart the clock.
      if (sustainedTimerRef.current || longTimerRef.current) return;
      sustainedTimerRef.current = setTimeout(() => {
        sustainedTimerRef.current = null;
        setState((prev) =>
          prev.isSustainedOffline
            ? prev
            : { isOnline: false, isSustainedOffline: true, isLongSustainedOffline: prev.isLongSustainedOffline },
        );
      }, sustainedMs);
      longTimerRef.current = setTimeout(() => {
        longTimerRef.current = null;
        setState({ isOnline: false, isSustainedOffline: true, isLongSustainedOffline: true });
      }, longSustainedMs);
    };

    const evaluate = () => {
      if (document.visibilityState === 'hidden') {
        // Freeze while hidden: don't start/advance offline timers in the
        // background. Preserve whatever visible verdict we already had.
        clearTimers();
        return;
      }
      if (rawOnline) {
        goOnline();
      } else {
        armOfflineTimers();
      }
    };

    evaluate();

    const handleVisibility = () => {
      // On becoming visible, re-evaluate against the current raw status so a
      // resolved-while-hidden outage clears at once and a still-down one
      // restarts its debounce from now (not from when the window was hidden).
      evaluate();
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      clearTimers();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [rawOnline, sustainedMs, longSustainedMs]);

  return state;
}
