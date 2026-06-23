import * as React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Bell, Lock } from 'lucide-react';
import { Notice, type NoticeTone, type NoticePlacement } from '@renderer/components/ui';

const meta = {
  title: 'Design System/Molecules/Notice',
  component: Notice,
  includeStories: ['Gallery', 'Layout', 'Actions', 'AccessibilityRoles', 'SettingsReality', 'AutomationsReality'],
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
    docs: {
      description: {
        component:
          '`Notice` is the shared persistent in-flow status, attention, and prerequisite primitive. ' +
          'It is the sister to `Toast` (which is transient and floating). Use `Notice` for messages ' +
          'that should remain visible near the thing they affect — permission warnings, prerequisite ' +
          'nudges, connection results, embedded-field warnings.',
      },
    },
  },
} satisfies Meta<typeof Notice>;

export default meta;
type Story = StoryObj<typeof meta>;

const wrapper: React.CSSProperties = {
  display: 'grid',
  gap: 28,
  padding: 24,
  maxWidth: 880,
};

const sectionStyle: React.CSSProperties = {
  display: 'grid',
  gap: 12,
};

const sectionHeading: React.CSSProperties = {
  margin: 0,
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--color-text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: 0.4,
};

const stack: React.CSSProperties = {
  display: 'grid',
  gap: 12,
};

const TONES: NoticeTone[] = ['info', 'warning', 'error', 'success'];
const PLACEMENTS: NoticePlacement[] = ['section', 'inline', 'embedded'];

export const Gallery: Story = {
  render: () => (
    <div style={wrapper}>
      <section style={sectionStyle}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Notice</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
          Persistent in-flow attention primitive. All four tones with default Lucide icons.
        </p>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionHeading}>Title + body</h2>
        <div style={stack}>
          {TONES.map((tone) => (
            <Notice key={tone} tone={tone} title={`${tone[0].toUpperCase()}${tone.slice(1)} title`}>
              Short body copy explaining the situation and what the user can do.
            </Notice>
          ))}
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionHeading}>Body only</h2>
        <div style={stack}>
          {TONES.map((tone) => (
            <Notice key={tone} tone={tone}>
              Compact note without a title. Useful for embedded contexts.
            </Notice>
          ))}
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionHeading}>Long, multi-line body</h2>
        <Notice tone="warning" title="On macOS, Rebel needs Full Disk Access">
          Without this, your notetaker may join the wrong meeting or fail to detect Teams calls. You
          can grant access from System Settings &rarr; Privacy &amp; Security &rarr; Full Disk Access,
          then restart Rebel.
        </Notice>
      </section>
    </div>
  ),
};

export const Placements: Story = {
  render: () => (
    <div style={wrapper}>
      <section style={sectionStyle}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Placements</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
          The three placements deliberately render at different weights. Section warnings dominate;
          inline nudges sit mid-section; embedded notices sit beneath a field as a subordinate.
        </p>
      </section>

      {PLACEMENTS.map((placement) => (
        <section key={placement} style={sectionStyle}>
          <h2 style={sectionHeading}>{placement}</h2>
          <Notice
            tone="warning"
            placement={placement}
            density={placement === 'embedded' ? 'compact' : 'standard'}
            title={placement === 'embedded' ? undefined : 'Trigger phrase warning'}
          >
            {placement === 'embedded'
              ? 'Your name is not set — the bot cannot detect your voice.'
              : 'On macOS, Rebel needs Full Disk Access to detect Microsoft Teams meeting links.'}
          </Notice>
        </section>
      ))}
    </div>
  ),
};

