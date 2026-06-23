import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { OperatorsTabs, type OperatorsTabValue } from './OperatorsTabs';

const meta = {
  title: 'Operators/Operators Tabs',
  component: OperatorsTabs,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <div style={{ width: 480, padding: 32 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof OperatorsTabs>;

export default meta;

type Story = StoryObj<typeof meta>;

function StatefulTabs({
  initial,
  operatorsCount,
  liveCoachesCount,
}: { initial: OperatorsTabValue; operatorsCount: number; liveCoachesCount: number }) {
  const [value, setValue] = useState<OperatorsTabValue>(initial);
  return (
    <OperatorsTabs
      value={value}
      onValueChange={setValue}
      operatorsCount={operatorsCount}
      liveCoachesCount={liveCoachesCount}
    />
  );
}

export const Default: Story = {
  render: () => <StatefulTabs initial="operators" operatorsCount={4} liveCoachesCount={2} />,
};

export const OperatorsActive: Story = {
  render: () => <StatefulTabs initial="operators" operatorsCount={6} liveCoachesCount={3} />,
};

export const LiveCoachesActive: Story = {
  render: () => <StatefulTabs initial="live-coaches" operatorsCount={2} liveCoachesCount={5} />,
};
