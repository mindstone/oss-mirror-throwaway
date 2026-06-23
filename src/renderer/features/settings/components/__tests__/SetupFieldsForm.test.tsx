// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SetupFieldsForm } from '../SetupFieldsForm';
import type { ConnectorCatalogEntry } from '@shared/types';

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
    root.render(ui);
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

function makeCatalogEntry(): ConnectorCatalogEntry {
  return {
    id: 'bundled-test',
    name: 'Test Connector',
    description: 'A connector used for setup-form tests.',
    category: 'productivity',
    icon: 'test',
    provider: 'bundled',
    requiresSetup: true,
    accountIdentity: 'email',
    callbackUrl: 'https://app.example.test/oauth/callback',
    setupUrl: 'https://vendor.example.test/setup',
    setupUrlBehavior: 'button',
    setupInstructions: '1. Open the vendor settings\n2. Paste the key below',
    bundledConfig: {
      authType: 'api-key',
      serverName: 'TestConnector',
    },
    setupFields: [
      {
        id: 'apiKey',
        label: 'API Key',
        type: 'password',
        placeholder: 'fake-api-key',
      },
      {
        id: 'workspace',
        label: 'Workspace',
        type: 'text',
        placeholder: 'Acme',
      },
      {
        id: 'endpoint',
        label: 'Endpoint',
        type: 'url',
        placeholder: 'https://api.example.test',
      },
      {
        id: 'environment',
        label: 'Environment',
        type: 'select',
        default: 'production',
        options: [
          { value: 'production', label: 'Production' },
          { value: 'sandbox', label: 'Sandbox' },
        ],
      },
      {
        id: 'readOnly',
        label: 'Read-only mode',
        type: 'boolean',
        required: false,
        default: 'false',
        helpText: 'Limits write operations.',
      },
    ],
  };
}

function renderForm(
  overrides: Partial<React.ComponentProps<typeof SetupFieldsForm>> = {},
): Mounted {
  const catalogEntry = overrides.catalogEntry ?? makeCatalogEntry();
  return mount(
    <SetupFieldsForm
      mode="create"
      catalogEntry={catalogEntry}
      connectionName={catalogEntry.name}
      fieldValues={{
        apiKey: 'secret',
        workspace: 'Acme',
        endpoint: 'https://api.example.test',
        environment: 'production',
        readOnly: 'false',
        email: 'user@example.com',
      }}
      onChange={vi.fn()}
      onSubmit={vi.fn()}
      onCancel={vi.fn()}
      isSaving={false}
      error={null}
      providerKeyPreFill={null}
      callbackUrlCopied={false}
      onCopyCallbackUrl={vi.fn()}
      onOpenSetupUrl={vi.fn()}
      submitWithRebel
      showBundledEmailField
      showManualEmailField={false}
      showManualWorkspaceField={false}
      skipDefaultUrlField={false}
      {...overrides}
    />,
  );
}

function getSaveButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('[data-testid="connector-setup-save-button"]');
  if (!button) {
    throw new Error('Save button not found');
  }
  return button;
}

describe('SetupFieldsForm', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('renders fields per type for create mode', () => {
    mounted = renderForm({ mode: 'create' });

    expect(mounted.container.querySelector<HTMLInputElement>('#setup-apiKey-expanded')?.type).toBe('password');
    expect(mounted.container.querySelector<HTMLInputElement>('#setup-workspace-expanded')?.type).toBe('text');
    expect(mounted.container.querySelector<HTMLInputElement>('#setup-endpoint-expanded')?.type).toBe('url');
    expect(mounted.container.querySelector<HTMLInputElement>('#setup-endpoint-expanded')?.placeholder).toBe('https://api.example.test');
    expect(mounted.container.querySelector<HTMLSelectElement>('#setup-environment-expanded')?.value).toBe('production');
    expect(mounted.container.querySelector<HTMLInputElement>('#setup-readOnly-expanded')?.type).toBe('checkbox');
    expect(mounted.container.querySelector<HTMLInputElement>('#setup-email-expanded')?.type).toBe('email');
    expect(mounted.container.textContent).toContain('Follow these steps:');
    expect(mounted.container.textContent).toContain('Callback URL');
  });

  it('renders fields per type for update mode (secret fields cleared, non-secret fields preserved)', () => {
    mounted = renderForm({
      mode: 'update',
      fieldValues: {
        apiKey: '',
        workspace: 'Acme',
        endpoint: 'https://api.example.test',
        environment: 'sandbox',
        readOnly: 'true',
        email: 'user@example.com',
      },
    });

    expect(mounted.container.querySelector<HTMLInputElement>('#setup-apiKey-expanded')?.value).toBe('');
    expect(mounted.container.querySelector<HTMLInputElement>('#setup-workspace-expanded')?.value).toBe('Acme');
    expect(mounted.container.querySelector<HTMLInputElement>('#setup-endpoint-expanded')?.value).toBe('https://api.example.test');
    expect(mounted.container.querySelector<HTMLSelectElement>('#setup-environment-expanded')?.value).toBe('sandbox');
    expect(mounted.container.querySelector<HTMLInputElement>('#setup-readOnly-expanded')?.checked).toBe(true);
  });

  it('submit-button label is "Set up with Rebel" / "Connect" in create mode', () => {
    mounted = renderForm({ mode: 'create', submitWithRebel: true });
    expect(getSaveButton(mounted.container).textContent).toContain('Set up with Rebel');

    mounted.unmount();
    mounted = renderForm({ mode: 'create', submitWithRebel: false });
    expect(getSaveButton(mounted.container).textContent).toContain('Connect');
  });

  it('submit-button label is "Save" in update mode', () => {
    mounted = renderForm({ mode: 'update' });

    expect(getSaveButton(mounted.container).textContent).toContain('Save');
  });

  it('disables submit when required fields are blank in create mode', () => {
    mounted = renderForm({
      mode: 'create',
      fieldValues: {
        apiKey: '',
        workspace: 'Acme',
        endpoint: 'https://api.example.test',
        environment: 'production',
        email: 'user@example.com',
      },
    });

    expect(getSaveButton(mounted.container).disabled).toBe(true);
  });

  it('allows blank password fields in update mode (merge intent)', () => {
    mounted = renderForm({
      mode: 'update',
      fieldValues: {
        apiKey: '',
        workspace: 'Acme',
        endpoint: 'https://api.example.test',
        environment: 'production',
        email: 'user@example.com',
      },
    });

    expect(getSaveButton(mounted.container).disabled).toBe(false);
  });

  it('email field is read-only in update mode', () => {
    mounted = renderForm({ mode: 'update' });

    expect(mounted.container.querySelector<HTMLInputElement>('#setup-email-expanded')?.readOnly).toBe(true);
  });
});
