#!/usr/bin/env npx tsx

/**
 * Deterministic overnight beta -> gate -> optional production-advance orchestrator.
 *
 * Safety model:
 * - This script is a coordinator, not an agent: it never fixes code, re-cuts a
 *   beta, or makes judgment calls.
 * - Production advance is off by default. The only call site for `spawnAdvance`
 *   is guarded by: all gates passed + `verifyArming(...).armed === true` +
 *   `--dry-run` is false.
 * - Per A2, the advance is a subprocess invocation of
 *   `scripts/promote-to-production.ts`; this file deliberately imports no
 *   production-driver symbols.
 */

import { Cli, Command, Option, UsageError } from 'clipanion';
import { execSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bindCandidate,
  DEFAULT_BETA_GCS_MANIFEST_PATH,
  findDispatchedBetaRun,
  matchesBinding,
  type CandidateBinding,
  type DispatchedBetaRun,
  type FindDispatchedBetaRunResult,
} from './lib/release-candidate-binding';
import {
  evaluateCleanGreen,
  type CleanGreenResult,
  type ManifestFetchResult,
} from './lib/ci-clean-green';
import {
  buildBetaSentryRelease,
  buildBlockingIssuesQuery,
  evaluateSentryGate,
  type FetchSentry,
  type FetchSentryInit,
  type FetchSentryResult,
  type SentryPromoteGateResult,
} from './lib/sentry-promote-gate';
import {
  DEFAULT_ARMING_TTL_MS,
  verifyArming,
  type ReleaseArmingFlags,
  type VerifyArmingResult,
} from './lib/release-arming';
import { evaluatePromotePreflight, type PromotePreflightVerdict } from './promote-preflight';
import {
  gatherPromoteFacts,
  type ExecFn,
  type ExecOpts,
  type ExecResult,
} from './promote-preflight-facts';

export const CANONICAL_REPO = 'mindstone/rebel-app';

const DEFAULT_LOCK_FILE = '/tmp/mindstone-rebel-overnight-release-chain.lock';
const DEFAULT_LOCK_STALE_TTL_MS = 18 * 60 * 60 * 1000;
const DEFAULT_BETA_DISPATCH_WAIT_MS = 10 * 60 * 1000;
const DEFAULT_BETA_WATCH_WINDOW_MS = 180 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 30 * 1000;

/**
 * execSync/spawnSync stdout buffer cap for the real seams. Node defaults to 1 MB,
 * but `gh run view <id> --log` for a release run is multi-MB (~7 MB and growing),
 * which throws ENOBUFS at the default and made the E2E flake-verdict read fail
 * closed on every real run (real-historical backtest finding F-BT1 —
 * docs/plans/260621_overnight-release-chain/BACKTEST_REAL_HISTORICAL.md). 64 MB
 * gives ample headroom; output that still exceeds it fails closed, the safe way.
 */
const MAX_EXEC_BUFFER_BYTES = 64 * 1024 * 1024;

const BETA_MARKER = '[deploy-beta]';

export const OVERNIGHT_EXIT_CODES = {
  SUCCESS: 0,
  STOPPED: 20,
  LOCK_HELD: 75,
  BAD_INPUT: 11,
  UNKNOWN_ERROR: 99,
} as const;

export type TerminalStatus =
  | 'promoted'
  | 'stopped-at-gate-clean-green'
  | 'stopped-at-gate-sentry'
  | 'stopped-at-gate-preflight'
  | 'beta-failed'
  | 'stopped-beta-incomplete'
  | 'not-armed-stopped-before-advance'
  | `promote-driver-${string}`;

export interface Clock {
  now: () => Date;
}

export interface RunLockHandle {
  acquired: boolean;
  reason?: string;
  release: () => void | Promise<void>;
}

export type AcquireRunLock = (path: string, staleTtlMs: number, clock: Clock) => RunLockHandle | Promise<RunLockHandle>;

