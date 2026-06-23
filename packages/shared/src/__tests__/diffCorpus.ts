/**
 * Golden-corpus fixtures for the `computeDiff` parity gate.
 *
 * Lives as a TypeScript array (NOT a checked-in text file) because:
 * - Git normalizes `\r\n` to `\n` on checkout on Windows, which would
 *   silently corrupt our CRLF and mixed-line-ending cases.
 * - Editor auto-format / EOL settings can't rewrite escaped string
 *   literals, so the exact bytes we assert on stay fixed in source.
 *
 * Every case contains:
 *   - `id`: stable, unique identifier (test report labels).
 *   - `before` / `after`: the two strings to diff.
 *   - `expectedStats`: per-side line counts from the UNTRIMMED
 *     `computeDiff(before, after).stats`.
 *   - `expectedHunkCount`: total number of hunks (any type) that
 *     `computeDiff(before, after).hunks` should contain.
 *   - `notes` (optional): context about what this case exercises.
 *
 * **Minimum coverage gate** (per Stage 5 DoD in
 * `docs/plans/260416_centralize_approval_and_diff_viewing_ux.md`):
 *   1. empty → empty
 *   2. empty → single-line
 *   3. LF-only content
 *   4. CRLF-only content
 *   5. mixed LF + CRLF
 *   6. trailing newline vs none
 *   7. Unicode surrogate pairs
 *   8. tabs vs spaces
 *   9. binary-looking content (non-printable bytes)
 *  10. whitespace-only change
 *  11. large (10k-line) synthetic file (exercised separately, see
 *      `diff.perf.test.ts` and `build10kLineCorpusCase()` helper below)
 *  12. real staged-file samples (≥3 — see `realStagedFileCases`)
 *
 * New edge cases are added by PRs that include the fixture + expected
 * output so the parity test exercises the new scenario.
 */

import type { DiffStats } from '../diff';

export interface DiffCase {
  id: string;
  before: string;
  after: string;
  expectedStats: DiffStats;
  expectedHunkCount: number;
  notes?: string;
  /**
   * When true, the parity test against `react-diff-viewer-continued`
   * skips this case because the viewer applies a `trimRight()` +
   * "trim-equal pairing" post-processing step that legitimately
   * disagrees with jsdiff's pure line-level output. `computeDiff`
   * intentionally stays byte-accurate (a line-ending conversion IS a
   * change in file bytes) — these cases are still covered by the
   * fixture-level test above; only the parity cross-check is skipped.
   *
   * See `packages/shared/src/__tests__/diff.test.ts` parity describe
   * block for the divergence explanation.
   */
  skipParityCheck?: boolean;
}

// =============================================================================
// Edge-case corpus (1–10 from the DoD list)
// =============================================================================

