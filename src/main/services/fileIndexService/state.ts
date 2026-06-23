/**
 * File Index Service — shared mutable state owner (Stage C2).
 *
 * This module is the SINGLE OWNER of the file-index service's shared mutable
 * module-level state. Before this stage that state lived as scattered top-level
 * `let`/`const` bindings in `index.ts`, read and field-mutated by ~every cluster
 * (the `currentIndex` god-singleton being the worst). Centralizing it here gives
 * each piece exactly one mutation surface reached through explicit accessors.
 *
 * Behavior-preserving: the accessors wrap the SAME singletons that lived in
 * index.ts. Identical lock serialization (one `writeChain`), identical
 * single-flight semantics (the same six in-flight/checkpoint maps), identical
 * mutation-version staleness contract, identical workspace-switch abort
 * behavior. No logic changed — only WHERE the state lives and HOW it is reached.
 *
 * The `WorkspaceIndex` struct shape is preserved EXACTLY (Phase D2 owns any
 * reshape). The `_get/_setCurrentIndexForTesting` seams in index.ts route
 * through `getCurrentIndex()`/`setCurrentIndex()` here, so the test suite's
 * struct-coupled references (`currentIndex.fileVectorsTable`, `.workspacePath`,
 * etc.) keep working unchanged.
 *
 * No import edge back to `index.ts` (the type definitions the singleton needs
 * live here and are re-imported by index.ts), matching the `optimize.ts` /
 * `fileVectorsWriter.ts` acyclic-graph precedent.
 */

import { ReadTableHandle } from './readTableHandle';
import { buildSymlinkMap, type SymlinkMapping } from '@core/utils/symlinkMap';

type LanceDBConnection = Awaited<ReturnType<typeof import('@lancedb/lancedb').connect>>;
type LanceDBTable = Awaited<ReturnType<LanceDBConnection['openTable']>>;

/**
 * A chunk-level embedding row in the `file_embeddings` table. Owned here (Stage
 * D1) so the enhancement cluster's `getUnenhancedChunks` return type can be
 * shared without an import edge back to index.ts (which re-exports it to
 * preserve the public API + the enhancementService consumer contract). Shape
 * unchanged from the prior index.ts definition.
 */
export type FileEmbeddingRecord = {
  id: string;
  path: string;
  relativePath: string;
  content: string;
  extension: string;
  mtime: number;
  size: number;
  chunkIndex: number;
  totalChunks: number;
  indexedAt: number;
  vector: number[];
  // Filename without extension for FTS search (snake_case required — LanceDB lowercases column names during FTS index creation)
  filename_stem: string;
  // Two-phase indexing: tracks whether chunk has been enhanced with contextual retrieval
  // Using snake_case + integers (0/1) to work around LanceDB boolean query parsing issues
  is_enhanced: number;   // 0 = not enhanced, 1 = enhanced
  enhanced_at: number;   // 0 = not enhanced, otherwise timestamp of enhancement
};

/**
 * The persisted file-level vector row (`file_vectors` table). Owned here (Stage
 * D1) so the derived-views cluster + index.ts share one definition without an
 * import cycle; re-exported by index.ts to preserve the public API. Shape
 * unchanged. NB: `fileVectorsWriter.ts` keeps its own structurally-identical
 * local copy to stay edge-free per the Stage C1 precedent.
 */
