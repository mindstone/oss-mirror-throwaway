/**
 * File Index Service — the single owner of `file_vectors` row writes (Stage C1).
 *
 * ## Why this module exists
 *
 * `file_vectors` is the file-level vector table derived from the chunk-level
 * `file_embeddings` rows. Historically the *production* of a row already funneled
 * through one function (`recomputeFileVectorRow`), but that function lived inline
 * in the 5k-line `index.ts` alongside its four callers, so "who writes a
 * file_vectors row, and when relative to a delete" was hard to reason about —
 * the root of the reconcile/lazy-fill ghost-rows race (260527). This module makes
 * that single producer the *explicit, sole owner* of the write, with a documented
 * contract, and routes all four call-sites through it:
 *
 *   1. `indexFileInternal`                         (re-index a file)
 *   2. `updateChunkEmbeddingInternal`              (enhancement re-embeds a chunk)
 *   3. `lazyFillFileVectorsForWorkspace`           (backfill missing rows)
 *   4. `reconcileFileVectorsForWorkspace`          (repair stale/orphan rows)
 *
 * ## The write contract — `recomputeFileVectorRow(filePath, chunks)`
 *
 * "Compute the file-level vector for `filePath` from its chunk vectors, then
 * persist (or remove) exactly one `file_vectors` row to reflect it."
 *
 * - **Caller holds the write lock.** This is an `*Internal`-style routine: it
 *   performs LanceDB mutations directly and assumes the caller already entered
 *   `withWriteLock` (REBEL-JK serialization). It never acquires the lock itself.
 * - **Single row per path.** A successful compute deletes any existing row for
 *   `filePath` and writes the freshly-averaged record — never two rows for one
 *   path. A degenerate input (no chunks / non-finite / mismatched dims) removes
 *   the row instead of writing one.
 * - **Return value is the observable outcome:**
 *     - `'written'`  — a row was persisted for `filePath`.
 *     - `'skipped'`  — input could not produce a vector; any existing row was
 *                      deleted (so the table never keeps a stale ghost row).
 *     - `'failed'`   — the persist threw; logged at warn, no throw propagated.
 * - **Cascade + schedule are delegated, not owned here.** After a write/skip the
 *   owner invalidates the dependent `file_neighbors` rows. Successful writes also
 *   schedule the fire-and-forget neighbors fill through the Stage 7 trailing
 *   debounce + max-wait trigger below, so bursts of file_vectors writes coalesce
 *   into bounded neighbors passes.
 *
 * ## Dependency injection
 *
 * Following the Stage B4 `optimize.ts` pattern: the shared `currentIndex`
 * singleton (now owned by `./state` since Stage C2) and the cross-cluster helpers
 * (`toNumberVector`, `invalidateFileNeighborsForVectorWrite`, and the
 * `startLazyFillFileNeighborsAsync` scheduler — all owned by `./vectorsDerive`
 * since Stage D1 — plus `deleteFileVectorRowsByPaths`, which stays index.ts-local)
 * are injected once at module load via `wireFileVectorsWriter(...)`. This avoids a
 * circular import and keeps the wiring uniform across the extracted modules.
 *
 * Behavior-preserving: identical write semantics, identical write-lock
 * serialization (caller-held), identical single-flight, identical observable
 * outcomes. No logic edits beyond the mechanical routing/extraction.
 */

import { logger } from '@core/logger';
import { eq } from '../../utils/lancedbPredicates';
import { computeAveragedNormalizedVector } from '@core/utils/vectorMath';
import { getEmbeddingGenerator } from '@core/embeddingGenerator';
import { ReadTableHandle } from './readTableHandle';
import { markFileNeighborsEpochMutated } from './state';

type LanceDBConnection = Awaited<ReturnType<typeof import('@lancedb/lancedb').connect>>;
type LanceDBTable = Awaited<ReturnType<LanceDBConnection['openTable']>>;

const FILE_VECTORS_TABLE_NAME = 'file_vectors';
const FILE_NEIGHBOR_WRITE_TRIGGER_DEBOUNCE_MS = 1_000;
const FILE_NEIGHBOR_WRITE_TRIGGER_MAX_WAIT_MS = 5_000;

/**
 * The chunk-level source rows a file vector is averaged from. Owned here because
 * `recomputeFileVectorRow` (and its skip-reason helper) are the only consumers
 * that need the full shape; index.ts re-imports the type for its
 * `readChunksForFileVector` projection.
 *
 * Structurally identical to the corresponding `Pick<FileEmbeddingRecord, ...>` in
 * index.ts. Defined locally (rather than imported from `./index`) so the writer
 * has no import edge back to index.ts — matching the `optimize.ts` precedent and
 * keeping the dependency graph acyclic (the only edge is index → writer).
 */
