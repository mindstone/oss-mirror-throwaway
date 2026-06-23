import type { AgentSessionSidebarStatus } from "@renderer/constants";
import type { AgentSession } from "@shared/types";
import type {
  ToolSafetyApprovalRequestBroadcast,
  ToolSafetyStagedCallBroadcast,
  ToolSafetyStagedCallUpdatedBroadcast,
} from "@rebel/shared";
import type { SessionRuntimeState } from "./utils/runtimeState";

// Re-export for unified approval UI
export type { MemoryWriteApprovalRequest } from "./hooks/useMemoryApproval";

export type ToolApprovalRequest = ToolSafetyApprovalRequestBroadcast;

/** Staged tool call awaiting execution */
export type StagedToolCall = ToolSafetyStagedCallBroadcast & {
  isExecuting?: boolean;
  status?: ToolSafetyStagedCallUpdatedBroadcast['status'];
  errorMessage?: string;
};

export type AgentSessionWithRuntime = AgentSession & {
  runtime?: SessionRuntimeState;
  isCorrupted?: boolean;
  /** Transient: tracks terminated turn IDs for post-terminal self-heal guard.
   *  Not persisted — rebuilt from events during replay. */
  terminatedTurnIds?: Set<string>;
};

export type AgentSessionSidebarEntry = {
  id: string;
  title: string;
  preview: string;
  timestamp: number;
  status: AgentSessionSidebarStatus;
  isHistory: boolean;
  isCorrupted: boolean;
  isResolved: boolean;
  resolvedAt: number | null;
  /** True when session is Active (not Done). Derived `doneAt == null`
   *  (single inversion of the negative-state field, like `deletedAt`).
   *  Required (not optional): every producer derives it via `isSessionActive(...)`,
   *  so consumers never see `undefined` — which previously risked a done↔active
   *  flip when coerced. See docs/plans/260614_done-state-rename/PLAN.md. */
  isActive: boolean;
  /** True when session is starred as a favorite */
  isStarred?: boolean;
  /** True when session is soft-deleted (in trash) */
  isDeleted?: boolean;
  /** Timestamp the session was soft-deleted (used to sort the Trash view) */
  deletedAt?: number | null;
  sortRank?: number;
  origin?: "manual" | "automation" | "focus" | "browser-extension";
  /** Total cost in USD for the session (computed from eventsByTurn) */
  totalCostUsd?: number | null;
  /** Number of messages in the session */
  messageCount: number;
  /** First user message text (truncated) for tooltip */
  firstMessagePreview?: string;
  /** Last message text (truncated) for tooltip - differs from preview when there are multiple messages */
  lastMessagePreview?: string;
  /** Estimated time saved in minutes for this session */
  timeSavedMinutes?: number | null;
  /** Whether this session has pending coaching insights */
  hasCoaching?: boolean;
  /** Whether this session has pending memory approval requests */
  hasPendingMemoryApproval?: boolean;
  /** Whether this session has draft text content */
  hasDraft?: boolean;
  /** Preview of draft text for draft-only sessions (first ~50 chars) */
  draftPreview?: string;
  /** Whether this session is a meeting companion session */
  isMeetingCompanion?: boolean;
  /** Whether this session has a response the user hasn't viewed yet */
  hasUnreadResponse?: boolean;
};
