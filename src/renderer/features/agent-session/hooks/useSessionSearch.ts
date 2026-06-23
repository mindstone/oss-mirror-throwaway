import { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import { useTimeoutRef } from '@renderer/hooks/useTimeoutRef';
import type { AgentTurnMessage, AgentSessionSummary } from '@shared/types';
import {
  semanticSearchConversations,
  calculateConversationRecencyBoost,
  RECENCY_FILTER_MS,
  type ConversationSearchResult,
  type SemanticConversationResult,
  type ConversationSearchAvailability,
  type RecencyFilter
} from '@renderer/utils/conversationSearch';
import type { EmitLogFn } from '@renderer/contexts';
import { parseNavigationUrl } from '@shared/navigation/urlParser';
import { isAutomationSession } from '@shared/sessionKind';
import { tracking } from '@renderer/src/tracking';

/** Deep search result from full-text search across all message content */
export type DeepSearchResult = {
  sessionId: string;
  title: string | null;
  matchPreview: string;
  matchCount: number;
};

/** Minimum query length for semantic search */
const MIN_QUERY_LENGTH_FOR_SEMANTIC = 3;
const FIND_SIMILAR_TIMEOUT_MS = 5 * 60 * 1000;

/** Minimum length for a raw session ID (nanoid is typically 21 chars) */
const MIN_SESSION_ID_LENGTH = 10;
/** Maximum length for a raw session ID (UUID is 36 chars with hyphens) */
const MAX_SESSION_ID_LENGTH = 40;
/** Pattern for valid session ID characters (alphanumeric + hyphen/underscore) */
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

type SessionSearchOrigin = 'manual' | 'automation' | 'focus' | 'browser-extension';

type FindSimilarSource = { sessionId: string; title: string };

const normalizeSessionOrigin = (
  origin: AgentSessionSummary['origin'] | undefined,
  sessionId: string,
): SessionSearchOrigin => {
  if (isAutomationSession(sessionId)) {
    return 'automation';
  }
  if (origin === 'focus') {
    return 'focus';
  }
  if (origin === 'browser-extension') {
    return 'browser-extension';
  }

  return 'manual';
};

/**
 * Extract a session ID from a search query.
 * Handles both rebel://conversation/{id} URLs and raw session IDs.
 *
 * @param query - The search query
 * @returns The extracted session ID, or null if not a valid ID/URL
 */
function extractSessionIdFromQuery(query: string): string | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  // Check for rebel://conversation/{id} URL using existing parser
  const navTarget = parseNavigationUrl(trimmed);
  if (navTarget?.type === 'sessions' && navTarget.sessionId) {
    return navTarget.sessionId;
  }

  // Check if query looks like a raw session ID
  if (
    trimmed.length >= MIN_SESSION_ID_LENGTH &&
    trimmed.length <= MAX_SESSION_ID_LENGTH &&
    SESSION_ID_PATTERN.test(trimmed)
  ) {
    return trimmed;
  }

  return null;
}

/**
 * Find a session by ID directly, bypassing filters.
 * This allows pasting a session ID or rebel:// URL to find any session.
 * Uses sessionSummaries for lightweight lookup (lazy loading Stage 7).
 */
