import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { generateIndexYaml, type RecommendationRow } from '../postmortem-recommendations-tracker';
import { serializeClaimsFile, type RecommendationClaims } from '../recs-claim';
import {
  buildShortlistResult,
  generateShortlist,
  loadHotlist,
  loadShortlistClaims,
  parseHotlistFile,
  runShortlist,
  type IndexClusterEntry,
  type ShortlistOptions,
} from '../recs-shortlist';

const NOW = new Date('2026-06-12T12:00:00.000Z');

function buildRow(overrides: Partial<RecommendationRow> = {}): RecommendationRow {
  return {
    fingerprint: 'abc1234567890def0',
    postmortem: '260101_test_postmortem.md',
    bug_id: '260101_test_bug',
    action_type: 'documentation',
    description: 'doc row',
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

function writeFixtureIndex(
  dir: string,
  rows: RecommendationRow[],
  clusters: IndexClusterEntry[] = [
    { cluster_id: 'ipc-race', title: 'IPC race cluster', canonical_statement: 'Unify IPC race handling', surface_hint: null, fingerprints: [], member_count: 0, live_member_count: 0 },
  ],
): string {
  const clusterCatalog = {
    clusters: clusters.map(({ cluster_id, title, canonical_statement, surface_hint }) => ({
      cluster_id,
      title,
      canonical_statement,
      ...(surface_hint ? { surface_hint } : {}),
    })),
  };
  const yaml = generateIndexYaml(rows, {}, clusterCatalog);
  const indexPath = path.join(dir, 'index.generated.yaml');
  fs.writeFileSync(indexPath, yaml, 'utf8');
  return indexPath;
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function mkFixtureDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recs-shortlist-'));
  tempDirs.push(dir);
  return dir;
}

describe('parseHotlistFile', () => {
  it('accepts a bare fingerprint array', () => {
    expect(parseHotlistFile('["fp-a","fp-b"]')).toEqual(['fp-a', 'fp-b']);
  });

  it('accepts a wrapped fingerprints object', () => {
    expect(parseHotlistFile('{"fingerprints":["fp-a"]}')).toEqual(['fp-a']);
  });
});

describe('loadHotlist', () => {
  it('degrades to empty when the hot-list file is missing', () => {
    const dir = mkFixtureDir();
    const missing = path.join(dir, 'missing-hotlist.json');
    const loaded = loadHotlist(missing);
    expect(loaded.fingerprints.size).toBe(0);
  });
});

describe('generateShortlist', () => {
  it('boosts hot-listed singletons ahead of higher-tier rows', () => {
    const rows = [
      buildRow({
        fingerprint: 'tier1-high',
        action_type: 'type_constraint',
        priority: 'high',
        bug_id: '260612_tier1',
        first_recorded: '260612',
        description: 'tier1 row',
      }),
      buildRow({
        fingerprint: 'hot-doc',
        action_type: 'documentation',
        priority: 'low',
        bug_id: '260101_hot',
        first_recorded: '260101',
        description: 'hot row',
      }),
    ];

    const items = generateShortlist(rows, [], new Set(['hot-doc']), 10);
    expect(items[0]?.fingerprint).toBe('hot-doc');
    expect(items[0]?.rationale.placed_by).toBe('hotlist');
    expect(items[1]?.fingerprint).toBe('tier1-high');
  });

  it('boosts a cluster when any live member fingerprint is hot-listed', () => {
    const rows = [
      buildRow({
        fingerprint: 'cluster-member',
        cluster_id: 'ipc-race',
        action_type: 'documentation',
        priority: 'low',
        bug_id: '260101_member',
        description: 'cluster member',
      }),
      buildRow({
        fingerprint: 'singleton-tier1',
        action_type: 'ci_check',
        priority: 'high',
        bug_id: '260612_singleton',
        description: 'singleton tier1',
      }),
    ];
    const clusters = [
      {
        cluster_id: 'ipc-race',
        title: 'IPC race cluster',
        canonical_statement: 'Unify IPC race handling',
        fingerprints: ['cluster-member'],
        member_count: 1,
        live_member_count: 1,
      },
    ];

    const items = generateShortlist(rows, clusters, new Set(['cluster-member']), 10);
    expect(items[0]?.unit_kind).toBe('cluster');
    expect(items[0]?.cluster_id).toBe('ipc-race');
    expect(items[0]?.rationale.placed_by).toBe('hotlist');
    expect(items[1]?.fingerprint).toBe('singleton-tier1');
  });

  it('orders by type tier, then priority, then recency within the baseline queue', () => {
    const rows = [
      buildRow({
        fingerprint: 'tier3-old',
        action_type: 'documentation',
        priority: 'high',
        bug_id: '260101_old',
        first_recorded: '260101',
      }),
      buildRow({
        fingerprint: 'tier2-new',
        action_type: 'test_coverage',
        priority: 'medium',
        bug_id: '260612_new',
        first_recorded: '260612',
      }),
      buildRow({
        fingerprint: 'tier1-medium',
        action_type: 'lint_rule',
        priority: 'medium',
        bug_id: '260611_mid',
        first_recorded: '260611',
      }),
    ];

    const items = generateShortlist(rows, [], new Set(), 10);
    expect(items.map((item) => item.fingerprint)).toEqual(['tier1-medium', 'tier2-new', 'tier3-old']);
    expect(items[0]?.rationale.tier).toBe(1);
    expect(items[1]?.rationale.tier).toBe(2);
    expect(items[2]?.rationale.tier).toBe(3);
  });

  it('orders by priority within the same tier and date', () => {
    const rows = [
      buildRow({
        fingerprint: 'same-tier-low',
        action_type: 'documentation',
        priority: 'low',
        bug_id: '260601_low',
        first_recorded: '260601',
      }),
      buildRow({
        fingerprint: 'same-tier-na',
        action_type: 'documentation',
        priority: 'n/a',
        bug_id: '260601_na',
        first_recorded: '260601',
      }),
      buildRow({
        fingerprint: 'same-tier-high',
        action_type: 'documentation',
        priority: 'high',
        bug_id: '260601_high',
        first_recorded: '260601',
      }),
      buildRow({
        fingerprint: 'same-tier-medium',
        action_type: 'documentation',
        priority: 'medium',
        bug_id: '260601_medium',
        first_recorded: '260601',
      }),
    ];

    const items = generateShortlist(rows, [], new Set(), 10);
    expect(items.map((item) => item.fingerprint)).toEqual([
      'same-tier-high',
      'same-tier-medium',
      'same-tier-low',
      'same-tier-na',
    ]);
  });

  it('represents clusters as one ranked unit with canonical metadata and member count', () => {
    const rows = [
      buildRow({
        fingerprint: 'cluster-a',
        cluster_id: 'shared-cluster',
        action_type: 'documentation',
        priority: 'low',
        bug_id: '260101_cluster_a',
        description: 'member a',
      }),
      buildRow({
        fingerprint: 'cluster-b',
        cluster_id: 'shared-cluster',
        action_type: 'type_constraint',
        priority: 'high',
        bug_id: '260612_cluster_b',
        description: 'member b',
      }),
      buildRow({
        fingerprint: 'singleton',
        action_type: 'documentation',
        priority: 'high',
        bug_id: '260612_singleton',
        description: 'singleton',
      }),
    ];
    const clusters = [
      {
        cluster_id: 'shared-cluster',
        title: 'Shared cluster title',
        canonical_statement: 'Canonical cluster statement',
        fingerprints: ['cluster-a', 'cluster-b'],
        member_count: 2,
        live_member_count: 2,
      },
    ];

    const items = generateShortlist(rows, clusters, new Set(), 10);
    const clusterItem = items.find((item) => item.unit_kind === 'cluster');
    expect(clusterItem).toMatchObject({
      cluster_id: 'shared-cluster',
      title: 'Shared cluster title',
      description: 'Canonical cluster statement',
      member_count: 2,
      action_type: 'type_constraint',
      priority: 'high',
      rationale: {
        tier: 1,
        priority_used: 'high',
        newest_date: '260612',
        member_count: 2,
      },
    });
    expect(clusterItem?.member_fingerprints).toEqual(['cluster-a', 'cluster-b']);
    expect(items[0]?.cluster_id).toBe('shared-cluster');
  });

  it('excludes quarantined and non-open rows from ranking', () => {
    const rows = [
      buildRow({
        fingerprint: 'live-open',
        action_type: 'type_constraint',
        priority: 'high',
        bug_id: '260612_live',
      }),
      buildRow({
        fingerprint: 'quarantined',
        action_type: 'no-recommendations',
        priority: 'n/a',
        bug_id: '260612_quarantine',
        is_quarantined: true,
      }),
      buildRow({
        fingerprint: 'implemented',
        action_type: 'type_constraint',
        priority: 'high',
        bug_id: '260612_done',
        status: 'implemented',
      }),
    ];

    const items = generateShortlist(rows, [], new Set(), 10);
    expect(items).toHaveLength(1);
    expect(items[0]?.fingerprint).toBe('live-open');
  });

  it('truncates to top-N', () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      buildRow({
        fingerprint: `fp-${index}`,
        bug_id: `26010${index}_bug`,
        first_recorded: `26010${index}`,
        priority: index % 2 === 0 ? 'high' : 'medium',
      }),
    );

    const items = generateShortlist(rows, [], new Set(), 3);
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.rank)).toEqual([1, 2, 3]);
  });
});

