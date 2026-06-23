/**
 * Type declarations for the @rebel/plugin-api module.
 *
 * These types describe the hooks and APIs available to plugins.
 * Used by the LLM for code generation context and by IDE autocompletion.
 *
 * IMPORTANT: Keep in sync with pluginApiFactory.ts and api/types.ts.
 *
 * @see src/renderer/features/plugins/api/pluginApiFactory.ts — implementation
 * @see src/renderer/features/plugins/api/types.ts — source types
 *
 * ──────────────────────────────────────────────────────────────────────────
 * BREAKING CHANGE (v0.2, 2026-06): `ConversationSummary.pinnedAt` → `doneAt`
 * ──────────────────────────────────────────────────────────────────────────
 * The lifecycle field exposed to plugins was renamed AND its polarity INVERTED.
 *
 *   OLD: `conversation.pinnedAt != null`  →  conversation is ACTIVE
 *        `conversation.pinnedAt == null`  →  conversation is DONE
 *   NEW: `conversation.doneAt   == null`  →  conversation is ACTIVE
 *        `conversation.doneAt   != null`  →  conversation is DONE
 *
 * `conversation:updated` events now report `'doneAt'` (not `'pinnedAt'`) in the
 * `changes` array.
 *
 * If your plugin broke after this release, this is almost certainly why.
 * Migration for plugin authors:
 *   - Read `conversation.doneAt` instead of `conversation.pinnedAt`.
 *   - FLIP any polarity logic: replace `pinnedAt != null` ("active") with
 *     `doneAt == null`, and `pinnedAt == null` ("done") with `doneAt != null`.
 *   - Filter `changes` for `'doneAt'` instead of `'pinnedAt'`.
 *   - Call `conversations.toggleDone(id)` instead of `conversations.pin(id)`
 *     (same behaviour — toggles Active/Done — just renamed off the dead `pin` vocab).
 *
 * Full migration guide + before/after snippets:
 *   - docs/project/PLUGINS_API_REFERENCE.md ("Breaking change: pinnedAt → doneAt")
 *   - rebel-system help-for-humans changelog
 * ──────────────────────────────────────────────────────────────────────────
 */

declare module '@rebel/plugin-api' {
  interface ConversationSummary {
    id: string;
    title: string | null;
    updatedAt: number;
    createdAt: number;
    isBusy: boolean;
    messageCount: number;
    preview: string;
    /** Lifecycle marker: non-null = Done, null = Active. Renamed from `pinnedAt` (polarity inverted) — see breaking-change header above. */
    doneAt: number | null;
    starredAt: number | null;
    origin: string;
    deletedAt: number | null;
    resolvedAt: number | null;
  }

  /** Snapshot of the currently-viewed conversation, or null when no conversation is active */
  interface ActiveSession extends ConversationSummary {
    activeTurnId: string | null;
    isCurrentSession: true;
  }

  interface UseConversationsParams {
    /** Filter by title substring (case-insensitive) */
    query?: string;
    /** Max results (default 50, max 100) */
    limit?: number;
    /** For pagination */
    offset?: number;
    /** Sort field (default: updatedAt descending) */
    sortBy?: 'updatedAt' | 'createdAt' | 'title';
    /**
     * Filter by date range (timestamps in ms).
     * `after` = include sessions on or after this timestamp.
     * `before` = include sessions on or before this timestamp.
     * Applies to `createdAt` by default, or `updatedAt` if `dateField` is set.
     */
    dateRange?: { after?: number; before?: number };
    /** Which date field `dateRange` applies to. Default: 'createdAt'. */
    dateField?: 'createdAt' | 'updatedAt';
    /**
     * Filter by session origin.
     * Accepts a single value (e.g., 'manual') or array of values (e.g., ['manual', 'plugin']).
     * Origin values: 'manual', 'automation', 'role', 'mcp-tool', 'inbound-trigger', 'plugin', 'focus'.
     */
    origin?: string | string[];
    /** Filter by busy state. `true` = only busy sessions, `false` = only idle sessions. */
    isBusy?: boolean;
    /** Include soft-deleted sessions in results. Default: false. */
    includeDeleted?: boolean;
  }

