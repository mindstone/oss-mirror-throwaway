---
description: "Plugin extension system — overview, wave history, key decisions, and signposting to detailed sub-docs"
last_updated: "2026-03-28"
---

# Plugin Extension System

Rebel supports user-facing plugins — React TSX components that add custom tabs to the app shell. Plugins render as full main-pane surfaces (via `FlowPanelsShell`), using the same surface system as built-in tabs like Library, Settings, and Automations. Plugins are primarily AI-generated (Rebel writes them for the user via the `rebel_plugins_create` MCP tool), compiled inside the renderer, and rendered directly in the React tree.

**Current status:** v1 through Wave 5 shipped. Full read/write plugin platform: event system, write capabilities (messages, skills, inbox, automations), agent hooks (pre/post-turn), external connectivity (mediated HTTP), homepage widgets, chart components, and hardened security model with main-process permission enforcement. Standardized error envelope pattern (`PluginWriteResult<T>`) for all write operations. Trusted mode (no sandboxing). Desktop-only.


## See Also

**Sub-documents (detailed reference):**
- [PLUGINS_API_REFERENCE](./PLUGINS_API_REFERENCE.md) — Full `@rebel/plugin-api` hook documentation, `@rebel/plugin-ui` components, RebelApi shape, type declarations
- [PLUGINS_SECURITY](./PLUGINS_SECURITY.md) — Current trusted-mode security, known attack surface, planned Wave 5 permission architecture
- [PLUGINS_ARCHITECTURE](./PLUGINS_ARCHITECTURE.md) — Architecture overview, compiler pipeline, file structure, IPC channels (17 channels)

**Related documents:**
- [Planning doc](../plans/260322_plugin_extension_system.md) — Full design decisions, review history, risk mitigations, future stages, and septuple-review findings
- [Wave 5 planning doc](../plans/260327_plugin_wave5_infrastructure.md) — Extension platform expansion: events, write capabilities, agent hooks, homepage widgets
- [Research report](../research/260322_plugin_architecture_research.md) — Architecture research and spike results
- [Tutorial explainer](../tutorials/260322b_plugin_extension_system_explainer.html) — Interactive explainer of the plugin system
- [User-facing doc](../../rebel-system/help-for-humans/plugins-and-custom-tabs.md) — End-user guide for plugins
- [ARCHITECTURE_OVERVIEW](./ARCHITECTURE_OVERVIEW.md) — Overall system architecture (plugin section signposts here)


## Wave History

### Wave 5 (Shipped)

Extension platform transformation from read-only to full read/write. Major additions:

- **Event system:** `useRebelEvent()` for lifecycle events (turn:started/completed/error, conversation:created, navigation:changed, memory:source-added). `pluginEventBus` for low-level access. Privacy-safe: events suppressed during private-mode sessions.
- **Write capabilities:** `sendMessage()`, `startConversation()`, `skills.write()`, `inbox.addItem()`, `automations.create()` — all with permission-gated main-process enforcement.
- **Agent hooks:** `usePreTurnHook()` injects plugin context before turns (2KB/plugin, 5KB total). `usePostTurnHook()` for post-processing.
- **External connectivity:** `useExternalFetch()` / `rebel.fetch()` — mediated HTTP through 8 security layers. Domain allowlist from manifest. DNS rebinding mitigation.
- **UI components:** `BarChart`, `LineChart`, `PieChart`, `DataTable`, `IframeView` (sandboxed with strict CSP).
- **Security hardening:** Main-process permission checks on all handlers (read + write). `pluginId` required in all IPC schemas. Storage isolation with known-plugin validation. Rate limiting per API.
- **Architecture:** Handler monolith split into 5 domain modules (`plugins/shared.ts`, `pluginMemoryHandlers.ts`, `pluginWriteHandlers.ts`, `pluginFetchHandlers.ts`, `pluginLifecycleHandlers.ts`).
- **API polish:** Standardized error envelopes (`PluginWriteResult<T>` discriminated unions), `conversations.create(message?)` for draft-prefilled navigation, `conversations.getTranscript()` for privacy-safe transcript access (requires `conversations:transcript` permission), unified rate limiter factory, write-invalidated permission cache, and `custom:${string}` event type support.

See [Wave 5 planning doc](../plans/260327_plugin_wave5_infrastructure.md) and [hardening doc](../plans/260327_plugin_wave5_hardening.md).

### Wave 4 (Shipped)

Major plugin API expansion: source access (`useSources()`, `useSourceDocument()`), AI helpers (`useAi()` with summarize/extract/generate), calendar access (`useMeetings()`), clipboard (`useClipboard()`), enhanced conversations/search, new UI components (Tabs, Select, Dialog). IPC expanded from 11 to 17 channels. See [ideation research](../research/260325_plugin_api_extension_ideation.md) and [planning doc](../plans/260325_sources_plugin_and_api_extensions.md).

### Wave 3 (Shipped)

`rebel_plugins_get_source` tool, Settings > Plugins actions (View Source, Fork, Export, Import), manifest support for `forkedFrom`/`documentation`, per-plugin persistent state (`usePluginStorage()`), workspace semantic search (`useMemorySearch()`), export/import sharing format. IPC expanded from 4 to 11 channels.

### Wave 2 (Shipped)

