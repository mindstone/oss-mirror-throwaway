// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '@renderer/components/ui';
import { AccountIdentityEnum } from '@shared/connectorCatalogSchema';
import { getIdentityFieldDisplay, type IdentityKind } from '@shared/identityKinds';
import type { ConnectorCatalogEntry } from '@shared/types';
import { ExpandedConnectionCard } from '../ExpandedConnectionCard';
import { createTestConnectionCardOps } from './connectionCardOpsTestUtils';
import type { UnifiedConnection } from '../../hooks/useUnifiedConnections';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const identityKinds = AccountIdentityEnum.options as readonly IdentityKind[];

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

function installWindowStubs(): void {
  Object.assign(window, {
    settingsApi: {
      mcpAddBundledServer: vi.fn().mockResolvedValue({ success: true }),
      mcpListTools: vi.fn().mockResolvedValue({ tools: [], nextPageToken: null }),
      mcpToggleServerEnabled: vi.fn().mockResolvedValue({ success: true }),
      mcpValidateServer: vi.fn().mockResolvedValue({ status: 'ok' }),
      mcpRestartSuperMcp: vi.fn().mockResolvedValue({ success: true }),
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
    githubApi: {
      startAuth: vi.fn().mockResolvedValue({ success: true }),
    },
  });
}

function makeCatalogEntry({
  id,
  accountIdentity,
}: {
  id: string;
  accountIdentity: IdentityKind;
}): ConnectorCatalogEntry {
  return {
    id,
    name: `Connector ${id}`,
    description: 'Connector description',
    category: 'productivity',
    icon: 'bot',
    provider: 'direct',
    requiresSetup: false,
    accountIdentity,
    bundledConfig: {
      authType: 'oauth',
      serverName: `Server ${id}`,
    },
  } as unknown as ConnectorCatalogEntry;
}

function makeAvailableConnection(entry: ConnectorCatalogEntry): UnifiedConnection {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    icon: entry.icon,
    status: 'available',
    provider: 'direct',
    catalogEntry: entry,
  };
}

