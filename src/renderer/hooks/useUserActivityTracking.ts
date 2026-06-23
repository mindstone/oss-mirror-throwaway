/**
 * User Activity Tracking Hook
 *
 * Reports genuine user input to the main process for engagement heartbeat tracking.
 * Only tracks events that REQUIRE physical user action.
 *
 * Tracked signals:
 * - keydown: User pressed a key
 * - pointerdown: User clicked/tapped/pen-touched (covers mouse, touch, stylus)
 * - scroll: User scrolled content
 *
 * Voice input is tracked separately via the voice recording flow.
 *
 * Throttled to max 1 IPC ping per 30 seconds to reduce noise.
 * Uses leading-edge throttle to prevent delayed trailing calls
 * from firing after user has left the window.
 */

import { useEffect, useRef } from 'react';

const THROTTLE_INTERVAL_MS = 30 * 1000; // 30 seconds

/**
 * Send activity ping to main process.
 * Uses fire-and-forget IPC (no response expected).
 */
function sendActivityPing(): void {
  // Use the userEngagementApi exposed in preload
  if (window.userEngagementApi?.pingActivity) {
    window.userEngagementApi.pingActivity();
  }
}

/**
 * Hook to track user activity and report to main process.
 * Should be mounted once at the app root level.
 */
export function useUserActivityTracking(): void {
  const lastPingTime = useRef(0);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;

    // Throttled ping - leading edge only, no trailing
    const maybePing = () => {
      if (!isMounted.current) return;

      const now = Date.now();
      if (now - lastPingTime.current >= THROTTLE_INTERVAL_MS) {
        lastPingTime.current = now;
        sendActivityPing();
      }
    };

    // Event handlers - only respond to trusted (real user) events
    // isTrusted is false for synthetic events (dispatchEvent, scrollTo, etc.)
    const onKeydown = (e: KeyboardEvent) => e.isTrusted && maybePing();
    const onPointerdown = (e: PointerEvent) => e.isTrusted && maybePing();
    const onScroll = (e: Event) => e.isTrusted && maybePing();

    // Register listeners
    window.addEventListener('keydown', onKeydown);
    window.addEventListener('pointerdown', onPointerdown);
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });

    return () => {
      isMounted.current = false;
      window.removeEventListener('keydown', onKeydown);
      window.removeEventListener('pointerdown', onPointerdown);
      window.removeEventListener('scroll', onScroll, { capture: true });
    };
  }, []);
}

/**
 * Call this directly when voice input starts.
 * Voice is a clear user engagement signal that doesn't trigger DOM events.
 */
export function pingUserActivityForVoice(): void {
  sendActivityPing();
}
