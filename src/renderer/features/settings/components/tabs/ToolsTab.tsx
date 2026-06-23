import { useMemo, useCallback, useState, useEffect, useRef } from 'react';
import type { ToolsTabProps } from './types';
import { UnifiedConnectionsPanel } from '../UnifiedConnectionsPanel';
import { getMcpServersForConnectorsView } from '../../hooks/useUnifiedConnections';

function useRecommendedConnectors(): string[] {
  const [ids, setIds] = useState<string[]>([]);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const fetch = () => {
      window.authApi.getConfig().then((config) => {
        if (mountedRef.current) setIds(config?.recommendedConnectors ?? []);
      }).catch(() => { /* auth config unavailable */ });
    };
    fetch();
    const unsub = window.api.onAuthConfigReceived(() => fetch());
    return () => { mountedRef.current = false; unsub(); };
  }, []);

  return ids;
}

export const ToolsTab = ({
  draftSettings,
  updateDraft,
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
  chooseMcpFile,
  onNavigateToDiagnostics,
  onConfigureWithRebel,
  onBuildConnector,
  onExtendConnector,
  onShareWithCommunity,
  onOpenContributionChat,
  onGetPythonHelp,
  onRequestConnector,
  connectorRevealTarget,
  onConnectorRevealReady,
  mcpRuntimeHealthDegraded,
}: ToolsTabProps) => {
  const allServers = useMemo(() => getMcpServersForConnectorsView(mcpSummary), [mcpSummary]);

  const recommendedConnectorIds = useRecommendedConnectors();

  const handleMcpServerToggle = useCallback(() => {
    updateDraft('mcpServerEnabled', !draftSettings.mcpServerEnabled);
  }, [draftSettings.mcpServerEnabled, updateDraft]);

  return (
    <UnifiedConnectionsPanel
      servers={allServers}
      onUpsertServer={upsertMcpServer}
      onRemoveServer={removeMcpServer}
      onLoadServer={loadMcpServer}
      mcpMutationPending={mcpMutationPending}
      onConfigureWithRebel={onConfigureWithRebel}
      onBuildConnector={onBuildConnector}
      onExtendConnector={onExtendConnector}
      onShareWithCommunity={onShareWithCommunity}
      onOpenContributionChat={onOpenContributionChat}
      onGetPythonHelp={onGetPythonHelp}
      onRefresh={refreshMcpSummary}
      onReloadConnectors={reloadConnectors}
      mcpSummary={mcpSummary}
      mcpSummaryLoading={mcpSummaryLoading}
      mcpSummaryError={mcpSummaryError}
      mcpHealthLoading={mcpHealthLoading}
      onChooseConfigFile={chooseMcpFile}
      onNavigateToDiagnostics={onNavigateToDiagnostics}
      recommendedConnectorIds={recommendedConnectorIds}
      onRequestConnector={onRequestConnector}
      connectorRevealTarget={connectorRevealTarget ?? undefined}
      onConnectorRevealReady={onConnectorRevealReady}
      mcpRuntimeHealthDegraded={mcpRuntimeHealthDegraded}
      externalMcpEnabled={draftSettings.mcpServerEnabled ?? false}
      onToggleExternalMcp={handleMcpServerToggle}
      interactiveViewsEnabled={draftSettings.experimental?.mcpAppsEnabled !== false}
      onToggleInteractiveViews={() => {
        updateDraft('experimental', {
          ...draftSettings.experimental,
          mcpAppsEnabled: draftSettings.experimental?.mcpAppsEnabled === false,
        });
      }}
    />
  );
};
