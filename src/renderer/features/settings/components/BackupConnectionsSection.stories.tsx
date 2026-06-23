import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, type ReactNode } from 'react';

import { ToastProvider } from '@renderer/components/ui';
import { DEFAULT_LOCAL_MODEL_SETTINGS, DEFAULT_OPENROUTER_SETTINGS, type AppSettings } from '@shared/types';
import { BackupConnectionsSection } from './BackupConnectionsSection';

const meta = {
  title: 'Settings/BackupConnectionsSection',
  component: BackupConnectionsSection,
  parameters: {
    layout: 'padded',
    controls: { disable: true },
  },
  decorators: [
    (Story: () => ReactNode) => (
      <ToastProvider>
        <Story />
      </ToastProvider>
    ),
  ],
} satisfies Meta<typeof BackupConnectionsSection>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Theme helpers ─────────────────────────────────────────────────────────────

function BodyTheme({
  theme,
  children,
}: {
  theme: 'light' | 'dark';
  children: ReactNode;
}) {
  useEffect(() => {
    document.body.classList.add(theme);
    return () => {
      document.body.classList.remove(theme);
    };
  }, [theme]);
  return <div className={theme}>{children}</div>;
}

function ThemePair({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <BodyTheme theme="light">{children}</BodyTheme>
      <BodyTheme theme="dark">{children}</BodyTheme>
    </div>
  );
}

// ─── Base settings factories ───────────────────────────────────────────────────

function baseSettings(): AppSettings {
  return {
    coreDirectory: null,
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    activeProvider: 'codex',
    experimental: {
      multiProviderRoutingEnabled: true,
    },
    voice: {
      provider: 'openai-whisper',
      openaiApiKey: null,
      elevenlabsApiKey: null,
      model: 'gpt-4o-mini-transcribe-2025-12-15',
      ttsVoice: null,
      activationHotkey: null,
      activationHotkeyVoiceMode: true,
    },
    claude: {
      apiKey: null,
      oauthToken: null,
      authMethod: 'api-key',
      model: 'openai/gpt-5.5',
      permissionMode: 'bypassPermissions',
      executablePath: null,
      planMode: false,
      extendedContext: true,
      thinkingEffort: 'high',
    },
    models: {
      apiKey: null,
      model: 'openai/gpt-5.5',
      workingFallback: undefined,
      thinkingModel: 'anthropic/claude-sonnet-4.6',
      longContextFallbackModel: 'anthropic/claude-sonnet-4.6',
      permissionMode: 'bypassPermissions',
    },
    diagnostics: { debugBreadcrumbsUntil: null },
    openRouter: {
      ...DEFAULT_OPENROUTER_SETTINGS,
      enabled: false,
      oauthToken: null,
    },
    localModel: {
      ...DEFAULT_LOCAL_MODEL_SETTINGS,
      profiles: [],
    },
  } as AppSettings;
}

// ─── Stories ───────────────────────────────────────────────────────────────────
// NOTE: In production, BackupConnectionsSection is gated by AgentsTab to only render
// when the active provider is connected (isActiveProviderConnected). All stories here
// reflect the supported state (connected active provider). The non-operable
// "all disconnected" state is unreachable in the rendered component — it is prevented
// upstream by the AgentsTab gate.

/**
 * Default state: two providers connected (ChatGPT Pro + OpenRouter), Anthropic not connected.
 * Shows the full reorder list with enabled toggles and a "Not connected" row.
 */
export const Default: Story = {
  render: () => {
    const settings: AppSettings = {
      ...baseSettings(),
      activeProvider: 'codex',
      enabledProviders: ['codex', 'openrouter'],
      openRouter: {
        ...DEFAULT_OPENROUTER_SETTINGS,
        enabled: true,
        oauthToken: 'story-or-token',
      },
    };
    return (
      <ThemePair>
        <BackupConnectionsSection
          draftSettings={settings}
          codexConnected={true}
          updateDraft={() => undefined}
        />
      </ThemePair>
    );
  },
};

/**
 * Empty state: only one provider connected (the active provider).
 * Shows the "Your main connection" non-interactive row + "Add connection" deep-link.
 */
export const Empty: Story = {
  render: () => {
    const settings: AppSettings = {
      ...baseSettings(),
      activeProvider: 'codex',
      enabledProviders: ['codex'],
    };
    return (
      <ThemePair>
        <BackupConnectionsSection
          draftSettings={settings}
          codexConnected={true}
          updateDraft={() => undefined}
        />
      </ThemePair>
    );
  },
};

/**
 * Muted / not-connected rows: three providers visible, one connected (ChatGPT Pro active),
 * OpenRouter and Anthropic both not connected — shown as muted rows with "Connect" button.
 *
 * Note: previously named `NotConnectedRow` and pointed at a single-connected-provider state,
 * which now renders the `OperableEmptyState` (guidance + "Add connection" link) thanks to
 * `isOperableEmptyState`. This story has been updated to show the actual muted-row state:
 * at least two connected providers must exist for the full list to render; this variant has
 * codex connected + stale-enabled openrouter (disconnected but in chain) so the list renders.
 */
export const NotConnectedRow: Story = {
  render: () => {
    // codex connected (active), openrouter stale-enabled (disconnected) — full list shown,
    // openrouter row is muted with "Connect" button and toggle-off-able.
    const settings: AppSettings = {
      ...baseSettings(),
      activeProvider: 'codex',
      enabledProviders: ['codex', 'openrouter'],
      // No openRouter token → openrouter row is not connected
    };
    return (
      <ThemePair>
        <BackupConnectionsSection
          draftSettings={settings}
          codexConnected={true}
          updateDraft={() => undefined}
        />
      </ThemePair>
    );
  },
};

/**
 * All three providers connected and in backup chain.
 * Full list in priority order: ChatGPT Pro → OpenRouter → Anthropic.
 */
export const AllConnected: Story = {
  render: () => {
    const settings: AppSettings = {
      ...baseSettings(),
      activeProvider: 'codex',
      enabledProviders: ['codex', 'openrouter', 'anthropic'],
      openRouter: {
        ...DEFAULT_OPENROUTER_SETTINGS,
        enabled: true,
        oauthToken: 'story-or-token',
      },
      models: {
        apiKey: 'sk-ant-story-key',
        model: 'openai/gpt-5.5',
        workingFallback: undefined,
        thinkingModel: 'anthropic/claude-sonnet-4.6',
        longContextFallbackModel: 'anthropic/claude-sonnet-4.6',
        permissionMode: 'bypassPermissions',
      },
    };
    return (
      <ThemePair>
        <BackupConnectionsSection
          draftSettings={settings}
          codexConnected={true}
          updateDraft={() => undefined}
        />
      </ThemePair>
    );
  },
};

/**
 * OpenRouter as active, showing Anthropic not connected and ChatGPT Pro not connected.
 * Tests label/ordering when active provider is not codex.
 */
export const OpenRouterActive: Story = {
  render: () => {
    const settings: AppSettings = {
      ...baseSettings(),
      activeProvider: 'openrouter',
      enabledProviders: ['openrouter'],
      openRouter: {
        ...DEFAULT_OPENROUTER_SETTINGS,
        enabled: true,
        oauthToken: 'story-or-token',
      },
    };
    return (
      <ThemePair>
        <BackupConnectionsSection
          draftSettings={settings}
          codexConnected={false}
          updateDraft={() => undefined}
        />
      </ThemePair>
    );
  },
};
