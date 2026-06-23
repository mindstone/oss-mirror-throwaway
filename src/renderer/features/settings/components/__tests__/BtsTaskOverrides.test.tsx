// @vitest-environment happy-dom

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BtsTaskOverrides } from '../BtsTaskOverrides';
import { CODEX_WORKING_PROFILE_ID } from '@shared/utils/codexDefaults';
import { BTS_TASK_GROUPS, BTS_TASK_GROUP_KEYS, type BtsTaskGroup } from '@shared/utils/btsModelResolver';
import type { AppSettings, ModelProfile } from '@shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
};

const codexWorkingProfile: ModelProfile = {
  id: CODEX_WORKING_PROFILE_ID,
  name: 'GPT-5.5 (ChatGPT Pro)',
  authSource: 'codex-subscription',
  providerType: 'openai',
  serverUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.5',
  createdAt: 0,
};

const customProfile: ModelProfile = {
  id: 'custom-openai-profile',
  name: 'Research Gateway',
  providerType: 'openai',
  serverUrl: 'https://gateway.example.com/v1',
  model: 'gpt-4.1',
  createdAt: 1,
};

const incompatibleJsonProfile: ModelProfile = {
  id: 'json-incompatible-profile',
  name: 'MiniMax 2.7',
  providerType: 'openai',
  serverUrl: 'https://api.example.com/v1',
  model: 'minimax/minimax-m2.7',
  createdAt: 2,
  jsonCompatibility: 'incompatible',
};

