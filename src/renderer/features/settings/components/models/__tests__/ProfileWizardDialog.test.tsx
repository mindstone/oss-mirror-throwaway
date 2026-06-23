// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PROVIDER_CATALOGS } from '@shared/data/providerCatalogs';
import { materializeCatalogProfile } from '@shared/utils/catalogMaterialization';
import { ProfileWizardDialog } from '../ProfileWizardDialog';
import type {
  WizardActions,
  WizardState,
  WizardViewState,
} from '../useProfileWizard';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  unmount: () => void;
}

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function makeChoosePathState(): WizardState {
  return {
    mode: 'add',
    step: 'choose-path',
    validationEpoch: 0,
    testKey: 'test-key',
  };
}

function makeActions(overrides: Partial<WizardActions> = {}): WizardActions {
  return {
    open: vi.fn(() => ({ opened: true })),
    close: vi.fn(),
    selectCustomPath: vi.fn(),
    selectProvider: vi.fn(),
    selectModel: vi.fn(),
    selectTypeManually: vi.fn(),
    backToChoosePath: vi.fn(),
    backToProvider: vi.fn(),
    backToModel: vi.fn(),
    updateForm: vi.fn(),
    updateKey: vi.fn(),
    updateValidation: vi.fn(),
    resetValidation: vi.fn(),
    setSaving: vi.fn(),
    setSaveError: vi.fn(),
    useLearnedContextWindow: vi.fn(),
    buildProfile: vi.fn(() => null),
    ...overrides,
  };
}

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof ProfileWizardDialog>> = {},
): { view: Mounted; actions: WizardActions } {
  const { actions: overrideActions, ...restOverrides } = overrides;
  const actions = makeActions(overrideActions);
  const state = makeChoosePathState();
  const viewState: WizardViewState = {
    state,
    canProceed: false,
    canSave: false,
    busy: false,
  };
  const props: React.ComponentProps<typeof ProfileWizardDialog> = {
    view: viewState,
    customProviders: [],
    providerKeys: {},
    openRouterConnected: true,
    connectorCatalogEntries: [PROVIDER_CATALOGS.openai[0]!],
    existingProfiles: [],
    getLatestProfilesSnapshot: () => [],
    providerConnections: { codex: { connected: true } },
    testState: {},
    runTest: vi.fn(async () => ({ success: true })),
    onSave: vi.fn(async () => {}),
    onCatalogEntryAlreadyOnTeam: vi.fn(),
    onDelete: vi.fn(async () => {}),
    ...restOverrides,
    actions,
  };
  return {
    view: mount(<ProfileWizardDialog {...props} />),
    actions,
  };
}

describe('ProfileWizardDialog catalog add behavior', () => {
  const mounted: Mounted[] = [];
  const entry = PROVIDER_CATALOGS.openai[0]!;

  afterEach(() => {
    for (const instance of mounted) instance.unmount();
    mounted.length = 0;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('renders the Add a model title and locked description on the choose-path step', () => {
    const { view } = renderDialog();
    mounted.push(view);

    expect(document.body.textContent).toContain('Add a model');
    expect(document.body.textContent).toContain(
      'Choose a model from a connected provider, or add one manually if it is not listed.',
    );
  });

  it('disables Cancel and Close while a catalog add is in flight', async () => {
    let resolveSave: (() => void) | null = null;
    const savePromise = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    const { view, actions } = renderDialog({
      onSave: vi.fn(async () => savePromise),
    });
    mounted.push(view);

    await act(async () => {
      document.body
        .querySelector(`[data-testid="settings-models-picker-add-openai:subscription:${entry.model}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    const cancelButton = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="settings-models-wizard-cancel-button"]',
    );
    const closeButton = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Close dialog"]',
    );
    expect(cancelButton?.disabled).toBe(true);
    expect(closeButton?.disabled).toBe(true);

    act(() => {
      cancelButton?.click();
      closeButton?.click();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      document.body
        .querySelector('[role="dialog"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(actions.close).not.toHaveBeenCalled();

    await act(async () => {
      resolveSave?.();
      await savePromise;
      await Promise.resolve();
    });

    expect(actions.close).toHaveBeenCalledTimes(1);
  });

  it('flashes the existing row when the JIT idempotency check finds a profile', async () => {
    const existing = materializeCatalogProfile(entry, { id: 'existing-connection' });
    const onCatalogEntryAlreadyOnTeam = vi.fn();
    const onSave = vi.fn(async () => {});
    const { view, actions } = renderDialog({
      getLatestProfilesSnapshot: () => [existing],
      onCatalogEntryAlreadyOnTeam,
      onSave,
    });
    mounted.push(view);

    await act(async () => {
      document.body
        .querySelector(`[data-testid="settings-models-picker-add-openai:subscription:${entry.model}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(onCatalogEntryAlreadyOnTeam).toHaveBeenCalledWith(existing.id);
    expect(onSave).not.toHaveBeenCalled();
    expect(actions.close).toHaveBeenCalledTimes(1);
  });
});
