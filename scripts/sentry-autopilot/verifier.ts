import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import type { AutopilotConfig } from './config.ts';
import { emitCounter } from './metrics.ts';
import type { SessionOutcome } from './session-manager.ts';
import type { IssueRow } from './state.ts';

/**
 * Mechanical verifier — confirms the bugfixer's claimed outcome matches
 * what's actually in the worktree.
 *
 * Five checks (severity in parens):
 *   - `plan_file_exists` (hard)        — `outcome.plan_file` resolves to a real file
 *   - `commit_present` (hard)          — `outcome.commit_hash` exists in the worktree
 *   - `files_changed_non_empty` (soft) — `outcome.files_changed` has at least one entry
 *   - `files_changed_match` (soft)     — claimed files vs `git diff --name-only` jaccard ≥ 0.5
 *   - `branch_pushed_to_origin` (hard) — only when `pushMode !== 'disabled'`;
 *                                         checked via `git ls-remote`
 *
 * Status resolution:
 *   - Any hard check failed → `hard_mismatch` (terminal — Stage B routes to
 *     `markVerificationFailure` when mode=enforce; Stage E will use this to
 *     gate PR creation).
 *   - All hard checks passed but at least one soft check failed → `soft_mismatch`
 *     (logged, but the issue still completes).
 *   - All checks passed → `pass`.
 *   - Verifier failed internally (e.g. git binary missing, worktree path
 *     doesn't exist) → `verification_error` (transient — retry on next tick).
 *   - `mode === 'disabled'` → `skipped` (no checks run).
 */
export const VerificationDetail = z.object({
  check: z.enum([
    'plan_file_exists',
    'commit_present',
    'files_changed_non_empty',
    'files_changed_match',
    'branch_pushed_to_origin',
  ]),
  severity: z.enum(['hard', 'soft']),
  passed: z.boolean(),
  observed: z.union([z.string(), z.array(z.string()), z.null()]),
  expected: z.union([z.string(), z.array(z.string()), z.null()]),
  message: z.string(),
});
export type VerificationDetail = z.infer<typeof VerificationDetail>;

export const VerificationResult = z.object({
  status: z.enum(['pass', 'soft_mismatch', 'hard_mismatch', 'verification_error', 'skipped']),
  details: z.array(VerificationDetail),
  metrics: z.record(z.number()),
});
export type VerificationResult = z.infer<typeof VerificationResult>;

export interface VerifyContext {
  worktreePath: string;
  mode: AutopilotConfig['verifyMode'];
  pushMode: AutopilotConfig['pushMode'];
  repoRoot: string;
}

const HARD_CHECKS = new Set<VerificationDetail['check']>([
  'plan_file_exists',
  'commit_present',
  'branch_pushed_to_origin',
]);

/**
 * Soft-mismatch jaccard threshold for `files_changed_match`.
 *
 * 0.5 = "at least half of the union of claimed-and-actual files match" — a
 * conservative lower bound that still catches "claimed plan.md but actually
 * committed src/foo.ts" without false-positive-ing on small reshuffles
 * (e.g. agent renamed a file mid-edit).
 */
const FILES_CHANGED_JACCARD_THRESHOLD = 0.5;

function makeDetail(
  check: VerificationDetail['check'],
  passed: boolean,
  observed: VerificationDetail['observed'],
  expected: VerificationDetail['expected'],
  message: string,
): VerificationDetail {
  return {
    check,
    severity: HARD_CHECKS.has(check) ? 'hard' : 'soft',
    passed,
    observed,
    expected,
    message,
  };
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const value of a) {
    if (b.has(value)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * Sentinel thrown for transient/infra failures (git binary missing, worktree
 * path doesn't exist, network failure). `runCheck` converts these into a
 * top-level `verification_error` rather than a hard_mismatch detail — they're
 * an autopilot infrastructure problem, not the bugfixer's fault, so they go
 * through `markFailed` (retryable) rather than `markVerificationFailure`
 * (terminal).
 */
class VerifierInfraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerifierInfraError';
  }
}

function isTransientGitError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') return true;
  // execFileSync timeout
  const signal = (error as { signal?: string }).signal;
  if (signal) return true;
  return false;
}

