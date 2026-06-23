import type { Meta, StoryObj } from '@storybook/react';
import type { OperatorMetadata } from '@shared/ipc/channels/operators';
import { OperatorCard } from './OperatorCard';

const baseOperator: OperatorMetadata = {
  id: '/workspace/Chief-of-Staff::customer-voice',
  operatorSlug: 'customer-voice',
  spacePath: '/workspace/Chief-of-Staff',
  sourceSpacePath: '/workspace/Chief-of-Staff',
  category: 'space',
  name: 'Customer Voice',
  description: 'Speaks for the user when claims and copy need pressure-testing.',
  consult_when: 'When discovery findings or pricing changes need a customer perspective.',
  kind: 'operator',
  roles: ['operator'],
  operatorFileAbsolutePath: '/workspace/Chief-of-Staff/operators/customer-voice/OPERATOR.md',
  groundingPath: '/workspace/Chief-of-Staff/operators/customer-voice/grounding.md',
  diaryPath: '/workspace/Chief-of-Staff/operators/customer-voice/diary.md',
};

const bundledOperator: OperatorMetadata = {
  ...baseOperator,
  id: '/workspace/rebel-system::brand-critic',
  operatorSlug: 'brand-critic',
  spacePath: '/workspace/rebel-system',
  sourceSpacePath: '/workspace/rebel-system',
  category: 'bundled',
  name: 'Brand Critic',
  description: 'Keeps the message honest.',
  consult_when: 'When claims need taste.',
};

const meta = {
  title: 'Operators/Operator Card',
  component: OperatorCard,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <div style={{ width: 360, padding: 32 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof OperatorCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Bundled: Story = {
  args: {
    operator: bundledOperator,
    state: { kind: 'bundled' },
    spaceLabel: 'Bundled',
    activationTargets: [
      { sourceSpacePath: '/workspace/Chief-of-Staff', label: 'Chief-of-Staff', isChiefOfStaff: true },
      { sourceSpacePath: '/workspace/work/acme/Launch', label: 'Launch' },
    ],
    defaultActivationTargetSpacePath: '/workspace/Chief-of-Staff',
    onActivate: () => undefined,
  },
};

export const ActivatedNeverPersonalised: Story = {
  args: {
    operator: baseOperator,
    state: { kind: 'activated', personalised: false, personalising: false },
    spaceLabel: 'Chief-of-Staff',
    onPersonalise: () => undefined,
    onOpenInstructions: () => undefined,
    onToggleLiveMeeting: () => undefined,
    onRename: () => undefined,
    onDuplicate: () => undefined,
    onHistory: () => undefined,
    onRemove: () => undefined,
  },
};

export const ActivatedPersonalised: Story = {
  args: {
    operator: baseOperator,
    state: { kind: 'activated', personalised: true, personalising: false },
    spaceLabel: 'Chief-of-Staff',
    onPersonalise: () => undefined,
    onOpenInstructions: () => undefined,
    onToggleLiveMeeting: () => undefined,
    onRename: () => undefined,
    onDuplicate: () => undefined,
    onHistory: () => undefined,
    onRemove: () => undefined,
  },
};

export const PersonalisingInProgress: Story = {
  args: {
    operator: baseOperator,
    state: { kind: 'activated', personalised: false, personalising: true },
    spaceLabel: 'Chief-of-Staff',
    onPersonalise: () => undefined,
    onOpenInstructions: () => undefined,
    onToggleLiveMeeting: () => undefined,
    onRename: () => undefined,
    onRemove: () => undefined,
  },
};

export const LiveCoachOnly: Story = {
  args: {
    operator: { ...baseOperator, id: '/workspace/Chief-of-Staff::live-only', operatorSlug: 'live-only', name: 'Live Only', roles: ['live_meeting'], consult_when: '' },
    state: { kind: 'activated', personalised: true, personalising: false },
    spaceLabel: 'Chief-of-Staff',
    onPersonalise: () => undefined,
    onOpenInstructions: () => undefined,
    onToggleLiveMeeting: () => undefined,
    onRename: () => undefined,
    onRemove: () => undefined,
    liveMeetingEnabled: true,
  },
};

export const DualRole: Story = {
  args: {
    operator: { ...baseOperator, id: '/workspace/Chief-of-Staff::dual-role', operatorSlug: 'dual-role', name: 'Dual Role', roles: ['operator', 'live_meeting'] },
    state: { kind: 'activated', personalised: true, personalising: false },
    spaceLabel: 'Chief-of-Staff',
    onPersonalise: () => undefined,
    onOpenInstructions: () => undefined,
    onToggleLiveMeeting: () => undefined,
    onRename: () => undefined,
    onDuplicate: () => undefined,
    onHistory: () => undefined,
    onRemove: () => undefined,
  },
};