  // Single source of truth: PluginPermissionIpcSchema in src/shared/ipc/schemas/plugins.ts.
  // This declaration is SDK-facing and must stay self-contained (the @shared path
  // alias is not available to plugin authors outside this repo). Keep in sync manually.
  type Permission =
    | 'conversations:read'
    | 'conversations:transcript'
    | 'conversations:write'
    | 'memory:read'
    | 'skills:read'
    | 'skills:write'
    | 'automations:create'
    | 'entities:read'
    | 'external-fetch';

  /**
   * Discriminated union envelope for plugin write/mutation operations.
   * All write methods return this shape instead of throwing.
   */
  type PluginWriteResult<T extends Record<string, unknown> = Record<string, never>> =
    | ({ ok: true } & T)
    | { ok: false; error: string };

  /** A single message from a conversation transcript */
  interface TranscriptMessage {
    role: 'user' | 'assistant';
    text: string;
    timestamp: string;
    toolsUsed?: string[];
  }

  interface PluginLifecycle {
    registerInterval(callback: () => void, ms: number): void;
    registerTimeout(callback: () => void, ms: number): void;
    registerSubscription(unsubscribe: () => void): void;
  }

  interface ShowToastOptions {
    /**
     * Known variants: default, success, error, info, warning.
     * Unknown values fall back to the default toast style.
     */
    variant?: string;
    /** Duration in ms (default 5000) */
    duration?: number;
  }

  /**
   * Navigation helpers with typed convenience methods.
   * Can be called directly as `navigate('rebel://...')` or via typed helpers.
   */
  interface NavigationHelpers {
    /** Navigate to a rebel:// URL directly */
    (target: string): void;
    /** Navigate to Settings, optionally opening a specific tab */
    toSettings(tab?: string): void;
    /** Navigate to the Automations surface */
    toAutomations(): void;
    /** Navigate to the Tasks surface */
    toTasks(): void;
    /** Navigate to the Library, optionally opening a specific file */
    toLibrary(filePath?: string): void;
    /** Navigate to a specific plugin's tab */
    toPlugin(pluginId: string): void;
  }

  interface SkillWriteOptions {
    /** Workspace-relative path to the target skill file */
    relativePath: string;
    /** Full markdown content to write */
    content: string;
    /** Optional base hash for stale-write conflict detection */
    baseContentHash?: string;
  }

  interface SkillWriteResult {
    ok: boolean;
    error?: string;
    conflict?: boolean;
    currentHash?: string;
  }

  interface InboxAddItemInput {
    title: string;
    description?: string;
    priority?: 'low' | 'medium' | 'high';
    /** Prompt text to run when user executes the item */
    actionPrompt?: string;
  }

  interface InboxItem {
    itemId: string;
    title: string;
    description?: string;
    priority: 'low' | 'medium' | 'high';
    actionPrompt?: string;
    /** Present when attribution metadata is available */
    pluginId?: string;
    createdAt: number;
    archived: boolean;
  }

  interface PluginFetchResult {
    ok: boolean;
    status: number;
    data: unknown;
    error?: string;
  }

  interface UseExternalFetchOptions {
    /** Only GET is supported for MVP */
    method?: 'GET';
    /** Custom headers to include in the request */
    headers?: Record<string, string>;
  }

  // ── Automation Types ──────────────────────────────────────────────────

  interface AutomationCreateDefinition {
    /** Human-readable name for the automation */
    name: string;
    /** Optional description */
    description?: string;
    /** Markdown content for the automation skill file */
    skillContent: string;
    /** Schedule configuration */
    schedule: {
      /** 'interval' for simple intervals ('30m', '1h', '1d'), 'cron' for cron expressions */
      type: 'interval' | 'cron';
      /** e.g., '1h', '30m', '1d', or a cron expression */
      value: string;
    };
    /** Default: false — user must manually enable */
    enabled?: boolean;
  }

  interface AutomationCreateResult {
    automationId: string;
    ok: boolean;
    error?: string;
  }

