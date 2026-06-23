/**
 * File Index Service — semantic search (Stage D1 extraction).
 *
 * Owns `semanticSearch` (the public entry) and its `semanticSearchVectorOnly`
 * fallback. This is the product's core retrieval surface; it was characterized
 * black-box in Stage A1 before any structural change, and this is a pure
 * behavior-preserving relocation — identical top-k ordering, threshold cutoff,
 * `fileTypes`/`pathPrefix` filtering, hybrid-FTS→vector-only fallback selection
 * (driven by `ftsStatus`), RRF reranking, recency/skill boosts, dedup, and the
 * read-lease acquire/release FD-leak discipline. No logic edits.
 *
 * Dependency shape (acyclic — index → search only): reads the shared
 * `currentIndex` singleton via the `./state` owner, the search-metric recorders
 * from `./contextualRetrieval`, and the scoring helpers from `./documentParsing`.
 * The single piece still owned by `index.ts` is the `loadNativeModule` boundary;
 * that and the embedding generator are reached through ambient imports, not
 * injection, because they have no `index.ts` state dependency. The
 * `SemanticSearchResult` public type is owned here and re-exported by `index.ts`
 * to preserve the consumer import path.
 */

import { logger } from '@core/logger';
import { getEmbeddingGenerator } from '@core/embeddingGenerator';
import { toPortablePath } from '@core/utils/portablePath';
import { loadNativeModule } from '@core/utils/loadNativeModule';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
import { redactAndTruncateRawError } from '@core/utils/redactRawError';
import { eq, likePrefix, or } from '../../utils/lancedbPredicates';
import { isTooManyOpenFilesError } from '../../utils/emfileRetry';
import { markEnfileDetected } from '../../utils/enfileState';
import { calculateRecencyBoost, cosineDistance, isSkillFile } from './documentParsing';
import { recordSearchFailure, recordSearchStart, recordSearchTime } from './contextualRetrieval';
import { getCurrentIndex } from './state';

type LanceDBConnection = Awaited<ReturnType<typeof import('@lancedb/lancedb').connect>>;
type LanceDBTable = Awaited<ReturnType<LanceDBConnection['openTable']>>;

// Skill boost configuration for search results.
// Prioritizes procedural guidance (SKILL.md files) to help users find relevant skills.
const SKILL_BOOST = 0.2; // +20% boost for skill files

// Query-time FTS degradation observability (GAP A, Stage 1.4 of
// docs/plans/260618_semantic-index-error-surfacing/PLAN.md). The two runtime
// fallbacks below (reranker-create / hybrid-query failure) fall back to
// vector-only WITHOUT mutating `ftsStatus` (a per-query error may be a transient
// native blip, not a persistent build failure). Without this they were fully
// silent in telemetry while every query degraded. We capture
// `file_index_fts_degraded` (phase: 'runtime') ONCE per process per failure-site
// (NOT per query — that would flood). A self-contained latch (rather than the
// build-time latch in index.ts) keeps the index→search dependency edge acyclic.
const ftsRuntimeDegradedLatch = new Set<string>();
const semanticSearchFailureLatch = new Set<string>();

/** @internal — unit-test seam: clear the once-per-process runtime FTS latch. */
export function _resetFtsRuntimeDegradedLatchForTesting(): void {
  ftsRuntimeDegradedLatch.clear();
}

/** @internal — unit-test seam: clear the once-per-process semantic-search failure latch. */
export function _resetSemanticSearchFailureLatchForTesting(): void {
  semanticSearchFailureLatch.clear();
}

/**
 * Capture an FTS runtime-degradation known condition at most once per process
 * per (workspace, site). PII-safe: the raw LanceDB error can embed workspace
 * paths, so we capture a synthetic `redactAndTruncateRawError`-scrubbed Error,
 * never the raw one. The per-query `logger.warn` at the call site is unchanged.
 */
