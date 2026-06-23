import { describe, expect, it } from 'vitest';
import {
  buildIndex,
  extractRecommendationsFromText,
  formatTrackerWarnings,
  generateIndexYaml,
  parseExistingIndex,
  validateOverridesDetailed,
  validateOverrides,
  OVERRIDES_PATH,
  GENERATED_PATH,
  CLUSTERS_PATH,
  loadClusterCatalogIfPresent,
  type ManualOverride,
  type RecommendationClusterCatalog,
  type RecommendationRow,
} from '../postmortem-recommendations-tracker';
import * as fs from 'fs';

function buildRow(overrides: Partial<RecommendationRow> = {}): RecommendationRow {
  return {
    fingerprint: 'abc1234567890def',
    postmortem: '260101_test_postmortem.md',
    bug_id: '260101_test_bug',
    action_type: 'test_coverage',
    description: 'add coverage for X',
    priority: 'high',
    status: 'open',
    first_recorded: '260101',
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

describe('extractRecommendationsFromText', () => {
  it('extracts a single [BUG-PREVENTION] line correctly', () => {
    const text = [
      '# Some Postmortem',
      'Body content',
      '',
      '[BUG-POSTMORTEM] {"bug_id":"260101_demo","severity":"low"}',
      '[BUG-PREVENTION] {"bug_id":"260101_demo","action_type":"test_coverage","description":"add coverage","priority":"high"}',
      '',
    ].join('\n');
    const rows = extractRecommendationsFromText(text, '260101_demo_postmortem.md');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      bug_id: '260101_demo',
      action_type: 'test_coverage',
      description: 'add coverage',
      priority: 'high',
      first_recorded: '260101',
    });
    expect(rows[0]!.fingerprint).toHaveLength(16);
  });

  it('extracts multiple [BUG-PREVENTION] lines in order', () => {
    const text = [
      '[BUG-PREVENTION] {"bug_id":"260101_x","action_type":"test_coverage","description":"d1","priority":"high"}',
      '[BUG-PREVENTION] {"bug_id":"260101_x","action_type":"agent_instructions","description":"d2","priority":"medium"}',
      '[BUG-PREVENTION] {"bug_id":"260101_x","action_type":"review_focus","description":"d3","priority":"low"}',
    ].join('\n');
    const rows = extractRecommendationsFromText(text, '260101_x_postmortem.md');
    expect(rows.map((r) => r.action_type)).toEqual(['test_coverage', 'agent_instructions', 'review_focus']);
  });

  it('generates a deterministic fingerprint (16 hex chars)', () => {
    const text = '[BUG-PREVENTION] {"bug_id":"260101_x","action_type":"test_coverage","description":"d","priority":"high"}';
    const a = extractRecommendationsFromText(text, '260101_x_postmortem.md');
    const b = extractRecommendationsFromText(text, '260101_x_postmortem.md');
    expect(a[0]!.fingerprint).toEqual(b[0]!.fingerprint);
    expect(a[0]!.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('falls back to "no-recommendations" synthetic row for postmortems with only [BUG-POSTMORTEM] trailer', () => {
    const text = [
      '# Postmortem',
      '[BUG-POSTMORTEM] {"bug_id":"260101_empty","severity":"low"}',
    ].join('\n');
    const rows = extractRecommendationsFromText(text, '260101_empty_postmortem.md');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action_type).toBe('no-recommendations');
  });

  it('throws on malformed [BUG-PREVENTION] JSON', () => {
    const text = '[BUG-PREVENTION] {not valid json}';
    expect(() => extractRecommendationsFromText(text, '260101_x_postmortem.md')).toThrow(/did not parse as JSON/);
  });

  it('throws when [BUG-PREVENTION] is missing required fields', () => {
    const text = '[BUG-PREVENTION] {"bug_id":"260101_x"}';
    expect(() => extractRecommendationsFromText(text, '260101_x_postmortem.md')).toThrow(/missing required string field "action_type"/);
  });

  it('handles postmortems with no trailers (empty output)', () => {
    const text = '# Just a body, no trailers.\n';
    const rows = extractRecommendationsFromText(text, '260101_x_postmortem.md');
    expect(rows).toHaveLength(0);
  });
});

describe('generateIndexYaml + parseExistingIndex round-trip', () => {
  it('round-trips a single row + manual override', () => {
    const rows = [
      buildRow({
        status: 'implemented',
        last_revisited: '260301',
        rejection_reason: null,
      }),
    ];
    const overrides: Record<string, ManualOverride> = {
      [rows[0]!.fingerprint]: { status: 'implemented', last_revisited: '260301' },
    };
    const yaml = generateIndexYaml(rows, overrides);
    const parsed = parseExistingIndex(yaml);
    expect(parsed.generated_count).toBe(1);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      bug_id: '260101_test_bug',
      action_type: 'test_coverage',
      status: 'implemented',
      last_revisited: '260301',
    });
    expect(parsed.manual_overrides).toEqual({
      [rows[0]!.fingerprint]: { status: 'implemented', last_revisited: '260301' },
    });
  });

  it('round-trips a rejected override with rejection_reason', () => {
    const fp = 'fingerprint00001';
    const rows = [
      buildRow({
        fingerprint: fp,
        status: 'rejected',
        last_revisited: '260201',
        rejection_reason: 'duplicate of bug X',
      }),
    ];
    const overrides: Record<string, ManualOverride> = {
      [fp]: { status: 'rejected', last_revisited: '260201', rejection_reason: 'duplicate of bug X' },
    };
    const yaml = generateIndexYaml(rows, overrides);
    const parsed = parseExistingIndex(yaml);
    expect(parsed.rows[0]!.rejection_reason).toBe('duplicate of bug X');
    expect(parsed.manual_overrides[fp]!.rejection_reason).toBe('duplicate of bug X');
  });

  it('round-trips absorbed and blocked-on-signal status metadata', () => {
    const absorbedFp = 'absorbed0000001';
    const blockedFp = 'blocked00000001';
    const rows = [
      buildRow({
        fingerprint: absorbedFp,
        status: 'absorbed',
        last_revisited: '260201',
        absorbed_into: 'docs/project/CODING_PRINCIPLES.md',
      }),
      buildRow({
        fingerprint: blockedFp,
        bug_id: '260101_blocked',
        status: 'blocked-on-signal',
        last_revisited: '260202',
        revisit_signal: 'qa13-hotlist-recurrence',
        owner: 'weekly-review',
      }),
    ];
    const overrides: Record<string, ManualOverride> = {
      [absorbedFp]: {
        status: 'absorbed',
        last_revisited: '260201',
        absorbed_into: 'docs/project/CODING_PRINCIPLES.md',
      },
      [blockedFp]: {
        status: 'blocked-on-signal',
        last_revisited: '260202',
        revisit_signal: 'qa13-hotlist-recurrence',
        owner: 'weekly-review',
      },
    };
    const yaml = generateIndexYaml(rows, overrides);
    const parsed = parseExistingIndex(yaml);
    expect(parsed.rows.find((row) => row.fingerprint === absorbedFp)).toMatchObject({
      status: 'absorbed',
      absorbed_into: 'docs/project/CODING_PRINCIPLES.md',
    });
    expect(parsed.rows.find((row) => row.fingerprint === blockedFp)).toMatchObject({
      status: 'blocked-on-signal',
      revisit_signal: 'qa13-hotlist-recurrence',
      owner: 'weekly-review',
    });
    expect(parsed.manual_overrides[absorbedFp]).toMatchObject({
      status: 'absorbed',
      absorbed_into: 'docs/project/CODING_PRINCIPLES.md',
    });
    expect(parsed.manual_overrides[blockedFp]).toMatchObject({
      status: 'blocked-on-signal',
      revisit_signal: 'qa13-hotlist-recurrence',
      owner: 'weekly-review',
    });
  });

  it('round-trips a curation-only cluster entry without changing status', () => {
    const fp = 'clusteronly0001';
    const rows = [buildRow({ fingerprint: fp, cluster_id: 'ipc-contracts' })];
    const overrides: Record<string, ManualOverride> = {
      [fp]: { cluster_id: 'ipc-contracts' },
    };
    const yaml = generateIndexYaml(rows, overrides, {
      clusters: [
        {
          cluster_id: 'ipc-contracts',
          title: 'IPC contracts',
          canonical_statement: 'Keep IPC contracts schema-first.',
        },
      ],
    });
    const parsed = parseExistingIndex(yaml);
    expect(parsed.rows[0]).toMatchObject({ status: 'open', cluster_id: 'ipc-contracts' });
    expect(parsed.manual_overrides[fp]).toEqual({ cluster_id: 'ipc-contracts' });
    expect(yaml).toContain('live_member_count: 1');
    expect(yaml).toContain(`      - ${fp}`);
  });

  it('emits quarantine flags and live queue summary counts', () => {
    const yaml = generateIndexYaml(
      [
        buildRow({ fingerprint: 'canonical0000001', status: 'open', action_type: 'test_coverage' }),
        buildRow({
          fingerprint: 'synthetic000000',
          status: 'open',
          action_type: 'no-recommendations',
          is_quarantined: true,
        }),
        buildRow({
          fingerprint: 'freeform0000001',
          status: 'open',
          action_type: 'monitoring',
          is_quarantined: true,
        }),
      ],
      {},
    );
    expect(yaml).toContain('  live_queue_count: 1');
    expect(yaml).toContain('  quarantined_count: 2');
    expect(yaml.match(/is_quarantined: true/g)).toHaveLength(2);
  });

  it('round-trips quoted strings and special characters', () => {
    const rows = [
      buildRow({
        description: 'Has "quotes" and special: chars / paths',
      }),
    ];
    const yaml = generateIndexYaml(rows, {});
    const parsed = parseExistingIndex(yaml);
    expect(parsed.rows[0]!.description).toBe('Has "quotes" and special: chars / paths');
  });

  it('sorts rows by date desc then bug_id then fingerprint', () => {
    const rows = [
      buildRow({ first_recorded: '260101', bug_id: '260101_z', fingerprint: 'aaaaaaaaaaaaaaaa' }),
      buildRow({ first_recorded: '260301', bug_id: '260301_a', fingerprint: 'bbbbbbbbbbbbbbbb' }),
      buildRow({ first_recorded: '260201', bug_id: '260201_m', fingerprint: 'cccccccccccccccc' }),
    ];
    const yaml = generateIndexYaml(rows, {});
    const parsed = parseExistingIndex(yaml);
    expect(parsed.rows.map((r) => r.first_recorded)).toEqual(['260301', '260201', '260101']);
  });

  it('round-trips an empty manual_overrides map', () => {
    const rows = [buildRow()];
    const yaml = generateIndexYaml(rows, {});
    expect(yaml).toContain('manual_overrides:\n  {}');
    const parsed = parseExistingIndex(yaml);
    expect(parsed.manual_overrides).toEqual({});
  });

  it('produces stable output (regenerating same input yields identical bytes)', () => {
    const rows = [buildRow(), buildRow({ fingerprint: 'fingerprint00002', bug_id: '260101_other' })];
    const a = generateIndexYaml(rows, {});
    const b = generateIndexYaml(rows, {});
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// validateOverrides — new strict gate
// ---------------------------------------------------------------------------

function makeOverridesYaml(
  entries: Array<{ fp: string; status?: string; last_revisited?: string; fields?: Record<string, string> }>,
): string {
  const lines = ['manual_overrides:'];
  for (const e of entries) {
    const quotedFp = /[^A-Za-z0-9_./:-]/.test(e.fp) ? `"${e.fp}"` : e.fp;
    lines.push(`  ${quotedFp}:`);
    if (e.status !== undefined) {
      lines.push(`    status: ${e.status}`);
    }
    if (e.last_revisited !== undefined) {
      lines.push(`    last_revisited: "${e.last_revisited}"`);
    }
    for (const [key, value] of Object.entries(e.fields ?? {})) {
      lines.push(`    ${key}: "${value}"`);
    }
  }
  return lines.join('\n') + '\n';
}

function makeLiveRow(fp: string, overrides: Partial<RecommendationRow> = {}): RecommendationRow {
  return {
    fingerprint: fp,
    postmortem: '260101_test_postmortem.md',
    bug_id: '260101_test_bug',
    action_type: 'test_coverage',
    description: 'add coverage for X',
    priority: 'high',
    status: 'open',
    first_recorded: '260101',
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

const TEST_CLUSTER_CATALOG: RecommendationClusterCatalog = {
  clusters: [
    {
      cluster_id: 'ipc-contracts',
      title: 'IPC contracts',
      canonical_statement: 'Keep IPC contracts schema-first.',
    },
  ],
};

describe('validateOverrides', () => {
  it('PASS: valid entry with known status and YYMMDD last_revisited', () => {
    const fp = 'abc1234567890def';
    const yaml = makeOverridesYaml([{ fp, status: 'implemented', last_revisited: '260531' }]);
    const liveRows = [makeLiveRow(fp)];
    const errors = validateOverrides(yaml, liveRows);
    expect(errors).toHaveLength(0);
  });

  it('FAIL: invalid status value', () => {
    const fp = 'abc1234567890def';
    const yaml = makeOverridesYaml([{ fp, status: 'done', last_revisited: '260531' }]);
    const liveRows = [makeLiveRow(fp)];
    const errors = validateOverrides(yaml, liveRows);
    const statusError = errors.find((e) => e.reason === 'invalid-status');
    expect(statusError).toBeTruthy();
    expect(statusError!.detail).toContain('"done"');
  });

  it('FAIL: orphan fingerprint (no matching live row)', () => {
    const fp = 'orphanfingerprint';
    const yaml = makeOverridesYaml([{ fp, status: 'implemented', last_revisited: '260531' }]);
    // liveRows does NOT contain fp
    const liveRows = [makeLiveRow('completely_different_fp')];
    const errors = validateOverrides(yaml, liveRows);
    const orphanError = errors.find((e) => e.reason === 'orphan-fingerprint');
    expect(orphanError).toBeTruthy();
    expect(orphanError!.fingerprint).toBe(fp);
  });

  it('FAIL: invalid last_revisited format', () => {
    const fp = 'abc1234567890def';
    const yaml = makeOverridesYaml([{ fp, status: 'implemented', last_revisited: '2025-05-31' }]);
    const liveRows = [makeLiveRow(fp)];
    const errors = validateOverrides(yaml, liveRows);
    const revisitError = errors.find((e) => e.reason === 'invalid-last-revisited');
    expect(revisitError).toBeTruthy();
  });

  it('FAIL: duplicate fingerprint keys', () => {
    const fp = 'abc1234567890def';
    // Manually build YAML with duplicate key
    const yaml = [
      'manual_overrides:',
      `  ${fp}:`,
      '    status: implemented',
      '    last_revisited: "260531"',
      `  ${fp}:`,
      '    status: open',
      '    last_revisited: "260601"',
    ].join('\n') + '\n';
    const liveRows = [makeLiveRow(fp)];
    const errors = validateOverrides(yaml, liveRows);
    const dupError = errors.find((e) => e.reason === 'duplicate-key');
    expect(dupError).toBeTruthy();
  });

  it('PASS: legacy-action fingerprint (pre-2026-05-25) passes if it maps to a live row', () => {
    // Legacy postmortems use `action` field instead of `action_type`; the fingerprint
    // was computed from the legacy action value. Simulate by having a row whose
    // fingerprint was computed with a legacy action value — if it maps to a live row, valid.
    const fp = 'legacy00000000fp';
    const yaml = makeOverridesYaml([{ fp, status: 'implemented', last_revisited: '260301' }]);
    // As long as we have a live row with that fingerprint, it passes
    const liveRows = [makeLiveRow(fp)];
    const errors = validateOverrides(yaml, liveRows);
    expect(errors).toHaveLength(0);
  });

  it('PASS: all non-reason-requiring statuses are accepted', () => {
    const statuses: string[] = ['open', 'implemented'];
    for (const status of statuses) {
      const fp = `fp_${status.replace('-', '_')}123456`;
      const yaml = makeOverridesYaml([{ fp, status, last_revisited: '260101' }]);
      const liveRows = [makeLiveRow(fp)];
      const errors = validateOverrides(yaml, liveRows);
      expect(errors).toHaveLength(0);
    }
  });

  it('PASS: absorbed status with absorbed_into is accepted', () => {
    const fp = 'abc1234567890def';
    const yaml = makeOverridesYaml([
      {
        fp,
        status: 'absorbed',
        last_revisited: '260101',
        fields: { absorbed_into: 'docs/project/CODING_PRINCIPLES.md' },
      },
    ]);
    const errors = validateOverrides(yaml, [makeLiveRow(fp)]);
    expect(errors).toHaveLength(0);
  });

  it('PASS: blocked-on-signal status with revisit_signal is accepted', () => {
    const fp = 'abc1234567890def';
    const yaml = makeOverridesYaml([
      {
        fp,
        status: 'blocked-on-signal',
        last_revisited: '260101',
        fields: { revisit_signal: 'qa13-hotlist-recurrence', owner: 'weekly-review' },
      },
    ]);
    const errors = validateOverrides(yaml, [makeLiveRow(fp)]);
    expect(errors).toHaveLength(0);
  });

  it('FAIL: absorbed status without absorbed_into', () => {
    const fp = 'abc1234567890def';
    const yaml = makeOverridesYaml([{ fp, status: 'absorbed', last_revisited: '260101' }]);
    const errors = validateOverrides(yaml, [makeLiveRow(fp)]);
    expect(errors.some((e) => e.reason === 'missing-absorbed-into')).toBe(true);
  });

  it('FAIL: blocked-on-signal status without revisit_signal', () => {
    const fp = 'abc1234567890def';
    const yaml = makeOverridesYaml([{ fp, status: 'blocked-on-signal', last_revisited: '260101' }]);
    const errors = validateOverrides(yaml, [makeLiveRow(fp)]);
    expect(errors.some((e) => e.reason === 'missing-revisit-signal')).toBe(true);
  });

  it('PASS: curation-only cluster_id entry without status is accepted and warns zero-member catalog clusters only when empty', () => {
    const fp = 'abc1234567890def';
    const yaml = makeOverridesYaml([{ fp, fields: { cluster_id: 'ipc-contracts' } }]);
    const liveRows = [makeLiveRow(fp, { cluster_id: 'ipc-contracts' })];
    const result = validateOverridesDetailed(yaml, liveRows, TEST_CLUSTER_CATALOG);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('FAIL: cluster_id entry must exist in the catalog', () => {
    const fp = 'abc1234567890def';
    const yaml = makeOverridesYaml([{ fp, fields: { cluster_id: 'missing-cluster' } }]);
    const result = validateOverridesDetailed(yaml, [makeLiveRow(fp, { cluster_id: 'missing-cluster' })], TEST_CLUSTER_CATALOG);
    expect(result.errors.some((e) => e.reason === 'unknown-cluster-id')).toBe(true);
  });

  it('WARN: catalog cluster with zero live members is a prune signal, not a failure', () => {
    const result = validateOverridesDetailed('manual_overrides: {}\n', [makeLiveRow('abc1234567890def')], TEST_CLUSTER_CATALOG);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        reason: 'cluster-zero-live-members',
        detail: expect.stringContaining('ipc-contracts'),
      }),
    ]);
  });

  it('WARN: unknown override keys are ignored with a warning', () => {
    const fp = 'abc1234567890def';
    const yaml = makeOverridesYaml([
      { fp, status: 'implemented', last_revisited: '260101', fields: { imaginary_field: 'value' } },
    ]);
    const result = validateOverridesDetailed(yaml, [makeLiveRow(fp)]);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        reason: 'unknown-override-key',
        fingerprint: fp,
      }),
    ]);
  });

  it('FAIL: reason_kind is only accepted for rejected and wont-do entries', () => {
    const fp = 'abc1234567890def';
    const yaml = makeOverridesYaml([
      { fp, status: 'implemented', last_revisited: '260101', fields: { reason_kind: 'other' } },
    ]);
    const errors = validateOverrides(yaml, [makeLiveRow(fp)]);
    expect(errors.some((e) => e.reason === 'invalid-reason-kind')).toBe(true);
  });

  // --- F1: missing last_revisited must FAIL (previously passed) ---
  it('FAIL: missing last_revisited', () => {
    const fp = 'abc1234567890def';
    // makeOverridesYaml omits last_revisited when undefined
    const yaml = makeOverridesYaml([{ fp, status: 'implemented' }]);
    const liveRows = [makeLiveRow(fp)];
    const errors = validateOverrides(yaml, liveRows);
    const err = errors.find((e) => e.reason === 'missing-last-revisited');
    expect(err).toBeTruthy();
    expect(err!.fingerprint).toBe(fp);
  });

  // --- F2: garbage / empty / wrong-top-key YAML must FAIL (previously returned []) ---
  it('FAIL: empty file', () => {
    const errors = validateOverrides('', [makeLiveRow('abc1234567890def')]);
    expect(errors.length).toBeGreaterThan(0);
    // empty parses to null → no-manual-overrides / not-a-mapping
    expect(errors.some((e) => e.reason === 'no-manual-overrides' || e.reason === 'not-a-mapping')).toBe(true);
  });

  it('FAIL: garbage / unparseable YAML', () => {
    const garbage = 'manual_overrides:\n  "fp1":\n    status: implemented\n   bad-indent: : :\n';
    const errors = validateOverrides(garbage, [makeLiveRow('fp1')]);
    expect(errors.some((e) => e.reason === 'yaml-parse-error' || e.reason === 'duplicate-key')).toBe(true);
  });

  it('FAIL: wrong top-level key (no manual_overrides)', () => {
    const yaml = 'something_else:\n  "fp1":\n    status: implemented\n    last_revisited: "260101"\n';
    const errors = validateOverrides(yaml, [makeLiveRow('fp1')]);
    const err = errors.find((e) => e.reason === 'no-manual-overrides');
    expect(err).toBeTruthy();
  });

  // --- F3: rejected / wont-do without rejection_reason must FAIL ---
  it('FAIL: rejected status without rejection_reason', () => {
    const fp = 'abc1234567890def';
    const yaml = makeOverridesYaml([{ fp, status: 'rejected', last_revisited: '260101' }]);
    const liveRows = [makeLiveRow(fp)];
    const errors = validateOverrides(yaml, liveRows);
    const err = errors.find((e) => e.reason === 'missing-rejection-reason');
    expect(err).toBeTruthy();
    expect(err!.fingerprint).toBe(fp);
  });

  it('FAIL: wont-do status without rejection_reason', () => {
    const fp = 'abc1234567890def';
    const yaml = makeOverridesYaml([{ fp, status: 'wont-do', last_revisited: '260101' }]);
    const liveRows = [makeLiveRow(fp)];
    const errors = validateOverrides(yaml, liveRows);
    expect(errors.some((e) => e.reason === 'missing-rejection-reason')).toBe(true);
  });

  it('PASS: rejected status WITH a non-empty rejection_reason', () => {
    const fp = 'abc1234567890def';
    const yaml = [
      'manual_overrides:',
      `  "${fp}":`,
      '    status: rejected',
      '    last_revisited: "260101"',
      '    rejection_reason: "duplicate of bug X"',
    ].join('\n') + '\n';
    const liveRows = [makeLiveRow(fp)];
    const errors = validateOverrides(yaml, liveRows);
    expect(errors).toHaveLength(0);
  });

  it('FAIL: ambiguous fingerprint (>1 live row)', () => {
    const fp = 'abc1234567890def';
    const yaml = makeOverridesYaml([{ fp, status: 'implemented', last_revisited: '260101' }]);
    const liveRows = [makeLiveRow(fp), makeLiveRow(fp, { postmortem: 'other.md' })];
    const errors = validateOverrides(yaml, liveRows);
    expect(errors.some((e) => e.reason === 'ambiguous-fingerprint')).toBe(true);
  });

  it('error messages include the context comment when present', () => {
    const fp = 'abc1234567890def';
    const yaml = [
      'manual_overrides:',
      '  # 260101_demo · test_coverage · add coverage for X',
      `  "${fp}":`,
      '    status: bogus',
      '    last_revisited: "260101"',
    ].join('\n') + '\n';
    const errors = validateOverrides(yaml, [makeLiveRow(fp)]);
    const err = errors.find((e) => e.reason === 'invalid-status');
    expect(err).toBeTruthy();
    expect(err!.context).toContain('260101_demo');
  });
});

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

