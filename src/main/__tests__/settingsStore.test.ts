import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { AppSettings } from '@shared/types';

// Mock electron-store before importing settingsStore.
//
// The mock simulates real electron-store JSON persistence semantics (read/
// write go through JSON.parse(JSON.stringify(...))) so that the Stage 2a
// `ensureNormalizedSettings` regression test can exercise the actual bug:
// `normalizeSettings` used to emit `{ key: undefined }` for several fields,
// which fast-deep-equal diffed unequal against the JSON-stripped persisted
// form, causing a write + fsync on every call. With JSON-round-trip here,
// the mock behaves like the real store for this specific hazard.
 
vi.mock('electron-store', () => {
  return {
    default: class MockStore {
      private _data: Record<string, unknown>;
      constructor(options?: { defaults?: Record<string, unknown>; name?: string }) {
        this._data = options?.defaults
          ? JSON.parse(JSON.stringify(options.defaults))
          : {};
      }
      get store(): Record<string, unknown> {
        return JSON.parse(JSON.stringify(this._data));
      }
      set store(value: Record<string, unknown>) {
        this._data = JSON.parse(JSON.stringify(value));
      }
      get = vi.fn();
      set = vi.fn();
    }
  };
});

// Import after mock is set up
import {
  migrateOnboardingTimestampIfNeeded,
  backfillCloudInstanceProviderIdIfNeeded,
  getSettings,
  getSettingsNormalizationStats,
  ensureNormalizedSettings,
  settingsStore,
  DEFAULT_SETTINGS,
} from '../settingsStore';

const baseSettings = {
  coreDirectory: null,
  mcpConfigFile: null,
  onboardingCompleted: false,
  userEmail: null,
  voice: {
    provider: 'openai-whisper' as const,
    openaiApiKey: null,
    elevenlabsApiKey: null,
    model: 'gpt-4o-mini-transcribe-2025-12-15',
    ttsVoice: 'nova',
    activationHotkey: null,
    activationHotkeyVoiceMode: true
  },
  claude: {
    apiKey: null,
    model: 'claude-sonnet-4-20250514',
    permissionMode: 'bypassPermissions' as const,
    executablePath: null,
    planMode: true,
    extendedContext: true,
    thinkingEffort: 'high' as const
  },
  diagnostics: { debugBreadcrumbsUntil: null }
};

const originalPlatform = process.platform;

describe('migrateOnboardingTimestampIfNeeded', () => {
  it('returns settings unchanged when neither field exists', () => {
    const settings = {
      ...baseSettings,
      onboardingFirstCompletedAt: undefined
    } as unknown as AppSettings;

    const result = migrateOnboardingTimestampIfNeeded(settings);

    expect(result).toBe(settings);
    expect((result as any).onboardingCompletedAt).toBeUndefined();
    expect((result as any).onboardingFirstCompletedAt).toBeUndefined();
  });

  it('migrates old field to new field when only old exists', () => {
    const timestamp = 1700000000000;
    const settings = {
      ...baseSettings,
      onboardingCompletedAt: timestamp
    } as unknown as AppSettings;

    const result = migrateOnboardingTimestampIfNeeded(settings);

    expect(result).not.toBe(settings);
    expect((result as any).onboardingCompletedAt).toBeUndefined();
    expect(result.onboardingFirstCompletedAt).toBe(timestamp);
  });

  it('returns settings unchanged when only new field exists', () => {
    const timestamp = 1700000000000;
    const settings = {
      ...baseSettings,
      onboardingFirstCompletedAt: timestamp
    } as AppSettings;

    const result = migrateOnboardingTimestampIfNeeded(settings);

    expect(result).toBe(settings);
    expect(result.onboardingFirstCompletedAt).toBe(timestamp);
  });

  it('removes old field and preserves new field when both exist with real value', () => {
    const oldTimestamp = 1600000000000;
    const newTimestamp = 1700000000000;
    const settings = {
      ...baseSettings,
      onboardingCompletedAt: oldTimestamp,
      onboardingFirstCompletedAt: newTimestamp
    } as unknown as AppSettings;

    const result = migrateOnboardingTimestampIfNeeded(settings);

    expect(result).not.toBe(settings);
    expect((result as any).onboardingCompletedAt).toBeUndefined();
    expect(result.onboardingFirstCompletedAt).toBe(newTimestamp);
  });

  it('migrates old value when new field is null (from defaults)', () => {
    const oldTimestamp = 1600000000000;
    const settings = {
      ...baseSettings,
      onboardingCompletedAt: oldTimestamp,
      onboardingFirstCompletedAt: null
    } as unknown as AppSettings;

    const result = migrateOnboardingTimestampIfNeeded(settings);

    expect(result).not.toBe(settings);
    expect((result as any).onboardingCompletedAt).toBeUndefined();
    expect(result.onboardingFirstCompletedAt).toBe(oldTimestamp);
  });

  it('migrates non-number old value as null', () => {
    const settings = {
      ...baseSettings,
      onboardingCompletedAt: 'invalid'
    } as unknown as AppSettings;

    const result = migrateOnboardingTimestampIfNeeded(settings);

    expect(result).not.toBe(settings);
    expect((result as any).onboardingCompletedAt).toBeUndefined();
    expect(result.onboardingFirstCompletedAt).toBeNull();
  });

  it('preserves other settings during migration', () => {
    const timestamp = 1700000000000;
    const settings = {
      ...baseSettings,
      coreDirectory: '/test/path',
      onboardingCompleted: true,
      onboardingCompletedAt: timestamp
    } as unknown as AppSettings;

    const result = migrateOnboardingTimestampIfNeeded(settings);

    expect(result.coreDirectory).toBe('/test/path');
    expect(result.onboardingCompleted).toBe(true);
    expect(result.onboardingFirstCompletedAt).toBe(timestamp);
  });
});

