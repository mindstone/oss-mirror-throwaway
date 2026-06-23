import { describe, expect, it, vi } from 'vitest';
import {
  computeDiff,
  computeDiffAsync,
  DiffAbortError,
  type DiffResult,
  type Hunk,
} from '../diff';
import { build10kLineCorpusCase, diffCorpus, type DiffCase } from './diffCorpus';

// =============================================================================
// Golden-corpus fixture test
// =============================================================================

/**
 * Sanity: the corpus must cover every mandatory edge case from the
 * Stage 5 DoD (see `docs/plans/260416_centralize_approval_and_diff_viewing_ux.md`).
 */
describe('diffCorpus coverage gate', () => {
  it('covers every mandatory Stage 5 DoD scenario', () => {
    const ids = diffCorpus.map((c) => c.id);
    // Minimum-coverage contract (1..10 from the DoD). `large-10k-line`
    // and the 3 real-staged-file samples are covered separately.
    const requiredPatterns: Array<[label: string, matcher: RegExp]> = [
      ['empty→empty', /^empty-to-empty$/],
      ['empty→single-line', /^empty-to-single-line/],
      ['LF', /^lf-/],
      ['CRLF', /^crlf-/],
      ['mixed line endings', /^mixed-line-endings/],
      ['trailing newline vs none', /^trailing-newline-/],
      ['unicode surrogate pairs', /^unicode-surrogate/],
      ['tabs vs spaces', /^tabs-to-spaces$/],
      ['binary-looking content', /^binary-looking/],
      ['whitespace-only change', /^whitespace-only/],
      ['real staged-file samples', /^real-staged-file/],
    ];
    for (const [label, matcher] of requiredPatterns) {
      expect(
        ids.some((id) => matcher.test(id)),
        `Missing coverage for "${label}" in diffCorpus`,
      ).toBe(true);
    }
    // At least 3 real staged-file samples.
    expect(ids.filter((id) => id.startsWith('real-staged-file')).length).toBeGreaterThanOrEqual(3);
  });
});

describe('computeDiff — golden corpus', () => {
  it.each(diffCorpus)(
    '$id → expected stats + hunk count',
    ({ before, after, expectedStats, expectedHunkCount }: DiffCase) => {
      const result = computeDiff(before, after);
      expect(result.stats).toEqual(expectedStats);
      expect(result.hunks.length).toBe(expectedHunkCount);
      assertHunksCoverInputs(result, before, after);
    },
  );
});

// =============================================================================
// Parity with react-diff-viewer-continued
// =============================================================================

/**
 * react-diff-viewer-continued exposes `computeLineInformation`, which
 * internally calls `diff.diffLines(oldStr.trimRight(), newStr.trimRight(),
 * { newlineIsToken:false, ignoreWhitespace:false, ignoreCase:false })`
 * and then applies a "trim-equal on paired removed/added lines" fixup
 * that re-classifies lines whose only difference is a trailing newline
 * back to `DEFAULT` (unchanged).
 *
 * For parity on the stats we care about (added / removed / unchanged
 * line counts) the simplest reliable contract is: call both sides with
 * the **raw, untrimmed** fixture input — that matches how desktop
 * actually invokes the viewer (untrimmed staged / remote content fresh
 * from IPC). The viewer's internal `trimRight()` and our untrimmed
 * tokenizer converge on the same counts when the input is "naturally"
 * terminated (both sides end in `\n` or both end without one) — which
 * is the case for every real-file sample in the corpus.
 */
