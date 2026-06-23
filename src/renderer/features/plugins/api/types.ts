/**
 * Plugin API Types
 *
 * Public types exposed to plugins via `@rebel/plugin-api`.
 * Keep this surface minimal — only add what plugins actually need.
 */

export interface ConversationSummary {
  id: string;
  title: string | null;
  updatedAt: number;
  createdAt: number;
  isBusy: boolean;
  messageCount: number;
  preview: string;
  /**
   * Lifecycle marker: non-null = conversation is Done; null = Active.
   * BREAKING (v0.2, 2026-06): renamed from `pinnedAt` with INVERTED polarity
   * (old `pinnedAt != null` = Active → new `doneAt == null` = Active).
   * @see rebel-plugin-api.d.ts breaking-change header + docs/project/PLUGINS_API_REFERENCE.md
   */
  doneAt: number | null;
  starredAt: number | null;
  origin: string;
  deletedAt: number | null;
  resolvedAt: number | null;
}

/**
 * Extended session info for the currently-viewed conversation.
 * Returned by `useActiveSession()`.
 */
export interface ActiveSession extends ConversationSummary {
  activeTurnId: string | null;
  isCurrentSession: true;
}

// ── Conversation Query Types ────────────────────────────────────────────

export interface UseConversationsParams {
  query?: string;
  limit?: number;
  offset?: number;
  sortBy?: 'updatedAt' | 'createdAt' | 'title';
  /** Filter by date range (timestamps in ms). Applies to `createdAt` by default, or `updatedAt` if `dateField` is set. */
  dateRange?: { after?: number; before?: number };
  /** Which date field `dateRange` applies to. Default: 'createdAt'. */
  dateField?: 'createdAt' | 'updatedAt';
  /** Filter by session origin. Accepts a single value or array of values. */
  origin?: string | string[];
  /** Filter by busy state (true = only busy, false = only idle). */
  isBusy?: boolean;
  /** Include soft-deleted sessions in results. Default: false. */
  includeDeleted?: boolean;
}

// Derived from shared IPC schema to prevent drift.
// See docs/plans/260416_plugin_permissions_followups.md — Stage 1.
export type Permission = import('@shared/ipc/schemas/plugins').PluginPermissionIpc;

// ── Write Result Envelope ───────────────────────────────────────────────

/**
 * Discriminated union envelope for plugin write/mutation operations.
 * All write methods return this shape instead of throwing.
 */
export type PluginWriteResult<T extends Record<string, unknown> = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

// ── Transcript Types ────────────────────────────────────────────────────

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  toolsUsed?: string[];
}

export interface PluginContext {
  pluginId: string;
  pluginName: string;
  content: string;
  priority: number;
}

export interface UsePreTurnHookOptions {
  getContext: () => string | null;
  priority?: number;
}

// ── Memory Search Options ───────────────────────────────────────────────

export interface MemorySearchOptions {
  limit?: number;
  pathPrefix?: string;
}

export interface PluginLifecycle {
  registerInterval(callback: () => void, ms: number): void;
  registerTimeout(callback: () => void, ms: number): void;
  registerSubscription(unsubscribe: () => void): void;
}

// ── Toast Types ─────────────────────────────────────────────────────────
export interface ShowToastOptions {
  /**
   * Known variants: default, success, error, info, warning.
   * Unknown values fall back to the default toast style.
   */
  variant?: string;
  /** Duration in ms (default 5000) */
  duration?: number;
}

// ── Navigation Helper Types ─────────────────────────────────────────────

export interface NavigationHelpers {
  (target: string): void;
  toSettings(tab?: string): void;
  toAutomations(): void;
  toTasks(): void;
  toLibrary(filePath?: string): void;
  toPlugin(pluginId: string): void;
}

export interface SkillWriteOptions {
  relativePath: string;
  content: string;
  baseContentHash?: string;
}

export interface SkillWriteResult {
  ok: boolean;
  error?: string;
  conflict?: boolean;
  currentHash?: string;
}

export interface InboxAddItemInput {
  title: string;
  description?: string;
  priority?: 'low' | 'medium' | 'high';
  /**
   * Prompt text to run when user executes the item.
   * This is persisted with plugin-created items.
   */
  actionPrompt?: string;
}

export interface InboxListParams {
  limit?: number;
}

export interface InboxItem {
  itemId: string;
  title: string;
  description?: string;
  priority: 'low' | 'medium' | 'high';
  actionPrompt?: string;
  /** Present when the item was created by a plugin and attribution is available. */
  pluginId?: string;
  createdAt: number;
  archived: boolean;
}

// ── Automation Types ────────────────────────────────────────────────────

