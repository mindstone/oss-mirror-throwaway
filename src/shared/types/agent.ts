import type {
  ThinkingEffort,
} from './settings';
import type { UserQuestion, UserQuestionAnswer } from './userQuestion';
import type { FulfillmentProvider } from './providerMetadata';
import type { AgentErrorResolution, BaseAnnotation, ExternalContext } from '@rebel/shared';
import type { JsonValue } from '../ipc/schemas/common';
import type { OutputShapeMetrics } from '../utils/outputShapeMetrics';
// R2 Stage 3a-AGT (2026-05-01): canonical type-guards anchor on the
// manifest-derived AgentEventFromManifest. The hand-authored AgentEvent and
// AgentEventFromManifest are TS-level identical today (parity.schema.test.ts's
// _ManifestParityCheck sentinel + the 142-fixture S2-D corpus). The contracts
// layer never imports back from shared/types/agent.ts in production code,
// so this import is one-way (verified by validate:circular-deps).
import type { AgentEventFromManifest } from '../contracts/agentEventManifest';

export type MemoryUpdateStatusType = 'running' | 'success' | 'error' | 'skipped' | 'pending_approval';

/** Reason why a memory write was auto-approved without prompting the user */
export type AutoApproveReason =
  | 'private_space'              // Private space + default settings
  | 'permissive_setting'         // User set permissive globally or for sharing level
  | 'space_override_permissive'  // User set space-specific permissive override
  | 'low_sensitivity'            // Balanced mode, Haiku evaluated as low/medium
  | 'safety_prompt_allowed'      // Safety Prompt evaluator allowed the write
  | 'pre_approved'               // Already approved earlier in session
  | 'remembered_choice';         // User clicked "Always allow" for this file

export interface MemoryEntityUpdate {
  entity: string;
  visibility: 'private' | 'shared';
  action: 'created' | 'updated';
  summary: string;
  /** Relative file path to the memory file that was updated */
  filePath?: string;
  /** Why this write was auto-approved (omitted if user was prompted) */
  autoApproveReason?: AutoApproveReason;
  /** Space sharing level for context in explanations */
  sharing?: 'private' | 'restricted' | 'company-wide' | 'public';
}

export interface MemoryUpdateStatus {
  originalTurnId: string;
  /** Session that owns this status; optional for legacy persisted entries. */
  originalSessionId?: string;
  status: MemoryUpdateStatusType;
  summary?: string;
  entityUpdates?: MemoryEntityUpdate[];
  error?: string;
  timestamp: number;
}

/** Broadcast payload shape for memory-update statuses; producer must always set originalSessionId. */
export type BroadcastMemoryUpdateStatus = MemoryUpdateStatus & {
  originalSessionId: string;
};

/**
 * A persisted memory history entry for the "What Rebel Knows" panel.
 * Aggregates memory updates across all sessions for easy browsing.
 */
export interface MemoryHistoryEntry {
  /** Unique identifier for this entry */
  id: string;
  /** When this memory was created/updated */
  timestamp: number;
  /** Session ID where this memory originated */
  sessionId: string;
  /** Turn ID that triggered this memory update */
  turnId: string;
  /** Space name (e.g., "Chief of Staff", "Mindstone") */
  entity: string;
  /** Whether this is private or shared memory */
  visibility: 'private' | 'shared';
  /** Whether this was created or updated */
  action: 'created' | 'updated';
  /** Brief description of what was stored */
  summary: string;
  /** Relative file path within workspace */
  filePath?: string;
  /** Title of the conversation where this memory was created */
  sessionTitle?: string;
  /** Why this write was auto-approved (omitted if user was prompted) */
  autoApproveReason?: AutoApproveReason;
  /** Space sharing level for context in explanations */
  sharing?: 'private' | 'restricted' | 'company-wide' | 'public';
}

/**
 * Aggregate stats for a memory space.
 * Supports hierarchy: top-level spaces can have children (e.g., Mindstone -> Exec, General).
 */
export interface MemorySpaceStats {
  space: string;
  count: number;
  lastUpdated: number | null;
  visibility: 'private' | 'shared';
  /** Child spaces (e.g., for work/Company/Space structure) */
  children?: MemorySpaceStats[];
}

// Time Saved Estimation Types
export type TimeSavedTaskType = 'research' | 'writing' | 'coordination' | 'analysis' | 'automation' | 'mixed';
export type TimeSavedConfidence = 'low' | 'medium' | 'high';
export type TimeSavedStatusType = 'running' | 'success' | 'error';

/** Impact level for time-saved weighting. 'unknown' is used for migrated entries. */
export type ImpactLevel = 'trivial' | 'low' | 'medium' | 'high' | 'critical' | 'unknown';

/** Multipliers for each impact level. Medium is baseline (1.0x). */
export const IMPACT_MULTIPLIERS: Record<ImpactLevel, number> = {
  trivial: 0,
  low: 0.5,
  medium: 1.0,
  high: 1.25,
  critical: 1.5,
  unknown: 1.0, // Migrated entries preserve original value
};

export interface TimeSavedEstimate {
  lowMinutes: number;
  highMinutes: number;
  confidence: TimeSavedConfidence;
  taskType: TimeSavedTaskType;
  reasoning?: string;
  /** Manual effort justification paragraph for detailed/expanded views. */
  reasoningDetail?: string;
  /** Organizational impact level. Optional for backward compatibility; defaults to 'unknown'. */
  impact?: ImpactLevel;
}

export interface TimeSavedStatus {
  turnId: string;
  /** Session that owns this status; optional for legacy persisted entries. */
  originalSessionId?: string;
  status: TimeSavedStatusType;
  estimate?: TimeSavedEstimate;
  /** How long Rebel took to complete the turn (seconds) */
  actualDurationSeconds?: number;
  error?: string;
  timestamp: number;
}

/** Broadcast payload shape for time-saved statuses; producer must always set originalSessionId. */
export type BroadcastTimeSavedStatus = TimeSavedStatus & {
  originalSessionId: string;
};

export interface WeeklyTimeSavedAggregate {
  weekStartDate: string;
  totalMinutes: number;
  sessionCount: number;
}

export interface TimeSavedAggregates {
  currentWeek: WeeklyTimeSavedAggregate;
  lastWeek: WeeklyTimeSavedAggregate;
  currentMonth: { totalMinutes: number; sessionCount: number };
  allTime: { totalMinutes: number; sessionCount: number };
}

export type WeeklyTrend = 'up' | 'steady' | null;

/** Top session info for Time Saved modal (week/day breakdowns) */
export interface TopSessionInfo {
  sessionId: string;
  totalMinutes: number;
  taskType: TimeSavedTaskType;
  reasoning: string | undefined;
  /** Manual effort justification paragraph for detailed/expanded views. */
  reasoningDetail?: string;
  entryCount: number;
  /** Timestamp of the most recent time-saved entry for this session */
  latestTimestamp: number;
  /** Highest impact level among entries for this session */
  highestImpact?: ImpactLevel;
}

// Session Coaching Types (post-conversation reflection)
export type SessionCoachingCategory =
  | 'deeper_research'
  | 'related_context'
  | 'document_generation'
  | 'follow_up_action'
  | 'cross_reference'
  | 'skill_opportunity'
  | 'skill_personalization_opportunity'
  | 'automation_insight';

export type SessionCoachingState = 'pending' | 'shown' | 'acted' | 'dismissed';

export type SessionCoachingDismissalReason = 'not_relevant' | 'too_obvious' | 'not_useful' | 'other';

export interface SessionCoachingInsight {
  id: string;
  insight: string;
  context?: string;
  continuationPrompt: string;
  category: SessionCoachingCategory;
  sources?: string[];
  /** For skill_opportunity: the skill name to suggest (e.g., "meeting-prep") */
  suggestedSkill?: string;
}

export interface SessionCoachingEvaluation {
  sessionId: string;
  evaluatedAt: number;
  primaryInsight: SessionCoachingInsight;
  additionalInsights?: SessionCoachingInsight[];
  state: SessionCoachingState;
  dismissalReason?: SessionCoachingDismissalReason;
}

// Community Share Types (post-session win sharing)
export type CommunityShareCardState = 'eligible' | 'composing' | 'preview' | 'shared' | 'dismissed' | 'opted-out';

export interface CommunityShareEligibility {
  sessionId: string;
  timeSavedMinutes: number;
  timeSavedFormatted: string;
  impact: ImpactLevel;
  quip: string;
  evaluatedAt: number;
}

export interface CommunitySharePreview {
  sessionId: string;
  title: string;
  body: string;
  timeSavedMinutes: number;
  timeSavedFormatted: string;
  impact: ImpactLevel;
  quip: string;
  composedAt: number;
}

export type AnalyticsConfigState = 'disabled' | 'pending' | 'healthy' | 'error';

export interface AnalyticsStatusPayload {
  state: AnalyticsConfigState;
  enabled: boolean;
  error?: string | null;
}

/**
 * Reason a node could not be fully resolved during the workspace walk.
 * Kept in lockstep with `FileNodeUnavailableReasonSchema` in
 * `src/shared/ipc/schemas/library.ts` (the Zod boundary mirror).
 */
