/**
 * Tests for the user-facing credential-source friendly-name mapper
 * (docs/plans/260621_paid-fallback-indicator/).
 *
 * The mapper must be EXHAUSTIVE over `PROVIDER_CREDENTIAL_SOURCES` (the
 * `assertNever` default guarantees a compile error if a value is missing, and
 * this test guards the runtime contract too) and must NEVER leak a raw enum to
 * the user surface.
 */

import { describe, expect, it } from 'vitest';
import { credentialSourceToFriendlyName } from '../credentialSourceFriendlyName';
import { PROVIDER_CREDENTIAL_SOURCES } from '../../types/providerRoute';

describe('credentialSourceToFriendlyName', () => {
  it('returns a non-empty, non-raw-enum name for every credential source (exhaustive)', () => {
    for (const cs of PROVIDER_CREDENTIAL_SOURCES) {
      const name = credentialSourceToFriendlyName(cs);
      expect(name.length).toBeGreaterThan(0);
      // No raw enum string should leak to the user surface.
      expect(name).not.toBe(cs);
      expect(name).not.toMatch(/-(api-key|oauth-token|subscription|managed-key|none)$/);
      expect(name).not.toMatch(/^missing-/);
    }
  });

  it('maps the common failover destinations to brand-friendly names', () => {
    expect(credentialSourceToFriendlyName('openrouter-oauth-token')).toBe('OpenRouter');
    expect(credentialSourceToFriendlyName('mindstone-managed-key')).toBe('Rebel');
    expect(credentialSourceToFriendlyName('codex-subscription')).toBe('ChatGPT');
    expect(credentialSourceToFriendlyName('anthropic-api-key')).toBe('your Anthropic key');
  });
});
