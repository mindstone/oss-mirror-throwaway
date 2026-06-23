// @ts-nocheck
import * as React from 'react';
import { useCallback, useState } from 'react';
import {
  DEFAULT_DIAGNOSTICS_SETTINGS,
  DEFAULT_LOCAL_MODEL_SETTINGS,
  DEFAULT_MEETING_BOT_SETTINGS,
  DEFAULT_VOICE_ACTIVATION_HOTKEY,
  DEFAULT_VOICE_ACTIVATION_VOICE_MODE,
} from '@shared/types';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Toggle,
} from '@renderer/components/ui';
import { FocusToggleSection } from '@renderer/features/settings/components/sections/FocusToggleSection';
import {
  LocalInferenceToggleSection,
  PowerSaveToggleSection,
} from '@renderer/features/settings/components/sections/SystemExperimentalFeaturesSection';

/**
 * FOX-3131 Stage 3 — the first real Missing-family page.
 *
 * Purpose: evolve `Design System/Missing/Toggles` into a truthful
 * bridge page. Rebel now has a shared `Toggle` atom, but not every
 * existing toggle-shaped surface has been unified yet. This page shows
 * the shared baseline plus the current local realities that still need
 * review and cleanup.
 *
 * Boundaries:
 *  - The shared `Toggle` atom exists now, but this page should not
 *    pretend every toggle-shaped pattern in the app is solved.
 *  - Storybook stays the preview/browser layer — the rendered sections
 *    live in `src/renderer/features/settings/...` and continue to own
 *    their own behavior.
 *  - Runtime-bound toggles (`SlackMentionToggle`, community-events
 *    toggles) are deliberately not mounted; they depend on services
 *    this page cannot and should not stub.
 *  - The styled notification-switch pattern in
 *    `SystemAccountPreferencesSections.tsx` is acknowledged in prose
 *    rather than rendered, because extracting it into a render-safe
 *    wrapper would require refactoring production code outside this
 *    slice.
 */
const meta = {
  title: 'Design System/Atoms/Toggles',
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
    docs: {
      description: {
        component:
          'Shared atom plus unresolved realities. Rebel now has a shared `Toggle` atom, but still has more than one toggle reality in product code. This page shows the atom baseline, then the current row-level realities that still need cleanup.',
      },
    },
  },
};

export default meta;

/**
 * Build a typed `AppSettings` fixture for rendering the safe settings
 * sections on this page.
 *
 * Why this exists: the settings sections type `draftSettings` as
 * `AppSettings`, which has many required top-level fields (`voice`,
 * `claude`, `diagnostics`, `coreDirectory`, …). Casting with
 * `as AppSettings` would hide the shape and silently rot when new
 * required fields land. Instead, this fixture mirrors the minimal
 * valid shape used by the Node-side defaults and leaves optional
 * branches unset unless the toggle sections on this page actually
 * read from them.
 *
 * The only branches that have to be pre-populated are the ones the
 * rendered sections read on first render: the `experimental` object
 * and the top-level `preventSleepDuringTurns` flag. Everything else is
 * there purely to satisfy the required shape of `AppSettings` so the
 * story compiles without `as`-casting.
 */
function buildToggleFixture() {
  return {
    coreDirectory: null,
    mcpConfigFile: null,
    onboardingCompleted: true,
    userFirstName: null,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    voice: {
      provider: 'local-parakeet',
      openaiApiKey: null,
      elevenlabsApiKey: null,
      model: 'parakeet-v3',
      ttsVoice: 'nova',
      activationHotkey: DEFAULT_VOICE_ACTIVATION_HOTKEY,
      activationHotkeyVoiceMode: DEFAULT_VOICE_ACTIVATION_VOICE_MODE,
    },
    claude: {
      apiKey: null,
      oauthToken: null,
      authMethod: 'api-key',
      model: 'claude-opus-4-7',
      permissionMode: 'bypassPermissions',
      executablePath: null,
      planMode: false,
      extendedContext: true,
      thinkingEffort: 'high',
    },
    diagnostics: { ...DEFAULT_DIAGNOSTICS_SETTINGS },
    experimental: {
      focusEnabled: false,
      localInferenceEnabled: false,
    },
    preventSleepDuringTurns: false,
    localModel: { ...DEFAULT_LOCAL_MODEL_SETTINGS },
    meetingBot: { ...DEFAULT_MEETING_BOT_SETTINGS },
    theme: 'dark',
  };
}

const SUBDUED_HEADING = {
  margin: 0,
  fontSize: 12,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--color-text-secondary)',
};

const MISSING_PILL_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  alignSelf: 'start',
  padding: '4px 10px',
  borderRadius: 999,
  background: 'rgba(245,158,11,0.16)',
  color: '#fcd34d',
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
};

const CODE_PATH = {
  fontFamily: 'monospace',
  fontSize: 12,
  color: 'var(--color-text-secondary)',
};

