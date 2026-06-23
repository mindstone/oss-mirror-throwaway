/**
 * Tests for migrateToSpaceSafetyLevels
 * 
 * Migration principles:
 * 1. Chief-of-Staff → NOT stored (it's hardcoded in resolution)
 * 2. Other spaces → take strictest of existing local settings
 * 3. Never make things less strict during migration
 * 4. Default to 'balanced' for all non-CoS spaces without explicit settings
 */

import { describe, it, expect } from 'vitest';
import { migrateToSpaceSafetyLevels } from '../settingsUtils';
import type { AppSettings, ModelSettings, SpaceConfig } from '../../types';

type SettingsOverrides = Partial<Omit<AppSettings, 'claude' | 'models'>> & {
  claude?: Partial<ModelSettings>;
  models?: Partial<ModelSettings>;
};

// Helper to create minimal settings for testing
function createSettings(overrides: SettingsOverrides = {}): AppSettings {
  const { claude: claudeOverrides, models: modelsOverrides, ...rootOverrides } = overrides;
  const baseModels: ModelSettings = {
    apiKey: null,
    oauthToken: null,
    authMethod: 'api-key',
    model: 'claude-sonnet-4-5-20250514',
    permissionMode: 'bypassPermissions',
    executablePath: null,
    planMode: true,
    extendedContext: true,
    thinkingEffort: 'high',
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
    ...(claudeOverrides ? { claude: { ...baseModels, ...claudeOverrides } } : {}),
    models: { ...baseModels, ...(claudeOverrides ?? {}), ...(modelsOverrides ?? {}) },
    diagnostics: {
      debugBreadcrumbsUntil: null,
    },
    ...rootOverrides,
  };
}

// Helper to create space configs
function createSpace(path: string, type: SpaceConfig['type'], sharing?: SpaceConfig['sharing']): SpaceConfig {
  return {
    name: path.split('/').pop() || path,
    path,
    type,
    isSymlink: false,
    createdAt: Date.now(),
    sharing,
  };
}

