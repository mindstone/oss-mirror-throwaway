// @ts-nocheck
import * as React from 'react';
import { Layers, Shield } from 'lucide-react';
import { RichSelect, Select } from '@renderer/components/ui';

const meta = {
  title: 'Design System/Atoms/Inputs/Select Family',
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
    docs: {
      description: {
        component:
          'Atom review page for the select family. `Select` is for low-ambiguity choices. `RichSelect` is for choices where the option descriptions matter.',
      },
    },
  },
};

export default meta;

const SAFETY_OPTIONS = [
  { value: 'auto', label: 'Save automatically', description: 'Use when trust is already established.', icon: Shield },
  { value: 'ask', label: 'Ask when sensitive', description: 'Default for spaces that may contain sensitive content.', icon: Layers },
  { value: 'always', label: 'Always ask', description: 'Highest-friction but safest choice.', icon: Shield },
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
          Atom family
        </div>
        <h1 style={{ margin: 0, fontSize: 32, lineHeight: 1.2 }}>Select Family</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', lineHeight: 1.55, maxWidth: 760 }}>
          Rebel&apos;s select family currently has two atom-level tools: a plain <code>Select</code> for
          low-ambiguity choices, and a <code>RichSelect</code> for choices that need visible explanation.
        </p>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 12, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>
          How this family should be used
        </h2>
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
          <div><strong>`Select`</strong> - use for low-ambiguity choices where the surrounding row already explains the decision.</div>
          <div><strong>`RichSelect`</strong> - use when the option descriptions matter to the decision.</div>
          <div><strong>Not for</strong> - visible comparison choices that should become decision-card molecules.</div>
        </div>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 12, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>
          Where it is used now
        </h2>
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
          <div><strong>`Select`</strong> - increasingly used in Settings, including `VoiceTab`, `BtsTaskOverrides`, and cloud/account flows.</div>
          <div><strong>`RichSelect`</strong> - used where the option descriptions are part of the user decision, such as safety/privacy style controls.</div>
        </div>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 12, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>
          Atom 1 - Select
        </h2>
        <div style={{ display: 'grid', gap: 12, maxWidth: 360 }}>
          <Select defaultValue="balanced">
            <option value="fast">Fast</option>
            <option value="balanced">Balanced</option>
            <option value="careful">Careful</option>
          </Select>
          <Select selectSize="sm" defaultValue="week">
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
          </Select>
        </div>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 12, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>
          Atom 2 - RichSelect
        </h2>
        <div style={{ maxWidth: 420 }}>
          <RichSelect
            value="ask"
            onChange={() => {}}
            options={SAFETY_OPTIONS}
          />
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
          If the user needs side-by-side comparison between options, this should stop being a select atom
          and become a decision-card molecule instead.
        </div>
      </section>
    </div>
  ),
};
