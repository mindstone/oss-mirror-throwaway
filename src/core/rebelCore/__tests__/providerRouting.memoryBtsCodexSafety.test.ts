import { describe, expect, it } from 'vitest';

import { selectProviderMode, type ProviderRouteSettings } from '../providerRouting';

/**
 * FOX-3481 Stage 2 safety lock-in.
 *
 * Stage 2 suppresses the active working profile for plain-model memory BTS turns
 * (`workingProfileOverrideId: ''`) so the turn executes on the configured BTS model
 * (e.g. gpt-5.4-mini) rather than the inherited working profile. The safety concern
 * was: could suppressing the working profile strand a bare model without Codex auth
 * (→ "OpenAI requires an API key") for a Codex/ChatGPT-Pro user?
 *
 * Answer (verified): NO. Codex auth is derived from the ACTIVE PROVIDER, not from any
 * working profile. With `activeProvider: 'codex'`, the provider mode resolves to
 * codex-subscription regardless of whether a profile is present — so a profile-less
 * (bare-model) memory turn still routes through the codex subscription/proxy, never
 * the Anthropic path. This test pins that invariant so a regression in
 * `selectProviderMode` can't silently re-introduce the auth-stranding risk.
 */
describe('selectProviderMode — codex auth is provider-derived, not profile-derived (FOX-3481 Stage 2)', () => {
  it('codex active provider → codex-subscription (no profile required)', () => {
    const mode = selectProviderMode({ activeProvider: 'codex' } as ProviderRouteSettings);
    expect(mode).toEqual({ provider: 'codex', credentialSource: 'codex-subscription' });
  });

  it('codex routing never collapses to an Anthropic credential source', () => {
    const mode = selectProviderMode({ activeProvider: 'codex' } as ProviderRouteSettings);
    expect(mode.provider).toBe('codex');
    expect(mode.credentialSource).not.toMatch(/anthropic/);
  });
});
