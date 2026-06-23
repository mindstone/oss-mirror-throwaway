// @vitest-environment happy-dom
//
// Contract test for postmortem 260211
// (onboarding_auth_refresh_draft_key_deadlock).
//
// The race: onboarding writes draft-only values (`coreDirectory`,
// `eulaAcceptedAt`) into `draftSettings` and relies on the 800ms autosave
// debounce to persist them. Separately, `onAuthConfigReceived` /
// `onSettingsExternalUpdate` trigger `refreshSettings()`, which replaces the
// draft with server-fetched values immediately. If that refresh fires BEFORE
// the debounce flushes, the draft loses the very keys `canProceed` needs and
// the onboarding "Continue" button silently deadlocks.
//
// The shipped fix (`refreshSettings({ preserveDraftKeys: [...] })`, with
// `coreDirectory` / `eulaAcceptedAt` always preserved — see useSettingsFeature.ts)
// merges those draft-local keys back over the server snapshot.
//
// This test asserts the SPECIFIC required keys survive (not merely
// `canProceed === true`), so an incomplete preserve set cannot pass green by
// accident.
//
// NON-VACUOUSNESS: the server settings returned by `settingsApi.get()` (used by
// `refreshSettings`) intentionally OMIT `coreDirectory` and `eulaAcceptedAt`.
// The only way those keys can be present in the draft after the refresh is the
// `preserveDraftKeys` merge. If `preserveDraftKeys` were removed from the
// `onAuthConfigReceived` / `onSettingsExternalUpdate` handlers, the post-refresh
// draft would carry the server snapshot's values (undefined/null) and this test
// would go RED.
//
// GUARD: if a future required onboarding draft key is added, it MUST be added
// to the `preserveDraftKeys` arrays in useSettingsFeature.ts AND asserted here.
// This test guards `coreDirectory` and `eulaAcceptedAt` specifically.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanupFakeTimers, flushAsync, renderHook, setupFakeTimers } from '@renderer/test-utils';
import type { AppSettings } from '@shared/types';
import { useSettingsFeature } from '../useSettingsFeature';

const ONBOARDING_CORE_DIRECTORY = '/Users/test/MindstoneLibrary';
const ONBOARDING_EULA_ACCEPTED_AT = 1_700_000_000_000;

/**
 * The settings the MAIN process returns from `settingsApi.get()` during the
 * auth-config refresh. This represents the server/persisted snapshot AFTER login
 * but BEFORE the onboarding draft has been autosaved — so it deliberately has NO
 * `coreDirectory` and NO `eulaAcceptedAt`. Those live only in the unsaved draft.
 */
const makeServerSettingsWithoutDraftKeys = (): AppSettings => ({
  coreDirectory: null,
  eulaAcceptedAt: null,
  mcpConfigFile: null,
  onboardingCompleted: false,
  userEmail: '[Mindstone-email]',
  onboardingFirstCompletedAt: null,
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
    model: 'claude-sonnet-4-6',
    permissionMode: 'bypassPermissions',
    executablePath: null,
    planMode: false,
    extendedContext: true,
    thinkingEffort: 'high',
  },
  models: {
    // Auth config delivered a server-provisioned API key — the whole reason a
    // refresh fires after login.
    apiKey: 'server-provisioned-key',
    oauthToken: null,
    authMethod: 'api-key',
    model: 'claude-opus-4-7',
    permissionMode: 'bypassPermissions',
    executablePath: null,
    planMode: false,
    extendedContext: true,
    thinkingEffort: 'high',
  },
  diagnostics: {
    debugBreadcrumbsUntil: null,
  },
  localModel: {
    profiles: [],
    activeProfileId: null,
  },
  openRouter: {
    enabled: false,
    oauthToken: null,
    selectedModel: 'openai/gpt-5.5',
  },
  activeProvider: 'anthropic',
} as AppSettings);