export type FileNodeUnavailableReason = 'realpath-failed' | 'listdir-failed';

export interface FileNode {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  children?: FileNode[];
  /** Modification time in milliseconds since epoch */
  mtime?: number;
  /**
   * Present when the node could not be fully resolved (broken/looped symlink,
   * permission denied). The node still appears in the tree so its existence is
   * visible, but its children/metadata may be incomplete.
   */
  unavailable?: FileNodeUnavailableReason;
}

export interface AgentAttachmentMeta {
  id: string;
  name: string;
  path: string;
  relativePath: string;
  size: number;
}

export interface AgentAttachmentPayload extends AgentAttachmentMeta {
  content: string;
}

/** Supported MIME types for image attachments */
export type ImageAttachmentMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** Supported MIME types for document attachments (PDFs) */
export type DocumentAttachmentMimeType = 'application/pdf';

/** Supported MIME types for office documents (DOCX, DOC, XLSX, XLS, PPTX) */
export type OfficeDocumentMimeType =
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' // .docx
  | 'application/msword' // .doc
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' // .xlsx
  | 'application/vnd.ms-excel' // .xls
  | 'application/vnd.openxmlformats-officedocument.presentationml.presentation' // .pptx
  | 'application/rtf' // .rtf
  | 'text/rtf'; // .rtf (alternative MIME type)

/**
 * Image attachment payload for sending images to the agent.
 * Uses base64 inline encoding (no Files API persistence).
 */
export interface ImageAttachmentPayload {
  id: string;
  name: string;
  type: 'image';
  mimeType: ImageAttachmentMimeType;
  /** Base64-encoded image data (without data URI prefix) */
  base64Data: string;
  /** Smaller preview retained in conversation history for sent-message thumbnails */
  previewBase64Data?: string;
  /** File size in bytes */
  sizeBytes: number;
  /** Image width in pixels (for token estimation) */
  width?: number;
  /** Image height in pixels (for token estimation) */
  height?: number;
  /** Original filesystem path (from drag-drop or file picker via webUtils.getPathForFile) */
  originalPath?: string;
}

/**
 * Document attachment payload for sending PDFs to the agent.
 * Uses base64 inline encoding (no Files API persistence).
 */
export interface DocumentAttachmentPayload {
  id: string;
  name: string;
  type: 'document';
  mimeType: DocumentAttachmentMimeType;
  /** Base64-encoded document data (without data URI prefix) */
  base64Data: string;
  /** File size in bytes */
  sizeBytes: number;
  /** Number of pages (if known, for token estimation) */
  pageCount?: number;
  /**
   * Extracted text content from the PDF (best-effort, for session recovery).
   * When a session falls back to conversation history injection (auth switch, app restart, etc.),
   * this text is included so the model retains the document's content even though the base64
   * document block is lost. NOT sent to the API — only used for history context.
   */
  extractedText?: string;
  /** Original filesystem path (from drag-drop or file picker via webUtils.getPathForFile) */
  originalPath?: string;
}

/**
 * Extracted PDF attachment payload for large PDFs where text extraction is used instead of base64.
 * Used when PDF exceeds size threshold (25MB) to avoid API limits while preserving text content.
 * Note: Images and formatting are not included in extraction.
 */
export interface ExtractedPdfAttachmentPayload {
  id: string;
  name: string;
  type: 'extracted-pdf';
  mimeType: DocumentAttachmentMimeType;
  /** Extracted text content from the PDF */
  extractedText: string;
  /** Original file size in bytes */
  originalSizeBytes: number;
  /** Extracted text size in bytes (for token estimation) */
  extractedSizeBytes: number;
  /** Original file as base64 (only present for clipboard pastes without disk path) */
  base64Data?: string;
  /** Number of pages in the original PDF */
  pageCount?: number;
  /** Original filesystem path (from drag-drop or file picker via webUtils.getPathForFile) */
  originalPath?: string;
}

/**
 * Office document attachment payload for Word/Excel files.
 * Text is extracted client-side and sent as plain text (Claude doesn't natively support these formats).
 */
export interface OfficeDocumentAttachmentPayload {
  id: string;
  name: string;
  type: 'office';
  /** Original MIME type of the uploaded file */
  mimeType: OfficeDocumentMimeType;
  /** Extracted text content from the document */
  extractedText: string;
  /** Original file size in bytes */
  originalSizeBytes: number;
  /** Extracted text size in bytes (for token estimation) */
  extractedSizeBytes: number;
  /** Original file as base64 (only present for clipboard pastes without disk path) */
  base64Data?: string;
  /** Office document subtype for UI display */
  officeType: 'word' | 'excel' | 'powerpoint' | 'rtf';
  /** Original filesystem path (from drag-drop or file picker via webUtils.getPathForFile) */
  originalPath?: string;
}

/**
 * Text file attachment payload for plain text files (.txt, .md, .json, .csv, code files, etc.).
 * Content is read client-side and sent as plain text.
 */
export interface TextFileAttachmentPayload {
  id: string;
  name: string;
  type: 'textfile';
  /** Original MIME type of the uploaded file (text/*, application/json, etc.) */
  mimeType: string;
  /** Text content read from the file */
  content: string;
  /** Original file size in bytes */
  originalSizeBytes: number;
  /** Content size in bytes (for token estimation) */
  contentSizeBytes: number;
  /** Original filesystem path (from drag-drop or file picker via webUtils.getPathForFile) */
  originalPath?: string;
}

/**
 * Binary file attachment payload for files without content extraction (ZIP, video, audio, etc.).
 * The agent receives the file path but cannot read the content in-conversation.
 * Used when the file type is not supported for content extraction.
 */
export interface BinaryFileAttachmentPayload {
  id: string;
  name: string;
  type: 'binary';
  mimeType: string;
  sizeBytes: number;
  /** Original filesystem path (from drag-drop or file picker via webUtils.getPathForFile) */
  originalPath?: string;
  /** Base64-encoded file data (only present for clipboard pastes without disk path) */
  base64Data?: string;
}

/** Union type for all attachment types */
export type AnyAttachmentPayload =
  | AgentAttachmentPayload
  | ImageAttachmentPayload
  | DocumentAttachmentPayload
  | ExtractedPdfAttachmentPayload
  | OfficeDocumentAttachmentPayload
  | TextFileAttachmentPayload
  | BinaryFileAttachmentPayload;

/** Type guard to check if an attachment is an image */
export const isImageAttachment = (
  attachment: AnyAttachmentPayload
): attachment is ImageAttachmentPayload => {
  return 'type' in attachment && attachment.type === 'image';
};

/** Type guard to check if an attachment is a document (PDF) */
export const isDocumentAttachment = (
  attachment: AnyAttachmentPayload
): attachment is DocumentAttachmentPayload => {
  return 'type' in attachment && attachment.type === 'document';
};

/** Type guard to check if an attachment is an extracted PDF (text-only, from large PDF) */
export const isExtractedPdfAttachment = (
  attachment: AnyAttachmentPayload
): attachment is ExtractedPdfAttachmentPayload => {
  return 'type' in attachment && attachment.type === 'extracted-pdf';
};

/** Type guard to check if an attachment is an office document (Word/Excel) */
export const isOfficeDocumentAttachment = (
  attachment: AnyAttachmentPayload
): attachment is OfficeDocumentAttachmentPayload => {
  return 'type' in attachment && attachment.type === 'office';
};

/** Type guard to check if an attachment is a text file (uploaded via drag-drop/paste) */
export const isTextFileAttachment = (
  attachment: AnyAttachmentPayload
): attachment is TextFileAttachmentPayload => {
  return 'type' in attachment && attachment.type === 'textfile';
};

/** Type guard to check if an attachment is a binary file (ZIP, video, etc.) */
export const isBinaryFileAttachment = (
  attachment: AnyAttachmentPayload
): attachment is BinaryFileAttachmentPayload => {
  return 'type' in attachment && attachment.type === 'binary';
};

/** Type guard to check if an attachment is a workspace text file (via @ mentions) */
export const isTextAttachment = (
  attachment: AnyAttachmentPayload
): attachment is AgentAttachmentPayload => {
  return (
    !('type' in attachment) ||
    (attachment.type !== 'image' &&
      attachment.type !== 'document' &&
      attachment.type !== 'extracted-pdf' &&
      attachment.type !== 'office' &&
      attachment.type !== 'textfile' &&
      attachment.type !== 'binary')
  );
};

/**
 * Image content block from MCP tool results.
 * Used for displaying images inline in tool output (e.g., screenshots).
 * Persisted in session history so images render when revisiting conversations.
 */
