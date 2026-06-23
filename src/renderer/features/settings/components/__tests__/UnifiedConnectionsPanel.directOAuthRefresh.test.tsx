// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnifiedConnectionsPanel } from '../UnifiedConnectionsPanel';
import type { UnifiedConnection } from '../../hooks/useUnifiedConnections';
import type { McpServerUpsertPayload } from '@shared/types';

const mockShowToast = vi.hoisted(() => vi.fn());
const mockConnectionsState = vi.hoisted(() => ({
  connections: [] as UnifiedConnection[],
}));
const trackingMocks = vi.hoisted(() => ({
  connectorViewed: vi.fn(),
  connectorConnectStarted: vi.fn(),
  connectorConnected: vi.fn(),
  connectorConnectionFailed: vi.fn(),
  connectorDisconnected: vi.fn(),
  customMcpServerClicked: vi.fn(),
}));

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  LayoutGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
}));

vi.mock('@renderer/contexts/AppContext', () => ({
  useAppContext: () => ({ showToast: mockShowToast }),
}));

vi.mock('../../SettingsProvider', () => ({
  useSettings: () => ({ settings: {} }),
}));

vi.mock('../../hooks/useAppBridgePairedCount', () => ({
  useAppBridgePairedCount: () => ({ pairedCount: 0, refresh: vi.fn() }),
}));

vi.mock('../../hooks/useConnectSlackMcpAction', () => ({
  useConnectSlackMcpAction: () => ({
    connect: vi.fn(),
    isInFlight: false,
  }),
}));

vi.mock('../../hooks/useUnifiedConnections', () => ({
  useUnifiedConnections: () => ({
    connections: mockConnectionsState.connections,
    categoryTabs: [],
  }),
  computeUnifiedConnectionsSnapshot: () => ({
    connections: mockConnectionsState.connections,
  }),
  getConnectionAttentionState: () => 'healthy',
}));

vi.mock('@renderer/src/tracking', () => ({
  tracking: {
    settings: trackingMocks,
  },
}));

vi.mock('../ConnectionChip', () => ({
  ConnectionChip: ({
    connection,
    onClick,
    'aria-selected': ariaSelected,
  }: {
    connection: UnifiedConnection;
    onClick: () => void;
    'aria-selected'?: boolean;
  }) => (
    <button
      type="button"
      aria-label={`${connection.name} connector`}
      aria-selected={ariaSelected}
      onClick={onClick}
    >
      {connection.name}
    </button>
  ),
}));

vi.mock('../ExpandedConnectionCard', () => ({
  ExpandedConnectionCard: ({
    connection,
    onConnect,
  }: {
    connection: UnifiedConnection;
    onConnect?: (
      email?: string,
      options?: { launchRebel?: boolean; setupFieldValues?: Record<string, string> },
    ) => void | Promise<void>;
  }) => (
    <section aria-label={`${connection.name} connector card`}>
      <h3>{connection.name}</h3>
      <button
        type="button"
        aria-label={`Connect ${connection.name}`}
        onClick={() => void onConnect?.()}
      >
        Connect {connection.name}
      </button>
    </section>
  ),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stripeConnection: UnifiedConnection = {
  id: 'catalog:stripe',
  name: 'Stripe',
  description: 'Payments',
  icon: 'CreditCard',
  status: 'available',
  provider: 'direct',
  catalogEntry: {
    id: 'stripe',
    name: 'Stripe',
    description: 'Payments',
    icon: 'CreditCard',
    provider: 'direct',
    category: 'sales',
    mcpConfig: {
      transport: 'http',
      url: 'https://mcp.stripe.com/',
      oauth: true,
    },
  },
};

function buttonByName(name: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.getAttribute('aria-label') === name || candidate.textContent === name,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${name}`);
  }
  return button;
}

function renderPanel({
  onUpsertServer = vi.fn().mockResolvedValue(undefined),
  onRefresh = vi.fn(),
}: {
  onUpsertServer?: (payload: McpServerUpsertPayload) => Promise<void>;
  onRefresh?: () => void;
} = {}): { root: Root; container: HTMLDivElement; unmount: () => void; onRefresh: () => void; onUpsertServer: typeof onUpsertServer } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <UnifiedConnectionsPanel
        servers={[]}
        onUpsertServer={onUpsertServer}
        mcpMutationPending={false}
        onRefresh={onRefresh}
        mcpSummary={{
          status: 'ready',
          mode: 'super-mcp',
          configPath: '/tmp/mcp.json',
          servers: [],
          upstreamCount: 0,
          lastLoadedAt: Date.parse('2026-05-28T12:00:00.000Z'),
        }}
        mcpSummaryLoading={false}
      />,
    );
  });

  return {
    root,
    container,
    onRefresh,
    onUpsertServer,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('UnifiedConnectionsPanel direct OAuth refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectionsState.connections = [stripeConnection];
    window.api = {
      ...(window.api ?? {}),
      onSuperMcpRestartDeferred: vi.fn(() => vi.fn()),
    };
    window.miscApi = {
      ...(window.miscApi ?? {}),
      mcpAuthenticate: vi.fn().mockResolvedValue({
        success: true,
        status: 'authenticated',
      }),
    };
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('refreshes the MCP summary after a direct HTTP OAuth connector authenticates successfully', async () => {
    const onRefresh = vi.fn();
    const onUpsertServer = vi.fn().mockResolvedValue(undefined);
    const mounted = renderPanel({ onUpsertServer, onRefresh });

    act(() => {
      buttonByName('Stripe connector').click();
    });

    await act(async () => {
      buttonByName('Connect Stripe').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onUpsertServer).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Stripe',
      transport: 'http',
      url: 'https://mcp.stripe.com/',
      oauth: true,
      catalogId: 'stripe',
      lastConnectedAt: expect.any(Number),
    }));
    expect(window.miscApi.mcpAuthenticate).toHaveBeenCalledWith({ serverId: 'Stripe' });
    expect(onRefresh).toHaveBeenCalledTimes(1);

    mounted.unmount();
  });
});
