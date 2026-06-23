/**
 * Test data builder for AppSettings.
 *
 * Provides a minimal valid AppSettings object with sensible defaults.
 * Also exports DEFAULT_TEST_SETTINGS — the single source of truth for
 * test settings, imported by vitest.setup.ts and testHelpers.ts.
 *
 * CAUTION: This file is imported by vitest.setup.ts during test bootstrap.
 * Only import from @shared/* and pure constants here — never from modules
 * that depend on @core/platform being initialized (e.g., dataPaths, stores).
 *
 * Usage:
 *   const settings = buildSettings();
 *   const custom = buildSettings({ onboardingCompleted: true, userEmail: 'test@example.com' });
 */
import type { AppSettings } from '@shared/types';
import {
  DEFAULT_DIAGNOSTICS_SETTINGS,
  DEFAULT_LOCAL_MODEL_SETTINGS,
  DEFAULT_MEETING_BOT_SETTINGS,
  DEFAULT_VOICE_ACTIVATION_HOTKEY,
  DEFAULT_VOICE_ACTIVATION_VOICE_MODE,
} from '@shared/types';

/**
 * Minimal valid AppSettings defaults for tests.
 * Mirrors vitest.setup.ts TEST_DEFAULT_SETTINGS to avoid divergence.
 */
export const DEFAULT_TEST_SETTINGS: AppSettings = {
  coreDirectory: null,
  mcpConfigFile: null,
  onboardingCompleted: false,
  userFirstName: null,
  userEmail: null,
  onboardingFirstCompletedAt: null,
  nps: {
    firstEligibleAt: null,
    lastShownAt: null,
    lastDismissedAt: null,
    lastCompletedAt: null,
    lastScore: null,
    lastFeedback: null,
    snoozeUntil: null,
    showCount: 0,
    completedCount: 0,
    neverShowAgain: false,
  },
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
    oauthRefreshToken: null,
    oauthTokenExpiresAt: null,
    authMethod: 'api-key',
    model: 'claude-opus-4-7',
    permissionMode: 'bypassPermissions',
    executablePath: null,
    planMode: false,
    extendedContext: true,
    thinkingEffort: 'high',
  },
  models: {
    apiKey: null,
    oauthToken: null,
    oauthRefreshToken: null,
    oauthTokenExpiresAt: null,
    authMethod: 'api-key',
    model: 'claude-opus-4-7',
    permissionMode: 'bypassPermissions',
    executablePath: null,
    planMode: false,
    extendedContext: true,
    thinkingEffort: 'high',
  },
  diagnostics: { ...DEFAULT_DIAGNOSTICS_SETTINGS },
  surveys: {},
  actionsFirstVisitedAt: null,
  theme: 'dark',
  memoryUpdateEnabled: true,
  localModel: { ...DEFAULT_LOCAL_MODEL_SETTINGS },
  meetingBot: { ...DEFAULT_MEETING_BOT_SETTINGS },
  sessionLogRetentionDays: 14,
  showDirectMcpSetupUi: false,
  cloudUpdateChannel: undefined,
};

/**
 * Build a valid AppSettings object with optional overrides.
 * Deep clones nested objects so each call returns fully independent instances.
 * For partial nested overrides, spread manually:
 *
 *   buildSettings({ models: { ...buildSettings().models, apiKey: 'test-key' } })
 */
type SettingsBuilderOverrides = Partial<Omit<AppSettings, 'claude' | 'models'>> & {
  claude?: Partial<NonNullable<AppSettings['claude']>>;
  models?: Partial<AppSettings['models']>;
};

export function buildSettings(overrides?: SettingsBuilderOverrides): AppSettings {
  const base = structuredClone(DEFAULT_TEST_SETTINGS);
  const {
    claude: claudeOverrides,
    models: modelsOverrides,
    ...rootOverrides
  } = overrides ?? {};
  const next: AppSettings = { ...base, ...rootOverrides };

  if (overrides && Object.hasOwn(overrides, 'claude') && claudeOverrides) {
    next.claude = { ...(base.claude ?? base.models), ...claudeOverrides };
  }

  if (overrides && Object.hasOwn(overrides, 'models') && modelsOverrides) {
    next.models = { ...base.models, ...modelsOverrides };
  } else if (overrides && Object.hasOwn(overrides, 'claude') && claudeOverrides) {
    next.models = { ...base.models, ...claudeOverrides };
  }

  return structuredClone(next);
}
