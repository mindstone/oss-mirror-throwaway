#!/usr/bin/env tsx
/**
 * Validates the R2 Stage 2 AgentEvent consumer-disposition audit file.
 *
 * The bucket allowlist below is the resolved Stage 1.1 taxonomy from
 * `docs/plans/260428_r2_stage1_close_information_needed.md:214-233`:
 * 19 resolved buckets, excluding the `uncertain (manual-audit)` holding state.
 *
 * `NEEDS-NEW-AXIS` is a transitional S2-F1/S2-F2 value: it is accepted so
 * missing manifest axes can surface before Stage 3 cutover, but it emits a
 * warning and contributes to `summary.unresolved`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const PATTERN_KINDS = [
  'stringly-typed-dispatch',
  'registry-lookup',
  'runtime-cast',
  'passthrough',
  'other',
] as const;

export const MANIFEST_IMPACTS = [
  'no-change',
  'derive-via-manifest',
  'runtime-validate',
  'refactor-required',
] as const;

export const TRANSITIONAL_BUCKET = 'NEEDS-NEW-AXIS' as const;
export const HOLDING_BUCKET = 'uncertain (manual-audit)' as const;

export const STAGE_1_1_BUCKET_ALLOWLIST = [
  'eventsByTurn-array-reader',
  'mock-or-test-helper',
  'producer',
  'renderer-ui',
  'eval-adapter',
  'ts-union-reader',
  'fixture-json',
  'cloud-service',
  'cloud-client-direct',
  'mobile-via-cloud-client',
  'web-companion',
  'reducer',
  'false-positive',
  'envelope-AgentTurnEvent',
  'script-or-replay',
  'schema-parser',
  'telemetry-or-exporter',
  'zod-schema-importer',
  'stringly-or-dynamic',
] as const;

export type ValidationSeverity = 'error' | 'warn';

export interface ValidationMessage {
  readonly severity: ValidationSeverity;
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly ValidationMessage[];
  readonly warnings: readonly ValidationMessage[];
}

const SITE_KEYS = [
  'filePath',
  'lineRange',
  'patternKind',
  'bucket',
  'rationale',
  'manifestImpact',
  'blocksStage3a',
] as const;

const OPTIONAL_SITE_KEYS = ['snippet'] as const;
const ALLOWED_SITE_KEYS = [...SITE_KEYS, ...OPTIONAL_SITE_KEYS] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAllowedString<const T extends readonly string[]>(
  value: unknown,
  allowlist: T,
): value is T[number] {
  return typeof value === 'string' && (allowlist as readonly string[]).includes(value);
}

function push(
  messages: ValidationMessage[],
  severity: ValidationSeverity,
  path: string,
  message: string,
): void {
  messages.push({ severity, path, message });
}

function countByBucket(sites: readonly Record<string, unknown>[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const site of sites) {
    const bucket = site.bucket;
    if (typeof bucket !== 'string') continue;
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  return counts;
}

export function validateConsumerDisposition(input: unknown): ValidationResult {
  const messages: ValidationMessage[] = [];

  if (!isRecord(input)) {
    push(messages, 'error', '$', 'Disposition file must be a JSON object.');
    return splitMessages(messages);
  }

  if (input.version !== 1) {
    push(messages, 'error', '$.version', 'Expected version to be the number 1.');
  }
  if (typeof input.auditDate !== 'string' || input.auditDate.length === 0) {
    push(messages, 'error', '$.auditDate', 'Expected non-empty auditDate string.');
  }
  if (typeof input.auditedBy !== 'string' || input.auditedBy.length === 0) {
    push(messages, 'error', '$.auditedBy', 'Expected non-empty auditedBy string.');
  }
  if (!Array.isArray(input.sites)) {
    push(messages, 'error', '$.sites', 'Expected sites to be an array.');
  }
  if (!isRecord(input.summary)) {
    push(messages, 'error', '$.summary', 'Expected summary to be an object.');
  }

  const sites = Array.isArray(input.sites)
    ? input.sites.filter((site): site is Record<string, unknown> => isRecord(site))
    : [];

  if (Array.isArray(input.sites)) {
    input.sites.forEach((site, index) => {
      const sitePath = `$.sites[${index}]`;
      if (!isRecord(site)) {
        push(messages, 'error', sitePath, 'Each site must be an object.');
        return;
      }

      const actualKeys = Object.keys(site);
      for (const key of SITE_KEYS) {
        if (!(key in site)) {
          push(messages, 'error', `${sitePath}.${key}`, `Missing required key "${key}".`);
        }
      }
      for (const key of actualKeys) {
        if (!(ALLOWED_SITE_KEYS as readonly string[]).includes(key)) {
          push(messages, 'error', `${sitePath}.${key}`, `Unexpected key "${key}".`);
        }
      }

      if (typeof site.filePath !== 'string' || site.filePath.length === 0) {
        push(messages, 'error', `${sitePath}.filePath`, 'Expected non-empty string.');
      }

      if (
        !Array.isArray(site.lineRange) ||
        site.lineRange.length !== 2 ||
        !Number.isInteger(site.lineRange[0]) ||
        !Number.isInteger(site.lineRange[1]) ||
        site.lineRange[0] < 1 ||
        site.lineRange[1] < site.lineRange[0]
      ) {
        push(messages, 'error', `${sitePath}.lineRange`, 'Expected [start, end] positive integer range.');
      }

      if (!isAllowedString(site.patternKind, PATTERN_KINDS)) {
        push(messages, 'error', `${sitePath}.patternKind`, `Expected one of: ${PATTERN_KINDS.join(', ')}.`);
      }

      if (site.bucket === TRANSITIONAL_BUCKET) {
        push(messages, 'warn', `${sitePath}.bucket`, 'NEEDS-NEW-AXIS is transitional and must be resolved before S2-F2 completion.');
      } else if (site.bucket === HOLDING_BUCKET) {
        push(messages, 'warn', `${sitePath}.bucket`, 'uncertain (manual-audit) is an unresolved holding state and must be resolved before S2-F2 completion.');
      } else if (!isAllowedString(site.bucket, STAGE_1_1_BUCKET_ALLOWLIST)) {
        push(
          messages,
          'error',
          `${sitePath}.bucket`,
          `Expected Stage 1.1 bucket or ${TRANSITIONAL_BUCKET}.`,
        );
      }

      if (typeof site.rationale !== 'string' || site.rationale.trim().length === 0) {
        push(messages, 'error', `${sitePath}.rationale`, 'Expected non-empty rationale string.');
      }

      if ('snippet' in site && (typeof site.snippet !== 'string' || site.snippet.trim().length === 0)) {
        push(messages, 'error', `${sitePath}.snippet`, 'Expected non-empty snippet string when present.');
      }

      if (!isAllowedString(site.manifestImpact, MANIFEST_IMPACTS)) {
        push(messages, 'error', `${sitePath}.manifestImpact`, `Expected one of: ${MANIFEST_IMPACTS.join(', ')}.`);
      }

      if (typeof site.blocksStage3a !== 'boolean') {
        push(messages, 'error', `${sitePath}.blocksStage3a`, 'Expected boolean.');
      }
    });
  }

  if (isRecord(input.summary)) {
    const summary = input.summary;
    const byBucket = summary.byBucket;
    if (!Number.isInteger(summary.totalSites) || (summary.totalSites as number) < 0) {
      push(messages, 'error', '$.summary.totalSites', 'Expected non-negative integer.');
    } else if (summary.totalSites !== sites.length) {
      push(messages, 'error', '$.summary.totalSites', `Expected ${sites.length}, got ${summary.totalSites}.`);
    }

    if (!isRecord(byBucket)) {
      push(messages, 'error', '$.summary.byBucket', 'Expected object of bucket counts.');
    } else {
      let sum = 0;
      const actualCounts = countByBucket(sites);
      for (const [bucket, value] of Object.entries(byBucket)) {
        if (bucket !== TRANSITIONAL_BUCKET && bucket !== HOLDING_BUCKET && !isAllowedString(bucket, STAGE_1_1_BUCKET_ALLOWLIST)) {
          push(messages, 'error', `$.summary.byBucket.${bucket}`, 'Unknown summary bucket.');
        }
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
          push(messages, 'error', `$.summary.byBucket.${bucket}`, 'Expected non-negative integer count.');
          continue;
        }
        sum += value;
        if ((actualCounts[bucket] ?? 0) !== value) {
          push(messages, 'error', `$.summary.byBucket.${bucket}`, `Expected ${(actualCounts[bucket] ?? 0)}, got ${value}.`);
        }
      }
      for (const [bucket, actualCount] of Object.entries(actualCounts)) {
        if (!(bucket in byBucket)) {
          push(messages, 'error', `$.summary.byBucket.${bucket}`, `Missing count for bucket with ${actualCount} site(s).`);
        }
      }
      if (Number.isInteger(summary.totalSites) && sum !== summary.totalSites) {
        push(messages, 'error', '$.summary.byBucket', `Counts sum to ${sum}, expected ${summary.totalSites}.`);
      }
    }

    const unresolved = sites.filter((site) => site.bucket === TRANSITIONAL_BUCKET || site.bucket === HOLDING_BUCKET).length;
    if (summary.unresolved !== unresolved) {
      push(messages, 'error', '$.summary.unresolved', `Expected ${unresolved}, got ${String(summary.unresolved)}.`);
    }

    const stage3aBlockers = sites.filter((site) => site.blocksStage3a === true).length;
    if (summary.blocksStage3a !== stage3aBlockers) {
      push(messages, 'error', '$.summary.blocksStage3a', `Expected ${stage3aBlockers}, got ${String(summary.blocksStage3a)}.`);
    }
  }

  return splitMessages(messages);
}

function splitMessages(messages: readonly ValidationMessage[]): ValidationResult {
  const errors = messages.filter((message) => message.severity === 'error');
  const warnings = messages.filter((message) => message.severity === 'warn');
  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

export function resolveDefaultDispositionPath(): string {
  return resolve(__dirname, '..', 'src', 'shared', 'contracts', 'consumer-disposition.json');
}

export function runValidation(filePath = resolveDefaultDispositionPath()): ValidationResult {
  if (!existsSync(filePath)) {
    return {
      ok: false,
      errors: [{ severity: 'error', path: filePath, message: 'Disposition file does not exist.' }],
      warnings: [],
    };
  }

  try {
    return validateConsumerDisposition(JSON.parse(readFileSync(filePath, 'utf8')));
  } catch (err) {
    return {
      ok: false,
      errors: [{ severity: 'error', path: filePath, message: `Failed to parse JSON: ${(err as Error).message}` }],
      warnings: [],
    };
  }
}

if (require.main === module) {
  const result = runValidation(process.argv[2]);
  for (const warning of result.warnings) {
    process.stderr.write(`WARN ${warning.path}: ${warning.message}\n`);
  }
  if (!result.ok) {
    for (const error of result.errors) {
      process.stderr.write(`ERROR ${error.path}: ${error.message}\n`);
    }
    process.exit(1);
  }
  process.stdout.write('consumer-disposition.json validated successfully\n');
  process.exit(0);
}
