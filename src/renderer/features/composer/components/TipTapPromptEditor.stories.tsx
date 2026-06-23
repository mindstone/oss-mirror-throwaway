import { useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { TipTapPromptEditor, type TipTapPromptEditorHandle } from './TipTapPromptEditor';

const meta = {
  title: 'Design System/Mixed/Composer/TipTap Prompt Editor',
  component: TipTapPromptEditor,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof TipTapPromptEditor>;

export default meta;

type Story = StoryObj<typeof meta>;

function ControlledEditor({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<TipTapPromptEditorHandle>(null);
  return (
    <div
      style={{
        // Mirror the standalone composer's input shell so the chip + textarea geometry matches
        // the real surface — Storybook reviewers should see what the user sees in the app.
        border: '1px solid rgba(148, 163, 184, 0.2)',
        borderRadius: 12,
        background: 'rgba(13, 17, 28, 0.9)',
        padding: '12px 14px',
        boxShadow: '0 4px 12px rgba(2, 6, 23, 0.15)',
        minHeight: 44,
        maxWidth: 720,
      }}
    >
      <TipTapPromptEditor ref={ref} value={value} onChange={(next) => setValue(next)} />
    </div>
  );
}

export const Empty: Story = {
  render: () => <ControlledEditor initial="" />,
};

export const ChiefDesignerChipMidParagraph: Story = {
  render: () => (
    <ControlledEditor initial="Please ask @CHIEF_DESIGNER to review the new context chip and tell me what they think." />
  ),
};

export const TwoChipsInOneParagraph: Story = {
  render: () => (
    <ControlledEditor initial="hi @CHIEF_DESIGNER and @designContext — should this row stay calm?" />
  ),
};

export const ChipOnSecondLine: Story = {
  render: () => (
    <ControlledEditor
      initial={'first line of the prompt with no chips\nthen on this line: @CHIEF_DESIGNER look here'}
    />
  ),
};