const TogglesPage = () => {
  const [draftSettings, setDraftSettings] = useState(() => buildToggleFixture());

  const updateDraft = useCallback((key, value) => {
    setDraftSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  return (
    <div style={{ display: 'grid', gap: 28, padding: '32px 24px', maxWidth: 960 }}>
      <section style={{ display: 'grid', gap: 10 }}>
        <div style={MISSING_PILL_STYLE}>Not yet shared</div>
        <h1 style={{ margin: 0, fontSize: 32, lineHeight: 1.2 }}>Toggles</h1>
        <p
          style={{
            margin: 0,
            color: 'var(--color-text-secondary)',
            maxWidth: 720,
            lineHeight: 1.55,
          }}
        >
          Rebel does not have a shared <code>Toggle</code> component for this family of settings
          controls today. Local product sections still build their own versions, and this page shows
          that reality directly instead of implying a single pattern already exists.
        </p>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={SUBDUED_HEADING}>What this page shows</h2>
        <Card variant="outlined">
          <CardContent style={{ padding: 20, display: 'grid', gap: 10, lineHeight: 1.55 }}>
            <p style={{ margin: 0 }}>
              Below are three real settings sections rendered in place. They are the checkbox-style
              reality: a plain HTML checkbox sitting inside a labelled row. The rows come from the
              live product code and are imported, not reconstructed.
            </p>
            <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
              You can flip each toggle. The state lives in a story-local fixture so nothing leaves
              this page — no product settings are changed.
            </p>
          </CardContent>
        </Card>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={SUBDUED_HEADING}>How this family should be used</h2>
        <Card variant="outlined">
          <CardContent style={{ padding: 20, display: 'grid', gap: 10, lineHeight: 1.55 }}>
            <p style={{ margin: 0 }}>
              <strong>Toggle atom</strong>: the low-level on/off control only.
            </p>
            <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
              Use a row-level molecule when the control needs labels, warnings, badges, or helper text around it.
              Do not use this atom for side-by-side option comparison or larger decision structures.
            </p>
          </CardContent>
        </Card>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={SUBDUED_HEADING}>Where it is used now</h2>
        <Card variant="outlined">
          <CardContent style={{ padding: 20, display: 'grid', gap: 10, lineHeight: 1.55 }}>
            <p style={{ margin: 0 }}>
              The shared atom is now used in low-risk Settings sections such as Focus and experimental/system toggles.
            </p>
            <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
              More complex or runtime-bound toggle surfaces still need cleanup and are intentionally documented here as unresolved realities.
            </p>
          </CardContent>
        </Card>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={SUBDUED_HEADING}>Shared atom baseline</h2>
        <Card variant="outlined">
          <CardContent style={{ padding: 20, display: 'grid', gap: 16 }}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
              <Toggle aria-label="Toggle off example" />
              <Toggle defaultChecked aria-label="Toggle on example" />
              <Toggle disabled aria-label="Disabled toggle example" />
              <Toggle defaultChecked disabled aria-label="Disabled checked toggle example" />
            </div>
            <p style={{ margin: 0, color: 'var(--color-text-secondary)', lineHeight: 1.55 }}>
              This is the shared low-level atom. It solves the core on/off control, but not the full
              row hierarchy or the larger settings patterns around it.
            </p>
          </CardContent>
        </Card>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={SUBDUED_HEADING}>Reality 1 — row-level toggle usage</h2>
        <Card variant="outlined">
          <CardContent style={{ padding: 20, display: 'grid', gap: 20 }}>
            <FocusToggleSection draftSettings={draftSettings} updateDraft={updateDraft} />
            <LocalInferenceToggleSection draftSettings={draftSettings} updateDraft={updateDraft} />
            <PowerSaveToggleSection draftSettings={draftSettings} updateDraft={updateDraft} />
          </CardContent>
        </Card>
        <p
          style={{
            margin: 0,
            color: 'var(--color-text-secondary)',
            lineHeight: 1.55,
          }}
        >
          Source files for these rows:{' '}
          <span style={CODE_PATH}>
            src/renderer/features/settings/components/sections/FocusToggleSection.tsx
          </span>
          {' and '}
          <span style={CODE_PATH}>
            src/renderer/features/settings/components/sections/SystemExperimentalFeaturesSection.tsx
          </span>
          .
        </p>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={SUBDUED_HEADING}>Reality 2 — still unresolved switch styling</h2>
        <Card variant="outlined">
          <CardHeader style={{ gap: 6 }}>
            <CardTitle style={{ fontSize: 15 }}>Not rendered on this page</CardTitle>
            <CardDescription style={{ lineHeight: 1.55 }}>
              Desktop notification preferences use a different look: a styled switch pill with a
              sliding thumb, rendered with <code>styles.toggle</code> and
              {' '}<code>styles.toggleSlider</code>.
            </CardDescription>
          </CardHeader>
          <CardContent style={{ paddingTop: 0, display: 'grid', gap: 10, lineHeight: 1.55 }}>
            <p style={{ margin: 0 }}>
              This page does not render the notification-switch variant. Mounting it truthfully would
              require refactoring production settings code to decouple the row from its surrounding
              section, which is out of scope for this slice. The page calls the variant out here so
              the Missing framing stays honest.
            </p>
            <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
              See it in the app code:{' '}
              <span style={CODE_PATH}>
                src/renderer/features/settings/components/sections/SystemAccountPreferencesSections.tsx
              </span>
              .
            </p>
          </CardContent>
        </Card>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={SUBDUED_HEADING}>What this page is not</h2>
        <Card variant="outlined">
          <CardContent style={{ padding: 20, display: 'grid', gap: 8, lineHeight: 1.55 }}>
            <p style={{ margin: 0 }}>
              It is not a proposal for a new shared <code>Toggle</code> component, and it is not
              exhaustive. Runtime-bound toggles such as the Slack mention toggle and the community
              events toggles are intentionally omitted because they depend on app services this page
              cannot stub without fiction.
            </p>
            <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
              The shared atom exists now, but this page should continue to document where the larger
              toggle family is still fragmented.
            </p>
          </CardContent>
        </Card>
      </section>
    </div>
  );
};

export const CurrentReality = {
  render: () => <TogglesPage />,
};