export type FileVectorRecord = {
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

/** The persisted file-level neighbor-cache row (`file_neighbors` table). */
export type FileNeighborRecord = {
  path: string;
  relative_path: string;
  neighbor_paths: string[];
  neighbor_scores: number[];
  neighbor_fingerprints: string[];
  source_vector_fingerprint: string;
  k: number;
  computed_at: number;
};

/** A single similar-file result (cosine similarity in [0,1]; higher = closer). */
export interface FindSimilarFilesResult {
  path: string;
  relativePath: string;
  /** Cosine similarity in the [0, 1] display range; higher is more similar. */
  score: number;
}

/** Persisted index metadata (mirrors index_metadata.json on disk). */
export interface IndexMetadata {
  scanCompletedAt: number | null; // Timestamp when full scan completed
  totalFilesAtCompletion: number | null; // Number of files when scan completed
  embeddingModel?: string; // Model used to create embeddings (for migration detection)
}

/**
 * The central per-workspace index handle. Shape preserved EXACTLY as it was
 * defined inline in index.ts before Stage C2 — fields and field mutation
 * semantics are unchanged so the struct-coupled test seams survive untouched.
 */
export interface WorkspaceIndex {
  connection: LanceDBConnection;
  table: LanceDBTable | null;
  fileVectorsTable: LanceDBTable | null;
  fileNeighborsTable: LanceDBTable | null;
  // Separate read connection with eventual consistency to avoid blocking on write operations
  // This prevents semantic search from being blocked during file indexing
  readConnection: LanceDBConnection;
  // Lease-managed read table handle. Readers must `acquire()` / `release()`;
  // writers swap in a new handle and `retire()` the old one. See
  // `ReadTableHandle` JSDoc for the FD-leak motivation and lifecycle contract.
  readTable: ReadTableHandle | null;
  fileVectorsReadTable: ReadTableHandle | null;
  fileNeighborsReadTable: ReadTableHandle | null;
  workspacePath: string;
  /**
   * Cached symlink registry for this workspace, built once via
   * {@link buildSymlinkMap} at index init. Threaded into every hot-path
   * `tryConvertToWorkspacePath` call so that converting an absolute path to a
   * workspace-relative path never rebuilds the registry per file (the idle-CPU
   * hotspot for symlink-backed files, e.g. the 321 Google-Drive files).
   *
   * Invalidated (rebuilt) on workspace (re)init and whenever the file watcher
   * observes a directory being added/removed (symlink topology can change). See
   * {@link rebuildWorkspaceSymlinkMap}.
   */
  symlinkMap: SymlinkMapping[];
  indexedMtimes: Map<string, number>; // path -> mtime for fast needsReindexing() checks
  lastIndexedAt: number | null;
  metadata: IndexMetadata;
  indexedFilesCount: number; // Cached count of unique indexed files (from DB on init)
  // FTS lifecycle state — scoped to workspace to prevent cross-workspace bugs (D6)
  ftsStatus: 'unavailable' | 'ready' | 'failed';
}

/** Two-phase enhancement progress counters. Managed by enhancementService. */
export interface EnhancementState {
  totalChunks: number;
  enhancedChunks: number;
  isRunning: boolean;
  isPaused: boolean;
  schemaSupportsEnhancement: boolean; // Set to true after successful migration
}

/** Result shape of a file_vectors lazy-fill run. */
export type LazyFillFileVectorsResult = {
  filled: number;
  skipped: number;
  failed: number;
  durationMs: number;
};

/** Result shape of a file_vectors reconcile run. */
export type ReconcileFileVectorsResult = {
  recomputed: number;
  deleted: number;
  skipped: number;
  durationMs: number;
};

/** Result shape of a file_neighbors reconcile run. */
export type ReconcileFileNeighborsResult = {
  deleted: number;
  stale: number;
  orphaned: number;
  crossReferenceOrphans: number;
  durationMs: number;
};

/** Cached metadata from a previous session, used as a startup-window status fallback. */
export type CachedMetadataForStatus = {
  workspacePath: string;
  indexedFiles: number;
  lastIndexedAt: number | null;
};

// ============================================================================
// The master singleton
// ============================================================================

let currentIndex: WorkspaceIndex | null = null;

/** Read the live `currentIndex` singleton. */
export function getCurrentIndex(): WorkspaceIndex | null {
  return currentIndex;
}

/**
 * Live count of open LanceDB connections held by the file index. The file
 * index holds TWO native connections when open — a write `connection` and a
 * separate `readConnection` — so an open index contributes 2. LanceDB is a
 * native Rust addon holding connection handles + an async runtime; a nonzero
 * count at quit time is a teardown-thread suspect for the residual macOS
 * quit-deadlock. Synchronous, allocation-free read for the native-liveness
 * snapshot (see `nativeLivenessSnapshot.ts`).
 */
export function getFileLanceLiveConnectionCount(): number {
  return currentIndex ? 2 : 0;
}

/**
 * Replace the live `currentIndex` singleton (workspace switch / open / close).
 * The sole assignment surface — replaces the scattered `currentIndex = ...`
 * writes that used to live in index.ts (init, close, and the testing seam).
 */
export function setCurrentIndex(next: WorkspaceIndex | null): void {
  currentIndex = next;
}

/**
 * Named workspace-switch guard, replacing the scattered
 * `currentIndex !== indexAtStart || currentIndex?.workspacePath !== workspacePath`
 * re-checks that defended the background-fill / reconcile paths against a
 * concurrent workspace switch. Returns true iff the live singleton is still the
 * exact index a background run captured at its start AND still points at the
 * same workspace path. Callers that additionally require a specific table to be
 * present (`.table`, `.fileVectorsTable`, `.fileNeighborsTable`) AND/OR a stable
 * table identity continue to combine this with that explicit check at the call
 * site — the table-presence semantics are deliberately left visible there.
 */
export function isStillCurrent(indexAtStart: WorkspaceIndex, workspacePath: string): boolean {
  return currentIndex === indexAtStart && currentIndex?.workspacePath === workspacePath;
}

/**
 * Read the cached symlink registry for the live workspace, or `null` if no
 * workspace index is currently open. Hot callers pass the result straight into
 * `tryConvertToWorkspacePath` as the 3rd arg; when `null`, the resolver falls
 * back to its own per-call build (correct, just not cached — e.g. during the
 * narrow window before an index is installed).
 */
export function getWorkspaceSymlinkMap(): SymlinkMapping[] | undefined {
  return currentIndex?.symlinkMap;
}

/**
 * Rebuild the cached symlink registry for the live workspace in place. Called
 * when the file watcher observes a directory add/remove (a symlinked mount can
 * appear or disappear), so the cached map cannot go stale across topology
 * changes. No-op when no index is open. Synchronous bounded scan — same cost as
 * one legacy fallback build, but now amortized across all subsequent per-file
 * conversions instead of paid per call.
 */
export function rebuildWorkspaceSymlinkMap(): void {
  if (!currentIndex) return;
  currentIndex.symlinkMap = buildSymlinkMap(currentIndex.workspacePath);
}

// ============================================================================
// Startup-window status fallback
// ============================================================================

let cachedMetadataForStatus: CachedMetadataForStatus | null = null;

export function getCachedMetadataForStatus(): CachedMetadataForStatus | null {
  return cachedMetadataForStatus;
}

export function setCachedMetadataForStatus(next: CachedMetadataForStatus | null): void {
  cachedMetadataForStatus = next;
}

// ============================================================================
// Enhancement state (managed by enhancementService; read by status)
// ============================================================================

let enhancementState: EnhancementState = {
  totalChunks: 0,
  enhancedChunks: 0,
  isRunning: false,
  isPaused: false,
  schemaSupportsEnhancement: false,
};

export function getEnhancementStateRaw(): EnhancementState {
  return enhancementState;
}

export function setEnhancementState(next: EnhancementState): void {
  enhancementState = next;
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
//
// Pattern:
//   export async function indexFile(...) {
//     return withWriteLock(() => indexFileInternal(...));
//   }
//   async function indexFileInternal(...) { /* actual work, can call other *Internal */ }
// ============================================================================

let writeChain: Promise<void> = Promise.resolve();

/**
 * Serialize write operations to prevent concurrent LanceDB mutations.
 * Public mutation functions use this; internal functions do NOT (they're called from locked context).
 */
export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    writeChain = writeChain
      .then(() => fn())
      .then(resolve)
      .catch(reject);
  });
}