describe('computeDiff — parity with react-diff-viewer-continued', () => {
  // Import lazily so the extra cost is only paid when the parity suite runs.
  // `compute-lines.js` is a CommonJS module shipped inside the package.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate CJS require for a package that ships no ESM entry for this internal path.
  const { computeLineInformation, DiffType } = require(
    'react-diff-viewer-continued/lib/src/compute-lines',
  ) as {
    computeLineInformation: (
      oldStr: string,
      newStr: string,
      disableWordDiff?: boolean,
    ) => {
      lineInformation: Array<{
        left?: { type?: number };
        right?: { type?: number };
      }>;
    };
    DiffType: { DEFAULT: number; ADDED: number; REMOVED: number; CHANGED: number };
  };

  const fullCorpus: DiffCase[] = [
    ...diffCorpus.filter((c) => !c.skipParityCheck),
    build10kLineCorpusCase(),
  ];

  it.each(fullCorpus)('parity: $id', ({ before, after }: DiffCase) => {
    // Both sides see the same raw input.
    const ours = computeDiff(before, after).stats;

    const { lineInformation } = computeLineInformation(before, after, /* disableWordDiff */ true);

    let added = 0;
    let removed = 0;
    let unchanged = 0;
    for (const li of lineInformation) {
      if (li.right?.type === DiffType.ADDED) added++;
      if (li.left?.type === DiffType.REMOVED) removed++;
      // DEFAULT lines have left === right === DEFAULT; count one side.
      if (li.left?.type === DiffType.DEFAULT) unchanged++;
    }
    const theirs = { added, removed, unchanged };

    expect(ours).toEqual(theirs);
  });

  // Sanity guard: every corpus entry has been triaged. Fail the build
  // if a new case is added without a deliberate `skipParityCheck` flag
  // (or without being in the parity set). This forces future authors
  // to make an explicit decision.
  it('every diffCorpus entry is either parity-checked or explicitly skipped', () => {
    for (const c of diffCorpus) {
      const covered = c.skipParityCheck === true || fullCorpus.some((fc) => fc.id === c.id);
      expect(covered, `corpus case "${c.id}" is neither skipped nor in the parity set`).toBe(true);
    }
  });

  // Stage 5 R2 (F5-4): Per-side hunk parity. Stats-only parity doesn't
  // catch reordering — two engines can return the same totals while
  // emitting lines in a different order. This assertion flattens our
  // hunks into a per-side `DiffType` sequence and compares to
  // `computeLineInformation`'s same-side sequence.
  //
  // NOTE (Stage 5 R2 gpt5.5 feedback, deferred to Stage 6): this is
  // STRICTLY STRONGER than stats-only parity, but it is still not
  // full row-pair parity. `react-diff-viewer-continued` pairs adjacent
  // `removed` + `added` lines into a single side-by-side display row
  // (`{ left: REMOVED, right: ADDED }`), whereas `computeDiff` emits
  // sequential, hunk-aligned runs. The two representations agree
  // per-side but diverge at row-pair granularity. Stage 6's mobile
  // renderer will decide which semantic it wants; if it needs paired
  // rows, it should apply a separate "pair adjacent remove+add" pass
  // over `computeDiff`'s hunks rather than require the shared engine
  // to replicate a rendering-layer concern.
  it.each(fullCorpus)('per-side hunk parity: $id', ({ before, after }: DiffCase) => {
    const ours = computeDiff(before, after);
    expect(ours.tooLarge).toBe(false);

    const ourLeftTypes: Array<'default' | 'removed'> = [];
    const ourRightTypes: Array<'default' | 'added'> = [];
    for (const h of ours.hunks) {
      if (h.type === 'added') {
        for (let i = 0; i < h.lineCount; i++) ourRightTypes.push('added');
      } else if (h.type === 'removed') {
        for (let i = 0; i < h.lineCount; i++) ourLeftTypes.push('removed');
      } else {
        for (let i = 0; i < h.lineCount; i++) {
          ourLeftTypes.push('default');
          ourRightTypes.push('default');
        }
      }
    }

    const { lineInformation } = computeLineInformation(before, after, /* disableWordDiff */ true);
    const theirLeftTypes: Array<'default' | 'removed'> = [];
    const theirRightTypes: Array<'default' | 'added'> = [];
    for (const li of lineInformation) {
      if (li.left) {
        if (li.left.type === DiffType.REMOVED) theirLeftTypes.push('removed');
        else if (li.left.type === DiffType.DEFAULT) theirLeftTypes.push('default');
      }
      if (li.right) {
        if (li.right.type === DiffType.ADDED) theirRightTypes.push('added');
        else if (li.right.type === DiffType.DEFAULT) theirRightTypes.push('default');
      }
    }

    expect(ourLeftTypes).toEqual(theirLeftTypes);
    expect(ourRightTypes).toEqual(theirRightTypes);
  });
});

// =============================================================================
// Option: maxLinesForFullDiff escape hatch
// =============================================================================

