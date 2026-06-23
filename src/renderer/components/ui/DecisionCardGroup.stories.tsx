// @ts-nocheck
import * as React from 'react';
import { useState } from 'react';
import { Ban, Cloud, MessageCircleQuestion, Monitor, Shield, Sparkles } from 'lucide-react';
import { DecisionCardGroup, MaturityBadge } from '@renderer/components/ui';
import settingsStyles from '@renderer/features/settings/components/SettingsSurface.module.css';

const meta = {
  title: 'Design System/Molecules/Decision Card Group',
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
    docs: {
      description: {
        component:
          'Molecule review page. Decision card groups are for visible comparison between a small set of meaningful options. They should not be flattened into ordinary selects just for the sake of consistency.',
      },
    },
  },
};

export default meta;

function JoinBehaviorGroup() {
  const [value, setValue] = useState('prompt');
  const [promptMinutes, setPromptMinutes] = useState('5');
  const options = [
    {
      id: 'prompt',
      icon: MessageCircleQuestion,
      title: 'Ask me first',
      description: 'Rebel asks before joining each meeting.',
      selectedContent: (
        <div className={settingsStyles.joinModeTimingRow}>
          <span>Ask</span>
          <select
            value={promptMinutes}
            onChange={(event) => setPromptMinutes(event.target.value)}
            className={settingsStyles.inlineSelectTiny}
            aria-label="Minutes before meeting to ask"
          >
            <option value="2">2</option>
            <option value="5">5</option>
            <option value="10">10</option>
            <option value="15">15</option>
          </select>
          <span>min before each meeting</span>
        </div>
      ),
      footer: 'Prompt before joining',
    },
    {
      id: 'auto',
      icon: Sparkles,
      title: 'Auto-join',
      description: 'Automatically join all meetings with video links.',
      footer: 'Joins automatically',
    },
    {
      id: 'never',
      icon: Ban,
      title: "Don't join",
      description: "Don't show meeting detection prompts.",
      footer: 'Manual only',
    },
  ];

  return (
    <DecisionCardGroup
      aria-label="Meeting join behavior"
      options={options}
      value={value}
      onValueChange={setValue}
    />
  );
}

function CloudContinuityGroup() {
  const [value, setValue] = useState('local');

  return (
    <DecisionCardGroup
      aria-label="Cloud continuity"
      value={value}
      onValueChange={setValue}
      options={[
        {
          id: 'local',
          icon: Monitor,
          title: 'Desktop only',
          description: 'Everything stays local on this computer. No continuity layer.',
          footer: 'Local by default',
        },
        {
          id: 'cloud',
          icon: Cloud,
          title: 'Add cloud continuity',
          description: 'Attach your cloud instance so work can continue across devices.',
          badge: <MaturityBadge level="beta" featureName="Cloud Continuity" />,
          footer: 'Works across devices',
        },
      ]}
    />
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
          Molecule
        </div>
        <h1 style={{ margin: 0, fontSize: 32, lineHeight: 1.2 }}>Decision Card Group</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', lineHeight: 1.55, maxWidth: 760 }}>
          Use this family when users need visible comparison between a small number of meaningful choices.
          If the comparison is the point, a dropdown is usually the wrong control.
        </p>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 12, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>
          Canonical variant - meeting join behavior
        </h2>
        <JoinBehaviorGroup />
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 12, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>
          Same variant - cloud continuity
        </h2>
        <CloudContinuityGroup />
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
        <div style={{ color: 'var(--color-text-primary)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Shield size={16} /> Review note
        </div>
        <div>
          This stays a molecule because the value is in the comparison structure, while the icon treatment comes from the shared Icon Tile atom.
        </div>
        <div>
          Keep the selected state calm and trust-building: border and fill are enough, with no extra checkmark chrome.
        </div>
      </section>
    </div>
  ),
};
