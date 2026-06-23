import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { FinishLineEditor } from './FinishLineEditor';
import { FINISH_LINE_MAX_LENGTH } from '@core/utils/finishLine';

const meta = {
  title: 'Design System/Mixed/Composer/Finish Line Editor',
  component: FinishLineEditor,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Composer-override editor for the per-conversation Finish line criterion. Cmd/Ctrl+Enter saves; Esc cancels. Persistence happens in the parent — this component only emits callbacks.',
      },
    },
  },
  tags: ['autodocs'],
} satisfies Meta<typeof FinishLineEditor>;

export default meta;

type Story = StoryObj<typeof meta>;

function StatefulPreview({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState<string | null>(initial.length > 0 ? initial : null);
  if (value === null) {
    return (
      <div style={{ display: 'grid', gap: 12, maxWidth: 520 }}>
        <span style={{ color: 'var(--color-text-secondary)' }}>
          Saved value: <em>(none — finish line cleared)</em>
        </span>
        <button type="button" onClick={() => setValue('')}>Reopen editor</button>
      </div>
    );
  }
  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 520 }}>
      <FinishLineEditor
        initialValue={value}
        onSave={(next) => setValue(next || null)}
        onCancel={() => setValue(value)}
        onClear={() => setValue(null)}
      />
      <span style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>
        Saved value: <em>{value === null ? '(cleared)' : value || '(empty)'}</em>
      </span>
    </div>
  );
}

export const Empty: Story = {
  args: {
    initialValue: '',
    onSave: () => undefined,
    onCancel: () => undefined,
    onClear: () => undefined,
  },
};

export const PreFilled: Story = {
  args: {
    initialValue: 'The brief is ready to send, with risks called out.',
    onSave: () => undefined,
    onCancel: () => undefined,
    onClear: () => undefined,
  },
};

export const AtCap: Story = {
  args: {
    initialValue: 'X'.repeat(FINISH_LINE_MAX_LENGTH),
    onSave: () => undefined,
    onCancel: () => undefined,
    onClear: () => undefined,
  },
};

export const EmptyLight: Story = {
  args: {
    initialValue: '',
    onSave: () => undefined,
    onCancel: () => undefined,
    onClear: () => undefined,
  },
  parameters: {
    backgrounds: { default: 'light' },
    themes: { themeOverride: 'light' },
  },
};

export const PreFilledLight: Story = {
  args: {
    initialValue: 'The brief is ready to send, with risks called out.',
    onSave: () => undefined,
    onCancel: () => undefined,
    onClear: () => undefined,
  },
  parameters: {
    backgrounds: { default: 'light' },
    themes: { themeOverride: 'light' },
  },
};

export const Interactive: Story = {
  render: () => <StatefulPreview initial="" />,
};

export const InteractivePreFilled: Story = {
  render: () => (
    <StatefulPreview initial="The brief is ready to send, with risks called out." />
  ),
};
