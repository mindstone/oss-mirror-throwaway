---
description: "Overview of Rebel's file, conversation, and semantic search systems, with signposts to the implementation docs."
last_updated: "2026-06-18"
---

# Search Systems Overview

Mindstone Rebel has multiple search systems serving different purposes. This document provides an overview and signposts to detailed documentation.

## Unavailable vs no results

**UX contract:** when a search backend is still warming up or temporarily broken, every surface must say search is **unavailable** — not that the user has zero matching files, sources, or conversations. A genuine no-match is `status: 'ok'` with an empty result set.

| Situation | User-facing stance | Implementation signpost |
|-----------|-------------------|-------------------------|
| Index/embedding not ready | "Search is still warming up…" | `semanticSearchWithStatus()` → `FileSearchStatus` in `src/main/services/fileIndexService/search.ts` |
| Unexpected backend failure | "Search is temporarily unavailable." | Same status path; agent tools return `success: false` (not an empty hit list) |
| Query ran, nothing matched | "No … found" empty state | `status: 'ok'` + `results: []` / `sources: []` |

**Agent tools** (super-mcp `RebelSearch` package): `rebel_search_files` and `rebel_search_sources` route through `inboxBridgeStateMachine.ts` (`POST /file-search`, `POST /sources/search`) and consume `semanticSearchWithStatus()` / `sourceMetadataStore.searchSources()` so unavailable backends never render as "No relevant files found" / "no sources". Sidebar **conversation search is status-aware too** (260619): `search:conversations-semantic` returns `{ status, results }` (via `searchConversationsWithStatus()`), and `useSessionSearch.ts` renders a warming / temporarily-unavailable state distinct from a genuine no-match — see the Conversation Search section below.

Consolidated implementation reference: [SEARCH_INDEX_DEGRADATION.md](SEARCH_INDEX_DEGRADATION.md).

