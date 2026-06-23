// @vitest-environment happy-dom

/**
 * Stage 3 [GPT-F5] (260611_calendar-cache-attention): DOM test for the exact
 * remediation path this run exists to fix — the "View Connector" deep-link.
 *
 * `connectorRevealTarget` → connectors panel reveal effect
 * (`UnifiedConnectionsPanel.tsx` deep-link effect) → the Google Workspace card
 * expands → `preferredInstanceServerName` auto-selects the needs-reconnect
 * instance → the user lands on the per-account recovery Notice.
 *
 * Uses the REAL `useUnifiedConnections`, `ExpandedConnectionCard`, and
 * `McpAccountsExtension` composition (only contexts/IPC are stubbed) so this
 * pins the user-visible chain, not hook internals.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@renderer/components/ui';
import { UnifiedConnectionsPanel } from '../UnifiedConnectionsPanel';
import type { McpServerPreview } from '@shared/types';

const mockShowToast = vi.hoisted(() => vi.fn());
// Stable identities: the panel's deep-link reveal effect depends on `settings`;
// a fresh object per render would re-run it forever (setState loop).
const stableSettingsContext = vi.hoisted(() => ({ settings: {} }));

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  LayoutGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: new Proxy(
    {},
    {
      get:
        () =>
        ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => {
          const domProps = Object.fromEntries(
            Object.entries(props).filter(
              ([key]) => !['initial', 'animate', 'exit', 'transition', 'layoutId', 'layout', 'whileHover', 'whileTap'].includes(key),
            ),
          );
          return <div {...domProps}>{children}</div>;
        },
    },
  ),
}));

vi.mock('@renderer/contexts/AppContext', () => ({
  useAppContext: () => ({ showToast: mockShowToast }),
}));

vi.mock('../../SettingsProvider', () => ({
  useSettings: () => stableSettingsContext,
  useSettingsSafe: () => null,
}));

vi.mock('../../hooks/useAppBridgePairedCount', () => ({
  useAppBridgePairedCount: () => ({ pairedCount: 0, refresh: vi.fn() }),
}));

vi.mock('../../hooks/useConnectSlackMcpAction', () => ({
  useConnectSlackMcpAction: () => ({ connect: vi.fn(), isInFlight: false }),
}));

vi.mock('@renderer/src/tracking', () => ({
  tracking: {
    settings: {
      connectorViewed: vi.fn(),
      connectorConnectStarted: vi.fn(),
      connectorConnected: vi.fn(),
      connectorConnectionFailed: vi.fn(),
      connectorDisconnected: vi.fn(),
      customMcpServerClicked: vi.fn(),
    },
  },
}));

vi.mock('../CalendarSelectionSection', () => ({
  CalendarSelectionSection: () => null,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HEALTHY_EMAIL = '[external-email]';
const LATCHED_EMAIL = 'jane@example.com';
const HEALTHY_SLUG = 'GoogleWorkspace-a-x-com';
const LATCHED_SLUG = 'GoogleWorkspace-jane-example-com';

function gwServer(name: string, email: string, extra: Partial<McpServerPreview> = {}): McpServerPreview {
  return {
    name,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@mindstone/mcp-server-google-workspace@0.1.3'],
    catalogId: 'bundled-google',
    email,
    health: 'ok',
    ...extra,
  };
}

function installWindowStubs(): void {
  Object.assign(window, {
    settingsApi: {
      mcpListTools: vi.fn().mockResolvedValue({ tools: [], nextPageToken: null }),
      mcpToggleServerEnabled: vi.fn().mockResolvedValue({ success: true }),
      get: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({ success: true }),
    },
    miscApi: {
      mcpCheckHealth: vi.fn().mockResolvedValue({ health: 'ok' }),
      checkPythonRuntime: vi.fn().mockResolvedValue({ uvxAvailable: true }),
    },
    appApi: { openUrl: vi.fn().mockResolvedValue(undefined) },
    contributionApi: { list: vi.fn().mockResolvedValue({ contributions: [] }) },
    googleWorkspaceApi: {
      getAccounts: vi.fn().mockResolvedValue({
        accounts: [
          { email: HEALTHY_EMAIL, category: 'personal', description: '', status: 'active' as const },
          { email: LATCHED_EMAIL, category: 'personal', description: '', status: 'active' as const },
        ],
      }),
      startAuth: vi.fn().mockResolvedValue({ success: true, email: LATCHED_EMAIL }),
      removeAccount: vi.fn().mockResolvedValue({ success: true }),
      cancelAuth: vi.fn().mockResolvedValue(undefined),
    },
  });
}

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  rerender: (props?: Partial<React.ComponentProps<typeof UnifiedConnectionsPanel>>) => void;
  unmount: () => void;
}

function mountPanel(props: Partial<React.ComponentProps<typeof UnifiedConnectionsPanel>> = {}): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (overrides: Partial<React.ComponentProps<typeof UnifiedConnectionsPanel>> = props): void => {
    act(() => {
      root.render(
        <ToastProvider>
        <UnifiedConnectionsPanel
          servers={[
            gwServer(HEALTHY_SLUG, HEALTHY_EMAIL),
            gwServer(LATCHED_SLUG, LATCHED_EMAIL, { needsReconnect: true }),
          ]}
          onUpsertServer={vi.fn()}
          mcpMutationPending={false}
          connectorRevealTarget="connector-googleworkspace"
          onConnectorRevealReady={vi.fn()}
          {...overrides}
        />
        </ToastProvider>,
      );
    });
  };
  render();
  return {
    container,
    root,
    rerender: (overrides) => render(overrides ?? props),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('UnifiedConnectionsPanel — deep-link reveal lands on the needs-reconnect account [GPT-F5]', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
    for (const key of ['settingsApi', 'miscApi', 'appApi', 'contributionApi', 'googleWorkspaceApi']) {
      Reflect.deleteProperty(window as unknown as Record<string, unknown>, key);
    }
  });

  it('expands the Google Workspace card with the needs-reconnect instance auto-selected and the recovery Notice visible', async () => {
    installWindowStubs();
    mounted = mountPanel();
    await flushAsyncWork();
    await flushAsyncWork();

    // Card expanded via the reveal effect
    const card = mounted.container.querySelector('[role="dialog"][aria-label="Google Workspace details"]');
    expect(card).toBeTruthy();

    // The affected row carries the marker…
    const marker = mounted.container.querySelector(
      `[data-testid="mcp-account-reconnect-marker-${LATCHED_EMAIL}"]`,
    );
    expect(marker).toBeTruthy();
    expect(marker?.textContent).toContain('Sign-in expired');

    // …and auto-selection (preferredInstanceServerName) surfaces the recovery
    // Notice for THAT account without any further clicks.
    const notice = mounted.container.querySelector('[data-testid="mcp-account-reconnect-notice"]');
    expect(notice).toBeTruthy();
    expect(notice?.textContent).toContain(`${LATCHED_EMAIL} sign-in expired`);
    expect(notice?.textContent).toContain('Reconnect to get this account back in sync.');
  });

  it('auto-selects a needs-reconnect instance that arrives AFTER the card expanded (stale-summary refresh) [Phase 7 GPT-F1]', async () => {
    // Real-app transition: Settings opens with the startup-cached MCP summary
    // (no needsReconnect latched yet), the reveal effect expands the Google
    // Workspace card off that stale snapshot, THEN the post-open
    // refreshMcpSummary() result lands with the latch present.
    installWindowStubs();
    const staleServers = [gwServer(HEALTHY_SLUG, HEALTHY_EMAIL), gwServer(LATCHED_SLUG, LATCHED_EMAIL)];
    const refreshedServers = [
      gwServer(HEALTHY_SLUG, HEALTHY_EMAIL),
      gwServer(LATCHED_SLUG, LATCHED_EMAIL, { needsReconnect: true }),
    ];
    mounted = mountPanel({ servers: staleServers });
    await flushAsyncWork();
    await flushAsyncWork();

    // Card expanded off the STALE snapshot — selection seeded to the first
    // (healthy) instance because nothing needs reconnecting yet.
    expect(
      mounted.container.querySelector('[role="dialog"][aria-label="Google Workspace details"]'),
    ).toBeTruthy();
    expect(mounted.container.querySelector('[data-testid="mcp-account-reconnect-notice"]')).toBeNull();

    // The refreshed summary overlays the latch.
    mounted.rerender({ servers: refreshedServers });
    await flushAsyncWork();
    await flushAsyncWork();

    const marker = mounted.container.querySelector(
      `[data-testid="mcp-account-reconnect-marker-${LATCHED_EMAIL}"]`,
    );
    expect(marker).toBeTruthy();

    // The latched account must take selection (the prior selection was only the
    // automatic seed) so the recovery Notice is reachable without extra clicks.
    const notice = mounted.container.querySelector('[data-testid="mcp-account-reconnect-notice"]');
    expect(notice).toBeTruthy();
    expect(notice?.textContent).toContain(`${LATCHED_EMAIL} sign-in expired`);
  });

  it('never overrides a DELIBERATE user row selection when a latch arrives later [Phase 7 GPT-F1]', async () => {
    installWindowStubs();
    const staleServers = [gwServer(HEALTHY_SLUG, HEALTHY_EMAIL), gwServer(LATCHED_SLUG, LATCHED_EMAIL)];
    const refreshedServers = [
      gwServer(HEALTHY_SLUG, HEALTHY_EMAIL),
      gwServer(LATCHED_SLUG, LATCHED_EMAIL, { needsReconnect: true }),
    ];
    mounted = mountPanel({ servers: staleServers });
    await flushAsyncWork();
    await flushAsyncWork();

    // User deliberately clicks the healthy account's row.
    const healthyRow = mounted.container.querySelector<HTMLElement>(
      `[data-testid="mcp-account-row-${HEALTHY_EMAIL}"]`,
    );
    expect(healthyRow).toBeTruthy();
    act(() => {
      healthyRow!.click();
    });
    await flushAsyncWork();

    // Latch arrives afterwards: the marker shows on the affected row, but the
    // user's deliberate selection (healthy account) is NOT hijacked, so the
    // selected-row Notice stays hidden until they click the marked row.
    mounted.rerender({ servers: refreshedServers });
    await flushAsyncWork();
    await flushAsyncWork();

    expect(
      mounted.container.querySelector(`[data-testid="mcp-account-reconnect-marker-${LATCHED_EMAIL}"]`),
    ).toBeTruthy();
    expect(mounted.container.querySelector('[data-testid="mcp-account-reconnect-notice"]')).toBeNull();

    // Recovery remains reachable: clicking the marked row surfaces the Notice.
    const latchedRow = mounted.container.querySelector<HTMLElement>(
      `[data-testid="mcp-account-row-${LATCHED_EMAIL}"]`,
    );
    expect(latchedRow).toBeTruthy();
    act(() => {
      latchedRow!.click();
    });
    await flushAsyncWork();
    const notice = mounted.container.querySelector('[data-testid="mcp-account-reconnect-notice"]');
    expect(notice).toBeTruthy();
    expect(notice?.textContent).toContain(`${LATCHED_EMAIL} sign-in expired`);
  });
});
