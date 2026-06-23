import { describe, expect, it } from 'vitest';

import {
  evaluateCleanGreen,
  EXPECTED_BETA_PLATFORMS,
  parseE2eVerdictFromLog,
  type CleanGreenVerdict,
  type ManifestFetchResult,
} from '../ci-clean-green';
import type { ExecFn, ExecOpts, ExecResult } from '../../promote-preflight-facts';

// SAFETY: every test injects a mocked exec + manifest fetcher. No real gh/network.

const RUN_ID = 27803427419;
const OWNER_REPO = 'mindstone/rebel-app';
const BETA_VERSION = '0.4.494282';

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

interface GreenJobOverrides {
  publish?: Partial<TestJob>;
  boot?: Partial<TestJob>;
  gpuMac?: Partial<TestJob>;
  gpuWin?: Partial<TestJob>;
  realboot?: Partial<TestJob>;
  e2e?: Partial<TestJob>;
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

function greenJobs(overrides: GreenJobOverrides = {}): TestJob[] {
  const jobs = [
    job('Publish to Google Cloud Storage'),
    job('Desktop Boot Smoke (macOS)', overrides.boot?.conclusion ?? 'success', [
      step('Boot smoke (launch packaged app, assert appReady)', overrides.boot?.steps?.[0]?.conclusion ?? 'success'),
    ]),
    job('GPU Worker WASM Smoke (macos-latest)', overrides.gpuMac?.conclusion ?? 'success', [
      step('GPU-worker WASM smoke (init + embed, assert no crash)', overrides.gpuMac?.steps?.[0]?.conclusion ?? 'success'),
    ]),
    job('GPU Worker WASM Smoke (windows-latest)', overrides.gpuWin?.conclusion ?? 'success', [
      step('GPU-worker WASM smoke (init + embed, assert no crash)', overrides.gpuWin?.steps?.[0]?.conclusion ?? 'success'),
    ]),
    job('Real-Boot Agent-Turn (observe-first, both channels)', overrides.realboot?.conclusion ?? 'success'),
    job('E2E Tests (macOS)', overrides.e2e?.conclusion ?? 'success', [
      step('Run Playwright E2E tests'),
      step('E2E flake summary', overrides.e2e?.steps?.[1]?.conclusion ?? 'success'),
    ]),
  ];

  const publishConclusion = overrides.publish?.conclusion;
  const publish = jobs[0];
  if (publish && publishConclusion !== undefined) jobs[0] = { ...publish, conclusion: publishConclusion };
  return jobs;
}

function runView(jobs: TestJob[]): string {
  return JSON.stringify({ jobs });
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
    flakySpecs: [],
    unexpectedSpecs: [],
  });
}

function runLog(verdict: CleanGreenVerdict): string {
  return [
    'E2E Tests (macOS)\tRun Playwright E2E tests\t2026-06-21T12:00:00Z done',
    `E2E Tests (macOS)\tE2E flake summary\tFlake summary: ${machineLine(verdict)}`,
  ].join('\n');
}

function flakeSummaryLine(summaryJson: string): string {
  return `E2E Tests (macOS)\tE2E flake summary\tFlake summary: ${summaryJson}`;
}

function manifest(platforms: readonly string[] = EXPECTED_BETA_PLATFORMS): unknown {
  return {
    version: BETA_VERSION,
    channel: 'beta',
    platforms: Object.fromEntries(platforms.map((platform) => [platform, { url: `https://example.com/${platform}` }])),
  };
}

function goodManifestFetch(platforms: readonly string[] = EXPECTED_BETA_PLATFORMS): () => ManifestFetchResult {
  return () => ({ ok: true, manifest: manifest(platforms) });
}

function greenRules(jobs = greenJobs(), verdict: CleanGreenVerdict = 'clean-green'): Array<[string, Partial<ExecResult>]> {
  return [
    ['--json jobs', { success: true, output: runView(jobs) }],
    ['--log', { success: true, output: runLog(verdict) }],
  ];
}

