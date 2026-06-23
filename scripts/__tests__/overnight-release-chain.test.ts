import { describe, expect, it, vi } from 'vitest';

import {
  OVERNIGHT_EXIT_CODES,
  buildPromoteSubprocessRequest,
  realExec,
  renderChainReport,
  runOvernightReleaseChain,
  type Clock,
  type OvernightReleaseChainDeps,
  type OvernightReleaseChainOptions,
} from '../overnight-release-chain';
import { EXPECTED_BETA_PLATFORMS, type CleanGreenVerdict, type ManifestFetchResult } from '../lib/ci-clean-green';
import type { FetchSentry, FetchSentryResult } from '../lib/sentry-promote-gate';
import type { ReleaseArmingFlags } from '../lib/release-arming';
import type { PromotePreflightVerdict } from '../promote-preflight';
import type { ExecFn, ExecOpts, ExecResult } from '../promote-preflight-facts';

// SAFETY: every test injects exec/fetch/spawn/clock/sleep. No real git, gh,
// network, Sentry, subprocess, beta push, or main advance can run.

const SHA = '428259cb83e22a32fdcc36bf538002f81fdd9fa8';
const SOURCE_VERSION = '0.4.49';
const MAIN_VERSION = '0.4.48';
const COMMIT_COUNT = '4282';
const BETA_VERSION = '0.4.494282';
const RUN_ID = 27803427419;
const DRIFT_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OWNER_REPO = 'mindstone/rebel-app';
const NOW_ISO = '2026-06-21T20:00:00.000Z';
const ARMED_AT_ISO = '2026-06-21T18:00:00.000Z';
const EXPECTED_FINISH_COMMAND = `npx tsx scripts/promote-to-production.ts --commit ${SHA} --confirm-changelog-current ${SOURCE_VERSION}`;

const GITMODULES_CONTENT = `[submodule "rebel-system"]
\tpath = rebel-system
\turl = [external-email]:mindstone/rebel-system.git
\tbranch = main
`;

const CHANGELOG_WITH_HEADING = `# Changelog\n\n## v${SOURCE_VERSION}\n\n- Shipped.\n`;

const PASSING_PREFLIGHT: PromotePreflightVerdict = {
  eligible: true,
  blockers: [],
  gates: [],
  summary: 'eligible',
};

const BLOCKING_PREFLIGHT: PromotePreflightVerdict = {
  eligible: false,
  blockers: ['changelog-heading'],
  gates: [
    {
      gate: 'changelog-heading',
      status: 'block',
      reason: 'Missing changelog heading at the bound SHA.',
    },
  ],
  summary: 'changelog-heading blocked',
};

type RecordingExec = ExecFn & { calls: string[]; callsWithOpts: Array<{ cmd: string; opts?: ExecOpts }> };

interface TestStep {
  name: string;
  status: 'completed';
  conclusion: string | null;
}

interface TestJob {
  name: string;
  status: 'completed';
  conclusion: string | null;
  steps: TestStep[];
}

function makeExec(rules: Array<[string, Partial<ExecResult>]>): RecordingExec {
  const calls: string[] = [];
  const callsWithOpts: Array<{ cmd: string; opts?: ExecOpts }> = [];
  const fn = ((cmd: string, opts?: ExecOpts): ExecResult => {
    calls.push(cmd);
    callsWithOpts.push({ cmd, opts });
    for (const [needle, result] of rules) {
      if (cmd.includes(needle)) {
        return { success: true, output: '', ...result };
      }
    }
    return { success: false, output: '', error: `unstubbed: ${cmd}`, exitCode: 1 };
  }) as RecordingExec;
  fn.calls = calls;
  fn.callsWithOpts = callsWithOpts;
  return fn;
}

function step(name: string, conclusion = 'success'): TestStep {
  return { name, status: 'completed', conclusion };
}

function job(name: string, conclusion = 'success', steps: TestStep[] = []): TestJob {
  return { name, status: 'completed', conclusion, steps };
}

