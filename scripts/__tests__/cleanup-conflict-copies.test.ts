/**
 * Tests for the standalone rebel-system conflict-copy cleanup script.
 *
 *   1. Planner behavior tests — mirror src/core/services/__tests__/conflictCopyCleanup.test.ts,
 *      run against the VENDORED port in rebel-system/scripts/cleanup-conflict-copies.ts.
 *   2. --apply integration test — real temp dir; byte-identical moved, originals/differing
 *      untouched, no-overwrite collision suffix, manifest written.
 *   3. Parity guard — imports the canonical @shared/conflictPatterns AND the vendored copy
 *      and asserts pattern sources/labels/providers match, so drift fails CI.
 *
 * Lives in the superproject scripts/__tests__/ (registered in vitest.config.ts desktop
 * project) so it can import BOTH the superproject @shared module and the rebel-system
 * script via relative path.
 */
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CONFLICT_PATTERNS as CANONICAL_PATTERNS,
  WORKSPACE_CONFLICT_MARKER as CANONICAL_MARKER,
} from '@shared/conflictPatterns';

import {
  CONFLICT_PATTERNS as VENDORED_PATTERNS,
  WORKSPACE_CONFLICT_MARKER as VENDORED_MARKER,
  AUTO_ELIGIBLE_LABELS,
  applyQuarantine,
  buildSnapshot,
  dateStamp,
  deriveImmediateParentRelPath,
  planConflictCopyCleanup,
  reserveNonCollidingDest,
  run,
  type CleanupPlan,
  type ConflictSnapshotEntry,
  type QuarantineCandidate,
} from '../../rebel-system/scripts/cleanup-conflict-copies';

function entry(relPath: string, hash: string | null, size = 10): ConflictSnapshotEntry {
  return { relPath, hash, size };
}

function plan(snapshot: readonly ConflictSnapshotEntry[]): CleanupPlan {
  return planConflictCopyCleanup(snapshot);
}

// ---------------------------------------------------------------------------
// 1. Planner behavior — mirrors the engine test cases
// ---------------------------------------------------------------------------

