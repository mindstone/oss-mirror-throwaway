/**
 * Tests for the extracted memorySafetyLevels module.
 *
 * Imports DIRECTLY from `../memorySafetyLevels` (the new home) so the direct
 * path is exercised. The pre-existing `memoryWriteHook.resolveMemorySafetyLevel.test.ts`
 * imports the same functions via the `../memoryWriteHook` re-export facade, so the
 * two suites together cover both import paths (belt-and-suspenders: a broken
 * re-export fails one suite while the direct definition stays green).
 *
 * Adds direct unit coverage for `shouldSkipSecretGateForPermissive`, which
 * previously had only indirect coverage via the broad memoryWriteHook suite and
 * leversAdversarial security tests.
 */

import { describe, it, expect } from 'vitest';
import {
  shouldSkipSecretGateForPermissive,
  isVerifiedChiefOfStaff,
  resolveMemorySafetyLevel,
  isStricter,
} from '../memorySafetyLevels';
import type { AppSettings, ModelSettings, SpaceConfig } from '@shared/types';

type SettingsOverrides = Partial<Omit<AppSettings, 'models'>> & {
  models?: Partial<ModelSettings>;
};

function createSettings(overrides: SettingsOverrides = {}): AppSettings {
  const { models: modelOverrides, ...rootOverrides } = overrides;
  const models: ModelSettings = {
    apiKey: null,
    oauthToken: null,
    authMethod: 'api-key',
    model: 'claude-sonnet-4-5-20250514',
    permissionMode: 'bypassPermissions',
    executablePath: null,
    planMode: true,
    extendedContext: true,
    thinkingEffort: 'high',
    ...modelOverrides,
  };
  return {
    coreDirectory: '/workspace',
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    voice: {
      provider: 'openai-whisper',
      openaiApiKey: null,
      elevenlabsApiKey: null,
      model: 'gpt-4o-mini-transcribe-2025-12-15',
      ttsVoice: 'nova',
      activationHotkey: null,
      activationHotkeyVoiceMode: true,
    },
    models,
    diagnostics: {
      debugBreadcrumbsUntil: null,
    },
    ...rootOverrides,
  };
}

function createSpaceConfig(
  path: string,
  type: SpaceConfig['type'] = 'team',
  sharing: SpaceConfig['sharing'] = 'restricted'
): SpaceConfig {
  return {
    name: path.split('/').pop() || path,
    path,
    type,
    sharing,
    isSymlink: false,
    createdAt: Date.now(),
  };
}

describe('memorySafetyLevels — direct-import smoke', () => {
  it('re-exported symbols are importable directly from the new module', () => {
    expect(typeof isStricter).toBe('function');
    expect(typeof isVerifiedChiefOfStaff).toBe('function');
    expect(typeof shouldSkipSecretGateForPermissive).toBe('function');
    expect(typeof resolveMemorySafetyLevel).toBe('function');
  });
});

describe('shouldSkipSecretGateForPermissive', () => {
  it('bypasses the gate for a verified Chief-of-Staff space (even with undefined sharing)', () => {
    // FOX-3072: CoS authority comes from settings, not frontmatter sharing.
    const settings = createSettings({
      spaces: [createSpaceConfig('Chief-of-Staff', 'chief-of-staff', 'private')],
    });

    expect(shouldSkipSecretGateForPermissive('Chief-of-Staff', settings, undefined)).toBe(true);
  });

  it('bypasses the gate for a verified Chief-of-Staff space regardless of frontmatter sharing', () => {
    const settings = createSettings({
      spaces: [createSpaceConfig('Chief-of-Staff', 'chief-of-staff', 'private')],
    });

    // Even if frontmatter claims a shared value, CoS verification wins.
    expect(shouldSkipSecretGateForPermissive('Chief-of-Staff', settings, 'company-wide')).toBe(true);
  });

  it('bypasses the gate for explicit private frontmatter sharing (non-CoS)', () => {
    const settings = createSettings({
      spaces: [createSpaceConfig('work/Acme/Private', 'team', 'private')],
    });

    expect(shouldSkipSecretGateForPermissive('work/Acme/Private', settings, 'private')).toBe(true);
  });

  it('runs the gate (returns false) for non-private, non-CoS spaces', () => {
    const settings = createSettings({
      spaces: [createSpaceConfig('work/Acme/General', 'team', 'restricted')],
    });

    expect(shouldSkipSecretGateForPermissive('work/Acme/General', settings, 'restricted')).toBe(false);
    expect(shouldSkipSecretGateForPermissive('work/Acme/General', settings, 'company-wide')).toBe(false);
    expect(shouldSkipSecretGateForPermissive('work/Acme/General', settings, 'public')).toBe(false);
  });

  it('runs the gate (returns false) when sharing is undefined and space is not CoS', () => {
    const settings = createSettings({
      spaces: [createSpaceConfig('work/Acme/General', 'team', 'restricted')],
    });

    expect(shouldSkipSecretGateForPermissive('work/Acme/General', settings, undefined)).toBe(false);
  });

  it('SECURITY: a fake chief-of-staff path not in local settings does NOT bypass', () => {
    const settings = createSettings({
      spaces: [createSpaceConfig('work/Acme/Chief-of-Staff-Fake', 'team', 'restricted')],
    });

    expect(shouldSkipSecretGateForPermissive('work/Acme/Chief-of-Staff-Fake', settings, undefined)).toBe(false);
  });

  it('runs the gate (returns false) when spacePath is null and sharing is not private', () => {
    const settings = createSettings({ spaces: [] });
    expect(shouldSkipSecretGateForPermissive(null, settings, undefined)).toBe(false);
    expect(shouldSkipSecretGateForPermissive(null, settings, 'restricted')).toBe(false);
  });

  it('bypasses (returns true) when spacePath is null but sharing is explicitly private', () => {
    const settings = createSettings({ spaces: [] });
    expect(shouldSkipSecretGateForPermissive(null, settings, 'private')).toBe(true);
  });
});
