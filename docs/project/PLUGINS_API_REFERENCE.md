---
description: "Plugin API reference — hooks, components, RebelApi shape, and type declarations for @rebel/plugin-api and @rebel/plugin-ui"
last_updated: "2026-06-15"
---

# Plugin API Reference

Complete API reference for Rebel's plugin system. Plugins import from two curated modules: `@rebel/plugin-api` (hooks and data access) and `@rebel/plugin-ui` (UI components).

**See also:** [PLUGINS_OVERVIEW](./PLUGINS_OVERVIEW.md) — high-level overview and signposting | [PLUGINS_ARCHITECTURE](./PLUGINS_ARCHITECTURE.md) — architecture, file structure, IPC | [PLUGINS_SECURITY](./PLUGINS_SECURITY.md) — security model and permissions

## Breaking change: `pinnedAt` → `doneAt` (v0.2, 2026-06)

The conversation lifecycle field exposed to plugins was **renamed `pinnedAt` → `doneAt`** and its **polarity inverted**. If a plugin that read `conversation.pinnedAt` (or filtered `conversation:updated` `changes` for `'pinnedAt'`) stopped working after this release, this is why.

**What changed:**
- `ConversationSummary.pinnedAt` is gone; use `ConversationSummary.doneAt` (`number | null`).
- The `conversation:updated` event reports `'doneAt'` in its `changes` array (no longer `'pinnedAt'`).
- `conversations.pin(id)` is renamed to `conversations.toggleDone(id)` (same behaviour — toggles Active/Done — renamed off the dead `pin` vocabulary).

**Polarity table** (the value flipped meaning, not just the name):

| Conversation state | OLD (`pinnedAt`) | NEW (`doneAt`) |
| --- | --- | --- |
| Active (in progress) | `pinnedAt != null` | `doneAt == null` |
| Done (finished)      | `pinnedAt == null` | `doneAt != null` |

**Migrate your plugin** — read the new field and flip the polarity:

```typescript
// BEFORE
const isActive = conversation.pinnedAt != null;
const isDone   = conversation.pinnedAt == null;
onEvent('conversation:updated', (e) => {
  if (e.changes.includes('pinnedAt')) { /* lifecycle changed */ }
});

// AFTER
const isActive = conversation.doneAt == null;
const isDone   = conversation.doneAt != null;
onEvent('conversation:updated', (e) => {
  if (e.changes.includes('doneAt')) { /* lifecycle changed */ }
});
```

(`starredAt`, `deletedAt`, `resolvedAt` are unchanged. The user-facing tabs remain "Active" / "Done".)


## `@rebel/plugin-api`

### Data Access Hooks

| Export | Type | Permission | Description |
|--------|------|------------|-------------|
| `useConversations(params?)` | Hook | `conversations:read` | Returns `{ data: ConversationSummary[], totalCount, isLoading }` — live conversation list with optional filtering, sorting, pagination |
| `useActiveSession()` | Hook | `conversations:read` | Returns `ActiveSession \| null` — reactive snapshot of the currently-viewed conversation, or null when no conversation is active or session is private |
| `useConversation(id)` | Hook | `conversations:read` | Returns `ConversationSummary \| null` — reactive single-conversation lookup by ID. Returns null for private or non-existent sessions; deleted sessions return with `deletedAt` set |
| `conversations.getTranscript(id, opts?)` | Method | `conversations:transcript` | Returns `PluginWriteResult<{ messages: TranscriptMessage[], state? }>` — transcript messages with state disambiguation (`ok`/`not_found`/`redacted`) |
| `useTopics(params?)` | Hook | `memory:read` | Returns `{ topics, isLoading, error }` — list workspace topics from memory/topics/ with optional filtering |
| `useTopicContent(relativePath)` | Hook | `memory:read` | Returns `{ content, isLoading, error }` — read a single topic's markdown content (frontmatter stripped) |
| `useMemorySearch(query, options?)` | Hook | `memory:read` | Returns `{ results, isLoading, error }` — semantic workspace search with optional `pathPrefix` and configurable `limit` |
| `useSources(params?)` | Hook | `memory:read` | Returns `{ sources, totalCount, isLoading, error }` — search/browse memory sources (meetings, recordings) with filters |
| `useSourceDocument(relativePath)` | Hook | `memory:read` | Returns `{ document, isLoading, error }` — full source document content (metadata + raw markdown) |
| `useEntities(params?)` | Hook | `entities:read` | Returns `{ entities, isLoading, error }` — search people/company entities with metadata |
| `useSkillFile(relativePath)` | Hook | `skills:read` | Returns `{ content, frontmatter, isLoading, error }` — read a skill file with parsed YAML frontmatter |
| `useMeetings(params?)` | Hook | `memory:read` | Returns `{ meetings, isStale, isLoading, error, refresh }` — cached calendar meetings (plugin-safe shape) |
| `useAi()` | Hook | — | Returns `{ ai, isProcessing, error }` — constrained BTS model access: `summarize()`, `extractObject()`, `generate()` |
| `useClipboard()` | Hook | — | Returns `{ copyText }` — write-only clipboard access |

