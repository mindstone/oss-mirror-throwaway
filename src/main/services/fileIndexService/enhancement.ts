/**
 * File Index Service — two-phase enhancement state + chunk getters (Stage D1).
 *
 * Owns the enhancement-progress surface that the enhancementService drives:
 *   - `updateEnhancementState` / `getEnhancementState` (the counter accessors)
 *   - `refreshEnhancementCounts` (recount from the chunks table)
 *   - `getUnenhancedChunks` / `getChunkCounts` (read projections)
 *   - `updateChunkEmbedding` (re-embed a chunk; keeps file_vectors in sync)
 *
 * The mutable `enhancementState` counters live in `./state` (Stage C2); this
 * module reaches them through the `getEnhancementStateRaw` / `setEnhancementState`
 * accessors. The file_vectors write owner (`recomputeFileVectorRow`) and the
 * optimize scheduler (`maybeOptimize`) are imported directly from their sibling
 * modules. The one index.ts-private dependency — `readChunksForFileVector`, the
 * chunk projection shared with the lazy-fill / reconcile paths — is injected via
 * `wireEnhancement(...)`, matching the `optimize.ts` / `fileVectorsWriter.ts`
 * DI precedent so the import graph stays acyclic (index -> enhancement only).
 *
 * Behavior-preserving relocation only: identical write-lock serialization
 * (`updateChunkEmbedding` enters `withWriteLock`, the `*Internal` body trusts the
 * caller holds it), identical ENFILE-cooldown short-circuits, identical schema
 * gating, identical eager file_vectors resync after a chunk re-embed. No logic
 * edits.
 */

import { logger } from '@core/logger';
import { getEmbeddingGenerator } from '@core/embeddingGenerator';
import { getInvalidVectorReason } from '@core/utils/vectorMath';
import { eq } from '../../utils/lancedbPredicates';
import { isTooManyOpenFilesError } from '../../utils/emfileRetry';
import { isEnfileActive, markEnfileDetected } from '../../utils/enfileState';
import { maybeOptimize } from './optimize';
import { recomputeFileVectorRow, type FileVectorSourceChunk } from './fileVectorsWriter';
import {
  getCurrentIndex,
  getEnhancementStateRaw,
  markChunksTableMutated,
  setEnhancementState,
  withWriteLock,
  type EnhancementState,
  type FileEmbeddingRecord,
} from './state';

type LanceDBConnection = Awaited<ReturnType<typeof import('@lancedb/lancedb').connect>>;
type LanceDBTable = Awaited<ReturnType<LanceDBConnection['openTable']>>;

/**
 * Shared dependency owned by index.ts and injected once at module load.
 *
 * - `readChunksForFileVector` — projects a file's chunk rows into the
 *   `FileVectorSourceChunk[]` the writer averages. Shared with the lazy-fill /
 *   reconcile derive paths, so it stays owned by index.ts (Stage D1 leaves the
 *   derive cluster there) and is injected here.
 */
interface EnhancementDeps {
  readChunksForFileVector: (filePath: string) => Promise<FileVectorSourceChunk[]>;
}

let _readChunksForFileVector: EnhancementDeps['readChunksForFileVector'] = async () => [];

/** Inject the shared dependencies owned by index.ts. Called once at module load. */
export function wireEnhancement(deps: EnhancementDeps): void {
  _readChunksForFileVector = deps.readChunksForFileVector;
}

/**
 * Refresh enhancement counts from database and update state
 */
export async function refreshEnhancementCounts(table?: LanceDBTable): Promise<void> {
  const targetTable = table || getCurrentIndex()?.table;
  if (!targetTable) return;

  try {
    const total = await targetTable.countRows();

    // If schema doesn't support enhancement, just update total
    if (!getEnhancementStateRaw().schemaSupportsEnhancement) {
      updateEnhancementState({ totalChunks: total, enhancedChunks: 0 });
      return;
    }

    // Count enhanced chunks (is_enhanced = 1 means enhanced)
    const enhancedResults = await targetTable
      .query()
      .where('is_enhanced = 1')
      .select(['id'])
      .toArray();

    updateEnhancementState({
      totalChunks: total,
      enhancedChunks: enhancedResults.length
    });

    logger.info({ total, enhanced: enhancedResults.length }, 'Refreshed enhancement counts');
  } catch (error) {
    logger.warn({ err: error }, 'Failed to refresh enhancement counts');
  }
}

/**
 * Update enhancement state (called by enhancementService)
 */
export function updateEnhancementState(state: {
  totalChunks?: number;
  enhancedChunks?: number;
  isRunning?: boolean;
  isPaused?: boolean;
  schemaSupportsEnhancement?: boolean;
}): void {
  setEnhancementState({ ...getEnhancementStateRaw(), ...state });
}

/**
 * Get enhancement state (for external access)
 */
export function getEnhancementState(): EnhancementState {
  return { ...getEnhancementStateRaw() };
}