describe('cleanup-conflict-copies planner (vendored port)', () => {
  it('quarantines numbered-copy files identical to parent and reviews differing copies', () => {
    expect(
      plan([
        entry('notes.md', 'hash-a'),
        entry('notes (1).md', 'hash-a'),
        entry('todo.md', 'hash-b'),
        entry('todo (1).md', 'hash-c'),
      ]),
    ).toEqual({
      toQuarantine: [
        {
          relPath: 'notes (1).md',
          immediateParentRelPath: 'notes.md',
          label: 'numbered-copy',
          provider: 'google-drive',
          hash: 'hash-a',
        },
      ],
      needsReview: [
        {
          relPath: 'todo (1).md',
          label: 'numbered-copy',
          provider: 'google-drive',
          immediateParentRelPath: 'todo.md',
          reason: 'differing-from-parent',
        },
      ],
    });
  });

  it('peels only one suffix for nested numbered copies', () => {
    expect(
      plan([
        entry('foo.md', 'base'),
        entry('foo (1).md', 'nested-parent'),
        entry('foo (1) (1).md', 'nested-parent'),
      ]),
    ).toEqual({
      toQuarantine: [
        {
          relPath: 'foo (1) (1).md',
          immediateParentRelPath: 'foo (1).md',
          label: 'numbered-copy',
          provider: 'google-drive',
          hash: 'nested-parent',
        },
      ],
      needsReview: [
        {
          relPath: 'foo (1).md',
          label: 'numbered-copy',
          provider: 'google-drive',
          immediateParentRelPath: 'foo.md',
          reason: 'differing-from-parent',
        },
      ],
    });
  });

  it('keeps DA D1 copy-suffix parents in review and only quarantines their numbered children', () => {
    expect(
      plan([
        entry('budget.md', 'same'),
        entry('budget copy.md', 'same'),
        entry('budget copy (1).md', 'same'),
      ]),
    ).toEqual({
      toQuarantine: [
        {
          relPath: 'budget copy (1).md',
          immediateParentRelPath: 'budget copy.md',
          label: 'numbered-copy',
          provider: 'google-drive',
          hash: 'same',
        },
      ],
      needsReview: [
        {
          relPath: 'budget copy.md',
          label: 'copy-suffix-duplicate',
          provider: 'generic',
          immediateParentRelPath: 'budget.md',
          reason: 'detect-only-label',
        },
      ],
    });
  });

  it('always sends copy-of and copy-suffix labels to review', () => {
    expect(
      plan([
        entry('notes.md', 'same'),
        entry('Copy of notes.md', 'same'),
        entry('notes copy.md', 'same'),
      ]),
    ).toEqual({
      toQuarantine: [],
      needsReview: [
        {
          relPath: 'Copy of notes.md',
          label: 'copy-of-duplicate',
          provider: 'generic',
          immediateParentRelPath: 'notes.md',
          reason: 'detect-only-label',
        },
        {
          relPath: 'notes copy.md',
          label: 'copy-suffix-duplicate',
          provider: 'generic',
          immediateParentRelPath: 'notes.md',
          reason: 'detect-only-label',
        },
      ],
    });
  });

  it('reviews empty, unreadable, and empty-parent cases with explicit reasons', () => {
    expect(
      plan([
        entry('empty.md', 'parent'),
        entry('empty (1).md', 'child', 0),
        entry('unreadable.md', 'parent'),
        entry('unreadable (1).md', null),
        entry('parent-empty.md', 'parent', 0),
        entry('parent-empty (1).md', 'child'),
      ]),
    ).toEqual({
      toQuarantine: [],
      needsReview: [
        {
          relPath: 'empty (1).md',
          label: 'numbered-copy',
          provider: 'google-drive',
          immediateParentRelPath: 'empty.md',
          reason: 'empty-or-placeholder',
        },
        {
          relPath: 'parent-empty (1).md',
          label: 'numbered-copy',
          provider: 'google-drive',
          immediateParentRelPath: 'parent-empty.md',
          reason: 'parent-empty-or-unreadable',
        },
        {
          relPath: 'unreadable (1).md',
          label: 'numbered-copy',
          provider: 'google-drive',
          immediateParentRelPath: 'unreadable.md',
          reason: 'empty-or-placeholder',
        },
      ],
    });
  });

  it('reviews conflicts whose immediate parent is missing', () => {
    expect(plan([entry('missing-parent (1).md', 'hash')])).toEqual({
      toQuarantine: [],
      needsReview: [
        {
          relPath: 'missing-parent (1).md',
          label: 'numbered-copy',
          provider: 'google-drive',
          immediateParentRelPath: 'missing-parent.md',
          reason: 'parent-missing',
        },
      ],
    });
  });

  it('quarantines identical Dropbox and generic sync conflict files', () => {
    expect(
      plan([
        entry('docs/report.md', 'same'),
        entry('docs/report (conflicted copy 2026-06-01).md', 'same'),
        entry('data/state.json', 'same-json'),
        entry('data/state-conflict-202606010001.json', 'same-json'),
      ]),
    ).toEqual({
      toQuarantine: [
        {
          relPath: 'data/state-conflict-202606010001.json',
          immediateParentRelPath: 'data/state.json',
          label: 'sync-conflict',
          provider: 'generic',
          hash: 'same-json',
        },
        {
          relPath: 'docs/report (conflicted copy 2026-06-01).md',
          immediateParentRelPath: 'docs/report.md',
          label: 'dropbox-conflict',
          provider: 'dropbox',
          hash: 'same',
        },
      ],
      needsReview: [],
    });
  });

  it('is independent of snapshot ordering', () => {
    const snapshot = [
      entry('b.md', 'b'),
      entry('b (1).md', 'different'),
      entry('a.md', 'a'),
      entry('a (1).md', 'a'),
      entry('Copy of c.md', 'c'),
      entry('c.md', 'c'),
    ];
    const shuffled = [snapshot[4], snapshot[1], snapshot[3], snapshot[0], snapshot[5], snapshot[2]];
    expect(plan(shuffled)).toEqual(plan(snapshot));
  });

  it('ignores multi-dot numbered-looking names that do not match the numbered-copy pattern', () => {
    expect(deriveImmediateParentRelPath('data (2).tar.gz')).toBeNull();
    expect(plan([entry('data.tar.gz', 'same'), entry('data (2).tar.gz', 'same')])).toEqual({
      toQuarantine: [],
      needsReview: [],
    });
  });
});

// ---------------------------------------------------------------------------
// 2. --apply integration on a real temp dir
// ---------------------------------------------------------------------------

