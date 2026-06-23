import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useState, type ReactNode } from 'react';

import type { CustomProvider, ModelProfile } from '@shared/types';
import type { TestStateEntry } from './useProfileTester';
import { ProfileTable } from './ProfileTable';

const SUCCESSFUL_TEST: TestStateEntry = {
  testing: false,
  result: { success: true, latencyMs: 142 },
};

const meta = {
  title: 'Settings/Models/ProfileTable',
  component: ProfileTable,
  parameters: {
    layout: 'padded',
    controls: { disable: true },
  },
} satisfies Meta<typeof ProfileTable>;

export default meta;
type Story = StoryObj<typeof meta>;

const customProviders: CustomProvider[] = [];

function makeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: overrides.id ?? 'profile-story',
    name: overrides.name ?? 'OpenAI / GPT-5.5',
    providerType: overrides.providerType ?? 'openai',
    serverUrl: overrides.serverUrl ?? 'https://api.openai.com/v1',
    model: overrides.model ?? 'gpt-5.5',
    apiKey: 'sk-storybook',
    enabled: true,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
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

function ProfileTableStory({
  profile,
  turnInFlight = false,
  testState,
}: {
  profile: ModelProfile;
  turnInFlight?: boolean;
  testState?: TestStateEntry;
}) {
  const [profiles, setProfiles] = useState([profile]);

  return (
    <ThemePair>
      <ProfileTable
        profiles={profiles}
        allProfiles={profiles}
        customProviders={customProviders}
        testState={testState ? { [profile.id]: testState } : {}}
        onProfilesChange={setProfiles}
        justAddedId={null}
        turnInFlight={turnInFlight}
        onToggleEnabled={(profileId) => {
          setProfiles((current) =>
            current.map((candidate) =>
              candidate.id === profileId
                ? { ...candidate, enabled: candidate.enabled === false ? true : false }
                : candidate,
            ),
          );
        }}
        onTest={() => undefined}
        onEdit={() => undefined}
        onRequestDelete={() => undefined}
        onConfirmDelete={() => undefined}
        deleteConfirmId={null}
        onHighlightDone={() => undefined}
      />
    </ThemePair>
  );
}

function makeStory(
  profile: ModelProfile,
  turnInFlight = false,
  testState?: TestStateEntry,
): Story {
  return {
    args: {
      profiles: [profile],
      testState: testState ? { [profile.id]: testState } : {},
      onProfilesChange: () => undefined,
      justAddedId: null,
      onToggleEnabled: () => undefined,
      onTest: () => undefined,
      onEdit: () => undefined,
      onRequestDelete: () => undefined,
      onConfirmDelete: () => undefined,
      deleteConfirmId: null,
      onHighlightDone: () => undefined,
    },
    render: () => (
      <ProfileTableStory
        profile={profile}
        turnInFlight={turnInFlight}
        testState={testState}
      />
    ),
  };
}

/**
 * Stage 1 — Toggle visibility stories.
 * Show the relocated On/Off toggle in actions cell: active row (On),
 * disabled/available row (Off), and a company-managed row (toggle functional).
 * Check both light and dark in Storybook — the BodyTheme wrapper applies both.
 */
export const ToggleOnActive: Story = makeStory(
  makeProfile({
    id: 'toggle-on',
    name: 'DeepSeek V4 Flash',
    model: 'deepseek/deepseek-v4-flash',
    enabled: true,
    councilEnabled: true,
    routingEligible: true,
  }),
);

export const ToggleOffAvailable: Story = makeStory(
  makeProfile({
    id: 'toggle-off',
    name: 'GPT-5.5 (paused)',
    model: 'gpt-5.5',
    enabled: false,
    councilEnabled: false,
    routingEligible: false,
  }),
);

export const CompanyManagedToggle: Story = makeStory(
  makeProfile({
    id: 'company-managed-toggle',
    name: 'Org-managed Model',
    model: 'anthropic/claude-opus-4',
    companyManaged: true,
    enabled: true,
    councilEnabled: true,
    routingEligible: true,
  }),
);

export const BothChipsOff: Story = makeStory(
  makeProfile({ id: 'both-off', councilEnabled: false, routingEligible: false }),
);

