import { useCallback, useEffect, useMemo, useState } from 'react';

import type { AppSettings, McpServerPreview } from '@shared/types';
import type { CloudInstanceConfig } from '@shared/types/settings';
import { Button, Notice } from '@renderer/components/ui';
import { useNavigationSafe } from '@renderer/contexts';
import { ConnectSlackCard, type ConnectSlackCardProps } from '../ConnectSlackCard';
import { SettingSection } from '../SettingSection';
import { useSettingsSafe } from '../../SettingsProvider';
import { useConnectSlackMcpAction } from '../../hooks/useConnectSlackMcpAction';
import { useConnectorSetupGuidance } from '../../hooks/useConnectorSetupGuidance';
import { ConnectorSetupDialog } from '../ConnectorSetupDialog';
import {
  computeUnifiedConnectionsSnapshot,
  getMcpServersForConnectorsView,
} from '../../hooks/useUnifiedConnections';
import { useInboundAuthorPolicy } from '../../hooks/useInboundAuthorPolicy';
import { MessagingComingSoonRow, type MessagingComingSoonRowProps } from './MessagingComingSoonRow';
import { MessagingConnectSlackCTA } from './MessagingConnectSlackCTA';
import { MultiRebelWorkspaceNotice } from './MultiRebelWorkspaceNotice';
import { UpgradeReviewNotice } from './UpgradeReviewNotice';
import { WhoCanMessageRebelPanel } from './WhoCanMessageRebelPanel';
import { RecentMessageAttemptsPanel, useSlackRecentSenders } from './RecentMessageAttemptsPanel';

export const MESSAGING_COMING_SOON_CHANNELS = [
  { platform: 'telegram' },
  { platform: 'whatsapp' },
  { platform: 'teams' },
] satisfies MessagingComingSoonRowProps[];

export type CloudContinuityMode = 'desktop-only' | 'cloud';

export interface SlackWorkspaceSummary {
  teamId: string;
  teamName: string;
}

type CloudSlackWorkspaceSummary = {
  teamId: string;
  teamName: string;
  status?: 'connected' | 'needs_reconnect' | 'disconnecting' | 'disconnected';
  peerInstanceCount?: number;
} | null;

export interface MessagingChannelsSectionProps {
  connectSlackCardProps?: ConnectSlackCardProps;
  /** Test/story override for the connector-state server list; production reads Settings context. */
  mcpServers?: McpServerPreview[];
  /** Test/story override; production derives S1 from connector state. */
  showConnectSlackCta?: boolean;
  /** Test/story override; production derives from Settings cloudInstance.mode. */
  cloudContinuityMode?: CloudContinuityMode;
  /** Test/story override; production derives from Settings experimental.cloudSlackWorkspace. */
  cloudSlackWorkspace?: CloudSlackWorkspaceSummary;
  /** Test/story override for canonical slack:get-workspaces IPC result. */
  slackWorkspaces?: SlackWorkspaceSummary[];
  /** Test/story override; production derives from Settings cloudInstance.lastKnownStatus. */
  cloudStatus?: CloudInstanceConfig['lastKnownStatus'] | null;
  /** Test/story override; production reads the desktop fallback adapter state. */
  localFallbackEnabled?: boolean;
}

const CLOUD_SETTINGS_URL = 'rebel://settings/?tab=cloud&section=cloudSync';
const SLACK_ADAPTER_ID = 'slack-mention';

export function hasSlackMcpConnector(
  mcpServers: McpServerPreview[],
  settings?: AppSettings,
): boolean {
  const { rawBeforeCategoryAccount } = computeUnifiedConnectionsSnapshot({
    servers: mcpServers,
    settings,
    includeAvailable: false,
    categoryFilter: 'all',
    sortBy: 'alphabetical',
  });

  return rawBeforeCategoryAccount.some(
    (connection) => connection.catalogEntry?.bundledConfig?.authApi === 'slackApi',
  );
}

function deriveCloudContinuityMode(settings: AppSettings | null | undefined): CloudContinuityMode | undefined {
  if (!settings?.cloudInstance) return undefined;
  return settings.cloudInstance.mode === 'cloud' ? 'cloud' : 'desktop-only';
}

function isCloudReachable(status: CloudInstanceConfig['lastKnownStatus'] | null | undefined): boolean {
  return status === 'running' || status === 'warm';
}

