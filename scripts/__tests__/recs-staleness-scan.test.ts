import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { RecommendationRow } from '../postmortem-recommendations-tracker';
import { serializeClaimsFile } from '../recs-claim';
import {
  buildRowsByFingerprint,
  detectStaleClaims,
  detectDeadTarget,
  detectFamilySupersession,
  detectShippedLanguage,
  detectStaleBlocked,
  extractCommitShas,
  extractRepoPaths,
  extractShippedPhrases,
  formatMarkdownSummary,
  parseGeneratedIndex,
  parseYyMmDd,
  runStalenessScan,
  type GeneratedIndexCluster,
} from '../recs-staleness-scan';

function baseRow(overrides: Partial<RecommendationRow> = {}): RecommendationRow {
  return {
    fingerprint: 'aaaaaaaaaaaaaaaa',
    postmortem: 'test_postmortem.md',
    bug_id: 'test_bug',
    action_type: 'test_coverage',
    description: 'baseline description',
    priority: 'medium',
    status: 'open',
    first_recorded: '260601',
    last_revisited: null,
    rejection_reason: null,
    absorbed_into: null,
    revisit_signal: null,
    owner: null,
    reason_kind: null,
    cluster_id: null,
    is_quarantined: false,
    ...overrides,
  };
}

function writeFixtureIndex(dir: string, body: string): string {
  const indexPath = path.join(dir, 'index.generated.yaml');
  fs.writeFileSync(indexPath, body, 'utf-8');
  return indexPath;
}

describe('recs-staleness-scan helpers', () => {
  it('parses YYMMDD dates', () => {
    const date = parseYyMmDd('260611');
    expect(date?.toISOString()).toBe('2026-06-11T00:00:00.000Z');
    expect(parseYyMmDd('991332')).toBeNull();
  });

  it('extracts commit SHAs and shipped phrases with word boundaries', () => {
    expect(extractCommitShas('fix in 4f426e7b9 and deadbeef12345678')).toEqual([
      '4f426e7b9',
      'deadbeef12345678',
    ]);
    expect(extractShippedPhrases('SHIPPED in 4f426e7b9')).toEqual(['SHIPPED']);
    expect(extractShippedPhrases('Follow-up (not yet shipped)')).toEqual([]);
    expect(extractShippedPhrases('notshipped language')).toEqual([]);
    expect(extractShippedPhrases('implemented in commit abc')).toEqual(['implemented in']);
  });

  it('extracts repo-relative path tokens', () => {
    const paths = extractRepoPaths(
      'Touch src/core/utils/foo.ts and scripts/check-foo.ts plus docs/project/BAR.md',
    );
    expect(paths).toEqual([
      'src/core/utils/foo.ts',
      'scripts/check-foo.ts',
      'docs/project/BAR.md',
    ]);
    expect(extractRepoPaths('See mobile/package.json. and mobile/RN')).toEqual([
      'mobile/package.json',
    ]);
  });
});

describe('shipped-language detector', () => {
  it('emits implemented-candidate only for a strict closure phrase with verified SHA', () => {
    const shortSha = '4f426e7b9';
    const candidate = detectShippedLanguage(
      baseRow({ description: `SHIPPED ${shortSha}` }),
      (sha) => sha === shortSha,
    );
    expect(candidate).toMatchObject({
      detector: 'shipped-language',
      suggested_status: 'implemented-candidate',
      evidence: {
        shas: [{ sha: shortSha, verified: true, negated_context: false }],
        strict_matches: [{ target: shortSha, target_type: 'sha', verified: true }],
      },
    });
  });

  it('emits implemented-candidate for an implemented-in planning path that exists', () => {
    const planPath = 'docs/plans/260611_recs-triage-system/PLAN.md';
    const candidate = detectShippedLanguage(
      baseRow({ description: `implemented in ${planPath}` }),
      () => false,
      (repoPath) => repoPath === planPath,
    );
    expect(candidate).toMatchObject({
      detector: 'shipped-language',
      suggested_status: 'implemented-candidate',
      evidence: {
        strict_matches: [{ target: planPath, target_type: 'plan-path', verified: true }],
      },
    });
  });

  it('emits needs-verification on unverified SHA-only evidence', () => {
    const candidate = detectShippedLanguage(
      baseRow({ description: 'Maybe fixed in deadbeef12345678' }),
      () => false,
    );
    expect(candidate).toMatchObject({
      detector: 'shipped-language',
      suggested_status: 'needs-verification',
      evidence: {
        shas: [{ sha: 'deadbeef12345678', verified: false, negated_context: false }],
      },
    });
  });

  it('emits needs-verification on weak shipped phrases without strict closure evidence', () => {
    const candidate = detectShippedLanguage(
      baseRow({ description: 'This was done in fix for the race' }),
      () => false,
    );
    expect(candidate).toMatchObject({
      detector: 'shipped-language',
      suggested_status: 'needs-verification',
      evidence: { phrases: ['done in fix'] },
    });
  });

  it('does not emit implemented-candidate for the review false-positive snippets', () => {
    const snippets = [
      'NOT drain-now: production mode shipped-dead-recovery-path should remain guarded.',
      'Follow-up (not yet shipped)',
      'OAuth secret SHA range described buggy history, not a fix: introduced in 1111111 and regressed in 2222222.',
      'we just shipped the bug',
      'RELEASE committed fix 3333333 but unreleased',
    ];

    for (const description of snippets) {
      const candidate = detectShippedLanguage(
        baseRow({ description }),
        () => true,
      );
      expect(candidate?.suggested_status).not.toBe('implemented-candidate');
    }
  });

  it('ignores quarantined and non-open rows', () => {
    expect(
      detectShippedLanguage(baseRow({ is_quarantined: true, description: 'SHIPPED' })),
    ).toBeNull();
    expect(
      detectShippedLanguage(baseRow({ status: 'implemented', description: 'SHIPPED' })),
    ).toBeNull();
  });
});