export type FileVectorSourceChunk = {
  path: string;
  relativePath: string;
  extension: string;
  mtime: number;
  indexedAt: number;
  enhanced_at: number;
  vector: number[] | Float32Array;
};

/**
 * The persisted file-level vector row. Structurally identical to index.ts's
 * exported `FileVectorRecord`; defined locally to avoid an import edge back to
 * index.ts (see `FileVectorSourceChunk` note).
 */
type FileVectorRecord = {
  path: string;
  relative_path: string;
  vector: number[];
  chunk_count: number;
  extension: string;
  source_max_chunk_mtime: number;
  source_max_indexed_at: number;
  source_max_enhanced_at: number;
  source_chunk_count: number;
  computed_at: number;
};

/**
 * The subset of the WorkspaceIndex singleton this writer reads/mutates. Kept
 * structurally minimal so the writer does not depend on the full internal
 * WorkspaceIndex type (which is owned by ./state since Stage C2). `fileVectorsTable`
 * and `fileVectorsReadTable` are lazily created/swapped in place here, exactly as
 * the inline code did.
 */
interface WriterIndex {
  connection: LanceDBConnection;
  readConnection: LanceDBConnection;
  fileVectorsTable: LanceDBTable | null;
  fileVectorsReadTable: ReadTableHandle | null;
}

/**
 * Shared dependencies injected once at module load (see the file-level JSDoc for
 * each one's current owner).
 *
 * - `getCurrentIndex`               — the live `currentIndex` singleton (or null),
 *                                     owned by ./state (Stage C2).
 * - `toNumberVector`                — Float32Array→number[] normalization helper,
 *                                     owned by ./vectorsDerive (Stage D1).
 * - `deleteFileVectorRowsByPaths`   — the file_vectors row deleter, index.ts-local
 *                                     (shared with the removal cluster).
 * - `invalidateFileNeighborsForVectorWrite` — neighbor-cache cascade, owned by
 *                                     ./vectorsDerive (Stage D1).
 * - `startLazyFillFileNeighborsAsync`       — the fire-and-forget neighbors-fill
 *                                     scheduler, owned by ./vectorsDerive (Stage D1);
 *                                     called through the Stage 7 debounce below.
 */
interface FileVectorsWriterDeps {
  getCurrentIndex: () => WriterIndex | null;
  toNumberVector: (vector: number[] | Float32Array) => number[];
  deleteFileVectorRowsByPaths: (pathsToDelete: string[]) => Promise<void>;
  invalidateFileNeighborsForVectorWrite: (
    filePath: string,
    sourceRecord?: Pick<
      FileVectorRecord,
      | 'path'
      | 'relative_path'
      | 'source_max_chunk_mtime'
      | 'source_max_indexed_at'
      | 'source_max_enhanced_at'
      | 'source_chunk_count'
    >
  ) => Promise<void>;
  startLazyFillFileNeighborsAsync: () => void;
}

let _getCurrentIndex: FileVectorsWriterDeps['getCurrentIndex'] = () => null;
let _toNumberVector: FileVectorsWriterDeps['toNumberVector'] = (vector) =>
  Array.isArray(vector) ? vector : Array.from(vector);
let _deleteFileVectorRowsByPaths: FileVectorsWriterDeps['deleteFileVectorRowsByPaths'] = async () => {};
let _invalidateFileNeighborsForVectorWrite: FileVectorsWriterDeps['invalidateFileNeighborsForVectorWrite'] =
  async () => {};
let _startLazyFillFileNeighborsAsync: FileVectorsWriterDeps['startLazyFillFileNeighborsAsync'] = () => {};
let fileNeighborWriteTriggerDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let fileNeighborWriteTriggerMaxWaitTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Inject the shared dependencies (current owners noted in the deps JSDoc above).
 * Called once at index.ts module load (alongside `wireOptimize`).
 */
export function wireFileVectorsWriter(deps: FileVectorsWriterDeps): void {
  _getCurrentIndex = deps.getCurrentIndex;
  _toNumberVector = deps.toNumberVector;
  _deleteFileVectorRowsByPaths = deps.deleteFileVectorRowsByPaths;
  _invalidateFileNeighborsForVectorWrite = deps.invalidateFileNeighborsForVectorWrite;
  _startLazyFillFileNeighborsAsync = deps.startLazyFillFileNeighborsAsync;
}

function flushFileNeighborWriteTrigger(): void {
  if (fileNeighborWriteTriggerDebounceTimer) {
    clearTimeout(fileNeighborWriteTriggerDebounceTimer);
    fileNeighborWriteTriggerDebounceTimer = null;
  }
  if (fileNeighborWriteTriggerMaxWaitTimer) {
    clearTimeout(fileNeighborWriteTriggerMaxWaitTimer);
    fileNeighborWriteTriggerMaxWaitTimer = null;
  }

  _startLazyFillFileNeighborsAsync();
}

