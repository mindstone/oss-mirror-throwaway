/**
 * Candidate binding for the overnight release chain (S-CB).
 *
 * Pure + dependency-injected: all git/GitHub facts come through the injected
 * `exec`, and this module never reaches the network or advances refs. The
 * binding freezes the exact beta candidate later gates must keep matching.
 */

import type { ExecFn } from '../promote-preflight-facts';

export const DEFAULT_BETA_GCS_MANIFEST_PATH =
  'https://storage.googleapis.com/mindstone-rebel/releases-beta/latest.json';

const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface CandidateBindingDeps {
  exec: ExecFn;
}

export interface FindDispatchedBetaRunOptions {
  /** Dev HEAD captured immediately before the beta-triggering push. */
  capturedHeadSha: string;
  /** ISO timestamp for the push that should have dispatched release.yml. */
  pushTimeIso: string;
  /** Explicit GitHub owner/repo, e.g. `mindstone/rebel-app`. */
  repo: string;
}

export interface DispatchedBetaRun {
  runId: number;
  databaseId: number;
  event: 'workflow_dispatch';
  branch: 'dev';
  headSha: string;
  createdAt: string;
  status: string;
  conclusion: string | null;
  displayTitle: string;
}

export type FindDispatchedBetaRunResult =
  | { kind: 'found'; run: DispatchedBetaRun }
  | { kind: 'not-found-yet'; reason: string }
  | { kind: 'blocked'; reason: string; message: string; matches?: readonly DispatchedBetaRun[] };

export interface BindCandidateOptions {
  devHeadSha: string;
  releaseRun: DispatchedBetaRun;
  gcsManifestPath?: string;
}

export interface CandidateBinding {
  readonly devHeadSha: string;
  readonly releaseRun: Readonly<DispatchedBetaRun>;
  readonly sourcePackageVersion: string;
  readonly betaPublishedVersion: string;
  readonly gcsManifestPath: string;
}

export type BindCandidateResult =
  | { kind: 'bound'; binding: CandidateBinding }
  | { kind: 'blocked'; reason: string; message: string };

export interface CandidateBindingObservation {
  devHeadSha?: string;
  runId?: number;
  databaseId?: number;
  event?: string;
  branch?: string;
  headSha?: string;
  sourcePackageVersion?: string;
  betaPublishedVersion?: string;
  /** Version read from `releases-beta/latest.json` / equivalent trusted manifest. */
  gcsManifestVersion?: string;
  gcsManifestPath?: string;
}

export type BindingMatchResult =
  | { kind: 'match' }
  | {
      kind: 'blocked';
      reason: string;
      field: string;
      expected: string | number;
      observed: unknown;
      message: string;
    };

interface RawGhRun {
  databaseId?: unknown;
  headSha?: unknown;
  event?: unknown;
  createdAt?: unknown;
  status?: unknown;
  conclusion?: unknown;
  displayTitle?: unknown;
}

function isCanonicalOid(value: string): boolean {
  return OID_RE.test(value);
}

function isSafeRepo(value: string): boolean {
  return REPO_RE.test(value);
}

function execOutput(exec: ExecFn, cmd: string): string | null {
  try {
    const result = exec(cmd);
    return result.success ? result.output.trim() : null;
  } catch {
    return null;
  }
}

