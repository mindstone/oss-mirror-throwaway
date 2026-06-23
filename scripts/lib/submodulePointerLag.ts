/**
 * Classifier for git-safe-sync's pre-safety submodule pointer-lag auto-align
 * phase (Stage 6, docs/plans/260611_prepush-gate-speedup/PLAN.md).
 *
 * THE FRICTION CLASS: after a MANUAL merge commit (conflict resolution), the
 * superproject records new submodule pins but the submodule checkouts still sit
 * at the old SHAs. `git status --porcelain` then shows ` M <sub>` and the sync's
 * safety check aborts "Superproject has uncommitted changes" until a human runs
 * `git submodule update --init`. Worse, the old abort copy said "Commit your
 * changes" — for a lagging gitlink that instruction creates a PIN-REGRESSION
 * commit (rolls the submodule pointer backward on dev).
 *
 * THE PREDICATE (never-lose-work; when in doubt, abort): a dirty entry is
 * auto-alignable iff ALL of:
 *   (a) it is a gitlink-mode (160000) submodule entry with NO staged pointer
 *       change (pure checkout-vs-committed-pin lag);
 *   (b) the submodule worktree is clean (`git -C <sub> status --porcelain`
 *       empty, untracked included — same notion as the safety check);
 *   (c) the checked-out HEAD is an ancestor of the committed pin (strictly
 *       behind or equal — moving it forward is information-preserving);
 *   (d) the committed pin is reachable from the submodule's tracked remote
 *       branch (reuses submodulePinAncestry's classifier; a local/unpushed/
 *       diverged pin must NOT be normalized by an auto-align);
 *   (e) the submodule HEAD is detached or on its expected branch (whose tip is
 *       the lagging checkout, so nothing beyond the pin exists on it);
 *   (f) no in-progress merge/rebase/cherry-pick in the submodule.
 *
 * Everything is driven through the injected `RunGit` seam so the decision table
 * is unit-testable without a real repository.
 */
import {
  classifyPin,
  readSubmoduleEntries,
  type RunGit,
  type SubmoduleEntry,
} from './submodulePinAncestry';

const SHA_RE = /^[0-9a-f]{40}$/;

export type DirtyEntryKind =
  /** Provably-safe pure pointer-lag — git-safe-sync may auto-align it. */
  | 'alignable-pointer-lag'
  /** Submodule-shaped but NOT provably safe — abort, with targeted copy. */
  | 'submodule-blocked'
  /**
   * Untracked file (`??`). Inert to merge/pull/push EXCEPT a same-path
   * collision with an incoming change; git-safe-sync tolerates the
   * non-colliding case (the collision check lives in the caller, which knows
   * the incoming-merge paths).
   */
  | 'untracked'
  /** Genuine tracked uncommitted change — abort with the classic copy. */
  | 'other';

export interface DirtyEntryAssessment {
  readonly path: string;
  readonly kind: DirtyEntryKind;
  /** Human line for the safety-check error list. */
  readonly reason: string;
  /** Recovery command/guidance for the safety-check recovery list. */
  readonly recovery: string;
  /** Short from/to SHAs for the loud align note (alignable entries only). */
  readonly fromSha?: string;
  readonly toSha?: string;
  /** Branch the submodule was on (undefined = detached) — for the align note. */
  readonly wasOnBranch?: string;
}

export interface DirtySuperprojectAssessment {
  /**
   * True iff there is at least one dirty entry and EVERY dirty entry is an
   * alignable pointer-lag. Empty status is deliberately NOT vacuously true.
   */
  readonly allAlignable: boolean;
  readonly entries: readonly DirtyEntryAssessment[];
}

/** One `git status --porcelain` line, split into status code + path. */
export interface PorcelainEntry {
  readonly xy: string;
  readonly path: string;
}

/**
 * Parses `git status --porcelain` (v1) output. Rename entries keep their full
 * `old -> new` tail as the path — they can never match a submodule path, so
 * they classify as 'other' (abort), which is the safe disposition.
 */