function clearFileNeighborWriteTriggerTimers(): void {
  if (fileNeighborWriteTriggerDebounceTimer) {
    clearTimeout(fileNeighborWriteTriggerDebounceTimer);
    fileNeighborWriteTriggerDebounceTimer = null;
  }
  if (fileNeighborWriteTriggerMaxWaitTimer) {
    clearTimeout(fileNeighborWriteTriggerMaxWaitTimer);
    fileNeighborWriteTriggerMaxWaitTimer = null;
  }
}

function scheduleFileNeighborWriteTrigger(): void {
  if (fileNeighborWriteTriggerDebounceTimer) {
    clearTimeout(fileNeighborWriteTriggerDebounceTimer);
  }

  if (!fileNeighborWriteTriggerMaxWaitTimer) {
    fileNeighborWriteTriggerMaxWaitTimer = setTimeout(() => {
      flushFileNeighborWriteTrigger();
    }, FILE_NEIGHBOR_WRITE_TRIGGER_MAX_WAIT_MS);
  }

  fileNeighborWriteTriggerDebounceTimer = setTimeout(() => {
    flushFileNeighborWriteTrigger();
  }, FILE_NEIGHBOR_WRITE_TRIGGER_DEBOUNCE_MS);
}

/** @internal — test seam: flush the per-write neighbors trigger debounce. */
export function _flushFileNeighborWriteTriggerForTesting(): void {
  if (fileNeighborWriteTriggerDebounceTimer || fileNeighborWriteTriggerMaxWaitTimer) {
    flushFileNeighborWriteTrigger();
  }
}

/** @internal — test seam for the debounce/max-wait scheduler. */
export function _scheduleFileNeighborWriteTriggerForTesting(start: () => void): () => void {
  const previousStart = _startLazyFillFileNeighborsAsync;
  _startLazyFillFileNeighborsAsync = start;
  scheduleFileNeighborWriteTrigger();
  return () => {
    clearFileNeighborWriteTriggerTimers();
    _startLazyFillFileNeighborsAsync = previousStart;
  };
}

function logFileVectorSkipped(
  path: string,
  reason: 'empty_chunks' | 'invalid_vectors' | 'mismatched_dimensions',
  chunkCount: number
): void {
  logger.warn({ path, reason, chunkCount }, 'file_vectors.skipped');
}

function getFileVectorSkipReason(
  chunks: FileVectorSourceChunk[]
): 'empty_chunks' | 'invalid_vectors' | 'mismatched_dimensions' {
  if (chunks.length === 0) {
    return 'empty_chunks';
  }

  const firstVectorLength = chunks[0].vector.length;
  for (const chunk of chunks) {
    if (chunk.vector.length !== firstVectorLength) {
      return 'mismatched_dimensions';
    }
    const vector = chunk.vector;
    for (let i = 0; i < vector.length; i++) {
      if (!Number.isFinite(vector[i])) {
        return 'invalid_vectors';
      }
    }
  }

  return 'invalid_vectors';
}

function buildFileVectorRecord(
  filePath: string,
  chunks: FileVectorSourceChunk[],
  vector: number[],
  computedAt: number
): FileVectorRecord {
  const firstChunk = chunks[0];
  let sourceMaxChunkMtime = 0;
  let sourceMaxIndexedAt = 0;
  let sourceMaxEnhancedAt = 0;

  for (const chunk of chunks) {
    sourceMaxChunkMtime = Math.max(sourceMaxChunkMtime, chunk.mtime ?? 0);
    sourceMaxIndexedAt = Math.max(sourceMaxIndexedAt, chunk.indexedAt ?? 0);
    sourceMaxEnhancedAt = Math.max(sourceMaxEnhancedAt, chunk.enhanced_at ?? 0);
  }

  return {
    path: filePath,
    relative_path: firstChunk.relativePath,
    vector,
    chunk_count: chunks.length,
    extension: firstChunk.extension,
    source_max_chunk_mtime: sourceMaxChunkMtime,
    source_max_indexed_at: sourceMaxIndexedAt,
    source_max_enhanced_at: sourceMaxEnhancedAt,
    source_chunk_count: chunks.length,
    computed_at: computedAt,
  };
}

async function openFileVectorsReadHandle(): Promise<void> {
  const index = _getCurrentIndex();
  if (!index?.fileVectorsTable) {
    return;
  }

  const oldReadHandle = index.fileVectorsReadTable;
  const newReadTable = await index.readConnection.openTable(FILE_VECTORS_TABLE_NAME);
  index.fileVectorsReadTable = new ReadTableHandle(newReadTable);
  if (oldReadHandle) await oldReadHandle.retire();
}

