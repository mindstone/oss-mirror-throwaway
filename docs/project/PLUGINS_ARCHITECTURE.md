---
description: "Plugin architecture — compiler pipeline, module resolution, file structure, IPC channels, and plugin lifecycle"
last_updated: "2026-03-27"
---

# Plugin Architecture

Technical architecture of Rebel's plugin system, including the compiler pipeline, module resolution, file structure, and IPC channels.

**See also:** [PLUGINS_OVERVIEW](./PLUGINS_OVERVIEW.md) — high-level overview and signposting | [PLUGINS_API_REFERENCE](./PLUGINS_API_REFERENCE.md) — API hooks and components | [PLUGINS_SECURITY](./PLUGINS_SECURITY.md) — security model and permissions


## Architecture Overview

```
User prompt → rebel_plugins_create tool (via MCP)
                → IPC to renderer (plugins:compile-and-register)
                    → Sucrase compile (TSX → CJS)
                    → Import rewriting (require → __REBEL_MODULES__)
                    → AST validation (default export, allowed imports, no forbidden patterns)
                    → new Function() execution → React component
                    → Plugin registry (in-memory, reactive)
                    → Main-pane tab rendered via PluginSurface
                → Structured result back to main
                → Persisted to per-plugin files on disk (survives restart)
```

**Plugin lifecycle:** register → compile → validate → load → render → (hot-reload on update) → persist.

**Module resolution:** Compiled plugin code calls `require("react")` etc., which the import rewriter maps to `globalThis.__REBEL_MODULES__[...]`. The module registry is populated at app startup with React, JSX runtime, plugin API, and plugin UI modules.


## Compiler Pipeline

The compilation pipeline is orchestrated by `pluginCompiler.ts`:

1. **Sucrase compile** — ~50KB, 0.07ms per compile. Strips TypeScript, transforms JSX, converts ESM→CJS. Lazy-loaded at first compile to avoid Vite dev server issues.
2. **Import rewriting** — Sucrase converts ESM imports to `require()` calls; the import rewriter maps `require("@rebel/*")` → `globalThis.__REBEL_MODULES__["@rebel/*"]`. Simpler and more robust than ESM regex rewriting.
3. **AST validation** — Validates default export exists, only allowed imports, no forbidden patterns (`eval`, `document.write`, `innerHTML`).
4. **Module execution** — `new Function()` instead of Blob URL + `import()`. Simpler, avoids CSP concerns in Electron.


## File Structure

All plugin code lives under `src/renderer/features/plugins/`:

### Types & Core
- `types.ts` — Branded `PluginSurfaceId` type, `createPluginSurfaceId()` factory, type guards (`isPluginSurface`, `isBuiltInSurface`)

### Compiler Pipeline
- `compiler/pluginCompiler.ts` — Sucrase TSX→CJS compiler, orchestrates the full pipeline
- `compiler/importRewriter.ts` — Rewrites `require("@rebel/*")` and `require("react")` to `globalThis.__REBEL_MODULES__[...]`
- `compiler/astValidator.ts` — Validates default export exists, only allowed imports, no forbidden patterns (`eval`, `document.write`, `innerHTML`)
- `compiler/types.ts` — `PluginCompileResult`, `PluginCompileError` shared error contract

### Runtime
- `runtime/pluginLoader.ts` — Executes compiled code via `new Function()`, extracts default export
- `runtime/pluginModuleRegistry.ts` — Populates `globalThis.__REBEL_MODULES__` with React, JSX runtime, plugin API/UI; exposes `__REBEL_PLUGINS__` registration API

### Plugin API (`@rebel/plugin-api`)
- `api/pluginApiFactory.ts` — Creates all plugin API hooks; injected into `@rebel/plugin-api` module
- `api/lifecycleManager.ts` — Auto-cleans intervals, timeouts, and subscriptions on plugin unmount
- `api/types.ts` — TypeScript interfaces for full plugin API surface
- `api/useSources.ts` — `useSources()` hook (debounced IPC to source metadata store)
- `api/useSourceDocument.ts` — `useSourceDocument()` hook (loads full source content)
- `api/useAi.ts` — `useAi()` hook (constrained BTS model access with rate limiting)
- `api/useMeetings.ts` — `useMeetings()` hook (cached calendar meetings)
- `api/useClipboard.ts` — `useClipboard()` hook (write-only clipboard)
- `api/useMemorySearch.ts` — `useMemorySearch()` hook (enhanced with pathPrefix + configurable limit)
- `api/usePluginStorage.ts` — `usePluginStorage()` hook (per-plugin KV store)

### Plugin UI (`@rebel/plugin-ui`)
- `ui/PluginButton.tsx` — Wraps `@renderer/components/ui/Button`
- `ui/PluginCard.tsx` — Wraps `@renderer/components/ui/Card` + `CardContent`
- `ui/PluginInput.tsx` — Wraps `@renderer/components/ui/Input`
- `ui/PluginStack.tsx` — Custom CSS flexbox layout with design-token spacing
- `ui/PluginBadge.tsx` — Wraps `@renderer/components/ui/Badge`
- `ui/PluginTabs.tsx` — Wraps `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`
- `ui/PluginSelect.tsx` — Wraps `Select`
- `ui/PluginDialog.tsx` — Wraps `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogBody`, `DialogFooter`
- `ui/LoadingCard.tsx` — Uses `Spinner` component
- `ui/ErrorCard.tsx` — Themed error display card
- `ui/index.ts` — Barrel export for all plugin UI components

