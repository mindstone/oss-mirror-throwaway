/**
 * File Index Service
 *
 * Manages the semantic file index using LanceDB for vector storage.
 * Handles indexing, searching, and index maintenance operations.
 */

import { getPlatformConfig } from '@core/platform';
import { onElectronAppEvent } from '@core/lazyElectron';
import path from 'node:path';
// S4.1c: `fs` is retained for WRITES (writeFile/mkdir/rm/rename/unlink) + the two
// provably-LOCAL app-data reads (index metadata + the LanceDB dir probe), which carry a
// `workspace-fs-allow-local:` gate exemption. Every cloud-capable WORKSPACE read goes
// through the bounded boundary below (the Stage-7 bespoke `runCloudBoundedIndexRead`
// timer is retired — the boundary now owns the per-op kill/reclaim).
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {
  workspaceFs,
  type WorkspaceFsOutcome,
} from '@core/services/boundedWorkspaceFs';
import { logger } from '@core/logger';
import { getEmbeddingGenerator } from '@core/embeddingGenerator';
import { getInvalidVectorReason } from '@core/utils/vectorMath';
import * as sourceMetadataStore from '../sourceMetadataStore';
import * as entityMetadataStore from '../entityMetadataStore';
import { tryConvertToWorkspacePath } from '../../utils/systemUtils';
import { buildSymlinkMap } from '@core/utils/symlinkMap';
import { classifyPathForRemoval } from '@core/services/cloudSpaceContainment';
import { isCloudSymlinkIndexingEnabled } from '@core/services/cloudSymlinkIndexing';
import { isTooManyOpenFilesError } from '../../utils/emfileRetry';
import { isEnfileActive, markEnfileDetected } from '../../utils/enfileState';
import { eq, inAny, or } from '../../utils/lancedbPredicates';
import { toPortablePath } from '@core/utils/portablePath';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { loadNativeModule } from '@core/utils/loadNativeModule';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
import { redactAndTruncateRawError } from '@core/utils/redactRawError';
// Document parsing / chunking / indexability policy (Stage B1 extraction).
// Re-exported below to preserve the public API; internal helpers
// (chunkText, generateChunkId) are used on the index path within this module.
// The scoring helpers (calculateRecencyBoost, isSkillFile) + cosineDistance now
// live with the semantic-search cluster (Stage D1 ./search), so they are no
// longer imported here for use — only re-exported below to preserve the API.
import {
  buildEmbeddingText,
  chunkText,
  extractDocumentFrontmatter,
  generateChunkId,
  shouldIndexFile,
} from './documentParsing';
// Preserve the public export surface (Stage B1): these were previously defined
// here and are imported by consumers/tests via `@main/services/fileIndexService`.
export {
  buildEmbeddingText,
  cosineDistance,
  type DocumentFrontmatter,
  extractDocumentFrontmatter,
  extractDocumentTitle,
  shouldIndexFile,
} from './documentParsing';

// Cost batching (Stage B3) lives in ./costBatching; contextual retrieval +
// session metrics in ./contextualRetrieval. flushFileIndexCosts is re-exported
// to preserve the public API. The search path (Stage D1 ./search) bumps metrics
// via the recordSearch* helpers directly from ./contextualRetrieval, so index.ts
// no longer imports them.
export { flushFileIndexCosts } from './costBatching';
export {
  disableContextualRetrieval,
  enableContextualRetrieval,
  getSearchMetrics,
  resetSearchMetrics,
} from './contextualRetrieval';

// Optimize / version-cleanup (Stage B4) lives in ./optimize. It owns the
// optimize backoff state; the shared currentIndex singleton + withWriteLock are
// injected via wireOptimize(...) below so ownership stays in index.ts. The
// isOptimizing() accessor is read by closeIndexInternal.
import { isOptimizing, maybeOptimize, optimizeIndex, wireOptimize } from './optimize';

// file_vectors row writer (Stage C1) lives in ./fileVectorsWriter. It is the
// explicit, sole owner of file_vectors row writes; the four callers
// (indexFileInternal, updateChunkEmbeddingInternal, lazyFillFileVectorsForWorkspace,
// reconcileFileVectorsForWorkspace) all route through recomputeFileVectorRow.
// The shared currentIndex singleton + cross-cluster helpers (incl. the C3-owned
// fire-and-forget neighbors-fill scheduler) are injected via
// wireFileVectorsWriter(...) below so ownership stays in index.ts. The
// FileVectorSourceChunk type is owned there and re-imported here for the
// readChunksForFileVector projection.
import {
  recomputeFileVectorRow,
  wireFileVectorsWriter,
  type FileVectorSourceChunk,
} from './fileVectorsWriter';

// Semantic search (Stage D1) lives in ./search. It is a leaf module: it reads
// the shared currentIndex via ./state and the scoring/metric helpers from
// ./documentParsing + ./contextualRetrieval, with no edge back to index.ts. The
// public semanticSearch entry + the SemanticSearchResult type are re-exported
// here to preserve the consumer/test import path.
export {
  semanticSearch,
  semanticSearchWithStatus,
  type FileSearchStatus,
  type FileSearchStatusResult,
  type SemanticSearchResult,
} from './search';

// Two-phase enhancement state + chunk getters (Stage D1) live in ./enhancement.
// It reaches the enhancementState counters via ./state, the file_vectors writer
// + optimize scheduler from their sibling modules, and the index.ts-private
// readChunksForFileVector projection via wireEnhancement(...) below. The public
// entries are re-exported here; refreshEnhancementCounts + updateEnhancementState
// are also imported for the lifecycle/index paths that still live in index.ts.
import {
  refreshEnhancementCounts,
  updateEnhancementState,
  wireEnhancement,
} from './enhancement';
export {
  getChunkCounts,
  getEnhancementState,
  getUnenhancedChunks,
  refreshEnhancementCounts,
  updateChunkEmbedding,
  updateEnhancementState,
} from './enhancement';

// Derived views — file_vectors + file_neighbors lazy-fill/reconcile/read +
// findSimilar* (Stage D1, ./vectorsDerive). Absorbs the de-scoped Stage C3: the
// fire-and-forget neighbors scheduling + fill moved here AS A UNIT, preserving
// the EXACT workspacePath single-flight key and the mutationVersion-gated
// setTimeout(0) self-restart (pinned by fileNeighbors.test.ts:543/619). The
// module reaches shared state via ./state and the writer via ./fileVectorsWriter;
// the index.ts-private helpers (removal-path resolution, refreshReadTable,
// readChunksForFileVector, deleteFileVectorRowsByPaths) are injected via
// wireVectorsDerive(...) below. index.ts imports back the neighbor-side helpers
// it still calls (the removal cascade, the writer's invalidate hook, the
// close/clear abort, toNumberVector for the writer wiring).
import {
  abortFileNeighborsLazyFill,
  cancelNanRepairSweep,
  deleteFileNeighborRowsForRemovedPaths,
  invalidateFileNeighborsForVectorWrite,
  startLazyFillFileNeighborsAsync,
  toNumberVector,
  wireVectorsDerive,
} from './vectorsDerive';
export {
  findSimilarFiles,
  findSimilarFilesByVector,
  findSimilarFilesByVectorOrThrow,
  getFileEmbeddings,
  lazyFillFileVectorsIfNeeded,
  readAllFileVectors,
  readFileNeighbors,
  reconcileFileNeighborsIfNeeded,
  reconcileFileVectorsIfNeeded,
  startLazyFillFileNeighborsAsync,
  _drainBackgroundFillsForTesting,
  _getNanRepairPendingForTesting,
  _runNanRepairSweepTickForTesting,
  _scheduleAndCheckNanRepairSweepForTesting,
  _waitForFileNeighborsLazyFillForTesting,
} from './vectorsDerive';

// Shared mutable state owner (Stage C2). state.ts is the single owner of
// currentIndex, the write lock, the mutation-version epoch, the six
// in-flight/checkpoint maps, enhancementState, and cachedMetadataForStatus.
// index.ts reaches all of them through these explicit accessors; the
// WorkspaceIndex struct shape lives there too (preserved exactly) and is
// re-imported here for construction + the public type re-export.
import {
  getCachedMetadataForStatus,
  getCurrentIndex,
  getDeterministicFileVectorFailures,
  getNanRepairAttempts,
  getNanRepairFailures,
  getNanRepairPending,
  getEnhancementStateRaw,
  getMutationVersion,
  markChunksTableMutated,
  getFileNeighborsLazyFillPromises,
  getLastLazyFillCheckpoint,
  setCachedMetadataForStatus,
  setCurrentIndex,
  withWriteLock,
  type FileEmbeddingRecord,
  type IndexMetadata,
  type WorkspaceIndex,
} from './state';

function isLanceTableNotFoundError(error: unknown, tableName: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`Table '${tableName}' was not found`) || message.includes(`${tableName}.lance`);
}

const TABLE_NAME = 'file_embeddings';
export const FILE_VECTORS_TABLE_NAME = 'file_vectors';
export const FILE_NEIGHBORS_TABLE_NAME = 'file_neighbors';
const METADATA_FILE = 'index_metadata.json';
export const MAX_FILE_SIZE = 1024 * 1024; // 1MB max file size to index



// IndexMetadata, the WorkspaceIndex shape, and the EnhancementState shape are
// owned by ./state (Stage C2) and imported above. They were always internal
// types — no public re-export needed.

// Current embedding model name - used for index compatibility tracking
export const CURRENT_EMBEDDING_MODEL = 'Xenova/bge-small-en-v1.5';

type LanceDBConnection = Awaited<ReturnType<typeof import('@lancedb/lancedb').connect>>;
type LanceDBTable = Awaited<ReturnType<LanceDBConnection['openTable']>>;

// ReadTableHandle lease extracted to a sibling module (Stage B2). Re-exported
// so the class (a runtime value used in tests) stays importable from
// `@main/services/fileIndexService`. Behavior-preserving move; no logic change.
import { ReadTableHandle } from './readTableHandle';
export { ReadTableHandle } from './readTableHandle';

// Cached symlink-registry accessors (Stage 2): the file watcher reads the
// cached map for its hot-path conversions and triggers a rebuild on directory
// add/remove so the cache cannot go stale across symlink-topology changes.
export { getWorkspaceSymlinkMap, rebuildWorkspaceSymlinkMap } from './state';

// Live LanceDB open-connection count (0 or 2) for the native-liveness snapshot
// captured at the macOS quit-deadlock boundary — see nativeLivenessSnapshot.ts.
export { getFileLanceLiveConnectionCount } from './state';

// MA4 (Stage 4 repair contract): a repair path that rewrites bad chunk vectors
// in place — preserving mtime/indexed_at/enhanced_at/count so the deterministic-
// skip fingerprint is unchanged — MUST call this to force lazy-fill to re-attempt
// the repaired file(s). See state.ts for the full rationale. Equivalent to (or
// complementary with) bumping the mutation version via markChunksTableMutated().
export { clearDeterministicVectorSkip } from './state';

// FileEmbeddingRecord / FileVectorRecord / FileNeighborRecord / FindSimilarFilesResult
// are owned by ./state (Stage D1 — shared between the derived-views cluster and
// index.ts) and re-exported here to preserve the public API (consumers + tests).
// Shapes unchanged. SemanticSearchResult + semanticSearch live in ./search (also
// re-exported above).
export type {
  FileEmbeddingRecord,
  FileNeighborRecord,
  FileVectorRecord,
  FindSimilarFilesResult,
} from './state';

/** State of the indexing system */
export type IndexState = 'not_started' | 'watching' | 'paused';

export interface IndexStatus {
  totalFiles: number;
  indexedFiles: number;
  pendingFiles: number;
  lastIndexedAt: number | null;
  isWatching: boolean;
  workspacePath: string | null;
  /** Current state of the indexing system */
  indexState: IndexState;
  // Two-phase indexing: enhancement progress
  totalChunks: number;
  enhancedChunks: number;
  enhancementRunning: boolean;
  enhancementPaused: boolean;
}

// The WorkspaceIndex struct, the currentIndex singleton, and
// cachedMetadataForStatus are owned by ./state (Stage C2). Reached here via
// getCurrentIndex()/setCurrentIndex() and the cached-metadata accessors.

/**
 * @internal — unit-test seam. Lets fdLeak.test.ts drive the
 * `semanticSearch` write-fallback null-check path (no-readTable +
 * concurrent table mutation) without needing a real LanceDB connection.
 * Production code MUST NOT call this; it's only re-exported for tests.
 * Routes through the ./state owner so the singleton has a single home.
 */
export function _setCurrentIndexForTesting(next: WorkspaceIndex | null): void {
  setCurrentIndex(next);
}

/**
 * @internal — unit-test seam. Read-only view of `currentIndex` for tests
 * that need to mutate fields on the live module-level reference (e.g. to
 * simulate a concurrent `clearIndex` mid-search). Routes through ./state.
 */
export function _getCurrentIndexForTesting(): WorkspaceIndex | null {
  return getCurrentIndex();
}

/**
 * @internal — unit-test seam for optimize lifecycle coverage.
 * Production code should rely on `maybeOptimize()` to schedule compaction.
 */
export function _optimizeIndexForTesting(): Promise<void> {
  return optimizeIndex();
}

/**
 * @internal — unit-test seam (Stage 3). Reads the cross-cluster mutation-version
 * epoch so convergence tests can assert that a no-work lazy-fill pass over a
 * deterministically-unfillable set does NOT bump the version (which is what would
 * otherwise re-trigger the file_neighbors master loop's `setTimeout(0)` restart).
 */
export function _getMutationVersionForTesting(): number {
  return getMutationVersion();
}

/**
 * @internal — unit-test seam (Stage 3). Exposes the per-workspace
 * deterministic-failure memo so tests can assert a file is recorded once and
 * cleared when its content identity changes.
 */
export function _getDeterministicFileVectorFailuresForTesting(): Map<string, Map<string, string>> {
  return getDeterministicFileVectorFailures();
}

/**
 * @internal — unit-test seam (FU-4). Exposes the per-workspace one-time
 * NaN-repair memo so tests can assert a file is repair-attempted at most once
 * per content identity (repair-once) and that a healed file's entry is cleared.
 */
export function _getNanRepairAttemptsForTesting(): Map<string, Map<string, Set<string>>> {
  return getNanRepairAttempts();
}

/**
 * @internal — unit-test seam (FU-4c). Exposes the per-workspace repair-failure /
 * quarantine tracking map so tests can assert bounded retries + quarantine.
 */
export function _getNanRepairFailuresForTesting(): ReturnType<typeof getNanRepairFailures> {
  return getNanRepairFailures();
}

// ============================================================================
// SINGLE-WRITER PATTERN: Serialize all LanceDB mutations to prevent corruption
// ============================================================================
//
// LanceDB write operations (add, delete, update, dropTable, optimize) are not
// thread-safe when called concurrently. This can lead to index corruption
// (REBEL-JK errors) when file watcher, enhancement service, and user operations
// race against each other.
//
// Solution: All public mutation functions acquire the write lock via withWriteLock().
// Internal functions (*Internal) do NOT acquire the lock - they trust their caller
// holds it. This prevents deadlock from nested calls like:
//   indexFile() -> removeFileFromIndex() (both need the lock)
// ============================================================================

