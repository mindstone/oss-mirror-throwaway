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

function selectBooleanEntry(): ConnectorCatalogEntry {
  return baseCatalogEntry({
    id: 'bundled-details',
    name: 'Details MCP',
    bundledConfig: {
      authType: 'api-key',
      serverName: 'DetailsMcp',
    },
    setupFields: [
      {
        id: 'apiKey',
        label: 'API Key',
        type: 'password',
        envVar: 'DETAILS_API_KEY',
      },
      {
        id: 'region',
        label: 'Region',
        type: 'select',
        envVar: 'DETAILS_REGION',
        default: 'us',
        options: [
          { value: 'us', label: 'US' },
          { value: 'eu', label: 'EU' },
        ],
      },
      {
        id: 'readOnly',
        label: 'Read-only mode',
        type: 'boolean',
        envVar: 'DETAILS_READ_ONLY',
        required: false,
        default: 'false',
      },
    ],
  });
}

function connectionFor(entry: ConnectorCatalogEntry, serverName = entry.bundledConfig?.serverName ?? entry.name): UnifiedConnection {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    icon: entry.icon,
    status: 'connected',
    provider: entry.provider,
    catalogEntry: entry,
    serverPreview: {
      name: serverName,
      transport: 'stdio',
      health: 'ok',
      catalogId: entry.id,
      email: 'existing@example.com',
      toolCount: 0,
    },
    health: 'ok',
    toolCount: 0,
  };
}

function serverDetails(
  entry: ConnectorCatalogEntry,
  env: Record<string, string> = {},
  email = 'existing@example.com',
): McpServerConfigDetails {
  return {
    name: entry.bundledConfig?.serverName ?? entry.name,
    type: null,
    transport: 'stdio',
    command: 'npx',
    args: [],
    url: null,
    cwd: null,
    env,
    headers: null,
    description: entry.description,
    catalogId: entry.id,
    email,
    workspace: null,
    lastConnectedAt: 1_714_000_000_000,
  };
}