function parseIsoMs(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function parseRunRow(row: RawGhRun): DispatchedBetaRun | null {
  const { databaseId, headSha, event, createdAt, status, conclusion, displayTitle } = row;
  if (typeof databaseId !== 'number') return null;
  if (typeof headSha !== 'string') return null;
  if (event !== 'workflow_dispatch') return null;
  if (typeof createdAt !== 'string') return null;
  if (typeof status !== 'string') return null;
  if (conclusion !== null && typeof conclusion !== 'string') return null;
  if (typeof displayTitle !== 'string') return null;
  if (!isCanonicalOid(headSha)) return null;
  if (parseIsoMs(createdAt) === null) return null;

  return {
    runId: databaseId,
    databaseId,
    event,
    branch: 'dev',
    headSha,
    createdAt,
    status,
    conclusion,
    displayTitle,
  };
}

function parsePackageJsonVersion(jsonStr: string): string | null {
  try {
    const parsed = JSON.parse(jsonStr) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : null;
  } catch {
    return null;
  }
}

function gatherSourcePackageVersion(exec: ExecFn, sha: string): string | null {
  const packageJson = execOutput(exec, `git show ${sha}:package.json`);
  return packageJson === null ? null : parsePackageJsonVersion(packageJson);
}

function gatherCommitCount(exec: ExecFn, sha: string): number | null {
  const output = execOutput(exec, `git rev-list --count ${sha}`);
  if (output === null) return null;
  if (!/^\d+$/.test(output)) return null;
  const count = Number(output);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

/**
 * Mirrors release.yml's setup job for beta builds:
 * `{major}.{minor}.{patch}{git rev-list --count <sha>}`, with leading zeroes
 * stripped from the third component. We deliberately re-derive this from the
 * bound SHA rather than reading `setup.beta_version` from `gh run view --json jobs`,
 * because job outputs are not reliably available there. The published manifest
 * is still checked later via `matchesBinding(..., { gcsManifestVersion })`.
 */
export function deriveBetaPublishedVersion(sourcePackageVersion: string, commitCount: number): string | null {
  const baseVersion = sourcePackageVersion.replace(/[-+].*$/, '');
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(baseVersion);
  if (!match) return null;

  const major = match[1];
  const minor = match[2];
  const patch = match[3];
  if (!major || !minor || !patch) return null;
  const betaThird = `${patch}${commitCount}`.replace(/^0+/, '') || '0';
  return `${major}.${minor}.${betaThird}`;
}

export function findDispatchedBetaRun(
  deps: CandidateBindingDeps,
  opts: FindDispatchedBetaRunOptions
): FindDispatchedBetaRunResult {
  if (!isCanonicalOid(opts.capturedHeadSha)) {
    return {
      kind: 'blocked',
      reason: 'invalid-head-sha',
      message: 'Captured dev HEAD is not a canonical git object id.',
    };
  }
  if (!isSafeRepo(opts.repo)) {
    return {
      kind: 'blocked',
      reason: 'invalid-repo',
      message: 'Repository must be an explicit safe owner/repo value.',
    };
  }

  const pushTimeMs = parseIsoMs(opts.pushTimeIso);
  if (pushTimeMs === null) {
    return {
      kind: 'blocked',
      reason: 'invalid-push-time',
      message: 'Push time is not a valid ISO timestamp.',
    };
  }

  const output = execOutput(
    deps.exec,
    `gh run list --repo ${opts.repo} --workflow release.yml --branch dev --limit 50 --json databaseId,headSha,event,createdAt,status,conclusion,displayTitle`
  );
  if (output === null) {
    return {
      kind: 'blocked',
      reason: 'gh-run-list-failed',
      message: 'Could not list dispatched release.yml runs.',
    };
  }

  let rawRuns: RawGhRun[];
  try {
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed)) {
      return {
        kind: 'blocked',
        reason: 'gh-run-list-shape',
        message: 'gh run list returned non-array JSON.',
      };
    }
    rawRuns = parsed as RawGhRun[];
  } catch {
    return {
      kind: 'blocked',
      reason: 'gh-run-list-json',
      message: 'gh run list returned invalid JSON.',
    };
  }

  const parsedRuns: DispatchedBetaRun[] = [];
  for (const row of rawRuns) {
    if (row.event !== 'workflow_dispatch') continue;
    const run = parseRunRow(row);
    if (!run) {
      return {
        kind: 'blocked',
        reason: 'gh-run-list-row-shape',
        message: 'A workflow_dispatch release.yml row had an unexpected shape.',
      };
    }
    parsedRuns.push(run);
  }

  const matches = parsedRuns.filter(
    (run) => run.headSha === opts.capturedHeadSha && (parseIsoMs(run.createdAt) ?? -Infinity) > pushTimeMs
  );

  if (matches.length === 0) {
    return {
      kind: 'not-found-yet',
      reason: 'No matching workflow_dispatch release.yml run for the captured dev HEAD after the push time.',
    };
  }
  if (matches.length > 1) {
    return {
      kind: 'blocked',
      reason: 'ambiguous-dispatched-run',
      message: 'Multiple workflow_dispatch release.yml runs match the captured dev HEAD after the push time.',
      matches,
    };
  }

  const match = matches[0];
  if (!match) {
    return {
      kind: 'not-found-yet',
      reason: 'No matching workflow_dispatch release.yml run for the captured dev HEAD after the push time.',
    };
  }

  return { kind: 'found', run: match };
}

