import { Fragment, useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Tooltip, Tabs, TabsList, TabsTrigger, TabsContent } from '@renderer/components/ui';
import {
  FolderOpen,
  Plug,
  Bot,
  Calendar,
  BarChart3,
  User,
  ChevronDown,
  ChevronRight,
  Wrench,
  ShieldCheck,
  AlertTriangle,
} from 'lucide-react';
import styles from './SettingsSurface.module.css';
import { useSettings } from '../SettingsProvider';
import { ToolsTab, AgentsTab, VoiceTab, UsageTab } from './tabs';
import { useScrollToSection } from '../hooks/useScrollToSection';
import { SettingsSearch } from './SettingsSearch';
import { tracking } from '@renderer/src/tracking';
import type { SettingsSaveStatus } from '../hooks/useSettingsFeature';
import type { SetupWithRebelParams } from './tabs/types';
import { getWorkingModelProfile } from '@shared/types';
import {
  getSettingsDestinationForLeafTab,
  resolveSettingsNavigation,
  resolveSettingsSectionForScroll,
  type SettingsDestinationId,
} from '@shared/navigation/settingsNavigationContract';
import { resolveSettingsTabId, type SettingsTabId } from '@shared/navigation/types';
import {
  SettingsWorkspaceDestination,
  SettingsAccountPreferencesDestination,
  SettingsPrivacySafetyDestination,
  SettingsAdvancedDestination,
  SettingsMeetingsDestination,
} from './SettingsDestinationViews';
import {
  getSettingsOnPageAnchors,
} from './settingsOnPageAnchorConfig';
import { useSettingsOnPageNavigation } from '../hooks/useSettingsOnPageNavigation';

export type SettingsSurfaceProps = {
  onClose: () => void;
  onSave: () => void;
  onRelaunchOnboarding: () => void;
  onResetOnboardingChecklist: () => void;
  onConfigureWithRebel?: (params: SetupWithRebelParams) => void | Promise<void>;
  onBuildConnector?: (searchQuery?: string) => void | Promise<void>;
  onExtendConnector?: (connectorId: string, connectorName: string) => void | Promise<void>;
  onShareWithCommunity?: (connectorName: string) => void | Promise<void>;
  /** Open the originating contribution conversation for a connector. */
  onOpenContributionChat?: (sessionId: string) => void | Promise<void>;
  onGetPythonHelp?: (connectorName: string) => void;
  onRequestConnector?: () => void;
  onChatAboutSafety?: () => void;
  /**
   * True when the `mcpRuntimeHealth` system-health check is in warn/fail state.
   * Used to render the Tools tab manager-status banner. Sourced from the same
   * `useHealthStatusPolling` cache that drives the HelpMenu glow.
   */
  mcpRuntimeHealthDegraded?: boolean;
};

const CheckIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M13.5 4.5L6.5 11.5L3 8"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const SpinnerIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M8 2V4M8 12V14M3.05 5L4.76 6.21M11.24 9.79L12.95 11M2 8H4M12 8H14M3.05 11L4.76 9.79M11.24 6.21L12.95 5"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
);

const AlertIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
    <path d="M8 5V8.5M8 10.5V11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

type SaveStatusToastProps = {
  status: SettingsSaveStatus;
};

