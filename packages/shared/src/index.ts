// --- Canonical cross-platform inbox types ---
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
  InboxPriority,
  InboxQuadrant,
  InboxItem,
  InboxConfidence,
  InboxExecutionMode,
  InboxHistoryEntry,
  InboxState,
} from './types/inbox';
export type {
  CloudSessionUsageStats,
  CloudExternalContext,
  CloudSlackContextMetadata,
  CloudSessionSummary,
  CloudSessionMessage,
  CloudSessionToolEvent,
  McpAppUiMeta,
  McpAppStructuredFallback,
  CloudSessionCore,
  ToolApprovalRequest,
  PendingMemoryApproval,
  StagedToolCall,
  ImageContentBlock,
  ImageRef,
  AssetResolutionReason,
  ImageAttachmentMimeType,
  ImageAttachmentPayload,
  DocumentAttachmentPayload,
  TextFileAttachmentPayload,
} from './types/cloudClientDtos';
export * from './types/inboundAuthorPolicy';
export * from './types/externalContext';
export {
  FileLocationSchema,
  OutsideCategorySchema,
  SharedSkillTargetSchema,
  describeFileLocation,
  fileLocationFromSkillTarget,
  legacyMissingLocation,
} from './fileLocation';
export {
  SlackOAuthStartResponseSchema,
  SlackWorkspaceNullableResponseSchema,
  SlackWorkspaceResponseSchema,
} from './slack';
export {
  BlockSourceSchema,
  SAFETY_PROMPT_BLOCKED_PREFIX,
  ToolBlockSourceSchema,
  backfillToolBlockSource,
} from './safety/blockSource';
export {
  MemoryFileStagedBroadcastSchema,
  MemoryStagedFilesChangedBroadcastSchema,
  MemoryWriteApprovalRequestBroadcastSchema,
  MemoryWriteApprovalResolvedBroadcastSchema,
  ToolSafetyApprovalRequestBroadcastSchema,
  ToolSafetyApprovalResolvedBroadcastSchema,
  ToolSafetyStagedCallBroadcastSchema,
  ToolSafetyStagedCallUpdatedBroadcastSchema,
} from './safety/approvalBroadcasts';
export type {
  FileLocation,
  OutsideCategory,
  FileLocationDescription,
  SharedSkillTarget,
} from './fileLocation';
export type {
  BlockSource,
  ToolBlockSource,
} from './safety/blockSource';
export type {
  MemoryFileStagedBroadcast,
  MemoryStagedFilesChangedBroadcast,
  MemoryWriteApprovalRequestBroadcast,
  MemoryWriteApprovalResolvedBroadcast,
  ToolSafetyApprovalRequestBroadcast,
  ToolSafetyApprovalResolvedBroadcast,
  ToolSafetyStagedCallBroadcast,
  ToolSafetyStagedCallUpdatedBroadcast,
} from './safety/approvalBroadcasts';

// --- Attachment limits ---
export {
  MAX_EXTRACTED_TEXT_BYTES,
  MAX_FILE_ATTACHMENTS,
  MAX_IMAGE_SIZE_BYTES,
  MAX_PDF_SIZE_BYTES,
  MAX_TEXT_FILE_SIZE_BYTES,
  MAX_TOTAL_PAYLOAD_BYTES,
  MAX_HEIC_SIZE_BYTES,
  OPTIMAL_MAX_DIMENSION,
  IMAGE_HARD_DIMENSION_LIMIT,
  ANTHROPIC_IMAGE_BYTE_LIMIT,
  nextDimensionForByteTarget,
  VALID_IMAGE_MIME_TYPES,
  TEXT_BASED_MIME_TYPES,
  TEXT_FILE_EXTENSIONS,
} from './utils/attachmentLimits';

