/**
 * Index Health Service
 *
 * Provides startup health checks for indices and the ONNX model cache.
 * Detects corruption and recovers by deleting corrupted resources (they will rebuild lazily).
 *
 * Validates:
 * - ONNX model cache (embedding model file)
 * - LanceDB indices (conversation, tool, file)
 *
 * This runs early in startup, before embedding worker and index services are initialized.
 *
 * CODE SYNC NOTE: The validation logic in this file is duplicated in
 * src/main/workers/indexHealthWorker.ts (which runs in a utilityProcess
 * for timeout enforcement). When modifying validation logic, constants,
 * or error classification, keep BOTH files in sync.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { createScopedLogger } from '@core/logger';
import { getDataPath, isPackaged } from '@core/utils/dataPaths';
import { loadNativeModule } from '@core/utils/loadNativeModule';
import { getErrorReporter } from '@core/errorReporter';
import type { AppSettings } from '@shared/types';

const log = createScopedLogger({ service: 'indexHealth' });

/**
 * Format bytes as a human-readable string (e.g., "127.0 MB")
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Get the path relative to userData for safer reporting to Sentry.
 * Avoids exposing full absolute paths in telemetry.
 */
function getRelativePath(absolutePath: string): string {
  const userDataPath = getDataPath();
  if (absolutePath.startsWith(userDataPath)) {
    return absolutePath.slice(userDataPath.length + 1); // +1 to remove leading slash
  }
  return absolutePath;
}

/**
 * Report an index health event to Sentry with appropriate categorization.
 * - Native module errors: error level (infrastructure issue, needs investigation)
 * - Data corruption: warning level (auto-recovery is expected behavior)
 * - Unknown errors: error level (needs investigation)
 */
function reportToSentry(item: RecoveredItem, recovered: boolean): void {
  const errorType = item.errorType ?? 'unknown';
  
  // Choose message based on error type for better Sentry grouping
  const message = errorType === 'native_module_missing'
    ? 'Index health: native module unavailable'
    : errorType === 'data_corruption'
      ? 'Index health: corruption auto-recovered'
      : 'Index health: validation failed';
  
  // Native module errors and unknown errors are 'error' level (need investigation)
  // Data corruption is 'warning' level (expected, auto-recovered)
  const level = errorType === 'data_corruption' ? 'warning' : 'error';
  
  getErrorReporter().captureMessage(message, {
    level,
    tags: {
      area: 'startup',
      component: 'index-health',
      error_category: errorType,
      platform: process.platform,
      arch: process.arch,
    },
    fingerprint: ['index-health', item.type, errorType],
    extra: {
      corruptionType: item.type,
      errorMessage: item.error,
      relativePath: getRelativePath(item.path),
      recovered,
      isPackaged: isPackaged(),
    },
  });
}

// ONNX model configuration
const ONNX_MODEL_SUBPATH = 'Xenova/bge-small-en-v1.5/onnx/model.onnx';
// Minimum file size to catch obvious placeholders (OneDrive stubs are typically <1MB)
// This is a fast pre-flight check; actual model corruption is caught by ONNX runtime on load
const ONNX_MIN_FILE_SIZE = 10_000_000; // 10MB - catches OneDrive placeholders without being version-specific

// LanceDB table names (match the actual table names used by each service)
const CONVERSATION_TABLE_NAME = 'conversation_embeddings';
const TOOL_TABLE_NAME = 'tool_embeddings';
const FILE_TABLE_NAME = 'file_embeddings';

/**
 * Classification of validation errors to determine appropriate recovery action.
 * - native_module_missing: Native binding unavailable (packaging/install issue) - do NOT delete index
 * - data_corruption: Actual index data is corrupt - delete for rebuild
 * - unknown: Unclassified error - log but do NOT delete (conservative approach)
 */
export type ValidationErrorType = 'native_module_missing' | 'data_corruption' | 'unknown';

/** Represents a single recovered item */
export interface RecoveredItem {
  type: 'onnx-model' | 'lancedb-conversation' | 'lancedb-tool' | 'lancedb-file';
  path: string;
  error: string;
  /** Classification of the error - determines recovery action */
  errorType?: ValidationErrorType;
}

/** Result of the validation and recovery process */
export interface IndexHealthReport {
  /** Whether any recovery was performed */
  recovered: boolean;
  /** List of items that were recovered (deleted for rebuild) */
  items: RecoveredItem[];
}

/** Result of LanceDB validation */
type LanceDBValidationResult = 
  | { ok: true }
  | { ok: false; errorType: ValidationErrorType; message: string };

/**
 * Classify a LanceDB-related error to determine appropriate recovery action.
 * Returns the error category based on error message patterns.
 */
