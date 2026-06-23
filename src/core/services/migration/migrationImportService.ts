import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicCredentialWrite } from '@core/utils/atomicCredentialWrite';
import { detectCloudStorage, type CloudProvider } from '@core/utils/cloudStorageUtils';
import {
  normalizeSnapshotRelativePath,
  resolveSnapshotChildPath,
  sha256Buffer,
} from '@core/utils/safeSnapshotCopy';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { isBundleCompatible } from './migrationCompatibility';
import {
  parseMigrationBundleManifest,
  type MigrationBundleManifest,
} from './migrationManifest';
import {
  buildMigrationSupportLog,
  captureMigrationFailure,
  appendMigrationSupportLogSync,
  logMigrationPhase,
  recordMigrationBreadcrumb,
  summarizeMigrationManifestForTelemetry,
  writeMigrationSupportLog,
  type MigrationManifestTelemetrySummary,
  type MigrationPhase,
} from './migrationObservability';
import {
  isAllowedMigrationImportEntryPath,
  MIGRATION_APP_SETTINGS_REL_PATH,
  MIGRATION_DATA_DIR_NAME,
  MIGRATION_WORKSPACE_DATA_PREFIX,
} from './migrationPolicy';

const MIGRATION_IMPORT_FLAG_FILENAME = 'mindstone-rebel-migration-import.json';
const MIGRATION_IMPORT_ERROR_FILENAME = 'mindstone-rebel-migration-import-error.json';
const MIGRATION_IMPORT_NOTICE_FILENAME = 'migration-import-notice.json';
const MIGRATION_IMPORT_BOOT_OUTCOME_FILENAME = 'migration-import-boot-outcome.json';
export const MIGRATION_IMPORT_STAGING_COMPLETE_FILENAME = '.migration-import-staging-complete.json';

export const DEFAULT_MAX_ENTRY_COUNT = 100_000;
export const DEFAULT_MAX_ENTRY_BYTES = 512 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 20 * 1024 * 1024 * 1024;

const WINDOWS_RESERVED_BASENAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

export type MigrationImportErrorCode =
  | 'manifest-missing'
  | 'manifest-invalid'
  | 'bundle-incompatible'
  | 'entry-count-exceeded'
  | 'entry-size-exceeded'
  | 'bundle-size-exceeded'
  | 'entry-path-invalid'
  | 'entry-path-reserved'
  | 'entry-path-ads'
  | 'entry-path-trailing-dot-or-space'
  | 'entry-case-collision'
  | 'entry-not-in-import-policy'
  | 'entry-file-missing'
  | 'entry-file-extra'
  | 'entry-file-not-regular'
  | 'entry-file-symlink'
  | 'entry-file-hardlink'
  | 'entry-bytes-mismatch'
  | 'entry-checksum-mismatch'
  | 'settings-missing'
  | 'settings-invalid'
  | 'staging-incomplete'
  | 'staging-import-id-mismatch'
  | 'staging-not-sibling'
  | 'target-not-fresh'
  | 'cross-device-publish'
  | 'publish-failed';

export class MigrationImportError extends Error {
  readonly code: MigrationImportErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;

  constructor(
    code: MigrationImportErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'MigrationImportError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
    this.cause = options.cause;
  }
}

export interface MigrationImportLimits {
  readonly maxEntryCount?: number;
  readonly maxEntryBytes?: number;
  readonly maxTotalBytes?: number;
}

export interface ValidateMigrationBundleOptions {
  readonly bundleDir: string;
  readonly targetDataSchemaEpoch: number;
  readonly limits?: MigrationImportLimits;
}

export interface ValidatedMigrationBundle {
  readonly bundleDir: string;
  readonly dataDir: string;
  readonly manifest: MigrationBundleManifest;
}

export interface PrepareMigrationImportOptions extends ValidateMigrationBundleOptions {
  readonly targetUserDataPath: string;
  readonly now: Date;
  readonly targetCoreDirectory?: string | null;
  readonly spaceSourcePathCandidates?: readonly string[];
  readonly importFlagPath?: string;
}

export interface PrepareMigrationImportResult {
  readonly importId: string;
  readonly stagingDir: string;
  readonly flagPath: string;
  readonly manifest: MigrationBundleManifest;
  readonly repairedSettingsPath: string;
  readonly shouldRelaunch: true;
}

export interface MigrationImportFlag {
  readonly stagingDir: string;
  readonly importId: string;
  readonly createdAt: string;
}

type MigrationReAuthChecklist = MigrationBundleManifest['reAuthChecklist'];

export interface MigrationImportAdoptionErrorState {
  readonly code: MigrationImportErrorCode;
  readonly message: string;
  /** Machine-readable sub-reason (e.g. freshness reason) for remote diagnosis. */
  readonly detail?: string;
  readonly importId?: string;
  readonly stagingDir?: string;
  readonly createdAt: string;
}

export interface MigrationImportNotice {
  readonly importId: string;
  readonly adoptedAt: string;
  readonly reAuthChecklist: MigrationReAuthChecklist;
}

export interface MigrationImportBootOutcome {
  readonly status: 'adopted' | 'refused' | 'ignored-invalid-flag';
  readonly code?: MigrationImportErrorCode;
  readonly importId?: string;
  readonly createdAt: string;
}

export type MigrationImportAdoptionResult =
  | { status: 'no-flag' }
  | { status: 'ignored-invalid-flag'; code: MigrationImportErrorCode }
  | { status: 'refused'; code: MigrationImportErrorCode; errorStatePath: string }
  | { status: 'adopted'; importId: string; backupDir: string | null; userDataPath: string };

export interface AdoptPreparedMigrationImportOptions {
  readonly targetUserDataPath: string;
  readonly now: Date;
  readonly importFlagPath?: string;
  readonly errorStatePath?: string;
}

type JsonRecord = Record<string, unknown>;

const EMPTY_REAUTH_CHECKLIST: MigrationReAuthChecklist = {
  providerKeys: [],
  connectors: [],
  cloudRepairRequired: false,
};

