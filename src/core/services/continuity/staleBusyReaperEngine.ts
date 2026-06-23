import { createScopedLogger } from '@core/logger';
import { applyInterruptedTurnCorrection } from '@core/services/sessionTurnRecovery';
import type { AgentSession } from '@shared/types';

const log = createScopedLogger({ service: 'continuity-stale-busy-reaper' });

/**
 * Time after which a busy session with no active controller in the in-process
 * registry is considered orphaned and eligible for cleanup. Matches the
 * cloud-service value (and is preserved at engine level so behaviour is
 * platform-independent).
 */
export const STALE_BUSY_GRACE_PERIOD_MS = 120_000;

/**
 * Subset of dependency container needed to run a single sweep pass. The engine
 * is intentionally surface-agnostic — it does NOT know about Express routes,
 * event broadcasters, or the cloud session store. Callers translate the
 * returned corrected-session IDs into surface-specific notifications
 * (e.g. cloud broadcasts a `cloud:session-changed` event for each ID).
 */
export interface StaleBusyReaperEngineDeps {
  listSessions: () => unknown;
  getSession: (id: string) => Promise<AgentSession | null>;
  upsertSession: (session: AgentSession) => Promise<void>;
  getActiveTurnController: (turnId: string) => AbortController | undefined;
}

type SessionSummaryLike = {
  id: string;
  isBusy: boolean;
  activeTurnId: string | null;
  updatedAt: number;
};

function isSessionSummaryLike(value: unknown): value is SessionSummaryLike {
  if (typeof value !== 'object' || value === null) return false;
  const summary = value as Record<string, unknown>;
  return (
    typeof summary.id === 'string' &&
    typeof summary.isBusy === 'boolean' &&
    (typeof summary.activeTurnId === 'string' || summary.activeTurnId === null) &&
    typeof summary.updatedAt === 'number'
  );
}

/**
 * Runs ONE sweep pass over the session list. Returns the IDs of sessions that
 * were corrected (their busy state was cleared and persisted) during this
 * pass. Callers — typically the cloud-service wrapper — should broadcast
 * surface-appropriate change events for each ID.
 *
 * Re-entrancy is the caller's concern (this function is NOT idempotent if
 * called concurrently; the cloud wrapper guards re-entry via an
 * `isRunning` flag).
 */
export async function sweepStaleBusySessions(deps: StaleBusyReaperEngineDeps): Promise<string[]> {
  const correctedIds: string[] = [];
  const startedAt = Date.now();
  let scanned = 0;
  let orphaned = 0;
  let cleaned = 0;

  try {
    const summaries = deps.listSessions();
    if (!Array.isArray(summaries)) {
      log.warn('Stale busy sweep skipped: listSessions() did not return an array');
      return correctedIds;
    }

    scanned = summaries.length;
    const staleBefore = Date.now() - STALE_BUSY_GRACE_PERIOD_MS;

    for (const summaryValue of summaries) {
      if (!isSessionSummaryLike(summaryValue)) continue;
      if (!summaryValue.isBusy || !summaryValue.activeTurnId) continue;
      if (summaryValue.updatedAt > staleBefore) continue;

      const staleTurnId = summaryValue.activeTurnId;

      if (deps.getActiveTurnController(staleTurnId)) {
        continue;
      }
      orphaned++;

      try {
        const session = await deps.getSession(summaryValue.id);
        if (!session) continue;

        if (!session.isBusy || session.activeTurnId !== staleTurnId) {
          continue;
        }

        if (deps.getActiveTurnController(staleTurnId)) {
          continue;
        }

        const corrected = applyInterruptedTurnCorrection(session, staleTurnId);
        await deps.upsertSession(corrected);
        correctedIds.push(corrected.id);

        cleaned++;
        log.info(
          { sessionId: corrected.id, turnId: staleTurnId },
          'Cleaned stale busy orphan turn',
        );
      } catch (sessionError) {
        const msg = sessionError instanceof Error ? sessionError.message : String(sessionError);
        log.warn(
          { sessionId: summaryValue.id, turnId: staleTurnId, error: msg },
          'Failed to clean stale busy session; will retry next sweep',
        );
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ error: message }, 'Stale busy sweep failed');
  } finally {
    const durationMs = Date.now() - startedAt;
    log.info(
      { scanned, orphaned, cleaned, durationMs },
      `Stale busy sweep: scanned=${scanned}, orphaned=${orphaned}, cleaned=${cleaned}, durationMs=${durationMs}`,
    );
  }

  return correctedIds;
}
