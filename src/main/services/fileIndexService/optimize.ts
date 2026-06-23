/**
 * File Index Service — LanceDB optimize / version cleanup.
 *
 * Owns the optimize backoff state (local to this cluster) and the
 * optimize/maybeOptimize lifecycle. Extracted from `fileIndexService/index.ts`
 * (Stage B4). Behavior-preserving move only.
 *
 * Two shared dependencies are injected once at module load via `wireOptimize(...)`
 * rather than imported: the `currentIndex` getter and the `withWriteLock` mutation
 * lock. Both are now owned by `./state` (Stage C2); index.ts re-points the wiring
 * at that owner. The injection (vs a direct `./state` import) is retained to keep
 * the dependency graph acyclic and the wiring uniform across the extracted modules.
 *
 * The one cross-read in the other direction — `closeIndexInternal` waiting out
 * an in-flight optimize — reads this module's `isOptimizing()` accessor.
 */

import { logger } from '@core/logger';

type LanceDBConnection = Awaited<ReturnType<typeof import('@lancedb/lancedb').connect>>;
type LanceDBTable = Awaited<ReturnType<LanceDBConnection['openTable']>>;

const FILE_VECTORS_TABLE_NAME = 'file_vectors';
const FILE_NEIGHBORS_TABLE_NAME = 'file_neighbors';

// LanceDB version cleanup configuration
// LanceDB creates a new version on every write (add/delete/update), which can lead to
// significant storage bloat if not periodically cleaned up via optimize().
const OPTIMIZE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes minimum between optimizations
const OPTIMIZE_RETENTION_MS = 60 * 60 * 1000; // Keep 1 hour of version history
const OPTIMIZE_AFTER_WRITES = 500; // Trigger optimization after this many writes

let lastOptimizeTime = 0;
let lastOptimizeAttemptTime = 0; // Tracks attempts to prevent thrashing on failures
let _isOptimizing = false;
let writesSinceLastOptimize = 0;
let optimizeFailureCount = 0; // For exponential backoff on repeated failures

/**
 * The subset of the WorkspaceIndex singleton this cluster reads. Kept
 * structurally minimal so optimize.ts does not depend on the full internal
 * WorkspaceIndex type (which is owned by ./state since Stage C2).
 */
interface OptimizableIndex {
  table: LanceDBTable | null;
  fileVectorsTable: LanceDBTable | null;
  fileNeighborsTable: LanceDBTable | null;
  workspacePath: string;
}

let _getCurrentIndex: () => OptimizableIndex | null = () => null;
let _withWriteLock: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn();

/**
 * Inject the shared dependencies (the `currentIndex` getter and the
 * `withWriteLock` mutation lock, both owned by ./state since Stage C2). Called
 * once at index.ts module load.
 */
export function wireOptimize(deps: {
  getCurrentIndex: () => OptimizableIndex | null;
  withWriteLock: <T>(fn: () => Promise<T>) => Promise<T>;
}): void {
  _getCurrentIndex = deps.getCurrentIndex;
  _withWriteLock = deps.withWriteLock;
}

/** @internal — cross-read for `closeIndexInternal` to wait out an in-flight optimize. */
export function isOptimizing(): boolean {
  return _isOptimizing;
}

/**
 * Optimize the LanceDB table to clean up old versions and compact data.
 * LanceDB creates a new version on every write operation (add/delete/update), which
 * can lead to significant storage bloat if not periodically cleaned up.
 *
 * This function:
 * - Compacts fragmented data files
 * - Prunes old version manifests (keeping only recent history)
 * - Uses exponential backoff on failures to prevent thrashing
 */
export async function optimizeIndex(): Promise<void> {
  return _withWriteLock(() => optimizeIndexInternal());
}

/**
 * Internal: Actual optimization logic. Called from locked context.
 */
