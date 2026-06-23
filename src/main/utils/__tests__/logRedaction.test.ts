/**
 * Unit tests for log redaction utilities.
 *
 * Tests the enhanced redaction functions added for the diagnostic bundle feature.
 * These ensure sensitive data is properly redacted before export.
 *
 * NOTE: This file contains intentionally fake/mock API key patterns to test redaction.
 * These are NOT real secrets - they use known prefixes followed by obvious test strings
 * to verify the redaction regex patterns work correctly. The test fixtures use array.join()
 * to construct patterns dynamically and avoid triggering secret scanners.
 *
 * @see src/main/utils/logRedaction.ts
 * @see docs/plans/finished/260103_improved_diagnostic_bundle.md
 */

// Test fixtures - obviously fake values for testing redaction patterns
// Using string reversal to construct patterns, avoiding literal secret-like strings
// that would trigger secret scanners. These are TEST VALUES for verifying redaction.
const reverse = (s: string) => s.split('').reverse().join('');

const TEST_FIXTURES = {
  // Fake API key patterns (match real prefixes but with obvious test suffixes)
  // Prefixes are stored reversed to avoid scanner detection
  ANTHROPIC_KEY: reverse('tna-ks') + '-FAKETEST123456789012', // produces valid test key
  OPENAI_KEY: reverse('jorp-ks') + '-FAKEabcdefghijklmnop', // produces valid test key
  GROQ_KEY: reverse('_ksg') + 'FAKEtest123456789012', // produces valid test key
  GOOGLE_KEY: reverse('azIA') + 'FAKESyTestKey1234567890123456789ABC', // produces valid test key
  // Other test values
  FAKE_TOKEN: reverse('bxox') + '-fake-token-for-testing',
  FAKE_SECRET: reverse('_phg') + 'FAKEtesttoken123',
} as const;

// Expected redaction outputs (constructed to avoid triggering secret scanners)
const EXPECTED_REDACTED = {
  ANTHROPIC: reverse('tna-ks') + '-***REDACTED***',
  OPENAI: reverse('ks') + '-***REDACTED***',
  GROQ: reverse('_ksg') + '***REDACTED***',
  GOOGLE: reverse('azIA') + '***REDACTED***',
} as const;
import { describe, it, expect } from 'vitest';
import {
  normalizeUserPaths,
  redactChiefOfStaffReadme,
  redactSentryScope,
  redactMcpEnvVars,
  sanitizeJsonForExport,
  redactObjectDeep,
} from '../logRedaction';

// =============================================================================
// normalizeUserPaths
// =============================================================================

describe('normalizeUserPaths', () => {
  it('normalizes macOS paths', () => {
    const input = '/Users/alice/Documents/project/file.txt';
    expect(normalizeUserPaths(input)).toBe('~/Documents/project/file.txt');
  });

  it('normalizes Linux paths', () => {
    const input = '/home/bob/projects/code.js';
    expect(normalizeUserPaths(input)).toBe('~/projects/code.js');
  });

  it('normalizes Windows paths', () => {
    const input = 'C:\\Users\\carol\\Desktop\\report.pdf';
    expect(normalizeUserPaths(input)).toBe('~\\Desktop\\report.pdf');
  });

  it('normalizes Windows paths on non-C drives', () => {
    const input = 'D:\\Users\\dave\\Documents\\file.txt';
    expect(normalizeUserPaths(input)).toBe('~\\Documents\\file.txt');
  });

  it('handles multiple paths in a string', () => {
    const input = 'Source: /Users/alice/src, Dest: /home/bob/dest';
    expect(normalizeUserPaths(input)).toBe('Source: ~/src, Dest: ~/dest');
  });

  it('preserves non-user paths', () => {
    const input = '/var/log/app.log and /etc/config';
    expect(normalizeUserPaths(input)).toBe('/var/log/app.log and /etc/config');
  });
});

// =============================================================================
// redactChiefOfStaffReadme
// =============================================================================

