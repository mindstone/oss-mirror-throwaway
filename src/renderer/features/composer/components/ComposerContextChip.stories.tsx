import type { Meta, StoryObj } from '@storybook/react';
import { ComposerContextChip } from './ComposerContextChip';

const meta = {
  title: 'Design System/Mixed/Chips & Pills/Composer Context Chip',
  component: ComposerContextChip,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof ComposerContextChip>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ChiefDesigner: Story = {
  args: {
    label: '@CHIEF_DESIGNER',
    kind: 'mode',
    onRemove: () => undefined,
  },
};

export const FolderContext: Story = {
  args: {
    label: 'design-system',
    kind: 'directory',
    onRemove: () => undefined,
  },
};

export const FinishLine: Story = {
  args: {
    label: 'The brief is ready to send, with risks called…',
    kind: 'finishLine',
    onRemove: () => undefined,
    ariaLabel: 'Finish line: The brief is ready to send, with risks called out.',
    title: 'Rebel stops when this is met.\nThe brief is ready to send, with risks called out.',
  },
};

export const FinishLineLight: Story = {
  args: {
    label: 'The brief is ready to send, with risks called…',
    kind: 'finishLine',
    onRemove: () => undefined,
    ariaLabel: 'Finish line: The brief is ready to send, with risks called out.',
    title: 'Rebel stops when this is met.\nThe brief is ready to send, with risks called out.',
  },
  parameters: {
    backgrounds: { default: 'light' },
    themes: { themeOverride: 'light' },
  },
};

export const Operator: Story = {
  args: {
    label: 'Skeptical Engineer',
    kind: 'mode',
    onRemove: () => undefined,
  },
};

export const MissingOperator: Story = {
  args: {
    label: 'Operator not found in this Space',
    kind: 'mode',
    onRemove: () => undefined,
    title: 'This Operator is no longer available',
  },
};

export const MultipleExamples: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: 16, background: 'var(--color-card)' }}>
      <ComposerContextChip label="@CHIEF_DESIGNER" kind="mode" onRemove={() => undefined} />
      <ComposerContextChip label="design-system" kind="directory" onRemove={() => undefined} />
      <ComposerContextChip label="brief.md" kind="file" onRemove={() => undefined} />
      <ComposerContextChip label="Friday Pulse feedback" kind="conversation" onRemove={() => undefined} />
      <ComposerContextChip label="Skeptical Engineer" kind="mode" onRemove={() => undefined} />
      <ComposerContextChip
        label="Brief ready to send…"
        kind="finishLine"
        onRemove={() => undefined}
        ariaLabel="Finish line: Brief ready to send."
        title="Rebel stops when this is met."
      />
    </div>
  ),
};
