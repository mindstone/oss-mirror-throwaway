import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  buildDiagnosisPacket,
  classifyLog,
  getExitCode,
  isFailureLikeConclusion,
  renderJson,
  runCiInvestigate,
  selectRelevantRun,
  splitFailedJobLogs,
  truncateLog,
  type DiagnosisPacket,
  type FsLike,
  type GhCommandResult,
  type GhRunner,
  type MatchResult,
  type RunMeta,
  type RunViewStreamingResult,
} from '../ci-investigate';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturesDir = join(repoRoot, 'scripts', '__tests__', 'fixtures', 'ci-investigate');

interface CatalogFixtureCase {
  fixture: string;
  expectedId: string;
  expectedCommand: string;
  expectedLens: string;
}

const CLASSIFIED_CATALOG_CASES: CatalogFixtureCase[] = [
  {
    fixture: 'knip-health-unused.log',
    expectedId: 'knip-health-unused-file',
    expectedCommand: 'npm run validate:knip-health',
    expectedLens: 'none (mechanical)',
  },
  {
    fixture: 'knip-health-unused-dependency.log',
    expectedId: 'knip-health-unused-dependency',
    expectedCommand: 'npm run validate:knip-health',
    expectedLens: 'none (mechanical)',
  },
  {
    fixture: 'cross-surface-parity-baseline-drift.log',
    expectedId: 'cross-surface-parity-baseline-drift',
    expectedCommand: 'npm run validate:cross-surface-parity-gap',
    expectedLens: 'Cross-surface parity',
  },
  {
    fixture: 'eslint-new-warnings-regression.log',
    expectedId: 'eslint-new-warnings-regression',
    expectedCommand: 'npm run validate:eslint-new-warnings',
    expectedLens: 'Runtime Safety',
  },
  {
    fixture: 'circular-deps-renderer.log',
    expectedId: 'circular-deps',
    expectedCommand: 'npm run validate:circular-deps',
    expectedLens: 'Architecture',
  },
  {
    fixture: 'mcp-lockfile-drift.log',
    expectedId: 'mcp-lockfile-drift',
    expectedCommand: 'npx tsx scripts/check-mcp-lockfiles.ts',
    expectedLens: 'MCP',
  },
  {
    fixture: 'ipc-validation-failed.log',
    expectedId: 'ipc-contract-drift',
    expectedCommand: 'npm run validate:ipc',
    expectedLens: 'Cross-process Contract',
  },
  {
    fixture: 'ts-ratchet-regression.log',
    expectedId: 'ts-ratchet-regression',
    expectedCommand: 'npm run validate:ts-ratchet',
    expectedLens: 'Approach Assessment',
  },
  {
    fixture: 'react-hooks-exhaustive-deps.log',
    expectedId: 'react-hooks-exhaustive-deps',
    expectedCommand: 'npm run lint',
    expectedLens: 'none (mechanical)',
  },
  {
    fixture: 'store-version-mismatch.log',
    expectedId: 'store-version-mismatch',
    expectedCommand: 'npm run validate:store-versions',
    expectedLens: 'Migration Safety',
  },
  {
    fixture: 'submodule-pointer-not-pushed.log',
    expectedId: 'submodule-pointer-not-pushed',
    expectedCommand: 'git submodule status',
    expectedLens: 'Operational',
  },
  {
    fixture: 'rebel-system-token-missing.log',
    expectedId: 'rebel-system-token-missing',
    expectedCommand: 'gh secret list',
    expectedLens: 'Operational',
  },
  {
    fixture: 'metro-unable-to-resolve.log',
    expectedId: 'metro-unable-to-resolve-module',
    expectedCommand: 'cd mobile && npx expo start --clear',
    expectedLens: 'Cross-surface parity',
  },
  {
    fixture: 'cloud-rollup-unresolved-import.log',
    expectedId: 'cloud-rollup-unresolved-import',
    expectedCommand: 'npm run verify:cloud-docker',
    expectedLens: 'Cross-surface parity',
  },
  {
    fixture: 'vitest-snapshot-mismatch.log',
    expectedId: 'vitest-snapshot-mismatch',
    expectedCommand: 'npx vitest run',
    expectedLens: 'Testability',
  },
  {
    fixture: 'eval-migration-lock-temp-cleanup.log',
    expectedId: 'eval-migration-lock-temp-cleanup',
    expectedCommand: 'npx vitest run --project=evals evals/__tests__/migration-lock.test.ts',
    expectedLens: 'Testability',
  },
  {
    fixture: 'release-e2e-harness-cascade.log',
    expectedId: 'release-e2e-harness-cascade',
    expectedCommand: 'npm run package && npm run test:e2e',
    expectedLens: 'Testability / E2E',
  },
  {
    fixture: 'e2e-ipc-payload-size-guard.log',
    expectedId: 'e2e-ipc-payload-size-guard',
    expectedCommand: 'npm run test:e2e:perf',
    expectedLens: 'Performance',
  },
  {
    fixture: 'mobile-testflight-eas-submit-failure.log',
    expectedId: 'mobile-testflight-eas-submit-failure',
    expectedCommand: 'cd mobile && eas submit --platform ios --profile production --latest --non-interactive',
    expectedLens: 'Operational',
  },
  {
    fixture: 'dependabot-private-submodule-access.log',
    expectedId: 'dependabot-private-submodule-access',
    expectedCommand: 'gh secret list --app dependabot',
    expectedLens: 'Operational',
  },
  {
    fixture: 'eval-planner-fixture-failure.log',
    expectedId: 'eval-planner-fixture-failure',
    expectedCommand: 'npm run eval:rebel-core-planner',
    expectedLens: 'Eval Quality',
  },
];