### Write / Action Hooks

| Export | Type | Permission | Description |
|--------|------|------------|-------------|
| `useRebel()` | Hook | — | Returns `RebelApi` object with navigation, conversation management, skills, inbox, automations, and lifecycle |
| `useExternalFetch()` | Hook | `external-fetch` | Returns `{ fetch, data, isLoading, error }` — mediated HTTP requests to manifest-declared domains |
| `usePluginStorage<T>(key, defaultValue)` | Hook | — | Returns `[value, setValue]` tuple backed by per-plugin persisted storage |

### Event / Lifecycle Hooks

| Export | Type | Description |
|--------|------|-------------|
| `useRebelEvent(eventType, callback)` | Hook | Subscribe to lifecycle events; auto-unsubscribes on unmount |
| `usePreTurnHook(options)` | Hook | Register a pre-turn hook: `{ getContext: () => string \| null, priority?: number }` |
| `usePostTurnHook(callback)` | Hook | Register a post-turn hook that runs after agent turns complete |
| `usePluginRoute()` | Hook | Get current route info: `{ pluginId, tabId?, params }` for param passing from agents |
| `pluginEventBus` | Object | Low-level event bus: `subscribe(event, cb)` (returns unsubscribe fn), `emit(event, payload)` |


### `RebelApi` Shape

Returned by `useRebel()`:

```typescript
interface RebelApi {
  conversations: {
    open(sessionId: string): void;
    list(): ConversationSummary[];
    toggleDone(sessionId: string): void; // renamed from pin() v0.2 — toggles Active/Done
    star(sessionId: string): void;
    rename(sessionId: string, title: string): void;
    create(options?: { draftText?: string; navigate?: boolean }): string;
    sendMessage(sessionId: string, message: string): Promise<PluginWriteResult>;
    startConversation(message: string): Promise<PluginWriteResult<{ sessionId: string }>>;
    getTranscript(sessionId: string, options?: { limit?: number }): Promise<PluginWriteResult<{ messages: TranscriptMessage[]; state?: 'ok' | 'not_found' | 'redacted' }>>;
  };
  navigate: NavigationHelpers;
  skills: {
    write(relativePath: string, content: string, opts?: { baseContentHash?: string }):
      Promise<{ ok: boolean; currentHash?: string; conflict?: boolean; error?: string }>;
  };
  inbox: {
    addItem(item: InboxAddItem): Promise<PluginWriteResult<{ itemId: string }>>;
    getItems(params?: { limit?: number }): Promise<InboxPluginItem[]>;
  };
  automations: {
    create(params: CreateAutomationParams): Promise<{ automationId: string; ok: boolean; error?: string }>;
    list(params?: { pluginId?: string }): Promise<AutomationEntry[]>;
  };
  ui: {
    showToast(message: string, options?: ShowToastOptions): void;
  };
  lifecycle: PluginLifecycle;
}
```

### Error Envelope Pattern

All write/mutation methods return a `PluginWriteResult<T>` discriminated union:

```typescript
type PluginWriteResult<T extends Record<string, unknown> = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: string };
```

Check `result.ok` before accessing payload fields:

```typescript
const result = await rebel.conversations.startConversation('Hello');
if (result.ok) {
  console.log('Created session:', result.sessionId);
} else {
  console.error('Failed:', result.error);
}
```

This pattern applies to: `sendMessage()`, `startConversation()`, `inbox.addItem()`, `automations.create()`, `skills.write()`, `getTranscript()`.

