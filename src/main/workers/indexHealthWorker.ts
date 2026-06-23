/**
 * Index Health Worker (utilityProcess)
 *
 * Runs index health validation in a separate OS process so that it can be
 * forcibly killed on timeout. This solves the problem where LanceDB native
 * FFI calls block the Node.js event loop, preventing setTimeout from firing.
 *
 * Communication protocol:
 * - validate: Run validateAndRecoverIndices with provided settings
 * - Returns result/error message
 *
 * IMPORTANT: This runs in a utilityProcess, NOT a worker_thread.
 * - Use `process.parentPort` for communication
 * - No access to Electron APIs (app, BrowserWindow, etc.)
 * - Paths must be passed via message, not read from electron.app
 *
 * CODE SYNC NOTE: This file duplicates validation logic from
 * src/main/services/indexHealthService.ts because utilityProcess cannot
 * import modules that depend on electron.app (for app.getPath, app.isPackaged).
 * When modifying validation logic, constants, or error classification,
 * keep BOTH files in sync. Sentry reporting is handled by the main process
 * after receiving this worker's report.
 */

// MUST be the very first import — see docs/plans/260428_graceful_fs_emfile_fix.md
import '../startup/installGracefulFs';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

// Types
type LanceDBModule = typeof import('@lancedb/lancedb');
type LanceDBConnection = Awaited<ReturnType<LanceDBModule['connect']>>;
type LanceDBTable = Awaited<ReturnType<LanceDBConnection['openTable']>>;

// Get parentPort from process (utilityProcess pattern)
const parentPort = process.parentPort;
if (!parentPort) {
  throw new Error('Index health worker must be spawned via utilityProcess');
}

// Configuration
const ONNX_MODEL_SUBPATH = 'Xenova/bge-small-en-v1.5/onnx/model.onnx';
const ONNX_MIN_FILE_SIZE = 10_000_000; // 10MB
const CONVERSATION_TABLE_NAME = 'conversation_embeddings';
const TOOL_TABLE_NAME = 'tool_embeddings';
const FILE_TABLE_NAME = 'file_embeddings';

// Types matching indexHealthService
type ValidationErrorType = 'native_module_missing' | 'data_corruption' | 'unknown';

interface RecoveredItem {
  type: 'onnx-model' | 'lancedb-conversation' | 'lancedb-tool' | 'lancedb-file';
  path: string;
  error: string;
  errorType?: ValidationErrorType;
}

interface IndexHealthReport {
  recovered: boolean;
  items: RecoveredItem[];
}

type LanceDBValidationResult = 
  | { ok: true }
  | { ok: false; errorType: ValidationErrorType; message: string };

interface WorkerMessage {
  type: 'validate';
  settings: WorkerSettings;
}

interface WorkerSettings {
  userDataPath: string;
  coreDirectory?: string;
  indexingEnabled?: boolean;
  unpackedNodeModules?: string;
}

interface WorkerResponse {
  type: 'result' | 'error';
  report?: IndexHealthReport;
  error?: string;
}

// State
let nativeRequire: NodeRequire | null = null;

function sendResponse(response: WorkerResponse): void {
  parentPort.postMessage(response);
}

function createNativeRequire(unpackedNodeModules?: string): NodeRequire {
  if (unpackedNodeModules) {
    const unpackedPath = path.join(unpackedNodeModules, '.package-lock.json');
    return createRequire(unpackedPath);
  }
  return createRequire(__filename);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function classifyLanceDBError(error: Error): ValidationErrorType {
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
  
  // Dynamic library loading failures
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
  
  // Permission/filesystem errors - don't delete
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY' ||
      msg.includes('permission denied') ||
      msg.includes('access denied')) {
    return 'unknown';
  }
  
  // Disk space issues - don't delete
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
  
  return 'unknown';
}

function getModelCacheDir(userDataPath: string): string {
  return path.join(userDataPath, 'models', 'transformers');
}

function getOnnxModelPath(userDataPath: string): string {
  return path.join(getModelCacheDir(userDataPath), ONNX_MODEL_SUBPATH);
}

function getConversationLanceDBDir(userDataPath: string): string {
  return path.join(userDataPath, 'indices', 'global', 'conversations', 'lancedb');
}

function getToolLanceDBDir(userDataPath: string): string {
  return path.join(userDataPath, 'indices', 'tools', 'lancedb');
}

function getFileLanceDBDir(userDataPath: string, coreDirectory: string | undefined): string | null {
  if (!coreDirectory) {
    return null;
  }
  const workspaceHash = crypto.createHash('sha256').update(coreDirectory).digest('hex').slice(0, 16);
  return path.join(userDataPath, 'indices', workspaceHash, 'lancedb');
}

async function validateOnnxModel(userDataPath: string): Promise<string | null> {
  const modelPath = getOnnxModelPath(userDataPath);

  try {
    const stats = await fs.stat(modelPath);

    if (!stats.isFile()) {
      return 'Model path is not a file';
    }

    if (stats.size < ONNX_MIN_FILE_SIZE) {
      return `Model file is too small (${formatBytes(stats.size)}, expected >${formatBytes(ONNX_MIN_FILE_SIZE)})`;
    }

    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    return `Failed to stat model file: ${(error as Error).message}`;
  }
}