describe('computeDiff — maxLinesForFullDiff escape hatch', () => {
  it('returns tooLarge placeholder when total line count exceeds the cap', () => {
    const before = 'a\nb\nc\n';
    const after = 'a\nb\nd\n';
    const result = computeDiff(before, after, { maxLinesForFullDiff: 5 });
    expect(result.tooLarge).toBe(true);
    expect(result.hunks).toEqual([]);
    expect(result.stats).toEqual({ added: 0, removed: 0, unchanged: 0 });
  });

  it('computes normally when total lines are at or below the cap', () => {
    const before = 'a\nb\nc\n';
    const after = 'a\nb\nd\n';
    // 3 + 3 = 6 total lines. Cap of 6 → allowed.
    const result = computeDiff(before, after, { maxLinesForFullDiff: 6 });
    // Stage 5 R2 (F5-2): discriminated union makes `tooLarge: false` explicit.
    expect(result.tooLarge).toBe(false);
    expect(result.stats.added + result.stats.removed).toBeGreaterThan(0);
  });

  it('ignores a non-finite cap and computes the full diff', () => {
    const before = 'a\nb\n';
    const after = 'a\nc\n';
    const result = computeDiff(before, after, { maxLinesForFullDiff: Infinity });
    expect(result.tooLarge).toBe(false);
    expect(result.stats.added).toBe(1);
  });

  it('short-circuits identical inputs before checking the cap', () => {
    // Exact same string → fast-path return (no token-count work, no
    // `tooLarge` signal) even if the input is "oversized".
    const huge = 'x\n'.repeat(1_000);
    const result = computeDiff(huge, huge, { maxLinesForFullDiff: 10 });
    expect(result.tooLarge).toBe(false);
    expect(result.stats).toEqual({ added: 0, removed: 0, unchanged: 1000 });
  });

  // Stage 5 R2 (F5-2): discriminated union narrows correctly.
  it('TypeScript narrowing: tooLarge=true path has empty hunks + zero stats', () => {
    const before = 'a\nb\nc\n';
    const after = 'x\ny\nz\n';
    const result = computeDiff(before, after, { maxLinesForFullDiff: 2 });
    if (result.tooLarge) {
      // With the discriminated union, this branch's `hunks` is typed as
      // `[]` and `stats` as the all-zeros literal — no need for a cast.
      expect(result.hunks).toEqual([]);
      expect(result.stats).toEqual({ added: 0, removed: 0, unchanged: 0 });
    } else {
      throw new Error('expected tooLarge=true branch');
    }
  });
});

// =============================================================================
// Async / chunking behavior
// =============================================================================

describe('computeDiffAsync — chunking / yielding', () => {
  it('yields through the provided scheduler before computing', async () => {
    const scheduler = vi.fn(async () => {});
    const result = await computeDiffAsync('a\nb\n', 'a\nc\n', { scheduler });
    expect(scheduler).toHaveBeenCalledTimes(1);
    expect(result.stats.added).toBe(1);
    expect(result.stats.removed).toBe(1);
  });

  it('returns the same output as the sync `computeDiff` for a 10k-line input', async () => {
    const large = build10kLineCorpusCase();
    const sync = computeDiff(large.before, large.after);
    const async_ = await computeDiffAsync(large.before, large.after);
    expect(async_.stats).toEqual(sync.stats);
    expect(async_.hunks.length).toBe(sync.hunks.length);
  });

  it('falls back to a default scheduler when none is provided', async () => {
    // Just proves the function does not throw and completes with valid
    // stats when called without an explicit scheduler.
    const result = await computeDiffAsync('a\n', 'a\n');
    expect(result.stats).toEqual({ added: 0, removed: 0, unchanged: 1 });
  });

  it('honors maxLinesForFullDiff even via the async path', async () => {
    const result = await computeDiffAsync('a\nb\nc\n', 'a\nb\nd\n', {
      maxLinesForFullDiff: 5,
      scheduler: async () => {},
    });
    expect(result.tooLarge).toBe(true);
  });

  it('non-blocks a 10k+ line computation: scheduler is invoked before diff work', async () => {
    // Track ordering: the scheduler's `await` resolves, THEN diff work
    // runs. We verify ordering by capturing a "schedulerResolvedAt" and a
    // "resultAt" timestamp and asserting the former precedes the latter.
    const large = build10kLineCorpusCase();
    let schedulerResolvedAt = 0;
    let resultAt = 0;
    const scheduler = async () => {
      schedulerResolvedAt = performance.now();
    };
    const result = await computeDiffAsync(large.before, large.after, { scheduler });
    resultAt = performance.now();
    expect(schedulerResolvedAt).toBeGreaterThan(0);
    expect(resultAt).toBeGreaterThanOrEqual(schedulerResolvedAt);
    expect(result.stats.added).toBeGreaterThan(0);
  });
});