export const Layout: Story = {
  render: () => (
    <div style={wrapper}>
      <section style={sectionStyle}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Layout</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
          Placement, density, and action alignment in one review surface. This keeps the component
          honest without making Storybook feel like a filing cabinet with opinions.
        </p>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionHeading}>Placements</h2>
        <div style={stack}>
          {PLACEMENTS.map((placement) => (
            <Notice
              key={placement}
              tone="warning"
              placement={placement}
              density={placement === 'embedded' ? 'compact' : 'standard'}
              title={placement === 'embedded' ? undefined : `${placement} notice`}
            >
              {placement === 'embedded'
                ? 'Your name is not set — the bot cannot detect your voice.'
                : 'Different placements preserve hierarchy without inventing separate banner styles.'}
            </Notice>
          ))}
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionHeading}>Standard</h2>
        <div style={stack}>
          {TONES.map((tone) => (
            <Notice key={tone} tone={tone} title="Standard">
              The standard density gives the message room to breathe.
            </Notice>
          ))}
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionHeading}>Compact</h2>
        <div style={stack}>
          {TONES.map((tone) => (
            <Notice key={tone} tone={tone} density="compact">
              Compact density tightens spacing and reduces body type.
            </Notice>
          ))}
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionHeading}>Compact + actions</h2>
        <div style={stack}>
          <Notice
            tone="info"
            density="compact"
            actions={[{ label: 'Open Settings', onClick: () => {} }]}
          >
            <strong>One more thing</strong> — to catch Teams meeting links, I need Full Disk Access.
          </Notice>
          <Notice
            tone="success"
            density="compact"
            actions={[{ label: 'View', onClick: () => {} }]}
          >
            Sync complete — 12 transcripts saved.
          </Notice>
          <Notice
            tone="warning"
            density="compact"
            dismissible
            onDismiss={() => {}}
            actions={[
              { label: 'Open Settings', onClick: () => {} },
            ]}
          >
            Permission needed for Teams meeting detection.
          </Notice>
        </div>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--color-text-secondary)' }}>
          Actions stay in the same row as the body. Dismissal uses the icon affordance, not a text button.
        </p>
      </section>
    </div>
  ),
};

export const CompactActionWrapping: Story = {
  render: () => {
    const constrained: React.CSSProperties = {
      maxWidth: 460,
      borderLeft: '2px dashed var(--color-border)',
      paddingLeft: 16,
    };
    return (
      <div style={wrapper}>
        <section style={sectionStyle}>
          <h1 style={{ margin: 0, fontSize: 28 }}>Compact action wrapping</h1>
          <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
            Actions stay in the same row as the body. A single action sits inline-right; true secondary
            actions stack into a compact right-side column. Dismissal uses the icon affordance, not a
            text button. Layout is CSS-driven; no JS measurement. The dashed border on the left of each
            example marks a constrained ~460px container so the row behaviour is visible and deterministic.
          </p>
        </section>

        <section style={sectionStyle}>
          <h2 style={sectionHeading}>Short body + short action → all inline</h2>
          <div style={constrained}>
            <Notice
              tone="info"
              density="compact"
              actions={[{ label: 'Open', onClick: () => {} }]}
            >
              One more thing — Full Disk Access needed.
            </Notice>
          </div>
        </section>

        <section style={sectionStyle}>
          <h2 style={sectionHeading}>Short body + long-label action → action remains in the right column</h2>
          <div style={constrained}>
            <Notice
              tone="warning"
              density="compact"
              actions={[
                { label: 'Open System Settings to enable Full Disk Access', onClick: () => {} },
              ]}
            >
              Permission required for Teams.
            </Notice>
          </div>
        </section>

        <section style={sectionStyle}>
          <h2 style={sectionHeading}>Short body + primary action + dismiss icon</h2>
          <div style={constrained}>
            <Notice
              tone="warning"
              density="compact"
              dismissible
              onDismiss={() => {}}
              actions={[
                { label: 'Open Settings', onClick: () => {} },
              ]}
            >
              Permission needed for Teams.
            </Notice>
          </div>
        </section>

        <section style={sectionStyle}>
          <h2 style={sectionHeading}>Body + 2 long actions → action column stays beside the body</h2>
          <div style={{ ...constrained, maxWidth: 360 }}>
            <Notice
              tone="warning"
              density="compact"
              actions={[
                { label: 'Open System Settings', onClick: () => {} },
                { label: 'Remind me later', onClick: () => {}, variant: 'secondary' },
              ]}
            >
              Full Disk Access required for Teams.
            </Notice>
          </div>
        </section>

        <section style={sectionStyle}>
          <h2 style={sectionHeading}>Multi-line body + 1 action → action stays beside the body</h2>
          <div style={constrained}>
            <Notice
              tone="warning"
              density="compact"
              actions={[{ label: 'Reconnect', onClick: () => {} }]}
            >
              The connector lost authorisation overnight. Sync is paused until you reconnect, but
              previously-synced transcripts remain available.
            </Notice>
          </div>
        </section>
      </div>
    );
  },
};

