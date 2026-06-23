// @ts-nocheck
import * as React from 'react';
import { Button, ConversationPill } from '@renderer/components/ui';
import chatStyles from '@renderer/features/homepage/components/HomepageChat.module.css';

const meta = {
  title: 'Design System/Molecules/Composer Suggestion Chips',
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
    docs: {
      description: {
        component:
          'Molecule review page. Composer suggestion chips are quick-start affordances near the input - not generic metadata chips, not tabs, and not connector status pills.',
      },
    },
  },
};

export default meta;

const sessions = [
  'Design Review System Layers',
  'Rebel Fun Committee',
  'New Agent Run',
  'rebel-system/skills/loading...',
];

export const CurrentReality = {
  render: () => (
    <div style={{ display: 'grid', gap: 28, padding: '32px 24px', maxWidth: 980 }}>
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
          Molecule
        </div>
        <h1 style={{ margin: 0, fontSize: 32, lineHeight: 1.2 }}>Composer Suggestion Chips</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', lineHeight: 1.55, maxWidth: 760 }}>
          These chips belong near a composer input and help users start quickly. Their job is quick-start
          prompting, not navigation, status, or metadata.
        </p>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 12, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>
          Current reality
        </h2>
        <div className={chatStyles.pillRow}>
          {sessions.map((session) => (
            <ConversationPill key={session} title={session} />
          ))}
          <Button type="button" variant="ghost" size="sm" className={chatStyles.historyLink}>
            View conversation history
          </Button>
        </div>
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
        }}
      >
        <div style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>Review note</div>
        <div>
          These should be reviewed as input-adjacent quick-start molecules, not lumped into the broader chip taxonomy.
        </div>
        <div>
          If a chip is telling the user what something <em>is</em>, it probably belongs to another family. If it is helping the user <em>start</em>, it likely belongs here.
        </div>
      </section>
    </div>
  ),
};
