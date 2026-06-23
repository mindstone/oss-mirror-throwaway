#!/usr/bin/env npx tsx
/**
 * Postmortem-recommendations staleness scan — report-only candidate detector.
 *
 * Reads the generated index (`docs-private/postmortems/_index_recommendations.generated.yaml`)
 * and emits a CANDIDATES REPORT (JSON + stdout markdown summary). Never modifies
 * `_recommendations_overrides.yaml`.
 *
 * Four detectors:
 *   1. shipped-language — strict closure phrases or commit SHAs in open descriptions
 *   2. dead-target — all referenced repo paths missing on disk
 *   3. family-supersession — open row in a cluster with an implemented member
 *   4. stale-blocked — blocked-on-signal rows past the revisit threshold
 *
 * Plus a stale-claims section: expired / closed-row / orphan entries in the
 * in-flight claims file (`_recommendations_claims.yaml`) — the implicit-release
 * residue flagged as GC candidates. Report-only; correctness never depends on
 * this (TTL auto-expiry and row closure already make stale claims inert).
 *
 * Run: `npx tsx scripts/recs-staleness-scan.ts [--index PATH] [--out PATH] [--stale-days N] [--claims PATH]`
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { parse as parseYaml } from 'yaml';

import { gitCapture } from './lib/git-exec';

import {
  GENERATED_PATH,
  type RecommendationClusterCatalog,
  type RecommendationReasonKind,
  type RecommendationRow,
  type RecommendationStatus,
} from './postmortem-recommendations-tracker.ts';
import {
  CLAIMS_PATH,
  describeClaims,
  parseClaimsFile,
  type ClaimListItem,
} from './recs-claim';

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT_PATH = path.join(
  REPO_ROOT,
  'docs/plans/260611_recs-triage-system/generated/recs-staleness-candidates.json',
);

export type StalenessDetector =
  | 'shipped-language'
  | 'dead-target'
  | 'family-supersession'
  | 'stale-blocked';

export type SuggestedStatus =
  | 'implemented-candidate'
  | 'needs-verification'
  | 'target-review'
  | 'superseded-review'
  | 'none';

export interface StalenessCandidate {
  fingerprint: string;
  detector: StalenessDetector;
  evidence: Record<string, unknown>;
  suggested_status: SuggestedStatus;
  reason_kind?: string;
}

/** A non-active claims-file entry (expired / closed-row / orphan) flagged for GC. */
export type StaleClaimEntry = ClaimListItem;

export interface StalenessScanReport {
  index_path: string;
  claims_path: string | null;
  stale_days: number;
  live_queue_count: number;
  candidates: StalenessCandidate[];
  counts_by_detector: Record<StalenessDetector, number>;
  stale_claims: StaleClaimEntry[];
}

export interface GeneratedIndexCluster {
  cluster_id: string;
  fingerprints: string[];
}

export interface ParsedGeneratedIndex {
  recommendations: RecommendationRow[];
  clusters: GeneratedIndexCluster[];
}

const COMMIT_SHA_RE = /\b[0-9a-f]{7,40}\b/gi;
const DOCS_PLAN_PATH_RE = /docs\/plans\/[a-zA-Z0-9_@./-]+/;

const SHIPPED_PHRASE_RES: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'SHIPPED', re: /\bSHIPPED\b/i },
  { label: 'implemented in', re: /\bimplemented in\b/i },
  { label: 'landed in', re: /\blanded in\b/i },
  { label: 'done in fix', re: /\bdone in fix\b/i },
];

/** Repo-relative path tokens (src/..., scripts/....ts, docs/..., etc.). */
const REPO_PATH_RE =
  /(?:src|scripts|docs(?:\/project)?|cloud-service|packages|mobile|evals|mcp-servers|coding-agent-instructions)\/[a-zA-Z0-9_@./-]+/g;
