import { afterEach, describe, it, expect, vi } from 'vitest';
import { getVisibleCloudProviders, resolveHelpUrl } from '../cloudProviders.config';

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__REBEL_IS_OSS__;
});

describe('OSS provider visibility', () => {
  it('omits Mindstone Cloud from the explicit OSS-visible provider list', () => {
    const providers = getVisibleCloudProviders({ isOss: true });

    expect(providers.map((provider) => provider.id)).toEqual(['fly', 'digitalocean', 'hetzner']);
  });

  it('keeps Mindstone Cloud in the enterprise-visible provider list', () => {
    const providers = getVisibleCloudProviders({ isOss: false });

    expect(providers.map((provider) => provider.id)).toContain('mindstone');
  });

  it('exports CLOUD_PROVIDERS without Mindstone when rendererIsOss() is true at module load', async () => {
    vi.resetModules();
    (globalThis as Record<string, unknown>).__REBEL_IS_OSS__ = true;

    const mod = await import('../cloudProviders.config');

    expect(mod.CLOUD_PROVIDERS.map((provider) => provider.id)).toEqual(['fly', 'digitalocean', 'hetzner']);
  });
});

describe('resolveHelpUrl', () => {
  describe('Fly billing deep-link (org-aware)', () => {
    it('deep-links to the org-specific billing page when providerContext.orgSlug is present', () => {
      const url = resolveHelpUrl('fly', 'provider_billing', { orgSlug: 'acme-org' });
      expect(url).toBe('https://fly.io/dashboard/acme-org/billing');
    });

    it('falls back to the personal billing page when no org slug is supplied', () => {
      const url = resolveHelpUrl('fly', 'provider_billing');
      expect(url).toBe('https://fly.io/dashboard/personal/billing');
    });

    it('URL-encodes org slugs with unusual characters', () => {
      const url = resolveHelpUrl('fly', 'provider_billing', { orgSlug: 'my org/x' });
      expect(url).toBe('https://fly.io/dashboard/my%20org%2Fx/billing');
    });

    it('does not apply the Fly org rewrite to other providers', () => {
      // DO has its own provider_billing URL; providing orgSlug must not alter it.
      const url = resolveHelpUrl('digitalocean', 'provider_billing', { orgSlug: 'irrelevant' });
      expect(url).toBe('https://cloud.digitalocean.com/account/billing');
    });
  });

  describe('SSO token help', () => {
    it('resolves sso_token_help to the Fly CLI org-tokens doc, not the personal token page', () => {
      const url = resolveHelpUrl('fly', 'sso_token_help');
      expect(url).toBe('https://fly.io/docs/flyctl/tokens-create-org/');
    });
  });

  describe('Unsupported cases', () => {
    it('returns undefined when helpKey is undefined', () => {
      expect(resolveHelpUrl('fly', undefined)).toBeUndefined();
    });

    it('returns undefined when provider has no URL for that helpKey', () => {
      // Hetzner has no dns_setup in our config? verify gracefully.
      expect(resolveHelpUrl('hetzner', 'sso_token_help')).toBeUndefined();
    });

    it('falls back to Fly config for unknown providerId', () => {
      // getProviderConfig falls back to Fly; provider_billing should still resolve.
      const url = resolveHelpUrl('made-up-provider', 'provider_billing');
      expect(url).toBe('https://fly.io/dashboard/personal/billing');
    });
  });
});
