/**
 * Unit tests for diagnostic bundle redaction and sanitization.
 *
 * These tests verify that sensitive data is properly redacted before
 * diagnostic bundles are shared with support. See docs/project/DIAGNOSTICS.md
 * for the full specification of what should/shouldn't be redacted.
 *
 * Imports production redaction functions from @core/utils/logRedaction
 * (platform-agnostic, zero Electron dependencies).
 *
 * @see docs/project/DIAGNOSTICS.md#diagnostic-bundle-sanitization
 * @see src/core/utils/logRedaction.ts
 */
import { describe, it, expect } from 'vitest';
import {
  SENSITIVE_KEY_PATTERNS,
  redactObjectDeep,
  redactUrlParams,
  redactSensitiveData,
} from '@core/utils/logRedaction';

describe('logExportService redaction', () => {
  describe('SENSITIVE_KEY_PATTERNS', () => {
    it('matches common API key field names', () => {
      const sensitiveKeys = [
        'apiKey',
        'api_key',
        'openaiApiKey',
        'claudeApiKey',
        'myApiKey',
      ];

      for (const key of sensitiveKeys) {
        const matches = SENSITIVE_KEY_PATTERNS.some((p) => p.test(key));
        expect(matches, `Expected "${key}" to match sensitive patterns`).toBe(true);
      }
    });

    it('matches OAuth token field names', () => {
      const sensitiveKeys = [
        'oauthToken',
        'oauth_token',
        'accessToken',
        'access_token',
        'refreshToken',
        'refresh_token',
        'idToken',
        'id_token',
      ];

      for (const key of sensitiveKeys) {
        const matches = SENSITIVE_KEY_PATTERNS.some((p) => p.test(key));
        expect(matches, `Expected "${key}" to match sensitive patterns`).toBe(true);
      }
    });

    it('matches secret and credential field names', () => {
      const sensitiveKeys = [
        'clientSecret',
        'client_secret',
        'password',
        'secret',
        'credential',
        'privateKey',
        'private_key',
        'jwt',
        'writeKey',
        'write_key',
      ];

      for (const key of sensitiveKeys) {
        const matches = SENSITIVE_KEY_PATTERNS.some((p) => p.test(key));
        expect(matches, `Expected "${key}" to match sensitive patterns`).toBe(true);
      }
    });

    it('does not match non-sensitive field names', () => {
      const safeKeys = ['name', 'email', 'model', 'version', 'theme', 'enabled', 'dataPlaneUrl'];

      for (const key of safeKeys) {
        const matches = SENSITIVE_KEY_PATTERNS.some((p) => p.test(key));
        expect(matches, `Expected "${key}" to NOT match sensitive patterns`).toBe(false);
      }
    });
  });

  describe('redactObjectDeep', () => {
    it('redacts nested API keys in settings-like objects', () => {
      const settings = {
        claude: {
          apiKey: 'sk-ant-api03-secret-key-here',
          model: 'claude-sonnet-4-20250514',
        },
        voice: {
          openaiApiKey: 'sk-proj-secret-openai-key',
          provider: 'openai-whisper',
        },
        userEmail: 'user@example.com', // Should NOT be redacted
      };

      const redacted = redactObjectDeep(settings) as typeof settings;

      expect(redacted.claude.apiKey).toBe('***REDACTED***');
      expect(redacted.claude.model).toBe('claude-sonnet-4-20250514');
      expect(redacted.voice.openaiApiKey).toBe('***REDACTED***');
      expect(redacted.voice.provider).toBe('openai-whisper');
      expect(redacted.userEmail).toBe('user@example.com');
    });

    it('redacts secrets in arrays', () => {
      const settings = {
        localModel: {
          profiles: [
            { id: '1', name: 'Profile 1', apiKey: 'secret-key-1' },
            { id: '2', name: 'Profile 2', apiKey: 'secret-key-2' },
          ],
        },
      };

      const redacted = redactObjectDeep(settings) as typeof settings;

      expect(redacted.localModel.profiles[0].apiKey).toBe('***REDACTED***');
      expect(redacted.localModel.profiles[0].name).toBe('Profile 1');
      expect(redacted.localModel.profiles[1].apiKey).toBe('***REDACTED***');
    });

    it('redacts OAuth tokens and client secrets', () => {
      const settings = {
        googleWorkspace: {
          clientId: 'public-client-id.apps.googleusercontent.com',
          clientSecret: 'GOCSPX-secret-here',
        },
        hubspot: {
          clientSecret: 'hubspot-secret',
          enabled: true,
        },
      };

      const redacted = redactObjectDeep(settings) as typeof settings;

      expect(redacted.googleWorkspace.clientId).toBe('public-client-id.apps.googleusercontent.com');
      expect(redacted.googleWorkspace.clientSecret).toBe('***REDACTED***');
      expect(redacted.hubspot.clientSecret).toBe('***REDACTED***');
      expect(redacted.hubspot.enabled).toBe(true);
    });

    it('does not mutate the original object', () => {
      const original = {
        claude: { apiKey: 'secret-key' },
      };
      const originalCopy = JSON.parse(JSON.stringify(original));

      redactObjectDeep(original);

      expect(original).toEqual(originalCopy);
    });

    it('redacts strata_id in URL values', () => {
      const config = {
        servers: {
          toolbox: {
            url: 'https://strata.klavis.ai/mcp/?strata_id=abc123-secret-id',
          },
        },
      };

      const redacted = redactObjectDeep(config) as typeof config;

      expect(redacted.servers.toolbox.url).toBe(
        'https://strata.klavis.ai/mcp/?strata_id=***REDACTED***'
      );
    });

    it('redacts basic auth in URLs', () => {
      const config = {
        webhook: 'https://user:password123@webhook.example.com/endpoint',
      };

      const redacted = redactObjectDeep(config) as typeof config;

      expect(redacted.webhook).toBe('https://user:***REDACTED***@webhook.example.com/endpoint');
    });

    it('handles null and undefined values', () => {
      const settings = {
        claude: {
          apiKey: null,
          oauthToken: undefined,
        },
      };

      const redacted = redactObjectDeep(settings) as typeof settings;

      expect(redacted.claude.apiKey).toBeNull();
      expect(redacted.claude.oauthToken).toBeUndefined();
    });

    it('handles empty strings (does not redact)', () => {
      const settings = {
        claude: { apiKey: '' },
      };

      const redacted = redactObjectDeep(settings) as typeof settings;

      // Empty strings are not redacted (nothing to hide)
      expect(redacted.claude.apiKey).toBe('');
    });
  });

  describe('redactSensitiveData (string content)', () => {
    it('redacts Anthropic API keys', () => {
      const content = 'Using API key: sk-ant-api03-abcdefghijklmnop';
      const redacted = redactSensitiveData(content);

      expect(redacted).toBe('Using API key: sk-ant-***REDACTED***');
    });

    it('redacts OpenAI-style API keys', () => {
      const content = 'OpenAI key: sk-proj-abcdefghijklmnopqrstuvwxyz';
      const redacted = redactSensitiveData(content);

      expect(redacted).toBe('OpenAI key: sk-***REDACTED***');
    });

    it('redacts email addresses', () => {
      const content = 'Contact: user@example.com and [external-email]';
      const redacted = redactSensitiveData(content);

      expect(redacted).toBe('Contact: ***@***.*** and ***@***.***');
    });

    it('normalizes macOS user paths', () => {
      const content = 'Path: /Users/alice/Documents/file.txt';
      const redacted = redactSensitiveData(content);

      expect(redacted).toBe('Path: ~/Documents/file.txt');
    });

    it('normalizes Linux user paths', () => {
      const content = 'Path: /home/bob/projects/code.js';
      const redacted = redactSensitiveData(content);

      expect(redacted).toBe('Path: ~/projects/code.js');
    });

    it('normalizes Windows user paths', () => {
      const content = 'Path: C:\\Users\\carol\\Desktop\\report.pdf';
      const redacted = redactSensitiveData(content);

      expect(redacted).toBe('Path: ~\\Desktop\\report.pdf');
    });

    it('normalizes Windows paths with spaces in username', () => {
      const content = 'Path: C:\\Users\\John Doe\\Documents\\file.txt';
      const redacted = redactSensitiveData(content);

      expect(redacted).toBe('Path: ~\\Documents\\file.txt');
    });

    it('normalizes Windows paths on non-C drives', () => {
      const content = 'Path: D:\\Users\\alice\\Desktop\\file.txt';
      const redacted = redactSensitiveData(content);

      expect(redacted).toBe('Path: ~\\Desktop\\file.txt');
    });

    it('redacts JSON API key patterns', () => {
      const content = '{"apiKey": "secret-value-here", "model": "gpt-4"}';
      const redacted = redactSensitiveData(content);

      expect(redacted).toBe('{"apiKey": "***REDACTED***", "model": "gpt-4"}');
    });

    it('redacts URL parameters', () => {
      const content = 'URL: https://api.example.com?strata_id=abc123&token=xyz789';
      const redacted = redactSensitiveData(content);

      expect(redacted).toContain('strata_id=***REDACTED***');
      expect(redacted).toContain('token=***REDACTED***');
    });
  });

  describe('URL parameter redaction', () => {
    it('redacts strata_id parameters', () => {
      const url = 'https://strata.klavis.ai/mcp/?strata_id=ee4c39a5-66da-4396-8756-925ac6e18243';
      const redacted = redactUrlParams(url);

      expect(redacted).toBe('https://strata.klavis.ai/mcp/?strata_id=***REDACTED***');
    });

    it('redacts bearer tokens in URLs', () => {
      const url = 'https://api.example.com?bearer=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
      const redacted = redactUrlParams(url);

      expect(redacted).toBe('https://api.example.com?bearer=***REDACTED***');
    });

    it('redacts multiple sensitive parameters', () => {
      const url = 'https://api.example.com?api_key=key123&secret=sec456&name=test';
      const redacted = redactUrlParams(url);

      expect(redacted).toContain('api_key=***REDACTED***');
      expect(redacted).toContain('secret=***REDACTED***');
      expect(redacted).toContain('name=test'); // Non-sensitive param preserved
    });

    it('redacts basic auth credentials in URLs', () => {
      const url = 'https://admin:supersecret@api.example.com/endpoint';
      const redacted = redactUrlParams(url);

      expect(redacted).toBe('https://admin:***REDACTED***@api.example.com/endpoint');
    });
  });

  describe('edge cases', () => {
    it('handles deeply nested objects', () => {
      const deepObj: Record<string, unknown> = { level1: { level2: { level3: { apiKey: 'secret' } } } };
      const redacted = redactObjectDeep(deepObj) as typeof deepObj;

      expect((redacted.level1 as Record<string, unknown>).level2).toBeDefined();
      expect(
        ((redacted.level1 as Record<string, unknown>).level2 as Record<string, unknown>)
          .level3 as Record<string, unknown>
      ).toHaveProperty('apiKey', '***REDACTED***');
    });

    it('handles mixed arrays with objects and primitives', () => {
      const mixed = {
        items: [
          'string',
          123,
          { apiKey: 'secret' },
          null,
          { nested: { password: 'pass123' } },
        ],
      };

      const redacted = redactObjectDeep(mixed) as typeof mixed;

      expect(redacted.items[0]).toBe('string');
      expect(redacted.items[1]).toBe(123);
      expect((redacted.items[2] as Record<string, unknown>).apiKey).toBe('***REDACTED***');
      expect(redacted.items[3]).toBeNull();
      expect(
        ((redacted.items[4] as Record<string, unknown>).nested as Record<string, unknown>).password
      ).toBe('***REDACTED***');
    });

    it('preserves non-sensitive data', () => {
      const data = {
        name: 'Test User',
        email: 'test@example.com',
        settings: {
          theme: 'dark',
          language: 'en',
          notifications: true,
        },
      };

      const redacted = redactObjectDeep(data) as typeof data;

      expect(redacted.name).toBe('Test User');
      expect(redacted.email).toBe('test@example.com');
      expect(redacted.settings.theme).toBe('dark');
      expect(redacted.settings.language).toBe('en');
      expect(redacted.settings.notifications).toBe(true);
    });
  });
});