// The single-writer lock (writeChain + withWriteLock) is owned by ./state
// (Stage C2). withWriteLock is imported above. The "*Internal functions trust
// their caller holds the lock" convention is unchanged:
//
//   export async function indexFile(...) {
//     return withWriteLock(() => indexFileInternal(...));
//   }
//   async function indexFileInternal(...) { /* actual work, can call other *Internal */ }

// Inject the shared dependencies the optimize cluster reads (Stage B4). The
// currentIndex singleton + write lock now live in ./state; wiring via closures
// re-points the B4 injection at the state owner (and still avoids a circular
// import edge).
wireOptimize({ getCurrentIndex: () => getCurrentIndex(), withWriteLock });

// Inject the shared dependencies the file_vectors writer reads (Stage C1),
// re-pointed at the ./state owner for currentIndex (Stage C2). As of Stage D1,
// toNumberVector / invalidateFileNeighborsForVectorWrite /
// startLazyFillFileNeighborsAsync are owned by ./vectorsDerive and imported
// above; deleteFileVectorRowsByPaths is still index.ts-local (depends on the
// removal-path resolution that stays here). The arrows keep the call sites
// stable. startLazyFillFileNeighborsAsync is the (now ./vectorsDerive-owned)
// fire-and-forget scheduling side-effect — passed through unchanged so the
// writer kicks it from exactly the same place as before (C3 boundary preserved).
wireFileVectorsWriter({
  getCurrentIndex: () => getCurrentIndex(),
  toNumberVector: (vector) => toNumberVector(vector),
  deleteFileVectorRowsByPaths: (paths) => deleteFileVectorRowsByPaths(paths),
  invalidateFileNeighborsForVectorWrite: (filePath, sourceRecord) =>
    invalidateFileNeighborsForVectorWrite(filePath, sourceRecord),
  startLazyFillFileNeighborsAsync: () => startLazyFillFileNeighborsAsync(),
});

// Inject the index.ts-private readChunksForFileVector projection into the
// enhancement cluster (Stage D1). Wrapped in an arrow so the late-defined
// hoisted declaration resolves at call time, matching the wireFileVectorsWriter
// pattern above.
wireEnhancement({
  readChunksForFileVector: (filePath) => readChunksForFileVector(filePath),
});

// Inject the index.ts-private helpers the derived-views cluster reads (Stage D1).
// These stay in index.ts because they belong to the removal / lifecycle paths
// (removal-path resolution, the read-table refresh, the chunk projection, the
// file_vectors row deleter). Wrapped in arrows so the late-defined hoisted
// declarations resolve at call time.
wireVectorsDerive({
  getRemovalRelativePath: (filePath) => getRemovalRelativePath(filePath),
  getRemovalMtimeCandidates: (filePath) => getRemovalMtimeCandidates(filePath),
  refreshReadTable: () => refreshReadTable(),
  readChunksForFileVector: (filePath) => readChunksForFileVector(filePath),
  deleteFileVectorRowsByPaths: (paths) => deleteFileVectorRowsByPaths(paths),
  repairFileWithNonFiniteChunks: (filePath, workspacePath) =>
    repairFileWithNonFiniteChunks(filePath, workspacePath),
});

// The file_vectors / file_neighbors lazy-fill + reconcile batch/progress sizing
// constants moved to ./vectorsDerive (Stage D1) along with their only consumers.
// The schema-seed sentinel stays: initializeIndexInternal still deletes the seed
// row when opening an existing file_neighbors table.
const FILE_NEIGHBORS_SCHEMA_SEED_PATH = '__file_neighbors_schema_seed__';

// Bounded wait at index shutdown for in-flight readers to release their lease
// before the read connection is closed underneath them. Matches the existing
// `optimize()` drain budget in `closeIndexInternal` so shutdown latency is
// bounded by the same envelope.
const SHUTDOWN_DRAIN_TIMEOUT_MS = 3000;

// The mutation-version epoch + the six single-flight/checkpoint maps are owned
// by ./state (Stage C2) and now consumed entirely by the derived-views cluster
// (Stage D1 ./vectorsDerive), which binds its own aliases. index.ts no longer
// touches them, so the prior local aliases here were removed.

/**
 * Get the index storage directory for a workspace
 */
function getIndexStorageDir(workspacePath: string): string {
  const workspaceHash = crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 16);
  const userDataPath = getPlatformConfig().userDataPath;
  return path.join(userDataPath, 'indices', workspaceHash);
}

/**
 * Get the LanceDB storage directory (subdirectory of index storage)
 */
function getLanceDBDir(workspacePath: string): string {
  return path.join(getIndexStorageDir(workspacePath), 'lancedb');
}

/**
 * Get the metadata file path for a workspace
 */
function getMetadataPath(workspacePath: string): string {
  return path.join(getIndexStorageDir(workspacePath), METADATA_FILE);
}

/**
 * Load metadata from disk
 */
async function loadMetadata(workspacePath: string): Promise<IndexMetadata> {
  const metadataPath = getMetadataPath(workspacePath);
  try {
    // workspace-fs-allow-local: index metadata lives in app-data (<userData>/indices/<hash>/), NEVER a workspace/cloud path — bare fs is correct here.
    const data = await fs.readFile(metadataPath, 'utf-8');
    return JSON.parse(data) as IndexMetadata;
  } catch {
    return { scanCompletedAt: null, totalFilesAtCompletion: null };
  }
}

/**
 * Save metadata to disk
 */
async function saveMetadata(workspacePath: string, metadata: IndexMetadata): Promise<void> {
  const metadataPath = getMetadataPath(workspacePath);
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
}


/**
 * Add missing filename_stem column to existing tables via in-place migration.
 * Uses DataFusion SQL to extract filename stem from the path column, avoiding
 * a full table drop + rescan. Also normalizes existing relativePath backslashes.
 *
 * file_vectors migration note: if a file_vectors table is present while this
 * legacy chunk-table migration runs, drop it first. The table is derived and
 * recoverable, and dropping it mechanically prevents stale relative_path /
 * filename_stem-era drift from surviving unusual upgrade or write ordering.
 */
async function migrateAddFilenameStem(table: LanceDBTable, connection: LanceDBConnection): Promise<boolean> {
  try {
    const tableNames = await connection.tableNames();
    if (tableNames.includes(FILE_VECTORS_TABLE_NAME)) {
      try {
        await connection.dropTable(FILE_VECTORS_TABLE_NAME);
      } catch (dropError) {
        if (!isLanceTableNotFoundError(dropError, FILE_VECTORS_TABLE_NAME)) {
          throw dropError;
        }
      }
      logger.info(
        {
          tableName: FILE_VECTORS_TABLE_NAME,
          reason: 'filename_stem_migration_drift_prevention',
        },
        'file_vectors.migration_drop'
      );
    }
    if (tableNames.includes(FILE_NEIGHBORS_TABLE_NAME)) {
      try {
        await connection.dropTable(FILE_NEIGHBORS_TABLE_NAME);
      } catch (dropError) {
        if (!isLanceTableNotFoundError(dropError, FILE_NEIGHBORS_TABLE_NAME)) {
          throw dropError;
        }
      }
      logger.info(
        {
          tableName: FILE_NEIGHBORS_TABLE_NAME,
          reason: 'filename_stem_migration_drift_prevention',
        },
        'file_neighbors.migration_drop'
      );
    }

    // SQL expression to extract filename stem from absolute path.
    // Handles dotfiles (.gitignore → .gitignore), regular files (budget.md → budget),
    // extensionless files (Dockerfile → Dockerfile), and both / and \ separators.
    //
    // DataFusion uses standard SQL string escaping (no backslash escaping in ordinary
    // string literals). Backslash is literal in SQL strings, but IS an escape character
    // in regexp patterns. So: SQL '\\' = two-char string "\\", but in regexp context
    // the regex engine sees \\ as escaped-backslash = literal \.
    const basenameSql = "regexp_replace(path, '^.*[/\\\\]', '')";
    const stemSql = `CASE WHEN ${basenameSql} LIKE '.%' AND strpos(substr(${basenameSql}, 2), '.') = 0 THEN ${basenameSql} ELSE regexp_replace(${basenameSql}, '\\.[^.]*$', '') END`;

    await table.addColumns([{ name: 'filename_stem', valueSql: stemSql }]);

    // Normalize existing relativePath values: replace backslashes with forward slashes
    // so Windows-stored paths work with SQL LIKE filters and isSkillFile() checks.
    // DataFusion LIKE does not treat backslash as escape, so '\' is a literal backslash.
    // Intentionally left as raw SQL: this uses DataFusion functions in a schema migration,
    // not a parameterized column/value predicate that lancedbPredicates abstracts.
    try {
      await table.update({
        where: `strpos(\`relativePath\`, '\\') > 0`,
        valuesSql: { relativePath: "replace(`relativePath`, '\\', '/')" }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- valuesSql overload not in all type definitions
      } as any);
    } catch {
      // Non-fatal: normalization is defense-in-depth. New writes are already normalized.
      logger.debug('Could not normalize existing relativePath backslashes (non-fatal)');
    }

    logger.info('Added filename_stem column via schema migration (avoided full rescan)');
    return true;
  } catch (error) {
    logger.warn({ err: error }, 'Failed to add filename_stem via migration — will fall back to rebuild');
    return false;
  }
}

/**
 * Check if existing table has the new schema with is_enhanced/enhanced_at columns.
 * 
 * If not, returns false to signal the table should be dropped and rebuilt.
 * This handles automatic migration for users upgrading from old versions.
 * 
 * Note: Using snake_case column names (is_enhanced) and integers (0/1) instead of
 * booleans because LanceDB's SQL parser cannot parse boolean literals (true/false).
 */
async function checkSchemaCompatibility(table: LanceDBTable, connection: LanceDBConnection): Promise<boolean> {
  try {
    const schema = await table.schema();
    const fields = schema.fields as Array<{ name: string }>;
    
    // Check for required snake_case columns
    const hasIsEnhanced = fields.some((f) => f.name === 'is_enhanced');
    const hasFilenameStem = fields.some((f) => f.name === 'filename_stem');
    
    if (!hasIsEnhanced) {
      // Check if it has old camelCase columns (migration case)
      const hasOldIsEnhanced = fields.some((f) => f.name === 'isEnhanced');
      if (hasOldIsEnhanced) {
        logger.info('Old index schema detected (camelCase isEnhanced column) - will rebuild with snake_case');
      } else {
        logger.info('Old index schema detected (missing is_enhanced column) - will rebuild');
      }
      return false;
    }
    
    if (!hasFilenameStem) {
      // Try in-place migration before falling back to expensive drop + rescan
      const migrated = await migrateAddFilenameStem(table, connection);
      if (migrated) {
        logger.info('Schema migrated: filename_stem added without rescan');
        return true;
      }
      logger.info('Index schema missing filename_stem column (needed for FTS) - will rebuild');
      return false;
    }
    
    // Column exists with correct name - test that queries work
    try {
      await table
        .query()
        .where('is_enhanced = 0')
        .select(['id'])
        .limit(1)
        .toArray();
      
      logger.info('Index schema is compatible (is_enhanced column works)');
      return true;
    } catch (queryError) {
      logger.warn({ err: queryError }, 'Schema test query failed - will rebuild');
      return false;
    }
  } catch (error) {
    logger.warn({ err: error }, 'Failed to check schema compatibility');
    return false;
  }
}

// Observability for FTS (keyword) index degradation. A failed FTS build leaves
// `ftsStatus === 'failed'` and hybrid search silently degrades to vector-only
// ranking — historically with only a pino log, invisible to telemetry (the
// library-scan postmortem's "the freeze was invisible to telemetry" class).
// Stage 1 of docs/plans/260618_semantic-index-error-surfacing/PLAN.md: surface
// the degradation to Sentry via the `file_index_fts_degraded` known condition.
//
// Latch (REQUIRED, not a comment): `captureKnownCondition` dedupes the Sentry
// *issue* by fingerprint but does NOT bound event *volume*. This once-per-process
// `Set` keyed by `${workspacePath}:${phase}` bounds it to ≤1 event per failing
// workspace per phase per process — defending against workspace-switch re-init
// churn and multi-user self-heal. (Idiom mirrors errorReporter.ts `offWarnLatched`.)
const ftsDegradedCaptureLatch = new Set<string>();

/** @internal — unit-test seam: clear the once-per-process FTS-degraded latch. */
export function _resetFtsDegradedLatchForTesting(): void {
  ftsDegradedCaptureLatch.clear();
}

/**
 * Capture an FTS-degraded known condition at most once per (workspace, phase)
 * per process. PII-safe by construction: the raw LanceDB error string can embed
 * workspace paths, so we NEVER pass it to Sentry — we build a synthetic Error
 * from a `redactAndTruncateRawError`-scrubbed message whose stack points at this
 * capture site (path-free). The unredacted error stays in the local pino log.
 */
function captureFtsDegradedOnce(
  workspacePath: string,
  phase: 'create' | 'verify' | 'runtime',
  rawError: unknown,
): void {
  const latchKey = `${workspacePath}:${phase}`;
  if (ftsDegradedCaptureLatch.has(latchKey)) {
    return;
  }
  ftsDegradedCaptureLatch.add(latchKey);

  const rawMessage = String((rawError as Error | undefined)?.message ?? rawError ?? 'unknown');
  const syntheticError = new Error(
    redactAndTruncateRawError(rawMessage) ?? 'FTS index degraded',
  );
  captureKnownCondition('file_index_fts_degraded', { phase }, syntheticError);
}

/**
 * Ensure FTS indexes exist on `content` and `filename_stem` columns.
 * Creates them if missing, then verifies via listIndices() that the indexes
 * actually exist (catches silent failures from naming issues or other problems).
 *
 * `workspacePath` is used only to key the once-per-process Sentry latch
 * (`captureFtsDegradedOnce`) — it never reaches Sentry (PII).
 *
 * Stage 0 finding: FTS index creation took 4ms for 12 rows (~19ms extrapolated for 56K rows).
 * Synchronous creation is fine — no async/fire-and-forget pattern needed.
 *
 * Note: LanceDB names FTS indexes as `${column}_idx` by convention.
 */
async function ensureFTSIndexes(table: LanceDBTable, workspacePath: string): Promise<boolean> {
  const requiredColumns = ['content', 'filename_stem'];
  try {
    const lancedb = loadNativeModule<typeof import('@lancedb/lancedb')>('@lancedb/lancedb');
    const indices = await table.listIndices();
    const indexedColumns = new Set(indices.map(i => i.columns[0]));

    let created = false;
    for (const column of requiredColumns) {
      if (!indexedColumns.has(column)) {
        logger.info({ column }, 'Creating FTS index');
        await table.createIndex(column, {
          config: column === 'content'
            ? lancedb.Index.fts({ stem: true, removeStopWords: true, lowercase: true })
            : lancedb.Index.fts({ lowercase: true })
        });
        created = true;
      }
    }

    // Post-create verification: re-list and confirm all required columns are indexed
    if (created) {
      const verifyIndices = await table.listIndices();
      const verifyColumns = new Set(verifyIndices.map(i => i.columns[0]));
      const missing = requiredColumns.filter(c => !verifyColumns.has(c));
      if (missing.length > 0) {
        // Column names are path-free; keep them in the local pino log only (the
        // Sentry condition schema stays minimal at `{ phase }`).
        logger.error(
          { missingColumns: missing, actualColumns: [...verifyColumns] },
          'FTS index creation appeared to succeed but indexes not found in listIndices — search will use vector-only fallback',
        );
        captureFtsDegradedOnce(
          workspacePath,
          'verify',
          new Error(`FTS verify failed: missing columns ${missing.join(',')}`),
        );
        return false;
      }
    }

    logger.info('FTS indexes ready');
    return true;
  } catch (error) {
    logger.error({ err: error }, 'Failed to ensure FTS indexes — search will use vector-only fallback');
    captureFtsDegradedOnce(workspacePath, 'create', error);
    return false;
  }
}

