#!/usr/bin/env npx tsx
/**
 * Postmortem-recommendations tracker — Stage 5 of compile-time-reliability plan.
 *
 * Walks `docs-private/postmortems/*_postmortem.md`, extracts every `[BUG-PREVENTION]`
 * JSON trailer line, and produces (or refreshes) the generated YAML index at
 * `docs-private/postmortems/_index_recommendations.generated.yaml` (gitignored).
 *
 * Reads from postmortem trailer lines of two shapes:
 *
 *   [BUG-PREVENTION]        {"bug_id":"...","action_type":"...","description":"...","priority":"...",...}
 *   [BUG-POSTMORTEM-AUGMENT] {"bug_id":"...","augmented_at":"...","prior_postmortem_recommendations_implemented":...}
 *
 * Manual overrides (the only human-curated state) are stored separately in
 * `docs-private/postmortems/_recommendations_overrides.yaml` (committed).
 * The full generated index is a build artifact (gitignored, regenerate on demand).
 *
 * The overrides file is validated by a sibling gate script
 * (`scripts/check-postmortem-recommendations-parity.ts`), which checks override
 * validity and that every override fingerprint maps to a live recommendation.
 *
 * Default behaviour:
 *   - Regenerates the index on every invocation (without `--check`).
 *   - With `--check`, validates the committed overrides file (strict mode).
 *
 * Status field:
 *   - 'open' (default): no human signal recorded.
 *   - 'implemented' / 'rejected' / 'wont-do' / 'absorbed' /
 *     'blocked-on-signal': hand-curated. **Preserved** across regenerations
 *     via the overrides file keyed by recommendation fingerprint
 *     (bug_id + action_type + description hash).
 *
 * Stale-recommendation reporter (>90 days open) lands as a follow-up; Stage 5
 * scope is the scaffold + parity gate only.
 *
 * To ACT on this index (mine the highest-leverage unimplemented recommendations
 * and ship them), see the process doc:
 *   docs/project/IMPLEMENT_PRIOR_POSTMORTEM_AND_PLAN_RECOMMENDATIONS.md
 * When a recommendation is implemented, mark it via `_recommendations_overrides.yaml`
 * (status: implemented) AND signpost the source postmortem to the planning folder.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parse as parseYaml, YAMLParseError } from 'yaml';

const REPO_ROOT = path.resolve(__dirname, '..');
const POSTMORTEMS_DIR = path.join(REPO_ROOT, 'docs-private/postmortems');
/** Committed source of truth for hand-curated recommendation overrides. */
export const OVERRIDES_PATH = path.join(POSTMORTEMS_DIR, '_recommendations_overrides.yaml');
/** Optional committed metadata catalog for recommendation clusters. */
export const CLUSTERS_PATH = path.join(POSTMORTEMS_DIR, '_recommendations_clusters.yaml');
/** Gitignored build artifact — the full assembled index with all rows. Regenerate on demand. */
export const GENERATED_PATH = path.join(POSTMORTEMS_DIR, '_index_recommendations.generated.yaml');

const BUG_PREVENTION_RE = /^\[BUG-PREVENTION\]\s+(\{.+\})\s*$/gm;
const BUG_POSTMORTEM_RE = /^\[BUG-POSTMORTEM\]\s+(\{.+\})\s*$/m;

export type RecommendationStatus = 'open' | 'implemented' | 'rejected' | 'wont-do' | 'absorbed' | 'blocked-on-signal';
export type RecommendationReasonKind =
  | 'target-gone'
  | 'superseded'
  | 'over-engineering'
  | 'covered-elsewhere'
  | 'other';

export interface RecommendationRow {
  fingerprint: string;
  postmortem: string;
  bug_id: string;
  action_type: string;
  description: string;
  priority: string;
  status: RecommendationStatus;
  first_recorded: string;
  last_revisited: string | null;
  rejection_reason: string | null;
  absorbed_into: string | null;
  revisit_signal: string | null;
  owner: string | null;
  reason_kind: RecommendationReasonKind | null;
  cluster_id: string | null;
  is_quarantined: boolean;
}

export interface ManualOverride {
  status?: RecommendationStatus;
  last_revisited?: string;
  rejection_reason?: string;
  absorbed_into?: string;
  revisit_signal?: string;
  owner?: string;
  reason_kind?: RecommendationReasonKind;
  cluster_id?: string;
}

export interface RecommendationClusterCatalogEntry {
  cluster_id: string;
  title: string;
  canonical_statement: string;
  surface_hint?: string;
}

export interface RecommendationClusterCatalog {
  clusters: RecommendationClusterCatalogEntry[];
}

const EMPTY_CLUSTER_CATALOG: RecommendationClusterCatalog = { clusters: [] };
const CLUSTER_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const CANONICAL_ACTION_TYPES: ReadonlySet<string> = new Set([
  'agent_instructions',
  'eval_fixture',
  'lint_rule',
  'type_constraint',
  'ci_check',
  'test_coverage',
  'review_focus',
  'workflow_improvement',
  'boundary_registry',
  'contract_test',
  'documentation',
  'observability',
]);

const FILENAME_DATE_RE = /^(\d{6})_/;

function extractDateFromFilename(filename: string): string {
  const match = filename.match(FILENAME_DATE_RE);
  if (!match) return '000000';
  return match[1]!;
}

function fingerprintOf(bug_id: string, action_type: string, description: string): string {
  const hash = createHash('sha256').update(`${bug_id}\u0001${action_type}\u0001${description}`).digest('hex');
  return hash.slice(0, 16);
}

function getRequiredString(obj: Record<string, unknown>, key: string, file: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`postmortem ${file}: [BUG-PREVENTION] missing required string field "${key}"`);
  }
  return value;
}

function getOptionalString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  return typeof value === 'string' && value.length > 0 ? value : '';
}

function isQuarantinedActionType(actionType: string): boolean {
  return !CANONICAL_ACTION_TYPES.has(actionType);
}

