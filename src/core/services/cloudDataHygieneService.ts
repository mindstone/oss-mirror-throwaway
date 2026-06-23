import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { getErrorReporter } from '@core/errorReporter';
import {
  cleanupSessionLogs,
  createScopedLogger,
  type SessionLogCleanupResult,
} from '@core/logger';
import { cleanupOldTranscripts } from '@core/services/transcriptService';

const log = createScopedLogger({ service: 'cloud-data-hygiene' });

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DELETED_SESSIONS_TTL_DAYS = 7;
const DELETED_SESSIONS_DIR_NAME = 'sessions-deleted';
const TIMESTAMP_REGEX = /_(\d+)\.json$/;
const LEGACY_FILES = [
  'agent-session-history.json',
  'agent-session-history.json.backup.json',
] as const;

const ZERO_SESSION_LOG_RESULT: SessionLogCleanupResult = {
  deleted: 0,
  errors: 0,
  remainingCount: 0,
  remainingBytes: 0,
};

const ZERO_TRANSCRIPT_RESULT = { deleted: 0, errors: 0 };

export interface HygieneResult {
  deletedSessionFiles: number;
  deletedSessionBytes: number;
  removedLegacyFiles: string[];
  sessionLogResult: SessionLogCleanupResult;
  oldTranscripts: { deleted: number; errors: number };
  errors: string[];
  durationMs: number;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function addHygieneBreadcrumb(
  message: string,
  level: 'info' | 'warning',
  data: Record<string, unknown>,
): void {
  try {
    getErrorReporter().addBreadcrumb({
      category: 'cloud-hygiene',
      message,
      level,
      data,
    });
  } catch (error) {
    log.debug({ err: error, message }, 'Failed to emit cloud hygiene breadcrumb');
  }
}

/**
 * Purge files in sessions-deleted/ older than `ttlDays` based on the timestamp
 * encoded in the filename (`${sessionId}_${Date.now()}.json`).
 *
 * MASS-LOSS BREAKER EXEMPTION (Stage 2 remover taxonomy — see
 * `computeBulkRemovalBound()` in incrementalSessionStore.ts): this TTL loop is
 * exempt-with-reason — it unlinks only files already soft-deleted into
 * `sessions-deleted/` and past their TTL. It never touches live `sessions/`
 * files and never the index, so it cannot cause visible-corpus loss. Pinned by
 * a negative test in incrementalSessionStore.safetyNets.test.ts.
 */
export async function purgeDeletedSessions(
  deletedDir: string,
  ttlDays: number = DEFAULT_DELETED_SESSIONS_TTL_DAYS,
): Promise<{ deleted: number; bytesFreed: number; errors: string[] }> {
  let fileNames: string[];
  try {
    fileNames = await fsp.readdir(deletedDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { deleted: 0, bytesFreed: 0, errors: [] };
    }
    const message = `Failed to read deleted sessions directory "${deletedDir}": ${formatError(error)}`;
    log.warn({ err: error, deletedDir }, 'Failed to read deleted sessions directory');
    return { deleted: 0, bytesFreed: 0, errors: [message] };
  }

  const cutoffMs = Date.now() - ttlDays * DAY_MS;
  let deleted = 0;
  let bytesFreed = 0;
  const errors: string[] = [];

  for (const fileName of fileNames) {
    const match = fileName.match(TIMESTAMP_REGEX);
    if (!match) {
      log.debug({ fileName }, 'Skipped deleted-session file without parseable timestamp suffix');
      continue;
    }

    const timestampMs = Number(match[1]);
    if (!Number.isFinite(timestampMs)) {
      log.debug({ fileName }, 'Skipped deleted-session file with invalid timestamp suffix');
      continue;
    }

    if (timestampMs >= cutoffMs) {
      continue;
    }

    const filePath = path.join(deletedDir, fileName);
    try {
      const stats = await fsp.stat(filePath);
      if (!stats.isFile()) {
        log.debug({ filePath }, 'Skipped non-file entry in deleted sessions directory');
        continue;
      }

      await fsp.unlink(filePath);
      deleted++;
      bytesFreed += stats.size;
    } catch (error) {
      const message = `Failed to purge deleted session file "${fileName}": ${formatError(error)}`;
      errors.push(message);
      log.warn({ err: error, filePath }, 'Failed to purge deleted session file');
    }
  }

  return { deleted, bytesFreed, errors };
}

export interface RemoveLegacyFilesOptions {
  /**
   * Minimum file age (in ms) required before removal. Default `0` removes
   * unconditionally — matches cloud behaviour where the backup was never
   * meaningful. Desktop passes a non-zero value (e.g. 30 days) so freshly
   * migrated users keep their safety net during the rollback window.
   */
  minAgeMs?: number;
}

/**
 * Remove legacy pre-incremental-store files only when incremental sessions
 * index.json exists. Optionally gated by file age.
 */
export async function removeLegacyFiles(
  dataPath: string,
  options: RemoveLegacyFilesOptions = {},
): Promise<{ removed: string[]; bytesFreed: number; errors: string[] }> {
  const sessionsIndexPath = path.join(dataPath, 'sessions', 'index.json');
  try {
    await fsp.access(sessionsIndexPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { removed: [], bytesFreed: 0, errors: [] };
    }
    const message = `Failed to verify incremental sessions index: ${formatError(error)}`;
    log.warn({ err: error, sessionsIndexPath }, 'Failed to verify incremental sessions index');
    return { removed: [], bytesFreed: 0, errors: [message] };
  }

  const minAgeMs = options.minAgeMs ?? 0;
  const now = Date.now();

  const removed: string[] = [];
  let bytesFreed = 0;
  const errors: string[] = [];

  for (const fileName of LEGACY_FILES) {
    const filePath = path.join(dataPath, fileName);
    try {
      // Stat unconditionally so we can report accurate `bytesFreed` regardless
      // of whether the caller passed `minAgeMs`. ENOENT is the common case
      // (file already gone) and is handled silently below.
      const stats = await fsp.stat(filePath);
      if (minAgeMs > 0 && now - stats.mtimeMs < minAgeMs) {
        log.debug(
          { filePath, ageMs: now - stats.mtimeMs, minAgeMs },
          'Legacy file present but younger than minAgeMs — keeping',
        );
        continue;
      }
      await fsp.unlink(filePath);
      removed.push(fileName);
      bytesFreed += stats.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      const message = `Failed to remove legacy file "${fileName}": ${formatError(error)}`;
      errors.push(message);
      log.warn({ err: error, filePath }, 'Failed to remove legacy file');
    }
  }

  return { removed, bytesFreed, errors };
}

/**
 * Run cloud data hygiene tasks with per-category isolation.
 *
 * Composition contract:
 * - `purgeDeletedSessions` and `removeLegacyFiles` are owned here and surface
 *   per-file failures into `HygieneResult.errors[]`.
 * - `cleanupSessionLogs` and `cleanupOldTranscripts` are EXISTING shared
 *   primitives. They log read/stat failures internally (see `src/core/logger.ts`
 *   and `src/core/services/transcriptService.ts`) but only some of those paths
 *   surface as `errors > 0` in their return value. We propagate `errors > 0`
 *   into `HygieneResult.errors[]` and rely on each primitive's own structured
 *   logging for the read-failure paths it doesn't count. Failures that bubble
 *   up as thrown errors are caught here and added to `HygieneResult.errors[]`.
 *
 * If a category throws, other categories still run. The result always
 * populates `durationMs` and `errors[]`.
 */
export async function runCloudDataHygiene(dataPath: string): Promise<HygieneResult> {
  const startedAt = Date.now();
  const result: HygieneResult = {
    deletedSessionFiles: 0,
    deletedSessionBytes: 0,
    removedLegacyFiles: [],
    sessionLogResult: { ...ZERO_SESSION_LOG_RESULT },
    oldTranscripts: { ...ZERO_TRANSCRIPT_RESULT },
    errors: [],
    durationMs: 0,
  };

  try {
    const purgeResult = await purgeDeletedSessions(
      path.join(dataPath, DELETED_SESSIONS_DIR_NAME),
      DEFAULT_DELETED_SESSIONS_TTL_DAYS,
    );
    result.deletedSessionFiles = purgeResult.deleted;
    result.deletedSessionBytes = purgeResult.bytesFreed;
    result.errors.push(...purgeResult.errors.map((error) => `purgeDeletedSessions: ${error}`));
    addHygieneBreadcrumb('purge-deleted-sessions-complete', 'info', {
      deleted: purgeResult.deleted,
      bytesFreed: purgeResult.bytesFreed,
      errors: purgeResult.errors.length,
    });
  } catch (error) {
    const message = `purgeDeletedSessions failed: ${formatError(error)}`;
    result.errors.push(message);
    log.warn({ err: error, dataPath }, 'Deleted sessions purge failed');
    addHygieneBreadcrumb('purge-deleted-sessions-failed', 'warning', { error: message });
  }

  try {
    const legacyResult = await removeLegacyFiles(dataPath);
    result.removedLegacyFiles = legacyResult.removed;
    result.errors.push(...legacyResult.errors.map((error) => `removeLegacyFiles: ${error}`));
    addHygieneBreadcrumb('remove-legacy-files-complete', 'info', {
      removed: legacyResult.removed.length,
      errors: legacyResult.errors.length,
    });
  } catch (error) {
    const message = `removeLegacyFiles failed: ${formatError(error)}`;
    result.errors.push(message);
    log.warn({ err: error, dataPath }, 'Legacy file cleanup failed');
    addHygieneBreadcrumb('remove-legacy-files-failed', 'warning', { error: message });
  }

  try {
    const sessionLogResult = await cleanupSessionLogs();
    result.sessionLogResult = sessionLogResult;
    if (sessionLogResult.errors > 0) {
      result.errors.push(`cleanupSessionLogs reported ${sessionLogResult.errors} file cleanup errors`);
    }
    addHygieneBreadcrumb('cleanup-session-logs-complete', 'info', {
      deleted: sessionLogResult.deleted,
      errors: sessionLogResult.errors,
      remainingCount: sessionLogResult.remainingCount,
      remainingBytes: sessionLogResult.remainingBytes,
    });
  } catch (error) {
    const message = `cleanupSessionLogs failed: ${formatError(error)}`;
    result.errors.push(message);
    log.warn({ err: error }, 'Session log cleanup failed');
    addHygieneBreadcrumb('cleanup-session-logs-failed', 'warning', { error: message });
  }

  try {
    const transcriptResult = await cleanupOldTranscripts();
    result.oldTranscripts = transcriptResult;
    if (transcriptResult.errors > 0) {
      result.errors.push(`cleanupOldTranscripts reported ${transcriptResult.errors} file cleanup errors`);
    }
    addHygieneBreadcrumb('cleanup-old-transcripts-complete', 'info', {
      deleted: transcriptResult.deleted,
      errors: transcriptResult.errors,
    });
  } catch (error) {
    const message = `cleanupOldTranscripts failed: ${formatError(error)}`;
    result.errors.push(message);
    log.warn({ err: error }, 'Transcript cleanup failed');
    addHygieneBreadcrumb('cleanup-old-transcripts-failed', 'warning', { error: message });
  }

  result.durationMs = Math.max(0, Date.now() - startedAt);
  addHygieneBreadcrumb('hygiene-run-complete', 'info', {
    deletedSessionFiles: result.deletedSessionFiles,
    deletedSessionBytes: result.deletedSessionBytes,
    removedLegacyFiles: result.removedLegacyFiles.length,
    sessionLogsDeleted: result.sessionLogResult.deleted,
    sessionLogErrors: result.sessionLogResult.errors,
    oldTranscriptsDeleted: result.oldTranscripts.deleted,
    oldTranscriptErrors: result.oldTranscripts.errors,
    totalErrors: result.errors.length,
    durationMs: result.durationMs,
  });

  if (result.errors.length > 0) {
    log.warn({ result }, 'Cloud data hygiene completed with errors');
    // Promote the failure to a captured Sentry event so it surfaces in alerts —
    // breadcrumbs alone can be lost if no later event is captured. Per Phase 7
    // behavioral-safety review, repeated cleanup failures must be observable
    // before they manifest as a crashed cloud-service from a full disk.
    try {
      getErrorReporter().captureMessage('Cloud data hygiene completed with errors', {
        level: 'warning',
        tags: { service: 'cloud-data-hygiene' },
        extra: {
          errorCount: result.errors.length,
          errors: result.errors,
          deletedSessionFiles: result.deletedSessionFiles,
          deletedSessionBytes: result.deletedSessionBytes,
          removedLegacyFiles: result.removedLegacyFiles.length,
          sessionLogErrors: result.sessionLogResult.errors,
          oldTranscriptErrors: result.oldTranscripts.errors,
          durationMs: result.durationMs,
        },
      });
    } catch (reportErr) {
      log.debug({ err: reportErr }, 'Failed to emit hygiene-failure capture event');
    }
  } else {
    log.info(
      {
        deletedSessionFiles: result.deletedSessionFiles,
        deletedSessionBytes: result.deletedSessionBytes,
        removedLegacyFiles: result.removedLegacyFiles.length,
        sessionLogsDeleted: result.sessionLogResult.deleted,
        oldTranscriptsDeleted: result.oldTranscripts.deleted,
        durationMs: result.durationMs,
      },
      'Cloud data hygiene completed',
    );
  }

  return result;
}