/**
 * @internal — unit-test seam (Stage 1). Drives `ensureFTSIndexes` with a fake
 * table to exercise the Sentry-capture + latch paths without a real LanceDB
 * native handle. Production code calls the private `ensureFTSIndexes` directly.
 */
export function _ensureFTSIndexesForTesting(
  table: LanceDBTable,
  workspacePath: string,
): Promise<boolean> {
  return ensureFTSIndexes(table, workspacePath);
}

async function dropFileVectorsTableDuringInit(
  connection: LanceDBConnection,
  reason: 'no_chunks_table' | 'fresh_chunks_with_orphan_vectors',
  details: Record<string, unknown> = {}
): Promise<void> {
  try {
    await connection.dropTable(FILE_VECTORS_TABLE_NAME);
  } catch (err) {
    if (isLanceTableNotFoundError(err, FILE_VECTORS_TABLE_NAME)) {
      return;
    }
    throw err;
  }

  logger.info(
    { ...details, tableName: FILE_VECTORS_TABLE_NAME, reason },
    'file_vectors.orphan_init_drop'
  );
}

async function dropFileNeighborsTableDuringInit(
  connection: LanceDBConnection,
  reason:
    | 'no_chunks_table'
    | 'fresh_chunks_with_orphan_neighbors'
    | 'neighbor_only_orphan'
    | 'schema_incompatible',
  details: Record<string, unknown> = {}
): Promise<void> {
  try {
    await connection.dropTable(FILE_NEIGHBORS_TABLE_NAME);
  } catch (err) {
    if (isLanceTableNotFoundError(err, FILE_NEIGHBORS_TABLE_NAME)) {
      return;
    }
    throw err;
  }

  logger.info(
    { ...details, tableName: FILE_NEIGHBORS_TABLE_NAME, reason },
    'file_neighbors.orphan_init_drop'
  );
}

async function checkFileNeighborsSchemaCompatibility(table: LanceDBTable): Promise<boolean> {
  try {
    const schema = await table.schema();
    const fields = schema.fields as Array<{ name: string }>;
    const fieldNames = new Set(fields.map(field => field.name));
    const requiredFields = [
      'path',
      'relative_path',
      'neighbor_paths',
      'neighbor_scores',
      'neighbor_fingerprints',
      'source_vector_fingerprint',
      'k',
      'computed_at',
    ];
    const missingFields = requiredFields.filter(field => !fieldNames.has(field));
    if (missingFields.length > 0) {
      logger.info(
        { tableName: FILE_NEIGHBORS_TABLE_NAME, missingFields },
        'file_neighbors.schema_incompatible'
      );
      return false;
    }

    await table
      .query()
      .select(requiredFields)
      .limit(1)
      .toArray();

    return true;
  } catch (err) {
    logger.warn({ err, tableName: FILE_NEIGHBORS_TABLE_NAME }, 'file_neighbors.schema_check_failure');
    return false;
  }
}

/**
 * Initialize or get the index for a workspace
 */
export async function initializeIndex(workspacePath: string): Promise<void> {
  return withWriteLock(() => initializeIndexInternal(workspacePath));
}

/**
 * Internal: Actual initialization logic. Called from locked context.
 */
async function initializeIndexInternal(workspacePath: string): Promise<void> {
  if (getCurrentIndex()?.workspacePath === workspacePath) {
    return;
  }

  await closeIndexInternal();

  const storageDir = getIndexStorageDir(workspacePath);
  const lanceDBDir = getLanceDBDir(workspacePath);
  await fs.mkdir(lanceDBDir, { recursive: true });

  logger.info({ workspacePath, storageDir }, 'Initializing file index');

  // Load metadata (scan completion state)
  const metadata = await loadMetadata(workspacePath);

  // Check if embedding model changed - requires full reindex if so
  if (metadata.embeddingModel && metadata.embeddingModel !== CURRENT_EMBEDDING_MODEL) {
    logger.info(
      { oldModel: metadata.embeddingModel, newModel: CURRENT_EMBEDDING_MODEL },
      'Embedding model changed, clearing index for full reindex'
    );
    // Clear the LanceDB directory to force reindex with new model
    await fs.rm(lanceDBDir, { recursive: true, force: true });
    await fs.mkdir(lanceDBDir, { recursive: true });
    // Reset metadata
    metadata.scanCompletedAt = null;
    metadata.totalFilesAtCompletion = null;
    metadata.embeddingModel = CURRENT_EMBEDDING_MODEL;
    await saveMetadata(workspacePath, metadata);
  }

  // Use loadNativeModule helper to resolve from app.asar.unpacked/node_modules in packaged builds.
  const lancedb = loadNativeModule<typeof import('@lancedb/lancedb')>('@lancedb/lancedb');
  
  // Create separate connections for read and write operations to avoid contention
  // Write connection: used for indexing operations (no consistency interval needed)
  const connection = await lancedb.connect(lanceDBDir);
  // Read connection: used for semantic search with eventual consistency
  // This prevents search queries from being blocked by ongoing write operations
  const readConnection = await lancedb.connect(lanceDBDir, {
    readConsistencyInterval: 1 // Check for updates every 1 second (eventual consistency)
  });

  let table: LanceDBTable | null = null;
  let readTable: ReadTableHandle | null = null;
  let fileVectorsTable: LanceDBTable | null = null;
  let fileVectorsReadTable: ReadTableHandle | null = null;
  let fileNeighborsTable: LanceDBTable | null = null;
  let fileNeighborsReadTable: ReadTableHandle | null = null;
  const tableNames = await connection.tableNames();
  const chunksTableExistedAtInit = tableNames.includes(TABLE_NAME);
  let shouldOpenFileVectorsTable = tableNames.includes(FILE_VECTORS_TABLE_NAME);
  let shouldOpenFileNeighborsTable = tableNames.includes(FILE_NEIGHBORS_TABLE_NAME);

  if (shouldOpenFileVectorsTable && !chunksTableExistedAtInit) {
    await dropFileVectorsTableDuringInit(connection, 'no_chunks_table');
    shouldOpenFileVectorsTable = false;
  }
  if (shouldOpenFileNeighborsTable && !chunksTableExistedAtInit) {
    await dropFileNeighborsTableDuringInit(connection, 'no_chunks_table');
    shouldOpenFileNeighborsTable = false;
  }

  if (chunksTableExistedAtInit) {
    table = await connection.openTable(TABLE_NAME);
    // Also open on read connection for non-blocking searches
    readTable = new ReadTableHandle(await readConnection.openTable(TABLE_NAME));
    logger.info({ tableName: TABLE_NAME }, 'Opened existing index table (write + read connections)');
    
    // Check if schema is compatible with two-phase indexing (has is_enhanced column)
    // If not, drop table and let it rebuild with correct schema
    const isCompatible = await checkSchemaCompatibility(table, connection);
    if (!isCompatible) {
      logger.info('Dropping incompatible index table - will rebuild with new schema');
      // Retire the read handle before nulling: dropTable does not close the
      // SDK-side table handle, so without retire we'd leak the FD.
      const droppedReadHandle = readTable;
      readTable = null;
      if (droppedReadHandle) await droppedReadHandle.retire();
      try { table.close(); } catch (err) {
        logger.warn({ err }, 'Error closing incompatible LanceDB write table before drop');
      }
      await connection.dropTable(TABLE_NAME);
      table = null;
      if (shouldOpenFileVectorsTable) {
        try {
          await connection.dropTable(FILE_VECTORS_TABLE_NAME);
        } catch (dropError) {
          if (!isLanceTableNotFoundError(dropError, FILE_VECTORS_TABLE_NAME)) {
            throw dropError;
          }
        }
        shouldOpenFileVectorsTable = false;
        logger.info(
          { tableName: FILE_VECTORS_TABLE_NAME },
          'Dropped file vectors table after incompatible chunk schema rebuild'
        );
      }
      if (shouldOpenFileNeighborsTable) {
        try {
          await connection.dropTable(FILE_NEIGHBORS_TABLE_NAME);
        } catch (dropError) {
          if (!isLanceTableNotFoundError(dropError, FILE_NEIGHBORS_TABLE_NAME)) {
            throw dropError;
          }
        }
        shouldOpenFileNeighborsTable = false;
        logger.info(
          { tableName: FILE_NEIGHBORS_TABLE_NAME },
          'Dropped file neighbors table after incompatible chunk schema rebuild'
        );
      }
      // Reset metadata so file watcher knows to re-scan everything
      metadata.scanCompletedAt = null;
      metadata.totalFilesAtCompletion = null;
      await saveMetadata(workspacePath, metadata);
    } else {
      const compatibleTableNames = await connection.tableNames();
      shouldOpenFileVectorsTable = compatibleTableNames.includes(FILE_VECTORS_TABLE_NAME);
      shouldOpenFileNeighborsTable = compatibleTableNames.includes(FILE_NEIGHBORS_TABLE_NAME);
      // Schema is good - enable enhancement tracking and load counts
      updateEnhancementState({ schemaSupportsEnhancement: true });
      await refreshEnhancementCounts(table);
    }
  }

  if (table && (shouldOpenFileVectorsTable || shouldOpenFileNeighborsTable)) {
    const chunkRowCount = await table.countRows();
    if (chunkRowCount === 0) {
      if (shouldOpenFileVectorsTable) {
        await dropFileVectorsTableDuringInit(
          connection,
          'fresh_chunks_with_orphan_vectors',
          { chunkRowCount }
        );
        shouldOpenFileVectorsTable = false;
      }
      if (shouldOpenFileNeighborsTable) {
        await dropFileNeighborsTableDuringInit(
          connection,
          'fresh_chunks_with_orphan_neighbors',
          { chunkRowCount }
        );
        shouldOpenFileNeighborsTable = false;
      }
    }
  }

  if (!shouldOpenFileVectorsTable && shouldOpenFileNeighborsTable) {
    let neighborRowCount = 0;
    let shouldDropNeighborOnlyOrphan = false;
    try {
      const neighborTable = await connection.openTable(FILE_NEIGHBORS_TABLE_NAME);
      try {
        neighborRowCount = await neighborTable.countRows();
        shouldDropNeighborOnlyOrphan = neighborRowCount > 0;
      } finally {
        try { neighborTable.close(); } catch (closeErr) {
          logger.warn({ err: closeErr, tableName: FILE_NEIGHBORS_TABLE_NAME }, 'Failed to close neighbor-only orphan probe table');
        }
      }
    } catch (err) {
      logger.warn({ err, tableName: FILE_NEIGHBORS_TABLE_NAME }, 'file_neighbors.neighbor_only_orphan_probe_failure');
      shouldDropNeighborOnlyOrphan = true;
    }

    if (shouldDropNeighborOnlyOrphan) {
      await dropFileNeighborsTableDuringInit(
        connection,
        'neighbor_only_orphan',
        { neighborRowCount }
      );
      shouldOpenFileNeighborsTable = false;
    }
  }

  if (shouldOpenFileVectorsTable) {
    try {
      fileVectorsTable = await connection.openTable(FILE_VECTORS_TABLE_NAME);
      fileVectorsReadTable = new ReadTableHandle(await readConnection.openTable(FILE_VECTORS_TABLE_NAME));
      logger.info({ tableName: FILE_VECTORS_TABLE_NAME }, 'Opened existing file vectors table (write + read connections)');
    } catch (err) {
      shouldOpenFileVectorsTable = false;
      try { fileVectorsTable?.close(); } catch (closeErr) {
        logger.warn({ err: closeErr, tableName: FILE_VECTORS_TABLE_NAME }, 'Failed to close stale file vectors table handle');
      }
      fileVectorsTable = null;
      fileVectorsReadTable = null;
      logger.warn(
        { err, tableName: FILE_VECTORS_TABLE_NAME },
        'Failed to open existing file vectors table; will recreate lazily'
      );
    }
  }

  if (shouldOpenFileNeighborsTable) {
    try {
      fileNeighborsTable = await connection.openTable(FILE_NEIGHBORS_TABLE_NAME);
      const isCompatible = await checkFileNeighborsSchemaCompatibility(fileNeighborsTable);
      if (!isCompatible) {
        try { fileNeighborsTable.close(); } catch (closeErr) {
          logger.warn({ err: closeErr, tableName: FILE_NEIGHBORS_TABLE_NAME }, 'Failed to close incompatible file neighbors table handle');
        }
        fileNeighborsTable = null;
        await dropFileNeighborsTableDuringInit(
          connection,
          'schema_incompatible',
          { tableName: FILE_NEIGHBORS_TABLE_NAME }
        );
        shouldOpenFileNeighborsTable = false;
      } else {
        await fileNeighborsTable.delete(eq('path', FILE_NEIGHBORS_SCHEMA_SEED_PATH));
        fileNeighborsReadTable = new ReadTableHandle(await readConnection.openTable(FILE_NEIGHBORS_TABLE_NAME));
        logger.info({ tableName: FILE_NEIGHBORS_TABLE_NAME }, 'Opened existing file neighbors table (write + read connections)');
      }
    } catch (err) {
      shouldOpenFileNeighborsTable = false;
      try { fileNeighborsTable?.close(); } catch (closeErr) {
        logger.warn({ err: closeErr, tableName: FILE_NEIGHBORS_TABLE_NAME }, 'Failed to close stale file neighbors table handle');
      }
      fileNeighborsTable = null;
      fileNeighborsReadTable = null;
      logger.warn(
        { err, tableName: FILE_NEIGHBORS_TABLE_NAME },
        'Failed to open existing file neighbors table; will recreate lazily'
      );
    }
  }

  // Determine initial FTS status: create indexes if table exists with compatible schema
  let ftsStatus: WorkspaceIndex['ftsStatus'] = 'unavailable';
  if (table) {
    const ftsOk = await ensureFTSIndexes(table, workspacePath);
    ftsStatus = ftsOk ? 'ready' : 'failed';
    // Reopen readTable so the read connection can see the newly created FTS indexes
    if (ftsOk && readConnection) {
      // Swap-and-retire: reopen the table on the read connection, install the
      // new ref-counted handle, and retire the prior handle. Without this we
      // were leaking one read-table handle per init that hit the FTS branch.
      try {
        const oldReadHandle = readTable;
        const newReadTable = await readConnection.openTable(TABLE_NAME);
        readTable = new ReadTableHandle(newReadTable);
        if (oldReadHandle) await oldReadHandle.retire();
      } catch (err) {
        // Non-fatal: search will fall back to the write table or the previous
        // read handle. Log per silent-failure rule so the degraded path is
        // observable in production.
        logger.warn({ err }, 'Failed to reopen read table after FTS index creation');
      }
    }
  }

  // Build the index, then install it as the singleton. Hydration below mutates
  // this same object — behavior-identical to the pre-C2 in-place
  // `currentIndex.field` mutations (init runs under the write lock, so no
  // concurrent setCurrentIndex can land mid-init).
  const newIndex: WorkspaceIndex = {
    connection,
    table,
    fileVectorsTable,
    fileNeighborsTable,
    readConnection,
    readTable,
    fileVectorsReadTable,
    fileNeighborsReadTable,
    workspacePath,
    // Build the workspace's symlink registry ONCE here (bounded depth-4 scan).
    // Hot-path path conversions reuse this cached map instead of rebuilding it
    // per file — the core Stage 2 idle-CPU win for symlink-backed files.
    symlinkMap: buildSymlinkMap(workspacePath),
    indexedMtimes: new Map(), // Will be populated below
    lastIndexedAt: null,
    metadata,
    indexedFilesCount: 0,
    ftsStatus
  };
  setCurrentIndex(newIndex);

  // Real index is now open — clear the pre-loaded metadata cache
  // so getIndexStatus() uses currentIndex directly.
  setCachedMetadataForStatus(null);

  // Eager hydration: load all path+mtime pairs into memory for fast needsReindexing() checks
  // This is a single query that enables O(1) mtime lookups instead of per-file DB queries
  if (table) {
    try {
      const startTime = Date.now();

      // Query all path+mtime pairs (includes duplicates for chunked files)
      const results = await table
        .query()
        .select(['path', 'mtime'])
        .toArray();

      // Build map, keeping max mtime per path (in case of multiple chunks)
      // The Map automatically deduplicates by path key, so size = unique file count
      for (const row of results) {
        const record = row as { path: string; mtime: number };
        const existing = newIndex.indexedMtimes.get(record.path);
        if (existing === undefined || record.mtime > existing) {
          newIndex.indexedMtimes.set(record.path, record.mtime);
        }
      }

      // indexedFilesCount = unique files (Map size), NOT chunks (results.length)
      newIndex.indexedFilesCount = newIndex.indexedMtimes.size;
      const elapsed = Date.now() - startTime;

      logger.info(
        {
          indexedFiles: newIndex.indexedFilesCount,
          totalChunks: results.length,
          hydrateMs: elapsed
        },
        'Index hydrated with mtime cache'
      );

      // Sanity checks for data integrity
      if (newIndex.indexedFilesCount > results.length) {
        // Each file produces at least 1 chunk, so files should never exceed chunks
        logger.warn(
          { indexedFiles: newIndex.indexedFilesCount, totalChunks: results.length },
          'Index sanity check failed: file count exceeds chunk count'
        );
      } else if (results.length > 100 && newIndex.indexedFilesCount === results.length) {
        // If file count equals chunk count for a large index, Map deduplication likely failed
        // This could happen if path values aren't proper strings
        logger.warn(
          { indexedFiles: newIndex.indexedFilesCount, totalChunks: results.length },
          'Index sanity check warning: file count equals chunk count - possible deduplication failure'
        );
      }

      if (newIndex.indexedFilesCount > 0) {
        // Get just the latest indexedAt timestamp (single row query)
        const latest = await table
          .query()
          .select(['indexedAt'])
          .limit(1)
          .toArray();

        if (latest.length > 0) {
          newIndex.lastIndexedAt = (latest[0] as { indexedAt: number }).indexedAt;
        }
      }
      
      // Trigger version cleanup on startup (fire and forget)
      // This cleans up any accumulated version bloat from previous sessions.
      // Silent-failure rule: log rejections rather than swallow them (was
      // a pre-existing `.catch(() => {})` flagged in Phase 1 review).
      optimizeIndex().catch(err => logger.warn({ err }, 'optimizeIndex background failure'));
    } catch (err) {
      logger.warn({ err }, 'Failed to hydrate index state from table');
    }
  }
}