function captureFtsRuntimeDegradedOnce(site: 'reranker' | 'query', rawError: unknown): void {
  const workspacePath = getCurrentIndex()?.workspacePath ?? 'unknown';
  const latchKey = `${workspacePath}:runtime:${site}`;
  if (ftsRuntimeDegradedLatch.has(latchKey)) {
    return;
  }
  ftsRuntimeDegradedLatch.add(latchKey);

  const rawMessage = String((rawError as Error | undefined)?.message ?? rawError ?? 'unknown');
  const syntheticError = new Error(
    redactAndTruncateRawError(rawMessage) ?? 'FTS runtime degraded',
  );
  captureKnownCondition('file_index_fts_degraded', { phase: 'runtime' }, syntheticError);
}

/**
 * Capture an unexpected semantic-search failure at most once per process per
 * workspace. Not-ready states are expected cold-start/rebuild conditions and
 * are reported via status only; this capture is reserved for the `error` status.
 */
function captureSemanticSearchFailedOnce(rawError: unknown): void {
  const workspacePath = getCurrentIndex()?.workspacePath ?? 'unknown';
  const latchKey = workspacePath;
  if (semanticSearchFailureLatch.has(latchKey)) {
    return;
  }
  semanticSearchFailureLatch.add(latchKey);

  const rawMessage = String((rawError as Error | undefined)?.message ?? rawError ?? 'unknown');
  const syntheticError = new Error(
    redactAndTruncateRawError(rawMessage) ?? 'semantic search failed',
  );
  captureKnownCondition('file_index_semantic_search_failed', {}, syntheticError);
}

/**
 * Public result shape for `semanticSearch`. Owned here (Stage D1) and re-exported
 * by `index.ts` so the renderer-facing IPC + service consumers keep their import
 * path. Structurally unchanged from the prior inline definition.
 */
export interface SemanticSearchResult {
  path: string;
  relativePath: string;
  snippet: string;
  score: number;
  extension: string;
  chunkIndex: number;
}

/**
 * Discriminated status for file semantic search.
 *
 * Distinguishes genuine no-match (`ok` + empty results) from an index/search
 * backend that is still warming up or unavailable. `semanticSearch()` remains
 * the best-effort `[]` wrapper for legacy/internal callers; user-facing paths
 * that need honest empty-state copy should consume `semanticSearchWithStatus()`.
 * FTS runtime degradation is orthogonal: it still returns `ok` because vector
 * search remains functional and is observed via `file_index_fts_degraded`.
 * Renderer `search:semantic` wiring is intentionally unchanged for this stage:
 * the planning pass found no live renderer consumer that displays those results.
 */
export type FileSearchStatus =
  | 'ok'
  | 'index_not_ready'
  | 'embedding_unavailable'
  | 'error';

export interface FileSearchStatusResult {
  status: FileSearchStatus;
  results: SemanticSearchResult[];
  message?: string;
}

/**
 * The chunk-row projection a search result is shaped from. Defined locally to
 * avoid an import edge back to `index.ts` (matching the `fileVectorsWriter.ts`
 * precedent); structurally a subset of `index.ts`'s `FileEmbeddingRecord`.
 */
type SearchChunkRow = {
  path: string;
  relativePath: string;
  content: string;
  extension: string;
  mtime: number;
  chunkIndex: number;
  vector: number[] | Float32Array;
};

/**
 * Perform hybrid search on the index (LanceDB native FTS + vector with RRF reranking).
 * When FTS indexes are available, uses LanceDB's built-in hybrid search which:
 * - Applies filters to BOTH vector and FTS branches (unlike old BM25 which ignored filters)
 * - Includes FTS-only hits in results (old BM25 dropped them)
 * - Has no in-memory cache or staleness window
 * Falls back to vector-only search when FTS indexes are unavailable.
 */
export async function semanticSearch(
  query: string,
  options: { limit?: number; threshold?: number; fileTypes?: string[]; pathPrefix?: string; lexicalExemption?: boolean } = {}
): Promise<SemanticSearchResult[]> {
  return (await semanticSearchWithStatus(query, options)).results;
}

