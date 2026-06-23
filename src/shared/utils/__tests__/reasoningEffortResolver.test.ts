import { describe, expect, it } from 'vitest';
import { resolveReasoningEffort } from '../reasoningEffortResolver';

describe('resolveReasoningEffort', () => {
  it('uses the supplied default when every effort source is unset', () => {
    expect(resolveReasoningEffort({ defaultEffort: 'high' })).toBe('high');
  });

  it('can preserve optional lower-level behavior when no default is supplied', () => {
    expect(resolveReasoningEffort({})).toBeUndefined();
  });

  it('uses global effort over the default', () => {
    expect(resolveReasoningEffort({
      globalEffort: 'medium',
      defaultEffort: 'high',
    })).toBe('medium');
  });

  it('uses per-model effort over global effort', () => {
    expect(resolveReasoningEffort({
      modelId: 'claude-opus-4-8',
      modelEfforts: { 'claude-opus-4-8': 'xhigh' },
      globalEffort: 'low',
      defaultEffort: 'high',
    })).toBe('xhigh');
  });

  it('treats skill effort as a floor over per-model/global/default effort', () => {
    expect(resolveReasoningEffort({
      globalEffort: 'low',
      skillEfforts: ['medium', 'high'],
      defaultEffort: 'high',
    })).toBe('high');
  });

  it('does not let skill effort downgrade the per-model/global/default effort', () => {
    expect(resolveReasoningEffort({
      modelId: 'claude-opus-4-8',
      modelEfforts: { 'claude-opus-4-8': 'xhigh' },
      globalEffort: 'low',
      skillEfforts: ['low'],
      defaultEffort: 'high',
    })).toBe('xhigh');
  });

  it('uses profile effort over skill and per-model/global/default effort', () => {
    expect(resolveReasoningEffort({
      modelId: 'claude-opus-4-8',
      modelEfforts: { 'claude-opus-4-8': 'xhigh' },
      globalEffort: 'low',
      profileEffort: 'medium',
      skillEfforts: ['max'],
      defaultEffort: 'high',
    })).toBe('medium');
  });

  it('maps profile effort max to xhigh', () => {
    expect(resolveReasoningEffort({
      globalEffort: 'low',
      profileEffort: 'max',
      defaultEffort: 'high',
    })).toBe('xhigh');
  });

  it('uses session override over profile, skill, per-model, global, and default effort', () => {
    expect(resolveReasoningEffort({
      sessionEffort: 'low',
      modelId: 'claude-opus-4-8',
      modelEfforts: { 'claude-opus-4-8': 'xhigh' },
      globalEffort: 'medium',
      profileEffort: 'high',
      skillEfforts: ['max'],
      defaultEffort: 'high',
    })).toBe('low');
  });

  it('uses valid shell env override over every other effort source', () => {
    expect(resolveReasoningEffort({
      envEffort: ' Medium ',
      sessionEffort: 'low',
      modelId: 'claude-opus-4-8',
      modelEfforts: { 'claude-opus-4-8': 'xhigh' },
      globalEffort: 'high',
      profileEffort: 'xhigh',
      skillEfforts: ['max'],
      defaultEffort: 'high',
    })).toBe('medium');
  });

  it('ignores invalid shell env override and falls through to session override', () => {
    expect(resolveReasoningEffort({
      envEffort: 'max',
      sessionEffort: 'medium',
      profileEffort: 'xhigh',
      defaultEffort: 'high',
    })).toBe('medium');
  });
});