function makeConnectedConnection(entry: ConnectorCatalogEntry): UnifiedConnection {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    icon: entry.icon,
    status: 'connected',
    provider: 'direct',
    catalogEntry: entry,
    serverPreview: {
      name: `Server ${entry.id}`,
      transport: 'stdio',
      health: 'ok',
      catalogId: entry.id,
      email: 'existing@example.com',
      toolCount: 0,
    },
    health: 'ok',
    toolCount: 0,
    instances: [
      {
        serverName: `Server ${entry.id}`,
        label: 'existing@example.com',
        health: 'ok',
      },
    ],
  };
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function getButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent?.includes(text));

  if (!button) {
    throw new Error(`Button not found: ${text}`);
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

describe('ExpandedConnectionCard identity display reads', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'settingsApi');
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'miscApi');
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'appApi');
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'githubApi');
  });

  it.each(identityKinds)(
    'direct identity input renders %s metadata when that path is active',
    async (kind) => {
      installWindowStubs();
      const entry = makeCatalogEntry({ id: `direct-${kind}`, accountIdentity: kind });
      const connection = makeAvailableConnection(entry);

      mounted = mount(
        <ExpandedConnectionCard
          connection={connection}
	          onClose={vi.fn()}
	          onConnect={vi.fn()}
	          onConfigureWithRebel={vi.fn()}
	          ops={createTestConnectionCardOps()}
	        />,
      );
      await flushAsyncWork();

      const input = mounted.container.querySelector<HTMLInputElement>('#direct-identity-expanded');
      const label = mounted.container.querySelector<HTMLLabelElement>('label[for="direct-identity-expanded"]');

      if (kind === 'email' || kind === 'workspace') {
        const display = getIdentityFieldDisplay(kind);
        expect(label?.textContent).toContain(display.label);
        expect(input).toBeTruthy();
        expect(input?.type).toBe(display.inputType);
        expect(input?.placeholder).toBe(display.placeholder);
      } else {
        // Stage 2 Option B keeps render-gates untouched. Non-email/workspace kinds
        // intentionally do not render this input in the current card flow.
        expect(input).toBeNull();
      }
    },
  );

  it.each([
    ['email', 'Account Email', 'you@example.com'],
    ['workspace', 'Workspace Name', 'My Workspace'],
  ] as const)(
    'direct identity path keeps byte-identical defaults for %s',
    async (kind, expectedLabel, expectedPlaceholder) => {
      installWindowStubs();
      const entry = makeCatalogEntry({ id: `literal-direct-${kind}`, accountIdentity: kind });
      const connection = makeAvailableConnection(entry);

      mounted = mount(
        <ExpandedConnectionCard
          connection={connection}
	          onClose={vi.fn()}
	          onConnect={vi.fn()}
	          onConfigureWithRebel={vi.fn()}
	          ops={createTestConnectionCardOps()}
	        />,
      );
      await flushAsyncWork();

      const input = mounted.container.querySelector<HTMLInputElement>('#direct-identity-expanded');
      const label = mounted.container.querySelector<HTMLLabelElement>('label[for="direct-identity-expanded"]');

      expect(label?.textContent).toContain(expectedLabel);
      expect(input?.placeholder).toBe(expectedPlaceholder);
    },
  );

  it.each([
    ['email', 'Add account'],
    ['workspace', 'Add workspace'],
  ] as const)(
    'add-another identity input renders %s metadata when opened from account list',
    async (kind, addButtonText) => {
      installWindowStubs();
      const entry = makeCatalogEntry({ id: `add-another-${kind}`, accountIdentity: kind });
      const connection = makeConnectedConnection(entry);

      mounted = mount(
        <ExpandedConnectionCard
          connection={connection}
	          onClose={vi.fn()}
	          onConnect={vi.fn()}
	          onConfigureWithRebel={vi.fn()}
	          ops={createTestConnectionCardOps()}
	        />,
      );
      await flushAsyncWork();

      await clickButton(getButtonByText(mounted.container, addButtonText));
      await flushAsyncWork();

      const input = mounted.container.querySelector<HTMLInputElement>('#add-another-identity');
      const label = mounted.container.querySelector<HTMLLabelElement>('label[for="add-another-identity"]');
      const display = getIdentityFieldDisplay(kind);

      expect(label?.textContent).toContain(display.label);
      expect(input).toBeTruthy();
      expect(input?.type).toBe(display.inputType);
      expect(input?.placeholder).toBe(display.placeholder);
    },
  );

  it.each([
    ['email', 'Account Email', 'you@example.com'],
    ['workspace', 'Workspace Name', 'My Workspace'],
  ] as const)(
    'add-another path keeps byte-identical defaults for %s',
    async (kind, expectedLabel, expectedPlaceholder) => {
      installWindowStubs();
      const entry = makeCatalogEntry({ id: `literal-add-${kind}`, accountIdentity: kind });
      const connection = makeConnectedConnection(entry);

      mounted = mount(
        <ExpandedConnectionCard
          connection={connection}
	          onClose={vi.fn()}
	          onConnect={vi.fn()}
	          onConfigureWithRebel={vi.fn()}
	          ops={createTestConnectionCardOps()}
	        />,
      );
      await flushAsyncWork();

      await clickButton(getButtonByText(mounted.container, kind === 'workspace' ? 'Add workspace' : 'Add account'));
      await flushAsyncWork();

      const input = mounted.container.querySelector<HTMLInputElement>('#add-another-identity');
      const label = mounted.container.querySelector<HTMLLabelElement>('label[for="add-another-identity"]');

      expect(label?.textContent).toContain(expectedLabel);
      expect(input?.placeholder).toBe(expectedPlaceholder);
    },
  );

});
