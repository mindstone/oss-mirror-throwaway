import { describe, expect, it } from 'vitest';
import type { McpConfigSummary, McpServerPreview } from '@shared/types';
import { countEnabledUserAddedConnectors } from '../connectorCounts';

function server(overrides: Partial<McpServerPreview> & Pick<McpServerPreview, 'name'>): McpServerPreview {
  return {
    transport: 'stdio',
    ...overrides,
  };
}

function summary(overrides: Partial<McpConfigSummary>): McpConfigSummary {
  return {
    status: 'ready',
    mode: 'super-mcp',
    configPath: '/tmp/super-mcp-router.json',
    servers: [],
    upstreamCount: 0,
    lastLoadedAt: Date.now(),
    ...overrides,
  };
}

describe('countEnabledUserAddedConnectors', () => {
  it('counts enabled connectors from the same source set as the connectors view', () => {
    const result = countEnabledUserAddedConnectors(summary({
      editableServers: [
        server({ name: 'GoogleWorkspace', catalogId: 'bundled-google' }),
        server({ name: 'CustomCrm', command: 'node', args: ['crm.js'] }),
        server({ name: 'DisabledSlack', catalogId: 'bundled-slack', disabled: true }),
      ],
      router: {
        configPaths: [],
        upstreamServers: [
          server({ name: 'HubSpot', catalogId: 'bundled-hubspot' }),
          server({ name: 'LocalDocs', url: 'https://example.com/mcp' }),
        ],
        upstreamCount: 2,
        httpMode: 'http',
        isRunning: true,
      },
    }));

    expect(result).toBe(4);
  });

  it('excludes Rebel internal connectors from user-added setup progress', () => {
    const result = countEnabledUserAddedConnectors(summary({
      editableServers: [
        server({ name: 'GoogleWorkspace', catalogId: 'bundled-google' }),
        server({ name: 'RebelCommunity' }),
        server({ name: 'RebelAutomations' }),
        server({ name: 'RebelCanvas' }),
        server({ name: 'RebelDiagnostics' }),
        server({ name: 'RebelInbox' }),
        server({ name: 'RebelMcpConnectors' }),
        server({ name: 'RebelPlugins' }),
        server({ name: 'RebelSearchAndConversations' }),
        server({ name: 'RebelSettings' }),
        server({ name: 'RebelSpaces' }),
      ],
      router: {
        configPaths: [],
        upstreamServers: [
          server({ name: 'GoogleWorkspace', catalogId: 'bundled-google' }),
          server({ name: 'RebelInbox' }),
        ],
        upstreamCount: 11,
        httpMode: 'http',
        isRunning: true,
      },
    }));

    expect(result).toBe(1);
  });

  it('deduplicates connectors that appear in editable and router summaries', () => {
    const duplicate = server({
      name: 'Slack',
      catalogId: 'bundled-slack',
      workspace: 'Rebel',
    });

    const result = countEnabledUserAddedConnectors(summary({
      editableServers: [duplicate],
      router: {
        configPaths: [],
        upstreamServers: [duplicate],
        upstreamCount: 1,
        httpMode: 'http',
        isRunning: true,
      },
    }));

    expect(result).toBe(1);
  });
});
