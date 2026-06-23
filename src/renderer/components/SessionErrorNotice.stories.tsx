import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { SessionErrorNotice } from './SessionErrorNotice';
import type { AgentErrorResolution, AgentErrorResolutionAction } from '@rebel/shared';

const meta = {
  title: 'Components/SessionErrorNotice',
  component: SessionErrorNotice,
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
  },
} satisfies Meta<typeof SessionErrorNotice>;

export default meta;
type Story = StoryObj<typeof meta>;

const wrapper: React.CSSProperties = {
  display: 'grid',
  gap: 24,
  padding: 24,
  maxWidth: 960,
};

const themeGrid: React.CSSProperties = {
  display: 'grid',
  gap: 16,
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
};

const themePanelStyle = (mode: 'light' | 'dark'): React.CSSProperties => ({
  display: 'grid',
  gap: 12,
  padding: 20,
  borderRadius: 16,
  background: mode === 'dark' ? '#0f172a' : '#ffffff',
  color: mode === 'dark' ? '#f8fafc' : '#0f172a',
});

const noopApply = (_action: AgentErrorResolutionAction) => {};

const ThemeSurface = ({
  mode,
  children,
}: {
  mode: 'light' | 'dark';
  children: React.ReactNode;
}) => (
  <div className={mode} style={themePanelStyle(mode)}>
    <h3 style={{ margin: 0, fontSize: 13, opacity: 0.7, textTransform: 'uppercase', letterSpacing: 0.5 }}>
      {mode}
    </h3>
    {children}
  </div>
);

function modelAction(label: string, model: string): AgentErrorResolutionAction {
  return {
    label,
    action: 'switch-model',
    payload: { model },
    variant: 'primary',
  };
}

function openSettingsAction(
  label: string,
  settingsSection: string,
  variant: AgentErrorResolutionAction['variant'] = 'secondary',
): AgentErrorResolutionAction {
  return {
    label,
    action: 'open-settings',
    payload: { settingsSection },
    variant,
  };
}

function retryAction(
  label: string,
  variant: AgentErrorResolutionAction['variant'] = 'primary',
): AgentErrorResolutionAction {
  return { label, action: 'retry', variant };
}

function resolution(
  fields: Omit<AgentErrorResolution, 'persistent' | 'defaultAction'> & {
    defaultAction?: AgentErrorResolutionAction;
  },
): AgentErrorResolution {
  const defaultAction = fields.defaultAction ?? fields.alternatives[0];
  return {
    ...fields,
    ...(defaultAction ? { defaultAction } : {}),
    persistent: fields.category !== 'transient',
  };
}

const variantA = resolution({
  category: 'unsupported-feature',
  kind: 'unsupported_model',
  title: "ChatGPT Pro doesn't run GPT-5.5 Pro.",
  body: 'Pick a model that works on your subscription, or switch providers.',
  alternatives: [
    modelAction('Use GPT-5.5', 'gpt-5.5'),
    openSettingsAction('Open settings', 'providerKeys'),
  ],
});

const variantB = resolution({
  category: 'unsupported-feature',
  kind: 'unsupported_model',
  title: "This model isn't available on your subscription.",
  body: 'Choose another to keep going.',
  alternatives: [openSettingsAction('Choose another', 'model', 'primary')],
});

const variantC = resolution({
  category: 'system-broken',
  kind: 'routing',
  title: 'Rebel hit a snag in the plumbing.',
  body: 'Not your message — something on our end. Your work is saved.',
  alternatives: [
    retryAction('Try again'),
    openSettingsAction('Open Diagnose', 'diagnose'),
  ],
});

const fallback = resolution({
  category: 'unknown',
  kind: 'unknown',
  title: 'Something went sideways.',
  body: 'Your message is safe. Try again, or check Settings → Diagnose.',
  alternatives: [
    retryAction('Try again'),
    openSettingsAction('Open Diagnose', 'diagnose'),
  ],
});

const transient = resolution({
  category: 'transient',
  kind: 'server_error',
  title: "Connection's been moody.",
  body: 'Saving your message — try again.',
  alternatives: [],
});

// 260622 Stage 4: the three Chief-of-Staff recovery resolutions, mirroring the
// real `classifyErrorUx` output for `chief-of-staff-unavailable` × reason. Copy
// is kept byte-identical to the classifier so the stories are an honest review
// surface. Actions use the new `recreate-chief-of-staff` /
// `proceed-without-chief-of-staff` verbs + the open-settings reveal sentinel.
function chiefOfStaffAction(
  label: string,
  action: AgentErrorResolutionAction['action'],
  variant: AgentErrorResolutionAction['variant'] = 'primary',
): AgentErrorResolutionAction {
  return { label, action, variant };
}