function greenJobs(overrides: { publishConclusion?: string | null; e2eStepConclusion?: string | null } = {}): TestJob[] {
  return [
    job('Publish to Google Cloud Storage', overrides.publishConclusion ?? 'success'),
    job('Desktop Boot Smoke (macOS)', 'success', [
      step('Boot smoke (launch packaged app, assert appReady)'),
    ]),
    job('GPU Worker WASM Smoke (macos-latest)', 'success', [
      step('GPU-worker WASM smoke (init + embed, assert no crash)'),
    ]),
    job('GPU Worker WASM Smoke (windows-latest)', 'success', [
      step('GPU-worker WASM smoke (init + embed, assert no crash)'),
    ]),
    job('Real-Boot Agent-Turn (observe-first, both channels)', 'success'),
    job('E2E Tests (macOS)', 'success', [
      step('Run Playwright E2E tests'),
      step('E2E flake summary', overrides.e2eStepConclusion ?? 'success'),
    ]),
  ];
}

function runViewRun(
  overrides: Partial<{ databaseId: number; headSha: string; status: string; conclusion: string | null; event: string }> = {}
): string {
  return JSON.stringify({
    databaseId: overrides.databaseId ?? RUN_ID,
    headSha: overrides.headSha ?? SHA,
    event: overrides.event ?? 'workflow_dispatch',
    createdAt: '2026-06-21T20:01:00.000Z',
    status: overrides.status ?? 'completed',
    conclusion: overrides.conclusion ?? 'success',
    displayTitle: 'Release Build and Publish',
  });
}

function runList(): string {
  return JSON.stringify([
    {
      databaseId: RUN_ID,
      headSha: SHA,
      event: 'workflow_dispatch',
      createdAt: '2026-06-21T20:01:00.000Z',
      status: 'in_progress',
      conclusion: null,
      displayTitle: 'Release Build and Publish',
    },
  ]);
}

function machineLine(verdict: CleanGreenVerdict): string {
  return JSON.stringify({
    kind: 'e2e-flake-summary',
    verdict,
    expected: verdict === 'clean-green' ? 12 : 11,
    flaky: verdict === 'shippable-but-flaky' ? 1 : 0,
    unexpected: verdict === 'red' ? 1 : 0,
    skipped: 0,
    total: 12,
  });
}

function runLog(verdict: CleanGreenVerdict): string {
  return `E2E Tests (macOS)\tE2E flake summary\tFlake summary: ${machineLine(verdict)}`;
}

function manifest(platforms: readonly string[] = EXPECTED_BETA_PLATFORMS): ManifestFetchResult {
  return {
    ok: true,
    manifest: {
      version: BETA_VERSION,
      channel: 'beta',
      platforms: Object.fromEntries(platforms.map((platform) => [platform, { url: `https://example.com/${platform}` }])),
    },
  };
}

function releaseObserved(): FetchSentryResult {
  return { ok: true, status: 200, json: { version: `mindstone-rebel-beta@${BETA_VERSION}` } };
}

function issues(rows: unknown[]): FetchSentryResult {
  return { ok: true, status: 200, json: rows };
}

function issue(): unknown {
  return { id: '4500000000000000', shortId: 'REBEL-123', title: 'Fatal startup regression' };
}

function makeFetchSentry(rows: unknown[] = []): FetchSentry {
  return async (url: string): Promise<FetchSentryResult> => {
    if (url.includes('/releases/')) return releaseObserved();
    if (url.includes('/issues/')) return issues(rows);
    return { ok: false, status: 500, error: `unstubbed ${url}` };
  };
}

function fullArmingFlags(overrides: Partial<ReleaseArmingFlags> = {}): ReleaseArmingFlags {
  return {
    armProduction: true,
    candidateSha: SHA,
    confirmChangelogCurrent: SOURCE_VERSION,
    attestS8aGreenInCi: true,
    attestPolicySignedOff: true,
    acceptNoSoakNoPaging: true,
    ...overrides,
  };
}