export const Actions: Story = {
  render: () => (
    <div style={wrapper}>
      <section style={sectionStyle}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Actions</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
          Notice supports up to two actions. Action mapping is deliberate and primitive-level: primary
          actions render as `Button variant="outline"`, secondary actions as `Button variant="ghost"`.
          The tone surface and border carry the visual weight; actions stay subordinate so we don't
          stack two competing accents (purple CTA on amber warning, etc.). Dismissal uses the close
          icon affordance, not a secondary text action. No raw `&lt;button&gt;` or purple-filled CTAs
          inside Notice.
        </p>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionHeading}>No action</h2>
        <Notice tone="info" title="Read-only">
          You're viewing this conversation in read-only mode.
        </Notice>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionHeading}>One primary action</h2>
        <Notice
          tone="info"
          title="One more thing"
          actions={[{ label: 'Open Settings', onClick: () => {} }]}
        >
          To catch Teams meeting links, Rebel needs Full Disk Access.
        </Notice>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionHeading}>Primary action + dismiss icon</h2>
        <Notice
          tone="warning"
          placement="section"
          title="Enable Full Disk Access for Teams meetings"
          dismissible
          onDismiss={() => {}}
          actions={[
            { label: 'Open System Settings', onClick: () => {} },
          ]}
        >
          On macOS, Rebel needs Full Disk Access to detect Microsoft Teams meeting links. Without this,
          your notetaker may join the wrong meeting or fail to detect Teams calls.
        </Notice>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionHeading}>Disabled action</h2>
        <Notice
          tone="warning"
          title="Connection unavailable"
          actions={[{ label: 'Reconnect', onClick: () => {}, disabled: true }]}
        >
          The connector is currently offline. Try again in a few minutes.
        </Notice>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionHeading}>Loading action</h2>
        <Notice
          tone="info"
          title="Verifying credentials"
          actions={[{ label: 'Verify', onClick: () => {}, loading: true }]}
        >
          Hold tight — checking your API key.
        </Notice>
      </section>
    </div>
  ),
};

const DismissibleDemo = () => {
  const [dismissed, setDismissed] = useState(false);
  return (
    <div style={stack}>
      {!dismissed ? (
        <Notice
          tone="warning"
          placement="section"
          title="Dismissible warning"
          dismissible
          onDismiss={() => setDismissed(true)}
          actions={[{ label: 'Open System Settings', onClick: () => {} }]}
        >
          The user can dismiss this notice. Persistent state lives in the consumer.
        </Notice>
      ) : (
        <Notice tone="info">
          Dismissed. Refresh the story to reset.
        </Notice>
      )}
    </div>
  );
};

export const Dismissible: Story = {
  render: () => (
    <div style={wrapper}>
      <section style={sectionStyle}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Dismissible</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
          Persistent by default. Opt in with `dismissible` + an `onDismiss` callback. The dismiss
          control is keyboard reachable and uses an `IconButton` with an accessible label.
        </p>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionHeading}>Persistent (default)</h2>
        <Notice tone="info" title="Persistent">
          No dismiss affordance. The notice resolves when the underlying condition resolves.
        </Notice>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionHeading}>Dismissible</h2>
        <DismissibleDemo />
      </section>
    </div>
  ),
};