export interface AutomationCreateDefinition {
  name: string;
  description?: string;
  /** Markdown content for the automation skill file */
  skillContent: string;
  schedule: {
    type: 'interval' | 'cron';
    /** e.g., '1h', '30m', '1d', or a cron expression */
    value: string;
  };
  /** Default: false — user must manually enable */
  enabled?: boolean;
}

export interface AutomationCreateResult {
  automationId: string;
  ok: boolean;
  error?: string;
}

export interface AutomationSummary {
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

export interface RebelApi {
  conversations: {
    open(sessionId: string): void;
    list(): ConversationSummary[];
    /** Toggle the Active/Done lifecycle (renamed from `pin` v0.2, 2026-06). */
    toggleDone(sessionId: string): void;
    star(sessionId: string): void;
    rename(sessionId: string, title: string): void;
    /** Send a message to an existing conversation. Requires `conversations:write`. Rate-limited: 5/min. */
    sendMessage(sessionId: string, message: string): Promise<PluginWriteResult>;
    /** Start a new conversation with an initial message. Requires `conversations:write`. Rate-limited: 5/min. */
    startConversation(message: string): Promise<PluginWriteResult<{ sessionId: string }>>;
    /** Create a new conversation. Optionally pre-fill the composer draft. Returns the new session ID.
     * @param options.draftText - Text to pre-fill in the composer (not auto-sent)
     * @param options.navigate - Switch UI to the new session (default: true). If false, create in background. */
    create(options?: { draftText?: string; navigate?: boolean }): string;
    /** Read transcript messages from a conversation. Requires `conversations:transcript`. Rate-limited: 10/min. */
    getTranscript(sessionId: string, options?: { limit?: number }): Promise<PluginWriteResult<{ messages: TranscriptMessage[]; state?: 'ok' | 'not_found' | 'redacted' }>>;
  };
  skills: {
    /** Write a skill file using managed conflict detection. Requires `skills:write`. Rate-limited: 5/min. */
    write(options: SkillWriteOptions): Promise<SkillWriteResult>;
  };
  inbox: {
    /** Add an inbox item (rate-limited: 10 items/min per plugin). Returns envelope. */
    addItem(item: InboxAddItemInput): Promise<PluginWriteResult<{ itemId: string }>>;
    /** List active inbox items (default limit 20, max 50). */
    getItems(params?: InboxListParams): Promise<InboxItem[]>;
  };
  automations: {
    /** Create a new automation. Requires `automations:create`. Rate-limited: 3/hour. Defaults to disabled. */
    create(definition: AutomationCreateDefinition): Promise<AutomationCreateResult>;
    /** List all automation summaries. */
    list(): Promise<AutomationSummary[]>;
  };
  navigate: NavigationHelpers;
  ui: {
    showToast(message: string, options?: ShowToastOptions): void;
  };
  /** Make a mediated HTTP GET request to an allowlisted external domain. Requires `external-fetch`. Rate-limited: 30/min. */
  fetch(url: string, options?: UseExternalFetchOptions): Promise<PluginFetchResult>;
  lifecycle: PluginLifecycle;
}

// ── External Fetch Types ────────────────────────────────────────────────

export interface UseExternalFetchOptions {
  method?: 'GET';
  headers?: Record<string, string>;
}

export interface UseExternalFetchResult<T = unknown> {
  data: T | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

export interface PluginFetchResult {
  ok: boolean;
  status: number;
  data: unknown;
  error?: string;
}

// ── Source Search Types ─────────────────────────────────────────────────

export interface UseSourcesParams {
  query?: string;
  sourceTypes?: string[];
  participants?: string[];
  dateRange?: {
    after?: string;
    before?: string;
  };
  limit?: number;
}

export interface SourceEntry {
  relativePath: string;
  title: string;
  sourceType: string;
  sourceSystem: string;
  occurredAt: string;
  participants: string[];
  summary: string;
  keyTakeaways: string[];
  durationMinutes?: number;
  description: string;
  sourceUrl?: string;
  relevanceScore?: number;
}

export interface UseSourcesResult {
  sources: SourceEntry[];
  totalCount: number;
  isLoading: boolean;
  error: string | null;
}

// ── Memory Topic Types ──────────────────────────────────────────────────

export interface UseTopicsParams {
  query?: string;
  spacePath?: string;
  limit?: number;
}

export interface TopicEntry {
  /**
   * Workspace-relative path to the topic markdown file.
   * Example: "Chief-of-Staff/memory/topics/project-notes.md"
   */
  relativePath: string;
  title: string;
  /** Space path containing this topic (relative to workspace root) */
  spacePath: string;
  /** ISO datetime string from file mtime */
  updatedAt: string;
}

export interface UseTopicsResult {
  topics: TopicEntry[];
  isLoading: boolean;
  error: string | null;
}

export interface UseEntitiesParams {
  entityType?: 'person' | 'company';
  query?: string;
  company?: string;
  limit?: number;
}

export interface EntityEntry {
  canonicalName: string;
  entityType: 'person' | 'company';
  emails: string[];
  company?: string;
  role?: string;
  domain?: string;
  aliases: string[];
}

export interface UseEntitiesResult {
  entities: EntityEntry[];
  isLoading: boolean;
  error: string | null;
}

export interface UseTopicContentResult {
  content: string | null;
  isLoading: boolean;
  error: string | null;
}

export interface UseSkillFileResult {
  content: string | null;
  frontmatter: Record<string, unknown> | null;
  isLoading: boolean;
  error: string | null;
}

// ── Source Document Types ───────────────────────────────────────────────

export interface SourceDocument {
  relativePath: string;
  title: string;
  sourceType: string;
  sourceSystem: string;
  occurredAt: string;
  storedAt: string;
  participants: string[];
  summary: string;
  keyTakeaways: string[];
  durationMinutes?: number;
  truncated: boolean;
  description: string;
  sourceUrl?: string;
  content: string;
}

export interface UseSourceDocumentResult {
  document: SourceDocument | null;
  isLoading: boolean;
  error: string | null;
}

// ── Meeting Types ───────────────────────────────────────────────────────

export interface PluginMeeting {
  id: string;
  title: string;
  startTime: string;           // ISO datetime
  endTime: string;             // ISO datetime
  participants: string[];      // Display names only
  meetingUrl?: string;         // Join link
}

export interface UseMeetingsParams {
  todayOnly?: boolean;
}

export interface UseMeetingsResult {
  meetings: PluginMeeting[];
  isStale: boolean;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

// ── Goal Types ──────────────────────────────────────────────────────────

export interface PluginGoal {
  id: string;
  text: string;
  status: 'active' | 'completed' | 'dropped';
  createdAt: number;
  updatedAt: number;
  outcome?: string;    // WOOP outcome
  obstacle?: string;   // WOOP obstacle
  plan?: string;       // WOOP plan
  quarterTag?: string;
}

export interface UseGoalsResult {
  goals: PluginGoal[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

// ── Clipboard Types ─────────────────────────────────────────────────────

export interface ClipboardApi {
  copyText: (text: string) => Promise<boolean>;
}

// ── Event Types ─────────────────────────────────────────────────────────

/**
 * Union of all lifecycle event names that plugins can subscribe to
 * via `useRebelEvent`.
 */
export type RebelEventType =
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

/** Payload for `turn:started` — emitted when an agent turn begins */
export interface TurnStartedPayload {
  sessionId: string;
  turnId: string;
}

/** Payload for `turn:completed` — emitted when an agent turn finishes successfully */
export interface TurnCompletedPayload {
  sessionId: string;
  turnId: string;
  assistantText: string;
  toolsUsed: string[];
}

/** Payload passed to `usePostTurnHook` callbacks */
export type PostTurnHookResult = TurnCompletedPayload;

/** Payload for `turn:error` — emitted when an agent turn fails */
export interface TurnErrorPayload {
  sessionId: string;
  turnId: string;
  error: string;
}

/** Payload for `conversation:created` — emitted when a new session appears */
export interface ConversationCreatedPayload {
  sessionId: string;
  title: string;
}

/** Payload for `conversation:updated` — emitted when meaningful metadata changes */
export interface ConversationUpdatedPayload {
  sessionId: string;
  title: string | null;
  /** Which fields changed (e.g., ['title', 'doneAt']) */
  changes: string[];
}

/** Payload for `conversation:deleted` — emitted when a session is soft-deleted */
export interface ConversationDeletedPayload {
  sessionId: string;
  title: string | null;
}

/** Payload for `conversation:restored` — emitted when a soft-deleted session is restored */
export interface ConversationRestoredPayload {
  sessionId: string;
  title: string | null;
}

/** Payload for `navigation:changed` — emitted when the active surface changes */
export interface NavigationChangedPayload {
  target: string;
  previousTarget: string;
}

/** Payload for `memory:source-added` — emitted when memory is updated after a turn */
export interface MemorySourceAddedPayload {
  turnId: string;
  summary?: string;
}

// ── AI Types ────────────────────────────────────────────────────────────

export interface AiApi {
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

  /** Generate text from a constrained prompt */
  generate(prompt: string, options?: { maxTokens?: number }): Promise<string>;
}

export interface UseAiResult {
  ai: AiApi;
  isProcessing: boolean;
  error: string | null;
}

// ── Plugin Route Types ──────────────────────────────────────────────────

/** Route info returned by `usePluginRoute()` — includes pluginId, optional tabId, and URL params. */
export interface PluginRouteInfo {
  pluginId: string;
  tabId?: string;
  params: Record<string, string>;
}