export function classifyLanceDBError(error: Error): ValidationErrorType {
  const msg = error.message;
  const code = (error as NodeJS.ErrnoException).code;
  
  // Node.js module resolution failures
  if (code === 'MODULE_NOT_FOUND' || msg.includes('Cannot find module')) {
    return 'native_module_missing';
  }
  
  // Windows DLL loading failures
  if (msg.includes('The specified module could not be found') ||
      msg.includes('is not a valid Win32 application') ||
      msg.includes('%1 is not a valid Win32 application')) {
    return 'native_module_missing';
  }
  
  // Dynamic library loading failures (cross-platform)
  if (msg.includes('ERR_DLOPEN_FAILED') ||
      msg.includes('dlopen') ||
      msg.includes('Module did not self-register')) {
    return 'native_module_missing';
  }
  
  // Node.js ABI/version mismatch
  if (msg.includes('NODE_MODULE_VERSION') ||
      msg.includes('compiled against a different Node.js version')) {
    return 'native_module_missing';
  }
  
  // macOS-specific loading failures
  if (msg.includes('wrong architecture') ||
      msg.includes('not a mach-o file') ||
      msg.includes('bad CPU type in executable') ||
      msg.includes('image not found')) {
    return 'native_module_missing';
  }
  
  // Linux shared library failures
  if (msg.includes('cannot open shared object file') ||
      msg.includes('undefined symbol')) {
    return 'native_module_missing';
  }
  
  // Permission/filesystem errors - don't delete, not corruption
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY' ||
      msg.includes('permission denied') ||
      msg.includes('access denied')) {
    return 'unknown';
  }
  
  // Disk space issues - don't delete, not corruption
  if (code === 'ENOSPC' || msg.includes('no space left')) {
    return 'unknown';
  }
  
  // Actual LanceDB/Arrow data corruption indicators
  if (msg.includes('IO error') ||
      msg.includes('corrupt') ||
      msg.includes('invalid magic') ||
      msg.includes('invalid schema') ||
      msg.includes('invalid footer')) {
    return 'data_corruption';
  }
  
  // Missing file errors - treat as data corruption so index can be rebuilt
  // These occur when LanceDB data files are deleted/moved/corrupted
  // Note: ENOENT is specifically for file not found, distinct from permission errors above
  if (code === 'ENOENT' ||
      msg.includes('Not found:') ||
      msg.includes('No such file or directory')) {
    return 'data_corruption';
  }
  
  // Default: unknown - do NOT delete (conservative approach per reviewer feedback)
  return 'unknown';
}

/**
 * Get the ONNX model cache directory
 */
function getModelCacheDir(): string {
  return path.join(getDataPath(), 'models', 'transformers');
}

/**
 * Get the full path to the ONNX model file
 */
function getOnnxModelPath(): string {
  return path.join(getModelCacheDir(), ONNX_MODEL_SUBPATH);
}

/**
 * Get the LanceDB directory for conversation index
 */
function getConversationLanceDBDir(): string {
  return path.join(getDataPath(), 'indices', 'global', 'conversations', 'lancedb');
}

/**
 * Get the LanceDB directory for tool index
 */
function getToolLanceDBDir(): string {
  return path.join(getDataPath(), 'indices', 'tools', 'lancedb');
}

/**
 * Get the LanceDB directory for file index (workspace-specific)
 * Returns null if no workspace is configured
 */
function getFileLanceDBDir(coreDirectory: string | undefined): string | null {
  if (!coreDirectory) {
    return null;
  }
  const workspaceHash = crypto.createHash('sha256').update(coreDirectory).digest('hex').slice(0, 16);
  return path.join(getDataPath(), 'indices', workspaceHash, 'lancedb');
}

/**
 * Validate the ONNX model cache
 * Returns an error message if corrupted, null if healthy or not present
 */
async function validateOnnxModel(): Promise<string | null> {
  const modelPath = getOnnxModelPath();

  try {
    const stats = await fs.stat(modelPath);

    if (!stats.isFile()) {
      return 'Model path is not a file';
    }

    if (stats.size < ONNX_MIN_FILE_SIZE) {
      return `Model file is too small (${formatBytes(stats.size)}, expected >${formatBytes(ONNX_MIN_FILE_SIZE)})`;
    }

    // Model file exists and has reasonable size
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Model doesn't exist yet - not an error, will be downloaded on first use
      return null;
    }
    // Other filesystem errors
    return `Failed to stat model file: ${(error as Error).message}`;
  }
}

/**
 * Validate a LanceDB index by attempting to connect and query.
 * Uses structured separation: native module loading is caught separately
 * from database operations to correctly classify errors.
 * 
 * Returns:
 * - { ok: true } if healthy or not present
 * - { ok: false, errorType, message } if validation failed
 */
