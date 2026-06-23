// cloud-client/src/types.ts — Canonical API-contract types for the Rebel cloud service.

import type {
  CloudSessionSummary as SharedSessionSummary,
  CloudSessionMessage as SharedSessionMessage,
  CloudSessionToolEvent as SharedSessionToolEvent,
  McpAppUiMeta as SharedMcpAppUiMeta,
  McpAppStructuredFallback as SharedMcpAppStructuredFallback,
  CloudSessionCore as SharedSessionCore,
  PendingMemoryApproval as SharedPendingMemoryApproval,
  StagedToolCall as SharedStagedToolCall,
  ImageContentBlock as SharedImageContentBlock,
  ImageRef as SharedImageRef,
  AssetResolutionReason as SharedAssetResolutionReason,
  ImageAttachmentMimeType as SharedImageAttachmentMimeType,
  ImageAttachmentPayload as SharedImageAttachmentPayload,
  DocumentAttachmentPayload as SharedDocumentAttachmentPayload,
  TextFileAttachmentPayload as SharedTextFileAttachmentPayload,
  FileLocation,
  ToolSafetyApprovalRequestBroadcast,
} from '@rebel/shared';
import type { AgentEvent } from '@shared/types';
import type { ExternalContext } from '@rebel/shared';
import type { DiagnosticSections } from '@shared/diagnostics/diagnosticBundleSections';

export type {
  ExternalContext,
  SlackMentionPollContext,
  SlackThreadContext,
  SlackThreadContextMetadata,
} from '@rebel/shared';

/**
 * User-question events surfaced on the lean session API so clients can
 * rehydrate the answered state after a force-quit. See:
 *   docs/plans/260420_user_question_cross_surface_resilience.md (Stage 7)
 *   cloud-service/src/routes/sessions.ts::filterLeanEventsByTurn
 */
export type SessionUserQuestionEvent = Extract<AgentEvent, { type: 'user_question' }>;
export type SessionUserQuestionAnsweredEvent = Extract<AgentEvent, { type: 'user_question_answered' }>;

export type SessionSummary = Omit<
  Pick<
    SharedSessionSummary,
    | 'id'
    | 'title'
    | 'createdAt'
    | 'updatedAt'
    | 'cloudUpdatedAt'
    | 'resolvedAt'
    | 'preview'
    | 'messageCount'
    | 'activeTurnId'
    | 'isBusy'
    | 'lastActivityAt'
    | 'lastError'
    | 'maxSeq'
    | 'doneAt' // canonical lifecycle field
    | 'starredAt'
    | 'deletedAt'
    | 'origin'
    | 'usage'
    | 'meetingCompanion'
  >,
  'origin'
> & {
  origin: string;
};

export type SessionMessage = SharedSessionMessage;

export type ImageContentBlock = SharedImageContentBlock;
export type ImageRef = SharedImageRef;
export type AssetResolutionReason = SharedAssetResolutionReason;

export type SessionToolEvent = SharedSessionToolEvent;
export type McpAppUiMeta = SharedMcpAppUiMeta;
export type McpAppStructuredFallback = SharedMcpAppStructuredFallback;

export type FullSession = Omit<SharedSessionCore, 'messages' | 'externalContext'> & {
  messages: SessionMessage[];
  externalContext?: ExternalContext;
  toolEventsByTurn?: Record<string, SessionToolEvent[]>;
  /**
   * User-question events keyed by turnId. Populated from the lean session API
   * so mobile / cloud-client can rehydrate the answered state after a
   * force-quit. Contains both `user_question` (the agent's ask) and
   * `user_question_answered` (the user's response) events.
   */
  userQuestionEventsByTurn?: Record<
    string,
    Array<SessionUserQuestionEvent | SessionUserQuestionAnsweredEvent>
  >;
};

export type ToolApproval = ToolSafetyApprovalRequestBroadcast;

export type MemoryWriteApproval = Pick<
  SharedPendingMemoryApproval,
  | 'toolUseId'
  | 'originalTurnId'
  | 'originalSessionId'
  | 'spaceName'
  | 'filePath'
  | 'summary'
  | 'contentPreview'
  | 'timestamp'
> & {
  // Cloud-client keeps these looser because the web store still normalizes
  // legacy payloads that may not exactly match the canonical IPC schema yet.
  spacePath: string;
  location?: FileLocation;
  sharing?: string;
  isNewFile: boolean;
  blockedBy: string;
  /** True when content was already staged to CoS pending — approval is informational */
  staged?: boolean;
  /** Label for the author of the pending write (surfaces "Me", a skill name, etc). */
  authorLabel?: string;
  /** Narrowed approval kind for UI branching ("memory_write" vs "shared_skill_checkpoint"). */
  approvalKind?: string;
};

export type CloudStagedToolCall = Omit<
  Pick<
    SharedStagedToolCall,
    | 'id'
    | 'sessionId'
    | 'turnId'
    | 'timestamp'
    | 'status'
    | 'displayName'
    | 'toolCategory'
    | 'riskLevel'
    | 'reason'
    | 'mcpPayload'
    | 'blockedBy'
  >,
  'status' | 'toolCategory' | 'riskLevel'