  interface AutomationSummary {
    id: string;
    name: string;
    description?: string;
    schedule: {
      type: string;
      value?: string;
    };
    enabled: boolean;
    lastRunAt: number | null;
    lastRunStatus?: string;
    nextRunAt: number | null;
    /** Plugin ID if this automation was created by a plugin */
    pluginId?: string;
  }

  interface RebelApi {
    conversations: {
      /** Open a conversation by session ID */
      open(sessionId: string): void;
      /** List all conversation summaries */
      list(): ConversationSummary[];
      /** Toggle the Active/Done lifecycle for a conversation (requires `conversations:read`). Renamed from `pin` (v0.2, 2026-06). */
      toggleDone(sessionId: string): void;
      /** Toggle star state for a conversation (requires `conversations:read`) */
      star(sessionId: string): void;
      /** Rename a conversation (requires `conversations:read`) */
      rename(sessionId: string, title: string): void;
      /**
       * Send a message to an existing conversation.
       * Requires `conversations:write` permission. Rate-limited: 5 calls/min per plugin.
       * Plugin attribution is included in the message metadata.
       * Returns `{ ok: true }` on success, `{ ok: false, error }` on failure.
       */
      sendMessage(sessionId: string, message: string): Promise<PluginWriteResult>;
      /**
       * Start a new conversation with an initial message.
       * Requires `conversations:write` permission. Rate-limited: 5 calls/min per plugin.
       * Returns `{ ok: true, sessionId }` on success, `{ ok: false, error }` on failure.
       */
      startConversation(message: string): Promise<PluginWriteResult<{ sessionId: string }>>;
      /**
       * Create a new conversation. Optionally pre-fill the composer draft. Returns the new session ID.
       * @param options.draftText - Text to pre-fill in the composer (not auto-sent)
       * @param options.navigate - Switch UI to the new session (default: true). If false, create in background.
       */
      create(options?: { draftText?: string; navigate?: boolean }): string;
      /**
       * Read visible user/assistant transcript messages from a conversation.
       * Requires `conversations:transcript` permission. Rate-limited: 10 calls/min per plugin.
       *
       * The `state` field disambiguates why messages may be empty:
       * - `'ok'` — session found with content
       * - `'not_found'` — no session with this ID exists
       * - `'redacted'` — session exists but content is not accessible (private or deleted)
       *
       * Default limit: 100 messages (last N).
       */
      getTranscript(sessionId: string, options?: { limit?: number }): Promise<PluginWriteResult<{ messages: TranscriptMessage[]; state?: 'ok' | 'not_found' | 'redacted' }>>;
    };
    skills: {
      /**
       * Write a shared skill markdown file using managed conflict detection.
       * Requires `skills:write` permission. Rate-limited: 5 calls/min per plugin.
       *
       * Returns `{ ok: false, conflict: true, currentHash }` when `baseContentHash`
       * does not match the current on-disk hash.
       */
      write(options: SkillWriteOptions): Promise<SkillWriteResult>;
    };
    inbox: {
      /**
       * Add an inbox item.
       * Rate-limited: 10 items/min per plugin.
       * No manifest permission required.
       * Returns `{ ok: true, itemId }` on success, `{ ok: false, error }` on failure.
       */
      addItem(item: InboxAddItemInput): Promise<PluginWriteResult<{ itemId: string }>>;
      /**
       * List active inbox items.
       * Default limit: 20. Max limit: 50.
       */
      getItems(params?: { limit?: number }): Promise<InboxItem[]>;
    };
    automations: {
      /**
       * Create a new automation (scheduled agent run).
       * Requires `automations:create` permission. Rate-limited: 3/hour per plugin.
       * Created automations default to `enabled: false` — user must manually enable.
       * Plugin attribution is recorded on the created automation.
       */
      create(definition: AutomationCreateDefinition): Promise<AutomationCreateResult>;
      /**
       * List all automation summaries.
       * Returns schedule, status, and plugin attribution for each automation.
       */
      list(): Promise<AutomationSummary[]>;
    };
    /** Navigate to surfaces — callable directly or via typed helpers */
    navigate: NavigationHelpers;
    ui: {
      /**
       * Show a toast notification. Rate-limited to 3 per 10 seconds.
       * Uses the app's existing Sonner toast infrastructure.
       */
      showToast(message: string, options?: ShowToastOptions): void;
    };
    /**
     * Make a mediated HTTP GET request to an allowlisted external domain.
     * Requires `external-fetch` permission and `externalDomains` in the manifest.
     * Rate-limited to 30 requests/min per plugin. Response capped at 1MB.
     * Redirects are disabled for security.
     */
    fetch(url: string, options?: UseExternalFetchOptions): Promise<PluginFetchResult>;
    lifecycle: PluginLifecycle;
  }