export function getMigrationImportFlagPath(): string {
  return path.join(os.tmpdir(), MIGRATION_IMPORT_FLAG_FILENAME);
}

export function getMigrationImportErrorStatePath(): string {
  return path.join(os.tmpdir(), MIGRATION_IMPORT_ERROR_FILENAME);
}

function limitsWithDefaults(limits: MigrationImportLimits | undefined): Required<MigrationImportLimits> {
  return {
    maxEntryCount: limits?.maxEntryCount ?? DEFAULT_MAX_ENTRY_COUNT,
    maxEntryBytes: limits?.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES,
    maxTotalBytes: limits?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseReAuthChecklist(value: unknown): MigrationReAuthChecklist | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.providerKeys) || !value.providerKeys.every((item) => typeof item === 'string')) {
    return null;
  }
  if (!Array.isArray(value.connectors) || !value.connectors.every((item) => typeof item === 'string')) {
    return null;
  }
  if (typeof value.cloudRepairRequired !== 'boolean') return null;
  return {
    providerKeys: value.providerKeys,
    connectors: value.connectors,
    cloudRepairRequired: value.cloudRepairRequired,
  };
}

function parseJsonFileSync(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
}

function parseManifestIssueCode(parseResult: ReturnType<typeof parseMigrationBundleManifest>): MigrationImportErrorCode {
  if (parseResult.ok) return 'manifest-invalid';
  for (const issue of parseResult.issues) {
    const pathKey = issue.path.join('.');
    if (/^entries\.\d+\.relPath$/.test(pathKey) || /^spaces\.\d+\.relPath$/.test(pathKey)) {
      return 'entry-path-invalid';
    }
  }
  return 'manifest-invalid';
}

function pathSegments(relativePath: string): string[] {
  return relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
}

function validatePortableRelPathHazards(relativePath: string): string {
  let normalized: string;
  try {
    normalized = normalizeSnapshotRelativePath(relativePath);
  } catch (error) {
    throw new MigrationImportError(
      'entry-path-invalid',
      `Migration bundle entry path is not safe: ${relativePath}`,
      { cause: error },
    );
  }

  for (const segment of pathSegments(relativePath)) {
    if (segment.includes(':')) {
      throw new MigrationImportError(
        'entry-path-ads',
        `Migration bundle entry path contains a Windows alternate data stream marker: ${relativePath}`,
      );
    }
    if (/[. ]$/.test(segment)) {
      throw new MigrationImportError(
        'entry-path-trailing-dot-or-space',
        `Migration bundle entry path contains a segment ending in a dot or space: ${relativePath}`,
      );
    }
    const base = segment.split('.')[0]?.toLowerCase() ?? '';
    if (WINDOWS_RESERVED_BASENAMES.has(base)) {
      throw new MigrationImportError(
        'entry-path-reserved',
        `Migration bundle entry path contains a Windows-reserved name: ${relativePath}`,
      );
    }
  }
  return normalized;
}

function assertNoCaseFoldCollision(entries: readonly { relPath: string }[]): void {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const normalized = validatePortableRelPathHazards(entry.relPath);
    const key = normalized.toLocaleLowerCase('en-US');
    const existing = seen.get(key);
    if (existing && existing !== normalized) {
      throw new MigrationImportError(
        'entry-case-collision',
        `Migration bundle contains paths that collide on case-insensitive filesystems: ${existing} / ${entry.relPath}`,
      );
    }
    seen.set(key, normalized);
  }
}

function assertManifestEntriesAllowedByImportPolicy(manifest: MigrationBundleManifest): void {
  for (const entry of manifest.entries) {
    const normalized = validatePortableRelPathHazards(entry.relPath);
    if (!isAllowedMigrationImportEntryPath(normalized, manifest)) {
      throw new MigrationImportError(
        'entry-not-in-import-policy',
        `Migration bundle contains a file Rebel is not allowed to import: ${normalized}`,
        { details: { relPath: normalized } },
      );
    }
  }
}

async function assertBundleDataTreeMatchesManifest(
  dataDir: string,
  expectedRelPaths: ReadonlySet<string>,
  manifest: MigrationBundleManifest,
): Promise<void> {
  async function walk(currentDir: string): Promise<void> {
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
    for (const dirent of entries) {
      const absolutePath = path.join(currentDir, dirent.name);
      const relativePath = normalizeSnapshotRelativePath(path.relative(dataDir, absolutePath));
      validatePortableRelPathHazards(relativePath);

      const stat = await fsp.lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new MigrationImportError(
          'entry-file-symlink',
          `Migration bundle data contains a symlink: ${relativePath}`,
        );
      }
      if (stat.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new MigrationImportError(
          'entry-file-not-regular',
          `Migration bundle data contains a non-regular file: ${relativePath}`,
        );
      }
      if (stat.nlink > 1) {
        throw new MigrationImportError(
          'entry-file-hardlink',
          `Migration bundle data contains a hardlinked file: ${relativePath}`,
        );
      }
      if (!isAllowedMigrationImportEntryPath(relativePath, manifest)) {
        throw new MigrationImportError(
          'entry-not-in-import-policy',
          `Migration bundle data contains a file Rebel is not allowed to import: ${relativePath}`,
          { details: { relPath: relativePath } },
        );
      }
      if (!expectedRelPaths.has(relativePath)) {
        throw new MigrationImportError(
          'entry-file-extra',
          `Migration bundle data contains a file not listed in the manifest: ${relativePath}`,
        );
      }
    }
  }

  await walk(dataDir);
}

