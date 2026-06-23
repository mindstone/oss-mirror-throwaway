import { describe, it, expect } from 'vitest';
import { computeSettingsDrift, providerFallbackLine } from '../UsageTooltipContent';
import type { UsageData } from '../UsageTooltipContent';
import type { TurnFallback } from '@shared/types';

describe('computeSettingsDrift', () => {
  it('should return empty array when no drift', () => {
    const usage: UsageData = { thinkingEffort: 'high', authMethod: 'api-key' };
    expect(computeSettingsDrift(usage, 'high', 'api-key')).toEqual([]);
  });

  it('should detect thinking effort change', () => {
    const usage: UsageData = { thinkingEffort: 'high' };
    const result = computeSettingsDrift(usage, 'low');
    expect(result).toEqual([
      { field: 'Thinking', turnValue: 'High', currentValue: 'Low' },
    ]);
  });

  it('should detect auth method change', () => {
    const usage: UsageData = { authMethod: 'api-key' };
    const result = computeSettingsDrift(usage, undefined, 'oauth-token');
    expect(result).toEqual([
      { field: 'Auth', turnValue: 'API Key', currentValue: 'Claude Subscription (deprecated)' },
    ]);
  });

  it('should detect both changes simultaneously', () => {
    const usage: UsageData = { thinkingEffort: 'high', authMethod: 'oauth-token' };
    const result = computeSettingsDrift(usage, 'medium', 'api-key');
    expect(result).toHaveLength(2);
    expect(result[0].field).toBe('Thinking');
    expect(result[1].field).toBe('Auth');
  });

  it('should return empty when turn has no settings data', () => {
    const usage: UsageData = {};
    expect(computeSettingsDrift(usage, 'high', 'api-key')).toEqual([]);
  });

  it('should return empty when current settings are undefined', () => {
    const usage: UsageData = { thinkingEffort: 'high', authMethod: 'api-key' };
    expect(computeSettingsDrift(usage, undefined, undefined)).toEqual([]);
  });

  it('should use human-readable labels', () => {
    const usage: UsageData = { thinkingEffort: 'medium', authMethod: 'oauth-token' };
    const result = computeSettingsDrift(usage, 'high', 'api-key');
    expect(result[0]).toEqual({ field: 'Thinking', turnValue: 'Medium', currentValue: 'High' });
    expect(result[1]).toEqual({ field: 'Auth', turnValue: 'Claude Subscription (deprecated)', currentValue: 'API Key' });
  });
});

describe('providerFallbackLine (paid-fallback indicator)', () => {
  const base = {
    type: 'provider' as const,
    from: 'anthropic-api-key',
    reason: 'multi-provider-rate-limit-failover',
  };

  it('renders a pay-as-you-go line for pay-per-use', () => {
    const fb: TurnFallback = { ...base, to: 'openrouter-oauth-token', billingSource: 'pay-per-use' };
    expect(providerFallbackLine(fb)).toBe('Switched to OpenRouter — pay-as-you-go');
  });

  it('renders a using-your-credits line for pool', () => {
    const fb: TurnFallback = { ...base, to: 'openrouter-oauth-token', billingSource: 'pool' };
    expect(providerFallbackLine(fb)).toBe('Switched to OpenRouter — using your credits');
  });

  it('renders a covered line for subscription', () => {
    const fb: TurnFallback = { ...base, to: 'mindstone-managed-key', billingSource: 'subscription' };
    expect(providerFallbackLine(fb)).toBe('Switched to Rebel — covered');
  });

  it('renders a plain line for local billing (no billing claim)', () => {
    const fb: TurnFallback = { ...base, to: 'local-none', billingSource: 'local' };
    expect(providerFallbackLine(fb)).toBe('Switched to your local model');
  });

  it('renders a plain line when billingSource is absent (legacy/unpatched)', () => {
    const fb: TurnFallback = { ...base, to: 'codex-subscription' };
    expect(providerFallbackLine(fb)).toBe('Switched to ChatGPT');
  });

  it('stays honest when the turn never landed (to still auto-failover)', () => {
    const fb: TurnFallback = { ...base, to: 'auto-failover' };
    expect(providerFallbackLine(fb)).toBe('Switched providers after a rate limit');
  });

  it('never leaks the raw credential-source enum to the user surface', () => {
    const fb: TurnFallback = { ...base, to: 'openrouter-oauth-token', billingSource: 'pay-per-use' };
    expect(providerFallbackLine(fb)).not.toContain('openrouter-oauth-token');
  });

  // MUST-ADDRESS 1 (GPT review): the OLDER flag-OFF Codex failover writes
  // type:'provider' records with reason:'codex-rate-limit' and a REAL destination
  // (e.g. 'openrouter'/'anthropic', not a credential-source id). Those must keep
  // their previous `Provider: {from} → {to}` rendering — NOT the Stage-4b copy and
  // NOT the never-landed copy.
  it('keeps the legacy Provider line for the flag-OFF Codex failover (codex-rate-limit) → real destination preserved', () => {
    const fb: TurnFallback = {
      type: 'provider',
      from: 'codex/openai',
      to: 'openrouter',
      reason: 'codex-rate-limit',
    };
    const line = providerFallbackLine(fb);
    expect(line).toBe('Provider: codex/openai → openrouter');
    // Regression guard: must NOT collapse to the never-landed copy.
    expect(line).not.toBe('Switched providers after a rate limit');
    // Real destination is preserved verbatim.
    expect(line).toContain('openrouter');
  });

  it('keeps the legacy Provider line for an anthropic Codex-failover destination', () => {
    const fb: TurnFallback = {
      type: 'provider',
      from: 'codex/openai',
      to: 'anthropic',
      reason: 'codex-rate-limit',
    };
    expect(providerFallbackLine(fb)).toBe('Provider: codex/openai → anthropic');
  });
});