export interface ImageContentBlock {
  type: 'image';
  /** Base64-encoded image data */
  data: string;
  /** MIME type (e.g., 'image/png', 'image/jpeg') */
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

/**
 * Reference to an opaque-content blob stored in the session-scoped
 * {@link ContentStore}. Mirrors `ImageRef` for non-image payloads
 * (tool output, command output, file content materializations).
 *
 * See `docs/plans/260518_cloud_sync_reconciliation_hardening.md` § Stage B1a.
 */
export interface ContentRef {
  contentId: string;
  mimeType: string;
  byteSize: number;
  /** Inline preview preserved alongside the ref so the renderer and search
   *  can display a snippet without hydration. Capped at ~500 chars. */
  summary?: string;
  /** Optional content-addressed etag (typically equal to `contentId`). */
  etag?: string;
  uploadStatus?: 'pending' | 'uploaded' | 'missing';
  [key: string]: unknown;
}

/**
 * Tool-result content block variant carrying a {@link ContentRef} in place
 * of inline bytes. Producers replace large inline blocks with this variant
 * after successfully publishing to the {@link ContentStore}; consumers
 * hydrate on demand via `cloud-client` / local content store.
 */
export interface ToolResultContentRefBlock {
  type: 'content_ref';
  contentRef: ContentRef;
  /** Optional snippet preserved so summaries render without hydration. */
  summary?: string;
  [key: string]: unknown;
}

export const KNOWN_ASSET_RESOLUTION_REASONS = [
  'ok',
  'pending-sync',
  'not-found',
  'permission-denied',
  'mime-rejected',
  'corrupt',
  'oversized',
  'upload-failed',
  'quota-exceeded',
  'unknown',
] as const;

export type KnownAssetResolutionReason = (typeof KNOWN_ASSET_RESOLUTION_REASONS)[number];

/**
 * Open-union by convention:
 * - known literals preserve editor autocomplete
 * - `(string & {})` accepts forward-compatible reason codes without schema breakage
 */
export type AssetResolutionReason =
  | KnownAssetResolutionReason
  | (string & {});

export function isKnownAssetResolutionReason(value: string): value is KnownAssetResolutionReason {
  return (KNOWN_ASSET_RESOLUTION_REASONS as readonly string[]).includes(value);
}

export function summarizeAssetResolutionReason(
  value: AssetResolutionReason,
): { known: boolean; fallback?: string } {
  if (isKnownAssetResolutionReason(value)) {
    return { known: true };
  }
  return { known: false, fallback: value };
}

export type AssetResolutionContext =
  | 'hydrate'
  | 'protocol'
  | 'cloud-get'
  | 'lifecycle'
  | 'persist'
  | 'upload'
  | 'quota'
  | 'curation';

export interface ResolutionFailure {
  timestamp: number;
  sessionIdHash: string;
  assetIdHash?: string;
  reason: AssetResolutionReason;
  context: AssetResolutionContext;
  metadata?: Record<string, JsonValue>;
}

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

/**
 * Records a degradation event during a turn (e.g., auth or model fallback).
 * Multiple fallbacks can occur in a single turn.
 */
export interface TurnFallback {
  type: 'auth' | 'model' | 'context' | 'tier_model' | 'provider';
  from: string;
  to: string;
  reason: string;
  /**
   * "Who pays" classification for the destination of a `type: 'provider'`
   * failover (e.g. a 429 rate-limit failover to a different provider). Optional +
   * additive: absent on legacy/cloud turns and on non-provider fallbacks; it
   * drives the user-facing "Switched to … — pay-as-you-go / using your credits /
   * covered" copy in the usage tooltip. Populated on the failover RETRY once the
   * fresh route resolves (the original write records `to: 'auto-failover'` with no
   * billing identity yet). See docs/plans/260621_paid-fallback-indicator/.
   *
   * Inlined (not imported from `@shared/utils/billingSource`) to avoid a
   * `shared/types → billingSource → shared/types` import cycle — `billingSource.ts`
   * depends on `shared/types`. Must match `BillingSource` there (the canonical
   * source) and the Zod enums in ipc/schemas/agent.ts + contracts/agentEventManifest.ts.
   */
  billingSource?: 'subscription' | 'pool' | 'pay-per-use' | 'local' | null;
}

export interface ModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  authMethod?: string;
  openRouterProvider?: string;
  providersSeen: string[];
  fulfillmentProvider?: FulfillmentProvider | null;
}

/**
 * WIRE spelling of a model role tier, as persisted in `ModelRoleBinding.role`
 * (session store + cloud sync) and validated by the Zod schemas in
 * `ipc/schemas/agent.ts` + `contracts/agentEventManifest.ts`. The cheap tier is
 * spelled `'fast'` here for backward/cross-version compatibility with already-
 * persisted turns — DO NOT rename these members. Internal code uses the canonical
 * `ModelRoleTier` (`'background'`); convert at the boundary. See
 * docs/plans/260614_smart-model-routing/ROLE_VOCAB_UNIFICATION_PLAN.md.
 */
export type ModelRoleWire = 'thinking' | 'working' | 'fast';

/**
 * CANONICAL capability-tier role — the single source of truth for "which of the
 * user's three model tiers." The cheap/auxiliary tier is spelled `'background'`
 * (matching the persisted `behindTheScenesModel` field, the Settings "Behind the
 * Scenes" label, and the search keywords) — NOT `'fast'`, which is a legacy
 * misnomer kept only as the wire spelling (`ModelRoleWire`) and the agent-facing
 * sub-agent alias. All internal model-role logic (resolver, configured fallback,
 * provider defaults, quality tiers, role assignment, fallback telemetry) uses
 * THIS type; convert to/from `ModelRoleWire` at the persistence boundary.
 *
 * Replaces the former drift family (`ConfiguredFallbackRole`, `ProviderRole`,
 * `QualityTierRole`, `FallbackTelemetryRole`, and the trio part of `RoleId`),
 * which were independently-declared copies of the same three tiers. See
 * docs/plans/260614_smart-model-routing/ROLE_VOCAB_UNIFICATION_PLAN.md.
 */
export type ModelRoleTier = 'thinking' | 'working' | 'background';

/**
 * Runtime-authored binding of a model role to the concrete model that played it for one turn.
 *
 * This is the fix for the Turn Usage tooltip showing the wrong/duplicate model per tier: instead
 * of the renderer reconstructing roles by string-comparing `model` vs `planningModel` (fragile —
 * see docs/plans/260601_diagnose-model-tier-tooltip/PLAN.md), the runtime authors role truth and
 * the renderer reads it.
 *
 * `roles[]` is an ANNOTATION layer over `modelUsage`, NOT a parallel usage ledger — it carries no
 * tokens/cost. For an `observed` role the renderer joins to `modelUsage[modelUsageKey]` for usage.
 * `modelUsage` remains the per-model usage/cost source of truth (and still surfaces council /
 * sub-agent models that have no role binding).
 */
export interface ModelRoleBinding {
  /** Which runtime role this model played (wire spelling; `'fast'` = Behind the Scenes). */
  role: ModelRoleWire;
  /** Canonical model id (via `toCanonicalModelId`) — stable across spellings; used to join + dedup. */
  canonicalModelId: string;
  /** The original served/configured model id, preserved for display. */
  rawModelId: string;
  /**
   * `observed` = this role actually ran this turn (has a `modelUsageKey`).
   * `configured_not_used` = the configured model for this role did not run (e.g. the worker on a
   * direct-answer turn, or the Background/BTS model when no BTS call fired) — shown for availability.
   */
  status: 'observed' | 'configured_not_used';
  /** The `modelUsage` key whose tokens/cost this role produced. Present iff `status === 'observed'`. */
  modelUsageKey?: string;
  /** Per-role auth method. Nullable/unknown by design — not always resolvable (esp. configured-not-used / BTS). */
  authMethod?: string;
  /** Per-role provider, when known. */
  provider?: string;
  /** Whether the model's cost is known to the pricing catalog. `unpriced` must render as such, never `$0`. */
  pricingStatus?: 'priced' | 'unpriced';
}

// =============================================================================
// MCP Apps Types (Interactive Tool Views)
// =============================================================================

/**
 * MCP App UI metadata for primary/inline presentation.
 *
 * Contract: `presentation: 'primary'` requires `viewSummary` (Zod refinement).
 * `viewRoleLabel` and `structuredFallback` carry the accessible/recovery
 * plaintext surfaces for primary views.
 * Producer policy: only tools the user actually interacts with should opt into
 * `primary`. Method 3 (legacy auto-detection) MUST NOT promote to primary.
 *
 * See docs/plans/260507_unified_interactive_ui_architecture.md § Phase A3.
 *
 * @see https://modelcontextprotocol.io/docs/extensions/apps
 */
export interface McpAppUiMeta {
  /** URI to the HTML resource (ui://tool-name/app.html) */
  resourceUri: string;
  /** Presentation priority for this view. Defaults to 'inline'; 'primary' requires viewSummary at schema boundaries. */
  presentation?: 'primary' | 'inline';
  /** Short plaintext summary for mobile, accessibility, search/export, and recovery surfaces. */
  viewSummary?: string;
  /** Short noun phrase describing the view's role (for example, "Editable email draft"). */
  viewRoleLabel?: string;
  /** Structured plaintext fallback payload for surfaces that cannot render the iframe. */
  structuredFallback?: McpAppStructuredFallback;
  /** The MCP package instance ID that produced this tool result (e.g., "GoogleWorkspace-jane-example-com"). Used for routing resource fetches back to the correct package. */
  sourcePackageId?: string | null;
  /** Direct protocol URL to load in iframe (skips IPC fetch). Used for folder-mode previews. */
  protocolUrl?: string;
  /** Original file path on disk (for "Open in Browser" feature) */
  originalFilePath?: string;
  /** Visibility for the tool - 'model' means callable by LLM, 'app' means callable from UI */
  visibility?: ('model' | 'app')[];
  /** Content Security Policy domain allowlists for the sandboxed iframe */
  csp?: {
    /** Domains allowed for fetch/XHR/WebSocket (connect-src) */
    connectDomains?: string[];
    /** Domains allowed for scripts, images, styles, fonts (script-src, img-src, etc.) */
    resourceDomains?: string[];
    /** Domains allowed for nested iframes (frame-src) */
    frameDomains?: string[];
  };
  /** Permission requests for the sandboxed iframe */
  permissions?: {
    camera?: boolean;
    microphone?: boolean;
    geolocation?: boolean;
    clipboardWrite?: boolean;
  };
}

