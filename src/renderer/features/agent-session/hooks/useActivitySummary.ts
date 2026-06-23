import { useCallback } from 'react';
import { useSessionStore } from '../store/sessionStore';

/**
 * Read access to the per-turn AI activity summary (260618 show-more-activity).
 *
 * One grounded sentence per turn (keyed by turnId), generated post-`result` in
 * core and surfaced as the collapsed work-disclosure label, with the
 * deterministic count-line (`turnActivityRecap.ts`) as the fallback.
 *
 * This hook is a pure store selector — UNLIKE `useTimeSavedStatus` / its memory
 * sibling, it does NOT own an IPC listener. The live swap-in
 * (`session:activity-summary-generated`) is subscribed once in
 * `useAgentSessionEngine` (beside the `session:title-generated` listener), which
 * calls `setActivitySummaryForSession` directly. Keeping the subscription there
 * matches the title-generated precedent and avoids a second listener-init path.
 */
export const useActivitySummary = () => {
  const activitySummaryByTurn = useSessionStore((state) => state.activitySummaryByTurn);

  const getSummaryForTurn = useCallback(
    (turnId: string): string | undefined => activitySummaryByTurn[turnId],
    [activitySummaryByTurn],
  );

  return { summaryByTurn: activitySummaryByTurn, getSummaryForTurn };
};
