// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { renderHook } from '@renderer/test-utils';

import { ProviderStep } from '../steps/ProviderStep';
import { useProfileWizard } from '../useProfileWizard';

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

function click(element: Element | null): void {
  if (!element) throw new Error('Missing clickable element');
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

describe('ProviderStep', () => {
  const mounted: Mounted[] = [];

  afterEach(() => {
    for (const view of mounted) view.unmount();
    mounted.length = 0;
    document.body.innerHTML = '';
  });

  it('renders local preset group with DS4 first and clicking DS4 seeds the local preset configure flow', () => {
    const hook = renderHook(() => useProfileWizard({}));
    act(() => hook.result.current[1].open({ mode: 'add' }));
    act(() => hook.result.current[1].selectCustomPath());

    const view = mount(
      <ProviderStep
        customProviders={[
          {
            id: 'cp-1',
            name: 'Acme Gateway',
            serverUrl: 'https://acme.example.com/v1',
            createdAt: 1_700_000_000_000,
          },
        ]}
        openRouterConnected
        onSelect={hook.result.current[1].selectProvider}
      />,
    );
    mounted.push(view);

    const text = view.container.textContent ?? '';
    const builtInIndex = text.indexOf('Built-in providers');
    const localIndex = text.indexOf('Models on your machine');
    const customIndex = text.indexOf('Your custom providers');
    expect(builtInIndex).toBeGreaterThan(-1);
    expect(localIndex).toBeGreaterThan(-1);
    expect(customIndex).toBeGreaterThan(-1);
    expect(builtInIndex).toBeLessThan(localIndex);
    expect(localIndex).toBeLessThan(customIndex);

    const localCards = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>('[data-testid^="settings-models-wizard-local-preset-"]'),
    );
    expect(localCards.map((card) => card.dataset.testid)).toEqual([
      'settings-models-wizard-local-preset-ds4',
      'settings-models-wizard-local-preset-lm-studio',
      'settings-models-wizard-local-preset-ollama-custom',
      'settings-models-wizard-local-preset-llama-cpp',
    ]);

    click(view.container.querySelector('[data-testid="settings-models-wizard-local-preset-ds4"]'));

    const [wizardView, actions] = hook.result.current;
    expect(wizardView.state?.step).toBe('configure');
    if (wizardView.state?.step !== 'configure') throw new Error('Expected configure step');

    expect(wizardView.state.providerType).toBe('other');
    expect(wizardView.state.presetKey).toBe('local:ds4');
    expect(wizardView.state.form.serverUrl).toBe('http://127.0.0.1:8000/v1');
    expect(wizardView.state.form.customModelName).toBe('deepseek-v4-flash');
    expect(wizardView.state.form.reasoningEffort).toBe('medium');

    const built = actions.buildProfile();
    expect(built).toEqual(
      expect.objectContaining({
        providerType: 'other',
        routeSurface: 'local',
        presetKey: 'local:ds4',
        serverUrl: 'http://127.0.0.1:8000/v1',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'medium',
      }),
    );

    hook.unmount();
  });
});