export function parsePorcelain(output: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = [];
  for (const line of output.split('\n')) {
    if (line.length < 4) continue; // XY + space + at least 1 path char
    const xy = line.slice(0, 2);
    let path = line.slice(3);
    // git quotes paths with special characters; strip the quotes so a plain
    // submodule path still matches (escaped contents won't match — safe).
    if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) {
      path = path.slice(1, -1);
    }
    entries.push({ xy, path });
  }
  return entries;
}

/** Probe results for one gitlink candidate — the pure predicate's input. */
export interface SubmoduleLagProbes {
  /** Index entry for the path is gitlink mode 160000. */
  readonly indexGitlink: boolean;
  /** Index gitlink differs from HEAD gitlink (a STAGED pointer change). */
  readonly stagedPointerChange: boolean;
  /** The pin recorded by HEAD (the committed pin). */
  readonly committedPin: string | null;
  /** The submodule's checked-out HEAD. */
  readonly checkoutHead: string | null;
  /** `git -C <sub> status --porcelain` empty (untracked included). */
  readonly worktreeClean: boolean;
  /** In-progress operation in the submodule, if any. */
  readonly inProgressOp: 'merge' | 'rebase' | 'cherry-pick' | null;
  /** Current branch name; '' = detached HEAD. */
  readonly currentBranch: string;
  /** Tracked branch from .gitmodules (default 'main'). */
  readonly expectedBranch: string;
  /** checkoutHead is an ancestor of committedPin. null = probe failed. */
  readonly headIsAncestorOfPin: boolean | null;
  /** committedPin is an ancestor of checkoutHead (the AHEAD/backward shape). */
  readonly pinIsAncestorOfHead: boolean | null;
  /** submodulePinAncestry verdict: pin reachable from origin/<branch>? */
  readonly pinOnTrackedRemote: 'ok' | 'fail' | 'skip';
  readonly pinRemoteReason?: string;
}

function blocked(path: string, reason: string, recovery: string): DirtyEntryAssessment {
  return { path, kind: 'submodule-blocked', reason, recovery };
}

/**
 * The pure never-lose-work predicate: decides one submodule-shaped dirty
 * entry's disposition from its probe results. Fail-closed on every unknown.
 */
