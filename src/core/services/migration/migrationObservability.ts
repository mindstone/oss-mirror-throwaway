import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getErrorReporter, type ErrorReporterEventScope } from '@core/errorReporter';
import { createScopedLogger } from '@core/logger';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { redactSensitiveString, REDACTED_TEXT } from '@shared/utils/sentryRedaction';
import { isSensitiveKeyName } from '@shared/utils/redactionPatterns';
import type { MigrationBundleManifest } from './migrationManifest';

export type MigrationOperation = 'export' | 'import-validate' | 'import-prepare' | 'import-adopt';

export type MigrationPhase =
  | 'start'
  | 'snapshot-complete'
  | 'manifest-written'
  | 'zip-written'
  | 'done'
  | 'validate-start'
  | 'validate-ok'
  | 'staged'
  | 'flag-written'
  | 'adopted'
  | 'refused'
  | 'failed';

const SUPPORT_LOG_SUBDIR = 'logs';
const SAFE_STRING_MAX_LENGTH = 160;
const log = createScopedLogger({ service: 'migration-observability' });

const ABSOLUTE_PATH_PATTERNS: readonly RegExp[] = [
  /(^|[\s"'([{])\/(?:[^/\s"'()[\]{}]+\/)+[^/\s"'()[\]{}:,]*/g,
  /(^|[\s"'([{])~\/(?:[^/\s"'()[\]{}]+\/)*[^/\s"'()[\]{}:,]*/g,
  /[a-zA-Z]:\\(?:[^\\\s"']+\\)*[^\\\s"']+/g,
];
const FILENAME_PATTERN = /\b[\w.-]+\.(?:json|jsonl|md|txt|log|png|jpg|jpeg|zip|rebeltransfer)\b/gi;
const MAX_SANITIZE_DEPTH = 20;
const SAFE_TELEMETRY_KEYS = new Set([
  'code',
  'importId',
  'operation',
  'phase',
  'status',
  'provider',
  'providerLabels',
]);

export function redactForMigrationTelemetry(value: string): string {
  let redacted = redactSensitiveString(value);
  for (const pattern of ABSOLUTE_PATH_PATTERNS) {
    redacted = redacted.replace(pattern, (match, prefix: string | undefined) => {
      if (prefix && match.startsWith(prefix)) {
        return `${prefix}<path>`;
      }
      return '<path>';
    });
  }
  redacted = redacted.replace(FILENAME_PATTERN, '<file>');
  return redacted.length > SAFE_STRING_MAX_LENGTH
    ? `${redacted.slice(0, SAFE_STRING_MAX_LENGTH)}...`
    : redacted;
}

export function sanitizeMigrationTelemetryValue(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const sanitizeRecursive = (current: unknown, depth: number, key?: string): unknown => {
    if (depth > MAX_SANITIZE_DEPTH) return '[MaxDepth]';
    if (typeof current === 'string') {
      if (key && isSensitiveKeyName(key) && !SAFE_TELEMETRY_KEYS.has(key)) {
        return REDACTED_TEXT;
      }
      return redactForMigrationTelemetry(current);
    }
    if (current === null || current === undefined || typeof current !== 'object') return current;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(current)) return '[Buffer]';
    if (seen.has(current)) return '[Circular]';
    seen.add(current);
    if (Array.isArray(current)) {
      return current.map((item) => sanitizeRecursive(item, depth + 1, key));
    }
    return Object.fromEntries(
      Object.entries(current as Record<string, unknown>).map(([key, item]) => [
        key,
        sanitizeRecursive(item, depth + 1, key),
      ]),
    );
  };
  return sanitizeRecursive(value, 0);
}

export interface MigrationManifestTelemetrySummary {
  readonly importId: string;
  readonly sourceDataSchemaEpoch: number;
  readonly entryCount: number;
  readonly totalBytes: number;
  readonly sessionEntryCount: number;
  readonly workspaceEntryCount: number;
  readonly spaceCount: number;
  readonly internalLocalSpaceCount: number;
  readonly cloudBackedSpaceCount: number;
  readonly externalSymlinkSpaceCount: number;
  readonly providerLabels: readonly string[];
  readonly exclusionCounts: {
    readonly derived: number;
    readonly keychain: number;
    readonly cloud: number;
    readonly transient: number;
  };
  readonly reAuthChecklist: {
    readonly providerKeyLabelCount: number;
    readonly connectorCount: number;
    readonly cloudRepairRequired: boolean;
  };
}

export function summarizeMigrationManifestForTelemetry(
  manifest: MigrationBundleManifest,
): MigrationManifestTelemetrySummary {
  const providers: string[] = [];
  for (const space of manifest.spaces) {
    const provider = space.provider ?? space.detectionEvidence?.provider;
    if (typeof provider === 'string' && provider.length > 0) {
      providers.push(provider);
    }
  }
  const providerLabels = [...new Set(providers)].sort((a, b) => a.localeCompare(b));

  return {
    importId: manifest.importId,
    sourceDataSchemaEpoch: manifest.sourceDataSchemaEpoch,
    entryCount: manifest.entries.length,
    totalBytes: manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0),
    sessionEntryCount: manifest.entries.filter((entry) => entry.relPath.startsWith('sessions/')).length,
    workspaceEntryCount: manifest.entries.filter((entry) => entry.relPath.startsWith('workspace/')).length,
    spaceCount: manifest.spaces.length,
    internalLocalSpaceCount: manifest.spaces.filter((space) => space.classification === 'internal-local').length,
    cloudBackedSpaceCount: manifest.spaces.filter((space) => space.classification === 'cloud-backed').length,
    externalSymlinkSpaceCount: manifest.spaces.filter((space) => space.classification === 'external-symlink').length,
    providerLabels,
    exclusionCounts: {
      derived: manifest.exclusions.derived.length,
      keychain: manifest.exclusions.keychain.length,
      cloud: manifest.exclusions.cloud.length,
      transient: manifest.exclusions.transient.length,
    },
    reAuthChecklist: {
      providerKeyLabelCount: manifest.reAuthChecklist.providerKeys.length,
      connectorCount: manifest.reAuthChecklist.connectors.length,
      cloudRepairRequired: manifest.reAuthChecklist.cloudRepairRequired,
    },
  };
}

function sanitizeTelemetryRecord(input: Record<string, unknown>): Record<string, unknown> {
  return sanitizeMigrationTelemetryValue(input) as Record<string, unknown>;
}

export function recordMigrationBreadcrumb(
  phase: MigrationPhase,
  data: Record<string, unknown>,
): void {
  try {
    getErrorReporter().addBreadcrumb({
      category: 'migration',
      level: phase === 'failed' || phase === 'refused' ? 'warning' : 'info',
      message: `migration.${phase}`,
      data: sanitizeTelemetryRecord({ phase, ...data }),
    });
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'migration.observability.breadcrumb',
      reason: 'observability must never affect migration behavior',
    });
    // Observability must never affect migration behavior.
  }
}

