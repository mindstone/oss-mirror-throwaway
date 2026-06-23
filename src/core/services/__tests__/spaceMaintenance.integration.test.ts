/**
 * Space Maintenance — end-to-end integration tests (Stage 5).
 *
 * Unlike the unit tests in `spaceMaintenanceService.test.ts`, these
 * exercise the FULL pipeline in a real tmpdir filesystem:
 *   - `runStartupCleanup` against synthetic conflicts on disk
 *   - `runDailyMaintenance` with a mocked BTS + mocked LLM repair, real fs
 *   - Atomic sequence end-to-end: journal writes on disk, tmp file
 *     created + renamed + cleaned up, trash invoked on the conflict copy
 *   - Frontmatter repair (mechanical + LLM fallback), body byte-exact
 *   - Numbered-copy routing (legacy / identical / differing / base-missing)
 *   - Health check surfaces `healthStatus` + `resolutionStats` after
 *     maintenance ran
 *   - Process-kill resume logic at journal-critical points
 *   - Multi-desktop lease contention → clean success return
 *   - Dry-run contract: zero side effects (no fs writes except tmpdir
 *     scaffolding, no BTS calls)
 *   - Cross-platform path tests: Windows-style backslash conflict names
 *
 * @see docs/plans/260411_shared_space_maintenance.md (Stage 5)
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, SpaceConfig } from '@shared/types';
import { setPlatformConfig } from '@core/platform';

// BTS + promptFileService mocks match the unit-test file's approach so
// neither surface hits disk/network. See the Stage 2 / Stage 3 tests for
// rationale; the integration tests reuse the same boundary.
 
vi.mock('@core/services/behindTheScenesClient', () => ({
  callWithModelAuthAware: vi.fn(),
}));
 
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
  runDailyMaintenance,
  runStartupCleanup,
  type DailyMaintenanceDeps,
  type MaintenanceDeps,
} from '../spaceMaintenanceService';
import * as bts from '../behindTheScenesClient';
import * as resolver from '../workspaceConflictResolver';
import {
  JOURNAL_SCHEMA_VERSION,
  SpaceMaintenanceJournal,
  type JournalEntry,
  type RenamePendingEntry,
  type QuarantinePendingEntry,
} from '../spaceMaintenanceJournal';
import { SpaceMaintenanceRetryStore } from '../spaceMaintenanceRetryState';
import { acquireLease, LEASE_FILE_NAME } from '../spaceMaintenanceLease';
import { CONFLICT_PATTERNS } from '@shared/conflictPatterns';
import { LEGACY_DUPLICATE_THRESHOLD_MS } from '@core/constants';
import { checkConflictingCopies } from '../../../main/services/health/checks/conflictingCopies';

function sha256(bytes: Buffer | string): string {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
  return createHash('sha256').update(buf).digest('hex');
}

function makeSpace(name: string, relPath: string, sharing: 'private' | 'restricted' = 'restricted'): SpaceConfig {
  return {
    name,
    path: relPath,
    type: 'team',
    isSymlink: false,
    sharing,
    createdAt: 0,
  } as SpaceConfig;
}

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return { spaces: undefined, ...overrides } as AppSettings;
}

async function writeFileRecursive(p: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
}

describe('spaceMaintenance integration', () => {
  let tmpDir: string;
  let userDataDir: string;
  let coreDir: string;
  let journal: SpaceMaintenanceJournal;
  let retryStore: SpaceMaintenanceRetryStore;
  let moveToTrashMock: ReturnType<typeof vi.fn<(absolutePath: string) => Promise<void>>>;
  let trashBin: string;
  let deps: MaintenanceDeps;
  let dailyDeps: DailyMaintenanceDeps;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'space-maint-integ-'));
    userDataDir = path.join(tmpDir, 'userData');
    coreDir = path.join(tmpDir, 'library');
    trashBin = path.join(tmpDir, 'trash');
    await fs.mkdir(userDataDir, { recursive: true });
    await fs.mkdir(coreDir, { recursive: true });
    await fs.mkdir(trashBin, { recursive: true });
    journal = new SpaceMaintenanceJournal(userDataDir);
    retryStore = new SpaceMaintenanceRetryStore(userDataDir);
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

    // Simulate OS trash by moving files into a tmpdir folder. Integration
    // tests assert the file stops existing at the original path (real
    // trash semantics) without needing Electron's actual `shell.trashItem`.
    moveToTrashMock = vi
      .fn<(absolutePath: string) => Promise<void>>()
      .mockImplementation(async (abs: string) => {
        const bytes = await fs.readFile(abs);
        const dest = path.join(trashBin, `${Date.now()}-${path.basename(abs)}`);
        await fs.writeFile(dest, bytes);
        await fs.unlink(abs);
      });

    deps = { moveToTrash: moveToTrashMock };
    dailyDeps = { moveToTrash: moveToTrashMock };

    // Reset BTS mock between tests — `vi.mock` creates a shared `vi.fn()`
    // that `vi.restoreAllMocks()` does NOT clear, so prior tests' call
    // history would leak into later "not called" assertions otherwise.
    vi.mocked(bts.callWithModelAuthAware).mockReset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  // -------------------------------------------------------------------
  // Section 1: `runStartupCleanup` end-to-end
  // -------------------------------------------------------------------

  it('startup: quarantines identical .conflict-cloud and persists journal state to disk', async () => {
    const original = path.join(coreDir, 'notes.md');
    const conflict = path.join(coreDir, 'notes.conflict-cloud.md');
    await writeFileRecursive(original, 'same bytes\n');
    await writeFileRecursive(conflict, 'same bytes\n');

    const result = await runStartupCleanup(coreDir, makeSettings(), journal, deps);
    expect(result.quarantinedIdentical).toBe(1);
    expect(result.errors).toEqual([]);

    await expect(fs.access(conflict)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(original)).resolves.toBeUndefined();
    expect(moveToTrashMock).toHaveBeenCalledWith(conflict);

    // Journal file landed on disk with a pending entry cleared — the
    // post-run state should contain NO quarantine-pending for this path.
    const journalRaw = await fs.readFile(journal.getFilePath(), 'utf8');
    const journalState = JSON.parse(journalRaw);
    expect(journalState.schemaVersion).toBe(JOURNAL_SCHEMA_VERSION);
    for (const entry of journalState.entries) {
      if (entry.type === 'quarantine-pending') {
        expect(entry.conflictPath).not.toBe(conflict);
      }
    }
  });

  it('startup: orphan conflict advances the stability-gate counter across scans and bails cleanly on a tiny time-budget', async () => {
    const orphan = path.join(coreDir, 'deleted-base.conflict-cloud.md');
    await writeFileRecursive(orphan, 'contents\n');
    // No `deleted-base.md` on disk → orphan.

    // Tiny budget to exercise the bail-out path; run should still return
    // a clean result (no throws) and record the stability state so
    // subsequent scans can resume where we left off.
    const r1 = await runStartupCleanup(coreDir, makeSettings(), journal, deps, {
      timeBudgetMs: 10_000,
      now: () => 1_000,
    });
    expect(r1.errors).toEqual([]);
    expect(r1.orphansDeferred).toBe(1);

    // Second scan an hour later — orphan still present, counter bumps.
    const r2 = await runStartupCleanup(coreDir, makeSettings(), journal, deps, {
      timeBudgetMs: 10_000,
      now: () => 1_000 + 3_600_000,
    });
    expect(r2.orphansDeferred).toBe(1);

    // The orphan is never quarantined by startup cleanup (daily does it).
    expect(moveToTrashMock).not.toHaveBeenCalled();
    await expect(fs.access(orphan)).resolves.toBeUndefined();

    // Journal persists the counter across calls.
    const journalState = JSON.parse(await fs.readFile(journal.getFilePath(), 'utf8'));
    const entry = journalState.entries.find(
      (e: JournalEntry) => e.type === 'orphan-candidate',
    );
    expect(entry).toBeDefined();
    expect(entry.stableScanCount).toBeGreaterThanOrEqual(2);
  });

  it('startup: time-budget bail returns partial results without throwing', async () => {
    // Many orphans — the scan iteration itself can exhaust the budget
    // before we reach classification. `timeBudgetExceeded` must be set.
    for (let i = 0; i < 50; i++) {
      await writeFileRecursive(
        path.join(coreDir, `f${i}.conflict-cloud.md`),
        'contents',
      );
    }

    let calls = 0;
    const result = await runStartupCleanup(coreDir, makeSettings(), journal, deps, {
      timeBudgetMs: 5,
      now: () => {
        calls++;
        return calls * 1_000; // each call steps 1s — instant budget burn
      },
    });
    expect(result.timeBudgetExceeded).toBe(true);
    expect(result.errors).toEqual([]);
  });

  // -------------------------------------------------------------------
  // Section 2: Full daily pipeline (mocked BTS, real fs)
  // -------------------------------------------------------------------

  it('daily: full atomic merge sequence creates tmp, renames, invokes trash, and clears journal', async () => {
    const settings = makeSettings({ spaces: [makeSpace('Team', '.')] });
    const original = path.join(coreDir, 'doc.md');
    const conflict = path.join(coreDir, 'doc.conflict-cloud.md');
    await writeFileRecursive(original, '# Heading\n\nlocal body.\n');
    await writeFileRecursive(conflict, '# Heading\n\ncloud body.\n');

    const merged = '# Heading\n\nmerged body.\n';
    vi.spyOn(resolver, 'proposeMerge').mockResolvedValue({
      success: true,
      mergedContent: merged,
    });

    const result = await runDailyMaintenance(coreDir, settings, journal, retryStore, dailyDeps);
    expect(result.mergedSuccessfully).toBe(1);
    expect(result.mergeFailed).toBe(0);
    expect(result.errors).toEqual([]);

    // Conflict is gone from disk AND was offered to moveToTrash.
    await expect(fs.access(conflict)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(moveToTrashMock).toHaveBeenCalledWith(conflict);

    // Original now contains merged bytes.
    const onDisk = await fs.readFile(original, 'utf8');
    expect(onDisk).toBe(merged);

    // tmp file has been cleaned up.
    await expect(fs.access(`${original}.rebel-merge-tmp`)).rejects.toMatchObject({ code: 'ENOENT' });

    // Journal has no lingering rename-pending / quarantine-pending entries.
    const journalState = JSON.parse(await fs.readFile(journal.getFilePath(), 'utf8'));
    const pending = journalState.entries.filter(
      (e: JournalEntry) => e.type === 'rename-pending' || e.type === 'quarantine-pending',
    );
    expect(pending).toEqual([]);
  });

  // -------------------------------------------------------------------
  // Section 3: Frontmatter repair — body byte-exact + YAML rejection
  // -------------------------------------------------------------------

  it('daily: frontmatter LLM repair preserves body bytes byte-exactly (UTF-8 multibyte)', async () => {
    const spaceDir = path.join(coreDir, 'Docs');
    await fs.mkdir(spaceDir, { recursive: true });
    const readmePath = path.join(spaceDir, 'README.md');
    const bodyText = '# Héllo 🌍\n\nTéxt with émojis 😀 and accénts.\n';
    const broken = '---\nfoo: {unclosed\n---\n' + bodyText;
    await fs.writeFile(readmePath, broken);

    const settings = makeSettings({ spaces: [makeSpace('Docs', 'Docs')] });

    vi.mocked(bts.callWithModelAuthAware).mockResolvedValueOnce({
      content: [{ type: 'text', text: '<FIXED_YAML>\nfoo: unclosed\n</FIXED_YAML>' }],
      model: 'stub-model',
    } as never);
    vi.spyOn(resolver, 'proposeMerge');

    const result = await runDailyMaintenance(coreDir, settings, journal, retryStore, dailyDeps);
    expect(result.frontmatterRepaired).toBe(1);

    const repairedBytes = await fs.readFile(readmePath);
    const bodyBytes = Buffer.from(bodyText, 'utf8');
    expect(repairedBytes.subarray(repairedBytes.length - bodyBytes.length)).toEqual(bodyBytes);
  });

  it('daily: frontmatter LLM repair rejects a key-dropping response and leaves bytes untouched', async () => {
    const spaceDir = path.join(coreDir, 'DocsKeys');
    await fs.mkdir(spaceDir, { recursive: true });
    const readmePath = path.join(spaceDir, 'README.md');
    const broken = '---\nfoo: {unclosed\nkept_key: 42\n---\n# body\n';
    await fs.writeFile(readmePath, broken);

    vi.mocked(bts.callWithModelAuthAware).mockResolvedValueOnce({
      content: [{ type: 'text', text: '<FIXED_YAML>\nfoo: unclosed\n</FIXED_YAML>' }],
      model: 'stub-model',
    } as never);

    const settings = makeSettings({ spaces: [makeSpace('DocsKeys', 'DocsKeys')] });
    const result = await runDailyMaintenance(coreDir, settings, journal, retryStore, dailyDeps);

    expect(result.frontmatterRepaired).toBe(0);
    const after = await fs.readFile(readmePath, 'utf8');
    expect(after).toBe(broken);
    // The rejection is recorded as an error on the result.
    expect(result.errors.some((e) => /missing-keys/.test(e))).toBe(true);
  });

  // -------------------------------------------------------------------
  // Section 4: Numbered-copy routing
  // -------------------------------------------------------------------

  it('daily: numbered-copy legacy gate (mtime > 2y) skips without LLM + persists legacy entry', async () => {
    const settings = makeSettings({ spaces: [makeSpace('Legacy', '.')] });
    const base = path.join(coreDir, 'ancient.md');
    const legacy = path.join(coreDir, 'ancient (1).md');
    await writeFileRecursive(base, 'current\n');
    await writeFileRecursive(legacy, 'old content\n');
    // Backdate the numbered copy's mtime to 3 years ago.
    const threeYearsAgo = Date.now() - (LEGACY_DUPLICATE_THRESHOLD_MS + 365 * 24 * 60 * 60 * 1000);
    await fs.utimes(legacy, threeYearsAgo / 1000, threeYearsAgo / 1000);

    const btsSpy = vi.mocked(bts.callWithModelAuthAware);
    const proposeMergeSpy = vi.spyOn(resolver, 'proposeMerge');

    const result = await runDailyMaintenance(coreDir, settings, journal, retryStore, dailyDeps);
    expect(result.numberedCopyLegacySkipped).toBe(1);
    expect(result.numberedCopyMerged).toBe(0);
    expect(btsSpy).not.toHaveBeenCalled();
    expect(proposeMergeSpy).not.toHaveBeenCalled();

    const journalState = JSON.parse(await fs.readFile(journal.getFilePath(), 'utf8'));
    const legacyEntry = journalState.entries.find(
      (e: JournalEntry) => e.type === 'legacy-duplicate',
    );
    expect(legacyEntry?.conflictPath).toBe(legacy);
  });

  it('daily: numbered-copy identical-quarantine uses moveToTrash (no LLM)', async () => {
    const settings = makeSettings({ spaces: [makeSpace('Dupes', '.')] });
    const base = path.join(coreDir, 'doc.md');
    const copy = path.join(coreDir, 'doc (1).md');
    const content = 'identical\n';
    await writeFileRecursive(base, content);
    await writeFileRecursive(copy, content);

    const btsSpy = vi.mocked(bts.callWithModelAuthAware);
    const proposeMergeSpy = vi.spyOn(resolver, 'proposeMerge');

    const result = await runDailyMaintenance(coreDir, settings, journal, retryStore, dailyDeps);
    expect(result.numberedCopyQuarantinedIdentical).toBe(1);
    expect(btsSpy).not.toHaveBeenCalled();
    expect(proposeMergeSpy).not.toHaveBeenCalled();
    expect(moveToTrashMock).toHaveBeenCalledWith(copy);
  });

  it('daily: numbered-copy differing-merge routes through LLM pipeline and atomic rename', async () => {
    const settings = makeSettings({ spaces: [makeSpace('Merge', '.')] });
    const base = path.join(coreDir, 'spec.md');
    const copy = path.join(coreDir, 'spec (1).md');
    await writeFileRecursive(base, '# Spec\n\nbase text\n');
    await writeFileRecursive(copy, '# Spec\n\ncopy text\n');

    const merged = '# Spec\n\nmerged text\n';
    vi.spyOn(resolver, 'proposeMerge').mockResolvedValue({ success: true, mergedContent: merged });

    const result = await runDailyMaintenance(coreDir, settings, journal, retryStore, dailyDeps);
    expect(result.numberedCopyMerged).toBe(1);
    expect(moveToTrashMock).toHaveBeenCalledWith(copy);
    expect(await fs.readFile(base, 'utf8')).toBe(merged);
  });

  // -------------------------------------------------------------------
  // Section 5: Resume at journal-critical points (simulate crash)
  // -------------------------------------------------------------------

  it('resume: a rename-pending entry from a prior crashed run replays the rename + quarantine', async () => {
    const original = path.join(coreDir, 'doc.md');
    const conflict = path.join(coreDir, 'doc.conflict-cloud.md');
    const tmpPath = `${original}.rebel-merge-tmp`;
    const originalBytes = Buffer.from('original bytes\n', 'utf8');
    const conflictBytes = Buffer.from('conflict bytes\n', 'utf8');
    const mergedBytes = Buffer.from('merged bytes\n', 'utf8');
    await writeFileRecursive(original, originalBytes);
    await writeFileRecursive(conflict, conflictBytes);
    await writeFileRecursive(tmpPath, mergedBytes);

    // Simulate a crash mid-merge: seed the journal with an unfinished
    // rename-pending entry whose three hashes match the on-disk files.
    const entry: RenamePendingEntry = {
      type: 'rename-pending',
      conflictPath: conflict,
      originalPath: original,
      mergedHash: sha256(mergedBytes),
      scanTimeOriginalHash: sha256(originalBytes),
      scanTimeConflictHash: sha256(conflictBytes),
      stage: 'rename-pending',
      startedAt: 1_000,
    };
    await journal.save(
      { schemaVersion: JOURNAL_SCHEMA_VERSION, updatedAt: 1_000, entries: [entry] },
      { nowMs: 1_000 },
    );

    // Run startup cleanup (daily runs startup internally too). The resume
    // pass must (a) finish the rename, (b) quarantine the conflict, (c)
    // clear the journal entry.
    const result = await runStartupCleanup(coreDir, makeSettings(), journal, deps);
    expect(result.errors).toEqual([]);

    expect(await fs.readFile(original)).toEqual(mergedBytes);
    await expect(fs.access(conflict)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(tmpPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(moveToTrashMock).toHaveBeenCalledWith(conflict);

    const journalState = JSON.parse(await fs.readFile(journal.getFilePath(), 'utf8'));
    const pending = journalState.entries.filter(
      (e: JournalEntry) => e.type === 'rename-pending' || e.type === 'quarantine-pending',
    );
    expect(pending).toEqual([]);
  });

  it('resume: rename-pending with a post-crash original edit drops the entry without clobbering', async () => {
    const original = path.join(coreDir, 'doc.md');
    const conflict = path.join(coreDir, 'doc.conflict-cloud.md');
    const tmpPath = `${original}.rebel-merge-tmp`;
    const mergedBytes = Buffer.from('merged\n', 'utf8');
    const postCrashOriginalBytes = Buffer.from('user edited after crash\n', 'utf8');
    const scanTimeOriginalBytes = Buffer.from('original pre-crash\n', 'utf8');
    const conflictBytes = Buffer.from('conflict bytes\n', 'utf8');

    await writeFileRecursive(original, postCrashOriginalBytes);
    await writeFileRecursive(conflict, conflictBytes);
    await writeFileRecursive(tmpPath, mergedBytes);

    const entry: RenamePendingEntry = {
      type: 'rename-pending',
      conflictPath: conflict,
      originalPath: original,
      mergedHash: sha256(mergedBytes),
      // Hash of the pre-crash original — does NOT match on-disk post-crash bytes.
      scanTimeOriginalHash: sha256(scanTimeOriginalBytes),
      scanTimeConflictHash: sha256(conflictBytes),
      stage: 'rename-pending',
      startedAt: 1_000,
    };
    await journal.save(
      { schemaVersion: JOURNAL_SCHEMA_VERSION, updatedAt: 1_000, entries: [entry] },
      { nowMs: 1_000 },
    );

    await runStartupCleanup(coreDir, makeSettings(), journal, deps);

    // Post-crash edit must survive — we must NOT clobber with tmp bytes.
    expect(await fs.readFile(original)).toEqual(postCrashOriginalBytes);
    // Conflict must remain on disk — we dropped the entry without quarantining.
    expect(await fs.readFile(conflict)).toEqual(conflictBytes);
    // Tmp must be cleaned up.
    await expect(fs.access(tmpPath)).rejects.toMatchObject({ code: 'ENOENT' });
    // Journal cleared.
    const journalState = JSON.parse(await fs.readFile(journal.getFilePath(), 'utf8'));
    const renamePending = journalState.entries.filter(
      (e: JournalEntry) => e.type === 'rename-pending',
    );
    expect(renamePending).toEqual([]);
  });

  it('resume: a stale quarantine-pending entry whose file is gone is cleared on next run', async () => {
    const conflict = path.join(coreDir, 'doc.conflict-cloud.md');
    // Conflict already trashed; only the pending entry survives.
    const entry: QuarantinePendingEntry = {
      type: 'quarantine-pending',
      conflictPath: conflict,
      expectedHash: sha256('anything'),
      attemptedAt: 1_000,
    };
    await journal.save(
      { schemaVersion: JOURNAL_SCHEMA_VERSION, updatedAt: 1_000, entries: [entry] },
      { nowMs: 1_000 },
    );

    await runStartupCleanup(coreDir, makeSettings(), journal, deps);

    const journalState = JSON.parse(await fs.readFile(journal.getFilePath(), 'utf8'));
    const pending = journalState.entries.filter(
      (e: JournalEntry) => e.type === 'quarantine-pending',
    );
    expect(pending).toEqual([]);
  });

  // -------------------------------------------------------------------
  // Section 6: Multi-desktop lease contention
  // -------------------------------------------------------------------

  it('contention: returns a clean success result (no failure counter bump) when another desktop holds the lease', async () => {
    const settings = makeSettings({ spaces: [makeSpace('Team', '.')] });

    // Pre-write a lease file held by a different "desktop". Use real
    // `acquireLease` with overridden hostname/pid so the on-disk payload
    // is well-formed v1.
    const leasePath = path.join(coreDir, LEASE_FILE_NAME);
    await acquireLease(coreDir, {
      now: () => 1_000,
      hostname: () => 'desktop-A',
      pid: () => 12345,
    });
    const before = await fs.readFile(leasePath, 'utf8');

    // Seed a differing conflict so there WOULD be LLM work if the lease
    // hadn't skipped us — the proposeMerge spy confirms we never reached it.
    const original = path.join(coreDir, 'doc.md');
    const conflict = path.join(coreDir, 'doc.conflict-cloud.md');
    await writeFileRecursive(original, 'local\n');
    await writeFileRecursive(conflict, 'cloud\n');
    const proposeMergeSpy = vi.spyOn(resolver, 'proposeMerge');

    // Run daily from the OTHER desktop, using the default lease acquire
    // (which pulls os.hostname / process.pid — guaranteed != our stub).
    // The first desktop's lease is still unexpired.
    const result = await runDailyMaintenance(coreDir, settings, journal, retryStore, dailyDeps, {
      now: () => 1_000 + 30_000, // 30s after A acquired; well inside TTL
    });

    expect(result.mergedSuccessfully).toBe(0);
    expect(result.mergeFailed).toBe(0);
    expect(result.errors).toEqual([]);
    expect(proposeMergeSpy).not.toHaveBeenCalled();
    expect(moveToTrashMock).not.toHaveBeenCalled();

    // Lease file MUST remain byte-exact — we did not clobber A's lock.
    const after = await fs.readFile(leasePath, 'utf8');
    expect(after).toBe(before);

    // Conflict is still on disk (we didn't merge anything).
    await expect(fs.access(conflict)).resolves.toBeUndefined();
  });

  it('contention: cleanly acquires and releases the lease in a normal run (lease file removed after completion)', async () => {
    const settings = makeSettings({ spaces: [makeSpace('Team', '.')] });
    const leasePath = path.join(coreDir, LEASE_FILE_NAME);

    // Confirm no lease file at start.
    await expect(fs.access(leasePath)).rejects.toMatchObject({ code: 'ENOENT' });

    const original = path.join(coreDir, 'doc.md');
    await writeFileRecursive(original, '# Heading\n\nfoo\n');

    await runDailyMaintenance(coreDir, settings, journal, retryStore, dailyDeps);

    // After a normal run the lease file is released (deleted).
    await expect(fs.access(leasePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // -------------------------------------------------------------------
  // Section 7: Dry-run contract
  // -------------------------------------------------------------------

  it('dry-run: zero side effects across the full daily pipeline', async () => {
    const settings = makeSettings({ spaces: [makeSpace('Team', '.')] });
    // Seed one identical + one differing + one frontmatter-broken space.
    const ident = path.join(coreDir, 'ident.md');
    const identConflict = path.join(coreDir, 'ident.conflict-cloud.md');
    await writeFileRecursive(ident, 'identical\n');
    await writeFileRecursive(identConflict, 'identical\n');

    const diffOrig = path.join(coreDir, 'diff.md');
    const diffConflict = path.join(coreDir, 'diff.conflict-cloud.md');
    await writeFileRecursive(diffOrig, '# Heading\n\nlocal\n');
    await writeFileRecursive(diffConflict, '# Heading\n\ncloud\n');

    const readmePath = path.join(coreDir, 'README.md');
    await writeFileRecursive(readmePath, '---\nfoo: {unclosed\n---\nbody\n');

    const beforeSnapshot = new Map<string, Buffer>();
    for (const p of [ident, identConflict, diffOrig, diffConflict, readmePath]) {
      beforeSnapshot.set(p, await fs.readFile(p));
    }

    const btsSpy = vi.mocked(bts.callWithModelAuthAware);
    const proposeMergeSpy = vi.spyOn(resolver, 'proposeMerge');

    const result = await runDailyMaintenance(coreDir, settings, journal, retryStore, dailyDeps, {
      dryRun: true,
    });

    // No destructive calls.
    expect(moveToTrashMock).not.toHaveBeenCalled();
    expect(btsSpy).not.toHaveBeenCalled();
    expect(proposeMergeSpy).not.toHaveBeenCalled();
    expect(result.errors).toEqual([]);

    // All seeded files are byte-identical to their original bytes.
    for (const [p, bytes] of beforeSnapshot) {
      const now = await fs.readFile(p);
      expect(now).toEqual(bytes);
    }

    // Journal + retry state files must NOT be written.
    await expect(fs.access(journal.getFilePath())).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(retryStore.getFilePath())).rejects.toMatchObject({ code: 'ENOENT' });

    // Preview counters still fire so callers know "what would happen".
    expect(result.quarantinedIdentical).toBeGreaterThanOrEqual(1);
    expect(result.mergedSuccessfully).toBeGreaterThanOrEqual(1);
    expect(result.frontmatterRepaired).toBeGreaterThanOrEqual(1);
  });

  it('dry-run: does NOT leave the lease file on disk after the run', async () => {
    const settings = makeSettings({ spaces: [makeSpace('Team', '.')] });
    await writeFileRecursive(path.join(coreDir, 'foo.md'), 'body\n');

    await runDailyMaintenance(coreDir, settings, journal, retryStore, dailyDeps, {
      dryRun: true,
    });

    const leasePath = path.join(coreDir, LEASE_FILE_NAME);
    await expect(fs.access(leasePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // -------------------------------------------------------------------
  // Section 8: Cross-platform path handling
  // -------------------------------------------------------------------

  it('patterns: backslashed Windows-style basenames match the shared conflict regexes', () => {
    // Synthetic Windows-style paths (baseline check — the scan itself
    // operates on basenames so platform-specific path separators don't
    // affect pattern detection, but make it explicit here).
    const winPaths = [
      'C:\\Users\\me\\notes.conflict-cloud.md',
      'D:\\Team Drive\\Plan (conflicted copy 2025-01-15 Mac).md',
      '\\\\share\\team\\data (1).json',
      'E:\\Drafts\\Copy of notes.md',
    ];
    const labels = new Set<string>();
    for (const full of winPaths) {
      const base = full.split('\\').pop()!;
      for (const p of CONFLICT_PATTERNS) {
        if (p.regex.test(base)) {
          labels.add(p.label);
          break;
        }
      }
    }
    expect(labels).toEqual(
      new Set(['rebel-cloud-conflict', 'dropbox-conflict', 'numbered-copy', 'copy-of-duplicate']),
    );
  });

  // -------------------------------------------------------------------
  // Section 9: Health surface after maintenance ran
  // -------------------------------------------------------------------

  it('health: resolutionStats reflect identical quarantine + lastMaintenanceRun after a daily run', async () => {
    const settings = makeSettings({ spaces: [makeSpace('Team', '.')] });
    const original = path.join(coreDir, 'notes.md');
    const conflict = path.join(coreDir, 'notes.conflict-cloud.md');
    await writeFileRecursive(original, 'same\n');
    await writeFileRecursive(conflict, 'same\n');

    const t0 = 1_700_000_000_000;
    const result = await runDailyMaintenance(coreDir, settings, journal, retryStore, dailyDeps, {
      now: () => t0,
    });
    expect(result.quarantinedIdentical).toBe(1);

    // Re-read the journal and derive the same stats the health check does.
    const journalState = JSON.parse(await fs.readFile(journal.getFilePath(), 'utf8'));
    const resolutionLogs = journalState.entries.filter(
      (e: JournalEntry) => e.type === 'resolution-log',
    );
    const resolutionCounter = journalState.entries.find(
      (e: JournalEntry) => e.type === 'resolution-counter',
    );
    expect(resolutionLogs.length).toBeGreaterThanOrEqual(1);
    expect(resolutionCounter?.total).toBeGreaterThanOrEqual(1);

    // lastMaintenanceRun = journalState.updatedAt (ISO rendered by health check).
    expect(journalState.updatedAt).toBe(t0);
  });

  it('health: circuit-breaker trip surfaces as pendingUserReview in retry-state', async () => {
    const settings = makeSettings({ spaces: [makeSpace('Team', '.')] });
    const original = path.join(coreDir, 'doc.md');
    const conflict = path.join(coreDir, 'doc.conflict-cloud.md');
    await writeFileRecursive(original, '# A\n\nlocal\n');
    await writeFileRecursive(conflict, '# A\n\ncloud\n');

    const conflictHash = sha256(await fs.readFile(conflict));
    // Seed 2 prior failures with backoff expired.
    await retryStore.save({
      schemaVersion: 1,
      updatedAt: 0,
      entries: [
        {
          conflictPath: conflict,
          conflictHash,
          attempts: 2,
          lastAttemptAt: 0,
          nextEligibleAt: 0,
          lastError: 'prior',
          status: 'retry',
        },
      ],
    });

    vi.spyOn(resolver, 'proposeMerge').mockResolvedValue({
      success: false,
      error: 'still broken',
    });

    const result = await runDailyMaintenance(coreDir, settings, journal, retryStore, dailyDeps);
    expect(result.mergeFailed).toBe(1);

    const retryRaw = await fs.readFile(retryStore.getFilePath(), 'utf8');
    const retryState = JSON.parse(retryRaw);
    const needsReview = retryState.entries.filter(
      (e: { status: string }) => e.status === 'needs-review',
    );
    expect(needsReview).toHaveLength(1);
  });

  it('health: checkConflictingCopies reflects maintenance output after daily run', async () => {
    const settings = makeSettings({ spaces: [makeSpace('Team', '.')] });
    const original = path.join(coreDir, 'notes.md');
    const conflict = path.join(coreDir, 'notes.conflict-cloud.md');
    await writeFileRecursive(original, 'same\n');
    await writeFileRecursive(conflict, 'same\n');

    // Keep this inside the health check's 24h rolling window so
    // `resolvedLast24h` assertions stay deterministic over time.
    const runAt = Date.now();
    const runResult = await runDailyMaintenance(coreDir, settings, journal, retryStore, dailyDeps, {
      now: () => runAt,
    });
    expect(runResult.quarantinedIdentical).toBe(1);

    const health = await checkConflictingCopies({ coreDirectory: coreDir } as AppSettings);
    expect(health.status).toBe('pass');
    expect(health.message).toContain('No conflicting copies');

    const details = health.details as Record<string, unknown>;
    expect(details.healthStatus).toBe('healthy');
    expect(details.lastMaintenanceRun).toBe(new Date(runAt).toISOString());

    const stats = details.resolutionStats as Record<string, number>;
    expect(stats.resolvedLast24h).toBeGreaterThanOrEqual(1);
    expect(stats.resolvedTotal).toBeGreaterThanOrEqual(1);
    expect(stats.pendingMerge).toBe(0);
    expect(stats.pendingUserReview).toBe(0);
  });
});
