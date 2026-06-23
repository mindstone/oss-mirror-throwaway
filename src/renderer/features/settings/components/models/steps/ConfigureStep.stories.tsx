import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useRef, type ReactNode } from 'react';

import { ConfigureStep } from './ConfigureStep';
import { useProfileWizard } from '../useProfileWizard';
import type { ModelProfile } from '@shared/types';

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
}

function Host({ profile }: HostProps) {
  const [view, actions] = useProfileWizard({});
  const openedRef = useRef(false);
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

function ThemePair({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <BodyTheme theme="light">{children}</BodyTheme>
      <BodyTheme theme="dark">{children}</BodyTheme>
    </div>
  );
}

function BodyTheme({ theme, children }: { theme: 'light' | 'dark'; children: ReactNode }) {
  useEffect(() => {
    document.body.classList.add(theme);
    return () => {
      document.body.classList.remove(theme);
    };
  }, [theme]);
  return <div className={theme}>{children}</div>;
}

const meta = {
  title: 'Settings/Configure Step (Advanced)',
  component: Host,
  parameters: {
    layout: 'padded',
    controls: { disable: true },
  },
} satisfies Meta<typeof Host>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AutoLearnedSource: Story = {
  render: () => (
    <ThemePair>
      <Host
        profile={makeProfile({
          name: 'gpt-future (auto)',
          contextWindow: 200_000,
          contextWindowSource: 'auto',
          lastLearnedContextWindow: 200_000,
          contextWindowOverflowCount: 3,
          contextWindowLearnedAt: Date.now() - 1000 * 60 * 60 * 6,
        })}
      />
    </ThemePair>
  ),
};

export const UserOverrodeWithLearnedAvailable: Story = {
  render: () => (
    <ThemePair>
      <Host
        profile={makeProfile({
          name: 'gpt-future (manual override)',
          contextWindow: 128_000,
          contextWindowSource: 'user',
          lastLearnedContextWindow: 200_000,
          contextWindowOverflowCount: 2,
          contextWindowLearnedAt: Date.now() - 1000 * 60 * 90,
        })}
      />
    </ThemePair>
  ),
};
