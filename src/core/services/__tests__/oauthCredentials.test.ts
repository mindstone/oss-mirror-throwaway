import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  googleCredentialSource,
  microsoftCredentialSource,
  oauthCredentialEnvVars,
  resolveMicrosoftClientId,
  resolveOAuthCredentials,
  resolveSalesforceCredentials,
  salesforceCredentialSource,
  setOAuthCredentialsProvider,
  slackCredentialSource,
  type OAuthCredentialsProvider,
} from '../oauthCredentials';

// Salesforce is BYOK: the connector setup UI persists the user's Connected App
// Consumer Key/Secret to settings (salesforce.clientId/clientSecret). The resolver
// must read them. Mock the settings store so tests control that input.
let mockSettings: Record<string, unknown> = {};
vi.mock('@core/services/settingsStore', () => ({
  getSettings: () => mockSettings,
}));

describe('oauthCredentials', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    setOAuthCredentialsProvider(null);
    mockSettings = {};
  });

  it('resolves provider credentials only from provider env vars', () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', ' google-client-id ');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', ' google-client-secret ');

    expect(resolveOAuthCredentials(googleCredentialSource)).toEqual({
      clientId: 'google-client-id',
      clientSecret: 'google-client-secret',
    });
  });

  it('returns null when required provider env vars are missing', () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'google-client-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', '');

    expect(resolveOAuthCredentials(googleCredentialSource)).toBeNull();
  });

  it('uses the OSS env naming convention for all registered client credentials', () => {
    expect(oauthCredentialEnvVars).toMatchObject({
      google: { envClientId: 'GOOGLE_CLIENT_ID', envClientSecret: 'GOOGLE_CLIENT_SECRET' },
      slack: { envClientId: 'SLACK_CLIENT_ID', envClientSecret: 'SLACK_CLIENT_SECRET' },
      hubspot: { envClientId: 'HUBSPOT_CLIENT_ID', envClientSecret: 'HUBSPOT_CLIENT_SECRET' },
      github: { envClientId: 'GITHUB_CLIENT_ID', envClientSecret: 'GITHUB_CLIENT_SECRET' },
      digitalocean: {
        envClientId: 'DIGITAL_OCEAN_CLIENT_ID',
        envClientSecret: 'DIGITAL_OCEAN_CLIENT_SECRET',
      },
      salesforce: { envClientId: 'SALESFORCE_CLIENT_ID', envClientSecret: 'SALESFORCE_CLIENT_SECRET' },
      plaud: { envClientId: 'PLAUD_CLIENT_ID', envClientSecret: 'PLAUD_CLIENT_SECRET' },
      discourse: { envClientId: 'DISCOURSE_CLIENT_ID', envClientSecret: 'DISCOURSE_CLIENT_SECRET' },
    });
  });

  it('resolves Microsoft public-client ID from env first', () => {
    expect(resolveMicrosoftClientId(microsoftCredentialSource)).toBeNull();

    vi.stubEnv('MICROSOFT_CLIENT_ID', ' microsoft-client-id ');

    expect(resolveMicrosoftClientId(microsoftCredentialSource)).toBe('microsoft-client-id');
  });

  describe('injected credentials provider (commercial-build fallback)', () => {
    const fakeProvider: OAuthCredentialsProvider = {
      get: (provider) => {
        if (provider === 'slack') return { clientId: 'commercial-slack-id', clientSecret: 'commercial-slack-secret' };
        if (provider === 'microsoft') return { clientId: 'commercial-ms-id' };
        return null; // salesforce/discourse never supplied — BYOK preserved
      },
    };

    it('stays broken-by-default (null) when no provider is registered and env is unset', () => {
      expect(resolveOAuthCredentials(slackCredentialSource)).toBeNull();
    });

    it('falls back to the provider when env is unset', () => {
      setOAuthCredentialsProvider(fakeProvider);
      expect(resolveOAuthCredentials(slackCredentialSource)).toEqual({
        clientId: 'commercial-slack-id',
        clientSecret: 'commercial-slack-secret',
      });
    });

    it('env vars take precedence over the provider', () => {
      setOAuthCredentialsProvider(fakeProvider);
      vi.stubEnv('SLACK_CLIENT_ID', 'env-slack-id');
      vi.stubEnv('SLACK_CLIENT_SECRET', 'env-slack-secret');
      expect(resolveOAuthCredentials(slackCredentialSource)).toEqual({
        clientId: 'env-slack-id',
        clientSecret: 'env-slack-secret',
      });
    });

    it('falls through to the provider when only one half of the env pair is set (regression guard)', () => {
      setOAuthCredentialsProvider(fakeProvider);
      vi.stubEnv('SLACK_CLIENT_ID', 'env-slack-id');
      // SLACK_CLIENT_SECRET intentionally unset → env pair incomplete
      expect(resolveOAuthCredentials(slackCredentialSource)).toEqual({
        clientId: 'commercial-slack-id',
        clientSecret: 'commercial-slack-secret',
      });
    });

    it('returns null for a provider that supplies only a clientId (no secret) for a secret-requiring connector', () => {
      setOAuthCredentialsProvider({ get: () => ({ clientId: 'id-only' }) });
      expect(resolveOAuthCredentials(slackCredentialSource)).toBeNull();
    });

    it('does not supply credentials for always-BYOK connectors (salesforce)', () => {
      setOAuthCredentialsProvider(fakeProvider);
      expect(resolveOAuthCredentials(salesforceCredentialSource)).toBeNull();
    });

    it('resolves Microsoft client ID from the provider when env is unset', () => {
      setOAuthCredentialsProvider(fakeProvider);
      expect(resolveMicrosoftClientId(microsoftCredentialSource)).toBe('commercial-ms-id');
    });

    it('does NOT use settings creds for non-salesforce providers (settings BYOK path is salesforce-only)', () => {
      mockSettings = { salesforce: { clientId: 'sf-id', clientSecret: 'sf-secret' } };
      expect(resolveOAuthCredentials(slackCredentialSource)).toBeNull();
    });

    it('an empty provider (OSS stub shape) keeps every connector broken-by-default', () => {
      setOAuthCredentialsProvider({ get: () => null });
      expect(resolveOAuthCredentials(slackCredentialSource)).toBeNull();
      expect(resolveOAuthCredentials(googleCredentialSource)).toBeNull();
      expect(resolveMicrosoftClientId(microsoftCredentialSource)).toBeNull();
    });
  });

  describe('resolveSalesforceCredentials — BYOK user-provided creds from settings', () => {
    it('reads the Connected App creds the setup UI saved to settings when env + provider are empty', () => {
      // Trimming mirrors readEnv behaviour and the UI .trim() on save.
      mockSettings = { salesforce: { clientId: ' 3MVG9.consumer-key ', clientSecret: ' consumer-secret ' } };
      expect(resolveSalesforceCredentials(salesforceCredentialSource)).toEqual({
        clientId: '3MVG9.consumer-key',
        clientSecret: 'consumer-secret',
      });
    });

    it('env still takes precedence over settings (dev/CI override preserved)', () => {
      mockSettings = { salesforce: { clientId: 'settings-id', clientSecret: 'settings-secret' } };
      vi.stubEnv('SALESFORCE_CLIENT_ID', 'env-id');
      vi.stubEnv('SALESFORCE_CLIENT_SECRET', 'env-secret');
      expect(resolveSalesforceCredentials(salesforceCredentialSource)).toEqual({
        clientId: 'env-id',
        clientSecret: 'env-secret',
      });
    });

    it('returns null when neither env nor settings supply both halves', () => {
      mockSettings = { salesforce: { clientId: 'only-id' } }; // missing secret
      expect(resolveSalesforceCredentials(salesforceCredentialSource)).toBeNull();
    });

    it('falls through to settings when the env pair is incomplete (only client id set)', () => {
      mockSettings = { salesforce: { clientId: 'settings-id', clientSecret: 'settings-secret' } };
      vi.stubEnv('SALESFORCE_CLIENT_ID', 'env-id'); // SALESFORCE_CLIENT_SECRET intentionally unset
      expect(resolveSalesforceCredentials(salesforceCredentialSource)).toEqual({
        clientId: 'settings-id',
        clientSecret: 'settings-secret',
      });
    });

    it('returns null when settings has no salesforce block at all', () => {
      mockSettings = {};
      expect(resolveSalesforceCredentials(salesforceCredentialSource)).toBeNull();
    });

    it('user settings win over an injected provider (BYOK: env -> settings -> provider)', () => {
      // A Salesforce provider is intentionally empty today, but if one ever appears the
      // user's typed Connected App creds must still take precedence.
      setOAuthCredentialsProvider({
        get: (p) => (p === 'salesforce' ? { clientId: 'provider-id', clientSecret: 'provider-secret' } : null),
      });
      mockSettings = { salesforce: { clientId: 'settings-id', clientSecret: 'settings-secret' } };
      expect(resolveSalesforceCredentials(salesforceCredentialSource)).toEqual({
        clientId: 'settings-id',
        clientSecret: 'settings-secret',
      });
    });

    it('falls back to the provider only when env and settings are both empty', () => {
      setOAuthCredentialsProvider({
        get: (p) => (p === 'salesforce' ? { clientId: 'provider-id', clientSecret: 'provider-secret' } : null),
      });
      mockSettings = {};
      expect(resolveSalesforceCredentials(salesforceCredentialSource)).toEqual({
        clientId: 'provider-id',
        clientSecret: 'provider-secret',
      });
    });
  });
});
