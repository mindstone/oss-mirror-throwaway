/**
 * File Index Service — derived views: file_vectors + file_neighbors (Stage D1).
 *
 * This module owns the two *derived* materialized views over the canonical
 * chunk table (`file_embeddings`):
 *
 *   - **file_vectors** lazy-fill + reconcile (former cluster C13)
 *   - **file_neighbors** fill + reconcile + read + findSimilar* (former C14)
 *
 * plus the neighbor/vector helper surface they own (fingerprints, projections,
 * the neighbor-row deleters, the neighbor table ensure/seed, the schema-failure
 * recovery, and the small vector/array coercions).
 *
 * ## C3 absorbed (read this before touching the scheduling)
 *
 * Stage C3 was de-scoped into D1: the behavior-identical relocation moved the
 * fire-and-forget neighbors scheduling + fill **as a unit** into this module.
 * Stage 7 (260611_perf-idle-churn) then deliberately changed the trigger policy:
 * file_vectors write triggers are debounced in `fileVectorsWriter.ts`, while the
 * single-flight key stays `workspacePath` and mid-pass mutation restarts stay
 * gated by the captured chunks/version epochs.
 *
 * ## Dependency injection (acyclic: index -> vectorsDerive only)
 *
 * The shared mutable state (`currentIndex`, the write lock, the mutation-version
 * epoch, and the six single-flight/checkpoint maps) is reached through the
 * `./state` owner. `recomputeFileVectorRow` comes straight from
 * `./fileVectorsWriter`. The handful of index.ts-private helpers this cluster
 * needs — `getRemovalRelativePath`, `getRemovalMtimeCandidates`,
 * `refreshReadTable`, `readChunksForFileVector`, and the file_vectors deleter
 * `deleteFileVectorRowsByPaths` (which itself depends on removal-path logic that
 * stays in index.ts) — are injected once via `wireVectorsDerive(...)`, matching
 * the `fileVectorsWriter.ts` / `optimize.ts` precedent. index.ts in turn imports
 * the neighbor-side helpers it still calls (the removal cascade, the writer's
 * invalidate hook, the close/clear abort) from this module.
 *
 * Behavior-preserving relocation only. No logic edits.
 */

import crypto from 'node:crypto';
import { logger } from '@core/logger';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { getBroadcastService } from '@core/broadcastService';
import { eq, inAny, notEq, or } from '../../utils/lancedbPredicates';
import { isAnyTurnActive, waitForTurnIdle } from '../visibilityAwareScheduler';
import { ReadTableHandle } from './readTableHandle';
import {
  _flushFileNeighborWriteTriggerForTesting,
  recomputeFileVectorRow,
  type FileVectorSourceChunk,
} from './fileVectorsWriter';
import {
  getDeterministicFileNeighborFailures,
  getCurrentIndex,
  getDeterministicFileVectorFailures,
  getFileNeighborsEpoch,
  getNanRepairAttempts,
  getNanRepairFailures,
  getNanRepairPending,
  getFileNeighborsLazyFillControllers,
  getFileNeighborsLazyFillPromises,
  getFileNeighborsReconcileInFlight,
  getLastFileNeighborsLazyFillCheckpoint,
  getLastLazyFillCheckpoint,
  getLazyFillInFlight,
  getMutationVersion,
  getReconcileInFlight,
  isStillCurrent,
  markFileNeighborsEpochMutated,
  rebuildWorkspaceSymlinkMap,
  withWriteLock,
  type FileNeighborRecord,
  type FindSimilarFilesResult,
  type FileVectorRecord,
  type LazyFillFileVectorsResult,
  type NanRepairFailureKind,
  type ReconcileFileNeighborsResult,
  type ReconcileFileVectorsResult,
  type WorkspaceIndex,
} from './state';

type LanceDBConnection = Awaited<ReturnType<typeof import('@lancedb/lancedb').connect>>;
type LanceDBTable = Awaited<ReturnType<LanceDBConnection['openTable']>>;

const FILE_NEIGHBORS_TABLE_NAME = 'file_neighbors';
const FILE_NEIGHBORS_SCHEMA_SEED_PATH = '__file_neighbors_schema_seed__';

const FILE_VECTOR_LAZY_FILL_BATCH_SIZE = 50;
const FILE_VECTOR_LAZY_FILL_PROGRESS_INTERVAL = 500;
const FILE_VECTOR_RECONCILE_BATCH_SIZE = 50;
const FILE_VECTOR_RECONCILE_PROGRESS_INTERVAL = 500;
const DEFAULT_FILE_NEIGHBOR_K = 5;
const FILE_NEIGHBOR_LAZY_FILL_BATCH_SIZE = 50;
const FILE_NEIGHBOR_BROADCAST_PROGRESS_INTERVAL = 100;
const FILE_NEIGHBOR_LOG_PROGRESS_INTERVAL = 500;
const FILE_NEIGHBOR_RECONCILE_BATCH_SIZE = 50;

// FU-4b: the decoupled NaN-repair sweep's bound (MA1). Re-embedding is real
// CPU/GPU work, so a workspace with hundreds of corrupt files (the observed case
// was 321) must not re-embed them all in one burst. The sweep repairs at most
// `FILE_VECTOR_NAN_REPAIR_PER_TICK` files per scheduled tick, then — only if the
// queue is non-empty — re-schedules the NEXT tick `FILE_VECTOR_NAN_REPAIR_TICK_
// INTERVAL_MS` of WALL-CLOCK time later. The bound is robust-by-construction: the
// sweep owns its own timer and is NEVER invoked by a read/neighbors reentry, so
// reentrant lazy-fill cannot drain more than one tick's budget back-to-back. Each
// file is also repaired at most once per content identity (the nanRepairAttempts
// memo, MA3), so the total is a bounded ONE-TIME cost spread across ticks, never a
// sustained burn.
const FILE_VECTOR_NAN_REPAIR_PER_TICK = 25;
const FILE_VECTOR_NAN_REPAIR_TICK_INTERVAL_MS = 30_000;

// FU-4c: a path that PERSISTENTLY fails the repair RE-INDEX (full disk, poisoned
// path, deterministic add failure) must not be re-embedded every tick forever.
// After this many failed attempts the sweep QUARANTINES it: removes it from the
// pending queue (so the sweep can go quiet) and emits one observable ERROR for
// manual / user-triggered recovery. A small cap keeps wasted re-embeds bounded
// while still riding out genuinely transient IO/FD pressure.
const FILE_VECTOR_NAN_REPAIR_MAX_ATTEMPTS = 3;

// Single-flight / checkpoint maps owned by ./state. Bound once as stable const
// references (never reassigned), behavior-identical to the prior index.ts aliases.
const lastLazyFillCheckpoint = getLastLazyFillCheckpoint();
const lazyFillInFlight = getLazyFillInFlight();
const deterministicFileVectorFailures = getDeterministicFileVectorFailures();
const lastFileNeighborsLazyFillCheckpoint = getLastFileNeighborsLazyFillCheckpoint();
const deterministicFileNeighborFailures = getDeterministicFileNeighborFailures();
const nanRepairAttempts = getNanRepairAttempts();
const nanRepairPending = getNanRepairPending();
const nanRepairFailures = getNanRepairFailures();
const reconcileInFlight = getReconcileInFlight();
const fileNeighborsLazyFillControllers = getFileNeighborsLazyFillControllers();
const fileNeighborsLazyFillPromises = getFileNeighborsLazyFillPromises();
const fileNeighborsReconcileInFlight = getFileNeighborsReconcileInFlight();

// ============================================================================
// Dependency injection — index.ts-private helpers
// ============================================================================

/**
 * Outcome of the injected one-time NaN-repair (FU-4 / FU-4b). Structurally mirrors
 * `NanRepairOutcome` in index.ts; defined locally to keep the import graph
 * acyclic (the only edge is index → vectorsDerive). `state` (MA2/Codex metrics):
 *  - `not_repairable`        — the skip was NOT due to non-finite chunks; left as a skip.
 *  - `healed`                — re-indexed; a valid file_vectors row now exists.
 *  - `still_invalid`         — re-indexed, all-NaN dropped by the guard → file legitimately
 *                              unfillable (file gone / backend persistently NaN). CONVERGED.
 *  - `failed_before_purge`   — the repair threw BEFORE deleting the old rows; the corrupt
 *                              rows are intact → safe to retry.
 *  - `failed_after_purge`    — the re-index deleted the old rows then the re-add failed
 *                              (transient IO/FD pressure) while the source is still
 *                              indexable on disk → the file is chunk-less but RECOVERABLE;
 *                              MUST be re-enqueued, NEVER presented as convergence (MA2).
 * `postFingerprint` (when re-indexed) lets the caller record the at-most-once gate against
 * the POST-repair fingerprint too (MA3).
 */
type RepairFileResult = {
  state:
    | 'not_repairable'
    | 'healed'
    | 'still_invalid'
    | 'failed_before_purge'
    | 'failed_after_purge';
  purgedRows: number;
};

interface VectorsDeriveDeps {
  getRemovalRelativePath: (filePath: string) => string | null;
  getRemovalMtimeCandidates: (filePath: string) => string[];
  refreshReadTable: () => Promise<void>;
  readChunksForFileVector: (filePath: string) => Promise<FileVectorSourceChunk[]>;
  deleteFileVectorRowsByPaths: (pathsToDelete: string[]) => Promise<void>;
  repairFileWithNonFiniteChunks: (filePath: string, workspacePath: string) => Promise<RepairFileResult>;
}

let _getRemovalRelativePath: VectorsDeriveDeps['getRemovalRelativePath'] = () => null;
let _getRemovalMtimeCandidates: VectorsDeriveDeps['getRemovalMtimeCandidates'] = (filePath) => [filePath];
let _refreshReadTable: VectorsDeriveDeps['refreshReadTable'] = async () => {};
let _readChunksForFileVector: VectorsDeriveDeps['readChunksForFileVector'] = async () => [];
let _deleteFileVectorRowsByPaths: VectorsDeriveDeps['deleteFileVectorRowsByPaths'] = async () => {};
let _repairFileWithNonFiniteChunks: VectorsDeriveDeps['repairFileWithNonFiniteChunks'] = async () => ({
  state: 'not_repairable',
  purgedRows: 0,
});

/** Inject the index.ts-private helpers. Called once at index.ts module load. */
export function wireVectorsDerive(deps: VectorsDeriveDeps): void {
  _getRemovalRelativePath = deps.getRemovalRelativePath;
  _getRemovalMtimeCandidates = deps.getRemovalMtimeCandidates;
  _refreshReadTable = deps.refreshReadTable;
  _readChunksForFileVector = deps.readChunksForFileVector;
  _deleteFileVectorRowsByPaths = deps.deleteFileVectorRowsByPaths;
  _repairFileWithNonFiniteChunks = deps.repairFileWithNonFiniteChunks;
}

/**
 * The per-workspace one-time NaN-repair memo (FU-4). Lazily creates the inner
 * map so callers can record/read without a null guard. Mirrors
 * {@link getDeterministicFailureMemoFor}; see the state.ts field note for why it
 * keys by chunk fingerprint and why it's in-memory only.
 */
function getNanRepairMemoFor(workspacePath: string): Map<string, Set<string>> {
  let memo = nanRepairAttempts.get(workspacePath);
  if (!memo) {
    memo = new Map<string, Set<string>>();
    nanRepairAttempts.set(workspacePath, memo);
  }
  return memo;
}

/** The per-workspace pending-repair queue (FU-4b/MA1), lazily created. */
function getNanRepairPendingFor(workspacePath: string): Set<string> {
  let pending = nanRepairPending.get(workspacePath);
  if (!pending) {
    pending = new Set<string>();
    nanRepairPending.set(workspacePath, pending);
  }
  return pending;
}

/** True if `filePath` has already been repaired at fingerprint `key` (MA3). */
function nanRepairAlreadyAttempted(
  memo: Map<string, Set<string>>,
  filePath: string,
  key: string
): boolean {
  return memo.get(filePath)?.has(key) ?? false;
}

/** Record that `filePath` has been repaired at fingerprint `key` (MA3 at-most-once). */
function recordNanRepairAttempt(
  memo: Map<string, Set<string>>,
  filePath: string,
  key: string
): void {
  let keys = memo.get(filePath);
  if (!keys) {
    keys = new Set<string>();
    memo.set(filePath, keys);
  }
  keys.add(key);
}

