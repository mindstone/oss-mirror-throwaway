/**
 * Canonical cross-platform inbox types.
 *
 * These are the single source of truth for inbox data structures shared across
 * desktop (Electron), cloud-service, cloud-client (mobile + web-companion).
 *
 * Desktop-only types (InboxIndexEntry, InboxIndexState, AttentionSuggestion,
 * ConversationTitle*, deprecated Task* aliases) remain in src/shared/types/inbox.ts.
 */

export type InboxReference =
  | {
      kind: 'workspace';
      path: string;
      label?: string;
    }
  | {
      kind: 'url';
      url: string;
      label?: string;
    }
  | {
      kind: 'email';
      threadId: string;
      messageId?: string;
      provider?: 'gmail' | 'outlook';
      label?: string;
    }
  | {
      kind: 'linear';
      issueId: string;
      label?: string;
    }
  | {
      kind: 'github';
      owner: string;
      repo: string;
      issueNumber: number;
      label?: string;
    }
  | {
      kind: 'asana';
      taskId: string;
      label?: string;
    };

export type InboxSource =
  | {
      kind: 'text';
      label: string;
    }
  | {
      kind: 'workspace';
      path: string;
      label?: string;
    }
  | {
      kind: 'automation';
      automationId: string;
      automationName: string;
      label?: string;
    }
  | {
      kind: 'role';
      roleId: string;
      roleName: string;
      rhythmLabel?: string;
      label?: string;
    }
  | {
      kind: 'meeting';
      meetingId?: string;
      meetingTitle?: string;
      label?: string;
    }
  | {
      kind: 'conversation';
      sessionId: string;
      label?: string;
    };

export type SocialPlatform = 'twitter' | 'linkedin' | 'facebook';

export type InboxActionExecute = {
  type: 'execute';
};

export type InboxActionShareToSocial = {
  type: 'shareToSocial';
  text: string;
  url?: string;
  platforms?: SocialPlatform[];
};

export type InboxAction = InboxActionExecute | InboxActionShareToSocial;

export type InboxItemCategory =
  | 'user-request'
  | 'automation'
  | 'meeting-action'
  | 'follow-up'
  | 'system'
  | 'uncategorized';

/** Rebel's confidence that an inbox item is actionable */
export type InboxConfidence = 'high' | 'medium' | 'low';

export type InboxItemStatus = 'active' | 'executing' | 'completed' | 'dismissed';

export type InboxPriority = 'p1' | 'p2' | 'p3';

export type InboxDismissReasonCategory =
  | 'not_useful'
  | 'not_an_action'
  | 'wrong_context'
  | 'already_handled'
  | 'other';

/** Eisenhower Matrix quadrant derived from urgent + important */
export type InboxQuadrant = 'do-now' | 'schedule' | 'delegate' | 'consider';

export type InboxItem = {
  id: string;
  title: string;
  text: string;
  source?: InboxSource | null;
  references: InboxReference[];
  addedAt: number;
  /** Whether this item is archived (completed/done). */
  archived?: boolean;
  /** When this item was archived (epoch ms). Set when archived becomes true. */
  archivedAt?: number;
  actions?: InboxAction[];
  /** @deprecated Use urgent + important instead. Kept for backwards compatibility. */
  priority?: InboxPriority;
  /** Whether this item requires immediate attention (Eisenhower: urgent axis). Default: false */
  urgent?: boolean;
  /** Whether this item matters for goals/values (Eisenhower: important axis). Default: true */
  important?: boolean;
  /** Optional clarifying question from Rebel to guide user input */
  clarifyingQuestion?: string;
  /** Pre-drafted deliverable (email, post, document) ready for user approval */
  draft?: string;
  /** Session ID of currently executing conversation. Set on Go, cleared on completion. */
  executingSessionId?: string;
  /** Whether the executing session should complete this item when Rebel finishes. */
  autoCompleteOnExecution?: boolean;
  /** Epoch ms after which this item is no longer actionable (e.g. the event it refers to has passed). */
  relevantDate?: number;
  /** Epoch ms by which this item should be completed. Used for temporal grouping. */
  dueBy?: number;
  /** Origin/intent category for filtering and analytics */
  category?: InboxItemCategory;
  /** Free-form topic tags for filtering and search (e.g., 'finance', 'marketing') */
  tags?: string[];
  /** Rebel's confidence that this item is actionable (derived or explicit) */
  confidence?: InboxConfidence;
  /** Override CTA label set by automations/agents at write time */
  actionLabel?: string;
  /** Whether this item was auto-completed by Rebel (not user-initiated) */
  autoCompleted?: boolean;
  /** Lifecycle status. When absent, derive from `archived` via `deriveInboxStatus`. */
  status?: InboxItemStatus;
  /** Who marked this item completed ('user' or 'rebel'). Set when status becomes 'completed'. */
  completedBy?: 'user' | 'rebel';
  /** Epoch ms when this item was marked completed. */
  completedAt?: number;
  /** Epoch ms when this item was dismissed. */
  dismissedAt?: number;
  /** Optional structured reason the user gave when deleting/dismissing the item. */
  dismissedReasonCategory?: InboxDismissReasonCategory;
  /** Optional free-text reason the user gave when deleting/dismissing the item. */
  dismissedReason?: string;
  /** Epoch ms of last mutation. Used for cloud sync conflict resolution. */
  updatedAt?: number;
};

export type InboxExecutionMode = 'execute' | 'execute_with_context';

export type InboxHistoryEntry = InboxItem & {
  executedAt: number;
  sessionId: string;
  mode: InboxExecutionMode;
  /** Whether the completion was initiated by the user or by Rebel */
  completionSource?: 'user' | 'rebel';
};

export interface InboxState {
  /** Schema version (INBOX_STORE_VERSION constant). NOT a data revision counter. */
  version: number;
  items: InboxItem[];
  history: InboxHistoryEntry[];
}
