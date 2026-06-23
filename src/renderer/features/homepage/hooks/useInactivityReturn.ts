/**
 * useInactivityReturn - Detects long idle periods and signals "just returned"
 *
 * Tracks last user interaction (mouse, keyboard, scroll). After the idle
 * threshold (default 15 min), exposes `isReturningFromIdle=true` for ~30 s once
 * the user touches Rebel again. The homepage uses this flag to switch into its
 * `'returning-after-idle'` state ("Welcome back — here's what you missed").
 *
 * Important: this hook intentionally does NOT navigate. Previously it forcibly
 * switched the active surface to `'home'` after 15 min idle, but that destroyed
 * the user's prior context (e.g. dropping them out of a long conversation just
 * because they were in another app during a meeting). The active surface is
 * already persisted by `FlowPanelsProvider`, so the user stays wherever they
 * were; if they choose to go Home themselves within ~30 s of returning, they
 * still get the welcome-back homepage state. (Reverses the Phase 1 auto-return
 * decision in `docs/plans/partway/260217_Homepage_Phase1_Build.md` based on user
 * feedback REBEL-5F6 / FOX-3274.)
 *
 * 15 minutes is chosen based on UX research:
 *   - Knowledge workers context-switch in ~10–15 min cycles (Gloria Mark, UC Irvine).
 *   - 5 min is too aggressive — users reading conversations, on calls, or briefly
 *     multitasking would have the welcome-back state flicker through.
 *   - 15 min means the user has been through an entire task cycle without
 *     touching Rebel — a reasonable signal they've come back fresh.
 *
 * Does NOT fire the welcome-back signal when:
 *   - User is already on the home surface
 *   - Agent is currently busy (active conversation)
 *   - Voice recording is active
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import type { FlowSurface } from '../../flow-panels/FlowPanelsProvider';
import { tracking } from '@renderer/src/tracking';

const DEFAULT_IDLE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

interface UseInactivityReturnOptions {
  /** Current active surface (used only to gate the welcome-back signal — we don't fire it when already on home) */
  activeSurface: FlowSurface;
  /** Whether the agent is currently busy (active conversation) */
  isBusy: boolean;
  /** Whether voice recording is active */
  isVoiceActive?: boolean;
  /** Idle threshold in ms (default 15 min) */
  idleThresholdMs?: number;
  /** Whether the feature is enabled */
  enabled?: boolean;
}

interface UseInactivityReturnResult {
  /** Whether the user just returned from idle (true for ~30s after return) */
  isReturningFromIdle: boolean;
}

export function useInactivityReturn({
  activeSurface,
  isBusy,
  isVoiceActive = false,
  idleThresholdMs = DEFAULT_IDLE_THRESHOLD_MS,
  enabled = true,
}: UseInactivityReturnOptions): UseInactivityReturnResult {
  const lastActivityRef = useRef(Date.now());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [isReturningFromIdle, setIsReturningFromIdle] = useState(false);
  const returningTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track idle-return state for the "returned after idle" metric.
  // When inactivity triggers, we store the timestamp of last activity so we can
  // measure total absence when the user eventually comes back.
  const idleTriggeredAtRef = useRef<number | null>(null);
  const previousSurfaceRef = useRef<string | null>(null);

  // Refs for volatile values — read inside the interval without causing
  // teardown/recreate on every isBusy or activeSurface change.
  const activeSurfaceRef = useRef(activeSurface);
  activeSurfaceRef.current = activeSurface;
  const isBusyRef = useRef(isBusy);
  isBusyRef.current = isBusy;
  const isVoiceActiveRef = useRef(isVoiceActive);
  isVoiceActiveRef.current = isVoiceActive;

  const startReturningWindow = useCallback(() => {
    setIsReturningFromIdle(true);
    if (returningTimeoutRef.current) clearTimeout(returningTimeoutRef.current);
    returningTimeoutRef.current = setTimeout(() => {
      setIsReturningFromIdle(false);
    }, 30_000);
  }, []);

  // Track user activity — also fires the "returned after idle" metric
  const handleActivity = useCallback(() => {
    const now = Date.now();
    if (idleTriggeredAtRef.current !== null) {
      const totalAbsence = now - idleTriggeredAtRef.current;
      tracking.homepage.userReturnedAfterIdle(
        totalAbsence,
        previousSurfaceRef.current ?? 'unknown',
      );
      idleTriggeredAtRef.current = null;
      previousSurfaceRef.current = null;
      startReturningWindow();
    } else {
      const idle = now - lastActivityRef.current;
      if (
        activeSurfaceRef.current !== 'home' &&
        !isBusyRef.current &&
        !isVoiceActiveRef.current &&
        idle >= idleThresholdMs
      ) {
        tracking.homepage.inactivityReturnTriggered(activeSurfaceRef.current, idle);
        tracking.homepage.userReturnedAfterIdle(idle, activeSurfaceRef.current);
        startReturningWindow();
      }
    }
    lastActivityRef.current = now;
  }, [idleThresholdMs, startReturningWindow]);

  // Register activity listeners
  useEffect(() => {
    if (!enabled) return;

    const events = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'] as const;
    events.forEach(event => document.addEventListener(event, handleActivity, { passive: true }));
    return () => {
      events.forEach(event => document.removeEventListener(event, handleActivity));
    };
  }, [enabled, handleActivity]);

  // Check for idle periodically — interval is stable (only depends on enabled + threshold)
  useEffect(() => {
    if (!enabled) return;

    timerRef.current = setInterval(() => {
      const idle = Date.now() - lastActivityRef.current;

      // Skip idle detection when:
      // - User is already on home (welcome-back UI would never be seen)
      // - Agent is busy (active conversation — don't distract)
      // - Voice recording is active
      // - Not idle long enough
      // - Signal is already armed (don't re-arm every 30s while still idle)
      if (
        activeSurfaceRef.current === 'home' ||
        isBusyRef.current ||
        isVoiceActiveRef.current ||
        idle < idleThresholdMs ||
        idleTriggeredAtRef.current !== null
      ) {
        return;
      }

      // Record the moment of last activity for the return metric
      idleTriggeredAtRef.current = lastActivityRef.current;
      previousSurfaceRef.current = activeSurfaceRef.current;

      // Record that an idle period happened. The welcome-back UI window starts
      // only when the user actually returns, not while they are still away.
      tracking.homepage.inactivityReturnTriggered(activeSurfaceRef.current, idle);
    }, 30_000); // Check every 30 seconds

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (returningTimeoutRef.current) clearTimeout(returningTimeoutRef.current);
    };
  }, [enabled, idleThresholdMs]);

  return { isReturningFromIdle };
}