export const AccessibilityRoles: Story = {
  render: () => (
    <div style={wrapper}>
      <section style={sectionStyle}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Accessibility roles</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
          Roles default by tone: info and success use `status` with `aria-live="polite"`;
          warning and error use `note` so static settings guidance is not announced as urgent.
          Override with `role="alert"` for newly surfaced failures. Icons are always `aria-hidden`.
        </p>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionHeading}>Default role per tone</h2>
        <div style={stack}>
          <Notice tone="info">role: status (aria-live polite)</Notice>
          <Notice tone="success">role: status (aria-live polite)</Notice>
          <Notice tone="warning">role: note</Notice>
          <Notice tone="error">role: note</Notice>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionHeading}>Explicit role override</h2>
        <Notice tone="warning" role="alert">
          Newly surfaced warnings can still opt into an interruptive alert role when the user needs to act now.
        </Notice>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionHeading}>Icon override (still aria-hidden)</h2>
        <Notice tone="info" icon={Bell} title="You have new automation suggestions">
          Custom icons render via the `icon` prop. They remain `aria-hidden`; meaning carries through
          the visible text.
        </Notice>
      </section>
    </div>
  ),
};

export const LongCopyAndWrapping: Story = {
  render: () => (
    <div style={wrapper}>
      <section style={sectionStyle}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Long copy &amp; wrapping</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
          Long titles, long bodies, and two actions wrap predictably without layout collision.
        </p>
      </section>

      <Notice
        tone="warning"
        placement="section"
        title="Your meeting notetaker isn't quite ready: there are three things that still need attention before Spark can join"
        actions={[
          {
            label: 'Open System Settings to grant Full Disk Access',
            onClick: () => {},
          },
          {
            label: 'Remind me later',
            onClick: () => {},
            variant: 'secondary',
          },
        ]}
        dismissible
        onDismiss={() => {}}
      >
        First, the bot needs Full Disk Access on macOS so it can read your calendar links — Microsoft
        Teams in particular relies on this. Second, your name in Account is unset, so the bot cannot
        identify when you speak. Third, the trigger phrase still defaults to "your Rebel"; setting a
        personalised one helps the bot ignore other voices.
      </Notice>
    </div>
  ),
};

const themePanelStyle = (mode: 'light' | 'dark'): React.CSSProperties => ({
  display: 'grid',
  gap: 12,
  padding: 20,
  borderRadius: 16,
  background: mode === 'dark' ? '#0f172a' : '#ffffff',
  color: mode === 'dark' ? '#f8fafc' : '#0f172a',
});

const ThemeSurface = ({ mode, children }: { mode: 'light' | 'dark'; children: React.ReactNode }) => (
  <div className={mode} style={themePanelStyle(mode)}>
    <h3 style={{ margin: 0, fontSize: 13, opacity: 0.7, textTransform: 'uppercase', letterSpacing: 0.5 }}>
      {mode}
    </h3>
    {children}
  </div>
);

export const ThemeMatrix: Story = {
  render: () => (
    <div style={{ ...wrapper, maxWidth: 1100 }}>
      <section style={sectionStyle}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Theme matrix</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
          Verify contrast and saturation on the actual blended surface in both light and dark themes.
        </p>
      </section>

      {PLACEMENTS.map((placement) => (
        <section key={placement} style={sectionStyle}>
          <h2 style={sectionHeading}>{placement}</h2>
          <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
            {(['light', 'dark'] as const).map((mode) => (
              <ThemeSurface key={`${placement}-${mode}`} mode={mode}>
                <div style={stack}>
                  {TONES.map((tone) => (
                    <Notice
                      key={`${placement}-${mode}-${tone}`}
                      tone={tone}
                      placement={placement}
                      title={placement === 'embedded' ? undefined : `${tone}`}
                    >
                      {`${tone} on ${mode}, placement="${placement}"`}
                    </Notice>
                  ))}
                </div>
              </ThemeSurface>
            ))}
          </div>
        </section>
      ))}
    </div>
  ),
};