/**
 * Host-authorized provenance envelope for MCP Apps iframe → host messages.
 *
 * The host derives this from trusted session/message state and the active iframe
 * nonce; iframe-supplied IDs are not authoritative for scoping.
 *
 * @see docs/project/MCP_APPS_BIDIRECTIONAL_TRUST_CONTRACT.md
 */
export interface IframeProvenanceEnvelope {
  source: {
    kind: 'mcp-app';
    /** Required for trust-boundary messages even though McpAppUiMeta keeps it optional for migration. */
    sourcePackageId: string;
    resourceUri: string;
    toolUseId: string;
  };
  /** Host-stamped ISO 8601 timestamp. */
  timestamp: string;
  sessionId: string;
  conversationId: string;
  /** Host-assigned iframe DOM/mount instance ID; part of the nonce validation key. */
  iframeInstanceId: string;
  /** Host-issued freshness nonce for the currently-active iframe load. */
  nonce: string;
}

/**
 * Known iframe → host JSON-RPC methods for MCP Apps.
 * `ui/sendMessage` and `ui/updateModelContext` are Phase C methods; the others
 * reflect existing or bootstrap iframe-host traffic.
 */
export type IframeMessageMethod =
  | 'ui/initialize'
  | 'ui/sendMessage'
  | 'ui/updateModelContext'
  | 'ui/resize'
  | 'tools/call';

export type TrustBoundaryRejectionReason =
  | 'stale_nonce'
  | 'missing_nonce'
  | 'source_mismatch'
  | 'unknown_method'
  | 'rate_limited'
  | 'permission_denied'
  | 'invalid_role'
  | 'invalid_params'
  | 'tool_not_allowed';

export type RateLimitTier = 'iframe' | 'conversation' | 'session' | 'aggregate';

export interface PermissionScope {
  sourcePackageId: string;
  conversationId: string;
}

export type TrustBoundaryJsonRpcCode = -32601 | -32602 | -32603 | -32000 | -32001 | -32029;

export interface TrustBoundaryRejection {
  jsonRpcCode: TrustBoundaryJsonRpcCode;
  reason: TrustBoundaryRejectionReason;
  safeMessage: string;
  correlationId?: string;
}

export interface IframeMessageEnvelope<
  TMethod extends IframeMessageMethod,
  TParams = unknown,
> {
  method: TMethod;
  params: TParams;
  provenance: IframeProvenanceEnvelope;
}

export type TrustBoundaryLogKind =
  | 'rate_limit'
  | 'replay'
  | 'permission_denial'
  | 'unknown_method'
  | 'invalid_role'
  | 'invalid_params'
  | 'injection_failed';

/**
 * Structured logging shape for MCP Apps trust-boundary rejections.
 * Content and raw sourcePackageId are intentionally excluded; use byte counts,
 * hashes, and the display-name-family resolver output only.
 */
export interface TrustBoundaryLogEvent {
  boundary: 'mcp-apps-bidirectional-trust';
  sessionId: string;
  conversationId: string;
  sourcePackageFamily: string;
  sourcePackageHash?: string;
  kind: TrustBoundaryLogKind;
  method: IframeMessageMethod | string;
  nonce: string | 'none';
  reason: TrustBoundaryRejectionReason;
  attemptedContentBytes: number;
  subkind?: string;
  toolUseId?: string;
  resourceUri?: string;
  rateLimitTier?: RateLimitTier;
  attemptCount?: number;
  timeSinceFirstAttemptMs?: number;
  attemptedContentHash?: string;
  attemptedContentOversize?: boolean;
}

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

/**
 * Data needed to render an MCP App View in a sandboxed iframe.
 * Created when a tool result with UI metadata is processed.
 */
export interface McpAppViewData {
  /** URI to the HTML resource (for identification) */
  resourceUri: string;
  /** HTML content to render in the iframe */
  htmlContent: string;
  /** Tool result data to pass to the View via postMessage */
  toolResult: {
    content?: unknown[];
    structuredContent?: unknown;
  };
  /** CSP configuration from the resource metadata */
  csp?: McpAppUiMeta['csp'];
}

/**
 * Why an agent turn ended. Surfaced in result events for renderer-side classification.
 * @see docs/plans/260415_silent_stop_detection_improvement.md
 */
export type TurnEndReason = 'completed' | 'user_stopped' | 'superseded' | 'awaiting_user' | 'error';

type AgentEventWithSeq = {
  /** Server-stamped per-session event sequence number (optional for backward compatibility). */
  seq?: number;
};