// --- Utilities ---
export { classifyEventForSession } from './utils/eventSessionClassification';
export type { EventSessionClassification } from './utils/eventSessionClassification';
export { fnvHashBase36, fnvHashHex } from './utils/fnvHash';
export { formatRelativeTime } from './utils/formatRelativeTime';
export type { FormatRelativeTimeOptions } from './utils/formatRelativeTime';
export { TRANSCRIPT_SOURCE_SLUGS, isTranscriptSource } from './utils/isTranscriptSource';
export type { TranscriptSource } from './utils/isTranscriptSource';
export { resolveInboxCtaLabel } from './utils/resolveInboxCtaLabel';
export type { ResolveInboxCtaLabelItem } from './utils/resolveInboxCtaLabel';
export { getGreeting } from './utils/getGreeting';
export { getProcessingQuip } from './utils/quips';
export * from './utils/friendlyErrors';
export * from './utils/agentErrorCatalog';
export { categoryForKind, classifyErrorUx } from './utils/classifyErrorUx';
export type {
  AgentErrorCategory,
  AgentErrorResolution,
  AgentErrorResolutionAction,
  ClassifyErrorUxInput,
} from './utils/classifyErrorUx';
export { isStructuredOutputSchemaRejection } from './utils/structuredOutputErrorClassification';
export {
  humanizeAgentError,
  formatHumanizedResetDate,
  humanizeStructuredOutputSchemaRejection,
  HUMANIZER_OWNED_KINDS,
  CALLER_OVERRIDE_KINDS,
  HUMANIZER_SAFE_FALLBACK,
  setHumanizerFailureObserver,
} from './utils/humanizeAgentError';
export type {
  HumanizerInput,
  BillingMeta as HumanizerBillingMeta,
  RateLimitMeta as HumanizerRateLimitMeta,
  HumanizerFailureReport,
  HumanizerFailureObserver,
} from './utils/humanizeAgentError';
export { extractMeetingId } from './utils/extractMeetingId';
export { getQuadrantLabel, getQuadrantPriority, sortInboxItems } from './utils/inboxHelpers';
export { computeTemporalBoundaries, getTemporalGroup, getScheduleDueBy, groupByTemporal, TEMPORAL_GROUP_ORDER, TEMPORAL_GROUP_META } from './utils/temporalGroup';
export type { TemporalGroup, ConcreteTemporalGroup, TemporalBoundaries } from './utils/temporalGroup';
export { isItemRelevantToMeeting, findCalendarMatchesForItem, computeCalendarMatchedIds } from './utils/calendarInboxMatcher';
export type { CalendarEventForMatching, InboxItemForMatching } from './utils/calendarInboxMatcher';
export { classifyInboxTier, looksLikeFyi, shouldRedirectToCoach, compareInboxPriority, stripLeadingEmoji } from './utils/inboxTiers';
export type { InboxTier } from './utils/inboxTiers';
export { deriveConfidence } from './utils/deriveConfidence';
export { deriveInboxStatus } from './utils/deriveInboxStatus';
export { deriveContextPlaceholder, extractShortTopic } from './utils/deriveContextPlaceholder';
export type { DeriveContextPlaceholderItem } from './utils/deriveContextPlaceholder';
export { getStatusLabel, derivePriorityLevel, getPriorityLabel, cyclePriority, priorityToQuadrant, isPriorityPinnedToToday, PRIORITY_SORT_RANK } from './utils/inboxStatusLabels';
export type { PriorityLevel } from './utils/inboxStatusLabels';
export { formatProvenanceLabel } from './utils/formatProvenance';
export { COUNCIL_REVIEW_PROMPT, isCouncilReviewAvailable } from './utils/councilReview';
export { humanizeToolActivity } from './utils/humanizeToolActivity';
export { selectVisibleMessages, type VisibleMessageCandidate } from './utils/selectVisibleMessages';
export { getRouterPhase } from './utils/getRouterPhase';
export type { RouterPhase } from './utils/getRouterPhase';

// --- Tool label primitives ---
export {
  sanitizeCommandForDisplay,
  extractBasename,
  toTitleCase,
  normalizeToolName,
  truncateForDisplay,
  FRIENDLY_TOOL_LABELS,
  PATH_KEYS,
  COMMAND_KEYS,
  TOOL_NAME_KEYS,
  SERVER_NAME_KEYS,
  MAX_SHORT_DETAIL_LENGTH,
} from './utils/toolLabels';
export type { ToolLabel } from './utils/toolLabels';

// --- Bookkeeping tool names (planning/no-side-effect tools) ---
export { BOOKKEEPING_TOOL_NAMES, isBookkeepingTool } from './utils/bookkeepingToolNames';

