// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigureStep } from '../steps/ConfigureStep';
import { useProfileWizard, type WizardActions, type WizardViewState } from '../useProfileWizard';
import type { ModelProfile } from '@shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  unmount: () => void;
}

function makeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'p-auto',
    name: 'gpt-future',
    providerType: 'other',
    serverUrl: '',
    model: 'gpt-future',
    apiKey: undefined,
    createdAt: 1_700_000_000_000,
    enabled: false,
    ...overrides,
  };
}

interface HostProps {
  profile: ModelProfile;
  apiRef: { current: { view: WizardViewState; actions: WizardActions } | null };
}

function Host({ profile, apiRef }: HostProps) {
  const [view, actions] = useProfileWizard({});
  apiRef.current = { view, actions };
  const openedRef = React.useRef(false);
  if (!openedRef.current) {
    openedRef.current = true;
    actions.open({ mode: 'edit', profile });
  }
  if (view.state?.step !== 'configure') return null;
  return (
    <ConfigureStep
      state={view.state}
      actions={actions}
      canSave={view.canSave}
      testKey={view.state.testKey}
      testState={undefined}
      runTest={async () => ({ success: true, latencyMs: 10 })}
    />
  );
}

function mount(profile: ModelProfile): {
  mounted: Mounted;
  api: () => { view: WizardViewState; actions: WizardActions };
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const apiRef: { current: { view: WizardViewState; actions: WizardActions } | null } = {
    current: null,
  };
  act(() => {
    root.render(<Host profile={profile} apiRef={apiRef} />);
  });
  return {
    mounted: {
      container,
      unmount: () => {
        act(() => {
          root.unmount();
        });
        container.remove();
      },
    },
    api: () => {
      if (!apiRef.current) throw new Error('host has not yet mounted');
      return apiRef.current;
    },
  };
}

describe('ConfigureStep — Advanced disclosure', () => {
  let mounts: Mounted[] = [];
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const m of mounts) m.unmount();
    mounts = [];
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('shows the Advanced toggle and renders both inputs when expanded', () => {
    const { mounted } = mount(
      makeProfile({
        contextWindow: 200_000,
        contextWindowSource: 'auto',
        lastLearnedContextWindow: 200_000,
      }),
    );
    mounts.push(mounted);
    expect(
      mounted.container.querySelector('[data-testid="settings-models-wizard-advanced-toggle"]'),
    ).not.toBeNull();
    // Auto-only profile defaults expanded → inputs visible.
    expect(
      mounted.container.querySelector('[data-testid="settings-models-wizard-context-window-input"]'),
    ).not.toBeNull();
    expect(
      mounted.container.querySelector('[data-testid="settings-models-wizard-max-output-tokens-input"]'),
    ).not.toBeNull();
  });

  it('renders the Learned badge for auto-source profiles', () => {
    const { mounted } = mount(
      makeProfile({
        contextWindow: 200_000,
        contextWindowSource: 'auto',
        lastLearnedContextWindow: 200_000,
        contextWindowOverflowCount: 3,
        contextWindowLearnedAt: Date.now() - 1000 * 60 * 60,
      }),
    );
    mounts.push(mounted);
    expect(
      mounted.container.querySelector('[data-testid="settings-models-wizard-learned-badge"]'),
    ).not.toBeNull();
  });

  it('does NOT render the Learned badge when source is user', () => {
    const { mounted } = mount(
      makeProfile({
        contextWindow: 200_000,
        contextWindowSource: 'user',
        lastLearnedContextWindow: 128_000,
        contextWindowOverflowCount: 1,
      }),
    );
    mounts.push(mounted);
    expect(
      mounted.container.querySelector('[data-testid="settings-models-wizard-learned-badge"]'),
    ).toBeNull();
  });

  it('shows "Use learned value" link when user-source diverges from lastLearnedContextWindow', () => {
    const { mounted } = mount(
      makeProfile({
        contextWindow: 64_000,
        contextWindowSource: 'user',
        lastLearnedContextWindow: 200_000,
        contextWindowOverflowCount: 4,
      }),
    );
    mounts.push(mounted);
    expect(
      mounted.container.querySelector('[data-testid="settings-models-wizard-use-learned-button"]'),
    ).not.toBeNull();
    expect(
      mounted.container.querySelector('[data-testid="settings-models-wizard-learned-value-hint"]')
        ?.textContent,
    ).toMatch(/200(\.0)?k tokens/i);
  });

  it('clicking "Use learned value" copies lastLearnedContextWindow into the input', () => {
    const { mounted, api } = mount(
      makeProfile({
        contextWindow: 64_000,
        contextWindowSource: 'user',
        lastLearnedContextWindow: 200_000,
        contextWindowOverflowCount: 4,
      }),
    );
    mounts.push(mounted);
    const link = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-models-wizard-use-learned-button"]',
    );
    expect(link).not.toBeNull();
    act(() => {
      link?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    const view = api().view;
    if (view.state?.step !== 'configure') throw new Error('expected configure');
    expect(view.state.form.contextWindow).toBe(200_000);
    expect(view.state.form.useLearnedRequested).toBe(true);
  });
});