async function validateLanceDBIndex(
  lanceDBDir: string,
  tableName: string
): Promise<LanceDBValidationResult> {
  try {
    await fs.access(lanceDBDir);
  } catch {
    return { ok: true };
  }

  // Step 1: Try to load the native module
  let lancedb: LanceDBModule;
  try {
    if (!nativeRequire) {
      return { ok: false, errorType: 'native_module_missing', message: 'Native require not initialized' };
    }
    lancedb = nativeRequire('@lancedb/lancedb') as LanceDBModule;
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

    if (!tableNames.includes(tableName)) {
      return { ok: true };
    }

    table = await connection.openTable(tableName);
    await table.query().limit(1).toArray();

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
    try { table?.close(); } catch { /* ignore */ }
    try { connection?.close(); } catch { /* ignore */ }
  }
}

async function deleteDirectory(dirPath: string): Promise<void> {
  await fs.rm(dirPath, { 
    recursive: true, 
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}

async function clearFileIndexScanMetadata(lanceDBDir: string): Promise<void> {
  const metadataPath = path.join(path.dirname(lanceDBDir), 'index_metadata.json');
  
  try {
    const data = await fs.readFile(metadataPath, 'utf-8');
    const metadata = JSON.parse(data);
    
    metadata.scanCompletedAt = null;
    metadata.totalFilesAtCompletion = null;
    
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('Failed to clear file index scan metadata:', error);
    }
  }
}

async function validateAndRecoverIndices(settings: WorkerSettings): Promise<IndexHealthReport> {
  const recoveredItems: RecoveredItem[] = [];
  const { userDataPath, coreDirectory, indexingEnabled } = settings;

  console.warn('[indexHealthWorker] Starting index health check');

  // 1. Validate ONNX model cache
  const onnxError = await validateOnnxModel(userDataPath);
  if (onnxError) {
    const modelCacheDir = getModelCacheDir(userDataPath);
    console.warn('[indexHealthWorker] ONNX model cache corrupted, deleting for rebuild:', onnxError);

    try {
      await deleteDirectory(modelCacheDir);
      recoveredItems.push({
        type: 'onnx-model',
        path: modelCacheDir,
        error: onnxError,
        errorType: 'data_corruption',
      });
    } catch (deleteError) {
      console.error('[indexHealthWorker] Failed to delete corrupted ONNX model cache:', deleteError);
    }
  }

  // 2. Validate conversation index
  const conversationDir = getConversationLanceDBDir(userDataPath);
  const conversationResult = await validateLanceDBIndex(conversationDir, CONVERSATION_TABLE_NAME);
  if (!conversationResult.ok) {
    const shouldDelete = conversationResult.errorType === 'data_corruption';
    console.warn('[indexHealthWorker] Conversation index validation:', conversationResult.message, 'willDelete:', shouldDelete);

    if (shouldDelete) {
      try {
        await deleteDirectory(conversationDir);
        recoveredItems.push({
          type: 'lancedb-conversation',
          path: conversationDir,
          error: conversationResult.message,
          errorType: conversationResult.errorType,
        });
      } catch (deleteError) {
        console.error('[indexHealthWorker] Failed to delete corrupted conversation index:', deleteError);
      }
    }
  }

  // 3. Validate tool index
  const toolDir = getToolLanceDBDir(userDataPath);
  const toolResult = await validateLanceDBIndex(toolDir, TOOL_TABLE_NAME);
  if (!toolResult.ok) {
    const shouldDelete = toolResult.errorType === 'data_corruption';
    console.warn('[indexHealthWorker] Tool index validation:', toolResult.message, 'willDelete:', shouldDelete);

    if (shouldDelete) {
      try {
        await deleteDirectory(toolDir);
        recoveredItems.push({
          type: 'lancedb-tool',
          path: toolDir,
          error: toolResult.message,
          errorType: toolResult.errorType,
        });
      } catch (deleteError) {
        console.error('[indexHealthWorker] Failed to delete corrupted tool index:', deleteError);
      }
    }
  }

  // 4. Validate file index (only if workspace configured and indexing enabled)
  if (indexingEnabled !== false && coreDirectory) {
    const fileDir = getFileLanceDBDir(userDataPath, coreDirectory);
    if (fileDir) {
      const fileResult = await validateLanceDBIndex(fileDir, FILE_TABLE_NAME);
      if (!fileResult.ok) {
        const shouldDelete = fileResult.errorType === 'data_corruption';
        console.warn('[indexHealthWorker] File index validation:', fileResult.message, 'willDelete:', shouldDelete);

        if (shouldDelete) {
          try {
            await deleteDirectory(fileDir);
            await clearFileIndexScanMetadata(fileDir);
            recoveredItems.push({
              type: 'lancedb-file',
              path: fileDir,
              error: fileResult.message,
              errorType: fileResult.errorType,
            });
          } catch (deleteError) {
            console.error('[indexHealthWorker] Failed to delete corrupted file index:', deleteError);
          }
        }
      }
    }
  }

  const report: IndexHealthReport = {
    recovered: recoveredItems.length > 0,
    items: recoveredItems,
  };

  console.warn('[indexHealthWorker] Index health check completed:', JSON.stringify(report));
  return report;
}

async function handleMessage(msg: WorkerMessage): Promise<void> {
  try {
    if (msg.type !== 'validate') {
      throw new Error(`Unknown message type: ${msg.type}`);
    }

    // Initialize native require with the correct path
    nativeRequire = createNativeRequire(msg.settings.unpackedNodeModules);

    const report = await validateAndRecoverIndices(msg.settings);
    sendResponse({ type: 'result', report });
  } catch (error) {
    sendResponse({
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

parentPort.on('message', (event: { data: WorkerMessage }) => {
  fireAndForget(handleMessage(event.data), 'indexHealthWorker.handleMessage');
});
