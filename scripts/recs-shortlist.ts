#!/usr/bin/env npx tsx
/**
 * Baseline-ordered shortlist generator for the postmortem recommendations live queue.
 *
 * Reads the generated index + optional hot-list fingerprints, ranks open non-quarantined
 * rows (clusters as one unit), and emits top-N JSON plus a markdown table on stdout.
 *
 * Ordering (deterministic, no numeric score):
 *   1. Unclaimed before claimed (demote-don't-hide). A claim is a *coordination*
 *      signal — someone is already implementing the unit — so an active claim
 *      sinks the unit below ALL unclaimed units, including hotlisted ones:
 *      re-picking a claimed item recreates the Round-5 parallel-drain collision.
 *      Claimed rows stay visible with claimant + age in the rationale.
 *   2. Hot-listed items first (direct fingerprint or cluster member match)
 *   3. Drain-ready before not-drain-ready (rows self-marked NOT-drain-now/spike/design-pass sink)
 *   4. Type tier: tier 1 = type_constraint | ci_check | lint_rule;
 *                tier 2 = test_coverage;
 *                tier 3 = other canonical action types
 *   5. Priority: high > medium > low > n/a
 *   6. Recency: newest source date first (bug_id prefix or first_recorded)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { parse as parseYaml } from 'yaml';

import {
  GENERATED_PATH,
  parseExistingIndex,
  type RecommendationClusterCatalog,
  type RecommendationRow,
} from './postmortem-recommendations-tracker';
import {
  CLAIMS_PATH,
  claimAgeHours,
  formatClaimsValidationErrors,
  isClaimActive,
  parseClaimsFile,
  validateClaimsDetailed,
} from './recs-claim';

const REPO_ROOT = path.resolve(__dirname, '..');

const TIER_1_ACTION_TYPES = new Set(['type_constraint', 'ci_check', 'lint_rule']);
const TIER_2_ACTION_TYPES = new Set(['test_coverage']);

const PRIORITY_RANK: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
  'n/a': 3,
};

const BUG_ID_DATE_RE = /^(\d{6})_/;

export type TypeTier = 1 | 2 | 3;
export type PlacedBy = 'hotlist' | 'tier';

export interface IndexClusterEntry {
  cluster_id: string;
  title: string;
  canonical_statement: string;
  surface_hint?: string | null;
  fingerprints: string[];
  member_count: number;
  live_member_count: number;
}

export interface ShortlistRationale {
  drain_ready?: boolean;
  placed_by: PlacedBy;
  tier: TypeTier;
  priority_used: string;
  newest_date: string;
  cluster_id?: string;
  member_count?: number;
  /** Present only on claimed (demoted) units: who is already implementing it. */
  claimed_by?: string;
  claimed_at?: string;
  claim_age_hours?: number;
}

export interface ShortlistItem {
  rank: number;
  unit_kind: 'cluster' | 'singleton';
  fingerprint?: string;
  cluster_id?: string;
  title?: string;
  action_type: string;
  description: string;
  priority: string;
  bug_id?: string;
  member_count?: number;
  member_fingerprints?: string[];
  rationale: ShortlistRationale;
}

export interface ShortlistResult {
  index_path: string;
  hotlist_path: string | null;
  hotlist_count: number;
  claims_path: string | null;
  active_claim_count: number;
  live_queue_count: number;
  top_n: number;
  items: ShortlistItem[];
}

export interface ShortlistOptions {
  indexPath: string;
  hotlistPath: string | null;
  topN: number;
  outPath: string | null;
  /** Claims file for claimed-demotion; null/missing file => no claims. */
  claimsPath?: string | null;
  /** Injected clock for deterministic claim activity/age; defaults to wall clock. */
  now?: Date;
}

export interface ActiveClaimInfo {
  run_slug: string;
  claimed_at: string;
  age_hours: number;
}

export interface ShortlistClaims {
  path: string | null;
  activeByKey: Map<string, ActiveClaimInfo>;
}

interface RankingUnit {
  unit_kind: 'cluster' | 'singleton';
  sort_key: string;
  fingerprint?: string;
  cluster_id?: string;
  title?: string;
  action_type: string;
  description: string;
  priority: string;
  bug_id?: string;
  member_count?: number;
  member_fingerprints?: string[];
  is_hotlisted: boolean;
  is_claimed: boolean;
  claimed_by?: string;
  claimed_at?: string;
  claim_age_hours?: number;
  drain_ready: boolean;
  tier: TypeTier;
  priority_rank: number;
  newest_date: string;
}

