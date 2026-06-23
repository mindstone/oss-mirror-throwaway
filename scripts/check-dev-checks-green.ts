#!/usr/bin/env npx tsx
/**
 * Pre-beta gate: confirm dev-checks is GREEN on the target tip before a ~2h beta.
 *
 * Why this exists: the local pre-beta de-risk (test:fast / validate:fast / boot-smoke)
 * cannot reproduce CI's *timing* environment (fork-pool contention, type-aware-lint
 * worker budgets, CI-only timeouts). A whole class of CI-only-red failures is therefore
 * invisible locally until the ~1.5-2h publish run surfaces them — we burned two doomed
 * betas this way (the silent-swallow-rule-presence CI-only timeout). `dev-checks.yml`
 * runs the SAME `validate-and-test` reusable workflow (Node 20) that release.yml's
 * publish path transitively gates on, on the exact dev tip, in the real CI environment.
 * So "dev-checks validate-and-test green on this SHA" is the faithful, cheap signal that
 * the beta's validate/unit tier will pass — the one we lacked before.
 *
 * This gate keys ONLY on the `validate-and-test` jobs (the validate + unit-shard +
 * test-evals + test-gate tier from reusable-validation.yml). It deliberately ignores the
 * dev-checks-only extras (knip-health, oss-build-smoke, eslint-new-warnings,
 * super-mcp-tests) — those are NOT in release.yml's publish gate, so a red there must not
 * block a legit beta. It does NOT cover the platform builds (e.g. the Windows native-build
 * class) — that is handled by-construction elsewhere (see the release.yml Build-Windows
 * better-sqlite3 scoping).
 *
 * Fail-LOUD on every non-green state (red / in_progress / no-run-for-SHA / gh error):
 * the whole point is to never hand the operator a false green. Override with --force only
 * for a documented legitimate case (e.g. dev-checks red on an unrelated non-publish job).
 *
 * Run: npx tsx scripts/check-dev-checks-green.ts [--sha <sha>] [--branch dev] [--json] [--force] [--limit N]
 * Wired into: docs/project/RELEASE_TO_BETA.md §5.1 (pre-push de-risk ladder).
 *
 * @see docs/plans/260614_ci-release-robustness/PLAN.md
 */

import { spawnSync } from 'node:child_process';
import { gitCapture } from './lib/git-exec';

const GH_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const DEFAULT_BRANCH = 'dev';
const DEFAULT_LIMIT = 20;
const WORKFLOW_FILE = 'dev-checks.yml';
/** Job-name prefix of the reusable-validation jobs that mirror release.yml's publish-gating tier. */
const GATING_JOB_PREFIX = 'validate-and-test';
/**
 * Conclusions that do NOT block a beta. `skipped` matters: jobs like
 * `validate-and-test / Validate Release Changelog` are intentionally skipped on dev/beta
 * pushes (they only run on `main`), so treating skipped as red would block every legit beta.
 * `neutral` is GitHub's explicit "not a failure" outcome. Anything else — failure, cancelled,
 * timed_out, action_required, startup_failure, or a null conclusion on a completed run — blocks.
 */
const ACCEPTABLE_JOB_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

export interface RunListEntry {
  databaseId: number;
  headSha: string;
  status: string; // queued | in_progress | completed
  conclusion: string | null; // success | failure | cancelled | ... | null while running
  createdAt: string;
}

export interface JobEntry {
  name: string;
  status: string;
  conclusion: string | null;
}

/** Injectable gh surface so the evaluation logic is unit-testable without the gh CLI. */
export interface GhRunner {
  runList(workflowFile: string, branch: string, limit: number): RunListEntry[];
  runViewJobs(runId: number): JobEntry[];
}

export type Verdict =
  | { kind: 'green'; runId: number; sha: string; message: string }
  | { kind: 'red'; runId: number; sha: string; failedJobs: string[]; message: string }
  | { kind: 'in_progress'; runId: number; sha: string; message: string }
  | { kind: 'no_signal'; sha: string; message: string }
  | { kind: 'gh_error'; message: string };

