import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gitIsolatedEnv } from '../../lib/git-env-isolation.ts';
import type { SessionOutcome } from '../session-manager.ts';
import type { IssueRow } from '../state.ts';
import { verifyOutcome } from '../verifier.ts';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-'));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    // gitIsolatedEnv strips GIT_DIR/GIT_WORK_TREE/etc. so this fixture's git
    // commands stay pinned to `cwd` (the tempdir) and never mutate the real
    // repo — even if run inside the pre-push hook. Belt-and-braces alongside
    // the global scrub in vitest.setup.ts. See scripts/lib/git-env-isolation.ts.
    env: {
      ...gitIsolatedEnv(),
      GIT_AUTHOR_NAME: 'Verifier Test',
      GIT_AUTHOR_EMAIL: 'verifier@test',
      GIT_COMMITTER_NAME: 'Verifier Test',
      GIT_COMMITTER_EMAIL: 'verifier@test',
    },
  }).trim();
}

function makeWorktree(): { worktree: string; commitHash: string } {
  const worktree = tmpDir();
  git(worktree, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(worktree, 'baseline.txt'), 'baseline\n');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-q', '-m', 'baseline');
  // Second commit so HEAD has a parent — git diff-tree only emits changed
  // files for non-root commits, and the verifier's files_changed_match uses
  // diff-tree to compute the actual file set.
  fs.writeFileSync(path.join(worktree, 'src.ts'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(worktree, 'README.md'), '# test\n');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-q', '-m', 'feat');
  const commitHash = git(worktree, 'rev-parse', 'HEAD');
  return { worktree, commitHash };
}

function makeIssue(): IssueRow {
  const now = new Date().toISOString();
  return {
    sentry_id: 'SENTRY-VERIFY',
    sentry_url: 'https://sentry.io/issues/SENTRY-VERIFY',
    title: 'test',
    error_type: 'exception',
    is_user_reported: false,
    occurrences: 1,
    users: 1,
    status: 'in_progress',
    dispatch_count: 1,
    max_retries: 2,
    confidence: null,
    outcome: null,
    last_error: null,
    commit_hash: null,
    plan_file: null,
    linear_issue_id: null,
    tmux_session: null,
    worktree_slot: 0,
    user_description: null,
    pending_actions: null,
    verification_status: null,
    verification_details: null,
    branch_name: null,
    pr_url: null,
    pushed_at: null,
    created_at: now,
    updated_at: now,
    dispatched_at: now,
    completed_at: null,
  };
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('verifyOutcome', () => {
  it('returns skipped when mode=disabled', () => {
    const result = verifyOutcome(makeIssue(), { outcome: 'auto_committed', commit_hash: 'deadbeef', files_changed: ['x'] }, {
      worktreePath: '',
      mode: 'disabled',
      pushMode: 'disabled',
      repoRoot: '',
    });
    expect(result.status).toBe('skipped');
    expect(result.details).toEqual([]);
  });

  it('returns skipped for failed/not_a_bug outcomes', () => {
    const result = verifyOutcome(makeIssue(), { outcome: 'failed', error: 'x' }, {
      worktreePath: '',
      mode: 'enforce',
      pushMode: 'disabled',
      repoRoot: '',
    });
    expect(result.status).toBe('skipped');
  });

  describe('plan_created', () => {
    it('passes when plan.md exists in the worktree', () => {
      const { worktree } = makeWorktree();
      fs.writeFileSync(path.join(worktree, 'plan.md'), '# plan\n');
      const result = verifyOutcome(
        makeIssue(),
        { outcome: 'plan_created', plan_file: 'plan.md' },
        { worktreePath: worktree, mode: 'enforce', pushMode: 'disabled', repoRoot: worktree },
      );
      expect(result.status).toBe('pass');
      const detail = result.details.find((d) => d.check === 'plan_file_exists');
      expect(detail?.passed).toBe(true);
    });

    it('hard_mismatch when plan.md is missing', () => {
      const { worktree } = makeWorktree();
      const result = verifyOutcome(
        makeIssue(),
        { outcome: 'plan_created', plan_file: 'plan.md' },
        { worktreePath: worktree, mode: 'enforce', pushMode: 'disabled', repoRoot: worktree },
      );
      expect(result.status).toBe('hard_mismatch');
      const detail = result.details.find((d) => d.check === 'plan_file_exists');
      expect(detail?.passed).toBe(false);
      expect(detail?.severity).toBe('hard');
    });
  });

  describe('auto_committed', () => {
    it('passes when commit + files_changed match', () => {
      const { worktree, commitHash } = makeWorktree();
      const result = verifyOutcome(
        makeIssue(),
        {
          outcome: 'auto_committed',
          commit_hash: commitHash,
          files_changed: ['src.ts', 'README.md'],
        },
        { worktreePath: worktree, mode: 'enforce', pushMode: 'disabled', repoRoot: worktree },
      );
      expect(result.status).toBe('pass');
    });

    it('hard_mismatch when commit_hash does not exist', () => {
      const { worktree } = makeWorktree();
      const result = verifyOutcome(
        makeIssue(),
        {
          outcome: 'auto_committed',
          commit_hash: '0000000000000000000000000000000000000000',
          files_changed: ['src.ts'],
        },
        { worktreePath: worktree, mode: 'enforce', pushMode: 'disabled', repoRoot: worktree },
      );
      expect(result.status).toBe('hard_mismatch');
      expect(result.details.find((d) => d.check === 'commit_present')?.passed).toBe(false);
    });

    it('soft_mismatch when files_changed is empty', () => {
      const { worktree, commitHash } = makeWorktree();
      const result = verifyOutcome(
        makeIssue(),
        { outcome: 'auto_committed', commit_hash: commitHash, files_changed: [] },
        { worktreePath: worktree, mode: 'enforce', pushMode: 'disabled', repoRoot: worktree },
      );
      expect(result.status).toBe('soft_mismatch');
      expect(result.details.find((d) => d.check === 'files_changed_non_empty')?.passed).toBe(false);
    });

    it('soft_mismatch when files_changed jaccard falls below threshold', () => {
      const { worktree, commitHash } = makeWorktree();
      const result = verifyOutcome(
        makeIssue(),
        {
          outcome: 'auto_committed',
          commit_hash: commitHash,
          // worktree commit contains src.ts + README.md; claim totally different files
          files_changed: ['totally/different.ts', 'unrelated.md'],
        },
        { worktreePath: worktree, mode: 'enforce', pushMode: 'disabled', repoRoot: worktree },
      );
      expect(result.status).toBe('soft_mismatch');
      const match = result.details.find((d) => d.check === 'files_changed_match');
      expect(match?.passed).toBe(false);
      expect(match?.severity).toBe('soft');
    });
  });

  describe('branch_pushed_to_origin', () => {
    it('does not run when pushMode=disabled', () => {
      const { worktree, commitHash } = makeWorktree();
      const result = verifyOutcome(
        makeIssue(),
        {
          outcome: 'auto_committed',
          commit_hash: commitHash,
          files_changed: ['src.ts', 'README.md'],
          branch_name: 'autopilot/sentry-foo',
        },
        { worktreePath: worktree, mode: 'enforce', pushMode: 'disabled', repoRoot: worktree },
      );
      expect(result.details.find((d) => d.check === 'branch_pushed_to_origin')).toBeUndefined();
    });

    it('hard_mismatch when branch_name is missing under pushMode=branch_only', () => {
      const { worktree, commitHash } = makeWorktree();
      const result = verifyOutcome(
        makeIssue(),
        {
          outcome: 'auto_committed',
          commit_hash: commitHash,
          files_changed: ['src.ts', 'README.md'],
        },
        { worktreePath: worktree, mode: 'enforce', pushMode: 'branch_only', repoRoot: worktree },
      );
      expect(result.status).toBe('hard_mismatch');
      const detail = result.details.find((d) => d.check === 'branch_pushed_to_origin');
      expect(detail?.passed).toBe(false);
    });
  });

  describe('verification_error', () => {
    it('returns verification_error when worktreePath does not exist', () => {
      const { commitHash } = makeWorktree();
      const result = verifyOutcome(
        makeIssue(),
        { outcome: 'auto_committed', commit_hash: commitHash, files_changed: ['x'] },
        {
          worktreePath: '/this/path/does/not/exist',
          mode: 'enforce',
          pushMode: 'disabled',
          repoRoot: '/this/path/does/not/exist',
        },
      );
      expect(result.status).toBe('verification_error');
    });
  });
});