// --- Mission/task extraction ---
export { parseMissionFromDetail, parseTasksFromDetail, parseTodosFromDetail, TASK_SNAPSHOT_TOOL_NAMES } from './utils/missionTaskExtraction';
export { parseIndividualTaskIdFromDetail, computeTurnTaskDelta, computeTaskDisplayProps } from './utils/missionTaskExtraction';
export type { MissionContext, TaskProgressItem, PendingTodo, ToolEventLike } from './utils/missionTaskExtraction';
export type { TurnTaskDelta, SnapshotCounts, TaskDisplayMode, TaskDisplayProps } from './utils/missionTaskExtraction';

// --- Continuation message builders ---
export { buildContinuationMessage, buildDiscardMessage } from './utils/buildContinuationMessage';
export type { ApprovalInfo, DiscardInfo } from './utils/buildContinuationMessage';

// --- File attachment utilities ---
export {
  estimateBase64Bytes,
  getBase64EncodedByteLength,
  estimateAttachmentPayloadBytes,
  validateFileSize,
  isValidImageMimeType,
  isHeicFileType,
  isTextBasedMimeType,
  isTextFileByExtension,
  isTextBasedFile,
  categorizeFile,
} from './utils/fileAttachmentUtils';
export type { AttachmentPayloadInfo, FileCategory } from './utils/fileAttachmentUtils';


export * from './utils/libraryUrls';
export * from './utils/fileCategories';
export * from './utils/markdownPreprocessors';
export {
  preprocessMarkdownForRender,
  DEFAULT_REMARK_PLUGINS,
} from './utils/markdownPipeline';
export type {
  PreprocessMarkdownOptions,
  PreprocessMarkdownResult,
} from './utils/markdownPipeline';
// `urlSchemePolicy` (renamed from `imageUrlGuard`): the module started as an
// image-URL guard but also houses the anchor scheme preservation knob
// (`preserveSchemes` in `createGuardedUrlTransform`), so the broader name is
// more accurate. Symbol names were also renamed on 2026-04-23 (I2 / R1 fix
// hardening bundle) after the anchor guard landed in `8f63997ae`.
// See docs/plans/260423_r1_hardening_i2_i3_i6.md Stage 1.
export {
  BLOCKED_URL_SCHEMES,
  findBlockedUrlScheme,
  redactUrlForLogging,
  createGuardedUrlTransform,
} from './utils/urlSchemePolicy';
export type { BlockedUrlScheme } from './utils/urlSchemePolicy';
export * from './utils/markdownLinkHandler';

// --- Credential labels (approval UI) ---
export { getCredentialLabel } from './credentialLabels';

// --- Browser App Bridge tool safety (Stage 6b) ---
export {
  BROWSER_FILL_FORM_TOOL,
  BROWSER_CLICK_TOOL,
  isSensitiveBrowserField,
  sanitizeFillFormFields,
  sanitizeFillFormToolInputForLlm,
  isDestructiveClickLabel,
  annotateClickToolInputForLlm,
  labelsMatch,
  preprocessBrowserToolInputForLlm,
  valueLooksSensitive,
} from './browserToolSafety';
export type {
  BrowserFillField,
  SanitizedFillField,
} from './browserToolSafety';

// --- Approval utilities (tool humanization, reason classification, service extraction) ---
export {
  TOOL_DISPLAY_CONFIG,
  JARGON_TOOL_NAMES,
  SERVICE_PATTERNS,
  getToolDisplayConfig,
  getFriendlyToolName,
  getToolHeader,
  getToolFallbackSubtitle,
  isJargonToolName,
  isGenericReason,
  extractServiceFromReason,
} from './approvalUtils';
export type { ToolDisplayConfig } from './approvalUtils';

// --- Approval content helpers (conflict detection, change type, binary heuristic) ---
export {
  detectConflict,
  detectChangeType,
  isLikelyBinary,
  classifyReadError,
} from './approvalContent';
export type {
  ApprovalChangeType,
  ApprovalContentError,
  ApprovalContentErrorKind,
} from './approvalContent';