/** Exit codes: 0 = green (or forced). Everything else is fail-loud and non-zero. */
export const EXIT_CODE_BY_KIND: Record<Verdict['kind'], number> = {
  green: 0,
  red: 1,
  in_progress: 2,
  no_signal: 3,
  gh_error: 4,
};

class GhError extends Error {}

function realGhRunner(): GhRunner {
  const gh = (args: string[]): string => {
    const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: GH_MAX_BUFFER_BYTES });
    if (result.error) {
      throw new GhError(
        `gh ${args.slice(0, 2).join(' ')} could not run (${result.error.message}). ` +
          'Is the GitHub CLI installed and authenticated (`gh auth status`)?',
      );
    }
    if (result.status !== 0) {
      throw new GhError(`gh ${args.slice(0, 2).join(' ')} failed (exit ${result.status}): ${result.stderr?.trim()}`);
    }
    return result.stdout ?? '';
  };
  return {
    runList(workflowFile, branch, limit) {
      const out = gh([
        'run',
        'list',
        '--workflow',
        workflowFile,
        '--branch',
        branch,
        '--limit',
        String(limit),
        '--json',
        'databaseId,headSha,status,conclusion,createdAt',
      ]);
      const parsed = JSON.parse(out) as RunListEntry[];
      if (!Array.isArray(parsed)) throw new GhError('gh run list returned unexpected (non-array) JSON');
      return parsed;
    },
    runViewJobs(runId) {
      const out = gh(['run', 'view', String(runId), '--json', 'jobs']);
      const parsed = JSON.parse(out) as { jobs?: JobEntry[] };
      if (!parsed || !Array.isArray(parsed.jobs)) throw new GhError('gh run view returned no jobs array');
      return parsed.jobs;
    },
  };
}

/**
 * Pure-ish evaluation: given a target SHA and a gh surface, decide green/red/etc.
 * No process exit, no console — returns a Verdict the caller renders.
 */
export function evaluateDevChecks(targetSha: string, runner: GhRunner, limit = DEFAULT_LIMIT, branch = DEFAULT_BRANCH): Verdict {
  let runs: RunListEntry[];
  try {
    runs = runner.runList(WORKFLOW_FILE, branch, limit);
  } catch (err) {
    return { kind: 'gh_error', message: err instanceof Error ? err.message : String(err) };
  }

  // Match the target SHA exactly. A "stale" latest run (for an older tip) therefore reads
  // as no-signal-for-this-tip rather than a false green — which is the safe failure.
  const matching = runs.filter((r) => r.headSha === targetSha);
  if (matching.length === 0) {
    return {
      kind: 'no_signal',
      sha: targetSha,
      message:
        `No dev-checks run found for ${short(targetSha)} in the last ${limit} ${branch} runs. ` +
        'Push the tip first and let dev-checks run, or widen --limit. Refusing to assume green. ' +
        'Note: dev-checks is path-filtered and does NOT run on an empty/docs-only `[deploy-beta]` ' +
        'trigger commit — check the code tip you are shipping (e.g. `--sha <last-code-commit>`) instead.',
    };
  }

  // Most recent run for this SHA wins (re-runs / amended pushes produce multiple).
  const latest = [...matching].sort(byCreatedAtThenIdDesc)[0];

  if (latest.status !== 'completed') {
    return {
      kind: 'in_progress',
      runId: latest.databaseId,
      sha: targetSha,
      message: `dev-checks for ${short(targetSha)} is still ${latest.status} (run ${latest.databaseId}). Wait for it to finish before the beta.`,
    };
  }

  let jobs: JobEntry[];
  try {
    jobs = runner.runViewJobs(latest.databaseId);
  } catch (err) {
    return { kind: 'gh_error', message: err instanceof Error ? err.message : String(err) };
  }

  const gatingJobs = jobs.filter((j) => j.name.startsWith(GATING_JOB_PREFIX));
  if (gatingJobs.length === 0) {
    // The reusable-validation jobs should always be present. Their absence means the run
    // shape changed (or the workflow was skipped) — never silently pass.
    return {
      kind: 'gh_error',
      message:
        `dev-checks run ${latest.databaseId} for ${short(targetSha)} has no '${GATING_JOB_PREFIX}' jobs — ` +
        'the workflow shape may have changed. Refusing to assume green; inspect the run manually.',
    };
  }

  const failedJobs = gatingJobs
    .filter((j) => !(j.conclusion !== null && ACCEPTABLE_JOB_CONCLUSIONS.has(j.conclusion)))
    .map((j) => `${j.name} (${j.conclusion ?? j.status})`);
  if (failedJobs.length > 0) {
    return {
      kind: 'red',
      runId: latest.databaseId,
      sha: targetSha,
      failedJobs,
      message:
        `dev-checks '${GATING_JOB_PREFIX}' is NOT green on ${short(targetSha)} (run ${latest.databaseId}):\n  - ` +
        failedJobs.join('\n  - ') +
        '\nFix on dev and confirm green before spending a beta — or override with --force if the failure is genuinely unrelated to the publish path.',
    };
  }

  return {
    kind: 'green',
    runId: latest.databaseId,
    sha: targetSha,
    message: `dev-checks '${GATING_JOB_PREFIX}' is green on ${short(targetSha)} (run ${latest.databaseId}). Safe to proceed with the beta.`,
  };
}