function findSessionById(
  sessionId: string,
  summaries: AgentSessionSummary[],
  currentSessionId: string,
  currentSessionTitle: string,
  currentSessionResolvedAt: number | null,
  currentSessionOrigin: SessionSearchOrigin,
  currentMessages: AgentTurnMessage[]
): ConversationSearchResult | null {
  // Check current session first
  if (sessionId === currentSessionId) {
    const lastMessage = currentMessages[currentMessages.length - 1];
    return {
      sessionId: currentSessionId,
      sessionTitle: currentSessionTitle,
      sessionTimestamp: lastMessage?.createdAt ?? Date.now(),
      resolvedAt: currentSessionResolvedAt,
      isResolved: currentSessionResolvedAt !== null,
      isHistory: false,
      isCorrupted: false,
      messageCount: currentMessages.length,
      matchedText: currentSessionTitle,
      matchedRole: 'user',
      score: 0,
      matches: [],
      isTitle: true,
      origin: currentSessionOrigin
    };
  }

  // Search in session summaries (including deleted ones for completeness)
  const summary = summaries.find((s) => s.id === sessionId);
  if (!summary) return null;

  return {
    sessionId: summary.id,
    sessionTitle: summary.title ?? 'Untitled',
    sessionTimestamp: summary.updatedAt ?? summary.createdAt ?? 0,
    resolvedAt: typeof summary.resolvedAt === 'number' ? summary.resolvedAt : null,
    isResolved: summary.resolvedAt != null,
    isHistory: true,
    isCorrupted: false, // Summaries don't track corruption
    messageCount: summary.messageCount ?? 0,
    matchedText: summary.title ?? 'Untitled',
    matchedRole: 'user',
    score: 0,
    matches: [],
    isTitle: true,
    origin: normalizeSessionOrigin(summary.origin, summary.id)
  };
}

/** localStorage key for recency filter preference */
const STORAGE_KEY_RECENCY_FILTER = 'session-search-recency-filter';

/** Valid recency filter values */
const VALID_RECENCY_FILTERS: RecencyFilter[] = ['1d', '7d', '30d', 'all'];

/** Load recency filter from localStorage */
const getStoredRecencyFilter = (): RecencyFilter => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_RECENCY_FILTER);
    if (stored && VALID_RECENCY_FILTERS.includes(stored as RecencyFilter)) {
      return stored as RecencyFilter;
    }
  } catch {
    // Ignore localStorage errors
  }
  return 'all';
};

/** Save recency filter to localStorage */
const setStoredRecencyFilter = (filter: RecencyFilter): void => {
  try {
    localStorage.setItem(STORAGE_KEY_RECENCY_FILTER, filter);
  } catch {
    // Ignore localStorage errors
  }
};

import type { SessionTypeFilter } from '@shared/types';

type UseSessionSearchOptions = {
  /** Session summaries for lightweight search (lazy loading Stage 7) */
  sessionSummaries: AgentSessionSummary[];
  currentSessionId: string;
  currentSessionTitle: string;
  currentSessionResolvedAt: number | null;
  currentSessionOrigin: AgentSessionSummary['origin'];
  messages: AgentTurnMessage[];
  emitLog: EmitLogFn;
  onSelectResult: (sessionId: string, isHistory: boolean) => void;
  /** Session type filter: 'all' (both), 'conversations' (manual only), 'automations' (automation only) */
  sessionTypeFilter: SessionTypeFilter;
};