/** The per-workspace repair-failure tracking map (FU-4c), lazily created. */
function getNanRepairFailuresFor(
  workspacePath: string
): Map<string, import('./state').NanRepairFailureRecord> {
  let failures = nanRepairFailures.get(workspacePath);
  if (!failures) {
    failures = new Map();
    nanRepairFailures.set(workspacePath, failures);
  }
  return failures;
}

/**
 * Record a repair INFRASTRUCTURE failure for `filePath` (FU-4c) and return whether
 * the bounded retry cap is now exhausted (i.e. the path should be quarantined).
 * Keeps a running attempt count + last failure kind; distinct from the
 * deterministic-skip memo (which is for semantically-unfillable content).
 */
function recordNanRepairFailure(
  workspacePath: string,
  filePath: string,
  kind: NanRepairFailureKind
): { attempts: number; capExhausted: boolean } {
  const failures = getNanRepairFailuresFor(workspacePath);
  const prior = failures.get(filePath);
  const attempts = (prior?.attempts ?? 0) + 1;
  const capExhausted = attempts >= FILE_VECTOR_NAN_REPAIR_MAX_ATTEMPTS;
  failures.set(filePath, {
    attempts,
    lastFailureKind: kind,
    lastAttemptAt: Date.now(),
    quarantined: capExhausted,
  });
  return { attempts, capExhausted };
}

/** Clear any failure record for `filePath` (FU-4c) — e.g. after it finally heals. */
function clearNanRepairFailure(workspacePath: string, filePath: string): void {
  nanRepairFailures.get(workspacePath)?.delete(filePath);
}

/**
 * True if `filePath` has been QUARANTINED (FU-4c): its repair persistently failed
 * the bounded retry cap. A quarantined path must not be re-enqueued by lazy-fill —
 * that is what lets the sweep go (and stay) quiet. Cleared by
 * `clearDeterministicVectorSkip` / a content change for manual recovery.
 */
function isNanRepairQuarantined(workspacePath: string, filePath: string): boolean {
  return nanRepairFailures.get(workspacePath)?.get(filePath)?.quarantined ?? false;
}

// ============================================================================
// Small coercions (owned here; used across the neighbor/vector paths)
// ============================================================================

export function toNumberVector(vector: number[] | Float32Array): number[] {
  return Array.isArray(vector) ? vector : Array.from(vector);
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (value && typeof (value as Iterable<unknown>)[Symbol.iterator] === 'function') {
    return Array.from(value as Iterable<unknown>).filter((item): item is string => typeof item === 'string');
  }
  return [];
}

function toNumberArray(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is number => typeof item === 'number');
  }
  if (value && typeof (value as Iterable<unknown>)[Symbol.iterator] === 'function') {
    return Array.from(value as Iterable<unknown>).filter((item): item is number => typeof item === 'number');
  }
  return [];
}

function isLikelySchemaProjectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /schema|column|field|not found|No field|Invalid/i.test(message);
}

function isLanceTableNotFoundError(error: unknown, tableName: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`Table '${tableName}' was not found`) || message.includes(`${tableName}.lance`);
}

// ============================================================================
// file_neighbors helper surface (table ensure/seed, deleters, invalidate)
// ============================================================================

async function openFileNeighborsReadHandle(): Promise<void> {
  const index = getCurrentIndex();
  if (!index?.fileNeighborsTable) {
    return;
  }

  const oldReadHandle = index.fileNeighborsReadTable;
  const newReadTable = await index.readConnection.openTable(FILE_NEIGHBORS_TABLE_NAME);
  index.fileNeighborsReadTable = new ReadTableHandle(newReadTable);
  if (oldReadHandle) await oldReadHandle.retire();
}

function buildFileVectorSourceFingerprint(record: FileVectorFingerprint): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      source_max_chunk_mtime: record.source_max_chunk_mtime,
      source_max_indexed_at: record.source_max_indexed_at,
      source_max_enhanced_at: record.source_max_enhanced_at,
      source_chunk_count: record.source_chunk_count,
    }))
    .digest('hex');
}

/**
 * The per-workspace deterministic-failure memo (Stage 3). Lazily creates the
 * inner map so callers can record/read without a null guard. See the state.ts
 * note for why this keys by chunk fingerprint and why it's in-memory only.
 */
function getDeterministicFailureMemoFor(workspacePath: string): Map<string, string> {
  let memo = deterministicFileVectorFailures.get(workspacePath);
  if (!memo) {
    memo = new Map<string, string>();
    deterministicFileVectorFailures.set(workspacePath, memo);
  }
  return memo;
}

function getDeterministicNeighborFailureMemoFor(workspacePath: string): Map<string, string> {
  let memo = deterministicFileNeighborFailures.get(workspacePath);
  if (!memo) {
    memo = new Map<string, string>();
    deterministicFileNeighborFailures.set(workspacePath, memo);
  }
  return memo;
}

function shouldAdvanceDerivedLazyFillCheckpoint(failed: number): boolean {
  // Deterministic skips are removed from `failed` before this shared gate is
  // evaluated. Keeping the predicate shared prevents file_vectors and
  // file_neighbors convergence semantics from drifting.
  return failed === 0;
}

function buildFileNeighborRecord(
  source: Pick<FileVectorRecord,
    'path'
    | 'relative_path'
    | 'source_max_chunk_mtime'
    | 'source_max_indexed_at'
    | 'source_max_enhanced_at'
    | 'source_chunk_count'
  >,
  neighbors: FindSimilarFilesResult[],
  k: number,
  neighborFingerprints: string[] = [],
  computedAt: number = Date.now()
): FileNeighborRecord {
  return {
    path: source.path,
    relative_path: source.relative_path,
    neighbor_paths: neighbors.map(neighbor => neighbor.path),
    neighbor_scores: neighbors.map(neighbor => neighbor.score),
    neighbor_fingerprints: neighborFingerprints.length === neighbors.length
      ? neighborFingerprints
      : neighbors.map(() => ''),
    source_vector_fingerprint: buildFileVectorSourceFingerprint(source),
    k,
    computed_at: computedAt,
  };
}

async function ensureFileNeighborsTable(recordForCreate: FileNeighborRecord): Promise<{
  table: LanceDBTable;
  createdWithRecord: boolean;
}> {
  // Stable for this locked routine — capture once for correct narrowing
  // (behavior-identical to the pre-C2 in-place currentIndex field mutations).
  const index = getCurrentIndex();
  if (!index) {
    throw new Error('Cannot create file_neighbors table without an active index');
  }

  if (index.fileNeighborsTable) {
    return { table: index.fileNeighborsTable, createdWithRecord: false };
  }

  const tableNames = await index.connection.tableNames();
  if (tableNames.includes(FILE_NEIGHBORS_TABLE_NAME)) {
    try {
      await index.connection.dropTable(FILE_NEIGHBORS_TABLE_NAME);
    } catch (err) {
      logger.warn(
        { err, tableName: FILE_NEIGHBORS_TABLE_NAME, reason: 'orphan_table_without_active_handle' },
        'file_neighbors.orphan_drop_failure'
      );
      throw err;
    }
    logger.info(
      { tableName: FILE_NEIGHBORS_TABLE_NAME, reason: 'orphan_table_without_active_handle' },
      'file_neighbors.orphan_drop'
    );
  }

  const needsSchemaSeed = recordForCreate.neighbor_paths.length === 0;
  const createRecord = needsSchemaSeed
    ? {
        ...recordForCreate,
        path: FILE_NEIGHBORS_SCHEMA_SEED_PATH,
        relative_path: FILE_NEIGHBORS_SCHEMA_SEED_PATH,
        neighbor_paths: [FILE_NEIGHBORS_SCHEMA_SEED_PATH],
        neighbor_scores: [0],
        neighbor_fingerprints: [FILE_NEIGHBORS_SCHEMA_SEED_PATH],
      }
    : recordForCreate;

  index.fileNeighborsTable = await index.connection.createTable(FILE_NEIGHBORS_TABLE_NAME, [createRecord]);
  if (needsSchemaSeed) {
    await index.fileNeighborsTable.delete(eq('path', FILE_NEIGHBORS_SCHEMA_SEED_PATH));
  }
  await openFileNeighborsReadHandle();
  return { table: index.fileNeighborsTable, createdWithRecord: !needsSchemaSeed };
}

async function deleteFileNeighborRowsByPaths(pathsToDelete: string[]): Promise<void> {
  const fileNeighborsTable = getCurrentIndex()?.fileNeighborsTable;
  if (!fileNeighborsTable || pathsToDelete.length === 0) {
    return;
  }

  const uniquePaths = [...new Set(pathsToDelete)];
  // Neighbor row deletes happen from removal, invalidation, and reconcile paths.
  // Bump before the mutation so even a partial/failed delete cannot leave the
  // converged neighbors checkpoint valid over potentially stale rows.
  markFileNeighborsEpochMutated();
  const BATCH_SIZE = 50;
  for (let i = 0; i < uniquePaths.length; i += BATCH_SIZE) {
    const batch = uniquePaths.slice(i, i + BATCH_SIZE);
    const relativePathCandidates = [...new Set(
      batch
        .map((filePath) => _getRemovalRelativePath(filePath))
        .filter((relativePath): relativePath is string => relativePath !== null)
    )];
    const predicates = [inAny('path', batch)];
    if (relativePathCandidates.length > 0) {
      predicates.push(inAny('relative_path', relativePathCandidates));
    }
    await fileNeighborsTable.delete(or(...predicates));
  }
}

async function findFileNeighborRowsReferencingPath(filePath: string): Promise<string[]> {
  const fileNeighborsTable = getCurrentIndex()?.fileNeighborsTable;
  if (!fileNeighborsTable) {
    return [];
  }

  const rows = await fileNeighborsTable
    .query()
    .select(['path', 'neighbor_paths'])
    .toArray();

  const referencingPaths: string[] = [];
  for (const row of rows) {
    const record = row as Pick<FileNeighborRecord, 'path' | 'neighbor_paths'>;
    if (toStringArray(record.neighbor_paths).includes(filePath)) {
      referencingPaths.push(record.path);
    }
  }
  return referencingPaths;
}

async function findFileNeighborRowsReferencingAnyPath(filePaths: string[]): Promise<string[]> {
  const fileNeighborsTable = getCurrentIndex()?.fileNeighborsTable;
  if (!fileNeighborsTable || filePaths.length === 0) {
    return [];
  }

  const pathSet = new Set(filePaths);
  const rows = await fileNeighborsTable
    .query()
    .select(['path', 'neighbor_paths'])
    .toArray();

  const referencingPaths: string[] = [];
  for (const row of rows) {
    const record = row as Pick<FileNeighborRecord, 'path' | 'neighbor_paths'>;
    if (toStringArray(record.neighbor_paths).some(neighborPath => pathSet.has(neighborPath))) {
      referencingPaths.push(record.path);
    }
  }
  return referencingPaths;
}

export async function deleteFileNeighborRowsForRemovedPaths(pathsToRemove: string[]): Promise<number> {
  if (!getCurrentIndex()?.fileNeighborsTable || pathsToRemove.length === 0) {
    return 0;
  }

  const candidatePaths = [...new Set(pathsToRemove.flatMap(filePath => _getRemovalMtimeCandidates(filePath)))];
  const rowsToDelete = new Set(candidatePaths);
  for (const referencingPath of await findFileNeighborRowsReferencingAnyPath(candidatePaths)) {
    rowsToDelete.add(referencingPath);
  }

  await deleteFileNeighborRowsByPaths([...rowsToDelete]);
  return rowsToDelete.size;
}

export async function invalidateFileNeighborsForVectorWrite(
  filePath: string,
  sourceRecord?: Pick<FileVectorRecord,
    'path'
    | 'relative_path'
    | 'source_max_chunk_mtime'
    | 'source_max_indexed_at'
    | 'source_max_enhanced_at'
    | 'source_chunk_count'
  >
): Promise<void> {
  const index = getCurrentIndex();
  if (!index) {
    return;
  }

  if (!index.fileNeighborsTable && sourceRecord) {
    const seedRecord = buildFileNeighborRecord(sourceRecord, [], DEFAULT_FILE_NEIGHBOR_K);
    await ensureFileNeighborsTable(seedRecord);
  }

  // Re-read the field: ensureFileNeighborsTable may have populated it on the
  // same singleton object (it mutates the field, not the singleton itself).
  if (!index.fileNeighborsTable) {
    return;
  }

  const rowsToDelete = new Set<string>(_getRemovalMtimeCandidates(filePath));
  try {
    for (const referencingPath of await findFileNeighborRowsReferencingPath(filePath)) {
      rowsToDelete.add(referencingPath);
    }
    await deleteFileNeighborRowsByPaths([...rowsToDelete]);
    logger.info({ path: filePath, deletedRows: rowsToDelete.size }, 'file_neighbors.invalidate');
  } catch (err) {
    logger.warn({ err, path: filePath }, 'file_neighbors.invalidate_failure');
  }
}