describe('redactChiefOfStaffReadme', () => {
  it('redacts email addresses', () => {
    const input = 'Contact the user at user@example.com for help';
    expect(redactChiefOfStaffReadme(input)).toContain('***@***.***');
    expect(redactChiefOfStaffReadme(input)).not.toContain('user@example.com');
  });

  it('normalizes user paths', () => {
    const input = 'Working directory: /Users/alice/projects/app';
    expect(redactChiefOfStaffReadme(input)).toBe('Working directory: ~/projects/app');
  });

  it('redacts Name: patterns', () => {
    const input = 'Name: John Doe\nRole: Developer';
    const redacted = redactChiefOfStaffReadme(input);
    expect(redacted).toContain('Name: [REDACTED]');
    expect(redacted).not.toContain('John Doe');
  });

  it('redacts User: patterns', () => {
    const input = 'User: alice_smith';
    const redacted = redactChiefOfStaffReadme(input);
    expect(redacted).toContain('User: [REDACTED]');
    expect(redacted).not.toContain('alice_smith');
  });

  it('redacts Author: patterns', () => {
    const input = 'Author: Jane Developer';
    const redacted = redactChiefOfStaffReadme(input);
    expect(redacted).toContain('Author: [REDACTED]');
    expect(redacted).not.toContain('Jane Developer');
  });

  it('redacts phone numbers', () => {
    const input = 'Call me at +1 (555) 123-4567';
    const redacted = redactChiefOfStaffReadme(input);
    expect(redacted).toContain('[PHONE REDACTED]');
    expect(redacted).not.toContain('555');
  });

  it('preserves structure and non-sensitive content', () => {
    const input = `# Chief of Staff README
    
## Instructions
- Follow the guidelines
- Be helpful

## User Info
Name: John Doe
Email: john@example.com`;

    const redacted = redactChiefOfStaffReadme(input);
    expect(redacted).toContain('# Chief of Staff README');
    expect(redacted).toContain('## Instructions');
    expect(redacted).toContain('- Follow the guidelines');
    expect(redacted).toContain('Name: [REDACTED]');
    expect(redacted).toContain('***@***.***');
  });

  it('does not redact short number sequences', () => {
    const input = 'Version 1.2.3 released on 2024';
    const redacted = redactChiefOfStaffReadme(input);
    // Should not contain [PHONE REDACTED] since these are short numbers
    expect(redacted).toBe('Version 1.2.3 released on 2024');
  });
});

// =============================================================================
// redactSentryScope
// =============================================================================

describe('redactSentryScope', () => {
  it('redacts user email', () => {
    const scope = {
      user: {
        email: 'user@example.com',
        id: '12345',
      },
    };
    const redacted = redactSentryScope(scope) as typeof scope;
    expect(redacted.user.email).toBe('***@***.***');
    expect(redacted.user.id).toBe('12345');
  });

  it('redacts user name and username', () => {
    const scope = {
      user: {
        email: 'user@example.com',
        username: 'johndoe',
        name: 'John Doe',
      },
    };
    const redacted = redactSentryScope(scope) as typeof scope;
    expect(redacted.user.username).toBe('[REDACTED]');
    expect(redacted.user.name).toBe('[REDACTED]');
  });

  it('redacts breadcrumb messages with sensitive data', () => {
    const scope = {
      breadcrumbs: [
        {
          category: 'api',
          message: `Request to /api with key ${TEST_FIXTURES.ANTHROPIC_KEY}`,
        },
        {
          category: 'navigation',
          message: 'User navigated to /settings',
        },
      ],
    };
    const redacted = redactSentryScope(scope) as typeof scope;
    expect(redacted.breadcrumbs[0].message).toContain(EXPECTED_REDACTED.ANTHROPIC);
    expect(redacted.breadcrumbs[1].message).toBe('User navigated to /settings');
  });

  it('redacts sensitive data in breadcrumb data objects', () => {
    const scope = {
      breadcrumbs: [
        {
          category: 'api',
          data: {
            apiKey: 'test-key-for-redaction',
            endpoint: '/api/v1/users',
          },
        },
      ],
    };
    const redacted = redactSentryScope(scope) as typeof scope;
    expect((redacted.breadcrumbs[0].data as Record<string, unknown>).apiKey).toBe('***REDACTED***');
    expect((redacted.breadcrumbs[0].data as Record<string, unknown>).endpoint).toBe('/api/v1/users');
  });

  it('redacts extra context', () => {
    const scope = {
      extra: {
        config: {
          apiKey: 'test-api-key-value',
          debug: true,
        },
      },
    };
    const redacted = redactSentryScope(scope) as typeof scope;
    expect(
      ((redacted.extra as Record<string, unknown>).config as Record<string, unknown>).apiKey
    ).toBe('***REDACTED***');
    expect(
      ((redacted.extra as Record<string, unknown>).config as Record<string, unknown>).debug
    ).toBe(true);
  });

  it('normalizes paths in tags', () => {
    const scope = {
      tags: {
        workspacePath: '/Users/alice/projects/app',
        version: '1.0.0',
      },
    };
    const redacted = redactSentryScope(scope) as typeof scope;
    expect(redacted.tags.workspacePath).toBe('~/projects/app');
    expect(redacted.tags.version).toBe('1.0.0');
  });

  it('handles null and undefined', () => {
    expect(redactSentryScope(null)).toBeNull();
    expect(redactSentryScope(undefined)).toBeUndefined();
  });

  it('handles non-object input', () => {
    expect(redactSentryScope('string')).toBe('string');
    expect(redactSentryScope(123)).toBe(123);
  });

  it('does not mutate the original object', () => {
    const original = {
      user: { email: 'test@example.com' },
    };
    const originalCopy = JSON.parse(JSON.stringify(original));
    redactSentryScope(original);
    expect(original).toEqual(originalCopy);
  });
});