export const CouncilOnlyOn: Story = makeStory(
  makeProfile({ id: 'council-only', councilEnabled: true, routingEligible: false }),
);

export const SmartPickingOnlyOn: Story = makeStory(
  makeProfile({ id: 'smart-only', councilEnabled: false, routingEligible: true }),
);

export const BothOn: Story = makeStory(
  makeProfile({ id: 'both-on', councilEnabled: true, routingEligible: true }),
);

export const CompanyManagedDisabled: Story = makeStory(
  makeProfile({
    id: 'managed-disabled',
    name: 'Company-managed model',
    companyManaged: true,
    councilEnabled: true,
    routingEligible: true,
  }),
);

export const ProfileDisabled: Story = makeStory(
  makeProfile({
    id: 'profile-disabled',
    name: 'Paused model',
    enabled: false,
    councilEnabled: true,
    routingEligible: false,
  }),
);

export const MidTurnDisabled: Story = makeStory(
  makeProfile({
    id: 'mid-turn-disabled',
    councilEnabled: false,
    routingEligible: true,
  }),
  true,
);

export const OrphanedProviderProfile: Story = makeStory(
  makeProfile({
    id: 'orphaned-provider',
    name: 'Provider went walkabout',
    providerType: 'other',
    customProviderId: 'missing-provider',
    councilEnabled: true,
    routingEligible: true,
  }),
);

/**
 * Stage 2 — "Research this model" gating stories.
 * The button surfaces only after a successful test AND when the model genuinely
 * lacks routing notes (no per-profile notes, no legacy strengths/weaknesses, no
 * catalog default). Catalog models stop nagging; custom/unknown endpoints offer it.
 */

// Catalog model (gpt-5.5 ships routing notes) → no Research button even after a pass.
export const TestedCatalogModelNoResearch: Story = makeStory(
  makeProfile({
    id: 'tested-catalog',
    name: 'OpenAI / GPT-5.5',
    model: 'gpt-5.5',
  }),
  false,
  SUCCESSFUL_TEST,
);

// Unknown custom model (no catalog notes) → Research button visible with new copy.
export const TestedCustomModelOffersResearch: Story = makeStory(
  makeProfile({
    id: 'tested-custom',
    name: 'My local model',
    providerType: 'other',
    serverUrl: 'http://127.0.0.1:8000/v1',
    model: 'my-local-model',
  }),
  false,
  SUCCESSFUL_TEST,
);

// In-flight test → status shows "Testing…", no Research button yet.
export const TestingInFlight: Story = makeStory(
  makeProfile({
    id: 'testing-inflight',
    name: 'My local model',
    providerType: 'other',
    serverUrl: 'http://127.0.0.1:8000/v1',
    model: 'my-local-model',
  }),
  false,
  { testing: true },
);

// Connection-managed row needing setup → reconnect CTA path (not the Research button).
export const NeedsSetupReconnect: Story = {
  args: {
    profiles: [],
    testState: {},
    onProfilesChange: () => undefined,
    justAddedId: null,
    onToggleEnabled: () => undefined,
    onTest: () => undefined,
    onEdit: () => undefined,
    onRequestDelete: () => undefined,
    onConfirmDelete: () => undefined,
    deleteConfirmId: null,
    onHighlightDone: () => undefined,
  },
  render: () => {
    const profile = makeProfile({
      id: 'needs-setup',
      name: 'OpenRouter (connection)',
      providerType: 'openrouter',
      serverUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-5.5',
      profileSource: 'connection',
      routeSurface: 'pool',
    });
    return (
      <ThemePair>
        <ProfileTable
          profiles={[profile]}
          allProfiles={[profile]}
          customProviders={customProviders}
          testState={{}}
          needsSetupProfileIds={new Set([profile.id])}
          getReconnectHandler={() => () => undefined}
          onProfilesChange={() => undefined}
          justAddedId={null}
          onToggleEnabled={() => undefined}
          onTest={() => undefined}
          onEdit={() => undefined}
          onRequestDelete={() => undefined}
          onConfirmDelete={() => undefined}
          deleteConfirmId={null}
          onHighlightDone={() => undefined}
        />
      </ThemePair>
    );
  },
};