export interface TrackerWarning {
  filename: string;
  reason:
    | 'unparseable-json'
    | 'not-object'
    | 'missing-action'
    | 'missing-bug-id'
    | 'unknown-override-key'
    | 'cluster-zero-live-members';
  detail: string;
}

type ExtractedRecommendationRow = Omit<
  RecommendationRow,
  | 'status'
  | 'last_revisited'
  | 'rejection_reason'
  | 'absorbed_into'
  | 'revisit_signal'
  | 'owner'
  | 'reason_kind'
  | 'cluster_id'
  | 'is_quarantined'
>;

export function extractRecommendationsFromText(
  text: string,
  filename: string,
  warnings?: TrackerWarning[],
): ExtractedRecommendationRow[] {
  const out: ExtractedRecommendationRow[] = [];
  const dateFromFile = extractDateFromFilename(filename);

  let match: RegExpExecArray | null;
  BUG_PREVENTION_RE.lastIndex = 0;
  while ((match = BUG_PREVENTION_RE.exec(text)) !== null) {
    const jsonText = match[1]!;
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (warnings) {
        warnings.push({ filename, reason: 'unparseable-json', detail });
        continue;
      }
      throw new Error(`postmortem ${filename}: [BUG-PREVENTION] line did not parse as JSON — ${detail}`);
    }
    if (typeof parsed !== 'object' || parsed === null) {
      if (warnings) {
        warnings.push({ filename, reason: 'not-object', detail: 'JSON is not an object' });
        continue;
      }
      throw new Error(`postmortem ${filename}: [BUG-PREVENTION] JSON is not an object`);
    }
    const obj = parsed as Record<string, unknown>;
    const bug_id_value = obj.bug_id;
    if (typeof bug_id_value !== 'string' || bug_id_value.trim().length === 0) {
      if (warnings) {
        warnings.push({ filename, reason: 'missing-bug-id', detail: JSON.stringify(obj).slice(0, 120) });
        continue;
      }
      throw new Error(`postmortem ${filename}: [BUG-PREVENTION] missing required string field "bug_id"`);
    }
    // Accept canonical (action_type + description, post-260515 trawl) OR
    // legacy shape (action + effort, pre-trawl) for backward compatibility
    // with the existing corpus (13 legacy lines as of 2026-05-25).
    const action_type_value = obj.action_type;
    const legacy_action_value = obj.action;
    let action_type: string;
    if (typeof action_type_value === 'string' && action_type_value.length > 0) {
      action_type = action_type_value;
    } else if (typeof legacy_action_value === 'string' && legacy_action_value.length > 0) {
      action_type = legacy_action_value;
    } else {
      if (warnings) {
        warnings.push({ filename, reason: 'missing-action', detail: 'neither action_type nor action present' });
        continue;
      }
      throw new Error(`postmortem ${filename}: [BUG-PREVENTION] missing required string field "action_type"`);
    }
    const description = getOptionalString(obj, 'description') || action_type;
    const bug_id = bug_id_value;
    const priority = getOptionalString(obj, 'priority') || 'unspecified';

    out.push({
      fingerprint: fingerprintOf(bug_id, action_type, description),
      postmortem: filename,
      bug_id,
      action_type,
      description,
      priority,
      first_recorded: dateFromFile,
    });
  }

  // Fallback: if a postmortem has no [BUG-PREVENTION] lines but has a
  // [BUG-POSTMORTEM] trailer, we still surface its bug_id with a synthetic
  // 'no-recommendations' marker so the index covers the full corpus.
  if (out.length === 0) {
    const trailerMatch = text.match(BUG_POSTMORTEM_RE);
    if (trailerMatch) {
      try {
        const trailer = JSON.parse(trailerMatch[1]!);
        if (typeof trailer === 'object' && trailer !== null) {
          const bug_id = (trailer as Record<string, unknown>).bug_id;
          if (typeof bug_id === 'string' && bug_id.trim().length > 0) {
            out.push({
              fingerprint: fingerprintOf(bug_id, 'no-recommendations', ''),
              postmortem: filename,
              bug_id,
              action_type: 'no-recommendations',
              description: '(no [BUG-PREVENTION] trailers in this postmortem)',
              priority: 'n/a',
              first_recorded: dateFromFile,
            });
          }
        }
      } catch {
        // Silently ignore — the upstream validate-new-postmortems script
        // owns the trailer-parseability contract.
      }
    }
  }

  return out;
}

function listPostmortemFiles(): string[] {
  return fs
    .readdirSync(POSTMORTEMS_DIR)
    .filter((f) => f.endsWith('_postmortem.md'))
    .sort();
}

interface ParsedIndex {
  generated_count: number;
  rows: RecommendationRow[];
  manual_overrides: Record<string, ManualOverride>;
}

