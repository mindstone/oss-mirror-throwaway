/**
 * Conversation Index Service
 *
 * Manages semantic indexing of conversation history using LanceDB for vector storage.
 * Enables semantic search to find past conversations by meaning rather than just keywords.
 *
 * Architecture:
 * - One embedding per conversation (title + sampled user messages)
 * - Hybrid search: FTS on title + vector with RRF reranking (vector-only fallback)
 * - Triggered on sessions:save, with startup reconciliation and backfill
 *
 * Exclusions:
 * - Demo mode sessions
 * - Privacy mode sessions
 * - Corrupted sessions
 * - Sessions with no user messages
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import type { AgentSession, AgentSessionSummary } from '@shared/types';
import { getPrimaryMcpAppFallbackTextsFromEvents } from '@shared/utils/mcpAppFallbackText';
import { createScopedLogger } from '@core/logger';
import { getEmbeddingGenerator } from '@core/embeddingGenerator';
import { getDataPath } from '@core/utils/dataPaths';
import { loadNativeModule } from '@core/utils/loadNativeModule';
import { cosineDistance } from './fileIndexService';
import { createPausableInterval, waitForTurnIdle, isAnyTurnActive } from './visibilityAwareScheduler';
import { isTooManyOpenFilesError } from '../utils/emfileRetry';
import { isEnfileActive, markEnfileDetected } from '../utils/enfileState';
import { eq, gte, inAny, isNull, or } from '../utils/lancedbPredicates';
import { countUserMessages, getIncrementalSessionStore } from './incrementalSessionStore';

const log = createScopedLogger({ service: 'conversationIndex' });

// Table and metadata configuration
const TABLE_NAME = 'conversation_embeddings';
const METADATA_FILE = 'index_metadata.json';

// Embedding model name - used for index compatibility tracking
// Bump this to trigger a full reindex when embedding strategy changes
const CURRENT_EMBEDDING_MODEL = 'Xenova/bge-small-en-v1.5-v2';

// Embedding text budget (~1000 tokens = ~4000 chars for BGE)
// Note: Existing embeddings will use this new budget when re-embedded (via stale check or manual re-index)
const MAX_EMBEDDING_TEXT_CHARS = 4000;
const MAX_RECENT_MESSAGE_CHARS = 3000; // Budget for recent user messages

// search_text is stored in the index for FTS but NOT used for vector embeddings.
const MAX_SEARCH_TEXT_CHARS = 12_000;
const MAX_ASSISTANT_TEXT_CHARS = 2_000; // Cap for first assistant response in search_text

// Search over-fetch multiplier: fetch N * multiplier rows from LanceDB before deduplicating
// by sessionId. Without this, duplicate rows for a single session can consume all result
// slots, preventing other sessions from appearing in results.
const SEARCH_OVERFETCH_MULTIPLIER = 3;

// Columns projected for search scoring + result building + the F1 lexical-exemption
// keep-rule. `search_text` lets buildConversationResults detect a genuine keyword/FTS
// hit and keep it even when embedding cosine is below the semantic floor; `updatedAt`/
// `origin` are projected for recency/session-type use. `search_text` never leaves the
// main process (buildConversationResults strips it from the returned shape).
const CONVERSATION_SEARCH_SELECT_COLUMNS = ['sessionId', 'title', 'search_text', 'createdAt', 'updatedAt', 'origin', 'messageCount', 'vector'];

// Re-embedding configuration
const REEMBED_MESSAGE_DELTA_THRESHOLD = 2; // Re-embed if 2+ new messages since last embed
const REEMBED_IDLE_TIME_MS = 5 * 60 * 1000; // Only re-embed if session idle for 5 minutes
const STALE_CHECK_INTERVAL_MS = 5 * 60 * 1000; // Check for stale embeddings every 5 minutes

// Exhaustive-within-window quick search (260620): when the sidebar sends a recency cutoff
// (`updatedAfter`), scope the LanceDB candidate set to the EXACT set of in-window conversations
// using FRESH session-summary timestamps (NOT the lagging index `updatedAt`), so relevance ranks
// over the windowed set rather than a top-N-by-relevance pool. The index `updatedAt` is written
// only at (re-)embed time (gated by REEMBED_*), so filtering on it would silently drop semantic
// matches in lightly-touched-but-old conversations — and deep search is lexical, not a semantic
// backstop. See docs/plans/260620_quick-search-exhaustive-window/PLAN.md.
const RECENCY_SCOPE_MAX_IDS = 500; // above this, an IN-clause allowlist is impractical → grace fallback
const INDEX_LAG_GRACE_MS = 24 * 60 * 60 * 1000; // grace buffer for the >MAX_IDS fallback prefilter ONLY

// LanceDB version cleanup configuration
// LanceDB creates a new version on every write (add/delete/update), which can lead to
// significant storage bloat if not periodically cleaned up via optimize().
// Conversation index has lower write volume than file index, so we use time-based OR
// write-based triggering to ensure cleanup happens even with few writes.
const OPTIMIZE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes minimum between optimizations
const OPTIMIZE_RETENTION_MS = 60 * 60 * 1000; // Keep 1 hour of version history
const OPTIMIZE_AFTER_WRITES = 500; // Trigger optimization after this many writes

function normalizeVectorField(value: unknown): number[] | Float32Array {
  if (value instanceof Float32Array || Array.isArray(value)) {
    return value as number[] | Float32Array;
  }
  if (value && typeof value === 'object') {
    const maybeToArray = (value as { toArray?: () => unknown }).toArray;
    if (typeof maybeToArray === 'function') {
      const arr = maybeToArray.call(value);
      if (arr instanceof Float32Array || Array.isArray(arr)) {
        return arr as number[] | Float32Array;
      }
    }
    const len = (value as { length?: number }).length;
    const getter = (value as { get?: (i: number) => unknown }).get;
    if (typeof len === 'number' && typeof getter === 'function') {
      const out: number[] = new Array(len);
      for (let i = 0; i < len; i++) {
        const v = getter.call(value, i);
        out[i] = typeof v === 'number' ? v : Number(v);
      }
      return out;
    }
  }
  return Array.from(value as Iterable<number>);
}

let lastOptimizeTime = Date.now();
let lastOptimizeAttemptTime = 0; // Tracks attempts to prevent thrashing on failures
let isOptimizing = false;
let writesSinceLastOptimize = 0;
let optimizeFailureCount = 0; // For exponential backoff on repeated failures
let needsOptimization = false; // Flag set by maybeOptimize, consumed by idle scheduler

// Startup optimization timer — stored so we can clear it on close
let startupOptimizeTimer: ReturnType<typeof setTimeout> | null = null;

// Idle optimization scheduler cleanup
let idleOptimizeCleanup: (() => void) | null = null;

// Idle callback injected from index.ts (e.g., () => getActiveTurnCount() === 0)
let isAppIdleFn: (() => boolean) | undefined;

// ============================================================================
// SINGLE-WRITER PATTERN: Serialize all LanceDB mutations to prevent corruption
// ============================================================================
//
// LanceDB write operations (add, delete, update, dropTable, optimize) are not
// thread-safe when called concurrently. This can lead to index corruption
// when onSessionsSaved, backfill, and stale checks race against each other.
//
// Solution: All public mutation functions acquire the write lock via withWriteLock().
// Internal functions (*Internal) do NOT acquire the lock — they trust their caller
// holds it. This prevents deadlock from nested calls like:
//   embedConversation() -> maybeOptimize (sets flag only, no lock needed)
//
// Pattern:
//   export async function embedConversation(...) {
//     return withWriteLock(() => embedConversationInternal(...));
//   }
//   async function embedConversationInternal(...) { /* actual work */ }
// ============================================================================

let writeChain: Promise<void> = Promise.resolve();

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    writeChain = writeChain
      .then(() => fn())
      .then(resolve)
      .catch(reject);
  });
}

// Types
type LanceDBConnection = Awaited<ReturnType<typeof import('@lancedb/lancedb').connect>>;
type LanceDBTable = Awaited<ReturnType<LanceDBConnection['openTable']>>;

export type ConversationEmbeddingRecord = {
  sessionId: string;       // Primary key
  title: string;
  search_text: string;     // All user messages + selective assistant content (FTS-only, not embedded in vectors)
  createdAt: number;
  updatedAt: number;
  origin: string;          // 'manual' | 'automation'
  messageCount: number;
  userMessageCount: number; // Track user messages specifically for re-embed detection
  embeddedAt: number;      // When the embedding was generated
  embeddingModel: string;  // e.g., 'bge-small-en-v1.5' - for schema migration detection
  vector: number[];        // 384 dims (BGE-small)
};

export interface ConversationSearchResult {
  sessionId: string;
  title: string;
  /**
   * Cosine similarity (0-1) to the query embedding. Kept for DISPLAY only
   * (e.g. conversationContextService renders it as a relevance %). Do NOT use
   * for ordering — a genuine keyword/FTS match can have low cosine; use `rankScore`.
   */
  score: number;
  /**
   * Ordering signal. In hybrid mode this is the RRF `_relevance_score` (fuses FTS +
   * vector ranks, so an exact keyword hit ranks appropriately even with low cosine).
   * In vector-only mode it equals `score`. Optional for back-compat with builders
   * (e.g. findSimilar) that don't set it — consumers fall back to `score`.
   */
  rankScore?: number;
  createdAt: number;
  messageCount: number;
}

export type FindSimilarStatus = 
  | 'ok'
  | 'source_not_indexed'
  | 'index_not_ready'
  | 'demo_mode'
  | 'error';

export interface FindSimilarResult {
  results: ConversationSearchResult[];
  status: FindSimilarStatus;
}

/**
 * Discriminated status for conversation search (FOX-3003).
 *
 * Distinguishes a genuine no-match (`ok` + empty results) from a backend that
 * is unavailable or still warming up. The old `searchConversations` collapsed
 * all of {index not initialized, embedding service down, search threw} into an
 * empty array, so the rebel_conversations_search MCP tool reported "No
 * conversations found" even when the backend was down. Callers that need to
 * tell the user the truth (the MCP bridge) consume the status; callers that
 * only want best-effort results keep using `searchConversations`.
 */
export type ConversationSearchStatus =
  | 'ok'
  | 'index_not_ready'
  | 'embedding_unavailable'
  | 'error';

export interface ConversationSearchStatusResult {
  results: ConversationSearchResult[];
  status: ConversationSearchStatus;
}

export interface ConversationIndexMetadata {
  embeddingModel: string;
  createdAt: number;
  lastReconcileAt: number;
  lastIndexedAt: number;          // Timestamp of most recent embedding
  metadataVersion?: number;       // For one-time migrations (e.g., dedupe)
}

