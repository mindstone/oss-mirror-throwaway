import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useState, type ReactNode } from 'react';

import type { RoleAssignment } from '@core/rebelCore/roleAssignment';
import type { AppSettings, ModelProfile } from '@shared/types';
import { ModelTeamSection } from './ModelTeamSection';

const meta = {
  title: 'Settings/Models/ModelTeamSection',
  component: ModelTeamSection,
  parameters: {
    layout: 'padded',
    controls: { disable: true },
  },
} satisfies Meta<typeof ModelTeamSection>;

export default meta;
type Story = StoryObj<typeof meta>;

const workingAssignment: RoleAssignment = {
  role: 'working',
  label: 'Working',
  primary: { kind: 'model', modelId: 'claude-sonnet-4-6' },
  fallback: null,
  status: { kind: 'ok', source: 'model' },
  display: {
    modelLabel: 'Claude Sonnet 4.6',
    providerLabel: 'Anthropic',
    billingSource: 'pay-per-use',
  },
  fallbackDisplay: null,
  effectiveModelId: 'claude-sonnet-4-6',
  warning: null,
  warningCta: null,
};

function makeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: overrides.id ?? 'profile-story',
    name: overrides.name ?? 'OpenAI / GPT-5.5',
    providerType: overrides.providerType ?? 'openai',
    serverUrl: overrides.serverUrl ?? 'https://api.openai.com/v1',
    model: overrides.model ?? 'gpt-5.5',
    apiKey: 'fake-storybook',
    enabled: true,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeSettings(
  profiles: ModelProfile[],
  adaptiveRoutingEnabled: boolean,
): AppSettings {
  return {
    activeProvider: 'anthropic',
    experimental: { adaptiveRoutingEnabled },
    localModel: { activeProfileId: null, profiles },
    models: { apiKey: 'fake-storybook' },
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

function ThemePair({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <BodyTheme theme="light">{children}</BodyTheme>
      <BodyTheme theme="dark">{children}</BodyTheme>
    </div>
  );
}

function ModelTeamStory({
  initialProfiles,
  adaptiveRoutingEnabled,
}: {
  initialProfiles: ModelProfile[];
  adaptiveRoutingEnabled: boolean;
}) {
  const [profiles, setProfiles] = useState(initialProfiles);
  const [settings, setSettings] = useState(() => makeSettings(initialProfiles, adaptiveRoutingEnabled));

  useEffect(() => {
    setSettings((current) => ({
      ...current,
      localModel: {
        ...(current.localModel ?? { activeProfileId: null }),
        profiles,
      },
    }));
  }, [profiles]);

  return (
    <ThemePair>
      <ModelTeamSection
        settings={settings}
        workingAssignment={workingAssignment}
        profiles={profiles}
        onSettingsChange={(updates) => setSettings((current) => ({ ...current, ...updates }))}
        onProfilesChange={setProfiles}
        onAddModel={() => undefined}
        onOpenProfileManager={() => undefined}
      />
    </ThemePair>
  );
}

function makeStory(initialProfiles: ModelProfile[], adaptiveRoutingEnabled: boolean): Story {
  return {
    args: {
      settings: makeSettings(initialProfiles, adaptiveRoutingEnabled),
      workingAssignment,
      profiles: initialProfiles,
      onSettingsChange: () => undefined,
      onProfilesChange: () => undefined,
      onAddModel: () => undefined,
      onOpenProfileManager: () => undefined,
    },
    render: () => (
      <ModelTeamStory
        initialProfiles={initialProfiles}
        adaptiveRoutingEnabled={adaptiveRoutingEnabled}
      />
    ),
  };
}

export const WorkingModelOnly: Story = makeStory([], false);

export const PopulatedCouncilOnly: Story = makeStory([
  makeProfile({ id: 'council-only', name: 'Council specialist', councilEnabled: true }),
], false);

export const PopulatedSmartPickingOnly: Story = makeStory([
  makeProfile({ id: 'smart-only', name: 'Routine work sprinter', routingEligible: true }),
], true);

export const PopulatedBoth: Story = makeStory([
  makeProfile({ id: 'council', name: 'Council specialist', councilEnabled: true, model: 'gpt-5.5' }),
  makeProfile({ id: 'smart', name: 'Routine work sprinter', routingEligible: true, model: 'gpt-5.5-mini' }),
  makeProfile({ id: 'both', name: 'All-rounder', councilEnabled: true, routingEligible: true, model: 'gpt-5.5' }),
], true);

export const SmartPickingOnPoolSizeOne: Story = makeStory([], true);

export const SmartPickingOffButEligible: Story = makeStory([
  makeProfile({ id: 'waiting-politely', name: 'Waiting politely', routingEligible: true }),
], false);

export const DuplicateModelWarning: Story = makeStory([
  makeProfile({ id: 'duplicate-a', name: 'Duplicate A', model: 'same-model', routingEligible: true }),
  makeProfile({ id: 'duplicate-b', name: 'Duplicate B', model: 'same-model', routingEligible: true }),
], true);
