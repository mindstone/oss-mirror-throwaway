import type { McpConfigSummary, McpServerPreview } from '@shared/types';

const INTERNAL_REBEL_CONNECTOR_NAMES = new Set([
  'RebelInternal',
  'RebelInbox',
  'RebelSearch',
  'RebelSearchAndConversations',
  'RebelAutomations',
  'RebelSpaces',
  'RebelSettings',
  'RebelMcpConnectors',
  'RebelDiagnostics',
  'RebelCanvas',
  'RebelCommunity',
  'RebelPlugins',
]);

function getConnectorIdentity(server: McpServerPreview): string {
  return [
    server.catalogId ?? '',
    server.name,
    server.email ?? '',
    server.workspace ?? '',
    server.url ?? '',
    server.command ?? '',
    ...(server.args ?? []),
  ].join('\u0000');
}

function isInternalRebelConnector(server: McpServerPreview): boolean {
  return INTERNAL_REBEL_CONNECTOR_NAMES.has(server.name);
}

export function countEnabledUserAddedConnectors(
  mcpSummary: McpConfigSummary | null | undefined,
): number {
  if (!mcpSummary) return 0;

  const editableServers = mcpSummary.editableServers ?? mcpSummary.servers ?? [];
  const routerServers = mcpSummary.router?.upstreamServers ?? [];
  const enabledConnectorIds = new Set<string>();

  for (const server of [...editableServers, ...routerServers]) {
    if (server.disabled) continue;
    if (isInternalRebelConnector(server)) continue;
    enabledConnectorIds.add(getConnectorIdentity(server));
  }

  return enabledConnectorIds.size;
}
