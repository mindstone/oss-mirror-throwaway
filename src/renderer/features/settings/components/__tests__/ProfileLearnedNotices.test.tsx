// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProfileLearnedEvent } from '../../hooks/useProfileLearnedEvents';
import { ProfileLearnedNotices, buildProfileLearnedNoticeCopy } from '../ProfileLearnedNotices';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function mount(ui: React.ReactElement, theme?: 'light' | 'dark'): Mounted {
  const container = document.createElement('div');
  if (theme) container.className = theme;
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const outputCapEvent: ProfileLearnedEvent = {
  id: 'profile-1:output-cap:1700000010000',
  kind: 'output-cap',
  profileId: 'profile-1',
  profileName: 'OpenAI / GPT-5.5',
  model: 'gpt-5.5',
  observedCap: 8_192,
  observedAt: 1_700_000_010_000,
};

// A second, distinct output-cap event (different profile) to exercise the
// collapsed multi-event path. The context-window event kind was retired
// (PLAN.md Stage 3) and can no longer be constructed type-wise.
const secondOutputCapEvent: ProfileLearnedEvent = {
  id: 'profile-2:output-cap:1700000020000',
  kind: 'output-cap',
  profileId: 'profile-2',
  profileName: 'Anthropic / Opus',
  model: 'claude-opus-4-7',
  observedCap: 32_000,
  observedAt: 1_700_000_020_000,
};

describe('ProfileLearnedNotices', () => {
  const mounted: Mounted[] = [];

  afterEach(() => {
    for (const instance of mounted) instance.unmount();
    mounted.length = 0;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders brand-voice copy for a single output-cap event', () => {
    const m = mount(
      <ProfileLearnedNotices events={[outputCapEvent]} onDismiss={vi.fn()} />,
    );
    mounted.push(m);

    expect(m.container.textContent).toContain('Rebel got smarter');
    expect(m.container.textContent).toContain(
      'gpt-5.5 said its output limit is 8K tokens. Rebel updated OpenAI / GPT-5.5; future requests will stay under it automatically.',
    );
  });

  it('never produces the retired "said its context limit is" copy for an output-cap event', () => {
    const copy = buildProfileLearnedNoticeCopy(outputCapEvent);
    expect(copy).not.toContain('said its context limit is');
    expect(copy).toContain('said its output limit is');

    const m = mount(
      <ProfileLearnedNotices events={[outputCapEvent]} onDismiss={vi.fn()} />,
    );
    mounted.push(m);
    expect(m.container.textContent).not.toContain('said its context limit is');
  });

  it('collapses multiple output-cap events into a single summary notice with show-details affordance', () => {
    const m = mount(
      <ProfileLearnedNotices
        events={[outputCapEvent, secondOutputCapEvent]}
        onDismiss={vi.fn()}
      />,
    );
    mounted.push(m);

    expect(m.container.textContent).toContain('Rebel learned 2 model limits');
    expect(m.container.querySelector('[data-testid="settings-models-learned-notice-collapsed"]')).not.toBeNull();
    expect(m.container.querySelector('[data-testid="settings-models-learned-notice-details"]')).toBeNull();

    const toggle = m.container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-models-learned-notice-toggle-details"]',
    );
    expect(toggle).not.toBeNull();
    act(() => {
      toggle?.click();
    });

    const details = m.container.querySelector('[data-testid="settings-models-learned-notice-details"]');
    expect(details).not.toBeNull();
    expect(details?.textContent).toContain('output limit is 8K tokens');
    expect(details?.textContent).toContain('output limit is 32K tokens');
    expect(details?.textContent).not.toContain('said its context limit is');
  });

  it('dismisses a single notice via the dismiss button', () => {
    const onDismiss = vi.fn();
    const m = mount(
      <ProfileLearnedNotices events={[outputCapEvent]} onDismiss={onDismiss} />,
    );
    mounted.push(m);

    const dismissButton = m.container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss notice"]');
    expect(dismissButton).not.toBeNull();
    act(() => {
      dismissButton?.click();
    });

    expect(onDismiss).toHaveBeenCalledWith(outputCapEvent.id);
  });

  it('dismisses every event in the collapsed summary when its dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    const m = mount(
      <ProfileLearnedNotices
        events={[outputCapEvent, secondOutputCapEvent]}
        onDismiss={onDismiss}
      />,
    );
    mounted.push(m);

    const dismissButton = m.container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss notice"]');
    expect(dismissButton).not.toBeNull();
    act(() => {
      dismissButton?.click();
    });

    expect(onDismiss).toHaveBeenCalledWith(outputCapEvent.id);
    expect(onDismiss).toHaveBeenCalledWith(secondOutputCapEvent.id);
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it('renders through light and dark theme containers', () => {
    const onDismiss = vi.fn();
    const light = mount(
      <ProfileLearnedNotices events={[outputCapEvent]} onDismiss={onDismiss} />,
      'light',
    );
    const dark = mount(
      <ProfileLearnedNotices events={[outputCapEvent]} onDismiss={onDismiss} />,
      'dark',
    );
    mounted.push(light, dark);

    expect(light.container.classList.contains('light')).toBe(true);
    expect(dark.container.classList.contains('dark')).toBe(true);
    expect(light.container.textContent).toContain('Rebel got smarter');
    expect(dark.container.textContent).toContain('Rebel got smarter');
  });
});