describe('useSettingsFeature — 260211 draft-key vs auth-refresh race', () => {
  // Captured handlers the hook registers via useIpcEvent; invoking them
  // simulates the external IPC event firing.
  let authConfigHandler: (() => void) | undefined;
  let externalUpdateHandler: (() => void) | undefined;

  beforeEach(() => {
    setupFakeTimers();
    authConfigHandler = undefined;
    externalUpdateHandler = undefined;

    Object.assign(window, {
      api: {
        onDemoModeChange: vi.fn(() => () => {}),
        onSettingsExternalUpdate: vi.fn((handler: () => void) => {
          externalUpdateHandler = handler;
          return () => {};
        }),
        onAuthConfigReceived: vi.fn((handler: () => void) => {
          authConfigHandler = handler;
          return () => {};
        }),
        getAnalyticsStatus: vi.fn(async () => null),
      },
      settingsApi: {
        // Initial mount + every refresh fetch the server snapshot that LACKS
        // the onboarding draft keys.
        get: vi.fn(async () => makeServerSettingsWithoutDraftKeys()),
        update: vi.fn(async (next: AppSettings) => next),
      },
    });
  });

  afterEach(() => {
    cleanupFakeTimers();
    vi.restoreAllMocks();
  });

  it('preserves coreDirectory and eulaAcceptedAt when onAuthConfigReceived refresh races the autosave debounce', async () => {
    const { result, unmount } = renderHook(() => useSettingsFeature({
      emitLog: vi.fn(),
      showToast: vi.fn(),
    }));

    // Let the mount-time refreshSettings() settle.
    await flushAsync();
    await flushAsync();

    // Onboarding populates the required draft keys. updateDraft schedules the
    // 800ms autosave debounce; we deliberately do NOT advance past it.
    act(() => {
      result.current.updateDraft('coreDirectory', ONBOARDING_CORE_DIRECTORY);
    });
    act(() => {
      result.current.updateDraft('eulaAcceptedAt', ONBOARDING_EULA_ACCEPTED_AT);
    });

    // Sanity: the draft holds the onboarding values pre-refresh.
    expect(result.current.draftSettings?.coreDirectory).toBe(ONBOARDING_CORE_DIRECTORY);
    expect(result.current.draftSettings?.eulaAcceptedAt).toBe(ONBOARDING_EULA_ACCEPTED_AT);

    // The autosave debounce (800ms) has NOT fired yet — the values are
    // draft-only. Now auth config arrives and triggers a refresh.
    expect(authConfigHandler).toBeTypeOf('function');
    await act(async () => {
      authConfigHandler?.();
      await flushAsync();
    });

    // The server-provisioned key flows in (refresh did happen)...
    expect(result.current.draftSettings?.models?.apiKey).toBe('server-provisioned-key');

    // ...but the unsaved onboarding draft keys MUST survive the refresh.
    // Assert the EXACT keys (not merely canProceed) so an incomplete
    // preserveDraftKeys set cannot pass green by accident.
    expect(result.current.draftSettings?.coreDirectory).toBe(ONBOARDING_CORE_DIRECTORY);
    expect(result.current.draftSettings?.eulaAcceptedAt).toBe(ONBOARDING_EULA_ACCEPTED_AT);

    unmount();
  });

  it('preserves coreDirectory and eulaAcceptedAt when onSettingsExternalUpdate refresh races the autosave debounce', async () => {
    const { result, unmount } = renderHook(() => useSettingsFeature({
      emitLog: vi.fn(),
      showToast: vi.fn(),
    }));

    await flushAsync();
    await flushAsync();

    act(() => {
      result.current.updateDraft('coreDirectory', ONBOARDING_CORE_DIRECTORY);
    });
    act(() => {
      result.current.updateDraft('eulaAcceptedAt', ONBOARDING_EULA_ACCEPTED_AT);
    });

    expect(externalUpdateHandler).toBeTypeOf('function');
    await act(async () => {
      externalUpdateHandler?.();
      await flushAsync();
    });

    expect(result.current.draftSettings?.coreDirectory).toBe(ONBOARDING_CORE_DIRECTORY);
    expect(result.current.draftSettings?.eulaAcceptedAt).toBe(ONBOARDING_EULA_ACCEPTED_AT);

    unmount();
  });
});
