import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, type ReactNode } from 'react';
import { ProviderStep } from './ProviderStep';

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

const meta = {
  title: 'Settings/Models/ProviderStep',
  component: ProviderStep,
  parameters: {
    layout: 'padded',
  },
  args: {
    openRouterConnected: true,
    onSelect: () => undefined,
  },
} satisfies Meta<typeof ProviderStep>;

export default meta;
type Story = StoryObj<typeof meta>;

export const noCustomProviders: Story = {
  render: (args) => (
    <ThemePair>
      <ProviderStep {...args} />
    </ThemePair>
  ),
};

export const withCustomProviders: Story = {
  args: {
    customProviders: [
      {
        id: 'cp-1',
        name: 'Acme Gateway',
        serverUrl: 'https://acme.example.com/v1',
        createdAt: 1_700_000_000_000,
      },
      {
        id: 'cp-2',
        name: 'Internal Proxy',
        serverUrl: 'https://proxy.example.com/v1',
        createdAt: 1_700_000_000_001,
      },
    ],
  },
  render: (args) => (
    <ThemePair>
      <ProviderStep {...args} />
    </ThemePair>
  ),
};

export const localInferenceDisabled: Story = {
  args: {
    localInferenceEnabled: false,
    customProviders: [
      {
        id: 'cp-1',
        name: 'Acme Gateway',
        serverUrl: 'https://acme.example.com/v1',
        createdAt: 1_700_000_000_000,
      },
    ],
  },
  render: (args) => (
    <ThemePair>
      <ProviderStep {...args} />
    </ThemePair>
  ),
};
