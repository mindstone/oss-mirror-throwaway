import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';

const logState = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => logState,
}));

import { resolveConfiguredBtsModel } from '../agentTool';

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    behindTheScenesModel: undefined,
    behindTheScenesOverrides: undefined,
    ...overrides,
  } as AppSettings;
}

describe('resolveConfiguredBtsModel prefix decoding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('decodes category override model:claude-opus-4-7', () => {
    const settings = makeSettings({
      behindTheScenesOverrides: { 'hero-choice': 'model:claude-opus-4-7' },
    });

    expect(resolveConfiguredBtsModel(settings, 'hero-choice')).toBe('claude-opus-4-7');
  });

  it('falls through from empty-after-strip override to global and warns', () => {
    const settings = makeSettings({
      behindTheScenesOverrides: { 'hero-choice': 'model:' },
      behindTheScenesModel: 'model:gpt-5.4-mini',
    });

    expect(resolveConfiguredBtsModel(settings, 'hero-choice')).toBe('gpt-5.4-mini');
    expect(logState.warn).toHaveBeenCalledTimes(1);
    expect(logState.warn).toHaveBeenCalledWith(
      {
        siteId: 'agentTool:resolveConfiguredBtsModel:override',
        rawTruncated: 'model:',
        rejectionReason: 'empty-model-id',
      },
      expect.stringContaining('empty model id'),
    );
  });

  it('returns undefined and warns when global model: decodes to null', () => {
    const settings = makeSettings({
      behindTheScenesModel: 'model:',
    });

    expect(resolveConfiguredBtsModel(settings, 'hero-choice')).toBeUndefined();
    expect(logState.warn).toHaveBeenCalledTimes(1);
    expect(logState.warn).toHaveBeenCalledWith(
      {
        siteId: 'agentTool:resolveConfiguredBtsModel:global',
        rawTruncated: 'model:',
        rejectionReason: 'empty-model-id',
      },
      expect.stringContaining('empty model id'),
    );
  });

  it('returns undefined and warns when global profile: has an empty profile id', () => {
    const settings = makeSettings({
      behindTheScenesModel: 'profile:',
    });

    expect(resolveConfiguredBtsModel(settings, 'hero-choice')).toBeUndefined();
    expect(logState.warn).toHaveBeenCalledTimes(1);
    expect(logState.warn).toHaveBeenCalledWith(
      {
        siteId: 'agentTool:resolveConfiguredBtsModel:global',
        rawTruncated: 'profile:',
        rejectionReason: 'empty-profile-id',
      },
      expect.stringContaining('empty profile id'),
    );
  });

  it('falls through from whitespace-only override to global and warns with rejection reason', () => {
    const settings = makeSettings({
      behindTheScenesOverrides: { 'hero-choice': '   ' },
      behindTheScenesModel: 'model:gpt-5.4-mini',
    });

    expect(resolveConfiguredBtsModel(settings, 'hero-choice')).toBe('gpt-5.4-mini');
    expect(logState.warn).toHaveBeenCalledTimes(1);
    expect(logState.warn).toHaveBeenCalledWith(
      {
        siteId: 'agentTool:resolveConfiguredBtsModel:override',
        rawTruncated: '   ',
        rejectionReason: 'empty-or-whitespace',
      },
      expect.stringContaining('empty or whitespace input'),
    );
  });

  it('falls through from non-string override to global and warns with raw type', () => {
    const settings = makeSettings({
      behindTheScenesOverrides: { 'hero-choice': 42 } as unknown as AppSettings['behindTheScenesOverrides'],
      behindTheScenesModel: 'model:gpt-5.4-mini',
    });

    expect(resolveConfiguredBtsModel(settings, 'hero-choice')).toBe('gpt-5.4-mini');
    expect(logState.warn).toHaveBeenCalledTimes(1);
    expect(logState.warn).toHaveBeenCalledWith(
      {
        siteId: 'agentTool:resolveConfiguredBtsModel:override',
        rawType: 'number',
        rejectionReason: 'invalid-type',
      },
      expect.stringContaining('invalid type (not a string)'),
    );
  });

  it('returns undefined for non-string global input and warns with raw type', () => {
    const settings = makeSettings({
      behindTheScenesModel: 42,
    } as unknown as Partial<AppSettings>);

    expect(resolveConfiguredBtsModel(settings, 'hero-choice')).toBeUndefined();
    expect(logState.warn).toHaveBeenCalledTimes(1);
    expect(logState.warn).toHaveBeenCalledWith(
      {
        siteId: 'agentTool:resolveConfiguredBtsModel:global',
        rawType: 'number',
        rejectionReason: 'invalid-type',
      },
      expect.stringContaining('invalid type (not a string)'),
    );
  });

  it('uses decoded global model when no category override exists', () => {
    const settings = makeSettings({
      behindTheScenesModel: 'model:gpt-5.4-mini',
    });

    expect(resolveConfiguredBtsModel(settings, 'hero-choice')).toBe('gpt-5.4-mini');
  });

  it('preserves profile override values', () => {
    const settings = makeSettings({
      behindTheScenesOverrides: { 'hero-choice': 'profile:abc-123' },
    });

    expect(resolveConfiguredBtsModel(settings, 'hero-choice')).toBe('profile:abc-123');
  });
});