  // ── Plugin Route Types ──────────────────────────────────────────────

  interface PluginRouteInfo {
    pluginId: string;
    tabId?: string;
    params: Record<string, string>;
  }

  /**
   * React hook that returns the current plugin's route info including
   * URL params passed when the plugin was opened.
   *
   * Re-renders when params change (e.g. agent opens plugin with new params).
   * Returns an empty params object when the plugin was opened without params.
   */
  export function usePluginRoute(): PluginRouteInfo;

  /**
   * React hook that returns a live list of conversation summaries.
   * Re-renders when conversations change (new, updated, deleted).
   *
   * Supports optional filtering, sorting, and pagination via params.
   * Without params, returns all conversations sorted by updatedAt descending.
   */
  export function useConversations(params?: UseConversationsParams): {
    data: ConversationSummary[];
    totalCount: number;
    isLoading: boolean;
  };

  /**
   * React hook returning the currently-viewed conversation session, or null.
   * Returns null when: no conversation is active (homepage/settings/plugin),
   * or the current session is private.
   * Requires `conversations:read` permission.
   */
  export function useActiveSession(): ActiveSession | null;

  /**
   * React hook returning a single conversation by ID, or null.
   * Returns null for private or non-existent sessions.
   * Deleted sessions return the summary with `deletedAt` set.
   * Requires `conversations:read` permission.
   */
  export function useConversation(id: string): ConversationSummary | null;

  /**
   * React hook that returns the Rebel API object for navigation,
   * conversation management, and lifecycle management.
   *
   * The lifecycle manager auto-cleans intervals, timeouts, and
   * subscriptions when the plugin component unmounts.
   */
  export function useRebel(): RebelApi;

  /**
   * React hook for per-plugin persistent key-value storage.
   * Returns a useState-like [value, setValue] tuple. Values persist
   * across plugin unmount/remount and app restart.
   *
   * Storage is namespaced per plugin (10MB quota). Cleaned up only
   * on explicit plugin deletion, NOT on disable.
   */
  /**
   * Plugin manifest field controlling where plugin data is stored.
   * 'local' = per-user (each user has their own data, stored in userData).
   * 'shared' = in Space directory (all Space members share data, colocated with plugin code).
   * Default: 'local'. Independent of where plugin code lives.
   */
  type PluginStorageScope = 'local' | 'shared';

  export function usePluginStorage<T>(key: string, defaultValue: T): [T, (value: T) => void];

  /**
   * Convenience wrapper around usePluginStorage that adds schema versioning
   * and automatic data migration.
   *
   * Stores data in a version envelope `{ _v: number, d: T }`. On load, if the
   * stored version is older than the current schemaVersion, the migrate callback
   * is invoked to upgrade the data. The upgraded data is written back automatically.
   *
   * If the migrate callback throws, the old data is preserved (not overwritten)
   * and a warning is logged.
   *
   * Plugins that don't need versioning can continue using usePluginStorage directly.
   *
   * @see MIGRATIONS.md in build-custom-plugin skill references
   */
  export function usePluginStorageWithVersion<T>(
    key: string,
    defaultValue: T,
    options: {
      /** Current schema version number (monotonically increasing integer) */
      schemaVersion: number;
      /** Called when stored data is older than schemaVersion. Receives the old version and old data, returns upgraded data. */
      migrate: (oldVersion: number, oldData: unknown) => T;
    },
  ): [T, (value: T) => void];

  interface SearchResult {
    filePath: string;
    title: string;
    snippet: string;
    score: number;
  }

  type MemorySearchStatus = 'ok' | 'index_not_ready' | 'embedding_not_ready' | 'error';

