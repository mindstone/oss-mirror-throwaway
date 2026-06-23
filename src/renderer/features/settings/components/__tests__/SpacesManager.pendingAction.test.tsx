// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpacesManager } from '../SpacesManager';
import { __resetSpacesCacheForTests } from '@renderer/hooks/useSpacesData';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const consumePendingSpacesAction = vi.hoisted(() => vi.fn());
const settingsState = vi.hoisted(() => ({
  value: {
    draftSettings: {
      coreDirectory: '/workspace',
      spaces: [],
    },
    refreshSettings: vi.fn(),
    pendingSpacesAction: null as { id: string; action: 'add' } | null,
    consumePendingSpacesAction,
  },
}));

vi.mock('@renderer/contexts/AppContext', () => ({
  useAppContext: () => ({ showToast: vi.fn() }),
}));

vi.mock('@renderer/features/settings/SettingsProvider', () => ({
  useSettingsSafe: () => settingsState.value,
}));

vi.mock('@renderer/contexts/NavigationContext', () => ({
  useNavigationSafe: () => ({ navigate: vi.fn() }),
}));

vi.mock('@renderer/hooks/useFeatureGate', () => ({
  useFeatureGate: () => ({ isFeatureEnabled: () => true }),
}));

vi.mock('@renderer/features/spaces', () => ({
  AddSpaceWizard: ({ open }: { open: boolean }) => (
    <div data-testid="mock-add-space-wizard-open">{String(open)}</div>
  ),
}));

vi.mock('@renderer/features/agent-session/components/CollapsibleSection', () => ({
  CollapsibleSection: ({ children }: { children: React.ReactNode }) => (
    <section>{children}</section>
  ),
}));

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
};

const scanSpaces = vi.fn();
const suggestSpaces = vi.fn();

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

describe('SpacesManager pending action intent', () => {
  let mounted: Mounted | null = null;

  beforeEach(() => {
    __resetSpacesCacheForTests();
    consumePendingSpacesAction.mockReset();
    settingsState.value.pendingSpacesAction = null;
    scanSpaces.mockResolvedValue({ success: true, spaces: [] });
    suggestSpaces.mockResolvedValue({ success: true, suggestions: [] });

    Object.defineProperty(window, 'libraryApi', {
      configurable: true,
      value: {
        scanSpaces,
        suggestSpaces,
        updateSpaceFrontmatter: vi.fn(),
        migrateLegacyAgentsMd: vi.fn(),
        removeSpace: vi.fn(),
        moveSpace: vi.fn(),
        renameSpace: vi.fn(),
      },
    });
    Object.defineProperty(window, 'appApi', {
      configurable: true,
      value: {
        revealPath: vi.fn(),
        openPath: vi.fn(),
      },
    });
    Object.defineProperty(window, 'settingsApi', {
      configurable: true,
      value: {
        chooseDirectory: vi.fn(),
      },
    });
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    __resetSpacesCacheForTests();
    vi.clearAllMocks();
  });

  it('opens Add Space wizard when pending action was queued before mount', async () => {
    // Simulates the Library action being queued while Settings was closed.
    settingsState.value.pendingSpacesAction = { id: 'pending-add-1', action: 'add' };

    mounted = mount(
      <SpacesManager
        companyName={null}
        pendingSpacesAction={settingsState.value.pendingSpacesAction}
        consumePendingSpacesAction={consumePendingSpacesAction}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mounted.container.querySelector('[data-testid="mock-add-space-wizard-open"]')?.textContent).toBe(
      'true',
    );
    expect(consumePendingSpacesAction).toHaveBeenCalledWith('pending-add-1');
  });

  it('coalesces rapid add-space intents while the wizard is already open', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    settingsState.value.pendingSpacesAction = { id: 'pending-add-1', action: 'add' };

    mounted = mount(
      <SpacesManager
        companyName={null}
        pendingSpacesAction={settingsState.value.pendingSpacesAction}
        consumePendingSpacesAction={consumePendingSpacesAction}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(consumePendingSpacesAction).toHaveBeenCalledWith('pending-add-1');

    settingsState.value.pendingSpacesAction = { id: 'pending-add-2', action: 'add' };
    act(() => {
      mounted?.root.render(
        <SpacesManager
          companyName={null}
          pendingSpacesAction={settingsState.value.pendingSpacesAction}
          consumePendingSpacesAction={consumePendingSpacesAction}
        />,
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(consumePendingSpacesAction).toHaveBeenCalledWith('pending-add-2');
    expect(warnSpy).toHaveBeenCalledWith(
      '[spaces] Add Space intent received while wizard is already open; coalescing',
      expect.objectContaining({ pendingActionId: 'pending-add-2' }),
    );

    warnSpy.mockRestore();
  });
});