describe('dead-target detector', () => {
  it('fires when all referenced paths are missing', () => {
    const candidate = detectDeadTarget(
      baseRow({
        description: 'Update src/missing/one.ts and scripts/missing-two.ts',
      }),
      () => false,
    );
    expect(candidate).toMatchObject({
      detector: 'dead-target',
      suggested_status: 'target-review',
    });
  });

  it('does not fire when any referenced path exists', () => {
    const candidate = detectDeadTarget(
      baseRow({
        description: 'Update scripts/recs-staleness-scan.ts and src/missing/one.ts',
      }),
      (repoPath) => repoPath === 'scripts/recs-staleness-scan.ts',
    );
    expect(candidate).toBeNull();
  });

  it('does not fire when no paths are referenced', () => {
    expect(detectDeadTarget(baseRow({ description: 'No file paths here' }), () => false)).toBeNull();
  });

  it('does not fire for the review false positives', () => {
    const existingAfterPunctuation = new Set([
      'mobile/package.json',
      'docs/project/SUBAGENT_REFERENCE.md',
      'scripts/__tests__/check-alias-integrity.test.ts',
      'src/main/index.ts',
    ]);
    const cases = [
      'mobile/package.json.',
      'docs/project/SUBAGENT_REFERENCE.md.',
      'scripts/__tests__/check-alias-integrity.test.ts.',
      'src/main/index.ts.',
      'mobile/cloud-service/cloud-client',
      'mobile/RN',
      'add scripts/check-oss-connector-pin-published.ts',
      'should introduce scripts/check-markdown-url-guards.ts',
    ];

    for (const description of cases) {
      const candidate = detectDeadTarget(
        baseRow({ description }),
        (repoPath) => existingAfterPunctuation.has(repoPath),
      );
      expect(candidate).toBeNull();
    }
  });
});

describe('family-supersession detector', () => {
  const clusters: GeneratedIndexCluster[] = [
    {
      cluster_id: 'cluster-a',
      fingerprints: ['open-fp', 'implemented-fp'],
    },
  ];
  const rowsByFingerprint = buildRowsByFingerprint([
    baseRow({ fingerprint: 'open-fp', cluster_id: 'cluster-a' }),
    baseRow({ fingerprint: 'implemented-fp', status: 'implemented', cluster_id: 'cluster-a' }),
  ]);

  it('fires when another cluster member is implemented', () => {
    const candidate = detectFamilySupersession(
      baseRow({ fingerprint: 'open-fp', cluster_id: 'cluster-a' }),
      clusters,
      rowsByFingerprint,
    );
    expect(candidate).toMatchObject({
      detector: 'family-supersession',
      suggested_status: 'superseded-review',
      evidence: {
        cluster_id: 'cluster-a',
        implemented_member_fingerprints: ['implemented-fp'],
      },
    });
  });

  it('degrades to zero when clusters are empty', () => {
    expect(
      detectFamilySupersession(
        baseRow({ fingerprint: 'open-fp', cluster_id: 'cluster-a' }),
        [],
        rowsByFingerprint,
      ),
    ).toBeNull();
  });

  it('does not fire without cluster_id', () => {
    expect(
      detectFamilySupersession(baseRow({ fingerprint: 'open-fp' }), clusters, rowsByFingerprint),
    ).toBeNull();
  });
});