describe('runShortlist integration', () => {
  it('reads fixture index, tolerates missing hot-list, and writes JSON output', () => {
    const dir = mkFixtureDir();
    const indexPath = writeFixtureIndex(dir, [
      buildRow({
        fingerprint: 'only-row',
        action_type: 'ci_check',
        priority: 'high',
        bug_id: '260612_only',
      }),
    ]);
    const outPath = path.join(dir, 'shortlist.json');
    const hotlistPath = path.join(dir, 'missing-hotlist.json');
    const options: ShortlistOptions = {
      indexPath,
      hotlistPath,
      topN: 10,
      outPath,
    };

    const result = runShortlist(options);
    expect(result.items).toHaveLength(1);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(outPath, 'utf8'))).toMatchObject({
      hotlist_count: 0,
      live_queue_count: 1,
      items: [{ fingerprint: 'only-row' }],
    });
  });

  it('writes byte-identical JSON for identical inputs', () => {
    const dir = mkFixtureDir();
    const indexPath = writeFixtureIndex(dir, [
      buildRow({
        fingerprint: 'stable-row',
        action_type: 'ci_check',
        priority: 'high',
        bug_id: '260612_stable',
      }),
    ]);
    const firstOutPath = path.join(dir, 'shortlist-a.json');
    const secondOutPath = path.join(dir, 'shortlist-b.json');
    const baseOptions: Omit<ShortlistOptions, 'outPath'> = {
      indexPath,
      hotlistPath: null,
      topN: 10,
    };

    runShortlist({ ...baseOptions, outPath: firstOutPath });
    runShortlist({ ...baseOptions, outPath: secondOutPath });

    expect(fs.readFileSync(secondOutPath, 'utf8')).toBe(fs.readFileSync(firstOutPath, 'utf8'));
  });

  it('buildShortlistResult reports live queue count independent of top-N', () => {
    const rows = [
      buildRow({ fingerprint: 'a', bug_id: '260612_a' }),
      buildRow({ fingerprint: 'b', bug_id: '260611_b' }),
      buildRow({ fingerprint: 'c', bug_id: '260610_c', status: 'implemented' }),
    ];
    const result = buildShortlistResult(
      { indexPath: 'index.yaml', hotlistPath: null, topN: 1, outPath: null },
      rows,
      [],
      new Set(),
    );
    expect(result.live_queue_count).toBe(2);
    expect(result.items).toHaveLength(1);
  });

  it('sinks not-drain-now rows below drain-ready rows of the same tier/priority/date', () => {
    const rows = [
      buildRow({
        fingerprint: 'notready',
        bug_id: '260612_x',
        description: 'Knip production leg. NOT drain-now: production mode needs an entry/project semantics and baseline tuning pass.',
      }),
      buildRow({ fingerprint: 'ready', bug_id: '260612_x', description: 'Add the chokepoint guard.' }),
    ];
    const result = buildShortlistResult(
      { indexPath: 'index.yaml', hotlistPath: null, topN: 10, outPath: null },
      rows,
      [],
      new Set(),
    );
    expect(result.items[0]!.fingerprint).toBe('ready');
    expect(result.items[0]!.rationale.drain_ready).toBe(true);
    expect(result.items[1]!.fingerprint).toBe('notready');
    expect(result.items[1]!.rationale.drain_ready).toBe(false);
  });
});

