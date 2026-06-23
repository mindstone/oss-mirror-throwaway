/**
 * Cross-platform client DTOs mirrored from the canonical desktop/shared contracts.
 *
 * These live in `@rebel/shared` because browser/mobile packages cannot import
 * `src/shared/*` directly with their current tsconfig roots.
 */

import type { FileLocation } from '../fileLocation';
import type { BlockSource, ToolBlockSource } from '../safety/blockSource';
import type { ExternalContext } from './externalContext';

export interface CloudSlackContextMetadata {
  userId?: string;
  userDisplayName?: string | null;
  userName?: string | null;
  channelName?: string | null;
  teamName?: string | null;
  permalink?: string | null;
}

// `CloudExternalContext` was historically a hand-rolled mirror of the canonical
// `ExternalContext` discriminated union. Now that the Zod-derived schema lives
// in `@rebel/shared` (relocated 2026-05-06 to fix the web-companion zod walk-up
// bug), the mirror is redundant — keep the alias only so the existing public
// export name continues to resolve. New code should import `ExternalContext`
// directly from `@rebel/shared`.
export type CloudExternalContext = ExternalContext;

export interface CloudSessionUsageStats {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  turnCount: number;
}

export interface CloudSessionSummary {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  cloudUpdatedAt?: number;
  resolvedAt: number | null;
  /** Canonical lifecycle field (non-null = Done). */
  doneAt?: number | null;
  starredAt: number | null;
  deletedAt: number | null;
  origin: 'manual' | 'automation' | 'mcp-tool' | 'inbound-trigger' | 'plugin';
  isCorrupted: boolean;
  privateMode?: boolean;
  interruptedTurnId?: string | null;
  preview: string;
  firstMessagePreview?: string;
  lastMessagePreview?: string;
  messageCount: number;
  hasDraft: boolean;
  draftPreview: string | null;
  draftUpdatedAt: number | null;
  usage: CloudSessionUsageStats;
  activeTurnId: string | null;
  isBusy: boolean;
  lastActivityAt?: number | null;
  lastError: string | null;
  maxSeq?: number;
  externalContext?: CloudExternalContext;
  meetingCompanion?: {
    meetingUrl: string;
  };
}

export interface CloudSessionMessage {
  id: string;
  turnId: string;
  role: 'user' | 'assistant' | 'result';
  text: string;
  createdAt: number;
  isHidden?: boolean;
  /** Companion-turn trigger metadata, persisted on the user message for mobile/web rendering. */
  triggerSource?: 'voice-trigger' | 'quick-ask-button';
  triggerSourceSpeaker?: 'unknown' | 'user' | string;
  triggeredAt?: number;
  triggerExtracted?: string;
  /**
   * Marker indicating this message represents a turn that ended in a recovered
   * terminal-transient state (e.g. provider stream dropped after retries).
   * Mirrors the desktop AgentTurnMessage.endedWith field; surfaced to mobile
   * so the cloud-rendered transcript can show a parity status marker.
   */
  endedWith?: 'transient_error' | 'superseded';
}

