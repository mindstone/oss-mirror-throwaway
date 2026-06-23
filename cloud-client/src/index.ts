// @rebel/cloud-client — shared cloud API client, stores, hooks, and types

// Types
export type { SessionSummary, SessionMessage, ImageContentBlock, ImageRef, AssetResolutionReason, SessionToolEvent, McpAppUiMeta, McpAppStructuredFallback, SessionUserQuestionEvent, SessionUserQuestionAnsweredEvent, FullSession, ExternalContext, SlackMentionPollContext, SlackThreadContext, SlackThreadContextMetadata, ToolApproval, MemoryWriteApproval, CloudStagedToolCall, StagedFile, WebFileAttachment, WebImageAttachment, WebDocumentAttachment, WebTextFileAttachment, WebImageMimeType, InboxItem, InboxHistoryEntry, InboxState, InboxItemStatus, InboxQuadrant, InboxReference, InboxSource, FeedbackRequest, SharedMessage, SharedSession, SharedFile, SharedResource } from './types';

// Client
export { configure, clearConfig, isConfigured, getCloudClientConfig, onUnauthorized, fireUnauthorized, getSessions, getSession, getSessionFull, uploadAsset, uploadContent, downloadContent, computeCapabilityFingerprint, peekCloudCapabilities, appendSessionEvents, patchSession, getServerCapabilities, catchUpSession, catchUpContinuity, getTombstones, updateSession, deleteSession, getSettings, listSlackRecentSenders, removeSlackRecentSender, clearSlackRecentSenders, stopTurn, submitFeedback, submitFeedbackOnce, readWorkspaceFile, ipcCall, createEventSocket, createAgentTurnSocket, checkHealth, getContinuityMap, getSelfDiagnostics, transcribe, textToSpeech, createShareLink, revokeShareLink, getShareStatus, fetchSharedSession, unlockSharedSession, fetchSharedResource, unlockSharedResource, getSharedFileDownloadUrl, CloudClientError, SessionNeedsReconcileError, SessionNeedsBootstrapError, SessionInvalidSeqError, SessionInvalidEnvelopeError, isTransientError, isNetworkError } from './cloudClient';
export type { AgentEventForPush, AppendEventsArgs, AppendEventsResult, PatchSessionArgs, CloudCapabilities, DestructiveOpsApplied } from './cloudClient';
export type { SlackRecentSender } from './types/slackRecentSender';
export type { LocalRecordingId, CloudMeetingSessionId, CompanionConversationId, LiveMeetingTurnMetadata } from './types/liveMeetingIds';
export { asLocalRecordingId, asCloudMeetingSessionId, asCompanionConversationId } from './types/liveMeetingIds';
export { mapImageRef } from './imageRefMapper';
export type { MappedImageRef, MapImageRefOptions } from './imageRefMapper';
export { startSlackOAuth, startByokSlackOAuth, getSlackWorkspace, deleteSlackWorkspace, SlackResponseValidationError, SlackAuthError, SlackTransientError, SlackNetworkError } from './slack';
export type { SlackByokOAuthStartArgs, SlackOAuthStartResponse, SlackWorkspaceResponse } from './slack';

// Stores
export { useSessionStore, setSessionContinuityRecorder } from './stores/sessionStore';
export type { ConnectionState } from './stores/sessionStore';
export { useApprovalStore } from './stores/approvalStore';
export { useInboxStore } from './stores/inboxStore';
export { useStagedFilesStore } from './stores/stagedFilesStore';
export { useSessionConflictStore } from './stores/sessionConflictStore';
export type { SessionConflictType, SessionConflictEntry } from './stores/sessionConflictStore';

// Auth
export { initAuthStore, useAuthStore } from './auth/createAuthStore';
export type { AuthState } from './auth/createAuthStore';
export type { TokenStorage } from './auth/types';
export { getOrCreateClientId, generateClientId } from './auth/createAuthStore';

