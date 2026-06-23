import { useMemo } from 'react';
import type { LibrarySearchOutcome } from './engine';

export type TruncationSignal =
  | { kind: 'none' }
  | { kind: 'engine-cap'; entriesTotal: number; entriesIndexed: number }
  | { kind: 'tree' }
  | { kind: 'both'; entriesTotal: number; entriesIndexed: number }
  | { kind: 'unknown' }
  /**
   * A cloud-backed space in scope is reconnecting / unreachable, so results may be
   * the last-known index (Stage 8, 260619_cloud-symlink-indexing). The same
   * "your view is partial / showing last-known" job the other variants do — a new
   * cause. `reconnectingSpaceCount` drives plural/singular copy. This is the moment
   * the user actually feels the degraded state (searching and not finding a file),
   * so it takes priority over the cap/tree signals.
   */
  | { kind: 'cloud-degraded'; reconnectingSpaceCount: number };

/**
 * Whether the in-memory file tree is a partial view of the workspace. This is
 * the authoritative tree-truncation source — it comes from `buildFileTree`'s
 * completeness metadata (the 100k node / byte producer cap, Bug-2), NOT from the
 * separate `library:get-stats` walk (capped at a different 1,000,000 limit, so
 * it can disagree). See PLAN.md Stage 3.
 *
 * - `boolean`: known complete (`false`) or known partial (`true`).
 * - `'unknown'`: metadata not yet available (still loading / never fetched).
 */
export type TreeCompleteness = boolean | 'unknown';

export function deriveTruncationSignal(
  searchOutcome: LibrarySearchOutcome | null,
  treeCompleteness: TreeCompleteness,
  reconnectingSpaceCount = 0,
): TruncationSignal {
  // A reconnecting cloud space in scope is the most actionable explanation for
  // stale/missing results — surface it ahead of the cap/tree signals (it's the
  // moment the user actually feels the degraded state). Stage 8.
  if (reconnectingSpaceCount > 0) {
    return { kind: 'cloud-degraded', reconnectingSpaceCount };
  }

  // Explicitly require `true` for engine-cap detection. Malformed payloads like
  // `truncated: undefined` are treated as "no engine cap" by default.
  const engineCapHit = searchOutcome?.truncated === true;
  const treeTruncated = treeCompleteness === true;

  if (engineCapHit && treeTruncated) {
    return {
      kind: 'both',
      entriesTotal: searchOutcome?.entriesTotal ?? 0,
      entriesIndexed: searchOutcome?.entriesIndexed ?? 0,
    };
  }

  if (engineCapHit) {
    return {
      kind: 'engine-cap',
      entriesTotal: searchOutcome?.entriesTotal ?? 0,
      entriesIndexed: searchOutcome?.entriesIndexed ?? 0,
    };
  }

  if (treeTruncated) {
    return { kind: 'tree' };
  }

  if (treeCompleteness === 'unknown') {
    return { kind: 'unknown' };
  }

  // Tree is known-complete and there is no engine cap signal.
  return { kind: 'none' };
}

type UseTruncationSignalArgs = {
  searchOutcome: LibrarySearchOutcome | null;
  treeCompleteness: TreeCompleteness;
  /**
   * Count of cloud spaces in scope that are currently reconnecting/unreachable
   * (Stage 8). > 0 ⇒ a `cloud-degraded` signal (results may be last-known).
   * Defaults to 0 (no signal) so existing callers are unaffected.
   */
  reconnectingSpaceCount?: number;
};

export function useTruncationSignal({
  searchOutcome,
  treeCompleteness,
  reconnectingSpaceCount = 0,
}: UseTruncationSignalArgs): TruncationSignal {
  return useMemo(
    () => deriveTruncationSignal(searchOutcome, treeCompleteness, reconnectingSpaceCount),
    [searchOutcome, treeCompleteness, reconnectingSpaceCount],
  );
}