### Manifest & Registry
- `manifest/pluginManifest.ts` — Zod schema for plugin manifests, validation function
- `manifest/pluginRegistry.ts` — In-memory plugin store with `useSyncExternalStore`-compatible subscription, persistence integration (debounced 300ms), persisted plugin loading

### Components
- `components/PluginSurface.tsx` — React wrapper that compiles, loads, and renders a plugin; includes error boundary and revision-based hot-reload

### Hooks
- `hooks/useRegisteredPlugins.ts` — React hook using `useSyncExternalStore` for reactive plugin list

### Settings UI
- `src/renderer/features/settings/components/tabs/PluginsTab.tsx` — Settings management UI (View Source, Fork, Export, Import, Docs expand/collapse)
- `src/renderer/features/settings/components/tabs/PluginSourceViewer.tsx` — Read-only TSX source viewer dialog

### Type Declarations (for LLM context)
- `declarations/rebel-plugin-api.d.ts` — TypeScript declarations for `@rebel/plugin-api`
- `declarations/rebel-plugin-ui.d.ts` — TypeScript declarations for `@rebel/plugin-ui`

### Examples (for LLM few-shot prompting)
- `examples/conversation-list.tsx` — List conversations with navigation and badges
- `examples/sources-browser.tsx` — **Built-in catalog plugin**: browse/search memory sources with space display, context menus, markdown content rendering, tooltips, and related sources
- `examples/conversation-organizer.tsx` — Conversation tagging dashboard (replaced by sources-browser in catalog, kept for reference)
- `examples/research-hub.tsx` — Research workspace with memory search
- `examples/pomodoro-timer.tsx` — Pomodoro timer with session tracking

### Related files outside `features/plugins/`
- `src/shared/ipc/schemas/plugins.ts` — Zod schemas for plugin IPC channels
- `src/shared/ipc/channels/plugins.ts` — Plugin IPC channel definitions
- `src/main/ipc/pluginHandlers.ts` — Main-process IPC handlers (persist, load, clear, compile-and-register, sources, AI, meetings)
- `src/core/services/pluginAiRateLimiter.ts` — Sliding-window rate limiter for plugin AI calls (10/min/plugin)
- `src/main/services/pluginCompileBridge.ts` — MessageChannelMain bridge for main↔renderer compile requests
- `src/main/services/pluginFilePersistence.ts` — per-plugin file-based persistence (manifest.json + index.tsx per plugin directory)
- `src/core/services/pluginStorageStore.ts` — per-plugin key-value storage store
- `resources/mcp/rebel-plugins/server.cjs` — MCP server implementing `rebel_plugins_create`, `rebel_plugins_list`, and all other plugin tools
- `src/core/rebelCore/types.ts` — `PluginService` interface in `BuiltinToolContext`
- `src/core/rebelCore/pluginServiceProvider.ts` — Global getter/setter for PluginService instance
- `src/shared/ipc/schemas/pluginExportImport.ts` — Zod schemas for export/import request and result payloads


## IPC Channels

**Current plugin IPC channel count: 17.**

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `plugins:compile-and-register` | main → renderer (via MessageChannelMain) | Forward `rebel_plugins_create` request to renderer for compile+register |
| `plugins:persist-all` | renderer → main | Save all registered plugins to per-plugin files on disk |
| `plugins:load-persisted` | renderer → main | Load all persisted plugins on startup |
| `plugins:clear-persisted` | renderer → main | Clear all persisted plugins |
| `plugins:storage-get` | renderer → main | Get a per-plugin stored value |
| `plugins:storage-set` | renderer → main | Set a per-plugin stored value |
| `plugins:storage-delete` | renderer → main | Delete a per-plugin stored value |
| `plugins:storage-clear` | renderer → main | Clear all storage for one plugin |
| `plugins:export-plugin` | renderer → main | Export a plugin to `.rebel-plugin.json` via native save dialog |
| `plugins:import-plugin` | renderer → main | Import a plugin file via native open dialog |
| `plugins:memory-search` | renderer → main | Semantic search + optional `pathPrefix` filtering for `useMemorySearch()` |
| `plugins:search-sources` | renderer → main | Search/browse memory sources for `useSources()` |
| `plugins:get-source-document` | renderer → main | Read full source document content for `useSourceDocument()` |
| `plugins:ai-summarize` | renderer → main | Constrained BTS summarization for `useAi().summarize()` |
| `plugins:ai-extract` | renderer → main | Structured data extraction for `useAi().extractObject()` |
| `plugins:ai-generate` | renderer → main | Constrained text generation for `useAi().generate()` |
| `plugins:get-meetings` | renderer → main | Read cached calendar meetings for `useMeetings()` |