export function abortFileNeighborsLazyFill(workspacePath: string, reason: string): void {
  const controller = fileNeighborsLazyFillControllers.get(workspacePath);
  if (!controller || controller.signal.aborted) {
    return;
  }
  controller.abort(reason);
  fileNeighborsLazyFillControllers.delete(workspacePath);
}

async function dropCurrentFileNeighborsTableAfterSchemaFailure(reason: string, err: unknown): Promise<void> {
  await withWriteLock(async () => {
    const index = getCurrentIndex();
    if (!index) {
      return;
    }

    abortFileNeighborsLazyFill(index.workspacePath, reason);
    try {
      index.fileNeighborsTable?.close();
    } catch (closeErr) {
      logger.warn({ err: closeErr, tableName: FILE_NEIGHBORS_TABLE_NAME }, 'Failed to close incompatible file neighbors table');
    }
    const oldReadHandle = index.fileNeighborsReadTable;
    index.fileNeighborsTable = null;
    index.fileNeighborsReadTable = null;
    if (oldReadHandle) {
      await oldReadHandle.retire();
    }

    try {
      await index.connection.dropTable(FILE_NEIGHBORS_TABLE_NAME);
    } catch (dropErr) {
      if (!isLanceTableNotFoundError(dropErr, FILE_NEIGHBORS_TABLE_NAME)) {
        logger.warn({ err: dropErr, reason }, 'file_neighbors.schema_drop_failure');
        return;
      }
    }

    logger.warn({ err, reason }, 'file_neighbors.schema_incompatible_drop');
  });
}

function broadcastFileNeighborsEvent(channel: string, payload: Record<string, unknown>): void {
  try {
    // dynamic-broadcast-reviewed: internal forwarding helper — its callers pass file-neighbors
    // channel literals (declared at those call sites); it adds no channel of its own.
    getBroadcastService().sendToAllWindows(channel, payload);
  } catch (err) {
    logger.debug({ err, channel }, 'file_neighbors.broadcast_skipped');
  }
}

// ============================================================================
// file_vectors lazy-fill + reconcile (former C13)
// ============================================================================

type FileVectorFingerprint = Pick<
  FileVectorRecord,
  'source_max_chunk_mtime' | 'source_max_indexed_at' | 'source_max_enhanced_at' | 'source_chunk_count'
>;

type FileVectorChunkProjectionRow = {
  path: string;
  mtime: number;
  indexedAt: number;
  enhanced_at: number;
};

type FileVectorRowProjection = Pick<FileVectorRecord, 'path'> & FileVectorFingerprint;

function buildChunkFingerprintProjection(
  rows: FileVectorChunkProjectionRow[]
): Map<string, FileVectorFingerprint> {
  const fingerprints = new Map<string, FileVectorFingerprint>();

  for (const row of rows) {
    const existing = fingerprints.get(row.path);
    if (existing) {
      existing.source_max_chunk_mtime = Math.max(existing.source_max_chunk_mtime, row.mtime ?? 0);
      existing.source_max_indexed_at = Math.max(existing.source_max_indexed_at, row.indexedAt ?? 0);
      existing.source_max_enhanced_at = Math.max(existing.source_max_enhanced_at, row.enhanced_at ?? 0);
      existing.source_chunk_count++;
    } else {
      fingerprints.set(row.path, {
        source_max_chunk_mtime: row.mtime ?? 0,
        source_max_indexed_at: row.indexedAt ?? 0,
        source_max_enhanced_at: row.enhanced_at ?? 0,
        source_chunk_count: 1,
      });
    }
  }

  return fingerprints;
}

async function readChunkFingerprintProjection(table: LanceDBTable): Promise<Map<string, FileVectorFingerprint>> {
  const rows = (await table
    .query()
    .select(['path', 'mtime', 'indexedAt', 'enhanced_at'])
    .toArray()) as FileVectorChunkProjectionRow[];

  return buildChunkFingerprintProjection(rows);
}

async function readFileVectorProjection(
  table: LanceDBTable | null = getCurrentIndex()?.fileVectorsTable ?? null
): Promise<Map<string, FileVectorFingerprint>> {
  if (!table) {
    return new Map();
  }

  // FU-4b: the decoupled repair sweep commits healed file_vectors rows through a
  // file_vectors handle held in a SEPARATE write-lock. A long-lived in-memory
  // handle this caller holds can return a STALE snapshot on its FIRST query after
  // that out-of-band commit — reporting a just-healed file as still missing, which
  // would make lazy-fill re-fill it and bump the mutation version (a re-churn that
  // defeats convergence — the exact loop this work prevents). A cheap warming read
  // advances the handle to the committed version before the real projection query.
  // Any error here is the caller's to surface (it propagates like the real read).
  await table.query().limit(1).toArray();

  const rows = await table
    .query()
    .select([
      'path',
      'source_max_chunk_mtime',
      'source_max_indexed_at',
      'source_max_enhanced_at',
      'source_chunk_count',
    ])
    .toArray();

  const projection = new Map<string, FileVectorFingerprint>();
  for (const row of rows) {
    const record = row as FileVectorRowProjection;
    projection.set(record.path, {
      source_max_chunk_mtime: record.source_max_chunk_mtime,
      source_max_indexed_at: record.source_max_indexed_at,
      source_max_enhanced_at: record.source_max_enhanced_at,
      source_chunk_count: record.source_chunk_count,
    });
  }
  return projection;
}

function fileVectorFingerprintsMatch(
  current: FileVectorFingerprint,
  stored: FileVectorFingerprint
): boolean {
  return current.source_max_chunk_mtime === stored.source_max_chunk_mtime
    && current.source_max_indexed_at === stored.source_max_indexed_at
    && current.source_max_enhanced_at === stored.source_max_enhanced_at
    && current.source_chunk_count === stored.source_chunk_count;
}

/**
 * If `file_vectors` is empty / missing rows for paths that exist in chunks, populate them.
 * Idempotent: existing paths are skipped; Stage 3.5 owns fingerprint-mismatch repair.
 *
 * Stage 0 measured 25k-file bulk-build at 2.86s — fast enough to run synchronously on first read.
 *
 * Concurrency: acquires `withWriteLock` for the writes; safe to run while live writes are happening.
 * Reads chunks table OUTSIDE the lock (cheap projection-only scan), then takes the lock per-path-batch.
 */
export async function lazyFillFileVectorsIfNeeded(): Promise<LazyFillFileVectorsResult> {
  const indexAtStart = getCurrentIndex();
  if (!indexAtStart?.table) {
    return { filled: 0, skipped: 0, failed: 0, durationMs: 0 };
  }

  const tableAtStart = indexAtStart.table;
  const workspacePath = indexAtStart.workspacePath;
  const existing = lazyFillInFlight.get(workspacePath);
  if (existing) {
    return existing;
  }

  const promise = lazyFillFileVectorsForWorkspace(indexAtStart, tableAtStart, workspacePath);
  lazyFillInFlight.set(workspacePath, promise);
  try {
    const result = await promise;
    return result;
  } finally {
    if (lazyFillInFlight.get(workspacePath) === promise) {
      lazyFillInFlight.delete(workspacePath);
    }
  }
}

