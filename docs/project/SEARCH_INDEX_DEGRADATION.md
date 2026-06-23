---
description: "Implementation reference for search unavailable-vs-empty status, FTS degradation telemetry, and semantic-index health checks."
last_updated: "2026-06-18"
---

# Search index degradation and honest status

**Intent:** Search surfaces must never tell a user (or agent) they have *zero matches* when the backend is still warming up or temporarily broken. A genuine no-match is `status: 'ok'` with an empty result set; anything else is *unavailable*, not empty.

**UX contract (overview):** [SEARCH.md § Unavailable vs no results](SEARCH.md#unavailable-vs-no-results). **Semantic-search architecture and FTS fallback behaviour:** [SEMANTIC_SEARCH.md § Index health and degradation](SEMANTIC_SEARCH.md#index-health-and-degradation).

## Status discriminant (shared contract)

All status-aware search APIs use the same four-valued union:

| Status | Meaning | User-facing stance |
|--------|---------|-------------------|
| `ok` | Query ran (or search not needed) | Empty → genuine no-match; non-empty → results |
| `index_not_ready` | LanceDB table/index not open yet | "Still warming up…" |
| `embedding_unavailable` | Query embedding could not be generated | "Temporarily unavailable" |
| `error` | Unexpected failure after prerequisites were met | "Temporarily unavailable" |

Legacy wrappers (`semanticSearch()`, `searchConversations()`) still return `[]` only — use status-aware APIs on any path that renders empty-state copy or agent conclusions.

## Status-aware entry points

| Surface | Status API | Legacy wrapper | Signpost |
|---------|-----------|----------------|----------|
| **Workspace files** (`@files`, plugin memory) | `semanticSearchWithStatus()` | `semanticSearch()` | `src/main/services/fileIndexService/search.ts` — `FileSearchStatus`, `FileSearchStatusResult` |
| **Conversations** (MCP bridge) | `searchConversationsWithStatus()` | `searchConversations()` | `src/main/services/conversationIndexService.ts` — `ConversationSearchStatus` |
| **Sources** (meetings/emails metadata) | `searchSources()` → `SourceSearchStatus` | — (always status-aware) | `src/core/services/sourceMetadataStore.ts` — adapter maps `FileSearchStatus` from injected `semanticSearchWithStatus` |

**Renderer note:** `search:conversations-semantic` IPC still calls `searchConversations()` (results-only). MCP and agent-tool paths use the status-aware APIs below.

## Agent tools: `success: false` when unavailable

Super-mcp package `resources/mcp/rebel-search-and-conversations/server.cjs` tools `rebel_search_files` and `rebel_search_sources` call the inbox bridge; handlers live in `src/core/services/inbox/inboxBridgeStateMachine.ts`.

**Pattern:** bridge returns HTTP 200 with `success: false` and an `error` string when `status !== 'ok'` (and, for hybrid source search, when semantic was needed but yielded nothing — the *hybrid-honesty rule*). MCP handlers check `!result.success` **before** empty-result copy so unavailable never renders as "No relevant files found" / "No sources found".

| Tool | Bridge route | Status source |
|------|-------------|---------------|
| `rebel_search_files` | `POST /file-search` | `semanticSearchWithStatus()` |
| `rebel_search_sources` | `POST /sources/search` | `sourceMetadataStore.searchSources()` + `sourceSemanticSearchAdapter` |
| `rebel_search_conversations` (related) | `POST /conversations/search` | `searchConversationsWithStatus()` |

Copy mapping (files/sources): `error` → "Search is temporarily unavailable."; warming states → "Search is still warming up…".

## FTS degradation (orthogonal to unavailable)

When the **keyword (FTS) half** of hybrid file search fails, search **still returns `status: 'ok'`** — vector-only ranking continues. This is a quality dip, not "search is down."

| Phase | Mechanism | Signpost |
|-------|-----------|----------|
| **Build-time** | `ensureFTSIndexes()` sets `ftsStatus`; failure does not block vector search | `src/main/services/fileIndexService/index.ts` |
| **Query-time** | Hybrid/rerank fallback to vector-only without mutating `ftsStatus` | `src/main/services/fileIndexService/search.ts` |

**Sentry known conditions** (`src/core/sentry/knownConditions.ts`) — captured once per process/workspace phase, not per query:

| Condition | When |
|-----------|------|
| `file_index_fts_degraded` | FTS build/verify failed (`ensureFTSIndexes`, `phase: 'build'`) or per-query hybrid/rerank fallback (`search.ts`, `phase: 'runtime'`) |
| `file_index_semantic_search_failed` | Unexpected post-embedding failure in `semanticSearchWithStatus()` (would otherwise look like no results) |

Inspect current FTS state: `getFtsStatus()` in `fileIndexService/index.ts`.

## Diagnostics health check

Desktop-only semantic-index health: `checkSemanticIndexHealth()` in `src/main/services/health/checks/semanticSearch.ts`.

| Check | Condition | Severity | Copy intent |
|-------|-----------|----------|-------------|
| Index not open | `!hasIndex()` | `warn` | Files still findable by name (Quick Open); meaning-based ranking returns when index opens — not "your files are missing" |
| FTS build failed | `getFtsStatus() === 'failed'` | `warn` (not `fail`) | "Keyword search ranking is temporarily reduced — search still works"; vector + name search unaffected |
| Model mismatch | `embeddingModel !== CURRENT_EMBEDDING_MODEL` | `warn` | Reindex recommended |

Embedding worker readiness is a separate check: `checkEmbeddingServiceReady()` in the same file.

## Related docs

- [SEARCH.md](SEARCH.md) — search-system overview and UX contract table
- [SEMANTIC_SEARCH.md](SEMANTIC_SEARCH.md) — LanceDB hybrid retrieval, indexing flow, operational troubleshooting
- [DIAGNOSTICS.md](DIAGNOSTICS.md) — health-check categories surfaced in Diagnostics
