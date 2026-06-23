import fs from 'node:fs/promises';
import path from 'node:path';
import { detectCloudStorage, type CloudProvider } from '@core/utils/cloudStorageUtils';
import {
  collectSafeSnapshotFiles,
  copyStableSnapshotFile,
  normalizeSnapshotRelativePath,
  sha256Buffer,
  snapshotRelativePathFromRoot,
  writeSnapshotBuffer,
  type SafeSnapshotFileCandidate,
} from '@core/utils/safeSnapshotCopy';
import { setupConnectors } from '@core/services/oauthConnectorSetup';
import type { AppSettings, SpaceConfig } from '@shared/types/settings';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { sanitizeAppSettingsForMigration } from './appSettingsMigrationSanitizer';
import {
  buildMigrationCopyRoots,
  buildMigrationExclusions,
  isDeniedMigrationRelPath,
  shouldCopyUserDataMigrationRelPath,
  MIGRATION_DATA_DIR_NAME,
  MIGRATION_WORKSPACE_DATA_PREFIX,
  MIGRATION_WORKSPACE_ROOT_SPACE_REL_PATH,
} from './migrationPolicy';
import {
  MIGRATION_BUNDLE_MANIFEST_SCHEMA_VERSION,
  parseMigrationBundleManifest,
  type MigrationBundleManifest,
  type MigrationSpaceDetectionEvidence,
} from './migrationManifest';
import {
  buildMigrationSupportLog,
  captureMigrationFailure,
  logMigrationPhase,
  recordMigrationBreadcrumb,
  summarizeMigrationManifestForTelemetry,
  writeMigrationSupportLog,
  type MigrationPhase,
} from './migrationObservability';

const WORKSPACE_ROOT_SPACE_NAME = 'Library root';

const PROVIDER_KEY_LABELS: readonly [RegExp, string][] = [
  [/^providerKeys(?:\.|$)/, 'providerKeys'],
  [/^models\.(?:apiKey|oauthToken|oauthRefreshToken)$/i, 'models'],
  [/^openRouter\./i, 'openrouter'],
  [/^customProviders\[/i, 'customProviders'],
  [/^localModel\./i, 'localModel'],
  [/^voice\./i, 'voice'],
  [/^meetingBot\./i, 'meetingBot'],
  [/^gamma\./i, 'gamma'],
  [/^googleWorkspace\./i, 'google-workspace'],
  [/^hubspot\./i, 'hubspot'],
  [/^salesforce\./i, 'salesforce'],
  [/^telemetry\./i, 'telemetry'],
];

export interface MigrationExportHooks {
  readonly afterCopyBeforeVerify?: (entry: {
    readonly sourceRelativePath: string;
    readonly destinationRelativePath: string;
    readonly sourcePath: string;
  }) => Promise<void> | void;
}

export interface ExportMigrationBundleOptions {
  readonly sourceUserDataPath: string;
  readonly coreDirectory: string | null | undefined;
  readonly settings: AppSettings;
  readonly appVersion: string;
  readonly dataSchemaEpoch: number;
  readonly importId: string;
  readonly destBundleDir: string;
  readonly now: Date;
  readonly hooks?: MigrationExportHooks;
}

export interface MigrationExportResult {
  readonly bundleDir: string;
  readonly dataDir: string;
  readonly manifestPath: string;
  readonly manifest: MigrationBundleManifest;
  readonly containsSensitiveHistory: true;
  readonly sensitiveCounts: {
    readonly copiedFiles: number;
    readonly copiedBytes: number;
    readonly copiedSessionFiles: number;
    readonly copiedSpaceFiles: number;
    readonly pointerOnlySpaces: number;
  };
  readonly removedSecretFields: readonly string[];
}

export class MigrationExportError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(code: string, message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message);
    this.name = 'MigrationExportError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.cause = options.cause;
  }
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function deriveProviderKeyChecklist(removedSecretFields: readonly string[]): string[] {
  const labels = new Set<string>();
  for (const field of removedSecretFields) {
    for (const [pattern, label] of PROVIDER_KEY_LABELS) {
      if (pattern.test(field)) {
        labels.add(label);
        break;
      }
    }
  }
  return sortedUnique(labels);
}