// ============================================================================
// Mutation version — the cross-cluster "dirty epoch" counter
// ============================================================================
//
// Bumped after any chunks/file_vectors write so derived views (file_vectors
// lazy-fill checkpoints, file_neighbors fill self-restart) know they are stale.

let fileIndexMutationVersion = 0;

/** Read the current mutation-version epoch. */
export function getMutationVersion(): number {
  return fileIndexMutationVersion;
}

/** Bump the mutation-version epoch. Called after any chunks-table mutation. */
export function markChunksTableMutated(): void {
  fileIndexMutationVersion++;
}

// ============================================================================
// file_neighbors epoch — invalidation for file_vectors-only changes
// ============================================================================
//
// file_neighbors is derived from file_vectors, but not every file_vectors write
// bumps the chunks mutation version: lazy-fill, reconcile, and repair can rewrite
// only the derived file_vectors table. This neighbors-specific epoch lets the
// neighbors checkpoint see those derived-table changes without overloading the
// chunks-table epoch.

let fileNeighborsEpoch = 0;

/** Read the current file_neighbors invalidation epoch. */
export function getFileNeighborsEpoch(): number {
  return fileNeighborsEpoch;
}

/** Bump the file_neighbors invalidation epoch after dependent rows go stale. */
export function markFileNeighborsEpochMutated(): void {
  fileNeighborsEpoch++;
}