  interface MemorySearchOptions {
    /** Max results (default 10, max 50) */
    limit?: number;
    /** Filter by path prefix (e.g., 'memory/sources') */
    pathPrefix?: string;
  }

  /**
   * React hook that searches workspace files using semantic search.
   * Query is debounced (300ms) to avoid excessive search requests.
   * Returns matching files with path, title, snippet, and relevance score.
   *
   * The `status` field indicates backend readiness:
   * - `'ok'` — search ran successfully (may return 0 results)
   * - `'index_not_ready'` — workspace file index is still being built
   * - `'embedding_not_ready'` — embedding service is still loading
   * - `'error'` — unexpected search failure
   *
   * Empty query returns empty results with `status: 'ok'` without making an IPC call.
   */
  export function useMemorySearch(query: string, options?: MemorySearchOptions): {
    results: SearchResult[];
    isLoading: boolean;
    error: string | null;
    status: MemorySearchStatus;
  };

  // ── Source Types ────────────────────────────────────────────────────

  interface UseSourcesParams {
    /** Semantic search query */
    query?: string;
    /** Filter by type: 'meeting', 'email', 'slack', etc. */
    sourceTypes?: string[];
    /** Filter by participant name/email */
    participants?: string[];
    /** Filter by date range */
    dateRange?: {
      after?: string;   // YYYY-MM-DD
      before?: string;  // YYYY-MM-DD
    };
    /** Max results (default 20, max 50) */
    limit?: number;
  }

  interface SourceEntry {
    /** Identity key (e.g. 'memory/sources/meetings/2026-03-25_standup.md') */
    relativePath: string;
    title: string;
    sourceType: string;
    /** e.g. 'recall', 'fathom', 'plaud' */
    sourceSystem: string;
    /** ISO date string */
    occurredAt: string;
    participants: string[];
    summary: string;
    keyTakeaways: string[];
    durationMinutes?: number;
    description: string;
    sourceUrl?: string;
    /** Present when query is provided */
    relevanceScore?: number;
  }

  /**
   * React hook that searches and filters memory sources.
   * Query is debounced (300ms) to avoid excessive search requests.
   *
   * Without params, returns all sources. With params, filters by
   * query, source type, participants, and/or date range.
   */
  export function useSources(params?: UseSourcesParams): {
    sources: SourceEntry[];
    totalCount: number;
    isLoading: boolean;
    error: string | null;
  };

  // ── Topic Types ───────────────────────────────────────────────────

  interface UseTopicsParams {
    /** Filter by title/content substring (case-insensitive) */
    query?: string;
    /** Restrict to a specific configured space path */
    spacePath?: string;
    /** Max results (default 20, max 50) */
    limit?: number;
  }

  interface TopicEntry {
    /**
     * Workspace-relative path to the topic file.
     * Example: "Chief-of-Staff/memory/topics/project-notes.md"
     */
    relativePath: string;
    /** Title from frontmatter (fallback: filename) */
    title: string;
    /** Space path that contains this topic */
    spacePath: string;
    /** Last modified timestamp as ISO string */
    updatedAt: string;
  }

  /**
   * React hook that lists/searches markdown topic files under `memory/topics/`
   * across configured spaces. Query is debounced (300ms).
   *
   * Requires plugin permission: `memory:read`
   */
  export function useTopics(params?: UseTopicsParams): {
    topics: TopicEntry[];
    isLoading: boolean;
    error: string | null;
  };

  interface UseEntitiesParams {
    /** Restrict to people or companies */
    entityType?: 'person' | 'company';
    /** Filter by canonical name or aliases (case-insensitive) */
    query?: string;
    /** Filter by company name (case-insensitive) */
    company?: string;
    /** Max results (default 20, max 50) */
    limit?: number;
  }

  interface EntityEntry {
    canonicalName: string;
    entityType: 'person' | 'company';
    emails: string[];
    company?: string;
    role?: string;
    domain?: string;
    aliases: string[];
  }