/**
 * Close the current index
 * 
 * IMPORTANT: Uses write lock to ensure all pending writes complete before closing.
 * This prevents index corruption from closing during active mutations.
 */
export async function closeIndex(): Promise<void> {
  return withWriteLock(() => closeIndexInternal());
}

/**
 * Internal: Actual close logic. Called from locked context.
 * 
 * IMPORTANT: This function waits for any in-progress optimization to complete
 * before closing connections to prevent index corruption. If shutdown happens
 * during optimize(), the version manifest can become inconsistent.
 */
async function closeIndexInternal(): Promise<void> {
  const index = getCurrentIndex();
  if (index) {
    abortFileNeighborsLazyFill(index.workspacePath, 'index_close');
    // FU-4b: stop the decoupled NaN-repair sweep timer for this workspace so no
    // tick fires against a torn-down index.
    cancelNanRepairSweep(index.workspacePath);
    // Wait for any in-flight optimization to complete (with timeout)
    // This prevents corruption from closing during optimize() writes
    if (isOptimizing()) {
      const maxWait = 3000; // 3 seconds max
      const start = Date.now();
      logger.info('Waiting for index optimization to complete before closing...');
      while (isOptimizing() && Date.now() - start < maxWait) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (isOptimizing()) {
        logger.warn('Closing index while optimization still in progress (timed out after 3s)');
      }
    }
    
    // Close tables first, then connections
    // Tables hold references that block deletion on Windows (matches indexHealthService.ts pattern)
    // Note: table.close() is synchronous in LanceDB but we wrap in try/catch for safety
    try { index.table?.close(); } catch (err) {
      logger.warn({ err }, 'Error closing LanceDB write table');
    }
    try { index.fileVectorsTable?.close(); } catch (err) {
      logger.warn({ err }, 'Error closing LanceDB file vectors write table');
    }
    try { index.fileNeighborsTable?.close(); } catch (err) {
      logger.warn({ err }, 'Error closing LanceDB file neighbors write table');
    }
    // Detach the read handle BEFORE awaiting close so any new
    // `semanticSearch` / `getFileEmbeddings` started during the drain wait
    // can't acquire a doomed handle (they'll fall through the
    // `currentIndex?.readTable ?? null` null-check). Then retire +
    // waitForDrain so in-flight readers finish before the read connection
    // closes underneath them — without this drain, a long-running search
    // can race the connection close and see "table closed" mid-read.
    const readHandleAtClose = index.readTable;
    index.readTable = null;
    if (readHandleAtClose) {
      try {
        await readHandleAtClose.retire();
        const drainResult = await readHandleAtClose.waitForDrain(SHUTDOWN_DRAIN_TIMEOUT_MS);
        if (!drainResult.drained) {
          logger.warn(
            { remainingRefs: drainResult.remainingRefs, timeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS },
            'readTable drain timeout at shutdown — closing read connection with in-flight readers'
          );
        }
      } catch (err) {
        logger.warn({ err }, 'Error retiring LanceDB read table handle');
      }
    }
    const fileVectorsReadHandleAtClose = index.fileVectorsReadTable;
    index.fileVectorsReadTable = null;
    if (fileVectorsReadHandleAtClose) {
      try {
        await fileVectorsReadHandleAtClose.retire();
        const drainResult = await fileVectorsReadHandleAtClose.waitForDrain(SHUTDOWN_DRAIN_TIMEOUT_MS);
        if (!drainResult.drained) {
          logger.warn(
            { remainingRefs: drainResult.remainingRefs, timeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS },
            'fileVectorsReadTable drain timeout at shutdown — closing read connection with in-flight readers'
          );
        }
      } catch (err) {
        logger.warn({ err }, 'Error retiring LanceDB file vectors read table handle');
      }
    }
    const fileNeighborsReadHandleAtClose = index.fileNeighborsReadTable;
    index.fileNeighborsReadTable = null;
    if (fileNeighborsReadHandleAtClose) {
      try {
        await fileNeighborsReadHandleAtClose.retire();
        const drainResult = await fileNeighborsReadHandleAtClose.waitForDrain(SHUTDOWN_DRAIN_TIMEOUT_MS);
        if (!drainResult.drained) {
          logger.warn(
            { remainingRefs: drainResult.remainingRefs, timeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS },
            'fileNeighborsReadTable drain timeout at shutdown — closing read connection with in-flight readers'
          );
        }
      } catch (err) {
        logger.warn({ err }, 'Error retiring LanceDB file neighbors read table handle');
      }
    }

    // Now close connections
    try {
      index.connection.close();
    } catch (err) {
      logger.warn({ err }, 'Error closing LanceDB write connection');
    }
    try {
      index.readConnection.close();
    } catch (err) {
      logger.warn({ err }, 'Error closing LanceDB read connection');
    }
    // Clean up the per-workspace single-flight / checkpoint entries owned by
    // ./state (Stage C2). The maps themselves now have their primary consumer in
    // ./vectorsDerive (Stage D1); close still clears the entries for the
    // workspace it is tearing down, reached through the state getters.
    getLastLazyFillCheckpoint().delete(index.workspacePath);
    getDeterministicFileVectorFailures().delete(index.workspacePath);
    getNanRepairAttempts().delete(index.workspacePath);
    getNanRepairPending().delete(index.workspacePath);
    getNanRepairFailures().delete(index.workspacePath);
    getFileNeighborsLazyFillPromises().delete(index.workspacePath);
    setCurrentIndex(null);
    logger.info('File index closed');
  }
}

// Defense-in-depth: ensure file index is closed on app quit
// This supplements the gracefulShutdown.ts path which closes via stopFileWatching()
// Desktop-only: cloud uses explicit shutdown calls.
onElectronAppEvent('will-quit', () => {
  // Fire and forget - don't block quit event
  // Note: closeIndex() handles the case where currentIndex is already null
  closeIndex().catch(err => {
    logger.warn({ err }, 'Error closing file index on will-quit');
  });
});

/**
 * Stage 7 (F2) — error thrown when a bounded cloud-file fs op times out in the
 * index-read path. A distinct class so callers can DISTINGUISH a dead-mount
 * timeout (defer the file — keep the last-known index entry, never block the
 * indexer / park libuv) from a genuine read error.
 */
class CloudIndexReadTimeoutError extends Error {
  constructor(op: string) {
    super(`cloud index-read op '${op}' timed out`);
    this.name = 'CloudIndexReadTimeoutError';
  }
}

/**
 * Stage 7 (F2) — index-read disposition for a file path (FS-FREE: flag check +
 * containment + the synchronous cached verdict; no `realpath`/`stat`):
 *  - `'local'`       — not an admitted cloud file (flag off OR not under a cloud
 *    space) → bare reads, byte-identical to today.
 *  - `'bound-cloud'` — admitted cloud file whose space is currently HEALTHY → issue
 *    the reads but cloud-budget-bound them (a mount dying mid-read degrades/defers,
 *    never blocks).
 *  - `'defer-cloud'` — cloud file whose space is NON-healthy (degraded/unknown) →
 *    DEFER WITHOUT issuing any fs op. This is the steady-state cap on the
 *    libuv-park amplification (GPT review should-3): once a mount degrades, a
 *    100-wide batch of `needsReindexing` for that space short-circuits to defer
 *    instead of abandoning 100 bounded-but-still-parked syscalls. A healthy space
 *    that dies mid-batch still issues the bounded reads for the in-flight wave (each
 *    bounded), then degrades → subsequent waves defer.
 *
 * With the flag OFF (default) this FS-FREE disposition is ALWAYS `'local'`, so it never
 * DEFERS — byte-identical gating to today. (S4.1c note: the subsequent read now goes
 * through `boundedWorkspaceFs`, whose CONTAINMENT classifier is configured independently
 * of the admission flag — so a CONFIGURED-cloud path would still take the bounded cloud
 * lane even with the flag off. That path is unreachable upstream with the flag off
 * (`discoverFiles`/the chokidar matcher exclude cloud), so this is a belt-and-braces
 * fail-safe, not a behaviour change in practice.) The flag re-check is belt-and-braces
 * over that upstream guarantee.
 */
function cloudIndexReadDisposition(filePath: string): 'local' | 'bound-cloud' | 'defer-cloud' {
  if (!isCloudSymlinkIndexingEnabled()) return 'local';
  const classification = classifyPathForRemoval(filePath);
  if (classification === 'local') return 'local';
  return classification.verdict === 'healthy' ? 'bound-cloud' : 'defer-cloud';
}

/**
 * S4.1c — unwrap a bounded-boundary index read. The Stage-7 bespoke timer
 * (`runCloudBoundedIndexRead` + `getTimeoutForPath`/`runWithTimeout`) is RETIRED: the
 * boundary now owns the per-op kill/reclaim for a cloud path (killable child pool),
 * and the FS-FREE `cloudIndexReadDisposition` pre-gate still caps batch amplification
 * by deferring whole files in a NON-healthy space before any op is issued.
 *
 *  - `ok`           → the value.
 *  - `reconnecting` → a dead/unreachable cloud mount was reclaimed → throw
 *    {@link CloudIndexReadTimeoutError} so the existing call-site logic DEFERS the
 *    file (keeps the last-known index entry), byte-identical to the old timeout path.
 *  - `error`        → a real fs error (ENOENT/…) → rethrow it RAW so the existing
 *    `err.code`/fallback handling at the call site is unchanged.
 */
function unwrapIndexRead<T>(outcome: WorkspaceFsOutcome<T>, op: string): T {
  if (outcome.status === 'ok') return outcome.value;
  if (outcome.status === 'reconnecting') throw new CloudIndexReadTimeoutError(op);
  throw outcome.error;
}

/**
 * Index a single file
 */
export async function indexFile(filePath: string, workspacePath: string): Promise<number> {
  // Skip during ENFILE cooldown to prevent error storms
  if (isEnfileActive()) {
    return 0;
  }
  return withWriteLock(() => indexFileInternal(filePath, workspacePath));
}

/**
 * Resolve the STABLE expected embedding dimension for the embed-time NaN guard
 * (MA2). The source of truth is the live embedding generator's declared
 * `embeddingDimension` (the per-model constant — 384 for BGE-small — exported
 * from `@core/embeddingGenerator`). This is deliberately NOT derived from the
 * shape of the current batch: a buggy short/long vector must never be able to
 * redefine what "correct" means (which would let it pass as the expected
 * dimension on a 1-chunk file, or win a 2-chunk dimension tie and drop the
 * genuine vector).
 *
 * Falls back to the existing `file_embeddings` table's vector field dimension
 * when the generator omits it (e.g. a test double), and finally to 0 — which
 * disables only the dimension check (finiteness + non-zero-norm still apply),
 * never weakening the guard. `existingTable` is the live write table when one
 * already exists (its schema pins the canonical dimension for this workspace).
 */
function resolveExpectedEmbeddingDimension(existingTable: LanceDBTable | null): number {
  const declared = getEmbeddingGenerator().embeddingDimension;
  if (typeof declared === 'number' && declared > 0) {
    return declared;
  }
  const schemaDim = readVectorDimensionFromTableSchema(existingTable);
  return schemaDim > 0 ? schemaDim : 0;
}

/**
 * Best-effort read of the `vector` column's fixed-size-list length from a cached
 * LanceDB table schema. Returns 0 when the dimension cannot be determined (no
 * table, no vector field, or non-fixed-size type). Synchronous: uses the schema
 * already materialised on the open table handle; never issues IO.
 */