export interface ConversationIndexStatus {
  totalEmbeddings: number;
  lastIndexedAt: number | null;
  lastReconcileAt: number | null;
  isInitialized: boolean;
  embeddingModel: string;
  indexedSessionIds: string[];  // List of session IDs that have embeddings
}

interface ConversationIndex {
  connection: LanceDBConnection;
  table: LanceDBTable | null;
  metadata: ConversationIndexMetadata;
  embeddedSessionIds: Set<string>;  // Cache for fast lookup
  embeddedUserMessageCounts: Map<string, number>; // Cache userMessageCount for stale detection
  embeddedTitles: Map<string, string>; // Cache indexed title to detect renames (F3) without a query
  rawRowCount: number;  // Total rows from init scan (includes duplicates) — used by dedup fast-path
  ftsReady: boolean;  // Whether FTS index on title is available for hybrid search
}

let currentIndex: ConversationIndex | null = null;

/**
 * Live count of open LanceDB connections held by the conversation index (0 or
 * 1 — a single `currentIndex.connection`). LanceDB is a native Rust addon that
 * holds connection handles + an async runtime, so a nonzero count at quit time
 * is a teardown-thread suspect for the residual macOS quit-deadlock.
 * Synchronous, allocation-free read for the native-liveness snapshot (see
 * `nativeLivenessSnapshot.ts`).
 */
export function getConversationLanceLiveConnectionCount(): number {
  return currentIndex ? 1 : 0;
}

// Stale-check once-per-launch full-verification flag (declared before the test seam that resets it)
let staleEmbeddingsFullVerificationCompleted = false;

/**
 * Test seam: inject a (possibly partial) conversation index so search/status
 * paths past the null-index guard can be exercised without a real LanceDB
 * connection. Pass `null` to reset. Production code never calls this.
 */
export function _setConversationIndexForTesting(index: Partial<ConversationIndex> | null): void {
  currentIndex = index as ConversationIndex | null;
  staleEmbeddingsFullVerificationCompleted = false;
}

// Backfill state
let isBackfillRunning = false;
let backfillAborted = false;

// Per-session in-flight guard to prevent race conditions during concurrent embedding
const inFlightEmbeddings = new Set<string>();

// Stale embedding check interval (visibility-aware)
let staleCheckCleanup: (() => void) | null = null;

// Metadata version for schema migrations (bump when adding new migrations).
// Version 2: backfill search_text field for existing rows.
// Dedup no longer uses this — it runs unconditionally on every startup.
const CURRENT_METADATA_VERSION = 2;

/**
 * Get the storage directory for conversation index (global, not per-workspace)
 */
function getIndexStorageDir(): string {
  return path.join(getDataPath(), 'indices', 'global', 'conversations');
}

/**
 * Get the LanceDB storage directory
 */
function getLanceDBDir(): string {
  return path.join(getIndexStorageDir(), 'lancedb');
}

/**
 * Get the metadata file path
 */
function getMetadataPath(): string {
  return path.join(getIndexStorageDir(), METADATA_FILE);
}

/**
 * Load metadata from disk
 */
async function loadMetadata(): Promise<ConversationIndexMetadata> {
  const metadataPath = getMetadataPath();
  try {
    const data = await fs.readFile(metadataPath, 'utf-8');
    return JSON.parse(data) as ConversationIndexMetadata;
  } catch {
    return {
      embeddingModel: CURRENT_EMBEDDING_MODEL,
      createdAt: Date.now(),
      lastReconcileAt: 0,
      lastIndexedAt: 0,
    };
  }
}

/**
 * Save metadata to disk
 */
async function saveMetadata(metadata: ConversationIndexMetadata): Promise<void> {
  const metadataPath = getMetadataPath();
  const storageDir = getIndexStorageDir();
  await fs.mkdir(storageDir, { recursive: true });
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
}

/**
 * Ensure FTS indices exist on the `title` and `search_text` columns.
 * Creates them if missing, with per-index error handling so one failure
 * doesn't prevent the other from being created. Verifies via listIndices()
 * after creation (catches silent failures from camelCase naming or other issues).
 *
 * Returns true if at least the `title` FTS index is available (minimum
 * viable for hybrid search), false otherwise.
 */
async function ensureConversationFTSIndex(table: LanceDBTable): Promise<boolean> {
  try {
    const lancedb = loadNativeModule<typeof import('@lancedb/lancedb')>('@lancedb/lancedb');
    const indices = await table.listIndices();
    const indexedColumns = new Set(indices.map(i => i.columns[0]));

    // Title FTS index
    let titleFtsReady = indexedColumns.has('title');
    if (!titleFtsReady) {
      try {
        log.info({ column: 'title' }, 'Creating FTS index');
        await table.createIndex('title', {
          config: lancedb.Index.fts({ stem: true, lowercase: true })
        });
        titleFtsReady = true;
      } catch (err) {
        log.error({ err, column: 'title' }, 'Failed to create FTS index');
      }
    }

    // search_text FTS index (snake_case avoids LanceDB camelCase FTS footgun)
    if (!indexedColumns.has('search_text')) {
      try {
        log.info({ column: 'search_text' }, 'Creating FTS index');
        await table.createIndex('search_text', {
          config: lancedb.Index.fts({ stem: true, lowercase: true })
        });
      } catch (err) {
        log.error({ err, column: 'search_text' }, 'Failed to create FTS index');
      }
    }

    // Post-create verification: re-list indices and confirm columns are present
    if (titleFtsReady) {
      const verifyIndices = await table.listIndices();
      const verifyColumns = new Set(verifyIndices.map(i => i.columns[0]));
      if (!verifyColumns.has('title')) {
        log.error(
          { column: 'title', actualColumns: [...verifyColumns] },
          'FTS index creation appeared to succeed but index not found in listIndices',
        );
        titleFtsReady = false;
      }
    }

    if (titleFtsReady) {
      log.info('Conversation FTS index ready');
    } else {
      log.error('Title FTS index not available — search will use vector-only fallback');
    }

    return titleFtsReady;
  } catch (error) {
    log.error({ err: error }, 'Failed to check/create conversation FTS indices — search will use vector-only fallback');
    return false;
  }
}

/**
 * Check if a session should be embedded
 */
export function shouldEmbedSession(session: AgentSession): boolean {
  // Skip corrupted sessions
  if (session.isCorrupted) {
    return false;
  }

  // Skip privacy mode sessions
  if (session.privateMode) {
    return false;
  }

  // NOTE (F7): automation sessions ARE indexed now, so the sidebar "Automations" filter +
  // search box works. They remain segregated at query time by the renderer's session-type
  // filter (origin), so they don't pollute the default Conversations search. Privacy-mode,
  // corrupted, deleted, and no-user-message exclusions below still apply to automations.

  // Skip sessions with no user messages
  const hasUserMessage = session.messages.some(m => m.role === 'user');
  if (!hasUserMessage) {
    return false;
  }

  // Skip soft-deleted sessions (in trash)
  if (session.deletedAt) {
    return false;
  }

  return true;
}

/**
 * Check if a session summary indicates eligibility for embedding using lightweight metadata.
 * Avoids loading full session data when the summary has enough information.
 * Returns false to skip, true to proceed (may still need full session check if hasUserMessages is undefined).
 */
export function shouldEmbedSummary(summary: AgentSessionSummary): boolean {
  if (summary.isCorrupted) return false;
  if (summary.privateMode) return false;
  // F7: automations are indexed (searchable under the Automations filter); see shouldEmbedSession.
  if (summary.deletedAt) return false;
  if (summary.hasUserMessages === false) return false;
  return true;
}

/**
 * Wait for app to be idle (no active agent turns) before proceeding with background work.
 * Returns true if idle (or timed out), false if backfill abort was requested during wait.
 *
 * Stage 6 (260508): unified on the `waitForTurnIdle` primitive (F15) so this
 * shares the active-turn signal with file-indexer and embedder gating instead
 * of polling a callback every second.
 */
async function waitForIdle(maxWaitMs = 30_000): Promise<boolean> {
  if (backfillAborted) return false;
  // Honour the legacy callback path when no callback was ever injected (e.g.
  // tests that don't wire it). The new primitive is the canonical signal.
  if (isAppIdleFn) {
    if (isAppIdleFn()) return true;
  } else if (!isAnyTurnActive()) {
    return true;
  }

  const result = await waitForTurnIdle(undefined, maxWaitMs);
  if (backfillAborted) return false;
  if (result === 'timeout') {
    log.debug('Backfill idle wait timed out, proceeding');
  }
  return !backfillAborted;
}

/**
 * Build full-text search content from a session.
 * Includes all non-hidden user messages (chronological) + first non-hidden assistant response (capped).
 * For a primary MCP App on that first assistant turn, also includes viewSummary and structured plaintext fallback.
 * Stored in the `search_text` column for FTS indexing — NOT used for vector embeddings.
 *
 * Budget: MAX_SEARCH_TEXT_CHARS total, with assistant text capped at MAX_ASSISTANT_TEXT_CHARS.
 */
export function buildSearchText(session: AgentSession): string {
  const parts: string[] = [];
  let budget = MAX_SEARCH_TEXT_CHARS;

  // 1. All non-hidden user messages (chronological order)
  for (const msg of session.messages) {
    if (msg.role !== 'user' || msg.isHidden || !msg.text || budget <= 0) continue;
    const text = msg.text.slice(0, budget);
    parts.push(text);
    budget -= text.length + 2; // +2 for \n\n separator
  }

  // 2. First non-hidden assistant response (capped at MAX_ASSISTANT_TEXT_CHARS)
  if (budget > 0) {
    const firstAssistant = session.messages.find((m) => {
      if (m.role !== 'assistant' || m.isHidden) return false;
      if (m.text) return true;
      return getPrimaryMcpAppFallbackTextsFromEvents(session.eventsByTurn?.[m.turnId]).length > 0;
    });
    if (firstAssistant?.text) {
      const text = firstAssistant.text.slice(0, Math.min(MAX_ASSISTANT_TEXT_CHARS, budget));
      parts.push(text);
      budget -= text.length + 2;
    }

    if (firstAssistant && budget > 0) {
      const fallbackText = getPrimaryMcpAppFallbackTextsFromEvents(
        session.eventsByTurn?.[firstAssistant.turnId],
      ).join('\n\n');
      if (fallbackText) {
        const text = fallbackText.slice(0, budget);
        parts.push(text);
      }
    }
  }

  return parts.join('\n\n');
}

/**
 * Extract text to embed from a session.
 * Strategy: title + first user message (context) + recent user messages (current discussion)
 * This captures both "what the conversation is about" and "what we're currently discussing"
 */