// Hooks
export { useEventChannel } from './hooks/useEventChannel';
export { useAgentTurn } from './hooks/useAgentTurn';
export type { AgentTurnState, CompletedStep, StartTurnOptions, UseAgentTurnReturn } from './hooks/useAgentTurn';
export { useDraftPreservingSend } from './hooks/useDraftPreservingSend';
export type {
  DraftSnapshot,
  UseDraftPreservingSendOptions,
  UseDraftPreservingSendReturn,
  SendAttemptHandle,
} from './hooks/useDraftPreservingSend';
export { useWebVoiceRecording } from './hooks/useWebVoiceRecording';
export type { UseWebVoiceRecordingReturn } from './hooks/useWebVoiceRecording';
export { useWebFileAttachments } from './hooks/useWebFileAttachments';
export type { UseWebFileAttachmentsOptions, UseWebFileAttachmentsReturn } from './hooks/useWebFileAttachments';
export { useSmoothStream } from './hooks/useSmoothStream';
export { useTodayCards } from './hooks/useTodayCards';
export type { TodayCard, UseTodayCardsReturn } from './hooks/useTodayCards';
export { useApprovalActions } from './hooks/useApprovalActions';
export type { ApprovalActionCallbacks } from './hooks/useApprovalActions';
export { useFileViewerModel } from './hooks/useFileViewerModel';
export type {
  FileViewerState,
  UseFileViewerModelOptions,
  UseFileViewerModelReturn,
} from './hooks/useFileViewerModel';
export { useApprovalContent } from './hooks/useApprovalContent';
export type {
  ApprovalContentItem,
  ApprovalContentErrorEvent,
  ReadWorkspaceFileResult,
  StagedContentIpcResult,
  UseApprovalContentOptions,
  UseApprovalContentResult,
} from './hooks/useApprovalContent';
export { useActionPreview } from './hooks/useActionPreview';
export type {
  UseActionPreviewOptions,
  UseActionPreviewResult,
} from './hooks/useActionPreview';
export { useUnifiedApprovals } from './hooks/useUnifiedApprovals';
export type {
  UseUnifiedApprovalsOptions,
  UseUnifiedApprovalsResult,
} from './hooks/useUnifiedApprovals';
export {
  useUserQuestions,
  buildQuestionBatchStates,
  extractQuestionBatches,
  extractAnsweredBatches,
  mergeUserQuestionEvents,
  isQuestionBatchStale,
} from './hooks/useUserQuestions';
export type {
  QuestionBatchState,
  AnsweredBatchState,
  UseUserQuestionsOptions,
  UseUserQuestionsReturn,
  UserQuestionSubmitRequest,
  UserQuestionSubmitResponse,
  UserQuestionTracking,
  UserQuestionContinuationContext,
} from './hooks/useUserQuestions';
export { buildMemoryBlockedAction } from './hooks/buildMemoryBlockedAction';
export { usePrincipleOptions } from './hooks/usePrincipleOptions';
export type {
  UsePrincipleOptionsArgs,
  UsePrincipleOptionsReturn,
} from './hooks/usePrincipleOptions';

// Offline Queue
export { OfflineQueue, initOfflineQueueStore, useOfflineQueueStore, QUEUE_MAX_SIZE, DEFAULT_PROCESSING_TIMEOUT_MS, DRAIN_INITIAL_JITTER_MS, QueueFullError, useQueueStatus, classifyUploadFailureCategory } from './offlineQueue';
export type { QueueItem, QueueItemType, QueueItemStatus, QueueSnapshot, QueueStorageAdapter, QueueConsumer, QueueConsumerResult, QueueFullRejection, QueueStateSnapshot, QueueTransitionEvent, DrainOptions, DrainSummary, OfflineQueueState, OfflineQueueConfig, QueueState, QueueStatusInputs, QueueStatus } from './offlineQueue';

// Continuity observability — see `observability/continuityEvents.ts`
export { CONTINUITY_SAFE_KEYS, hashForBreadcrumb } from './observability/continuityEvents';
export type {
  ContinuityTransitionEvent,
  ContinuityEventFamily,
  SessionMergeEvent,
  SessionMergeDirection,
  OutboxEvent,
  OutboxTransition,
  CatchUpEvent,
  ContinuityStateEvent,
  ContinuityStateReason,
  ConflictEvent,
  SessionDeltaPushEvent,
  ConflictType,
  ConflictResolution,
  ContinuityErrorCategory,
} from './observability/continuityEvents';

// Persistence
export type { PersistenceAdapter } from './persistence';
export { initPersistence, flushPending, clearKeysForPrefix, buildCacheKeyPrefix } from './persistence';

