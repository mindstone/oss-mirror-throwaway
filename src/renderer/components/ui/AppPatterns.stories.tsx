import * as React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { ReactNode } from 'react';
import {
  CheckCircle2,
  Clock,
  FolderOpen,
  Home,
  Inbox,
  MessageSquare,
  Rocket,
  Settings,
  Star,
  Zap,
} from 'lucide-react';
import { LibraryLensBar } from '@renderer/features/library/components/LibraryLensBar';
import type { LibraryLens, LibrarySortOption } from '@renderer/features/library/types/lens';

const meta = {
  title: 'Design System/Molecules/Navigation Controls',
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
    docs: {
      description: {
        component:
          'Human-readable review page for Rebel navigation controls that can look tab-like while doing different jobs. Use this to keep the visual family aligned without forcing every control into the canonical `Tabs` atom.\n\n' +
          'Current source references:\n' +
          '- App shell flow chips: `src/renderer/styles/layout/app-shell.css`\n' +
          '- Content tabs: `src/renderer/components/ui/Tabs.tsx`\n' +
          '- Conversation filters: `src/renderer/features/agent-session/components/AgentSessionSidebar.tsx`',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section style={{ display: 'grid', gap: 12 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 18 }}>{title}</h2>
        <p style={{ margin: '6px 0 0', color: 'var(--color-text-secondary)', maxWidth: 840 }}>{description}</p>
      </div>
      {children}
    </section>
  );
}

function GuidanceCard({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gap: 8,
        padding: 16,
        borderRadius: 16,
        border: '1px solid rgba(255,255,255,0.08)',
        background: 'rgba(255,255,255,0.03)',
        lineHeight: 1.55,
      }}
    >
      {children}
    </div>
  );
}

function LibraryLensExample() {
  const [lens, setLens] = React.useState<LibraryLens>({ filter: 'spaces', view: 'folders' });
  const [searchQuery, setSearchQuery] = React.useState('');
  const [sortBy, setSortBy] = React.useState<LibrarySortOption>('name');
  const [tipDismissed, setTipDismissed] = React.useState(false);

  return (
    <LibraryLensBar
      lens={lens}
      searchQuery={searchQuery}
      sortBy={sortBy}
      setBrowseLens={(next) => {
        setLens((previous) => (typeof next === 'function' ? next(previous) : next));
      }}
      onSearchQueryChange={setSearchQuery}
      onSortByChange={setSortBy}
      orientationTipDismissed={tipDismissed}
      dismissOrientationTip={() => setTipDismissed(true)}
    />
  );
}

const NAVIGATION_CONTROL_FAMILIES = [
  {
    name: 'Content tabs',
    job: 'Switch between related content panels inside one surface.',
    story: 'Design System/Atoms/Tabs',
    direction: 'Use the shared `Tabs` atom.',
  },
  {
    name: 'App shell flow chips',
    job: 'Move between major app areas such as Home, Conversations, Actions, and Library.',
    story: 'This page',
    direction:
      'Keep separate semantics, but align active, hover, badge, spacing, and radius with the broader navigation-control family.',
  },
  {
    name: 'Filter controls',
    job: 'Narrow a list by state, time, scope, or ownership without leaving the current surface.',
    story: 'Still local',
    direction: 'Treat as a segmented-control molecule candidate before promoting to a shared component.',
  },
  {
    name: 'Session shortcuts',
    job: 'Help users move through conversation-specific state and shortcuts.',
    story: 'Still local',
    direction: 'Review beside the family so density and active state feel related, not copied blindly.',
  },
] as const;