> & {
  status: string;
  toolCategory: string;
  riskLevel: string;
  /** Friendly automation name when the call originated from an automation (optional). */
  automationName?: string;
  /** Whether the user may grant permanent trust from this approval card. */
  allowPermanentTrust?: boolean;
};

export interface StagedFile {
  id: string;
  realPath: string;
  spaceName: string;
  spacePath: string;
  location?: FileLocation;
  sessionId: string;
  baseHash: string;
  summary: string;
  stagedAt: number;
  sensitivity: 'high';
  sharing?: string;
  blockedBy?: string;
  hasConflict?: boolean;
  approvalKind?: string;
  authorLabel?: string;
  toolUseId?: string;
  /**
   * Optional pending destination (absolute workspace-relative path) used by the mapper
   * for paired-memory dedup when toolUseId is absent but destinations match.
   */
  pendingDestination?: string;
}

// ---------------------------------------------------------------------------
// Web file attachment types (compatible with backend AgentTurnRequest.attachments)
// ---------------------------------------------------------------------------

/** Supported image MIME types */
export type WebImageMimeType = SharedImageAttachmentMimeType;

/** Image attachment — resized and base64-encoded client-side */
export type WebImageAttachment = SharedImageAttachmentPayload & {
  mimeType: WebImageMimeType;
};

/** PDF document attachment — base64-encoded */
export type WebDocumentAttachment = SharedDocumentAttachmentPayload;

/** Text file attachment — content read as text */
export type WebTextFileAttachment = SharedTextFileAttachmentPayload;

/** Union of all web file attachment types */
export type WebFileAttachment = WebImageAttachment | WebDocumentAttachment | WebTextFileAttachment;

// ---------------------------------------------------------------------------
// Inbox types — re-exported from @rebel/shared (canonical cross-platform types)
// ---------------------------------------------------------------------------
export type {
  InboxReference,
  InboxSource,
  InboxQuadrant,
  InboxItem,
  InboxHistoryEntry,
  InboxState,
  InboxItemStatus,
  InboxDismissReasonCategory,
} from '@rebel/shared';

// ---------------------------------------------------------------------------
// Share types
// ---------------------------------------------------------------------------
// No canonical shared equivalent yet; this is the public share endpoint shape.
export interface SharedMessage {
  id: string;
  role: 'user' | 'assistant' | 'result';
  text: string;
  createdAt: number;
}

// No canonical shared equivalent yet; this is the public share endpoint shape.
export interface SharedSession {
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: SharedMessage[];
}

// Public shared file response shape (returned by GET /api/shared/:shareId for file shares).
export interface SharedFile {
  resourceType: 'file';
  fileName: string;       // just the filename, NOT the full workspace path
  mimeType: string;
  size: number;
  content?: string;       // present for text/markdown files
  downloadUrl?: string;   // present for binary files (HMAC-signed if password-protected)
  updatedAt: number;
}

// Discriminated union for public share response — callers check `resourceType` to determine rendering.
// Missing `resourceType` in the response defaults to conversation (backward compat with existing shares).
export type SharedResource = SharedSession | SharedFile;

// ---------------------------------------------------------------------------
// Feedback types
// ---------------------------------------------------------------------------
// No canonical shared equivalent yet; mobile + web-companion still consume this
// cloud-client-owned request contract.

export interface FeedbackRequest {
  feedbackType: 'bug' | 'improvement' | 'other';
  urgency: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  stepsToReproduce?: string;
  expectedBehavior?: string;
  platform: 'web' | 'ios' | 'android';
  appVersion?: string;
  /** Optional diagnostic bundle (device info + privacy-filtered logs) from mobile clients. */
  diagnostics?: {
    deviceInfo: Record<string, string>;
    filteredLogs?: string;
    logLineCount?: number;
    queueSnapshot?: {
      pendingCount: number;
      processingCount: number;
      countsByType: Record<string, number>;
      countsByErrorCategory: Record<string, number>;
      maxAttempts: number;
      oldestAgeMs: number | null;
      queueFull: boolean;
      limitedConnectivity: boolean;
      authExpired: boolean;
    };
    continuityState?: {
      connectionState: 'connected' | 'reconnecting' | 'disconnected';
      knownSessionCount: number;
      appliedSeqSessionCount: number;
      lastTombstoneSyncAt: number | null;
      queueBoundCloudUrlHash?: string;
    };
    catchUpHistory?: Array<{
      sessionIdHash: string;
      appliedSeq: number;
    }>;
  };
  /** Optional cloud-side diagnostic snapshot (JSON string) from /api/diagnostics/self. */
  serverContext?: string;
  /** Per-bundle diagnostic section overrides; not persisted. */
  diagnosticSections?: DiagnosticSections;
  /**
   * Stable per-report id minted by the client (mobile offline feedback queue).
   * Drives per-report fingerprint entropy on the cloud relay so each distinct
   * report is its own Sentry issue. Optional for backwards-compat.
   */
  clientReportId?: string;
  /**
   * Stable 32-char lowercase hex id minted by the client, reused across the
   * offline queue's delivery retries. The cloud relay sets it as the Sentry
   * `event_id` so a retried-after-delivery report dedups server-side instead of
   * creating a duplicate issue. Must be hex (not a dashed UUID). Optional.
   */
  eventId?: string;
}
