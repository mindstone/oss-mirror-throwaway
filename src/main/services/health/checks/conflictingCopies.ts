/**
 * Conflicting Copies Health Check
 *
 * Detects files in the workspace that appear to be cloud sync conflict copies
 * or accidental duplicates (e.g. "README (1).md", "AGENTS (conflicted copy).md").
 * These can confuse the AI agent by providing stale or duplicate instructions.
 *
 * Stage 4 (docs/plans/260411_shared_space_maintenance.md) augments the details
 * payload with a **categorical** `healthStatus` and `resolutionStats` sourced
 * from the maintenance state files (journal + retry-state) rather than being
 * recomputed here. A numeric 0-100 score was rejected to avoid under-defined
 * downstream arithmetic (plan §Principles #12).
 */

import path from 'node:path';
import type { AppSettings } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { safeWalkDirectory } from '@core/utils/safeWalkDirectory';
import { CONFLICT_PATTERNS, type ConflictLabel } from '@shared/conflictPatterns';
import { ALWAYS_SKIP_DIRS, WORKSPACE_SYNC_TEMP_MARKER } from '@shared/workspaceConstants';
import { getPlatformConfig } from '@core/platform';
import {
  ORPHAN_STABILITY_MIN_AGE_MS,
  ORPHAN_STABILITY_MIN_SCANS,
} from '@core/services/spaceMaintenanceService';
import {
  RESOLUTION_LOG_WINDOW_MS,
  SpaceMaintenanceJournal,
} from '@core/services/spaceMaintenanceJournal';
import { SpaceMaintenanceRetryStore } from '@core/services/spaceMaintenanceRetryState';
import type { CheckResult } from '../types';

const log = createScopedLogger({ service: 'healthCheck:conflictingCopies' });

/**
 * Conflict patterns live in `@shared/conflictPatterns` so the health check,
 * the workspace conflict-listing IPC, and the startup/daily maintenance
 * service all match the same set. Previously this file had its own local
 * copy that was missing `.conflict-cloud` — Rebel's own cloud-sync marker —
 * causing the check to silently miss Rebel-originated conflicts. Fixed in
 * Stage 1 of the shared-space-maintenance plan (260411).
 *
 * Providers handled (see `CONFLICT_PATTERNS` for exact regexes):
 *   - Rebel:        "file.conflict-cloud.md" / "file.conflict-cloud"
 *   - Dropbox:      "file (conflicted copy 2025-01-15 Josh's MacBook).md"
 *   - Google Drive: "file (1).md", "file (2).md"
 *   - Generic:      "Copy of file.md", "file copy.md", "file-conflict-20250115.md"
 */

interface ConflictFile {
  relativePath: string;
  pattern: ConflictLabel | 'duplicate-workspace-folder';
  kind: 'file' | 'folder';
}

const MAX_DEPTH = 4;
const DUPLICATE_WORKSPACE_FOLDER_LABEL = 'Duplicate workspace folders';
const PAREN_SUFFIX_NUMBERED_COPY_REGEX = /(?:^| )\(\d+\)$/;
const TRAILING_NUMBERED_COPY_REGEX = / \d+$/;

function isParenSuffixNumberedDuplicateFolderName(folderName: string): boolean {
  return PAREN_SUFFIX_NUMBERED_COPY_REGEX.test(folderName);
}

function getTrailingNumberedDuplicateBaseName(folderName: string): string | null {
  if (!TRAILING_NUMBERED_COPY_REGEX.test(folderName)) return null;
  const baseName = folderName.replace(TRAILING_NUMBERED_COPY_REGEX, '');
  return baseName.length > 0 ? baseName : null;
}

/**
 * Categorical health surface — deliberately NOT a numeric score.
 * See plan §Principles #12 (Round 2).
 */
export type ConflictHealthStatus = 'healthy' | 'degraded' | 'needs-attention';

/**
 * Counter bundle surfaced on the `details.resolutionStats` payload. Read from
 * the maintenance state files (not recomputed from scratch) so the health
 * surface reflects what the daily pipeline actually did, not what a
 * re-scan would recompute.
 */
