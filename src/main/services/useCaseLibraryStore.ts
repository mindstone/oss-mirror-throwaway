/**
 * Use Case Library Store
 *
 * Manages a self-curating library of personalized use cases that evolves
 * toward maximum diversity, quality, and relevance over time.
 *
 * Key features:
 * - Semantic deduplication via embeddings
 * - Quality threshold filtering (85+)
 * - Value-based replacement when at capacity
 * - Usage tracking for engagement-based prioritization
 * - Demo mode support
 *
 * @see docs/plans/finished/251231_use_case_library_self_curating.md
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import type { CallerIntent } from '@core/embeddingGenerator';
import {
  USE_CASE_LIBRARY_STORE_VERSION,
  MAX_USE_CASES,
  USE_CASE_SIMILARITY_THRESHOLD,
  USE_CASE_QUALITY_THRESHOLD,
  USE_CASE_NEW_BADGE_DAYS
} from '../constants';
import { migrateStore, shouldEnterReadOnlyMode, type VersionedData, type MigrationFn } from '../utils/storeMigration';
import { classifyLoadFailure, resolveConfStorePath } from '@core/utils/loadStoreSafely';
import {
  generateEmbedding,
  cosineSimilarity,
  waitForModelReady,
  isEmbeddingServiceReady
} from './embeddingService';

const log = createScopedLogger({ service: 'useCaseLibrary' });

// ============================================================================
// Types
// ============================================================================

/**
 * A use case record in the library with full metadata
 */
export interface UseCaseRecord {
  id: string;
  title: string;
  description: string;
  prompt: string;
  icon: string;
  qualityRating: number;
  embedding: number[];
  generatedAt: number;
  isNew: boolean;
  newUntil: number;
  usageCount: number;
  lastUsedAt: number | null;
  firstUsedAt: number;
  dismissedFromCoach: boolean;
}

/**
 * Store shape for electron-store
 */
interface UseCaseLibraryStoreShape extends VersionedData {
  version: number;
  useCases: UseCaseRecord[];
  lastUpdatedAt: number;
  migrationComplete: boolean;
}

/**
 * Input for adding a new use case candidate
 */
export interface UseCaseCandidate {
  title: string;
  description: string;
  prompt: string;
  icon: string;
  qualityRating: number;
}

/**
 * Result of attempting to add a use case
 */
export interface AddUseCaseResult {
  added: boolean;
  reason: 'added' | 'replaced' | 'too_similar' | 'below_quality' | 'embedding_failed';
  id?: string;
  replacedId?: string;
}

export interface ForceAddUseCaseResult {
  added: boolean;
  id?: string;
}

// ============================================================================
// Default State
// ============================================================================

const createDefaultState = (): UseCaseLibraryStoreShape => ({
  version: USE_CASE_LIBRARY_STORE_VERSION,
  useCases: [],
  lastUpdatedAt: Date.now(),
  migrationComplete: false
});

// ============================================================================
// Migrations
// ============================================================================

const USE_CASE_LIBRARY_MIGRATIONS: Record<number, MigrationFn<UseCaseLibraryStoreShape>> = {
  // No migrations needed yet - store is at version 1
};

// ============================================================================
// Data Normalization
// ============================================================================

const normalizeUseCaseRecord = (record: unknown): UseCaseRecord | null => {
  if (!record || typeof record !== 'object') return null;

  const r = record as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.trim().length === 0) return null;
  if (typeof r.prompt !== 'string' || r.prompt.trim().length === 0) return null;

  const embedding = Array.isArray(r.embedding) 
    ? r.embedding.filter((n): n is number => typeof n === 'number')
    : [];

  return {
    id: r.id as string,
    title: typeof r.title === 'string' ? r.title : 'Untitled',
    description: typeof r.description === 'string' ? r.description : '',
    prompt: r.prompt as string,
    icon: typeof r.icon === 'string' ? r.icon : '✨',
    qualityRating: typeof r.qualityRating === 'number' ? r.qualityRating : 85,
    embedding,
    generatedAt: typeof r.generatedAt === 'number' ? r.generatedAt : Date.now(),
    isNew: typeof r.isNew === 'boolean' ? r.isNew : false,
    newUntil: typeof r.newUntil === 'number' ? r.newUntil : 0,
    usageCount: typeof r.usageCount === 'number' ? r.usageCount : 0,
    lastUsedAt: typeof r.lastUsedAt === 'number' ? r.lastUsedAt : null,
    firstUsedAt: typeof r.firstUsedAt === 'number' ? r.firstUsedAt : Date.now(),
    dismissedFromCoach: typeof r.dismissedFromCoach === 'boolean' ? r.dismissedFromCoach : false,
  };
};