describe('cleanup-conflict-copies buildSnapshot + applyQuarantine (real FS)', () => {
  function makeStorm(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'ccc-apply-'));
    writeFileSync(path.join(root, 'notes.md'), 'IDENTICAL BODY');
    writeFileSync(path.join(root, 'notes (1).md'), 'IDENTICAL BODY'); // byte-identical → quarantine
    writeFileSync(path.join(root, 'todo.md'), 'ORIGINAL');
    writeFileSync(path.join(root, 'todo (1).md'), 'DIFFERENT'); // differing → review, stays
    writeFileSync(path.join(root, 'empty.md'), 'PARENT');
    writeFileSync(path.join(root, 'empty (1).md'), ''); // empty → review, stays
    writeFileSync(path.join(root, 'Report (1).md'), 'STANDALONE'); // legit, no parent → review, stays
    writeFileSync(path.join(root, 'doc.md'), 'C');
    writeFileSync(path.join(root, 'Copy of doc.md'), 'C'); // copy-of (human) → review, stays
    return root;
  }

  it('moves byte-identical copies to quarantine, leaves originals/differing/empty/standalone in place', () => {
    const root = makeStorm();
    const snapshot = buildSnapshot(root);
    const result = planConflictCopyCleanup(snapshot);

    expect(result.toQuarantine.map((c) => c.relPath)).toEqual(['notes (1).md']);

    const applyResult = applyQuarantine(root, result.toQuarantine);
    expect(applyResult.moved).toBe(1);
    expect(applyResult.skipped).toBe(0);

    // Moved file gone from origin, present in quarantine.
    expect(existsSync(path.join(root, 'notes (1).md'))).toBe(false);
    const stamp = dateStamp();
    const quarantineDir = path.join(root, '.rebel', 'conflicts-cleanup', stamp);
    expect(existsSync(path.join(quarantineDir, 'notes (1).md'))).toBe(true);

    // Everything else untouched.
    for (const survivor of [
      'notes.md',
      'todo.md',
      'todo (1).md',
      'empty.md',
      'empty (1).md',
      'Report (1).md',
      'doc.md',
      'Copy of doc.md',
    ]) {
      expect(existsSync(path.join(root, survivor))).toBe(true);
    }

    // Manifest written with a 'moved' record.
    expect(applyResult.manifestPath).not.toBeNull();
    const manifestLines = readFileSync(applyResult.manifestPath!, 'utf8').trim().split('\n');
    const records = manifestLines.map((l) => JSON.parse(l));
    const movedRecord = records.find((r) => r.relPath === 'notes (1).md');
    expect(movedRecord.action).toBe('moved');
    expect(movedRecord.label).toBe('numbered-copy');
    expect(movedRecord.destRelPath).toContain('conflicts-cleanup');
  });

  it('never overwrites — adds a (n) suffix on quarantine collision', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ccc-collide-'));
    const stamp = dateStamp();
    const quarantineDir = path.join(root, '.rebel', 'conflicts-cleanup', stamp);
    mkdirSync(quarantineDir, { recursive: true });
    // Pre-existing file at the would-be destination.
    writeFileSync(path.join(quarantineDir, 'notes (1).md'), 'PRE-EXISTING DO NOT CLOBBER');

    writeFileSync(path.join(root, 'notes.md'), 'BODY');
    writeFileSync(path.join(root, 'notes (1).md'), 'BODY');

    const candidate: QuarantineCandidate = {
      relPath: 'notes (1).md',
      immediateParentRelPath: 'notes.md',
      label: 'numbered-copy',
      provider: 'google-drive',
      hash: planConflictCopyCleanup(buildSnapshot(root)).toQuarantine[0].hash,
    };
    const applyResult = applyQuarantine(root, [candidate]);

    expect(applyResult.moved).toBe(1);
    // Original pre-existing quarantine file preserved.
    expect(readFileSync(path.join(quarantineDir, 'notes (1).md'), 'utf8')).toBe(
      'PRE-EXISTING DO NOT CLOBBER',
    );
    // Moved file landed under a collision-suffixed name.
    expect(existsSync(path.join(quarantineDir, 'notes (1) (1).md'))).toBe(true);
    expect(readFileSync(path.join(quarantineDir, 'notes (1) (1).md'), 'utf8')).toBe('BODY');
  });

  it('skips (does not move) a file that changed since the snapshot — rehash guard', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ccc-rehash-'));
    writeFileSync(path.join(root, 'notes.md'), 'BODY');
    writeFileSync(path.join(root, 'notes (1).md'), 'BODY');
    const candidate: QuarantineCandidate = {
      relPath: 'notes (1).md',
      immediateParentRelPath: 'notes.md',
      label: 'numbered-copy',
      provider: 'google-drive',
      hash: 'STALE-HASH-THAT-WONT-MATCH',
    };
    const applyResult = applyQuarantine(root, [candidate]);
    expect(applyResult.moved).toBe(0);
    expect(applyResult.skipped).toBe(1);
    // File left in place.
    expect(existsSync(path.join(root, 'notes (1).md'))).toBe(true);
    const records = readFileSync(applyResult.manifestPath!, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(records[0].action).toBe('skipped-rehash-changed');
  });

  it('does not descend into dot-dirs (incl. the quarantine) when building the snapshot', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ccc-skip-'));
    writeFileSync(path.join(root, 'real.md'), 'X');
    mkdirSync(path.join(root, '.rebel', 'conflicts-cleanup', '2026-01-01'), { recursive: true });
    writeFileSync(path.join(root, '.rebel', 'conflicts-cleanup', '2026-01-01', 'old (1).md'), 'X');
    mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    writeFileSync(path.join(root, 'node_modules', 'pkg (1).md'), 'X');

    const snapshot = buildSnapshot(root);
    expect(snapshot.map((e) => e.relPath).sort()).toEqual(['real.md']);
  });
});

