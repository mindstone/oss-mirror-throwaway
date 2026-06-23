// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnifiedConnectionsPanel } from '../UnifiedConnectionsPanel';
import type { UnifiedConnection } from '../../hooks/useUnifiedConnections';
import {
  buildMcpServerRemovalRestartContext,
  buildMcpServerToggleRestartContext,
  buildSettingsUpsertRestartContext,
} from '@shared/utils/mcpRestartContexts';

const mockShowToast = vi.hoisted(() => vi.fn());
const mockConnectSlack = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockConnectionsState = vi.hoisted(() => ({
  connections: [] as UnifiedConnection[],
}));
const restartDeferredListeners = vi.hoisted(() => new Set<(event: { context: string; activeTurns: number; deferredAt: number }) => void>());
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
    connect: mockConnectSlack,
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
    isConnecting,
    isRemoving,
    deferredKind,
    onConnect,
    onDisconnect,
  }: {
    connection: UnifiedConnection;
    isConnecting?: boolean;
    isRemoving?: boolean;
    deferredKind?: 'connect' | 'disconnect';
    onConnect?: (
      email?: string,
      options?: { launchRebel?: boolean; setupFieldValues?: Record<string, string> },
    ) => void | Promise<void>;
    onDisconnect?: (serverName?: string) => void | Promise<void>;
  }) => (
    <section
      aria-label={`${connection.name} connector card`}
      data-connecting={String(Boolean(isConnecting))}
      data-removing={String(Boolean(isRemoving))}
      data-deferred-kind={deferredKind ?? ''}
    >
      <h3>{connection.name}</h3>
      {connection.status === 'available' ? (
        <button
          type="button"
          aria-label={`Connect ${connection.name}`}
          onClick={() => void onConnect?.(undefined, { launchRebel: true })}
        >
          {deferredKind === 'connect' ? 'Connect queued' : `Connect ${connection.name}`}
        </button>
      ) : (
        <button
          type="button"
          aria-label="Disconnect Slack"
          onClick={() => void onDisconnect?.(connection.serverPreview?.name)}
        >
          {deferredKind === 'disconnect' ? 'Disconnect queued' : 'Disconnect'}
        </button>
      )}
      {deferredKind === 'connect' && (
        <p aria-live="polite" data-testid="connector-deferred-helper">
          Connect queued. Rebel will finish this when the current task wraps up.
        </p>
      )}
      {deferredKind === 'disconnect' && (
        <p aria-live="polite" data-testid="connector-deferred-helper">
          Disconnect queued. Rebel will finish this when the current task wraps up.
        </p>
      )}
    </section>
  ),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const slackConnection: UnifiedConnection = {
  id: 'catalog:bundled-slack',
  name: 'Slack',
  description: 'Team messaging',
  icon: 'MessageSquare',
  status: 'available',
  provider: 'bundled',
  catalogEntry: {
    id: 'bundled-slack',
    name: 'Slack',
    description: 'Team messaging',
    icon: 'MessageSquare',
    provider: 'bundled',
    category: 'communication',
    bundledConfig: {
      serverName: 'Slack',
      authType: 'oauth',
      authApi: 'slackApi',
    },
  },
};

const connectedSlackConnection: UnifiedConnection = {
  ...slackConnection,
  status: 'connected',
  serverPreview: {
    name: 'Slack',
    transport: 'stdio',
    health: 'ok',
    catalogId: 'bundled-slack',
    toolCount: 4,
  },
  health: 'ok',
  toolCount: 4,
};