**NavigationHelpers:** Callable as `navigate('rebel://...')` or via typed methods:
- `navigate.toSettings(tab?)` — Open Settings (tab: `system`, `spaces`, `meetings`, `tools`, `agents`, `voice`, `safety`, `diagnostics`, `developer`, `usage`, `cloud`, `account`)
- `navigate.toAutomations()` — Open Automations
- `navigate.toTasks()` — Open Tasks
- `navigate.toLibrary(filePath?)` — Open Library
- `navigate.toPlugin(pluginId)` — Open a plugin tab

**ShowToastOptions:** `variant` ('default'|'success'|'error'|'info'|'warning'), `duration` (ms, default 5000). Rate-limited: 3 toasts per 10 seconds per plugin.

**PluginLifecycle:** `registerInterval(cb, ms)`, `registerTimeout(cb, ms)`, `registerSubscription(unsub)` — auto-cleaned on unmount.


### Hook Details

#### `useActiveSession()`

```typescript
function useActiveSession(): ActiveSession | null

interface ActiveSession extends ConversationSummary {
  activeTurnId: string | null;
  isCurrentSession: true;
}
```

Returns a reactive snapshot of the session the user is currently viewing. Returns `null` when:
- No conversation is active (homepage, settings, plugin tab)
- The current session is private

Uses `useSyncExternalStore` for efficient reactivity. Re-renders only when the active session's data changes.

#### `useConversation(id)`

```typescript
function useConversation(id: string): ConversationSummary | null
```

Reactive single-conversation lookup by ID. Returns `null` for private or non-existent sessions. Deleted sessions return the summary with `deletedAt` set (not null), allowing plugins to show metadata of deleted conversations without accessing their content.

#### `useConversations()`

```typescript
function useConversations(params?: {
  query?: string;
  limit?: number;        // Default 50, max 100
  offset?: number;
  sortBy?: 'updatedAt' | 'createdAt' | 'title';
  dateRange?: { after?: number; before?: number };  // Filter by timestamp (ms)
  dateField?: 'createdAt' | 'updatedAt';            // Which field dateRange applies to (default: createdAt)
  origin?: string | string[];                        // Filter by session origin
  isBusy?: boolean;                                  // Filter by busy state
  includeDeleted?: boolean;                          // Include soft-deleted sessions (default: false)
}): { data: ConversationSummary[]; totalCount: number; isLoading: boolean }
```

**ConversationSummary fields:** `id`, `title`, `updatedAt`, `createdAt`, `isBusy`, `messageCount`, `preview`, `doneAt`, `starredAt`, `origin`, `deletedAt`, `resolvedAt` (`doneAt` non-null = Done — renamed from `pinnedAt` with inverted polarity; see "Breaking change" above)