// ============================================================================
// Single-flight / checkpoint maps (the C9 <-> C13 <-> C14 background-write substrate)
// ============================================================================

const lastLazyFillCheckpoint = new Map<string, { mutationVersion: number; skipped: number }>();
const lazyFillInFlight = new Map<string, Promise<LazyFillFileVectorsResult>>();

// ----------------------------------------------------------------------------
// Deterministic-failure short-circuit (Layer B / Stage 3)
// ----------------------------------------------------------------------------
//
// A file whose chunk vectors can never produce a file-level vector
// (`recomputeFileVectorRow` → 'skipped': empty_chunks / invalid_vectors /
// mismatched_dimensions) is a *deterministic* failure: re-running the average
// over the SAME chunk inputs yields the same null result. Without a memo, such a
// file is "missing" forever (no row is ever persisted), so the lazy-fill pass
// re-derives it every pass, never reaches `failed===0`, never checkpoints, and
// keeps the file_neighbors master loop re-running — the idle-CPU / log-spam loop.
//
// We record each deterministic failure keyed by the file's CONTENT IDENTITY: the
// chunk fingerprint (source_max_chunk_mtime / indexed_at / enhanced_at /
// chunk_count) that the lazy-fill already projects per file. A pass that sees a
// file whose current fingerprint still matches a recorded failure treats it as
// "known-unfillable" — NOT pending, NOT a fresh failure — so the pass can
// converge and checkpoint. When the file's content changes its fingerprint
// changes (the chunks are re-embedded), the recorded key no longer matches and
// the file is re-attempted. In-memory only (self-heals on restart) by design;
// no persisted schema.
//
//   workspacePath -> (filePath -> chunk-fingerprint key at time of failure)
const deterministicFileVectorFailures = new Map<string, Map<string, string>>();

// ----------------------------------------------------------------------------
// file_neighbors converged checkpoint + deterministic-failure short-circuit
// ----------------------------------------------------------------------------
//
// file_neighbors rows are derived from file_vectors. A workspace whose
// file_vectors projection and neighbor invalidation epoch are unchanged can skip
// the expensive neighbor pass after the mandatory symlink-map rebuild has
// bounded MA3 staleness.
//
// A file whose neighbor row cannot be materialized at the SAME file-vector source
// fingerprint is recorded here so the next pass treats it as "known-unfillable"
// instead of re-running the same ANN/materialization failure forever. The memo is
// keyed by content identity, self-pruned with the live file_vectors projection,
// cleared when the file-vector fingerprint changes, and in-memory only.
//
//   workspacePath -> converged key captured at pass start
const lastFileNeighborsLazyFillCheckpoint = new Map<string, {
  chunksMutationVersion: number;
  fileNeighborsEpoch: number;
  skipped: number;
}>();

//   workspacePath -> (filePath -> file-vector source fingerprint at failure)
const deterministicFileNeighborFailures = new Map<string, Map<string, string>>();

