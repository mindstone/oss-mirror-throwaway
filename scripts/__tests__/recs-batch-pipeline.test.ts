import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import {
  OVERRIDES_PATH,
  parseExistingIndex,
  validateOverridesDetailed,
  type RecommendationRow,
} from '../postmortem-recommendations-tracker';
import {
  appendToOverridesText,
  buildOverrideEntriesFromVerdicts,
  chunkIntoBatches,
  emitBatches,
  inferReasonKind,
  parseVerdictFileText,
  renderOverrideAppendBlock,
  selectTypeRoutingRows,
  validateVerdicts,
  type BatchInputFile,
  type BatchVerdict,
  type VerdictFile,
} from '../recs-batch-pipeline';

function buildRow(overrides: Partial<RecommendationRow> = {}): RecommendationRow {
  return {
    fingerprint: 'aaaa111122223333',
    postmortem: '260101_test_postmortem.md',
    bug_id: '260101_test_bug',
    action_type: 'review_focus',
    description: 'review the thing',
    priority: 'medium',
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

function buildBatchInput(rows: Array<Partial<RecommendationRow>>, batch_id = 'type-routing-001'): BatchInputFile {
  return {
    batch_id,
    kind: 'type-routing',
    rows: rows.map((partial) => {
      const row = buildRow(partial);
      return {
        fingerprint: row.fingerprint,
        bug_id: row.bug_id,
        action_type: row.action_type,
        priority: row.priority,
        date: row.first_recorded,
        description: row.description,
        source_postmortem: row.postmortem,
      };
    }),
  };
}

function validationArgs(
  batchInput: BatchInputFile,
  verdictFile: VerdictFile,
  {
    liveFingerprints,
    existingOverrideFingerprints = new Set<string>(),
  }: { liveFingerprints?: Set<string>; existingOverrideFingerprints?: Set<string> } = {},
) {
  return {
    batchInput,
    verdictFile,
    liveFingerprints: liveFingerprints ?? new Set(batchInput.rows.map((row) => row.fingerprint)),
    existingOverrideFingerprints,
  };
}

const SYNTHETIC_OVERRIDES_YAML = [
  '# synthetic overrides fixture',
  'manual_overrides:',
  '  # 260101_existing_bug · test_coverage · existing entry',
  '  "ffff000011112222":',
  '    status: implemented',
  '    last_revisited: "260601"',
  '',
].join('\n');

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recs-batch-pipeline-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('selectTypeRoutingRows', () => {
  it('keeps only open, non-quarantined, process-type rows', () => {
    const rows = [
      buildRow({ fingerprint: 'a000000000000001', action_type: 'review_focus' }),
      buildRow({ fingerprint: 'a000000000000002', action_type: 'agent_instructions' }),
      buildRow({ fingerprint: 'a000000000000003', action_type: 'workflow_improvement' }),
      buildRow({ fingerprint: 'a000000000000004', action_type: 'test_coverage' }),
      buildRow({ fingerprint: 'a000000000000005', action_type: 'review_focus', status: 'implemented' }),
      buildRow({ fingerprint: 'a000000000000006', action_type: 'review_focus', is_quarantined: true }),
    ];
    const selected = selectTypeRoutingRows(rows);
    expect(selected.map((row) => row.fingerprint)).toEqual([
      'a000000000000001',
      'a000000000000002',
      'a000000000000003',
    ]);
  });

  it('orders deterministically: first_recorded desc, bug_id asc, fingerprint asc', () => {
    const rows = [
      buildRow({ fingerprint: 'b000000000000002', first_recorded: '260101', bug_id: 'bug_b' }),
      buildRow({ fingerprint: 'b000000000000001', first_recorded: '260105', bug_id: 'bug_z' }),
      buildRow({ fingerprint: 'b000000000000004', first_recorded: '260101', bug_id: 'bug_a' }),
      buildRow({ fingerprint: 'b000000000000003', first_recorded: '260101', bug_id: 'bug_a' }),
    ];
    expect(selectTypeRoutingRows(rows).map((row) => row.fingerprint)).toEqual([
      'b000000000000001',
      'b000000000000003', // bug_a ties broken by fingerprint asc
      'b000000000000004',
      'b000000000000002',
    ]);
  });
});

describe('chunkIntoBatches', () => {
  it('chunks with zero-padded sequential batch ids and maps the row shape', () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      buildRow({ fingerprint: `c00000000000000${i}`, bug_id: `260101_bug_${i}` }),
    );
    const batches = chunkIntoBatches(rows, 'type-routing', 2);
    expect(batches.map((b) => [b.batch_id, b.rows.length])).toEqual([
      ['type-routing-001', 2],
      ['type-routing-002', 2],
      ['type-routing-003', 1],
    ]);
    expect(batches[0]!.rows[0]).toEqual({
      fingerprint: 'c000000000000000',
      bug_id: '260101_bug_0',
      action_type: 'review_focus',
      priority: 'medium',
      date: '260101',
      description: 'review the thing',
      source_postmortem: '260101_test_postmortem.md',
    });
  });

  it('rejects non-positive batch sizes', () => {
    expect(() => chunkIntoBatches([], 'type-routing', 0)).toThrow(/positive integer/);
  });
});

