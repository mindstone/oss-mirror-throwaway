import { describe, expect, it } from 'vitest';
import {
  PROVIDER_PRESETS,
  getKnownContextWindowForModel,
  getKnownContextWindowForProfile,
  getKnownMaxOutputForModel,
} from '../modelProviderPresets';

describe('modelProviderPresets context window metadata', () => {
  it('returns known windows for supported OpenAI preset models', () => {
    expect(getKnownContextWindowForModel('gpt-5.2')).toBe(400000);
    expect(getKnownContextWindowForModel('gpt-4.1')).toBe(1047576);
    expect(getKnownContextWindowForModel('o3')).toBe(200000);
  });

  it('returns known windows for gpt-5.4 / gpt-5.5 / gpt-5.5-pro (added in compaction-failure fixes)', () => {
    expect(getKnownContextWindowForModel('gpt-5.4')).toBe(400000);
    expect(getKnownContextWindowForModel('gpt-5.5')).toBe(400000);
    expect(getKnownContextWindowForModel('gpt-5.5-pro')).toBe(400000);
  });

  it('returns the same 400K window for the broader gpt-5.x reasoning family (regression guard)', () => {
    expect(getKnownContextWindowForModel('gpt-5')).toBe(400000);
    expect(getKnownContextWindowForModel('gpt-5.1')).toBe(400000);
    expect(getKnownContextWindowForModel('gpt-5.3-codex')).toBe(400000);
  });

  it('returns known windows for supported Gemini preset models', () => {
    expect(getKnownContextWindowForModel('gemini-2.5-pro')).toBe(1047576);
    expect(getKnownContextWindowForModel('gemini-3-flash-preview')).toBe(1047576);
  });

  it('returns catalog preset windows for OpenRouter SDK model aliases', () => {
    expect(getKnownContextWindowForModel('claude-opus-4-7')).toBe(1_000_000);
    expect(getKnownContextWindowForModel('claude-sonnet-4-6')).toBe(1_000_000);
  });

  it('returns null when a model window is unknown', () => {
    expect(getKnownContextWindowForModel('llama-3.3-70b')).toBeNull();
    expect(getKnownContextWindowForModel('gpt-future-9')).toBeNull();
  });

  it('prefers an explicit profile context window override', () => {
    expect(getKnownContextWindowForProfile({
      model: 'gpt-5.2',
      contextWindow: 123456,
    })).toBe(123456);
  });
});

describe('getKnownMaxOutputForModel — dated-id normalization', () => {
  it('resolves an exact (undated) OpenRouter preset id', () => {
    expect(getKnownMaxOutputForModel('openai/gpt-5.5')).not.toBeNull();
  });

  it('resolves a dated OpenRouter id to the same cap as its undated form', () => {
    const undated = getKnownMaxOutputForModel('openai/gpt-5.5');
    expect(undated).not.toBeNull();
    // `-20260301` (YYYYMMDD) dated suffix must strip down to the undated preset,
    // instead of missing and forcing resolveModelLimits() to the 32768 default.
    expect(getKnownMaxOutputForModel('openai/gpt-5.5-20260301')).toBe(undated);
    // `-YYYY-MM-DD` form too.
    expect(getKnownMaxOutputForModel('openai/gpt-5.5-2026-03-01')).toBe(undated);
  });

  it('only strips genuine date suffixes — no over-match', () => {
    // A real undated preset id resolves to a concrete positive cap via exact lookup.
    const cap = getKnownMaxOutputForModel('openai/gpt-5.5');
    expect(typeof cap).toBe('number');
    expect(cap as number).toBeGreaterThan(0);
    // A trailing 4-digit number that is NOT a date pattern (regex needs \d{8} or
    // YYYY-MM-DD) must NOT be stripped → stays null, not coerced to the gpt-5.5 cap.
    expect(getKnownMaxOutputForModel('openai/gpt-5.5-1234')).toBeNull();
    // A genuine date suffix IS stripped, but if the undated form is unknown the result
    // stays null — stripping never fabricates a cap for an unknown base id.
    expect(getKnownMaxOutputForModel('made-up-model-20260301')).toBeNull();
    // An unknown id with no date stays null.
    expect(getKnownMaxOutputForModel('totally-unknown-model')).toBeNull();
  });
});

describe('Claude Fable 5 not featured while access withdrawn (2026-06)', () => {
  const orModelValues = PROVIDER_PRESETS.openrouter.models.map((m) => m.value);
  const orPresetModels = (PROVIDER_PRESETS.openrouter.presetProfiles ?? []).map((p) => p.template.model);

  it('the one-click preset profiles no longer feature Fable (R1)', () => {
    // The app shouldn't offer a one-click add for a model that 404s. Re-add the
    // Fable preset profile when access returns.
    expect(orPresetModels).not.toContain('anthropic/claude-fable-5');
    expect(orPresetModels).toContain('anthropic/claude-opus-4-8');
  });

  it('Fable stays in the OR model registry (.models) for metadata/consistency', () => {
    // .models doubles as the OR metadata registry; check-model-registry-consistency
    // enforces OR_MODEL_CATALOG ⊆ .models, so a hidden model must remain here.
    // Fable is hidden from the MAIN/role pickers via its catalog
    // isMainModel/isAuxiliaryModel flags instead (see modelCatalog.test.ts).
    expect(orModelValues).toContain('anthropic/claude-fable-5');
  });
});
