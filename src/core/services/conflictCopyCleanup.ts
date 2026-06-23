import path from 'node:path';

import {
  deriveOriginalPath,
  matchConflictPattern,
  type ConflictLabel,
  type ConflictProvider,
} from '@shared/conflictPatterns';

export interface ConflictSnapshotEntry {
  relPath: string;
  hash: string | null;
  size: number;
}

export const AUTO_ELIGIBLE_LABELS: ReadonlySet<ConflictLabel> = new Set<ConflictLabel>([
  'numbered-copy',
  'dropbox-conflict',
  'sync-conflict',
]);

export interface QuarantineCandidate {
  relPath: string;
  immediateParentRelPath: string;
  label: ConflictLabel;
  provider: ConflictProvider;
  hash: string;
}

export type ReviewReason =
  | 'differing-from-parent'
  | 'parent-missing'
  | 'empty-or-placeholder'
  | 'parent-empty-or-unreadable'
  | 'detect-only-label';

export interface ReviewItem {
  relPath: string;
  label: ConflictLabel;
  provider: ConflictProvider;
  immediateParentRelPath: string | null;
  reason: ReviewReason;
}

export interface CleanupPlan {
  toQuarantine: QuarantineCandidate[];
  needsReview: ReviewItem[];
}

/**
 * Same-directory immediate parent (ONE suffix peeled).
 * Returns null if relPath is not a conflict copy or if it is Rebel's own conflict marker.
 */
export function deriveImmediateParentRelPath(
  relPath: string,
): { parentRelPath: string; label: ConflictLabel; provider: ConflictProvider } | null {
  const basename = path.posix.basename(relPath);
  const match = matchConflictPattern(basename);
  if (!match || match.label === 'rebel-cloud-conflict') {
    return null;
  }

  const parentBasename = deriveOriginalPath(basename, match.label);
  if (!parentBasename || parentBasename === basename) {
    return null;
  }

  const dirname = path.posix.dirname(relPath);
  const parentRelPath =
    dirname === '.' || dirname === ''
      ? parentBasename
      : path.posix.join(dirname, parentBasename);

  return {
    parentRelPath,
    label: match.label,
    provider: match.provider,
  };
}

/** Pure, order-independent. Builds the plan from a snapshot. */
export function planConflictCopyCleanup(snapshot: readonly ConflictSnapshotEntry[]): CleanupPlan {
  const byRelPath = new Map<string, ConflictSnapshotEntry>();
  for (const entry of snapshot) {
    byRelPath.set(entry.relPath, entry);
  }

  const toQuarantine: QuarantineCandidate[] = [];
  const needsReview: ReviewItem[] = [];

  for (const entry of snapshot) {
    const parent = deriveImmediateParentRelPath(entry.relPath);
    if (!parent) {
      continue;
    }

    if (!AUTO_ELIGIBLE_LABELS.has(parent.label)) {
      needsReview.push({
        relPath: entry.relPath,
        label: parent.label,
        provider: parent.provider,
        immediateParentRelPath: parent.parentRelPath,
        reason: 'detect-only-label',
      });
      continue;
    }

    if (entry.size === 0 || entry.hash == null) {
      needsReview.push({
        relPath: entry.relPath,
        label: parent.label,
        provider: parent.provider,
        immediateParentRelPath: parent.parentRelPath,
        reason: 'empty-or-placeholder',
      });
      continue;
    }

    const parentEntry = byRelPath.get(parent.parentRelPath);
    if (!parentEntry) {
      needsReview.push({
        relPath: entry.relPath,
        label: parent.label,
        provider: parent.provider,
        immediateParentRelPath: parent.parentRelPath,
        reason: 'parent-missing',
      });
      continue;
    }

    if (parentEntry.size === 0 || parentEntry.hash == null) {
      needsReview.push({
        relPath: entry.relPath,
        label: parent.label,
        provider: parent.provider,
        immediateParentRelPath: parent.parentRelPath,
        reason: 'parent-empty-or-unreadable',
      });
      continue;
    }

    if (parentEntry.hash === entry.hash) {
      toQuarantine.push({
        relPath: entry.relPath,
        immediateParentRelPath: parent.parentRelPath,
        label: parent.label,
        provider: parent.provider,
        hash: entry.hash,
      });
      continue;
    }

    needsReview.push({
      relPath: entry.relPath,
      label: parent.label,
      provider: parent.provider,
      immediateParentRelPath: parent.parentRelPath,
      reason: 'differing-from-parent',
    });
  }

  return {
    toQuarantine: toQuarantine.sort(compareByRelPath),
    needsReview: needsReview.sort(compareByRelPath),
  };
}

function compareByRelPath<T extends { relPath: string }>(a: T, b: T): number {
  if (a.relPath < b.relPath) return -1;
  if (a.relPath > b.relPath) return 1;
  return 0;
}
