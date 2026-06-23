import { describe, expect, it } from 'vitest';
import {
  diffConnectorBuildBaselines,
  normalizeEvalOutput,
  type NormalizedEvalOutput,
} from '../connector-build-baseline-diff';

type RawFixture = {
  fixtureId: string;
  passed: boolean;
  error?: string;
  stalledByWatchdog?: boolean;
  assertions?: Array<{ type: string; pattern: string; passed: boolean }>;
};

function makeRawOutput(overrides: {
  metadata?: Record<string, unknown>;
  summary?: Record<string, unknown>;
  results?: RawFixture[];
} = {}): Record<string, unknown> {
  const results = overrides.results ?? [
    { fixtureId: 'fixture-a', passed: true },
    { fixtureId: 'fixture-b', passed: false },
  ];

  return {
    metadata: {
      gitHash: 'abc123',
      gitBranch: 'dev',
      model: 'claude-sonnet-4-6',
      totalFixtures: results.length,
      seEvidenceGateEnabled: false,
      superMcpRouterConfigHash: 'cfg123',
      trialIndex: 1,
      trialCount: 3,
      anthropicApiErrorsObserved: 0,
      ...(overrides.metadata ?? {}),
    },
    summary: {
      passRate: results.length === 0 ? 0 : results.filter((r) => r.passed).length / results.length,
      ...(overrides.summary ?? {}),
    },
    results,
  };
}

function normalize(raw: Record<string, unknown>, label: 'baseline' | 'candidate'): NormalizedEvalOutput {
  return normalizeEvalOutput(raw, label);
}