export async function validateMigrationBundle(
  options: ValidateMigrationBundleOptions,
): Promise<ValidatedMigrationBundle> {
  const bundleDir = path.resolve(options.bundleDir);
  const dataDir = path.join(bundleDir, MIGRATION_DATA_DIR_NAME);
  const manifestPath = path.join(bundleDir, 'manifest.json');
  const limits = limitsWithDefaults(options.limits);
  let phase: MigrationPhase = 'validate-start';
  let manifestSummary: MigrationManifestTelemetrySummary | undefined;

  logMigrationPhase('info', 'Migration import validate-start', {
    operation: 'import-validate',
    phase,
  });
  recordMigrationBreadcrumb('validate-start', {
    operation: 'import-validate',
  });

  try {
    let manifestRaw: unknown;
    try {
      manifestRaw = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as unknown;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      throw new MigrationImportError(
        code === 'ENOENT' ? 'manifest-missing' : 'manifest-invalid',
        'Migration bundle manifest is missing or unreadable.',
        { cause: error },
      );
    }

    const parsed = parseMigrationBundleManifest(manifestRaw);
    if (!parsed.ok) {
      throw new MigrationImportError(
        parseManifestIssueCode(parsed),
        `Migration bundle manifest failed validation: ${parsed.reason}`,
        { details: { issueCount: parsed.issues.length } },
      );
    }
    manifestSummary = summarizeMigrationManifestForTelemetry(parsed.manifest);

    const compatibility = isBundleCompatible(options.targetDataSchemaEpoch, parsed.manifest);
    if (!compatibility.ok) {
      throw new MigrationImportError(
        'bundle-incompatible',
        'Migration bundle was created by a newer Rebel data schema. Update Rebel before importing.',
        { details: compatibility },
      );
    }

    if (parsed.manifest.entries.length > limits.maxEntryCount) {
      throw new MigrationImportError(
        'entry-count-exceeded',
        'Migration bundle contains too many files.',
        { details: { count: parsed.manifest.entries.length, maxEntryCount: limits.maxEntryCount } },
      );
    }
    assertNoCaseFoldCollision(parsed.manifest.entries);
    assertManifestEntriesAllowedByImportPolicy(parsed.manifest);

    const expectedRelPaths = new Set(parsed.manifest.entries.map((entry) => validatePortableRelPathHazards(entry.relPath)));
    await assertBundleDataTreeMatchesManifest(dataDir, expectedRelPaths, parsed.manifest);

    let totalBytes = 0;
    for (const entry of parsed.manifest.entries) {
      const normalizedRelPath = validatePortableRelPathHazards(entry.relPath);
      if (entry.bytes > limits.maxEntryBytes) {
        throw new MigrationImportError(
          'entry-size-exceeded',
          'Migration bundle entry exceeds the per-file size limit.',
          { details: { bytes: entry.bytes, maxEntryBytes: limits.maxEntryBytes } },
        );
      }
      totalBytes += entry.bytes;
      if (totalBytes > limits.maxTotalBytes) {
        throw new MigrationImportError(
          'bundle-size-exceeded',
          'Migration bundle exceeds the total size limit.',
          { details: { totalBytes, maxTotalBytes: limits.maxTotalBytes } },
        );
      }

      const sourcePath = resolveSnapshotChildPath(dataDir, normalizedRelPath);
      let stat: fs.Stats;
      try {
        stat = await fsp.lstat(sourcePath);
      } catch (error) {
        throw new MigrationImportError(
          'entry-file-missing',
          'Migration bundle entry is missing from data/.',
          { cause: error },
        );
      }
      if (stat.isSymbolicLink()) {
        throw new MigrationImportError(
          'entry-file-symlink',
          'Migration bundle entry is a symlink.',
        );
      }
      if (!stat.isFile()) {
        throw new MigrationImportError(
          'entry-file-not-regular',
          'Migration bundle entry is not a regular file.',
        );
      }
      if (stat.nlink > 1) {
        throw new MigrationImportError(
          'entry-file-hardlink',
          'Migration bundle entry is hardlinked.',
        );
      }
      if (stat.size !== entry.bytes) {
        throw new MigrationImportError(
          'entry-bytes-mismatch',
          'Migration bundle entry size does not match the manifest.',
        );
      }

      const bytes = await fsp.readFile(sourcePath);
      if (sha256Buffer(bytes) !== entry.sha256) {
        throw new MigrationImportError(
          'entry-checksum-mismatch',
          'Migration bundle entry checksum does not match the manifest.',
        );
      }
    }

    phase = 'validate-ok';
    logMigrationPhase('info', 'Migration import validate-ok', {
      operation: 'import-validate',
      phase,
      manifest: manifestSummary,
    });
    recordMigrationBreadcrumb('validate-ok', {
      operation: 'import-validate',
      manifest: manifestSummary,
    });
    return { bundleDir, dataDir, manifest: parsed.manifest };
  } catch (error) {
    const code = error instanceof MigrationImportError
      ? error.code
      : (error as NodeJS.ErrnoException | undefined)?.code ?? 'manifest-invalid';
    const level = code === 'bundle-incompatible' ? 'warn' : 'error';
    logMigrationPhase(level, 'Migration import validation failed', {
      operation: 'import-validate',
      phase,
      code,
      importId: manifestSummary?.importId,
      retryable: error instanceof MigrationImportError ? error.retryable : undefined,
      errorName: error instanceof Error ? error.name : typeof error,
      manifest: manifestSummary,
    });
    recordMigrationBreadcrumb('failed', {
      operation: 'import-validate',
      phase,
      code,
      importId: manifestSummary?.importId,
      manifest: manifestSummary,
    });
    captureMigrationFailure(error, {
      operation: 'import-validate',
      phase,
      code,
      importId: manifestSummary?.importId,
      manifestSummary,
    });
    throw error;
  }
}

function hasBundledWorkspaceContent(manifest: MigrationBundleManifest): boolean {
  return manifest.entries.some((entry) =>
    entry.relPath === MIGRATION_WORKSPACE_DATA_PREFIX ||
    entry.relPath.startsWith(`${MIGRATION_WORKSPACE_DATA_PREFIX}/`)
  );
}