function evaluate(
  rules: Array<[string, Partial<ExecResult>]>,
  fetchManifest = goodManifestFetch()
) {
  return evaluateCleanGreen(
    { exec: makeExec(rules), fetchManifest },
    { runId: RUN_ID, betaPublishedVersion: BETA_VERSION, repo: OWNER_REPO }
  );
}

describe('parseE2eVerdictFromLog', () => {
  it('parses the renderMachineLine JSON from the E2E flake summary log line', () => {
    expect(parseE2eVerdictFromLog(runLog('clean-green'))).toBe('clean-green');
    expect(parseE2eVerdictFromLog(runLog('shippable-but-flaky'))).toBe('shippable-but-flaky');
    expect(parseE2eVerdictFromLog(runLog('red'))).toBe('red');
  });

  it('parses the summary JSON when a brace-bearing token follows it on the same log line', () => {
    const log = [
      'E2E Tests (macOS)\tRun Playwright E2E tests\t2026-06-21T12:00:00Z done',
      `${flakeSummaryLine(machineLine('clean-green'))} trailing={ignored:true}`,
    ].join('\n');

    expect(parseE2eVerdictFromLog(log)).toBe('clean-green');
  });

  it('returns null when the flake summary marker is absent', () => {
    expect(parseE2eVerdictFromLog(`E2E flake summary\t${machineLine('clean-green')}`)).toBeNull();
  });

  it('returns null when the verdict field is missing or not recognized', () => {
    const missingVerdict = JSON.stringify({
      kind: 'e2e-flake-summary',
      expected: 12,
      flaky: 0,
      unexpected: 0,
      skipped: 0,
      total: 12,
    });
    const garbageVerdict = JSON.stringify({
      kind: 'e2e-flake-summary',
      verdict: 'mostly-green',
      expected: 12,
      flaky: 0,
      unexpected: 0,
      skipped: 0,
      total: 12,
    });

    expect(parseE2eVerdictFromLog(flakeSummaryLine(missingVerdict))).toBeNull();
    expect(parseE2eVerdictFromLog(flakeSummaryLine(garbageVerdict))).toBeNull();
  });

  it('skips non-machine summary-shaped lines and parses the machine-readable summary', () => {
    const otherSummary = JSON.stringify({
      kind: 'different-summary',
      verdict: 'red',
      expected: 12,
      flaky: 0,
      unexpected: 0,
      skipped: 0,
      total: 12,
    });
    const log = [flakeSummaryLine(otherSummary), flakeSummaryLine(machineLine('clean-green'))].join('\n');

    expect(parseE2eVerdictFromLog(log)).toBe('clean-green');
  });

  it('returns null when no machine-readable verdict is present', () => {
    expect(parseE2eVerdictFromLog('E2E flake summary\tFlake summary: not-json')).toBeNull();
    expect(parseE2eVerdictFromLog('ordinary log line')).toBeNull();
  });

  it('returns null for the degenerate empty clean-green summary emitted when the report is unreadable', () => {
    const emptySummary = JSON.stringify({
      kind: 'e2e-flake-summary',
      verdict: 'clean-green',
      expected: 0,
      flaky: 0,
      unexpected: 0,
      skipped: 0,
      total: 0,
      flakySpecs: [],
      unexpectedSpecs: [],
    });

    expect(parseE2eVerdictFromLog(`E2E flake summary\tFlake summary: ${emptySummary}`)).toBeNull();
  });
});