export type AgentEvent = AgentEventWithSeq & (
  | {
      type: 'status';
      message: string;
      timestamp: number;
      /**
       * Quit-vs-crash discriminator for synthetic turn-interruption statuses
       * (`TURN_INTERRUPTION_MESSAGE`). `'shutdown'` = graceful quit,
       * `'startup-correction'` = crash recovery. Absent on regular status
       * events and on interruption events persisted before this field existed.
       * @see src/shared/constants/turnInterruption.ts
       */
      source?: 'shutdown' | 'startup-correction';
      /**
       * SOFT, non-destructive "still waiting" marker (Stage 1b,
       * 260617_bricked-state-0448-electron42). Present ONLY on the one-shot
       * status the watchdog dispatches when an INTERACTIVE turn has been silent
       * in the `awaiting_api` phase (request sent, no first token) past the soft
       * threshold (`AWAITING_API_SOFT_STALL_MS`, ~30s) — the turn is still
       * running. The renderer uses it to surface an early calm "this is taking
       * longer than usual, Try again / Stop" affordance (State B) without ending
       * the turn. Optional + additive: absent on every other status event and on
       * events persisted/produced before this field existed (= today's behaviour),
       * and ignored by cloud/mobile/automation consumers that don't read it.
       * Cleared by activity resume (a subsequent status without `stall`, or the
       * turn producing output / ending).
       * @see src/core/services/watchdog/watchdogTracker.ts isAwaitingApiSoftStall
       */
      stall?: {
        phase: 'awaiting_api';
        /** Milliseconds the turn has been silent in `awaiting_api` when the soft stall first tripped. */
        sinceMs: number;
      };
    }
  | {
      type: 'assistant';
      text: string;
      timestamp: number;
    }
  | {
      type: 'assistant_delta';
      text: string;
      timestamp: number;
    }
  | {
      type: 'thinking_delta';
      text: string;
      timestamp: number;
    }
  | {
      type: 'result';
      text: string;
      model?: string;
      /** The planning model used for this turn (when plan mode was active). */
      planningModel?: string;
      modelUsage?: Record<string, ModelUsageEntry>;
      usage?: {
        inputTokens?: number | null;
        outputTokens?: number | null;
        cacheCreationTokens?: number | null;
        cacheReadTokens?: number | null;
        costUsd?: number | null;
        /** Context window utilization as percentage (0-100) */
        contextUtilization?: number | null;
        /** Context window size in tokens (200000 standard, 1000000 extended) */
        contextWindow?: number | null;
      };
      toolMetrics?: {
        totalToolCalls: number;
        failedToolCalls: number;
        filesCreated: number;
        filesEdited: number;
        workArtifactsCreated?: number;
        workArtifactsCreatedByType?: Record<string, number>;
        toolUsageByCategory: Record<string, number>;
        mcpServerUsage: Record<string, number>;
        totalToolOutputChars: number;
        mcpToolOutputChars: number;
        builtinToolOutputChars: number;
      };
      /** Content-free shape metrics for the final user-visible response. */
      outputShapeMetrics?: OutputShapeMetrics;
      subAgentMetrics?: {
        usedSubAgents: boolean;
        subAgentCount: number;
        subAgentToolCount: number;
      };
      /** Per-turn thinking effort at time of execution (Claude turns only) */
      thinkingEffort?: ThinkingEffort;
      /** Per-turn auth method at time of execution. Widened from ClaudeAuthMethod for Codex/OpenRouter/profile/local auth values. */
      authMethod?: string;
      /** Degradation events that occurred during this turn */
      fallbacks?: TurnFallback[];
      /**
       * Runtime-authored per-role model bindings (Planner/Main work/Behind the Scenes). Optional +
       * additive — absent on pre-existing persisted turns, where the renderer falls back to legacy
       * derivation. Annotation layer over `modelUsage`; carries no tokens/cost. @see ModelRoleBinding.
       */
      roles?: ModelRoleBinding[];
      /**
       * Why this turn ended. Used by renderer for silent stop classification.
       * Optional for backward compatibility with pre-existing events.
       * @see docs/plans/260415_silent_stop_detection_improvement.md
       */
      turnEndReason?: TurnEndReason;
      timestamp: number;
    }
  | {
      type: 'tool';
      toolName: string;
      toolUseId?: string;
      parentToolUseId?: string | null;
      detail: string;
      stage: 'start' | 'end';
      /** Whether the runtime reported this tool result as an error (from tool_result.is_error) */
      isError?: boolean;
      /** Original output size before any model-facing materialisation/truncation. */
      outputChars?: number;
      timestamp: number;
      /**
       * Image content from tool results (only present on 'end' stage).
       * Persisted in session history so images render when revisiting conversations.
       */
      imageContent?: ImageContentBlock[];
      imageRef?: (ImageRef | null)[];
      /**
       * Positional refs for opaque-content blocks offloaded to the
       * session-scoped {@link ContentStore}. Aligned to the position of the
       * `content_ref` block within `toolResult.content` after materialization;
       * a `null` entry means materialization failed for that block and the
       * inline content (if any) is preserved.
       * See `docs/plans/260518_cloud_sync_reconciliation_hardening.md` § Stage B1a.
       */
      contentRef?: (ContentRef | null)[];
      /**
       * MCP Apps UI metadata from tool results (only present on 'end' stage).
       * When present, indicates this tool result can render an interactive View.
       * Gated by settings.experimental.mcpAppsEnabled feature flag.
       */
      mcpAppUiMeta?: McpAppUiMeta;
      /** Full tool result payload for MCP App Views that need structured data. */
      toolResult?: {
        content?: unknown[];
        structuredContent?: unknown;
      };
      /**
       * Provenance of this tool event.
       * - `real` (or absent for backward compatibility): emitted from live model execution.
       * - `synthetic-plan-seed`: synthetic MissionSet/TaskList events seeded by the host.
       * - `pre-turn-context`: host-emitted context assembly events (file/tool/skill/conversation search, doc prefetch).
       */
      _origin?: 'real' | 'synthetic-plan-seed' | 'pre-turn-context';
    }
  | {
      type: 'error';
      error: string;
      /**
       * Top-level raw upstream error body, populated by `dispatchAgentErrorEvent`
       * when `errorSource === 'main'` for **every** error kind. Redacted
       * (Bearer/sk-/AIza/Authorization/api_key/JWT) and truncated to 4 KB before
       * persistence. Eval diagnostics fall back to this field when neither
       * `rateLimitMeta.rawError` nor `billingMeta.rawError` is present.
       */
      rawError?: string;
      isTransient?: boolean;
      /** Which process originated this error — used to deduplicate Sentry captures */
      errorSource?: 'main' | 'renderer';
      /** Structural error classification from main process (see agentErrorCatalog.ts) */
      errorKind?: import('@shared/utils/agentErrorCatalog').AgentErrorKind;
      /**
       * Optional limit attribution for provider-capacity failures:
       * - `provider`: upstream provider throttling
       * - `plan`: subscription/entitlement window or plan cap
       * - `account`: account-level credits/spend/key limits
       */
      limitScope?: 'provider' | 'plan' | 'account';
      /**
       * Route credential source at the time of failure.
       * Additive telemetry context only; never used for routing.
       */
      credentialSource?: import('./providerRoute').ProviderCredentialSource;
      /**
       * Telemetry-only headline bucket derived at dispatch from
       * `errorKind × limitScope × credentialSource`.
       */
      headlineClass?: 'rate_limit' | 'billing_quota' | 'subscription_entitlement' | 'auth' | 'other';
      /** Actionable recovery metadata derived from errorKind + provider/settings context. */
      resolution?: AgentErrorResolution;
      /** Rate-limit metadata for rich UI banner and cooldown accuracy */
      rateLimitMeta?: {
        /** Provider's actual error message (for supplementary UI display) */
        rawError?: string;
        /** Parsed retry-after duration in ms (for cooldown accuracy, NOT UI display) */
        retryAfterMs?: number;
        /** Absolute timestamp (ms) when the rate limit resets — from Codex `resets_at`. */
        resetAtMs?: number;
      };
      /** Billing metadata for subtype-aware banner copy. Presence = definitive billing signal. */
      billingMeta?: {
        subtype: import('@shared/utils/friendlyErrors').BillingSubtype;
        /** Display-only upstream provider (e.g. "anthropic" when OpenRouter routes to Anthropic). CTA routing still uses top-level `provider`. */
        upstreamProviderName?: string;
        /** Raw provider error string, preserved for display/debugging. */
        rawError?: string;
        /**
         * Present iff the failing turn routed through the Mindstone-managed
         * subscription credential. Carries the active tier so renderer copy
         * can switch between BYO-key and managed-allowance-exhaustion
         * messaging (see docs/plans/260513a_subscription_consumer_audit_gaps.md § E).
         */
        managedSubscription?: { tier: string; resetsAt?: string };
      };
      /**
       * Set when `errorKind === 'managed_model_not_allowed'`. Carries the
       * requested model id, the tier-allowlisted model ids the request would
       * have been allowed to use, and the raw upstream error string so the
       * renderer can produce a clear "this model isn't included in your
       * subscription" banner without re-parsing the body. See
       * docs/plans/260513a_subscription_consumer_audit_gaps.md § G3.
       */
      managedModelMeta?: { requested?: string; allowed?: string[]; rawError?: string };
      /** Provider name (e.g. 'Anthropic', 'OpenAI') for provider-aware error messages */
      provider?: string;
      /** Timeout diagnostic result (only present on message_timeout errors) */
      timeoutDiagnostic?: {
        kind: 'anthropic_issue' | 'internet_unreachable' | 'transient_stall';
        indicator?: string;
        description?: string;
      };
      // Parallel to timeoutDiagnostic; future consolidation into a discriminated stallDiagnostic if a third kind surfaces.
      watchdogDiagnostic?: {
        phase: string;
        messageCount: number;
        rawStreamEventCount: number;
        rawStreamLastEventType: string | null;
        rawStreamLastEventAgeMs: number | null;
        watchdogLevel: number;
        maxWatchdogLevel: number;
        effectiveAbortMs: number;
        model?: string;
      };
      timestamp: number;
    }
  | {
      type: 'context_overflow';
      originalPrompt: string;
      timestamp: number;
    }
  | {
      /** @deprecated Stage 4 retires these in favour of recovery:* events. See docs/plans/260503_unified_recovery_pipeline.md. */
      type: 'compaction_started';
      depth: number;
      sessionId: string;
      timestamp: number;
    }
  | {
      /** @deprecated Stage 4 retires these in favour of recovery:* events. See docs/plans/260503_unified_recovery_pipeline.md. */
      type: 'compaction_summary_ready';
      summary: string;
      depth: number;
      timestamp: number;
    }
  | {
      /** @deprecated Stage 4 retires these in favour of recovery:* events. See docs/plans/260503_unified_recovery_pipeline.md. */
      type: 'compaction_retrying';
      depth: number;
      timestamp: number;
    }
  | {
      /** @deprecated Stage 4 retires these in favour of recovery:* events. See docs/plans/260503_unified_recovery_pipeline.md. */
      type: 'compaction_completed';
      timestamp: number;
    }
  | {
      /** @deprecated Stage 4 retires these in favour of recovery:* events. See docs/plans/260503_unified_recovery_pipeline.md. */
      type: 'compaction_failed';
      error: string;
      depth: number;
      timestamp: number;
    }
  | {
      type: 'recovery:started';
      turnId: string;
      sessionId: string;
      originalSessionId: string;
      depth: number;
      attempt: number;
      totalCalls: number;
      timestamp: number;
      phase: 'pre_activity' | 'post_activity';
    }
  | {
      type: 'recovery:fallback_attempting';
      turnId: string;
      sessionId: string;
      originalSessionId: string;
      depth: number;
      attempt: number;
      totalCalls: number;
      timestamp: number;
      target: { kind: 'model' | 'profile'; profileId?: string; profileName?: string; modelName?: string };
    }
  | {
      type: 'recovery:fallback_succeeded';
      turnId: string;
      sessionId: string;
      originalSessionId: string;
      depth: number;
      attempt: number;
      totalCalls: number;
      timestamp: number;
      target: { kind: 'model' | 'profile'; profileId?: string; profileName?: string; modelName?: string };
    }
  | {
      type: 'recovery:compacting';
      turnId: string;
      sessionId: string;
      originalSessionId: string;
      depth: number;
      attempt: number;
      totalCalls: number;
      timestamp: number;
    }
  | {
      type: 'recovery:summary_ready';
      turnId: string;
      sessionId: string;
      originalSessionId: string;
      depth: number;
      attempt: number;
      totalCalls: number;
      timestamp: number;
      summary: string;
      revealDurationMs?: number;
    }
  | {
      type: 'recovery:retrying';
      turnId: string;
      sessionId: string;
      originalSessionId: string;
      depth: number;
      attempt: number;
      totalCalls: number;
      timestamp: number;
    }
  | {
      type: 'recovery:skeleton_attempting';
      turnId: string;
      sessionId: string;
      originalSessionId: string;
      depth: number;
      attempt: number;
      totalCalls: number;
      timestamp: number;
    }
  | {
      type: 'recovery:depth4_attempting';
      turnId: string;
      sessionId: string;
      originalSessionId: string;
      depth: number;
      attempt: number;
      totalCalls: number;
      timestamp: number;
      profileId: string;
      modelName: string;
      costEstimate: 'high';
    }
  | {
      type: 'recovery:succeeded';
      turnId: string;
      sessionId: string;
      originalSessionId: string;
      depth: number;
      attempt: number;
      totalCalls: number;
      timestamp: number;
      finalDepth: number;
      totalDurationMs: number;
    }
  | {
      type: 'recovery:failed';
      turnId: string;
      sessionId: string;
      originalSessionId: string;
      depth: number;
      attempt: number;
      totalCalls: number;
      timestamp: number;
      error: string;
      exhaustedReason: 'depth_limit_reached' | 'attempt_limit_reached' | 'no_qualifying_profile' | 'rate_limited' | 'recovery_disabled' | 'no_messages_to_compact' | 'summary_generation_failed' | 'agent_loop_error_before_recovery' | 'agent_loop_error_after_recovery' | 'long_context_fallback_failed' | 'aborted';
    }
  | {
      type: 'recovery:last_resort_skipped';
      turnId: string;
      sessionId: string;
      originalSessionId: string;
      depth: number;
      attempt: number;
      totalCalls: number;
      timestamp: number;
      reason: 'no_qualifying_profile' | 'rate_limited';
      userFacingTitle: string;
      userFacingMessage: string;
      action: string;
    }
  | {
      /** Fired when a turn is cancelled because a newer turn superseded it */
      type: 'turn_superseded';
      /** The turnId of the newer turn that replaced this one */
      newTurnId: string;
      timestamp: number;
    }
  | {
      /** Injected user message from main process (e.g., proactive coaching checks) */
      type: 'user_message';
      text: string;
      /** Optional: marks message as hidden from default view */
      isHidden?: boolean;
      timestamp: number;
    }
  | {
      /** Non-blocking warning displayed inline in conversation (e.g., MCP tools unavailable) */
      type: 'warning';
      message: string;
      category?: string;
      timestamp: number;
    }
  | {
      /** Structured questions from the agent (via AskUserQuestion tool) for inline question card */
      type: 'user_question';
      batchId: string;
      toolUseId: string;
      questions: UserQuestion[];
      /**
       * Authoritative session ID of the conversation where this question was
       * emitted. Added to close a cross-session routing leak where a stale
       * `eventsByTurn` snapshot paired with a freshly-switched
       * `currentSessionId` let a batch reconstruct with the wrong session.
       * Optional for backward compatibility with persisted events pre-fix.
       * See docs-private/investigations/260424_user_question_cross_session_routing_leak.md
       */
      sessionId?: string;
      timestamp: number;
    }
  | {
      /** Recorded when the user answers (or skips) an AskUserQuestion batch */
      type: 'user_question_answered';
      batchId: string;
      answers: UserQuestionAnswer[];
      skipped?: boolean;
      /**
       * Authoritative session ID of the conversation where this answer was
       * recorded. See the `user_question` variant above for rationale.
       */
      sessionId?: string;
      timestamp: number;
    }
  | {
      /** Lifecycle event: a new turn has started execution. Emitted before any model/tool work. */
      type: 'turn_started';
      timestamp: number;
    }
  | {
      /**
       * Desktop-renderer-IPC-only lifecycle marker emitted by `agentEventDispatcher`
       * on the FIRST `assistant_delta` of each turn, signalling that the answer
       * phase has begun (used by the renderer to clear its transient thinking
       * buffer once and only once per turn). Per the active-work CPU/GPU rebuild
       * (260508 plan, Stage 2), this event is dispatched ONLY via
       * `dispatchRendererOnlyAgentEvent` (no CLI listener fan-out, no cloud SSE
       * subscriber fan-out, no main-accumulator append). It is fully transient:
       * `mainAccumulator: false`, `rendererStore: false`, `cloud: false`,
       * `compactionPolicy: 'drop'`. See `agentEventPolicyManifest.ts`.
       */
      type: 'answer_phase_started';
      timestamp: number;
    }
);