// ----------------------------------------------------------------------------
// One-time NaN-repair attempt memo (Layer C / Stage 4 / FU-4 / FU-4b)
// ----------------------------------------------------------------------------
//
// FU-4 proactively REPAIRS files that are currently unfillable because legacy
// non-finite (NaN) chunk vectors already exist on disk (written before the
// embed-time guard shipped): it purges the corrupt chunk rows and re-indexes the
// file through the normal embed path so it heals under the guard. The re-embed is
// real CPU/GPU work, so it must run AT MOST ONCE per content identity — never
// every pass. This memo is the repair-once gate: a file recorded here is NOT
// repaired again at the same content identity.
//
// FU-4b (at-most-once invariant, MA3): the value is the SET of chunk-fingerprint
// keys this path has been repaired at — both the PRE-repair fingerprint AND the
// POST-repair fingerprint (the re-index bumps indexedAt → a fresh fingerprint).
// Keying only on the pre-repair fingerprint was unsound: a guarded re-index that
// left fresh-but-still-invalid rows would carry a NEW fingerprint the memo did
// not contain, so the file could be re-repaired (and, with a persistently-NaN
// backend, re-repaired every pass — a re-churn loop). Recording the post-repair
// fingerprint too closes that: the file matches the memo on EITHER fingerprint
// and is never re-embedded at an identity it has already been repaired at. Only a
// genuine external content change (which yields a fingerprint in neither set)
// re-opens repair.
//
// Interaction with the deterministic-skip memo (above): on a SUCCESSFUL repair
// the file heals (a file_vectors row is written) and the entry is dropped — the
// next pass sees the row and never revisits it. On a repair that STILL yields an
// unfillable file (e.g. an embedder that returns all-NaN even after re-embed),
// the file falls through to the deterministic-skip memo so it is neither repaired
// nor re-derived again — exactly the convergence the Stage-3 work established.
//
// In-memory only by design (self-heals on restart); pruned in lockstep with the
// live chunk projection so it cannot leak across the workspace's lifetime.
//
//   workspacePath -> (filePath -> set of chunk-fingerprint keys repaired at)
const nanRepairAttempts = new Map<string, Map<string, Set<string>>>();

// ----------------------------------------------------------------------------
// Pending NaN-repair queue (FU-4b / MA1 — the decoupled repair scheduler)
// ----------------------------------------------------------------------------
//
// MA1: the per-pass repair cap was bypassable. Lazy-fill always kicks the
// file-neighbors fill, whose targets each call findSimilarFilesByVector →
// prepareFileVectorsRead → lazyFillFileVectorsIfNeeded REENTRANTLY; an inline
// repair therefore drained another budget's worth of re-embeds per reentry, so a
// large backlog ran back-to-back inside one background run — a sustained re-embed
// sweep, the exact idle-CPU burn this project exists to kill.
//
// FU-4b decouples repair from the read/lazy-fill path entirely. Reads/lazy-fill
// now only DETECT a non-finite file and ENQUEUE its path here (cheap, idempotent —
// never a re-embed). An EXPLICIT, wall-clock-rate-limited, idle-scheduled
// background sweep (its own timer; see vectorsDerive.ts) owns the repair cadence:
// it drains at most K files per real wall-clock window and is NEVER triggered by a
// read/neighbors reentry. The rate cap is therefore robust-by-construction —
// reentrancy can only enqueue, it cannot bypass a wall-clock-scheduled sweep.
//
// In-memory only; pruned in lockstep with the chunk projection (a path that left
// the projection no longer needs repair). Cleared on workspace close.
//
//   workspacePath -> set of file paths awaiting a scheduled repair
const nanRepairPending = new Map<string, Set<string>>();

