import type { Meta, StoryObj } from '@storybook/react';
import { PageHeader, SectionHeader } from '@renderer/components/ui';

const meta = {
  title: 'Design System/Molecules/Headers',
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
    docs: {
      description: {
        component:
          'Shared hierarchy components for page-level hero headers and smaller content section headers.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Gallery: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 36, padding: 24 }}>
      <PageHeader
        title="Good afternoon, Team Member"
        subtitle="Here's your check-in for today."
        meta={<span style={{ color: 'var(--color-muted-foreground)', opacity: 0.6 }}>Rebel saved you <strong>52m</strong> this week.</span>}
      />

      <section style={{ display: 'grid', gap: 12, maxWidth: 620 }}>
        <SectionHeader
          title="Needs your attention today"
          subtitle="Your meetings, action items, and automations, sorted by what matters most."
        />
        <div style={{ height: 72, borderRadius: 12, border: '1px solid rgba(148, 163, 184, 0.12)', background: 'rgba(255, 255, 255, 0.03)' }} />
      </section>
    </div>
  ),
};