export async function semanticSearchWithStatus(
  query: string,
  options: { limit?: number; threshold?: number; fileTypes?: string[]; pathPrefix?: string; lexicalExemption?: boolean } = {}
): Promise<FileSearchStatusResult> {
  const startTime = Date.now();
  recordSearchStart();
  const { limit = 10, threshold = 0.3, fileTypes, pathPrefix, lexicalExemption = false } = options;

  // Use readTable for searches to avoid blocking on write operations (file indexing).
  // Fall back to write table if the read handle is not yet initialized.
  // Acquire the read-table lease for the duration of this search so a
  // concurrent writer's swap-and-retire defers the underlying close until
  // we release in finally — this is the half of the FD-leak fix that
  // prevents in-flight reads from being torn down under us.
  //
  // Capture refs synchronously so we can defensively detect a concurrent
  // workspace switch (`currentIndex` reassigned) or `clearIndex` (table
  // nulled) AFTER the await but before we touch the table. Without this
  // null-check, a fresh-workspace bootstrap that briefly has `readTable
  // == null && table != null` could see the write table yanked from
  // under the search — the lease pattern protects the readTable path,
  // but the write-fallback path has no lease, so we fail closed instead.
  const capturedIndex = getCurrentIndex();
  const readHandle = capturedIndex?.readTable ?? null;
  const writeFallbackTable = capturedIndex?.table ?? null;
  const searchTable: LanceDBTable | null = readHandle
    ? readHandle.acquire()
    : writeFallbackTable;
  if (!searchTable) {
    logger.warn('Cannot search: index not initialized');
    return { status: 'index_not_ready', results: [] };
  }

  let embeddingGenerated = false;
  try {
    // Use generateQueryEmbedding for BGE model prefix optimization
    const queryEmbedding = await getEmbeddingGenerator().generateQueryEmbedding(query);
    embeddingGenerated = true;

    // Defensive: when we fell through to the write-fallback path (no read
    // handle, raw `currentIndex.table`), there's no lease protecting us.
    // A concurrent `clearIndex()` between the await above and the actual
    // search query below could pull the rug — fail closed with a structured
    // log per the silent-failure rule. The read-handle path is protected
    // by `acquire()` / `release()` and doesn't need this guard.
    if (!readHandle && (getCurrentIndex() !== capturedIndex || capturedIndex?.table === null)) {
      logger.warn(
        { reason: 'index swapped or cleared during search bootstrap' },
        'Cannot search: write-fallback table no longer valid'
      );
      return { status: 'index_not_ready', results: [] };
    }

    // Build filter predicates (reused by both hybrid and vector-only paths)
    let extensionFilter: string | undefined;
    if (fileTypes && fileTypes.length > 0) {
      extensionFilter = or(...fileTypes.map((t) => eq('extension', `.${t.replace(/^\./, '')}`)));
    }

    let pathPrefixFilter: string | undefined;
    if (pathPrefix) {
      // Normalize to forward slashes for consistent cross-platform matching
      // LanceDB stores relativePath with forward slashes on all platforms
      const normalizedPrefix = toPortablePath(pathPrefix);
      pathPrefixFilter = likePrefix('relativePath', normalizedPrefix);
    }

    // Determine search mode: hybrid (FTS + vector) or vector-only fallback
    const useHybrid = getCurrentIndex()?.ftsStatus === 'ready';
    let rawResults: Array<Record<string, unknown>>;

    if (useHybrid) {
      // --- Hybrid search path: LanceDB native FTS + vector with RRF reranking ---
      const lancedb = loadNativeModule<typeof import('@lancedb/lancedb')>('@lancedb/lancedb');

      const ftsQuery = new lancedb.MultiMatchQuery(query, ['content', 'filename_stem'], {
        boosts: [1.0, 2.0]  // Boost filename matches (matches old BM25 weight ratio)
      });

      let reranker;
      try {
        reranker = await lancedb.rerankers.RRFReranker.create(60);
      } catch (err) {
        // If reranker creation fails, fall back to vector-only
        logger.warn({ err }, 'RRFReranker creation failed — falling back to vector-only search');
        // Surface the runtime degradation once per process (NOT per query).
        captureFtsRuntimeDegradedOnce('reranker', err);
        return {
          status: 'ok',
          results: await semanticSearchVectorOnly(searchTable, queryEmbedding, {
            limit, threshold, extensionFilter, pathPrefixFilter, startTime, query, lexicalExemption
          }),
        };
      }

      let hybridQuery = searchTable
        .query()
        .nearestTo(Array.from(queryEmbedding))
        .distanceType('cosine')
        .fullTextSearch(ftsQuery)
        .rerank(reranker)
        .limit(limit * 3);

      // Filters apply to BOTH vector and FTS branches in hybrid mode
      if (extensionFilter) hybridQuery = hybridQuery.where(extensionFilter);
      if (pathPrefixFilter) hybridQuery = hybridQuery.where(pathPrefixFilter);

      try {
        rawResults = await hybridQuery.toArray() as Array<Record<string, unknown>>;
      } catch (hybridErr) {
        logger.warn({ err: hybridErr }, 'Hybrid search query failed — falling back to vector-only');
        // Surface the runtime degradation once per process (NOT per query).
        captureFtsRuntimeDegradedOnce('query', hybridErr);
        return {
          status: 'ok',
          results: await semanticSearchVectorOnly(searchTable, queryEmbedding, {
            limit, threshold, extensionFilter, pathPrefixFilter, startTime, query, lexicalExemption
          }),
        };
      }

      logger.debug(
        { query, resultCount: rawResults.length, mode: 'hybrid' },
        'Hybrid search raw results'
      );
    } else {
      // --- Vector-only fallback: FTS indexes not ready ---
      return {
        status: 'ok',
        results: await semanticSearchVectorOnly(searchTable, queryEmbedding, {
          limit, threshold, extensionFilter, pathPrefixFilter, startTime, query, lexicalExemption
        }),
      };
    }

    // Build deduped, ranked results from the hybrid rows. The keep-rule lets a
    // genuine lexical hit (query present in relativePath/content) survive the
    // vector-cosine floor when lexicalExemption is enabled — explicit user
    // search ONLY (the same F1 fix as conversationIndexService; see
    // buildFileSearchResults). Auto-context callers leave it default-off so
    // per-turn context stays semantic-strict.
    const results = buildFileSearchResults(
      rawResults,
      query,
      queryEmbedding,
      threshold,
      limit,
      lexicalExemption,
      Date.now(),
    );
    const elapsed = Date.now() - startTime;
    recordSearchTime(elapsed);
    logger.info({ query: query.slice(0, 50), elapsed, resultCount: results.length, mode: 'hybrid' }, 'Search completed');
    return { status: 'ok', results };
  } catch (error) {
    recordSearchFailure();
    const elapsed = Date.now() - startTime;
    recordSearchTime(elapsed);
    if (!embeddingGenerated) {
      logger.debug({ err: error, query }, 'Semantic search: embedding generation unavailable');
      return { status: 'embedding_unavailable', results: [] };
    }
    if (isTooManyOpenFilesError(error)) {
      const { isFirstDetection } = markEnfileDetected(error);
      if (isFirstDetection) {
        logger.error('ENFILE: System file descriptor exhaustion detected - file index operations paused for 60s');
      }
      return { status: 'embedding_unavailable', results: [] };
    }
    const message = redactAndTruncateRawError(
      String((error as Error | undefined)?.message ?? error ?? 'semantic search failed'),
    ) ?? 'semantic search failed';
    captureSemanticSearchFailedOnce(error);
    logger.error({ err: error, query, elapsed }, 'Semantic search failed');
    return { status: 'error', results: [], message };
  } finally {
    // Release the lease so a concurrently-retired handle can finish closing.
    // No-op if we fell back to the write table (no read handle was acquired).
    if (readHandle) {
      try {
        await readHandle.release();
      } catch (err) {
        // Defensive: release is non-throwing by contract, but log per
        // silent-failure rule if the contract is ever violated.
        logger.warn({ err }, 'ReadTableHandle.release threw during semanticSearch finally');
      }
    }
  }
}

