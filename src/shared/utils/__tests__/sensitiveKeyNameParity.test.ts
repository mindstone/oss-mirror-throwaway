import { describe, expect, it } from 'vitest';
import { stripSensitiveSettingsForClient } from '@shared/cloudSettingsPolicy';
import { scrubAppSettingsSecretsForBackup } from '@core/utils/appSettingsSecretScrub';
import { redactObjectDeep as redactLogObjectDeep, SENSITIVE_KEY_PATTERNS as LOG_SENSITIVE_KEY_PATTERNS } from '@core/utils/logRedaction';
import { isSensitiveKeyName } from '../redactionPatterns';
import { redactObjectDeep as redactSentryObjectDeep, SENSITIVE_KEY_PATTERNS as SENTRY_SENSITIVE_KEY_PATTERNS } from '../sentryRedaction';

type RedactionSite = {
  name: string;
  redact: (key: string) => unknown;
  redactedValue: unknown;
};

const SECRET_KEYS = [
  'providerKeys',
  'provider_keys',
  'apiKey',
  'api_key',
  'openaiApiKey',
  'oauthCode',
  'oauth_code',
  'oauthState',
  'oauth_state',
  'oauthToken',
  'oauth_token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'idToken',
  'id_token',
  'botToken',
  'bot_token',
  'cloudToken',
  'cloud_token',
  'clientSecret',
  'client_secret',
  'signingSecret',
  'signing_secret',
  'slackSigningSecret',
  'slack_signing_secret',
  'password',
  'nestedPassword',
  'secret',
  'fooSecret',
  'credential',
  'myCredential',
  'bearer',
  'bearerToken',
  'authorization',
  'writeKey',
  'write_key',
  'privateKey',
  'private_key',
  'privateKeyPem',
  'jwt',
  'signature',
  'routerToken',
  'router_token',
  'routerInternalToken',
  'router_internal_token',
  'pairingCode',
  'pairing_code',
  'pairCode',
  'pair_code',
  // SCREAMING_SNAKE env-secret suffixes (MCP connector env vars etc.) — added
  // 260612 alongside the /_(TOKEN|SECRET|PASSWORD|API_KEY)$/ vocab pattern.
  'HUBSPOT_PRIVATE_APP_TOKEN',
  'NOTION_API_TOKEN',
  'SLACK_CLIENT_SECRET',
  'DB_PASSWORD',
  'SOME_API_KEY',
] as const;

const CONFIG_OR_AMBIGUOUS_KEYS = [
  'dataPlaneUrl',
  'data_plane_url',
  'publicEndpoint',
  'clientId',
  'accountId',
  'maxOutputTokens',
  'secret_settings',
  // Benign token-count telemetry that the SCREAMING_SNAKE env-secret pattern
  // must NOT over-redact (plural `_TOKENS` / camelCase) — locks Stage-3's
  // anti-over-redaction safety claim across every redaction site.
  'MAX_TOKENS',
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'tokenBudget',
  'TokenCount',
] as const;

const sites: RedactionSite[] = [
  {
    name: 'cloud settings response',
    redact: (key) => stripSensitiveSettingsForClient({ [key]: 'secret-value' })[key],
    redactedValue: null,
  },
  {
    name: 'settings backup scrub',
    redact: (key) => scrubAppSettingsSecretsForBackup({ [key]: 'secret-value' })[key],
    redactedValue: '',
  },
  {
    name: 'log redaction',
    redact: (key) => (redactLogObjectDeep({ [key]: 'secret-value' }) as Record<string, unknown>)[key],
    redactedValue: '***REDACTED***',
  },
  {
    name: 'sentry redaction',
    redact: (key) => (redactSentryObjectDeep({ [key]: 'secret-value' }) as Record<string, unknown>)[key],
    redactedValue: '***REDACTED***',
  },
];

describe('sensitive key-name SSOT parity', () => {
  it.each(SECRET_KEYS)('classifies %s as a secret key name', (key) => {
    expect(isSensitiveKeyName(key)).toBe(true);
  });

  it.each(sites.flatMap((site) => SECRET_KEYS.map((key) => ({ site, key }))))(
    '$site.name redacts $key',
    ({ site, key }) => {
      expect(site.redact(key)).toBe(site.redactedValue);
    },
  );

  it.each(SECRET_KEYS)('keeps cloud settings redaction a superset for %s', (key) => {
    const logMatches = LOG_SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
    const sentryMatches = SENTRY_SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));

    expect(logMatches).toBe(true);
    expect(sentryMatches).toBe(true);
    expect(stripSensitiveSettingsForClient({ [key]: 'secret-value' })[key]).toBeNull();
  });

  it.each(CONFIG_OR_AMBIGUOUS_KEYS)('does not classify config-looking key %s as a secret', (key) => {
    expect(isSensitiveKeyName(key)).toBe(false);
    expect(stripSensitiveSettingsForClient({ [key]: 'config-value' })[key]).toBe('config-value');
    expect((redactLogObjectDeep({ [key]: 'config-value' }) as Record<string, unknown>)[key]).toBe('config-value');
    expect((redactSentryObjectDeep({ [key]: 'config-value' }) as Record<string, unknown>)[key]).toBe('config-value');
  });

  it('keeps providerKeys exact to avoid backup-name false positives', () => {
    expect(isSensitiveKeyName('myProviderKeysBackup')).toBe(false);
    expect(stripSensitiveSettingsForClient({ myProviderKeysBackup: 'config-value' }).myProviderKeysBackup).toBe('config-value');
  });
});
