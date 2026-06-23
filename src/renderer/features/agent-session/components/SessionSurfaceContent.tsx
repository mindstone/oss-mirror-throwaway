/**
 * SessionSurfaceContent
 *
 * Memoized component that renders the full session surface: conversation pane,
 * footer (pending reviews, coaching card, annotation orchestrator, recorder strip),
 * and navigation controls.
 *
 * Extracted from App.tsx to create a React.memo render boundary. Uses a ref-based
 * actions pattern for callbacks — a single stable `actionsRef` holds all ~60 callbacks,
 * so React.memo can effectively bail out when only callbacks (not data) have changed.
 *
 * The actionsRef is updated by App.tsx on every render, but because refs are mutable
 * and don't participate in shallow comparison, the memo boundary only re-renders
 * when the data props actually change.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject, MouseEvent as ReactMouseEvent } from 'react';
import { AlertTriangle, PartyPopper, Sparkles, Trash2, X } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { Button } from '@renderer/components/ui';
import { DevProfiler } from '@renderer/components/DevProfiler';
import { ConversationPane, type ConversationPaneHandle } from './ConversationPane';
import {
  MCPBuildCard,
  buildMcpBuildQuestionBatch,
  type MCPBuildCardActionHandlers,
  type MCPBuildCardState,
} from './MCPBuildCard';
import { routeMcpBuildAnswer } from './mcpBuildQuestionRouting';
import {
  computePendingMcpBuildQuestionBatch,
  computeVisibleMcpBuildQuestionBatch,
} from './mcpBuildQuestionVisibility';
import {
  buildConnectorSetupQuestionBatch,
  type ConnectorSetupCardInfo,
} from '../hooks/useConnectorSetupSuggestions';
import { useAuthRequiredSignals } from '../hooks/useAuthRequiredSignals';
import { buildConnectorSetupKey } from '@shared/utils/connectorSetupSignal';
import { formatConnectorDisplayName } from '@shared/utils/formatConnectorDisplayName';
import { ConversationModelSelector } from './ConversationModelSelector';
import { ConversationProfileLearnedNote } from './ConversationProfileLearnedNote';
import { ConversationActionsMenu, type ConversationContextMenuAnchor } from './ConversationActionsMenu';
import { ConversationCategoryIndicator } from './ConversationCategoryIndicator';
import { ConversationNav } from './ConversationNav';
import { MoveToFolderPopover } from './MoveToFolderPopover';
import { useFolders, useFolderActions, useFolderStore, getFolderStoreState } from '../store/folderStore';
import { DiagnosticsPanel } from '../diagnostics';
import { useMeetingTriggerHeard } from '../hooks/useMeetingTriggerHeard';
import { useOnlineStatus } from '@renderer/hooks/useOnlineStatus';
import { meetingEventEmitter } from '@rebel/cloud-client';

import { ApprovalPointerBar } from './ApprovalPointerBar';
import type { StagedToolCall } from '../types';
import { SessionCoachingCard } from './SessionCoachingCard';
import { AnnotationOrchestrator } from './AnnotationOrchestrator';
import { MeetingCompanionBanner, type CoachSelection, type PresenceMode } from '@renderer/components/MeetingCompanionBanner';
import { PinnedFavoritesTabs } from './PinnedFavoritesTabs';
import { InteractionStrip } from '@renderer/features/composer/InteractionStrip';
import { QueuedMessagesTray } from '@renderer/features/composer/QueuedMessagesTray';
import {
  BrowserContextChip,
  ExternalContextIndicator,
  OfficeContextChip,
  SlackContextChip,
} from '@renderer/features/app-bridge';
import { useExternalContextForSession } from '@renderer/hooks/useExternalContextQueue';
import type { ExternalContextEntry } from '@renderer/hooks/useExternalContextQueue';
import type { ExternalContext, PolicyMode } from '@rebel/shared';
import { useUserQuestions } from '../hooks/useUserQuestions';
import { UserQuestionCard } from './UserQuestionCard';
import { MCPAuthRequiredCard } from './MCPAuthRequiredCard';
import { MinimizedQuestionPill } from './MinimizedQuestionPill';
import { ContextFilteredIndicator } from './ContextFilteredIndicator';
import uqStyles from './UserQuestionCard.module.css';
import type { ComposerHandle, ComposerWithStateProps } from '@renderer/features/composer/ComposerWithState';
import type { SelectionContext } from './TextSelectionMenu';
import type { ToastMessage } from '@renderer/contexts';
import type { TurnStepContext } from '../utils/turnStepContext';
import type { SubAgentTimeline } from '../utils/subAgentTimeline';
import type { InsightTurnSummary } from '../work-surface/types';
import { useConversationFiles } from '../hooks/useConversationFiles';
import { useMemoryUpdateStatus } from '../hooks/useMemoryUpdateStatus';
import { useSessionConflictStore } from '../store/sessionConflictStore';
import type { ToolApprovalRequest, AgentSessionSidebarEntry } from '../types';
import type { MemoryWriteApprovalRequest } from '../hooks/useMemoryApproval';
import type { StagedFileItem } from '@renderer/features/inbox/hooks/useStagedFiles';
import type {
  AgentTurnMessage,
  AgentEvent,
  PersonalizedUseCase,
  RendererLogPayload,
  CompactionBoundary,
  SessionCoachingEvaluation,
  CommunitySharePreview,
  UserQuestionAnswer,
  AnyAttachmentPayload,
} from '@shared/types';
import type { ChangelogHighlight } from '@renderer/features/whats-new/utils/changelogParser';
import { useCommunityShare } from '../hooks/useCommunityShare';
import { getSessionStoreState } from '../store';
import { getFolderSessionIdsToSetActiveState } from '../utils/folderSessionState';
import { useMeetingStatus } from '@renderer/hooks/useMeetingStatus';
import { useFlowPanels, type FlowSurface } from '@renderer/features/flow-panels/FlowPanelsProvider';
import { COUNCIL_REVIEW_PROMPT, isSessionActive } from '@rebel/shared';
import { isBackgroundConversationSession } from '@shared/sessionKind';

import { type ChromeMode, chromeInert } from '@renderer/features/flow-panels/chromeMode';
import paneStyles from '@renderer/components/AgentSessionPane.module.css';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Meeting companion metadata for the current session */
interface MeetingCompanionMeta {
  meetingTitle: string;
  meetingUrl: string;
  coach?: {
    skillPath: string;
    skillName: string;
    showAllChecks?: boolean;
  } | null;
}

/** Queued message for QueuedMessagesTray */
interface QueuedMessageEntry {
  id: string;
  text: string;
  source: 'text' | 'voice';
  targetSessionId?: string;
}