function getEmbeddingText(session: AgentSession): string {
  const parts: string[] = [];
  let charBudget = MAX_EMBEDDING_TEXT_CHARS;

  // 1. Title (always include)
  if (session.title) {
    parts.push(session.title);
    charBudget -= session.title.length + 2; // +2 for separator
  }

  // 2. First user message (establishes context)
  const userMessages = session.messages.filter(m => m.role === 'user' && m.text);
  const firstUserMsg = userMessages[0]?.text?.slice(0, 500);
  if (firstUserMsg) {
    parts.push(firstUserMsg);
    charBudget -= firstUserMsg.length + 2;
  }

  // 3. Recent user messages (fill remaining budget from the end)
  // Skip the first message if we already included it
  const recentMessages = userMessages.slice(1).reverse();
  let recentBudget = Math.min(charBudget, MAX_RECENT_MESSAGE_CHARS);
  const recentParts: string[] = [];

  for (const msg of recentMessages) {
    if (!msg.text || recentBudget <= 0) break;
    const text = msg.text.slice(0, recentBudget);
    recentParts.unshift(text); // Maintain chronological order
    recentBudget -= text.length + 2;
  }

  if (recentParts.length > 0) {
    parts.push(...recentParts);
  }

  return parts.filter(Boolean).join('\n\n');
}

/**
 * Run LanceDB optimize to clean up old versions and reduce storage bloat.
 * Internal version — must be called from within the write lock.
 */
async function optimizeIndexInternal(): Promise<void> {
  const index = currentIndex;
  if (!index?.table || isOptimizing) return;

  isOptimizing = true;
  lastOptimizeAttemptTime = Date.now();
  const startTime = Date.now();

  try {
    const stats = await index.table.optimize({
      cleanupOlderThan: new Date(Date.now() - OPTIMIZE_RETENTION_MS)
    });

    lastOptimizeTime = Date.now();
    writesSinceLastOptimize = 0;
    needsOptimization = false;
    optimizeFailureCount = 0; // Reset backoff on success

    log.info({
      versionsRemoved: stats.prune?.oldVersionsRemoved ?? 0,
      elapsedMs: Date.now() - startTime
    }, 'Conversation index optimization completed');
  } catch (err) {
    optimizeFailureCount++;
    log.warn({ err, failureCount: optimizeFailureCount }, 'Conversation index optimization failed');
  } finally {
    isOptimizing = false;
  }
}

/**
 * Run LanceDB optimize — public entry point that acquires the write lock.
 */
async function optimizeIndex(): Promise<void> {
  return withWriteLock(() => optimizeIndexInternal());
}

/**
 * Signal that optimization may be needed.
 * Called from within Internal mutation functions (already under write lock).
 * Does NOT run optimize inline — just sets a flag for the idle scheduler.
 */
function maybeOptimize(): void {
  writesSinceLastOptimize++;

  const enoughWrites = writesSinceLastOptimize >= OPTIMIZE_AFTER_WRITES;
  const enoughTime = Date.now() - lastOptimizeTime >= OPTIMIZE_INTERVAL_MS && writesSinceLastOptimize > 0;

  if (enoughWrites || enoughTime) {
    needsOptimization = true;
  }
}

/**
 * Initialize the conversation index
 */
export async function initializeConversationIndex(options?: {
  isAppIdle?: () => boolean;
}): Promise<void> {
  // Always update the idle callback if provided, even if index already exists.
  // This handles the case where embedConversation/onSessionsSaved lazily initializes
  // the index before index.ts passes the isAppIdle callback.
  if (options?.isAppIdle) {
    isAppIdleFn = options.isAppIdle;
  }

  if (currentIndex) {
    return;
  }

  const storageDir = getIndexStorageDir();
  const lanceDBDir = getLanceDBDir();
  await fs.mkdir(lanceDBDir, { recursive: true });

  log.info({ storageDir }, 'Initializing conversation index');

  // Load metadata
  const metadata = await loadMetadata();

  // Check if embedding model changed - requires full reindex
  if (metadata.embeddingModel && metadata.embeddingModel !== CURRENT_EMBEDDING_MODEL) {
    log.info(
      { oldModel: metadata.embeddingModel, newModel: CURRENT_EMBEDDING_MODEL },
      'Embedding model changed, clearing conversation index for full reindex'
    );
    await fs.rm(lanceDBDir, { recursive: true, force: true });
    await fs.mkdir(lanceDBDir, { recursive: true });
    metadata.embeddingModel = CURRENT_EMBEDDING_MODEL;
    metadata.lastReconcileAt = 0;
    await saveMetadata(metadata);
  }

  // Connect to LanceDB
  const lancedb = loadNativeModule<typeof import('@lancedb/lancedb')>('@lancedb/lancedb');
  const connection = await lancedb.connect(lanceDBDir);

  let table: LanceDBTable | null = null;
  const tableNames = await connection.tableNames();

  if (tableNames.includes(TABLE_NAME)) {
    table = await connection.openTable(TABLE_NAME);
    log.info({ tableName: TABLE_NAME }, 'Opened existing conversation index table');

    // Schema upgrade: add search_text column if missing (tables created before FTS enhancement).
    // Without this, table.add() rejects records that include search_text, and the migration v2
    // backfill also fails. Uses addColumns (same pattern as fileIndexService filename_stem).
    try {
      const tableSchema = await table.schema();
      const fieldNames = new Set(tableSchema.fields.map((f: { name: string }) => f.name));

      if (!fieldNames.has('search_text')) {
        log.info('Adding missing search_text column to conversation index (schema upgrade)');
        try {
          await table.addColumns([{ name: 'search_text', valueSql: "''" }]);
        } catch (addErr) {
          // addColumns failed — table may be corrupted or incompatible. Drop and rebuild.
          log.warn({ err: addErr }, 'Failed to add search_text column — clearing index for full reindex');
          await connection.dropTable(TABLE_NAME);
          table = null;
        }
      }
    } catch (schemaErr) {
      // schema() failed — transient I/O or LanceDB error. Log but don't destroy the table;
      // embedding attempts will fail individually and the user keeps their existing index.
      log.warn({ err: schemaErr }, 'Failed to read conversation index schema for upgrade check');
    }
  }

  // Build cache of embedded session IDs and user message counts
  const embeddedSessionIds = new Set<string>();
  const embeddedUserMessageCounts = new Map<string, number>();
  const embeddedTitles = new Map<string, string>();
  let rawRowCount = 0;
  if (table) {
    try {
      const results = await table
        .query()
        .select(['sessionId', 'userMessageCount', 'title'])
        .toArray();

      rawRowCount = results.length;
      for (const row of results) {
        const record = row as { sessionId: string; userMessageCount?: number; title?: string };
        embeddedSessionIds.add(record.sessionId);
        // userMessageCount may be undefined for old records (before this field existed)
        if (typeof record.userMessageCount === 'number') {
          embeddedUserMessageCounts.set(record.sessionId, record.userMessageCount);
        }
        if (typeof record.title === 'string') {
          embeddedTitles.set(record.sessionId, record.title);
        }
      }

      log.info({ embeddedCount: embeddedSessionIds.size, rawRowCount }, 'Loaded embedded session IDs cache');
    } catch (err) {
      log.warn({ err }, 'Failed to load embedded session IDs');
    }
  }

  // Create FTS index on title column for hybrid search
  let ftsReady = false;
  if (table) {
    ftsReady = await ensureConversationFTSIndex(table);
  }

  currentIndex = {
    connection,
    table,
    metadata,
    embeddedSessionIds,
    embeddedUserMessageCounts,
    embeddedTitles,
    rawRowCount,
    ftsReady,
  };

  // Signal that startup optimization is needed to clean up accumulated version bloat.
  // Deferred to the idle scheduler to avoid LanceDB FFI blocking during active turns.
  if (table) {
    startupOptimizeTimer = setTimeout(() => {
      needsOptimization = true;
    }, 5000); // Delay 5s, then let idle scheduler pick it up
  }

  // Start idle optimization scheduler — polls every 60s, runs optimize when idle
  startIdleOptimizeScheduler();
}

/**
 * Start the idle optimization scheduler.
 * Polls every 60s: if optimization is needed and the app is idle, runs optimize via the write lock.
 */
function startIdleOptimizeScheduler(): void {
  if (idleOptimizeCleanup) return; // Already running

  const IDLE_OPTIMIZE_POLL_MS = 60_000; // 60 seconds

  idleOptimizeCleanup = createPausableInterval(async () => {
    if (!needsOptimization || isOptimizing) return;

    // Stage 6: skip when any agent turn is active. Falls back to the legacy
    // callback path when one is wired (preserves test wiring); otherwise reads
    // the registry signal directly via `isAnyTurnActive`.
    if (isAppIdleFn ? !isAppIdleFn() : isAnyTurnActive()) return;

    // Respect exponential backoff on failures
    if (optimizeFailureCount > 0) {
      const backoffMs = Math.min(
        Math.pow(2, optimizeFailureCount) * 30000,
        OPTIMIZE_INTERVAL_MS // Cap at normal interval
      );
      if (Date.now() - lastOptimizeAttemptTime < backoffMs) return;
    }

    await optimizeIndex();
  }, IDLE_OPTIMIZE_POLL_MS, { pauseOnBlur: true, catchUpPriority: 3 });

  log.debug('Started idle optimization scheduler (60s poll)');
}

/**
 * Close the conversation index
 */
export async function closeConversationIndex(): Promise<void> {
  staleEmbeddingsFullVerificationCompleted = false;

  // Clear startup optimize timer
  if (startupOptimizeTimer) {
    clearTimeout(startupOptimizeTimer);
    startupOptimizeTimer = null;
  }

  // Clear idle optimization scheduler
  if (idleOptimizeCleanup) {
    idleOptimizeCleanup();
    idleOptimizeCleanup = null;
  }

  // Clear stale check interval
  if (staleCheckCleanup) {
    staleCheckCleanup();
    staleCheckCleanup = null;
  }
  
  if (currentIndex) {
    try {
      currentIndex.connection.close();
    } catch (err) {
      log.warn({ err }, 'Error closing LanceDB connection');
    }
    currentIndex = null;
    log.info('Conversation index closed');
  }
}

/**
 * Check if a session is already embedded
 */
export function isSessionEmbedded(sessionId: string): boolean {
  return currentIndex?.embeddedSessionIds.has(sessionId) ?? false;
}

/**
 * Embed a single conversation — internal version, must be called from within the write lock.
 */
