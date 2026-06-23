import { app, dialog, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import AdmZip from 'adm-zip';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_SCHEMA_EPOCH } from '@core/constants';
import { getPlatformConfig } from '@core/platform';
import { getDataPath } from '@core/utils/dataPaths';
import type { AppSettings } from '@shared/types';
import {
  exportMigrationBundle,
  MigrationExportError,
} from '@core/services/migration/migrationExportService';
import {
  consumeMigrationImportNoticeSync,
  DEFAULT_MAX_ENTRY_BYTES,
  DEFAULT_MAX_ENTRY_COUNT,
  DEFAULT_MAX_TOTAL_BYTES,
  describeMigrationImportTargetFreshnessSync,
  MigrationImportError,
  type MigrationImportErrorCode,
  prepareMigrationImport,
  validateMigrationBundle,
} from '@core/services/migration/migrationImportService';
import type { MigrationBundleManifest } from '@core/services/migration/migrationManifest';
import {
  captureMigrationFailure,
  logMigrationPhase,
  recordMigrationBreadcrumb,
  summarizeMigrationManifestForTelemetry,
} from '@core/services/migration/migrationObservability';
import { registerHandler } from './utils/registerHandler';

type MigrationErrorKind =
  | 'cancelled'
  | 'incompatible'
  | 'corrupt'
  | 'not-fresh'
  | 'storage'
  | 'permission'
  | 'file-in-use'
  | 'unknown';

type MigrationIpcError = {
  kind: MigrationErrorKind;
  code?: string;
  message: string;
  retryable?: boolean;
};

export interface MigrationHandlerDeps {
  getSettings: () => AppSettings;
  getWindowForEvent: (sender: Electron.WebContents) => BrowserWindow | null;
}

const TRANSFER_EXTENSION = 'rebeltransfer';
const ALLOWED_TRANSFER_ENTRY_ROOTS = ['manifest.json', 'data', 'logs'] as const;

function defaultTransferFileName(now = new Date()): string {
  return `Rebel transfer - ${now.toISOString().slice(0, 10)}.${TRANSFER_EXTENSION}`;
}

function ensureTransferExtension(filePath: string): string {
  return path.extname(filePath).toLowerCase() === `.${TRANSFER_EXTENSION}`
    ? filePath
    : `${filePath}.${TRANSFER_EXTENSION}`;
}

function summaryFromManifest(manifest: MigrationBundleManifest) {
  return {
    sourceAppVersion: manifest.sourceAppVersion,
    sourceDataSchemaEpoch: manifest.sourceDataSchemaEpoch,
    createdAt: manifest.createdAt,
    importId: manifest.importId,
    reAuthChecklist: manifest.reAuthChecklist,
  };
}

function mapSystemError(error: unknown): MigrationIpcError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOSPC') {
    return { kind: 'storage', code, message: 'There is not enough storage space for the Rebel transfer file.', retryable: true };
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return { kind: 'permission', code, message: 'Rebel does not have permission to use that location.', retryable: true };
  }
  if (code === 'EBUSY') {
    return { kind: 'file-in-use', code, message: 'That file is currently in use. Choose another location and try again.', retryable: true };
  }
  return { kind: 'unknown', code, message: 'Rebel could not finish the transfer step.', retryable: true };
}

function mapExportError(error: unknown): MigrationIpcError {
  if (error instanceof MigrationExportError) {
    if (error.code === 'source-changed-during-export') {
      return {
        kind: 'file-in-use',
        code: error.code,
        message: 'Rebel data changed while the transfer file was being created. Try again when things are quieter.',
        retryable: true,
      };
    }
    return { kind: 'unknown', code: error.code, message: error.message, retryable: error.retryable };
  }
  return mapSystemError(error);
}