export function parseExistingIndex(yamlText: string, warnings?: TrackerWarning[]): ParsedIndex {
  const lines = yamlText.split('\n');
  const out: ParsedIndex = { generated_count: 0, rows: [], manual_overrides: {} };
  let mode: 'header' | 'recommendations' | 'clusters' | 'manual_overrides' = 'header';
  let current: Partial<RecommendationRow> | null = null;
  let currentOverride: { key: string; override: Partial<ManualOverride> } | null = null;

  const flushCurrent = () => {
    if (current && current.fingerprint && current.bug_id && current.action_type) {
      out.rows.push({
        fingerprint: current.fingerprint,
        postmortem: current.postmortem ?? '',
        bug_id: current.bug_id,
        action_type: current.action_type,
        description: current.description ?? '',
        priority: current.priority ?? 'unspecified',
        status: (current.status as RecommendationStatus) ?? 'open',
        first_recorded: current.first_recorded ?? '000000',
        last_revisited: current.last_revisited ?? null,
        rejection_reason: current.rejection_reason ?? null,
        absorbed_into: current.absorbed_into ?? null,
        revisit_signal: current.revisit_signal ?? null,
        owner: current.owner ?? null,
        reason_kind: current.reason_kind ?? null,
        cluster_id: current.cluster_id ?? null,
        is_quarantined: current.is_quarantined ?? isQuarantinedActionType(current.action_type),
      });
    }
    current = null;
  };

  const flushOverride = () => {
    if (currentOverride) {
      const override: ManualOverride = {};
      const raw = currentOverride.override;
      if (raw.status !== undefined) override.status = raw.status;
      if (raw.last_revisited !== undefined) override.last_revisited = raw.last_revisited;
      if (raw.rejection_reason !== undefined) override.rejection_reason = raw.rejection_reason;
      if (raw.absorbed_into !== undefined) override.absorbed_into = raw.absorbed_into;
      if (raw.revisit_signal !== undefined) override.revisit_signal = raw.revisit_signal;
      if (raw.owner !== undefined) override.owner = raw.owner;
      if (raw.reason_kind !== undefined) override.reason_kind = raw.reason_kind;
      if (raw.cluster_id !== undefined) override.cluster_id = raw.cluster_id;
      if (Object.keys(override).length > 0) {
        out.manual_overrides[currentOverride.key] = override;
      }
    }
    currentOverride = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    if (line.startsWith('generated_count:')) {
      out.generated_count = Number.parseInt(line.split(':')[1]!.trim(), 10) || 0;
      continue;
    }
    if (line === 'recommendations:') {
      flushCurrent();
      flushOverride();
      mode = 'recommendations';
      continue;
    }
    if (line === 'manual_overrides:') {
      flushCurrent();
      flushOverride();
      mode = 'manual_overrides';
      continue;
    }
    if (line === 'clusters:') {
      flushCurrent();
      flushOverride();
      mode = 'clusters';
      continue;
    }

    if (mode === 'recommendations') {
      if (line.startsWith('  - fingerprint:')) {
        flushCurrent();
        current = { fingerprint: yamlDecode(line.slice('  - fingerprint:'.length).trim()) };
        continue;
      }
      if (!current) continue;
      const stripped = line.replace(/^    /, '');
      const idx = stripped.indexOf(':');
      if (idx === -1) continue;
      const key = stripped.slice(0, idx).trim();
      const value = stripped.slice(idx + 1).trim();
      switch (key) {
        case 'postmortem': current.postmortem = yamlDecode(value); break;
        case 'bug_id': current.bug_id = yamlDecode(value); break;
        case 'action_type': current.action_type = yamlDecode(value); break;
        case 'description': current.description = yamlDecode(value); break;
        case 'priority': current.priority = yamlDecode(value); break;
        case 'status': current.status = yamlDecode(value) as RecommendationStatus; break;
        case 'first_recorded': current.first_recorded = yamlDecode(value); break;
        case 'last_revisited': current.last_revisited = value === 'null' ? null : yamlDecode(value); break;
        case 'rejection_reason': current.rejection_reason = value === 'null' ? null : yamlDecode(value); break;
        case 'absorbed_into': current.absorbed_into = value === 'null' ? null : yamlDecode(value); break;
        case 'revisit_signal': current.revisit_signal = value === 'null' ? null : yamlDecode(value); break;
        case 'owner': current.owner = value === 'null' ? null : yamlDecode(value); break;
        case 'reason_kind': current.reason_kind = value === 'null' ? null : yamlDecode(value) as RecommendationReasonKind; break;
        case 'cluster_id': current.cluster_id = value === 'null' ? null : yamlDecode(value); break;
        case 'is_quarantined': current.is_quarantined = value === 'true'; break;
      }
    } else if (mode === 'manual_overrides') {
      const indented = line.startsWith('  ') ? line.slice(2) : line;
      if (!indented.startsWith(' ')) {
        flushOverride();
        const idx = indented.indexOf(':');
        if (idx === -1) continue;
        const key = indented.slice(0, idx).trim();
        currentOverride = { key: yamlDecode(key), override: {} };
        continue;
      }
      if (!currentOverride) continue;
      const stripped = indented.slice(2);
      const idx = stripped.indexOf(':');
      if (idx === -1) continue;
      const key = stripped.slice(0, idx).trim();
      const value = stripped.slice(idx + 1).trim();
      switch (key) {
        case 'status': currentOverride.override.status = yamlDecode(value) as RecommendationStatus; break;
        case 'last_revisited': currentOverride.override.last_revisited = yamlDecode(value); break;
        case 'rejection_reason': currentOverride.override.rejection_reason = yamlDecode(value); break;
        case 'absorbed_into': currentOverride.override.absorbed_into = yamlDecode(value); break;
        case 'revisit_signal': currentOverride.override.revisit_signal = yamlDecode(value); break;
        case 'owner': currentOverride.override.owner = yamlDecode(value); break;
        case 'reason_kind': currentOverride.override.reason_kind = yamlDecode(value) as RecommendationReasonKind; break;
        case 'cluster_id': currentOverride.override.cluster_id = yamlDecode(value); break;
        default:
          warnings?.push({
            filename: '_recommendations_overrides.yaml',
            reason: 'unknown-override-key',
            detail: `ignored unknown manual_overrides key "${key}" on ${currentOverride.key}`,
          });
          break;
      }
    }
  }
  flushCurrent();
  flushOverride();
  return out;
}