describe('claimed-demotion', () => {
  function writeClaimsFile(dir: string, claims: RecommendationClaims, name = 'claims.yaml'): string {
    const claimsPath = path.join(dir, name);
    fs.writeFileSync(claimsPath, serializeClaimsFile(claims), 'utf8');
    return claimsPath;
  }

  const SHARED_CLUSTER: IndexClusterEntry = {
    cluster_id: 'shared-cluster',
    title: 'Shared cluster',
    canonical_statement: 'Shared cluster statement',
    surface_hint: null,
    fingerprints: ['member-a', 'member-b'],
    member_count: 2,
    live_member_count: 2,
  };

  function clusterRows(): RecommendationRow[] {
    return [
      buildRow({
        fingerprint: 'member-a',
        cluster_id: 'shared-cluster',
        action_type: 'type_constraint',
        priority: 'high',
        bug_id: '260612_member_a',
        description: 'member a',
      }),
      buildRow({
        fingerprint: 'member-b',
        cluster_id: 'shared-cluster',
        action_type: 'ci_check',
        priority: 'high',
        bug_id: '260612_member_b',
        description: 'member b',
      }),
      buildRow({
        fingerprint: 'plain-singleton',
        action_type: 'documentation',
        priority: 'low',
        bug_id: '260101_plain',
        description: 'plain tier3 singleton',
      }),
    ];
  }

  it('demotes a claimed unit below ALL unclaimed units, regardless of hotlist/drain-ready/tier', () => {
    const dir = mkFixtureDir();
    const rows = [
      buildRow({
        fingerprint: 'claimed-hot-tier1',
        action_type: 'type_constraint',
        priority: 'high',
        bug_id: '260612_claimed',
        description: 'hotlisted tier1 drain-ready row',
      }),
      buildRow({
        fingerprint: 'unclaimed-weak',
        action_type: 'documentation',
        priority: 'low',
        bug_id: '260101_weak',
        description: 'tier3 row. NOT drain-now: needs a design pass first.',
      }),
    ];
    const claimsPath = writeClaimsFile(dir, {
      'claimed-hot-tier1': { run_slug: 'fleet-x', claimed_at: '2026-06-12T10:00:00.000Z', ttl_hours: 48 },
    });
    const claims = loadShortlistClaims(claimsPath, rows, [], NOW);

    const items = generateShortlist(rows, [], new Set(['claimed-hot-tier1']), 10, claims);
    // Demote-don't-hide: still 2 items, claimed one last despite hotlist+tier1+drain-ready.
    expect(items.map((item) => item.fingerprint)).toEqual(['unclaimed-weak', 'claimed-hot-tier1']);
    expect(items).toHaveLength(2);
    expect(items[1]?.rationale).toMatchObject({
      placed_by: 'hotlist',
      claimed_by: 'fleet-x',
      claimed_at: '2026-06-12T10:00:00.000Z',
      claim_age_hours: 2,
    });
    expect(items[0]?.rationale.claimed_by).toBeUndefined();
  });

  it('does not demote on an expired claim', () => {
    const dir = mkFixtureDir();
    const rows = [
      buildRow({ fingerprint: 'was-claimed', action_type: 'type_constraint', priority: 'high', bug_id: '260612_a' }),
      buildRow({ fingerprint: 'other', action_type: 'documentation', priority: 'low', bug_id: '260101_b' }),
    ];
    const claimsPath = writeClaimsFile(dir, {
      'was-claimed': { run_slug: 'fleet-old', claimed_at: '2026-06-10T00:00:00.000Z', ttl_hours: 1 },
    });
    const claims = loadShortlistClaims(claimsPath, rows, [], NOW);
    expect(claims.activeByKey.size).toBe(0);

    const items = generateShortlist(rows, [], new Set(), 10, claims);
    expect(items.map((item) => item.fingerprint)).toEqual(['was-claimed', 'other']);
    expect(items[0]?.rationale.claimed_by).toBeUndefined();
  });

  it('demotes the whole cluster unit when its cluster_id is claimed', () => {
    const dir = mkFixtureDir();
    const rows = clusterRows();
    const claimsPath = writeClaimsFile(dir, {
      'shared-cluster': { run_slug: 'fleet-cluster', claimed_at: NOW.toISOString(), ttl_hours: 48 },
    });
    const claims = loadShortlistClaims(claimsPath, rows, [SHARED_CLUSTER], NOW);

    const items = generateShortlist(rows, [SHARED_CLUSTER], new Set(), 10, claims);
    // The tier1-high cluster sinks below the tier3-low singleton.
    expect(items[0]?.fingerprint).toBe('plain-singleton');
    expect(items[1]?.cluster_id).toBe('shared-cluster');
    expect(items[1]?.rationale).toMatchObject({ claimed_by: 'fleet-cluster', claim_age_hours: 0 });
  });

  it('demotes the cluster unit when any live member fingerprint is claimed', () => {
    const dir = mkFixtureDir();
    const rows = clusterRows();
    const claimsPath = writeClaimsFile(dir, {
      'member-b': { run_slug: 'fleet-member', claimed_at: '2026-06-12T11:30:00.000Z', ttl_hours: 48 },
    });
    const claims = loadShortlistClaims(claimsPath, rows, [SHARED_CLUSTER], NOW);

    const items = generateShortlist(rows, [SHARED_CLUSTER], new Set(), 10, claims);
    expect(items[0]?.fingerprint).toBe('plain-singleton');
    expect(items[1]?.cluster_id).toBe('shared-cluster');
    expect(items[1]?.rationale).toMatchObject({ claimed_by: 'fleet-member', claim_age_hours: 0.5 });
  });

  it('produces identical items with no claims, a missing claims file, and an empty claims file', () => {
    const dir = mkFixtureDir();
    const rows = clusterRows();
    const baseline = generateShortlist(rows, [SHARED_CLUSTER], new Set(), 10);

    const missing = loadShortlistClaims(path.join(dir, 'does-not-exist.yaml'), rows, [SHARED_CLUSTER], NOW);
    const empty = loadShortlistClaims(writeClaimsFile(dir, {}), rows, [SHARED_CLUSTER], NOW);

    expect(generateShortlist(rows, [SHARED_CLUSTER], new Set(), 10, missing)).toEqual(baseline);
    expect(generateShortlist(rows, [SHARED_CLUSTER], new Set(), 10, empty)).toEqual(baseline);
  });

  it('fails loud (throws) on a malformed claims file instead of silently ignoring it', () => {
    const dir = mkFixtureDir();
    const rows = clusterRows();
    const malformedPath = path.join(dir, 'claims.yaml');
    fs.writeFileSync(
      malformedPath,
      'claims:\n  "member-a":\n    run_slug: "Bad Slug"\n    claimed_at: "not-a-date"\n    ttl_hours: 9999\n',
      'utf8',
    );

    expect(() => loadShortlistClaims(malformedPath, rows, [SHARED_CLUSTER], NOW)).toThrow(/invalid-run-slug/);

    const indexPath = writeFixtureIndex(dir, rows, [SHARED_CLUSTER]);
    expect(() =>
      runShortlist({
        indexPath,
        hotlistPath: null,
        topN: 10,
        outPath: null,
        claimsPath: malformedPath,
        now: NOW,
      }),
    ).toThrow(/validation error/);
  });

  it('writes byte-identical JSON with claims and an injected now, and reports claims_path + active_claim_count', () => {
    const dir = mkFixtureDir();
    const rows = clusterRows();
    const indexPath = writeFixtureIndex(dir, rows, [SHARED_CLUSTER]);
    const claimsPath = writeClaimsFile(dir, {
      'member-b': { run_slug: 'fleet-member', claimed_at: '2026-06-12T11:30:00.000Z', ttl_hours: 48 },
    });
    const firstOutPath = path.join(dir, 'shortlist-a.json');
    const secondOutPath = path.join(dir, 'shortlist-b.json');
    const baseOptions: Omit<ShortlistOptions, 'outPath'> = {
      indexPath,
      hotlistPath: null,
      topN: 10,
      claimsPath,
      now: NOW,
    };

    const result = runShortlist({ ...baseOptions, outPath: firstOutPath });
    runShortlist({ ...baseOptions, outPath: secondOutPath });

    expect(fs.readFileSync(secondOutPath, 'utf8')).toBe(fs.readFileSync(firstOutPath, 'utf8'));
    expect(result.claims_path).toBe(claimsPath);
    expect(result.active_claim_count).toBe(1);
  });
});