const edgeCases: DiffCase[] = [
  // ---------------------------------------------------------------------------
  // 1. empty → empty
  // ---------------------------------------------------------------------------
  {
    id: 'empty-to-empty',
    before: '',
    after: '',
    expectedStats: { added: 0, removed: 0, unchanged: 0 },
    expectedHunkCount: 0,
    notes: 'Byte-identical empty inputs short-circuit to zero hunks.',
  },

  // ---------------------------------------------------------------------------
  // 2. empty → single-line
  // ---------------------------------------------------------------------------
  {
    id: 'empty-to-single-line-with-newline',
    before: '',
    after: 'hello world\n',
    expectedStats: { added: 1, removed: 0, unchanged: 0 },
    expectedHunkCount: 1,
    notes: 'Create: a single terminated line appears on the new side.',
  },
  {
    id: 'empty-to-single-line-no-newline',
    before: '',
    after: 'hello world',
    expectedStats: { added: 1, removed: 0, unchanged: 0 },
    expectedHunkCount: 1,
    notes: 'Create without trailing newline — still counts as 1 added line.',
  },
  {
    id: 'single-line-to-empty',
    before: 'hello world\n',
    after: '',
    expectedStats: { added: 0, removed: 1, unchanged: 0 },
    expectedHunkCount: 1,
    notes: 'Delete: the single line disappears.',
  },

  // ---------------------------------------------------------------------------
  // 3. LF-only content
  // ---------------------------------------------------------------------------
  {
    id: 'lf-identical',
    before: 'a\nb\nc\n',
    after: 'a\nb\nc\n',
    expectedStats: { added: 0, removed: 0, unchanged: 3 },
    expectedHunkCount: 1,
    notes: 'Identical LF content → single unchanged hunk.',
  },
  {
    id: 'lf-middle-line-modified',
    before: 'alpha\nbravo\ncharlie\n',
    after: 'alpha\nBRAVO\ncharlie\n',
    expectedStats: { added: 1, removed: 1, unchanged: 2 },
    expectedHunkCount: 4,
    notes: 'LF modify: unchanged, removed, added, unchanged.',
  },
  {
    id: 'lf-line-inserted',
    before: 'line1\nline3\n',
    after: 'line1\nline2\nline3\n',
    expectedStats: { added: 1, removed: 0, unchanged: 2 },
    expectedHunkCount: 3,
    notes: 'LF insertion splits the unchanged run.',
  },

  // ---------------------------------------------------------------------------
  // 4. CRLF-only content
  // ---------------------------------------------------------------------------
  {
    id: 'crlf-identical',
    before: 'a\r\nb\r\nc\r\n',
    after: 'a\r\nb\r\nc\r\n',
    expectedStats: { added: 0, removed: 0, unchanged: 3 },
    expectedHunkCount: 1,
    notes: 'Identical CRLF content → single unchanged hunk.',
  },
  {
    id: 'crlf-middle-line-modified',
    before: 'alpha\r\nbravo\r\ncharlie\r\n',
    after: 'alpha\r\nBRAVO\r\ncharlie\r\n',
    expectedStats: { added: 1, removed: 1, unchanged: 2 },
    expectedHunkCount: 4,
    notes: 'CRLF modify — same shape as LF modify, just different terminators.',
  },

  // ---------------------------------------------------------------------------
  // 5. Mixed line endings
  // ---------------------------------------------------------------------------
  {
    id: 'mixed-line-endings-identical',
    before: 'a\nb\r\nc\nd\r\n',
    after: 'a\nb\r\nc\nd\r\n',
    expectedStats: { added: 0, removed: 0, unchanged: 4 },
    expectedHunkCount: 1,
    notes: 'Mixed LF and CRLF preserved verbatim on both sides.',
  },
  {
    id: 'mixed-line-endings-modified',
    before: 'a\nb\r\nc\nd\r\n',
    after: 'a\nb\r\nc-changed\nd\r\n',
    expectedStats: { added: 1, removed: 1, unchanged: 3 },
    expectedHunkCount: 4,
    notes: 'Modify inside a mixed-ending block; terminators preserved verbatim.',
  },
  {
    id: 'line-ending-converted-lf-to-crlf',
    before: 'a\nb\n',
    after: 'a\r\nb\r\n',
    expectedStats: { added: 2, removed: 2, unchanged: 0 },
    expectedHunkCount: 2,
    notes: 'LF → CRLF conversion: every line is a different byte sequence, so all lines change.',
    // Viewer trims trailing '\n' then sees the last line as equal ("b"),
    // so its stats collapse one pair to "unchanged". Pure jsdiff sees the
    // bytes as different and (correctly) reports the change.
    skipParityCheck: true,
  },

  // ---------------------------------------------------------------------------
  // 6. Trailing newline vs none
  // ---------------------------------------------------------------------------
  {
    id: 'trailing-newline-added',
    before: 'a\nb',
    after: 'a\nb\n',
    expectedStats: { added: 1, removed: 1, unchanged: 1 },
    expectedHunkCount: 3,
    notes:
      'Adding a trailing newline changes the final token from "b" to "b\\n". ' +
      'jsdiff (and our computeDiff) tokenizes them as distinct lines.',
    // Viewer's trimRight() erases this difference before tokenizing, so
    // its stats read "no change". We surface the byte-level change.
    skipParityCheck: true,
  },
  {
    id: 'trailing-newline-removed',
    before: 'a\nb\n',
    after: 'a\nb',
    expectedStats: { added: 1, removed: 1, unchanged: 1 },
    expectedHunkCount: 3,
    notes: 'Mirror of the "added" case — same jsdiff tokenization rule.',
    skipParityCheck: true,
  },

  // ---------------------------------------------------------------------------
  // 7. Unicode surrogate pairs
  // ---------------------------------------------------------------------------
  {
    id: 'unicode-surrogate-identical',
    before: '\u{1F389} party time\n\u{1F4A5} boom\n',
    after: '\u{1F389} party time\n\u{1F4A5} boom\n',
    expectedStats: { added: 0, removed: 0, unchanged: 2 },
    expectedHunkCount: 1,
    notes: 'Identical surrogate-pair emoji lines → unchanged.',
  },
  {
    id: 'unicode-surrogate-emoji-swapped',
    before: '\u{1F389} party time\n',
    after: '\u{1F38A} party time\n',
    expectedStats: { added: 1, removed: 1, unchanged: 0 },
    expectedHunkCount: 2,
    notes: 'Swapping one emoji for another changes the line; surrogate pair diffs correctly.',
  },

  // ---------------------------------------------------------------------------
  // 8. Tabs vs spaces
  // ---------------------------------------------------------------------------
  {
    id: 'tabs-to-spaces',
    before: 'def foo():\n\treturn 1\n',
    after: 'def foo():\n    return 1\n',
    expectedStats: { added: 1, removed: 1, unchanged: 1 },
    expectedHunkCount: 3,
    notes: 'Indent changed from tab to four spaces — byte-level change.',
  },

  // ---------------------------------------------------------------------------
  // 9. Binary-looking content (non-printable bytes)
  //    computeDiff does not reject binary — we just diff the chars as-is.
  //    Callers are expected to use isLikelyBinary() upstream.
  // ---------------------------------------------------------------------------
  {
    id: 'binary-looking-added',
    before: 'header\n',
    after: 'header\n\x00\x01\x02\x03\n',
    expectedStats: { added: 1, removed: 0, unchanged: 1 },
    expectedHunkCount: 2,
    notes: 'Non-printable bytes appear as a new line; diff still works on the character stream.',
  },
  {
    id: 'binary-looking-identical',
    before: '\x00\x01\x02\n\xff\xfe\n',
    after: '\x00\x01\x02\n\xff\xfe\n',
    expectedStats: { added: 0, removed: 0, unchanged: 2 },
    expectedHunkCount: 1,
    notes: 'Identical binary-ish content still short-circuits to unchanged.',
  },

  // ---------------------------------------------------------------------------
  // 10. Whitespace-only change
  //     With ignoreWhitespace:false (our setting, mirroring react-diff-viewer-
  //     continued), whitespace-only diffs still register as modifications.
  // ---------------------------------------------------------------------------
  {
    id: 'whitespace-only-trailing-space-added',
    before: 'line one\n',
    after: 'line one \n',
    expectedStats: { added: 1, removed: 1, unchanged: 0 },
    expectedHunkCount: 2,
    notes:
      'Trailing space on a line is a byte-level change; ignoreWhitespace is FALSE ' +
      'in our jsdiff invocation, so this is a full modification.',
    // Viewer strips all trailing whitespace (including spaces) before
    // tokenizing; our pure output keeps the space-level change visible.
    skipParityCheck: true,
  },
  {
    id: 'whitespace-only-indent-change',
    before: 'x\n  y\nz\n',
    after: 'x\n    y\nz\n',
    expectedStats: { added: 1, removed: 1, unchanged: 2 },
    expectedHunkCount: 4,
    notes: 'Indent widened from 2 to 4 spaces.',
  },
];