export function logMigrationPhase(
  level: 'info' | 'warn' | 'error',
  message: string,
  data: Record<string, unknown>,
): void {
  const safeData = sanitizeTelemetryRecord(data);
  if (level === 'error') {
    log.error(safeData, message);
    return;
  }
  if (level === 'warn') {
    log.warn(safeData, message);
    return;
  }
  log.info(safeData, message);
}

export function shouldCaptureMigrationFailure(code: string | undefined): boolean {
  return code !== 'bundle-incompatible' && code !== 'target-not-fresh';
}

export function captureMigrationFailure(
  error: unknown,
  args: {
    readonly operation: MigrationOperation;
    readonly phase: MigrationPhase;
    readonly code?: string;
    readonly importId?: string;
    readonly manifestSummary?: MigrationManifestTelemetrySummary;
    readonly extra?: Record<string, unknown>;
  },
): void {
  const code = args.code ?? 'unknown';
  if (!shouldCaptureMigrationFailure(code)) return;

  const safeContext = sanitizeTelemetryRecord({
    operation: args.operation,
    phase: args.phase,
    code,
    importId: args.importId,
    manifest: args.manifestSummary,
    ...args.extra,
  });
  const captureError = new Error(`Migration ${args.operation} failed (${code})`);
  captureError.name = 'MigrationFailure';
  const reporter = getErrorReporter();

  try {
    if (reporter.captureExceptionWithScope) {
      reporter.captureExceptionWithScope(captureError, (scope: ErrorReporterEventScope) => {
        scope.setTag('area', 'migration');
        scope.setTag('migration.operation', args.operation);
        scope.setTag('migration.phase', args.phase);
        scope.setTag('migration.code', code);
        scope.setContext('migration', safeContext);
      });
      return;
    }
    reporter.captureException(captureError, {
      tags: {
        area: 'migration',
        'migration.operation': args.operation,
        'migration.phase': args.phase,
        'migration.code': code,
      },
      contexts: { migration: safeContext },
    });
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'migration.observability.failure-capture',
      reason: 'observability must never affect migration behavior',
    });
    // Observability must never affect migration behavior.
  }

  void error;
}

