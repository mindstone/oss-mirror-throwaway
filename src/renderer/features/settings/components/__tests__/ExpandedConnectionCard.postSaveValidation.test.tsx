// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sonnerMocks = vi.hoisted(() => ({
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock('sonner', () => ({
  Toaster: () => null,
  toast: Object.assign(sonnerMocks.toast, {
    success: sonnerMocks.success,
    error: sonnerMocks.error,
    warning: sonnerMocks.warning,
    info: sonnerMocks.info,
    dismiss: sonnerMocks.dismiss,
  }),
}));

vi.mock('@renderer/src/sentry', () => ({
  captureRendererMessage: vi.fn(),
  recordRendererBreadcrumb: vi.fn(),
}));

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

type VoidCallback = () => void;

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

function gammaEntry(): ConnectorCatalogEntry {
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
  } as ConnectorCatalogEntry;
}

function connectionFor(entry: ConnectorCatalogEntry): UnifiedConnection {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    icon: entry.icon,
    status: 'connected',
    provider: entry.provider,
    catalogEntry: entry,
    serverPreview: {
      name: entry.bundledConfig?.serverName ?? entry.name,
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

function serverDetails(entry: ConnectorCatalogEntry): McpServerConfigDetails {
  return {
    name: entry.bundledConfig?.serverName ?? entry.name,
    type: null,
    transport: 'stdio',
    command: 'npx',
    args: [],
    url: null,
    cwd: null,
    env: { GAMMA_API_KEY: 'saved-secret' },
    headers: null,
    description: entry.description,
    catalogId: entry.id,
    email: 'existing@example.com',
    workspace: null,
    lastConnectedAt: 1_714_000_000_000,
  };
}

function installWindowStubs({
  mcpAddBundledServer = vi.fn().mockResolvedValue({ success: true }),
  mcpValidateServer = vi.fn().mockResolvedValue({ status: 'ok' }),
}: {
  mcpAddBundledServer?: ReturnType<typeof vi.fn>;
  mcpValidateServer?: ReturnType<typeof vi.fn>;
} = {}): { mcpAddBundledServer: ReturnType<typeof vi.fn>; mcpValidateServer: ReturnType<typeof vi.fn> } {
  Object.assign(window, {
    settingsApi: {
      mcpAddBundledServer,
      mcpValidateServer,
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
  return { mcpAddBundledServer, mcpValidateServer };
}

function renderCard({
  mcpAddBundledServer,
  mcpValidateServer,
  onRefresh = vi.fn<VoidCallback>(),
}: {
  mcpAddBundledServer?: ReturnType<typeof vi.fn>;
  mcpValidateServer?: ReturnType<typeof vi.fn>;
  onRefresh?: VoidCallback;
} = {}): {
  mounted: Mounted;
  mcpAddBundledServer: ReturnType<typeof vi.fn>;
  mcpValidateServer: ReturnType<typeof vi.fn>;
  onRefresh: VoidCallback;
} {
  const entry = gammaEntry();
  const stubs = installWindowStubs({ mcpAddBundledServer, mcpValidateServer });
  const mounted = mount(
    <ExpandedConnectionCard
	      connection={connectionFor(entry)}
	      onClose={() => undefined}
	      onLoadServer={vi.fn(async () => serverDetails(entry))}
	      ops={createTestConnectionCardOps()}
	      onRefresh={onRefresh}
	    />,
  );
  return { mounted, ...stubs, onRefresh };
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

describe('ExpandedConnectionCard — post-save validation', () => {
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

  it('successful save + ok health check resets isUpdating, surfaces success notice, calls onRefresh', async () => {
    const onRefresh = vi.fn();
    ({ mounted } = renderCard({ onRefresh }));

    await openUpdateForm(mounted.container);
    await clickButton(getButton(mounted.container, 'connector-setup-save-button'));
    await flushAsyncWork();

    expect(mounted.container.querySelector('[data-testid="connector-setup-save-button"]')).toBeNull();
    expect(mounted.container.textContent).toContain('Updated. Tested the new key — all good.');
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(sonnerMocks.success).toHaveBeenCalledWith(
      'Key updated',
      expect.objectContaining({ description: 'Rebel is checking Gamma now.' }),
    );
  });

  it('successful save + error health check keeps form open, surfaces error inline, no lastConnectedAt advance', async () => {
    const onRefresh = vi.fn();
    ({ mounted } = renderCard({
      onRefresh,
      mcpValidateServer: vi.fn().mockResolvedValue({ status: 'error', error: 'Bad credentials' }),
    }));

    await openUpdateForm(mounted.container);
    await clickButton(getButton(mounted.container, 'connector-setup-save-button'));
    await flushAsyncWork();

    expect(mounted.container.querySelector('[data-testid="connector-setup-save-button"]')).toBeTruthy();
    expect(mounted.container.textContent).toContain("Saved, but the new key didn't work. Double-check it and try again.");
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('successful save + unavailable health check closes form, surfaces warning, no lastConnectedAt advance', async () => {
    const onRefresh = vi.fn();
    ({ mounted } = renderCard({
      onRefresh,
      mcpValidateServer: vi.fn().mockResolvedValue({ status: 'unavailable' }),
    }));

    await openUpdateForm(mounted.container);
    await clickButton(getButton(mounted.container, 'connector-setup-save-button'));
    await flushAsyncWork();

    expect(mounted.container.querySelector('[data-testid="connector-setup-save-button"]')).toBeNull();
    expect(mounted.container.textContent).toContain("Saved, but we couldn't validate. Will retry next time the connector loads.");
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('failed save (IPC throw) keeps form open, surfaces error, no health check fired', async () => {
    const mcpValidateServer = vi.fn().mockResolvedValue({ status: 'ok' });
    ({ mounted } = renderCard({
      mcpAddBundledServer: vi.fn().mockRejectedValue(new Error('Config save failed')),
      mcpValidateServer,
    }));

    await openUpdateForm(mounted.container);
    await clickButton(getButton(mounted.container, 'connector-setup-save-button'));
    await flushAsyncWork();

    expect(mounted.container.querySelector('[data-testid="connector-setup-save-button"]')).toBeTruthy();
    expect(mounted.container.textContent).toContain('Config save failed');
    expect(mcpValidateServer).not.toHaveBeenCalled();
  });
});
