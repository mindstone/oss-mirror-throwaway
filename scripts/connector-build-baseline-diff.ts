#!/usr/bin/env npx tsx

import fs from 'node:fs/promises';
import path from 'node:path';

export type BaselineDiffAxis = 'v3-set-off' | 'fixture-33-off' | 'fixture-33-on';
export type BaselineDiffVerdict =
  | 'regression'
  | 'improvement'
  | 'flat'
  | 'low-confidence'
  | 'incomparable';

type FixtureAssertion = {
  type?: unknown;
  pattern?: unknown;
  passed?: unknown;
};

type FixtureResult = {
  fixtureId?: unknown;
  passed?: unknown;
  error?: unknown;
  stalledByWatchdog?: unknown;
  assertions?: unknown;
};

type RawEvalOutput = {
  metadata?: Record<string, unknown>;
  summary?: Record<string, unknown>;
  results?: unknown;
};

export interface NormalizedFixtureResult {
  fixtureId: string;
  passed: boolean;
  error?: string;
  stalledByWatchdog?: boolean;
  failedAssertionSummaries: string[];
}

export interface NormalizedEvalOutput {
  metadata: {
    gitHash?: string;
    gitBranch?: string;
    model?: string;
    totalFixtures: number;
    seEvidenceGateEnabled?: boolean;
    superMcpRouterConfigHash?: string;
    trialIndex?: number;
    trialCount?: number;
    anthropicApiErrorsObserved?: number;
  };
  summary: {
    passRate: number;
  };
  results: NormalizedFixtureResult[];
  warnings: string[];
}

export interface BaselineDiffOptions {
  axis?: BaselineDiffAxis;
  strictConfigMatch?: boolean;
  allowTrialMismatch?: boolean;
}

export interface PerFixtureTransition {
  fixtureId: string;
  baseline: 'pass' | 'fail';
  candidate: 'pass' | 'fail';
  transition: 'pass→pass' | 'pass→fail' | 'fail→pass' | 'fail→fail';
  baselineError?: string;
  candidateError?: string;
  baselineStalledByWatchdog?: boolean;
  candidateStalledByWatchdog?: boolean;
  baselineFailedAssertions: string[];
  candidateFailedAssertions: string[];
}