const UNKNOWN_CATALOG_CASES = [
  'e2e-harness-cascade-docs-mention.log',
  'mobile-testflight-eas-submit-docs-mention.log',
  'mobile-testflight-submit-command-later-step-failure.log',
  'dependabot-private-submodule-docs-mention.log',
  'eval-planner-fixture-failure-other-job.log',
  'eslint-new-warnings-docs-mention.log',
];

function fixturePath(name: string): string {
  return join(fixturesDir, name);
}

function readFixture(name: string): string {
  return readFileSync(fixturePath(name), 'utf8');
}

function normalizePacketForSnapshot<T extends DiagnosisPacket>(packet: T, root: string): T {
  if (!('logPath' in packet) || typeof packet.logPath !== 'string') {
    return packet;
  }
  const lp = packet.logPath;
  if (!isAbsolute(lp)) {
    return packet;
  }
  const rel = relative(root, lp).replace(/\\/g, '/');
  if (rel.startsWith('..')) {
    return { ...packet, logPath: '<outside-repo-root>' };
  }
  return { ...packet, logPath: rel };
}

function ok(stdout = ''): GhCommandResult {
  return {
    status: 0,
    stdout,
    stderr: '',
  };
}

function nonZero(stderr: string): GhCommandResult {
  return {
    status: 1,
    stdout: '',
    stderr,
  };
}

function writeStreamingLog(outputPath: string, log: string): RunViewStreamingResult {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, log, 'utf8');
  const tail = truncateLog(log, {
    maxLines: 800,
    maxBytes: 400 * 1024,
  });
  return {
    status: 0,
    stderr: '',
    logExcerptTail: tail.text,
    truncated: tail.truncated,
  };
}

function createRunner(overrides: Partial<GhRunner> = {}): GhRunner {
  return {
    version: overrides.version ?? (() => ok('gh version 2.74.1 (2025-06-10)')),
    authStatus: overrides.authStatus ?? (() => ok('')),
    runList:
      overrides.runList ??
      (() =>
        ok(
          JSON.stringify([
            {
              databaseId: 25600243693,
              workflowName: 'Desktop Dev Checks',
              name: 'dev-checks',
              conclusion: 'failure',
              status: 'completed',
              attempt: 1,
            },
          ]),
        )),
    runView:
      overrides.runView ??
      ((args: string[]) => {
        if (args.includes('--json')) {
          return ok(
            JSON.stringify({
              databaseId: 25600243693,
              workflowName: 'Desktop Dev Checks',
              conclusion: 'failure',
              status: 'completed',
              attempt: 1,
            }),
          );
        }
        return ok(readFixture('knip-health-unused.log'));
      }),
    runViewStreaming:
      overrides.runViewStreaming ??
      (async (_args: string[], options) => writeStreamingLog(options.outputPath, readFixture('knip-health-unused.log'))),
  };
}

