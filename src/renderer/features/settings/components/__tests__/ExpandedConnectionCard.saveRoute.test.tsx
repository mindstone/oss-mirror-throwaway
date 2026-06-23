// @vitest-environment happy-dom

/**
 * Save-path routing guard for ExpandedConnectionCard (260417 regression class).
 *
 * Locks the 3 live `handleSaveSetup` routes enumerated in
 * `src/shared/__tests__/connectorCatalog.test.ts:330-347`:
 *   1. authType='api-key'            → window.settingsApi.mcpAddBundledServer
 *   2. authType='oauth-user-provided'→ window.settingsApi.update + onConnect
 *   3. authType='none' + setupFields → window.settingsApi.mcpAddBundledServer
 *
 * Plus a negative-case test (bundledConfig stripped from an api-key fixture)
 * that documents the 260417 silent-fallthrough failure mode: a bundled-like
 * entry missing bundledConfig routes to the generic `onUpsertServer` path,
 * which does NOT resolve `{{BRIDGE_STATE_PATH}}`-style template variables and
 * would silently re-publish a broken connector. The catalog-level guard in
 * connectorCatalog.test.ts prevents this at write-time; this test locks the
 * routing side of the contract at the UI boundary.
 *
 * Background: docs-private/postmortems/260417_rebel_oss_bundledconfig_regression_postmortem.md
 * Plan: docs/plans/260422_bundledconfig_prevention_followups.md
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '@renderer/components/ui';
import { ExpandedConnectionCard } from '../ExpandedConnectionCard';
import { createTestConnectionCardOps } from './connectionCardOpsTestUtils';
import type { UnifiedConnection } from '../../hooks/useUnifiedConnections';
import type { ConnectorCatalog, ConnectorCatalogEntry } from '@shared/types';
import { buildSettingsUpsertRestartContext } from '@shared/utils/mcpRestartContexts';
import catalogData from '../../../../../../resources/connector-catalog.json';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const catalog = catalogData as ConnectorCatalog;

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
  });
}

/**
 * Build a minimal UnifiedConnection backed by a real catalog entry. Keeps test
 * fixtures realistic (catalog-sampled rather than synthetic) so the test tracks
 * catalog-shape evolutions. `overrides.catalogEntry` is a shallow merge so the
 * negative-case test can strip bundledConfig without rebuilding the full entry.
 */
function buildFixtureConnection(
  catalogId: string,
  overrides: {
    catalogEntry?: Partial<ConnectorCatalogEntry>;
    status?: UnifiedConnection['status'];
  } = {},
): UnifiedConnection {
  const entry = catalog.connectors.find((c) => c.id === catalogId);
  if (!entry) {
    throw new Error(`Test fixture catalog entry not found: ${catalogId}`);
  }
  // `as unknown as ConnectorCatalogEntry` is intentional: the negative-case
  // test deliberately violates the strict shape (`bundledConfig: undefined`)
  // to simulate the 260417 regression state. The catalog test forbids that
  // shape in real JSON; this cast lets us reproduce it in a test without
  // relaxing the production type.
  const mergedEntry = { ...entry, ...overrides.catalogEntry } as unknown as ConnectorCatalogEntry;
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    icon: entry.icon ?? '',
    status: overrides.status ?? 'available',
    provider: entry.provider,
    catalogEntry: mergedEntry,
  };
}

/**
 * R-12: Fail-loud stub pattern — unexpected IPC calls throw rather than
 * silently resolve. The `overrides` parameter lets each test opt into the
 * specific IPC methods it exercises. `__fallbackMessage` helps identify
 * *which* test triggered the unexpected call in CI logs.
 */