export function bindCandidate(deps: CandidateBindingDeps, opts: BindCandidateOptions): BindCandidateResult {
  if (!isCanonicalOid(opts.devHeadSha)) {
    return {
      kind: 'blocked',
      reason: 'invalid-head-sha',
      message: 'Captured dev HEAD is not a canonical git object id.',
    };
  }
  if (opts.releaseRun.event !== 'workflow_dispatch' || opts.releaseRun.branch !== 'dev') {
    return {
      kind: 'blocked',
      reason: 'wrong-release-run',
      message: 'Candidate binding requires the dispatched release.yml workflow_dispatch run on dev.',
    };
  }
  if (opts.releaseRun.headSha !== opts.devHeadSha) {
    return {
      kind: 'blocked',
      reason: 'head-sha-drift',
      message: `Release run headSha ${opts.releaseRun.headSha} does not match captured dev HEAD ${opts.devHeadSha}.`,
    };
  }

  const sourcePackageVersion = gatherSourcePackageVersion(deps.exec, opts.devHeadSha);
  if (sourcePackageVersion === null) {
    return {
      kind: 'blocked',
      reason: 'source-version-unavailable',
      message: 'Could not read package.json version at the captured dev HEAD.',
    };
  }

  const commitCount = gatherCommitCount(deps.exec, opts.devHeadSha);
  if (commitCount === null) {
    return {
      kind: 'blocked',
      reason: 'commit-count-unavailable',
      message: 'Could not derive the beta version commit count for the captured dev HEAD.',
    };
  }

  const betaPublishedVersion = deriveBetaPublishedVersion(sourcePackageVersion, commitCount);
  if (betaPublishedVersion === null) {
    return {
      kind: 'blocked',
      reason: 'beta-version-unavailable',
      message: 'Could not derive beta published version from the source package version and commit count.',
    };
  }

  const releaseRun = Object.freeze({ ...opts.releaseRun });
  const binding: CandidateBinding = Object.freeze({
    devHeadSha: opts.devHeadSha,
    releaseRun,
    sourcePackageVersion,
    betaPublishedVersion,
    gcsManifestPath: opts.gcsManifestPath ?? DEFAULT_BETA_GCS_MANIFEST_PATH,
  });

  return { kind: 'bound', binding };
}

function mismatch(
  field: string,
  expected: string | number,
  observed: unknown,
  reason = 'candidate-binding-mismatch'
): Extract<BindingMatchResult, { kind: 'blocked' }> {
  return {
    kind: 'blocked',
    reason,
    field,
    expected,
    observed,
    message: `Observed ${field} does not match the frozen candidate binding.`,
  };
}

export function matchesBinding(binding: CandidateBinding, observed: CandidateBindingObservation): BindingMatchResult {
  let compared = 0;
  const blockedResults: Array<Extract<BindingMatchResult, { kind: 'blocked' }>> = [];

  const compare = (field: string, expected: string | number, value: unknown): void => {
    if (value === undefined) return;
    compared += 1;
    if (value !== expected) {
      blockedResults.push(mismatch(field, expected, value));
    }
  };

  compare('devHeadSha', binding.devHeadSha, observed.devHeadSha);
  compare('runId', binding.releaseRun.runId, observed.runId);
  compare('databaseId', binding.releaseRun.databaseId, observed.databaseId);
  compare('event', binding.releaseRun.event, observed.event);
  compare('branch', binding.releaseRun.branch, observed.branch);
  compare('headSha', binding.releaseRun.headSha, observed.headSha);
  compare('sourcePackageVersion', binding.sourcePackageVersion, observed.sourcePackageVersion);
  compare('betaPublishedVersion', binding.betaPublishedVersion, observed.betaPublishedVersion);
  compare('gcsManifestVersion', binding.betaPublishedVersion, observed.gcsManifestVersion);
  compare('gcsManifestPath', binding.gcsManifestPath, observed.gcsManifestPath);

  const firstBlocked = blockedResults[0];
  if (firstBlocked) return firstBlocked;
  if (compared === 0) {
    return mismatch('observation', 'at least one candidate identity field', undefined, 'no-observed-fields');
  }

  return { kind: 'match' };
}