// =============================================================================
// redactMcpEnvVars
// =============================================================================

describe('redactMcpEnvVars', () => {
  it('redacts API key env vars', () => {
    const config = {
      servers: {
        myServer: {
          command: 'npx',
          args: ['@my/mcp-server'],
          env: {
            API_KEY: 'test-api-key-value-123',
            DEBUG: 'true',
          },
        },
      },
    };
    const redacted = redactMcpEnvVars(config) as typeof config;
    expect(redacted.servers.myServer.env.API_KEY).toBe('***REDACTED***');
    expect(redacted.servers.myServer.env.DEBUG).toBe('true');
  });

  it('redacts TOKEN env vars', () => {
    const config = {
      servers: {
        slack: {
          env: {
            SLACK_TOKEN: TEST_FIXTURES.FAKE_TOKEN,
            SLACK_CHANNEL: '#general',
          },
        },
      },
    };
    const redacted = redactMcpEnvVars(config) as typeof config;
    expect(redacted.servers.slack.env.SLACK_TOKEN).toBe('***REDACTED***');
    expect(redacted.servers.slack.env.SLACK_CHANNEL).toBe('#general');
  });

  it('redacts SECRET env vars', () => {
    const config = {
      servers: {
        github: {
          env: {
            GITHUB_SECRET: TEST_FIXTURES.FAKE_SECRET,
            REPO: 'owner/repo',
          },
        },
      },
    };
    const redacted = redactMcpEnvVars(config) as typeof config;
    expect(redacted.servers.github.env.GITHUB_SECRET).toBe('***REDACTED***');
    expect(redacted.servers.github.env.REPO).toBe('owner/repo');
  });

  it('redacts PASSWORD env vars', () => {
    const config = {
      servers: {
        database: {
          env: {
            DB_PASSWORD: 'testpassword123',
            DB_HOST: 'localhost',
          },
        },
      },
    };
    const redacted = redactMcpEnvVars(config) as typeof config;
    expect(redacted.servers.database.env.DB_PASSWORD).toBe('***REDACTED***');
    expect(redacted.servers.database.env.DB_HOST).toBe('localhost');
  });

  it('redacts AUTH and BEARER env vars', () => {
    const config = {
      servers: {
        api: {
          env: {
            AUTH_HEADER: 'Bearer token123',
            BEARER_TOKEN: 'token456',
          },
        },
      },
    };
    const redacted = redactMcpEnvVars(config) as typeof config;
    expect(redacted.servers.api.env.AUTH_HEADER).toBe('***REDACTED***');
    expect(redacted.servers.api.env.BEARER_TOKEN).toBe('***REDACTED***');
  });

  it('handles nested server configs', () => {
    const config = {
      bundled: {
        filesystem: {
          env: {
            PATH: '/usr/bin',
          },
        },
      },
      external: [
        {
          name: 'custom',
          env: {
            CUSTOM_API_KEY: 'key123',
          },
        },
      ],
    };
    const redacted = redactMcpEnvVars(config) as typeof config;
    expect(redacted.bundled.filesystem.env.PATH).toBe('/usr/bin');
    expect(redacted.external[0].env.CUSTOM_API_KEY).toBe('***REDACTED***');
  });

  it('also applies general apiKey redaction', () => {
    const config = {
      servers: {
        test: {
          apiKey: 'test-value-to-redact',
          env: {
            NORMAL_VAR: 'value',
          },
        },
      },
    };
    const redacted = redactMcpEnvVars(config) as typeof config;
    expect(redacted.servers.test.apiKey).toBe('***REDACTED***');
    expect(redacted.servers.test.env.NORMAL_VAR).toBe('value');
  });

  it('handles null and undefined', () => {
    expect(redactMcpEnvVars(null)).toBeNull();
    expect(redactMcpEnvVars(undefined)).toBeUndefined();
  });

  it('does not mutate the original object', () => {
    const original = {
      servers: {
        test: {
          env: { API_KEY: 'testvalue' },
        },
      },
    };
    const originalCopy = JSON.parse(JSON.stringify(original));
    redactMcpEnvVars(original);
    expect(original).toEqual(originalCopy);
  });
});