function yamlEncode(value: string): string {
  if (value === '') return "''";
  if (/^[A-Za-z0-9_./:\-]+$/.test(value) && !/^(true|false|null|yes|no|on|off)$/i.test(value) && !/^-?\d/.test(value)) {
    return value;
  }
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function yamlDecode(value: string): string {
  if (value === "''") return '';
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return value;
}

interface GeneratedSummary {
  statusCounts: Record<RecommendationStatus, number>;
  liveQueueCount: number;
  quarantinedCount: number;
}

function calculateSummary(rows: RecommendationRow[]): GeneratedSummary {
  const statusCounts = Object.fromEntries([...VALID_STATUSES].map((status) => [status, 0])) as Record<
    RecommendationStatus,
    number
  >;
  let liveQueueCount = 0;
  let quarantinedCount = 0;
  for (const row of rows) {
    statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
    if (row.is_quarantined) quarantinedCount += 1;
    if (row.status === 'open' && !row.is_quarantined) liveQueueCount += 1;
  }
  return { statusCounts, liveQueueCount, quarantinedCount };
}

function groupedClusterMembers(
  rows: RecommendationRow[],
  clusterCatalog: RecommendationClusterCatalog,
): Array<RecommendationClusterCatalogEntry & { fingerprints: string[]; member_count: number; live_member_count: number }> {
  const rowsByCluster = new Map<string, RecommendationRow[]>();
  for (const row of rows) {
    if (!row.cluster_id) continue;
    const existing = rowsByCluster.get(row.cluster_id);
    if (existing) existing.push(row);
    else rowsByCluster.set(row.cluster_id, [row]);
  }

  return clusterCatalog.clusters.map((cluster) => {
    const members = [...(rowsByCluster.get(cluster.cluster_id) ?? [])].sort((a, b) =>
      a.fingerprint.localeCompare(b.fingerprint),
    );
    return {
      ...cluster,
      fingerprints: members.map((row) => row.fingerprint),
      member_count: members.length,
      live_member_count: members.filter((row) => row.status === 'open' && !row.is_quarantined).length,
    };
  });
}

export function generateIndexYaml(
  rows: RecommendationRow[],
  manualOverrides: Record<string, ManualOverride>,
  clusterCatalog: RecommendationClusterCatalog = EMPTY_CLUSTER_CATALOG,
): string {
  const sortedRows = [...rows].sort((a, b) => {
    const dateCmp = b.first_recorded.localeCompare(a.first_recorded);
    if (dateCmp !== 0) return dateCmp;
    const bugCmp = a.bug_id.localeCompare(b.bug_id);
    if (bugCmp !== 0) return bugCmp;
    return a.fingerprint.localeCompare(b.fingerprint);
  });
  const sortedOverrideKeys = Object.keys(manualOverrides).sort();
  const summary = calculateSummary(sortedRows);
  const clusterMembers = groupedClusterMembers(sortedRows, clusterCatalog);

  const lines: string[] = [
    '# Postmortem recommendations index — auto-generated by',
    '# scripts/postmortem-recommendations-tracker.ts. DO NOT EDIT BY HAND.',
    '#',
    '# To curate the status of a recommendation, add a manual override under',
    '# `manual_overrides` keyed by the recommendation fingerprint. Manual',
    '# overrides survive regeneration; the status, curation metadata, cluster,',
    '# and quarantine fields under `recommendations` are derived (do not',
    '# edit those directly).',
    '#',
    '# Regenerate: `npx tsx scripts/postmortem-recommendations-tracker.ts`',
    '# Verify lockstep: `npx tsx scripts/check-postmortem-recommendations-parity.ts`',
    `generated_count: ${sortedRows.length}`,
  ];
  lines.push('summary:');
  lines.push('  status_counts:');
  for (const status of VALID_STATUSES) {
    lines.push(`    ${yamlEncode(status)}: ${summary.statusCounts[status as RecommendationStatus] ?? 0}`);
  }
  lines.push(`  live_queue_count: ${summary.liveQueueCount}`);
  lines.push(`  quarantined_count: ${summary.quarantinedCount}`);
  lines.push('clusters:');
  if (clusterMembers.length === 0) {
    lines.push('  []');
  } else {
    for (const cluster of clusterMembers) {
      lines.push(`  - cluster_id: ${yamlEncode(cluster.cluster_id)}`);
      lines.push(`    title: ${yamlEncode(cluster.title)}`);
      lines.push(`    canonical_statement: ${yamlEncode(cluster.canonical_statement)}`);
      lines.push(`    surface_hint: ${cluster.surface_hint ? yamlEncode(cluster.surface_hint) : 'null'}`);
      lines.push(`    member_count: ${cluster.member_count}`);
      lines.push(`    live_member_count: ${cluster.live_member_count}`);
      lines.push('    fingerprints:');
      if (cluster.fingerprints.length === 0) {
        lines.push('      []');
      } else {
        for (const fp of cluster.fingerprints) {
          lines.push(`      - ${yamlEncode(fp)}`);
        }
      }
    }
  }
  lines.push('recommendations:');

  for (const row of sortedRows) {
    lines.push(`  - fingerprint: ${yamlEncode(row.fingerprint)}`);
    lines.push(`    postmortem: ${yamlEncode(row.postmortem)}`);
    lines.push(`    bug_id: ${yamlEncode(row.bug_id)}`);
    lines.push(`    action_type: ${yamlEncode(row.action_type)}`);
    lines.push(`    description: ${yamlEncode(row.description)}`);
    lines.push(`    priority: ${yamlEncode(row.priority)}`);
    lines.push(`    status: ${yamlEncode(row.status)}`);
    lines.push(`    first_recorded: ${yamlEncode(row.first_recorded)}`);
    lines.push(`    last_revisited: ${row.last_revisited === null ? 'null' : yamlEncode(row.last_revisited)}`);
    lines.push(`    rejection_reason: ${row.rejection_reason === null ? 'null' : yamlEncode(row.rejection_reason)}`);
    lines.push(`    absorbed_into: ${row.absorbed_into === null ? 'null' : yamlEncode(row.absorbed_into)}`);
    lines.push(`    revisit_signal: ${row.revisit_signal === null ? 'null' : yamlEncode(row.revisit_signal)}`);
    lines.push(`    owner: ${row.owner === null ? 'null' : yamlEncode(row.owner)}`);
    lines.push(`    reason_kind: ${row.reason_kind === null ? 'null' : yamlEncode(row.reason_kind)}`);
    lines.push(`    cluster_id: ${row.cluster_id === null ? 'null' : yamlEncode(row.cluster_id)}`);
    lines.push(`    is_quarantined: ${row.is_quarantined ? 'true' : 'false'}`);
  }

  lines.push('manual_overrides:');
  if (sortedOverrideKeys.length === 0) {
    lines.push('  {}');
  } else {
    for (const key of sortedOverrideKeys) {
      const override = manualOverrides[key]!;
      lines.push(`  ${yamlEncode(key)}:`);
      if (override.status) {
        lines.push(`    status: ${yamlEncode(override.status)}`);
      }
      if (override.last_revisited) {
        lines.push(`    last_revisited: ${yamlEncode(override.last_revisited)}`);
      }
      if (override.rejection_reason) {
        lines.push(`    rejection_reason: ${yamlEncode(override.rejection_reason)}`);
      }
      if (override.absorbed_into) {
        lines.push(`    absorbed_into: ${yamlEncode(override.absorbed_into)}`);
      }
      if (override.revisit_signal) {
        lines.push(`    revisit_signal: ${yamlEncode(override.revisit_signal)}`);
      }
      if (override.owner) {
        lines.push(`    owner: ${yamlEncode(override.owner)}`);
      }
      if (override.reason_kind) {
        lines.push(`    reason_kind: ${yamlEncode(override.reason_kind)}`);
      }
      if (override.cluster_id) {
        lines.push(`    cluster_id: ${yamlEncode(override.cluster_id)}`);
      }
    }
  }

  return lines.join('\n') + '\n';
}

export function buildIndex(
  manualOverrides: Record<string, ManualOverride>,
  postmortemFiles?: string[],
  warnings?: TrackerWarning[],
): RecommendationRow[] {
  const files = postmortemFiles ?? listPostmortemFiles();
  const out: RecommendationRow[] = [];
  for (const filename of files) {
    const abs = path.join(POSTMORTEMS_DIR, filename);
    const text = fs.readFileSync(abs, 'utf-8');
    const extracted = extractRecommendationsFromText(text, filename, warnings);
    for (const row of extracted) {
      const override = manualOverrides[row.fingerprint];
      out.push({
        ...row,
        status: override?.status ?? 'open',
        last_revisited: override?.last_revisited ?? null,
        rejection_reason: override?.rejection_reason ?? null,
        absorbed_into: override?.absorbed_into ?? null,
        revisit_signal: override?.revisit_signal ?? null,
        owner: override?.owner ?? null,
        reason_kind: override?.reason_kind ?? null,
        cluster_id: override?.cluster_id ?? null,
        is_quarantined: isQuarantinedActionType(row.action_type),
      });
    }
  }
  return out;
}

export type OverrideValidationErrorReason =
  | 'yaml-parse-error'
  | 'no-manual-overrides'
  | 'not-a-mapping'
  | 'invalid-status'
  | 'missing-status'
  | 'missing-last-revisited'
  | 'invalid-last-revisited'
  | 'missing-rejection-reason'
  | 'missing-absorbed-into'
  | 'missing-revisit-signal'
  | 'invalid-owner'
  | 'invalid-reason-kind'
  | 'invalid-cluster-id'
  | 'unknown-cluster-id'
  | 'orphan-fingerprint'
  | 'ambiguous-fingerprint'
  | 'duplicate-key';

export interface OverrideValidationError {
  /** Fingerprint key; empty string for whole-file errors (parse / structure). */
  fingerprint: string;
  reason: OverrideValidationErrorReason;
  detail: string;
  /** Context comment from the overrides file (bug_id · action_type · description) if available */
  context?: string;
}

export interface OverrideValidationWarning {
  /** Fingerprint key; empty string for whole-file warnings. */
  fingerprint: string;
  reason: 'unknown-override-key' | 'cluster-zero-live-members';
  detail: string;
  context?: string;
}

export interface OverrideValidationResult {
  errors: OverrideValidationError[];
  warnings: OverrideValidationWarning[];
}

const VALID_STATUSES: ReadonlySet<string> = new Set([
  'open',
  'implemented',
  'rejected',
  'wont-do',
  'absorbed',
  'blocked-on-signal',
]);
const REASON_REQUIRED_STATUSES: ReadonlySet<string> = new Set(['rejected', 'wont-do']);
const VALID_REASON_KINDS: ReadonlySet<string> = new Set([
  'target-gone',
  'superseded',
  'over-engineering',
  'covered-elsewhere',
  'other',
]);
const KNOWN_OVERRIDE_KEYS: ReadonlySet<string> = new Set([
  'status',
  'last_revisited',
  'rejection_reason',
  'absorbed_into',
  'revisit_signal',
  'owner',
  'reason_kind',
  'cluster_id',
]);
const LAST_REVISITED_RE = /^\d{6}$/;

/**
 * Best-effort map of fingerprint -> context comment, scanned from the raw text.
 * Used ONLY to enrich error messages (the human-readable `# bug_id · action_type · …`
 * comment that sits above each entry). Validation never depends on this — it runs
 * off the real-YAML-parsed object below. A real YAML parser strips comments, so we
 * recover them with a tolerant line scan keyed by the quoted/bare fingerprint.
 */
function scanContextComments(overridesYaml: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = overridesYaml.split('\n');
  let pendingComment: string | null = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      pendingComment = trimmed.slice(1).trim();
      continue;
    }
    if (!trimmed) continue;
    // A 2-space-indented key line: `  "fp":` or `  fp:`
    const m = line.match(/^ {2}("?)([^":]+)\1\s*:\s*$/);
    if (m && pendingComment) {
      out.set(m[2]!.trim(), pendingComment);
    }
    pendingComment = null;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireClusterString(value: Record<string, unknown>, key: string, clusterLabel: string): string {
  const raw = value[key];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(`${clusterLabel} missing required non-empty string field "${key}"`);
  }
  return raw;
}

