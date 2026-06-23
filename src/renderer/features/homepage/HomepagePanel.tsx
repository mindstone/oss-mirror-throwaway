/**
 * HomepagePanel - Main homepage surface
 *
 * Layout modelled after AutomationsPanel:
 *   - Page header: greeting title + contextual subtitle
 *   - Hero chat input (same visual weight as automations hero input)
 *   - Recent conversations (3–4 latest)
 *   - Two-column row: Today (60%) + Coach (40%)
 *
 * Adapts content by user state (see useHomepageState).
 */

import { useCallback, useMemo, useState, useEffect, useRef, type ReactNode } from 'react';
import { Timer } from 'lucide-react';
import { DailySparkSlot } from './components/DailySparkSlot';
import { HomepageChat } from './components/HomepageChat';
import { PRApprovedBanner, type PRApprovedBannerProps } from './components/PRApprovedBanner';
import { EfficiencyModeOfferCard } from './components/EfficiencyModeOfferCard';
import { useEfficiencyModeOffer } from './hooks/useEfficiencyModeOffer';
import { TodaySection, type ConnectorActionAvailability } from './components/TodaySection';
import { CoachSection } from './components/CoachSection';
import { PluginWidgetSection } from './components/PluginWidgetSection';
import { useHomepageState } from './hooks/useHomepageState';
import type { HomepageUserState } from './hooks/useHomepageState';
import { useMeetingCache } from '../usecases/hooks/useMeetingCache';
import { useHomepageInboxItems } from './hooks/useHomepageInboxItems';
import { useFirstRunActionsPass } from './hooks/useFirstRunActionsPass';
import { useTimeSavedData, formatTimeSavedCompact } from '@renderer/hooks/useProgressData';
import { classifyInboxTier, shouldRedirectToCoach } from './utils/inboxTiers';
import { useFlowPanels } from '../flow-panels/FlowPanelsProvider';
import { tracking } from '@renderer/src/tracking';
import { getGreeting as getSharedGreeting } from '@rebel/shared';
import { useMentionContext } from '@renderer/contexts';
import { useNavigationSafe } from '@renderer/contexts/NavigationContext';
import { fireAndForget } from '@shared/utils/fireAndForget';
import type { FileAttachment } from '../composer/hooks/useFileAttachments';
import { PageHeader } from '@renderer/components/ui';
import type { AppSettings } from '@shared/types';
import styles from './HomepagePanel.module.css';

type SaveSettingsWith = (
  updater?: (draft: AppSettings) => AppSettings,
  options?: { keepOpen?: boolean }
) => Promise<void>;

interface HomepagePanelProps {
  onSubmitMessage: (prompt: string, attachments?: FileAttachment[]) => void;
  onNavigateToSessions: () => void;
  onStartMeetingPrep: (prompt: string) => string;
  coachingSessionIds: Set<string>;
  onCoachingDismiss: (sessionId: string) => void;
  onOpenFile?: (path: string) => void;
  onOpenSession?: (sessionId: string) => void;
  /** Number of connected external connectors (calendar, email, etc.) */
  connectedConnectorCount?: number;
  /** Number of user-added connectors (excluding system/internal MCP servers) */
  userAddedConnectorCount?: number;
  /** Connected connector categories used to choose a truthful starter action */
  connectorActionAvailability?: ConnectorActionAvailability;
  /** Number of past conversation sessions */
  sessionCount?: number;
  /** Whether the user just returned from idle (set by useInactivityReturn) */
  isReturningFromIdle?: boolean;
  /** Navigate to connector setup in settings */
  onNavigateToConnectors?: () => void;
  /** Navigate to Inbox tab (tasks surface) */
  onNavigateToInbox?: () => void;
  /** Whether the new-user Home activation card should stay visible */
  onboardingActivationIncomplete?: boolean;
  /** Whether a valid onboarding coach session exists to resume */
  hasAvailableOnboardingCoachSession?: boolean;
  /** Start or resume the onboarding intro from Home */
  onStartOnboardingIntro?: () => void;
  /** User's first name for personalised greeting */
  userFirstName?: string | null;
  /** Open the progress/achievement hub to the Time Saved tab */
  onOpenTimeSaved?: () => void;
  /** Whether the Focus feature is enabled */
  focusEnabled?: boolean;
  /** Enables Focus via settings save + navigates to Focus surface */
  onEnableFocus?: () => Promise<void>;
  /** Optional visual shell for approved MCP contribution notifications */
  prApprovedBanner?: PRApprovedBannerProps | null;
  /** Optional post-startup notice rendered above the Home header. */
  startupNotice?: ReactNode;
  /** Current settings, used for first-run activation status. */
  settings: AppSettings | null;
  /** Persist settings mutations from the first-run activation pass. */
  saveSettingsWith: SaveSettingsWith;
  /** Demo mode state from the app shell; Home feeds decide their own data source. */
  isDemoMode?: boolean;
}