const normalizeStoreShape = (data: unknown): UseCaseLibraryStoreShape => {
  if (!data || typeof data !== 'object') {
    return createDefaultState();
  }

  const d = data as Record<string, unknown>;
  const useCases = Array.isArray(d.useCases)
    ? d.useCases.map(normalizeUseCaseRecord).filter((uc): uc is UseCaseRecord => uc !== null)
    : [];

  return {
    version: typeof d.version === 'number' ? d.version : USE_CASE_LIBRARY_STORE_VERSION,
    useCases,
    lastUpdatedAt: typeof d.lastUpdatedAt === 'number' ? d.lastUpdatedAt : Date.now(),
    migrationComplete: typeof d.migrationComplete === 'boolean' ? d.migrationComplete : false
  };
};

// ============================================================================
// Store Instance
// ============================================================================

let _store: KeyValueStore<UseCaseLibraryStoreShape> | null = null;
const getStore = () => _store ??= createStore<UseCaseLibraryStoreShape>({
  name: 'use-case-library',
  defaults: createDefaultState()
});

let useCaseLibraryReadOnlyMode = false;
// Set true once load/migration has run, so the read-only flag is authoritative.
let _useCaseLibraryMigrationRan = false;

// ============================================================================
// Internal Load/Save
// ============================================================================

const loadInternal = (): UseCaseLibraryStoreShape => {
  try {
    // Pass RAW data to `migrateStore` — do NOT normalize/manufacture a version
    // first. Normalizing ahead of migration stamps the current version onto
    // present-but-unversioned REAL data, hiding it from the hardened Case 2 and
    // leaving it writable so a later save could overwrite it. Let migrateStore
    // classify (empty `{}` → fresh; non-empty version-less → read-only), then
    // normalize.
    const raw = getStore().store;

    const migrationResult = migrateStore(raw as unknown as VersionedData, {
      storeName: 'use-case-library',
      currentVersion: USE_CASE_LIBRARY_STORE_VERSION,
      migrations: USE_CASE_LIBRARY_MIGRATIONS as unknown as Record<number, MigrationFn<VersionedData>>,
      createDefault: createDefaultState as unknown as () => VersionedData,
    });

    useCaseLibraryReadOnlyMode = shouldEnterReadOnlyMode(migrationResult);
    _useCaseLibraryMigrationRan = true;

    const normalized = normalizeStoreShape(migrationResult.data);

    // Persist the normalized/migrated shape only when safe (never for
    // future_version or corrupted — those preserve the on-disk data).
    if (migrationResult.shouldPersist && !useCaseLibraryReadOnlyMode) {
      getStore().store = normalized;
    }

    return normalized;
  } catch (err) {
    // NEVER reset+persist over real on-disk data. Classify ENOENT (fresh init)
    // vs existing-but-unreadable (preserve raw + back up + latch read-only).
    // Set the migration-ran flag so the read-only latch is authoritative for
    // first-touch writers.
    _useCaseLibraryMigrationRan = true;
    const classified = classifyLoadFailure('use-case-library', resolveConfStorePath('use-case-library'), err);
    if (classified.outcome === 'load-failed') {
      useCaseLibraryReadOnlyMode = true;
    }
    return createDefaultState();
  }
};

/**
 * Read-only check that GUARANTEES load/migration has run first. A writer that
 * read the raw `useCaseLibraryReadOnlyMode` as the FIRST touch (no prior read)
 * would see a stale `false` and clobber real, un-migrated data. Use in EVERY
 * writer.
 */
const isUseCaseLibraryReadOnly = (): boolean => {
  if (!_useCaseLibraryMigrationRan) {
    loadInternal();
  }
  return useCaseLibraryReadOnlyMode;
};

const saveInternal = (state: UseCaseLibraryStoreShape): boolean => {
  // Ensure load/migration has run so the flag is authoritative (first-touch-safe;
  // no recursion — load never calls save).
  if (isUseCaseLibraryReadOnly()) {
    log.debug('Use case library store in read-only mode, skipping save');
    return false;
  }

  try {
    getStore().store = state;
    return true;
  } catch (err) {
    log.error({ error: err }, 'Failed to save use case library store');
    return false;
  }
};

// ============================================================================
// Similarity & Value Calculations
// ============================================================================

/**
 * Calculate average similarity of a use case to all others in the library.
 * Only counts comparisons where both embeddings are valid.
 */