function runGitCapture(args: readonly string[], cwd: string): string {
  if (cwd && !fs.existsSync(cwd)) {
    throw new VerifierInfraError(`Worktree path ${cwd} does not exist`);
  }
  try {
    // git-exec-allow: verifier git capture keeps timeout and transient-error semantics
    return execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (isTransientGitError(error)) {
      throw new VerifierInfraError(
        `git ${args.join(' ')} failed transiently: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw error;
  }
}

function checkPlanFileExists(outcome: SessionOutcome, ctx: VerifyContext): VerificationDetail | null {
  if (outcome.outcome !== 'plan_created' && outcome.outcome !== 'escalated') {
    return null;
  }

  const planFile = outcome.plan_file ?? 'plan.md';
  // plan_file may be a relative path inside the worktree (e.g. 'plan.md') or
  // an absolute artifact-dir path. We accept either; the verifier's job is to
  // confirm the bugfixer didn't lie about creating it.
  const candidates = path.isAbsolute(planFile)
    ? [planFile]
    : [path.join(ctx.worktreePath, planFile), planFile];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return makeDetail('plan_file_exists', true, candidate, planFile, 'Plan file exists');
    }
  }

  return makeDetail(
    'plan_file_exists',
    false,
    null,
    planFile,
    `Plan file '${planFile}' was claimed but not found in worktree ${ctx.worktreePath}`,
  );
}

function checkCommitPresent(outcome: SessionOutcome, ctx: VerifyContext): VerificationDetail | null {
  if (outcome.outcome !== 'auto_committed' || !outcome.commit_hash) {
    return null;
  }

  try {
    runGitCapture(['cat-file', '-e', `${outcome.commit_hash}^{commit}`], ctx.worktreePath);
    return makeDetail('commit_present', true, outcome.commit_hash, outcome.commit_hash, 'Commit exists');
  } catch (error) {
    if (error instanceof VerifierInfraError) throw error;
    // git exited non-zero — commit really isn't there.
    return makeDetail(
      'commit_present',
      false,
      null,
      outcome.commit_hash,
      `Commit ${outcome.commit_hash} not found in worktree: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function checkFilesChangedNonEmpty(outcome: SessionOutcome): VerificationDetail | null {
  if (outcome.outcome !== 'auto_committed') {
    return null;
  }

  const claimed = outcome.files_changed ?? [];
  return makeDetail(
    'files_changed_non_empty',
    claimed.length > 0,
    claimed,
    'at least one file',
    claimed.length > 0
      ? `${claimed.length} file(s) claimed`
      : 'auto_committed outcome listed no files_changed',
  );
}

function checkFilesChangedMatch(outcome: SessionOutcome, ctx: VerifyContext): VerificationDetail | null {
  if (outcome.outcome !== 'auto_committed' || !outcome.commit_hash) {
    return null;
  }

  const claimed = outcome.files_changed ?? [];
  if (claimed.length === 0) {
    // `files_changed_non_empty` already covers this case; don't double-flag.
    return null;
  }

  let actualOutput: string;
  try {
    actualOutput = runGitCapture(
      ['diff-tree', '--no-commit-id', '--name-only', '-r', outcome.commit_hash],
      ctx.worktreePath,
    );
  } catch (error) {
    if (error instanceof VerifierInfraError) throw error;
    return makeDetail(
      'files_changed_match',
      false,
      null,
      claimed,
      `Could not list commit files: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const actual = actualOutput.split('\n').map((line) => line.trim()).filter(Boolean);
  const claimedSet = new Set(claimed);
  const actualSet = new Set(actual);
  const similarity = jaccard(claimedSet, actualSet);

  const passed = similarity >= FILES_CHANGED_JACCARD_THRESHOLD;
  return makeDetail(
    'files_changed_match',
    passed,
    actual,
    claimed,
    passed
      ? `files_changed jaccard ${similarity.toFixed(2)} ≥ ${FILES_CHANGED_JACCARD_THRESHOLD}`
      : `files_changed jaccard ${similarity.toFixed(2)} < ${FILES_CHANGED_JACCARD_THRESHOLD} (claimed=${claimed.length} actual=${actual.length})`,
  );
}

function checkBranchPushedToOrigin(
  outcome: SessionOutcome,
  ctx: VerifyContext,
): VerificationDetail | null {
  if (ctx.pushMode === 'disabled') return null;
  if (outcome.outcome !== 'auto_committed' && outcome.outcome !== 'plan_created') return null;

  const branchName = outcome.branch_name;
  if (!branchName) {
    return makeDetail(
      'branch_pushed_to_origin',
      false,
      null,
      'autopilot/<sentry_id>',
      `Push mode is "${ctx.pushMode}" but outcome did not report branch_name`,
    );
  }

  let output: string;
  try {
    output = runGitCapture(['ls-remote', 'origin', `refs/heads/${branchName}`], ctx.worktreePath);
  } catch (error) {
    if (error instanceof VerifierInfraError) throw error;
    // Non-transient git failure (e.g. invalid refspec) — surface as a hard
    // mismatch so the issue doesn't loop.
    return makeDetail(
      'branch_pushed_to_origin',
      false,
      null,
      branchName,
      `git ls-remote failed for ${branchName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!output) {
    return makeDetail(
      'branch_pushed_to_origin',
      false,
      null,
      branchName,
      `Branch ${branchName} is not present on origin`,
    );
  }

  const remoteSha = output.split(/\s+/)[0] ?? '';
  if (outcome.outcome !== 'auto_committed' || !outcome.commit_hash) {
    return makeDetail(
      'branch_pushed_to_origin',
      true,
      remoteSha,
      branchName,
      `Branch ${branchName} is on origin at ${remoteSha.slice(0, 12)}`,
    );
  }

  // For auto_committed outcomes, the remote SHA should match the claimed commit.
  const matches = remoteSha.startsWith(outcome.commit_hash) || outcome.commit_hash.startsWith(remoteSha);
  return makeDetail(
    'branch_pushed_to_origin',
    matches,
    remoteSha,
    outcome.commit_hash,
    matches
      ? `Branch ${branchName} on origin at ${remoteSha.slice(0, 12)} matches commit_hash`
      : `Branch ${branchName} on origin at ${remoteSha.slice(0, 12)} does not match claimed commit ${outcome.commit_hash}`,
  );
}

/**
 * Verify the bugfixer's claimed outcome against the actual worktree state.
 *
 * Pure function modulo `execFileSync('git', ...)` and `fs.existsSync`.
 *
 * Called from `SessionManager.harvestOutcome()` BEFORE `tryReleaseSlot()`
 * so the worktree is still intact. The caller decides what to do with the
 * result: `verifyMode=log_only` records details but doesn't change the
 * outcome; `verifyMode=enforce` routes `hard_mismatch` through
 * `markVerificationFailure`.
 */
export function verifyOutcome(
  issue: IssueRow,
  outcome: SessionOutcome,
  ctx: VerifyContext,
): VerificationResult {
  if (ctx.mode === 'disabled') {
    emitCounter('verifier.skipped', { reason: 'mode_disabled' });
    return { status: 'skipped', details: [], metrics: {} };
  }

  // Failed outcomes don't claim anything verifiable — skip.
  if (outcome.outcome === 'failed' || outcome.outcome === 'not_a_bug') {
    emitCounter('verifier.skipped', { reason: `outcome_${outcome.outcome}` });
    return { status: 'skipped', details: [], metrics: {} };
  }

  const details: VerificationDetail[] = [];
  let internalError: Error | null = null;
  const runCheck = (
    fn: () => VerificationDetail | null,
  ): void => {
    if (internalError) return;
    try {
      const detail = fn();
      if (detail) details.push(detail);
    } catch (error) {
      internalError = error instanceof Error ? error : new Error(String(error));
    }
  };

  runCheck(() => checkPlanFileExists(outcome, ctx));
  runCheck(() => checkCommitPresent(outcome, ctx));
  runCheck(() => checkFilesChangedNonEmpty(outcome));
  runCheck(() => checkFilesChangedMatch(outcome, ctx));
  runCheck(() => checkBranchPushedToOrigin(outcome, ctx));

  if (internalError) {
    emitCounter('verifier.verification_error', { sentry_id: issue.sentry_id });
    return {
      status: 'verification_error',
      details,
      metrics: {},
    };
  }

  const hardFailures = details.filter((d) => d.severity === 'hard' && !d.passed);
  const softFailures = details.filter((d) => d.severity === 'soft' && !d.passed);

  let status: VerificationResult['status'];
  if (hardFailures.length > 0) {
    status = 'hard_mismatch';
    for (const failure of hardFailures) {
      emitCounter('verifier.hard_mismatch', { check: failure.check });
    }
  } else if (softFailures.length > 0) {
    status = 'soft_mismatch';
    emitCounter('verifier.soft_mismatch', { outcome: outcome.outcome });
  } else {
    status = 'pass';
    emitCounter('verifier.pass', { outcome: outcome.outcome });
  }

  return {
    status,
    details,
    metrics: {
      checks_run: details.length,
      hard_failures: hardFailures.length,
      soft_failures: softFailures.length,
    },
  };
}

export function summarizeVerification(result: VerificationResult): string {
  if (result.status === 'skipped') return 'verifier skipped';
  if (result.status === 'pass') return 'verification passed';
  if (result.status === 'verification_error') {
    return 'verifier failed internally';
  }
  const failures = result.details.filter((d) => !d.passed);
  if (failures.length === 0) return `verification ${result.status} (no failed details)`;
  return failures.map((d) => `${d.check}: ${d.message}`).join('; ');
}