export function MessagingChannelsSection({
  connectSlackCardProps,
  mcpServers: mcpServersOverride,
  showConnectSlackCta,
  cloudContinuityMode: cloudContinuityModeOverride,
  cloudSlackWorkspace: cloudSlackWorkspaceOverride,
  slackWorkspaces: slackWorkspacesOverride,
  cloudStatus: cloudStatusOverride,
  localFallbackEnabled,
}: MessagingChannelsSectionProps) {
  const settingsContext = useSettingsSafe();
  const navigation = useNavigationSafe();
  const connectSlackMcp = useConnectSlackMcpAction();
  const setupGuidanceDialog = useConnectorSetupGuidance();
  const contextMcpServers = useMemo(
    () => getMcpServersForConnectorsView(settingsContext?.mcpSummary),
    [settingsContext?.mcpSummary],
  );
  const mcpServers = mcpServersOverride ?? contextMcpServers;
  const mcpStateReady = mcpServersOverride !== undefined ||
    Boolean(settingsContext?.mcpSummary) ||
    settingsContext?.mcpSummaryLoading === false;
  const hasSlackConnector = useMemo(
    () => hasSlackMcpConnector(mcpServers, settingsContext?.settings ?? undefined),
    [mcpServers, settingsContext?.settings],
  );
  const shouldShowConnectSlackCta = showConnectSlackCta ?? (mcpStateReady && !hasSlackConnector);
  const settingsForSignals = settingsContext?.draftSettings ?? settingsContext?.settings ?? null;
  const cloudContinuityMode = cloudContinuityModeOverride ?? deriveCloudContinuityMode(settingsForSignals);
  const cloudSlackWorkspace = cloudSlackWorkspaceOverride ?? settingsForSignals?.experimental?.cloudSlackWorkspace ?? null;
  const inboundPolicyState = useInboundAuthorPolicy();
  const recentSendersState = useSlackRecentSenders();
  const effectiveCloudStatus = cloudStatusOverride ?? connectSlackCardProps?.cloudStatus ?? settingsForSignals?.cloudInstance?.lastKnownStatus ?? null;
  const [desktopFallbackEnabled, setDesktopFallbackEnabled] = useState(false);
  const [slackWorkspacesFromIpc, setSlackWorkspacesFromIpc] = useState<SlackWorkspaceSummary[] | null>(
    slackWorkspacesOverride ?? null,
  );

  useEffect(() => {
    if (localFallbackEnabled !== undefined) {
      setDesktopFallbackEnabled(localFallbackEnabled);
      return undefined;
    }
    if (connectSlackCardProps?.localFallback) {
      setDesktopFallbackEnabled(connectSlackCardProps.localFallback.enabled);
      return undefined;
    }
    const api = window.inboundTriggersApi;
    if (!api) {
      setDesktopFallbackEnabled(false);
      return undefined;
    }
    let cancelled = false;
    api.getAdapterState({ adapterId: SLACK_ADAPTER_ID })
      .then((state) => {
        if (!cancelled) setDesktopFallbackEnabled(state?.enabled ?? false);
      })
      .catch((err) => {
        console.warn('Failed to read Slack desktop fallback state for Messaging section', err);
        if (!cancelled) setDesktopFallbackEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectSlackCardProps?.localFallback, localFallbackEnabled]);

  useEffect(() => {
    if (slackWorkspacesOverride) {
      setSlackWorkspacesFromIpc(slackWorkspacesOverride);
      return undefined;
    }
    if (!hasSlackConnector || !cloudSlackWorkspace?.teamId) {
      setSlackWorkspacesFromIpc(null);
      return undefined;
    }
    const api = window.slackApi;
    if (!api?.getWorkspaces) {
      setSlackWorkspacesFromIpc(null);
      return undefined;
    }
    let cancelled = false;
    setSlackWorkspacesFromIpc(null);
    api.getWorkspaces()
      .then((result) => {
        if (!cancelled) setSlackWorkspacesFromIpc(result.workspaces);
      })
      .catch((err) => {
        console.warn('Failed to read Slack MCP workspaces for Messaging section', err);
        if (!cancelled) setSlackWorkspacesFromIpc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [cloudSlackWorkspace?.teamId, hasSlackConnector, slackWorkspacesOverride]);

  const s7Applies = !shouldShowConnectSlackCta && cloudContinuityMode === 'desktop-only';
  const s8Applies = Boolean(
    hasSlackConnector &&
    cloudSlackWorkspace?.teamId &&
    cloudSlackWorkspace.status !== 'disconnected' &&
    slackWorkspacesFromIpc &&
    slackWorkspacesFromIpc.length > 0 &&
    !slackWorkspacesFromIpc.some((workspace) => workspace.teamId === cloudSlackWorkspace.teamId),
  );
  const cloudUnavailable = cloudContinuityMode === 'cloud' && effectiveCloudStatus !== null && !isCloudReachable(effectiveCloudStatus);
  const showDesktopFallbackSignal = s7Applies || cloudUnavailable || desktopFallbackEnabled;
  const slackConnected = Boolean(
    hasSlackConnector
    && cloudSlackWorkspace?.teamId
    && cloudSlackWorkspace.status !== 'disconnected',
  );
  const ownerIdentityUnknown = settingsForSignals?.dismissedAnnouncements?.['slack-owner-identity-missing'] === false;

  const handleOpenCloudContinuity = useCallback(() => {
    if (navigation) {
      void navigation.navigate(CLOUD_SETTINGS_URL);
      return;
    }
    const appApi = (window as Window & { appApi?: { openUrl?: (url: string) => void | Promise<void> } }).appApi;
    void appApi?.openUrl?.(CLOUD_SETTINGS_URL);
  }, [navigation]);

  const handleReinstallForListenerWorkspace = useCallback(() => {
    // Route a not-configured `setupGuidance` result to the shared ConnectorSetupDialog so a
    // broken-by-default Slack connector opens the setup dialog instead of dropping the guidance.
    void connectSlackMcp.connect({
      workspaceHint: cloudSlackWorkspace?.teamName,
      onSetupGuidance: setupGuidanceDialog.handleResult,
    });
  }, [cloudSlackWorkspace?.teamName, connectSlackMcp, setupGuidanceDialog]);

  return (
    <SettingSection
      title="Messaging"
      description="Let Rebel answer @mentions from Slack threads, with more messaging apps coming later."
      data-section="messagingChannels"
      data-testid="messaging-channels-section"
    >
      {shouldShowConnectSlackCta ? <MessagingConnectSlackCTA /> : null}
      {s7Applies ? (
        <Notice
          tone="info"
          placement="inline"
          title="Cloud continuity needed for always-on Slack"
          data-testid="messaging-s7-cloud-continuity-notice"
        >
          <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
            <span>Rebel can listen from this computer while it is open. Add cloud continuity to catch Slack mentions when it is not.</span>
            <Button type="button" variant="default" size="sm" onClick={handleOpenCloudContinuity} style={{ justifySelf: 'start' }}>
              Set up cloud continuity
            </Button>
          </div>
        </Notice>
      ) : null}
      {s8Applies ? (
        <Notice
          tone="warning"
          placement="inline"
          title="Slack connector and listener point to different workspaces"
          data-testid="messaging-s8-workspace-mismatch-notice"
        >
          <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
            <span>
              Rebel is listening to {cloudSlackWorkspace?.teamName ?? 'this Slack workspace'}, but the Slack connector is installed for a different workspace.
              Reinstall Slack for {cloudSlackWorkspace?.teamName ?? 'this workspace'} so replies stay in the right thread.
            </span>
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={handleReinstallForListenerWorkspace}
              style={{ justifySelf: 'start' }}
            >
              Reinstall Slack for {cloudSlackWorkspace?.teamName ?? 'this workspace'}
            </Button>
          </div>
        </Notice>
      ) : null}
      {showDesktopFallbackSignal ? (
        <Notice
          tone="info"
          placement="inline"
          density="compact"
          data-testid="messaging-desktop-fallback-signal"
        >
          Listening via desktop fallback — cloud continuity is unreachable. Mentions are caught while this app is open.
        </Notice>
      ) : null}

      {shouldShowConnectSlackCta ? null : <ConnectSlackCard {...connectSlackCardProps} />}

      <div
        role="group"
        aria-label="Inbound messaging policy"
        data-testid="messaging-inbound-policy-subsection"
      >
        <MultiRebelWorkspaceNotice peerInstanceCount={cloudSlackWorkspace?.peerInstanceCount} />
        <UpgradeReviewNotice
          policy={inboundPolicyState.policy}
          recentSendersCount={recentSendersState.senders.length}
          onDismiss={inboundPolicyState.dismissUpgradeReviewNotice}
          onMarkDismissedNow={inboundPolicyState.markUpgradeReviewDismissedNow}
          reviewTargetSectionId="who-can-message-rebel"
        />
        <WhoCanMessageRebelPanel
          policyState={inboundPolicyState}
          slackConnected={slackConnected}
          ownerIdentityUnknown={ownerIdentityUnknown}
        />
        <RecentMessageAttemptsPanel
          policyState={inboundPolicyState}
          recentSendersState={recentSendersState}
          slackConnected={slackConnected}
        />
      </div>

      <div
        role="group"
        aria-labelledby="messaging-more-channels-heading"
        data-testid="messaging-more-channels"
      >
        <h3
          id="messaging-more-channels-heading"
          style={{
            margin: 'var(--space-2) 0 var(--space-1)',
            color: 'var(--color-text-primary)',
            fontSize: '0.95rem',
            fontWeight: 600,
          }}
        >
          More channels
        </h3>
        {MESSAGING_COMING_SOON_CHANNELS.map((channel) => (
          <MessagingComingSoonRow key={channel.platform} {...channel} />
        ))}
      </div>
      <ConnectorSetupDialog
        guidance={setupGuidanceDialog.guidance}
        open={setupGuidanceDialog.isOpen}
        onOpenChange={setupGuidanceDialog.setOpen}
      />
    </SettingSection>
  );
}