describe('stale-blocked detector', () => {
  it('fires for blocked-on-signal rows past the threshold', () => {
    const candidate = detectStaleBlocked(
      baseRow({
        status: 'blocked-on-signal',
        last_revisited: '260101',
        revisit_signal: 'wait for beta',
        owner: 'greg',
      }),
      45,
      new Date('2026-06-12T12:00:00.000Z'),
    );
    expect(candidate).toMatchObject({
      detector: 'stale-blocked',
      suggested_status: 'none',
      evidence: {
        last_revisited: '260101',
        stale_days_threshold: 45,
      },
    });
    expect(candidate?.evidence.age_days).toBeGreaterThan(45);
  });

  it('does not fire for recent blocked rows', () => {
    expect(
      detectStaleBlocked(
        baseRow({ status: 'blocked-on-signal', last_revisited: '260611' }),
        45,
        new Date('2026-06-12T12:00:00.000Z'),
      ),
    ).toBeNull();
  });

  it('does not fire for open rows', () => {
    expect(
      detectStaleBlocked(
        baseRow({ status: 'open', last_revisited: '260101' }),
        45,
        new Date('2026-06-12T12:00:00.000Z'),
      ),
    ).toBeNull();
  });
});

describe('parseGeneratedIndex + runStalenessScan integration', () => {
  it('parses fixture index in mkdtemp and aggregates detector counts', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'recs-staleness-scan-'));
    const verifiedSha = '4f426e7b9';
    const yaml = `
generated_count: 2
clusters: []
recommendations:
  - fingerprint: fp-shipped
    postmortem: pm.md
    bug_id: bug1
    action_type: test_coverage
    description: "SHIPPED ${verifiedSha}"
    priority: high
    status: open
    first_recorded: "260601"
    last_revisited: null
    rejection_reason: null
    absorbed_into: null
    revisit_signal: null
    owner: null
    reason_kind: null
    cluster_id: null
    is_quarantined: false
  - fingerprint: fp-dead
    postmortem: pm.md
    bug_id: bug2
    action_type: test_coverage
    description: "Retire src/nowhere/missing.ts"
    priority: high
    status: open
    first_recorded: "260601"
    last_revisited: null
    rejection_reason: null
    absorbed_into: null
    revisit_signal: null
    owner: null
    reason_kind: null
    cluster_id: null
    is_quarantined: false
`;
    const indexPath = writeFixtureIndex(dir, yaml);
    const parsed = parseGeneratedIndex(fs.readFileSync(indexPath, 'utf-8'));
    const report = runStalenessScan({
      index: parsed,
      verifySha: (sha) => sha === verifiedSha,
      pathExistsFn: () => false,
    });

    expect(report.counts_by_detector['shipped-language']).toBe(1);
    expect(report.counts_by_detector['dead-target']).toBe(1);
    expect(report.counts_by_detector['family-supersession']).toBe(0);
    expect(report.counts_by_detector['stale-blocked']).toBe(0);
    expect(report.live_queue_count).toBe(2);

    report.index_path = path.basename(indexPath);
    const summary = formatMarkdownSummary(report);
    expect(summary).toContain('shipped-language: 1');
    expect(summary).toContain('dead-target: 1');
    expect(summary).toContain('family-supersession: 0');
    expect(summary).toContain('stale-blocked: 0');

    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it('emits byte-identical JSON for identical inputs', () => {
    const parsed = parseGeneratedIndex(`
generated_count: 1
clusters: []
recommendations:
  - fingerprint: fp-shipped
    postmortem: pm.md
    bug_id: bug1
    action_type: test_coverage
    description: "SHIPPED 4f426e7b9"
    priority: high
    status: open
    first_recorded: "260601"
    last_revisited: null
    rejection_reason: null
    absorbed_into: null
    revisit_signal: null
    owner: null
    reason_kind: null
    cluster_id: null
    is_quarantined: false
`);
    const options = {
      index: parsed,
      verifySha: (sha: string) => sha === '4f426e7b9',
      pathExistsFn: () => false,
    };

    const first = JSON.stringify(runStalenessScan(options), null, 2);
    const second = JSON.stringify(runStalenessScan(options), null, 2);
    expect(second).toBe(first);
  });
});

