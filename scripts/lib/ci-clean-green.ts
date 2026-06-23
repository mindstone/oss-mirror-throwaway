/**
 * Clean-green CI evaluator for the overnight release chain (S-CG).
 *
 * Pure + dependency-injected: GitHub CLI calls and manifest reads come through
 * injected deps, and this module never mutates refs or touches the network
 * directly. Unknown evidence fails closed to `cleanGreen: null`.
 */

import type { ExecFn } from '../promote-preflight-facts';

export type CleanGreenVerdict = 'clean-green' | 'shippable-but-flaky' | 'red';

export interface CleanGreenDeps {
  exec: ExecFn;
  fetchManifest: (betaPublishedVersion: string) => ManifestFetchResult;
}

export interface EvaluateCleanGreenOptions {
  runId: number;
  betaPublishedVersion: string;
  repo: string;
}

export interface CleanGreenResult {
  /** `null` means "could not determine", which is a blocking result. */
  cleanGreen: boolean | null;
  reasons: string[];
}

export type ManifestFetchResult =
  | { ok: true; manifest: unknown }
  | { ok: false; error: string };

export const EXPECTED_BETA_PLATFORMS = ['mac-arm64', 'mac-x64', 'win-x64', 'linux-x64'] as const;

interface GhRunViewResponse {
  jobs?: unknown;
}

interface GhJob {
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
  steps?: unknown;
}

interface GhStep {
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
}