// ----------------------------------------------------------------------------
// NaN-repair FAILURE tracking + quarantine (FU-4c — bounded retry)
// ----------------------------------------------------------------------------
//
// FU-4c: a path that PERSISTENTLY fails the repair re-index (`failed_after_purge`
// from a full disk / poisoned path / deterministic add failure, or repeated
// `failed_before_purge`) would otherwise stay in `nanRepairPending` and be
// re-read + re-embedded EVERY sweep tick forever (≤25/tick) — a throttled but
// PERPETUAL sustained re-embed loop, the cardinal sin for this project.
//
// This map tracks repair INFRASTRUCTURE failures, kept deliberately SEPARATE from
// the deterministic-skip memo (which means "content is semantically unfillable").
// After a small bounded number of failed attempts the sweep QUARANTINES the path:
// removes it from `nanRepairPending` so the sweep can go quiet, and emits one
// observable structured ERROR for manual / user-triggered recovery. A quarantined
// path is NOT recorded as a deterministic skip — it is an infra failure, not bad
// content. `clearDeterministicVectorSkip` / a content change clears the record so
// recovery re-opens repair.
//
// In-memory only (self-heals on restart); pruned in lockstep with the chunk
// projection and cleared on workspace close.
//
//   workspacePath -> (filePath -> { attempts, lastFailureKind, lastAttemptAt, quarantined })
export type NanRepairFailureKind = 'failed_before_purge' | 'failed_after_purge';
export type NanRepairFailureRecord = {
  attempts: number;
  lastFailureKind: NanRepairFailureKind;
  lastAttemptAt: number;
  quarantined: boolean;
};
const nanRepairFailures = new Map<string, Map<string, NanRepairFailureRecord>>();

const reconcileInFlight = new Map<string, Promise<ReconcileFileVectorsResult>>();
const fileNeighborsLazyFillControllers = new Map<string, AbortController>();
const fileNeighborsLazyFillPromises = new Map<string, Promise<void>>();
const fileNeighborsReconcileInFlight = new Map<string, Promise<ReconcileFileNeighborsResult>>();

/** file_vectors lazy-fill per-workspace skip checkpoint. */
export function getLastLazyFillCheckpoint(): Map<string, { mutationVersion: number; skipped: number }> {
  return lastLazyFillCheckpoint;
}

/** file_vectors lazy-fill single-flight registry. */
export function getLazyFillInFlight(): Map<string, Promise<LazyFillFileVectorsResult>> {
  return lazyFillInFlight;
}

/**
 * file_vectors deterministic-failure memo (Stage 3): per-workspace map of
 * filePath → chunk-fingerprint key recorded at the time the file failed to
 * produce a vector. See the field-level note above for the convergence rationale.
 */
export function getDeterministicFileVectorFailures(): Map<string, Map<string, string>> {
  return deterministicFileVectorFailures;
}

/** file_neighbors lazy-fill converged checkpoint. */
export function getLastFileNeighborsLazyFillCheckpoint(): Map<string, {
  chunksMutationVersion: number;
  fileNeighborsEpoch: number;
  skipped: number;
}> {
  return lastFileNeighborsLazyFillCheckpoint;
}

/**
 * file_neighbors deterministic-failure memo: per-workspace map of filePath →
 * file-vector source fingerprint recorded when a neighbor row failed to
 * materialize. See the field-level note above for the convergence rationale.
 */
export function getDeterministicFileNeighborFailures(): Map<string, Map<string, string>> {
  return deterministicFileNeighborFailures;
}

/**
 * One-time NaN-repair attempt memo (FU-4 / FU-4b): per-workspace map of filePath →
 * SET of chunk-fingerprint keys (pre- and post-repair) the file has been repaired
 * at. The repair-once gate — a file whose current fingerprint matches ANY recorded
 * key is not repaired again at that content identity. See the field-level note
 * above for the at-most-once (MA3) rationale.
 */
export function getNanRepairAttempts(): Map<string, Map<string, Set<string>>> {
  return nanRepairAttempts;
}

/**
 * Pending NaN-repair queue (FU-4b / MA1): per-workspace set of file paths a
 * read/lazy-fill pass detected as needing repair and ENQUEUED. The decoupled,
 * wall-clock-rate-limited repair sweep (vectorsDerive.ts) drains this; reads never
 * repair inline. See the field-level note above for the un-bypassable-bound
 * rationale.
 */
export function getNanRepairPending(): Map<string, Set<string>> {
  return nanRepairPending;
}

