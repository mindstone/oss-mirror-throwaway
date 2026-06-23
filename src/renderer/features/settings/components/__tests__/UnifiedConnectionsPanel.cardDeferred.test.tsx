// @vitest-environment happy-dom

/**
 * B-F1 coverage: the queued/deferred state must light up for the card
 * entrypoints that bypassed the parent's deferred tracker before this fix —
 * (1) `ExpandedConnectionCard.handleSaveSetup()` (setup-form / API-key connects)
 * and (2) per-account disconnect (`AccountInstancesList` → onRemove).
 *
 * Unlike `UnifiedConnectionsPanel.slackBranch.test.tsx` (which MOCKS the card),
 * this suite renders the REAL `ExpandedConnectionCard` inside the REAL
 * `UnifiedConnectionsPanel`, so the full chain is exercised end-to-end:
 *   card setup-form save → onTrackDeferredOperation (parent single-slot)
 *   → super-mcp:restart-deferred broadcast → deferredKind prop → queued render.
 *
 * Stage 3 of docs/plans/260609_fix-harry-review-findings/PLAN.md.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@renderer/components/ui';
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
const restartDeferredListeners = vi.hoisted(
  () => new Set<(event: { context: string; activeTurns: number; deferredAt: number }) => void>(),
);
const trackingMocks = vi.hoisted(() => ({
  connectorViewed: vi.fn(),
  connectorConnectStarted: vi.fn(),
  connectorConnected: vi.fn(),
  connectorConnectionFailed: vi.fn(),
  connectorDisconnected: vi.fn(),
  connectorConfigureWithRebelClicked: vi.fn(),
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

// SettingsProvider exposes both useSettings (panel) and useSettingsSafe (card).
vi.mock('../../SettingsProvider', () => ({
  useSettings: () => ({ settings: {} }),
  useSettingsSafe: () => null,
}));

vi.mock('@renderer/contexts/NavigationContext', () => ({
  useNavigationSafe: () => null,
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

// Card's contribution hook hits window.contributionApi on mount — keep it inert.
vi.mock('../../hooks/useConnectorContribution', () => ({
  useConnectorContribution: () => ({ contribution: null, isLoading: false }),
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

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Available API-key connector. `handleSaveSetup` for an api-key connector calls
// window.settingsApi.mcpAddBundledServer directly (no parent handleConnect) — the
// exact entrypoint B-F1 fixes. showSetupUI is true for an available api-key
// connector, so the SetupFieldsForm renders on mount (no extra "Set up" click).
const apiKeyConnection: UnifiedConnection = {
  id: 'catalog:bundled-freshdesk',
  name: 'Freshdesk',
  description: 'Support desk',
  icon: 'LifeBuoy',
  status: 'available',
  provider: 'bundled',
  catalogEntry: {
    id: 'bundled-freshdesk',
    name: 'Freshdesk',
    description: 'Support desk',
    icon: 'LifeBuoy',
    provider: 'bundled',
    category: 'productivity',
    requiresSetup: true,
    bundledConfig: {
      serverName: 'Freshdesk',
      authType: 'api-key',
    },
    setupFields: [
      { id: 'domain', label: 'Domain', type: 'text' },
      { id: 'apiKey', label: 'API Key', type: 'password' },
    ],
  } as unknown as UnifiedConnection['catalogEntry'],
};

// Connected multi-instance API-key connector (email identity) → renders
// AccountInstancesList with per-row remove. Per-account remove must now route
// through the parent's tracked handleDisconnect.
const multiAccountConnection: UnifiedConnection = {
  id: 'catalog:bundled-freshdesk-connected',
  name: 'Freshdesk',
  description: 'Support desk',
  icon: 'LifeBuoy',
  status: 'connected',
  provider: 'bundled',
  serverPreview: {
    name: 'Freshdesk-a-example-com',
    transport: 'stdio',
    health: 'ok',
    catalogId: 'bundled-freshdesk',
    toolCount: 3,
  },
  health: 'ok',
  toolCount: 3,
  instances: [
    { serverName: 'Freshdesk-a-example-com', label: 'a@example.com', health: 'ok' },
    { serverName: 'Freshdesk-b-example-com', label: 'b@example.com', health: 'ok' },
  ],
  catalogEntry: {
    id: 'bundled-freshdesk',
    name: 'Freshdesk',
    description: 'Support desk',
    icon: 'LifeBuoy',
    provider: 'bundled',
    category: 'productivity',
    accountIdentity: 'email',
    requiresSetup: true,
    bundledConfig: {
      serverName: 'Freshdesk',
      authType: 'api-key',
    },
    setupFields: [
      { id: 'email', label: 'Account Email', type: 'email' },
      { id: 'apiKey', label: 'API Key', type: 'password' },
    ],
  } as unknown as UnifiedConnection['catalogEntry'],
};

const missingEmailConnection: UnifiedConnection = {
  ...multiAccountConnection,
  id: 'catalog:bundled-freshdesk-missing-email',
  serverPreview: {
    name: 'Freshdesk-legacy-account',
    transport: 'stdio',
    health: 'ok',
    catalogId: 'bundled-freshdesk',
    toolCount: 3,
  },
  instances: undefined,
};

const customConnection: UnifiedConnection = {
  id: 'custom:legacy-server',
  name: 'Legacy Server',
  description: 'Custom MCP',
  icon: 'Server',
  status: 'connected',
  provider: 'direct',
  serverPreview: {
    name: 'LegacyServer',
    transport: 'stdio',
    health: 'ok',
    toolCount: 1,
  },
  health: 'ok',
  toolCount: 1,
};

const connectedBooleanFieldConnection: UnifiedConnection = {
  id: 'catalog:bundled-browser',
  name: 'Browser Automation',
  description: 'Browser controls',
  icon: 'Globe',
  status: 'connected',
  provider: 'bundled',
  serverPreview: {
    name: 'BrowserAutomation',
    transport: 'stdio',
    health: 'ok',
    catalogId: 'bundled-browser',
    toolCount: 2,
  },
  health: 'ok',
  toolCount: 2,
  catalogEntry: {
    id: 'bundled-browser',
    name: 'Browser Automation',
    description: 'Browser controls',
    icon: 'Globe',
    provider: 'bundled',
    category: 'productivity',
    requiresSetup: true,
    setupFields: [
      {
        id: 'showBrowser',
        label: 'Show browser window',
        type: 'boolean',
        envVar: 'SHOW_BROWSER',
        default: 'false',
      },
    ],
  } as unknown as UnifiedConnection['catalogEntry'],
};

// Connected bundled OAuth Google connection → renders McpAccountsExtension
// (per-account toggle path the F1 refinement covers: pausing an account returns
// success once the config write lands, while tool routing waits on the deferred
// restart — the queued UX must say so honestly).
const googleConnection: UnifiedConnection = {
  id: 'catalog:bundled-google',
  name: 'Google Workspace',
  description: 'Gmail, Calendar, Drive',
  icon: 'Mail',
  status: 'connected',
  provider: 'bundled',
  serverPreview: {
    name: 'GoogleWorkspace-teammember-mindstone-com',
    transport: 'stdio',
    health: 'ok',
    catalogId: 'bundled-google',
    toolCount: 5,
  },
  health: 'ok',
  toolCount: 5,
  instances: [
    { serverName: 'GoogleWorkspace-teammember-mindstone-com', label: '[Mindstone-email]', health: 'ok' },
  ],
  catalogEntry: {
    id: 'bundled-google',
    name: 'Google Workspace',
    description: 'Gmail, Calendar, Drive',
    icon: 'Mail',
    provider: 'bundled',
    category: 'productivity',
    accountIdentity: 'email',
    requiresSetup: true,
    bundledConfig: {
      serverName: 'GoogleWorkspace',
      authType: 'oauth',
    },
  } as unknown as UnifiedConnection['catalogEntry'],
};

function queryByTestId(root: ParentNode, testId: string): HTMLElement | null {
  return root.querySelector(`[data-testid="${testId}"]`);
}

function buttonByAriaLabel(name: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.getAttribute('aria-label') === name,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${name}`);
  }
  return button;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

type McpAddBundledServerResult = Awaited<
  ReturnType<NonNullable<typeof window.settingsApi>['mcpAddBundledServer']>
>;

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

function renderPanel({
  onLoadServer,
  onRemoveServer,
  onUpsertServer,
}: {
  onLoadServer?: (serverName: string) => Promise<unknown>;
  onRemoveServer?: (serverName: string) => Promise<void>;
  onUpsertServer?: (payload: unknown) => Promise<void>;
} = {}): { root: Root; container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <ToastProvider>
        <UnifiedConnectionsPanel
          servers={[]}
          onUpsertServer={(onUpsertServer ?? vi.fn().mockResolvedValue(undefined)) as never}
          onRemoveServer={onRemoveServer}
          onConfigureWithRebel={undefined}
          onLoadServer={onLoadServer as never}
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
        />
      </ToastProvider>,
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

describe('UnifiedConnectionsPanel — real card deferred coverage (B-F1)', () => {
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

  it('surfaces the queued state when a setup-form (API-key) connect restart is deferred', async () => {
    let resolveAdd: (() => void) | undefined;
    window.settingsApi = {
      ...(window.settingsApi ?? {}),
      mcpAddBundledServer: vi.fn(
        () =>
          new Promise<McpAddBundledServerResult>((resolve) => {
            resolveAdd = () => resolve(mcpAddBundledServerResult());
          }),
      ),
    } as never;
    mockConnectionsState.connections = [apiKeyConnection];
    const mounted = renderPanel();

    // Expand the card (real ExpandedConnectionCard mounts with the setup form).
    act(() => {
      buttonByAriaLabel('Freshdesk connector').click();
    });

    // Fill required setup fields so the save button enables.
    const domainInput = mounted.container.querySelector<HTMLInputElement>('#setup-domain-expanded');
    const apiKeyInput = mounted.container.querySelector<HTMLInputElement>('#setup-apiKey-expanded');
    expect(domainInput).toBeTruthy();
    expect(apiKeyInput).toBeTruthy();
    act(() => {
      setInputValue(domainInput!, 'acme.freshdesk.com');
      setInputValue(apiKeyInput!, 'secret-key');
    });

    // Save → handleSaveSetup awaits mcpAddBundledServer (held pending).
    const saveButton = queryByTestId(mounted.container, 'connector-setup-save-button');
    expect(saveButton).toBeTruthy();
    await act(async () => {
      saveButton!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(window.settingsApi.mcpAddBundledServer).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: 'Freshdesk' }),
    );
    // Pre-event: not queued yet.
    expect(mounted.container.textContent).not.toContain('Connect queued');

    // Restart deferred behind an active task → queued state must surface.
    fireRestartDeferred(buildSettingsUpsertRestartContext('Freshdesk'));

    expect(queryByTestId(mounted.container, 'connector-deferred-helper')?.textContent).toContain(
      'Connect queued',
    );
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Connector change queued' }),
    );

    // Settle → queued state clears.
    await act(async () => {
      resolveAdd?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mounted.container.textContent).not.toContain('Connect queued');

    mounted.unmount();
  });

  it('surfaces the queued state when a per-account disconnect restart is deferred', async () => {
    let resolveRemoval: (() => void) | undefined;
    const onRemoveServer = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRemoval = resolve;
        }),
    );
    mockConnectionsState.connections = [multiAccountConnection];
    const mounted = renderPanel({ onRemoveServer });

    act(() => {
      buttonByAriaLabel('Freshdesk connector').click();
    });

    // AccountInstancesList renders a remove button per account (AccountDisconnectButton,
    // aria-label "Disconnect <label>").
    const removeButton = buttonByAriaLabel('Disconnect a@example.com');
    expect(removeButton).toBeTruthy();

    await act(async () => {
      removeButton!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onRemoveServer).toHaveBeenCalledWith('Freshdesk-a-example-com');
    expect(trackingMocks.connectorDisconnected).toHaveBeenCalledWith('Freshdesk', true);
    expect(mounted.container.textContent).not.toContain('Disconnect queued');

    fireRestartDeferred('mcp-server-removal:Freshdesk-a-example-com');

    expect(mounted.container.textContent).toContain('Disconnect queued');

    await act(async () => {
      resolveRemoval?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mounted.container.textContent).not.toContain('Disconnect queued');

    mounted.unmount();
  });

  it('surfaces the queued state when saving a missing account email restart is deferred', async () => {
    let resolveUpsert: (() => void) | undefined;
    const onUpsertServer = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveUpsert = resolve;
        }),
    );
    const onLoadServer = vi.fn().mockResolvedValue({
      name: 'Freshdesk-legacy-account',
      transport: 'stdio',
      command: 'freshdesk-mcp',
      args: ['--stdio'],
      env: { FRESHDESK_DOMAIN: 'acme' },
      catalogId: 'bundled-freshdesk',
      toolCount: 3,
    });

    mockConnectionsState.connections = [missingEmailConnection];
    const mounted = renderPanel({
      onRemoveServer: vi.fn().mockResolvedValue(undefined),
      onUpsertServer,
      onLoadServer,
    });

    act(() => {
      buttonByAriaLabel('Freshdesk connector').click();
    });

    const emailInput = mounted.container.querySelector<HTMLInputElement>('#account-email-setter');
    expect(emailInput).toBeTruthy();
    act(() => {
      setInputValue(emailInput!, 'legacy@example.com');
    });

    const setEmailButton = Array.from(mounted.container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === 'Set email',
    );
    expect(setEmailButton).toBeTruthy();

    await act(async () => {
      setEmailButton!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onLoadServer).toHaveBeenCalledWith('Freshdesk-legacy-account');
    expect(onUpsertServer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Freshdesk-legacy-account',
        email: 'legacy@example.com',
        env: { FRESHDESK_DOMAIN: 'acme' },
      }),
    );
    expect(mounted.container.textContent).not.toContain('Connect queued');

    fireRestartDeferred(buildSettingsUpsertRestartContext('Freshdesk-legacy-account'));

    expect(queryByTestId(mounted.container, 'connector-deferred-helper')?.textContent).toContain(
      'Connect queued',
    );

    await act(async () => {
      resolveUpsert?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mounted.container.textContent).not.toContain('Connect queued');

    mounted.unmount();
  });

  it('surfaces the queued state when a connected env-var field save restart is deferred', async () => {
    let resolveUpsert: (() => void) | undefined;
    const onUpsertServer = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveUpsert = resolve;
        }),
    );
    const onLoadServer = vi.fn().mockResolvedValue({
      name: 'BrowserAutomation',
      transport: 'stdio',
      command: 'browser-mcp',
      args: ['--stdio'],
      env: { SHOW_BROWSER: 'false', EXISTING_TOKEN: 'preserved' },
      catalogId: 'bundled-browser',
      toolCount: 2,
    });

    mockConnectionsState.connections = [connectedBooleanFieldConnection];
    const mounted = renderPanel({
      onRemoveServer: vi.fn().mockResolvedValue(undefined),
      onUpsertServer,
      onLoadServer,
    });

    act(() => {
      buttonByAriaLabel('Browser Automation connector').click();
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const toggle = mounted.container.querySelector<HTMLInputElement>('#connected-showBrowser');
    expect(toggle).toBeTruthy();
    expect(toggle!.checked).toBe(false);

    await act(async () => {
      toggle!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onLoadServer).toHaveBeenCalledWith('BrowserAutomation');
    expect(onUpsertServer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'BrowserAutomation',
        env: { SHOW_BROWSER: 'true', EXISTING_TOKEN: 'preserved' },
      }),
    );
    expect(mounted.container.textContent).not.toContain('Connect queued');

    fireRestartDeferred(buildSettingsUpsertRestartContext('BrowserAutomation'));

    expect(queryByTestId(mounted.container, 'connector-deferred-helper')?.textContent).toContain(
      'Connect queued',
    );

    await act(async () => {
      resolveUpsert?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mounted.container.textContent).not.toContain('Connect queued');

    mounted.unmount();
  });

  it('tracks only the final upsert leg when advanced config renames a server', async () => {
    let resolveUpsert: (() => void) | undefined;
    const onRemoveServer = vi.fn().mockResolvedValue(undefined);
    const onUpsertServer = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveUpsert = resolve;
        }),
    );
    const onLoadServer = vi.fn().mockResolvedValue({
      name: 'LegacyServer',
      transport: 'stdio',
      command: 'legacy-mcp',
      args: ['--stdio'],
      env: { TOKEN: 'secret' },
      toolCount: 1,
    });

    mockConnectionsState.connections = [customConnection];
    const mounted = renderPanel({
      onRemoveServer,
      onUpsertServer,
      onLoadServer,
    });

    act(() => {
      buttonByAriaLabel('Legacy Server connector').click();
    });

    const advancedButton = Array.from(mounted.container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.includes('Advanced settings'),
    );
    expect(advancedButton).toBeTruthy();

    await act(async () => {
      advancedButton!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const nameInput = mounted.container.querySelector<HTMLInputElement>('input[placeholder="Server name"]');
    expect(nameInput).toBeTruthy();
    act(() => {
      setInputValue(nameInput!, 'RenamedServer');
    });

    const saveButton = Array.from(mounted.container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === 'Save',
    );
    expect(saveButton).toBeTruthy();

    await act(async () => {
      saveButton!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onRemoveServer).toHaveBeenCalledWith('LegacyServer');
    expect(trackingMocks.connectorDisconnected).toHaveBeenCalledWith('Legacy Server', true);
    expect(onUpsertServer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'RenamedServer',
        command: 'legacy-mcp',
      }),
    );

    fireRestartDeferred(buildMcpServerRemovalRestartContext('LegacyServer'));
    expect(mounted.container.textContent).not.toContain('Disconnect queued');
    expect(mounted.container.textContent).not.toContain('Connect queued');

    fireRestartDeferred(buildSettingsUpsertRestartContext('RenamedServer'));
    expect(queryByTestId(mounted.container, 'connector-deferred-helper')?.textContent).toContain(
      'Connect queued',
    );

    await act(async () => {
      resolveUpsert?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mounted.container.textContent).not.toContain('Connect queued');

    mounted.unmount();
  });

  it('warns instead of silently no-oping when a card remove lacks a panel remover', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockConnectionsState.connections = [multiAccountConnection];
    const mounted = renderPanel();

    act(() => {
      buttonByAriaLabel('Freshdesk connector').click();
    });

    const removeButton = buttonByAriaLabel('Disconnect a@example.com');
    await act(async () => {
      removeButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(warnSpy).toHaveBeenCalledWith(
      '[UnifiedConnectionsPanel] Ignoring connector-card remove request',
      expect.objectContaining({
        serverName: 'Freshdesk-a-example-com',
        connectionId: 'catalog:bundled-freshdesk-connected',
        connectorName: 'Freshdesk',
        reason: 'missing-onRemoveServer',
      }),
    );

    warnSpy.mockRestore();
    mounted.unmount();
  });

  // F1 refinement (260610_gworkspace-mcp-error-disconnect-hang): toggling an
  // account/connector returns success when the config write lands, but tool
  // routing applies only when the deferred Super-MCP restart executes. The
  // `mcp-server-toggle:<serverId>` deferral must surface the honest queued
  // state on the toggled card instead of silently showing paused/resumed.
  it('surfaces the queued state when a per-instance toggle restart is deferred', async () => {
    let resolveToggle: (() => void) | undefined;
    window.settingsApi = {
      ...(window.settingsApi ?? {}),
      mcpToggleServerEnabled: vi.fn(
        () =>
          new Promise<{ success: boolean }>((resolve) => {
            resolveToggle = () => resolve({ success: true });
          }),
      ),
    } as never;
    mockConnectionsState.connections = [multiAccountConnection];
    // onRemoveServer wired so the connected-card footer (which hosts the
    // deferred helper text) renders.
    const mounted = renderPanel({ onRemoveServer: vi.fn().mockResolvedValue(undefined) });

    act(() => {
      buttonByAriaLabel('Freshdesk connector').click();
    });

    // AccountInstancesList renders a pause/play toggle per account.
    const toggleButton = queryByTestId(mounted.container, 'instance-toggle-Freshdesk-a-example-com');
    expect(toggleButton).toBeTruthy();

    await act(async () => {
      toggleButton!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(window.settingsApi.mcpToggleServerEnabled).toHaveBeenCalledWith({
      serverId: 'Freshdesk-a-example-com',
    });
    expect(mounted.container.textContent).not.toContain('Change queued');

    fireRestartDeferred(buildMcpServerToggleRestartContext('Freshdesk-a-example-com'));

    expect(queryByTestId(mounted.container, 'connector-deferred-helper')?.textContent).toContain(
      'Change queued',
    );
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Connector change queued' }),
    );

    await act(async () => {
      resolveToggle?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mounted.container.textContent).not.toContain('Change queued');

    mounted.unmount();
  });

  it('surfaces the queued state when a Google per-account toggle restart is deferred (McpAccountsExtension)', async () => {
    let resolveToggle: (() => void) | undefined;
    window.settingsApi = {
      ...(window.settingsApi ?? {}),
      mcpToggleServerEnabled: vi.fn(
        () =>
          new Promise<{ success: boolean }>((resolve) => {
            resolveToggle = () => resolve({ success: true });
          }),
      ),
    } as never;
    window.googleWorkspaceApi = {
      ...(window.googleWorkspaceApi ?? {}),
      getAccounts: vi.fn().mockResolvedValue({
        accounts: [{ email: '[Mindstone-email]', status: 'active' }],
      }),
    } as never;
    mockConnectionsState.connections = [googleConnection];
    const mounted = renderPanel({ onRemoveServer: vi.fn().mockResolvedValue(undefined) });

    act(() => {
      buttonByAriaLabel('Google Workspace connector').click();
    });

    // Flush McpAccountsExtension's mount-time getAccounts load.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const toggleButton = queryByTestId(mounted.container, '[Mindstone-email]');
    expect(toggleButton).toBeTruthy();

    await act(async () => {
      toggleButton!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(window.settingsApi.mcpToggleServerEnabled).toHaveBeenCalledWith({
      serverId: 'GoogleWorkspace-teammember-mindstone-com',
    });
    expect(mounted.container.textContent).not.toContain('Change queued');

    fireRestartDeferred(buildMcpServerToggleRestartContext('GoogleWorkspace-teammember-mindstone-com'));

    expect(queryByTestId(mounted.container, 'connector-deferred-helper')?.textContent).toContain(
      'Change queued',
    );
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Connector change queued' }),
    );

    await act(async () => {
      resolveToggle?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mounted.container.textContent).not.toContain('Change queued');

    mounted.unmount();
  });

  // Stage 5 (260610_gworkspace-mcp-error-disconnect-hang): "Add another
  // account" (McpAccountsExtension → google-workspace:start-auth) — the
  // surface named in this run's task. The start-auth IPC now resolves on
  // deferral, so the `google-workspace-connect` broadcast is the only honest
  // signal that routing is still pending; the connect-kind deferred op is
  // plumbed card→extension via the toggle-prop precedent (4aead7933).
  it('surfaces the queued state when a Google add-account connect restart is deferred (McpAccountsExtension)', async () => {
    let resolveAuth: (() => void) | undefined;
    window.googleWorkspaceApi = {
      ...(window.googleWorkspaceApi ?? {}),
      getAccounts: vi.fn().mockResolvedValue({
        accounts: [{ email: '[Mindstone-email]', status: 'active' }],
      }),
      startAuth: vi.fn(
        () =>
          new Promise<{ success: boolean; email?: string }>((resolve) => {
            resolveAuth = () => resolve({ success: true, email: '[Mindstone-email]' });
          }),
      ),
    } as never;
    mockConnectionsState.connections = [googleConnection];
    const mounted = renderPanel({ onRemoveServer: vi.fn().mockResolvedValue(undefined) });

    act(() => {
      buttonByAriaLabel('Google Workspace connector').click();
    });

    // Flush McpAccountsExtension's mount-time getAccounts load.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const addButton = Array.from(mounted.container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.includes('Add another account'),
    );
    expect(addButton).toBeTruthy();

    await act(async () => {
      addButton!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(window.googleWorkspaceApi.startAuth).toHaveBeenCalledTimes(1);
    expect(mounted.container.textContent).not.toContain('Connect queued');

    // Cross-op isolation: a different connector's connect deferral must not
    // light this card.
    fireRestartDeferred('slack-connect');
    expect(mounted.container.textContent).not.toContain('Connect queued');

    fireRestartDeferred('google-workspace-connect');

    expect(queryByTestId(mounted.container, 'connector-deferred-helper')?.textContent).toContain(
      'Connect queued',
    );
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Connector change queued' }),
    );

    // Settle → queued state clears (the extension clears the op in finally).
    await act(async () => {
      resolveAuth?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mounted.container.textContent).not.toContain('Connect queued');

    mounted.unmount();
  });
});