interface E2eFlakeMachineLine {
  kind?: unknown;
  verdict?: unknown;
  expected?: unknown;
  flaky?: unknown;
  unexpected?: unknown;
  skipped?: unknown;
  total?: unknown;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MACHINE_LINE_KIND = 'e2e-flake-summary';
const FLAKE_SUMMARY_MARKER = 'Flake summary:';

export function evaluateCleanGreen(deps: CleanGreenDeps, opts: EvaluateCleanGreenOptions): CleanGreenResult {
  const inputReasons = validateInputs(opts);
  if (inputReasons.length > 0) return { cleanGreen: null, reasons: inputReasons };

  const jobsResult = readJobs(deps.exec, opts.runId, opts.repo);
  if (jobsResult.kind === 'blocked') {
    return { cleanGreen: null, reasons: [jobsResult.reason] };
  }

  const reasons: string[] = [];
  const unknownReasons: string[] = [];
  const jobs = jobsResult.jobs;

  checkJobConclusion(jobs, 'publish-to-gcs', jobNameEquals('Publish to Google Cloud Storage'), reasons, unknownReasons);
  checkStepConclusion(
    jobs,
    'boot-smoke',
    jobNameEquals('Desktop Boot Smoke (macOS)'),
    'smoke',
    stepNameEquals('Boot smoke (launch packaged app, assert appReady)'),
    reasons,
    unknownReasons
  );
  checkStepConclusion(
    jobs,
    'gpu-worker-wasm-smoke',
    jobNameStartsWith('GPU Worker WASM Smoke'),
    'gpusmoke',
    stepNameEquals('GPU-worker WASM smoke (init + embed, assert no crash)'),
    reasons,
    unknownReasons
  );
  checkJobConclusion(jobs, 'realboot', jobNameStartsWith('Real-Boot Agent-Turn'), reasons, unknownReasons);
  checkJobConclusion(jobs, 'test-e2e', jobNameEquals('E2E Tests (macOS)'), reasons, unknownReasons);
  checkStepConclusion(
    jobs,
    'test-e2e',
    jobNameEquals('E2E Tests (macOS)'),
    'E2E flake summary',
    stepNameEquals('E2E flake summary'),
    reasons,
    unknownReasons
  );

  const verdictResult = readE2eVerdict(deps.exec, opts.runId, opts.repo);
  if (verdictResult.kind === 'blocked') {
    unknownReasons.push(verdictResult.reason);
  } else if (verdictResult.verdict !== 'clean-green') {
    reasons.push(`E2E flake verdict was ${verdictResult.verdict}; required clean-green.`);
  }

  const manifestResult = checkManifestCompleteness(deps.fetchManifest, opts.betaPublishedVersion);
  if (manifestResult.kind === 'unknown') {
    unknownReasons.push(manifestResult.reason);
  } else {
    reasons.push(...manifestResult.reasons);
  }

  if (unknownReasons.length > 0) return { cleanGreen: null, reasons: [...unknownReasons, ...reasons] };
  if (reasons.length > 0) return { cleanGreen: false, reasons };
  return { cleanGreen: true, reasons: [] };
}

function validateInputs(opts: EvaluateCleanGreenOptions): string[] {
  const reasons: string[] = [];
  if (!Number.isSafeInteger(opts.runId) || opts.runId <= 0) {
    reasons.push('Run id must be a positive integer.');
  }
  if (!REPO_RE.test(opts.repo)) {
    reasons.push('Repository must be an explicit safe owner/repo value.');
  }
  if (typeof opts.betaPublishedVersion !== 'string' || opts.betaPublishedVersion.trim().length === 0) {
    reasons.push('Beta published version is required.');
  }
  return reasons;
}

function readJobs(exec: ExecFn, runId: number, repo: string): { kind: 'ok'; jobs: GhJob[] } | { kind: 'blocked'; reason: string } {
  let output: string;
  try {
    const result = exec(`gh run view ${runId} --repo ${repo} --json jobs`);
    if (!result.success) return { kind: 'blocked', reason: 'Could not read release.yml jobs from gh run view.' };
    output = result.output.trim();
  } catch {
    return { kind: 'blocked', reason: 'Could not read release.yml jobs from gh run view.' };
  }

  try {
    const parsed = JSON.parse(output) as GhRunViewResponse;
    if (!Array.isArray(parsed.jobs)) {
      return { kind: 'blocked', reason: 'gh run view returned no jobs array.' };
    }
    return { kind: 'ok', jobs: parsed.jobs as GhJob[] };
  } catch {
    return { kind: 'blocked', reason: 'gh run view returned invalid jobs JSON.' };
  }
}

function readE2eVerdict(
  exec: ExecFn,
  runId: number,
  repo: string
): { kind: 'ok'; verdict: CleanGreenVerdict } | { kind: 'blocked'; reason: string } {
  let logOutput: string;
  try {
    // The full run log is multi-MB; give it more than the default 30s metadata
    // timeout (backtest finding F-BT2). A slow/failed fetch still fails closed.
    const result = exec(`gh run view ${runId} --repo ${repo} --log`, { timeoutMs: 120_000 });
    if (!result.success) {
      return { kind: 'blocked', reason: 'Could not read release.yml logs to obtain the E2E flake verdict.' };
    }
    logOutput = result.output;
  } catch {
    return { kind: 'blocked', reason: 'Could not read release.yml logs to obtain the E2E flake verdict.' };
  }

  const verdict = parseE2eVerdictFromLog(logOutput);
  if (!verdict) {
    return { kind: 'blocked', reason: 'E2E flake verdict was not obtainable from the run log.' };
  }
  return { kind: 'ok', verdict };
}

export function parseE2eVerdictFromLog(logOutput: string): CleanGreenVerdict | null {
  for (const line of logOutput.split('\n')) {
    const json = extractFlakeSummaryJson(line);
    if (!json) continue;
    try {
      const parsed = JSON.parse(json) as E2eFlakeMachineLine;
      if (parsed.kind !== MACHINE_LINE_KIND) continue;
      if (!hasReadableE2eCounts(parsed)) continue;
      return normalizeVerdict(parsed.verdict);
    } catch {
      continue;
    }
  }
  return null;
}

function extractFlakeSummaryJson(line: string): string | null {
  const marker = line.indexOf(FLAKE_SUMMARY_MARKER);
  if (marker < 0) return null;

  const start = line.indexOf('{', marker + FLAKE_SUMMARY_MARKER.length);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < line.length; index += 1) {
    const char = line[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return line.slice(start, index + 1);
      if (depth < 0) return null;
    }
  }

  return null;
}

function normalizeVerdict(value: unknown): CleanGreenVerdict | null {
  if (value === 'clean-green' || value === 'shippable-but-flaky' || value === 'red') return value;
  return null;
}

