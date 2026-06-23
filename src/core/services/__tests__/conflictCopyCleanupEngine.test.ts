/**
 * Stage 2 tests for the REBEL-62A one-off conflict-copy cleanup ENGINE:
 *   - `detectConflictCopyCleanup` (read-only bulk scan -> plan + JSONL manifest)
 *   - `executeConflictCopyCleanup` (MOVE identical copies into the in-workspace
 *     `.rebel/conflicts-cleanup/<date>/` quarantine, never trash/unlink)
 *   - the `conflicts-cleanup` sync-exclusion (`ALWAYS_SKIP_DIRS`)
 *   - the Phase-6 safety fixes (F1 crash-resume, F2 no-overwrite, F3 no-unlink
 *     on EXDEV, F4 untrusted-path rejection, F7 no empty manifest).
 *
 * Strategy mirrors the existing maintenance/driveAware suites: real `node:fs`
 * temp dirs + injected clock + injected lease. No filesystem mocks.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  detectConflictCopyCleanup,
  executeConflictCopyCleanup,
  runStartupCleanup,
  CONFLICT_CLEANUP_RUNS_DIRNAME,
} from '../spaceMaintenanceService';
import {
  SpaceMaintenanceJournal,
  JOURNAL_SCHEMA_VERSION,
  type CleanupMovePendingEntry,
} from '../spaceMaintenanceJournal';
import { ALWAYS_SKIP_DIRS } from '@shared/workspaceConstants';

const FIXED_NOW = Date.UTC(2026, 5, 1, 12, 0, 0); // 2026-06-01
const DATE_DIR = '2026-06-01';

async function readManifest(manifestPath: string): Promise<Array<Record<string, unknown>>> {
  const body = await fs.readFile(manifestPath, 'utf8');
  return body
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

describe('conflict-copy cleanup engine (Stage 2)', () => {
  let spaceRoot: string;
  let manifestDir: string;
  let userDataDir: string;

  beforeEach(async () => {
    spaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccc-space-'));
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccc-userdata-'));
    manifestDir = userDataDir;
  });

  afterEach(async () => {
    await fs.rm(spaceRoot, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  /**
   * Conflict-storm fixture:
   *   notes.md                      (original)
   *   notes (1).md                  identical -> quarantine (numbered-copy)
   *   notes (1) (1).md              identical to notes (1).md -> quarantine (nested chain)
   *   report.md                     (original)
   *   report (1).md                 DIFFERING -> needs-review
   *   placeholder.md                (0-byte original)
   *   placeholder (1).md            0-byte twin -> needs-review (empty)
   *   Copy of plan.md               copy-of label -> needs-review (detect-only)
   *   plan.md                       (original, present so copy-of has a parent)
   */
  async function writeStormFixture(): Promise<void> {
    await fs.writeFile(path.join(spaceRoot, 'notes.md'), 'note body', 'utf8');
    await fs.writeFile(path.join(spaceRoot, 'notes (1).md'), 'note body', 'utf8');
    await fs.writeFile(path.join(spaceRoot, 'notes (1) (1).md'), 'note body', 'utf8');

    await fs.writeFile(path.join(spaceRoot, 'report.md'), 'original report', 'utf8');
    await fs.writeFile(path.join(spaceRoot, 'report (1).md'), 'EDITED report', 'utf8');

    await fs.writeFile(path.join(spaceRoot, 'placeholder.md'), '', 'utf8');
    await fs.writeFile(path.join(spaceRoot, 'placeholder (1).md'), '', 'utf8');

    await fs.writeFile(path.join(spaceRoot, 'plan.md'), 'plan body', 'utf8');
    await fs.writeFile(path.join(spaceRoot, 'Copy of plan.md'), 'plan body', 'utf8');
  }

  const okLease = () => ({
    acquired: true as const,
    release: vi.fn(async () => {}),
  });

  describe('detectConflictCopyCleanup (read-only)', () => {
    it('returns the right plan, writes a manifest, and moves nothing', async () => {
      await writeStormFixture();

      const result = await detectConflictCopyCleanup(spaceRoot, {
        manifestDir,
        now: () => FIXED_NOW,
        runId: 'run-detect-1',
      });

      const quarantined = result.plan.toQuarantine.map((q) => q.relPath).sort();
      expect(quarantined).toEqual(['notes (1) (1).md', 'notes (1).md']);

      const reviewByRel = new Map(result.plan.needsReview.map((r) => [r.relPath, r.reason]));
      expect(reviewByRel.get('report (1).md')).toBe('differing-from-parent');
      expect(reviewByRel.get('placeholder (1).md')).toBe('empty-or-placeholder');
      expect(reviewByRel.get('Copy of plan.md')).toBe('detect-only-label');

      // Manifest written under userData/<runs-dir>/<runId>.jsonl
      expect(result.manifestPath).toBe(
        path.join(manifestDir, CONFLICT_CLEANUP_RUNS_DIRNAME, 'run-detect-1.jsonl'),
      );
      const rows = await readManifest(result.manifestPath);
      const quarantineRows = rows.filter((r) => r.action === 'quarantine');
      const reviewRows = rows.filter((r) => r.action === 'review');
      expect(quarantineRows).toHaveLength(2);
      expect(reviewRows.length).toBeGreaterThanOrEqual(3);
      // Manifest field shape.
      const sample = quarantineRows[0];
      expect(sample.runId).toBe('run-detect-1');
      expect(typeof sample.immediateParent).toBe('string');
      expect(typeof sample.hash).toBe('string');
      expect(typeof sample.timestamp).toBe('number');

      // READ-ONLY: every source file still present; no quarantine dir created.
      for (const name of [
        'notes.md',
        'notes (1).md',
        'notes (1) (1).md',
        'report (1).md',
        'placeholder (1).md',
        'Copy of plan.md',
      ]) {
        expect(await exists(path.join(spaceRoot, name))).toBe(true);
      }
      expect(await exists(path.join(spaceRoot, '.rebel', 'conflicts-cleanup'))).toBe(false);
    });

    it('F7: writes NO manifest file when the plan is empty', async () => {
      await fs.writeFile(path.join(spaceRoot, 'just-a-file.md'), 'no conflicts here', 'utf8');

      const result = await detectConflictCopyCleanup(spaceRoot, {
        manifestDir,
        now: () => FIXED_NOW,
        runId: 'run-empty-1',
      });

      expect(result.plan.toQuarantine).toEqual([]);
      expect(result.plan.needsReview).toEqual([]);
      // The path is returned, but the file is NOT created.
      expect(await exists(result.manifestPath)).toBe(false);
    });
  });

  describe('executeConflictCopyCleanup (move-only)', () => {
    it('moves ONLY the identical set into .rebel/conflicts-cleanup/<date>/; others remain; not re-detected; lease acquired', async () => {
      await writeStormFixture();

      const detected = await detectConflictCopyCleanup(spaceRoot, {
        manifestDir,
        now: () => FIXED_NOW,
        runId: 'run-exec-1',
      });

      const journal = new SpaceMaintenanceJournal(userDataDir);
      const acquireLease = vi.fn(async () => okLease());

      const execResult = await executeConflictCopyCleanup(
        spaceRoot,
        detected.runId,
        { journal, manifestDir, acquireLease },
        { now: () => FIXED_NOW },
      );

      expect(acquireLease).toHaveBeenCalledTimes(1);
      expect(execResult.leaseContended).toBe(false);
      expect(execResult.quarantined).toBe(2);
      expect(execResult.skipped).toBe(0);
      expect(execResult.errors).toEqual([]);

      const qRoot = path.join(spaceRoot, '.rebel', 'conflicts-cleanup', DATE_DIR);
      // Identical copies MOVED into the quarantine (relative structure preserved).
      expect(await exists(path.join(qRoot, 'notes (1).md'))).toBe(true);
      expect(await exists(path.join(qRoot, 'notes (1) (1).md'))).toBe(true);
      // ...and gone from their original location.
      expect(await exists(path.join(spaceRoot, 'notes (1).md'))).toBe(false);
      expect(await exists(path.join(spaceRoot, 'notes (1) (1).md'))).toBe(false);

      // Originals + differing + empty + copy-of UNTOUCHED.
      for (const name of [
        'notes.md',
        'report.md',
        'report (1).md',
        'placeholder.md',
        'placeholder (1).md',
        'plan.md',
        'Copy of plan.md',
      ]) {
        expect(await exists(path.join(spaceRoot, name))).toBe(true);
      }

      // Re-scan after execute: the quarantine is NOT re-detected.
      const rescan = await detectConflictCopyCleanup(spaceRoot, {
        manifestDir,
        now: () => FIXED_NOW,
        runId: 'run-rescan-1',
      });
      const rescanQuarantine = rescan.plan.toQuarantine.map((q) => q.relPath);
      expect(rescanQuarantine).toEqual([]); // both identicals already quarantined + excluded

      // F6: execute rows carry the detect runId + are appended per item.
      const rows = await readManifest(detected.manifestPath);
      const quarantinedRows = rows.filter((r) => r.action === 'quarantined');
      expect(quarantinedRows.length).toBe(2);
      expect(quarantinedRows.every((r) => r.runId === 'run-exec-1')).toBe(true);
    });

    it('skips + records a file whose bytes changed between detect and execute (rehash-race)', async () => {
      await fs.writeFile(path.join(spaceRoot, 'notes.md'), 'note body', 'utf8');
      await fs.writeFile(path.join(spaceRoot, 'notes (1).md'), 'note body', 'utf8');

      const detected = await detectConflictCopyCleanup(spaceRoot, {
        manifestDir,
        now: () => FIXED_NOW,
        runId: 'run-race-1',
      });
      expect(detected.plan.toQuarantine.map((q) => q.relPath)).toEqual(['notes (1).md']);

      // Mutate the conflict copy AFTER detect, BEFORE execute.
      await fs.writeFile(path.join(spaceRoot, 'notes (1).md'), 'RACED new content', 'utf8');

      const journal = new SpaceMaintenanceJournal(userDataDir);
      const execResult = await executeConflictCopyCleanup(
        spaceRoot,
        detected.runId,
        { journal, manifestDir },
        { now: () => FIXED_NOW },
      );

      expect(execResult.quarantined).toBe(0);
      expect(execResult.skipped).toBe(1);
      // File left in place (not moved).
      expect(await exists(path.join(spaceRoot, 'notes (1).md'))).toBe(true);
      expect(
        await exists(path.join(spaceRoot, '.rebel', 'conflicts-cleanup', DATE_DIR, 'notes (1).md')),
      ).toBe(false);

      const rows = await readManifest(detected.manifestPath);
      expect(rows.some((r) => r.action === 'skipped-rehash')).toBe(true);
    });

    it('F4/M2: skips the whole batch when the lease is contended', async () => {
      await fs.writeFile(path.join(spaceRoot, 'notes.md'), 'note body', 'utf8');
      await fs.writeFile(path.join(spaceRoot, 'notes (1).md'), 'note body', 'utf8');

      const detected = await detectConflictCopyCleanup(spaceRoot, {
        manifestDir,
        now: () => FIXED_NOW,
        runId: 'run-lease-1',
      });

      const journal = new SpaceMaintenanceJournal(userDataDir);
      const release = vi.fn(async () => {});
      const execResult = await executeConflictCopyCleanup(
        spaceRoot,
        detected.runId,
        { journal, manifestDir, acquireLease: async () => ({ acquired: false, release }) },
        { now: () => FIXED_NOW },
      );

      expect(execResult.leaseContended).toBe(true);
      expect(execResult.quarantined).toBe(0);
      // Nothing moved; release NOT called (we never held it).
      expect(await exists(path.join(spaceRoot, 'notes (1).md'))).toBe(true);
    });

    it('does not follow a directory symlink that escapes the space root', async () => {
      // Outside-the-space target containing a would-be conflict copy.
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ccc-outside-'));
      try {
        await fs.writeFile(path.join(outside, 'secret.md'), 'x', 'utf8');
        await fs.writeFile(path.join(outside, 'secret (1).md'), 'x', 'utf8');
        await fs.writeFile(path.join(spaceRoot, 'inside.md'), 'y', 'utf8');
        await fs.symlink(outside, path.join(spaceRoot, 'escape-link'), 'dir');

        const detected = await detectConflictCopyCleanup(spaceRoot, {
          manifestDir,
          now: () => FIXED_NOW,
          runId: 'run-symlink-1',
        });
        // The escaping symlink dir is NOT walked, so its conflict copy is invisible.
        const allRels = [
          ...detected.plan.toQuarantine.map((q) => q.relPath),
          ...detected.plan.needsReview.map((r) => r.relPath),
        ];
        expect(allRels.some((r) => r.includes('escape-link'))).toBe(false);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });
  });

  describe('Phase-6 safety fixes', () => {
    it('F2: two identical files mapping to the same dest are BOTH preserved (no overwrite)', async () => {
      // Two files in different subdirs whose basenames collide at the dest
      // would normally map to the same `<date>/<relPath>` only if relPaths
      // collide. To force a same-dest collision deterministically, pre-create
      // the dest from a prior same-day run, then quarantine a new copy.
      await fs.writeFile(path.join(spaceRoot, 'notes.md'), 'note body', 'utf8');
      await fs.writeFile(path.join(spaceRoot, 'notes (1).md'), 'note body', 'utf8');

      // Simulate a prior same-day run that already quarantined `notes (1).md`
      // with DIFFERENT bytes — must NOT be overwritten.
      const qDir = path.join(spaceRoot, '.rebel', 'conflicts-cleanup', DATE_DIR);
      await fs.mkdir(qDir, { recursive: true });
      await fs.writeFile(path.join(qDir, 'notes (1).md'), 'PRIOR quarantined bytes', 'utf8');

      const detected = await detectConflictCopyCleanup(spaceRoot, {
        manifestDir,
        now: () => FIXED_NOW,
        runId: 'run-collide-1',
      });

      const journal = new SpaceMaintenanceJournal(userDataDir);
      const execResult = await executeConflictCopyCleanup(
        spaceRoot,
        detected.runId,
        { journal, manifestDir },
        { now: () => FIXED_NOW },
      );

      expect(execResult.quarantined).toBe(1);
      // The prior quarantined copy is untouched.
      expect(await fs.readFile(path.join(qDir, 'notes (1).md'), 'utf8')).toBe(
        'PRIOR quarantined bytes',
      );
      // The new copy landed at a non-colliding suffix.
      expect(await fs.readFile(path.join(qDir, 'notes (1) (1).md'), 'utf8')).toBe('note body');
      // Source is gone (moved, not left, not the prior one overwritten).
      expect(await exists(path.join(spaceRoot, 'notes (1).md'))).toBe(false);
    });

    it('F3: an injected rename failure leaves the source in place + records an error (never unlinks)', async () => {
      await fs.writeFile(path.join(spaceRoot, 'notes.md'), 'note body', 'utf8');
      await fs.writeFile(path.join(spaceRoot, 'notes (1).md'), 'note body', 'utf8');

      const detected = await detectConflictCopyCleanup(spaceRoot, {
        manifestDir,
        now: () => FIXED_NOW,
        runId: 'run-exdev-1',
      });

      // Inject an EXDEV ONLY for the move of the source file (not for the
      // journal's tmp->file rename, which also goes through fs.rename).
      const realRename = fs.rename.bind(fs);
      const sourceAbs = path.join(spaceRoot, 'notes (1).md');
      const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (from === sourceAbs) {
          const err = new Error('cross-device link not permitted') as NodeJS.ErrnoException;
          err.code = 'EXDEV';
          throw err;
        }
        return realRename(from as string, to as string);
      });
      // Guard: unlink must NEVER be called by the cleanup move.
      const unlinkSpy = vi.spyOn(fs, 'unlink');

      try {
        const journal = new SpaceMaintenanceJournal(userDataDir);
        const execResult = await executeConflictCopyCleanup(
          spaceRoot,
          detected.runId,
          { journal, manifestDir },
          { now: () => FIXED_NOW },
        );

        expect(execResult.quarantined).toBe(0);
        expect(execResult.errors.length).toBeGreaterThan(0);
        expect(execResult.errors.some((e) => /move failed/.test(e))).toBe(true);
        // Source LEFT in place (never unlinked).
        expect(await exists(path.join(spaceRoot, 'notes (1).md'))).toBe(true);
        expect(await fs.readFile(path.join(spaceRoot, 'notes (1).md'), 'utf8')).toBe('note body');
        // No unlink of the source path.
        expect(
          unlinkSpy.mock.calls.some(([p]) => p === path.join(spaceRoot, 'notes (1).md')),
        ).toBe(false);
      } finally {
        renameSpy.mockRestore();
        unlinkSpy.mockRestore();
      }
    });

    it('F4: a manifest row with a ../escape relPath is rejected + skipped; nothing moved outside root', async () => {
      // Hand-craft a malicious manifest as if a tampered/stale plan was fed in.
      const runId = 'run-escape-1';
      const manifestPath = path.join(manifestDir, CONFLICT_CLEANUP_RUNS_DIRNAME, `${runId}.jsonl`);
      await fs.mkdir(path.dirname(manifestPath), { recursive: true });

      // A real file OUTSIDE the space root we must never touch.
      const outsideDir = path.dirname(spaceRoot);
      const victim = path.join(outsideDir, 'VICTIM.md');
      await fs.writeFile(victim, 'do not move me', 'utf8');

      const evilRow = {
        runId,
        timestamp: FIXED_NOW,
        relPath: '../VICTIM.md',
        immediateParent: '../VICTIM-parent.md',
        label: 'numbered-copy',
        provider: 'google_drive',
        hash: 'deadbeef',
        action: 'quarantine',
        reason: 'identical-to-immediate-parent',
      };
      await fs.writeFile(manifestPath, JSON.stringify(evilRow) + '\n', 'utf8');

      const journal = new SpaceMaintenanceJournal(userDataDir);
      const execResult = await executeConflictCopyCleanup(
        spaceRoot,
        runId,
        { journal, manifestDir },
        { now: () => FIXED_NOW },
      );

      expect(execResult.quarantined).toBe(0);
      expect(execResult.skipped).toBe(1);
      expect(execResult.errors.some((e) => /unsafe relPath/.test(e))).toBe(true);
      // The victim is untouched; never moved into the quarantine.
      expect(await exists(victim)).toBe(true);
      expect(await fs.readFile(victim, 'utf8')).toBe('do not move me');

      await fs.rm(victim, { force: true });
    });

    it('F1: a crashed cleanup move (cleanup-move-pending) RESUMES the in-workspace move; never OS-trashed', async () => {
      // Simulate the crash: write the cleanup-move-pending journal entry but
      // do NOT perform the move (process died after journal write).
      await fs.writeFile(path.join(spaceRoot, 'notes.md'), 'note body', 'utf8');
      const sourceAbs = path.join(spaceRoot, 'notes (1).md');
      await fs.writeFile(sourceAbs, 'note body', 'utf8');

      const crypto = await import('node:crypto');
      const expectedHash = crypto
        .createHash('sha256')
        .update('note body')
        .digest('hex');

      const destAbs = path.join(
        spaceRoot,
        '.rebel',
        'conflicts-cleanup',
        DATE_DIR,
        'notes (1).md',
      );

      const journal = new SpaceMaintenanceJournal(userDataDir);
      const pending: CleanupMovePendingEntry = {
        type: 'cleanup-move-pending',
        conflictPath: sourceAbs,
        destPath: destAbs,
        expectedHash,
        attemptedAt: FIXED_NOW,
      };
      await journal.save({
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        updatedAt: FIXED_NOW,
        entries: [pending],
      });

      // Recovery path: moveToTrash MUST NEVER be called for a cleanup entry.
      const moveToTrash = vi.fn(async () => {});

      await runStartupCleanup(
        spaceRoot,
        { spaces: [] } as never,
        journal,
        { moveToTrash },
        { now: () => FIXED_NOW },
      );

      // The source was MOVED into the quarantine, NOT trashed.
      expect(moveToTrash).not.toHaveBeenCalled();
      expect(await exists(sourceAbs)).toBe(false);
      expect(await exists(destAbs)).toBe(true);
      expect(await fs.readFile(destAbs, 'utf8')).toBe('note body');

      // The journal entry was cleared on resolution.
      const after = await journal.load();
      expect(after.state.entries.some((e) => e.type === 'cleanup-move-pending')).toBe(false);
    });
  });

  describe('sync exclusion', () => {
    it('includes conflicts-cleanup in ALWAYS_SKIP_DIRS', () => {
      expect(ALWAYS_SKIP_DIRS.has('conflicts-cleanup')).toBe(true);
    });
  });
});