function installFailLoudStubs(
  overrides: {
    settingsApi?: Partial<{
      mcpAddBundledServer: (...args: unknown[]) => unknown;
      get: (...args: unknown[]) => unknown;
      update: (...args: unknown[]) => unknown;
      mcpToggleServerEnabled: (...args: unknown[]) => unknown;
    }>;
    appApi?: Partial<{ openUrl: (...args: unknown[]) => unknown }>;
    miscApi?: Partial<{ checkPythonRuntime: (...args: unknown[]) => unknown }>;
    __fallbackMessage?: string;
  } = {},
): void {
  const fallback = (method: string) => () => {
    throw new Error(
      `[saveRoute test] Unexpected IPC call: ${method}${
        overrides.__fallbackMessage ? ` (${overrides.__fallbackMessage})` : ''
      }`,
    );
  };

  Object.assign(window, {
    settingsApi: {
      mcpAddBundledServer: overrides.settingsApi?.mcpAddBundledServer ?? fallback('settingsApi.mcpAddBundledServer'),
      get: overrides.settingsApi?.get ?? fallback('settingsApi.get'),
      update: overrides.settingsApi?.update ?? fallback('settingsApi.update'),
      mcpToggleServerEnabled: overrides.settingsApi?.mcpToggleServerEnabled ?? fallback('settingsApi.mcpToggleServerEnabled'),
    },
    appApi: {
      openUrl: overrides.appApi?.openUrl ?? fallback('appApi.openUrl'),
    },
    miscApi: {
      // R-12: fail loud by default — none of the fixtures (elevenlabs, salesforce,
      // ibkr) declare runtime: 'python', so the ExpandedConnectionCard useEffect
      // at line ~446 should short-circuit and never call this. If a future fixture
      // adds a python-runtime entry, this assertion surfaces the coupling.
      checkPythonRuntime: overrides.miscApi?.checkPythonRuntime ?? fallback('miscApi.checkPythonRuntime'),
    },
  });
}