function mapImportError(error: unknown): MigrationIpcError {
  if (error instanceof MigrationImportError) {
    if (error.code === 'bundle-incompatible') {
      return {
        kind: 'incompatible',
        code: error.code,
        message: 'This transfer file was made with a newer Rebel.',
        retryable: false,
      };
    }
    if (error.code === 'target-not-fresh') {
      return {
        kind: 'not-fresh',
        code: error.code,
        message: 'This computer already has Rebel set up.',
        retryable: false,
      };
    }
    return {
      kind: 'corrupt',
      code: error.code,
      message: 'Rebel could not read this transfer file.',
      retryable: error.retryable,
    };
  }
  return mapSystemError(error);
}

function responseStatusForImportError(error: MigrationIpcError): 'incompatible' | 'corrupt' | 'not-fresh' | 'error' {
  if (error.kind === 'incompatible') return 'incompatible';
  if (error.kind === 'not-fresh') return 'not-fresh';
  if (error.kind === 'corrupt') return 'corrupt';
  return 'error';
}

function assertSafeZipEntryName(entryName: string): void {
  const normalized = entryName.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (
    normalized.startsWith('/') ||
    /^[a-zA-Z]:\//.test(normalized) ||
    segments.length === 0 ||
    segments.includes('..')
  ) {
    throw new MigrationImportError(
      'entry-path-invalid',
      'Transfer file contains an unsafe archive path.',
    );
  }
}

function assertAllowedZipEntryRoot(entryName: string): void {
  const normalized = entryName.replace(/\\/g, '/').replace(/\/+$/, '');
  if (
    normalized === 'manifest.json' ||
    normalized === 'data' ||
    normalized.startsWith('data/') ||
    normalized === 'logs' ||
    normalized.startsWith('logs/')
  ) {
    return;
  }
  throw new MigrationImportError(
    'entry-path-invalid',
    'Transfer file contains an unexpected archive path.',
    { details: { allowedRoots: ALLOWED_TRANSFER_ENTRY_ROOTS, entryName } },
  );
}

function assertZipEntryLimits(entries: readonly AdmZip.IZipEntry[]): void {
  if (entries.length > DEFAULT_MAX_ENTRY_COUNT) {
    throw new MigrationImportError(
      'entry-count-exceeded',
      'Transfer file contains too many archive entries.',
      { details: { count: entries.length, maxEntryCount: DEFAULT_MAX_ENTRY_COUNT } },
    );
  }

  let totalBytes = 0;
  for (const entry of entries) {
    const entryBytes = entry.header.size;
    if (entryBytes > DEFAULT_MAX_ENTRY_BYTES) {
      throw new MigrationImportError(
        'entry-size-exceeded',
        'Transfer file contains an archive entry that is too large.',
        { details: { bytes: entryBytes, maxEntryBytes: DEFAULT_MAX_ENTRY_BYTES } },
      );
    }
    totalBytes += entryBytes;
    if (totalBytes > DEFAULT_MAX_TOTAL_BYTES) {
      throw new MigrationImportError(
        'bundle-size-exceeded',
        'Transfer file is too large to import safely.',
        { details: { totalBytes, maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES } },
      );
    }
  }
}

async function extractTransferFile(transferFilePath: string): Promise<string> {
  const extractDir = await fs.mkdtemp(path.join(app.getPath('temp'), 'rebel-transfer-import-'));
  try {
    const zip = new AdmZip(transferFilePath);
    const entries = zip.getEntries();
    assertZipEntryLimits(entries);
    for (const entry of entries) {
      assertSafeZipEntryName(entry.entryName);
      assertAllowedZipEntryRoot(entry.entryName);
    }
    zip.extractAllTo(extractDir, true);
    return extractDir;
  } catch (error) {
    await fs.rm(extractDir, { recursive: true, force: true });
    throw error;
  }
}

async function createTransferFile(bundleDir: string, outputPath: string): Promise<number> {
  const zip = new AdmZip();
  zip.addLocalFolder(bundleDir);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  zip.writeZip(outputPath);
  const stat = await fs.stat(outputPath);
  return stat.size;
}

