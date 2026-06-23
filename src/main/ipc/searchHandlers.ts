/**
 * Search Domain IPC Handlers
 *
 * Handles semantic file search, indexing, and file watching operations.
 */

import { workspaceFs } from '@core/services/boundedWorkspaceFs';
import path from 'node:path';
import type { HandlerInvokeEvent } from '@core/handlerRegistry';
import { registerHandler } from './utils/registerHandler';
import { logger } from '@core/logger';
import { callBehindTheScenes } from '../services/behindTheScenesClient';
import {
  semanticSearch,
  clearIndex,
  readFileNeighbors,
  getIndexedPaths,
  hasIndex,
  type SemanticSearchResult
} from '../services/fileIndexService';
import { isWithinRoot } from '@core/utils/pathSafety';
import {
  searchTools,
  type ToolSearchResult
} from '../services/toolIndexService';
import {
  startWatching,
  stopWatching,
  pauseWatching,
  reindexWorkspace,
  getWatcherStatus,
  isWatching,
  getWatchedWorkspace
} from '../services/fileWatcherService';
import {
  pauseEnhancement,
  resumeEnhancement,
  startEnhancement,
} from '../services/enhancementService';
import {
  searchConversationsWithStatus,
  getConversationIndexStatus,
  findSimilarConversations,
  type ConversationSearchStatusResult,
  type FindSimilarResult
} from '../services/conversationIndexService';
import { getCategorizedCostSummary, EMPTY_CATEGORIZED_COST_SUMMARY } from '../services/costLedgerService';
import { getSettings, settingsStore } from '../settingsStore';
import { getApiKey } from '@core/rebelCore/settingsAccessors';
import { 
  getAtlasProjection, 
  getAtlasNeighbors,
  getAtlasQueryEmbedding,
  type AtlasProjectionResult 
} from '../services/atlasService';
import { getIncrementalSessionStore } from '../services/incrementalSessionStore';
import { buildMcpAppAwareMessageText } from '@shared/utils/mcpAppFallbackText';
import type {
  AtlasNeighborhoodRequest,
  AtlasNeighborhoodResponse,
} from '@shared/ipc/channels/search';

/**
 * Track latest requestId per caller to ignore stale deep search results.
 *
 * Desktop: keyed by WebContents.id (number).
 * Cloud: keyed by the literal string 'cloud-process' — cloud passes
 * event=null (cloud-service/src/routes/ipc.ts:363), so all cloud invocations
 * share a single cancellation key. Only one cloud process exists per turn,
 * so the latest-wins semantic still cancels the prior in-flight request.
 */
const latestDeepSearchRequestId = new Map<number | string, string>();
let currentNeighborhoodGeneration = 0;

/** Deep search constants */
const DEEP_SEARCH_BATCH_SIZE = 20;
const DEEP_SEARCH_MAX_RESULTS = 200;
const DEEP_SEARCH_PREVIEW_CONTEXT = 50; // chars before and after match

export function bumpAtlasNeighborhoodGeneration(): number {
  currentNeighborhoodGeneration += 1;
  return currentNeighborhoodGeneration;
}

export function _resetAtlasNeighborhoodGenerationForTesting(): void {
  currentNeighborhoodGeneration = 0;
}

function normalizeAtlasNeighborhoodLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) {
    return 5;
  }
  return Math.min(50, Math.max(1, Math.floor(limit ?? 5)));
}

function toPortableRelativePath(filePath: string, workspacePath: string | null): string {
  if (!workspacePath) {
    return filePath;
  }

  const relative = path.relative(workspacePath, filePath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join('/');
  }

  return filePath;
}