// Rows that self-declare unreadiness (explicit not-drain-now / spike / design-pass
// markers in the description) stay visible but sink below drain-ready items: they
// need a readiness decision, not an implementation slot. (Top-50 review F2.)
const NOT_DRAIN_READY_PATTERN =
  /\bNOT[ -]drain[ -]now\b|\bnot drain-now\b|\bneeds? (?:a |an )?(?:spike|design pass|tuning pass|semantics pass)\b|\bdesign-first\b/i;

export function isDrainReady(description: string): boolean {
  return !NOT_DRAIN_READY_PATTERN.test(description);
}

export function extractDateFromRow(row: RecommendationRow): string {
  const fromBugId = row.bug_id.match(BUG_ID_DATE_RE)?.[1];
  if (fromBugId) return fromBugId;
  if (row.first_recorded && row.first_recorded !== '000000') return row.first_recorded;
  return '000000';
}

export function actionTypeTier(actionType: string): TypeTier {
  if (TIER_1_ACTION_TYPES.has(actionType)) return 1;
  if (TIER_2_ACTION_TYPES.has(actionType)) return 2;
  return 3;
}

export function priorityRank(priority: string): number {
  return PRIORITY_RANK[priority] ?? 4;
}

export function parseHotlistFile(raw: string): string[] {
  const parsed = JSON.parse(raw) as unknown;
  if (Array.isArray(parsed)) {
    return parsed.filter((value): value is string => typeof value === 'string');
  }
  if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { fingerprints?: unknown }).fingerprints)) {
    return (parsed as { fingerprints: unknown[] }).fingerprints.filter(
      (value): value is string => typeof value === 'string',
    );
  }
  throw new Error('hot-list must be a JSON array of fingerprints or { "fingerprints": [...] }');
}

export function loadHotlist(hotlistPath: string | null): { path: string | null; fingerprints: Set<string> } {
  if (!hotlistPath) {
    return { path: null, fingerprints: new Set() };
  }
  if (!fs.existsSync(hotlistPath)) {
    return { path: hotlistPath, fingerprints: new Set() };
  }
  const raw = fs.readFileSync(hotlistPath, 'utf8');
  const fingerprints = parseHotlistFile(raw);
  return { path: hotlistPath, fingerprints: new Set(fingerprints) };
}

export function parseClustersFromIndexYaml(yamlText: string): IndexClusterEntry[] {
  const doc = parseYaml(yamlText) as { clusters?: unknown };
  if (!Array.isArray(doc.clusters)) return [];

  return doc.clusters.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`clusters[${index}] must be an object`);
    }
    const cluster = entry as Record<string, unknown>;
    const clusterId = cluster.cluster_id;
    if (typeof clusterId !== 'string' || clusterId.length === 0) {
      throw new Error(`clusters[${index}].cluster_id must be a non-empty string`);
    }
    const fingerprints = Array.isArray(cluster.fingerprints)
      ? cluster.fingerprints.filter((value): value is string => typeof value === 'string')
      : [];
    return {
      cluster_id: clusterId,
      title: typeof cluster.title === 'string' ? cluster.title : clusterId,
      canonical_statement:
        typeof cluster.canonical_statement === 'string' ? cluster.canonical_statement : '',
      surface_hint: typeof cluster.surface_hint === 'string' ? cluster.surface_hint : null,
      fingerprints,
      member_count: typeof cluster.member_count === 'number' ? cluster.member_count : fingerprints.length,
      live_member_count: typeof cluster.live_member_count === 'number' ? cluster.live_member_count : 0,
    };
  });
}

function isLiveQueueRow(row: RecommendationRow): boolean {
  return row.status === 'open' && !row.is_quarantined;
}

function bestTier(members: RecommendationRow[]): TypeTier {
  return members.reduce<TypeTier>((best, row) => {
    const tier = actionTypeTier(row.action_type);
    return tier < best ? tier : best;
  }, 3);
}

function bestPriority(members: RecommendationRow[]): string {
  return members.reduce((best, row) => (priorityRank(row.priority) < priorityRank(best) ? row.priority : best), 'n/a');
}

function newestDate(members: RecommendationRow[]): string {
  return members.reduce((best, row) => {
    const date = extractDateFromRow(row);
    return date.localeCompare(best) > 0 ? date : best;
  }, '000000');
}

function strongestMember(members: RecommendationRow[]): RecommendationRow {
  return [...members].sort((a, b) => {
    const tierCmp = actionTypeTier(a.action_type) - actionTypeTier(b.action_type);
    if (tierCmp !== 0) return tierCmp;
    const priorityCmp = priorityRank(a.priority) - priorityRank(b.priority);
    if (priorityCmp !== 0) return priorityCmp;
    const dateCmp = extractDateFromRow(b).localeCompare(extractDateFromRow(a));
    if (dateCmp !== 0) return dateCmp;
    return a.fingerprint.localeCompare(b.fingerprint);
  })[0]!;
}