async function validateLanceDBIndex(
  lanceDBDir: string,
  tableName: string
): Promise<LanceDBValidationResult> {
  try {
    // Check if directory exists first
    await fs.access(lanceDBDir);
  } catch {
    // Directory doesn't exist - not an error, index will be created on first use
    return { ok: true };
  }

  // Type aliases for cleaner code
  type LanceDBModule = typeof import('@lancedb/lancedb');
  type LanceDBConnection = Awaited<ReturnType<LanceDBModule['connect']>>;
  type LanceDBTable = Awaited<ReturnType<LanceDBConnection['openTable']>>;

  // Step 1: Try to load the native module (separate try-catch per reviewer feedback)
  // If this fails, it's 100% a module loading issue, not data corruption
  let lancedb: LanceDBModule;
  try {
    lancedb = loadNativeModule<LanceDBModule>('@lancedb/lancedb');
  } catch (error) {
    const err = error as Error;
    return {
      ok: false,
      errorType: 'native_module_missing',
      message: `LanceDB native module load failed: ${err.message}`,
    };
  }

  // Step 2: Try to connect and query the database
  let connection: LanceDBConnection | null = null;
  let table: LanceDBTable | null = null;

  try {
    connection = await lancedb.connect(lanceDBDir);

    const tableNames = await connection.tableNames();

    // Table doesn't exist - not an error, will be created on first use
    if (!tableNames.includes(tableName)) {
      return { ok: true };
    }

    // Try to open and query the table
    table = await connection.openTable(tableName);
    await table.query().limit(1).toArray();

    // Successfully queried - index is healthy
    return { ok: true };
  } catch (error) {
    const err = error as Error;
    const errorType = classifyLanceDBError(err);
    return {
      ok: false,
      errorType,
      message: `LanceDB validation failed: ${err.message}`,
    };
  } finally {
    // Close table first, then connection (table holds references that block deletion on Windows)
    // Note: close() is synchronous in LanceDB but we wrap in try/catch for safety
    try { table?.close(); } catch { /* ignore */ }
    try { connection?.close(); } catch { /* ignore */ }
  }
}

/**
 * Delete a directory and all its contents.
 * Uses retry options for Windows resilience (handles EBUSY/EPERM from lingering file handles).
 */
async function deleteDirectory(dirPath: string): Promise<void> {
  await fs.rm(dirPath, { 
    recursive: true, 
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}

/**
 * Clear the scanCompletedAt field in the file index metadata.
 * This signals to the file watcher that a full rescan is needed.
 * 
 * The metadata file is in the parent directory of the lancedb folder:
 * - lancedb path: userData/indices/<hash>/lancedb/
 * - metadata path: userData/indices/<hash>/index_metadata.json
 */
async function clearFileIndexScanMetadata(lanceDBDir: string): Promise<void> {
  const metadataPath = path.join(path.dirname(lanceDBDir), 'index_metadata.json');
  
  try {
    const data = await fs.readFile(metadataPath, 'utf-8');
    const metadata = JSON.parse(data);
    
    // Clear scan completion markers to trigger full rescan
    metadata.scanCompletedAt = null;
    metadata.totalFilesAtCompletion = null;
    
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    log.info({ metadataPath }, 'Cleared file index scan metadata to trigger full rescan');
  } catch (error) {
    // Metadata file may not exist (fresh install) - that's fine
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err: error, metadataPath }, 'Failed to clear file index scan metadata');
    }
  }
}

/**
 * Validate and recover corrupted indices and model cache.
 *
 * This should be called early in startup, before initializing embedding
 * worker or index services. It detects corruption and recovers by deleting
 * corrupted resources (they will rebuild lazily on next use).
 *
 * @param settings - App settings for checking workspace config and indexing enabled state
 * @returns Report of what was recovered
 */