describe('emitBatches', () => {
  it('writes per-batch input files plus a manifest into the out dir', () => {
    const dir = makeTempDir();
    const rows = Array.from({ length: 3 }, (_, i) => buildRow({ fingerprint: `d00000000000000${i}` }));
    const manifest = emitBatches({ kind: 'type-routing', batchSize: 2, outDir: dir, rows });

    expect(manifest.selected_row_count).toBe(3);
    expect(manifest.batches).toHaveLength(2);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'type-routing-001.input.json'), 'utf-8')) as BatchInputFile;
    expect(onDisk.batch_id).toBe('type-routing-001');
    expect(onDisk.rows).toHaveLength(2);
    const manifestOnDisk = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
    expect(manifestOnDisk.batches).toEqual(manifest.batches);
  });
});

describe('parseVerdictFileText', () => {
  it('parses plain JSON and fenced JSON (Composer fence hazard)', () => {
    const json = '{"batch_id":"type-routing-001","verdicts":[]}';
    expect(parseVerdictFileText(json).batch_id).toBe('type-routing-001');
    expect(parseVerdictFileText('```json\n' + json + '\n```').batch_id).toBe('type-routing-001');
  });

  it('fails loud on non-JSON, missing batch_id, missing verdicts array', () => {
    expect(() => parseVerdictFileText('Sure! Here are the verdicts...')).toThrow(/not valid JSON/);
    expect(() => parseVerdictFileText('{"verdicts":[]}')).toThrow(/batch_id/);
    expect(() => parseVerdictFileText('{"batch_id":"x"}')).toThrow(/verdicts array/);
  });
});