Initial plugin creation and persistence, main-pane tab rendering, basic conversation access.


## Key Decisions

These decisions were made during the design phase and validated through septuple review. See the planning doc for full rationale and rejected alternatives.

1. **TSX components, not a declarative DSL** — standard React for maximum flexibility and LLM familiarity.
2. **Curated API surface** — plugins import only from `@rebel/plugin-api` and `@rebel/plugin-ui`. No access to internal modules.
3. **Trusted mode** — no iframe sandboxing in v1. Plugins run in the same React tree as the app. Acceptable because plugins are AI-generated, not third-party. Sandboxing planned as Stage 14.
4. **Sucrase compiler** — ~50KB, 0.07ms per compile. Strips TypeScript, transforms JSX, converts ESM→CJS. Lazy-loaded at first compile to avoid Vite dev server issues.
5. **CJS import rewriting** — Sucrase converts ESM imports to `require()` calls; the import rewriter maps `require("@rebel/*")` → `globalThis.__REBEL_MODULES__["@rebel/*"]`. Simpler and more robust than ESM regex rewriting.
6. **`new Function()` module execution** — instead of Blob URL + `import()`. Simpler, avoids CSP concerns in Electron.
7. **Branded `PluginSurfaceId` type** — `plugin:{id}` format. Split Record approach for built-in vs plugin surfaces.
8. **In-memory registry** — `useSyncExternalStore`-compatible plugin registry with subscription support.
9. **Plugin persistence via per-plugin files** — each plugin stored as `{userData}/plugins/{pluginId}/manifest.json` + `index.tsx` on disk.
10. **AI-driven creation** — `rebel_plugins_create` MCP tool sends manifest + TSX source to renderer via IPC for compilation.


## Plugin Tools (via MCP)

- **`rebel_plugins_create`** — Creates or updates a UI plugin tab. Agent calls with manifest fields + TSX source; renderer compiles and registers.
- **`rebel_plugins_list`** — Lists all registered plugins with IDs, names, descriptions.
- **`rebel_plugins_get_source`** — Returns TSX source for an existing plugin by ID (powers read-before-modify workflow).


## Plugin Management UI (Settings > Plugins)

- **View Source** (active plugins) — opens read-only source dialog
- **Export** (active plugins) — writes `.rebel-plugin.json` file
- **Import Plugin** (top-level action) — reads and validates a plugin file
- **Fork** (catalog plugins) — creates editable copy with `{id}-custom`, stores lineage in `forkedFrom`
- **Docs** toggle (active plugins) — expands/collapses manifest documentation


## Plugin Export/Import Format

Plugins are exported as `.rebel-plugin.json`:

```json
{
  "version": 1,
  "plugin": {
    "manifest": {
      "id": "meeting-prep",
      "name": "Meeting Prep",
      "description": "Summarizes recent conversations before meetings",
      "version": "0.1.0",
      "forkedFrom": "meeting-prep-template",
      "documentation": "# Meeting Prep\nHow this plugin works..."
    },
    "source": "import React from 'react';\nexport default function Plugin() { return null; }"
  }
}
```

Import validates structure before registration. Duplicate IDs handled with replace confirmation.


## Manifest Fields (Wave 3+)

| Field | Type | Purpose |
|-------|------|---------|
| `forkedFrom` | `string?` | Tracks source catalog plugin ID for forked plugins |
| `documentation` | `string?` | Inline markdown docs shown in Settings via Docs toggle |


## Known Limitations

- **External fetch requires manifest declaration** — plugins can make HTTP requests via `useExternalFetch()` but only to domains declared in `externalDomains` manifest field, mediated through the main process
- **Curated data access** — plugins access sources via `useSources()`/`useSourceDocument()` (restricted to `memory/sources/`), meetings via `useMeetings()` (sensitive fields redacted), and workspace via `useMemorySearch()`. No arbitrary file I/O.
- **Constrained AI access** — `useAi()` provides summarize/extract/generate but is rate-limited (10 calls/min/plugin) and input-size-capped
- **Permission-gated writes** — write operations (messages, skills, inbox, automations) require explicit manifest permissions and user approval at install time
- **No background execution** — plugins only run when their tab is visible
- **Eager mounting** — all plugins mount simultaneously; no lazy mounting (deferred due to state-loss UX concerns)
- **Single-file plugins** — no multi-file plugins or dependencies beyond the curated API
- **Desktop-only** — cloud and mobile do not support plugins
- **Unicode in JSX text** — `\uXXXX` escape sequences in JSX text content render as literal characters, not Unicode. Use actual characters or JSX expressions like `{'\u2190'}` instead. See the `build-custom-plugin` skill for details.
- **No `window` access** — the AST validator blocks `window` references. Use `document.addEventListener` instead of `window.addEventListener`. `document.write()` and `document.cookie` are also blocked.


## Future Stages

The original planning doc (`docs/plans/260322_plugin_extension_system.md`) details future stages including Stages 11-17 (management UI follow-ups, API expansion, iframe sandboxing, agent hooks, multi-surface, marketplace).

The Wave 5 planning doc (`docs/plans/260327_plugin_wave5_infrastructure.md`) details the next major expansion: event system, write capabilities, agent hooks, homepage widgets, external connectivity, and security model formalization.
