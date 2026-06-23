/**
 * ============================================================================
 * Merge Integrity Verifier — Core Algorithm
 * ============================================================================
 *
 * Detects "ours"-style merges where incoming changes are silently dropped.
 * This is the algorithmic core — pure analysis separated from git I/O for
 * testability.
 *
 * Two checks:
 *   1. **Tree equality** (deterministic): merge_tree == parent1_tree → FAIL
 *      Catches 100% of "take ours" merges with zero configuration.
 *   2. **Incorporation ratio** (heuristic): what fraction of "theirs" files
 *      appear in the merge diff? Low ratio + many theirs files → WARN.
 *
 * Background: Two incidents (Mar 29: 87 files, Apr 2: 362 files) where
 * `git reset HEAD -- .` in merge state created merge commits identical to
 * parent 1, silently dropping all incoming changes.
 *
 * See: docs/plans/260403_merge_safety_hardening.md
 * See: docs-private/postmortems/260330_merge_drop_concurrent_session_race_postmortem.md
 * ============================================================================
 */

import { execSync, type ExecSyncOptions } from 'child_process';
import { DEFAULT_GIT_MAXBUFFER } from './git-exec.js';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Raw facts gathered from git about a merge commit */
export interface MergeFacts {
  /** The merge commit SHA */
  mergeCommit: string;
  /** First parent SHA (ours) */
  parent1: string;
  /** Second parent SHA (theirs) */
  parent2: string;
  /** Tree object SHA of the merge commit */
  mergeTree: string;
  /** Tree object SHA of parent 1 */
  parent1Tree: string;
  /** Files changed between merge-base and parent 2 (what "theirs" brought in) */
  theirsFiles: string[];
  /** Files changed between parent 1 and the merge commit */
  mergeChangedFiles: string[];
  /**
   * Files from theirs that don't appear in mergeChangedFiles but whose content
   * in the merge result matches theirs (convergent changes — both sides made
   * the same modification independently). These are correctly incorporated
   * despite not showing up in the parent1→merge diff.
   *
   * Common causes: submodule pointers advanced locally before merge, identical
   * fixes applied on both sides, auto-formatted files.
   */
  convergentFiles: string[];
  /** Whether this is a merge commit (2 parents) */
  isMerge: boolean;
  /** Whether this is an octopus merge (3+ parents) — skipped */
  isOctopus: boolean;
}

/** Result of merge integrity analysis */
export interface MergeIntegrityResult {
  status: 'pass' | 'fail' | 'warn' | 'skip';
  reason: string;
  mergeCommit: string;
  parent1: string;
  parent2: string;
  theirsFileCount: number;
  mergeChangeCount: number;
  incorporationRatio: number;
  /** Sample of dropped files (up to 10) for diagnostic output */
  suspiciousFiles?: string[];
}

/** Configuration options for the integrity check */
export interface MergeIntegrityOptions {
  /** Minimum incorporation ratio; below this triggers a warning (default: 0.1) */
  threshold?: number;
  /** Minimum number of "theirs" files before ratio check applies (default: 5) */
  minTheirsFiles?: number;
  /**
   * Pre-loaded allowlist of merge SHAs to treat as PASS.
   * If omitted, the default repo-level allowlist
   * (`scripts/lib/merge-integrity-allowlist.json`) is loaded automatically.
   * Pass an empty array to disable allowlisting entirely (useful for tests).
   */
  allowlist?: AllowlistEntry[];
}

/** A historical merge that the verifier should treat as PASS. */
export interface AllowlistEntry {
  /** Full 40-char merge commit SHA */
  sha: string;
  /** Why this merge is allowlisted (free-form, used for diagnostics) */
  reason: string;
  /** Commit SHA where the dropped content was recovered (free-form) */
  recovered_in?: string;
}

/** Injectable git command runner for testability */
export type GitRunner = (command: string, options?: ExecSyncOptions) => string;

// -----------------------------------------------------------------------------
// Default git runner (uses execSync)
// -----------------------------------------------------------------------------

/**
 * Default git runner that shells out via execSync.
 *
 * This wrapper is the single chokepoint for every git command merge-integrity
 * runs (incl. `git diff --name-only` reachable from .husky/pre-push), so it
 * carries the shared DEFAULT_GIT_MAXBUFFER policy. The guard
 * (check-git-exec-maxbuffer.ts) cannot see git commands assembled into the
 * `command` variable here, so bounding the runner is what kills the class for
 * this module — see the guard's "Known limitation" header.
 */