function fillInput(container: HTMLElement, selector: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(selector);
  if (!input) {
    throw new Error(`[saveRoute test] Input not found for selector: ${selector}`);
  }
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function fillSelect(container: HTMLElement, selector: string, value: string): void {
  const select = container.querySelector<HTMLSelectElement>(selector);
  if (!select) {
    throw new Error(`[saveRoute test] Select not found for selector: ${selector}`);
  }
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    'value',
  )?.set;
  act(() => {
    setter?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function clickSaveButton(container: HTMLElement): Promise<void> {
  const saveBtn = container.querySelector<HTMLButtonElement>(
    '[data-testid="connector-setup-save-button"]',
  );
  if (!saveBtn) {
    throw new Error('[saveRoute test] Save button not found (data-testid="connector-setup-save-button")');
  }
  if (saveBtn.disabled) {
    throw new Error('[saveRoute test] Save button is disabled — check that all required setup fields are filled');
  }
  await act(async () => {
    saveBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ExpandedConnectionCard — save-path routing (260417 regression guard)', () => {
  let mounted: Mounted | null = null;

  beforeEach(() => {
    mounted = null;
  });

  // R-9: mandatory window-globals teardown — mirrors OfficeSidecarStatusSection.test.tsx
  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'settingsApi');
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'appApi');
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'miscApi');
  });

  it('[api-key] routes through mcpAddBundledServer, not onUpsertServer (ElevenLabs fixture)', async () => {
    const mcpAddBundledServer = vi.fn().mockResolvedValue(undefined);
    const onUpsertServer = vi.fn(() => {
      throw new Error('onUpsertServer must not be called on the api-key route');
    });
    const onConfigureWithRebel = vi.fn();

    installFailLoudStubs({
      settingsApi: { mcpAddBundledServer },
      __fallbackMessage: 'api-key positive',
    });

    const connection = buildFixtureConnection('bundled-elevenlabs');

    mounted = mount(
      <ExpandedConnectionCard
        connection={connection}
        onClose={vi.fn()}
        ops={createTestConnectionCardOps({ upsertServer: onUpsertServer })}
        onConfigureWithRebel={onConfigureWithRebel}
        onRefresh={vi.fn()}
      />,
    );
    await flushAsyncWork();

    fillInput(mounted.container, '#setup-apiKey-expanded', 'fake-test-api-key');
    fillInput(mounted.container, '#setup-email-expanded', 'user@example.com');

    await clickSaveButton(mounted.container);

    expect(mcpAddBundledServer).toHaveBeenCalledTimes(1);
    expect(mcpAddBundledServer).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: 'ElevenLabs',
        apiKey: 'fake-test-api-key',
        email: 'user@example.com',
        catalogId: 'bundled-elevenlabs',
      }),
    );
    expect(onUpsertServer).not.toHaveBeenCalled();
  });

  it('[api-key negative] falls through to onUpsertServer when bundledConfig is missing (260417 failure mode)', async () => {
    // R-5: mandatory negative-case. This documents the exact shape of the
    // 260417 regression: a bundled-like entry with bundledConfig stripped
    // bypasses the mcpAddBundledServer route and silently lands on the
    // generic onUpsertServer path. The catalog test forbids this JSON shape;
    // this test locks the routing side so a future refactor that "fixes" the
    // fallthrough without updating the route would fail here.
    const mcpAddBundledServer = vi.fn(() => {
      throw new Error('mcpAddBundledServer must not be called when bundledConfig is missing');
    });
    const onUpsertServer = vi.fn().mockResolvedValue(undefined);

    installFailLoudStubs({
      settingsApi: { mcpAddBundledServer },
      __fallbackMessage: 'api-key negative (stripped bundledConfig)',
    });

    const connection = buildFixtureConnection('bundled-elevenlabs', {
      catalogEntry: { bundledConfig: undefined },
    });

    mounted = mount(
      <ExpandedConnectionCard
        connection={connection}
        onClose={vi.fn()}
        ops={createTestConnectionCardOps({ upsertServer: onUpsertServer })}
        onConfigureWithRebel={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    await flushAsyncWork();

    // With bundledConfig stripped, isBundledApiKey=false and isManualSetup=true
    // (requiresSetup + setupFields). Form still renders via the isManualSetup
    // branch; the email field gets the `setup-email-manual-expanded` id because
    // the `isBundledApiKey` guard there is false.
    fillInput(mounted.container, '#setup-apiKey-expanded', 'fake-test-api-key');
    fillInput(mounted.container, '#setup-email-manual-expanded', 'user@example.com');

    await clickSaveButton(mounted.container);

    expect(onUpsertServer).toHaveBeenCalledTimes(1);
    expect(mcpAddBundledServer).not.toHaveBeenCalled();
  });

  it('[oauth-user-provided] routes through settingsApi.update + onConnect, not onUpsertServer (Salesforce fixture)', async () => {
    const settingsGet = vi.fn().mockResolvedValue({});
    const settingsUpdate = vi.fn().mockResolvedValue(undefined);
    const onConnect = vi.fn();
    const onUpsertServer = vi.fn(() => {
      throw new Error('onUpsertServer must not be called on the oauth-user-provided route');
    });

    installFailLoudStubs({
      settingsApi: { get: settingsGet, update: settingsUpdate },
      __fallbackMessage: 'oauth-user-provided (Salesforce)',
    });

    const connection = buildFixtureConnection('bundled-salesforce');

    mounted = mount(
      <ExpandedConnectionCard
        connection={connection}
        onClose={vi.fn()}
        ops={createTestConnectionCardOps({ upsertServer: onUpsertServer })}
        onConnect={onConnect}
        onConfigureWithRebel={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    await flushAsyncWork();

    // environment defaults to 'production' via setupFields default, so it's
    // pre-populated. Fill the remaining required fields explicitly.
    fillSelect(mounted.container, '#setup-environment-expanded', 'production');
    fillInput(mounted.container, '#setup-clientId-expanded', 'test-client-id');
    fillInput(mounted.container, '#setup-clientSecret-expanded', 'test-client-secret');
    fillInput(mounted.container, '#setup-email-expanded', 'user@example.com');

    await clickSaveButton(mounted.container);

    expect(settingsGet).toHaveBeenCalledTimes(1);
    expect(settingsUpdate).toHaveBeenCalledTimes(1);
    const [updatePayload] = settingsUpdate.mock.calls[0];
    // Payload should contain the nested salesforce block with the credentials
    // we entered. Catalog maps settingsKey 'salesforce.clientId' → nested path.
    expect(updatePayload).toEqual(
      expect.objectContaining({
        salesforce: expect.objectContaining({
          clientId: 'test-client-id',
          clientSecret: 'test-client-secret',
          environment: 'production',
        }),
      }),
    );
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onConnect).toHaveBeenCalledWith(
      'user@example.com',
      expect.objectContaining({ launchRebel: true }),
    );
    expect(onUpsertServer).not.toHaveBeenCalled();
  });

  it('[none + setupFields] routes through mcpAddBundledServer with credentials payload (IBKR fixture)', async () => {
    const mcpAddBundledServer = vi.fn().mockResolvedValue(undefined);
    const onUpsertServer = vi.fn(() => {
      throw new Error('onUpsertServer must not be called on the auth-none+setupFields route');
    });

    installFailLoudStubs({
      settingsApi: { mcpAddBundledServer },
      __fallbackMessage: 'auth-none + setupFields (IBKR)',
    });

    const connection = buildFixtureConnection('bundled-ibkr');

    mounted = mount(
      <ExpandedConnectionCard
        connection={connection}
        onClose={vi.fn()}
        ops={createTestConnectionCardOps({ upsertServer: onUpsertServer })}
        onConfigureWithRebel={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    await flushAsyncWork();

    fillInput(mounted.container, '#setup-mode-expanded', 'paper');
    fillInput(mounted.container, '#setup-port-expanded', '7497');
    fillInput(mounted.container, '#setup-host-expanded', '127.0.0.1');
    fillInput(mounted.container, '#setup-clientId-expanded', '1');

    await clickSaveButton(mounted.container);

    expect(mcpAddBundledServer).toHaveBeenCalledTimes(1);
    expect(mcpAddBundledServer).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: 'IBKR',
        catalogId: 'bundled-ibkr',
        credentials: expect.objectContaining({
          mode: 'paper',
          port: '7497',
          host: '127.0.0.1',
          clientId: '1',
        }),
      }),
    );
    expect(onUpsertServer).not.toHaveBeenCalled();
  });

  it('[direct + oauth + setupFields URL] propagates oauth flag through onUpsertServer (n8n fixture)', async () => {
    // Direct OAuth connectors that take a user-supplied URL (e.g. n8n MCP) must
    // forward `oauth: true` from the catalog mcpConfig through the setupFields
    // save path. Without that propagation, Super-MCP never starts the OAuth
    // handshake and the connector silently fails to authenticate. Mirrors the
    // propagation already done in UnifiedConnectionsPanel.handleConnect.
    const onUpsertServer = vi.fn().mockResolvedValue(undefined);

    installFailLoudStubs({
      __fallbackMessage: 'direct + oauth + setupFields URL (n8n)',
    });

    const connection = buildFixtureConnection('n8n');

    mounted = mount(
      <ExpandedConnectionCard
        connection={connection}
        onClose={vi.fn()}
        ops={createTestConnectionCardOps({ upsertServer: onUpsertServer })}
        onConfigureWithRebel={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    await flushAsyncWork();

    fillInput(
      mounted.container,
      '#setup-url-expanded',
      'https://my-n8n.example.com/mcp-server/http',
    );

    await clickSaveButton(mounted.container);

    expect(onUpsertServer).toHaveBeenCalledTimes(1);
    expect(onUpsertServer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: connection.name,
        transport: 'http',
        url: 'https://my-n8n.example.com/mcp-server/http',
        oauth: true,
        catalogId: 'n8n',
      }),
      {
        kind: 'connect',
        context: buildSettingsUpsertRestartContext(connection.name),
      },
    );
  });
});