function formatConflictAgeShort(detectedAt: number): string {
  const deltaMs = Math.max(0, Date.now() - detectedAt);
  const minutes = Math.max(1, Math.floor(deltaMs / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatConflictFieldLabel(field: string): string {
  if (field === 'doneAt') return 'done';
  if (field === 'starredAt') return 'starred';
  if (field === 'privateMode') return 'private mode';
  if (field === 'meetingCompanion') return 'meeting companion';
  return field.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function describeConflictFields(fields: string[]): string {
  if (fields.length === 0) return 'Session metadata changed elsewhere.';
  return `Changed elsewhere: ${fields.map(formatConflictFieldLabel).join(', ')}`;
}

function formatExternalTabHostname(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function formatOfficeSourceLabel(host: string | undefined, title: string | undefined): string | undefined {
  if (title) return title;
  switch (host) {
    case 'word':
      return 'Word';
    case 'excel':
      return 'Excel';
    case 'powerpoint':
      return 'PowerPoint';
    default:
      return host ? 'Office' : undefined;
  }
}

export function resolveExternalContextSourceLabel(
  externalContext: Pick<ExternalContextEntry, 'appId' | 'tabContext' | 'documentContext' | 'externalContext'> | undefined,
): string | undefined {
  if (!externalContext) return undefined;
  if (externalContext.appId === 'office-addin') {
    return formatOfficeSourceLabel(
      externalContext.documentContext?.host,
      externalContext.documentContext?.title,
    );
  }
  if (externalContext.appId === 'slack') {
    const ctx = externalContext.externalContext as ExternalContext | undefined;
    if (ctx && 'metadata' in ctx && (ctx.kind === 'slack-thread' || ctx.kind === 'slack-mention-poll')) {
      if (ctx.metadata.channelName) return `#${ctx.metadata.channelName}`;
      if (ctx.metadata.userName) return ctx.metadata.userName;
      if (ctx.metadata.userDisplayName) return ctx.metadata.userDisplayName;
    }
    return 'Slack';
  }
  if (externalContext.appId === 'browser-extension') {
    return formatExternalTabHostname(externalContext.tabContext?.url);
  }
  return (
    formatExternalTabHostname(externalContext.tabContext?.url) ??
    formatOfficeSourceLabel(
      externalContext.documentContext?.host,
      externalContext.documentContext?.title,
    )
  );
}

export function isSessionWideModeShortcut(
  event: Pick<globalThis.KeyboardEvent, 'key' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'repeat'>,
): boolean {
  return event.key.toLowerCase() === 'f' && event.shiftKey && (event.metaKey || event.ctrlKey) && !event.repeat;
}

export function handleSessionWideModeShortcut(
  event: Pick<globalThis.KeyboardEvent, 'key' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'repeat' | 'preventDefault'>,
  activeSurface: FlowSurface,
  toggleWideMode: () => void,
): boolean {
  if (activeSurface !== 'sessions') {
    return false;
  }
  if (!isSessionWideModeShortcut(event)) {
    return false;
  }
  event.preventDefault();
  toggleWideMode();
  return true;
}

/**
 * All callback actions, grouped in a single ref object.
 * App.tsx updates actionsRef.current every render; consumers dereference at call time.
 */
export interface SessionSurfaceActions {
  // Navigation / session management
  handleNewChat: (source?: 'header_button' | 'sidebar_button' | 'brand_button' | 'collapsed_tabs' | 'keyboard_shortcut') => void;
  handleOpenHistorySession: (sessionId: string, source?: 'sidebar' | 'collapsed_tabs' | 'keyboard_shortcut' | 'homepage' | 'inbox' | 'rebel_link' | 'notification' | 'library' | 'meeting' | 'mcp' | 'task' | 'time_saved' | 'achievement' | 'atlas' | 'restore' | 'onboarding') => void;
  handleTogglePinSession: (
    sessionId: string,
    event?: ReactMouseEvent,
    options?: { skipAutoSwitch?: boolean },
  ) => void;
  setSelectedTrashedSessionId: (id: string | null) => void;
  restoreSession: (sessionId: string) => void;
  /**
   * @internal Raw engine opener — does NOT apply the scroll-settling contract.
   * Prefer `navigateToConversation` for user-facing navigation. Retained here for
   * non-UI / programmatic opens; do not add new call sites without justification.
   * See docs-private/investigations/260416_thread_scroll_jumps_to_top_on_switch.md.
   */
  openHistorySession: (sessionId: string) => Promise<boolean>;
  /**
   * Canonical user-facing conversation navigation helper. Applies the scroll-settling
   * contract (markPendingHistoryScroll + pane-hide + scroll-to-latest) before opening,
   * so the user lands at the latest turn. Use this for any user-initiated navigation.
   */
  navigateToConversation: (sessionId: string, source?: 'sidebar' | 'collapsed_tabs' | 'keyboard_shortcut' | 'homepage' | 'inbox' | 'rebel_link' | 'notification' | 'library' | 'meeting' | 'mcp' | 'task' | 'time_saved' | 'achievement' | 'atlas' | 'restore' | 'onboarding') => Promise<boolean>;

  // Message editing
  handleBeginEditMessage: (messageId: string) => void;
  handleRetryMessage: (messageId: string) => void;

  // Turn / step interaction
  handleSelectInlineStep: (turnId: string, stepNumber: number | null) => void;
  focusTurn: (turnId: string) => void;
  resolveTurnIdForMessage: (message: AgentTurnMessage) => string | null;

  // File / navigation actions
  handleOpenDocumentInPreview: (filePath: string) => void;
  handleOpenWorkspaceFolder: (folderPath: string) => void;
  handleOpenConversationReference: (sessionId: string) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- forwarded callbacks with varying signatures
  handleNavigateFromChat: (...args: any[]) => void;
  handleOpenTutorial: (tutorialPath: string) => void;
  handleCopyToClipboard: (text: string) => void;
  handleOpenInLibrary: (filePath: string, isFolder: boolean) => void;
  handleSelectUseCase: (prompt: string) => void;

  // Session actions menu
  startRename: (sessionId: string, currentTitle: string) => void;
  handleSoftDeleteSession: (sessionId: string, event?: ReactMouseEvent) => void;
  handleFindSimilar: (sessionId: string) => void;
  handleToggleStarSession: (sessionId: string, event?: ReactMouseEvent) => void;
  handleCopyMarkdown: (sessionId: string) => void;
  handleExportMarkdown: (sessionId: string) => void;
  handleCopyConversationLink: (sessionId: string) => void;
  handleShareConversation?: (sessionId: string) => void;
  handleRevealInSidebar: (sessionId: string) => void;
  handleStartDiagnose: (sessionId: string) => void;
  handleExportLogs: (sessionId: string) => void;

  // Toast
  showToast: (message: ToastMessage) => void;

  // Annotation callbacks
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- forwarded to AnnotationOrchestrator
  submitQueuedMessage: (...args: any[]) => Promise<void>;
  handleSelectionMenuReply: (context: SelectionContext) => void;
  handleSelectionMenuReplyInNewChat: (context: SelectionContext) => void;
  handleGenericAddComment: (text: string, documentPath?: string, hintOffset?: number) => void;
  handleSelectionMenuOpenChange: (isOpen: boolean) => void;
  setIsAnnotationActive: (isActive: boolean) => void;
  clearComposerAfterSend: () => void;

  // Mention resolution (for annotation send path)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- attachment payload union varies
  prepareMentionAttachments: (promptText: string) => Promise<any[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- attachment payload union varies
  prepareConversationAttachments: (text: string) => Promise<any[]>;

  // Voice / recording
  handleToggleTranscription: () => void;
  handleStopAndSend: () => void;
  handleToggleAutoSpeak: () => void;
  setPrivateMode: (mode: boolean) => void;
  setCouncilMode: (mode: boolean) => void;
  requestCouncilReview: () => void;
  handleToggleAutoDone: (source?: 'menu' | 'click' | 'keyboard' | 'long_press') => void;
  handleMarkDoneNow: () => void;
  stopActiveTurn: () => void;
  handleShowSettingsSurface: () => void;
  handleNavigateToVoiceSettings: () => void;
  emitLog: (payload: RendererLogPayload) => void;

  // Pending review
  approveAndRetry: (toolUseId: string) => void;
  dismiss: (toolUseId: string) => void;
  approveAllAndRetry: () => void;
  dismissAll: () => void;
  handleTrustToolAlways: (toolId: string, displayName: string) => void;
  executeStagedTool: (id: string) => Promise<void>;
  rejectStagedTool: (id: string) => void;
  executeAllStagedTools: () => Promise<void>;
  rejectAllStagedTools: () => void;
  publishStagedFile: (id: string) => Promise<{ success: boolean; hasConflict?: boolean; error?: string; conflict?: { realContent: string; stagedContent: string } }>;
  discardStagedFile: (id: string) => Promise<{ success: boolean; error?: string }>;
  keepStagedFilePrivate: (id: string) => Promise<{ success: boolean; error?: string; destinationPath?: string }>;
  saveMemory: (toolUseId: string) => void;
  skipMemory: (toolUseId: string) => void;
  saveAllMemory: () => void;
  skipAllMemory: () => void;

  // Notifications
  openNotificationsForSession: (sessionId: string) => void;

  /**
   * Send a message to a specific session.
   *
   * - `receiptText` — hide the raw user message AND inject a compact receipt chip (approval / memory / staged-tool continuations).
   * - `options.isHidden` — hide only; no receipt chip (AskUserQuestion continuations and other system-continuation paths).
   * - Neither — the message is user-visible (e.g. `onContinueIncomplete`'s "Continue working on the remaining steps.").
   *
   * When either hide signal is active, the message is also stamped with
   * `messageOrigin: 'system-continuation'` so downstream consumers have
   * an authoritative non-textual signal.
   */
  sendMessageToSession: (
    sessionId: string,
    message: string,
    receiptText?: string,
    options?: { isHidden?: boolean; attachments?: AnyAttachmentPayload[] },
  ) => Promise<void>;

  // Queued messages
  removeFromQueue: (id: string) => void;
  clearQueueForSession: (sessionId: string) => void;
  sendQueuedMessageNow: (id: string) => void;

  // Session coaching
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- forwarded with varying signatures
  handleUserMessage: (...args: any[]) => void;
  updateCoachingState: (sessionId: string, state: SessionCoachingEvaluation['state'], reason?: SessionCoachingEvaluation['dismissalReason']) => Promise<void>;
  setCoachingSessionIds: (updater: (prev: Set<string>) => Set<string>) => void;

  // Community share
  composeSharePost: (sessionId: string) => Promise<CommunitySharePreview | null>;
  openDiscourseShare: (sessionId: string) => Promise<void>;
  dismissShare: (sessionId: string) => Promise<void>;
  optOutSharing: () => Promise<void>;

  // Discovery slot
  /**
   * Start a fresh "What's New" session introducing the given changelog highlight.
   * Used by the empty-state discovery whisper and the during-turn nudge when
   * the selected item is a changelog variant.
   */
  handleTryWhatsNewFeature: (highlight: ChangelogHighlight) => void;
}

// ─── Props ──────────────────────────────────────────────────────────────────

export interface SessionSurfaceContentProps {
  /** Single stable ref holding all callback actions — updated by App.tsx each render */
  actionsRef: RefObject<SessionSurfaceActions>;

  // ── Session identity & state ────────────────────────────────────────────
  currentSessionId: string;
  currentSessionTitle: string | null;
  currentSessionStarredAt: number | null;
  currentSessionDoneAt: number | null;

  // ── Message / turn data ─────────────────────────────────────────────────
  visibleMessages: AgentTurnMessage[];
  eventsByTurn: Record<string, AgentEvent[]>;
  messages: AgentTurnMessage[];
  turnSummaries: InsightTurnSummary[];
  visibleTurnId: string;
  focusedTurnId: string | null;
  /** Turn the agent runtime is actively processing (from runtime state, not user focus). (FOX-2505) */
  processingTurnId: string | null;
  editingMessageId: string | null;
  turnStepContextByTurn: Record<string, TurnStepContext>;
  subAgentTimelineByTurn: Map<string, SubAgentTimeline>;
  activeStepByTurn: Record<string, number | null>;
  compactionBoundaries: CompactionBoundary[] | undefined;

  // ── Agent state ─────────────────────────────────────────────────────────
  isBusy: boolean;
  isStopping: boolean;
  isSettling: boolean;
  isRevealMasked: boolean;
  isTextMode: boolean;
  isInsightSurface: boolean;
  isDiagnosticsSurface: boolean;
  onToggleDiagnostics: () => void;

  // ── Thinking state ──────────────────────────────────────────────────────
  thinkingHeadline: string;
  thinkingElapsedLabel: string;

  // ── Scroll state ────────────────────────────────────────────────────────
  isScrolledAway: boolean;
  newMessageCount: number;
  isAnswerTopPinned: boolean;
  /** Jump to latest callback — clears sticky scroll-away latch (FOX-2668) */
  onJumpToLatest?: (options?: { behavior?: 'auto' | 'smooth' }) => void;

  // ── UI state ────────────────────────────────────────────────────────────
  selectedTrashedSessionId: string | null;
  flowHistoryOpen: boolean;
  mcpBuildCardState?: MCPBuildCardState | null;
  onMcpBuildCardActions?: MCPBuildCardActionHandlers;
  /**
   * Clears the preserved `github-check` transient owned by
   * `useMcpBuildSubmission`. Called when the user dismisses the MCP
   * build question batch while the picker is showing (`phase ===
   * 'github-check'`) so the memo falls back to the store-derived
   * submit-prompt and the retry affordance returns. Stage 1.3 X1a of
   * `docs/plans/260420_oss_mcp_backend_relay.md`.
   */
  onMcpBuildClearGithubCheck?: () => void;
  /**
   * Stage 5a of `docs/plans/260420_oss_mcp_backend_relay.md`: resolved
   * feature-flag value that gates the relay submit path (Rebel-name +
   * Anonymous attribution) in the MCP build share picker. When `false`
   * the picker collapses back to the 2-option GitHub / Skip card. When
   * `true` (default) the 3-way attribution picker is shown. See
   * `resolveContributionRelayEnabled` for the channel-aware default.
   */
  enableContributionRelay?: boolean;
  /** True for OSS builds, where contribution sharing is unavailable. */
  isOssBuild?: boolean;
  /** Latest unsaved connector setup suggestion for footer rendering. */
  connectorSetupFooterCard?: ConnectorSetupCardInfo | null;
  /** Callback when user clicks "Set it up" on a setup offer card. */
  onConnectorSetUp?: (card: ConnectorSetupCardInfo) => void;
  /** Callback when user clicks "Save for later" on a setup offer card. */
  onConnectorSaveForLater?: (turnId: string) => void;
  /**
   * Marks the connector-setup suggestion as answered in the session-scoped
   * registry. Used as a belt-and-suspenders alongside `onConnectorSaveForLater`
   * so the card stays suppressed across component remount and cross-turn
   * re-emission. See docs-private/investigations/260416_duplicate_connector_setup_card.md.
   */
  onConnectorMarkAnswered?: (key: string) => void;
  /** Chrome display mode — 'reduced' makes session toolbar inert */
  chromeMode: ChromeMode;
  /** True during onboarding coaching — used for content suppressions (FirstBigWin, feedback, intro card) */
  isOnboardingCoachActive: boolean;
  /** True when a document preview drawer is open beside the chat. */
  isDocumentPreviewOpen?: boolean;

  // ── Meeting companion ───────────────────────────────────────────────────
  currentSessionMeetingCompanion: MeetingCompanionMeta | null | undefined;
  meetingStatus: ReturnType<typeof useMeetingStatus>;

  // ── Pinned sessions ─────────────────────────────────────────────────────
  pinnedFavorites: AgentSessionSidebarEntry[];

  // ── Settings-derived props ──────────────────────────────────────────────
  personalizedUseCases: PersonalizedUseCase[] | undefined;
  coreDirectory: string | null | undefined;
  inboundAuthorPolicyMode: PolicyMode;
  voiceProviderLabel: string | undefined;
  /**
   * Mic button gate. `true` means the user cannot start transcription.
   * For `openai-whisper`, Codex/ChatGPT Pro acts as an STT fallback — see App.tsx
   * `sttKeyMissing` computation and docs/plans/260415_codex_voice_stt_routing.md.
   */
  sttKeyMissing: boolean;
  /**
   * Speaker toggle gate. `true` means the TTS toggle should be blocked.
   * TTS is strictly key-based — Codex does NOT provide a TTS fallback.
   */
  ttsKeyMissing: boolean;
  localModelMissing: boolean;
  localModelDownloading: boolean;
  ttsUnavailable: boolean;

  // ── Model info (for SessionSettingsMenu model row) ─────────────────────
  modelInfo?: {
    workingModelName: string;
    thinkingModelName: string;
    thinkingInheritsFromWorking: boolean;
    hasAnyCustom: boolean;
    backgroundModelName: string;
    backgroundIsCustom: boolean;
  };
  onNavigateToModelSettings?: () => void;

  // ── Composer ────────────────────────────────────────────────────────────
  composerRef: RefObject<ComposerHandle | null>;
  composerProps: ComposerWithStateProps;

  // ── Conversation pane ref ───────────────────────────────────────────────
  agentSessionLogRef: RefObject<ConversationPaneHandle | null>;

  // ── Voice / recording ───────────────────────────────────────────────────
  isTranscribing: boolean;
  isTranscribeProcessing: boolean;
  transcriptionAudioLevel: number;
  autoSpeak: boolean;
  privateMode: boolean;
  councilMode: boolean;
  councilModeAvailable: boolean;
  councilModeDisabledTooltip?: string;
  autoDoneEnabled: boolean;

  // ── Finish line ─────────────────────────────────────────────────────────
  finishLine: string | null;
  setFinishLine: (value: string | null) => void;
  isEditingFinishLine: boolean;
  onToggleEditFinishLine: () => void;

  // ── Pending review data ─────────────────────────────────────────────────
  deniedOperations: ToolApprovalRequest[];
  stagedToolCalls: StagedToolCall[];
  currentSessionStagedFiles: StagedFileItem[];
  memoryApprovalRequests: MemoryWriteApprovalRequest[];
  isExecutingStagedTools: boolean;

  // ── Queued messages ─────────────────────────────────────────────────────
  currentSessionQueue: QueuedMessageEntry[];

  // ── Session coaching ────────────────────────────────────────────────────
  sessionCoaching: SessionCoachingEvaluation | null;
}

// ─── Component ──────────────────────────────────────────────────────────────

export const SessionSurfaceContent = memo(function SessionSurfaceContent(props: SessionSurfaceContentProps) {
  const {
    actionsRef,
    currentSessionId,
    currentSessionTitle,
    currentSessionStarredAt,
    currentSessionDoneAt,
    visibleMessages,
    eventsByTurn,
    messages,
    turnSummaries,
    visibleTurnId,
    focusedTurnId,
    processingTurnId,
    editingMessageId,
    turnStepContextByTurn,
    subAgentTimelineByTurn,
    activeStepByTurn,
    compactionBoundaries,
    isBusy,
    isStopping,
    isSettling,
    isRevealMasked,
    isTextMode,
    isInsightSurface,
    isDiagnosticsSurface,
    onToggleDiagnostics,
    thinkingHeadline,
    thinkingElapsedLabel,
    isScrolledAway,
    newMessageCount,
    isAnswerTopPinned,
    onJumpToLatest,
    selectedTrashedSessionId,
    flowHistoryOpen,
    mcpBuildCardState,
    onMcpBuildCardActions,
    onMcpBuildClearGithubCheck,
    enableContributionRelay = true,
    isOssBuild = false,
    connectorSetupFooterCard,
    onConnectorSetUp,
    onConnectorSaveForLater,
    onConnectorMarkAnswered,
    chromeMode,
    isOnboardingCoachActive,
    isDocumentPreviewOpen = false,
    currentSessionMeetingCompanion,
    meetingStatus,
    pinnedFavorites,
    personalizedUseCases: _personalizedUseCases,
    coreDirectory,
    inboundAuthorPolicyMode,
    voiceProviderLabel,
    sttKeyMissing,
    ttsKeyMissing,
    localModelMissing,
    localModelDownloading,
    ttsUnavailable,
    modelInfo,
    onNavigateToModelSettings,
    composerRef,
    composerProps,
    agentSessionLogRef,
    isTranscribing,
    isTranscribeProcessing,
    transcriptionAudioLevel,
    autoSpeak,
    privateMode,
    councilMode,
    councilModeAvailable,
    councilModeDisabledTooltip,
    autoDoneEnabled,
    finishLine,
    setFinishLine,
    isEditingFinishLine,
    onToggleEditFinishLine,
    deniedOperations,
    stagedToolCalls,
    currentSessionStagedFiles,
    memoryApprovalRequests,
    currentSessionQueue,
    sessionCoaching,
  } = props;
  const isBackgroundCurrentSession = isBackgroundConversationSession(currentSessionId);

  // ── Community share eligibility (via hook with module-level cache) ──────
  // Used here solely for coaching card gating. The card itself renders in ConversationPane.
  const communityShareEligibility = useCommunityShare(currentSessionId);

  const meetingTriggerState = useMeetingTriggerHeard(currentSessionId);
  const isOnline = useOnlineStatus();

  const handleAskSparkSubmit = useCallback((prompt: string, label: string) => {
    meetingEventEmitter.emit('quick-ask-submitted', {
      sessionId: currentSessionId,
      prompt,
      label,
    });
  }, [currentSessionId]);

  // ── Continue incomplete — wired to the silent stop Continue button ──────
  // Sends a continuation message when the user clicks Continue on a turn
  // that stopped with incomplete tasks.
  const onContinueIncomplete = useCallback(() => {
    void actionsRef.current.sendMessageToSession(
      currentSessionId,
      'Continue working on the remaining steps.',
    );
  }, [actionsRef, currentSessionId]);

  // ── Empty-state conversation starters — route through the existing queue ─
  // Clicking a personalized use case in the empty state should behave like
  // the user typed that prompt and hit send on the current (empty) session.
  const handleEmptyStateSubmitPrompt = useCallback((prompt: string) => {
    void actionsRef.current.sendMessageToSession(currentSessionId, prompt);
  }, [actionsRef, currentSessionId]);

  // ── Discovery: changelog "try it" — forward to the existing handler ─────
  // Stable wrapper that dereferences actionsRef at call time so the ref
  // pattern can keep callback changes from invalidating React.memo boundaries.
  const handleTryChangelog = useCallback((highlight: ChangelogHighlight) => {
    actionsRef.current.handleTryWhatsNewFeature(highlight);
  }, [actionsRef]);

  // ── Pending user questions (shown in place of InteractionStrip) ─────────
  // Route continuation through the message queue (matching memory/tool approval pattern).
  // This sets isBusy immediately, eliminating the timing gap.
  const handleQuestionSendContinuation = useCallback(
    (sessionId: string, message: string, attachments?: AnyAttachmentPayload[]): Promise<void> => {
      return actionsRef.current.sendMessageToSession(sessionId, message, undefined, {
        isHidden: true,
        attachments,
      });
    },
    [actionsRef],
  );

  const resolveTurnIdForMessage = useCallback(
    (message: AgentTurnMessage) => actionsRef.current.resolveTurnIdForMessage(message),
    [actionsRef],
  );

  const {
    cardByMessageIndex: authRequiredCardByMessageIndex,
    pendingFooterCard: authRequiredFooterCard,
    startReconnect: startAuthReconnect,
    cancelReconnect: cancelAuthReconnect,
  } = useAuthRequiredSignals(
    eventsByTurn,
    visibleMessages,
    resolveTurnIdForMessage,
  );

  const {
    questionBatches: footerQuestionBatches,
    submitAnswers: footerSubmitAnswers,
    dismissBatch: footerDismissBatch,
    undoDismiss: footerUndoDismiss,
    dismissedBatchIds: footerDismissedIds,
    isSubmitting: footerIsQuestionSubmitting,
    submissionError: footerQuestionError,
  } = useUserQuestions(currentSessionId, eventsByTurn, handleQuestionSendContinuation);
  const pendingFooterBatch = footerQuestionBatches.find((b) => !b.isAnswered && !b.dismissed);
  const lastShownQuestionErrorRef = useRef<string | null>(null);
  const [dismissedConnectorSetupQuestionId, setDismissedConnectorSetupQuestionId] = useState<string | null>(null);
  const [dismissedMcpBuildQuestionId, setDismissedMcpBuildQuestionId] = useState<string | null>(null);
  const [minimizedQuestionBatchId, setMinimizedQuestionBatchId] = useState<string | null>(null);
  // 260424 PR-template revamp follow-up (addendum #2): the Stage 4
  // `pendingAttributionMode` redirect was removed along with the inline
  // `github-check` form. Footer attribution clicks now submit directly
  // via the `onUseRebelName`/`onGitHubYes`/`onAnonymous` handlers — no
  // intermediate inline card, no scroll/focus effect, no form state.
  const connectorSetupQuestionBatch = useMemo(
    () => (
      connectorSetupFooterCard
        ? buildConnectorSetupQuestionBatch(connectorSetupFooterCard, currentSessionId)
        : null
    ),
    [connectorSetupFooterCard, currentSessionId],
  );
  const mcpBuildQuestionBatch = useMemo(
    () => (
      mcpBuildCardState
        ? buildMcpBuildQuestionBatch(mcpBuildCardState, currentSessionId, {
            enableContributionRelay,
            isOssBuild,
          })
        : null
    ),
    [currentSessionId, mcpBuildCardState, enableContributionRelay, isOssBuild],
  );
  const visibleConnectorSetupQuestionBatch = useMemo(
    () => (
      connectorSetupQuestionBatch?.batchId === dismissedConnectorSetupQuestionId
        ? null
        : connectorSetupQuestionBatch
    ),
    [connectorSetupQuestionBatch, dismissedConnectorSetupQuestionId],
  );
  // 260424 bug fix: suppress the synthetic MCP build batch while the
  // agent is mid-turn. See `mcpBuildQuestionVisibility.ts` for the full
  // rationale. The helper is pure and unit-tested; this memo just
  // threads current state through it.
  const visibleMcpBuildQuestionBatch = useMemo(
    () =>
      computeVisibleMcpBuildQuestionBatch({
        batch: mcpBuildQuestionBatch,
        dismissedBatchId: dismissedMcpBuildQuestionId,
        isBusy,
      }),
    [isBusy, mcpBuildQuestionBatch, dismissedMcpBuildQuestionId],
  );
  // 260428 Stage 0 fix: same selection as `visibleMcpBuildQuestionBatch`
  // but ignoring the `isBusy` gate. Used only by the minimized-question
  // cleanup effects below so they can match the right batch even
  // mid-turn (when the busy gate hides the visible batch). Render must
  // continue to use `visibleMcpBuildQuestionBatch`. See the helper's
  // jsdoc and `docs/plans/260428_keep_private_minimize_and_settings_share_button.md`
  // (Stage 0).
  const pendingMcpBuildBatch = useMemo(
    () =>
      computePendingMcpBuildQuestionBatch({
        batch: mcpBuildQuestionBatch,
        dismissedBatchId: dismissedMcpBuildQuestionId,
      }),
    [mcpBuildQuestionBatch, dismissedMcpBuildQuestionId],
  );

  useEffect(() => {
    if (!footerQuestionError) {
      lastShownQuestionErrorRef.current = null;
      return;
    }

    // Keep routine submission errors inline on the pending question card.
    // If the card is already gone (e.g. answer saved but continuation failed),
    // surface the failure with a toast so it does not disappear silently.
    if (pendingFooterBatch) {
      return;
    }

    if (lastShownQuestionErrorRef.current === footerQuestionError) {
      return;
    }

    lastShownQuestionErrorRef.current = footerQuestionError;
    actionsRef.current.showToast({
      title: 'Question answer saved, but Rebel could not continue',
      description: footerQuestionError,
      variant: 'error',
      duration: 10000,
    });
  }, [actionsRef, footerQuestionError, pendingFooterBatch]);

  useEffect(() => {
    if (!connectorSetupQuestionBatch) {
      setDismissedConnectorSetupQuestionId(null);
    }
  }, [connectorSetupQuestionBatch]);

  useEffect(() => {
    if (!mcpBuildQuestionBatch) {
      setDismissedMcpBuildQuestionId(null);
    }
  }, [mcpBuildQuestionBatch]);

  // ── Minimized question pill ──────────────────────────────────────────────
  // Auto-dismiss the minimized question when a new turn starts (user typed
  // a message instead of answering). The question is now stale.
  //
  // 260428 Stage 0 fix: the MCP build branch reads `pendingMcpBuildBatch`
  // (un-busy-gated), not `visibleMcpBuildQuestionBatch`, because by the
  // time this effect fires `isBusy` has already flipped to true and the
  // visible memo is null. The connector-setup branch is unaffected
  // (`visibleConnectorSetupQuestionBatch` is dismissal-filtered only,
  // not busy-gated).
  const prevBusyRef = useRef(isBusy);
  useEffect(() => {
    if (isBusy && !prevBusyRef.current && minimizedQuestionBatchId) {
      if (pendingFooterBatch?.batch.batchId === minimizedQuestionBatchId) {
        footerDismissBatch(minimizedQuestionBatchId);
      } else if (pendingMcpBuildBatch?.batchId === minimizedQuestionBatchId) {
        setDismissedMcpBuildQuestionId(minimizedQuestionBatchId);
      } else if (visibleConnectorSetupQuestionBatch?.batchId === minimizedQuestionBatchId) {
        setDismissedConnectorSetupQuestionId(minimizedQuestionBatchId);
      } else {
        // Observability: minimized batch id matches none of the three live
        // batches at busy-transition time. Most likely the underlying batch
        // already cleared (status flip + cleanup ran) and this effect is
        // racing the clear. Log once so we can spot true silent-failure
        // regressions per AGENTS.md "Silent failure is a bug" rule.
        console.warn('[SessionSurfaceContent] busy-transition cleanup: minimized batch id matched no live batch', {
          minimizedQuestionBatchId,
          pendingFooterBatchId: pendingFooterBatch?.batch.batchId ?? null,
          pendingMcpBuildBatchId: pendingMcpBuildBatch?.batchId ?? null,
          connectorSetupBatchId: visibleConnectorSetupQuestionBatch?.batchId ?? null,
        });
      }
      setMinimizedQuestionBatchId(null);
    }
    prevBusyRef.current = isBusy;
  }, [isBusy, minimizedQuestionBatchId, pendingFooterBatch, pendingMcpBuildBatch, visibleConnectorSetupQuestionBatch, footerDismissBatch]);

  // Clear minimized state when the batch disappears (answered, dismissed elsewhere, etc.)
  // Uses `pendingMcpBuildBatch` so the pill survives across `isBusy`
  // transitions; the busy-gated `visibleMcpBuildQuestionBatch` would
  // spuriously fail the `stillExists` check mid-turn. See Stage 0 fix.
  useEffect(() => {
    if (!minimizedQuestionBatchId) return;
    const stillExists =
      pendingFooterBatch?.batch.batchId === minimizedQuestionBatchId ||
      pendingMcpBuildBatch?.batchId === minimizedQuestionBatchId ||
      visibleConnectorSetupQuestionBatch?.batchId === minimizedQuestionBatchId;
    if (!stillExists) setMinimizedQuestionBatchId(null);
  }, [minimizedQuestionBatchId, pendingFooterBatch, pendingMcpBuildBatch, visibleConnectorSetupQuestionBatch]);

  const handleMinimizeQuestion = useCallback((batchId: string) => {
    setMinimizedQuestionBatchId(batchId);
  }, []);

  const handleRestoreMinimizedQuestion = useCallback(() => {
    setMinimizedQuestionBatchId(null);
  }, []);

  // Stage 0 amendment: uses `pendingMcpBuildBatch` (un-busy-gated) for
  // symmetry with the busy-transition cleanup effect above. Closes a
  // theoretical one-render race where the user clicks the pill X while
  // `isBusy` has already flipped true but the post-render busy effect
  // hasn't cleared `minimizedQuestionBatchId` yet — `visibleMcpBuildQuestionBatch`
  // would be null in that window, dropping the dismissal record.
  const handleDismissMinimizedQuestion = useCallback(() => {
    if (!minimizedQuestionBatchId) return;
    if (pendingFooterBatch?.batch.batchId === minimizedQuestionBatchId) {
      footerDismissBatch(minimizedQuestionBatchId);
    } else if (pendingMcpBuildBatch?.batchId === minimizedQuestionBatchId) {
      setDismissedMcpBuildQuestionId(minimizedQuestionBatchId);
    } else if (visibleConnectorSetupQuestionBatch?.batchId === minimizedQuestionBatchId) {
      setDismissedConnectorSetupQuestionId(minimizedQuestionBatchId);
    }
    setMinimizedQuestionBatchId(null);
  }, [minimizedQuestionBatchId, pendingFooterBatch, pendingMcpBuildBatch, visibleConnectorSetupQuestionBatch, footerDismissBatch]);

  const handleConnectorSetupQuestionSubmit = useCallback(
    async (batchId: string, answers: UserQuestionAnswer[]) => {
      if (!connectorSetupFooterCard) return;
      const selectedOptionIds = new Set(answers[0]?.selectedOptionIds ?? []);

      setDismissedConnectorSetupQuestionId(batchId);

      if (selectedOptionIds.has('set-up-now')) {
        await onConnectorSetUp?.(connectorSetupFooterCard);
        return;
      }

      if (selectedOptionIds.has('save-for-later')) {
        // Belt-and-suspenders: mark in the session-scoped answered registry
        // in addition to the turn-keyed `savedTurnIds` path, so suppression
        // survives component remount (session-tab switch) AND cross-turn
        // re-emission of the same connector's signal.
        // See docs-private/investigations/260416_duplicate_connector_setup_card.md.
        const key = buildConnectorSetupKey({
          intent: connectorSetupFooterCard.intent,
          connectorId: connectorSetupFooterCard.connectorId,
          connectorName: connectorSetupFooterCard.connectorName,
        });
        onConnectorSaveForLater?.(connectorSetupFooterCard.turnId);
        onConnectorMarkAnswered?.(key);
      }
    },
    [connectorSetupFooterCard, onConnectorMarkAnswered, onConnectorSaveForLater, onConnectorSetUp],
  );

  const handleConnectorSetupQuestionDismiss = useCallback(
    (batchId: string) => {
      setDismissedConnectorSetupQuestionId(batchId);
    },
    [],
  );
  // 260424 PR-template revamp follow-up (addendum #2): with the inline
  // form removed, the footer picker now awaits the submit IPC directly.
  // Thread a local busy flag into the `UserQuestionCard` below so the
  // picker visibly disables during the ~100–500ms latency between the
  // click and the `submitting` overlay mounting — prevents rapid-click
  // double-invocations from looking like the UI is unresponsive (the
  // `isSubmittingRef` guard inside `useMcpBuildSubmission` already
  // blocks data corruption; this is purely visual feedback).
  const [isMcpBuildFooterSubmitting, setIsMcpBuildFooterSubmitting] = useState(false);
  const handleMcpBuildQuestionSubmit = useCallback(
    async (batchId: string, answers: UserQuestionAnswer[]) => {
      const selectedOptionIds = new Set(answers[0]?.selectedOptionIds ?? []);
      setIsMcpBuildFooterSubmitting(true);
      try {
        const { shouldDismiss, shouldMinimize } = await routeMcpBuildAnswer({
          selectedOptionIds,
          actions: onMcpBuildCardActions,
          mcpBuildCardState,
        });
        // 260428 Stage 1: "Keep it private" routes through the existing
        // minimize machinery (same code path as the manual minimize
        // button) instead of full dismissal — the user gets a
        // `MinimizedQuestionPill` they can restore. `shouldMinimize`
        // takes precedence over `shouldDismiss`; legacy callers without
        // the flag fall through to the existing dismiss behavior.
        if (shouldMinimize) {
          handleMinimizeQuestion(batchId);
        } else if (shouldDismiss) {
          setDismissedMcpBuildQuestionId(batchId);
        }
      } finally {
        setIsMcpBuildFooterSubmitting(false);
      }
    },
    [onMcpBuildCardActions, mcpBuildCardState, handleMinimizeQuestion],
  );
  const handleMcpBuildQuestionDismiss = useCallback(
    (batchId: string) => {
      setDismissedMcpBuildQuestionId(batchId);
      // Stage 1.3 X1a (260420 OSS MCP backend relay): when the user
      // dismisses the github-check picker explicitly, clear the
      // preserved transient in the submission hook. Without this, R1's
      // failure-preservation keeps `githubCheckConnectorName` set, the
      // effective memo stays pinned to `github-check`, and the next
      // `buildMcpBuildQuestionBatch` call produces the same `batchId`
      // that the user just dismissed — so the submit-prompt retry
      // affordance never re-renders until the session is switched.
      if (mcpBuildCardState?.phase === 'github-check') {
        onMcpBuildClearGithubCheck?.();
      }
    },
    [mcpBuildCardState, onMcpBuildClearGithubCheck],
  );

  // ── Conversation-level file aggregation for the files indicator ─────────
  const { statusByTurn: memoryStatusByTurn } = useMemoryUpdateStatus();
  const conversationFiles = useConversationFiles(turnStepContextByTurn, memoryStatusByTurn);

  // ── Stage 7 — browser-extension context for the current conversation ───
  // Drives the BrowserContextChip (tab host pill) and ExternalContextIndicator
  // ("held for you" banner) mounted via the InteractionStrip topAccessory.
  const externalContext = useExternalContextForSession(currentSessionId);
  const hasBrowserContext = Boolean(
    externalContext?.tabContext?.url || externalContext?.tabContext?.title,
  );
  const hasDocumentContext = Boolean(
    externalContext?.documentContext?.host || externalContext?.documentContext?.title,
  );
  const parsedExternalContext = externalContext?.externalContext as ExternalContext | undefined;
  const slackExternalContext = parsedExternalContext
    && (parsedExternalContext.kind === 'slack-thread' || parsedExternalContext.kind === 'slack-mention-poll')
    ? parsedExternalContext
    : null;
  const hasSlackContext = Boolean(slackExternalContext);
  const slackContextMetadata = slackExternalContext?.metadata;
  const digestFilteredCount = slackContextMetadata?.digestFilteredCount ?? 0;
  const externalContextSourceLabel = resolveExternalContextSourceLabel(externalContext);
  const hasHeldMessages = (externalContext?.queueSize ?? 0) > 0;

  // ── Annotation state for composer integration ────────────────────────────
  const [annotationCount, setAnnotationCount] = useState(0);
  const sendAnnotationsRef = useRef<(() => void) | null>(null);
  const [isWideMode, setIsWideMode] = useState(false);
  const [isModelOverrideVisible, setIsModelOverrideVisible] = useState(false);
  const { activeSurface, setActiveSurface } = useFlowPanels();

  const handleToggleWideMode = useCallback(() => {
    setIsWideMode(prev => !prev);
  }, []);

  const handleToggleModelOverride = useCallback(() => {
    setIsModelOverrideVisible(prev => !prev);
  }, []);

  // Keyboard shortcut: Cmd/Ctrl+Shift+F to toggle wide mode
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      handleSessionWideModeShortcut(event, activeSurface, () => {
        setIsWideMode(prev => !prev);
      });
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeSurface]);

  // Stable callback that the composer chain calls to trigger annotation send
  const handleSendAnnotations = useCallback(() => {
    sendAnnotationsRef.current?.();
  }, []);

  // ── Stable callback wrappers that dereference actionsRef at call time ───
  // These ensure we always call the latest callback from App.tsx.
  const actions = actionsRef.current;

  // ── Inline handler for PinnedFavoritesTabs.onSelect ─────────────────────
  const handlePinnedTabSelect = useCallback((sessionId: string) => {
    if (sessionId !== currentSessionId) {
      actionsRef.current.handleOpenHistorySession(sessionId, 'collapsed_tabs');
    } else {
      actionsRef.current.setSelectedTrashedSessionId(null);
    }
  }, [actionsRef, currentSessionId]);

  // ── Inline handler for PinnedFavoritesTabs.onUnpin ──────────────────────
  const handlePinnedTabUnpin = useCallback((sessionId: string) => {
    if (sessionId) {
      actionsRef.current.handleTogglePinSession(sessionId);
    }
  }, [actionsRef]);

  // ── Inline handler for PinnedFavoritesTabs.onNewChat ──────────────────
  const handleCollapsedNewChat = useCallback(() => {
    actionsRef.current.handleNewChat('collapsed_tabs');
  }, [actionsRef]);

  // ── Inline handler for trashed session restore ──────────────────────────
  const handleRestoreTrashedSession = useCallback(async () => {
    if (!selectedTrashedSessionId) return;
    actionsRef.current.restoreSession(selectedTrashedSessionId);
    actionsRef.current.setSelectedTrashedSessionId(null);
    // Use canonical navigation helper so scroll-settling contract is applied
    // and the user lands at the latest turn of the just-restored conversation
    // (rather than the top of a long reused transcript).
    await actionsRef.current.navigateToConversation(selectedTrashedSessionId, 'restore');
  }, [actionsRef, selectedTrashedSessionId]);

  // The conversation currently on screen is a trashed (soft-deleted) session,
  // opened read-only. Gated on the id matching currentSessionId so the banner /
  // disabled composer only appear once the trashed transcript has actually loaded.
  const isCurrentSessionTrashed =
    selectedTrashedSessionId != null && selectedTrashedSessionId === currentSessionId;

  // ── Meeting companion coach selection handler ───────────────────────────
  const handleMeetingCoachSelect = useCallback(async (coach: CoachSelection | null, withPresenceMode?: PresenceMode) => {
    if (coach) {
      const result = await window.meetingBotApi?.setCoach?.({
        coachSkillPath: coach.skillPath,
        companionSessionId: currentSessionId,
      });
      if (result?.success) {
        getSessionStoreState().setMeetingCompanionCoach({
          skillPath: coach.skillPath,
          skillName: coach.skillName,
          showAllChecks: true,
        });
        if (withPresenceMode) {
          void window.meetingBotApi?.setPresenceMode?.({ mode: withPresenceMode });
        }
      } else {
        actionsRef.current.showToast({ title: 'Could not start coaching - no active meeting' });
      }
    } else {
      const clearResult = await window.meetingBotApi?.setCoach?.(null);
      if (clearResult?.success !== false) {
        getSessionStoreState().setMeetingCompanionCoach(null);
      } else {
        actionsRef.current.showToast({ title: 'Failed to clear coach' });
      }
    }
  }, [actionsRef, currentSessionId]);

  // ── Meeting companion show all checks toggle ────────────────────────────
  const handleToggleShowAllChecks = useCallback((value: boolean) => {
    getSessionStoreState().setShowAllChecks(value);
  }, []);

  const handlePresenceModeChange = useCallback((mode: PresenceMode) => {
    void window.meetingBotApi?.setPresenceMode?.({ mode });
  }, []);

  // ── Council review button visibility ─────────────────────────────────────
  const canRequestCouncilReview = useMemo(() => {
    if (isBusy || !councilModeAvailable || councilMode) return false;
    const hasAssistantMessage = messages.some((m) => m.role === 'assistant' || m.role === 'result');
    if (!hasAssistantMessage) return false;
    // Prevent review-of-review: check if the last user message was a council review prompt
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUserMsg?.text === COUNCIL_REVIEW_PROMPT) return false;
    return true;
  }, [isBusy, councilModeAvailable, councilMode, messages]);

  // ── InteractionStrip stopActiveTurn wrapper ─────────────────────────────
  const handleStopActiveTurn = useCallback(() => {
    actionsRef.current.stopActiveTurn();
  }, [actionsRef]);

  // ── Session coaching act handler ────────────────────────────────────────
  const handleCoachingAct = useCallback((prompt: string) => {
    void actionsRef.current.updateCoachingState(currentSessionId, 'acted');
    actionsRef.current.setCoachingSessionIds((prev: Set<string>) => {
      const next = new Set(prev);
      next.delete(currentSessionId);
      return next;
    });
    actionsRef.current.handleSelectUseCase(prompt);
  }, [actionsRef, currentSessionId]);

  // ── Session coaching dismiss handler ────────────────────────────────────
  const handleCoachingDismiss = useCallback((reason?: SessionCoachingEvaluation['dismissalReason']) => {
    void actionsRef.current.updateCoachingState(currentSessionId, 'dismissed', reason);
    actionsRef.current.setCoachingSessionIds((prev: Set<string>) => {
      const next = new Set(prev);
      next.delete(currentSessionId);
      return next;
    });
  }, [actionsRef, currentSessionId]);

  // ── Community share handlers ────────────────────────────────────────────
  const handleSharePreview = useCallback(async () => {
    const preview = await actionsRef.current.composeSharePost(currentSessionId);
    return preview;
  }, [actionsRef, currentSessionId]);

  const handleShareOpen = useCallback(async () => {
    await actionsRef.current.openDiscourseShare(currentSessionId);
  }, [actionsRef, currentSessionId]);

  const handleShareDismiss = useCallback(() => {
    void actionsRef.current.dismissShare(currentSessionId);
  }, [actionsRef, currentSessionId]);

  const handleShareOptOut = useCallback(() => {
    void actionsRef.current.optOutSharing();
  }, [actionsRef]);

  // ── Clear queue for current session wrapper ─────────────────────────────
  const handleClearQueue = useCallback(() => {
    actionsRef.current.clearQueueForSession(currentSessionId);
  }, [actionsRef, currentSessionId]);

  // ── Local conversationContextMenu state for the context menu ────────────
  // This needs to be here so right-click context menu works within the memoized component
  const [localContextMenu, setLocalContextMenu] = useState<ConversationContextMenuAnchor | null>(null);

  const handleLocalContextMenu = useCallback((event: React.MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (
      target.closest('article') ||
      target.closest('button') ||
      target.closest('a') ||
      target.closest('input') ||
      target.closest('textarea') ||
      target.closest('[contenteditable]') ||
      target.closest('[data-selectable-content]')
    ) {
      return;
    }
    event.preventDefault();
    setLocalContextMenu({
      x: event.clientX,
      y: event.clientY,
      contextElement: event.currentTarget,
    });
  }, []);

  const handleLocalContextMenuClose = useCallback(() => {
    setLocalContextMenu(null);
  }, []);

  // ── Folder wiring for "Move to folder" in the conversation actions menu ──
  // The sidebar has its own copy of this wiring; both surfaces are connected
  // to the same Zustand folder store, so they stay in sync.
  //
  // Subscribes only to the current session's membership entry (not the whole
  // map) to avoid re-rendering this memoized surface on unrelated folder moves.
  const folders = useFolders();
  const currentFolderId = useFolderStore(
    (s) => s.membership[currentSessionId] ?? null,
  );
  const { moveSessionToFolder, removeSessionFromFolder, createFolder } = useFolderActions();
  const isInFolder = Boolean(currentFolderId);

  const reopenCurrentFolder = useCallback(() => {
    if (!currentFolderId) {
      return;
    }

    const sessionEntries = getSessionStoreState().sessionSummaries.map((summary) => ({
      id: summary.id,
      isActive: isSessionActive(summary),
      isDeleted: Boolean(summary.deletedAt),
    }));
    const sessionIds = getFolderSessionIdsToSetActiveState(
      sessionEntries,
      getFolderStoreState().membership,
      currentFolderId,
      true,
    );

    for (const sessionId of sessionIds) {
      actionsRef.current.handleTogglePinSession(sessionId);
    }
  }, [actionsRef, currentFolderId]);

  const handleFolderAwareToggleStar = useCallback((
    sessionId: string,
    event?: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    // Done (`doneAt != null`) folder gets reopened when a member is starred.
    if (currentFolderId && currentSessionDoneAt != null) {
      reopenCurrentFolder();
    }
    actionsRef.current.handleToggleStarSession(sessionId, event);
  }, [actionsRef, currentFolderId, currentSessionDoneAt, reopenCurrentFolder]);

  // Latch the target sessionId when the popover opens so that a subsequent
  // session switch (e.g., notification routing) can't redirect the action to
  // the wrong conversation. Mirrors the sidebar's pattern.
  const [moveToFolderState, setMoveToFolderState] = useState<
    { sessionId: string; anchor: { x: number; y: number } } | null
  >(null);

  const handleOpenMoveToFolder = useCallback(
    (sessionId: string, event: ReactMouseEvent<HTMLButtonElement>) => {
      setMoveToFolderState({
        sessionId,
        anchor: { x: event.clientX, y: event.clientY },
      });
    },
    [],
  );

  const handleCloseMoveToFolder = useCallback(() => {
    setMoveToFolderState(null);
  }, []);

  const handleMoveSessionToFolder = useCallback(
    (folderId: string) => {
      if (moveToFolderState) {
        moveSessionToFolder(moveToFolderState.sessionId, folderId);
      }
    },
    [moveSessionToFolder, moveToFolderState],
  );

  const handleRemoveSessionFromFolder = useCallback(() => {
    if (moveToFolderState) {
      removeSessionFromFolder(moveToFolderState.sessionId);
    }
  }, [removeSessionFromFolder, moveToFolderState]);

  // Direct menu-item callback (bypasses the popover): uses the sessionId the
  // menu resolved at open time, not currentSessionId.
  const handleRemoveFromFolderAction = useCallback(
    (sessionId: string) => {
      removeSessionFromFolder(sessionId);
    },
    [removeSessionFromFolder],
  );

  // Derive the folder ID at the time the popover opened, so the "current
  // folder" ✓ indicator and the visibility of "Remove from folder" inside the
  // popover remain correct even if the user switches sessions while open.
  const popoverCurrentFolderId = useFolderStore(
    (s) => (moveToFolderState ? s.membership[moveToFolderState.sessionId] ?? null : null),
  );

  const blockingCount = deniedOperations.length + memoryApprovalRequests.length;
  const nonBlockingCount = stagedToolCalls.length + currentSessionStagedFiles.length;
  const hasPendingReview = blockingCount > 0 || nonBlockingCount > 0;
  const currentSessionConflict = useSessionConflictStore((state) => state.conflictsBySessionId[currentSessionId] ?? null);
  const dismissSessionConflict = useSessionConflictStore((state) => state.dismissConflict);
  const showSessionConflictBadge = currentSessionConflict !== null && currentSessionConflict.dismissedAt === null;
  const sessionConflictAgeLabel = currentSessionConflict
    ? formatConflictAgeShort(currentSessionConflict.detectedAt)
    : null;
  const sessionConflictTooltip = currentSessionConflict
    ? describeConflictFields(currentSessionConflict.fields ?? [])
    : '';

  const handleOpenReviewDrawer = useCallback(() => {
    actionsRef.current.openNotificationsForSession(currentSessionId);
  }, [actionsRef, currentSessionId]);

  const handleDismissSessionConflict = useCallback(() => {
    dismissSessionConflict(currentSessionId);
  }, [currentSessionId, dismissSessionConflict]);

  return (
    <>
      {/* Session pane */}
      <section className={paneStyles.pane} onContextMenu={handleLocalContextMenu}>
        <div
          className={cn(
            paneStyles.toolbar,
            !flowHistoryOpen && paneStyles.toolbarWithDivider,
          )}
          inert={chromeInert(chromeMode)}
        >
          {!flowHistoryOpen ? (
            <PinnedFavoritesTabs
              pinnedSessions={pinnedFavorites}
              activeSessionId={currentSessionId}
              onSelect={handlePinnedTabSelect}
              onUnpin={handlePinnedTabUnpin}
              onNewChat={handleCollapsedNewChat}
            />
          ) : null}
          {showSessionConflictBadge ? (
            <div
              className={paneStyles.sessionConflictBadge}
              role="status"
              aria-live="polite"
              title={sessionConflictTooltip}
              aria-label={`Edited elsewhere ${sessionConflictAgeLabel ?? ''}. ${sessionConflictTooltip}`.trim()}
              data-testid="session-conflict-badge"
            >
              <AlertTriangle size={14} className={paneStyles.sessionConflictBadgeIcon} aria-hidden />
              <span className={paneStyles.sessionConflictBadgeText}>
                {sessionConflictAgeLabel ? `Edited elsewhere ${sessionConflictAgeLabel}` : 'Edited elsewhere'}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className={paneStyles.sessionConflictBadgeDismiss}
                onClick={handleDismissSessionConflict}
                aria-label="Dismiss conflict badge"
              >
                <X size={12} aria-hidden />
              </Button>
            </div>
          ) : null}
        </div>
        {isCurrentSessionTrashed && (
          <div className={paneStyles.trashedBanner} role="status">
            <Trash2 size={15} className={paneStyles.trashedBannerIcon} aria-hidden />
            <span className={paneStyles.trashedBannerText}>
              This conversation is in the Trash. It&apos;s read-only until you restore it.
            </span>
            <Button size="sm" onClick={handleRestoreTrashedSession}>
              Restore
            </Button>
          </div>
        )}
        <>
            {isDiagnosticsSurface ? (
              <DiagnosticsPanel
                sessionId={currentSessionId}
                eventsByTurn={eventsByTurn}
                turnSummaries={turnSummaries}
                messages={messages}
                turnStepContextByTurn={turnStepContextByTurn}
                onClose={onToggleDiagnostics}
              />
            ) : (
              <>
                {currentSessionMeetingCompanion && (
                  <MeetingCompanionBanner
                    meetingTitle={currentSessionMeetingCompanion.meetingTitle}
                    meetingUrl={currentSessionMeetingCompanion.meetingUrl}
                    isRecording={
                      (meetingStatus.state === 'recording' || meetingStatus.state === 'recording_local' || meetingStatus.state === 'collaborator_recording') &&
                      meetingStatus.meeting?.meetingUrl === currentSessionMeetingCompanion.meetingUrl
                    }
                    disableParticipantMode={meetingStatus.state === 'recording_local' || meetingStatus.state === 'collaborator_recording'}
                    captionsActive={meetingStatus.captionsActive}
                    selectedCoach={
                      currentSessionMeetingCompanion.coach
                        ? {
                            skillPath: currentSessionMeetingCompanion.coach.skillPath,
                            skillName: currentSessionMeetingCompanion.coach.skillName,
                          }
                        : null
                    }
                    onSelectCoach={handleMeetingCoachSelect}
                    showAllChecks={currentSessionMeetingCompanion.coach?.showAllChecks ?? true}
                    onToggleShowAllChecks={handleToggleShowAllChecks}
                    presenceMode={
                      meetingStatus.meeting?.meetingUrl === currentSessionMeetingCompanion.meetingUrl
                        ? meetingStatus.presenceMode
                        : undefined
                    }
                    onPresenceModeChange={handlePresenceModeChange}
                    isOnline={isOnline}
                    triggerState={meetingTriggerState}
                    onAskSparkSubmit={handleAskSparkSubmit}
                    onOpenOperatorsPanel={() => setActiveSurface('team')}
                  />
                )}
                <ConversationModelSelector hasMessages={visibleMessages.length > 0} isExpanded={isModelOverrideVisible} />
                <ConversationProfileLearnedNote hasMessages={visibleMessages.length > 0} />
                <DevProfiler id="ConversationPane">
                  <ConversationPane
                    // REBEL-5D5: TanStack virtualizer elementsCache retains never-repeating
                    // message-keyed DOM; remount per session makes cross-session retention
                    // unreachable. See docs/plans/260611_rebel-5d5-renderer-leak/.
                    key={currentSessionId}
                    ref={agentSessionLogRef}
                    visibleMessages={visibleMessages}
                    eventsByTurn={eventsByTurn}
                    visibleTurnId={visibleTurnId}
                    focusedTurnId={focusedTurnId}
                    processingTurnId={processingTurnId}
                    editingMessageId={editingMessageId}
                    isBusy={isBusy}
                    isPausedForApproval={blockingCount > 0}
                    isStopping={isStopping}
                    isSettling={isSettling}
                    isRevealMasked={isRevealMasked}
                    suspendBottomAnchor={isAnswerTopPinned}
                    currentSessionId={currentSessionId}
                    isTextMode={isTextMode}
                    turnStepContextByTurn={turnStepContextByTurn}
                    subAgentTimelineByTurn={subAgentTimelineByTurn}
                    activeStepByTurn={activeStepByTurn}
                    thinkingHeadline={thinkingHeadline}
                    thinkingElapsedLabel={thinkingElapsedLabel}
                    compactionBoundaries={compactionBoundaries}
                    resolveTurnIdForMessage={resolveTurnIdForMessage}
                    onBeginEditMessage={actions.handleBeginEditMessage}
                    onRetryMessage={actions.handleRetryMessage}
                    onStopActiveTurn={actions.stopActiveTurn}
                    onSelectInlineStep={actions.handleSelectInlineStep}
                    onFocusTurn={actions.focusTurn}
                    onOpenFile={actions.handleOpenDocumentInPreview}
                    onOpenFolder={actions.handleOpenWorkspaceFolder}
                    onOpenConversation={actions.handleOpenConversationReference}
                    onNavigate={actions.handleNavigateFromChat}
                    onOpenTutorial={actions.handleOpenTutorial}
                    onCopyToClipboard={actions.handleCopyToClipboard}
                    showToast={actions.showToast}
                    coreDirectory={coreDirectory ?? undefined}
                    onOpenInLibrary={actions.handleOpenInLibrary}
                    isOnboardingCoachActive={isOnboardingCoachActive}
                    onSharePreview={handleSharePreview}
                    onShareOpen={handleShareOpen}
                    onShareDismiss={handleShareDismiss}
                    onShareOptOut={handleShareOptOut}
                    isWideMode={isWideMode}
                    isDocumentPreviewOpen={isDocumentPreviewOpen}
                    mcpBuildCardState={mcpBuildCardState}
                    onMcpBuildCardActions={onMcpBuildCardActions}
                    isOssBuild={isOssBuild}
                    authRequiredCardByMessageIndex={authRequiredCardByMessageIndex}
                    onStartAuthReconnect={startAuthReconnect}
                    onCancelAuthReconnect={cancelAuthReconnect}
                    dismissedBatchIds={footerDismissedIds}
                    onUndoDismiss={footerUndoDismiss}
                    onContinueIncomplete={onContinueIncomplete}
                    onSubmitPrompt={handleEmptyStateSubmitPrompt}
                    onTryChangelog={handleTryChangelog}
                  />
                </DevProfiler>
              </>
            )}
          </>
        <ConversationNav
          isScrolledAway={isScrolledAway}
          newMessageCount={newMessageCount}
          visibleMessages={visibleMessages}
          containerRef={agentSessionLogRef}
          currentSessionId={currentSessionId}
          isInsightSurface={isInsightSurface}
          isDiagnosticsSurface={isDiagnosticsSurface}
          onJumpToLatest={onJumpToLatest}
        />
        <ConversationActionsMenu
          sessionId={currentSessionId}
          sessionTitle={currentSessionTitle ?? 'Conversation'}
          isStarred={Boolean(currentSessionStarredAt)}
          isActive={isSessionActive({ doneAt: currentSessionDoneAt })}
          onRename={actions.startRename}
          onDelete={actions.handleSoftDeleteSession}
          onFindSimilar={actions.handleFindSimilar}
          onToggleStar={handleFolderAwareToggleStar}
          onTogglePin={isBackgroundCurrentSession ? undefined : actions.handleTogglePinSession}
          onCopyMarkdown={actions.handleCopyMarkdown}
          onExportMarkdown={actions.handleExportMarkdown}
          onCopyLink={actions.handleCopyConversationLink}
          onShareConversation={actions.handleShareConversation}
          onRevealInSidebar={actions.handleRevealInSidebar}
          onDiagnose={actions.handleStartDiagnose}
          onExportLogs={actions.handleExportLogs}
          onMoveToFolder={handleOpenMoveToFolder}
          onRemoveFromFolder={handleRemoveFromFolderAction}
          isInFolder={isInFolder}
          contextAnchor={localContextMenu}
          onContextClose={handleLocalContextMenuClose}
          toolbarVisible={!flowHistoryOpen}
          isWideMode={isWideMode}
          onToggleWideMode={handleToggleWideMode}
          onToggleDiagnostics={onToggleDiagnostics}
          isDiagnosticsActive={isDiagnosticsSurface}
          isBusy={isBusy}
          isModelOverrideVisible={isModelOverrideVisible}
          onToggleModelOverride={handleToggleModelOverride}
          hasMessages={visibleMessages.length > 0}
        />
        <ConversationCategoryIndicator
          isStarred={Boolean(currentSessionStarredAt)}
          isActive={isSessionActive({ doneAt: currentSessionDoneAt })}
          toolbarVisible={!flowHistoryOpen}
        />
        {moveToFolderState && (
          <MoveToFolderPopover
            folders={folders}
            currentFolderId={popoverCurrentFolderId}
            anchor={moveToFolderState.anchor}
            onMoveToFolder={handleMoveSessionToFolder}
            onRemoveFromFolder={handleRemoveSessionFromFolder}
            onCreateFolder={createFolder}
            onClose={handleCloseMoveToFolder}
          />
        )}
      </section>

      {/* Session footer */}
      <div className={paneStyles.footer}>
        {isCurrentSessionTrashed ? (
          <div className={paneStyles.trashedFooterNotice}>
            <span>You can&apos;t reply to a conversation in the Trash.</span>
            <Button variant="ghost" size="sm" onClick={handleRestoreTrashedSession}>
              Restore to reply
            </Button>
          </div>
        ) : (
          <>
        {/* Session coaching card - shown when returning to completed sessions (hidden when community share is active) */}
        {!communityShareEligibility && sessionCoaching?.state === 'pending' && !isBusy && (
          <SessionCoachingCard
            evaluation={sessionCoaching}
            onAct={handleCoachingAct}
            onDismiss={handleCoachingDismiss}
          />
        )}
        <AnnotationOrchestrator
          currentSessionId={currentSessionId}
          agentSessionLogRef={agentSessionLogRef}
          handleUserMessage={actions.submitQueuedMessage}
          composerRef={composerRef}
          clearComposerAfterSend={actions.clearComposerAfterSend}
          isBusy={isBusy}
          showToast={actions.showToast}
          onAnnotationActiveChange={actions.setIsAnnotationActive}
          onAnnotationCountChange={setAnnotationCount}
          sendAnnotationsRef={sendAnnotationsRef}
          prepareMentionAttachments={actions.prepareMentionAttachments}
          prepareConversationAttachments={actions.prepareConversationAttachments}
          onReply={actions.handleSelectionMenuReply}
          onReplyInNewChat={actions.handleSelectionMenuReplyInNewChat}
          onGenericAddComment={actions.handleGenericAddComment}
          onMenuOpenChange={actions.handleSelectionMenuOpenChange}
        />
        <DevProfiler id="InteractionStrip">
          <InteractionStrip
            isInsightSurface={isInsightSurface}
            isDiagnosticsSurface={isDiagnosticsSurface}
            isBusy={isBusy}
            isStopping={isStopping}
            processingTurnId={processingTurnId}
            onStopActiveTurn={handleStopActiveTurn}
            composerRef={composerRef}
            composerProps={composerProps}
            annotationCount={annotationCount}
            onSendAnnotations={handleSendAnnotations}
            isTranscribing={isTranscribing}
            isTranscribeProcessing={isTranscribeProcessing}
            onToggleTranscription={actions.handleToggleTranscription}
            onStopAndSend={actions.handleStopAndSend}
            audioLevel={transcriptionAudioLevel}
            autoSpeak={autoSpeak}
            onToggleAutoSpeak={actions.handleToggleAutoSpeak}
            privateMode={privateMode}
            onPrivateModeChange={actions.setPrivateMode}
            councilMode={councilMode}
            onCouncilModeChange={actions.setCouncilMode}
            councilModeAvailable={councilModeAvailable}
            councilModeDisabledTooltip={councilModeDisabledTooltip}
            autoDoneEnabled={isBackgroundCurrentSession ? false : autoDoneEnabled}
            onToggleAutoDone={isBackgroundCurrentSession ? undefined : actions.handleToggleAutoDone}
            hasMessages={messages.length > 0}
            onMarkDoneNow={isBackgroundCurrentSession ? undefined : actions.handleMarkDoneNow}
            showToast={actions.showToast}
            sttKeyMissing={sttKeyMissing}
            ttsKeyMissing={ttsKeyMissing}
            localModelMissing={localModelMissing}
            localModelDownloading={localModelDownloading}
            ttsUnavailable={ttsUnavailable}
            voiceProviderLabel={voiceProviderLabel}
            onOpenSettings={actions.handleNavigateToVoiceSettings}
            modelInfo={modelInfo}
            onNavigateToModelSettings={onNavigateToModelSettings}
            conversationFiles={conversationFiles}
            onOpenFile={actions.handleOpenDocumentInPreview}
            coreDirectory={coreDirectory ?? undefined}
            canRequestCouncilReview={canRequestCouncilReview}
            onRequestCouncilReview={actions.requestCouncilReview}
            finishLine={finishLine}
            onFinishLineChange={setFinishLine}
            isEditingFinishLine={isEditingFinishLine}
            onToggleEditFinishLine={onToggleEditFinishLine}
            topAccessory={(
              hasPendingReview
              || currentSessionQueue.length > 0
              || hasBrowserContext
              || hasDocumentContext
              || hasSlackContext
              || hasHeldMessages
              || minimizedQuestionBatchId
            ) ? (
              <>
                {minimizedQuestionBatchId && (
                  <MinimizedQuestionPill
                    onRestore={handleRestoreMinimizedQuestion}
                    onDismiss={handleDismissMinimizedQuestion}
                  />
                )}
                {hasPendingReview && (
                  <ApprovalPointerBar
                    blockingCount={blockingCount}
                    nonBlockingCount={nonBlockingCount}
                    onReview={handleOpenReviewDrawer}
                  />
                )}
                {hasHeldMessages && (
                  <ExternalContextIndicator
                    queueSize={externalContext?.queueSize ?? 0}
                    lastPreview={externalContext?.lastBufferedPreview}
                    sourceLabel={externalContextSourceLabel}
                  />
                )}
                {hasBrowserContext && (
                  <BrowserContextChip
                    url={externalContext?.tabContext?.url}
                    title={externalContext?.tabContext?.title}
                  />
                )}
                {hasDocumentContext && (
                  <OfficeContextChip
                    host={externalContext?.documentContext?.host}
                    title={externalContext?.documentContext?.title}
                  />
                )}
                {hasSlackContext && (
                  <SlackContextChip
                    channelName={slackContextMetadata?.channelName}
                    userName={slackContextMetadata?.userName}
                    userDisplayName={slackContextMetadata?.userDisplayName}
                    teamName={slackContextMetadata?.teamName}
                    permalink={slackContextMetadata?.permalink}
                  />
                )}
                {hasSlackContext && digestFilteredCount > 0 && (
                  <ContextFilteredIndicator
                    filteredCount={digestFilteredCount}
                    mode={inboundAuthorPolicyMode}
                  />
                )}
                {currentSessionQueue.length > 0 && (
                  <QueuedMessagesTray
                    messageQueue={currentSessionQueue}
                    currentSessionId={currentSessionId}
                    onRemove={actions.removeFromQueue}
                    onSendNow={actions.sendQueuedMessageNow}
                  />
                )}
              </>
            ) : undefined}
            composerOverride={pendingFooterBatch && pendingFooterBatch.batch.batchId !== minimizedQuestionBatchId ? (
              <UserQuestionCard
                key={pendingFooterBatch.batch.batchId}
                batch={pendingFooterBatch.batch}
                isAnswered={false}
                onSubmit={footerSubmitAnswers}
                onDismiss={footerDismissBatch}
                onMinimize={handleMinimizeQuestion}
                onUndoDismiss={footerUndoDismiss}
                isSubmitting={footerIsQuestionSubmitting}
                error={footerQuestionError}
                variant="footer"
              />
            ) : mcpBuildCardState?.phase === 'submitting' ? (
              <MCPBuildCard state={mcpBuildCardState} variant="footer" isOssBuild={isOssBuild} />
            ) : visibleMcpBuildQuestionBatch && visibleMcpBuildQuestionBatch.batchId !== minimizedQuestionBatchId ? (
              // Note: the `building` phase (implementing / testing) is no
              // longer rendered here. It now surfaces inside the
              // `ContextualProgressCard` Doing-right-now line via
              // `mcpBuildActivity`, giving the user one unified activity
              // anchor and sidestepping the old stuck-footer-card symptom
              // when the contribution record lingered in `testing`.
              //
              // 260424 bug fix: the `isBusy` gate lives in the
              // `visibleMcpBuildQuestionBatch` memo — see its comment.
              // The `submitting` overlay above stays unconditional — it
              // represents an in-flight submit the user already
              // initiated.
              <UserQuestionCard
                key={visibleMcpBuildQuestionBatch.batchId}
                batch={visibleMcpBuildQuestionBatch}
                isAnswered={false}
                onSubmit={handleMcpBuildQuestionSubmit}
                onDismiss={handleMcpBuildQuestionDismiss}
                onMinimize={handleMinimizeQuestion}
                onUndoDismiss={() => {}}
                isSubmitting={isMcpBuildFooterSubmitting}
                variant="footer"
                {...(mcpBuildCardState?.phase === 'submitted' ? {
                  headerIcon: <PartyPopper size={14} aria-hidden="true" />,
                  headerLabel: 'Connector submitted',
                  headerIconClassName: uqStyles.headerIconCelebrate,
                } : mcpBuildCardState?.phase === 'testing-error' ? {
                  headerIcon: <Sparkles size={14} aria-hidden="true" />,
                  headerLabel: `${formatConnectorDisplayName(mcpBuildCardState.connectorName)} connector`,
                } : {})}
              />
            ) : authRequiredFooterCard ? (
              <MCPAuthRequiredCard
                card={authRequiredFooterCard}
                variant="footer"
                onReconnect={startAuthReconnect}
                onCancel={cancelAuthReconnect}
              />
            ) : visibleConnectorSetupQuestionBatch && visibleConnectorSetupQuestionBatch.batchId !== minimizedQuestionBatchId ? (
              <UserQuestionCard
                key={visibleConnectorSetupQuestionBatch.batchId}
                batch={visibleConnectorSetupQuestionBatch}
                isAnswered={false}
                onSubmit={handleConnectorSetupQuestionSubmit}
                onDismiss={handleConnectorSetupQuestionDismiss}
                onMinimize={handleMinimizeQuestion}
                onUndoDismiss={() => {}}
                isSubmitting={false}
                variant="footer"
              />
            ) : undefined}
          />
        </DevProfiler>
          </>
        )}
      </div>
    </>
  );
});