function readVectorDimensionFromTableSchema(table: LanceDBTable | null): number {
  if (!table) {
    return 0;
  }
  try {
    const maybeSchema = (table as unknown as { schema?: unknown }).schema;
    const fields = (maybeSchema as { fields?: Array<{ name?: string; type?: { listSize?: number } }> } | undefined)
      ?.fields;
    if (!Array.isArray(fields)) {
      return 0;
    }
    const vectorField = fields.find((f) => f?.name === 'vector');
    const listSize = vectorField?.type?.listSize;
    return typeof listSize === 'number' && listSize > 0 ? listSize : 0;
  } catch {
    return 0;
  }
}

/**
 * FU-4b/MA2 — optional structured outcome the repair path needs to distinguish a
 * post-purge re-add failure (recoverable, must retry) from "all chunks invalid /
 * dropped" (legitimate convergence). `indexFileInternal` returns a bare chunk
 * count (0 is ambiguous); this recorder makes the phase explicit when the caller
 * passes it. `phase`:
 *  - `created`             — created a fresh table (first file in workspace).
 *  - `added`               — purged old rows then durably added the new ones.
 *  - `all_invalid_dropped` — every re-embedded chunk was dropped by the guard;
 *                            old rows removed, nothing written (legit no-op).
 *  - `not_indexable`       — source not indexable (gone / too big / empty / filtered);
 *                            no purge performed.
 *  - `failed_before_purge` — threw before deleting old rows (rows intact).
 *  - `failed_after_purge`  — threw AFTER deleting old rows (rows lost; recoverable).
 */
export type IndexFileOutcome = {
  phase:
    | 'created'
    | 'added'
    | 'all_invalid_dropped'
    | 'not_indexable'
    | 'failed_before_purge'
    | 'failed_after_purge';
};

/**
 * Internal: Actual indexing logic. Called from locked context.
 *
 * @param outcome optional recorder (FU-4b/MA2): when supplied, its `phase` is set
 *   to the precise terminal state so a caller (the repair sweep) can tell a
 *   recoverable post-purge add-failure from a legitimate all-dropped no-op.
 */
async function indexFileInternal(
  filePath: string,
  workspacePath: string,
  outcome?: IndexFileOutcome
): Promise<number> {
  // Default phase: a not-indexable early-return path. Overwritten as we progress.
  if (outcome) {
    outcome.phase = 'not_indexable';
  }
  if (getCurrentIndex()?.workspacePath !== workspacePath) {
    await initializeIndexInternal(workspacePath);
  }

  // The index is stable for the rest of this locked routine (initialize already
  // ran above if needed, and no further setCurrentIndex can land while we hold
  // the write lock). Capture it once so field reads/writes narrow correctly —
  // behavior-identical to the pre-C2 in-place `currentIndex.field` mutations.
  const index = getCurrentIndex();
  if (!index) {
    throw new Error('Failed to initialize index');
  }

  if (!shouldIndexFile(filePath)) {
    return 0;
  }

  // FU-4b/MA2: tracks whether we have already deleted the file's prior chunk rows
  // (the destructive step). A throw AFTER this point left the file chunk-less and
  // the caller must treat it as recoverable, not as a converged no-op.
  let purgedPriorRows = false;

  // Stage 7 (F2): an admitted cloud file's realpath/stat/readFile below dereference
  // the FUSE mount. If the mount died after admission, bound them so a dead mount
  // DEFERS the file (keep last-known index entry) instead of blocking the indexer
  // queue + parking libuv. Decided FS-FREE (flag + containment + cached verdict).
  const cloudReadDisposition = cloudIndexReadDisposition(filePath);
  if (cloudReadDisposition === 'defer-cloud') {
    // The space is non-healthy → DEFER without issuing any fs op (caps the
    // libuv-park amplification on a batch of admitted-then-dead files). Keep the
    // last-known index entry; re-indexed on a later pass once the mount recovers.
    if (outcome) outcome.phase = 'not_indexable';
    logger.debug(
      { filePath },
      'File index: deferring an admitted cloud file in a non-healthy space (no fs op); keeping last-known index entry',
    );
    return 0;
  }
  // ('bound-cloud' vs 'local' no longer branches the reads — the boundary classifies
  // and bounds each op itself; the disposition above only gates the FS-FREE defer.)

  try {
    // Normalize path to canonical form (resolves symlinks and fixes case on case-insensitive filesystems)
    // This prevents duplicates when folders are renamed with different casing (e.g., Personal -> personal)
    let canonicalPath: string;
    try {
      canonicalPath = unwrapIndexRead(
        await workspaceFs.realpath(filePath),
        'realpath',
      );
    } catch (err) {
      if (err instanceof CloudIndexReadTimeoutError) throw err; // dead mount → defer (outer catch)
      // If realpath fails (non-timeout), fall back to original path
      canonicalPath = filePath;
    }

    const stat = unwrapIndexRead(
      await workspaceFs.stat(canonicalPath),
      'stat',
    );

    if (!stat.isFile || stat.size > MAX_FILE_SIZE || stat.size === 0) {
      return 0;
    }

    const content = unwrapIndexRead(
      await workspaceFs.readFile(canonicalPath, 'utf-8'),
      'readFile',
    );
    // Compute relativePath through symlinks for proper display
    // tryConvertToWorkspacePath handles symlinked spaces (e.g., Google Drive)
    const relativePath = toPortablePath(tryConvertToWorkspacePath(canonicalPath, workspacePath, index.symlinkMap)
      ?? path.relative(workspacePath, canonicalPath));
    const extension = path.extname(canonicalPath).toLowerCase();

    // Hook: Index source metadata if this is a source file (memory/sources/**/*.md)
    // Runs in parallel with embedding indexing - no await needed
    if (sourceMetadataStore.isSourcePath(canonicalPath, workspacePath)) {
      sourceMetadataStore.indexSource(canonicalPath, relativePath, content, Math.floor(stat.mtimeMs));
    }

    // Hook: Index entity metadata if this file has entity_type frontmatter
    if (entityMetadataStore.isEntityFile(content)) {
      entityMetadataStore.indexEntity(canonicalPath, relativePath, content, Math.floor(stat.mtimeMs));
    } else {
      // Remove stale entry if file was previously an entity but frontmatter was removed.
      // Removal Coordinator (Stage 4a): this is a `replacement`-class removal — it
      // runs INSIDE the re-index flow (indexFileInternal, under the write lock) and
      // touches only the entity store. Like the LanceDB `replacement` deletes below,
      // it is NOT routed through the main-side coordinator (re-entrancy/layering) and
      // is exempt from the only-door gate; `replacement` is never health-gated.
      entityMetadataStore.removeEntity(canonicalPath);
    }

    const chunks = chunkText(content);

    // Enrich chunks with metadata (title + description + path + tags) for better semantic search
    const { title, description, tags } = extractDocumentFrontmatter(content);
    const enrichedTexts = chunks.map((c) => buildEmbeddingText(title, relativePath, c, description, tags));

    const records: FileEmbeddingRecord[] = [];

    // Two-phase indexing: basic embedding with metadata enrichment
    // Enhancement service may later add LLM context prefixes in the background
    // Batch embedding generation for performance (GPU/CPU both support batching)
    // Uses enriched texts (with title/path prefix) for embeddings, but stores raw chunks in content
    const embeddingStartMs = Date.now();
    const embeddings = await getEmbeddingGenerator().generateEmbeddings(enrichedTexts);
    const embeddingMs = Date.now() - embeddingStartMs;

    const filenameStem = path.basename(canonicalPath, path.extname(canonicalPath));
    // Embed-time NaN guard (Layer 1, Stage 4): the GPU/WebGPU backend can emit
    // an all-NaN vector for a chunk under a transient fp/driver glitch. Such a
    // vector must NEVER reach file_embeddings: a single NaN chunk poisons the
    // whole-file average and marks the entire file invalid_vectors (the idle-CPU
    // retry-forever loop this plan fixes). We validate each chunk vector and DROP
    // (do not write) any that is non-finite / wrong-dimension / zero-norm, with a
    // single counted warning. Dropping (vs. a CPU re-embed retry) is the chosen
    // disposition: the source content is intact, so a later file change or
    // re-index re-derives cleanly, and a dropped chunk only slightly reduces that
    // file's coverage — far cheaper than the per-chunk retry plumbing, and the
    // file stays usable via its remaining valid chunks (Layer 2 averaging).
    // The expected dimension MUST come from a STABLE per-model source, never
    // from the shape of this batch (MA2). Inferring it from the batch is wrong
    // for 1-chunk files (a buggy len-2 vector would become its own "expected")
    // and 2-chunk ties (insertion order could pick the wrong length and drop the
    // valid 384-dim vector). The live generator declares its dimension
    // (`@core/embeddingGenerator` is electron-free, so this is safe in the unit
    // harness, which mocks that module). Fall back to the existing
    // file_embeddings table's vector dimension if the generator omits it; if
    // neither is known, pass 0 to skip the dimension check (finiteness +
    // non-zero-norm still apply).
    const expectedDimension = resolveExpectedEmbeddingDimension(index.table);
    let droppedInvalidChunks = 0;
    for (let i = 0; i < chunks.length; i++) {
      const vector = Array.from(embeddings[i]);
      const invalidReason = getInvalidVectorReason(vector, expectedDimension);
      if (invalidReason) {
        droppedInvalidChunks++;
        logger.warn(
          { path: canonicalPath, chunkIndex: i, totalChunks: chunks.length, reason: invalidReason },
          'embedding.invalid_chunk_vector'
        );
        continue;
      }
      records.push({
        id: generateChunkId(canonicalPath, i),
        path: canonicalPath,
        relativePath,
        content: chunks[i],
        extension,
        mtime: Math.floor(stat.mtimeMs),  // mtimeMs can have decimals
        size: stat.size,
        chunkIndex: i,
        totalChunks: chunks.length,
        indexedAt: Date.now(),
        vector,
        filename_stem: filenameStem,
        is_enhanced: 0,  // 0 = not enhanced, 1 = enhanced (using integer to avoid LanceDB boolean query issues)
        enhanced_at: 0   // 0 = not yet enhanced, will be set to timestamp when enhanced
      });
    }

    if (droppedInvalidChunks > 0) {
      logger.warn(
        { path: canonicalPath, droppedInvalidChunks, totalChunks: chunks.length, writtenChunks: records.length },
        'embedding.dropped_invalid_chunks'
      );
    }

    // Every chunk vector was invalid (e.g. a backend producing all-NaN output):
    // there is nothing usable to index. Bail before touching the tables so we do
    // not create an empty/partial row set. Treat as a no-op index (same as a file
    // that produced no indexable content) — the file simply has no embeddings yet.
    if (records.length === 0) {
      logger.warn(
        { path: canonicalPath, totalChunks: chunks.length },
        'embedding.all_chunk_vectors_invalid'
      );
      // Remove any prior (now-stale) rows so we don't leave poisoned data behind.
      // This is a LEGITIMATE no-op convergence (the backend produced nothing
      // usable), distinct from a post-purge add FAILURE — record it as such so the
      // repair sweep treats it as converged, not as a recoverable loss (MA2).
      // Removal Coordinator (Stage 4a): `replacement`-class delete — internal,
      // under the write lock, NOT routed through the coordinator (re-entrancy);
      // never health-gated. Only-door gate exempts this in-flow internal site.
      purgedPriorRows = true;
      await removeFileFromIndexInternal(canonicalPath, { skipReadRefresh: true });
      if (outcome) {
        outcome.phase = 'all_invalid_dropped';
      }
      return 0;
    }

    // Pass records directly to LanceDB - it will infer types correctly for numbers and strings
    // Using snake_case column names + integers avoids LanceDB boolean literal parsing issues
    const writeStartMs = Date.now();
    if (!index.table) {
      index.table = await index.connection.createTable(TABLE_NAME, records);
      // Also open on read connection for non-blocking searches.
      // Swap-and-retire: any pre-existing read handle (defensive — should be
      // null in this branch since `!index.table` implies coherent
      // null state, but cheap to enforce) is retired before assignment.
      {
        const oldReadHandle = index.readTable;
        const newReadTable = await index.readConnection.openTable(TABLE_NAME);
        index.readTable = new ReadTableHandle(newReadTable);
        if (oldReadHandle) await oldReadHandle.retire();
      }
      // New table has correct schema - enable enhancement tracking
      updateEnhancementState({ schemaSupportsEnhancement: true });
      // Fresh-workspace bootstrap: create FTS indexes on the new table
      const ftsOk = await ensureFTSIndexes(index.table, index.workspacePath);
      index.ftsStatus = ftsOk ? 'ready' : 'failed';
      // Reopen readTable so the read connection can see FTS indexes.
      // Swap-and-retire: prior leak site (line ~1366) — without retire, the
      // pre-FTS read handle from above was discarded, leaking one FD per
      // fresh-workspace bootstrap.
      if (ftsOk && index.readConnection) {
        try {
          const oldReadHandle = index.readTable;
          const newReadTable = await index.readConnection.openTable(TABLE_NAME);
          index.readTable = new ReadTableHandle(newReadTable);
          if (oldReadHandle) await oldReadHandle.retire();
        } catch (err) {
          // Non-fatal: search will fall back to the write table or prior
          // handle. Log per silent-failure rule so degraded path is visible.
          logger.warn({ err }, 'Failed to reopen read table after FTS index creation (createTable path)');
        }
      }
      logger.info({ tableName: TABLE_NAME, recordCount: records.length }, 'Created index table (write + read connections)');
      if (outcome) {
        outcome.phase = 'created';
      }
    } else {
      // MA2: the DESTRUCTIVE step. Mark purged BEFORE awaiting the delete so that
      // a throw anywhere between here and the durable `add` below is classified
      // `failed_after_purge` (recoverable) by the catch — never silently lost.
      // Removal Coordinator (Stage 4a): `replacement`-class prior-row delete —
      // internal, under the write lock, NOT routed through the coordinator
      // (re-entrancy/deadlock); never health-gated. Only-door gate exempts it.
      purgedPriorRows = true;
      await removeFileFromIndexInternal(canonicalPath, {
        skipFileVectorDelete: true,
        skipReadRefresh: true,
      });
      await index.table.add(records);
      if (outcome) {
        outcome.phase = 'added';
      }
    }
    await recomputeFileVectorRow(canonicalPath, records);
    const writeMs = Date.now() - writeStartMs;

    // Update caches
    if (!index.indexedMtimes.has(canonicalPath)) {
      index.indexedFilesCount++; // New file added
    }
    index.indexedMtimes.set(canonicalPath, stat.mtimeMs);
    index.lastIndexedAt = Date.now();
    markChunksTableMutated();

    logger.debug({ filePath: relativePath, chunks: chunks.length, embeddingMs, writeMs }, 'Indexed file');

    // Trigger version cleanup if enough writes have accumulated
    maybeOptimize();

    return chunks.length;
  } catch (error) {
    // MA2: classify the failure by whether the destructive purge already ran. A
    // throw after the purge (transient IO / FD pressure on the re-add) left the
    // file chunk-less and RECOVERABLE; the repair sweep must retry it, never
    // present it as convergence. A throw before the purge left the rows intact.
    if (outcome) {
      outcome.phase = purgedPriorRows ? 'failed_after_purge' : 'failed_before_purge';
    }
    if (isTooManyOpenFilesError(error)) {
      const { isFirstDetection } = markEnfileDetected(error);
      if (isFirstDetection) {
        logger.error('ENFILE: System file descriptor exhaustion detected - file index operations paused for 60s');
      }
      return 0;
    }
    if (error instanceof CloudIndexReadTimeoutError) {
      // Stage 7 (F2): the cloud mount died mid-index-read. DEFER this file — the
      // timeout fired BEFORE any destructive purge (realpath/stat/readFile), so the
      // last-known index entry is intact (`failed_before_purge`). Observable, never
      // silent; the file is re-indexed on a later pass once the mount recovers (the
      // onRecovery rebuild re-runs discovery).
      logger.info(
        { filePath },
        'File index: deferring an admitted cloud file (mount unresponsive within budget); keeping last-known index entry',
      );
      return 0;
    }
    logger.warn({ err: error, filePath }, 'Failed to index file');
    return 0;
  }
}

