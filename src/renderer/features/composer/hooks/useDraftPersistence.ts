import { useCallback, useEffect } from 'react';
import { getSessionStoreState } from '@renderer/features/agent-session/store';
import {
  sanitiseCorruptedDraftText,
  detectCorruptionMarkers,
} from '@renderer/features/composer/utils/draftSanitisation';
import {
  markSessionSanitised,
  wasSessionSanitised,
} from '@renderer/features/composer/utils/draftSanitisationState';
import { toComposerWireMarkdown } from '@renderer/features/composer/utils/composerMarkdown';

const DRAFT_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const STORAGE_KEY_PREFIX = 'draft:';
/** Backup key prefix for the original (pre-sanitisation) localStorage payload. */
const SANITISATION_BACKUP_PREFIX = 'draft-sanitisation-backup:';
/** Backup TTL — 7 days, per Stage 6 H14 (auto-evicted by existing localStorage cleanup). */
const SANITISATION_BACKUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Module-level flag to prevent migration from re-running on component remount.
 * This survives React component remounts but resets on full page reload.
 */
let migrationCompletedInContext = false;

/**
 * Outcome of a single batch run of the localStorage draft migration. Returned
 * for tests and the caller's structured logging — no draft content (PII).
 *
 * Stage 6 of `docs/plans/260501_composer_tiptap_atmention_bugfix.md`.
 */
export interface MigrateLocalStorageDraftsResult {
  migratedCount: number;
  failedCount: number;
  concurrentWriteCount: number;
}

/**
 * Migrate localStorage drafts to the session store.
 *
 * Stage 6 amendments (post-spike GPT-High + 90%-push C3 + Opus-High atomic CAS):
 *   1. Async — awaits the new `upsertDraftDurable` action so a localStorage
 *      original is only deleted after the in-memory write is observable.
 *   2. Sanitises NBSP-family corruption markers before writing to the store.
 *      The pure `sanitiseCorruptedDraftText` runs in `markdownToDoc` already
 *      (C1); doing it here too is belt-and-braces *and* gives us the boundary
 *      to log corruption markers without leaking PII.
 *   3. Backs up the corrupted original to `draft-sanitisation-backup:<id>`
 *      with a 7-day TTL before sanitising.
 *   4. CAS-protected: `upsertDraftDurable(_, _, expectedCurrent)` rejects the
 *      migration if the user has typed since we read `expectedCurrent` from
 *      the store. The user's text wins; migration retries on next reload.
 *   5. Compare-and-write localStorage delete: only removes the original key
 *      if it still equals the snapshot (so concurrent writes from another
 *      tab/process aren't silently clobbered).
 *
 * Idempotent (safe to run on every startup) and crash-safe (a partial run
 * leaves the localStorage original in place for the next attempt).
 *
 * The result counts are intentionally separated by outcome so the caller can
 * log structured info about deferrals (concurrent writes, the user wins) vs
 * genuine failures.
 */