export function evaluateSubmoduleLag(
  path: string,
  p: SubmoduleLagProbes,
): DirtyEntryAssessment {
  if (!p.indexGitlink) {
    return blocked(
      path,
      'is a submodule in .gitmodules but the dirty entry is not a gitlink-mode pointer change',
      `inspect manually: git diff -- ${path} (see coding-agent-instructions/docs/GIT_COMMIT_CHANGES.md)`,
    );
  }
  if (p.stagedPointerChange) {
    return blocked(
      path,
      'has a STAGED submodule pointer change (index differs from HEAD) — not pure checkout lag',
      `review the staged pin (git diff --cached -- ${path}); commit it deliberately or unstage it (git restore --staged ${path})`,
    );
  }
  if (!p.worktreeClean) {
    return blocked(
      path,
      'submodule worktree has uncommitted changes',
      `commit or stash inside the submodule first: cd ${path} && git status (see coding-agent-instructions/docs/GIT_COMMIT_CHANGES.md)`,
    );
  }
  if (p.inProgressOp) {
    return blocked(
      path,
      `submodule has an in-progress ${p.inProgressOp}`,
      `finish or abort the ${p.inProgressOp} inside ${path} first`,
    );
  }
  if (!p.committedPin || !p.checkoutHead) {
    return blocked(
      path,
      'could not read the committed pin / submodule checkout HEAD',
      `inspect manually: git ls-tree HEAD -- ${path} && git -C ${path} rev-parse HEAD`,
    );
  }
  if (p.checkoutHead === p.committedPin) {
    return blocked(
      path,
      'checkout already equals the committed pin yet the path reports dirty — unexpected state',
      `inspect manually: git status && git diff -- ${path}`,
    );
  }
  if (p.headIsAncestorOfPin !== true) {
    if (p.pinIsAncestorOfHead === true) {
      // Checkout is AHEAD of the pin (forgot-to-commit-the-bump, or a pin
      // rollback merge). Aligning would move the checkout BACKWARD over real
      // commits — and "commit your changes" is correct here (it's the normal
      // pointer-advance flow), unlike the lag case.
      return blocked(
        path,
        'submodule checkout is AHEAD of the committed pin (the normal advance shape, not lag)',
        `do NOT run submodule update (it would move the checkout backward); commit the pointer bump (git add ${path} && git commit) — or, if the pin rollback was deliberate, git -C ${path} checkout <pinned-sha>`,
      );
    }
    if (p.headIsAncestorOfPin === null || p.pinIsAncestorOfHead === null) {
      return blocked(
        path,
        'could not determine checkout/pin ancestry (merge-base probe failed)',
        `inspect manually inside ${path}; do NOT blind-run submodule update`,
      );
    }
    return blocked(
      path,
      'submodule checkout has DIVERGED from the committed pin (neither is an ancestor of the other)',
      `resolve manually inside ${path} (see coding-agent-instructions/docs/GIT_COMMIT_CHANGES.md); do NOT blind-run submodule update`,
    );
  }
  if (p.currentBranch && p.currentBranch !== p.expectedBranch) {
    return blocked(
      path,
      `submodule is on unexpected branch '${p.currentBranch}' (expected '${p.expectedBranch}' or detached HEAD)`,
      `inspect the branch's purpose, then align deliberately: git -C ${path} checkout ${p.expectedBranch} (or leave it and resolve the pointer manually)`,
    );
  }
  if (p.pinOnTrackedRemote !== 'ok') {
    // GPT F2: aligning onto a local/unpushed/diverged pin would normalize a
    // pin the rest of the pipeline could then ship — abort instead.
    return blocked(
      path,
      `committed pin is not verifiably reachable from the tracked remote branch${p.pinRemoteReason ? ` (${p.pinRemoteReason})` : ''}`,
      `land the pin on the submodule's tracked branch first (push it), then re-run the sync`,
    );
  }
  return {
    path,
    kind: 'alignable-pointer-lag',
    reason: 'submodule checkout lags the committed pin (pure pointer-lag, provably safe to align)',
    recovery: `git submodule update --init -- ${path}   # safe for pure pointer-lag (or: git submodule update --init --recursive)`,
    fromSha: p.checkoutHead.slice(0, 10),
    toSha: p.committedPin.slice(0, 10),
    ...(p.currentBranch ? { wasOnBranch: p.currentBranch } : {}),
  };
}

/** Reads the HEAD gitlink for a path (mode 160000), or null. */
function readHeadGitlink(runGit: RunGit, path: string): string | null {
  const r = runGit(['ls-tree', 'HEAD', '--', path]);
  if (r.status !== 0 || !r.stdout.trim()) return null;
  const [mode, type, sha] = r.stdout.trim().split(/\s+/);
  return mode === '160000' && type === 'commit' && SHA_RE.test(sha ?? '') ? sha : null;
}

/** Reads the INDEX gitlink for a path, or null. */
function readIndexGitlinkSha(runGit: RunGit, path: string): string | null {
  const r = runGit(['rev-parse', `:${path}`]);
  const sha = r.stdout.trim();
  return r.status === 0 && SHA_RE.test(sha) ? sha : null;
}

