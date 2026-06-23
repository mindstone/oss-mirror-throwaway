import type { Meta, StoryObj } from '@storybook/react';
import { ContextFilteredIndicator, type ContextFilteredIndicatorProps } from './ContextFilteredIndicator';

const meta = {
  title: 'Agent Session/ContextFilteredIndicator',
  component: ContextFilteredIndicator,
  parameters: {
    layout: 'centered',
    controls: { disable: true },
  },
} satisfies Meta<typeof ContextFilteredIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

function ThemePair(args: ContextFilteredIndicatorProps) {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)', width: 720, maxWidth: '100%' }}>
      <div className="light">
        <ContextFilteredIndicator {...args} />
      </div>
      <div className="dark">
        <ContextFilteredIndicator {...args} />
      </div>
    </div>
  );
}

export const Hidden: Story = {
  render: () => (
    <ThemePair
      filteredCount={0}
      mode="ownerOnly"
    />
  ),
};

export const Singular: Story = {
  render: () => (
    <ThemePair
      filteredCount={1}
      mode="ownerOnly"
    />
  ),
};

export const Plural: Story = {
  render: () => (
    <ThemePair
      filteredCount={4}
      mode="allowlist"
    />
  ),
};