describe('validateVerdicts', () => {
  const fpA = 'e000000000000001';
  const fpB = 'e000000000000002';
  const input = buildBatchInput([{ fingerprint: fpA }, { fingerprint: fpB }]);
  const keepOpen = (fingerprint: string): BatchVerdict => ({ fingerprint, verdict: 'keep-open' });

  it('passes a complete, well-formed verdict set', () => {
    const verdictFile: VerdictFile = {
      batch_id: input.batch_id,
      verdicts: [
        { fingerprint: fpA, verdict: 'absorb', target_doc: 'docs/project/CODING_PRINCIPLES.md', principle_text: 'A durable principle.' },
        { fingerprint: fpB, verdict: 'wont-do', reason: 'Target file was removed in the 260520 refactor.' },
      ],
    };
    expect(validateVerdicts(validationArgs(input, verdictFile))).toEqual([]);
  });

  it('flags a missing fingerprint (input row without a verdict)', () => {
    const verdictFile: VerdictFile = { batch_id: input.batch_id, verdicts: [keepOpen(fpA)] };
    const issues = validateVerdicts(validationArgs(input, verdictFile));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ reason: 'missing-fingerprint', fingerprint: fpB });
  });

  it('flags an extra fingerprint not in the batch input', () => {
    const verdictFile: VerdictFile = {
      batch_id: input.batch_id,
      verdicts: [keepOpen(fpA), keepOpen(fpB), keepOpen('e000000000000099')],
    };
    const issues = validateVerdicts(validationArgs(input, verdictFile));
    expect(issues.map((i) => i.reason)).toContain('extra-fingerprint');
    // The extra fingerprint is also not in the live index
    expect(issues.map((i) => i.reason)).toContain('not-in-live-index');
  });

  it('flags a duplicated fingerprint', () => {
    const verdictFile: VerdictFile = {
      batch_id: input.batch_id,
      verdicts: [keepOpen(fpA), keepOpen(fpA), keepOpen(fpB)],
    };
    const issues = validateVerdicts(validationArgs(input, verdictFile));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ reason: 'duplicate-fingerprint', fingerprint: fpA });
  });

  it('flags an attempted overwrite of an existing override entry', () => {
    const verdictFile: VerdictFile = {
      batch_id: input.batch_id,
      verdicts: [
        { fingerprint: fpA, verdict: 'wont-do', reason: 'obsolete' },
        keepOpen(fpB),
      ],
    };
    const issues = validateVerdicts(
      validationArgs(input, verdictFile, { existingOverrideFingerprints: new Set([fpA]) }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ reason: 'would-overwrite-existing-override', fingerprint: fpA });
  });

  it('does NOT treat keep-open on an already-overridden row as an overwrite (writes nothing)', () => {
    const verdictFile: VerdictFile = { batch_id: input.batch_id, verdicts: [keepOpen(fpA), keepOpen(fpB)] };
    const issues = validateVerdicts(
      validationArgs(input, verdictFile, { existingOverrideFingerprints: new Set([fpA]) }),
    );
    expect(issues).toEqual([]);
  });

  it('flags absorb without target_doc and without principle_text', () => {
    const verdictFile: VerdictFile = {
      batch_id: input.batch_id,
      verdicts: [{ fingerprint: fpA, verdict: 'absorb' }, keepOpen(fpB)],
    };
    const issues = validateVerdicts(validationArgs(input, verdictFile));
    expect(issues.map((i) => i.reason).sort()).toEqual([
      'absorb-missing-principle-text',
      'absorb-missing-target-doc',
    ]);
  });

  it('flags wont-do without a reason', () => {
    const verdictFile: VerdictFile = {
      batch_id: input.batch_id,
      verdicts: [{ fingerprint: fpA, verdict: 'wont-do' }, keepOpen(fpB)],
    };
    const issues = validateVerdicts(validationArgs(input, verdictFile));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ reason: 'wont-do-missing-reason', fingerprint: fpA });
  });

  it('flags invalid verdict kinds, batch_id mismatch, and fingerprints missing from the live index', () => {
    const verdictFile = {
      batch_id: 'type-routing-999',
      verdicts: [
        { fingerprint: fpA, verdict: 'implement' },
        keepOpen(fpB),
      ],
    } as unknown as VerdictFile;
    const issues = validateVerdicts(
      validationArgs(input, verdictFile, { liveFingerprints: new Set([fpA]) }),
    );
    const reasons = issues.map((i) => i.reason);
    expect(reasons).toContain('batch-id-mismatch');
    expect(reasons).toContain('invalid-verdict-kind');
    expect(reasons).toContain('not-in-live-index'); // fpB absent from live index
  });
});

