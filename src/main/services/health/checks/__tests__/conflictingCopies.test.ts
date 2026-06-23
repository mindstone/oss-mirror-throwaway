import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Dirent } from 'node:fs';

const mockReaddir = vi.hoisted(() => vi.fn());
// safeWalkDirectory calls fs.realpath up front for cycle detection. The
// tests use a mock workspace path that doesn't exist on disk, so realpath
// has to be stubbed to echo the input back, otherwise the walk bails empty
// before any readdir runs. (See REBEL-506 fix.)
const mockRealpath = vi.hoisted(() => vi.fn(async (p: string) => p));

 
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    default: { ...actual, readdir: mockReaddir, realpath: mockRealpath },
    readdir: mockReaddir,
    realpath: mockRealpath,
  };
});

import { checkConflictingCopies, deriveHealthStatus } from '../conflictingCopies';
import { setPlatformConfig } from '@core/platform';
import {
  JOURNAL_SCHEMA_VERSION,
  SpaceMaintenanceJournal,
  type JournalEntry,
} from '@core/services/spaceMaintenanceJournal';
import {
  RETRY_STATE_SCHEMA_VERSION,
  SpaceMaintenanceRetryStore,
} from '@core/services/spaceMaintenanceRetryState';
import { ORPHAN_STABILITY_MIN_AGE_MS } from '@core/services/spaceMaintenanceService';
import type { AppSettings } from '@shared/types';

function makeDirent(name: string, isFile = true): Dirent {
  return {
    name,
    isFile: () => isFile,
    isDirectory: () => !isFile,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    parentPath: '/mock',
    path: '/mock',
  } as Dirent;
}

const baseSettings = { coreDirectory: '/mock/workspace' } as AppSettings;