function deriveCloudRelativeSuffix(inputPath: string): string | undefined {
  const portable = inputPath.replace(/\\/g, '/');
  const markers = [
    /\/OneDrive[^/]*(?:\/(.+))?$/i,
    /\/Library\/CloudStorage\/GoogleDrive-[^/]+(?:\/(.+))?$/i,
    /\/Google Drive(?:\/(.+))?$/i,
    /^[a-zA-Z]:\/(?:My Drive|Shared drives)(?:\/(.+))?$/i,
    /\/Dropbox(?:\/(.+))?$/i,
    /\/Library\/Mobile Documents\/com~apple~CloudDocs(?:\/(.+))?$/i,
    /\/iCloud ?Drive(?:\/(.+))?$/i,
    /\/Box(?: Sync)?(?:\/(.+))?$/i,
  ];
  for (const marker of markers) {
    const match = portable.match(marker);
    if (match) return match[1] ?? '';
  }
  return undefined;
}

function normalizeSuffix(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return normalizeSnapshotRelativePath(value || '.');
}

async function hashReadmeIfPresent(candidatePath: string): Promise<string | undefined> {
  try {
    const readmePath = path.join(candidatePath, 'README.md');
    const stat = await fsp.lstat(readmePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    return sha256Buffer(await fsp.readFile(readmePath));
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'migration.import.cloud-readme-hash',
      reason: 'cloud source matching evidence is optional',
    });
    return undefined;
  }
}

async function findHighConfidenceSpaceSourcePath(
  manifestSpace: MigrationBundleManifest['spaces'][number],
  candidates: readonly string[],
): Promise<string | undefined> {
  const expectedProvider = manifestSpace.provider ?? manifestSpace.detectionEvidence?.provider;
  const expectedSuffix = normalizeSuffix(manifestSpace.detectionEvidence?.relativeSuffix);
  const expectedReadmeSha = manifestSpace.detectionEvidence?.readmeSha256;
  if (!expectedProvider || expectedSuffix === undefined || !expectedReadmeSha) {
    return undefined;
  }

  for (const candidate of candidates) {
    const resolvedCandidate = path.resolve(candidate);
    const detection = detectCloudStorage(resolvedCandidate);
    if (!detection.isCloud || detection.provider !== expectedProvider) continue;
    if (normalizeSuffix(deriveCloudRelativeSuffix(resolvedCandidate)) !== expectedSuffix) continue;
    if (await hashReadmeIfPresent(resolvedCandidate) !== expectedReadmeSha) continue;
    return resolvedCandidate;
  }
  return undefined;
}