export async function migrateLocalStorageDrafts(): Promise<MigrateLocalStorageDraftsResult> {
  const result: MigrateLocalStorageDraftsResult = {
    migratedCount: 0,
    failedCount: 0,
    concurrentWriteCount: 0,
  };
  if (typeof localStorage === 'undefined') return result;

  const draftKeys = Object.keys(localStorage).filter((k) => k.startsWith(STORAGE_KEY_PREFIX));

  for (const key of draftKeys) {
    const sessionId = key.replace(STORAGE_KEY_PREFIX, '');

    try {
      const stored = localStorage.getItem(key);
      if (!stored) {
        // Key exists but value is null - clean up
        localStorage.removeItem(key);
        continue;
      }

      // Snapshot the raw localStorage value so we can compare-and-write later
      // (only delete the original if it hasn't been mutated by another writer
      // between the read above and the delete below).
      const originalLocalStorageValue = stored;

      const draftData: { text?: string; timestamp?: number } = JSON.parse(stored);

      // Skip empty drafts - just clean up localStorage
      if (!draftData.text?.trim()) {
        localStorage.removeItem(key);
        continue;
      }

      // Check draft age - skip expired drafts
      const draftTimestamp = draftData.timestamp ?? 0;
      const age = Date.now() - draftTimestamp;
      if (age >= DRAFT_EXPIRY_MS) {
        // Expired - clean up localStorage
        localStorage.removeItem(key);
        continue;
      }

      // Check if this draft is already migrated (idempotent check)
      const state = getSessionStoreState();
      const existingDraft = state.draftsBySessionId[sessionId];
      // Check loaded session cache for existing draft (if session happens to be loaded)
      const loadedSession = state.loadedSessions.get(sessionId);
      const existingSessionDraft = loadedSession?.draft;

      // Use the newer of existing store draft or session draft
      const existingTimestamp = Math.max(
        existingDraft?.updatedAt ?? 0,
        existingSessionDraft?.updatedAt ?? 0
      );

      // If localStorage draft is older than or equal to existing, skip it
      if (existingTimestamp >= draftTimestamp) {
        // localStorage is stale - clean up
        localStorage.removeItem(key);
        continue;
      }

      // localStorage has newer draft - migrate it
      // Check if session exists (either current or in history)
      const isCurrentSession = state.currentSessionId === sessionId;
      const existingSummary = state.sessionSummaries.find((s) => s.id === sessionId);
      const sessionExists = isCurrentSession || existingSummary != null;

      if (!sessionExists) {
        // Note: Orphan drafts (for sessions that don't exist) are NOT removed here.
        // They might just be sessions that haven't loaded yet. Let the 24h expiry
        // handle true orphans, or let the next migration attempt handle them.
        continue;
      }

      const raw = draftData.text;
      // Sanitise via the same path the editor uses on hydrate — sanitise + round-trip
      // through `markdownToDoc`/`docToMarkdown` so the wire form on disk matches the
      // wire form the editor would emit on its next save (idempotent on no-corruption
      // input).
      const cleaned = sanitiseCorruptedDraftText(raw);

      // Read current store value BEFORE attempting the durable write — this is
      // the snapshot the CAS will check. If a user keystroke lands between this
      // line and `upsertDraftDurable` resolving, the CAS rejects.
      const expectedCurrent = existingDraft?.text ?? '';

      if (cleaned !== raw) {
        // Backup the corrupted original BEFORE we attempt the durable write
        // (so even if the write fails, we still have the original on disk).
        try {
          localStorage.setItem(
            `${SANITISATION_BACKUP_PREFIX}${sessionId}`,
            JSON.stringify({ text: raw, timestamp: Date.now(), ttl: SANITISATION_BACKUP_TTL_MS }),
          );
        } catch {
          // Backup failure is non-fatal — proceed with migration. The localStorage
          // original is still there until we explicitly delete it.
        }
      }

      // Atomic CAS write to the store. Pass the snapshot as expectedCurrent so
      // a concurrent user-keystroke wins.
      const upsertResult = await state.upsertDraftDurable(
        sessionId,
        cleaned,
        expectedCurrent,
      );

      if (upsertResult.ok) {
        // Compare-and-write localStorage delete: only remove the original if
        // its value hasn't been mutated by another writer (e.g. a second tab
        // writing the same key) between our snapshot and now.
        const stillSame = localStorage.getItem(key);
        if (stillSame === originalLocalStorageValue) {
          localStorage.removeItem(key);
        }

        // Boundary-side structured log: only fire once per session per app run
        // (rate-limited by `wasSessionSanitised`). No draft content — PII safe.
        // Object-first arg order to mirror the project's pino structured-log
        // convention (CLAUDE.md). Aligns with the concurrent_write deferral
        // log below so both diagnostics share the same shape.
        if (cleaned !== raw && !wasSessionSanitised(sessionId)) {
          console.warn(
            {
              sessionId,
              corruptionMarkers: detectCorruptionMarkers(raw),
              originalLength: raw.length,
              sanitisedLength: cleaned.length,
              source: 'migration',
            },
            '[DraftMigration] Sanitised corrupted composer draft on migration',
          );
          markSessionSanitised(sessionId);
        }

        result.migratedCount += 1;
        continue;
      }

      // Non-ok outcomes — leave the localStorage original in place so the
      // next reload retries.
      if (upsertResult.reason === 'concurrent_write') {
        // Stage 4 of docs-private/investigations/260505_composer_nbsp_recurrence.md —
        // upgrade per-occurrence deferral from info to warn so the deferral
        // path is observable in production logs. Cross-layer retry-on-idle
        // scheduling is intentionally NOT wired up here (Fix Design reviewer
        // flagged it as cross-layer coupling); revisit if logs show the
        // deferral persists corruption in practice. Payload mirrors the
        // sanitisation log above (corruptionMarkers + originalLength) so
        // diagnostics share the same shape.
        console.warn(
          {
            sessionId,
            deferralReason: 'concurrent_write',
            source: 'migration',
            corruptionMarkers: detectCorruptionMarkers(raw),
            originalLength: raw.length,
          },
          '[DraftMigration] Composer draft migration deferred — concurrent write',
        );
        result.concurrentWriteCount += 1;
      } else {
        console.error(
          '[DraftMigration] Draft migration durable-persist failed; localStorage original retained',
          { sessionId, reason: upsertResult.reason },
        );
        result.failedCount += 1;
      }
    } catch {
      // Parse error or other issue - clean up corrupted data
      try {
        localStorage.removeItem(key);
      } catch {
        // Ignore removal failures
      }
      result.failedCount += 1;
    }
  }

  return result;
}