// ---------------------------------------------------------------------------
// 3. Parity guard — vendored copy must match canonical @shared/conflictPatterns
// ---------------------------------------------------------------------------

describe('cleanup-conflict-copies vendored-pattern parity with @shared/conflictPatterns', () => {
  it('matches WORKSPACE_CONFLICT_MARKER', () => {
    expect(VENDORED_MARKER).toBe(CANONICAL_MARKER);
  });

  it('matches CONFLICT_PATTERNS count, regex sources/flags, labels, and providers', () => {
    expect(VENDORED_PATTERNS.length).toBe(CANONICAL_PATTERNS.length);
    const serialize = (p: { regex: RegExp; label: string; provider: string }) => ({
      source: p.regex.source,
      flags: p.regex.flags,
      label: p.label,
      provider: p.provider,
    });
    expect(VENDORED_PATTERNS.map(serialize)).toEqual(CANONICAL_PATTERNS.map(serialize));
  });

  it('keeps AUTO_ELIGIBLE_LABELS to the machine-generated set only', () => {
    expect([...AUTO_ELIGIBLE_LABELS].sort()).toEqual(
      ['dropbox-conflict', 'numbered-copy', 'sync-conflict'].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Safety probes (review fixes F1/F2/F3)
// ---------------------------------------------------------------------------

describe('cleanup-conflict-copies safety probes', () => {
  // Some tests chmod a dir read-only; restore it so the OS temp cleaner can rm it.
  const toRestore: string[] = [];
  afterEach(() => {
    while (toRestore.length > 0) {
      const dir = toRestore.pop()!;
      try {
        chmodSync(dir, 0o755);
      } catch {
        /* best-effort */
      }
    }
  });

  // F1 — refuse a non-writable target under --apply.
  it('F1: --apply on a read-only directory errors clearly and moves nothing', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ccc-ro-'));
    writeFileSync(path.join(root, 'notes.md'), 'BODY');
    writeFileSync(path.join(root, 'notes (1).md'), 'BODY'); // would be a quarantine candidate

    chmodSync(root, 0o555); // read + execute, no write
    toRestore.push(root);

    expect(() => run(root, { apply: true })).toThrow(/not writable/i);

    // Nothing was created or moved.
    expect(existsSync(path.join(root, '.rebel'))).toBe(false);
    expect(existsSync(path.join(root, 'notes (1).md'))).toBe(true);
  });

  it('F1: dry-run does NOT require write access (read-only dir still previews)', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ccc-ro-dry-'));
    writeFileSync(path.join(root, 'notes.md'), 'BODY');
    writeFileSync(path.join(root, 'notes (1).md'), 'BODY');

    chmodSync(root, 0o555);
    toRestore.push(root);

    const result = run(root, { apply: false });
    expect(result.plan.toQuarantine.map((c) => c.relPath)).toEqual(['notes (1).md']);
    expect(result.apply).toBeUndefined();
    expect(existsSync(path.join(root, '.rebel'))).toBe(false);
  });

  // F2 — atomic no-overwrite: a colliding dest created after planning, before move.
  it('F2: does NOT overwrite a dest created between planning and move (picks next suffix)', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ccc-toctou-'));
    writeFileSync(path.join(root, 'notes.md'), 'BODY');
    writeFileSync(path.join(root, 'notes (1).md'), 'BODY');

    const snapshot = buildSnapshot(root);
    const planned = planConflictCopyCleanup(snapshot);
    expect(planned.toQuarantine.map((c) => c.relPath)).toEqual(['notes (1).md']);

    // Simulate a racing creator: the quarantine dest exists by apply time.
    const stamp = dateStamp();
    const quarantineDir = path.join(root, '.rebel', 'conflicts-cleanup', stamp);
    mkdirSync(quarantineDir, { recursive: true });
    writeFileSync(path.join(quarantineDir, 'notes (1).md'), 'RACED-IN DO NOT CLOBBER');

    const applyResult = applyQuarantine(root, planned.toQuarantine);
    expect(applyResult.moved).toBe(1);

    // Pre-existing (raced-in) file is intact — NOT overwritten.
    expect(readFileSync(path.join(quarantineDir, 'notes (1).md'), 'utf8')).toBe(
      'RACED-IN DO NOT CLOBBER',
    );
    // Our move landed under the next free suffix.
    expect(readFileSync(path.join(quarantineDir, 'notes (1) (1).md'), 'utf8')).toBe('BODY');
  });

  it('F2: reserveNonCollidingDest claims atomically and never returns a pre-existing path', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ccc-reserve-'));
    const base = path.join(root, 'x.md');
    writeFileSync(base, 'PRE'); // occupied

    const reserved = reserveNonCollidingDest(base);
    // Did not return the occupied path; reserved an exclusive new placeholder.
    expect(reserved).not.toBe(base);
    expect(existsSync(reserved)).toBe(true);
    expect(readFileSync(base, 'utf8')).toBe('PRE'); // original untouched

    // A second reservation must pick a DIFFERENT path (the first is now claimed).
    const reserved2 = reserveNonCollidingDest(base);
    expect(reserved2).not.toBe(reserved);
    expect(reserved2).not.toBe(base);
  });

  // F3a — dry-run leaves the filesystem untouched (no .rebel dir, no manifest).
  it('F3a: dry-run creates NO .rebel dir and NO manifest', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ccc-dry-'));
    writeFileSync(path.join(root, 'notes.md'), 'BODY');
    writeFileSync(path.join(root, 'notes (1).md'), 'BODY');

    const before = readdirSync(root).sort();
    const result = run(root, { apply: false });

    expect(result.plan.toQuarantine.map((c) => c.relPath)).toEqual(['notes (1).md']);
    expect(result.apply).toBeUndefined();
    // Filesystem untouched: same entries, no .rebel.
    expect(readdirSync(root).sort()).toEqual(before);
    expect(existsSync(path.join(root, '.rebel'))).toBe(false);
  });

  // F3b — symlinked file and symlinked directory are skipped (no escape).
  it('F3b: symlinked file and symlinked directory inside the target are skipped', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'ccc-outside-'));
    writeFileSync(path.join(outside, 'secret.md'), 'OUTSIDE');
    writeFileSync(path.join(outside, 'secret (1).md'), 'OUTSIDE');
    mkdirSync(path.join(outside, 'subdir'));
    writeFileSync(path.join(outside, 'subdir', 'deep.md'), 'OUTSIDE');

    const root = mkdtempSync(path.join(tmpdir(), 'ccc-symlink-'));
    writeFileSync(path.join(root, 'real.md'), 'X');
    // A symlinked FILE that matches a conflict pattern.
    symlinkSync(path.join(outside, 'secret (1).md'), path.join(root, 'linked (1).md'));
    // A symlinked DIRECTORY pointing outside the tree.
    symlinkSync(path.join(outside, 'subdir'), path.join(root, 'linkdir'));

    const snapshot = buildSnapshot(root);
    // Only the real file is snapshotted; no symlink target was followed.
    expect(snapshot.map((e) => e.relPath).sort()).toEqual(['real.md']);
  });

  // F3c — a large same-dir storm is handled without error and counts correctly.
  it('F3c: handles a 1,200+ file same-dir storm and plans the right count', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ccc-storm-'));
    const N = 1300;
    for (let i = 0; i < N; i++) {
      writeFileSync(path.join(root, `f${i}.md`), `BODY-${i}`);
      writeFileSync(path.join(root, `f${i} (1).md`), `BODY-${i}`); // byte-identical numbered copy
    }

    const snapshot = buildSnapshot(root);
    expect(snapshot.length).toBe(N * 2);

    const planned = planConflictCopyCleanup(snapshot);
    expect(planned.toQuarantine.length).toBe(N);
    expect(planned.needsReview.length).toBe(0);
  });
});
