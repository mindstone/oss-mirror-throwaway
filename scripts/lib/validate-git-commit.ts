import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Assert that `repoRoot` is a git working tree before running discovery-sensitive
 * git commands. Call this before any `git` subprocess that uses `cwd: repoRoot`
 * so inherited `GIT_DIR` / parent-repo discovery cannot mask a non-repo path.
 */
export function assertGitRepoPresent(repoRoot: string): void {
  if (!fs.existsSync(path.join(repoRoot, '.git'))) {
    throw new Error(`repoRoot ${repoRoot} is not a git repository`);
  }
}

export type RunGitCatFile = (repoRoot: string, commitHash: string) => void;

function defaultRunGitCatFile(repoRoot: string, commitHash: string): void {
  try {
    // git-exec-allow: cat-file validation ignores output and needs only exit status
    execFileSync('git', ['cat-file', '-e', `${commitHash}^{commit}`], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`git executable not found while validating commit ${commitHash}`, { cause: error });
    }
    throw new Error(
      `auto_committed outcome references commit ${commitHash} which does not exist in ${repoRoot}`,
      { cause: error },
    );
  }
}

/**
 * Validate that `commitHash` resolves to a commit object in `repoRoot`.
 *
 * Checks for a local `.git` entry first so git discovery never runs against a
 * plain directory (see postmortem 260607_check_reporoot_for_git_before_invoking).
 */
export function validateGitCommitExists(
  repoRoot: string,
  commitHash: string,
  runGitCatFile: RunGitCatFile = defaultRunGitCatFile,
): void {
  assertGitRepoPresent(repoRoot);
  runGitCatFile(repoRoot, commitHash);
}
