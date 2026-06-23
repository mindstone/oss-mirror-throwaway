// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '@renderer/components/ui';
import { ExpandedConnectionCard } from '../ExpandedConnectionCard';
import { createTestConnectionCardOps } from './connectionCardOpsTestUtils';
import type { UnifiedConnection } from '../../hooks/useUnifiedConnections';

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

function makeConnection(catalogId: string): UnifiedConnection {
  return {
    id: 'connector-id',
    name: 'Rebel Browser',
    description: 'Install the browser companion with Rebel in conversation.',
    icon: 'globe',
    status: 'available',
    provider: 'bundled',
    catalogEntry: {
      id: catalogId,
      provider: 'bundled',
    } as UnifiedConnection['catalogEntry'],
  };
}

describe('ExpandedConnectionCard', () => {
  let mounted: Mounted[] = [];

  afterEach(() => {
    for (const instance of mounted) {
      instance.unmount();
    }
    mounted = [];
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('keeps Rebel Browser on the standard Set up with Rebel path without the legacy settings panel', () => {
    const onConnect = vi.fn();

    const bridgeCard = mount(
      <ExpandedConnectionCard
        connection={makeConnection('bundled-app-bridge')}
        onClose={() => undefined}
        onConnect={onConnect}
        onConfigureWithRebel={() => undefined}
        ops={createTestConnectionCardOps()}
      />,
    );
    const genericCard = mount(
      <ExpandedConnectionCard
        connection={makeConnection('bundled-generic')}
        onClose={() => undefined}
        onConnect={() => undefined}
        onConfigureWithRebel={() => undefined}
        ops={createTestConnectionCardOps()}
      />,
    );
    mounted = [bridgeCard, genericCard];

    const button = bridgeCard.container.querySelector(
      '[data-testid="connector-connect-button-connector-id"]',
    );

    expect(button?.textContent).toContain('Set up with Rebel');
    expect(bridgeCard.container.textContent).not.toContain('Install Rebel Browser');
    expect(bridgeCard.container.textContent).not.toContain('Early access');
    expect(bridgeCard.container.textContent).not.toContain('Install in progress');
    expect(bridgeCard.container.innerHTML).toBe(genericCard.container.innerHTML);

    act(() => {
      button?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });

    expect(onConnect).toHaveBeenCalledWith(undefined, { launchRebel: true });
  });
});
