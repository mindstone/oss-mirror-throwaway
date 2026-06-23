// @vitest-environment happy-dom

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperatorMetadata } from '@shared/ipc/channels/operators';
import { TeamPanel } from '../OperatorsPanel';

const { registryState } = vi.hoisted(() => ({
  registryState: {
    operators: [] as OperatorMetadata[],
    failures: [] as Array<{ spacePath: string; operatorSlug: string; operatorFileAbsolutePath: string; errorCode: string; message: string }>,
    loading: false,
    error: null as string | null,
    refresh: vi.fn(),
  },
}));

const { toastMocks } = vi.hoisted(() => ({
  toastMocks: { showToast: vi.fn() },
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
    navigate: vi.fn().mockResolvedValue(true),
    currentSurface: 'team',
    teamSelectedOperatorId: null,
  }),
}));

vi.mock('../hooks/useOperatorRegistry', () => ({
  useOperatorRegistry: () => ({
    operators: registryState.operators,
    failures: registryState.failures,
    loading: registryState.loading,
    error: registryState.error,
    refresh: registryState.refresh,
    spacePaths: ['/workspace/Chief-of-Staff'],
    sourceSpaces: [
      { sourceSpacePath: '/workspace/rebel-system', label: 'Bundled', category: 'bundled' },
      { sourceSpacePath: '/workspace/Chief-of-Staff', label: 'Chief-of-Staff', category: 'space', isChiefOfStaff: true },
    ],
  }),
}));

const bundledOperator: OperatorMetadata = {
  id: '/workspace/rebel-system::brand-critic',
  operatorSlug: 'brand-critic',
  spacePath: '/workspace/rebel-system',
  sourceSpacePath: '/workspace/rebel-system',
  category: 'bundled',
  name: 'Brand Critic',
  description: 'Keeps the message honest.',
  consult_when: 'When claims need taste.',
  kind: 'operator',
  roles: ['operator'],
  operatorFileAbsolutePath: '/workspace/rebel-system/operators/brand-critic/OPERATOR.md',
  groundingPath: '/workspace/rebel-system/operators/brand-critic/grounding.md',
  diaryPath: '/workspace/rebel-system/operators/brand-critic/diary.md',
};

const activatedOperator: OperatorMetadata = {
  ...bundledOperator,
  id: '/workspace/Chief-of-Staff::brand-critic',
  spacePath: '/workspace/Chief-of-Staff',
  sourceSpacePath: '/workspace/Chief-of-Staff',
  category: 'space',
  operatorFileAbsolutePath: '/workspace/Chief-of-Staff/operators/brand-critic/OPERATOR.md',
  groundingPath: '/workspace/Chief-of-Staff/operators/brand-critic/grounding.md',
  diaryPath: '/workspace/Chief-of-Staff/operators/brand-critic/diary.md',
};

describe('activation recovery integration flow (Phase A)', () => {
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
    registryState.refresh.mockResolvedValue(undefined);
    toastMocks.showToast.mockReset();

    (window as unknown as { operatorsApi: unknown }).operatorsApi = {
      activate: vi.fn().mockResolvedValue({
        success: false,
        errorCode: 'already_activated',
        existingOperatorPath: '/workspace/Chief-of-Staff/operators/brand-critic/OPERATOR.md',
      }),
      remove: vi.fn(),
      setDisplayName: vi.fn(),
      duplicate: vi.fn(),
      getDiary: vi.fn().mockResolvedValue({ operatorId: activatedOperator.id, diary: '' }),
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

  it('surfaces a "Show existing" toast action that highlights the existing activated card', async () => {
    registryState.operators = [bundledOperator, activatedOperator];

    await act(async () => {
      root.render(<TeamPanel />);
    });
    await act(async () => { await Promise.resolve(); });

    const bundledCard = container.querySelector(`[data-operator-id="${bundledOperator.id}"]`);
    const activateButton = bundledCard?.querySelector('[data-testid="operator-activate-button"]');
    await act(async () => {
      activateButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });

    expect(toastMocks.showToast).toHaveBeenCalled();
    const toastPayload = toastMocks.showToast.mock.calls.at(-1)?.[0] as {
      action?: { label: string; onClick: () => void };
    } | undefined;
    expect(toastPayload?.action?.label).toBe('Show existing');

    await act(async () => {
      toastPayload?.action?.onClick();
      await Promise.resolve();
    });

    const highlightedCard = container.querySelector(`[data-operator-id="${activatedOperator.id}"]`);
    expect(highlightedCard?.getAttribute('data-highlighted')).toBe('true');
  });
});