function makeSettings(profiles: ModelProfile[]): AppSettings {
  return {
    coreDirectory: null,
    mcpConfigFile: null,
    onboardingCompleted: false,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    voice: {
      provider: 'openai-whisper',
      openaiApiKey: null,
      elevenlabsApiKey: null,
      model: 'gpt-4o-mini-transcribe-2025-12-15',
      ttsVoice: null,
      activationHotkey: null,
      activationHotkeyVoiceMode: true,
    },
    models: {
      apiKey: null,
      oauthToken: null,
      authMethod: 'api-key',
      model: 'claude-sonnet-4-6',
      permissionMode: 'bypassPermissions',
      executablePath: null,
      planMode: false,
      extendedContext: true,
      thinkingEffort: 'high',
    },
    diagnostics: { debugBreadcrumbsUntil: null },
    localModel: {
      profiles,
      activeProfileId: null,
    },
  };
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

function getYourModelOptions(container: HTMLDivElement, group: string = 'safety'): string[] {
  const select = container.querySelector(`#bts-override-${group}`);
  const options = select?.querySelectorAll('optgroup[label="Your Models"] option') ?? [];
  return Array.from(options).map(option => option.textContent ?? '');
}

function getSelect(container: HTMLDivElement, group: BtsTaskGroup = 'safety'): HTMLSelectElement {
  const select = container.querySelector<HTMLSelectElement>(`#bts-override-${group}`);
  expect(select).not.toBeNull();
  return select!;
}

function getOptionValues(container: HTMLDivElement, group: BtsTaskGroup, optgroupLabel: string): string[] {
  const select = getSelect(container, group);
  const options = select.querySelectorAll(`optgroup[label="${optgroupLabel}"] option`);
  return Array.from(options).map(option => option.getAttribute('value') ?? '');
}

describe('BtsTaskOverrides', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('renders the picker option set for every BTS task group', () => {
    mounted = mount(
      <BtsTaskOverrides
        settings={makeSettings([customProfile, incompatibleJsonProfile])}
        overrides={undefined}
        onOverrideChange={vi.fn()}
        localModelProfiles={[customProfile, incompatibleJsonProfile]}
        activeProvider="anthropic"
        codexConnected={false}
      />
    );

    for (const group of BTS_TASK_GROUP_KEYS) {
      const select = getSelect(mounted.container, group);
      const specialOptions = getOptionValues(mounted.container, group, 'Special');
      const claudeOptions = getOptionValues(mounted.container, group, 'Claude');
      const yourModelOptions = getYourModelOptions(mounted.container, group);

      expect(select.labels?.[0]?.textContent).toBe(BTS_TASK_GROUPS[group].label);
      expect(specialOptions).toEqual(['']);
      expect(claudeOptions.length).toBeGreaterThan(0);
      expect(yourModelOptions.some(text => text.startsWith('Research Gateway'))).toBe(true);

      const includesJsonIncompatibleProfile = yourModelOptions.some(text => text.startsWith('MiniMax 2.7'));
      expect(includesJsonIncompatibleProfile).toBe(BTS_TASK_GROUPS[group].requiresJson === true ? false : true);
    }
  });

  it('hides codex-gpt-5.5 auto-profile from Your Models when activeProvider is anthropic', () => {
    mounted = mount(
      <BtsTaskOverrides
        settings={makeSettings([codexWorkingProfile, customProfile])}
        overrides={undefined}
        onOverrideChange={vi.fn()}
        localModelProfiles={[codexWorkingProfile, customProfile]}
        activeProvider="anthropic"
        codexConnected={false}
      />
    );

    const optionTexts = getYourModelOptions(mounted.container);

    expect(optionTexts.some(text => text.startsWith('GPT-5.5 (ChatGPT Pro)'))).toBe(false);
    expect(optionTexts.some(text => text.startsWith('Research Gateway'))).toBe(true);
  });

  it('shows codex-gpt-5.5 auto-profile when activeProvider is codex', () => {
    mounted = mount(
      <BtsTaskOverrides
        settings={makeSettings([codexWorkingProfile, customProfile])}
        overrides={undefined}
        onOverrideChange={vi.fn()}
        localModelProfiles={[codexWorkingProfile, customProfile]}
        activeProvider="codex"
        codexConnected={true}
      />
    );

    const optionTexts = getYourModelOptions(mounted.container);

    expect(optionTexts.some(text => text.startsWith('GPT-5.5 (ChatGPT Pro)'))).toBe(true);
    expect(optionTexts.some(text => text.startsWith('Research Gateway'))).toBe(true);
  });

  it('non-Codex custom profiles are always shown', () => {
    mounted = mount(
      <BtsTaskOverrides
        settings={makeSettings([customProfile])}
        overrides={undefined}
        onOverrideChange={vi.fn()}
        localModelProfiles={[customProfile]}
        activeProvider="anthropic"
        codexConnected={false}
      />
    );

    const optionTexts = getYourModelOptions(mounted.container);

    expect(optionTexts).toHaveLength(1);
    expect(optionTexts[0]).toContain('Research Gateway');
  });

  it('renders inline hint when persisted override is a hidden Codex profile', () => {
    const onOverrideChange = vi.fn();

    mounted = mount(
      <BtsTaskOverrides
        settings={makeSettings([codexWorkingProfile, customProfile])}
        overrides={{ safety: `profile:${CODEX_WORKING_PROFILE_ID}` }}
        onOverrideChange={onOverrideChange}
        localModelProfiles={[codexWorkingProfile, customProfile]}
        activeProvider="anthropic"
        codexConnected={false}
      />
    );

    const select = mounted.container.querySelector('#bts-override-safety') as HTMLSelectElement | null;

    expect(select).not.toBeNull();
    expect(select?.value).toBe(`profile:${CODEX_WORKING_PROFILE_ID}`);
    expect(mounted.container.textContent).toContain('Previous model hidden — reconnect ChatGPT Pro or pick another');
    expect(onOverrideChange).not.toHaveBeenCalled();
  });

  it('uses hero-choice key path — hidden value still shows hint for hero-choice task', () => {
    mounted = mount(
      <BtsTaskOverrides
        settings={makeSettings([codexWorkingProfile, customProfile])}
        overrides={{ 'hero-choice': `profile:${CODEX_WORKING_PROFILE_ID}` }}
        onOverrideChange={vi.fn()}
        localModelProfiles={[codexWorkingProfile, customProfile]}
        activeProvider="anthropic"
        codexConnected={false}
      />
    );

    const select = mounted.container.querySelector('#bts-override-hero-choice') as HTMLSelectElement | null;

    expect(select).not.toBeNull();
    expect(select?.value).toBe(`profile:${CODEX_WORKING_PROFILE_ID}`);
    expect(mounted.container.textContent).toContain('Previous model hidden — reconnect ChatGPT Pro or pick another');
  });

  it('renders generic hint when persisted override is a hidden non-Codex value (OR-format)', () => {
    mounted = mount(
      <BtsTaskOverrides
        settings={makeSettings([customProfile])}
        overrides={{ safety: 'openai/gpt-5.4-mini' }}
        onOverrideChange={vi.fn()}
        localModelProfiles={[customProfile]}
        activeProvider="anthropic"
        codexConnected={false}
      />
    );

    const select = mounted.container.querySelector('#bts-override-safety') as HTMLSelectElement | null;

    expect(select).not.toBeNull();
    expect(select?.value).toBe('openai/gpt-5.4-mini');
    expect(mounted.container.textContent).toContain('Previous model no longer available for current provider');
  });

  it('renders an inline warning notice when a persisted override references a missing profile', () => {
    mounted = mount(
      <BtsTaskOverrides
        settings={makeSettings([])}
        overrides={{ safety: 'profile:missing-task-profile' }}
        onOverrideChange={vi.fn()}
        localModelProfiles={[]}
        activeProvider="anthropic"
        codexConnected={false}
      />
    );

    const select = getSelect(mounted.container, 'safety');
    const notice = mounted.container.querySelector('[data-testid="bts-task-override-safety-missing-profile-notice"]');
    const cta = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="bts-task-override-safety-missing-profile-cta"]',
    );

    expect(select.value).toBe('profile:missing-task-profile');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain(
      'This profile is no longer available. Using default model for this task for now.',
    );
    expect(cta?.textContent).toContain('Pick another model');
    expect(mounted.container.textContent).not.toContain('Previous model no longer available for current provider');
  });

  it('renders Codex copy when persisted override is a hidden Codex profile even while codexConnected=true', () => {
    mounted = mount(
      <BtsTaskOverrides
        settings={makeSettings([codexWorkingProfile, customProfile])}
        overrides={{ safety: `profile:${CODEX_WORKING_PROFILE_ID}` }}
        onOverrideChange={vi.fn()}
        localModelProfiles={[codexWorkingProfile, customProfile]}
        activeProvider="anthropic"
        codexConnected={true}
      />
    );

    const select = mounted.container.querySelector('#bts-override-safety') as HTMLSelectElement | null;

    expect(select).not.toBeNull();
    expect(select?.value).toBe(`profile:${CODEX_WORKING_PROFILE_ID}`);
    expect(mounted.container.textContent).toContain('Previous model hidden — reconnect ChatGPT Pro or pick another');
  });

  it('hides JSON-incompatible profiles for JSON-required BTS groups', () => {
    mounted = mount(
      <BtsTaskOverrides
        settings={makeSettings([incompatibleJsonProfile])}
        overrides={undefined}
        onOverrideChange={vi.fn()}
        localModelProfiles={[incompatibleJsonProfile]}
        activeProvider="anthropic"
        codexConnected={false}
      />
    );

    const safetyOptions = getYourModelOptions(mounted.container, 'safety');
    expect(safetyOptions.some(text => text.startsWith('MiniMax 2.7'))).toBe(false);
  });

  it('keeps JSON-incompatible profiles visible for non-JSON BTS groups', () => {
    mounted = mount(
      <BtsTaskOverrides
        settings={makeSettings([incompatibleJsonProfile])}
        overrides={undefined}
        onOverrideChange={vi.fn()}
        localModelProfiles={[incompatibleJsonProfile]}
        activeProvider="anthropic"
        codexConnected={false}
      />
    );

    const meetingsOptions = getYourModelOptions(mounted.container, 'meetings');
    expect(meetingsOptions.some(text => text.startsWith('MiniMax 2.7'))).toBe(true);
  });

  it('shows JSON-specific stale hint when saved override points to filtered profile', () => {
    mounted = mount(
      <BtsTaskOverrides
        settings={makeSettings([incompatibleJsonProfile])}
        overrides={{ safety: `profile:${incompatibleJsonProfile.id}` }}
        onOverrideChange={vi.fn()}
        localModelProfiles={[incompatibleJsonProfile]}
        activeProvider="anthropic"
        codexConnected={false}
      />
    );

    const select = mounted.container.querySelector('#bts-override-safety') as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect(select?.value).toBe(`profile:${incompatibleJsonProfile.id}`);
    expect(mounted.container.textContent).toContain('is marked No JSON and cannot be used for this task');
  });

  it('labels filtered-but-known JSON-incompatible selected profiles by name', () => {
    mounted = mount(
      <BtsTaskOverrides
        settings={makeSettings([incompatibleJsonProfile])}
        overrides={{ safety: `profile:${incompatibleJsonProfile.id}` }}
        onOverrideChange={vi.fn()}
        localModelProfiles={[incompatibleJsonProfile]}
        activeProvider="anthropic"
        codexConnected={false}
      />
    );

    const select = getSelect(mounted.container, 'safety');
    const selectedOption = Array.from(select.options).find(option => option.value === `profile:${incompatibleJsonProfile.id}`);

    expect(selectedOption?.textContent).toBe('MiniMax 2.7 — not available for this task');
    expect(mounted.container.textContent).not.toContain(`Unknown profile (${incompatibleJsonProfile.id})`);
  });

  it('selecting Same as Behind the Scenes clears the override', () => {
    const onOverrideChange = vi.fn();

    mounted = mount(
      <BtsTaskOverrides
        settings={makeSettings([customProfile])}
        overrides={{ safety: `profile:${customProfile.id}` }}
        onOverrideChange={onOverrideChange}
        localModelProfiles={[customProfile]}
        activeProvider="anthropic"
        codexConnected={false}
      />
    );

    const select = getSelect(mounted.container, 'safety');

    act(() => {
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(onOverrideChange).toHaveBeenCalledWith('safety', undefined);
  });

  it('bare model id selection is written unchanged into behindTheScenesOverrides', () => {
    const onOverrideChange = vi.fn();

    mounted = mount(
      <BtsTaskOverrides
        settings={makeSettings([customProfile])}
        overrides={undefined}
        onOverrideChange={onOverrideChange}
        localModelProfiles={[customProfile]}
        activeProvider="anthropic"
        codexConnected={false}
      />
    );

    const select = getSelect(mounted.container, 'safety');
    const modelValue = getOptionValues(mounted.container, 'safety', 'Claude')[0];
    expect(modelValue).toBeTruthy();

    act(() => {
      select.value = modelValue;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(onOverrideChange).toHaveBeenCalledWith('safety', modelValue);
    expect(onOverrideChange).not.toHaveBeenCalledWith('safety', `model:${modelValue}`);
  });
});