async function lazyFillFileVectorsForWorkspace(
  indexAtStart: WorkspaceIndex,
  tableAtStart: LanceDBTable,
  workspacePath: string
): Promise<LazyFillFileVectorsResult> {
  const startTime = Date.now();

  // MA3: rebuild the cached workspace symlink map ONCE at the start of each
  // lazy-fill pass, in addition to the dir:added/removed watcher invalidation.
  // The dir-event invalidation alone is unsound: a symlink can be atomically
  // re-pointed, a previously-broken target can mount/appear, or a cloud-storage
  // mount can swap underneath the symlink — none of which necessarily surface a
  // dir:added/dir:removed event. A stale map then mis-converts both the indexed
  // relative_path AND the DELETE predicate (getRemovalRelativePath →
  // deleteFileVectorRowsByPaths), so a delete after a silent retarget could
  // remove the wrong row. Rebuilding per-pass bounds staleness to ≤ one pass
  // while keeping the per-file conversions O(1) (the legacy walker rebuilt every
  // call). This is cheap because Stage 3 drives passes to ~zero work at idle;
  // CRUCIAL: this runs once per pass, never per file. The rebuild mutates
  // currentIndex.symlinkMap in place, so the freshly-rebuilt map is the same
  // object the delete/skip path reads via index.symlinkMap (index.ts ~1506).
  rebuildWorkspaceSymlinkMap();

  const mutationVersionAtProjection = getMutationVersion();
  const checkpoint = lastLazyFillCheckpoint.get(workspacePath);
  if (checkpoint?.mutationVersion === mutationVersionAtProjection) {
    return { filled: 0, skipped: checkpoint.skipped, failed: 0, durationMs: Date.now() - startTime };
  }

  let chunkFingerprints: Map<string, FileVectorFingerprint>;
  try {
    chunkFingerprints = await readChunkFingerprintProjection(tableAtStart);
  } catch (err) {
    logger.warn({ err, workspacePath }, 'file_vectors.lazy_fill_projection_failure');
    return { filled: 0, skipped: 0, failed: 1, durationMs: Date.now() - startTime };
  }

  if (chunkFingerprints.size === 0) {
    if (!indexAtStart.fileVectorsTable) {
      return { filled: 0, skipped: 0, failed: 0, durationMs: 0 };
    }
    lastLazyFillCheckpoint.set(workspacePath, {
      mutationVersion: mutationVersionAtProjection,
      skipped: 0,
    });
    return { filled: 0, skipped: 0, failed: 0, durationMs: Date.now() - startTime };
  }

  let fileVectorProjection: Map<string, FileVectorFingerprint>;
  try {
    fileVectorProjection = await readFileVectorProjection(indexAtStart.fileVectorsTable);
  } catch (err) {
    logger.error({ err, workspacePath }, 'file_vectors.projection_failure');
    return {
      filled: 0,
      skipped: 0,
      failed: chunkFingerprints.size,
      durationMs: Date.now() - startTime,
    };
  }

  // Deterministic-failure memo (Stage 3). A missing-row file whose chunk
  // fingerprint still matches a recorded deterministic failure is treated as
  // "known-unfillable" — it is NOT re-derived this pass, so an all-unfillable
  // set converges to `failed===0` and the checkpoint can advance. The memo is
  // pruned in lockstep with the live chunk projection so it never leaks or
  // skips a file whose content has since changed.
  const deterministicMemo = getDeterministicFailureMemoFor(workspacePath);

  const pathsToFill: string[] = [];
  let skipped = 0;
  let deterministicSkip = 0;
  for (const [filePath, fingerprint] of chunkFingerprints) {
    if (fileVectorProjection.has(filePath)) {
      // Stage 3 deliberately owns only missing rows. Fingerprint mismatch repair
      // is Stage 3.5's reconcile scope per S4.1. A file that now HAS a row is no
      // longer an unfillable case — drop any stale memo entry.
      skipped++;
      deterministicMemo.delete(filePath);
      continue;
    }
    const recordedKey = deterministicMemo.get(filePath);
    if (recordedKey === buildFileVectorSourceFingerprint(fingerprint)) {
      // Known-unfillable at this exact content identity → short-circuit, do NOT
      // re-derive. Counts as converged work, not as a pending or failed file.
      deterministicSkip++;
      continue;
    }
    if (recordedKey !== undefined) {
      // The file changed since it last failed (fingerprint differs) → clear the
      // memo and re-attempt it below.
      deterministicMemo.delete(filePath);
    }
    pathsToFill.push(filePath);
  }

  // Prune memo entries whose file no longer appears in the chunk projection
  // (deleted / re-indexed away), so the memo cannot leak across the workspace's
  // lifetime or pin a path LanceDB no longer knows about.
  for (const memoedPath of [...deterministicMemo.keys()]) {
    if (!chunkFingerprints.has(memoedPath)) {
      deterministicMemo.delete(memoedPath);
    }
  }
  // FU-4: prune the one-time NaN-repair memo in lockstep, for the same reason —
  // a file that left the chunk projection (e.g. its corrupt rows were purged and
  // it produced no usable chunk, or it was deleted) must not pin a repair record.
  const nanRepairMemoForPrune = nanRepairAttempts.get(workspacePath);
  if (nanRepairMemoForPrune) {
    for (const memoedPath of [...nanRepairMemoForPrune.keys()]) {
      if (!chunkFingerprints.has(memoedPath)) {
        nanRepairMemoForPrune.delete(memoedPath);
      }
    }
  }
  // FU-4b: prune the pending-repair queue in lockstep too — a path that left the
  // chunk projection no longer needs repair (deleted, or its corrupt rows were
  // already purged), so the sweep must not chase a ghost.
  const nanRepairPendingForPrune = nanRepairPending.get(workspacePath);
  if (nanRepairPendingForPrune) {
    for (const pendingPath of [...nanRepairPendingForPrune]) {
      if (!chunkFingerprints.has(pendingPath)) {
        nanRepairPendingForPrune.delete(pendingPath);
      }
    }
  }
  // FU-4c: prune the repair-failure / quarantine records in lockstep too. A path
  // that left the chunk projection (deleted, or its corrupt rows were purged by a
  // failed_after_purge it can no longer auto-recover from) no longer participates
  // in lazy-fill, so its failure record is dead weight. A quarantined
  // failed_before_purge path KEEPS its corrupt rows in the projection, so its
  // record correctly survives here and keeps gating re-enqueue.
  const nanRepairFailuresForPrune = nanRepairFailures.get(workspacePath);
  if (nanRepairFailuresForPrune) {
    for (const failedPath of [...nanRepairFailuresForPrune.keys()]) {
      if (!chunkFingerprints.has(failedPath)) {
        nanRepairFailuresForPrune.delete(failedPath);
      }
    }
  }

  // Single summary line REPLACING the former per-file `file_vectors.skipped` /
  // `file_neighbors.invalidate` spam (242 lines/min). Emitted once per scanning
  // pass; logged here for the all-known-unfillable short-circuit path, and again
  // at completion below once newly-discovered failures are folded in. The
  // unfillable set stays observable as a count; Stage 4 roots out WHY.
  const logDeterministicSkip = (count: number): void => {
    if (count > 0) {
      logger.info({ workspacePath, count }, 'file_vectors.deterministic_skip');
    }
  };

  if (pathsToFill.length === 0) {
    // S4: deterministic skips ARE intentionally-bypassed known rows; fold them
    // into the reported/checkpoint `skipped` so the count doesn't under-report
    // how many files the pass deliberately did not (re)derive.
    const totalSkipped = skipped + deterministicSkip;
    lastLazyFillCheckpoint.set(workspacePath, {
      mutationVersion: mutationVersionAtProjection,
      skipped: totalSkipped,
    });
    const durationMs = Date.now() - startTime;
    logDeterministicSkip(deterministicSkip);
    logger.info(
      { filled: 0, skipped, deterministicSkip, failed: 0, durationMs },
      'file_vectors.lazy_fill_complete'
    );
    return { filled: 0, skipped: totalSkipped, failed: 0, durationMs };
  }

  logger.info(
    { workspacePath, missing: pathsToFill.length, skipped, deterministicSkip, totalPaths: chunkFingerprints.size },
    'file_vectors.lazy_fill_start'
  );

  // FU-4 / FU-4b: the deterministic-skip memo + the one-time NaN-repair memo for
  // this workspace. The repair memo is the repair-once gate (see state.ts): a file
  // recorded here is NOT re-embedded again at the same content identity (MA3).
  const nanRepairMemo = getNanRepairMemoFor(workspacePath);
  const nanRepairQueue = getNanRepairPendingFor(workspacePath);

  let filled = 0;
  let failed = 0;
  let processed = 0;
  // FU-4b observability: how many non-finite files this pass DETECTED-and-ENQUEUED
  // for the decoupled repair sweep (MA1). The pass NEVER re-embeds inline.
  let enqueuedForRepair = 0;

  for (let i = 0; i < pathsToFill.length; i += FILE_VECTOR_LAZY_FILL_BATCH_SIZE) {
    const batch = pathsToFill.slice(i, i + FILE_VECTOR_LAZY_FILL_BATCH_SIZE);
    const batchResult = await withWriteLock(async () => {
      if (getCurrentIndex()?.workspacePath !== workspacePath || !getCurrentIndex()?.table) {
        return {
          filled: 0, failed: batch.length, newlyDeterministic: 0, enqueuedForRepair: 0,
        };
      }

      let batchFilled = 0;
      let batchFailed = 0;
      let batchDeterministic = 0;
      let batchEnqueued = 0;
      for (const filePath of batch) {
        try {
          const chunks = await _readChunksForFileVector(filePath);
          const result = await recomputeFileVectorRow(filePath, chunks);
          if (result === 'written') {
            batchFilled++;
            // A successful write supersedes any prior deterministic record.
            deterministicMemo.delete(filePath);
          } else if (result === 'skipped') {
            // Deterministic failure (empty_chunks / invalid_vectors /
            // mismatched_dimensions): the average over these exact chunk inputs
            // is null and will stay null until the chunks change.
            const fingerprint = chunkFingerprints.get(filePath);
            const fingerprintKey = fingerprint ? buildFileVectorSourceFingerprint(fingerprint) : null;

            // FU-4b (MA1): a file unfillable because legacy NON-FINITE (NaN/Inf)
            // chunk vectors already exist on disk is REPAIRABLE. But repair is real
            // re-embed work and MUST NOT happen inline on this (reentrant) read
            // path — that is the bypassable-budget bug. Instead DETECT it here
            // (cheap: scan the chunks we already read) and ENQUEUE its path; the
            // decoupled, wall-clock-rate-limited sweep owns the actual re-embed.
            //
            // Repair-once (MA3): if this exact content identity was already
            // repaired (pre- OR post-repair fingerprint in the memo), do NOT
            // re-enqueue — record a deterministic skip so the file converges.
            const alreadyRepaired = fingerprintKey !== null
              && nanRepairAlreadyAttempted(nanRepairMemo, filePath, fingerprintKey);
            const isNonFinite = chunksHaveNonFiniteVector(chunks);
            // FU-4c: a quarantined path (repair persistently failed the retry cap)
            // must NOT be re-enqueued — otherwise a failed_before_purge file, whose
            // corrupt rows survive in the projection, would be re-detected and
            // re-queued every pass, defeating the quarantine and re-arming the loop.
            const quarantined = isNanRepairQuarantined(workspacePath, filePath);

            if (isNonFinite && !alreadyRepaired && !quarantined && fingerprintKey !== null) {
              // Cheap, idempotent enqueue — NO re-embed on this path. Do NOT memo
              // it as a deterministic skip yet (that would short-circuit it out of
              // pathsToFill and the sweep's mutation-version bump could never get
              // re-detected). The sweep repairs it on its own cadence; the file
              // stays unfillable for THIS pass (counts toward neither filled nor
              // failed), so the pass can still checkpoint and stop the read loop.
              if (!nanRepairQueue.has(filePath)) {
                nanRepairQueue.add(filePath);
                batchEnqueued++;
              }
            } else {
              // Not repairable as a NaN case (genuine zero-norm / mismatched dims),
              // already repaired at this identity, no fingerprint, OR QUARANTINED
              // (FU-4c — repair persistently failed). Record a deterministic skip so
              // the pass CONVERGES (short-circuits this path out of pathsToFill) and
              // never re-derives it. NOTE: the deterministic memo is only the
              // "don't re-derive" mechanism; for a quarantined path the semantic
              // truth (it is an INFRA failure, not unfillable content) is preserved
              // separately in nanRepairFailures + the repair_quarantined ERROR, so
              // recovery (clearDeterministicVectorSkip clears BOTH) can re-open it.
              batchDeterministic++;
              if (fingerprintKey !== null) {
                deterministicMemo.set(filePath, fingerprintKey);
              }
            }
          } else {
            // result === 'failed' — a transient persist error. Do NOT memo;
            // it must be retried on the next pass (and blocks the checkpoint).
            batchFailed++;
          }
        } catch (err) {
          batchFailed++;
          logger.warn({ err, path: filePath }, 'file_vectors.lazy_fill_path_failure');
        }
      }
      return {
        filled: batchFilled,
        failed: batchFailed,
        newlyDeterministic: batchDeterministic,
        enqueuedForRepair: batchEnqueued,
      };
    });

    filled += batchResult.filled;
    failed += batchResult.failed;
    deterministicSkip += batchResult.newlyDeterministic;
    enqueuedForRepair += batchResult.enqueuedForRepair;
    processed += batch.length;

    if (processed % FILE_VECTOR_LAZY_FILL_PROGRESS_INTERVAL === 0 || processed === pathsToFill.length) {
      logger.info(
        { processed, total: pathsToFill.length, filled, skipped, deterministicSkip, enqueuedForRepair, failed, durationMs: Date.now() - startTime },
        'file_vectors.lazy_fill_progress'
      );
    }

    if (isAnyTurnActive()) {
      await waitForTurnIdle();
    }
  }

  if (filled > 0) {
    await _refreshReadTable();
  }

  const durationMs = Date.now() - startTime;
  // Deterministic skips are NOT failures: a pass that only hit unfillable files
  // (failed===0) checkpoints, so the next pass short-circuits at the mutation-
  // version guard and does no work — this is what makes the loop converge.
  // S4: include deterministic skips in the REPORTED skipped count so it doesn't
  // under-report intentionally-bypassed known rows. The RETURNED `skipped` keeps
  // its original meaning of "rows not (re)derived this pass" — existing-row skips
  // plus deterministic skips — and deliberately does NOT fold in `filled` (those
  // were freshly written, not skipped). The CHECKPOINT, however, stores the
  // next-pass skip total (existing skips + filled + deterministic), matching the
  // pre-S4 `skipped + filled` checkpoint semantics plus the deterministic set.
  const reportedSkipped = skipped + deterministicSkip;
  // FU-4b: enqueued-for-repair files do NOT block the checkpoint. The decoupled
  // sweep owns repair on its own wall-clock cadence and bumps the mutation version
  // when it actually re-embeds — which invalidates this checkpoint and makes the
  // next read re-detect the (now-healed / converged) state. Checkpointing here is
  // what STOPS the read loop from spinning while the sweep works in the background;
  // this is the core of the MA1 fix (a read pass never drains the repair backlog).
  if (shouldAdvanceDerivedLazyFillCheckpoint(failed)) {
    lastLazyFillCheckpoint.set(workspacePath, {
      mutationVersion: mutationVersionAtProjection,
      skipped: skipped + filled + deterministicSkip,
    });
  }
  logDeterministicSkip(deterministicSkip);
  logger.info(
    { filled, skipped, deterministicSkip, enqueuedForRepair, failed, durationMs },
    'file_vectors.lazy_fill_complete'
  );

  // FU-4b: hand any newly-detected non-finite files to the decoupled repair sweep.
  // This SCHEDULES (does not run) a wall-clock-rate-limited tick; it is never a
  // synchronous re-embed and never reenters lazy-fill. Safe to call every pass
  // (idempotent: a sweep already scheduled/running is left alone).
  if (enqueuedForRepair > 0) {
    scheduleNanRepairSweep(workspacePath);
  }
  return { filled, skipped: reportedSkipped, failed, durationMs };
}

// ============================================================================
// FU-4b — decoupled, wall-clock-rate-limited NaN-repair sweep (MA1)
// ============================================================================
//
// The single mechanism that performs the expensive re-embed repair. It is the
// ONLY caller of `_repairFileWithNonFiniteChunks`, it owns its own `setTimeout`
// cadence, and it is NEVER invoked from a read / neighbors reentry — so the rate
// cap cannot be bypassed by reentrant lazy-fill. Reads only enqueue paths (above).

/** True if any chunk's (materialized) vector contains a non-finite component. */
function chunksHaveNonFiniteVector(chunks: FileVectorSourceChunk[]): boolean {
  for (const chunk of chunks) {
    // MUST materialize the Arrow vector first: direct `vec[i]` indexing on a
    // non-materialized Arrow FloatVector returns `undefined`, which would make
    // EVERY chunk look "non-finite" and spuriously enqueue clean files.
    const vector = Array.from(chunk.vector);
    if (vector.some((value) => !Number.isFinite(value))) {
      return true;
    }
  }
  return false;
}

// Per-workspace scheduler handles. A pending timer means a tick is scheduled; an
// in-flight promise means a tick is executing. Both gate re-scheduling so the
// sweep is strictly single-flight per workspace and advances at most one tick per
// wall-clock interval regardless of how many reads enqueue in between.
const nanRepairSweepTimers = new Map<string, ReturnType<typeof setTimeout>>();
const nanRepairSweepInFlight = new Map<string, Promise<void>>();

