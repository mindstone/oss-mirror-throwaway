import { describe, expect, it } from 'vitest';
import { SafeModeErrorCategorySchema } from '@shared/ipc/schemas/common';
import {
  SAFE_MODE_CATEGORY_GUIDANCE,
  SAFE_MODE_CATEGORY_PROMPT_GUIDANCE,
  getSafeModeCategoryGuidance,
  getSafeModeCategoryPromptGuidance,
} from '../safeModeCategoryGuidance';

describe('safe mode category guidance', () => {
  it('has user guidance for every SafeModeErrorCategory', () => {
    expect(Object.keys(SAFE_MODE_CATEGORY_GUIDANCE).sort()).toEqual(
      [...SafeModeErrorCategorySchema.options].sort(),
    );

    for (const category of SafeModeErrorCategorySchema.options) {
      expect(SAFE_MODE_CATEGORY_GUIDANCE[category], category).toEqual(expect.any(String));
      expect(SAFE_MODE_CATEGORY_GUIDANCE[category].trim().length, category).toBeGreaterThan(0);
    }
  });

  it('uses the requested recovery copy for the new startup categories', () => {
    expect(SAFE_MODE_CATEGORY_GUIDANCE.missing_bundle).toBe(
      'Part of Rebel\'s bundled tools runtime is missing. Reinstalling or updating Rebel usually fixes this. Safe Mode keeps the app usable while you check Settings → Advanced.',
    );
    expect(SAFE_MODE_CATEGORY_GUIDANCE.spawn_missing_executable).toContain('Security software may be blocking Rebel\'s tools runtime');
    expect(SAFE_MODE_CATEGORY_GUIDANCE.fs_exhaustion).toContain('too many files open');
    expect(SAFE_MODE_CATEGORY_GUIDANCE.health_timeout).toContain('restart the connection in Settings → Advanced');
  });

  it('has cause-oriented prompt guidance for every SafeModeErrorCategory', () => {
    expect(Object.keys(SAFE_MODE_CATEGORY_PROMPT_GUIDANCE).sort()).toEqual(
      [...SafeModeErrorCategorySchema.options].sort(),
    );

    for (const category of SafeModeErrorCategorySchema.options) {
      expect(SAFE_MODE_CATEGORY_PROMPT_GUIDANCE[category], category).toContain('Diagnostic hypotheses:');
      expect(SAFE_MODE_CATEGORY_PROMPT_GUIDANCE[category], category).toContain('- ');
    }

    expect(SAFE_MODE_CATEGORY_PROMPT_GUIDANCE.process_crash).toContain('zombie Node process');
    expect(SAFE_MODE_CATEGORY_PROMPT_GUIDANCE.process_crash).toContain('File locks from a previous crash');
    expect(SAFE_MODE_CATEGORY_PROMPT_GUIDANCE.process_crash).toContain('Antivirus or quarantine');
  });

  it('falls back to unknown guidance when no category is supplied', () => {
    expect(getSafeModeCategoryGuidance()).toBe(SAFE_MODE_CATEGORY_GUIDANCE.unknown);
    expect(getSafeModeCategoryPromptGuidance()).toBe(SAFE_MODE_CATEGORY_PROMPT_GUIDANCE.unknown);
  });
});
