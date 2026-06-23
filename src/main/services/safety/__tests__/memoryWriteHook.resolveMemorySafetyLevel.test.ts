/**
 * Tests for resolveMemorySafetyLevel (new simplified architecture)
 * 
 * Resolution order:
 * 1. Private Mode → always 'cautious'
 * 2. Unknown path → always 'cautious'  
 * 3. Chief-of-Staff → always 'permissive' (verified from local settings, NOT frontmatter)
 * 4. Per-space setting from spaceSafetyLevels or default 'balanced'
 * 5. SAFETY FLOOR: Shared spaces cannot be 'permissive'
 */

import { describe, it, expect } from 'vitest';
import { resolveMemorySafetyLevel, isStricter, isVerifiedChiefOfStaff } from '../memoryWriteHook';
import type { AppSettings, ModelSettings, SafetyLevel, SpaceConfig } from '@shared/types';

// Helper to create minimal settings for testing
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

describe('isStricter', () => {
  it('returns true when first level is stricter', () => {
    expect(isStricter('cautious', 'balanced')).toBe(true);
    expect(isStricter('cautious', 'permissive')).toBe(true);
    expect(isStricter('balanced', 'permissive')).toBe(true);
  });

  it('returns false when levels are equal', () => {
    expect(isStricter('cautious', 'cautious')).toBe(false);
    expect(isStricter('balanced', 'balanced')).toBe(false);
    expect(isStricter('permissive', 'permissive')).toBe(false);
  });

  it('returns false when first level is less strict', () => {
    expect(isStricter('balanced', 'cautious')).toBe(false);
    expect(isStricter('permissive', 'cautious')).toBe(false);
    expect(isStricter('permissive', 'balanced')).toBe(false);
  });
});

// Helper to create a basic SpaceConfig for testing
function createSpaceConfig(path: string, type: SpaceConfig['type'] = 'team', sharing: SpaceConfig['sharing'] = 'restricted'): SpaceConfig {
  return {
    name: path.split('/').pop() || path,
    path,
    type,
    sharing,
    isSymlink: false,
    createdAt: Date.now(),
  };
}

describe('isVerifiedChiefOfStaff', () => {
  it('returns true when space is configured as Chief-of-Staff in local settings', () => {
    const settings = createSettings({
      spaces: [createSpaceConfig('Chief-of-Staff', 'chief-of-staff', 'private')],
    });
    
    expect(isVerifiedChiefOfStaff('Chief-of-Staff', settings)).toBe(true);
  });

  it('returns false for non-Chief-of-Staff spaces', () => {
    const settings = createSettings({
      spaces: [
        createSpaceConfig('Chief-of-Staff', 'chief-of-staff', 'private'),
        createSpaceConfig('work/Acme/General', 'team', 'restricted'),
      ],
    });
    
    expect(isVerifiedChiefOfStaff('work/Acme/General', settings)).toBe(false);
  });

  it('returns false when spaces array is empty', () => {
    const settings = createSettings({ spaces: [] });
    expect(isVerifiedChiefOfStaff('Chief-of-Staff', settings)).toBe(false);
  });

  it('returns false when spaces is undefined', () => {
    const settings = createSettings({ spaces: undefined });
    expect(isVerifiedChiefOfStaff('Chief-of-Staff', settings)).toBe(false);
  });

  it('returns false when spacePath is null', () => {
    const settings = createSettings({
      spaces: [createSpaceConfig('Chief-of-Staff', 'chief-of-staff', 'private')],
    });
    expect(isVerifiedChiefOfStaff(null, settings)).toBe(false);
  });

  it('SECURITY: returns false for space with chief-of-staff in name but not in local settings', () => {
    // This tests that a malicious space claiming to be Chief-of-Staff in its README
    // will NOT be treated as Chief-of-Staff if it's not in local settings
    const settings = createSettings({
      spaces: [createSpaceConfig('work/Acme/Chief-of-Staff-Fake', 'team', 'restricted')],
    });
    
    expect(isVerifiedChiefOfStaff('work/Acme/Chief-of-Staff-Fake', settings)).toBe(false);
  });
});