/**
 * Refresh the read table to see recent writes.
 * Call this after batch deletions to make changes visible to searches/Atlas.
 *
 * Swap-and-retire: the previous read handle is retired (and closed once any
 * in-flight readers release), preventing the FD leak that motivated the
 * `ReadTableHandle` introduction.
 */
export async function refreshReadTable(): Promise<void> {
  const index = getCurrentIndex();
  if (!index?.readConnection) {
    return;
  }

  try {
    const oldReadHandle = index.readTable;
    const oldFileVectorsReadHandle = index.fileVectorsReadTable;
    const oldFileNeighborsReadHandle = index.fileNeighborsReadTable;
    const newReadTable = index.table
      ? new ReadTableHandle(await index.readConnection.openTable(TABLE_NAME))
      : null;
    const tableNames = index.fileVectorsTable || index.fileNeighborsTable
      ? await index.connection.tableNames()
      : [];
    const newFileVectorsReadTable = index.fileVectorsTable && tableNames.includes(FILE_VECTORS_TABLE_NAME)
      ? new ReadTableHandle(await index.readConnection.openTable(FILE_VECTORS_TABLE_NAME))
      : null;
    const newFileNeighborsReadTable = index.fileNeighborsTable && tableNames.includes(FILE_NEIGHBORS_TABLE_NAME)
      ? new ReadTableHandle(await index.readConnection.openTable(FILE_NEIGHBORS_TABLE_NAME))
      : null;
    index.readTable = newReadTable;
    index.fileVectorsReadTable = newFileVectorsReadTable;
    index.fileNeighborsReadTable = newFileNeighborsReadTable;
    if (oldReadHandle) await oldReadHandle.retire();
    if (oldFileVectorsReadHandle) await oldFileVectorsReadHandle.retire();
    if (oldFileNeighborsReadHandle) await oldFileNeighborsReadHandle.retire();
    logger.debug('Refreshed read table');
  } catch (error) {
    logger.warn({ err: error }, 'Failed to refresh read table');
  }
}

/**
 * Remove a file from the index
 * @param filePath - Path to remove from index
 * @param options.skipReadRefresh - If true, skip refreshing read table (for batch operations)
 */
export async function removeFileFromIndex(
  filePath: string, 
  options?: { skipReadRefresh?: boolean }
): Promise<void> {
  // Skip during ENFILE cooldown to prevent error storms
  if (isEnfileActive()) {
    return;
  }
  return withWriteLock(() => removeFileFromIndexInternal(filePath, options));
}

/**
 * Internal: Actual removal logic. Called from locked context.
 */
async function removeFileFromIndexInternal(
  filePath: string, 
  options?: { skipReadRefresh?: boolean; skipFileVectorDelete?: boolean }
): Promise<void> {
  const index = getCurrentIndex();
  if (!index?.table) {
    return;
  }

  try {
    const relativePath = getRemovalRelativePath(filePath);
    const predicate = relativePath
      ? or(eq('path', filePath), eq('relativePath', relativePath))
      : eq('path', filePath);
    await index.table.delete(predicate);
    if (!options?.skipFileVectorDelete) {
      try {
        await deleteFileVectorRowsByPaths(getRemovalMtimeCandidates(filePath));
        logger.info({ path: filePath }, 'file_vectors.delete');
      } catch (err) {
        logger.warn({ err, path: filePath }, 'file_vectors.delete_failure');
      }
      try {
        const deletedRows = await deleteFileNeighborRowsForRemovedPaths([filePath]);
        logger.info({ path: filePath, deletedRows }, 'file_neighbors.delete');
      } catch (err) {
        logger.warn({ err, path: filePath }, 'file_neighbors.delete_failure');
      }
    }
    
    // Refresh read table to see the deletion immediately (unless in batch mode)
    // Without this, searches and Atlas may return stale results including deleted files
    // LanceDB's readConsistencyInterval only triggers on queries, not automatically.
    // Swap-and-retire: the prior read handle is retired (and closed once any
    // in-flight readers finish) — without this, every per-file delete leaked
    // one read-table handle.
    if (!options?.skipReadRefresh) {
      await refreshReadTable();
    }
    
    const removedFromCache = removeIndexedMtimeForPath(filePath);
    index.indexedFilesCount = Math.max(0, index.indexedFilesCount - removedFromCache);
    markChunksTableMutated();
    logger.debug({ filePath }, 'Removed file from index');
    
    // Trigger version cleanup if enough writes have accumulated
    maybeOptimize();
  } catch (error) {
    if (isTooManyOpenFilesError(error)) {
      const { isFirstDetection } = markEnfileDetected(error);
      if (isFirstDetection) {
        logger.error('ENFILE: System file descriptor exhaustion detected - file index operations paused for 60s');
      }
      return;
    }
    logger.warn({ err: error, filePath }, 'Failed to remove file from index');
  }
}

function getRemovalRelativePath(filePath: string): string | null {
  const index = getCurrentIndex();
  if (!index) {
    return null;
  }

  if (!path.isAbsolute(filePath)) {
    return toPortablePath(filePath);
  }

  const relativePath = tryConvertToWorkspacePath(filePath, index.workspacePath, index.symlinkMap)
    ?? path.relative(index.workspacePath, filePath);
  const portableRelativePath = toPortablePath(relativePath);
  return portableRelativePath.startsWith('../') || portableRelativePath === '..'
    ? null
    : portableRelativePath;
}

function removeIndexedMtimeForPath(filePath: string): number {
  const index = getCurrentIndex();
  if (!index) {
    return 0;
  }

  let removedCount = 0;
  for (const candidate of getRemovalMtimeCandidates(filePath)) {
    if (index.indexedMtimes.delete(candidate)) {
      removedCount++;
    }
  }

  return removedCount;
}

function getRemovalMtimeCandidates(filePath: string): string[] {
  const index = getCurrentIndex();
  if (!index) {
    return [filePath];
  }

  const candidates = new Set<string>([filePath]);
  const relativePath = getRemovalRelativePath(filePath);
  if (relativePath) {
    candidates.add(path.resolve(index.workspacePath, relativePath));
  }

  return [...candidates];
}


async function deleteFileVectorRowsByPaths(pathsToDelete: string[]): Promise<void> {
  const fileVectorsTable = getCurrentIndex()?.fileVectorsTable;
  if (!fileVectorsTable || pathsToDelete.length === 0) {
    return;
  }

  const uniquePaths = [...new Set(pathsToDelete)];
  const BATCH_SIZE = 50;
  for (let i = 0; i < uniquePaths.length; i += BATCH_SIZE) {
    const batch = uniquePaths.slice(i, i + BATCH_SIZE);
    const relativePathCandidates = [...new Set(
      batch
        .map((filePath) => getRemovalRelativePath(filePath))
        .filter((relativePath): relativePath is string => relativePath !== null)
    )];
    const predicates = [inAny('path', batch)];
    if (relativePathCandidates.length > 0) {
      predicates.push(inAny('relative_path', relativePathCandidates));
    }
    await fileVectorsTable.delete(or(...predicates));
  }
}

async function readChunksForFileVector(filePath: string): Promise<FileVectorSourceChunk[]> {
  const table = getCurrentIndex()?.table;
  if (!table) {
    return [];
  }

  const rows = await table
    .query()
    .where(eq('path', filePath))
    .select(['path', 'relativePath', 'extension', 'mtime', 'indexedAt', 'enhanced_at', 'vector'])
    .toArray();

  return rows as FileVectorSourceChunk[];
}

/**
 * Outcome of a one-time NaN-chunk repair attempt (FU-4 / FU-4b). The states map
 * to the differentiated metrics Codex asked for:
 *  - `not_repairable`      — no non-finite chunk rows present (not our target; no-op).
 *  - `healed`              — re-indexed; a valid file_vectors row now exists.
 *  - `still_invalid`       — re-indexed, all chunks dropped by the guard → the file
 *                            is legitimately unfillable (gone / backend NaN). CONVERGED.
 *  - `failed_before_purge` — the repair threw before the destructive delete; corrupt
 *                            rows are intact → safe to retry.
 *  - `failed_after_purge`  — the delete ran then the re-add failed (transient IO/FD)
 *                            while the source is still indexable → chunk-less but
 *                            RECOVERABLE; MUST be re-enqueued, never lost (MA2).
 * `purgedRows` is the count of non-finite chunk rows observed before the re-index.
 */
export type NanRepairOutcome = {
  state:
    | 'not_repairable'
    | 'healed'
    | 'still_invalid'
    | 'failed_before_purge'
    | 'failed_after_purge';
  purgedRows: number;
};

/**
 * FU-4b/MA2: is `filePath` a still-indexable source on disk? Used to recognize the
 * post-purge-loss state (zero chunk rows but recoverable content) so the repair
 * can re-index from disk instead of giving up as `not_repairable`.
 */
async function isRecoverableSourceOnDisk(filePath: string): Promise<boolean> {
  if (!shouldIndexFile(filePath)) {
    return false;
  }
  try {
    // S4.1c: route through the boundary so a dead cloud mount can't hang the repair
    // (this site previously had NO bound — the inventory's one cloud-reachable gap).
    const realpathOutcome = await workspaceFs.realpath(filePath);
    let canonicalPath: string;
    if (realpathOutcome.status === 'ok') {
      canonicalPath = realpathOutcome.value;
    } else if (realpathOutcome.status === 'reconnecting') {
      // S4.1c (review F1): a dead/unreachable cloud mount is NOT "source gone" — the
      // (already-purged) rows may be recoverable once the mount returns. PROPAGATE so the
      // repair caller defers/retries (failed_after_purge), never converging to terminal
      // not_repairable (which would drop the repair work for a transient cloud-down).
      throw new CloudIndexReadTimeoutError('isRecoverableSourceOnDisk.realpath');
    } else {
      // Not a symlink / unresolvable realpath: fall back to the literal path and let the
      // (bounded) stat below decide recoverability. Best-effort canonicalization.
      ignoreBestEffortCleanup(realpathOutcome.error, {
        operation: 'isRecoverableSourceOnDisk.realpath',
        reason: 'realpath-fallback-to-literal-path-for-recoverability-stat',
        owner: 'main.fileIndexService',
      });
      canonicalPath = filePath;
    }
    // reconnecting → CloudIndexReadTimeoutError (propagated by the catch below).
    const stat = unwrapIndexRead(await workspaceFs.stat(canonicalPath), 'stat');
    return stat.isFile && stat.size > 0 && stat.size <= MAX_FILE_SIZE;
  } catch (err) {
    // S4.1c (review F1): a cloud mount unavailable mid-probe (CloudIndexReadTimeoutError)
    // is RETRYABLE, not "not recoverable" — propagate so the repair caller defers. Only a
    // genuine fs error / absence (ENOENT) is an expected "not recoverable" outcome here.
    if (err instanceof CloudIndexReadTimeoutError) throw err;
    ignoreBestEffortCleanup(err, {
      operation: 'isRecoverableSourceOnDisk.stat',
      reason: 'missing-or-unreadable-source-is-not-recoverable',
      owner: 'main.fileIndexService',
    });
    return false;
  }
}

/**
 * Test-only seam for the bounded post-purge recoverability probe (S4.1c review F1):
 * resolves `true`/`false` for a present/absent source, but REJECTS with
 * `CloudIndexReadTimeoutError` when the source is on a dead/unreachable cloud mount so
 * the repair caller defers (retryable) rather than converging to terminal not_repairable.
 */
export const _isRecoverableSourceOnDiskForTesting = isRecoverableSourceOnDisk;

/**
 * FU-4: proactively repair a file that is currently unfillable because legacy
 * NON-FINITE (NaN/Inf) chunk vectors already exist on disk — written before the
 * embed-time guard shipped. Such rows poison the whole-file average and mark the
 * file `invalid_vectors`, so it never becomes searchable and (pre-Stage-3) drove
 * the idle-CPU retry loop.
 *
 * The repair REUSES the normal index path rather than hand-rolling an embedder:
 * `indexFileInternal` re-reads the file, re-chunks + re-embeds it (now under the
 * embed-time guard, which drops any non-finite chunk), purges the prior chunk
 * rows for the path, and recomputes the file_vectors row. So a single call both
 * purges the corrupt rows and heals the file. After it returns, we re-read the
 * chunks and recompute the file vector to get the authoritative outcome.
 *
 * Contract:
 * - MUST be called with the write lock already held (it runs from inside the
 *   repair sweep's `withWriteLock`); it never acquires the lock itself, and calls
 *   the `*Internal` routines directly to avoid a self-deadlock.
 * - Returns `not_repairable` (a no-op) when the file's chunks are NOT non-finite
 *   (e.g. a genuine zero-norm/mismatched-dimension skip) — those are left to the
 *   existing deterministic-skip path, never re-embedded.
 * - Returns `healed` / `still_invalid` for a completed re-index, and the two
 *   distinct failure states (`failed_before_purge` / `failed_after_purge`) so the
 *   sweep can keep a recoverable post-purge add-failure queued for retry instead
 *   of silently losing the file (MA2).
 *
 * NOTE on the "valid rows are never deleted" claim: the repair re-indexes the
 * WHOLE file, which deletes ALL of that path's chunk rows and replaces them. It is
 * NOT a surgical delete of only the non-finite rows. That is acceptable because
 * the source content on disk is the source of truth and the replacement is written
 * durably (or, if the re-add fails, surfaced as `failed_after_purge` for retry).
 *
 * @returns the repair outcome + number of corrupt chunk rows observed.
 */
