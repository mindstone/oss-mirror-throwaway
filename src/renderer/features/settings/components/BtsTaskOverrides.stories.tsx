import type { Meta, StoryObj } from '@storybook/react';
import React, { useState, type ComponentProps } from 'react';

import { BtsTaskOverrides } from './BtsTaskOverrides';
import {
  BtsTaskOverridesStoryBodyTheme,
  type BtsTaskOverridesStoryTheme,
} from './BtsTaskOverridesStoryTheme';
import { CODEX_WORKING_PROFILE_ID } from '@shared/utils/codexDefaults';
import { BTS_TASK_GROUP_KEYS, type BtsTaskGroup } from '@shared/utils/btsModelResolver';
import { MODEL_OPTIONS } from '@shared/utils/modelNormalization';
import { DEFAULT_LOCAL_MODEL_SETTINGS, type ActiveProvider, type AppSettings, type ModelProfile } from '@shared/types';

const meta = {
  title: 'Settings/BTS Task Overrides',
  component: BtsTaskOverrides,
  parameters: {
    layout: 'padded',
    controls: { disable: true },
  },
} satisfies Meta<typeof BtsTaskOverrides>;

export default meta;
type Story = StoryObj<typeof meta>;

const researchProfile: ModelProfile = {
  id: 'research-gateway',
  name: 'Research Gateway',
  providerType: 'openai',
  serverUrl: 'https://gateway.example.com/v1',
  model: 'gpt-5.5',
  apiKey: 'sk-fixture',
  enabled: true,
  createdAt: 1,
};

const meetingProfile: ModelProfile = {
  id: 'meeting-scout',
  name: 'Meeting Scout',
  providerType: 'openai',
  serverUrl: 'https://gateway.example.com/v1',
  model: 'gpt-5.4-mini',
  apiKey: 'sk-fixture',
  enabled: true,
  createdAt: 2,
};

const jsonIncompatibleProfile: ModelProfile = {
  id: 'json-incompatible-profile',
  name: 'MiniMax 2.7',
  providerType: 'openai',
  serverUrl: 'https://gateway.example.com/v1',
  model: 'minimax/minimax-m2.7',
  apiKey: 'sk-fixture',
  enabled: true,
  jsonCompatibility: 'incompatible',
  createdAt: 3,
};

const codexProfile: ModelProfile = {
  id: CODEX_WORKING_PROFILE_ID,
  name: 'GPT-5.5 (ChatGPT Pro)',
  authSource: 'codex-subscription',
  providerType: 'openai',
  serverUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.5',
  enabled: true,
  createdAt: 4,
};

const auxiliaryModelValues = MODEL_OPTIONS
  .filter((model) => model.isAuxiliaryModel)
  .map((model) => model.value);

function makeSettings(profiles: ModelProfile[], activeProvider: ActiveProvider = 'anthropic'): AppSettings {
  return {
    localModel: {
      ...DEFAULT_LOCAL_MODEL_SETTINGS,
      profiles,
    },
    activeProvider,
    models: {
      apiKey: activeProvider === 'anthropic' ? 'sk-ant-fixture' : null,
    },
    openRouter: {
      oauthToken: 'or-fixture',
    },
  } as AppSettings;
}

function allOverrides(): Partial<Record<BtsTaskGroup, string>> {
  return BTS_TASK_GROUP_KEYS.reduce<Partial<Record<BtsTaskGroup, string>>>((acc, group, index) => {
    if (index % 3 === 0) {
      acc[group] = `profile:${researchProfile.id}`;
    } else if (index % 3 === 1) {
      acc[group] = auxiliaryModelValues[index % auxiliaryModelValues.length];
    } else {
      acc[group] = `profile:${meetingProfile.id}`;
    }
    return acc;
  }, {});
}

function StoryHost({
  theme,
  profiles,
  initialOverrides,
  activeProvider = 'anthropic',
  codexConnected = false,
}: {
  theme: BtsTaskOverridesStoryTheme;
  profiles: ModelProfile[];
  initialOverrides?: Partial<Record<BtsTaskGroup, string>>;
  activeProvider?: ActiveProvider;
  codexConnected?: boolean;
}) {
  const [overrides, setOverrides] = useState(initialOverrides);
  const settings = makeSettings(profiles, activeProvider);

  return (
    <BtsTaskOverridesStoryBodyTheme theme={theme}>
      <BtsTaskOverrides
        settings={settings}
        overrides={overrides}
        onOverrideChange={(group, value) => {
          setOverrides((current) => {
            const next = { ...(current ?? {}) };
            if (value) {
              next[group] = value;
            } else {
              delete next[group];
            }
            return Object.keys(next).length > 0 ? next : undefined;
          });
        }}
        localModelProfiles={profiles}
        activeProvider={activeProvider}
        codexConnected={codexConnected}
      />
    </BtsTaskOverridesStoryBodyTheme>
  );
}

type StoryHostProps = ComponentProps<typeof StoryHost>;

const storybookRequiredArgs: ComponentProps<typeof BtsTaskOverrides> = {
  settings: makeSettings([]),
  overrides: undefined,
  onOverrideChange: () => {},
  localModelProfiles: [],
  codexConnected: false,
};

function makeThemeStory(props: StoryHostProps): Story {
  return {
    args: storybookRequiredArgs,
    render: () => (
      <StoryHost {...props} />
    ),
  };
}

export const EmptyOverridesLight: Story = makeThemeStory({
  theme: 'light',
  profiles: [researchProfile, meetingProfile],
});

export const EmptyOverridesDark: Story = makeThemeStory({
  theme: 'dark',
  profiles: [researchProfile, meetingProfile],
});

export const AllOverriddenLight: Story = makeThemeStory({
  theme: 'light',
  profiles: [researchProfile, meetingProfile],
  initialOverrides: allOverrides(),
});

export const AllOverriddenDark: Story = makeThemeStory({
  theme: 'dark',
  profiles: [researchProfile, meetingProfile],
  initialOverrides: allOverrides(),
});

export const JsonRequiredWithIncompatibleProfileSelectedLight: Story = makeThemeStory({
  theme: 'light',
  profiles: [researchProfile, jsonIncompatibleProfile],
  initialOverrides: { safety: `profile:${jsonIncompatibleProfile.id}` },
});

export const JsonRequiredWithIncompatibleProfileSelectedDark: Story = makeThemeStory({
  theme: 'dark',
  profiles: [researchProfile, jsonIncompatibleProfile],
  initialOverrides: { safety: `profile:${jsonIncompatibleProfile.id}` },
});

export const CodexActiveLight: Story = makeThemeStory({
  theme: 'light',
  profiles: [codexProfile, researchProfile],
  activeProvider: 'codex',
  codexConnected: true,
  initialOverrides: { meetings: `profile:${CODEX_WORKING_PROFILE_ID}` },
});

export const CodexActiveDark: Story = makeThemeStory({
  theme: 'dark',
  profiles: [codexProfile, researchProfile],
  activeProvider: 'codex',
  codexConnected: true,
  initialOverrides: { meetings: `profile:${CODEX_WORKING_PROFILE_ID}` },
});
