// @ts-nocheck
import * as React from 'react';
import { useState } from 'react';
import { Button, MaturityBadge, Select } from '@renderer/components/ui';
import { SettingRow } from '@renderer/features/settings/components/SettingRow';
import { SettingSection } from '@renderer/features/settings/components/SettingSection';

const meta = {
  title: 'Design System/Molecules/Settings Rows',
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
    docs: {
      description: {
        component:
          'Molecule review page. Settings rows are not low-level atoms - they are small repeatable compositions of labels, descriptions, badges, helper affordances, and controls.',
      },
    },
  },
};

export default meta;

function SettingsRowsPage() {
  const [autoMode, setAutoMode] = useState('balanced');
  const [toggleEnabled, setToggleEnabled] = useState(true);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);

  return (
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
        <h1 style={{ margin: 0, fontSize: 32, lineHeight: 1.2 }}>Settings Rows</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', lineHeight: 1.55, maxWidth: 760 }}>
          A settings row is a small product composition: label, explanation, optional badge/help,
          and the control itself. The control atom matters, but the row hierarchy matters just as much.
        </p>
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
        }}
      >
        <div><strong>How this should be used</strong> - use when a setting needs a label, explanation, optional badge/help, and a control that should read as one trust-sensitive row.</div>
        <div><strong>Where it is used now</strong> - Settings surfaces across voice, cloud, advanced/system toggles, and other form-heavy settings areas.</div>
        <div><strong>Not for</strong> - side-by-side option comparison, which should become a decision-card molecule instead.</div>
      </section>

      <SettingSection
        title="Row variants"
        description="These examples show the jobs settings rows should cover before more one-off wrappers are introduced."
      >
        <SettingRow
          label="Enable assistant voice"
          description="Lets Rebel speak responses aloud when voice is active."
          badge={<MaturityBadge level="labs" featureName="Voice" />}
          tooltip="Use rows like this for trust-sensitive on/off settings."
          htmlFor="storybook-voice-toggle"
        >
          <input
            id="storybook-voice-toggle"
            type="checkbox"
            checked={toggleEnabled}
            onChange={() => setToggleEnabled((v) => !v)}
          />
        </SettingRow>

        <SettingRow
          label="Default quality mode"
          description="Pick the default balance of speed and thoroughness for new conversations."
          tooltip="Use Select when the user already understands the choice."
          htmlFor="storybook-quality-select"
        >
          <Select
            id="storybook-quality-select"
            value={autoMode}
            onChange={(e) => setAutoMode(e.target.value)}
          >
            <option value="fast">Fast</option>
            <option value="balanced">Balanced</option>
            <option value="careful">Careful</option>
          </Select>
        </SettingRow>

        <SettingRow
          label="Connection health"
          description="Current provider status and the best next action."
          badge={<span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>Healthy</span>}
          variant="stacked"
        >
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button variant="outline" size="sm">Run check</Button>
            <Button variant="ghost" size="sm">View logs</Button>
          </div>
        </SettingRow>

        <SettingRow
          label="Desktop notifications"
          description="Show gentle nudges when attention is needed."
          tooltip="Rows can stay calm even when the control is simple."
          htmlFor="storybook-notification-toggle"
        >
          <input
            id="storybook-notification-toggle"
            type="checkbox"
            checked={notificationsEnabled}
            onChange={() => setNotificationsEnabled((v) => !v)}
          />
        </SettingRow>
      </SettingSection>

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
          If a choice really needs side-by-side comparison, this should stop being a settings row
          and become a decision-card molecule instead.
        </div>
      </section>
    </div>
  );
}

export const CurrentReality = {
  render: () => <SettingsRowsPage />,
};
