import * as React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import {
  BarChart3,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Inbox,
  X,
  Zap,
} from 'lucide-react';
import {
  Button,
  ConversationPill,
  IconTile,
  PageHeader,
  SectionHeader,
} from '@renderer/components/ui';

const meta = {
  title: 'Design System/Organisms/Dashboard Patterns',
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
    docs: {
      description: {
        component:
          'Repeated app pattern, not yet shared. This page reviews homepage/dashboard organisms and the component boundaries around them: attention cards, coach carousel, recent conversation strip, and stat pills.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function ReviewBadge({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        width: 'fit-content',
        padding: '4px 10px',
        borderRadius: 999,
        background: 'rgba(148, 163, 184, 0.14)',
        color: 'var(--color-text-secondary)',
        fontSize: 12,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
      }}
    >
      {children}
    </span>
  );
}

function DemoAttentionCard({
  tone,
  title,
  meta,
  cta,
}: {
  tone: 'meeting' | 'inbox' | 'automation' | 'focus';
  title: string;
  meta: string;
  cta: string;
}) {
  const icon = tone === 'meeting' ? Calendar : tone === 'automation' ? Zap : tone === 'focus' ? BarChart3 : Inbox;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 14px',
        borderRadius: 10,
        background: 'rgba(255, 255, 255, 0.03)',
        border: '1px solid rgba(148, 163, 184, 0.08)',
      }}
    >
      <IconTile icon={icon} tone={tone} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: '0.85rem', fontWeight: 500, color: 'rgba(248, 250, 255, 0.92)' }}>
          {title}
        </p>
        <p style={{ margin: '2px 0 0', fontSize: '0.75rem', fontWeight: 500, color: 'rgba(148, 163, 184, 0.8)' }}>
          {meta}
        </p>
      </div>
      <Button variant="secondary" size="xs">
        {cta}
      </Button>
    </div>
  );
}

function DemoRecentConversationStrip() {
  const titles = [
    'New Agent Plan',
    'Secondary actions button logic',
    'Friday Pulso feedback session',
    'Claude design workflow',
    'Sprint inbox cleanup',
  ];

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflowX: 'auto', maxWidth: 640 }}>
      {titles.map((title) => (
        <ConversationPill key={title} title={title} onClick={() => undefined} />
      ))}
      <Button variant="ghost" size="sm" style={{ marginLeft: 'auto', flexShrink: 0, paddingInline: 0 }}>
        View conversation history
      </Button>
    </div>
  );
}

function DemoStatPill() {
  return (
    <span style={{ color: 'var(--color-muted-foreground)', opacity: 0.72, fontSize: '0.875rem' }}>
      Rebel saved you
      <button
        type="button"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 3,
          margin: '0 3px',
          padding: '1px 7px',
          borderRadius: 999,
          border: '1px solid rgba(99, 102, 241, 0.5)',
          background: 'rgba(99, 102, 241, 0.18)',
          color: '#a5b4fc',
          fontSize: '0.75rem',
          fontWeight: 600,
          lineHeight: 1.4,
          cursor: 'pointer',
        }}
      >
        <Clock3 size={10} />
        52m
      </button>
      this week
    </span>
  );
}