describe('connector-build-baseline-diff', () => {
  it('returns improvement when candidate pass-rate increases', () => {
    const baseline = normalize(makeRawOutput({ summary: { passRate: 0.5 } }), 'baseline');
    const candidate = normalize(makeRawOutput({ summary: { passRate: 0.75 } }), 'candidate');

    const report = diffConnectorBuildBaselines(baseline, candidate);
    expect(report.verdict).toBe('improvement');
  });

  it('returns regression when candidate pass-rate decreases', () => {
    const baseline = normalize(makeRawOutput({ summary: { passRate: 0.75 } }), 'baseline');
    const candidate = normalize(makeRawOutput({ summary: { passRate: 0.5 } }), 'candidate');

    const report = diffConnectorBuildBaselines(baseline, candidate);
    expect(report.verdict).toBe('regression');
  });

  it('returns flat when pass-rate is unchanged', () => {
    const baseline = normalize(makeRawOutput({ summary: { passRate: 0.5 } }), 'baseline');
    const candidate = normalize(makeRawOutput({ summary: { passRate: 0.5 } }), 'candidate');

    const report = diffConnectorBuildBaselines(baseline, candidate);
    expect(report.verdict).toBe('flat');
  });

  it('marks incomparable when seEvidenceGateEnabled differs without --axis', () => {
    const baseline = normalize(makeRawOutput({ metadata: { seEvidenceGateEnabled: false } }), 'baseline');
    const candidate = normalize(makeRawOutput({ metadata: { seEvidenceGateEnabled: true } }), 'candidate');

    const report = diffConnectorBuildBaselines(baseline, candidate);
    expect(report.verdict).toBe('incomparable');
    expect(report.metadataDiff.mismatches.join('\n')).toContain('seEvidenceGateEnabled differs');
  });

  it('treats router-config mismatch as comparable by default but incomparable with --strict-config-match', () => {
    const baseline = normalize(makeRawOutput({ metadata: { superMcpRouterConfigHash: 'cfg-a' } }), 'baseline');
    const candidate = normalize(makeRawOutput({ metadata: { superMcpRouterConfigHash: 'cfg-b' } }), 'candidate');

    const defaultReport = diffConnectorBuildBaselines(baseline, candidate);
    expect(defaultReport.verdict).toBe('flat');

    const strictReport = diffConnectorBuildBaselines(baseline, candidate, { strictConfigMatch: true });
    expect(strictReport.verdict).toBe('incomparable');
    expect(strictReport.metadataDiff.mismatches.join('\n')).toContain('superMcpRouterConfigHash mismatch');
  });

  it('detects gitHash mismatch as incomparable without axis', () => {
    const baseline = normalize(makeRawOutput({ metadata: { gitHash: 'hash-a' } }), 'baseline');
    const candidate = normalize(makeRawOutput({ metadata: { gitHash: 'hash-b' } }), 'candidate');

    const report = diffConnectorBuildBaselines(baseline, candidate);
    expect(report.verdict).toBe('incomparable');
    expect(report.metadataDiff.mismatches.join('\n')).toContain('gitHash differs');
  });

  it('builds a correct per-fixture matrix for all four transitions', () => {
    const baseline = normalize(makeRawOutput({
      summary: { passRate: 0.5 },
      results: [
        { fixtureId: 'pp', passed: true },
        { fixtureId: 'pf', passed: true },
        { fixtureId: 'fp', passed: false, assertions: [{ type: 'expected_file', pattern: 'x', passed: false }] },
        { fixtureId: 'ff', passed: false, error: 'baseline failure' },
      ],
    }), 'baseline');
    const candidate = normalize(makeRawOutput({
      summary: { passRate: 0.5 },
      results: [
        { fixtureId: 'pp', passed: true },
        { fixtureId: 'pf', passed: false, stalledByWatchdog: true },
        { fixtureId: 'fp', passed: true },
        { fixtureId: 'ff', passed: false, error: 'candidate failure' },
      ],
    }), 'candidate');

    const report = diffConnectorBuildBaselines(baseline, candidate);
    expect(report.verdict).toBe('flat');
    expect(report.perFixture.counts).toEqual({
      passToPass: 1,
      passToFail: 1,
      failToPass: 1,
      failToFail: 1,
    });
    expect(report.perFixture.matrix.find((row) => row.fixtureId === 'pp')?.transition).toBe('pass→pass');
    expect(report.perFixture.matrix.find((row) => row.fixtureId === 'pf')?.transition).toBe('pass→fail');
    expect(report.perFixture.matrix.find((row) => row.fixtureId === 'fp')?.transition).toBe('fail→pass');
    expect(report.perFixture.matrix.find((row) => row.fixtureId === 'ff')?.transition).toBe('fail→fail');
  });

  it('applies infrastructure low-confidence guard at >10% (9% stays normal, 11% is low-confidence)', () => {
    const baseline = normalize(makeRawOutput({
      metadata: { totalFixtures: 100, anthropicApiErrorsObserved: 0 },
      summary: { passRate: 0.5 },
    }), 'baseline');

    const candidateNine = normalize(makeRawOutput({
      metadata: { totalFixtures: 100, anthropicApiErrorsObserved: 9 },
      summary: { passRate: 0.5 },
    }), 'candidate');
    const reportNine = diffConnectorBuildBaselines(baseline, candidateNine);
    expect(reportNine.infrastructureGuard.lowConfidence).toBe(false);
    expect(reportNine.verdict).toBe('flat');

    const candidateEleven = normalize(makeRawOutput({
      metadata: { totalFixtures: 100, anthropicApiErrorsObserved: 11 },
      summary: { passRate: 0.5 },
    }), 'candidate');
    const reportEleven = diffConnectorBuildBaselines(baseline, candidateEleven);
    expect(reportEleven.infrastructureGuard.lowConfidence).toBe(true);
    expect(reportEleven.verdict).toBe('low-confidence');
  });

  it('handles legacy outputs missing Stage 0.6 metadata fields with warnings (no crash)', () => {
    const legacy = normalize({
      metadata: {
        gitHash: 'legacy-hash',
        gitBranch: 'dev',
      },
      summary: {
        passRate: 0.5,
      },
      results: [
        { fixtureId: 'fixture-a', passed: true },
        { fixtureId: 'fixture-b', passed: false },
      ],
    }, 'baseline');
    const candidate = normalize(makeRawOutput({ metadata: { gitHash: 'legacy-hash' } }), 'candidate');

    const report = diffConnectorBuildBaselines(legacy, candidate, { allowTrialMismatch: true });
    expect(report.warnings.some((warning) => warning.includes('legacy result metadata missing'))).toBe(true);
    expect(['flat', 'improvement', 'regression', 'low-confidence', 'incomparable']).toContain(report.verdict);
  });

  it('marks trial mismatch incomparable by default and comparable with --allow-trial-mismatch', () => {
    const baseline = normalize(makeRawOutput({ metadata: { trialIndex: 1, trialCount: 3 } }), 'baseline');
    const candidate = normalize(makeRawOutput({ metadata: { trialIndex: 2, trialCount: 3 } }), 'candidate');

    const defaultReport = diffConnectorBuildBaselines(baseline, candidate);
    expect(defaultReport.verdict).toBe('incomparable');
    expect(defaultReport.metadataDiff.mismatches.join('\n')).toContain('trialIndex/trialCount mismatch');

    const allowedReport = diffConnectorBuildBaselines(baseline, candidate, { allowTrialMismatch: true });
    expect(allowedReport.verdict).toBe('flat');
  });
});
