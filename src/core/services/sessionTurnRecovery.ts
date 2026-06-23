/**
 * Session turn recovery — shared stale-busy correction logic.
 *
 * Consolidates the "interrupted turn detection + markSessionTurnsAsCompleted"
 * pattern used in 3 places:
 * - incrementalSessionStore startup correction
 * - staleBusyReaper cloud sweep
 * - main/index.ts session loading
 *
 * @see docs/plans/260409_cloud_continuity_centralization_top10.md — Stage 2
 */

import type { AgentSession } from '@shared/types';
import type { TurnInterruptionSource } from '@shared/constants/turnInterruption';
import { markSessionTurnsAsCompleted } from './inboxStore';
import { hasTerminalEventInTurn } from './sessionMergeUtils';

/**
 * Apply interrupted-turn correction to a session with a stale active turn.
 *
 * Logic:
 * 1. If the stale turn has NO terminal event → set `interruptedTurnId` (for auto-resume)
 * 2. Call `markSessionTurnsAsCompleted` to clear `activeTurnId`/`isBusy` and append
 *    interruption status events
 *
 * Callers must:
 * - Verify `staleTurnId` is valid before calling (this function trusts the parameter)
 * - Own persistence (this function returns the corrected session but does NOT write it)
 * - Own any additional guards (e.g., staleBusyReaper checks controller liveness first)
 *
 * This function does NOT modify `updatedAt` — corrections are housekeeping, not user activity.
 */
export function applyInterruptedTurnCorrection(
  session: AgentSession,
  staleTurnId: string,
  // All current callers are crash/stale-recovery shaped → 'startup-correction'.
  // Param exists so a future graceful-path caller can discriminate.
  source: TurnInterruptionSource = 'startup-correction',
): AgentSession {
  const sessionWithInterruptedTurn = !hasTerminalEventInTurn(session.eventsByTurn, staleTurnId)
    ? { ...session, interruptedTurnId: staleTurnId }
    : session;

  return markSessionTurnsAsCompleted(sessionWithInterruptedTurn, source);
}