const SaveStatusToast = ({ status }: SaveStatusToastProps) => {
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const previousStatusRef = useRef(status);

  useEffect(() => {
    const wasIdle = previousStatusRef.current === 'idle';
    const isActive = status !== 'idle';

    if (isActive && (wasIdle || status !== previousStatusRef.current)) {
      setExiting(false);
      setVisible(true);
    }

    if (status === 'idle' && previousStatusRef.current !== 'idle') {
      setExiting(true);
      const timer = setTimeout(() => {
        setVisible(false);
        setExiting(false);
      }, 200);
      return () => clearTimeout(timer);
    }

    previousStatusRef.current = status;
  }, [status]);

  if (!visible) return null;

  const isError = status === 'error';
  const isSaving = status === 'saving';

  return (
    <div className={styles.saveToastContainer} data-testid="settings-save-toast">
      <div className={`${styles.saveToast} ${exiting ? styles.saveToastExiting : ''}`}>
        <span className={styles.saveToastIcon}>
          {isSaving && (
            <span className={styles.saveToastIconSpinner}>
              <SpinnerIcon />
            </span>
          )}
          {status === 'saved' && (
            <span className={styles.saveToastIconCheck}>
              <CheckIcon />
            </span>
          )}
          {isError && (
            <span className={styles.saveToastIconError}>
              <AlertIcon />
            </span>
          )}
        </span>
        <span className={isError ? styles.saveToastTextError : styles.saveToastText}>
          {isSaving && 'Saving...'}
          {status === 'saved' && 'Saved'}
          {isError && 'Save failed'}
        </span>
      </div>
    </div>
  );
};

type SidebarRow = {
  destination: SettingsDestinationId;
  label: string;
  icon: typeof Plug;
  description: string;
  testId: string;
  defaultLeaf: SettingsTabId;
};

const SIDEBAR_GROUPS: SidebarRow[][] = [
  [
    {
      destination: 'connectors',
      label: 'Connectors',
      icon: Plug,
      description: 'Connect to Gmail, Slack, Calendar, and 50+ tools',
      testId: 'settings-tab-connectors',
      defaultLeaf: 'tools',
    },
    {
      destination: 'agent_voice',
      label: 'Agent & Voice',
      icon: Bot,
      description: 'Models, keys, and voice input',
      testId: 'settings-destination-agent-voice',
      defaultLeaf: 'agents',
    },
    {
      destination: 'privacy_safety',
      label: 'Privacy & Safety',
      icon: ShieldCheck,
      description: 'What Rebel can do, your safety rules, and how your data is handled',
      testId: 'settings-destination-privacy-safety',
      defaultLeaf: 'safety',
    },
  ],
  [
    {
      destination: 'meetings',
      label: 'Meetings',
      icon: Calendar,
      description: 'Meeting capture and transcript storage',
      testId: 'settings-tab-meetings',
      defaultLeaf: 'meetings',
    },
  ],
  [
    {
      destination: 'workspace',
      label: 'Workspace',
      icon: FolderOpen,
      description: 'Library folder, spaces, scratchpad, continuity, and messaging',
      testId: 'settings-destination-workspace',
      defaultLeaf: 'spaces',
    },
    {
      destination: 'account_preferences',
      label: 'Account & Preferences',
      icon: User,
      description: 'Profile, appearance, and notifications',
      testId: 'settings-destination-account-preferences',
      defaultLeaf: 'account',
    },
  ],
  [
    {
      destination: 'usage',
      label: 'Usage',
      icon: BarChart3,
      description: 'Usage tracking and cost breakdowns',
      testId: 'settings-tab-usage',
      defaultLeaf: 'usage',
    },
  ],
  [
    {
      destination: 'advanced',
      label: 'Advanced',
      icon: Wrench,
      description: 'Diagnostics, updates, labs, and developer tools',
      testId: 'settings-destination-advanced',
      defaultLeaf: 'diagnostics',
    },
  ],
];

