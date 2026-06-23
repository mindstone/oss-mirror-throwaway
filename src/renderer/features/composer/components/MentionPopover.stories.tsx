import type { Meta, StoryObj } from '@storybook/react';
import type { MentionState } from '../hooks';
import { MentionPopover } from './MentionPopover';

const baseMentionState: MentionState = {
  active: true,
  startIndex: 0,
  endIndex: 1,
  rawQuery: '',
  query: '',
  filter: 'all',
  hasExplicitPrefix: false,
  results: [],
  selectedIndex: 0,
};

const meta = {
  title: 'Composer/Mention Popover',
  component: MentionPopover,
  parameters: {
    layout: 'centered',
  },
  args: {
    isTextMode: true,
    mentionState: baseMentionState,
    coreDirectory: '/workspace',
    libraryIndex: [],
    libraryIndexLoading: false,
    libraryIndexError: null,
    getRelativeLibraryPath: (path: string) => path,
    refreshLibraryIndex: async () => undefined,
    insertMentionResult: () => undefined,
    setSelectedIndex: () => undefined,
    hasConversations: false,
    showModelsTab: true,
    hasOperators: false,
    onOpenOperatorsPanel: () => undefined,
  },
  decorators: [
    (Story) => (
      <div style={{ position: 'relative', width: 520, height: 320 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MentionPopover>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ZeroOperators: Story = {};

export const WithOperators: Story = {
  args: {
    hasOperators: true,
    mentionState: {
      ...baseMentionState,
      results: [
        {
          kind: 'operator',
          operatorId: '/workspace/Chief-of-Staff::skeptical-engineer',
          operatorSlug: 'skeptical-engineer',
          operatorName: 'Skeptical Engineer',
          description: 'Stress-tests the plan.',
          consultWhen: 'When the plan needs pressure.',
          score: 0,
          matches: [[0, 9]],
        },
        {
          kind: 'operator',
          operatorId: '/workspace/Chief-of-Staff::brand-critic',
          operatorSlug: 'brand-critic',
          operatorName: 'Brand Critic',
          description: 'Keeps the message honest.',
          consultWhen: 'When the copy is getting too pleased with itself.',
          score: 1,
          matches: [[0, 5]],
        },
      ],
    },
  },
};