async function embedConversationInternal(session: AgentSession): Promise<boolean> {
  // Skip during ENFILE cooldown to prevent error storms
  if (isEnfileActive()) {
    return false;
  }

  if (!currentIndex) {
    await initializeConversationIndex();
  }

  if (!currentIndex) {
    throw new Error('Failed to initialize conversation index');
  }

  // Validate session
  if (!shouldEmbedSession(session)) {
    log.debug({ sessionId: session.id, title: session.title }, 'Session not eligible for embedding');
    return false;
  }

  // Skip if already embedded
  if (currentIndex.embeddedSessionIds.has(session.id)) {
    log.debug({ sessionId: session.id }, 'Session already embedded');
    return false;
  }

  // Per-session in-flight guard to prevent race conditions
  // (e.g., backfill and reconcile running concurrently on same session)
  if (inFlightEmbeddings.has(session.id)) {
    log.debug({ sessionId: session.id }, 'Session embedding already in progress');
    return false;
  }

  inFlightEmbeddings.add(session.id);
  try {
    // Double-check after acquiring the guard (another call may have completed)
    if (currentIndex.embeddedSessionIds.has(session.id)) {
      log.debug({ sessionId: session.id }, 'Session already embedded (after guard)');
      return false;
    }

    const embeddingText = getEmbeddingText(session);
    const embedding = await getEmbeddingGenerator().generateEmbedding(embeddingText, 'background_indexing');
    const userMsgCount = countUserMessages(session);

    const record: ConversationEmbeddingRecord = {
      sessionId: session.id,
      title: session.title,
      search_text: buildSearchText(session),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      origin: session.origin ?? 'manual',
      messageCount: session.messages.length,
      userMessageCount: userMsgCount,
      embeddedAt: Date.now(),
      embeddingModel: CURRENT_EMBEDDING_MODEL,
      vector: Array.from(embedding)
    };

    if (!currentIndex.table) {
      currentIndex.table = await currentIndex.connection.createTable(TABLE_NAME, [record]);
      log.info({ tableName: TABLE_NAME }, 'Created conversation index table');
      // Create FTS index on the new table
      currentIndex.ftsReady = await ensureConversationFTSIndex(currentIndex.table);
    } else {
      await currentIndex.table.add([record]);
    }

    currentIndex.embeddedSessionIds.add(session.id);
    currentIndex.embeddedUserMessageCounts.set(session.id, userMsgCount);
    currentIndex.embeddedTitles.set(session.id, session.title);
    currentIndex.metadata.lastIndexedAt = Date.now();
    log.debug({ sessionId: session.id, title: session.title, userMsgCount }, 'Embedded conversation');
    maybeOptimize();
    return true;
  } catch (error) {
    if (isTooManyOpenFilesError(error)) {
      const { isFirstDetection } = markEnfileDetected(error);
      if (isFirstDetection) {
        log.error('ENFILE: System file descriptor exhaustion detected - conversation index operations paused for 60s');
      }
      return false;
    }
    log.warn({ err: error, sessionId: session.id }, 'Failed to embed conversation');
    return false;
  } finally {
    inFlightEmbeddings.delete(session.id);
  }
}

/**
 * Embed a single conversation — public entry point that acquires the write lock.
 */
export async function embedConversation(session: AgentSession): Promise<boolean> {
  return withWriteLock(() => embedConversationInternal(session));
}

/**
 * Remove a conversation from the index — internal version, must be called from within the write lock.
 */
async function removeConversationInternal(sessionId: string): Promise<void> {
  if (!currentIndex?.table) {
    return;
  }

  try {
    await currentIndex.table.delete(eq('sessionId', sessionId));
    currentIndex.embeddedSessionIds.delete(sessionId);
    currentIndex.embeddedUserMessageCounts.delete(sessionId);
    currentIndex.embeddedTitles.delete(sessionId);
    log.debug({ sessionId }, 'Removed conversation from index');
    maybeOptimize();
  } catch (error) {
    if (isTooManyOpenFilesError(error)) {
      const { isFirstDetection } = markEnfileDetected(error);
      if (isFirstDetection) {
        log.error('ENFILE: System file descriptor exhaustion detected - conversation index operations paused for 60s');
      }
      return;
    }
    log.warn({ err: error, sessionId }, 'Failed to remove conversation from index');
  }
}

/**
 * Remove a conversation from the index — public entry point that acquires the write lock.
 */
export async function removeConversation(sessionId: string): Promise<void> {
  return withWriteLock(() => removeConversationInternal(sessionId));
}

/**
 * Re-embed a conversation (delete existing + create new embedding).
 * Internal version — must be called from within the write lock.
 */
async function reembedConversationInternal(session: AgentSession): Promise<boolean> {
  if (!currentIndex?.table) {
    return false;
  }

  // Validate session is still eligible
  if (!shouldEmbedSession(session)) {
    return false;
  }

  // Use in-flight guard to prevent concurrent re-embeds
  if (inFlightEmbeddings.has(session.id)) {
    log.debug({ sessionId: session.id }, 'Re-embed already in progress');
    return false;
  }

  inFlightEmbeddings.add(session.id);
  try {
    // Generate new embedding FIRST (before deleting old) to avoid data loss on failure
    const embeddingText = getEmbeddingText(session);
    const embedding = await getEmbeddingGenerator().generateEmbedding(embeddingText, 'background_indexing');
    const userMsgCount = countUserMessages(session);

    const record: ConversationEmbeddingRecord = {
      sessionId: session.id,
      title: session.title,
      search_text: buildSearchText(session),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      origin: session.origin ?? 'manual',
      messageCount: session.messages.length,
      userMessageCount: userMsgCount,
      embeddedAt: Date.now(),
      embeddingModel: CURRENT_EMBEDDING_MODEL,
      vector: Array.from(embedding)
    };

    // Now delete existing and add new (embedding generation succeeded)
    await currentIndex.table.delete(eq('sessionId', session.id));

    await currentIndex.table.add([record]);
    currentIndex.embeddedSessionIds.add(session.id);
    currentIndex.embeddedUserMessageCounts.set(session.id, userMsgCount);
    currentIndex.embeddedTitles.set(session.id, session.title);
    currentIndex.metadata.lastIndexedAt = Date.now();

    log.debug({ sessionId: session.id, title: session.title, userMsgCount }, 'Re-embedded conversation');
    maybeOptimize();
    return true;
  } catch (error) {
    if (isTooManyOpenFilesError(error)) {
      const { isFirstDetection } = markEnfileDetected(error);
      if (isFirstDetection) {
        log.error('ENFILE: System file descriptor exhaustion detected - conversation index operations paused for 60s');
      }
      return false;
    }
    log.warn({ err: error, sessionId: session.id }, 'Failed to re-embed conversation');
    return false;
  } finally {
    inFlightEmbeddings.delete(session.id);
  }
}

/**
 * Re-embed a conversation — public entry point that acquires the write lock.
 */
export async function reembedConversation(session: AgentSession): Promise<boolean> {
  return withWriteLock(() => reembedConversationInternal(session));
}

/**
 * Check if a session's embedding is stale and should be re-embedded.
 * Criteria: 3+ new user messages since last embed AND session has been idle for 5+ minutes
 */
function isEmbeddingStale(session: AgentSession): boolean {
  if (!currentIndex) return false;

  const embeddedUserMsgCount = currentIndex.embeddedUserMessageCounts.get(session.id);
  if (embeddedUserMsgCount === undefined) {
    // No userMessageCount tracked (old record) - conservative: don't re-embed
    return false;
  }

  const currentUserMsgCount = countUserMessages(session);
  const messageDelta = currentUserMsgCount - embeddedUserMsgCount;

  // Check if enough new messages
  if (messageDelta < REEMBED_MESSAGE_DELTA_THRESHOLD) {
    return false;
  }

  // Check if session has been idle (no updates in last 5 minutes)
  const lastUpdate = session.updatedAt ?? session.createdAt ?? Date.now();
  const idleTime = Date.now() - lastUpdate;

  return idleTime >= REEMBED_IDLE_TIME_MS;
}

/**
 * Perform semantic search on conversations using hybrid search (FTS on title + vector + RRF)
 * with vector-only fallback when FTS is unavailable.
 *
 * Best-effort variant: collapses every failure mode to an empty array. Use this
 * for in-app callers (context enrichment, IPC search UI) that only want results
 * and treat unavailability as "no results". For the MCP/bridge path that must
 * tell the user the truth, use {@link searchConversationsWithStatus} instead.
 */
export async function searchConversations(
  query: string,
  options: ConversationSearchOptions = {}
): Promise<ConversationSearchResult[]> {
  return (await searchConversationsWithStatus(query, options)).results;
}

/**
 * @property lexicalExemption — when true, a genuine keyword/FTS hit (query appears in
 * title/search_text) is retained even if its embedding cosine is below `threshold`.
 * **Default false (strict semantic).** Enable ONLY for explicit user-driven search
 * (sidebar search box, the `rebel_conversations_search` agent tool) — NOT for silent
 * auto-context-injection, which must stay semantic-strict so a mere keyword coincidence
 * doesn't inject a low-relevance conversation into every turn's context.
 */
export interface ConversationSearchOptions {
  limit?: number;
  threshold?: number;
  lexicalExemption?: boolean;
  /**
   * When set, scope the search to conversations last active at/after this timestamp (ms) so
   * quick search is EXHAUSTIVE within the active recency window — relevance ranks over the
   * windowed set, not a top-N-by-relevance pool. The window is resolved from FRESH session
   * summaries (see {@link resolveRecencyScope}), not the lagging index `updatedAt`.
   */
  updatedAfter?: number;
}

/**
 * LanceDB recency scope for exhaustive-within-window quick search.
 * - `none`: no recency cutoff → no `.where()` (default 'All time' behavior, unchanged).
 * - `empty`: cutoff set but ZERO conversations in window → return [] without querying.
 * - `allowlist`: exact in-window set (≤ {@link RECENCY_SCOPE_MAX_IDS}) → `sessionId IN (...)`;
 *   `limit` is the in-window count so the search returns the WHOLE windowed set ranked by
 *   relevance (this is what makes it exhaustive AND lets the renderer's session-type filter
 *   operate over the complete in-window set instead of a top-100-by-relevance prefix).
 * - `grace`: too many in-window IDs for an IN clause → grace-buffered prefilter on the
 *   (lagging) index `updatedAt`; the renderer's fresh-timestamp post-filter is the precise boundary.
 */
export type RecencyScope =
  | { kind: 'none' }
  | { kind: 'empty' }
  | { kind: 'allowlist'; predicate: string; limit: number }
  | { kind: 'grace'; predicate: string };

/**
 * Pure scope builder (no I/O — caller supplies the fresh in-window session IDs), so the
 * windowing policy is unit-testable without a LanceDB table or a session store.
 */
