import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  GENERATED_PATH,
  generateIndexYaml,
  type RecommendationClusterCatalog,
  type RecommendationRow,
} from '../postmortem-recommendations-tracker';
import {
  DEFAULT_TTL_HOURS,
  parseClaimsFile,
  runClaimsCli,
  serializeClaimsFile,
  validateClaimsDetailed,
  type ClaimResolutionContext,
  type RecommendationClaims,
} from '../recs-claim';

const NOW = new Date('2026-06-12T12:00:00.000Z');

function buildRow(overrides: Partial<RecommendationRow> = {}): RecommendationRow {
  return {
    fingerprint: 'fp-a',
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

const CLUSTER_CATALOG: RecommendationClusterCatalog = {
  clusters: [
    {
      cluster_id: 'shared-cluster',
      title: 'Shared cluster',
      canonical_statement: 'Shared recommendation cluster.',
    },
  ],
};

function context(rows: RecommendationRow[] = [buildRow()]): ClaimResolutionContext {
  return { liveRows: rows, clusterCatalog: CLUSTER_CATALOG };
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recs-claim-'));
  tempDirs.push(dir);
  return dir;
}

function writeIndex(dir: string, rows: RecommendationRow[]): string {
  const indexPath = path.join(dir, 'index.generated.yaml');
  fs.writeFileSync(indexPath, generateIndexYaml(rows, {}, CLUSTER_CATALOG), 'utf-8');
  return indexPath;
}

function runCli(argv: string[]): { exitCode: number; stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  const exitCode = runClaimsCli(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { exitCode, stdout, stderr };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('claims serialization', () => {
  it('serializes in stable sorted-key order with fixed field order and a trailing newline', () => {
    const claims: RecommendationClaims = {
      'z-fp': { run_slug: 'run-z', claimed_at: '2026-06-12T13:00:00.000Z', ttl_hours: 12 },
      'a-fp': { run_slug: 'run-a', claimed_at: '2026-06-12T12:00:00.000Z', ttl_hours: DEFAULT_TTL_HOURS },
    };
    const first = serializeClaimsFile(claims);
    const second = serializeClaimsFile(parseClaimsFile(first).claims);
    expect(second).toBe(first);
    expect(first.indexOf('"a-fp":')).toBeLessThan(first.indexOf('"z-fp":'));
    expect(first).toContain('    run_slug: "run-a"\n    claimed_at: "2026-06-12T12:00:00.000Z"\n    ttl_hours: 48');
    expect(first.endsWith('\n')).toBe(true);
  });
});

describe('recs-claim CLI', () => {
  it('claim/release/list round-trips through a temp claims file', () => {
    const dir = makeTempDir();
    const claimsPath = path.join(dir, 'claims.yaml');
    const indexPath = writeIndex(dir, [buildRow({ fingerprint: 'fp-a' })]);

    const claim = runCli([
      'claim',
      'fp-a',
      '--run',
      'run-a',
      '--claims',
      claimsPath,
      '--index',
      indexPath,
      '--now',
      NOW.toISOString(),
    ]);
    expect(claim).toMatchObject({ exitCode: 0 });

    const list = runCli(['list', '--json', '--claims', claimsPath, '--index', indexPath, '--now', NOW.toISOString()]);
    expect(list.exitCode).toBe(0);
    expect(JSON.parse(list.stdout)).toMatchObject({
      claims: [expect.objectContaining({ id: 'fp-a', run_slug: 'run-a', state: 'active' })],
    });

    const release = runCli([
      'release',
      'fp-a',
      '--run',
      'run-a',
      '--claims',
      claimsPath,
      '--index',
      indexPath,
      '--now',
      NOW.toISOString(),
    ]);
    expect(release.exitCode).toBe(0);
    expect(parseClaimsFile(fs.readFileSync(claimsPath, 'utf-8')).claims).toEqual({});
  });

  it('refuses an all-or-nothing batch when any id overlaps an active foreign claim and leaves the file untouched', () => {
    const dir = makeTempDir();
    const claimsPath = path.join(dir, 'claims.yaml');
    const indexPath = writeIndex(dir, [buildRow({ fingerprint: 'fp-a' }), buildRow({ fingerprint: 'fp-b' })]);
    const before = serializeClaimsFile({
      'fp-a': { run_slug: 'run-a', claimed_at: '2026-06-12T10:00:00.000Z', ttl_hours: 48 },
    });
    fs.writeFileSync(claimsPath, before, 'utf-8');

    const result = runCli([
      'claim',
      'fp-a',
      'fp-b',
      '--run',
      'run-b',
      '--claims',
      claimsPath,
      '--index',
      indexPath,
      '--now',
      NOW.toISOString(),
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('run-a');
    expect(result.stderr).toContain('age 2.0h');
    expect(fs.readFileSync(claimsPath, 'utf-8')).toBe(before);
  });

  it('refuses to write over a malformed existing claims file', () => {
    const dir = makeTempDir();
    const claimsPath = path.join(dir, 'claims.yaml');
    const indexPath = writeIndex(dir, [buildRow({ fingerprint: 'fp-a' })]);
    const malformed = 'claims:\n  "fp-a":\n    run_slug: "bad run"\n    claimed_at: "not-a-date"\n    ttl_hours: 999\n';
    fs.writeFileSync(claimsPath, malformed, 'utf-8');

    const result = runCli([
      'claim',
      'fp-a',
      '--run',
      'run-a',
      '--claims',
      claimsPath,
      '--index',
      indexPath,
      '--now',
      NOW.toISOString(),
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('invalid-run-slug');
    expect(fs.readFileSync(claimsPath, 'utf-8')).toBe(malformed);
  });

  it('allows expired-claim takeover and same-slug refresh', () => {
    const dir = makeTempDir();
    const claimsPath = path.join(dir, 'claims.yaml');
    const indexPath = writeIndex(dir, [buildRow({ fingerprint: 'fp-a' })]);
    fs.writeFileSync(
      claimsPath,
      serializeClaimsFile({
        'fp-a': { run_slug: 'old-run', claimed_at: '2026-06-10T00:00:00.000Z', ttl_hours: 1 },
      }),
      'utf-8',
    );

    expect(
      runCli(['claim', 'fp-a', '--run', 'new-run', '--claims', claimsPath, '--index', indexPath, '--now', NOW.toISOString()])
        .exitCode,
    ).toBe(0);
    expect(parseClaimsFile(fs.readFileSync(claimsPath, 'utf-8')).claims['fp-a']).toMatchObject({
      run_slug: 'new-run',
      claimed_at: NOW.toISOString(),
    });

    const later = new Date('2026-06-12T13:00:00.000Z').toISOString();
    expect(runCli(['claim', 'fp-a', '--run', 'new-run', '--claims', claimsPath, '--index', indexPath, '--now', later]).exitCode).toBe(0);
    expect(parseClaimsFile(fs.readFileSync(claimsPath, 'utf-8')).claims['fp-a']?.claimed_at).toBe(later);
  });

  it('enforces cluster/member exclusivity in both claim directions', () => {
    const rows = [
      buildRow({ fingerprint: 'member-a', cluster_id: 'shared-cluster' }),
      buildRow({ fingerprint: 'member-b', cluster_id: 'shared-cluster' }),
    ];
    const dir = makeTempDir();
    const indexPath = writeIndex(dir, rows);

    const clusterClaimsPath = path.join(dir, 'cluster-claims.yaml');
    expect(
      runCli([
        'claim',
        'shared-cluster',
        '--run',
        'cluster-run',
        '--claims',
        clusterClaimsPath,
        '--index',
        indexPath,
        '--now',
        NOW.toISOString(),
      ]).exitCode,
    ).toBe(0);
    const memberBlocked = runCli([
      'claim',
      'member-a',
      '--run',
      'member-run',
      '--claims',
      clusterClaimsPath,
      '--index',
      indexPath,
      '--now',
      NOW.toISOString(),
    ]);
    expect(memberBlocked.exitCode).toBe(1);
    expect(memberBlocked.stderr).toContain('cluster-run');

    const memberClaimsPath = path.join(dir, 'member-claims.yaml');
    expect(
      runCli([
        'claim',
        'member-a',
        '--run',
        'member-run',
        '--claims',
        memberClaimsPath,
        '--index',
        indexPath,
        '--now',
        NOW.toISOString(),
      ]).exitCode,
    ).toBe(0);
    const clusterBlocked = runCli([
      'claim',
      'shared-cluster',
      '--run',
      'cluster-run',
      '--claims',
      memberClaimsPath,
      '--index',
      indexPath,
      '--now',
      NOW.toISOString(),
    ]);
    expect(clusterBlocked.exitCode).toBe(1);
    expect(clusterBlocked.stderr).toContain('member-run');

    // Self-conflict gets a distinct message: claiming a member of a cluster the
    // SAME run already holds is a no-op want, not a foreign collision.
    const selfConflict = runCli([
      'claim',
      'member-a',
      '--run',
      'cluster-run',
      '--claims',
      clusterClaimsPath,
      '--index',
      indexPath,
      '--now',
      NOW.toISOString(),
    ]);
    expect(selfConflict.exitCode).toBe(1);
    expect(selfConflict.stderr).toContain('already covered by your own active claim "shared-cluster"');
  });

  it('list does not rewrite the committed generated index (read-only context)', () => {
    const dir = makeTempDir();
    const claimsPath = path.join(dir, 'claims.yaml');
    fs.writeFileSync(
      claimsPath,
      serializeClaimsFile({
        'fp-a': { run_slug: 'run-a', claimed_at: NOW.toISOString(), ttl_hours: 48 },
      }),
      'utf-8',
    );

    // No --index: exercises the default tracker-backed context. `list` must use
    // the in-memory check path and never (re)write GENERATED_PATH as a side effect.
    const before = fs.existsSync(GENERATED_PATH)
      ? {
          exists: true as const,
          mtimeMs: fs.statSync(GENERATED_PATH).mtimeMs,
          content: fs.readFileSync(GENERATED_PATH, 'utf-8'),
        }
      : { exists: false as const };

    const list = runCli(['list', '--claims', claimsPath, '--now', NOW.toISOString()]);
    expect(list.exitCode).toBe(0);

    if (before.exists) {
      expect(fs.statSync(GENERATED_PATH).mtimeMs).toBe(before.mtimeMs);
      expect(fs.readFileSync(GENERATED_PATH, 'utf-8')).toBe(before.content);
    } else {
      expect(fs.existsSync(GENERATED_PATH)).toBe(false);
    }
  });
});

describe('validateClaimsDetailed', () => {
  it('treats the exact TTL boundary as expired', () => {
    const yaml = serializeClaimsFile({
      'fp-a': { run_slug: 'run-a', claimed_at: '2026-06-12T11:00:00.000Z', ttl_hours: 1 },
    });
    const result = validateClaimsDetailed(yaml, context().liveRows, context().clusterCatalog, NOW);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([expect.objectContaining({ reason: 'expired-claim', id: 'fp-a' })]);
  });

  it('fails on future skew beyond the allowance', () => {
    const yaml = serializeClaimsFile({
      'fp-a': { run_slug: 'run-a', claimed_at: '2026-06-12T13:01:00.000Z', ttl_hours: 48 },
    });
    const result = validateClaimsDetailed(yaml, context().liveRows, context().clusterCatalog, NOW);
    expect(result.errors).toEqual([expect.objectContaining({ reason: 'future-claimed-at', id: 'fp-a' })]);
  });

  it('fails closed on malformed YAML and bad schema fields', () => {
    const malformed = validateClaimsDetailed('claims:\n  "fp-a":\n    run_slug: [nope]\n', context().liveRows, context().clusterCatalog, NOW);
    expect(malformed.errors.map((error) => error.reason)).toContain('invalid-run-slug');
    expect(malformed.errors.map((error) => error.reason)).toContain('invalid-claimed-at');
    expect(malformed.errors.map((error) => error.reason)).toContain('invalid-ttl-hours');

    const badValues = validateClaimsDetailed(
      serializeClaimsFile({
        'fp-a': { run_slug: 'Not A Slug', claimed_at: 'not-a-date', ttl_hours: 999 },
      }),
      context().liveRows,
      context().clusterCatalog,
      NOW,
    );
    expect(badValues.errors.map((error) => error.reason).sort()).toEqual([
      'invalid-claimed-at',
      'invalid-run-slug',
      'invalid-ttl-hours',
    ]);

    const duplicate = validateClaimsDetailed(
      'claims:\n  "fp-a":\n    run_slug: "a"\n    claimed_at: "2026-06-12T12:00:00.000Z"\n    ttl_hours: 48\n  "fp-a":\n    run_slug: "b"\n    claimed_at: "2026-06-12T12:00:00.000Z"\n    ttl_hours: 48\n',
      context().liveRows,
      context().clusterCatalog,
      NOW,
    );
    expect(duplicate.errors.some((error) => error.reason === 'duplicate-key' || error.reason === 'yaml-parse-error')).toBe(true);
  });

  it('errors on active cluster/member overlap in a committed file', () => {
    const rows = [
      buildRow({ fingerprint: 'member-a', cluster_id: 'shared-cluster' }),
      buildRow({ fingerprint: 'member-b', cluster_id: 'shared-cluster' }),
    ];
    const yaml = serializeClaimsFile({
      'shared-cluster': { run_slug: 'cluster-run', claimed_at: NOW.toISOString(), ttl_hours: 48 },
      'member-a': { run_slug: 'member-run', claimed_at: NOW.toISOString(), ttl_hours: 48 },
    });
    const result = validateClaimsDetailed(yaml, rows, CLUSTER_CATALOG, NOW);
    expect(result.errors).toEqual([expect.objectContaining({ reason: 'overlapping-active-claim' })]);
  });

  it('warns, rather than errors, for a claim on a closed row', () => {
    const yaml = serializeClaimsFile({
      'fp-a': { run_slug: 'run-a', claimed_at: NOW.toISOString(), ttl_hours: 48 },
    });
    const result = validateClaimsDetailed(
      yaml,
      [buildRow({ fingerprint: 'fp-a', status: 'implemented' })],
      CLUSTER_CATALOG,
      NOW,
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ reason: 'closed-row-claim', id: 'fp-a' }),
    ]);
  });

  it('warns, rather than errors, for an orphan claim key', () => {
    const yaml = serializeClaimsFile({
      missing: { run_slug: 'run-a', claimed_at: NOW.toISOString(), ttl_hours: 48 },
    });
    const result = validateClaimsDetailed(yaml, context().liveRows, context().clusterCatalog, NOW);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([expect.objectContaining({ reason: 'orphan-claim', id: 'missing' })]);
  });

  it('warns on unknown top-level keys (siblings of `claims`)', () => {
    const yaml = `${serializeClaimsFile({})}stray_key: 1\n`;
    const result = validateClaimsDetailed(yaml, context().liveRows, context().clusterCatalog, NOW);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ reason: 'unknown-top-level-key', id: 'stray_key' }),
    ]);
  });
});
