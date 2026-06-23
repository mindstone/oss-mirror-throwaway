/**
 * Single source of truth for the "submodule pin orphan" invariant: a superproject
 * submodule pin must be reachable from that submodule's configured tracked branch
 * (`branch` in `.gitmodules`, default `main`). A pin that has DIVERGED from the
 * tracked branch — or is merely AHEAD of it (a local/feature commit not yet landed
 * on the branch) — gets silently dropped on the next routine pointer re-align. That
 * is exactly how `bulk_export` + the materialization realpath defense were lost
 * (see docs/postmortems/260603_supermcp_bulk_export_submodule_pin_orphan_postmortem.md).
 *
 * Two consumers share this logic so the two safety surfaces can't drift apart:
 *   - scripts/check-submodule-pin-ancestry.ts  — the OFFLINE validate:fast gate
 *     (runs in the pre-push hook; skips when a submodule/ref isn't present here).
 *   - scripts/git-safe-sync.ts                  — the ONLINE by-construction check
 *     (fetches the tracked branch then HARD-FAILS before pushing the superproject).
 */
import { spawnSync } from 'node:child_process';

export const DEFAULT_TRACKED_BRANCH = 'main';
const SHA_RE = /^[0-9a-f]{40}$/;

export interface GitResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `git <args>`, returning a structured result. */
export type RunGit = (args: readonly string[]) => GitResult;

export interface SubmoduleEntry {
  readonly name: string;
  readonly path: string;
  readonly branch: string;
}

export type PinStatus = 'ok' | 'fail' | 'skip';

export interface PinOutcome {
  readonly path: string;
  readonly branch: string;
  /** The recorded gitlink SHA, or null when it could not be read. */
  readonly sha: string | null;
  readonly status: PinStatus;
  readonly reason?: string;
}

export interface CheckOptions {
  /**
   * When true, best-effort `git fetch origin <branch>` per submodule before the
   * ancestry check so the tracked-branch ref is fresh (online consumers, e.g.
   * git-safe-sync). When false/omitted, the check is fully offline and SKIPs if
   * the ref isn't present (validate:fast gate). A fetch failure never throws —
   * the ref-presence check that follows decides OK/SKIP.
   */
  readonly fetch?: boolean;
}

/**
 * Builds a `RunGit` that runs git from `repoRoot` with the hook-contaminating
 * repo-location `GIT_*` env vars stripped (GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE/
 * GIT_COMMON_DIR/GIT_OBJECT_DIRECTORY/GIT_ALTERNATE_OBJECT_DIRECTORIES/GIT_PREFIX).
 * Inside a git hook (e.g. pre-push) git sets these for the SUPERPROJECT; left in
 * place they would override `git -C <submodule> ...` so it resolves the
 * superproject repo instead of the submodule, producing false results. (Other
 * GIT_* vars like GIT_TRACE/GIT_SSH are intentionally left alone.) Stripping makes
 * behaviour identical inside and outside hooks.
 */