**Filter details:**
- `dateRange`: Applies to `createdAt` by default. Set `dateField: 'updatedAt'` for "recently active" filtering.
- `origin`: Accepts a single value (e.g., `'manual'`) or array (e.g., `['manual', 'plugin']`). Known values: `manual`, `automation`, `role`, `mcp-tool`, `inbound-trigger`, `plugin`, `focus`.
- `isBusy`: `true` = only sessions with an active turn, `false` = only idle sessions.
- `includeDeleted`: Soft-deleted sessions are excluded by default. Set `true` to include them (they'll have `deletedAt` set).
- `totalCount` is computed after all filters are applied (including privacy/deletion exclusion).

#### `useTopics()`

```typescript
function useTopics(params?: {
  query?: string;
  spacePath?: string;
  limit?: number;        // Default 50
}): { topics: TopicEntry[]; isLoading: boolean; error: string | null }
```

**TopicEntry fields:** `relativePath`, `title`, `spacePath`, `updatedAt`

#### `useTopicContent()`

```typescript
function useTopicContent(relativePath: string): {
  content: string | null;
  isLoading: boolean;
  error: string | null;
}
```

#### `useMemorySearch()`

- Uses semantic workspace search via main-process `fileIndexService`
- 300ms debounce in hook
- Empty query short-circuits to `[]` without IPC
- Optional `pathPrefix` to scope search (e.g., `'memory/sources'`)
- Configurable `limit` (default 10, max 50)

#### `useSources()`

- Backed by `sourceMetadataStore.searchSources()` — filters by query, sourceType, participants, dateRange
- No query returns all sources sorted by `occurredAt` desc
- 300ms debounce on query changes
- Returns `SourceEntry` with metadata (title, summary, participants, keyTakeaways, etc.)

#### `useSourceDocument()`

- Reads the full markdown body of a source file (frontmatter stripped)
- Restricted to `memory/sources/` paths for security
- Path traversal (`..`) blocked server-side

#### `useEntities()`

```typescript
function useEntities(params?: {
  entityType?: 'person' | 'company';
  query?: string;
  company?: string;
  limit?: number;        // Default 20, max 50
}): { entities: EntityEntry[]; isLoading: boolean; error: string | null }
```

**EntityEntry fields:** `canonicalName`, `entityType`, `emails`, `company`, `role`, `domain`, `aliases`

#### `useSkillFile()`

```typescript
function useSkillFile(relativePath: string): {
  content: string | null;
  frontmatter: Record<string, unknown> | null;
  isLoading: boolean;
  error: string | null;
}
```

- Reads skill files from configured spaces' `skills/` directories
- YAML frontmatter parsed and returned separately
- `skills/` shorthand paths resolved across all configured spaces

#### `useAi()`

- Rate-limited: 10 calls/minute per plugin (sliding window, enforced server-side)
- `summarize(text, { maxLength? })` — input max 5000 chars
- `extractObject<T>(text, schema)` — structured extraction, input max 5000 chars
- `generate(prompt, { maxTokens? })` — freeform text, input max 2000 chars, output max 1000 tokens
- All calls tracked under `plugin-ai` cost category
- Backed by `behindTheScenesClient` (BTS model)

#### `useMeetings()`

- Reads from meeting cache store (same source as homepage Today view)
- `todayOnly` param filters to today's meetings
- Returns plugin-safe shape: omits `calendarSource` (contains email), `participantEmails`, `prepPath` (filesystem)
- `refresh()` triggers a re-fetch
- `isStale` indicates if the cache needs a sync

#### `useClipboard()`

- Write-only: `copyText(text)` returns `Promise<boolean>`
- Uses `navigator.clipboard.writeText` directly (no IPC)
- Read access intentionally not provided

#### `useExternalFetch()`

```typescript
function useExternalFetch(url: string, options?: {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  enabled?: boolean;
}): {
  data: unknown;
  isLoading: boolean;
  error: string | null;
  fetch: (url: string, opts?) => Promise<FetchResult>;
}
```

- **Permission required:** `external-fetch` + `externalDomains` in manifest
- Mediated through main process — 8 security layers (domain validation, SSRF protection, DNS rebinding mitigation, rate limiting, response size caps, content-type filtering, redirect validation, private IP blocking)
- Imperative `rebel.fetch(url, opts)` also available via `useRebel()`
- See [PLUGINS_SECURITY](./PLUGINS_SECURITY.md) for full security model

#### `useRebelEvent()`

```typescript
function useRebelEvent(
  eventType: RebelEventType,
  callback: (payload: unknown) => void
): void

type RebelEventType =
  | 'turn:started'            // { sessionId, turnId }
  | 'turn:completed'          // { sessionId, turnId, assistantText, toolsUsed }
  | 'turn:error'              // { sessionId, turnId, error }
  | 'conversation:created'    // { sessionId, title }
  | 'conversation:updated'    // { sessionId, title, changes: string[] }
  | 'conversation:deleted'    // { sessionId, title }
  | 'conversation:restored'   // { sessionId, title }
  | 'navigation:changed'      // { target, previousTarget }
  | 'memory:source-added'     // { turnId, summary? }
  | `custom:${string}`;       // custom events (cross-plugin communication)
```

**Lifecycle events:**
- `conversation:updated` — Fires when meaningful metadata changes: `title`, `doneAt`, `starredAt`, `resolvedAt`. Does NOT fire for `updatedAt`-only changes or `isBusy` transitions (use `turn:started`/`turn:completed` for those). The `changes` array lists which fields changed. (`doneAt` was `pinnedAt` before v0.2 — see "Breaking change" above.)
- `conversation:deleted` — Fires when a session is soft-deleted (`deletedAt` changes from null to non-null).
- `conversation:restored` — Fires when a soft-deleted session is restored (`deletedAt` changes from non-null to null).

**Transcript state:** `getTranscript()` now returns a `state` field for disambiguation:
- `'ok'` — Session found with content
- `'not_found'` — No session with this ID exists
- `'redacted'` — Session exists but content is not accessible (private or deleted)

The `state` field is additive — existing plugins that only check `result.ok` and `result.messages` continue working unchanged.

**Privacy:** `turn:*` and `conversation:*` events are suppressed during private-mode sessions. Lifecycle events use per-session privacy checking (not just the current session) to prevent leaking private background session activity.

Plugins can emit and subscribe to custom events using the `custom:` prefix (e.g., `custom:my-plugin-data-updated`).

#### `usePreTurnHook()`

```typescript
function usePreTurnHook(
  callback: () => string | null | undefined
): void
```

- Called before each agent turn to collect plugin context
- Return a string to inject into the agent's context (max 2000 chars per plugin, 5000 total across all plugins)
- Return `null`/`undefined` to skip

#### `usePostTurnHook()`

```typescript
function usePostTurnHook(
  callback: (turnResult: { sessionId: string; turnId: string; assistantText?: string }) => void
): void
```

- Called after each agent turn completes
- Use for post-processing, analytics, or triggering follow-up actions

#### `usePluginStorage()`

- Storage is namespaced per plugin (`pluginId + key`)
- Data persists across app restarts
- 10MB quota per plugin


## `@rebel/plugin-ui`

| Component | Wraps | Key Props |
|-----------|-------|-----------|
| `Button` | `@renderer/components/ui/Button` | `variant`, `onClick`, `disabled` |
| `Card` | `@renderer/components/ui/Card` | `onClick`, `className` |
| `Input` | `@renderer/components/ui/Input` | `value`, `onChange`, `placeholder`, `type` |
| `Stack` | Custom flexbox | `gap` (`sm`/`md`/`lg`), `direction` (`column`/`row`) |
| `Badge` | `@renderer/components/ui/Badge` | `variant` (`default`/`secondary`/`destructive`/`outline`) |
| `Textarea` | `@renderer/components/ui/Input` | `value`, `onChange`, `placeholder`, `rows` |
| `LoadingCard` | `Spinner` | No props |
| `ErrorCard` | Themed Card | `title`, `message` |
| `Tabs` | `@renderer/components/ui/Tabs` | `defaultValue`, `value`, `onValueChange` |
| `TabsList` | `@renderer/components/ui/Tabs` | `variant` (`default`/`pills`/`underline`) |
| `TabsTrigger` | `@renderer/components/ui/Tabs` | `value` |
| `TabsContent` | `@renderer/components/ui/Tabs` | `value` |
| `Select` | `@renderer/components/ui/Select` | `value`, `onChange`, `disabled` |
| `Dialog` | `@renderer/components/ui/Dialog` | `open`, `onOpenChange` |
| `DialogContent` | `@renderer/components/ui/Dialog` | `size` (`sm`/`md`/`lg`) |
| `DialogHeader` | `@renderer/components/ui/Dialog` | `onClose` |
| `DialogTitle` | `@renderer/components/ui/Dialog` | — |
| `DialogDescription` | `@renderer/components/ui/Dialog` | — |
| `DialogBody` | `@renderer/components/ui/Dialog` | — |
| `DialogFooter` | `@renderer/components/ui/Dialog` | — |

### Chart Components

| Component | Description | Key Props |
|-----------|-------------|-----------|
| `BarChart` | SVG bar chart with theme-aware colors | `data: { label, value, color? }[]`, `height?`, `showLabels?` |
| `LineChart` | SVG line chart with optional data point markers | `data: { label, value }[]`, `height?`, `showDots?`, `color?` |
| `PieChart` | SVG pie chart with optional legend | `data: { label, value, color? }[]`, `size?`, `showLabels?` |
| `DataTable` | Responsive table with sortable columns | `columns: { key, label, sortable? }[]`, `rows: Record[]`, `onRowClick?` |
| `IframeView` | Sandboxed iframe for rich HTML content | `html: string`, `height?` |

All chart components include ARIA attributes for screen reader accessibility.


## Type Declarations

TypeScript declarations for LLM context and plugin development are in:

- `src/renderer/features/plugins/declarations/rebel-plugin-api.d.ts` — `@rebel/plugin-api` types
- `src/renderer/features/plugins/declarations/rebel-plugin-ui.d.ts` — `@rebel/plugin-ui` types

Source code for hooks and API factory:

- `src/renderer/features/plugins/api/pluginApiFactory.ts` — creates all plugin API hooks
- `src/renderer/features/plugins/api/types.ts` — TypeScript interfaces for full API surface