/**
 * Schedule (idempotently) a NaN-repair sweep tick for `workspacePath`. If a tick
 * is already scheduled or running, this is a no-op — the rate is governed solely
 * by the sweep's own re-scheduling after each tick, never by the call rate here.
 * Even the FIRST tick waits a full wall-clock interval: repair is idle-healing,
 * not latency-critical, and the delay makes the bound unambiguously wall-clock-
 * governed (a burst of reads that each enqueue cannot pull a tick forward).
 * @param delayMs wall-clock delay before the tick fires (defaults to the inter-
 *   tick interval).
 */
function scheduleNanRepairSweep(
  workspacePath: string,
  delayMs = FILE_VECTOR_NAN_REPAIR_TICK_INTERVAL_MS
): void {
  if (nanRepairSweepTimers.has(workspacePath) || nanRepairSweepInFlight.has(workspacePath)) {
    return;
  }
  const pending = nanRepairPending.get(workspacePath);
  if (!pending || pending.size === 0) {
    return;
  }
  const timer = setTimeout(() => {
    nanRepairSweepTimers.delete(workspacePath);
    const promise = runNanRepairSweepTick(workspacePath);
    nanRepairSweepInFlight.set(workspacePath, promise);
    promise
      .catch((err) => {
        // Fire-and-forget background sweep: an unexpected tick-level throw is
        // logged and swallowed so it can't reject an unobserved promise. The
        // sweep self-reschedules below, so a transient failure simply retries.
        ignoreBestEffortCleanup(err, {
          operation: 'scheduleNanRepairSweep.tick',
          reason: 'background-sweep-tick-failure-logged-and-self-reschedules',
          owner: 'main.fileIndexService',
        });
        logger.warn({ err, workspacePath }, 'file_vectors.repair_sweep_failure');
      })
      .finally(() => {
        if (nanRepairSweepInFlight.get(workspacePath) === promise) {
          nanRepairSweepInFlight.delete(workspacePath);
        }
        // Re-schedule the NEXT tick a full wall-clock interval later IFF work
        // remains. This is the rate cap: at most FILE_VECTOR_NAN_REPAIR_PER_TICK
        // re-embeds per FILE_VECTOR_NAN_REPAIR_TICK_INTERVAL_MS, un-bypassable
        // because the cadence lives here, not on the read path.
        const remaining = nanRepairPending.get(workspacePath);
        if (remaining && remaining.size > 0 && getCurrentIndex()?.workspacePath === workspacePath) {
          scheduleNanRepairSweep(workspacePath, FILE_VECTOR_NAN_REPAIR_TICK_INTERVAL_MS);
        }
      });
  }, delayMs);
  // Don't keep the event loop / process alive solely for a repair tick.
  (timer as { unref?: () => void }).unref?.();
  nanRepairSweepTimers.set(workspacePath, timer);
}

/** Cancel any scheduled sweep tick for a workspace (called on close/clear). */
export function cancelNanRepairSweep(workspacePath: string): void {
  const timer = nanRepairSweepTimers.get(workspacePath);
  if (timer) {
    clearTimeout(timer);
    nanRepairSweepTimers.delete(workspacePath);
  }
}

/**
 * Execute ONE rate-limited repair tick: drain at most FILE_VECTOR_NAN_REPAIR_PER_
 * TICK pending paths, repairing each via the (purge + re-embed) primitive. Records
 * the at-most-once memo against BOTH the pre- and post-repair fingerprints (MA3),
 * and re-enqueues a `failed_after_purge` path (MA2 — recoverable, never lost).
 */
async function runNanRepairSweepTick(workspacePath: string): Promise<void> {
  const pending = nanRepairPending.get(workspacePath);
  if (!pending || pending.size === 0) {
    return;
  }

  const memo = getNanRepairMemoFor(workspacePath);
  const deterministicMemo = getDeterministicFailureMemoFor(workspacePath);
  const batch = [...pending].slice(0, FILE_VECTOR_NAN_REPAIR_PER_TICK);

  let repaired = 0;
  let repairNotRepairable = 0;
  let repairStillInvalidAllDropped = 0;
  let repairFailedBeforePurge = 0;
  let repairFailedAfterPurge = 0;
  let repairQuarantined = 0;
  let purgedChunkRows = 0;

  // FU-4c: handle a repair INFRASTRUCTURE failure (failed_before/after_purge).
  // Bound retries: keep the path queued for a later tick until the cap, then
  // QUARANTINE it (drop from the queue so the sweep can go quiet) and emit one
  // observable ERROR. The PRE at-most-once memo entry is cleared so a retry (or a
  // post-recovery re-attempt) is allowed; the failure is tracked separately from
  // the deterministic-skip memo (it is an infra failure, not unfillable content).
  const handleRepairFailure = (
    filePath: string,
    kind: NanRepairFailureKind,
    preKey: string | null
  ): void => {
    if (preKey !== null) {
      memo.get(filePath)?.delete(preKey);
    }
    const { attempts, capExhausted } = recordNanRepairFailure(workspacePath, filePath, kind);
    if (capExhausted) {
      // Quarantine: stop the perpetual per-tick re-embed loop for this path.
      pending.delete(filePath);
      repairQuarantined++;
      logger.error(
        {
          workspacePath,
          path: filePath,
          failureKind: kind,
          attempts,
          maxAttempts: FILE_VECTOR_NAN_REPAIR_MAX_ATTEMPTS,
        },
        'file_vectors.repair_quarantined'
      );
    }
  };

  await withWriteLock(async () => {
    if (getCurrentIndex()?.workspacePath !== workspacePath || !getCurrentIndex()?.table) {
      return;
    }
    for (const filePath of batch) {
      // Re-confirm the path still needs repair under the lock (it may have been
      // dequeued / healed by a concurrent path) and capture its PRE fingerprint.
      if (!pending.has(filePath)) {
        continue;
      }
      const preFingerprint = await readSingleFileChunkFingerprint(filePath);
      const preKey = preFingerprint ? buildFileVectorSourceFingerprint(preFingerprint) : null;
      if (preKey !== null && nanRepairAlreadyAttempted(memo, filePath, preKey)) {
        // Already repaired at this exact identity (MA3): drop it from the queue and
        // record a deterministic skip so it converges; do NOT re-embed.
        pending.delete(filePath);
        deterministicMemo.set(filePath, preKey);
        continue;
      }
      // Record the PRE attempt FIRST so even a thrown repair can never re-loop at
      // this identity (the repair-once invariant).
      if (preKey !== null) {
        recordNanRepairAttempt(memo, filePath, preKey);
      }

      const outcome = await _repairFileWithNonFiniteChunks(filePath, workspacePath);
      purgedChunkRows += outcome.purgedRows;

      if (outcome.state === 'not_repairable') {
        // Not a NaN target (e.g. zero-norm / mismatched dims): dequeue + drop the
        // PRE attempt (don't burn the once-gate on a non-target) + deterministic-skip.
        // Terminal for this identity → clear any prior infra-failure record (FU-4c).
        pending.delete(filePath);
        clearNanRepairFailure(workspacePath, filePath);
        if (preKey !== null) {
          memo.get(filePath)?.delete(preKey);
          deterministicMemo.set(filePath, preKey);
        }
        repairNotRepairable++;
      } else if (outcome.state === 'failed_before_purge') {
        // The repair threw BEFORE deleting old rows — corrupt rows intact, safe to
        // retry up to the bounded cap; then quarantine (FU-4c).
        handleRepairFailure(filePath, 'failed_before_purge', preKey);
        repairFailedBeforePurge++;
      } else if (outcome.state === 'failed_after_purge') {
        // MA2 — the re-index deleted the old rows then the re-add failed while the
        // source is still indexable on disk: the file is chunk-less but RECOVERABLE.
        // Retry up to the bounded cap, then QUARANTINE (FU-4c) so a path that
        // persistently fails (full disk / poisoned path / deterministic add error)
        // can't be re-embedded every tick forever. NEVER converge it as a
        // deterministic skip (it is an infra failure, not unfillable content).
        handleRepairFailure(filePath, 'failed_after_purge', preKey);
        repairFailedAfterPurge++;
      } else {
        // healed | still_invalid: the file is now in a terminal state for this
        // identity. Dequeue it and also record the POST-repair fingerprint (MA3) so
        // a guarded re-index that left fresh-but-still-invalid rows with a NEW
        // fingerprint cannot trigger another repair. Clear any prior failure record
        // (FU-4c) — it finally reached a terminal state.
        pending.delete(filePath);
        clearNanRepairFailure(workspacePath, filePath);
        const postFingerprint = await readSingleFileChunkFingerprint(filePath);
        const postKey = postFingerprint ? buildFileVectorSourceFingerprint(postFingerprint) : null;
        if (postKey !== null) {
          recordNanRepairAttempt(memo, filePath, postKey);
        }
        if (outcome.state === 'healed') {
          deterministicMemo.delete(filePath);
          repaired++;
        } else {
          // still_invalid: re-embed dropped everything → converged. Record a
          // deterministic skip keyed to whichever fingerprint still describes it.
          repairStillInvalidAllDropped++;
          const skipKey = postKey ?? preKey;
          if (skipKey !== null) {
            deterministicMemo.set(filePath, skipKey);
          }
        }
      }
    }
  });

  if (repaired > 0) {
    // Make the healed rows visible to Atlas / search (read handles). The write
    // file_vectors handle that the next lazy-fill pass reads is advanced to the
    // committed version by the warming read in `readFileVectorProjection` (see the
    // note there) — that is what keeps a just-healed file from being re-filled and
    // re-churning the mutation version.
    await _refreshReadTable();
  }

  logger.info(
    {
      workspacePath,
      repaired,
      repairNotRepairable,
      repairStillInvalidAllDropped,
      repairFailedBeforePurge,
      repairFailedAfterPurge,
      repairQuarantined,
      purgedChunkRows,
      remaining: nanRepairPending.get(workspacePath)?.size ?? 0,
    },
    'file_vectors.repair_summary'
  );
}

/**
 * Read the chunk fingerprint for a SINGLE path directly from the chunks table.
 * Returns null if the path has no chunk rows (e.g. all dropped by the guard).
 * Used by the repair sweep to compute pre/post-repair fingerprints (MA3).
 */
async function readSingleFileChunkFingerprint(
  filePath: string
): Promise<FileVectorFingerprint | null> {
  const table = getCurrentIndex()?.table;
  if (!table) {
    return null;
  }
  const rows = (await table
    .query()
    .where(eq('path', filePath))
    .select(['path', 'mtime', 'indexedAt', 'enhanced_at'])
    .toArray()) as FileVectorChunkProjectionRow[];
  if (rows.length === 0) {
    return null;
  }
  return buildChunkFingerprintProjection(rows).get(filePath) ?? null;
}

/** @internal — unit-test seam: synchronously run a single repair sweep tick. */
export async function _runNanRepairSweepTickForTesting(
  workspacePath: string | null = getCurrentIndex()?.workspacePath ?? null
): Promise<void> {
  if (!workspacePath) {
    return;
  }
  await runNanRepairSweepTick(workspacePath);
}

/** @internal — unit-test seam: read the pending-repair queue for a workspace. */
export function _getNanRepairPendingForTesting(
  workspacePath: string | null = getCurrentIndex()?.workspacePath ?? null
): ReadonlySet<string> | null {
  return workspacePath ? nanRepairPending.get(workspacePath) ?? null : null;
}

/**
 * @internal — unit-test seam: drive the real production scheduler entry point and
 * report whether it ARMED a sweep timer. Lets a test prove the sweep goes quiet
 * after quarantine — `scheduleNanRepairSweep` no-ops when the queue is empty, so
 * an armed timer here means there is still work the sweep would re-run (FU-4c).
 */
export function _scheduleAndCheckNanRepairSweepForTesting(
  workspacePath: string | null = getCurrentIndex()?.workspacePath ?? null
): boolean {
  if (!workspacePath) {
    return false;
  }
  // Cancel any pre-armed timer first so this probes whether scheduling NEWLY arms
  // based purely on the current queue state (an earlier enqueue may have armed the
  // real 30s timer; that is orthogonal to "is there work left after quarantine").
  cancelNanRepairSweep(workspacePath);
  scheduleNanRepairSweep(workspacePath);
  const armed = nanRepairSweepTimers.has(workspacePath);
  // Don't leave a real 30s timer dangling in the test process.
  cancelNanRepairSweep(workspacePath);
  return armed;
}

