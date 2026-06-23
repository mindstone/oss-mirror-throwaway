// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ManagedBillingErrorActions } from '../ManagedBillingErrorActions';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
};

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

describe('ManagedBillingErrorActions', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('renders Add your own key plus Wait-until CTA when managed reset date is valid', () => {
    const onAddOwnKey = vi.fn();
    const onDismiss = vi.fn();
    const mounted = mount(
      <ManagedBillingErrorActions
        managedSubscription={{ tier: 'dash', resetsAt: '2026-06-01T00:00:00.000Z' }}
        onAddOwnKey={onAddOwnKey}
        onDismiss={onDismiss}
      />,
    );

    const addOwnKeyButton = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="error-banner-add-own-key"]',
    );
    const waitOrDismissButton = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="error-banner-wait-or-dismiss"]',
    );

    expect(addOwnKeyButton?.textContent?.trim()).toBe('Add your own key');
    expect(waitOrDismissButton?.textContent?.trim()).toBe('Wait until June 1, 2026');

    act(() => {
      addOwnKeyButton?.click();
      waitOrDismissButton?.click();
    });
    expect(onAddOwnKey).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    mounted.unmount();
  });

  it('falls back to Dismiss when managed reset date is invalid', () => {
    const mounted = mount(
      <ManagedBillingErrorActions
        managedSubscription={{ tier: 'rogue', resetsAt: 'not-a-date' }}
        onAddOwnKey={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const waitOrDismissButton = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="error-banner-wait-or-dismiss"]',
    );
    expect(waitOrDismissButton?.textContent?.trim()).toBe('Dismiss');

    mounted.unmount();
  });
});