const calculateAvgSimilarity = (
  embedding: number[],
  otherUseCases: UseCaseRecord[]
): number => {
  if (otherUseCases.length === 0 || embedding.length === 0) return 0;

  const embeddingArray = new Float32Array(embedding);
  let totalSimilarity = 0;
  let comparisonCount = 0;

  for (const other of otherUseCases) {
    if (other.embedding.length === embedding.length && other.embedding.length > 0) {
      const otherArray = new Float32Array(other.embedding);
      totalSimilarity += cosineSimilarity(embeddingArray, otherArray);
      comparisonCount++;
    }
  }

  // If no valid comparisons, return moderate similarity to avoid distorted scores
  if (comparisonCount === 0) return 0.5;

  return totalSimilarity / comparisonCount;
};

/**
 * Check if a new prompt is too similar to existing use cases
 */
const findMostSimilar = (
  newEmbedding: Float32Array,
  existingUseCases: UseCaseRecord[]
): { maxSimilarity: number; mostSimilarId: string | null } => {
  let maxSimilarity = 0;
  let mostSimilarId: string | null = null;

  for (const existing of existingUseCases) {
    if (existing.embedding.length === newEmbedding.length) {
      const existingArray = new Float32Array(existing.embedding);
      const similarity = cosineSimilarity(newEmbedding, existingArray);
      if (similarity > maxSimilarity) {
        maxSimilarity = similarity;
        mostSimilarId = existing.id;
      }
    }
  }

  return { maxSimilarity, mostSimilarId };
};

/**
 * Calculate value score for a use case (used for replacement decisions)
 */
const calculateValueScore = (uc: UseCaseRecord, allUseCases: UseCaseRecord[]): number => {
  const others = allUseCases.filter(other => other.id !== uc.id);
  const avgSimilarity = calculateAvgSimilarity(uc.embedding, others);
  const diversityScore = 1 - avgSimilarity;

  const ageInDays = Math.max(1, (Date.now() - uc.generatedAt) / (24 * 60 * 60 * 1000));
  const engagementScore = Math.min(1, uc.usageCount / ageInDays);

  const qualityScore = uc.qualityRating / 100;

  return (
    diversityScore * 0.4 +
    engagementScore * 0.4 +
    qualityScore * 0.2
  );
};

/**
 * Find the use case with lowest value score
 */
const findLowestValue = (useCases: UseCaseRecord[]): UseCaseRecord | null => {
  if (useCases.length === 0) return null;

  let lowestValue = Infinity;
  let lowestUseCase: UseCaseRecord | null = null;

  for (const uc of useCases) {
    const value = calculateValueScore(uc, useCases);
    if (value < lowestValue) {
      lowestValue = value;
      lowestUseCase = uc;
    }
  }

  return lowestUseCase;
};

// ============================================================================
// Relevance Scoring
// ============================================================================

/**
 * Score a workflow by how relevant it is to the user right now.
 * Combines usage frequency with recency of last use — a workflow used
 * 3 times this week beats one used 5 times a month ago.
 *
 * Half-life of 14 days: usage weight halves every 2 weeks of inactivity.
 */