function isHotlistedFingerprints(fingerprints: Iterable<string>, hotlist: Set<string>): boolean {
  for (const fingerprint of fingerprints) {
    if (hotlist.has(fingerprint)) return true;
  }
  return false;
}

export const EMPTY_SHORTLIST_CLAIMS: ShortlistClaims = { path: null, activeByKey: new Map() };

function toClusterCatalog(clusters: IndexClusterEntry[]): RecommendationClusterCatalog {
  return {
    clusters: clusters.map(({ cluster_id, title, canonical_statement, surface_hint }) => ({
      cluster_id,
      title,
      canonical_statement,
      ...(surface_hint ? { surface_hint } : {}),
    })),
  };
}

/**
 * Load + validate the claims file, returning only *active* claims keyed by
 * fingerprint-or-cluster_id. Missing/null path => no claims (graceful: old
 * checkouts and branches without the file behave exactly as before). A claims
 * file with validation ERRORS throws — fail-loud, never silently ignore: a
 * silently-dropped claims file would resurrect the parallel-drain collision
 * class this mechanism exists to prevent. Lifecycle warnings (expired, orphan,
 * closed-row) are fine here; expired claims simply don't demote.
 */
export function loadShortlistClaims(
  claimsPath: string | null,
  rows: RecommendationRow[],
  clusters: IndexClusterEntry[],
  now: Date,
): ShortlistClaims {
  if (!claimsPath || !fs.existsSync(claimsPath)) {
    return { path: claimsPath ?? null, activeByKey: new Map() };
  }
  const claimsYaml = fs.readFileSync(claimsPath, 'utf8');
  const validation = validateClaimsDetailed(claimsYaml, rows, toClusterCatalog(clusters), now);
  if (validation.errors.length > 0) {
    throw new Error(formatClaimsValidationErrors(validation.errors).trimEnd());
  }
  const activeByKey = new Map<string, ActiveClaimInfo>();
  const { claims } = parseClaimsFile(claimsYaml);
  for (const id of Object.keys(claims).sort()) {
    const claim = claims[id]!;
    if (!isClaimActive(claim, now)) continue;
    activeByKey.set(id, {
      run_slug: claim.run_slug,
      claimed_at: claim.claimed_at,
      age_hours: Number(claimAgeHours(claim, now).toFixed(2)),
    });
  }
  return { path: claimsPath, activeByKey };
}

/** First active claim matching any candidate key (cluster_id first, then sorted live member fingerprints). */
function findActiveClaim(candidateKeys: string[], claims: ShortlistClaims): ActiveClaimInfo | null {
  for (const key of candidateKeys) {
    const claim = claims.activeByKey.get(key);
    if (claim) return claim;
  }
  return null;
}

export function buildRankingUnits(
  rows: RecommendationRow[],
  clusters: IndexClusterEntry[],
  hotlist: Set<string>,
  claims: ShortlistClaims = EMPTY_SHORTLIST_CLAIMS,
): RankingUnit[] {
  const liveRows = rows.filter(isLiveQueueRow);
  const liveByCluster = new Map<string, RecommendationRow[]>();
  const singletons: RecommendationRow[] = [];

  for (const row of liveRows) {
    if (row.cluster_id) {
      const existing = liveByCluster.get(row.cluster_id);
      if (existing) existing.push(row);
      else liveByCluster.set(row.cluster_id, [row]);
    } else {
      singletons.push(row);
    }
  }

  const clusterCatalog = new Map(clusters.map((cluster) => [cluster.cluster_id, cluster]));
  const units: RankingUnit[] = [];

  for (const [clusterId, members] of liveByCluster) {
    const catalog = clusterCatalog.get(clusterId);
    const memberFingerprints = members.map((row) => row.fingerprint);
    const strongest = strongestMember(members);
    const hotlisted =
      isHotlistedFingerprints(memberFingerprints, hotlist) ||
      isHotlistedFingerprints(catalog?.fingerprints ?? [], hotlist);
    const sortedMemberFingerprints = [...memberFingerprints].sort();
    // A cluster unit is claimed if its cluster_id is claimed OR any live member
    // fingerprint is claimed (mirrors the hotlist member-matching pattern and
    // recs-claim's scope semantics; claims on closed members are inert).
    const claim = findActiveClaim([clusterId, ...sortedMemberFingerprints], claims);

    units.push({
      unit_kind: 'cluster',
      sort_key: `cluster:${clusterId}`,
      cluster_id: clusterId,
      title: catalog?.title ?? clusterId,
      action_type: strongest.action_type,
      description: catalog?.canonical_statement || strongest.description,
      priority: bestPriority(members),
      member_count: members.length,
      member_fingerprints: sortedMemberFingerprints,
      is_hotlisted: hotlisted,
      is_claimed: claim !== null,
      ...(claim
        ? { claimed_by: claim.run_slug, claimed_at: claim.claimed_at, claim_age_hours: claim.age_hours }
        : {}),
      drain_ready: members.some((member) => isDrainReady(member.description)),
      tier: bestTier(members),
      priority_rank: priorityRank(bestPriority(members)),
      newest_date: newestDate(members),
    });
  }

  for (const row of singletons) {
    const claim = findActiveClaim([row.fingerprint], claims);
    units.push({
      unit_kind: 'singleton',
      sort_key: `singleton:${row.fingerprint}`,
      fingerprint: row.fingerprint,
      action_type: row.action_type,
      description: row.description,
      priority: row.priority,
      bug_id: row.bug_id,
      is_hotlisted: hotlist.has(row.fingerprint),
      is_claimed: claim !== null,
      ...(claim
        ? { claimed_by: claim.run_slug, claimed_at: claim.claimed_at, claim_age_hours: claim.age_hours }
        : {}),
      drain_ready: isDrainReady(row.description),
      tier: actionTypeTier(row.action_type),
      priority_rank: priorityRank(row.priority),
      newest_date: extractDateFromRow(row),
    });
  }

  return units;
}