const cosReconnecting = resolution({
  category: 'transient',
  kind: 'chief-of-staff-unavailable',
  title: 'Reconnecting to your drive.',
  body: "Rebel paused this turn because it can't reach your drive right now, where your Chief-of-Staff instructions live. Try again once it's back, or run this turn without your instructions just this once.",
  alternatives: [
    retryAction('Try again'),
    chiefOfStaffAction('Run without my instructions', 'proceed-without-chief-of-staff', 'secondary'),
  ],
});

const cosUnreadable = resolution({
  category: 'user-fixable',
  kind: 'chief-of-staff-unavailable',
  title: "Can't read your Chief-of-Staff instructions.",
  body: "The file is there, but Rebel couldn't open it, usually a permissions issue or the file got into a bad state. Fix the file, then try again.",
  alternatives: [
    retryAction('Try again'),
    openSettingsAction('Open the file', 'reveal-chief-of-staff-readme', 'secondary'),
  ],
});

const cosMissingAfterSetup = resolution({
  category: 'user-fixable',
  kind: 'chief-of-staff-unavailable',
  title: 'Your Chief-of-Staff instructions are missing.',
  body: "Rebel set these up for you during onboarding, but the file isn't where it should be, it may have been moved or deleted. Recreate it from the starter template and you're back in business.",
  alternatives: [
    chiefOfStaffAction('Recreate from template', 'recreate-chief-of-staff', 'primary'),
    chiefOfStaffAction('Run without my instructions', 'proceed-without-chief-of-staff', 'secondary'),
  ],
});

const fixtures: Array<{ label: string; resolution: AgentErrorResolution }> = [
  { label: 'Variant A — Codex unsupported with alternative', resolution: variantA },
  { label: 'Variant B — Codex unsupported without alternative', resolution: variantB },
  { label: 'Variant C — system-broken', resolution: variantC },
  { label: 'Fallback — unknown kind', resolution: fallback },
  { label: 'Transient — suppressed during retry', resolution: transient },
  { label: 'Chief-of-Staff — reconnecting (drive down)', resolution: cosReconnecting },
  { label: 'Chief-of-Staff — unreadable', resolution: cosUnreadable },
  { label: 'Chief-of-Staff — missing after setup', resolution: cosMissingAfterSetup },
];

const renderFixture = (fixture: AgentErrorResolution) => (
  <SessionErrorNotice
    resolution={fixture}
    dismissible={fixture.category !== 'system-broken'}
    onApply={noopApply}
    onDismiss={() => {}}
  />
);

export const VariantA: Story = {
  render: () => <div style={wrapper}>{renderFixture(variantA)}</div>,
};

export const VariantB: Story = {
  render: () => <div style={wrapper}>{renderFixture(variantB)}</div>,
};

export const VariantC: Story = {
  render: () => <div style={wrapper}>{renderFixture(variantC)}</div>,
};

export const DismissibleWarning: Story = {
  render: () => <div style={wrapper}>{renderFixture(variantA)}</div>,
};

export const NonDismissibleSystemBroken: Story = {
  render: () => <div style={wrapper}>{renderFixture(variantC)}</div>,
};

export const Fallback: Story = {
  render: () => <div style={wrapper}>{renderFixture(fallback)}</div>,
};

export const Transient: Story = {
  render: () => <div style={wrapper}>{renderFixture(transient)}</div>,
};

export const ChiefOfStaffReconnecting: Story = {
  render: () => <div style={wrapper}>{renderFixture(cosReconnecting)}</div>,
};

export const ChiefOfStaffUnreadable: Story = {
  render: () => <div style={wrapper}>{renderFixture(cosUnreadable)}</div>,
};

export const ChiefOfStaffMissingAfterSetup: Story = {
  render: () => <div style={wrapper}>{renderFixture(cosMissingAfterSetup)}</div>,
};

export const LightAndDark: Story = {
  render: () => (
    <div style={{ ...wrapper, maxWidth: 1200 }}>
      {fixtures.map((fixture) => (
        <section key={fixture.label} style={{ display: 'grid', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 14, color: 'var(--color-text-secondary)' }}>
            {fixture.label}
          </h2>
          <div style={themeGrid}>
            {(['light', 'dark'] as const).map((mode) => (
              <ThemeSurface key={`${fixture.label}-${mode}`} mode={mode}>
                {renderFixture(fixture.resolution)}
              </ThemeSurface>
            ))}
          </div>
        </section>
      ))}
    </div>
  ),
};