function toManifestCloudProvider(provider: string | undefined): CloudProvider | undefined {
  if (
    provider === 'onedrive' ||
    provider === 'google_drive' ||
    provider === 'dropbox' ||
    provider === 'icloud' ||
    provider === 'box'
  ) {
    return provider;
  }
  return undefined;
}

function isPathInsideOrSame(parentPath: string, childPath: string): boolean {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  const comparisonParent = process.platform === 'win32' || process.platform === 'darwin'
    ? parent.toLowerCase()
    : parent;
  const comparisonChild = process.platform === 'win32' || process.platform === 'darwin'
    ? child.toLowerCase()
    : child;
  const relative = path.relative(comparisonParent, comparisonChild);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolveExistingPhysicalPath(inputPath: string): Promise<string> {
  try {
    return await fs.realpath(inputPath);
  } catch {
    return path.resolve(inputPath);
  }
}

async function isSymlinkPath(inputPath: string): Promise<boolean> {
  try {
    return (await fs.lstat(inputPath)).isSymbolicLink();
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'migration.export.symlink-detect',
      reason: 'path probe fallback is safe during migration classification',
    });
    return false;
  }
}

function deriveCloudRelativeSuffix(resolvedPath: string): string | undefined {
  const portable = resolvedPath.replace(/\\/g, '/');
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

async function hashFileIfPresent(filePath: string): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile()) return undefined;
    return sha256Buffer(await fs.readFile(filePath));
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'migration.export.hash-file-if-present',
      reason: 'optional evidence hash must not block migration export',
    });
    return undefined;
  }
}

async function classifySpaceForMigration(args: {
  readonly space: Pick<SpaceConfig, 'name' | 'path' | 'isSymlink' | 'sourcePath' | 'storageProvider'>;
  readonly coreDirectory: string;
  readonly resolvedCoreDirectory: string;
  readonly coreDirectoryCloudProvider?: CloudProvider;
}): Promise<MigrationBundleManifest['spaces'][number] & { physicalPath: string; shouldCopyContent: boolean }> {
  const { space, coreDirectory, resolvedCoreDirectory, coreDirectoryCloudProvider } = args;
  const logicalPath = path.resolve(coreDirectory, space.path);
  const inputPath = space.isSymlink && space.sourcePath ? space.sourcePath : logicalPath;
  const resolvedPath = await resolveExistingPhysicalPath(inputPath);
  const detected = detectCloudStorage(resolvedPath);
  const manifestProvider = coreDirectoryCloudProvider ?? detected.provider ?? toManifestCloudProvider(space.storageProvider);
  const physicallyInsideCore = isPathInsideOrSame(resolvedCoreDirectory, resolvedPath);
  const symlinkOnDisk = space.isSymlink || await isSymlinkPath(logicalPath);

  const classification = coreDirectoryCloudProvider || detected.isCloud
    ? 'cloud-backed'
    : physicallyInsideCore
      ? 'internal-local'
      : 'external-symlink';

  const evidence: MigrationSpaceDetectionEvidence = {
    inputPath,
    resolvedPath,
    provider: manifestProvider,
    relativeSuffix: deriveCloudRelativeSuffix(resolvedPath),
    readmeSha256: await hashFileIfPresent(path.join(resolvedPath, 'README.md')),
    coreDirectoryIsCloudBacked: Boolean(coreDirectoryCloudProvider),
    isSymlink: symlinkOnDisk,
  };

  return {
    name: space.name,
    relPath: normalizeSnapshotRelativePath(space.path),
    classification,
    provider: manifestProvider,
    detectionEvidence: evidence,
    physicalPath: resolvedPath,
    shouldCopyContent: classification === 'internal-local',
  };
}

