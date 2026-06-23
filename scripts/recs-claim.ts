#!/usr/bin/env npx tsx
/**
 * In-flight claim coordination for the postmortem-recommendations drain queue.
 *
 * Claims are launcher-owned run state, stored separately from durable curation
 * overrides. The CLI writes only docs-private/postmortems/_recommendations_claims.yaml;
 * the launcher commits that file as the dispatch manifest.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { parse as parseYaml, YAMLParseError } from 'yaml';

import {
  type RecommendationClusterCatalog,
  type RecommendationRow,
  loadClusterCatalogIfPresent,
  parseExistingIndex,
  runTracker,
} from './postmortem-recommendations-tracker';

const REPO_ROOT = path.resolve(__dirname, '..');
const POSTMORTEMS_DIR = path.join(REPO_ROOT, 'docs-private/postmortems');

export const CLAIMS_PATH = path.join(POSTMORTEMS_DIR, '_recommendations_claims.yaml');
export const DEFAULT_TTL_HOURS = 48;
export const MIN_TTL_HOURS = 1;
export const MAX_TTL_HOURS = 168;
export const FUTURE_SKEW_ALLOWANCE_HOURS = 1;

const RUN_SLUG_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const HOUR_MS = 60 * 60 * 1000;

export interface RecommendationClaim {
  run_slug: string;
  claimed_at: string;
  ttl_hours: number;
}

export type RecommendationClaims = Record<string, RecommendationClaim>;

export interface ParsedClaimsFile {
  claims: RecommendationClaims;
}

export type ClaimValidationErrorReason =
  | 'yaml-parse-error'
  | 'duplicate-key'
  | 'no-claims'
  | 'not-a-mapping'
  | 'unknown-key'
  | 'invalid-run-slug'
  | 'invalid-claimed-at'
  | 'future-claimed-at'
  | 'invalid-ttl-hours'
  | 'overlapping-active-claim';

export interface ClaimValidationError {
  id: string;
  reason: ClaimValidationErrorReason;
  detail: string;
}

export type ClaimValidationWarningReason =
  | 'expired-claim'
  | 'orphan-claim'
  | 'closed-row-claim'
  | 'unknown-top-level-key';

export interface ClaimValidationWarning {
  id: string;
  reason: ClaimValidationWarningReason;
  detail: string;
}

export interface ClaimValidationResult {
  errors: ClaimValidationError[];
  warnings: ClaimValidationWarning[];
}

export interface ClaimResolutionContext {
  liveRows: RecommendationRow[];
  clusterCatalog: RecommendationClusterCatalog;
}

export interface ClaimListItem {
  id: string;
  run_slug: string;
  claimed_at: string;
  ttl_hours: number;
  state: 'active' | 'expired' | 'closed-row' | 'orphan';
  age_hours: number;
  target_kind: 'cluster' | 'fingerprint' | 'unknown';
}

const CLAIMS_HEADER = [
  '# _recommendations_claims.yaml',
  '# Ephemeral in-flight coordination for postmortem recommendation drains.',
  '# Durable curation belongs in _recommendations_overrides.yaml; claims do not.',
  '#',
  '# Schema:',
  '#   claims:',
  '#     "<fingerprint-or-cluster_id>":',
  '#       run_slug: "<launcher-assigned-run-slug>"',
  '#       claimed_at: "<ISO-8601 timestamp>"',
  '#       ttl_hours: 48',
  '#',
  `# Default TTL is ${DEFAULT_TTL_HOURS}h; valid ttl_hours is ${MIN_TTL_HOURS}..${MAX_TTL_HOURS}.`,
  '# Active means now < claimed_at + ttl_hours; expiry is automatic and is a warning only.',
  '# Cluster/member union rule: a cluster_id claim blocks all live member fingerprints,',
  '# and a live member fingerprint claim blocks its cluster_id through the live catalog.',
  '# Sibling members are exclusive too: two runs cannot claim two members of the same',
  '# cluster — the cluster ranks as one shortlist unit, so splitting it across runs',
  '# would recreate exactly the collision this file exists to prevent.',
  '# Merge conflict rule: keep the union of different keys; for the same key, keep the',
  '# earlier claimed_at. The losing launcher detects the active foreign claim with list.',
  '# Renewal: the same run_slug may re-claim the same key to refresh claimed_at.',
  '# Launcher-owned protocol: the fleet launcher batch-claims each run assignment in one',
  '# commit at launch. Drains never push claim changes mid-run; normal curation closure',
  '# makes a claim inert, and TTL covers abandoned runs.',
  '',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function parseIsoDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function ttlExpiresAt(claim: RecommendationClaim): Date | null {
  const claimedAt = parseIsoDate(claim.claimed_at);
  if (!claimedAt) return null;
  return new Date(claimedAt.getTime() + claim.ttl_hours * HOUR_MS);
}

export function isClaimActive(claim: RecommendationClaim, now: Date): boolean {
  const expiresAt = ttlExpiresAt(claim);
  return expiresAt !== null && now.getTime() < expiresAt.getTime();
}

export function claimAgeHours(claim: RecommendationClaim, now: Date): number {
  const claimedAt = parseIsoDate(claim.claimed_at);
  if (!claimedAt) return Number.NaN;
  return (now.getTime() - claimedAt.getTime()) / HOUR_MS;
}

export function parseClaimsFile(claimsYaml: string): ParsedClaimsFile {
  const parsed = parseYaml(claimsYaml, { uniqueKeys: true }) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('claims file top-level is not a mapping');
  }
  if (!('claims' in parsed)) {
    throw new Error('claims file has no top-level `claims` key');
  }
  const rawClaims = parsed.claims;
  if (rawClaims !== null && !isRecord(rawClaims)) {
    throw new Error('`claims` is not a mapping');
  }

  const claims: RecommendationClaims = {};
  for (const [id, rawClaim] of Object.entries((rawClaims as Record<string, unknown>) ?? {})) {
    if (!isRecord(rawClaim)) {
      throw new Error(`claim "${id}" value is not a mapping`);
    }
    claims[id] = {
      run_slug: typeof rawClaim.run_slug === 'string' ? rawClaim.run_slug : '',
      claimed_at: typeof rawClaim.claimed_at === 'string' ? rawClaim.claimed_at : '',
      ttl_hours: typeof rawClaim.ttl_hours === 'number' ? rawClaim.ttl_hours : Number.NaN,
    };
  }
  return { claims };
}

export function serializeClaimsFile(claims: RecommendationClaims): string {
  const lines = [...CLAIMS_HEADER, 'claims:'];
  const ids = Object.keys(claims).sort();
  if (ids.length === 0) {
    lines.push('  {}');
    return lines.join('\n') + '\n';
  }
  for (const id of ids) {
    const claim = claims[id]!;
    lines.push(`  ${yamlString(id)}:`);
    lines.push(`    run_slug: ${yamlString(claim.run_slug)}`);
    lines.push(`    claimed_at: ${yamlString(claim.claimed_at)}`);
    lines.push(`    ttl_hours: ${claim.ttl_hours}`);
  }
  return lines.join('\n') + '\n';
}

type ResolvedClaimTarget =
  | {
      kind: 'cluster';
      id: string;
      claimable: boolean;
      liveFingerprints: string[];
      scopeKeys: string[];
      inertReason?: 'closed-row' | 'orphan';
    }
  | {
      kind: 'fingerprint';
      id: string;
      claimable: boolean;
      clusterId: string | null;
      scopeKeys: string[];
      inertReason?: 'closed-row' | 'orphan';
    }
  | {
      kind: 'unknown';
      id: string;
      claimable: false;
      scopeKeys: string[];
      inertReason: 'orphan';
    };

function isLiveQueueRow(row: RecommendationRow): boolean {
  return row.status === 'open' && !row.is_quarantined;
}

function buildRowsByFingerprint(rows: RecommendationRow[]): Map<string, RecommendationRow[]> {
  const out = new Map<string, RecommendationRow[]>();
  for (const row of rows) {
    const existing = out.get(row.fingerprint);
    if (existing) existing.push(row);
    else out.set(row.fingerprint, [row]);
  }
  return out;
}

function resolveClaimTarget(id: string, context: ClaimResolutionContext): ResolvedClaimTarget {
  const catalogClusterIds = new Set(context.clusterCatalog.clusters.map((cluster) => cluster.cluster_id));
  const rowsInCluster = context.liveRows.filter((row) => row.cluster_id === id);
  if (catalogClusterIds.has(id) || rowsInCluster.length > 0) {
    const liveFingerprints = rowsInCluster
      .filter(isLiveQueueRow)
      .map((row) => row.fingerprint)
      .sort();
    if (liveFingerprints.length === 0) {
      return {
        kind: 'cluster',
        id,
        claimable: false,
        liveFingerprints,
        scopeKeys: [],
        inertReason: rowsInCluster.length > 0 || catalogClusterIds.has(id) ? 'closed-row' : 'orphan',
      };
    }
    return {
      kind: 'cluster',
      id,
      claimable: true,
      liveFingerprints,
      scopeKeys: [`cluster:${id}`, ...liveFingerprints.map((fp) => `fingerprint:${fp}`)],
    };
  }

  const rowsByFingerprint = buildRowsByFingerprint(context.liveRows);
  const matchingRows = rowsByFingerprint.get(id) ?? [];
  const liveRows = matchingRows.filter(isLiveQueueRow);
  if (liveRows.length === 0) {
    if (matchingRows.length > 0) {
      return {
        kind: 'fingerprint',
        id,
        claimable: false,
        clusterId: matchingRows[0]?.cluster_id ?? null,
        scopeKeys: [],
        inertReason: 'closed-row',
      };
    }
    return { kind: 'unknown', id, claimable: false, scopeKeys: [], inertReason: 'orphan' };
  }

  const row = liveRows[0]!;
  return {
    kind: 'fingerprint',
    id,
    claimable: true,
    clusterId: row.cluster_id,
    scopeKeys: row.cluster_id ? [`cluster:${row.cluster_id}`, `fingerprint:${id}`] : [`fingerprint:${id}`],
  };
}

function validateClaimShape(id: string, rawClaim: RecommendationClaim, now: Date, errors: ClaimValidationError[]): void {
  if (!RUN_SLUG_RE.test(rawClaim.run_slug)) {
    errors.push({
      id,
      reason: 'invalid-run-slug',
      detail: `claim "${id}" has invalid run_slug ${JSON.stringify(rawClaim.run_slug)}`,
    });
  }
  const claimedAt = parseIsoDate(rawClaim.claimed_at);
  if (!claimedAt) {
    errors.push({
      id,
      reason: 'invalid-claimed-at',
      detail: `claim "${id}" has invalid claimed_at ${JSON.stringify(rawClaim.claimed_at)}`,
    });
  } else if (claimedAt.getTime() > now.getTime() + FUTURE_SKEW_ALLOWANCE_HOURS * HOUR_MS) {
    errors.push({
      id,
      reason: 'future-claimed-at',
      detail: `claim "${id}" claimed_at ${rawClaim.claimed_at} is more than ${FUTURE_SKEW_ALLOWANCE_HOURS}h in the future`,
    });
  }
  if (
    !Number.isInteger(rawClaim.ttl_hours) ||
    rawClaim.ttl_hours < MIN_TTL_HOURS ||
    rawClaim.ttl_hours > MAX_TTL_HOURS
  ) {
    errors.push({
      id,
      reason: 'invalid-ttl-hours',
      detail: `claim "${id}" has invalid ttl_hours ${JSON.stringify(rawClaim.ttl_hours)} (expected ${MIN_TTL_HOURS}..${MAX_TTL_HOURS})`,
    });
  }
}

function collectActiveClaimScopes(
  claims: RecommendationClaims,
  context: ClaimResolutionContext,
  now: Date,
): Array<{ id: string; claim: RecommendationClaim; target: ResolvedClaimTarget; scopeKeys: Set<string> }> {
  const out: Array<{ id: string; claim: RecommendationClaim; target: ResolvedClaimTarget; scopeKeys: Set<string> }> = [];
  for (const [id, claim] of Object.entries(claims)) {
    if (!isClaimActive(claim, now)) continue;
    const target = resolveClaimTarget(id, context);
    if (!target.claimable) continue;
    out.push({ id, claim, target, scopeKeys: new Set(target.scopeKeys) });
  }
  return out;
}

function scopesOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const key of a) {
    if (b.has(key)) return true;
  }
  return false;
}

export function validateClaimsDetailed(
  claimsYaml: string,
  liveRows: RecommendationRow[],
  clusterCatalog: RecommendationClusterCatalog,
  now: Date,
): ClaimValidationResult {
  const errors: ClaimValidationError[] = [];
  const warnings: ClaimValidationWarning[] = [];

  let parsed: unknown;
  try {
    parsed = parseYaml(claimsYaml, { uniqueKeys: true }) as unknown;
  } catch (err) {
    const reason: ClaimValidationErrorReason =
      err instanceof YAMLParseError && /unique/i.test(err.message) ? 'duplicate-key' : 'yaml-parse-error';
    return {
      errors: [
        {
          id: '',
          reason,
          detail: `claims file failed to parse as YAML: ${
            err instanceof Error ? err.message.split('\n')[0] : String(err)
          }`,
        },
      ],
      warnings,
    };
  }

  if (!isRecord(parsed)) {
    return { errors: [{ id: '', reason: 'not-a-mapping', detail: 'claims file top-level is not a mapping' }], warnings };
  }
  if (!('claims' in parsed)) {
    return { errors: [{ id: '', reason: 'no-claims', detail: 'claims file has no top-level `claims` key' }], warnings };
  }
  const rawClaims = parsed.claims;
  if (rawClaims !== null && !isRecord(rawClaims)) {
    return { errors: [{ id: '', reason: 'not-a-mapping', detail: '`claims` is not a mapping' }], warnings };
  }
  for (const key of Object.keys(parsed)) {
    if (key !== 'claims') {
      warnings.push({
        id: key,
        reason: 'unknown-top-level-key',
        detail: `claims file has unknown top-level key "${key}" (only \`claims\` is recognised)`,
      });
    }
  }

  const claims: RecommendationClaims = {};
  const context: ClaimResolutionContext = { liveRows, clusterCatalog };
  for (const [id, rawClaim] of Object.entries((rawClaims as Record<string, unknown>) ?? {})) {
    if (!isRecord(rawClaim)) {
      errors.push({ id, reason: 'not-a-mapping', detail: `claim "${id}" value is not a mapping` });
      continue;
    }
    for (const key of Object.keys(rawClaim)) {
      if (key !== 'run_slug' && key !== 'claimed_at' && key !== 'ttl_hours') {
        errors.push({ id, reason: 'unknown-key', detail: `claim "${id}" has unknown key "${key}"` });
      }
    }
    const claim: RecommendationClaim = {
      run_slug: typeof rawClaim.run_slug === 'string' ? rawClaim.run_slug : '',
      claimed_at: typeof rawClaim.claimed_at === 'string' ? rawClaim.claimed_at : '',
      ttl_hours: typeof rawClaim.ttl_hours === 'number' ? rawClaim.ttl_hours : Number.NaN,
    };
    claims[id] = claim;
    validateClaimShape(id, claim, now, errors);

    const target = resolveClaimTarget(id, context);
    if (target.inertReason === 'orphan') {
      warnings.push({ id, reason: 'orphan-claim', detail: `claim "${id}" does not match a live fingerprint or cluster_id` });
    } else if (target.inertReason === 'closed-row') {
      warnings.push({
        id,
        reason: 'closed-row-claim',
        detail: `claim "${id}" no longer has live open non-quarantined recommendation rows`,
      });
    }
    const expiresAt = ttlExpiresAt(claim);
    if (expiresAt !== null && now.getTime() >= expiresAt.getTime()) {
      warnings.push({
        id,
        reason: 'expired-claim',
        detail: `claim "${id}" expired at ${expiresAt.toISOString()}`,
      });
    }
  }

  const activeScopes = collectActiveClaimScopes(claims, context, now);
  for (let i = 0; i < activeScopes.length; i += 1) {
    for (let j = i + 1; j < activeScopes.length; j += 1) {
      const left = activeScopes[i]!;
      const right = activeScopes[j]!;
      if (scopesOverlap(left.scopeKeys, right.scopeKeys)) {
        errors.push({
          id: left.id,
          reason: 'overlapping-active-claim',
          detail:
            `active claim "${left.id}" (${left.claim.run_slug}) overlaps "${right.id}" ` +
            `(${right.claim.run_slug}) through the live cluster/member catalog`,
        });
      }
    }
  }

  return { errors, warnings };
}

export function describeClaims(
  claims: RecommendationClaims,
  context: ClaimResolutionContext,
  now: Date,
): ClaimListItem[] {
  return Object.entries(claims)
    .map(([id, claim]) => {
      const target = resolveClaimTarget(id, context);
      const expired = !isClaimActive(claim, now);
      const state: ClaimListItem['state'] = expired
        ? 'expired'
        : target.inertReason === 'closed-row'
          ? 'closed-row'
          : target.inertReason === 'orphan'
            ? 'orphan'
            : 'active';
      return {
        id,
        run_slug: claim.run_slug,
        claimed_at: claim.claimed_at,
        ttl_hours: claim.ttl_hours,
        state,
        age_hours: Number(claimAgeHours(claim, now).toFixed(2)),
        target_kind: target.kind,
      };
    })
    .sort((a, b) => {
      const stateCmp = a.state.localeCompare(b.state);
      if (stateCmp !== 0) return stateCmp;
      return a.id.localeCompare(b.id);
    });
}

export function formatClaimsValidationErrors(errors: ClaimValidationError[]): string {
  if (errors.length === 0) return '';
  const lines = [`[recs-claim] FAIL: claims file has ${errors.length} validation error(s).\n`];
  for (const error of errors) {
    lines.push(`  - ${error.reason}: ${error.detail}\n`);
  }
  return lines.join('');
}

export function formatClaimsValidationWarnings(warnings: ClaimValidationWarning[]): string {
  if (warnings.length === 0) return '';
  const lines = [`[recs-claim] WARN: claims file has ${warnings.length} lifecycle warning(s).\n`];
  for (const warning of warnings.slice(0, 20)) {
    lines.push(`  - ${warning.id}: ${warning.reason} (${warning.detail})\n`);
  }
  return lines.join('');
}

function loadClaimsYamlFromPath(claimsPath: string): string {
  if (!fs.existsSync(claimsPath)) {
    return serializeClaimsFile({});
  }
  return fs.readFileSync(claimsPath, 'utf-8');
}

function writeClaimsToPath(claimsPath: string, claims: RecommendationClaims): void {
  fs.mkdirSync(path.dirname(claimsPath), { recursive: true });
  fs.writeFileSync(claimsPath, serializeClaimsFile(claims), 'utf-8');
}

/**
 * Build the resolution context from the live corpus. `read-only` uses the
 * tracker's in-memory check path and never touches the committed generated
 * index on disk (so `list` cannot dirty the working tree as a side effect);
 * `regenerate` rewrites the generated index, which is desirable for the write
 * commands (`claim`/`release`) so the launcher works from a fresh corpus.
 */