export function parseClusterCatalog(yamlText: string): RecommendationClusterCatalog {
  const parsed = parseYaml(yamlText, { uniqueKeys: true });
  if (!isRecord(parsed)) {
    throw new Error('cluster catalog top-level is not a mapping');
  }
  const clusters = parsed.clusters;
  if (!Array.isArray(clusters)) {
    throw new Error('cluster catalog must have a top-level clusters array');
  }

  const seen = new Set<string>();
  return {
    clusters: clusters.map((cluster, index) => {
      const label = `clusters[${index}]`;
      if (!isRecord(cluster)) {
        throw new Error(`${label} is not a mapping`);
      }
      const cluster_id = requireClusterString(cluster, 'cluster_id', label);
      if (!CLUSTER_ID_RE.test(cluster_id)) {
        throw new Error(`${label}.cluster_id must be a kebab slug`);
      }
      if (seen.has(cluster_id)) {
        throw new Error(`duplicate cluster_id "${cluster_id}"`);
      }
      seen.add(cluster_id);
      const title = requireClusterString(cluster, 'title', label);
      const canonical_statement = requireClusterString(cluster, 'canonical_statement', label);
      const surface_hint = cluster.surface_hint;
      if (surface_hint !== undefined && (typeof surface_hint !== 'string' || surface_hint.trim().length === 0)) {
        throw new Error(`${label}.surface_hint must be a non-empty string when present`);
      }
      return {
        cluster_id,
        title,
        canonical_statement,
        ...(typeof surface_hint === 'string' ? { surface_hint } : {}),
      };
    }),
  };
}