export function buildRecencyScope(
  updatedAfter: number | undefined,
  inWindowSessionIds: string[],
): RecencyScope {
  if (updatedAfter === undefined) return { kind: 'none' };
  const count = inWindowSessionIds.length;
  if (count === 0) return { kind: 'empty' };
  if (count <= RECENCY_SCOPE_MAX_IDS) {
    return { kind: 'allowlist', predicate: inAny('sessionId', inWindowSessionIds), limit: count };
  }
  return {
    kind: 'grace',
    predicate: or(gte('updatedAt', updatedAfter - INDEX_LAG_GRACE_MS), isNull('updatedAt')),
  };
}

/** Grace-buffered fallback prefilter on the (lagging) index `updatedAt`. */
function graceScope(updatedAfter: number): RecencyScope {
  return {
    kind: 'grace',
    predicate: or(gte('updatedAt', updatedAfter - INDEX_LAG_GRACE_MS), isNull('updatedAt')),
  };
}

/**
 * Resolve the recency scope for a search call: read the FRESH in-window session IDs from the
 * session store (the authoritative full set — the renderer's lazy-loaded summaries may be a
 * subset, so we must NOT compute the allowlist there) and apply the windowing policy. Mirrors
 * the index's eligibility by excluding deleted/private/corrupted sessions (which are never
 * embedded) so the count and IN-clause stay tight. Degrades OBSERVABLY to the grace-buffered
 * index prefilter — never to un-windowed results (which would reintroduce the top-N-overall
 * truncation bug) and never to a false no-match (which would hide every in-window match) — on:
 *  - `listSessions()` throwing, OR
 *  - `listSessions()` returning ZERO summaries. `listSessions()` can return `[]` WITHOUT
 *    throwing on a transient index-read degrade (no `.bak` available), so an empty list is
 *    treated as possibly-unavailable rather than "genuinely empty window". A genuinely empty
 *    store yields an empty grace query too, so this fallback is safe in the no-conversations case.
 */
function resolveRecencyScope(updatedAfter: number | undefined): RecencyScope {
  if (updatedAfter === undefined) return { kind: 'none' };
  let summaries: ReturnType<ReturnType<typeof getIncrementalSessionStore>['listSessions']>;
  try {
    summaries = getIncrementalSessionStore().listSessions();
  } catch (err) {
    log.warn(
      { err, updatedAfter },
      'Recency scope: fresh session list unavailable — degrading to grace-buffered index prefilter (quick search may miss stale-indexed in-window matches; "Search all messages" lexical fallback is unaffected)',
    );
    return graceScope(updatedAfter);
  }
  if (summaries.length === 0) {
    // Zero summaries: either a genuinely empty store OR the transient-degrade `[]` return.
    // We can't tell them apart here, so degrade to grace (which still queries) instead of a
    // short-circuit no-match. Safe either way: an empty store yields an empty grace query.
    log.warn(
      { updatedAfter },
      'Recency scope: session summary list is empty (genuinely empty store or a transient index-read degrade) — using grace-buffered index prefilter rather than a short-circuit no-match',
    );
    return graceScope(updatedAfter);
  }
  const inWindowIds = summaries
    .filter(
      (s) =>
        !s.deletedAt &&
        !s.privateMode &&
        !s.isCorrupted &&
        (s.updatedAt ?? s.createdAt ?? 0) >= updatedAfter,
    )
    .map((s) => s.id);
  const scope = buildRecencyScope(updatedAfter, inWindowIds);
  if (scope.kind === 'grace') {
    log.warn(
      { inWindowCount: inWindowIds.length, max: RECENCY_SCOPE_MAX_IDS, updatedAfter },
      'Recency scope: too many in-window conversations for an exact allowlist — using grace-buffered index prefilter (a stale-indexed in-window match may be missed; "Search all messages" lexical fallback is unaffected)',
    );
  }
  return scope;
}

/**
 * Status-returning conversation search (FOX-3003).
 *
 * Distinguishes a genuine no-match (`ok` + empty results) from an unavailable
 * backend (`index_not_ready` / `embedding_unavailable`) and unexpected failures
 * (`error`). The MCP bridge uses this to surface "temporarily unavailable"
 * instead of a misleading "No conversations found".
 */
export async function searchConversationsWithStatus(
  query: string,
  options: ConversationSearchOptions = {}
): Promise<ConversationSearchStatusResult> {
  const { limit = 10, threshold = 0.3, lexicalExemption = false, updatedAfter } = options;

  if (!query || query.trim().length === 0) {
    return { status: 'ok', results: [] };
  }

  if (!currentIndex?.table) {
    log.debug('Cannot search: conversation index not initialized');
    return { status: 'index_not_ready', results: [] };
  }

  // Exhaustive-within-window scope (260620): when the sidebar sends a recency cutoff, restrict
  // the LanceDB candidate set to the EXACT set of in-window conversations (fresh timestamps),
  // so relevance ranks over the windowed set. `none` adds no `.where()` (unchanged default).
  const scope = resolveRecencyScope(updatedAfter);
  if (scope.kind === 'empty') {
    // Recency window active but no conversations fall inside it — a genuine no-match.
    return { status: 'ok', results: [] };
  }
  const recencyPredicate = scope.kind === 'allowlist' || scope.kind === 'grace' ? scope.predicate : null;
  // On the exact-allowlist path the effective limit is the in-window count, so the search
  // returns the WHOLE windowed set ranked by relevance; otherwise the caller's display limit.
  const effectiveLimit = scope.kind === 'allowlist' ? scope.limit : limit;

  // The search embeds the query first, so an embedding outage means the search
  // cannot run at all. We detect that from the embedding call itself throwing
  // (tracked via `embeddingGenerated`) and surface it as embedding_unavailable
  // rather than a no-match. We deliberately do NOT import embeddingService here:
  // its static graph pulls electron into the agentTurnExecutor entrypoint
  // (validate:transitive-electron-deps). getEmbeddingGenerator() is the detached
  // factory accessor used everywhere else in this file.
  let embeddingGenerated = false;
  try {
    const queryEmbedding = await getEmbeddingGenerator().generateQueryEmbedding(query);
    embeddingGenerated = true;

    let rawResults: Array<Record<string, unknown>>;
    let isHybrid = false;

    if (currentIndex.ftsReady) {
      // Hybrid search: FTS on title + search_text + vector + RRF reranking
      const lancedb = loadNativeModule<typeof import('@lancedb/lancedb')>('@lancedb/lancedb');
      const ftsQuery = new lancedb.MultiMatchQuery(query, ['title', 'search_text']);

      let reranker;
      try {
        reranker = await lancedb.rerankers.RRFReranker.create(60);
      } catch (err) {
        log.warn({ err }, 'RRFReranker creation failed — conversation search falling back to vector-only');
        return { status: 'ok', results: await searchConversationsVectorOnly(query, queryEmbedding, effectiveLimit, threshold, lexicalExemption, recencyPredicate) };
      }

      try {
        // Recency scope (`.where()`) applies to BOTH the FTS and vector branches in hybrid mode,
        // so an out-of-window lexical-only hit is excluded too.
        let hybridQuery = currentIndex.table
          .query()
          .nearestTo(Array.from(queryEmbedding))
          .distanceType('cosine')
          .fullTextSearch(ftsQuery)
          .select(CONVERSATION_SEARCH_SELECT_COLUMNS)
          .rerank(reranker);
        if (recencyPredicate) hybridQuery = hybridQuery.where(recencyPredicate);
        rawResults = await hybridQuery
          .limit(effectiveLimit * SEARCH_OVERFETCH_MULTIPLIER)
          .toArray() as Array<Record<string, unknown>>;
        isHybrid = true;
      } catch (hybridErr) {
        log.warn({ err: hybridErr }, 'Hybrid conversation search failed — falling back to vector-only');
        return { status: 'ok', results: await searchConversationsVectorOnly(query, queryEmbedding, effectiveLimit, threshold, lexicalExemption, recencyPredicate) };
      }
    } else {
      // Vector-only fallback (existing behavior)
      let vectorQuery = currentIndex.table
        .vectorSearch(Array.from(queryEmbedding))
        .distanceType('cosine')
        .select(CONVERSATION_SEARCH_SELECT_COLUMNS);
      if (recencyPredicate) vectorQuery = vectorQuery.where(recencyPredicate);
      rawResults = await vectorQuery
        .limit(effectiveLimit * SEARCH_OVERFETCH_MULTIPLIER)
        .toArray() as Array<Record<string, unknown>>;
    }

    return {
      status: 'ok',
      results: buildConversationResults(rawResults, query, queryEmbedding, threshold, effectiveLimit, isHybrid, lexicalExemption),
    };
  } catch (error) {
    if (!embeddingGenerated) {
      // The embedding step failed before any search ran → backend unavailable, not a no-match.
      log.debug({ err: error, query }, 'Conversation search: embedding generation unavailable');
      return { status: 'embedding_unavailable', results: [] };
    }
    if (isTooManyOpenFilesError(error)) {
      const { isFirstDetection } = markEnfileDetected(error);
      if (isFirstDetection) {
        log.error('ENFILE: System file descriptor exhaustion detected - conversation index operations paused for 60s');
      }
      // FD exhaustion is a transient backend-unavailable condition, not a no-match.
      return { status: 'embedding_unavailable', results: [] };
    }
    log.error({ err: error, query }, 'Conversation search failed');
    return { status: 'error', results: [] };
  }
}

/**
 * Vector-only conversation search fallback.
 * Used when FTS is unavailable or hybrid search fails.
 */
async function searchConversationsVectorOnly(
  query: string,
  queryEmbedding: Float32Array,
  limit: number,
  threshold: number,
  lexicalExemption: boolean,
  recencyPredicate: string | null = null,
): Promise<ConversationSearchResult[]> {
  if (!currentIndex?.table) return [];
  let vectorQuery = currentIndex.table
    .vectorSearch(Array.from(queryEmbedding))
    .distanceType('cosine')
    .select(CONVERSATION_SEARCH_SELECT_COLUMNS);
  if (recencyPredicate) vectorQuery = vectorQuery.where(recencyPredicate);
  const rawResults = await vectorQuery
    .limit(limit * SEARCH_OVERFETCH_MULTIPLIER)
    .toArray() as Array<Record<string, unknown>>;
  return buildConversationResults(rawResults, query, queryEmbedding, threshold, limit, false, lexicalExemption);
}