/**
 * Narrowed AgentEvent variants for type-safe access to variant-specific fields.
 *
 * Anchored on `AgentEventFromManifest` (R2 Stage 3a-AGT cutover, 2026-05-01).
 * The hand-authored `AgentEvent` discriminated-union and the manifest-derived
 * `AgentEventFromManifest` are TS-level identical today (proven by
 * `parity.schema.test.ts`'s `_ManifestParityCheck = AssertExact<IsExactStrict<...>>`
 * sentinel) and structurally validated across 142 fixtures by S2-D. Anchoring
 * the canonical type-guards on the manifest-derived alias unblocks Stage 3b/3c
 * consumers that migrate off the hand-authored union without losing access to
 * the narrowed-extract aliases (closes the 4 `blocksStage3a` consumer-disposition
 * entries at `shared/types/agent.ts:793,800`).
 */
export type ToolAgentEvent = Extract<AgentEventFromManifest, { type: 'tool' }>;
export type ResultAgentEvent = Extract<AgentEventFromManifest, { type: 'result' }>;
export type ErrorAgentEvent = Extract<AgentEventFromManifest, { type: 'error' }>;
export type AssistantAgentEvent = Extract<AgentEventFromManifest, { type: 'assistant' }>;
export type AssistantDeltaAgentEvent = Extract<AgentEventFromManifest, { type: 'assistant_delta' }>;
export type StatusAgentEvent = Extract<AgentEventFromManifest, { type: 'status' }>;

/** Type guard for tool events — use in `.filter()` for narrowed arrays. */
export function isToolEvent(event: AgentEventFromManifest): event is ToolAgentEvent {
  return event.type === 'tool';
}

/** Type guard for assistant-family events (assistant, assistant_delta, result) — the events shown in conversation transcript. */
export function isAssistantFamilyEvent(
  event: AgentEventFromManifest
): event is AssistantAgentEvent | AssistantDeltaAgentEvent | ResultAgentEvent {
  return event.type === 'assistant' || event.type === 'assistant_delta' || event.type === 'result';
}

export interface AgentTurnEvent {
  turnId: string;
  event: AgentEvent;
  sessionId?: string;
}

/** Error categories for voice transcription failures */
export type VoiceErrorCategory = 'temporary' | 'billing' | 'auth' | 'network' | 'provider-error';

export interface VoiceTranscriptionPayload {
  audio: ArrayBuffer;
  mimeType: string;
  /** Recording duration in milliseconds, used for dynamic timeout calculation */
  durationMs?: number;
  /** WAV version of audio for pending file, converted in renderer via Web Audio API */
  pendingAudioWav?: ArrayBuffer;
  /** Optional previous transcript context for Whisper prompt conditioning (e.g. meeting chunk continuity) */
  prompt?: string;
}

export interface TtsAlignment {
  characters: string[];
  characterStartTimesSeconds: number[];
  characterEndTimesSeconds: number[];
}

export interface TtsWithTimestampsResponse {
  audio: Buffer;
  alignment: TtsAlignment;
}

