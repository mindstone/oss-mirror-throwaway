/**
 * Top-level renderer component. Coordinates cross-cutting UX flows (voice,
 * session, workspace, settings) so feature hooks stay focused and reusable
 * instead of duplicating state. Large by design — see `./AGENTS.md` for the
 * extraction rules before adding new logic here.
 *
 * @see docs/project/UI_OVERVIEW.md — primary UI architecture and layout
 * @see docs/project/UI_CONVERSATIONS.md — conversation-surface contracts
 * @see src/renderer/AGENTS.md — App.tsx boundaries and where new code goes
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useGlobalHotkey } from './hooks/useGlobalHotkey';

import { AppProvider, type AppContextValue, type ToastMessage as _ToastMessage } from './contexts';
import type { KeyboardEvent, MouseEvent as ReactMouseEvent, CSSProperties, ReactElement as _ReactElement } from 'react';

// Source label for analytics/tracking when a user navigates back to an existing conversation.
// Keep in sync with `SessionSurfaceActions.handleOpenHistorySession` source union in
// `./features/agent-session/components/SessionSurfaceContent.tsx`.
export type SessionResumeSource =
  | 'sidebar'
  | 'collapsed_tabs'
  | 'keyboard_shortcut'
  | 'homepage'
  | 'inbox'
  | 'rebel_link'
  | 'notification'
  | 'library'
  | 'meeting'
  | 'mcp'
  | 'task'
  | 'time_saved'
  | 'achievement'
  | 'atlas'
  | 'restore'
  | 'onboarding';

type SessionOpenOptions = {
  transition?: 'settled' | 'instant';
};
import { SquarePen, MessageSquare, Rocket, FolderOpen, Zap, Inbox, Settings, Search, Bell, BellRing, Home, Calendar, Pin as _Pin, Plug, Users, Target, ExternalLink } from 'lucide-react';
import { cn as _cn } from './lib/utils';
import { installAnimationPauseControls } from './animationPauseControls';
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter, IconButton, Tooltip, useToast } from './components/ui';
import { HelpMenu } from './components/HelpMenu';
import { ProgressIndicator } from './components/ProgressIndicator';
import { AchievementHub } from './components/AchievementHub';
import { MeetingStatusIndicator } from './components/MeetingStatusIndicator';
import { MeetingButton } from './components/MeetingButton';
import { PhysicalRecordingIndicator } from './components/PhysicalRecordingIndicator';
import { LocalRecordingConsentDialog } from './components/LocalRecordingConsentDialog';
import { TimeSavedModal } from './components/TimeSavedModal';
import { TimeSavedMilestoneChecker } from './components/TimeSavedMilestoneChecker';
import { StreakMilestoneChecker } from './components/StreakMilestoneChecker';
import { BadgeUnlockChecker } from './components/BadgeUnlockChecker';
import { TierUnlockChecker } from './components/TierUnlockChecker';
import { GraduationChecker, type GraduationData } from './components/GraduationChecker';
import { GraduationModal } from './components/GraduationModal';
import { SessionErrorNotice } from './components/SessionErrorNotice';

import { FirstWeekCelebrationChecker } from './components/FirstWeekCelebrationChecker';
import { useTheme } from './hooks/useTheme';
import { useVisualCustomization } from './hooks/useVisualCustomization';
import { useSubscriptionLifecycle } from './hooks/useSubscriptionLifecycle';
import { useCreditMeterToastWarnings } from './hooks/useCreditMeterToastWarnings';
import { useDebouncedOnlineStatus } from './hooks/useDebouncedOnlineStatus';

import { NotificationDrawer } from './features/inbox/components/NotificationDrawer';
import { ApprovalNudgeToast } from './features/inbox/components/ApprovalNudgeToast';
import { WhatsNewDialog } from './components/WhatsNewDialog';
import { ShortcutsDialog } from './components/ShortcutsDialog';
import { BugReportDialog } from './components/BugReportDialog';
import { DemoModeDialog } from './components/DemoModeDialog';

// paneStyles moved to SessionSurfaceContent

import type {
  AgentEvent,
  AutomationAdmissionBlock,
  BreadcrumbEntry,
  RendererLogPayload,
  AgentTurnMessage,
  AgentAttachmentPayload,
  AgentSession,
  AnyAttachmentPayload,
  InboxItem,
  TaskExecutionMode,
  ThemePreference,
  AppSettings,
  RendererSessionType
} from '@shared/types';
import { getActiveVoiceProfile } from '@shared/types';
import { hasCheckId, isHealthCheckId, type HealthCheckId } from '@shared/ipc/schemas/health';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { WriteFailureError } from '@shared/utils/documentIoErrorClassification';
import { getProviderKey } from '@shared/utils/providerKeys';
import { isLocalProvider } from '@shared/utils/voiceProviderUtils';
import { resolveModelSettings } from '@shared/utils/settingsUtils';
import { getApiKey, getOauthMigratedAt } from '@renderer/features/settings/utils/modelAuthAccessors';
import { PermissionStatusBanner, PermissionOnboardingDialog } from './PermissionComponents';
import { OfflineBanner } from './components/OfflineBanner';
import { OfflineIndicator } from './components/OfflineIndicator';
import { CloudSyncIndicator } from './components/CloudSyncIndicator';
import { MigrationReAuthChecklistNotice } from './features/migration/MigrationReAuthChecklist';
import { MigrationNoticeProvider } from './features/migration/MigrationNoticeContext';
import { useDemoMode } from './hooks/useDemoMode';
import { VersionOutdatedBanner } from './components/VersionOutdatedBanner';
import { DataReadOnlyBanner } from './components/DataReadOnlyBanner';
import { EmergencyStartupRecovery } from './components/EmergencyStartupRecovery';
import { ResumeConversationsModal } from './components/ResumeConversationsModal';
import { InterruptedSessionsModal } from './components/InterruptedSessionsModal';

import { TruncatedTextWithTooltip as _TruncatedTextWithTooltip } from './components/TruncatedTextWithTooltip';
import { SettingsSurface, useSettingsFeature, SettingsProvider } from './features/settings';
import { generateSetupPrompt, type SetupWithRebelParams } from './features/settings/utils/setupPromptGenerator';
import { resolveSendMessageOptions } from './utils/resolveSendMessageOptions';
import { writeFileOrFail } from './utils/libraryWrites';
import { showPathOpenFailureToast } from './utils/pathOpenFailure';
import { createId } from '@shared/utils/id';
import { getModelDisplayName, isThinkingModelUnavailableError } from '@shared/utils/modelNormalization';
import { CLAUDE_MENTION_MODELS } from '@shared/utils/claudeMentionModels';
import { getBuildChannelSuffix } from '@shared/utils/versionDisplay';
import { bareToolId } from '@shared/utils/trustedToolNormalization';
import { getConnectorSectionId } from '@shared/utils/connectorSectionIds';
import { getPrimaryMcpAppFallbackTextsFromEvents } from '@shared/utils/mcpAppFallbackText';
import {
  buildOssMcpEntryPointBuildPrompt,
  buildOssMcpEntryPointExtendPrompt,
  buildOssMcpEntryPointSharePrompt,
} from '@shared/utils/ossMcpChatIntent';
import { buildConnectorSetupKey } from '@shared/utils/connectorSetupSignal';
import { MentionProvider } from './contexts/MentionContext';
import { NavigationProvider, NavigateRefSync, type NavigationProviderDeps } from './contexts/NavigationContext';
import { resolveLink } from '@core/navigation';
import { rendererDesktopSpaceResolver } from './contexts/desktopSpaceResolverRenderer';
import { VisualCaptureOverlay } from './features/visual-verification/VisualCaptureOverlay';
import type { NavigationTarget, SettingsTabId } from '@shared/navigation/types';
import type { MigrationImportNotice } from '@shared/ipc/channels/migration';
import { formatNavigationUrl } from '@shared/navigation/urlParser';

import { type ConversationPaneHandle } from './features/agent-session/components/ConversationPane';
import {
  abandonSwitchTimingIfMatches,
  beginSwitchTiming,
} from './features/agent-session/dev/switchTimingProbe';
import { useMeetingStatus } from './hooks/useMeetingStatus';
import { InsightsDrawer } from './features/agent-session/components/InsightsDrawer';
import { UnifiedDocumentEditor, type UnifiedDocumentEditorHandle } from './features/document-editor';
import { EditorWithNavigatorLayout } from '@renderer/features/document-editor/components/EditorWithNavigatorLayout';
import { getNextEditorKioskLevel, type EditorKioskLevel } from './features/document-editor/hooks/useEditorKiosk';
import { resolveDocumentPreviewMountPath } from './features/document-editor/utils/resolveDocumentPreviewMountPath';
import { WorkSurface as _WorkSurface, useWorkSurfaceView } from './features/agent-session/work-surface';
import type { TurnStepContext as _TurnStepContext } from './features/agent-session/utils/turnStepContext';
import type { AgentSessionSidebarEntry } from './features/agent-session/types';
import { isActiveNavEntry } from './features/agent-session/utils/filterSessionList';
import { isBackgroundConversationSession } from '@shared/sessionKind';

import type { AgentSessionSummary } from '@shared/types';
import { useAgentSessionEngine } from './features/agent-session/hooks/useAgentSessionEngine';
import {
  buildDashboardSeedDraft,
  dashboardShareErrorCopy,
  parseDashboardSharePayload,
  redeemDashboardShareToken,
} from './features/agent-session/services/seedChatFromDashboard';
import { useConnectorStatusWatcher } from './features/agent-session/hooks/useConnectorStatusWatcher';
import { useInterruptedSessionResume } from './features/agent-session/hooks/useInterruptedSessionResume';
import { useNetworkReconnectResume } from './features/agent-session/hooks/useNetworkReconnectResume';
import { useReconcilePairStatusOnReopen } from './features/agent-session/hooks/useReconcilePairStatusOnReopen';
import { useTurnData } from './features/agent-session/hooks/useTurnData';
import { useToolApproval } from './features/agent-session/hooks/useToolApproval';
import { useMemoryApproval } from './features/agent-session/hooks/useMemoryApproval';
import { useStagedToolCalls } from './features/agent-session/hooks/useStagedToolCalls';
import { useMcpBuildCardState } from './features/agent-session/hooks/useMcpBuildCardState';
import { useMcpBuildSubmission } from './features/agent-session/hooks/useMcpBuildSubmission';
import { getEffectiveMcpBuildCardState } from './features/agent-session/hooks/getEffectiveMcpBuildCardState';
import { resolveContributionRelayEnabled } from '@shared/utils/contributionRelayFlag';
import { useMcpBuildRefreshErrorToast } from './features/agent-session/hooks/useMcpBuildRefreshErrorToast';
import { useExternalDeliveryFailedToast } from './features/agent-session/hooks/useExternalDeliveryFailedToast';
import { useSafetyPromptRulePersisted } from './features/agent-session/hooks/useSafetyPromptRulePersisted';
import { useBtsStructuredOutputBypassedToast } from './features/agent-session/hooks/useBtsStructuredOutputBypassedToast';
import {
  planManualSessionErrorRetry,
  SESSION_ERROR_RESOLUTION_RETRY_ACTIONS,
} from './features/agent-session/utils/sessionErrorResolutionRetry';
import { resolveChiefOfStaffReadmePath } from './features/agent-session/utils/chiefOfStaffReadmePath';
import {
  useConnectorSetupSuggestions,
  type ConnectorSetupCardInfo,
} from './features/agent-session/hooks/useConnectorSetupSuggestions';
import { useContributionNotifications } from './features/homepage/hooks/useContributionNotifications';

// AnnotationOrchestrator moved to SessionSurfaceContent
import { SessionSurfaceContent, type SessionSurfaceActions } from './features/agent-session/components/SessionSurfaceContent';
import { DiagnoseDialogManager, type DiagnoseDialogManagerRef } from './features/agent-session/components/DiagnoseDialogManager';
import { ManagedBillingErrorActions } from './features/agent-session/components/ManagedBillingErrorActions';
import { ShareConversationDialog, type ShareDialogResult } from './features/agent-session/components/ShareConversationDialog';
import { MeetingCompanionManager, type MeetingCompanionManagerRef, getMeetingKey } from './features/agent-session/components/MeetingCompanionManager';
import { SafeModeOrchestrator, type SafeModeOrchestratorRef } from './features/app-shell/components/SafeModeOrchestrator';
import { UpdateToastManager, type UpdateToastManagerRef } from './components/UpdateToastManager';

import { AgentSessionSidebar } from './features/agent-session/components/AgentSessionSidebar';
import { SessionDeleteDialog } from './features/agent-session/components/SessionDeleteDialog';
import { DraftDiscardDialog } from './features/agent-session/components/DraftDiscardDialog';
import { useShallow } from 'zustand/react/shallow';
import { useSessionStore, selectVisibleMessages, isMessageHidden, getSessionStoreState, subscribeToSessionStore } from './features/agent-session/store';
import { getCurrentSessionEvents, getCurrentSessionEventsForTurn, getCheapLeakCounters, getLeakDiagnostics, getToolArchiveDiagnostics, getLoadedSessionsPayloadDiagnostics, getSessionSummariesPayloadDiagnostics, getStateMapsByteDiagnostics } from './features/agent-session/store/sessionStore';
import { getImageDataUrlCacheStats } from './components/MessageMarkdown';
import { useFolderStore } from './features/agent-session/store/folderStore';
import { getCoachingCacheSize } from './features/agent-session/hooks/useSessionCoaching';
import { getEligibilityCacheSize } from './features/agent-session/hooks/useCommunityShare';
import { useAudioPlayback, useVoiceRecording, useVoiceModeAutoSpeak } from './features/voice';

import { useMessageQueue, isSummaryBusyForQueueGate, type QueueMode } from './features/agent-session/hooks/useMessageQueue';
import { useSessionDeleteDialog } from './features/agent-session/hooks/useSessionDeleteDialog';
import { useSessionRename } from './features/agent-session/hooks/useSessionRename';
import { InboxPanel } from './features/inbox/components/InboxPanel';
import { useInbox } from './features/inbox/hooks/useInbox';
import { buildActionToast } from './features/inbox/utils/buildActionToast';
import { filterInboxViewItems } from './features/inbox/utils/filterInboxViewItems';
import { usePendingApprovalCount } from './features/inbox/hooks/usePendingApprovals';
import { usePendingQuestionWaitingCount } from './features/inbox/hooks/usePendingQuestionWaiting';
import { useStagedFiles } from './features/inbox/hooks/useStagedFiles';
import { useSkillChangeNotificationCount, useSkillChangeNotifications } from './features/inbox/hooks/useSkillChangeNotifications';
import { ScratchpadModal } from './features/scratchpad';
import { useDialogStates } from './hooks/useDialogStates';
import { useDraftDiscardDialog } from './hooks/useDraftDiscardDialog';
import { usePinnedSessionNavigation } from './hooks/usePinnedSessionNavigation';
import { useEditShortcutHint } from './hooks/useEditShortcutHint';
import { useQuickCapture } from '@renderer/hooks/useQuickCapture';
import { resolveModelRoles } from '@renderer/hooks/useModelRoles';
import {
  createProfileConnectivity,
  getProfileConnectivityStateFromSettings,
} from '@shared/utils/connectivityHelpers';
import { useHealthStatusPolling, type DegradedCheck } from './hooks/useHealthStatusPolling';
import { useApiCooldownEvents } from './hooks/useApiCooldownEvents';
import { useUserActivityTracking } from './hooks/useUserActivityTracking';
import { useIpcListeners } from './hooks/useIpcListeners';
import { usePromptCacheWarming } from './hooks/usePromptCacheWarming';
import { useMenuCommands } from './hooks/useMenuCommands';
import { useAppKeyboardShortcuts } from './hooks/useAppKeyboardShortcuts';
import { useVoiceHotkeyListener } from './hooks/useVoiceHotkeyListener';
import { useInlineVoiceShortcut } from './hooks/useInlineVoiceShortcut';
import { TutorialsModal, useTutorialsModalStore } from './features/tutorials';
import { countEnabledUserAddedConnectors } from './features/homepage/utils/connectorCounts';

import { FindBar } from './components/FindBar';
import { useBrokenSpacesNotification } from './hooks/useBrokenSpacesNotification';
import { useLibraryChangedInvalidator } from './hooks/useLibraryChangedInvalidator';
import { useSubscribeToExternalContextQueue } from './hooks/useExternalContextQueue';
import { useFeatureGate } from './hooks/useFeatureGate';
import { useLibraryCreateActions } from './hooks/useLibraryCreateActions';
import { useSharedDriveHealthToasts } from './features/settings/hooks/useSharedDriveHealthToasts';
import { useConflictCleanupToast } from './features/settings/hooks/useConflictCleanupToast';
import { useDriveAwareSyncToast } from './features/settings/hooks/useDriveAwareSyncToast';
import { WorkspaceConflictDialog } from './features/cloud/WorkspaceConflictDialog';
import { useNewSessionActions } from './hooks/useNewSessionActions';
import { useFirstTimeTooltipEffects } from './hooks/useFirstTimeTooltipEffects';
import { useManagedTierModelChangeNotifier } from './hooks/useManagedTierModelChangeNotifier';
import { useAutomationsAppState } from './features/automations/hooks/useAutomationsAppState';
import { useAutomationProviderReadinessSummary } from './features/automations/hooks/useAutomationProviderReadinessSummary';
import { AutomationsPanel } from './features/automations/components/AutomationsPanel';
import { TeamPanel } from './features/operators/OperatorsPanel';
import { useOperatorRegistry } from './features/operators/hooks/useOperatorRegistry';
import { tracking } from './src/tracking';
import { analytics as _analytics } from './src/analytics';
import { bugReportStatusToastCopy } from './src/bugReportToastCopy';
import { readFlowPanelsState, type BuiltInFlowSurface, type FlowSurface, useFlowPanels } from './features/flow-panels/FlowPanelsProvider';
import { FlowPanelsShell, type FlowSurfaceConfig, type SurfaceTab } from './features/flow-panels/FlowPanelsShell';
import {
  acquireChromeModeOwner,
  releaseChromeModeOwner,
  resolveChromeMode,
  type ChromeMode,
  type ChromeModeOwner,
} from './features/flow-panels/chromeMode';
import { createPluginSurfaceId, isBuiltInSurface as _isBuiltInSurface, isPluginSurface, type PluginSurfaceId } from './features/plugins/types';
import { PluginSurface } from './features/plugins/components/PluginSurface';
import { initPluginModuleRegistry, updatePluginModule, exposePluginRegistrationApi, freezeModuleRegistries } from './features/plugins/runtime/pluginModuleRegistry';
import { compilePluginSource } from './features/plugins/compiler/pluginCompiler';
import { clearPluginCrashes, getPluginCrashes } from './features/plugins/runtime/pluginDiagnostics';
import {
  registerPlugin,
  unregisterPlugin,
  initializePluginPersistence,
  loadPersistedPlugins,
} from './features/plugins/manifest/pluginRegistry';
import type { PluginManifest } from './features/plugins/manifest/pluginManifest';
import { useRegisteredPlugins } from './features/plugins/hooks/useRegisteredPlugins';
import { startSharedSpacePluginsController, stopSharedSpacePluginsController } from './features/plugins/hooks/spacePluginsStartup';
import { createPluginApiModule } from './features/plugins/api/pluginApiFactory';
import { pluginEventBus } from './features/plugins/api/pluginEventBus';
import { diffSessionLifecycle } from './features/plugins/api/lifecycleDiff';
import { setPluginRoute, clearPluginRoute } from './features/plugins/api/pluginRouteStore';
import { HistoryFilterDropdown } from './features/agent-session/components/HistoryFilterDropdown';

import {
  EDITABLE_EXTENSIONS as _EDITABLE_EXTENSIONS,
  TURN_ID_FALLBACK,
  DEFAULT_VOICE_STATUS,
  MAX_BREADCRUMBS,
  LOG_SOURCE
} from './constants';

import { formatAcceleratorDisplay } from './utils/acceleratorUtils';
import {
  LibraryDrawer,
  type LibraryDrawerHandle
} from './features/library/components/LibraryDrawer';
import { WorkspaceFileNavigator } from '@renderer/features/library/components/WorkspaceFileNavigator';
import { QuickOpenDialog } from './features/library/components/QuickOpenDialog';
import { type SelectionContext } from './features/agent-session/components/TextSelectionMenu';
import { useLibraryIndex } from './features/library/hooks/useLibraryIndex';
import { useLibraryMentions, MAX_ATTACHMENT_COUNT as _MAX_ATTACHMENT_COUNT } from './features/library/hooks/useLibraryMentions';
import { useSkillImprovementToast } from './features/library/hooks/useSkillImprovementToast';
import { useConversationMentions, type UnifiedMentionResult, type FileMentionResult, type CommandMentionResult, type ModelMentionResult, type OperatorMentionResult, type MentionFilterType } from './features/mentions';
import { isSkillEntry, isSkillPath, isMemoryPath } from './utils/skillUtils';
import { normalizePath } from './utils/stringUtils';
import type { FlatFileEntry } from './utils/librarySearch';

import { OnboardingWizard } from './features/onboarding/OnboardingWizard';
import { OnboardingCoachOrchestrator, type OnboardingCoachOrchestratorRef } from './features/onboarding/OnboardingCoachOrchestrator';
import { hasCoachCompletionSignal } from './features/onboarding/utils/coachCompletionState';
import { WhatsNewWidget, type ChangelogHighlight, compareVersions } from './features/whats-new';
import { useNpsSurvey } from './features/nps/useNpsSurvey';
import { NpsSurveyDialog } from './features/nps/NpsSurveyDialog';
import { useSurvey, SurveyModal, ACTIONS_FEEDBACK_SURVEY } from './features/surveys';
import { useDesktopNotificationPrompt } from './hooks/useDesktopNotificationPrompt';
import { DesktopNotificationPrompt } from './features/settings/components/DesktopNotificationPrompt';
import { useNotificationClickNavigation } from './hooks/useNotificationClickNavigation';
import type { AutomationDefinition, ConnectorCatalogEntry as _ConnectorCatalogEntry, PersonalizedUseCase, SafeModeContext } from '@shared/types';
import { getRandomTip } from '@shared/data/tips';
import { EXPORT_SUCCESS, EXPORT_FAILED } from '@shared/data/brandCopy';
import {
  HUMANIZER_OWNED_KINDS,
  type AgentErrorResolutionAction,
  humanizeAgentError,
  resolveInboxCtaLabel,
  isSessionActive,
} from '@rebel/shared';
import {
  assessCouncilEligibility,
  COUNCIL_MANAGED_NO_BYOK_TOOLTIP,
  getCouncilProfiles,
  isCouncilReviewAvailable,
} from '@shared/utils/councilProfiles';
import { getManagedAllowListState } from '@shared/types/managedProvider';
import { useSessionHistoryView } from './features/agent-session/hooks/useSessionHistoryView';
import { useUnreadResponses } from './features/agent-session/hooks/useUnreadResponses';
import { selectNextSession } from './features/agent-session/utils/selectNextSession';
import { AGENT_ERROR_KIND_TO_SESSION_CATEGORY, buildAgentSessionErrorFingerprint, classifySessionError } from './features/agent-session/utils/classifySessionError';
import {
  clearReloadConversationSessionId,
  readReloadConversationSessionId,
  writeReloadConversationSessionId
} from './features/agent-session/utils/reloadConversationSession';
import { useSessionSearch } from './features/agent-session/hooks/useSessionSearch';
import { findSimilarConversations } from './utils/conversationSearch';
import { useConversationAutoScroll } from './features/agent-session/hooks/useConversationAutoScroll';
import { useCurrentSessionCoaching, updateCoachingState } from './features/agent-session/hooks/useSessionCoaching';
import { composeSharePost, openDiscourseShare, dismissShare, optOutSharing } from './features/agent-session/hooks/useCommunityShare';
// SessionCoachingCard moved to SessionSurfaceContent
import { usePermissionsOrchestrator } from './features/permissions/usePermissionsOrchestrator';
import { captureRendererException, recordRendererBreadcrumb } from './src/sentry';
import { addToRendererLogBuffer } from './src/rendererLogBuffer';
import {
  humanizeRoleResolutionFailure,
  parseRoleResolutionFailureFromRawError,
} from '@core/rebelCore/modelRoleResolver';
// InteractionStrip moved to SessionSurfaceContent
import { type ComposerHandle, type ComposerWithStateProps } from './features/composer/ComposerWithState';
import { CanvasInputSurface, type MindMapExport } from './features/canvas';
// QueuedMessagesTray moved to SessionSurfaceContent
import type { MentionedFileCandidate as _MentionedFileCandidate } from './features/composer/types';
import { resolveComposerSubmitMode } from './features/composer/utils/resolveComposerSubmitMode';
import { AuthGate } from './features/auth';
import { useTranscriptionMic } from './features/composer/hooks';
import { useDraftMigration } from './features/composer/hooks/useDraftPersistence';
import { useManagedDefaults } from './hooks/useManagedDefaults';
import { useIsOssBuild } from './hooks/useIsOssBuild';
import { useSubscriptionState } from './hooks/useSubscriptionState';
import { toComposerWireMarkdown } from './features/composer/utils/composerMarkdown';
import { DevProfiler } from './components/DevProfiler';
import { SessionSurface } from './features/flow-panels/components/SessionSurface';
import { BrandLogo } from './components/BrandLogo';
import { HomepageLoadingSkeleton } from './components/HomepageLoadingSkeleton';
// PinnedFavoritesTabs moved to SessionSurfaceContent
// Kept for potential future use:
// import { LandingPage } from './features/landing';
import { UseCasesPanel } from './features/usecases';
import { HomepagePanel } from './features/homepage/HomepagePanel';
import { FocusPanel } from './features/focus/FocusPanel';
import { useInactivityReturn } from './features/homepage/hooks/useInactivityReturn';
import { SurfaceErrorBoundary } from './features/app-shell';
import { detectSustainedHeapGrowth } from './utils/rendererLeakDetection';

// Initialize plugin module registry so compiled plugins can resolve react, @rebel/* imports
initPluginModuleRegistry();
exposePluginRegistrationApi(
  (manifest, source) => registerPlugin(manifest as PluginManifest, source),
  unregisterPlugin,
);



type NavigatorWithUA = Navigator & { userAgentData?: { platform?: string } };

const resolveShortcutModifier = (): '⌘' | 'Ctrl' => {
  if (typeof navigator === 'undefined') {
    return '⌘';
  }
  const platform = ((navigator as NavigatorWithUA).userAgentData?.platform ?? navigator.platform ?? '').toLowerCase();
  return /mac|darwin|iphone|ipad|ipod/.test(platform) ? '⌘' : 'Ctrl';
};

// Primary internal server to check for inbox connectivity (uses RebelInbox from the 7-MCP split architecture)
const REBEL_INBOX_SERVER_NAME = 'rebelinbox';

// Renderer memory leak detection: track heap snapshots over time (matches main process pattern)
const MAX_RENDERER_MEMORY_SAMPLES = 12; // 1 hour at 5-minute intervals
const rendererMemoryHistory: { timestamp: number; heapUsedMB: number }[] = [];
// Throttle state for the "Renderer memory leak suspected" WARN (≤1/30min, reset
// on a material heap drop). Detection math lives in the pure
// `detectSustainedHeapGrowth` helper — see src/renderer/utils/rendererLeakDetection.ts.
let rendererLeakWarnLastFiredAtMs: number | null = null;
let rendererLeakWarnLastFiredHeapMB: number | null = null;

// Extensions supported for inline document preview (module-scope to avoid per-render allocation)
const PREVIEW_SUPPORTED_TEXT = new Set(['md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'xml', 'csv', 'log']);
const PREVIEW_SUPPORTED_IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);
const PREVIEW_SUPPORTED_VIDEO = new Set(['mp4', 'webm', 'mov', 'm4v']);
const PREVIEW_SUPPORTED_AUDIO = new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac']);
const PREVIEW_SUPPORTED_HTML = new Set(['html', 'htm']);
const PREVIEW_SUPPORTED_PDF = new Set(['pdf']);
const LIBRARY_NAVIGATOR_DEFAULT_WIDTH_PERCENT = 50;
const LIBRARY_NAVIGATOR_FOCUS_WIDTH_PERCENT = 22;
const NOOP_EDITOR_LAYOUT_RESIZE_HANDLER = (_event: ReactMouseEvent): void => {};

/** Claude models available as @-mention subagent targets (always shown in Models tab).
 * @see src/shared/utils/claudeMentionModels.ts — single source of truth */
const CLAUDE_MENTION_ENTRIES = CLAUDE_MENTION_MODELS.map((m) => ({
  value: m.modelValue,
  label: m.label,
}));

type OperatorMentionSource = {
  id: string;
  operatorSlug: string;
  name: string;
};

const OPERATOR_TOKEN_REGEX = /@operator:([a-z0-9-]+)/g;

function escapeUserHintText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function appendOperatorMentionHints(prompt: string, operators: OperatorMentionSource[]): string {
  const bySlug = new Map(operators.map((operator) => [operator.operatorSlug, operator]));
  const hintedOperatorNames: string[] = [];
  const seenOperatorIds = new Set<string>();
  for (const match of prompt.matchAll(OPERATOR_TOKEN_REGEX)) {
    const slug = match[1];
    if (!slug) continue;
    const operator = bySlug.get(slug);
    if (!operator || seenOperatorIds.has(operator.id)) continue;
    seenOperatorIds.add(operator.id);
    hintedOperatorNames.push(operator.name);
  }
  if (hintedOperatorNames.length === 0) return prompt;
  const hints = hintedOperatorNames.map((operatorName) =>
    `<user_hint>The user mentioned the @${escapeUserHintText(operatorName)} Operator; consider asking it via rebel_operator__consult.</user_hint>`,
  );
  return `${prompt}\n\n${hints.join('\n')}`;
}

/** Provider billing/credits page URLs for direct links in error banners */
const PROVIDER_BILLING_URLS: Record<string, string> = {
  'OpenRouter': 'https://openrouter.ai/credits',
  'Anthropic': 'https://console.anthropic.com/settings/billing',
  'OpenAI': 'https://platform.openai.com/settings/organization/billing',
  'Google': 'https://aistudio.google.com/app/billing',
};

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Claude',
  codex: 'ChatGPT Pro',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
};

function formatResolutionModelLabel(model: string): string {
  return model
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.toUpperCase())
    .join('-');
}

// One-per-session suppression for voiceApiKeyValid health toast (REBEL-128)
let voiceKeyToasted = false;
const MIGRATION_IMPORT_ACTIVE_NOTICE_STORAGE_KEY = 'migration-import-active-notice';
const EMPTY_MIGRATION_REAUTH_CHECKLIST: MigrationImportNotice['reAuthChecklist'] = {
  providerKeys: [],
  connectors: [],
  cloudRepairRequired: false,
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parseMigrationReAuthChecklist(value: unknown): MigrationImportNotice['reAuthChecklist'] {
  if (
    value &&
    typeof value === 'object' &&
    isStringArray((value as { providerKeys?: unknown }).providerKeys) &&
    isStringArray((value as { connectors?: unknown }).connectors) &&
    typeof (value as { cloudRepairRequired?: unknown }).cloudRepairRequired === 'boolean'
  ) {
    const checklist = value as MigrationImportNotice['reAuthChecklist'];
    return {
      providerKeys: checklist.providerKeys,
      connectors: checklist.connectors,
      cloudRepairRequired: checklist.cloudRepairRequired,
    };
  }
  return EMPTY_MIGRATION_REAUTH_CHECKLIST;
}

function readStoredMigrationImportNotice(): MigrationImportNotice | null {
  try {
    const raw = localStorage.getItem(MIGRATION_IMPORT_ACTIVE_NOTICE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MigrationImportNotice>;
    if (typeof parsed.importId === 'string' && typeof parsed.adoptedAt === 'string') {
      return {
        importId: parsed.importId,
        adoptedAt: parsed.adoptedAt,
        reAuthChecklist: parseMigrationReAuthChecklist(parsed.reAuthChecklist),
      };
    }
  } catch {
    // Best-effort UI persistence only.
  }
  return null;
}

function storeMigrationImportNotice(notice: MigrationImportNotice): void {
  try {
    localStorage.setItem(MIGRATION_IMPORT_ACTIVE_NOTICE_STORAGE_KEY, JSON.stringify(notice));
  } catch {
    // Best-effort UI persistence only.
  }
}

function clearStoredMigrationImportNotice(): void {
  try {
    localStorage.removeItem(MIGRATION_IMPORT_ACTIVE_NOTICE_STORAGE_KEY);
  } catch {
    // Best-effort UI persistence only.
  }
}

const App = () => {
  // ═══════════════════════════════════════════════════════════════════════════════
  // SECTION: State Declarations
  // UI state, refs, and local component state. Feature-specific state lives in
  // dedicated hooks (useAgentSessionEngine, useSettingsFeature, etc.).
  // ═══════════════════════════════════════════════════════════════════════════════

  // Super-MCP ready state - tracks when tools are available for prompt cache warming
  const [superMcpReady, setSuperMcpReady] = useState(false);
  const [pendingSessionErrorAction, setPendingSessionErrorAction] = useState<
    AgentErrorResolutionAction['action'] | null
  >(null);
  // Safe Mode state - when enabled, Super-MCP is skipped for troubleshooting
  const [safeModeContext, setSafeModeContext] = useState<SafeModeContext>({ isEnabled: false });
  // Emergency recovery state - shown when settings fail to load (before normal recovery dialog can work)
  const [showEmergencyRecovery, setShowEmergencyRecovery] = useState(false);
  const emergencyRecoveryDismissedRef = useRef(false);
  // Ref for centralized navigation — synced by NavigateRefSync inside NavigationProvider
  const navigateRef = useRef<((target: NavigationTarget | string) => Promise<boolean>) | null>(null);
  const [loginOverlayVisible, setLoginOverlayVisible] = useState(false);
  const legacyErrorFallbackLoggedRef = useRef<Set<string>>(new Set());
  const pendingSessionErrorActionRef = useRef<AgentErrorResolutionAction['action'] | null>(null);
  // Refs for extracted orchestrators/managers
  const safeModeOrchestratorRef = useRef<SafeModeOrchestratorRef>(null);
  const diagnoseDialogManagerRef = useRef<DiagnoseDialogManagerRef>(null);
  const [sharingSessionId, setSharingSessionId] = useState<string | null>(null);
  const [sharingFilePath, setSharingFilePath] = useState<string | null>(null);
  const updateToastManagerRef = useRef<UpdateToastManagerRef>(null);
  // Dialog/modal visibility states (extracted to dedicated hook)
  const {
    quickOpenOpen,
    setQuickOpenOpen,
    whatsNewOpen,
    setWhatsNewOpen,
    shortcutsOpen,
    setShortcutsOpen,
    timeSavedModalOpen,
    setTimeSavedModalOpen,
    firstWeekCelebration,
    setFirstWeekCelebration,
    scratchpadOpen,
    setScratchpadOpen,
    localRecordingConsentOpen,
    setLocalRecordingConsentOpen,
    bugReportOpen,
    setBugReportOpen,
    bugReportDefaultFeedbackType,
    setBugReportDefaultFeedbackType,
    bugReportPrefill,
    setBugReportPrefill,
    demoModeDialogOpen,
    setDemoModeDialogOpen,
    achievementHubOpen,
    setAchievementHubOpen,
    graduationModalOpen,
    setGraduationModalOpen,
  } = useDialogStates();

  const [notificationScrollTarget, setNotificationScrollTarget] = useState<string | null>(null);
  const [workspaceConflictDialogOpen, setWorkspaceConflictDialogOpen] = useState(false);
  const [workspaceConflictPaths, setWorkspaceConflictPaths] = useState<string[]>([]);
  const openWorkspaceConflictDialog = useCallback(() => {
    setWorkspaceConflictDialogOpen(true);
  }, []);

  // Track which tab to show when AchievementHub opens
  const [achievementHubInitialTab, setAchievementHubInitialTab] = useState<'overview' | 'time' | 'badges' | 'journey'>('overview');
  
  // Callback to open AchievementHub to the Journey tab (used by TheSparkPanel)
  const openJourneyProgress = useCallback(() => {
    setAchievementHubInitialTab('journey');
    setAchievementHubOpen(true);
  }, [setAchievementHubOpen]);

  // Callback to open AchievementHub to the Time Saved tab (used by HomepagePanel pill)
  const openTimeSavedProgress = useCallback(() => {
    setAchievementHubInitialTab('time');
    setAchievementHubOpen(true);
  }, [setAchievementHubOpen]);

  const [downloadDiagnosticsDialogOpen, setDownloadDiagnosticsDialogOpen] = useState(false);
  const openDownloadDiagnosticsDialog = useCallback(() => {
    setDownloadDiagnosticsDialogOpen(true);
  }, []);

  // Canvas input surface state
  const [canvasOpen, setCanvasOpen] = useState(false);

  // Find-in-page bar (conversation / general find via Electron's findInPage)
  const [showFindBar, setShowFindBar] = useState(false);

  // Focus approval ID — set by NavigationContext when navigating to tasks with a specific approval
  const [_focusApprovalId, setFocusApprovalId] = useState<string | null>(null);

  // Tutorials modal - access via store (shared with HelpMenu)
  const openTutorials = useTutorialsModalStore((s) => s.open);
  const tutorialsModalOpen = useTutorialsModalStore((s) => s.isOpen);
  const tutorialsModalInitialVideo = useTutorialsModalStore((s) => s.initialVideo);
  const closeTutorials = useTutorialsModalStore((s) => s.close);
  const { activeSurface, setActiveSurface, flowHistoryOpen, setFlowHistoryOpen, toggleFlowHistoryOpen, collapseSidebarForLibraryEditor, restoreSidebarFromLibraryEditor, libraryEditorOpen, openInsightsDrawer, navigateToLibraryLens, openDocumentPreview, closeDocumentPreview, setDocumentPreviewOpener, documentPreviewOpen, documentPreviewPath, documentPreviewGeneration, approvalsDrawerOpen, openApprovalsDrawer, closeApprovalsDrawer, toggleApprovalsDrawer } = useFlowPanels();
  const activeSurfaceRef = useRef(activeSurface);
  activeSurfaceRef.current = activeSurface;
  const [chromeModeOwners, setChromeModeOwners] = useState<ReadonlySet<ChromeModeOwner>>(new Set());
  const requestChromeMode = useCallback((owner: ChromeModeOwner, mode: ChromeMode = 'reduced') => {
    setChromeModeOwners((prev) => acquireChromeModeOwner(prev, owner, mode));
  }, []);
  const releaseChromeMode = useCallback((owner: ChromeModeOwner) => {
    setChromeModeOwners((prev) => releaseChromeModeOwner(prev, owner));
  }, []);
  const chromeMode = useMemo<ChromeMode>(() => resolveChromeMode(chromeModeOwners), [chromeModeOwners]);

  // Kiosk/reduced chrome only applies while the Library editor is active.
  useEffect(() => {
    if (activeSurface === 'library' && libraryEditorOpen) return;
    releaseChromeMode('kiosk');
    releaseChromeMode('library');
  }, [activeSurface, libraryEditorOpen, releaseChromeMode]);

  // Ref + bridging for the UnifiedDocumentEditor in document preview
  const docPreviewEditorRef = useRef<UnifiedDocumentEditorHandle>(null);
  const pendingDocPreviewPathRef = useRef<string | null>(null);

  // Bridge FlowPanelsProvider committed-path → editor for the mount-time
  // pending-path case ONLY.
  //
  // Invariant (DI-4 / Stage 2 of `docs/plans/260501_di_4_flowpanels_abort_aware_preview.md`):
  // all mounted-preview commits flow through the FlowPanels gate
  // (`setDocumentPreviewOpener` registered below). Once the editor mounts
  // and registers the opener, the gate is the SINGLE commit channel —
  // FlowPanels won't commit `documentPreviewPath` until
  // `editor.openDocument()` resolves true. This effect therefore only
  // parks the path for the mount-time fallback path (no opener registered
  // yet → provider commits eagerly per AMD.6 → bridge effect parks the
  // committed path for the mount handler to pick up).
  useEffect(() => {
    if (!documentPreviewPath || !documentPreviewOpen) return;
    if (!docPreviewEditorRef.current) {
      pendingDocPreviewPathRef.current = documentPreviewPath;
    }
    // No-op when editor is mounted: the gate already committed via the
    // registered opener; documentPreviewGeneration changes here are just
    // re-renders, not new commit triggers.
  }, [documentPreviewPath, documentPreviewGeneration, documentPreviewOpen]);

  // Focus mode for document preview drawer mirrors the main editor cycle:
  // off → wide → zen → off.
  const [documentPreviewKioskLevel, setDocumentPreviewKioskLevel] =
    useState<EditorKioskLevel>('off');
  const cycleDocumentPreviewKioskLevel = useCallback(() => {
    setDocumentPreviewKioskLevel((previous) => getNextEditorKioskLevel(previous));
  }, []);
  const clearDocumentPreviewKioskLevel = useCallback(() => {
    setDocumentPreviewKioskLevel('off');
  }, []);

  // Reset focus mode when document preview is closed
  useEffect(() => {
    if (!documentPreviewOpen) {
      setDocumentPreviewKioskLevel('off');
    }
  }, [documentPreviewOpen]);
  
  const [userFirstName, setUserFirstName] = useState<string | null>(null);
  // Display name with fallback - used for UI greetings when no name is available
  const _displayUserName = userFirstName || 'friend';
  const [timeSavedBySession, setTimeSavedBySession] = useState<Record<string, number>>({});
  const [coachingSessionIds, setCoachingSessionIds] = useState<Set<string>>(new Set());
  const [graduationData, setGraduationData] = useState<GraduationData | null>(null);

  // Onboarding coach state - keeps replies in the coaching prompt and shows the inline intro card
  const [isOnboardingCoachActive, setIsOnboardingCoachActive] = useState(false);
  // Track whether to show manual continue button (Layer 2 fallback)
  const [showOnboardingManualContinue, setShowOnboardingManualContinue] = useState(false);
  const [onboardingCoachLaunchRequestId, setOnboardingCoachLaunchRequestId] = useState<number | undefined>(undefined);
  // Ref to OnboardingCoachOrchestrator for imperative callbacks
  const onboardingCoachRef = useRef<OnboardingCoachOrchestratorRef>(null);

  // Text mode state (kept in App for mode toggle UI)
  const [isTextMode, setIsTextMode] = useState(false);

  // Meeting companion session tracking (for creating companion on recording start).
  // Map is keyed by normalized meeting ID (getMeetingKey), NOT raw URLs.
  const meetingStatus = useMeetingStatus();
  // Single source of truth for offline status — debounced once here and passed
  // to both offline surfaces (header dot + sustained banner). See Stage 3 of
  // docs/plans/260618_arthur-offline-resilience/PLAN.md.
  const offlineStatus = useDebouncedOnlineStatus();
  const [companionSessionByMeetingUrl, setCompanionSessionByMeetingUrl] = useState<Record<string, string>>({});
  // Ref to MeetingCompanionManager for imperative dedup override callback
  const meetingCompanionRef = useRef<MeetingCompanionManagerRef>(null);

  // Trashed session selection - when set, shows "Restore to view" in conversation area
  const [selectedTrashedSessionId, setSelectedTrashedSessionId] = useState<string | null>(null);

  // Context menu for right-click in conversation whitespace
  // conversationContextMenu state moved to SessionSurfaceContent

  const [workspaceRecoveryDialog, setWorkspaceRecoveryDialog] = useState<{
    open: boolean;
    checking: boolean;
    path: string | null;
    code?: string;
    error?: string;
  }>({ open: false, checking: false, path: null });

  const handleUserMessageRef = useRef<((
    text: string,
    source?: 'text' | 'voice',
    attachments?: AgentAttachmentPayload[],
    options?: { editTargetMessageId?: string; targetSessionId?: string }
  ) => Promise<void>) | null>(null);
  // Ref to submitQueuedMessage (queue-aware) for routing approval continuations through the message queue
  const submitQueuedMessageRef = useRef<((
    text: string,
    source?: 'text' | 'voice',
    attachments?: AnyAttachmentPayload[],
    options?: { queueMode?: 'queue' | 'sendNow'; targetSessionId?: string; isSystemContinuation?: boolean; isHidden?: boolean; displayText?: string; messageOrigin?: import('@shared/types').AgentTurnMessage['messageOrigin'] }
  ) => Promise<void>) | null>(null);
  const stopRecordingRef = useRef<() => void>(() => {});
  const stopRecordingSafe = useCallback(() => {
    stopRecordingRef.current();
  }, []);
  const cancelRecordingRef = useRef<() => void>(() => {});
  const cancelRecordingSafe = useCallback(() => {
    cancelRecordingRef.current();
  }, []);
  const pendingTaskExecutionRef = useRef<{ taskId: string; sessionId: string; mode: TaskExecutionMode } | null>(null);
  const sessionSearchInputRef = useRef<HTMLInputElement | null>(null);
  const breadcrumbsRef = useRef<BreadcrumbEntry[]>([]);
  const libraryDrawerRef = useRef<LibraryDrawerHandle | null>(null);
  const composerRef = useRef<ComposerHandle | null>(null);
  /**
   * Per-session pending `onCommit` callbacks for document-annotation
   * sends. When the user clicks "Send to Rebel" from DocumentFooter,
   * the send handlers here stash the closure on this map keyed by
   * target session id. When the user then submits the composer via
   * `handleSubmitTextPrompt`, the handler drains ALL closures queued
   * for the submitting session, composes them into a single sequential
   * `onCommit` (each callback awaited here, BEFORE hand-off, so disk
   * flushes complete before the next runs), and passes the composed
   * closure to `submitQueuedMessage` as the `onCommit` option. The
   * queue itself does NOT await the composed callback — `invokeOnCommitSafely`
   * is fire-and-forget with rejection isolation (sync throws and
   * rejected promises are both caught and logged). It fires after
   * `processMessage` resolves successfully (see `useMessageQueue` Stage 2).
   *
   * ACCUMULATION (not overwrite): double-sending file A and then file B
   * to the same session before submitting must preserve BOTH callbacks
   * — otherwise the first file's staged IDs would never be cleared.
   * See matrix rows #8 and #9 in the planning doc:
   * `docs/plans/260417_centralize_annotations_and_fix_document_send_clear.md`.
   *
   * EXPLICIT DISCARD CLEANUP: when the user abandons the composer
   * (Discard dialog confirm, session deletion, draft cleared to empty,
   * etc.) the pending callbacks for that session are dropped via
   * `dropPendingDocumentAnnotationOnCommits` so subsequent unrelated
   * submits on that session don't silently clear annotations that the
   * user never actually sent.
   *
   * MESSAGE SNAPSHOT (FIX B from final heavy review): each entry
   * captures the exact annotation message that was inserted into the
   * composer at stage time. At submit time the drain filters entries
   * by `prompt.includes(entry.messageSnapshot)` — if the user has
   * edited the composer to remove the annotation block entirely, the
   * snapshot won't be present in the final prompt and the callback is
   * silently dropped rather than fired. This closes the hole where a
   * user could stage annotations, select-all-delete the prefilled
   * draft (but keep the composer non-empty by typing unrelated text),
   * send, and have the stale callback clear annotations they never
   * actually sent. Pure `includes` check — fast, no regex, no hashing.
   *
   * Ref-based (not store) because `onCommit` is a plain-function
   * closure — not serialisable, not meaningful to persist across
   * reloads, and not something other surfaces need to observe.
   */
  const pendingDocumentAnnotationOnCommitRef = useRef<
    Map<
      string,
      Array<{ messageSnapshot: string; fencedMessage?: string; onCommit: () => void | Promise<void> }>
    >
  >(new Map());
  const pendingVoiceSourceRef = useRef<boolean>(false); // Tracks if composer content came from voice transcription
  const lastUserSubmitAtRef = useRef<number>(0);
  const activeTurnIdRef = useRef<string | null>(null);
  const isTranscribingRef = useRef(false);
  const composerHasTextRef = useRef(false);
  const configurationCompleteHandlerRef = useRef<() => void>(() => {});
  const agentSessionLogRef = useRef<ConversationPaneHandle | null>(null);
  const lastCapturedErrorRef = useRef<string | null>(null);
  const autoFixCountRef = useRef<number>(0); // Circuit breaker: max 2 auto-fix attempts per session for preview error feedback

  const pendingLocalRecordingRef = useRef<string | null>(null); // Store meeting title for consent flow
  const pendingVoiceHotkeySessionRef = useRef<string | null>(null); // Stores the target session ID for deferred voice hotkey transcription start
  const pendingDoneAutoSwitchRef = useRef<{ sessionId: string; nextInListId: string | null } | null>(null); // Track done for auto-switch to next session
  const reloadRestoreAttemptedRef = useRef(false);
  const initialReloadSurfaceRef = useRef<FlowSurface | null>(
    typeof window === 'undefined' ? null : readFlowPanelsState().surface
  );
  // Set to true when an external event (desktop notification click, MCP-initiated
  // conversation start/send) has already decided which conversation to open. Used
  // to short-circuit the reload-restore effect below so it does not race against
  // the deliberate navigation and land on the wrong session.
  const startupConversationRestoreSuppressedRef = useRef(false);
  // Refs to break callback dependency chains - callbacks use ref.current to avoid recreation
  const sidebarEntriesRef = useRef<AgentSessionSidebarEntry[]>([]);
  const sessionSummariesRef = useRef<AgentSessionSummary[]>([]);
  const messagesRef = useRef<AgentTurnMessage[]>([]);
  const settingsRef = useRef<AppSettings | null>(null);
  const allowanceToastOpenSettingsRef = useRef<(() => void) | null>(null);
  const libraryIndexRef = useRef<FlatFileEntry[] | null>(null);
  const libraryIndexLoadedRef = useRef(false);
  const [composerHasText, setComposerHasText] = useState(false);
  const [oauthBannerDismissed, setOauthBannerDismissed] = useState(() => {
    try { return localStorage.getItem('oauth-deprecation-banner-dismissed') === 'true'; } catch { return false; }
  });
  const [migrationImportNotice, setMigrationImportNotice] = useState<MigrationImportNotice | null>(() => readStoredMigrationImportNotice());
  const migrationImportNoticeConsumedRef = useRef(false);

  // Focus helper for composer - used by multiple hooks/handlers
  const focusComposer = useCallback(() => {
    composerRef.current?.focus();
  }, []);

  // Draft discard dialog (extracted to dedicated hook)
  // Note: checkDraftBeforeAction is deprecated for session switching since drafts auto-persist.
  // Use checkAttachmentsBeforeAction for session switching (attachments aren't persisted with drafts).
  const {
    pendingDraftDiscard,
    checkDraftBeforeAction: _checkDraftBeforeAction,
    checkAttachmentsBeforeAction,
    handleConfirm: handleDraftDiscardConfirm,
    handleCancel: handleDraftDiscardCancel,
  } = useDraftDiscardDialog({ composerRef, focusComposer });
  
  // Health status for HelpMenu glow indicator
  // Ref indirection: showToast is declared later (line ordering), but the health check
  // has a 10s delay so the ref is always populated before the first callback fires.
  const healthDegradedHandlerRef = useRef<((checks: DegradedCheck[]) => void) | undefined>(undefined);
  const { healthStatus, healthIssueCount, mcpRuntimeHealthDegraded } = useHealthStatusPolling({
    onHealthDegraded: useCallback((checks: DegradedCheck[]) => {
      healthDegradedHandlerRef.current?.(checks);
    }, []),
  });

  // User engagement tracking for accurate analytics
  // Reports user activity (keydown, pointerdown, scroll) to main process
  useUserActivityTracking();
  useLibraryChangedInvalidator();

  // Migrate localStorage drafts to session store (one-time migration on startup)
  // This runs after a delay to ensure sessions have been loaded from persistence
  useDraftMigration();

  // One-time localStorage key migration (workspace → library rename)
  useEffect(() => {
    const migrations: [string, string][] = [
      ['workspace-recent-files', 'library-recent-files'],
      ['workspace-split-width', 'library-split-width'],
    ];
    for (const [oldKey, newKey] of migrations) {
      const oldValue = localStorage.getItem(oldKey);
      if (oldValue && !localStorage.getItem(newKey)) {
        localStorage.setItem(newKey, oldValue);
        localStorage.removeItem(oldKey);
      }
    }
  }, []);

  // Pause CSS animations when the app window is hidden/minimized OR visible-but-unfocused,
  // to cut idle CPU/GPU usage (FOX-3438). See installAnimationPauseControls for details.
  useEffect(() => {
    return installAnimationPauseControls();
  }, []);

  const recordBreadcrumb = useCallback((breadcrumb: BreadcrumbEntry) => {
    breadcrumbsRef.current = [...breadcrumbsRef.current.slice(-MAX_BREADCRUMBS + 1), breadcrumb];
  }, []);

  const emitLog = useCallback(
    (payload: Omit<RendererLogPayload, 'source' | 'breadcrumbs'> & { breadcrumbs?: BreadcrumbEntry[] }) => {
      // Only auto-include breadcrumbs for warn/error/fatal to avoid serialization overhead
      // But always include if caller explicitly provides breadcrumbs
      const shouldAutoIncludeBreadcrumbs = payload.level === 'warn' || payload.level === 'error' || payload.level === 'fatal';
      const breadcrumbs = payload.breadcrumbs !== undefined
        ? payload.breadcrumbs
        : shouldAutoIncludeBreadcrumbs
          ? breadcrumbsRef.current.slice(-MAX_BREADCRUMBS)
          : undefined;
      try {
        window.api.logEvent({
          ...payload,
          source: LOG_SOURCE,
          breadcrumbs
        });
      } catch {
        // Ignore logging bridge errors
      }
      // Stage 4 (Class B): feed the renderer-local recent-log ring so a renderer
      // Sentry capture can attach this context (redacted) — closes the "renderer
      // attaches no logs" gap. Best-effort; never throws into product code.
      try {
        addToRendererLogBuffer({
          timestamp: payload.timestamp ?? Date.now(),
          level: payload.level,
          message: payload.message,
          context: payload.context,
        });
      } catch (error) {
        ignoreBestEffortCleanup(error, {
          operation: 'App.emitLog.addToRendererLogBuffer',
          reason: 'Renderer log-ring population is best-effort observability; it must never crash the renderer',
        });
      }
      if (payload.level === 'warn' || payload.level === 'error' || payload.level === 'fatal') {
        try {
          recordRendererBreadcrumb({
            category: 'renderer.log',
            level:
              payload.level === 'warn'
                ? 'warning'
                : payload.level === 'fatal'
                  ? 'fatal'
                  : 'error',
            message: payload.message,
            data: payload.context
          });
        } catch (error) {
          ignoreBestEffortCleanup(error, {
            operation: 'App.recordRendererBreadcrumb',
            reason: 'Telemetry sink failure must not propagate to product code; breadcrumb is best-effort observability',
          });
        }
      }
    },
    []
  );

  // Toast system (via ToastProvider in main.tsx)
  const { showToast } = useToast();
  useSafetyPromptRulePersisted();
  useBtsStructuredOutputBypassedToast();

  // Cross-cutting subscription lifecycle: surfaces user-visible toasts when the
  // Mindstone subscription transitions between active/past_due/canceled. Does NOT
  // silently switch providers — the user is prompted to act in Settings.
  useSubscriptionLifecycle(showToast);
  const isOssBuild = useIsOssBuild();
  const { managedProvider: allowanceManagedProvider } = useManagedDefaults();
  const { subscription: allowanceSubscription } = useSubscriptionState();
  const openSettingsFromAllowanceToast = useCallback(() => {
    allowanceToastOpenSettingsRef.current?.();
  }, []);
  useCreditMeterToastWarnings({
    managedProvider: allowanceManagedProvider,
    subscription: allowanceSubscription,
    showToast,
    openSettings: openSettingsFromAllowanceToast,
  });

  // Cloud update status listener (app-level so it works even when Settings is closed)
  useEffect(() => {
    const unsub = window.cloudApi?.onCloudUpdateStatus?.((data) => {
      if (data.status === 'updated') {
        showToast({ title: 'Cloud updated', description: data.message || 'Your cloud instance has been updated.', variant: 'default', duration: 8000 });
      } else if (data.status === 'error') {
        showToast({ title: 'Cloud update failed', description: data.message || 'A background update encountered an error.', variant: 'error', duration: 10000 });
      }
    });
    return () => unsub?.();
  }, [showToast]);

  // Bug report status listener — background bug report completion toasts.
  // Copy decision (incl. truthful disabled-reason branches) lives in the pure
  // helper so it stays regression-testable.
  useEffect(() => {
    const unsub = window.bugReportApi?.onBugReportStatus?.((data) => {
      const toast = bugReportStatusToastCopy(data);
      if (!toast) return;
      const { action, ...toastProps } = toast;
      if (action === 'copy-report') {
        // Wire the environment-independent recovery affordances. The pure copy
        // module names the affordance; the report text arrives on the payload
        // (the dialog has already reset by toast time). Primary action copies
        // the user's report to the clipboard (can't fail like the network did);
        // the secondary opens the Rebels community.
        const reportText = data.reportText;
        showToast({
          ...toastProps,
          ...(reportText
            ? {
                action: {
                  label: 'Copy report',
                  onClick: () => {
                    fireAndForget(navigator.clipboard?.writeText(reportText), 'copyBugReportToClipboard');
                  },
                },
              }
            : {}),
          cancel: {
            label: 'Open community',
            onClick: () => {
              window.appApi?.openUrl('https://rebels.mindstone.com/c/feature-requests/7');
            },
          },
        });
        return;
      }
      showToast(toastProps);
    });
    return () => unsub?.();
  }, [showToast]);

  // ═══════════════════════════════════════════════════════════════════════════════
  // SECTION: Core Feature Hooks
  // Main business logic hooks. These orchestrate agent sessions, settings,
  // permissions, voice, workspace, and other major features.
  // ═══════════════════════════════════════════════════════════════════════════════
  const {
    messages,
    eventsByTurn,
    activeTurnId,
    focusedTurnId,
    currentSessionId,
    currentSessionTitle,
    currentSessionDoneAt,
    currentSessionStarredAt,
    currentSessionOrigin,
    error,
    lastErrorSource,
    isBusy,
    isStopping,
    currentRuntime,
    currentSessionResolvedAt,
    showConversation,
    setShowConversation,
    setAgentError,
    handleVoiceRunFailure,
    handleUserMessage,
    editingMessageId,
    beginEditLastUserMessage,
    beginEditMessage,
    cancelEditMessage,
    rerunEditedMessage,
    stopActiveTurn,
    resetSessionState,
    openHistorySession,
    deleteHistorySession,
    togglePinSession,
    toggleStarSession,
    softDeleteSession,
    restoreSession,
    emptyTrash,
    renameSession,
    focusTurn,
    ingestExternalSessions,
    dismissCompaction,
    privateMode,
    setPrivateMode,
    councilMode,
    setCouncilMode,
    requestCouncilReview,
    autoDoneEnabled,
    setAutoDoneEnabled,
    finishLine,
    setFinishLine,
    getEngineLeakCounters,
  } = useAgentSessionEngine({ emitLog, recordBreadcrumb, showToast });

  const [isEditingFinishLine, setIsEditingFinishLine] = useState(false);
  const toggleEditFinishLine = useCallback(() => {
    setIsEditingFinishLine((v) => !v);
  }, []);

  const configureWithRebelRetryRef = useRef<
    (params: SetupWithRebelParams) => Promise<void>
  >(async () => {
    throw new Error('Configure with Rebel handler not ready');
  });
  const retryBundledAppBridgeInstall = useCallback(() => {
    return configureWithRebelRetryRef.current({
      serverName: 'Rebel Browser',
      isNewConnection: false,
      catalogEntry: {
        id: 'bundled-app-bridge',
        name: 'Rebel Browser',
        description: 'Browser extension',
        category: 'productivity',
        icon: 'globe',
        provider: 'bundled',
        bundledConfig: {
          authType: 'none',
          serverName: 'RebelAppBridge',
          setupToolName: 'rebel_bridge_prepare_install',
        },
      },
    });
  }, []);
  useConnectorStatusWatcher({
    retryConfigureWithRebel: retryBundledAppBridgeInstall,
    showToast,
    emitLog,
  });
  useReconcilePairStatusOnReopen({
    retryConfigureWithRebel: retryBundledAppBridgeInstall,
    showToast,
    emitLog,
  });

  // Canonical user-facing conversation navigation helper.
  //
  // User-facing conversation opens (sidebar click, deep link, inbox, task toast,
  // meeting companion, etc.) MUST go through this helper (or `executeOpenHistorySession`
  // /`handleOpenHistorySession` further below). The helper enforces the scroll-settling
  // contract (`markPendingHistoryScroll` + pane-hide + scroll-to-latest) before opening.
  // Bypassing it leaves the reused `ConversationPane` at its previous scroll position —
  // typically `scrollTop = 0` after virtualizer count change — causing the "thread
  // scrolled back to top" bug (diagnosed in
  // docs-private/investigations/260416_thread_scroll_jumps_to_top_on_switch.md).
  //
  // Backed by a ref so early-in-file callbacks can reference it even though the
  // full `executeOpenHistorySession` implementation is declared later (it depends
  // on `markPendingHistoryScroll` from `useConversationAutoScroll`, which itself
  // is destructured further down). The ref is assigned in-place during render
  // right after `executeOpenHistorySession` is defined.
  const executeOpenHistorySessionRef = useRef<
    ((sessionId: string, source?: SessionResumeSource, options?: SessionOpenOptions) => Promise<boolean>) | null
  >(null);
  const openHistoryNavigationSeqRef = useRef(0);
  const currentSessionSetupContext = useSessionStore((s) => s.currentSessionSetupContext);
  const readInstallSetupContext = useCallback(
    async (sessionId: string): Promise<AgentSession['setupContext'] | null | undefined> => {
      if (sessionId === currentSessionId) {
        return currentSessionSetupContext;
      }

      const state = getSessionStoreState();
      const loadedSession = state.loadedSessions.get(sessionId);
      if (loadedSession) {
        return loadedSession.setupContext;
      }

      const persistedSession = await window.sessionsApi.get({ id: sessionId });
      return persistedSession?.setupContext;
    },
    [currentSessionId, currentSessionSetupContext]
  );
  const endPairSessionForSetupContext = useCallback(
    async (
      sessionId: string,
      sessionSetupContext: AgentSession['setupContext'] | null | undefined,
    ): Promise<void> => {
      if (
        sessionSetupContext?.kind !== 'bundled-app-bridge' ||
        !sessionSetupContext.pairSessionId
      ) {
        return;
      }

      let alreadyPaired = false;
      try {
        const status = await window.appBridgeApi.checkPairStatus({
          pairSessionId: sessionSetupContext.pairSessionId,
        });
        alreadyPaired = status.paired.length > 0;
      } catch {
        // Best-effort guard only — fall through to endPairSession cleanup.
      }

      if (alreadyPaired) {
        if (sessionId === currentSessionId) {
          getSessionStoreState().setSetupContext(null);
        }
        return;
      }

      try {
        await window.appBridgeApi.endPairSession({
          pairSessionId: sessionSetupContext.pairSessionId,
        });
        if (sessionId === currentSessionId) {
          getSessionStoreState().setSetupContext(null);
        }
      } catch (err) {
        emitLog({
          level: 'warn',
          message: 'Failed to clean up app-bridge install context',
          context: {
            sessionId,
            pairSessionId: sessionSetupContext.pairSessionId,
            error: err instanceof Error ? err.message : String(err),
          },
          timestamp: Date.now(),
        });
        recordRendererBreadcrumb({
          category: 'app-bridge.install',
          level: 'warning',
          message: 'renderer.install-context-cleanup-failed',
          data: {
            sessionId,
            pairSessionId: sessionSetupContext.pairSessionId,
          },
        });
      }
    },
    [currentSessionId, emitLog]
  );
  const cleanupInstallContext = useCallback(
    async (sessionId: string): Promise<void> => {
      const sessionSetupContext = await readInstallSetupContext(sessionId);
      await endPairSessionForSetupContext(sessionId, sessionSetupContext);
    },
    [endPairSessionForSetupContext, readInstallSetupContext]
  );
  const navigateToConversation = useCallback(
    async (sessionId: string, source?: SessionResumeSource): Promise<boolean> => {
      if (sessionId !== currentSessionId) {
        await cleanupInstallContext(currentSessionId);
      }
      const fn = executeOpenHistorySessionRef.current;
      if (!fn) {
        // Observable fallback: the ref is populated during render, so callers
        // during the first render (before line ~4140) would hit this. In
        // practice no callsite does that, but if a future regression makes it
        // happen the user will experience "click did nothing" — so surface it
        // rather than failing silently. See AGENTS.md "Silent failure is a bug."
        recordBreadcrumb({
          type: 'navigation.not-ready',
          message: 'navigateToConversation invoked before executeOpenHistorySession ref populated',
          timestamp: Date.now(),
          data: { sessionId, source },
        });
        emitLog({
          level: 'warn',
          message: 'navigateToConversation: executeOpenHistorySessionRef not ready',
          context: { sessionId, source },
        });
        return false;
      }
      return fn(sessionId, source);
    },
    [cleanupInstallContext, currentSessionId, recordBreadcrumb, emitLog]
  );

  // Keep refs updated for stable callback access (breaks dependency chain)
  // Note: sessionSummaries ref is updated after useSessionStore call below (line ~585)
  messagesRef.current = messages;

  const flushComposerDraft = useCallback(() => {
    composerRef.current?.flushDraft();
  }, []);

  // Common "start fresh session + navigate" primitive (eliminates 10+ duplicated 4-line sequences)
  const { startFreshSession } = useNewSessionActions({
    resetSessionState,
    setActiveSurface: (s: string) => setActiveSurface(s as FlowSurface),
    setShowConversation,
    setIsTextMode,
    setFlowHistoryOpen,
    flushComposerDraft,
  });

  // Skill improvement toast (fires when a doctor session completes)
  useSkillImprovementToast({
    showToast,
    onTrySkill: (skillPath: string) => {
      const sessionId = startFreshSession({ showHistory: true });
      getSessionStoreState().setDraftForSession(sessionId, `@\`${skillPath}\` `);
    },
    onCompareWithLastUse: (skillPath: string, lastSessionId: string) => {
      fireAndForget((async () => {
        const oldSession = await window.sessionsApi.get({ id: lastSessionId });
        if (!oldSession) return;
        const firstUserMessage = oldSession.messages.find(m => m.role === 'user')?.text;
        if (!firstUserMessage) return;
        const truncated = firstUserMessage.length > 500 ? firstUserMessage.slice(0, 500) + '...' : firstUserMessage;
        const sessionId = startFreshSession({ showHistory: true });
        getSessionStoreState().setDraftForSession(
          sessionId,
          `@\`${skillPath}\` I just improved this skill. Last time I used it, I asked:\n\n> ${truncated}\n\nTry this same task again with the updated skill and tell me what you'd do differently now.`
        );
      })(), 'compareSkillWithLastUse');
    },
  });

  // Draft persistence is now handled internally by ComposerWithState

  // Stable callback for approval continuations — routes through the message queue
  // so approvals during an active turn are queued instead of colliding.
  // Uses ref bridge because useMessageQueue is declared after the approval hooks.
  // targetSessionId ensures the continuation reaches the originating session,
  // not whichever session happens to be active when the user clicks "Allow".
  // When receiptText is provided, the verbose user message is hidden and a compact
  // assistant-side receipt is injected (FOX-2782).
  const sendApprovalContinuation = useCallback((text: string, targetSessionId?: string, receiptText?: string) => {
    const shouldHide = Boolean(receiptText);
    if (submitQueuedMessageRef.current) {
      fireAndForget(submitQueuedMessageRef.current(text, 'text', undefined, { queueMode: 'queue', isSystemContinuation: true, targetSessionId, isHidden: shouldHide }), 'sendApprovalContinuation');
    } else {
      fireAndForget(handleUserMessage(text, 'text', undefined, undefined, targetSessionId, { isSystemContinuation: true, isHidden: shouldHide }), 'sendApprovalContinuationFallback');
    }
    if (receiptText) {
      const store = getSessionStoreState();
      const isCurrentSession = !targetSessionId || targetSessionId === store.currentSessionId;
      if (isCurrentSession) {
        store.addReceiptMessage(receiptText);
      }
    }
  }, [handleUserMessage]);

  // Tool safety approval state - non-blocking design with deny + retry
  const { deniedOperations, approveAndRetry, dismiss, approveAllAndRetry, dismissAll } = 
    useToolApproval(currentSessionId, sendApprovalContinuation);

  // Staged tool calls - non-blocking staging pattern (MCP side-effect tools)
  const { 
    stagedCalls: stagedToolCalls, 
    execute: executeStagedTool, 
    executeAll: executeAllStagedTools, 
    reject: rejectStagedTool, 
    rejectAll: rejectAllStagedTools, 
    isExecuting: isExecutingStagedTools 
  } = useStagedToolCalls(currentSessionId, sendApprovalContinuation);

  // Memory safety approval state for blocking flow (non-heredoc Bash writes - content is opaque, can't stage)
  // Most memory writes use staging (see memoryWriteHook.ts); non-heredoc Bash writes fall back to blocking approval
  const { 
    pendingRequests: memoryApprovalRequests, 
    allPendingSessionIds: memoryApprovalSessionIds, 
    save: saveMemory, 
    saveAll: saveAllMemory, 
    skip: skipMemory, 
    skipAll: skipAllMemory 
  } = useMemoryApproval(currentSessionId, sendApprovalContinuation);

  // Whether an annotation popover/editing is active (reported by AnnotationOrchestrator for hotkey guard)
  const [isAnnotationActive, setIsAnnotationActive] = useState(false);

  // Session coaching - reflection insights shown when returning to completed sessions
  const sessionCoaching = useCurrentSessionCoaching();

  // MCP Build Card — derive visual state from contribution store for current session
  const {
    cardState: mcpBuildCardState,
    // 260427 footer-question suppression follow-on: connector names of
    // every contribution linked to the current session, used below to
    // suppress the `suggest_connector_setup` footer card once a build is
    // already underway for the same connector.
    linkedConnectorNames: sessionLinkedConnectorNames,
    refreshStatus: refreshMcpBuildStatus,
    isRefreshing: isMcpBuildRefreshing,
    refreshError: mcpBuildRefreshError,
    refreshErrorReAuthRequired: mcpBuildRefreshErrorReAuthRequired,
    refetch: refetchMcpBuildCardState,
  } = useMcpBuildCardState(currentSessionId);

  // Surface refresh failures from the MCP build card so manual refresh
  // clicks don't look like no-ops when the relay or GitHub is unreachable.
  // Stage 1.1 of docs/plans/260420_oss_mcp_backend_relay.md — extracted to
  // a hook so the dedupe invariant + session-switch reset can be tested in
  // isolation from the App render tree.
  useMcpBuildRefreshErrorToast({
    sessionId: currentSessionId,
    refreshError: mcpBuildRefreshError,
    refreshErrorReAuthRequired: mcpBuildRefreshErrorReAuthRequired,
    showToast,
  });

  const shouldShowContributionNotifications =
    approvalsDrawerOpen || activeSurface === 'home' || activeSurface === 'tasks';

  // Contribution notifications — derives banner + drawer data from contribution store
  const { bannerProps: contributionBannerProps, drawerNotifications: contributionDrawerNotifications, dismissDrawer: dismissContributionDrawer } = useContributionNotifications(shouldShowContributionNotifications);

  // Track previous showConversation value for transition detection
  const prevShowConversationRef = useRef(showConversation);
  // Track previous activeSurface for transition detection
  const prevActiveSurfaceRef = useRef(activeSurface);

  // Auto-focus command input when transitioning from landing page to conversation.
  // This ensures the text input is ready for typing when the user first enters
  // the conversation view after the home/landing page.
  useEffect(() => {
    const wasHidden = !prevShowConversationRef.current;
    const isNowVisible = showConversation;
    prevShowConversationRef.current = showConversation;

    // Focus when transitioning from landing page (hidden) to conversation (visible)
    // and when on the sessions surface (conversation pane)
    if (wasHidden && isNowVisible && activeSurface === 'sessions') {
      setIsTextMode(true);
      composerRef.current?.focus();
    }
  }, [showConversation, activeSurface, setIsTextMode]);

  // Compaction overlay state
  const compactionState = useSessionStore((s) => s.compaction);
  // Compaction boundaries for visual continuity after context compaction
  const compactionBoundaries = useSessionStore((s) => s.compactionBoundaries);

  // Meeting companion metadata for meeting-linked sessions
  const currentSessionMeetingCompanion = useSessionStore((s) => s.currentSessionMeetingCompanion);
  
  // Lightweight session summaries for sidebar display (lazy loading support)
  const sessionSummaries = useSessionStore(useShallow((s) => s.sessionSummaries));
  // Update ref for stable callback access (defined at line ~339)
  sessionSummariesRef.current = sessionSummaries;

  // Load conversation folders on mount (sidebar folder organisation — FOX-2987)
  const loadFolders = useFolderStore((s) => s.loadFolders);
  useEffect(() => { fireAndForget(loadFolders(), 'loadFolders'); }, [loadFolders]);

  // Navigate to sessions surface when compaction starts (ensures overlay is visible)
  useEffect(() => {
    if (compactionState.phase !== 'idle') {
      setActiveSurface('sessions');
    }
  }, [compactionState.phase, setActiveSurface]);

  const [activeStepByTurn, setActiveStepByTurn] = useState<Record<string, number | null>>({});

  const handleSurfaceChange = useCallback(
    (surface: FlowSurface) => {
      if (surface === 'sessions' || surface === 'settings') {
        setShowConversation(true);
      }
    },
    [setShowConversation]
  );

  // Reset library to opening state when clicking Library tab while already on it
  const handleLibraryReset = useCallback(() => {
    libraryDrawerRef.current?.resetToOpeningState();
  }, []);

  // Wrapped setActiveSurface that includes side effects from handleSurfaceChange
  // Used by NavigationProvider so navigate() triggers the same side effects as UI clicks
  // Calls handleSurfaceChange directly to avoid duplicating side-effect logic
  const setActiveSurfaceWithSideEffects = useCallback(
    (surface: FlowSurface) => {
      setActiveSurface(surface);
      handleSurfaceChange(surface);
    },
    [setActiveSurface, handleSurfaceChange]
  );

  useEffect(() => {
    if (!error || typeof error !== 'string' || !error.trim()) {
      lastCapturedErrorRef.current = null;
      return;
    }
    const trimmedError = error.trim();
    if (lastCapturedErrorRef.current === trimmedError) {
      return;
    }
    lastCapturedErrorRef.current = trimmedError;

    const lowerError = trimmedError.toLowerCase();

    // Check the latest error event across all turns (activeTurnId is null after terminal errors).
    // Prefer structural metadata from the event itself; fall back to string matching for legacy events.
    const latestErrorEvent = (() => {
      let latest: Extract<AgentEvent, { type: 'error' }> | null = null;

      for (const events of Object.values(eventsByTurn)) {
        for (let i = events.length - 1; i >= 0; i--) {
          const candidate = events[i];
          if (candidate.type !== 'error') continue;
          if (!latest || candidate.timestamp > latest.timestamp) {
            latest = candidate;
          }
        }
      }

      return latest;
    })();

    // Only trust structural metadata if the event matches the current error string.
    // This prevents a stale event from a previous turn from misclassifying a newer error.
    const eventMatchesCurrent = latestErrorEvent?.error === trimmedError;
    const structuralKind = eventMatchesCurrent ? latestErrorEvent?.errorKind : undefined;
    const hasRateLimitMeta = eventMatchesCurrent ? Boolean(latestErrorEvent?.rateLimitMeta) : false;
    // rateLimitMeta overrides kind — some non-rate_limit kinds (e.g. auth during a Max block)
    // still carry rate-limit metadata the UI treats as the authoritative signal.
    // Otherwise, look up the structural kind in the exhaustive map (compile-time enforced via
    // `satisfies Record<AgentErrorKind, SessionErrorCategory>` in classifySessionError.ts).
    const structuralCategory = hasRateLimitMeta
      ? 'rate_limit' as const
      : structuralKind
        ? structuralKind in AGENT_ERROR_KIND_TO_SESSION_CATEGORY
          ? AGENT_ERROR_KIND_TO_SESSION_CATEGORY[
              structuralKind as keyof typeof AGENT_ERROR_KIND_TO_SESSION_CATEGORY
            ]
          : null
        : null;

    // Classify the error into a category for filtering and Sentry fingerprinting.
    // Prefer structural event classification when available; fall back to string matching.
    const errorCategory = structuralCategory ?? classifySessionError(lowerError);

    // User-actionable errors: track for analytics but don't send to Sentry
    if (errorCategory === 'billing') {
      tracking.chat.turnError({
        turnId: activeTurnId ?? 'unknown',
        sessionId: currentSessionId ?? 'unknown',
        errorType: 'billing_error',
        errorCode: 'user_billing_issue',
        isRetryable: false,
      });
      return;
    }

    if (errorCategory === 'rate_limit') {
      tracking.chat.turnError({
        turnId: activeTurnId ?? 'unknown',
        sessionId: currentSessionId ?? 'unknown',
        errorType: 'rate_limit_error',
        errorCode: 'user_rate_limited',
        isRetryable: true,
      });
      return;
    }

    // User-intentional actions are not errors — don't capture to Sentry
    if (errorCategory === 'user_action') {
      return;
    }

    if (lastErrorSource === 'main') {
      // Main process already captured this to Sentry with richer diagnostics — don't double-capture
      return;
    }

    try {
      const capturedError = new Error(trimmedError);
      capturedError.name = 'AgentSessionError';
      // Sentry fingerprint policy:
      // - errorCategory is the primary discriminator; existing well-grouped issues stay grouped.
      // - structuralKind (the AgentErrorKind enum value, when present) is added as a secondary
      //   discriminator. This splits historical catch-all issues like REBEL-T4 (which collapsed
      //   many distinct AgentErrorKinds into the same coarse 'api_error' bucket) into per-kind
      //   Sentry issues so triage can see the actual root cause without inspecting events.
      // - The 'unknown' branch is checked FIRST and preserves the existing 80-char message-prefix
      //   fallback — that bucket is polymorphic by design and benefits from message-level granularity.
      //   When `errorCategory === 'unknown'`, structuralKind is intentionally OMITTED from the
      //   fingerprint (to keep message-prefix grouping) but is still surfaced via `extra.structuralErrorKind`
      //   below — so triagers can see the kind without it forcing a different group.
      // - When structuralKind is absent (renderer-side string-classification path, legacy events),
      //   the original 2-tuple is preserved — no regression, no orphan singletons.
      // - Renderer-only. Main-process Sentry captures use stacktrace-based default grouping and are
      //   not affected; the renderer path is short-circuited above for `lastErrorSource === 'main'`.
      const fingerprint = buildAgentSessionErrorFingerprint({ errorCategory, structuralKind, lowerError });
      captureRendererException(capturedError, {
        extra: {
          sessionId: currentSessionId,
          activeTurnId,
          isBusy,
          isStopping,
          sessionCount: sessionSummaries.length,
          errorCategory,
          ...(structuralKind ? { structuralErrorKind: structuralKind } : {}),
        },
        fingerprint,
      });
    } catch (sentryError) {
      ignoreBestEffortCleanup(sentryError, {
        operation: 'App.captureRendererException',
        reason: 'Sentry capture failure must not propagate from a useEffect or it crashes the React tree; capture is best-effort observability',
      });
    }
  }, [error, lastErrorSource, eventsByTurn, currentSessionId, activeTurnId, isBusy, isStopping, sessionSummaries.length]);

  // Deprecated: tasks are a dedicated surface now; toggling handled by FlowPanelsShell

  const handleViewAutomationSession = useCallback(
    async (sessionId?: string | null) => {
      // 1. If no specific session, just go to sessions view
      if (!sessionId) {
        setShowConversation(true);
        setActiveSurface('sessions');
        return;
      }

      // 2. Delegate to canonical navigation helper — applies scroll-settling contract
      //    (markPendingHistoryScroll) and handles same-session / deleted-session cases.
      //    Shows toast on failure.
      const opened = await navigateToConversation(sessionId);
      if (!opened) {
        showToast({ title: 'Conversation transcript not available' });
      }
    },
    [navigateToConversation, setActiveSurface, setShowConversation, showToast]
  );

  const { isSpeaking, speakText, stopSpeech, playbackError, clearPlaybackError } = useAudioPlayback({ emitLog });

  // Inject sessionType: 'onboarding-coach' when user replies during coaching
  const handleUserMessageWithCoaching = useCallback(async (
    text: string,
    source: 'voice' | 'text' = 'text',
    attachments?: AnyAttachmentPayload[],
    existingMessageId?: string,
    targetSessionId?: string,
    options?: { isSystemContinuation?: boolean; modelOverride?: string; thinkingModelOverride?: string; doneAfterComplete?: boolean; unleashedMode?: boolean; sessionType?: RendererSessionType; bypassToolSafety?: boolean; isHidden?: boolean; displayText?: string; messageOrigin?: import('@shared/types').AgentTurnMessage['messageOrigin']; continuationContext?: import('@shared/types').AgentTurnRequest['continuationContext']; supersedePolicy?: import('@shared/types').AgentTurnRequest['supersedePolicy'] }
  ) => {
    const effectiveOptions = { ...options };
    const currentSettings = settingsRef.current;
    const coachSessionId = currentSettings?.onboardingSessionIds?.coach ?? currentSettings?.onboardingChecklist?.sessionIds?.[0];
    const targetIsCoachSession = Boolean(coachSessionId) && (targetSessionId ?? currentSessionId) === coachSessionId;
    if (isOnboardingCoachActive && targetIsCoachSession && !effectiveOptions.sessionType) {
      effectiveOptions.sessionType = 'onboarding-coach';
    }
    return handleUserMessage(
      text,
      source,
      attachments,
      existingMessageId,
      targetSessionId,
      effectiveOptions as Parameters<typeof handleUserMessage>[5],
    );
  }, [
    handleUserMessage,
    isOnboardingCoachActive,
    currentSessionId,
  ]);

  const stampUserSubmit = useCallback(() => {
    lastUserSubmitAtRef.current = Date.now();
  }, []);

  // Per-target busy probe for the message queue (Stage 1,
  // docs/plans/260610_queue-drain-cancels-turn): lets the queue hold messages
  // whose TARGET session is mid-turn even when the viewed session is idle.
  // Depends on `sessionSummaries` (not the ref) deliberately: a new summaries
  // array on a background session's terminal event gives the drain gate its
  // wake-up via the new callback identity. Stale-busy summaries are treated
  // as idle at read time (see isSummaryBusyForQueueGate).
  const isQueueTargetSessionBusy = useCallback(
    (sessionId: string) =>
      isSummaryBusyForQueueGate(sessionSummaries.find((s) => s.id === sessionId)),
    [sessionSummaries]
  );

  const {
    handleUserMessage: submitQueuedMessage,
    pendingInputSource,
    setPendingInputSource,
    messageQueue,
    clearQueueForSession,
    removeFromQueue,
    sendQueuedMessageNow
  } = useMessageQueue({
    isBusy,
    isStopping,
    activeTurnId,
    currentSessionId,
    isSessionBusy: isQueueTargetSessionBusy,
    stopActiveTurn,
    processMessage: handleUserMessageWithCoaching,
    rerunEditedMessage,
    emitLog,
    showToast,
    onUserSubmit: stampUserSubmit
  });

  // Filter queue to only show messages for current session in the UI
  const currentSessionQueue = useMemo(
    () => messageQueue.filter((m) => m.targetSessionId === currentSessionId),
    [messageQueue, currentSessionId]
  );
  const currentSessionQueueCount = currentSessionQueue.length;

  useEffect(() => {
    handleUserMessageRef.current = submitQueuedMessage;
    submitQueuedMessageRef.current = submitQueuedMessage;
  }, [submitQueuedMessage]);

  // Interrupted session recovery on startup
  // Shows a modal letting the user choose which interrupted sessions to resume.
  // Resuming preserves conversation history and re-submits with a recovery preamble.
  const clearInterruptedTurnData = useSessionStore((s) => s.clearInterruptedTurnData);
  // Pending recording tracking (prevents empty sessions from being discarded during voice recording)
  const markSessionHasPendingRecording = useSessionStore((s) => s.markSessionHasPendingRecording);
  const clearSessionPendingRecording = useSessionStore((s) => s.clearSessionPendingRecording);
  const memoryUpdateStatusByTurn = useSessionStore(useShallow((s) => s.memoryUpdateStatusByTurn));
  const interruptedSessionResume = useInterruptedSessionResume({
    sessionSummaries,
    navigateToSession: useCallback(async (sessionId: string) => {
      await navigateToConversation(sessionId);
    }, [navigateToConversation]),
    resumeTurn: useCallback(async (session, modifiedMessageText) => {
      // 1. Open the session (keeps all history including partial work)
      const opened = await navigateToConversation(session.id);
      if (!opened) {
        throw new Error('Failed to open session for resume');
      }

      // 2. Do NOT clear interrupted turn data — agent needs to see what was done.
      // The conversation history (partial responses, tool results) is preserved.

      // 3. Submit modified message (original + recovery preamble) as a new turn
      fireAndForget(submitQueuedMessage(modifiedMessageText, 'text', undefined, { targetSessionId: session.id }), 'interruptedSessionResume');
    }, [navigateToConversation, submitQueuedMessage]),
  });

  // Network reconnect auto-resume
  // When a turn fails due to transient network errors (ETIMEDOUT, ECONNREFUSED, etc.),
  // this hook manages resuming multiple pending turns via modal UI when connectivity returns.
  //
  // NOTE: Intentionally uses the raw engine `openHistorySession` rather than
  // `navigateToConversation`. The resume is a background/batch flow (iterates
  // multiple interrupted turns) where stealing UI focus / scroll / surface for
  // each target session would be WRONG — the user is not interacting with the
  // conversation at that moment.
  const flushPendingDraftBeforeSessionSwitch = useCallback(() => {
    composerRef.current?.flushDraft();
  }, []);
  const reconnectOpenHistorySession = useCallback(
    (sessionId: string) => {
      flushPendingDraftBeforeSessionSwitch();
      // eslint-disable-next-line no-restricted-syntax -- openHistorySession-justified: sanctioned reconnect bypass (PM 260416). Background/batch resume of interrupted turns must NOT steal scroll/focus, so it intentionally calls the raw engine rather than navigateToConversation (see NOTE above).
      fireAndForget(openHistorySession(sessionId), 'reconnectOpenHistorySession');
    },
    [flushPendingDraftBeforeSessionSwitch, openHistorySession],
  );

  const networkReconnectResume = useNetworkReconnectResume({
    showToast,
    submitQueuedMessage,
    clearInterruptedTurnData,
    openHistorySession: reconnectOpenHistorySession,
  });

  const settingsFeature = useSettingsFeature({
    emitLog,
    showToast,
    onError: setAgentError,
    onConfigurationComplete: () => configurationCompleteHandlerRef.current()
  });

  // Demo mode state - controls header styling and exit button
  const { isDemoMode, isExitingDemoMode, exitDemoMode } = useDemoMode();

  // Destructure commonly used values from settings feature
  const {
    settings,
    settingsOpen,
    activeTab: settingsActiveTab,
    mcpSummary,
    mcpSummaryLoading,
    mcpMutationPending,
    openSettingsDialog,
    closeSettingsDialog,
    saveSettings,
    saveSettingsWith,
    refreshMcpSummary,
    addRebelInternalServer,
    refreshSettings,
    requestPendingSpacesAction,
  } = settingsFeature;

  const { isFeatureEnabled } = useFeatureGate();
  const canCreateAdditionalSpaces = isFeatureEnabled('spaces:create-additional');

  const {
    operators: availableOperators,
    loading: operatorsLoading,
  } = useOperatorRegistry({
    coreDirectory: settings?.coreDirectory,
    roleFilter: 'operator',
  });
  const operatorsBySlug = useMemo(
    () => new Map(availableOperators.map((operator) => [operator.operatorSlug, operator])),
    [availableOperators],
  );

  // Keep settings ref updated for stable callback access
  settingsRef.current = settings;
  allowanceToastOpenSettingsRef.current = () => {
    fireAndForget(
      openSettingsDialog('account', 'subscription', { source: 'link', interactionType: 'programmatic' }),
      'openSettingsFromAllowanceToast',
    );
  };

  const [codexConnectedForProfiles, setCodexConnectedForProfiles] = useState(false);
  useEffect(() => {
    const refreshCodexStatus = () => {
      const statusPromise = window.codexApi?.status?.();
      if (!statusPromise) return;
      statusPromise.then((status) => setCodexConnectedForProfiles(status.connected)).catch(() => {});
    };

    refreshCodexStatus();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshCodexStatus();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  const profileConnectivity = useMemo(
    () => createProfileConnectivity(
      getProfileConnectivityStateFromSettings(settings, { codexConnected: codexConnectedForProfiles }),
    ),
    [codexConnectedForProfiles, settings],
  );

  const codexProviderRepairedAt = settings?.codexProviderRepairedAt;
  const activeProviderForRepairToast = settings?.activeProvider;
  useEffect(() => {
    if (!codexProviderRepairedAt || activeProviderForRepairToast !== 'codex') return;

    const storageKey = `codex-provider-repair-toast-shown:${codexProviderRepairedAt}`;
    try {
      if (localStorage.getItem(storageKey) === 'true') return;
      localStorage.setItem(storageKey, 'true');
    } catch {
      // Toast is best-effort; localStorage is only used to avoid repeat UI noise.
    }

    showToast({
      title: 'ChatGPT Pro is back in use.',
      description: 'Rebel refreshed your connection. New turns should show as covered by your subscription.',
      duration: 10000,
      action: {
        label: 'View usage',
        onClick: () => {
          fireAndForget(
            openSettingsDialog('usage', undefined, { source: 'link', interactionType: 'programmatic' }),
            'navigateToUsageAfterCodexRepair'
          );
        },
      },
    });
  }, [activeProviderForRepairToast, codexProviderRepairedAt, openSettingsDialog, showToast]);

  const { managedProvider: managedProviderConfig } = useManagedDefaults();
  const managedAllowListState = useMemo(
    () => getManagedAllowListState(managedProviderConfig),
    [managedProviderConfig],
  );
  const councilProfiles = useMemo(
    () => getCouncilProfiles(settings),
    [settings],
  );
  const councilEligibility = useMemo(
    () => assessCouncilEligibility(councilProfiles, settings ?? {}, managedAllowListState),
    [councilProfiles, managedAllowListState, settings],
  );
  const councilModeAvailable = useMemo(
    () => isCouncilReviewAvailable(settings, managedAllowListState),
    [managedAllowListState, settings],
  );
  const councilModeDisabledTooltip = useMemo(() => {
    if (settings?.activeProvider !== 'mindstone') return undefined;
    if (councilEligibility.kind !== 'blocked') return undefined;
    return COUNCIL_MANAGED_NO_BYOK_TOOLTIP;
  }, [councilEligibility, settings?.activeProvider]);

  // Auto-focus command input when returning to Conversation view from other surfaces
  // (e.g., Settings, Inbox, Library). This ensures immediate typing readiness.
  // Note: This effect must be after settingsOpen is destructured from settingsFeature.
  useEffect(() => {
    const wasOnOtherSurface = prevActiveSurfaceRef.current !== 'sessions';
    const isNowOnSessions = activeSurface === 'sessions';

    // Focus when transitioning TO sessions surface from any other surface.
    // Guard against settingsOpen: when navigating from Settings, activeSurface changes
    // to 'sessions' before settingsOpen becomes false. We defer the ref update until
    // settingsOpen is false so we don't "consume" the transition prematurely.
    if (isNowOnSessions && settingsOpen) {
      // Settings still closing - don't update ref, wait for next render
      return;
    }

    // Safe to update ref now (either not on sessions, or settings is closed)
    prevActiveSurfaceRef.current = activeSurface;

    if (wasOnOtherSurface && isNowOnSessions && showConversation) {
      composerRef.current?.focus();
    }
  }, [activeSurface, showConversation, settingsOpen]);

  // Staged files for memory safety - HIGH sensitivity writes staged for review
  // NOTE: Must be declared BEFORE prevPendingApprovalsRef which references currentSessionStagedFiles
  const {
    files: allStagedFiles,
    publish: publishStagedFile,
    discard: discardStagedFile,
    keepPrivate: keepStagedFilePrivate,
    publishAll: _publishAllStagedFiles,
    discardAll: _discardAllStagedFiles,
  } = useStagedFiles();
  
  // Filter staged files for current session (shown inline in conversation)
  const currentSessionStagedFiles = useMemo(
    () => allStagedFiles.filter(f => f.sessionId === currentSessionId),
    [allStagedFiles, currentSessionId]
  );

  // Auto-focus composer when approval bars clear (tool safety, memory approvals, staged files).
  // Uses reactive pattern: watches state arrays becoming empty rather than wrapping each callback.
  // Handles all resolution paths: inline approval, Inbox approval, IPC-based resolution.
  const prevPendingApprovalsRef = useRef({
    denied: deniedOperations.length,
    memory: memoryApprovalRequests.length,
    staged: currentSessionStagedFiles.length,
    sessionId: currentSessionId,
  });
  useEffect(() => {
    const prev = prevPendingApprovalsRef.current;
    // Don't focus on session switch (arrays clearing for navigation, not user action)
    if (prev.sessionId !== currentSessionId) {
      prevPendingApprovalsRef.current = {
        denied: deniedOperations.length,
        memory: memoryApprovalRequests.length,
        staged: currentSessionStagedFiles.length,
        sessionId: currentSessionId,
      };
      return;
    }

    const hadPending = prev.denied > 0 || prev.memory > 0 || prev.staged > 0;
    const nowEmpty =
      deniedOperations.length === 0 &&
      memoryApprovalRequests.length === 0 &&
      currentSessionStagedFiles.length === 0;

    // Update ref before potential focus
    prevPendingApprovalsRef.current = {
      denied: deniedOperations.length,
      memory: memoryApprovalRequests.length,
      staged: currentSessionStagedFiles.length,
      sessionId: currentSessionId,
    };

    // Focus composer when pending approvals fully clear (user finished reviewing)
    if (hadPending && nowEmpty && activeSurface === 'sessions') {
      requestAnimationFrame(() => focusComposer());
    }
  }, [
    deniedOperations.length,
    memoryApprovalRequests.length,
    currentSessionStagedFiles.length,
    currentSessionId,
    activeSurface,
    focusComposer,
  ]);

  const previousSettingsOpenRef = useRef(settingsOpen);
  const hasRequestedInitialMcpSummary = useRef(false);
  // C2 (Class A): guards the once-per-session "App Reached Interactive" signal.
  const hasReportedReachedInteractiveRef = useRef(false);

  // Theme management
  const handleThemeChange = useCallback(
    (newTheme: ThemePreference) => {
      fireAndForget(saveSettingsWith((draft) => ({ ...draft, theme: newTheme })), 'saveTheme');
    },
    [saveSettingsWith]
  );

  const { resolvedTheme } = useTheme(settings?.theme ?? 'dark', handleThemeChange);
  useVisualCustomization(settings, resolvedTheme);

  // Inbox layout mode management (grid vs list view)
  const handleInboxLayoutModeChange = useCallback(
    (mode: 'grid' | 'list') => {
      fireAndForget(saveSettingsWith((draft) => ({ ...draft, inboxLayoutMode: mode })), 'saveInboxLayoutMode');
    },
    [saveSettingsWith]
  );

  // Add tool to trusted list (from "Always allow" in approval UI)
  const handleTrustToolAlways = useCallback(
    (toolId: string, displayName: string) => {
      fireAndForget(saveSettingsWith((draft) => {
        const existing = draft.trustedTools ?? [];
        // Strip any legacy "packageId/" prefix before storing
        const canonical = bareToolId(toolId);
        // Don't add duplicates (compare using bare form)
        if (existing.some(t => bareToolId(t.toolId) === canonical)) {
          return draft;
        }
        return {
          ...draft,
          trustedTools: [
            ...existing,
            { toolId: canonical, displayName, addedAt: Date.now() }
          ]
        };
      }), 'trustToolAlways');
      showToast({
        title: `"${displayName}" added to trusted tools`,
        variant: 'success',
      });
    },
    [saveSettingsWith, showToast]
  );

  const appContextValue = useMemo<AppContextValue>(
    () => ({ emitLog, showToast, recordBreadcrumb, settings }),
    [emitLog, showToast, recordBreadcrumb, settings]
  );

  const {
    showPermissionOnboarding,
    openPermissionOnboarding,
    closePermissionOnboarding,
    showOnboardingWizard,
    handleConfigurationComplete,
    completeOnboardingFlow,
    handleRelaunchOnboarding
  } = usePermissionsOrchestrator({
    settings,
    saveSettingsWith,
    emitLog,
    showToast
  });

  useEffect(() => {
    if (migrationImportNoticeConsumedRef.current) return;
    if (showOnboardingWizard || !settings?.onboardingCompleted) return;
    migrationImportNoticeConsumedRef.current = true;

    fireAndForget((async () => {
      const response = await window.migrationApi.consumeImportNotice();
      if (response.notice) {
        storeMigrationImportNotice(response.notice);
        setMigrationImportNotice(response.notice);
      }
    })(), 'consumeMigrationImportNotice');
  }, [settings?.onboardingCompleted, showOnboardingWizard]);

  // Wire up health degradation notifications (ref populated after showToast is available).
  // Plain assignment — no useCallback needed since ref bypasses React's dependency tracking.
  healthDegradedHandlerRef.current = (checks: DegradedCheck[]) => {
    // Missing auth/config is expected while onboarding is still in progress.
    if (showOnboardingWizard || !settings?.onboardingCompleted) {
      return;
    }

    // Checks that are known transient or self-healing — downgrade from error to warning (REBEL-ZF/ZX/ZW/128)
    const TRANSIENT_HEALTH_CHECKS: ReadonlySet<HealthCheckId> = new Set([
      'embeddingServiceReady',
      'conflictingCopies',
      'calendarCacheHealth',
      'conversationIndexHealth',
      'enhancementHealth',
      'semanticIndexHealth',
      'toolIndexHealth',
      'workspaceAccessible',
    ]);
    // Check IDs arrive as `string` (DegradedCheck.id); narrow for the typed set
    // via the shared hasCheckId helper (same idiom as useHealthStatusPolling).
    const isTransientHealthCheck = (id: string): boolean =>
      hasCheckId(TRANSIENT_HEALTH_CHECKS, id);

    // Environmental conditions (the user's machine, not an app fault — e.g. a full
    // disk) surface as a calm WARNING toast, never an error/Sentry event — same
    // treatment as transient checks (REBEL — ENOSPC disk-full warning).
    const ENVIRONMENTAL_WARNING_CHECKS: ReadonlySet<HealthCheckId> = new Set([
      'diskSpace',
    ]);
    const surfaceAsWarning = (id: string): boolean =>
      isTransientHealthCheck(id) || hasCheckId(ENVIRONMENTAL_WARNING_CHECKS, id);

    const HEALTH_CHECK_TAB: Partial<Record<HealthCheckId, SettingsTabId>> = {
      calendarCacheHealth: 'tools',
      mcpConfigValid: 'tools',
      superMcpHealth: 'tools',
      bundledServers: 'tools',
      mcpSkippedServers: 'tools',
      claudeApiKeyValid: 'agents',
      voiceApiKeyValid: 'voice',
      authHealth: 'account',
      autoUpdateHealth: 'diagnostics',
      workspaceAccessible: 'spaces',
      oauthRefreshHealth: 'tools',
      apiCooldownHealth: 'diagnostics',
      mcpRuntimeHealth: 'tools',
    };

    const HEALTH_CHECK_SECTION: Partial<Record<string, string>> = {
      autoUpdateHealth: 'appUpdates',
      workspaceAccessible: 'coreDirectory',
      apiCooldownHealth: 'recentActivity',
    };

    const navigateToSettings = (tab: SettingsTabId, sectionId?: string) => {
      setActiveSurface('settings');
      fireAndForget(openSettingsDialog(tab, sectionId, { source: 'link', interactionType: 'programmatic' }), 'navigateToSettingsFromHealthCheck');
    };

    if (checks.length === 1) {
      const c = checks[0];

      // Suppress repeat voiceApiKeyValid toasts after the first one per session (REBEL-128)
      if (c.id === 'voiceApiKeyValid' && voiceKeyToasted) return;

      const tab = (isHealthCheckId(c.id) ? HEALTH_CHECK_TAB[c.id] : undefined) ?? 'tools';
      const connectorNames = Array.isArray(c.details?.connectorServerNames)
        ? (c.details.connectorServerNames as unknown[]).filter((n): n is string => typeof n === 'string')
        : [];
      const sectionFromCheck = HEALTH_CHECK_SECTION[c.id];
      const sectionId =
        sectionFromCheck ?? (connectorNames.length > 0 ? getConnectorSectionId(connectorNames[0]) : undefined);
      const label = c.id === 'mcpRuntimeHealth'
        ? 'Open Settings'
        : sectionId ? 'View Connector' : 'Open Settings';

      if (c.id === 'voiceApiKeyValid') voiceKeyToasted = true;

      // Downgrade transient + environmental checks from error to warning (REBEL-ZF/ZX/ZW; diskSpace)
      const variant = c.status === 'fail'
        ? (surfaceAsWarning(c.id) ? 'warning' : 'error')
        : 'warning';

      let toastTitle = `${c.name} needs attention`;
      if (c.id === 'oauthRefreshHealth') {
        const providerCount = Number(c.details?.providerCount) || 0;
        toastTitle = providerCount > 1
          ? 'Some connections need reconnecting'
          : c.message;
      } else if (c.id === 'mcpRuntimeHealth') {
        toastTitle = 'A connected tool needs attention';
      } else if (c.id === 'diskSpace') {
        toastTitle = c.status === 'fail' ? 'Your disk is nearly full' : 'Running low on disk space';
      }

      // Disk-full has no in-app fix, so no settings action — the description tells
      // the user to free up space.
      const toastAction = c.id === 'diskSpace'
        ? undefined
        : { label, onClick: () => navigateToSettings(tab, sectionId) };

      showToast({
        title: toastTitle,
        description: c.id === 'mcpRuntimeHealth' ? c.remediation : c.remediation || c.message,
        variant,
        duration: 10000,
        action: toastAction,
      });
    } else {
      // Only count non-transient, non-environmental failing checks as hard failures
      const hasFail = checks.some(c => c.status === 'fail' && !surfaceAsWarning(c.id));
      const tabs = new Set(
        checks
          .map(c => (isHealthCheckId(c.id) ? HEALTH_CHECK_TAB[c.id] : undefined))
          .filter((t): t is SettingsTabId => t !== undefined),
      );
      const tab: SettingsTabId = tabs.size === 1 ? [...tabs][0] : 'tools';
      showToast({
        title: `${checks.length} issues need attention`,
        description: checks.map(c => c.name).join(', '),
        variant: hasFail ? 'error' : 'warning',
        duration: 10000,
        action: { label: 'Open Settings', onClick: () => navigateToSettings(tab) },
      });
    }
  };

  const handleChooseNewWorkspace = useCallback(async () => {
    try {
      const chosenPath = await window.settingsApi.chooseDirectory();
      if (!chosenPath) return;

      setWorkspaceRecoveryDialog((prev) => ({ ...prev, checking: true }));
      const validation = await window.systemHealthApi.validateWorkspaceAccess({
        path: chosenPath,
        createIfMissing: true,
      });

      if (!validation.accessible) {
        setWorkspaceRecoveryDialog((prev) => ({
          ...prev,
          checking: false,
          open: true,
          path: chosenPath,
          code: validation.code,
          error: validation.error,
        }));
        showToast({ title: "Can't use that folder. Choose a different location." });
        return;
      }

      await saveSettingsWith((draft) => ({ ...draft, coreDirectory: chosenPath }));
      setWorkspaceRecoveryDialog({ open: false, checking: false, path: null });
      showToast({ title: 'Library folder updated' });
    } catch (error) {
      emitLog({
        level: 'error',
        message: 'Failed to update Library folder during recovery',
        context: { error: String(error) },
        timestamp: Date.now(),
      });
      setWorkspaceRecoveryDialog((prev) => ({ ...prev, checking: false, open: true }));
      showToast({ title: 'Failed to update Library folder' });
    }
  }, [emitLog, saveSettingsWith, showToast]);

  const handleRetryWorkspaceAccess = useCallback(async () => {
    try {
      const currentPath = settings?.coreDirectory;
      if (!currentPath) {
        setWorkspaceRecoveryDialog((prev) => ({ ...prev, open: true, checking: false, path: null }));
        return;
      }

      setWorkspaceRecoveryDialog((prev) => ({ ...prev, checking: true }));
      const validation = await window.systemHealthApi.validateWorkspaceAccess({
        path: currentPath,
        createIfMissing: false,
      });

      if (validation.accessible) {
        setWorkspaceRecoveryDialog({ open: false, checking: false, path: null });
        showToast({ title: 'Library folder is accessible again' });
        return;
      }

      setWorkspaceRecoveryDialog({
        open: true,
        checking: false,
        path: currentPath,
        code: validation.code,
        error: validation.error,
      });
      showToast({ title: "Still can't access your Library folder" });
    } catch (error) {
      emitLog({
        level: 'error',
        message: 'Failed to validate Library folder access during recovery',
        context: { error: String(error) },
        timestamp: Date.now(),
      });
      setWorkspaceRecoveryDialog((prev) => ({ ...prev, checking: false, open: true }));
      showToast({ title: "Couldn't check Library folder access" });
    }
  }, [emitLog, settings?.coreDirectory, showToast]);

  useEffect(() => {
    // Don't show while onboarding is active.
    if (showOnboardingWizard) return;
    // Don't show in safe mode (safe mode is meant to let users reach diagnostics/settings).
    if (safeModeContext.isEnabled) return;
    // Don't show in E2E mode - dialog blocks clicks and causes test flakiness.
    if (window.e2eApi?.isEnabled) return;
    if (!settings?.onboardingCompleted) return;

    if (!settings.coreDirectory) {
      setWorkspaceRecoveryDialog({
        open: true,
        checking: false,
        path: null,
        code: 'NO_WORKSPACE',
        error: 'Library folder not configured.',
      });
      return;
    }

    let cancelled = false;
    setWorkspaceRecoveryDialog((prev) => ({ ...prev, checking: true }));

    fireAndForget((async () => {
      try {
        const validation = await window.systemHealthApi.validateWorkspaceAccess({
          path: settings.coreDirectory ?? '',
          createIfMissing: false,
        });

        if (cancelled) return;

        if (validation.accessible) {
          setWorkspaceRecoveryDialog({ open: false, checking: false, path: null });
          return;
        }

        setWorkspaceRecoveryDialog({
          open: true,
          checking: false,
          path: settings.coreDirectory,
          code: validation.code,
          error: validation.error,
        });
      } catch (error) {
        if (cancelled) return;
        emitLog({
          level: 'error',
          message: 'Failed to validate Library folder access on startup',
          context: { error: String(error) },
          timestamp: Date.now(),
        });
        setWorkspaceRecoveryDialog((prev) => ({ ...prev, open: true, checking: false }));
      }
    })(), 'validateWorkspaceAccess');

    return () => {
      cancelled = true;
    };
  }, [emitLog, safeModeContext.isEnabled, settings?.coreDirectory, settings?.onboardingCompleted, showOnboardingWizard]);

  // NPS Survey feature
  const npsBlocked = showOnboardingWizard || showPermissionOnboarding;
  const {
    showNps,
    handleDismiss: handleNpsDismiss,
    handleSubmit: handleNpsSubmit
  } = useNpsSurvey({
    settings,
    saveSettingsWith,
    blocked: npsBlocked
  });

  // Track first Actions tab visit (for survey eligibility gating)
  useEffect(() => {
    if (activeSurface === 'tasks' && settings && !settings.actionsFirstVisitedAt) {
      fireAndForget(saveSettingsWith((draft) => ({
        ...draft,
        actionsFirstVisitedAt: draft.actionsFirstVisitedAt ?? Date.now(),
      })), 'saveActionsFirstVisitedAt');
    }
  }, [activeSurface, settings, saveSettingsWith]);

  // In-app survey (shown after onboarding + 5 days, only to users who've visited Actions)
  const hasVisitedActions = typeof settings?.actionsFirstVisitedAt === 'number';
  const surveyBlocked = showOnboardingWizard || showPermissionOnboarding || showNps || !hasVisitedActions;
  const {
    showSurvey,
    surveyConfig,
    handleDismiss: handleSurveyDismiss,
    handleComplete: handleSurveyComplete,
  } = useSurvey({
    surveyId: ACTIONS_FEEDBACK_SURVEY.id,
    config: ACTIONS_FEEDBACK_SURVEY,
    settings,
    saveSettingsWith,
    blocked: surveyBlocked,
  });

  // Desktop notification prompt (shown after a few days of use)
  const notificationPromptBlocked = showOnboardingWizard || showPermissionOnboarding || showNps || showSurvey;
  const {
    showPrompt: showNotificationPrompt,
    handleEnable: handleNotificationEnable,
    handleDismiss: handleNotificationPromptDismiss,
  } = useDesktopNotificationPrompt({
    settings,
    saveSettingsWith,
    blocked: notificationPromptBlocked,
  });
  const handleNotificationPromptOpenSettings = useCallback(() => {
    setActiveSurface('settings');
    fireAndForget(openSettingsDialog('account', 'notifications', { source: 'link', interactionType: 'programmatic' }), 'navigateToNotificationSettings');
  }, [setActiveSurface, openSettingsDialog]);

  // Auto-navigate to the homepage 5s after the coach finishes, so new
  // users discover the homepage rather than staying on the (now-complete) conversation.
  useEffect(() => {
    let redirectTimer: ReturnType<typeof setTimeout> | null = null;

    const handler = () => {
      redirectTimer = setTimeout(() => {
        if (activeSurfaceRef.current === 'sessions') {
          emitLog({ level: 'info', message: 'Onboarding: Auto-navigating to homepage 5s after coach completion', timestamp: Date.now() });
          setActiveSurface('home');
        }
      }, 5000);
    };
    window.addEventListener('onboarding-coach-complete', handler);
    return () => {
      window.removeEventListener('onboarding-coach-complete', handler);
      if (redirectTimer) clearTimeout(redirectTimer);
    };
  }, [setActiveSurface, emitLog]);

  const handleShowSettingsSurface = useCallback(() => {
    setShowConversation(true);
    setActiveSurface('settings');
  }, [setActiveSurface, setShowConversation]);

  const handleNavigateToVoiceSettings = useCallback(() => {
    setActiveSurface('settings');
    fireAndForget(openSettingsDialog('voice', undefined, { source: 'link', interactionType: 'programmatic' }), 'navigateToVoiceSettings');
  }, [setActiveSurface, openSettingsDialog]);

  const handleCloseSettingsSurface = useCallback(() => {
    closeSettingsDialog();
    setActiveSurface('sessions');
  }, [closeSettingsDialog, setActiveSurface]);

  const handleSaveSettingsSurface = useCallback(async () => {
    await saveSettings();
  }, [saveSettings]);

  const handleChatAboutSafetyRules = useCallback(() => {
    closeSettingsDialog();
    const sessionId = resetSessionState();
    setActiveSurface('sessions');
    setIsTextMode(true);
    setShowConversation(true);
    setFlowHistoryOpen(true);
    getSessionStoreState().setDraftForSession(
      sessionId,
      '@`rebel-system/skills/safety/chat-about-safety-rules/SKILL.md` I want to review my safety rules. '
    );
  }, [closeSettingsDialog, resetSessionState, setActiveSurface, setFlowHistoryOpen, setIsTextMode, setShowConversation]);

  // Check for broken spaces (notification now handled via system health check)
  useBrokenSpacesNotification({
    coreDirectory: settings?.coreDirectory,
  });

  // Shared drive health warnings (drive app not running / files online-only)
  useSharedDriveHealthToasts();
  useDriveAwareSyncToast();
  // REBEL-62A one-off conflict-copy cleanup — affected-only confirm toast.
  useConflictCleanupToast();

  // Stage 7 — mirror browser-extension intent broadcasts into the
  // per-session queue store so SessionSurfaceContent can render the
  // BrowserContextChip / ExternalContextIndicator above the composer.
  useSubscribeToExternalContextQueue();

  // Deliberately distinct from clearCoachCompletionState
  // (features/onboarding/utils/coachCompletionState.ts): this resets
  // tutorial-checklist progress only and preserves onboardingCompletedAt, so
  // the Home activation card stays suppressed for users who finished the coach.
  const handleResetOnboardingChecklist = useCallback(() => {
    emitLog({ level: 'info', message: 'Resetting onboarding checklist (fresh start)', timestamp: Date.now() });
    fireAndForget(saveSettingsWith((draft) => ({
      ...draft,
      onboardingChecklist: {
        ...draft.onboardingChecklist,
        step: 1,
        sessionIds: undefined,
        completedSteps: undefined  // Clear all completed steps for a true fresh start
      }
    })), 'resetOnboardingChecklist');
    showToast({ title: 'Onboarding checklist reset - all steps cleared' });
  }, [saveSettingsWith, emitLog, showToast]);

  // Determine if we're in the onboarding sequence (first-time user flow).
  // During onboarding, the main app UI doesn't need to be rendered - it would just
  // be hidden behind overlays anyway and wastes resources.
  //
  // IMPORTANT: When `settings` is still null (IPC round-trip in progress) we
  // deliberately return `false` here. The earlier behaviour — `!undefined === true`
  // for `!settings?.onboardingCompleted` — caused already-onboarded users to be
  // mis-classified as "in onboarding" during the brief settings-load window,
  // which drove the homepage loading skeleton to unmount and remount through
  // the fallback render branch (visible as a flash of the skeleton disappearing
  // and reappearing with a fresh tip). The `if (!settings)` early return in the
  // render handles the loading UI for that window on its own.
  const isInOnboardingSequence = useMemo(() => {
    if (!settings) return false;
    if (!settings.onboardingCompleted) return true;
    if (showOnboardingWizard) return true;
    return false;
  }, [settings, showOnboardingWizard]);

  // Defer main app rendering until the onboarding sequence completes. The 100ms
  // delay is ONLY used when we're actually exiting a visible onboarding overlay,
  // so its exit animation can start before the main app mounts on top of it.
  // It is intentionally NOT applied on cold starts of already-onboarded users —
  // there's no overlay to animate out, and applying the delay there is what
  // previously caused the fallback-skeleton branch to render for ~100ms and
  // flash a second skeleton instance at the user.
  const hasBeenInOnboardingRef = useRef(false);
  const [isAnimatingOnboardingExit, setIsAnimatingOnboardingExit] = useState(false);
  useEffect(() => {
    if (!settings) return;
    emitLog({ level: 'debug', message: 'Onboarding: isInOnboardingSequence changed', context: { isInOnboardingSequence, onboardingCompleted: settings.onboardingCompleted, showOnboardingWizard, hasBeenInOnboarding: hasBeenInOnboardingRef.current }, timestamp: Date.now() });
    if (isInOnboardingSequence) {
      hasBeenInOnboardingRef.current = true;
      setIsAnimatingOnboardingExit(false);
      return;
    }
    if (!hasBeenInOnboardingRef.current) {
      // Cold start of an already-onboarded user: no overlay to animate out.
      setIsAnimatingOnboardingExit(false);
      return;
    }
    emitLog({ level: 'debug', message: 'Onboarding: Onboarding sequence complete, will render main app in 100ms', timestamp: Date.now() });
    setIsAnimatingOnboardingExit(true);
    const timer = setTimeout(() => {
      emitLog({ level: 'info', message: 'Onboarding: Clearing onboarding exit animation flag', timestamp: Date.now() });
      setIsAnimatingOnboardingExit(false);
    }, 100);
    return () => clearTimeout(timer);
  }, [settings, isInOnboardingSequence, showOnboardingWizard, emitLog]);

  // Derived — never a state race. Once `settings` lands, the very next render
  // has the correct value for already-onboarded users, so the fallback-skeleton
  // branch below never has a chance to flash a second skeleton instance.
  const shouldRenderMainApp = !!settings && !isInOnboardingSequence && !isAnimatingOnboardingExit;

  // Pause aurora background animation when main app is showing.
  // The aurora is hidden behind the opaque app shell anyway; pausing saves CPU.
  // See app-shell.css for the CSS that responds to this attribute.
  useEffect(() => {
    document.body.dataset.showAurora = shouldRenderMainApp ? 'false' : 'true';
  }, [shouldRenderMainApp]);

  // Safety guard: force isOnboardingCoachActive=false when onboarding is complete.
  // This prevents the UI from staying stuck in coach mode if the orchestrator
  // unmounts (via onboardingCompletedAt) before clearing isOnboardingCoachActive.
  useEffect(() => {
    if (isOnboardingCoachActive && settings?.onboardingCompletedAt) {
      emitLog({ level: 'warn', message: 'Onboarding: Forcing isOnboardingCoachActive=false (onboardingCompletedAt already set)', timestamp: Date.now() });
      setIsOnboardingCoachActive(false);
    }
  }, [isOnboardingCoachActive, settings?.onboardingCompletedAt, emitLog]);

  // Go directly to chat when onboarding completes (skip landing page).
  // Initialize ref as undefined so the first load with onboardingCompleted=true
  // triggers the bootstrap (wasIncomplete=true). This first-render branch is
  // load-bearing for cold starts of already-onboarded users: without it, the
  // main shell can render into a half-initialized state (aurora-only blank
  // screen). The separate reload-restore effect below overrides to the
  // previously-visible conversation when appropriate. See
  // docs-private/investigations/260422_reload_restore_regression_learnings.md.
  const prevOnboardingCompletedRef = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    const wasIncomplete = prevOnboardingCompletedRef.current !== true;
    const isNowComplete = settings?.onboardingCompleted;
    prevOnboardingCompletedRef.current = isNowComplete;

    if (wasIncomplete && isNowComplete) {
      emitLog({ level: 'info', message: 'Onboarding: onboardingCompleted changed to true, showing chat directly', timestamp: Date.now() });
      
      // Default to text mode if voice is unavailable (no API key for cloud providers).
      // This prevents users from landing in voice mode with a disabled mic button
      // that tells them to "go to settings" - which is confusing UX after onboarding.
      // Note: local providers don't need an API key, so we don't force text mode for them.
      const voiceProvider = settings?.voice?.provider ?? 'openai-whisper';
      const hasVoiceKey = isLocalProvider(voiceProvider) ||
        (voiceProvider === 'openai-whisper' ? Boolean(settings?.voice?.openaiApiKey) : Boolean(settings?.voice?.elevenlabsApiKey));
      if (!hasVoiceKey) {
        emitLog({ level: 'info', message: 'Onboarding: Voice key missing, defaulting to text mode', context: { voiceProvider }, timestamp: Date.now() });
        setIsTextMode(true);
      }
      
      setShowConversation(true);

      // On an in-app renderer reload from Conversations, skip the Home override:
      // - `sessionStorage` only survives reloads (cleared on full quit), so a
      //   non-null reload sessionId uniquely identifies a reload vs cold start.
      // - `initialReloadSurfaceRef` captured the persisted surface before any
      //   startup effects mutated it.
      // Leaving `activeSurface` at its `FlowPanelsProvider` init value ('sessions')
      // avoids the Home → Conversation flash while the reload-restore effect
      // below hands off through `navigateToConversation(sessionId, 'restore')`.
      const hasReloadRestoreCandidate =
        initialReloadSurfaceRef.current === 'sessions' &&
        readReloadConversationSessionId() !== null;
      if (hasReloadRestoreCandidate) {
        emitLog({ level: 'info', message: 'Reload restore: deferring Home bootstrap to reload-restore effect', timestamp: Date.now() });
      } else {
        setActiveSurface('home');
      }
    }
  }, [settings?.onboardingCompleted, settings?.voice?.provider, settings?.voice?.openaiApiKey, settings?.voice?.elevenlabsApiKey, emitLog, setActiveSurface, setShowConversation]);

  useEffect(() => {
    let cancelled = false;
    tracking.setAccountContext({
      companyName: settings?.companyName ?? null,
      source: settings?.companyName ? 'settings.companyName' : null,
    });
    void window.authApi?.getConfig?.()
      .then((config) => {
        if (cancelled) return;
        const companyName = settings?.companyName ?? config?.companyDisplayName ?? null;
        tracking.setAccountContext({
          companyName,
          source: settings?.companyName
            ? 'settings.companyName'
            : (config?.companyDisplayName ? 'authConfig.companyDisplayName' : null),
          licenseTier: config?.licenseTier ?? null,
        });
      })
      .catch(() => {
        // Auth config is optional; settings-based attribution above is enough.
      });
    return () => {
      cancelled = true;
    };
  }, [settings?.companyName]);

  // Diagnostic logging for blank screen debugging - logs key render state on every change
  // Using 'info' level so it's captured even without diagnostics mode enabled
  useEffect(() => {
    emitLog({
      level: 'info',
      message: 'App render state changed',
      context: {
        hasSettings: !!settings,
        shouldRenderMainApp,
        showConversation,
        showOnboardingWizard,
        isInOnboardingSequence,
        onboardingCompleted: settings?.onboardingCompleted
      },
      timestamp: Date.now()
    });
  }, [settings, shouldRenderMainApp, showConversation, showOnboardingWizard, isInOnboardingSequence, emitLog]);

  // =============================================================================
  // Renderer Memory Diagnostics (every 5 minutes)
  // =============================================================================
  // Production: cheap counters + V8 heap snapshot only (no recursive payload
  // walks). Heavy byte-attribution lives behind `VITE_PERFORMANCE === 'true'`
  // (dev:perf) because the REBEL-5D5 investigation showed every payload bucket
  // reads ~0 KB even at multi-GB heap — the recursive walks were costing real
  // user CPU/heap-pressure every 5 minutes without yielding actionable signal.
  // See `docs-private/investigations/260506_renderer_memory_leak.md` and the tier
  // principle in `docs/project/APP_PERFORMANCE_AND_MEMORY.md`.
  // Look for "Renderer memory diagnostic" in logs when investigating leaks.
  useEffect(() => {
    const RENDERER_MEMORY_INTERVAL_MS = 5 * 60 * 1000;
    const isPerfMode = import.meta.env.VITE_PERFORMANCE === 'true';

    const logRendererMemory = () => {
      const diagStartedAt = performance.now();
      const state = getSessionStoreState();

      // Cheap counts — no payload walking. Iterates events for length sums
      // and the basic detail/text estimator only.
      let totalEventCount = 0;
      let maxEventsInTurn = 0;
      let turnCount = 0;
      let estimatedEventsByTurnKB = 0;
      const currentEvents = getCurrentSessionEvents();
      for (const turnId of Object.keys(currentEvents)) {
        const events = currentEvents[turnId];
        totalEventCount += events.length;
        if (events.length > maxEventsInTurn) {
          maxEventsInTurn = events.length;
        }
        turnCount++;
        for (const evt of events) {
          estimatedEventsByTurnKB += ('detail' in evt ? evt.detail.length : 0) + ('text' in evt ? evt.text.length : 0) + 200;
        }
      }
      estimatedEventsByTurnKB = Math.round(estimatedEventsByTurnKB / 1024);

      let loadedEventCount = 0;
      let loadedTurnCount = 0;
      let loadedMessageCount = 0;
      for (const session of state.loadedSessions.values()) {
        loadedMessageCount += session.messages?.length ?? 0;
        for (const events of Object.values(session.eventsByTurn ?? {})) {
          loadedEventCount += events.length;
          loadedTurnCount++;
        }
      }

      const cheapCounters = getCheapLeakCounters();
      const engineLeakCounters = getEngineLeakCounters();
      const imageCacheStats = getImageDataUrlCacheStats();

      // V8 heap metrics (Chromium-only, always available in Electron)
      const perfMemory = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit?: number } }).memory;
      const heapUsedMB = perfMemory ? Math.round(perfMemory.usedJSHeapSize / 1024 / 1024) : null;
      const heapTotalMB = perfMemory ? Math.round(perfMemory.totalJSHeapSize / 1024 / 1024) : null;
      const heapLimitMB = perfMemory?.jsHeapSizeLimit ? Math.round(perfMemory.jsHeapSizeLimit / 1024 / 1024) : null;

      // Capture the previous sample BEFORE pushing the new one so we can
      // emit cheap, free deltas (no new module state needed). On the first
      // tick of a session — and on any tick where `performance.memory` was
      // unavailable last time — these fields are null.
      const previousSample = rendererMemoryHistory.length > 0
        ? rendererMemoryHistory[rendererMemoryHistory.length - 1]
        : null;
      const sampleTimestamp = Date.now();
      const heapUsedDeltaMB = heapUsedMB !== null && previousSample
        ? heapUsedMB - previousSample.heapUsedMB
        : null;
      const sampleIntervalMs = previousSample
        ? sampleTimestamp - previousSample.timestamp
        : null;

      if (heapUsedMB !== null) {
        rendererMemoryHistory.push({ timestamp: sampleTimestamp, heapUsedMB });
        if (rendererMemoryHistory.length > MAX_RENDERER_MEMORY_SAMPLES) {
          rendererMemoryHistory.shift();
        }
      }

      emitLog({
        level: 'info',
        message: 'Renderer memory diagnostic',
        context: {
          // V8 heap (incl. limit so we can see how close we are to OOM)
          heapUsedMB,
          heapTotalMB,
          heapLimitMB,
          // Cheap deltas — derived from `rendererMemoryHistory` (no new
          // module state). `heapUsedDeltaMB` highlights tick-over-tick drift
          // before the 30 min leak threshold fires; `sampleIntervalMs`
          // detects timer stalls / background sleep / StrictMode double
          // mounts so growth rates can be trusted.
          heapUsedDeltaMB,
          sampleIntervalMs,
          // Current session state — cardinality only
          currentSessionId: state.currentSessionId,
          currentMessageCount: state.messages.length,
          currentTurnCount: turnCount,
          currentEventCount: totalEventCount,
          maxEventsInTurn,
          estimatedEventsByTurnKB,
          // Image data URL cache — cheap count + tracked byte estimate
          imageDataUrlCacheEntries: imageCacheStats.entries,
          imageDataUrlCacheKB: imageCacheStats.estimatedKB,
          imageDataUrlCacheEvictions: {
            rate5m: imageCacheStats.evictionRate5m,
            cumulative: imageCacheStats.evictionCount,
          },
          // Background buffers — cheap counts only (payload bytes are dev:perf)
          bgEventBufferSessions: cheapCounters.backgroundEventBuffersSessions,
          bgEventBufferTotal: cheapCounters.backgroundEventBuffersTotal,
          // Streaming state cardinality
          pendingThinkingDeltasKeys: cheapCounters.pendingThinkingDeltasKeys,
          // Uncounted engine refs (FOX-3518 within-session leak suspects).
          // pendingEventsRef queues full AgentEvent objects for turns whose
          // sessionId hasn't resolved yet (background/foreign turns). High
          // pendingEventsTurns or pendingEventsTotal while currentEventCount is
          // frozen confirms the leading hypothesis from the Decision Log.
          pendingEventsTurns: engineLeakCounters.pendingEventsTurns,
          pendingEventsTotal: engineLeakCounters.pendingEventsTotal,
          pendingEventsKB: engineLeakCounters.pendingEventsKB,
          turnSessionMapSize: engineLeakCounters.turnSessionMapSize,
          turnStartTimesSize: engineLeakCounters.turnStartTimesSize,
          // Session counts (lazy loading)
          sessionSummaryCount: state.sessionSummaries.length,
          loadedSessionCount: state.loadedSessions.size,
          // Loaded sessions metrics (LRU cache)
          loadedMessageCount,
          loadedTurnCount,
          loadedEventCount,
          // Drafts
          draftCount: Object.keys(state.draftsBySessionId).length,
          // Self-instrumentation. Cheap path should stay in single-digit ms;
          // a sustained climb here would mean the prod tier has accreted
          // something expensive again. Pair with the dev:perf record's
          // `diagBuildMs` to see how much extra the gated walks add.
          diagBuildMs: Math.round(performance.now() - diagStartedAt),
        },
        timestamp: Date.now()
      });

      // Dev:perf only — full payload-aware byte attribution. Includes the
      // depth-64 recursive walks over `currentSessionEvents`,
      // `backgroundEventBuffers`, and the 10 LRU-cached `loadedSessions`,
      // plus the `sessionSummaries` and state-map byte walks. The REBEL-5D5
      // investigation showed every one of these buckets reads ~0 KB at
      // multi-GB heap; this block is kept for future targeted runs but is no
      // longer paid for by every production user every 5 minutes.
      if (isPerfMode) {
        const payloadLeakDiag = getLeakDiagnostics();
        const loadedPayloadDiag = getLoadedSessionsPayloadDiagnostics(
          state.loadedSessions,
          state.currentSessionId,
        );
        const archiveDiag = getToolArchiveDiagnostics(state.loadedSessions);

        let currentMessagesKB = 0;
        let currentAttachmentTextsKB = 0;
        for (const message of state.messages) {
          currentMessagesKB += (message.text?.length ?? 0);
          const texts = message.attachmentTexts;
          if (texts) {
            for (const value of Object.values(texts)) {
              currentAttachmentTextsKB += value?.length ?? 0;
            }
          }
        }
        currentMessagesKB = Math.round(currentMessagesKB / 1024);
        currentAttachmentTextsKB = Math.round(currentAttachmentTextsKB / 1024);
        let currentThinkingTextKB = 0;
        for (const text of Object.values(state.thinkingTextByTurn)) {
          currentThinkingTextKB += text?.length ?? 0;
        }
        currentThinkingTextKB = Math.round(currentThinkingTextKB / 1024);

        const loadedSessionsDetail: Array<{ id: string; msgCount: number; turnCount: number; toolArchiveKeys: number }> = [];
        for (const [id, session] of state.loadedSessions.entries()) {
          loadedSessionsDetail.push({
            id: id.slice(0, 8),
            msgCount: session.messages?.length ?? 0,
            turnCount: Object.keys(session.eventsByTurn ?? {}).length,
            toolArchiveKeys: Object.keys(session.toolDetailArchive ?? {}).length,
          });
        }

        const summariesDiag = getSessionSummariesPayloadDiagnostics(state.sessionSummaries);
        const stateMapsDiag = getStateMapsByteDiagnostics(state);
        const domNodeCount = typeof document !== 'undefined'
          ? document.getElementsByTagName('*').length
          : 0;

        emitLog({
          level: 'info',
          message: 'Renderer leak diagnostics (dev:perf)',
          context: {
            heapUsedMB,
            heapLimitMB,
            // Cheap deltas (same values as on the paired prod record at this
            // timestamp). Repeated here so dev:perf log mining doesn't need
            // to cross-reference the prod line.
            heapUsedDeltaMB,
            sampleIntervalMs,
            // #1: currentSessionEvents (external Map) — unbounded for active session
            csEventsTurns: payloadLeakDiag.currentSessionEventsTurns,
            csEventsTotal: payloadLeakDiag.currentSessionEventsTotal,
            csEventsKB: payloadLeakDiag.currentSessionEventsEstimatedKB,
            // #1a: payload-aware bytes for active-session events (REBEL-5D5)
            csImageContentKB: payloadLeakDiag.currentSessionImageContentKB,
            csToolResultKB: payloadLeakDiag.currentSessionToolResultKB,
            csMcpAppUiMetaKB: payloadLeakDiag.currentSessionMcpAppUiMetaKB,
            csMessagesKB: currentMessagesKB,
            csAttachmentTextsKB: currentAttachmentTextsKB,
            csThinkingTextKB: currentThinkingTextKB,
            // #2: loadedSessions LRU cache — soft cap of 10
            loadedSessionCount: state.loadedSessions.size,
            loadedSessionsDetail,
            loadedMessagesKB: loadedPayloadDiag.messagesKB,
            loadedAttachmentTextsKB: loadedPayloadDiag.attachmentTextsKB,
            loadedEventDetailKB: loadedPayloadDiag.eventDetailKB,
            loadedImageContentKB: loadedPayloadDiag.imageContentKB,
            loadedToolResultKB: loadedPayloadDiag.toolResultKB,
            loadedMcpAppUiMetaKB: loadedPayloadDiag.mcpAppUiMetaKB,
            // #2a: toolDetailArchive across all cached sessions (bounded per-session)
            toolArchiveTotalEntries: archiveDiag.totalArchiveEntries,
            toolArchiveTotalKB: archiveDiag.totalArchiveEstimatedKB,
            // #3: module-level caches
            coachingCacheSize: getCoachingCacheSize(),
            eligibilityCacheSize: getEligibilityCacheSize(),
            imageDataUrlCacheEntries: imageCacheStats.entries,
            imageDataUrlCacheKB: imageCacheStats.estimatedKB,
            imageDataUrlCacheEvictions: {
              rate5m: imageCacheStats.evictionRate5m,
              cumulative: imageCacheStats.evictionCount,
            },
            // #4: backgroundEventBuffers (orphaned entries) — incl. payload bytes
            bgBufferSessions: payloadLeakDiag.backgroundEventBuffersSessions,
            bgBufferTotal: payloadLeakDiag.backgroundEventBuffersTotal,
            bgBufferKB: payloadLeakDiag.backgroundEventBuffersEstimatedKB,
            bgBufferPayloadKB: payloadLeakDiag.backgroundEventPayloadKB,
            // #5: Zustand state maps (unbounded)
            autoDoneEntries: Object.keys(state.autoDoneBySessionId).length,
            draftEntries: Object.keys(state.draftsBySessionId).length,
            memoryStatusEntries: Object.keys(state.memoryUpdateStatusByTurn).length,
            timeSavedStatusEntries: Object.keys(state.timeSavedStatusByTurn).length,
            // #5a: byte sizes for the state maps above
            autoDoneKB: stateMapsDiag.autoDoneKB,
            draftsKB: stateMapsDiag.draftsKB,
            memoryStatusKB: stateMapsDiag.memoryStatusKB,
            timeSavedStatusKB: stateMapsDiag.timeSavedStatusKB,
            // #6: sessionSummaries (unbounded array) — count + byte size
            sessionSummaryCount: summariesDiag.count,
            sessionSummariesKB: summariesDiag.totalKB,
            // #7: streaming state — keys + total pending text bytes
            pendingThinkingDeltas: payloadLeakDiag.pendingThinkingDeltasKeys,
            pendingThinkingDeltasKB: stateMapsDiag.thinkingDeltasKB,
            // #8: DOM retention proxy
            domNodeCount,
            // Self-instrumentation, including all dev:perf walks above. The
            // gap between this and the prod record's `diagBuildMs` is the
            // cost of the dev:perf-only block — useful when deciding whether
            // a new diagnostic addition would be too expensive to promote
            // back to the prod tier.
            diagBuildMs: Math.round(performance.now() - diagStartedAt),
          },
          timestamp: Date.now()
        });
      }

      // Leak detection: sustained recent growth over the newest contiguous
      // (non-sleep-gapped) segment, GC-robust (latter-half least-squares slope)
      // and throttled to ≤1 WARN/30min. Detection math is the pure
      // `detectSustainedHeapGrowth` helper so it's unit-testable in isolation;
      // see src/renderer/utils/rendererLeakDetection.ts and
      // docs/project/APP_PERFORMANCE_AND_MEMORY.md. The cheap `Renderer memory
      // diagnostic` INFO line above stays UNTHROTTLED — raw heap is observable
      // every tick even when this WARN is silent. Production warning carries
      // cheap signal only; for byte attribution at the moment of the warning,
      // run dev:perf and consult the matching "Renderer leak diagnostics
      // (dev:perf)" record at the same timestamp.
      const leakVerdict = detectSustainedHeapGrowth({
        samples: rendererMemoryHistory,
        nominalIntervalMs: RENDERER_MEMORY_INTERVAL_MS,
        lastFiredHeapMB: rendererLeakWarnLastFiredHeapMB,
        lastFiredAtMs: rendererLeakWarnLastFiredAtMs,
        now: Date.now(),
      });

      if (leakVerdict.shouldWarn) {
        const newest = rendererMemoryHistory[rendererMemoryHistory.length - 1];
        // Advance throttle state so repeat WARNs are suppressed for ~30min
        // unless heap later drops materially (a distinct new leak).
        rendererLeakWarnLastFiredAtMs = Date.now();
        rendererLeakWarnLastFiredHeapMB = newest.heapUsedMB;

        emitLog({
          level: 'warn',
          message: 'Renderer memory leak suspected - sustained heap growth detected',
          context: {
            growthMB: leakVerdict.growthMB,
            timeSpanMinutes: Math.round(leakVerdict.segmentSpanMinutes),
            growthRateMBPerHour: Math.round(leakVerdict.ratePerHour),
            oldestHeapMB: rendererMemoryHistory[rendererMemoryHistory.length - leakVerdict.segmentSampleCount].heapUsedMB,
            newestHeapMB: newest.heapUsedMB,
            heapLimitMB,
            sampleCount: rendererMemoryHistory.length,
            // New shape/segment fields (additive — see PLAN.md).
            slopeMBPerHr: Math.round(leakVerdict.slopeMBPerHr),
            segmentSampleCount: leakVerdict.segmentSampleCount,
            // Cheap snapshot at the moment of the warning. Payload-byte
            // attribution lives in the dev:perf record.
            currentEventDetailKB: estimatedEventsByTurnKB,
            currentTurnCount: turnCount,
            currentEventCount: totalEventCount,
            imageDataUrlCacheKB: imageCacheStats.estimatedKB,
            imageDataUrlCacheEvictions: {
              rate5m: imageCacheStats.evictionRate5m,
              cumulative: imageCacheStats.evictionCount,
            },
            bgBufferSessions: cheapCounters.backgroundEventBuffersSessions,
            bgBufferTotal: cheapCounters.backgroundEventBuffersTotal,
            loadedSessionCount: state.loadedSessions.size,
            sessionSummaryCount: state.sessionSummaries.length,
          },
          timestamp: Date.now()
        });
      }
    };

    logRendererMemory();

    const intervalId = setInterval(logRendererMemory, RENDERER_MEMORY_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [emitLog, getEngineLeakCounters]);

  // =============================================================================
  // E2E Readiness Bridge (test-only)
  // =============================================================================

  useEffect(() => {
    if (!window.e2eApi?.isEnabled) {
      return;
    }

    const selector = '[data-testid="login-screen-overlay"]';
    const refresh = () => {
      const el = document.querySelector(selector);
      if (!el) {
        setLoginOverlayVisible(false);
        return;
      }

      const htmlEl = el as HTMLElement;
      const style = window.getComputedStyle(htmlEl);
      const isBlocking =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.pointerEvents !== 'none' &&
        htmlEl.getClientRects().length > 0;

      setLoginOverlayVisible(isBlocking);
    };

    refresh();

    const observer = new MutationObserver(() => refresh());
    observer.observe(document.body, { childList: true, subtree: true });

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!window.e2eApi?.isEnabled) {
      return;
    }

    const onboardingCompleted = Boolean(settings?.onboardingCompleted);
    const safeModeEnabled = safeModeContext.isEnabled;
    // NOTE: startupRecoveryDialogVisible is now managed inside SafeModeOrchestrator.
    // In E2E mode, the startup recovery dialog is skipped entirely (isE2EMode guards),
    // so this is always false in practice.
    const startupRecoveryDialogVisible = false;
    const routerIsRunning = mcpSummary?.router?.isRunning ?? false;

    const toolsReady = routerIsRunning && !safeModeEnabled;
    const onboardingResolved = showOnboardingWizard || (onboardingCompleted && shouldRenderMainApp);
    const appReady = Boolean(settings) && !startupRecoveryDialogVisible && !loginOverlayVisible && onboardingResolved;

    const phase = safeModeEnabled
      ? 'safe-mode'
      : !settings
        ? 'booting'
        : loginOverlayVisible
          ? 'login'
          : !onboardingCompleted || showOnboardingWizard || !shouldRenderMainApp
            ? 'onboarding'
            : 'main';

    let blockingReason: string | undefined;
    if (!appReady) {
      if (!settings) blockingReason = 'settings-loading';
      else if (startupRecoveryDialogVisible) blockingReason = 'startup-recovery-dialog';
      else if (loginOverlayVisible) blockingReason = 'auth-login';
      else if (!onboardingCompleted || showOnboardingWizard || !shouldRenderMainApp) blockingReason = 'onboarding';
    }

    window.e2eApi.setReadiness({
      phase,
      blockingReason,
      appReady,
      toolsReady,
      onboardingCompleted,
      safeModeEnabled,
      startupRecoveryDialogVisible,
    });
  }, [
    loginOverlayVisible,
    mcpSummary?.router?.isRunning,
    safeModeContext.isEnabled,
    settings,
    settings?.onboardingCompleted,
    showOnboardingWizard,
    shouldRenderMainApp,
  ]);

  // C2 (Class A): positive "App Reached Interactive" signal. `Application
  // Opened` (main, did-finish-load) fires when the page loads and over-counts
  // blank/stuck renderers as healthy; this fires the first time the UI is
  // actually interactive, so a blank/stuck cohort is detectable by the event's
  // ABSENCE relative to `Application Opened` (pairs with the active-detection /
  // alerting workstreams' cohort absence-alert). Fires at most once per renderer
  // session (ref-guarded); not e2e-gated (this is the production signal).
  useEffect(() => {
    if (hasReportedReachedInteractiveRef.current) {
      return;
    }
    const onboardingCompleted = Boolean(settings?.onboardingCompleted);
    const onboardingResolved =
      showOnboardingWizard || (onboardingCompleted && shouldRenderMainApp);
    const appReady =
      Boolean(settings) && !loginOverlayVisible && onboardingResolved;
    if (!appReady) {
      return;
    }
    hasReportedReachedInteractiveRef.current = true;
    // performance.now() is ms since renderer process start (timeOrigin), a safe
    // low-cardinality elapsed measure; guard for environments without it.
    const msSinceBoot =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? Math.round(performance.now())
        : null;
    tracking.app.reachedInteractive({
      msSinceBoot,
      safeMode: safeModeContext.isEnabled,
    });
  }, [
    loginOverlayVisible,
    safeModeContext.isEnabled,
    settings,
    settings?.onboardingCompleted,
    showOnboardingWizard,
    shouldRenderMainApp,
  ]);

  // Save personalized use cases when generated during onboarding
  const handleUseCasesGenerated = useCallback((useCases: PersonalizedUseCase[]) => {
    emitLog({ level: 'info', message: 'Onboarding: handleUseCasesGenerated called', context: { useCasesCount: useCases.length }, timestamp: Date.now() });
    fireAndForget(saveSettingsWith((draft) => ({
      ...draft,
      personalizedUseCases: useCases
    })), 'savePersonalizedUseCases');
  }, [saveSettingsWith, emitLog]);



  // Save user's first name when fetched during onboarding
  const handleUserNameFetched = useCallback((firstName: string | null) => {
    setUserFirstName(firstName);
    if (firstName) {
      fireAndForget(saveSettingsWith((draft) => ({
        ...draft,
        userFirstName: firstName
      })), 'saveUserFirstName');
    }
  }, [saveSettingsWith]);

  // Initialize user first name from persisted settings
  useEffect(() => {
    if (settings?.userFirstName && !userFirstName) {
      setUserFirstName(settings.userFirstName);
    }
  }, [settings?.userFirstName, userFirstName]);

  // Track draft ElevenLabs API key during onboarding (before settings are committed)
  // This allows the prefetch hook to start fetching while user is still in the wizard
  const [_draftElevenlabsKey, setDraftElevenlabsKey] = useState<string | null>(null);
  const handleDraftElevenlabsKeyChange = useCallback((key: string | null) => {
    setDraftElevenlabsKey(key);
  }, []);

  // Clear draft key when onboarding wizard closes
  useEffect(() => {
    if (!showOnboardingWizard) {
      setDraftElevenlabsKey(null);
    }
  }, [showOnboardingWizard]);

  useEffect(() => {
    if (activeSurface === 'settings') {
      if (!settingsOpen) {
        fireAndForget(openSettingsDialog(), 'syncOpenSettingsDialog');
      }
    } else if (settingsOpen) {
      closeSettingsDialog();
    }
  }, [activeSurface, closeSettingsDialog, openSettingsDialog, settingsOpen]);

  useEffect(() => {
    const wasOpen = previousSettingsOpenRef.current;
    if (activeSurface === 'settings' && wasOpen && !settingsOpen) {
      setActiveSurface('sessions');
    }
    previousSettingsOpenRef.current = settingsOpen;
  }, [activeSurface, settingsOpen, setActiveSurface]);

  configurationCompleteHandlerRef.current = handleConfigurationComplete;

  useEffect(() => {
    if (hasRequestedInitialMcpSummary.current) {
      return;
    }
    hasRequestedInitialMcpSummary.current = true;
    fireAndForget(refreshMcpSummary(), 'initialMcpSummary');
  }, [refreshMcpSummary]);

  const {
    loading: inboxLoading,
    items: inboxItems,
    history: inboxHistory,
    recordTaskExecutionResult,
    handleTaskShare,
    handleDeleteTask: _handleDeleteTask,
    handleArchiveTask: _handleArchiveTask,
    handleDone: handleInboxDone,
    handleDismiss: handleInboxDismiss,
    handleSetTags,
    handleSetPriority,
    handleSetSchedule,
    // Inbox counts
    archivedCount: inboxArchivedCount,
    activeCount: _inboxActiveCount,
    actionableCount: _inboxActionableCount
  } = useInbox({ emitLog, showToast });

  // When sessions finish, mark associated inbox items as completed (by Rebel).
  // Track which sessionIds were busy in the previous render.
  const prevBusySessionsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const currentBusy = new Set(
      sessionSummariesRef.current.filter(s => s.isBusy).map(s => s.id)
    );
    const prevBusy = prevBusySessionsRef.current;
    
    for (const sessionId of prevBusy) {
      if (!currentBusy.has(sessionId)) {
        const itemWithSession = inboxItems.find(item => item.executingSessionId === sessionId)
          || inboxHistory?.find(item => item.executingSessionId === sessionId);
        if (itemWithSession && itemWithSession.status === 'executing') {
          if (itemWithSession.autoCompleteOnExecution === true) {
            void window.inboxApi.setStatus({ itemId: itemWithSession.id, status: 'completed', completedBy: 'rebel' });
          } else {
            void window.inboxApi.setExecuting({ itemId: itemWithSession.id, sessionId: null });
          }
        }
      }
    }
    
    prevBusySessionsRef.current = currentBusy;
   
  }, [sessionSummaries, inboxItems, inboxHistory, showToast, setActiveSurface]); // sessionSummaries dep triggers re-check on busy changes

  // Badge count: filtered active inbox items (matches what the "All" tab shows)
  const inboxBadgeCount = useMemo(
    () => filterInboxViewItems(inboxItems, 'active', '', new Set()).length,
    [inboxItems],
  );

  // Pending approval count for approvals/staged writes needing attention
  const pendingApprovalCount = usePendingApprovalCount();
  const pendingQuestionWaitingCount = usePendingQuestionWaitingCount();
  const skillChangeNotificationCount = useSkillChangeNotificationCount();
  const notificationDrawerCount = pendingApprovalCount + pendingQuestionWaitingCount + skillChangeNotificationCount;

  const handleNewSkillChangeNotification = useCallback((notification: {
    actorLabel: string;
    skillName: string;
    skillWorkspacePath: string;
  }) => {
    showToast({
      title: `${notification.actorLabel} changed ${notification.skillName}`,
      description: 'Open Notifications to review the skill changes.',
    });
    void window.appApi.showNotification({
      title: `${notification.skillName} was modified by ${notification.actorLabel}`,
      body: 'Want to review the changes?',
      filePath: notification.skillWorkspacePath,
    });
  }, [showToast]);

  useSkillChangeNotifications({
    onNewNotification: handleNewSkillChangeNotification,
  });
  
  const {
    sessionTypeFilter,
    automationSessions,
    hasCompletedRuns,
    terminalRunStateKey,
    setSessionTypeFilter,
  } = useAutomationsAppState();
  const {
    providerReadinessSummary,
    providerWaitCauseCount,
  } = useAutomationProviderReadinessSummary();

  const rebelInternalServer = useMemo(() => {
    if (!mcpSummary) {
      return null;
    }
    const combined = [
      ...(mcpSummary.servers ?? []),
      ...(mcpSummary.editableServers ?? []),
      ...(mcpSummary.router?.upstreamServers ?? [])
    ];
    return combined.find((server) => server.name?.toLowerCase() === REBEL_INBOX_SERVER_NAME) ?? null;
  }, [mcpSummary]);
  const isInternalConnectionPending = mcpSummaryLoading || !hasRequestedInitialMcpSummary.current;
  const internalConnectionStatus: 'loading' | 'connected' | 'disconnected' = isInternalConnectionPending
    ? 'loading'
    : mcpSummary?.status === 'ready' && rebelInternalServer
      ? 'connected'
      : 'disconnected';
  const canAutoConnectInternal = Boolean(mcpSummary?.configPath);

  useEffect(() => {
    if (automationSessions.length === 0) {
      return;
    }
    ingestExternalSessions(automationSessions);
  }, [automationSessions, ingestExternalSessions]);

  useManagedTierModelChangeNotifier({
    activeProvider: settings?.activeProvider,
    settings,
    showToast,
  });

  const { showMentionTooltip } = useFirstTimeTooltipEffects({
    settings,
    saveSettingsWith,
    showToast,
    openSettingsDialog: (tab: string) => { fireAndForget(openSettingsDialog(tab), 'tooltipOpenSettingsDialog'); },
    setActiveSurface,
    memoryUpdateStatusByTurn,
    pendingApprovalCount,
    deniedOperationsCount: deniedOperations.length,
    stagedToolCallsCount: stagedToolCalls.length,
    memoryApprovalRequestsCount: memoryApprovalRequests.length,
    eventsByTurn,
    hasCompletedRuns,
    settingsOpen,
    settingsActiveTab,
  });

  // Inbound trigger sessions (e.g., Slack @-mention): add to sidebar immediately
  useEffect(() => {
    const unsubscribe = window.api.onInboundTriggerSessionCreated?.((session) => {
      if (!session?.id) return;
      ingestExternalSessions([{ ...session, origin: 'inbound-trigger' }]);
    });
    return unsubscribe;
  }, [ingestExternalSessions]);

  const finalizePendingTaskExecution = useCallback(async () => {
    if (!pendingTaskExecutionRef.current) {
      return;
    }
    const payload = pendingTaskExecutionRef.current;
    pendingTaskExecutionRef.current = null;
    await recordTaskExecutionResult(payload.taskId, payload.sessionId, payload.mode);
  }, [recordTaskExecutionResult]);

  const handleSelectUseCase = useCallback((prompt: string, attachments?: AnyAttachmentPayload[]) => {
    const sessionId = startFreshSession();

    const store = getSessionStoreState();
    const placeholder = store.addUserMessage(prompt);
    store.setShowConversation(true);

    fireAndForget(submitQueuedMessage(prompt, 'text', attachments, {
      targetSessionId: sessionId,
      existingMessageId: placeholder.id
    }), 'handleSelectUseCase');
  }, [startFreshSession, submitQueuedMessage]);

  const selectUseCaseById = useCallback(async (useCaseId: string) => {
    try {
      const { useCases } = await window.useCaseLibraryApi.getAll({});
      const match = useCases.find((useCase) => useCase.id === useCaseId);

      if (match) {
        void window.useCaseLibraryApi.recordUsage({ id: useCaseId });
        handleSelectUseCase(match.prompt);
      } else {
        showToast({ title: 'This use case is no longer available', variant: 'info' });
        setActiveSurfaceWithSideEffects('usecases');
      }
    } catch {
      showToast({ title: 'Could not load use case', variant: 'error' });
      setActiveSurfaceWithSideEffects('usecases');
    }
  }, [handleSelectUseCase, setActiveSurfaceWithSideEffects, showToast]);

  // Start a guided conversation to introduce a new feature from What's New
  const handleTryWhatsNewFeature = useCallback((highlight: ChangelogHighlight) => {
    const sessionId = startFreshSession();
    
    // Update session title to reflect feature exploration
    const store = getSessionStoreState();
    store.setCurrentSessionMeta({ currentSessionTitle: `What's New: ${highlight.title}` });
    
    // Build navigation link instruction if actionUrl is available
    // e.g., "rebel://library" -> "[Library](rebel://library)"
    let navigationLinkInstruction = '';
    if (highlight.actionUrl?.startsWith('rebel://')) {
      // Extract a friendly label from the URL path
      const urlPath = highlight.actionUrl.replace('rebel://', '');
      const pathParts = urlPath.split('/');
      const label = pathParts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' > ');
      navigationLinkInstruction = `\n\nIMPORTANT: End your response with a clickable link to the feature. Use this exact markdown: [Open ${label}](${highlight.actionUrl})`;
    }
    
    // Construct a prompt with the exact intro Rebel should output
    // Chat mode ensures no tools are called - just a text response
    const prompt = `[WHAT'S NEW FEATURE INTRO]

Start your response with this text EXACTLY (no preamble):
---

## ${highlight.title}

${highlight.description}

---

After the intro, add 2-3 sentences explaining why this is useful, then ask if they'd like to try it together.${navigationLinkInstruction}`;
    
    // Optimistically show the message and send
    const placeholder = store.addUserMessage(prompt);
    store.setShowConversation(true);
    
    // Send the message (router will handle direct answer vs agent)
    fireAndForget(submitQueuedMessage(prompt, 'text', undefined, { 
      targetSessionId: sessionId,
      existingMessageId: placeholder.id 
    }), 'handleTryWhatsNewFeature');
  }, [startFreshSession, submitQueuedMessage]);

  // Start a chat to help users learn about Rebel's capabilities (from Help menu)
  const handleAskRebel = useCallback(() => {
    const sessionId = startFreshSession();
    
    // Update session title
    const store = getSessionStoreState();
    store.setCurrentSessionMeta({ currentSessionTitle: 'Ask Rebel' });
    
    // Get a random tip to share with the user (prevents hallucination)
    const tip = getRandomTip();
    
    // Build prompt for a warm, helpful introduction with a real tip
    const prompt = `[ASK REBEL INTRO]

The user clicked "Ask Rebel" from the Help menu. They want to learn how to use you better.

Here's a feature tip to share with them:
${tip.content}

Respond warmly and briefly (3-4 sentences max):
1. Welcome them and say you're happy to help them get the most out of Rebel
2. Share the tip above naturally (don't say "here's a tip" - weave it in conversationally)
3. Mention you can answer questions about features, help with tasks, or explain how to connect tools
4. End by asking what they'd like to know or try

Keep it conversational, not a lecture. Match Rebel's dry wit personality.`;
    
    // Optimistically show the message and send
    const placeholder = store.addUserMessage(prompt);
    store.setShowConversation(true);
    
    // Send the message (router will handle direct answer vs agent)
    fireAndForget(submitQueuedMessage(prompt, 'text', undefined, { 
      targetSessionId: sessionId,
      existingMessageId: placeholder.id 
    }), 'handleAskRebel');
  }, [startFreshSession, submitQueuedMessage]);

  // Start a conversation about a plugin from Settings > Plugins (custom event bridge)
  useEffect(() => {
    const handler = (event: Event) => {
      const { pluginId, pluginName, source } = (event as CustomEvent<{ pluginId: string; pluginName: string; source: string }>).detail;
      const sessionId = startFreshSession();
      const store = getSessionStoreState();
      store.setCurrentSessionMeta({ currentSessionTitle: `Plugin: ${pluginName}` });

      const prompt = `[PLUGIN OVERVIEW REQUEST]

The user opened a conversation about the "${pluginName}" plugin (ID: ${pluginId}) from Settings > Plugins.

Here is the plugin source code:
\`\`\`tsx
${source}
\`\`\`

Please briefly explain what this plugin does (2-3 sentences), what Rebel APIs it uses, and offer to help them modify, improve, or troubleshoot it.`;

      const placeholder = store.addUserMessage(prompt);
      store.setShowConversation(true);
      fireAndForget(submitQueuedMessage(prompt, 'text', undefined, {
        targetSessionId: sessionId,
        existingMessageId: placeholder.id,
      }), 'pluginConversationEvent');
    };
    window.addEventListener('rebel:start-plugin-conversation', handler);
    return () => window.removeEventListener('rebel:start-plugin-conversation', handler);
  }, [startFreshSession, submitQueuedMessage]);

  // Start a session in background without navigating (e.g., for meeting prep).
  // Returns the sessionId so callers can track progress via the session store.
  const handleStartBackgroundSession = useCallback((prompt: string): string => {
    const store = getSessionStoreState();
    const sessionId = createId();
    store.createBackgroundSession(sessionId);
    fireAndForget(submitQueuedMessage(prompt, 'text', undefined, { targetSessionId: sessionId }), 'handleStartBackgroundSession');

    // Immediate feedback: solid toast with icon and action to view the session.
    // Extract meeting title from prompt for personalised copy.
    const meetingMatch = prompt.match(/Prep me for my meeting "([^"]+)"/);
    const isMeetingPrep = Boolean(meetingMatch);
    const title = meetingMatch
      ? `Prepping "${meetingMatch[1]}"`
      : 'Working on it';
    showToast({
      title,
      description: 'Running in the background \u2014 I\u2019ll let you know when it\u2019s ready.',
      icon: isMeetingPrep ? <Calendar size={16} /> : <Zap size={16} />,
      action: { label: 'View', onClick: () => {
        fireAndForget(navigateToConversation(sessionId), 'openBackgroundSessionFromToast');
      }},
      duration: 6000,
    });
    return sessionId;
  }, [submitQueuedMessage, showToast, navigateToConversation]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{
        prompt?: unknown;
        profileName?: unknown;
      }>).detail;
      if (typeof detail?.prompt !== 'string' || detail.prompt.trim().length === 0) return;

      const sessionId = handleStartBackgroundSession(detail.prompt);
      if (typeof detail.profileName === 'string' && detail.profileName.trim().length > 0) {
        getSessionStoreState().renameSession(sessionId, `Research: ${detail.profileName.trim()}`);
      }
    };

    window.addEventListener('rebel:start-model-profile-enrichment', handler);
    return () => window.removeEventListener('rebel:start-model-profile-enrichment', handler);
  }, [handleStartBackgroundSession]);

  // Start a new conversation with files attached (for Atlas tooltip)
  const handleAtlasStartConversation = useCallback(async (message: string, filePaths: string[]) => {
    try {
      // Build attachments from file paths
      const attachments: AgentAttachmentPayload[] = [];
      const coreDir = settingsRef.current?.coreDirectory;
      
      for (const filePath of filePaths.slice(0, 6)) { // Limit to 6 files
        try {
          const result = await window.libraryApi.readFile(filePath);
          // readFile returns { path, content, updatedAt? } - no success field
          if (result.content !== undefined) {
            const fileName = filePath.split('/').pop() ?? filePath;
            // Compute relative path from workspace root
            let relativePath = fileName;
            if (coreDir && filePath.startsWith(coreDir)) {
              const sliceStart = coreDir.endsWith('/') ? coreDir.length : coreDir.length + 1;
              relativePath = filePath.slice(sliceStart) || fileName;
            }
            attachments.push({
              id: `atlas-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              name: fileName,
              path: filePath,
              relativePath,
              size: new Blob([result.content]).size,
              content: result.content
            });
          }
        } catch (e) {
          // Skip files that can't be read
          emitLog({ level: 'warn', message: 'Failed to read file for Atlas conversation', context: { filePath, error: String(e) }, timestamp: Date.now() });
        }
      }

      // Create new session and capture the ID for explicit targeting
      const sessionId = resetSessionState();
      setActiveSurface('sessions');
      setShowConversation(true);
      setIsTextMode(true);
      setFlowHistoryOpen(true);

      // Pass targetSessionId explicitly for safety (follows pattern from other handlers)
      await submitQueuedMessage(message, 'text', attachments.length > 0 ? attachments : undefined, { targetSessionId: sessionId });
    } catch (error) {
      emitLog({ level: 'error', message: 'Failed to start Atlas conversation', context: { error: String(error) }, timestamp: Date.now() });
      showToast({ title: 'Failed to start conversation' });
    }
  }, [emitLog, resetSessionState, setActiveSurface, setFlowHistoryOpen, setIsTextMode, setShowConversation, showToast, submitQueuedMessage]);

  const {
    files: libraryIndex,
    loading: libraryIndexLoading,
    error: libraryIndexError,
    hasLoaded: libraryIndexLoaded,
    refresh: refreshLibraryIndex,
    filesRef: libraryIndexFilesRef,
    treeMetadata: libraryIndexMetadata
  } = useLibraryIndex({
    autoLoad: Boolean(settings?.coreDirectory) && !workspaceRecoveryDialog.open && !workspaceRecoveryDialog.checking,
    enabled: Boolean(settings?.coreDirectory) && !workspaceRecoveryDialog.open && !workspaceRecoveryDialog.checking
  });

  // Keep library refs updated for stable callback access
  libraryIndexRef.current = libraryIndex;
  libraryIndexLoadedRef.current = libraryIndexLoaded;

  useEffect(() => {
    if (settings?.coreDirectory && !workspaceRecoveryDialog.open && !workspaceRecoveryDialog.checking) {
      fireAndForget(refreshLibraryIndex(), 'refreshLibraryIndex');
    }
    // Note: mention state clearing is handled by the useMentionAutocomplete hook
    // when hasWorkspace becomes false
  }, [settings?.coreDirectory, refreshLibraryIndex, workspaceRecoveryDialog.checking, workspaceRecoveryDialog.open]);

  // Stable callbacks that forward to UpdateToastManager ref (consumed by useIpcListeners).
  // Buffer the last update payload in a ref so it's not lost if the manager hasn't
  // mounted yet (e.g., during onboarding or pre-settings splash). The useEffect below
  // flushes it once the manager mounts.
  const pendingUpdateRef = useRef<
    | { updateKey: string; version: string; downloadUrl?: string; recoveryAttempts?: number }
    | null
  >(null);
  const setUpdateAvailable = useCallback(
    (
      data:
        | { updateKey: string; version: string; downloadUrl?: string; recoveryAttempts?: number }
        | null,
    ) => {
      if (updateToastManagerRef.current) {
        updateToastManagerRef.current.setUpdateAvailable(data);
      } else {
        pendingUpdateRef.current = data;
      }
    },
    [],
  );
  const setIsInstallingUpdate = useCallback(
    (isInstalling: boolean) => updateToastManagerRef.current?.setIsInstallingUpdate(isInstalling),
    [],
  );
  // Flush any buffered update once UpdateToastManager mounts (shouldRenderMainApp becomes true)
  useEffect(() => {
    if (shouldRenderMainApp && updateToastManagerRef.current && pendingUpdateRef.current) {
      updateToastManagerRef.current.setUpdateAvailable(pendingUpdateRef.current);
      pendingUpdateRef.current = null;
    }
  }, [shouldRenderMainApp]);

  // Reload session summaries from IPC (used by cloud sync to refresh sidebar after remote changes)
  const reloadSessionSummaries = useCallback(async () => {
    try {
      const summaries = await window.sessionsApi.list();
      if (summaries) {
        getSessionStoreState().setSessionSummaries(summaries);
      }
    } catch (error) {
      console.error('[Cloud Sync] Failed to reload session summaries:', error);
    }
  }, []);

  useEffect(() => {
    if (!window.e2eApi?.isEnabled) return;

    const handleE2EClearAllSessions = (event: Event) => {
      const detail = (event as CustomEvent<{ deletedIds?: string[] }>).detail;
      getSessionStoreState().clearAllSessionsForE2E(detail?.deletedIds);
    };

    window.addEventListener('rebel-e2e:clear-all-sessions', handleE2EClearAllSessions);
    return () => {
      window.removeEventListener('rebel-e2e:clear-all-sessions', handleE2EClearAllSessions);
    };
  }, []);

  const lastAutomationSummaryReloadKeyRef = useRef('');
  useEffect(() => {
    if (!terminalRunStateKey || terminalRunStateKey === lastAutomationSummaryReloadKeyRef.current) {
      return;
    }
    lastAutomationSummaryReloadKeyRef.current = terminalRunStateKey;

    fireAndForget(reloadSessionSummaries(), 'reloadSessionSummariesAfterAutomationTerminalRun');
    const retryTimer = window.setTimeout(() => {
      fireAndForget(reloadSessionSummaries(), 'retryReloadSessionSummariesAfterAutomationTerminalRun');
    }, 750);

    return () => window.clearTimeout(retryTimer);
  }, [terminalRunStateKey, reloadSessionSummaries]);

  // Refresh the actively-viewed session's full content (messages + events) from
  // disk after the main process merges new cloud content. Sidebar summaries
  // alone don't carry transcript content, so without this hook the open
  // conversation silently stays stale until the user re-opens the session or
  // restarts the app. See docs-private/investigations/260518_cloud_merged_session_not_refreshed_in_active_view.md.
  const activeCloudRefreshSeqRef = useRef(0);
  const refreshActiveCloudSession = useCallback(async (sessionId: string) => {
    const initialState = getSessionStoreState();
    if (initialState.currentSessionId !== sessionId) return;

    // Skip while a live local turn is streaming on this session — replacing
    // the snapshot mid-stream would clobber assistant_delta / thinking_delta
    // events the disk hasn't seen yet. The next cloud:sessions-synced
    // broadcast (or a session re-open) will pick this up once the turn ends.
    if (initialState.isBusy && initialState.activeTurnId) {
      emitLog({
        level: 'info',
        message: 'Skipped cloud session refresh: local turn is streaming',
        context: { sessionId, activeTurnId: initialState.activeTurnId },
        timestamp: Date.now(),
      });
      return;
    }

    // Fingerprint local state so we can detect any local mutation that
    // happens between fetch issue and resolve (a local turn starting AND
    // completing during the in-flight IPC). If the fingerprint changed, the
    // disk-read may be older than our in-memory state — abort the ingest.
    const preFetchFingerprint = {
      messageCount: initialState.messages.length,
      eventsVersion: initialState.eventsByTurnVersion,
    };
    const requestSeq = ++activeCloudRefreshSeqRef.current;

    let session: AgentSession | null;
    try {
      session = (await window.sessionsApi.get({ id: sessionId })) as AgentSession | null;
    } catch (error) {
      emitLog({
        level: 'warn',
        message: 'Cloud sync: failed to fetch active session after merge',
        context: { sessionId, error: error instanceof Error ? error.message : String(error) },
        timestamp: Date.now(),
      });
      return;
    }
    if (!session) return;

    // Stale-response guards: another refresh raced ahead, the user switched
    // sessions, a turn started in the gap, or the local transcript advanced
    // (turn started and finished) while the IPC was in flight.
    if (requestSeq !== activeCloudRefreshSeqRef.current) return;
    const postFetchState = getSessionStoreState();
    if (postFetchState.currentSessionId !== sessionId) return;
    if (postFetchState.isBusy && postFetchState.activeTurnId) return;
    if (
      postFetchState.messages.length !== preFetchFingerprint.messageCount ||
      postFetchState.eventsByTurnVersion !== preFetchFingerprint.eventsVersion
    ) {
      emitLog({
        level: 'info',
        message: 'Skipped cloud session refresh: local transcript advanced during fetch',
        context: {
          sessionId,
          before: preFetchFingerprint,
          after: {
            messageCount: postFetchState.messages.length,
            eventsVersion: postFetchState.eventsByTurnVersion,
          },
        },
        timestamp: Date.now(),
      });
      return;
    }

    ingestExternalSessions([session]);
  }, [emitLog, ingestExternalSessions]);

  // Consolidated IPC event subscriptions (extracted from App.tsx for maintainability)
  const { resetUpdateDedup } = useIpcListeners({
    emitLog,
    showToast,
    refreshLibraryIndex,
    refreshMcpSummary,
    refreshSettings,
    setTimeSavedBySession,
    setCoachingSessionIds,
    setUpdateAvailable,
    setIsInstallingUpdate,
    setSuperMcpReady,
    reloadSessionSummaries,
    refreshActiveCloudSession,
    onWorkspaceConflictsDetected: setWorkspaceConflictPaths,
    openWorkspaceConflictDialog,
  });

  // JIT prompt cache warming - triggers on composer focus when cache has expired
  const { triggerWarmupIfNeeded } = usePromptCacheWarming({
    superMcpReady,
    isBusy,
  });



  // =============================================================================
  // Emergency Startup Recovery (P0 protection against settings load hang)
  // =============================================================================
  // This timeout triggers BEFORE settings load completes. If settings don't load
  // within 15 seconds, we show the EmergencyStartupRecovery component which uses
  // fire-and-forget IPC to restart in Safe Mode (works even when normal IPC is hung).
  //
  // This is distinct from StartupRecoveryDialog which only triggers AFTER settings
  // load and handles Super-MCP startup issues.
  const emergencyTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const emergencyGraceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    // Skip in E2E mode - tests manage their own timeouts
    const isE2EMode = Boolean(window.e2eApi?.isEnabled);
    if (isE2EMode) return;

    // If settings loaded or user dismissed, clear the timeout
    if (settings || emergencyRecoveryDismissedRef.current) {
      if (emergencyTimeoutRef.current) {
        clearTimeout(emergencyTimeoutRef.current);
        emergencyTimeoutRef.current = null;
      }
      if (emergencyGraceTimeoutRef.current) {
        clearTimeout(emergencyGraceTimeoutRef.current);
        emergencyGraceTimeoutRef.current = null;
      }
      return;
    }

    // Don't re-show if already showing or was dismissed
    if (showEmergencyRecovery) return;

    // Set emergency timeout - 15s catches genuine startup hangs, with a short
    // grace check to avoid false positives when dev HMR or main-process work
    // delays the settings state update by a few hundred milliseconds.
    const EMERGENCY_TIMEOUT_MS = 15_000;
    const EMERGENCY_GRACE_MS = 5_000;
    emergencyTimeoutRef.current = setTimeout(() => {
      // Double-check settings still haven't loaded
      if (!settingsRef.current && !emergencyRecoveryDismissedRef.current) {
        console.warn('[App] Settings still loading after 15s; waiting briefly before showing emergency recovery');
        emergencyGraceTimeoutRef.current = setTimeout(() => {
          if (!settingsRef.current && !emergencyRecoveryDismissedRef.current) {
            console.error('[App] Emergency startup timeout - settings failed to load after grace period');
            setShowEmergencyRecovery(true);
          }
        }, EMERGENCY_GRACE_MS);
      }
    }, EMERGENCY_TIMEOUT_MS);

    return () => {
      if (emergencyTimeoutRef.current) {
        clearTimeout(emergencyTimeoutRef.current);
        emergencyTimeoutRef.current = null;
      }
      if (emergencyGraceTimeoutRef.current) {
        clearTimeout(emergencyGraceTimeoutRef.current);
        emergencyGraceTimeoutRef.current = null;
      }
    };
  }, [settings, showEmergencyRecovery]);

  // Listen for menu commands from native application menu
  useMenuCommands({
    setActiveSurface,
    setShowConversation,
    setIsTextMode,
    setShortcutsOpen,
    showToast,
    emitLog,
    focusComposer,
    setUpdateAvailable,
    onAskRebel: handleAskRebel,
    onWatchTutorials: openTutorials,
    onReportBug: () => setBugReportOpen(true),
    onStartDemoMode: () => setDemoModeDialogOpen(true),
    onDownloadDiagnostics: openDownloadDiagnosticsDialog,
  });

  // Find menu commands — route Cmd+F / Cmd+G / Cmd+Shift+G to the appropriate surface.
  // Uses pendingFindAction to avoid timing issues: when FindBar opens from a find-next/previous
  // command, we store the action and let FindBar consume it after mount.
  const [pendingFindAction, setPendingFindAction] = useState<'next' | 'previous' | null>(null);

  useEffect(() => {
    const routeToDocumentEditor = () => {
      window.dispatchEvent(new CustomEvent('document-editor:open-find'));
    };

    const isDocumentEditorActive = () =>
      (activeSurfaceRef.current === 'library' && libraryEditorOpen) || documentPreviewOpen;

    const handleFind = () => {
      if (isDocumentEditorActive()) {
        routeToDocumentEditor();
      } else {
        setShowFindBar(true);
      }
    };

    const handleFindNext = () => {
      if (isDocumentEditorActive()) {
        routeToDocumentEditor();
      } else {
        setPendingFindAction('next');
        setShowFindBar(true);
      }
    };

    const handleFindPrevious = () => {
      if (isDocumentEditorActive()) {
        routeToDocumentEditor();
      } else {
        setPendingFindAction('previous');
        setShowFindBar(true);
      }
    };

    const unsubFind = window.api.onMenuFind(handleFind);
    const unsubFindNext = window.api.onMenuFindNext(handleFindNext);
    const unsubFindPrevious = window.api.onMenuFindPrevious(handleFindPrevious);

    return () => {
      unsubFind();
      unsubFindNext();
      unsubFindPrevious();
    };
  }, [libraryEditorOpen, documentPreviewOpen]);

  // Determine if tools (MCP) are connected/configured
  const _hasToolsConfigured = Boolean(
    // Prefer definitive summary if available, otherwise fall back to presence of a config file
    (mcpSummary && mcpSummary.status !== 'missing' && (mcpSummary.upstreamCount && mcpSummary.upstreamCount > 0)) ||
    settings?.mcpConfigFile
  );

  // Homepage: derive connected connector count for user state detection
  const connectedConnectorCount = mcpSummary?.upstreamCount ?? 0;

  // Homepage nudge: match the enabled connector universe shown in Settings, including
  // custom/editable connectors, so the nudge retires once the setup is genuinely rich.
  const userAddedConnectorCount = useMemo(() => {
    return countEnabledUserAddedConnectors(mcpSummary);
  }, [mcpSummary]);

  const connectorActionAvailability = useMemo(() => {
    const servers = [
      ...(mcpSummary?.servers ?? []),
      ...(mcpSummary?.editableServers ?? []),
      ...(mcpSummary?.router?.upstreamServers ?? []),
    ].filter((server) => !server.disabled);
    const searchable = servers.map((server) => [
      server.catalogId,
      server.name,
      server.description,
      server.email,
      server.workspace,
    ].filter(Boolean).join(' ').toLowerCase());

    const hasAny = (...needles: string[]) =>
      searchable.some((value) => needles.some((needle) => value.includes(needle)));

    return {
      hasEmail: hasAny('gmail', 'mail', 'outlook', 'email'),
      hasMessaging: hasAny('slack', 'teams', 'message', 'chat'),
      hasDocsOrWork: hasAny('notion', 'drive', 'docs', 'document', 'asana', 'jira', 'atlassian', 'hubspot', 'miro', 'canva'),
    };
  }, [mcpSummary?.editableServers, mcpSummary?.router?.upstreamServers, mcpSummary?.servers]);

  // Library mention resolution (file @-mentions)
  const {
    ensureLibraryIndex,
    getRelativeLibraryPath,
    mentionResultsForQuery: fileMentionResultsForQuery,
    canResolveLibraryReference: _canResolveLibraryReference,
    buildPromptFromInboxItem: buildTaskPromptFromTask,
    resolveMentionedFiles,
    prepareMentionAttachments
  } = useLibraryMentions({
    libraryIndex,
    libraryIndexRef: libraryIndexFilesRef,
    coreDirectory: settings?.coreDirectory,
    textPrompt: '', // No longer needed here - mention resolution is done in ComposerWithState
    libraryIndexLoaded,
    libraryIndexLoading,
    refreshLibraryIndex,
    showToast,
    emitLog
  });
  // Conversation mention resolution (conversation @-mentions)
  // Uses sessionSummaries for lightweight title search (lazy loading Stage 7)
  const { conversationResultsForQuery, extractConversationReferences, prepareConversationAttachments } = useConversationMentions({
    sessionSummaries,
    currentSessionId
  });

  // Loading state for conversation summary generation during @-mention preparation
  const [isPreparingMentionContext, setIsPreparingMentionContext] = useState(false);
  const isPreparingMentionContextRef = useRef(false);

  const buildAttachmentsForPrompt = useCallback(async (
    prompt: string,
    baseAttachments: AnyAttachmentPayload[] = [],
  ): Promise<AnyAttachmentPayload[] | undefined> => {
    const hasPromptReferences = prompt.includes('@') || extractConversationReferences(prompt).length > 0;
    if (!hasPromptReferences) {
      return baseAttachments.length > 0 ? baseAttachments : undefined;
    }

    const mentionAttachments = await prepareMentionAttachments(prompt);
    const conversationAttachments = await prepareConversationAttachments(prompt);
    const allAttachments = [...mentionAttachments, ...conversationAttachments, ...baseAttachments];
    return allAttachments.length > 0 ? allAttachments : undefined;
  }, [
    extractConversationReferences,
    prepareConversationAttachments,
    prepareMentionAttachments,
  ]);

  const sendUserPrompt = useCallback(async (
    text: string,
    source: 'text' | 'voice',
    options?: {
      targetSessionId?: string;
      queueMode?: 'queue' | 'sendNow';
      editTargetMessageId?: string;
      attachments?: AnyAttachmentPayload[];
      /**
       * 260622 Stage 4: bypass the Chief-of-Staff admission gate for this one
       * turn (the "Run without my instructions" recovery escape). Threaded onto
       * the turn request; never persisted.
       */
      proceedWithoutChiefOfStaff?: boolean;
    },
  ) => {
    const prompt = text.trim();
    if (!prompt) return;
    lastUserSubmitAtRef.current = Date.now();

    let attachments: AnyAttachmentPayload[] | undefined;
    try {
      attachments = await buildAttachmentsForPrompt(prompt, options?.attachments ?? []);
    } catch (attachmentError) {
      showToast({
        title: attachmentError instanceof Error ? attachmentError.message : 'Unable to attach mentioned files'
      });
      return;
    }

    const promptWithOperatorHints = appendOperatorMentionHints(prompt, availableOperators);
    const operatorHintDisplayText = promptWithOperatorHints === prompt ? undefined : prompt;

    await submitQueuedMessage(promptWithOperatorHints, source, attachments, {
      targetSessionId: options?.targetSessionId,
      queueMode: options?.queueMode,
      editTargetMessageId: options?.editTargetMessageId,
      displayText: operatorHintDisplayText,
      ...(options?.proceedWithoutChiefOfStaff ? { proceedWithoutChiefOfStaff: true } : {}),
    });
  }, [
    availableOperators,
    buildAttachmentsForPrompt,
    showToast,
    submitQueuedMessage,
  ]);

  const submitVoicePrompt = useCallback(async (
    text: string,
    sessionId: string,
    queueMode?: 'queue',
  ) => {
    await sendUserPrompt(text, 'voice', {
      targetSessionId: sessionId,
      queueMode,
    });
  }, [sendUserPrompt]);

  // Compose unified mention results (files + conversations + commands + models)
  const mentionResultsForQuery = useCallback(
    (query: string, filter: MentionFilterType = 'all'): UnifiedMentionResult[] => {
      const hasWorkspace = Boolean(settings?.coreDirectory);
      const normalizedQuery = query.toLowerCase().trim();
      const isShortQuery = normalizedQuery.length < 2;

      // Skip unnecessary search calls based on filter (performance optimization)
      // - 'skills' filter: Only need file results (skills are a subset of files)
      // - 'memory' filter: Only need file results (memory files are a subset of files)
      // - 'conversations' filter: Only need conversation results
      // - 'models' filter: Only need model profile results
      // - 'all' filter: Need all result types
      const needFiles = filter === 'all' || filter === 'skills' || filter === 'memory';
      const needConversations = filter === 'all' || filter === 'conversations';
      const needCommands = filter === 'all';
      const needModels = filter === 'all' || filter === 'models';
      const needOperators = filter === 'all' || filter === 'operators';

      // Get file results (includes skills/memory - we'll filter below)
      let fileResults: FileMentionResult[] = [];
      if (needFiles && hasWorkspace) {
        const rawFileResults = fileMentionResultsForQuery(query).map((r) => ({ ...r, kind: 'file' as const }));
        if (filter === 'skills') {
          // Filter to only skills. Metadata-backed skills may live outside legacy skill path conventions.
          fileResults = rawFileResults.filter(isSkillEntry);
        } else if (filter === 'memory') {
          // Filter to only memory paths using path-based detection
          fileResults = rawFileResults.filter((r) => isMemoryPath(r.fullPath));
        } else {
          fileResults = rawFileResults;
        }
      }

      // Get conversation results
      const conversationResults = needConversations ? conversationResultsForQuery(query) : [];

      // Get model results: user profiles + Claude models
      const modelResults: ModelMentionResult[] = [];
      const profiles = settings?.localModel?.profiles ?? [];
      if (needModels) {
        const normalizedQ = normalizedQuery;

        // User-configured third-party profiles (skip disabled)
        for (const profile of profiles) {
          const modelName = typeof profile.model === 'string' ? profile.model : '';
          if (!modelName || profile.enabled === false) continue;

          const profileName = typeof profile.name === 'string' && profile.name.trim()
            ? profile.name
            : modelName;
          const profileNameLower = profileName.toLowerCase();
          const modelNameLower = modelName.toLowerCase();
          const nameMatch = profileNameLower.includes(normalizedQ);
          const modelMatch = modelNameLower.includes(normalizedQ);

          if (isShortQuery || nameMatch || modelMatch) {
            const matchStart = profileNameLower.indexOf(normalizedQ);
            modelResults.push({
              kind: 'model',
              profileId: profile.id,
              profileName,
              modelName,
              providerType: profile.providerType,
              score: matchStart === 0 ? 0 : (nameMatch ? 0.1 : 0.2),
              matches: matchStart >= 0 && normalizedQ.length > 0
                ? [[matchStart, matchStart + normalizedQ.length]]
                : [],
            });
          }
        }

        // Claude model entries (always available, even without configured profiles)
        for (const entry of CLAUDE_MENTION_ENTRIES) {
          const labelLower = entry.label.toLowerCase();
          const valueLower = entry.value.toLowerCase();
          const labelMatch = labelLower.includes(normalizedQ);
          const valueMatch = valueLower.includes(normalizedQ);

          if (isShortQuery || labelMatch || valueMatch) {
            const matchStart = labelLower.indexOf(normalizedQ);
            modelResults.push({
              kind: 'model',
              profileId: `claude-native:${entry.value}`,
              profileName: entry.label,
              modelName: entry.value,
              score: matchStart === 0 ? 0 : (labelMatch ? 0.1 : 0.2),
              matches: matchStart >= 0 && normalizedQ.length > 0
                ? [[matchStart, matchStart + normalizedQ.length]]
                : [],
            });
          }
        }

        modelResults.sort((a, b) => a.score - b.score || a.profileName.localeCompare(b.profileName));
      }

      const operatorResults: OperatorMentionResult[] = [];
      if (needOperators) {
        for (const operator of availableOperators) {
          const displayName = operator.displayName ?? operator.name;
          const displayNameLower = displayName.toLowerCase();
          const canonicalNameLower = operator.name.toLowerCase();
          const slugLower = operator.operatorSlug.toLowerCase();
          const descriptionLower = operator.description.toLowerCase();
          const displayNameMatch = displayNameLower.includes(normalizedQuery);
          const canonicalNameMatch = canonicalNameLower.includes(normalizedQuery);
          const slugMatch = slugLower.includes(normalizedQuery);
          const descriptionMatch = descriptionLower.includes(normalizedQuery);
          if (isShortQuery || displayNameMatch || canonicalNameMatch || slugMatch || descriptionMatch) {
            const matchStart = displayNameLower.indexOf(normalizedQuery);
            operatorResults.push({
              kind: 'operator',
              operatorId: operator.id,
              operatorSlug: operator.operatorSlug,
              operatorName: displayName,
              description: operator.description,
              consultWhen: operator.consult_when,
              score: matchStart === 0 ? 0 : (displayNameMatch ? 0.1 : canonicalNameMatch ? 0.15 : slugMatch ? 0.2 : 0.3),
              matches: matchStart >= 0 && normalizedQuery.length > 0
                ? [[matchStart, matchStart + normalizedQuery.length]]
                : [],
            });
          }
        }
        operatorResults.sort((a, b) => a.score - b.score || a.operatorName.localeCompare(b.operatorName));
      }

      // Available commands - only shown when filter is 'all' (discovery aids, not filtered results)
      const commandResults: CommandMentionResult[] = [];
      if (needCommands) {
        const AVAILABLE_COMMANDS = [
          { command: 'skills', label: '@skills', description: 'Find skills by describing what you need' },
          { command: 'files', label: '@files', description: 'Search library files by meaning' },
          { command: 'conversations', label: '@conversations', description: 'Search past conversations' },
          {
            command: 'designContext',
            label: '@designContext',
            description: 'Ground product and UX decisions in personas, journeys, and research',
          },
          {
            command: 'CHIEF_DESIGNER',
            label: '@CHIEF_DESIGNER',
            description: 'Get UI and UX design judgment grounded in Rebel\'s existing component system',
          },
        ];

        for (const cmd of AVAILABLE_COMMANDS) {
          // For short/empty queries, show all commands for discoverability
          // For longer queries, only show if query matches the command name
          const commandLower = cmd.command.toLowerCase();
          const matches = commandLower.includes(normalizedQuery);
          if (isShortQuery || matches) {
            const matchStart = commandLower.indexOf(normalizedQuery);
            // matchRanges must be relative to label (e.g., "@skills") not command (e.g., "skills")
            // labelOffset accounts for the "@" prefix in the display label
            const labelOffset = cmd.label.toLowerCase().indexOf(commandLower);
            const matchRanges: Array<[number, number]> = matchStart >= 0 && normalizedQuery.length > 0
              ? [[labelOffset + matchStart, labelOffset + matchStart + normalizedQuery.length]]
              : [];
            commandResults.push({
              kind: 'command',
              command: cmd.command,
              label: cmd.label,
              description: cmd.description,
              score: matchStart === 0 ? 0 : 0.1, // Prioritize prefix matches
              matches: matchRanges
            });
          }
        }
      }

      // For short/empty queries, limit file/conversation results
      const maxFiles = isShortQuery ? 4 : 200;
      const maxConversations = isShortQuery ? 4 : 6;
      const maxModels = isShortQuery ? 4 : 200;
      const maxOperators = isShortQuery ? 4 : 200;

      // When filter is 'all', separate skills from other files so skills appear before conversations
      // When filter is 'skills', all fileResults are already skills (no separation needed)
      if (filter === 'all') {
        const skillResults = fileResults.filter(isSkillEntry);
        const nonSkillResults = fileResults.filter((r) => !isSkillEntry(r));
        const cappedSkills = skillResults.slice(0, maxFiles);
        const remainingFileSlots = Math.max(0, maxFiles - cappedSkills.length);
        // Order: commands → skills → conversations → other files
        return [
          ...commandResults,
          ...operatorResults.slice(0, maxOperators),
          ...cappedSkills,
          ...conversationResults.slice(0, maxConversations),
          ...modelResults.slice(0, maxModels),
          ...nonSkillResults.slice(0, remainingFileSlots)
        ];
      }

      if (filter === 'models') {
        return modelResults.slice(0, maxModels);
      }

      if (filter === 'operators') {
        return operatorResults.slice(0, maxOperators);
      }

      // Filtered view: commands first (if any), then results for the filter type
      return [
        ...commandResults,
        ...conversationResults.slice(0, maxConversations),
        ...fileResults.slice(0, maxFiles)
      ];
    },
    [
      settings?.coreDirectory,
      settings?.localModel?.profiles,
      fileMentionResultsForQuery,
      conversationResultsForQuery,
      availableOperators,
    ]
  );

  // File attachments and mention autocomplete are now handled internally by ComposerWithState

  // Memoized mention context value — eliminates prop drilling through surfaces
  const mentionContextValue = useMemo(() => ({
    mentionResultsForQuery,
    ensureLibraryIndex,
    getRelativeLibraryPath,
    hasWorkspace: Boolean(settings?.coreDirectory),
    hasConversations: sessionSummaries.length > 0,
    coreDirectory: settings?.coreDirectory,
    libraryIndex,
    libraryIndexLoading,
    libraryIndexError,
    refreshLibraryIndex,
  }), [
    mentionResultsForQuery, ensureLibraryIndex, getRelativeLibraryPath,
    settings?.coreDirectory, sessionSummaries.length,
    libraryIndex, libraryIndexLoading, libraryIndexError, refreshLibraryIndex,
  ]);

  // STT/TTS "key missing" flags are split because Codex/ChatGPT Pro provides an
  // STT fallback for `openai-whisper` (see docs/plans/260415_codex_voice_stt_routing.md
  // and audioService.ts:973-994), but TTS remains key-only — Codex does not expose a
  // TTS endpoint. We therefore:
  //   - `sttKeyMissing` → gates the mic button; treats `openai-whisper` as available
  //     when the active provider is Codex.
  //   - `ttsKeyMissing` → gates the speaker toggle; remains strictly key-based.
  // See docs-private/investigations/260422_voice_mic_blocked_codex_stt.md for the bug this split fixes.
  const sttKeyMissing = useMemo(() => {
    if (!settings) return true;

    // Local providers don't need an API key for STT
    if (isLocalProvider(settings.voice.provider)) return false;

    if (settings.voice.provider === 'custom-openai') {
      const activeProfile = getActiveVoiceProfile(settings.voice);
      if (!activeProfile) return true; // No active profile = can't use voice
      const hasProfileKey = Boolean(activeProfile.apiKey?.trim());
      const hasSharedOpenAiKey = Boolean(getProviderKey(settings, 'openai'));
      return !hasProfileKey && !hasSharedOpenAiKey;
    }

    if (settings.voice.provider === 'openai-whisper') {
      // Codex/ChatGPT Pro provides an STT fallback path (see audioService.ts),
      // so the mic should remain enabled even without a standalone OpenAI API key.
      if (settings.activeProvider === 'codex') return false;
      return !getProviderKey(settings, 'openai');
    }

    return !settings.voice.elevenlabsApiKey?.trim();
  }, [settings]);

  // TTS is intentionally NOT Codex-aware: Codex/ChatGPT Pro does not expose a TTS
  // endpoint, so for `openai-whisper` the speaker toggle still requires an OpenAI key.
  const ttsKeyMissing = useMemo(() => {
    if (!settings) return true;

    // Local providers don't need an API key for STT
    if (isLocalProvider(settings.voice.provider)) return false;

    if (settings.voice.provider === 'custom-openai') {
      const activeProfile = getActiveVoiceProfile(settings.voice);
      if (!activeProfile) return true; // No active profile = can't use voice
      const hasProfileKey = Boolean(activeProfile.apiKey?.trim());
      const hasSharedOpenAiKey = Boolean(getProviderKey(settings, 'openai'));
      return !hasProfileKey && !hasSharedOpenAiKey;
    }

    if (settings.voice.provider === 'openai-whisper') {
      return !getProviderKey(settings, 'openai');
    }

    return !settings.voice.elevenlabsApiKey?.trim();
  }, [settings]);

  // Track local STT model installation status (relevant for any local provider)
  const [localSttModelInstalled, setLocalSttModelInstalled] = useState<boolean | null>(null);
  const [localSttModelDownloading, setLocalSttModelDownloading] = useState(false);

  useEffect(() => {
    const provider = settings?.voice.provider;
    // Only check model status when a local provider is selected
    if (provider !== 'local-parakeet' && provider !== 'local-moonshine') {
      setLocalSttModelInstalled(null);
      setLocalSttModelDownloading(false);
      return;
    }

    // Determine which modelId to query based on provider
    const modelId = provider === 'local-moonshine' ? 'moonshine-base' : undefined;
    const ipcArgs = modelId ? { modelId } : undefined;

    let isMounted = true;
    const checkModelStatus = async () => {
      try {
        const status = await window.localSttApi.modelStatus(ipcArgs);
        if (isMounted) {
          setLocalSttModelInstalled(status.installed);
          setLocalSttModelDownloading(status.downloading);
        }
      } catch (err) {
        console.error('Failed to check local STT model status:', err);
        if (isMounted) {
          setLocalSttModelInstalled(false);
          setLocalSttModelDownloading(false);
        }
      }
    };

    fireAndForget(checkModelStatus(), 'checkLocalSttModelStatus');

    // Re-check on window focus (catches model changes when app was backgrounded)
    const handleFocus = () => { fireAndForget(checkModelStatus(), 'checkLocalSttModelOnFocus'); };
    window.addEventListener('focus', handleFocus);

    // Listen for model download progress and completion
    // Filter by the modelId matching the current provider
    const expectedModelId = provider === 'local-moonshine' ? 'moonshine-base' : 'parakeet-v3';
    const cleanup = window.api?.onLocalSttModelProgress?.((progress: { status: string; modelId?: string }) => {
      if (!isMounted) return;
      // Only react to progress events for the currently selected provider's model
      const eventModelId = progress.modelId ?? 'parakeet-v3';
      if (eventModelId !== expectedModelId) return;

      if (progress.status === 'downloading' || progress.status === 'extracting') {
        setLocalSttModelDownloading(true);
      } else if (progress.status === 'complete') {
        setLocalSttModelInstalled(true);
        setLocalSttModelDownloading(false);
      } else if (progress.status === 'error' || progress.status === 'cancelled') {
        setLocalSttModelInstalled(false);
        setLocalSttModelDownloading(false);
      }
    });

    return () => {
      isMounted = false;
      window.removeEventListener('focus', handleFocus);
      cleanup?.();
    };
  }, [settings?.voice.provider, settingsOpen]); // Re-check when settings closes (model may have been installed/removed)

  // Local model is missing if any local provider is selected AND model is not positively confirmed installed
  const localModelMissing = (settings?.voice.provider === 'local-parakeet' || settings?.voice.provider === 'local-moonshine') && localSttModelInstalled !== true;
  // Local model is actively downloading (mic stays blocked via localModelMissing; this is for UI messaging)
  const localModelDownloading = (settings?.voice.provider === 'local-parakeet' || settings?.voice.provider === 'local-moonshine') && localSttModelDownloading;

  // Core configuration required to use the app (voice key is optional - mic button handles gracefully)
  // Must stay consistent with hasValidAuth() in authEnvUtils.ts
  const missingConfiguration = useMemo(() => {
    if (!settings) return true;
    const modelSettings = resolveModelSettings(settings);
    const hasLlmAuth =
      Boolean(modelSettings?.apiKey) ||
      Boolean(settings.openRouter?.enabled && settings.openRouter?.oauthToken) ||
      settings.activeProvider === 'codex' ||
      // Mindstone managed-subscription users: auth is server-side, so the
      // active subscription itself satisfies the LLM-auth requirement. Provider
      // activation is independently gated by `subscription.routingAvailable`.
      settings.activeProvider === 'mindstone';
    return !settings.coreDirectory || !hasLlmAuth;
  }, [settings]);

  const {
    recording: _recording,
    setVoiceHint,
    voiceGuardTriggered,
    isVoiceMode: _isVoiceMode,
    setVoiceMode,
    autoSpeak,
    setAutoSpeak,
    mediaRecorder: _mediaRecorder,
    computedVoiceHint: _computedVoiceHint,
    stopRecording,
    cancelRecording,
    toggleRecording,
    audioLevel: _voiceAudioLevel
  } = useVoiceRecording({
    missingConfiguration,
    localModelNotReady: localModelMissing,
    isStopping,
    isSpeaking,
    currentSessionId,
    emitLog,
    recordBreadcrumb,
    showToast,
    submitVoicePrompt: (text, sessionId) => submitVoicePrompt(text, sessionId),
    setAgentError,
    handleVoiceRunFailure,
    stopSpeech
  });

  // Speaker toggle is session-local state (not persisted to settings)
  // autoSpeak comes from useVoiceRecording hook, defaults to true

  const _handleDeactivateVoiceMode = useCallback(() => {
    setVoiceMode(false);
    stopSpeech();
    showToast({ title: 'Voice mode off' });
  }, [setVoiceMode, showToast, stopSpeech]);

  const handleToggleAutoSpeak = useCallback(() => {
    if (autoSpeak && isSpeaking) {
      stopSpeech();
    }
    setAutoSpeak(!autoSpeak);
  }, [autoSpeak, isSpeaking, setAutoSpeak, stopSpeech]);

  // Auto-speak assistant messages when speaker toggle is on
  useVoiceModeAutoSpeak({ autoSpeak, currentSessionId, messages, eventsByTurn, speakText });

  // Helper to clear composer state after sending a message
  const clearComposerAfterSend = useCallback(() => {
    composerRef.current?.clear();
    pendingVoiceSourceRef.current = false; // Clear voice source flag when composer is cleared
  }, []);

  /**
   * Drop any pending document-annotation `onCommit` callbacks queued
   * for the given session. Call this whenever the user explicitly
   * abandons the composer (Discard dialog confirm, session deletion,
   * etc.) — without it, a later unrelated submit on the same session
   * would silently fire the stale callbacks and clear annotations
   * the user never actually sent.
   *
   * No-op when the session has no pending callbacks. See FIX 1 in
   * docs/plans/260417_centralize_annotations_and_fix_document_send_clear.md.
   */
  const dropPendingDocumentAnnotationOnCommits = useCallback((sessionId: string) => {
    pendingDocumentAnnotationOnCommitRef.current.delete(sessionId);
  }, []);

  /**
   * Wrapper around `handleDraftDiscardConfirm` that first drops any
   * pending document-annotation onCommits for the current session.
   * When the user confirms "Discard" in the draft discard dialog they
   * are explicitly abandoning the composer contents — which includes
   * the formatted annotation message pre-filled by "Send to Rebel".
   * Without this drop, a subsequent unrelated submit on the same
   * session would silently clear the staged annotations.
   */
  const handleDraftDiscardConfirmAndDrop = useCallback(() => {
    const sessionId = getSessionStoreState().currentSessionId;
    if (sessionId) {
      dropPendingDocumentAnnotationOnCommits(sessionId);
    }
    handleDraftDiscardConfirm();
  }, [dropPendingDocumentAnnotationOnCommits, handleDraftDiscardConfirm]);

  // Inline transcription for the composer mic button.
  // Normal flow: inserts transcript into composer for review before sending.
  // Session-switch flow: if user navigates away during transcription, auto-sends to
  // original session (same as voice mode) to avoid losing the recording.
  const {
    isRecording: isTranscribing,
    isProcessing: isTranscribeProcessing,
    toggleRecording: handleToggleTranscription,
    stopAndSend: handleStopAndSend,
    audioLevel: transcriptionAudioLevel
  } = useTranscriptionMic({
    currentSessionId,
    onTranscript: (text, sessionId) => {
      // Get CURRENT session ID at callback time (not stale closure value)
      // This is critical because the callback fires after an async transcription delay,
      // during which the user may have switched sessions
      const currentSession = getSessionStoreState().currentSessionId;
      
      // User switched sessions during transcription - auto-send to original session
      // to preserve the recording (inserting into wrong session's composer would be confusing)
      if (sessionId !== currentSession) {
        fireAndForget(submitVoicePrompt(text, sessionId), 'voiceCrossSessionSend');
        return;
      }
      // Same session - insert into composer for user to review/edit before sending
      composerRef.current?.insertAtCursor(toComposerWireMarkdown(text));
      // Mark that current composer content came from voice transcription
      pendingVoiceSourceRef.current = true;
    },
    onTranscriptAndSend: (text, sessionId) => {
      lastUserSubmitAtRef.current = Date.now();
      const storeState = getSessionStoreState();
      const queueMode: QueueMode | undefined = storeState.isBusy ? 'queue' : undefined;

      if (sessionId !== storeState.currentSessionId) {
        fireAndForget(
          submitVoicePrompt(text, sessionId, queueMode),
          'voiceSendNow',
        );
        return;
      }

      fireAndForget((async () => {
        const existingPrompt = composerRef.current?.getText()?.trim() ?? '';
        const prompt = existingPrompt ? `${existingPrompt} ${text}` : text;
        const fileAttachments = composerRef.current?.getAttachments() ?? [];
        const editTargetMessageId = editingMessageId;

        try {
          const allAttachments = await buildAttachmentsForPrompt(prompt, fileAttachments);

          if (!existingPrompt) {
            pendingDocumentAnnotationOnCommitRef.current.delete(sessionId);
          }
          const stashedEntries = existingPrompt
            ? pendingDocumentAnnotationOnCommitRef.current.get(sessionId)
            : undefined;
          if (stashedEntries) {
            pendingDocumentAnnotationOnCommitRef.current.delete(sessionId);
          }

          let ipcPrompt = prompt;
          let displayText: string | undefined;
          if (stashedEntries) {
            for (const entry of stashedEntries) {
              if (prompt.includes(entry.messageSnapshot) && entry.fencedMessage) {
                ipcPrompt = ipcPrompt.replace(entry.messageSnapshot, entry.fencedMessage);
                displayText = prompt;
              }
            }
          }

          const pendingOnCommits = stashedEntries
            ? stashedEntries.map((entry) => entry.onCommit)
            : undefined;
          const composedOnCommit: (() => Promise<void>) | undefined =
            pendingOnCommits && pendingOnCommits.length > 0
              ? async () => {
                  for (const cb of pendingOnCommits) {
                    try {
                      await cb();
                    } catch (err) {
                      emitLog({
                        level: 'error',
                        message: 'Composed annotation onCommit callback failed',
                        context: {
                          sessionId,
                          error: err instanceof Error ? err.message : String(err),
                        },
                        timestamp: Date.now(),
                      });
                    }
                  }
                }
              : undefined;

          const baseOptions = editTargetMessageId
            ? { editTargetMessageId, queueMode, targetSessionId: sessionId }
            : { queueMode, targetSessionId: sessionId };
          const optionsWithDisplay = displayText !== undefined
            ? { ...baseOptions, displayText }
            : baseOptions;
          const options = editTargetMessageId || !composedOnCommit
            ? optionsWithDisplay
            : { ...optionsWithDisplay, onCommit: composedOnCommit };

          await submitQueuedMessage(ipcPrompt, 'voice', allAttachments, options);
          await finalizePendingTaskExecution();

          const currentAttachments = composerRef.current?.getAttachments() ?? [];
          const composerStillMatchesSnapshot =
            (composerRef.current?.getText()?.trim() ?? '') === existingPrompt &&
            currentAttachments.length === fileAttachments.length &&
            currentAttachments.every((attachment, index) => attachment === fileAttachments[index]);

          if (getSessionStoreState().currentSessionId === sessionId && composerStillMatchesSnapshot) {
            clearComposerAfterSend();
            if (editTargetMessageId) {
              cancelEditMessage();
            }
          }
        } catch (attachmentError) {
          showToast({
            title: attachmentError instanceof Error ? attachmentError.message : 'Unable to attach mentioned files'
          });
        }
      })(), 'voiceSendNow');
    },
    onError: (message) => {
      showToast({ title: message });
      emitLog({
        level: 'error',
        message: 'Inline transcription failed',
        context: { error: message },
        timestamp: Date.now()
      });
    },
    minDurationMs: 500,
    minBlobSizeBytes: 1000,
    onRecordingStarted: () => {
      emitLog({
        level: 'info',
        message: 'Inline transcription recording started',
        timestamp: Date.now()
      });
    },
    onValidationFailed: (reason, context) => {
      switch (reason) {
        case 'too_short':
          showToast({ title: 'Too short to catch — hold the button a bit longer' });
          emitLog({
            level: 'warn',
            message: 'Inline transcription recording too short',
            context: { durationMs: context?.durationMs },
            timestamp: Date.now()
          });
          break;
        case 'no_audio':
          showToast({ title: 'No audio captured — check your microphone permissions' });
          break;
        case 'empty_result':
          showToast({ title: "Couldn't make out any words — try speaking closer to the mic" });
          break;
      }
    },
    onMarkPendingRecording: markSessionHasPendingRecording,
    onClearPendingRecording: clearSessionPendingRecording
  });

  useEffect(() => {
    activeTurnIdRef.current = activeTurnId;
  }, [activeTurnId]);

  useEffect(() => {
    isTranscribingRef.current = isTranscribing;
  }, [isTranscribing]);

  useEffect(() => {
    composerHasTextRef.current = composerHasText;
  }, [composerHasText]);

  const getUserWorkSignalsForCooldown = useCallback(() => ({
    activeTurn: activeTurnIdRef.current !== null,
    recentSubmit: (Date.now() - lastUserSubmitAtRef.current) < 5_000,
    voiceActive: isTranscribingRef.current,
    composerHasText: composerHasTextRef.current,
  }), []);

  const navigateToDiagnosticsFromCooldown = useCallback(() => {
    setActiveSurface('settings');
    fireAndForget(
      openSettingsDialog('diagnostics', 'recentActivity', {
        source: 'link',
        interactionType: 'programmatic',
      }),
      'navigateToDiagnosticsFromCooldown',
    );
  }, [openSettingsDialog, setActiveSurface]);

  const navigateToAgentsSettingsFromCooldown = useCallback(() => {
    setActiveSurface('settings');
    fireAndForget(
      openSettingsDialog('agents'),
      'navigateToAgentsSettingsFromCooldown',
    );
  }, [openSettingsDialog, setActiveSurface]);

  const hasBackgroundFallbackConfiguredForCooldown = useCallback(
    () => typeof settings?.backgroundFallback === 'string' && settings.backgroundFallback.trim().length > 0,
    [settings?.backgroundFallback],
  );

  useApiCooldownEvents({
    getUserWorkSignals: getUserWorkSignalsForCooldown,
    showToast,
    navigateToDiagnostics: navigateToDiagnosticsFromCooldown,
    navigateToAgentsSettings: navigateToAgentsSettingsFromCooldown,
    hasBackgroundFallbackConfigured: hasBackgroundFallbackConfiguredForCooldown,
  });

  const quickCapture = useQuickCapture();

  // Homepage: inactivity detection — after 15 min idle, arms an
  // "isReturningFromIdle" flag so the homepage can show the "Welcome back"
  // state IF the user chooses to navigate there. Intentionally does not
  // force-navigate: the user stays on whatever surface they last left
  // (REBEL-5F6 / FOX-3274).
  const { isReturningFromIdle } = useInactivityReturn({
    activeSurface,
    isBusy,
    isVoiceActive: isTranscribing,
    enabled: Boolean(settings?.onboardingCompleted),
  });

  // Global keyboard shortcuts (ESC, Cmd+I)
  useAppKeyboardShortcuts({
    isTextMode,
    setIsTextMode,
    setVoiceMode,
    stopSpeech,
    cancelRecording,
    focusCommandInput: focusComposer,
    setActiveSurface,
    setShowConversation,
    isBusy,
    isStopping,
    stopActiveTurn,
    documentPreviewOpen,
  });

  useEffect(() => {
    stopRecordingRef.current = stopRecording;
  }, [stopRecording]);

  useEffect(() => {
    cancelRecordingRef.current = cancelRecording;
  }, [cancelRecording]);

  useEffect(() => {
    if (!playbackError) {
      return;
    }
    setVoiceMode(false);
    showToast({ title: `Voice mode disabled: ${playbackError}` });
    clearPlaybackError();
  }, [clearPlaybackError, playbackError, setVoiceMode, showToast]);

  useEffect(() => {
    if (showConversation) {
      setVoiceHint('');
    }
  }, [setVoiceHint, showConversation]);

  // Start voice transcription after session reset completes (from voice hotkey)
  // Uses session ID matching to prevent unexpected triggers from other session changes
  useEffect(() => {
    if (pendingVoiceHotkeySessionRef.current === currentSessionId && !isTranscribing) {
      pendingVoiceHotkeySessionRef.current = null;
      handleToggleTranscription();
    }
  }, [currentSessionId, isTranscribing, handleToggleTranscription]);

  const _simulateMicTap = useCallback(() => {
    try {
      toggleRecording();
    } catch (error) {
      emitLog({
        level: 'warn',
        message: 'Failed to trigger mic via hotkey',
        context: {
          error: error instanceof Error ? error.message : String(error)
        },
        timestamp: Date.now()
      });
    }
  }, [emitLog, toggleRecording]);

  const loadWorkspaceFile = useCallback(
    async (filePath: string) => {
      if (!filePath) return;
      try {
        await libraryDrawerRef.current?.openFile(filePath);
        // Only switch to Library surface after the file loads successfully.
        // If the file doesn't exist, callers handle the error (e.g., toast).
        setActiveSurface('library');
      } catch (error) {
        emitLog({
          level: 'error',
          message: 'Failed to open library file via drawer',
          context: {
            path: filePath,
            error: error instanceof Error ? error.message : String(error)
          },
          timestamp: Date.now()
        });
        // Re-throw so callers can handle fallback behavior (e.g., show toast)
        throw error;
      }
    },
    [emitLog, setActiveSurface]
  );

  // Open document in the right-side preview panel (stays in conversation context)
  // For supported files, shows inline preview; for others, falls back to library
  const handleOpenDocumentInPreview = useCallback(
    (filePath: string) => {
      if (!filePath) return;
      
      // Check if this is an absolute path outside the workspace
      const coreDir = settingsRef.current?.coreDirectory;
      const isAbsolutePath = filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath);
      if (isAbsolutePath && (!coreDir || !filePath.startsWith(coreDir))) {
        // External file - open with system's default handler.
        // FOX-3422: surface a toast on failure instead of swallowing the rejection.
        void window.appApi.openPath(filePath).catch((error) =>
          showPathOpenFailureToast(error, showToast),
        );
        return;
      }
      
      const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
      const isSupported = PREVIEW_SUPPORTED_TEXT.has(ext) || 
                          PREVIEW_SUPPORTED_IMAGE.has(ext) || 
                          PREVIEW_SUPPORTED_VIDEO.has(ext) || 
                          PREVIEW_SUPPORTED_AUDIO.has(ext) ||
                          PREVIEW_SUPPORTED_HTML.has(ext) ||
                          PREVIEW_SUPPORTED_PDF.has(ext);
      if (isSupported) {
        // Open in side preview panel
        openDocumentPreview(filePath);
      } else {
        // Unsupported file type - open in library instead
        fireAndForget(loadWorkspaceFile(filePath), 'loadUnsupportedFile');
      }
    },
    [openDocumentPreview, loadWorkspaceFile, showToast]
  );

  // Opens a tutorial in the document preview drawer
  // Tutorials are HTML files from rebel-system/help-for-humans/tutorials/
  const handleOpenTutorial = useCallback(
    (tutorialPath: string) => {
      if (!tutorialPath) return;
      openDocumentPreview(tutorialPath);
    },
    [openDocumentPreview]
  );

  const handleOpenDocumentInPreviewAsync = useCallback(
    async (filePath: string) => {
      handleOpenDocumentInPreview(filePath);
    },
    [handleOpenDocumentInPreview]
  );

  // Opens file in library from the document preview drawer.
  // Navigates the Library tree to the enclosing folder so the user
  // can see where the file lives, then opens it in the editor.
  const handleOpenInLibraryFromPreview = useCallback(
    async (filePath: string) => {
      const ok = await docPreviewEditorRef.current?.closeAllDocuments();
      // closeAllDocuments returns:
      //   - true: flush succeeded, close proceeded
      //   - false: flush rejected, abort navigation (Class A Batch 1)
      //   - undefined: no preview editor mounted — nothing to flush, proceed.
      if (ok === false) return;
      closeDocumentPreview();
      const enclosingFolder = filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
      if (enclosingFolder) {
        navigateToLibraryLens({ filter: 'spaces' }, { folderPath: enclosingFolder });
      }
      await loadWorkspaceFile(filePath);
    },
    [closeDocumentPreview, loadWorkspaceFile, navigateToLibraryLens]
  );

  // Navigates to a folder in the library from the document preview drawer
  const handleNavigateToFolderFromPreview = useCallback(
    async (folderPath: string) => {
      const ok = await docPreviewEditorRef.current?.closeAllDocuments();
      // closeAllDocuments returns:
      //   - true: flush succeeded, close proceeded
      //   - false: flush rejected, abort navigation (Class A Batch 1)
      //   - undefined: no preview editor mounted — nothing to flush, proceed.
      if (ok === false) return;
      closeDocumentPreview();
      navigateToLibraryLens({ filter: 'spaces' }, { folderPath });
    },
    [closeDocumentPreview, navigateToLibraryLens]
  );

  const handleRevealInTreeFromPreview = useCallback(
    async (filePath: string) => {
      const ok = await docPreviewEditorRef.current?.closeAllDocuments();
      if (ok === false) return;
      closeDocumentPreview();
      navigateToLibraryLens({ filter: 'spaces' }, { folderPath: filePath, revealInTree: true });
    },
    [closeDocumentPreview, navigateToLibraryLens],
  );

  // Uses refs for settings/libraryIndex to avoid callback recreation when they load
  // Inlines relative path logic to avoid dependency on getRelativeLibraryPath (which has coreDirectory dep)
  const handleOpenWorkspaceFolder = useCallback(
    (folderPath: string) => {
      if (!folderPath) return;

      // Convert absolute path to relative if needed (inline logic, use ref for stable callback)
      let relativePath = folderPath;
      const coreDir = settingsRef.current?.coreDirectory;
      const isAbsolutePath = folderPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(folderPath);
      
      if (coreDir && folderPath.startsWith(coreDir)) {
        // Inline version of getRelativeLibraryPath
        const sliceStart = coreDir.endsWith('/') ? coreDir.length : coreDir.length + 1;
        relativePath = folderPath.slice(sliceStart) || folderPath;
      } else if (isAbsolutePath) {
        // Absolute path outside workspace - reveal in system file browser instead.
        // FOX-3422: surface a toast on failure instead of swallowing.
        void window.appApi.revealPath(folderPath).then(
          (result) => showPathOpenFailureToast(result, showToast),
          (error) => showPathOpenFailureToast(error, showToast),
        );
        return;
      }

      // Remove trailing slash for navigation (the expand/scroll logic handles either)
      const normalizedPath = relativePath.endsWith('/') ? relativePath.slice(0, -1) : relativePath;

      // For skill folders containing only SKILL.md, auto-open the file in preview (use refs)
      const libIndex = libraryIndexRef.current;
      const libLoaded = libraryIndexLoadedRef.current;
      if (libLoaded && libIndex && isSkillPath(normalizedPath)) {
        const folderEntry = libIndex.find(
          (entry) => entry.node.kind === 'directory' && entry.fullPath === normalizePath(normalizedPath)
        );
        if (folderEntry?.node.children) {
          const children = folderEntry.node.children;
          // Check if folder contains exactly one file named SKILL.md
          if (children.length === 1 && children[0].kind === 'file' && children[0].name === 'SKILL.md') {
            openDocumentPreview(`${normalizedPath}/SKILL.md`);
            return;
          }
        }
      }

      // Navigate to workspace with folder path - the LibraryNavigatorProvider will handle expansion/scroll
      navigateToLibraryLens({ filter: 'spaces' }, { folderPath: normalizedPath });
    },
    [navigateToLibraryLens, openDocumentPreview, showToast]
  );

  // Opens file or folder in library from context menu
  const handleOpenInLibrary = useCallback(
    async (filePath: string, isFolder: boolean) => {
      if (isFolder) {
        handleOpenWorkspaceFolder(filePath);
      } else {
        await loadWorkspaceFile(filePath);
      }
    },
    [handleOpenWorkspaceFolder, loadWorkspaceFile]
  );

  const handleQuickOpenSelect = useCallback(
    (node: import('@shared/types').FileNode) => {
      if (node.kind === 'file') {
        handleOpenDocumentInPreview(node.path);
      } else if (node.kind === 'directory') {
        // Navigate to folder in Library
        handleOpenWorkspaceFolder(node.path);
      }
    },
    [handleOpenDocumentInPreview, handleOpenWorkspaceFolder]
  );








  // Turn data processing
  const {
    turnStepContextByTurn,
    turnSummaries,
    subAgentTimelineByTurn,
    visibleTurnId,
    selectedTurnId: _selectedTurnId,
    resolveTurnIdForMessage,
    assistantEvents,
    assistantSteps,
    turnEvents,
  } = useTurnData({
    eventsByTurn,
    messages,
    focusedTurnId
  });

  // Validate activeStepByTurn when turn context changes
  // PERF FIX: Use ref to check if update is needed BEFORE calling setState
  // This avoids triggering re-renders when no actual changes are needed.
  // Note: activeStepByTurn is intentionally omitted from deps - we read it via ref
  // to avoid infinite loop (effect validates/corrects the state it would depend on).
  const activeStepByTurnRef = useRef(activeStepByTurn);
  activeStepByTurnRef.current = activeStepByTurn;
  
  useEffect(() => {
    const prev = activeStepByTurnRef.current;
    let didChange = false;
    const next = { ...prev };
    for (const [turnId, selectedStep] of Object.entries(prev)) {
      const data = turnStepContextByTurn[turnId];
      if (!data) {
        delete next[turnId];
        didChange = true;
        continue;
      }
      if (selectedStep !== null && (selectedStep < 1 || selectedStep > data.assistantSteps.length)) {
        next[turnId] = null;
        didChange = true;
      }
    }
    // Only call setState if there are actual changes
    if (didChange) {
      setActiveStepByTurn(next);
    }
  }, [turnStepContextByTurn]);

  const isViewSessionBusy = currentRuntime.startedAt !== null;

  // Get the last user message for contextual quip generation
  const lastUserMessage = useMemo(() => {
    if (!messages || messages.length === 0) {
      return undefined;
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'user') {
        return messages[i].text;
      }
    }
    return undefined;
  }, [messages]);

  const {
    workSurfaceView: _workSurfaceView,
    isInsightSurface,
    isDiagnosticsSurface,
    isSessionSurface: _isSessionSurface,
    storylineFilters,
    toggleStorylineFilter,
    toggleWorkSurfaceView: _toggleWorkSurfaceView,
    toggleDiagnosticsView,
    resetToSessionView,
    showTechnicalDetails: _showTechnicalDetails,
    setShowTechnicalDetails,
    thinkingStage,
    thinkingHeadline,
    thinkingHint,
    thinkingElapsedLabel,
    thinkingDurationBucket: _thinkingDurationBucket,
    displayStepsCount: _displayStepsCount,
    insightButtonDescription: _insightButtonDescription,
  } = useWorkSurfaceView({
    assistantEvents,
    assistantSteps,
    allTurnEvents: turnEvents,
    isViewSessionBusy,
    runtimeStartedAt: currentRuntime?.startedAt ?? null,
    visibleTurnId,
    sessionId: currentSessionId,
    lastUserMessage
  });

  const handleToggleHistoryPanel = useCallback(() => {
    toggleFlowHistoryOpen();
  }, [toggleFlowHistoryOpen]);


  // Filter messages for live coach sessions when showAllChecks is false
  const visibleMessages = useMemo(() => {
    const selected = selectVisibleMessages(messages);
    
    // If not a meeting companion with coach, or showing all checks, return unfiltered
    const coach = currentSessionMeetingCompanion?.coach;
    if (!coach || coach.showAllChecks !== false) {
      return selected;
    }
    
    // Filter out "nothing to add" style coaching responses
    // Keep user messages (coaching checks) but hide their responses if they're routine
    const nothingToAddPatterns = [
      /nothing to add/i,
      /no coaching/i,
      /no actionable/i,
      /nothing notable/i,
      /no specific tip/i,
      /no immediate/i,
    ];
    
    // Use a Set to track indices to hide (avoids mutating message objects)
    const indicesToHide = new Set<number>();
    
    selected.forEach((msg, idx) => {
      // Only check assistant messages
      if (msg.role !== 'assistant') return;
      
      // Check if assistant response is a "nothing to add" message
      const isNothingToAdd = nothingToAddPatterns.some(pattern => pattern.test(msg.text));
      if (!isNothingToAdd) return;
      
      // Find the preceding user message with same turnId
      let precedingUserMsg: typeof selected[0] | undefined;
      for (let i = idx - 1; i >= 0; i--) {
        if (selected[i].turnId === msg.turnId && selected[i].role === 'user') {
          precedingUserMsg = selected[i];
          break;
        }
      }
      
      // Only hide if the preceding user message is a coaching check (starts with [Coaching check])
      // This prevents hiding legitimate conversations where the assistant happens to say "nothing to add"
      if (!precedingUserMsg || !precedingUserMsg.text.startsWith('[Coaching check]')) {
        return;
      }
      
      // Hide both the routine response AND its preceding coaching check user message
      indicesToHide.add(idx);
      const precedingIdx = selected.indexOf(precedingUserMsg);
      if (precedingIdx >= 0) {
        indicesToHide.add(precedingIdx);
      }
    });
    
    return selected.filter((_, idx) => !indicesToHide.has(idx));
  }, [messages, currentSessionMeetingCompanion]);

  // Track when text selection context menu is open - used to pause auto-scroll during streaming
  const [isSelectionMenuOpen, setIsSelectionMenuOpen] = useState(false);
  const handleSelectionMenuOpenChange = useCallback((isOpen: boolean) => {
    setIsSelectionMenuOpen(isOpen);
  }, []);

  // Auto-scroll behavior for conversation pane
  const { markPendingHistoryScroll, cancelPendingHistoryScroll, isSettling, isRevealMasked, isScrolledAway, newMessageCount, hasNewMessagesBelow: _hasNewMessagesBelow, isAnswerTopPinned, scrollToLastMessage } = useConversationAutoScroll({
    containerRef: agentSessionLogRef,
    visibleMessages,
    rawMessages: messages,
    processingTurnId: activeTurnId,
    isBusy,
    isInsightSurface,
    isDiagnosticsSurface,
    currentSessionId,
    pauseAutoScroll: isSelectionMenuOpen || isAnnotationActive,
    // Only the short-lived selection menu drives catch-up eligibility; the
    // long-lived annotation popover deliberately does NOT — closing it should
    // leave the user where they were. See:
    // docs-private/investigations/260509_annotation_save_jumps_to_bottom.md
    pauseAutoScrollCatchUpEligible: isSelectionMenuOpen,
    isSurfaceVisible: activeSurface === 'sessions',
  });
  // Track which sessions we've fired the startup-restore scroll-mark for.
  // Prevents double-firing the primitive when the effect below re-runs on
  // `showConversation` transitions. Populated lazily the first time we
  // detect "store rehydrated → non-empty session → not yet shown".
  const startupMarkFiredForSessionRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (messages.length > 0 || Object.keys(eventsByTurn).length > 0) {
      // Only navigate to sessions surface when starting a new session from the landing page
      // (showConversation is false). Once conversation is shown, don't force navigation.
      if (!showConversation && activeSurface !== 'sessions') {
        setActiveSurface('sessions');
      }

      // Startup-restore scroll-mark (covers the implicit restore path):
      // when the persistent store rehydrates with a populated session on
      // app launch, this effect is the first moment we show it. The
      // canonical navigation paths (`handleOpenHistorySession`, etc.)
      // call `markPendingHistoryScroll` BEFORE the pane mounts — but
      // startup-restore has no navigation event and therefore no mark.
      // Without this, the pane renders with `scrollTop=0` and the user
      // lands at the TOP of a potentially long thread rather than the
      // latest message.
      //
      // Ref-keyed to fire once per session-open (this effect re-runs on
      // every `showConversation` flip). If the user later navigates to a
      // different session, that path's own mark-call supersedes. See
      // `docs-private/investigations/260420_long_restored_conversation_scroll_short.md`.
      const wasNotShown = !showConversation;
      const alreadyMarked = currentSessionId
        ? startupMarkFiredForSessionRef.current.has(currentSessionId)
        : false;

      if (wasNotShown && currentSessionId && !alreadyMarked) {
        startupMarkFiredForSessionRef.current.add(currentSessionId);
        // Startup-restore: mark-time == pending target == the restored session
        // (there is no "previous" session being navigated away from).
        markPendingHistoryScroll(currentSessionId, currentSessionId);
      }

      setShowConversation(true);
    }
  }, [messages.length, eventsByTurn, activeSurface, showConversation, setActiveSurface, setShowConversation, currentSessionId, markPendingHistoryScroll]);

  const handleBeginEditMessage = useCallback(
    (messageId: string) => {
      const target = beginEditMessage(messageId);
      if (!target) {
        return;
      }

      setShowConversation(true);
      setFlowHistoryOpen(true);
      setIsTextMode(true);
      composerRef.current?.setText(toComposerWireMarkdown(target.displayText ?? target.text ?? ''));
    },
    [beginEditMessage, setFlowHistoryOpen, setIsTextMode, setShowConversation]
  );

  // Uses messagesRef to avoid callback recreation when messages change
  // Routes through submitQueuedMessage (not rerunEditedMessage directly) to ensure
  // proper isBusy checks and queue semantics - prevents duplicate turn execution
  const handleRetryMessage = useCallback(
    (messageId: string) => {
      const target = messagesRef.current.find((m) => m.id === messageId);
      if (!target || target.role !== 'user') {
        return;
      }
      fireAndForget(
        sendUserPrompt(target.text, 'text', { editTargetMessageId: messageId }),
        'retryEditedMessage',
      );
    },
    [sendUserPrompt]
  );

  // Workspace visibility is handled by the active surface in FlowPanelsShell; no-op here

  // ═══════════════════════════════════════════════════════════════════════════════
  // SECTION: Event Handlers & Callbacks
  // User action handlers, navigation callbacks, and orchestration logic.
  // New handlers should be added to feature-specific hooks when possible.
  // ═══════════════════════════════════════════════════════════════════════════════

  const resetConversationState = useCallback(() => {
    // Belt: drop any pending history-scroll mark so an interrupted history-open
    // can't leave the reveal mask stuck over the fresh chat. The mechanism that
    // kills this class by construction is the mark-time orphan guard in
    // useConversationAutoScroll; this just makes new-chat supersede semantics
    // explicit at the call site. See docs/plans/260611_fix-stuck-reveal-mask/PLAN.md.
    cancelPendingHistoryScroll();
    recordBreadcrumb({ type: 'conversation', message: 'reset', timestamp: Date.now() });
    cancelRecordingSafe();
    stopSpeech();
    setVoiceMode(false);

    // Flush any pending draft to the store BEFORE resetting session state.
    // The composer uses debounced writes (1000ms), so if we don't flush here,
    // calling clear() will cancel the pending write and the draft is lost.
    // We flush even when text is empty — this ensures a cleared draft is
    // persisted (setDraftForSession treats '' as "delete draft entry").
    const draftText = composerRef.current?.getText()?.trim();
    if (draftText !== undefined && currentSessionId) {
      getSessionStoreState().setDraftForSession(currentSessionId, draftText);
    }

    pendingTaskExecutionRef.current = null;
    resetSessionState();
    setPendingInputSource(null);
    setShowTechnicalDetails(false);
    setVoiceHint(DEFAULT_VOICE_STATUS);
    composerRef.current?.clear();
    if (isTextMode) {
      composerRef.current?.focus();
    }
  }, [
    isTextMode,
    currentSessionId,
    cancelPendingHistoryScroll,
    recordBreadcrumb,
    resetSessionState,
    setShowTechnicalDetails,
    setVoiceHint,
    setVoiceMode,
    setPendingInputSource,
    cancelRecordingSafe,
    stopSpeech
  ]);

  const executeNewChat = useCallback(() => {
    resetConversationState();
    setSelectedTrashedSessionId(null); // Clear any trashed session selection
    setActiveSurface('sessions');
    setShowConversation(true);
    requestAnimationFrame(() => {
      focusComposer();
    });
  }, [resetConversationState, setActiveSurface, setShowConversation, focusComposer]);

  const handleNewChat = useCallback((source?: 'header_button' | 'sidebar_button' | 'brand_button' | 'collapsed_tabs' | 'keyboard_shortcut') => {
    tracking.navigation.newConversationClicked(source);
    checkAttachmentsBeforeAction(executeNewChat);
  }, [checkAttachmentsBeforeAction, executeNewChat]);

  const handleDownloadDiagnostics = useCallback(async () => {
    showToast({ title: 'Gathering diagnostics — this takes a moment', duration: 15000 });
    // Defense-in-depth renderer-side timeout (mirrors the ZIP path): ensures the
    // toast always resolves even if the IPC round-trip never settles.
    const RENDERER_EXPORT_TIMEOUT_MS = 45000;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      // Use standard markdown format (safer for external sharing)
      // Users can access detailed ZIP format via Settings → Advanced
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error('Diagnostic report timed out')),
          RENDERER_EXPORT_TIMEOUT_MS,
        );
      });
      const result = await Promise.race([
        window.systemHealthApi.healthExportWithLogs({ logWindowMinutes: 15 }),
        timeoutPromise,
      ]);
      if (!result.content || !result.filename) {
        throw new Error('Failed to generate diagnostic report');
      }
      const blob = new Blob([result.content], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast({ title: 'Diagnostic report downloaded', variant: 'success' });
    } catch (error) {
      emitLog({
        level: 'error',
        message: 'Failed to download diagnostics',
        context: { error: String(error) },
        timestamp: Date.now()
      });
      showToast({ title: "Couldn't download diagnostic report", variant: 'error' });
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }, [showToast, emitLog]);

  const handleDownloadDetailedDiagnostics = useCallback(async () => {
    showToast({ title: 'Preparing detailed diagnostic bundle...', duration: 15000 });
    // Defense-in-depth: the main process bounds bundle assembly with its own
    // deadline (Stage 2), but if the IPC round-trip itself never settles the
    // toast would hang on "preparing" forever. Race the invoke against a
    // renderer-side timeout so this handler ALWAYS resolves to success /
    // partial / failure. (The timeout can't cancel main-process work; it only
    // releases the renderer.)
    const RENDERER_EXPORT_TIMEOUT_MS = 45000;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error('Diagnostic bundle timed out')),
          RENDERER_EXPORT_TIMEOUT_MS,
        );
      });
      const result = await Promise.race([
        window.systemHealthApi.healthExportZip({ logWindowMinutes: 15 }),
        timeoutPromise,
      ]);
      if (!result.success || !result.data || !result.filename) {
        throw new Error(result.error || 'Failed to generate diagnostic bundle');
      }
      const blob = new Blob([result.data], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      if (result.partial) {
        // Some sections couldn't be gathered (collector timed out, or the
        // minimal fallback was used) — still a usable bundle, but say so.
        showToast({
          title: 'Partial diagnostic bundle downloaded',
          description: 'Some sections were unavailable, but the rest is included.',
          variant: 'warning',
        });
      } else {
        showToast({ title: 'Diagnostic bundle downloaded', variant: 'success' });
      }
    } catch (error) {
      emitLog({
        level: 'error',
        message: 'Failed to download detailed diagnostics',
        context: { error: String(error) },
        timestamp: Date.now()
      });
      showToast({ title: "Couldn't download diagnostic bundle", variant: 'error' });
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }, [showToast, emitLog]);

  const handleCheckForUpdates = useCallback(async () => {
    const currentVersion = window.electronEnv?.appVersion || 'unknown';
    try {
      showToast({ title: 'Checking for updates...' });
      
      // First try the native auto-updater (will trigger download dialog if update found)
      const autoUpdateResult = await window.miscApi.checkForUpdates();
      
      if (autoUpdateResult.available) {
        // Check if the update is already downloaded and ready to install.
        // Pass ignoreAck so user-initiated checks always surface a downloaded update
        // even if the toast was previously shown and dismissed this session.
        const pendingResult = await window.miscApi.getPendingDownloaded?.({ ignoreAck: true });
        if (pendingResult?.pending) {
          setUpdateAvailable({
            updateKey: pendingResult.pending.updateKey,
            version: pendingResult.pending.versionLabel,
            downloadUrl: pendingResult.pending.downloadUrl,
            recoveryAttempts: pendingResult.recoveryAttempts ?? 0,
          });
          return;
        }
        // Still downloading — show interim toast
        showToast({ title: `Downloading update ${autoUpdateResult.version || ''}. It will be ready in a moment.` });
        return;
      }
      
      // No update via auto-updater, check manifest for version comparison
      const manifestResult = await window.miscApi.fetchUpdateManifest();
      
      if (!manifestResult.success || !manifestResult.manifest) {
        if (!autoUpdateResult.error) {
          showToast({ title: "You're on the latest version" });
        } else {
          showToast({ title: "Couldn't check for updates" });
        }
        return;
      }
      
      const manifest = manifestResult.manifest;
      const comparison = compareVersions(currentVersion, manifest.version);
      
      if (comparison < 0) {
        const platformKey = (() => {
          const p = window.electronEnv?.platform;
          const a = window.electronEnv?.arch;
          if (!p || !a) return '';
          if (p === 'darwin') return `mac-${a}`;
          if (p === 'win32') return `win-${a}`;
          if (p === 'linux') return `linux-${a}`;
          return `${p}-${a}`;
        })();
        const downloadUrl = platformKey ? manifest.platforms[platformKey]?.url : undefined;
        showToast({
          title: `Update available: v${manifest.version}`,
          description: downloadUrl ? 'Click to download the latest version.' : 'Visit mindstone.ai to download.',
          duration: 15000,
          ...(downloadUrl && {
            action: {
              label: 'Download',
              onClick: () => { void window.appApi.openUrl(downloadUrl); },
            },
          }),
        });
      } else {
        showToast({ title: "You're on the latest version" });
      }
    } catch (error) {
      emitLog({
        level: 'error',
        message: 'Failed to check for updates',
        context: { error: String(error) },
        timestamp: Date.now()
      });
      showToast({ title: "Couldn't check for updates — your connection might be the culprit" });
    }
  }, [showToast, emitLog, setUpdateAvailable]);

  const handleVoiceActivationHotkey = useCallback((payload?: import('./hooks/useVoiceHotkeyListener').VoiceActivationHotkeyPayload) => {
    const currentHotkeyLabel = formatAcceleratorDisplay(settings?.voice.activationHotkey ?? null);

    // If already transcribing, stop and let the transcript be inserted
    // Note: When stopping, we ignore any screenshot in the payload (it was captured but we don't need it)
    if (isTranscribing) {
      showToast({
        title: currentHotkeyLabel
          ? `🎙️ Transcribing via ${currentHotkeyLabel}`
          : '🎙️ Transcribing…'
      });
      handleToggleTranscription();
      return;
    }

    if (missingConfiguration) {
      showToast({ title: 'Configure your library and voice provider before using the hotkey.' });
      return;
    }

    if (localModelMissing) {
      showToast({
        title: localModelDownloading
          ? 'Voice model is still downloading \u2014 it\u2019ll be ready in a moment.'
          : 'Voice model needs to be downloaded. Check Settings \u2192 Voice.',
      });
      return;
    }

    if (voiceGuardTriggered) {
      showToast({ title: 'Microphone access is blocked. Enable it in System Settings → Privacy & Security.' });
      return;
    }

    if (!settings) {
      showToast({ title: 'Settings are still loading — give it a moment' });
      return;
    }

    const formattedHotkey = formatAcceleratorDisplay(settings.voice.activationHotkey ?? null);

    // Determine screenshot status for user feedback (shown after voice toast)
    let screenshotStatus: 'success' | 'permission-error' | 'failed' | 'none' = 'none';
    if (payload?.screenshot) {
      screenshotStatus = 'success';
    } else if (payload?.screenshotError === 'screen-permission') {
      screenshotStatus = 'permission-error';
    } else if (payload?.screenshotError) {
      screenshotStatus = 'failed';
    }

    recordBreadcrumb({
      type: 'voice',
      message: 'activation-hotkey',
      timestamp: Date.now(),
      data: { accelerator: settings.voice.activationHotkey ?? null, hasScreenshot: !!payload?.screenshot }
    });

    // Track voice hotkey usage
    tracking.voice.hotkeyUsed(settings.voice.activationHotkey ?? '', isTranscribing);

    // Always start a new chat when voice hotkey is pressed
    const newSessionId = resetSessionState();

    // Ensure conversation pane is visible and focused
    setShowConversation(true);
    setActiveSurface('sessions');
    closeSettingsDialog();
    setIsTextMode(true);
    composerRef.current?.clear();

    // Attach screenshot if available (captured before window focus)
    if (payload?.screenshot) {
      const screenshotPayload: import('@shared/types').ImageAttachmentPayload = {
        id: `screenshot-${Date.now()}`,
        name: 'Screenshot',
        type: 'image',
        mimeType: 'image/png',
        base64Data: payload.screenshot.base64Data,
        sizeBytes: payload.screenshot.sizeBytes,
        width: payload.screenshot.width,
        height: payload.screenshot.height,
      };
      // Defer attachment until after session is fully set up
      requestAnimationFrame(() => {
        composerRef.current?.addImageAttachment(screenshotPayload);
      });
    }

    // Show voice activation toast with screenshot status
    const voiceToastBase = formattedHotkey
      ? `🎙️ Listening via ${formattedHotkey}`
      : '🎙️ Listening';
    
    switch (screenshotStatus) {
      case 'success':
        showToast({ title: `📸 ${voiceToastBase} — screenshot included` });
        break;
      case 'permission-error':
        showToast({
          title: `${voiceToastBase} — no screenshot`,
          description: 'Enable Screen Recording permission to capture what\'s on your screen.',
          duration: 8000,
          action: { label: 'Open Settings', onClick: () => { void window.permissionsApi.openSystemPreferences('screen-recording'); } },
        });
        break;
      case 'failed':
        showToast({ title: `${voiceToastBase} — couldn't capture screenshot` });
        break;
      default:
        showToast({ title: `${voiceToastBase} — press again to stop` });
    }

    // Defer transcription start until after session state updates
    // Store target session ID to prevent unexpected triggers from other session changes
    pendingVoiceHotkeySessionRef.current = newSessionId;
  }, [
    closeSettingsDialog,
    handleToggleTranscription,
    isTranscribing,
    localModelDownloading,
    localModelMissing,
    missingConfiguration,
    recordBreadcrumb,
    resetSessionState,
    setActiveSurface,
    setIsTextMode,
    setShowConversation,
    settings,
    showToast,
    voiceGuardTriggered
  ]);

  // Voice activation hotkey listener (IPC subscription with ref pattern)
  useVoiceHotkeyListener(handleVoiceActivationHotkey);

  // In-app shortcut to toggle voice recording in the current conversation
  // Only active when a conversation is visible (not on Settings, Home, Library, etc.)
  // Guard: allow stopping (isTranscribing), but block starting when local model isn't ready
  const handleInlineVoiceShortcutToggle = useCallback(() => {
    if (!isTranscribing && localModelMissing) {
      showToast({
        title: localModelDownloading
          ? 'Voice model is still downloading \u2014 it\u2019ll be ready in a moment.'
          : 'Voice model needs to be downloaded. Check Settings \u2192 Voice.',
      });
      return;
    }
    handleToggleTranscription();
  }, [isTranscribing, localModelMissing, localModelDownloading, showToast, handleToggleTranscription]);

  useInlineVoiceShortcut({
    accelerator: showConversation ? (settings?.voice.inlineVoiceHotkey ?? null) : null,
    onToggle: handleInlineVoiceShortcutToggle,
  });

  const executeOpenHistorySession = useCallback(
    async (sessionId: string, source?: SessionResumeSource, options?: SessionOpenOptions): Promise<boolean> => {
      // Stop (not cancel) recording so transcription completes and routes to original session
      // via recordingSessionIdRef. Cancelling would lose the recording entirely.
      stopRecordingSafe();
      stopSpeech();
      setVoiceMode(false);
      const shouldMaskDuringOpen = options?.transition !== 'instant';
      const scheduleInstantScroll = () => {
        requestAnimationFrame(() => {
          if (getSessionStoreState().currentSessionId !== sessionId) return;
          scrollToLastMessage({ behavior: 'auto' });
        });
      };

      recordBreadcrumb({
        type: 'conversation',
        message: 'open-history-session',
        timestamp: Date.now(),
        data: { sessionId }
      });

      // Get session info before opening for tracking (use ref to avoid callback recreation)
      const sessionSummary = sessionSummariesRef.current.find((s) => s.id === sessionId);
      const messageCount = sessionSummary?.messageCount ?? 0;
      const sessionAge = sessionSummary ? Date.now() - sessionSummary.createdAt : 0;

      // Deleted sessions open read-only: load the transcript as usual, but flag
      // the session so the conversation surface shows a Trash banner and disables
      // the composer (see `isCurrentSessionTrashed` in SessionSurfaceContent).
      // Restoring is offered from that banner. Non-deleted opens clear the flag.
      setSelectedTrashedSessionId(sessionSummary?.deletedAt != null ? sessionId : null);
      const previousSurface = activeSurfaceRef.current;
      const previousShowConversation = showConversation;
      const navigationSeq = openHistoryNavigationSeqRef.current + 1;
      openHistoryNavigationSeqRef.current = navigationSeq;

      // Same-session guard: skip the settling/loading sequence to avoid a blank screen.
      // markPendingHistoryScroll sets isSettling=true (hides pane), but the reveal effect
      // depends on visibleMessages changing. When re-opening the same session, messages
      // don't change, so isSettling stays true and the pane remains hidden.
      // Mirrors guards in handleSidebarSelect and handleViewAutomationSession.
      if (sessionId === getSessionStoreState().currentSessionId) {
        setActiveSurface('sessions');
        setShowConversation(true);
        if (!shouldMaskDuringOpen) {
          scheduleInstantScroll();
        }
        return true;
      }

      // Mark pending scroll BEFORE loading session to hide the pane during transition.
      // This prevents the "flash of content" where new messages briefly appear at wrong
      // scroll position before being hidden.
      //
      // queueMicrotask ensures isSettling=true is committed before the browser paints
      // (microtasks run before rAF/paint), avoiding the flash of content at wrong scroll
      // position. Unlike flushSync, this won't collide with in-progress React renders —
      // flushSync during a render cycle causes "Should not already be working" errors
      // and can corrupt the React scheduler under memory pressure.
      // The settling state ensures:
      // 1. Existing content is masked before paint (no wrong-session flash)
      // 2. Messages load
      // 3. Scroll to bottom happens
      // 4. Pane content is revealed once settling resolves
      if (shouldMaskDuringOpen) {
        beginSwitchTiming(sessionId);
        // Mark-time id is STORE truth (not a render-scope value): a
        // startTransition-lagged render can trail the store's already-applied
        // switch, and a render-scope mark-time would reopen a FOX-3040 strand
        // window in the hook's orphan guard. See
        // docs/plans/260611_fix-stuck-reveal-mask/PLAN.md.
        markPendingHistoryScroll(sessionId, getSessionStoreState().currentSessionId);
      }

      // Switch the active surface immediately so the previous surface (Home,
      // Actions, Automations, etc.) stops rendering while the conversation
      // load/settle path runs. The pane is masked above, so the user sees the
      // existing conversation skeleton rather than hidden panels doing work in
      // the background.
      setActiveSurface('sessions');
      setShowConversation(true);
      setShowTechnicalDetails(false);

      flushPendingDraftBeforeSessionSwitch();

      // CRITICAL: await the async session load to ensure session is loaded before switching surfaces.
      // Previously this was not awaited, causing blank chat when navigating from Inbox approvals.
      // eslint-disable-next-line no-restricted-syntax -- openHistorySession-justified: this IS the canonical wrapper executeOpenHistorySession; it calls the raw engine exactly once, after beginSwitchTiming + markPendingHistoryScroll, which is the scroll-settling contract the lint protects (PM 260416).
      const opened = await openHistorySession(sessionId);
      if (!opened) {
        // Opening failed - clear settling state to reveal current pane
        // (markPendingHistoryScroll set isSettling=true, we need to undo it).
        // Pass sessionId so a stale navigation's failure (e.g., superseded by a
        // newer click) cannot clear a newer request's pending scroll — the core
        // bug that left users stuck at the top even on the canonical path.
        // See docs-private/investigations/260420_scroll_to_bottom_still_broken.md.
        if (shouldMaskDuringOpen) {
          cancelPendingHistoryScroll(sessionId);
          abandonSwitchTimingIfMatches(sessionId, 'failed');
        }
        // We optimistically moved to Conversations before the async load so
        // the previous surface wouldn't keep rendering during the wait. If
        // this navigation is still current and the open fails, restore where
        // the user came from rather than revealing the old conversation.
        if (
          openHistoryNavigationSeqRef.current === navigationSeq &&
          activeSurfaceRef.current === 'sessions'
        ) {
          setActiveSurface(previousSurface);
          setShowConversation(previousShowConversation);
        }
        return false;
      }

      tracking.chat.sessionResumed(sessionId, messageCount, sessionAge, source);

      setVoiceHint('');
      // Note: Don't clear composer here - ComposerWithState's sessionId effect handles
      // clearing/restoration when the session changes. Calling clear() here would race
      // with the draft restoration and wipe the persisted draft.
      setPendingInputSource(null);
      if (!shouldMaskDuringOpen) {
        scheduleInstantScroll();
      }
      if (isTextMode) {
        composerRef.current?.focus();
      }

      return true;
    },
    [
      cancelPendingHistoryScroll,
      isTextMode,
      markPendingHistoryScroll,
      openHistorySession,
      flushPendingDraftBeforeSessionSwitch,
      recordBreadcrumb,
      scrollToLastMessage,
      setActiveSurface,
      setPendingInputSource,
      setShowConversation,
      setShowTechnicalDetails,
      setVoiceHint,
      setVoiceMode,
      showConversation,
      stopRecordingSafe,
      stopSpeech
    ]
  );

  // Forward the concrete implementation through the stable ref used by
  // `navigateToConversation` (declared near the top of the component). Render-phase
  // ref assignment is safe here — refs don't trigger re-renders, and every consumer
  // reads `.current` at call time (inside async callbacks), after this line has run.
  executeOpenHistorySessionRef.current = executeOpenHistorySession;

  const handleOpenHistorySession = useCallback(
    (sessionId: string, source?: SessionResumeSource) => {
      checkAttachmentsBeforeAction(() => {
        fireAndForget(executeOpenHistorySession(sessionId, source), 'executeOpenHistorySession');
      });
    },
    [checkAttachmentsBeforeAction, executeOpenHistorySession]
  );

  // Handler for conversation reference links - shows error if session not found
  // Uses sessionSummariesRef to avoid recreating callback when sessions change
  const handleOpenConversationReference = useCallback(
    (sessionId: string) => {
      const sessionExists = sessionSummariesRef.current.some((s) => s.id === sessionId);
      if (!sessionExists) {
        showToast({ title: 'That conversation is gone — it may have been deleted' });
        return;
      }
      handleOpenHistorySession(sessionId, 'rebel_link');
    },
    [handleOpenHistorySession, showToast]
  );

  const openNotificationConversation = useCallback(
    (sessionId: string) => {
      checkAttachmentsBeforeAction(() => {
        fireAndForget((async () => {
          const opened = await executeOpenHistorySession(sessionId, 'notification');
          if (!opened) {
            emitLog({
              level: 'warn',
              message: 'Notification click conversation open failed',
              context: { sessionId },
              timestamp: Date.now(),
            });
            showToast({ title: 'That conversation is gone — it may have been deleted' });
          }
        })(), 'openNotificationConversation');
      });
    },
    [checkAttachmentsBeforeAction, emitLog, executeOpenHistorySession, showToast]
  );

  const openNotificationFile = useCallback(
    (filePath: string) => {
      fireAndForget(navigateRef.current?.({ type: 'library', filePath }), 'navigateToFileFromNotification');
    },
    []
  );

  // Handler for rebel:// navigation links in chat messages.
  //
  // Conversation policy: when a link resolves to a workspace file we open it
  // in the side preview drawer so the conversation stays visible on the left.
  // Without this, `rebel://space/{name}/{filePath}` URLs (which the
  // remark-library-links plugin emits for files in shareable spaces) would
  // route through NavigationContext.navigate → resolveLink → 'open-library-file'
  // → setActiveSurface('library'), yanking the user off the conversation.
  //
  // `rebel://library/{path}` URLs never reach this handler — they're dispatched
  // directly via onOpenFile in MessageMarkdown's linkDispatcher. This branch
  // is what gives the two URL forms parity.
  //
  // Non-file navigation (settings, sessions, focus, plugin surfaces, etc.)
  // still delegates to NavigationContext.navigate() unchanged.
  const handleNavigateFromChat = useCallback(
    async (url: string) => {
      try {
        const action = await resolveLink(url, {
          spaceResolver: rendererDesktopSpaceResolver,
          surface: 'desktop-renderer',
        });
        if (action.kind === 'open-library-file') {
          handleOpenDocumentInPreview(action.relativePath);
          return;
        }
      } catch {
        // Fall through to default navigation on resolve failure.
      }
      await navigateRef.current?.(url);
    },
    [handleOpenDocumentInPreview]
  );

  const { initialNotificationCheckComplete } = useNotificationClickNavigation({
    enabled: shouldRenderMainApp,
    startupConversationRestoreSuppressedRef,
    openNotificationConversation,
    openNotificationFile,
    emitLog,
  });

  // Handle MCP-initiated conversation starts (rebel_conversations_start tool)
  // The preload buffers events until this subscriber registers, so early calls aren't lost
  useEffect(() => {
    const unsubscribe = window.api.onConversationStartRequested?.((data) => {
      startupConversationRestoreSuppressedRef.current = true;
      if (!data?.sessionId || typeof data.text !== 'string') return;
      const text = data.text.trim();
      // Focus-only navigation: the embedded-chat side panel's
      // "Open in Rebel" button posts to /intent/conversation/:id/focus,
      // which broadcasts an empty-text + sendMessage:false +
      // switchToConversation:true event. In that case we ONLY navigate —
      // no session create, no draft, no submit. Without this branch the
      // empty-text guard below would drop the event entirely.
      // See `appBridgeIntentService.focusConversation` (Stage 3 of the
      // 260421_embedded_chat_in_extension plan).
      const isFocusOnly = !text && data.switchToConversation && !data.sendMessage;
      if (!text && !isFocusOnly) return;

      if (isFocusOnly) {
        // Focus existing session — do not mutate the store, do not draft,
        // do not submit. Just navigate. The conversation is already real
        // (focusConversation 404'd early on the bridge side if not).
        fireAndForget((async () => {
          try {
            await navigateToConversation(data.sessionId, 'mcp');
          } catch (err) {
            console.error('[MCP] Failed to focus conversation', data.sessionId, err);
          }
        })(), 'mcpFocusConversation');
        return;
      }

      // 1. Create the session in the store (synchronous Zustand set)
      getSessionStoreState().createBackgroundSession(
        data.sessionId,
        data.origin ?? 'mcp-tool',
        data.externalContext,
        data.systemPromptPrefix ? { systemPromptPrefix: data.systemPromptPrefix } : undefined,
      );

      if (data.sendMessage && data.switchToConversation) {
        // Navigate first so the target session is current before submission.
        // This ensures the user message is written via addUserMessage() and
        // appears in the transcript instead of the cross-session path.
        fireAndForget((async () => {
          try {
            await navigateToConversation(data.sessionId, 'mcp');
          } catch (err) {
            console.error('[MCP] Failed to navigate to conversation', data.sessionId, err);
          }
          fireAndForget(submitQueuedMessageRef.current?.(text, 'text', undefined, { targetSessionId: data.sessionId }), 'onConversationStartRequested');
        })(), 'mcpStartAndSendConversation');
        return;
      }

      if (data.sendMessage) {
        // 2a. Send the message immediately via the queue
        fireAndForget(submitQueuedMessageRef.current?.(text, 'text', undefined, { targetSessionId: data.sessionId }), 'onConversationStartRequested');
      } else {
        // 2b. Save as draft instead of sending
        getSessionStoreState().setDraftForSession(data.sessionId, text);
      }

      if (data.switchToConversation) {
        // 3. Navigate to the conversation (follows navigateToSession pattern)
        fireAndForget((async () => {
          try {
            await navigateToConversation(data.sessionId, 'mcp');
          } catch (err) {
            console.error('[MCP] Failed to navigate to conversation', data.sessionId, err);
          }
        })(), 'mcpNavigateToConversation');
      }
    });
    return () => unsubscribe?.();
  }, [navigateToConversation]);

  // Handle bridge-initiated send to existing conversation (rebel_conversations_send_message tool)
  // Navigate FIRST so the session becomes current, then send — this ensures the user message
  // is added via addUserMessage() (visible in transcript) rather than the cross-session path.
  useEffect(() => {
    const unsubscribe = window.api.onConversationSendRequested?.((data) => {
      startupConversationRestoreSuppressedRef.current = true;
      if (!data?.sessionId || typeof data.text !== 'string') return;
      const text = data.text.trim();
      if (!text) return;

      fireAndForget((async () => {
        // Navigate first if requested — makes the target session current
        if (data.switchToConversation) {
          try {
            await navigateToConversation(data.sessionId, 'mcp');
          } catch (err) {
            console.error('[MCP] Failed to navigate to conversation', data.sessionId, err);
          }
        }

        if (data.sendMessage) {
          // After navigation, the target session is current — message goes through addUserMessage()
          // and appears in the transcript. If not navigating, uses cross-session targeting.
          fireAndForget(submitQueuedMessageRef.current?.(text, 'text', undefined, {
            targetSessionId: data.sessionId,
            ...(typeof data.displayText === 'string' ? { displayText: data.displayText } : {}),
          }), 'onConversationSendRequested');
        } else {
          getSessionStoreState().setDraftForSession(data.sessionId, text);
        }
      })(), 'mcpSendToConversation');
    });
    return () => unsubscribe?.();
  }, [navigateToConversation]);

  // Slack-thread (and any other external) delivery failure consumer. The
  // producer (`slackThreadAdapter.scheduleRetry` / `cancelByTeamId`)
  // broadcasts on retries-exhausted and workspace-disconnected via the
  // `external-delivery:failed` cloud-push channel, but until this hook
  // landed there was no renderer subscriber — failures were silent.
  // See `src/renderer/features/agent-session/hooks/useExternalDeliveryFailedToast.ts`.
  useExternalDeliveryFailedToast({
    showToast,
    navigateToConversation: (conversationId) => navigateToConversation(conversationId, 'mcp'),
    openSlackReconnect: () => {
      fireAndForget(
        openSettingsDialog('tools', getConnectorSectionId('Slack'), { source: 'link', interactionType: 'programmatic' }),
        'externalDeliveryFailedReconnectSlack',
      );
    },
  });

  useEffect(() => {
    if (activeSurface !== 'sessions' || !showConversation) {
      return;
    }

    const persistedCurrentSession = sessionSummariesRef.current.some(
      (summary) => summary.id === currentSessionId && summary.deletedAt == null
    );
    if (!persistedCurrentSession) {
      return;
    }

    writeReloadConversationSessionId(currentSessionId);
  }, [activeSurface, currentSessionId, showConversation]);

  useEffect(() => {
    if (reloadRestoreAttemptedRef.current) {
      return;
    }

    if (!shouldRenderMainApp) {
      return;
    }

    if (!initialNotificationCheckComplete) {
      return;
    }

    if (initialReloadSurfaceRef.current !== 'sessions') {
      reloadRestoreAttemptedRef.current = true;
      return;
    }

    if (startupConversationRestoreSuppressedRef.current) {
      reloadRestoreAttemptedRef.current = true;
      clearReloadConversationSessionId();
      return;
    }

    if (sessionSummaries.length === 0) {
      return;
    }

    reloadRestoreAttemptedRef.current = true;

    const storedSessionId = readReloadConversationSessionId();
    if (!storedSessionId) {
      return;
    }

    const sessionExists = sessionSummariesRef.current.some(
      (summary) => summary.id === storedSessionId && summary.deletedAt == null
    );
    if (!sessionExists) {
      clearReloadConversationSessionId();
      return;
    }

    fireAndForget((async () => {
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });

      const opened = await navigateToConversation(storedSessionId, 'restore');
      if (!opened) {
        emitLog({
          level: 'warn',
          message: 'Reload conversation restore failed',
          context: { sessionId: storedSessionId },
          timestamp: Date.now()
        });
      }
    })(), 'reloadConversationRestore');
  }, [emitLog, initialNotificationCheckComplete, navigateToConversation, sessionSummaries, shouldRenderMainApp]);

  // Handle meeting notification clicks - trigger "Send Rebel" for detected meeting
  useEffect(() => {
    const unsubscribe = window.api.onMeetingNotificationClicked?.((data) => {
      if (!data?.meetingUrl) return;
      fireAndForget((async () => {
        tracking.meetingBot.sendClicked(data.meetingUrl, data.meetingTitle || 'Meeting', 'notification');
        const result = await window.meetingBotApi?.send?.({
          meetingUrl: data.meetingUrl,
          meetingTitle: data.meetingTitle || 'Meeting',
        });
        tracking.meetingBot.sendResult(result?.success ?? false, result?.error);
        if (!result?.success) {
          showToast({ title: "Couldn't join that meeting — check the link and try again" });
        }
      })(), 'sendBotFromMeetingNotification');
    });
    return () => unsubscribe?.();
  }, [showToast]);

  // Handle "Add Comment" on generic content (e.g., Library editor)
  // Dispatches a custom event that the Library component listens for
  const handleGenericAddComment = useCallback((text: string, documentPath?: string, hintOffset?: number) => {
    window.dispatchEvent(new CustomEvent('library:add-comment', {
      detail: { text, documentPath, hintOffset }
    }));
  }, []);

  // Listen for "Ask Rebel" action from Library editor's floating toolbar
  // Navigates to chat, keeps document preview open, and inserts quoted text
  useEffect(() => {
    const handleLibraryQuoteReply = (e: CustomEvent<{ text: string; documentPath?: string; documentTitle?: string }>) => {
      tracking.navigation.selectionMenuReply('library');
      const { text, documentPath, documentTitle } = e.detail;
      setActiveSurface('sessions');
      setShowConversation(true);
      
      // 2. Open/keep the document preview so user can reference the source
      if (documentPath) {
        openDocumentPreview(documentPath);
      }
      
      // 3. Format as clean markdown blockquote with document reference
      const blockquote = text.split('\n').map(line => `> ${line}`).join('\n');
      // Use document title if available, otherwise extract from path
      const displayName = documentTitle || (documentPath ? documentPath.split('/').pop() : null);
      const prefix = displayName 
        ? `About this from **${displayName.replace(/\.md$/i, '')}**:`
        : 'About this:';
      const quotedText = `${prefix}\n${blockquote}\n\n`;
      
      // 4. Insert text and focus composer for user to add their question
      composerRef.current?.insertAtCursor(toComposerWireMarkdown(quotedText));
      composerRef.current?.focus();
    };

    window.addEventListener('library:quote-reply', handleLibraryQuoteReply as EventListener);
    return () => window.removeEventListener('library:quote-reply', handleLibraryQuoteReply as EventListener);
  }, [setActiveSurface, setShowConversation, openDocumentPreview]);

  // Listen for "Ask Rebel in New Chat" action from Library editor / Document preview
  // Creates a new session and pre-fills composer with quoted text, keeping document preview open
  useEffect(() => {
    const handleLibraryQuoteReplyNewChat = (e: CustomEvent<{ text: string; documentPath?: string; documentTitle?: string }>) => {
      tracking.navigation.selectionMenuReplyNewChat('library');
      checkAttachmentsBeforeAction(() => {
        const { text, documentPath, documentTitle } = e.detail;

        // 1. Create a new session and navigate to Conversations tab
        const sessionId = startFreshSession();

        // 2. Open/keep the document preview so user can reference the source
        if (documentPath) {
          openDocumentPreview(documentPath);
        }

        // 3. Format as clean markdown blockquote with document reference
        const blockquote = text.split('\n').map(line => `> ${line}`).join('\n');
        const displayName = documentTitle || (documentPath ? documentPath.split('/').pop() : null);
        const prefix = displayName
          ? `About this from **${displayName.replace(/\.md$/i, '')}**:`
          : 'About this:';
        const quotedText = `${prefix}\n${blockquote}\n\n`;

        // 4. Pre-fill composer via store (safe — no race condition with React re-render)
        getSessionStoreState().setDraftForSession(sessionId, quotedText);
      });
    };

    window.addEventListener('library:quote-reply-new-chat', handleLibraryQuoteReplyNewChat as EventListener);
    return () => window.removeEventListener('library:quote-reply-new-chat', handleLibraryQuoteReplyNewChat as EventListener);
  }, [checkAttachmentsBeforeAction, startFreshSession, openDocumentPreview]);

  // Listen for "Send annotations to Rebel" action from document preview
  // (direct send path — no SendToRebelDialog, user stays on current session).
  // Pre-fills composer with formatted annotation message. If the event
  // carries an `onCommit` closure (new in v3 per-message onCommit plan),
  // append it to the pending-callbacks array keyed to the target session
  // id so `handleSubmitTextPrompt` can attach it to the resulting
  // `QueuedMessage`. Multiple Send clicks accumulate — each one's
  // staged-annotation snapshot will clear on dispatch.
  useEffect(() => {
    const handleSendAnnotations = (e: CustomEvent<{
      message: string;
      displayMessage?: string;
      documentPath?: string;
      documentTitle?: string;
      onCommit?: () => void | Promise<void>;
    }>) => {
      const { message, displayMessage, documentPath, onCommit } = e.detail;
      const messageForComposer = displayMessage ?? message;
      
      // 1. Navigate to Conversations tab
      setActiveSurface('sessions');
      setShowConversation(true);
      
      // 2. Keep the document preview open so user can reference the source
      if (documentPath) {
        openDocumentPreview(documentPath);
      }

      // 3. Accumulate the onCommit closure keyed to the current session
      //    id. Direct-send always targets the currently-focused session
      //    (that's the whole "no dialog" contract). If the user switches
      //    sessions before submitting, the closures simply never fire —
      //    matching matrix row 6 ("Send targeting session A, user sends
      //    on session B instead → annotations intact"). If the same
      //    user queues multiple Send clicks on the same session (e.g.,
      //    two files, or the same file twice — matrix rows 8 and 9),
      //    ALL pending closures run sequentially on dispatch.
      //
      //    FIX B: each entry also captures the exact inserted `message`
      //    so the submit drain can filter out callbacks whose annotation
      //    block was edited out of the composer before send.
      if (onCommit) {
        const targetSessionId = getSessionStoreState().currentSessionId;
        if (targetSessionId) {
          const map = pendingDocumentAnnotationOnCommitRef.current;
          const entry = {
            messageSnapshot: messageForComposer,
            fencedMessage: message,
            onCommit,
          };
          const existing = map.get(targetSessionId);
          if (existing) {
            existing.push(entry);
          } else {
            map.set(targetSessionId, [entry]);
          }
        }
      }

      // 4. Insert the formatted annotations message into composer
      composerRef.current?.insertAtCursor(toComposerWireMarkdown(messageForComposer));
      composerRef.current?.focus();
    };

    window.addEventListener('library:send-annotations', handleSendAnnotations as EventListener);
    return () => window.removeEventListener('library:send-annotations', handleSendAnnotations as EventListener);
  }, [setActiveSurface, setShowConversation, openDocumentPreview]);

  // Listen for "This wasn't OK" flag from Safety Activity Log
  useEffect(() => {
    const handleSafetyFlagAndChat = (e: CustomEvent<{
      source?: 'deterministic' | 'safety-prompt' | 'user-approved';
      toolDisplayName?: string;
      actionSummary?: string;
      reason?: string;
    }>) => {
      const entry = e.detail;
      if (!entry) return;

      const sourceExplanation = entry.source === 'deterministic'
        ? 'This action was allowed by a built-in rule (it is a read-only operation that Rebel always permits), not by my safety rules.'
        : entry.source === 'user-approved'
          ? 'This action was initially blocked by my safety rules but was then approved by me.'
          : 'This action was evaluated against my safety rules and allowed.';

      const toolName = (entry.toolDisplayName || '').replace(/`/g, "'");
      const action = (entry.actionSummary || '').replace(/`/g, "'");
      const reason = (entry.reason || '').replace(/`/g, "'");

      const draft = [
        '@`rebel-system/skills/safety/chat-about-safety-rules/SKILL.md`',
        "I flagged an action in my activity log that shouldn't have been allowed.",
        '',
        '**Flagged action:**',
        `- Tool: \`${toolName}\``,
        `- Action: \`${action}\``,
        `- Reason given: ${reason}`,
        `- ${sourceExplanation}`,
        '',
        'Help me understand why this was allowed and what I can do about it.',
      ].join('\n');

      closeSettingsDialog();
      const sessionId = resetSessionState();
      setActiveSurface('sessions');
      setIsTextMode(true);
      setShowConversation(true);
      setFlowHistoryOpen(true);
      getSessionStoreState().setDraftForSession(sessionId, draft);
    };

    window.addEventListener('safety:flag-and-chat', handleSafetyFlagAndChat as EventListener);
    return () => window.removeEventListener('safety:flag-and-chat', handleSafetyFlagAndChat as EventListener);
  }, [closeSettingsDialog, resetSessionState, setActiveSurface, setFlowHistoryOpen, setIsTextMode, setShowConversation]);

  // Reset preview error auto-fix counter when switching sessions
  useEffect(() => {
    autoFixCountRef.current = 0;
  }, [currentSessionId]);

  // Listen for runtime errors from HTML preview iframes (dispatched by McpAppView)
  // and auto-trigger a follow-up agent turn to self-correct
  const MAX_PREVIEW_AUTO_FIX = 2;
  useEffect(() => {
    const handlePreviewError = (event: Event) => {
      const detail = (event as CustomEvent<{ resourceUri: string; errors: string[] }>).detail;
      if (!detail?.errors || detail.errors.length === 0) return;

      // Circuit breaker: max N auto-fix attempts per session
      if (autoFixCountRef.current >= MAX_PREVIEW_AUTO_FIX) return;
      autoFixCountRef.current += 1;

      // Sanitize error strings: cap length, strip XML-like tags to prevent prompt boundary issues
      const sanitize = (s: string) => String(s).replace(/<\/?[a-z][^>]*>/gi, '').slice(0, 500);
      const errorList = detail.errors.slice(0, 10).map(sanitize).join('\n');
      const attempt = autoFixCountRef.current;
      const prompt = `[PREVIEW ERROR FEEDBACK]\n\nThe HTML preview encountered runtime errors:\n\n<preview-errors>\n${errorList}\n</preview-errors>\n\n` +
        `IMPORTANT: The preview runs in a sandboxed iframe with a Content Security Policy. ` +
        `External scripts are ONLY allowed from https://cdnjs.cloudflare.com — other CDNs (jsdelivr, unpkg, etc.) are blocked. ` +
        `If the error is about a missing library (e.g. "X is not defined"), use a cdnjs URL instead. ` +
        `Available CDN libraries: Chart.js 4.4.1, Mermaid 11.4.0, D3.js 7.9.0, Leaflet 1.9.4 — all from https://cdnjs.cloudflare.com only. ` +
        `For Chart.js: <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>\n\n` +
        `This is auto-fix attempt ${attempt} of ${MAX_PREVIEW_AUTO_FIX}. Fix the errors and render the preview again.`;

      fireAndForget(submitQueuedMessageRef.current?.(prompt, 'text', undefined, {
        queueMode: 'queue',
        isSystemContinuation: true,
      }), 'mcpPreviewAutoFix');
    };

    window.addEventListener('mcp-app:preview-error', handlePreviewError);
    return () => window.removeEventListener('mcp-app:preview-error', handlePreviewError);
  }, []);

  // Shared helper: formats a SelectionContext as a markdown blockquote with context prefix.
  // Used by both "Ask Rebel" (current chat) and "Ask Rebel in New Chat" handlers.
  const formatSelectionAsBlockquote = useCallback((context: SelectionContext): string => {
    const text = context.kind === 'message' ? context.selection.text : context.text;
    const blockquote = text.split('\n').map(line => `> ${line}`).join('\n');

    let prefix = 'In reply to:';
    if (context.kind === 'generic' && context.documentPath) {
      prefix = `Regarding @\`${context.documentPath}\`:`;
    }

    return `${prefix}\n${blockquote}\n\n`;
  }, []);

  // Handle "Reply" action from TextSelectionMenuLayer - inserts selected text as blockquote into composer
  const handleSelectionMenuReply = useCallback((context: SelectionContext) => {
    tracking.navigation.selectionMenuReply('chat');
    const quotedText = formatSelectionAsBlockquote(context);
    composerRef.current?.insertAtCursor(toComposerWireMarkdown(quotedText));
    composerRef.current?.focus();
  }, [formatSelectionAsBlockquote]);

  // Handle "Reply in New Chat" action from TextSelectionMenuLayer - opens new chat with selected text as blockquote.
  // When selected from a chat message, includes prior conversation context so Rebel understands the history.
  const handleSelectionMenuReplyInNewChat = useCallback((context: SelectionContext) => {
    tracking.navigation.selectionMenuReplyNewChat('chat');
    const quotedText = formatSelectionAsBlockquote(context);

    // Capture conversation context NOW, before checkAttachmentsBeforeAction which may
    // defer execution (attachments confirm dialog) — by which time messages could change/clear.
    let conversationContext = '';
    const { messages } = getSessionStoreState();
    if (context.kind === 'message') {
      const selectedMsgIndex = messages.findIndex(m => m.id === context.selection.messageId);
      const contextMessages = selectedMsgIndex >= 0
        ? messages.slice(0, selectedMsgIndex + 1)
        : messages;
      const visible = contextMessages.filter(m => !isMessageHidden(m));
      if (visible.length > 0) {
        const lines: string[] = ['[Previous conversation:]'];
        for (const msg of visible) {
          const roleLabel = msg.role === 'user' ? 'User' : 'Assistant';
          lines.push(`${roleLabel}: ${msg.text}`);
        }
        lines.push('[End of previous conversation]');
        lines.push('');
        lines.push('');
        conversationContext = lines.join('\n');
      }
    } else if (!context.documentPath && messages.length > 0) {
      // Generic fallback: selection was in a chat message but offsets couldn't be computed
      // (e.g. selection collapsed between mousedown and contextmenu). Still include all
      // visible messages as context since the user is clearly in a conversation.
      const visible = messages.filter(m => !isMessageHidden(m));
      if (visible.length > 0) {
        const lines: string[] = ['[Previous conversation:]'];
        for (const msg of visible) {
          const roleLabel = msg.role === 'user' ? 'User' : 'Assistant';
          lines.push(`${roleLabel}: ${msg.text}`);
        }
        lines.push('[End of previous conversation]');
        lines.push('');
        lines.push('');
        conversationContext = lines.join('\n');
      }
    }

    checkAttachmentsBeforeAction(() => {
      const sessionId = startFreshSession();
      getSessionStoreState().setDraftForSession(sessionId, conversationContext + quotedText);
    });
  }, [checkAttachmentsBeforeAction, formatSelectionAsBlockquote, startFreshSession]);

  // Shared helper: stops active turn and cleans up voice/queue state before session deletion.
  //
  // FIX D (final heavy review): `targetSessionId` is now explicit so
  // queued messages for the DELETED session are cleared regardless of
  // whether that session is currently focused. Previously this only
  // called `clearQueueForSession(currentSessionId)`, leaving queued
  // messages (and their `onCommit` callbacks) alive when a background
  // session was deleted — the callback could later fire on a reroute
  // or recreated-session path. Voice/active-turn cleanup remains
  // conditional on `targetSessionId === currentSessionId` because
  // those resources always belong to the focused session.
  const cleanupBeforeSessionDelete = useCallback(
    (targetSessionId: string, reason: 'permanent' | 'soft') => {
      const isDeletingActive = targetSessionId === currentSessionId;
      if (isDeletingActive && isBusy && activeTurnId) {
        void stopActiveTurn().catch((err) => {
          emitLog({
            level: 'warn',
            message: reason === 'permanent'
              ? 'Error stopping turn during session deletion'
              : 'Error stopping turn during soft session deletion',
            context: { error: err instanceof Error ? err.message : String(err) },
            timestamp: Date.now()
          });
        });
      }
      // Always clear queued messages targeting the session being
      // deleted — including background/non-active sessions — so their
      // `onCommit` callbacks cannot fire after the delete. Per the
      // planning doc's "session delete drops onCommit" rule.
      clearQueueForSession(targetSessionId);
      if (isDeletingActive) {
        setPendingInputSource(null);
        cancelRecordingSafe();
        stopSpeech();
        setVoiceMode(false);
      }
    },
    [
      activeTurnId,
      cancelRecordingSafe,
      clearQueueForSession,
      currentSessionId,
      emitLog,
      isBusy,
      setPendingInputSource,
      setVoiceMode,
      stopActiveTurn,
      stopSpeech
    ]
  );

  const executeSessionDeletion = useCallback(
    (sessionId: string) => {
      fireAndForget((async () => {
        let sessionSetupContext: AgentSession['setupContext'] | null | undefined;
        try {
          sessionSetupContext = await readInstallSetupContext(sessionId);
        } catch {
          sessionSetupContext = undefined;
        }
        // Get session info for tracking before deletion (use summary for messageCount)
        const sessionSummary = sessionSummariesRef.current.find((s) => s.id === sessionId);
        const messageCount = sessionSummary?.messageCount ?? 0;

        // FIX D: always run cleanup — it now clears the queue for the
        // exact targetSessionId regardless of focus. Voice/active-turn
        // side-effects stay scoped to the active session internally.
        cleanupBeforeSessionDelete(sessionId, 'permanent');

        const { success, wasActive } = deleteHistorySession(sessionId);
        if (!success) {
          showToast({ title: "Couldn't delete that conversation" });
          return;
        }

        tracking.chat.sessionDeleted(sessionId, wasActive, messageCount);

        // Drop any pending document-annotation onCommit closures for the
        // deleted session — otherwise the closures would stick around in
        // the ref-Map, pinning captured editor handles and file paths,
        // and could fire on a future composer submit that happens to
        // reuse the same session id (unlikely with UUIDs, but fail-safe
        // cleanup is always cheap).
        dropPendingDocumentAnnotationOnCommits(sessionId);

        if (wasActive) {
          setShowTechnicalDetails(false);
          setVoiceHint(DEFAULT_VOICE_STATUS);
          composerRef.current?.clear();
        }

        showToast({ title: 'Conversation deleted' });
        fireAndForget(
          endPairSessionForSetupContext(sessionId, sessionSetupContext),
          'deleteSessionInstallCleanup',
        );
      })(), 'executeSessionDeletion');
    },
    [
      cleanupBeforeSessionDelete,
      deleteHistorySession,
      dropPendingDocumentAnnotationOnCommits,
      endPairSessionForSetupContext,
      readInstallSetupContext,
      setShowTechnicalDetails,
      setVoiceHint,
      showToast
    ]
  );

  // Returns `{ ok: true }` once the prompt has been handed off to the queue
  // submission pipeline (async submit is fire-and-forget — downstream failures
  // surface via the queue's own toast path). Returns `{ ok: false }` if the
  // synchronous prep step (mention attachment resolution) threw, so callers
  // can roll back any optimistic state they set before calling in.
  const seedConnectorPrompt = useCallback(async (
    prompt: string,
    targetSessionId: string,
    failureMessage: string,
  ): Promise<{ ok: boolean }> => {
    try {
      const mentionAttachments = await prepareMentionAttachments(prompt);
      fireAndForget(
        submitQueuedMessage(
          prompt,
          'text',
          mentionAttachments.length > 0 ? mentionAttachments : undefined,
          { targetSessionId },
        ),
        'seedConnectorPrompt',
      );
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : failureMessage;
      showToast({ title: message });
      return { ok: false };
    }
  }, [prepareMentionAttachments, submitQueuedMessage, showToast]);

  // P1 entry point: "Set up a connector" and search empty state CTA.
  // Seeds a fresh-session draft for the user to review/edit. The draft write
  // must happen synchronously after the session switch because ComposerWithState
  // hydrates store drafts when its `sessionId` prop changes.
  const handleBuildConnector = useCallback((searchQuery?: string) => {
    closeSettingsDialog();
    const sessionId = startFreshSession();

    const prompt = buildOssMcpEntryPointBuildPrompt(searchQuery);
    getSessionStoreState().setDraftForSession(sessionId, prompt);
  }, [closeSettingsDialog, startFreshSession]);

  // P1 entry point: "Add more tools" on rebel-oss connector cards
  // Seeds a conversation with the extend-mcp-server skill, including connector context.
  const handleExtendConnector = useCallback(async (connectorId: string | undefined, connectorName: string) => {
    closeSettingsDialog();
    const sessionId = startFreshSession();

    const prompt = buildOssMcpEntryPointExtendPrompt(connectorName, connectorId);

    await seedConnectorPrompt(prompt, sessionId, 'Unable to start connector extension');
  }, [closeSettingsDialog, seedConnectorPrompt, startFreshSession]);

  // "Set up with Rebel" CTA on any connector card (bundled, direct OAuth, or community).
  // Generates a connector-specific setup prompt and auto-sends it via the shared
  // `seedConnectorPrompt` primitive — matching `handleExtendConnector`.
  // Generic build setup uses a reviewable composer draft instead. See
  // `src/renderer/features/settings/utils/setupPromptGenerator.ts` for prompt shapes.
  //
  // Lives here (below `useLibraryMentions` and `seedConnectorPrompt`) so it can reference
  // `seedConnectorPrompt` directly without a ref bridge — matching the OSS MCP CTAs.
  const handleConfigureWithRebel = useCallback(async (params: SetupWithRebelParams) => {
    closeSettingsDialog();
    const sessionId = startFreshSession();
    if (params.catalogEntry?.bundledConfig?.setupToolName === 'rebel_bridge_prepare_install') {
      getSessionStoreState().setSetupContext({
        kind: 'bundled-app-bridge',
      });
    }
    // `generateSetupPrompt` is async because it does an MCP tool search for
    // non-bundled connectors (bundled-app-bridge short-circuits to the skill
    // mention synchronously, so there's no wait for the Rebel Browser case).
    const prompt = await generateSetupPrompt(params);
    await seedConnectorPrompt(prompt, sessionId, 'Unable to start the connector setup conversation.');
  }, [closeSettingsDialog, seedConnectorPrompt, startFreshSession]);
  configureWithRebelRetryRef.current = handleConfigureWithRebel;

  // P5.5: Detect structured connector setup suggestions in conversation events
  // and surface the latest unsaved one in the shared footer override lane.
  // The `sessionId` param anchors the session-scoped "answered" registry
  // so suppression survives cross-turn re-emission and component remount
  // (see docs-private/investigations/260416_duplicate_connector_setup_card.md).
  //
  // 260427 footer-question suppression follow-on: when a contribution
  // already exists for the same connector in this session (any status),
  // hide the card. Closes the visual inconsistency where the
  // "Want Rebel to build the X connector for you?" card persisted
  // alongside an active planning + early-build flow. Matching is
  // case-insensitive and whitespace-trimmed (mirrors
  // `buildConnectorSetupKey` normalization in `connectorSetupSignal.ts`).
  // See docs/plans/260427_contribution_flow_followon_self_block_at_registration.md.
  const hasContributionForConnector = useCallback(
    (connectorName: string): boolean => {
      const target = connectorName.trim().toLowerCase();
      if (target.length === 0) return false;
      for (const name of sessionLinkedConnectorNames) {
        if (name.trim().toLowerCase() === target) return true;
      }
      return false;
    },
    [sessionLinkedConnectorNames],
  );

  const {
    pendingFooterCard: pendingConnectorSetupCard,
    saveForLater: handleConnectorSaveForLater,
    markAnswered: markConnectorAnswered,
    markPending: markConnectorPending,
    clearPending: clearConnectorPending,
  } = useConnectorSetupSuggestions(
    eventsByTurn,
    visibleMessages,
    resolveTurnIdForMessage,
    currentSessionId,
    hasContributionForConnector,
  );

  // P5.5: Footer question action — continue in the current conversation by seeding the
  // relevant MCP skill prompt into the active session rather than forking a new one.
  //
  // Uses a two-phase mark on the session-scoped answered registry so the card
  // disappears the moment the user clicks (pending) and stays hidden once the
  // prompt is queued (answered). On enqueue prep failure we clear the pending
  // mark so the card re-appears for retry — suppression must not become a
  // silent dead-end. See docs-private/investigations/260416_duplicate_connector_setup_card.md.
  const handleConnectorSetUp = useCallback(async (card: ConnectorSetupCardInfo) => {
    const targetSessionId = currentSessionId;
    const key = buildConnectorSetupKey({
      intent: card.intent,
      connectorId: card.connectorId,
      connectorName: card.connectorName,
    });

    markConnectorPending(key);

    const prompt = card.intent === 'extend'
      ? buildOssMcpEntryPointExtendPrompt(card.connectorName, card.connectorId)
      : buildOssMcpEntryPointBuildPrompt(card.connectorName);
    const failureMessage = card.intent === 'extend'
      ? 'Unable to start connector extension'
      : 'Unable to start connector setup';

    const result = await seedConnectorPrompt(prompt, targetSessionId, failureMessage);
    if (result.ok) {
      markConnectorAnswered(key);
    } else {
      clearConnectorPending(key);
    }
  }, [currentSessionId, seedConnectorPrompt, markConnectorAnswered, markConnectorPending, clearConnectorPending]);

  // P8 entry point: "Share with everyone" on Settings → Tools connector
  // cards. For genuinely-shareable contributions (`draft` / `ready_to_submit`),
  // tries to navigate to the source build session — falls back to a seeded
  // conversation only if that session was deleted, or when no contribution
  // record exists for the name at all.
  //
  // Per C4 of `docs/plans/260428_keep_private_minimize_and_settings_share_button.md`:
  // do NOT silently seed duplicate flows when the contribution is in a
  // non-shareable state (e.g. already `submitted`) or when the `list()` IPC
  // throws — those cases get user-visible toasts and stop, because a silent
  // re-seed would spawn a parallel share attempt the user didn't ask for.
  //
  // Stage 2 review amendments:
  //   - Reentrancy guard (`shareInFlightRef`) prevents the seed-fall-through
  //     path from seeding two fresh sessions on a rapid double-click.
  //   - Exhaustive switch with a `default` log-and-toast prevents future
  //     `ContributionStatus` values from silently falling into "Already
  //     shared." if someone adds e.g. `'cancelled'` later.
  const shareInFlightRef = useRef(false);
  const handleShareWithCommunity = useCallback(async (connectorName: string) => {
    if (isOssBuild) {
      showToast({ title: "Sharing isn't available in this build." });
      return;
    }
    if (shareInFlightRef.current) return;
    shareInFlightRef.current = true;
    try {
      closeSettingsDialog();

      // Type inferred from `contributionApi.list` IPC schema (no extra import).
      let contribution: Awaited<ReturnType<typeof window.contributionApi.list>>['contributions'][number] | undefined;
      try {
        const result = await window.contributionApi.list({});
        contribution = result.contributions
          .filter((c) => c.connectorName.toLowerCase() === connectorName.toLowerCase())
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
      } catch (err) {
        // Don't silently seed — that creates a duplicate flow on a transient
        // IPC blip. Tell the user; they can retry. Renderer console logs are
        // captured to file (per docs/project/DEBUGGING.md) so this is greppable.
        console.warn('[handleShareWithCommunity] list failed', err);
        showToast({ title: "Couldn't check sharing status. Try again?" });
        return;
      }

      if (contribution) {
        const status = contribution.status;
        switch (status) {
          case 'draft':
          case 'ready_to_submit': {
            // Genuinely shareable — try to navigate back to the source build
            // conversation. If the session was deleted, fall through to seed
            // (handled outside the switch).
            const opened = await navigateToConversation(contribution.sessionId);
            if (opened) return;
            // Session deleted — seeding a fresh conversation is the right
            // recovery here: the user wants to share, the existing record's
            // chat is gone, so we hand them a new build chat pre-filled with
            // the connector name. Falls through to the seed block below.
            break;
          }
          case 'testing': {
            // Mid-flight — surfaced via the agent's testing card / Settings
            // stuck-recovery, not via re-seeding.
            showToast({ title: "This tool isn't ready to share yet." });
            return;
          }
          case 'submitted':
          case 'ci_pass':
          case 'ci_fail':
          case 'changes_requested':
          case 'approved':
          case 'rejected':
          case 'published': {
            // All already passed through the share flow once. Re-seeding
            // would create a duplicate PR / duplicate contribution record;
            // surface a calm acknowledgement instead.
            showToast({ title: 'Already shared. Nice.' });
            return;
          }
          default: {
            // Forward-compat: any new ContributionStatus added later lands
            // here. Don't silently seed (could spawn duplicates) and don't
            // silently coerce to "Already shared" (could lie about state).
            // Log + ask the user to refresh; explicit observable failure.
            console.warn('[handleShareWithCommunity] unrecognised contribution status', { status });
            showToast({ title: "Couldn't check sharing status. Try again?" });
            return;
          }
        }
      }

      // Reached when: (a) no contribution record exists for this name, or
      // (b) the source session for a shareable contribution was deleted.
      // Both are legitimate "start a fresh build/share conversation" states.
      const sessionId = startFreshSession();
      const prompt = buildOssMcpEntryPointSharePrompt(connectorName);

      try {
        const mentionAttachments = await prepareMentionAttachments(prompt);
        fireAndForget(
          submitQueuedMessage(
            prompt,
            'text',
            mentionAttachments.length > 0 ? mentionAttachments : undefined,
            { targetSessionId: sessionId },
          ),
          'handleShareWithCommunity',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to start sharing flow';
        showToast({ title: message });
      }
    } finally {
      shareInFlightRef.current = false;
    }
  }, [closeSettingsDialog, isOssBuild, navigateToConversation, startFreshSession, prepareMentionAttachments, submitQueuedMessage, showToast]);

  // Opens the originating contribution conversation from the Settings connector card.
  // Closes the settings dialog first so the chat view is visible.
  const handleOpenContributionChat = useCallback(
    async (sessionId: string) => {
      closeSettingsDialog();
      const opened = await navigateToConversation(sessionId);
      if (!opened) {
        showToast({ title: 'That conversation is no longer available' });
      }
    },
    [closeSettingsDialog, navigateToConversation, showToast],
  );

  const handleTaskExecute = useCallback(
    async (task: InboxItem, context: string | undefined, pinAfter: boolean, fileAttachments?: AnyAttachmentPayload[]) => {
      pendingTaskExecutionRef.current = null;
      const sessionId = resetSessionState();
      const basePrompt = buildTaskPromptFromTask(task);
      const prompt = context ? `${basePrompt}\n\n**Additional instructions from user:**\n${context}` : basePrompt;
      const mode: TaskExecutionMode = context ? 'execute_with_context' : 'execute';
      let attachments: AnyAttachmentPayload[] | undefined;
      try {
        const mentionAttachments = await prepareMentionAttachments(prompt);
        const allAttachments = [...mentionAttachments, ...(fileAttachments ?? [])];
        attachments = allAttachments.length > 0 ? allAttachments : undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to attach referenced files';
        showToast({ title: message });
        emitLog({
          level: 'error',
          message: 'Failed to prepare task attachments',
          context: { taskId: task.id, error: message },
          timestamp: Date.now()
        });
        return;
      }

      try {
        const executionStartedAt = performance.now();
        const isFirstExecution = !inboxHistory?.some(h => h.id === task.id);
        const ctaLabel = task.actionLabel?.trim() ? 'custom' : resolveInboxCtaLabel(task);
        tracking.inbox.itemExecuted(task.id, mode, sessionId, isFirstExecution, ctaLabel);
        
        // Set executing state while preserving the action unless Auto-mark done is enabled.
        await window.inboxApi.setExecuting({
          itemId: task.id,
          sessionId,
          autoCompleteOnExecution: !pinAfter,
        });
        
        // CRITICAL: Pass targetSessionId explicitly because submitQueuedMessage's currentSessionId
        // closure is stale after resetSessionState() - React hasn't re-rendered yet.
        // doneAfterComplete: mark conversation done when complete (only when auto-done toggled via pinAfter=false)
        // unleashedMode: always true for inbox execution — aggressive continuation ensures task completes
        await submitQueuedMessage(prompt, 'text', attachments, {
          targetSessionId: sessionId,
          doneAfterComplete: !pinAfter,
          unleashedMode: true,
        });
        tracking.inbox.itemExecutionCompleted(
          task.id,
          'success',
          Math.round(performance.now() - executionStartedAt),
          1
        );

        const taskId = task.id;
        showToast(buildActionToast({
          action: 'execute',
          items: [task],
          undoCallback: () => {
            void window.inboxApi.setExecuting({ itemId: taskId, sessionId: null });
          },
          viewCallback: () => {
            fireAndForget(navigateToConversation(sessionId, 'task'), 'viewTaskSession');
          },
        }));
      } catch (error) {
        // Clear executing state on error to prevent stuck "Running" state
        void window.inboxApi.setExecuting({ itemId: task.id, sessionId: null });
        const message = error instanceof Error ? error.message : 'Unable to execute task';
        tracking.inbox.itemExecutionError(task.id, 'execution_failed', 'SUBMIT_ERROR', 0);
        emitLog({
          level: 'error',
          message: 'Failed to execute queued task',
          context: { taskId: task.id, error: message },
          timestamp: Date.now()
        });
        showToast({ title: "Couldn't run that task" });
      }
    },
    [buildTaskPromptFromTask, emitLog, prepareMentionAttachments, resetSessionState, showToast, submitQueuedMessage, inboxHistory, navigateToConversation]
  );

  // Handler for "I can probably tidy this up" - populates composer with health report for user review
  const troubleshootingRef = useRef(false);
  const handleTroubleshoot = useCallback(async () => {
    // Guard against duplicate clicks while diagnostics are running (ref for synchronous check)
    if (troubleshootingRef.current) return;
    troubleshootingRef.current = true;
    
    // Show toast immediately - health export can take 2-5 seconds due to LLM coherence check
    showToast({ title: 'Running diagnostics — a new conversation will open when ready', duration: 10000 });
    
    try {
      const { markdown } = await window.systemHealthApi.healthExport();
      const sessionId = startFreshSession({ showHistory: true });
      
      const prompt = `I clicked "What's going on?" because the system detected some issues.

Here's my current health check report:

${markdown}

Please help me understand what's wrong and guide me through fixing these issues step by step. Start with the most critical problems first.`;

      // Reactive thinking-model fallback: per FOX-3096, an invalid configured thinking
      // model (e.g. catalog drift, deprecated mid-session) can fail the very first
      // diagnostic turn — the worst place to fail. Layered defenses already cover the
      // common cases (settingsUtils.normalizeSettings strips invalid values at boot;
      // turnErrorRecovery Handler 3 auto-downgrades PREFERRED_PLANNING_MODEL). This
      // listener closes the remaining gap: if the first turn errors with a
      // thinking-model-unavailable signature AND the user has a thinking model that
      // could be at fault, resubmit once with the thinking model cleared so the
      // diagnostic still reaches them. Skipped entirely when no thinking model is
      // configured (nothing to fall back from). See
      // docs/plans/260509_troubleshoot_thinking_model_fallback.md.
      const resolvedModels = resolveModelSettings(settingsRef.current);
      const hasThinkingModel = Boolean(resolvedModels.thinkingModel || resolvedModels.thinkingProfileId);
      if (hasThinkingModel) {
        let fallbackTriggered = false;
        let hasSeenBusy = false;
        let unsubscribe: (() => void) | null = null;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;

        const cleanup = () => {
          if (unsubscribe) {
            unsubscribe();
            unsubscribe = null;
          }
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
        };

        const checkForFallback = () => {
          if (fallbackTriggered) return;
          const state = getSessionStoreState();
          const isCurrent = state.currentSessionId === sessionId;
          const summaryEntry = state.sessionSummaries.find((s) => s.id === sessionId);

          // True teardown only when the session is no longer current AND has no summary entry.
          // While still current, a missing summary is normal (snapshot may not be inserted yet).
          if (!isCurrent && !summaryEntry) {
            cleanup();
            return;
          }

          // Latch on first observed busy → only react to the FIRST turn's completion.
          // Once that turn ends (busy: true → false) we either retry or stop watching;
          // we never react to subsequent turns the user runs in the same conversation.
          const isBusy = isCurrent ? state.isBusy : (summaryEntry?.isBusy ?? false);
          if (isBusy) {
            hasSeenBusy = true;
            return;
          }
          if (!hasSeenBusy) return;

          // Foreground errors land on top-level state.lastError; background errors
          // land on sessionSummaries[i].lastError. Read whichever applies.
          const errorString = isCurrent
            ? (state.lastError ?? summaryEntry?.lastError ?? null)
            : (summaryEntry?.lastError ?? null);

          if (!errorString) {
            cleanup();
            return;
          }
          if (!isThinkingModelUnavailableError(errorString)) {
            cleanup();
            return;
          }

          fallbackTriggered = true;
          cleanup();
          showToast({
            title: 'Retrying without your custom thinking model — adjust in Settings → Models',
            duration: 6000,
          });
          emitLog({
            level: 'warn',
            message: 'Troubleshoot session retried after thinking-model failure',
            context: { sessionId, errorPreview: String(errorString).slice(0, 200) },
            timestamp: Date.now(),
          });
          fireAndForget(submitQueuedMessage(prompt, 'text', undefined, {
            targetSessionId: sessionId,
            thinkingModelOverride: '',
          }), 'troubleshootingFallback');
        };

        unsubscribe = subscribeToSessionStore(checkForFallback);
        timeoutId = setTimeout(cleanup, 60_000);
      }

      // Auto-send the message immediately (follows pattern from handleAskRebel)
      fireAndForget(submitQueuedMessage(prompt, 'text', undefined, {
        targetSessionId: sessionId,
      }), 'troubleshootingConversation');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      showToast({ title: message || 'Unable to run diagnostics' });
      emitLog({
        level: 'error',
        message: 'Failed to launch troubleshooting session',
        context: { error: message },
        timestamp: Date.now()
      });
    } finally {
      troubleshootingRef.current = false;
    }
  }, [emitLog, startFreshSession, showToast, submitQueuedMessage]);

  const handleOpenTaskHistorySession = useCallback(
    async (sessionId: string) => {
      const opened = await navigateToConversation(sessionId, 'task');
      if (!opened) {
        showToast({ title: 'Conversation transcript not available' });
      }
    },
    [navigateToConversation, showToast]
  );

  const handleTogglePinSession = useCallback(
    (
      sessionId: string,
      event?: ReactMouseEvent,
      options?: { skipAutoSwitch?: boolean },
    ) => {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      // Track whether we're marking the current session Done for auto-switch.
      // Active = `doneAt == null` (canonical lifecycle).
      const isCurrentSession = sessionId === currentSessionId;
      const isMarkingDone = isCurrentSession && currentSessionDoneAt == null;

      // Check if marking done or activating for analytics
      // For current session, read currentSessionDoneAt; for history sessions, look it up in summaries
      let isCurrentlyActive = false;
      if (isCurrentSession) {
        isCurrentlyActive = currentSessionDoneAt == null;
      } else {
        const sessionSummary = sessionSummariesRef.current.find(s => s.id === sessionId);
        isCurrentlyActive = sessionSummary ? isSessionActive(sessionSummary) : false;
      }

      // Track done/activate action
      if (isCurrentlyActive) {
        tracking.navigation.conversationMarkedDone(sessionId);
      } else {
        tracking.navigation.conversationActivated(sessionId);
      }

      if (isMarkingDone && !options?.skipAutoSwitch) {
        // Capture the next-in-list session before state changes (list position is lost after marking done).
        // isActiveNavEntry excludes background kinds so auto-switch can't land on an app-initiated run.
        const activeEntries = sidebarEntriesRef.current.filter(isActiveNavEntry);
        const idx = activeEntries.findIndex((s) => s.id === sessionId);
        const adjacent = activeEntries[idx + 1] ?? activeEntries[idx - 1] ?? null;
        pendingDoneAutoSwitchRef.current = { sessionId, nextInListId: adjacent?.id ?? null };
      }
      togglePinSession(sessionId);
    },
    [currentSessionId, currentSessionDoneAt, togglePinSession]
  );

  const handleToggleStarSession = useCallback(
    (sessionId: string, event?: ReactMouseEvent) => {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      
      // Check if starring or unstarring for analytics
      const isCurrentSession = sessionId === currentSessionId;
      let isCurrentlyStarred = false;
      if (isCurrentSession) {
        isCurrentlyStarred = Boolean(currentSessionStarredAt);
      } else {
        const sessionSummary = sessionSummariesRef.current.find(s => s.id === sessionId);
        isCurrentlyStarred = Boolean(sessionSummary?.starredAt);
      }
      
      // Track star/unstar action
      if (isCurrentlyStarred) {
        tracking.navigation.conversationUnstarred(sessionId);
      } else {
        tracking.navigation.conversationStarred(sessionId);
      }
      
      toggleStarSession(sessionId);
    },
    [toggleStarSession, currentSessionId, currentSessionStarredAt]
  );

  const handleSoftDeleteSession = useCallback(
    (sessionId: string, event?: ReactMouseEvent) => {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }

      fireAndForget((async () => {
        let sessionSetupContext: AgentSession['setupContext'] | null | undefined;
        try {
          sessionSetupContext = await readInstallSetupContext(sessionId);
        } catch {
          sessionSetupContext = undefined;
        }

        // FIX D: always run cleanup — it clears the queue for the exact
        // targetSessionId regardless of focus, so queued onCommit
        // callbacks for a non-active soft-deleted session can't fire on
        // a reroute path later. Voice/active-turn side-effects are
        // internally scoped to the focused session. For background
        // sessions we still need to stop their active turn (different
        // code path because stopActiveTurn targets the active session
        // only; non-active needs a direct IPC call).
        const isDeletingActive = sessionId === currentSessionId;
        cleanupBeforeSessionDelete(sessionId, 'soft');
        if (!isDeletingActive) {
          // Stop background session if it has an active turn (use summary for activeTurnId/isBusy)
          const sessionSummary = sessionSummariesRef.current.find((s) => s.id === sessionId);
          if (sessionSummary?.activeTurnId && sessionSummary?.isBusy) {
            void window.agentApi.stopTurn(sessionSummary.activeTurnId).catch((err) => {
              console.warn('Failed to stop background session turn:', err);
            });
          }
        }

        // Drop any pending document-annotation onCommit stashes for the
        // soft-deleted session. Matches the hard-delete cleanup above:
        // soft-delete also abandons the composer context, so stale
        // stashes must not survive.
        dropPendingDocumentAnnotationOnCommits(sessionId);

        softDeleteSession(sessionId);
        showToast({ title: 'Moved to Trash — scroll down in the sidebar if you change your mind' });
        fireAndForget(
          endPairSessionForSetupContext(sessionId, sessionSetupContext),
          'softDeleteSessionInstallCleanup',
        );
      })(), 'handleSoftDeleteSession');
    },
    [
      cleanupBeforeSessionDelete,
      currentSessionId,
      dropPendingDocumentAnnotationOnCommits,
      endPairSessionForSetupContext,
      readInstallSetupContext,
      showToast,
      softDeleteSession,
    ]
  );

  // Context menu state and handlers moved to SessionSurfaceContent

  const handleRestoreSession = useCallback(
    (sessionId: string, event?: ReactMouseEvent) => {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      restoreSession(sessionId);
      showToast({ title: 'Restored from Trash' });
    },
    [restoreSession, showToast]
  );

  const handleEmptyTrash = useCallback(() => {
    emptyTrash();
    showToast({ title: 'Trash emptied' });
  }, [emptyTrash, showToast]);

  const handleSessionTypeFilterChange = useCallback(
    (filter: 'all' | 'conversations' | 'automations') => {
      if (filter === sessionTypeFilter) {
        return;
      }
      setSessionTypeFilter(filter).catch((err) => {
        showToast({ title: err instanceof Error ? err.message : 'Unable to update history filter' });
      });
    },
    [setSessionTypeFilter, sessionTypeFilter, showToast]
  );

  const handleSidebarSelect = useCallback(
    (entryId: string, isHistory: boolean) => {
      setActiveSurface('sessions');
      setShowConversation(true);

      if (entryId === currentSessionId) {
        setSelectedTrashedSessionId(null);
        // Exit diagnostics/insights when re-clicking the current conversation
        resetToSessionView();
        return;
      }
      if (isHistory) {
        handleOpenHistorySession(entryId, 'sidebar');
      }
    },
    [currentSessionId, handleOpenHistorySession, setActiveSurface, setShowConversation, resetToSessionView]
  );

  const { unreadSessionIds } = useUnreadResponses(sessionSummaries, currentSessionId);

  const {
    currentSessionSidebarEntry,
    sidebarEntries: sidebarAgentSessions,
    sections
  } = useSessionHistoryView({
    currentSessionId,
    currentSessionTitle,
    currentSessionResolvedAt,
    currentSessionDoneAt,
    currentSessionStarredAt,
    currentSessionOrigin,
    messages,
    sessionSummaries,
    eventsByTurn,
    activeTurnId,
    isBusy,
    error,
    sessionTypeFilter,
    timeSavedBySession,
    coachingSessionIds,
    memoryApprovalSessionIds,
    currentSessionMeetingCompanion, // Bug 12 fix - show video icon for current session
    unreadSessionIds,
  });

  sidebarEntriesRef.current = sidebarAgentSessions;

  // Auto-switch to next session after marking current session done.
  // Prefers the adjacent session in the visual list (captured at done time)
  // so the user lands on the conversation that was next/previous in the sidebar.
  // Falls back to selectNextSession if the adjacent session can't be opened.
  useEffect(() => {
    const pending = pendingDoneAutoSwitchRef.current;
    if (!pending) return;

    // Clear stale pending if user navigated away before effect triggered
    if (pending.sessionId !== currentSessionId) {
      pendingDoneAutoSwitchRef.current = null;
      return;
    }

    // Trigger when current session becomes Done (`doneAt != null`)
    if (currentSessionDoneAt != null) {
      pendingDoneAutoSwitchRef.current = null;
      let cancelled = false;

      // Prefer the adjacent session captured at done time (preserves list position),
      // fall back to selectNextSession heuristic if unavailable
      const targetId = pending.nextInListId
        ?? selectNextSession({ doneSessionId: currentSessionId, sections })?.session?.id
        ?? null;

      if (targetId) {
        navigateToConversation(targetId).then((opened) => {
          if (cancelled) return;
          if (!opened) {
            resetSessionState();
          }
        }).catch(() => {
          if (!cancelled) resetSessionState();
        });
      } else {
        // No suitable session found - start fresh
        resetSessionState();
      }

      return () => { cancelled = true; };
    }
  }, [currentSessionId, currentSessionDoneAt, sections, navigateToConversation, resetSessionState]);

  const {
    pendingDeleteSession,
    deletingSessionId,
    requestDeleteSession: handleDeleteHistorySession,
    confirmDeleteSession: handleConfirmDeleteSession,
    cancelDeleteSession: handleCancelDeleteSession
  } = useSessionDeleteDialog({
    sessionSummaries,
    currentSessionId,
    currentSessionSidebarEntry,
    isBusy,
    queuedMessageCount: currentSessionQueueCount, // Use session-scoped count, not global
    sidebarAgentSessions,
    messages,
    executeSessionDeletion
  });

  const {
    editingSessionId,
    editValue,
    inputRef: editInputRef,
    startRename,
    handleEditChange,
    handleEditKeyDown,
    handleEditBlur
  } = useSessionRename({ onRename: renameSession });

  const {
    query: sessionSearchQuery,
    results: sessionSearchResults,
    isSearching,
    searchStatus: sessionSearchStatus,
    retrySearch: retrySessionSearch,
    findSimilarSource,
    deepSearchResults: sessionDeepSearchResults,
    isDeepSearching,
    triggerDeepSearch,
    selectedIndex: sessionSearchSelectedIndex,
    lastSearchQuery: sessionLastSearchQuery,
    recencyFilter: sessionRecencyFilter,
    setRecencyFilter: setSessionRecencyFilter,
    handleQueryChange: handleSessionSearchQueryChange,
    handleKeyDown: handleSessionSearchKeyDown,
    handleHoverResult: handleSessionSearchHover,
    clearSearch: clearSessionSearch,
    restoreSearch: restoreSessionSearch,
    setFindSimilarResults: setSessionSemanticResults
  } = useSessionSearch({
    sessionSummaries,
    currentSessionId,
    currentSessionTitle,
    currentSessionResolvedAt,
    currentSessionOrigin,
    messages,
    emitLog,
    onSelectResult: handleSidebarSelect,
    sessionTypeFilter
  });

  // Recency filtering is now handled inside AgentSessionSidebar alongside status filtering

  // Guards rapid Find Similar re-triggers from resolving out of order (GPT stage-review F1):
  // only the latest request commits its results/title/toasts.
  const findSimilarRequestIdRef = useRef(0);
  const handleFindSimilar = useCallback(
    async (sessionId: string) => {
      const requestId = ++findSimilarRequestIdRef.current;
      try {
        const sourceTitle = sessionId === currentSessionId
          ? currentSessionTitle
          : (sessionSummaries.find((s) => s.id === sessionId)?.title ?? '');
        const { results, status } = await findSimilarConversations(sessionId, { limit: 5 });
        // A newer Find Similar trigger superseded this one — drop the stale result.
        if (requestId !== findSimilarRequestIdRef.current) return;

        // Handle different status conditions
        if (status === 'source_not_indexed') {
          showToast({ title: 'Still indexing this conversation — try again shortly' });
          return;
        }
        if (status === 'index_not_ready') {
          showToast({ title: 'Search is warming up — try again shortly' });
          return;
        }
        if (status === 'demo_mode') {
          showToast({ title: "Find similar isn't available in demo mode" });
          return;
        }
        if (status === 'error') {
          showToast({ title: "Couldn't find similar conversations" });
          return;
        }

        if (results.length === 0) {
          showToast({ title: 'No similar conversations turned up' });
          return;
        }
        // Deduplicate by sessionId (keep first/highest score) to prevent duplicate React keys
        const seen = new Set<string>();
        const dedupedResults = results.filter((r) => {
          if (seen.has(r.sessionId)) return false;
          seen.add(r.sessionId);
          return true;
        });
        setSessionSemanticResults(dedupedResults, { sessionId, title: sourceTitle ?? '' });
      } catch (err) {
        // Drop stale failures too, so a superseded request can't clobber the latest with a toast.
        if (requestId !== findSimilarRequestIdRef.current) return;
        showToast({ title: "Couldn't find similar conversations" });
        console.error('[App] Find similar conversations failed:', err);
      }
    },
    [currentSessionId, currentSessionTitle, sessionSummaries, showToast, setSessionSemanticResults]
  );

  // Track which sessions are indexed for semantic search (for tooltip display)
  const [indexedSessionIds, setIndexedSessionIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    const fetchIndexStatus = async () => {
      try {
        const status = await window.searchApi.conversationIndexStatus();
        setIndexedSessionIds(new Set(status.indexedSessionIds));
      } catch {
        // Silently fail - index status is non-critical
      }
    };
    fireAndForget(fetchIndexStatus(), 'fetchConversationIndexStatus');
    // Refresh every 60 seconds to catch newly indexed sessions (reduced from 30s to minimize IPC overhead)
    const interval = setInterval(() => { fireAndForget(fetchIndexStatus(), 'refreshConversationIndexStatus'); }, 60_000);
    return () => clearInterval(interval);
  }, []);

  // Session pills removed from the toolbar; no unresolved session tray is rendered.

  const handleSelectInlineStep = useCallback((turnId: string, stepNumber: number | null) => {
    if (!turnId || turnId === TURN_ID_FALLBACK) {
      return;
    }
    setActiveStepByTurn((prev) => {
      const currentValue = prev[turnId] ?? null;
      if (currentValue === stepNumber) {
        return prev;
      }
      const next = { ...prev };
      if (stepNumber === null) {
        if (turnId in next) {
          delete next[turnId];
          return next;
        }
        return prev;
      }
      next[turnId] = stepNumber;
      return next;
    });
  }, []);

  const handleCopyToClipboard = useCallback(
    (_text: string) => {
      showToast({ title: 'Copied' });
    },
    [showToast]
  );

  // Copy conversation link (rebel://conversation/{id}) to clipboard
  const handleCopyConversationLink = useCallback(
    (sessionId: string) => {
      const link = formatNavigationUrl({ type: 'sessions', sessionId });
      navigator.clipboard.writeText(link).then(
        () => showToast({ title: 'Copied' }),
        () => showToast({ title: "Couldn't copy that link" })
      );
    },
    [showToast]
  );

  // Share conversation — opens dialog to choose expiry & optional password
  const handleShareConversation = useCallback(
    (sessionId: string) => setSharingSessionId(sessionId),
    []
  );

  const handleShareConfirm = useCallback(
    async (opts: ShareDialogResult) => {
      setSharingSessionId(null);
      if (!opts.sessionId) {
        showToast({ title: "Couldn't create share link" });
        return;
      }
      try {
        const result = await window.cloudApi.shareCreate({
          sessionId: opts.sessionId,
          expiresIn: opts.expiresIn,
          password: opts.password,
        });
        if (!result.success || !result.shareId) {
          showToast({ title: result.error || "Couldn't create share link" });
          return;
        }
        const cloudUrl = settingsRef.current?.cloudInstance?.cloudUrl;
        if (!cloudUrl) {
          showToast({ title: 'Cloud not connected' });
          return;
        }
        const shareUrl = `${cloudUrl.replace(/\/+$/, '')}/app/shared/${result.shareId}`;
        navigator.clipboard.writeText(shareUrl).then(
          () => showToast({ title: 'Link copied — anyone with it can view this conversation' }),
          () => showToast({ title: "Couldn't copy that link" })
        );
      } catch {
        showToast({ title: "Couldn't create share link" });
      }
    },
    [showToast]
  );

  // Share file — opens dialog to choose expiry & optional password (parallel to conversation sharing)
  const handleShareFile = useCallback(
    (filePath: string) => setSharingFilePath(filePath),
    []
  );

  const handleShareFileConfirm = useCallback(
    async (opts: ShareDialogResult) => {
      setSharingFilePath(null);
      if (!opts.filePath) {
        showToast({ title: "Couldn't create share link" });
        return;
      }
      try {
        const result = await window.cloudApi.shareCreate({
          resourceType: 'file' as const,
          filePath: opts.filePath,
          expiresIn: opts.expiresIn,
          password: opts.password,
        });
        if (!result.success || !result.shareId) {
          showToast({ title: result.error || "Couldn't create share link" });
          return;
        }
        const cloudUrl = settingsRef.current?.cloudInstance?.cloudUrl;
        if (!cloudUrl) {
          showToast({ title: 'Cloud not connected' });
          return;
        }
        const shareUrl = `${cloudUrl.replace(/\/+$/, '')}/app/shared/${result.shareId}`;
        navigator.clipboard.writeText(shareUrl).then(
          () => showToast({ title: 'Link copied — anyone with it can access this file' }),
          () => showToast({ title: "Couldn't copy that link" })
        );
      } catch {
        showToast({ title: "Couldn't create share link" });
      }
    },
    [showToast]
  );

  // Build markdown from conversation messages (shared by copy and export)
  // Note: For non-current sessions, this returns null and caller should lazy-load
  const buildConversationMarkdown = useCallback(
    (sessionId: string): { markdown: string; title: string } | null => {
      const summary = sessionSummariesRef.current.find((s) => s.id === sessionId);
      // For current session, use messages from state; for others, we can't export without lazy-loading
      // The caller (handleCopyMarkdown, handleExportMarkdown) handles this case
      const messagesForExport = sessionId === currentSessionId
        ? messages
        : []; // Non-current sessions need async loading - handled by callers

      if (messagesForExport.length === 0) {
        return null;
      }

      const title = summary?.title ?? currentSessionTitle ?? 'Conversation';
      const timestamp = new Date().toISOString().split('T')[0];
      const lines: string[] = [
        `# ${title}`,
        '',
        `*Exported on ${timestamp}*`,
        '',
        '---',
        '',
      ];

      for (const msg of messagesForExport) {
        let role: string;
        switch (msg.role) {
          case 'user':
            role = '**You**';
            break;
          case 'result':
            role = '**Tool Result**';
            break;
          default:
            role = '**Rebel**';
        }
        lines.push(`${role}:`);
        lines.push('');
        lines.push(msg.displayText ?? msg.text);
        lines.push('');
        if (msg.role === 'assistant' || msg.role === 'result') {
          const fallbackTexts = getPrimaryMcpAppFallbackTextsFromEvents(eventsByTurn[msg.turnId]);
          if (fallbackTexts.length > 0) {
            lines.push(fallbackTexts.join('\n\n'));
            lines.push('');
          }
        }
        lines.push('---');
        lines.push('');
      }

      return { markdown: lines.join('\n'), title };
    },
    [currentSessionId, currentSessionTitle, eventsByTurn, messages]
  );

  // Copy conversation as markdown to clipboard
  const handleCopyMarkdown = useCallback(
    (sessionId: string) => {
      const result = buildConversationMarkdown(sessionId);
      if (!result) {
        showToast({ title: 'Nothing to copy yet' });
        return;
      }
      navigator.clipboard.writeText(result.markdown).then(
        () => showToast({ title: 'Conversation copied as Markdown' }),
        () => showToast({ title: "Couldn't copy that" })
      );
    },
    [buildConversationMarkdown, showToast]
  );

  // Export conversation to markdown file
  const handleExportMarkdown = useCallback(
    async (sessionId: string) => {
      try {
        const result = buildConversationMarkdown(sessionId);
        if (!result) {
          showToast({ title: 'Nothing to export yet' });
          return;
        }

        const safeName = result.title.replace(/[^a-zA-Z0-9 -]/g, '').trim().slice(0, 50);
        const now = new Date();
        const stamp = now.toISOString().slice(2, 16).replace(/[-:T]/g, '').replace(/(\d{6})(\d{4})/, '$1_$2');
        const fileName = `${safeName || 'conversation'}-${stamp}.md`;

        const saveResult = await window.exportApi.saveFile({
          data: new TextEncoder().encode(result.markdown).buffer,
          fileName,
          filters: [{ name: 'Markdown', extensions: ['md'] }],
          title: 'Export Conversation as Markdown'
        });

        if (saveResult.success) {
          showToast({ title: EXPORT_SUCCESS });
        } else if (!saveResult.cancelled) {
          showToast({ title: EXPORT_FAILED });
        }
      } catch (err) {
        console.error('[App] Export markdown failed:', err);
        showToast({ title: EXPORT_FAILED });
      }
    },
    [buildConversationMarkdown, showToast]
  );

  // Stable callback forwarding diagnose to DiagnoseDialogManager ref
  const handleStartDiagnose = useCallback(
    (sessionId: string) => diagnoseDialogManagerRef.current?.handleStartDiagnose(sessionId),
    [],
  );

  // Export conversation logs to a file
  const handleExportLogs = useCallback(
    async (sessionId: string) => {
      try {
        const result = await window.sessionsApi.exportLogs({ sessionId });
        if (!result.success || !result.content || !result.filename) {
          showToast({ title: result.error || 'Could not export logs' });
          return;
        }

        // Save to file via export:save-file
        const encoder = new TextEncoder();
        const data = encoder.encode(result.content);
        const saveResult = await window.exportApi.saveFile({
          data: data.buffer as ArrayBuffer,
          fileName: result.filename,
          filters: [{ name: 'Markdown', extensions: ['md'] }],
          title: 'Export Conversation Diagnostics',
        });

        if (saveResult.success) {
          showToast({ title: 'Diagnostics exported' });
        } else if (!saveResult.cancelled) {
          showToast({ title: EXPORT_FAILED });
        }
      } catch (err) {
        console.error('[App] Export diagnostics failed:', err);
        showToast({ title: EXPORT_FAILED });
      }
    },
    [showToast]
  );

  // Reveal session in sidebar (open sidebar and scroll to it)
  const [revealSessionId, setRevealSessionId] = useState<string | null>(null);
  const handleRevealInSidebar = useCallback(
    (sessionId: string) => {
      // Open the sidebar if not already open
      if (!flowHistoryOpen) {
        setFlowHistoryOpen(true);
      }
      // Clear any active search so all sessions are visible
      clearSessionSearch();
      // Set the session to reveal - sidebar will scroll to it
      setRevealSessionId(sessionId);
    },
    [flowHistoryOpen, setFlowHistoryOpen, clearSessionSearch]
  );
  const handleRevealComplete = useCallback(() => {
    setRevealSessionId(null);
  }, []);

  const _openPath = (target: string | null) => {
    if (target) {
      fireAndForget(window.appApi.openPath(target), 'openPathFromHelper');
    }
  };

  const pinnedFavorites = useMemo(
    // The collapsed pinned-tabs strip is an Active surface, so it excludes
    // background (app-initiated) kinds by construction — see isActiveNavEntry.
    () => sidebarAgentSessions.filter(isActiveNavEntry),
    [sidebarAgentSessions]
  );

  // Callback for NavigationContext to set the focused approval ID when navigating to tasks
  const handleSetTasksFocusApprovalId = useCallback(
    (id: string | undefined) => { setFocusApprovalId(id ?? null); },
    []
  );

  // Callback for NavigationContext to open feedback/bug report dialog
  const handleOpenFeedbackDialog = useCallback(
    (target: Extract<NavigationTarget, { type: 'feedback' }>) => {
      if (target.feedbackType) {
        setBugReportDefaultFeedbackType(target.feedbackType);
      }
      if (
        target.description
        || target.stepsToReproduce
        || target.expectedBehavior
        || target.attachContinuityDiagnostics
      ) {
        setBugReportPrefill({
          description: target.description,
          stepsToReproduce: target.stepsToReproduce,
          expectedBehavior: target.expectedBehavior,
          attachContinuityDiagnostics: target.attachContinuityDiagnostics,
        });
      }
      setBugReportOpen(true);
    },
    [setBugReportDefaultFeedbackType, setBugReportPrefill, setBugReportOpen]
  );

  const handleOpenSeededDashboardChat = useCallback(async (token: string): Promise<boolean> => {
    const result = await redeemDashboardShareToken(token);
    if (!result.success) {
      const copy = dashboardShareErrorCopy(result.errorCode);
      showToast({ ...copy, variant: result.errorCode === 'FORBIDDEN_SCOPE' ? 'error' : 'warning' });
      return false;
    }

    const payload = parseDashboardSharePayload(result.payload);
    if (!payload) {
      const copy = dashboardShareErrorCopy('UNSUPPORTED_PAYLOAD_VERSION');
      showToast({ ...copy, variant: 'warning' });
      return false;
    }

    const sessionId = startFreshSession({ showHistory: true });
    setActiveSurfaceWithSideEffects('sessions');
    setShowConversation(true);
    setIsTextMode(true);
    setFlowHistoryOpen(true);
    getSessionStoreState().setDraftForSession(sessionId, buildDashboardSeedDraft(payload));
    showToast({
      title: 'Dashboard table ready',
      description: 'Review the draft and send it when you are ready.',
      variant: 'success',
    });
    return true;
  }, [setActiveSurfaceWithSideEffects, setFlowHistoryOpen, setIsTextMode, setShowConversation, showToast, startFreshSession]);

  // Navigation provider dependencies - centralizes navigation logic
  // See docs/plans/finished/251219_unified_navigation_system.md
  const navigationDeps = useMemo<NavigationProviderDeps>(
    () => ({
      activeSurface,
      // Use wrapped version that includes side effects (setShowConversation for sessions/settings)
      setActiveSurface: setActiveSurfaceWithSideEffects,
      openSession: handleOpenHistorySession,
      openInsightsDrawer,
      openSettingsDialog: (...args: Parameters<typeof openSettingsDialog>) => { fireAndForget(openSettingsDialog(...args), 'navOpenSettingsDialog'); },
      closeSettingsDialog,
      loadWorkspaceFile,
      navigateToLibraryFolder: handleOpenWorkspaceFolder,
      navigateToLibraryLens: (lens) => navigateToLibraryLens(lens),
      settingsOpen,
      setTasksFocusApprovalId: handleSetTasksFocusApprovalId,
      selectUseCaseById: selectUseCaseById ? (useCaseId: string) => { fireAndForget(selectUseCaseById(useCaseId), 'navSelectUseCase'); } : undefined,
      showToast,
      openFeedbackDialog: handleOpenFeedbackDialog,
      openSeededDashboardChat: handleOpenSeededDashboardChat,
    }),
    [
      activeSurface,
      setActiveSurfaceWithSideEffects,
      handleOpenHistorySession,
      openInsightsDrawer,
      openSettingsDialog,
      closeSettingsDialog,
      loadWorkspaceFile,
      handleOpenWorkspaceFolder,
      navigateToLibraryLens,
      settingsOpen,
      handleSetTasksFocusApprovalId,
      selectUseCaseById,
      showToast,
      handleOpenFeedbackDialog,
      handleOpenSeededDashboardChat,
    ]
  );

  // Ctrl+Tab / Ctrl+Shift+Tab to cycle through pinned sessions
  const handleKeyboardSessionNav = useCallback(
    (sessionId: string) => handleOpenHistorySession(sessionId, 'keyboard_shortcut'),
    [handleOpenHistorySession]
  );
  usePinnedSessionNavigation({
    pinnedSessions: pinnedFavorites,
    currentSessionId,
    onOpenSession: handleKeyboardSessionNav,
  });

  // Cmd/Ctrl+N for new chat
  useGlobalHotkey(
    'mod+n',
    () => {
      handleNewChat('keyboard_shortcut');
    },
    [handleNewChat]
  );

  // Cmd/Ctrl+Shift+N for scratchpad
  useGlobalHotkey(
    'mod+shift+n',
    () => {
      setScratchpadOpen(true);
    },
    []
  );

  const handleQuickOpenHotkey = useCallback(() => {
    tracking.navigation.quickOpenOpened();
    setQuickOpenOpen(true);
  }, [setQuickOpenOpen]);

  // Cmd/Ctrl+O alias and Cmd/Ctrl+P for quick file open
  useGlobalHotkey(
    'mod+o',
    handleQuickOpenHotkey,
    [handleQuickOpenHotkey]
  );
  useGlobalHotkey(
    'mod+p',
    handleQuickOpenHotkey,
    [handleQuickOpenHotkey]
  );

  // Cmd/Ctrl+Shift+A for Atlas view in Library
  useGlobalHotkey(
    'mod+shift+a',
    () => {
      navigateToLibraryLens({ filter: 'spaces', view: 'atlas' });
    },
    [navigateToLibraryLens]
  );

  // eslint-disable-next-line no-restricted-syntax -- origin-classification-justified: open-session running indicator uses live current-session origin plus busy state, not history visibility.
  const isAutomationRunningInCurrentSession = currentSessionOrigin === 'automation' && isBusy;

  // Pre-memoize headerActions to avoid defeating AgentSessionSidebar's React.memo
  const sidebarHeaderActions = useMemo(() => (
    <div className="sidebar-chrome-actions">
      <HistoryFilterDropdown
        sessionTypeFilter={sessionTypeFilter}
        onSessionTypeFilterChange={handleSessionTypeFilterChange}
        recencyFilter={sessionRecencyFilter}
        onRecencyFilterChange={setSessionRecencyFilter}
        isAutomationRunning={isAutomationRunningInCurrentSession}
      />
      <Tooltip
        content={`New conversation (${formatAcceleratorDisplay('CommandOrControl+N')})`}
        delayShow={300}
      >
        <IconButton
          size="xs"
          className="sidebar-new-chat-button"
          onClick={() => handleNewChat('sidebar_button')}
          aria-label="New conversation"
        >
          <SquarePen size={14} strokeWidth={2} />
        </IconButton>
      </Tooltip>
    </div>
  ), [sessionTypeFilter, handleSessionTypeFilterChange, sessionRecencyFilter, setSessionRecencyFilter, isAutomationRunningInCurrentSession, handleNewChat]);

  // Pre-memoize checklistWidget slot (now just WhatsNewWidget) to avoid defeating AgentSessionSidebar's React.memo
  const sidebarChecklistWidget = useMemo(() => (
    <WhatsNewWidget 
      onSeeAll={() => setWhatsNewOpen(true)}
      onTryFeature={handleTryWhatsNewFeature}
    />
  ), [setWhatsNewOpen, handleTryWhatsNewFeature]);

  const [sidebarCatchUpReady, setSidebarCatchUpReady] = useState(true);
  const revealedSidebarSessionIdRef = useRef(currentSessionId);
  const revealedSidebarEntriesRef = useRef(sidebarAgentSessions);
  useEffect(() => {
    if (isRevealMasked) {
      setSidebarCatchUpReady(false);
      return;
    }

    const rafId = requestAnimationFrame(() => {
      setSidebarCatchUpReady(true);
      revealedSidebarSessionIdRef.current = currentSessionId;
      revealedSidebarEntriesRef.current = sidebarAgentSessions;
    });

    return () => cancelAnimationFrame(rafId);
  }, [currentSessionId, isRevealMasked, sidebarAgentSessions]);

  const shouldFreezeSidebarList = isRevealMasked || !sidebarCatchUpReady;
  const sidebarCurrentSessionId = shouldFreezeSidebarList
    ? revealedSidebarSessionIdRef.current
    : currentSessionId;
  const sidebarSessionsForRender = shouldFreezeSidebarList
    ? revealedSidebarEntriesRef.current
    : sidebarAgentSessions;

  // Memoize sidebar to prevent unnecessary re-renders when sidebar props haven't changed
  const sidebarElement = useMemo(() => (
    <DevProfiler id="AgentSessionSidebar">
      <AgentSessionSidebar
        currentSessionId={sidebarCurrentSessionId}
        sessions={sidebarSessionsForRender}
        sessionSearchQuery={sessionSearchQuery}
        sessionSearchResults={sessionSearchResults}
        findSimilarSource={findSimilarSource}
        isSearching={isSearching}
        searchStatus={sessionSearchStatus}
        onRetrySearch={retrySessionSearch}
        sessionDeepSearchResults={sessionDeepSearchResults}
        isDeepSearching={isDeepSearching}
        onTriggerDeepSearch={triggerDeepSearch}
        sessionSearchSelectedIndex={sessionSearchSelectedIndex}
        sessionSearchInputRef={sessionSearchInputRef}
        onSearchChange={handleSessionSearchQueryChange}
        onSearchKeyDown={handleSessionSearchKeyDown}
        onSearchHover={handleSessionSearchHover}
        onClearSearch={clearSessionSearch}
        onSelectSession={handleSidebarSelect}
        onSoftDeleteSession={handleSoftDeleteSession}
        onDeleteSession={handleDeleteHistorySession}
        onTogglePin={handleTogglePinSession}
        onToggleStar={handleToggleStarSession}
        onRestoreSession={handleRestoreSession}
        onEmptyTrash={handleEmptyTrash}
        sessionTypeFilter={sessionTypeFilter}
        onSessionTypeFilterChange={handleSessionTypeFilterChange}
        recencyFilter={sessionRecencyFilter}
        onRecencyFilterChange={setSessionRecencyFilter}
        editingSessionId={editingSessionId}
        editValue={editValue}
        editInputRef={editInputRef}
        onStartRename={startRename}
        onEditChange={handleEditChange}
        onEditKeyDown={handleEditKeyDown}
        onEditBlur={handleEditBlur}
        deletingSessionId={deletingSessionId}
        onFindSimilar={handleFindSimilar}
        onCopyMarkdown={handleCopyMarkdown}
        onExportMarkdown={handleExportMarkdown}
        onCopyLink={handleCopyConversationLink}
        onShareConversation={settings?.cloudInstance?.mode === 'cloud' ? handleShareConversation : undefined} /* Sidebar gates per-session on cloud_active; here we gate on cloud mode (backend rejects non-synced sessions) */
        onDiagnose={handleStartDiagnose}
        onExportLogs={handleExportLogs}
        lastSearchQuery={sessionLastSearchQuery}
        onRestoreSearch={restoreSessionSearch}
        indexedSessionIds={indexedSessionIds}
        revealSessionId={revealSessionId}
        onRevealComplete={handleRevealComplete}
        headerActions={sidebarHeaderActions}
        checklistWidget={sidebarChecklistWidget}
      />
    </DevProfiler>
  ), [
    // Session identity
    sidebarCurrentSessionId,
    // Session data
    sidebarSessionsForRender,
    // Search state
    sessionSearchQuery,
    sessionSearchResults,
    findSimilarSource,
    isSearching,
    sessionSearchStatus,
    retrySessionSearch,
    sessionDeepSearchResults,
    isDeepSearching,
    triggerDeepSearch,
    sessionSearchSelectedIndex,
    sessionSearchInputRef,
    handleSessionSearchQueryChange,
    handleSessionSearchKeyDown,
    handleSessionSearchHover,
    clearSessionSearch,
    // Session actions
    handleSidebarSelect,
    handleSoftDeleteSession,
    handleDeleteHistorySession,
    handleTogglePinSession,
    handleToggleStarSession,
    handleRestoreSession,
    handleEmptyTrash,
    // Filter state
    sessionTypeFilter,
    handleSessionTypeFilterChange,
    sessionRecencyFilter,
    setSessionRecencyFilter,
    // Rename state
    editingSessionId,
    editValue,
    editInputRef,
    startRename,
    handleEditChange,
    handleEditKeyDown,
    handleEditBlur,
    // Delete state
    deletingSessionId,
    // Context menu actions
    handleFindSimilar,
    handleCopyMarkdown,
    handleExportMarkdown,
    handleCopyConversationLink,
    handleShareConversation,
    settings?.cloudInstance?.mode,
    handleStartDiagnose,
    handleExportLogs,
    // Search restore
    sessionLastSearchQuery,
    restoreSessionSearch,
    // Indexing and reveal
    indexedSessionIds,
    revealSessionId,
    handleRevealComplete,
    // Pre-memoized sub-elements
    sidebarHeaderActions,
    sidebarChecklistWidget,
  ]);

  // Dynamically derive plugin sidebar tabs from the plugin registry
  const registeredPlugins = useRegisteredPlugins();
  const pluginSurfaceIds = useMemo(
    () => registeredPlugins.map(p => createPluginSurfaceId(p.manifest.id)),
    [registeredPlugins],
  );

  // Fall back to home if the active plugin surface was unregistered
  useEffect(() => {
    if (isPluginSurface(activeSurface) && !pluginSurfaceIds.includes(activeSurface)) {
      setActiveSurface('home');
    }
  }, [activeSurface, pluginSurfaceIds, setActiveSurface]);

  const surfaceTabs: SurfaceTab[] = useMemo(() => [
    { id: 'home', label: 'Home', icon: Home, tooltip: 'See what needs your attention, get recommendations, and start working.' },
    ...(settings?.experimental?.focusEnabled ? [{ id: 'focus' as const, label: 'Focus', icon: Target, tooltip: 'Plan your week around what matters.', maturity: 'early' as const }] : []),
    { id: 'sessions', label: 'Conversations', icon: MessageSquare, tooltip: 'Your conversation history with Rebel. Start new conversations or pick up where you left off.' },
    { id: 'tasks', label: 'Actions', badge: inboxBadgeCount + pendingApprovalCount, icon: Inbox, tooltip: "Your action items. Save tasks and have Rebel execute them when you're ready." },
    { id: 'automations', label: 'Automations', badge: providerWaitCauseCount, icon: Zap, tooltip: 'Schedule tasks to run automatically. Workflow refreshes, weekly reports, and more.' },
    { id: 'team', label: 'Operators', icon: Users, tooltip: 'Perspectives Rebel can ask during your work.' },
    { id: 'usecases', label: 'The Spark', icon: Rocket, tooltip: 'Discover what Rebel can do. Personalized suggestions, coaching insights, and quick links.' },
    { id: 'library', label: 'Library', icon: FolderOpen, tooltip: 'Everything Rebel can use to help you — skills for specific tasks, memories from your conversations, and files from your workspace.' },
    ...registeredPlugins.map((p, i) => ({
      id: pluginSurfaceIds[i],
      label: p.manifest.name,
      icon: Plug,
      tooltip: p.manifest.description ?? `Plugin: ${p.manifest.name}`,
      maturity: p.manifest.maturity as 'labs' | undefined,
      overflow: true,
    })),
    { id: 'settings', label: 'Settings', icon: Settings, tooltip: 'Configure Rebel: AI models, voice, connected tools, and preferences.' }
  ], [inboxBadgeCount, pendingApprovalCount, providerWaitCauseCount, registeredPlugins, pluginSurfaceIds, settings?.experimental?.focusEnabled]);

  const buildChannel = window.electronEnv?.buildChannel;
  const appVersion = window.electronEnv?.appVersion;
  const channelSuffix = getBuildChannelSuffix(buildChannel);

  const flowShellBrand = useMemo(() => (
    <>
      <Tooltip content="Start a new conversation" placement="bottom" delayShow={300}>
        <button
          type="button"
          data-testid="brand-home"
          className="brand-home-button"
          onClick={() => handleNewChat('brand_button')}
          aria-label="New conversation"
        >
          <BrandLogo className="brand-logo" height={18} />
          <span className="brand">Rebel</span>
        </button>
      </Tooltip>
      {appVersion && (
        <Tooltip content="View changelog" placement="bottom" delayShow={300}>
          <button
            type="button"
            className="brand-version-button"
            onClick={() => setWhatsNewOpen(true)}
            aria-label={`View changelog for version ${appVersion}${channelSuffix}`}
          >
            {appVersion}{channelSuffix}
          </button>
        </Tooltip>
      )}
    </>
  ), [handleNewChat, appVersion, channelSuffix, setWhatsNewOpen]);

  const showMeetingIndicator = settings?.meetingBotUnlocked === true && settings?.meetingBot?.joinMode !== 'never';
  
  const flowShellHeaderCenter = (
    <>
      {showMeetingIndicator && <MeetingStatusIndicator
      onSendRebel={async (meetingUrl, meetingTitle) => {
        tracking.meetingBot.sendClicked(meetingUrl, meetingTitle, 'indicator');
        const result = await window.meetingBotApi?.send?.({
          meetingUrl,
          meetingTitle,
        });
        tracking.meetingBot.sendResult(result?.success ?? false, result?.error);
        if (!result?.success) {
          console.error('Failed to send meeting bot:', result?.error);
        } else if (result.isOwner === false && result.canOverride && result.ownerName) {
          // Another user's bot is already in the meeting - show override dialog
          meetingCompanionRef.current?.requestDedupOverride({
            open: true,
            meetingUrl,
            meetingTitle,
            ownerName: result.ownerName,
          });
        }
      }}
      onSkip={(meetingUrl) => {
        tracking.meetingBot.skipped(meetingUrl);
        void window.api.skipMeeting?.(meetingUrl);
      }}
      onStopRecording={async (botId) => {
        const result = await window.meetingBotApi?.cancel?.({ botId });
        tracking.meetingBot.recordingStopped(botId, 'cloud', result?.success ? 'user' : 'error');
        if (!result?.success) {
          showToast({
            title: 'Could not stop recording',
            description: result?.recoverable
              ? 'Please try again'
              : 'Recording may still be active on the server',
            variant: 'error',
          });
        }
      }}
      onStopPhysicalRecording={async () => {
        const result = await window.physicalRecordingApi?.stopRecording?.({});
        if (!result?.success) {
          showToast({
            title: 'Could not stop recording',
            description: result?.error ?? 'Please try again',
            variant: 'error',
          });
        }
      }}
      onStopQuickCapture={quickCapture.stopRecording}
      onTryAgain={async (meetingUrl, meetingTitle, botId) => {
        // Cancel the stuck bot first so dedup doesn't silently return the same one
        if (botId) {
          await window.meetingBotApi?.cancel?.({ botId });
        }
        const result = await window.meetingBotApi?.send?.({
          meetingUrl,
          meetingTitle,
        });
        if (!result?.success) {
          console.error('Failed to resend meeting bot:', result?.error);
        }
      }}
      onDismiss={async () => {
        // Dismiss clears the UI status without cancelling on the backend.
        // This is used for terminal states (rejected, waiting_too_long, upload_failed)
        // where the bot is already done or failed. For actively recording bots,
        // onStopRecording is used instead.
        tracking.meetingBot.dismissed();
        await window.api.dismissMeetingStatus?.();
      }}
      onOpenSettings={() => {
        setActiveSurface('settings');
        fireAndForget(openSettingsDialog('meetings', 'notetaker', { source: 'link', interactionType: 'programmatic' }), 'navigateToMeetingSettings');
      }}
      onPrepMe={handleStartBackgroundSession}
      onShowPrep={loadWorkspaceFile}
      onJoinWithRebel={async (meetingUrl, meetingTitle, scheduledFor) => {
        const result = await window.meetingBotApi?.send?.({
          meetingUrl,
          meetingTitle,
          scheduledFor,
        });
        if (!result?.success) {
          console.error('Failed to schedule meeting bot:', result?.error);
        }
        // Open the meeting link in browser
        await window.appApi.openUrl(meetingUrl);
      }}
      onJoin={(meetingUrl) => {
        window.appApi.openUrl(meetingUrl);
      }}
      onRecordLocally={async (meetingTitle, botId) => {
        // Check if consent has been acknowledged
        const settings = await window.settingsApi?.get();
        if (!settings?.meetingBot?.localRecordingConsentAcknowledged) {
          // Store pending recording and show consent dialog
          pendingLocalRecordingRef.current = meetingTitle;
          setLocalRecordingConsentOpen(true);
          return;
        }
        
        // Cancel any active cloud bot first to avoid double transcripts
        if (botId) {
          const cancelResult = await window.meetingBotApi?.cancel?.({ botId });
          if (!cancelResult?.success) {
            // Don't block local recording start - just warn user
            showToast({
              title: 'Cloud recording may still be active',
              description: 'Starting local recording anyway',
              variant: 'default',
            });
          }
        }
        
        // Check permissions first
        const permCheck = await window.meetingBotApi?.checkLocalRecordingPermissions();
        if (!permCheck?.supported) {
          showToast({ title: permCheck?.unsupportedReason || 'Local recording not supported on this platform' });
          return;
        }
        if (!permCheck?.allGranted) {
          // Request permissions
          const permResult = await window.meetingBotApi?.requestLocalRecordingPermissions();
          if (!permResult?.success) {
            showToast({ title: 'Please grant permissions in your system settings and try again' });
            return;
          }
        }
        
        // Start local recording
        const result = await window.meetingBotApi?.startLocalRecording({ meetingTitle });
        if (!result?.success) {
          console.error('Failed to start local recording:', result?.error);
          showToast({ title: result?.error || 'Could not start local recording' });
        }
      }}
      onStopLocalRecording={async () => {
        const result = await window.meetingBotApi?.stopLocalRecording();
        if (!result?.success) {
          console.error('Failed to stop local recording:', result?.error);
          showToast({ title: result?.error || 'Could not stop recording' });
        }
      }}
      onSendMineAnyway={async (meetingUrl, meetingTitle) => {
        // Force send own bot even though a collaborator's bot is already in the meeting
        tracking.meetingBot.sendClicked(meetingUrl, meetingTitle, 'indicator');
        const result = await window.meetingBotApi?.send?.({
          meetingUrl,
          meetingTitle,
          forceJoin: true,
        });
        tracking.meetingBot.sendResult(result?.success ?? false, result?.error);
        if (!result?.success) {
          showToast({ title: 'Failed to send Rebel', variant: 'error' });
        }
      }}
      hasCompanion={!!meetingStatus.meeting?.meetingUrl && !!companionSessionByMeetingUrl[getMeetingKey(meetingStatus.meeting.meetingUrl)]}
      onOpenCompanion={() => {
        const meetingUrl = meetingStatus.meeting?.meetingUrl;
        if (!meetingUrl) return;
        const key = getMeetingKey(meetingUrl);
        const sessionId = companionSessionByMeetingUrl[key];
        if (sessionId) {
          fireAndForget(navigateToConversation(sessionId, 'meeting'), 'openCompanionSession');
        }
      }}
      />}
    </>
  );

  const handleOpenMeetingSettings = useCallback(() => {
    setActiveSurface('settings');
    fireAndForget(openSettingsDialog('meetings', 'notetaker', { source: 'link', interactionType: 'programmatic' }), 'navigateToMeetingSettingsFromCallback');
  }, [setActiveSurface, openSettingsDialog]);

  const handleOpenQuickOpen = useCallback(() => {
    handleQuickOpenHotkey();
  }, [handleQuickOpenHotkey]);

  const handleOpenAchievementHub = useCallback(() => {
    setAchievementHubOpen(true);
  }, [setAchievementHubOpen]);

  const handleOpenShortcuts = useCallback(() => {
    setShortcutsOpen(true);
  }, [setShortcutsOpen]);

  const handleOpenBugReport = useCallback(() => {
    setBugReportOpen(true);
  }, [setBugReportOpen]);

  const handleRequestConnector = useCallback(() => {
    setBugReportDefaultFeedbackType('improvement');
    setBugReportOpen(true);
  }, [setBugReportDefaultFeedbackType, setBugReportOpen]);

  const handleToggleNotifications = useCallback(() => {
    toggleApprovalsDrawer();
  }, [toggleApprovalsDrawer]);

  const flowShellHeaderRight = useMemo(() => (
    <>
      <div className="header-actions__main">
        <Tooltip
          content={`Quick open file (${formatAcceleratorDisplay('CommandOrControl+P')} / ${formatAcceleratorDisplay('CommandOrControl+O')})`}
          delayShow={300}
        >
          <IconButton
            size="sm"
            className="header-icon-button"
            onClick={handleOpenQuickOpen}
            aria-label="Quick open file"
          >
            <Search size={16} aria-hidden="true" />
          </IconButton>
        </Tooltip>

        {/* Notification bell - toggle approval stack visibility */}
        <Tooltip
          content={approvalsDrawerOpen ? 'Hide notifications' : 'Show notifications'}
          delayShow={300}
        >
          <IconButton
            size="sm"
            className={`header-icon-button notification-bell-button ${notificationDrawerCount > 0 ? 'notification-bell-button--has-pending' : ''} ${approvalsDrawerOpen ? 'notification-bell-button--active' : ''}`}
            onClick={handleToggleNotifications}
            aria-label={approvalsDrawerOpen ? 'Hide notifications' : 'Show notifications'}
            aria-pressed={approvalsDrawerOpen}
            data-testid="notification-bell-button"
          >
            {notificationDrawerCount > 0 ? (
              <BellRing size={16} aria-hidden="true" />
            ) : (
              <Bell size={16} aria-hidden="true" />
            )}
            {notificationDrawerCount > 0 && (
              <span className={`notification-bell-badge ${approvalsDrawerOpen ? '' : 'notification-bell-badge--attention'}`}>{notificationDrawerCount > 9 ? '9+' : notificationDrawerCount}</span>
            )}
          </IconButton>
        </Tooltip>
        {showMeetingIndicator && <MeetingButton
          onOpenSettings={handleOpenMeetingSettings}
          onStartQuickCapture={quickCapture.startRecording}
          isQuickCaptureRecording={quickCapture.isRecording}
          onSendToMeeting={async (meetingUrl, meetingTitle, scheduledFor) => {
            const result = await window.meetingBotApi?.send?.({
              meetingUrl,
              meetingTitle,
              ...(scheduledFor ? { scheduledFor } : {}),
            });
            return {
              success: result?.success ?? false,
              botId: result?.botId,
              error: result?.error,
              isOwner: result?.isOwner,
              ownerName: result?.ownerName,
              canOverride: result?.canOverride,
            };
          }}
        />}
        <PhysicalRecordingIndicator />
        <ProgressIndicator onClick={handleOpenAchievementHub} />
        <OfflineIndicator status={offlineStatus} />
        <CloudSyncIndicator
          cloudInstance={settings?.cloudInstance}
          onNavigateToCloud={() => {
            setActiveSurface('settings');
            // Navigate to Cloud tab; scroll to cloud capacity section so the tier picker is in view.
            fireAndForget(openSettingsDialog('cloud', 'cloudCapacity', { source: 'link', interactionType: 'programmatic' }), 'navigateToCloudSettings');
          }}
        />
        <HelpMenu
          onShowShortcuts={handleOpenShortcuts}
          onReportBug={handleOpenBugReport}
          onCheckForUpdates={handleCheckForUpdates}
          onDownloadDiagnostics={openDownloadDiagnosticsDialog}
          healthStatus={healthStatus}
          healthIssueCount={healthIssueCount}
          onTroubleshoot={handleTroubleshoot}
        />
      </div>

      <div className="header-divider" aria-hidden="true" />

      <Tooltip
        content={`New conversation (${formatAcceleratorDisplay('CommandOrControl+N')})`}
        delayShow={300}
      >
        <Button
          variant="secondary"
          size="sm"
          onClick={() => handleNewChat('header_button')}
          aria-label="New conversation"
          data-testid="new-chat-button"
        >
          <SquarePen size={14} aria-hidden="true" />
          <span>New</span>
        </Button>
      </Tooltip>
    </>
  ), [
    handleOpenQuickOpen,
    handleNewChat,
    showMeetingIndicator,
    quickCapture.isRecording,
    quickCapture.startRecording,
    handleOpenMeetingSettings,
    handleOpenAchievementHub,
    handleOpenShortcuts,
    handleOpenBugReport,
    handleCheckForUpdates,
    openDownloadDiagnosticsDialog,
    healthStatus,
    healthIssueCount,
    handleTroubleshoot,
    approvalsDrawerOpen,
    handleToggleNotifications,
    settings?.cloudInstance,
    notificationDrawerCount,
    openSettingsDialog,
    setActiveSurface,
    offlineStatus,
  ]);

  const handleSubmitTextPrompt = useCallback(async (mode?: 'queue' | 'sendNow') => {
    if (isPreparingMentionContextRef.current) return;

    const prompt = composerRef.current?.getText()?.trim() ?? '';
    if (!prompt) return;
    lastUserSubmitAtRef.current = Date.now();

    const fileAttachments = composerRef.current?.getAttachments() ?? [];

    // Combine file attachments, conversation attachments, and uploaded files
    const hasConversationRefs = extractConversationReferences(prompt).length > 0;
    if (hasConversationRefs) {
      isPreparingMentionContextRef.current = true;
      setIsPreparingMentionContext(true);
    }
    try {
      const allAttachments = await buildAttachmentsForPrompt(prompt, fileAttachments);

      // Drain any pending document-annotation onCommit closures for
      // the submitting session. Closures are accumulated when the user
      // clicks "Send to Rebel" on a document (via the
      // `library:send-annotations` event or
      // `handleSendWorkspaceAnnotations`) — matrix rows 8 and 9 rely
      // on multiple pending closures all firing on this dispatch:
      //   - Each one rides with exactly this submission.
      //   - A subsequent send on the same session starts a fresh
      //     accumulation (map entry was deleted by this drain).
      //   - Edit/rerun submissions drop the onCommit entirely — the
      //     planning doc's "rerun-edit does NOT fire onCommit" rule.
      //
      // If the user never clicked "Send to Rebel" the map has no entry
      // and the drain is a no-op — the submission proceeds normally.
      const submissionSessionId = getSessionStoreState().currentSessionId;
      // Backup empty-draft guard (FIX A, REV 2 belt-and-braces): if the
      // composer's live text is empty or whitespace-only at dispatch
      // time (a condition the `!prompt` early-return above already
      // guards against, but we re-check here to self-correct should
      // the primary `onHasTextChange(false)` detection miss a
      // transition), drop any stashed closures without firing them.
      // Never silently fires a stale onCommit on a truly-empty
      // composer. `prompt` above is guaranteed non-empty at this
      // point, so this is only a defensive re-read.
      const liveComposerText =
        composerRef.current?.getText()?.trim() ?? '';
      if (!liveComposerText && submissionSessionId) {
        pendingDocumentAnnotationOnCommitRef.current.delete(
          submissionSessionId,
        );
      }
      const stashedEntries =
        submissionSessionId && liveComposerText
          ? pendingDocumentAnnotationOnCommitRef.current.get(
              submissionSessionId,
            )
          : undefined;
      if (submissionSessionId && stashedEntries) {
        pendingDocumentAnnotationOnCommitRef.current.delete(submissionSessionId);
      }

      let ipcPrompt = prompt;
      let displayText: string | undefined;
      if (stashedEntries) {
        for (const entry of stashedEntries) {
          if (prompt.includes(entry.messageSnapshot) && entry.fencedMessage) {
            ipcPrompt = ipcPrompt.replace(entry.messageSnapshot, entry.fencedMessage);
            displayText = prompt;
          }
        }
      }

      // Always fire stashed onCommit callbacks for the submitting
      // session. The user explicitly clicked "Send to Rebel" which
      // establishes clear intent — whether they then add context,
      // rephrase, or edit around the annotation block shouldn't gate
      // the clear. The "user abandoned the send" case is already
      // handled by FIX A (empty-composer transition drops stashed
      // closures) and the immediate-clear checkbox in the dialog.
      const pendingOnCommits = stashedEntries
        ? stashedEntries.map((entry) => entry.onCommit)
        : undefined;

      // Compose all pending closures into a single sequential onCommit.
      // Each callback is awaited so flush-on-clear disk writes complete
      // before the next fires. Errors are isolated per-callback so one
      // failure doesn't skip the rest.
      const composedOnCommit: (() => Promise<void>) | undefined =
        pendingOnCommits && pendingOnCommits.length > 0
          ? async () => {
              for (const cb of pendingOnCommits) {
                try {
                  await cb();
                } catch (err) {
                  emitLog({
                    level: 'error',
                    message: 'Composed annotation onCommit callback failed',
                    context: {
                      sessionId: submissionSessionId ?? null,
                      error: err instanceof Error ? err.message : String(err),
                    },
                    timestamp: Date.now(),
                  });
                }
              }
            }
          : undefined;

      const baseOptions = editingMessageId
        ? { editTargetMessageId: editingMessageId, queueMode: mode }
        : { queueMode: mode };
      const optionsWithDisplay = displayText !== undefined
        ? { ...baseOptions, displayText }
        : baseOptions;
      // Edit/rerun path intentionally drops onCommit — matches the
      // planning doc's "rerun-edit does NOT fire onCommit" semantics.
      // The stashed closures have already been consumed above; dropping
      // them silently here means the user's annotations remain intact
      // if they're editing a prior message.
      const options = editingMessageId || !composedOnCommit
        ? optionsWithDisplay
        : { ...optionsWithDisplay, onCommit: composedOnCommit };

      // Capture voice source before clearing (clearComposerAfterSend resets the flag)
      const source: 'text' | 'voice' = pendingVoiceSourceRef.current ? 'voice' : 'text';

      clearComposerAfterSend();

      if (editingMessageId) {
        cancelEditMessage();
      }

      const promptWithOperatorHints = appendOperatorMentionHints(ipcPrompt, availableOperators);
      const optionsWithOperatorDisplay = promptWithOperatorHints === ipcPrompt
        ? options
        : { ...options, displayText: displayText ?? prompt };
      await submitQueuedMessage(promptWithOperatorHints, source, allAttachments, optionsWithOperatorDisplay);
      await finalizePendingTaskExecution();
    } catch (attachmentError) {
      showToast({
        title: attachmentError instanceof Error ? attachmentError.message : 'Unable to attach mentioned files'
      });
      return;
    } finally {
      if (hasConversationRefs) {
        isPreparingMentionContextRef.current = false;
        setIsPreparingMentionContext(false);
      }
    }

  }, [
    buildAttachmentsForPrompt,
    cancelEditMessage,
    clearComposerAfterSend,
    editingMessageId,
    emitLog,
    extractConversationReferences,
    finalizePendingTaskExecution,
    availableOperators,
    showToast,
    submitQueuedMessage
  ]);

  // Toggle auto-done mode for current session (fire & forget)
  // When toggled during an active turn, also update doneAfterTurnIds so the current turn is affected
  const handleToggleAutoDone = useCallback((source: 'click' | 'keyboard' | 'long_press' = 'click') => {
    const newEnabled = !autoDoneEnabled;
    setAutoDoneEnabled(newEnabled);
    // Track the toggle action
    tracking.conversation.autoDoneToggled(newEnabled, source, Boolean(activeTurnId));
    // If there's an active turn, add/remove from doneAfterTurnIds to affect this turn
    if (activeTurnId) {
      if (newEnabled) {
        getSessionStoreState().addDoneAfterTurnId(activeTurnId);
      } else {
        getSessionStoreState().removeDoneAfterTurnId(activeTurnId);
      }
    }
  }, [autoDoneEnabled, setAutoDoneEnabled, activeTurnId]);

  // Mark current session done immediately (from session settings menu)
  // Lifecycle: `doneAt == null` means Active, `doneAt != null` means Done.
  // Uses handleTogglePinSession to get the auto-switch behavior (switch to next session)
  const handleMarkDoneNow = useCallback(() => {
    if (currentSessionId && currentSessionDoneAt == null) {
      tracking.conversation.markDoneNow('menu');
      handleTogglePinSession(currentSessionId);
      // No toast - session moves to done section, visual feedback is clear
    }
  }, [currentSessionId, currentSessionDoneAt, handleTogglePinSession]);

  // Handle mind map canvas attachment - adds to composer instead of sending
  const handleCanvasSend = useCallback(async (data: MindMapExport) => {
    // Convert PNG blob to base64 efficiently using FileReader
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Remove data URL prefix (e.g., "data:image/png;base64,")
        const base64Data = result.split(',')[1];
        resolve(base64Data);
      };
      reader.onerror = () => reject(new Error('Failed to read image data'));
      reader.readAsDataURL(data.png);
    });

    const imageAttachment: import('@shared/types').ImageAttachmentPayload = {
      id: `mindmap-${Date.now()}`,
      name: 'Mind Map',
      type: 'image',
      mimeType: 'image/png',
      base64Data: base64,
      sizeBytes: data.png.size,
      width: data.width,
      height: data.height,
    };

    // Add attachment to composer and pre-fill with semantic text
    composerRef.current?.addImageAttachment(imageAttachment);
    
    // Pre-fill composer with the semantic structure as context
    const currentText = composerRef.current?.getText()?.trim() || '';
    const mindMapContext = `Here's my mind map:\n\`\`\`\n${data.semanticText}\n\`\`\`\n\n`;
    composerRef.current?.setText(toComposerWireMarkdown(currentText ? `${mindMapContext}${currentText}` : mindMapContext));
    
    // Focus composer so user can add their message
    composerRef.current?.focus();
    setCanvasOpen(false);
  }, []);

  // Handle canvas error
  const handleCanvasError = useCallback((message: string) => {
    showToast({ title: message });
  }, [showToast]);

  // Cmd/Ctrl+Enter for done actions (context-sensitive):
  // - When idle with messages: Mark done immediately and switch to next session
  // - When busy with active turn: Toggle auto-done mode (mark done when turn completes)
  //
  // Uses capture-phase listener on document so it fires before React synthetic events,
  // Floating UI handlers, and react-hotkeys-hook (all of which use bubble phase).
  useEffect(() => {
    const handleModEnter = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey || event.altKey) return;

      if (activeSurface !== 'sessions' || composerHasText || editingMessageId) return;
      // AnnotationPopover uses Cmd+Enter for submit — let it through
      if (isAnnotationActive) return;
      if (isBackgroundConversationSession(currentSessionId)) return;

      // Consume the event fully — capture-phase stop prevents any downstream handlers
      // (React, Floating UI, menus) from seeing this keystroke
      event.preventDefault();
      event.stopPropagation();

      // Already done — give feedback instead of silently doing nothing
      if (currentSessionDoneAt != null) {
        showToast({ title: 'Already marked as done' });
        return;
      }

      const willEnable = !autoDoneEnabled;
      handleToggleAutoDone('keyboard');
      showToast({ title: willEnable ? 'Will mark as done when complete' : 'Auto-done disabled' });
    };

    document.addEventListener('keydown', handleModEnter, true);
    return () => document.removeEventListener('keydown', handleModEnter, true);
  }, [activeSurface, composerHasText, editingMessageId, isAnnotationActive, currentSessionDoneAt, isBusy, messages.length, activeTurnId, autoDoneEnabled, currentSessionId, handleTogglePinSession, handleToggleAutoDone, showToast]);

  // Text change handling is now internal to ComposerWithState

  const handleBeginEditLastUserMessage = useCallback(() => {
    const target = beginEditLastUserMessage();
    if (!target) {
      showToast({ title: 'Nothing to edit yet' });
      return;
    }

    // Note: useEditShortcutHint auto-hides when isEditing becomes true
    setShowConversation(true);
    setIsTextMode(true);
    setFlowHistoryOpen(true);
    composerRef.current?.setText(toComposerWireMarkdown(target.displayText ?? target.text));
  }, [
    beginEditLastUserMessage,
    setFlowHistoryOpen,
    setIsTextMode,
    setShowConversation,
    showToast
  ]);

  const handleCancelEditMessage = useCallback(() => {
    cancelEditMessage();
    composerRef.current?.setText(toComposerWireMarkdown(''));
    // Note: useEditShortcutHint auto-manages visibility based on isEditing state
  }, [cancelEditMessage]);

  const handleComposerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'ArrowUp') {
        // Check if composer is empty using ref
        const currentText = composerRef.current?.getText()?.trim() ?? '';
        if (!currentText && !editingMessageId) {
          event.preventDefault();
          handleBeginEditLastUserMessage();
        }
        return;
      }

      // Note: Mention navigation is now handled internally by ComposerWithState
      // This handler only receives non-mention keystrokes

      if (event.key === 'Escape' && editingMessageId) {
        event.preventDefault();
        handleCancelEditMessage();
        return;
      }

      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        // If currently recording, Enter stops the recording (same as clicking mic button)
        if (isTranscribing) {
          handleToggleTranscription();
          return;
        }
        fireAndForget(handleSubmitTextPrompt(
          resolveComposerSubmitMode({ isBusy, isEditing: Boolean(editingMessageId) })
        ), 'submitTextOnEnter');
        return;
      }
      if (event.key === 'Enter' && event.shiftKey) {
        event.stopPropagation();
        return;
      }
    },
    [
      editingMessageId,
      handleBeginEditLastUserMessage,
      handleCancelEditMessage,
      handleSubmitTextPrompt,
      handleToggleTranscription,
      isBusy,
      isTranscribing
    ]
  );

  // MentionPopover is now rendered inside ComposerWithState

  const _isVoicePending = pendingInputSource === 'voice';
  const isTextPending = pendingInputSource === 'text';
  const isEditing = Boolean(editingMessageId);
  const hasUserMessages = messages.some((message) => message.role === 'user');
  const showInlineEditButton = hasUserMessages || isEditing;
  const _editButtonDisabled =
    isStopping ||
    isTextPending ||
    (!isEditing && !hasUserMessages);
  const editShortcutModifier = useMemo(() => resolveShortcutModifier(), []);
  const editShortcutDisplay = editShortcutModifier === '⌘' ? '⌘↑' : 'Ctrl+↑';

  // Show edit hint when composer is empty and user has messages
  const showEditShortcutHint = useEditShortcutHint({
    showInlineEditButton,
    isEditing,
    isTextMode,
    composerHasText,
  });

  // Compute placeholder with edit shortcut hint - shows "Press ⌘↑ to edit" after delay
  const composerPlaceholder = isEditing
    ? 'Edit your last message'
    : showEditShortcutHint
      ? `Press ${editShortcutDisplay} to edit your last message`
      : 'Type your command, or click the microphone to speak it';

  // Composer text-presence transitions.
  //
  // Primary behaviour: mirror `composerHasText` for the edit-hint hook.
  //
  // Additional: when the composer transitions to EMPTY we drop any
  // pending document-annotation `onCommit` closures for the currently
  // focused session (FIX A, REV 2). Covers this scenario:
  //
  //   1. User clicks "Send to Rebel" on a document → onCommit stashed +
  //      draft pre-filled with the formatted annotation message.
  //   2. User select-all-deletes the pre-filled draft → textPrompt = ''.
  //   3. User types unrelated text → textPrompt = '...'.
  //   4. User submits → without this drop, the stale onCommit would
  //      fire and clear annotations the user never actually sent.
  //
  // Safe against the submit path: `handleSubmitTextPrompt` drains
  // `pendingDocumentAnnotationOnCommitRef` for the target session
  // BEFORE `clearComposerAfterSend()` runs, so by the time the
  // composer's empty-transition effect fires post-submit the map
  // entry for that session is already gone. The drop is a no-op.
  //
  // Safe against session switching: `currentSessionId` is read at
  // callback time, so a switch-from-A-to-B that empties B's composer
  // only drops B's map entry — A's stashed closures remain live.
  //
  // Note: `onHasTextChange` is fired by the composer only on actual
  // presence flips (empty↔non-empty), not per keystroke, so a user
  // typing-and-backspacing a single character triggers a drop only if
  // they cross the empty boundary, which is the intended signal.
  const handleComposerHasTextChange = useCallback((hasText: boolean) => {
    setComposerHasText(hasText);
    if (!hasText) {
      const sessionId = getSessionStoreState().currentSessionId;
      if (sessionId) {
        dropPendingDocumentAnnotationOnCommits(sessionId);
      }
    }
  }, [dropPendingDocumentAnnotationOnCommits]);

  // ComposerWithState props - most state is now internal to the component
  const composerProps: ComposerWithStateProps = useMemo(() => ({
    sessionId: currentSessionId,
    placeholder: composerPlaceholder,
    isEditing,
    isBusy,
    isStopping,
    isTextPending,
    isPreparingMentionContext,
    processingTurnId: activeTurnId,
    hasWorkspace: Boolean(settings?.coreDirectory),
    hasConversations: sessionSummaries.length > 0,
    hasOperators: availableOperators.length > 0 || operatorsLoading,
    onOpenOperatorsPanel: () => setActiveSurface('team'),
    resolveOperatorMention: (operatorSlug) => {
      const operator = operatorsBySlug.get(operatorSlug);
      return operator
        ? {
            operatorId: operator.id,
            operatorName: operator.displayName ?? operator.name,
          }
        : null;
    },
    mentionResultsForQuery,
    ensureLibraryIndex,
    getRelativeLibraryPath,
    resolveMentionedFiles,
    onSubmit: handleSubmitTextPrompt,
    onStopActiveTurn: stopActiveTurn,
    onCancelEdit: handleCancelEditMessage,
    onKeyDown: handleComposerKeyDown,
    showToast,
    onHasTextChange: handleComposerHasTextChange,
    onUserTyping: () => { pendingVoiceSourceRef.current = false; },
    onComposerFocus: triggerWarmupIfNeeded,
    onMentionPopoverOpened: showMentionTooltip,
    isTranscribing,
    isTranscribeProcessing,
    onToggleTranscription: handleToggleTranscription,
    coreDirectory: settings?.coreDirectory,
    libraryIndex,
    libraryIndexLoading,
    libraryIndexError,
    refreshLibraryIndex,
    agentSessionsCount: sessionSummaries.length,
    onOpenCanvas: () => setCanvasOpen(true)
  }), [
    currentSessionId,
    composerPlaceholder,
    isEditing,
    isBusy,
    isStopping,
    isTextPending,
    isPreparingMentionContext,
    activeTurnId,
    settings?.coreDirectory,
    sessionSummaries.length,
    availableOperators.length,
    operatorsBySlug,
    operatorsLoading,
    setActiveSurface,
    mentionResultsForQuery,
    ensureLibraryIndex,
    getRelativeLibraryPath,
    resolveMentionedFiles,
    handleSubmitTextPrompt,
    stopActiveTurn,
    handleCancelEditMessage,
    handleComposerKeyDown,
    handleComposerHasTextChange,
    showToast,
    triggerWarmupIfNeeded,
    showMentionTooltip,
    isTranscribing,
    isTranscribeProcessing,
    handleToggleTranscription,
    libraryIndex,
    libraryIndexLoading,
    libraryIndexError,
    refreshLibraryIndex
  ]);



  // Canonical callback for cross-session messages (approvals, staged file instructions, etc.).
  // Used by InboxPanel, NotificationDrawer, AutomationsPanel, and SessionSurfaceContent (via actionsRef).
  // When receiptText is provided, the message is hidden and a compact receipt is injected (FOX-2782).
  // When options.isHidden is true, the message is hidden without a receipt chip (AskUserQuestion continuations).
  const handleInboxSendMessage = useCallback(async (
    sessionId: string,
    message: string,
    receiptText?: string,
    options?: { isHidden?: boolean; attachments?: AnyAttachmentPayload[]; continuationContext?: import('@shared/types').AgentTurnRequest['continuationContext'] },
  ): Promise<void> => {
    const { shouldHide, messageOrigin } = resolveSendMessageOptions({ receiptText, options });
    if (submitQueuedMessageRef.current) {
      await submitQueuedMessageRef.current(message, 'text', options?.attachments, {
        targetSessionId: sessionId,
        queueMode: 'queue',
        isSystemContinuation: true,
        isHidden: shouldHide,
        messageOrigin,
        ...(options?.continuationContext ? { continuationContext: options.continuationContext } : {}),
      });
    } else {
      await handleUserMessage(message, 'text', options?.attachments ?? [], undefined, sessionId, {
        isSystemContinuation: true,
        isHidden: shouldHide,
        messageOrigin,
        ...(options?.continuationContext ? { continuationContext: options.continuationContext } : {}),
      });
    }
    if (receiptText) {
      const store = getSessionStoreState();
      const isCurrentSession = !sessionId || sessionId === store.currentSessionId;
      if (isCurrentSession) {
        store.addReceiptMessage(receiptText);
      }
    }
  }, [handleUserMessage]);

  const handleInboxAddReceiptToSession = useCallback(async (
    sessionId: string,
    receiptText: string,
  ): Promise<void> => {
    await getSessionStoreState().addReceiptMessageToSession(sessionId, receiptText);
  }, []);

  // ── Session surface: ref-based actions object for SessionSurfaceContent ──
  // A single stable ref holds all callbacks. SessionSurfaceContent reads .current
  // at invocation time, so React.memo can bail out when only callbacks changed.
  const sessionActionsRef = useRef<SessionSurfaceActions>({} as SessionSurfaceActions);
  sessionActionsRef.current = {
    // Navigation / session management
    handleNewChat,
    handleOpenHistorySession,
    handleTogglePinSession,
    setSelectedTrashedSessionId,
    restoreSession,
    openHistorySession,
    navigateToConversation,
    // Message editing
    handleBeginEditMessage,
    handleRetryMessage,
    // Turn / step interaction
    handleSelectInlineStep,
    focusTurn,
    resolveTurnIdForMessage,
    // File / navigation actions
    handleOpenDocumentInPreview,
    handleOpenWorkspaceFolder,
    handleOpenConversationReference,
    handleNavigateFromChat: (...args: Parameters<typeof handleNavigateFromChat>) => { fireAndForget(handleNavigateFromChat(...args), 'sessionNavigateFromChat'); },
    handleOpenTutorial,
    handleCopyToClipboard,
    handleOpenInLibrary: (...args: Parameters<typeof handleOpenInLibrary>) => { fireAndForget(handleOpenInLibrary(...args), 'sessionOpenInLibrary'); },
    handleSelectUseCase,
    // Session actions menu
    startRename,
    handleSoftDeleteSession,
    handleFindSimilar: (...args: Parameters<typeof handleFindSimilar>) => { fireAndForget(handleFindSimilar(...args), 'sessionFindSimilar'); },
    handleToggleStarSession,
    handleCopyMarkdown,
    handleExportMarkdown: (...args: Parameters<typeof handleExportMarkdown>) => { fireAndForget(handleExportMarkdown(...args), 'sessionExportMarkdown'); },
    handleCopyConversationLink,
    handleShareConversation: settings?.cloudInstance?.mode === 'cloud' ? handleShareConversation : undefined,
    handleRevealInSidebar,
    handleStartDiagnose,
    handleExportLogs: (...args: Parameters<typeof handleExportLogs>) => { fireAndForget(handleExportLogs(...args), 'sessionExportLogs'); },
    // Toast
    showToast,
    // Annotation callbacks
    submitQueuedMessage,
    handleSelectionMenuReply,
    handleSelectionMenuReplyInNewChat,
    handleGenericAddComment,
    handleSelectionMenuOpenChange,
    setIsAnnotationActive,
    clearComposerAfterSend,
    prepareMentionAttachments,
    prepareConversationAttachments,
    // Voice / recording
    handleToggleTranscription,
    handleStopAndSend,
    handleToggleAutoSpeak,
    setPrivateMode,
    setCouncilMode,
    requestCouncilReview,
    handleToggleAutoDone: handleToggleAutoDone as (source?: 'menu' | 'click' | 'keyboard' | 'long_press') => void,
    handleMarkDoneNow,
    stopActiveTurn: () => { fireAndForget(stopActiveTurn(), 'sessionStopActiveTurn'); },
    handleShowSettingsSurface,
    handleNavigateToVoiceSettings,
    emitLog,
    // Pending review
    approveAndRetry,
    dismiss,
    approveAllAndRetry,
    dismissAll,
    handleTrustToolAlways,
    executeStagedTool,
    rejectStagedTool,
    executeAllStagedTools,
    rejectAllStagedTools,
    publishStagedFile,
    discardStagedFile,
    keepStagedFilePrivate,
    saveMemory,
    skipMemory,
    saveAllMemory,
    skipAllMemory,
    // Notifications
    openNotificationsForSession: (sessionId: string) => {
      openApprovalsDrawer();
      setNotificationScrollTarget(sessionId);
    },
    // Cross-session messaging
    sendMessageToSession: handleInboxSendMessage,
    // Queued messages
    removeFromQueue,
    clearQueueForSession,
    sendQueuedMessageNow: (...args: Parameters<typeof sendQueuedMessageNow>) => { fireAndForget(sendQueuedMessageNow(...args), 'sessionSendQueuedNow'); },
    // Session coaching
    handleUserMessage: (...args: Parameters<typeof handleUserMessage>) => { fireAndForget(handleUserMessage(...args), 'sessionHandleUserMessage'); },
    updateCoachingState,
    setCoachingSessionIds,
    // Community share
    composeSharePost,
    openDiscourseShare,
    dismissShare,
    optOutSharing,
    // Discovery slot
    handleTryWhatsNewFeature,
  };

  // Pre-compute voice provider label (lifted from inline JSX)
  const voiceProviderLabel = useMemo(() => {
    if (settings?.voice.provider === 'local-parakeet') return 'Parakeet V3 (Local)';
    if (settings?.voice.provider === 'local-moonshine') return 'Moonshine Base (Local)';
    if (settings?.voice.provider === 'openai-whisper') return `OpenAI ${settings.voice.model}`;
    if (settings?.voice.model) return `ElevenLabs ${settings.voice.model}`;
    return undefined;
  }, [settings?.voice.provider, settings?.voice.model]);

  // Pre-compute ttsUnavailable flag (local providers don't support TTS)
  const ttsUnavailable = settings?.voice.provider ? isLocalProvider(settings.voice.provider) : false;

  // Model roles — resolved names for SessionSettingsMenu model info.
  // Cannot use useModelRoles() hook here because SettingsProvider/NavigationProvider
  // are children of App (in the JSX return), so context hooks return null in App's body.
  // Instead, call resolveModelRoles() pure function directly with App's settings data.
  const profiles = useMemo(
    () => settings?.localModel?.profiles ?? [],
    [settings?.localModel?.profiles],
  );
  const resolvedRoles = useMemo(
    () => settings ? resolveModelRoles(settings, profiles, profileConnectivity) : null,
    [profileConnectivity, settings, profiles],
  );

  /* eslint-disable react-hooks/exhaustive-deps -- intentional: omitting the resolvedRoles object so modelInfo only recomputes when role fields change */
  const modelInfo = useMemo(() => resolvedRoles ? {
    workingModelName: resolvedRoles.working.modelName,
    thinkingModelName: resolvedRoles.thinking.modelName,
    thinkingInheritsFromWorking: !resolvedRoles.thinking.isCustom,
    hasAnyCustom: resolvedRoles.hasAnyCustom,
    backgroundModelName: resolvedRoles.background.modelName,
    backgroundIsCustom: resolvedRoles.background.isCustom,
  } : undefined, [
    resolvedRoles?.working.modelName,
    resolvedRoles?.thinking.modelName,
    resolvedRoles?.thinking.isCustom,
    resolvedRoles?.hasAnyCustom,
    resolvedRoles?.background.modelName,
    resolvedRoles?.background.isCustom,
  ]);

  const handleNavigateToModelSettings = useCallback(() => {
    setActiveSurface('settings');
    fireAndForget(openSettingsDialog('agents'), 'navigateToModelSettings');
  }, [setActiveSurface, openSettingsDialog]);
  /* eslint-enable react-hooks/exhaustive-deps */

  // MCPBuildCard: action handler for changes_requested/ci_fail — spawns follow-up session
  // using contributionFollowUpService via IPC, with the same prepareMentionAttachments +
  // submitQueuedMessage pattern as P1 entry points.
  const handleBuildCardMakeChanges = useCallback(async () => {
    if (!currentSessionId) return;
    try {
      // Get the contribution for the current session to find its ID
      const { contribution } = await window.contributionApi.getBySession({ sessionId: currentSessionId });
      if (!contribution) {
        showToast({ title: 'No contribution found for this session' });
        return;
      }

      const { context } = await window.contributionApi.createFollowUpContext({
        contributionId: contribution.id,
      });

      if (!context) {
        showToast({ title: 'Unable to create follow-up session' });
        return;
      }

      const sessionId = startFreshSession();

      const prompt = `@\`rebel-system/skills/coding/${context.skillMention}\` ${context.prompt}`;

      const mentionAttachments = await prepareMentionAttachments(prompt);
      fireAndForget(
        submitQueuedMessage(
          prompt,
          'text',
          mentionAttachments.length > 0 ? mentionAttachments : undefined,
          {
            targetSessionId: sessionId,
          },
        ),
        'handleBuildCardMakeChanges',
      );

      void window.contributionApi.linkFollowUpSession({
        contributionId: contribution.id,
        followUpSessionId: sessionId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to start follow-up session';
      showToast({ title: message });
    }
  }, [currentSessionId, startFreshSession, prepareMentionAttachments, submitQueuedMessage, showToast]);

  // MCPBuildCard: "Run test" — sends a message to the agent in the current conversation
  const handleBuildCardRunTest = useCallback(() => {
    if (!currentSessionId) return;
    fireAndForget(
      submitQueuedMessage('Run the tests now for this connector.', 'text', undefined, {
        targetSessionId: currentSessionId,
      }),
      'handleBuildCardRunTest',
    );
  }, [currentSessionId, submitQueuedMessage]);

  // MCPBuildCard: "View on GitHub" — opens the PR URL in the default browser
  const handleBuildCardViewOnGitHub = useCallback((prUrl: string) => {
    window.appApi.openUrl(prUrl);
  }, []);

  // MCPBuildCard: "Contact the Mindstone team" — opens the bug report dialog pre-set to bug type
  const handleBuildCardContactTeam = useCallback(() => {
    setBugReportDefaultFeedbackType('bug');
    setBugReportOpen(true);
  }, [setBugReportDefaultFeedbackType, setBugReportOpen]);

  // Stage 5a (260420 OSS MCP backend relay): resolve the
  // `enableContributionRelay` feature flag once per render. Passed to
  // both the submission hook (submit-path gate) and
  // SessionSurfaceContent (UI-path gate) so the picker shape and the
  // handler gating always agree.
  const contributionRelayEnabled = useMemo(
    () => resolveContributionRelayEnabled(
      settings?.experimental?.enableContributionRelay,
      buildChannel,
    ),
    [settings?.experimental?.enableContributionRelay, buildChannel],
  );

  // MCPBuildCard: attribution-picker submission flow. The hook owns the
  // transient overlay state (`submitting` / `github-check`), the
  // double-click guard, the reAuth-required flag, and the session-switch
  // guards around the multiple await points in `runAttributedSubmit`.
  // Stage 1.1 of `docs/plans/260420_oss_mcp_backend_relay.md` extracted
  // this from App.tsx for testability and to centralise the "only dismiss
  // the picker when we actually succeeded" contract (handlers return
  // `Promise<boolean>`; see `useMcpBuildSubmission.ts` docblock).
  const {
    githubCheckConnectorName,
    submittingConnectorName,
    handleSubmitToCommunity: handleBuildCardSubmitToCommunity,
    handleUseRebelName: handleBuildCardUseRebelName,
    handleAnonymous: handleBuildCardAnonymous,
    handleGitHubYes: handleBuildCardGitHubYes,
    clearGithubCheck: handleBuildCardClearGithubCheck,
  } = useMcpBuildSubmission({
    currentSessionId,
    userFirstName,
    refetchMcpBuildCardState,
    showToast,
    emitLog,
    // Stage 5a (260420 OSS MCP backend relay): the relay submit path
    // (Rebel-name + Anonymous attribution) is feature-flagged so we
    // can ship the 3-way picker to beta first and keep stable users on
    // the proven GitHub direct-fork flow until the backend has proved
    // itself. User setting wins over the channel default; see
    // `resolveContributionRelayEnabled` for the resolution logic.
    enableContributionRelay: contributionRelayEnabled,
    isOssBuild,
  });

  // Derive the effective MCPBuildCard state.
  // Priority: store-terminal (submitted) > submitting overlay > github-check overlay > store-derived.
  // Logic is extracted into `getEffectiveMcpBuildCardState` so the priority
  // rules can be unit-tested without a full render tree. Stage 1.3 X1b of
  // `docs/plans/260420_oss_mcp_backend_relay.md`.
  //
  // 260424 PR-template revamp follow-up (addendum #2): the Stage 4
  // `storedPrFormValues` plumbing was removed along with the inline
  // "One more thing" form. The `github-check` phase no longer has
  // a form to pre-populate, so no IPC fetch or state threading is
  // needed.
  const effectiveMcpBuildCardState = useMemo(
    () => getEffectiveMcpBuildCardState({
      submittingConnectorName,
      githubCheckConnectorName,
      userFirstName,
      cardState: mcpBuildCardState,
    }),
    [submittingConnectorName, githubCheckConnectorName, userFirstName, mcpBuildCardState],
  );

  const handleBuildCardViewInSettings = useCallback((connectorName: string) => {
    setActiveSurface('settings');
    fireAndForget(
      openSettingsDialog('tools', getConnectorSectionId(connectorName), {
        source: 'link',
        interactionType: 'programmatic',
      }),
      'handleBuildCardViewInSettings',
    );
  }, [openSettingsDialog, setActiveSurface]);

  // MCPBuildCard action handlers — wired to ConversationPane via SessionSurfaceContent
  const mcpBuildCardActions = useMemo(() => ({
    onRunTest: handleBuildCardRunTest,
    onReRunTest: handleBuildCardRunTest,
    onContactTeam: handleBuildCardContactTeam,
    onSubmitToCommunity: handleBuildCardSubmitToCommunity,
    onUseRebelName: handleBuildCardUseRebelName,
    onAnonymous: handleBuildCardAnonymous,
    onGitHubYes: handleBuildCardGitHubYes,
    onMakeChanges: handleBuildCardMakeChanges,
    onRefreshStatus: refreshMcpBuildStatus,
    isRefreshing: isMcpBuildRefreshing,
    onViewOnGitHub: handleBuildCardViewOnGitHub,
    onViewInSettings: handleBuildCardViewInSettings,
  }), [handleBuildCardRunTest, handleBuildCardContactTeam, handleBuildCardSubmitToCommunity, handleBuildCardUseRebelName, handleBuildCardAnonymous, handleBuildCardGitHubYes, handleBuildCardMakeChanges, refreshMcpBuildStatus, isMcpBuildRefreshing, handleBuildCardViewOnGitHub, handleBuildCardViewInSettings]);

  // Memoized session surface element — separate from flowSurfaceConfigs
  // so session-related deps don't trigger recalculation of all 6 surface configs.
  const revealedThinkingElapsedLabelRef = useRef(thinkingElapsedLabel);
  useEffect(() => {
    if (!isRevealMasked) {
      revealedThinkingElapsedLabelRef.current = thinkingElapsedLabel;
    }
  }, [isRevealMasked, thinkingElapsedLabel]);
  const thinkingElapsedLabelForSurface = isRevealMasked
    ? revealedThinkingElapsedLabelRef.current
    : thinkingElapsedLabel;

  const sessionSurfaceElement = useMemo(() => (
    <SessionSurfaceContent
      actionsRef={sessionActionsRef}
      currentSessionId={currentSessionId}
      currentSessionTitle={currentSessionTitle}
      currentSessionStarredAt={currentSessionStarredAt}
      currentSessionDoneAt={currentSessionDoneAt}
      visibleMessages={visibleMessages}
      eventsByTurn={eventsByTurn}
      messages={messages}
      turnSummaries={turnSummaries}
      visibleTurnId={visibleTurnId}
      focusedTurnId={focusedTurnId}
      processingTurnId={activeTurnId}
      editingMessageId={editingMessageId}
      turnStepContextByTurn={turnStepContextByTurn}
      subAgentTimelineByTurn={subAgentTimelineByTurn}
      activeStepByTurn={activeStepByTurn}
      compactionBoundaries={compactionBoundaries}
      isBusy={isBusy}
      isStopping={isStopping}
      isSettling={isSettling}
      isRevealMasked={isRevealMasked}
      isTextMode={isTextMode}
      isInsightSurface={isInsightSurface}
      isDiagnosticsSurface={isDiagnosticsSurface}
      onToggleDiagnostics={toggleDiagnosticsView}
      thinkingHeadline={thinkingHeadline}
      thinkingElapsedLabel={thinkingElapsedLabelForSurface}
      isScrolledAway={isScrolledAway}
      newMessageCount={newMessageCount}
      isAnswerTopPinned={isAnswerTopPinned}
      onJumpToLatest={scrollToLastMessage}
      selectedTrashedSessionId={selectedTrashedSessionId}
      flowHistoryOpen={flowHistoryOpen}
      mcpBuildCardState={effectiveMcpBuildCardState}
      onMcpBuildCardActions={mcpBuildCardActions}
      onMcpBuildClearGithubCheck={handleBuildCardClearGithubCheck}
      enableContributionRelay={contributionRelayEnabled}
      isOssBuild={isOssBuild}
      connectorSetupFooterCard={pendingConnectorSetupCard}
      onConnectorSetUp={handleConnectorSetUp}
      onConnectorSaveForLater={handleConnectorSaveForLater}
      onConnectorMarkAnswered={markConnectorAnswered}
      chromeMode={chromeMode}
      isOnboardingCoachActive={isOnboardingCoachActive}
      isDocumentPreviewOpen={documentPreviewOpen}
      currentSessionMeetingCompanion={currentSessionMeetingCompanion}
      meetingStatus={meetingStatus}
      pinnedFavorites={pinnedFavorites}
      personalizedUseCases={settings?.personalizedUseCases}
      coreDirectory={settings?.coreDirectory}
      inboundAuthorPolicyMode={settings?.experimental?.inboundAuthorPolicy?.mode ?? 'legacyPermissive'}
      voiceProviderLabel={voiceProviderLabel}
      sttKeyMissing={sttKeyMissing}
      ttsKeyMissing={ttsKeyMissing}
      localModelMissing={localModelMissing}
      localModelDownloading={localModelDownloading}
      ttsUnavailable={ttsUnavailable}
      modelInfo={modelInfo}
      onNavigateToModelSettings={handleNavigateToModelSettings}
      composerRef={composerRef}
      composerProps={composerProps}
      agentSessionLogRef={agentSessionLogRef}
      isTranscribing={isTranscribing}
      isTranscribeProcessing={isTranscribeProcessing}
      transcriptionAudioLevel={transcriptionAudioLevel}
      autoSpeak={autoSpeak}
      privateMode={privateMode}
      councilMode={councilMode}
      councilModeAvailable={councilModeAvailable}
      councilModeDisabledTooltip={councilModeDisabledTooltip}
      autoDoneEnabled={autoDoneEnabled}
      finishLine={finishLine}
      setFinishLine={setFinishLine}
      isEditingFinishLine={isEditingFinishLine}
      onToggleEditFinishLine={toggleEditFinishLine}
      deniedOperations={deniedOperations}
      stagedToolCalls={stagedToolCalls.map(c => ({
        id: c.id,
        sessionId: c.sessionId,
        displayName: c.displayName,
        packageId: c.mcpPayload.packageId,
        toolId: c.mcpPayload.toolId,
        riskLevel: c.riskLevel,
        reason: c.reason,
        timestamp: c.timestamp,
        status: c.status,
        errorMessage: c.result?.error,
        allowPermanentTrust: c.allowPermanentTrust,
      }))}
      currentSessionStagedFiles={currentSessionStagedFiles}
      memoryApprovalRequests={memoryApprovalRequests}
      isExecutingStagedTools={isExecutingStagedTools}
      currentSessionQueue={currentSessionQueue}
      sessionCoaching={sessionCoaching}
    />
  ), [
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
    activeTurnId,
    editingMessageId,
    turnStepContextByTurn,
    subAgentTimelineByTurn,
    activeStepByTurn,
    compactionBoundaries,
    isBusy,
    isStopping,
    isSettling,
    isTextMode,
    isInsightSurface,
    isDiagnosticsSurface,
    toggleDiagnosticsView,
    thinkingHeadline,
    thinkingElapsedLabelForSurface,
    isScrolledAway,
    newMessageCount,
    selectedTrashedSessionId,
    flowHistoryOpen,
    effectiveMcpBuildCardState,
    mcpBuildCardActions,
    handleBuildCardClearGithubCheck,
    contributionRelayEnabled,
    isOssBuild,
    pendingConnectorSetupCard,
    handleConnectorSetUp,
    handleConnectorSaveForLater,
    markConnectorAnswered,
    chromeMode,
    isAnswerTopPinned,
    isRevealMasked,
    isOnboardingCoachActive,
    documentPreviewOpen,
    currentSessionMeetingCompanion,
    meetingStatus,
    pinnedFavorites,
    settings?.personalizedUseCases,
    settings?.coreDirectory,
    settings?.experimental?.inboundAuthorPolicy?.mode,
    voiceProviderLabel,
    sttKeyMissing,
    ttsKeyMissing,
    localModelMissing,
    localModelDownloading,
    ttsUnavailable,
    modelInfo,
    handleNavigateToModelSettings,
    composerProps,
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
    toggleEditFinishLine,
    deniedOperations,
    stagedToolCalls,
    currentSessionStagedFiles,
    memoryApprovalRequests,
    isExecutingStagedTools,
    currentSessionQueue,
    sessionCoaching,
    scrollToLastMessage,
  ]);

  // Workspace layout is managed inside FlowPanelsShell and WorkspaceDrawer

  const _appShellStyle = useMemo<CSSProperties>(() => ({}), []);

  const handleUseSkill = useCallback((skillRelativePath: string) => {
    const sessionId = startFreshSession({ showHistory: true });
    // Set draft in store so ComposerWithState's sessionId effect loads it
    getSessionStoreState().setDraftForSession(sessionId, `@\`${skillRelativePath}\` `);
  }, [startFreshSession]);

  const {
    createActionPending: libraryCreateActionPending,
    createSkill: handleCreateSkill,
    createMemory: handleCreateMemory,
    addSpaceFromLibrary: handleAddSpaceFromLibrary,
  } = useLibraryCreateActions({
    startFreshSession,
    setSessionDraft: (sessionId, draft) => {
      getSessionStoreState().setDraftForSession(sessionId, draft);
    },
    canCreateAdditionalSpaces,
    setActiveSurface: (surface) => setActiveSurface(surface as FlowSurface),
    openSettingsDialog,
    requestPendingSpacesAction,
    showToast,
  });

  // Library cloud-degraded notice → Settings → Spaces, where the per-Space
  // Re-check lever lets the user force a reconnect. Parallels
  // handleAddSpaceFromLibrary (threaded App → LibraryDrawer → provider → notice).
  const handleManageSpacesFromLibrary = useCallback(() => {
    fireAndForget(
      openSettingsDialog('spaces', 'spaces', { source: 'link', interactionType: 'programmatic' }),
      'manageSpacesFromLibrary',
    );
  }, [openSettingsDialog]);

  const handlePersonaliseSkill = useCallback((skillRelativePath: string) => {
    // Extract skill name from path (e.g., "rebel-system/skills/research/web-researcher/SKILL.md" -> "web-researcher")
    const pathParts = skillRelativePath.split('/');
    const skillFolderIndex = pathParts.findIndex((p) => p === 'SKILL.md') - 1;
    const skillName = skillFolderIndex >= 0 ? pathParts[skillFolderIndex] : 'skill';
    const category = skillFolderIndex >= 1 ? pathParts[skillFolderIndex - 1] : 'uncategorized';
    
    // Create the extension file path (uses extends: frontmatter for proper inheritance)
    const extensionPath = `Chief-of-Staff/skills/${category}/${skillName}/SKILL.md`;
    const extensionContent = `---
name: ${skillName}
description: "Personal extension of ${skillName}"
extends: ${skillRelativePath}
extension_type: overlay
---

# Personal Extensions

Add your preferences, examples, and context below.
Your extension inherits improvements to the base skill automatically.

## My Preferences

<!-- Add format preferences, structure requirements, etc. -->

## Additional Context

<!-- Add recurring context: company, role, industry, etc. -->
`;
    
    // Create the folder and file
    fireAndForget((async () => {
      try {
        await window.libraryApi.createFolder({ parentPath: `Chief-of-Staff/skills/${category}`, folderName: skillName });
        const writeResult = await writeFileOrFail({ path: extensionPath, content: extensionContent });
        if (writeResult.result === 'conflict') {
          showToast({ title: 'Save failed: file changed externally.' });
          return;
        }
        showToast({ title: `Created personal extension for ${skillName}` });
        // Open the file in editor
        await libraryDrawerRef.current?.openFile(extensionPath);
      } catch (error) {
        if (error instanceof WriteFailureError) {
          showToast({ title: 'Unable to save changes.' });
          return;
        }
        showToast({ title: `Couldn't create extension: ${error instanceof Error ? error.message : String(error)}` });
      }
    })(), 'createSkillExtension');
  }, [showToast]);

  const handleShareSkill = useCallback((skillRelativePath: string) => {
    const sessionId = startFreshSession({ showHistory: true });
    getSessionStoreState().setDraftForSession(sessionId, `@\`rebel-system/skills/system/skill-port-personal-to-general\` I want to share my skill: @\`${skillRelativePath}\` `);
  }, [startFreshSession]);

  const handleImproveSkill = useCallback((skillRelativePath: string, qualityContext?: import('./features/library/utils/skillQualityUtils').SkillImproveQualityContext) => {
    const weakestDimension = qualityContext?.topImprovement.dimension;
    let doctorSkill = 'rebel-system/skills/system/improve-skill';
    if (weakestDimension === 'extensionHealth') {
      doctorSkill = 'rebel-system/skills/system/customise-and-extend-skill';
    } else if (weakestDimension === 'structure') {
      doctorSkill = 'rebel-system/skills/system/skill-repair';
    }

    let prompt: string;
    if (!qualityContext) {
      prompt = `@\`rebel-system/skills/system/improve-skill\` I want to improve: @\`${skillRelativePath}\` `;
    } else {
      const bandLabel = qualityContext.band === 'seedling'
        ? 'just started'
        : qualityContext.band === 'growing'
          ? 'taking shape'
          : qualityContext.band === 'solid'
            ? 'strong'
            : 'exceptional';

      prompt = `@\`${doctorSkill}\` I'd like to improve this skill: @\`${skillRelativePath}\`\n\nIt's currently ${bandLabel} (${qualityContext.score}/100). ${qualityContext.topImprovement.suggestion}`;
    }

    const sessionId = startFreshSession({ showHistory: true });
    getSessionStoreState().setDraftForSession(sessionId, prompt);
  }, [startFreshSession]);

  const handleStartCreateAutomationConversation = useCallback((initialMessage?: string) => {
    const sessionId = startFreshSession({ showHistory: true });
    // Set draft in store so ComposerWithState's sessionId effect loads it
    const basePrompt = '@`rebel-system/skills/operations/create-automation/SKILL.md` ';
    const userMessage = initialMessage?.trim() || 'I want to create a new automation.';
    getSessionStoreState().setDraftForSession(sessionId, `${basePrompt}${userMessage} `);
  }, [startFreshSession]);

  const handleStartEditAutomationConversation = useCallback((automation: AutomationDefinition) => {
    const sessionId = startFreshSession({ showHistory: true });
    const scheduleDescription = automation.schedule.type === 'daily' 
      ? `Daily at ${automation.schedule.time}`
      : automation.schedule.type === 'weekly'
      ? `Weekly on ${(automation.schedule.daysOfWeek ?? []).map(d => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ')} at ${automation.schedule.time}`
      : automation.schedule.type === 'once'
      ? `Once on ${new Date(automation.schedule.dateTime).toLocaleString()}`
      : automation.schedule.type;
    const modelDescription = automation.model
      ? getModelDisplayName(automation.model)
      : 'default';
    const prompt = `@\`rebel-system/skills/operations/edit-automation/SKILL.md\` ` +
      `Edit automation "${automation.name}" (ID: ${automation.id}). ` +
      `Current schedule: ${scheduleDescription}. ` +
      `Model: ${modelDescription}. ` +
      `${automation.thinkingModel ? `Planner: ${getModelDisplayName(automation.thinkingModel)}. ` : ''}` +
      `Skill file: ${automation.filePath || 'not set'}. `;
    // Set draft in store so ComposerWithState's sessionId effect loads it
    getSessionStoreState().setDraftForSession(sessionId, prompt);
  }, [startFreshSession]);

  const handleCustomizeSystemAutomation = useCallback((_automation: AutomationDefinition, skillPath: string, prompt: string) => {
    const sessionId = startFreshSession({ showHistory: true });
    // Use customise-and-extend-skill to help user create their customization
    const fullPrompt = `@\`rebel-system/skills/system/customise-and-extend-skill/SKILL.md\` ${prompt}The base skill is at: @\`${skillPath}\``;
    getSessionStoreState().setDraftForSession(sessionId, fullPrompt);
  }, [startFreshSession]);

  // Handle sending workspace file annotations to composer (pre-fill, user sends).
  //
  // `onCommit` (third arg, new in v3 per-message onCommit plan): fires on
  // the resulting `QueuedMessage`'s dispatch success. Appended to the
  // pending-callbacks array keyed to the resolved target session id so
  // `handleSubmitTextPrompt` picks them up and threads a composed
  // `onCommit` into `submitQueuedMessage(..., { onCommit })`. Multiple
  // Send clicks on the same session accumulate — each one's staged
  // annotations clear on dispatch.
  const handleSendWorkspaceAnnotations = useCallback((
    message: string,
    options?: { target: 'file-conversation' | 'last-active' | 'new'; sessionId?: string; displayMessage?: string },
    onCommit?: () => void | Promise<void>,
  ) => {
    const target = options?.target ?? 'new';
    const composerMessage = options?.displayMessage ?? message;
    const storeState = getSessionStoreState();

    let targetSessionId: string | undefined;
    let isAlreadyOnTargetSession = false;

    if (target === 'new') {
      targetSessionId = resetSessionState();
    } else if (target === 'file-conversation' && options?.sessionId) {
      // Check if we're already on the target session before attempting navigation
      isAlreadyOnTargetSession = storeState.currentSessionId === options.sessionId;
      if (!isAlreadyOnTargetSession) {
        handleOpenHistorySession(options.sessionId);
      }
      targetSessionId = options.sessionId;
    } else if (target === 'last-active') {
      // Explicit resolution for the last-active branch (was implicit via
      // `setText` touching the currently-focused composer). Making it
      // explicit means the onCommit stash below is keyed to the
      // real target session id that `handleSubmitTextPrompt` will
      // later look up.
      const resolvedTargetId = options?.sessionId ?? storeState.currentSessionId;
      if (resolvedTargetId) {
        targetSessionId = resolvedTargetId;
      }
    }

    // Accumulate onCommit onto the pending-callbacks array keyed to
    // the resolved target session id. If no target session was
    // resolved (edge case: no current session AND no options.sessionId
    // on last-active), the onCommit is silently dropped — matches "if
    // there is no queued message, there is no dispatch to commit on"
    // semantics. No annotations cleared.
    //
    // FIX B: each entry also captures the inserted `message` so the
    // submit drain can filter out callbacks whose annotation block was
    // edited out of the composer before send.
    if (onCommit && targetSessionId) {
      const map = pendingDocumentAnnotationOnCommitRef.current;
      const entry = {
        messageSnapshot: composerMessage,
        fencedMessage: message,
        onCommit,
      };
      const existing = map.get(targetSessionId);
      if (existing) {
        existing.push(entry);
      } else {
        map.set(targetSessionId, [entry]);
      }
    }

    setActiveSurface('sessions');
    setIsTextMode(true);
    setShowConversation(true);
    setFlowHistoryOpen(true);

    // For 'file-conversation', we set the draft on the target session in the store.
    // This is safe even if navigation is deferred (attachment confirmation dialog) because
    // the draft is written to the target session's slot, not the current composer.
    // When navigation completes, ComposerWithState's sessionId useEffect loads the draft.
    // We use queueMicrotask to ensure the draft is set after React processes the session
    // switch, allowing ComposerWithState's sessionId effect to run first.
    //
    // EDGE CASE: If we're already on the target session (isAlreadyOnTargetSession), the
    // sessionId prop won't change, so ComposerWithState's useEffect([sessionId]) won't fire.
    // In this case, we use setText() directly to populate the composer immediately.
    if (target === 'file-conversation' && targetSessionId) {
      if (isAlreadyOnTargetSession) {
        // Already on target session - use setText directly since sessionId won't change
        // and the useEffect won't fire to load the draft from store
        storeState.setDraftForSession(targetSessionId, composerMessage);
        composerRef.current?.setText(toComposerWireMarkdown(composerMessage));
      } else {
        // Navigating to a different session - set draft in store, effect will load it
        const queuedSessionId = targetSessionId;
        queueMicrotask(() => {
          if (!queuedSessionId) return;
          getSessionStoreState().setDraftForSession(queuedSessionId, composerMessage);
        });
      }
    } else if (target === 'new' && targetSessionId) {
      // For 'new' sessions, draft can be set immediately (no race with clear())
      storeState.setDraftForSession(targetSessionId, composerMessage);
    } else {
      // 'last-active' - use setText directly since we're staying on current session
      // and sessionId won't change, so the useEffect won't fire
      const lastActiveTargetId = targetSessionId ?? storeState.currentSessionId;
      if (lastActiveTargetId) {
        storeState.setDraftForSession(lastActiveTargetId, composerMessage);
      }
      composerRef.current?.setText(toComposerWireMarkdown(composerMessage));
    }
  }, [resetSessionState, setActiveSurface, setFlowHistoryOpen, setIsTextMode, setShowConversation, handleOpenHistorySession]);

  const workspaceDrawerElement = useMemo(() => showConversation ? (
    <LibraryDrawer
      ref={libraryDrawerRef}
      open={activeSurface === 'library'}
      settings={settings}
      refreshSettings={refreshSettings}
      showToast={showToast}
      emitLog={emitLog}
      onUseSkill={handleUseSkill}
      onCreateSkill={handleCreateSkill}
      onCreateMemory={handleCreateMemory}
      onAddSpace={handleAddSpaceFromLibrary}
      onManageSpaces={handleManageSpacesFromLibrary}
      canCreateAdditionalSpaces={canCreateAdditionalSpaces}
      createActionPending={libraryCreateActionPending}
      onPersonaliseSkill={handlePersonaliseSkill}
      onShareSkill={handleShareSkill}
      onImproveSkill={handleImproveSkill}
      onEditorOpen={collapseSidebarForLibraryEditor}
      onEditorClose={restoreSidebarFromLibraryEditor}
      onOpenQuickOpen={handleOpenQuickOpen}
      chromeMode={chromeMode}
      requestChromeMode={requestChromeMode}
      releaseChromeMode={releaseChromeMode}
      floatingEditorMode={libraryEditorOpen}
      onOpenSession={handleOpenHistorySession}
      onSendAnnotations={handleSendWorkspaceAnnotations}
      currentSessionId={currentSessionId}
      currentSessionTitle={currentSessionTitle}
      onStartConversation={handleAtlasStartConversation}
      onShareFile={settings?.cloudInstance?.mode === 'cloud' ? handleShareFile : undefined}
    />
  ) : null, [
    showConversation,
    activeSurface,
    settings,
    refreshSettings,
    showToast,
    emitLog,
    handleUseSkill,
    handleCreateSkill,
    handleCreateMemory,
    handleAddSpaceFromLibrary,
    handleManageSpacesFromLibrary,
    canCreateAdditionalSpaces,
    libraryCreateActionPending,
    handlePersonaliseSkill,
    handleShareSkill,
    handleImproveSkill,
    collapseSidebarForLibraryEditor,
    restoreSidebarFromLibraryEditor,
    handleOpenQuickOpen,
    chromeMode,
    requestChromeMode,
    releaseChromeMode,
    libraryEditorOpen,
    handleOpenHistorySession,
    handleSendWorkspaceAnnotations,
    currentSessionId,
    currentSessionTitle,
    handleAtlasStartConversation,
    handleShareFile,
  ]);

  const insightsDrawerElement = useMemo(() => showConversation ? (
    <DevProfiler id="InsightsDrawer">
      <InsightsDrawer
        turnSummaries={turnSummaries}
        currentRuntime={currentRuntime}
        isBusy={isBusy}
        storylineFilters={storylineFilters}
        onToggleStorylineFilter={toggleStorylineFilter}
        thinkingStage={thinkingStage}
        thinkingElapsedLabel={thinkingElapsedLabel}
        isViewSessionBusy={isViewSessionBusy}
        thinkingHint={thinkingHint}
        turnStepContextByTurn={turnStepContextByTurn}
        loadWorkspaceFile={handleOpenDocumentInPreviewAsync}
        onOpenConversation={handleOpenConversationReference}
        sessionId={currentSessionId}
      />
    </DevProfiler>
  ) : null, [
    showConversation,
    turnSummaries,
    currentRuntime,
    isBusy,
    storylineFilters,
    toggleStorylineFilter,
    thinkingStage,
    thinkingElapsedLabel,
    isViewSessionBusy,
    thinkingHint,
    turnStepContextByTurn,
    handleOpenDocumentInPreviewAsync,
    handleOpenConversationReference,
    currentSessionId,
  ]);

  const handleCloseDocumentPreview = useCallback(async () => {
    const ok = await docPreviewEditorRef.current?.closeAllDocuments();
    // closeAllDocuments returns:
    //   - true: flush succeeded, close proceeded
    //   - false: flush rejected, abort outer close (Class A Batch 1)
    //   - undefined: no preview editor mounted — nothing to flush, proceed.
    if (ok === false) return;
    closeDocumentPreview();
  }, [closeDocumentPreview]);

  // Flush pending/committed preview path when the editor mounts.
  const handleDocPreviewEditorMount = useCallback((handle: UnifiedDocumentEditorHandle) => {
    const pathToOpen = resolveDocumentPreviewMountPath({
      pendingPath: pendingDocPreviewPathRef.current,
      committedPath: documentPreviewPath,
      previewOpen: documentPreviewOpen,
      openTabCount: handle.getOpenTabCount(),
    });
    if (!pathToOpen) return;

    pendingDocPreviewPathRef.current = null;
    fireAndForget(handle.openDocument(pathToOpen), 'openPendingDocPreview');
  }, [documentPreviewOpen, documentPreviewPath]);

  // DI-4 / Stage 2 (post-Stage-2 review fix): the FlowPanels gate opener is
  // a stable wrapper that reads the editor handle at call time, NOT the bound
  // `handle.openDocument` directly. Reason: UnifiedDocumentEditor's
  // `useImperativeHandle` re-creates the handle on every render whose deps
  // change (tabs/flushThenAct/fileIO), so React invokes this ref-callback
  // with `null → newHandle` on those renders. Registering `handle.openDocument`
  // directly would mean every legitimate re-render bumps
  // documentPreviewRequestGenRef via deregistration, dropping in-flight gate
  // commits.
  //
  // Two coordinated mechanisms:
  // 1. Stable wrapper: reads `docPreviewEditorRef.current` at call time, so
  //    handle identity churn doesn't break the gate.
  // 2. Microtask-debounced deregister: ref-callback `null` invocations are
  //    queued; if a new handle arrives in the same tick (re-render churn),
  //    the deregister is cancelled. Only a TRUE unmount (no replacement
  //    handle in the same tick) actually calls `setDocumentPreviewOpener(null)`.
  const stableDocPreviewOpenerRef = useRef<((path: string) => Promise<boolean>) | null>(null);
  if (stableDocPreviewOpenerRef.current === null) {
    stableDocPreviewOpenerRef.current = (path: string) => {
      const handle = docPreviewEditorRef.current;
      if (!handle) return Promise.resolve(false);
      return handle.openDocument(path);
    };
  }
  const pendingDocPreviewDeregisterRef = useRef<number | null>(null);
  const docPreviewOpenerRegisteredRef = useRef(false);

  const handleDocPreviewEditorRef = useCallback((handle: UnifiedDocumentEditorHandle | null) => {
    (docPreviewEditorRef as React.MutableRefObject<UnifiedDocumentEditorHandle | null>).current = handle;
    if (handle) {
      // Cancel any pending deregister (this is a re-render churn null→handle).
      if (pendingDocPreviewDeregisterRef.current !== null) {
        clearTimeout(pendingDocPreviewDeregisterRef.current);
        pendingDocPreviewDeregisterRef.current = null;
      }
      // Register the stable wrapper once on first mount.
      if (!docPreviewOpenerRegisteredRef.current) {
        setDocumentPreviewOpener(stableDocPreviewOpenerRef.current);
        docPreviewOpenerRegisteredRef.current = true;
      }
      handleDocPreviewEditorMount(handle);
    } else {
      // Schedule deregister for next tick. If a new handle arrives before then
      // (re-render churn), the if-handle branch cancels this.
      if (pendingDocPreviewDeregisterRef.current === null) {
        pendingDocPreviewDeregisterRef.current = window.setTimeout(() => {
          pendingDocPreviewDeregisterRef.current = null;
          if (!docPreviewEditorRef.current && docPreviewOpenerRegisteredRef.current) {
            setDocumentPreviewOpener(null);
            docPreviewOpenerRegisteredRef.current = false;
          }
        }, 0);
      }
    }
  }, [handleDocPreviewEditorMount, setDocumentPreviewOpener]);

  const canonicalizedDocumentPreviewPath = useMemo(() => {
    if (!documentPreviewPath) return null;
    const isAbsolute = documentPreviewPath.startsWith('/') || /^[A-Za-z]:/.test(documentPreviewPath);
    if (isAbsolute) {
      return documentPreviewPath;
    }
    if (!settings?.coreDirectory) {
      // Intentional null: avoid false-negative navigator highlights from unresolved relative paths.
      return null;
    }
    return `${settings.coreDirectory.replace(/\/+$/, '')}/${documentPreviewPath}`;
  }, [documentPreviewPath, settings?.coreDirectory]);

  const handleDocumentPreviewSelectFile = useCallback((absolutePath: string) => {
    openDocumentPreview(absolutePath);
  }, [openDocumentPreview]);

  const documentPreviewDrawerElement = (
    <EditorWithNavigatorLayout
      navigator={documentPreviewKioskLevel === 'wide' ? (
        <WorkspaceFileNavigator
          activePath={canonicalizedDocumentPreviewPath}
          coreDirectory={settings?.coreDirectory ?? null}
          onSelectFile={handleDocumentPreviewSelectFile}
          emitLog={emitLog}
        />
      ) : null}
      editor={(
        <UnifiedDocumentEditor
          ref={handleDocPreviewEditorRef}
          showToast={showToast}
          onOpenInLibrary={handleOpenInLibraryFromPreview}
          onNavigateToFolder={handleNavigateToFolderFromPreview}
          editorKioskLevel={documentPreviewKioskLevel}
          onToggleKioskMode={cycleDocumentPreviewKioskLevel}
          onRestoreChromeMode={clearDocumentPreviewKioskLevel}
          onOpenQuickOpen={handleOpenQuickOpen}
          onRevealInTree={handleRevealInTreeFromPreview}
          onClose={handleCloseDocumentPreview}
          // Last tab closed via the per-tab "X": dismiss the drawer using the
          // synchronous FlowPanels shell-state clear directly, NOT
          // handleCloseDocumentPreview. The tab-close path already flushed
          // (flushThenAct); a second closeAllDocuments()/flush() is redundant
          // and would re-create the 0-tab-while-open state that reopens the doc.
          onLastTabClosed={closeDocumentPreview}
        />
      )}
      editorHasDocuments
      kioskLevel={documentPreviewKioskLevel}
      navigatorWidthPercent={LIBRARY_NAVIGATOR_DEFAULT_WIDTH_PERCENT}
      focusNavigatorWidthPercent={LIBRARY_NAVIGATOR_FOCUS_WIDTH_PERCENT}
      floatingEditorMode={false}
      isResizing={false}
      onResizeMouseDown={NOOP_EDITOR_LAYOUT_RESIZE_HANDLER}
      onResizeDoubleClick={NOOP_EDITOR_LAYOUT_RESIZE_HANDLER}
      onResizeContextMenu={NOOP_EDITOR_LAYOUT_RESIZE_HANDLER}
    />
  );

  // Combined right drawer - shows document preview when open, otherwise insights.
  // Document preview renders regardless of showConversation so it persists
  // when transferring a file from Library to another surface.
  const rightDrawerElement = (showConversation || documentPreviewOpen)
    ? (documentPreviewOpen ? documentPreviewDrawerElement : insightsDrawerElement)
    : null;

  // Claude usage warning banner — shows when approaching subscription rate limits

  useEffect(() => {
    pendingSessionErrorActionRef.current = null;
    setPendingSessionErrorAction(null);
  }, [error]);

  useEffect(() => {
    if (!error) return;

    let latest: { turnId: string; event: Extract<AgentEvent, { type: 'error' }> } | null = null;
    for (const [turnId, events] of Object.entries(eventsByTurn)) {
      for (let i = events.length - 1; i >= 0; i--) {
        const candidate = events[i];
        if (candidate.type !== 'error') continue;
        if (candidate.error === error && (!latest || candidate.timestamp > latest.event.timestamp)) {
          latest = { turnId, event: candidate };
        }
      }
    }

    if (!latest || latest.event.resolution) return;

    const logKey = `${latest.turnId}:${latest.event.timestamp}:${latest.event.errorKind ?? 'unknown'}:${latest.event.error}`;
    if (legacyErrorFallbackLoggedRef.current.has(logKey)) return;
    legacyErrorFallbackLoggedRef.current.add(logKey);

    emitLog({
      level: 'info',
      message: 'legacy_error_banner_fallback',
      context: {
        errorKind: latest.event.errorKind ?? 'unknown',
        turnId: latest.turnId,
        message: latest.event.error,
      },
      timestamp: Date.now(),
    });
  }, [emitLog, error, eventsByTurn]);

  const handleApplySessionErrorResolution = useCallback(async (
    failedTurnId: string,
    action: AgentErrorResolutionAction,
  ) => {
    if (pendingSessionErrorActionRef.current) return;

    pendingSessionErrorActionRef.current = action.action;
    setPendingSessionErrorAction(action.action);
    const shouldRetryAfterApply = SESSION_ERROR_RESOLUTION_RETRY_ACTIONS.has(action.action);
    // FOX-3494 (round-3 F1): the session-override clear and the retry below are
    // session-scoped, but they run AFTER the awaited `applyResolution` IPC. If
    // the user switches conversations while that IPC is in flight, they would
    // otherwise mutate/retry the wrong (now-current) conversation. Capture the
    // recovery conversation id up front and abort the session-scoped steps if it
    // changed — mirroring the `stale_turn` posture already in this handler.
    const recoverySessionId = getSessionStoreState().currentSessionId;

    try {
      if (shouldRetryAfterApply && activeTurnIdRef.current) {
        showToast({
          title: 'Still working',
          description: 'Wait for the current attempt to finish, then try again.',
          variant: 'warning',
        });
        return;
      }

      const result = await window.errorApi.applyResolution({
        turnId: failedTurnId,
        action: action.action,
        payload: action.payload,
      });

      if (!result.ok) {
        switch (result.reason) {
          case 'in_flight':
            return;
          case 'stale_turn':
            setAgentError(null);
            showToast({
              title: 'Already moving',
              description: 'That error is from an older attempt. The new one is already running.',
              variant: 'info',
            });
            return;
          case 'invalid_payload':
            emitLog({
              level: 'warn',
              message: 'Invalid error resolution payload',
              context: { turnId: failedTurnId, action: action.action, payload: action.payload },
              timestamp: Date.now(),
            });
            showToast({
              title: "Couldn't apply",
              description: 'Try a different option.',
              variant: 'warning',
            });
            return;
          case 'turn_alive':
          case undefined:
            showToast({
              title: 'Still working',
              description: 'Wait for the current attempt to finish, then try again.',
              variant: 'warning',
            });
            return;
          default: {
            const _exhaustive: never = result.reason;
            void _exhaustive;
            return;
          }
        }
      }

      if (result.nextTurnId) {
        emitLog({
          level: 'info',
          message: 'Error resolution returned next turn id',
          context: { failedTurnId, nextTurnId: result.nextTurnId, action: action.action },
          timestamp: Date.now(),
        });
      }

      if (action.action === 'open-settings') {
        // 260622 Stage 4: the Chief-of-Staff "Open the file" action reuses the
        // open-settings verb with a sentinel section. Intercept it and reveal
        // the README in the OS file manager instead of opening Settings, so the
        // user can inspect/fix an unreadable file. The README path is resolved
        // from settings (the chief-of-staff space entry, else the canonical
        // join); revealPath degrades gracefully (toast) if it's gone.
        if (action.payload?.settingsSection === 'reveal-chief-of-staff-readme') {
          const readmePath = resolveChiefOfStaffReadmePath(settingsRef.current);
          if (!readmePath) {
            showToast({
              title: "Couldn't find the file",
              description: 'Set your workspace folder in Settings, then try again.',
              variant: 'warning',
            });
            return;
          }
          fireAndForget(
            window.appApi.revealPath(readmePath).then((result) => {
              if (!result.ok) {
                showToast({
                  title: "Couldn't open the file",
                  description:
                    result.reason === 'missing'
                      ? "Rebel couldn't find the file where it expected it."
                      : result.message,
                  variant: 'warning',
                });
              }
            }),
            'revealChiefOfStaffReadme',
          );
          return;
        }
        setActiveSurface('settings');
        fireAndForget(
          openSettingsDialog('agents', action.payload?.settingsSection ?? 'providerKeys', {
            source: 'link',
            interactionType: 'programmatic',
          }),
          'navigateToResolutionSettings',
        );
        return;
      }

      // FOX-3494 (round-3 F1): the user may have navigated to another
      // conversation while `applyResolution` was in flight. The global
      // settings.models switch is already applied (and is global, not
      // session-scoped, so it is fine to leave). But the session-override clear
      // and the retry below are session-scoped and must NOT touch the now-current
      // conversation — abort them if the recovery conversation is no longer
      // active, matching the `stale_turn` posture above.
      const recoverySessionStillActive =
        getSessionStoreState().currentSessionId === recoverySessionId;
      if (!recoverySessionStillActive) {
        emitLog({
          level: 'info',
          message: 'Skipping session-scoped error recovery: conversation changed during apply',
          context: {
            failedTurnId,
            action: action.action,
            recoverySessionId,
            currentSessionId: getSessionStoreState().currentSessionId,
          },
          timestamp: Date.now(),
        });
        return;
      }

      if (action.action === 'switch-model' && action.payload?.model) {
        // FOX-3494 (round-2 M2): the claude-under-ChatGPT-Pro recovery sets
        // `failedRole`. The main-process handler repaired GLOBAL settings.models,
        // but a per-conversation session model/thinking override (set via the
        // conversation model selector) takes precedence over global settings in
        // core — so without clearing it the immediate retry AND every future turn
        // in this conversation would loop back into the same Claude/Anthropic
        // terminal. Collapse the session overrides so the conversation honours the
        // newly-switched GPT model going forward.
        if (action.payload?.failedRole) {
          getSessionStoreState().clearSessionModelOverridesForRecovery();
        }
        // A `profile:<id>` recovery target has no human-readable model id; reuse the
        // action's "Use <profile>" label (which already names the profile) instead of
        // rendering the raw ref as "PROFILE:<ID>".
        const switchedLabel = action.payload.model.startsWith('profile:')
          ? action.label.replace(/^Use\s+/i, '')
          : formatResolutionModelLabel(action.payload.model);
        showToast({
          title: `Switched to ${switchedLabel}. Retrying.`,
          variant: 'success',
        });
      } else if (action.action === 'switch-provider' && action.payload?.provider) {
        showToast({
          title: `Switched to ${PROVIDER_LABELS[action.payload.provider] ?? action.payload.provider}. Retrying.`,
          variant: 'success',
        });
      }

      const retryPlan = planManualSessionErrorRetry({
        action: action.action,
        activeTurnId: activeTurnIdRef.current,
        failedTurnId,
        events: eventsByTurn[failedTurnId] ?? [],
        messages,
      });

      switch (retryPlan.kind) {
        case 'not-retry-action':
          return;
        case 'missing-message':
          showToast({
            title: 'Nothing to retry',
            description: 'Your message is safe, but Rebel could not find the original text to resend.',
            variant: 'warning',
          });
          return;
        case 'still-working':
          showToast({
            title: 'Still working',
            description: 'Wait for the current turn to finish before retrying.',
            variant: 'warning',
          });
          return;
        case 'retry':
          break;
        default: {
          const _exhaustive: never = retryPlan;
          void _exhaustive;
          return;
        }
      }

      if (retryPlan.failedTurnHadToolEvents) {
        emitLog({
          level: 'info',
          message: 'Manual error-resolution retry after failed turn used tools',
          context: { failedTurnId, action: action.action },
          timestamp: Date.now(),
        });
      }
      setAgentError(null);
      // 260622 Stage 4: the `proceed-without-chief-of-staff` escape resends the
      // turn with the admission bypass flag set, so the Chief-of-Staff gate
      // admits this turn on the generic template (the user's explicit
      // allow-proceed-with-warning choice). The flag is per-turn only — it never
      // persists, so the next turn re-evaluates the Chief-of-Staff state.
      const proceedWithoutChiefOfStaff = action.action === 'proceed-without-chief-of-staff';
      await sendUserPrompt(
        retryPlan.messageText,
        'text',
        proceedWithoutChiefOfStaff ? { proceedWithoutChiefOfStaff: true } : undefined,
      );
    } catch (err) {
      showToast({
        title: "Couldn't apply that fix",
        description: err instanceof Error ? err.message : 'Try again from Settings.',
        variant: 'error',
      });
    } finally {
      pendingSessionErrorActionRef.current = null;
      setPendingSessionErrorAction(null);
    }
  }, [
    emitLog,
    eventsByTurn,
    messages,
    openSettingsDialog,
    sendUserPrompt,
    setActiveSurface,
    setAgentError,
    showToast,
  ]);

  const sessionErrorBanner = useMemo(() => {
    if (!error) return null;

    const matchingErrorWithTurn = (() => {
      let latest: { turnId: string; event: Extract<AgentEvent, { type: 'error' }> } | null = null;
      for (const [turnId, events] of Object.entries(eventsByTurn)) {
        for (let i = events.length - 1; i >= 0; i--) {
          const candidate = events[i];
          if (candidate.type !== 'error') continue;
          if (candidate.error === error && (!latest || candidate.timestamp > latest.event.timestamp)) {
            latest = { turnId, event: candidate };
          }
        }
      }
      return latest;
    })();

    if (matchingErrorWithTurn?.event.resolution) {
      const failedTurnId = matchingErrorWithTurn.turnId;
      return (
        <SessionErrorNotice
          resolution={matchingErrorWithTurn.event.resolution}
          error={matchingErrorWithTurn.event}
          pendingAction={pendingSessionErrorAction}
          dismissible={matchingErrorWithTurn.event.resolution.category !== 'system-broken'}
          onApply={(action) => {
            fireAndForget(
              handleApplySessionErrorResolution(failedTurnId, action),
              'applySessionErrorResolution',
            );
          }}
          onDismiss={() => setAgentError(null)}
        />
      );
    }

    // TODO(FOX-3267): remove legacy CTA branch after two beta cycles.

    // --- Rate-limit detection via rateLimitMeta (structural, not string matching) ---
    // activeTurnId is null after an error, so scan all turn events in reverse and keep the latest match.
    const latestRateLimitError = (() => {
      let latest: { turnId: string; event: Extract<AgentEvent, { type: 'error' }> } | null = null;

      for (const [turnId, events] of Object.entries(eventsByTurn)) {
        for (let i = events.length - 1; i >= 0; i--) {
          const candidate = events[i];
          if (candidate.type !== 'error' || !candidate.rateLimitMeta) continue;
          if (!latest || candidate.timestamp > latest.event.timestamp) {
            latest = { turnId, event: candidate };
          }
        }
      }

      return latest;
    })();

    // Guard: only use the rate-limit banner if the event corresponds to the CURRENT error.
    // Without this, a stale rate-limit event from a previous turn could hijack a later
    // non-rate-limit error (e.g., auth error shows rate-limit CTA).
    const isCurrentRateLimitError = latestRateLimitError &&
      latestRateLimitError.event.error === error;

    if (isCurrentRateLimitError) {
      const { event: rateLimitEvent, turnId: failedTurnId } = latestRateLimitError;
      const rawError = rateLimitEvent.rateLimitMeta?.rawError;
      const providerName = rateLimitEvent.provider;

      // Use the original error message when it's already a specific contextual message
      // (e.g. Claude Max OAuth block, or backup-provider guidance from the fallback handler),
      // otherwise build a provider-aware headline.
      const lowerErr = error.toLowerCase();
      const isContextualError = lowerErr.includes('restricted by anthropic')
        || lowerErr.includes('backup provider');
      // OpenAI/Codex rate limits use rolling windows (up to 5 hours for Codex);
      // other providers typically reset in minutes.
      // When the provider returns an exact reset timestamp, show it.
      const resetAtMs = rateLimitEvent.rateLimitMeta?.resetAtMs;
      const isOpenAIProvider = providerName && /openai|chatgpt|codex/i.test(providerName);
      let resetHint: string;
      if (resetAtMs && resetAtMs > Date.now()) {
        const resetDate = new Date(resetAtMs);
        const timeStr = resetDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        const isToday = resetDate.toDateString() === new Date().toDateString();
        const isTomorrow = resetDate.toDateString() === new Date(Date.now() + 86_400_000).toDateString();
        const dayStr = isToday ? 'today' : isTomorrow ? 'tomorrow' : resetDate.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        resetHint = isToday ? `Resets at ${timeStr}.` : `Resets ${dayStr} at ${timeStr}.`;
      } else if (isOpenAIProvider) {
        resetHint = 'OpenAI limits can take up to a few hours to reset.';
      } else {
        resetHint = 'This usually resets within a few minutes.';
      }
      // Append exact reset time to contextual errors too (the backup-provider
      // guidance is still useful, but knowing when the limit resets is strictly better).
      const exactResetSuffix = resetAtMs && resetAtMs > Date.now() ? ` ${resetHint}` : '';
      const headline = isContextualError
        ? `${error}${exactResetSuffix}`
        : providerName
          ? `${providerName} is rate-limiting requests. ${resetHint}`
          : error;

      // Show raw provider detail only when human-readable and different from the headline
      const isHumanReadable = (text: string | undefined): boolean => {
        if (!text) return false;
        if (text.includes('{') || text.includes('"type":') || text.includes('"error":')) return false;
        return true;
      };
      const showDetail = isHumanReadable(rawError) && rawError?.trim() !== headline.trim();

      const hadToolEvents = failedTurnId
        ? (eventsByTurn[failedTurnId]?.some(e => e.type === 'tool') ?? false)
        : false;
      const retryMessage = failedTurnId
        ? (messages.find(m => m.turnId === failedTurnId && m.role === 'user' && !isMessageHidden(m)) ?? null)
        : null;
      const canRetry = retryMessage && !hadToolEvents;
      const hadAttachments = (retryMessage?.attachments?.length ?? 0) > 0;

      return (
        <div className="error-banner" data-testid="error-banner">
          <div className="error-banner-text">
            {headline}
            {showDetail && (
              <div className="error-banner-detail">{rawError}</div>
            )}
            {canRetry && hadAttachments && (
              <span className="error-banner-attachment-hint"> You'll need to re-attach your files.</span>
            )}
          </div>
          <div className="error-banner-actions">
            {error.toLowerCase().includes('settings') && (
              <Button
                variant="ghost"
                size="sm"
                className="error-banner-cta"
                onClick={() => {
                  setActiveSurface('settings');
                  fireAndForget(openSettingsDialog('agents', 'providerKeys'), 'navigateToProviderKeysFromRateLimit');
                }}
              >
                Open Settings
              </Button>
            )}
            {canRetry && (
              <Button
                variant="ghost"
                size="sm"
                className="error-banner-retry"
                onClick={() => {
                  setAgentError(null);
                  if (retryMessage?.text) {
                    fireAndForget(sendUserPrompt(retryMessage.text, 'text'), 'errorBannerRetry');
                  }
                }}
              >
                Try again
              </Button>
            )}
            <button
              type="button"
              className="error-banner-dismiss"
              onClick={() => setAgentError(null)}
              aria-label="Dismiss error"
            >
              ✕
            </button>
          </div>
        </div>
      );
    }

    // --- Watchdog and generic error handling (existing behavior) ---
    const isWatchdogError = classifySessionError(error.toLowerCase()) === 'watchdog';

    // Look up the latest error event matching this error string for provider context
    const matchingErrorEvent = (() => {
      let latest: Extract<AgentEvent, { type: 'error' }> | null = null;
      for (const events of Object.values(eventsByTurn)) {
        for (let i = events.length - 1; i >= 0; i--) {
          const candidate = events[i];
          if (candidate.type !== 'error') continue;
          if (candidate.error === error && (!latest || candidate.timestamp > latest.timestamp)) {
            latest = candidate;
          }
        }
      }
      return latest;
    })();
    const errorProvider = matchingErrorEvent?.provider;
    const errorKind = matchingErrorEvent?.errorKind;
    const billingMeta = matchingErrorEvent?.billingMeta;
    const roleResolutionFailure = parseRoleResolutionFailureFromRawError(
      matchingErrorEvent?.rawError,
    );

    // Detect auth/billing errors from structural metadata OR error text.
    // The catch-all error path doesn't always set errorKind,
    // so text matching is the reliable fallback — but only when errorKind
    // is absent. When errorKind is explicitly set (e.g. 'rate_limit'),
    // trust it and skip text-matching to avoid false reclassification.
    // Keep patterns aligned with humanizeError() in shared/utils/friendlyErrors.ts
    const lowerError = error.toLowerCase();
    const isAuthError = errorKind === 'auth'
      || errorKind === 'connection-not-configured'
      || (!errorKind && (lowerError.includes('api key')
        || lowerError.includes('authentication')
        || lowerError.includes('unauthorized')));
    const isBillingError = errorKind === 'billing'
      || (!errorKind && (lowerError.includes('billing')
        || lowerError.includes('credits')
        || lowerError.includes('credit balance')
        || lowerError.includes('quota')
        || lowerError.includes('spending limit')));
    const isModerationError = errorKind === 'moderation';
    const isClaudeMaxBlock = lowerError.includes('restricted by anthropic for third-party');
    const isRoleResolutionError = !!roleResolutionFailure;
    const isCouncilManagedEligibilityError = lowerError.includes('council mode needs at least one model you can run');
    const isSettingsActionable = isAuthError || isBillingError || isClaudeMaxBlock || isRoleResolutionError;
    // Mindstone managed-subscription failures must route to the subscription panel,
    // not the personal-API-key panel (providerKeys). The route terminal labels these
    // errors with provider 'Mindstone' (buildTerminalReconnectMessage / missing-mindstone-credentials).
    // Mirror classifyErrorUx: both connection-not-configured AND auth go to subscription
    // for Mindstone (this is the legacy fallback when event.resolution is absent).
    const isMindstoneSettingsError = (errorKind === 'connection-not-configured' || errorKind === 'auth')
      && errorProvider === 'Mindstone';
    const settingsActionSection = isRoleResolutionError
      ? 'model'
      : isCouncilManagedEligibilityError
        ? 'modelTeam'
        : isMindstoneSettingsError
          ? 'subscription'
          : 'providerKeys';

    // Provider-aware headline: enhance generic messages with provider context when known.
    //
    // Uses the classification-first `humanizeAgentError` for every kind the humanizer
    // owns. Caller-override kinds (message_timeout, process_exit, mcp_error,
    // session_not_found, tool_name_corrupt, user_action) carry bespoke per-call-site
    // copy in `error` already humanized at dispatch time via Stage 2 — we MUST NOT
    // overwrite it, so the HUMANIZER_OWNED_KINDS guard is the only acceptable gate.
    //
    // Auth parity note: humanizeAuth's copy ("There's an issue with your API key.
    // Check Settings to update it.") is provider-agnostic, whereas the previous
    // renderer branch produced provider-aware copy. We preserve the provider-aware
    // phrasing explicitly before the humanizer guard so the CTA-adjacent copy matches
    // the user's actual provider. See Stage 6 Impl Notes.
    const displayError = (() => {
      if (roleResolutionFailure) {
        return humanizeRoleResolutionFailure(roleResolutionFailure);
      }
      if (isCouncilManagedEligibilityError) {
        return error;
      }
      if (errorKind === 'connection-not-configured') {
        return error;
      }
      if (errorProvider === 'Mindstone' && isAuthError) {
        return 'Your Mindstone subscription credentials were rejected. Check your subscription status in Settings.';
      }
      if (errorProvider && isAuthError) {
        return `Your ${errorProvider} key may be invalid. Check your credentials in Settings.`;
      }
      if (billingMeta?.managedSubscription) {
        return error;
      }
      if (errorKind && HUMANIZER_OWNED_KINDS.has(errorKind)) {
        return humanizeAgentError({
          kind: 'classified',
          errorKind,
          billingMeta,
          rateLimitMeta: matchingErrorEvent?.rateLimitMeta,
          provider: errorProvider,
          upstreamProviderName: matchingErrorEvent?.billingMeta?.upstreamProviderName,
          rawMessage: error,
        });
      }
      return error;
    })();

    // For watchdog errors, find the failed turn's user message for retry
    let retryMessage: AgentTurnMessage | null = null;
    let hadAttachments = false;
    let hadToolEvents = false;

    if (isWatchdogError) {
      // Find the turn that had the watchdog error
      const failedTurnId = Object.entries(eventsByTurn).find(([, events]) =>
        events.some(e => e.type === 'error' && classifySessionError(e.error.toLowerCase()) === 'watchdog')
      )?.[0];

      if (failedTurnId) {
        // Check if this turn had tool events (unsafe to retry — could duplicate side effects)
        hadToolEvents = eventsByTurn[failedTurnId]?.some(e => e.type === 'tool') ?? false;

        // Find the user message for this specific turn (not just any last user message)
        retryMessage = messages.find(m => m.turnId === failedTurnId && m.role === 'user' && !isMessageHidden(m)) ?? null;
        hadAttachments = (retryMessage?.attachments?.length ?? 0) > 0;
      }
    }

    const canRetry = isWatchdogError && retryMessage && !hadToolEvents;
    const managedBillingSubscription = billingMeta?.managedSubscription;

    const providerBillingUrl = !managedBillingSubscription && isBillingError && errorProvider
      ? PROVIDER_BILLING_URLS[errorProvider]
      : undefined;

    return (
      <div className="error-banner" data-testid="error-banner">
        <span className="error-banner-text">
          {displayError}
          {isModerationError && (
            <span className="error-banner-attachment-hint"> Rephrase and retry should do it.</span>
          )}
          {canRetry && hadAttachments && (
            <span className="error-banner-attachment-hint"> You'll need to re-attach your files.</span>
          )}
        </span>
        <div className="error-banner-actions">
          {managedBillingSubscription
            ? (
              <ManagedBillingErrorActions
                managedSubscription={managedBillingSubscription}
                onAddOwnKey={() => {
                  setActiveSurface('settings');
                  fireAndForget(
                    openSettingsDialog('agents', 'modelTeam'),
                    'navigateToManagedOverflowSettings',
                  );
                }}
                onDismiss={() => setAgentError(null)}
              />
            )
            : (
              <>
                {providerBillingUrl && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="error-banner-cta"
                    onClick={() => {
                      window.appApi.openUrl(providerBillingUrl).catch(() => {});
                    }}
                  >
                    Top up credits <ExternalLink size={12} style={{ marginLeft: 4, verticalAlign: 'middle' }} />
                  </Button>
                )}
                {isSettingsActionable && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="error-banner-cta"
                    onClick={() => {
                      setActiveSurface('settings');
                      fireAndForget(
                        openSettingsDialog('agents', settingsActionSection),
                        'navigateToActionableSettings',
                      );
                    }}
                  >
                    Open Settings
                  </Button>
                )}
              </>
            )}
          {canRetry && (
            <Button
              variant="ghost"
              size="sm"
              className="error-banner-retry"
              onClick={() => {
                setAgentError(null);
                  if (retryMessage?.text) {
                    fireAndForget(sendUserPrompt(retryMessage.text, 'text'), 'errorBannerRetryBottom');
                }
              }}
            >
              Try again
            </Button>
          )}
          <button
            type="button"
            className="error-banner-dismiss"
            onClick={() => setAgentError(null)}
            aria-label="Dismiss error"
          >
            ✕
          </button>
        </div>
      </div>
    );
  }, [
    error,
    eventsByTurn,
    handleApplySessionErrorResolution,
    messages,
    pendingSessionErrorAction,
    setAgentError,
    sendUserPrompt,
    setActiveSurface,
    openSettingsDialog,
  ]);

  // Proactive OAuth migration banner — shows once to users who were migrated from OAuth
  const oauthMigratedAt = getOauthMigratedAt(settings);
  const apiKeyForBanner = getApiKey(settings);
  const oauthDeprecationBanner = useMemo(() => {
    if (oauthBannerDismissed) return null;
    if (!oauthMigratedAt) return null;

    const hasApiKey = Boolean(apiKeyForBanner);
    return (
      <div className="usage-warning-banner" data-testid="oauth-deprecation-banner">
        <div className="usage-warning-banner-text">
          Your previous login method has been retired — Anthropic no longer supports it for third-party apps.
          {hasApiKey
            ? ' Your API key is already set up, so you\'re covered.'
            : ' Add an API key in Settings to keep Rebel working.'}
        </div>
        <div className="usage-warning-banner-actions">
          <Button
            variant="ghost"
            size="sm"
            className="usage-warning-banner-cta"
            onClick={() => {
              setActiveSurface('settings');
              fireAndForget(openSettingsDialog('agents', 'apiKey'), 'navigateToApiKeySettings');
            }}
          >
            Open Settings
          </Button>
          <button
            type="button"
            className="usage-warning-banner-dismiss"
            onClick={() => {
              try { localStorage.setItem('oauth-deprecation-banner-dismissed', 'true'); } catch { /* best effort */ }
              setOauthBannerDismissed(true);
            }}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      </div>
    );
  }, [oauthBannerDismissed, oauthMigratedAt, apiKeyForBanner, setActiveSurface, openSettingsDialog]);

  // Banner priority: error banner wins over oauth deprecation
  const sessionBannerForSurface = sessionErrorBanner || oauthDeprecationBanner;

  // Stable callback for InboxPanel navigate to session
  const _handleInboxNavigateToSession = useCallback(async (sessionId: string) => {
    await navigateToConversation(sessionId, 'inbox');
  }, [navigateToConversation]);

  // Stable callback for InboxPanel open scratchpad
  const handleInboxOpenScratchpad = useCallback(() => {
    tracking.navigation.scratchpadOpened();
    setScratchpadOpen(true);
  }, [setScratchpadOpen]);

  // Stable callback for AutomationsPanel open file in library
  const handleAutomationsOpenFile = useCallback((filePath: string) => {
    fireAndForget(handleOpenInLibrary(filePath, false), 'openFileInLibraryFromAutomations');
  }, [handleOpenInLibrary]);

  // Memoize busySessionIds to prevent InboxPanel re-renders
  const busySessionIds = useMemo(
    () => new Set(sessionSummaries.filter(s => s.isBusy).map(s => s.id)),
    [sessionSummaries]
  );

  // Per-surface memos — each surface only re-creates when its own deps change,
  // instead of the old mega-memo where ANY dep change re-created ALL 6 surfaces.

  const sessionsSurfaceConfig: FlowSurfaceConfig = useMemo(() => ({
    kind: 'stage',
    content: (
      <SurfaceErrorBoundary surfaceName="Session">
        <SessionSurface
          errorBanner={sessionBannerForSurface}
          content={sessionSurfaceElement}
          footer={null}
          compaction={{
            phase: compactionState.phase,
            statusMessage: compactionState.statusMessage,
            depth: compactionState.depth,
            onDismiss: dismissCompaction,
            reason: compactionState.reason
          }}
        />
      </SurfaceErrorBoundary>
    )
  }), [sessionBannerForSurface, sessionSurfaceElement, compactionState.phase, compactionState.statusMessage, compactionState.depth, compactionState.reason, dismissCompaction]);

  // Homepage: navigate to sessions surface
  const handleNavigateToSessions = useCallback(() => {
    setActiveSurface('sessions');
    setShowConversation(true);
  }, [setActiveSurface, setShowConversation]);

  // Homepage: open a specific session from the recent conversations list
  const handleOpenSessionFromHomepage = useCallback((sessionId: string) => {
    handleOpenHistorySession(sessionId, 'homepage');
  }, [handleOpenHistorySession]);

  const handleNavigateToConnectors = useCallback(() => {
    setActiveSurfaceWithSideEffects('settings');
    fireAndForget(openSettingsDialog('tools'), 'navigateToConnectorsSettings');
  }, [setActiveSurfaceWithSideEffects, openSettingsDialog]);

  // MCP contribution: navigate to connector in Settings (for approved notifications)
  const handleViewMcpConnector = useCallback((connectorName?: string) => {
    setActiveSurfaceWithSideEffects('settings');
    fireAndForget(
      openSettingsDialog('tools', getConnectorSectionId(connectorName), {
        source: 'link',
        interactionType: 'programmatic',
      }),
      'handleViewMcpConnector',
    );
  }, [setActiveSurfaceWithSideEffects, openSettingsDialog]);

  // MCP contribution: spawn follow-up session for changes_requested notifications.
  // Uses contributionFollowUpService via IPC to create the seeded prompt with
  // skill mention, then uses prepareMentionAttachments + submitQueuedMessage
  // (same pattern as P1 entry points). Links the follow-up session to the
  // contribution store for traceability.
  const handleMakeMcpChanges = useCallback(async (notification: import('./features/homepage/hooks/useContributionNotifications').ContributionNotificationItem) => {
    try {
      const { context } = await window.contributionApi.createFollowUpContext({
        contributionId: notification.contributionId,
      });

      if (!context) {
        showToast({ title: 'Unable to create follow-up session' });
        return;
      }

      const sessionId = startFreshSession();

      // Build prompt with @skill mention for prepareMentionAttachments to resolve
      const prompt = `@\`rebel-system/skills/coding/${context.skillMention}\` ${context.prompt}`;

      const mentionAttachments = await prepareMentionAttachments(prompt);
      fireAndForget(
        submitQueuedMessage(
          prompt,
          'text',
          mentionAttachments.length > 0 ? mentionAttachments : undefined,
          {
            targetSessionId: sessionId,
          },
        ),
        'handleNotificationMakeChanges',
      );

      // Link the follow-up session to the contribution for traceability
      void window.contributionApi.linkFollowUpSession({
        contributionId: notification.contributionId,
        followUpSessionId: sessionId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to start follow-up session';
      showToast({ title: message });
    }
  }, [startFreshSession, prepareMentionAttachments, submitQueuedMessage, showToast]);

  // Homepage: navigate to Inbox tab (tasks surface)
  const handleNavigateToInbox = useCallback(() => {
    setActiveSurface('tasks');
  }, [setActiveSurface]);

  // Home activation is incomplete when setup is done but the coaching intro has
  // not completed. A missing coach session is still incomplete; Home can start a
  // fresh intro instead of silently marking onboarding complete.
  const checklistCoachSessionId = settings?.onboardingChecklist?.sessionIds?.[0];
  const onboardingActivationIncomplete = useMemo(() => {
    if (!settings?.onboardingCompleted) return false;
    // Completion signals (incl. legacy redundancy) live in the SSOT predicate,
    // paired with the relaunch reset in coachCompletionState.ts.
    return !hasCoachCompletionSignal(settings);
  }, [settings]);

  const resolvedCoachSessionId = settings?.onboardingSessionIds?.coach ?? checklistCoachSessionId;
  const hasAvailableCoachSession = useMemo(() => {
    if (!resolvedCoachSessionId) return false;
    return sessionSummaries.some((s) => s.id === resolvedCoachSessionId && s.deletedAt == null);
  }, [resolvedCoachSessionId, sessionSummaries]);

  const handleResumeCoach = useCallback(async () => {
    if (resolvedCoachSessionId) {
      const opened = await executeOpenHistorySession(resolvedCoachSessionId, 'onboarding', {
        transition: 'instant',
      });
      if (opened) {
        // Re-enter coaching mode so the coaching system prompt is applied to new messages
        // and the orchestrator's completion detection watches this session.
        setActiveSurface('sessions');
        setShowConversation(true);
        setIsOnboardingCoachActive(true);
        return;
      }

      await saveSettingsWith((draft) => {
        const sessionIds = { ...draft.onboardingChecklist?.sessionIds };
        delete sessionIds[0];

        return {
          ...draft,
          onboardingSessionIds: {
            ...draft.onboardingSessionIds,
            coach: null,
            memory: draft.onboardingSessionIds?.memory ?? null,
            useCases: draft.onboardingSessionIds?.useCases ?? null,
          },
          onboardingChecklist: draft.onboardingChecklist
            ? {
                ...draft.onboardingChecklist,
                sessionIds,
              }
            : draft.onboardingChecklist,
        };
      });
    }

    setOnboardingCoachLaunchRequestId((value) => (value ?? 0) + 1);
  }, [resolvedCoachSessionId, executeOpenHistorySession, saveSettingsWith, setActiveSurface, setShowConversation]);

  const handleCoachingDismiss = useCallback((sessionId: string) => {
    setCoachingSessionIds(prev => {
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  // Enable Focus from the homepage discovery nudge: save setting → navigate
  const handleEnableFocus = useCallback(async () => {
    await saveSettingsWith((draft) => ({
      ...draft,
      experimental: { ...draft.experimental, focusEnabled: true },
    }));
    setActiveSurface('focus');
  }, [saveSettingsWith, setActiveSurface]);

  const handleDismissMigrationImportNotice = useCallback(() => {
    clearStoredMigrationImportNotice();
    setMigrationImportNotice(null);
  }, []);

  // Single reactive source for the transfer-origin signal, shared with the
  // Settings "Finish settling in" section (Stage 3). Dismiss is coupled by design.
  // See docs/plans/260611_transfer-ui-tweaks/PLAN.md.
  const migrationNoticeContextValue = useMemo(
    () => ({ notice: migrationImportNotice, dismiss: handleDismissMigrationImportNotice }),
    [migrationImportNotice, handleDismissMigrationImportNotice],
  );

  const focusEnabled = settings?.experimental?.focusEnabled === true;

  const homepageSurfaceConfig: FlowSurfaceConfig = useMemo(() => ({
    content: (
      <SurfaceErrorBoundary surfaceName="Homepage">
        <DevProfiler id="HomepagePanel">
          <HomepagePanel
            onSubmitMessage={handleSelectUseCase}
            onNavigateToSessions={handleNavigateToSessions}
            onStartMeetingPrep={handleStartBackgroundSession}
            coachingSessionIds={coachingSessionIds}
            onCoachingDismiss={handleCoachingDismiss}
            onOpenFile={handleOpenDocumentInPreview}
            onOpenSession={handleOpenSessionFromHomepage}
            connectedConnectorCount={connectedConnectorCount}
            userAddedConnectorCount={userAddedConnectorCount}
            connectorActionAvailability={connectorActionAvailability}
            sessionCount={sessionSummaries.length}
            isReturningFromIdle={isReturningFromIdle}
            onNavigateToConnectors={handleNavigateToConnectors}
            onNavigateToInbox={handleNavigateToInbox}
            onboardingActivationIncomplete={onboardingActivationIncomplete}
            hasAvailableOnboardingCoachSession={hasAvailableCoachSession}
            onStartOnboardingIntro={handleResumeCoach}
            userFirstName={userFirstName}
            onOpenTimeSaved={openTimeSavedProgress}
            focusEnabled={focusEnabled}
            onEnableFocus={handleEnableFocus}
            prApprovedBanner={contributionBannerProps ? {
              ...contributionBannerProps,
              onViewConnector: () => {
                handleViewMcpConnector(contributionBannerProps.connectorName);
                contributionBannerProps.onDismiss?.();
              },
            } : null}
            startupNotice={migrationImportNotice ? (
              <MigrationReAuthChecklistNotice
                reAuthChecklist={migrationImportNotice.reAuthChecklist}
                onDismiss={handleDismissMigrationImportNotice}
              />
            ) : null}
            settings={settings}
            saveSettingsWith={saveSettingsWith}
            isDemoMode={isDemoMode}
          />
        </DevProfiler>
      </SurfaceErrorBoundary>
    )
  }), [handleSelectUseCase, handleNavigateToSessions, handleStartBackgroundSession, coachingSessionIds, handleCoachingDismiss, handleOpenDocumentInPreview, handleOpenSessionFromHomepage, connectedConnectorCount, userAddedConnectorCount, connectorActionAvailability, sessionSummaries.length, isReturningFromIdle, handleNavigateToConnectors, handleNavigateToInbox, onboardingActivationIncomplete, hasAvailableCoachSession, handleResumeCoach, userFirstName, openTimeSavedProgress, focusEnabled, handleEnableFocus, contributionBannerProps, migrationImportNotice, handleDismissMigrationImportNotice, settings, saveSettingsWith, isDemoMode, handleViewMcpConnector]);

  const usecasesSurfaceConfig: FlowSurfaceConfig = useMemo(() => ({
    content: (
      <SurfaceErrorBoundary surfaceName="Use Cases">
        <DevProfiler id="UseCasesPanel">
          <UseCasesPanel
            onSelectUseCase={handleSelectUseCase}
            onOpenFile={handleOpenDocumentInPreview}
            onOpenJourneyProgress={openJourneyProgress}
          />
        </DevProfiler>
      </SurfaceErrorBoundary>
    )
  }), [handleSelectUseCase, handleOpenDocumentInPreview, openJourneyProgress]);

  const tasksSurfaceConfig: FlowSurfaceConfig = useMemo(() => ({
    content: (
      <SurfaceErrorBoundary surfaceName="Tasks">
        <DevProfiler id="InboxPanel">
          <InboxPanel
            items={inboxItems}
            history={inboxHistory}
            loading={inboxLoading}
            busySessionIds={busySessionIds}
            internalConnectionStatus={internalConnectionStatus}
            internalConnectionPending={mcpMutationPending}
            canAutoConnectInternal={canAutoConnectInternal}
            onConnectInternal={addRebelInternalServer}
            onOpenInboxSettings={handleShowSettingsSurface}
            onExecute={handleTaskExecute}
            onShare={handleTaskShare}
            onDone={handleInboxDone}
            onDismiss={handleInboxDismiss}
            onSetTags={handleSetTags}
            onSetPriority={handleSetPriority}
            onSetSchedule={handleSetSchedule}
            onOpenSession={handleOpenTaskHistorySession}
            onOpenFile={handleOpenDocumentInPreview}
            onOpenScratchpad={handleInboxOpenScratchpad}
            onNavigateToConnectors={handleNavigateToConnectors}
            connectedConnectorCount={connectedConnectorCount}
            inboxLayoutMode={settings?.inboxLayoutMode ?? 'grid'}
            onInboxLayoutModeChange={handleInboxLayoutModeChange}
            archivedCount={inboxArchivedCount}
            mcpNotifications={contributionDrawerNotifications}
            onDismissMcpNotification={dismissContributionDrawer}
            onViewMcpConnector={handleViewMcpConnector}
            onMakeMcpChanges={handleMakeMcpChanges}
          />
        </DevProfiler>
      </SurfaceErrorBoundary>
    )
  }), [
    inboxItems, inboxHistory, inboxLoading, busySessionIds,
    internalConnectionStatus, mcpMutationPending, canAutoConnectInternal, addRebelInternalServer,
    handleShowSettingsSurface, handleTaskExecute, handleTaskShare,
    handleInboxDone, handleInboxDismiss, handleSetTags, handleSetPriority, handleSetSchedule, handleOpenTaskHistorySession,
    handleOpenDocumentInPreview, handleInboxOpenScratchpad,
    handleNavigateToConnectors, connectedConnectorCount,
    settings?.inboxLayoutMode, handleInboxLayoutModeChange,
    inboxArchivedCount, contributionDrawerNotifications, dismissContributionDrawer,
    handleViewMcpConnector, handleMakeMcpChanges,
  ]);

  const handleOpenProviderSettingsFromAutomations = useCallback((cause: AutomationAdmissionBlock | null) => {
    if (cause?.provider === 'anthropic') {
      fireAndForget(
        openSettingsDialog('agents', 'apiKey'),
        'navigateToApiKeySettingsFromAutomationsProviderReadiness',
      );
      return;
    }

    if (cause?.provider === 'codex' || cause?.provider === 'openrouter') {
      fireAndForget(
        openSettingsDialog('agents', 'providerKeys'),
        'navigateToProviderKeysFromAutomationsProviderReadiness',
      );
      return;
    }

    fireAndForget(
      openSettingsDialog('agents'),
      'navigateToAgentsSettingsFromAutomationsProviderReadiness',
    );
  }, [openSettingsDialog]);

  const automationsSurfaceConfig: FlowSurfaceConfig = useMemo(() => ({
    content: (
      <SurfaceErrorBoundary surfaceName="Automations">
        <DevProfiler id="AutomationsPanel">
          <AutomationsPanel
            onViewSession={handleViewAutomationSession}
            onStartCreateConversation={handleStartCreateAutomationConversation}
            onStartEditConversation={handleStartEditAutomationConversation}
            onCustomizeSystemAutomation={handleCustomizeSystemAutomation}
            onOpenFileInLibrary={handleAutomationsOpenFile}
            onSendMessageToSession={handleInboxSendMessage}
            onOpenProviderSettings={handleOpenProviderSettingsFromAutomations}
            providerReadinessSummary={providerReadinessSummary}
            showToast={showToast}
          />
        </DevProfiler>
      </SurfaceErrorBoundary>
    )
  }), [
    handleViewAutomationSession,
    handleStartCreateAutomationConversation, handleStartEditAutomationConversation,
    handleCustomizeSystemAutomation,
    handleAutomationsOpenFile,
    handleInboxSendMessage,
    handleOpenProviderSettingsFromAutomations,
    providerReadinessSummary,
    showToast,
  ]);

  const librarySurfaceConfig: FlowSurfaceConfig = useMemo(() => ({
    content: workspaceDrawerElement ? (
      <SurfaceErrorBoundary surfaceName="Library">
        <DevProfiler id="LibraryDrawer">
          {workspaceDrawerElement}
        </DevProfiler>
      </SurfaceErrorBoundary>
    ) : null,
    bodyClassName: 'library-surface'
  }), [workspaceDrawerElement]);

  const settingsSurfaceConfig: FlowSurfaceConfig = useMemo(() => ({
    content: (
      <SurfaceErrorBoundary surfaceName="Settings">
        <DevProfiler id="SettingsSurface">
          <SettingsSurface
            onClose={handleCloseSettingsSurface}
            onSave={handleSaveSettingsSurface}
            onRelaunchOnboarding={handleRelaunchOnboarding}
            onResetOnboardingChecklist={handleResetOnboardingChecklist}
            onConfigureWithRebel={handleConfigureWithRebel}
            onBuildConnector={handleBuildConnector}
            onExtendConnector={handleExtendConnector}
            onShareWithCommunity={handleShareWithCommunity}
            onOpenContributionChat={handleOpenContributionChat}
            onRequestConnector={handleRequestConnector}
            onChatAboutSafety={handleChatAboutSafetyRules}
            mcpRuntimeHealthDegraded={mcpRuntimeHealthDegraded}
          />
        </DevProfiler>
      </SurfaceErrorBoundary>
    ),
    bodyClassName: 'settings-surface-panel'
  }), [handleCloseSettingsSurface, handleSaveSettingsSurface, handleRelaunchOnboarding, handleResetOnboardingChecklist, handleConfigureWithRebel, handleBuildConnector, handleExtendConnector, handleShareWithCommunity, handleOpenContributionChat, handleRequestConnector, handleChatAboutSafetyRules, mcpRuntimeHealthDegraded]);

  const teamSurfaceConfig: FlowSurfaceConfig = useMemo(() => ({
    content: (
      <SurfaceErrorBoundary surfaceName="Team">
        <TeamPanel />
      </SurfaceErrorBoundary>
    )
  }), []);

  const focusSurfaceConfig: FlowSurfaceConfig = useMemo(() => ({
    content: (
      <SurfaceErrorBoundary surfaceName="Focus">
        <FocusPanel
          startFreshSession={startFreshSession}
          submitQueuedMessage={submitQueuedMessage}
          onOpenConversation={async (sessionId: string) => {
            await navigateToConversation(sessionId);
          }}
        />
      </SurfaceErrorBoundary>
    )
  }), [startFreshSession, submitQueuedMessage, navigateToConversation]);

  // Built-in surface configs — exhaustive Record ensures all built-in surfaces are covered.
  const builtInSurfaceConfigs: Record<BuiltInFlowSurface, FlowSurfaceConfig> = useMemo(() => ({
    home: homepageSurfaceConfig,
    focus: focusSurfaceConfig,
    sessions: sessionsSurfaceConfig,
    usecases: usecasesSurfaceConfig,
    tasks: tasksSurfaceConfig,
    automations: automationsSurfaceConfig,
    team: teamSurfaceConfig,
    library: librarySurfaceConfig,
    settings: settingsSurfaceConfig,
  }), [homepageSurfaceConfig, focusSurfaceConfig, sessionsSurfaceConfig, usecasesSurfaceConfig, tasksSurfaceConfig, automationsSurfaceConfig, teamSurfaceConfig, librarySurfaceConfig, settingsSurfaceConfig]);

  // Refs for plugin API callbacks — keep current so the one-time useEffect
  // never captures stale closures (fixes Gemini 3 Pro review finding).
  const handleNavigateFromChatRef = useRef(handleNavigateFromChat);
  const handleOpenConversationReferenceRef = useRef(handleOpenConversationReference);
  handleNavigateFromChatRef.current = handleNavigateFromChat;
  handleOpenConversationReferenceRef.current = handleOpenConversationReference;

  // Wire real plugin API module with app-level navigation callbacks.
  // This replaces the placeholder API set during initPluginModuleRegistry().
  useEffect(() => {
    const pluginApi = createPluginApiModule(
      (target: string) => {
        if (target.startsWith('rebel://')) {
          fireAndForget(handleNavigateFromChatRef.current(target), 'pluginNavigate');
        } else {
          setActiveSurface(target as FlowSurface);
        }
      },
      (sessionId: string) => {
        handleOpenConversationReferenceRef.current(sessionId);
      },
    );
    updatePluginModule('@rebel/plugin-api', pluginApi);
    // Freeze both __REBEL_MODULES__ and __REBEL_PLUGINS__ now that all
    // initialization is complete. This is Layer 1 of security hardening.
    freezeModuleRegistries();
    // Enable event bus dispatch now that plugins can receive events
    pluginEventBus.initialize();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: runs once on mount; freezeModuleRegistries() is a one-time security hardening step
  }, []);

  // ── Plugin event bus wiring ──────────────────────────────────────────
  // Emit lifecycle events to plugins from existing session/navigation state.
  // The event bus handles privacy guard and initialization guard internally.

  // Turn lifecycle: emit turn:started when isBusy transitions false→true,
  // turn:completed / turn:error when isBusy transitions true→false.
  const pluginPrevIsBusyRef = useRef(isBusy);
  const pluginPrevTurnIdRef = useRef(activeTurnId);
  useEffect(() => {
    const wasBusy = pluginPrevIsBusyRef.current;
    const prevTurnId = pluginPrevTurnIdRef.current;
    pluginPrevIsBusyRef.current = isBusy;
    pluginPrevTurnIdRef.current = activeTurnId;

    if (!wasBusy && isBusy && activeTurnId) {
      pluginEventBus.emit('turn:started', { sessionId: currentSessionId, turnId: activeTurnId });
    }
    if (wasBusy && !isBusy && prevTurnId) {
      if (error) {
        pluginEventBus.emit('turn:error', { sessionId: currentSessionId, turnId: prevTurnId, error });
      } else {
        const lastAssistant = messagesRef.current
          .filter((m) => m.role === 'assistant' && m.turnId === prevTurnId)
          .pop();
        const toolsUsed: string[] = [];
        const seenToolNames = new Set<string>();
        for (const event of getCurrentSessionEventsForTurn(prevTurnId)) {
          if (event.type !== 'tool') continue;
          if (seenToolNames.has(event.toolName)) continue;
          seenToolNames.add(event.toolName);
          toolsUsed.push(event.toolName);
        }
        pluginEventBus.emit('turn:completed', {
          sessionId: currentSessionId,
          turnId: prevTurnId,
          assistantText: lastAssistant?.text ?? '',
          toolsUsed,
        });
      }
    }
  }, [isBusy, activeTurnId, currentSessionId, error]);

  // Background session turn lifecycle: emit turn events for sessions other than the current one.
  // The effect above only monitors the current session's isBusy/activeTurnId state.
  // Background sessions (e.g. created by plugins via sendMessage) update sessionSummaries
  // but not the current session state, so their turn events never fire without this.
  // assistantText/toolsUsed are loaded from the loadedSessions LRU cache when available.
  const pluginPrevBgBusyMapRef = useRef(
    new Map(
      sessionSummaries
        .filter((s) => s.id !== currentSessionId)
        .map((s) => [s.id, { isBusy: s.isBusy, activeTurnId: s.activeTurnId }] as const)
    )
  );
  useEffect(() => {
    const prevMap = pluginPrevBgBusyMapRef.current;
    const nextMap = new Map<string, { isBusy: boolean; activeTurnId: string | null }>();

    for (const summary of sessionSummaries) {
      if (summary.id === currentSessionId) continue;

      nextMap.set(summary.id, { isBusy: summary.isBusy, activeTurnId: summary.activeTurnId });

      const prev = prevMap.get(summary.id);
      const wasBusy = prev?.isBusy ?? false;
      const prevTurnId = prev?.activeTurnId ?? null;

      if (!wasBusy && summary.isBusy && summary.activeTurnId) {
        pluginEventBus.emit('turn:started', { sessionId: summary.id, turnId: summary.activeTurnId }, summary.id);
      }

      if (wasBusy && !summary.isBusy && prevTurnId) {
        if (summary.lastError) {
          pluginEventBus.emit('turn:error', { sessionId: summary.id, turnId: prevTurnId, error: summary.lastError }, summary.id);
        } else {
          // Load assistantText/toolsUsed from loadedSessions cache (LRU, ~10 entries)
          const loadedSession = getSessionStoreState().loadedSessions.get(summary.id);
          let assistantText = '';
          const toolsUsed: string[] = [];

          if (loadedSession) {
            const lastAssistant = loadedSession.messages
              .filter((m) => m.role === 'assistant' && m.turnId === prevTurnId)
              .pop();
            assistantText = lastAssistant?.text ?? '';

            const turnEvents = loadedSession.eventsByTurn[prevTurnId] ?? [];
            const seenToolNames = new Set<string>();
            for (const event of turnEvents) {
              if (event.type !== 'tool') continue;
              if (seenToolNames.has(event.toolName)) continue;
              seenToolNames.add(event.toolName);
              toolsUsed.push(event.toolName);
            }
          } else {
            console.warn(`[Plugins] Background turn:completed cache miss for session ${summary.id} — assistantText will be empty`);
          }

          pluginEventBus.emit('turn:completed', {
            sessionId: summary.id,
            turnId: prevTurnId,
            assistantText,
            toolsUsed,
          }, summary.id);
        }
      }
    }

    pluginPrevBgBusyMapRef.current = nextMap;
  }, [sessionSummaries, currentSessionId]);

  // Conversation lifecycle: detect created/updated/deleted/restored sessions.
  // Created: new session IDs appearing in summaries.
  // Updated/deleted/restored: diff previous vs current summaries using lifecycleDiff utility.
  const pluginKnownSessionIdsRef = useRef<Set<string>>(new Set(sessionSummaries.map((s) => s.id)));
  const pluginPrevSummariesRef = useRef<AgentSessionSummary[]>(sessionSummaries);
  useEffect(() => {
    const prevSummaries = pluginPrevSummariesRef.current;
    pluginPrevSummariesRef.current = sessionSummaries;

    // Detect new sessions (conversation:created)
    for (const summary of sessionSummaries) {
      if (!pluginKnownSessionIdsRef.current.has(summary.id)) {
        pluginEventBus.emit('conversation:created', { sessionId: summary.id, title: summary.title ?? '' }, summary.id);
      }
    }
    pluginKnownSessionIdsRef.current = new Set(sessionSummaries.map((s) => s.id));

    // Detect lifecycle changes (updated/deleted/restored)
    const lifecycleEvents = diffSessionLifecycle(prevSummaries, sessionSummaries);
    for (const event of lifecycleEvents) {
      pluginEventBus.emit(event.type, event.payload, event.sessionId);
    }
  }, [sessionSummaries]);

  // Navigation changed: emit when activeSurface changes.
  const pluginPrevSurfaceRef = useRef(activeSurface);
  useEffect(() => {
    const prev = pluginPrevSurfaceRef.current;
    pluginPrevSurfaceRef.current = activeSurface;
    if (prev !== activeSurface) {
      pluginEventBus.emit('navigation:changed', { target: activeSurface, previousTarget: prev });
    }
  }, [activeSurface]);

  // Memory source added: subscribe to session store for memory update status changes.
  // Uses store.subscribe to avoid adding a state dep that triggers re-renders.
  useEffect(() => {
    const emittedTurnIds = new Set<string>();
    // Pre-populate with existing entries so we only emit for new ones
    const initial = getSessionStoreState().memoryUpdateStatusByTurn;
    for (const turnId of Object.keys(initial)) {
      emittedTurnIds.add(turnId);
    }
    return subscribeToSessionStore((state) => {
      for (const [turnId, status] of Object.entries(state.memoryUpdateStatusByTurn)) {
        if (status.status === 'success' && !emittedTurnIds.has(turnId)) {
          emittedTurnIds.add(turnId);
          pluginEventBus.emit('memory:source-added', { turnId, summary: status.summary });
        }
      }
    });
  }, []);

  // Main process plugin tool requests are delivered via MessagePort through preload.
  // Renderer compiles + registers, then returns a structured result over that port.
  useEffect(() => {
    if (!window.pluginsApi?.onCompileAndRegisterRequest) {
      return;
    }

    return window.pluginsApi.onCompileAndRegisterRequest(async ({ manifest, source }) => {
      const MAX_CRASHES_TO_REPORT = 5;
      const MAX_STACK_LINES = 8;
      const allCrashes = getPluginCrashes(manifest.id);
      const previousCrashes = allCrashes.slice(-MAX_CRASHES_TO_REPORT).map((crash) => ({
        ...crash,
        ...(crash.stack ? { stack: crash.stack.split('\n').slice(0, MAX_STACK_LINES).join('\n') } : {}),
        ...(crash.componentStack ? { componentStack: crash.componentStack.split('\n').slice(0, MAX_STACK_LINES).join('\n') } : {}),
      }));

      const compiled = compilePluginSource(source);
      if (!compiled.ok) {
        return {
          ok: false,
          errors: compiled.errors.map((error) => ({
            type: error.type,
            message: error.message,
            ...(error.line !== undefined ? { line: error.line } : {}),
            ...(error.column !== undefined ? { column: error.column } : {}),
            ...(error.snippet ? { snippet: error.snippet } : {}),
          })),
          ...(previousCrashes.length > 0 ? { previousCrashes } : {}),
        };
      }

      const registration = registerPlugin(manifest as PluginManifest, source);
      if (!registration.ok) {
        return {
          ok: false,
          errors: [{ type: 'validation', message: registration.error }],
          ...(previousCrashes.length > 0 ? { previousCrashes } : {}),
        };
      }

      clearPluginCrashes(manifest.id);

      return {
        ok: true,
        ...(compiled.warnings && compiled.warnings.length > 0
          ? {
              warnings: compiled.warnings.map((warning) => ({
                message: warning.message,
                type: warning.type,
              })),
            }
          : {}),
        ...(previousCrashes.length > 0 ? { previousCrashes } : {}),
      };
    });
  }, []);

  // Boot sequence: load persisted → migrate legacy entries → seed bundled plugins
  // → start persistence subscription → start controller. Order matters:
  //   - Persistence must subscribe AFTER load+migrate finish so the debounced
  //     save scheduled by `registerPlugin` notifications during `loadPersistedPlugins`
  //     can't write the migrated entries back into legacy persistence after
  //     `migrateToSpace` clears it (300ms debounce race).
  //   - Seed must happen before controller scan so freshly-seeded plugins are
  //     discovered in the first scan.
  //   - The seeded-id settings update re-reads the full settings snapshot
  //     because `settings:update` is full-replacement (no server-side merge).
  useEffect(() => {
    let persistenceCleanup: (() => void) | undefined;
    const bootPlugins = async () => {
      try {
        await loadPersistedPlugins();
      } catch (error) {
        ignoreBestEffortCleanup(error, {
          operation: 'App.bootPlugins.loadPersistedPlugins',
          reason: 'Plugin boot continues after legacy-load failure so migration/seed can still run',
        });
        // Non-fatal — registry persistence subscribers will keep retrying.
      }
      try {
        await window.pluginsApi?.migrateToSpace?.();
      } catch (error) {
        ignoreBestEffortCleanup(error, {
          operation: 'App.bootPlugins.migrateToSpace',
          reason: 'Migration failure should not block plugin boot; legacy entries can still load and retry later',
        });
        // Migration failure is non-fatal — persisted plugins still load from electron-store
      }
      try {
        const settings = await window.settingsApi.get();
        const alreadySeededIds = settings.seededBundledPluginIds ?? [];
        const result = await window.pluginsApi?.seedBundled?.({ alreadySeededIds });
        if (result) {
          // Both `seeded` (freshly written) and `skipped` (already-considered or CoS-resident)
          // count as "we considered this id" for idempotency purposes. `failed`/`malformed` do NOT.
          const nextIds = Array.from(new Set([
            ...alreadySeededIds,
            ...result.seeded,
            ...result.skipped,
          ]));
          if (nextIds.length !== alreadySeededIds.length) {
            // `settings:update` is full-replacement; re-read the latest snapshot and merge
            // the new field so concurrent settings edits aren't clobbered.
            const fresh = await window.settingsApi.get();
            await window.settingsApi.update({ ...fresh, seededBundledPluginIds: nextIds });
          }
          const failedCount = result.failed.length + result.malformed.length;
          if (failedCount > 0) {
            const ids = [...result.failed, ...result.malformed];
            showToast({
              title: 'Bundled plugins partially loaded',
              description: `${failedCount} bundled plugin${failedCount === 1 ? '' : 's'} could not be installed (${ids.join(', ')}). Rebel will retry on next launch.`,
              variant: 'warning',
            });
          }
        }
      } catch (error) {
        ignoreBestEffortCleanup(error, {
          operation: 'App.bootPlugins.seedBundled',
          reason: 'Bundled seeding is best-effort at boot and retries on next launch',
        });
        // Seed failure is non-fatal — next launch will retry.
      }
      persistenceCleanup = initializePluginPersistence();
      startSharedSpacePluginsController();
    };
    fireAndForget(bootPlugins(), 'bootPlugins');
    return () => {
      persistenceCleanup?.();
      stopSharedSpacePluginsController();
    };
  }, [showToast]);

  // Listen for agent-triggered plugin unregister/navigate broadcasts.
  useEffect(() => {
    const unsubUnregister = window.pluginsApi.onPluginUnregister?.((pluginId) => {
      clearPluginRoute(pluginId);
      unregisterPlugin(pluginId);
    });
    const unsubNavigate = window.pluginsApi.onPluginNavigate?.((pluginId, params) => {
      // Always write route state on explicit open (replaces previous state)
      setPluginRoute(pluginId, { params: params ?? {} });
      const surfaceId = createPluginSurfaceId(pluginId);
      setActiveSurface(surfaceId);
    });
    return () => {
      unsubUnregister?.();
      unsubNavigate?.();
    };
  }, [setActiveSurface]);

  // Plugin surface configs — dynamic Map populated from the plugin registry.
  const pluginSurfaceConfigs = useMemo(() => {
    const configs = new Map<PluginSurfaceId, FlowSurfaceConfig>();
    for (let i = 0; i < registeredPlugins.length; i++) {
      const surfaceId = pluginSurfaceIds[i];
      const plugin = registeredPlugins[i];
      configs.set(surfaceId, {
        content: <PluginSurface surfaceId={surfaceId} source={plugin.source} />,
        kind: 'panel',
      });
    }
    return configs;
  }, [registeredPlugins, pluginSurfaceIds]);

  // Combined lookup — merges built-in Record + plugin Map for FlowPanelsShell.
  const flowSurfaceConfigs: Record<string, FlowSurfaceConfig | undefined> = useMemo(() => {
    const combined: Record<string, FlowSurfaceConfig | undefined> = { ...builtInSurfaceConfigs };
    for (const [id, config] of pluginSurfaceConfigs) {
      combined[id] = config;
    }
    return combined;
  }, [builtInSurfaceConfigs, pluginSurfaceConfigs]);

  // Workspace layout and CSS variables handled inside FlowPanelsShell

  // Inline voice UI is used; disable full-screen overlay
  const _voiceModeOverlayElement = null;

  // ═══════════════════════════════════════════════════════════════════════════════
  // SECTION: Render
  // Early returns for loading states, then main JSX composition.
  // ═══════════════════════════════════════════════════════════════════════════════

  // Show minimal loading state until settings are loaded to prevent UI flashing
  // This eliminates the "tests running" feel where elements appear before initialization completes
  if (!settings) {
    // If emergency recovery is triggered, show that instead of just the splash
    if (showEmergencyRecovery) {
      return (
        <EmergencyStartupRecovery
          onContinueWaiting={() => {
            emergencyRecoveryDismissedRef.current = true;
            setShowEmergencyRecovery(false);
          }}
        />
      );
    }
    return (
      <div className="app-loading-splash app-loading-splash--homepage">
        <HomepageLoadingSkeleton />
      </div>
    );
  }

  return (
    <AppProvider value={appContextValue}>
      <MigrationNoticeProvider value={migrationNoticeContextValue}>
      <SettingsProvider value={settingsFeature}>
      <NavigationProvider deps={navigationDeps}>
      <NavigateRefSync navigateRef={navigateRef} />
      <AuthGate>
      {/* Onboarding coach orchestrator — conditionally mounted pre-onboarding only */}
      {!settings?.onboardingCompletedAt && (
        <OnboardingCoachOrchestrator
          ref={onboardingCoachRef}
          shouldRenderMainApp={shouldRenderMainApp}
          showOnboardingWizard={showOnboardingWizard}
          onboardingDay={settings?.onboardingDay}
          onboardingCompletedAt={settings?.onboardingCompletedAt}
          launchRequestId={onboardingCoachLaunchRequestId}
          isOnboardingCoachActive={isOnboardingCoachActive}
          resetSessionState={resetSessionState}
          handleUserMessageRef={handleUserMessageRef}
          saveSettingsWith={saveSettingsWith}
          emitLog={emitLog}
          persistedCoachSessionId={resolvedCoachSessionId ?? undefined}
          persistedDiscoverySessionId={settings?.onboardingSessionIds?.discovery ?? undefined}
          setIsOnboardingCoachActive={setIsOnboardingCoachActive}
          setShowOnboardingManualContinue={setShowOnboardingManualContinue}
          setActiveSurface={(s: string) => setActiveSurface(s as FlowSurface)}
          setShowConversation={setShowConversation}
        />
      )}
      {/* Main app UI - only render after onboarding sequence completes */}
      {shouldRenderMainApp && (
        <MentionProvider value={mentionContextValue}>
        <div className="app-wrapper visible focus-mode">
          <FlowPanelsShell
          brand={flowShellBrand}
          headerCenter={flowShellHeaderCenter}
          headerRight={flowShellHeaderRight}
          sidebar={sidebarElement}
          surfaceTabs={surfaceTabs}
          surfaces={flowSurfaceConfigs}
          onSurfaceChange={handleSurfaceChange}
          onToggleHistory={handleToggleHistoryPanel}
          onLibraryReset={handleLibraryReset}
          showConversation={showConversation}
          rightDrawer={rightDrawerElement}
          chromeMode={chromeMode}
          showOnboardingManualContinue={showOnboardingManualContinue}
          onOnboardingManualContinue={() => onboardingCoachRef.current?.handleCoachDeferred()}
          isDemoMode={isDemoMode}
          isExitingDemoMode={isExitingDemoMode}
          onExitDemoMode={exitDemoMode}
          onRestartDemoMode={() => setDemoModeDialogOpen(true)}
          belowTabs={!showOnboardingWizard ? <><DataReadOnlyBanner /><VersionOutdatedBanner /></> : undefined}
          approvalsDrawer={
            <NotificationDrawer
              onClose={() => closeApprovalsDrawer()}
              onSendMessageToSession={handleInboxSendMessage}
              onAddReceiptToSession={handleInboxAddReceiptToSession}
              busySessionIds={busySessionIds}
              scrollToSessionId={notificationScrollTarget}
              onScrollComplete={() => setNotificationScrollTarget(null)}
              mcpNotifications={contributionDrawerNotifications}
              onDismissMcpNotification={dismissContributionDrawer}
              onViewMcpConnector={handleViewMcpConnector}
              onMakeMcpChanges={handleMakeMcpChanges}
            />
          }
          />
        </div>
        <VisualCaptureOverlay onStop={() => { fireAndForget(stopActiveTurn(), 'visualCaptureOverlayStop'); }} />
        {/* Persistent nudge toast — visible across all views */}
        <ApprovalNudgeToast
          count={pendingApprovalCount}
          questionCount={pendingQuestionWaitingCount}
          drawerVisible={approvalsDrawerOpen}
          onOpenDrawer={() => openApprovalsDrawer()}
        />
        {/* Find-in-page bar (conversation/general) — floating overlay */}
        <FindBar isOpen={showFindBar} onClose={() => setShowFindBar(false)} pendingAction={pendingFindAction} onPendingActionConsumed={() => setPendingFindAction(null)} />
        </MentionProvider>
      )}
      {/* Fallback UI for *genuinely* stuck states — helps debug blank-screen issues.
          The full homepage skeleton is reserved for the initial settings-loading
          path above. Once settings exist, this branch should not re-show a second
          skeleton during short main-app mount windows; it only offers the delayed
          Refresh escape hatch if the app appears stuck. */}
      {!shouldRenderMainApp && !showOnboardingWizard && !isInOnboardingSequence && (
        <div className="app-loading-splash app-loading-splash--homepage">
          <div className="app-loading-splash__fallback">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                emitLog({
                  level: 'info',
                  message: 'User clicked refresh from fallback UI',
                  context: {
                    hasSettings: !!settings,
                    shouldRenderMainApp,
                    showConversation,
                    showOnboardingWizard,
                    isInOnboardingSequence,
                    isAnimatingOnboardingExit,
                  },
                  timestamp: Date.now()
                });
                // The only thing this escape hatch can clear in the derived
                // `shouldRenderMainApp` model is a stuck exit-animation flag.
                // If we're stuck for another reason (settings still null, still
                // in onboarding), clearing this is a safe no-op.
                setIsAnimatingOnboardingExit(false);
              }}
            >
              Refresh
            </Button>
          </div>
        </div>
      )}

      <UpdateToastManager ref={updateToastManagerRef} showToast={showToast} onDismiss={resetUpdateDedup} />
      <OfflineBanner status={offlineStatus} />
      <SafeModeOrchestrator
        ref={safeModeOrchestratorRef}
        safeModeContext={safeModeContext}
        setSafeModeContext={setSafeModeContext}
        settings={settings}
        mcpRouterIsRunning={mcpSummary?.router?.isRunning ?? false}
        resetSessionState={resetSessionState}
        setActiveSurface={setActiveSurface}
        setShowConversation={setShowConversation}
        setIsTextMode={setIsTextMode}
        setFlowHistoryOpen={setFlowHistoryOpen}
        emitLog={emitLog}
      />

      <Dialog open={workspaceRecoveryDialog.open} onOpenChange={() => {}}>
        <DialogContent size="sm" data-testid="workspace-recovery-dialog">
          <DialogHeader>
            <DialogTitle>Library folder not accessible</DialogTitle>
            <DialogDescription>
              Rebel can’t access your Library folder right now. Choose a new location or try again.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {workspaceRecoveryDialog.path ? (
              <div className="text-sm">
                <div className="text-muted-foreground">Current location</div>
                <div className="mt-1 font-mono break-all">{workspaceRecoveryDialog.path}</div>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No Library folder is configured.</div>
            )}
            {workspaceRecoveryDialog.error && (
              <div className="mt-3 text-sm text-muted-foreground">
                {workspaceRecoveryDialog.code ? `${workspaceRecoveryDialog.code}: ` : ''}
                {workspaceRecoveryDialog.error}
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={workspaceRecoveryDialog.checking}
              onClick={() => {
                fireAndForget(handleRetryWorkspaceAccess(), 'retryWorkspaceAccess');
              }}
            >
              Try again
            </Button>
            <Button
              disabled={workspaceRecoveryDialog.checking}
              onClick={() => {
                fireAndForget(handleChooseNewWorkspace(), 'chooseNewWorkspace');
              }}
            >
              Choose folder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ResumeConversationsModal
        open={networkReconnectResume.shouldShowModal}
        onClose={networkReconnectResume.closeModal}
        pendingTurns={networkReconnectResume.pendingTurns}
        sessions={sessionSummaries}
        onResumeAll={networkReconnectResume.resumeAll}
        onHandleManually={networkReconnectResume.handleManually}
      />
      <InterruptedSessionsModal
        open={interruptedSessionResume.shouldShowModal}
        onClose={interruptedSessionResume.closeModal}
        sessions={interruptedSessionResume.interruptedSessions}
        isResuming={interruptedSessionResume.isResuming}
        onResumeSession={interruptedSessionResume.resumeSession}
        onResumeAll={interruptedSessionResume.resumeAll}
        onDismissSession={interruptedSessionResume.dismissSession}
        onDismissAll={interruptedSessionResume.dismissAll}
      />
      {!showOnboardingWizard && (
        <>
          <PermissionStatusBanner
            onRequestPermissions={openPermissionOnboarding}
            settings={settings}
          />
          <PermissionOnboardingDialog
            isOpen={showPermissionOnboarding}
            onClose={closePermissionOnboarding}
            settings={settings}
          />
        </>
      )}
      <OnboardingWizard
        isOpen={showOnboardingWizard}
        completeOnboarding={completeOnboardingFlow}
        onUserNameFetched={handleUserNameFetched}
        onUseCasesGenerated={handleUseCasesGenerated}
        onDraftElevenlabsKeyChange={handleDraftElevenlabsKeyChange}
        onFinalSetupStepEntered={() => onboardingCoachRef.current?.handleFinalSetupStepEntered()}
      />
      {pendingDeleteSession ? (
        <SessionDeleteDialog
          sessionId={pendingDeleteSession.id}
          sessionTitle={pendingDeleteSession.title}
          sessionTimestamp={pendingDeleteSession.timestamp}
          messageCount={pendingDeleteSession.messageCount}
          isActive={pendingDeleteSession.isActive}
          willStopRun={pendingDeleteSession.willStopRun}
          queuedMessageCount={pendingDeleteSession.queuedMessageCount}
          onCancel={handleCancelDeleteSession}
          onConfirm={handleConfirmDeleteSession}
        />
      ) : null}
      {pendingDraftDiscard ? (
        <DraftDiscardDialog
          draftPreview={pendingDraftDiscard.draftText}
          type={pendingDraftDiscard.type}
          onDiscard={handleDraftDiscardConfirmAndDrop}
          onCancel={handleDraftDiscardCancel}
        />
      ) : null}
      <NpsSurveyDialog
        isOpen={showNps}
        onDismiss={handleNpsDismiss}
        onSubmit={handleNpsSubmit}
      />
      <SurveyModal
        isOpen={showSurvey}
        config={surveyConfig}
        onDismiss={handleSurveyDismiss}
        onComplete={handleSurveyComplete}
      />
      <DesktopNotificationPrompt
        isOpen={showNotificationPrompt}
        onEnable={handleNotificationEnable}
        onDismiss={handleNotificationPromptDismiss}
        onOpenSettings={handleNotificationPromptOpenSettings}
      />
      <QuickOpenDialog
        open={quickOpenOpen}
        onOpenChange={setQuickOpenOpen}
        files={libraryIndex}
        isPartialTree={libraryIndexMetadata?.truncated === true}
        onSelectFile={handleQuickOpenSelect}
      />
      <WorkspaceConflictDialog
        open={workspaceConflictDialogOpen}
        onOpenChange={setWorkspaceConflictDialogOpen}
        initialConflictPaths={workspaceConflictPaths}
        showToast={showToast}
      />
      <WhatsNewDialog
        open={whatsNewOpen}
        onOpenChange={setWhatsNewOpen}
        currentVersion={appVersion ?? undefined}
        onTryFeature={(highlight) => {
          setWhatsNewOpen(false);
          handleTryWhatsNewFeature(highlight);
        }}
      />
      <TutorialsModal
        open={tutorialsModalOpen}
        onOpenChange={(open) => {
          if (!open) closeTutorials();
        }}
        initialVideo={tutorialsModalInitialVideo}
      />
      <ShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
      />
      <CanvasInputSurface
        isOpen={canvasOpen}
        onClose={() => setCanvasOpen(false)}
        onSend={handleCanvasSend}
        onError={handleCanvasError}
        theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
      />
      <Dialog
        open={downloadDiagnosticsDialogOpen}
        onOpenChange={setDownloadDiagnosticsDialogOpen}
      >
        <DialogContent size="sm" data-testid="download-diagnostics-dialog">
          <DialogHeader>
            <DialogTitle>Download diagnostics</DialogTitle>
            <DialogDescription>Choose a format to export.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="space-y-4">
              <div>
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => {
                    tracking.navigation.helpMenuItemClicked('diagnostics_standard');
                    setDownloadDiagnosticsDialogOpen(false);
                    fireAndForget(handleDownloadDiagnostics(), 'downloadDiagnosticsMd');
                  }}
                  data-testid="download-diagnostics-md"
                >
                  High-level report (.md)
                </Button>
                <p className="mt-1 text-xs text-muted-foreground">
                  Best for sharing. Includes health checks, settings, and recent logs.
                </p>
              </div>
              <div>
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => {
                    tracking.navigation.helpMenuItemClicked('diagnostics_detailed');
                    setDownloadDiagnosticsDialogOpen(false);
                    fireAndForget(handleDownloadDetailedDiagnostics(), 'downloadDiagnosticsZip');
                  }}
                  data-testid="download-diagnostics-zip"
                >
                  Detailed bundle (.zip)
                </Button>
                <p className="mt-1 text-xs text-muted-foreground">
                  More data for deeper debugging. Review before sharing externally.
                </p>
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDownloadDiagnosticsDialogOpen(false)}
              data-testid="download-diagnostics-cancel"
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <BugReportDialog
        open={bugReportOpen}
        onOpenChange={(open) => {
          setBugReportOpen(open);
          if (!open) {
            setBugReportDefaultFeedbackType(undefined);
            setBugReportPrefill(undefined);
          }
        }}
        defaultFeedbackType={bugReportDefaultFeedbackType}
        prefill={bugReportPrefill}
        conversationId={currentSessionId}
        onSuccess={(eventId) => {
          if (eventId === 'pending') {
            // Async bug report flow: show assembling toast, completion comes via broadcast
            showToast({
              title: 'Rebel is assembling your bug report...',
            });
          } else {
            showToast({
              title: 'Feedback submitted',
              description: `Reference: ${eventId}`,
            });
          }
        }}
        onError={(error) => {
          showToast({
            title: 'Failed to submit feedback',
            description: error.message,
            variant: 'error',
          });
        }}
      />
      <DemoModeDialog
        open={demoModeDialogOpen}
        onOpenChange={setDemoModeDialogOpen}
        showToast={showToast}
        isRestart={isDemoMode}
      />
      <DiagnoseDialogManager
        ref={diagnoseDialogManagerRef}
        sessionSummaries={sessionSummaries}
        currentSessionId={currentSessionId}
        currentSessionTitle={currentSessionTitle}
        resetSessionState={resetSessionState}
        setActiveSurface={(s: string) => setActiveSurface(s as FlowSurface)}
        setShowConversation={setShowConversation}
        showToast={showToast}
        submitQueuedMessage={submitQueuedMessage}
      />
      {sharingSessionId && (
        <ShareConversationDialog
          mode="conversation"
          sessionId={sharingSessionId}
          onShare={handleShareConfirm}
          onCancel={() => setSharingSessionId(null)}
        />
      )}
      {sharingFilePath && (
        <ShareConversationDialog
          mode="file"
          filePath={sharingFilePath}
          onShare={handleShareFileConfirm}
          onCancel={() => setSharingFilePath(null)}
        />
      )}
      <LocalRecordingConsentDialog
        open={localRecordingConsentOpen}
        onOpenChange={setLocalRecordingConsentOpen}
        onConfirm={async (dontShowAgain) => {
          const meetingTitle = pendingLocalRecordingRef.current;
          pendingLocalRecordingRef.current = null;
          
          // Save consent if user checked "don't show again"
          if (dontShowAgain) {
            const currentSettings = await window.settingsApi?.get();
            if (currentSettings) {
              await window.settingsApi?.update({
                ...currentSettings,
                meetingBot: {
                  ...currentSettings.meetingBot,
                  localRecordingConsentAcknowledged: true,
                },
              });
            }
          }
          
          // Now proceed with recording
          if (!meetingTitle) return;
          
          // Check permissions first
          const permCheck = await window.meetingBotApi?.checkLocalRecordingPermissions();
          if (!permCheck?.supported) {
            showToast({ title: permCheck?.unsupportedReason || 'Local recording not supported on this platform' });
            return;
          }
          if (!permCheck?.allGranted) {
            const permResult = await window.meetingBotApi?.requestLocalRecordingPermissions();
            if (!permResult?.success) {
              showToast({ title: 'Please grant permissions in your system settings and try again' });
              return;
            }
          }
          
          // Start local recording
          const result = await window.meetingBotApi?.startLocalRecording({ meetingTitle });
          if (!result?.success) {
            console.error('Failed to start local recording:', result?.error);
            showToast({ title: result?.error || 'Could not start local recording' });
          }
        }}
        onCancel={() => {
          pendingLocalRecordingRef.current = null;
        }}
      />
      {/* MeetingCompanionManager — owns companion creation effect, dedup override dialog */}
      {settings?.meetingBotUnlocked === true && (
        <MeetingCompanionManager
          ref={meetingCompanionRef}
          companionSessionByMeetingUrl={companionSessionByMeetingUrl}
          setCompanionSessionByMeetingUrl={setCompanionSessionByMeetingUrl}
          navigateToConversation={navigateToConversation}
          showToast={showToast}
          handleUserMessageRef={handleUserMessageRef}
        />
      )}
      <ScratchpadModal
        open={scratchpadOpen}
        onOpenChange={setScratchpadOpen}
        coreDirectory={settings?.coreDirectory ?? null}
        onOpenFile={handleOpenDocumentInPreview}
        showToast={showToast}
        onOpenSettings={() => {
          setScratchpadOpen(false);
          setActiveSurface('settings');
        }}
      />
      <TimeSavedModal
        open={timeSavedModalOpen}
        onClose={() => {
          setTimeSavedModalOpen(false);
          setFirstWeekCelebration(false);
        }}
        celebrationMode={firstWeekCelebration ? 'first-week' : undefined}
        sessions={sidebarAgentSessions}
        onNavigateToSession={async (sessionId) => {
          // Use canonical navigation helper so scroll-settling contract is applied
          // and we land at the latest turn instead of the top of a previously-scrolled thread.
          await navigateToConversation(sessionId, 'time_saved');
        }}
      />
      <TimeSavedMilestoneChecker />
      <StreakMilestoneChecker />
      <BadgeUnlockChecker />
      <TierUnlockChecker />

      <AchievementHub
        open={achievementHubOpen}
        onClose={() => {
          setAchievementHubOpen(false);
          setAchievementHubInitialTab('overview'); // Reset to default
        }}
        initialTab={achievementHubInitialTab}
        sessions={sidebarAgentSessions}
        onNavigateToSession={async (sessionId) => {
          // Use canonical navigation helper so scroll-settling contract is applied
          // and we land at the latest turn instead of the top of a previously-scrolled thread.
          await navigateToConversation(sessionId, 'achievement');
        }}
        onNavigateToSpark={() => {
          setActiveSurface('usecases');
        }}
        onSelectJourneyTask={(prompt) => {
          handleSelectUseCase(prompt);
        }}
      />
      <FirstWeekCelebrationChecker
        onTrigger={() => {
          setFirstWeekCelebration(true);
          setTimeSavedModalOpen(true);
        }}
      />
      <GraduationChecker
        onTrigger={(data) => {
          setGraduationData(data);
          setGraduationModalOpen(true);
        }}
      />
      <GraduationModal
        open={graduationModalOpen}
        onClose={() => setGraduationModalOpen(false)}
        badgesEarned={graduationData?.badges ?? []}
        journeyStats={graduationData?.stats ?? { daysCompleted: 0, totalMinutesSaved: 0 }}
        onStartConversation={(prompt) => {
          const newSessionId = startFreshSession();
          fireAndForget(submitQueuedMessage(prompt, 'text', undefined, { targetSessionId: newSessionId }), 'graduationModalStartConversation');
        }}
      />
      </AuthGate>
      </NavigationProvider>
      </SettingsProvider>
      </MigrationNoticeProvider>
    </AppProvider>
  );
};

export default App;
