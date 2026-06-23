// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_LOCAL_MODEL_SETTINGS, type AppSettings, type ModelProfile } from '@shared/types';
import type { ModelChoice } from '@shared/types/modelChoice';
import {
  choiceToPickerValue,
  ModelChoicePicker,
  pickerValueToChoice,
} from '../ModelChoicePicker';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settings = {
  activeProvider: 'anthropic',
  localModel: { ...DEFAULT_LOCAL_MODEL_SETTINGS, profiles: [] },
  models: { apiKey: 'fake-key' },
} as unknown as AppSettings;

const profile: ModelProfile = {
  id: 'profile-1',
  name: 'Gateway',
  providerType: 'openai',
  serverUrl: 'https://example.test/v1',
  model: 'gpt-5.5',
  apiKey: 'fake-key',
  createdAt: 1,
  enabled: true,
};

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
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('ModelChoicePicker', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
  });

  it.each([
    [{ kind: 'model', modelId: 'claude-sonnet-4-6' }, 'claude-sonnet-4-6'],
    [{ kind: 'profile', profileId: 'profile-1' }, 'profile:profile-1'],
    [{ kind: 'auto' }, 'auto'],
    [{ kind: 'inherit' }, 'inherit'],
    [{ kind: 'off' }, ''],
  ] as Array<[ModelChoice, string]>)('round-trips %j through picker encoding', (choice, encoded) => {
    expect(choiceToPickerValue(choice)).toBe(encoded);
    expect(pickerValueToChoice(encoded)).toEqual(choice);
  });

  it('emits decoded ModelChoice values when the select changes', () => {
    const onChange = vi.fn();
    mounted = mount(
      <ModelChoicePicker
        role="working"
        value={{ kind: 'model', modelId: 'claude-sonnet-4-6' }}
        onChange={onChange}
        profiles={[profile]}
        catalogModels={[{ value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' }]}
        settings={{ ...settings, localModel: { ...DEFAULT_LOCAL_MODEL_SETTINGS, profiles: [profile] } }}
        codexConnected={false}
        activeProvider="anthropic"
        htmlFor="model-picker"
      />,
    );

    const select = mounted.container.querySelector<HTMLSelectElement>('#model-picker');
    expect(select).not.toBeNull();

    act(() => {
      select!.value = 'profile:profile-1';
      select!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith({ kind: 'profile', profileId: 'profile-1' });
  });

  it('keeps a stale profile visible without treating it as healthy', () => {
    mounted = mount(
      <ModelChoicePicker
        role="working"
        value={{ kind: 'profile', profileId: 'missing-profile' }}
        onChange={vi.fn()}
        profiles={[]}
        catalogModels={[{ value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' }]}
        settings={settings}
        codexConnected={false}
        activeProvider="anthropic"
        htmlFor="model-picker"
      />,
    );

    const select = mounted.container.querySelector<HTMLSelectElement>('#model-picker');
    expect(select?.value).toBe('profile:missing-profile');
    expect(select?.textContent).toContain('Profile no longer available');
    expect(select?.textContent).not.toContain('Unknown profile (missing-profile)');
  });

  it('lets consumers override the label for a missing selected profile', () => {
    mounted = mount(
      <ModelChoicePicker
        role="background"
        value={{ kind: 'profile', profileId: 'filtered-profile' }}
        onChange={vi.fn()}
        profiles={[]}
        catalogModels={[{ value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' }]}
        settings={settings}
        codexConnected={false}
        activeProvider="anthropic"
        htmlFor="model-picker"
        missingProfileLabelResolver={(profileId) =>
          profileId === 'filtered-profile' ? 'MiniMax 2.7 — not available for this task' : undefined}
      />,
    );

    const select = mounted.container.querySelector<HTMLSelectElement>('#model-picker');
    expect(select?.value).toBe('profile:filtered-profile');
    expect(select?.textContent).toContain('MiniMax 2.7 — not available for this task');
    expect(select?.textContent).not.toContain('Unknown profile (filtered-profile)');
  });

  // 260604 refinement — missing-model option must label its suffix using the
  // catalog entry's own provider, not the active provider. A stale Anthropic
  // selection while the active provider is Codex should render as
  // "Opus 4.8 — Claude", never "Opus 4.8 — ChatGPT Pro".
  it('labels a missing cross-provider model using the catalog entry provider, not the active provider', () => {
    mounted = mount(
      <ModelChoicePicker
        role="working"
        value={{ kind: 'model', modelId: 'claude-opus-4-8' }}
        onChange={vi.fn()}
        profiles={[]}
        catalogModels={[{ value: 'gpt-5.5', label: 'GPT-5.5' }]}
        settings={settings}
        codexConnected
        activeProvider="codex"
        htmlFor="model-picker"
      />,
    );

    const select = mounted.container.querySelector<HTMLSelectElement>('#model-picker');
    expect(select?.value).toBe('claude-opus-4-8');
    expect(select?.textContent).toContain('Opus 4.8 — Claude');
    expect(select?.textContent).not.toContain('Opus 4.8 — ChatGPT Pro');
  });
});