const fakeSettingsCard: React.CSSProperties = {
  display: 'grid',
  gap: 12,
  padding: 16,
  border: '1px solid var(--color-border)',
  borderRadius: 12,
  background: 'var(--color-card)',
};

const fakeFieldLabel: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--color-text-primary)',
};

const fakeFieldDescription: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: 'var(--color-text-secondary)',
};

const fakeInput: React.CSSProperties = {
  width: '100%',
  height: 36,
  padding: '0 12px',
  border: '1px solid var(--color-border-input)',
  borderRadius: 8,
  background: 'transparent',
  color: 'var(--color-text-primary)',
};

export const SettingsReality: Story = {
  render: () => (
    <div style={wrapper}>
      <section style={sectionStyle}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Embedded in Settings</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
          The compact embedded placement renders as a subordinate to its host field, not a peer of
          the surrounding section.
        </p>
      </section>

      <section style={fakeSettingsCard}>
        <p style={fakeFieldLabel}>Trigger phrase</p>
        <p style={fakeFieldDescription}>
          Say "hey [phrase]" to ask a question, "stop [phrase]" to interrupt.
        </p>
        <input style={fakeInput} placeholder="Your Rebel" defaultValue="" />
        <Notice tone="warning" placement="embedded" density="compact">
          Your name is not set — the bot cannot detect your voice. Go to <strong>Account</strong> to set it.
        </Notice>
      </section>

      <section style={fakeSettingsCard}>
        <p style={fakeFieldLabel}>Speak responses aloud</p>
        <p style={fakeFieldDescription}>
          Rebel will speak answers using your TTS voice.
        </p>
        <Notice tone="info" placement="embedded" density="compact">
          Your TTS provider is set to ElevenLabs. Voice latency may be higher on slower connections.
        </Notice>
      </section>
    </div>
  ),
};

const realityColumn: React.CSSProperties = {
  display: 'grid',
  gap: 12,
  alignContent: 'start',
};

const realityColumnLabel: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--color-text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: 0.4,
};

export const MeetingsReality: Story = {
  render: () => (
    <div style={{ ...wrapper, maxWidth: 1280 }}>
      <section style={sectionStyle}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Meetings reality</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
          Honest side-by-side reconstruction of the three current `MeetingsTab` use cases as one
          primitive. The three weights are preserved deliberately — section, inline, embedded — so
          the convergence does not flatten their roles. Compare them at a glance.
        </p>
      </section>

      <div
        style={{
          display: 'grid',
          gap: 20,
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          alignItems: 'start',
        }}
      >
        <div style={realityColumn}>
          <p style={realityColumnLabel}>1. Top warning banner</p>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--color-text-secondary)' }}>
            placement="section", tone="warning", dismissible, one action plus dismiss icon.
          </p>
          <Notice
            tone="warning"
            placement="section"
            title="Enable Full Disk Access for Teams meetings"
            dismissible
            onDismiss={() => {}}
            actions={[
              { label: 'Open System Settings', onClick: () => {} },
            ]}
          >
            On macOS, Rebel needs Full Disk Access to detect Microsoft Teams meeting links. Without
            this, your notetaker may join the wrong meeting or fail to detect Teams calls.
          </Notice>
        </div>

        <div style={realityColumn}>
          <p style={realityColumnLabel}>2. Inline FDA nudge</p>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--color-text-secondary)' }}>
            placement="inline", density="compact", tone="info", one primary action.
          </p>
          <Notice
            tone="info"
            placement="inline"
            density="compact"
            icon={Lock}
            actions={[{ label: 'Open Settings', onClick: () => {} }]}
          >
            <strong>One more thing</strong> — to catch Teams meeting links, I need Full Disk Access.
          </Notice>
        </div>

        <div style={realityColumn}>
          <p style={realityColumnLabel}>3. Trigger phrase warning</p>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--color-text-secondary)' }}>
            placement="embedded", density="compact", tone="warning", no actions, no title.
          </p>
          <Notice tone="warning" placement="embedded" density="compact">
            Your name is not set — the bot cannot detect your voice. Go to <strong>Account</strong> to set it.
          </Notice>
        </div>
      </div>

      <section style={sectionStyle}>
        <h2 style={sectionHeading}>Compact FDA nudge at realistic Settings width</h2>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--color-text-secondary)' }}>
          The 3-column comparison above necessarily renders the FDA notice in a narrow column,
          which forces the action to wrap. At realistic Settings content width, the action sits
          beside the body — which is the contract this primitive is designed for. Verify both
          renderings before declaring the migration done.
        </p>
        <div style={{ maxWidth: 980 }}>
          <Notice
            tone="info"
            placement="inline"
            density="compact"
            icon={Lock}
            actions={[{ label: 'Open Settings', onClick: () => {} }]}
          >
            <strong>One more thing</strong> — to catch Teams meeting links, I need Full Disk Access.
          </Notice>
        </div>
      </section>
    </div>
  ),
};