const calculateRelevanceScore = (uc: UseCaseRecord, now: number): number => {
  if (uc.usageCount === 0) return 0;

  const daysSinceLastUse = uc.lastUsedAt
    ? (now - uc.lastUsedAt) / (24 * 60 * 60 * 1000)
    : 999;

  const recencyMultiplier = Math.pow(0.5, daysSinceLastUse / 14);
  return uc.usageCount * (0.3 + 0.7 * recencyMultiplier);
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Get all use cases in the library
 */
export const getAllUseCases = (): UseCaseRecord[] => {
  const state = loadInternal();
  return [...state.useCases];
};

/**
 * Get use cases for collapsed display.
 *
 * Ranking strategy (proven value first, discovery second):
 *   1. Frequently-used workflows sorted by relevance score
 *   2. One "new" workflow reserved as a discovery slot (if available)
 *   3. Remaining slots filled by quality-sorted suggestions
 */
export const getUseCasesForDisplay = (limit: number = 3): UseCaseRecord[] => {
  const state = loadInternal();
  const now = Date.now();

  const isActiveNew = (uc: UseCaseRecord) =>
    uc.isNew && uc.newUntil > now && uc.usageCount === 0;

  const available = state.useCases.filter(uc => !uc.dismissedFromCoach);

  const frequent = available
    .filter(uc => uc.usageCount > 0)
    .sort((a, b) => calculateRelevanceScore(b, now) - calculateRelevanceScore(a, now));

  const newOnes = available
    .filter(isActiveNew)
    .sort((a, b) => b.generatedAt - a.generatedAt);

  const suggestions = available
    .filter(uc => uc.usageCount === 0 && !isActiveNew(uc))
    .sort((a, b) => b.qualityRating - a.qualityRating || b.generatedAt - a.generatedAt);

  const result: UseCaseRecord[] = [];
  const used = new Set<string>();

  const pick = (uc: UseCaseRecord) => {
    if (used.has(uc.id)) return false;
    result.push(uc);
    used.add(uc.id);
    return true;
  };

  // Frequent workflows get priority slots
  const discoverySlots = newOnes.length > 0 ? 1 : 0;
  const frequentSlots = Math.min(frequent.length, limit - discoverySlots);
  for (let i = 0; i < frequentSlots; i++) pick(frequent[i]);

  // Reserve one discovery slot for a new workflow
  if (newOnes.length > 0 && result.length < limit) {
    pick(newOnes[0]);
  }

  // Fill remaining with more frequent, then more new, then suggestions
  const overflow = [...frequent, ...newOnes, ...suggestions];
  for (const uc of overflow) {
    if (result.length >= limit) break;
    pick(uc);
  }

  return result.slice(0, limit);
};

/**
 * Get use cases grouped for expanded view.
 *
 * Section priority (matches UI rendering order):
 *   1. frequent — "Your Workflows": proven, sorted by relevance
 *   2. new      — "New": discovery, active new-badge items
 *   3. other    — "Suggestions": unused, sorted by quality
 */
export const getGroupedUseCases = (): {
  new: UseCaseRecord[];
  frequent: UseCaseRecord[];
  other: UseCaseRecord[];
} => {
  const state = loadInternal();
  const now = Date.now();

  const isActiveNew = (uc: UseCaseRecord) =>
    uc.isNew && uc.newUntil > now && uc.usageCount === 0;

  const available = state.useCases.filter(uc => !uc.dismissedFromCoach);

  return {
    frequent: available
      .filter(uc => uc.usageCount > 0)
      .sort((a, b) => calculateRelevanceScore(b, now) - calculateRelevanceScore(a, now))
      .slice(0, 5),
    new: available
      .filter(isActiveNew)
      .sort((a, b) => b.generatedAt - a.generatedAt),
    other: available
      .filter(uc => uc.usageCount === 0 && !isActiveNew(uc))
      .sort((a, b) => b.qualityRating - a.qualityRating || b.generatedAt - a.generatedAt)
  };
};

/**
 * Add a new use case candidate to the library.
 * Handles deduplication, quality filtering, and replacement logic.
 *
 * If embedding generation fails (e.g., service temporarily unavailable),
 * the use case is still saved with an empty embedding. Deduplication
 * is skipped in this case - use cases will be deduplicated on next
 * embedding backfill or when the service recovers.
 *
 * `options.callerIntent` defaults to `background_indexing` to preserve Stage 6
 * active-turn embedder gating for background callers (post-turn generator,
 * automation, dashboard). The in-turn `/usecases/add` bridge handler must pass
 * `foreground_tool` so the call cannot wait on its own active turn
 * (FOX-3331 / Sentry REBEL-5MG, 2026-05-22).
 */
export const addUseCase = async (
  candidate: UseCaseCandidate,
  options?: { callerIntent?: CallerIntent }
): Promise<AddUseCaseResult> => {
  if (candidate.qualityRating < USE_CASE_QUALITY_THRESHOLD) {
    log.debug({ rating: candidate.qualityRating }, 'Use case below quality threshold');
    return { added: false, reason: 'below_quality' };
  }

  let embedding: Float32Array | null = null;
  let embeddingFailed = false;
  try {
    await waitForModelReady();
    const callerIntent = options?.callerIntent ?? 'background_indexing';
    embedding = await generateEmbedding(candidate.prompt, callerIntent);
  } catch (err) {
    log.warn({ error: err }, 'Failed to generate embedding for use case - saving without embedding');
    embeddingFailed = true;
  }

  const state = loadInternal();

  // Only check similarity if we have a valid embedding
  if (embedding && embedding.length > 0) {
    const { maxSimilarity, mostSimilarId } = findMostSimilar(embedding, state.useCases);

    if (maxSimilarity > USE_CASE_SIMILARITY_THRESHOLD) {
      log.debug(
        { maxSimilarity, threshold: USE_CASE_SIMILARITY_THRESHOLD, mostSimilarId },
        'Use case too similar to existing'
      );
      return { added: false, reason: 'too_similar' };
    }
  } else if (!embeddingFailed) {
    // Embedding was generated but is empty/invalid - skip similarity check
    log.debug('Empty embedding generated, skipping similarity check');
  }

  const now = Date.now();
  const newUseCase: UseCaseRecord = {
    id: crypto.randomUUID(),
    title: candidate.title,
    description: candidate.description,
    prompt: candidate.prompt,
    icon: candidate.icon,
    qualityRating: candidate.qualityRating,
    embedding: embedding ? Array.from(embedding) : [],
    generatedAt: now,
    isNew: true,
    newUntil: now + USE_CASE_NEW_BADGE_DAYS * 24 * 60 * 60 * 1000,
    usageCount: 0,
    lastUsedAt: null,
    firstUsedAt: now,
    dismissedFromCoach: false,
  };

  let nextUseCases: UseCaseRecord[];
  let result: AddUseCaseResult;

  if (state.useCases.length < MAX_USE_CASES) {
    nextUseCases = [...state.useCases, newUseCase];
    result = { added: true, reason: 'added', id: newUseCase.id };
    log.info({ id: newUseCase.id, title: newUseCase.title }, 'Added new use case to library');
  } else {
    const lowestValue = findLowestValue(state.useCases);
    if (lowestValue) {
      nextUseCases = state.useCases.filter(uc => uc.id !== lowestValue.id);
      nextUseCases.push(newUseCase);
      result = { added: true, reason: 'replaced', id: newUseCase.id, replacedId: lowestValue.id };
      log.info(
        { newId: newUseCase.id, replacedId: lowestValue.id },
        'Replaced lowest-value use case'
      );
    } else {
      nextUseCases = state.useCases;
      result = { added: false, reason: 'too_similar' };
    }
  }

  const nextState: UseCaseLibraryStoreShape = {
    ...state,
    useCases: nextUseCases,
    lastUpdatedAt: now
  };

  saveInternal(nextState);
  return result;
};

/**
 * Force add a use case (bypasses similarity check, used for daily minimum guarantee)
 */
export const forceAddUseCase = async (candidate: UseCaseCandidate): Promise<ForceAddUseCaseResult> => {
  let embedding: Float32Array;
  try {
    await waitForModelReady();
    embedding = await generateEmbedding(candidate.prompt, 'background_indexing');
  } catch (err) {
    log.error({ error: err }, 'Failed to generate embedding for forced use case');
    return { added: false };
  }

  const state = loadInternal();
  const now = Date.now();

  const newUseCase: UseCaseRecord = {
    id: crypto.randomUUID(),
    title: candidate.title,
    description: candidate.description,
    prompt: candidate.prompt,
    icon: candidate.icon,
    qualityRating: candidate.qualityRating,
    embedding: Array.from(embedding),
    generatedAt: now,
    isNew: true,
    newUntil: now + USE_CASE_NEW_BADGE_DAYS * 24 * 60 * 60 * 1000,
    usageCount: 0,
    lastUsedAt: null,
    firstUsedAt: now,
    dismissedFromCoach: false,
  };

  let nextUseCases: UseCaseRecord[];
  if (state.useCases.length < MAX_USE_CASES) {
    nextUseCases = [...state.useCases, newUseCase];
  } else {
    const lowestValue = findLowestValue(state.useCases);
    if (lowestValue) {
      nextUseCases = state.useCases.filter(uc => uc.id !== lowestValue.id);
      nextUseCases.push(newUseCase);
    } else {
      nextUseCases = [...state.useCases.slice(1), newUseCase];
    }
  }

  const nextState: UseCaseLibraryStoreShape = {
    ...state,
    useCases: nextUseCases,
    lastUpdatedAt: now
  };

  saveInternal(nextState);
  log.info({ id: newUseCase.id, title: newUseCase.title }, 'Force-added use case to library');
  return { added: true, id: newUseCase.id };
};

/**
 * Record usage of a use case
 */
export const recordUseCaseUsage = (id: string): void => {
  const state = loadInternal();
  const index = state.useCases.findIndex(uc => uc.id === id);

  if (index < 0) {
    log.warn({ id }, 'Attempted to record usage for unknown use case');
    return;
  }

  const now = Date.now();
  const updated = {
    ...state.useCases[index],
    usageCount: state.useCases[index].usageCount + 1,
    lastUsedAt: now
  };

  const nextUseCases = [...state.useCases];
  nextUseCases[index] = updated;

  const nextState: UseCaseLibraryStoreShape = {
    ...state,
    useCases: nextUseCases,
    lastUpdatedAt: now
  };

  saveInternal(nextState);
  log.debug({ id, newCount: updated.usageCount }, 'Recorded use case usage');
};

/**
 * Mark a use case as seen (removes "new" badge)
 */
export const markUseCaseSeen = (id: string): void => {
  const state = loadInternal();
  const index = state.useCases.findIndex(uc => uc.id === id);

  if (index < 0) return;

  const updated = {
    ...state.useCases[index],
    isNew: false
  };

  const nextUseCases = [...state.useCases];
  nextUseCases[index] = updated;

  const nextState: UseCaseLibraryStoreShape = {
    ...state,
    useCases: nextUseCases,
    lastUpdatedAt: Date.now()
  };

  saveInternal(nextState);
  log.debug({ id }, 'Marked use case as seen');
};

/**
 * Dismiss a use case from the Coach carousel.
 * Dismissed use cases are excluded from all display queries so the user
 * never sees the same item again after explicitly dismissing it.
 */
export const dismissUseCase = (id: string): void => {
  const state = loadInternal();
  const index = state.useCases.findIndex(uc => uc.id === id);

  if (index < 0) {
    log.warn({ id }, 'Attempted to dismiss unknown use case');
    return;
  }

  const updated = {
    ...state.useCases[index],
    dismissedFromCoach: true,
  };

  const nextUseCases = [...state.useCases];
  nextUseCases[index] = updated;

  const nextState: UseCaseLibraryStoreShape = {
    ...state,
    useCases: nextUseCases,
    lastUpdatedAt: Date.now(),
  };

  saveInternal(nextState);
  log.debug({ id }, 'Dismissed use case from coach');
};

/**
 * Import use cases from settings (one-time migration)
 */
export const importFromSettings = async (
  existingUseCases: Array<{
    id: string;
    title: string;
    description: string;
    prompt: string;
    icon?: string;
    generatedAt?: number;
  }>
): Promise<number> => {
  const state = loadInternal();

  if (state.migrationComplete) {
    log.debug('Migration already complete, skipping import');
    return 0;
  }

  if (existingUseCases.length === 0) {
    const nextState = { ...state, migrationComplete: true };
    saveInternal(nextState);
    return 0;
  }

  let imported = 0;
  const now = Date.now();

  for (const uc of existingUseCases) {
    if (state.useCases.some(existing => existing.id === uc.id)) {
      continue;
    }

    let embedding: number[] = [];
    try {
      if (isEmbeddingServiceReady()) {
        const emb = await generateEmbedding(uc.prompt, 'background_indexing');
        embedding = Array.from(emb);
      }
    } catch {
      log.debug({ id: uc.id }, 'Failed to generate embedding during import, using empty');
    }

    const record: UseCaseRecord = {
      id: uc.id,
      title: uc.title,
      description: uc.description,
      prompt: uc.prompt,
      icon: uc.icon ?? '✨',
      qualityRating: 85,
      embedding,
      generatedAt: uc.generatedAt ?? now,
      isNew: false,
      newUntil: 0,
      usageCount: 0,
      lastUsedAt: null,
      firstUsedAt: uc.generatedAt ?? now,
      dismissedFromCoach: false,
    };

    state.useCases.push(record);
    imported++;
  }

  const nextState: UseCaseLibraryStoreShape = {
    ...state,
    lastUpdatedAt: now,
    migrationComplete: true
  };

  saveInternal(nextState);
  log.info({ imported }, 'Imported use cases from settings');
  return imported;
};

/**
 * Get library statistics
 */
export const getLibraryStats = (): {
  total: number;
  newCount: number;
  usedCount: number;
  avgRating: number;
} => {
  const state = loadInternal();
  const now = Date.now();

  const newCount = state.useCases.filter(uc => uc.isNew && uc.newUntil > now).length;
  const usedCount = state.useCases.filter(uc => uc.usageCount > 0).length;
  const avgRating = state.useCases.length > 0
    ? state.useCases.reduce((sum, uc) => sum + uc.qualityRating, 0) / state.useCases.length
    : 0;

  return {
    total: state.useCases.length,
    newCount,
    usedCount,
    avgRating
  };
};

/**
 * Check if migration from settings is needed
 */
export const needsMigration = (): boolean => {
  const state = loadInternal();
  return !state.migrationComplete;
};