async function classifyWorkspaceRootForMigration(args: {
  readonly coreDirectory: string;
  readonly resolvedCoreDirectory: string;
  readonly coreDirectoryCloudProvider?: CloudProvider;
}): Promise<MigrationBundleManifest['spaces'][number]> {
  const { coreDirectory, resolvedCoreDirectory, coreDirectoryCloudProvider } = args;
  const detection = detectCloudStorage(resolvedCoreDirectory);
  const provider = coreDirectoryCloudProvider ?? detection.provider;
  return {
    name: WORKSPACE_ROOT_SPACE_NAME,
    relPath: MIGRATION_WORKSPACE_ROOT_SPACE_REL_PATH,
    classification: provider ? 'cloud-backed' : 'internal-local',
    provider,
    detectionEvidence: {
      inputPath: coreDirectory,
      resolvedPath: resolvedCoreDirectory,
      provider,
      relativeSuffix: deriveCloudRelativeSuffix(resolvedCoreDirectory),
      readmeSha256: await hashFileIfPresent(path.join(resolvedCoreDirectory, 'README.md')),
      coreDirectoryIsCloudBacked: Boolean(provider),
      isSymlink: await isSymlinkPath(coreDirectory),
    },
  };
}

async function copyUserDataEntries(
  sourceUserDataPath: string,
  dataDir: string,
  copyRoots: readonly string[],
  hooks?: MigrationExportHooks,
): Promise<MigrationBundleManifest['entries']> {
  const candidatesByRelPath = new Map<string, SafeSnapshotFileCandidate>();
  for (const copyRoot of copyRoots) {
    const collected = await collectSafeSnapshotFiles(sourceUserDataPath, copyRoot, {
      shouldIncludeRelativePath: shouldCopyUserDataMigrationRelPath,
    });
    if (collected.failure) {
      throw new MigrationExportError(
        'source-walk-failed',
        `Could not safely enumerate ${copyRoot}: ${collected.failure.error}`,
        { retryable: true },
      );
    }
    for (const candidate of collected.files) {
      if (shouldCopyUserDataMigrationRelPath(candidate.relativePath)) {
        candidatesByRelPath.set(candidate.relativePath, candidate);
      }
    }
  }

  const entries: MigrationBundleManifest['entries'] = [];
  for (const candidate of [...candidatesByRelPath.values()].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath)
  )) {
    try {
      entries.push(await copyStableSnapshotFile(candidate, dataDir, candidate.relativePath, {
        afterCopyBeforeVerify: () => hooks?.afterCopyBeforeVerify?.({
          sourceRelativePath: candidate.relativePath,
          destinationRelativePath: candidate.relativePath,
          sourcePath: candidate.sourcePath,
        }),
      }));
    } catch (error) {
      throw new MigrationExportError(
        'source-changed-during-export',
        `Source file changed while exporting ${candidate.relativePath}. Retry the export when Rebel is idle.`,
        { retryable: true, cause: error },
      );
    }
  }
  return entries;
}

async function copyInternalSpaceEntries(
  dataDir: string,
  space: MigrationBundleManifest['spaces'][number] & { physicalPath: string },
  hooks?: MigrationExportHooks,
): Promise<MigrationBundleManifest['entries']> {
  const destinationPrefix = normalizeSnapshotRelativePath(path.posix.join(MIGRATION_WORKSPACE_DATA_PREFIX, space.relPath));
  // Defense-in-depth (Stage 2 review S1): the workspace is the user's own library
  // going to their own machine (A7 accepted risk), but a stray token/secret file
  // sitting inside it should still never ride along in the bundle.
  const collected = await collectSafeSnapshotFiles(space.physicalPath, '.', {
    shouldIncludeRelativePath: (relativePath) => !isDeniedMigrationRelPath(relativePath),
  });
  if (collected.failure) {
    throw new MigrationExportError(
      'space-walk-failed',
      `Could not safely enumerate space ${space.relPath}: ${collected.failure.error}`,
      { retryable: true },
    );
  }

  const entries: MigrationBundleManifest['entries'] = [];
  for (const candidate of collected.files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    const destinationRelativePath = normalizeSnapshotRelativePath(
      path.posix.join(destinationPrefix, candidate.relativePath),
    );
    try {
      entries.push(await copyStableSnapshotFile(candidate, dataDir, destinationRelativePath, {
        afterCopyBeforeVerify: () => hooks?.afterCopyBeforeVerify?.({
          sourceRelativePath: snapshotRelativePathFromRoot(space.physicalPath, candidate.sourcePath),
          destinationRelativePath,
          sourcePath: candidate.sourcePath,
        }),
      }));
    } catch (error) {
      throw new MigrationExportError(
        'source-changed-during-export',
        `Source file changed while exporting space ${space.relPath}. Retry the export when Rebel is idle.`,
        { retryable: true, cause: error },
      );
    }
  }
  return entries;
}