export function loadClusterCatalogIfPresent(): RecommendationClusterCatalog {
  if (!fs.existsSync(CLUSTERS_PATH)) {
    return EMPTY_CLUSTER_CATALOG;
  }
  try {
    return parseClusterCatalog(fs.readFileSync(CLUSTERS_PATH, 'utf-8'));
  } catch (err) {
    throw new Error(
      `${path.relative(REPO_ROOT, CLUSTERS_PATH)} is invalid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Strict-mode overrides validation. Called by the gate (check mode).
 *
 * Parses the overrides file with a REAL YAML parser (`yaml`, with `uniqueKeys`)
 * so syntax errors and duplicate keys are rejected by construction — there is NO
 * tolerant line-scan in the validation path. Malformed input FAILS; it cannot
 * silently disappear from the parsed model.
 *
 * Schema (per accepted plan):
 *   - file must parse as YAML and have a top-level `manual_overrides` MAPPING;
 *   - each status override: `status` ∈ VALID_STATUSES plus `last_revisited`
 *     REQUIRED, valid YYMMDD;
 *   - curation-only cluster entries may omit status when `cluster_id` is present;
 *   - rejected/wont-do REQUIRE a non-empty `rejection_reason`;
 *   - absorbed REQUIRES `absorbed_into`; blocked-on-signal REQUIRES
 *     `revisit_signal`;
 *   - every fingerprint maps to exactly ONE live recommendation (0 = orphan, >1 = ambiguous).
 *
 * @param overridesYaml - raw text of _recommendations_overrides.yaml
 * @param liveRows - freshly-regenerated corpus rows (for orphan check)
 * @returns validation errors plus non-fatal warnings (empty errors = valid)
 */
export function validateOverridesDetailed(
  overridesYaml: string,
  liveRows: RecommendationRow[],
  clusterCatalog: RecommendationClusterCatalog = EMPTY_CLUSTER_CATALOG,
): OverrideValidationResult {
  const errors: OverrideValidationError[] = [];
  const warnings: OverrideValidationWarning[] = [];
  const contextByFp = scanContextComments(overridesYaml);
  const ctx = (fp: string): string | undefined => contextByFp.get(fp);
  const catalogClusterIds = new Set(clusterCatalog.clusters.map((cluster) => cluster.cluster_id));

  // (a) Real-YAML parse — rejects syntax errors AND duplicate keys by construction.
  let parsed: unknown;
  try {
    parsed = parseYaml(overridesYaml, { uniqueKeys: true });
  } catch (err) {
    const reason: OverrideValidationErrorReason =
      err instanceof YAMLParseError && /unique/i.test(err.message) ? 'duplicate-key' : 'yaml-parse-error';
    errors.push({
      fingerprint: '',
      reason,
      detail: `overrides file failed to parse as YAML: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
    });
    return { errors, warnings }; // cannot proceed without a parse tree
  }

  // (b) Structure: top-level `manual_overrides` must be a mapping.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push({
      fingerprint: '',
      reason: 'not-a-mapping',
      detail: 'overrides file top-level is not a mapping',
    });
    return { errors, warnings };
  }
  const root = parsed as Record<string, unknown>;
  if (!('manual_overrides' in root)) {
    errors.push({
      fingerprint: '',
      reason: 'no-manual-overrides',
      detail: 'overrides file has no top-level `manual_overrides` key',
    });
    return { errors, warnings };
  }
  const mo = root.manual_overrides;
  // An empty mapping (`manual_overrides:` with no entries) parses as null — treat as
  // a valid-but-empty set. A non-null non-object value is a structure error.
  if (mo !== null && (typeof mo !== 'object' || Array.isArray(mo))) {
    errors.push({
      fingerprint: '',
      reason: 'not-a-mapping',
      detail: '`manual_overrides` is not a mapping',
    });
    return { errors, warnings };
  }
  const overrides: Record<string, unknown> = (mo as Record<string, unknown>) ?? {};

  // Build fingerprint -> [rows] lookup (for orphan + ambiguous checks)
  const rowsByFp = new Map<string, RecommendationRow[]>();
  for (const row of liveRows) {
    const existing = rowsByFp.get(row.fingerprint);
    if (existing) existing.push(row);
    else rowsByFp.set(row.fingerprint, [row]);
  }
  const liveMembersByCluster = new Map<string, number>();
  for (const row of liveRows) {
    if (!row.cluster_id || row.status !== 'open' || row.is_quarantined) continue;
    liveMembersByCluster.set(row.cluster_id, (liveMembersByCluster.get(row.cluster_id) ?? 0) + 1);
  }

  // (c) Per-entry schema + orphan/ambiguous checks.
  for (const [fp, rawEntry] of Object.entries(overrides)) {
    if (rawEntry === null || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      errors.push({
        fingerprint: fp,
        reason: 'not-a-mapping',
        detail: `override "${fp}" value is not a mapping`,
        context: ctx(fp),
      });
      continue;
    }
    const entry = rawEntry as Record<string, unknown>;
    const status = entry.status;
    const clusterId = entry.cluster_id;

    for (const key of Object.keys(entry)) {
      if (!KNOWN_OVERRIDE_KEYS.has(key)) {
        warnings.push({
          fingerprint: fp,
          reason: 'unknown-override-key',
          detail: `override "${fp}" has unknown key "${key}" (ignored by the loader)`,
          context: ctx(fp),
        });
      }
    }

    if (status === undefined || status === null) {
      if (typeof clusterId !== 'string' || clusterId.trim().length === 0) {
        errors.push({
          fingerprint: fp,
          reason: 'missing-status',
          detail: `override "${fp}" has no status field; statusless entries must carry cluster_id`,
          context: ctx(fp),
        });
      }
    } else if (typeof status !== 'string' || !VALID_STATUSES.has(status)) {
      errors.push({
        fingerprint: fp,
        reason: 'invalid-status',
        detail: `override "${fp}" has invalid status ${JSON.stringify(status)} (allowed: ${[...VALID_STATUSES].join('|')})`,
        context: ctx(fp),
      });
    }

    // last_revisited REQUIRED + valid YYMMDD for actual status overrides.
    const lastRevisited = entry.last_revisited;
    if (typeof status === 'string') {
      if (lastRevisited === undefined || lastRevisited === null || lastRevisited === '') {
        errors.push({
          fingerprint: fp,
          reason: 'missing-last-revisited',
          detail: `override "${fp}" is missing required last_revisited (YYMMDD)`,
          context: ctx(fp),
        });
      } else if (typeof lastRevisited !== 'string' || !LAST_REVISITED_RE.test(lastRevisited)) {
        errors.push({
          fingerprint: fp,
          reason: 'invalid-last-revisited',
          detail: `override "${fp}" has invalid last_revisited ${JSON.stringify(lastRevisited)} (expected YYMMDD)`,
          context: ctx(fp),
        });
      }
    } else if (lastRevisited !== undefined && (typeof lastRevisited !== 'string' || !LAST_REVISITED_RE.test(lastRevisited))) {
      errors.push({
        fingerprint: fp,
        reason: 'invalid-last-revisited',
        detail: `override "${fp}" has invalid last_revisited ${JSON.stringify(lastRevisited)} (expected YYMMDD)`,
        context: ctx(fp),
      });
    }

    // rejected / wont-do REQUIRE a non-empty rejection_reason.
    if (typeof status === 'string' && REASON_REQUIRED_STATUSES.has(status)) {
      const reason = entry.rejection_reason;
      if (typeof reason !== 'string' || reason.trim().length === 0) {
        errors.push({
          fingerprint: fp,
          reason: 'missing-rejection-reason',
          detail: `override "${fp}" has status "${status}" but no non-empty rejection_reason`,
          context: ctx(fp),
        });
      }
    }

    if (status === 'absorbed') {
      const absorbedInto = entry.absorbed_into;
      if (typeof absorbedInto !== 'string' || absorbedInto.trim().length === 0) {
        errors.push({
          fingerprint: fp,
          reason: 'missing-absorbed-into',
          detail: `override "${fp}" has status "absorbed" but no non-empty absorbed_into`,
          context: ctx(fp),
        });
      }
    }

    if (status === 'blocked-on-signal') {
      const revisitSignal = entry.revisit_signal;
      if (typeof revisitSignal !== 'string' || revisitSignal.trim().length === 0) {
        errors.push({
          fingerprint: fp,
          reason: 'missing-revisit-signal',
          detail: `override "${fp}" has status "blocked-on-signal" but no non-empty revisit_signal`,
          context: ctx(fp),
        });
      }
    }

    if (entry.owner !== undefined && status !== 'blocked-on-signal') {
      errors.push({
        fingerprint: fp,
        reason: 'invalid-owner',
        detail: `override "${fp}" has owner but status is not "blocked-on-signal"`,
        context: ctx(fp),
      });
    }

    const reasonKind = entry.reason_kind;
    if (reasonKind !== undefined) {
      if (typeof reasonKind !== 'string' || !VALID_REASON_KINDS.has(reasonKind)) {
        errors.push({
          fingerprint: fp,
          reason: 'invalid-reason-kind',
          detail: `override "${fp}" has invalid reason_kind ${JSON.stringify(reasonKind)} (allowed: ${[...VALID_REASON_KINDS].join('|')})`,
          context: ctx(fp),
        });
      } else if (status !== 'rejected' && status !== 'wont-do') {
        errors.push({
          fingerprint: fp,
          reason: 'invalid-reason-kind',
          detail: `override "${fp}" has reason_kind but status is not rejected/wont-do`,
          context: ctx(fp),
        });
      }
    }

    if (clusterId !== undefined) {
      if (typeof clusterId !== 'string' || !CLUSTER_ID_RE.test(clusterId)) {
        errors.push({
          fingerprint: fp,
          reason: 'invalid-cluster-id',
          detail: `override "${fp}" has invalid cluster_id ${JSON.stringify(clusterId)} (expected kebab slug)`,
          context: ctx(fp),
        });
      } else if (!catalogClusterIds.has(clusterId)) {
        errors.push({
          fingerprint: fp,
          reason: 'unknown-cluster-id',
          detail: `override "${fp}" references cluster_id "${clusterId}" but it is not in ${path.relative(REPO_ROOT, CLUSTERS_PATH)}`,
          context: ctx(fp),
        });
      }
    }

    // Orphan / ambiguous fingerprint check.
    const matchingRows = rowsByFp.get(fp);
    if (!matchingRows || matchingRows.length === 0) {
      errors.push({
        fingerprint: fp,
        reason: 'orphan-fingerprint',
        detail: `override "${fp}" has no matching recommendation in the live corpus`,
        context: ctx(fp),
      });
    } else if (matchingRows.length > 1) {
      errors.push({
        fingerprint: fp,
        reason: 'ambiguous-fingerprint',
        detail: `override "${fp}" matches ${matchingRows.length} rows in the corpus (fingerprint collision)`,
        context: ctx(fp),
      });
    }
  }

  for (const cluster of clusterCatalog.clusters) {
    if ((liveMembersByCluster.get(cluster.cluster_id) ?? 0) === 0) {
      warnings.push({
        fingerprint: '',
        reason: 'cluster-zero-live-members',
        detail: `cluster "${cluster.cluster_id}" has zero live open non-quarantined members`,
      });
    }
  }

  return { errors, warnings };
}

