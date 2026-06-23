import { describe, expect, it, vi } from 'vitest';
import {
  resolveDefaultModelForRole,
  type ModelRoleResolverSettings,
} from '../modelRoleResolver';

function makeSettings(
  overrides: Partial<ModelRoleResolverSettings> = {},
): ModelRoleResolverSettings {
  return {
    models: undefined,
    localModel: { activeProfileId: null, profiles: [] },
    behindTheScenesModel: undefined,
    ...overrides,
  };
}

describe('resolveDefaultModelForRole fast-role prefix decoding', () => {
  it('decodes model:claude-haiku-4-5 to bare model id', () => {
    expect(resolveDefaultModelForRole('background', makeSettings({
      behindTheScenesModel: 'model:claude-haiku-4-5',
    }), [])).toEqual({
      ok: true,
      role: 'background',
      source: 'setting',
      model: 'claude-haiku-4-5',
    });
  });

  it('decodes model:gpt-5.4-mini to bare model id', () => {
    expect(resolveDefaultModelForRole('background', makeSettings({
      behindTheScenesModel: 'model:gpt-5.4-mini',
    }), [])).toEqual({
      ok: true,
      role: 'background',
      source: 'setting',
      model: 'gpt-5.4-mini',
    });
  });

  it('falls back to DEFAULT_AUXILIARY_MODEL when model: decodes to null and warns', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveDefaultModelForRole('background', makeSettings({
        behindTheScenesModel: 'model:',
      }), [])).toEqual({
        ok: true,
        role: 'background',
        source: 'setting',
        model: 'claude-haiku-4-5',
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('empty model id'),
        {
          siteId: 'modelRoleResolver:resolveFastRole',
          rawTruncated: 'model:',
          rejectionReason: 'empty-model-id',
        },
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('returns role-key failure when profile: has an empty profile id and warns', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveDefaultModelForRole('background', makeSettings({
        behindTheScenesModel: 'profile:',
      }), [])).toEqual({
        ok: false,
        role: 'background',
        reason: 'role-key-references-unknown-profile',
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('empty profile id'),
        {
          siteId: 'modelRoleResolver:resolveFastRole',
          rawTruncated: 'profile:',
          rejectionReason: 'empty-profile-id',
        },
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('falls back to DEFAULT_AUXILIARY_MODEL when BTS is whitespace-only and warns', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveDefaultModelForRole('background', makeSettings({
        behindTheScenesModel: '   ',
      }), [])).toEqual({
        ok: true,
        role: 'background',
        source: 'setting',
        model: 'claude-haiku-4-5',
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('empty or whitespace input'),
        {
          siteId: 'modelRoleResolver:resolveFastRole',
          rawTruncated: '   ',
          rejectionReason: 'empty-or-whitespace',
        },
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('falls back to DEFAULT_AUXILIARY_MODEL when BTS is non-string and warns with raw type', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveDefaultModelForRole('background', makeSettings({
        behindTheScenesModel: 42,
      } as unknown as Partial<ModelRoleResolverSettings>), [])).toEqual({
        ok: true,
        role: 'background',
        source: 'setting',
        model: 'claude-haiku-4-5',
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('invalid type (not a string)'),
        {
          siteId: 'modelRoleResolver:resolveFastRole',
          rawType: 'number',
          rejectionReason: 'invalid-type',
        },
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('preserves profile:abc-123 for downstream profile resolution', () => {
    expect(resolveDefaultModelForRole('background', makeSettings({
      behindTheScenesModel: 'profile:abc-123',
    }), [])).toEqual({
      ok: false,
      role: 'background',
      reason: 'role-key-references-unknown-profile',
      profileId: 'abc-123',
    });
  });
});
