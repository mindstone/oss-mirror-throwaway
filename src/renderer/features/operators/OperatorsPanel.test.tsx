// @vitest-environment happy-dom

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperatorMetadata } from '@shared/ipc/channels/operators';
import { TeamPanel, _resetOperatorsPanelTelemetryForTests } from './OperatorsPanel';

const { registryState } = vi.hoisted(() => ({
  registryState: {
    operators: [] as OperatorMetadata[],
    failures: [] as Array<{ spacePath: string; operatorSlug: string; operatorFileAbsolutePath: string; errorCode: string; message: string }>,
    loading: false,
    error: null as string | null,
    refresh: vi.fn(),
    lastOptions: null as { coreDirectory?: string | null; activeSpacePath?: string | null; mode?: string } | null,
  },
}));

const { toastMocks } = vi.hoisted(() => ({
  toastMocks: { showToast: vi.fn() },
}));

const { navigationMocks } = vi.hoisted(() => ({
  navigationMocks: { navigate: vi.fn() },
}));

vi.mock('@renderer/components/ui', async () => {
  const actual = await vi.importActual<typeof import('@renderer/components/ui')>('@renderer/components/ui');
  return {
    ...actual,
    useToast: () => ({
      toasts: [],
      showToast: toastMocks.showToast,
      dismissToast: vi.fn(),
    }),
  };
});

vi.mock('@renderer/features/settings', () => ({
  useSettingsSafe: () => ({ settings: { coreDirectory: '/workspace' } }),
}));

vi.mock('@renderer/contexts/NavigationContext', () => ({
  useNavigationSafe: () => ({
    navigate: navigationMocks.navigate,
    currentSurface: 'team',
    teamSelectedOperatorId: null,
  }),
}));

const { invalidateOperatorRegistryCacheMock } = vi.hoisted(() => ({
  invalidateOperatorRegistryCacheMock: vi.fn(),
}));

vi.mock('./hooks/useOperatorRegistry', () => ({
  useOperatorRegistry: (options: { coreDirectory?: string | null; activeSpacePath?: string | null; mode?: string }) => {
    registryState.lastOptions = options;
    return {
      operators: registryState.operators,
      failures: registryState.failures,
      loading: registryState.loading,
      error: registryState.error,
      refresh: registryState.refresh,
      spacePaths: ['/workspace/Chief-of-Staff'],
      sourceSpaces: [
        { sourceSpacePath: '/workspace/rebel-system', label: 'Bundled', category: 'bundled' },
        { sourceSpacePath: '/workspace/Chief-of-Staff', label: 'Chief-of-Staff', category: 'space', isChiefOfStaff: true },
        { sourceSpacePath: '/workspace/work/acme/Launch', label: 'Launch', category: 'space' },
      ],
    };
  },
  invalidateOperatorRegistryCache: invalidateOperatorRegistryCacheMock,
}));

const operator: OperatorMetadata = {
  id: '/workspace/Chief-of-Staff::brand-critic',
  operatorSlug: 'brand-critic',
  spacePath: '/workspace/Chief-of-Staff',
  sourceSpacePath: '/workspace/Chief-of-Staff',
  category: 'space',
  name: 'Brand Critic',
  description: 'Keeps the message honest.',
  consult_when: 'When claims need taste.',
  kind: 'operator',
  roles: ['operator'],
  operatorFileAbsolutePath: '/workspace/Chief-of-Staff/operators/brand-critic/OPERATOR.md',
  groundingPath: '/workspace/Chief-of-Staff/operators/brand-critic/grounding.md',
  diaryPath: '/workspace/Chief-of-Staff/operators/brand-critic/diary.md',
};

const liveCoachOperator: OperatorMetadata = {
  ...operator,
  id: '/workspace/Chief-of-Staff::live-coach',
  operatorSlug: 'live-coach',
  name: 'Live Coach',
  roles: ['live_meeting'],
};

const dualRoleOperator: OperatorMetadata = {
  ...operator,
  id: '/workspace/Chief-of-Staff::dual-role',
  operatorSlug: 'dual-role',
  name: 'Dual Role',
  roles: ['operator', 'live_meeting'],
};