/**
 * Build final search results from raw LanceDB rows.
 *
 * Keep-rule (F1): a row is retained if it is a genuine **lexical/keyword hit**
 * (the query, or all its tokens, appear in `title`/`search_text`) OR its embedding
 * cosine similarity clears the semantic `threshold`. The old code applied a
 * vector-only cosine floor to ALL hybrid rows, which silently discarded exact
 * keyword/title matches the FTS half had surfaced and RRF had ranked highly. A
 * genuine no-match (no lexical hit AND nothing clears the floor) still returns []
 * so callers can distinguish zero-results from an unavailable backend.
 *
 * The lexical check is a deliberately conservative approximation of LanceDB FTS
 * (plain case-insensitive substring, no stemming) — it under-exempts rather than
 * over-exempts, which is the safe direction for the "I searched the exact thing"
 * complaint.
 *
 * Ranking uses `rankScore` (RRF `_relevance_score` in hybrid mode; cosine in
 * vector-only mode), so lexical hits with low cosine still rank where FTS+RRF put
 * them. `score` stays cosine for display/percentage callers. Dedup keeps the
 * best-ranked row per sessionId across ALL candidate rows (order-independent),
 * replacing the previous first-seen-wins-before-threshold logic that could drop a
 * later, higher-scoring row of the same session.
 */
export function buildConversationResults(
  rawResults: Array<Record<string, unknown>>,
  query: string,
  queryEmbedding: Float32Array,
  threshold: number,
  limit: number,
  isHybrid: boolean,
  lexicalExemption: boolean = false,
): ConversationSearchResult[] {
  const normalizedQuery = query.trim().toLowerCase();
  // Punctuation-aware tokenization: split on any non-alphanumeric so `Penny?`, `budget, Q2`,
  // `Acme.` tokenize to clean terms that substring-match the haystack (LanceDB FTS is
  // lowercased/stemmed, so the old whitespace/hyphen split was too tight for ordinary
  // punctuation and could still drop a low-cosine keyword hit).
  const queryTokens = normalizedQuery.split(/[^a-z0-9]+/).filter(Boolean);

  // Best surviving row per sessionId, ranked by rankScore (order-independent dedup).
  const bestBySession = new Map<string, { result: ConversationSearchResult; rankScore: number }>();

  for (const row of rawResults) {
    const record = row as unknown as ConversationEmbeddingRecord & {
      _distance?: number;
      _relevance_score?: number;
    };

    // Cosine similarity: hybrid mode has _distance === null, so compute manually;
    // vector-only mode uses 1 - _distance for parity with previous behavior.
    const cosineScore = isHybrid
      ? 1 - cosineDistance(queryEmbedding, record.vector)
      : 1 - (record._distance ?? 1);

    // Lexical evidence (only when exemption is enabled — explicit user search, NOT silent
    // auto-context-injection): query (or all tokens) present in title/search_text.
    const haystack = `${record.title ?? ''} ${record.search_text ?? ''}`.toLowerCase();
    const lexicalHit =
      lexicalExemption &&
      queryTokens.length > 0 &&
      (haystack.includes(normalizedQuery) || queryTokens.every((token) => haystack.includes(token)));

    // Keep-rule: lexical hit OR clears the semantic floor.
    if (!lexicalHit && (!Number.isFinite(cosineScore) || cosineScore < threshold)) continue;

    // Ranking: in hybrid mode use RRF `_relevance_score` (small scale, ~1/(60+rank)); fall
    // back to 0 (NOT cosine — cosine 0.3-1.0 would dwarf real RRF scores and corrupt
    // ordering/dedup within the result set). Vector-only mode ranks by cosine.
    const rankScore = isHybrid
      ? (Number.isFinite(record._relevance_score) ? (record._relevance_score as number) : 0)
      : cosineScore;
    const displayScore = Number.isFinite(cosineScore) ? Math.max(0, cosineScore) : 0;

    const existing = bestBySession.get(record.sessionId);
    if (existing && existing.rankScore >= rankScore) continue;

    bestBySession.set(record.sessionId, {
      rankScore,
      result: {
        sessionId: record.sessionId,
        title: record.title,
        score: displayScore,
        rankScore,
        createdAt: record.createdAt,
        messageCount: record.messageCount,
      },
    });
  }

  const results = Array.from(bestBySession.values())
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, limit)
    .map((entry) => entry.result);

  log.debug({ resultCount: results.length, isHybrid }, 'Conversation search completed');
  return results;
}

/**
 * Find conversations similar to a given session
 */
export async function findSimilarConversations(
  sessionId: string,
  options: { limit?: number; threshold?: number } = {}
): Promise<FindSimilarResult> {
  const { limit = 5, threshold = 0.3 } = options;

  if (!currentIndex?.table) {
    log.debug('Cannot find similar: conversation index not initialized');
    return { results: [], status: 'index_not_ready' };
  }

  try {
    // Get the embedding for the source session
    const sourceResults = await currentIndex.table
      .query()
      .where(eq('sessionId', sessionId))
      .limit(1)
      .toArray();

    if (sourceResults.length === 0) {
      log.debug({ sessionId }, 'Source session not found in index');
      return { results: [], status: 'source_not_indexed' };
    }

    const sourceRecord = sourceResults[0] as unknown as ConversationEmbeddingRecord;
    const sourceEmbedding = sourceRecord.vector;

    // Over-fetch to account for source session + duplicate sessionId rows, then dedupe + trim
    const results = await currentIndex.table
      .vectorSearch(sourceEmbedding)
      .distanceType('cosine')
      .limit((limit + 1) * SEARCH_OVERFETCH_MULTIPLIER)
      .toArray();

    const searchResults: ConversationSearchResult[] = [];
    const seenSessionIds = new Set<string>();

    for (const row of results) {
      const record = row as unknown as ConversationEmbeddingRecord & { _distance?: number };
      
      // Exclude the source session from results
      if (record.sessionId === sessionId) {
        continue;
      }

      // Deduplicate by sessionId (keep first/highest score)
      if (seenSessionIds.has(record.sessionId)) {
        continue;
      }
      seenSessionIds.add(record.sessionId);

      const distance =
        typeof record._distance === 'number' && Number.isFinite(record._distance)
          ? record._distance
          : cosineDistance(
              normalizeVectorField(sourceEmbedding),
              normalizeVectorField(record.vector),
            );
      const score = 1 - distance;

      if (!Number.isFinite(score) || score < threshold) {
        continue;
      }

      searchResults.push({
        sessionId: record.sessionId,
        title: record.title,
        score,
        createdAt: record.createdAt,
        messageCount: record.messageCount
      });

      // Stop once we have enough results (excluding source)
      if (searchResults.length >= limit) {
        break;
      }
    }

    log.debug({ sessionId, resultCount: searchResults.length }, 'Find similar conversations completed');
    return { results: searchResults, status: 'ok' };
  } catch (error) {
    if (isTooManyOpenFilesError(error)) {
      const { isFirstDetection } = markEnfileDetected(error);
      if (isFirstDetection) {
        log.error('ENFILE: System file descriptor exhaustion detected - conversation index operations paused for 60s');
      }
      return { results: [], status: 'error' };
    }
    log.error({ err: error, sessionId }, 'Find similar conversations failed');
    return { results: [], status: 'error' };
  }
}

/**
 * Reconcile embeddings with current sessions - remove orphans.
 * Internal version — must be called from within the write lock.
 */
async function reconcileEmbeddingsInternal(validSessionIds: Set<string>): Promise<number> {
  if (!currentIndex?.table) {
    return 0;
  }

  try {
    // Find orphaned embeddings
    const orphanedIds: string[] = [];
    for (const embeddedId of currentIndex.embeddedSessionIds) {
      if (!validSessionIds.has(embeddedId)) {
        orphanedIds.push(embeddedId);
      }
    }

    if (orphanedIds.length === 0) {
      log.debug('No orphaned conversation embeddings found');
      return 0;
    }

    // Remove orphans — call internal version (already under write lock)
    for (const sessionId of orphanedIds) {
      await removeConversationInternal(sessionId);
    }

    // Update metadata
    currentIndex.metadata.lastReconcileAt = Date.now();
    await saveMetadata(currentIndex.metadata);

    log.info({ removedCount: orphanedIds.length }, 'Reconciled conversation embeddings');
    return orphanedIds.length;
  } catch (error) {
    log.error({ err: error }, 'Failed to reconcile conversation embeddings');
    return 0;
  }
}

/**
 * Reconcile embeddings with current sessions — public entry point that acquires the write lock.
 */
export async function reconcileEmbeddings(validSessionIds: Set<string>): Promise<number> {
  return withWriteLock(() => reconcileEmbeddingsInternal(validSessionIds));
}

/**
 * Check for stale embeddings and re-embed sessions that have changed significantly.
 * Called periodically (every 5 minutes) to catch sessions that have grown since initial embed.
 *
 * Uses session summaries from the in-memory index for lightweight filtering,
 * then loads full sessions on-demand only for candidates that need re-embedding.
 * This avoids retaining the full AgentSession[] array in memory between checks.
 */
async function checkStaleEmbeddings(): Promise<void> {
  if (!currentIndex) return;

  // Skip during ENFILE cooldown
  if (isEnfileActive()) return;

  const startTime = Date.now();
  const forceFullVerification = !staleEmbeddingsFullVerificationCompleted;
  const { getIncrementalSessionStore } = await import('./incrementalSessionStore');
  const sessionStore = getIncrementalSessionStore();
  // Stage 2: indexing must include internal sessions so reconciliation and
  // stale-check metadata remain complete even for sidebar-hidden sessions.
  const summaries = sessionStore.listSessions({ includeInternal: true });

  const sessionsToReembed: AgentSession[] = [];
  const sessionsToRefreshInIndex: AgentSession[] = [];
  let gateSkipped = 0;
  let loaded = 0;
  let reembedded = 0;

  for (const summary of summaries) {
    // Skip if not embedded
    if (!currentIndex.embeddedSessionIds.has(summary.id)) continue;

    // Skip ineligible sessions — route through shouldEmbedSummary so eligibility rules
    // (incl. F7's now-allowed automations) stay defined in exactly one place.
    if (!shouldEmbedSummary(summary)) continue;

    // Check staleness: need embedded user message count from index
    const embeddedUserMsgCount = currentIndex.embeddedUserMessageCounts.get(summary.id);
    if (embeddedUserMsgCount === undefined) continue;

    // Check idle time from summary
    const lastUpdate = summary.updatedAt ?? summary.createdAt ?? Date.now();
    const idleTime = Date.now() - lastUpdate;
    if (idleTime < REEMBED_IDLE_TIME_MS) continue;

    if (typeof summary.userMessageCount === 'number') {
      const messageDelta = summary.userMessageCount - embeddedUserMsgCount;
      if (!forceFullVerification && messageDelta < REEMBED_MESSAGE_DELTA_THRESHOLD) {
        gateSkipped++;
        continue;
      }
    }

    // Load full sessions only for the explicit first-pass verification, old
    // summaries missing userMessageCount, or summaries whose count gate admits.
    const session = await sessionStore.getSession(summary.id);
    if (!session) continue;
    loaded++;
    if (typeof summary.userMessageCount !== 'number') {
      sessionsToRefreshInIndex.push(session);
    }
    if (!shouldEmbedSession(session)) continue;

    if (isEmbeddingStale(session)) {
      sessionsToReembed.push(session);
    }
  }

  if (sessionsToRefreshInIndex.length > 0) {
    try {
      await sessionStore.refreshSessionIndexSummaries(sessionsToRefreshInIndex);
    } catch (err) {
      log.warn(
        { err, count: sessionsToRefreshInIndex.length },
        'Failed to refresh stale-embedding session summaries',
      );
    }
  }

  if (sessionsToReembed.length > 0) {
    log.info({ count: sessionsToReembed.length }, 'Re-embedding stale conversations');

    for (const session of sessionsToReembed) {
      try {
        if (await reembedConversation(session)) {
          reembedded++;
        }
      } catch (err) {
        log.warn({ err, sessionId: session.id }, 'Failed to re-embed stale session');
      }
    }
  }

  staleEmbeddingsFullVerificationCompleted = true;
  log.info(
    {
      summaries: summaries.length,
      gateSkipped,
      loaded,
      reembedded,
      durationMs: Date.now() - startTime,
    },
    'Stale embedding check complete',
  );
}

