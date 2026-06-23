import type { Meta, StoryObj } from '@storybook/react';
import type { OperatorMetadata } from '@shared/ipc/channels/operators';
import { OperatorDiaryViewer } from './OperatorDiaryViewer';

const operator: OperatorMetadata = {
  id: '/workspace/Chief-of-Staff::customer-voice',
  operatorSlug: 'customer-voice',
  spacePath: '/workspace/Chief-of-Staff',
  sourceSpacePath: '/workspace/Chief-of-Staff',
  category: 'space',
  name: 'Customer Voice',
  description: 'Keeps the work anchored in what customers actually said.',
  consult_when: 'When a decision needs user-language evidence.',
  kind: 'operator',
  roles: ['operator'],
  operatorFileAbsolutePath: '/workspace/Chief-of-Staff/operators/customer-voice/OPERATOR.md',
  groundingPath: '/workspace/Chief-of-Staff/operators/customer-voice/grounding.md',
  diaryPath: '/workspace/Chief-of-Staff/operators/customer-voice/diary.md',
};

const meta = {
  title: 'Operators/Operator Diary Viewer',
  component: OperatorDiaryViewer,
  parameters: { layout: 'centered' },
  args: {
    operator,
    initialDiary: [
      '## 2026-05-25',
      'Asked Customer Voice about onboarding language. Answer: users understand "setup", not "calibration".',
      '',
      '## 2026-05-24',
      'Asked Customer Voice whether the launch note sounded useful. It sounded like a brochure. Excellent news.',
    ].join('\n'),
  },
  decorators: [
    (Story) => (
      <div style={{ width: 640 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof OperatorDiaryViewer>;

export default meta;

type Story = StoryObj<typeof meta>;

export const WithEntries: Story = {};

export const Empty: Story = {
  args: { initialDiary: '' },
};