function hasReadableE2eCounts(summary: E2eFlakeMachineLine): boolean {
  const expected = nonNegativeInteger(summary.expected);
  const flaky = nonNegativeInteger(summary.flaky);
  const unexpected = nonNegativeInteger(summary.unexpected);
  const skipped = nonNegativeInteger(summary.skipped);
  const total = nonNegativeInteger(summary.total);
  if (expected === null || flaky === null || unexpected === null || skipped === null || total === null) {
    return false;
  }
  if (total === 0) return false;
  return expected + flaky + unexpected + skipped === total;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function checkJobConclusion(
  jobs: GhJob[],
  label: string,
  predicate: (job: GhJob) => boolean,
  reasons: string[],
  unknownReasons: string[]
): void {
  const matches = jobs.filter(predicate);
  if (matches.length === 0) {
    unknownReasons.push(`Required job ${label} was not found.`);
    return;
  }
  for (const job of matches) {
    if (job.conclusion !== 'success') {
      reasons.push(`Required job ${safeJobName(job, label)} concluded ${String(job.conclusion)}; required success.`);
    }
  }
}

function checkStepConclusion(
  jobs: GhJob[],
  jobLabel: string,
  jobPredicate: (job: GhJob) => boolean,
  stepLabel: string,
  stepPredicate: (step: GhStep) => boolean,
  reasons: string[],
  unknownReasons: string[]
): void {
  const matches = jobs.filter(jobPredicate);
  if (matches.length === 0) {
    unknownReasons.push(`Required job ${jobLabel} was not found.`);
    return;
  }

  for (const job of matches) {
    if (!Array.isArray(job.steps)) {
      unknownReasons.push(`Required job ${safeJobName(job, jobLabel)} did not include readable steps.`);
      continue;
    }
    const steps = job.steps as GhStep[];
    const step = steps.find(stepPredicate);
    if (!step) {
      unknownReasons.push(`Required step ${stepLabel} was not found in job ${safeJobName(job, jobLabel)}.`);
      continue;
    }
    if (step.conclusion !== 'success') {
      reasons.push(
        `Required step ${stepLabel} in job ${safeJobName(job, jobLabel)} concluded ${String(step.conclusion)}; required success.`
      );
    }
  }
}

function checkManifestCompleteness(
  fetchManifest: CleanGreenDeps['fetchManifest'],
  betaPublishedVersion: string
): { kind: 'ok'; reasons: string[] } | { kind: 'unknown'; reason: string } {
  let fetched: ManifestFetchResult;
  try {
    fetched = fetchManifest(betaPublishedVersion);
  } catch {
    return { kind: 'unknown', reason: 'Could not fetch the published beta manifest.' };
  }

  if (!fetched.ok) {
    return { kind: 'unknown', reason: `Could not fetch the published beta manifest: ${fetched.error}` };
  }

  const manifest = fetched.manifest as { version?: unknown; platforms?: unknown } | null;
  if (!manifest || typeof manifest !== 'object') {
    return { kind: 'unknown', reason: 'Published beta manifest had an unexpected shape.' };
  }
  if (manifest.version !== betaPublishedVersion) {
    return {
      kind: 'ok',
      reasons: [`Published beta manifest version was ${String(manifest.version)}; expected ${betaPublishedVersion}.`],
    };
  }
  if (!manifest.platforms || typeof manifest.platforms !== 'object' || Array.isArray(manifest.platforms)) {
    return { kind: 'unknown', reason: 'Published beta manifest did not include a readable platforms object.' };
  }

  const platforms = manifest.platforms as Record<string, unknown>;
  const missing = EXPECTED_BETA_PLATFORMS.filter((platform) => !(platform in platforms));
  if (missing.length > 0) {
    return { kind: 'ok', reasons: [`Published beta manifest is missing platform(s): ${missing.join(', ')}.`] };
  }

  return { kind: 'ok', reasons: [] };
}

function jobNameEquals(expected: string): (job: GhJob) => boolean {
  return (job) => typeof job.name === 'string' && job.name.trim().toLowerCase() === expected.toLowerCase();
}

function jobNameStartsWith(prefix: string): (job: GhJob) => boolean {
  return (job) => typeof job.name === 'string' && job.name.trim().toLowerCase().startsWith(prefix.toLowerCase());
}

function stepNameEquals(expected: string): (step: GhStep) => boolean {
  return (step) => typeof step.name === 'string' && step.name.trim().toLowerCase() === expected.toLowerCase();
}

function safeJobName(job: GhJob, fallback: string): string {
  return typeof job.name === 'string' && job.name.trim() ? job.name.trim() : fallback;
}