function installWindowStubs(
  mcpAddBundledServer: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({ success: true }),
): void {
  Object.assign(window, {
    settingsApi: {
      mcpAddBundledServer,
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
  onLoadServer,
  mcpAddBundledServer,
  onRefresh,
}: {
  entry?: ConnectorCatalogEntry;
  onLoadServer?: (serverName: string) => Promise<McpServerConfigDetails>;
  mcpAddBundledServer?: ReturnType<typeof vi.fn>;
  onRefresh?: () => void;
} = {}): { mounted: Mounted; onLoadServer: ReturnType<typeof vi.fn>; onRefresh: () => void; mcpAddBundledServer: ReturnType<typeof vi.fn> } {
  const addServer = mcpAddBundledServer ?? vi.fn().mockResolvedValue({ success: true });
  installWindowStubs(addServer);
  const loadServer = vi.fn(onLoadServer ?? (async () => serverDetails(entry, {
    [entry.setupFields?.[0]?.envVar ?? 'API_KEY']: 'saved-secret',
  })));
  const refresh = onRefresh ?? vi.fn();
  const mounted = mount(
    <ExpandedConnectionCard
      connection={connectionFor(entry)}
      onClose={vi.fn()}
      onLoadServer={loadServer}
      ops={createTestConnectionCardOps()}
      onRefresh={refresh}
    />,
  );
  return { mounted, onLoadServer: loadServer, onRefresh: refresh, mcpAddBundledServer: addServer };
}

function getButton(container: HTMLElement, testId: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!button) {
    throw new Error(`Button not found: ${testId}`);
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

async function openUpdateForm(container: HTMLElement): Promise<void> {
  await clickButton(getButton(container, 'connector-update-credentials-button'));
  await flushAsyncWork();
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function cancelButton(container: HTMLElement): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent?.includes('Cancel'));
  if (!button) {
    throw new Error('Cancel button not found');
  }
  return button;
}

describe('ExpandedConnectionCard — update credentials mode', () => {
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

  it('single-secret connector renders "Update key" button on connected healthy card', async () => {
    ({ mounted } = renderCard());
    await flushAsyncWork();

    expect(getButton(mounted.container, 'connector-update-credentials-button').textContent).toContain('Update key');
  });

  it('multi-field connector renders "Update details" button', async () => {
    ({ mounted } = renderCard({ entry: multiFieldEntry() }));
    await flushAsyncWork();

    expect(getButton(mounted.container, 'connector-update-credentials-button').textContent).toContain('Update details');
  });

  it('clicking the button opens the SetupFieldsForm in update mode with email locked', async () => {
    ({ mounted } = renderCard());

    await openUpdateForm(mounted.container);

    expect(mounted.container.textContent).toContain('Update key');
    expect(getButton(mounted.container, 'connector-setup-save-button').textContent).toContain('Save');
    const emailInput = mounted.container.querySelector<HTMLInputElement>('#setup-email-expanded');
    expect(emailInput?.value).toBe('existing@example.com');
    expect(emailInput?.readOnly).toBe(true);
  });

  it('password fields are blank in update mode', async () => {
    ({ mounted } = renderCard({
      entry: multiFieldEntry(),
      onLoadServer: async () => serverDetails(multiFieldEntry(), {
        KLING_ACCESS_KEY: 'saved-access-key',
        KLING_SECRET_KEY: 'saved-secret-key',
      }),
    }));

    await openUpdateForm(mounted.container);

    expect(mounted.container.querySelector<HTMLInputElement>('#setup-secretKey-expanded')?.value).toBe('');
  });

  it('non-secret fields (e.g. select, boolean) pre-fill from the existing entry', async () => {
    const entry = selectBooleanEntry();
    ({ mounted } = renderCard({
      entry,
      onLoadServer: async () => serverDetails(entry, {
        DETAILS_API_KEY: 'saved-secret',
        DETAILS_REGION: 'eu',
        DETAILS_READ_ONLY: 'true',
      }),
    }));

    await openUpdateForm(mounted.container);

    expect(mounted.container.querySelector<HTMLSelectElement>('#setup-region-expanded')?.value).toBe('eu');
    expect(mounted.container.querySelector<HTMLInputElement>('#setup-readOnly-expanded')?.checked).toBe(true);
  });

  it('cancel resets isUpdating without firing IPC', async () => {
    const mcpAddBundledServer = vi.fn().mockResolvedValue({ success: true });
    ({ mounted } = renderCard({ mcpAddBundledServer }));

    await openUpdateForm(mounted.container);
    await clickButton(cancelButton(mounted.container));

    expect(mcpAddBundledServer).not.toHaveBeenCalled();
    expect(mounted.container.querySelector('[data-testid="connector-setup-save-button"]')).toBeNull();
    expect(getButton(mounted.container, 'connector-update-credentials-button').textContent).toContain('Update key');
  });

  it("save fires mcpAddBundledServer with mode='update' and serverName=activeServerName", async () => {
    const mcpAddBundledServer = vi.fn().mockResolvedValue({ success: true });
    ({ mounted } = renderCard({ mcpAddBundledServer }));

    await openUpdateForm(mounted.container);
    const emailInput = mounted.container.querySelector<HTMLInputElement>('#setup-email-expanded');
    if (!emailInput) {
      throw new Error('Email input not found');
    }
    setInputValue(emailInput, 'changed@example.com');
    await clickButton(getButton(mounted.container, 'connector-setup-save-button'));

    expect(mcpAddBundledServer).toHaveBeenCalledWith(expect.objectContaining({
      serverName: 'GammaMcp',
      mode: 'update',
      email: 'existing@example.com',
      catalogId: 'bundled-gamma',
    }));
  });

  it('save success resets isUpdating and calls onRefresh after health-check success', async () => {
    const onRefresh = vi.fn();
    ({ mounted } = renderCard({ onRefresh }));

    await openUpdateForm(mounted.container);
    await clickButton(getButton(mounted.container, 'connector-setup-save-button'));
    await flushAsyncWork();

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(mounted.container.querySelector('[data-testid="connector-setup-save-button"]')).toBeNull();
    expect(getButton(mounted.container, 'connector-update-credentials-button')).toBeTruthy();
  });

  it('save failure leaves form open with the error displayed', async () => {
    const mcpAddBundledServer = vi.fn().mockRejectedValue(new Error('New key rejected'));
    ({ mounted } = renderCard({ mcpAddBundledServer }));

    await openUpdateForm(mounted.container);
    await clickButton(getButton(mounted.container, 'connector-setup-save-button'));
    await flushAsyncWork();

    expect(mounted.container.querySelector('[data-testid="connector-setup-save-button"]')).toBeTruthy();
    expect(mounted.container.textContent).toContain('New key rejected');
    expect(mounted.container.querySelector('[data-testid="connector-update-credentials-button"]')).toBeNull();
  });

  it('OAuth connectors do NOT render the update button', async () => {
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

    expect(mounted.container.querySelector('[data-testid="connector-update-credentials-button"]')).toBeNull();
  });

  it('oauth-user-provided connectors do NOT render the update button', async () => {
    const entry = baseCatalogEntry({
      id: 'bundled-salesforce',
      name: 'Salesforce',
      provider: 'bundled',
      bundledConfig: {
        authType: 'oauth-user-provided',
        serverName: 'Salesforce',
      },
      setupFields: [
        {
          id: 'clientId',
          label: 'Client ID',
          type: 'text',
          settingsKey: 'salesforce.clientId',
        },
        {
          id: 'clientSecret',
          label: 'Client Secret',
          type: 'password',
          settingsKey: 'salesforce.clientSecret',
        },
      ],
    });
    ({ mounted } = renderCard({ entry }));
    await flushAsyncWork();

    expect(mounted.container.querySelector('[data-testid="connector-update-credentials-button"]')).toBeNull();
  });

  it('internal connectors do NOT render the update button', async () => {
    const entry = baseCatalogEntry({
      id: 'bundled-internal',
      name: 'Internal MCP',
      provider: 'bundled',
      isInternal: true,
    });
    ({ mounted } = renderCard({ entry }));
    await flushAsyncWork();

    expect(mounted.container.querySelector('[data-testid="connector-update-credentials-button"]')).toBeNull();
  });
});