// git-exec-allow: wrapper centralizes DEFAULT_GIT_MAXBUFFER for all merge-integrity git commands
export function defaultGitRunner(command: string, options?: ExecSyncOptions): string {
  return execSync(command, {
    maxBuffer: DEFAULT_GIT_MAXBUFFER,
    ...options,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// -----------------------------------------------------------------------------
// Git I/O — collecting facts
// -----------------------------------------------------------------------------

/**
 * Collects raw merge facts from git for a given commit.
 *
 * @param repoRoot - Absolute path to the repository root
 * @param commit - The commit to inspect (default: HEAD)
 * @param gitRunner - Injectable git command runner (default: execSync wrapper)
 */
export function collectMergeFacts(
  repoRoot: string,
  commit: string = 'HEAD',
  gitRunner: GitRunner = defaultGitRunner,
): MergeFacts {
  const opts: ExecSyncOptions = { cwd: repoRoot };

  // Resolve the commit SHA
  const mergeCommit = gitRunner(`git rev-parse ${commit}`, opts);

  // Get parent count and parent SHAs
  const parentLine = gitRunner(`git rev-parse ${commit}^@`, opts);
  const parents = parentLine
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Not a merge commit
  if (parents.length < 2) {
    return {
      mergeCommit,
      parent1: parents[0] || '',
      parent2: '',
      mergeTree: '',
      parent1Tree: '',
      theirsFiles: [],
      mergeChangedFiles: [],
      convergentFiles: [],
      isMerge: false,
      isOctopus: false,
    };
  }

  // Octopus merge (3+ parents) — skip, too complex for simple heuristic
  if (parents.length > 2) {
    return {
      mergeCommit,
      parent1: parents[0],
      parent2: parents[1],
      mergeTree: '',
      parent1Tree: '',
      theirsFiles: [],
      mergeChangedFiles: [],
      convergentFiles: [],
      isMerge: true,
      isOctopus: true,
    };
  }

  const parent1 = parents[0];
  const parent2 = parents[1];

  // Get tree objects for primary (deterministic) check
  const mergeTree = gitRunner(`git rev-parse ${commit}^{tree}`, opts);
  const parent1Tree = gitRunner(`git rev-parse ${parent1}^{tree}`, opts);

  // Get merge-base for accurate "theirs" diff
  const mergeBase = gitRunner(`git merge-base ${parent1} ${parent2}`, opts);

  // Files that "theirs" (parent2) introduced relative to the common ancestor
  const theirsRaw = gitRunner(`git diff --name-only ${mergeBase} ${parent2}`, opts);
  const theirsFiles = theirsRaw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Files changed between parent1 and the merge result
  const mergeChangedRaw = gitRunner(`git diff --name-only ${parent1} ${commit}`, opts);
  const mergeChangedFiles = mergeChangedRaw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Detect convergent files: theirs files NOT in merge diff but whose content
  // in the merge result matches theirs exactly. These are correctly incorporated
  // via a different path (e.g., already applied locally before the merge).
  const mergeChangedSet = new Set(mergeChangedFiles);
  const suspectFiles = theirsFiles.filter((f) => !mergeChangedSet.has(f));
  const convergentFiles: string[] = [];

  for (const file of suspectFiles) {
    try {
      // If merge result == parent2 for this file, the content is incorporated
      const diff = gitRunner(`git diff ${commit} ${parent2} -- "${file}"`, opts);
      if (diff === '') {
        convergentFiles.push(file);
      }
    } catch (err) {
      // File diff failures (e.g., binary, deleted on one side) are expected
      // edge cases — treat as not convergent but don't block the check.
      // The file will show up as "not incorporated" in the ratio, which is
      // the safe default (over-counting suspicious files, not under-counting).
      void err;
    }
  }

  return {
    mergeCommit,
    parent1,
    parent2,
    mergeTree,
    parent1Tree,
    theirsFiles,
    mergeChangedFiles,
    convergentFiles,
    isMerge: true,
    isOctopus: false,
  };
}

// -----------------------------------------------------------------------------
// Pure analysis — no I/O
// -----------------------------------------------------------------------------

const DEFAULT_THRESHOLD = 0.1;
const DEFAULT_MIN_THEIRS_FILES = 5;

function defaultAllowlistPath(): string {
  const __filename = fileURLToPath(import.meta.url);
  return join(dirname(__filename), 'merge-integrity-allowlist.json');
}

function isAllowlistEntry(value: unknown): value is AllowlistEntry {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sha === 'string' &&
    typeof record.reason === 'string' &&
    (record.recovered_in === undefined || typeof record.recovered_in === 'string')
  );
}

/**
 * Loads the default repo-level allowlist from
 * `scripts/lib/merge-integrity-allowlist.json`. Returns an empty array if the
 * file is missing or malformed (loader is fail-soft so a typo in the JSON
 * doesn't take down the pre-push hook).
 */
export function loadDefaultAllowlist(allowlistPath = defaultAllowlistPath()): AllowlistEntry[] {
  try {
    if (!existsSync(allowlistPath)) return [];
    const parsed = JSON.parse(readFileSync(allowlistPath, 'utf8')) as {
      exempted_merges?: unknown;
    };
    if (!Array.isArray(parsed.exempted_merges)) return [];
    const valid = parsed.exempted_merges.filter(isAllowlistEntry);
    const dropped = parsed.exempted_merges.length - valid.length;
    if (dropped > 0) {
      console.warn(
        `[merge-integrity] dropped ${dropped} malformed allowlist entr${dropped === 1 ? 'y' : 'ies'} from ${allowlistPath}`,
      );
    }
    return valid;
  } catch {
    return [];
  }
}

/**
 * Assesses merge integrity from pre-collected facts.
 * Pure function — no git I/O, fully testable with synthetic data.
 *
 * @param facts - Raw merge facts from `collectMergeFacts()`
 * @param options - Optional threshold configuration
 */
export function assessMergeIntegrity(
  facts: MergeFacts,
  options?: MergeIntegrityOptions,
): MergeIntegrityResult {
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD;
  const minTheirsFiles = options?.minTheirsFiles ?? DEFAULT_MIN_THEIRS_FILES;
  const allowlist = options?.allowlist ?? loadDefaultAllowlist();

  // Base result structure
  const base = {
    mergeCommit: facts.mergeCommit,
    parent1: facts.parent1,
    parent2: facts.parent2,
    theirsFileCount: facts.theirsFiles.length,
    mergeChangeCount: facts.mergeChangedFiles.length,
    incorporationRatio: 0,
  };

  // Allowlist short-circuit: known-OK historical merges pass without analysis.
  // Match by full SHA (case-insensitive) — short SHAs are too collision-prone.
  if (facts.isMerge && allowlist.length > 0) {
    const allowed = allowlist.find(
      (e) => e.sha.toLowerCase() === facts.mergeCommit.toLowerCase(),
    );
    if (allowed) {
      return {
        ...base,
        status: 'pass',
        reason: `Allowlisted: ${allowed.reason}`,
        incorporationRatio: 1,
      };
    }
  }

  /**
   * 'skip' is correct/expected for non-merge commits and octopus merges.
   * In fail-closed mode, skip is NOT a failure — it means the check
   * is not applicable to this commit type. This is explicitly documented
   * behavior, not a gap in coverage.
   * See: docs/plans/260412_git_safe_sync_consolidation.md § SF4
   */
  // Skip non-merge commits
  if (!facts.isMerge) {
    return {
      ...base,
      status: 'skip',
      reason: 'Not a merge commit (single parent)',
    };
  }

  // Skip octopus merges — too complex for this heuristic
  if (facts.isOctopus) {
    return {
      ...base,
      status: 'skip',
      reason: 'Octopus merge (3+ parents) — skipped',
    };
  }

  // PRIMARY CHECK (deterministic): tree equality
  // If merge tree == parent1 tree, the merge preserved nothing from parent2.
  // This catches 100% of "ours"-style merges with zero configuration.
  //
  // BUT: if theirs introduced no files relative to merge-base, then there was
  // nothing for the merge to incorporate in the first place — tree equality is
  // expected (no-op merge), not a drop. Flagging these would false-positive on
  // legitimate "merge already-up-to-date branch into self" commits.
  if (facts.mergeTree === facts.parent1Tree && facts.theirsFiles.length > 0) {
    // Convergence exception: if EVERY theirs file already has identical content
    // on our side (merge result == parent2 for each), tree equality is the
    // CORRECT outcome, not a drop. Canonical shape: two agents advance the same
    // submodule pointers to the same commits (one pushes the other's submodule
    // work), then merge — the gitlink-only "theirs" set is fully convergent and
    // the merge is a no-op by construction. (260611 incident: merge 4eedb846d,
    // theirs = {coding-agent-instructions, super-mcp} gitlinks, both identical.)
    const convergentSet = new Set(facts.convergentFiles ?? []);
    const nonConvergent = facts.theirsFiles.filter((f) => !convergentSet.has(f));
    if (nonConvergent.length === 0) {
      return {
        ...base,
        status: 'pass',
        reason:
          'No-op convergent merge — every incoming file already had identical content ' +
          'on our side (e.g. submodule pointers both sides advanced to the same commits).',
        incorporationRatio: 1,
      };
    }
    // Find sample of dropped files for diagnostics (genuinely non-convergent only)
    const suspiciousFiles = nonConvergent.slice(0, 10);
    return {
      ...base,
      status: 'fail',
      reason:
        'Merge tree is identical to parent 1 — all incoming changes were dropped. ' +
        'This is an "ours"-style merge that discards the entire other side.',
      incorporationRatio: 0,
      suspiciousFiles,
    };
  }

  // SECONDARY CHECK (heuristic): incorporation ratio
  // What fraction of "theirs" files appear in the merge diff or are convergent?
  if (facts.theirsFiles.length > 0) {
    const mergeChangedSet = new Set(facts.mergeChangedFiles);
    const convergentSet = new Set(facts.convergentFiles ?? []);

    // A file is "incorporated" if it appears in the merge diff OR if both sides
    // converged to the same content (convergent files)
    const incorporatedCount = facts.theirsFiles.filter(
      (f) => mergeChangedSet.has(f) || convergentSet.has(f),
    ).length;
    const incorporationRatio = incorporatedCount / facts.theirsFiles.length;

    base.incorporationRatio = incorporationRatio;

    // Only flag if there are enough "theirs" files to make the ratio meaningful
    if (facts.theirsFiles.length >= minTheirsFiles && incorporationRatio < threshold) {
      const droppedFiles = facts.theirsFiles
        .filter((f) => !mergeChangedSet.has(f) && !convergentSet.has(f))
        .slice(0, 10);

      // 0% incorporation is almost certainly a bad merge — FAIL, not WARN
      const isZeroIncorporation = incorporatedCount === 0;

      return {
        ...base,
        status: isZeroIncorporation ? 'fail' : 'warn',
        reason: isZeroIncorporation
          ? `Zero incorporation: 0/${facts.theirsFiles.length} incoming files appear in merge. ` +
            `This is almost certainly an "ours"-style merge that dropped all incoming changes.`
          : `Low incorporation ratio: ${(incorporationRatio * 100).toFixed(1)}% of incoming ` +
            `files (${incorporatedCount}/${facts.theirsFiles.length}) appear in merge. ` +
            `Threshold: ${(threshold * 100).toFixed(0)}%. This may indicate dropped changes.`,
        incorporationRatio,
        suspiciousFiles: droppedFiles,
      };
    }

    const convergentNote = convergentSet.size > 0
      ? ` (${convergentSet.size} convergent)`
      : '';

    return {
      ...base,
      status: 'pass',
      reason: `Incorporation ratio: ${(incorporationRatio * 100).toFixed(1)}%${convergentNote} — above threshold`,
      incorporationRatio,
    };
  }

  // No theirs files — nothing to check
  return {
    ...base,
    status: 'pass',
    reason: 'No incoming files from parent 2 — nothing to verify',
    incorporationRatio: 1,
  };
}

// -----------------------------------------------------------------------------
// Convenience: find merge commits in a range
// -----------------------------------------------------------------------------

/**
 * Lists merge commit SHAs in a given range.
 *
 * @param repoRoot - Absolute path to the repository root
 * @param range - Git range expression (e.g., "abc123..HEAD")
 * @param gitRunner - Injectable git command runner
 */
export function findMergeCommitsInRange(
  repoRoot: string,
  range: string,
  gitRunner: GitRunner = defaultGitRunner,
): string[] {
  const opts: ExecSyncOptions = { cwd: repoRoot };
  try {
    const output = gitRunner(`git rev-list --merges ${range}`, opts);
    return output
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    // No merge commits or invalid range
    return [];
  }
}
