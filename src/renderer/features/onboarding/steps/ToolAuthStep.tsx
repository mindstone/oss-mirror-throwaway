import React, { useCallback, useMemo } from 'react';
import { AlertCircle, Briefcase, Calendar, Check, Info, Loader2, Mail } from 'lucide-react';
import { Tooltip } from '@renderer/components/ui';
import { useSettings } from '@renderer/features/settings/SettingsProvider';
import { useUnifiedConnections, matchesConnectorSearch, type UnifiedConnection } from '@renderer/features/settings/hooks/useUnifiedConnections';
import {
  CONNECTOR_CATEGORY_ORDER,
  CATEGORY_LABELS,
  type ConnectorCategory,
} from '@renderer/features/settings/constants/connectorCategories';
import { getConnectorIcon } from '@renderer/features/settings/utils/connectorIcons';
import { ExpandedConnectionCard } from '@renderer/features/settings/components/ExpandedConnectionCard';
import { createUntrackedConnectionCardOps } from '@renderer/features/settings/components/useConnectionCardOps';
import { ConnectorSetupDialog } from '@renderer/features/settings/components/ConnectorSetupDialog';
import { useConnectorSetupGuidance, type MaybeSetupGuidanceResult } from '@renderer/features/settings/hooks/useConnectorSetupGuidance';
import type { McpServerPreview } from '@shared/types';
import { isBundledLikeProvider } from '@shared/types';
import styles from '../OnboardingWizard.module.css';
import type { ToolAuthStepProps } from './types';
import type { ToolAuthState, ToolType } from '../hooks/useOnboardingFlow';
import {
  isAwaitingOrVerifyingStatus,
  isCategoryActiveStatus,
  isConnectedStatus,
  isConnectorSetupClickableStatus,
  isErrorStatus,
  isGeneratingStatus,
  isPendingStatus,
  isPollingStatus,
  isReadyToConnectStatus,
} from '../hooks/toolAuthMachine';

interface ExistingProviderOption {
  kind: 'existing';
  value: ToolType;
  label: string;
  connectorId: string;
  required?: boolean;
  accountFamily?: 'google' | 'microsoft';
}

interface CatalogProviderOption {
  kind: 'catalog';
  connectorId: string;
  label: string;
}

type ProviderOption = ExistingProviderOption | CatalogProviderOption;

interface CategoryConfig {
  id: string;
  title: string;
  description: string;
  headerIcon: typeof Mail;
  providers: ProviderOption[];
}

type CategoryCardState = 'idle' | 'loading' | 'awaiting' | 'connected' | 'error';

const CORE_CONNECTOR_IDS = new Set([
  'bundled-google',
  'bundled-microsoft-mail',
  'bundled-microsoft-calendar',
  'bundled-slack',
  'bundled-microsoft-teams',
  'asana',
  'notion',
  'atlassian',
  'canva',
  'bundled-hubspot',
  'miro',
]);

const CATEGORY_CONFIGS: CategoryConfig[] = [
  {
    id: 'messages',
    title: 'Stay on top of emails & messages',
    description: 'Rebel reads your inbox, drafts replies, and surfaces what actually needs your attention.',
    headerIcon: Mail,
    providers: [
      {
        kind: 'existing',
        value: 'gmail',
        label: 'Gmail',
        connectorId: 'bundled-google',
        required: true,
        accountFamily: 'google',
      },
      {
        kind: 'existing',
        value: 'outlook-mail',
        label: 'Outlook Mail',
        connectorId: 'bundled-microsoft-mail',
        required: true,
        accountFamily: 'microsoft',
      },
      {
        kind: 'existing',
        value: 'slack',
        label: 'Slack',
        connectorId: 'bundled-slack',
      },
      {
        kind: 'existing',
        value: 'teams',
        label: 'Microsoft Teams',
        connectorId: 'bundled-microsoft-teams',
      },
    ],
  },
  {
    id: 'meetings',
    title: 'Never miss a meeting',
    description: 'Rebel preps you before meetings, pulls in relevant context, and makes sure you walk in ready.',
    headerIcon: Calendar,
    providers: [
      {
        kind: 'existing',
        value: 'google-calendar',
        label: 'Google Calendar',
        connectorId: 'bundled-google',
        accountFamily: 'google',
      },
      {
        kind: 'existing',
        value: 'outlook-calendar',
        label: 'Outlook Calendar',
        connectorId: 'bundled-microsoft-calendar',
        accountFamily: 'microsoft',
      },
    ],
  },
  {
    id: 'work',
    title: 'Your work, connected',
    description: 'Rebel works across your projects, docs, and tasks - so your context is always in one place.',
    headerIcon: Briefcase,
    providers: [
      { kind: 'catalog', connectorId: 'asana', label: 'Asana' },
      { kind: 'catalog', connectorId: 'notion', label: 'Notion' },
      { kind: 'catalog', connectorId: 'atlassian', label: 'Atlassian / Jira' },
      { kind: 'catalog', connectorId: 'canva', label: 'Canva' },
      { kind: 'catalog', connectorId: 'bundled-hubspot', label: 'HubSpot' },
      { kind: 'catalog', connectorId: 'miro', label: 'Miro' },
    ],
  },
];