function getTimeOfDayBucket(): 'morning' | 'afternoon' | 'evening' {
  const hour = new Date().getHours();
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

function getGreeting(name: string | null | undefined, _bucket: string): string {
  return getSharedGreeting(name ?? undefined);
}

function getSubtext(state: HomepageUserState): string {
  switch (state.kind) {
    case 'new-loading':
      return 'Getting things ready — one moment.';
    case 'new-no-data':
      return 'Nothing on the radar yet. Where shall we start?';
    case 'new-no-connectors':
      return 'Let\'s get you set up. What can I help with?';
    case 'established-daily':
      return 'Here\'s your check-in for today.';
    case 'returning-after-idle':
      return 'Welcome back — here\'s what you missed.';
  }
}

export function HomepagePanel({
  onSubmitMessage,
  onNavigateToSessions,
  onStartMeetingPrep,
  coachingSessionIds,
  onCoachingDismiss,
  onOpenFile,
  onOpenSession,
  connectedConnectorCount = 0,
  userAddedConnectorCount = 0,
  connectorActionAvailability,
  sessionCount = 0,
  isReturningFromIdle = false,
  onNavigateToConnectors,
  onNavigateToInbox,
  onboardingActivationIncomplete,
  hasAvailableOnboardingCoachSession,
  onStartOnboardingIntro,
  userFirstName,
  onOpenTimeSaved,
  focusEnabled,
  onEnableFocus,
  prApprovedBanner,
  startupNotice,
  settings,
  saveSettingsWith,
}: HomepagePanelProps) {
  const navigation = useNavigationSafe();
  // Mention props from context (eliminates prop drilling from App.tsx)
  const {
    mentionResultsForQuery,
    ensureLibraryIndex,
    getRelativeLibraryPath,
    hasWorkspace,
    hasConversations,
    coreDirectory,
    libraryIndex,
    libraryIndexLoading,
    libraryIndexError,
    refreshLibraryIndex,
  } = useMentionContext();
  // Gate data fetching by surface visibility — when the user is on another tab
  // (e.g. typing in sessions), these polling hooks are completely paused.
  const { activeSurface } = useFlowPanels();
  const isHomeActive = activeSurface === 'home';

  // Single source of meeting + inbox data for the entire homepage surface.
  // Previously, useHomepageState and useTodayStream each called useMeetingCache
  // independently, creating duplicate polling intervals.
  const liveFeedsEnabled = isHomeActive;
  const rawMeetingCache = useMeetingCache(true, liveFeedsEnabled);
  const rawInboxResult = useHomepageInboxItems(liveFeedsEnabled);
  const meetingCache = rawMeetingCache;
  const inboxResult = rawInboxResult;

  useFirstRunActionsPass({
    settings,
    saveSettingsWith,
    enabled: liveFeedsEnabled,
    connectedConnectorCount,
    connectorActionAvailability,
    meetingCache,
    inboxResult,
  });

  // Items that belong in Coach, not Today. Two sources:
  // 1. Insight/coach-redirect prefixes (win:, learning:, summary:, context:, etc.)
  // 2. FYI-tier items (explicit FYI title patterns like "fyi:", "heads up:", etc.)
  // Note: important=false alone does NOT route to Coach — low-importance action
  // items stay in Today as Review tier. Only content-based FYI signals trigger Coach routing.
  const insightInboxItems = useMemo(() => {
    return inboxResult.items.filter(item => {
      if (item.archived || item.autoCompleted || item.executingSessionId) return false;
      if (shouldRedirectToCoach(item.title)) return true;
      return classifyInboxTier(item) === 'fyi';
    });
  }, [inboxResult.items]);

  const userState = useHomepageState({
    connectedConnectorCount,
    sessionCount,
    isReturningFromIdle,
    meetingsLoading: meetingCache.isLoading,
    hasMeetings: meetingCache.meetings.length > 0,
  });

  // Re-derive greeting when the time-of-day bucket changes (morning/afternoon/evening)
  const [timeOfDayBucket, setTimeOfDayBucket] = useState(getTimeOfDayBucket);
  useEffect(() => {
    const id = setInterval(() => {
      setTimeOfDayBucket((prev) => {
        const next = getTimeOfDayBucket();
        return next !== prev ? next : prev;
      });
    }, 60_000); // check every minute
    return () => clearInterval(id);
  }, []);

  const greeting = useMemo(() => getGreeting(userFirstName, timeOfDayBucket), [userFirstName, timeOfDayBucket]);
  const subtext = getSubtext(userState);

  const timeSavedData = useTimeSavedData();
  const timeSavedDisplay = timeSavedData ? formatTimeSavedCompact(timeSavedData.totalMinutes) : null;
  const handleStartOnboardingIntro = useCallback(() => {
    tracking.homepage.todayOnboardingContinueClicked();
    onStartOnboardingIntro?.();
  }, [onStartOnboardingIntro]);

  // Track page view once when the homepage mounts (or user state stabilises)
  const hasTrackedView = useRef(false);
  useEffect(() => {
    if (userState.kind === 'new-loading' || hasTrackedView.current) return;
    hasTrackedView.current = true;
    tracking.homepage.viewed(userState.kind, connectedConnectorCount, sessionCount);
  }, [userState.kind, connectedConnectorCount, sessionCount]);

  const efficiencyOffer = useEfficiencyModeOffer({ settings, saveSettingsWith });

  return (
    <div className={styles.container} data-testid="homepage-panel">
      {prApprovedBanner && <PRApprovedBanner {...prApprovedBanner} />}
      {startupNotice}
      {efficiencyOffer.showOffer && (
        <EfficiencyModeOfferCard
          onEnable={efficiencyOffer.handleEnable}
          onDismiss={efficiencyOffer.handleDismiss}
        />
      )}
      <PageHeader
        title={greeting}
        subtitle={subtext}
        meta={timeSavedDisplay && (
          <span className={styles.timeSavedText}>
            Rebel saved you
            <button
              type="button"
              className={styles.timeSavedPill}
              onClick={onOpenTimeSaved}
              aria-label={`View time saved details: ${timeSavedDisplay}`}
            >
              <Timer size={10} className={styles.timeSavedIcon} />
              {timeSavedDisplay}
            </button>
            this week!
          </span>
        )}
      />

      <DailySparkSlot />

      {/* Hero Chat Input + Recent Conversation Pills */}
      <HomepageChat
        onSubmit={onSubmitMessage}
        onNavigateToSessions={onNavigateToSessions}
        onOpenSession={onOpenSession}
        mentionResultsForQuery={mentionResultsForQuery}
        ensureLibraryIndex={ensureLibraryIndex}
        getRelativeLibraryPath={getRelativeLibraryPath}
        hasWorkspace={hasWorkspace}
        hasConversations={hasConversations}
        coreDirectory={coreDirectory}
        libraryIndex={libraryIndex}
        libraryIndexLoading={libraryIndexLoading}
        libraryIndexError={libraryIndexError}
        refreshLibraryIndex={refreshLibraryIndex}
      />

      {/* Plugin homepage widgets — renders only when plugins declare homepageWidget surface */}
      <PluginWidgetSection />

      {/* Horizontal divider between chat input and content columns */}
      <hr className={styles.horizontalDivider} />

      {/* Two-column: Today (60%) + Coach (40%) */}
      <div className={styles.contentRow}>
        <div className={styles.todayColumn}>
          <TodaySection
            userState={userState}
            onStartMeetingPrep={onStartMeetingPrep}
            onOpenSession={onOpenSession}
            onOpenFile={onOpenFile}
            onNavigateToInbox={onNavigateToInbox}
            onNavigateToTeam={(target) => {
              fireAndForget(navigation?.navigate(target), 'navigateToTeam');
            }}
            connectedConnectorCount={connectedConnectorCount}
            userAddedConnectorCount={userAddedConnectorCount}
            connectorActionAvailability={connectorActionAvailability}
            onNavigateToConnectors={onNavigateToConnectors}
            onboardingActivationIncomplete={onboardingActivationIncomplete}
            hasAvailableOnboardingCoachSession={hasAvailableOnboardingCoachSession}
            onStartOnboardingIntro={handleStartOnboardingIntro}
            meetingCache={meetingCache}
            inboxResult={inboxResult}
            firstRunActionsPass={settings?.firstRunActionsPass}
            enabled={liveFeedsEnabled}
            focusEnabled={focusEnabled}
            onEnableFocus={onEnableFocus}
          />
        </div>
        <div className={styles.coachColumn}>
          <div className={styles.coachColumnInner}>
            <CoachSection
              userState={userState}
              coachingSessionIds={coachingSessionIds}
              onAct={onSubmitMessage}
              onDismiss={onCoachingDismiss}
              onOpenSession={onOpenSession}
              insightInboxItems={insightInboxItems}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