/**
 * NaN-repair failure / quarantine tracking (FU-4c): per-workspace map of filePath →
 * {@link NanRepairFailureRecord}. Tracks repair INFRASTRUCTURE failures (distinct
 * from semantically-unfillable content) so the sweep can bound retries and
 * quarantine a persistently-failing path instead of re-embedding it every tick.
 */
export function getNanRepairFailures(): Map<string, Map<string, NanRepairFailureRecord>> {
  return nanRepairFailures;
}

/**
 * MA4 — Stage 4 repair contract. Explicitly invalidate the deterministic
 * "known-unfillable" skip memo so a subsequent lazy-fill pass re-attempts the
 * affected file(s).
 *
 * Why this exists: the deterministic-skip memo key is the chunk fingerprint
 * ({source_max_chunk_mtime, source_max_indexed_at, source_max_enhanced_at,
 * source_chunk_count}). It does NOT encode whether the chunk VECTORS are valid.
 * A repair that rewrites bad chunk vectors in place (preserving mtime / count)
 * makes the file fillable again WITHOUT changing the fingerprint — so the file
 * would stay skipped, and the lazy-fill checkpoint would short-circuit, until
 * an app restart. Any repair path that fixes vectors in place MUST therefore
 * call this (or `markChunksTableMutated()`) so lazy-fill re-attempts the file.
 *
 * This clears the per-file memo entries AND invalidates the workspace's
 * lazy-fill checkpoint (the mutation-version short-circuit would otherwise
 * return before re-reading the projection), guaranteeing the next pass does
 * real work for the cleared paths.
 *
 * @param workspacePath - the workspace whose memo to invalidate.
 * @param paths - specific file paths to clear; when omitted, clears ALL memoed
 *   skips for the workspace.
 */
export function clearDeterministicVectorSkip(
  workspacePath: string,
  paths?: readonly string[],
): void {
  const memo = deterministicFileVectorFailures.get(workspacePath);
  if (memo) {
    if (paths === undefined) {
      memo.clear();
    } else {
      for (const filePath of paths) {
        memo.delete(filePath);
      }
    }
  }

  // Also drop any one-time NaN-repair record for the cleared paths (FU-4), any
  // pending-repair enqueue (FU-4b), AND any repair-failure / quarantine record
  // (FU-4c). A caller clearing the deterministic skip is asserting the file should
  // be re-attempted from scratch; keeping a stale repair-attempt entry would block
  // a fresh repair, a stale pending entry would point the sweep at a path being
  // reset, and a stale quarantine record would keep the path locked out of repair.
  const repairMemo = nanRepairAttempts.get(workspacePath);
  const pending = nanRepairPending.get(workspacePath);
  const failures = nanRepairFailures.get(workspacePath);
  if (paths === undefined) {
    repairMemo?.clear();
    pending?.clear();
    failures?.clear();
  } else {
    for (const filePath of paths) {
      repairMemo?.delete(filePath);
      pending?.delete(filePath);
      failures?.delete(filePath);
    }
  }

  // The checkpoint's mutation-version guard short-circuits the next pass before
  // it re-reads the projection. Drop the checkpoint so the cleared paths are
  // actually revisited regardless of the memo state above.
  lastLazyFillCheckpoint.delete(workspacePath);
}

/** file_vectors reconcile single-flight registry. */
export function getReconcileInFlight(): Map<string, Promise<ReconcileFileVectorsResult>> {
  return reconcileInFlight;
}

/** file_neighbors lazy-fill abort + single-flight controllers. */
export function getFileNeighborsLazyFillControllers(): Map<string, AbortController> {
  return fileNeighborsLazyFillControllers;
}

/** file_neighbors lazy-fill promise registry (also exposed via test seams). */
export function getFileNeighborsLazyFillPromises(): Map<string, Promise<void>> {
  return fileNeighborsLazyFillPromises;
}

/** file_neighbors reconcile single-flight registry. */
export function getFileNeighborsReconcileInFlight(): Map<string, Promise<ReconcileFileNeighborsResult>> {
  return fileNeighborsReconcileInFlight;
}