const automationsPanelMock: React.CSSProperties = {
  display: 'grid',
  gap: 12,
};

const automationsCardMock: React.CSSProperties = {
  padding: 12,
  borderRadius: 12,
  border: '1px solid var(--color-border)',
  background: 'var(--color-card)',
  display: 'grid',
  gap: 6,
};

export const AutomationsReality: Story = {
  render: () => (
    <div style={{ ...wrapper, maxWidth: 1200 }}>
      <section style={sectionStyle}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Automations reality</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
          Warning-section notices at the top of the Automations list, with one-cause and two-cause
          stacks shown side by side in both themes.
        </p>
      </section>

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
        {(['light', 'dark'] as const).map((mode) => (
          <ThemeSurface key={mode} mode={mode}>
            <div style={automationsPanelMock}>
              <div style={automationsPanelMock}>
                <p style={realityColumnLabel}>Single cause</p>
                <Notice
                  tone="warning"
                  placement="section"
                  density="standard"
                  title="Automations are waiting on ChatGPT Pro"
                  actions={[{ label: 'Reconnect', onClick: () => {} }]}
                >
                  ChatGPT Pro is disconnected, so 3 automations can&apos;t run. Reconnect and they&apos;ll
                  pick up on their own.
                </Notice>
              </div>

              <div style={automationsPanelMock}>
                <p style={realityColumnLabel}>Two-cause stack</p>
                <Notice
                  tone="warning"
                  placement="section"
                  density="standard"
                  title="Automations are waiting on ChatGPT Pro"
                  actions={[{ label: 'Reconnect', onClick: () => {} }]}
                >
                  ChatGPT Pro is disconnected, so 2 automations can&apos;t run. Reconnect and they&apos;ll
                  pick up on their own.
                </Notice>
                <Notice
                  tone="warning"
                  placement="section"
                  density="standard"
                  title="Automations are waiting on Anthropic"
                  actions={[{ label: 'Add API key', onClick: () => {} }]}
                >
                  Anthropic needs an API key, so 1 automation can&apos;t run. Add it once and everything
                  resumes on schedule.
                </Notice>
              </div>

              <div style={automationsCardMock}>
                <strong style={{ fontSize: 13 }}>Weekly customer digest</strong>
                <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                  Waiting on ChatGPT Pro · 3 hours ago
                </span>
              </div>
              <div style={automationsCardMock}>
                <strong style={{ fontSize: 13 }}>Pipeline recap</strong>
                <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                  Waiting on Anthropic · 6 hours ago
                </span>
              </div>
            </div>
          </ThemeSurface>
        ))}
      </div>
    </div>
  ),
};