export async function _checkStaleEmbeddingsForTesting(): Promise<void> {
  await checkStaleEmbeddings();
}

/**
 * Start the periodic stale embedding check interval
 * Uses visibility-aware scheduling to pause when app is hidden (cleanup/optimization, safe to pause)
 */
function startStaleCheckInterval(): void {
  if (staleCheckCleanup) return; // Already running

  staleCheckCleanup = createPausableInterval(async () => {
    // Stage 6: skip while any agent turn is active. Stale-checks are cleanup
    // work that competes with foreground LLM/embedding traffic if it runs in
    // parallel with a turn.
    if (isAppIdleFn ? !isAppIdleFn() : isAnyTurnActive()) return;

    try {
      await checkStaleEmbeddings();
    } catch (err) {
      log.warn({ err }, 'Stale embedding check failed');
    }
  }, STALE_CHECK_INTERVAL_MS, { pauseOnBlur: true, catchUpPriority: 3 });

  log.debug({ intervalMs: STALE_CHECK_INTERVAL_MS }, 'Started stale embedding check interval (visibility-aware)');
}

/**
 * Process sessions after save - embed new eligible sessions and cleanup deleted ones
 */
export async function onSessionsSaved(sessions: AgentSession[]): Promise<void> {
  // Skip all index operations during ENFILE cooldown to prevent error storms
  if (isEnfileActive()) {
    return;
  }

  if (!currentIndex) {
    await initializeConversationIndex();
  }

  if (!currentIndex) {
    return;
  }

  // Start stale check interval on first save (lazy initialization)
  startStaleCheckInterval();

  try {
    const sessionsToEmbed: AgentSession[] = [];
    const sessionsToRemove: string[] = [];
    const sessionsToRefresh: AgentSession[] = []; // F3: title changed since indexing → re-embed

    for (const session of sessions) {
      const isEmbedded = currentIndex.embeddedSessionIds.has(session.id);
      const isEligible = shouldEmbedSession(session);

      if (isEligible && !isEmbedded) {
        // New session needs embedding
        sessionsToEmbed.push(session);
      } else if (!isEligible && isEmbedded) {
        // Session became ineligible (privacy mode, corrupted, deleted, etc.) - remove embedding
        sessionsToRemove.push(session.id);
      } else if (isEligible && isEmbedded) {
        // F3: a rename (or other title change) leaves the indexed title/search_text stale,
        // so the conversation can't be found by its new title. The 2-msg/5-min stale gate
        // misses title-only edits. Re-embed when the title differs from what we indexed
        // (delete+add refreshes title, search_text, vector, and updatedAt together — the
        // proven write path; rename is infrequent so the embedding cost is negligible).
        const indexedTitle = currentIndex.embeddedTitles.get(session.id);
        if (indexedTitle !== undefined && indexedTitle !== session.title) {
          sessionsToRefresh.push(session);
        }
      }
    }

    // Remove embeddings for sessions that became ineligible (privacy mode, deleted, etc.)
    // Note: Orphan cleanup (reconcile) only runs at startup — not here. This function is
    // called for both single-session upserts and bulk saves, and the passed sessions are
    // never the full truth, so reconciling here would incorrectly orphan other sessions.
    if (sessionsToRemove.length > 0) {
      log.info({ count: sessionsToRemove.length }, 'Removing embeddings for ineligible sessions');
      for (const sessionId of sessionsToRemove) {
        await removeConversation(sessionId);
      }
    }

    // Embed new sessions (async, don't block)
    if (sessionsToEmbed.length > 0) {
      log.info({ count: sessionsToEmbed.length }, 'Embedding new conversations');
      for (const session of sessionsToEmbed) {
        try {
          await embedConversation(session);
        } catch (err) {
          log.warn({ err, sessionId: session.id }, 'Failed to embed session on save');
        }
      }
    }

    // F3: refresh embeddings whose title changed since indexing (renames).
    if (sessionsToRefresh.length > 0) {
      log.info({ count: sessionsToRefresh.length }, 'Re-embedding renamed conversations');
      for (const session of sessionsToRefresh) {
        try {
          await reembedConversation(session);
        } catch (err) {
          log.warn({ err, sessionId: session.id }, 'Failed to re-embed renamed session on save');
        }
      }
    }

    if (sessionsToEmbed.length > 0 || sessionsToRemove.length > 0 || sessionsToRefresh.length > 0) {
      log.info({ embedded: sessionsToEmbed.length, ineligible: sessionsToRemove.length, renamed: sessionsToRefresh.length }, 'Processed sessions save');
    }
  } catch (error) {
    log.error({ err: error }, 'Failed to process sessions save');
  }
}

/**
 * Backfill embeddings for existing sessions (called at startup).
 *
 * Uses summary-driven approach: filters candidates via lightweight session index metadata
 * (zero I/O from warm cache), then lazy-loads only sessions that actually need embedding.
 * Pauses when agent turns are active to avoid contending with user-facing work.
 *
 * Note: We don't use timestamp-based filtering because it can permanently skip sessions
 * that failed to embed in a previous run. The embeddedSessionIds check is O(1) and self-healing.
 */
