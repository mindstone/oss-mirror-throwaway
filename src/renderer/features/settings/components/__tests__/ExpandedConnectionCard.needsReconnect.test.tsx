// @vitest-environment happy-dom

/**
 * Stage 3 (260611_calendar-cache-attention): per-account Google Workspace
 * reconnect state on the PRIMARY surface — `McpAccountsExtension` rendered
 * inside `ExpandedConnectionCard` (Chief Designer F5 / DSR F1).
 *
 * DOM tests (not hook-state-only — Verification Notes #3 / 260609-10 retro):
 * - row marker: AlertTriangle + visible "Sign-in expired" label on the
 *   affected account row only;
 * - recovery: warning Notice "{email} sign-in expired" with a Reconnect
 *   action for the affected/selected account; single-account variant renders
 *   the Notice below the row;
 * - [GPT-F2] the Reconnect CTA passes the affected instance's email as
 *   `targetEmail` so re-auth is scoped to that account;
 * - auto-selection: `preferredInstanceServerName` prefers the needs-reconnect
 *   instance when the card expands.
 *
 * Red→green: pre-Stage-3 none of these affordances exist.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '@renderer/components/ui';
import { ExpandedConnectionCard } from '../ExpandedConnectionCard';
import { createTestConnectionCardOps } from './connectionCardOpsTestUtils';
import type { UnifiedConnection, ConnectionInstance } from '../../hooks/useUnifiedConnections';
import type { ConnectorCatalogEntry } from '@shared/types';

// Calendar selection drags in its own IPC surface — out of scope for this suite.
vi.mock('../CalendarSelectionSection', () => ({
  CalendarSelectionSection: () => null,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LONG_EMAIL = '[external-email]';
const HEALTHY_EMAIL = '[external-email]';
const LONG_EMAIL_SLUG = 'GoogleWorkspace-firstname-lastname-subdomain-company-name-co-uk';
const HEALTHY_SLUG = 'GoogleWorkspace-a-x-com';

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<ToastProvider>{ui}</ToastProvider>);
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => {
        root.unmount();
      });
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

async function clickElement(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Dispatches a cancelable keydown and reports whether preventDefault fired. */
async function keydownElement(el: HTMLElement, key: string): Promise<boolean> {
  let defaultPrevented = false;
  await act(async () => {
    const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    defaultPrevented = event.defaultPrevented;
    await Promise.resolve();
    await Promise.resolve();
  });
  return defaultPrevented;
}

function googleEntry(): ConnectorCatalogEntry {
  return {
    id: 'bundled-google',
    name: 'Google Workspace',
    description: 'Gmail, Calendar, Drive.',
    category: 'productivity',
    icon: 'google',
    provider: 'rebel-oss',
    accountIdentity: 'email',
    bundledConfig: {
      authType: 'oauth',
      settingsKey: 'googleWorkspace.enabled',
      serverName: 'GoogleWorkspace',
      authApi: 'googleWorkspaceApi',
    },
  } as ConnectorCatalogEntry;
}

function googleConnection(instances: ConnectionInstance[]): UnifiedConnection {
  const entry = googleEntry();
  return {
    id: 'catalog:bundled-google',
    name: entry.name,
    description: entry.description,
    icon: entry.icon,
    status: 'connected',
    provider: entry.provider,
    catalogEntry: entry,
    serverPreview: {
      name: instances[0].serverName,
      transport: 'stdio',
      health: 'ok',
      catalogId: entry.id,
      email: instances[0].label,
      toolCount: 0,
    },
    health: 'ok',
    toolCount: 0,
    instances,
  };
}

function installWindowStubs(emails: string[]): { startAuth: ReturnType<typeof vi.fn> } {
  const startAuth = vi.fn().mockResolvedValue({ success: true, email: emails[0] });
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
    appApi: {
      openUrl: vi.fn().mockResolvedValue(undefined),
    },
    contributionApi: {
      list: vi.fn().mockResolvedValue({ contributions: [] }),
    },
    googleWorkspaceApi: {
      getAccounts: vi.fn().mockResolvedValue({
        accounts: emails.map((email) => ({
          email,
          category: 'personal',
          description: 'Connected via Rebel',
          status: 'active' as const,
        })),
      }),
      startAuth,
      removeAccount: vi.fn().mockResolvedValue({ success: true }),
      cancelAuth: vi.fn().mockResolvedValue(undefined),
    },
  });
  return { startAuth };
}

