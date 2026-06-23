/**
 * Inbound Trigger Framework — Types & Interfaces
 *
 * Generic types for polling external sources (Slack, email, etc.) and spawning
 * agent turns when triggers are detected. Adapter-agnostic by design.
 */

import type { AgentEvent, AgentSession, AppSettings } from '@shared/types';
import type { ExternalConversationService } from '@core/services/externalConversation/externalConversationService';
import type { ConversationScopeResolver } from '@core/services/externalConversation/conversationScopeResolver';
import type { ExternalContext } from '@core/services/externalConversation/externalContext';
import type { VersionedData } from '../../utils/storeMigration';

// ---------------------------------------------------------------------------
// Trigger & Adapter
// ---------------------------------------------------------------------------

/**
 * A single inbound trigger detected by an adapter.
 * Represents an external event (e.g., a Slack @-mention) that should
 * spawn an agent turn.
 */
export interface InboundTrigger {
  /** Adapter that produced this trigger (e.g., 'slack-mention') */
  adapterId: string;
  /** Source identifier within the adapter (e.g., Slack workspace teamId) */
  sourceId: string;
  /** Source-specific timestamp for ordering / dedup (e.g., Slack message ts) */
  timestamp: string;
  /** Human-readable summary for logging and UI */
  summary: string;
  /** Unique message identifier for dedup (e.g., Slack message ts + channel) */
  messageId: string;
  /** Adapter-specific context passed through to prompt building */
  context: Record<string, unknown>;
  /**
   * Canonical external-conversation context for transports that can bind to an
   * existing conversation (for example, Slack thread continuity).
   *
   * When present, `InboundTriggerService.processTrigger` first performs a
   * read-only `ConversationScopeResolver.lookup()` and routes through
   * `ExternalConversationService` instead of the legacy inbound-session mint
   * path.
   */
  externalContext?: ExternalContext;
}

/**
 * PreToolUse safety hook function.
 * Structurally compatible with the HookCallback type defined in `@core/agentRuntimeTypes`
 * (originally defined by the Claude Agent SDK, now produced by Rebel Core). Defined here to avoid coupling the generic
 * framework to runtime internals.
 */
export type InboundTriggerSafetyHook = (
  input: Record<string, unknown>,
  toolUseID: string | undefined,
  options: { signal: AbortSignal }
) => Promise<Record<string, unknown>>;

/**
 * Contract that every inbound trigger adapter must implement.
 *
 * Each adapter is responsible for polling a single external source type
 * (e.g., Slack @-mentions, email, Teams) and converting events into
 * `InboundTrigger` objects.
 */
export interface InboundTriggerAdapter {
  /** Unique identifier for this adapter (e.g., 'slack-mention') */
  readonly id: string;
  /** Human-readable display name (e.g., 'Slack @-mentions') */
  readonly displayName: string;

  /**
   * Check if the adapter has the required configuration to operate.
   * Returns false if tokens/credentials are missing.
   */
  isConfigured(): Promise<boolean>;

  /**
   * Poll for new triggers since the given timestamp for a specific source.
   * Returns the oldest unprocessed trigger, or null if no new triggers.
   *
   * @param sourceId - Source identifier (e.g., Slack workspace teamId)
   * @param lastSeenTs - Last processed timestamp (null on first poll)
   * @param processedIds - Set of recently processed message IDs for dedup
   * @returns The oldest unprocessed trigger, or null
   */
  poll(
    sourceId: string,
    lastSeenTs: string | null,
    processedIds: Set<string>
  ): Promise<InboundTrigger | null>;

  /**
   * Get all source IDs this adapter should poll.
   * For Slack, this returns workspace teamIds.
   */
  getSourceIds(): Promise<string[]>;

  /** Default polling interval in milliseconds */
  getDefaultIntervalMs(): number;

  /**
   * Build the agent turn prompt for a given trigger.
   * The prompt should include all context the agent needs.
   */
  buildPrompt(trigger: InboundTrigger): string;