export async function backfillConversationEmbeddings(
  options: { batchSize?: number; delayMs?: number } = {}
): Promise<number> {
  if (isEnfileActive()) {
    return 0;
  }

  if (!currentIndex) {
    await initializeConversationIndex();
  }

  if (!currentIndex) {
    return 0;
  }
  const index = currentIndex;

  const { batchSize = 10, delayMs = 200 } = options;

  const { getIncrementalSessionStore } = await import('./incrementalSessionStore');
  const sessionStore = getIncrementalSessionStore();
  // Stage 2: backfill candidate discovery is an indexing path (not sidebar UI),
  // so it explicitly opts into internal sessions.
  const summaries = sessionStore.listSessions({ includeInternal: true });

  // Filter candidates using summary metadata (no session file I/O)
  const candidates = summaries
    .filter(s => shouldEmbedSummary(s) && !index.embeddedSessionIds.has(s.id))
    .sort((a, b) => a.createdAt - b.createdAt);

  if (candidates.length === 0) {
    log.debug('No sessions to backfill');
    return 0;
  }

  log.info({ totalCandidates: candidates.length }, 'Starting conversation embedding backfill');

  isBackfillRunning = true;
  backfillAborted = false;
  let embeddedCount = 0;
  let loadFailures = 0;
  let skippedIneligible = 0;

  try {
    for (let i = 0; i < candidates.length; i++) {
      if (backfillAborted) {
        log.info({ embeddedCount, remaining: candidates.length - i }, 'Backfill aborted');
        break;
      }

      // Wait for app idle before loading/embedding (abort-aware)
      const shouldContinue = await waitForIdle();
      if (!shouldContinue) {
        log.info({ embeddedCount, remaining: candidates.length - i }, 'Backfill aborted during idle wait');
        break;
      }

      const summary = candidates[i];
      const session = await sessionStore.getSession(summary.id);
      if (!session) {
        loadFailures++;

        const fileExists = await sessionStore.sessionFileExists(summary.id);
        if (!fileExists) {
          try {
            log.warn({ sessionId: summary.id }, 'Backfill: ghost session detected (file confirmed missing) — pruning');

            if (index.embeddedSessionIds.has(summary.id)) {
              await removeConversation(summary.id);
            }

            // Intent: 'hygiene' (Stage 3 classification table) — this is a
            // file-confirmed-missing prune of PRESUMED-GONE data, not fresh
            // user intent. Tombstoning it would permanently block cloud
            // re-sync of a live session whose local file was transiently lost
            // (the eviction trap through a caller — DEFERRAL #1's shape).
            await sessionStore.deleteSession(summary.id, { intent: 'hygiene' });
          } catch (pruneErr) {
            log.warn(
              { err: pruneErr, sessionId: summary.id },
              'Failed to prune ghost session — will retry next backfill'
            );
          }
        } else {
          log.debug({ sessionId: summary.id }, 'Backfill: session file exists but unreadable, skipping');
        }
        continue;
      }

      // Full eligibility check (handles hasUserMessages === undefined from older index entries)
      if (!shouldEmbedSession(session)) {
        skippedIneligible++;
        continue;
      }

      try {
        const success = await embedConversation(session);
        if (success) {
          embeddedCount++;
        }
      } catch (err) {
        log.warn({ err, sessionId: session.id }, 'Failed to backfill session');
      }

      // Progress logging and throttling
      if ((i + 1) % batchSize === 0) {
        log.debug({ progress: i + 1, total: candidates.length }, 'Backfill progress');
        await saveMetadata(index.metadata);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    await saveMetadata(index.metadata);
    log.info({ embeddedCount, loadFailures, skippedIneligible, totalCandidates: candidates.length }, 'Conversation embedding backfill complete');
    return embeddedCount;
  } finally {
    isBackfillRunning = false;
  }
}

/**
 * Check if backfill is currently running
 */
export function isBackfillInProgress(): boolean {
  return isBackfillRunning;
}

/**
 * Get the status of the conversation index
 */
export async function getConversationIndexStatus(): Promise<ConversationIndexStatus> {
  if (!currentIndex) {
    return {
      totalEmbeddings: 0,
      lastIndexedAt: null,
      lastReconcileAt: null,
      isInitialized: false,
      embeddingModel: CURRENT_EMBEDDING_MODEL,
      indexedSessionIds: []
    };
  }

  return {
    totalEmbeddings: currentIndex.embeddedSessionIds.size,
    lastIndexedAt: currentIndex.metadata.lastIndexedAt || null,
    lastReconcileAt: currentIndex.metadata.lastReconcileAt || null,
    isInitialized: true,
    embeddingModel: currentIndex.metadata.embeddingModel,
    indexedSessionIds: Array.from(currentIndex.embeddedSessionIds)
  };
}

/**
 * Lightweight status for health checks - avoids allocating large session ID array.
 */
export function getConversationIndexHealthStatus(): {
  isInitialized: boolean;
  totalEmbeddings: number;
  lastIndexedAt: number | null;
  lastReconcileAt: number | null;
  embeddingModel: string;
} {
  if (!currentIndex) {
    return {
      isInitialized: false,
      totalEmbeddings: 0,
      lastIndexedAt: null,
      lastReconcileAt: null,
      embeddingModel: CURRENT_EMBEDDING_MODEL,
    };
  }

  return {
    isInitialized: true,
    totalEmbeddings: currentIndex.embeddedSessionIds.size,
    lastIndexedAt: currentIndex.metadata.lastIndexedAt || null,
    lastReconcileAt: currentIndex.metadata.lastReconcileAt || null,
    embeddingModel: currentIndex.metadata.embeddingModel,
  };
}

/**
 * Deduplicate conversation embeddings. Runs on every startup to catch duplicates
 * from any source (race conditions, interrupted migrations, etc.).
 *
 * Fast-path: compares rawRowCount (from init scan) vs embeddedSessionIds.size.
 * If equal, no duplicates exist and we skip the full scan.
 *
 * Does NOT write metadataVersion — that's reserved for schema migrations.
 */
async function deduplicateConversationIndexInternal(): Promise<number> {
  if (!currentIndex?.table) {
    return 0;
  }

  // Fast-path: if total row count equals unique session count, no duplicates exist.
  // Guard: skip fast-path when both are 0 (init-scan failure leaves defaults) — force a real scan.
  if (currentIndex.rawRowCount === currentIndex.embeddedSessionIds.size && currentIndex.rawRowCount > 0) {
    log.debug({ rowCount: currentIndex.rawRowCount }, 'Conversation index dedup fast-path: no duplicates');
    return 0;
  }

  log.info(
    { rawRowCount: currentIndex.rawRowCount, uniqueCount: currentIndex.embeddedSessionIds.size },
    'Row count mismatch detected, scanning for duplicate embeddings'
  );

  try {
    // Get all sessionIds to find duplicates
    const results = await currentIndex.table.query().select(['sessionId']).toArray();
    
    // Count occurrences of each sessionId
    const counts: Record<string, number> = {};
    for (const row of results) {
      const record = row as { sessionId: string };
      counts[record.sessionId] = (counts[record.sessionId] || 0) + 1;
    }

    // Find sessionIds with duplicates
    const duplicateIds = Object.entries(counts)
      .filter(([, count]) => count > 1)
      .map(([id]) => id);

    if (duplicateIds.length === 0) {
      log.info('No duplicate embeddings found (row count mismatch may be from other causes)');
      currentIndex.rawRowCount = results.length;
      return 0;
    }

    log.info({ duplicateCount: duplicateIds.length }, 'Found duplicate embeddings, cleaning up');

    let cleaned = 0;
    let failed = 0;
    for (const sessionId of duplicateIds) {
      try {
        const sessionPredicate = eq('sessionId', sessionId);
        
        // Get ALL copies and keep the most recently embedded one (highest embeddedAt).
        // Without ordering, LanceDB returns an arbitrary row which may be staler.
        const allCopies = await currentIndex.table
          .query()
          .where(sessionPredicate)
          .toArray();

        if (allCopies.length === 0) {
          log.warn({ sessionId }, 'Could not find record for duplicate cleanup');
          failed++;
          continue;
        }

        // Pick the copy with the most recent embeddedAt (newest embedding wins)
        const row = allCopies.reduce((best, curr) => {
          const bestAt = (best as unknown as ConversationEmbeddingRecord).embeddedAt ?? 0;
          const currAt = (curr as unknown as ConversationEmbeddingRecord).embeddedAt ?? 0;
          return currAt > bestAt ? curr : best;
        });

        // Extract only the fields we need (avoid re-inserting internal LanceDB fields
        // like _distance, _relevance_score). Include ALL schema fields so future
        // migrations (e.g., search_text) aren't stripped.
        const record = row as unknown as ConversationEmbeddingRecord;
        const cleanRecord: ConversationEmbeddingRecord = {
          sessionId: record.sessionId,
          title: record.title,
          search_text: record.search_text ?? '',
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          origin: record.origin,
          messageCount: record.messageCount,
          userMessageCount: record.userMessageCount ?? record.messageCount, // Fallback for old records
          embeddedAt: record.embeddedAt ?? record.updatedAt ?? Date.now(), // Fallback for old records
          embeddingModel: record.embeddingModel,
          vector: record.vector
        };

        // Delete all copies
        await currentIndex.table.delete(sessionPredicate);

        // Re-add single copy
        try {
          await currentIndex.table.add([cleanRecord]);
          cleaned++;
        } catch (addErr) {
          // Re-add failed after delete - remove from cache so backfill can heal
          log.warn({ err: addErr, sessionId }, 'Failed to re-add record after delete, removing from cache for re-embedding');
          currentIndex.embeddedSessionIds.delete(sessionId);
          failed++;
        }
      } catch (err) {
        log.warn({ err, sessionId }, 'Failed to deduplicate session');
        failed++;
        // Continue with other sessions
      }
    }

    // Update rawRowCount to reflect cleaned state
    const duplicateRowsRemoved = Object.entries(counts)
      .filter(([, count]) => count > 1)
      .reduce((sum, [, count]) => sum + (count - 1), 0);
    currentIndex.rawRowCount = Math.max(0, currentIndex.rawRowCount - duplicateRowsRemoved + failed);

    if (failed === 0) {
      log.info({ cleaned, totalDuplicates: duplicateIds.length }, 'Conversation index dedup completed');
    } else {
      log.warn({ cleaned, failed, totalDuplicates: duplicateIds.length }, 'Conversation index dedup completed with failures, will retry on next startup');
    }

    return cleaned;
  } catch (error) {
    log.error({ err: error }, 'Failed to deduplicate conversation index');
    return 0;
  }
}

/**
 * Deduplicate conversation embeddings — public entry point that acquires the write lock.
 */
export async function deduplicateConversationIndex(): Promise<number> {
  return withWriteLock(() => deduplicateConversationIndexInternal());
}

/**
 * Migration v2: Backfill `search_text` for existing rows.
 * Loads sessions on-demand from the incremental store, computes search_text,
 * and updates rows via delete+re-add. Does NOT re-compute vector embeddings —
 * search_text is FTS-only.
 *
 * Idempotent: checks metadataVersion, only stamps version on full success.
 * Self-healing: on add failure, clears embeddedSessionIds so backfill can recover.
 *
 * After successful migration: re-creates FTS indexes (search_text column now populated)
 * and runs optimize to compact LanceDB versions from all the delete+re-add operations.
 */
async function migrateSearchTextInternal(): Promise<void> {
  if (!currentIndex?.table) return;
  if ((currentIndex.metadata.metadataVersion ?? 0) >= CURRENT_METADATA_VERSION) return;

  const table = currentIndex.table;
  const embeddedIds = Array.from(currentIndex.embeddedSessionIds);
  if (embeddedIds.length === 0) {
    currentIndex.metadata.metadataVersion = CURRENT_METADATA_VERSION;
    await saveMetadata(currentIndex.metadata);
    log.info('Metadata v2 migration: no rows to migrate, version stamped');
    return;
  }

  log.info({ sessionCount: embeddedIds.length }, 'Starting metadata v2 migration: backfill search_text');

  const { getIncrementalSessionStore } = await import('./incrementalSessionStore');
  let backfilled = 0;
  let failed = 0;

  for (let i = 0; i < embeddedIds.length; i++) {
    const sessionId = embeddedIds[i];
    try {
      const session = await getIncrementalSessionStore().getSession(sessionId);
      if (!session) {
        log.debug({ sessionId }, 'Migration: session not found in store, skipping');
        failed++;
        continue;
      }

      const searchText = buildSearchText(session);
      const sessionPredicate = eq('sessionId', sessionId);

      // Read existing record
      const rows = await table
        .query()
        .where(sessionPredicate)
        .limit(1)
        .toArray();

      if (rows.length === 0) {
        log.debug({ sessionId }, 'Migration: row not found in index, skipping');
        failed++;
        continue;
      }

      const record = rows[0] as unknown as ConversationEmbeddingRecord;

      // Delete old row
      await table.delete(sessionPredicate);

      // Re-add with search_text populated
      try {
        await table.add([{
          sessionId: record.sessionId,
          title: record.title,
          search_text: searchText,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          origin: record.origin,
          messageCount: record.messageCount,
          userMessageCount: record.userMessageCount ?? record.messageCount,
          embeddedAt: record.embeddedAt ?? record.updatedAt ?? Date.now(),
          embeddingModel: record.embeddingModel,
          vector: record.vector,
        }]);
        backfilled++;
      } catch (addErr) {
        // Add failed after delete — remove from cache so backfill can heal this session later
        log.warn({ err: addErr, sessionId }, 'Migration: failed to re-add record after delete, removing from cache');
        currentIndex.embeddedSessionIds.delete(sessionId);
        currentIndex.embeddedUserMessageCounts.delete(sessionId);
        failed++;
      }
    } catch (err) {
      log.warn({ err, sessionId }, 'Migration: failed to backfill search_text for session');
      failed++;
    }

    // Progress logging every 100 sessions
    if ((i + 1) % 100 === 0) {
      log.info({ progress: i + 1, total: embeddedIds.length, backfilled, failed }, 'Migration v2 progress');
    }
  }

  if (failed === 0) {
    currentIndex.metadata.metadataVersion = CURRENT_METADATA_VERSION;
    await saveMetadata(currentIndex.metadata);
    log.info({ backfilled }, 'Metadata v2 migration complete: search_text backfilled');
  } else {
    log.warn(
      { backfilled, failed },
      'Metadata v2 migration completed with failures — will retry on next startup'
    );
  }

  // Re-create FTS indexes now that search_text column is populated.
  if (currentIndex.table) {
    currentIndex.ftsReady = await ensureConversationFTSIndex(currentIndex.table);
  }

  // Compact LanceDB versions created by all the delete+re-add operations
  await optimizeIndexInternal();
}

/**
 * Migrate search_text field for existing conversation embeddings.
 * Public entry point that acquires the write lock.
 */
export async function migrateSearchText(): Promise<void> {
  return withWriteLock(() => migrateSearchTextInternal());
}