export interface SpawnAdvanceRequest {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface SpawnAdvanceResult {
  exitCode: number;
  exitName?: string;
  stdout?: string;
  stderr?: string;
  stableRunId?: number;
}

export interface OvernightReleaseChainOptions {
  repo?: string;
  repoRoot?: string;
  dryRun?: boolean;
  explainJson?: boolean;
  dryRunRunId?: number;
  betaDispatchWaitMs?: number;
  betaWatchWindowMs?: number;
  pollIntervalMs?: number;
  lockFilePath?: string;
  lockStaleTtlMs?: number;
  preBetaCommands?: string[];
  pushBetaCommand?: string;
  armingFlags?: ReleaseArmingFlags;
  armedAtIso?: string | null;
  armingTtlMs?: number | null;
}

export interface OvernightReleaseChainDeps {
  exec: ExecFn;
  spawnAdvance: (request: SpawnAdvanceRequest) => Promise<SpawnAdvanceResult> | SpawnAdvanceResult;
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
  fetchSentry: FetchSentry;
  fetchManifest: (betaPublishedVersion: string) => Promise<ManifestFetchResult>;
  getEnv: (key: string) => string | undefined;
  evaluatePreflightGate?: (binding: CandidateBinding, context: { repo: string; repoRoot: string }) => PromotePreflightVerdict;
  acquireRunLock?: AcquireRunLock;
  isCleanFastForward?: (baseRef: string, targetRef: string, cwd: string) => boolean;
  log?: (message: string) => void;
}

export interface PhaseTiming {
  startedAtIso: string;
  endedAtIso: string;
  durationMs: number;
}

export interface GateEvidence<TInput, TOutput> {
  input: TInput;
  output: TOutput;
}

export interface ChainState {
  terminalStatus: TerminalStatus;
  stopReason?: string;
  dryRun: boolean;
  explainJson: boolean;
  repo: string;
  startedAtIso: string;
  endedAtIso: string;
  sourceSha?: string;
  ghActor?: string;
  binding?: CandidateBinding;
  dispatchedRun?: DispatchedBetaRun;
  stableRunId?: number;
  gates: {
    cleanGreen?: GateEvidence<{ runId: number; betaPublishedVersion: string }, CleanGreenResult>;
    sentry?: GateEvidence<{ betaPublishedVersion: string; queryUrl: string }, SentryPromoteGateResult>;
    preflight?: GateEvidence<{ sha: string }, PromotePreflightVerdict>;
  };
  arming?: VerifyArmingResult;
  manifestVersions: {
    betaPublishedVersion?: string;
    sourcePackageVersion?: string;
  };
  timings: Record<string, PhaseTiming>;
  manualFinishCommand?: string;
  advance?: {
    request?: SpawnAdvanceRequest;
    result?: SpawnAdvanceResult;
  };
  notes: string[];
}

export interface OvernightReleaseChainResult {
  exitCode: number;
  state: ChainState;
  report: string;
  explainJson?: string;
}

interface PhaseTracker {
  finish: () => void;
}

function phase(state: ChainState, clock: Clock, name: string): PhaseTracker {
  const started = clock.now();
  return {
    finish: () => {
      const ended = clock.now();
      state.timings[name] = {
        startedAtIso: started.toISOString(),
        endedAtIso: ended.toISOString(),
        durationMs: Math.max(0, ended.getTime() - started.getTime()),
      };
    },
  };
}

function execOutput(exec: ExecFn, command: string, opts?: ExecOpts): string | null {
  try {
    const result = exec(command, opts);
    return result.success ? result.output.trim() : null;
  } catch {
    return null;
  }
}

function execOrStop(exec: ExecFn, command: string): { ok: true; output: string } | { ok: false; reason: string } {
  try {
    const result = exec(command);
    if (result.success) return { ok: true, output: result.output.trim() };
    return { ok: false, reason: result.error || result.output || `Command failed: ${command}` };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function parsePositiveInt(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new UsageError(`${label} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new UsageError(`${label} must be a positive integer.`);
  return parsed;
}

function msFromMinutes(value: string | undefined, label: string): number | undefined {
  const minutes = parsePositiveInt(value, label);
  return minutes === undefined ? undefined : minutes * 60 * 1000;
}

function safeIso(clock: Clock): string {
  try {
    return clock.now().toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

export function buildPromoteSubprocessRequest(binding: CandidateBinding): SpawnAdvanceRequest {
  return {
    command: 'npx',
    args: [
      'tsx',
      'scripts/promote-to-production.ts',
      '--commit',
      binding.devHeadSha,
      '--confirm-changelog-current',
      binding.sourcePackageVersion,
    ],
    env: {
      REBEL_CERTIFIED_PROMOTE_SHA: binding.devHeadSha,
    },
  };
}

function exitNameFromCode(exitCode: number): string {
  const names: Record<number, string> = {
    10: 'not-eligible',
    11: 'bad-input',
    20: 'not-fast-forward',
    30: 'run-not-triggered',
    35: 'publish-not-confirmed',
    40: 'ref-update-failed',
    60: 'user-cancelled',
    99: 'unknown-error',
  };
  return names[exitCode] ?? `exit-${exitCode}`;
}

function manualFinishCommand(binding: CandidateBinding, stableRunId?: number): string {
  const envParts = [`REBEL_OVERNIGHT_BETA_RUN_ID=${binding.releaseRun.runId}`];
  if (stableRunId !== undefined) envParts.push(`REBEL_OVERNIGHT_STABLE_RUN_ID=${stableRunId}`);
  return [
    ...envParts,
    'npx',
    'tsx',
    'scripts/promote-to-production.ts',
    '--commit',
    binding.devHeadSha,
    '--confirm-changelog-current',
    binding.sourcePackageVersion,
  ].join(' ');
}

function sentryQueryUrl(betaPublishedVersion: string): string {
  const release = buildBetaSentryRelease(betaPublishedVersion);
  const url = new URL('https://us.sentry.io/api/0/projects/mindstone/rebel/issues/');
  url.searchParams.set('query', buildBlockingIssuesQuery(release));
  url.searchParams.set('statsPeriod', '24h');
  url.searchParams.set('limit', '100');
  return url.toString();
}

function initializeState(opts: Required<Pick<OvernightReleaseChainOptions, 'dryRun' | 'explainJson'>>, repo: string, clock: Clock): ChainState {
  const now = safeIso(clock);
  return {
    terminalStatus: 'stopped-beta-incomplete',
    dryRun: opts.dryRun,
    explainJson: opts.explainJson,
    repo,
    startedAtIso: now,
    endedAtIso: now,
    gates: {},
    manifestVersions: {},
    timings: {},
    notes: [
      'Deterministic gates PASSED only means the configured gates passed; soak NOT evaluated; morning review is the response window.',
      'Real-historical beta backtests remain a pre-arming readiness item; this stage proves dry-run wiring with synthetic fixtures.',
    ],
  };
}

function finishState(state: ChainState, clock: Clock, status: TerminalStatus, reason?: string): ChainState {
  state.terminalStatus = status;
  state.stopReason = reason;
  state.endedAtIso = safeIso(clock);
  if (state.binding) {
    state.manualFinishCommand = manualFinishCommand(state.binding, state.stableRunId);
  }
  return state;
}

function resultFromState(state: ChainState): OvernightReleaseChainResult {
  const exitCode = state.terminalStatus === 'promoted' ? OVERNIGHT_EXIT_CODES.SUCCESS : OVERNIGHT_EXIT_CODES.STOPPED;
  const report = renderChainReport(state);
  const explainJson = state.explainJson ? JSON.stringify(explainChainState(state), null, 2) : undefined;
  return { exitCode, state, report, explainJson };
}

interface RunViewJson {
  databaseId?: unknown;
  headSha?: unknown;
  event?: unknown;
  createdAt?: unknown;
  status?: unknown;
  conclusion?: unknown;
  displayTitle?: unknown;
}

function parseDispatchedRun(row: RunViewJson): DispatchedBetaRun | null {
  if (typeof row.databaseId !== 'number') return null;
  if (row.event !== 'workflow_dispatch') return null;
  if (typeof row.headSha !== 'string') return null;
  if (typeof row.createdAt !== 'string') return null;
  if (typeof row.status !== 'string') return null;
  if (row.conclusion !== null && typeof row.conclusion !== 'string') return null;
  if (typeof row.displayTitle !== 'string') return null;
  return {
    runId: row.databaseId,
    databaseId: row.databaseId,
    event: 'workflow_dispatch',
    branch: 'dev',
    headSha: row.headSha,
    createdAt: row.createdAt,
    status: row.status,
    conclusion: row.conclusion,
    displayTitle: row.displayTitle,
  };
}

function readRunView(exec: ExecFn, repo: string, runId: number): DispatchedBetaRun | null {
  const out = execOutput(
    exec,
    `gh run view ${runId} --repo ${repo} --json databaseId,headSha,event,createdAt,status,conclusion,displayTitle`
  );
  if (out === null) return null;
  try {
    const parsed = JSON.parse(out) as RunViewJson;
    return parseDispatchedRun(parsed);
  } catch {
    return null;
  }
}

function selectLatestDryRunBetaRun(exec: ExecFn, repo: string, runId?: number): DispatchedBetaRun | null {
  if (runId !== undefined) return readRunView(exec, repo, runId);

  const out = execOutput(
    exec,
    `gh run list --repo ${repo} --workflow release.yml --branch dev --limit 20 --json databaseId,headSha,event,createdAt,status,conclusion,displayTitle`
  );
  if (out === null) return null;
  try {
    const parsed = JSON.parse(out);
    if (!Array.isArray(parsed)) return null;
    const runs = parsed
      .map((row) => parseDispatchedRun(row as RunViewJson))
      .filter((row): row is DispatchedBetaRun => row !== null)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return runs[0] ?? null;
  } catch {
    return null;
  }
}

async function waitForDispatchedRun(
  deps: OvernightReleaseChainDeps,
  opts: {
    repo: string;
    capturedHeadSha: string;
    pushTimeIso: string;
    timeoutMs: number;
    pollIntervalMs: number;
  }
): Promise<FindDispatchedBetaRunResult> {
  const startedAt = deps.clock.now().getTime();
  while (deps.clock.now().getTime() - startedAt <= opts.timeoutMs) {
    const found = findDispatchedBetaRun(
      { exec: deps.exec },
      {
        capturedHeadSha: opts.capturedHeadSha,
        pushTimeIso: opts.pushTimeIso,
        repo: opts.repo,
      }
    );
    if (found.kind !== 'not-found-yet') return found;
    await deps.sleep(opts.pollIntervalMs);
  }
  return {
    kind: 'blocked',
    reason: 'dispatched-beta-run-timeout',
    message: 'No matching dispatched beta release.yml run appeared within the bounded wait window.',
  };
}

async function watchBetaRun(
  deps: OvernightReleaseChainDeps,
  opts: {
    repo: string;
    runId: number;
    timeoutMs: number;
    pollIntervalMs: number;
  }
): Promise<{ kind: 'completed'; run: DispatchedBetaRun } | { kind: 'incomplete'; reason: string }> {
  const startedAt = deps.clock.now().getTime();
  while (deps.clock.now().getTime() - startedAt <= opts.timeoutMs) {
    const run = readRunView(deps.exec, opts.repo, opts.runId);
    if (run && run.status === 'completed') return { kind: 'completed', run };
    await deps.sleep(opts.pollIntervalMs);
  }
  return {
    kind: 'incomplete',
    reason: 'Beta release.yml run was still queued/in_progress past the bounded watch window.',
  };
}

async function evaluateCleanGreenGate(
  deps: OvernightReleaseChainDeps,
  repo: string,
  binding: CandidateBinding
): Promise<CleanGreenResult> {
  const manifest = await deps.fetchManifest(binding.betaPublishedVersion);
  return evaluateCleanGreen(
    {
      exec: deps.exec,
      fetchManifest: () => manifest,
    },
    {
      runId: binding.releaseRun.runId,
      betaPublishedVersion: binding.betaPublishedVersion,
      repo,
    }
  );
}

async function evaluateSentryPromoteGate(
  deps: OvernightReleaseChainDeps,
  binding: CandidateBinding
): Promise<SentryPromoteGateResult> {
  return evaluateSentryGate(
    {
      fetchSentry: deps.fetchSentry,
      getEnv: deps.getEnv,
    },
    {
      betaPublishedVersion: binding.betaPublishedVersion,
      sinceIso: binding.releaseRun.createdAt,
    }
  );
}

function evaluateRealPreflightGate(
  deps: OvernightReleaseChainDeps,
  opts: { repo: string; repoRoot: string; binding: CandidateBinding }
): PromotePreflightVerdict {
  const facts = gatherPromoteFacts(opts.binding.devHeadSha, {
    exec: deps.exec,
    repoRoot: opts.repoRoot,
    ownerRepo: opts.repo,
    isCleanFastForward: deps.isCleanFastForward,
  });
  return evaluatePromotePreflight(facts);
}

function acquireFileRunLock(path: string, staleTtlMs: number, clock: Clock): RunLockHandle {
  const nowMs = clock.now().getTime();
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as { pid?: unknown; acquiredAtMs?: unknown };
      const acquiredAtMs = typeof parsed.acquiredAtMs === 'number' ? parsed.acquiredAtMs : null;
      if (acquiredAtMs !== null && nowMs - acquiredAtMs <= staleTtlMs) {
        return {
          acquired: false,
          reason: `another overnight release chain appears to be running (pid=${String(parsed.pid ?? 'unknown')})`,
          release: () => undefined,
        };
      }
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ pid: process.pid, acquiredAtMs: nowMs, acquiredAtIso: new Date(nowMs).toISOString() }));
    return {
      acquired: true,
      release: () => {
        try {
          unlinkSync(path);
        } catch {
          // Best-effort cleanup; a stale lock is handled by the TTL on the next run.
        }
      },
    };
  } catch (error) {
    return {
      acquired: false,
      reason: `could not acquire run lock: ${error instanceof Error ? error.message : String(error)}`,
      release: () => undefined,
    };
  }
}

export async function runOvernightReleaseChain(
  inputOpts: OvernightReleaseChainOptions,
  deps: OvernightReleaseChainDeps
): Promise<OvernightReleaseChainResult> {
  const opts = {
    repo: inputOpts.repo ?? CANONICAL_REPO,
    repoRoot: inputOpts.repoRoot ?? process.cwd(),
    dryRun: inputOpts.dryRun === true,
    explainJson: inputOpts.explainJson === true,
    dryRunRunId: inputOpts.dryRunRunId,
    betaDispatchWaitMs: inputOpts.betaDispatchWaitMs ?? DEFAULT_BETA_DISPATCH_WAIT_MS,
    betaWatchWindowMs: inputOpts.betaWatchWindowMs ?? DEFAULT_BETA_WATCH_WINDOW_MS,
    pollIntervalMs: inputOpts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    lockFilePath: inputOpts.lockFilePath ?? DEFAULT_LOCK_FILE,
    lockStaleTtlMs: inputOpts.lockStaleTtlMs ?? DEFAULT_LOCK_STALE_TTL_MS,
    preBetaCommands: inputOpts.preBetaCommands ?? ['npm run check:dev-checks-green', 'npm run validate:fast'],
    pushBetaCommand: inputOpts.pushBetaCommand ?? 'npx tsx scripts/git-safe-sync.ts --validate',
    armingFlags: inputOpts.armingFlags,
    armedAtIso: inputOpts.armedAtIso,
    armingTtlMs: inputOpts.armingTtlMs ?? DEFAULT_ARMING_TTL_MS,
  };
  const state = initializeState({ dryRun: opts.dryRun, explainJson: opts.explainJson }, opts.repo, deps.clock);
  const log = deps.log ?? (() => undefined);

  const lock = await (deps.acquireRunLock ?? acquireFileRunLock)(opts.lockFilePath, opts.lockStaleTtlMs, deps.clock);
  if (!lock.acquired) {
    finishState(state, deps.clock, 'stopped-beta-incomplete', lock.reason ?? 'run lock is held');
    state.notes.push('Run-lock refused this invocation before any beta push or gate evaluation.');
    return { ...resultFromState(state), exitCode: OVERNIGHT_EXIT_CODES.LOCK_HELD };
  }

  try {
    let releaseRun: DispatchedBetaRun | null = null;

    const actorPhase = phase(state, deps.clock, 'capture-actor');
    state.ghActor = execOutput(deps.exec, 'gh api user --jq .login') ?? '<unknown>';
    actorPhase.finish();

    if (opts.dryRun) {
      const dryRunPhase = phase(state, deps.clock, 'dry-run-select-beta');
      releaseRun = selectLatestDryRunBetaRun(deps.exec, opts.repo, opts.dryRunRunId);
      dryRunPhase.finish();
      if (!releaseRun) {
        finishState(state, deps.clock, 'stopped-beta-incomplete', 'No historical dispatched beta run was available for dry-run.');
        return resultFromState(state);
      }
      state.sourceSha = releaseRun.headSha;
      state.dispatchedRun = releaseRun;
    } else {
      const capturePhase = phase(state, deps.clock, 'capture-dev-head');
      const head = execOrStop(deps.exec, 'git rev-parse HEAD');
      if (!head.ok) {
        capturePhase.finish();
        finishState(state, deps.clock, 'stopped-beta-incomplete', `Could not capture dev HEAD: ${head.reason}`);
        return resultFromState(state);
      }
      const capturedHeadSha = head.output;
      state.sourceSha = capturedHeadSha;
      const subject = execOrStop(deps.exec, 'git log -1 --pretty=%s');
      if (!subject.ok || !subject.output.includes(BETA_MARKER)) {
        capturePhase.finish();
        finishState(
          state,
          deps.clock,
          'stopped-beta-incomplete',
          `Captured HEAD subject must include ${BETA_MARKER}; refusing to push a beta trigger implicitly.`
        );
        return resultFromState(state);
      }
      capturePhase.finish();

      const deRiskPhase = phase(state, deps.clock, 'pre-beta-de-risk');
      for (const command of opts.preBetaCommands) {
        log(`Running pre-beta de-risk: ${command}`);
        const result = deps.exec(command, { timeoutMs: 30 * 60 * 1000 });
        if (!result.success) {
          deRiskPhase.finish();
          finishState(
            state,
            deps.clock,
            'beta-failed',
            `Pre-beta de-risk command failed: ${command}: ${result.error || result.output}`
          );
          return resultFromState(state);
        }
      }
      deRiskPhase.finish();

      const pushPhase = phase(state, deps.clock, 'push-beta-trigger');
      const pushTimeIso = safeIso(deps.clock);
      log(`Pushing beta trigger via sanctioned path: ${opts.pushBetaCommand}`);
      const pushed = deps.exec(opts.pushBetaCommand, { timeoutMs: 45 * 60 * 1000 });
      if (!pushed.success) {
        pushPhase.finish();
        finishState(state, deps.clock, 'beta-failed', `Beta trigger push failed: ${pushed.error || pushed.output}`);
        return resultFromState(state);
      }
      pushPhase.finish();

      const bindWaitPhase = phase(state, deps.clock, 'find-dispatched-beta-run');
      const found = await waitForDispatchedRun(deps, {
        repo: opts.repo,
        capturedHeadSha,
        pushTimeIso,
        timeoutMs: opts.betaDispatchWaitMs,
        pollIntervalMs: opts.pollIntervalMs,
      });
      bindWaitPhase.finish();
      if (found.kind !== 'found') {
        const reason = found.kind === 'blocked' ? found.message : found.reason;
        finishState(state, deps.clock, 'stopped-beta-incomplete', reason);
        return resultFromState(state);
      }
      releaseRun = found.run;
      state.dispatchedRun = releaseRun;
    }

    if (releaseRun === null) {
      finishState(state, deps.clock, 'stopped-beta-incomplete', 'No beta release run was selected.');
      return resultFromState(state);
    }

    const bindPhase = phase(state, deps.clock, 'bind-candidate');
    const bound = bindCandidate(
      { exec: deps.exec },
      {
        devHeadSha: releaseRun.headSha,
        releaseRun,
        gcsManifestPath: DEFAULT_BETA_GCS_MANIFEST_PATH,
      }
    );
    bindPhase.finish();
    if (bound.kind !== 'bound') {
      finishState(state, deps.clock, 'stopped-beta-incomplete', bound.message);
      return resultFromState(state);
    }
    state.binding = bound.binding;
    state.manifestVersions.sourcePackageVersion = bound.binding.sourcePackageVersion;
    state.manifestVersions.betaPublishedVersion = bound.binding.betaPublishedVersion;

    const watchPhase = phase(state, deps.clock, 'watch-beta');
    const watched = await watchBetaRun(deps, {
      repo: opts.repo,
      runId: bound.binding.releaseRun.runId,
      timeoutMs: opts.betaWatchWindowMs,
      pollIntervalMs: opts.pollIntervalMs,
    });
    watchPhase.finish();
    if (watched.kind === 'incomplete') {
      finishState(state, deps.clock, 'stopped-beta-incomplete', watched.reason);
      return resultFromState(state);
    }
    state.dispatchedRun = watched.run;
    const watchedRunMatch = matchesBinding(bound.binding, {
      runId: watched.run.runId,
      databaseId: watched.run.databaseId,
      headSha: watched.run.headSha,
    });
    if (watchedRunMatch.kind !== 'match') {
      const watchedRunMismatchReason = [
        `Watched beta run drifted from the bound candidate: ${watchedRunMatch.message}`,
        `(${watchedRunMatch.field}: expected ${watchedRunMatch.expected}, observed ${String(watchedRunMatch.observed)}).`,
      ].join(' ');
      finishState(
        state,
        deps.clock,
        'stopped-beta-incomplete',
        watchedRunMismatchReason
      );
      return resultFromState(state);
    }
    if (watched.run.conclusion !== 'success') {
      finishState(state, deps.clock, 'beta-failed', `Beta run concluded ${String(watched.run.conclusion)}.`);
      return resultFromState(state);
    }

    const cleanPhase = phase(state, deps.clock, 'gate-clean-green');
    const cleanGreen = await evaluateCleanGreenGate(deps, opts.repo, bound.binding);
    state.gates.cleanGreen = {
      input: { runId: bound.binding.releaseRun.runId, betaPublishedVersion: bound.binding.betaPublishedVersion },
      output: cleanGreen,
    };
    cleanPhase.finish();
    if (cleanGreen.cleanGreen !== true) {
      finishState(state, deps.clock, 'stopped-at-gate-clean-green', cleanGreen.reasons.join(' '));
      return resultFromState(state);
    }

    const sentryPhase = phase(state, deps.clock, 'gate-sentry');
    const sentry = await evaluateSentryPromoteGate(deps, bound.binding);
    state.gates.sentry = {
      input: { betaPublishedVersion: bound.binding.betaPublishedVersion, queryUrl: sentryQueryUrl(bound.binding.betaPublishedVersion) },
      output: sentry,
    };
    sentryPhase.finish();
    if (sentry.sentryClean !== true) {
      finishState(state, deps.clock, 'stopped-at-gate-sentry', sentry.reasons.join(' '));
      return resultFromState(state);
    }

    const preflightPhase = phase(state, deps.clock, 'gate-promote-preflight');
    const preflight = deps.evaluatePreflightGate
      ? deps.evaluatePreflightGate(bound.binding, { repo: opts.repo, repoRoot: opts.repoRoot })
      : evaluateRealPreflightGate(deps, {
          repo: opts.repo,
          repoRoot: opts.repoRoot,
          binding: bound.binding,
        });
    state.gates.preflight = {
      input: { sha: bound.binding.devHeadSha },
      output: preflight,
    };
    preflightPhase.finish();
    if (!preflight.eligible) {
      finishState(state, deps.clock, 'stopped-at-gate-preflight', preflight.summary);
      return resultFromState(state);
    }

    const armingPhase = phase(state, deps.clock, 'verify-arming');
    const arming = verifyArming(
      { now: deps.clock.now },
      {
        flags: opts.armingFlags,
        binding: bound.binding,
        armedAtIso: opts.armedAtIso,
        ttlMs: opts.armingTtlMs,
      }
    );
    state.arming = arming;
    armingPhase.finish();

    // CATASTROPHIC INVARIANT: this is the only `spawnAdvance` call site.
    // It is reachable only after every prior gate has returned and the exact
    // candidate-bound arming helper says armed, and never in dry-run mode.
    if (arming.armed === true && opts.dryRun !== true) {
      const advancePhase = phase(state, deps.clock, 'advance-subprocess');
      const request = buildPromoteSubprocessRequest(bound.binding);
      const advance = await deps.spawnAdvance(request);
      state.advance = { request, result: advance };
      state.stableRunId = advance.stableRunId;
      advancePhase.finish();
      if (advance.exitCode !== 0) {
        const exitName = advance.exitName ?? exitNameFromCode(advance.exitCode);
        finishState(state, deps.clock, `promote-driver-${exitName}`, `Promote driver exited ${advance.exitCode}.`);
        return resultFromState(state);
      }
      finishState(state, deps.clock, 'promoted', 'Promote driver exited 0.');
      return resultFromState(state);
    }

    const reason = opts.dryRun
      ? 'DRY RUN: all gates passed and no advance was invoked.'
      : arming.reasons.join(' ');
    finishState(state, deps.clock, 'not-armed-stopped-before-advance', reason);
    return resultFromState(state);
  } finally {
    await lock.release();
  }
}

export function explainChainState(state: ChainState): Record<string, unknown> {
  return {
    terminalStatus: state.terminalStatus,
    stopReason: state.stopReason,
    dryRun: state.dryRun,
    repo: state.repo,
    sourceSha: state.sourceSha,
    dispatchedRunId: state.binding?.releaseRun.runId ?? state.dispatchedRun?.runId,
    stableRunId: state.stableRunId,
    sourcePackageVersion: state.binding?.sourcePackageVersion,
    betaPublishedVersion: state.binding?.betaPublishedVersion,
    ghActor: state.ghActor,
    startedAtIso: state.startedAtIso,
    endedAtIso: state.endedAtIso,
    timings: state.timings,
    gates: state.gates,
    sentryQueryUrl: state.gates.sentry?.input.queryUrl,
    arming: state.arming,
    manualFinishCommand: state.manualFinishCommand,
    advance: state.advance,
    notes: state.notes,
  };
}

export function renderChainReport(state: ChainState): string {
  const lines: string[] = [];
  lines.push('# Overnight Release Chain Report');
  lines.push('');
  lines.push(`Terminal status: ${state.terminalStatus}`);
  lines.push(`Verdict: ${verdictText(state)}`);
  if (state.stopReason) lines.push(`Stop reason: ${state.stopReason}`);
  lines.push('');
  lines.push('## Evidence');
  lines.push(`- Source SHA: ${state.sourceSha ?? state.binding?.devHeadSha ?? '<unknown>'}`);
  lines.push(`- Dispatched beta run id: ${String(state.binding?.releaseRun.runId ?? state.dispatchedRun?.runId ?? '<unknown>')}`);
  lines.push(`- Stable run id: ${String(state.stableRunId ?? '<unknown>')}`);
  lines.push(`- Source package version: ${state.binding?.sourcePackageVersion ?? '<unknown>'}`);
  lines.push(`- Beta published version: ${state.binding?.betaPublishedVersion ?? '<unknown>'}`);
  lines.push(`- gh actor: ${state.ghActor ?? '<unknown>'}`);
  lines.push(`- Started: ${state.startedAtIso}`);
  lines.push(`- Ended: ${state.endedAtIso}`);
  lines.push(`- Sentry query URL: ${state.gates.sentry?.input.queryUrl ?? '<not evaluated>'}`);
  lines.push(`- Arming: ${state.arming?.armed === true ? 'armed' : 'not armed'}`);
  lines.push(`- Arming attestation: ${JSON.stringify(state.arming?.attestation ?? null)}`);
  lines.push(`- Manifest versions: ${JSON.stringify(state.manifestVersions)}`);
  lines.push(`- Timings: ${JSON.stringify(state.timings)}`);
  lines.push('');
  lines.push('## Gates');
  lines.push(`- Clean-green: ${JSON.stringify(state.gates.cleanGreen ?? null)}`);
  lines.push(`- Sentry: ${JSON.stringify(state.gates.sentry ?? null)}`);
  lines.push(`- Promote preflight: ${JSON.stringify(state.gates.preflight ?? null)}`);
  lines.push('');
  lines.push('## Manual Finish / Retry');
  if (state.terminalStatus === 'promoted') {
    lines.push('Already promoted by the subprocess driver; no finish command is needed.');
  } else if (state.manualFinishCommand) {
    lines.push(state.manualFinishCommand);
  } else {
    lines.push('No bound SHA/version is available yet; re-run the chain after resolving the stop reason.');
  }
  lines.push('');
  lines.push('## Notes');
  for (const note of state.notes) lines.push(`- ${note}`);
  return lines.join('\n');
}

function verdictText(state: ChainState): string {
  if (state.terminalStatus === 'promoted') {
    return 'Promoted. Deterministic gates PASSED; soak NOT evaluated; morning review is the response window.';
  }
  if (
    state.terminalStatus === 'not-armed-stopped-before-advance' &&
    state.dryRun &&
    state.arming?.armed === true
  ) {
    return 'DRY RUN ONLY: deterministic gates PASSED and arming matched, but no advance was invoked; soak NOT evaluated; morning review is the response window.';
  }
  if (state.terminalStatus.startsWith('promote-driver-')) {
    const exitCode = state.advance?.result?.exitCode;
    const exitText = exitCode === undefined ? 'with an unknown exit code' : `exited ${exitCode}`;
    return `ADVANCE ATTEMPTED - \`main\` MAY HAVE ADVANCED. The promote driver ${exitText} and did NOT confirm a completed ship. Investigate \`main\`/the stable run before re-running.`;
  }
  if (state.gates.cleanGreen?.output.cleanGreen === true && state.gates.sentry?.output.sentryClean === true && state.gates.preflight?.output.eligible === true) {
    return 'Deterministic gates PASSED; soak NOT evaluated; morning review is the response window. Stopped before advance.';
  }
  return 'Stopped fail-closed. Production was not advanced by this orchestrator.';
}

export function realExec(repoRoot: string): ExecFn {
  return (command: string, opts?: ExecOpts): ExecResult => {
    try {
      const output = execSync(command, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: opts?.timeoutMs ?? 30_000,
        maxBuffer: MAX_EXEC_BUFFER_BYTES,
        env: opts?.env ? { ...process.env, ...opts.env } : process.env,
      }) as string;
      return { success: true, output: output.trim() };
    } catch (error) {
      const err = error as { status?: number; stdout?: Buffer; stderr?: Buffer; message?: string };
      return {
        success: false,
        output: err.stdout?.toString().trim() || '',
        error: err.stderr?.toString().trim() || err.message || 'Unknown error',
        exitCode: err.status,
      };
    }
  };
}

async function realFetchManifest(betaPublishedVersion: string): Promise<ManifestFetchResult> {
  try {
    const response = await fetch(DEFAULT_BETA_GCS_MANIFEST_PATH, { cache: 'no-store' });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status} while reading beta manifest for ${betaPublishedVersion}` };
    }
    return { ok: true, manifest: await response.json() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const realFetchSentry: FetchSentry = async (url: string, init?: FetchSentryInit): Promise<FetchSentryResult> => {
  try {
    const response = await fetch(url, { headers: init?.headers });
    if (!response.ok) {
      return { ok: false, status: response.status, error: await response.text() };
    }
    return { ok: true, status: response.status, json: await response.json() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

async function realSpawnAdvance(request: SpawnAdvanceRequest): Promise<SpawnAdvanceResult> {
  const result = spawnSync(request.command, request.args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_EXEC_BUFFER_BYTES,
    env: { ...process.env, ...request.env },
  });
  const exitCode = result.status ?? OVERNIGHT_EXIT_CODES.UNKNOWN_ERROR;
  return {
    exitCode,
    exitName: exitCode === 0 ? 'success' : exitNameFromCode(exitCode),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

class OvernightReleaseChainCommand extends Command {
  static paths = [['overnight-release-chain'], ['overnight-release'], Command.Default];

  static usage = Command.Usage({
    description: 'Run the deterministic overnight beta -> gates -> optional production advance chain',
  });

  dryRun = Option.Boolean('--dry-run', false, {
    description: 'Evaluate a given/latest historical beta run and never push or advance main',
  });

  explainJson = Option.Boolean('--explain-json', false, {
    description: 'Print gathered facts and terminal decision as JSON',
  });

  dryRunRunId = Option.String('--dry-run-run-id', {
    description: 'Historical beta release.yml run id to evaluate in --dry-run mode',
  });

  armProduction = Option.Boolean('--arm-production', false, {
    description: 'Arm production advance for the exact bound candidate',
  });

  candidateSha = Option.String('--candidate-sha', {
    description: 'Exact candidate SHA required when --arm-production is used',
  });

  confirmChangelogCurrent = Option.String('--confirm-changelog-current', {
    description: 'Exact source package version required by arming and the promote driver',
  });

  armedAtIso = Option.String('--armed-at-iso', {
    description: 'ISO timestamp when the operator armed this candidate',
  });

  attestS8aGreenInCi = Option.Boolean('--attest-s8a-green-in-ci', false, {
    description: 'Operator attests S8a is merged and green in CI',
  });

  attestPolicySignedOff = Option.Boolean('--attest-policy-signed-off', false, {
    description: 'Operator attests policy/go-live sign-off is present',
  });

  acceptNoSoakNoPaging = Option.Boolean('--accept-no-soak-no-paging', false, {
    description: 'Accept the named no-soak/no-paging risk clause',
  });

  betaDispatchWaitMinutes = Option.String('--beta-dispatch-wait-minutes', {
    description: 'Bounded wait for the dispatched beta run (default 10)',
  });

  betaWatchMinutes = Option.String('--beta-watch-minutes', {
    description: 'Bounded beta watch window (default 180)',
  });

  async execute(): Promise<number> {
    const repoRootResult = realExec(process.cwd())('git rev-parse --show-toplevel');
    const repoRoot = repoRootResult.success ? repoRootResult.output : process.cwd();
    const exec = realExec(repoRoot);
    const dryRunRunId = parsePositiveInt(this.dryRunRunId, '--dry-run-run-id');
    const result = await runOvernightReleaseChain(
      {
        repoRoot,
        dryRun: this.dryRun,
        explainJson: this.explainJson,
        dryRunRunId,
        betaDispatchWaitMs: msFromMinutes(this.betaDispatchWaitMinutes, '--beta-dispatch-wait-minutes'),
        betaWatchWindowMs: msFromMinutes(this.betaWatchMinutes, '--beta-watch-minutes'),
        armingFlags: {
          armProduction: this.armProduction,
          candidateSha: this.candidateSha,
          confirmChangelogCurrent: this.confirmChangelogCurrent,
          attestS8aGreenInCi: this.attestS8aGreenInCi,
          attestPolicySignedOff: this.attestPolicySignedOff,
          acceptNoSoakNoPaging: this.acceptNoSoakNoPaging,
        },
        armedAtIso: this.armedAtIso,
      },
      {
        exec,
        spawnAdvance: realSpawnAdvance,
        clock: { now: () => new Date() },
        sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
        fetchSentry: realFetchSentry,
        fetchManifest: realFetchManifest,
        getEnv: (key) => process.env[key],
        log: (message) => this.context.stdout.write(`${message}\n`),
      }
    );
    this.context.stdout.write(`${this.explainJson && result.explainJson ? result.explainJson : result.report}\n`);
    return result.exitCode;
  }
}

const cli = new Cli({
  binaryLabel: 'Overnight Release Chain',
  binaryName: 'overnight-release-chain',
  binaryVersion: '1.0.0',
});

cli.register(OvernightReleaseChainCommand);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli.runExit(process.argv.slice(2));
}

export { UsageError };
