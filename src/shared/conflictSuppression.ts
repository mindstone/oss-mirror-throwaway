import { statSync } from 'node:fs';
import {
  deriveOriginalDirPath,
  deriveOriginalPathCandidates,
  matchConflictDirPattern,
  matchConflictPattern,
} from './conflictPatterns';
import { ignoreBestEffortCleanup } from './utils/intentionalSwallow';

/**
 * Pure Google-Drive/Dropbox conflict-copy suppression gate.
 *
 * Hoisted to `@shared` so BOTH the desktop workspace-sync (`@main`) and the
 * per-user Fly cloud-service manifest builder (`cloud-service`) can share ONE
 * copy of this logic. cloud-service imports zero `@main` modules; routing the
 * gate through `@main` would have introduced the first cloud→desktop-main
 * coupling. These functions are pure (callback-based; only `isExistingDirectory`
 * touches `node:fs` `statSync`, fine in both Node runtimes), so they belong here.
 */

export interface ConflictDirAncestorProbes {
  manifestHasPrefix: (relativeDirPrefix: string) => boolean;
  localDirExists: (relativeDir: string) => boolean;
}

/**
 * Decide whether a file is a *suppressible* cloud-storage conflict copy — i.e.
 * a Google-Drive numbered copy (`foo (1).md`), Dropbox conflicted copy,
 * `Copy of …`, ` copy.ext`, or `-conflict-<digits>` artifact whose ORIGINAL
 * sibling is present. Such files are minted by Drive/Dropbox when two machines
 * write the same path; mirroring them through Fly re-propagates them to the
 * peer as new files, producing the runaway `(1) (1) (1) …` fan-out (REBEL-62A).
 *
 * Sibling-gated on purpose: a non-Drive user's standalone `Report (1).md`
 * (with no `Report.md`) is NOT a conflict copy and must keep syncing. Only when
 * the derived original is present do we treat the file as a Drive/Dropbox
 * artifact and exclude it from the workspace sync manifest (both push and pull).
 *
 * `basename` MUST be a bare filename (not a path). `originalIsPresent` is given
 * the derived original's BASENAME and returns whether that original exists in
 * the relevant scope (on disk for push; in the cloud/local manifest for pull).
 *
 * `.conflict-cloud` / `.pending.md` are handled by separate, unconditional
 * skips upstream and intentionally not routed through here.
 */
export function isSuppressibleConflictCopy(
  basename: string,
  originalIsPresent: (originalBasename: string) => boolean,
): boolean {
  const match = matchConflictPattern(basename);
  if (!match) return false;
  // Rebel's own conflict marker is handled by the dedicated upstream skip; never
  // route it through sibling-gating (its original may legitimately not exist).
  if (match.label === 'rebel-cloud-conflict') return false;
  // Gate on EVERY progressively-shallower original, not just the immediate
  // sibling. A nested numbered copy (`foo (1) (1).md`) whose intermediate
  // (`foo (1).md`) was deleted/renamed/not-yet-synced — but whose root
  // (`foo.md`) survives — must still be recognised as a conflict copy, or the
  // gate fails open and Fly re-propagates it (REBEL-62A recurrence). Non-nested
  // labels yield a single candidate, so their behavior is unchanged.
  const candidates = deriveOriginalPathCandidates(basename, match.label);
  if (candidates.length === 0) return false;
  return candidates.some((originalBasename) => originalIsPresent(originalBasename));
}

export function isSuppressibleConflictDir(
  basename: string,
  originalDirIsPresent: (originalBasename: string) => boolean,
): boolean {
  const match = matchConflictDirPattern(basename);
  if (!match) return false;
  const originalBasename = deriveOriginalDirPath(basename, match.label);
  if (!originalBasename) return false;
  return originalDirIsPresent(originalBasename);
}

export function shouldSuppressConflictDirAncestor(
  relativePath: string,
  { manifestHasPrefix, localDirExists }: ConflictDirAncestorProbes,
): boolean {
  const segments = relativePath.split('/');
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    const match = matchConflictDirPattern(segment);
    if (!match) continue;

    const originalBasename = deriveOriginalDirPath(segment, match.label);
    if (!originalBasename) continue;

    const parent = segments.slice(0, i).join('/');
    const originalDir = parent ? `${parent}/${originalBasename}` : originalBasename;
    if (manifestHasPrefix(`${originalDir}/`) || localDirExists(originalDir)) {
      return true;
    }
  }

  return false;
}

/**
 * Best-effort probe: does a real directory exist at `absolutePath`? Used only for the rare
 * conflict-copy sibling-gate checks (REBEL-5QS). Any stat failure (absent OR permission) means
 * "no original sibling to gate on" → caller does NOT suppress (fail toward syncing, the safe default).
 */
export function isExistingDirectory(absolutePath: string): boolean {
  try {
    return statSync(absolutePath).isDirectory();
  } catch (err) {
    ignoreBestEffortCleanup(err, {
      operation: 'cloudWorkspaceSync.isExistingDirectory',
      reason: 'sibling-dir-probe-failed-treated-as-absent',
      severity: 'debug',
      owner: 'main.cloudWorkspaceSync',
    });
    return false;
  }
}