  /**
   * React hook that lists/searches entity metadata extracted from memory.
   * Query is debounced (300ms). Returns plugin-safe metadata only.
   *
   * Requires plugin permission: `entities:read`
   */
  export function useEntities(params?: UseEntitiesParams): {
    entities: EntityEntry[];
    isLoading: boolean;
    error: string | null;
  };

  /**
   * React hook that loads a topic markdown file by workspace-relative path.
   * Returns frontmatter-stripped markdown content, or null if not found.
   *
   * Security: path is validated server-side to ensure reads are restricted
   * to configured `memory/topics/` directories with traversal blocked.
   *
   * Requires plugin permission: `memory:read`
   */
  export function useTopicContent(relativePath: string): {
    content: string | null;
    isLoading: boolean;
    error: string | null;
  };

  /**
   * React hook that loads a skill markdown file by workspace-relative path.
   * Returns frontmatter-parsed metadata plus markdown body content.
   *
   * Security: path is validated server-side to ensure reads are restricted
   * to configured `skills/` directories with traversal blocked.
   *
   * Requires plugin permission: `skills:read`
   */
  export function useSkillFile(relativePath: string): {
    content: string | null;
    frontmatter: Record<string, unknown> | null;
    isLoading: boolean;
    error: string | null;
  };

  // ── Source Document Types ──────────────────────────────────────────

  interface SourceDocument {
    relativePath: string;
    title: string;
    sourceType: string;
    sourceSystem: string;
    /** ISO date string */
    occurredAt: string;
    /** ISO date string */
    storedAt: string;
    participants: string[];
    summary: string;
    keyTakeaways: string[];
    durationMinutes?: number;
    truncated: boolean;
    description: string;
    sourceUrl?: string;
    /** Raw markdown body (frontmatter stripped) */
    content: string;
  }

  /**
   * React hook that loads a full source document by its relative path.
   * Returns the document content with metadata, or null if not found.
   *
   * Only paths under 'memory/sources/' are allowed for security.
   */
  export function useSourceDocument(relativePath: string): {
    document: SourceDocument | null;
    isLoading: boolean;
    error: string | null;
  };

  // ── Meeting Types ──────────────────────────────────────────────────

  interface PluginMeeting {
    id: string;
    title: string;
    /** ISO datetime */
    startTime: string;
    /** ISO datetime */
    endTime: string;
    /** Display names only — emails are omitted for privacy */
    participants: string[];
    /** Video call join link, if available */
    meetingUrl?: string;
  }

  /**
   * React hook that returns cached calendar meetings.
   * Auto-fetches on mount. Call `refresh()` to re-fetch.
   *
   * Returns a plugin-safe meeting shape that omits sensitive fields
   * (calendar source email, participant emails, filesystem paths).
   */
  export function useMeetings(params?: { todayOnly?: boolean }): {
    meetings: PluginMeeting[];
    isStale: boolean;
    isLoading: boolean;
    error: string | null;
    refresh: () => void;
  };

  // ── Clipboard Types ───────────────────────────────────────────────

  /**
   * React hook that provides write-only clipboard access.
   * Uses navigator.clipboard.writeText directly.
   * Returns true on success, false on failure.
   * Does not show a toast — the plugin can handle its own UI feedback.
   */
  export function useClipboard(): {
    copyText: (text: string) => Promise<boolean>;
  };

  // ── Event Types ────────────────────────────────────────────────────

  /**
   * Union of lifecycle event names that plugins can subscribe to.
   *
   * - `turn:started` — Agent turn begins (payload: `{ sessionId, turnId }`)
   * - `turn:completed` — Agent turn finishes successfully (payload: `{ sessionId, turnId, assistantText, toolsUsed }`)
   * - `turn:error` — Agent turn fails (payload: `{ sessionId, turnId, error }`)
   * - `conversation:created` — New session appears (payload: `{ sessionId, title }`)
   * - `conversation:updated` — Meaningful metadata changes (payload: `{ sessionId, title, changes }`)
   * - `conversation:deleted` — Session soft-deleted (payload: `{ sessionId, title }`)
   * - `conversation:restored` — Soft-deleted session restored (payload: `{ sessionId, title }`)
   * - `navigation:changed` — Active surface changes (payload: `{ target, previousTarget }`)
   * - `memory:source-added` — Memory updated after a turn (payload: `{ turnId, summary? }`)
   *
   * Privacy: `turn:*` and `conversation:*` events are suppressed during private-mode sessions.
   */
  type RebelEventType =
    | 'turn:started'
    | 'turn:completed'
    | 'turn:error'
    | 'conversation:created'
    | 'conversation:updated'
    | 'conversation:deleted'
    | 'conversation:restored'
    | 'navigation:changed'
    | 'memory:source-added'
    | `custom:${string}`;