describe('migrateToSpaceSafetyLevels', () => {
  describe('Skip conditions', () => {
    it('returns existing spaceSafetyLevels if already populated', () => {
      const existingLevels = { 'work/Acme/General': 'cautious' as const };
      const settings = createSettings({
        spaceSafetyLevels: existingLevels,
        memorySafetyPrivate: 'permissive', // Would normally trigger migration
      });
      const spaces = [createSpace('work/Acme/General', 'team', 'restricted')];
      
      const result = migrateToSpaceSafetyLevels(settings, spaces);
      
      expect(result).toEqual(existingLevels);
    });

    it('returns undefined for fresh install with no legacy settings', () => {
      const settings = createSettings({
        // No legacy settings
        spaceSafetyOverrides: undefined,
        memorySafetyBySharing: undefined,
        memorySafetyPrivate: undefined,
        memorySafetyShared: undefined,
      });
      const spaces = [createSpace('work/Acme/General', 'team', 'restricted')];
      
      const result = migrateToSpaceSafetyLevels(settings, spaces);
      
      // Returns empty object (not undefined) to ensure new resolver is always used
      // This prevents fallback to legacy resolution which has different defaults
      expect(result).toEqual({});
    });
  });

  describe('Chief-of-Staff handling', () => {
    it('skips Chief-of-Staff (not stored in spaceSafetyLevels)', () => {
      const settings = createSettings({
        memorySafetyPrivate: 'permissive',
      });
      const spaces = [
        createSpace('Chief-of-Staff', 'chief-of-staff', 'private'),
        createSpace('work/Acme/General', 'team', 'restricted'),
      ];
      
      const result = migrateToSpaceSafetyLevels(settings, spaces);
      
      expect(result).toBeDefined();
      expect(result!['Chief-of-Staff']).toBeUndefined();
      expect(result!['work/Acme/General']).toBeDefined();
    });
  });

  describe('Tier 3 migration (spaceSafetyOverrides)', () => {
    it('migrates spaceSafetyOverrides levels', () => {
      const settings = createSettings({
        spaceSafetyOverrides: [
          { spacePath: 'work/Acme/Exec', spaceName: 'Exec', level: 'cautious', addedAt: Date.now() },
        ],
      });
      const spaces = [createSpace('work/Acme/Exec', 'team', 'restricted')];
      
      const result = migrateToSpaceSafetyLevels(settings, spaces);
      
      expect(result!['work/Acme/Exec']).toBe('cautious');
    });

    it('includes orphaned overrides not in spaces list', () => {
      const settings = createSettings({
        spaceSafetyOverrides: [
          { spacePath: 'work/Deleted/Space', spaceName: 'Deleted Space', level: 'cautious', addedAt: Date.now() },
        ],
      });
      const spaces: SpaceConfig[] = []; // Space was deleted
      
      const result = migrateToSpaceSafetyLevels(settings, spaces);
      
      expect(result!['work/Deleted/Space']).toBe('cautious');
    });
  });

  describe('Tier 2 migration (memorySafetyBySharing)', () => {
    it('uses memorySafetyBySharing for spaces with matching sharing level', () => {
      const settings = createSettings({
        memorySafetyBySharing: {
          restricted: 'cautious',
        },
      });
      const spaces = [createSpace('work/Acme/General', 'team', 'restricted')];
      
      const result = migrateToSpaceSafetyLevels(settings, spaces);
      
      expect(result!['work/Acme/General']).toBe('cautious');
    });

    it('handles company-wide sharing level', () => {
      const settings = createSettings({
        memorySafetyBySharing: {
          'company-wide': 'balanced',
        },
      });
      const spaces = [createSpace('work/BigCorp/Announcements', 'company', 'company-wide')];
      
      const result = migrateToSpaceSafetyLevels(settings, spaces);
      
      expect(result!['work/BigCorp/Announcements']).toBe('balanced');
    });

    it('ignores memorySafetyBySharing for private spaces', () => {
      const settings = createSettings({
        memorySafetyBySharing: {
          restricted: 'cautious',
        },
        memorySafetyPrivate: 'permissive',
      });
      const spaces = [createSpace('Personal', 'personal', 'private')];
      
      const result = migrateToSpaceSafetyLevels(settings, spaces);
      
      // Should NOT use memorySafetyBySharing.restricted for private space
      // Instead uses memorySafetyPrivate, but baseline is 'balanced', and
      // 'permissive' is not stricter than 'balanced', so result is 'balanced'
      expect(result!['Personal']).toBe('balanced');
    });
  });

  describe('Tier 1 migration (base defaults)', () => {
    it('uses memorySafetyPrivate for private spaces', () => {
      const settings = createSettings({
        memorySafetyPrivate: 'cautious',
      });
      const spaces = [createSpace('Personal', 'personal', 'private')];
      
      const result = migrateToSpaceSafetyLevels(settings, spaces);
      
      expect(result!['Personal']).toBe('cautious');
    });

    it('uses memorySafetyShared for non-private spaces', () => {
      const settings = createSettings({
        memorySafetyShared: 'cautious',
      });
      const spaces = [createSpace('work/Acme/General', 'team', 'restricted')];
      
      const result = migrateToSpaceSafetyLevels(settings, spaces);
      
      expect(result!['work/Acme/General']).toBe('cautious');
    });
  });

  describe('Strictest-wins behavior', () => {
    it('takes strictest of Tier 3 override and baseline', () => {
      const settings = createSettings({
        spaceSafetyOverrides: [
          { spacePath: 'work/Acme/General', spaceName: 'General', level: 'permissive', addedAt: Date.now() },
        ],
        memorySafetyShared: 'cautious',
      });
      const spaces = [createSpace('work/Acme/General', 'team', 'restricted')];
      
      const result = migrateToSpaceSafetyLevels(settings, spaces);
      
      // Tier 3 says 'permissive', but Tier 1 says 'cautious'
      // Baseline is 'balanced', Tier 3 'permissive' is not stricter
      // Tier 1 'cautious' is strictest
      expect(result!['work/Acme/General']).toBe('cautious');
    });

    it('takes strictest of all tiers combined', () => {
      const settings = createSettings({
        spaceSafetyOverrides: [
          { spacePath: 'work/Acme/General', spaceName: 'General', level: 'balanced', addedAt: Date.now() },
        ],
        memorySafetyBySharing: {
          restricted: 'cautious',
        },
        memorySafetyShared: 'permissive',
      });
      const spaces = [createSpace('work/Acme/General', 'team', 'restricted')];
      
      const result = migrateToSpaceSafetyLevels(settings, spaces);
      
      // Tier 3: balanced, Tier 2: cautious, Tier 1: permissive
      // Strictest is 'cautious'
      expect(result!['work/Acme/General']).toBe('cautious');
    });
  });

  describe('Edge cases', () => {
    it('handles empty spaces array', () => {
      const settings = createSettings({
        memorySafetyShared: 'cautious',
      });
      
      const result = migrateToSpaceSafetyLevels(settings, []);
      
      expect(result).toBeUndefined();
    });

    it('handles undefined spaces', () => {
      const settings = createSettings({
        memorySafetyShared: 'cautious',
      });
      
      const result = migrateToSpaceSafetyLevels(settings, undefined);
      
      expect(result).toBeUndefined();
    });

    it('handles spaces without sharing field (legacy)', () => {
      const settings = createSettings({
        memorySafetyShared: 'cautious',
      });
      const spaces = [createSpace('work/Legacy/Space', 'team', undefined)];
      
      const result = migrateToSpaceSafetyLevels(settings, spaces);
      
      // Should use memorySafetyShared for spaces without sharing
      expect(result!['work/Legacy/Space']).toBe('cautious');
    });

    it('migrates multiple spaces correctly', () => {
      const settings = createSettings({
        spaceSafetyOverrides: [
          { spacePath: 'work/Acme/Exec', spaceName: 'Exec', level: 'cautious', addedAt: Date.now() },
        ],
        memorySafetyBySharing: {
          restricted: 'balanced',
        },
        memorySafetyPrivate: 'permissive',
      });
      const spaces = [
        createSpace('Chief-of-Staff', 'chief-of-staff', 'private'),
        createSpace('Personal', 'personal', 'private'),
        createSpace('work/Acme/General', 'team', 'restricted'),
        createSpace('work/Acme/Exec', 'team', 'restricted'),
      ];
      
      const result = migrateToSpaceSafetyLevels(settings, spaces);
      
      expect(result!['Chief-of-Staff']).toBeUndefined(); // Skipped
      expect(result!['Personal']).toBe('balanced'); // baseline balanced, private permissive not stricter
      expect(result!['work/Acme/General']).toBe('balanced'); // Tier 2 balanced
      expect(result!['work/Acme/Exec']).toBe('cautious'); // Tier 3 override
    });
  });
});
