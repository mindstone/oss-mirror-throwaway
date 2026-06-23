import Fuse from 'fuse.js';
import type { AgentSession } from '@shared/types';
import type { ConversationMentionResult } from '@renderer/features/mentions/types';

// Recency boost configuration for conversation search
// Conservative settings - less volatile than file search
const CONVERSATION_RECENCY_BOOST = 0.08; // Max +8% boost for recent conversations
const CONVERSATION_RECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days half-life

/**
 * Calculate recency boost factor for a conversation based on its timestamp.
 * Uses exponential decay with configurable half-life.
 * 
 * @param timestamp - Conversation timestamp (ms since epoch)
 * @param nowMs - Current timestamp (ms since epoch), defaults to Date.now()
 * @returns Multiplier between 1.0 (no boost) and 1+CONVERSATION_RECENCY_BOOST (max boost)
 */
export function calculateConversationRecencyBoost(timestamp: number, nowMs: number = Date.now()): number {
  const ageMs = Math.max(0, nowMs - timestamp); // Clamp to 0 for future timestamps (clock skew)
  const decayFactor = Math.pow(2, -ageMs / CONVERSATION_RECENCY_HALF_LIFE_MS);
  return 1 + CONVERSATION_RECENCY_BOOST * decayFactor;
}

/** Recency filter options for conversation search */
export type RecencyFilter = '1d' | '7d' | '30d' | 'all';

/** Recency filter durations in milliseconds */
export const RECENCY_FILTER_MS: Record<RecencyFilter, number | null> = {
  '1d': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  'all': null,
};

/** Labels for recency filter UI */
export const RECENCY_FILTER_LABELS: Record<RecencyFilter, string> = {
  '1d': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  'all': 'All time',
};

/**
 * Result from semantic conversation search via IPC.
 */
export interface SemanticConversationResult {
  sessionId: string;
  title: string;
  /** Cosine similarity (0-1) for display only — a keyword match can have low cosine. */
  score: number;
  /** Ordering signal from the backend (RRF relevance in hybrid mode). Falls back to `score`. */
  rankScore?: number;
  createdAt: number;
  messageCount: number;
}

/**
 * Search availability (F4): distinguishes a genuine no-match (`ok` + empty) from an
 * unavailable backend (index warming up / embedding down) and unexpected failures, so
 * the sidebar can say "search is warming up / unavailable" instead of "No conversations".
 */
export type ConversationSearchAvailability = 'ok' | 'index_not_ready' | 'embedding_unavailable' | 'error';

export interface SemanticConversationSearchResponse {
  status: ConversationSearchAvailability;
  results: SemanticConversationResult[];
}

/**
 * Perform semantic search on conversations via the main process.
 * Uses hybrid (FTS + vector) retrieval to find conversations by keyword/meaning.
 *
 * @param query - The search query
 * @param options - Optional limit and threshold
 * @returns Status + matching conversations sorted by relevance. Unavailability is a
 *   distinct status (not an empty result), so callers can show an honest warming/error
 *   state instead of a misleading "no matches".
 */
export const semanticSearchConversations = async (
  query: string,
  options?: { limit?: number; threshold?: number; updatedAfter?: number }
): Promise<SemanticConversationSearchResponse> => {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return { status: 'ok', results: [] };
  }

  try {
    const response = await window.searchApi.conversationsSemantic({
      query: trimmedQuery,
      limit: options?.limit ?? 10,
      threshold: options?.threshold,
      // When set, scope the backend search to this recency window (exhaustive-within-window).
      updatedAfter: options?.updatedAfter
    });
    // Defensive against a legacy bare-array response (older main process / transition).
    if (Array.isArray(response)) {
      return { status: 'ok', results: response };
    }
    return response;
  } catch (error) {
    console.error('[conversationSearch] Semantic search failed:', error);
    return { status: 'error', results: [] };
  }
};

export type FindSimilarStatus = 'ok' | 'source_not_indexed' | 'index_not_ready' | 'demo_mode' | 'error';

export interface FindSimilarResult {
  results: SemanticConversationResult[];
  status: FindSimilarStatus;
}

/**
 * Find conversations similar to a given session via the main process.
 * Uses the session's embedding to find other conversations with similar content.
 *
 * @param sessionId - The source session ID to find similar conversations for
 * @param options - Optional limit for number of results
 * @returns Results and status indicating why results might be empty
 */
export const findSimilarConversations = async (
  sessionId: string,
  options?: { limit?: number }
): Promise<FindSimilarResult> => {
  if (!sessionId) {
    return { results: [], status: 'ok' };
  }

  try {
    const response = await window.searchApi.similarConversations({
      sessionId,
      limit: options?.limit ?? 5
    });
    return {
      results: response.results,
      status: response.status as FindSimilarStatus
    };
  } catch (error) {
    console.error('[conversationSearch] Find similar failed:', error);
    return { results: [], status: 'error' };
  }
};

/**
 * Lightweight session entry for title-only search (used in @-mention autocomplete).
 */
interface TitleSearchEntry {
  sessionId: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  origin?: 'manual' | 'automation' | 'role' | 'mcp-tool' | 'inbound-trigger' | 'plugin' | 'focus' | 'browser-extension' | 'operator-personalisation';
}

/**
 * Fuse.js instance cache for title-only search.
 * We cache based on a key derived from session IDs and titles to detect changes.
 */
let titleFuseCache: {
  cacheKey: string;
  entries: TitleSearchEntry[];
  instance: Fuse<TitleSearchEntry>;
} | null = null;

/**
 * Generate a cache key from sessions for stable identity comparison.
 * Key includes session IDs and titles to detect renames.
 */