/**
 * Reconcile file_vectors against the canonical chunks table.
 * - For each path WITH AN EXISTING file_vectors row whose fingerprint mismatches the
 *   current chunks projection: recompute.
 * - For each file_vectors row whose path is NOT in the chunks projection: delete.
 * - Stage 3 owns missing-row case; reconcile does NOT cover that.
 *
 * Idempotent. Safe to run concurrently with live writes (uses withWriteLock per batch).
 */
export async function reconcileFileVectorsIfNeeded(): Promise<ReconcileFileVectorsResult> {
  const indexAtStart = getCurrentIndex();
  if (!indexAtStart?.table) {
    return { recomputed: 0, deleted: 0, skipped: 0, durationMs: 0 };
  }

  const tableAtStart = indexAtStart.table;
  const fileVectorsTableAtStart = indexAtStart.fileVectorsTable;
  const workspacePath = indexAtStart.workspacePath;
  const existing = reconcileInFlight.get(workspacePath);
  if (existing) {
    return existing;
  }

  const promise = reconcileFileVectorsForWorkspace(
    indexAtStart,
    tableAtStart,
    fileVectorsTableAtStart,
    workspacePath
  );
  reconcileInFlight.set(workspacePath, promise);
  try {
    return await promise;
  } finally {
    if (reconcileInFlight.get(workspacePath) === promise) {
      reconcileInFlight.delete(workspacePath);
    }
  }
}

async function reconcileFileVectorsForWorkspace(
  indexAtStart: WorkspaceIndex,
  tableAtStart: LanceDBTable,
  fileVectorsTableAtStart: LanceDBTable | null,
  workspacePath: string
): Promise<ReconcileFileVectorsResult> {
  const startTime = Date.now();
  logger.info({ workspacePath }, 'file_vectors.reconcile_start');

  let chunkFingerprints: Map<string, FileVectorFingerprint>;
  try {
    chunkFingerprints = await readChunkFingerprintProjection(tableAtStart);
  } catch (err) {
    const durationMs = Date.now() - startTime;
    logger.warn(
      { err, workspacePath, stage: 'chunks_projection', durationMs },
      'file_vectors.reconcile_partial_failure'
    );
    return { recomputed: 0, deleted: 0, skipped: 0, durationMs };
  }

  if (!isStillCurrent(indexAtStart, workspacePath) || getCurrentIndex()?.table !== tableAtStart) {
    return { recomputed: 0, deleted: 0, skipped: 0, durationMs: Date.now() - startTime };
  }

  let fileVectorProjection: Map<string, FileVectorFingerprint>;
  try {
    fileVectorProjection = await readFileVectorProjection(fileVectorsTableAtStart);
  } catch (err) {
    const durationMs = Date.now() - startTime;
    logger.warn(
      { err, workspacePath, stage: 'file_vectors_projection', durationMs },
      'file_vectors.reconcile_partial_failure'
    );
    return { recomputed: 0, deleted: 0, skipped: 0, durationMs };
  }

  if (!isStillCurrent(indexAtStart, workspacePath) || getCurrentIndex()?.table !== tableAtStart) {
    return { recomputed: 0, deleted: 0, skipped: 0, durationMs: Date.now() - startTime };
  }

  const pathsToRecompute: string[] = [];
  const pathsToDelete: string[] = [];
  let skipped = 0;

  for (const [filePath, chunkFingerprint] of chunkFingerprints) {
    const fileVectorFingerprint = fileVectorProjection.get(filePath);
    if (!fileVectorFingerprint) {
      skipped++;
      continue;
    }
    if (!fileVectorFingerprintsMatch(chunkFingerprint, fileVectorFingerprint)) {
      pathsToRecompute.push(filePath);
    }
  }

  for (const filePath of fileVectorProjection.keys()) {
    if (!chunkFingerprints.has(filePath)) {
      pathsToDelete.push(filePath);
    }
  }

  const totalToProcess = pathsToRecompute.length + pathsToDelete.length;
  let recomputed = 0;
  let deleted = 0;
  let processed = 0;
  let failed = 0;
  const failedPathSamples: string[] = [];

  const recordFailedPaths = (paths: string[]): void => {
    failed += paths.length;
    for (const filePath of paths) {
      if (failedPathSamples.length < 10) {
        failedPathSamples.push(filePath);
      }
    }
  };

  const logProgress = (): void => {
    if (
      totalToProcess > 0
      && (processed % FILE_VECTOR_RECONCILE_PROGRESS_INTERVAL === 0 || processed === totalToProcess)
    ) {
      logger.info(
        { processed, total: totalToProcess, recomputed, deleted, skipped, failed, durationMs: Date.now() - startTime },
        'file_vectors.reconcile_progress'
      );
    }
  };

  let aborted = false;

  for (let i = 0; i < pathsToRecompute.length; i += FILE_VECTOR_RECONCILE_BATCH_SIZE) {
    const batch = pathsToRecompute.slice(i, i + FILE_VECTOR_RECONCILE_BATCH_SIZE);
    const batchResult = await withWriteLock(async () => {
      if (!isStillCurrent(indexAtStart, workspacePath) || !getCurrentIndex()?.table) {
        return { recomputed: 0, skipped: 0, failedPaths: [] as string[], aborted: true };
      }

      let batchRecomputed = 0;
      let batchSkipped = 0;
      const batchFailedPaths: string[] = [];

      for (const filePath of batch) {
        try {
          const chunks = await _readChunksForFileVector(filePath);
          const result = await recomputeFileVectorRow(filePath, chunks);
          if (result === 'written') {
            batchRecomputed++;
          } else if (result === 'skipped') {
            batchSkipped++;
          } else {
            batchFailedPaths.push(filePath);
          }
        } catch (err) {
          batchFailedPaths.push(filePath);
          logger.warn({ err, path: filePath }, 'file_vectors.reconcile_path_failure');
        }
      }

      return {
        recomputed: batchRecomputed,
        skipped: batchSkipped,
        failedPaths: batchFailedPaths,
        aborted: false,
      };
    });

    if (batchResult.aborted) {
      aborted = true;
      break;
    }

    recomputed += batchResult.recomputed;
    skipped += batchResult.skipped;
    recordFailedPaths(batchResult.failedPaths);
    processed += batch.length;
    logProgress();

    if (processed < totalToProcess) {
      await waitForTurnIdle();
    }
  }

  if (!aborted) {
    for (let i = 0; i < pathsToDelete.length; i += FILE_VECTOR_RECONCILE_BATCH_SIZE) {
      const batch = pathsToDelete.slice(i, i + FILE_VECTOR_RECONCILE_BATCH_SIZE);
      const batchResult = await withWriteLock(async () => {
        if (
          !isStillCurrent(indexAtStart, workspacePath)
          || !getCurrentIndex()?.table
          || !getCurrentIndex()?.fileVectorsTable
        ) {
          return { deleted: 0, failedPaths: [] as string[], aborted: true };
        }

        try {
          await _deleteFileVectorRowsByPaths(batch);
          return { deleted: batch.length, failedPaths: [] as string[], aborted: false };
        } catch (err) {
          logger.warn({ err, paths: batch.length }, 'file_vectors.reconcile_delete_failure');
          return { deleted: 0, failedPaths: batch, aborted: false };
        }
      });

      if (batchResult.aborted) {
        aborted = true;
        break;
      }

      deleted += batchResult.deleted;
      recordFailedPaths(batchResult.failedPaths);
      processed += batch.length;
      logProgress();

      if (processed < totalToProcess) {
        await waitForTurnIdle();
      }
    }
  }

  if (recomputed > 0 || deleted > 0) {
    await _refreshReadTable();
  }

  const durationMs = Date.now() - startTime;
  if (failed > 0) {
    logger.warn(
      { workspacePath, failed, pathSamples: failedPathSamples, recomputed, deleted, skipped, durationMs },
      'file_vectors.reconcile_partial_failure'
    );
  }
  if (!aborted) {
    await reconcileFileNeighborsIfNeeded();
    startLazyFillFileNeighborsAsync();
  }
  logger.info({ recomputed, deleted, skipped, durationMs }, 'file_vectors.reconcile_complete');
  return { recomputed, deleted, skipped, durationMs };
}

// ============================================================================
// file_neighbors fill + reconcile + read (former C14) — C3 unit lives here
// ============================================================================

type FileNeighborVectorProjection = Pick<
  FileVectorRecord,
  'path'
  | 'relative_path'
  | 'vector'
  | 'source_max_chunk_mtime'
  | 'source_max_indexed_at'
  | 'source_max_enhanced_at'
  | 'source_chunk_count'
>;

type FileNeighborProjectionRow = Pick<
  FileNeighborRecord,
  'path' | 'source_vector_fingerprint' | 'k' | 'neighbor_paths' | 'neighbor_fingerprints'
>;

async function readFileVectorRowsForNeighbors(table: LanceDBTable): Promise<FileNeighborVectorProjection[]> {
  return (await table
    .query()
    .select([
      'path',
      'relative_path',
      'vector',
      'source_max_chunk_mtime',
      'source_max_indexed_at',
      'source_max_enhanced_at',
      'source_chunk_count',
    ])
    .toArray()) as FileNeighborVectorProjection[];
}

async function readFileNeighborProjection(
  table: LanceDBTable | null = getCurrentIndex()?.fileNeighborsTable ?? null
): Promise<Map<string, FileNeighborProjectionRow>> {
  if (!table) {
    return new Map();
  }

  let rows: FileNeighborProjectionRow[];
  try {
    rows = (await table
      .query()
      .select(['path', 'source_vector_fingerprint', 'k', 'neighbor_paths', 'neighbor_fingerprints'])
      .toArray()) as FileNeighborProjectionRow[];
  } catch (err) {
    if (isLikelySchemaProjectionError(err)) {
      await dropCurrentFileNeighborsTableAfterSchemaFailure('projection_read', err);
    }
    throw err;
  }

  const projection = new Map<string, FileNeighborProjectionRow>();
  for (const row of rows) {
    projection.set(row.path, {
      path: row.path,
      source_vector_fingerprint: row.source_vector_fingerprint,
      k: row.k,
      neighbor_paths: toStringArray(row.neighbor_paths),
      neighbor_fingerprints: toStringArray(row.neighbor_fingerprints),
    });
  }
  return projection;
}

async function writeFileNeighborRecordBatch(records: FileNeighborRecord[]): Promise<number> {
  if (records.length === 0) {
    return 0;
  }

  let recordsToAdd = records;
  const { table, createdWithRecord } = await ensureFileNeighborsTable(records[0]);
  if (createdWithRecord) {
    recordsToAdd = records.slice(1);
  } else {
    await table.delete(inAny('path', records.map(record => record.path)));
  }

  if (recordsToAdd.length > 0) {
    await table.add(recordsToAdd);
  }

  return records.length;
}

/**
 * Asynchronously populate file_neighbors for paths in file_vectors that lack a current row.
 * Long-running at large workspace sizes; fire-and-forget and single-flight per workspace.
 */
export function startLazyFillFileNeighborsAsync(): void {
  const indexAtStart = getCurrentIndex();
  if (!indexAtStart?.fileVectorsTable) {
    return;
  }

  const workspacePath = indexAtStart.workspacePath;
  const existing = fileNeighborsLazyFillControllers.get(workspacePath);
  if (existing && !existing.signal.aborted) {
    return;
  }

  const controller = new AbortController();
  fileNeighborsLazyFillControllers.set(workspacePath, controller);
  const promise = lazyFillFileNeighborsForWorkspace(indexAtStart, workspacePath, controller);
  fileNeighborsLazyFillPromises.set(workspacePath, promise);

  promise
    .catch(err => logger.warn({ err, workspacePath }, 'file_neighbors.lazy_fill_failure'))
    .finally(() => {
      if (fileNeighborsLazyFillControllers.get(workspacePath) === controller) {
        fileNeighborsLazyFillControllers.delete(workspacePath);
      }
      if (fileNeighborsLazyFillPromises.get(workspacePath) === promise) {
        fileNeighborsLazyFillPromises.delete(workspacePath);
      }
    });
}

/** @internal — unit-test seam for the fire-and-forget file_neighbors fill. */
export function _waitForFileNeighborsLazyFillForTesting(
  workspacePath: string | null = getCurrentIndex()?.workspacePath ?? null
): Promise<void> | null {
  return workspacePath ? fileNeighborsLazyFillPromises.get(workspacePath) ?? null : null;
}