/**
 * Vector-only search fallback — used when FTS indexes are unavailable.
 * Preserves the original vector search logic with recency/skill boosts and path dedup.
 */
async function semanticSearchVectorOnly(
  searchTable: LanceDBTable,
  queryEmbedding: Float32Array,
  opts: {
    limit: number;
    threshold: number;
    extensionFilter?: string;
    pathPrefixFilter?: string;
    startTime: number;
    query?: string;
    lexicalExemption?: boolean;
  }
): Promise<SemanticSearchResult[]> {
  const { limit, threshold, extensionFilter, pathPrefixFilter, startTime, query = '', lexicalExemption = false } = opts;
  // Lexical exemption applies here too for parity with the hybrid path, but is a
  // near-no-op in practice: with FTS unavailable the candidate set is pure
  // vector-ANN, so a lexical-but-low-cosine row is rarely retrieved at all.
  const matchesLexically = buildLexicalMatcher(query, lexicalExemption);

  let vectorSearchQuery = searchTable
    .vectorSearch(Array.from(queryEmbedding))
    .distanceType('cosine')
    .limit(limit * 3);

  if (extensionFilter) vectorSearchQuery = vectorSearchQuery.where(extensionFilter);
  if (pathPrefixFilter) vectorSearchQuery = vectorSearchQuery.where(pathPrefixFilter);

  const vectorResults = await vectorSearchQuery.toArray();

  logger.debug(
    { resultCount: vectorResults.length, mode: 'vector-only' },
    'Vector-only search raw results'
  );

  const nowMs = Date.now();
  const seenPaths = new Map<string, SemanticSearchResult & { boostedScore: number }>();

  for (const row of vectorResults) {
    const record = row as unknown as SearchChunkRow & { _distance?: number };
    const distance = record._distance ?? 1;
    const score = 1 - distance;

    // Keep-rule: lexical hit (explicit user search only) OR clears the cosine
    // floor. The keep decision uses the raw cosine; display/ranking use the
    // clamped value below.
    const lexicalHit = matchesLexically(`${record.relativePath ?? ''} ${record.content ?? ''}`);
    if (!lexicalHit && (!Number.isFinite(score) || score < threshold)) {
      continue;
    }

    // Lexical exemption can admit a row whose cosine is below the floor — even
    // negative or NaN (zero/opposing vectors). Clamp to a finite, non-negative
    // value so neither the display score (IPC, `%` strings) nor the ranking
    // sort is corrupted by NaN (mirrors buildFileSearchResults / F1).
    const displayScore = Number.isFinite(score) ? Math.max(0, score) : 0;

    // Apply boosts for ranking
    let boostedScore = displayScore;

    if (Number.isFinite(record.mtime)) {
      boostedScore *= calculateRecencyBoost(record.mtime, nowMs);
    }

    if (isSkillFile(record.relativePath)) {
      boostedScore *= (1 + SKILL_BOOST);
    }

    // Dedup by path: keep the best-scored chunk per file
    const existing = seenPaths.get(record.path);
    if (!existing || boostedScore > existing.boostedScore) {
      seenPaths.set(record.path, {
        path: record.path,
        relativePath: record.relativePath,
        snippet: record.content,
        score: displayScore, // Clamped cosine similarity (0-1)
        extension: record.extension,
        chunkIndex: record.chunkIndex,
        boostedScore
      });
    }
  }

  // Sort by boosted score
  const uniqueResults = Array.from(seenPaths.values());
  uniqueResults.sort((a, b) => b.boostedScore - a.boostedScore);

  // Strip internal boostedScore before returning
  const results: SemanticSearchResult[] = uniqueResults.slice(0, limit).map(({ boostedScore: _, ...rest }) => rest);
  const elapsed = Date.now() - startTime;
  recordSearchTime(elapsed);
  logger.info({ query: 'vector-only', elapsed, resultCount: results.length, mode: 'vector-only' }, 'Search completed');
  return results;
}