function makeFailurePacketFromLog(log: string): { matches: MatchResult[]; packet: DiagnosisPacket } {
  const jobs = splitFailedJobLogs(log);
  const matches = jobs.flatMap((job) =>
    classifyLog(job.text, CATALOG).map((match) => ({
      ...match,
      jobName: job.jobName,
    })),
  );
  const packet = buildDiagnosisPacket({
    runMeta: {
      runId: '25600243693',
      workflowName: 'Desktop Dev Checks',
      conclusion: 'failure',
      status: 'completed',
      attempt: 1,
    },
    matches,
    failedJobs: jobs.map((job) => job.jobName),
    logPath: 'tmp/ci-investigate/25600243693.log',
    truncated: false,
    logExcerptTail: truncateLog(log, { maxLines: 800, maxBytes: 400 * 1024 }).text,
  });
  return { matches, packet };
}

const missingFsLike: FsLike = {
  existsSync: () => false,
  mkdirSync: () => {
    // no-op
  },
  renameSync: () => {
    // no-op
  },
  unlinkSync: () => {
    // no-op
  },
};

describe('ci-investigate catalog fixtures', () => {
  describe.each(CLASSIFIED_CATALOG_CASES)('$fixture', ({ fixture, expectedId, expectedCommand, expectedLens }) => {
    it('classifies expected id/repro/lens and snapshots packet', async () => {
      const result = await runCiInvestigate(
        {
          fromFile: fixturePath(fixture),
        },
        {
          repoRoot,
        },
      );

      expect(result.packet.status).toBe('classified');
      if (result.packet.status !== 'classified') {
        throw new Error('Expected classified packet');
      }

      const match = result.packet.matches.find((candidate) => candidate.id === expectedId);
      expect(match).toBeDefined();
      expect(match?.repro.command).toBe(expectedCommand);
      expect(match?.lens).toBe(expectedLens);
      expect(normalizePacketForSnapshot(result.packet, repoRoot)).toMatchSnapshot();
    });
  });

  it('promotes validate-fast-generic-only fixture to unknown with tentative repro', async () => {
    const result = await runCiInvestigate(
      {
        fromFile: fixturePath('validate-fast-generic.log'),
      },
      {
        repoRoot,
      },
    );

    expect(result.packet.status).toBe('unknown');
    expect(result.exitCode).toBe(2);
    if (result.packet.status === 'unknown') {
      expect(result.packet.tentativeRepro?.command).toBe('npm run validate:fast');
    }
  });

  describe.each(UNKNOWN_CATALOG_CASES)('%s', (fixture) => {
    it('does not classify broad operational/flaky-suspect text outside the expected job context', async () => {
      const result = await runCiInvestigate(
        {
          fromFile: fixturePath(fixture),
        },
        {
          repoRoot,
        },
      );

      expect(result.packet.status).toBe('unknown');
    });
  });
});