function formatBool(value: boolean): string {
  return value ? 'yes' : 'no';
}

export function buildMigrationSupportLog(args: {
  readonly kind: 'export' | 'import';
  readonly importId: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly status: 'started' | 'success' | 'refused' | 'failed';
  readonly phases: readonly string[];
  readonly manifestSummary?: MigrationManifestTelemetrySummary;
  readonly code?: string;
}): string {
  const lines = [
    `Migration ${args.kind} log`,
    `importId: ${args.importId}`,
    `status: ${args.status}`,
    `startedAt: ${args.startedAt}`,
    `completedAt: ${args.completedAt ?? 'not-completed'}`,
  ];

  if (args.code) lines.push(`code: ${args.code}`);
  lines.push(`phases: ${args.phases.join(', ') || 'none'}`);

  const summary = args.manifestSummary;
  if (summary) {
    lines.push(
      `entries: ${summary.entryCount}`,
      `bytes: ${summary.totalBytes}`,
      `sessions: ${summary.sessionEntryCount}`,
      `workspace_entries: ${summary.workspaceEntryCount}`,
      `spaces_total: ${summary.spaceCount}`,
      `spaces_internal_local: ${summary.internalLocalSpaceCount}`,
      `spaces_cloud_backed: ${summary.cloudBackedSpaceCount}`,
      `spaces_external_symlink: ${summary.externalSymlinkSpaceCount}`,
      `provider_labels: ${summary.providerLabels.join(', ') || 'none'}`,
      `excluded_derived: ${summary.exclusionCounts.derived}`,
      `excluded_keychain: ${summary.exclusionCounts.keychain}`,
      `excluded_cloud: ${summary.exclusionCounts.cloud}`,
      `excluded_transient: ${summary.exclusionCounts.transient}`,
      `reauth_provider_key_labels: ${summary.reAuthChecklist.providerKeyLabelCount}`,
      `reauth_connectors: ${summary.reAuthChecklist.connectorCount}`,
      `reauth_cloud_pairing: ${formatBool(summary.reAuthChecklist.cloudRepairRequired)}`,
    );
  }

  lines.push(
    '',
    'What transferred',
    '- Conversations/session files: counts only in this log; content is not repeated here.',
    '- Workspace content: only local workspace files selected by the migration manifest.',
    '- Settings: sanitized migration-safe preferences only.',
    '',
    'What was excluded',
    '- Keychain and OAuth material: reconnect on this computer.',
    '- Cloud sync state and device identity: re-pair from this computer.',
    '- Derived caches and transient logs: rebuilt by Rebel.',
    '',
    'Re-auth checklist',
    '- Add AI provider keys again.',
    '- Reconnect listed connectors.',
    '- Pair cloud continuity again if needed.',
    '',
  );

  return lines.map((line) => redactForMigrationTelemetry(line)).join('\n');
}

export async function writeMigrationSupportLog(
  baseDir: string,
  fileStem: string,
  content: string,
): Promise<string> {
  const logDir = path.join(baseDir, SUPPORT_LOG_SUBDIR);
  await fsp.mkdir(logDir, { recursive: true, mode: 0o700 });
  const filePath = path.join(logDir, `${fileStem}.log`);
  await fsp.writeFile(filePath, content, { encoding: 'utf8', mode: 0o600 });
  return filePath;
}

export function appendMigrationSupportLogSync(
  baseDir: string,
  fileStem: string,
  content: string,
): string | null {
  try {
    const logDir = path.join(baseDir, SUPPORT_LOG_SUBDIR);
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const filePath = path.join(logDir, `${fileStem}.log`);
    fs.appendFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
    return filePath;
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'migration.observability.support-log-append',
      reason: 'support log is best-effort observability',
    });
    return null;
  }
}
