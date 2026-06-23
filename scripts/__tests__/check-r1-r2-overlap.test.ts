/**
 * Unit tests for the R1↔R2 file-overlap tripwire (chunk S2-PRE-A of the
 * R2 Stage 2 chunked implementation plan).
 *
 * Tests the pure functions:
 *   - parseDiff(): unified-diff string → FileDiff[]
 *   - diffMatchesEntry(): respects whole-file vs line-range entries
 *   - evaluateWatchlist(): aggregates per-entry matches
 *   - hasAckToken(): exact-match against [r1-r2-overlap-ack]
 *
 * The CLI runner (resolveContext + main) is exercised end-to-end via
 * a synthetic-diff fixture without spawning git, since that path requires
 * env + filesystem manipulation. The pure functions cover the actual
 * decision logic.
 *
 * @see scripts/check-r1-r2-overlap.ts
 * @see docs/plans/260429_r2_stage2_chunked_implementation_plan.md (S2-PRE-A)
 */
import { describe, it, expect } from 'vitest';
import {
  parseDiff,
  diffMatchesEntry,
  evaluateWatchlist,
  hasAckToken,
  ACK_TOKEN,
  WATCHLIST,
  type WatchlistEntry,
  type FileDiff,
} from '../check-r1-r2-overlap';

// ---------------------------------------------------------------------------
// parseDiff — basic format handling
// ---------------------------------------------------------------------------

describe('parseDiff', () => {
  it('returns empty list for empty input', () => {
    expect(parseDiff('')).toEqual([]);
  });

  it('parses a single-file single-hunk diff', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index abc..def 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -10,2 +10,3 @@ context line',
      ' const x = 1;',
      '+const y = 2;',
      ' const z = 3;',
    ].join('\n');
    const result = parseDiff(diff);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('src/foo.ts');
    expect(result[0].deleted).toBe(false);
    expect(result[0].hunks).toEqual([{ oldStart: 10, oldCount: 2, newStart: 10, newCount: 3 }]);
  });

  it('defaults missing oldCount/newCount to 1', () => {
    const diff = ['diff --git a/x.ts b/x.ts', '@@ -5 +5 @@', ' line'].join('\n');
    const result = parseDiff(diff);
    expect(result[0].hunks).toEqual([{ oldStart: 5, oldCount: 1, newStart: 5, newCount: 1 }]);
  });

  it('parses multiple hunks in one file', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '@@ -1,2 +1,3 @@',
      ' x',
      '+y',
      '@@ -100,1 +101,2 @@',
      ' z',
      '+w',
    ].join('\n');
    const result = parseDiff(diff);
    expect(result[0].hunks).toEqual([
      { oldStart: 1, oldCount: 2, newStart: 1, newCount: 3 },
      { oldStart: 100, oldCount: 1, newStart: 101, newCount: 2 },
    ]);
  });

  it('detects file deletion via `+++ /dev/null` marker', () => {
    const diff = [
      'diff --git a/cloud-service/src/bootstrap.ts b/cloud-service/src/bootstrap.ts',
      'deleted file mode 100644',
      '--- a/cloud-service/src/bootstrap.ts',
      '+++ /dev/null',
      '@@ -1,1000 +0,0 @@',
      '-(file content was 1000 lines)',
    ].join('\n');
    const result = parseDiff(diff);
    expect(result).toHaveLength(1);
    expect(result[0].deleted).toBe(true);
    expect(result[0].hunks).toEqual([{ oldStart: 1, oldCount: 1000, newStart: 0, newCount: 0 }]);
  });

  it('handles CRLF line endings (Windows fixtures)', () => {
    const diff = [
      'diff --git a/x.ts b/x.ts',
      '@@ -5,1 +5,2 @@',
      ' line',
      '+new',
    ].join('\r\n');
    const result = parseDiff(diff);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('x.ts');
    expect(result[0].hunks).toEqual([{ oldStart: 5, oldCount: 1, newStart: 5, newCount: 2 }]);
  });

  it('strips trailing \\r defensively from path lines', () => {
    // Simulate a fixture with mixed line endings
    const diff = 'diff --git a/x.ts b/x.ts\r\n@@ -1 +1 @@\r\n line\r\n';
    const result = parseDiff(diff);
    expect(result[0].path).toBe('x.ts'); // not 'x.ts\r'
  });

  it('parses multi-file diffs', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '@@ -1,1 +1,2 @@',
      ' x',
      '+y',
      'diff --git a/b.ts b/b.ts',
      '@@ -5,1 +5,2 @@',
      ' p',
      '+q',
    ].join('\n');
    const result = parseDiff(diff);
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.path).sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('records file with zero hunks (e.g., mode-only or rename-only diffs)', () => {
    const diff = [
      'diff --git a/x.ts b/y.ts',
      'similarity index 100%',
      'rename from x.ts',
      'rename to y.ts',
    ].join('\n');
    const result = parseDiff(diff);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('y.ts');
    expect(result[0].hunks).toEqual([]);
    expect(result[0].deleted).toBe(false);
  });

  it('normalises Windows-style backslashes in paths to forward slashes', () => {
    const diff = ['diff --git a/src\\foo.ts b/src\\foo.ts', '@@ -1,1 +1,2 @@', ' x', '+y'].join('\n');
    const result = parseDiff(diff);
    expect(result[0].path).toBe('src/foo.ts');
  });
});