/**
 * @internal — unit-test seam that drains every fire-and-forget background fill
 * for the active workspace to quiescence.
 *
 * `indexFile` (via `recomputeFileVectorRow`) kicks off `startLazyFillFileNeighborsAsync()`
 * as a fire-and-forget task. That neighbors fill internally calls
 * `findSimilarFilesByVectorOrThrow` → `prepareFileVectorsRead` →
 * `lazyFillFileVectorsIfNeeded`, so it transitively (re)creates any *missing*
 * `file_vectors` rows whose chunks still exist. A test that mutates `file_vectors`
 * out-of-band (e.g. deleting only the file_vectors row while leaving its chunks)
 * therefore races this background writer: under CPU load the fill can land *after*
 * the delete and resurrect the row. This helper lets such tests await the real
 * pending task before they manipulate state, instead of weakening assertions.
 *
 * Drains both the neighbors fill and the file_vectors fill, and tolerates the
 * neighbors fill's `setTimeout(0)` self-restart via a bounded loop.
 */
export async function _drainBackgroundFillsForTesting(
  workspacePath: string | null = getCurrentIndex()?.workspacePath ?? null
): Promise<void> {
  if (!workspacePath) {
    return;
  }
  // Bound the loop so a pathological restart cycle can't hang the test process.
  for (let i = 0; i < 50; i++) {
    _flushFileNeighborWriteTriggerForTesting();
    const neighborsFill = fileNeighborsLazyFillPromises.get(workspacePath) ?? null;
    const vectorsFill = lazyFillInFlight.get(workspacePath) ?? null;
    if (!neighborsFill && !vectorsFill) {
      // Let any queued `setTimeout(0)` restart (from a mutation that landed
      // mid-fill) schedule itself, then re-check before declaring quiescence.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (!fileNeighborsLazyFillPromises.get(workspacePath) && !lazyFillInFlight.get(workspacePath)) {
        return;
      }
      continue;
    }
    await Promise.allSettled([neighborsFill, vectorsFill].filter(Boolean) as Promise<unknown>[]);
  }
}

async function lazyFillFileNeighborsForWorkspace(
  indexAtStart: WorkspaceIndex,
  workspacePath: string,
  controller: AbortController
): Promise<void> {
  const startTime = Date.now();
  const chunksMutationVersionAtStart = getMutationVersion();
  const fileNeighborsEpochAtStart = getFileNeighborsEpoch();
  const k = DEFAULT_FILE_NEIGHBOR_K;
  let total = 0;
  let filled = 0;
  let skipped = 0;
  let failed = 0;
  let deterministicSkip = 0;
  let aborted = false;

  const abortRequested = (): boolean => controller.signal.aborted
    || !isStillCurrent(indexAtStart, workspacePath);

  try {
    if (abortRequested()) {
      aborted = true;
      return;
    }

    // MA3: refresh the cached symlink map at the start of the neighbors pass too
    // (mirrors lazyFillFileVectorsForWorkspace). Neighbors records carry
    // relative_path and the neighbors invalidate/delete path also converts via
    // index.symlinkMap, so bounding staleness to ≤ one pass here keeps those
    // conversions correct against a silent symlink retarget / mount swap.
    rebuildWorkspaceSymlinkMap();

    const checkpoint = lastFileNeighborsLazyFillCheckpoint.get(workspacePath);
    if (
      checkpoint?.chunksMutationVersion === chunksMutationVersionAtStart
      && checkpoint.fileNeighborsEpoch === fileNeighborsEpochAtStart
    ) {
      skipped = checkpoint.skipped;
      return;
    }

    let fileVectorRows: FileNeighborVectorProjection[];
    let neighborProjection: Map<string, FileNeighborProjectionRow>;
    try {
      fileVectorRows = await readFileVectorRowsForNeighbors(indexAtStart.fileVectorsTable!);
      neighborProjection = await readFileNeighborProjection(indexAtStart.fileNeighborsTable);
    } catch (err) {
      logger.warn({ err, workspacePath }, 'file_neighbors.lazy_fill_projection_failure');
      return;
    }

    if (abortRequested()) {
      aborted = true;
      logger.info({ workspacePath, filled, total, failed, reason: 'workspace_changed' }, 'file_neighbors.lazy_fill_aborted');
      return;
    }

    const vectorFingerprints = new Map<string, string>();
    for (const row of fileVectorRows) {
      vectorFingerprints.set(row.path, buildFileVectorSourceFingerprint(row));
    }

    const deterministicMemo = getDeterministicNeighborFailureMemoFor(workspacePath);
    const targets: FileNeighborVectorProjection[] = [];
    for (const row of fileVectorRows) {
      const fingerprint = vectorFingerprints.get(row.path) ?? buildFileVectorSourceFingerprint(row);
      const existing = neighborProjection.get(row.path);
      if (
        existing
        && existing.k === k
        && existing.source_vector_fingerprint === fingerprint
      ) {
        skipped++;
        deterministicMemo.delete(row.path);
        continue;
      }

      const recordedKey = deterministicMemo.get(row.path);
      if (recordedKey === fingerprint) {
        deterministicSkip++;
        continue;
      }
      if (recordedKey !== undefined) {
        deterministicMemo.delete(row.path);
      }

      targets.push(row);
    }

    for (const memoedPath of [...deterministicMemo.keys()]) {
      if (!vectorFingerprints.has(memoedPath)) {
        deterministicMemo.delete(memoedPath);
      }
    }

    total = targets.length;
    logger.info(
      {
        workspacePath,
        total,
        skipped,
        deterministicSkip,
        indexedFiles: fileVectorRows.length,
        durationMs: Date.now() - startTime,
      },
      'file_neighbors.lazy_fill_start'
    );

    if (total === 0) {
      if (shouldAdvanceDerivedLazyFillCheckpoint(failed)) {
        lastFileNeighborsLazyFillCheckpoint.set(workspacePath, {
          chunksMutationVersion: chunksMutationVersionAtStart,
          fileNeighborsEpoch: fileNeighborsEpochAtStart,
          skipped: skipped + deterministicSkip,
        });
      }
      return;
    }

    let pendingRecords: FileNeighborRecord[] = [];

    const flushPending = async (): Promise<void> => {
      if (pendingRecords.length === 0) {
        return;
      }
      if (abortRequested()) {
        aborted = true;
        pendingRecords = [];
        return;
      }
      const records = pendingRecords;
      pendingRecords = [];
      try {
        const written = await withWriteLock(async () => {
          if (abortRequested()) {
            aborted = true;
            return 0;
          }
          return writeFileNeighborRecordBatch(records);
        });
        if (written > 0) {
          filled += written;
          await _refreshReadTable();
          if (filled % FILE_NEIGHBOR_BROADCAST_PROGRESS_INTERVAL === 0 || filled === total) {
            broadcastFileNeighborsEvent('file_neighbors:progress', { filled, total });
          }
          if (filled % FILE_NEIGHBOR_LOG_PROGRESS_INTERVAL === 0 || filled === total) {
            logger.info(
              { workspacePath, filled, total, failed, durationMs: Date.now() - startTime },
              'file_neighbors.lazy_fill_progress'
            );
          }
        }
      } catch (err) {
        failed += records.length;
        logger.warn({ err, paths: records.map(record => record.path) }, 'file_neighbors.lazy_fill_write_failure');
      }
    };

    for (const target of targets) {
      if (abortRequested()) {
        aborted = true;
        logger.info({ workspacePath, filled, total, failed, reason: 'workspace_changed' }, 'file_neighbors.lazy_fill_aborted');
        return;
      }

      try {
        const targetVector = toNumberVector(target.vector);
        if (targetVector.length === 0 || targetVector.some((value) => !Number.isFinite(value))) {
          const fingerprint = vectorFingerprints.get(target.path);
          if (fingerprint) {
            deterministicMemo.set(target.path, fingerprint);
          }
          deterministicSkip++;
          continue;
        }
        const neighbors = await findSimilarFilesByVectorOrThrow(targetVector, k, { excludePath: target.path });
        if (abortRequested()) {
          aborted = true;
          logger.info({ workspacePath, filled, total, failed, reason: 'workspace_changed' }, 'file_neighbors.lazy_fill_aborted');
          return;
        }
        pendingRecords.push(buildFileNeighborRecord(
          target,
          neighbors,
          k,
          neighbors.map(neighbor => vectorFingerprints.get(neighbor.path) ?? '')
        ));
        deterministicMemo.delete(target.path);
      } catch (err) {
        failed++;
        logger.warn({ err, path: target.path }, 'file_neighbors.lazy_fill_search_failure');
      }

      if (pendingRecords.length >= FILE_NEIGHBOR_LAZY_FILL_BATCH_SIZE) {
        await flushPending();
        if (filled < total) {
          await waitForTurnIdle();
        }
      }
    }

    await flushPending();

    if (abortRequested()) {
      aborted = true;
      logger.info({ workspacePath, filled, total, failed, reason: 'workspace_changed' }, 'file_neighbors.lazy_fill_aborted');
      return;
    }

    if (shouldAdvanceDerivedLazyFillCheckpoint(failed)) {
      lastFileNeighborsLazyFillCheckpoint.set(workspacePath, {
        chunksMutationVersion: chunksMutationVersionAtStart,
        fileNeighborsEpoch: fileNeighborsEpochAtStart,
        skipped: skipped + filled + deterministicSkip,
      });
    }

    if (
      (getMutationVersion() !== chunksMutationVersionAtStart || getFileNeighborsEpoch() !== fileNeighborsEpochAtStart)
      && getCurrentIndex() === indexAtStart
    ) {
      // A chunk/file-vector write landed after this run captured its target set.
      // Defer the restart to the next macrotask so this run's promise/controller
      // finalizers clear the single-flight guard before the follow-up start checks it.
      setTimeout(() => startLazyFillFileNeighborsAsync(), 0);
    }
  } finally {
    const durationMs = Date.now() - startTime;
    broadcastFileNeighborsEvent('file_neighbors:complete', { filled, total, failed, aborted });
    logger.info(
      { workspacePath, filled, total, skipped, deterministicSkip, failed, aborted, durationMs },
      'file_neighbors.lazy_fill_complete'
    );
  }
}

export async function reconcileFileNeighborsIfNeeded(): Promise<ReconcileFileNeighborsResult> {
  const indexAtStart = getCurrentIndex();
  if (!indexAtStart?.fileVectorsTable || !indexAtStart.fileNeighborsTable) {
    return { deleted: 0, stale: 0, orphaned: 0, crossReferenceOrphans: 0, durationMs: 0 };
  }

  const workspacePath = indexAtStart.workspacePath;
  const existing = fileNeighborsReconcileInFlight.get(workspacePath);
  if (existing) {
    return existing;
  }

  const promise = reconcileFileNeighborsForWorkspace(indexAtStart, workspacePath);
  fileNeighborsReconcileInFlight.set(workspacePath, promise);
  try {
    return await promise;
  } finally {
    if (fileNeighborsReconcileInFlight.get(workspacePath) === promise) {
      fileNeighborsReconcileInFlight.delete(workspacePath);
    }
  }
}

