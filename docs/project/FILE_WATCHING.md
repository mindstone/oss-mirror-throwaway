---
description: "File watching architecture for workspace changes — semantic indexing watcher, library refresh watcher, chokidar settings, and troubleshooting"
last_updated: "2026-02-06"
---

# File Watching

File watching in Mindstone Rebel uses chokidar to monitor workspace directories for changes. There are two independent file watcher services, each serving a distinct purpose.

## See Also

- `src/main/services/fileWatcherService.ts` — Semantic search indexing watcher implementation
- `src/main/services/workspaceWatcherService.ts` — UI file tree refresh watcher implementation
- [LIBRARY_AND_FILE_ACCESS](LIBRARY_AND_FILE_ACCESS.md) — Workspace selection and file operations
- [SYSTEM_ARCHITECTURE](ARCHITECTURE_OVERVIEW.md) — Overall system architecture

## Overview

Both watchers start automatically when a workspace (`coreDirectory`) is configured:

1. **On app startup** (`src/main/index.ts`) — if `coreDirectory` is set
2. **When settings change** (`src/main/ipc/settingsHandlers.ts`) — restarts watchers with new directory

## File Watcher Service (Semantic Search)

**Location:** `src/main/services/fileWatcherService.ts`

Watches workspace files and triggers embedding/indexing into the LanceDB vector store for semantic search.

### Key Features

- **Async queue with backpressure** — MAX_QUEUE_SIZE of 10,000 items prevents memory exhaustion
- **Concurrency control** — Processes 2 files in parallel with inter-file delays
- **Smart rescan skipping** — Skips full rescan if index was updated within 1 hour
- **Deduplication** — Keeps only the latest operation per file in queue
- **`awaitWriteFinish`** — 500ms stability threshold avoids indexing partial writes
- **Comprehensive ignore patterns** — 100+ patterns including secrets (`.env`, `*.pem`, etc.)

### Configuration

```typescript
const CONCURRENCY = 2;
const INTER_FILE_DELAY_MS = 20;
const MAX_QUEUE_SIZE = 10000;
const SKIP_RESCAN_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
```

### Chokidar Options

```typescript
{
  ignored: IGNORED_PATTERNS,  // 100+ patterns
  persistent: true,
  ignoreInitial: skipRescan,  // Skip if recent scan exists
  followSymlinks: true,
  depth: 10,
  usePolling: false,          // Native fs events
  awaitWriteFinish: {
    stabilityThreshold: 500,
    pollInterval: 100,
  },
  ignorePermissionErrors: true,
}
```

### Events Handled

- `add` — Queue file for indexing
- `change` — Queue file for re-indexing
- `unlink` — Queue file for removal from index
- `error` — Log error

## Workspace Watcher Service (UI Refresh)

**Location:** `src/main/services/workspaceWatcherService.ts`

Monitors the workspace directory and notifies the renderer to refresh the file tree UI.

### Key Features

- **True debounce with max-wait** — 1.5s debounce + 30s max-wait to batch rapid changes while guaranteeing periodic updates
- **Lightweight** — Just counts events and sends IPC notification
- **Directory events** — Handles `addDir`/`unlinkDir` for folder changes
- **Independent operation** — Works even if semantic indexing fails

### Configuration

Uses a true debounce (with max-wait) rather than simple throttle, so rapid bursts of file changes are batched into a single notification while still guaranteeing periodic updates during sustained activity.

```typescript
const DEBOUNCE_MS = 1500;
const MAX_WAIT_MS = 30000;
const MAX_WATCH_DEPTH = 12;
```

### Chokidar Options

```typescript
{
  ignored: IGNORED_PATTERNS,  // 12 basic patterns
  persistent: true,
  ignoreInitial: true,        // Always skip existing files
  followSymlinks: true,
  depth: MAX_WATCH_DEPTH,
  awaitWriteFinish: {
    stabilityThreshold: 300,
    pollInterval: 100,
  },
}
```

### Events Handled

- `add`, `addDir`, `unlink`, `unlinkDir` — Increment counter, schedule notification
- `error` — Log error

### IPC Output

Sends `library:changed` to all renderer windows with timestamp:
```typescript
window.webContents.send('library:changed', { timestamp: Date.now() });
```

## Troubleshooting

### File changes not detected
- Check if the file matches an ignore pattern
- Verify `usePolling: false` works on your filesystem (network drives may need polling)
- Check logs for watcher errors

### High CPU usage
- Large workspaces may cause initial scan load
- The semantic indexer has GC pauses every 50 files to reduce pressure
- Consider if `depth` limits are appropriate for your workspace

### Index not updating
- Check if `SKIP_RESCAN_THRESHOLD_MS` is causing skipped rescans
- Use `search:reindex` IPC with `force: true` to clear and rebuild

## Appendix: Comparison of File Watchers

| Aspect | `fileWatcherService` | `workspaceWatcherService` |
|--------|---------------------|---------------------------|
| **Purpose** | Semantic search indexing | UI file tree refresh |
| **Output** | Indexes to LanceDB vector store | Sends `library:changed` IPC |
| **Processing** | Async queue, embedding model | Simple debounce (1s) |
| **Ignore patterns** | 100+ (including secrets) | 12 basic patterns |
| **Depth limit** | 10 | 12 |
| **Directory events** | Files only | Files and directories |
| **`awaitWriteFinish`** | 500ms | 300ms |
| **`ignoreInitial`** | Conditional (skip if recent) | Always true |
| **Dependencies** | Embedding service, LanceDB | None (standalone) |
| **Failure isolation** | Independent | Independent |

### Why Two Watchers?

The current architecture uses two separate chokidar instances for separation of concerns:

1. **Different ignore patterns** — UI may show files that semantic search ignores (e.g., `.env` files visible in tree but not indexed)
2. **Different timing needs** — UI needs fast feedback; indexing needs stability
3. **Failure isolation** — If indexing fails, UI still works
4. **Simpler reasoning** — Each service has a single responsibility

### Future Consolidation Considerations

A potential optimization would consolidate into a single chokidar instance with event broadcasting. Tradeoffs:

- **Pro:** Single fs watcher = less overhead
- **Pro:** Consistent ignore patterns
- **Con:** UI would hide files that indexing ignores
- **Con:** Coupling between features
- **Con:** ~200ms extra latency on UI updates due to `awaitWriteFinish`

Currently, the duplication is minor overhead since chokidar uses native fs events efficiently.
