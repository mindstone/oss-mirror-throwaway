// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppSettings, ModelProfile } from '@shared/types';
import { ConversationProfileLearnedNote } from '../ConversationProfileLearnedNote';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => {
  const sessionState: {
    sessionWorkingProfileId: string | undefined;
    sessionThinkingProfileId: string | undefined;
  } = {
    sessionWorkingProfileId: undefined,
    sessionThinkingProfileId: undefined,
  };
  return {
    draftSettings: {} as Partial<AppSettings>,
    sessionState,
  };
});

 
vi.mock('@renderer/features/settings', () => ({
  useSettingsSafe: () => ({
    draftSettings: mocks.draftSettings,
    settings: mocks.draftSettings,
  }),
}));

 
vi.mock('../../store/sessionStore', () => ({
  useSessionStore: <T,>(selector: (state: typeof mocks.sessionState) => T): T => selector(mocks.sessionState),
}));

interface Mounted {
  container: HTMLDivElement;
  unmount: () => void;
}

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

function makeProfile(overrides: Partial<ModelProfile>): ModelProfile {
  return {
    id: 'profile-1',
    name: 'Active OpenAI',
    providerType: 'openai',
    serverUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
    apiKey: 'test-key',
    createdAt: 1_700_000_000_000,
    enabled: true,
    ...overrides,
  };
}

describe('ConversationProfileLearnedNote', () => {
  const mounted: Mounted[] = [];

  beforeEach(() => {
    mocks.draftSettings = {} as Partial<AppSettings>;
    mocks.sessionState.sessionWorkingProfileId = undefined;
    mocks.sessionState.sessionThinkingProfileId = undefined;
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.clear();
    }
  });

  afterEach(() => {
    for (const m of mounted) m.unmount();
    mounted.length = 0;
    document.body.innerHTML = '';
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.clear();
    }
    vi.restoreAllMocks();
  });

  it('renders nothing when there are no messages yet (suppresses notice on empty conversation)', () => {
    const learnedProfile = makeProfile({
      id: 'profile-active',
      outputTokensSource: 'auto',
      outputTokensLearnedAt: 1_700_000_010_000,
      lastLearnedOutputTokens: 8_192,
    });
    mocks.draftSettings = {
      localModel: { profiles: [learnedProfile], activeProfileId: 'profile-active' },
    } as Partial<AppSettings>;
    mocks.sessionState.sessionWorkingProfileId = 'profile-active';

    const m = mount(<ConversationProfileLearnedNote hasMessages={false} />);
    mounted.push(m);

    expect(m.container.querySelector('[data-testid="conversation-profile-learned-note"]')).toBeNull();
  });

  it('renders the notice when the active session profile has a fresh learned event', () => {
    const learnedProfile = makeProfile({
      id: 'profile-active',
      outputTokensSource: 'auto',
      outputTokensLearnedAt: 1_700_000_010_000,
      lastLearnedOutputTokens: 8_192,
    });
    mocks.draftSettings = {
      localModel: { profiles: [learnedProfile], activeProfileId: 'profile-active' },
    } as Partial<AppSettings>;
    mocks.sessionState.sessionWorkingProfileId = 'profile-active';

    const m = mount(<ConversationProfileLearnedNote hasMessages />);
    mounted.push(m);

    expect(m.container.querySelector('[data-testid="conversation-profile-learned-note"]')).not.toBeNull();
    expect(m.container.textContent).toContain('Rebel got smarter');
    expect(m.container.textContent).toContain(
      'gpt-5.5 said its output limit is 8K tokens.',
    );
  });

  it('filters out events for profiles that are not the active session profile', () => {
    const otherProfile = makeProfile({
      id: 'profile-other',
      name: 'Other profile',
      outputTokensSource: 'auto',
      outputTokensLearnedAt: 1_700_000_010_000,
      lastLearnedOutputTokens: 8_192,
    });
    const activeProfile = makeProfile({ id: 'profile-active', name: 'Active' });
    mocks.draftSettings = {
      localModel: { profiles: [otherProfile, activeProfile], activeProfileId: 'profile-active' },
    } as Partial<AppSettings>;
    mocks.sessionState.sessionWorkingProfileId = 'profile-active';

    const m = mount(<ConversationProfileLearnedNote hasMessages />);
    mounted.push(m);

    expect(m.container.querySelector('[data-testid="conversation-profile-learned-note"]')).toBeNull();
  });

  it('also includes events for the session thinking profile', () => {
    const thinkingProfile = makeProfile({
      id: 'profile-thinking',
      name: 'Thinking profile',
      outputTokensSource: 'auto',
      outputTokensLearnedAt: 1_700_000_020_000,
      lastLearnedOutputTokens: 16_384,
    });
    const workingProfile = makeProfile({ id: 'profile-working', name: 'Working profile' });
    mocks.draftSettings = {
      localModel: { profiles: [workingProfile, thinkingProfile], activeProfileId: 'profile-working' },
    } as Partial<AppSettings>;
    mocks.sessionState.sessionWorkingProfileId = 'profile-working';
    mocks.sessionState.sessionThinkingProfileId = 'profile-thinking';

    const m = mount(<ConversationProfileLearnedNote hasMessages />);
    mounted.push(m);

    expect(m.container.querySelector('[data-testid="conversation-profile-learned-note"]')).not.toBeNull();
    expect(m.container.textContent).toContain('output limit is 16K tokens');
  });

  it('respects persisted dismissals from the Settings surface (cross-surface continuity)', () => {
    const learnedProfile = makeProfile({
      id: 'profile-active',
      outputTokensSource: 'auto',
      outputTokensLearnedAt: 1_700_000_010_000,
      lastLearnedOutputTokens: 8_192,
    });
    const dismissedId = 'profile-active:output-cap:1700000010000';
    window.localStorage.setItem(
      'rebel:profile-learned-dismissed:v1',
      JSON.stringify([dismissedId]),
    );
    mocks.draftSettings = {
      localModel: { profiles: [learnedProfile], activeProfileId: 'profile-active' },
    } as Partial<AppSettings>;
    mocks.sessionState.sessionWorkingProfileId = 'profile-active';

    const m = mount(<ConversationProfileLearnedNote hasMessages />);
    mounted.push(m);

    expect(m.container.querySelector('[data-testid="conversation-profile-learned-note"]')).toBeNull();
  });
});