/** Delay before running migration (ms) - allows sessions to load */
const MIGRATION_DELAY_MS = 1500;

/**
 * Hook to run localStorage draft migration once after app initialization.
 * Should be called from the app's initialization flow (e.g., App.tsx).
 *
 * The migration is idempotent and crash-safe, designed to run on every startup
 * but only migrate drafts that haven't been migrated yet.
 *
 * Uses a delay-based approach to ensure sessions have been loaded before
 * migration runs. This is simpler than tracking hydration state explicitly
 * and matches the pattern used by other startup hooks.
 */
export function useDraftMigration(): void {
  useEffect(() => {
    // Only run migration once per JS context
    if (migrationCompletedInContext) return;

    let cancelled = false;

    // Delay to allow sessions to load from persistence
    // (sessions are loaded async in useAgentSessionEngine)
    const timeoutId = setTimeout(() => {
      if (migrationCompletedInContext || cancelled) return;
      migrationCompletedInContext = true;

      // Async migration: awaits durable-persist via `upsertDraftDurable` and
      // CAS-protects against concurrent user keystrokes. See Stage 6 of
      // docs/plans/260501_composer_tiptap_atmention_bugfix.md.
      void migrateLocalStorageDrafts().then(
        ({ migratedCount, failedCount, concurrentWriteCount }) => {
          if (cancelled) return;
          if (migratedCount > 0) {
            // eslint-disable-next-line no-console -- migration-complete diagnostic; safe (no PII)
            console.log(
              `[DraftMigration] Migrated ${migratedCount} draft(s) from localStorage to session store`,
            );
          }
          if (concurrentWriteCount > 0) {
            // eslint-disable-next-line no-console -- info-level renderer diagnostic; safe (no PII)
            console.info(
              `[DraftMigration] Deferred ${concurrentWriteCount} draft(s) due to concurrent user typing — will retry on next reload`,
            );
          }
          if (failedCount > 0) {
            console.error(
              `[DraftMigration] ${failedCount} draft(s) failed to migrate; localStorage originals retained`,
            );
          }
        },
        (err) => {
          if (cancelled) return;
          console.error('[DraftMigration] Migration rejected', err);
        },
      );
    }, MIGRATION_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, []);
}

interface DraftData {
  text: string;
  timestamp: number;
}

/**
 * Persist composer draft text to localStorage.
 *
 * Features:
 * - Auto-saves draft every 2 seconds (debounced)
 * - Restores draft on session load
 * - Expires drafts after 24 hours
 * - Clears draft when message is sent
 *
 * Note: Attachments are not persisted (too complex, minimal value).
 */
export const useDraftPersistence = (
  sessionId: string,
  _textPrompt: string,
  setTextPrompt: (text: string) => void
): { clearDraft: () => void } => {
  // Restore draft from localStorage on session change (migration path only).
  // The store-based draft sync in ComposerWithState handles ongoing persistence;
  // this restore is kept so legacy localStorage drafts aren't silently lost.
  useEffect(() => {
    const key = `${STORAGE_KEY_PREFIX}${sessionId}`;
    try {
      const stored = localStorage.getItem(key);
      if (stored) {
        const data: DraftData = JSON.parse(stored);
        const age = Date.now() - data.timestamp;
        if (age < DRAFT_EXPIRY_MS && data.text.trim()) {
          setTextPrompt(toComposerWireMarkdown(data.text));
        } else {
          // Expired or empty - clean up
          localStorage.removeItem(key);
        }
      }
    } catch {
      // Ignore parse errors - corrupted data
      localStorage.removeItem(key);
    }
  }, [sessionId, setTextPrompt]);

  // Clear draft when message is sent
  const clearDraft = useCallback(() => {
    const key = `${STORAGE_KEY_PREFIX}${sessionId}`;
    localStorage.removeItem(key);
  }, [sessionId]);

  return { clearDraft };
};