export const SettingsSurface = ({
  onClose: _onClose,
  onSave: _onSave,
  onRelaunchOnboarding,
  onResetOnboardingChecklist,
  onConfigureWithRebel,
  onBuildConnector,
  onExtendConnector,
  onShareWithCommunity,
  onOpenContributionChat,
  onGetPythonHelp,
  onRequestConnector,
  onChatAboutSafety,
  mcpRuntimeHealthDegraded = false,
}: SettingsSurfaceProps) => {
  const {
    settingsOpen: isOpen,
    settingsMigrationDegraded,
    activeTab,
    setActiveTab,
    setSettingsLeafTab,
    targetSection,
    clearTargetSection,
    consumePendingSettingsNavigationInteraction,
    consumePendingOpenResolutionMeta,
    draftSettings,
    saveStatus,
    updateDraft,
    updateClaude,
    updateVoice,
    markKeySticky,
    chooseDirectory,
    chooseMcpFile,
    mcpSummary,
    mcpSummaryLoading,
    mcpSummaryError,
    mcpHealthLoading,
    mcpMutationPending,
    refreshMcpSummary,
    reloadConnectors,
    upsertMcpServer,
    removeMcpServer,
    loadMcpServer,
  } = useSettings();

  const [searchTargetSection, setSearchTargetSection] = useState<string | undefined>(undefined);
  const [connectorScrollPendingId, setConnectorScrollPendingId] = useState<string | undefined>(undefined);
  const [searchMatchedDestinations, setSearchMatchedDestinations] = useState<Set<SettingsDestinationId> | null>(null);
  const sectionToScroll = searchTargetSection ?? targetSection;
  const baseScrollSectionId = resolveSettingsSectionForScroll(activeTab as SettingsTabId, sectionToScroll);
  const isConnectorDeepLink =
    typeof sectionToScroll === 'string' &&
    sectionToScroll.startsWith('connector-') &&
    activeTab === 'tools';
  const scrollSectionForHook = isConnectorDeepLink ? connectorScrollPendingId : baseScrollSectionId;
  const developerModeEnabled = draftSettings?.diagnostics?.developerMode ?? false;
  const prevDestinationRef = useRef<SettingsDestinationId | null>(null);

  useEffect(() => {
    if (!isConnectorDeepLink) {
      setConnectorScrollPendingId(undefined);
    }
  }, [isConnectorDeepLink]);

  const handleConnectorRevealReady = useCallback(
    (sectionId: string | null) => {
      if (sectionId) {
        setConnectorScrollPendingId(sectionId);
      } else {
        clearTargetSection();
        setSearchTargetSection(undefined);
      }
    },
    [clearTargetSection],
  );

  const handleScrollComplete = useCallback(() => {
    clearTargetSection();
    setSearchTargetSection(undefined);
    setConnectorScrollPendingId(undefined);
  }, [clearTargetSection]);

  useScrollToSection(scrollSectionForHook, handleScrollComplete, [activeTab]);

  useEffect(() => {
    if (!draftSettings) return;
    if (activeTab === 'developer' && !developerModeEnabled) {
      setActiveTab('diagnostics');
    }
  }, [activeTab, developerModeEnabled, draftSettings, setActiveTab]);

  const activeDestination = getSettingsDestinationForLeafTab(activeTab as SettingsTabId);
  const onPageAnchors = useMemo(
    () => getSettingsOnPageAnchors(activeDestination, { developerModeEnabled }),
    [activeDestination, developerModeEnabled],
  );
  const advancedExpanded = activeDestination === 'advanced';

  useEffect(() => {
    if (!isOpen) {
      prevDestinationRef.current = null;
      return;
    }
    if (!draftSettings) return;

    const dest = getSettingsDestinationForLeafTab(activeTab as SettingsTabId);
    const prev = prevDestinationRef.current;

    if (prev !== dest) {
      const interaction = consumePendingSettingsNavigationInteraction() ?? 'programmatic';
      const meta = consumePendingOpenResolutionMeta();
      tracking.settings.destinationSwitched({
        destination: dest,
        interactionType: interaction,
        leafTab: activeTab,
        section: sectionToScroll,
        redirectedFrom: meta?.redirectedFrom
          ? { tab: meta.redirectedFrom.tab, section: meta.redirectedFrom.section }
          : undefined,
      });
      prevDestinationRef.current = dest;
    } else {
      consumePendingSettingsNavigationInteraction();
      consumePendingOpenResolutionMeta();
    }
  }, [
    isOpen,
    activeTab,
    draftSettings,
    sectionToScroll,
    consumePendingSettingsNavigationInteraction,
    consumePendingOpenResolutionMeta,
  ]);

  const handleLeafTabSwitch = useCallback(
    (newTab: SettingsTabId) => {
      if (newTab !== activeTab) {
        tracking.settings.tabSwitched(newTab, activeTab);
      }
      setActiveTab(newTab);
    },
    [activeTab, setActiveTab],
  );

  const handleSearchMatchesChange = useCallback((destinations: string[] | null) => {
    if (!destinations || destinations.length === 0) {
      setSearchMatchedDestinations(null);
      return;
    }
    setSearchMatchedDestinations(new Set(destinations as SettingsDestinationId[]));
  }, []);

  const handleSearchNavigate = useCallback(
    (tab: string, section?: string) => {
      const resolved = resolveSettingsNavigation(
        {
          tab: resolveSettingsTabId(tab),
          section,
        },
        { developerModeEnabled },
      );
      setSettingsLeafTab(resolved.leafTab, 'search');
      setSearchTargetSection(resolved.section);
    },
    [developerModeEnabled, setSettingsLeafTab],
  );

  const {
    activeAnchorId,
    beginExplicitJump,
  } = useSettingsOnPageNavigation({
    destination: activeDestination,
    activeLeafTab: activeTab as SettingsTabId,
    anchors: onPageAnchors,
    incomingSection: scrollSectionForHook,
  });

  const handleOnPageAnchorSelect = useCallback(
    (anchorId: string) => {
      const anchor = onPageAnchors.find((candidate) => candidate.anchorId === anchorId);
      if (!anchor) {
        return;
      }
      beginExplicitJump(anchor.anchorId);
      setSearchTargetSection(anchor.scrollTarget);
    },
    [beginExplicitJump, onPageAnchors],
  );

  const selectDestination = useCallback(
    (row: SidebarRow) => {
      if (activeDestination === row.destination) {
        return;
      }
      setSettingsLeafTab(row.defaultLeaf, 'sidebar');
    },
    [activeDestination, setSettingsLeafTab],
  );

  const getDestinationRowClassName = useCallback(
    (destination: SettingsDestinationId) => {
      const isActive = activeDestination === destination;
      return `${styles.sidebarItem} ${isActive ? styles.sidebarItemActive : ''}`;
    },
    [activeDestination],
  );

  const getDestinationRowStyle = useCallback(
    (destination: SettingsDestinationId) => {
      if (!searchMatchedDestinations || activeDestination === destination) {
        return undefined;
      }
      if (searchMatchedDestinations.has(destination)) {
        return {
          background: 'rgba(99, 102, 241, 0.08)',
          color: 'var(--color-text-primary)',
        };
      }
      return { opacity: 0.45 };
    },
    [activeDestination, searchMatchedDestinations],
  );

  if (!isOpen) return null;

  if (!draftSettings) {
    return (
      <div className={styles.surface} role="region" aria-live="polite">
        <div className={`${styles.panel} ${styles.panelLoading}`}>
          <span className={styles.panelLoadingLabel}>Loading settings…</span>
        </div>
      </div>
    );
  }

  const isUsingAlternativeModel = !!getWorkingModelProfile(draftSettings);
  const modelSettings = draftSettings.models;
  const needsApiKey =
    !modelSettings?.apiKey && !modelSettings?.oauthToken && !draftSettings.openRouter?.oauthToken && !isUsingAlternativeModel;
  const cloudMode = draftSettings.cloudInstance?.mode ?? 'local';
  const cloudStatus = draftSettings.cloudInstance?.lastKnownStatus;
  const hasCloudIssue =
    cloudMode === 'cloud' &&
    (!draftSettings.cloudInstance?.cloudUrl ||
      cloudStatus === 'error' ||
      cloudStatus === 'cold');

  const agentVoicePillValue = activeTab === 'voice' ? 'voice' : 'agents';

  const renderMainContent = () => {
    switch (activeDestination) {
      case 'agent_voice':
        return (
          <>
            <Tabs
              value={agentVoicePillValue}
              onValueChange={(v) => handleLeafTabSwitch(v === 'voice' ? 'voice' : 'agents')}
              className={styles.agentVoiceTabs}
            >
              <div className={styles.pageChrome}>
                <header className={styles.pageHeader}>
                  <h2 className={styles.pageTitle}>Agent &amp; Voice</h2>
                  <p className={styles.pageDescription}>How Rebel thinks, speaks, and listens.</p>
                </header>
              </div>
              <TabsList
                variant="pills"
                aria-label="Agent and voice sections"
                className={`${styles.settingsAnchorStrip} ${styles.agentVoiceTabsList}`}
              >
                <TabsTrigger value="agents" className={styles.agentVoiceTab}>
                  Agent
                </TabsTrigger>
                <TabsTrigger value="voice" className={styles.agentVoiceTab}>
                  Voice
                </TabsTrigger>
              </TabsList>
              <TabsContent value="agents" className={styles.agentVoiceTabPanel}>
                <AgentsTab draftSettings={draftSettings} updateDraft={updateDraft} updateClaude={updateClaude} updateVoice={updateVoice} markKeySticky={markKeySticky} />
              </TabsContent>
              <TabsContent value="voice" className={styles.agentVoiceTabPanel}>
                <VoiceTab draftSettings={draftSettings} updateDraft={updateDraft} updateVoice={updateVoice} />
              </TabsContent>
            </Tabs>
          </>
        );
      case 'connectors':
        return (
          <ToolsTab
            draftSettings={draftSettings}
            updateDraft={updateDraft}
            mcpSummary={mcpSummary}
            mcpSummaryLoading={mcpSummaryLoading}
            mcpSummaryError={mcpSummaryError}
            mcpHealthLoading={mcpHealthLoading}
            mcpMutationPending={mcpMutationPending}
            refreshMcpSummary={refreshMcpSummary}
            reloadConnectors={reloadConnectors}
            upsertMcpServer={upsertMcpServer}
            removeMcpServer={removeMcpServer}
            loadMcpServer={loadMcpServer}
            chooseMcpFile={chooseMcpFile}
            onNavigateToDiagnostics={() => setSettingsLeafTab('diagnostics', 'sidebar')}
            mcpRuntimeHealthDegraded={mcpRuntimeHealthDegraded}
            onConfigureWithRebel={onConfigureWithRebel}
            onBuildConnector={onBuildConnector}
            onExtendConnector={onExtendConnector}
            onShareWithCommunity={onShareWithCommunity}
            onOpenContributionChat={onOpenContributionChat}
            onGetPythonHelp={onGetPythonHelp}
            onRequestConnector={onRequestConnector}
            connectorRevealTarget={isConnectorDeepLink ? sectionToScroll : undefined}
            onConnectorRevealReady={handleConnectorRevealReady}
          />
        );
      case 'meetings':
        return <SettingsMeetingsDestination draftSettings={draftSettings} updateDraft={updateDraft} />;
      case 'workspace':
        return (
          <SettingsWorkspaceDestination
            draftSettings={draftSettings}
            updateDraft={updateDraft}
            chooseDirectory={chooseDirectory}
            anchors={onPageAnchors}
            activeAnchorId={activeAnchorId}
            onSelectAnchor={handleOnPageAnchorSelect}
          />
        );
      case 'privacy_safety':
        return (
          <SettingsPrivacySafetyDestination
            draftSettings={draftSettings}
            updateDraft={updateDraft}
            anchors={onPageAnchors}
            activeAnchorId={activeAnchorId}
            onSelectAnchor={handleOnPageAnchorSelect}
            onChatAboutSafety={onChatAboutSafety}
          />
        );
      case 'account_preferences':
        return (
          <SettingsAccountPreferencesDestination
            draftSettings={draftSettings}
            updateDraft={updateDraft}
            anchors={onPageAnchors}
            activeAnchorId={activeAnchorId}
            onSelectAnchor={handleOnPageAnchorSelect}
          />
        );
      case 'usage':
        return (
          <>
            <div className={styles.pageChrome}>
              <header className={styles.pageHeader}>
                <h2 className={styles.pageTitle}>Usage</h2>
                <p className={styles.pageDescription}>See what Rebel spent, where it went, and whether anything looks off.</p>
              </header>
            </div>
            <UsageTab />
          </>
        );
      case 'advanced':
        return (
          <SettingsAdvancedDestination
            draftSettings={draftSettings}
            updateDraft={updateDraft}
            developerModeEnabled={developerModeEnabled}
            anchors={onPageAnchors}
            activeAnchorId={activeAnchorId}
            onSelectAnchor={handleOnPageAnchorSelect}
            onRelaunchOnboarding={onRelaunchOnboarding}
            onResetOnboardingChecklist={onResetOnboardingChecklist}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className={styles.surface} role="region" aria-label="Settings" data-testid="settings-panel">
      <div className={styles.settingsLayout}>
        <nav className={styles.settingsSidebar} aria-label="Settings destinations">
          <div className={styles.sidebarContent}>
            <SettingsSearch
              onNavigate={handleSearchNavigate}
              onMatchesChange={handleSearchMatchesChange}
              hiddenTabs={developerModeEnabled ? undefined : ['developer']}
            />

            {SIDEBAR_GROUPS.map((group, groupIndex) => (
              <Fragment key={groupIndex}>
                {groupIndex > 0 && <div className={styles.sidebarDivider} />}
                {group.map((row) => {
                  const Icon = row.icon;
                  const isAdvancedRow = row.destination === 'advanced';
                  return (
                    <Tooltip key={row.destination} content={row.description} placement="right" delayShow={400}>
                      <button
                        type="button"
                        className={getDestinationRowClassName(row.destination)}
                        style={getDestinationRowStyle(row.destination)}
                        onClick={() => selectDestination(row)}
                        data-testid={row.testId}
                        aria-current={activeDestination === row.destination ? 'page' : undefined}
                      >
                        <Icon className={styles.sidebarIcon} size={18} />
                        <span className={styles.sidebarLabel}>{row.label}</span>
                        {row.destination === 'agent_voice' && needsApiKey && (
                          <span className={styles.sidebarIssueHint}>Needs setup</span>
                        )}
                        {row.destination === 'workspace' && hasCloudIssue && (
                          <span className={styles.sidebarIssueHint}>Needs attention</span>
                        )}
                        {isAdvancedRow &&
                          (advancedExpanded ? (
                            <ChevronDown size={16} className={styles.sidebarIcon} aria-hidden />
                          ) : (
                            <ChevronRight size={16} className={styles.sidebarIcon} aria-hidden />
                          ))}
                      </button>
                    </Tooltip>
                  );
                })}
              </Fragment>
            ))}
          </div>
        </nav>

        <div className={styles.settingsContent} data-settings-scroll-root>
          <div className={styles.settingsScrollRoot}>
            <div className={styles.panel}>
              {settingsMigrationDegraded && (
                <div
                  className={`${styles.warningBanner} ${styles.warningBannerDegraded}`}
                  role="status"
                  aria-live="polite"
                  data-testid="settings-models-migration-degraded-banner"
                >
                  <AlertTriangle size={16} className={styles.warningBannerIcon} aria-hidden />
                  <div className={styles.warningBannerContent}>
                    <p className={styles.warningBannerTitle}>Model settings need review</p>
                    <p className={styles.warningBannerText}>
                      Rebel couldn&apos;t fully migrate your model settings. Quit Rebel, fix or remove the legacy
                      <code> claude </code>
                      block in your settings file, then restart and review your model settings.
                    </p>
                  </div>
                </div>
              )}
              <div key={`${activeDestination}-${activeTab}`} className={styles.tabContent}>
                {renderMainContent()}
              </div>

              <div className={styles.panelActions}>
                <SaveStatusToast status={saveStatus} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