describe('backfillCloudInstanceProviderIdIfNeeded', () => {
  const settingsWithCloudInstance = (ci: Partial<AppSettings['cloudInstance']> | null): AppSettings => ({
    ...baseSettings,
    cloudInstance: ci as AppSettings['cloudInstance'],
  } as unknown as AppSettings);

  const silentLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    fatal: () => undefined,
    child: () => silentLogger,
  } as never;

  it('returns settings unchanged when cloudInstance is absent', () => {
    const settings = { ...baseSettings } as unknown as AppSettings;
    const result = backfillCloudInstanceProviderIdIfNeeded(settings, silentLogger);
    expect(result).toBe(settings);
  });

  it('returns settings unchanged when providerId is already set', () => {
    const settings = settingsWithCloudInstance({
      mode: 'cloud',
      cloudUrl: 'https://x.fly.dev',
      provisionMode: 'byok',
      providerId: 'fly',
      flyAppName: 'app',
      flyMachineId: 'mach',
    });
    const result = backfillCloudInstanceProviderIdIfNeeded(settings, silentLogger);
    expect(result).toBe(settings);
  });

  it('backfills providerId="fly" for legacy BYOK records with flyApp + flyMachine', () => {
    const settings = settingsWithCloudInstance({
      mode: 'cloud',
      cloudUrl: 'https://x.fly.dev',
      provisionMode: 'byok',
      flyAppName: 'app',
      flyMachineId: 'mach',
    });
    const result = backfillCloudInstanceProviderIdIfNeeded(settings, silentLogger);
    expect(result).not.toBe(settings);
    expect(result.cloudInstance?.providerId).toBe('fly');
    expect(result.cloudInstance?.flyAppName).toBe('app');
    expect(result.cloudInstance?.flyMachineId).toBe('mach');
  });

  it('backfills providerId="mindstone" for legacy managed records with flyApp + flyMachine', () => {
    const settings = settingsWithCloudInstance({
      mode: 'cloud',
      cloudUrl: 'https://x.fly.dev',
      provisionMode: 'managed',
      flyAppName: 'app',
      flyMachineId: 'mach',
    });
    const result = backfillCloudInstanceProviderIdIfNeeded(settings, silentLogger);
    expect(result).not.toBe(settings);
    expect(result.cloudInstance?.providerId).toBe('mindstone');
  });

  it('returns settings unchanged when flyAppName is missing (insufficient signal)', () => {
    const settings = settingsWithCloudInstance({
      mode: 'cloud',
      cloudUrl: 'https://x.fly.dev',
      provisionMode: 'byok',
      flyMachineId: 'mach',
    });
    const result = backfillCloudInstanceProviderIdIfNeeded(settings, silentLogger);
    expect(result).toBe(settings);
  });

  it('returns settings unchanged when flyMachineId is missing (insufficient signal)', () => {
    const settings = settingsWithCloudInstance({
      mode: 'cloud',
      cloudUrl: 'https://x.fly.dev',
      provisionMode: 'byok',
      flyAppName: 'app',
    });
    const result = backfillCloudInstanceProviderIdIfNeeded(settings, silentLogger);
    expect(result).toBe(settings);
  });

  it('returns settings unchanged for unknown provisionMode (no fabrication)', () => {
    const settings = settingsWithCloudInstance({
      mode: 'cloud',
      cloudUrl: 'https://x.fly.dev',
      provisionMode: 'manual' as never,
      flyAppName: 'app',
      flyMachineId: 'mach',
    });
    const result = backfillCloudInstanceProviderIdIfNeeded(settings, silentLogger);
    expect(result).toBe(settings);
  });

  it('preserves all other cloudInstance fields when backfilling', () => {
    const ci = {
      mode: 'cloud' as const,
      cloudUrl: 'https://x.fly.dev',
      cloudToken: 'tok',
      provisionMode: 'byok' as const,
      flyAppName: 'app',
      flyMachineId: 'mach',
      flyRegion: 'sea',
      vmTierId: 'standard' as const,
    };
    const settings = settingsWithCloudInstance(ci);
    const result = backfillCloudInstanceProviderIdIfNeeded(settings, silentLogger);
    expect(result.cloudInstance).toEqual({
      ...ci,
      providerId: 'fly',
    });
  });
});