describe('OperatorsPanel (redesign)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    registryState.operators = [];
    registryState.failures = [];
    registryState.loading = false;
    registryState.error = null;
    registryState.lastOptions = null;
    registryState.refresh.mockResolvedValue(undefined);
    invalidateOperatorRegistryCacheMock.mockReset();
    toastMocks.showToast.mockReset();
    navigationMocks.navigate.mockReset();
    navigationMocks.navigate.mockResolvedValue(true);
    _resetOperatorsPanelTelemetryForTests();
    (window as unknown as { operatorsApi: unknown }).operatorsApi = {
      activate: vi.fn().mockResolvedValue({ success: true, activatedPath: '/workspace/Chief-of-Staff/operators/brand-critic' }),
      remove: vi.fn().mockResolvedValue({ success: true }),
      setDisplayName: vi.fn().mockResolvedValue({ success: true }),
      duplicate: vi.fn().mockResolvedValue({ success: true, newSlug: 'brand-critic-copy' }),
      setLiveMeetingEnabled: vi.fn().mockResolvedValue({ success: true }),
      getDiary: vi.fn().mockResolvedValue({ operatorId: operator.id, diary: '' }),
    };
    (window as unknown as { libraryApi: unknown }).libraryApi = {
      statFile: vi.fn().mockResolvedValue({ exists: true, mtimeMs: Date.now() }),
    };
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    vi.clearAllMocks();
  });

  it('renders zero-Operators hero when no operators are loaded', async () => {
    await act(async () => {
      root.render(<TeamPanel />);
    });
    expect(container.textContent).toContain('No Operators are available in this Space.');
    expect(container.textContent).toContain('Add starter Operators');
  });

  it('renders an operator card grid for the operators tab and switches to live coaches tab', async () => {
    registryState.operators = [operator, liveCoachOperator];
    await act(async () => {
      root.render(<TeamPanel />);
    });
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector(`[data-operator-id="${operator.id}"]`)).not.toBeNull();
    expect(container.querySelector(`[data-operator-id="${liveCoachOperator.id}"]`)).toBeNull();

    const liveCoachesTrigger = container.querySelector('[data-testid="live-coaches-tab-trigger"]');
    await act(async () => {
      liveCoachesTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector(`[data-operator-id="${liveCoachOperator.id}"]`)).not.toBeNull();
    expect(container.querySelector(`[data-operator-id="${operator.id}"]`)).toBeNull();
  });

  it('shows accurate tab counts and role-filtered cards across live-only and dual-role Operators', async () => {
    registryState.operators = [operator, liveCoachOperator, dualRoleOperator];
    await act(async () => {
      root.render(<TeamPanel />);
    });
    await act(async () => { await Promise.resolve(); });

    const operatorsTrigger = container.querySelector('[data-testid="operators-tab-trigger"]');
    const liveCoachesTrigger = container.querySelector('[data-testid="live-coaches-tab-trigger"]');
    expect(operatorsTrigger?.textContent).toContain('2');
    expect(liveCoachesTrigger?.textContent).toContain('2');
    expect(container.querySelector(`[data-operator-id="${operator.id}"]`)).not.toBeNull();
    expect(container.querySelector(`[data-operator-id="${dualRoleOperator.id}"]`)).not.toBeNull();
    expect(container.querySelector(`[data-operator-id="${liveCoachOperator.id}"]`)).toBeNull();

    await act(async () => {
      liveCoachesTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector(`[data-operator-id="${liveCoachOperator.id}"]`)).not.toBeNull();
    expect(container.querySelector(`[data-operator-id="${dualRoleOperator.id}"]`)).not.toBeNull();
    expect(container.querySelector(`[data-operator-id="${operator.id}"]`)).toBeNull();
  });

  it('does not render legacy Notes, Preview, or right-column editor UI', async () => {
    registryState.operators = [operator];
    await act(async () => {
      root.render(<TeamPanel selectedOperatorId={operator.id} />);
    });
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector('[data-testid="operators-panel"]')).not.toBeNull();
    expect(container.querySelector(`[data-operator-id="${operator.id}"]`)).not.toBeNull();
    expect(container.textContent).not.toContain('Notes');
    expect(container.textContent).not.toContain('Edit notes');
    expect(container.textContent).not.toContain('Preview');
    expect(container.textContent).not.toContain('Nothing written yet');
  });

  it('activates a bundled operator with copy-only semantics', async () => {
    const bundled: OperatorMetadata = {
      ...operator,
      id: '/workspace/rebel-system::brand-critic',
      sourceSpacePath: '/workspace/rebel-system',
      spacePath: '/workspace/rebel-system',
      category: 'bundled',
    };
    registryState.operators = [bundled];

    await act(async () => {
      root.render(<TeamPanel />);
    });
    await act(async () => { await Promise.resolve(); });

    const activateButton = container.querySelector('[data-testid="operator-activate-button"]');
    await act(async () => {
      activateButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });

    expect(window.operatorsApi.activate).toHaveBeenCalledWith({
      operatorSlug: 'brand-critic',
      sourceSpacePath: '/workspace/rebel-system',
      targetSpacePath: '/workspace/Chief-of-Staff',
    });
  });

  it('opens the duplicate dialog from the More menu and submits the duplicate via the API', async () => {
    const duplicatedOperator: OperatorMetadata = {
      ...operator,
      id: '/workspace/Chief-of-Staff::brand-critic-copy',
      operatorSlug: 'brand-critic-copy',
      displayName: 'Brand Critic (Copy)',
    };
    registryState.refresh.mockImplementationOnce(async () => {
      registryState.operators = [operator, duplicatedOperator];
    });
    registryState.operators = [operator];
    await act(async () => {
      root.render(<TeamPanel />);
    });
    await act(async () => { await Promise.resolve(); });

    const moreButton = container.querySelector('[data-testid="operator-card-more-button"]');
    await act(async () => {
      moreButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const duplicateMenuItem = document.body.querySelector('[data-testid="operator-card-more-duplicate"]');
    await act(async () => {
      duplicateMenuItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const dialog = document.body.querySelector('[data-testid="operator-duplicate-dialog"]');
    expect(dialog).not.toBeNull();
    const input = document.body.querySelector('[data-testid="operator-duplicate-input"]') as HTMLInputElement | null;
    expect(input?.value).toBe('Brand Critic (Copy)');
    const confirm = document.body.querySelector('[data-testid="operator-duplicate-confirm"]');

    await act(async () => {
      confirm?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });

    expect(window.operatorsApi.duplicate).toHaveBeenCalledWith({
      sourceSlug: 'brand-critic',
      sourceSpacePath: '/workspace/Chief-of-Staff',
      newDisplayName: 'Brand Critic (Copy)',
    });
    expect(registryState.refresh).toHaveBeenCalledTimes(1);
    expect(container.querySelector(`[data-operator-id="${duplicatedOperator.id}"]`)).not.toBeNull();
    expect(toastMocks.showToast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Duplicated as Brand Critic (Copy)',
    }));
  });

  it('keeps the duplicate dialog open and avoids registry refresh when duplicate fails', async () => {
    registryState.operators = [operator];
    (window.operatorsApi.duplicate as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ success: false, errorCode: 'copy_failed' });
    await act(async () => {
      root.render(<TeamPanel />);
    });
    await act(async () => { await Promise.resolve(); });

    const moreButton = container.querySelector('[data-testid="operator-card-more-button"]');
    await act(async () => {
      moreButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const duplicateMenuItem = document.body.querySelector('[data-testid="operator-card-more-duplicate"]');
    await act(async () => {
      duplicateMenuItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const confirm = document.body.querySelector('[data-testid="operator-duplicate-confirm"]');
    await act(async () => {
      confirm?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });

    expect(document.body.querySelector('[data-testid="operator-duplicate-dialog"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="operator-duplicate-error"]')?.textContent)
      .toContain('copy');
    expect(registryState.refresh).not.toHaveBeenCalled();
    expect(container.querySelector('[data-operator-id="/workspace/Chief-of-Staff::brand-critic-copy"]')).toBeNull();
  });

  it('opens the history dialog from the More menu', async () => {
    registryState.operators = [operator];
    await act(async () => {
      root.render(<TeamPanel />);
    });
    await act(async () => { await Promise.resolve(); });

    const moreButton = container.querySelector('[data-testid="operator-card-more-button"]');
    await act(async () => {
      moreButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const historyItem = document.body.querySelector('[data-testid="operator-card-more-history"]');
    await act(async () => {
      historyItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.body.querySelector('[data-testid="operator-history-dialog"]')).not.toBeNull();
  });

  it('navigates to the operator file in the Library when instructions exist', async () => {
    registryState.operators = [operator];
    await act(async () => {
      root.render(<TeamPanel />);
    });
    await act(async () => { await Promise.resolve(); });

    const instructionsButton = container.querySelector('[data-testid="operator-instructions-button"]');
    await act(async () => {
      instructionsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });

    expect(navigationMocks.navigate).toHaveBeenCalledWith({
      type: 'library',
      filePath: operator.operatorFileAbsolutePath,
    });
    expect(toastMocks.showToast).not.toHaveBeenCalled();
  });

  it('shows a fallback toast when statFile reports the operator file is missing', async () => {
    registryState.operators = [operator];
    (window.libraryApi.statFile as ReturnType<typeof vi.fn>).mockResolvedValue({ exists: false, mtimeMs: null });
    await act(async () => {
      root.render(<TeamPanel />);
    });
    await act(async () => { await Promise.resolve(); });

    const instructionsButton = container.querySelector('[data-testid="operator-instructions-button"]');
    await act(async () => {
      instructionsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });

    expect(navigationMocks.navigate).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="operators-panel"]')).not.toBeNull();
    expect(container.querySelector(`[data-operator-id="${operator.id}"]`)).not.toBeNull();
    expect(toastMocks.showToast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Couldn’t open instructions',
    }));
  });

  it('opens the remove confirmation dialog and submits without a confirmation flag', async () => {
    registryState.operators = [operator];
    (window.operatorsApi.remove as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });

    await act(async () => {
      root.render(<TeamPanel />);
    });
    await act(async () => { await Promise.resolve(); });

    const moreButton = container.querySelector('[data-testid="operator-card-more-button"]');
    await act(async () => {
      moreButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const removeMenuItem = document.body.querySelector('[data-testid="operator-card-more-remove"]');
    await act(async () => {
      removeMenuItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });

    expect(window.operatorsApi.remove).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Remove Brand Critic?');
    expect(document.body.textContent).toContain('conversation history');
    expect(document.body.textContent).not.toContain('grounding character');

    const confirmButton = document.body.querySelector('[data-testid="operator-remove-confirm-button"]');
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });

    expect(window.operatorsApi.remove).toHaveBeenCalledWith({
      operatorSlug: 'brand-critic',
      targetSpacePath: '/workspace/Chief-of-Staff',
    });
    expect(toastMocks.showToast).toHaveBeenCalledWith({
      title: 'Removed Brand Critic',
      variant: 'success',
    });
  });

  it('toggles live meeting role on success and refreshes the registry', async () => {
    registryState.operators = [operator];
    await act(async () => {
      root.render(<TeamPanel />);
    });
    await act(async () => { await Promise.resolve(); });

    const liveToggle = container.querySelector('[data-testid="operator-live-toggle"] input[type="checkbox"]') as HTMLInputElement | null;
    expect(liveToggle).not.toBeNull();
    expect(liveToggle?.checked).toBe(false);
    expect(liveToggle?.disabled).toBe(false);

    await act(async () => {
      liveToggle?.click();
    });
    await act(async () => { await Promise.resolve(); });

    expect(window.operatorsApi.setLiveMeetingEnabled).toHaveBeenCalledWith({
      operatorSlug: 'brand-critic',
      targetSpacePath: '/workspace/Chief-of-Staff',
      enabled: true,
    });
    expect(registryState.refresh).toHaveBeenCalledTimes(1);
    expect(invalidateOperatorRegistryCacheMock).toHaveBeenCalledTimes(1);
  });

  it('does not bust the cross-surface registry cache when the live toggle is rejected', async () => {
    registryState.operators = [operator];
    (window.operatorsApi.setLiveMeetingEnabled as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ success: false, errorCode: 'live_prompt_missing' });

    await act(async () => {
      root.render(<TeamPanel />);
    });
    await act(async () => { await Promise.resolve(); });

    const liveToggle = container.querySelector('[data-testid="operator-live-toggle"] input[type="checkbox"]') as HTMLInputElement | null;
    await act(async () => {
      liveToggle?.click();
    });
    await act(async () => { await Promise.resolve(); });

    expect(invalidateOperatorRegistryCacheMock).not.toHaveBeenCalled();
  });

  it('surfaces a live_prompt_missing toast with an Open Instructions action', async () => {
    registryState.operators = [operator];
    (window.operatorsApi.setLiveMeetingEnabled as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ success: false, errorCode: 'live_prompt_missing' });

    await act(async () => {
      root.render(<TeamPanel />);
    });
    await act(async () => { await Promise.resolve(); });

    const liveToggle = container.querySelector('[data-testid="operator-live-toggle"] input[type="checkbox"]') as HTMLInputElement | null;
    await act(async () => {
      liveToggle?.click();
    });
    await act(async () => { await Promise.resolve(); });

    expect(registryState.refresh).not.toHaveBeenCalled();
    expect(toastMocks.showToast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Add live meeting instructions first',
      action: expect.objectContaining({ label: 'Open Instructions' }),
    }));
  });

  it('surfaces a roles_would_be_empty toast without an action and keeps the toggle reverted', async () => {
    const liveOnly: OperatorMetadata = {
      ...operator,
      id: '/workspace/Chief-of-Staff::live-only',
      operatorSlug: 'live-only',
      name: 'Live Only',
      consult_when: '',
      roles: ['live_meeting'],
    };
    registryState.operators = [liveOnly];
    (window.operatorsApi.setLiveMeetingEnabled as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ success: false, errorCode: 'roles_would_be_empty' });

    await act(async () => {
      root.render(<TeamPanel />);
    });
    await act(async () => { await Promise.resolve(); });

    const liveCoachesTrigger = container.querySelector('[data-testid="live-coaches-tab-trigger"]');
    await act(async () => {
      liveCoachesTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });

    const liveToggle = container.querySelector('[data-testid="operator-live-toggle"] input[type="checkbox"]') as HTMLInputElement | null;
    expect(liveToggle?.checked).toBe(true);
    await act(async () => {
      liveToggle?.click();
    });
    await act(async () => { await Promise.resolve(); });

    expect(registryState.refresh).not.toHaveBeenCalled();
    expect(toastMocks.showToast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Can’t turn off the only role',
    }));
    const lastToastCall = toastMocks.showToast.mock.calls[toastMocks.showToast.mock.calls.length - 1]?.[0];
    expect(lastToastCall?.action).toBeUndefined();

    const finalToggle = container.querySelector('[data-testid="operator-live-toggle"] input[type="checkbox"]') as HTMLInputElement | null;
    expect(finalToggle?.checked).toBe(true);
  });

  it('renames an operator via the More menu', async () => {
    registryState.operators = [operator];
    await act(async () => {
      root.render(<TeamPanel />);
    });
    await act(async () => { await Promise.resolve(); });

    const moreButton = container.querySelector('[data-testid="operator-card-more-button"]');
    await act(async () => {
      moreButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const renameItem = document.body.querySelector('[data-testid="operator-card-more-rename"]');
    await act(async () => {
      renameItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const renameInput = document.body.querySelector('#operator-display-name-input') as HTMLInputElement | null;
    expect(renameInput).not.toBeNull();
    await act(async () => {
      if (!renameInput) return;
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(renameInput, 'Brand Critic — Enterprise');
      renameInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const saveButton = document.body.querySelector('[data-testid="operator-rename-save-button"]');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });

    expect(window.operatorsApi.setDisplayName).toHaveBeenCalledWith({
      operatorSlug: 'brand-critic',
      targetSpacePath: '/workspace/Chief-of-Staff',
      displayName: 'Brand Critic — Enterprise',
    });
  });
});
