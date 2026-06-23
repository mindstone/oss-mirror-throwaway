import type { Meta, StoryObj } from '@storybook/react';
import { Button, ConversationPill } from '@renderer/components/ui';

const meta = {
  title: 'Design System/Molecules/Conversation Pill',
  component: ConversationPill,
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
    docs: {
      description: {
        component:
          '`ConversationPill` is the compact recent-conversation shortcut used below prompt entry points. It is a product molecule, not a generic badge.',
      },
    },
  },
} satisfies Meta<typeof ConversationPill>;

export default meta;
type Story = StoryObj<typeof meta>;

const titles = [
  'New Agent Plan',
  'Secondary actions button logic',
  'Friday Pulso feedback session',
  'A much longer conversation title that should truncate gracefully',
];

export const Gallery: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 24, padding: 24 }}>
      <section style={{ display: 'grid', gap: 8 }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Conversation Pill</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', maxWidth: 760 }}>
          A small, low-emphasis shortcut for returning to recent conversations without making them feel
          like primary actions.
        </p>
      </section>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {titles.map((title) => (
          <ConversationPill key={title} title={title} onClick={() => undefined} />
        ))}
      </div>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Homepage row shape</h2>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            overflowX: 'auto',
            maxWidth: 620,
            paddingBottom: 4,
          }}
        >
          {[
            ...titles,
            'Quarterly planning notes',
          ].map((title) => (
            <ConversationPill key={title} title={title} onClick={() => undefined} />
          ))}
          <Button variant="ghost" size="sm" style={{ marginLeft: 'auto', flexShrink: 0, paddingInline: 0 }}>
            View conversation history
          </Button>
        </div>
      </section>
    </div>
  ),
};