// Transport adapters (approval flows) — Stage 0 of
// docs/plans/260416_centralize_approval_and_diff_viewing_ux.md
export type {
  ApprovalTransport,
  BlockedActionContext,
  PrincipleOption,
  PrincipleOptionScope,
  PrincipleOptionsResult,
  PrincipleApplyRequest,
  PrincipleApplyResult,
  PrincipleUpdate,
  PrincipleDirection,
  SafetyPromptSnapshot,
  SafetyPromptHistoryEntry,
  SafetyPromptUpdater,
  SafetyPromptUpdateRequest,
  SafetyPromptUpdatedEvent,
  AddTrustedToolRequest,
  SpaceSafetyLevel,
} from './transport/approvalTransport';
export { ApprovalTransportError } from './transport/approvalTransport';
export { safetyPromptEventEmitter } from './utils/safetyPromptEventEmitter';
export type { SafetyPromptEventMap } from './utils/safetyPromptEventEmitter';

// Components
export { EventBridge } from './components/EventBridge';

// Utils
export { formatRelativeTime } from './utils/formatRelativeTime';
export { resolveInboxCtaLabel } from '@rebel/shared';
export { deriveContextPlaceholder } from '@rebel/shared';
export { getGreeting } from '@rebel/shared';
export { getProcessingQuip } from '@rebel/shared';

export * from '@rebel/shared/utils/libraryUrls';
export * from '@rebel/shared/utils/fileCategories';
export * from '@rebel/shared/utils/markdownPreprocessors';
export * from '@rebel/shared/utils/markdownLinkHandler';
export { createLogger, setLogEnabled, setLogPersistCallback, setLogErrorReporter } from './utils/logger';
export type { PersistCallback, LogLevel, LogErrorReporter } from './utils/logger';
export {
  extractMissionFromEvents,
  extractTasksFromEvents,
  extractTurnTaskDeltaFromEvents,
  parseMissionFromDetail,
  parseTasksFromDetail,
  parseIndividualTaskIdFromDetail,
  computeTurnTaskDelta,
  computeTaskDisplayProps,
  TASK_MISSION_TOOL_NAMES,
} from './utils/missionTaskExtraction';
export type { MissionContext, TaskProgressItem, TurnTaskDelta, SnapshotCounts, TaskDisplayMode, TaskDisplayProps } from './utils/missionTaskExtraction';
export { extractSubAgentItems, formatSubAgentName } from './utils/subAgentExtraction';
export { isSubAgentToolName } from './utils/subAgentExtraction';
export type { SubAgentItem, SubAgentStatus } from './utils/subAgentExtraction';
export { buildToolLabel, extractBasename, sanitizeCommandForDisplay } from './utils/toolLabels';
export type { ToolLabel } from './utils/toolLabels';
export {
  buildActiveActivityViewModel,
  buildCompletedActivityViewModel,
  deriveActivityHeader,
  deriveAssistantDisplayItems,
  formatActivityElapsed,
} from './selectors/mobileActivityViewModel';
export type {
  MobileActivityState,
  MobileAssistantDisplayItem,
  MobileActivityStep,
  MobileActivityViewModel,
} from './selectors/mobileActivityViewModel';
export { getQuadrantLabel, getQuadrantPriority, sortInboxItems } from '@rebel/shared';
export { computeTemporalBoundaries, getTemporalGroup, groupByTemporal, TEMPORAL_GROUP_ORDER, TEMPORAL_GROUP_META } from '@rebel/shared';
export type { TemporalGroup, ConcreteTemporalGroup, TemporalBoundaries } from '@rebel/shared';
export { classifyInboxTier, looksLikeFyi, shouldRedirectToCoach, compareInboxPriority, stripLeadingEmoji } from '@rebel/shared';
export type { InboxTier } from '@rebel/shared';
export { COUNCIL_REVIEW_PROMPT, isCouncilReviewAvailable } from '@rebel/shared';
export { humanizeToolActivity } from '@rebel/shared';
export { selectVisibleMessages } from '@rebel/shared';
export { getRouterPhase } from '@rebel/shared';
export type { RouterPhase } from '@rebel/shared';
export { meetingEventEmitter } from './utils/meetingEventEmitter';
export type {
  CoachingCardEvent,
  CompanionTurnStartedEvent,
  MeetingEventMap,
  TriggerDroppedEvent,
  TriggerDroppedReason,
  TriggerHeardEvent,
  TriggerRateLimitExceededEvent,
  TriggerSourceSpeaker,
} from './utils/meetingEventEmitter';
