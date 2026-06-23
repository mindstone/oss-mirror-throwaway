// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionErrorNotice } from '../SessionErrorNotice';
import type { AgentErrorResolution } from '@rebel/shared';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = {
  container: HTMLDivElement;
  unmount: () => void;
};

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

const baseResolution: AgentErrorResolution = {
  category: 'unsupported-feature',
  kind: 'unsupported_model',
  title: "ChatGPT Pro doesn't run GPT-5.5 Pro.",
  body: 'Pick a model that works on your subscription, or switch providers.',
  alternatives: [
    {
      label: 'Use GPT-5.5',
      action: 'switch-model',
      payload: { model: 'gpt-5.5' },
      variant: 'primary',
    },
    {
      label: 'Open settings',
      action: 'open-settings',
      payload: { settingsSection: 'providerKeys' },
      variant: 'secondary',
    },
  ],
  defaultAction: {
    label: 'Use GPT-5.5',
    action: 'switch-model',
    payload: { model: 'gpt-5.5' },
    variant: 'primary',
  },
  persistent: true,
};

describe('SessionErrorNotice', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('renders resolution copy, up to two actions, and dispatches selected action', () => {
    const onApply = vi.fn();
    mounted = mount(
      <SessionErrorNotice
        resolution={{
          ...baseResolution,
          alternatives: [
            ...baseResolution.alternatives,
            { label: 'Ignored third action', action: 'retry' },
          ],
        }}
        onApply={onApply}
        onDismiss={() => {}}
      />,
    );

    expect(mounted.container.textContent).toContain("ChatGPT Pro doesn't run GPT-5.5 Pro.");
    expect(mounted.container.textContent).toContain(
      'Pick a model that works on your subscription, or switch providers.',
    );
    expect(mounted.container.querySelectorAll('[data-testid^="session-error-action-"]')).toHaveLength(2);

    const primaryAction = mounted.container.querySelector(
      '[data-testid="session-error-action-switch-model"]',
    ) as HTMLButtonElement | null;
    expect(primaryAction).not.toBeNull();

    act(() => {
      primaryAction?.click();
    });

    expect(onApply).toHaveBeenCalledWith(baseResolution.alternatives[0]);
  });

  it('preserves the dismiss affordance', () => {
    const onDismiss = vi.fn();
    mounted = mount(
      <SessionErrorNotice
        resolution={baseResolution}
        onApply={() => {}}
        onDismiss={onDismiss}
      />,
    );

    const dismiss = mounted.container.querySelector(
      'button[aria-label="Dismiss notice"]',
    ) as HTMLButtonElement | null;
    expect(dismiss).not.toBeNull();

    act(() => {
      dismiss?.click();
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('disables every action and ignores clicks while an action is pending', () => {
    const onApply = vi.fn();
    mounted = mount(
      <SessionErrorNotice
        resolution={baseResolution}
        pendingAction="switch-model"
        onApply={onApply}
        onDismiss={() => {}}
      />,
    );

    const buttons = Array.from(
      mounted.container.querySelectorAll('[data-testid^="session-error-action-"]'),
    ) as HTMLButtonElement[];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.disabled)).toBe(true);

    act(() => {
      buttons.forEach((button) => button.click());
    });

    expect(onApply).not.toHaveBeenCalled();
  });

  it('can render non-dismissible system-broken notices', () => {
    mounted = mount(
      <SessionErrorNotice
        resolution={{ ...baseResolution, category: 'system-broken', kind: 'routing' }}
        dismissible={false}
        onApply={() => {}}
        onDismiss={() => {}}
      />,
    );

    expect(mounted.container.querySelector('button[aria-label="Dismiss notice"]')).toBeNull();
  });
});