export interface ImageContentBlock {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface ImageRef {
  assetId: string;
  mimeType: string;
  byteSize: number;
  width?: number;
  height?: number;
  thumbnailAssetId?: string;
  uploadStatus?: 'pending' | 'uploaded' | 'missing';
  [key: string]: unknown;
}

export interface ContentRef {
  contentId: string;
  mimeType: string;
  byteSize: number;
  summary?: string;
  etag?: string;
  uploadStatus?: 'pending' | 'uploaded' | 'missing';
  [key: string]: unknown;
}

export interface ToolResultContentRefBlock {
  type: 'content_ref';
  contentRef: ContentRef;
  summary?: string;
  [key: string]: unknown;
}

export type KnownAssetResolutionReason =
  | 'ok'
  | 'pending-sync'
  | 'not-found'
  | 'permission-denied'
  | 'mime-rejected'
  | 'corrupt'
  | 'oversized'
  | 'upload-failed'
  | 'quota-exceeded'
  | 'unknown';

export type AssetResolutionReason = KnownAssetResolutionReason | (string & {});

export interface ToolResultImageContentSource {
  type: 'base64';
  media_type: string;
  data: string;
}

export interface ToolResultImageContentBlock {
  type: 'image';
  source?: ToolResultImageContentSource;
  imageRef?: ImageRef;
  [key: string]: unknown;
}

export type ToolResultContentBlock =
  | ToolResultImageContentBlock
  | ToolResultContentRefBlock
  | Record<string, unknown>;

export type McpAppStructuredFallback =
  | {
      kind: 'email-draft';
      payload: {
        to: string[];
        cc?: string[];
        bcc?: string[];
        subject: string;
        body: string;
      };
    }
  | {
      kind: 'calendar-pick';
      payload: {
        title?: string;
        options: Array<{
          id?: string;
          label: string;
          start?: string;
          end?: string;
          location?: string;
        }>;
      };
    }
  | {
      kind: 'document-outline';
      payload: {
        title?: string;
        sections: Array<{
          heading: string;
          bullets?: string[];
        }>;
      };
    }
  | {
      kind: 'plain';
      payload: {
        markdown: string;
      };
    };

export interface McpAppUiMeta {
  resourceUri: string;
  presentation?: 'primary' | 'inline';
  viewSummary?: string;
  viewRoleLabel?: string;
  structuredFallback?: McpAppStructuredFallback;
  sourcePackageId?: string;
  protocolUrl?: string;
  originalFilePath?: string;
  visibility?: ('model' | 'app')[];
  csp?: {
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
  };
  permissions?: {
    camera?: boolean;
    microphone?: boolean;
    geolocation?: boolean;
    clipboardWrite?: boolean;
  };
}

export interface CloudSessionToolEvent {
  type: 'tool';
  toolName: string;
  detail: string;
  stage: 'start' | 'end';
  isError?: boolean;
  toolUseId?: string;
  parentToolUseId?: string;
  timestamp: number;
  imageContent?: ImageContentBlock[];
  imageRef?: (ImageRef | null)[];
  contentRef?: (ContentRef | null)[];
  mcpAppUiMeta?: McpAppUiMeta;
  toolResult?: {
    content?: unknown[];
    structuredContent?: unknown;
  };
}

export interface CloudSessionCore {
  id: string;
  title: string;
  cloudUpdatedAt?: number;
  messages: CloudSessionMessage[];
  activeTurnId: string | null;
  isBusy: boolean;
  lastError: string | null;
  maxSeq?: number;
  /**
   * Lifecycle state (non-null = Done). Mirrors `AgentSession.doneAt` and the
   * field on `CloudSessionSummary`. The detail view reads this via strict null
   * to drive the Mark-as-done ⇄ Reopen toggle, so the full-session payload must
   * carry it through. See docs/plans/260614_done-state-rename.
   */
  doneAt?: number | null;
  /** Favourite state (non-null = Starred). Mirrors `AgentSession.starredAt`. */
  starredAt?: number | null;
  meetingCompanion?: {
    meetingUrl: string;
  };
  /**
   * User-set success criterion for this conversation. Mirrored from
   * `AgentSession.finishLine`. See `docs/plans/260515_finish_line.md`.
   */
  finishLine?: string;
}

export interface ToolApprovalRequest {
  toolUseID: string;
  turnId: string;
  sessionId?: string;
  toolName: string;
  input: Record<string, unknown>;
  reason?: string;
  timestamp: number;
  allowPermanentTrust?: boolean;
  effectiveToolId?: string;
  /** Display-metadata forwarded by toolSafetyService (optional at rest; present on live events). */
  riskLevel?: 'low' | 'medium' | 'high';
  packageName?: string;
  conversationTitle?: string;
  /** Discriminator for why the tool was blocked — prevents trust escalation on eval_error approvals. */
  blockedBy?: ToolBlockSource;
}

export interface PendingMemoryApproval {
  toolUseId: string;
  originalTurnId: string;
  originalSessionId: string;
  turnId: string;
  sessionId: string;
  filePath: string;
  spaceName: string;
  summary: string;
  content: string;
  timestamp: number;
  sensitivityReason?: string;
  hasSpaceOverride?: boolean;
  privateMode?: boolean;
  blockedBy?: BlockSource;
  spacePath?: string;
  location?: FileLocation;
  sharing?: 'private' | 'restricted' | 'company-wide' | 'public';
  contentPreview?: string;
  approvalIdentifier?: string;
  approvalKind?: 'memory_write' | 'shared_skill_checkpoint';
  /** Human-readable label identifying who authored the underlying write (e.g. "Me", "Skill Author"). */
  authorLabel?: string;
  /** True when content was already staged to CoS pending — approval is informational */
  staged?: boolean;
}

export interface StagedToolCall {
  id: string;
  sessionId: string;
  turnId: string;
  timestamp: number;
  expiresAt: number;
  status: 'pending' | 'executing' | 'executed' | 'failed' | 'rejected' | 'expired';
  mcpPayload: {
    packageId: string;
    toolId: string;
    args: Record<string, unknown>;
  };
  displayName: string;
  toolCategory: 'side-effect' | 'read-only';
  riskLevel?: 'low' | 'medium' | 'high';
  reason?: string;
  allowPermanentTrust?: boolean;
  blockedBy?: ToolBlockSource;
  automationId?: string;
  automationName?: string;
  result?: {
    success: boolean;
    content?: string;
    error?: string;
    executedAt: number;
  };
}

export type ImageAttachmentMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface ImageAttachmentPayload {
  id: string;
  name: string;
  type: 'image';
  mimeType: ImageAttachmentMimeType;
  base64Data: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  originalPath?: string;
}

export interface DocumentAttachmentPayload {
  id: string;
  name: string;
  type: 'document';
  mimeType: 'application/pdf';
  base64Data: string;
  sizeBytes: number;
  pageCount?: number;
  extractedText?: string;
  originalPath?: string;
}

export interface TextFileAttachmentPayload {
  id: string;
  name: string;
  type: 'textfile';
  mimeType: string;
  content: string;
  originalSizeBytes: number;
  contentSizeBytes: number;
  originalPath?: string;
}