describe('evaluateCleanGreen', () => {
  it('passes when publish, smoke steps, realboot, E2E verdict, and all manifest platforms are green', () => {
    const result = evaluate(greenRules());

    expect(result).toEqual({ cleanGreen: true, reasons: [] });
  });

  it('blocks when publish-to-gcs is not successful', () => {
    const result = evaluate(greenRules(greenJobs({ publish: { conclusion: 'failure' } })));

    expect(result.cleanGreen).toBe(false);
    expect(result.reasons.join('\n')).toContain('Publish to Google Cloud Storage');
  });

  it('blocks when boot-smoke job is success but the smoke step failed', () => {
    const result = evaluate(greenRules(greenJobs({ boot: { conclusion: 'success', steps: [step('unused', 'failure')] } })));

    expect(result.cleanGreen).toBe(false);
    expect(result.reasons.join('\n')).toContain('smoke');
    expect(result.reasons.join('\n')).toContain('failure');
  });

  it('blocks when any gpu-worker gpusmoke step failed', () => {
    const result = evaluate(
      greenRules(greenJobs({ gpuWin: { conclusion: 'success', steps: [step('unused', 'failure')] } }))
    );

    expect(result.cleanGreen).toBe(false);
    expect(result.reasons.join('\n')).toContain('gpusmoke');
    expect(result.reasons.join('\n')).toContain('windows-latest');
  });

  it('blocks when realboot failed', () => {
    const result = evaluate(greenRules(greenJobs({ realboot: { conclusion: 'failure' } })));

    expect(result.cleanGreen).toBe(false);
    expect(result.reasons.join('\n')).toContain('Real-Boot Agent-Turn');
  });

  it('blocks when the E2E verdict is shippable-but-flaky', () => {
    const result = evaluate(greenRules(greenJobs(), 'shippable-but-flaky'));

    expect(result.cleanGreen).toBe(false);
    expect(result.reasons.join('\n')).toContain('shippable-but-flaky');
  });

  it('blocks when the E2E verdict is red', () => {
    const result = evaluate(greenRules(greenJobs(), 'red'));

    expect(result.cleanGreen).toBe(false);
    expect(result.reasons.join('\n')).toContain('red');
  });

  it('fails closed when the E2E verdict is unobtainable', () => {
    const result = evaluate([
      ['--json jobs', { success: true, output: runView(greenJobs()) }],
      ['--log', { success: true, output: 'no machine line here' }],
    ]);

    expect(result.cleanGreen).toBeNull();
    expect(result.reasons.join('\n')).toContain('E2E flake verdict was not obtainable');
  });

  it('accepts the E2E verdict evidence when the summary log line has trailing tokens', () => {
    const result = evaluate([
      ['--json jobs', { success: true, output: runView(greenJobs()) }],
      ['--log', { success: true, output: `${flakeSummaryLine(machineLine('clean-green'))} trailing={ignored:true}` }],
    ]);

    expect(result).toEqual({ cleanGreen: true, reasons: [] });
  });

  it('fails closed when gh run view jobs JSON is unreadable', () => {
    const result = evaluate([
      ['--json jobs', { success: true, output: 'not json' }],
      ['--log', { success: true, output: runLog('clean-green') }],
    ]);

    expect(result.cleanGreen).toBeNull();
    expect(result.reasons.join('\n')).toContain('invalid jobs JSON');
  });

  it('fails closed when a required job group is absent', () => {
    const jobs = greenJobs().filter((candidate) => candidate.name !== 'Publish to Google Cloud Storage');
    const result = evaluate(greenRules(jobs));

    expect(result.cleanGreen).toBeNull();
    expect(result.reasons.join('\n')).toContain('publish-to-gcs');
  });

  it('fails closed when a required step is absent due to name drift', () => {
    const jobs = greenJobs().map((candidate) =>
      candidate.name === 'Desktop Boot Smoke (macOS)'
        ? { ...candidate, steps: [step('Renamed boot smoke step')] }
        : candidate
    );
    const result = evaluate(greenRules(jobs));

    expect(result.cleanGreen).toBeNull();
    expect(result.reasons.join('\n')).toContain('smoke');
    expect(result.reasons.join('\n')).toContain('not found');
  });

  it('blocks when the published manifest is missing a required platform', () => {
    const result = evaluate(greenRules(), goodManifestFetch(['mac-arm64', 'mac-x64', 'win-x64']));

    expect(result.cleanGreen).toBe(false);
    expect(result.reasons.join('\n')).toContain('linux-x64');
  });

  it('fails closed when the manifest cannot be fetched', () => {
    const result = evaluate(greenRules(), () => ({ ok: false, error: '404' }));

    expect(result.cleanGreen).toBeNull();
    expect(result.reasons.join('\n')).toContain('Could not fetch the published beta manifest');
  });
});
