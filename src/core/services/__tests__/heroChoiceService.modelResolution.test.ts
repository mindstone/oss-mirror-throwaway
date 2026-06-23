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

import { resolveHeroChoiceModel } from '../heroChoiceService';

function makeSettings(overrides: Record<string, unknown> = {}): AppSettings {
  return {
    models: undefined,
    claude: undefined,
    behindTheScenesOverrides: undefined,
    ...overrides,
  } as unknown as AppSettings;
}

describe('resolveHeroChoiceModel prefix decoding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('decodes model-prefixed override values', () => {
    const settings = makeSettings({
      behindTheScenesOverrides: { 'hero-choice': 'model:claude-haiku-4-5' },
    });

    expect(resolveHeroChoiceModel(settings)).toBe('claude-haiku-4-5');
  });

  it('falls through from empty-after-strip override to thinking model and warns', () => {
    const settings = makeSettings({
      behindTheScenesOverrides: { 'hero-choice': 'model:' },
      models: { thinkingModel: 'claude-opus-4-7' },
    });

    expect(resolveHeroChoiceModel(settings)).toBe('claude-opus-4-7');
    expect(logState.warn).toHaveBeenCalledTimes(1);
    expect(logState.warn).toHaveBeenCalledWith(
      {
        siteId: 'heroChoiceService:resolveHeroChoiceModel:override',
        rawTruncated: 'model:',
        rejectionReason: 'empty-model-id',
      },
      expect.stringContaining('empty model id'),
    );
  });

  it('falls through from override profile: literal to thinking model and warns', () => {
    const settings = makeSettings({
      behindTheScenesOverrides: { 'hero-choice': 'profile:' },
      models: { thinkingModel: 'claude-opus-4-7' },
    });

    expect(resolveHeroChoiceModel(settings)).toBe('claude-opus-4-7');
    expect(logState.warn).toHaveBeenCalledTimes(1);
    expect(logState.warn).toHaveBeenCalledWith(
      {
        siteId: 'heroChoiceService:resolveHeroChoiceModel:override',
        rawTruncated: 'profile:',
        rejectionReason: 'empty-profile-id',
      },
      expect.stringContaining('empty profile id'),
    );
  });

  it('falls through from whitespace-only override to thinking model and warns', () => {
    const settings = makeSettings({
      behindTheScenesOverrides: { 'hero-choice': '   ' },
      models: { thinkingModel: 'claude-opus-4-7' },
    });

    expect(resolveHeroChoiceModel(settings)).toBe('claude-opus-4-7');
    expect(logState.warn).toHaveBeenCalledTimes(1);
    expect(logState.warn).toHaveBeenCalledWith(
      {
        siteId: 'heroChoiceService:resolveHeroChoiceModel:override',
        rawTruncated: '   ',
        rejectionReason: 'empty-or-whitespace',
      },
      expect.stringContaining('empty or whitespace input'),
    );
  });

  it('falls through from non-string override to thinking model and warns with raw type', () => {
    const settings = makeSettings({
      behindTheScenesOverrides: { 'hero-choice': 42 },
      models: { thinkingModel: 'claude-opus-4-7' },
    });

    expect(resolveHeroChoiceModel(settings)).toBe('claude-opus-4-7');
    expect(logState.warn).toHaveBeenCalledTimes(1);
    expect(logState.warn).toHaveBeenCalledWith(
      {
        siteId: 'heroChoiceService:resolveHeroChoiceModel:override',
        rawType: 'number',
        rejectionReason: 'invalid-type',
      },
      expect.stringContaining('invalid type (not a string)'),
    );
  });

  it('uses thinking model when no override is configured', () => {
    const settings = makeSettings({
      models: { thinkingModel: 'claude-opus-4-7' },
    });

    expect(resolveHeroChoiceModel(settings)).toBe('claude-opus-4-7');
  });

  it('preserves profile override values', () => {
    const settings = makeSettings({
      behindTheScenesOverrides: { 'hero-choice': 'profile:abc-123' },
    });

    expect(resolveHeroChoiceModel(settings)).toBe('profile:abc-123');
  });
});