describe('validateVerdicts — implemented/rejected vocabulary (weekly close lane)', () => {
  const fpA = 'e000000000000001';
  const fpB = 'e000000000000002';
  const input = buildBatchInput([{ fingerprint: fpA }, { fingerprint: fpB }]);

  it('passes implemented (with and without evidence) and a fully-typed rejected', () => {
    const verdictFile: VerdictFile = {
      batch_id: input.batch_id,
      verdicts: [
        { fingerprint: fpA, verdict: 'implemented', evidence: 'Shipped in abc1234; test pins the contract.' },
        {
          fingerprint: fpB,
          verdict: 'rejected',
          rejection_reason: 'Sole placement target was deleted in the per-session worktree migration.',
          reason_kind: 'target-gone',
        },
      ],
    };
    expect(validateVerdicts(validationArgs(input, verdictFile))).toEqual([]);

    const noEvidence: VerdictFile = {
      batch_id: input.batch_id,
      verdicts: [
        { fingerprint: fpA, verdict: 'implemented' },
        { fingerprint: fpB, verdict: 'keep-open' },
      ],
    };
    expect(validateVerdicts(validationArgs(input, noEvidence))).toEqual([]);
  });

  it('flags rejected without rejection_reason and without reason_kind', () => {
    const verdictFile: VerdictFile = {
      batch_id: input.batch_id,
      verdicts: [
        { fingerprint: fpA, verdict: 'rejected' },
        { fingerprint: fpB, verdict: 'keep-open' },
      ],
    };
    const issues = validateVerdicts(validationArgs(input, verdictFile));
    expect(issues.map((i) => i.reason).sort()).toEqual([
      'rejected-missing-reason-kind',
      'rejected-missing-rejection-reason',
    ]);
  });

  it('flags an off-vocabulary reason_kind', () => {
    const verdictFile = {
      batch_id: input.batch_id,
      verdicts: [
        { fingerprint: fpA, verdict: 'rejected', rejection_reason: 'gone', reason_kind: 'not-a-kind' },
        { fingerprint: fpB, verdict: 'keep-open' },
      ],
    } as unknown as VerdictFile;
    const issues = validateVerdicts(validationArgs(input, verdictFile));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ reason: 'invalid-reason-kind', fingerprint: fpA });
  });

  it('overwrite guard fires for implemented and rejected (any entry-writing verdict)', () => {
    const verdictFile: VerdictFile = {
      batch_id: input.batch_id,
      verdicts: [
        { fingerprint: fpA, verdict: 'implemented', evidence: 'abc' },
        { fingerprint: fpB, verdict: 'rejected', rejection_reason: 'gone', reason_kind: 'target-gone' },
      ],
    };
    const issues = validateVerdicts(
      validationArgs(input, verdictFile, { existingOverrideFingerprints: new Set([fpA, fpB]) }),
    );
    expect(issues.map((i) => i.reason)).toEqual([
      'would-overwrite-existing-override',
      'would-overwrite-existing-override',
    ]);
  });

  it('verdicts-only mode (no batch input) skips membership checks but keeps per-verdict checks', () => {
    const verdictFile: VerdictFile = {
      batch_id: 'weekly-close-260612',
      verdicts: [
        { fingerprint: fpA, verdict: 'implemented', evidence: 'verified artifact' },
        { fingerprint: 'e000000000000099', verdict: 'implemented' }, // not in live index
        { fingerprint: fpA, verdict: 'keep-open' }, // duplicate
      ],
    };
    const issues = validateVerdicts({
      verdictFile,
      liveFingerprints: new Set([fpA]),
      existingOverrideFingerprints: new Set<string>(),
    });
    const reasons = issues.map((i) => i.reason).sort();
    // No batch-id-mismatch / extra-fingerprint / missing-fingerprint in verdicts-only mode.
    expect(reasons).toEqual(['duplicate-fingerprint', 'not-in-live-index']);
  });
});

describe('inferReasonKind', () => {
  it('maps reason text onto typed reason kinds, undefined when not inferable', () => {
    expect(inferReasonKind('The target file no longer exists after the refactor')).toBe('target-gone');
    expect(inferReasonKind('Superseded by the 260601 chokepoint guard')).toBe('superseded');
    expect(inferReasonKind('Already covered by the existing parity gate')).toBe('covered-elsewhere');
    expect(inferReasonKind('Over-engineering for a one-off script')).toBe('over-engineering');
    expect(inferReasonKind('Too vague to action')).toBeUndefined();
  });
});

