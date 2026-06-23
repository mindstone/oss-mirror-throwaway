import { describe, it, expect, afterEach } from 'vitest';
import {
  getOAuthRedirectUri,
  type OAuthRedirectConnector,
} from '../oauthRedirectUri';

const CONNECTOR_EXPECTATIONS: Array<{
  connector: OAuthRedirectConnector;
  envKey: string;
  defaultUri: string;
}> = [
  {
    connector: 'slack',
    envKey: 'SLACK_REDIRECT_URI',
    defaultUri: 'https://rebel-auth.mindstone.com/slack/callback',
  },
  {
    connector: 'microsoft',
    envKey: 'MICROSOFT_REDIRECT_URI',
    defaultUri: 'https://rebel-auth.mindstone.com/microsoft/callback',
  },
  {
    connector: 'salesforce',
    envKey: 'SALESFORCE_REDIRECT_URI',
    defaultUri: 'https://rebel-auth.mindstone.com/salesforce/callback',
  },
  {
    connector: 'plaud',
    envKey: 'PLAUD_REDIRECT_URI',
    defaultUri: 'https://rebel-auth.mindstone.com/plaud/callback',
  },
  {
    connector: 'github',
    envKey: 'GITHUB_REDIRECT_URI',
    defaultUri: 'https://rebel-auth.mindstone.com/github/callback',
  },
  {
    connector: 'digitalocean',
    envKey: 'DIGITAL_OCEAN_REDIRECT_URI',
    defaultUri: 'https://rebel-auth.mindstone.com/digitalocean/callback',
  },
  {
    connector: 'openrouter',
    envKey: 'OPENROUTER_REDIRECT_URI',
    defaultUri: 'https://rebel-auth.mindstone.com/openrouter/callback',
  },
  {
    connector: 'openrouter-start',
    envKey: 'OPENROUTER_AUTH_START_URL',
    defaultUri: 'https://rebel-auth.mindstone.com/openrouter/start',
  },
];

const ENV_KEYS = CONNECTOR_EXPECTATIONS.map((entry) => entry.envKey);
const originalEnv = Object.fromEntries(
  ENV_KEYS.map((envKey) => [envKey, process.env[envKey]]),
) as Record<string, string | undefined>;

afterEach(() => {
  for (const envKey of ENV_KEYS) {
    const originalValue = originalEnv[envKey];
    if (originalValue === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = originalValue;
    }
  }
});

describe('getOAuthRedirectUri', () => {
  it.each(CONNECTOR_EXPECTATIONS)(
    'returns the production default for $connector when the env override is unset',
    ({ connector, envKey, defaultUri }) => {
      delete process.env[envKey];

      expect(getOAuthRedirectUri(connector)).toBe(defaultUri);
    },
  );

  it.each(CONNECTOR_EXPECTATIONS)(
    'returns the env override for $connector when set',
    ({ connector, envKey }) => {
      process.env[envKey] = `https://self-hosted.example.test/${connector}`;

      expect(getOAuthRedirectUri(connector)).toBe(
        `https://self-hosted.example.test/${connector}`,
      );
    },
  );

  it('resolves env overrides at call time after module import', () => {
    delete process.env.SLACK_REDIRECT_URI;
    expect(getOAuthRedirectUri('slack')).toBe(
      'https://rebel-auth.mindstone.com/slack/callback',
    );

    process.env.SLACK_REDIRECT_URI = 'https://runtime.example.test/slack/callback';

    expect(getOAuthRedirectUri('slack')).toBe(
      'https://runtime.example.test/slack/callback',
    );
  });

  it('returns the same GitHub env override across multiple calls', () => {
    process.env.GITHUB_REDIRECT_URI = 'https://runtime.example.test/github/callback';

    expect(getOAuthRedirectUri('github')).toBe(
      getOAuthRedirectUri('github'),
    );
  });
});