export function compareRankingUnits(a: RankingUnit, b: RankingUnit): number {
  // Claimed-demotion is deliberately the FIRST key: hotlist/drain_ready/tier are
  // prioritisation signals ("most worth doing"), a claim is a coordination signal
  // ("someone is already doing it"). A claimed unit sinks below ALL unclaimed
  // units — demoted, never hidden (claimant + age stay visible in the rationale).
  if (a.is_claimed !== b.is_claimed) return a.is_claimed ? 1 : -1;
  if (a.is_hotlisted !== b.is_hotlisted) return a.is_hotlisted ? -1 : 1;
  if (a.drain_ready !== b.drain_ready) return a.drain_ready ? -1 : 1;
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.priority_rank !== b.priority_rank) return a.priority_rank - b.priority_rank;
  if (a.newest_date !== b.newest_date) return b.newest_date.localeCompare(a.newest_date);
  return a.sort_key.localeCompare(b.sort_key);
}

function toShortlistItem(unit: RankingUnit, rank: number): ShortlistItem {
  const rationale: ShortlistRationale = {
    placed_by: unit.is_hotlisted ? 'hotlist' : 'tier',
    tier: unit.tier,
    priority_used: unit.priority,
    newest_date: unit.newest_date,
    drain_ready: unit.drain_ready,
  };
  if (unit.cluster_id) {
    rationale.cluster_id = unit.cluster_id;
    rationale.member_count = unit.member_count;
  }
  if (unit.is_claimed) {
    rationale.claimed_by = unit.claimed_by;
    rationale.claimed_at = unit.claimed_at;
    rationale.claim_age_hours = unit.claim_age_hours;
  }

  return {
    rank,
    unit_kind: unit.unit_kind,
    fingerprint: unit.fingerprint,
    cluster_id: unit.cluster_id,
    title: unit.title,
    action_type: unit.action_type,
    description: unit.description,
    priority: unit.priority,
    bug_id: unit.bug_id,
    member_count: unit.member_count,
    member_fingerprints: unit.member_fingerprints,
    rationale,
  };
}

export function generateShortlist(
  rows: RecommendationRow[],
  clusters: IndexClusterEntry[],
  hotlist: Set<string>,
  topN: number,
  claims: ShortlistClaims = EMPTY_SHORTLIST_CLAIMS,
): ShortlistItem[] {
  const units = buildRankingUnits(rows, clusters, hotlist, claims).sort(compareRankingUnits);
  return units.slice(0, topN).map((unit, index) => toShortlistItem(unit, index + 1));
}

export function formatMarkdownTable(items: ShortlistItem[]): string {
  const headers = ['Rank', 'Kind', 'ID', 'Type', 'Priority', 'Date', 'Placed by', 'Claimed', 'Description'];
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ];

  for (const item of items) {
    const id =
      item.unit_kind === 'cluster'
        ? `${item.cluster_id} (${item.member_count ?? 0})`
        : item.fingerprint ?? '';
    const description = item.description.replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 120);
    const claimed = item.rationale.claimed_by
      ? `${item.rationale.claimed_by} (${item.rationale.claim_age_hours}h)`
      : '';
    lines.push(
      `| ${item.rank} | ${item.unit_kind} | ${id} | ${item.action_type} | ${item.priority} | ${item.rationale.newest_date} | ${item.rationale.placed_by} | ${claimed} | ${description} |`,
    );
  }

  return lines.join('\n');
}