export function makeRunGit(repoRoot: string): RunGit {
  return (args) => {
    const env = { ...process.env };
    delete env.GIT_DIR;
    delete env.GIT_INDEX_FILE;
    delete env.GIT_WORK_TREE;
    delete env.GIT_COMMON_DIR;
    delete env.GIT_OBJECT_DIRECTORY;
    delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    delete env.GIT_PREFIX;
    // git-exec-allow: submodule ancestry runner preserves status and stderr for safety gate
    const r = spawnSync('git', [...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

/** Parse `.gitmodules` for each submodule's path + tracked branch (default `main`). */
export function readSubmoduleEntries(runGit: RunGit): SubmoduleEntry[] {
  const res = runGit(['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$']);
  if (res.status !== 0) {
    return [];
  }
  const entries: SubmoduleEntry[] = [];
  for (const line of res.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^submodule\.(.+)\.path\s+(.+)$/);
    if (!match) continue;
    const name = match[1];
    const path = match[2].trim();
    const branchRes = runGit(['config', '--file', '.gitmodules', '--get', `submodule.${name}.branch`]);
    const branch = branchRes.status === 0 && branchRes.stdout.trim().length > 0
      ? branchRes.stdout.trim()
      : DEFAULT_TRACKED_BRANCH;
    entries.push({ name, path, branch });
  }
  return entries;
}

/** The SHA the superproject records for this submodule (staged index, then HEAD). */
export function readRecordedGitlink(runGit: RunGit, path: string): string | null {
  const indexResult = runGit(['rev-parse', `:${path}`]);
  if (indexResult.status === 0 && SHA_RE.test(indexResult.stdout.trim())) {
    return indexResult.stdout.trim();
  }
  const treeResult = runGit(['ls-tree', 'HEAD', path]);
  if (treeResult.status === 0 && treeResult.stdout.trim().length > 0) {
    const [mode, type, sha] = treeResult.stdout.trim().split(/\s+/);
    if (mode === '160000' && type === 'commit' && SHA_RE.test(sha ?? '')) {
      return sha;
    }
  }
  return null;
}

/** Classify one submodule pin against its tracked branch. */
export function classifyPin(runGit: RunGit, entry: SubmoduleEntry, opts: CheckOptions = {}): PinOutcome {
  const { path, branch } = entry;
  const ref = `origin/${branch}`;
  const sha = readRecordedGitlink(runGit, path);
  if (sha === null) {
    return { path, branch, sha: null, status: 'fail',
      reason: `unable to read superproject gitlink for "${path}" (not a submodule in index/HEAD?)` };
  }
  const base = { path, branch, sha };

  // In online mode, freshen the tracked-branch ref so the ancestry check runs
  // against current data. Track whether the fetch actually succeeded: if it did
  // NOT, a "not on branch" result below is downgraded to SKIP rather than FAIL —
  // otherwise a transient fetch blip against a present-but-stale local ref could
  // false-fail a commit that WAS just landed on the branch (e.g. right after
  // git-safe-sync auto-pushed it). Fail-open on unverifiable, strict when verified.
  const fetchAttempted = opts.fetch === true;
  const fetchOk = fetchAttempted
    ? runGit(['-C', path, 'fetch', '--quiet', 'origin', branch]).status === 0
    : true;

  // Unverifiable: submodule clone not present in this environment.
  if (runGit(['-C', path, 'cat-file', '-e', `${sha}^{commit}`]).status !== 0) {
    return { ...base, status: 'skip',
      reason: `"${path}" not initialized here (pinned commit ${sha.slice(0, 10)} absent) — cannot verify. ` +
        `Run: git submodule update --init ${path} for coverage in this environment.` };
  }
  // Unverifiable: tracked-branch ref not present in this environment.
  if (runGit(['-C', path, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status !== 0) {
    return { ...base, status: 'skip',
      reason: `local ref "${ref}" not present for "${path}" — cannot verify ancestry. ` +
        `Run: git -C ${path} fetch origin ${branch} (or use git-safe-sync) for coverage here.` };
  }
  // Verifiable — STRICT: the pin must be reachable from the tracked branch.
  const pinOnBranch = runGit(['-C', path, 'merge-base', '--is-ancestor', sha, ref]);
  if (pinOnBranch.status === 0) {
    return { ...base, status: 'ok' };
  }
  if (pinOnBranch.status !== 1) {
    return { ...base, status: 'fail',
      reason: `git merge-base --is-ancestor failed for "${path}": ${pinOnBranch.stderr.trim() || '<empty>'}` };
  }
  // Not on the branch. If we asked for a fresh ref but the fetch FAILED, we can't
  // trust the local (possibly stale) ref to declare an orphan — downgrade to SKIP
  // so a transient network failure never false-fails a legitimately-landed pin.
  if (fetchAttempted && !fetchOk) {
    return { ...base, status: 'skip',
      reason: `could not fetch "${ref}" for "${path}" to verify freshly; pin ${sha.slice(0, 10)} is not on the ` +
        `local (possibly stale) ref. Re-run after restoring connectivity — if it still fails, it's a genuine orphan.` };
  }
  // Distinguish ahead vs diverged for the message only — both are orphan-prone and both FAIL.
  const branchOnPin = runGit(['-C', path, 'merge-base', '--is-ancestor', ref, sha]);
  const shape = branchOnPin.status === 0
    ? `is AHEAD of "${ref}" (a local commit not yet landed on the tracked branch — push it to ${branch} first; git-safe-sync does this before the superproject push)`
    : `has DIVERGED from "${ref}" (a feature/abandoned lineage — land the work on ${branch}, or move it to a Rebel-owned layer)`;
  return { ...base, status: 'fail',
    reason: `pinned commit ${sha} ${shape}, then re-pin. A pushed superproject pin not on "${ref}" is the ` +
      `submodule-pin-orphan class: it will be silently dropped on the next pointer re-align.` };
}

/** Classify every `.gitmodules` submodule pin. */
export function checkSubmodulePins(runGit: RunGit, opts: CheckOptions = {}): PinOutcome[] {
  return readSubmoduleEntries(runGit).map((entry) => classifyPin(runGit, entry, opts));
}
