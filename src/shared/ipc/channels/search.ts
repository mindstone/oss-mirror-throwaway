import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

// =============================================================================
// Search Domain Channels
// =============================================================================

// Shared schema for tool search results
const toolSearchResultSchema = z.object({
  toolId: z.string(),
  serverId: z.string(),
  serverName: z.string(),
  name: z.string(),
  description: z.string(),
  summary: z.string(),
  inputSchema: z.unknown(),
  score: z.number(),
});

export const ATLAS_NEIGHBORHOOD_REQUEST_SCHEMA = z.object({
  paths: z.array(z.string()).min(1).max(50000),
  limit: z.number().int().positive().max(50).default(5),
  generation: z.number().int().nonnegative().optional(),
});

const ATLAS_NEIGHBORHOOD_SUCCESS_RESPONSE_SCHEMA = z.object({
  generation: z.number().int().nonnegative(),
  neighbors: z.record(
    z.string(),
    z.array(z.object({
      path: z.string(),
      relativePath: z.string(),
      // `score` is cosine similarity in [0, 1]. The renderer's AtlasNeighbor type uses
      // `similarity` for the same value — kept distinct here to match the existing
      // `search:atlas-neighbors` channel (legacy hover IPC) for shape consistency.
      score: z.number().min(0).max(1),
    })),
  ),
  neighborsCoverage: z.object({
    requested: z.number().int().nonnegative(),
    covered: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
  }),
});

export const ATLAS_NEIGHBORHOOD_RESPONSE_SCHEMA = ATLAS_NEIGHBORHOOD_SUCCESS_RESPONSE_SCHEMA.nullable();

export type AtlasNeighborhoodRequest = z.infer<typeof ATLAS_NEIGHBORHOOD_REQUEST_SCHEMA>;
export type AtlasNeighborhoodResponse = z.infer<typeof ATLAS_NEIGHBORHOOD_SUCCESS_RESPONSE_SCHEMA>;