export function buildShortlistResult(
  options: ShortlistOptions,
  rows: RecommendationRow[],
  clusters: IndexClusterEntry[],
  hotlist: Set<string>,
  claims: ShortlistClaims = EMPTY_SHORTLIST_CLAIMS,
): ShortlistResult {
  const liveQueueCount = rows.filter(isLiveQueueRow).length;
  const items = generateShortlist(rows, clusters, hotlist, options.topN, claims);

  return {
    index_path: options.indexPath,
    hotlist_path: options.hotlistPath,
    hotlist_count: hotlist.size,
    claims_path: claims.path,
    active_claim_count: claims.activeByKey.size,
    live_queue_count: liveQueueCount,
    top_n: options.topN,
    items,
  };
}

export function runShortlist(options: ShortlistOptions): ShortlistResult {
  const yamlText = fs.readFileSync(options.indexPath, 'utf8');
  const { rows } = parseExistingIndex(yamlText);
  const clusters = parseClustersFromIndexYaml(yamlText);
  const { fingerprints } = loadHotlist(options.hotlistPath);
  const now = options.now ?? new Date();
  const claims = loadShortlistClaims(options.claimsPath ?? null, rows, clusters, now);
  const result = buildShortlistResult(options, rows, clusters, fingerprints, claims);

  if (options.outPath) {
    fs.writeFileSync(options.outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }

  process.stdout.write(`${formatMarkdownTable(result.items)}\n`);
  return result;
}

function parseCliArgs(argv: string[]): ShortlistOptions {
  const options: ShortlistOptions = {
    indexPath: GENERATED_PATH,
    hotlistPath: null,
    topN: 50,
    outPath: null,
    claimsPath: CLAIMS_PATH,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--index': {
        const value = argv[i + 1];
        if (!value) throw new Error('--index requires a path');
        options.indexPath = path.isAbsolute(value) ? value : path.join(REPO_ROOT, value);
        i += 1;
        break;
      }
      case '--hotlist': {
        const value = argv[i + 1];
        if (!value) throw new Error('--hotlist requires a path');
        options.hotlistPath = path.isAbsolute(value) ? value : path.join(REPO_ROOT, value);
        i += 1;
        break;
      }
      case '--top': {
        const value = argv[i + 1];
        if (!value) throw new Error('--top requires a number');
        const topN = Number.parseInt(value, 10);
        if (!Number.isFinite(topN) || topN < 1) throw new Error('--top must be a positive integer');
        options.topN = topN;
        i += 1;
        break;
      }
      case '--out': {
        const value = argv[i + 1];
        if (!value) throw new Error('--out requires a path');
        options.outPath = path.isAbsolute(value) ? value : path.join(REPO_ROOT, value);
        i += 1;
        break;
      }
      case '--claims': {
        const value = argv[i + 1];
        if (!value) throw new Error('--claims requires a path');
        options.claimsPath = path.isAbsolute(value) ? value : path.join(REPO_ROOT, value);
        i += 1;
        break;
      }
      case '--now': {
        const value = argv[i + 1];
        if (!value) throw new Error('--now requires an ISO timestamp');
        const now = new Date(value);
        if (!Number.isFinite(now.getTime())) throw new Error(`--now must be an ISO timestamp (got ${JSON.stringify(value)})`);
        options.now = now;
        i += 1;
        break;
      }
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printUsage(): void {
  process.stdout.write(`Usage: npx tsx scripts/recs-shortlist.ts [options]

Options:
  --index <path>     Generated recommendations index (default: docs-private/postmortems/_index_recommendations.generated.yaml)
  --hotlist <path>   Optional JSON hot-list (array or { "fingerprints": [...] }); missing file => empty hot-list
  --claims <path>    Claims file for claimed-demotion (default: docs-private/postmortems/_recommendations_claims.yaml);
                     missing file => no claims; malformed file => exit 1 (fail-loud)
  --now <iso>        Injected clock for claim activity/age (default: wall clock)
  --top <n>          Number of items to emit (default: 50)
  --out <path>       Write JSON result to this path
  -h, --help         Show this help
`);
}

function main(): void {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    if (!fs.existsSync(options.indexPath)) {
      throw new Error(`index file not found: ${options.indexPath}`);
    }
    runShortlist(options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`recs-shortlist: ${message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
