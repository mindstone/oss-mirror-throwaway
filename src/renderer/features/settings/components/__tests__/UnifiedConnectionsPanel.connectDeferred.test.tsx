// @vitest-environment happy-dom

/**
 * Stage 5 (260610_gworkspace-mcp-error-disconnect-hang): queued-UX for the
 * settings-panel connect branches whose IPC now resolves on deferral (Stage 4)
 * — Microsoft/Discourse (auth handler owns registration: previously tracked
 * NOTHING), Google leg-2 re-track, Slack panel-side tracking — plus the DA-F1
 * gate: a connect marked deferred must NOT auto-launch the "Set up with
 * Rebel" chat (its prompt immediately asks Rebel to list_tools a connector
 * whose routing has not applied yet).
 *
 * Mocks `ExpandedConnectionCard` (branch-level coverage, mirroring
 * `UnifiedConnectionsPanel.slackBranch.test.tsx`); the real-card chain for the
 * "Add another account" surface lives in
 * `UnifiedConnectionsPanel.cardDeferred.test.tsx`.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnifiedConnectionsPanel } from '../UnifiedConnectionsPanel';
import type { UnifiedConnection } from '../../hooks/useUnifiedConnections';

const mockShowToast = vi.hoisted(() => vi.fn());
const mockConnectSlack = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockConnectionsState = vi.hoisted(() => ({
  connections: [] as UnifiedConnection[],
}));
const restartDeferredListeners = vi.hoisted(
  () => new Set<(event: { context: string; activeTurns: number; deferredAt: number }) => void>(),
);
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

vi.mock('../../hooks/useConnectorSetupGuidance', () => ({
  useConnectorSetupGuidance: () => ({
    dialog: null,
    handleResult: vi.fn().mockReturnValue(false),
  }),
  isOAuthSetupGuidance: () => false,
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
  }: {
    connection: UnifiedConnection;
    onClick: () => void;
  }) => (
    <button type="button" aria-label={`${connection.name} connector`} onClick={onClick}>
      {connection.name}
    </button>
  ),
}));

vi.mock('../ExpandedConnectionCard', () => ({
  ExpandedConnectionCard: ({
    connection,
    deferredKind,
    onConnect,
  }: {
    connection: UnifiedConnection;
    deferredKind?: 'connect' | 'disconnect' | 'toggle';
    onConnect?: (
      email?: string,
      options?: { launchRebel?: boolean },
    ) => void | Promise<void>;
  }) => (
    <section aria-label={`${connection.name} connector card`} data-deferred-kind={deferredKind ?? ''}>
      <h3>{connection.name}</h3>
      <button
        type="button"
        aria-label={`Connect ${connection.name}`}
        onClick={() => void onConnect?.(undefined, { launchRebel: true })}
      >
        {deferredKind === 'connect' ? 'Connect queued' : `Connect ${connection.name}`}
      </button>
      {deferredKind === 'connect' && (
        <p aria-live="polite" data-testid="connector-deferred-helper">
          Connect queued. Rebel will finish this when the current task wraps up.
        </p>
      )}
    </section>
  ),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function bundledOAuthConnection(
  name: string,
  catalogId: string,
  serverName: string,
  authApi: string,
): UnifiedConnection {
  return {
    id: `catalog:${catalogId}`,
    name,
    description: name,
    icon: 'Plug',
    status: 'available',
    provider: 'bundled',
    catalogEntry: {
      id: catalogId,
      name,
      description: name,
      icon: 'Plug',
      provider: 'bundled',
      category: 'productivity',
      bundledConfig: {
        serverName,
        authType: 'oauth',
        authApi,
      },
    } as unknown as UnifiedConnection['catalogEntry'],
  };
}

const microsoftConnection = bundledOAuthConnection(
  'Microsoft 365',
  'bundled-microsoft',
  'Microsoft365',
  'microsoftApi',
);
const discourseConnection = bundledOAuthConnection(
  'Rebels Community',
  'bundled-discourse',
  'DiscourseWrite',
  'discourseApi',
);
const googleConnection = bundledOAuthConnection(
  'Google Workspace',
  'bundled-google',
  'GoogleWorkspace',
  'googleWorkspaceApi',
);
const slackConnection = bundledOAuthConnection(
  'Slack',
  'bundled-slack',
  'Slack',
  'slackApi',
);

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
  onConfigureWithRebel,
}: {
  onConfigureWithRebel?: (params: unknown) => void;
} = {}): { root: Root; container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <UnifiedConnectionsPanel
        servers={[]}
        onUpsertServer={vi.fn().mockResolvedValue(undefined)}
        onConfigureWithRebel={onConfigureWithRebel}
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

function fireRestartDeferred(context: string): void {
  act(() => {
    for (const listener of restartDeferredListeners) {
      listener({ context, activeTurns: 1, deferredAt: Date.now() });
    }
  });
}

describe('UnifiedConnectionsPanel connect branches — resolve-on-deferral queued UX (Stage 5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restartDeferredListeners.clear();
    window.api = {
      ...(window.api ?? {}),
      onSuperMcpRestartDeferred: (
        callback: (event: { context: string; activeTurns: number; deferredAt: number }) => void,
      ) => {
        restartDeferredListeners.add(callback);
        return () => {
          restartDeferredListeners.delete(callback);
        };
      },
    } as never;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('lights the queued state for a Microsoft connect when its restart is deferred', async () => {
    let resolveAuth: (() => void) | undefined;
    window.microsoftApi = {
      ...(window.microsoftApi ?? {}),
      startAuth: vi.fn(
        () =>
          new Promise<{ success: boolean; email?: string }>((resolve) => {
            resolveAuth = () => resolve({ success: true, email: 'alice@example.com' });
          }),
      ),
    } as never;
    mockConnectionsState.connections = [microsoftConnection];
    const mounted = renderPanel();

    act(() => {
      buttonByName('Microsoft 365 connector').click();
    });
    await act(async () => {
      buttonByName('Connect Microsoft 365').click();
      await Promise.resolve();
    });

    expect(window.microsoftApi.startAuth).toHaveBeenCalledTimes(1);
    expect(mounted.container.textContent).not.toContain('Connect queued');

    // Context literal on purpose — byte-identity with the main-process emitter.
    fireRestartDeferred('microsoft-connect');

    expect(
      mounted.container.querySelector('[data-testid="connector-deferred-helper"]')?.textContent,
    ).toContain('Connect queued');
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Connector change queued' }),
    );

    await act(async () => {
      resolveAuth?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mounted.container.textContent).not.toContain('Connect queued');

    mounted.unmount();
  });

  // Stage 5 refinement (GPT-F1 ≡ Claude-F1): the settings-upsert prefix
  // fallback exists for main's payload.name rewrites and only makes sense when
  // the TRACKED context is itself `settings-upsert:*`. A static-context
  // connect (microsoft-connect etc.) must NOT be marked deferred by an
  // unrelated `settings-upsert:*` deferral — pre-refinement this showed a
  // false queued toast AND falsely suppressed the post-connect setup chat via
  // the DA-F1 gate. (Positive prefix-fallback coverage for genuinely
  // settings-upsert-tracked ops lives in UnifiedConnectionsPanel.slackBranch:
  // "still flags a connect-in-progress card via prefix fallback…".)
  it('ignores an unrelated settings-upsert deferral while a static-context connect is tracked (no queued UI, no launchRebel suppression)', async () => {
    const onConfigureWithRebel = vi.fn();
    let resolveAuth: (() => void) | undefined;
    window.microsoftApi = {
      ...(window.microsoftApi ?? {}),
      startAuth: vi.fn(
        () =>
          new Promise<{ success: boolean; email?: string }>((resolve) => {
            resolveAuth = () => resolve({ success: true, email: 'alice@example.com' });
          }),
      ),
    } as never;
    mockConnectionsState.connections = [microsoftConnection];
    const mounted = renderPanel({ onConfigureWithRebel });

    act(() => {
      buttonByName('Microsoft 365 connector').click();
    });
    await act(async () => {
      buttonByName('Connect Microsoft 365').click();
      await Promise.resolve();
    });

    // Unrelated settings-upsert deferral (e.g. another connector's add-server
    // leg) lands during the OAuth window.
    fireRestartDeferred('settings-upsert:Other');

    expect(mounted.container.textContent).not.toContain('Connect queued');
    expect(mockShowToast).not.toHaveBeenCalled();

    // The idle launchRebel path must NOT be gated by the foreign deferral.
    await act(async () => {
      resolveAuth?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onConfigureWithRebel).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: 'Microsoft365', isNewConnection: true }),
    );

    mounted.unmount();
  });

  it('lights the queued state for a Discourse connect when its restart is deferred', async () => {
    let resolveAuth: (() => void) | undefined;
    window.discourseApi = {
      ...(window.discourseApi ?? {}),
      startAuth: vi.fn(
        () =>
          new Promise<{ success: boolean; username?: string }>((resolve) => {
            resolveAuth = () => resolve({ success: true, username: 'greg' });
          }),
      ),
    } as never;
    mockConnectionsState.connections = [discourseConnection];
    const mounted = renderPanel();

    act(() => {
      buttonByName('Rebels Community connector').click();
    });
    await act(async () => {
      buttonByName('Connect Rebels Community').click();
      await Promise.resolve();
    });

    fireRestartDeferred('discourse-connect');

    expect(
      mounted.container.querySelector('[data-testid="connector-deferred-helper"]')?.textContent,
    ).toContain('Connect queued');

    await act(async () => {
      resolveAuth?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mounted.container.textContent).not.toContain('Connect queued');

    mounted.unmount();
  });

  it('re-tracks the Google connect for leg 2 so a google-workspace-connect deferral lights the card', async () => {
    let resolveAuth: (() => void) | undefined;
    window.settingsApi = {
      ...(window.settingsApi ?? {}),
      mcpAddBundledServer: vi.fn().mockResolvedValue({}),
    } as never;
    window.googleWorkspaceApi = {
      ...(window.googleWorkspaceApi ?? {}),
      startAuth: vi.fn(
        () =>
          new Promise<{ success: boolean; email?: string }>((resolve) => {
            resolveAuth = () => resolve({ success: true, email: 'alice@example.com' });
          }),
      ),
    } as never;
    mockConnectionsState.connections = [googleConnection];
    const mounted = renderPanel();

    act(() => {
      buttonByName('Google Workspace connector').click();
    });
    await act(async () => {
      buttonByName('Connect Google Workspace').click();
      // Flush leg 1 (mcpAddBundledServer) so leg 2 re-tracks before the event.
      await Promise.resolve();
      await Promise.resolve();
    });

    // Cross-op isolation: another connector's deferral must not light this op.
    fireRestartDeferred('slack-connect');
    expect(mounted.container.textContent).not.toContain('Connect queued');
    expect(mockShowToast).not.toHaveBeenCalled();

    // The leg-2 context could never match the leg-1 `settings-upsert:*` op —
    // only the re-track makes this light up.
    fireRestartDeferred('google-workspace-connect');
    expect(
      mounted.container.querySelector('[data-testid="connector-deferred-helper"]')?.textContent,
    ).toContain('Connect queued');

    await act(async () => {
      resolveAuth?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mounted.container.textContent).not.toContain('Connect queued');

    mounted.unmount();
  });

  it('lights the queued state for the panel Slack branch and gates the hook launchRebel callback (DA F1)', async () => {
    const onConfigureWithRebel = vi.fn();
    let resolveSlack: (() => void) | undefined;
    mockConnectSlack.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSlack = () => resolve();
        }),
    );
    mockConnectionsState.connections = [slackConnection];
    const mounted = renderPanel({ onConfigureWithRebel });

    act(() => {
      buttonByName('Slack connector').click();
    });
    await act(async () => {
      buttonByName('Connect Slack').click();
      await Promise.resolve();
    });

    fireRestartDeferred('slack-connect');
    expect(
      mounted.container.querySelector('[data-testid="connector-deferred-helper"]')?.textContent,
    ).toContain('Connect queued');

    // The panel hands the hook a GATED wrapper: with the op deferred, invoking
    // it (as the hook would on launchRebel) must not reach the real callback.
    const hookArgs = mockConnectSlack.mock.calls[0][0] as {
      onConfigureWithRebel?: (params: unknown) => void;
    };
    expect(hookArgs.onConfigureWithRebel).toBeTypeOf('function');
    hookArgs.onConfigureWithRebel?.({ serverName: 'Slack-mindstone' });
    expect(onConfigureWithRebel).not.toHaveBeenCalled();

    await act(async () => {
      resolveSlack?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    mounted.unmount();
  });

  it('passes the Slack launchRebel callback through when the connect was not deferred', async () => {
    const onConfigureWithRebel = vi.fn();
    mockConnectSlack.mockResolvedValue(undefined);
    mockConnectionsState.connections = [slackConnection];
    const mounted = renderPanel({ onConfigureWithRebel });

    act(() => {
      buttonByName('Slack connector').click();
    });
    await act(async () => {
      buttonByName('Connect Slack').click();
      await Promise.resolve();
    });

    const hookArgs = mockConnectSlack.mock.calls[0][0] as {
      onConfigureWithRebel?: (params: unknown) => void;
    };
    hookArgs.onConfigureWithRebel?.({ serverName: 'Slack-mindstone' });
    expect(onConfigureWithRebel).toHaveBeenCalledWith({ serverName: 'Slack-mindstone' });

    mounted.unmount();
  });

  // DA F4: the deferred-launchRebel suppression, end-to-end through the
  // bundled branch — a deferred event during the tracked connect must result
  // in onConfigureWithRebel NOT being called when the held auth IPC resolves.
  it('skips the post-connect setup chat when the connect restart was deferred (DA F1)', async () => {
    const onConfigureWithRebel = vi.fn();
    let resolveAuth: (() => void) | undefined;
    window.microsoftApi = {
      ...(window.microsoftApi ?? {}),
      startAuth: vi.fn(
        () =>
          new Promise<{ success: boolean; email?: string }>((resolve) => {
            resolveAuth = () => resolve({ success: true, email: 'alice@example.com' });
          }),
      ),
    } as never;
    mockConnectionsState.connections = [microsoftConnection];
    const mounted = renderPanel({ onConfigureWithRebel });

    act(() => {
      buttonByName('Microsoft 365 connector').click();
    });
    await act(async () => {
      buttonByName('Connect Microsoft 365').click();
      await Promise.resolve();
    });

    // Deferral lands while the auth IPC is held (main emits the broadcast
    // synchronously before early-resolving the connect IPC).
    fireRestartDeferred('microsoft-connect');

    await act(async () => {
      resolveAuth?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(trackingMocks.connectorConnected).toHaveBeenCalled();
    expect(onConfigureWithRebel).not.toHaveBeenCalled();

    mounted.unmount();
  });

  it('still launches the post-connect setup chat on the idle (non-deferred) path', async () => {
    const onConfigureWithRebel = vi.fn();
    window.microsoftApi = {
      ...(window.microsoftApi ?? {}),
      startAuth: vi.fn().mockResolvedValue({ success: true, email: 'alice@example.com' }),
    } as never;
    mockConnectionsState.connections = [microsoftConnection];
    const mounted = renderPanel({ onConfigureWithRebel });

    act(() => {
      buttonByName('Microsoft 365 connector').click();
    });
    await act(async () => {
      buttonByName('Connect Microsoft 365').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onConfigureWithRebel).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: 'Microsoft365', isNewConnection: true }),
    );

    mounted.unmount();
  });
});