describe('getSettings write-on-read regression', () => {
  it('does not trigger normalization (pure read)', () => {
    const before = getSettingsNormalizationStats();
    getSettings();
    getSettings();
    getSettings();
    const after = getSettingsNormalizationStats();
    expect(after.calls).toBe(before.calls);
    expect(after.writes).toBe(before.writes);
  });
});

// Stage 2a: real regression test for the normalize→fsync amplification bug.
// Pre-fix, `normalizeSettings` emitted `{ key: undefined }` for several fields
// (activeProvider, openRouter, trustedTools, behindTheScenesModel, etc.).
// JSON persistence stripped those keys, but `fast-deep-equal` diffed unequal
// between pre-persist (with undefined) and persisted (without), so every
// `ensureNormalizedSettings()` call triggered a write + fsync — observed at
// 13/13 writes/session in logs.
//
// This test uses the REAL settingsStore + REAL ensureNormalizedSettings
// (the electron-store mock above simulates JSON persistence). It drives a
// sequence of three consecutive calls and asserts at most one write: the
// first call may legitimately normalize a fresh store; subsequent calls must
// not write because normalize's output is JSON-round-trip idempotent.
describe('ensureNormalizedSettings real regression (Stage 2a)', () => {
  beforeEach(() => {
    // Reset the store to DEFAULT_SETTINGS so the test starts from a known state.
    // (The mock is shared across tests; without this, earlier `settingsStore.store = ...`
    // writes could leave residual state that skews the counters.)
    //
    // We assign via settingsStore.store = ... (the real write path) so that the
    // mock's JSON-round-trip semantics apply — this matches real startup behaviour
    // where a write normalises the persisted shape.
    settingsStore.store = DEFAULT_SETTINGS;
  });

  it('three consecutive calls write at most once (round-trip stable after first call)', () => {
    const beforeStats = getSettingsNormalizationStats();
    ensureNormalizedSettings(); // Call 1 — may legitimately normalize the default store.
    ensureNormalizedSettings(); // Call 2 — MUST NOT write (round-trip stable).
    ensureNormalizedSettings(); // Call 3 — same.
    const afterStats = getSettingsNormalizationStats();

    expect(afterStats.calls - beforeStats.calls).toBe(3);
    // Strict target is 0 (pure steady state); we tolerate 1 (the first call
    // normalising a freshly-defaulted fixture store). Pre-fix this would be 3.
    expect(afterStats.writes - beforeStats.writes).toBeLessThanOrEqual(1);
  });

  it('after steady-state is reached, no further writes occur', () => {
    // Prime: normalise once so the store reflects the canonical shape.
    ensureNormalizedSettings();
    const beforeStats = getSettingsNormalizationStats();
    // Now the store is steady-state. Subsequent calls MUST NOT write.
    ensureNormalizedSettings();
    ensureNormalizedSettings();
    ensureNormalizedSettings();
    ensureNormalizedSettings();
    ensureNormalizedSettings();
    const afterStats = getSettingsNormalizationStats();

    expect(afterStats.calls - beforeStats.calls).toBe(5);
    expect(afterStats.writes - beforeStats.writes).toBe(0);
  });
});