export interface BaselineDiffReport {
  axis?: BaselineDiffAxis;
  warnings: string[];
  metadataDiff: {
    baseline: NormalizedEvalOutput['metadata'];
    candidate: NormalizedEvalOutput['metadata'];
    mismatches: string[];
  };
  passRateDelta: {
    baseline: number;
    candidate: number;
    deltaAbsolute: number;
    deltaRelativeToBaseline: number | null;
  };
  perFixture: {
    matrix: PerFixtureTransition[];
    counts: {
      passToPass: number;
      passToFail: number;
      failToPass: number;
      failToFail: number;
    };
  };
  infrastructureGuard: {
    ratio: number;
    threshold: number;
    lowConfidence: boolean;
    detail: string;
  };
  verdict: BaselineDiffVerdict;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function summarizeFailedAssertions(assertions: unknown): string[] {
  if (!Array.isArray(assertions)) {
    return [];
  }
  return assertions
    .map((entry) => asObject(entry) as FixtureAssertion)
    .filter((entry) => entry.passed === false)
    .map((entry) => {
      const type = asString(entry.type) ?? 'unknown';
      const pattern = asString(entry.pattern) ?? '(no-pattern)';
      return `${type}: ${pattern}`;
    });
}

export function normalizeEvalOutput(raw: unknown, label: 'baseline' | 'candidate'): NormalizedEvalOutput {
  const parsed = asObject(raw) as RawEvalOutput;
  const metadata = asObject(parsed.metadata);
  const summary = asObject(parsed.summary);
  const warnings: string[] = [];

  const normalizedResults = Array.isArray(parsed.results)
    ? parsed.results
      .map((entry): NormalizedFixtureResult | null => {
        const result = asObject(entry) as FixtureResult;
        const fixtureId = asString(result.fixtureId);
        const passed = asBoolean(result.passed);
        if (!fixtureId || typeof passed !== 'boolean') {
          return null;
        }
        return {
          fixtureId,
          passed,
          ...(typeof result.error === 'string' ? { error: result.error } : {}),
          ...(typeof result.stalledByWatchdog === 'boolean' ? { stalledByWatchdog: result.stalledByWatchdog } : {}),
          failedAssertionSummaries: summarizeFailedAssertions(result.assertions),
        };
      })
      .filter((entry): entry is NormalizedFixtureResult => entry !== null)
    : [];

  const metadataTotalFixtures = asNumber(metadata.totalFixtures);
  const totalFixtures = metadataTotalFixtures ?? normalizedResults.length;
  const summaryPassRate = asNumber(summary.passRate);
  const passRateFromResults = totalFixtures === 0
    ? 0
    : normalizedResults.filter((result) => result.passed).length / totalFixtures;
  const passRate = summaryPassRate ?? passRateFromResults;

  const seEvidenceGateEnabled = asBoolean(metadata.seEvidenceGateEnabled);
  const superMcpRouterConfigHash = asString(metadata.superMcpRouterConfigHash);
  const trialIndex = asNumber(metadata.trialIndex);
  const trialCount = asNumber(metadata.trialCount);
  const anthropicApiErrorsObserved = asNumber(metadata.anthropicApiErrorsObserved);

  if (seEvidenceGateEnabled === undefined) {
    warnings.push(`${label}: legacy result metadata missing "seEvidenceGateEnabled"`);
  }
  if (superMcpRouterConfigHash === undefined) {
    warnings.push(`${label}: legacy result metadata missing "superMcpRouterConfigHash"`);
  }
  if (trialIndex === undefined || trialCount === undefined) {
    warnings.push(`${label}: legacy result metadata missing "trialIndex/trialCount"`);
  }
  if (anthropicApiErrorsObserved === undefined) {
    warnings.push(`${label}: legacy result metadata missing "anthropicApiErrorsObserved"`);
  }

  return {
    metadata: {
      gitHash: asString(metadata.gitHash),
      gitBranch: asString(metadata.gitBranch),
      model: asString(metadata.model),
      totalFixtures,
      ...(seEvidenceGateEnabled !== undefined ? { seEvidenceGateEnabled } : {}),
      ...(superMcpRouterConfigHash !== undefined ? { superMcpRouterConfigHash } : {}),
      ...(trialIndex !== undefined ? { trialIndex } : {}),
      ...(trialCount !== undefined ? { trialCount } : {}),
      ...(anthropicApiErrorsObserved !== undefined ? { anthropicApiErrorsObserved } : {}),
    },
    summary: { passRate },
    results: normalizedResults,
    warnings,
  };
}

function classifyTransition(
  baselinePassed: boolean,
  candidatePassed: boolean,
): PerFixtureTransition['transition'] {
  if (baselinePassed && candidatePassed) return 'pass→pass';
  if (baselinePassed && !candidatePassed) return 'pass→fail';
  if (!baselinePassed && candidatePassed) return 'fail→pass';
  return 'fail→fail';
}

function computePerFixtureTransitions(
  baseline: NormalizedEvalOutput,
  candidate: NormalizedEvalOutput,
): BaselineDiffReport['perFixture'] {
  const baselineMap = new Map(baseline.results.map((result) => [result.fixtureId, result] as const));
  const candidateMap = new Map(candidate.results.map((result) => [result.fixtureId, result] as const));
  const fixtureIds = new Set([...baselineMap.keys(), ...candidateMap.keys()]);
  const matrix: PerFixtureTransition[] = [];

  for (const fixtureId of [...fixtureIds].sort((a, b) => a.localeCompare(b))) {
    const baselineResult = baselineMap.get(fixtureId);
    const candidateResult = candidateMap.get(fixtureId);
    const baselinePassed = baselineResult?.passed === true;
    const candidatePassed = candidateResult?.passed === true;
    matrix.push({
      fixtureId,
      baseline: baselinePassed ? 'pass' : 'fail',
      candidate: candidatePassed ? 'pass' : 'fail',
      transition: classifyTransition(baselinePassed, candidatePassed),
      ...(baselineResult?.error ? { baselineError: baselineResult.error } : {}),
      ...(candidateResult?.error ? { candidateError: candidateResult.error } : {}),
      ...(baselineResult?.stalledByWatchdog ? { baselineStalledByWatchdog: true } : {}),
      ...(candidateResult?.stalledByWatchdog ? { candidateStalledByWatchdog: true } : {}),
      baselineFailedAssertions: baselineResult?.failedAssertionSummaries ?? [],
      candidateFailedAssertions: candidateResult?.failedAssertionSummaries ?? [],
    });
  }

  return {
    matrix,
    counts: {
      passToPass: matrix.filter((entry) => entry.transition === 'pass→pass').length,
      passToFail: matrix.filter((entry) => entry.transition === 'pass→fail').length,
      failToPass: matrix.filter((entry) => entry.transition === 'fail→pass').length,
      failToFail: matrix.filter((entry) => entry.transition === 'fail→fail').length,
    },
  };
}

export function diffConnectorBuildBaselines(
  baseline: NormalizedEvalOutput,
  candidate: NormalizedEvalOutput,
  options: BaselineDiffOptions = {},
): BaselineDiffReport {
  const warnings = [...baseline.warnings, ...candidate.warnings];
  const mismatches: string[] = [];

  const baselineGate = baseline.metadata.seEvidenceGateEnabled;
  const candidateGate = candidate.metadata.seEvidenceGateEnabled;
  if (baselineGate !== candidateGate && options.axis === undefined) {
    mismatches.push('seEvidenceGateEnabled differs without --axis (comparison is incomparable)');
  }

  if (
    baseline.metadata.gitHash
    && candidate.metadata.gitHash
    && baseline.metadata.gitHash !== candidate.metadata.gitHash
    && options.axis === undefined
  ) {
    mismatches.push('gitHash differs without --axis (comparison is incomparable)');
  }

  const baselineTrialMismatch =
    baseline.metadata.trialIndex !== candidate.metadata.trialIndex
    || baseline.metadata.trialCount !== candidate.metadata.trialCount;
  if (baselineTrialMismatch && !options.allowTrialMismatch) {
    mismatches.push('trialIndex/trialCount mismatch (use --allow-trial-mismatch to compare anyway)');
  }

  const configMismatch =
    baseline.metadata.superMcpRouterConfigHash !== candidate.metadata.superMcpRouterConfigHash;
  if (configMismatch && options.strictConfigMatch) {
    mismatches.push('superMcpRouterConfigHash mismatch with --strict-config-match enabled');
  }

  const perFixture = computePerFixtureTransitions(baseline, candidate);
  const deltaAbsolute = candidate.summary.passRate - baseline.summary.passRate;
  const deltaRelativeToBaseline =
    baseline.summary.passRate === 0 ? null : deltaAbsolute / baseline.summary.passRate;

  const candidateInfraErrors = candidate.metadata.anthropicApiErrorsObserved ?? 0;
  const totalFixtures = candidate.metadata.totalFixtures > 0
    ? candidate.metadata.totalFixtures
    : Math.max(candidate.results.length, 1);
  const infraRatio = candidateInfraErrors / totalFixtures;
  const infraThreshold = 0.10;
  const lowConfidence = infraRatio > infraThreshold;

  let verdict: BaselineDiffVerdict;
  if (mismatches.length > 0) {
    verdict = 'incomparable';
  } else if (lowConfidence) {
    verdict = 'low-confidence';
  } else if (deltaAbsolute < 0) {
    verdict = 'regression';
  } else if (deltaAbsolute > 0) {
    verdict = 'improvement';
  } else {
    verdict = 'flat';
  }

  return {
    axis: options.axis,
    warnings,
    metadataDiff: {
      baseline: baseline.metadata,
      candidate: candidate.metadata,
      mismatches,
    },
    passRateDelta: {
      baseline: baseline.summary.passRate,
      candidate: candidate.summary.passRate,
      deltaAbsolute,
      deltaRelativeToBaseline,
    },
    perFixture,
    infrastructureGuard: {
      ratio: infraRatio,
      threshold: infraThreshold,
      lowConfidence,
      detail: lowConfidence
        ? `LOW-CONFIDENCE: anthropicApiErrorsObserved/totalFixtures = ${(infraRatio * 100).toFixed(1)}% > ${(infraThreshold * 100).toFixed(0)}%`
        : `Infra error ratio ${(infraRatio * 100).toFixed(1)}% is within ${(infraThreshold * 100).toFixed(0)}% threshold`,
    },
    verdict,
  };
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatMaybe(value: string | number | boolean | undefined): string {
  if (value === undefined) return 'undefined';
  return String(value);
}

function formatHumanReadable(report: BaselineDiffReport): string {
  const lines: string[] = [];
  lines.push('## Run metadata diff');
  lines.push(`- gitHash: ${formatMaybe(report.metadataDiff.baseline.gitHash)} -> ${formatMaybe(report.metadataDiff.candidate.gitHash)}`);
  lines.push(`- superMcpRouterConfigHash: ${formatMaybe(report.metadataDiff.baseline.superMcpRouterConfigHash)} -> ${formatMaybe(report.metadataDiff.candidate.superMcpRouterConfigHash)}`);
  lines.push(`- seEvidenceGateEnabled: ${formatMaybe(report.metadataDiff.baseline.seEvidenceGateEnabled)} -> ${formatMaybe(report.metadataDiff.candidate.seEvidenceGateEnabled)}`);
  lines.push(
    `- trial: ${formatMaybe(report.metadataDiff.baseline.trialIndex)}/${formatMaybe(report.metadataDiff.baseline.trialCount)} -> ${formatMaybe(report.metadataDiff.candidate.trialIndex)}/${formatMaybe(report.metadataDiff.candidate.trialCount)}`,
  );
  lines.push(`- anthropicApiErrorsObserved: ${formatMaybe(report.metadataDiff.baseline.anthropicApiErrorsObserved)} -> ${formatMaybe(report.metadataDiff.candidate.anthropicApiErrorsObserved)}`);
  if (report.metadataDiff.mismatches.length > 0) {
    lines.push('- mismatches:');
    for (const mismatch of report.metadataDiff.mismatches) {
      lines.push(`  - ${mismatch}`);
    }
  }

  lines.push('');
  lines.push('## Pass-rate delta');
  lines.push(`- baseline: ${formatPercent(report.passRateDelta.baseline)}`);
  lines.push(`- candidate: ${formatPercent(report.passRateDelta.candidate)}`);
  lines.push(`- delta: ${formatPercent(report.passRateDelta.deltaAbsolute)}`);
  lines.push(
    `- relative: ${report.passRateDelta.deltaRelativeToBaseline === null ? 'n/a' : formatPercent(report.passRateDelta.deltaRelativeToBaseline)}`,
  );

  lines.push('');
  lines.push('## Per-fixture verdict matrix');
  lines.push(`- pass→pass: ${report.perFixture.counts.passToPass}`);
  lines.push(`- pass→fail: ${report.perFixture.counts.passToFail}`);
  lines.push(`- fail→pass: ${report.perFixture.counts.failToPass}`);
  lines.push(`- fail→fail: ${report.perFixture.counts.failToFail}`);
  for (const row of report.perFixture.matrix) {
    const details: string[] = [];
    if (row.baselineError) details.push(`baselineError=${row.baselineError}`);
    if (row.candidateError) details.push(`candidateError=${row.candidateError}`);
    if (row.baselineStalledByWatchdog) details.push('baselineWatchdogStall=true');
    if (row.candidateStalledByWatchdog) details.push('candidateWatchdogStall=true');
    if (row.baselineFailedAssertions.length > 0) {
      details.push(`baselineFailedAssertions=${row.baselineFailedAssertions.slice(0, 2).join(' | ')}`);
    }
    if (row.candidateFailedAssertions.length > 0) {
      details.push(`candidateFailedAssertions=${row.candidateFailedAssertions.slice(0, 2).join(' | ')}`);
    }
    lines.push(`- ${row.fixtureId}: ${row.transition}${details.length > 0 ? ` (${details.join('; ')})` : ''}`);
  }

  lines.push('');
  lines.push('## Infrastructure-error guard');
  lines.push(`- ${report.infrastructureGuard.detail}`);

  if (report.warnings.length > 0) {
    lines.push('');
    lines.push('## Warnings');
    for (const warning of report.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  lines.push('');
  lines.push(`## Verdict: ${report.verdict}`);
  return `${lines.join('\n')}\n`;
}

export interface ParsedCliArgs {
  baselinePath: string;
  candidatePath: string;
  axis?: BaselineDiffAxis;
  strictConfigMatch: boolean;
  allowTrialMismatch: boolean;
  json: boolean;
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const getValue = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index < 0 || index >= argv.length - 1) {
      return undefined;
    }
    return argv[index + 1];
  };

  const baselinePath = getValue('--baseline');
  const candidatePath = getValue('--candidate');
  const axisRaw = getValue('--axis');
  const strictConfigMatch = argv.includes('--strict-config-match');
  const allowTrialMismatch = argv.includes('--allow-trial-mismatch');
  const json = argv.includes('--json');

  if (!baselinePath) {
    throw new Error('Missing required flag --baseline <path>');
  }
  if (!candidatePath) {
    throw new Error('Missing required flag --candidate <path>');
  }

  let axis: BaselineDiffAxis | undefined;
  if (axisRaw !== undefined) {
    if (axisRaw !== 'v3-set-off' && axisRaw !== 'fixture-33-off' && axisRaw !== 'fixture-33-on') {
      throw new Error(`Invalid --axis value "${axisRaw}" (expected v3-set-off | fixture-33-off | fixture-33-on)`);
    }
    axis = axisRaw;
  }

  return {
    baselinePath,
    candidatePath,
    ...(axis ? { axis } : {}),
    strictConfigMatch,
    allowTrialMismatch,
    json,
  };
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const absolutePath = path.resolve(filePath);
  const raw = await fs.readFile(absolutePath, 'utf8');
  return JSON.parse(raw);
}

export async function runBaselineDiffFromCli(argv: string[]): Promise<BaselineDiffReport> {
  const parsed = parseCliArgs(argv);
  const [baselineRaw, candidateRaw] = await Promise.all([
    readJsonFile(parsed.baselinePath),
    readJsonFile(parsed.candidatePath),
  ]);
  const baseline = normalizeEvalOutput(baselineRaw, 'baseline');
  const candidate = normalizeEvalOutput(candidateRaw, 'candidate');
  const report = diffConnectorBuildBaselines(baseline, candidate, {
    axis: parsed.axis,
    strictConfigMatch: parsed.strictConfigMatch,
    allowTrialMismatch: parsed.allowTrialMismatch,
  });

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatHumanReadable(report));
  }

  return report;
}

if (!process.env.VITEST) {
  runBaselineDiffFromCli(process.argv.slice(2))
    .then((report) => {
      process.exit(report.verdict === 'regression' ? 1 : 0);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exit(1);
    });
}