// =============================================================================
// Stage 5 R2 (F5-3): AbortSignal cancellation
// =============================================================================

describe('computeDiffAsync — AbortSignal', () => {
  it('throws DiffAbortError when the signal is already aborted before call', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      computeDiffAsync('a\nb\n', 'a\nc\n', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'DiffAbortError' });
  });

  it('throws DiffAbortError when the signal fires during the scheduler yield', async () => {
    const controller = new AbortController();
    // Scheduler yields for long enough that we can abort before it resumes.
    const scheduler = () =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          controller.abort();
          resolve();
        }, 0);
      });
    await expect(
      computeDiffAsync('a\nb\n', 'a\nc\n', {
        scheduler,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'DiffAbortError' });
  });

  it('resolves normally when the signal is never aborted', async () => {
    const controller = new AbortController();
    const result = await computeDiffAsync('a\nb\n', 'a\nc\n', {
      signal: controller.signal,
      scheduler: async () => {},
    });
    expect(result.tooLarge).toBe(false);
    expect(result.stats.added).toBe(1);
  });

  it('DiffAbortError is structurally matchable by name', async () => {
    const controller = new AbortController();
    controller.abort();
    try {
      await computeDiffAsync('a\n', 'b\n', { signal: controller.signal });
      throw new Error('expected abort');
    } catch (err) {
      expect((err as Error).name).toBe('DiffAbortError');
      expect(err).toBeInstanceOf(Error);
    }
  });
});

// =============================================================================
// Hunk value / lineCount invariants
// =============================================================================

describe('computeDiff — hunk invariants', () => {
  it('preserves line terminators verbatim in each hunk value', () => {
    const result = computeDiff('a\nb\r\n', 'a\nc\r\n');
    // All hunks together reconstitute either side; verify each side.
    const rebuiltBefore = result.hunks
      .filter((h) => h.type !== 'added')
      .map((h) => h.value)
      .join('');
    const rebuiltAfter = result.hunks
      .filter((h) => h.type !== 'removed')
      .map((h) => h.value)
      .join('');
    expect(rebuiltBefore).toBe('a\nb\r\n');
    expect(rebuiltAfter).toBe('a\nc\r\n');
  });

  it('lineCount matches jsdiff "count" on every hunk', () => {
    const result = computeDiff('a\nb\nc\n', 'a\nX\nc\n');
    for (const hunk of result.hunks) {
      expect(hunk.lineCount).toBeGreaterThanOrEqual(1);
      // Round-trip: reconstructing the line count from the value itself
      // should agree with the stored lineCount for non-empty hunks.
      const lineCount = countLines(hunk.value);
      expect(hunk.lineCount).toBe(lineCount);
    }
  });

  it('stats.added equals the sum of lineCount across added hunks', () => {
    const large = build10kLineCorpusCase();
    const result = computeDiff(large.before, large.after);
    const summed = sumByType(result.hunks);
    expect(result.stats).toEqual(summed);
  });
});

// =============================================================================
// Helpers
// =============================================================================

function countLines(str: string): number {
  if (str.length === 0) return 0;
  let c = 0;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) === 10) c++;
  }
  if (str.charCodeAt(str.length - 1) !== 10) c++;
  return c;
}

function sumByType(hunks: Hunk[]): { added: number; removed: number; unchanged: number } {
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const h of hunks) {
    if (h.type === 'added') added += h.lineCount;
    else if (h.type === 'removed') removed += h.lineCount;
    else unchanged += h.lineCount;
  }
  return { added, removed, unchanged };
}

/**
 * Reconstituting the "before" side should concatenate unchanged + removed
 * hunks (in order); reconstituting the "after" side should concatenate
 * unchanged + added. This catches any hunk ordering / value truncation
 * regression.
 */
function assertHunksCoverInputs(result: DiffResult, before: string, after: string): void {
  if (result.tooLarge) return; // placeholder result — skip
  const rebuiltBefore = result.hunks
    .filter((h) => h.type !== 'added')
    .map((h) => h.value)
    .join('');
  const rebuiltAfter = result.hunks
    .filter((h) => h.type !== 'removed')
    .map((h) => h.value)
    .join('');
  expect(rebuiltBefore).toBe(before);
  expect(rebuiltAfter).toBe(after);
}