describe('ci-investigate helper behavior', () => {
  it('does not false-positive on a benign circular dependency mention', () => {
    const { matches, packet } = makeFailurePacketFromLog(readFixture('negative-circular-mention.log'));
    expect(matches).toEqual([]);
    expect(packet.status).toBe('unknown');
  });

  it('does not false-positive on react-hooks docs mention', async () => {
    const result = await runCiInvestigate(
      {
        fromFile: fixturePath('react-hooks-docs-mention.log'),
      },
      {
        repoRoot,
      },
    );
    expect(result.packet.status).toBe('unknown');
  });

  it('does not false-positive on IPC docs mention', async () => {
    const result = await runCiInvestigate(
      {
        fromFile: fixturePath('ipc-docs-mention.log'),
      },
      {
        repoRoot,
      },
    );
    expect(result.packet.status).toBe('unknown');
  });

  it('does not false-positive on vitest-snapshot docs mention', async () => {
    const result = await runCiInvestigate(
      {
        fromFile: fixturePath('vitest-snapshot-docs-mention.log'),
      },
      {
        repoRoot,
      },
    );
    expect(result.packet.status).toBe('unknown');
  });

  it('returns unknown packet and exit code 2 for unmatched logs', async () => {
    const result = await runCiInvestigate(
      {
        fromFile: fixturePath('unknown.log'),
      },
      {
        repoRoot,
      },
    );
    expect(result.packet.status).toBe('unknown');
    expect(result.exitCode).toBe(2);
  });

  it('returns multiple matches from a multi-match fixture', () => {
    const { matches } = makeFailurePacketFromLog(readFixture('multi-match.log'));
    expect(matches.map((match) => match.id)).toEqual(
      expect.arrayContaining(['knip-health-unused-file', 'react-hooks-exhaustive-deps']),
    );
  });

  it('splits multi-job logs (including CRLF) into job buckets', () => {
    const rawLog = readFixture('multi-job.log').replace(/\n/g, '\r\n');
    const jobs = splitFailedJobLogs(rawLog);
    expect(jobs.map((job) => job.jobName)).toEqual(['knip-health', 'validate-and-test']);
  });

  it('uses longest regex source for tie-breaking', () => {
    const matches = classifyLog('error token', [
      {
        id: 'short',
        displayName: 'Short',
        regex: /error/,
        repro: { command: 'short' },
        lens: 'none',
      },
      {
        id: 'long',
        displayName: 'Long',
        regex: /error token/,
        repro: { command: 'long' },
        lens: 'none',
      },
    ]);
    expect(matches[0]?.id).toBe('long');
  });

  it('uses alphabetical id when regex source lengths are equal', () => {
    const matches = classifyLog('error', [
      {
        id: 'z-id',
        displayName: 'Z',
        regex: /error/,
        repro: { command: 'z' },
        lens: 'none',
      },
      {
        id: 'a-id',
        displayName: 'A',
        regex: /error/,
        repro: { command: 'a' },
        lens: 'none',
      },
    ]);
    expect(matches[0]?.id).toBe('a-id');
  });

  it('does not apply validate:fast generic catch-all outside validate-and-test job names', async () => {
    const runner = createRunner({
      runViewStreaming: async (_args: string[], options) =>
        writeStreamingLog(
          options.outputPath,
          'knip-health\tUNKNOWN STEP\t2026-05-10T00:00:00.000Z ##[error]Process completed with exit code 1.\n',
        ),
    });

    const result = await runCiInvestigate(
      {
        branch: 'dev',
      },
      {
        runner,
        repoRoot,
      },
    );

    expect(result.packet.status).toBe('unknown');
    expect(result.exitCode).toBe(2);
  });

  it('enforces truncation limits', () => {
    const largeLog = `${'padding line for truncation budget\n'.repeat(45000)}final line\n`;
    const truncated = truncateLog(largeLog, {
      maxLines: 800,
      maxBytes: 400 * 1024,
    });

    expect(truncated.truncated).toBe(true);
    expect(Buffer.byteLength(truncated.text, 'utf8')).toBeLessThanOrEqual(400 * 1024);
    expect(truncated.text.split(/\r?\n/).length).toBeLessThanOrEqual(800);
  });

  it('catalog repro commands are cross-platform safe (no leading slash paths)', () => {
    for (const entry of CATALOG) {
      expect(entry.repro.command.startsWith('/')).toBe(false);
    }
  });

  it('filters out validate-fast-generic when a specific signature also matches', async () => {
    const result = await runCiInvestigate(
      {
        fromFile: fixturePath('validate-fast-generic-plus-knip.log'),
      },
      {
        repoRoot,
      },
    );

    expect(result.packet.status).toBe('classified');
    if (result.packet.status === 'classified') {
      expect(result.packet.matches.map((match) => match.id)).toContain('knip-health-unused-file');
      expect(result.packet.matches.map((match) => match.id)).not.toContain('validate-fast-generic');
    }
  });
});

describe('isFailureLikeConclusion', () => {
  it('returns true for failure', () => {
    expect(isFailureLikeConclusion('failure')).toBe(true);
  });

  it.each(['timed_out', 'action_required', 'startup_failure', 'stale'])(
    'returns true for non-success conclusion %s',
    (conclusion) => {
      expect(isFailureLikeConclusion(conclusion)).toBe(true);
    },
  );

  it.each(['success', 'cancelled', 'skipped', 'neutral', null, undefined, ''])(
    'returns false for non-failure-like conclusion %s',
    (conclusion) => {
      expect(isFailureLikeConclusion(conclusion as string | null | undefined)).toBe(false);
    },
  );
});