function baseRules(overrides: Array<[string, Partial<ExecResult>]> = []): Array<[string, Partial<ExecResult>]> {
  return [
    ...overrides,
    ['gh api user --jq .login', { output: 'gdetre' }],
    ['git rev-parse HEAD', { output: SHA }],
    ['git log -1 --pretty=%s', { output: 'chore(release): Trigger beta deploy [deploy-beta]' }],
    ['prebeta', { output: 'ok' }],
    ['safe-push', { output: 'ok' }],
    [
      `gh run view ${RUN_ID} --repo ${OWNER_REPO} --json databaseId,headSha,event,createdAt,status,conclusion,displayTitle`,
      { output: runViewRun() },
    ],
    ['--workflow release.yml --branch dev --limit 50', { output: runList() }],
    [`git show ${SHA}:package.json`, { output: JSON.stringify({ version: SOURCE_VERSION }) }],
    [`git rev-list --count ${SHA}`, { output: COMMIT_COUNT }],
    ['git fetch --quiet origin +refs/heads/main:refs/remotes/origin/main +refs/heads/dev:refs/remotes/origin/dev', { output: '' }],
    [`git rev-parse --verify ${SHA}^{commit}`, { output: SHA }],
    [`git merge-base --is-ancestor ${SHA} origin/dev`, { output: '' }],
    [`git show origin/main:package.json`, { output: JSON.stringify({ version: MAIN_VERSION }) }],
    [`gh run list --repo ${OWNER_REPO} --workflow release.yml --branch dev --commit ${SHA}`, { output: JSON.stringify([{ databaseId: RUN_ID, headSha: SHA, status: 'completed', conclusion: 'success' }]) }],
    [`gh run view ${RUN_ID} --repo ${OWNER_REPO} --json jobs`, { output: JSON.stringify({ jobs: greenJobs() }) }],
    [`git ls-tree ${SHA} rebel-system`, { output: `160000 commit 9807d9d20aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trebel-system` }],
    ['git -C rebel-system show', { output: CHANGELOG_WITH_HEADING }],
    [`git show ${SHA}:.gitmodules`, { output: GITMODULES_CONTENT }],
    ['git -C rebel-system fetch --quiet origin', { output: '' }],
    ['git -C rebel-system merge-base --is-ancestor', { output: '' }],
    [`gh run view ${RUN_ID} --repo ${OWNER_REPO} --log`, { output: runLog('clean-green') }],
  ];
}