describe('resolveMemorySafetyLevel', () => {
  describe('Private Mode', () => {
    it('returns cautious when privateMode is true, regardless of other settings', () => {
      const settings = createSettings({
        spaces: [createSpaceConfig('work/Acme/General', 'team', 'private')],
        spaceSafetyLevels: { 'work/Acme/General': 'permissive' },
      });
      
      const result = resolveMemorySafetyLevel(
        'work/Acme/General',
        'private',
        settings,
        true // privateMode
      );
      
      expect(result.level).toBe('cautious');
      expect(result.hasSpaceOverride).toBe(false);
    });

    it('returns cautious for Chief-of-Staff when privateMode is true', () => {
      const settings = createSettings({
        spaces: [createSpaceConfig('Chief-of-Staff', 'chief-of-staff', 'private')],
      });
      
      const result = resolveMemorySafetyLevel(
        'Chief-of-Staff',
        'private',
        settings,
        true // privateMode
      );
      
      expect(result.level).toBe('cautious');
    });
  });

  describe('Unknown path (not in any space)', () => {
    it('returns cautious when spacePath is null', () => {
      const settings = createSettings();
      
      const result = resolveMemorySafetyLevel(
        null, // no space path
        undefined,
        settings,
        false
      );
      
      expect(result.level).toBe('cautious');
      expect(result.hasSpaceOverride).toBe(false);
    });
  });

  describe('Chief-of-Staff (always permissive when verified)', () => {
    it('returns permissive for verified Chief-of-Staff regardless of spaceSafetyLevels', () => {
      const settings = createSettings({
        spaces: [createSpaceConfig('Chief-of-Staff', 'chief-of-staff', 'private')],
        spaceSafetyLevels: { 'Chief-of-Staff': 'cautious' }, // Should be ignored
      });
      
      const result = resolveMemorySafetyLevel(
        'Chief-of-Staff',
        'private',
        settings,
        false
      );
      
      expect(result.level).toBe('permissive');
      expect(result.hasSpaceOverride).toBe(false);
    });

    it('returns permissive for Chief-of-Staff even if sharing is set to restricted (edge case)', () => {
      const settings = createSettings({
        spaces: [createSpaceConfig('Chief-of-Staff', 'chief-of-staff', 'private')],
      });
      
      const result = resolveMemorySafetyLevel(
        'Chief-of-Staff',
        'restricted', // Edge case: CoS claimed as shared in frontmatter
        settings,
        false
      );
      
      // Chief-of-Staff is ALWAYS permissive when verified, regardless of sharing claim
      expect(result.level).toBe('permissive');
    });

    it('SECURITY: does NOT return permissive for unverified shared space claiming chief-of-staff type', () => {
      // A malicious space could set space_type: chief-of-staff in their README
      // but it should NOT get permissive treatment unless it's in local settings
      const settings = createSettings({
        spaces: [
          createSpaceConfig('Chief-of-Staff', 'chief-of-staff', 'private'), // Real CoS
          createSpaceConfig('work/Acme/FakeCoS', 'team', 'restricted'), // NOT chief-of-staff
        ],
      });
      
      // This space is NOT configured as chief-of-staff in local settings,
      // so even if its README claims space_type: chief-of-staff, we ignore it
      const result = resolveMemorySafetyLevel(
        'work/Acme/FakeCoS',
        'restricted', // Shared space — should get balanced default, not CoS permissive
        settings,
        false
      );
      
      // Should get default balanced, NOT permissive (CoS path not reached)
      expect(result.level).toBe('balanced');
    });
  });

  describe('Per-space settings (spaceSafetyLevels)', () => {
    it('uses spaceSafetyLevels value when present', () => {
      const settings = createSettings({
        spaceSafetyLevels: { 'work/Acme/Exec': 'cautious' },
      });
      
      const result = resolveMemorySafetyLevel(
        'work/Acme/Exec',
        'restricted',
        settings,
        false
      );
      
      expect(result.level).toBe('cautious');
      expect(result.hasSpaceOverride).toBe(true);
    });

    it('defaults to balanced for shared space when no spaceSafetyLevels entry exists', () => {
      const settings = createSettings({
        spaceSafetyLevels: {}, // Empty
      });
      
      const result = resolveMemorySafetyLevel(
        'work/Acme/General',
        'restricted',
        settings,
        false
      );
      
      expect(result.level).toBe('balanced');
      expect(result.hasSpaceOverride).toBe(false);
    });

    it('defaults to permissive for private space when no spaceSafetyLevels entry exists', () => {
      const settings = createSettings({
        spaceSafetyLevels: {}, // Empty — no override for this space
      });
      
      const result = resolveMemorySafetyLevel(
        'Personal',
        'private',
        settings,
        false
      );
      
      expect(result.level).toBe('permissive');
      expect(result.hasSpaceOverride).toBe(false);
    });

    it('defaults to balanced for legacy space (sharing undefined) when no spaceSafetyLevels entry exists', () => {
      const settings = createSettings({
        spaceSafetyLevels: {}, // Empty — no override for this space
      });
      
      const result = resolveMemorySafetyLevel(
        'work/Legacy/OldSpace',
        undefined, // Legacy space without frontmatter sharing field
        settings,
        false
      );
      
      expect(result.level).toBe('balanced');
      expect(result.hasSpaceOverride).toBe(false);
    });

    it('defaults to balanced when spaceSafetyLevels is undefined', () => {
      const settings = createSettings({
        spaceSafetyLevels: undefined,
      });
      
      const result = resolveMemorySafetyLevel(
        'work/BigCorp/General',
        'company-wide',
        settings,
        false
      );
      
      expect(result.level).toBe('balanced');
      expect(result.hasSpaceOverride).toBe(false);
    });
  });

  describe('Safety floor for shared spaces', () => {
    it('honours explicit permissive on restricted spaces (260525_approval_overasking_diagnostic.md)', () => {
      const settings = createSettings({
        spaceSafetyLevels: { 'work/Acme/General': 'permissive' },
      });

      const result = resolveMemorySafetyLevel(
        'work/Acme/General',
        'restricted',
        settings,
        false
      );

      expect(result.level).toBe('permissive'); // user choice honoured
      expect(result.hasSpaceOverride).toBe(true);
    });

    it('honours explicit permissive on company-wide spaces', () => {
      const settings = createSettings({
        spaceSafetyLevels: { 'work/BigCorp/Announcements': 'permissive' },
      });

      const result = resolveMemorySafetyLevel(
        'work/BigCorp/Announcements',
        'company-wide',
        settings,
        false
      );

      expect(result.level).toBe('permissive');
    });

    it('honours explicit permissive on public spaces', () => {
      const settings = createSettings({
        spaceSafetyLevels: { 'public/Blog': 'permissive' },
      });

      const result = resolveMemorySafetyLevel(
        'public/Blog',
        'public',
        settings,
        false
      );

      expect(result.level).toBe('permissive');
    });

    it('allows permissive for private spaces', () => {
      const settings = createSettings({
        spaceSafetyLevels: { 'Personal': 'permissive' },
      });
      
      const result = resolveMemorySafetyLevel(
        'Personal',
        'private',
        settings,
        false
      );
      
      expect(result.level).toBe('permissive'); // No floor for private
      expect(result.hasSpaceOverride).toBe(true);
    });

    it('allows cautious for shared spaces (stricter than floor)', () => {
      const settings = createSettings({
        spaceSafetyLevels: { 'work/Acme/Exec': 'cautious' },
      });

      const result = resolveMemorySafetyLevel(
        'work/Acme/Exec',
        'restricted',
        settings,
        false
      );

      expect(result.level).toBe('cautious');
    });

    it('treats undefined sharing as shared (conservative): permissive demoted to balanced', () => {
      const settings = createSettings({
        spaceSafetyLevels: { 'work/Legacy/OldSpace': 'permissive' },
      });

      const result = resolveMemorySafetyLevel(
        'work/Legacy/OldSpace',
        undefined, // No sharing set in frontmatter
        settings,
        false
      );

      // Undefined sharing isn't an explicit user choice — keep the
      // balanced floor. Explicit non-private sharing (covered above) is
      // honoured because it represents a deliberate setting.
      expect(result.level).toBe('balanced');
    });
  });

  describe('Combined scenarios', () => {
    it('private mode takes precedence over everything', () => {
      const settings = createSettings({
        spaceSafetyLevels: { 'Personal': 'permissive' },
      });
      
      const result = resolveMemorySafetyLevel(
        'Personal',
        'private',
        settings,
        true // privateMode
      );
      
      expect(result.level).toBe('cautious'); // Private mode wins
    });

    it('Chief-of-Staff beats private mode (but private mode wins)', () => {
      const settings = createSettings({
        spaces: [createSpaceConfig('Chief-of-Staff', 'chief-of-staff', 'private')],
      });
      
      // When private mode is on, even Chief-of-Staff becomes cautious
      const result = resolveMemorySafetyLevel(
        'Chief-of-Staff',
        'private',
        settings,
        true // privateMode
      );
      
      // Private mode is checked first and wins
      expect(result.level).toBe('cautious');
    });

    it('returns correct level for typical work space', () => {
      const settings = createSettings({
        spaceSafetyLevels: {
          'work/Acme/General': 'balanced',
          'work/Acme/Exec': 'cautious',
        },
      });
      
      // General space - balanced
      const general = resolveMemorySafetyLevel(
        'work/Acme/General',
        'restricted',
        settings,
        false
      );
      expect(general.level).toBe('balanced');
      expect(general.hasSpaceOverride).toBe(true);
      
      // Exec space - cautious
      const exec = resolveMemorySafetyLevel(
        'work/Acme/Exec',
        'restricted',
        settings,
        false
      );
      expect(exec.level).toBe('cautious');
      expect(exec.hasSpaceOverride).toBe(true);
    });
  });

  describe('Invalid settings validation', () => {
    it('defaults to cautious for invalid spaceSafetyLevels string value', () => {
      // This can happen if user manually edits settings.json with invalid value
      const settings = createSettings({
        spaceSafetyLevels: { 'work/Acme/General': 'invalid_value' as SafetyLevel },
      });
      
      const result = resolveMemorySafetyLevel(
        'work/Acme/General',
        'restricted',
        settings,
        false
      );
      
      // Invalid override should default to cautious (most restrictive)
      expect(result.level).toBe('cautious');
      expect(result.hasSpaceOverride).toBe(true); // A value was present
    });

    it('defaults to cautious for null spaceSafetyLevels value', () => {
      // This can happen if settings.json is corrupted or manually edited
      const settings = createSettings({
        spaceSafetyLevels: { 'work/Acme/General': null as unknown as SafetyLevel },
      });
      
      const result = resolveMemorySafetyLevel(
        'work/Acme/General',
        'restricted',
        settings,
        false
      );
      
      // Corrupted null value should fail closed to cautious
      expect(result.level).toBe('cautious');
      expect(result.hasSpaceOverride).toBe(true); // Key exists, even if null
    });

    it('defaults to balanced for missing spaceSafetyLevels entry on shared space', () => {
      const settings = createSettings({
        spaceSafetyLevels: {}, // No entry for this space
      });
      
      const result = resolveMemorySafetyLevel(
        'work/Acme/General',
        'restricted',
        settings,
        false
      );
      
      // Missing entry for shared space should default to balanced
      expect(result.level).toBe('balanced');
      expect(result.hasSpaceOverride).toBe(false);
    });

    it('accepts valid safety level values', () => {
      const settings = createSettings({
        spaceSafetyLevels: { 
          'space1': 'permissive',
          'space2': 'balanced',
          'space3': 'cautious',
        },
      });
      
      expect(resolveMemorySafetyLevel('space1', 'private', settings, false).level).toBe('permissive');
      expect(resolveMemorySafetyLevel('space2', 'private', settings, false).level).toBe('balanced');
      expect(resolveMemorySafetyLevel('space3', 'private', settings, false).level).toBe('cautious');
    });
  });

  describe('Lever B — explicit permissive on shared spaces (260525_approval_overasking_diagnostic.md)', () => {
    it('shared+permissive (explicit) resolves to permissive', () => {
      // Previously the safety floor coerced shared+permissive to balanced.
      // Now we honour the user's explicit choice; the auto-approve fast path
      // is scoped to private/CoS only, so non-private permissive falls
      // through to the LLM-eval branch downstream.
      const settings = createSettings({
        spaces: [createSpaceConfig('work/Acme/General', 'team', 'company-wide')],
        spaceSafetyLevels: { 'work/Acme/General': 'permissive' },
      });
      const result = resolveMemorySafetyLevel(
        'work/Acme/General',
        'company-wide',
        settings,
        false,
      );
      expect(result.level).toBe('permissive');
      expect(result.hasSpaceOverride).toBe(true);
    });

    it('shared with no override still defaults to balanced', () => {
      const settings = createSettings({
        spaces: [createSpaceConfig('work/Acme/General', 'team', 'company-wide')],
      });
      const result = resolveMemorySafetyLevel(
        'work/Acme/General',
        'company-wide',
        settings,
        false,
      );
      expect(result.level).toBe('balanced');
      expect(result.hasSpaceOverride).toBe(false);
    });

    it('private mode still forces cautious even with explicit permissive', () => {
      const settings = createSettings({
        spaces: [createSpaceConfig('work/Acme/General', 'team', 'company-wide')],
        spaceSafetyLevels: { 'work/Acme/General': 'permissive' },
      });
      const result = resolveMemorySafetyLevel(
        'work/Acme/General',
        'company-wide',
        settings,
        true, // private mode
      );
      expect(result.level).toBe('cautious');
    });

    it('reproduces the bda78829 fix: General space with explicit permissive resolves to permissive', () => {
      const settings = createSettings({
        spaces: [
          createSpaceConfig('Personal', 'personal', 'private'),
          createSpaceConfig('work/mindstone/General', 'team', 'company-wide'),
        ],
        spaceSafetyLevels: {
          Personal: 'permissive',
          'work/mindstone/General': 'permissive',
        },
      });
      expect(
        resolveMemorySafetyLevel('Personal', 'private', settings, false).level,
      ).toBe('permissive');
      expect(
        resolveMemorySafetyLevel('work/mindstone/General', 'company-wide', settings, false).level,
      ).toBe('permissive');
    });
  });
});