describe('checkConflictingCopies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips when library not configured', async () => {
    const result = await checkConflictingCopies({ coreDirectory: null } as unknown as AppSettings);
    expect(result.status).toBe('skip');
  });

  it('passes when no conflicts found', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('README.md'),
      makeDirent('AGENTS.md'),
      makeDirent('notes.md'),
    ]);

    const result = await checkConflictingCopies(baseSettings);
    expect(result.status).toBe('pass');
  });

  it('detects Dropbox conflicted copy pattern', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('README.md'),
      makeDirent("README (conflicted copy 2025-01-15 Josh's MacBook).md"),
    ]);

    const result = await checkConflictingCopies(baseSettings);
    expect(result.status).toBe('warn');
    expect(result.details?.total).toBe(1);
    expect((result.details?.byPattern as Record<string, number>)?.['dropbox-conflict']).toBe(1);
  });

  it('detects numbered copy pattern like (1).md', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('README.md'),
      makeDirent('README (1).md'),
      makeDirent('AGENTS (2).md'),
    ]);

    const result = await checkConflictingCopies(baseSettings);
    expect(result.status).toBe('warn');
    expect(result.details?.total).toBe(2);
    expect((result.details?.byPattern as Record<string, number>)?.['numbered-copy']).toBe(2);
  });

  it('detects folder-level duplicates like "18" + "18 (1)"', async () => {
    mockReaddir.mockImplementation(async (dirPath: string) => {
      if (dirPath === '/mock/workspace') {
        return [
          makeDirent('18', false),
          makeDirent('18 (1)', false),
        ];
      }
      return [];
    });

    const result = await checkConflictingCopies(baseSettings);
    expect(result.status).toBe('warn');
    expect(result.details?.total).toBe(1);
    expect((result.details?.byPattern as Record<string, number>)?.['duplicate-workspace-folder']).toBe(1);
    expect((result.details as Record<string, unknown>)?.folderDuplicateCount).toBe(1);
  });

  it('detects trailing-number folder duplicates like "05-May" + "05-May 2"', async () => {
    mockReaddir.mockImplementation(async (dirPath: string) => {
      if (dirPath === '/mock/workspace') {
        return [
          makeDirent('05-May', false),
          makeDirent('05-May 2', false),
        ];
      }
      return [];
    });

    const result = await checkConflictingCopies(baseSettings);
    expect(result.status).toBe('warn');
    expect((result.details?.byPattern as Record<string, number>)?.['duplicate-workspace-folder']).toBe(1);
    expect((result.details as Record<string, unknown>)?.folderDuplicateCount).toBe(1);
  });

  it('counts mixed file+folder duplicates in one result', async () => {
    mockReaddir.mockImplementation(async (dirPath: string) => {
      if (dirPath === '/mock/workspace') {
        return [
          makeDirent('README (1).md'),
          makeDirent('Project', false),
          makeDirent('Project (1)', false),
        ];
      }
      return [];
    });

    const result = await checkConflictingCopies(baseSettings);
    expect(result.status).toBe('warn');
    expect(result.details?.total).toBe(2);
    const byPattern = result.details?.byPattern as Record<string, number>;
    expect(byPattern['numbered-copy']).toBe(1);
    expect(byPattern['duplicate-workspace-folder']).toBe(1);
    expect((result.details as Record<string, unknown>)?.folderDuplicateCount).toBe(1);
  });

  it('does not false-positive on legitimate names like "Document v2"', async () => {
    mockReaddir.mockImplementation(async (dirPath: string) => {
      if (dirPath === '/mock/workspace') {
        return [makeDirent('Document v2', false)];
      }
      return [];
    });

    const result = await checkConflictingCopies(baseSettings);
    expect(result.status).toBe('pass');
    expect(result.details?.total).toBe(0);
    expect((result.details as Record<string, unknown>)?.folderDuplicateCount).toBe(0);
  });

  it('does not false-positive on "Sprint 1" without sibling "Sprint"', async () => {
    mockReaddir.mockImplementation(async (dirPath: string) => {
      if (dirPath === '/mock/workspace') {
        return [makeDirent('Sprint 1', false)];
      }
      return [];
    });

    const result = await checkConflictingCopies(baseSettings);
    expect(result.status).toBe('pass');
    expect(result.details?.total).toBe(0);
    expect((result.details as Record<string, unknown>)?.folderDuplicateCount).toBe(0);
  });

  it('detects "Copy of" prefix pattern', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('notes.md'),
      makeDirent('Copy of notes.md'),
    ]);

    const result = await checkConflictingCopies(baseSettings);
    expect(result.status).toBe('warn');
    expect((result.details?.byPattern as Record<string, number>)?.['copy-of-duplicate']).toBe(1);
  });

  it('detects "copy" suffix pattern', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('README.md'),
      makeDirent('README copy.md'),
    ]);

    const result = await checkConflictingCopies(baseSettings);
    expect(result.status).toBe('warn');
    expect((result.details?.byPattern as Record<string, number>)?.['copy-suffix-duplicate']).toBe(1);
  });

  it('detects sync conflict timestamp pattern', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('data.json'),
      makeDirent('data-conflict-20250115123456.json'),
    ]);

    const result = await checkConflictingCopies(baseSettings);
    expect(result.status).toBe('warn');
    expect((result.details?.byPattern as Record<string, number>)?.['sync-conflict']).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Regression tests for the shared-pattern consolidation (Stage 1, plan 260411).
  // Before this change, `.conflict-cloud` files were produced by cloudWorkspaceSync
  // but never detected by this health check — a silent gap the consolidation fixes.
  // ---------------------------------------------------------------------------

  it('detects Rebel .conflict-cloud pattern (with extension)', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('README.md'),
      makeDirent('README.conflict-cloud.md'),
    ]);

    const result = await checkConflictingCopies(baseSettings);
    expect(result.status).toBe('warn');
    expect(result.details?.total).toBe(1);
    expect((result.details?.byPattern as Record<string, number>)?.['rebel-cloud-conflict']).toBe(1);
  });

  it('detects Rebel .conflict-cloud pattern (extensionless variant)', async () => {
    // cloudWorkspaceSync.ts:1056-1059 produces `basename.conflict-cloud` when
    // the source file has no extension. The regex must match this form too.
    mockReaddir.mockResolvedValue([
      makeDirent('Makefile'),
      makeDirent('Makefile.conflict-cloud'),
    ]);

    const result = await checkConflictingCopies(baseSettings);
    expect(result.status).toBe('warn');
    expect(result.details?.total).toBe(1);
    expect((result.details?.byPattern as Record<string, number>)?.['rebel-cloud-conflict']).toBe(1);
  });

  it('detects multiple .conflict-cloud files alongside other providers', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('README.conflict-cloud.md'),
      makeDirent('notes.conflict-cloud.md'),
      makeDirent('AGENTS (conflicted copy 2025-01-15).md'),
      makeDirent('data (1).json'),
    ]);

    const result = await checkConflictingCopies(baseSettings);
    expect(result.status).toBe('warn');
    expect(result.details?.total).toBe(4);
    const byPattern = result.details?.byPattern as Record<string, number>;
    expect(byPattern['rebel-cloud-conflict']).toBe(2);
    expect(byPattern['dropbox-conflict']).toBe(1);
    expect(byPattern['numbered-copy']).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // F1 refinement (REBEL-696): a cloud-pull temp file must never be flagged as a
  // conflict copy, even if a crash leaves one behind. The temp name doesn't
  // match CONFLICT_PATTERNS today, but the exclusion makes the scanner robust.
  // ---------------------------------------------------------------------------

  it('does NOT flag a leftover cloud-pull temp file as a conflict', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('README.md'),
      // `.<base>.<uuid>.rebel-cloud-pull.tmp` — the WORKSPACE_SYNC_TEMP_MARKER form.
      makeDirent('.README.md.0f1e2d3c-4b5a-6789-abcd-ef0123456789.rebel-cloud-pull.tmp'),
    ]);

    const result = await checkConflictingCopies(baseSettings);
    expect(result.status).toBe('pass');
    expect(result.details?.total).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Cross-platform regression: Windows-style path segments in the relative
  // path surface. Detection is filename-based so the scan must still work
  // when directories are Windows-rooted (no POSIX separator dependency).
  // ---------------------------------------------------------------------------

  it('handles Windows-style backslash paths (filename-based matching is separator-agnostic)', async () => {
    // The scan walks via path.join which uses the host separator, but pattern
    // matching is against basenames only. Verify filename-only matching
    // survives a workspace whose configured root uses backslashes even when
    // the test is running on POSIX (path.resolve will pass the string through
    // since backslashes aren't significant to POSIX).
    const windowsStyleRoot = 'C:\\Users\\jdoe\\Rebel';
    mockReaddir.mockImplementation(async () => [
      makeDirent('Plan.conflict-cloud.md'),
      makeDirent('doc (1).md'),
    ]);

    const result = await checkConflictingCopies({ coreDirectory: windowsStyleRoot } as AppSettings);
    expect(result.status).toBe('warn');
    expect(result.details?.total).toBe(2);
    const byPattern = result.details?.byPattern as Record<string, number>;
    expect(byPattern['rebel-cloud-conflict']).toBe(1);
    expect(byPattern['numbered-copy']).toBe(1);
  });

  it('returns fail status when 5 or more conflicts found', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('a (1).md'),
      makeDirent('b (1).md'),
      makeDirent('c (1).md'),
      makeDirent('d (1).md'),
      makeDirent('e (1).md'),
    ]);

    const result = await checkConflictingCopies(baseSettings);
    expect(result.status).toBe('fail');
    expect(result.details?.total).toBe(5);
  });

  it('recurses into subdirectories', async () => {
    mockReaddir.mockImplementation(async (dirPath: string) => {
      if (dirPath === '/mock/workspace') {
        return [
          makeDirent('spaces', false),
          makeDirent('README.md'),
        ];
      }
      if (dirPath === '/mock/workspace/spaces') {
        return [makeDirent('Copy of notes.md')];
      }
      return [];
    });

    const result = await checkConflictingCopies(baseSettings);
    expect(result.status).toBe('warn');
    expect(result.details?.total).toBe(1);
  });

  it('skips hidden directories', async () => {
    mockReaddir.mockImplementation(async (dirPath: string) => {
      if (dirPath === '/mock/workspace') {
        return [
          makeDirent('.git', false),
          makeDirent('README.md'),
        ];
      }
      if (dirPath === '/mock/workspace/.git') {
        return [makeDirent('HEAD (1).md')];
      }
      return [];
    });

    const result = await checkConflictingCopies(baseSettings);
    expect(result.status).toBe('pass');
  });

  it('truncates file list in details to 20 entries', async () => {
    const entries = Array.from({ length: 25 }, (_, i) => makeDirent(`file${i} (1).md`));
    mockReaddir.mockResolvedValue(entries);

    const result = await checkConflictingCopies(baseSettings);
    expect(result.status).toBe('fail');
    expect(result.details?.total).toBe(25);
    expect((result.details?.files as unknown[]).length).toBe(20);
    expect(result.details?.truncated).toBe(true);
  });

  it('handles readdir errors gracefully', async () => {
    mockReaddir.mockRejectedValue(new Error('EACCES: permission denied'));

    const result = await checkConflictingCopies(baseSettings);
    expect(result.status).toBe('pass');
  });

  // ===========================================================================
  // Stage 4 (plan 260411): categorical healthStatus + resolutionStats surfacing
  // ===========================================================================

  describe('Stage 4: categorical healthStatus + resolutionStats', () => {
    describe('deriveHealthStatus (pure function)', () => {
      it('healthy when there are no unresolved entries', () => {
        expect(
          deriveHealthStatus({
            resolvedLast24h: 0,
            resolvedTotal: 0,
            pendingMerge: 0,
            pendingUserReview: 0,
            pendingSyncStability: 12,
            legacyDuplicates: 7,
          }),
        ).toBe('healthy');
      });

      it('degraded when 1-4 unresolved (pendingMerge + pendingUserReview)', () => {
        expect(
          deriveHealthStatus({
            resolvedLast24h: 0,
            resolvedTotal: 0,
            pendingMerge: 3,
            pendingUserReview: 0,
            pendingSyncStability: 0,
            legacyDuplicates: 0,
          }),
        ).toBe('degraded');
        expect(
          deriveHealthStatus({
            resolvedLast24h: 0,
            resolvedTotal: 0,
            pendingMerge: 0,
            pendingUserReview: 0,
            pendingSyncStability: 0,
            legacyDuplicates: 0,
          }),
        ).toBe('healthy'); // boundary: 0 unresolved
      });

      it('needs-attention when unresolved >= 5', () => {
        expect(
          deriveHealthStatus({
            resolvedLast24h: 0,
            resolvedTotal: 0,
            pendingMerge: 5,
            pendingUserReview: 0,
            pendingSyncStability: 0,
            legacyDuplicates: 0,
          }),
        ).toBe('needs-attention');
      });

      it('needs-attention escalates on ANY pendingUserReview (circuit-breaker trip)', () => {
        // Even a single needs-review entry must escalate regardless of total
        // unresolved count. Plan §Stage 4 thresholds.
        expect(
          deriveHealthStatus({
            resolvedLast24h: 0,
            resolvedTotal: 0,
            pendingMerge: 0,
            pendingUserReview: 1,
            pendingSyncStability: 0,
            legacyDuplicates: 0,
          }),
        ).toBe('needs-attention');
      });

      it('legacyDuplicates do NOT count as unresolved', () => {
        // 500 legacy duplicates with zero real issues must still be healthy.
        // Plan §Stage 4: legacy duplicates are informational.
        expect(
          deriveHealthStatus({
            resolvedLast24h: 0,
            resolvedTotal: 0,
            pendingMerge: 0,
            pendingUserReview: 0,
            pendingSyncStability: 0,
            legacyDuplicates: 500,
          }),
        ).toBe('healthy');
      });
    });

    describe('details payload (integration with journal + retry-state)', () => {
      let tmpDir: string;
      let userDataDir: string;

      beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'conflict-copies-test-'));
        userDataDir = path.join(tmpDir, 'userData');
        await fs.mkdir(userDataDir, { recursive: true });
        setPlatformConfig({
          userDataPath: userDataDir,
          appPath: tmpDir,
          tempPath: tmpDir,
          logsPath: tmpDir,
          homePath: tmpDir,
          documentsPath: tmpDir,
          desktopPath: tmpDir,
          appDataPath: tmpDir,
          version: '0.0.0-test',
          isPackaged: false,
          platform: process.platform,
          totalMemoryBytes: 16 * 1024 * 1024 * 1024,
          arch: process.arch,
          surface: 'desktop',
          isOss: false,
        });
      });

      afterEach(async () => {
        // Reset by re-setting to a benign desktop config so the final
        // sanity expectation below stays meaningful across runs.
        // (No public resetPlatformConfig; overwriting is the supported reset.)
        try {
          await fs.rm(tmpDir, { recursive: true, force: true });
        } catch { /* ignore */ }
      });

      it('exposes categorical healthStatus and zeroed resolutionStats on fresh install (no state files)', async () => {
        mockReaddir.mockResolvedValue([]);

        const result = await checkConflictingCopies(baseSettings);
        expect(result.status).toBe('pass');
        const details = result.details!;
        expect(details.healthStatus).toBe('healthy');
        expect(details.lastMaintenanceRun).toBeNull();
        expect(details.resolutionStats).toEqual({
          resolvedLast24h: 0,
          resolvedTotal: 0,
          pendingMerge: 0,
          pendingUserReview: 0,
          pendingSyncStability: 0,
          legacyDuplicates: 0,
        });
      });

      it('reads counters from journal + retry-state files (degraded threshold)', async () => {
        // Seed 2 retry-state 'retry' entries (pendingMerge) + 1 orphan in
        // stability-gate window (pendingSyncStability) + 3 legacy duplicates
        // (informational). Expect degraded status (pendingMerge = 2 ∈ [1,4]).
        const journal = new SpaceMaintenanceJournal(userDataDir);
        const nowMs = Date.now();
        const entries: JournalEntry[] = [
          {
            type: 'orphan-candidate',
            conflictPath: '/mock/workspace/orphan.conflict-cloud.md',
            firstSeenAt: nowMs - 1000,
            stableScanCount: 1,
            lastSeenAt: nowMs,
          },
          {
            type: 'legacy-duplicate',
            conflictPath: '/mock/workspace/a (1).md',
            fileMtimeMs: nowMs - 5 * 365 * 24 * 60 * 60 * 1000,
            classifiedAt: nowMs,
          },
          {
            type: 'legacy-duplicate',
            conflictPath: '/mock/workspace/b (1).md',
            fileMtimeMs: nowMs - 5 * 365 * 24 * 60 * 60 * 1000,
            classifiedAt: nowMs,
          },
          {
            type: 'legacy-duplicate',
            conflictPath: '/mock/workspace/c (1).md',
            fileMtimeMs: nowMs - 5 * 365 * 24 * 60 * 60 * 1000,
            classifiedAt: nowMs,
          },
          {
            type: 'resolution-counter',
            total: 42,
            updatedAt: nowMs,
          },
          {
            type: 'resolution-log',
            resolvedAt: nowMs - 60 * 60 * 1000, // 1h ago
            kind: 'conflict-cloud-merged',
          },
          {
            type: 'resolution-log',
            resolvedAt: nowMs - 30 * 60 * 60 * 1000, // 30h ago — outside window, still counted by journal read
            kind: 'numbered-copy-identical',
          },
        ];
        await journal.save({
          schemaVersion: JOURNAL_SCHEMA_VERSION,
          updatedAt: nowMs,
          entries,
        });

        const retryStore = new SpaceMaintenanceRetryStore(userDataDir);
        await retryStore.save({
          schemaVersion: RETRY_STATE_SCHEMA_VERSION,
          updatedAt: nowMs,
          entries: [
            {
              conflictPath: '/mock/workspace/x.conflict-cloud.md',
              conflictHash: 'a'.repeat(64),
              attempts: 1,
              lastAttemptAt: nowMs,
              nextEligibleAt: nowMs + 1000,
              lastError: 'first fail',
              status: 'retry',
            },
            {
              conflictPath: '/mock/workspace/y.conflict-cloud.md',
              conflictHash: 'b'.repeat(64),
              attempts: 2,
              lastAttemptAt: nowMs,
              nextEligibleAt: nowMs + 1000,
              lastError: 'second fail',
              status: 'retry',
            },
          ],
        });

        mockReaddir.mockResolvedValue([]);
        const result = await checkConflictingCopies(baseSettings);

        const details = result.details!;
        const stats = details.resolutionStats as Record<string, number>;
        expect(stats.pendingMerge).toBe(2);
        expect(stats.pendingUserReview).toBe(0);
        expect(stats.pendingSyncStability).toBe(1);
        expect(stats.legacyDuplicates).toBe(3);
        // 30h-ago log is outside the 24h window so it is NOT counted.
        expect(stats.resolvedLast24h).toBe(1);
        expect(stats.resolvedTotal).toBe(42);

        // pendingMerge + pendingUserReview = 2 -> degraded
        expect(details.healthStatus).toBe('degraded');
        // lastMaintenanceRun is the journal.updatedAt timestamp
        expect(typeof details.lastMaintenanceRun).toBe('string');
      });

      it('promotes an orphan past the stability gate to pendingUserReview (not pendingSyncStability)', async () => {
        const journal = new SpaceMaintenanceJournal(userDataDir);
        const nowMs = Date.now();
        // Stability gate: >= 3 scans AND >= 48h age.
        await journal.save({
          schemaVersion: JOURNAL_SCHEMA_VERSION,
          updatedAt: nowMs,
          entries: [
            {
              type: 'orphan-candidate',
              conflictPath: '/mock/workspace/gone.conflict-cloud.md',
              firstSeenAt: nowMs - ORPHAN_STABILITY_MIN_AGE_MS - 1000,
              stableScanCount: 5,
              lastSeenAt: nowMs,
            },
            {
              type: 'numbered-copy-orphan',
              conflictPath: '/mock/workspace/stable-numbered (1).md',
              firstSeenAt: nowMs - ORPHAN_STABILITY_MIN_AGE_MS - 1000,
              stableScanCount: 3,
              lastSeenAt: nowMs,
            },
            {
              type: 'numbered-copy-orphan',
              conflictPath: '/mock/workspace/still-pending (1).md',
              firstSeenAt: nowMs - 60 * 1000,
              stableScanCount: 1,
              lastSeenAt: nowMs,
            },
          ],
        });

        mockReaddir.mockResolvedValue([]);
        const result = await checkConflictingCopies(baseSettings);
        const stats = result.details?.resolutionStats as Record<string, number>;

        expect(stats.pendingUserReview).toBe(2);
        expect(stats.pendingSyncStability).toBe(1);
        // pendingMerge+pendingUserReview = 2, AND pendingUserReview > 0 ->
        // needs-attention per circuit-breaker escalation rule.
        expect(result.details?.healthStatus).toBe('needs-attention');
      });

      it('counts retry-state needs-review entries as pendingUserReview (circuit-breaker)', async () => {
        const retryStore = new SpaceMaintenanceRetryStore(userDataDir);
        const nowMs = Date.now();
        await retryStore.save({
          schemaVersion: RETRY_STATE_SCHEMA_VERSION,
          updatedAt: nowMs,
          entries: [
            {
              conflictPath: '/mock/workspace/wedged.conflict-cloud.md',
              conflictHash: 'a'.repeat(64),
              attempts: 3,
              lastAttemptAt: nowMs,
              nextEligibleAt: nowMs + 1e9,
              lastError: 'gave up',
              status: 'needs-review',
            },
          ],
        });

        mockReaddir.mockResolvedValue([]);
        const result = await checkConflictingCopies(baseSettings);
        const stats = result.details?.resolutionStats as Record<string, number>;

        expect(stats.pendingUserReview).toBe(1);
        expect(stats.pendingMerge).toBe(0);
        expect(result.details?.healthStatus).toBe('needs-attention');
      });

      it('safe-skips when the journal schemaVersion is unknown (forward-compat)', async () => {
        // Write a future-version journal directly. The health check must
        // NOT overwrite the file AND must not throw.
        const journalPath = path.join(userDataDir, 'space-maintenance-journal.json');
        const futureJson = JSON.stringify({
          schemaVersion: 9001,
          updatedAt: 1,
          entries: [{ future: 'data' }],
        });
        await fs.writeFile(journalPath, futureJson);

        mockReaddir.mockResolvedValue([]);
        const result = await checkConflictingCopies(baseSettings);
        const stats = result.details?.resolutionStats as Record<string, number>;

        // Zeros because safe-skip.
        expect(stats.legacyDuplicates).toBe(0);
        expect(stats.pendingSyncStability).toBe(0);
        expect(stats.resolvedTotal).toBe(0);

        // On-disk journal is byte-identical to what we wrote.
        const after = await fs.readFile(journalPath, 'utf8');
        expect(after).toBe(futureJson);
      });

      it('surfaces resolutionStats even when conflicts are also present on disk', async () => {
        // Mix: 3 on-disk numbered copies + 1 resolved in last 24h + 1
        // wedged needs-review entry. Assert both paths coexist.
        mockReaddir.mockResolvedValue([
          makeDirent('a (1).md'),
          makeDirent('b (1).md'),
          makeDirent('c (1).md'),
        ]);

        const nowMs = Date.now();
        const journal = new SpaceMaintenanceJournal(userDataDir);
        await journal.save({
          schemaVersion: JOURNAL_SCHEMA_VERSION,
          updatedAt: nowMs,
          entries: [
            {
              type: 'resolution-counter',
              total: 10,
              updatedAt: nowMs,
            },
            {
              type: 'resolution-log',
              resolvedAt: nowMs - 30 * 60 * 1000,
              kind: 'numbered-copy-merged',
            },
          ],
        });

        const retryStore = new SpaceMaintenanceRetryStore(userDataDir);
        await retryStore.save({
          schemaVersion: RETRY_STATE_SCHEMA_VERSION,
          updatedAt: nowMs,
          entries: [
            {
              conflictPath: '/mock/workspace/foo.conflict-cloud.md',
              conflictHash: 'a'.repeat(64),
              attempts: 3,
              lastAttemptAt: nowMs,
              nextEligibleAt: nowMs + 1e9,
              lastError: 'gave up',
              status: 'needs-review',
            },
          ],
        });

        const result = await checkConflictingCopies(baseSettings);
        expect(result.details?.total).toBe(3);
        const stats = result.details?.resolutionStats as Record<string, number>;
        expect(stats.resolvedLast24h).toBe(1);
        expect(stats.resolvedTotal).toBe(10);
        expect(stats.pendingUserReview).toBe(1);
        expect(result.details?.healthStatus).toBe('needs-attention');
      });
    });
  });

});