function makeClock(): { clock: Clock; advance: (ms: number) => void } {
  let nowMs = Date.parse(NOW_ISO);
  return {
    clock: { now: () => new Date(nowMs) },
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function baseOpts(overrides: OvernightReleaseChainOptions = {}): OvernightReleaseChainOptions {
  return {
    repo: OWNER_REPO,
    repoRoot: '/repo',
    preBetaCommands: ['prebeta'],
    pushBetaCommand: 'safe-push',
    betaDispatchWaitMs: 10,
    betaWatchWindowMs: 10,
    pollIntervalMs: 1,
    ...overrides,
  };
}

interface Harness {
  exec: RecordingExec;
  spawnAdvance: ReturnType<typeof vi.fn>;
  deps: OvernightReleaseChainDeps;
}

function makeHarness(
  rules: Array<[string, Partial<ExecResult>]> = baseRules(),
  overrides: Partial<OvernightReleaseChainDeps> = {}
): Harness {
  const exec = makeExec(rules);
  const { clock, advance } = makeClock();
  const spawnAdvance = vi.fn(async () => ({ exitCode: 0, stableRunId: 99999 }));
  const deps: OvernightReleaseChainDeps = {
    exec,
    spawnAdvance,
    clock,
    sleep: async (ms: number) => advance(ms),
    fetchSentry: makeFetchSentry(),
    fetchManifest: async () => manifest(),
    getEnv: (key) => (key === 'SENTRY_AUTH_TOKEN' ? 'sntrys-token' : undefined),
    isCleanFastForward: () => true,
    acquireRunLock: async () => ({ acquired: true, release: () => undefined }),
    ...overrides,
  };
  return { exec, spawnAdvance, deps };
}

function expectStoppedWithFinishCommand(report: string): void {
  expect(report).toContain(EXPECTED_FINISH_COMMAND);
  expect(report).toContain(`REBEL_OVERNIGHT_BETA_RUN_ID=${RUN_ID}`);
}

function issuedBetaPush(exec: RecordingExec): boolean {
  return exec.calls.some((call) => call.includes('safe-push'));
}

describe('buildPromoteSubprocessRequest', () => {
  it('builds the mandatory subprocess command with bound SHA and source version', () => {
    const request = buildPromoteSubprocessRequest({
      devHeadSha: SHA,
      releaseRun: {
        runId: RUN_ID,
        databaseId: RUN_ID,
        event: 'workflow_dispatch',
        branch: 'dev',
        headSha: SHA,
        createdAt: '2026-06-21T19:01:00.000Z',
        status: 'completed',
        conclusion: 'success',
        displayTitle: 'Release Build and Publish',
      },
      sourcePackageVersion: SOURCE_VERSION,
      betaPublishedVersion: BETA_VERSION,
      gcsManifestPath: 'https://storage.googleapis.com/mindstone-rebel/releases-beta/latest.json',
    });

    expect(request.command).toBe('npx');
    expect(request.args).toEqual([
      'tsx',
      'scripts/promote-to-production.ts',
      '--commit',
      SHA,
      '--confirm-changelog-current',
      SOURCE_VERSION,
    ]);
    expect(request.env.REBEL_CERTIFIED_PROMOTE_SHA).toBe(SHA);
  });
});

describe('renderChainReport', () => {
  it('never renders a bare GO-style verdict when deterministic gates passed', () => {
    const report = renderChainReport({
      terminalStatus: 'not-armed-stopped-before-advance',
      dryRun: false,
      explainJson: false,
      repo: OWNER_REPO,
      startedAtIso: NOW_ISO,
      endedAtIso: NOW_ISO,
      gates: {
        cleanGreen: { input: { runId: RUN_ID, betaPublishedVersion: BETA_VERSION }, output: { cleanGreen: true, reasons: [] } },
        sentry: { input: { betaPublishedVersion: BETA_VERSION, queryUrl: 'https://example.com' }, output: { sentryClean: true, releaseObserved: true, blockingIssues: 0, reasons: [] } },
        preflight: { input: { sha: SHA }, output: { eligible: true, blockers: [], gates: [], summary: 'eligible' } },
      },
      manifestVersions: {},
      timings: {},
      notes: [],
    });

    expect(report).toContain('soak NOT evaluated; morning review is the response window');
    expect(report).not.toContain('GO');
    expect(report).not.toContain('promoted-clean');
  });
});

describe('runOvernightReleaseChain safety matrix', () => {
  it('beta failed ⇒ beta-failed, finish command present, advance never invoked', async () => {
    const h = makeHarness(
      baseRules([
        [
          `gh run view ${RUN_ID} --repo ${OWNER_REPO} --json databaseId,headSha,event,createdAt,status,conclusion,displayTitle`,
          { output: runViewRun({ conclusion: 'failure' }) },
        ],
      ])
    );

    const result = await runOvernightReleaseChain(baseOpts(), h.deps);

    expect(result.state.terminalStatus).toBe('beta-failed');
    expectStoppedWithFinishCommand(result.report);
    expect(h.spawnAdvance).not.toHaveBeenCalled();
  });

  it('beta incomplete ⇒ stopped-beta-incomplete, finish command present, advance never invoked', async () => {
    const h = makeHarness(
      baseRules([
        [
          `gh run view ${RUN_ID} --repo ${OWNER_REPO} --json databaseId,headSha,event,createdAt,status,conclusion,displayTitle`,
          { output: runViewRun({ status: 'in_progress', conclusion: null }) },
        ],
      ])
    );

    const result = await runOvernightReleaseChain(baseOpts({ betaWatchWindowMs: 1 }), h.deps);

    expect(result.state.terminalStatus).toBe('stopped-beta-incomplete');
    expectStoppedWithFinishCommand(result.report);
    expect(h.spawnAdvance).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'headSha',
      watchedRun: runViewRun({ headSha: DRIFT_SHA }),
      expectedField: 'headSha',
    },
    {
      name: 'runId',
      watchedRun: runViewRun({ databaseId: RUN_ID + 1 }),
      expectedField: 'runId',
    },
  ])(
    'watched beta run $name drift ⇒ stopped-beta-incomplete before gates, advance never invoked',
    async ({ watchedRun, expectedField }) => {
      const h = makeHarness(
        baseRules([
          [
            `gh run view ${RUN_ID} --repo ${OWNER_REPO} --json databaseId,headSha,event,createdAt,status,conclusion,displayTitle`,
            { output: watchedRun },
          ],
        ]),
        { evaluatePreflightGate: () => PASSING_PREFLIGHT }
      );

      const result = await runOvernightReleaseChain(
        baseOpts({
          armingFlags: fullArmingFlags(),
          armedAtIso: ARMED_AT_ISO,
        }),
        h.deps
      );

      expect(result.state.terminalStatus).toBe('stopped-beta-incomplete');
      expect(result.report).toContain('Watched beta run drifted from the bound candidate');
      expect(result.report).toContain(`Observed ${expectedField} does not match the frozen candidate binding`);
      expect(h.exec.calls.some((call) => call.includes('--json jobs'))).toBe(false);
      expect(h.spawnAdvance).not.toHaveBeenCalled();
    }
  );

  it('clean-green blocks ⇒ stopped-at-gate-clean-green, finish command present, advance never invoked', async () => {
    const h = makeHarness(
      baseRules([
        [`gh run view ${RUN_ID} --repo ${OWNER_REPO} --log`, { output: runLog('shippable-but-flaky') }],
      ])
    );

    const result = await runOvernightReleaseChain(baseOpts(), h.deps);

    expect(result.state.terminalStatus).toBe('stopped-at-gate-clean-green');
    expect(result.report).toContain('shippable-but-flaky');
    expectStoppedWithFinishCommand(result.report);
    expect(h.spawnAdvance).not.toHaveBeenCalled();
  });

  it('Sentry blocks ⇒ stopped-at-gate-sentry, finish command present, advance never invoked', async () => {
    const h = makeHarness(baseRules(), { fetchSentry: makeFetchSentry([issue()]) });

    const result = await runOvernightReleaseChain(baseOpts(), h.deps);

    expect(result.state.terminalStatus).toBe('stopped-at-gate-sentry');
    expect(result.report).toContain('unresolved error/fatal issue');
    expectStoppedWithFinishCommand(result.report);
    expect(h.spawnAdvance).not.toHaveBeenCalled();
  });

  it('preflight blocks ⇒ stopped-at-gate-preflight, finish command present, advance never invoked', async () => {
    const h = makeHarness(baseRules(), { evaluatePreflightGate: () => BLOCKING_PREFLIGHT });

    const result = await runOvernightReleaseChain(baseOpts(), h.deps);

    expect(result.state.terminalStatus).toBe('stopped-at-gate-preflight');
    expect(result.report).toContain('changelog-heading');
    expectStoppedWithFinishCommand(result.report);
    expect(h.spawnAdvance).not.toHaveBeenCalled();
  });

  it('not armed ⇒ not-armed-stopped-before-advance, finish command present, advance never invoked', async () => {
    const h = makeHarness(baseRules(), { evaluatePreflightGate: () => PASSING_PREFLIGHT });

    const result = await runOvernightReleaseChain(baseOpts(), h.deps);

    expect(result.state.terminalStatus).toBe('not-armed-stopped-before-advance');
    expect(result.report).toContain('not armed');
    expectStoppedWithFinishCommand(result.report);
    expect(h.spawnAdvance).not.toHaveBeenCalled();
  });

  it('armed happy path ⇒ advance invoked exactly once with bound SHA and source version', async () => {
    const h = makeHarness(baseRules(), { evaluatePreflightGate: () => PASSING_PREFLIGHT });

    const result = await runOvernightReleaseChain(
      baseOpts({
        armingFlags: fullArmingFlags(),
        armedAtIso: ARMED_AT_ISO,
      }),
      h.deps
    );

    expect(result.state.terminalStatus).toBe('promoted');
    expect(h.spawnAdvance).toHaveBeenCalledTimes(1);
    const request = h.spawnAdvance.mock.calls[0]?.[0];
    expect(request?.command).toBe('npx');
    expect(request?.args).toContain(SHA);
    expect(request?.args).toContain(SOURCE_VERSION);
  });

  it('armed path maps a non-zero promote subprocess exit to promote-driver-<exitname>', async () => {
    const spawnAdvance = vi.fn(async () => ({ exitCode: 30, exitName: 'run-not-triggered' }));
    const h = makeHarness(baseRules(), { spawnAdvance, evaluatePreflightGate: () => PASSING_PREFLIGHT });

    const result = await runOvernightReleaseChain(
      baseOpts({
        armingFlags: fullArmingFlags(),
        armedAtIso: ARMED_AT_ISO,
      }),
      h.deps
    );

    expect(result.state.terminalStatus).toBe('promote-driver-run-not-triggered');
    expect(spawnAdvance).toHaveBeenCalledTimes(1);
    expect(result.report).toContain(
      'Verdict: ADVANCE ATTEMPTED - `main` MAY HAVE ADVANCED. The promote driver exited 30 and did NOT confirm a completed ship. Investigate `main`/the stable run before re-running.'
    );
    expect(result.report).not.toContain('Stopped before advance');
    expect(result.report).toContain('Promote driver exited 30');
    expectStoppedWithFinishCommand(result.report);
  });

  it('dry-run with armed green candidate never pushes beta and never invokes advance', async () => {
    const h = makeHarness(baseRules(), { evaluatePreflightGate: () => PASSING_PREFLIGHT });

    const result = await runOvernightReleaseChain(
      baseOpts({
        dryRun: true,
        explainJson: true,
        dryRunRunId: RUN_ID,
        armingFlags: fullArmingFlags(),
        armedAtIso: ARMED_AT_ISO,
      }),
      h.deps
    );

    expect(result.state.terminalStatus).toBe('not-armed-stopped-before-advance');
    expect(result.report).toContain('DRY RUN');
    expect(result.explainJson).toContain('"dryRun": true');
    expect(issuedBetaPush(h.exec)).toBe(false);
    expect(h.spawnAdvance).not.toHaveBeenCalled();
  });

  it('run-lock refusal stops before any git/gh command', async () => {
    const h = makeHarness(baseRules(), {
      acquireRunLock: async () => ({
        acquired: false,
        reason: 'already running',
        release: () => undefined,
      }),
    });

    const result = await runOvernightReleaseChain(baseOpts(), h.deps);

    expect(result.exitCode).toBe(OVERNIGHT_EXIT_CODES.LOCK_HELD);
    expect(result.state.terminalStatus).toBe('stopped-beta-incomplete');
    expect(result.report).toContain('already running');
    expect(h.exec.calls).toHaveLength(0);
    expect(h.spawnAdvance).not.toHaveBeenCalled();
  });
});

describe('dry-run synthetic beta-run fixtures', () => {
  it.each([
    {
      name: 'clean-green',
      runConclusion: 'success',
      jobs: greenJobs(),
      verdict: 'clean-green' as CleanGreenVerdict,
      expected: 'not-armed-stopped-before-advance',
    },
    {
      name: 'published-with-flakes',
      runConclusion: 'success',
      jobs: greenJobs(),
      verdict: 'shippable-but-flaky' as CleanGreenVerdict,
      expected: 'stopped-at-gate-clean-green',
    },
    {
      name: 'cancelled',
      runConclusion: 'cancelled',
      jobs: greenJobs(),
      verdict: 'clean-green' as CleanGreenVerdict,
      expected: 'beta-failed',
    },
    {
      name: 'flaky-green',
      runConclusion: 'success',
      jobs: greenJobs(),
      verdict: 'shippable-but-flaky' as CleanGreenVerdict,
      expected: 'stopped-at-gate-clean-green',
    },
    {
      name: 'partial-publish',
      runConclusion: 'success',
      jobs: greenJobs({ publishConclusion: 'failure' }),
      verdict: 'clean-green' as CleanGreenVerdict,
      expected: 'stopped-at-gate-clean-green',
    },
  ])('$name fixture touches nothing and reaches $expected', async ({ runConclusion, jobs, verdict, expected }) => {
    const h = makeHarness(
      baseRules([
        [
          `gh run view ${RUN_ID} --repo ${OWNER_REPO} --json databaseId,headSha,event,createdAt,status,conclusion,displayTitle`,
          { output: runViewRun({ conclusion: runConclusion }) },
        ],
        [`gh run view ${RUN_ID} --repo ${OWNER_REPO} --json jobs`, { output: JSON.stringify({ jobs }) }],
        [`gh run view ${RUN_ID} --repo ${OWNER_REPO} --log`, { output: runLog(verdict) }],
      ]),
      { evaluatePreflightGate: () => PASSING_PREFLIGHT }
    );

    const result = await runOvernightReleaseChain(
      baseOpts({
        dryRun: true,
        explainJson: true,
        dryRunRunId: RUN_ID,
        armingFlags: fullArmingFlags(),
        armedAtIso: ARMED_AT_ISO,
      }),
      h.deps
    );

    expect(result.state.terminalStatus).toBe(expected);
    expect(issuedBetaPush(h.exec)).toBe(false);
    expect(h.exec.calls.some((call) => call.includes('prebeta'))).toBe(false);
    expect(h.spawnAdvance).not.toHaveBeenCalled();
  });

  it('dry-run manifest mismatch blocks as a clean-green gate failure', async () => {
    const h = makeHarness(baseRules(), {
      fetchManifest: async () => ({ ok: true, manifest: { version: '0.0.0', platforms: {} } }),
    });

    const result = await runOvernightReleaseChain(
      baseOpts({
        dryRun: true,
        explainJson: true,
        dryRunRunId: RUN_ID,
        armingFlags: fullArmingFlags(),
        armedAtIso: ARMED_AT_ISO,
      }),
      h.deps
    );

    expect(result.state.terminalStatus).toBe('stopped-at-gate-clean-green');
    expect(result.report).toContain('expected 0.4.494282');
    expect(issuedBetaPush(h.exec)).toBe(false);
    expect(h.spawnAdvance).not.toHaveBeenCalled();
  });
});

// Real-seam regression for backtest finding F-BT1: the real `realExec` (not an
// injected mock) must not blow Node's default 1 MB execSync buffer. `gh run view
// --log` for a release run is multi-MB; without an explicit maxBuffer the exec
// throws ENOBUFS, which made the clean-green E2E flake-verdict read fail closed
// on every real run. This one test deliberately spawns a *controlled local*
// subprocess (node emitting bytes) — no git/gh/network — to exercise that seam.
describe('realExec buffer (F-BT1 regression)', () => {
  it('reads >1 MB of subprocess stdout without ENOBUFS', () => {
    const exec = realExec(process.cwd());
    const bytes = 2 * 1024 * 1024; // 2 MB — over the 1 MB default, under the 64 MB cap
    const result = exec(
      `node -e "process.stdout.write('x'.repeat(${bytes}))"`,
      { timeoutMs: 30_000 }
    );
    expect(result.success).toBe(true);
    expect(result.output.length).toBe(bytes);
  });
});