async function loadIsolatedSettingsStoreForGuardrailTests(
  normalizeImpl: (settings: AppSettings) => AppSettings
): Promise<{
  ensureNormalizedSettings: () => void;
  getSettingsNormalizationStats: () => { calls: number; writes: number };
  settingsStore: { store: AppSettings };
  DEFAULT_SETTINGS: AppSettings;
  warn: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();
  const warn = vi.fn();

  // The mocked logger needs to satisfy every pino method invoked at module load
  // time — in particular bootstrapModelsNamespaceMigration calls log.info on the
  // success path and log.error in the catch path. Only `warn` carries spy semantics
  // for the guardrail assertion; the rest are no-op stubs.
   
  vi.doMock('@core/logger', () => ({
    createScopedLogger: () => ({
      warn,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
    }),
  }));

   
  vi.doMock('@shared/utils/settingsUtils', async () => {
    const actual = await vi.importActual<typeof import('@shared/utils/settingsUtils')>('@shared/utils/settingsUtils');
    return {
      ...actual,
      normalizeSettings: normalizeImpl,
    };
  });

  const isolated = await import('../settingsStore');
  return {
    ensureNormalizedSettings: isolated.ensureNormalizedSettings,
    getSettingsNormalizationStats: isolated.getSettingsNormalizationStats,
    settingsStore: isolated.settingsStore as { store: AppSettings },
    DEFAULT_SETTINGS: isolated.DEFAULT_SETTINGS,
    warn,
  };
}

describe('DEFAULT_SETTINGS voice defaults', () => {
  const loadDefaultSettingsForPlatform = async (
    platform: 'darwin' | 'win32' | 'linux'
  ) => {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    const { DEFAULT_SETTINGS } = await import('../settingsStore');
    return DEFAULT_SETTINGS;
  };

  it('defaults to local-parakeet on darwin', async () => {
    const defaults = await loadDefaultSettingsForPlatform('darwin');

    expect(defaults.voice.provider).toBe('local-parakeet');
  });

  it('defaults to local-parakeet on win32', async () => {
    const defaults = await loadDefaultSettingsForPlatform('win32');

    expect(defaults.voice.provider).toBe('local-parakeet');
  });

  it('defaults to openai-whisper on linux', async () => {
    const defaults = await loadDefaultSettingsForPlatform('linux');

    expect(defaults.voice.provider).toBe('openai-whisper');
  });

  it('uses parakeet-v3 model when local-parakeet is the default provider', async () => {
    const defaults = await loadDefaultSettingsForPlatform('darwin');

    expect(defaults.voice.provider).toBe('local-parakeet');
    expect(defaults.voice.model).toBe('parakeet-v3');
  });

  it('explicitly sets enablePriorTurnsHeader to false so new installs are gated off until opt-in', async () => {
    const defaults = await loadDefaultSettingsForPlatform('darwin');
    expect(defaults.enablePriorTurnsHeader).toBe(false);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });
});

