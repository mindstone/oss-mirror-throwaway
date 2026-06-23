import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useState, type ReactNode } from 'react';

import { ToastProvider } from '@renderer/components/ui';
import { FlowPanelsProvider } from '@renderer/features/flow-panels/FlowPanelsProvider';
import { DEFAULT_LOCAL_MODEL_SETTINGS, DEFAULT_OPENROUTER_SETTINGS, type AppSettings, type ModelProfile, type ModelSettings } from '@shared/types';
import {
  BTS_DETAILS_HAS_RENDERED_KEY,
  BTS_DETAILS_USER_PREFERENCE_KEY,
} from '../../hooks/useFirstRenderOpenState';
import { AgentsTab } from './AgentsTab';

const meta = {
  title: 'Settings/Tabs/AgentsTab',
  component: AgentsTab,
  parameters: {
    layout: 'padded',
    controls: { disable: true },
  },
} satisfies Meta<typeof AgentsTab>;

export default meta;
type Story = StoryObj<typeof meta>;

const storyProfiles: ModelProfile[] = [
  {
    id: 'story-research',
    name: 'Research Gateway',
    providerType: 'openai',
    serverUrl: 'https://gateway.example.com/v1',
    model: 'gpt-5.5',
    apiKey: 'fake-storybook',
    routingEligible: true,
    councilEnabled: true,
    enabled: true,
    createdAt: 1,
  },
  {
    id: 'story-routine',
    name: 'Routine work sprinter',
    providerType: 'openai',
    serverUrl: 'https://gateway.example.com/v1',
    model: 'gpt-5.5-mini',
    apiKey: 'fake-storybook',
    routingEligible: true,
    enabled: true,
    createdAt: 2,
  },
];

function makeSettings(): AppSettings {
  return {
    coreDirectory: null,
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    activeProvider: 'openrouter',
    experimental: {
      adaptiveRoutingEnabled: true,
    },
    voice: {
      provider: 'openai-whisper',
      openaiApiKey: null,
      elevenlabsApiKey: null,
      model: 'gpt-4o-mini-transcribe-2025-12-15',
      ttsVoice: null,
      activationHotkey: null,
      activationHotkeyVoiceMode: true,
    },
    claude: {
      apiKey: null,
      oauthToken: null,
      authMethod: 'api-key',
      model: 'openai/gpt-5.5',
      permissionMode: 'bypassPermissions',
      executablePath: null,
      planMode: false,
      extendedContext: true,
      thinkingEffort: 'high',
    },
    models: {
      apiKey: null,
      model: 'openai/gpt-5.5',
      workingFallback: undefined,
      thinkingModel: 'anthropic/claude-sonnet-4.6',
      longContextFallbackModel: 'anthropic/claude-sonnet-4.6',
      permissionMode: 'bypassPermissions',
    },
    diagnostics: { debugBreadcrumbsUntil: null },
    openRouter: {
      ...DEFAULT_OPENROUTER_SETTINGS,
      enabled: true,
      oauthToken: 'story-openrouter-token',
      selectedModel: 'openai/gpt-5.5',
    },
    localModel: {
      ...DEFAULT_LOCAL_MODEL_SETTINGS,
      profiles: storyProfiles,
    },
    heroChoiceRunMode: 'ask',
  } as AppSettings;
}

function BodyTheme({
  theme,
  children,
}: {
  theme: 'light' | 'dark';
  children: ReactNode;
}) {
  useEffect(() => {
    document.body.classList.remove(theme === 'light' ? 'dark' : 'light');
    document.body.classList.add(theme);
    return () => {
      document.body.classList.remove(theme);
    };
  }, [theme]);

  return (
    <div
      className={theme}
      style={{
        background: 'var(--color-background)',
        color: 'var(--color-text-primary)',
        padding: 16,
      }}
    >
      {children}
    </div>
  );
}

function AgentsTabStory() {
  const [settings, setSettings] = useState(makeSettings);

  const updateDraft = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const updateClaude = <K extends keyof ModelSettings>(key: K, value: ModelSettings[K]) => {
    setSettings((current) => ({
      ...current,
      models: { ...(current.models ?? {}), [key]: value } as AppSettings['models'],
    }));
  };

  const updateVoice = <K extends keyof AppSettings['voice']>(key: K, value: AppSettings['voice'][K]) => {
    setSettings((current) => ({
      ...current,
      voice: { ...current.voice, [key]: value },
    }));
  };

  return (
    <FlowPanelsProvider>
      <ToastProvider>
        <AgentsTab
          draftSettings={settings}
          updateDraft={updateDraft}
          updateClaude={updateClaude}
          updateVoice={updateVoice}
          markKeySticky={() => undefined}
        />
      </ToastProvider>
    </FlowPanelsProvider>
  );
}

function ThemePair() {
  return (
    <div style={{ display: 'grid', gap: 24 }}>
      <BodyTheme theme="light">
        <AgentsTabStory />
      </BodyTheme>
      <BodyTheme theme="dark">
        <AgentsTabStory />
      </BodyTheme>
    </div>
  );
}

export const NewIaHierarchy: Story = {
  args: {
    draftSettings: makeSettings(),
    updateDraft: () => undefined,
    updateClaude: () => undefined,
    updateVoice: () => undefined,
    markKeySticky: () => undefined,
  },
  render: () => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(BTS_DETAILS_HAS_RENDERED_KEY, 'true');
      window.localStorage.setItem(BTS_DETAILS_USER_PREFERENCE_KEY, 'open');
    }
    return <ThemePair />;
  },
};