describe('path constants', () => {
  it('OVERRIDES_PATH points to the committed overrides file', () => {
    expect(OVERRIDES_PATH).toContain('_recommendations_overrides.yaml');
    expect(OVERRIDES_PATH).not.toContain('.generated.');
  });

  it('GENERATED_PATH points to the gitignored generated artifact', () => {
    expect(GENERATED_PATH).toContain('.generated.yaml');
  });

  it('CLUSTERS_PATH points to the committed cluster catalog', () => {
    expect(CLUSTERS_PATH).toContain('_recommendations_clusters.yaml');
  });

  it('OVERRIDES_PATH is a committed file that actually exists', () => {
    expect(fs.existsSync(OVERRIDES_PATH)).toBe(true);
  });
});

describe('formatTrackerWarnings', () => {
  it('prints all unknown override keys in a dedicated block and caps other warnings', () => {
    const warnings = [
      ...Array.from({ length: 12 }, (_, index) => ({
        filename: `unknown-${index}`,
        reason: 'unknown-override-key' as const,
        detail: `ignored unknown key ${index}`,
      })),
      ...Array.from({ length: 12 }, (_, index) => ({
        filename: `cluster-${index}`,
        reason: 'cluster-zero-live-members' as const,
        detail: `cluster ${index} has zero members`,
      })),
    ];

    const formatted = formatTrackerWarnings(warnings);

    expect(formatted).toContain('Unknown override keys (12) — all shown:');
    expect(formatted).toContain('unknown-11');
    expect(formatted).toContain('Other warnings (12). Showing first 10:');
    expect(formatted).toContain('cluster-9');
    expect(formatted).not.toContain('cluster-10');
  });
});

