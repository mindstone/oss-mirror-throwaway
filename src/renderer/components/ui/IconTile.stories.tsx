import type { Meta, StoryObj } from '@storybook/react';
import { Calendar, Inbox, Zap, Users, Plug, BarChart3, MessageCircle, CheckCircle2, AlertTriangle } from 'lucide-react';
import { IconTile, type IconTileTone } from '@renderer/components/ui';

const meta = {
  title: 'Design System/Atoms/Icon Tile',
  component: IconTile,
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
    docs: {
      description: {
        component:
          '`IconTile` is the non-interactive square category marker used in cards and dashboard rows. Use `IconButton` for clickable icon-only controls.',
      },
    },
  },
} satisfies Meta<typeof IconTile>;

export default meta;
type Story = StoryObj<typeof meta>;

const examples: Array<{ tone: IconTileTone; label: string; icon: typeof Calendar }> = [
  { tone: 'neutral', label: 'Neutral', icon: Calendar },
  { tone: 'meeting', label: 'Meeting', icon: Calendar },
  { tone: 'inbox', label: 'Inbox', icon: Inbox },
  { tone: 'automation', label: 'Automation', icon: Zap },
  { tone: 'role', label: 'Role', icon: Users },
  { tone: 'connector', label: 'Connector', icon: Plug },
  { tone: 'focus', label: 'Focus', icon: BarChart3 },
  { tone: 'onboarding', label: 'Onboarding', icon: MessageCircle },
  { tone: 'success', label: 'Success', icon: CheckCircle2 },
  { tone: 'warning', label: 'Warning', icon: AlertTriangle },
];

export const Gallery: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 28, padding: 24 }}>
      <section style={{ display: 'grid', gap: 8 }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Icon Tile</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', maxWidth: 760 }}>
          A category marker atom for cards, rows, and dashboard summaries. It carries type and tone,
          not click behaviour.
        </p>
      </section>

      <section style={{ display: 'grid', gap: 14 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Tones</h2>
        {[
          { label: 'Dark card surface', background: 'rgba(13, 17, 28, 0.95)', border: 'rgba(148, 163, 184, 0.14)' },
          { label: 'Light card surface', background: 'rgba(255, 255, 255, 0.88)', border: 'rgba(148, 163, 184, 0.22)' },
        ].map((surface) => (
          <div
            key={surface.label}
            style={{
              display: 'grid',
              gap: 12,
              padding: 16,
              borderRadius: 18,
              border: `1px solid ${surface.border}`,
              background: surface.background,
            }}
          >
            <h3 style={{ margin: 0, fontSize: 13, color: 'var(--color-text-secondary)' }}>{surface.label}</h3>
            <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
              {examples.map(({ tone, label, icon }) => (
                <div key={`${surface.label}-${tone}`} style={{ display: 'grid', gap: 8, justifyItems: 'center', color: 'var(--color-text-secondary)', fontSize: 12 }}>
                  <IconTile tone={tone} icon={icon} />
                  <span>{label}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section style={{ display: 'grid', gap: 14 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Sizes</h2>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <IconTile size="sm" tone="meeting" icon={Calendar} />
          <IconTile size="md" tone="meeting" icon={Calendar} />
          <IconTile size="lg" tone="meeting" icon={Calendar} />
        </div>
      </section>
    </div>
  ),
};