// =============================================================================
// 12. Real staged-file samples (≥3 — per DoD)
// =============================================================================

const markdownFileBefore = [
  '# Q2 Planning Notes',
  '',
  '## Goals',
  '',
  '- Ship the approval UX refresh',
  '- Close the mobile gap',
  '- Hit 90% eval pass rate',
  '',
  '## Risks',
  '',
  '- Parity regressions on desktop',
  '',
].join('\n');

const markdownFileAfter = [
  '# Q2 Planning Notes',
  '',
  '## Goals',
  '',
  '- Ship the approval UX refresh',
  '- Close the mobile gap on iOS and Android',
  '- Hit 95% eval pass rate',
  '',
  '## Risks',
  '',
  '- Parity regressions on desktop',
  '- Offline publish queue deferred',
  '',
].join('\n');

const tsFileBefore = [
  'export interface ApprovalSummary {',
  '  id: string;',
  '  sessionId: string;',
  '  kind: "tool" | "memory";',
  '}',
  '',
  'export function summarize(item: ApprovalSummary): string {',
  '  return `${item.kind}:${item.id}`;',
  '}',
  '',
].join('\n');

const tsFileAfter = [
  'export interface ApprovalSummary {',
  '  id: string;',
  '  sessionId: string;',
  '  kind: "tool" | "memory" | "staged-file";',
  '  createdAt: number;',
  '}',
  '',
  'export function summarize(item: ApprovalSummary): string {',
  '  return `${item.kind}:${item.id}@${item.createdAt}`;',
  '}',
  '',
].join('\n');