async function ensureFileVectorsTable(recordForCreate: FileVectorRecord): Promise<{
  table: LanceDBTable;
  createdWithRecord: boolean;
}> {
  const index = _getCurrentIndex();
  if (!index) {
    throw new Error('Cannot create file_vectors table without an active index');
  }

  if (index.fileVectorsTable) {
    return { table: index.fileVectorsTable, createdWithRecord: false };
  }

  const tableNames = await index.connection.tableNames();
  if (tableNames.includes(FILE_VECTORS_TABLE_NAME)) {
    try {
      await index.connection.dropTable(FILE_VECTORS_TABLE_NAME);
    } catch (err) {
      logger.warn(
        { err, tableName: FILE_VECTORS_TABLE_NAME, reason: 'orphan_table_without_active_handle' },
        'file_vectors.orphan_drop_failure'
      );
      throw err;
    }
    logger.info(
      { tableName: FILE_VECTORS_TABLE_NAME, reason: 'orphan_table_without_active_handle' },
      'file_vectors.orphan_drop'
    );
  }

  // Match the existing file_embeddings lifecycle: LanceDB infers the schema
  // from the first canonical row, preserving fixed-size vector typing without
  // adding a parallel Arrow schema dependency in this service.
  index.fileVectorsTable = await index.connection.createTable(FILE_VECTORS_TABLE_NAME, [recordForCreate]);
  await openFileVectorsReadHandle();
  return { table: index.fileVectorsTable, createdWithRecord: true };
}

/**
 * Compute + persist a single `file_vectors` row for `filePath` from its chunk
 * vectors. The sole owner of file_vectors row writes — see the file-level JSDoc
 * for the full write contract. Caller MUST hold the write lock.
 */
export async function recomputeFileVectorRow(
  filePath: string,
  chunks: FileVectorSourceChunk[]
): Promise<'written' | 'skipped' | 'failed'> {
  const vectors = chunks.map((chunk) => _toNumberVector(chunk.vector));
  // Source the expected dimension from the STABLE per-model constant the live
  // generator declares (NOT from the batch/legacy rows). This keeps Layer 2 in
  // agreement with the embed-time guard (MA3): legacy minority-dimension chunks
  // are skipped, never allowed to define the file vector.
  const expectedDimension = getEmbeddingGenerator().embeddingDimension;
  const { vector, validCount, skippedCount, invalidReasons } = computeAveragedNormalizedVector(
    vectors,
    expectedDimension
  );
  if (!vector) {
    const reason = getFileVectorSkipReason(chunks);
    try {
      await _deleteFileVectorRowsByPaths([filePath]);
      // file_vectors writes/skips from lazy-fill, reconcile, and repair do not
      // bump the chunks mutationVersion; this epoch invalidates the dependent
      // file_neighbors checkpoint for those derived-table-only changes.
      markFileNeighborsEpochMutated();
      await _invalidateFileNeighborsForVectorWrite(filePath);
    } catch (err) {
      logger.warn({ err, path: filePath }, 'file_vectors.delete_failure');
    }
    logFileVectorSkipped(filePath, reason, chunks.length);
    return 'skipped';
  }

  // MA4 — Layer-2 healing observability. When the average was built from a
  // SUBSET of the chunks (legacy/on-disk corrupt rows skipped), the resulting
  // file vector is silently low-quality (e.g. 1 valid of 100). Emit a counted
  // warning so this is visible in telemetry; the on-disk 394 corrupt rows will
  // hit exactly this path on lazy-fill/reconcile. This is observability, not a
  // new fallback — the null-only-when-ALL-invalid semantics are unchanged.
  if (skippedCount > 0) {
    const reasonCounts: Partial<Record<string, number>> = {};
    for (const r of invalidReasons) {
      reasonCounts[r] = (reasonCounts[r] ?? 0) + 1;
    }
    logger.warn(
      { path: filePath, validCount, skippedCount, totalChunks: chunks.length, reasonCounts },
      'file_vectors.partial_quality'
    );
  }

  const computedAt = Date.now();
  const record = buildFileVectorRecord(filePath, chunks, vector, computedAt);

  try {
    const { table, createdWithRecord } = await ensureFileVectorsTable(record);
    if (!createdWithRecord) {
      await table.delete(eq('path', filePath));
      await table.add([record]);
    }
    // file_vectors writes from lazy-fill, reconcile, and repair do not bump the
    // chunks mutationVersion; this neighbors-specific epoch keeps the dependent
    // file_neighbors checkpoint from going stale at the same chunks epoch.
    markFileNeighborsEpochMutated();
    await _invalidateFileNeighborsForVectorWrite(filePath, record);
    scheduleFileNeighborWriteTrigger();
    logger.info({ path: filePath, chunkCount: chunks.length, computedAt }, 'file_vectors.write');
    return 'written';
  } catch (err) {
    logger.warn({ err, path: filePath, chunkCount: chunks.length }, 'file_vectors.write_failure');
    return 'failed';
  }
}