export interface ResolutionStats {
  /** Successful resolutions in the last 24h (any kind). Pruned on journal save. */
  resolvedLast24h: number;
  /** Lifetime monotonic counter of successful resolutions on this install. */
  resolvedTotal: number;
  /** Retry-state entries with `status: 'retry'` — awaiting the next run. */
  pendingMerge: number;
  /**
   * Entries surfaced for manual user intervention: retry-state `needs-review`
   * entries (circuit-breaker tripped) PLUS orphan candidates that have
   * cleared the sync-stability gate (>= 3 scans AND >= 48h) — including
   * `.conflict-cloud` orphans and Stage-4 numbered-copy orphans.
   */
  pendingUserReview: number;
  /**
   * Orphan candidates still progressing through the stability gate
   * (stableScanCount < 3 OR age < 48h) — informational, not actionable.
   */
  pendingSyncStability: number;
  /**
   * Numbered-copy files classified as legacy duplicates (mtime > 2 years).
   * Persistent; not counted as unresolved.
   */
  legacyDuplicates: number;
}

async function scanDirectoryForConflicts(
  rootPath: string,
  results: ConflictFile[],
): Promise<void> {
  const directoryNamesByParent = new Map<string, Set<string>>();
  const trailingNumberCandidatesByParent = new Map<string, Map<string, ConflictFile[]>>();

  // Backed by safeWalkDirectory for cycle/depth/path-length protection.
  // Pre-fix this walker had a depth cap but no realpath cycle detection,
  // so a self-nested workspace could still spin (REBEL-506).
  await safeWalkDirectory(rootPath, {
    maxDepth: MAX_DEPTH,
    onDirectory: ({ absolutePath, name, parentDir }) => {
      // Skip hidden dirs and known non-content dirs. Honor ALWAYS_SKIP_DIRS
      // (F8) so the in-workspace `conflicts-cleanup` quarantine is never
      // re-flagged by the health check even if it moves out of a dot-dir.
      if (name.startsWith('.') || name === 'node_modules' || ALWAYS_SKIP_DIRS.has(name)) return false;

      let parentDirNames = directoryNamesByParent.get(parentDir);
      if (!parentDirNames) {
        parentDirNames = new Set<string>();
        directoryNamesByParent.set(parentDir, parentDirNames);
      }
      parentDirNames.add(name);

      const relativePath = path.relative(rootPath, absolutePath);

      if (isParenSuffixNumberedDuplicateFolderName(name)) {
        results.push({ relativePath, pattern: 'duplicate-workspace-folder', kind: 'folder' });
      } else {
        let trailingCandidates = trailingNumberCandidatesByParent.get(parentDir);
        if (!trailingCandidates) {
          trailingCandidates = new Map<string, ConflictFile[]>();
          trailingNumberCandidatesByParent.set(parentDir, trailingCandidates);
        }

        const pendingTrailingCopies = trailingCandidates.get(name);
        if (pendingTrailingCopies) {
          results.push(...pendingTrailingCopies);
          trailingCandidates.delete(name);
        }

        const trailingBaseName = getTrailingNumberedDuplicateBaseName(name);
        if (trailingBaseName) {
          if (parentDirNames.has(trailingBaseName)) {
            results.push({ relativePath, pattern: 'duplicate-workspace-folder', kind: 'folder' });
          } else {
            const pending = trailingCandidates.get(trailingBaseName) ?? [];
            pending.push({ relativePath, pattern: 'duplicate-workspace-folder', kind: 'folder' });
            trailingCandidates.set(trailingBaseName, pending);
          }
        }
      }
      return true;
    },
    onFile: ({ absolutePath, name }) => {
      // Belt-and-braces: a cloud-pull temp file (`.<base>.<uuid>.rebel-cloud-pull.tmp`)
      // is transient and Rebel-owned — never flag it as a conflict copy, even
      // if a crash leaves one behind. It doesn't match CONFLICT_PATTERNS today,
      // but excluding it explicitly keeps the scanner robust to a leftover temp.
      if (name.includes(WORKSPACE_SYNC_TEMP_MARKER)) {
        return;
      }
      for (const { regex, label } of CONFLICT_PATTERNS) {
        if (regex.test(name)) {
          const relativePath = path.relative(rootPath, absolutePath);
          results.push({ relativePath, pattern: label, kind: 'file' });
          break; // one match per file is enough
        }
      }
    },
    onTruncated: ({ reasons, entriesVisited }) => {
      log.debug(
        { rootPath, reasons, entriesVisited },
        'scanDirectoryForConflicts hit a traversal cap — conflict scan may be incomplete',
      );
    },
  });
}

