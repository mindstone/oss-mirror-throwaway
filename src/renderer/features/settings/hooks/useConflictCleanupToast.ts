import { useEffect, useRef } from 'react';
import { useToast } from '@renderer/components/ui/Toast';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Summary broadcast by the main process when the one-off conflict-copy
 * cleanup detection (REBEL-62A) finds backlog duplicates in an affected
 * space. Mirrors `ConflictCleanupPlanSummary` in `spaceMaintenanceAdapter.ts`.
 */
interface ConflictCleanupAvailableInfo {
  runId: string;
  spaceRootAbsPath: string;
  spaceName: string;
  quarantineCount: number;
  needsReviewCount: number;
  sample: string[];
}

// ---------------------------------------------------------------------------
// Message builders (exported for testing)
// ---------------------------------------------------------------------------

export function buildCleanupOfferDescription(info: ConflictCleanupAvailableInfo): string {
  const { quarantineCount, needsReviewCount } = info;
  const fileWord = quarantineCount === 1 ? 'file' : 'files';
  let msg = `Rebel found ${quarantineCount} duplicate ${fileWord} from a cloud-sync issue`;
  if (needsReviewCount > 0) {
    msg += ` (${needsReviewCount} more need your review)`;
  }
  msg += '.';
  return msg;
}

export function buildCleanupDoneDescription(
  quarantined: number,
  needsReviewCount: number,
): string {
  const fileWord = quarantined === 1 ? 'file' : 'files';
  let msg = `Moved ${quarantined} ${fileWord} to .rebel/conflicts-cleanup/`;
  if (needsReviewCount > 0) {
    msg += `; ${needsReviewCount} still need review`;
  }
  msg += '.';
  return msg;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Listens for `conflict-cleanup:available` broadcasts from the main process
 * and shows an AFFECTED-ONLY toast that states what was found, with an
 * explicit confirm action. Empty plans are never broadcast → no toast.
 *
 * Flow (Safety Contract §1/§2/§3):
 *  - Main detects (read-only) → broadcasts a summary for ONE affected space.
 *  - Toast states the counts + offers a confirm button "Move N to cleanup
 *    folder" (the explicit confirmation) and a "Not now" cancel.
 *  - Clicking confirm → `spaceMaintenanceApi.cleanupExecute({ runId,
 *    spaceRootAbsPath })`, the ONLY destructive call. Core reloads the trusted
 *    manifest by runId and MOVES (never deletes) into the quarantine folder.
 *  - On success → a follow-up confirmation toast.
 *
 * Dedup: the main-process run-once marker already gates surfacing, but we keep
 * an in-session `useRef<Set>` keyed on runId so a re-broadcast can't double-toast.
 */
export function useConflictCleanupToast(): void {
  const { showToast } = useToast();
  const shownRunIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const unsubscribe = window.api.onConflictCleanupAvailable(
      (info: ConflictCleanupAvailableInfo) => {
        const { runId, spaceRootAbsPath, quarantineCount, needsReviewCount } = info;

        // Nothing actionable to auto-move → don't offer a confirm. (Pure
        // needs-review backlogs are surfaced elsewhere, not here.)
        if (quarantineCount <= 0) return;

        // In-session dedup keyed on runId.
        if (shownRunIdsRef.current.has(runId)) return;
        shownRunIdsRef.current.add(runId);

        const fileWord = quarantineCount === 1 ? 'file' : 'files';

        showToast({
          title: 'Tidy up duplicate files?',
          description: buildCleanupOfferDescription(info),
          variant: 'default',
          duration: Infinity, // Persistent until the user acts.
          action: {
            label: `Move ${quarantineCount} to cleanup folder`,
            onClick: () => {
              // Clicking confirm IS the explicit confirmation → execute.
              void (async () => {
                try {
                  const result = await window.spaceMaintenanceApi.cleanupExecute({
                    runId,
                    spaceRootAbsPath,
                  });
                  if (result.errors.length > 0 && result.quarantined === 0) {
                    showToast({
                      title: 'Cleanup didn\'t finish',
                      description: `Couldn't move the ${fileWord} (${result.errors[0]}). Nothing was deleted.`,
                      variant: 'warning',
                      duration: Infinity,
                    });
                    return;
                  }
                  showToast({
                    title: 'Cleanup done',
                    description: buildCleanupDoneDescription(result.quarantined, needsReviewCount),
                    variant: 'success',
                    duration: Infinity,
                  });
                } catch {
                  showToast({
                    title: 'Cleanup didn\'t finish',
                    description: 'Something went wrong. Nothing was deleted — your files are safe.',
                    variant: 'warning',
                    duration: Infinity,
                  });
                }
              })();
            },
          },
          cancel: {
            label: 'Not now',
            onClick: () => {
              // No-op: the toast dismisses; we re-detect on a future launch
              // unless the cleanup completes.
            },
          },
        });
      },
    );

    return () => unsubscribe();
  }, [showToast]);
}