/**
 * Get unenhanced chunks for background processing
 */
export async function getUnenhancedChunks(limit: number): Promise<FileEmbeddingRecord[]> {
  const table = getCurrentIndex()?.table;
  if (!table) return [];
  if (!getEnhancementStateRaw().schemaSupportsEnhancement) return [];  // Schema doesn't support enhancement

  try {
    const results = await table
      .query()
      .where('is_enhanced = 0')
      .select(['id', 'path', 'relativePath', 'content', 'chunkIndex', 'totalChunks'])
      .limit(limit)
      .toArray();
    return results as FileEmbeddingRecord[];
  } catch (error) {
    logger.warn({ err: error }, 'Failed to get unenhanced chunks');
    return [];
  }
}

/**
 * Get total and enhanced chunk counts
 */
export async function getChunkCounts(): Promise<{ total: number; enhanced: number }> {
  const table = getCurrentIndex()?.table;
  if (!table) return { total: 0, enhanced: 0 };

  try {
    const total = await table.countRows();

    // If schema doesn't support enhancement, return total with 0 enhanced
    if (!getEnhancementStateRaw().schemaSupportsEnhancement) {
      return { total, enhanced: 0 };
    }

    // Count enhanced chunks (is_enhanced = 1 means enhanced)
    const enhancedResults = await table
      .query()
      .where('is_enhanced = 1')
      .select(['id'])
      .toArray();

    return { total, enhanced: enhancedResults.length };
  } catch (error) {
    logger.warn({ err: error }, 'Failed to get chunk counts');
    return { total: 0, enhanced: 0 };
  }
}

/**
 * Update a chunk with enhanced embedding
 */
export async function updateChunkEmbedding(
  chunkId: string,
  newVector: number[],
  enhanced_at: number
): Promise<boolean> {
  // Skip during ENFILE cooldown to prevent error storms
  if (isEnfileActive()) {
    return false;
  }
  return withWriteLock(() => updateChunkEmbeddingInternal(chunkId, newVector, enhanced_at));
}

/**
 * Internal: Actual chunk update logic. Called from locked context.
 */
async function updateChunkEmbeddingInternal(
  chunkId: string,
  newVector: number[],
  enhanced_at: number
): Promise<boolean> {
  const table = getCurrentIndex()?.table;
  if (!table) return false;
  if (!getEnhancementStateRaw().schemaSupportsEnhancement) return false;  // Schema doesn't support enhancement

  // Embed-time NaN/dimension guard for the ENHANCEMENT write path (MA1). The
  // contextual-enhancement embedding goes through the exact same GPU/WebGPU
  // backend as initial indexing, so it can produce the same NaN/Inf/zero-norm
  // glitch. Without this guard a corrupt enhanced vector would overwrite the
  // chunk's (possibly-good) basic vector and then poison the file_vectors
  // average — the same corruption the index-path guard (Layer 1) prevents.
  // Validate against the SAME stable per-model dimension (MA2) BEFORE writing.
  // On rejection: do NOT overwrite the existing chunk vector, do NOT bump
  // is_enhanced/enhanced_at, log a counted warning, and return false. The prior
  // chunk vector is left intact.
  const expectedDimension = getEmbeddingGenerator().embeddingDimension;
  const invalidReason = getInvalidVectorReason(newVector, expectedDimension);
  if (invalidReason) {
    logger.warn(
      { chunkId, reason: invalidReason, dimension: newVector.length },
      'embedding.invalid_enhanced_vector'
    );
    return false;
  }

  try {
    await table.update({
      where: eq('id', chunkId),
      values: {
        vector: newVector,
        is_enhanced: 1,  // 1 = enhanced
        enhanced_at
      }
    });

    // Eagerly keep file_vectors in sync with enhancement writes so the
    // materialised file-level view remains usable immediately. If profiling
    // at 25k files shows enhancement cycles thrash this, switch to
    // mark-dirty + recompute-on-next-read.
    const updatedChunkRows = await table
      .query()
      .where(eq('id', chunkId))
      .select(['path'])
      .limit(1)
      .toArray();
    const updatedChunk = updatedChunkRows[0] as { path?: string } | undefined;
    if (updatedChunk?.path) {
      const chunks = await _readChunksForFileVector(updatedChunk.path);
      await recomputeFileVectorRow(updatedChunk.path, chunks);
    }
    markChunksTableMutated();

    // Trigger version cleanup if enough writes have accumulated
    maybeOptimize();

    return true;
  } catch (error) {
    if (isTooManyOpenFilesError(error)) {
      const { isFirstDetection } = markEnfileDetected(error);
      if (isFirstDetection) {
        logger.error('ENFILE: System file descriptor exhaustion detected - file index operations paused for 60s');
      }
      return false;
    }
    logger.warn({ err: error, chunkId }, 'Failed to update chunk embedding');
    return false;
  }
}