FTS/semantic **index degradation** (keyword half failed but vector search still works) is orthogonal — search still returns `ok`; see [SEMANTIC_SEARCH.md § Index health and degradation](SEMANTIC_SEARCH.md#index-health-and-degradation).

## Search Types

| System | Purpose | Technology | Documentation |
|--------|---------|------------|---------------|
| **Fuzzy Autocomplete** | @-mention files/conversations | Fuse.js (extended search) | This doc |
| **Semantic Search** | Workspace file content | LanceDB native FTS + vector + RRF | [SEMANTIC_SEARCH.md](SEMANTIC_SEARCH.md) |
| **Conversation Search** | Sidebar conversation search | LanceDB hybrid (FTS on `title` + `search_text` + semantic embeddings) + deep search opt-in | [SEMANTIC_SEARCH.md](SEMANTIC_SEARCH.md) |

## Fuzzy Autocomplete (@-mentions)

Used when typing `@` in the composer to reference files or past conversations.

### See Also

- [CONVERSATION_MENTIONS.md](CONVERSATION_MENTIONS.md) - @-mention UX, token format, context resolution
- [LIBRARY_AND_FILE_ACCESS.md](LIBRARY_AND_FILE_ACCESS.md) - File system access and workspace structure
- `src/renderer/utils/librarySearch.tsx` - File search implementation
- `src/renderer/utils/conversationSearch.tsx` - Conversation title search implementation

### How It Works

1. User types `@` followed by search terms
2. Query is tokenized (split on hyphens/spaces)
3. Fuse.js extended search matches each term independently
4. Results combine files (from workspace) and conversations (from history)

### Query Transformation

Queries are transformed for multi-term matching:

```
"chr-mov"     → "'chr 'mov"      (matches "Christmas Movie")
"quiz guess"  → "'quiz 'guess"   (matches "Quiz Guessing")
"christmas"   → "'christmas"     (single term)
```

The `'` prefix is Fuse.js "include-match" syntax - each term must appear somewhere in the target string.

### Configuration

**Conversation search** (`conversationSearch.tsx`):
```typescript
{
  keys: ['title'],
  threshold: 0.4,
  useExtendedSearch: true,
  ignoreLocation: true,
  minMatchCharLength: 1,
  distance: 200
}
```

**File search** (`librarySearch.tsx`):
```typescript
{
  keys: [
    { name: 'node.name', weight: 0.5 },
    { name: 'fullPath', weight: 0.1 },
    { name: 'skillMeta.description', weight: 0.3 },
    { name: 'skillMeta.name', weight: 0.1 }
  ],
  threshold: 0.3,
  useExtendedSearch: true,
  ignoreLocation: false,
  minMatchCharLength: 2,
  distance: 50
}
```

### Prefix Boosting

Both file and conversation search apply **prefix boosting** to improve ranking when the query matches the start of a result or a word component:

| Boost Type | Factor | Example |
|------------|--------|---------|
| Prefix match | 0.5x score | `sou` prefers `source-capture` over `blah-source` |
| Exact component | 0.5x score | `skill` in `write-skill.md` |
| Component prefix | 0.7x score | `ski` in `write-skill.md` |

This ensures intuitive ordering when typing partial words - results starting with your query rank higher than results containing it elsewhere.

### Trade-offs

| Behavior | Status | Notes |
|----------|--------|-------|
| Multi-term search (`chr-mov`) | Supported | Via extended search mode |
| Out-of-order words | Supported | `movie christmas` matches `Christmas Movie` |
| Typo tolerance | Limited | Extended search is stricter than fuzzy |
| Very short queries (2 chars) | Works | But may not rank optimally |
| Prefix preference | Supported | `sou` prefers `source-*` over `*-source` |

### Key Files

| File | Purpose |
|------|---------|
| `src/renderer/utils/librarySearch.tsx` | `searchFiles()` - fuzzy file/directory search |
| `src/renderer/utils/conversationSearch.tsx` | `searchSessionTitles()` - conversation autocomplete |
| `src/renderer/features/mentions/hooks/useConversationMentions.ts` | Conversation mention hook |
| `src/renderer/features/library/hooks/useLibraryMentions.ts` | File mention hook |
| `src/renderer/features/composer/hooks/useMentionAutocomplete.ts` | Unified autocomplete state |
| `src/renderer/App.tsx` | `mentionResultsForQuery()` - combines file + conversation results |

### Testing

Comparison test script: `scripts/test-fuzzy-search-comparison.ts`

```bash
npx tsx scripts/test-fuzzy-search-comparison.ts
```

Tests Fuse.js configurations against uFuzzy with real session titles.

## File Search (@files)

Hybrid search for workspace file content using LanceDB native FTS + vector search with Reciprocal Rank Fusion (RRF). Triggered by `@files` keyword.

**Full documentation**: [SEMANTIC_SEARCH.md](SEMANTIC_SEARCH.md)

### Quick Reference

- **Technology**: BGE-small-en-v1.5 embeddings + LanceDB native FTS + vector + RRF
- **Trigger**: Include `@files` in message
- **Scope**: Searches file content (not just names)
- **Implementation**: `semanticSearchWithStatus()` in `src/main/services/fileIndexService/search.ts` (`semanticSearch()` is the legacy `[]`-only wrapper)
- **Results**: Injected into agent context as markdown

## Conversation Search (Sidebar)

Sidebar search combines LanceDB hybrid conversation search, recency filtering, and explicit deep-search results.

**Related docs**: [SEMANTIC_SEARCH.md](SEMANTIC_SEARCH.md), [ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md](ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md)

### Quick Reference

- **Technology**: LanceDB hybrid retrieval (FTS on `title` + `search_text`, semantic embeddings, RRF reranking) + an instant renderer-side **title-substring floor** + recency filtering.
- **Scope**: Main results search titles + `search_text` (all user messages + first assistant response). "Search all messages" does a broader full-message scan.
- **Implementation**: Orchestrated in `src/renderer/features/agent-session/hooks/useSessionSearch.ts`; backend matching in `conversationIndexService.ts` (`searchConversationsWithStatus` → `buildConversationResults`).
- **Used by**: `useSessionSearch.ts` hook

**Behavior notes (260619 — conversation-search reliability work):**
- **Lexical keep-rule (F1)**: `buildConversationResults` keeps a row if it's a genuine keyword/FTS hit (query in `title`/`search_text`) OR clears the cosine floor, ranked by RRF `rankScore` — so exact keyword/title matches aren't dropped by a vector-only similarity cutoff. The lexical exemption is **opt-in** (`lexicalExemption`), enabled only for explicit user search (sidebar + the `rebel_conversations_search` tool); silent auto-context-injection stays semantic-strict.
- **Honest availability (F4)**: distinguishes warming-up / unavailable / error from a genuine no-match (see "Unavailable vs no results" above).
- **Real time filtering (F2)**: the recency chip constrains both quick search and "Search all messages" (`updatedAfter` bound).
- **Exhaustive-within-window quick search (260620)**: when a recency chip is active, the sidebar sends `updatedAfter` to `search:conversations-semantic`. `searchConversationsWithStatus` (`conversationIndexService.ts`) resolves the **exact** in-window conversation set from **fresh** session-summary timestamps (`listSessions()`, not the lagging index `updatedAt`) and applies `sessionId IN (...)` to the LanceDB query, returning the whole windowed set ranked by relevance — so a relevant match ranked beyond the old top-100 now appears, and the renderer's session-type filter operates over the full in-window set. Above `RECENCY_SCOPE_MAX_IDS` (500) in-window conversations the IN-clause is impractical, so it falls back to a grace-buffered (`INDEX_LAG_GRACE_MS` = 24h) prefilter on the index `updatedAt` + a logged warning (the renderer post-filter stays the precise boundary; "Search all messages" stays exhaustive). `buildRecencyScope` is the pure, unit-tested windowing policy.
- **Index freshness (F3)**: renaming a conversation re-embeds it so it's findable by its new title.
- **Short-query fallback (F5)**: 1-2 char / proper-noun queries get instant title-substring matches.
- **Automations searchable (F7)**: automation sessions are indexed and appear under the Automations filter.

**Note**: This is separate from `searchSessionTitles()` which only searches titles for @-mention autocomplete.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        User Input                                │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
              ▼               ▼               ▼
     ┌────────────┐  ┌────────────┐  ┌────────────┐
     │ @-mention  │  │ @semantic  │  │  Sidebar   │
     │ autocomplete│  │  -search   │  │  search    │
     └─────┬──────┘  └─────┬──────┘  └─────┬──────┘
           │               │               │
           ▼               ▼               ▼
     ┌────────────┐  ┌────────────┐  ┌─────────────────────┐
     │  Fuse.js   │  │  LanceDB   │  │ title floor (instant)│
     │  Extended  │  │  Vectors   │  │ + LanceDB hybrid     │
     │            │  │            │  │ (FTS+vector+RRF,     │
     │            │  │            │  │ status-aware)        │
     └─────┬──────┘  └─────┬──────┘  └─────┬───────────────┘
           │               │               │
           ▼               ▼               ▼
     ┌────────────┐  ┌────────────┐  ┌────────────┐
     │ Autocomplete│  │  Context   │  │  Session   │
     │  popover   │  │  injection │  │  highlight │
     └────────────┘  └────────────┘  └────────────┘
```

## Development Notes

### Adding New Search Types

If adding a new search system:

1. Consider whether fuzzy (Fuse.js) or semantic (vectors) is appropriate
2. For fuzzy: use extended search mode with query transformation for multi-term support
3. For semantic: integrate with existing LanceDB infrastructure
4. Document in this file and create detailed doc if complex

### Fuse.js Extended Search Syntax

Reference for query transformation:

| Syntax | Meaning | Example |
|--------|---------|---------|
| `'term` | Include match (must contain) | `'chr` matches "christmas" |
| `=term` | Exact match | `=christmas` matches only "christmas" |
| `!term` | Exclude | `!draft` excludes results with "draft" |
| `^term` | Prefix | `^chr` matches "christmas" not "torch" |
| `term$` | Suffix | `mas$` matches "christmas" |
| `term1 term2` | AND (both required) | `'chr 'mov` both must match |
| `term1 \| term2` | OR (either) | `'christmas \| 'xmas` |

Our implementation uses `'term` (include-match) for each token, joined with spaces (implicit AND).