const KNOWN_PATH_EXTENSION_RE =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|yaml|yml|py|sh|css|scss|html|sql|toml|lock)$/i;
const KNOWN_EXTENSIONLESS_PREFIX_RE =
  /^(?:src|scripts|docs\/project|cloud-service\/src|packages\/[^/]+\/src|mcp-servers\/[^/]+\/src|evals|coding-agent-instructions\/(?:workflows|scripts|docs|skills))\//;
const TRAILING_PATH_PUNCTUATION_RE = /[.,;:!?`'")\]]+$/;
const FUTURE_TARGET_BEFORE_RE =
  /\b(?:add|adding|create|creating|new|planned|proposed|e\.g\.|eg|should|introduce|introducing)\b/i;
const NEGATION_CONTEXT_RE =
  /\b(?:not|never|no|without|unreleased|introduced in|regressed in|broken by|buggy history|we just shipped the bug|not yet shipped|not drain-now)\b/i;
const CONTRARY_SHA_CONTEXT_RE = /\b(?:introduced|regressed)\s+in\b|\bbroken\s+by\b/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecommendationRow(raw: unknown, label: string): RecommendationRow {
  if (!isRecord(raw)) {
    throw new Error(`${label} is not a mapping`);
  }
  const requiredStrings = [
    'fingerprint',
    'postmortem',
    'bug_id',
    'action_type',
    'description',
    'priority',
    'status',
    'first_recorded',
  ] as const;
  for (const key of requiredStrings) {
    if (typeof raw[key] !== 'string') {
      throw new Error(`${label} missing string field "${key}"`);
    }
  }
  const reasonKind =
    typeof raw.reason_kind === 'string' ? (raw.reason_kind as RecommendationReasonKind) : null;
  return {
    fingerprint: raw.fingerprint as string,
    postmortem: raw.postmortem as string,
    bug_id: raw.bug_id as string,
    action_type: raw.action_type as string,
    description: raw.description as string,
    priority: raw.priority as string,
    status: raw.status as RecommendationStatus,
    first_recorded: raw.first_recorded as string,
    last_revisited: typeof raw.last_revisited === 'string' ? raw.last_revisited : null,
    rejection_reason: typeof raw.rejection_reason === 'string' ? raw.rejection_reason : null,
    absorbed_into: typeof raw.absorbed_into === 'string' ? raw.absorbed_into : null,
    revisit_signal: typeof raw.revisit_signal === 'string' ? raw.revisit_signal : null,
    owner: typeof raw.owner === 'string' ? raw.owner : null,
    reason_kind: reasonKind,
    cluster_id: typeof raw.cluster_id === 'string' ? raw.cluster_id : null,
    is_quarantined: raw.is_quarantined === true,
  };
}

function parseCluster(raw: unknown, label: string): GeneratedIndexCluster {
  if (!isRecord(raw)) {
    throw new Error(`${label} is not a mapping`);
  }
  if (typeof raw.cluster_id !== 'string' || raw.cluster_id.length === 0) {
    throw new Error(`${label} missing cluster_id`);
  }
  const fingerprints = raw.fingerprints;
  if (!Array.isArray(fingerprints)) {
    throw new Error(`${label} missing fingerprints array`);
  }
  return {
    cluster_id: raw.cluster_id,
    fingerprints: fingerprints.map((fp, index) => {
      if (typeof fp !== 'string' || fp.length === 0) {
        throw new Error(`${label}.fingerprints[${index}] is not a non-empty string`);
      }
      return fp;
    }),
  };
}

export function parseGeneratedIndex(yamlText: string): ParsedGeneratedIndex {
  const parsed = parseYaml(yamlText, { uniqueKeys: true });
  if (!isRecord(parsed)) {
    throw new Error('index top-level is not a mapping');
  }
  const recommendationsRaw = parsed.recommendations;
  if (!Array.isArray(recommendationsRaw)) {
    throw new Error('index missing recommendations array');
  }
  const recommendations = recommendationsRaw.map((row, index) =>
    parseRecommendationRow(row, `recommendations[${index}]`),
  );

  const clustersRaw = parsed.clusters;
  const clusters = Array.isArray(clustersRaw)
    ? clustersRaw.map((cluster, index) => parseCluster(cluster, `clusters[${index}]`))
    : [];

  return { recommendations, clusters };
}

export function parseYyMmDd(value: string): Date | null {
  const match = /^(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (!match) return null;
  const year = 2000 + Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

export function daysSinceYyMmDd(value: string, today: Date): number | null {
  const parsed = parseYyMmDd(value);
  if (!parsed) return null;
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const valueUtc = Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate());
  return Math.floor((todayUtc - valueUtc) / (24 * 60 * 60 * 1000));
}

export function verifyCommitExists(sha: string, repoRoot: string = REPO_ROOT): boolean {
  try {
    gitCapture(['cat-file', '-e', `${sha}^{commit}`], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

function stripTrailingPathPunctuation(token: string): string {
  return token.replace(TRAILING_PATH_PUNCTUATION_RE, '');
}

function contextAround(text: string, start: number, end: number, radius = 48): string {
  return text.slice(Math.max(0, start - radius), Math.min(text.length, end + radius));
}

function isNegatedContext(text: string, start: number, end: number): boolean {
  return NEGATION_CONTEXT_RE.test(contextAround(text, start, end));
}

function isFutureTargetContext(text: string, start: number): boolean {
  const before = text.slice(Math.max(0, start - 72), start);
  return FUTURE_TARGET_BEFORE_RE.test(before);
}

function isPathLikeToken(token: string): boolean {
  if (!token.includes('/')) return false;
  if (KNOWN_PATH_EXTENSION_RE.test(token)) return true;
  return KNOWN_EXTENSIONLESS_PREFIX_RE.test(token);
}

interface CommitShaMatch {
  sha: string;
  index: number;
  verified: boolean;
  negated_context: boolean;
}

interface StrictClosureMatch {
  label: string;
  target: string;
  target_type: 'sha' | 'plan-path';
  verified: boolean;
}

export function extractCommitShas(description: string): string[] {
  const seen = new Set<string>();
  const matches: string[] = [];
  for (const match of description.matchAll(COMMIT_SHA_RE)) {
    const sha = match[0].toLowerCase();
    if (!seen.has(sha)) {
      seen.add(sha);
      matches.push(sha);
    }
  }
  return matches;
}

function extractCommitShaMatches(
  description: string,
  verifySha: (sha: string) => boolean,
): CommitShaMatch[] {
  const seen = new Set<string>();
  const matches: CommitShaMatch[] = [];
  for (const match of description.matchAll(COMMIT_SHA_RE)) {
    const sha = match[0].toLowerCase();
    if (seen.has(sha)) continue;
    seen.add(sha);
    const index = match.index ?? 0;
    matches.push({
      sha,
      index,
      verified: verifySha(sha),
      negated_context:
        isNegatedContext(description, index, index + match[0].length) ||
        CONTRARY_SHA_CONTEXT_RE.test(contextAround(description, index, index + match[0].length)),
    });
  }
  return matches;
}

export function extractShippedPhrases(description: string): string[] {
  const found: string[] = [];
  for (const { label, re } of SHIPPED_PHRASE_RES) {
    const match = re.exec(description);
    if (match && !isNegatedContext(description, match.index, match.index + match[0].length)) {
      found.push(label);
    }
  }
  return found;
}

export function extractRepoPaths(description: string): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const match of description.matchAll(REPO_PATH_RE)) {
    const token = stripTrailingPathPunctuation(match[0]);
    if (!isPathLikeToken(token)) continue;
    if (!seen.has(token)) {
      seen.add(token);
      paths.push(token);
    }
  }
  return paths;
}

function extractRepoPathMatches(description: string): Array<{ path: string; index: number }> {
  const seen = new Set<string>();
  const paths: Array<{ path: string; index: number }> = [];
  for (const match of description.matchAll(REPO_PATH_RE)) {
    const token = stripTrailingPathPunctuation(match[0]);
    if (!isPathLikeToken(token)) continue;
    if (isFutureTargetContext(description, match.index ?? 0)) continue;
    if (!seen.has(token)) {
      seen.add(token);
      paths.push({ path: token, index: match.index ?? 0 });
    }
  }
  return paths;
}

export function pathExists(repoRelativePath: string, repoRoot: string = REPO_ROOT): boolean {
  return fs.existsSync(path.join(repoRoot, repoRelativePath));
}

function isLiveOpenRow(row: RecommendationRow): boolean {
  return row.status === 'open' && !row.is_quarantined;
}

function extractStrictClosureMatches(
  description: string,
  verifySha: (sha: string) => boolean,
  artifactExists: (repoPath: string) => boolean,
): StrictClosureMatch[] {
  const matches: StrictClosureMatch[] = [];
  const strictPatterns: ReadonlyArray<{ label: string; re: RegExp }> = [
    {
      label: 'SHIPPED <sha>',
      re: /\bSHIPPED\b\s+(?:in\s+)?([0-9a-f]{7,40})\b/gi,
    },
    {
      label: 'Shipped in commit(s) <sha>',
      re: /\bshipped\s+in\s+commits?\s+([0-9a-f]{7,40})\b/gi,
    },
    {
      label: 'implemented in <sha|docs/plans/...>',
      re: /\bimplemented\s+in\s+([0-9a-f]{7,40}|docs\/plans\/[a-zA-Z0-9_@./-]+)/gi,
    },
  ];

  for (const { label, re } of strictPatterns) {
    for (const match of description.matchAll(re)) {
      const rawTarget = match[1];
      if (!rawTarget) continue;
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (isNegatedContext(description, start, end)) continue;

      const target = stripTrailingPathPunctuation(rawTarget);
      const isSha = /^[0-9a-f]{7,40}$/i.test(target);
      const isPlanPath = DOCS_PLAN_PATH_RE.test(target);
      const verified = isSha ? verifySha(target.toLowerCase()) : isPlanPath && artifactExists(target);
      if (!verified) continue;

      matches.push({
        label,
        target: isSha ? target.toLowerCase() : target,
        target_type: isSha ? 'sha' : 'plan-path',
        verified,
      });
    }
  }

  return matches;
}

export function detectShippedLanguage(
  row: RecommendationRow,
  verifySha: (sha: string) => boolean = verifyCommitExists,
  artifactExists: (repoPath: string) => boolean = pathExists,
): StalenessCandidate | null {
  if (!isLiveOpenRow(row)) return null;

  const shas = extractCommitShaMatches(row.description, verifySha);
  const phrases = extractShippedPhrases(row.description);
  if (shas.length === 0 && phrases.length === 0) return null;

  const strictMatches = extractStrictClosureMatches(row.description, verifySha, artifactExists);
  if (strictMatches.length > 0) {
    return {
      fingerprint: row.fingerprint,
      detector: 'shipped-language',
      evidence: {
        shas,
        phrases,
        strict_matches: strictMatches,
      },
      suggested_status: 'implemented-candidate',
    };
  }

  return {
    fingerprint: row.fingerprint,
    detector: 'shipped-language',
    evidence: {
      shas,
      phrases,
      negated_context: shas.some((sha) => sha.negated_context),
    },
    suggested_status: 'needs-verification',
  };
}

export function detectDeadTarget(
  row: RecommendationRow,
  exists: (repoPath: string) => boolean = pathExists,
): StalenessCandidate | null {
  if (!isLiveOpenRow(row)) return null;

  const pathMatches = extractRepoPathMatches(row.description);
  const paths = pathMatches.map((match) => match.path);
  if (paths.length === 0) return null;

  const missing = paths.filter((repoPath) => !exists(repoPath));
  if (missing.length !== paths.length) return null;

  return {
    fingerprint: row.fingerprint,
    detector: 'dead-target',
    evidence: {
      referenced_paths: paths,
      missing_paths: missing,
    },
    suggested_status: 'target-review',
  };
}

export function buildRowsByFingerprint(rows: RecommendationRow[]): Map<string, RecommendationRow> {
  return new Map(rows.map((row) => [row.fingerprint, row]));
}

export function detectFamilySupersession(
  row: RecommendationRow,
  clusters: GeneratedIndexCluster[],
  rowsByFingerprint: Map<string, RecommendationRow>,
): StalenessCandidate | null {
  if (!isLiveOpenRow(row) || !row.cluster_id) return null;
  if (clusters.length === 0) return null;

  const cluster = clusters.find((entry) => entry.cluster_id === row.cluster_id);
  if (!cluster || cluster.fingerprints.length === 0) return null;

  const implementedMembers = cluster.fingerprints
    .filter((fp) => fp !== row.fingerprint)
    .map((fp) => rowsByFingerprint.get(fp))
    .filter((member): member is RecommendationRow => member?.status === 'implemented');

  if (implementedMembers.length === 0) return null;

  return {
    fingerprint: row.fingerprint,
    detector: 'family-supersession',
    evidence: {
      cluster_id: row.cluster_id,
      implemented_member_fingerprints: implementedMembers.map((member) => member.fingerprint),
    },
    suggested_status: 'superseded-review',
  };
}

export function detectStaleBlocked(
  row: RecommendationRow,
  staleDays: number,
  today: Date = new Date(),
): StalenessCandidate | null {
  if (row.status !== 'blocked-on-signal') return null;
  if (!row.last_revisited) return null;

  const ageDays = daysSinceYyMmDd(row.last_revisited, today);
  if (ageDays === null || ageDays <= staleDays) return null;

  return {
    fingerprint: row.fingerprint,
    detector: 'stale-blocked',
    evidence: {
      last_revisited: row.last_revisited,
      age_days: ageDays,
      stale_days_threshold: staleDays,
      revisit_signal: row.revisit_signal,
      owner: row.owner,
    },
    suggested_status: 'none',
  };
}

/**
 * List the non-active claims in a claims file: expired (TTL passed), closed-row
 * (the normal implicit-release residue — its recommendation rows were curated
 * closed), and orphan (key matches nothing in the corpus). Report-only GC
 * observability; structural parse failures throw (fail-loud, same as the index).
 */
export function detectStaleClaims(
  claimsYaml: string,
  index: ParsedGeneratedIndex,
  today: Date,
): StaleClaimEntry[] {
  const clusterCatalog: RecommendationClusterCatalog = {
    clusters: index.clusters.map((cluster) => ({
      cluster_id: cluster.cluster_id,
      title: cluster.cluster_id,
      canonical_statement: '',
    })),
  };
  const { claims } = parseClaimsFile(claimsYaml);
  return describeClaims(claims, { liveRows: index.recommendations, clusterCatalog }, today).filter(
    (item) => item.state !== 'active',
  );
}

export function runStalenessScan(options: {
  index: ParsedGeneratedIndex;
  staleDays?: number;
  today?: Date;
  verifySha?: (sha: string) => boolean;
  pathExistsFn?: (repoPath: string) => boolean;
  /** Raw claims-file YAML; null/undefined => no claims file (empty stale-claims section). */
  claimsYaml?: string | null;
}): StalenessScanReport {
  const staleDays = options.staleDays ?? 45;
  const today = options.today ?? new Date();
  const rowsByFingerprint = buildRowsByFingerprint(options.index.recommendations);
  const liveQueueCount = options.index.recommendations.filter(isLiveOpenRow).length;

  const candidates: StalenessCandidate[] = [];
  for (const row of options.index.recommendations) {
    const shipped = detectShippedLanguage(row, options.verifySha, options.pathExistsFn);
    if (shipped) candidates.push(shipped);

    const dead = detectDeadTarget(row, options.pathExistsFn);
    if (dead) candidates.push(dead);

    const superseded = detectFamilySupersession(row, options.index.clusters, rowsByFingerprint);
    if (superseded) candidates.push(superseded);

    const stale = detectStaleBlocked(row, staleDays, today);
    if (stale) candidates.push(stale);
  }

  const countsByDetector: Record<StalenessDetector, number> = {
    'shipped-language': 0,
    'dead-target': 0,
    'family-supersession': 0,
    'stale-blocked': 0,
  };
  for (const candidate of candidates) {
    countsByDetector[candidate.detector] += 1;
  }

  const staleClaims = options.claimsYaml ? detectStaleClaims(options.claimsYaml, options.index, today) : [];

  return {
    index_path: '',
    claims_path: null,
    stale_days: staleDays,
    live_queue_count: liveQueueCount,
    candidates,
    counts_by_detector: countsByDetector,
    stale_claims: staleClaims,
  };
}

export function formatMarkdownSummary(report: StalenessScanReport): string {
  const lines = [
    '# Recs staleness scan — candidates report',
    '',
    `Index: ${report.index_path}`,
    `Live queue (open, non-quarantined): ${report.live_queue_count}`,
    `Stale blocked threshold: ${report.stale_days} days`,
    '',
    '## Counts by detector',
    '',
    `- shipped-language: ${report.counts_by_detector['shipped-language']}`,
    `- dead-target: ${report.counts_by_detector['dead-target']}`,
    `- family-supersession: ${report.counts_by_detector['family-supersession']}`,
    `- stale-blocked: ${report.counts_by_detector['stale-blocked']}`,
    '',
    `**Total candidates: ${report.candidates.length}**`,
    '',
    '## Stale claims (GC candidates)',
    '',
    ...(report.stale_claims.length === 0
      ? ['- none']
      : report.stale_claims.map(
          (claim) =>
            `- ${claim.id}: ${claim.state} — run ${claim.run_slug}, age ${claim.age_hours}h (ttl ${claim.ttl_hours}h)`,
        )),
    '',
    '_Report-only — closure still requires per-row artifact verification._',
  ];
  return lines.join('\n');
}

function parseArgs(argv: string[]): {
  indexPath: string;
  outPath: string;
  staleDays: number;
  claimsPath: string;
} {
  let indexPath = GENERATED_PATH;
  let outPath = DEFAULT_OUT_PATH;
  let staleDays = 45;
  let claimsPath = CLAIMS_PATH;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--index') {
      const value = argv[i + 1];
      if (!value) throw new Error('--index requires a path');
      indexPath = path.resolve(value);
      i += 1;
    } else if (arg === '--claims') {
      const value = argv[i + 1];
      if (!value) throw new Error('--claims requires a path');
      claimsPath = path.resolve(value);
      i += 1;
    } else if (arg === '--out') {
      const value = argv[i + 1];
      if (!value) throw new Error('--out requires a path');
      outPath = path.resolve(value);
      i += 1;
    } else if (arg === '--stale-days') {
      const value = argv[i + 1];
      if (!value) throw new Error('--stale-days requires a number');
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error('--stale-days must be a non-negative number');
      }
      staleDays = parsed;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        `Usage: npx tsx scripts/recs-staleness-scan.ts [--index PATH] [--out PATH] [--stale-days N] [--claims PATH]`,
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { indexPath, outPath, staleDays, claimsPath };
}

function main(): void {
  const { indexPath, outPath, staleDays, claimsPath } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(indexPath)) {
    console.error(
      `[recs-staleness-scan] FAIL: index not found at ${path.relative(REPO_ROOT, indexPath)}.\n` +
        'Regenerate via `npm run regenerate:postmortem-recommendations`.',
    );
    process.exit(1);
  }

  const index = parseGeneratedIndex(fs.readFileSync(indexPath, 'utf-8'));
  // Missing claims file => no claims (pre-bootstrap checkouts/branches).
  const claimsYaml = fs.existsSync(claimsPath) ? fs.readFileSync(claimsPath, 'utf-8') : null;
  const report = runStalenessScan({ index, staleDays, claimsYaml });
  report.index_path = path.relative(REPO_ROOT, indexPath);
  report.claims_path = claimsYaml === null ? null : path.relative(REPO_ROOT, claimsPath);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');

  const summary = formatMarkdownSummary(report);
  console.log(summary);
  console.log(`\nWrote JSON report to ${path.relative(REPO_ROOT, outPath)}`);
}

if (require.main === module) {
  main();
}