/**
 * Read the maintenance state files and compute the Stage 4 counter bundle.
 * Never throws — returns a zero-filled `ResolutionStats` + `null` timestamp
 * when the files are missing (fresh install / first run) or when either
 * store reports an unknown `schemaVersion` (forward-compat safe-skip).
 */
async function readResolutionStats(
  userDataDir: string,
  nowMs: number,
): Promise<{ stats: ResolutionStats; lastMaintenanceRun: string | null }> {
  const emptyStats: ResolutionStats = {
    resolvedLast24h: 0,
    resolvedTotal: 0,
    pendingMerge: 0,
    pendingUserReview: 0,
    pendingSyncStability: 0,
    legacyDuplicates: 0,
  };

  let lastMaintenanceRun: string | null = null;

  try {
    const journal = new SpaceMaintenanceJournal(userDataDir);
    const { state: journalState, mutable: journalMutable } = await journal.load();

    if (!journalMutable) {
      // Forward-compat safe-skip: we leave the file alone and expose
      // zeros rather than guessing at an unknown schema's shape.
      log.debug(
        { path: journal.getFilePath() },
        'conflictingCopies: journal schemaVersion unknown; surfacing empty stats',
      );
    } else {
      if (journalState.updatedAt > 0) {
        lastMaintenanceRun = new Date(journalState.updatedAt).toISOString();
      }

      const cutoff = nowMs - RESOLUTION_LOG_WINDOW_MS;
      for (const entry of journalState.entries) {
        if (entry.type === 'resolution-log') {
          if (entry.resolvedAt >= cutoff) emptyStats.resolvedLast24h++;
        } else if (entry.type === 'resolution-counter') {
          // Singleton entry — last-write wins when multiple somehow exist.
          emptyStats.resolvedTotal = Math.max(emptyStats.resolvedTotal, entry.total);
        } else if (entry.type === 'legacy-duplicate') {
          emptyStats.legacyDuplicates++;
        } else if (
          entry.type === 'orphan-candidate'
          || entry.type === 'numbered-copy-orphan'
        ) {
          const gatePassed =
            entry.stableScanCount >= ORPHAN_STABILITY_MIN_SCANS
            && (nowMs - entry.firstSeenAt) >= ORPHAN_STABILITY_MIN_AGE_MS;
          if (gatePassed) {
            emptyStats.pendingUserReview++;
          } else {
            emptyStats.pendingSyncStability++;
          }
        }
      }
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'conflictingCopies: failed to read maintenance journal; surfacing zeros',
    );
  }

  try {
    const retryStore = new SpaceMaintenanceRetryStore(userDataDir);
    const { state: retryState, mutable: retryMutable } = await retryStore.load();

    if (retryMutable) {
      for (const entry of retryState.entries) {
        if (entry.status === 'retry') {
          emptyStats.pendingMerge++;
        } else if (entry.status === 'needs-review') {
          emptyStats.pendingUserReview++;
        }
      }
    } else {
      log.debug(
        { path: retryStore.getFilePath() },
        'conflictingCopies: retry-state schemaVersion unknown; surfacing empty stats',
      );
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'conflictingCopies: failed to read maintenance retry-state; surfacing zeros',
    );
  }

  return { stats: emptyStats, lastMaintenanceRun };
}

/**
 * Derive the categorical health status from the resolution stats.
 *
 * Thresholds (plan §Stage 4):
 *   - `healthy`:         0 unresolved conflicts.
 *   - `degraded`:        1-4 unresolved (`pendingMerge + pendingUserReview`).
 *   - `needs-attention`: ≥5 unresolved OR ANY `pendingUserReview` entry.
 *                        Circuit-breaker trips always escalate regardless
 *                        of total volume.
 *
 * Legacy duplicates do NOT count as unresolved — they're informational,
 * awaiting a future bulk-dismiss UX.
 */
