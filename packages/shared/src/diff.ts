/**
 * Pure, platform-agnostic line-level diff primitives.
 *
 * Wraps jsdiff's `diffLines` with a minimal, strongly-typed API so that
 * desktop, cloud, and mobile surfaces can compute identical line-level
 * diff stats from the same content.
 *
 * Desktop currently renders its visible diff through
 * `react-diff-viewer-continued` (which itself calls `diffLines` under the
 * hood). This module mirrors that library's `diffLines` invocation options
 * verbatim so the per-side (added / removed / unchanged) line counts are
 * byte-compatible — the golden-corpus parity test in
 * `packages/shared/src/__tests__/diff.test.ts` enforces that contract.
 *
 * Consumed by:
 * - `src/renderer/features/inbox/components/StagedFilePreviewDialog.tsx`
 *   and `MemoryPreviewDialog.tsx` — internal comparisons only; visible
 *   diff still renders via `react-diff-viewer-continued` (Stage 5 locks
 *   this behavior in; Stage 6 lifts the stats onto mobile UI).
 * - `mobile/src/components/approval/MobileDiffView.tsx` (Stage 6).
 *
 * See `docs/plans/260416_centralize_approval_and_diff_viewing_ux.md`
 * Stage 5 for the full design and acceptance gates.
 */

/// <reference path="./diff.d.ts" />
import { diffLines } from 'diff';

// =============================================================================
// Types
// =============================================================================

/**
 * A single contiguous block of diff output — a run of lines that were all
 * `added`, `removed`, or `unchanged` together.
 *
 * `value` preserves the original line endings verbatim so callers can
 * reconstruct either side exactly; `lineCount` is jsdiff's `count` field
 * (the number of tokenized lines, where one token = one content line
 * including its trailing `\n` or `\r\n`, or a final line without a
 * terminator).
 */
export interface Hunk {
  type: 'added' | 'removed' | 'unchanged';
  value: string;
  /** Number of lines represented by this hunk. */
  lineCount: number;
}

/**
 * Per-side line counts. `added + unchanged` equals the number of lines on
 * the "after" side; `removed + unchanged` equals the number on the
 * "before" side.
 */
export interface DiffStats {
  added: number;
  removed: number;
  unchanged: number;
}

/**
 * Result shape returned by {@link computeDiff} / {@link computeDiffAsync}.
 *
 * Modelled as a discriminated union on `tooLarge` so callers are forced
 * to branch explicitly — without this, a forgetful consumer would
 * silently treat `{ hunks: [], stats: { 0, 0, 0 }, tooLarge: true }`
 * (oversized-input bail-out) as "no changes". Stage 5 R2 (F5-2) tightens
 * this shape after reviewers flagged the original optional-flag form as
 * an easy silent-failure vector.
 *
 * - `tooLarge: false` → a real diff (possibly zero-length if both sides
 *   are byte-identical).
 * - `tooLarge: true`  → the input exceeded
 *   {@link ComputeDiffOptions.maxLinesForFullDiff}; caller should render
 *   a "file too large — open on desktop" fallback state rather than
 *   displaying the (empty) hunks/stats as if nothing changed.
 */
export type DiffResult =
  | { tooLarge: false; hunks: Hunk[]; stats: DiffStats }
  | { tooLarge: true; hunks: []; stats: { added: 0; removed: 0; unchanged: 0 } };

/** Options accepted by {@link computeDiff} / {@link computeDiffAsync}. */
export interface ComputeDiffOptions {
  /**
   * Escape hatch for pathologically large inputs. When the summed line
   * count of `before` + `after` exceeds this threshold, the function
   * returns a placeholder `DiffResult` with `tooLarge: true` instead of
   * invoking `diffLines` (which is O(N*D) and can freeze the UI thread
   * for multi-megabyte inputs).
   *
   * Defaults to `Infinity` — no cap — when omitted, preserving today's
   * desktop behavior.
   */
  maxLinesForFullDiff?: number;
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Lightweight line counter that avoids allocating a split array.
 *
 * Matches jsdiff's tokenizer in the cases we care about: a string ending
 * in `\n` has N lines, a string ending in anything else has N+1 lines
 * (the trailing fragment counts as its own line). Empty strings have 0.
 */
function countLines(str: string): number {
  if (str.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) === 10) count++; // '\n'
  }
  if (str.charCodeAt(str.length - 1) !== 10) count++;
  return count;
}

// =============================================================================
// computeDiff — synchronous, pure
// =============================================================================

/**
 * Compute a line-level diff between `before` and `after`.
 *
 * Wraps jsdiff's `diffLines` with the same options used by
 * `react-diff-viewer-continued` (`newlineIsToken: false`,
 * `ignoreWhitespace: false`, `ignoreCase: false`). This guarantees that
 * the desktop viewer and any consumer of this function see the same
 * hunks for the same inputs — the parity test in
 * `packages/shared/src/__tests__/diff.test.ts` enforces that over the
 * full `diffCorpus.ts` fixture set.
 *
 * Short-circuits on byte-identical inputs so equality checks are O(1).
 * Otherwise the underlying `diffLines` is O(N*D) (Myers LCS).
 *
 * This function is synchronous and unbounded by default. Use
 * {@link ComputeDiffOptions.maxLinesForFullDiff} to cap runaway inputs,
 * or {@link computeDiffAsync} to yield to the host event loop before
 * computing.
 */
