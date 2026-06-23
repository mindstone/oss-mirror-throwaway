/**
 * Tests for spaceMaintenanceService (Stages 1 + 2).
 *
 * Strategy: real temp-directory filesystem + injected `moveToTrash` +
 * injected `now` clock. Avoids vi.mock('node:fs/promises') fragility and
 * exercises the real scan/classify code paths end-to-end.
 *
 * Stage 2 tests add coverage for the LLM merge pipeline by mocking
 * `proposeMerge` at the workspaceConflictResolver boundary.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';

// Mock the BTS layer so proposeMerge never calls out over the network.
 
vi.mock('@core/services/behindTheScenesClient', () => ({
  callWithModelAuthAware: vi.fn(),
}));

// The workspace merge prompt is fetched via promptFileService, which
// reads from disk at call time. Stage 2 mocks proposeMerge directly so
// the prompt service never runs — but we still need a safe default for
// other tests in this file that don't opt in to the mock.
 
vi.mock('@core/services/promptFileService', async () => {
  const actual = await vi.importActual<typeof import('@core/services/promptFileService')>(
    '@core/services/promptFileService',
  );
  return {
    ...actual,
    getPrompt: () => 'mock workspace-merge prompt',
  };
});

import {
  classifyConflictCloud,
  DEFAULT_STARTUP_TIME_BUDGET_MS,
  evaluateMergeGuards,
  MAX_ENTRIES_PER_DIR,
  ORPHAN_STABILITY_MIN_AGE_MS,
  ORPHAN_STABILITY_MIN_SCANS,
  repairBrokenFrontmatter,
  runDailyMaintenance,
  runStartupCleanup,
  scanConflicts,
  type DailyMaintenanceDeps,
  type MaintenanceDeps,
} from '../spaceMaintenanceService';
import * as bts from '../behindTheScenesClient';
import * as resolver from '../workspaceConflictResolver';
import {
  createEmptyJournalState,
  SpaceMaintenanceJournal,
  type JournalEntry,
} from '../spaceMaintenanceJournal';
import {
  resetNeedsReview,
  RETRY_STATE_SCHEMA_VERSION,
  SpaceMaintenanceRetryStore,
} from '../spaceMaintenanceRetryState';

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    spaces: undefined,
    ...overrides,
  } as AppSettings;
}

async function writeFile(p: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
}

describe('spaceMaintenanceService', () => {
  let tmpDir: string;
  let userDataDir: string;
  let coreDir: string;
  let journal: SpaceMaintenanceJournal;
  let moveToTrashMock: ReturnType<typeof vi.fn<(absolutePath: string) => Promise<void>>>;
  let deps: MaintenanceDeps;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'space-maint-'));
    userDataDir = path.join(tmpDir, 'userData');
    coreDir = path.join(tmpDir, 'library');
    await fs.mkdir(userDataDir, { recursive: true });
    await fs.mkdir(coreDir, { recursive: true });
    journal = new SpaceMaintenanceJournal(userDataDir);
    moveToTrashMock = vi.fn<(absolutePath: string) => Promise<void>>().mockResolvedValue(undefined);
    deps = { moveToTrash: moveToTrashMock };
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  // ---------------------------------------------------------------------------
  // scanConflicts: pattern coverage
  // ---------------------------------------------------------------------------

  describe('scanConflicts', () => {
    it('finds conflicts across every supported pattern', async () => {
      await writeFile(path.join(coreDir, 'README.md'), 'hello');
      await writeFile(path.join(coreDir, 'README.conflict-cloud.md'), 'conflict');
      await writeFile(path.join(coreDir, 'Makefile.conflict-cloud'), 'make');
      await writeFile(path.join(coreDir, "Plan (conflicted copy 2025-01-15 Mac).md"), 'dup');
      await writeFile(path.join(coreDir, 'data (1).json'), '{}');
      await writeFile(path.join(coreDir, 'Copy of notes.md'), 'copy');
      await writeFile(path.join(coreDir, 'Drafts copy.md'), 'copy');
      await writeFile(path.join(coreDir, 'log-conflict-20250115123456.txt'), 'log');

      const results = await scanConflicts(coreDir, makeSettings(), createEmptyJournalState());
      const labels = results.map((r) => r.label).sort();

      expect(labels).toEqual([
        'copy-of-duplicate',
        'copy-suffix-duplicate',
        'dropbox-conflict',
        'numbered-copy',
        'rebel-cloud-conflict',
        'rebel-cloud-conflict',
        'sync-conflict',
      ]);

      // Every conflict must have its originalPath derived (non-null for these patterns).
      for (const r of results) {
        expect(r.originalPath).not.toBeNull();
      }
    });

    it('skips hidden directories and node_modules', async () => {
      await writeFile(path.join(coreDir, 'foo.conflict-cloud.md'), 'x');
      await writeFile(path.join(coreDir, '.git', 'HEAD.conflict-cloud'), 'x');
      await writeFile(path.join(coreDir, 'node_modules', 'pkg (1).md'), 'x');

      const results = await scanConflicts(coreDir, makeSettings(), createEmptyJournalState());
      expect(results).toHaveLength(1);
      expect(results[0].label).toBe('rebel-cloud-conflict');
    });

    it('respects MAX_ENTRIES_PER_DIR cap', async () => {
      // 501 matching files in a single directory — one should be dropped.
      for (let i = 0; i < MAX_ENTRIES_PER_DIR + 1; i++) {
        await writeFile(path.join(coreDir, `file${i}.conflict-cloud.md`), 'x');
      }
      const results = await scanConflicts(coreDir, makeSettings(), createEmptyJournalState());
      expect(results.length).toBeLessThanOrEqual(MAX_ENTRIES_PER_DIR);
    });

    it('filters to non-private shared spaces when settings.spaces is set', async () => {
      await fs.mkdir(path.join(coreDir, 'Private'), { recursive: true });
      await fs.mkdir(path.join(coreDir, 'Team'), { recursive: true });
      await writeFile(path.join(coreDir, 'Private', 'secret.conflict-cloud.md'), 'x');
      await writeFile(path.join(coreDir, 'Team', 'notes.conflict-cloud.md'), 'y');

      const settings = makeSettings({
        spaces: [
          { name: 'Private', path: 'Private', type: 'personal', isSymlink: false, sharing: 'private', createdAt: 0 },
          { name: 'Team', path: 'Team', type: 'team', isSymlink: false, sharing: 'restricted', createdAt: 0 },
        ],
      });

      const results = await scanConflicts(coreDir, settings, createEmptyJournalState());
      expect(results).toHaveLength(1);
      expect(results[0].absolutePath).toBe(path.join(coreDir, 'Team', 'notes.conflict-cloud.md'));
    });
  });

  // ---------------------------------------------------------------------------
  // classifyConflictCloud: status discrimination
  // ---------------------------------------------------------------------------

  describe('classifyConflictCloud', () => {
    it('returns identical (with hashes) when conflict and original match byte-for-byte', async () => {
      const conflict = path.join(coreDir, 'notes.conflict-cloud.md');
      const original = path.join(coreDir, 'notes.md');
      await writeFile(conflict, 'same bytes');
      await writeFile(original, 'same bytes');

      const result = await classifyConflictCloud(conflict, original);
      expect(result.status).toBe('identical');
      // Classification-time hashes are exposed so the pre-quarantine
      // re-hash (F7) can compare against them.
      expect(result.conflictHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.originalHash).toBe(result.conflictHash);
    });

    it('returns differing when conflict and original differ', async () => {
      const conflict = path.join(coreDir, 'notes.conflict-cloud.md');
      const original = path.join(coreDir, 'notes.md');
      await writeFile(conflict, 'version A');
      await writeFile(original, 'version B');

      const result = await classifyConflictCloud(conflict, original);
      expect(result.status).toBe('differing');
      expect(result.conflictHash).toBeUndefined();
      expect(result.originalHash).toBeUndefined();
    });

    it('returns orphaned when original does not exist', async () => {
      const conflict = path.join(coreDir, 'notes.conflict-cloud.md');
      await writeFile(conflict, 'orphan');

      const original = path.join(coreDir, 'notes.md');
      expect((await classifyConflictCloud(conflict, original)).status).toBe('orphaned');
    });

    it('returns orphaned when original is null', async () => {
      const conflict = path.join(coreDir, 'notes.conflict-cloud.md');
      await writeFile(conflict, 'orphan');

      expect((await classifyConflictCloud(conflict, null)).status).toBe('orphaned');
    });

    it('returns binary when the conflict file contains null bytes', async () => {
      const conflict = path.join(coreDir, 'image.conflict-cloud.png');
      const original = path.join(coreDir, 'image.png');
      const binary = Buffer.concat([Buffer.from('PNG'), Buffer.from([0x00, 0x00, 0x00, 0x01])]);
      await writeFile(conflict, binary);
      await writeFile(original, binary);

      expect((await classifyConflictCloud(conflict, original)).status).toBe('binary');
    });
  });

  // ---------------------------------------------------------------------------
  // runStartupCleanup: identical quarantine + stability gate + dry-run
  // ---------------------------------------------------------------------------

  describe('runStartupCleanup', () => {
    it('quarantines identical .conflict-cloud files via moveToTrash', async () => {
      const original = path.join(coreDir, 'notes.md');
      const conflict = path.join(coreDir, 'notes.conflict-cloud.md');
      await writeFile(original, 'same');
      await writeFile(conflict, 'same');

      const result = await runStartupCleanup(coreDir, makeSettings(), journal, deps);

      expect(result.quarantinedIdentical).toBe(1);
      expect(result.errors).toEqual([]);
      expect(moveToTrashMock).toHaveBeenCalledTimes(1);
      expect(moveToTrashMock).toHaveBeenCalledWith(conflict);
    });

    it('leaves differing .conflict-cloud files in place', async () => {
      const original = path.join(coreDir, 'notes.md');
      const conflict = path.join(coreDir, 'notes.conflict-cloud.md');
      await writeFile(original, 'A');
      await writeFile(conflict, 'B');

      const result = await runStartupCleanup(coreDir, makeSettings(), journal, deps);

      expect(result.quarantinedIdentical).toBe(0);
      expect(result.remainingConflicts).toBe(1);
      expect(moveToTrashMock).not.toHaveBeenCalled();
      // File still present on disk.
      expect(fsSync.existsSync(conflict)).toBe(true);
    });

    it('ignores non-rebel conflict patterns in Stage 1 (never calls moveToTrash)', async () => {
      await writeFile(path.join(coreDir, 'base.md'), 'hi');
      await writeFile(path.join(coreDir, 'base (1).md'), 'hi');
      await writeFile(path.join(coreDir, 'Copy of base.md'), 'hi');

      const result = await runStartupCleanup(coreDir, makeSettings(), journal, deps);
      expect(moveToTrashMock).not.toHaveBeenCalled();
      expect(result.quarantinedIdentical).toBe(0);
      expect(result.remainingConflicts).toBe(2);
    });

    // ---- Sync-stability gate -------------------------------------------------

    it('keeps orphans in pending-review on the first sighting, advances counter each scan, and marks orphaned once both thresholds pass', async () => {
      const conflict = path.join(coreDir, 'gone.conflict-cloud.md');
      await writeFile(conflict, 'orphan bytes');
      // Note: the base file `gone.md` is intentionally absent.

      // --- Scan 1: first sighting ---
      const t0 = 1_700_000_000_000;
      const r1 = await runStartupCleanup(
        coreDir,
        makeSettings(),
        journal,
        deps,
        { now: () => t0 },
      );
      expect(r1.orphansDeferred).toBe(1);
      expect(moveToTrashMock).not.toHaveBeenCalled();
      let { state } = await journal.load();
      expect(state.entries).toHaveLength(1);
      let entry = state.entries[0];
      expect(entry.type).toBe('orphan-candidate');
      if (entry.type === 'orphan-candidate') {
        expect(entry.stableScanCount).toBe(1);
        expect(entry.firstSeenAt).toBe(t0);
      }

      // --- Scan 2: 1 hour later (still within the age window) ---
      const t1 = t0 + 60 * 60 * 1000;
      await runStartupCleanup(coreDir, makeSettings(), journal, deps, { now: () => t1 });
      ({ state } = await journal.load());
      entry = state.entries[0];
      if (entry.type === 'orphan-candidate') {
        expect(entry.stableScanCount).toBe(2);
      }

      // --- Scan 3: past 48h threshold — stability gate satisfied ---
      const t2 = t0 + ORPHAN_STABILITY_MIN_AGE_MS + 1000;
      const r3 = await runStartupCleanup(
        coreDir,
        makeSettings(),
        journal,
        deps,
        { now: () => t2 },
      );
      // Stage 1 still DOES NOT quarantine — orphan action is Stage 2's job.
      // The gate simply promotes the classification from pending-review to orphaned.
      expect(moveToTrashMock).not.toHaveBeenCalled();
      expect(r3.orphansDeferred).toBe(1);
      ({ state } = await journal.load());
      entry = state.entries[0];
      if (entry.type === 'orphan-candidate') {
        expect(entry.stableScanCount).toBeGreaterThanOrEqual(ORPHAN_STABILITY_MIN_SCANS);
      }
    });

    it('resets the stability counter when the base file reappears', async () => {
      const conflict = path.join(coreDir, 'came-back.conflict-cloud.md');
      const original = path.join(coreDir, 'came-back.md');
      await writeFile(conflict, 'orphan');

      const t0 = 2_000_000_000_000;
      await runStartupCleanup(coreDir, makeSettings(), journal, deps, { now: () => t0 });
      let { state } = await journal.load();
      expect(state.entries).toHaveLength(1);

      // Sync catches up — base file appears (bytes differ so no quarantine).
      await writeFile(original, 'recovered bytes');

      const t1 = t0 + 60 * 1000;
      await runStartupCleanup(coreDir, makeSettings(), journal, deps, { now: () => t1 });

      ({ state } = await journal.load());
      // Conflict file now classifies as differing, so the orphan candidate is dropped.
      expect(state.entries.filter((e) => e.type === 'orphan-candidate')).toHaveLength(0);
    });

    // ---- Time budget ---------------------------------------------------------

    it('bails out when the time budget is exceeded and returns partial results', async () => {
      // Create a modest tree — the scan is fast, so we fake time progression
      // by returning an advancing clock that blows past the budget after the
      // first readdir call. We can simulate via a mutable counter.
      for (let i = 0; i < 50; i++) {
        await writeFile(path.join(coreDir, `file${i}.conflict-cloud.md`), `x${i}`);
      }

      let fakeNow = 0;
      const clock = () => {
        fakeNow += 100; // every call advances 100ms
        return fakeNow;
      };

      const result = await runStartupCleanup(
        coreDir,
        makeSettings(),
        journal,
        deps,
        { timeBudgetMs: 50, now: clock },
      );

      expect(result.timeBudgetExceeded).toBe(true);
    });

    it('has a default 2-second time budget constant', () => {
      expect(DEFAULT_STARTUP_TIME_BUDGET_MS).toBe(2000);
    });

    // ---- Dry-run contract ----------------------------------------------------

    it('dry-run makes zero destructive calls and writes no journal entries but reports preview counts', async () => {
      // Case A: identical file that WOULD be quarantined — must not be touched.
      const original = path.join(coreDir, 'a.md');
      const conflict = path.join(coreDir, 'a.conflict-cloud.md');
      await writeFile(original, 'same');
      await writeFile(conflict, 'same');

      // Case B: orphan that WOULD advance the journal.
      const orphan = path.join(coreDir, 'b.conflict-cloud.md');
      await writeFile(orphan, 'orphan');

      const saveSpy = vi.spyOn(journal, 'save');
      const result = await runStartupCleanup(
        coreDir,
        makeSettings(),
        journal,
        deps,
        { dryRun: true },
      );

      expect(moveToTrashMock).not.toHaveBeenCalled();
      expect(saveSpy).not.toHaveBeenCalled();
      expect(result.errors).toEqual([]);
      // Preview counters reflect "what would have happened" so CLI/IPC
      // consumers see `1 quarantined` not `0 quarantined` (F3).
      expect(result.quarantinedIdentical).toBe(1);
      expect(result.orphansDeferred).toBe(1);
      // Identical file still on disk.
      expect(fsSync.existsSync(conflict)).toBe(true);
      // Journal file was never created.
      expect(fsSync.existsSync(journal.getFilePath())).toBe(false);
    });

    it('records an error when moveToTrash throws and leaves the file in place', async () => {
      const original = path.join(coreDir, 'notes.md');
      const conflict = path.join(coreDir, 'notes.conflict-cloud.md');
      await writeFile(original, 'same');
      await writeFile(conflict, 'same');

      moveToTrashMock.mockRejectedValueOnce(new Error('EACCES: permission denied'));

      const result = await runStartupCleanup(coreDir, makeSettings(), journal, deps);
      expect(result.quarantinedIdentical).toBe(0);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]).toContain('moveToTrash failed');
    });

    // ---- F1: forward-compat safe-skip on unknown schemaVersion -------------

    it('does not touch the journal file when the on-disk schemaVersion is unknown (F1)', async () => {
      // Simulate a future-version Rebel having written a journal with a
      // schema we don't recognise. We MUST leave it alone.
      const journalPath = journal.getFilePath();
      const futureJson = JSON.stringify({
        schemaVersion: 999,
        updatedAt: 1,
        entries: [{ future: 'data', opaque: [1, 2, 3] }],
      });
      await fs.mkdir(path.dirname(journalPath), { recursive: true });
      await fs.writeFile(journalPath, futureJson);

      // Seed an identical conflict so the normal path would otherwise
      // trigger a journal save (for the quarantine-pending entry).
      const original = path.join(coreDir, 'notes.md');
      const conflict = path.join(coreDir, 'notes.conflict-cloud.md');
      await writeFile(original, 'same');
      await writeFile(conflict, 'same');

      const result = await runStartupCleanup(coreDir, makeSettings(), journal, deps);
      expect(result.errors).toEqual([]);

      // The critical assertion: the on-disk journal file is byte-identical
      // to what was there before the run. A future schema's data survives.
      const afterBytes = await fs.readFile(journalPath, 'utf8');
      expect(afterBytes).toBe(futureJson);
    });

    // ---- F2: orphan counters preserved on time-budget bail -----------------

    it('preserves orphan stability entries when time budget bails before re-scanning them (F2)', async () => {
      // Seed the journal with an orphan candidate for a path we will NOT
      // re-scan this run. A bail-before-classification must NOT reset the
      // stability counter.
      const seededPath = path.join(coreDir, 'slow-fs', 'gone.conflict-cloud.md');
      const seededAt = 1_700_000_000_000;
      await journal.save({
        schemaVersion: 2,
        updatedAt: seededAt,
        entries: [
          {
            type: 'orphan-candidate',
            conflictPath: seededPath,
            firstSeenAt: seededAt,
            stableScanCount: 2,
            lastSeenAt: seededAt,
          },
        ],
      });

      // timeBudgetMs: 0 bails before we classify anything — mimics the
      // slow-FS (OneDrive Files-On-Demand) case where scans overrun.
      const result = await runStartupCleanup(
        coreDir,
        makeSettings(),
        journal,
        deps,
        { timeBudgetMs: 0 },
      );
      expect(result.timeBudgetExceeded).toBe(true);

      const { state } = await journal.load();
      const orphans = state.entries.filter((e) => e.type === 'orphan-candidate');
      expect(orphans).toHaveLength(1);
      const entry = orphans[0];
      if (entry.type === 'orphan-candidate') {
        expect(entry.conflictPath).toBe(seededPath);
        expect(entry.stableScanCount).toBe(2);
        expect(entry.firstSeenAt).toBe(seededAt);
      }
    });

    // ---- F5: mid-flight file-disappeared before quarantine -----------------

    it('soft-succeeds when the conflict file disappears between classify and quarantine (F5)', async () => {
      const original = path.join(coreDir, 'notes.md');
      const conflict = path.join(coreDir, 'notes.conflict-cloud.md');
      await writeFile(original, 'same');
      await writeFile(conflict, 'same');

      // Mock fs.access to throw ENOENT ONLY for the conflict path. Classify
      // calls fs.access on the ORIGINAL, so we let those through.
      const accessSpy = vi.spyOn(fs, 'access').mockImplementation((p: any) => {
        if (p === conflict) {
          const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          return Promise.reject(err);
        }
        return Promise.resolve();
      });

      try {
        const result = await runStartupCleanup(coreDir, makeSettings(), journal, deps);
        expect(result.quarantinedIdentical).toBe(0);
        expect(result.errors).toEqual([]);
        expect(moveToTrashMock).not.toHaveBeenCalled();
      } finally {
        accessSpy.mockRestore();
      }
    });

    // ---- F7: re-hash before quarantine catches mid-flight conflict mutation

    it('aborts quarantine when the conflict file is mutated between classify and quarantine (F7)', async () => {
      const original = path.join(coreDir, 'notes.md');
      const conflict = path.join(coreDir, 'notes.conflict-cloud.md');
      await writeFile(original, 'same');
      await writeFile(conflict, 'same');

      // Mutate the conflict file right before quarantine runs — simulate
      // cloudWorkspaceSync replacing bytes mid-flight. We hook the
      // moveToTrash lifecycle via a spy on hashFile... but since hashFile
      // is internal, we instead overwrite the file inside the moveToTrash
      // mock's preflight. The guard sits BEFORE moveToTrash, so we need
      // the bytes to change BEFORE the second hash. Simplest: intercept
      // at the filesystem level by mutating inside a spy on `fs.readFile`
      // that triggers only on the conflict path, after its first read
      // (classify) has already happened.

      let conflictReads = 0;
      const realReadFile = fs.readFile.bind(fs);
      const readFileSpy = vi.spyOn(fs, 'readFile').mockImplementation(async (p: any, ...rest: any[]) => {
        if (p === conflict) {
          conflictReads += 1;
          // The SECOND readFile on the conflict file happens inside the
          // pre-quarantine re-hash (F7 guard). Swap bytes before it reads.
          if (conflictReads === 2) {
            await realReadFile.call(fs, p, ...rest); // capture original semantics, throwaway
            await writeFile(conflict, 'MUTATED BYTES');
          }
        }
        return realReadFile.call(fs, p, ...rest);
      });

      try {
        const result = await runStartupCleanup(coreDir, makeSettings(), journal, deps);

        expect(moveToTrashMock).not.toHaveBeenCalled();
        expect(result.quarantinedIdentical).toBe(0);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]).toContain('hash changed');
        expect(fsSync.existsSync(conflict)).toBe(true);
      } finally {
        readFileSpy.mockRestore();
      }
    });

    // ---- F8: quarantine-pending entry is resumed after a simulated crash ---

    it('clears a quarantine-pending journal entry when the file is gone on next startup (F8)', async () => {
      // Simulate the crash-between-trash-and-clear scenario by seeding a
      // quarantine-pending entry for a path whose file has already been
      // removed (i.e. the previous run's moveToTrash succeeded but the
      // journal-clear save crashed).
      const ghostPath = path.join(coreDir, 'ghost.conflict-cloud.md');
      await journal.save({
        schemaVersion: 2,
        updatedAt: 1_700_000_000_000,
        entries: [
          {
            type: 'quarantine-pending',
            conflictPath: ghostPath,
            expectedHash: 'deadbeef'.repeat(8),
            attemptedAt: 1_700_000_000_000,
          },
        ],
      });

      const result = await runStartupCleanup(coreDir, makeSettings(), journal, deps);
      expect(result.errors).toEqual([]);
      expect(moveToTrashMock).not.toHaveBeenCalled();

      const { state } = await journal.load();
      const pending = state.entries.filter((e) => e.type === 'quarantine-pending');
      expect(pending).toHaveLength(0);
    });

    it('retries a quarantine-pending move when the file still exists with matching hash (F8)', async () => {
      // The opposite failure mode: the previous run wrote the entry but
      // crashed before even calling moveToTrash. Next startup must retry.
      const conflict = path.join(coreDir, 'retry.conflict-cloud.md');
      const original = path.join(coreDir, 'retry.md');
      await writeFile(original, 'same');
      await writeFile(conflict, 'same');

      const { createHash } = await import('node:crypto');
      const expectedHash = createHash('sha256').update('same').digest('hex');

      await journal.save({
        schemaVersion: 2,
        updatedAt: 1_700_000_000_000,
        entries: [
          {
            type: 'quarantine-pending',
            conflictPath: conflict,
            expectedHash,
            attemptedAt: 1_700_000_000_000,
          },
        ],
      });

      await runStartupCleanup(coreDir, makeSettings(), journal, deps);
      // moveToTrash should have been called at least once for the retry.
      // (The subsequent scan also re-classifies and would quarantine again,
      // but the retry path alone is what the test asserts.)
      expect(moveToTrashMock).toHaveBeenCalledWith(conflict);
      const { state } = await journal.load();
      expect(state.entries.filter((e) => e.type === 'quarantine-pending')).toHaveLength(0);
    });
  });

  // =========================================================================
  // Stage 2: evaluateMergeGuards (size-delta + markdown anchor invariants)
  // =========================================================================

  describe('evaluateMergeGuards', () => {
    it('passes on a reasonable merge', () => {
      const local = '# Heading\n\nBody A with enough bytes to matter here.';
      const cloud = '# Heading\n\nBody B with enough bytes to matter here too.';
      const merged = '# Heading\n\nBody A + Body B combined for a merged output.';
      expect(evaluateMergeGuards(local, cloud, merged).passed).toBe(true);
    });

    it('rejects when the merged output drops a heading present in both inputs', () => {
      const local = '# Title\n\n## Section A\ncontent-a\n\n## Section B\nshared\n';
      const cloud = '# Title\n\n## Section A\ncontent-a-other\n\n## Section B\nshared\n';
      // LLM "helpfully" dropped Section B from the merge.
      const merged = '# Title\n\n## Section A\nmerged content\n';
      const result = evaluateMergeGuards(local, cloud, merged);
      expect(result.passed).toBe(false);
      expect(result.reason).toBe('missing-heading');
      expect(result.detail).toContain('## Section B');
    });

    it('allows a heading that appears in only one input to be dropped', () => {
      const local = '# Title\n\n## Section A\nlocal-only\n';
      const cloud = '# Title\n\nno section here\n';
      // Merged dropped Section A — fine, because Section A wasn't in cloud.
      const merged = '# Title\n\nmerged body\n';
      expect(evaluateMergeGuards(local, cloud, merged).passed).toBe(true);
    });

    it('rejects when the merged output shrinks below 70% of the smaller input (size-shrink)', () => {
      const local = 'x'.repeat(10_000);
      const cloud = 'x'.repeat(10_500);
      const merged = 'x'.repeat(6_000); // 60% of min — below the 70% floor
      const result = evaluateMergeGuards(local, cloud, merged);
      expect(result.passed).toBe(false);
      expect(result.reason).toBe('size-delta-shrink');
    });

    it('rejects when the merged output deviates >50% from max input (size-relative)', () => {
      const local = 'x'.repeat(10_000);
      const cloud = 'x'.repeat(10_000);
      const merged = 'x'.repeat(16_000); // 60% larger — beyond the 50% ceiling
      const result = evaluateMergeGuards(local, cloud, merged);
      expect(result.passed).toBe(false);
      expect(result.reason).toBe('size-delta-relative');
    });

    it('applies the small-file absolute floor for inputs < 1KB', () => {
      const local = 'short';
      const cloud = 'short-ish';
      // Stays under +1KB of max-input; should pass.
      const mergedOk = 'a moderately longer merged string, still well under 1KB';
      expect(evaluateMergeGuards(local, cloud, mergedOk).passed).toBe(true);

      // Balloon to >1KB past max-input — should be rejected.
      const mergedBig = 'x'.repeat(2000);
      const rejected = evaluateMergeGuards(local, cloud, mergedBig);
      expect(rejected.passed).toBe(false);
      expect(rejected.reason).toBe('size-delta-absolute');
    });
  });

  // =========================================================================
  // Stage 2: runDailyMaintenance
  // =========================================================================

  describe('runDailyMaintenance', () => {
    let retryStore: SpaceMaintenanceRetryStore;
    let dailyDeps: DailyMaintenanceDeps;
    let telemetrySpy: ReturnType<typeof vi.fn<(event: string, props: Record<string, unknown>) => void>>;

    beforeEach(() => {
      retryStore = new SpaceMaintenanceRetryStore(userDataDir);
      telemetrySpy = vi.fn();
      dailyDeps = {
        moveToTrash: moveToTrashMock,
        emitTelemetry: telemetrySpy,
      };
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('merges a differing .conflict-cloud via proposeMerge and quarantines the conflict', async () => {
      const conflict = path.join(coreDir, 'notes.conflict-cloud.md');
      const original = path.join(coreDir, 'notes.md');
      // Shared anchor, so the markdown-anchor guard has something to enforce.
      await writeFile(original, '# Notes\n\nlocal body line one.\nlocal body line two.\n');
      await writeFile(conflict, '# Notes\n\ncloud body line one.\ncloud body line two.\n');

      const mergedContent = '# Notes\n\nmerged body line one.\nmerged body line two.\n';
      const proposeMergeSpy = vi.spyOn(resolver, 'proposeMerge').mockResolvedValue({
        success: true,
        mergedContent,
      });

      const result = await runDailyMaintenance(
        coreDir,
        makeSettings(),
        journal,
        retryStore,
        dailyDeps,
      );

      expect(proposeMergeSpy).toHaveBeenCalledTimes(1);
      expect(result.mergedSuccessfully).toBe(1);
      expect(result.mergeFailed).toBe(0);
      expect(result.errors).toEqual([]);

      // Original was rewritten with merged bytes; tmp + conflict are gone.
      const finalBytes = await fs.readFile(original, 'utf8');
      expect(finalBytes).toBe(mergedContent);
      expect(moveToTrashMock).toHaveBeenCalledWith(conflict);

      // Journal ends the run empty (rename-pending cleared, quarantine-pending cleared).
      const { state } = await journal.load();
      expect(
        state.entries.filter((e) => e.type === 'rename-pending' || e.type === 'quarantine-pending'),
      ).toHaveLength(0);

      // Telemetry fired with structured counters.
      expect(telemetrySpy).toHaveBeenCalledWith(
        'space_maintenance_run',
        expect.objectContaining({
          dryRun: false,
          mergedSuccessfully: 1,
        }),
      );
    });

    it('records a merge failure and schedules a retry with exponential backoff', async () => {
      const conflict = path.join(coreDir, 'notes.conflict-cloud.md');
      const original = path.join(coreDir, 'notes.md');
      await writeFile(original, 'local body\n');
      await writeFile(conflict, 'cloud body\n');

      vi.spyOn(resolver, 'proposeMerge').mockResolvedValue({
        success: false,
        error: 'model returned empty response',
      });

      const t0 = 1_700_000_000_000;
      const result = await runDailyMaintenance(
        coreDir,
        makeSettings(),
        journal,
        retryStore,
        dailyDeps,
        { now: () => t0 },
      );

      expect(result.mergeFailed).toBe(1);
      expect(result.mergedSuccessfully).toBe(0);
      expect(moveToTrashMock).not.toHaveBeenCalled();

      const { state: retryState } = await retryStore.load();
      expect(retryState.entries).toHaveLength(1);
      const entry = retryState.entries[0];
      expect(entry.conflictPath).toBe(conflict);
      expect(entry.status).toBe('retry');
      expect(entry.attempts).toBe(1);
      // First failure -> next eligible in 1 day.
      expect(entry.nextEligibleAt).toBe(t0 + 24 * 60 * 60 * 1000);
    });

    it('skips a conflict whose retry entry is still within the backoff window', async () => {
      const conflict = path.join(coreDir, 'notes.conflict-cloud.md');
      const original = path.join(coreDir, 'notes.md');
      await writeFile(original, 'local body\n');
      await writeFile(conflict, 'cloud body\n');

      const conflictBytes = await fs.readFile(conflict);
      const { createHash } = await import('node:crypto');
      const conflictHash = createHash('sha256').update(conflictBytes).digest('hex');

      const future = 1_800_000_000_000;
      await retryStore.save({
        schemaVersion: RETRY_STATE_SCHEMA_VERSION,
        updatedAt: 0,
        entries: [
          {
            conflictPath: conflict,
            conflictHash,
            attempts: 1,
            lastAttemptAt: 0,
            nextEligibleAt: future,
            lastError: 'boom',
            status: 'retry',
          },
        ],
      });

      const proposeMergeSpy = vi.spyOn(resolver, 'proposeMerge');

      const result = await runDailyMaintenance(
        coreDir,
        makeSettings(),
        journal,
        retryStore,
        dailyDeps,
        { now: () => future - 1 },
      );

      expect(proposeMergeSpy).not.toHaveBeenCalled();
      expect(result.mergeSkippedBackoff).toBe(1);
      expect(result.mergedSuccessfully).toBe(0);
    });

    it('circuit-breaks at 3 failures and transitions the entry to needs-review', async () => {
      const conflict = path.join(coreDir, 'notes.conflict-cloud.md');
      const original = path.join(coreDir, 'notes.md');
      await writeFile(original, 'local body\n');
      await writeFile(conflict, 'cloud body\n');

      const { createHash } = await import('node:crypto');
      const conflictHash = createHash('sha256').update(await fs.readFile(conflict)).digest('hex');

      // Pre-seed: 2 prior failures with backoff already expired.
      await retryStore.save({
        schemaVersion: RETRY_STATE_SCHEMA_VERSION,
        updatedAt: 0,
        entries: [
          {
            conflictPath: conflict,
            conflictHash,
            attempts: 2,
            lastAttemptAt: 0,
            nextEligibleAt: 0,
            lastError: 'prior failure',
            status: 'retry',
          },
        ],
      });

      vi.spyOn(resolver, 'proposeMerge').mockResolvedValue({
        success: false,
        error: 'still failing',
      });

      const now = 2_000_000_000_000;
      const result = await runDailyMaintenance(
        coreDir,
        makeSettings(),
        journal,
        retryStore,
        dailyDeps,
        { now: () => now },
      );

      expect(result.mergeFailed).toBe(1);

      const { state } = await retryStore.load();
      expect(state.entries).toHaveLength(1);
      expect(state.entries[0].status).toBe('needs-review');
      expect(state.entries[0].attempts).toBe(3);
    });

    it('auto-expires a stale retry entry when the conflict bytes have changed', async () => {
      const conflict = path.join(coreDir, 'notes.conflict-cloud.md');
      const original = path.join(coreDir, 'notes.md');
      await writeFile(original, 'local body\n');
      await writeFile(conflict, 'cloud NEW bytes\n');

      // Seed an entry whose hash represents the OLD conflict contents — by
      // the time this run loads state, cloudWorkspaceSync has replaced the
      // conflict file with new bytes.
      await retryStore.save({
        schemaVersion: RETRY_STATE_SCHEMA_VERSION,
        updatedAt: 0,
        entries: [
          {
            conflictPath: conflict,
            conflictHash: 'deadbeef'.repeat(8),
            attempts: 3,
            lastAttemptAt: 0,
            nextEligibleAt: 0,
            lastError: 'gave up',
            status: 'needs-review',
          },
        ],
      });

      vi.spyOn(resolver, 'proposeMerge').mockResolvedValue({
        success: true,
        mergedContent: 'merged body\n',
      });

      const result = await runDailyMaintenance(
        coreDir,
        makeSettings(),
        journal,
        retryStore,
        dailyDeps,
      );

      // The stale entry did NOT block the retry cycle — we merged successfully.
      expect(result.mergedSuccessfully).toBe(1);
      expect(result.mergeSkippedCircuitBreaker).toBe(0);
      // Stale entry was pruned.
      const { state } = await retryStore.load();
      expect(state.entries).toHaveLength(0);
    });

    it('aborts a merge as aborted-race when the original hash changes during proposeMerge', async () => {
      const conflict = path.join(coreDir, 'notes.conflict-cloud.md');
      const original = path.join(coreDir, 'notes.md');
      await writeFile(original, 'original body one\n');
      await writeFile(conflict, 'cloud body one\n');

      // proposeMerge returns success but meanwhile another writer mutates
      // the original file. The pre-rename re-hash guard must detect it.
      vi.spyOn(resolver, 'proposeMerge').mockImplementation(async () => {
        await writeFile(original, 'OTHER writer mutated this\n');
        return { success: true, mergedContent: 'merged content body\n' };
      });

      const result = await runDailyMaintenance(
        coreDir,
        makeSettings(),
        journal,
        retryStore,
        dailyDeps,
      );

      expect(result.mergedSuccessfully).toBe(0);
      expect(result.mergeAbortedRace).toBe(1);

      // Original retains the mutation from the other writer — we did NOT clobber it.
      const originalNow = await fs.readFile(original, 'utf8');
      expect(originalNow).toBe('OTHER writer mutated this\n');

      // Conflict file is still on disk (we didn't trash it).
      expect(fsSync.existsSync(conflict)).toBe(true);

      // No rename-pending entry left behind (guard discarded it).
      const { state } = await journal.load();
      expect(state.entries.filter((e) => e.type === 'rename-pending')).toHaveLength(0);
    });

    it('rejects a merge that fails the markdown-anchor guard (LLM dropped a heading)', async () => {
      const conflict = path.join(coreDir, 'doc.conflict-cloud.md');
      const original = path.join(coreDir, 'doc.md');
      await writeFile(
        original,
        '# Title\n\n## Section One\none\n\n## Section Two\ntwo shared\n',
      );
      await writeFile(
        conflict,
        '# Title\n\n## Section One\none-alt\n\n## Section Two\ntwo shared\n',
      );

      // LLM returns content missing Section Two.
      vi.spyOn(resolver, 'proposeMerge').mockResolvedValue({
        success: true,
        mergedContent: '# Title\n\n## Section One\nmerged\n',
      });

      const result = await runDailyMaintenance(
        coreDir,
        makeSettings(),
        journal,
        retryStore,
        dailyDeps,
      );

      expect(result.mergeFailed).toBe(1);
      expect(result.mergedSuccessfully).toBe(0);
      expect(moveToTrashMock).not.toHaveBeenCalled();

      // Original is untouched — the guard caught it before the rename.
      const originalNow = await fs.readFile(original, 'utf8');
      expect(originalNow).toContain('## Section Two');
    });

    it('does not quarantine when conflict bytes changed after rename (pre-quarantine hash guard)', async () => {
      const conflict = path.join(coreDir, 'guard.conflict-cloud.md');
      const original = path.join(coreDir, 'guard.md');
      await writeFile(original, '# Guard\n\nlocal body\n');
      await writeFile(conflict, '# Guard\n\ncloud body\n');

      vi.spyOn(resolver, 'proposeMerge').mockResolvedValue({
        success: true,
        mergedContent: '# Guard\n\nmerged body\n',
      });

      const realSave = journal.save.bind(journal);
      vi.spyOn(journal, 'save').mockImplementation(async (state, options) => {
        const saved = await realSave(state, options);
        // Inject a post-rename conflict rewrite right after the journal
        // flips to quarantine-pending.
        if (state.entries.some((entry) => entry.type === 'quarantine-pending')) {
          await writeFile(conflict, '# Guard\n\nreplacement from another writer\n');
        }
        return saved;
      });

      const result = await runDailyMaintenance(
        coreDir,
        makeSettings(),
        journal,
        retryStore,
        dailyDeps,
      );

      expect(result.mergedSuccessfully).toBe(1);
      expect(result.mergeFailed).toBe(0);
      expect(moveToTrashMock).not.toHaveBeenCalled();
      expect(result.errors.some((e) => e.includes('conflict raced'))).toBe(true);
      expect(await fs.readFile(conflict, 'utf8')).toContain('replacement from another writer');
    });

    it('dry-run performs no writes, no BTS calls, and no quarantines', async () => {
      const conflict = path.join(coreDir, 'notes.conflict-cloud.md');
      const original = path.join(coreDir, 'notes.md');
      await writeFile(original, 'local body\n');
      await writeFile(conflict, 'cloud body\n');

      const proposeMergeSpy = vi.spyOn(resolver, 'proposeMerge');
      const retrySaveSpy = vi.spyOn(retryStore, 'save');
      const journalSaveSpy = vi.spyOn(journal, 'save');

      const result = await runDailyMaintenance(
        coreDir,
        makeSettings(),
        journal,
        retryStore,
        dailyDeps,
        { dryRun: true },
      );

      expect(proposeMergeSpy).not.toHaveBeenCalled();
      expect(moveToTrashMock).not.toHaveBeenCalled();
      expect(retrySaveSpy).not.toHaveBeenCalled();
      // journal.save is allowed via the rename-pending resume path if any
      // pending entries existed — none were seeded, so it must stay untouched.
      expect(journalSaveSpy).not.toHaveBeenCalled();
      // Preview: we report `mergedSuccessfully: 1` as the "would attempt" count.
      expect(result.mergedSuccessfully).toBe(1);

      // Telemetry is still fired but with the `dryRun: true` discriminator.
      expect(telemetrySpy).toHaveBeenCalledWith(
        'space_maintenance_run',
        expect.objectContaining({ dryRun: true }),
      );

      // Filesystem unchanged.
      expect(await fs.readFile(original, 'utf8')).toBe('local body\n');
      expect(await fs.readFile(conflict, 'utf8')).toBe('cloud body\n');
    });

    it('dry-run does not attempt lease acquisition', async () => {
      const conflict = path.join(coreDir, 'lease-test.conflict-cloud.md');
      const original = path.join(coreDir, 'lease-test.md');
      await writeFile(original, 'local body\n');
      await writeFile(conflict, 'cloud body\n');

      const acquireLeaseSpy = vi
        .fn<() => Promise<{ acquired: boolean; release: () => Promise<void> }>>()
        .mockResolvedValue({
        acquired: true,
        release: async () => {
          throw new Error('should never run');
        },
        });

      const result = await runDailyMaintenance(
        coreDir,
        makeSettings(),
        journal,
        retryStore,
        { ...dailyDeps, acquireLease: acquireLeaseSpy },
        { dryRun: true },
      );

      expect(acquireLeaseSpy).not.toHaveBeenCalled();
      expect(result.errors).toEqual([]);
      expect(await fs.readFile(original, 'utf8')).toBe('local body\n');
      expect(await fs.readFile(conflict, 'utf8')).toBe('cloud body\n');
    });

    it('resumes a rename-pending journal entry from a prior crash (tmp intact)', async () => {
      const conflict = path.join(coreDir, 'notes.conflict-cloud.md');
      const original = path.join(coreDir, 'notes.md');
      const tmp = `${original}.rebel-merge-tmp`;
      // Seed: original pre-merge on disk, tmp holds merged bytes, conflict still around.
      const originalBody = 'pre-merge body\n';
      const conflictBody = 'cloud body\n';
      await writeFile(original, originalBody);
      await writeFile(conflict, conflictBody);
      const mergedContent = 'resumed-merge body with more bytes for size parity.\n';
      await writeFile(tmp, mergedContent);

      const { createHash } = await import('node:crypto');
      const mergedHash = createHash('sha256').update(mergedContent).digest('hex');
      const scanTimeOriginalHash = createHash('sha256').update(originalBody).digest('hex');
      const scanTimeConflictHash = createHash('sha256').update(conflictBody).digest('hex');

      await journal.save({
        schemaVersion: 2,
        updatedAt: 0,
        entries: [
          {
            type: 'rename-pending',
            conflictPath: conflict,
            originalPath: original,
            mergedHash,
            scanTimeOriginalHash,
            scanTimeConflictHash,
            stage: 'rename-pending',
            startedAt: 0,
          },
        ],
      });

      // Real `shell.trashItem` actually removes the file; simulate that so
      // the post-resume scan doesn't re-classify the conflict as differing.
      moveToTrashMock.mockImplementation(async (p) => {
        await fs.unlink(p);
      });

      // proposeMerge should never run — after resume the conflict is gone
      // and the scan has nothing differing to process.
      const proposeMergeSpy = vi.spyOn(resolver, 'proposeMerge');

      await runDailyMaintenance(coreDir, makeSettings(), journal, retryStore, dailyDeps);

      // Resume completed: tmp renamed -> original now holds the merged bytes.
      expect(await fs.readFile(original, 'utf8')).toBe(mergedContent);
      expect(fsSync.existsSync(tmp)).toBe(false);
      // Conflict was quarantined (and actually removed by the adapter stub).
      expect(moveToTrashMock).toHaveBeenCalledWith(conflict);
      expect(fsSync.existsSync(conflict)).toBe(false);
      // Journal emptied of rename-pending.
      const { state } = await journal.load();
      expect(state.entries.filter((e) => e.type === 'rename-pending')).toHaveLength(0);
      expect(proposeMergeSpy).not.toHaveBeenCalled();
    });

    it('discards a rename-pending tmp whose hash no longer matches the merged hash', async () => {
      const conflict = path.join(coreDir, 'notes.conflict-cloud.md');
      const original = path.join(coreDir, 'notes.md');
      const tmp = `${original}.rebel-merge-tmp`;
      await writeFile(original, 'pre-merge body\n');
      await writeFile(conflict, 'cloud body\n');
      await writeFile(tmp, 'tmp has GARBAGE bytes - hash will not match\n');

      await journal.save({
        schemaVersion: 2,
        updatedAt: 0,
        entries: [
          {
            type: 'rename-pending',
            conflictPath: conflict,
            originalPath: original,
            mergedHash: 'deadbeef'.repeat(8),
            scanTimeOriginalHash: 'cafebabe'.repeat(8),
            scanTimeConflictHash: 'feedface'.repeat(8),
            stage: 'rename-pending',
            startedAt: 0,
          },
        ],
      });

      vi.spyOn(resolver, 'proposeMerge').mockResolvedValue({
        success: false,
        error: 'subsequent scan failure',
      });

      await runDailyMaintenance(coreDir, makeSettings(), journal, retryStore, dailyDeps);

      // The stale tmp is cleaned up and the rename-pending entry is cleared.
      expect(fsSync.existsSync(tmp)).toBe(false);
      expect(await fs.readFile(original, 'utf8')).toBe('pre-merge body\n');
    });

    it('drops a rename-pending entry cleanly when the tmp is already gone', async () => {
      const conflict = path.join(coreDir, 'notes.conflict-cloud.md');
      const original = path.join(coreDir, 'notes.md');
      await writeFile(original, 'final merged body\n');
      // No conflict file, no tmp — the previous run completed the rename
      // and the conflict quarantine, but died before clearing the entry.

      await journal.save({
        schemaVersion: 2,
        updatedAt: 0,
        entries: [
          {
            type: 'rename-pending',
            conflictPath: conflict,
            originalPath: original,
            mergedHash: 'deadbeef'.repeat(8),
            scanTimeOriginalHash: 'cafebabe'.repeat(8),
            scanTimeConflictHash: 'feedface'.repeat(8),
            stage: 'rename-pending',
            startedAt: 0,
          },
        ],
      });

      await runDailyMaintenance(coreDir, makeSettings(), journal, retryStore, dailyDeps);

      const { state } = await journal.load();
      expect(state.entries.filter((e) => e.type === 'rename-pending')).toHaveLength(0);
      // No error recorded for this normal resume path.
    });

    // ---- S2-F1: Resume-path data-loss guard --------------------------------

    it('S2-F1: preserves original bytes when a writer mutated the original post-crash', async () => {
      // Scenario: yesterday 06:00 the daily merged V1 of the original into
      // tmp, persisted the rename-pending entry, then crashed. Overnight
      // the user edited the file (V1 -> V2). App restarts -> without the
      // S2-F1 guard we would rename tmp into the original and destroy V2.
      const conflict = path.join(coreDir, 'notes.conflict-cloud.md');
      const original = path.join(coreDir, 'notes.md');
      const tmp = `${original}.rebel-merge-tmp`;

      // At scan time (yesterday) the original was V1.
      const v1Body = 'V1 — the body that existed at scan time\n';
      const conflictBody = 'cloud body that diverged from V1\n';
      const mergedContent = 'M(V1, conflict) — yesterday\'s merge result.\n';

      const { createHash } = await import('node:crypto');
      const scanTimeOriginalHash = createHash('sha256').update(v1Body).digest('hex');
      const scanTimeConflictHash = createHash('sha256').update(conflictBody).digest('hex');
      const mergedHash = createHash('sha256').update(mergedContent).digest('hex');

      // Now (post-restart) the user has edited the file to V2 and the
      // conflict is still on disk. The crashed tmp is still present.
      const v2Body = 'V2 — USER EDIT made after the crash. Must not be lost.\n';
      await writeFile(original, v2Body);
      await writeFile(conflict, conflictBody);
      await writeFile(tmp, mergedContent);

      await journal.save({
        schemaVersion: 2,
        updatedAt: 0,
        entries: [
          {
            type: 'rename-pending',
            conflictPath: conflict,
            originalPath: original,
            mergedHash,
            scanTimeOriginalHash,
            scanTimeConflictHash,
            stage: 'rename-pending',
            startedAt: 0,
          },
        ],
      });

      // proposeMerge path should not run on resume; but it will run for the
      // still-differing conflict on the downstream scan. Mock it to a
      // safe no-op so it doesn't hit BTS.
      vi.spyOn(resolver, 'proposeMerge').mockResolvedValue({
        success: false,
        error: 'not the focus of this test',
      });

      await runDailyMaintenance(coreDir, makeSettings(), journal, retryStore, dailyDeps);

      // CRITICAL: V2 must be preserved byte-for-byte. tmp is discarded.
      expect(await fs.readFile(original, 'utf8')).toBe(v2Body);
      expect(fsSync.existsSync(tmp)).toBe(false);

      // Journal rename-pending entry is cleared (dropped stale).
      const { state } = await journal.load();
      expect(state.entries.filter((e) => e.type === 'rename-pending')).toHaveLength(0);
    });

    it('S2-F1: completes rename but skips quarantine when conflict was replaced post-crash', async () => {
      // Scenario: rename-pending + valid tmp + pristine original, but
      // overnight cloudWorkspaceSync replaced the conflict file with a
      // NEW divergent version. Resume must rename (forward progress on
      // the merged content) but must NOT trash the new conflict bytes —
      // the next scan will re-classify them.
      const conflict = path.join(coreDir, 'notes.conflict-cloud.md');
      const original = path.join(coreDir, 'notes.md');
      const tmp = `${original}.rebel-merge-tmp`;

      const preMergeOriginal = 'pre-merge original body\n';
      const oldConflictBody = 'the conflict bytes at scan time\n';
      const newConflictBody = 'FRESH divergent bytes from cloudWorkspaceSync overnight\n';
      const mergedContent = 'the merged body — reasonable length for guards.\n';

      const { createHash } = await import('node:crypto');
      const scanTimeOriginalHash = createHash('sha256').update(preMergeOriginal).digest('hex');
      const scanTimeConflictHash = createHash('sha256').update(oldConflictBody).digest('hex');
      const mergedHash = createHash('sha256').update(mergedContent).digest('hex');

      await writeFile(original, preMergeOriginal);
      await writeFile(conflict, newConflictBody); // REPLACED by cloud sync
      await writeFile(tmp, mergedContent);

      await journal.save({
        schemaVersion: 2,
        updatedAt: 0,
        entries: [
          {
            type: 'rename-pending',
            conflictPath: conflict,
            originalPath: original,
            mergedHash,
            scanTimeOriginalHash,
            scanTimeConflictHash,
            stage: 'rename-pending',
            startedAt: 0,
          },
        ],
      });

      // Avoid re-merge on the post-resume scan triggering real work — the
      // downstream pipeline will try to propose a new merge on the still-
      // differing conflict. Fail it so the test's assertions stay focused.
      vi.spyOn(resolver, 'proposeMerge').mockResolvedValue({
        success: false,
        error: 'out of scope for this test',
      });

      await runDailyMaintenance(coreDir, makeSettings(), journal, retryStore, dailyDeps);

      // Rename completed: original now holds the merged bytes.
      expect(await fs.readFile(original, 'utf8')).toBe(mergedContent);
      // BUT the conflict file was NOT quarantined — the new divergent
      // bytes are still on disk, untouched.
      expect(fsSync.existsSync(conflict)).toBe(true);
      expect(await fs.readFile(conflict, 'utf8')).toBe(newConflictBody);
      expect(moveToTrashMock).not.toHaveBeenCalledWith(conflict);
    });

    it('S2-F1: migrates a v1 journal by dropping rename-pending entries', async () => {
      // Write a v1 journal containing a rename-pending entry (the v1 shape
      // lacks scanTime*Hash fields). Load + re-save must: (a) upgrade to
      // v2, (b) drop the rename-pending entry — its missing guard data is
      // unsafe to honour, and the next daily will re-merge from scratch.
      const journalPath = journal.getFilePath();
      const v1Journal = {
        schemaVersion: 1,
        updatedAt: 0,
        entries: [
          {
            type: 'rename-pending',
            conflictPath: path.join(coreDir, 'x.conflict-cloud.md'),
            originalPath: path.join(coreDir, 'x.md'),
            expectedHash: 'deadbeef'.repeat(8),
            stage: 'rename-pending',
            startedAt: 0,
          },
          {
            type: 'orphan-candidate',
            conflictPath: path.join(coreDir, 'gone.conflict-cloud.md'),
            firstSeenAt: 0,
            stableScanCount: 1,
            lastSeenAt: 0,
          },
        ],
      };
      await fs.mkdir(path.dirname(journalPath), { recursive: true });
      await fs.writeFile(journalPath, JSON.stringify(v1Journal, null, 2));

      const { state, mutable } = await journal.load();

      expect(mutable).toBe(true);
      expect(state.schemaVersion).toBe(2);
      // rename-pending entry was dropped.
      expect(state.entries.filter((e) => e.type === 'rename-pending')).toHaveLength(0);
      // orphan-candidate survives (schema unchanged across v1 -> v2).
      expect(state.entries.filter((e) => e.type === 'orphan-candidate')).toHaveLength(1);

      // Subsequent save writes a valid v2 file.
      await journal.save(state);
      const raw = JSON.parse(await fs.readFile(journalPath, 'utf8'));
      expect(raw.schemaVersion).toBe(2);
    });

    // ---- S2-F2: post-rename cleanup failure does NOT poison retry counter ---

    it('S2-F2: counts a merge as success even when post-rename moveToTrash fails', async () => {
      // The rename has already committed — the file IS merged. Only the
      // downstream moveToTrash call failed. The retry-state MUST NOT gain
      // an entry from this, or three such failures would circuit-break a
      // perfectly good file.
      const conflict = path.join(coreDir, 'notes.conflict-cloud.md');
      const original = path.join(coreDir, 'notes.md');
      await writeFile(original, '# Notes\n\nbody local\n');
      await writeFile(conflict, '# Notes\n\nbody cloud\n');

      const mergedContent = '# Notes\n\nbody merged across.\n';
      vi.spyOn(resolver, 'proposeMerge').mockResolvedValue({
        success: true,
        mergedContent,
      });

      // First moveToTrash call (post-merge quarantine) throws. The
      // subsequent startup-cleanup-style resume (within the same run) will
      // NOT be invoked because the conflict file is still on disk and the
      // scan re-classifies it; we assert the counts after this single run.
      moveToTrashMock.mockRejectedValueOnce(new Error('EACCES: locked by OS'));

      const result = await runDailyMaintenance(
        coreDir,
        makeSettings(),
        journal,
        retryStore,
        dailyDeps,
      );

      // Original was merged successfully.
      expect(await fs.readFile(original, 'utf8')).toBe(mergedContent);
      // Merge counter incremented; mergeFailed NOT incremented.
      expect(result.mergedSuccessfully).toBeGreaterThanOrEqual(1);
      expect(result.mergeFailed).toBe(0);
      // The cleanup error was surfaced on errors.
      expect(result.errors.join('\n')).toContain('moveToTrash failed');
      // NO retry-state entry was created (the crux of S2-F2).
      const { state } = await retryStore.load();
      const retryForConflict = state.entries.filter((e) => e.conflictPath === conflict);
      expect(retryForConflict).toHaveLength(0);
    });
  });

  // =========================================================================
  // Stage 2 refinement: resetNeedsReview (S2-F3)
  // =========================================================================

  describe('resetNeedsReview', () => {
    it('flips needs-review entries back to retry with fresh counters', () => {
      const now = 1_900_000_000_000;
      const input = [
        {
          conflictPath: '/tmp/a.conflict-cloud.md',
          conflictHash: 'a'.repeat(64),
          attempts: 3,
          lastAttemptAt: now,
          nextEligibleAt: now + 1000,
          lastError: 'wedged',
          status: 'needs-review' as const,
        },
        {
          conflictPath: '/tmp/b.conflict-cloud.md',
          conflictHash: 'b'.repeat(64),
          attempts: 1,
          lastAttemptAt: now,
          nextEligibleAt: now + 1000,
          lastError: 'first try',
          status: 'retry' as const,
        },
        {
          conflictPath: '/tmp/c.conflict-cloud.md',
          conflictHash: 'c'.repeat(64),
          attempts: 3,
          lastAttemptAt: now,
          nextEligibleAt: now + 1000,
          lastError: 'also wedged',
          status: 'needs-review' as const,
        },
      ];

      const { entries, resetCount } = resetNeedsReview(input);

      expect(resetCount).toBe(2);
      // Needs-review entries reset.
      const a = entries.find((e) => e.conflictPath === '/tmp/a.conflict-cloud.md')!;
      expect(a.status).toBe('retry');
      expect(a.attempts).toBe(0);
      expect(a.lastAttemptAt).toBe(0);
      expect(a.nextEligibleAt).toBe(0);
      expect(a.lastError).toBeNull();
      // Already-retry entry untouched.
      const b = entries.find((e) => e.conflictPath === '/tmp/b.conflict-cloud.md')!;
      expect(b.status).toBe('retry');
      expect(b.attempts).toBe(1);
      expect(b.lastError).toBe('first try');
      // conflictPath + conflictHash preserved (identity key stable).
      const c = entries.find((e) => e.conflictPath === '/tmp/c.conflict-cloud.md')!;
      expect(c.conflictHash).toBe('c'.repeat(64));
    });

    it('returns resetCount: 0 when no needs-review entries exist', () => {
      const { resetCount } = resetNeedsReview([]);
      expect(resetCount).toBe(0);
    });

    it('round-trips through the retry store: seed -> reset -> save -> reload', async () => {
      const retryStore = new SpaceMaintenanceRetryStore(userDataDir);
      const conflictPath = '/tmp/wedged.conflict-cloud.md';
      await retryStore.save({
        schemaVersion: RETRY_STATE_SCHEMA_VERSION,
        updatedAt: 0,
        entries: [
          {
            conflictPath,
            conflictHash: 'deadbeef'.repeat(8),
            attempts: 3,
            lastAttemptAt: 1,
            nextEligibleAt: 999,
            lastError: 'gave up after 3',
            status: 'needs-review',
          },
        ],
      });

      const { state } = await retryStore.load();
      const { entries: next, resetCount } = resetNeedsReview(state.entries);
      await retryStore.save({
        schemaVersion: RETRY_STATE_SCHEMA_VERSION,
        updatedAt: 0,
        entries: next,
      });

      expect(resetCount).toBe(1);
      const { state: reloaded } = await retryStore.load();
      expect(reloaded.entries).toHaveLength(1);
      expect(reloaded.entries[0].status).toBe('retry');
      expect(reloaded.entries[0].attempts).toBe(0);
      expect(reloaded.entries[0].nextEligibleAt).toBe(0);
      expect(reloaded.entries[0].lastError).toBeNull();
    });
  });

  // =========================================================================
  // Stage 3: repairBrokenFrontmatter
  // =========================================================================

  describe('repairBrokenFrontmatter', () => {
    /**
     * Seed a non-private shared space at `<coreDir>/<name>` with the given
     * README content, and return settings + absolute path so a test can
     * drive `repairBrokenFrontmatter` without boilerplate.
     */
    async function seedSharedSpace(
      name: string,
      readmeContent: string | Buffer,
    ): Promise<{ settings: AppSettings; spaceDir: string; readmePath: string }> {
      const spaceDir = path.join(coreDir, name);
      const readmePath = path.join(spaceDir, 'README.md');
      await fs.mkdir(spaceDir, { recursive: true });
      await fs.writeFile(readmePath, readmeContent);
      const settings = makeSettings({
        spaces: [
          {
            name,
            path: name,
            type: 'team',
            isSymlink: false,
            sharing: 'restricted',
            createdAt: 0,
          },
        ],
      });
      return { settings, spaceDir, readmePath };
    }

    beforeEach(() => {
      // `callWithModelAuthAware` is mocked at module load for the whole
      // file. Prior describe blocks leave prior call history in place;
      // clear it here so Stage 3 dry-run assertions on "never called"
      // are meaningful.
      vi.mocked(bts.callWithModelAuthAware).mockReset();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('mechanically repairs a file with duplicate top-level keys', async () => {
      const broken = [
        '---',
        'rebel_space_description: earlier draft',
        'sharing: team',
        'rebel_space_description: final description',
        '---',
        '# Body',
        '',
        'some body text',
      ].join('\n');
      const { settings, readmePath } = await seedSharedSpace('Team-A', broken);

      const btsSpy = vi.mocked(bts.callWithModelAuthAware);

      const result = await repairBrokenFrontmatter(coreDir, settings, journal);

      expect(result.checked).toBe(1);
      expect(result.repairedMechanical).toBe(1);
      expect(result.repairedLLM).toBe(0);
      expect(result.unrepairable).toBe(0);
      expect(result.errors).toEqual([]);
      // No LLM call for the mechanical case.
      expect(btsSpy).not.toHaveBeenCalled();

      const newBytes = await fs.readFile(readmePath, 'utf8');
      const parsed = (await import('front-matter')).default(newBytes);
      expect((parsed.attributes as Record<string, unknown>).rebel_space_description).toBe(
        'final description',
      );
      // Body preserved.
      expect(parsed.body).toContain('# Body');
      expect(parsed.body).toContain('some body text');
    });

    it('skips files whose frontmatter parses cleanly (no schema-only repair)', async () => {
      // Valid YAML but intentionally MISSING `rebel_space_description` —
      // this is the schema-missing-field path and MUST NOT invoke the
      // repair. Stage 3 is strictly for YAML-parser-level breakage.
      const clean = [
        '---',
        'sharing: team',
        'some_field: value',
        '---',
        '# Body',
      ].join('\n');
      const { settings, readmePath } = await seedSharedSpace('Valid', clean);

      const btsSpy = vi.mocked(bts.callWithModelAuthAware);

      const result = await repairBrokenFrontmatter(coreDir, settings, journal);

      expect(result.checked).toBe(0);
      expect(result.repairedMechanical).toBe(0);
      expect(result.repairedLLM).toBe(0);
      expect(result.unrepairable).toBe(0);
      expect(btsSpy).not.toHaveBeenCalled();

      const after = await fs.readFile(readmePath, 'utf8');
      expect(after).toBe(clean);
    });

    it('skips private spaces entirely', async () => {
      const broken = '---\nfoo: {unclosed\n---\n# body\n';
      const spaceDir = path.join(coreDir, 'Private');
      await fs.mkdir(spaceDir, { recursive: true });
      await fs.writeFile(path.join(spaceDir, 'README.md'), broken);

      const settings = makeSettings({
        spaces: [
          {
            name: 'Private',
            path: 'Private',
            type: 'personal',
            isSymlink: false,
            sharing: 'private',
            createdAt: 0,
          },
        ],
      });

      const result = await repairBrokenFrontmatter(coreDir, settings, journal);
      expect(result.checked).toBe(0);
    });

    it('repairs via LLM fallback when mechanical layer cannot fix the YAML', async () => {
      // Unclosed flow mapping — none of the mechanical cases can fix this.
      const bodyText = '# Team A\n\nBody line one.\nBody line two.\n';
      const broken = '---\nfoo: {unclosed\n---\n' + bodyText;
      const { settings, readmePath } = await seedSharedSpace('Team-A', broken);

      // LLM returns a minimal well-formed YAML reflecting the same key.
      vi.mocked(bts.callWithModelAuthAware).mockResolvedValueOnce({
        content: [
          { type: 'text', text: '<FIXED_YAML>\nfoo: unclosed\n</FIXED_YAML>' },
        ],
        model: 'stub-model',
      } as never);

      const result = await repairBrokenFrontmatter(coreDir, settings, journal);

      expect(result.checked).toBe(1);
      expect(result.repairedMechanical).toBe(0);
      expect(result.repairedLLM).toBe(1);
      expect(result.unrepairable).toBe(0);
      expect(result.errors).toEqual([]);

      // The LLM was called exactly once, with `{ category: 'system' }`.
      expect(vi.mocked(bts.callWithModelAuthAware)).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(bts.callWithModelAuthAware).mock.calls[0];
      expect(callArgs[3]).toEqual({ category: 'system' });

      // Body is preserved byte-for-byte — we split at the closing `---`
      // and reassemble with the original body bytes.
      const repairedBytes = await fs.readFile(readmePath);
      const repairedText = repairedBytes.toString('utf8');
      expect(repairedText.endsWith(bodyText)).toBe(true);

      // Frontmatter parses cleanly now.
      const parsed = (await import('front-matter')).default(repairedText);
      expect((parsed.attributes as Record<string, unknown>).foo).toBe('unclosed');
    });

    it('body bytes are preserved even when the body contains non-ASCII runs', async () => {
      // A body containing UTF-8 multibyte characters. We assert the raw
      // bytes after repair still match the original body bytes exactly.
      const bodyText = '# Héllo 🌍\n\nTéxt with accénts and emoji 😀.\n';
      const broken = '---\nfoo: {unclosed\n---\n' + bodyText;
      const { settings, readmePath } = await seedSharedSpace('Unicode', broken);

      vi.mocked(bts.callWithModelAuthAware).mockResolvedValueOnce({
        content: [{ type: 'text', text: '<FIXED_YAML>\nfoo: unclosed\n</FIXED_YAML>' }],
        model: 'stub-model',
      } as never);

      await repairBrokenFrontmatter(coreDir, settings, journal);

      const repairedBytes = await fs.readFile(readmePath);
      const bodyBytes = Buffer.from(bodyText, 'utf8');
      // The last N bytes of the file MUST equal the original body bytes.
      expect(repairedBytes.slice(repairedBytes.length - bodyBytes.length)).toEqual(bodyBytes);
    });

    it('rejects an LLM output that drops an original key', async () => {
      const broken = '---\nfoo: {unclosed\nkept_key: 42\n---\n# body\n';
      const { settings, readmePath } = await seedSharedSpace('Drop-Key', broken);

      // LLM returns only `foo`, silently dropping `kept_key`.
      vi.mocked(bts.callWithModelAuthAware).mockResolvedValueOnce({
        content: [{ type: 'text', text: '<FIXED_YAML>\nfoo: unclosed\n</FIXED_YAML>' }],
        model: 'stub-model',
      } as never);

      const result = await repairBrokenFrontmatter(coreDir, settings, journal);

      expect(result.repairedLLM).toBe(0);
      expect(result.unrepairable).toBe(1);
      expect(result.errors.join('\n')).toMatch(/missing-keys/);

      // File untouched (still broken).
      const after = await fs.readFile(readmePath, 'utf8');
      expect(after).toBe(broken);
    });

    it('rejects an LLM output that renames a key (not a superset)', async () => {
      const broken = '---\nfoo: {unclosed\nsharing: team\n---\n# body\n';
      const { settings, readmePath } = await seedSharedSpace('Rename', broken);

      vi.mocked(bts.callWithModelAuthAware).mockResolvedValueOnce({
        content: [
          { type: 'text', text: '<FIXED_YAML>\nfoo: unclosed\nshare_level: team\n</FIXED_YAML>' },
        ],
        model: 'stub-model',
      } as never);

      const result = await repairBrokenFrontmatter(coreDir, settings, journal);

      expect(result.repairedLLM).toBe(0);
      expect(result.unrepairable).toBe(1);
      const after = await fs.readFile(readmePath, 'utf8');
      expect(after).toBe(broken);
    });

    it('accepts superset-of-keys when original frontmatter is unparseable (regex fallback)', async () => {
      // When the original YAML is too broken to parse even as a fragment,
      // `compareFrontmatterFidelity` falls back to regex top-level key
      // extraction and only enforces the superset-of-keys invariant.
      // This is the intentional design — value-level deep-compare is
      // only meaningful when BOTH sides parse.
      //
      // Test: the LLM returns the same keys (with slightly different
      // whitespace in values) — we accept.
      const broken = '---\nfoo: {unclosed\nsharing: team\n---\n# body\n';
      const { settings, readmePath } = await seedSharedSpace('Regex-Fallback', broken);

      vi.mocked(bts.callWithModelAuthAware).mockResolvedValueOnce({
        content: [
          { type: 'text', text: '<FIXED_YAML>\nfoo: unclosed\nsharing: team\n</FIXED_YAML>' },
        ],
        model: 'stub-model',
      } as never);

      const result = await repairBrokenFrontmatter(coreDir, settings, journal);

      expect(result.repairedLLM).toBe(1);
      expect(result.unrepairable).toBe(0);
      const after = await fs.readFile(readmePath, 'utf8');
      const parsed = (await import('front-matter')).default(after);
      expect((parsed.attributes as Record<string, unknown>).foo).toBe('unclosed');
      expect((parsed.attributes as Record<string, unknown>).sharing).toBe('team');
    });

    it('dry-run performs no LLM calls, no writes, and reports preview counts', async () => {
      const bodyText = '# Body preserved\n';
      const broken = '---\nfoo: {unclosed\n---\n' + bodyText;
      const { settings, readmePath } = await seedSharedSpace('Dry-Run', broken);

      const btsSpy = vi.mocked(bts.callWithModelAuthAware);
      const beforeBytes = await fs.readFile(readmePath);
      const journalSaveSpy = vi.spyOn(journal, 'save');

      const result = await repairBrokenFrontmatter(coreDir, settings, journal, { dryRun: true });

      expect(btsSpy).not.toHaveBeenCalled();
      expect(journalSaveSpy).not.toHaveBeenCalled();
      // File untouched byte-for-byte.
      const afterBytes = await fs.readFile(readmePath);
      expect(afterBytes).toEqual(beforeBytes);

      // Preview counters populated.
      expect(result.checked).toBe(1);
      // The file couldn't be mechanically repaired; dry-run previews as
      // a "would invoke LLM" count.
      expect(result.repairedLLM).toBe(1);
      expect(result.repairedMechanical).toBe(0);
    });

    it('runDailyMaintenance wires repairBrokenFrontmatter into step 4', async () => {
      // Seed a mechanically-repairable broken space.
      const broken = [
        '---',
        'rebel_space_description: earlier',
        'sharing: team',
        'rebel_space_description: final',
        '---',
        '# body',
      ].join('\n');
      const { settings, readmePath } = await seedSharedSpace('Wired', broken);

      const retryStore = new SpaceMaintenanceRetryStore(userDataDir);
      const dailyDeps: DailyMaintenanceDeps = {
        moveToTrash: moveToTrashMock,
        emitTelemetry: vi.fn(),
      };

      const result = await runDailyMaintenance(
        coreDir,
        settings,
        journal,
        retryStore,
        dailyDeps,
      );

      // The daily pipeline surfaces mechanical repairs via frontmatterRepaired.
      expect(result.frontmatterRepaired).toBeGreaterThanOrEqual(1);

      // README was actually repaired on disk.
      const after = await fs.readFile(readmePath, 'utf8');
      const parsed = (await import('front-matter')).default(after);
      expect((parsed.attributes as Record<string, unknown>).rebel_space_description).toBe('final');
    });
  });

  // =========================================================================
  // Stage 4: Numbered-copy handling + legacy gate
  // =========================================================================

  describe('Stage 4: numbered-copy resolution', () => {
    let retryStore: SpaceMaintenanceRetryStore;
    let dailyDeps: DailyMaintenanceDeps;

    beforeEach(() => {
      retryStore = new SpaceMaintenanceRetryStore(userDataDir);
      dailyDeps = {
        moveToTrash: moveToTrashMock,
        emitTelemetry: vi.fn(),
      };
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    /**
     * Shape a utimes-adjusted numbered copy next to its base. Returns the
     * absolute paths for assertions. The numbered-copy mtime is configurable
     * so tests can hit either side of the LEGACY_DUPLICATE_THRESHOLD_MS.
     */
    async function seedNumberedCopyPair(options: {
      baseName: string;
      baseContent: string | null;
      conflictContent: string;
      conflictMtimeMs: number;
    }): Promise<{ base: string | null; conflict: string }> {
      const baseFile = `${options.baseName}.md`;
      const conflictFile = `${options.baseName} (1).md`;
      const basePath = options.baseContent != null ? path.join(coreDir, baseFile) : null;
      const conflictPath = path.join(coreDir, conflictFile);

      if (basePath && options.baseContent != null) {
        await writeFile(basePath, options.baseContent);
      }
      await writeFile(conflictPath, options.conflictContent);
      await fs.utimes(
        conflictPath,
        options.conflictMtimeMs / 1000,
        options.conflictMtimeMs / 1000,
      );
      return { base: basePath, conflict: conflictPath };
    }

    // ---- Legacy gate -------------------------------------------------------

    it('classifies numbered copies older than LEGACY_DUPLICATE_THRESHOLD_MS as legacy-duplicate and persists the entry', async () => {
      const nowMs = 1_700_000_000_000;
      // Two years + a week ago -> clearly legacy.
      const mtimeMs = nowMs - (2 * 365 + 7) * 24 * 60 * 60 * 1000;
      const { conflict } = await seedNumberedCopyPair({
        baseName: 'legacy-notes',
        baseContent: 'current base content',
        conflictContent: 'old cloud import from 2014',
        conflictMtimeMs: mtimeMs,
      });

      // proposeMerge must NEVER run for a legacy file.
      const proposeMergeSpy = vi.spyOn(resolver, 'proposeMerge');

      const result = await runDailyMaintenance(
        coreDir,
        makeSettings(),
        journal,
        retryStore,
        dailyDeps,
        { now: () => nowMs },
      );

      expect(result.numberedCopyLegacySkipped).toBe(1);
      expect(result.numberedCopyMerged).toBe(0);
      expect(result.numberedCopyQuarantinedIdentical).toBe(0);
      expect(proposeMergeSpy).not.toHaveBeenCalled();
      expect(moveToTrashMock).not.toHaveBeenCalled();

      // File untouched.
      expect(fsSync.existsSync(conflict)).toBe(true);

      // LegacyDuplicateEntry persisted.
      const { state } = await journal.load();
      const legacy = state.entries.filter((e) => e.type === 'legacy-duplicate');
      expect(legacy).toHaveLength(1);
      if (legacy[0].type === 'legacy-duplicate') {
        expect(legacy[0].conflictPath).toBe(conflict);
      }
    });

    it('does NOT re-classify an already-persisted legacy entry (skips stat + LLM)', async () => {
      const nowMs = 1_700_000_000_000;
      const mtimeMs = nowMs - (2 * 365 + 7) * 24 * 60 * 60 * 1000;
      const { conflict } = await seedNumberedCopyPair({
        baseName: 'preflagged',
        baseContent: 'anything',
        conflictContent: 'legacy bytes',
        conflictMtimeMs: mtimeMs,
      });

      // Seed the journal as-if we'd already classified this conflict.
      await journal.save({
        schemaVersion: 2,
        updatedAt: 0,
        entries: [
          {
            type: 'legacy-duplicate',
            conflictPath: conflict,
            fileMtimeMs: mtimeMs,
            classifiedAt: nowMs - 24 * 60 * 60 * 1000,
          },
        ],
      });

      const statSpy = vi.spyOn(fs, 'stat');
      const proposeMergeSpy = vi.spyOn(resolver, 'proposeMerge');

      const result = await runDailyMaintenance(
        coreDir,
        makeSettings(),
        journal,
        retryStore,
        dailyDeps,
        { now: () => nowMs },
      );

      // Counter still fires (informational) but the stat + LLM paths must
      // NEVER run — that was the whole point of persistence.
      expect(result.numberedCopyLegacySkipped).toBe(1);
      expect(proposeMergeSpy).not.toHaveBeenCalled();
      expect(moveToTrashMock).not.toHaveBeenCalled();

      // Stat should not have been called for the conflict path. (We allow
      // other stat calls — the scheduler's own pipeline touches many.)
      const statCalledOnConflict = statSpy.mock.calls.some(
        (c) => typeof c[0] === 'string' && c[0] === conflict,
      );
      expect(statCalledOnConflict).toBe(false);
    });

    // ---- Base exists + identical ------------------------------------------

    it('quarantines an identical non-legacy numbered copy via moveToTrash with no LLM call', async () => {
      const nowMs = 1_700_000_000_000;
      const content = 'identical\nbytes across copies.\n';
      // Within threshold — NOT legacy.
      const recentMtime = nowMs - 30 * 24 * 60 * 60 * 1000;
      const { base, conflict } = await seedNumberedCopyPair({
        baseName: 'twin',
        baseContent: content,
        conflictContent: content,
        conflictMtimeMs: recentMtime,
      });

      const proposeMergeSpy = vi.spyOn(resolver, 'proposeMerge');

      const result = await runDailyMaintenance(
        coreDir,
        makeSettings(),
        journal,
        retryStore,
        dailyDeps,
        { now: () => nowMs },
      );

      expect(result.numberedCopyQuarantinedIdentical).toBe(1);
      expect(result.numberedCopyMerged).toBe(0);
      expect(proposeMergeSpy).not.toHaveBeenCalled();
      expect(moveToTrashMock).toHaveBeenCalledWith(conflict);
      // Base file is unmodified.
      expect(await fs.readFile(base!, 'utf8')).toBe(content);

      // Resolution log entries + counter were written.
      const { state } = await journal.load();
      const counter = state.entries.find((e) => e.type === 'resolution-counter');
      expect(counter?.type).toBe('resolution-counter');
      if (counter?.type === 'resolution-counter') {
        expect(counter.total).toBeGreaterThanOrEqual(1);
      }
      const logs = state.entries.filter((e) => e.type === 'resolution-log');
      expect(logs.length).toBeGreaterThanOrEqual(1);
      const kinds = logs
        .filter((e): e is Extract<JournalEntry, { type: 'resolution-log' }> => e.type === 'resolution-log')
        .map((e) => e.kind);
      expect(kinds).toContain('numbered-copy-identical');
    });

    // ---- Base exists + differing -------------------------------------------

    it('merges a differing non-legacy numbered copy via proposeMerge and quarantines the copy', async () => {
      const nowMs = 1_700_000_000_000;
      const recentMtime = nowMs - 30 * 24 * 60 * 60 * 1000;
      const baseContent = '# Notes\n\nbase body line.\nbase body line two.\n';
      const conflictContent = '# Notes\n\ndivergent body line.\ndivergent two.\n';
      const mergedContent = '# Notes\n\nmerged body line.\nmerged body two.\n';

      const { base, conflict } = await seedNumberedCopyPair({
        baseName: 'merge-me',
        baseContent,
        conflictContent,
        conflictMtimeMs: recentMtime,
      });

      const proposeMergeSpy = vi.spyOn(resolver, 'proposeMerge').mockResolvedValue({
        success: true,
        mergedContent,
      });

      const result = await runDailyMaintenance(
        coreDir,
        makeSettings(),
        journal,
        retryStore,
        dailyDeps,
        { now: () => nowMs },
      );

      expect(proposeMergeSpy).toHaveBeenCalledTimes(1);
      expect(result.numberedCopyMerged).toBe(1);
      expect(result.mergeFailed).toBe(0);

      // Base was rewritten with merged bytes.
      expect(await fs.readFile(base!, 'utf8')).toBe(mergedContent);
      expect(moveToTrashMock).toHaveBeenCalledWith(conflict);

      // Resolution log records a numbered-copy-merged event.
      const { state } = await journal.load();
      const logs = state.entries
        .filter((e): e is Extract<JournalEntry, { type: 'resolution-log' }> => e.type === 'resolution-log')
        .map((e) => e.kind);
      expect(logs).toContain('numbered-copy-merged');
    });

    // ---- Base missing: sync-stability gate (never auto-rename) -------------

    it('never auto-renames when base is missing; advances sync-stability counter across scans', async () => {
      const t0 = 1_700_000_000_000;
      // No base file — only the numbered copy exists.
      const { conflict } = await seedNumberedCopyPair({
        baseName: 'gone',
        baseContent: null,
        conflictContent: 'orphan body',
        conflictMtimeMs: t0,
      });

      const proposeMergeSpy = vi.spyOn(resolver, 'proposeMerge');

      // --- Scan 1 ---
      const r1 = await runDailyMaintenance(
        coreDir,
        makeSettings(),
        journal,
        retryStore,
        dailyDeps,
        { now: () => t0 },
      );
      expect(r1.numberedCopyPendingStability).toBe(1);
      expect(r1.numberedCopyPendingUserReview).toBe(0);
      expect(proposeMergeSpy).not.toHaveBeenCalled();
      expect(moveToTrashMock).not.toHaveBeenCalled();
      // File still on disk (never auto-renamed).
      expect(fsSync.existsSync(conflict)).toBe(true);

      const { state: s1 } = await journal.load();
      const orphan1 = s1.entries.find((e) => e.type === 'numbered-copy-orphan');
      expect(orphan1?.type).toBe('numbered-copy-orphan');

      // --- Scan 2 (1h later) ---
      const t1 = t0 + 60 * 60 * 1000;
      await runDailyMaintenance(
        coreDir,
        makeSettings(),
        journal,
        retryStore,
        dailyDeps,
        { now: () => t1 },
      );

      // --- Scan 3 (past 48h) ---
      const t2 = t0 + ORPHAN_STABILITY_MIN_AGE_MS + 60 * 1000;
      const r3 = await runDailyMaintenance(
        coreDir,
        makeSettings(),
        journal,
        retryStore,
        dailyDeps,
        { now: () => t2 },
      );

      // Gate has now passed -> pending-user-review, NOT auto-renamed.
      expect(r3.numberedCopyPendingUserReview).toBe(1);
      expect(r3.numberedCopyPendingStability).toBe(0);
      expect(moveToTrashMock).not.toHaveBeenCalled();
      expect(fsSync.existsSync(conflict)).toBe(true);

      const { state: s3 } = await journal.load();
      const orphan3 = s3.entries.find((e) => e.type === 'numbered-copy-orphan');
      if (orphan3?.type === 'numbered-copy-orphan') {
        expect(orphan3.stableScanCount).toBeGreaterThanOrEqual(ORPHAN_STABILITY_MIN_SCANS);
      }
    });

    // ---- Dry-run contract --------------------------------------------------

    it('dry-run makes no LLM calls, no writes, no trash moves, no journal mutations — but reports preview counts', async () => {
      const nowMs = 1_700_000_000_000;
      const recentMtime = nowMs - 30 * 24 * 60 * 60 * 1000;
      const legacyMtime = nowMs - (2 * 365 + 7) * 24 * 60 * 60 * 1000;

      // One of each classification so the dry-run exercises all branches.
      const pairs = await Promise.all([
        seedNumberedCopyPair({
          baseName: 'identical',
          baseContent: 'same',
          conflictContent: 'same',
          conflictMtimeMs: recentMtime,
        }),
        seedNumberedCopyPair({
          baseName: 'differ',
          baseContent: 'local body\n',
          conflictContent: 'cloud body\n',
          conflictMtimeMs: recentMtime,
        }),
        seedNumberedCopyPair({
          baseName: 'legacy',
          baseContent: 'anything',
          conflictContent: 'ancient',
          conflictMtimeMs: legacyMtime,
        }),
        seedNumberedCopyPair({
          baseName: 'orphan',
          baseContent: null,
          conflictContent: 'no-base',
          conflictMtimeMs: recentMtime,
        }),
      ]);

      const proposeMergeSpy = vi.spyOn(resolver, 'proposeMerge');
      const journalSaveSpy = vi.spyOn(journal, 'save');
      const retrySaveSpy = vi.spyOn(retryStore, 'save');

      const result = await runDailyMaintenance(
        coreDir,
        makeSettings(),
        journal,
        retryStore,
        dailyDeps,
        { dryRun: true, now: () => nowMs },
      );

      expect(proposeMergeSpy).not.toHaveBeenCalled();
      expect(moveToTrashMock).not.toHaveBeenCalled();
      expect(journalSaveSpy).not.toHaveBeenCalled();
      expect(retrySaveSpy).not.toHaveBeenCalled();

      // Preview counts reflect "what Rebel would have done".
      expect(result.numberedCopyQuarantinedIdentical).toBe(1);
      expect(result.numberedCopyMerged).toBe(1);
      expect(result.numberedCopyLegacySkipped).toBe(1);
      expect(result.numberedCopyPendingStability).toBe(1);

      // Filesystem untouched: every numbered copy still on disk.
      for (const pair of pairs) {
        expect(fsSync.existsSync(pair.conflict)).toBe(true);
      }
    });
  });
});