function renderCard(instances: ConnectionInstance[], emails: string[]): {
  mounted: Mounted;
  startAuth: ReturnType<typeof vi.fn>;
} {
  const { startAuth } = installWindowStubs(emails);
  const mounted = mount(
    <ExpandedConnectionCard
	      connection={googleConnection(instances)}
	      onClose={vi.fn()}
	      ops={createTestConnectionCardOps()}
	      onRefresh={vi.fn()}
	    />,
  );
  return { mounted, startAuth };
}

const multiAccountInstances: ConnectionInstance[] = [
  { serverName: HEALTHY_SLUG, label: HEALTHY_EMAIL, health: 'ok' },
  { serverName: LONG_EMAIL_SLUG, label: LONG_EMAIL, health: 'ok', needsReconnect: true },
];

function reconnectNotice(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-testid="mcp-account-reconnect-notice"]');
}

function reconnectButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    '[data-testid="mcp-account-reconnect-button"]',
  );
  if (!button) throw new Error('Reconnect button not found');
  return button;
}

describe('ExpandedConnectionCard — per-account needs-reconnect (Stage 3)', () => {
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

  it('shows the "Sign-in expired" marker on the affected account row only (multi-account)', async () => {
    ({ mounted } = renderCard(multiAccountInstances, [HEALTHY_EMAIL, LONG_EMAIL]));
    await flushAsyncWork();

    const affectedMarker = mounted.container.querySelector(
      `[data-testid="mcp-account-reconnect-marker-${LONG_EMAIL}"]`,
    );
    expect(affectedMarker).toBeTruthy();
    expect(affectedMarker?.textContent).toContain('Sign-in expired');

    const healthyMarker = mounted.container.querySelector(
      `[data-testid="mcp-account-reconnect-marker-${HEALTHY_EMAIL}"]`,
    );
    expect(healthyMarker).toBeNull();
  });

  it('auto-selects the needs-reconnect instance on expand and shows the recovery Notice for it', async () => {
    ({ mounted } = renderCard(multiAccountInstances, [HEALTHY_EMAIL, LONG_EMAIL]));
    await flushAsyncWork();

    // preferredInstanceServerName must prefer the latched instance (NOT instances[0])
    const notice = reconnectNotice(mounted.container);
    expect(notice).toBeTruthy();
    expect(notice?.textContent).toContain(`${LONG_EMAIL} sign-in expired`);
    expect(notice?.textContent).toContain('Reconnect to get this account back in sync.');
  });

  it('[GPT-F2] Reconnect CTA re-runs OAuth scoped to the affected email (targetEmail)', async () => {
    let startAuth: ReturnType<typeof vi.fn>;
    ({ mounted, startAuth } = renderCard(multiAccountInstances, [HEALTHY_EMAIL, LONG_EMAIL]));
    await flushAsyncWork();

    await clickElement(reconnectButton(mounted.container));
    await flushAsyncWork();

    expect(startAuth).toHaveBeenCalledWith({ targetEmail: LONG_EMAIL });
  });

  it('selecting a healthy account row hides the Notice while the row marker persists', async () => {
    ({ mounted } = renderCard(multiAccountInstances, [HEALTHY_EMAIL, LONG_EMAIL]));
    await flushAsyncWork();

    const healthyRow = mounted.container.querySelector<HTMLElement>(
      `[data-testid="mcp-account-row-${HEALTHY_EMAIL}"]`,
    );
    expect(healthyRow).toBeTruthy();
    await clickElement(healthyRow!);
    await flushAsyncWork();

    expect(reconnectNotice(mounted.container)).toBeNull();
    expect(
      mounted.container.querySelector(`[data-testid="mcp-account-reconnect-marker-${LONG_EMAIL}"]`),
    ).toBeTruthy();
  });

  it('single account: renders the Notice below the row', async () => {
    ({ mounted } = renderCard(
      [{ serverName: LONG_EMAIL_SLUG, label: LONG_EMAIL, health: 'ok', needsReconnect: true }],
      [LONG_EMAIL],
    ));
    await flushAsyncWork();

    expect(
      mounted.container.querySelector(`[data-testid="mcp-account-reconnect-marker-${LONG_EMAIL}"]`),
    ).toBeTruthy();
    const notice = reconnectNotice(mounted.container);
    expect(notice).toBeTruthy();
    expect(notice?.textContent).toContain(`${LONG_EMAIL} sign-in expired`);
  });

  it('renders no marker and no Notice when all accounts are healthy', async () => {
    ({ mounted } = renderCard(
      [
        { serverName: HEALTHY_SLUG, label: HEALTHY_EMAIL, health: 'ok' },
        { serverName: LONG_EMAIL_SLUG, label: LONG_EMAIL, health: 'ok' },
      ],
      [HEALTHY_EMAIL, LONG_EMAIL],
    ));
    await flushAsyncWork();

    expect(reconnectNotice(mounted.container)).toBeNull();
    expect(mounted.container.textContent).not.toContain('Sign-in expired');
  });

  it('[Phase 6 DSR-F1] Space activates row selection (with preventDefault) like Enter', async () => {
    ({ mounted } = renderCard(multiAccountInstances, [HEALTHY_EMAIL, LONG_EMAIL]));
    await flushAsyncWork();

    // Auto-select prefers the latched instance, so its Notice is showing.
    expect(reconnectNotice(mounted.container)).toBeTruthy();

    const healthyRow = mounted.container.querySelector<HTMLElement>(
      `[data-testid="mcp-account-row-${HEALTHY_EMAIL}"]`,
    );
    expect(healthyRow).toBeTruthy();

    // Space selects the healthy row (Notice hides) AND prevents page scroll.
    const prevented = await keydownElement(healthyRow!, ' ');
    await flushAsyncWork();
    expect(prevented).toBe(true);
    expect(reconnectNotice(mounted.container)).toBeNull();

    // Enter still selects (back to the affected row → Notice returns).
    const affectedRow = mounted.container.querySelector<HTMLElement>(
      `[data-testid="mcp-account-row-${LONG_EMAIL}"]`,
    );
    await keydownElement(affectedRow!, 'Enter');
    await flushAsyncWork();
    expect(reconnectNotice(mounted.container)).toBeTruthy();
  });

  it('[Phase 6 DSR-F1] selectable rows expose button semantics with aria-pressed + state-bearing aria-label', async () => {
    ({ mounted } = renderCard(multiAccountInstances, [HEALTHY_EMAIL, LONG_EMAIL]));
    await flushAsyncWork();

    const affectedRow = mounted.container.querySelector<HTMLElement>(
      `[data-testid="mcp-account-row-${LONG_EMAIL}"]`,
    );
    const healthyRow = mounted.container.querySelector<HTMLElement>(
      `[data-testid="mcp-account-row-${HEALTHY_EMAIL}"]`,
    );
    expect(affectedRow).toBeTruthy();
    expect(healthyRow).toBeTruthy();

    // Button semantics + selection state (affected row auto-selected on expand).
    expect(affectedRow!.getAttribute('role')).toBe('button');
    expect(affectedRow!.getAttribute('aria-pressed')).toBe('true');
    expect(healthyRow!.getAttribute('aria-pressed')).toBe('false');

    // The sign-in-expired state survives accessible-name computation.
    expect(affectedRow!.getAttribute('aria-label')).toBe(`${LONG_EMAIL} — Sign-in expired`);
    expect(healthyRow!.getAttribute('aria-label')).toBe(HEALTHY_EMAIL);

    // Selecting the healthy row flips the pressed state.
    await clickElement(healthyRow!);
    await flushAsyncWork();
    expect(healthyRow!.getAttribute('aria-pressed')).toBe('true');
    expect(affectedRow!.getAttribute('aria-pressed')).toBe('false');
  });

  it('surfaces an inline error when the scoped reconnect fails', async () => {
    let startAuth: ReturnType<typeof vi.fn>;
    ({ mounted, startAuth } = renderCard(multiAccountInstances, [HEALTHY_EMAIL, LONG_EMAIL]));
    startAuth!.mockResolvedValueOnce({
      success: false,
      error: 'Authenticated Google account did not match the requested account',
    });
    await flushAsyncWork();

    await clickElement(reconnectButton(mounted.container));
    await flushAsyncWork();

    expect(mounted.container.textContent).toContain(
      'Authenticated Google account did not match the requested account',
    );
    // Latch untouched (renderer state comes from the store via summary refresh) — marker persists
    expect(
      mounted.container.querySelector(`[data-testid="mcp-account-reconnect-marker-${LONG_EMAIL}"]`),
    ).toBeTruthy();
  });
});
