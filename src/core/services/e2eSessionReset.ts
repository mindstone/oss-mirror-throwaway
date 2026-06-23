/**
 * E2E factory-reset helper for the session store (Stage 3, 260612 recs-round5).
 *
 * Extracted from the `e2e:clear-all-sessions` IPC handler (src/main/index.ts)
 * so the reset semantics — INCLUDING the mid-loop partial-failure early-return
 * path — are unit-testable. E2E-test-mode only by construction: the desktop
 * handler is registered only under REBEL_E2E_TEST_MODE, and
 * `clearHardDeleteLedgerForTestReset()` throws outside test contexts.
 *
 * Stage 3 factory-reset semantics: the deletes are 'user-delete' (they
 * tombstone — matching what the renderer-side ledger expects), but a test
 * reset must then CLEAR the hard-delete ledger; otherwise reseeding a
 * previously-used fixture id would be silently dropped (poisoned E2E). The
 * ledger clear runs in `finally` so it covers BOTH the success path and the
 * partial-failure early return (leftover partial tombstones are precisely the
 * flake this prevents).
 */
import { createScopedLogger } from '@core/logger';
import type { IncrementalSessionStore } from './incrementalSessionStore';

const log = createScopedLogger({ service: 'e2eSessionReset' });

type E2eClearAllSessionsStore = Pick<
  IncrementalSessionStore,
  'listSessions' | 'deleteSession' | 'clearHardDeleteLedgerForTestReset'
>;

type E2eClearAllSessionsResult =
  | { success: true; deletedCount: number; deletedIds: string[] }
  | { success: false; deletedCount: number; error: { message: string } };

export async function clearAllSessionsForE2eReset(
  store: E2eClearAllSessionsStore,
): Promise<E2eClearAllSessionsResult> {
  const summaries = store.listSessions({ includeInternal: true });
  const deletedIds: string[] = [];

  try {
    for (const summary of summaries) {
      try {
        await store.deleteSession(summary.id, { intent: 'user-delete' });
        deletedIds.push(summary.id);
      } catch (err) {
        log.error(
          {
            err,
            sessionId: summary.id,
            deletedCount: deletedIds.length,
            sessionCount: summaries.length,
          },
          'e2e:clear-all-sessions failed',
        );
        return {
          success: false,
          deletedCount: deletedIds.length,
          error: { message: (err as Error).message },
        };
      }
    }

    // Return the full set of disk-deleted ids so the renderer can tombstone
    // ALL of them (not just currently-visible summaries) and prevent a stale
    // async save / disk-list reconciliation from resurrecting any of them.
    return { success: true, deletedCount: deletedIds.length, deletedIds };
  } finally {
    store.clearHardDeleteLedgerForTestReset();
  }
}