// --- Action preview model + projector layer (Stage 1) ---
export { classifyEffectKind } from './actionPreview/classify';
export { EFFECT_PROJECTOR_REGISTRY } from './actionPreview/registry';
export { deriveActionPreview } from './actionPreview/projectors';
export { FILE_BACKED_ACTION_EFFECT_KINDS, isFileBackedEffectKind } from './actionPreview/fileBacked';
export { projectBlastRadius } from './actionPreview/projectors/blastRadius';
export { projectDataCapture } from './actionPreview/projectors/dataCapture';
export { projectGenericStructured, redactArgsForPreview } from './actionPreview/projectors/generic';
export { projectMessage, detectMessageKind, normalizeSlackUserId } from './actionPreview/projectors/message';
export { hasSourceCaptureEvidence, hasNetNewEvidence, isSourceCaptureFileName } from './actionPreview/sourceCapture';
export type {
  ActionPreviewModel,
  ActionPreviewInput,
  ActionEffectKind,
  BlastRadius,
  BlastRadiusChip,
  Reversibility,
  RiskReason,
  GenericStructuredRow,
  ContentVisibility,
} from './actionPreview/model';

// --- Canonical side-effect verb heuristics ---
export {
  SIDE_EFFECT_VERBS,
  sideEffectPatterns,
  isSideEffectVerb,
} from './toolVerbs';

// --- Canonical session-lifecycle predicates (pinnedAt → doneAt rename) ---
export { isSessionDone, isSessionActive } from './sessionLifecycle';
export type { SessionLifecycleFields } from './sessionLifecycle';

// --- Diff primitives (Stage 5 — shared line-level diff engine) ---
export { computeDiff, computeDiffAsync, DiffAbortError } from './diff';
export type {
  Hunk,
  DiffStats,
  DiffResult,
  ComputeDiffOptions,
  SchedulerFn,
} from './diff';

// --- Untrusted-content fencing primitives (Stage A closeout — shared helpers) ---
export {
  FenceCollisionError,
  DEFAULT_METADATA_MAX_LENGTH,
  generateFenceNonce,
  sanitizeMetadata,
  truncateUtf8Safe,
} from './untrustedFencing';

// --- Annotation primitives (shared between conversation + document annotation systems) ---
export {
  AnnotationFormatExhaustionError,
  DEFAULT_ANNOTATION_COMMENT_LENGTH,
  DEFAULT_ANNOTATION_FORMAT_MAX_ATTEMPTS,
  DEFAULT_ANNOTATION_MAX_COUNT,
  DEFAULT_ANNOTATION_TEXT_BYTE_LENGTH,
  buildAnnotationMessageSafe,
  buildAnnotationDisplayMessageSafe,
  formatAnnotationMessage,
  formatAnnotationDisplayMessage,
  generateAnnotationId,
} from './annotationUtils';
export type { BaseAnnotation, FormatAnnotationDisplayOptions, FormatAnnotationOptions } from './annotationUtils';

// --- Conversational conflict-resolution seed prompt (Stage 6) ---
export {
  buildConversationalResolutionPrompt,
} from './conversationalResolutionPrompt';
export type {
  BuildConversationalResolutionPromptArgs,
  BuildConversationalResolutionPromptOptions,
  StagedFileForResolution,
} from './conversationalResolutionPrompt';

// --- Conversational instruction-driven publish message (Stage A closeout) ---
export {
  buildConversationalPublishMessage,
} from './conversationalPublishMessage';
export type {
  ConversationalPublishContext,
} from './conversationalPublishMessage';

// --- Unified approval mapper (Stage 3 — shared list derivation) ---
export { deriveUnifiedApprovals } from './unifiedApprovalMapper';
export type {
  UnifiedApproval,
  UnifiedApprovalKind,
  UnifiedApprovalRiskLevel,
  UnifiedStagedFileInput,
  MemoryApprovalInput,
  MemoryApprovalKind,
  MemoryBlockedBySource,
  MemorySharing,
  SessionContextForApprovals,
  StagedFileInput,
  StagedToolCallInput,
  ToolApprovalInput,
  ToolApprovalSummary,
  DeriveUnifiedApprovalsInputs,
  DeriveUnifiedApprovalsOptions,
} from './unifiedApprovalMapper';

// --- Hooks ---
export { useSmoothStream } from './hooks/useSmoothStream';