export function validateOverrides(
  overridesYaml: string,
  liveRows: RecommendationRow[],
  clusterCatalog: RecommendationClusterCatalog = EMPTY_CLUSTER_CATALOG,
): OverrideValidationError[] {
  return validateOverridesDetailed(overridesYaml, liveRows, clusterCatalog).errors;
}

interface MainResult {
  exitCode: number;
  message: string;
  generatedYaml: string;
  rowCount: number;
  warnings: TrackerWarning[];
}

export function runTracker({ check }: { check: boolean }): MainResult {
  // Read overrides ONLY from the committed overrides-only file (OVERRIDES_PATH).
  // The old combined `_index_recommendations.yaml` was `git rm`'d; we never fall
  // back to it (a stale local copy must NOT silently become the source of truth).
  // Absence is fail-loud in both modes.
  if (!fs.existsSync(OVERRIDES_PATH)) {
    return {
      exitCode: 1,
      message:
        `[postmortem-recommendations-tracker] FAIL: overrides file not found at ${path.relative(REPO_ROOT, OVERRIDES_PATH)}.\n` +
        `  This file is the committed source of truth and must exist. (The old _index_recommendations.yaml was removed.)\n`,
      generatedYaml: '',
      rowCount: 0,
      warnings: [],
    };
  }
  const overridesYaml = fs.readFileSync(OVERRIDES_PATH, 'utf-8');
  const warnings: TrackerWarning[] = [];
  let clusterCatalog: RecommendationClusterCatalog;
  try {
    clusterCatalog = loadClusterCatalogIfPresent();
  } catch (err) {
    return {
      exitCode: 1,
      message: `[postmortem-recommendations-tracker] FAIL: ${err instanceof Error ? err.message : String(err)}\n`,
      generatedYaml: '',
      rowCount: 0,
      warnings,
    };
  }
  const existingOverrides: Record<string, ManualOverride> =
    parseExistingIndex(overridesYaml, warnings).manual_overrides;

  const rows = buildIndex(existingOverrides, undefined, warnings);
  const newYaml = generateIndexYaml(rows, existingOverrides, clusterCatalog);

  if (check) {
    // Strict overrides-validity gate (replaces byte-exact full-file compare).
    // Must pass on a fresh CI checkout where GENERATED_PATH does NOT exist.
    const validationResult = validateOverridesDetailed(overridesYaml, rows, clusterCatalog);
    for (const warning of validationResult.warnings) {
      warnings.push({
        filename: warning.fingerprint || '_recommendations_clusters.yaml',
        reason: warning.reason,
        detail: warning.detail,
      });
    }
    if (validationResult.errors.length === 0) {
      return { exitCode: 0, message: 'OK', generatedYaml: newYaml, rowCount: rows.length, warnings };
    }

    const errLines: string[] = [
      `[postmortem-recommendations-tracker] FAIL: overrides file has ${validationResult.errors.length} validation error(s).\n`,
    ];
    for (const e of validationResult.errors) {
      const ctx = e.context ? ` [${e.context}]` : '';
      errLines.push(`  - ${e.reason}: ${e.detail}${ctx}\n`);
    }
    errLines.push(`  To fix: edit ${path.relative(REPO_ROOT, OVERRIDES_PATH)}\n`);

    return {
      exitCode: 1,
      message: errLines.join(''),
      generatedYaml: newYaml,
      rowCount: rows.length,
      warnings,
    };
  }

  fs.writeFileSync(GENERATED_PATH, newYaml, 'utf-8');
  return {
    exitCode: 0,
    message: `[postmortem-recommendations-tracker] Wrote ${rows.length} recommendation row(s) to ${path.relative(REPO_ROOT, GENERATED_PATH)}.\n`,
    generatedYaml: newYaml,
    rowCount: rows.length,
    warnings,
  };
}

