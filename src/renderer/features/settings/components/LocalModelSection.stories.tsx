import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, type ReactNode } from 'react';

import { LocalModelSection } from './LocalModelSection';
import type { CustomProvider, ModelProfile, ProviderKeys } from '@shared/types';

const meta = {
  title: 'Settings/Local Model Section',
  component: LocalModelSection,
  parameters: {
    layout: 'padded',
    controls: { disable: true },
  },
} satisfies Meta<typeof LocalModelSection>;

export default meta;
type Story = StoryObj<typeof meta>;

const providerKeys: ProviderKeys = { openai: 'sk-stub' };
const customProviders: CustomProvider[] = [];

function activeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: overrides.id ?? 'profile-active-1',
    name: overrides.name ?? 'OpenAI / GPT-5.5',
    providerType: 'openai',
    serverUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
    apiKey: 'sk-fixture',
    enabled: true,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function availableProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return activeProfile({
    id: 'profile-available-1',
    name: 'OpenAI / GPT-5.4 mini',
    model: 'gpt-5.4-mini',
    enabled: false,
    ...overrides,
  });
}

function needsSetupProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: overrides.id ?? 'auto:gpt-future',
    name: overrides.name ?? 'gpt-future',
    providerType: 'other',
    serverUrl: '',
    apiKey: undefined,
    model: overrides.model ?? 'gpt-future',
    enabled: false,
    createdAt: 1_700_000_000_000,
    contextWindow: 200_000,
    contextWindowSource: 'auto',
    lastLearnedContextWindow: 200_000,
    contextWindowOverflowCount: 2,
    contextWindowLearnedAt: Date.now() - 1000 * 60 * 60 * 24 * 2,
    ...overrides,
  };
}

function ThemePair({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <BodyTheme theme="light">{children}</BodyTheme>
      <BodyTheme theme="dark">{children}</BodyTheme>
    </div>
  );
}

function BodyTheme({
  theme,
  children,
}: {
  theme: 'light' | 'dark';
  children: ReactNode;
}) {
  useEffect(() => {
    document.body.classList.add(theme);
    return () => {
      document.body.classList.remove(theme);
    };
  }, [theme]);
  return <div className={theme}>{children}</div>;
}

function story(profiles: ModelProfile[]): Story {
  return {
    render: () => (
      <ThemePair>
        <LocalModelSection
          profiles={profiles}
          onProfilesChange={() => undefined}
          providerKeys={providerKeys}
          customProviders={customProviders}
          openRouterConnected={false}
        />
      </ThemePair>
    ),
  };
}

export const ActiveAndAvailableOnly = story([
  activeProfile(),
  availableProfile(),
]);

export const AllThreeSections = story([
  activeProfile(),
  availableProfile(),
  needsSetupProfile(),
  needsSetupProfile({
    id: 'auto:gpt-mini-future',
    name: 'gpt-mini-future',
    model: 'gpt-mini-future',
    contextWindow: 64_000,
    lastLearnedContextWindow: 64_000,
    contextWindowOverflowCount: 1,
    contextWindowLearnedAt: Date.now() - 1000 * 60 * 30,
  }),
]);

export const NeedsSetupOnly = story([
  needsSetupProfile(),
  needsSetupProfile({
    id: 'auto:gpt-mini-future',
    name: 'gpt-mini-future',
    model: 'gpt-mini-future',
    contextWindow: 64_000,
    lastLearnedContextWindow: 64_000,
    contextWindowOverflowCount: 1,
    contextWindowLearnedAt: Date.now() - 1000 * 60 * 30,
  }),
]);

export const NeedsSetupHiddenWhenEmpty = story([activeProfile()]);