describe('selectRelevantRun', () => {
  function makeRun(overrides: Partial<RunMeta> & Pick<RunMeta, 'runId'>): RunMeta {
    return {
      workflowName: 'wf',
      conclusion: 'success',
      status: 'completed',
      attempt: 1,
      headSha: null,
      ...overrides,
    };
  }

  it('returns null for empty input', () => {
    expect(selectRelevantRun([])).toBeNull();
  });

  it('returns the only run when there is just one', () => {
    const run = makeRun({ runId: '1', conclusion: 'success' });
    expect(selectRelevantRun([run])).toEqual(run);
  });

  it('returns runs[0] when no headSha is available and no failures anywhere (degraded path)', () => {
    const run = makeRun({ runId: '1', conclusion: 'success', headSha: null });
    const otherSuccess = makeRun({ runId: '2', conclusion: 'success', headSha: null });
    expect(selectRelevantRun([run, otherSuccess])).toEqual(run);
  });

  it('prefers a sibling failure on the latest SHA over runs[0] success', () => {
    const sha = 'abc123';
    const success = makeRun({ runId: '1', conclusion: 'success', headSha: sha });
    const failure = makeRun({ runId: '2', conclusion: 'failure', headSha: sha });
    expect(selectRelevantRun([success, failure])).toEqual(failure);
  });

  it('picks the first failure on the latest SHA when multiple siblings failed', () => {
    const sha = 'abc123';
    const success = makeRun({ runId: '1', conclusion: 'success', headSha: sha });
    const firstFailure = makeRun({ runId: '2', conclusion: 'failure', headSha: sha });
    const secondFailure = makeRun({ runId: '3', conclusion: 'failure', headSha: sha });
    expect(selectRelevantRun([success, firstFailure, secondFailure])).toEqual(firstFailure);
  });

  it('does NOT surface failures from older SHAs', () => {
    const newSuccess = makeRun({ runId: '1', conclusion: 'success', headSha: 'new-sha' });
    const oldFailure = makeRun({ runId: '2', conclusion: 'failure', headSha: 'old-sha' });
    expect(selectRelevantRun([newSuccess, oldFailure])).toEqual(newSuccess);
  });

  it('returns runs[0] unchanged when latest SHA itself is the failure', () => {
    const failure = makeRun({ runId: '1', conclusion: 'failure', headSha: 'abc123' });
    const success = makeRun({ runId: '2', conclusion: 'success', headSha: 'abc123' });
    expect(selectRelevantRun([failure, success])).toEqual(failure);
  });

  it('surfaces a sibling timed_out conclusion as a failure-like sibling', () => {
    const sha = 'abc123';
    const success = makeRun({ runId: '1', conclusion: 'success', headSha: sha });
    const timedOut = makeRun({ runId: '2', conclusion: 'timed_out', headSha: sha });
    expect(selectRelevantRun([success, timedOut])).toEqual(timedOut);
  });

  it('surfaces a sibling startup_failure conclusion as a failure-like sibling', () => {
    const sha = 'abc123';
    const success = makeRun({ runId: '1', conclusion: 'success', headSha: sha });
    const startupFail = makeRun({ runId: '2', conclusion: 'startup_failure', headSha: sha });
    expect(selectRelevantRun([success, startupFail])).toEqual(startupFail);
  });

  it('does NOT surface cancelled conclusions (deliberate cancellations are noise)', () => {
    const sha = 'abc123';
    const success = makeRun({ runId: '1', conclusion: 'success', headSha: sha });
    const cancelled = makeRun({ runId: '2', conclusion: 'cancelled', headSha: sha });
    expect(selectRelevantRun([success, cancelled])).toEqual(success);
  });

  it('falls back to scanning all runs for failures when runs[0].headSha is null', () => {
    const successNoSha = makeRun({ runId: '1', conclusion: 'success', headSha: null });
    const failureNoSha = makeRun({ runId: '2', conclusion: 'failure', headSha: null });
    expect(selectRelevantRun([successNoSha, failureNoSha])).toEqual(failureNoSha);
  });
});