export const searchChannels = {
  'search:tools': defineInvokeChannel({
    channel: 'search:tools',
    request: z.object({
      query: z.string(),
      limit: z.number().optional(),
      threshold: z.number().optional(),
      maxPerPackage: z.number().optional(),
    }),
    response: z.array(toolSearchResultSchema),
    description: 'Search for MCP tools using semantic search (hybrid BM25 + vector)',
  }),

  'search:semantic': defineInvokeChannel({
    channel: 'search:semantic',
    request: z.object({
      query: z.string(),
      limit: z.number().optional(),
      threshold: z.number().optional(),
      fileTypes: z.array(z.string()).optional(),
    }),
    response: z.array(z.object({
      path: z.string(),
      relativePath: z.string(),
      snippet: z.string(),
      score: z.number(),
      extension: z.string(),
      chunkIndex: z.number(),
    })),
    description: 'Perform semantic search on indexed workspace files',
  }),

  'search:index-status': defineInvokeChannel({
    channel: 'search:index-status',
    request: z.void(),
    response: z.object({
      totalFiles: z.number(),
      indexedFiles: z.number(),
      pendingFiles: z.number(),
      lastIndexedAt: z.number().nullable(),
      isWatching: z.boolean(),
      workspacePath: z.string().nullable(),
      indexState: z.enum(['not_started', 'watching', 'paused']),
      // Two-phase indexing: enhancement progress
      totalChunks: z.number(),
      enhancedChunks: z.number(),
      enhancementRunning: z.boolean(),
      enhancementPaused: z.boolean(),
    }),
    description: 'Get the current status of the file index including enhancement progress',
  }),

  /**
   * Stage 8 (260619_cloud-symlink-indexing) — per-space "has a prior index" probe.
   * Drives the SpaceCard reconnecting banner's State A vs B: a degraded cloud space
   * with prior indexed entries shows "showing your last-known files" (A); one with
   * NO prior index shows the honest "this space is empty for now" (B). Reads the
   * in-memory indexed-paths cache (cheap, no I/O); scoped to the ACTIVE workspace,
   * which is the same workspace whose spaces Settings shows. `ready=false` (index
   * not hydrated yet) ⇒ the renderer must fail toward State A (never claim emptiness
   * we can't prove).
   */
  'search:spaces-with-index': defineInvokeChannel({
    channel: 'search:spaces-with-index',
    request: z.object({
      /** Absolute space paths to probe (SpaceInfo.absolutePath). */
      spacePaths: z.array(z.string()),
    }),
    response: z.object({
      /**
       * Whether the index is hydrated enough to answer. When false, callers must
       * treat every space as "has prior index" (conservative State-A default).
       */
      ready: z.boolean(),
      /** Subset of the requested paths that have ≥1 indexed entry beneath them. */
      pathsWithIndex: z.array(z.string()),
    }),
    description: 'For each requested space absolutePath, report whether the active-workspace file index holds any indexed entries beneath it (drives the per-space reconnecting State A vs B copy).',
  }),

  'search:start-watching': defineInvokeChannel({
    channel: 'search:start-watching',
    request: z.object({
      workspacePath: z.string(),
    }),
    response: z.object({
      started: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Start watching a workspace for file changes and indexing',
  }),

  'search:stop-watching': defineInvokeChannel({
    channel: 'search:stop-watching',
    request: z.void(),
    response: z.object({
      stopped: z.boolean(),
    }),
    description: 'Stop watching the workspace and close the index completely',
  }),

  'search:pause-watching': defineInvokeChannel({
    channel: 'search:pause-watching',
    request: z.void(),
    response: z.object({
      paused: z.boolean(),
    }),
    description: 'Pause watching the workspace (keeps index open for resume)',
  }),

  'search:reindex': defineInvokeChannel({
    channel: 'search:reindex',
    request: z.object({
      force: z.boolean().optional(),
    }),
    response: z.object({
      started: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Trigger a reindex of the workspace (force=true clears existing index)',
  }),

  'search:clear-index': defineInvokeChannel({
    channel: 'search:clear-index',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Clear the entire file index',
  }),

  'search:pause-enhancement': defineInvokeChannel({
    channel: 'search:pause-enhancement',
    request: z.void(),
    response: z.object({
      paused: z.boolean(),
    }),
    description: 'Pause background enhancement processing',
  }),

  'search:resume-enhancement': defineInvokeChannel({
    channel: 'search:resume-enhancement',
    request: z.void(),
    response: z.object({
      resumed: z.boolean(),
    }),
    description: 'Resume background enhancement processing',
  }),

  'search:start-enhancement': defineInvokeChannel({
    channel: 'search:start-enhancement',
    request: z.void(),
    response: z.object({
      started: z.boolean(),
    }),
    description: 'Manually start background enhancement (for large workspaces where auto-enhance is skipped)',
  }),

  // Conversation semantic search channels
  'search:conversations-semantic': defineInvokeChannel({
    channel: 'search:conversations-semantic',
    request: z.object({
      query: z.string(),
      limit: z.number().optional(),
      threshold: z.number().optional(),
      // When set, scope the search to conversations last active at/after this timestamp
      // (ms) so quick search is EXHAUSTIVE within the active recency window — relevance
      // ranks over the windowed set, not a top-N-by-relevance pool that's then filtered.
      // Resolved to an EXACT in-window sessionId allowlist from fresh session summaries (the
      // lagging index `updatedAt` is only a >500-in-window fallback). Finite-guarded so a stray
      // NaN/Infinity can't reach the DataFusion predicate builder.
      updatedAfter: z.number().finite().optional(),
    }),
    response: z.object({
      // Distinguishes a genuine no-match (`ok` + empty results) from an unavailable
      // backend (index warming up / embedding down) and unexpected failures — so the
      // sidebar can say "search is warming up / unavailable" instead of the misleading
      // "No conversations found" (the SEARCH.md "Unavailable vs no results" contract).
      status: z.enum(['ok', 'index_not_ready', 'embedding_unavailable', 'error']),
      results: z.array(z.object({
        sessionId: z.string(),
        title: z.string(),
        // Cosine similarity (0-1) for DISPLAY; a genuine keyword match can have low cosine.
        score: z.number(),
        // Ordering signal (RRF relevance in hybrid mode; cosine in vector-only). Optional
        // for back-compat; consumers fall back to `score`. Sort by this, not `score`.
        rankScore: z.number().optional(),
        createdAt: z.number(),
        messageCount: z.number(),
      })),
    }),
    description: 'Perform semantic search on conversation history (status-aware: distinguishes no-match from unavailable backend)',
  }),

  // Deep full-text search across all message content
  'search:conversations-deep': defineInvokeChannel({
    channel: 'search:conversations-deep',
    request: z.object({
      query: z.string(),
      requestId: z.string(), // For cancellation - stale results are ignored
      // F2: when set, only scan conversations last active at/after this timestamp (ms).
      // Mirrors the sidebar recency chip so "Search all messages" honours the time window.
      updatedAfter: z.number().optional(),
    }),
    response: z.object({
      results: z.array(z.object({
        sessionId: z.string(),
        title: z.string().nullable(),
        matchPreview: z.string(), // ~100 chars around first match
        matchCount: z.number(), // Number of matching messages
      })),
      requestId: z.string(), // Echo back for client-side staleness check
      truncated: z.boolean(), // True if more results exist beyond limit
    }),
    description: 'Deep full-text search across message content (slower, explicit opt-in). Case-insensitive substring match, scoped by updatedAfter when set. Returns up to 200 results.',
  }),

  'search:conversation-index-status': defineInvokeChannel({
    channel: 'search:conversation-index-status',
    request: z.void(),
    response: z.object({
      totalEmbeddings: z.number(),
      lastIndexedAt: z.number().nullable(),
      lastReconcileAt: z.number().nullable(),
      isInitialized: z.boolean(),
      embeddingModel: z.string(),
      indexedSessionIds: z.array(z.string()),
    }),
    description: 'Get the current status of the conversation index',
  }),

  'search:similar-conversations': defineInvokeChannel({
    channel: 'search:similar-conversations',
    request: z.object({
      sessionId: z.string(),
      limit: z.number().optional(),
    }),
    response: z.object({
      results: z.array(z.object({
        sessionId: z.string(),
        title: z.string(),
        score: z.number(),
        createdAt: z.number(),
        messageCount: z.number(),
      })),
      status: z.enum(['ok', 'source_not_indexed', 'index_not_ready', 'demo_mode', 'error']),
    }),
    description: 'Find conversations similar to the given session',
  }),

  // Cost summary channel (category-aware aggregation)
  'search:cost-summary': defineInvokeChannel({
    channel: 'search:cost-summary',
    request: z.object({
      startTs: z.number().optional(),
      endTs: z.number().optional(),
      categories: z.array(z.string()).optional(),
      excludeCategories: z.array(z.string()).optional(),
    }),
    response: z.object({
      total: z.number(),
      byCategory: z.record(z.string(), z.number()),
      byModel: z.record(z.string(), z.number()),
      entryCount: z.number(),
      turnCount: z.number(),
      byAutomationType: z.record(z.string(), z.number()),
      byAuthMethod: z.record(z.string(), z.number()),
      totalInputTokens: z.number(),
      totalOutputTokens: z.number(),
      totalCacheReadTokens: z.number(),
      totalCacheCreationTokens: z.number(),
      totalPromptTokens: z.number(),
      activeSessionCount: z.number(),
    }),
    description: 'Get category-aware cost summary from persistent cost ledger',
  }),

  // Atlas visualization channels - semantic map of workspace files
  'search:atlas-projection': defineInvokeChannel({
    channel: 'search:atlas-projection',
    request: z.object({
      forceRecompute: z.boolean().optional(),
      includeEmbeddings: z.boolean().optional(), // Include embeddings for semantic search; neighbors hydrate via Stage 6 IPC.
    }),
    response: z.object({
      nodes: z.array(z.object({
        path: z.string(),
        relativePath: z.string(),
        x: z.number(),
        y: z.number(),
        z: z.number(),
        extension: z.string(),
        chunkCount: z.number(),
        // Phase 7: Semantic search support
        embedding: z.array(z.number()).optional(), // 384-dim normalized embedding
        // Stage 5: projection intentionally omits neighbors; Stage 6 hydrates them separately.
        neighbors: z.array(z.object({
          path: z.string(),
          similarity: z.number(),
        })).optional(), // Top-5 neighbors with similarity scores
        // Phase 8: Recent file highlight + enhanced tooltips
        mtime: z.number().optional(), // File modification timestamp (ms since epoch)
        // Phase 9: Topic detection
        topic: z.string().optional(), // Detected topic name (e.g., "Meetings", "Research")
      })),
      // Phase 11: LOD clusters for large dataset visualization
      clusters: z.array(z.object({
        id: z.number(),
        centroid: z.object({
          x: z.number(),
          y: z.number(),
          z: z.number(),
        }),
        nodeCount: z.number(),
        nodePaths: z.array(z.string()),           // All file paths in cluster
        representativePaths: z.array(z.string()), // Top-5 closest to centroid
        label: z.string().nullable(),             // Topic label if dominant
      })),
      count: z.number(),
      totalFileCount: z.number(), // Total indexed files (may differ from count if sampled)
      computedAt: z.number(),
      cached: z.boolean(),
    }),
    description: 'Get PCA-projected file coordinates for Atlas visualization. With includeEmbeddings=true, includes embedding vectors; node.neighbors stays undefined until Stage 6 neighborhood IPC hydrates it. Includes LOD clusters for large datasets.',
  }),

  'search:atlas-neighbors': defineInvokeChannel({
    channel: 'search:atlas-neighbors',
    request: z.object({
      path: z.string(),
      limit: z.number().optional(),
    }),
    response: z.object({
      neighbors: z.array(z.object({
        path: z.string(),
        relativePath: z.string(),
        score: z.number(),
      })),
    }),
    description: 'Get k-nearest neighbor files for a node (lazy edge loading)',
  }),

  'search:atlas-neighborhood': defineInvokeChannel({
    channel: 'search:atlas-neighborhood',
    request: ATLAS_NEIGHBORHOOD_REQUEST_SCHEMA,
    response: ATLAS_NEIGHBORHOOD_RESPONSE_SCHEMA,
    description: 'Get materialized top-K neighbor files for many Atlas nodes',
  }),

  // Phase 7: Semantic search query embedding
  'search:atlas-embed-query': defineInvokeChannel({
    channel: 'search:atlas-embed-query',
    request: z.object({
      query: z.string(),
    }),
    response: z.object({
      embedding: z.array(z.number()), // 384-dim normalized embedding
    }),
    description: 'Embed a search query for Atlas semantic filtering. Returns L2-normalized 384-dim vector.',
  }),

  // Atlas AI Insights - "The gist" file summary
  'search:atlas-summarize-file': defineInvokeChannel({
    channel: 'search:atlas-summarize-file',
    request: z.object({
      filePath: z.string(),
    }),
    response: z.object({
      summary: z.string().nullable(),
      error: z.string().optional(),
    }),
    description: 'Generate AI summary of a file for Atlas tooltip',
  }),

  // Atlas AI Insights - "Zoom out" neighborhood theme
  'search:atlas-summarize-neighborhood': defineInvokeChannel({
    channel: 'search:atlas-summarize-neighborhood',
    request: z.object({
      centerFilePath: z.string(),
      neighborFilePaths: z.array(z.string()),
    }),
    response: z.object({
      insight: z.string().nullable(),
      error: z.string().optional(),
    }),
    description: 'Generate AI insight about what theme connects a cluster of files. Reads file contents on backend.',
  }),

  // Atlas AI Insights - "Ask" question about files
  'search:atlas-ask-question': defineInvokeChannel({
    channel: 'search:atlas-ask-question',
    request: z.object({
      centerFilePath: z.string(),
      neighborFilePaths: z.array(z.string()),
      question: z.string(),
    }),
    response: z.object({
      answer: z.string().nullable(),
      error: z.string().optional(),
    }),
    description: 'Ask a question about a file and its neighbors in Atlas. Reads file contents on backend.',
  }),
} as const;