export function computeDiff(
  before: string,
  after: string,
  options?: ComputeDiffOptions,
): DiffResult {
  // Fast path: identical bytes → zero-diff, one big unchanged hunk (or
  // no hunks for empty input). Cheap even for multi-MB strings.
  if (before === after) {
    if (before.length === 0) {
      return {
        tooLarge: false,
        hunks: [],
        stats: { added: 0, removed: 0, unchanged: 0 },
      };
    }
    const lineCount = countLines(before);
    return {
      tooLarge: false,
      hunks: [{ type: 'unchanged', value: before, lineCount }],
      stats: { added: 0, removed: 0, unchanged: lineCount },
    };
  }

  const maxLines = options?.maxLinesForFullDiff;
  if (typeof maxLines === 'number' && Number.isFinite(maxLines)) {
    const totalLines = countLines(before) + countLines(after);
    if (totalLines > maxLines) {
      return {
        tooLarge: true,
        hunks: [],
        stats: { added: 0, removed: 0, unchanged: 0 },
      };
    }
  }

  const rawChanges = diffLines(before, after, {
    newlineIsToken: false,
    ignoreWhitespace: false,
    ignoreCase: false,
  });

  const hunks: Hunk[] = [];
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const change of rawChanges) {
    const value = change.value ?? '';
    if (!value) continue; // defensive — jsdiff shouldn't emit empty chunks
    const lineCount = typeof change.count === 'number' ? change.count : countLines(value);
    let type: Hunk['type'];
    if (change.added) {
      type = 'added';
      added += lineCount;
    } else if (change.removed) {
      type = 'removed';
      removed += lineCount;
    } else {
      type = 'unchanged';
      unchanged += lineCount;
    }
    hunks.push({ type, value, lineCount });
  }

  return {
    tooLarge: false,
    hunks,
    stats: { added, removed, unchanged },
  };
}

// =============================================================================
// computeDiffAsync — yielding wrapper for large inputs
// =============================================================================

/**
 * A scheduler is a zero-argument function that resolves on some
 * "next-tick"-like boundary. The default scheduler prefers
 * `requestIdleCallback` (available in browsers/Electron renderers) and
 * falls back to `setTimeout(0)` everywhere else.
 *
 * React Native callers should supply their own scheduler wrapping
 * `InteractionManager.runAfterInteractions`; `@rebel/shared` does not
 * import RN APIs.
 */
export type SchedulerFn = () => Promise<void>;

/**
 * Default scheduler implementation for browser / Electron renderer
 * contexts. Resolves on the next idle callback when available, else on
 * the next timer tick.
 */
function defaultScheduler(): Promise<void> {
  type MaybeIdleGlobal = {
    requestIdleCallback?: (cb: () => void) => unknown;
  };
  const globalWithIdle = globalThis as MaybeIdleGlobal;
  if (typeof globalWithIdle.requestIdleCallback === 'function') {
    return new Promise<void>((resolve) => {
      globalWithIdle.requestIdleCallback!(() => resolve());
    });
  }
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * Thrown by {@link computeDiffAsync} when the caller aborts via the
 * supplied `AbortSignal` before the (synchronous) LCS pass runs. Named
 * `DiffAbortError` rather than the built-in `AbortError` because browser
 * targets don't expose the latter reliably and we want a type callers
 * can match structurally in either environment.
 */
export class DiffAbortError extends Error {
  readonly name = 'DiffAbortError';
  constructor(message = 'computeDiffAsync was aborted') {
    super(message);
  }
}

/**
 * Asynchronous wrapper around {@link computeDiff} that yields once to
 * the host event loop *before* running the (potentially expensive) LCS
 * computation. Useful for large inputs where we want the current frame
 * to paint a loading indicator before a long-running synchronous
 * computation starts.
 *
 * IMPORTANT: chunking/yielding here defers work but does NOT reduce
 * total CPU. The jsdiff algorithm is holistic (Myers LCS) — we can't
 * stream partial results. For a true bail-out on oversized inputs, use
 * {@link ComputeDiffOptions.maxLinesForFullDiff} which returns a
 * placeholder result with `tooLarge: true`.
 *
 * Stage 5 R2 (F5-3) adds an optional `signal` so UI callers can cancel
 * queued work when the dialog closes / component unmounts. If the
 * signal is already aborted (or fires before the scheduler yields), the
 * function throws `DiffAbortError` instead of running `diffLines`.
 * Callers are expected to treat `DiffAbortError` as "discard result",
 * not as a real failure.
 *
 * Platform guidance:
 * - **Desktop / Electron renderer:** default scheduler is fine
 *   (`requestIdleCallback`).
 * - **React Native / mobile:** pass `{ scheduler: () => new Promise(r =>
 *   InteractionManager.runAfterInteractions(() => r())) }` so the UI
 *   thread can settle after any in-flight gestures / animations.
 */
export async function computeDiffAsync(
  before: string,
  after: string,
  options?: ComputeDiffOptions & {
    scheduler?: SchedulerFn;
    signal?: AbortSignal;
  },
): Promise<DiffResult> {
  const signal = options?.signal;
  if (signal?.aborted) {
    throw new DiffAbortError();
  }
  const yieldOnce = options?.scheduler ?? defaultScheduler;
  await yieldOnce();
  if (signal?.aborted) {
    throw new DiffAbortError();
  }
  return computeDiff(before, after, options);
}
