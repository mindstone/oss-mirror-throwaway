import type { Meta, StoryObj } from '@storybook/react';
import { SlackContextChip, type SlackContextChipProps } from './SlackContextChip';

const meta = {
  title: 'Features/App Bridge/SlackContextChip',
  component: SlackContextChip,
  parameters: {
    layout: 'centered',
    controls: { disable: true },
  },
} satisfies Meta<typeof SlackContextChip>;

export default meta;
type Story = StoryObj<typeof meta>;

function ThemePair(args: SlackContextChipProps) {
  return (
    <div style={{ display: 'grid', gap: 12, minWidth: 360 }}>
      <div className="light" style={{ padding: 16, background: 'var(--color-card)', borderRadius: 'var(--radius-md)' }}>
        <SlackContextChip {...args} />
      </div>
      <div className="dark" style={{ padding: 16, background: 'var(--color-card)', borderRadius: 'var(--radius-md)' }}>
        <SlackContextChip {...args} />
      </div>
    </div>
  );
}

export const FullMetadata: Story = {
  render: () => (
    <ThemePair
      userName="Alice"
      channelName="general"
      teamName="Acme"
      permalink="https://acme.slack.com/archives/C123/p1700000000123456"
    />
  ),
};

export const MissingUser: Story = {
  render: () => (
    <ThemePair
      userName={null}
      channelName="general"
      teamName="Acme"
      permalink="https://acme.slack.com/archives/C123/p1700000000123456"
    />
  ),
};

export const MissingChannel: Story = {
  render: () => (
    <ThemePair
      userName="Alice"
      channelName={null}
      teamName="Acme"
      permalink="https://acme.slack.com/archives/C123/p1700000000123456"
    />
  ),
};

export const MissingTeam: Story = {
  render: () => (
    <ThemePair
      userName="Alice"
      channelName="general"
      teamName={null}
      permalink="https://acme.slack.com/archives/C123/p1700000000123456"
    />
  ),
};

export const MissingPermalink: Story = {
  render: () => (
    <ThemePair
      userName="Alice"
      channelName="general"
      teamName="Acme"
      permalink={null}
    />
  ),
};

export const AllMissing: Story = {
  render: () => <ThemePair />,
};
