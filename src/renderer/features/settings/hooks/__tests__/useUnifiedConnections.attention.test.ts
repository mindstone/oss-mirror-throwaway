import { describe, it, expect } from 'vitest';
import {
  computeUnifiedConnectionsSnapshot,
  countConnectorConfigAttentionSignals,
  getConnectionAttentionState,
  getMcpServersForConnectorsView,
} from '../useUnifiedConnections';
import type { McpServerPreview, McpConfigSummary } from '@shared/types';

const BUNDLED_ARG = '/resources/mcp/fathom-test.mjs';

function fathomInstance(
  partial: Partial<McpServerPreview> & Pick<McpServerPreview, 'name'>,
): McpServerPreview {
  return {
    transport: 'stdio',
    catalogId: 'bundled-fathom',
    args: [BUNDLED_ARG],
    ...partial,
  };
}

describe('getMcpServersForConnectorsView', () => {
  it('prefers editableServers and appends router upstream servers', () => {
    const summary = {
      editableServers: [{ name: 'editable', transport: 'stdio' } as McpServerPreview],
      servers: [{ name: 'legacy', transport: 'stdio' } as McpServerPreview],
      router: {
        upstreamServers: [{ name: 'upstream', transport: 'stdio' } as McpServerPreview],
      },
    } as McpConfigSummary;

    expect(getMcpServersForConnectorsView(summary).map((s) => s.name)).toEqual([
      'editable',
      'upstream',
    ]);
  });

  it('falls back to servers when editableServers is absent', () => {
    const summary = {
      servers: [{ name: 'only', transport: 'stdio' } as McpServerPreview],
    } as McpConfigSummary;
    expect(getMcpServersForConnectorsView(summary).map((s) => s.name)).toEqual(['only']);
  });
});

describe('countConnectorConfigAttentionSignals', () => {
  it('counts one grouped connector when any instance needs attention', () => {
    const servers = [
      fathomInstance({ name: 'Fathom-a', email: '[external-email]', health: 'ok' }),
      fathomInstance({ name: 'Fathom-b', email: '[external-email]', health: 'error' }),
    ];
    expect(countConnectorConfigAttentionSignals(servers)).toBe(1);
  });

  it('excludes fully inactive grouped connectors', () => {
    const servers = [
      fathomInstance({ name: 'Fathom-a', email: '[external-email]', health: 'ok', disabled: true }),
      fathomInstance({ name: 'Fathom-b', email: '[external-email]', health: 'ok', disabled: true }),
    ];
    expect(countConnectorConfigAttentionSignals(servers)).toBe(0);
  });

  it('counts grouped connectors with missing email identity', () => {
    const servers = [fathomInstance({ name: 'Fathom-stale', health: 'ok' })];
    expect(countConnectorConfigAttentionSignals(servers)).toBe(1);
  });

  it('counts one grouped connector when an instance needs reconnect despite healthy MCP probes (Stage 3)', () => {
    const servers = [
      fathomInstance({ name: 'Fathom-a', email: '[external-email]', health: 'ok' }),
      fathomInstance({ name: 'Fathom-b', email: '[external-email]', health: 'ok', needsReconnect: true }),
    ];
    expect(countConnectorConfigAttentionSignals(servers)).toBe(1);
  });
});

describe('needsReconnect instance plumbing (Stage 3, 260611_calendar-cache-attention)', () => {
  it('passes needsReconnect through grouped-instance mapping', () => {
    const { rawBeforeCategoryAccount } = computeUnifiedConnectionsSnapshot({
      servers: [
        fathomInstance({ name: 'Fathom-a', email: '[external-email]', health: 'ok' }),
        fathomInstance({ name: 'Fathom-b', email: '[external-email]', health: 'ok', needsReconnect: true }),
      ],
      includeAvailable: false,
    });
    const grouped = rawBeforeCategoryAccount.find((c) => c.instances && c.instances.length === 2);
    expect(grouped).toBeTruthy();
    const byName = new Map(grouped!.instances!.map((i) => [i.serverName, i]));
    expect(byName.get('Fathom-b')?.needsReconnect).toBe(true);
    expect(byName.get('Fathom-a')?.needsReconnect).toBeUndefined();
  });

  it('getConnectionAttentionState treats a needs-reconnect instance as needs-attention', () => {
    const { rawBeforeCategoryAccount } = computeUnifiedConnectionsSnapshot({
      servers: [
        fathomInstance({ name: 'Fathom-a', email: '[external-email]', health: 'ok' }),
        fathomInstance({ name: 'Fathom-b', email: '[external-email]', health: 'ok', needsReconnect: true }),
      ],
      includeAvailable: false,
    });
    const grouped = rawBeforeCategoryAccount.find((c) => c.instances && c.instances.length === 2);
    expect(grouped).toBeTruthy();
    expect(getConnectionAttentionState(grouped!)).toBe('needs-attention');
  });

  it('disabled treatment wins: a fully disabled connector stays inactive even when latched', () => {
    const { rawBeforeCategoryAccount } = computeUnifiedConnectionsSnapshot({
      servers: [
        fathomInstance({ name: 'Fathom-a', email: '[external-email]', health: 'ok', disabled: true, needsReconnect: true }),
        fathomInstance({ name: 'Fathom-b', email: '[external-email]', health: 'ok', disabled: true }),
      ],
      includeAvailable: false,
    });
    const grouped = rawBeforeCategoryAccount.find((c) => c.instances && c.instances.length === 2);
    expect(grouped).toBeTruthy();
    expect(getConnectionAttentionState(grouped!)).toBe('inactive');
  });
});