describe('apply building blocks', () => {
  const liveRows = [
    buildRow({ fingerprint: 'f000000000000001', bug_id: '260101_bug_one', description: 'absorb me: a "quoted" rec' }),
    buildRow({ fingerprint: 'f000000000000002', bug_id: '260101_bug_two', action_type: 'workflow_improvement' }),
    buildRow({ fingerprint: 'f000000000000003', bug_id: '260101_bug_three' }),
    buildRow({ fingerprint: 'ffff000011112222', bug_id: '260101_existing_bug', action_type: 'test_coverage' }),
  ];
  const rowsByFingerprint = new Map(liveRows.map((row) => [row.fingerprint, row]));
  const verdicts: BatchVerdict[] = [
    {
      fingerprint: 'f000000000000001',
      verdict: 'absorb',
      target_doc: 'docs/project/CODING_PRINCIPLES.md',
      principle_text: 'Multi-line\nprinciple text\ngets collapsed.',
    },
    { fingerprint: 'f000000000000002', verdict: 'wont-do', reason: 'Superseded by the later chokepoint guard.' },
    { fingerprint: 'f000000000000003', verdict: 'keep-open' },
  ];

  it('keep-open produces no entry; absorb/wont-do entries carry the required fields', () => {
    const entries = buildOverrideEntriesFromVerdicts({
      verdicts,
      rowsByFingerprint,
      date: '260612',
      batchId: 'type-routing-001',
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]!.entry).toEqual({
      status: 'absorbed',
      last_revisited: '260612',
      absorbed_into: 'docs/project/CODING_PRINCIPLES.md',
    });
    expect(entries[0]!.commentLines[1]).toContain('Multi-line principle text gets collapsed.');
    expect(entries[1]!.entry).toEqual({
      status: 'wont-do',
      last_revisited: '260612',
      rejection_reason: 'Superseded by the later chokepoint guard.',
      reason_kind: 'superseded',
    });
  });

  it('rejects a non-YYMMDD date', () => {
    expect(() =>
      buildOverrideEntriesFromVerdicts({ verdicts, rowsByFingerprint, date: '2026-06-12', batchId: 'x' }),
    ).toThrow(/YYMMDD/);
  });

  it('implemented entries carry status+date with evidence in the comment; rejected entries carry the explicit reason_kind', () => {
    const weeklyVerdicts: BatchVerdict[] = [
      {
        fingerprint: 'f000000000000001',
        verdict: 'implemented',
        evidence: 'SHA abc1234 exists on dev and\ncontains the claimed work.',
      },
      { fingerprint: 'f000000000000002', verdict: 'implemented' },
      {
        fingerprint: 'f000000000000003',
        verdict: 'rejected',
        rejection_reason: 'Sole target script was deleted; precondition handled by init-worktree post-init hook.',
        // Deliberately NOT inferable from the text alone — must be carried explicitly, never inferred.
        reason_kind: 'target-gone',
      },
    ];
    const entries = buildOverrideEntriesFromVerdicts({
      verdicts: weeklyVerdicts,
      rowsByFingerprint,
      date: '260612',
      batchId: 'weekly-close-260612',
    });
    expect(entries).toHaveLength(3);
    expect(entries[0]!.entry).toEqual({ status: 'implemented', last_revisited: '260612' });
    expect(entries[0]!.commentLines[1]).toBe(
      '# implemented (batch weekly-close-260612): SHA abc1234 exists on dev and contains the claimed work.',
    );
    expect(entries[1]!.entry).toEqual({ status: 'implemented', last_revisited: '260612' });
    expect(entries[1]!.commentLines[1]).toBe('# implemented (batch weekly-close-260612)');
    expect(entries[2]!.entry).toEqual({
      status: 'rejected',
      last_revisited: '260612',
      rejection_reason: 'Sole target script was deleted; precondition handled by init-worktree post-init hook.',
      reason_kind: 'target-gone',
    });
  });

  it('implemented/rejected entries round-trip: append -> reparse -> validateOverridesDetailed clean', () => {
    const dir = makeTempDir();
    const tempOverridesPath = path.join(dir, '_recommendations_overrides.yaml');
    fs.writeFileSync(tempOverridesPath, SYNTHETIC_OVERRIDES_YAML, 'utf-8');

    const entries = buildOverrideEntriesFromVerdicts({
      verdicts: [
        { fingerprint: 'f000000000000001', verdict: 'implemented', evidence: 'verified in tree' },
        {
          fingerprint: 'f000000000000002',
          verdict: 'rejected',
          rejection_reason: 'Target module removed.',
          reason_kind: 'target-gone',
        },
      ],
      rowsByFingerprint,
      date: '260612',
      batchId: 'weekly-close-260612',
    });
    const newText = appendToOverridesText(
      fs.readFileSync(tempOverridesPath, 'utf-8'),
      renderOverrideAppendBlock(entries),
    );
    fs.writeFileSync(tempOverridesPath, newText, 'utf-8');

    expect(() => parseYaml(newText, { uniqueKeys: true })).not.toThrow();
    const reparsed = parseExistingIndex(newText);
    expect(reparsed.manual_overrides['f000000000000001']).toEqual({
      status: 'implemented',
      last_revisited: '260612',
    });
    expect(reparsed.manual_overrides['f000000000000002']).toEqual({
      status: 'rejected',
      last_revisited: '260612',
      rejection_reason: 'Target module removed.',
      reason_kind: 'target-gone',
    });

    // Full strict validation against the synthetic live corpus: zero errors
    // (pins that rejected+reason_kind satisfies the parity gate's typed-metadata rules).
    const result = validateOverridesDetailed(newText, liveRows);
    expect(result.errors).toEqual([]);
  });

  it('round-trips through a temp copy: append -> reparse -> validateOverridesDetailed clean', () => {
    const dir = makeTempDir();
    const tempOverridesPath = path.join(dir, '_recommendations_overrides.yaml');
    fs.writeFileSync(tempOverridesPath, SYNTHETIC_OVERRIDES_YAML, 'utf-8');

    const entries = buildOverrideEntriesFromVerdicts({
      verdicts,
      rowsByFingerprint,
      date: '260612',
      batchId: 'type-routing-001',
    });
    const newText = appendToOverridesText(
      fs.readFileSync(tempOverridesPath, 'utf-8'),
      renderOverrideAppendBlock(entries),
    );
    fs.writeFileSync(tempOverridesPath, newText, 'utf-8');

    // Real YAML parse with uniqueKeys (what the parity gate does first).
    expect(() => parseYaml(newText, { uniqueKeys: true })).not.toThrow();

    // Tolerant loader round-trip (what the tracker does on load).
    const reparsed = parseExistingIndex(newText);
    expect(Object.keys(reparsed.manual_overrides).sort()).toEqual([
      'f000000000000001',
      'f000000000000002',
      'ffff000011112222',
    ]);
    expect(reparsed.manual_overrides['f000000000000001']).toEqual({
      status: 'absorbed',
      last_revisited: '260612',
      absorbed_into: 'docs/project/CODING_PRINCIPLES.md',
    });
    expect(reparsed.manual_overrides['f000000000000002']).toEqual({
      status: 'wont-do',
      last_revisited: '260612',
      rejection_reason: 'Superseded by the later chokepoint guard.',
      reason_kind: 'superseded',
    });

    // Full strict validation against the synthetic live corpus: zero errors.
    const result = validateOverridesDetailed(newText, liveRows);
    expect(result.errors).toEqual([]);
  });

  it('appends cleanly to a temp COPY of the real overrides file (never the real file)', () => {
    const dir = makeTempDir();
    const tempCopy = path.join(dir, 'real-copy.yaml');
    fs.copyFileSync(OVERRIDES_PATH, tempCopy);
    const before = fs.readFileSync(tempCopy, 'utf-8');
    const beforeCount = Object.keys(parseExistingIndex(before).manual_overrides).length;

    const entries = buildOverrideEntriesFromVerdicts({
      verdicts: [verdicts[0]!, verdicts[1]!],
      rowsByFingerprint,
      date: '260612',
      batchId: 'type-routing-001',
    });
    const newText = appendToOverridesText(before, renderOverrideAppendBlock(entries));
    fs.writeFileSync(tempCopy, newText, 'utf-8');

    expect(() => parseYaml(newText, { uniqueKeys: true })).not.toThrow();
    const after = parseExistingIndex(newText).manual_overrides;
    expect(Object.keys(after)).toHaveLength(beforeCount + 2);
    expect(after['f000000000000001']!.status).toBe('absorbed');
    // The real overrides file itself is untouched.
    expect(fs.readFileSync(OVERRIDES_PATH, 'utf-8')).toBe(before);
  });

  it('appendToOverridesText refuses files without manual_overrides or ending outside the mapping', () => {
    expect(() => appendToOverridesText('something_else:\n  a: 1\n', 'block')).toThrow(/manual_overrides/);
    expect(() =>
      appendToOverridesText('manual_overrides:\n  "aaaa000000000000":\n    status: open\nother_section:\n', 'block'),
    ).toThrow(/refusing to append/);
  });
});