const generateTitleCacheKey = (entries: TitleSearchEntry[]): string => {
  return entries.map((e) => `${e.sessionId}:${e.title}`).join('|');
};

/**
 * Clear the title search Fuse cache.
 * Call when sessions list changes.
 */
export const clearTitleFuseCache = (): void => {
  titleFuseCache = null;
};

/**
 * Transform a search query for Fuse.js extended search mode.
 * Splits on hyphens and spaces, prefixes each term with ' (include-match syntax).
 *
 * Examples:
 * - "chr-mov" → "'chr 'mov"
 * - "quiz guess" → "'quiz 'guess"
 * - "christmas" → "'christmas"
 *
 * @param query - Raw user query
 * @returns Transformed query for Fuse.js extended search
 */
const transformQueryForExtendedSearch = (query: string): string => {
  const parts = query
    .replace(/-/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return parts.map((p) => `'${p}`).join(' ');
};

/**
 * Get or create cached Fuse instance for title-only search.
 * Uses extended search mode for tokenized multi-term matching.
 */
const getTitleFuseInstance = (entries: TitleSearchEntry[]): Fuse<TitleSearchEntry> => {
  const cacheKey = generateTitleCacheKey(entries);
  
  if (titleFuseCache && titleFuseCache.cacheKey === cacheKey) {
    return titleFuseCache.instance;
  }

  const instance = new Fuse(entries, {
    keys: ['title'],
    threshold: 0.4, // More lenient for title-only matching
    includeScore: true,
    includeMatches: true,
    ignoreLocation: true, // Match anywhere in title
    minMatchCharLength: 1, // Allow single character matches for short queries
    distance: 200,
    useExtendedSearch: true // Enable tokenized multi-term matching
  });

  titleFuseCache = { cacheKey, entries, instance };
  return instance;
};

/**
 * Lightweight title-only search for @-mention autocomplete.
 * Much faster than full conversation search since it only examines session titles.
 *
 * @param query - The search query
 * @param sessions - List of AgentSession objects to search
 * @param options - Optional configuration
 * @returns Array of ConversationMentionResult sorted by score
 */
export const searchSessionTitles = (
  query: string,
  sessions: AgentSession[],
  options?: { limit?: number }
): ConversationMentionResult[] => {
  const limit = options?.limit ?? 8;
  const trimmedQuery = query.trim();

  if (!trimmedQuery || sessions.length === 0) {
    return [];
  }

  // Build title search entries from sessions
  const entries: TitleSearchEntry[] = sessions
    .filter((session) => !session.isCorrupted && session.messages.length > 0)
    .map((session) => ({
      sessionId: session.id,
      title: session.title,
      updatedAt: session.updatedAt ?? session.createdAt ?? Date.now(),
      messageCount: session.messages.length,
      origin: session.origin
    }));

  if (entries.length === 0) {
    return [];
  }

  const fuse = getTitleFuseInstance(entries);
  const extendedQuery = transformQueryForExtendedSearch(trimmedQuery);
  
  // Guard against delimiter-only queries (e.g. "-") that become empty after transformation
  if (!extendedQuery) {
    return [];
  }
  
  const fuseResults = fuse.search(extendedQuery, { limit: limit * 2 });

  // Convert to ConversationMentionResult
  const results: ConversationMentionResult[] = fuseResults.map((result) => {
    const matches: Array<[number, number]> = [];

    // Extract match indices from Fuse result
    if (result.matches) {
      for (const match of result.matches) {
        if (match.key === 'title' && match.indices) {
          for (const [start, end] of match.indices) {
            matches.push([start, end + 1]); // Convert to exclusive end
          }
        }
      }
    }

    return {
      kind: 'conversation' as const,
      id: result.item.sessionId,
      title: result.item.title,
      updatedAt: result.item.updatedAt,
      messageCount: result.item.messageCount,
      score: result.score ?? 1,
      matches,
      origin: result.item.origin
    };
  });

  // Boost prefix matches (results where query is prefix of title or title component)
  // This ensures "sou" prefers "source-capture" over "blah-source"
  const queryLower = trimmedQuery.toLowerCase();
  const queryNormalized = queryLower.replace(/[-\s]/g, '');

  for (const result of results) {
    const titleLower = result.title.toLowerCase();
    const titleNormalized = titleLower.replace(/[-\s]/g, '');

    // Check for word-component matches (e.g., "source" in "source-capture")
    const titleComponents = titleLower.split(/[-_\s]+/).filter(Boolean);
    const hasExactComponent = titleComponents.some((comp) => comp === queryLower);
    const hasComponentPrefix = titleComponents.some((comp) => comp.startsWith(queryLower));

    // Strong boost for prefix matches
    if (titleLower.startsWith(queryLower) || titleNormalized.startsWith(queryNormalized)) {
      result.score *= 0.5;
    }
    // Strong boost for exact word-component match
    else if (hasExactComponent) {
      result.score *= 0.5;
    }
    // Moderate boost for component prefix match
    else if (hasComponentPrefix) {
      result.score *= 0.7;
    }
  }

  // Sort by score (lower is better)
  results.sort((a, b) => a.score - b.score);

  return results.slice(0, limit);
};

export interface ConversationSearchResult {
  sessionId: string;
  sessionTitle: string;
  sessionTimestamp: number;
  resolvedAt: number | null;
  isResolved: boolean;
  isHistory: boolean;
  isCorrupted: boolean;
  messageCount: number;
  matchedText: string;
  matchedRole: 'user' | 'assistant' | 'result';
  score: number;
  matches: Array<[number, number]>;
  isTitle: boolean;
  origin?: 'manual' | 'automation' | 'role' | 'mcp-tool' | 'inbound-trigger' | 'plugin' | 'focus' | 'browser-extension' | 'operator-personalisation';
}