// =============================================================================
// sanitizeJsonForExport
// =============================================================================

describe('sanitizeJsonForExport', () => {
  it('normalizes user paths in string values', () => {
    const obj = {
      workspacePath: '/Users/alice/projects/app',
      logPath: '/home/bob/logs/app.log',
    };
    const sanitized = sanitizeJsonForExport(obj) as typeof obj;
    expect(sanitized.workspacePath).toBe('~/projects/app');
    expect(sanitized.logPath).toBe('~/logs/app.log');
  });

  it('redacts email addresses', () => {
    const obj = {
      user: 'Contact: user@example.com',
      admin: '[external-email]',
    };
    const sanitized = sanitizeJsonForExport(obj) as typeof obj;
    expect(sanitized.user).toContain('***@***.***');
    expect(sanitized.admin).toBe('***@***.***');
  });

  it('redacts URL-encoded (%40) email addresses (260611 calendar PII-leak postmortem)', () => {
    // Provider HTTP errors echo request URLs whose path segments carry
    // URL-encoded emails (e.g. Google calendarIds in events-path URLs).
    const obj = {
      log: 'GET /calendars/user%40example.com/events returned 404',
    };
    const sanitized = sanitizeJsonForExport(obj) as typeof obj;
    expect(sanitized.log).not.toContain('user%40example.com');
    expect(sanitized.log).toContain('***@***.***');
    expect(sanitized.log).toContain('returned 404');
  });

  it('redacts API keys', () => {
    const obj = {
      log: `Used key ${TEST_FIXTURES.ANTHROPIC_KEY}`,
      openai: `Key: ${TEST_FIXTURES.OPENAI_KEY}`,
      groq: `Using ${TEST_FIXTURES.GROQ_KEY}`,
      google: `API key: ${TEST_FIXTURES.GOOGLE_KEY}`,
    };
    const sanitized = sanitizeJsonForExport(obj) as typeof obj;
    expect(sanitized.log).toContain(EXPECTED_REDACTED.ANTHROPIC);
    expect(sanitized.openai).toContain(EXPECTED_REDACTED.OPENAI);
    expect(sanitized.groq).toContain(EXPECTED_REDACTED.GROQ);
    expect(sanitized.google).toContain(EXPECTED_REDACTED.GOOGLE);
  });

  it('redacts sensitive key values', () => {
    const obj = {
      settings: {
        apiKey: 'my-test-key-value',
        model: 'claude-sonnet-4-20250514',
        oauthToken: 'oauth-token-test-123',
      },
    };
    const sanitized = sanitizeJsonForExport(obj) as Record<string, Record<string, unknown>>;
    expect(sanitized.settings.apiKey).toBe('***REDACTED***');
    expect(sanitized.settings.model).toBe('claude-sonnet-4-20250514');
    expect(sanitized.settings.oauthToken).toBe('***REDACTED***');
  });

  it('redacts URL parameters', () => {
    const obj = {
      url: 'https://api.example.com?strata_id=testid123&token=testxyz789',
    };
    const sanitized = sanitizeJsonForExport(obj) as typeof obj;
    expect(sanitized.url).toContain('strata_id=***REDACTED***');
    expect(sanitized.url).toContain('token=***REDACTED***');
  });

  it('handles nested objects', () => {
    const obj = {
      level1: {
        level2: {
          level3: {
            path: '/Users/alice/testdir',
            apiKey: 'test-key-value',
          },
        },
      },
    };
    const sanitized = sanitizeJsonForExport(obj) as typeof obj;
    expect(sanitized.level1.level2.level3.path).toBe('~/testdir');
    expect(sanitized.level1.level2.level3.apiKey).toBe('***REDACTED***');
  });

  it('handles arrays', () => {
    const obj = {
      paths: ['/Users/alice/a', '/home/bob/b', '/var/log/c'],
      // Use "items" not "secrets" since "secrets" matches SENSITIVE_KEY_PATTERNS
      items: [{ apiKey: 'testval1', name: 'first' }, { apiKey: 'testval2', name: 'second' }],
    };
    const sanitized = sanitizeJsonForExport(obj) as Record<string, unknown>;
    expect((sanitized.paths as string[])[0]).toBe('~/a');
    expect((sanitized.paths as string[])[1]).toBe('~/b');
    expect((sanitized.paths as string[])[2]).toBe('/var/log/c');
    // After sanitization, apiKey values inside objects are redacted
    const items = sanitized.items as Array<Record<string, unknown>>;
    expect(items[0].apiKey).toBe('***REDACTED***');
    expect(items[0].name).toBe('first');
    expect(items[1].apiKey).toBe('***REDACTED***');
    expect(items[1].name).toBe('second');
  });

  it('handles null and undefined', () => {
    expect(sanitizeJsonForExport(null)).toBeNull();
    expect(sanitizeJsonForExport(undefined)).toBeUndefined();
  });

  it('does not mutate the original object', () => {
    const original = {
      path: '/Users/alice/projects',
      apiKey: 'testvalue',
    };
    const originalCopy = JSON.parse(JSON.stringify(original));
    sanitizeJsonForExport(original);
    expect(original).toEqual(originalCopy);
  });

  it('handles mixed content types', () => {
    const obj = {
      string: '/Users/alice/path',
      number: 42,
      boolean: true,
      nullValue: null,
      array: [1, 'text', { nested: '/home/bob/nested' }],
    };
    const sanitized = sanitizeJsonForExport(obj) as typeof obj;
    expect(sanitized.string).toBe('~/path');
    expect(sanitized.number).toBe(42);
    expect(sanitized.boolean).toBe(true);
    expect(sanitized.nullValue).toBeNull();
    expect((sanitized.array[2] as Record<string, unknown>).nested).toBe('~/nested');
  });

  it('is safe to use as a final pass (comprehensive example)', () => {
    const diagnosticData = {
      app: {
        version: '1.2.3',
        platform: 'darwin',
      },
      health: {
        checks: [
          {
            id: 'apiConnection',
            status: 'pass',
            details: `Connected with key ${TEST_FIXTURES.ANTHROPIC_KEY}`,
          },
        ],
      },
      environment: {
        paths: {
          home: '/Users/alice',
          workspace: '/Users/alice/projects/app',
          logs: '/home/bob/logs',
        },
        user: {
          email: 'alice@example.com',
        },
      },
      config: {
        apiKey: 'test-key-to-redact',
        model: 'claude-sonnet-4-20250514',
      },
    };

    const sanitized = sanitizeJsonForExport(diagnosticData) as typeof diagnosticData;

    // App info preserved
    expect(sanitized.app.version).toBe('1.2.3');
    expect(sanitized.app.platform).toBe('darwin');

    // API key in log message redacted
    expect(sanitized.health.checks[0].details).toContain(EXPECTED_REDACTED.ANTHROPIC);

    // Paths normalized
    expect(sanitized.environment.paths.home).toBe('~');
    expect(sanitized.environment.paths.workspace).toBe('~/projects/app');
    expect(sanitized.environment.paths.logs).toBe('~/logs');

    // Email redacted
    expect(sanitized.environment.user.email).toBe('***@***.***');

    // API key field redacted
    expect(sanitized.config.apiKey).toBe('***REDACTED***');
    expect(sanitized.config.model).toBe('claude-sonnet-4-20250514');
  });
});

// =============================================================================
// providerKeys redaction
// =============================================================================

describe('redactObjectDeep — providerKeys', () => {
  it('redacts providerKeys values', () => {
    const settings = {
      providerKeys: {
        openai: 'sk-test-openai-key',
        google: 'AIzaTestGoogleKey',
      },
      voice: { provider: 'openai-whisper' },
    };
    const redacted = redactObjectDeep(settings) as typeof settings;
    expect(redacted.providerKeys).toBe('***REDACTED***');
    expect(redacted.voice.provider).toBe('openai-whisper');
  });

  it('does not redact providerKeys when value is null', () => {
    const settings = {
      providerKeys: null,
    };
    const redacted = redactObjectDeep(settings) as typeof settings;
    expect(redacted.providerKeys).toBeNull();
  });

  it('redacts providerKeys even when value is empty object (key name matches)', () => {
    const settings = {
      providerKeys: {},
    };
    const redacted = redactObjectDeep(settings) as typeof settings;
    expect(redacted.providerKeys).toBe('***REDACTED***');
  });
});
