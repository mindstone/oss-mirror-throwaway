import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';

import { resolveDailySparkModel } from '../dailySparkService';

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    behindTheScenesModel: undefined,
    behindTheScenesOverrides: undefined,
    ...overrides,
  } as AppSettings;
}

describe('resolveDailySparkModel prefix decoding', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses decoded override when present', () => {
    const settings = makeSettings({
      behindTheScenesOverrides: { 'hero-choice': 'model:claude' },
      behindTheScenesModel: 'model:gpt-5.4-mini',
    });

    expect(resolveDailySparkModel(settings)).toBe('claude');
  });

  it('uses decoded global when override is absent', () => {
    const settings = makeSettings({
      behindTheScenesModel: 'model:claude',
    });

    expect(resolveDailySparkModel(settings)).toBe('claude');
  });

  it('uses Dash-shaped global model when override is absent', () => {
    const settings = makeSettings({
      behindTheScenesModel: 'deepseek/deepseek-v4-flash',
    });

    expect(resolveDailySparkModel(settings)).toBe('deepseek/deepseek-v4-flash');
  });

  it('honors hero-choice override over Dash-shaped global model', () => {
    const settings = makeSettings({
      behindTheScenesOverrides: { 'hero-choice': 'mistral-large' },
      behindTheScenesModel: 'deepseek/deepseek-v4-flash',
    });

    expect(resolveDailySparkModel(settings)).toBe('mistral-large');
  });

  it('falls back to DAILY_SPARK_DEFAULT_MODEL when override and global are absent', () => {
    expect(resolveDailySparkModel(makeSettings())).toBe('claude-haiku-4-5');
  });

  it('falls through from empty-after-strip override to decoded global and warns', () => {
    const settings = makeSettings({
      behindTheScenesOverrides: { 'hero-choice': 'model:' },
      behindTheScenesModel: 'model:claude',
    });

    expect(resolveDailySparkModel(settings)).toBe('claude');
  });

  it('falls back to DAILY_SPARK_DEFAULT_MODEL and warns when global model: decodes to null', () => {
    const settings = makeSettings({
      behindTheScenesModel: 'model:',
    });

    expect(resolveDailySparkModel(settings)).toBe('claude-haiku-4-5');
  });

  it('falls back to DAILY_SPARK_DEFAULT_MODEL and warns when global profile: has an empty profile id', () => {
    const settings = makeSettings({
      behindTheScenesModel: 'profile:',
    });

    expect(resolveDailySparkModel(settings)).toBe('claude-haiku-4-5');
  });

  it('falls through from override profile: literal to global and warns', () => {
    const settings = makeSettings({
      behindTheScenesOverrides: { 'hero-choice': 'profile:' },
      behindTheScenesModel: 'model:claude',
    });

    expect(resolveDailySparkModel(settings)).toBe('claude');
  });

  it('falls through from whitespace-only override to global and warns', () => {
    const settings = makeSettings({
      behindTheScenesOverrides: { 'hero-choice': '   ' },
      behindTheScenesModel: 'model:claude',
    });

    expect(resolveDailySparkModel(settings)).toBe('claude');
  });

  it('falls through from non-string override to global and warns with raw type', () => {
    const settings = makeSettings({
      behindTheScenesOverrides: { 'hero-choice': 42 } as unknown as AppSettings['behindTheScenesOverrides'],
      behindTheScenesModel: 'model:claude',
    });

    expect(resolveDailySparkModel(settings)).toBe('claude');
  });

  it('preserves profile override values', () => {
    const settings = makeSettings({
      behindTheScenesOverrides: { 'hero-choice': 'profile:abc' },
    });

    expect(resolveDailySparkModel(settings)).toBe('profile:abc');
  });
});