function DemoCoachCarousel() {
  const [index, setIndex] = React.useState(0);
  const cards = [
    {
      title: "Rebel's take on your priorities",
      body: 'Rebel reads through your recent conversations, meetings, and goals to build a short, prioritized list of what deserves your attention right now.',
      action: 'Run once',
    },
    {
      title: 'Automate a recurring task',
      body: 'If you find yourself doing the same thing every Monday, Rebel can probably handle it. Tell me what is repetitive.',
      action: 'Try this',
    },
    {
      title: 'Prep your next meeting',
      body: 'Turn recent context into a short briefing before the meeting starts. Useful, and only slightly smug about it.',
      action: 'Prep',
    },
  ];
  const current = cards[index];

  return (
    <div
      style={{
        width: 300,
        display: 'grid',
        gap: 12,
        padding: 14,
        borderRadius: 14,
        background: 'rgba(255,255,255,0.025)',
        border: '1px solid rgba(148, 163, 184, 0.08)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <div>
          <p style={{ margin: 0, fontSize: '0.9rem', fontWeight: 600 }}>Coach carousel</p>
          <p style={{ margin: '4px 0 0', color: 'rgba(148, 163, 184, 0.82)', fontSize: '0.78rem' }}>
            Organism candidate: card, nav, feedback, and CTA hierarchy.
          </p>
        </div>
        <button type="button" aria-label="Not now" style={{ background: 'transparent', border: 0, color: 'rgba(148,163,184,0.45)', cursor: 'pointer' }}>
          <X size={14} />
        </button>
      </div>

      <div
        style={{
          minHeight: 156,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: '14px 16px',
          borderRadius: 10,
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(148, 163, 184, 0.08)',
        }}
      >
        <p style={{ margin: 0, fontSize: '0.85rem', fontWeight: 600 }}>{current.title}</p>
        <p style={{ margin: 0, color: 'rgba(148,163,184,0.82)', fontSize: '0.78rem', lineHeight: 1.65 }}>
          {current.body}
        </p>
        <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <Button variant="ghost" size="sm" style={{ color: 'rgba(148, 163, 184, 0.58)', background: 'transparent', border: 0 }}>
            Run daily
          </Button>
          <Button variant="secondary" size="sm">
            {current.action} <ChevronRight size={14} />
          </Button>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
        <button
          type="button"
          aria-label="Previous card"
          onClick={() => setIndex((index + cards.length - 1) % cards.length)}
          style={{ background: 'transparent', border: 0, color: 'rgba(148,163,184,0.55)', cursor: 'pointer', padding: 4 }}
        >
          <ChevronLeft size={14} />
        </button>
        <div role="tablist" aria-label="Carousel navigation" style={{ display: 'flex', gap: 5 }}>
          {cards.map((card, i) => (
            <button
              key={card.title}
              type="button"
              role="tab"
              aria-selected={i === index}
              aria-label={`Card ${i + 1}`}
              onClick={() => setIndex(i)}
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                border: 0,
                padding: 0,
                cursor: 'pointer',
                background: i === index ? 'rgba(129, 140, 248, 0.8)' : 'rgba(148, 163, 184, 0.2)',
                transform: i === index ? 'scale(1.3)' : undefined,
              }}
            />
          ))}
        </div>
        <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
          {index + 1} of {cards.length}
        </span>
        <button
          type="button"
          aria-label="Next card"
          onClick={() => setIndex((index + 1) % cards.length)}
          style={{ background: 'transparent', border: 0, color: 'rgba(148,163,184,0.55)', cursor: 'pointer', padding: 4 }}
        >
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

export const Gallery: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 32, padding: 24 }}>
      <section style={{ display: 'grid', gap: 10 }}>
        <ReviewBadge>Repeated app pattern</ReviewBadge>
        <h1 style={{ margin: 0, fontSize: 32, lineHeight: 1.2 }}>Dashboard Patterns</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', lineHeight: 1.55, maxWidth: 860 }}>
          A review surface for homepage/dashboard components that are now partly composed from shared atoms and molecules,
          but should not be promoted into generic primitives yet.
        </p>
      </section>

      <section style={{ display: 'grid', gap: 16, maxWidth: 760 }}>
        <PageHeader
          title="Good afternoon, Team Member"
          subtitle="Here's your check-in for today."
          meta={<DemoStatPill />}
        />
        <DemoRecentConversationStrip />
      </section>

      <section style={{ display: 'grid', gap: 14, maxWidth: 640 }}>
        <SectionHeader
          title="Needs your attention today"
          subtitle="Your meetings, action items, and automations, sorted by what matters most."
        />
        <DemoAttentionCard tone="automation" title="Daily stand-up auto-post" meta="Ran successfully" cta="Review" />
        <DemoAttentionCard tone="inbox" title="Respond to Kofi in Slack about Claude Design" meta="Review the suggested response and send it when ready." cta="Review" />
        <DemoAttentionCard tone="focus" title="You have 5 meetings today" meta="Plan your week around what actually matters." cta="See my week" />
      </section>

      <section style={{ display: 'grid', gap: 14 }}>
        <DemoCoachCarousel />
      </section>

      <section
        style={{
          display: 'grid',
          gap: 8,
          padding: 16,
          borderRadius: 16,
          border: '1px solid rgba(255,255,255,0.08)',
          background: 'rgba(255,255,255,0.03)',
          lineHeight: 1.55,
          color: 'var(--color-text-secondary)',
          maxWidth: 900,
        }}
      >
        <div style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>Review contract</div>
        <div>Shared now: `Button.secondary`, `IconTile`, `ConversationPill`, `PageHeader`, and `SectionHeader`.</div>
        <div>Still app-patterns: `AttentionCard`, `RecentConversationStrip`, `StatPill`, and `CoachCarousel`.</div>
        <div>Still local: dismiss/settings/thumb/carousel micro-controls until a tiny embedded-control family is justified.</div>
        <div>Carousel review belongs with `CoachCarousel` first; only split out pagination/arrows once another surface needs the same mechanism.</div>
      </section>
    </div>
  ),
};

export const HomeActivationStates: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 24, padding: 24, maxWidth: 820 }}>
      <section style={{ display: 'grid', gap: 8 }}>
        <ReviewBadge>Today attention card</ReviewBadge>
        <h1 style={{ margin: 0, fontSize: 28, lineHeight: 1.2 }}>Home activation cards</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', lineHeight: 1.55, maxWidth: 720 }}>
          Persistent but non-blocking onboarding activation. It is intentionally not dismissible.
        </p>
      </section>

      <DemoAttentionCard tone="inbox" title="Tell Rebel what matters" meta="A short intro helps Rebel prioritise suggestions around your work. You can keep using everything else meanwhile." cta="Start" />
      <DemoAttentionCard tone="inbox" title="Continue your intro with Rebel" meta="A short intro helps Rebel prioritise suggestions around your work. You can keep using everything else meanwhile." cta="Continue" />
    </div>
  ),
};