function findDeepSearchMatch(
  text: string,
  query: string,
): { index: number; length: number } | null {
  const directIndex = text.toLowerCase().indexOf(query.toLowerCase());
  if (directIndex >= 0) {
    return { index: directIndex, length: query.length };
  }

  const normalizedQuery = query.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!normalizedQuery) {
    return null;
  }

  const normalizedChars: string[] = [];
  const originalIndexByNormalizedIndex: number[] = [];
  let previousWasWhitespace = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (/\s/.test(char)) {
      if (!previousWasWhitespace) {
        normalizedChars.push(' ');
        originalIndexByNormalizedIndex.push(index);
        previousWasWhitespace = true;
      }
      continue;
    }

    normalizedChars.push(char.toLowerCase());
    originalIndexByNormalizedIndex.push(index);
    previousWasWhitespace = false;
  }

  const normalizedIndex = normalizedChars.join('').indexOf(normalizedQuery);
  if (normalizedIndex < 0) {
    return null;
  }

  const normalizedEndIndex = normalizedIndex + normalizedQuery.length - 1;
  const originalStart = originalIndexByNormalizedIndex[normalizedIndex];
  const originalEnd = originalIndexByNormalizedIndex[normalizedEndIndex];
  if (originalStart === undefined || originalEnd === undefined) {
    return null;
  }

  return { index: originalStart, length: originalEnd - originalStart + 1 };
}