export const useSessionSearch = ({
  sessionSummaries,
  currentSessionId,
  currentSessionTitle,
  currentSessionResolvedAt,
  currentSessionOrigin,
  messages,
  emitLog,
  onSelectResult,
  sessionTypeFilter
}: UseSessionSearchOptions) => {
  // Refs to hold latest data - updated on every render but don't trigger effects
  const summariesRef = useRef(sessionSummaries);
  summariesRef.current = sessionSummaries;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Core search state — single unified results list (replaces Fuse + semantic tiers)
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ConversationSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Search availability (F4): 'ok' (incl. genuine no-match) vs index warming-up /
  // backend-unavailable / error — lets the sidebar say "warming up / unavailable"
  // instead of a misleading "No conversations found".
  const [searchStatus, setSearchStatus] = useState<ConversationSearchAvailability>('ok');
  // Bumped by retrySearch() to re-run the current query after a transient failure.
  const [retryNonce, setRetryNonce] = useState(0);
  const [findSimilarSource, setFindSimilarSource] = useState<FindSimilarSource | null>(null);

  // Search lifecycle refs
  const searchDebounce = useTimeoutRef();
  const searchAbortRef = useRef<AbortController | null>(null);

  // Guard: when true, the search effect must not clear results.
  // Set by setFindSimilarResults, cleared by handleQueryChange/clearSearch/Escape.
  const findSimilarModeRef = useRef(false);
  const findSimilarTimeout = useTimeoutRef();

  // Deep search state (full-text search across all messages)
  const [deepSearchResults, setDeepSearchResults] = useState<DeepSearchResult[]>([]);
  const [isDeepSearching, setIsDeepSearching] = useState(false);

  const normalizedCurrentSessionOrigin = useMemo(
    () => normalizeSessionOrigin(currentSessionOrigin, currentSessionId),
    [currentSessionId, currentSessionOrigin],
  );
  const deepSearchRequestIdRef = useRef<number>(0);

  // Recency filter state (persisted to localStorage)
  const [recencyFilter, setRecencyFilterState] = useState<RecencyFilter>(getStoredRecencyFilter);

  // Wrapper to persist filter changes
  const setRecencyFilter = useCallback((filter: RecencyFilter) => {
    setRecencyFilterState(filter);
    setStoredRecencyFilter(filter);
  }, []);

  // "Back to search" state - remembers query when user selects a result
  const [lastSearchQuery, setLastSearchQuery] = useState<string>('');
  // Track the query as user types (for capturing on selection)
  const currentQueryRef = useRef<string>('');

  // Build session lookup maps for filtering results
  // Uses sessionSummaries for lazy loading (Stage 7)

  // Stable signature for origin map — only changes when session list or origins change,
  // not on every streaming token (mirrors historySignature pattern)
  const originSignature = useMemo(
    () => sessionSummaries.map((s) => `${s.id}|${s.origin ?? 'manual'}`).join('::'),
    [sessionSummaries]
  );

  const sessionOriginMap = useMemo(() => {
    const map = new Map<string, SessionSearchOrigin>();
    for (const summary of summariesRef.current) {
      map.set(summary.id, normalizeSessionOrigin(summary.origin, summary.id));
    }
    return map;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- originSignature is an intentional proxy dependency
  }, [originSignature]);

  // Stable signature for timestamp map — only changes when session timestamps shift meaningfully
  const timestampSignature = useMemo(
    () => sessionSummaries.map((s) => `${s.id}|${s.updatedAt ?? s.createdAt ?? 0}`).join('::'),
    [sessionSummaries]
  );

  // Map session IDs to their last activity timestamp (for recency filtering/boosting)
  // Uses updatedAt from summaries (already derived from message timestamps)
  const sessionTimestampMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const summary of summariesRef.current) {
      const timestamp = summary.updatedAt ?? summary.createdAt ?? 0;
      map.set(summary.id, timestamp);
    }
    return map;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- timestampSignature is an intentional proxy dependency
  }, [timestampSignature]);

  // F5: instant title-substring matches over already-loaded session summaries. Serves
  // short/proper-noun queries (1-2 chars) that the semantic backend rejects, and acts as
  // an immediate "floor" beneath the async results so the sidebar never looks empty while
  // hybrid search runs. Respects the active recency + session-type filters.
  const buildTitleFloor = useCallback((trimmedQuery: string): ConversationSearchResult[] => {
    const q = trimmedQuery.toLowerCase();
    if (!q) return [];
    const filterMs = RECENCY_FILTER_MS[recencyFilter];
    const cutoffTime = filterMs ? Date.now() - filterMs : 0;
    const originMatchesFilter = (sessionId: string, origin: SessionSearchOrigin) => {
      if (sessionTypeFilter === 'all') return true;
      if (sessionTypeFilter === 'automations') return isAutomationSession(sessionId);
      return origin === 'manual' || origin === 'focus' || origin === 'browser-extension';
    };
    const out: ConversationSearchResult[] = [];
    for (const summary of summariesRef.current) {
      if (summary.deletedAt) continue;
      if (summary.isCorrupted) continue;
      const title = summary.title ?? '';
      const idx = title.toLowerCase().indexOf(q);
      if (idx < 0) continue;
      const origin = sessionOriginMap.get(summary.id) ?? normalizeSessionOrigin(summary.origin, summary.id);
      if (!originMatchesFilter(summary.id, origin)) continue;
      const ts = sessionTimestampMap.get(summary.id) ?? summary.updatedAt ?? summary.createdAt ?? 0;
      if (cutoffTime > 0 && ts < cutoffTime) continue;
      out.push({
        sessionId: summary.id,
        sessionTitle: title || 'Untitled',
        sessionTimestamp: ts,
        resolvedAt: typeof summary.resolvedAt === 'number' ? summary.resolvedAt : null,
        isResolved: summary.resolvedAt != null,
        isHistory: true,
        isCorrupted: false,
        messageCount: summary.messageCount ?? 0,
        matchedText: title || 'Untitled',
        matchedRole: 'user' as const,
        score: 1,
        matches: [[idx, idx + q.length]],
        isTitle: true,
        origin,
      });
    }
    out.sort((a, b) => b.sessionTimestamp - a.sessionTimestamp);
    return out.slice(0, 8);
  }, [recencyFilter, sessionTypeFilter, sessionOriginMap, sessionTimestampMap]);

  // Clear deep search results when query changes (prevents stale results from previous search)
  useEffect(() => {
    // Invalidate any in-flight deep search requests
    deepSearchRequestIdRef.current++;
    // Clear results immediately
    setDeepSearchResults([]);
    setIsDeepSearching(false);
  }, [query]);

  // Main search effect: debounced IPC call to LanceDB hybrid search
  useEffect(() => {
    // Cancel any in-flight search
    if (searchAbortRef.current) {
      searchAbortRef.current.abort();
      searchAbortRef.current = null;
    }
    searchDebounce.clear();

    const trimmedQuery = query.trim();

    // Empty query — clear results (unless Find Similar is active)
    if (!trimmedQuery) {
      if (!findSimilarModeRef.current) {
        setResults([]);
      }
      setIsSearching(false);
      setSelectedIndex(0);
      setSearchStatus('ok');
      return;
    }

    // Direct session ID / rebel:// URL bypass — synchronous, no debounce
    const extractedId = extractSessionIdFromQuery(trimmedQuery);
    if (extractedId) {
      const directMatch = findSessionById(
        extractedId,
        summariesRef.current,
        currentSessionId,
        currentSessionTitle,
        currentSessionResolvedAt,
        normalizedCurrentSessionOrigin,
        messagesRef.current
      );
      if (directMatch) {
        setResults([directMatch]);
        setIsSearching(false);
        setSelectedIndex(0);
        setSearchStatus('ok'); // local match, no backend call — clear any stale error/warming
        emitLog({
          level: 'debug',
          message: 'Direct session ID match found',
          context: { query: trimmedQuery, sessionId: extractedId },
          timestamp: Date.now()
        });
        return;
      }
      // Not found but looks like a rebel:// URL — don't fall through to search
      const navTarget = parseNavigationUrl(trimmedQuery);
      if (navTarget?.type === 'sessions' && navTarget.sessionId) {
        if (!findSimilarModeRef.current) {
          setResults([]);
        }
        setIsSearching(false);
        setSearchStatus('ok'); // never hit the backend — don't leave a stale error/warming state
        return;
      }
    }

    // F5: instant title-match floor (also the ONLY results for sub-threshold queries).
    const titleFloor = buildTitleFloor(trimmedQuery);
    const titleFloorIds = new Set(titleFloor.map((r) => r.sessionId));

    // Too short for semantic search — show title matches instead of nothing.
    if (trimmedQuery.length < MIN_QUERY_LENGTH_FOR_SEMANTIC) {
      if (!findSimilarModeRef.current) {
        setResults(titleFloor);
        setSelectedIndex(0);
      }
      setIsSearching(false);
      setSearchStatus('ok'); // never hit the backend — don't leave a stale error/warming state
      return;
    }

    // User started typing — exit Find Similar mode so the effect manages results
    findSimilarModeRef.current = false;
    setFindSimilarSource(null);

    // Show the title floor immediately so the list isn't empty while hybrid search runs
    // (anti-flicker: these stable rows persist and semantic results append below them).
    if (!findSimilarModeRef.current && titleFloor.length > 0) {
      setResults(titleFloor);
    }

    // Prepare async search with debounce
    const abortController = new AbortController();
    searchAbortRef.current = abortController;
    setIsSearching(true);

    searchDebounce.set(() => {
      if (abortController.signal.aborted) return;

      (async () => {
        try {
          // The recency window is pushed into the backend search (260620): the service scopes
          // the candidate set to the EXACT in-window conversations (fresh timestamps), so quick
          // search is exhaustive within the window rather than a top-N-by-relevance pool. Compute
          // the cutoff ONCE and reuse the SAME value for `updatedAfter` (sent to the backend) and
          // the post-filter below, so search latency can't make the two disagree.
          const filterMs = RECENCY_FILTER_MS[recencyFilter];
          const cutoffTime = filterMs ? Date.now() - filterMs : 0;
          // 'all' → no scope, modest pool. Filtered → the backend returns the whole in-window set
          // on the exact-allowlist path; this limit only bounds the >500-in-window grace fallback
          // and the unscoped 'all' path.
          const candidateLimit = recencyFilter === 'all' ? 20 : 100;
          const { status, results: semanticHits } = await semanticSearchConversations(trimmedQuery, {
            limit: candidateLimit,
            updatedAfter: cutoffTime > 0 ? cutoffTime : undefined,
          });

          if (abortController.signal.aborted) return;

          // Surface backend availability (warming-up / unavailable / error) distinctly
          // from a genuine no-match so the sidebar can render an honest state (F4).
          setSearchStatus(status);

          const nowMs = Date.now();

          // Helper to check if an origin matches the current filter
          const originMatchesFilter = (sessionId: string, origin: SessionSearchOrigin) => {
            if (sessionTypeFilter === 'all') return true;
            if (sessionTypeFilter === 'automations') return isAutomationSession(sessionId);
            return origin === 'manual' || origin === 'focus' || origin === 'browser-extension'; // 'conversations'
          };

          // Filter by origin and recency, deduplicate by sessionId
          const seenSessionIds = new Set<string>();
          const filteredHits = semanticHits.filter((hit) => {
            // Deduplicate
            if (seenSessionIds.has(hit.sessionId)) return false;
            seenSessionIds.add(hit.sessionId);
            // Filter by origin to match sessionTypeFilter
            const origin = sessionOriginMap.get(hit.sessionId);
            if (!origin) return false; // Session not found (maybe deleted)
            if (!originMatchesFilter(hit.sessionId, origin)) return false;
            // Apply recency filter
            if (cutoffTime > 0) {
              const sessionTimestamp = sessionTimestampMap.get(hit.sessionId) ?? hit.createdAt;
              if (sessionTimestamp < cutoffTime) return false;
            }
            return true;
          });

          // Apply recency boost and map to ConversationSearchResult
          const mappedResults: ConversationSearchResult[] = filteredHits.map((hit) => {
            const sessionTimestamp = sessionTimestampMap.get(hit.sessionId) ?? hit.createdAt;
            const recencyBoost = calculateConversationRecencyBoost(sessionTimestamp, nowMs);
            // Order by the backend's rankScore (RRF relevance in hybrid mode) so genuine
            // keyword/title hits — which can have low cosine `score` — rank where FTS+RRF
            // put them, not at the bottom. Falls back to `score` (vector-only mode / legacy).
            const boostedScore = (hit.rankScore ?? hit.score) * recencyBoost;
            // Enrich with metadata from summaries
            const summary = summariesRef.current.find((s) => s.id === hit.sessionId);
            return {
              sessionId: hit.sessionId,
              sessionTitle: hit.title,
              sessionTimestamp: summary?.updatedAt ?? summary?.createdAt ?? hit.createdAt,
              resolvedAt: summary?.resolvedAt != null && typeof summary.resolvedAt === 'number' ? summary.resolvedAt : null,
              isResolved: summary?.resolvedAt != null,
              isHistory: true,
              isCorrupted: false,
              messageCount: hit.messageCount,
              matchedText: hit.title,
              matchedRole: 'user' as const,
              score: boostedScore,
              matches: [],
              isTitle: true,
              origin: sessionOriginMap.get(hit.sessionId) ?? 'manual',
            };
          });

          // Sort by boosted score (higher is better for semantic results)
          mappedResults.sort((a, b) => b.score - a.score);

          // Guard: don't overwrite results set externally by Find Similar
          if (findSimilarModeRef.current) return;

          // F5: keep the instant title-match floor first (stable rows — no flicker), then
          // append semantic results not already shown as a title match (dedup, title-first).
          const semanticOnly = mappedResults.filter((r) => !titleFloorIds.has(r.sessionId));
          const merged = [...titleFloor, ...semanticOnly];

          setResults(merged);
          emitLog({
            level: 'debug',
            message: 'Session search performed',
            context: {
              query: trimmedQuery,
              resultCount: merged.length,
              titleFloorCount: titleFloor.length,
              recencyFilter,
              totalSemanticHits: semanticHits.length
            },
            timestamp: Date.now()
          });
          // Track conversation search (only for meaningful queries of 2+ chars)
          if (trimmedQuery.length >= 2) {
            tracking.navigation.conversationSearchPerformed(trimmedQuery.length, merged.length);
          }
        } catch (error) {
          if (!abortController.signal.aborted) {
            emitLog({
              level: 'error',
              message: 'Session search failed',
              context: { error: error instanceof Error ? error.message : String(error) },
              timestamp: Date.now()
            });
            setResults([]);
            // An unexpected throw here (not the graceful status path) → honest error state.
            setSearchStatus('error');
          }
        } finally {
          if (!abortController.signal.aborted) {
            setIsSearching(false);
          }
        }
      })();
    }, 300); // 300ms debounce for IPC search

    // Cleanup: cancel debounce and abort on unmount or when dependencies change
    return () => {
      searchDebounce.clear();
      abortController.abort();
    };
  // retryNonce is included so retrySearch() re-runs the current query after a transient
  // backend failure (F4 "Try again").
  }, [query, retryNonce, recencyFilter, sessionTypeFilter, sessionOriginMap, sessionTimestampMap, buildTitleFloor, emitLog, searchDebounce, currentSessionId, currentSessionTitle, currentSessionResolvedAt, normalizedCurrentSessionOrigin]);

  // Bound selectedIndex when results change
  useEffect(() => {
    if (results.length === 0) {
      setSelectedIndex(0);
      return;
    }
    setSelectedIndex((prev) => Math.min(prev, results.length - 1));
  }, [results.length]);

  // Trigger deep search on button click (explicit opt-in)
  const triggerDeepSearch = useCallback(async () => {
    if (query.trim().length < MIN_QUERY_LENGTH_FOR_SEMANTIC) {
      return;
    }

    // Increment request ID to cancel any previous deep search
    const requestId = ++deepSearchRequestIdRef.current;
    const requestIdStr = String(requestId);
    
    setIsDeepSearching(true);
    setDeepSearchResults([]);

    // F2: honour the active recency window so "Search all messages" scans only the
    // selected time range (matches the quick-search scope and the chip label).
    const deepFilterMs = RECENCY_FILTER_MS[recencyFilter];
    const updatedAfter = deepFilterMs ? Date.now() - deepFilterMs : undefined;

    try {
      const response = await window.searchApi.conversationsDeep({
        query: query.trim(),
        requestId: requestIdStr,
        updatedAfter,
      });

      // Check if this response is stale (a newer search was triggered)
      if (deepSearchRequestIdRef.current !== requestId) {
        return;
      }

      // Helper to check if an origin matches the current filter
      const originMatchesFilter = (sessionId: string, origin: SessionSearchOrigin) => {
        if (sessionTypeFilter === 'all') return true;
        if (sessionTypeFilter === 'automations') return isAutomationSession(sessionId);
        return origin === 'manual' || origin === 'focus' || origin === 'browser-extension'; // 'conversations'
      };
      
      // Deduplicate against main results (single unified list)
      const mainSessionIds = new Set(results.map((r) => r.sessionId));
      
      const deduplicatedResults = response.results.filter((hit) => {
        // Skip if already in main results
        if (mainSessionIds.has(hit.sessionId)) return false;
        // Apply origin filter to match session type filter
        const origin = sessionOriginMap.get(hit.sessionId);
        if (!origin) return false; // Session not found in summaries (maybe deleted)
        if (!originMatchesFilter(hit.sessionId, origin)) return false;
        return true;
      });

      setDeepSearchResults(deduplicatedResults);
      
      emitLog({
        level: 'debug',
        message: 'Deep conversation search performed',
        context: {
          query: query.trim(),
          totalResults: response.results.length,
          deduplicatedResults: deduplicatedResults.length,
          truncated: response.truncated,
        },
        timestamp: Date.now(),
      });
    } catch (error) {
      // Only log error if not stale
      if (deepSearchRequestIdRef.current === requestId) {
        emitLog({
          level: 'error',
          message: 'Deep conversation search failed',
          context: { error: error instanceof Error ? error.message : String(error) },
          timestamp: Date.now(),
        });
        setDeepSearchResults([]);
      }
    } finally {
      // Only update loading state if not stale
      if (deepSearchRequestIdRef.current === requestId) {
        setIsDeepSearching(false);
      }
    }
  }, [query, results, emitLog, sessionOriginMap, sessionTypeFilter, recencyFilter]);

  // Wrapped handleQueryChange that tracks current query for "Back to search"
  const handleQueryChange = useCallback(
    (newQuery: string) => {
      // Exit Find Similar mode — user is starting their own search
      findSimilarModeRef.current = false;
      setFindSimilarSource(null);
      findSimilarTimeout.clear();
      currentQueryRef.current = newQuery;
      // Clear lastSearchQuery when user starts a new search
      if (newQuery.trim() && lastSearchQuery) {
        setLastSearchQuery('');
      }
      setQuery(newQuery);
      setSelectedIndex(0);
    },
    [lastSearchQuery, findSimilarTimeout]
  );

  // Extended clear that resets all search state
  // rememberForBack: true when clearing due to result selection (save query for "Back to search")
  // rememberForBack: false when explicitly clearing (Esc, X button)
  const clearSearch = useCallback(
    (options?: { rememberForBack?: boolean }) => {
      const { rememberForBack = false } = options ?? {};
      
      if (rememberForBack && currentQueryRef.current.trim()) {
        // Save query for "Back to search" feature
        setLastSearchQuery(currentQueryRef.current);
      } else if (!rememberForBack) {
        // Explicit clear - also clear the "back" state
        setLastSearchQuery('');
      }
      
      findSimilarModeRef.current = false;
      setFindSimilarSource(null);
      findSimilarTimeout.clear();
      setQuery('');
      currentQueryRef.current = '';
      setResults([]);
      setIsSearching(false);
      setSelectedIndex(0);
      setSearchStatus('ok'); // clearing search resets availability (F4)
      searchDebounce.clear();
      if (searchAbortRef.current) {
        searchAbortRef.current.abort();
        searchAbortRef.current = null;
      }
      // Clear deep search state
      setDeepSearchResults([]);
      setIsDeepSearching(false);
      deepSearchRequestIdRef.current++; // Invalidate any in-flight requests
    },
    [findSimilarTimeout, searchDebounce]
  );

  useEffect(() => {
    if (!findSimilarSource) return;

    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.repeat || e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      e.preventDefault();
      clearSearch();
    };

    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [findSimilarSource, clearSearch]);

  // Restore search from "Back to search" action
  const restoreSearch = useCallback(() => {
    if (lastSearchQuery) {
      handleQueryChange(lastSearchQuery);
      setLastSearchQuery('');
    }
  }, [handleQueryChange, lastSearchQuery]);

  // Alias for backward compatibility
  const handleHoverResult = useCallback((index: number) => {
    setSelectedIndex(index);
  }, []);

  // Re-run the current query after a transient backend failure (F4 "Try again").
  const retrySearch = useCallback(() => {
    setRetryNonce((n) => n + 1);
  }, []);

  // Wrapper for external callers (e.g. Find Similar) that protects results from
  // being cleared by the search effect when dependencies change.
  // Safety timeout: auto-clears guard after 5 minutes to prevent stuck state
  // if a code path forgets to clear it (e.g. unexpected navigation).
  const setFindSimilarResults = useCallback((semanticResults: SemanticConversationResult[], source: FindSimilarSource) => {
    findSimilarModeRef.current = true;
    setSearchStatus('ok'); // externally-injected results — never a backend error/warming state
    searchDebounce.clear();
    if (searchAbortRef.current) {
      searchAbortRef.current.abort();
      searchAbortRef.current = null;
    }
    setQuery('');
    currentQueryRef.current = '';
    setLastSearchQuery('');
    setDeepSearchResults([]);
    setIsDeepSearching(false);
    deepSearchRequestIdRef.current++;
    // Map SemanticConversationResult to ConversationSearchResult for unified rendering
    const mapped: ConversationSearchResult[] = semanticResults.map((hit) => {
      const summary = summariesRef.current.find((s) => s.id === hit.sessionId);
      return {
        sessionId: hit.sessionId,
        sessionTitle: hit.title,
        sessionTimestamp: summary?.updatedAt ?? summary?.createdAt ?? hit.createdAt,
        resolvedAt: summary?.resolvedAt != null && typeof summary.resolvedAt === 'number' ? summary.resolvedAt : null,
        isResolved: summary?.resolvedAt != null,
        isHistory: true,
        isCorrupted: false,
        messageCount: hit.messageCount,
        matchedText: hit.title,
        matchedRole: 'user' as const,
        score: hit.score,
        matches: [],
        isTitle: true,
        origin: normalizeSessionOrigin(summary?.origin, hit.sessionId),
      };
    });
    setResults(mapped);
    setSelectedIndex(0);
    setIsSearching(false);
    setFindSimilarSource(source);
    findSimilarTimeout.set(() => {
      findSimilarModeRef.current = false;
      setFindSimilarSource(null);
      setResults([]);
    }, FIND_SIMILAR_TIMEOUT_MS);
  }, [findSimilarTimeout, searchDebounce]);

  // Keyboard navigation (inlined — previously from useSearchWithNavigation)
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Find Similar escape
      if (e.key === 'Escape' && findSimilarModeRef.current) {
        findSimilarModeRef.current = false;
        setFindSimilarSource(null);
        findSimilarTimeout.clear();
        setResults([]);
        e.preventDefault();
        return;
      }

      if (results.length === 0) {
        if (e.key === 'Escape') {
          clearSearch();
        }
        return;
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case 'Enter': {
          e.preventDefault();
          const selected = results[selectedIndex];
          if (selected) {
            onSelectResult(selected.sessionId, selected.isHistory);
            clearSearch({ rememberForBack: true });
          }
          break;
        }
        case 'Escape':
          e.preventDefault();
          clearSearch();
          break;
        default:
          // eslint-disable-next-line rebel-switch-exhaustiveness/no-bare-default-bypass -- event.key is an unbounded DOM string; non-handled keys are intentionally ignored.
          break;
      }
    },
    [results, selectedIndex, findSimilarTimeout, clearSearch, onSelectResult]
  );

  return {
    query,
    results,
    isSearching,
    searchStatus,
    retrySearch,
    findSimilarSource,
    deepSearchResults,
    isDeepSearching,
    triggerDeepSearch,
    selectedIndex,
    lastSearchQuery,
    recencyFilter,
    setRecencyFilter,
    handleQueryChange,
    handleKeyDown,
    handleHoverResult,
    clearSearch,
    restoreSearch,
    setFindSimilarResults
  };
};
