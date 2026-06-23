import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  getEffectiveThinkingModel,
  getEffectiveWorkingModel,
  materializeModelsFromLegacy,
  resolveEffectiveModelSettings,
  resolveModelSettings,
  toBareModelId,
  type ResolvedModelSettings,
} from '../modelSettingsResolver';
import { DEFAULT_MODEL } from '../modelNormalization';
import type { ModelProfile } from '../../types';

const makeProfile = (overrides: Partial<ModelProfile> = {}): ModelProfile => ({
  id: 'p-test',
  name: 'Test Profile',
  serverUrl: 'https://example.invalid/v1',
  model: 'mock-model',
  createdAt: 0,
  ...overrides,
});

describe('toBareModelId', () => {
  // Invariant #1 cases — provider-aware bare-id helper.
  it('returns bare ids unchanged', () => {
    expect(toBareModelId('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });

  it('strips anthropic/ prefix when activeProvider is anthropic', () => {
    expect(toBareModelId('anthropic/claude-sonnet-4-6', { activeProvider: 'anthropic' })).toBe(
      'claude-sonnet-4-6',
    );
  });

  it('strips anthropic/ prefix when activeProvider is undefined (default direct-Anthropic)', () => {
    expect(toBareModelId('anthropic/claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });

  it('preserves anthropic/ prefix when activeProvider is openrouter', () => {
    expect(toBareModelId('anthropic/claude-sonnet-4-6', { activeProvider: 'openrouter' })).toBe(
      'anthropic/claude-sonnet-4-6',
    );
  });

  it('preserves cross-provider openai/ prefix regardless of activeProvider', () => {
    expect(toBareModelId('openai/gpt-5.5')).toBe('openai/gpt-5.5');
    expect(toBareModelId('openai/gpt-5.5', { activeProvider: 'anthropic' })).toBe('openai/gpt-5.5');
    expect(toBareModelId('openai/gpt-5.5', { activeProvider: 'openrouter' })).toBe('openai/gpt-5.5');
  });

  it('preserves deepseek-ai/ prefix', () => {
    expect(toBareModelId('deepseek-ai/DeepSeek-V4-Pro')).toBe('deepseek-ai/DeepSeek-V4-Pro');
  });

  it('preserves meta-llama/ prefix', () => {
    expect(toBareModelId('meta-llama/llama-3.1')).toBe('meta-llama/llama-3.1');
  });

  it('throws on empty input', () => {
    expect(() => toBareModelId('')).toThrow(/empty/i);
    expect(() => toBareModelId('   ')).toThrow(/empty/i);
  });

  it('throws on double anthropic/anthropic/ prefix', () => {
    expect(() => toBareModelId('anthropic/anthropic/claude-sonnet-4-6')).toThrow(/invalid/i);
  });

  it('does NOT dot-normalize (divergence from resolveAnthropicWireModel)', () => {
    expect(toBareModelId('claude-opus-4.7')).toBe('claude-opus-4.7');
    expect(toBareModelId('anthropic/claude-opus-4.7', { activeProvider: 'anthropic' })).toBe(
      'claude-opus-4.7',
    );
  });
});

describe('resolveEffectiveModelSettings', () => {
  // Invariant #1 — empty input returns DEFAULT_MODEL with thinkingModel undefined.
  it('returns DEFAULT_MODEL when input is empty', () => {
    const resolved = resolveEffectiveModelSettings({});
    expect(resolved.workingModel).toBe(DEFAULT_MODEL);
    expect(resolved.thinkingModel).toBeUndefined();
    expect(resolved.workingProfile).toBeUndefined();
    expect(resolved.thinkingProfile).toBeUndefined();
  });

  it('returns DEFAULT_MODEL when input is null/undefined', () => {
    expect(resolveEffectiveModelSettings(null).workingModel).toBe(DEFAULT_MODEL);
    expect(resolveEffectiveModelSettings(undefined).workingModel).toBe(DEFAULT_MODEL);
  });

  // Runtime cutover — models is the only runtime namespace.
  it('reads from models namespace and ignores stale claude', () => {
    const resolved = resolveEffectiveModelSettings({
      models: { model: 'claude-opus-4-7' } as never,
      claude: { model: 'legacy-model' } as never,
    });
    expect(resolved.workingModel).toBe('claude-opus-4-7');
  });

  it('does not fall back to claude when models does not have the key', () => {
    const resolved = resolveEffectiveModelSettings({
      models: { thinkingModel: 'claude-opus-4-7' } as never,
      claude: { model: 'claude-haiku-3-5' } as never,
    });
    expect(resolved.workingModel).toBe(DEFAULT_MODEL);
    expect(resolved.thinkingModel).toBe('claude-opus-4-7');
  });

  // Invariant #4 — null user-clear in models is authoritative (does NOT fall through).
  it('respects null user-clear in models namespace (does not fall back to claude)', () => {
    const resolved = resolveEffectiveModelSettings({
      models: { thinkingModel: undefined, model: 'claude-sonnet-4-6', thinkingProfileId: null } as never,
      claude: { thinkingProfileId: 'should-not-leak' } as never,
    });
    expect(resolved.thinkingProfileId).toBeNull();
  });

  // Invariant #1 — bare-id normalization on the working model.
  it('strips anthropic/ prefix from working model', () => {
    const resolved = resolveEffectiveModelSettings({
      models: { model: 'anthropic/claude-sonnet-4-6' } as never,
    });
    expect(resolved.workingModel).toBe('claude-sonnet-4-6');
  });

  // Invariant #1 — bare-id normalization preserves cross-provider prefixes.
  it('preserves cross-provider prefix on working model', () => {
    const resolved = resolveEffectiveModelSettings(
      {
        models: { model: 'anthropic/claude-sonnet-4-6' } as never,
      },
      { activeProvider: 'openrouter' },
    );
    expect(resolved.workingModel).toBe('anthropic/claude-sonnet-4-6');
  });

  // Invariant #6 — profile lookup by id from localModel.
  it('resolves working profile by id from localModel.profiles', () => {
    const profile = makeProfile({ id: 'p-1', model: 'gpt-5.5' });
    const resolved = resolveEffectiveModelSettings({
      models: { workingProfileId: 'p-1' } as never,
      localModel: { profiles: [profile], activeProfileId: undefined } as never,
    });
    expect(resolved.workingProfile?.id).toBe('p-1');
    expect(resolved.workingModel).toBe('gpt-5.5');
  });

  // Invariant #7 — malformed namespace (non-object/array) throws by default.
  it('throws when models namespace is malformed (array)', () => {
    expect(() =>
      resolveEffectiveModelSettings({ models: [] as never }),
    ).toThrow(/malformed/i);
  });

  it('ignores malformed claude namespace at runtime', () => {
    expect(() =>
      resolveEffectiveModelSettings({ claude: 'broken' as never }),
    ).not.toThrow();
  });

  // Invariant #5 — observability: throwOnMalformed:false invokes onMalformed callback.
  it('invokes onMalformed callback when throwOnMalformed:false', () => {
    let observed: { reason: string; ctx: { settingsKeys: string[] } } | undefined;
    const resolved = resolveEffectiveModelSettings(
      { models: 'broken' as never },
      {
        throwOnMalformed: false,
        onMalformed: (reason, ctx) => {
          observed = { reason, ctx };
        },
      },
    );
    expect(observed?.reason).toMatch(/models/);
    expect(resolved.workingModel).toBe(DEFAULT_MODEL);
  });

  // Invariant #5 (silent-degradation closer) — falls back to console.warn when
  // throwOnMalformed:false and no onMalformed handler is provided.
  it('warns to console when throwOnMalformed:false and no onMalformed handler', () => {
    const original = console.warn;
    let warned = false;
    console.warn = () => {
      warned = true;
    };
    try {
      const resolved = resolveEffectiveModelSettings(
        { models: 'broken' as never },
        { throwOnMalformed: false },
      );
      expect(resolved.workingModel).toBe(DEFAULT_MODEL);
      expect(warned).toBe(true);
    } finally {
      console.warn = original;
    }
  });

  // Invariant #8 — idempotence (deep-equal under repeated calls).
  it('is idempotent: repeated calls produce deep-equal output', () => {
    const settings = {
      models: { model: 'anthropic/claude-sonnet-4-6', thinkingModel: 'claude-opus-4-7' } as never,
    };
    const a = resolveEffectiveModelSettings(settings);
    const b = resolveEffectiveModelSettings(settings);
    expect(a).toEqual(b);
  });

  // Invariant — per-tier helpers parity with resolved view.
  it('per-tier helpers match resolveEffectiveModelSettings output', () => {
    const settings = {
      models: {
        model: 'anthropic/claude-sonnet-4-6',
        thinkingModel: 'claude-opus-4-7',
      } as never,
    };
    const resolved: ResolvedModelSettings = resolveEffectiveModelSettings(settings);
    expect(getEffectiveWorkingModel(settings)).toBe(resolved.workingModel);
    expect(getEffectiveThinkingModel(settings)).toBe(resolved.thinkingModel);
  });

  // Invariant — pass-through fields (effort, fallbacks, modelEfforts).
  it('passes through thinking effort, fallbacks, and modelEfforts', () => {
    const resolved = resolveEffectiveModelSettings({
      models: {
        model: 'claude-sonnet-4-6',
        thinkingEffort: 'high',
        workingFallback: 'model:claude-haiku-3-5',
        thinkingFallback: 'profile:p-1',
        modelEfforts: { 'claude-opus-4-7': 'xhigh' },
      } as never,
    });
    expect(resolved.thinkingEffort).toBe('high');
    expect(resolved.workingFallback).toBe('model:claude-haiku-3-5');
    expect(resolved.thinkingFallback).toBe('profile:p-1');
    expect(resolved.modelEfforts).toEqual({ 'claude-opus-4-7': 'xhigh' });
  });

  // Invariant #11 — JSDoc decision-rule block presence ratchet.
  it('JSDoc decision-rule block is present at the top of modelSettingsResolver.ts', () => {
    const source = readFileSync(
      resolve(__dirname, '../modelSettingsResolver.ts'),
      'utf8',
    );
    expect(source).toMatch(/Decision Rule/);
    expect(source).toMatch(/per-field accessors/i);
    expect(source).toMatch(/per-tier helpers/i);
    expect(source).toMatch(/resolveEffectiveModelSettings/);
  });
});

describe('materializeModelsFromLegacy', () => {
  it('composes legacy claude fields when models lacks the key', () => {
    expect(materializeModelsFromLegacy({
      models: { thinkingModel: 'claude-opus-4-7' } as never,
      claude: { model: 'claude-haiku-3-5' } as never,
    })).toMatchObject({
      model: 'claude-haiku-3-5',
      thinkingModel: 'claude-opus-4-7',
    });
  });

  it('preserves present-null values from models as authoritative clears', () => {
    expect(materializeModelsFromLegacy({
      models: { apiKey: null } as never,
      claude: { apiKey: 'fake-ant-legacy-stale' } as never,
    }).apiKey).toBeNull();
  });

  it('keeps runtime resolveModelSettings models-only', () => {
    expect(resolveModelSettings({
      models: {},
      claude: { model: 'claude-haiku-3-5' },
    } as never).model).toBeUndefined();
  });
});
