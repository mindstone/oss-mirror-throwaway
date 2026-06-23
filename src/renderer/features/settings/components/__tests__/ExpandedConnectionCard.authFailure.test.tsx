// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '@renderer/components/ui';
import { ExpandedConnectionCard } from '../ExpandedConnectionCard';
import { createTestConnectionCardOps } from './connectionCardOpsTestUtils';
import type { UnifiedConnection } from '../../hooks/useUnifiedConnections';
import type { ConnectorCatalogEntry, McpServerConfigDetails } from '@shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

function baseCatalogEntry(overrides: Partial<ConnectorCatalogEntry> = {}): ConnectorCatalogEntry {
  return {
    id: 'bundled-gamma',
    name: 'Gamma',
    description: 'Generate presentations and documents.',
    category: 'productivity',
    icon: 'presentation',
    provider: 'rebel-oss',
    requiresSetup: true,
    accountIdentity: 'email',
    bundledConfig: {
      authType: 'api-key',
      serverName: 'GammaMcp',
    },
    setupFields: [
      {
        id: 'apiKey',
        label: 'Gamma API Key',
        type: 'password',
        envVar: 'GAMMA_API_KEY',
      },
    ],
    ...overrides,
  } as ConnectorCatalogEntry;
}

function multiFieldEntry(): ConnectorCatalogEntry {
  return baseCatalogEntry({
    id: 'bundled-kling',
    name: 'Kling AI',
    bundledConfig: {
      authType: 'api-key',
      serverName: 'Kling',
    },
    setupFields: [
      {
        id: 'accessKey',
        label: 'Access Key',
        type: 'text',
        envVar: 'KLING_ACCESS_KEY',
      },
      {
        id: 'secretKey',
        label: 'Secret Key',
        type: 'password',
        envVar: 'KLING_SECRET_KEY',
      },
    ],
  });
}

function connectionFor(entry: ConnectorCatalogEntry, status: UnifiedConnection['status'] = 'error'): UnifiedConnection {
  const serverName = entry.bundledConfig?.serverName ?? entry.name;
  const health = status === 'error' ? 'error' : 'ok';
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    icon: entry.icon,
    status,
    provider: entry.provider,
    catalogEntry: entry,
    serverPreview: {
      name: serverName,
      transport: 'stdio',
      health,
      catalogId: entry.id,
      email: 'existing@example.com',
      toolCount: 0,
    },
    health,
    toolCount: 0,
  };
}

function serverDetails(entry: ConnectorCatalogEntry): McpServerConfigDetails {
  return {
    name: entry.bundledConfig?.serverName ?? entry.name,
    type: null,
    transport: 'stdio',
    command: 'npx',
    args: [],
    url: null,
    cwd: null,
    env: {
      [entry.setupFields?.find((field) => field.envVar)?.envVar ?? 'API_KEY']: 'saved-secret',
    },
    headers: null,
    description: entry.description,
    catalogId: entry.id,
    email: 'existing@example.com',
    workspace: null,
    lastConnectedAt: 1_714_000_000_000,
  };
}

function installWindowStubs(): void {
  Object.assign(window, {
    settingsApi: {
      mcpAddBundledServer: vi.fn().mockResolvedValue({ success: true }),
      mcpValidateServer: vi.fn().mockResolvedValue({ status: 'ok' }),
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
  });
}

function renderCard({
  entry = baseCatalogEntry(),
  status = 'error',
}: {
  entry?: ConnectorCatalogEntry;
  status?: UnifiedConnection['status'];
} = {}): { mounted: Mounted; onLoadServer: ReturnType<typeof vi.fn> } {
  installWindowStubs();
  const loadServer = vi.fn(async () => serverDetails(entry));
  const mounted = mount(
    <ExpandedConnectionCard
      connection={connectionFor(entry, status)}
      onClose={vi.fn()}
      onLoadServer={loadServer}
      ops={createTestConnectionCardOps()}
      onRefresh={vi.fn()}
    />,
  );
  return { mounted, onLoadServer: loadServer };
}

function authFailureNotice(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-testid="connector-auth-failure-notice"]');
}

function noticeAction(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('[data-testid="connector-auth-failure-update-button"]');
  if (!button) {
    throw new Error('Auth-failure Notice action not found');
  }
  return button;
}

async function clickButton(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ExpandedConnectionCard — auth-failure Notice', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'settingsApi');
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'miscApi');
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'appApi');
  });

  it('renders Notice when connector status is "error" and authType is "api-key"', async () => {
    ({ mounted } = renderCard());
    await flushAsyncWork();

    const notice = authFailureNotice(mounted.container);
    expect(notice).toBeTruthy();
    expect(notice?.textContent).toContain('Gamma needs a new key');
    expect(notice?.textContent).toContain("Couldn't reach this connector. If it's a credential issue, update the key below.");
  });

  it('Notice action label is "Update key" for single-secret', async () => {
    ({ mounted } = renderCard());
    await flushAsyncWork();

    expect(noticeAction(mounted.container).textContent).toContain('Update key');
  });

  it('Notice action label is "Update details" for multi-field', async () => {
    ({ mounted } = renderCard({ entry: multiFieldEntry() }));
    await flushAsyncWork();

    expect(authFailureNotice(mounted.container)?.textContent).toContain('Kling AI needs new details');
    expect(noticeAction(mounted.container).textContent).toContain('Update details');
  });

  it('clicking Notice action opens the same form as the footer button', async () => {
    ({ mounted } = renderCard());
    await flushAsyncWork();

    await clickButton(noticeAction(mounted.container));
    await flushAsyncWork();

    expect(mounted.container.querySelector('[data-testid="connector-auth-failure-notice"]')).toBeNull();
    expect(mounted.container.textContent).toContain('Update key');
    expect(mounted.container.querySelector('[data-testid="connector-setup-save-button"]')?.textContent).toContain('Save');
    const emailInput = mounted.container.querySelector<HTMLInputElement>('#setup-email-expanded');
    expect(emailInput?.value).toBe('existing@example.com');
    expect(emailInput?.readOnly).toBe(true);
  });

  it('Notice is hidden once isUpdating is true (to avoid double affordance)', async () => {
    ({ mounted } = renderCard());
    await flushAsyncWork();

    expect(authFailureNotice(mounted.container)).toBeTruthy();
    await clickButton(noticeAction(mounted.container));
    await flushAsyncWork();

    expect(authFailureNotice(mounted.container)).toBeNull();
    expect(mounted.container.querySelector('[data-testid="connector-setup-save-button"]')).toBeTruthy();
  });

  it("OAuth connectors with status==='error' do NOT render this Notice", async () => {
    const entry = baseCatalogEntry({
      id: 'bundled-slack',
      name: 'Slack',
      provider: 'bundled',
      bundledConfig: {
        authType: 'oauth',
        serverName: 'Slack',
      },
      setupFields: undefined,
      requiresSetup: false,
      accountIdentity: 'workspace',
    });
    ({ mounted } = renderCard({ entry }));
    await flushAsyncWork();

    expect(authFailureNotice(mounted.container)).toBeNull();
    expect(mounted.container.textContent).not.toContain('Slack needs a new key');
  });
});
