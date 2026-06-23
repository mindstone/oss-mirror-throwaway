import { describe, it, expect, vi } from 'vitest';
import {
  redactSensitiveString,
  redactObjectDeep,
  redactOrigin,
  redactSentryEvent,
  SENSITIVE_KEY_PATTERNS,
} from '../sentryRedaction';
import { collectSerdeStrictnessIssues } from '../sentrySerdeStrictness';
import { hashTeamId } from '../teamIdHash';

describe('sentryRedaction', () => {
  it('hashTeamId returns a 12-character stable hex hash', () => {
    expect(hashTeamId('T123')).toMatch(/^[a-f0-9]{12}$/);
    expect(hashTeamId('T123')).toBe(hashTeamId('T123'));
  });

  describe('providerKeys redaction', () => {
    it('redacts providerKeys object values', () => {
      const input = {
        providerKeys: {
          anthropicApiKey: 'fake-ant-token-123',
          openaiApiKey: 'fake-token-456',
        },
      };
      const result = redactObjectDeep(input) as Record<string, unknown>;
      expect(result.providerKeys).toBe('***REDACTED***');
    });

    it('redacts providerKeys when nested in settings', () => {
      const input = {
        settings: {
          providerKeys: {
            groqApiKey: 'fake-groq-token-123',
          },
        },
      };
      const result = redactObjectDeep(input) as Record<string, unknown>;
      const settings = result.settings as Record<string, unknown>;
      expect(settings.providerKeys).toBe('***REDACTED***');
    });

    it('includes providerKeys in SENSITIVE_KEY_PATTERNS array', () => {
      const hasProviderKeys = SENSITIVE_KEY_PATTERNS.some((p) => p.test('providerKeys'));
      expect(hasProviderKeys).toBe(true);
    });

    it('does not redact keys containing providerKeys as substring', () => {
      const input = { myProviderKeysBackup: 'not-sensitive' };
      const result = redactObjectDeep(input) as Record<string, unknown>;
      expect(result.myProviderKeysBackup).toBe('not-sensitive');
    });
  });

  describe('Slack and OAuth redaction', () => {
    it('redacts Slack organization and legacy app token shapes', () => {
      const redacted = redactSensitiveString([
        'xoxe-org-token-1234567890',
        'xoxe.xoxp-org-user-token-1234567890',
        'xoxa-legacy-token-1234567890',
      ].join(' '));

      expect(redacted).not.toContain('org-token-1234567890');
      expect(redacted).not.toContain('org-user-token-1234567890');
      expect(redacted).not.toContain('legacy-token-1234567890');
      expect(redacted).toContain('xoxe-***REDACTED***');
      expect(redacted).toContain('xoxe.xoxp-***REDACTED***');
      expect(redacted).toContain('xoxa-***REDACTED***');
    });

    it('redacts OAuth code and state in OAuth contexts without redacting generic code fields', () => {
      const oauthCode = 'fake-test-oauth-code-value-1234567890';
      const redactedObject = redactObjectDeep({
        oauth_code: oauthCode,
        code: oauthCode,
        error_code: 'ERR_123',
        statusCode: 400,
        oauth_state: 'state-secret-value',
      }) as Record<string, unknown>;
      const redactedUrl = redactSensitiveString(`https://example.test/callback?code=${oauthCode}&state=secret-state`);

      expect(redactedObject.oauth_code).toBe('***REDACTED***');
      expect(redactedObject.code).toBe('***REDACTED***');
      expect(redactedObject.error_code).toBe('ERR_123');
      expect(redactedObject.statusCode).toBe(400);
      expect(redactedObject.oauth_state).toBe('***REDACTED***');
      expect(redactedUrl).toContain('code=***REDACTED***');
      expect(redactedUrl).toContain('state=***REDACTED***');
    });

    it('redacts JSON-string key-value forms and avoids secret_settings false positives', () => {
      const payload = '{"signing_secret":"signing-value","secret_settings":"keep-me","secret":"hide-me","client_secret":"hide-client"}';
      const redacted = redactSensitiveString(payload);

      expect(redacted).not.toContain('signing-value');
      expect(redacted).not.toContain('hide-me');
      expect(redacted).not.toContain('hide-client');
      expect(redacted).toContain('"secret_settings":"keep-me"');

      const objectRedacted = redactObjectDeep({
        secret_settings: 'keep-me',
        secret: 'hide-me',
        client_secret: 'hide-client',
      }) as Record<string, unknown>;
      expect(objectRedacted.secret_settings).toBe('keep-me');
      expect(objectRedacted.secret).toBe('***REDACTED***');
      expect(objectRedacted.client_secret).toBe('***REDACTED***');
    });

    it('redacts Sentry event request, breadcrumbs, contexts, user non-identity fields, and stack frame vars', () => {
      const secret = 'xoxb-secret-token-value';
      const event = redactSentryEvent({
        message: `bot token ${secret}`,
        extra: { signing_secret: 'signing-secret-value' },
        request: {
          data: { bot_token: secret },
          headers: { 'x-slack-signature': 'v0=abcdef1234567890abcdef' },
          cookies: { session: 'cookie-secret' },
        },
        breadcrumbs: [{ message: `crumb ${secret}`, data: { client_secret: 'client-secret-value' } }],
        contexts: { slack: { signing_secret: 'context-secret' } },
        user: { id: 'user-1', email: 'person@example.com' },
        exception: {
          values: [{
            value: `exception ${secret}`,
            stacktrace: { frames: [{ vars: { bot_token: secret } }] },
          }],
        },
      });
      const serialized = JSON.stringify(event);

      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain('signing-secret-value');
      expect(serialized).not.toContain('abcdef1234567890abcdef');
      expect(serialized).not.toContain('client-secret-value');
      expect(serialized).not.toContain('context-secret');
      expect(serialized).toContain('***REDACTED***');

      // User identity fields (id, email) are preserved for reporter identification
      const user = (event as Record<string, unknown>).user as Record<string, unknown>;
      expect(user.id).toBe('user-1');
      expect(user.email).toBe('person@example.com');
    });

    it('preserves user id and email but redacts other user fields', () => {
      const event = redactSentryEvent({
        user: { id: 'user-1', email: 'person@example.com', ip_address: '1.2.3.4', username: 'secret-user' },
      });
      const user = (event as Record<string, unknown>).user as Record<string, unknown>;
      expect(user.id).toBe('user-1');
      expect(user.email).toBe('person@example.com');
      expect(user.ip_address).toBe('***REDACTED***');
      expect(user.username).toBe('***REDACTED***');
    });

    // PRIVACY (MF-1): server_name defaults to os.hostname() (often the user's
    // real name on personal machines) and is set before beforeSend. It must be
    // stripped from every event.
    it('deletes server_name (os.hostname() leaks the user identity)', () => {
      const event = redactSentryEvent({
        message: 'something failed',
        server_name: 'Ada-MacBook-Pro.local',
      });
      expect(event).not.toHaveProperty('server_name');
      expect(JSON.stringify(event)).not.toContain('Ada-MacBook-Pro');
    });

    it('produces serde-safe JSON when event strings contain lone surrogates at multiple depths', () => {
      const loneLead = '\uD83D';
      const event = redactSentryEvent({
        message: `message:${loneLead}`,
        tags: { phase: `tag:${loneLead}` },
        fingerprint: ['user-bug-report', `fingerprint:${loneLead}`],
        extra: {
          nested: {
            summary: `extra:${loneLead}`,
          },
        },
        breadcrumbs: [
          {
            category: 'log',
            message: `crumb:${loneLead}`,
            data: {
              detail: `crumb-data:${loneLead}`,
            },
          },
        ],
        exception: {
          values: [
            {
              type: 'Error',
              value: `exception:${loneLead}`,
            },
          ],
        },
      });

      const issues = collectSerdeStrictnessIssues(JSON.stringify(event));
      expect(issues.loneSurrogateEscapes).toHaveLength(0);
      expect(issues.rawLoneSurrogates).toHaveLength(0);
    });

    it('preserves a well-formed event byte-for-byte', () => {
      const sourceEvent = {
        message: 'Bug report for dashboard emoji 😀 keeps shape',
        tags: { area: 'bug-report', channel: 'beta' },
        fingerprint: ['user-bug-report', 'dashboard-load'],
        extra: {
          nested: {
            retries: 2,
            outcome: 'failed',
          },
        },
        breadcrumbs: [
          {
            category: 'log',
            message: 'Main process logger initialized',
            data: { component: 'main', durationMs: 12 },
          },
        ],
        contexts: {
          runtime: {
            platform: 'desktop',
          },
        },
      };

      const event = redactSentryEvent(sourceEvent);
      expect(event).toEqual(sourceEvent);
      expect(JSON.stringify(event)).toBe(JSON.stringify(sourceEvent));
    });

    it('normalizes hostile keys in extra, breadcrumbs, and nested objects with deterministic last-write-wins collisions', () => {
      const event = redactSentryEvent({
        extra: {
          '\uD83D': 'first',
          '\uFFFD': 'second',
          nested: {
            '\uD83D': 'nested-first',
            '\uFFFD': 'nested-second',
          },
        },
        breadcrumbs: [
          {
            category: 'log',
            data: {
              '\uD83D': 'crumb-first',
              '\uFFFD': 'crumb-second',
            },
          },
        ],
      });

      const serialized = JSON.stringify(event);
      const issues = collectSerdeStrictnessIssues(serialized);
      expect(issues.loneSurrogateEscapes).toHaveLength(0);
      expect(issues.rawLoneSurrogates).toHaveLength(0);

      const extra = (event as Record<string, unknown>).extra as Record<string, unknown>;
      expect(extra['\uFFFD']).toBe('second');
      expect(Object.keys(extra).filter((key) => key === '\uFFFD')).toHaveLength(1);

      const nested = extra.nested as Record<string, unknown>;
      expect(nested['\uFFFD']).toBe('nested-second');
      expect(Object.keys(nested).filter((key) => key === '\uFFFD')).toHaveLength(1);

      const crumbs = (event as Record<string, unknown>).breadcrumbs as Array<Record<string, unknown>>;
      const crumbData = (crumbs[0]?.data ?? {}) as Record<string, unknown>;
      expect(crumbData['\uFFFD']).toBe('crumb-second');
      expect(Object.keys(crumbData).filter((key) => key === '\uFFFD')).toHaveLength(1);
    });

    it('reports replacement counts and field paths when well-formedness fixes occur', () => {
      const onWellFormedFix = vi.fn();
      redactSentryEvent(
        {
          message: 'bad:\uD83D',
          extra: { nested: { detail: 'also bad:\uD83D' } },
        },
        { onWellFormedFix },
      );

      expect(onWellFormedFix).toHaveBeenCalledTimes(1);
      expect(onWellFormedFix).toHaveBeenCalledWith(
        expect.objectContaining({
          replacementCount: 2,
          omittedPathCount: 0,
          replacementPaths: expect.arrayContaining(['message', 'extra.nested.detail']),
        }),
      );
    });
  });

  describe('email redaction (EMAIL_ADDRESS_REGEX)', () => {
    it('redacts plain email addresses in strings', () => {
      const redacted = redactSensitiveString('sync failed for user@example.com after retry');

      expect(redacted).not.toContain('user@example.com');
      expect(redacted).toContain('***@***.***');
      expect(redacted).toContain('after retry');
    });

    it('redacts URL-encoded (%40) email addresses (260611 calendar PII-leak postmortem)', () => {
      // Google calendarIds in events-path URLs are URL-encoded emails — provider
      // HTTP errors echo the request URL, so `user%40example.com` reaches the
      // central Sentry-bound redaction routinely.
      const redacted = redactSensitiveString(
        'GET /calendars/user%40example.com/events returned 404',
      );

      expect(redacted).not.toContain('user%40example.com');
      expect(redacted).not.toContain('example.com');
      expect(redacted).toContain('***@***.***');
      expect(redacted).toContain('returned 404');
    });

    it('redacts %40-encoded emails inside nested objects via redactObjectDeep', () => {
      const redacted = redactObjectDeep({
        breadcrumb: { message: 'fetch https://api.test/cal/user%40example.com failed' },
      }) as { breadcrumb: { message: string } };

      expect(redacted.breadcrumb.message).not.toContain('user%40example.com');
      expect(redacted.breadcrumb.message).toContain('***@***.***');
    });
  });

  describe('redactOrigin', () => {
    it('keeps scheme + TLD for public https hostnames', () => {
      expect(redactOrigin('https://portal.pitchbook.com')).toBe('https://***.com');
      expect(redactOrigin('https://portal.pitchbook.com/*')).toBe('https://***.com');
      expect(redactOrigin('https://example.co.uk')).toBe('https://***.uk');
    });

    it('keeps scheme + TLD for public http hostnames', () => {
      expect(redactOrigin('http://news.example.org/path')).toBe('http://***.org');
    });

    it('collapses loopback to <loopback>', () => {
      expect(redactOrigin('http://localhost:3000')).toBe('<loopback>');
      expect(redactOrigin('http://127.0.0.1:8080')).toBe('<loopback>');
      expect(redactOrigin('https://[::1]')).toBe('<loopback>');
    });

    it('collapses RFC1918 private IPv4 to <private-ip>', () => {
      expect(redactOrigin('http://10.0.0.1')).toBe('<private-ip>');
      expect(redactOrigin('http://192.168.1.5:8443')).toBe('<private-ip>');
      expect(redactOrigin('http://172.16.0.1')).toBe('<private-ip>');
      expect(redactOrigin('http://169.254.1.1')).toBe('<private-ip>');
    });

    it('collapses IPv6 private ranges to <private-ip>', () => {
      expect(redactOrigin('http://[fc00::1]')).toBe('<private-ip>');
      expect(redactOrigin('http://[fd12:3456::1]')).toBe('<private-ip>');
      expect(redactOrigin('http://[fe80::1]')).toBe('<private-ip>');
    });

    it('returns generic <redacted> for unsupported schemes or invalid input', () => {
      expect(redactOrigin('chrome://settings')).toBe('<redacted>');
      expect(redactOrigin('chrome-extension://abc/index.html')).toBe('<redacted>');
      expect(redactOrigin('file:///Users/me/foo.html')).toBe('<redacted>');
      expect(redactOrigin('data:text/plain,hi')).toBe('<redacted>');
      expect(redactOrigin('not a url')).toBe('<redacted>');
      expect(redactOrigin('')).toBe('<redacted>');
      expect(redactOrigin(null)).toBe('<redacted>');
      expect(redactOrigin(undefined)).toBe('<redacted>');
    });

    it('redacts public IPv4 literals without exposing the address', () => {
      expect(redactOrigin('https://8.8.8.8')).toBe('https://***.***');
    });
  });
});
