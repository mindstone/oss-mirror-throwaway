// @ts-nocheck
import * as React from 'react';
import {
  Bell,
  CloudOff,
  Info,
  Mic,
  MoreVertical,
  Paperclip,
  RefreshCw,
  Search,
  Star,
  X,
} from 'lucide-react';
import { IconButton } from '@renderer/components/ui';

const meta = {
  title: 'Design System/Atoms/Buttons/Icon Button',
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
    docs: {
      description: {
        component:
          'Shared `IconButton` atom plus the host contexts where it ships in Rebel. Each Reality row shows the atom rendered the way the production surface uses it, so size/variant choices stay tied to the host instead of drifting.',
      },
    },
  },
};

export default meta;

const SECTION_HEADING = {
  margin: 0,
  fontSize: 12,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--color-text-secondary)',
};

function Section({ title, description, children }) {
  return (
    <section style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'grid', gap: 6 }}>
        <h2 style={SECTION_HEADING}>{title}</h2>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', lineHeight: 1.55, maxWidth: 860 }}>
          {description}
        </p>
      </div>
      {children}
    </section>
  );
}

function ComposerHost({ children }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        padding: 0,
        borderRadius: 16,
        border: '1px solid rgba(148, 163, 184, 0.15)',
        background: 'rgba(13, 17, 28, 0.95)',
        boxShadow:
          '0 8px 32px rgba(2, 6, 23, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.04)',
        minHeight: 64,
        maxWidth: 640,
      }}
    >
      {children}
    </div>
  );
}

function ComposerRow() {
  return (
    <ComposerHost>
      <IconButton size="lg" variant="ghost" aria-label="Voice" style={{ marginLeft: 12 }}>
        <Mic size={18} />
      </IconButton>
      <div
        style={{
          flex: 1,
          padding: '20px 12px',
          color: 'rgba(148, 163, 184, 0.5)',
          fontSize: '1rem',
        }}
      >
        Tell me what you need...
      </div>
      <IconButton size="lg" variant="ghost" aria-label="Attach file" style={{ marginRight: 4 }}>
        <Paperclip size={18} />
      </IconButton>
      <div
        style={{
          width: 56,
          height: 56,
          margin: 4,
          borderRadius: 12,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background:
            'linear-gradient(135deg, rgba(139, 92, 246, 0.9) 0%, rgba(99, 102, 241, 0.9) 100%)',
          color: 'white',
        }}
        aria-hidden
      >
        →
      </div>
    </ComposerHost>
  );
}

function ShelfHost({ children }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 14px',
        borderRadius: 14,
        border: '1px solid rgba(148, 163, 184, 0.12)',
        background: 'rgba(15, 23, 42, 0.55)',
        maxWidth: 460,
      }}
    >
      {children}
    </div>
  );
}

function ShelfRow() {
  const [infoOpen, setInfoOpen] = React.useState(true);
  return (
    <ShelfHost>
      <span
        style={{
          flex: 1,
          fontSize: 13,
          color: 'var(--color-text-secondary)',
        }}
      >
        Library · 1,284 files indexed
      </span>
      <IconButton variant="ghost" size="lg" aria-label="Refresh">
        <RefreshCw size={18} />
      </IconButton>
      <IconButton
        variant="ghost"
        size="lg"
        active={infoOpen}
        onClick={() => setInfoOpen((v) => !v)}
        aria-pressed={infoOpen}
        aria-label="Toggle library info"
      >
        <Info size={18} />
      </IconButton>
    </ShelfHost>
  );
}

const LIST_ROW_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '10px 14px',
  borderRadius: 12,
  background: 'rgba(15, 23, 42, 0.65)',
  border: '1px solid rgba(148, 163, 184, 0.08)',
  maxWidth: 460,
  cursor: 'pointer',
  transition: 'background var(--motion-duration-fast, 120ms) ease',
};

/**
 * Sidebar list-row actions are a denser variant of the ghost atom owned by
 * AgentSessionSidebar.module.css `.actionButton`: 24x24 (vs the atom's 28-px xs),
 * neutral-white icon colour, and indigo (not lavender) hover. The row-lift
 * transform belongs to the parent list row, not the button.
 *
 * This story mirrors that production override inline so the demo matches what
 * ships, instead of the cleaner aspirational atom default.
 */
function SidebarRow() {
  return (
    <div className="rebel-storybook-list-row" style={LIST_ROW_STYLE}>
      <style>{`
        .rebel-storybook-list-row:hover {
          background: rgba(99, 102, 241, 0.08);
        }
        .rebel-storybook-list-row .rebel-storybook-list-action {
          width: 24px;
          height: 24px;
          min-width: 24px;
          border-radius: 6px;
          color: rgba(226, 232, 240, 0.92);
          opacity: 1;
          background: transparent;
          border-color: transparent;
          transition: color 0.18s ease, background 0.18s ease,
            transform 0.18s ease, opacity 0.18s ease;
        }
        .rebel-storybook-list-row .rebel-storybook-list-action:hover {
          background: rgba(99, 102, 241, 0.12);
          color: rgba(241, 245, 249, 1);
        }
        .rebel-storybook-list-row:hover .rebel-storybook-list-action,
        .rebel-storybook-list-row:focus-within .rebel-storybook-list-action {
          transform: translateY(-2px);
        }
      `}</style>
      <span style={{ flex: 1, fontSize: 13, color: 'var(--color-text-primary)' }}>
        Quarterly review prep
      </span>
      <div style={{ display: 'flex', gap: 4 }}>
        <IconButton
          size="xs"
          variant="ghost"
          className="rebel-storybook-list-action"
          aria-label="Star session"
        >
          <Star size={16} />
        </IconButton>
        <IconButton
          size="xs"
          variant="ghost"
          className="rebel-storybook-list-action"
          aria-label="Keep in cloud"
        >
          <CloudOff size={16} />
        </IconButton>
        <IconButton
          size="xs"
          variant="ghost"
          className="rebel-storybook-list-action"
          aria-label="More actions"
        >
          <MoreVertical size={16} />
        </IconButton>
      </div>
    </div>
  );
}