// ---------------------------------------------------------------------------
// Round-trip: committed overrides → all 43 project into live rows.
// Drives buildIndex() + validateOverrides() against the REAL corpus, so it does
// NOT depend on the gitignored generated artifact (it is non-vacuous in fresh CI).
// ---------------------------------------------------------------------------

describe('round-trip: committed overrides project onto live rows', () => {
  it('the committed overrides file passes strict validation against the live corpus', () => {
    const overridesYaml = fs.readFileSync(OVERRIDES_PATH, 'utf-8');
    const parsed = parseExistingIndex(overridesYaml);
    const overrideKeys = Object.keys(parsed.manual_overrides);
    expect(overrideKeys.length).toBeGreaterThanOrEqual(43); // at least 43 committed overrides

    // Regenerate the corpus rows directly (does NOT touch the gitignored generated file).
    const liveRows = buildIndex(parsed.manual_overrides);

    // Strict gate: zero errors == every override valid AND maps to exactly one live row.
    // The committed catalog must be loaded — cluster_id curation entries validate against it.
    const errors = validateOverrides(overridesYaml, liveRows, loadClusterCatalogIfPresent());
    expect(errors).toEqual([]);
  });

  it('every committed override fingerprint maps to exactly one live recommendation', () => {
    const overridesYaml = fs.readFileSync(OVERRIDES_PATH, 'utf-8');
    const parsed = parseExistingIndex(overridesYaml);
    const overrideKeys = Object.keys(parsed.manual_overrides);

    const liveRows = buildIndex(parsed.manual_overrides);
    const countByFp = new Map<string, number>();
    for (const row of liveRows) {
      countByFp.set(row.fingerprint, (countByFp.get(row.fingerprint) ?? 0) + 1);
    }

    const orphans = overrideKeys.filter((fp) => (countByFp.get(fp) ?? 0) === 0);
    const ambiguous = overrideKeys.filter((fp) => (countByFp.get(fp) ?? 0) > 1);
    expect({ orphans, ambiguous }).toEqual({ orphans: [], ambiguous: [] });
  });
});