async function reconcileFileNeighborsForWorkspace(
  indexAtStart: WorkspaceIndex,
  workspacePath: string
): Promise<ReconcileFileNeighborsResult> {
  const startTime = Date.now();
  logger.info({ workspacePath }, 'file_neighbors.reconcile_start');

  let fileVectorRows: FileNeighborVectorProjection[];
  let neighborProjection: Map<string, FileNeighborProjectionRow>;
  try {
    fileVectorRows = await readFileVectorRowsForNeighbors(indexAtStart.fileVectorsTable!);
    neighborProjection = await readFileNeighborProjection(indexAtStart.fileNeighborsTable);
  } catch (err) {
    const durationMs = Date.now() - startTime;
    logger.warn({ err, workspacePath, durationMs }, 'file_neighbors.reconcile_partial_failure');
    return { deleted: 0, stale: 0, orphaned: 0, crossReferenceOrphans: 0, durationMs };
  }

  if (!isStillCurrent(indexAtStart, workspacePath)) {
    return { deleted: 0, stale: 0, orphaned: 0, crossReferenceOrphans: 0, durationMs: Date.now() - startTime };
  }

  const vectorFingerprints = new Map<string, string>();
  for (const row of fileVectorRows) {
    vectorFingerprints.set(row.path, buildFileVectorSourceFingerprint(row));
  }

  const pathsToDelete = new Set<string>();
  let stale = 0;
  let orphaned = 0;
  let crossReferenceOrphans = 0;
  for (const [filePath, neighborRow] of neighborProjection) {
    const currentFingerprint = vectorFingerprints.get(filePath);
    if (!currentFingerprint) {
      orphaned++;
      pathsToDelete.add(filePath);
      continue;
    }
    if (neighborRow.k !== DEFAULT_FILE_NEIGHBOR_K || neighborRow.source_vector_fingerprint !== currentFingerprint) {
      stale++;
      pathsToDelete.add(filePath);
      continue;
    }

    let hasCrossReferenceOrphan = false;
    let hasReferencedVectorStale = neighborRow.neighbor_paths.length !== neighborRow.neighbor_fingerprints.length;
    for (const [index, neighborPath] of neighborRow.neighbor_paths.entries()) {
      const neighborFingerprint = vectorFingerprints.get(neighborPath);
      if (!neighborFingerprint) {
        hasCrossReferenceOrphan = true;
        break;
      }
      if (neighborRow.neighbor_fingerprints[index] !== neighborFingerprint) {
        hasReferencedVectorStale = true;
      }
    }

    if (hasCrossReferenceOrphan) {
      crossReferenceOrphans++;
      pathsToDelete.add(filePath);
      continue;
    }
    if (hasReferencedVectorStale) {
      stale++;
      pathsToDelete.add(filePath);
    }
  }

  const paths = [...pathsToDelete];
  let deleted = 0;
  for (let i = 0; i < paths.length; i += FILE_NEIGHBOR_RECONCILE_BATCH_SIZE) {
    const batch = paths.slice(i, i + FILE_NEIGHBOR_RECONCILE_BATCH_SIZE);
    const batchDeleted = await withWriteLock(async () => {
      if (!isStillCurrent(indexAtStart, workspacePath) || !getCurrentIndex()?.fileNeighborsTable) {
        return 0;
      }
      await deleteFileNeighborRowsByPaths(batch);
      return batch.length;
    });
    deleted += batchDeleted;
    if (i + FILE_NEIGHBOR_RECONCILE_BATCH_SIZE < paths.length) {
      await waitForTurnIdle();
    }
  }

  if (deleted > 0) {
    await _refreshReadTable();
    startLazyFillFileNeighborsAsync();
  }

  const durationMs = Date.now() - startTime;
  logger.info(
    { workspacePath, deleted, stale, orphaned, crossReferenceOrphans, durationMs },
    'file_neighbors.reconcile_complete'
  );
  return { deleted, stale, orphaned, crossReferenceOrphans, durationMs };
}

export async function readFileNeighbors(
  paths: string[]
): Promise<Record<string, Array<{ path: string; score: number }>>> {
  const index = getCurrentIndex();
  if (paths.length === 0 || !index?.table || !index.fileNeighborsReadTable) {
    return {};
  }

  const readHandle = index.fileNeighborsReadTable;
  const readTable = readHandle.acquire();
  const result: Record<string, Array<{ path: string; score: number }>> = {};
  try {
    const uniquePaths = [...new Set(paths)];
    for (let i = 0; i < uniquePaths.length; i += 50) {
      const batch = uniquePaths.slice(i, i + 50);
      const rows = (await readTable
        .query()
        .where(inAny('path', batch))
        .select(['path', 'neighbor_paths', 'neighbor_scores'])
        .toArray()) as Pick<FileNeighborRecord, 'path' | 'neighbor_paths' | 'neighbor_scores'>[];

      for (const row of rows) {
        const neighborPaths = toStringArray(row.neighbor_paths);
        const neighborScores = toNumberArray(row.neighbor_scores);
        result[row.path] = neighborPaths.map((neighborPath, index) => ({
          path: neighborPath,
          score: Number(neighborScores[index] ?? 0),
        }));
      }
    }
  } catch (err) {
    if (isLikelySchemaProjectionError(err)) {
      await dropCurrentFileNeighborsTableAfterSchemaFailure('read_file_neighbors', err);
    }
    logger.warn({ err, requestedPaths: paths.length }, 'file_neighbors.read_failure');
    return {};
  } finally {
    try {
      await readHandle.release();
    } catch (err) {
      logger.warn({ err }, 'ReadTableHandle.release threw during readFileNeighbors finally');
    }
  }

  return result;
}

// ============================================================================
// findSimilarFiles* (file_vectors vector search)
// ============================================================================

function normalizeFindSimilarLimit(k: number): number {
  if (!Number.isFinite(k)) {
    return 0;
  }
  return Math.max(0, Math.floor(k));
}

function scoreFromCosineDistance(distance: number): number | null {
  if (!Number.isFinite(distance)) {
    return null;
  }
  return Math.min(1, Math.max(0, 1 - distance));
}

function logLazyFillPartialFailure(workspacePath: string, fillResult: LazyFillFileVectorsResult): void {
  if (fillResult.failed === 0) {
    return;
  }

  logger.warn(
    {
      workspacePath,
      filled: fillResult.filled,
      skipped: fillResult.skipped,
      failed: fillResult.failed,
      durationMs: fillResult.durationMs,
    },
    'file_vectors.lazy_fill_partial_failure'
  );
}

async function prepareFileVectorsRead(workspaceAtStart: string): Promise<ReadTableHandle | null> {
  const fillResult = await lazyFillFileVectorsIfNeeded();
  logLazyFillPartialFailure(workspaceAtStart, fillResult);

  const index = getCurrentIndex();
  if (index?.workspacePath !== workspaceAtStart) {
    return null;
  }

  return index.fileVectorsReadTable;
}

/**
 * Find files most similar to a given file by its semantic vector.
 * Returns up to `k` results ranked by cosine similarity (most similar first).
 * The query file itself is excluded from results.
 *
 * Returns [] if `path` has no file_vectors row (not yet computed; caller treats as "no neighbors yet").
 */
export async function findSimilarFiles(
  path: string,
  k: number = 5
): Promise<FindSimilarFilesResult[]> {
  const limit = normalizeFindSimilarLimit(k);
  const index = getCurrentIndex();
  if (limit === 0 || !index?.table) {
    return [];
  }

  // workspaceAtStart pins the workspace this lookup targets; the live
  // getCurrentIndex() re-reads below detect a concurrent workspace switch.
  const workspaceAtStart = index.workspacePath;
  const readHandle = await prepareFileVectorsRead(workspaceAtStart);
  if (!readHandle || !getCurrentIndex()?.fileVectorsTable || getCurrentIndex()?.workspacePath !== workspaceAtStart) {
    return [];
  }

  const readTable = readHandle.acquire();
  try {
    if (getCurrentIndex()?.workspacePath !== workspaceAtStart) {
      return [];
    }

    const rows = await readTable
      .query()
      .where(eq('path', path))
      .limit(1)
      .toArray();

    if (getCurrentIndex()?.workspacePath !== workspaceAtStart) {
      return [];
    }

    if (rows.length === 0) {
      return [];
    }

    const record = rows[0] as Pick<FileVectorRecord, 'vector'> & { vector: number[] | Float32Array };
    return findSimilarFilesByVector(toNumberVector(record.vector), limit, { excludePath: path });
  } catch (err) {
    logger.warn({ err, path, k: limit }, 'find_similar_files.lookup_failure');
    return [];
  } finally {
    try {
      await readHandle.release();
    } catch (err) {
      logger.warn({ err }, 'ReadTableHandle.release threw during findSimilarFiles finally');
    }
  }
}

/**
 * Find files most similar to a query vector.
 * Used by atlasService for neighborhood lookups, semantic search, etc.
 */
export async function findSimilarFilesByVector(
  vector: number[],
  k: number = 5,
  options: { excludePath?: string } = {}
): Promise<FindSimilarFilesResult[]> {
  try {
    return await findSimilarFilesByVectorOrThrow(vector, k, options);
  } catch (err) {
    logger.warn({ err, k: normalizeFindSimilarLimit(k) }, 'find_similar_files.query_failure');
    return [];
  }
}

/**
 * Internal materialization path for vector search. Unlike `findSimilarFilesByVector`,
 * this propagates LanceDB failures so callers do not persist "empty but fresh" rows.
 */
export async function findSimilarFilesByVectorOrThrow(
  vector: number[],
  k: number = 5,
  options: { excludePath?: string } = {}
): Promise<FindSimilarFilesResult[]> {
  const limit = normalizeFindSimilarLimit(k);
  const index = getCurrentIndex();
  if (limit === 0 || vector.length === 0 || !index?.table) {
    return [];
  }

  // workspaceAtStart pins the workspace this lookup targets; the live
  // getCurrentIndex() re-reads below detect a concurrent workspace switch.
  const workspaceAtStart = index.workspacePath;
  const readHandle = await prepareFileVectorsRead(workspaceAtStart);
  if (!readHandle || !getCurrentIndex()?.fileVectorsTable || getCurrentIndex()?.workspacePath !== workspaceAtStart) {
    return [];
  }

  const readTable = readHandle.acquire();
  const startTime = Date.now();
  try {
    if (getCurrentIndex()?.workspacePath !== workspaceAtStart) {
      return [];
    }

    const overfetchLimit = limit + (options.excludePath ? 1 : 0);
    let query = readTable
      .vectorSearch(Array.from(vector))
      .distanceType('cosine')
      .limit(overfetchLimit);

    if (options.excludePath) {
      query = query.where(notEq('path', options.excludePath));
    }

    const rows = await query.toArray();

    if (getCurrentIndex()?.workspacePath !== workspaceAtStart) {
      return [];
    }

    const results: FindSimilarFilesResult[] = [];
    for (const row of rows) {
      const record = row as FileVectorRecord & { _distance?: number };
      if (options.excludePath && record.path === options.excludePath) {
        continue;
      }

      const score = scoreFromCosineDistance(record._distance ?? 1);
      if (score === null) {
        continue;
      }

      results.push({
        path: record.path,
        relativePath: record.relative_path,
        score,
      });

      if (results.length >= limit) {
        break;
      }
    }

    const latencyMs = Date.now() - startTime;
    if (latencyMs > 50) {
      logger.info({ k: limit, latencyMs, resultCount: results.length }, 'find_similar_files.query');
    }

    return results;
  } finally {
    try {
      await readHandle.release();
    } catch (err) {
      logger.warn({ err }, 'ReadTableHandle.release threw during findSimilarFilesByVector finally');
    }
  }
}

/**
 * Read the full materialized file_vectors table (Atlas / headless callers).
 * Triggers a lazy-fill first so newly-indexed files surface.
 */
export async function readAllFileVectors(): Promise<FileVectorRecord[]> {
  const indexAtEntry = getCurrentIndex();
  if (!indexAtEntry?.table) {
    return [];
  }

  const workspaceAtStart = indexAtEntry.workspacePath;
  const fillResult = await lazyFillFileVectorsIfNeeded();
  logLazyFillPartialFailure(workspaceAtStart, fillResult);

  const index = getCurrentIndex();
  if (index?.workspacePath !== workspaceAtStart) {
    return [];
  }

  const readHandle = index.fileVectorsReadTable;
  if (!readHandle) {
    return [];
  }
  const readTable = readHandle.acquire();

  try {
    const rows = await readTable.query().toArray();
    return rows.map((row) => {
      const record = row as Omit<FileVectorRecord, 'vector'> & { vector: number[] | Float32Array };
      return {
        path: record.path,
        relative_path: record.relative_path,
        vector: toNumberVector(record.vector),
        chunk_count: record.chunk_count,
        extension: record.extension,
        source_max_chunk_mtime: record.source_max_chunk_mtime,
        source_max_indexed_at: record.source_max_indexed_at,
        source_max_enhanced_at: record.source_max_enhanced_at,
        source_chunk_count: record.source_chunk_count,
        computed_at: record.computed_at,
      };
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to read file vectors');
    return [];
  } finally {
    try {
      await readHandle.release();
    } catch (err) {
      logger.warn({ err }, 'ReadTableHandle.release threw during readAllFileVectors finally');
    }
  }
}

/**
 * Get file-level embeddings for Atlas visualization.
 * Reads the materialized file_vectors table and preserves the legacy
 * camelCase response shape used by Atlas/headless callers.
 */
export async function getFileEmbeddings(): Promise<Array<{
  path: string;
  relativePath: string;
  vector: number[];
  chunkCount: number;
  mtime: number;
}>> {
  // Partial-clear read guard (S4.4): if the chunks table has been quarantined,
  // file_vectors may still exist on disk but must not be exposed as current.
  if (!getCurrentIndex()?.table) {
    logger.debug('No index available for file embeddings');
    return [];
  }

  const fileVectors = await readAllFileVectors();
  return fileVectors.map(row => ({
    path: row.path,
    relativePath: row.relative_path,
    vector: row.vector,
    chunkCount: row.chunk_count,
    mtime: row.source_max_chunk_mtime,
  }));
}