export function registerSearchHandlers(): void {
  // Tool semantic search handler
  registerHandler(
    'search:tools',
    async (
      _event: HandlerInvokeEvent,
      args: { query: string; limit?: number; threshold?: number; maxPerPackage?: number }
    ): Promise<ToolSearchResult[]> => {
      try {
        const { query, limit = 10, threshold = 0.35, maxPerPackage = 5 } = args;

        if (!query || query.trim().length === 0) {
          return [];
        }

        const results = await searchTools(query, limit, threshold, maxPerPackage);
        logger.debug({ query, resultCount: results.length }, 'Tool search completed');
        return results;
      } catch (error) {
        logger.error({ err: error }, 'Tool search failed');
        return [];
      }
    }
  );

  registerHandler(
    'search:semantic',
    async (
      _event: HandlerInvokeEvent,
      args: { query: string; limit?: number; threshold?: number; fileTypes?: string[] }
    ): Promise<SemanticSearchResult[]> => {
      try {
        const { query, limit, threshold, fileTypes } = args;

        if (!query || query.trim().length === 0) {
          return [];
        }

        // Explicit user search (Library / @files UI) — enable the lexical
        // exemption so an exact keyword/filename match survives the vector-cosine
        // floor (F9, mirroring the F1 conversation-search fix).
        const results = await semanticSearch(query, { limit, threshold, fileTypes, lexicalExemption: true });
        logger.debug({ query, resultCount: results.length }, 'Semantic search completed');
        return results;
      } catch (error) {
        logger.error({ err: error }, 'Semantic search failed');
        return [];
      }
    }
  );

  registerHandler('search:index-status', async (_event: HandlerInvokeEvent) => {
    try {
      return getWatcherStatus();
    } catch (error) {
      logger.error({ err: error }, 'Failed to get index status');
      return {
        totalFiles: 0,
        indexedFiles: 0,
        pendingFiles: 0,
        lastIndexedAt: null,
        isWatching: false,
        workspacePath: null,
        indexState: 'not_started' as const,
      };
    }
  });

  // Stage 8 (260619_cloud-symlink-indexing) — per-space "has a prior index" probe.
  // Drives the SpaceCard reconnecting banner copy (State A "showing your last-known
  // files" vs State B "this space is empty for now"). Reads the in-memory
  // indexed-paths cache (cheap, no fs I/O), scoped to the ACTIVE workspace — the same
  // workspace whose spaces Settings shows. Returns `ready=false` when the index isn't
  // hydrated so the renderer fails toward State A (never claim emptiness we can't
  // prove). Path containment uses the approved `isWithinRoot` helper (separator-safe;
  // lowercased so case-insensitive filesystems don't false-negative).
  registerHandler(
    'search:spaces-with-index',
    async (_event: HandlerInvokeEvent, args: { spacePaths: string[] }) => {
      try {
        const spacePaths = args?.spacePaths ?? [];
        // Index not hydrated yet ⇒ can't prove emptiness ⇒ caller treats all as A.
        if (!hasIndex()) {
          return { ready: false, pathsWithIndex: [] };
        }
        const indexedPaths = getIndexedPaths();
        if (indexedPaths.length === 0) {
          // Hydrated but empty index: a genuine "no prior index" answer for every
          // space (ready=true, none have entries) ⇒ State B is reachable.
          return { ready: true, pathsWithIndex: [] };
        }
        // `isWithinRoot` throws on a non-absolute arg (a contract violation), so we
        // pre-filter to absolute, lowercased entries (case-insensitive filesystems)
        // rather than swallow per-entry inside the hot loop.
        const indexedAbs = indexedPaths.filter((p) => path.isAbsolute(p)).map((p) => p.toLowerCase());
        const pathsWithIndex = spacePaths.filter((spacePath) => {
          if (!path.isAbsolute(spacePath)) return false;
          const rootLower = spacePath.toLowerCase();
          return indexedAbs.some((indexed) => isWithinRoot(indexed, rootLower));
        });
        return { ready: true, pathsWithIndex };
      } catch (error) {
        // Fail toward State A (treat as "has prior index"): report not-ready so the
        // renderer never shows the honest-empty State B on an unexpected error.
        logger.warn({ err: error }, 'search:spaces-with-index probe failed; defaulting to has-prior-index');
        return { ready: false, pathsWithIndex: [] };
      }
    }
  );

  registerHandler(
    'search:start-watching',
    async (_event: HandlerInvokeEvent, args: { workspacePath: string }) => {
      try {
        const { workspacePath } = args;

        if (!workspacePath) {
          return { started: false, error: 'Workspace path is required' };
        }

        // startWatching handles contextual retrieval configuration internally
        await startWatching(workspacePath);
        // Persist that indexing is now enabled
        settingsStore.set('indexingEnabled', true);
        logger.info({ workspacePath }, 'Started file watching');
        return { started: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to start watching';
        logger.error({ err: error }, 'Failed to start file watching');
        return { started: false, error: message };
      }
    }
  );

  registerHandler('search:stop-watching', async (_event: HandlerInvokeEvent) => {
    try {
      await stopWatching();
      logger.info('Stopped file watching');
      return { stopped: true };
    } catch (error) {
      logger.error({ err: error }, 'Failed to stop file watching');
      return { stopped: false };
    }
  });

  registerHandler('search:pause-watching', async (_event: HandlerInvokeEvent) => {
    try {
      await pauseWatching();
      logger.info('Paused file watching (index preserved)');
      return { paused: true };
    } catch (error) {
      logger.error({ err: error }, 'Failed to pause file watching');
      return { paused: false };
    }
  });

  registerHandler(
    'search:reindex',
    async (_event: HandlerInvokeEvent, args: { force?: boolean }) => {
      try {
        const { force = false } = args;
        
        // If already watching, use current workspace path
        // (reindexWorkspace calls startWatching which handles contextual retrieval config)
        if (isWatching()) {
          logger.info({ force }, 'Reindexing currently watched workspace');
          await reindexWorkspace(force);
          return { started: true };
        }
        
        // If not watching, try to get workspace path from settings
        const settings = getSettings();
        const workspacePath = getWatchedWorkspace() || settings.coreDirectory;
        if (!workspacePath) {
          logger.warn('Reindex requested but no workspace path available');
          return { started: false, error: 'No workspace configured. Please set a workspace directory first.' };
        }
        
        // Start watching (which will trigger indexing)
        logger.info({ force, workspacePath }, 'Starting watcher for reindex');
        if (force) {
          // Clear index first if force=true
          await clearIndex();
        }
        await startWatching(workspacePath);
        return { started: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to start reindex';
        logger.error({ err: error }, 'Failed to start reindex');
        return { started: false, error: message };
      }
    }
  );

  registerHandler('search:clear-index', async (_event: HandlerInvokeEvent) => {
    try {
      // Get workspace path for clearing (needed if currentIndex is null on fresh start)
      const settings = getSettings();
      const workspacePath = getWatchedWorkspace() || settings.coreDirectory || undefined;
      
      // Clear index BEFORE stopping watcher (stopWatching sets currentIndex=null)
      // Pass workspacePath so we can clear even if currentIndex is null
      await clearIndex(workspacePath);
      await stopWatching();
      // Persist that indexing is disabled
      settingsStore.set('indexingEnabled', false);
      logger.info('Cleared file index and stopped watching');
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to clear index';
      logger.error({ err: error }, 'Failed to clear index');
      return { success: false, error: message };
    }
  });

  // Enhancement control handlers
  registerHandler('search:pause-enhancement', async (_event: HandlerInvokeEvent) => {
    try {
      pauseEnhancement();
      // Clear user request flag so enhancement doesn't auto-resume on app restart
      settingsStore.set('enhancementUserRequested', false);
      logger.info('Enhancement paused (user request cleared)');
      return { paused: true };
    } catch (error) {
      logger.error({ err: error }, 'Failed to pause enhancement');
      return { paused: false };
    }
  });

  registerHandler('search:resume-enhancement', async (_event: HandlerInvokeEvent) => {
    try {
      resumeEnhancement();
      logger.info('Enhancement resumed');
      return { resumed: true };
    } catch (error) {
      logger.error({ err: error }, 'Failed to resume enhancement');
      return { resumed: false };
    }
  });

  registerHandler('search:start-enhancement', async (_event: HandlerInvokeEvent) => {
    try {
      // Persist user's explicit request so enhancement resumes after app restart
      settingsStore.set('enhancementUserRequested', true);
      await startEnhancement();
      logger.info('Enhancement started manually (user request persisted)');
      return { started: true };
    } catch (error) {
      logger.error({ err: error }, 'Failed to start enhancement');
      return { started: false };
    }
  });

  // Conversation semantic search handlers
  registerHandler(
    'search:conversations-semantic',
    async (
      _event: HandlerInvokeEvent,
      args: { query: string; limit?: number; threshold?: number; updatedAfter?: number }
    ): Promise<ConversationSearchStatusResult> => {
      try {
        const { query, limit, threshold, updatedAfter } = args;

        if (!query || query.trim().length === 0) {
          return { status: 'ok', results: [] };
        }

        // Status-aware (F4): surface index-warming-up / embedding-unavailable / error
        // distinctly from a genuine no-match, so the sidebar doesn't render "No
        // conversations found" while the backend is merely warming up.
        // Explicit user-driven sidebar search → enable the lexical-exemption keep-rule so
        // exact keyword/title matches surface even when their embedding cosine is low (F1).
        // `updatedAfter` (when set) scopes the search to the active recency window so quick
        // search is exhaustive within it (grace-buffered prefilter on the index timestamp).
        const result = await searchConversationsWithStatus(query, { limit, threshold, lexicalExemption: true, updatedAfter });
        logger.debug({ query, status: result.status, resultCount: result.results.length }, 'Conversation semantic search completed');
        return result;
      } catch (error) {
        logger.error({ err: error }, 'Conversation semantic search failed');
        return { status: 'error', results: [] };
      }
    }
  );

  // Deep full-text search across ALL message content
  registerHandler(
    'search:conversations-deep',
    async (
      event: HandlerInvokeEvent,
      args: { query: string; requestId: string; updatedAfter?: number }
    ): Promise<{
      results: Array<{
        sessionId: string;
        title: string | null;
        matchPreview: string;
        matchCount: number;
      }>;
      requestId: string;
      truncated: boolean;
    }> => {
      const { query, requestId, updatedAfter } = args;
      const senderId: number | string = event?.sender?.id ?? 'cloud-process';

      // Track latest request to enable cancellation
      latestDeepSearchRequestId.set(senderId, requestId);

      const emptyResponse = { results: [], requestId, truncated: false };

      try {
        if (!query || query.trim().length === 0) {
          return emptyResponse;
        }

        const queryLower = query.toLowerCase();
        const store = getIncrementalSessionStore();
        const sessionIds = store.getSessionIds();

        // Word-boundary regex for relevance sorting (title match + whole-word match rank higher)
        const wordBoundaryPattern = new RegExp(`(?:^|\\W)${queryLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\W)`, 'i');

        const collected: Array<{
          sessionId: string;
          title: string | null;
          matchPreview: string;
          matchCount: number;
          titleMatch: boolean;
          wholeWordMatch: boolean;
        }> = [];
        let truncated = false;

        // Process in batches to limit memory usage
        for (let i = 0; i < sessionIds.length; i += DEEP_SEARCH_BATCH_SIZE) {
          // Check if request is stale (newer request came in)
          if (latestDeepSearchRequestId.get(senderId) !== requestId) {
            logger.debug({ requestId, senderId }, 'Deep search cancelled - stale request');
            return emptyResponse;
          }

          // Check if we have enough results
          if (collected.length >= DEEP_SEARCH_MAX_RESULTS) {
            truncated = true;
            break;
          }

          const batch = sessionIds.slice(i, i + DEEP_SEARCH_BATCH_SIZE);

          // Load sessions in parallel within batch
          const sessions = await Promise.all(
            batch.map((id) => store.getSession(id).catch(() => null))
          );

          for (const session of sessions) {
            // Skip corrupted/missing sessions
            if (!session) continue;
            if (session.isCorrupted) continue;

            // Skip deleted/trashed and private-mode sessions (the comment above claimed
            // corrupted was skipped, but only missing/deleted were — align with the
            // semantic-search eligibility rules so deep search doesn't surface private
            // or corrupted conversations).
            if (session.deletedAt) continue;
            if (session.privateMode) continue;

            // F2: honour the active recency window — skip conversations last active before
            // the cutoff (use the fresh in-session updatedAt, not the index timestamp).
            // Done BEFORE the result cap so excluded rows don't consume the cap budget.
            if (updatedAfter && (session.updatedAt ?? session.createdAt ?? 0) < updatedAfter) {
              continue;
            }

            // Check if we have enough results after each session
            if (collected.length >= DEEP_SEARCH_MAX_RESULTS) {
              truncated = true;
              break;
            }

            // Check title match for relevance sorting
            const titleMatch = (session.title ?? '').toLowerCase().includes(queryLower);

            // Search through all messages, including deterministic plaintext for primary MCP App fallbacks.
            let matchCount = 0;
            let firstMatchPreview = '';
            let wholeWordMatch = false;

            for (const message of session.messages ?? []) {
              const text = buildMcpAppAwareMessageText(
                message.text,
                message.role === 'assistant' || message.role === 'result'
                  ? session.eventsByTurn?.[message.turnId]
                  : undefined,
              );
              const match = findDeepSearchMatch(text, query);

              if (match) {
                matchCount++;

                if (!wholeWordMatch) {
                  wholeWordMatch = wordBoundaryPattern.test(text);
                }

                // Capture preview from first match only
                if (!firstMatchPreview) {
                  const matchIndex = match.index;
                  const start = Math.max(0, matchIndex - DEEP_SEARCH_PREVIEW_CONTEXT);
                  const end = Math.min(
                    text.length,
                    matchIndex + match.length + DEEP_SEARCH_PREVIEW_CONTEXT
                  );
                  let preview = text.slice(start, end);

                  // Add ellipsis if truncated
                  if (start > 0) preview = '…' + preview;
                  if (end < text.length) preview = preview + '…';

                  firstMatchPreview = preview;
                }
              }
            }

            // Add to results if any matches found
            if (matchCount > 0) {
              collected.push({
                sessionId: session.id,
                title: session.title ?? null,
                matchPreview: firstMatchPreview,
                matchCount,
                titleMatch,
                wholeWordMatch,
              });
            }
          }
        }

        // Sort by relevance: title match > whole-word match > matchCount
        collected.sort((a, b) => {
          if (a.titleMatch !== b.titleMatch) return a.titleMatch ? -1 : 1;
          if (a.wholeWordMatch !== b.wholeWordMatch) return a.wholeWordMatch ? -1 : 1;
          return b.matchCount - a.matchCount;
        });

        // Strip internal fields before returning
        const results = collected.map(({ titleMatch: _t, wholeWordMatch: _w, ...rest }) => rest);

        logger.debug(
          { query, resultCount: results.length, truncated, requestId },
          'Deep conversation search completed'
        );

        return { results, requestId, truncated };
      } catch (error) {
        logger.error({ err: error, requestId }, 'Deep conversation search failed');
        return emptyResponse;
      }
    }
  );

  registerHandler('search:conversation-index-status', async (_event: HandlerInvokeEvent) => {
    try {
      return await getConversationIndexStatus();
    } catch (error) {
      logger.error({ err: error }, 'Failed to get conversation index status');
      return {
        totalEmbeddings: 0,
        lastIndexedAt: null,
        lastReconcileAt: null,
        isInitialized: false,
        embeddingModel: 'unknown',
      };
    }
  });

  // Find similar conversations handler
  registerHandler(
    'search:similar-conversations',
    async (
      _event: HandlerInvokeEvent,
      args: { sessionId: string; limit?: number }
    ): Promise<FindSimilarResult> => {
      try {
        const { sessionId, limit = 5 } = args;

        if (!sessionId) {
          return { results: [], status: 'ok' };
        }

        const result = await findSimilarConversations(sessionId, { limit });
        logger.debug({ sessionId, resultCount: result.results.length, status: result.status }, 'Find similar conversations completed');
        return result;
      } catch (error) {
        logger.error({ err: error }, 'Find similar conversations failed');
        return { results: [], status: 'error' };
      }
    }
  );

  // Cost summary handler (category-aware aggregation)
  registerHandler(
    'search:cost-summary',
    async (
      _event: HandlerInvokeEvent,
      args: {
        startTs?: number;
        endTs?: number;
        categories?: string[];
        excludeCategories?: string[];
      }
    ) => {
      try {
        const result = await getCategorizedCostSummary(args);
        logger.debug(
          { startTs: args.startTs, endTs: args.endTs, entryCount: result.entryCount },
          'Cost summary retrieved'
        );
        return result;
      } catch (error) {
        logger.error({ err: error }, 'Failed to get cost summary');
        return { ...EMPTY_CATEGORIZED_COST_SUMMARY };
      }
    }
  );

  // Atlas projection handler - semantic visualization of workspace files
  registerHandler(
    'search:atlas-projection',
    async (
      _event: HandlerInvokeEvent,
      args: { forceRecompute?: boolean; includeEmbeddings?: boolean }
    ): Promise<AtlasProjectionResult> => {
      try {
        const result = await getAtlasProjection(
          args.forceRecompute ?? false,
          args.includeEmbeddings ?? false
        );
        logger.debug(
          { nodeCount: result.count, cached: result.cached, includeEmbeddings: args.includeEmbeddings },
          'Atlas projection retrieved'
        );
        return result;
      } catch (error) {
        logger.error({ err: error }, 'Atlas projection failed');
        return {
          nodes: [],
          clusters: [],
          count: 0,
          totalFileCount: 0,
          computedAt: Date.now(),
          cached: false,
        };
      }
    }
  );

  // Atlas neighbors handler - lazy edge loading on hover
  registerHandler(
    'search:atlas-neighbors',
    async (
      _event: HandlerInvokeEvent,
      args: { path: string; limit?: number }
    ): Promise<{ neighbors: Array<{ path: string; relativePath: string; score: number }> }> => {
      try {
        const neighbors = await getAtlasNeighbors(args.path, args.limit ?? 5);
        return { neighbors };
      } catch (error) {
        logger.error({ err: error, path: args.path }, 'Atlas neighbors lookup failed');
        return { neighbors: [] };
      }
    }
  );

  // Atlas neighborhood handler - bulk materialized edge loading after first paint
  registerHandler(
    'search:atlas-neighborhood',
    async (
      _event: HandlerInvokeEvent,
      args: AtlasNeighborhoodRequest
    ): Promise<AtlasNeighborhoodResponse | null> => {
      const requestedGen = args.generation ?? currentNeighborhoodGeneration + 1;
      currentNeighborhoodGeneration = Math.max(currentNeighborhoodGeneration, requestedGen);
      const limit = normalizeAtlasNeighborhoodLimit(args.limit);

      try {
        const neighborsMap = await readFileNeighbors(args.paths);

        // A newer neighborhood request or workspace switch landed while this
        // request awaited the read table. Return null so the renderer can drop it.
        if (currentNeighborhoodGeneration !== requestedGen) {
          return null;
        }

        const workspacePath = getWatchedWorkspace() || getSettings().coreDirectory || null;
        const neighbors: AtlasNeighborhoodResponse['neighbors'] = {};

        for (const [sourcePath, rows] of Object.entries(neighborsMap)) {
          neighbors[sourcePath] = rows.slice(0, limit).map(row => ({
            path: row.path,
            relativePath: toPortableRelativePath(row.path, workspacePath),
            score: row.score,
          }));
        }

        const covered = Object.keys(neighbors).length;
        return {
          generation: requestedGen,
          neighbors,
          neighborsCoverage: {
            requested: args.paths.length,
            covered,
            missing: Math.max(0, args.paths.length - covered),
          },
        };
      } catch (error) {
        logger.error({ err: error, pathCount: args.paths.length }, 'Atlas neighborhood lookup failed');
        return {
          generation: requestedGen,
          neighbors: {},
          neighborsCoverage: {
            requested: args.paths.length,
            covered: 0,
            missing: args.paths.length,
          },
        };
      }
    }
  );

  // Phase 7: Atlas query embedding handler - embed search query for semantic filtering
  registerHandler(
    'search:atlas-embed-query',
    async (
      _event: HandlerInvokeEvent,
      args: { query: string }
    ): Promise<{ embedding: number[] }> => {
      try {
        const embedding = await getAtlasQueryEmbedding(args.query);
        logger.debug(
          { queryLength: args.query.length, embeddingDim: embedding.length },
          'Atlas query embedding generated'
        );
        return { embedding };
      } catch (error) {
        logger.error({ err: error }, 'Atlas query embedding failed');
        return { embedding: [] };
      }
    }
  );

  // Atlas AI Insights: "The gist" - summarize a single file
  registerHandler(
    'search:atlas-summarize-file',
    async (
      _event: HandlerInvokeEvent,
      args: { filePath: string }
    ): Promise<{ summary: string | null; error?: string }> => {
      try {
        const settings = getSettings();

        if (!getApiKey(settings)) {
          return { summary: null, error: 'No API key configured' };
        }

        // Read file content through the bounded workspace-fs boundary: a cloud
        // path routes to the killable pool (never an unbounded blocking read on a
        // dead Drive mount — the indexed entry may be a stale cloud path).
        const readResult = await workspaceFs.readFile(args.filePath);
        if (readResult.status !== 'ok') {
          const error =
            readResult.status === 'reconnecting'
              ? 'This file is on a reconnecting cloud drive — try again shortly.'
              : readResult.error.message || 'Could not read file';
          return { summary: null, error };
        }

        // Truncate to ~8K chars (~2K tokens) to keep costs low
        const truncated = readResult.value.slice(0, 8000);

        const response = await callBehindTheScenes(
          settings,
          {
            system: `You extract the key insight from a document - not what it's "about", but the actual takeaway someone should remember.

Rules:
- Lead with the most important insight, finding, or actionable point
- If it's a how-to or process, state the core technique or approach
- If it's notes/research, surface the key conclusion or discovery
- Skip meta-commentary ("This document...", "The author...") - just state the insight directly
- Be specific and concrete, not generic
- 2-3 sentences max`,
            messages: [{ role: 'user', content: truncated }],
            maxTokens: 1024,
            timeout: 15000,
          },
          { category: 'atlas-insights' }
        );

        const text = response.content?.[0];
        if (text?.type === 'text' && text.text) {
          logger.debug({ filePath: args.filePath }, 'Atlas file summary generated');
          return { summary: text.text.trim() };
        }

        return { summary: null, error: 'Empty response from AI' };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Summary generation failed';
        logger.error({ err: error, filePath: args.filePath }, 'Atlas file summary failed');
        return { summary: null, error: message };
      }
    }
  );

  // Atlas AI Insights: "Zoom out" - analyze neighborhood theme
  registerHandler(
    'search:atlas-summarize-neighborhood',
    async (
      _event: HandlerInvokeEvent,
      args: { centerFilePath: string; neighborFilePaths: string[] }
    ): Promise<{ insight: string | null; error?: string }> => {
      try {
        const settings = getSettings();

        if (!getApiKey(settings)) {
          return { insight: null, error: 'No API key configured' };
        }

        // Read center file content
        let centerContent = '';
        const centerName = args.centerFilePath.split('/').pop() || args.centerFilePath;
        {
          // Bounded read: a reconnecting/unreadable cloud path degrades gracefully
          // to a placeholder instead of hanging the handler.
          const centerRead = await workspaceFs.readFile(args.centerFilePath);
          centerContent =
            centerRead.status === 'ok' ? centerRead.value.slice(0, 3000) : '(unable to read file)';
        }

        // Read neighbor file contents (limit to 5 neighbors, ~750 tokens each)
        const neighborContents: { name: string; content: string }[] = [];
        for (const filePath of args.neighborFilePaths.slice(0, 5)) {
          const name = filePath.split('/').pop() || filePath;
          // Bounded read: a reconnecting/unreadable cloud neighbor degrades to a
          // placeholder instead of hanging.
          const neighborRead = await workspaceFs.readFile(filePath);
          neighborContents.push({
            name,
            content: neighborRead.status === 'ok' ? neighborRead.value.slice(0, 3000) : '(unable to read file)',
          });
        }

        // Build the context with actual file contents
        const neighborSection = neighborContents
          .map(n => `### ${n.name}\n${n.content}`)
          .join('\n\n---\n\n');

        const response = await callBehindTheScenes(
          settings,
          {
            system: `You help users see the bigger picture of their knowledge. Given a file and its semantic neighbors (with full content), surface non-obvious insights about this cluster.

Your job:
1. **Pattern**: What theme or thread connects these documents? Be specific about the actual content.
2. **Key insights**: What are the most important takeaways across these documents?
3. **Connections**: How do these documents relate to or build on each other?
4. **Gap or opportunity**: What's missing? What adjacent topic might be worth exploring?

Be concise and insightful. You have the actual content, so reference specific details. Surface something the user might not have noticed from just the titles.`,
            messages: [{
              role: 'user',
              content: `## Currently viewing: ${centerName}
${centerContent}

---

## Nearby files in the knowledge graph:

${neighborSection}

---

What patterns, connections, and insights do you see across these documents?`
            }],
            maxTokens: 1024,
            timeout: 20000,
          },
          { category: 'atlas-insights' }
        );

        const text = response.content?.[0];
        if (text?.type === 'text' && text.text) {
          logger.debug({ centerFile: centerName, neighborCount: neighborContents.length }, 'Atlas neighborhood insight generated');
          return { insight: text.text.trim() };
        }

        return { insight: null, error: 'Empty response from AI' };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Insight generation failed';
        logger.error({ err: error }, 'Atlas neighborhood insight failed');
        return { insight: null, error: message };
      }
    }
  );

  // Atlas AI Insights: "Ask" - answer a question about files
  registerHandler(
    'search:atlas-ask-question',
    async (
      _event: HandlerInvokeEvent,
      args: { centerFilePath: string; neighborFilePaths: string[]; question: string }
    ): Promise<{ answer: string | null; error?: string }> => {
      try {
        const settings = getSettings();

        if (!getApiKey(settings)) {
          return { answer: null, error: 'No API key configured' };
        }

        // Read center file content
        let centerContent = '';
        const centerName = args.centerFilePath.split('/').pop() || args.centerFilePath;
        {
          // Bounded read (see zoom-out): cloud-safe, degrades to a placeholder.
          const centerRead = await workspaceFs.readFile(args.centerFilePath);
          centerContent =
            centerRead.status === 'ok' ? centerRead.value.slice(0, 3000) : '(unable to read file)';
        }

        // Read neighbor file contents
        const neighborContents: { name: string; content: string }[] = [];
        for (const filePath of args.neighborFilePaths.slice(0, 5)) {
          const name = filePath.split('/').pop() || filePath;
          // Bounded read: a reconnecting/unreadable cloud neighbor degrades to a
          // placeholder instead of hanging.
          const neighborRead = await workspaceFs.readFile(filePath);
          neighborContents.push({
            name,
            content: neighborRead.status === 'ok' ? neighborRead.value.slice(0, 3000) : '(unable to read file)',
          });
        }

        // Build the context
        const neighborSection = neighborContents
          .map(n => `### ${n.name}\n${n.content}`)
          .join('\n\n---\n\n');

        const response = await callBehindTheScenes(
          settings,
          {
            system: `You answer questions about documents concisely and directly. You have access to the main document and its related files. Base your answer on the actual content provided.

Rules:
- Answer the question directly and specifically
- Reference actual content from the documents when relevant
- If the answer isn't in the documents, say so briefly
- Keep responses concise (2-4 sentences typical)`,
            messages: [{
              role: 'user',
              content: `## Main document: ${centerName}
${centerContent}

---

## Related documents:

${neighborSection}

---

Question: ${args.question}`
            }],
            maxTokens: 1024,
            timeout: 20000,
          },
          { category: 'atlas-insights' }
        );

        const text = response.content?.[0];
        if (text?.type === 'text' && text.text) {
          logger.debug({ centerFile: centerName, question: args.question.slice(0, 50) }, 'Atlas question answered');
          return { answer: text.text.trim() };
        }

        return { answer: null, error: 'Empty response from AI' };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Question answering failed';
        logger.error({ err: error }, 'Atlas question answering failed');
        return { answer: null, error: message };
      }
    }
  );
}
