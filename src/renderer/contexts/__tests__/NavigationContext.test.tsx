// @vitest-environment happy-dom

import React, { useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavigationProvider, useNavigation, type NavigationProviderDeps } from '../NavigationContext';

vi.mock('@renderer/hooks/useIpcEvent', () => ({
  useIpcEvent: vi.fn(),
}));

describe('NavigationContext team deep-links', () => {
  let container: HTMLDivElement;
  let root: Root;
  let selectedOperatorId: string | null = null;

  const deps = (): NavigationProviderDeps => ({
    activeSurface: 'home',
    setActiveSurface: vi.fn(),
    openSession: vi.fn(),
    openInsightsDrawer: vi.fn(),
    openSettingsDialog: vi.fn(),
    closeSettingsDialog: vi.fn(),
    settingsOpen: false,
  });

  function Probe() {
    const navigation = useNavigation();
    useEffect(() => {
      selectedOperatorId = navigation.teamSelectedOperatorId;
    }, [navigation.teamSelectedOperatorId]);
    return (
      <button type="button" onClick={() => void navigation.navigate('rebel://team/%2Fworkspace%2FChief-of-Staff%3A%3Abrand-critic')}>
        open operator
      </button>
    );
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    selectedOperatorId = null;
    (window as unknown as { api: { onNavigateDeepLink: () => () => void } }).api = {
      onNavigateDeepLink: () => () => undefined,
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it('stores roleId from rebel://team/{operatorId} so the Operators panel can focus the card', async () => {
    const providerDeps = deps();
    await act(async () => {
      root.render(
        <NavigationProvider deps={providerDeps}>
          <Probe />
        </NavigationProvider>,
      );
    });

    await act(async () => {
      container.querySelector('button')?.click();
      await Promise.resolve();
    });

    expect(providerDeps.setActiveSurface).toHaveBeenCalledWith('team');
    expect(selectedOperatorId).toBe('/workspace/Chief-of-Staff::brand-critic');
  });
});