export const CurrentReality = {
  render: () => (
    <div style={{ display: 'grid', gap: 28, padding: '32px 24px', maxWidth: 1040 }}>
      <section style={{ display: 'grid', gap: 10 }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            alignSelf: 'start',
            padding: '4px 10px',
            borderRadius: 999,
            background: 'rgba(148,163,184,0.14)',
            color: 'var(--color-text-secondary)',
            fontSize: 12,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          Shared atom
        </div>
        <h1 style={{ margin: 0, fontSize: 32, lineHeight: 1.2 }}>Icon Button</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', lineHeight: 1.55, maxWidth: 760 }}>
          One atom, three host contexts. The shared <code>IconButton</code> covers the toolbar/top-bar,
          composer, library shelf, and sidebar list actions; the realities below show the host context
          (textarea, shelf, list row) that drives the variant and size choice — not separate visual systems.
        </p>
      </section>

      <Section
        title="Shared atom baseline"
        description={'Use this as the atom-level baseline. `framed` (default) is the grey-stroked square used in the top bar. `ghost` drops the resting fill and border for embedded contexts. Hover gets a lavender tint in both variants; the `active` flag handles toggled/pressed state.'}
      >
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <IconButton size="xs" aria-label="Close">
            <X size={14} />
          </IconButton>
          <IconButton size="sm" aria-label="Search">
            <Search size={16} />
          </IconButton>
          <IconButton size="md" aria-label="Attach file">
            <Paperclip size={18} />
          </IconButton>
          <IconButton size="lg" active aria-label="Notifications on">
            <Bell size={16} />
          </IconButton>
          <IconButton size="lg" variant="ghost" aria-label="Refresh">
            <RefreshCw size={18} />
          </IconButton>
          <IconButton size="lg" variant="subtle" aria-label="Refresh subtle">
            <RefreshCw size={18} />
          </IconButton>
        </div>
      </Section>

      <Section
        title="What belongs in this family"
        description="Square or near-square icon-only actions that stay visually quiet by default and become clearer on hover, focus, or active state."
      >
        <div
          style={{
            padding: 16,
            borderRadius: 16,
            border: '1px solid rgba(255,255,255,0.08)',
            background: 'rgba(255,255,255,0.03)',
            display: 'grid',
            gap: 10,
            lineHeight: 1.55,
          }}
        >
          <div>Good fit: utility controls, toolbar actions, inline card/list actions, compact toggles.</div>
          <div style={{ color: 'var(--color-text-secondary)' }}>
            Not a fit: primary CTAs, icon + text buttons, segmented choices, or the composer submit arrow.
          </div>
        </div>
      </Section>

      <Section
        title="Reality 1 — composer (textarea host)"
        description={'Inside the hero/composer input, icon buttons share a flex row with the textarea and submit. They use `variant="ghost"` (no resting fill or border so they don\'t compete with the caret) at `size="lg"` to match the 64-px input strip.'}
      >
        <ComposerRow />
      </Section>

      <Section
        title="Reality 2 — library command shelf"
        description={'The shelf hosts utility controls next to a label. Same `variant="ghost"` keeps them quiet against the shelf fill; `active` carries the toggled state for the Library info panel without inventing a separate pressed style.'}
      >
        <ShelfRow />
      </Section>

      <Section
        title="Reality 3 — sidebar list actions (list-row variant)"
        description={'Session-list actions are a denser, list-row app-pattern on top of the atom: the atom is still `variant="ghost"`, but the row owns 24-px sizing (not the atom\'s 28-px xs), neutral-white icon colour, and an indigo hover (kept distinct from the atom\'s lavender so the row\'s own hover gradient stays the dominant signal). The row-lift transform on hover/focus belongs to the list row, not the button. Hover the row to see the lift.'}
      >
        <SidebarRow />
      </Section>

      <Section
        title="Open questions"
        description="Use this page to spot drift before it ships."
      >
        <div
          style={{
            padding: 16,
            borderRadius: 16,
            border: '1px solid rgba(255,255,255,0.08)',
            background: 'rgba(255,255,255,0.03)',
            display: 'grid',
            gap: 8,
            lineHeight: 1.55,
            color: 'var(--color-text-secondary)',
          }}
        >
          <div>Are there surfaces still rendering raw `&lt;button&gt;` icon controls outside the atom?</div>
          <div>Does any host need a tighter resting state than `ghost` (e.g. fully invisible until hovered)? Surface it as a system gap, don&apos;t fork the atom.</div>
          <div>Dense-row variant: the sidebar (24-px, indigo hover) and the settings model table (24-px) both run dense via local `.iconButton`/`.actionButton` overrides on top of `&lt;IconButton size=&quot;xs&quot;&gt;`. Should these graduate into a first-class atom size or a `&lt;DenseRowAction&gt;` wrapper if a third dense-list surface needs the same trick?</div>
          <div style={{ color: 'var(--color-text-tertiary, var(--color-text-secondary))' }}>
            <strong>Resolved:</strong> star/cloud-active toggles in `SessionListItemActions` deliberately keep filled-icon as the pressed signal and do <em>not</em> pass the atom&apos;s `active` prop. Lavender pressed backgrounds are tuned for prominent single-toggle surfaces; in dense list-rows with multiple toggles plus row hover and lift, filled-icon is the right density tier. See the comment in `SessionListItemActions.tsx`.
          </div>
        </div>
      </Section>
    </div>
  ),
};