function isPathWithinDirectory(candidatePath: string, directoryPath: string): boolean {
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedDirectory = path.resolve(directoryPath);
  const relative = path.relative(resolvedDirectory, resolvedCandidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function registerMigrationHandlers(deps: MigrationHandlerDeps): void {
  const { getSettings, getWindowForEvent } = deps;

  registerHandler(
    'migration:export',
    async (event: IpcMainInvokeEvent, payload?: { defaultFileName?: string }) => {
      const win = getWindowForEvent(event.sender);
      const saveDialogOptions = {
        title: 'Choose where to save your Rebel transfer file.',
        defaultPath: payload?.defaultFileName ?? defaultTransferFileName(),
        filters: [
          { name: 'Rebel transfer file', extensions: [TRANSFER_EXTENSION] },
          { name: 'All Files', extensions: ['*'] },
        ],
      };
      const result = win
        ? await dialog.showSaveDialog(win, saveDialogOptions)
        : await dialog.showSaveDialog(saveDialogOptions);

      if (result.canceled || !result.filePath) {
        return { status: 'cancelled' as const };
      }

      const transferFilePath = ensureTransferExtension(result.filePath);
      const tempBundleDir = await fs.mkdtemp(path.join(app.getPath('temp'), 'rebel-transfer-export-'));
      let exportedForTelemetry: {
        readonly importId: string;
        readonly manifestSummary: ReturnType<typeof summarizeMigrationManifestForTelemetry>;
      } | null = null;
      try {
        const settings = getSettings();
        const exported = await exportMigrationBundle({
          sourceUserDataPath: getPlatformConfig().userDataPath,
          coreDirectory: settings.coreDirectory,
          settings,
          appVersion: app.getVersion(),
          dataSchemaEpoch: DATA_SCHEMA_EPOCH,
          importId: randomUUID(),
          destBundleDir: tempBundleDir,
          now: new Date(),
        });
        exportedForTelemetry = {
          importId: exported.manifest.importId,
          manifestSummary: summarizeMigrationManifestForTelemetry(exported.manifest),
        };

        const zipBytes = await createTransferFile(exported.bundleDir, transferFilePath);
        logMigrationPhase('info', 'Migration export zip-written', {
          operation: 'export',
          importId: exported.manifest.importId,
          phase: 'zip-written',
          zipBytes,
          manifest: exportedForTelemetry.manifestSummary,
        });
        recordMigrationBreadcrumb('zip-written', {
          operation: 'export',
          importId: exported.manifest.importId,
          zipBytes,
          manifest: exportedForTelemetry.manifestSummary,
        });

        return {
          status: 'success' as const,
          filePath: transferFilePath,
          containsSensitiveHistory: exported.containsSensitiveHistory,
          sensitiveCounts: exported.sensitiveCounts,
          removedSecretFields: [...exported.removedSecretFields],
          reAuthChecklist: exported.manifest.reAuthChecklist,
        };
      } catch (error) {
        const mapped = mapExportError(error);
        if (exportedForTelemetry) {
          captureMigrationFailure(error, {
            operation: 'export',
            phase: 'zip-written',
            code: mapped.code,
            importId: exportedForTelemetry.importId,
            manifestSummary: exportedForTelemetry.manifestSummary,
          });
        }
        return {
          status: 'error' as const,
          error: mapped,
        };
      } finally {
        await fs.rm(tempBundleDir, { recursive: true, force: true });
      }
    },
  );

  registerHandler('migration:validate-import', async (event: IpcMainInvokeEvent) => {
    const win = getWindowForEvent(event.sender);
    const openDialogOptions = {
      title: 'Choose your Rebel transfer file.',
      properties: ['openFile'],
      filters: [
        { name: 'Rebel transfer file', extensions: [TRANSFER_EXTENSION] },
        { name: 'All Files', extensions: ['*'] },
      ],
    } satisfies Electron.OpenDialogOptions;
    const result = win
      ? await dialog.showOpenDialog(win, openDialogOptions)
      : await dialog.showOpenDialog(openDialogOptions);

    if (result.canceled || result.filePaths.length === 0) {
      return { status: 'cancelled' as const };
    }

    const targetUserDataPath = getPlatformConfig().userDataPath;
    const freshness = describeMigrationImportTargetFreshnessSync(targetUserDataPath);
    if (!freshness.fresh) {
      const notFreshCode: MigrationImportErrorCode = 'target-not-fresh';
      logMigrationPhase('warn', 'Migration import target is not fresh', {
        operation: 'import-validate',
        phase: 'validate-start',
        code: notFreshCode,
        freshnessReason: freshness.reason,
      });
      recordMigrationBreadcrumb('failed', {
        operation: 'import-validate',
        phase: 'validate-start',
        code: notFreshCode,
        freshnessReason: freshness.reason,
      });
      return {
        status: 'not-fresh' as const,
        error: mapImportError(new MigrationImportError(
          notFreshCode,
          'Migration import can only be used before this Rebel setup has user data.',
        )),
      };
    }

    let extractedBundleDir: string | null = null;
    try {
      const transferFilePath = result.filePaths[0];
      extractedBundleDir = await extractTransferFile(transferFilePath);
      const validated = await validateMigrationBundle({
        bundleDir: extractedBundleDir,
        targetDataSchemaEpoch: DATA_SCHEMA_EPOCH,
      });
      return {
        status: 'valid' as const,
        transferFilePath,
        extractedBundleDir,
        summary: summaryFromManifest(validated.manifest),
      };
    } catch (error) {
      if (extractedBundleDir) {
        await fs.rm(extractedBundleDir, { recursive: true, force: true });
      }
      const mapped = mapImportError(error);
      return {
        status: responseStatusForImportError(mapped),
        error: mapped,
      };
    }
  });

  registerHandler(
    'migration:prepare-import',
    async (_event: IpcMainInvokeEvent, payload: { extractedBundleDir: string }) => {
      const targetUserDataPath = getPlatformConfig().userDataPath;
      const freshness = describeMigrationImportTargetFreshnessSync(targetUserDataPath);
      if (!freshness.fresh) {
        const notFreshCode: MigrationImportErrorCode = 'target-not-fresh';
        logMigrationPhase('warn', 'Migration import target is not fresh', {
          operation: 'import-prepare',
          phase: 'validate-start',
          code: notFreshCode,
          freshnessReason: freshness.reason,
        });
        recordMigrationBreadcrumb('failed', {
          operation: 'import-prepare',
          phase: 'validate-start',
          code: notFreshCode,
          freshnessReason: freshness.reason,
        });
        const error = mapImportError(new MigrationImportError(
          notFreshCode,
          'Migration import can only be used before this Rebel setup has user data.',
        ));
        return { status: 'not-fresh' as const, error };
      }

      try {
        const prepared = await prepareMigrationImport({
          bundleDir: payload.extractedBundleDir,
          targetDataSchemaEpoch: DATA_SCHEMA_EPOCH,
          targetUserDataPath,
          now: new Date(),
        });
        return {
          status: 'ready-to-relaunch' as const,
          importId: prepared.importId,
          shouldRelaunch: prepared.shouldRelaunch,
          summary: summaryFromManifest(prepared.manifest),
        };
      } catch (error) {
        const mapped = mapImportError(error);
        return {
          status: responseStatusForImportError(mapped),
          error: mapped,
        };
      }
    },
  );

  registerHandler(
    'migration:discard-extracted',
    async (_event: IpcMainInvokeEvent, payload: { extractedBundleDir: string }) => {
      const tempDir = app.getPath('temp');
      if (!isPathWithinDirectory(payload.extractedBundleDir, tempDir)) {
        return { discarded: false };
      }

      await fs.rm(path.resolve(payload.extractedBundleDir), { recursive: true, force: true });
      return { discarded: true };
    },
  );

  registerHandler('migration:consume-import-notice', () => ({
    notice: consumeMigrationImportNoticeSync(getDataPath()),
  }));

  registerHandler('migration:relaunch', () => {
    setImmediate(() => {
      app.relaunch();
      app.quit();
    });
  });
}