async function optimizeIndexInternal(): Promise<void> {
  // Capture current workspace to avoid race conditions on workspace switch
  const index = _getCurrentIndex();
  if ((!index?.table && !index?.fileVectorsTable && !index?.fileNeighborsTable) || _isOptimizing) return;

  const workspacePath = index.workspacePath;
  _isOptimizing = true;
  lastOptimizeAttemptTime = Date.now();

  try {
    const cleanupOlderThan = new Date(Date.now() - OPTIMIZE_RETENTION_MS);
    let hadFailure = false;
    const nextFailureCount = optimizeFailureCount + 1;

    if (index.table) {
      try {
        const startTime = Date.now();
        const stats = await index.table.optimize({ cleanupOlderThan });
        logger.info({
          versionsRemoved: stats.prune?.oldVersionsRemoved ?? 0,
          bytesFreed: stats.prune?.bytesRemoved ?? 0,
          durationMs: Date.now() - startTime,
          workspace: workspacePath
        }, 'Optimized file index');
      } catch (err) {
        hadFailure = true;
        logger.warn({ err, failureCount: nextFailureCount }, 'Failed to optimize file index');
      }
    }

    if (index.fileVectorsTable) {
      try {
        const startTime = Date.now();
        const stats = await index.fileVectorsTable.optimize({ cleanupOlderThan });
        logger.info({
          tableName: FILE_VECTORS_TABLE_NAME,
          versionsRemoved: stats.prune?.oldVersionsRemoved ?? 0,
          bytesFreed: stats.prune?.bytesRemoved ?? 0,
          durationMs: Date.now() - startTime,
          workspace: workspacePath
        }, 'Optimized file vectors index');
      } catch (err) {
        hadFailure = true;
        logger.warn(
          { err, failureCount: nextFailureCount, tableName: FILE_VECTORS_TABLE_NAME },
          'Failed to optimize file vectors index'
        );
      }
    }

    if (index.fileNeighborsTable) {
      try {
        const startTime = Date.now();
        const stats = await index.fileNeighborsTable.optimize({ cleanupOlderThan });
        logger.info({
          tableName: FILE_NEIGHBORS_TABLE_NAME,
          versionsRemoved: stats.prune?.oldVersionsRemoved ?? 0,
          bytesFreed: stats.prune?.bytesRemoved ?? 0,
          durationMs: Date.now() - startTime,
          workspace: workspacePath
        }, 'Optimized file neighbors index');
      } catch (err) {
        hadFailure = true;
        logger.warn(
          { err, failureCount: nextFailureCount, tableName: FILE_NEIGHBORS_TABLE_NAME },
          'Failed to optimize file neighbors index'
        );
      }
    }

    if (hadFailure) {
      optimizeFailureCount = nextFailureCount;
      return;
    }

    // Only update success metrics if workspace hasn't changed
    if (_getCurrentIndex()?.workspacePath === workspacePath) {
      lastOptimizeTime = Date.now();
      writesSinceLastOptimize = 0;
      optimizeFailureCount = 0; // Reset backoff on success
    }
  } catch (err) {
    optimizeFailureCount++;
    logger.warn({ err, failureCount: optimizeFailureCount }, 'Failed to optimize file index');
  } finally {
    _isOptimizing = false;
  }
}

/**
 * Check if optimization should run and trigger it in background if needed.
 * Called after write operations (add, delete, update) from WITHIN a locked context.
 *
 * Uses multiple guards to prevent excessive optimization:
 * - Minimum interval between optimizations
 * - Minimum writes threshold
 * - Exponential backoff on failures
 *
 * NOTE: This is called from within locked context, so it schedules optimization
 * via the public optimizeIndex() which will queue behind the current write.
 */
export function maybeOptimize(): void {
  writesSinceLastOptimize++;

  // Don't optimize if not enough writes since last optimize
  if (writesSinceLastOptimize < OPTIMIZE_AFTER_WRITES) return;

  // Don't optimize if too soon since last successful optimize
  if (Date.now() - lastOptimizeTime < OPTIMIZE_INTERVAL_MS) return;

  // Don't optimize if already in progress
  if (_isOptimizing) return;

  // Exponential backoff on failures: wait 2^failureCount * 30 seconds after failure
  // This prevents thrashing when optimize consistently fails
  if (optimizeFailureCount > 0) {
    const backoffMs = Math.min(
      Math.pow(2, optimizeFailureCount) * 30000,
      OPTIMIZE_INTERVAL_MS // Cap at normal interval
    );
    if (Date.now() - lastOptimizeAttemptTime < backoffMs) return;
  }

  // Fire and forget - schedules optimization via the write queue
  // This will run AFTER the current write completes (since we're in locked context)
  // Silent-failure rule: log structured warn rather than swallowing the
  // rejection — `optimizeIndexInternal` already logs its own errors at warn,
  // but a rejection bubbling out (e.g. write-lock chain failure) must still
  // surface here.
  optimizeIndex().catch(err => logger.warn({ err }, 'optimizeIndex background failure'));
}