/**
 * Conservative lexical-exemption matcher (mirrors the F1 keep-rule in
 * `conversationIndexService.buildConversationResults`). When enabled — explicit
 * user search ONLY — a row whose haystack (relativePath + chunk content)
 * literally contains the query, or all of its punctuation-split tokens, is
 * treated as a genuine keyword/FTS hit and survives the vector-cosine floor.
 *
 * Default OFF so silent auto-context paths (`semanticContextService`, the
 * pre-turn prefetch worker) stay semantic-strict and don't get flooded with
 * low-relevance keyword coincidences on every turn — the regression the F1
 * caller-split was designed to prevent.
 */
function buildLexicalMatcher(query: string, lexicalExemption: boolean): (haystack: string) => boolean {
  if (!lexicalExemption) return () => false;
  const normalizedQuery = query.trim().toLowerCase();
  // Punctuation-aware tokenization (matches F1): split on any non-alphanumeric so
  // `budget?`, `Q2, plan` tokenize cleanly against the lowercased haystack.
  const queryTokens = normalizedQuery.split(/[^a-z0-9]+/).filter(Boolean);
  if (queryTokens.length === 0) return () => false;
  return (haystack: string): boolean => {
    const h = haystack.toLowerCase();
    return h.includes(normalizedQuery) || queryTokens.every((token) => h.includes(token));
  };
}