/** Gathers all probes for one submodule-shaped dirty entry. */
export function probeSubmoduleLag(runGit: RunGit, entry: SubmoduleEntry): SubmoduleLagProbes {
  const { path } = entry;

  const lsFiles = runGit(['ls-files', '-s', '--', path]);
  const indexGitlink =
    lsFiles.status === 0 && lsFiles.stdout.trim().startsWith('160000 ');

  const indexPin = readIndexGitlinkSha(runGit, path);
  const committedPin = readHeadGitlink(runGit, path);
  const stagedPointerChange =
    indexPin !== null && committedPin !== null && indexPin !== committedPin;

  const headRes = runGit(['-C', path, 'rev-parse', 'HEAD']);
  const checkoutHead =
    headRes.status === 0 && SHA_RE.test(headRes.stdout.trim()) ? headRes.stdout.trim() : null;

  const statusRes = runGit(['-C', path, 'status', '--porcelain']);
  // Fail-closed: an unreadable status counts as dirty.
  const worktreeClean = statusRes.status === 0 && statusRes.stdout.trim().length === 0;

  let inProgressOp: SubmoduleLagProbes['inProgressOp'] = null;
  const opRefs: Array<[string, SubmoduleLagProbes['inProgressOp']]> = [
    ['MERGE_HEAD', 'merge'],
    ['REBASE_HEAD', 'rebase'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ];
  for (const [ref, op] of opRefs) {
    if (runGit(['-C', path, 'rev-parse', '-q', '--verify', ref]).status === 0) {
      inProgressOp = op;
      break;
    }
  }

  const branchRes = runGit(['-C', path, 'branch', '--show-current']);
  const currentBranch = branchRes.status === 0 ? branchRes.stdout.trim() : '';

  const ancestor = (a: string, b: string): boolean | null => {
    const r = runGit(['-C', path, 'merge-base', '--is-ancestor', a, b]);
    if (r.status === 0) return true;
    if (r.status === 1) return false;
    return null;
  };
  const headIsAncestorOfPin =
    checkoutHead && committedPin ? ancestor(checkoutHead, committedPin) : null;
  const pinIsAncestorOfHead =
    checkoutHead && committedPin ? ancestor(committedPin, checkoutHead) : null;

  // Remote-reachability of the pin (GPT F2) — reuse the shared classifier.
  // Offline (fetch:false): git-safe-sync's own Step-2 fetch ran moments ago,
  // and reachability from origin/<branch> is monotonic, so a fresh fetch here
  // would add round-trips without safety value. 'skip' (unverifiable) is
  // treated as NOT alignable by the predicate — fail-closed.
  const pin = classifyPin(runGit, entry, { fetch: false });

  return {
    indexGitlink,
    stagedPointerChange,
    committedPin,
    checkoutHead,
    worktreeClean,
    inProgressOp,
    currentBranch,
    expectedBranch: entry.branch,
    headIsAncestorOfPin,
    pinIsAncestorOfHead,
    pinOnTrackedRemote: pin.status,
    ...(pin.reason ? { pinRemoteReason: pin.reason } : {}),
  };
}

/**
 * Classifies every dirty superproject entry. Runs `git status --porcelain`
 * itself via the injected runner so the caller and the classifier can't see
 * different snapshots of the working tree.
 */
export function assessDirtySuperproject(runGit: RunGit): DirtySuperprojectAssessment {
  const status = runGit(['status', '--porcelain']);
  if (status.status !== 0) {
    return {
      allAlignable: false,
      entries: [
        {
          path: '(unknown)',
          kind: 'other',
          reason: `git status failed: ${status.stderr.trim() || '<empty>'}`,
          recovery: 'fix the repository state, then re-run',
        },
      ],
    };
  }

  const porcelain = parsePorcelain(status.stdout);
  if (porcelain.length === 0) {
    // Not dirty — never report vacuous alignability.
    return { allAlignable: false, entries: [] };
  }

  const submodulesByPath = new Map(readSubmoduleEntries(runGit).map((e) => [e.path, e]));

  const entries: DirtyEntryAssessment[] = porcelain.map((entry) => {
    const sub = submodulesByPath.get(entry.path);
    if (!sub) {
      if (entry.xy === '??') {
        return {
          path: entry.path,
          kind: 'untracked' as const,
          reason: 'untracked file',
          recovery:
            'Untracked — safe-sync tolerates non-colliding untracked files; commit or gitignore it if it should persist',
        };
      }
      return {
        path: entry.path,
        kind: 'other' as const,
        reason: `uncommitted change (${entry.xy.trim() || '??'})`,
        recovery: 'Commit your changes, or use --autostash to stash them',
      };
    }
    return evaluateSubmoduleLag(entry.path, probeSubmoduleLag(runGit, sub));
  });

  return {
    allAlignable: entries.length > 0 && entries.every((e) => e.kind === 'alignable-pointer-lag'),
    entries,
  };
}