export async function exportMigrationBundle(options: ExportMigrationBundleOptions): Promise<MigrationExportResult> {
  const sourceUserDataPath = path.resolve(options.sourceUserDataPath);
  const destBundleDir = path.resolve(options.destBundleDir);
  const dataDir = path.join(destBundleDir, MIGRATION_DATA_DIR_NAME);
  const phases: string[] = [];
  let phase: MigrationPhase = 'start';
  const startMs = Date.now();
  const startedAt = options.now.toISOString();
  const markPhase = (nextPhase: MigrationPhase, data: Record<string, unknown> = {}) => {
    phase = nextPhase;
    phases.push(nextPhase);
    logMigrationPhase('info', `Migration export ${nextPhase}`, {
      operation: 'export',
      importId: options.importId,
      phase: nextPhase,
      ...data,
    });
    recordMigrationBreadcrumb(nextPhase, {
      operation: 'export',
      importId: options.importId,
      ...data,
    });
  };

  markPhase('start', {
    hasCoreDirectory: Boolean(options.coreDirectory),
    sourceDataSchemaEpoch: options.dataSchemaEpoch,
  });

  try {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });

    const { settings: sanitizedSettings, removedSecretFields } = sanitizeAppSettingsForMigration(options.settings);
    const entries: MigrationBundleManifest['entries'] = [];

    entries.push(await writeSnapshotBuffer(
      dataDir,
      'app-settings.json',
      `${JSON.stringify(sanitizedSettings, null, 2)}\n`,
    ));

    entries.push(...await copyUserDataEntries(
      sourceUserDataPath,
      dataDir,
      buildMigrationCopyRoots(),
      options.hooks,
    ));

    const coreDirectory = options.coreDirectory ? path.resolve(options.coreDirectory) : null;
    const spaces: MigrationBundleManifest['spaces'] = [];
    const spaceCopyTasks: Array<MigrationBundleManifest['spaces'][number] & {
      physicalPath: string;
      shouldCopyContent: boolean;
    }> = [];

    if (coreDirectory) {
      const resolvedCoreDirectory = await resolveExistingPhysicalPath(coreDirectory);
      const coreDetection = detectCloudStorage(resolvedCoreDirectory);
      const coreDirectoryCloudProvider = coreDetection.isCloud ? coreDetection.provider : undefined;
      spaces.push(await classifyWorkspaceRootForMigration({
        coreDirectory,
        resolvedCoreDirectory,
        coreDirectoryCloudProvider,
      }));

      for (const space of options.settings.spaces ?? []) {
        const classified = await classifySpaceForMigration({
          space,
          coreDirectory,
          resolvedCoreDirectory,
          coreDirectoryCloudProvider,
        });
        const { physicalPath: _physicalPath, shouldCopyContent: _shouldCopyContent, ...manifestSpace } = classified;
        spaces.push(manifestSpace);
        spaceCopyTasks.push(classified);
      }
    }

    for (const space of spaceCopyTasks) {
      if (!space.shouldCopyContent) continue;
      entries.push(...await copyInternalSpaceEntries(dataDir, space, options.hooks));
    }

    const copiedFilesSoFar = entries.length;
    const copiedBytesSoFar = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    markPhase('snapshot-complete', {
      entryCount: copiedFilesSoFar,
      totalBytes: copiedBytesSoFar,
      spaceCount: spaces.length,
      pointerOnlySpaces: spaces.filter((space) =>
        space.relPath !== MIGRATION_WORKSPACE_ROOT_SPACE_REL_PATH &&
        space.classification !== 'internal-local'
      ).length,
    });

    const manifest: MigrationBundleManifest = {
      schemaVersion: MIGRATION_BUNDLE_MANIFEST_SCHEMA_VERSION,
      createdAt: options.now.toISOString(),
      importId: options.importId,
      sourceAppVersion: options.appVersion,
      sourceDataSchemaEpoch: options.dataSchemaEpoch,
      oldPaths: {
        userDataPath: sourceUserDataPath,
        coreDirectory,
        mcpConfigFile: options.settings.mcpConfigFile ?? null,
      },
      spaces: spaces.sort((a, b) => a.relPath.localeCompare(b.relPath)),
      entries: entries.sort((a, b) => a.relPath.localeCompare(b.relPath)),
      exclusions: buildMigrationExclusions(),
      reAuthChecklist: {
        providerKeys: deriveProviderKeyChecklist(removedSecretFields),
        connectors: [...setupConnectors].sort(),
        cloudRepairRequired: Boolean(options.settings.cloudInstance),
      },
    };

    const parsed = parseMigrationBundleManifest(manifest);
    if (!parsed.ok) {
      throw new MigrationExportError(
        'manifest-invalid',
        `Generated migration manifest failed validation: ${parsed.reason}`,
      );
    }

    const manifestPath = path.join(destBundleDir, 'manifest.json');
    await writeSnapshotBuffer(destBundleDir, 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
    markPhase('manifest-written', {
      entryCount: manifest.entries.length,
      totalBytes: manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0),
    });

    const manifestSummary = summarizeMigrationManifestForTelemetry(manifest);
    await writeMigrationSupportLog(
      destBundleDir,
      `migration-export-${options.importId}`,
      buildMigrationSupportLog({
        kind: 'export',
        importId: options.importId,
        startedAt,
        completedAt: new Date().toISOString(),
        status: 'success',
        phases,
        manifestSummary,
      }),
    );

    const copiedFiles = manifest.entries.length;
    const copiedBytes = manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0);
    markPhase('done', {
      ...manifestSummary,
      durationMs: Math.max(0, Date.now() - startMs),
    });
    return {
      bundleDir: destBundleDir,
      dataDir,
      manifestPath,
      manifest,
      containsSensitiveHistory: true,
      sensitiveCounts: {
        copiedFiles,
        copiedBytes,
        copiedSessionFiles: manifest.entries.filter((entry) => entry.relPath.startsWith('sessions/')).length,
        copiedSpaceFiles: manifest.entries.filter((entry) => entry.relPath.startsWith(`${MIGRATION_WORKSPACE_DATA_PREFIX}/`)).length,
        pointerOnlySpaces: manifest.spaces.filter((space) =>
          space.relPath !== MIGRATION_WORKSPACE_ROOT_SPACE_REL_PATH &&
          space.classification !== 'internal-local'
        ).length,
      },
      removedSecretFields,
    };
  } catch (error) {
    const code = error instanceof MigrationExportError
      ? error.code
      : (error as NodeJS.ErrnoException | undefined)?.code ?? 'unknown';
    logMigrationPhase('error', 'Migration export failed', {
      operation: 'export',
      importId: options.importId,
      phase,
      code,
      retryable: error instanceof MigrationExportError ? error.retryable : undefined,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    recordMigrationBreadcrumb('failed', {
      operation: 'export',
      importId: options.importId,
      phase,
      code,
    });
    captureMigrationFailure(error, {
      operation: 'export',
      phase,
      code,
      importId: options.importId,
    });
    throw error;
  }
}