async function repairFileWithNonFiniteChunks(
  filePath: string,
  workspacePath: string
): Promise<NanRepairOutcome> {
  const index = getCurrentIndex();
  if (!index?.table || index.workspacePath !== workspacePath) {
    return { state: 'not_repairable', purgedRows: 0 };
  }

  // Confirm the repairable signal: at least one EXISTING chunk row for this path
  // has a non-finite vector. If none are non-finite, this is not the NaN-repair
  // target (it's some other deterministic skip) — leave it to the skip path.
  let priorChunks: FileVectorSourceChunk[];
  try {
    priorChunks = await readChunksForFileVector(filePath);
  } catch (err) {
    // Read before any destructive step — corrupt rows intact, safe to retry.
    logger.warn({ err, path: filePath }, 'file_vectors.repair_failed');
    return { state: 'failed_before_purge', purgedRows: 0 };
  }

  const nonFiniteRows = priorChunks.filter((chunk) => {
    // MUST materialize the Arrow vector first: direct `vec[i]` indexing on a
    // non-materialized Arrow FloatVector returns `undefined` (which would make
    // EVERY chunk look "non-finite" and trigger a spurious re-embed of clean
    // files — the exact pitfall the Stage-4 researcher flagged).
    const vector = Array.from(chunk.vector);
    return vector.some((value) => !Number.isFinite(value));
  }).length;

  if (nonFiniteRows === 0) {
    // MA2 recovery: a path with ZERO chunk rows but a still-indexable source on
    // disk is the post-purge-loss state — an earlier repair deleted the corrupt
    // rows then the re-add failed. The "confirm non-finite" gate can't fire (there
    // are no rows), but the file is recoverable: re-index it from disk. (A file
    // with finite rows and no non-finite vector is a genuine non-target → skip.)
    let recoverableAfterPurge = false;
    if (priorChunks.length === 0) {
      try {
        recoverableAfterPurge = await isRecoverableSourceOnDisk(filePath);
      } catch (err) {
        // S4.1c (review F1): the post-purge recoverability probe hit a dead/unreachable
        // cloud mount. The rows are already gone but the source may be fine once the mount
        // returns → RETRYABLE (failed_after_purge), NOT terminal not_repairable (which
        // would drop the repair work for a transient cloud-down). Any other error is
        // unexpected here (the probe is internally fail-safe) → surface it.
        if (err instanceof CloudIndexReadTimeoutError) {
          logger.warn({ path: filePath }, 'file_vectors.repair_defer_cloud_unavailable');
          return { state: 'failed_after_purge', purgedRows: 0 };
        }
        throw err;
      }
    }
    if (recoverableAfterPurge) {
      logger.info({ path: filePath }, 'file_vectors.repair_recover_after_purge');
      // fall through to the re-index below with nonFiniteRows === 0 as "recovery"
    } else {
      return { state: 'not_repairable', purgedRows: 0 };
    }
  }

  logger.info(
    { path: filePath, nonFiniteRows, totalChunks: priorChunks.length },
    'file_vectors.repair_start'
  );

  // Re-index via the EXISTING embed path: purges the prior (corrupt) chunk rows
  // for this path and re-embeds under the guard. The structured `outcome` tells us
  // whether a throw happened before or after the destructive purge (MA2).
  const indexOutcome: IndexFileOutcome = { phase: 'not_indexable' };
  try {
    await indexFileInternal(filePath, workspacePath, indexOutcome);
  } catch (err) {
    // indexFileInternal swallows its own errors (returns 0), so this catch only
    // fires for an unexpected throw; classify by the recorded phase.
    const afterPurge = indexOutcome.phase === 'failed_after_purge' || indexOutcome.phase === 'added';
    logger.warn({ err, path: filePath, phase: indexOutcome.phase }, 'file_vectors.repair_failed');
    return { state: afterPurge ? 'failed_after_purge' : 'failed_before_purge', purgedRows: nonFiniteRows };
  }

  // MA2: an internally-swallowed post-purge re-add failure. The old rows are gone
  // but the source is still indexable on disk — RECOVERABLE, must retry, never
  // present as convergence.
  if (indexOutcome.phase === 'failed_after_purge') {
    logger.warn({ path: filePath, purgedRows: nonFiniteRows }, 'file_vectors.repair_failed');
    return { state: 'failed_after_purge', purgedRows: nonFiniteRows };
  }
  // A pre-purge failure (e.g. the file became unreadable before we deleted
  // anything): rows intact, retry.
  if (indexOutcome.phase === 'failed_before_purge') {
    logger.warn({ path: filePath, purgedRows: nonFiniteRows }, 'file_vectors.repair_failed');
    return { state: 'failed_before_purge', purgedRows: nonFiniteRows };
  }

  // Determine the authoritative healed/unfillable outcome from the re-indexed state.
  let freshChunks: FileVectorSourceChunk[];
  try {
    freshChunks = await readChunksForFileVector(filePath);
  } catch (err) {
    // The re-index itself succeeded (phase added/created/all_invalid_dropped); a
    // failure only on the verify-read is not a data-loss case — treat as converged
    // for this identity (the rows are whatever indexFileInternal left durably).
    logger.warn({ err, path: filePath }, 'file_vectors.repair_failed');
    return { state: 'still_invalid', purgedRows: nonFiniteRows };
  }

  if (freshChunks.length === 0) {
    // The file is gone on disk (not_indexable) or produced no usable chunk under
    // the guard (all_invalid_dropped): the re-index removed the corrupt rows and
    // wrote nothing. Legitimately converged — it leaves the chunk projection.
    logger.info({ path: filePath, purgedRows: nonFiniteRows, phase: indexOutcome.phase }, 'file_vectors.repair_failed');
    return { state: 'still_invalid', purgedRows: nonFiniteRows };
  }

  const result = await recomputeFileVectorRow(filePath, freshChunks);
  if (result === 'written') {
    logger.info(
      { path: filePath, purgedRows: nonFiniteRows, chunkCount: freshChunks.length },
      'file_vectors.repaired'
    );
    return { state: 'healed', purgedRows: nonFiniteRows };
  }

  // FU-4c (Codex suggestion 3): the chunks re-indexed cleanly (finite, durable),
  // but the file_vectors row was NOT written. Distinguish:
  //  - 'failed' → a TRANSIENT persist error writing the file_vectors row. The
  //    finite chunks are durable, so this is recoverable — surface it as a
  //    retryable post-purge failure so the sweep retries (bounded) instead of
  //    silently converging finite chunks with no file_vectors row.
  //  - 'skipped' → the averaged vector is genuinely null over these finite chunks
  //    (e.g. mismatched dimensions): unfillable CONTENT → converged (still_invalid).
  if (result === 'failed') {
    logger.warn(
      { path: filePath, purgedRows: nonFiniteRows, chunkCount: freshChunks.length },
      'file_vectors.repair_failed'
    );
    return { state: 'failed_after_purge', purgedRows: nonFiniteRows };
  }

  logger.warn(
    { path: filePath, purgedRows: nonFiniteRows, result },
    'file_vectors.repair_failed'
  );
  return { state: 'still_invalid', purgedRows: nonFiniteRows };
}

/**
 * Batch remove multiple files from the index.
 * Uses a single LanceDB delete per batch for much better performance than individual deletes.
 * Falls back to individual deletes if batch delete fails.
 *
 * @param filePaths - Array of file paths to remove
 * @param options.skipReadRefresh - If true, skip refreshing read table (caller handles it)
 * @param options.skipOptimize - If true, skip maybeOptimize() call (caller handles it)
 * @returns Number of files actually removed from the in-memory cache
 */
export async function removeFilesFromIndex(
  filePaths: string[],
  options?: { skipReadRefresh?: boolean; skipOptimize?: boolean }
): Promise<number> {
  // Skip during ENFILE cooldown to prevent error storms
  if (isEnfileActive()) {
    return 0;
  }
  return withWriteLock(() => removeFilesFromIndexInternal(filePaths, options));
}

/**
 * Internal: Actual batch removal logic. Called from locked context.
 */
async function removeFilesFromIndexInternal(
  filePaths: string[],
  options?: { skipReadRefresh?: boolean; skipOptimize?: boolean }
): Promise<number> {
  const index = getCurrentIndex();
  if (!index?.table || filePaths.length === 0) {
    return 0;
  }

  // De-duplicate paths (watcher churn can produce duplicates)
  const uniquePaths = [...new Set(filePaths)];

  const BATCH_SIZE = 50; // Reasonable predicate size for LanceDB/DataFusion
  let removedCount = 0;

  for (let i = 0; i < uniquePaths.length; i += BATCH_SIZE) {
    const batch = uniquePaths.slice(i, i + BATCH_SIZE);

    const predicate = or(...batch.flatMap((filePath) => {
      const relativePath = getRemovalRelativePath(filePath);
      return relativePath
        ? [eq('path', filePath), eq('relativePath', relativePath)]
        : [eq('path', filePath)];
    }));

    try {
      await index.table.delete(predicate);
      try {
        await deleteFileVectorRowsByPaths(batch.flatMap((filePath) => getRemovalMtimeCandidates(filePath)));
        logger.info({ paths: batch.length }, 'file_vectors.delete');
      } catch (err) {
        logger.warn({ err, paths: batch.length }, 'file_vectors.delete_failure');
      }
      try {
        const deletedRows = await deleteFileNeighborRowsForRemovedPaths(batch);
        logger.info({ paths: batch.length, deletedRows }, 'file_neighbors.delete');
      } catch (err) {
        logger.warn({ err, paths: batch.length }, 'file_neighbors.delete_failure');
      }

      // Update in-memory tracking for all paths in batch
      for (const filePath of batch) {
        const removedFromCache = removeIndexedMtimeForPath(filePath);
        index.indexedFilesCount = Math.max(0, index.indexedFilesCount - removedFromCache);
        removedCount += removedFromCache;
      }

      logger.debug({ batchSize: batch.length, batchIndex: Math.floor(i / BATCH_SIZE) }, 'Batch deleted files from index');
    } catch (error) {
      // If ENFILE, mark it and skip fallback - don't hammer with individual deletes
      if (isTooManyOpenFilesError(error)) {
        const { isFirstDetection } = markEnfileDetected(error);
        if (isFirstDetection) {
          logger.error('ENFILE: System file descriptor exhaustion detected - file index operations paused for 60s');
        }
        // Skip remaining batches during ENFILE
        break;
      }

      // Fallback to individual deletes if batch fails (non-ENFILE errors only)
      // NOTE: Use internal variant to avoid deadlock (we already hold the lock)
      logger.warn({ err: error, batchSize: batch.length }, 'Batch delete failed, falling back to individual deletes');

      for (const filePath of batch) {
        try {
          await removeFileFromIndexInternal(filePath, { skipReadRefresh: true });
          removedCount++;
        } catch (individualError) {
          logger.warn({ err: individualError, filePath }, 'Individual delete also failed');
        }
      }
    }
  }

  // Single refresh after all batches.
  // Swap-and-retire: the prior read handle is retired (and closed once any
  // in-flight readers finish). The single-refresh-per-batch design means
  // this site's leak only fires once per watcher batch, but on a busy
  // workspace that's still hundreds of leaks per hour.
  if (!options?.skipReadRefresh) {
    try {
      await refreshReadTable();
    } catch (error) {
      if (isTooManyOpenFilesError(error)) {
        markEnfileDetected(error); // Toast already shown if first detection
      } else {
        logger.warn({ err: error }, 'Failed to refresh read table after batch delete');
      }
    }
  }

  // Trigger optimize if needed (unless skipped)
  if (!options?.skipOptimize) {
    maybeOptimize();
  }

  if (removedCount > 0) {
    markChunksTableMutated();
  }

  logger.info({ removedCount, totalPaths: uniquePaths.length }, 'Batch removed files from index');
  return removedCount;
}

/**
 * Check if a file needs reindexing based on mtime
 * Uses in-memory mtime cache for O(1) lookups - no DB queries
 */
export async function needsReindexing(filePath: string): Promise<boolean> {
  if (!getCurrentIndex()) {
    return true;
  }

  // Stage 7 (F2): an admitted cloud file's realpath/stat below dereference the FUSE
  // mount. Bound them so a mount that died after admission can't block this check
  // (which gates the indexer queue) + park libuv. FS-FREE gate (flag + containment +
  // cached verdict). A non-healthy space DEFERS without any fs op (caps the batch
  // libuv-park amplification — GPT review should-3): return false = "don't re-index
  // this pass", retaining the last-known entry. `local` ⇒ bare path, unchanged.
  const cloudReadDisposition = cloudIndexReadDisposition(filePath);
  if (cloudReadDisposition === 'defer-cloud') {
    return false;
  }
  // (the disposition above only gates the FS-FREE defer; the boundary bounds each op.)

  try {
    // Resolve symlinks to get canonical path (matches how indexFile stores paths)
    // This is critical for workspaces with symlinked directories (e.g., Google Drive spaces)
    let canonicalPath: string;
    try {
      canonicalPath = unwrapIndexRead(
        await workspaceFs.realpath(filePath),
        'realpath',
      );
    } catch (err) {
      if (err instanceof CloudIndexReadTimeoutError) throw err; // dead mount → defer (outer catch)
      canonicalPath = filePath;
    }

    // Check in-memory cache (keyed by canonical path)
    const cachedMtime = getCurrentIndex()?.indexedMtimes.get(canonicalPath);

    if (cachedMtime === undefined) {
      // File not in index - needs indexing
      return true;
    }

    // File is indexed - check if mtime has changed
    // Note: We store Math.floor(mtimeMs) in the database, so floor the comparison too
    const stat = unwrapIndexRead(
      await workspaceFs.stat(canonicalPath),
      'stat',
    );
    return cachedMtime < Math.floor(stat.mtimeMs);
  } catch (err) {
    // Stage 7 (F2): a dead admitted cloud mount timed out. DEFER — return false so
    // the indexer does NOT attempt to re-index (which would block on the same dead
    // mount); the last-known index entry is retained and re-checked on a later pass
    // (the onRecovery rebuild re-runs discovery). For a non-cloud file the existing
    // contract is unchanged: a missing/unstattable file needs a reindex attempt.
    if (err instanceof CloudIndexReadTimeoutError) {
      logger.debug(
        { filePath },
        'needsReindexing: deferring an admitted cloud file (mount unresponsive within budget); not re-indexing this pass',
      );
      return false;
    }
    // File doesn't exist or can't be stat'd - needs reindexing attempt
    return true;
  }
}

/**
 * Get the count of unique indexed files from the database.
 * This returns the number of distinct file paths, NOT the chunk count.
 * Uses the in-memory mtime cache which is keyed by path (Map automatically deduplicates).
 */
export async function getIndexedFileCount(): Promise<number> {
  // Use the in-memory cache size which is already deduplicated by path
  // This is the accurate count of unique files, not chunks
  return getCurrentIndex()?.indexedMtimes.size ?? 0;
}

/**
 * Get the current index status (sync version for cache state)
 */
export function getIndexStatus(isWatching: boolean = false, indexState: IndexState = 'not_started'): IndexStatus {
  const index = getCurrentIndex();
  if (!index) {
    // Fall back to pre-loaded metadata so the UI shows accurate counts
    // during the 120s startup delay instead of "Not started" / "Never"
    const cachedMetadataForStatus = getCachedMetadataForStatus();
    if (cachedMetadataForStatus) {
      return {
        totalFiles: cachedMetadataForStatus.indexedFiles,
        indexedFiles: cachedMetadataForStatus.indexedFiles,
        pendingFiles: 0,
        lastIndexedAt: cachedMetadataForStatus.lastIndexedAt,
        isWatching: false,
        workspacePath: cachedMetadataForStatus.workspacePath,
        indexState: 'not_started',
        totalChunks: 0,
        enhancedChunks: 0,
        enhancementRunning: false,
        enhancementPaused: false,
      };
    }
    return {
      totalFiles: 0,
      indexedFiles: 0,
      pendingFiles: 0,
      lastIndexedAt: null,
      isWatching: false,
      workspacePath: null,
      indexState: 'not_started',
      totalChunks: 0,
      enhancedChunks: 0,
      enhancementRunning: false,
      enhancementPaused: false,
    };
  }

  return {
    totalFiles: index.indexedFilesCount,
    indexedFiles: index.indexedFilesCount, // From DB count on init
    pendingFiles: 0,
    lastIndexedAt: index.lastIndexedAt,
    isWatching,
    workspacePath: index.workspacePath,
    indexState,
    totalChunks: getEnhancementStateRaw().totalChunks,
    enhancedChunks: getEnhancementStateRaw().enhancedChunks,
    enhancementRunning: getEnhancementStateRaw().isRunning,
    enhancementPaused: getEnhancementStateRaw().isPaused,
  };
}