export function formatTrackerWarnings(warnings: TrackerWarning[]): string {
  if (warnings.length === 0) return '';
  const unknownOverrideWarnings = warnings.filter((warning) => warning.reason === 'unknown-override-key');
  const otherWarnings = warnings.filter((warning) => warning.reason !== 'unknown-override-key');
  const lines = [`[postmortem-recommendations-tracker] WARN: ${warnings.length} warning(s).\n`];

  if (unknownOverrideWarnings.length > 0) {
    lines.push(`Unknown override keys (${unknownOverrideWarnings.length}) — all shown:\n`);
    for (const w of unknownOverrideWarnings) {
      lines.push(`  - ${w.filename}: ${w.reason} (${w.detail.slice(0, 160)})\n`);
    }
  }

  if (otherWarnings.length > 0) {
    lines.push(`Other warnings (${otherWarnings.length}). Showing first 10:\n`);
  }
  for (const w of otherWarnings.slice(0, 10)) {
    lines.push(`  - ${w.filename}: ${w.reason} (${w.detail.slice(0, 160)})\n`);
  }
  return lines.join('');
}

function main(): number {
  const check = process.argv.includes('--check');
  const result = runTracker({ check });
  if (result.exitCode === 0 && !check) {
    process.stdout.write(result.message);
  } else if (result.exitCode !== 0) {
    process.stderr.write(result.message);
  }
  if (result.warnings.length > 0) {
    process.stderr.write(formatTrackerWarnings(result.warnings));
  }
  return result.exitCode;
}

if (require.main === module) {
  process.exit(main());
}