const isExistingProvider = (provider: ProviderOption): provider is ExistingProviderOption => provider.kind === 'existing';

const hasSensitiveSetupFields = (connection: UnifiedConnection): boolean => {
  return (
    connection.catalogEntry?.setupFields?.some((field) => {
      return field.type === 'password' || /api[_-]?key|secret|password/i.test(field.id);
    }) ?? false
  );
};

const supportsInlineConnect = (connection: UnifiedConnection): boolean => {
  const entry = connection.catalogEntry;
  if (
    !entry ||
    entry.isInternal ||
    entry.requiresDesktopApp ||
    entry.requiresSetup ||
    hasSensitiveSetupFields(connection)
  ) {
    return false;
  }

  if (isBundledLikeProvider(entry.provider)) {
    return entry.bundledConfig?.authType === 'oauth';
  }

  return Boolean(entry.mcpConfig?.oauth);
};

/** Auth IPC result that may carry structured OAuth setup guidance on the not-configured path. */
type AuthResult = MaybeSetupGuidanceResult & { success: boolean; error?: string };

export const ToolAuthStep = ({
  state,
  actions,
  draftSettings,
  renderToolStatus,
}: ToolAuthStepProps) => {
  const { toolAuthStates, toolAuthReady, triedContinue, canSkipToolAuth } = state;
  const { mcpSummary, refreshMcpSummary, upsertMcpServer, removeMcpServer } = useSettings();
  const connectionCardOps = useMemo(() => createUntrackedConnectionCardOps(
    'onboarding has no queued-state UI',
    {
      addBundledServer: (payload) => window.settingsApi.mcpAddBundledServer(payload),
      upsertServer: (payload) => upsertMcpServer(payload),
      removeServer: (serverName) => removeMcpServer(serverName),
      toggleServerEnabled: (serverId) => window.settingsApi.mcpToggleServerEnabled({ serverId }),
    },
  ), [removeMcpServer, upsertMcpServer]);
  const setupGuidanceDialog = useConnectorSetupGuidance();
  const [now, setNow] = React.useState(() => Date.now());
  const [connectingCatalogId, setConnectingCatalogId] = React.useState<string | null>(null);
  const [catalogErrors, setCatalogErrors] = React.useState<Record<string, string>>({});
  const [moreToolsSearch, setMoreToolsSearch] = React.useState('');
  const [expandedConnectorId, setExpandedConnectorId] = React.useState<string | null>(null);
  const [connectingCardId, setConnectingCardId] = React.useState<string | null>(null);
  const [removingCardId, setRemovingCardId] = React.useState<string | null>(null);

  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  React.useEffect(() => {
    void refreshMcpSummary();
  }, [refreshMcpSummary]);

  React.useEffect(() => {
    const handleFocus = () => {
      void refreshMcpSummary();
    };
    const handleVisibility = () => {
      if (!document.hidden) {
        void refreshMcpSummary();
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [refreshMcpSummary]);

  const allServers = React.useMemo((): McpServerPreview[] => {
    if (!mcpSummary) {
      return [];
    }
    const editableServers = mcpSummary.editableServers ?? mcpSummary.servers ?? [];
    return [...editableServers, ...(mcpSummary.router?.upstreamServers ?? [])];
  }, [mcpSummary]);

  const { connections } = useUnifiedConnections({
    servers: allServers,
    settings: draftSettings,
    includeAvailable: true,
  });

  const catalogConnectionsById = React.useMemo(() => {
    const next = new Map<string, UnifiedConnection>();
    for (const connection of connections) {
      const catalogId = connection.catalogEntry?.id;
      if (!catalogId) {
        continue;
      }

      const existing = next.get(catalogId);
      if (!existing || existing.status === 'available') {
        next.set(catalogId, connection);
      }
    }
    return next;
  }, [connections]);

  React.useEffect(() => {
    for (const category of CATEGORY_CONFIGS) {
      for (const provider of category.providers) {
        if (provider.kind !== 'existing') continue;
        const toolState = toolAuthStates.find((t) => t.tool === provider.value);
        if (!toolState || !isPendingStatus(toolState.status)) continue;

        const connection = catalogConnectionsById.get(provider.connectorId);
        if (connection?.status === 'connected') {
          actions.observeCatalogConnection(provider.value);
        }
      }
    }
  }, [catalogConnectionsById, toolAuthStates, actions]);

  const visibleCategories = React.useMemo(() => {
    return CATEGORY_CONFIGS.map((category) => ({
      ...category,
      providers: category.providers.filter((provider) => {
        if (provider.kind === 'existing') {
          return true;
        }
        return catalogConnectionsById.has(provider.connectorId);
      }),
    })).filter((category) => category.providers.length > 0);
  }, [catalogConnectionsById]);

  const moreTools = React.useMemo(() => {
    const isSearching = moreToolsSearch.trim().length > 0;
    return Array.from(catalogConnectionsById.values())
      .filter((connection) => {
        const entry = connection.catalogEntry;
        const connectorId = entry?.id;
        if (!connectorId || CORE_CONNECTOR_IDS.has(connectorId)) return false;
        if (entry?.isInternal || entry?.hidden) return false;
        // When browsing, hide requiresDesktopApp connectors for a cleaner onboarding experience.
        // When searching, include them so users can discover connectors like Beeper via aliases
        // (e.g. searching "WhatsApp" should surface Beeper). See FOX-2999.
        if (!isSearching && entry?.requiresDesktopApp) return false;
        return true;
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [catalogConnectionsById, moreToolsSearch]);

  const moreToolsByCategory = React.useMemo(() => {
    const grouped = new Map<ConnectorCategory, UnifiedConnection[]>();

    for (const connection of moreTools) {
      const category = (connection.catalogEntry?.category ?? 'other') as ConnectorCategory;
      const existing = grouped.get(category) ?? [];
      existing.push(connection);
      grouped.set(category, existing);
    }

    return CONNECTOR_CATEGORY_ORDER.map((category) => ({
      category,
      label: CATEGORY_LABELS[category],
      connections: grouped.get(category) ?? [],
    })).filter((group) => group.connections.length > 0);
  }, [moreTools]);

  const filteredMoreToolsByCategory = React.useMemo(() => {
    if (!moreToolsSearch.trim()) return moreToolsByCategory;
    return moreToolsByCategory
      .map((group) => ({
        ...group,
        connections: group.connections.filter((c) => matchesConnectorSearch(c, moreToolsSearch)),
      }))
      .filter((group) => group.connections.length > 0);
  }, [moreToolsByCategory, moreToolsSearch]);

  const currentUserEmail = draftSettings.userEmail ?? window.electronEnv?.userEmail ?? null;

  const googleConnected = React.useMemo(() => {
    return toolAuthStates.some(
      (toolState) => ['gmail', 'google-calendar'].includes(toolState.tool) && isConnectedStatus(toolState.status)
    );
  }, [toolAuthStates]);

  const emailRequirementSatisfied = React.useMemo(() => {
    return toolAuthStates.some(
      (toolState) => ['gmail', 'outlook-mail'].includes(toolState.tool) && isConnectedStatus(toolState.status)
    );
  }, [toolAuthStates]);

  const microsoftConnected = React.useMemo(() => {
    return toolAuthStates.some(
      (toolState) =>
        ['outlook-mail', 'outlook-calendar', 'teams'].includes(toolState.tool) && isConnectedStatus(toolState.status)
    );
  }, [toolAuthStates]);

  const getToolState = useCallback(
    (tool: ToolType): ToolAuthState | undefined => {
      return toolAuthStates.find((toolState) => toolState.tool === tool);
    },
    [toolAuthStates]
  );

  const getAccountLabel = useCallback(
    (provider: ExistingProviderOption): string | null => {
      if (!currentUserEmail) {
        return null;
      }

      if (provider.accountFamily === 'google' && googleConnected) {
        return currentUserEmail;
      }

      if (provider.accountFamily === 'microsoft' && microsoftConnected) {
        return currentUserEmail;
      }

      return null;
    },
    [currentUserEmail, googleConnected, microsoftConnected]
  );

  const getCategoryState = useCallback(
    (category: CategoryConfig): CategoryCardState => {
      const hasConnectedProvider = category.providers.some((provider) => {
        if (provider.kind === 'existing') {
          const toolState = getToolState(provider.value);
          return Boolean(toolState && isConnectedStatus(toolState.status));
        }
        return catalogConnectionsById.get(provider.connectorId)?.status === 'connected';
      });
      if (hasConnectedProvider) {
        return 'connected';
      }

      const activeExistingProvider = category.providers.find((provider) => {
        if (!isExistingProvider(provider)) {
          return false;
        }
        const toolState = getToolState(provider.value);
        return Boolean(toolState && isCategoryActiveStatus(toolState.status));
      });

      if (activeExistingProvider?.kind === 'existing') {
        const toolState = getToolState(activeExistingProvider.value);
        if (toolState && isGeneratingStatus(toolState.status)) {
          return 'loading';
        }
        if (toolState && isAwaitingOrVerifyingStatus(toolState.status)) {
          return 'awaiting';
        }
      }

      const hasError = category.providers.some((provider) => {
        const toolState = provider.kind === 'existing' ? getToolState(provider.value) : undefined;
        return Boolean(toolState && isErrorStatus(toolState.status));
      });

      return hasError ? 'error' : 'idle';
    },
    [catalogConnectionsById, getToolState]
  );

  const getCategoryGroupClass = useCallback((categoryState: CategoryCardState): string => {
    const baseClass = styles.onboardingConnectorGroup;
    switch (categoryState) {
      case 'connected':
        return `${baseClass} ${styles.onboardingConnectorGroupConnected}`;
      case 'loading':
      case 'awaiting':
        return `${baseClass} ${styles.onboardingConnectorGroupActive}`;
      case 'error':
        return `${baseClass} ${styles.onboardingConnectorGroupError}`;
      default:
        return baseClass;
    }
  }, []);

  type StatusMessageInfo = {
    message: string;
    provider: ToolType;
  };

  const getCategoryStatusInfo = useCallback(
    (category: CategoryConfig): StatusMessageInfo | null => {
      for (const provider of category.providers) {
        if (!isExistingProvider(provider)) {
          continue;
        }

        const toolState = getToolState(provider.value);
        if (
          toolState &&
          isErrorStatus(toolState.status) &&
          toolState.error?.toLowerCase().includes('timed out waiting for authentication')
        ) {
          return {
            message: 'Timed out waiting for authentication. Please try again or skip and set up later in Settings.',
            provider: provider.value,
          };
        }
      }

      for (const provider of category.providers) {
        if (!isExistingProvider(provider)) {
          continue;
        }

        const toolState = getToolState(provider.value);
        if (
          toolState &&
          isPollingStatus(toolState.status) &&
          toolState.awaitingSince &&
          now - toolState.awaitingSince > 10000
        ) {
          return {
            message: 'Working on getting your connection set up. Please bear with us.',
            provider: provider.value,
          };
        }
      }

      return null;
    },
    [getToolState, now]
  );

  const handleAlreadyAuthenticated = useCallback(
    (provider: ToolType) => {
      actions.markToolAuthConnected(provider);
    },
    [actions]
  );

  const renderProviderLabel = useCallback(
    (provider: ExistingProviderOption | CatalogProviderOption) => {
      const badge =
        provider.kind === 'existing' &&
        provider.required &&
        !emailRequirementSatisfied;
      const iconConnectorId = provider.connectorId;

      return (
        <div className={styles.onboardingProviderLabel}>
          <div className={styles.onboardingCatalogIcon} aria-hidden="true">
            {React.createElement(getConnectorIcon(catalogConnectionsById.get(iconConnectorId)?.icon), {
              size: 14,
              strokeWidth: 1.9,
            })}
          </div>
          <div className={styles.onboardingProviderText}>
            <div className={styles.onboardingProviderTitleRow}>
              <span>{provider.label}</span>
              {badge && <span className={`${styles.optionalBadge} ${styles.requiredChipBadge}`}>Recommended</span>}
            </div>
          </div>
        </div>
      );
    },
    [catalogConnectionsById, emailRequirementSatisfied]
  );

  const renderExistingProvider = useCallback(
    (provider: ExistingProviderOption) => {
      const toolState = getToolState(provider.value);
      const status = toolState?.status ?? 'pending';
      const showSkeleton = isGeneratingStatus(status);
      const isClickable = isConnectorSetupClickableStatus(status);
      const accountLabel = isConnectedStatus(status) ? getAccountLabel(provider) : null;
      const actionLabel = isReadyToConnectStatus(status)
        ? `Connect ${provider.label}`
        : isErrorStatus(status)
          ? `Retry ${provider.label}`
          : `Set up ${provider.label}`;

      const handleClick = () => {
        if (!toolState || !isClickable) {
          return;
        }

        actions.clearToolAuthError(provider.value);
        if (isReadyToConnectStatus(status) && toolState.authUrl) {
          actions.startOAuthFlow(provider.value);
        } else {
          void actions.generateAuthLink(provider.value, { autoStart: true });
        }
      };

      return (
        <div key={provider.value} className={styles.onboardingProviderWrapper}>
          {showSkeleton && <div className={styles.skeletonButton} />}

          {!showSkeleton && isAwaitingOrVerifyingStatus(status) && toolState && (
            <div className={`${styles.onboardingConnectionChip} ${styles.onboardingConnectionChipBusy}`}>
              <div className={styles.onboardingConnectionChipMain}>
                {renderProviderLabel(provider)}
                <span className={styles.onboardingChipStatus}>
                  <Loader2 size={12} className={styles.onboardingChipSpinner} />
                  {renderToolStatus(toolState)}
                </span>
              </div>
            </div>
          )}

          {!showSkeleton && isConnectedStatus(status) && (
            <Tooltip
              placement="top"
              maxWidth="320px"
              content={
                <div className={styles.onboardingConnectedTooltip}>
                  {accountLabel ? (
                    <>
                      <div className={styles.onboardingConnectedTooltipPrimary}>{accountLabel}</div>
                      <div className={styles.onboardingConnectedTooltipSecondary}>
                        You can add more email addresses and other connectors in Settings after you finish onboarding.
                      </div>
                    </>
                  ) : provider.value === 'gmail' || provider.value === 'outlook-mail' ? (
                    <div className={styles.onboardingConnectedTooltipSecondary}>
                      Connected. You can add more email addresses and other connectors in Settings after you finish
                      onboarding.
                    </div>
                  ) : (
                    <div className={styles.onboardingConnectedTooltipSecondary}>
                      Connected. Add more connectors from this list anytime.
                    </div>
                  )}
                </div>
              }
            >
              <span className={styles.onboardingTooltipTrigger}>
                <div className={`${styles.onboardingConnectionChip} ${styles.onboardingConnectionChipConnected}`}>
                  <div className={styles.onboardingConnectionChipMain}>
                    {renderProviderLabel(provider)}
                  </div>
                  <span className={styles.onboardingChipCheck} aria-label="Connected" title="Connected">
                    <Check size={12} />
                  </span>
                </div>
              </span>
            </Tooltip>
          )}

          {!showSkeleton && isConnectorSetupClickableStatus(status) && (
            <Tooltip content="" disabled>
              <span className={styles.onboardingTooltipTrigger}>
                <button
                  type="button"
                  className={`${styles.onboardingConnectionChip} ${styles.onboardingConnectionChipButton} ${isErrorStatus(status) ? styles.onboardingConnectionChipProblem : ''}`}
                  onClick={handleClick}
                  disabled={!isClickable}
                  aria-label={actionLabel}
                >
                  <div className={styles.onboardingConnectionChipMain}>
                    {renderProviderLabel(provider)}
                    {isPendingStatus(status) && <span className={styles.onboardingChipCta}>Set up</span>}
                    {isReadyToConnectStatus(status) && <span className={styles.onboardingChipCta}>Connect</span>}
                    {isErrorStatus(status) && (
                      <span className={styles.onboardingChipStatusProblem}>
                        <AlertCircle size={12} />
                        Retry
                      </span>
                    )}
                  </div>
                </button>
              </span>
            </Tooltip>
          )}

          {toolState?.error && !toolState.error.toLowerCase().includes('timed out waiting for authentication') && (
            <span className={styles.onboardingProviderError}>{toolState.error}</span>
          )}
        </div>
      );
    },
    [actions, getAccountLabel, getToolState, renderProviderLabel, renderToolStatus]
  );

  const handleCatalogConnect = useCallback(
    async (connection: UnifiedConnection) => {
      const entry = connection.catalogEntry;
      if (!entry || connectingCatalogId === entry.id) {
        return;
      }

      setCatalogErrors((current) => {
        if (!current[entry.id]) {
          return current;
        }
        const next = { ...current };
        delete next[entry.id];
        return next;
      });
      setConnectingCatalogId(entry.id);

      try {
        if (!supportsInlineConnect(connection)) {
          throw new Error('This connector needs extra setup in Settings.');
        }

        if (isBundledLikeProvider(entry.provider)) {
          const { bundledConfig } = entry;
          if (!bundledConfig) throw new Error('Missing bundled config for bundled-like provider');

          await window.settingsApi.mcpAddBundledServer({
            serverName: bundledConfig.serverName,
            catalogId: entry.id,
          });

          let authResult: AuthResult | undefined;
          switch (bundledConfig.authApi) {
            case 'hubspotApi':
              authResult = await window.hubspotApi.startAuth({});
              break;
            case 'googleWorkspaceApi':
              authResult = await window.googleWorkspaceApi.startAuth();
              break;
            case 'microsoftApi':
              authResult = await window.microsoftApi.startAuth();
              break;
            case 'slackApi': {
              const slackResult = await window.slackApi.startAuth();
              authResult = { success: slackResult.success, error: slackResult.error, setupGuidance: slackResult.setupGuidance };
              break;
            }
            default:
              authResult = await window.miscApi.mcpAuthenticate({ serverId: bundledConfig.serverName });
          }

          if (!authResult?.success) {
            if (setupGuidanceDialog.handleResult(authResult)) return;
            throw new Error(authResult?.error ?? `Couldn't connect ${connection.name}.`);
          }
        } else {
          const config = entry.mcpConfig;
          if (!config?.oauth) {
            throw new Error('This connector is not available for one-click onboarding setup.');
          }

          await upsertMcpServer({
            name: connection.name,
            transport: config.transport || 'stdio',
            type: config.type,
            url: config.url,
            command: config.command,
            args: config.args,
            oauth: config.oauth,
            oauthParams: config.oauthParams,
            oauthClientId: config.oauthClientId,
            oauthClientSecret: config.oauthClientSecret,
            catalogId: entry.id,
            lastConnectedAt: Date.now(),
          });

          let authResult: AuthResult | undefined;
          if (entry.authMethod === 'rebel-oauth') {
            const githubResult = await window.githubApi.startAuth();
            authResult = { success: githubResult.success, error: githubResult.error, setupGuidance: githubResult.setupGuidance };
            if (githubResult.success) {
              await window.settingsApi.mcpRestartSuperMcp();
            }
          } else {
            authResult = await window.miscApi.mcpAuthenticate({ serverId: connection.name });
          }

          if (!authResult?.success) {
            if (setupGuidanceDialog.handleResult(authResult)) return;
            throw new Error(authResult?.error ?? `Couldn't connect ${connection.name}.`);
          }
        }

        await refreshMcpSummary();
        setExpandedConnectorId(null);
      } catch (error) {
        const message = error instanceof Error ? error.message : `Couldn't connect ${connection.name}.`;
        setCatalogErrors((current) => ({ ...current, [entry.id]: message }));
      } finally {
        setConnectingCatalogId(null);
      }
    },
    [connectingCatalogId, refreshMcpSummary, upsertMcpServer, setupGuidanceDialog]
  );

  const handleMoreToolConnect = useCallback(
    async (
      connection: UnifiedConnection,
      email?: string,
      options?: { launchRebel?: boolean; scopeTier?: 'readonly' | 'full'; setupFieldValues?: Record<string, string> }
    ) => {
      const entry = connection.catalogEntry;
      if (!entry || connectingCardId === entry.id) return;

      setCatalogErrors((current) => {
        if (!current[entry.id]) return current;
        const next = { ...current };
        delete next[entry.id];
        return next;
      });
      setConnectingCardId(entry.id);
      try {
        if (isBundledLikeProvider(entry.provider)) {
          const { bundledConfig } = entry;
          if (!bundledConfig) throw new Error('Missing bundled config for bundled-like provider');
          await window.settingsApi.mcpAddBundledServer({
            serverName: bundledConfig.serverName,
            ...(email ? { email } : {}),
            ...(options?.scopeTier ? { scopeTier: options.scopeTier } : {}),
            catalogId: entry.id,
          });

          let authResult: AuthResult | undefined;
          switch (bundledConfig.authApi) {
            case 'hubspotApi':
              authResult = await window.hubspotApi.startAuth({
                ...(options?.scopeTier ? { scopeTier: options.scopeTier } : {}),
              });
              break;
            case 'googleWorkspaceApi':
              authResult = await window.googleWorkspaceApi.startAuth();
              break;
            case 'microsoftApi':
              authResult = await window.microsoftApi.startAuth();
              break;
            case 'slackApi': {
              const slackResult = await window.slackApi.startAuth();
              authResult = { success: slackResult.success, error: slackResult.error, setupGuidance: slackResult.setupGuidance };
              break;
            }
            default:
              authResult = await window.miscApi.mcpAuthenticate({ serverId: bundledConfig.serverName });
          }

          if (!authResult?.success) {
            if (setupGuidanceDialog.handleResult(authResult)) return;
            throw new Error(authResult?.error ?? `Couldn't connect ${connection.name}.`);
          }
        } else {
          const config = entry.mcpConfig;
          if (!config?.oauth) {
            throw new Error('This connector requires manual setup.');
          }

          await upsertMcpServer({
            name: connection.name,
            transport: config.transport || 'stdio',
            type: config.type,
            url: config.url,
            command: config.command,
            args: config.args,
            oauth: config.oauth,
            oauthParams: config.oauthParams,
            oauthClientId: config.oauthClientId,
            oauthClientSecret: config.oauthClientSecret,
            catalogId: entry.id,
            lastConnectedAt: Date.now(),
            ...(email ? { email } : {}),
          });

          let authResult: AuthResult | undefined;
          if (entry.authMethod === 'rebel-oauth') {
            const result = await window.githubApi.startAuth();
            authResult = { success: result.success, error: result.error, setupGuidance: result.setupGuidance };
            if (result.success) {
              await window.settingsApi.mcpRestartSuperMcp();
            }
          } else {
            authResult = await window.miscApi.mcpAuthenticate({ serverId: connection.name });
          }

          if (!authResult?.success) {
            if (setupGuidanceDialog.handleResult(authResult)) return;
            throw new Error(authResult?.error ?? `Couldn't connect ${connection.name}.`);
          }
        }

        await refreshMcpSummary();

        const matchingTools = CATEGORY_CONFIGS
          .flatMap((c) => c.providers)
          .filter((p): p is ExistingProviderOption => p.kind === 'existing' && p.connectorId === entry.id);
        for (const p of matchingTools) {
          actions.markToolAuthConnected(p.value);
        }

        setExpandedConnectorId(null);
      } catch (error) {
        const message = error instanceof Error ? error.message : `Couldn't connect ${connection.name}.`;
        setCatalogErrors((current) => ({ ...current, [entry.id]: message }));
      } finally {
        setConnectingCardId(null);
      }
    },
    [actions, connectingCardId, refreshMcpSummary, upsertMcpServer, setupGuidanceDialog]
  );

  const handleMoreToolDisconnect = useCallback(
    async (connection: UnifiedConnection) => {
      const serverName = connection.serverPreview?.name;
      if (!serverName) return;

      const connectorId = connection.catalogEntry?.id;
      setRemovingCardId(connectorId ?? null);
      try {
        await removeMcpServer(serverName);
        await refreshMcpSummary();
        setExpandedConnectorId(null);

        if (connectorId) {
          const matchingTools = CATEGORY_CONFIGS
            .flatMap((c) => c.providers)
            .filter((p): p is ExistingProviderOption => p.kind === 'existing' && p.connectorId === connectorId);
          for (const p of matchingTools) {
            actions.disconnectToolAuth(p.value);
          }
        }
      } catch (error) {
        console.error('Failed to disconnect:', error);
      } finally {
        setRemovingCardId(null);
      }
    },
    [actions, removeMcpServer, refreshMcpSummary]
  );

  const renderCatalogProvider = useCallback(
    (provider: CatalogProviderOption) => {
      const connection = catalogConnectionsById.get(provider.connectorId);
      if (!connection) {
        return null;
      }

      const isConnected = connection.status === 'connected';
      const isBusy = connectingCatalogId === provider.connectorId;
      const errorMessage = catalogErrors[provider.connectorId];
      const showRetry = connection.status === 'error' || connection.status === 'needs-setup' || Boolean(errorMessage);
      const actionLabel = isConnected
        ? provider.label
        : showRetry
          ? `Retry ${provider.label}`
          : `Set up ${provider.label}`;

      return (
        <div key={provider.connectorId} className={styles.onboardingProviderWrapper}>
          <button
            type="button"
            className={`${styles.onboardingConnectionChip} ${styles.onboardingConnectionChipButton} ${isConnected ? styles.onboardingConnectionChipConnected : ''} ${showRetry ? styles.onboardingConnectionChipProblem : ''}`}
            onClick={() => {
              if (!isConnected) {
                void handleCatalogConnect(connection);
              }
            }}
            disabled={isBusy}
            aria-label={actionLabel}
          >
            <div className={styles.onboardingConnectionChipMain}>
              {renderProviderLabel(provider)}
              {isBusy && (
                <span className={styles.onboardingChipStatus}>
                  <Loader2 size={12} className={styles.onboardingChipSpinner} />
                  Connecting
                </span>
              )}
              {!isConnected && !isBusy && showRetry && (
                <span className={styles.onboardingChipStatusProblem}>
                  <AlertCircle size={12} />
                  Retry
                </span>
              )}
              {!isConnected && !isBusy && !showRetry && <span className={styles.onboardingChipCta}>Set up</span>}
            </div>
            {isConnected && (
              <span className={styles.onboardingChipCheck} aria-label="Connected" title="Connected">
                <Check size={12} />
              </span>
            )}
          </button>
          {errorMessage && <span className={styles.onboardingProviderError}>{errorMessage}</span>}
        </div>
      );
    },
    [catalogConnectionsById, catalogErrors, connectingCatalogId, handleCatalogConnect, renderProviderLabel]
  );

  const renderCategoryProviders = useCallback(
    (category: CategoryConfig) => {
      return (
        <div className={styles.onboardingConnectionChips}>
          {category.providers.map((provider) => {
            const connectorId = provider.connectorId;
            const connection = catalogConnectionsById.get(connectorId);
            const isExpanded = expandedConnectorId === connectorId;
            const isConnected = connection?.status === 'connected';

            const chipKey = provider.kind === 'existing' ? provider.value : provider.connectorId;
            const chipContent = provider.kind === 'existing'
              ? renderExistingProvider(provider)
              : renderCatalogProvider(provider);

            return (
              <React.Fragment key={chipKey}>
                <div
                  onClick={(e) => {
                    if (e.target instanceof HTMLElement && e.target.closest('button')) {
                      return;
                    }
                    setExpandedConnectorId(isExpanded ? null : connectorId);
                  }}
                  className={isExpanded ? styles.onboardingChipExpandedWrapper : undefined}
                >
                  {chipContent}
                </div>
                {isExpanded && connection && (
                  <div className={styles.onboardingExpandedCardInline}>
                    <ExpandedConnectionCard
                      connection={connection}
                      onClose={() => setExpandedConnectorId(null)}
                      onConnect={(email, options) => handleMoreToolConnect(connection, email, options)}
                      onDisconnect={isConnected ? () => handleMoreToolDisconnect(connection) : undefined}
                      ops={connectionCardOps}
                      onRefresh={refreshMcpSummary}
                      isConnecting={connectingCardId === connectorId}
                      isRemoving={removingCardId === connectorId}
                      onCancelConnect={() => setConnectingCardId(null)}
                    />
                    {catalogErrors[connectorId] && (
                      <span className={styles.onboardingProviderError}>{catalogErrors[connectorId]}</span>
                    )}
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      );
    },
    [
      catalogConnectionsById, catalogErrors, connectingCardId, expandedConnectorId, removingCardId,
      renderCatalogProvider, renderExistingProvider,
      handleMoreToolConnect, handleMoreToolDisconnect,
      connectionCardOps, refreshMcpSummary,
    ]
  );

  return (
    <div className={styles.stepBody}>
      <div className={styles.stepTitleGroup}>
        <h2>Set up your connectors</h2>
        <p className={styles.stepDescription}>
          Connect the apps you want Rebel to work with first. To continue, connect an email account, then add the rest that match how you work.
        </p>
      </div>

      {triedContinue && !toolAuthReady && !canSkipToolAuth && (
        <div className={styles.connectionRequiredBanner}>
          <Info size={16} aria-hidden />
          <p>You'll need to connect at least one email account to continue. Email is Rebel's starting point. It's how Rebel reads your inbox, drafts replies, and knows what needs your attention. Connect Gmail or Outlook above to get started.</p>
        </div>
      )}

      <div className={styles.onboardingConnectorGroups}>
        {visibleCategories.map((category) => {
          const categoryState = getCategoryState(category);
          const statusInfo = getCategoryStatusInfo(category);
          return (
            <div key={category.id} className={getCategoryGroupClass(categoryState)}>
              <div className={styles.onboardingConnectorHeader}>
                <span className={styles.onboardingConnectorLabel}>{category.title}</span>
              </div>
              <p className={styles.onboardingConnectorDescription}>{category.description}</p>
              {renderCategoryProviders(category)}
              {statusInfo && (
                <div className={styles.onboardingConnectorStatusRow}>
                  {statusInfo.message}{' '}
                  <button
                    type="button"
                    onClick={() => handleAlreadyAuthenticated(statusInfo.provider)}
                    className={styles.onboardingConnectorLink}
                  >
                    Already authenticated? Click here.
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {moreToolsByCategory.length > 0 && (
          <details
            className={styles.accordion}
            onToggle={(e) => {
              if (!(e.target as HTMLDetailsElement).open) {
                setMoreToolsSearch('');
                setExpandedConnectorId(null);
              }
            }}
          >
            <summary>Connect more</summary>
            <div className={styles.onboardingMoreToolsGroups}>
              <p className={styles.onboardingConnectorGuidance}>
                The more connectors you set up, the more Rebel can help. You can always turn connectors on or off again in Settings.
              </p>
              <div className={styles.onboardingMoreToolsSearch}>
                <input
                  type="search"
                  placeholder="Search connectors..."
                  value={moreToolsSearch}
                  onChange={(e) => setMoreToolsSearch(e.target.value)}
                  className={styles.onboardingMoreToolsSearchInput}
                  aria-label="Search connectors"
                />
              </div>
              {filteredMoreToolsByCategory.length === 0 && moreToolsSearch.trim() && (
                <p className={styles.onboardingNoResults}>No connectors match your search.</p>
              )}
              {filteredMoreToolsByCategory.map((group) => (
                <div key={group.category} className={styles.onboardingMoreToolsCategory}>
                  <div className={styles.onboardingConnectorHeader}>
                    <span className={styles.onboardingConnectorLabel}>{group.label}</span>
                  </div>
                  <div className={styles.onboardingConnectionChips}>
                    {group.connections.map((connection) => {
                      const connectorId = connection.catalogEntry?.id;
                      if (!connectorId) return null;

                      const isConnected = connection.status === 'connected';
                      const isExpanded = expandedConnectorId === connectorId;
                      const isBusy = connectingCardId === connectorId;
                      const errorMessage = catalogErrors[connectorId];

                      return (
                        <React.Fragment key={connectorId}>
                          <button
                            type="button"
                            className={`${styles.onboardingConnectionChip} ${styles.onboardingConnectionChipButton} ${isConnected ? styles.onboardingConnectionChipConnected : ''} ${isExpanded ? styles.onboardingConnectionChipExpanded : ''}`}
                            onClick={() => setExpandedConnectorId(isExpanded ? null : connectorId)}
                            disabled={isBusy}
                            aria-label={isConnected ? connection.name : `Set up ${connection.name}`}
                            aria-expanded={isExpanded}
                          >
                            <div className={styles.onboardingConnectionChipMain}>
                              <div className={styles.onboardingProviderLabel}>
                                <div className={styles.onboardingCatalogIcon} aria-hidden="true">
                                  {React.createElement(getConnectorIcon(connection.icon), {
                                    size: 14,
                                    strokeWidth: 1.9,
                                  })}
                                </div>
                                <div className={styles.onboardingProviderText}>
                                  <div className={styles.onboardingProviderTitleRow}>
                                    <span>{connection.name}</span>
                                  </div>
                                </div>
                              </div>
                              {isConnected && (
                                <span className={styles.onboardingChipCheck} aria-label="Connected" title="Connected">
                                  <Check size={12} />
                                </span>
                              )}
                              {isBusy && (
                                <span className={styles.onboardingChipStatus}>
                                  <Loader2 size={12} className={styles.onboardingChipSpinner} />
                                  Connecting
                                </span>
                              )}
                              {!isConnected && !isBusy && (
                                <span className={styles.onboardingChipCta}>Set up</span>
                              )}
                            </div>
                          </button>
                          {isExpanded && (
                            <div className={styles.onboardingExpandedCardInline}>
                              <ExpandedConnectionCard
                                connection={connection}
                                onClose={() => setExpandedConnectorId(null)}
                                onConnect={(email, options) => handleMoreToolConnect(connection, email, options)}
                                onDisconnect={isConnected ? () => handleMoreToolDisconnect(connection) : undefined}
                                ops={connectionCardOps}
                                onRefresh={refreshMcpSummary}
                                isConnecting={connectingCardId === connectorId}
                                isRemoving={removingCardId === connectorId}
                                onCancelConnect={() => setConnectingCardId(null)}
                              />
                              {errorMessage && (
                                <span className={styles.onboardingProviderError}>{errorMessage}</span>
                              )}
                            </div>
                          )}
                          {errorMessage && !isExpanded && (
                            <span className={styles.onboardingProviderError}>{errorMessage}</span>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      <p className={styles.onboardingConnectorFootnote}>
        Connect what you use. You can adjust what each connector can access — or remove it entirely — anytime in Settings.
      </p>

      <ConnectorSetupDialog
        guidance={setupGuidanceDialog.guidance}
        open={setupGuidanceDialog.isOpen}
        onOpenChange={setupGuidanceDialog.setOpen}
      />
    </div>
  );
};