describe('stale-claims section', () => {
  const TODAY = new Date('2026-06-12T12:00:00.000Z');

  function claimsFixtureIndex() {
    return {
      recommendations: [
        baseRow({ fingerprint: 'fp-live', status: 'open' }),
        baseRow({ fingerprint: 'fp-live-expired', status: 'open' }),
        baseRow({ fingerprint: 'fp-closed', status: 'implemented' }),
      ],
      clusters: [] as GeneratedIndexCluster[],
    };
  }

  const CLAIMS_YAML = serializeClaimsFile({
    // Active claim on a live row — NOT stale, must not be reported.
    'fp-live': { run_slug: 'run-active', claimed_at: '2026-06-12T11:00:00.000Z', ttl_hours: 48 },
    // TTL passed → expired.
    'fp-live-expired': { run_slug: 'run-expired', claimed_at: '2026-06-10T00:00:00.000Z', ttl_hours: 1 },
    // Row curated closed → closed-row (the normal implicit-release residue).
    'fp-closed': { run_slug: 'run-closed', claimed_at: '2026-06-12T11:00:00.000Z', ttl_hours: 48 },
    // Key matches nothing in the corpus → orphan.
    'fp-orphan': { run_slug: 'run-orphan', claimed_at: '2026-06-12T11:00:00.000Z', ttl_hours: 48 },
  });

  it('reports expired, closed-row, and orphan claims with run_slug + age, and skips active ones', () => {
    const report = runStalenessScan({
      index: claimsFixtureIndex(),
      claimsYaml: CLAIMS_YAML,
      today: TODAY,
      verifySha: () => false,
      pathExistsFn: () => false,
    });

    expect(report.stale_claims).toEqual([
      expect.objectContaining({ id: 'fp-closed', state: 'closed-row', run_slug: 'run-closed', age_hours: 1 }),
      expect.objectContaining({ id: 'fp-live-expired', state: 'expired', run_slug: 'run-expired' }),
      expect.objectContaining({ id: 'fp-orphan', state: 'orphan', run_slug: 'run-orphan', age_hours: 1 }),
    ]);
    expect(report.stale_claims.map((claim) => claim.id)).not.toContain('fp-live');

    const summary = formatMarkdownSummary({ ...report, index_path: 'index.yaml' });
    expect(summary).toContain('## Stale claims (GC candidates)');
    expect(summary).toContain('- fp-live-expired: expired — run run-expired');
    expect(summary).toContain('- fp-closed: closed-row — run run-closed, age 1h (ttl 48h)');
    expect(summary).toContain('- fp-orphan: orphan — run run-orphan');
    expect(summary).not.toContain('fp-live:');
  });

  it('reports an empty section when all claims are active or no claims file exists', () => {
    const activeOnly = serializeClaimsFile({
      'fp-live': { run_slug: 'run-active', claimed_at: '2026-06-12T11:00:00.000Z', ttl_hours: 48 },
    });
    const withActive = runStalenessScan({
      index: claimsFixtureIndex(),
      claimsYaml: activeOnly,
      today: TODAY,
      verifySha: () => false,
      pathExistsFn: () => false,
    });
    expect(withActive.stale_claims).toEqual([]);

    const withoutFile = runStalenessScan({
      index: claimsFixtureIndex(),
      today: TODAY,
      verifySha: () => false,
      pathExistsFn: () => false,
    });
    expect(withoutFile.stale_claims).toEqual([]);
    expect(withoutFile.claims_path).toBeNull();

    const summary = formatMarkdownSummary({ ...withoutFile, index_path: 'index.yaml' });
    expect(summary).toContain('## Stale claims (GC candidates)');
    expect(summary).toContain('- none');
  });

  it('detectStaleClaims is deterministic and byte-stable for identical inputs', () => {
    const first = JSON.stringify(detectStaleClaims(CLAIMS_YAML, claimsFixtureIndex(), TODAY), null, 2);
    const second = JSON.stringify(detectStaleClaims(CLAIMS_YAML, claimsFixtureIndex(), TODAY), null, 2);
    expect(second).toBe(first);

    const options = {
      index: claimsFixtureIndex(),
      claimsYaml: CLAIMS_YAML,
      today: TODAY,
      verifySha: () => false,
      pathExistsFn: () => false,
    };
    const firstReport = JSON.stringify(runStalenessScan(options), null, 2);
    const secondReport = JSON.stringify(runStalenessScan(options), null, 2);
    expect(secondReport).toBe(firstReport);
  });
});