export async function validateAndRecoverIndices(
  settings?: AppSettings
): Promise<IndexHealthReport> {
  const recoveredItems: RecoveredItem[] = [];
  const startTime = Date.now();

  log.info('Starting index health check');

  // 1. Validate ONNX model cache
  const onnxError = await validateOnnxModel();
  if (onnxError) {
    const modelCacheDir = getModelCacheDir();
    log.warn({ path: modelCacheDir, error: onnxError }, 'ONNX model cache corrupted, deleting for rebuild');

    try {
      await deleteDirectory(modelCacheDir);
      const recoveredItem: RecoveredItem = {
        type: 'onnx-model',
        path: modelCacheDir,
        error: onnxError,
        errorType: 'data_corruption', // ONNX issues are always treated as corruption (file validation only)
      };
      recoveredItems.push(recoveredItem);
      reportToSentry(recoveredItem, true);
    } catch (deleteError) {
      log.error({ err: deleteError, path: modelCacheDir }, 'Failed to delete corrupted ONNX model cache');
    }
  }

  // 2. Validate conversation index
  const conversationDir = getConversationLanceDBDir();
  const conversationResult = await validateLanceDBIndex(conversationDir, CONVERSATION_TABLE_NAME);
  if (!conversationResult.ok) {
    const shouldDelete = conversationResult.errorType === 'data_corruption';
    log.warn(
      { path: conversationDir, error: conversationResult.message, errorType: conversationResult.errorType, willDelete: shouldDelete },
      shouldDelete ? 'Conversation index corrupted, deleting for rebuild' : 'Conversation index validation failed (not deleting)'
    );

    const recoveredItem: RecoveredItem = {
      type: 'lancedb-conversation',
      path: conversationDir,
      error: conversationResult.message,
      errorType: conversationResult.errorType,
    };

    if (shouldDelete) {
      try {
        await deleteDirectory(conversationDir);
        recoveredItems.push(recoveredItem);
        reportToSentry(recoveredItem, true);
      } catch (deleteError) {
        log.error({ err: deleteError, path: conversationDir }, 'Failed to delete corrupted conversation index');
      }
    } else {
      // Report to Sentry but don't delete - this is a module/infra issue, not corruption
      reportToSentry(recoveredItem, false);
    }
  }

  // 3. Validate tool index
  const toolDir = getToolLanceDBDir();
  const toolResult = await validateLanceDBIndex(toolDir, TOOL_TABLE_NAME);
  if (!toolResult.ok) {
    const shouldDelete = toolResult.errorType === 'data_corruption';
    log.warn(
      { path: toolDir, error: toolResult.message, errorType: toolResult.errorType, willDelete: shouldDelete },
      shouldDelete ? 'Tool index corrupted, deleting for rebuild' : 'Tool index validation failed (not deleting)'
    );

    const recoveredItem: RecoveredItem = {
      type: 'lancedb-tool',
      path: toolDir,
      error: toolResult.message,
      errorType: toolResult.errorType,
    };

    if (shouldDelete) {
      try {
        await deleteDirectory(toolDir);
        recoveredItems.push(recoveredItem);
        reportToSentry(recoveredItem, true);
      } catch (deleteError) {
        log.error({ err: deleteError, path: toolDir }, 'Failed to delete corrupted tool index');
      }
    } else {
      reportToSentry(recoveredItem, false);
    }
  }

  // 4. Validate file index (only if indexing is enabled and workspace is configured)
  const indexingEnabled = settings?.indexingEnabled !== false;
  const coreDirectory = settings?.coreDirectory;

  if (indexingEnabled && coreDirectory) {
    const fileDir = getFileLanceDBDir(coreDirectory);
    if (fileDir) {
      const fileResult = await validateLanceDBIndex(fileDir, FILE_TABLE_NAME);
      if (!fileResult.ok) {
        const shouldDelete = fileResult.errorType === 'data_corruption';
        log.warn(
          { path: fileDir, error: fileResult.message, errorType: fileResult.errorType, willDelete: shouldDelete },
          shouldDelete ? 'File index corrupted, deleting for rebuild' : 'File index validation failed (not deleting)'
        );

        const recoveredItem: RecoveredItem = {
          type: 'lancedb-file',
          path: fileDir,
          error: fileResult.message,
          errorType: fileResult.errorType,
        };

        if (shouldDelete) {
          try {
            await deleteDirectory(fileDir);
            
            // Clear scanCompletedAt in metadata to trigger full rescan on next startup
            await clearFileIndexScanMetadata(fileDir);
            
            recoveredItems.push(recoveredItem);
            reportToSentry(recoveredItem, true);
          } catch (deleteError) {
            log.error({ err: deleteError, path: fileDir }, 'Failed to delete corrupted file index');
          }
        } else {
          reportToSentry(recoveredItem, false);
        }
      }
    }
  } else if (!indexingEnabled) {
    log.debug('Skipping file index check: indexing is disabled');
  } else if (!coreDirectory) {
    log.debug('Skipping file index check: no workspace configured');
  }

  const elapsedMs = Date.now() - startTime;

  // Log summary
  if (recoveredItems.length > 0) {
    log.warn(
      {
        recoveredCount: recoveredItems.length,
        items: recoveredItems.map(i => ({ type: i.type, error: i.error })),
        elapsedMs,
      },
      'Index health check completed with recovery'
    );
  } else {
    log.info({ elapsedMs }, 'Index health check completed - all indices healthy');
  }

  return {
    recovered: recoveredItems.length > 0,
    items: recoveredItems,
  };
}