export function deriveHealthStatus(stats: ResolutionStats): ConflictHealthStatus {
  const unresolved = stats.pendingMerge + stats.pendingUserReview;
  if (unresolved === 0) return 'healthy';
  if (stats.pendingUserReview > 0 || unresolved >= 5) return 'needs-attention';
  return 'degraded';
}

export async function checkConflictingCopies(settings: AppSettings): Promise<CheckResult> {
  const id = 'conflictingCopies';
  const name = 'Conflicting File Copies';

  if (!settings.coreDirectory) {
    return {
      id,
      name,
      status: 'skip',
      message: 'Library not configured',
    };
  }

  const nowMs = Date.now();
  // Resolve userDataPath via the shared platform config (same surface-gated
  // helper used by `filesystem.ts` and `sync.ts`). Wrap in try/catch so
  // test harnesses that never initialise platform config still get a
  // clean check result rather than an unhandled throw.
  let userDataDir: string | null = null;
  try {
    userDataDir = getPlatformConfig().userDataPath;
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'conflictingCopies: platform config unavailable; stats will be zeroed',
    );
  }

  const { stats: resolutionStats, lastMaintenanceRun } = userDataDir
    ? await readResolutionStats(userDataDir, nowMs)
    : {
        stats: {
          resolvedLast24h: 0,
          resolvedTotal: 0,
          pendingMerge: 0,
          pendingUserReview: 0,
          pendingSyncStability: 0,
          legacyDuplicates: 0,
        } satisfies ResolutionStats,
        lastMaintenanceRun: null as string | null,
      };

  try {
    const rootPath = path.resolve(settings.coreDirectory);
    const conflicts: ConflictFile[] = [];
    await scanDirectoryForConflicts(rootPath, conflicts);

    const healthStatus = deriveHealthStatus(resolutionStats);

    if (conflicts.length === 0) {
      return {
        id,
        name,
        status: 'pass',
        message: 'No conflicting copies detected',
        details: {
          total: 0,
          byPattern: {},
          healthStatus,
          lastMaintenanceRun,
          resolutionStats,
          files: [],
          folderDuplicateCount: 0,
          folderDuplicateLabel: DUPLICATE_WORKSPACE_FOLDER_LABEL,
        },
      };
    }

    const byPattern: Record<string, number> = {};
    for (const c of conflicts) {
      byPattern[c.pattern] = (byPattern[c.pattern] ?? 0) + 1;
    }
    const folderDuplicateCount = byPattern['duplicate-workspace-folder'] ?? 0;
    // Labels are stable kebab-case strings from `@shared/conflictPatterns`.
    // Downstream consumers should treat `byPattern` as informational — only
    // the total count + specific pattern names (e.g. 'rebel-cloud-conflict')
    // are contractual. See docs/plans/260411_shared_space_maintenance.md.

    const status = conflicts.length >= 5 ? 'fail' : 'warn';
    const itemWord = conflicts.length === 1 ? 'item' : 'items';
    const folderSummary = folderDuplicateCount > 0
      ? ` (${DUPLICATE_WORKSPACE_FOLDER_LABEL}: ${folderDuplicateCount})`
      : '';

    return {
      id,
      name,
      status,
      message: `${conflicts.length} conflicting copy ${itemWord} found in Library${folderSummary}`,
      details: {
        total: conflicts.length,
        byPattern,
        healthStatus,
        lastMaintenanceRun,
        resolutionStats,
        folderDuplicateCount,
        folderDuplicateLabel: DUPLICATE_WORKSPACE_FOLDER_LABEL,
        files: conflicts.slice(0, 20).map(c => ({ path: c.relativePath, type: c.pattern })),
        truncated: conflicts.length > 20,
      },
      remediation: 'Review and delete the duplicate/conflict files. They may have been created by cloud storage sync.',
    };
  } catch (error) {
    log.warn({ err: error }, 'Conflicting copies check failed unexpectedly');
    return {
      id,
      name,
      status: 'warn',
      message: 'Check failed unexpectedly',
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}
