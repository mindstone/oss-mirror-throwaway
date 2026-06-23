import { describe, it, expect } from 'vitest';
import { deriveConnectorAuthHint } from '../deriveConnectorAuthHint';

describe('deriveConnectorAuthHint', () => {
  describe('catalog-based derivation', () => {
    it('returns "oauth" for catalog entries with mcpConfig.oauth === true', () => {
      expect(
        deriveConnectorAuthHint({
          catalogEntry: { mcpConfig: { oauth: true } } as never,
        }),
      ).toBe('oauth');
    });

    it('returns "oauth" for catalog entries with bundledConfig.authType === "oauth"', () => {
      expect(
        deriveConnectorAuthHint({
          catalogEntry: { bundledConfig: { authType: 'oauth' } } as never,
        }),
      ).toBe('oauth');
    });

    it('returns "oauth" for catalog entries with bundledConfig.authType === "oauth-user-provided"', () => {
      expect(
        deriveConnectorAuthHint({
          catalogEntry: { bundledConfig: { authType: 'oauth-user-provided' } } as never,
        }),
      ).toBe('oauth');
    });

    it('returns "api-key" for catalog entries with bundledConfig.authType === "api-key"', () => {
      expect(
        deriveConnectorAuthHint({
          catalogEntry: { bundledConfig: { authType: 'api-key' } } as never,
        }),
      ).toBe('api-key');
    });
  });

  describe('serverPreview fallback for custom connectors', () => {
    it('returns "oauth" when serverPreview.oauth === true and no catalog entry', () => {
      // REBEL-1H7 regression: custom OAuth MCPs must render the "Re-authenticate" affordance
      // when unavailable, not the generic "service may be unavailable" message.
      expect(
        deriveConnectorAuthHint({
          serverPreview: { oauth: true },
        }),
      ).toBe('oauth');
    });

    it('returns "oauth" when serverPreview.oauth === true and catalog entry has no auth info', () => {
      expect(
        deriveConnectorAuthHint({
          catalogEntry: {} as never,
          serverPreview: { oauth: true },
        }),
      ).toBe('oauth');
    });

    it('prefers catalog api-key over serverPreview.oauth (catalog wins)', () => {
      expect(
        deriveConnectorAuthHint({
          catalogEntry: { bundledConfig: { authType: 'api-key' } } as never,
          serverPreview: { oauth: true },
        }),
      ).toBe('api-key');
    });
  });

  describe('default', () => {
    it('returns "none" for unknown catalog auth type', () => {
      expect(
        deriveConnectorAuthHint({
          catalogEntry: { bundledConfig: { authType: 'unknown' } } as never,
        }),
      ).toBe('none');
    });

    it('returns "none" when no catalog entry and no serverPreview', () => {
      expect(deriveConnectorAuthHint({})).toBe('none');
    });

    it('returns "none" when serverPreview.oauth is false', () => {
      expect(
        deriveConnectorAuthHint({
          serverPreview: { oauth: false },
        }),
      ).toBe('none');
    });

    it('returns "none" when serverPreview.oauth is undefined', () => {
      expect(
        deriveConnectorAuthHint({
          serverPreview: {},
        }),
      ).toBe('none');
    });
  });
});