  /**
   * Build a clean, user-facing display message shown in the conversation sidebar.
   * Unlike buildPrompt (which contains internal instructions for the agent), this
   * should be a human-readable summary of what triggered the turn.
   * Optional — falls back to trigger.summary if not implemented.
   */
  buildDisplayMessage?(trigger: InboundTrigger): string;

  /**
   * Post a deterministic acknowledgment (e.g., "On it!" reply).
   * Best-effort: failures are logged but do not prevent the agent turn.
   */
  postAcknowledgment(trigger: InboundTrigger): Promise<void>;

  /**
   * Check if all prerequisites are met to enable this adapter.
   * Returns { ready: true } or { ready: false, reason: "..." }.
   * Used by the UI to gate the toggle and show actionable guidance.
   */
  checkPrerequisites(): Promise<{ ready: boolean; reason: string | null }>;

  /**
   * Create an optional PreToolUse safety hook for a specific trigger.
   * The hook is injected into the agent turn and can intercept/block tool calls
   * based on adapter-specific safety concerns (e.g., PII in public channels,
   * unauthorized CRM writes, etc.).
   *
   * Returns null if no additional safety checks are needed for this trigger.
   * Settings are passed so the hook can call behind-the-scenes LLM evaluation.
   */
  createSafetyHook?(
    trigger: InboundTrigger,
    settings: AppSettings
  ): InboundTriggerSafetyHook | null;

  /**
   * Optional cleanup hook for adapters with per-process in-flight duplicate
   * guards. Called when trigger processing fails before the source cursor is
   * advanced, so the same event remains retryable.
   */
  releaseDuplicateGuard?(trigger: InboundTrigger): void;
}

// ---------------------------------------------------------------------------
// Persisted State (electron-store)
// ---------------------------------------------------------------------------

/** Per-source state within an adapter (e.g., per Slack workspace) */
export interface InboundTriggerSourceState {
  /** Last successfully processed trigger timestamp (source-specific format) */
  lastSeenTs: string | null;
  /** Bounded LRU of recently processed message IDs for dedup (max 200) */
  lastProcessedIds: string[];
}

/** Per-adapter state */
export interface InboundTriggerAdapterState {
  enabled: boolean;
  lastPollAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  pollCount: number;
  triggerCount: number;
  /** Per-source state keyed by source ID (e.g., Slack workspace teamId) */
  sources: Record<string, InboundTriggerSourceState>;
}

/** Top-level persisted state shape */
export interface InboundTriggerStoreState extends VersionedData {
  version: number;
  adapters: Record<string, InboundTriggerAdapterState>;
}

// ---------------------------------------------------------------------------
// Service Dependencies
// ---------------------------------------------------------------------------

/** Dependencies injected into InboundTriggerService */
export interface InboundTriggerServiceDeps {
  executeAgentTurn: (
    turnId: string,
    prompt: string,
    options: {
      sessionId: string;
      onEvent: (event: AgentEvent) => void;
      /** Adapter-provided PreToolUse safety hook (opaque to the framework) */
      inboundSafetyHook?: InboundTriggerSafetyHook;
    }
  ) => Promise<void>;
  getSettings: () => AppSettings;
  createSession: (session: {
    id: string;
    title: string;
    createdAt: number;
    origin: string;
  }) => Promise<void>;
  updateSession: (session: AgentSession) => Promise<void>;
  broadcastToRenderer: (channel: string, payload: unknown) => void;
  externalConversationService?: Pick<ExternalConversationService, 'createConversation' | 'injectMessage'>;
  conversationScopeResolver?: Pick<ConversationScopeResolver, 'lookup' | 'getBinding'>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of processed IDs to retain per source for dedup */
export const MAX_PROCESSED_IDS = 200;

/** Store version for migration framework */
export const INBOUND_TRIGGER_STORE_VERSION = 1;

/** Lookback window (ms) when a source is polled for the first time */
export const FIRST_ENABLE_LOOKBACK_MS = 5 * 60 * 1000; // 5 minutes