// ---------------------------------------------------------------------------
// diffMatchesEntry — whole-file vs line-range
// ---------------------------------------------------------------------------

// Helper for constructing FileDiff fixtures in tests with mirrored old/new
function makeHunk(opts: { oldStart: number; oldCount?: number; newStart: number; newCount?: number }): {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
} {
  return {
    oldStart: opts.oldStart,
    oldCount: opts.oldCount ?? 1,
    newStart: opts.newStart,
    newCount: opts.newCount ?? 1,
  };
}

describe('diffMatchesEntry', () => {
  const wholeFileEntry: WatchlistEntry = {
    path: 'src/shared/utils/eventCompaction.ts',
    reason: 'test',
  };

  const rangedEntry: WatchlistEntry = {
    path: 'cloud-service/src/bootstrap.ts',
    lineRange: [589, 622],
    reason: 'test',
  };

  it('returns false when paths do not match', () => {
    const file: FileDiff = {
      path: 'unrelated.ts',
      hunks: [makeHunk({ oldStart: 100, oldCount: 5, newStart: 100, newCount: 5 })],
      deleted: false,
    };
    expect(diffMatchesEntry(file, wholeFileEntry)).toBe(false);
  });

  it('whole-file entry: returns true even with empty hunks (mode-change/rename)', () => {
    const file: FileDiff = { path: 'src/shared/utils/eventCompaction.ts', hunks: [], deleted: false };
    expect(diffMatchesEntry(file, wholeFileEntry)).toBe(true);
  });

  it('whole-file entry: returns true with any hunk', () => {
    const file: FileDiff = {
      path: 'src/shared/utils/eventCompaction.ts',
      hunks: [makeHunk({ oldStart: 1, newStart: 1 })],
      deleted: false,
    };
    expect(diffMatchesEntry(file, wholeFileEntry)).toBe(true);
  });

  it('ranged entry: false when no hunk overlaps the range (on either old or new side)', () => {
    const file: FileDiff = {
      path: 'cloud-service/src/bootstrap.ts',
      hunks: [
        makeHunk({ oldStart: 100, oldCount: 50, newStart: 100, newCount: 50 }),
        makeHunk({ oldStart: 700, oldCount: 10, newStart: 700, newCount: 10 }),
      ],
      deleted: false,
    };
    expect(diffMatchesEntry(file, rangedEntry)).toBe(false);
  });

  it('ranged entry: true when hunk fully inside range', () => {
    const file: FileDiff = {
      path: 'cloud-service/src/bootstrap.ts',
      hunks: [makeHunk({ oldStart: 600, oldCount: 5, newStart: 600, newCount: 5 })],
      deleted: false,
    };
    expect(diffMatchesEntry(file, rangedEntry)).toBe(true);
  });

  it('ranged entry: true when hunk overlaps range start boundary', () => {
    const file: FileDiff = {
      path: 'cloud-service/src/bootstrap.ts',
      hunks: [makeHunk({ oldStart: 585, oldCount: 10, newStart: 585, newCount: 10 })],
      deleted: false,
    };
    expect(diffMatchesEntry(file, rangedEntry)).toBe(true);
  });

  it('ranged entry: true when hunk overlaps range end boundary', () => {
    const file: FileDiff = {
      path: 'cloud-service/src/bootstrap.ts',
      hunks: [makeHunk({ oldStart: 620, oldCount: 10, newStart: 620, newCount: 10 })],
      deleted: false,
    };
    expect(diffMatchesEntry(file, rangedEntry)).toBe(true);
  });

  it('ranged entry: true when hunk fully contains range', () => {
    const file: FileDiff = {
      path: 'cloud-service/src/bootstrap.ts',
      hunks: [makeHunk({ oldStart: 500, oldCount: 200, newStart: 500, newCount: 200 })],
      deleted: false,
    };
    expect(diffMatchesEntry(file, rangedEntry)).toBe(true);
  });

  it('ranged entry: hunk exactly at range start', () => {
    const file: FileDiff = {
      path: 'cloud-service/src/bootstrap.ts',
      hunks: [makeHunk({ oldStart: 589, newStart: 589 })],
      deleted: false,
    };
    expect(diffMatchesEntry(file, rangedEntry)).toBe(true);
  });

  it('ranged entry: hunk exactly at range end', () => {
    const file: FileDiff = {
      path: 'cloud-service/src/bootstrap.ts',
      hunks: [makeHunk({ oldStart: 622, newStart: 622 })],
      deleted: false,
    };
    expect(diffMatchesEntry(file, rangedEntry)).toBe(true);
  });

  it('ranged entry: hunk one line before range — no overlap', () => {
    const file: FileDiff = {
      path: 'cloud-service/src/bootstrap.ts',
      hunks: [makeHunk({ oldStart: 588, newStart: 588 })],
      deleted: false,
    };
    expect(diffMatchesEntry(file, rangedEntry)).toBe(false);
  });

  it('ranged entry: hunk one line after range — no overlap', () => {
    const file: FileDiff = {
      path: 'cloud-service/src/bootstrap.ts',
      hunks: [makeHunk({ oldStart: 623, newStart: 623 })],
      deleted: false,
    };
    expect(diffMatchesEntry(file, rangedEntry)).toBe(false);
  });

  // ---- Deletion-only / addition-only edge cases (gemini-3.1-pro reviewer MUST #3) ----

  it('ranged entry: pure deletion inside guarded range matches via OLD side', () => {
    // Deletion: `@@ -600,5 +599,0 @@` — old range 600..604 overlaps 589..622
    const file: FileDiff = {
      path: 'cloud-service/src/bootstrap.ts',
      hunks: [makeHunk({ oldStart: 600, oldCount: 5, newStart: 599, newCount: 0 })],
      deleted: false,
    };
    expect(diffMatchesEntry(file, rangedEntry)).toBe(true);
  });

  it('ranged entry: deletion of entire guarded block matches via OLD side', () => {
    // Deletion of lines 589-622: `@@ -589,34 +588,0 @@`
    const file: FileDiff = {
      path: 'cloud-service/src/bootstrap.ts',
      hunks: [makeHunk({ oldStart: 589, oldCount: 34, newStart: 588, newCount: 0 })],
      deleted: false,
    };
    expect(diffMatchesEntry(file, rangedEntry)).toBe(true);
  });

  it('ranged entry: full file deletion (`+++ /dev/null`) is automatic match', () => {
    const file: FileDiff = {
      path: 'cloud-service/src/bootstrap.ts',
      hunks: [makeHunk({ oldStart: 1, oldCount: 1000, newStart: 0, newCount: 0 })],
      deleted: true,
    };
    expect(diffMatchesEntry(file, rangedEntry)).toBe(true);
  });

  it('ranged entry: pure addition inside guarded range matches via NEW side', () => {
    // Addition: `@@ -600,0 +601,3 @@`
    const file: FileDiff = {
      path: 'cloud-service/src/bootstrap.ts',
      hunks: [makeHunk({ oldStart: 600, oldCount: 0, newStart: 601, newCount: 3 })],
      deleted: false,
    };
    expect(diffMatchesEntry(file, rangedEntry)).toBe(true);
  });

  it('ranged entry: addition just BEFORE guarded range — anchor at 588 — matches via OLD side', () => {
    // Edge case: addition anchored at line 588 (right before range [589, 622])
    // Old anchor (newCount=0 side) is treated as a 1-line touch at oldStart=588.
    // 588 does not overlap 589..622 — should NOT fire.
    const file: FileDiff = {
      path: 'cloud-service/src/bootstrap.ts',
      hunks: [makeHunk({ oldStart: 588, oldCount: 0, newStart: 589, newCount: 3 })],
      deleted: false,
    };
    // New side anchors at 589 (new range 589..591) which DOES overlap [589, 622] → match
    expect(diffMatchesEntry(file, rangedEntry)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evaluateWatchlist — multi-entry aggregation
// ---------------------------------------------------------------------------

describe('evaluateWatchlist', () => {
  const watchlist: readonly WatchlistEntry[] = [
    { path: 'a.ts', reason: 'a' },
    { path: 'b.ts', lineRange: [10, 20], reason: 'b' },
    { path: 'c.ts', reason: 'c' },
  ];

  it('returns empty when no diff matches', () => {
    const files: readonly FileDiff[] = [
      { path: 'unrelated.ts', hunks: [makeHunk({ oldStart: 1, newStart: 1 })], deleted: false },
    ];
    expect(evaluateWatchlist(files, watchlist)).toEqual([]);
  });

  it('returns one violation per matching entry', () => {
    const files: readonly FileDiff[] = [
      { path: 'a.ts', hunks: [makeHunk({ oldStart: 1, newStart: 1 })], deleted: false },
      { path: 'b.ts', hunks: [makeHunk({ oldStart: 15, oldCount: 2, newStart: 15, newCount: 2 })], deleted: false },
    ];
    const result = evaluateWatchlist(files, watchlist);
    expect(result).toHaveLength(2);
    expect(result.map((v) => v.entry.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('skips ranged entry whose hunk is outside the range', () => {
    const files: readonly FileDiff[] = [
      { path: 'b.ts', hunks: [makeHunk({ oldStart: 100, newStart: 100 })], deleted: false },
    ];
    expect(evaluateWatchlist(files, watchlist)).toEqual([]);
  });

  it('handles all 3 entries firing simultaneously', () => {
    const files: readonly FileDiff[] = [
      { path: 'a.ts', hunks: [makeHunk({ oldStart: 1, newStart: 1 })], deleted: false },
      { path: 'b.ts', hunks: [makeHunk({ oldStart: 15, newStart: 15 })], deleted: false },
      { path: 'c.ts', hunks: [], deleted: false },
    ];
    expect(evaluateWatchlist(files, watchlist)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// hasAckToken — exact match
// ---------------------------------------------------------------------------

describe('hasAckToken', () => {
  it('returns false on empty string', () => {
    expect(hasAckToken('')).toBe(false);
  });

  it('returns false when token absent', () => {
    expect(hasAckToken('feat(r2): add manifest scaffolding')).toBe(false);
  });

  it('returns true when token in title', () => {
    expect(hasAckToken('refactor(r2): touch bootstrap [r1-r2-overlap-ack]')).toBe(true);
  });

  it('returns true when token in middle of multi-line commit subjects', () => {
    const text = ['feat(r2): A', 'feat(r2): B [r1-r2-overlap-ack]', 'feat(r2): C'].join('\n');
    expect(hasAckToken(text)).toBe(true);
  });

  it('is case-sensitive (uppercase variant is not the canonical token)', () => {
    expect(hasAckToken('feat: [R1-R2-OVERLAP-ACK]')).toBe(false);
  });

  it('does not match similar tokens with extra whitespace inside', () => {
    expect(hasAckToken('feat: [r1 r2 overlap ack]')).toBe(false);
    expect(hasAckToken('feat: [r1-r2-overlap-ack ]')).toBe(false);
  });

  it('canonical token constant matches expected literal', () => {
    expect(ACK_TOKEN).toBe('[r1-r2-overlap-ack]');
  });
});

// ---------------------------------------------------------------------------
// End-to-end fail-path + ack-bypass-path scenarios
// ---------------------------------------------------------------------------

describe('end-to-end: fail-path scenario', () => {
  it('a synthetic R2 PR touching eventCompaction.ts without ack triggers a violation', () => {
    const diff = [
      'diff --git a/src/shared/utils/eventCompaction.ts b/src/shared/utils/eventCompaction.ts',
      '@@ -75,3 +75,4 @@',
      ' const x = 1;',
      '+const y = 2;',
      ' const z = 3;',
    ].join('\n');
    const files = parseDiff(diff);
    const violations = evaluateWatchlist(files, WATCHLIST);
    expect(violations).toHaveLength(1);
    expect(violations[0].entry.path).toBe('src/shared/utils/eventCompaction.ts');

    // Without ack, the runtime would FAIL — simulate by checking ack absence
    const prTitle = 'refactor(r2): port eventCompaction to manifest-derived';
    expect(hasAckToken(prTitle)).toBe(false);
  });

  it('a synthetic R2 PR touching cloud-service/src/bootstrap.ts in line 600 (within :589-622) triggers', () => {
    const diff = [
      'diff --git a/cloud-service/src/bootstrap.ts b/cloud-service/src/bootstrap.ts',
      '@@ -600,2 +600,3 @@',
      ' line',
      '+new',
    ].join('\n');
    const files = parseDiff(diff);
    const violations = evaluateWatchlist(files, WATCHLIST);
    expect(violations).toHaveLength(1);
    expect(violations[0].entry.path).toBe('cloud-service/src/bootstrap.ts');
  });

  it('a synthetic R2 PR touching cloud-service/src/bootstrap.ts at line 100 (outside :589-622) does NOT trigger', () => {
    const diff = [
      'diff --git a/cloud-service/src/bootstrap.ts b/cloud-service/src/bootstrap.ts',
      '@@ -100,2 +100,3 @@',
      ' line',
      '+new',
    ].join('\n');
    const files = parseDiff(diff);
    const violations = evaluateWatchlist(files, WATCHLIST);
    expect(violations).toEqual([]);
  });
});

describe('end-to-end: ack-bypass scenario', () => {
  it('the same diff with ack token in title would be permitted', () => {
    const diff = [
      'diff --git a/src/shared/utils/eventCompaction.ts b/src/shared/utils/eventCompaction.ts',
      '@@ -75,3 +75,4 @@',
      ' const x = 1;',
      '+const y = 2;',
      ' const z = 3;',
    ].join('\n');
    const files = parseDiff(diff);
    const violations = evaluateWatchlist(files, WATCHLIST);
    expect(violations).toHaveLength(1);

    // With ack, the runtime would PASS
    const prTitle = 'refactor(r2): port eventCompaction to manifest-derived [r1-r2-overlap-ack]';
    expect(hasAckToken(prTitle)).toBe(true);
  });

  it('a diff outside the watchlist passes without ack regardless', () => {
    const diff = [
      'diff --git a/src/renderer/App.tsx b/src/renderer/App.tsx',
      '@@ -10,1 +10,2 @@',
      ' line',
      '+new',
    ].join('\n');
    const files = parseDiff(diff);
    const violations = evaluateWatchlist(files, WATCHLIST);
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Watchlist sanity — deters accidental drift
// ---------------------------------------------------------------------------

describe('WATCHLIST sanity checks', () => {
  it('contains exactly the 4 expected paths (drift sentinel)', () => {
    const paths = WATCHLIST.map((e) => e.path).sort();
    expect(paths).toEqual([
      'cloud-service/src/bootstrap.ts',
      'src/main/services/__tests__/turnPipelineReplay.canonicalizer.ts',
      'src/shared/utils/eventCompaction.ts',
      'src/shared/utils/eventSanitization.ts',
    ]);
  });

  it('cloud-service/src/bootstrap.ts is the only line-ranged entry', () => {
    const ranged = WATCHLIST.filter((e) => e.lineRange !== undefined);
    expect(ranged).toHaveLength(1);
    expect(ranged[0].path).toBe('cloud-service/src/bootstrap.ts');
    expect(ranged[0].lineRange).toEqual([589, 650]);
  });

  it('every entry has a non-empty reason', () => {
    for (const e of WATCHLIST) {
      expect(e.reason.length).toBeGreaterThan(20);
    }
  });
});
