/**
 * ENFILE State Module
 *
 * Coordinates system-wide file descriptor exhaustion (ENFILE/EMFILE) detection
 * across all LanceDB services to prevent error storms that cause CPU spikes.
 *
 * When ENFILE is detected, all LanceDB operations should check `isEnfileActive()`
 * and skip their work until the cooldown expires. This prevents tight retry loops
 * that would otherwise cause 200%+ CPU usage and beach balls.
 *
 * **Not scheduled for removal.** This module solves a different problem from
 * graceful-fs's callback-fs queue: LanceDB calls `open()` via N-API and bypasses
 * Node's JS-level fs patching entirely, so graceful-fs cannot prevent the
 * CPU-storm that a raw retry loop would cause. The 60-second cooldown is the
 * correct solution here. See `docs/plans/260428_graceful_fs_emfile_fix.md`.
 */

import { getBroadcastService } from '@core/broadcastService';
import { tagFsExhaustion } from '@core/utils/gracefulFsObservability';

const ENFILE_COOLDOWN_MS = 60_000; // 60 seconds

let enfileDetectedAt = 0;

/**
 * Mark that an ENFILE/EMFILE error has been detected.
 * Returns whether this is the first detection in the current episode.
 *
 * When an `error` is provided AND this is the first detection in the
 * current cooldown window, the error is also tagged for Sentry as a
 * `native_bypass` `fs_exhaustion` event (graceful-fs cannot patch
 * LanceDB's N-API fs path). The tag is gated on `!wasActive` so the 13
 * catch blocks across the LanceDB services don't each fire a Sentry
 * event during a single cooldown — matches the existing toast-broadcast
 * gating. See docs/plans/260428_graceful_fs_emfile_fix.md Stage 3.
 *
 * @param error Optional caught EMFILE/ENFILE error to surface to Sentry
 *   on first detection. Pass through the value caught at the call site.
 * @returns `{ isFirstDetection: true }` if this is the first detection
 *   since cooldown expired.
 */
export function markEnfileDetected(error?: unknown): { isFirstDetection: boolean } {
  const now = Date.now();
  // Capture wasActive BEFORE mutating enfileDetectedAt so first-detection
  // gating remains correct for both the broadcast and the Sentry tag.
  const wasActive = enfileDetectedAt > 0 && now - enfileDetectedAt < ENFILE_COOLDOWN_MS;

  enfileDetectedAt = now;

  // Broadcast toast notification to renderer on first detection
  if (!wasActive) {
    getBroadcastService().sendToAllWindows('system:resource-warning', {
      type: 'enfile',
      message: 'System resource constraints detected. Some features may be temporarily limited.'
    });
  }

  // Tag Sentry on first detection only — prevents flood across the 13
  // catch blocks that each call markEnfileDetected during a cooldown.
  if (error !== undefined && !wasActive) {
    try { tagFsExhaustion(error, 'native_bypass'); } catch { /* never fail detection on tag errors */ }
  }

  return { isFirstDetection: !wasActive };
}

/**
 * Check if ENFILE cooldown is currently active.
 * LanceDB operations should check this and skip their work if true.
 */
export function isEnfileActive(): boolean {
  if (enfileDetectedAt === 0) return false;
  return Date.now() - enfileDetectedAt < ENFILE_COOLDOWN_MS;
}

/**
 * Reset state for testing purposes only.
 * @internal
 */
export function _resetForTesting(): void {
  enfileDetectedAt = 0;
}