function loadDefaultResolutionContext(mode: 'read-only' | 'regenerate'): ClaimResolutionContext {
  const result = runTracker({ check: mode === 'read-only' });
  if (result.exitCode !== 0) {
    throw new Error(`recommendations index ${mode === 'read-only' ? 'build' : 'regeneration'} failed:\n${result.message}`);
  }
  return {
    liveRows: parseExistingIndex(result.generatedYaml).rows,
    clusterCatalog: loadClusterCatalogIfPresent(),
  };
}

function loadContextFromGeneratedIndex(indexPath: string, clusterCatalog: RecommendationClusterCatalog): ClaimResolutionContext {
  const text = fs.readFileSync(indexPath, 'utf-8');
  return { liveRows: parseExistingIndex(text).rows, clusterCatalog };
}

interface ParsedArgs {
  command: 'claim' | 'release' | 'list';
  ids: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0];
  if (command !== 'claim' && command !== 'release' && command !== 'list') {
    throw new Error('usage: recs-claim.ts <claim|release|list> [ids...] [flags]');
  }
  const flags = new Map<string, string | true>();
  const ids: string[] = [];
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      ids.push(arg);
      continue;
    }
    if (arg === '--json' || arg === '--force' || arg === '--stale') {
      flags.set(arg, true);
      continue;
    }
    const value = argv[i + 1];
    if (!value) throw new Error(`${arg} requires a value`);
    flags.set(arg, value);
    i += 1;
  }
  return { command, ids, flags };
}

function stringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} requires a value`);
  return value;
}

function requiredStringFlag(flags: Map<string, string | true>, name: string): string {
  const value = stringFlag(flags, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseNowFlag(flags: Map<string, string | true>): Date {
  const raw = stringFlag(flags, '--now');
  if (!raw) return new Date();
  const parsed = parseIsoDate(raw);
  if (!parsed) throw new Error(`--now must be an ISO timestamp (got ${JSON.stringify(raw)})`);
  return parsed;
}

function parseTtlFlag(flags: Map<string, string | true>): number {
  const raw = stringFlag(flags, '--ttl-hours') ?? stringFlag(flags, '--ttl');
  if (!raw) return DEFAULT_TTL_HOURS;
  const ttl = Number.parseInt(raw, 10);
  if (!Number.isInteger(ttl) || ttl < MIN_TTL_HOURS || ttl > MAX_TTL_HOURS) {
    throw new Error(`ttl must be an integer ${MIN_TTL_HOURS}..${MAX_TTL_HOURS} hours (got ${JSON.stringify(raw)})`);
  }
  return ttl;
}

function resolvePathFlag(flags: Map<string, string | true>, name: string, fallback: string): string {
  const raw = stringFlag(flags, name);
  if (!raw) return fallback;
  return path.isAbsolute(raw) ? raw : path.join(REPO_ROOT, raw);
}

function loadCliContext(
  flags: Map<string, string | true>,
  mode: 'read-only' | 'regenerate',
): ClaimResolutionContext {
  const indexFlag = stringFlag(flags, '--index');
  if (!indexFlag) return loadDefaultResolutionContext(mode);
  const indexPath = path.isAbsolute(indexFlag) ? indexFlag : path.join(REPO_ROOT, indexFlag);
  return loadContextFromGeneratedIndex(indexPath, loadClusterCatalogIfPresent());
}

function formatConflict(
  id: string,
  existingId: string,
  existingClaim: RecommendationClaim,
  now: Date,
  requestingRunSlug: string,
): string {
  const age = claimAgeHours(existingClaim, now).toFixed(1);
  if (existingClaim.run_slug === requestingRunSlug) {
    return (
      `claim "${id}" is already covered by your own active claim "${existingId}" ` +
      `(run ${existingClaim.run_slug}, age ${age}h) — no separate claim is needed`
    );
  }
  return `claim "${id}" conflicts with active claim "${existingId}" by ${existingClaim.run_slug} (age ${age}h)`;
}

function claimIds({
  claims,
  ids,
  runSlug,
  ttlHours,
  now,
  context,
}: {
  claims: RecommendationClaims;
  ids: string[];
  runSlug: string;
  ttlHours: number;
  now: Date;
  context: ClaimResolutionContext;
}): { nextClaims: RecommendationClaims; refusals: string[] } {
  if (!RUN_SLUG_RE.test(runSlug)) {
    return { nextClaims: claims, refusals: [`run slug must match ${RUN_SLUG_RE.source} (got ${JSON.stringify(runSlug)})`] };
  }
  const uniqueIds = [...new Set(ids)];
  const refusals: string[] = [];
  const activeExisting = collectActiveClaimScopes(claims, context, now);
  const requestedScopes: Array<{ id: string; scopeKeys: Set<string> }> = [];

  for (const id of uniqueIds) {
    const target = resolveClaimTarget(id, context);
    if (!target.claimable) {
      refusals.push(`claim "${id}" is not claimable (${target.inertReason})`);
      continue;
    }
    const scopeKeys = new Set(target.scopeKeys);
    for (const requested of requestedScopes) {
      if (scopesOverlap(scopeKeys, requested.scopeKeys)) {
        refusals.push(`claim "${id}" overlaps requested claim "${requested.id}" in the same batch`);
      }
    }
    requestedScopes.push({ id, scopeKeys });

    const sameKeyClaim = claims[id];
    for (const existing of activeExisting) {
      if (existing.id === id && sameKeyClaim?.run_slug === runSlug) continue;
      if (existing.id === id || scopesOverlap(scopeKeys, existing.scopeKeys)) {
        refusals.push(formatConflict(id, existing.id, existing.claim, now, runSlug));
      }
    }
  }

  if (refusals.length > 0) {
    return { nextClaims: claims, refusals };
  }

  const claimedAt = now.toISOString();
  const nextClaims: RecommendationClaims = { ...claims };
  for (const id of uniqueIds) {
    nextClaims[id] = { run_slug: runSlug, claimed_at: claimedAt, ttl_hours: ttlHours };
  }
  return { nextClaims, refusals: [] };
}

function releaseIds({
  claims,
  ids,
  runSlug,
  force,
}: {
  claims: RecommendationClaims;
  ids: string[];
  runSlug: string;
  force: boolean;
}): { nextClaims: RecommendationClaims; refusals: string[]; released: string[] } {
  const nextClaims: RecommendationClaims = { ...claims };
  const refusals: string[] = [];
  const released: string[] = [];
  for (const id of [...new Set(ids)]) {
    const claim = nextClaims[id];
    if (!claim) continue;
    if (!force && claim.run_slug !== runSlug) {
      refusals.push(`claim "${id}" belongs to ${claim.run_slug}, not ${runSlug}`);
      continue;
    }
    delete nextClaims[id];
    released.push(id);
  }
  return refusals.length > 0 ? { nextClaims: claims, refusals, released: [] } : { nextClaims, refusals, released };
}

function formatList(items: ClaimListItem[]): string {
  const lines = ['ID\tState\tRun\tAge(h)\tTTL(h)\tClaimed at'];
  for (const item of items) {
    lines.push(`${item.id}\t${item.state}\t${item.run_slug}\t${item.age_hours}\t${item.ttl_hours}\t${item.claimed_at}`);
  }
  return lines.join('\n') + '\n';
}

export interface RunClaimsCliOptions {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export function runClaimsCli(argv: string[], options: RunClaimsCliOptions = {}): number {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  const parsed = parseArgs(argv);
  const now = parseNowFlag(parsed.flags);
  const claimsPath = resolvePathFlag(parsed.flags, '--claims', CLAIMS_PATH);
  const context = loadCliContext(parsed.flags, parsed.command === 'list' ? 'read-only' : 'regenerate');
  const claimsYaml = loadClaimsYamlFromPath(claimsPath);
  const validation = validateClaimsDetailed(claimsYaml, context.liveRows, context.clusterCatalog, now);
  if (validation.errors.length > 0 && parsed.command !== 'list') {
    stderr(formatClaimsValidationErrors(validation.errors));
    return 1;
  }
  const claims = validation.errors.length > 0 ? {} : parseClaimsFile(claimsYaml).claims;

  switch (parsed.command) {
    case 'claim': {
      if (parsed.ids.length === 0) throw new Error('claim requires at least one id');
      const runSlug = requiredStringFlag(parsed.flags, '--run');
      const ttlHours = parseTtlFlag(parsed.flags);
      const result = claimIds({ claims, ids: parsed.ids, runSlug, ttlHours, now, context });
      if (result.refusals.length > 0) {
        for (const refusal of result.refusals) stderr(`[recs-claim] REFUSED: ${refusal}\n`);
        return 1;
      }
      writeClaimsToPath(claimsPath, result.nextClaims);
      stdout(`[recs-claim] claimed ${new Set(parsed.ids).size} id(s) for ${runSlug}\n`);
      return 0;
    }
    case 'release': {
      if (parsed.ids.length === 0) throw new Error('release requires at least one id');
      const runSlug = requiredStringFlag(parsed.flags, '--run');
      const result = releaseIds({
        claims,
        ids: parsed.ids,
        runSlug,
        force: parsed.flags.get('--force') === true,
      });
      if (result.refusals.length > 0) {
        for (const refusal of result.refusals) stderr(`[recs-claim] REFUSED: ${refusal}\n`);
        return 1;
      }
      writeClaimsToPath(claimsPath, result.nextClaims);
      stdout(`[recs-claim] released ${result.released.length} id(s) for ${runSlug}\n`);
      return 0;
    }
    case 'list': {
      const items = describeClaims(claims, context, now).filter((item) =>
        parsed.flags.get('--stale') === true ? item.state !== 'active' : true,
      );
      if (parsed.flags.get('--json') === true) {
        stdout(`${JSON.stringify({ claims: items, errors: validation.errors, warnings: validation.warnings }, null, 2)}\n`);
      } else {
        stdout(formatList(items));
        stderr(formatClaimsValidationWarnings(validation.warnings));
        stderr(formatClaimsValidationErrors(validation.errors));
      }
      return validation.errors.length > 0 ? 1 : 0;
    }
    default:
      return 1;
  }
}

function main(): number {
  try {
    return runClaimsCli(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`recs-claim: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}