/**
 * Build deduped, ranked file-search results from raw hybrid (FTS + vector + RRF)
 * rows. Exported for unit testing; structurally mirrors
 * `conversationIndexService.buildConversationResults` (F1/F9 — the same
 * vector-cosine-gate-defeats-FTS bug class in a different subsystem).
 *
 * Keep-rule: a row survives if it clears the cosine floor OR (when
 * `lexicalExemption` is enabled — explicit user search only) the query literally
 * appears in its relativePath/content. Ranking is by boosted RRF (recency + skill
 * boosts). Dedup keeps the best-ranked chunk per path and is order-independent:
 * the first row for a path always registers; a later row replaces it only on a
 * strictly-higher boosted RRF.
 *
 * `_distance` is always null in hybrid mode, so cosine is computed manually from
 * the vectors (identical semantics to `1 - _distance`). `nowMs` is injected for
 * deterministic recency-boost testing.
 */
export function buildFileSearchResults(
  rawResults: Array<Record<string, unknown>>,
  query: string,
  queryEmbedding: Float32Array,
  threshold: number,
  limit: number,
  lexicalExemption: boolean,
  nowMs: number,
): SemanticSearchResult[] {
  const matchesLexically = buildLexicalMatcher(query, lexicalExemption);
  const seenPaths = new Map<string, SemanticSearchResult>();
  const bestRrfByPath = new Map<string, number>();

  for (const row of rawResults) {
    const record = row as unknown as SearchChunkRow & {
      _relevance_score?: number;
      vector: number[] | Float32Array;
    };

    // Compute cosine similarity manually (hybrid returns null _distance).
    const score = 1 - cosineDistance(queryEmbedding, record.vector);
    const lexicalHit = matchesLexically(`${record.relativePath ?? ''} ${record.content ?? ''}`);

    // Keep-rule: lexical hit OR clears the semantic floor (NaN fails the floor).
    if (!lexicalHit && (!Number.isFinite(score) || score < threshold)) {
      continue;
    }

    // Apply boosts to the RRF score for ranking:
    // - Recency boost: promotes recently modified files (acts as "working memory")
    // - Skill boost: promotes procedural guidance (SKILL.md files)
    let rrfScore = record._relevance_score ?? 0;
    let boost = 1.0;
    if (Number.isFinite(record.mtime)) {
      boost *= calculateRecencyBoost(record.mtime, nowMs);
    }
    if (isSkillFile(record.relativePath)) {
      boost *= (1 + SKILL_BOOST);
    }
    rrfScore *= boost;

    // Order-independent dedup: first row for a path always registers; a later
    // row replaces it only with a strictly-higher boosted RRF.
    const existing = bestRrfByPath.get(record.path);
    if (existing !== undefined && existing >= rrfScore) {
      continue;
    }
    bestRrfByPath.set(record.path, rrfScore);
    seenPaths.set(record.path, {
      path: record.path,
      relativePath: record.relativePath,
      snippet: record.content,
      // Display score = cosine, but the lexical exemption can admit a row whose
      // cosine is below the floor — even negative or NaN (zero/opposing vectors).
      // Clamp to a finite, non-negative value (mirrors conversationIndexService
      // F1) so IPC consumers and the `%`-formatted context strings never see a
      // negative or NaN score. Ranking is unaffected (it uses RRF, above).
      score: Number.isFinite(score) ? Math.max(0, score) : 0,
      extension: record.extension,
      chunkIndex: record.chunkIndex,
    });
  }

  // Sort by boosted RRF score for ranking (higher = more relevant).
  const uniqueResults = Array.from(seenPaths.values());
  uniqueResults.sort((a, b) => (bestRrfByPath.get(b.path) ?? 0) - (bestRrfByPath.get(a.path) ?? 0));
  return uniqueResults.slice(0, limit);
}
