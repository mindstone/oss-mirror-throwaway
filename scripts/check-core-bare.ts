/**
 * Guard: fail loudly if this checkout's EFFECTIVE `core.bare` is true.
 *
 * Why this exists
 * ---------------
 * The shared `.git/config` has `extensions.worktreeConfig = true`. Under that
 * mode `core.bare` is a per-worktree setting: it belongs in each worktree's
 * `config.worktree`, NOT the shared `.git/config`. A plain (non-`--worktree`)
 * `git config core.bare true` therefore writes to the SHARED config and flips
 * EVERY worktree that lacks its own `config.worktree` into "bare" — which makes
 * git refuse work-tree operations ("fatal: this operation must be run in a work
 * tree") for commits, diffs, and validate:fast across the whole machine.
 *
 * The observed writer is a leaked git test-fixture (one that creates a bare repo
 * / sets core.bare without fully isolating its cwd/GIT_DIR). It's intermittent,
 * so rather than rely on catching it, we (a) give every worktree a protective
 * `config.worktree` and (b) run this guard so the corruption surfaces as an
 * instant, clearly-explained failure instead of a cryptic mid-pipeline break.
 *
 * Diagnosis history: docs/plans/260607_log-parity-ci-submodule/PLAN.md (2026-06-07)
 * and docs/plans/260607_oss-b4-api-config-self-config/PLAN.md.
 *
 * Behaviour:
 *   - `git rev-parse --is-inside-work-tree` == "true"  -> OK (exit 0)
 *   - == "false" (this repo is never legitimately bare) -> FAIL (exit 1, banner)
 *   - git unavailable / not a git repo                  -> SKIP (exit 0; don't
 *     block non-git contexts)
 */
import { pathToFileURL } from 'node:url';

import { gitCapture } from './lib/git-exec.js';

export type GitRunner = (args: readonly string[]) => { ok: boolean; stdout: string };

export const realGitRunner: GitRunner = (args) => {
  // Route through the repo-wide git capture helper (maxBuffer policy; enforced by
  // validate:git-exec-maxbuffer). gitCapture throws on non-zero exit / spawn error,
  // which we map to `ok: false` (e.g. "not a git repo").
  try {
    return { ok: true, stdout: gitCapture([...args]).trim() };
  } catch {
    return { ok: false, stdout: '' };
  }
};

export type CoreBareStatus = 'healthy' | 'corrupted' | 'skipped';

export function evaluateCoreBare(runGit: GitRunner): { status: CoreBareStatus; detail: string } {
  const res = runGit(['rev-parse', '--is-inside-work-tree']);
  if (!res.ok) {
    return { status: 'skipped', detail: 'not a git work context (git unavailable or not a repo)' };
  }
  if (res.stdout === 'true') {
    return { status: 'healthy', detail: 'work tree healthy (core.bare effectively false)' };
  }
  return {
    status: 'corrupted',
    detail: `git rev-parse --is-inside-work-tree => "${res.stdout || '(empty)'}" — core.bare is effectively true`,
  };
}

const FAILURE_BANNER = (detail: string): string =>
  [
    '',
    '════════════════════════════════════════════════════════════════',
    '  check-core-bare FAILED',
    `  ${detail}`,
    '',
    '  Effective core.bare is true: git refuses work-tree operations',
    '  (commit / diff / validate) in this checkout AND every sibling',
    '  worktree that shares this .git.',
    '',
    '  Root cause: a leaked git test-fixture writes core.bare=true to the',
    '  SHARED .git/config; under extensions.worktreeConfig=true a non-',
    '  `--worktree` write lands in the shared file and breaks all worktrees.',
    '',
    '  Fix:',
    '    git config core.bare false              # repair shared config',
    '    git config --worktree core.bare false   # protect this worktree',
    '════════════════════════════════════════════════════════════════',
    '',
  ].join('\n');

export function main(runGit: GitRunner = realGitRunner): number {
  const { status, detail } = evaluateCoreBare(runGit);
  if (status === 'corrupted') {
    process.stderr.write(FAILURE_BANNER(detail) + '\n');
    return 1;
  }
  process.stdout.write(`[check-core-bare] ${status === 'skipped' ? 'SKIP' : 'OK'}: ${detail}\n`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exit(main());
}