function byCreatedAtThenIdDesc(a: RunListEntry, b: RunListEntry): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return b.databaseId - a.databaseId;
}

function short(sha: string): string {
  return sha.length > 10 ? sha.slice(0, 10) : sha;
}

interface CliOptions {
  sha?: string;
  branch: string;
  limit: number;
  json: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { branch: DEFAULT_BRANCH, limit: DEFAULT_LIMIT, json: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--sha') opts.sha = argv[++i];
    else if (arg === '--branch') opts.branch = argv[++i];
    else if (arg === '--limit') opts.limit = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(opts.limit) || opts.limit <= 0) throw new Error(`--limit must be a positive number`);
  return opts;
}

function resolveSha(explicit: string | undefined, branch: string): string {
  if (explicit) return explicit;
  // Default to the current local tip — the SHA the operator is about to push / has on HEAD.
  // Route through the gitCapture chokepoint (repo-wide maxBuffer policy + the git-exec guard).
  try {
    return gitCapture(['rev-parse', 'HEAD']).trim();
  } catch (err) {
    throw new Error(`Could not resolve current HEAD via git rev-parse (for --branch ${branch}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

function main(): void {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    console.error('Usage: npx tsx scripts/check-dev-checks-green.ts [--sha <sha>] [--branch dev] [--json] [--force] [--limit N]');
    process.exit(64); // EX_USAGE
    return;
  }

  let targetSha: string;
  try {
    targetSha = resolveSha(opts.sha, opts.branch);
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_CODE_BY_KIND.gh_error);
    return;
  }

  const verdict = evaluateDevChecks(targetSha, realGhRunner(), opts.limit, opts.branch);

  if (opts.json) {
    console.log(JSON.stringify({ ...verdict, forced: opts.force }, null, 2));
  } else {
    const icon = verdict.kind === 'green' ? '✓' : '✗';
    console.log(`${icon} ${verdict.message}`);
  }

  let exitCode = EXIT_CODE_BY_KIND[verdict.kind];
  if (exitCode !== 0 && opts.force) {
    console.error(`\n⚠ --force given: overriding the non-green dev-checks verdict (${verdict.kind}). Proceeding at operator's risk.`);
    exitCode = 0;
  }
  process.exit(exitCode);
}

// Only run as a CLI when invoked directly (not when imported by the test).
if (require.main === module) {
  main();
}
