import { describe, it, expect } from 'vitest';
import { toCanonicalModelId, isSameModel } from '../modelIdentity';

describe('toCanonicalModelId', () => {
  it('collapses the dated OpenRouter snapshot, the provider-prefixed alias, the bare alias, and the [1m] suffix to ONE canonical key (the diagnosed Turn-Usage bug)', () => {
    // These four spellings all refer to Claude Opus 4.8. The renderer used to show the
    // served snapshot and the configured alias as two separate "Opus" rows because it
    // compared raw strings. They must canonicalize identically.
    const spellings = [
      'anthropic/claude-4.8-opus-20260528', // provider-served dated snapshot (the "Working" row)
      'anthropic/claude-opus-4-8',          // provider-prefixed alias (the "Thinking" row)
      'claude-opus-4-8',                    // bare catalog alias
      'claude-opus-4-8[1m]',                // extended-context suffix
    ];
    const canonicals = spellings.map((s) => toCanonicalModelId(s).canonical);
    expect(new Set(canonicals).size).toBe(1);
  });

  it('treats provider/model and bare forms of the same model as equal', () => {
    expect(isSameModel('deepseek/deepseek-v4-pro', 'deepseek-v4-pro')).toBe(true);
  });

  it('keeps genuinely different models distinct', () => {
    expect(isSameModel('claude-opus-4-8', 'deepseek-v4-pro')).toBe(false);
    expect(isSameModel('anthropic/claude-4.8-opus-20260528', 'deepseek/deepseek-v4-pro')).toBe(false);
  });

  it('does NOT collapse two different UNKNOWN provider-prefixed models to the same canonical (no over-collapse)', () => {
    // Regression guard for the Stage-3 review F1: stripping the provider prefix for unknown models
    // would wrongly merge providerA/foo and providerB/foo into "foo" and mis-bind role->usage.
    expect(isSameModel('providerA/foo', 'providerB/foo')).toBe(false);
    expect(toCanonicalModelId('providerA/foo').canonical).toBe('providera/foo');
    expect(toCanonicalModelId('providerB/foo').canonical).toBe('providerb/foo');
  });

  it('reports provenance via the source field', () => {
    expect(toCanonicalModelId('claude-opus-4-8').source).toBe('alias');
    expect(toCanonicalModelId('anthropic/claude-4.8-opus-20260528').source).toBe('openrouter');
    expect(toCanonicalModelId('some-local-model-xyz').source).toBe('raw');
  });

  it('never returns null and falls back to a normalized raw id for unknown/local models', () => {
    const r = toCanonicalModelId('My-Local-Model[1m]');
    expect(r.source).toBe('raw');
    expect(r.canonical).toBe('my-local-model'); // lowercased, [1m] stripped
    expect(r.raw).toBe('My-Local-Model[1m]');
  });

  it('is safe on empty / whitespace input', () => {
    expect(toCanonicalModelId('').canonical).toBe('');
    expect(toCanonicalModelId('   ').canonical).toBe('');
    // @ts-expect-error guarding the runtime null path even though the type says string
    expect(toCanonicalModelId(undefined).canonical).toBe('');
  });

  it('preserves the original raw string verbatim', () => {
    expect(toCanonicalModelId('anthropic/claude-4.8-opus-20260528').raw).toBe('anthropic/claude-4.8-opus-20260528');
  });
});
