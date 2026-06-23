---
description: "Atlas 3D workspace visualization architecture — embedding projection, lazy WebGL loading, caching, worker lifecycle, limits"
last_updated: "2026-05-25"
---

# Atlas Visualization

The Atlas is a 3D semantic visualization of workspace files shown in the Library when `View as: Atlas` is selected. It projects file embeddings onto a 3D canvas where similar files cluster together.

## See Also

- [`src/main/services/atlasService.ts`](../../src/main/services/atlasService.ts) — Main process: PCA projection, caching, topic classification, neighbor lookup
- [`src/main/workers/atlasWorker.ts`](../../src/main/workers/atlasWorker.ts) — Worker thread: PCA dimensionality reduction
- [`src/renderer/features/atlas/`](../../src/renderer/features/atlas/) — Renderer: React components and hooks for 3D visualization
- [`src/renderer/features/atlas/components/AtlasCanvas.tsx`](../../src/renderer/features/atlas/components/AtlasCanvas.tsx) — WebGL 3D canvas using react-force-graph-3d/Three.js
- [SEMANTIC_SEARCH.md](SEMANTIC_SEARCH.md) — Underlying embedding system that Atlas consumes
- [LIBRARY_AND_FILE_ACCESS.md](LIBRARY_AND_FILE_ACCESS.md) — Library UI where Atlas lives

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Renderer (React)                              │
│  ┌─────────────────┐                                            │
│  │   AtlasView     │ ──lazy──▶ AtlasCanvas (WebGL/Three.js)     │
│  └────────┬────────┘         Only loaded when Atlas view active │
│           │                                                      │
│  ┌────────▼────────┐                                            │
│  │useAtlasProjection│  Fetches nodes/clusters on demand         │
│  └────────┬────────┘                                            │
└───────────┼─────────────────────────────────────────────────────┘
            │ IPC: searchApi.atlasProjection()
┌───────────▼─────────────────────────────────────────────────────┐
│                    Main Process                                  │
│  ┌─────────────────┐                                            │
│  │  atlasService   │  Lazy computation, aggressive caching      │
│  └────────┬────────┘                                            │
│           │ (only when called)                                   │
│  ┌────────▼────────┐                                            │
│  │  atlasWorker    │  Worker thread: PCA projection             │
│  └─────────────────┘  Created per-request, terminated after     │
│                                                                  │
│  ┌─────────────────┐                                            │
│  │embeddingService │  BGE model (GPU/CPU) - already running     │
│  └─────────────────┘  for semantic search regardless of Atlas   │
└──────────────────────────────────────────────────────────────────┘
```

## Resource Usage When Atlas Is NOT Open

**Key finding: Atlas has minimal resource impact when not actively viewed.**

### What Does NOT Run:

1. **WebGL/Three.js Canvas** — `AtlasCanvas` is lazy-loaded (`React.lazy()`) and only mounted while the Atlas view is active. When unmounted:
   - WebGL context is disposed (see cleanup effect in AtlasCanvas)
   - No GPU memory for 3D rendering
   - No animation frames

2. **PCA Worker Thread** — `atlasWorker.ts` is spawned on-demand per projection request and terminated immediately after. No persistent worker.

3. **Atlas-specific IPC calls** — `useAtlasProjection` hook only fetches when mounted. No background polling.

4. **Projection computation** — `getAtlasProjection()` is only called when `AtlasView` renders.

### What DOES Run (But Not Due to Atlas):

1. **Embedding Service** — The BGE embedding model runs regardless of Atlas for:
   - File indexing (fileIndexService)
   - Semantic search queries
   - This is ~200-400MB RAM (model) but is NOT Atlas-specific

2. **File Index** — `fileIndexService` indexes workspace files and stores chunk embeddings plus materialized file-level vectors in LanceDB. Atlas reads the Stage 5 `file_vectors` table and doesn't trigger indexing. Atlas neighbor edges are precomputed in a per-workspace LanceDB table named `file_neighbors` (top-K neighbors per source file), populated asynchronously after `file_vectors` lazy-fill completes.

3. **Topic Embeddings Cache** — Computed lazily on first Atlas view, then cached in memory (~few KB per workspace). Only populated when Atlas is opened.

### When Atlas View Is Active:

| Resource | Usage | Notes |
|----------|-------|-------|
| WebGL Context | 1 context | Three.js renderer |
| GPU VRAM | ~50-150MB | Depends on node count |
| CPU (idle) | Minimal | No physics simulation |
| CPU (interaction) | Brief spikes | Hover/click, camera animation |
| Main-thread memory | ~5-20MB | Node/cluster data |
| Worker thread | Temporary | PCA computation only |

## Design Decisions

### Lazy Loading Over Eager Loading
Atlas uses `React.lazy()` for `AtlasCanvas` specifically because Three.js and react-force-graph are heavy dependencies. This ensures:
- Faster initial app load
- No WebGL context until needed
- Memory only allocated when the Atlas view is active

### PCA Over UMAP
Originally planned to use UMAP, but switched to PCA because:
- UMAP has O(n²) complexity and stack overflow issues with 2000+ files
- PCA is O(n*d) and handles 20,000+ files instantly
- Embeddings already encode semantic similarity, so PCA preserves clustering

### On-Demand Worker Threads
Atlas workers are created per-request rather than kept alive because:
- Projection is infrequent (cached aggressively)
- Worker overhead is minimal for single computation
- Avoids zombie workers during shutdown

### Aggressive Caching
Projection results are cached per-workspace and only invalidated when:
- File count changes >10%
- User clicks "Refresh" button
- Workspace changes

## Gotchas

1. **WebGL Context Limits** — Browsers limit WebGL contexts (~16). The cleanup effect in AtlasCanvas disposes the context on unmount. If you see WebGL errors, check for context leaks.

2. **Shutdown Race** — `atlasService` checks `isShuttingDown()` before spawning workers to prevent V8 crashes during app exit.

3. **Symlink Performance** — Path conversion from absolute to workspace-relative uses pre-computed symlink maps for O(1) lookups instead of O(n) filesystem operations.

## Future Considerations

- LOD (Level of Detail) rendering for very large workspaces (20k+ files)
- Consider web worker for client-side clustering if server-side clusters aren't sufficient
- Potential to pre-compute projection during file indexing (currently on-demand)

## Appendix: Resource Usage Review Findings

Independent review (Jan 2026) identified these additional considerations:

### Memory Retention After First Use
- `projectionCache` and `topicEmbeddingsCache` persist in main process memory after switching away from the Atlas view
- File embeddings are read from the materialized `file_vectors` table rather than retained in an Atlas-local embedding cache
- Projection/topic caches are cleared on workspace change

### Main Thread Compute
- The old inline O(n²) neighbor loop is gone
- Atlas neighbor edges arrive through Stage 6's two-phase IPC (`search:atlas-neighborhood`) rather than being computed inline with projection
- k-means clustering still runs on the main thread after the worker returns

### Minor Cleanup Gaps
- Some short `setTimeout` calls in AtlasCanvas (camera animation, zoomToFit) aren't explicitly cleared on unmount
- Low risk since they're brief, but could attempt state updates after unmount

### Verified Working Well
- Lazy loading correctly defers Three.js/react-force-graph bundle
- WebGL context properly disposed on unmount
- Worker threads are ephemeral and correctly terminated
- Graceful shutdown prevents zombie workers