describe('ensureNormalizedSettings guardrail logging (Stage 2b)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('logs purely undefined-vs-missing diffs at the top level in perf mode', async () => {
    vi.stubEnv('REBEL_PERF_MODE', '1');
    const isolated = await loadIsolatedSettingsStoreForGuardrailTests(
      (settings) => ({ ...settings, foo: undefined } as AppSettings)
    );

    isolated.settingsStore.store = isolated.DEFAULT_SETTINGS;
    const before = isolated.getSettingsNormalizationStats();
    isolated.ensureNormalizedSettings();
    const after = isolated.getSettingsNormalizationStats();

    expect(after.calls - before.calls).toBe(1);
    expect(after.writes - before.writes).toBe(1);
    expect(isolated.warn).toHaveBeenCalledTimes(1);
    expect(isolated.warn).toHaveBeenCalledWith(
      { keyPath: ['foo'], profilerChannel: 'perf-summary' },
      'normalize diff was undefined-vs-missing only — possible new emitter regression'
    );
  });

  it('logs purely undefined-vs-missing nested diffs in perf mode', async () => {
    vi.stubEnv('REBEL_PERF_MODE', '1');
    const isolated = await loadIsolatedSettingsStoreForGuardrailTests(
      (settings) => ({
        ...settings,
        models: {
          ...settings.models,
          oauthProfile: undefined,
        },
      } as AppSettings)
    );

    isolated.settingsStore.store = isolated.DEFAULT_SETTINGS;
    const before = isolated.getSettingsNormalizationStats();
    isolated.ensureNormalizedSettings();
    const after = isolated.getSettingsNormalizationStats();

    expect(after.calls - before.calls).toBe(1);
    expect(after.writes - before.writes).toBe(1);
    expect(isolated.warn).toHaveBeenCalledTimes(1);
    expect(isolated.warn).toHaveBeenCalledWith(
      { keyPath: ['models.oauthProfile'], profilerChannel: 'perf-summary' },
      'normalize diff was undefined-vs-missing only — possible new emitter regression'
    );
  });

  it('does not log when the diff includes a real value change, but still writes', async () => {
    vi.stubEnv('REBEL_PERF_MODE', '1');
    const isolated = await loadIsolatedSettingsStoreForGuardrailTests(
      (settings) => ({ ...settings, activeProvider: 'openrouter' } as AppSettings)
    );

    isolated.settingsStore.store = { ...isolated.DEFAULT_SETTINGS, activeProvider: 'anthropic' };
    const before = isolated.getSettingsNormalizationStats();
    isolated.ensureNormalizedSettings();
    const after = isolated.getSettingsNormalizationStats();

    expect(after.calls - before.calls).toBe(1);
    expect(after.writes - before.writes).toBe(1);
    expect(isolated.warn).not.toHaveBeenCalled();
  });

  it('skips guardrail detection when REBEL_PERF_MODE is unset, even for undefined-only diffs', async () => {
    const isolated = await loadIsolatedSettingsStoreForGuardrailTests(
      (settings) => ({ ...settings, foo: undefined } as AppSettings)
    );

    isolated.settingsStore.store = isolated.DEFAULT_SETTINGS;
    const before = isolated.getSettingsNormalizationStats();
    isolated.ensureNormalizedSettings();
    const after = isolated.getSettingsNormalizationStats();

    expect(after.calls - before.calls).toBe(1);
    expect(after.writes - before.writes).toBe(1);
    expect(isolated.warn).not.toHaveBeenCalled();
  });

  it('does not log mixed diffs that combine real changes with undefined-vs-missing paths', async () => {
    vi.stubEnv('REBEL_PERF_MODE', '1');
    const isolated = await loadIsolatedSettingsStoreForGuardrailTests(
      (settings) => ({
        ...settings,
        activeProvider: 'openrouter',
        claude: {
          ...settings.claude,
          oauthProfile: undefined,
        },
      } as AppSettings)
    );

    isolated.settingsStore.store = { ...isolated.DEFAULT_SETTINGS, activeProvider: 'anthropic' };
    const before = isolated.getSettingsNormalizationStats();
    isolated.ensureNormalizedSettings();
    const after = isolated.getSettingsNormalizationStats();

    expect(after.calls - before.calls).toBe(1);
    expect(after.writes - before.writes).toBe(1);
    expect(isolated.warn).not.toHaveBeenCalled();
  });
});