  /**
   * React hook that subscribes to a plugin lifecycle event.
   * The callback fires whenever the specified event occurs.
   * Automatically unsubscribes when the component unmounts.
   *
   * Privacy guard: `turn:*` and `conversation:*` events are NOT dispatched
   * during private-mode sessions — plugins receive nothing.
   *
   * @param eventType — One of the RebelEventType values
   * @param callback — Called with the event payload (type depends on eventType)
   */
  export function useRebelEvent(
    eventType: RebelEventType,
    callback: (payload: unknown) => void,
  ): void;

  interface UsePreTurnHookOptions {
    /**
     * Returns context text to inject into the next agent turn's system prompt.
     * Return null (or an empty string) to provide no context for this render.
     */
    getContext: () => string | null;
    /**
     * Ordering hint for system prompt injection.
     * Higher priority contexts are placed later in the prompt.
     */
    priority?: number;
  }

  /**
   * Register supplemental plugin context that is injected before each turn.
   *
   * Context is capped to 2,000 chars per plugin and 5,000 chars total across plugins.
   * Lower-priority contexts are trimmed first when total size exceeds the cap.
   */
  export function usePreTurnHook(options: UsePreTurnHookOptions): void;

  interface PostTurnHookResult {
    sessionId: string;
    turnId: string;
    assistantText: string;
    toolsUsed: string[];
  }

  /**
   * Convenience hook for post-turn processing. Equivalent to:
   * `useRebelEvent('turn:completed', callback)` with a typed payload.
   *
   * Privacy guard: does not fire during private-mode sessions.
   */
  export function usePostTurnHook(callback: (turnResult: PostTurnHookResult) => void): void;

  // ── External Fetch Types ────────────────────────────────────────────

  /**
   * React hook that makes a mediated HTTP GET request to an allowlisted external domain.
   * The URL is validated against the plugin's manifest `externalDomains`.
   *
   * Security:
   * - Requires `external-fetch` permission and `externalDomains` in manifest
   * - GET-only (POST/PUT/DELETE deferred to future iteration)
   * - Domain validation in main process before every request
   * - Private/local IP blocking (SSRF prevention + DNS rebinding protection)
   * - Rate-limited: 30 requests/min per plugin
   * - Response capped at 1MB
   * - 30s timeout
   * - Redirects disabled
   * - No cookie jar sharing
   */
  export function useExternalFetch<T = unknown>(
    url: string,
    options?: UseExternalFetchOptions,
  ): {
    data: T | null;
    isLoading: boolean;
    error: string | null;
    refetch: () => void;
  };

  // ── AI Types ───────────────────────────────────────────────────────

  interface AiApi {
    /** Summarize text into a concise summary */
    summarize(text: string, options?: { maxLength?: number }): Promise<string>;

    /** Extract structured data from text using a JSON schema description */
    extractObject<T>(text: string, schema: {
      name: string;
      description: string;
      properties: Record<string, unknown>;
      required?: string[];
      [key: string]: unknown;
    }): Promise<T>;

    /** Generate text from a constrained prompt (max 2000 chars input, 1000 tokens output) */
    generate(prompt: string, options?: { maxTokens?: number }): Promise<string>;
  }

  /**
   * React hook that provides constrained LLM access for plugin tasks.
   * Rate-limited to 10 calls per minute per plugin. All calls are
   * tracked for cost attribution.
   *
   * Three operations: summarize (condense text), extractObject (structured
   * extraction with schema), and generate (freeform text generation).
   */
  export function useAi(): {
    ai: AiApi;
    isProcessing: boolean;
    error: string | null;
  };
}