async function repairStagedAppSettings(args: {
  readonly stagingDir: string;
  readonly targetUserDataPath: string;
  readonly targetCoreDirectory: string | null;
  readonly manifest: MigrationBundleManifest;
  readonly spaceSourcePathCandidates: readonly string[];
}): Promise<string> {
  const settingsPath = resolveSnapshotChildPath(args.stagingDir, MIGRATION_APP_SETTINGS_REL_PATH);
  let settingsRaw: unknown;
  try {
    settingsRaw = JSON.parse(await fsp.readFile(settingsPath, 'utf8')) as unknown;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    throw new MigrationImportError(
      code === 'ENOENT' ? 'settings-missing' : 'settings-invalid',
      'Migration bundle app-settings.json is missing or invalid.',
      { cause: error },
    );
  }
  if (!isRecord(settingsRaw)) {
    throw new MigrationImportError('settings-invalid', 'Migration bundle app-settings.json must be a JSON object.');
  }

  const settings = settingsRaw;
  settings.mcpConfigFile = null;
  delete settings.cloudInstance;
  settings.coreDirectory = args.targetCoreDirectory;

  if (Array.isArray(settings.spaces)) {
    const manifestSpaceByRelPath = new Map(args.manifest.spaces.map((space) => [space.relPath, space]));
    const repairedSpaces: unknown[] = [];
    for (const spaceValue of settings.spaces) {
      if (!isRecord(spaceValue) || typeof spaceValue.path !== 'string') {
        repairedSpaces.push(spaceValue);
        continue;
      }
      const spacePath = spaceValue.path;
      const space: JsonRecord & { path: string } = { ...spaceValue, path: spacePath };
      const normalizedSpaceRelPath = normalizeSnapshotRelativePath(spacePath);
      const manifestSpace = manifestSpaceByRelPath.get(normalizedSpaceRelPath);
      if (!manifestSpace) {
        repairedSpaces.push(space);
        continue;
      }

      if (manifestSpace.classification === 'internal-local') {
        delete space.sourcePath;
        space.isSymlink = false;
        if (space.storageProvider === undefined || space.storageProvider === 'other') {
          space.storageProvider = 'local';
        }
        repairedSpaces.push(space);
        continue;
      }

      const repairedSourcePath = await findHighConfidenceSpaceSourcePath(
        manifestSpace,
        args.spaceSourcePathCandidates,
      );
      if (repairedSourcePath) {
        space.sourcePath = repairedSourcePath;
        space.isSymlink = true;
        const provider: CloudProvider | undefined = manifestSpace.provider ?? manifestSpace.detectionEvidence?.provider;
        if (provider) space.storageProvider = provider;
      } else {
        delete space.sourcePath;
        space.isSymlink = true;
      }
      repairedSpaces.push(space);
    }
    settings.spaces = repairedSpaces;
  }

  await atomicCredentialWrite(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return settingsPath;
}

function stagingDirForImport(targetUserDataPath: string, importId: string): string {
  return path.join(path.dirname(path.resolve(targetUserDataPath)), `mindstone-rebel-import-${importId}.staging`);
}

function defaultTargetCoreDirectory(targetUserDataPath: string, manifest: MigrationBundleManifest): string | null {
  if (!hasBundledWorkspaceContent(manifest)) return null;
  return path.join(path.resolve(targetUserDataPath), MIGRATION_WORKSPACE_DATA_PREFIX);
}

async function copyValidatedBundleIntoStaging(
  validated: ValidatedMigrationBundle,
  stagingDir: string,
): Promise<void> {
  await fsp.rm(stagingDir, { recursive: true, force: true });
  await fsp.mkdir(stagingDir, { recursive: true, mode: 0o700 });
  for (const entry of validated.manifest.entries) {
    const normalizedRelPath = validatePortableRelPathHazards(entry.relPath);
    const sourcePath = resolveSnapshotChildPath(validated.dataDir, normalizedRelPath);
    const destinationPath = resolveSnapshotChildPath(stagingDir, normalizedRelPath);
    await fsp.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
    await fsp.copyFile(sourcePath, destinationPath);
    await fsp.chmod(destinationPath, 0o600);
  }
}

async function writeStagingCompletionMarker(
  stagingDir: string,
  manifest: MigrationBundleManifest,
  now: Date,
): Promise<void> {
  await atomicCredentialWrite(
    path.join(stagingDir, MIGRATION_IMPORT_STAGING_COMPLETE_FILENAME),
    `${JSON.stringify({
      importId: manifest.importId,
      completedAt: now.toISOString(),
      sourceDataSchemaEpoch: manifest.sourceDataSchemaEpoch,
      reAuthChecklist: manifest.reAuthChecklist,
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function writeMigrationImportFlag(flagPath: string, flag: MigrationImportFlag): Promise<void> {
  await atomicCredentialWrite(flagPath, `${JSON.stringify(flag, null, 2)}\n`, { mode: 0o600 });
}

export async function prepareMigrationImport(
  options: PrepareMigrationImportOptions,
): Promise<PrepareMigrationImportResult> {
  const startedAt = options.now.toISOString();
  const phases: string[] = [];
  let phase: MigrationPhase = 'validate-start';
  const validated = await validateMigrationBundle(options);
  const manifestSummary = summarizeMigrationManifestForTelemetry(validated.manifest);
  const targetUserDataPath = path.resolve(options.targetUserDataPath);
  const stagingDir = stagingDirForImport(targetUserDataPath, validated.manifest.importId);
  const flagPath = options.importFlagPath ?? getMigrationImportFlagPath();
  const targetCoreDirectory = options.targetCoreDirectory === undefined
    ? defaultTargetCoreDirectory(targetUserDataPath, validated.manifest)
    : options.targetCoreDirectory;

  const markPhase = (nextPhase: MigrationPhase, data: Record<string, unknown> = {}) => {
    phase = nextPhase;
    phases.push(nextPhase);
    logMigrationPhase('info', `Migration import prepare ${nextPhase}`, {
      operation: 'import-prepare',
      importId: validated.manifest.importId,
      phase: nextPhase,
      manifest: manifestSummary,
      ...data,
    });
    recordMigrationBreadcrumb(nextPhase, {
      operation: 'import-prepare',
      importId: validated.manifest.importId,
      manifest: manifestSummary,
      ...data,
    });
  };

  try {
    await copyValidatedBundleIntoStaging(validated, stagingDir);
    phase = 'staged';
    const repairedSettingsPath = await repairStagedAppSettings({
      stagingDir,
      targetUserDataPath,
      targetCoreDirectory,
      manifest: validated.manifest,
      spaceSourcePathCandidates: options.spaceSourcePathCandidates ?? [],
    });
    await writeStagingCompletionMarker(stagingDir, validated.manifest, options.now);
    markPhase('staged', {
      hasTargetCoreDirectory: Boolean(targetCoreDirectory),
    });

    await writeMigrationSupportLog(
      stagingDir,
      `migration-import-${validated.manifest.importId}`,
      buildMigrationSupportLog({
        kind: 'import',
        importId: validated.manifest.importId,
        startedAt,
        status: 'started',
        phases,
        manifestSummary,
      }),
    );

    await writeMigrationImportFlag(flagPath, {
      stagingDir,
      importId: validated.manifest.importId,
      createdAt: options.now.toISOString(),
    });
    markPhase('flag-written');
    try {
      await writeMigrationSupportLog(
        stagingDir,
        `migration-import-${validated.manifest.importId}`,
        buildMigrationSupportLog({
          kind: 'import',
          importId: validated.manifest.importId,
          startedAt,
          status: 'started',
          phases,
          manifestSummary,
        }),
      );
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'migration.import.prepare.support-log-refresh',
        reason: 'support artifact refresh must not strand prepared import',
      });
      // The restart flag is already durable; don't strand the prepared import
      // because the support artifact refresh failed.
    }

    return {
      importId: validated.manifest.importId,
      stagingDir,
      flagPath,
      manifest: validated.manifest,
      repairedSettingsPath,
      shouldRelaunch: true,
    };
  } catch (error) {
    const code = error instanceof MigrationImportError
      ? error.code
      : (error as NodeJS.ErrnoException | undefined)?.code ?? 'publish-failed';
    logMigrationPhase('error', 'Migration import prepare failed', {
      operation: 'import-prepare',
      importId: validated.manifest.importId,
      phase,
      code,
      retryable: error instanceof MigrationImportError ? error.retryable : undefined,
      errorName: error instanceof Error ? error.name : typeof error,
      manifest: manifestSummary,
    });
    recordMigrationBreadcrumb('failed', {
      operation: 'import-prepare',
      importId: validated.manifest.importId,
      phase,
      code,
      manifest: manifestSummary,
    });
    captureMigrationFailure(error, {
      operation: 'import-prepare',
      phase,
      code,
      importId: validated.manifest.importId,
      manifestSummary,
    });
    try {
      await writeMigrationSupportLog(
        stagingDir,
        `migration-import-${validated.manifest.importId}`,
        buildMigrationSupportLog({
          kind: 'import',
          importId: validated.manifest.importId,
          startedAt,
          completedAt: new Date().toISOString(),
          status: 'failed',
          phases,
          manifestSummary,
          code,
        }),
      );
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'migration.import.prepare.failure-support-log',
        reason: 'failure support artifact is best-effort',
      });
      // Best-effort support artifact only.
    }
    throw error;
  }
}

function clearFileSync(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
      throw error;
    }
  }
}

function readMigrationImportFlagSync(flagPath: string): MigrationImportFlag | null {
  if (!fs.existsSync(flagPath)) return null;
  try {
    const parsed = parseJsonFileSync(flagPath);
    if (
      isRecord(parsed) &&
      typeof parsed.stagingDir === 'string' &&
      typeof parsed.importId === 'string' &&
      typeof parsed.createdAt === 'string'
    ) {
      return {
        stagingDir: parsed.stagingDir,
        importId: parsed.importId,
        createdAt: parsed.createdAt,
      };
    }
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'migration.import.flag.parse',
      reason: 'invalid import flag is cleared by caller',
    });
    // Cleared by caller as an invalid flag.
  }
  return null;
}

function readStagingCompletionMarkerSync(stagingDir: string): {
  importId: string;
  reAuthChecklist: MigrationReAuthChecklist;
} | null {
  try {
    const parsed = parseJsonFileSync(path.join(stagingDir, MIGRATION_IMPORT_STAGING_COMPLETE_FILENAME));
    if (isRecord(parsed) && typeof parsed.importId === 'string') {
      return {
        importId: parsed.importId,
        reAuthChecklist: parseReAuthChecklist(parsed.reAuthChecklist) ?? EMPTY_REAUTH_CHECKLIST,
      };
    }
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'migration.import.staging-marker.parse',
      reason: 'missing or invalid marker means no completed staging',
    });
    return null;
  }
  return null;
}

/**
 * Why a target was judged not-fresh — surfaced in logs/breadcrumbs so a refusal
 * is debuggable remotely (the previous code logged only the opaque
 * `target-not-fresh` code, which made field diagnosis near-impossible).
 */
export type MigrationImportTargetFreshness =
  | { fresh: true; reason: 'fresh' }
  | {
      fresh: false;
      reason:
        | 'sessions-have-user-data'
        | 'agent-sessions-present'
        | 'onboarding-completed'
        | 'settings-unreadable';
    };

// Legacy orphaned dir from a partial SessionStorageService impl. It is never
// created on a fresh install, so mere existence is a safe not-fresh signal.
const LEGACY_AGENT_SESSIONS_DIR = 'agent-sessions';
const SESSIONS_DIR_NAME = 'sessions';
const SESSIONS_INDEX_FILENAME = 'index.json';

// Files in `sessions/` that are NOT session payloads. Mirrors `NON_SESSION_FILES`
// in incrementalSessionStore.ts — kept local so this safety gate doesn't pull the
// heavy store module into the early boot-adoption path. Here, drift only ever
// causes a *conservative* false-refuse (safe direction); in the store it is the
// DANGEROUS direction (a missed sidecar crashed classifySessionKind — see that
// set's doc). Keep the two identical; enforced by
// `sessionSidecarDenylist.lockstep.test.ts`. Exported for that test.
// (`index.json.bak` needs no entry in either set — both checks are
// `.json`-suffix-gated and it does not end in `.json`.)
export const SESSION_DIR_NON_PAYLOAD_FILES = new Set<string>([
  SESSIONS_INDEX_FILENAME,
  // Stage 3 (260612 recs-round5): hard-delete tombstone ledger — lives inside
  // sessions/ so `.rebeltransfer` carries it; never a session payload.
  'session-delete-ledger.json',
  'folders.json',
  'cloud-outbox.json',
  'cloud-continuity-meta.json',
  'cloud-sync-meta.json',
  'cloud-workspace-manifest.json',
  // Cloud-sync tombstone quarantine snapshot (cloudOutbox.ts). LRU diagnostic
  // state, not a session — must be denylisted so a from-files rebuild never
  // hydrates it into an id-less "session". See the store's NON_SESSION_FILES.
  'cloud-tombstone-quarantine.json',
]);

const SESSION_FILE_SUFFIX = '.json';

function isSessionPayloadFile(name: string): boolean {
  return name.endsWith(SESSION_FILE_SUFFIX) && !SESSION_DIR_NON_PAYLOAD_FILES.has(name);
}

function isPositiveNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Does a session-index entry represent genuine user engagement (as opposed to a
 * system-seeded stub)? A fresh install auto-seeds default automations (Morning
 * Triage, Weekly Prep, …) into `sessions/` on first launch — `origin:"automation"`,
 * zero turns, zero cost — before the user does anything. Those must NOT count as
 * "Rebel is already set up". We key on positive signals of real use rather than an
 * allowlist of seeded origins, so a future seeded origin is auto-ignored too:
 *   - `origin === 'manual'` (a chat the user explicitly opened), OR
 *   - any real model activity (a turn ran / tokens / cost).
 *
 * Deliberately NOT used: `messageCount` / `hasUserMessages` / `hasDraft`. The seeded
 * automation stubs have `messageCount: 1` and `hasUserMessages: true` (the injected
 * system prompt), so those signals would re-introduce the very false positive this
 * fixes. Do not add them without re-checking the seeded-automation shape.
 */
function sessionEntryShowsUserEngagement(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  if (entry.origin === 'manual') return true;
  const usage = entry.usage;
  if (isRecord(usage)) {
    if (
      isPositiveNumber(usage.turnCount) ||
      isPositiveNumber(usage.costUsd) ||
      isPositiveNumber(usage.inputTokens) ||
      isPositiveNumber(usage.outputTokens)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * True if the `sessions/` directory holds genuine user data (vs. only auto-seeded
 * zero-engagement stubs). Safety-critical: this is what allows the importer to
 * back-up-and-replace the profile, so it FAILS CLOSED on any ambiguity.
 *
 * Reads the session index (`sessions/index.json`), but does NOT blindly trust it:
 * the store documents a crash-recovery state where a real session payload is
 * written before the index is updated. So even when the index parses and shows no
 * engagement, we still require the index and the on-disk payload files to AGREE —
 * any payload file not represented in the index, any malformed index entry, or an
 * unreadable directory/index is treated as "has user data" (not fresh).
 *
 * Auto-seeded automation stubs (origin "automation", zero usage) that ARE listed
 * in the index remain fresh — that's the bug this whole change fixes.
 */
function sessionsDirHasUserData(userDataPath: string): boolean {
  const sessionsDir = path.join(userDataPath, SESSIONS_DIR_NAME);
  if (!fs.existsSync(sessionsDir)) return false;

  let payloadFiles: string[];
  try {
    payloadFiles = fs.readdirSync(sessionsDir).filter(isSessionPayloadFile);
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'migration.import.target-freshness-session-readdir',
      reason: 'unreadable sessions dir treated as not-fresh',
    });
    return true; // cannot inspect the directory → fail closed
  }

  const indexPath = path.join(sessionsDir, SESSIONS_INDEX_FILENAME);
  if (fs.existsSync(indexPath)) {
    try {
      const parsed = parseJsonFileSync(indexPath);
      if (isRecord(parsed) && Array.isArray(parsed.sessions)) {
        const entries = parsed.sessions;
        // Any genuinely engaged session → real user data.
        if (entries.some(sessionEntryShowsUserEngagement)) return true;
        // Any malformed entry → can't classify → fail closed.
        if (entries.some((entry) => !isRecord(entry) || typeof entry.id !== 'string')) return true;
        // Index/disk disagreement (e.g. a crash left a real session payload on disk
        // that the index doesn't list) → fail closed: an unindexed payload is real data.
        const indexedIds = new Set(entries.map((entry) => (entry as { id: string }).id));
        return payloadFiles.some(
          (name) => !indexedIds.has(name.slice(0, name.length - SESSION_FILE_SUFFIX.length)),
        );
      }
      // Index present but unrecognised shape — fall through to conservative check.
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'migration.import.target-freshness-session-index',
        reason: 'unreadable session index falls back to conservative file check',
      });
    }
  }

  // No parseable index: any session payload file means we can't prove freshness → not fresh.
  return payloadFiles.length > 0;
}

/**
 * A target is adoptable only if it has no real user data. This is the backstop
 * for the absolute "never mutate a live install" guarantee. Returns a structured
 * reason so refusals are diagnosable in the field.
 *
 * What counts as "real user data": a `manual`/used session in `sessions/`, the
 * legacy `agent-sessions/` dir, `onboardingCompleted === true`, or unreadable
 * settings. Crucially, the mere existence of `sessions/` does NOT — a fresh install
 * seeds default-automation stubs there before the user reaches the transfer screen
 * (the cause of the "This computer already has Rebel set up" false positive).
 *
 * This is intentionally conservative and not exhaustive — a profile mid-onboarding
 * that already holds some data could still read as fresh. That residual is bounded
 * by: (1) adoption only fires after the user explicitly ran import from this profile,
 * and (2) publish ALWAYS moves the existing profile aside to a timestamped backup
 * before renaming (fully recoverable, never destroyed).
 */
export function describeMigrationImportTargetFreshnessSync(
  userDataPath: string,
): MigrationImportTargetFreshness {
  if (sessionsDirHasUserData(userDataPath)) {
    return { fresh: false, reason: 'sessions-have-user-data' };
  }
  if (fs.existsSync(path.join(userDataPath, LEGACY_AGENT_SESSIONS_DIR))) {
    return { fresh: false, reason: 'agent-sessions-present' };
  }

  const settingsPath = path.join(userDataPath, MIGRATION_APP_SETTINGS_REL_PATH);
  if (!fs.existsSync(settingsPath)) return { fresh: true, reason: 'fresh' };
  try {
    const parsed = parseJsonFileSync(settingsPath);
    if (!isRecord(parsed)) return { fresh: false, reason: 'settings-unreadable' };
    return parsed.onboardingCompleted === true
      ? { fresh: false, reason: 'onboarding-completed' }
      : { fresh: true, reason: 'fresh' };
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'migration.import.target-freshness-settings',
      reason: 'unreadable settings means target is not fresh',
    });
    return { fresh: false, reason: 'settings-unreadable' };
  }
}

export function isFreshMigrationImportTargetSync(userDataPath: string): boolean {
  return describeMigrationImportTargetFreshnessSync(userDataPath).fresh;
}

function backupSuffix(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function isSameParentPath(left: string, right: string): boolean {
  return path.resolve(path.dirname(left)) === path.resolve(path.dirname(right));
}

function writeErrorStateSync(
  errorStatePath: string,
  state: MigrationImportAdoptionErrorState,
): void {
  fs.mkdirSync(path.dirname(errorStatePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(errorStatePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function getMigrationImportNoticePath(userDataPath: string): string {
  return path.join(userDataPath, MIGRATION_IMPORT_NOTICE_FILENAME);
}

function getMigrationImportBootOutcomePath(userDataPath: string): string {
  return path.join(userDataPath, MIGRATION_IMPORT_BOOT_OUTCOME_FILENAME);
}

function writeMigrationImportNoticeBestEffortSync(
  userDataPath: string,
  notice: MigrationImportNotice,
): void {
  try {
    fs.writeFileSync(
      getMigrationImportNoticePath(userDataPath),
      `${JSON.stringify(notice, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'migration.import.notice.write',
      reason: 'startup notice is best-effort after adoption',
    });
    // Best-effort startup notice only; adoption has already succeeded.
  }
}

function writeMigrationImportBootOutcomeBestEffortSync(
  userDataPath: string,
  outcome: MigrationImportBootOutcome,
): void {
  try {
    fs.writeFileSync(
      getMigrationImportBootOutcomePath(userDataPath),
      `${JSON.stringify(outcome, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'migration.import.boot-outcome.write',
      reason: 'startup observability must not affect adoption result',
    });
    // Best-effort startup observability only; adoption/refusal result is already returned.
  }
}

export function consumeMigrationImportNoticeSync(userDataPath: string): MigrationImportNotice | null {
  const noticePath = getMigrationImportNoticePath(userDataPath);
  if (!fs.existsSync(noticePath)) return null;

  try {
    const parsed = parseJsonFileSync(noticePath);
    if (
      isRecord(parsed) &&
      typeof parsed.importId === 'string' &&
      typeof parsed.adoptedAt === 'string'
    ) {
      const reAuthChecklist = parseReAuthChecklist(parsed.reAuthChecklist) ?? EMPTY_REAUTH_CHECKLIST;
      recordMigrationBreadcrumb('adopted', {
        operation: 'import-adopt',
        importId: parsed.importId,
      });
      return {
        importId: parsed.importId,
        adoptedAt: parsed.adoptedAt,
        reAuthChecklist,
      };
    }
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'migration.notice.consume',
      reason: 'corrupt notices are consumed as absent',
    });
    // Corrupt notices are treated as absent, but still consumed below.
  } finally {
    try {
      fs.unlinkSync(noticePath);
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'migration.notice.cleanup',
        reason: 'one-shot notice cleanup is best-effort',
      });
      // One-shot cleanup is best-effort.
    }
  }

  return null;
}

function recordRefusalAndClearFlag(args: {
  readonly flagPath: string;
  readonly errorStatePath: string;
  readonly code: MigrationImportErrorCode;
  readonly message: string;
  readonly detail?: string;
  readonly importId?: string;
  readonly stagingDir?: string;
  readonly now: Date;
}): MigrationImportAdoptionResult {
  clearFileSync(args.flagPath);
  writeErrorStateSync(args.errorStatePath, {
    code: args.code,
    message: args.message,
    detail: args.detail,
    importId: args.importId,
    stagingDir: args.stagingDir,
    createdAt: args.now.toISOString(),
  });
  return { status: 'refused', code: args.code, errorStatePath: args.errorStatePath };
}

export function adoptPreparedMigrationImportSync(
  options: AdoptPreparedMigrationImportOptions,
): MigrationImportAdoptionResult {
  const flagPath = options.importFlagPath ?? getMigrationImportFlagPath();
  const errorStatePath = options.errorStatePath ?? getMigrationImportErrorStatePath();
  const targetUserDataPath = path.resolve(options.targetUserDataPath);
  const flag = readMigrationImportFlagSync(flagPath);

  if (!flag) {
    if (fs.existsSync(flagPath)) {
      clearFileSync(flagPath);
      return { status: 'ignored-invalid-flag', code: 'manifest-invalid' };
    }
    return { status: 'no-flag' };
  }

  const stagingDir = path.resolve(flag.stagingDir);
  const completion = readStagingCompletionMarkerSync(stagingDir);
  if (!completion) {
    clearFileSync(flagPath);
    return { status: 'ignored-invalid-flag', code: 'staging-incomplete' };
  }
  if (completion.importId !== flag.importId) {
    clearFileSync(flagPath);
    return { status: 'ignored-invalid-flag', code: 'staging-import-id-mismatch' };
  }
  if (!isSameParentPath(stagingDir, targetUserDataPath)) {
    return recordRefusalAndClearFlag({
      flagPath,
      errorStatePath,
      code: 'staging-not-sibling',
      message: 'Migration import staging directory is not a sibling of the target userData directory.',
      importId: flag.importId,
      stagingDir,
      now: options.now,
    });
  }
  const freshness = describeMigrationImportTargetFreshnessSync(targetUserDataPath);
  if (!freshness.fresh) {
    logMigrationPhase('warn', 'Migration import adoption refused: target not fresh', {
      operation: 'import-adopt',
      phase: 'validate-start',
      code: 'target-not-fresh',
      freshnessReason: freshness.reason,
      importId: flag.importId,
    });
    return recordRefusalAndClearFlag({
      flagPath,
      errorStatePath,
      code: 'target-not-fresh',
      message: 'Migration import can only be adopted into a fresh Rebel profile.',
      detail: freshness.reason,
      importId: flag.importId,
      stagingDir,
      now: options.now,
    });
  }

  const backupDir = fs.existsSync(targetUserDataPath)
    ? `${targetUserDataPath}.pre-import-backup-${backupSuffix(options.now)}`
    : null;

  try {
    if (backupDir) {
      fs.renameSync(targetUserDataPath, backupDir);
    }
    fs.renameSync(stagingDir, targetUserDataPath);
    writeMigrationImportNoticeBestEffortSync(targetUserDataPath, {
      importId: flag.importId,
      adoptedAt: options.now.toISOString(),
      reAuthChecklist: completion.reAuthChecklist,
    });
    writeMigrationImportBootOutcomeBestEffortSync(targetUserDataPath, {
      status: 'adopted',
      importId: flag.importId,
      createdAt: options.now.toISOString(),
    });
    appendMigrationSupportLogSync(
      targetUserDataPath,
      `migration-import-${flag.importId}`,
      [
        '',
        'Boot adoption',
        'status: success',
        `adoptedAt: ${options.now.toISOString()}`,
        `backup_kept: ${backupDir ? 'yes' : 'no'}`,
        '',
      ].join('\n'),
    );
    clearFileSync(flagPath);
    clearFileSync(errorStatePath);
    return { status: 'adopted', importId: flag.importId, backupDir, userDataPath: targetUserDataPath };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code === 'EXDEV'
      ? 'cross-device-publish'
      : 'publish-failed';
    if (backupDir && fs.existsSync(backupDir) && !fs.existsSync(targetUserDataPath)) {
      try {
        fs.renameSync(backupDir, targetUserDataPath);
      } catch (rollbackError) {
        ignoreBestEffortCleanup(rollbackError, {
          operation: 'migration.import.adopt.backup-rollback',
          reason: 'preserve original publish failure while backup remains recoverable',
        });
        // Preserve the original publish failure for the caller; the backup path
        // remains in the recorded state so support can recover manually.
      }
    }
    return recordRefusalAndClearFlag({
      flagPath,
      errorStatePath,
      code,
      message: code === 'cross-device-publish'
        ? 'Migration import publish crossed filesystem devices and was refused.'
        : 'Migration import publish failed before adoption completed.',
      importId: flag.importId,
      stagingDir,
      now: options.now,
    });
  }
}
