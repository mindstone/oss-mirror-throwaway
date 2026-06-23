import type { Meta, StoryObj } from '@storybook/react';
import { OperatorMoreMenu, type OperatorMoreMenuAction } from './OperatorMoreMenu';

const allActions: OperatorMoreMenuAction[] = [
  { id: 'rename', label: 'Rename…', icon: 'rename', onSelect: () => undefined },
  { id: 'duplicate', label: 'Duplicate…', icon: 'duplicate', onSelect: () => undefined },
  { id: 'history', label: 'History', icon: 'history', onSelect: () => undefined },
  { id: 'remove', label: 'Remove', icon: 'remove', onSelect: () => undefined, isDanger: true },
];

const meta = {
  title: 'Operators/Operator More Menu',
  component: OperatorMoreMenu,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <div style={{ minHeight: 220, width: 260, padding: 32 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof OperatorMoreMenu>;

export default meta;

type Story = StoryObj<typeof meta>;

export const AllActions: Story = {
  args: {
    actions: allActions,
    buttonLabel: 'More actions for Customer Voice',
  },
};

export const LiveCoachOnly: Story = {
  args: {
    actions: [
      { id: 'rename', label: 'Rename…', icon: 'rename', onSelect: () => undefined },
      { id: 'remove', label: 'Remove', icon: 'remove', onSelect: () => undefined, isDanger: true },
    ],
    buttonLabel: 'More actions for Live Coach',
  },
};