const bundledLinearConnection: UnifiedConnection = {
  id: 'catalog:bundled-linear',
  name: 'Linear',
  description: 'Issue tracking',
  icon: 'ListChecks',
  status: 'available',
  provider: 'bundled',
  catalogEntry: {
    id: 'bundled-linear',
    name: 'Linear',
    description: 'Issue tracking',
    icon: 'ListChecks',
    provider: 'bundled',
    category: 'productivity',
    bundledConfig: {
      serverName: 'LinearLocal',
      authType: 'none',
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
  onRemoveServer,
}: {
  onRemoveServer?: (serverName: string) => Promise<void>;
} = {}): { root: Root; container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <UnifiedConnectionsPanel
        servers={[]}
        onUpsertServer={vi.fn().mockResolvedValue(undefined)}
        onRemoveServer={onRemoveServer}
        mcpMutationPending={false}
        mcpSummary={{
          status: 'ready',
          mode: 'super-mcp',
          configPath: '/tmp/mcp.json',
          servers: [],
          upstreamCount: 0,
          lastLoadedAt: Date.parse('2026-05-23T12:00:00.000Z'),
        }}
        mcpSummaryLoading={false}
      />,
    );
  });

  return {
    root,
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

type McpAddBundledServerResult = Awaited<ReturnType<NonNullable<typeof window.settingsApi>['mcpAddBundledServer']>>;

function mcpAddBundledServerResult(): McpAddBundledServerResult {
  return {
    summary: {
      status: 'ready',
      mode: 'super-mcp',
      configPath: '/tmp/mcp.json',
      servers: [],
      upstreamCount: 0,
      lastLoadedAt: Date.parse('2026-05-23T12:00:00.000Z'),
    },
  };
}

describe('UnifiedConnectionsPanel Slack connector branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restartDeferredListeners.clear();
    window.api = {
      ...(window.api ?? {}),
      onSuperMcpRestartDeferred: (callback: (event: { context: string; activeTurns: number; deferredAt: number }) => void) => {
        restartDeferredListeners.add(callback);
        return () => {
          restartDeferredListeners.delete(callback);
        };
      },
    };
    window.settingsApi = {
      ...(window.settingsApi ?? {}),
      mcpAddBundledServer: vi.fn().mockResolvedValue(mcpAddBundledServerResult()),
    };
    mockConnectionsState.connections = [slackConnection];
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the Slack connector card affordances and delegates OAuth to useConnectSlackMcpAction', async () => {
    const mounted = renderPanel();

    expect(buttonByName('Slack connector')).toBeTruthy();
    expect(mounted.container.textContent).toContain('Available');

    act(() => {
      buttonByName('Slack connector').click();
    });

    expect(document.querySelector('section[aria-label="Slack connector card"]')).toBeTruthy();
    expect(buttonByName('Connect Slack')).toBeTruthy();

    await act(async () => {
      buttonByName('Connect Slack').click();
      await Promise.resolve();
    });

    expect(trackingMocks.connectorConnectStarted).toHaveBeenCalledWith(
      'Slack',
      'communication',
      {
        connectorType: 'bundled',
        source: 'settings_ui',
        isReconnect: false,
      },
    );
    expect(mockConnectSlack).toHaveBeenCalledWith(expect.objectContaining({
      workspaceHint: undefined,
      connectionName: 'Slack',
      category: 'communication',
      catalogEntry: slackConnection.catalogEntry,
      launchRebel: true,
      connectorType: 'bundled',
      // Stage 5 (260610_gworkspace-mcp-error-disconnect-hang): the panel now
      // always hands the hook a gated wrapper (DA F1 — skips the setup chat
      // when the connect restart was deferred); it delegates to the panel's
      // onConfigureWithRebel prop, undefined here.
      onConfigureWithRebel: expect.any(Function),
      isAttemptCurrent: expect.any(Function),
    }));
    expect(document.querySelector('section[aria-label="Slack connector card"]')).toBeNull();
    expect(mockShowToast).not.toHaveBeenCalled();

    mounted.unmount();
  });

  it('shows connect queued UX for rewritten settings-upsert contexts and ignores toggle deferrals', async () => {
    let resolveAdd: (() => void) | undefined;
    window.settingsApi = {
      ...(window.settingsApi ?? {}),
      mcpAddBundledServer: vi.fn(() => new Promise<McpAddBundledServerResult>((resolve) => {
        resolveAdd = () => resolve(mcpAddBundledServerResult());
      })),
    };
    mockConnectionsState.connections = [bundledLinearConnection];
    const mounted = renderPanel();

    act(() => {
      buttonByName('Linear connector').click();
    });

    await act(async () => {
      buttonByName('Connect Linear').click();
      await Promise.resolve();
    });

    // A toggle deferral for some other card must not light up this connect op
    // (toggle contexts now carry the toggled serverId; cross-op isolation
    // relies on the exact-match contract).
    act(() => {
      for (const listener of restartDeferredListeners) {
        listener({
          context: buildMcpServerToggleRestartContext('SomeOtherServer'),
          activeTurns: 1,
          deferredAt: Date.now(),
        });
      }
    });

    expect(mounted.container.textContent).not.toContain('Connect queued');
    expect(mockShowToast).not.toHaveBeenCalled();

    act(() => {
      for (const listener of restartDeferredListeners) {
        listener({
          context: buildSettingsUpsertRestartContext('ExistingLinearServer'),
          activeTurns: 1,
          deferredAt: Date.now(),
        });
      }
    });

    expect(window.settingsApi.mcpAddBundledServer).toHaveBeenCalledWith(expect.objectContaining({
      serverName: 'LinearLocal',
      catalogId: 'bundled-linear',
    }));
    expect(buttonByName('Connect queued')).toBeTruthy();
    expect(mounted.container.querySelector('[data-testid="connector-deferred-helper"]')?.textContent).toBe(
      'Connect queued. Rebel will finish this when the current task wraps up.',
    );
    expect(mockShowToast).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveAdd?.();
      await Promise.resolve();
    });

    expect(mounted.container.textContent).not.toContain('Connect queued');

    mounted.unmount();
  });

  it('shows disconnect queued UX only for matching restart deferral context and clears on settle', async () => {
    let resolveRemoval: (() => void) | undefined;
    const onRemoveServer = vi.fn(() => new Promise<void>((resolve) => {
      resolveRemoval = resolve;
    }));
    mockConnectionsState.connections = [connectedSlackConnection];
    const mounted = renderPanel({ onRemoveServer });

    act(() => {
      buttonByName('Slack connector').click();
    });

    await act(async () => {
      buttonByName('Disconnect Slack').click();
      await Promise.resolve();
    });

    // A toggle deferral (even for the same server) must not light up the
    // tracked disconnect op — toggle contexts only exact-match toggle ops.
    act(() => {
      for (const listener of restartDeferredListeners) {
        listener({
          context: buildMcpServerToggleRestartContext('Slack'),
          activeTurns: 1,
          deferredAt: Date.now(),
        });
      }
    });

    expect(mounted.container.textContent).not.toContain('Disconnect queued');
    expect(mockShowToast).not.toHaveBeenCalled();

    act(() => {
      for (const listener of restartDeferredListeners) {
        listener({
          context: buildMcpServerRemovalRestartContext('Slack'),
          activeTurns: 1,
          deferredAt: Date.now(),
        });
        listener({
          context: buildMcpServerRemovalRestartContext('Slack'),
          activeTurns: 1,
          deferredAt: Date.now(),
        });
      }
    });

    expect(buttonByName('Disconnect queued')).toBeTruthy();
    expect(mounted.container.querySelector('[data-testid="connector-deferred-helper"]')?.textContent).toBe(
      'Disconnect queued. Rebel will finish this when the current task wraps up.',
    );
    expect(mockShowToast).toHaveBeenCalledTimes(1);
    expect(mockShowToast).toHaveBeenCalledWith({
      title: 'Connector change queued',
      description: 'Rebel will apply it automatically once the current task wraps up. No need to retry.',
      variant: 'info',
      duration: 8000,
    });

    await act(async () => {
      resolveRemoval?.();
      await Promise.resolve();
    });

    expect(mounted.container.textContent).not.toContain('Disconnect queued');

    mounted.unmount();
  });

  // N2 negative case (Stage 4): a SIMULTANEOUS UNRELATED operation's deferred
  // event must NOT light up the current card. Server-removal contexts are never
  // rewritten by main, so disconnect ops match exactly only — a different
  // server's removal event sharing the `mcp-server-removal:` prefix must be
  // ignored. (Under the old prefix-only matcher this briefly flagged the wrong
  // card.)
  it('does NOT flag a disconnect-in-progress card for an unrelated server-removal deferral', async () => {
    let resolveRemoval: (() => void) | undefined;
    const onRemoveServer = vi.fn(() => new Promise<void>((resolve) => {
      resolveRemoval = resolve;
    }));
    mockConnectionsState.connections = [connectedSlackConnection];
    const mounted = renderPanel({ onRemoveServer });

    act(() => {
      buttonByName('Slack connector').click();
    });

    await act(async () => {
      buttonByName('Disconnect Slack').click();
      await Promise.resolve();
    });

    // An unrelated connector's removal deferral arrives while Slack disconnect
    // is in flight. It shares the `mcp-server-removal:` prefix but targets a
    // different exact context.
    act(() => {
      for (const listener of restartDeferredListeners) {
        listener({
          context: buildMcpServerRemovalRestartContext('SomeOtherConnector'),
          activeTurns: 1,
          deferredAt: Date.now(),
        });
      }
    });

    expect(mounted.container.textContent).not.toContain('Disconnect queued');
    expect(mockShowToast).not.toHaveBeenCalled();

    // The matching exact context still lights it up — proves we did not break
    // the real relevant-event path.
    act(() => {
      for (const listener of restartDeferredListeners) {
        listener({
          context: buildMcpServerRemovalRestartContext('Slack'),
          activeTurns: 1,
          deferredAt: Date.now(),
        });
      }
    });

    expect(buttonByName('Disconnect queued')).toBeTruthy();

    await act(async () => {
      resolveRemoval?.();
      await Promise.resolve();
    });

    mounted.unmount();
  });

  // N2 fallback case (Stage 4): main rewrites payload.name for bundled
  // connectors (idempotent catalogId+email match → existing serverName), so the
  // broadcast `settings-upsert:<rewrittenName>` does not byte-equal the tracked
  // `settings-upsert:<originalName>`. The prefix fallback for `connect` ops MUST
  // still match, or we reintroduce the bug Harry's commit fixed (queued UX never
  // lights up for renamed bundled connectors).
  it('still flags a connect-in-progress card via prefix fallback when main rewrites the bundled server name', async () => {
    let resolveAdd: (() => void) | undefined;
    window.settingsApi = {
      ...(window.settingsApi ?? {}),
      mcpAddBundledServer: vi.fn(() => new Promise<McpAddBundledServerResult>((resolve) => {
        resolveAdd = () => resolve(mcpAddBundledServerResult());
      })),
    };
    mockConnectionsState.connections = [bundledLinearConnection];
    const mounted = renderPanel();

    act(() => {
      buttonByName('Linear connector').click();
    });

    await act(async () => {
      buttonByName('Connect Linear').click();
      await Promise.resolve();
    });

    // Tracked context is `settings-upsert:LinearLocal`; main broadcasts the
    // rewritten `settings-upsert:ExistingLinearServer`. Exact match fails →
    // connect-kind prefix fallback must still flag the card.
    act(() => {
      for (const listener of restartDeferredListeners) {
        listener({
          context: buildSettingsUpsertRestartContext('ExistingLinearServer'),
          activeTurns: 1,
          deferredAt: Date.now(),
        });
      }
    });

    expect(buttonByName('Connect queued')).toBeTruthy();
    expect(mounted.container.querySelector('[data-testid="connector-deferred-helper"]')?.textContent).toBe(
      'Connect queued. Rebel will finish this when the current task wraps up.',
    );

    await act(async () => {
      resolveAdd?.();
      await Promise.resolve();
    });

    mounted.unmount();
  });
});