/**
 * Clear the entire index for a workspace
 * @param workspacePath - Optional workspace path. If provided and currentIndex is null,
 *                        will try to connect to the database and drop the table.
 */
export async function clearIndex(workspacePath?: string): Promise<void> {
  return withWriteLock(() => clearIndexInternal(workspacePath));
}

/**
 * Internal: Actual clear logic. Called from locked context.
 */
async function clearIndexInternal(workspacePath?: string): Promise<void> {
  // If currentIndex exists, clear it normally
  const index = getCurrentIndex();
  if (index) {
    try {
      abortFileNeighborsLazyFill(index.workspacePath, 'index_clear');
      // FU-4b: stop the decoupled NaN-repair sweep + drop its in-memory memo /
      // pending queue for this workspace — clearing the index resets all derived
      // state, so a stale repair record must not survive into the rebuilt index.
      cancelNanRepairSweep(index.workspacePath);
      getNanRepairAttempts().delete(index.workspacePath);
      getNanRepairPending().delete(index.workspacePath);
      getNanRepairFailures().delete(index.workspacePath);
      // Detach the read handle BEFORE we drop the underlying table so a
      // concurrently-started `semanticSearch` / `getFileEmbeddings` can't
      // acquire a doomed handle (they fall through the
      // `currentIndex?.readTable ?? null` null-check). Then retire +
      // bounded drain wait, matching the shutdown contract in
      // `closeIndexInternal` — draining AFTER `dropTable()` is too late
      // to protect in-flight readers from having the table yanked out
      // from under them.
      const droppedReadHandle = index.readTable;
      index.readTable = null;
      if (droppedReadHandle) {
        await droppedReadHandle.retire();
        const drainResult = await droppedReadHandle.waitForDrain(SHUTDOWN_DRAIN_TIMEOUT_MS);
        if (!drainResult.drained) {
          logger.warn(
            { remainingRefs: drainResult.remainingRefs, timeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS },
            'readTable drain timeout during clearIndex — proceeding with table drop'
          );
        }
      }
      const droppedFileVectorsReadHandle = index.fileVectorsReadTable;
      index.fileVectorsReadTable = null;
      if (droppedFileVectorsReadHandle) {
        await droppedFileVectorsReadHandle.retire();
        const drainResult = await droppedFileVectorsReadHandle.waitForDrain(SHUTDOWN_DRAIN_TIMEOUT_MS);
        if (!drainResult.drained) {
          logger.warn(
            { remainingRefs: drainResult.remainingRefs, timeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS },
            'fileVectorsReadTable drain timeout during clearIndex — proceeding with table drop'
          );
        }
      }
      const droppedFileNeighborsReadHandle = index.fileNeighborsReadTable;
      index.fileNeighborsReadTable = null;
      if (droppedFileNeighborsReadHandle) {
        await droppedFileNeighborsReadHandle.retire();
        const drainResult = await droppedFileNeighborsReadHandle.waitForDrain(SHUTDOWN_DRAIN_TIMEOUT_MS);
        if (!drainResult.drained) {
          logger.warn(
            { remainingRefs: drainResult.remainingRefs, timeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS },
            'fileNeighborsReadTable drain timeout during clearIndex — proceeding with table drop'
          );
        }
      }
      try { index.table?.close(); } catch (err) {
        logger.warn({ err }, 'Error closing LanceDB write table before clearIndex drop');
      }
      try { index.fileVectorsTable?.close(); } catch (err) {
        logger.warn({ err }, 'Error closing LanceDB file vectors write table before clearIndex drop');
      }
      try { index.fileNeighborsTable?.close(); } catch (err) {
        logger.warn({ err }, 'Error closing LanceDB file neighbors write table before clearIndex drop');
      }
      const tableNamesBeforeDrop = await index.connection.tableNames();
      let partialDropError: unknown = null;

      if (index.table) {
        await index.connection.dropTable(TABLE_NAME);
        index.table = null;
      } else if (tableNamesBeforeDrop.includes(TABLE_NAME)) {
        await index.connection.dropTable(TABLE_NAME);
      }

      if (index.fileVectorsTable || tableNamesBeforeDrop.includes(FILE_VECTORS_TABLE_NAME)) {
        try {
          await index.connection.dropTable(FILE_VECTORS_TABLE_NAME);
        } catch (err) {
          logger.warn({ err, workspacePath: index.workspacePath }, 'file_vectors.clear_partial_failure');
          partialDropError ??= err;
        }
        index.fileVectorsTable = null;
        index.fileVectorsReadTable = null;
      }

      if (index.fileNeighborsTable || tableNamesBeforeDrop.includes(FILE_NEIGHBORS_TABLE_NAME)) {
        try {
          await index.connection.dropTable(FILE_NEIGHBORS_TABLE_NAME);
        } catch (err) {
          logger.warn({ err, workspacePath: index.workspacePath }, 'file_neighbors.clear_partial_failure');
          partialDropError ??= err;
        }
        index.fileNeighborsTable = null;
        index.fileNeighborsReadTable = null;
      }

      if (partialDropError) {
        throw partialDropError;
      }

      index.ftsStatus = 'unavailable';
      index.indexedMtimes.clear();
      index.indexedFilesCount = 0;
      index.lastIndexedAt = null;
      await clearScanMetadata();
      markChunksTableMutated();
      logger.info('Index cleared');
      return;
    } catch (error) {
      logger.error({ err: error }, 'Failed to clear index');
      throw error;
    }
  }

  // currentIndex is null - try to clear database directly if workspacePath provided
  if (!workspacePath) {
    logger.debug('clearIndex called but no currentIndex and no workspacePath provided');
    return;
  }

  try {
    const lanceDBDir = getLanceDBDir(workspacePath);
    
    // Check if database directory exists
    try {
      // workspace-fs-allow-local: the LanceDB index dir is app-data (<userData>/indices/), NEVER a workspace/cloud path — bare fs is correct here.
      await fs.access(lanceDBDir);
    } catch {
      logger.debug({ lanceDBDir }, 'No index database found to clear');
      return;
    }

    // Connect and drop table if it exists.
    // FD-leak fix: the prior implementation opened an ad-hoc connection and
    // never closed it (`fileIndexService.ts:2095-2101` in the investigation
    // doc) — every workspace switch / force-reindex against a no-current-
    // index state leaked one connection. Wrap in try/finally so close fires
    // on both success and rejection of `dropTable`.
    const lancedb = loadNativeModule<typeof import('@lancedb/lancedb')>('@lancedb/lancedb');
    const connection = await lancedb.connect(lanceDBDir);
    try {
      const tableNames = await connection.tableNames();
      let partialDropError: unknown = null;

      if (tableNames.includes(TABLE_NAME)) {
        await connection.dropTable(TABLE_NAME);
        markChunksTableMutated();
        logger.info({ workspacePath }, 'Index table dropped (was not initialized in memory)');
      }
      if (tableNames.includes(FILE_VECTORS_TABLE_NAME)) {
        try {
          await connection.dropTable(FILE_VECTORS_TABLE_NAME);
          logger.info({ workspacePath }, 'File vectors table dropped (was not initialized in memory)');
        } catch (err) {
          logger.warn({ err, workspacePath }, 'file_vectors.clear_partial_failure');
          partialDropError ??= err;
        }
      }
      if (tableNames.includes(FILE_NEIGHBORS_TABLE_NAME)) {
        try {
          await connection.dropTable(FILE_NEIGHBORS_TABLE_NAME);
          logger.info({ workspacePath }, 'File neighbors table dropped (was not initialized in memory)');
        } catch (err) {
          logger.warn({ err, workspacePath }, 'file_neighbors.clear_partial_failure');
          partialDropError ??= err;
        }
      }

      if (partialDropError) {
        throw partialDropError;
      }

      // Clear metadata. Use `getMetadataPath()` so this stays in sync with
      // the canonical METADATA_FILE constant ('index_metadata.json' with an
      // underscore) — the prior hardcoded 'index-metadata.json' (hyphen)
      // never matched the file written by `saveMetadata()`, leaving the
      // file behind on every clearIndex call. Flagged in Phase 1 review.
      const metadataPath = getMetadataPath(workspacePath);
      try {
        await fs.unlink(metadataPath);
      } catch (err) {
        // Silent-failure rule: log so an unexpected unlink failure (other
        // than ENOENT) is observable. Missing file is the common case
        // (metadata may not exist) so we keep this at debug to avoid
        // production log noise.
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (code === 'ENOENT') {
          logger.debug({ metadataPath }, 'Index metadata file already absent during clearIndex');
        } else {
          logger.warn({ err, metadataPath }, 'Failed to unlink index metadata file during clearIndex');
        }
      }

      logger.info('Index cleared');
    } finally {
      // Always close the ad-hoc connection — silent-failure rule: any
      // close error must surface in structured logs, not be swallowed.
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- LanceDB SDK types do not surface .close() on Connection in this version, but it is supported at runtime
        const closeResult = (connection as any).close?.();
        if (closeResult && typeof (closeResult as PromiseLike<unknown>).then === 'function') {
          await closeResult;
        }
      } catch (closeErr) {
        logger.warn({ err: closeErr, workspacePath }, 'Failed to close ad-hoc LanceDB connection in clearIndexInternal');
      }
    }
  } catch (error) {
    logger.error({ err: error, workspacePath }, 'Failed to clear index from disk');
    throw error;
  }
}

/**
 * Get the current workspace path
 */
export function getCurrentLibraryPath(): string | null {
  return getCurrentIndex()?.workspacePath ?? null;
}

/**
 * Check if an index exists (has been initialized with a table).
 * Use this instead of isWatching() when you need to check if searches can be performed
 * (e.g., when watcher is paused but index still exists).
 */
export function hasIndex(): boolean {
  return getCurrentIndex()?.table != null;
}

/** Whether the file index has a searchable table (for pre-flight readiness checks). */
export function isFileIndexReady(): boolean {
  return (getCurrentIndex()?.readTable ?? getCurrentIndex()?.table) != null;
}

/**
 * Get the index metadata (for health checks).
 * Returns null if no index is open.
 */
export function getIndexMetadata(): IndexMetadata | null {
  return getCurrentIndex()?.metadata ?? null;
}

/**
 * Current FTS (keyword) index status (for the Semantic Index health check).
 * `'ready'` → hybrid keyword+vector search; `'failed'` → keyword build failed,
 * hybrid degraded to vector-only ranking; `'unavailable'` → benign no-FTS-yet
 * (still building / freshly cleared). Single `currentIndex` singleton.
 * See docs/plans/260618_semantic-index-error-surfacing/PLAN.md.
 */
export function getFtsStatus(): WorkspaceIndex['ftsStatus'] {
  return getCurrentIndex()?.ftsStatus ?? 'unavailable';
}

/**
 * Get the timestamp of the last indexing operation
 */
export function getLastIndexedAt(): number | null {
  return getCurrentIndex()?.lastIndexedAt ?? null;
}

/**
 * Get the timestamp when the last full scan completed
 * Returns null if scan never completed or was interrupted
 */
export function getScanCompletedAt(): number | null {
  return getCurrentIndex()?.metadata.scanCompletedAt ?? null;
}

/**
 * Get the total files count from when the scan completed
 * Returns null if scan never completed
 */
export function getTotalFilesAtCompletion(): number | null {
  return getCurrentIndex()?.metadata.totalFilesAtCompletion ?? null;
}

/**
 * Pre-load index metadata from disk so getIndexStatus() can return truthful
 * values while the full LanceDB index is still loading (120s startup delay).
 *
 * Call this early in the startup sequence, BEFORE the delayed indexing scheduler.
 * Once the real index opens via initializeIndex(), getIndexStatus() uses
 * currentIndex and this cache is ignored.
 */
export async function preloadIndexMetadata(workspacePath: string): Promise<void> {
  try {
    const metadata = await loadMetadata(workspacePath);
    if (metadata.scanCompletedAt && metadata.totalFilesAtCompletion) {
      setCachedMetadataForStatus({
        workspacePath,
        indexedFiles: metadata.totalFilesAtCompletion,
        lastIndexedAt: metadata.scanCompletedAt,
      });
      logger.info(
        { indexedFiles: metadata.totalFilesAtCompletion, lastIndexedAt: new Date(metadata.scanCompletedAt).toISOString() },
        'Pre-loaded index metadata for status display'
      );
    }
  } catch (err) {
    logger.debug({ err }, 'No cached index metadata to pre-load');
  }
}

/**
 * Mark the full scan as complete
 * Call this when the initial file scan finishes processing all discovered files
 */
export async function markScanComplete(totalFiles: number): Promise<void> {
  const index = getCurrentIndex();
  if (!index) {
    return;
  }

  const now = Date.now();
  index.metadata = {
    scanCompletedAt: now,
    totalFilesAtCompletion: totalFiles,
    embeddingModel: CURRENT_EMBEDDING_MODEL
  };

  await saveMetadata(index.workspacePath, index.metadata);
  
  logger.info(
    { scanCompletedAt: new Date(now).toISOString(), totalFiles, embeddingModel: CURRENT_EMBEDDING_MODEL },
    'Marked scan as complete'
  );
}

/**
 * Clear scan completion state (e.g., when clearing the index)
 */
async function clearScanMetadata(): Promise<void> {
  const index = getCurrentIndex();
  if (!index) {
    return;
  }

  index.metadata = {
    scanCompletedAt: null,
    totalFilesAtCompletion: null,
    embeddingModel: CURRENT_EMBEDDING_MODEL // Preserve model name
  };

  await saveMetadata(index.workspacePath, index.metadata);
}

export async function hydrateIndexedPathsCache(): Promise<void> {
  const index = getCurrentIndex();
  if (!index?.table) {
    return;
  }

  // If already hydrated during init, skip
  if (index.indexedMtimes.size > 0) {
    logger.debug('Mtime cache already hydrated, skipping');
    return;
  }

  try {
    const startTime = Date.now();

    // Query all path+mtime pairs
    const results = await index.table
      .query()
      .select(['path', 'mtime'])
      .toArray();

    // Build map, keeping max mtime per path
    for (const row of results) {
      const record = row as { path: string; mtime: number };
      const existing = index.indexedMtimes.get(record.path);
      if (existing === undefined || record.mtime > existing) {
        index.indexedMtimes.set(record.path, record.mtime);
      }
    }

    index.indexedFilesCount = index.indexedMtimes.size;

    const elapsed = Date.now() - startTime;
    logger.info(
      { filesCached: index.indexedMtimes.size, totalChunks: results.length, elapsedMs: elapsed },
      'Hydrated mtime cache in background'
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to hydrate mtime cache');
  }
}

/**
 * Get all indexed file paths from the in-memory cache.
 * Used by file watcher to detect stale entries (files deleted while app was closed).
 * Returns empty array if cache is not hydrated.
 */
export function getIndexedPaths(): string[] {
  const index = getCurrentIndex();
  if (!index?.indexedMtimes) {
    return [];
  }
  return Array.from(index.indexedMtimes.keys());
}