const jsonFileBefore = [
  '{',
  '  "name": "Memory Approval",',
  '  "status": "pending",',
  '  "details": {',
  '    "file": "notes.md",',
  '    "size": 1024',
  '  }',
  '}',
  '',
].join('\n');

const jsonFileAfter = [
  '{',
  '  "name": "Memory Approval",',
  '  "status": "approved",',
  '  "details": {',
  '    "file": "notes.md",',
  '    "size": 2048,',
  '    "sharing": "private"',
  '  }',
  '}',
  '',
].join('\n');

const realStagedFileCases: DiffCase[] = [
  {
    id: 'real-staged-file-markdown-notes',
    before: markdownFileBefore,
    after: markdownFileAfter,
    // Two consecutive line modifications (LCS merges them into one
    // removed+added pair) plus one inserted line at the end.
    // Hunk shape: unchanged(5) removed(2) added(2) unchanged(4) added(1).
    expectedStats: { added: 3, removed: 2, unchanged: 9 },
    expectedHunkCount: 5,
    notes: 'A realistic markdown staged file with two modifications and one insertion.',
  },
  {
    id: 'real-staged-file-ts-interface',
    before: tsFileBefore,
    after: tsFileAfter,
    // Two separate modifications (with unchanged lines between them).
    // Hunk shape:
    //   unchanged(3) removed(1) added(2) unchanged(3) removed(1) added(1) unchanged(1).
    expectedStats: { added: 3, removed: 2, unchanged: 7 },
    expectedHunkCount: 7,
    notes: 'A realistic TypeScript interface + function staged file.',
  },
  {
    id: 'real-staged-file-json-config',
    before: jsonFileBefore,
    after: jsonFileAfter,
    // Two separate modifications (with unchanged lines between them).
    // Hunk shape:
    //   unchanged(2) removed(1) added(1) unchanged(2) removed(1) added(2) unchanged(2).
    expectedStats: { added: 3, removed: 2, unchanged: 6 },
    expectedHunkCount: 7,
    notes: 'A realistic JSON config staged file.',
  },
];

// =============================================================================
// Public corpus
// =============================================================================

export const diffCorpus: DiffCase[] = [...edgeCases, ...realStagedFileCases];

// =============================================================================
// Synthetic 10k-line builder (used by parity + perf tests)
// =============================================================================

/**
 * Build a synthetic 10k-line corpus case.
 *
 * Lives as a factory (not baked into the static array) because it's
 * ~300 kB of text that we don't want cluttering test reports or import
 * cost in normal runs.
 */
export function build10kLineCorpusCase(): DiffCase {
  const totalLines = 10000;
  const before: string[] = [];
  const after: string[] = [];

  for (let i = 0; i < totalLines; i++) {
    const baseLine = `line ${i.toString().padStart(5, '0')} — content payload`;
    before.push(baseLine);
    // Modify every 500th line so we get a realistic "spread" of changes.
    if (i % 500 === 0) {
      after.push(`${baseLine} (UPDATED)`);
    } else {
      after.push(baseLine);
    }
  }

  const beforeStr = before.join('\n') + '\n';
  const afterStr = after.join('\n') + '\n';

  // 20 modified lines (indices 0, 500, 1000, ..., 9500) → 20 added + 20 removed,
  // and 9980 unchanged on each side.
  const modifiedLines = Math.ceil(totalLines / 500);
  // Each modification sits between two unchanged runs; the count of hunks
  // is (unchanged_run_count) + 2 * modified_line_count = 20 runs of
  // unchanged + 20 * 2 hunks of ±. Tail of the diff ends in unchanged.
  // Structure: [unchanged? removed added unchanged removed added unchanged ...]
  // With the first line (i=0) modified, the pattern starts "removed added unchanged ...".
  // Pattern per mod: removed, added, then unchanged (499 lines). Last run may
  // terminate with an unchanged hunk that includes lines 9501..9999.
  // Total hunks = 20 * 2 (removed+added) + 20 (unchanged blocks between) = 60.
  const expectedHunkCount = modifiedLines * 2 + modifiedLines;

  return {
    id: 'large-10k-line-synthetic',
    before: beforeStr,
    after: afterStr,
    expectedStats: {
      added: modifiedLines,
      removed: modifiedLines,
      unchanged: totalLines - modifiedLines,
    },
    expectedHunkCount,
    notes: '10k-line synthetic file with one modification every 500 lines.',
  };
}