describe('ci-investigate exit codes and core statuses', () => {
  it('maps all packet statuses to expected exit codes', () => {
    const packets: DiagnosisPacket[] = [
      {
        status: 'classified',
        runId: '1',
        workflowName: 'wf',
        failedJobs: ['a'],
        matches: [],
        truncated: false,
      },
      {
        status: 'unknown',
        runId: '2',
        workflowName: 'wf',
        failedJobs: ['a'],
        truncated: false,
        logExcerptTail: 'tail',
      },
      {
        status: 'no_failure',
        runId: '3',
        workflowName: 'wf',
        conclusion: 'success',
      },
      {
        status: 'in_progress',
        runId: '4',
        workflowName: 'wf',
        runStatus: 'in_progress',
      },
      {
        status: 'hard_error',
        reason: 'x',
        remediation: 'y',
      },
    ];

    expect(getExitCode(packets[0])).toBe(0);
    expect(getExitCode(packets[1])).toBe(2);
    expect(getExitCode(packets[2])).toBe(0);
    expect(getExitCode(packets[3])).toBe(0);
    expect(getExitCode(packets[4])).toBe(1);
  });

  it('--dry-run does not call gh run view or gh run view --log-failed', async () => {
    let runViewCalls = 0;
    let runViewStreamingCalls = 0;
    const runner = createRunner({
      runView: (args: string[]) => {
        runViewCalls += 1;
        return ok(JSON.stringify({ databaseId: args[0], workflowName: 'Desktop Dev Checks', conclusion: 'failure' }));
      },
      runViewStreaming: async () => {
        runViewStreamingCalls += 1;
        return {
          status: 0,
          stderr: '',
          logExcerptTail: '',
          truncated: false,
        };
      },
    });

    const result = await runCiInvestigate(
      {
        branch: 'dev',
        dryRun: true,
      },
      {
        runner,
        repoRoot,
      },
    );

    expect(runViewCalls).toBe(0);
    expect(runViewStreamingCalls).toBe(0);
    expect(result.packet.status).toBe('no_failure');
    if (result.packet.status === 'no_failure') {
      expect(result.packet.conclusion).toBe('dry_run');
    }
    expect(result.exitCode).toBe(0);
  });

  it('returns hard_error with install remediation when gh is missing (ENOENT)', async () => {
    const missingRunner = createRunner({
      version: () => {
        const error = new Error('spawn gh ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      },
    });

    const result = await runCiInvestigate(
      {
        branch: 'dev',
      },
      {
        runner: missingRunner,
        repoRoot,
      },
    );

    expect(result.packet.status).toBe('hard_error');
    if (result.packet.status === 'hard_error') {
      expect(result.packet.remediation).toContain('https://cli.github.com/');
    }
    expect(result.exitCode).toBe(1);
  });

  it('returns hard_error when gh auth status fails', async () => {
    const runner = createRunner({
      authStatus: () => nonZero('You are not logged into any GitHub hosts.'),
    });

    const result = await runCiInvestigate(
      {
        branch: 'dev',
      },
      {
        runner,
        repoRoot,
      },
    );

    expect(result.packet.status).toBe('hard_error');
    if (result.packet.status === 'hard_error') {
      expect(result.packet.remediation).toContain('gh auth login');
    }
    expect(result.exitCode).toBe(1);
  });

  it('returns hard_error when gh version is below the minimum supported version', async () => {
    const runner = createRunner({
      version: () => ok('gh version 2.49.0 (2025-01-01)'),
    });

    const result = await runCiInvestigate(
      {
        branch: 'dev',
      },
      {
        runner,
        repoRoot,
      },
    );

    expect(result.packet.status).toBe('hard_error');
    if (result.packet.status === 'hard_error') {
      expect(result.packet.reason).toContain('version too old');
      expect(result.packet.remediation).toContain('2.50+');
    }
    expect(result.exitCode).toBe(1);
  });

  it('returns in_progress with exit code 0 when latest run is queued/in_progress', async () => {
    const runner = createRunner({
      runList: () =>
        ok(
          JSON.stringify([
            {
              databaseId: 999,
              workflowName: 'Desktop Dev Checks',
              conclusion: null,
              status: 'queued',
              attempt: 1,
            },
          ]),
        ),
    });

    const result = await runCiInvestigate(
      {
        branch: 'dev',
      },
      {
        runner,
        repoRoot,
      },
    );

    expect(result.packet.status).toBe('in_progress');
    expect(result.exitCode).toBe(0);
  });

  it('returns no_failure with exit code 0 when latest run completed successfully', async () => {
    const runner = createRunner({
      runList: () =>
        ok(
          JSON.stringify([
            {
              databaseId: 1000,
              workflowName: 'Desktop Dev Checks',
              conclusion: 'success',
              status: 'completed',
              attempt: 1,
            },
          ]),
        ),
    });

    const result = await runCiInvestigate(
      {
        branch: 'dev',
      },
      {
        runner,
        repoRoot,
      },
    );

    expect(result.packet.status).toBe('no_failure');
    expect(result.exitCode).toBe(0);
  });

  it('surfaces a sibling failure on the same SHA when the latest run succeeded', async () => {
    const sha = 'abc123def456';
    const runner = createRunner({
      runList: () =>
        ok(
          JSON.stringify([
            {
              databaseId: 2001,
              workflowName: 'Beta Deploy Trigger',
              conclusion: 'success',
              status: 'completed',
              attempt: 1,
              headSha: sha,
            },
            {
              databaseId: 2002,
              workflowName: 'Desktop Dev Checks',
              conclusion: 'failure',
              status: 'completed',
              attempt: 1,
              headSha: sha,
            },
            {
              databaseId: 2003,
              workflowName: 'Commit Notifications',
              conclusion: 'success',
              status: 'completed',
              attempt: 1,
              headSha: sha,
            },
          ]),
        ),
    });

    const result = await runCiInvestigate(
      {
        branch: 'dev',
      },
      {
        runner,
        repoRoot,
      },
    );

    expect(result.packet.status).not.toBe('no_failure');
    if (result.packet.status === 'classified' || result.packet.status === 'unknown') {
      expect(result.packet.runId).toBe('2002');
      expect(result.packet.workflowName).toBe('Desktop Dev Checks');
    }
  });

  it('does not surface stale failures from older SHAs', async () => {
    const runner = createRunner({
      runList: () =>
        ok(
          JSON.stringify([
            {
              databaseId: 3001,
              workflowName: 'Beta Deploy Trigger',
              conclusion: 'success',
              status: 'completed',
              attempt: 1,
              headSha: 'newsha123',
            },
            {
              databaseId: 3002,
              workflowName: 'Desktop Dev Checks',
              conclusion: 'failure',
              status: 'completed',
              attempt: 1,
              headSha: 'oldsha789',
            },
          ]),
        ),
    });

    const result = await runCiInvestigate(
      {
        branch: 'dev',
      },
      {
        runner,
        repoRoot,
      },
    );

    expect(result.packet.status).toBe('no_failure');
  });

  it('returns hard_error for --from-file when the file is missing', async () => {
    const result = await runCiInvestigate(
      {
        fromFile: '/tmp/does-not-exist.log',
      },
      {
        fsLike: missingFsLike,
        repoRoot,
      },
    );

    expect(result.packet.status).toBe('hard_error');
    expect(result.exitCode).toBe(1);
  });

  it('returns hard_error for --from-file when path points to a directory', async () => {
    const result = await runCiInvestigate(
      {
        fromFile: fixturesDir,
      },
      {
        repoRoot,
      },
    );

    expect(result.packet.status).toBe('hard_error');
    expect(result.exitCode).toBe(1);
  });
});

describe('ci-investigate runCiInvestigate integrations', () => {
  it('classifies from gh run list + streaming run view path (Contract #15)', async () => {
    const runner = createRunner({
      runViewStreaming: async (_args: string[], options) =>
        writeStreamingLog(options.outputPath, readFixture('knip-health-unused.log')),
    });

    const result = await runCiInvestigate(
      {
        branch: 'dev',
      },
      {
        runner,
        repoRoot,
      },
    );

    expect(result.packet.status).toBe('classified');
    if (result.packet.status === 'classified') {
      expect(result.packet.matches.map((match) => match.id)).toContain('knip-health-unused-file');
    }
  });

  it('groups multi-job output by jobName through runCiInvestigate JSON output', async () => {
    const runner = createRunner({
      runViewStreaming: async (_args: string[], options) =>
        writeStreamingLog(options.outputPath, readFixture('multi-job.log')),
    });

    const result = await runCiInvestigate(
      {
        branch: 'dev',
        json: true,
      },
      {
        runner,
        repoRoot,
      },
    );

    expect(result.packet.status).toBe('classified');
    const parsed = JSON.parse(result.output) as {
      status: string;
      matches?: Array<{ id: string; jobName?: string }>;
    };
    expect(parsed.status).toBe('classified');
    expect(parsed.matches?.map((match) => match.jobName)).toEqual(
      expect.arrayContaining(['knip-health', 'validate-and-test']),
    );
  });

  it('keeps classification against full streamed log when signature is only at the head (10MB)', async () => {
    const headSignature = 'validate-and-test\tUNKNOWN STEP\t2026-05-10T19:24:09.000Z ✘ Found 1 unused file(s):\n';
    const fillerLine =
      'validate-and-test\tUNKNOWN STEP\t2026-05-10T19:24:10.000Z filler text that pushes the signature out of the tail window\n';
    const filler = fillerLine.repeat(90_000);
    const hugeLog = `${headSignature}${filler}`;

    const runner = createRunner({
      runViewStreaming: async (_args: string[], options) => writeStreamingLog(options.outputPath, hugeLog),
    });

    const result = await runCiInvestigate(
      {
        branch: 'dev',
      },
      {
        runner,
        repoRoot,
      },
    );

    expect(result.packet.status).toBe('classified');
    if (result.packet.status === 'classified') {
      expect(result.packet.truncated).toBe(true);
      expect(result.packet.matches.map((match) => match.id)).toContain('knip-health-unused-file');
    }
  });

  it('retries run list once on transient error', async () => {
    let calls = 0;
    const runner = createRunner({
      runList: () => {
        calls += 1;
        if (calls === 1) {
          return nonZero('HTTP 429 API rate limit exceeded');
        }
        return ok(
          JSON.stringify([
            {
              databaseId: 25600243693,
              workflowName: 'Desktop Dev Checks',
              conclusion: 'failure',
              status: 'completed',
              attempt: 1,
            },
          ]),
        );
      },
    });

    const result = await runCiInvestigate(
      {
        branch: 'dev',
      },
      {
        runner,
        repoRoot,
      },
    );

    expect(calls).toBe(2);
    expect(result.packet.status).toBe('classified');
  });

  it('retries run view streaming once on transient error', async () => {
    let calls = 0;
    const runner = createRunner({
      runViewStreaming: async (_args: string[], options) => {
        calls += 1;
        if (calls === 1) {
          return {
            status: 1,
            stderr: 'ETIMEDOUT while fetching run logs',
            logExcerptTail: '',
            truncated: false,
          };
        }
        return writeStreamingLog(options.outputPath, readFixture('knip-health-unused.log'));
      },
    });

    const result = await runCiInvestigate(
      {
        branch: 'dev',
      },
      {
        runner,
        repoRoot,
      },
    );

    expect(calls).toBe(2);
    expect(result.packet.status).toBe('classified');
  });

  it('returns auth-refresh remediation for HTTP 401 run-list failures', async () => {
    const runner = createRunner({
      runList: () => nonZero('HTTP 401 Bad credentials'),
    });

    const result = await runCiInvestigate(
      {
        branch: 'dev',
      },
      {
        runner,
        repoRoot,
      },
    );

    expect(result.packet.status).toBe('hard_error');
    if (result.packet.status === 'hard_error') {
      expect(result.packet.remediation).toContain('gh auth refresh');
    }
  });

  it('returns rate-limit remediation when retries still fail with HTTP 429', async () => {
    let calls = 0;
    const runner = createRunner({
      runList: () => {
        calls += 1;
        return nonZero('HTTP 429 API rate limit exceeded');
      },
    });

    const result = await runCiInvestigate(
      {
        branch: 'dev',
      },
      {
        runner,
        repoRoot,
      },
    );

    expect(calls).toBe(2);
    expect(result.packet.status).toBe('hard_error');
    if (result.packet.status === 'hard_error') {
      expect(result.packet.remediation).toContain('GitHub API rate limit');
    }
  });

  it('returns network remediation for ENOTFOUND run-view failures', async () => {
    const runner = createRunner({
      runViewStreaming: async () => ({
        status: 1,
        stderr: 'ENOTFOUND api.github.com',
        logExcerptTail: '',
        truncated: false,
      }),
    });

    const result = await runCiInvestigate(
      {
        branch: 'dev',
      },
      {
        runner,
        repoRoot,
      },
    );

    expect(result.packet.status).toBe('hard_error');
    if (result.packet.status === 'hard_error') {
      expect(result.packet.remediation).toContain('Network/DNS error');
    }
  });

  it('uses run attempt in cache filename when attempt metadata is available', async () => {
    const runner = createRunner({
      runList: () =>
        ok(
          JSON.stringify([
            {
              databaseId: 25600243693,
              workflowName: 'Desktop Dev Checks',
              conclusion: 'failure',
              status: 'completed',
              attempt: 7,
            },
          ]),
        ),
    });

    const result = await runCiInvestigate(
      {
        branch: 'dev',
      },
      {
        runner,
        repoRoot,
      },
    );

    expect(result.packet.status).toBe('classified');
    if (result.packet.status === 'classified') {
      expect(result.packet.logPath).toContain('25600243693-attempt-7.log');
    }
  });

  it('returns hard_error JSON packet for invalid limit when json mode is enabled', async () => {
    const result = await runCiInvestigate(
      {
        branch: 'dev',
        json: true,
        limit: 0,
      },
      {
        repoRoot,
      },
    );

    expect(result.packet.status).toBe('hard_error');
    const parsed = JSON.parse(renderJson(result.packet)) as { status: string };
    expect(parsed.status).toBe('hard_error');
  });
});