export interface AgentTurnRequest {
  prompt: string;
  sessionId: string;
  /** Client-generated idempotency key for this turn request (stable across retries). */
  clientTurnId?: string;
  resetConversation?: boolean;
  /**
   * Stage 2 of `docs/plans/260525_cross_turn_awareness_layer1_layer2.md` (F3).
   * When set, the renderer is signalling that an upstream accumulator (e.g.
   * `userQuestionResponseHandler`) has already injected context into
   * `prompt`. The proactive prepend in `agentTurnExecute` must SKIP its
   * own `<prior_turns>` + `<conversation_history>` injection to avoid
   * double rendering.
   */
  continuationContext?: {
    alreadyInjected: true;
    meta: {
      headerIncluded: boolean;
      headerBytes: number;
      historyIncluded: boolean;
      historyBytes: number;
      truncated: boolean;
    };
  };
  attachments?: AnyAttachmentPayload[];
  /**
   * What to do at admission when the target session already has an active turn.
   * - 'supersede' (default when absent): cancel the existing turn (server-side
   *   dedup / interrupt backstop — legacy behavior, relied on by sendNow's
   *   stop-failure backstop, stuck-turn recovery, and cloud sends).
   * - 'reject': refuse admission with a typed error
   *   (`AGENT_TURN_TARGET_BUSY`, see `@shared/utils/agentTurnAdmission`) and
   *   leave the active turn untouched — a non-interrupt (queue-mode) send must
   *   never abort an active turn.
   * Optional for backward/forward compatibility across desktop↔cloud version
   * skew. See docs/plans/260610_queue-drain-cancels-turn/PLAN.md Stage 2.
   */
  supersedePolicy?: 'supersede' | 'reject';
  /** Private mode: forces cautious tool safety + cautious memory safety (always ask before actions/writes) */
  privateMode?: boolean;
  /** System continuation: skip clearing coaching when this turn is a system-initiated retry/continuation (e.g., memory approval, tool approval) */
  isSystemContinuation?: boolean;
  /**
   * 260622 Stage 4: bypass the Chief-of-Staff admission gate for THIS turn only
   * (the "Run without my instructions" recovery escape — the user's explicit
   * allow-proceed-with-warning choice when their Chief-of-Staff instructions
   * can't be read). When set, admission skips the Chief-of-Staff block and logs
   * a structured WARN (observable, never a silent degrade); the turn proceeds on
   * the generic template. Per-turn only — never persisted on the session, so the
   * next turn re-evaluates the Chief-of-Staff state. Desktop-only in effect (the
   * gate only runs on user-initiated desktop interactive turns).
   */
  proceedWithoutChiefOfStaff?: boolean;
  /**
   * Override the model for this turn only. Falls back to settings.models.model if not specified.
   * Useful for using a faster/cheaper model (e.g., Haiku) for simple directive tasks.
   */
  modelOverride?: string;
  /**
   * Override the thinking model for this turn only. Falls back to settings.models.thinkingModel if not specified.
   * Empty string suppresses thinking model usage (single-model mode).
   */
  thinkingModelOverride?: string;
  /**
   * Override the working profile for this turn only. Falls back to settings working profile if not specified.
   * Points to a ModelProfile id in settings.localModel.profiles.
   */
  workingProfileOverrideId?: string;
  /**
   * Override the thinking profile for this turn only. Falls back to settings thinking profile if not specified.
   * Points to a ModelProfile id in settings.localModel.profiles.
   */
  thinkingProfileOverrideId?: string;
  /**
   * Override the thinking effort for this turn only. Falls back to settings.models.thinkingEffort if not specified.
   * Per-conversation session setting that takes precedence over global effort and per-model effort,
   * but NOT over shell env CLAUDE_CODE_EFFORT_LEVEL override.
   */
  thinkingEffortOverride?: ThinkingEffort;
  /**
   * Enable unleashed mode for this turn (looser auto-continue stopping criteria).
   * When true, Claude will be pushed to complete tasks more aggressively,
   * with up to 10 auto-continues vs 3 in default mode.
   * Useful for fire-and-forget inbox tasks where user won't be watching.
   */
  unleashedMode?: boolean;
  /**
   * Input source for this turn. Used for badge tracking (voice vs text).
   * Default: 'text'
   */
  inputSource?: 'voice' | 'text';
  /**
   * Session type for this turn. Mapped to executor SessionType in main process:
   * - 'manual' -> 'interactive' (user is actively watching/interacting)
   * - 'automation' -> 'automation' (background task, skip heavy pre-turn logic)
   */
  sessionType?: 'manual' | 'automation';
  /**
   * When true, skips tool safety evaluation for this turn.
   * Used for automation runs that need to execute tools without user approval.
   */
  bypassToolSafety?: boolean;
  /** Activate council mode for this turn (dispatch parallel subagents on different model providers) */
  councilMode?: boolean;
  /** Active Space path for prompt-time Operator discovery scoping. */
  activeSpacePath?: string | null;
  /** Session origin hint — enables server-side context injection (e.g., 'focus' for Focus conversations). */
  origin?: 'manual' | 'automation' | 'role' | 'mcp-tool' | 'inbound-trigger' | 'plugin' | 'focus' | 'browser-extension' | 'operator-personalisation';
  /**
   * Cloud meeting session ID — when present, the cloud agent turn handler injects
   * the meeting's rolling transcript and conversation state into the prompt.
   * Used by mobile Ask Rebel during live meeting recording (Stage 4).
   */
  meetingSessionId?: string;
  /**
   * Indicates a live meeting recording is active for this turn, even if the
   * cloud meeting session id is not yet available.
   */
  recordingActive?: boolean;
  /**
   * Canonical metadata for companion turns started from an in-meeting trigger
   * or quick-ask action. Persisted onto the user turn message.
   */
  triggerMeta?: MeetingCompanionTriggerMeta;
  /**
   * User-set success criterion for this turn. When present, takes precedence
   * over `AgentSession.finishLine` at turn admission. Normalised through
   * `normalizeFinishLine` at every persistence boundary. See
   * `docs/plans/260515_finish_line.md`.
   */
  finishLine?: string;
  /**
   * External provenance for cloud-routed inbound turns (Slack thread / Slack
   * poll-mention). Persisted onto the AgentSession the turn creates so
   * subsequent merges, retries, and replies stay scoped to the originating
   * channel. Manual desktop turns leave this unset.
   */
  externalContext?: ExternalContext;
  /**
   * Turn-scoped system-prompt prefix. Set by main process for the first turn
   * of an Operator personalisation conversation only — never persisted on the
   * session, never replayed on subsequent turns. The trusted source lives in
   * main-side `pendingPersonalisationPrefixes` and is validated against it at
   * the `agent:turn` IPC boundary; cloud-pushed broadcasts cannot inject one.
   */
  systemPromptPrefix?: string;
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface BreadcrumbEntry {
  type: string;
  message: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

export interface RendererLogPayload {
  level: LogLevel;
  message: string;
  timestamp?: number;
  context?: Record<string, unknown>;
  error?: {
    name?: string;
    message: string;
    stack?: string | string[] | null;
    code?: string | number;
  };
  breadcrumbs?: BreadcrumbEntry[];
  source?: 'renderer' | 'preload';
  turnId?: string | null;
  sessionId?: string | null;
}

/** Origin of a user message — used for origin-aware scroll/analytics behavior.
 * Not persisted for assistant/result messages (only meaningful for user messages). */
export type MessageOrigin = 'user-typed' | 'queue-drain' | 'system-continuation' | 'voice' | 'automation';

export type MeetingCompanionTriggerSource = 'voice-trigger' | 'quick-ask-button';
export type MeetingCompanionTriggerSourceSpeaker = 'unknown' | 'user' | string;

export interface MeetingCompanionTriggerMeta {
  triggerSource: MeetingCompanionTriggerSource;
  triggerSourceSpeaker: MeetingCompanionTriggerSourceSpeaker;
  /** Epoch milliseconds when the trigger/button action was detected. */
  triggeredAt: number;
  /** Voice-trigger extracted question or quick-ask canned label, when available. */
  triggerExtracted?: string;
}

export interface AgentTurnMessage {
  id: string;
  turnId: string;
  role: 'user' | 'assistant' | 'result';
  text: string;
  usage?: string;
  createdAt: number;
  /** Server-side deletion timestamp used while converging message deletes across cloud clients. */
  deletedAt?: number;
  attachments?: AgentAttachmentMeta[];
  /** If true, message is hidden from conversation UI (used for system-initiated prompts) */
  isHidden?: boolean;
  /** If true, this is a compact approval receipt (e.g., "✓ Approved: save to X") — rendered inline without full message chrome */
  isApprovalReceipt?: boolean;
  /** If true, this is an inline warning banner (e.g., MCP tools unavailable) — rendered as amber banner */
  isWarning?: boolean;
  /**
   * Extracted text from document/PDF/office attachments, keyed by attachment name.
   * Persisted so that buildConversationHistoryContext can include document content
   * when the session is lost (auth switch, app restart, session recovery).
   */
  attachmentTexts?: Record<string, string>;
  /** Origin of this message — used for origin-aware scroll/analytics behavior.
   * Not persisted for assistant/result messages (only meaningful for user messages). */
  messageOrigin?: MessageOrigin;
  /**
   * Canonical in-meeting companion-turn metadata. These fields are persisted on
   * the user message so mobile/desktop/cloud hydration can render source labels.
   */
  triggerSource?: MeetingCompanionTriggerSource;
  triggerSourceSpeaker?: MeetingCompanionTriggerSourceSpeaker;
  triggeredAt?: number;
  triggerExtracted?: string;
  /**
   * Optional display-friendly text for the conversation UI. When present,
   * the renderer shows this instead of `text`. The `text` field remains
   * the canonical LLM-bound content (e.g., fenced annotations with
   * prompt-injection markers that users should not see).
   */
  displayText?: string;
  /**
   * Marker indicating this message represents a turn that ended in a recovered
   * terminal-transient state (e.g. provider stream dropped after retries).
   * When set, the conversation reducer has promoted whatever trajectory it
   * could find to a `result`-role message so subsequent turns continue from
   * a coherent state. Renderer surfaces a subtle "Connection dropped" status
   * marker. See docs/plans/260503_turn_error_trajectory_preservation.md.
   */
  endedWith?: 'transient_error' | 'superseded';
}

/** Marks a point in conversation where context was compacted */
export interface CompactionBoundary {
  /** Index in messages array after which compaction occurred */
  afterMessageIndex: number;
  /** The summary generated during compaction */
  summary: string;
  /** When compaction occurred */
  timestamp: number;
  /** Compaction attempt number (1 or 2) */
  depth: number;
}

/**
 * Archived tool call detail preserved before in-memory compaction strips it.
 * Keyed by toolUseId. Allows diagnostics to show full tool inputs/outputs
 * even after eventCompaction reduces the in-memory footprint.
 */
export interface ToolDetailArchiveEntry {
  toolName: string;
  /** Full input detail from the start event */
  input: string;
  /** Full output detail from the end event */
  output: string;
  /** Char count of output (for size display without parsing) */
  outputChars: number;
}

export interface ConversationAnnotation extends BaseAnnotation {
  messageId: string;
  /** Character offset from start of message body text content */
  startOffset: number;
  /** Character offset for end of selection (startOffset + text.length) */
  endOffset: number;
}

export interface AgentSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Server-stamped, monotonic ordering timestamp used by cloud clients. */
  cloudUpdatedAt?: number;
  messages: AgentTurnMessage[];
  /** Server-side ledger for message deletions not represented in `messages`. */
  _deletedMessages?: Record<string, number>;
  /** Server-side ledger for destructive event operations propagated through catch-up. */
  _destructiveOpsLedger?: Array<{
    op: 'truncateTurn' | 'deleteEventIdentity';
    target: string;
    appliedAt: number;
  }>;
  eventsByTurn: Record<string, AgentEvent[]>;
  /** Session-scoped asset quota warning for Stage 9 UI surfacing. */
  quotaWarning?: {
    kind: 'asset-count-exceeded' | 'asset-bytes-exceeded';
    count?: number;
    bytes?: number;
  };
  /** In-memory Stage 9 observability surface; capped at 100 and cleared on restart/reload. */
  assetResolutionFailures?: ResolutionFailure[];
  /**
   * Highest server-stamped event sequence number persisted for this session.
   *
   * INVARIANT: monotonically increasing within a session, but NOT necessarily
   * contiguous. Sources of legitimate gaps in persisted seq sequences:
   *   - `assistant_delta` events stamp+broadcast a seq but are deliberately
   *     not accumulated/persisted (`agentEventDispatcher.ts`).
   *   - `thinking_delta` events stamp+broadcast a seq but are deliberately
   *     not accumulated/persisted (desktop dispatcher + cloud submission paths).
   *   - Filtered transient events / legacy migration paths.
   *
   * Consumers (Stage 3 UNION dedup, cloud catch-up) MUST treat gaps as
   * normal — do NOT repair them, do NOT treat them as evidence of dropped
   * persisted events. Gap-detection breadcrumbs in
   * `unionEventsByIdentity` are observability only.
   */
  maxSeq?: number;
  activeTurnId: string | null;
  isBusy: boolean;
  lastError: string | null;
  resolvedAt: number | null;
  /**
   * Canonical lifecycle field. Non-null timestamp = conversation marked Done;
   * `null`/absent = Active. Affirmative-action polarity, matching
   * `starredAt`/`deletedAt`. Read it only through the shared
   * `isSessionDone`/`isSessionActive` predicates (`@rebel/shared`), never raw
   * truthiness — `doneAt: 0` must read as Done.
   */
  doneAt?: number | null;
  /** When set, session is starred as a favorite; value stores star timestamp */
  starredAt?: number | null;
  /** When set, session is soft-deleted (in trash); value stores deletion timestamp */
  deletedAt?: number | null;
  /** Timestamp when auto-title was last generated. Cleared on manual rename. */
  autoTitleGeneratedAt?: number;
  /** Number of completed turns when the last auto-title was generated. Used to gate re-titling. */
  autoTitleTurnCount?: number;
  isCorrupted?: boolean;
  origin?: 'manual' | 'automation' | 'role' | 'mcp-tool' | 'inbound-trigger' | 'plugin' | 'focus' | 'browser-extension' | 'operator-personalisation';
  externalContext?: ExternalContext;
  /** Memory update status by original turn ID */
  memoryUpdateStatusByTurn?: Record<string, MemoryUpdateStatus>;
  /** Time saved estimation status by turn ID */
  timeSavedStatusByTurn?: Record<string, TimeSavedStatus>;
  /**
   * One grounded sentence summarising what the agent did, keyed by turn ID.
   * Generated cheaply behind the scenes on turn completion for substantial
   * turns only; the deterministic count-line recap is the graceful fallback.
   * Additive optional field (no store-version bump).
   */
  activitySummaryByTurn?: Record<string, string>;
  automationId?: string | null;
  automationRunId?: string | null;
  /** Boundaries where context compaction occurred (for visual continuity) */
  compactionBoundaries?: CompactionBoundary[];
  /** Private mode: forces cautious tool safety + cautious memory safety (always ask before actions/writes) */
  privateMode?: boolean;
  /** Per-conversation working model override (Claude model string, e.g., 'claude-opus-4-7') */
  sessionWorkingModel?: string;
  /** Per-conversation thinking model override (Claude model string, e.g., 'claude-opus-4-7') */
  sessionThinkingModel?: string;
  /** Per-conversation working profile ID override (points to a ModelProfile id) */
  sessionWorkingProfileId?: string;
  /** Per-conversation thinking profile ID override (points to a ModelProfile id) */
  sessionThinkingProfileId?: string;
  /** Per-conversation thinking effort override */
  sessionThinkingEffort?: ThinkingEffort;
  /** Turn ID that was interrupted when the app closed (for auto-resume on next startup) */
  interruptedTurnId?: string | null;
  /** Draft text content (persisted for crash resilience) */
  draft?: {
    text: string;
    updatedAt: number;
  };
  /** Pending conversation annotations scoped to this session. */
  annotations?: ConversationAnnotation[];
  /** App/setup metadata tied to the conversation lifecycle. */
  setupContext?: {
    kind: 'bundled-app-bridge';
    pairSessionId?: string;
    pendingAnnouncement?: {
      status: 'connected' | 'expired' | 'cancelled';
      emittedAt: number;
    };
  };
  /**
   * Archive of tool call details preserved before in-memory compaction.
   * Populated by cacheSession() before stripping detail strings from events.
   * Keyed by toolUseId. Only contains entries for tool calls that had non-empty details.
   */
  toolDetailArchive?: Record<string, ToolDetailArchiveEntry>;
  /** Meeting companion metadata (for meeting-linked conversations) */
  meetingCompanion?: {
    /** Meeting URL - stable identifier that survives bot retries */
    meetingUrl: string;
    /** Current bot ID (may change on retry) */
    botId?: string;
    /** Meeting title for display */
    meetingTitle: string;
    /** When the companion session started */
    startedAt: number;
    /** Path to prep notes file (if available) */
    prepPath?: string;
    /** Coach configuration (optional - companion can exist without coach) */
    coach?: {
      /** Path to the coach skill file */
      skillPath: string;
      /** Human-readable name of the coach skill */
      skillName: string;
      /** If true, show all coaching checks. If false, filter routine responses. */
      showAllChecks?: boolean;
    };
    /** 
     * Tracks which coach context was last injected into the conversation.
     * Used to determine if we need to re-inject when coach changes.
     * - undefined/null = no context injected yet (first turn)
     * - '' = context injected with no coach (tool hint only)
     * - 'path/to/skill' = context injected with this coach skill
     */
    lastInjectedCoachPath?: string | null;
  };
  /**
   * User-set success criterion for this conversation; fed into the
   * auto-continue evaluator and injected into the system prompt when set.
   * Normalised through `normalizeFinishLine` at every persistence boundary
   * (trim, length cap, empty -> undefined). See
   * `docs/plans/260515_finish_line.md`.
   */
  finishLine?: string;
  /**
   * Optional system-prompt prefix applied at every turn for this conversation.
   * Used by Operator personalisation to seed the agent with the target
   * Operator's persona context. Persists with the session and is forwarded
   * into the agent turn as `turnOptions.systemPromptPrefix`.
   */
  systemPromptPrefix?: string;
}

export type AgentSessionMetadataPatch = {
  title?: string;
  /** Canonical lifecycle field (non-null = Done). */
  doneAt?: number | null;
  starredAt?: number | null;
  deletedAt?: number | null;
  privateMode?: boolean;
  draft?: AgentSession['draft'] | null;
  resolvedAt?: number | null;
  /** User-set success criterion. `null` clears the value. */
  finishLine?: string | null;
};

export const AGENT_SESSION_METADATA_PATCH_KEYS = [
  'title',
  'doneAt', // canonical lifecycle field
  'starredAt',
  'deletedAt',
  'privateMode',
  'draft',
  'resolvedAt',
  'finishLine',
] as const satisfies ReadonlyArray<keyof AgentSessionMetadataPatch>;

// Compile-time assertion: every key on `AgentSessionMetadataPatch` must appear
// in `AGENT_SESSION_METADATA_PATCH_KEYS`. Adding a new optional field without
// also extending the runtime allowlist would silently drop the field from
// every metadata-patch path (cloud PATCH route, conflict detector, outbox
// digest). If this `true` literal stops compiling, append the missing key.
// eslint-disable-next-line @typescript-eslint/naming-convention -- private compile-time-only assertion alias
type _MetadataPatchKeysCovered =
  Exclude<keyof AgentSessionMetadataPatch, typeof AGENT_SESSION_METADATA_PATCH_KEYS[number]> extends never
    ? true
    : false;
const _ASSERT_METADATA_PATCH_KEYS_COVERED: _MetadataPatchKeysCovered = true;
void _ASSERT_METADATA_PATCH_KEYS_COVERED;