export const Gallery: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 28, padding: 24 }}>
      <section style={{ display: 'grid', gap: 8 }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Navigation Controls</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', maxWidth: 820, lineHeight: 1.55 }}>
          App navigation, content tabs, and filters should feel like one Rebel family even when
          their behavior differs. The design goal is visual alignment, not one overloaded `Tabs` API.
        </p>
      </section>

      <Section
        title="Family rule"
        description="Use this rule when deciding whether a control belongs in the shared `Tabs` atom or needs a separate navigation/filter pattern."
      >
        <GuidanceCard>
          <div><strong>Same visual family</strong> - radius, active fill, text/icon scale, badge treatment, hover, focus, and density should feel related.</div>
          <div><strong>Different semantics</strong> - content switching, app navigation, list filtering, and session shortcuts should keep their own names and behavior until one contract truly fits.</div>
          <div><strong>Storybook expectation</strong> - put canonical shared content tabs under `Atoms / Tabs`; put app navigation and filter realities here for comparison.</div>
        </GuidanceCard>
      </Section>

      <Section
        title="App shell flow chips"
        description="These are the top navigation tabs used in the real app shell. They are not the same component as `ui/Tabs`, but they should visually rhyme with the rest of the navigation-control family."
      >
        <div
          role="tablist"
          className="flow-segment-control"
          style={{
            display: 'inline-flex',
            width: 'fit-content',
            maxWidth: '100%',
            flexWrap: 'wrap',
          }}
        >
          <div
            className="flow-tab-indicator"
            style={{ width: 72, transform: 'translateX(8px)', opacity: 1 }}
            aria-hidden="true"
          />
          <button type="button" role="tab" aria-selected="true" className="flow-chip active">
            <Home size={12} /> Home
          </button>
          <button type="button" role="tab" aria-selected="false" className="flow-chip">
            <MessageSquare size={12} /> Conversations
          </button>
          <button type="button" role="tab" aria-selected="false" className="flow-chip">
            <Inbox size={12} /> Actions <span className="flow-chip__badge">17</span>
          </button>
          <button type="button" role="tab" aria-selected="false" className="flow-chip">
            <Zap size={12} /> Automations
          </button>
          <button type="button" role="tab" aria-selected="false" className="flow-chip">
            <Rocket size={12} /> The Spark
          </button>
          <button type="button" role="tab" aria-selected="false" className="flow-chip">
            <FolderOpen size={12} /> Library
          </button>
          <button type="button" role="tab" aria-selected="false" className="flow-chip flow-chip--dimmed">
            <Settings size={12} /> Settings
          </button>
        </div>
      </Section>

      <Section
        title="Filter examples to compare"
        description="These are illustrative examples for Storybook review, not a new shared implementation. They help reviewers compare density and active-state language with app-shell flow chips."
      >
        <div style={{ display: 'grid', gap: 10 }}>
          <div
            style={{
              justifySelf: 'start',
              padding: '4px 10px',
              borderRadius: 999,
              background: 'rgba(148,163,184,0.14)',
              color: 'var(--color-text-secondary)',
              fontSize: 12,
            }}
          >
            App-pattern example, not a shared component yet
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" className="flow-chip active">
              <Clock size={12} /> Active
            </button>
            <button type="button" className="flow-chip">
              <Star size={12} /> Starred
            </button>
            <button type="button" className="flow-chip">
              <CheckCircle2 size={12} /> Done
            </button>
            <button type="button" className="flow-chip">
              All <span className="flow-chip__badge">42</span>
            </button>
          </div>
        </div>
      </Section>

      <Section
        title="Library lens bar example"
        description="Production molecule used in Library. Keep this side-by-side with app-shell chips when reviewing navigation-control rhythm."
      >
        <LibraryLensExample />
      </Section>

      <Section
        title="How to read this family"
        description="A tidy design-system browser should help people understand where to look first and what not to over-standardize."
      >
        <div style={{ display: 'grid', gap: 10, maxWidth: 960 }}>
          {NAVIGATION_CONTROL_FAMILIES.map((family) => (
            <GuidanceCard key={family.name}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <strong>{family.name}</strong>
                <span style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>{family.story}</span>
              </div>
              <div style={{ color: 'var(--color-text-secondary)' }}>{family.job}</div>
              <div>{family.direction}</div>
            </GuidanceCard>
          ))}
        </div>
      </Section>
    </div>
  ),
};
