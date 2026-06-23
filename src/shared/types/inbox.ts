import type { AgentTurnMessage } from './agent';

// ---------------------------------------------------------------------------
// Canonical inbox types — re-exported from @rebel/shared
// These are the cross-platform single source of truth.
// ---------------------------------------------------------------------------
export type {
  InboxReference,
  InboxSource,
  SocialPlatform,
  InboxActionExecute,
  InboxActionShareToSocial,
  InboxAction,
  InboxItemCategory,
  InboxItemStatus,
  InboxDismissReasonCategory,
  InboxConfidence,
  InboxPriority,
  InboxQuadrant,
  InboxItem,
  InboxExecutionMode,
  InboxHistoryEntry,
  InboxState,
} from '@rebel/shared';

// Re-import for use in local type definitions below
import type {
  InboxSource,
  InboxItemStatus,
  InboxPriority,
  InboxItemCategory,
  InboxConfidence,
  InboxReference,
  InboxItem,
  InboxExecutionMode,
  InboxHistoryEntry,
  InboxState,
} from '@rebel/shared';

// ---------------------------------------------------------------------------
// Desktop-only types — defined locally (not in @rebel/shared)
// ---------------------------------------------------------------------------

// Contextual Dashboard Suggestions
export type AttentionSuggestion = {
  id: string;
  icon: string;
  title: string;
  detail: string;
  iCan: string;
  prompt: string;
  // Optional richer fields to improve prioritization and drill-down
  type?: 'email' | 'slack' | 'teams' | 'file' | 'generic' | 'calendar' | 'linear' | 'git';
  urgency?: 'high' | 'medium' | 'low';
  timestamp?: string;
  metadata?: Record<string, unknown>;
};

export type ConversationTitleTranscriptEntry = {
  role: AgentTurnMessage['role'];
  text: string;
};

export type ConversationTitleRequestPayload = {
  sessionId: string;
  transcript: ConversationTitleTranscriptEntry[];
};

export type ConversationTitleResponsePayload = {
  title: string | null;
};

/**
 * Lightweight index entry for inbox items (~200 bytes per item).
 * Used for fast startup - full item data is loaded on demand.
 */
export interface InboxIndexEntry {
  id: string;
  title: string;
  archived: boolean;
  addedAt: number;
  archivedAt?: number;
  /** Source kind only for badge display */
  sourceKind?: InboxSource['kind'];
  /** @deprecated Use urgent + important instead */
  priority?: InboxPriority;
  /** Eisenhower: requires immediate attention */
  urgent?: boolean;
  /** Eisenhower: matters for goals/values */
  important?: boolean;
  /** Session ID of currently executing conversation */
  executingSessionId?: string;
  /** Epoch ms after which this item is no longer actionable */
  relevantDate?: number;
  /** Epoch ms by which this item should be completed. Used for temporal grouping. */
  dueBy?: number;
  /** Origin/intent category for filtering and analytics */
  category?: InboxItemCategory;
  /** Free-form topic tags for filtering and search */
  tags?: string[];
  /** Rebel's confidence that this item is actionable (derived at read time if absent) */
  confidence?: InboxConfidence;
  /** Whether this item was auto-completed by Rebel */
  autoCompleted?: boolean;
  /** Lifecycle status (derive from `archived` when absent) */
  status?: InboxItemStatus;
  /** Epoch ms of last mutation. Used for cloud sync conflict resolution. */
  updatedAt?: number;
}

/**
 * Index state for inbox (metadata only).
 * Full item content is stored in separate entry files.
 */
export type InboxIndexState = {
  /** Schema version (INBOX_STORE_VERSION constant). NOT a data revision counter. */
  version: number;
  entries: InboxIndexEntry[];
  history: InboxHistoryEntry[];
  /** Tombstones for deleted items — prevents cloud pull from resurrecting them. */
  deletedIds?: Array<{ id: string; deletedAt: number }>;
  /** Marker to indicate migration from legacy inbox.json is complete */
  migrationComplete?: boolean;
  /** Marker to indicate one-time retroactive quality cleanup has run */
  retroactiveCleanupComplete?: boolean;
  /** Version of retroactive cleanup rules that have been applied (bumped when rules improve) */
  retroactiveCleanupVersion?: number;
  /** Epoch ms of last periodic freshness check (rate-limits to once per hour) */
  lastFreshnessCheck?: number;
};

// ---------------------------------------------------------------------------
// Deprecated aliases — desktop backward-compat naming only
// ---------------------------------------------------------------------------

/** @deprecated Use InboxReference instead */
export type TaskReference = InboxReference;
/** @deprecated Use InboxSource instead */
export type TaskSource = InboxSource;
/** @deprecated Use InboxItem instead */
export type TaskQueueItem = InboxItem;
/** @deprecated Use InboxExecutionMode instead */
export type TaskExecutionMode = InboxExecutionMode;
/** @deprecated Use InboxHistoryEntry instead */
export type TaskHistoryEntry = InboxHistoryEntry;
/** @deprecated Use InboxState instead */
export type TaskQueueState = InboxState;
