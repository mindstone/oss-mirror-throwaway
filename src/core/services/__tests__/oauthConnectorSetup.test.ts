import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildConnectorConfigLogPayload,
  CONNECTOR_SETUP_DOCS_PATH,
  describeMissingOAuthCredentials,
  getConnectorConfigState,
  oauthConnectorSetupDescriptors,
  setupConnectors,
  type OAuthConnectorSetupDescriptor,
  type SetupConnector,
} from '../oauthConnectorSetup';
import { setOAuthCredentialsProvider } from '../oauthCredentials';

const ALL_CONNECTOR_ENV_VARS = [
  'SLACK_CLIENT_ID',
  'SLACK_CLIENT_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'HUBSPOT_CLIENT_ID',
  'HUBSPOT_CLIENT_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID',
  'PLAUD_CLIENT_ID',
  'PLAUD_CLIENT_SECRET',
  'DIGITAL_OCEAN_CLIENT_ID',
  'DIGITAL_OCEAN_CLIENT_SECRET',
  'SALESFORCE_CLIENT_ID',
  'SALESFORCE_CLIENT_SECRET',
];

const REDIRECT_ENV_VARS = [
  'SLACK_REDIRECT_URI',
  'MICROSOFT_REDIRECT_URI',
  'SALESFORCE_REDIRECT_URI',
  'PLAUD_REDIRECT_URI',
  'GITHUB_REDIRECT_URI',
  'DIGITAL_OCEAN_REDIRECT_URI',
];

describe('oauthConnectorSetup', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    setOAuthCredentialsProvider(null);
    for (const name of [...ALL_CONNECTOR_ENV_VARS, ...REDIRECT_ENV_VARS]) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    setOAuthCredentialsProvider(null);
    for (const name of [...ALL_CONNECTOR_ENV_VARS, ...REDIRECT_ENV_VARS]) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  describe('descriptor map', () => {
    it('covers exactly the eight in-scope connectors', () => {
      expect([...setupConnectors].sort()).toEqual(
        [
          'digitalocean',
          'github',
          'google',
          'hubspot',
          'microsoft',
          'plaud',
          'salesforce',
          'slack',
        ].sort(),
      );
    });

    it('excludes discourse', () => {
      expect(setupConnectors).not.toContain('discourse' as SetupConnector);
      expect(
        (oauthConnectorSetupDescriptors as Record<string, unknown>).discourse,
      ).toBeUndefined();
    });

    it('marks Microsoft as PKCE (no secret) and omits its secret env var', () => {
      // Type via the interface (not the narrowed `as const` literal) so `envClientSecret` —
      // declared optional on OAuthConnectorSetupDescriptor — is a legal access. Reading it off
      // the narrowed literal is a TS2339 (the property is correctly omitted from that member).
      const ms: OAuthConnectorSetupDescriptor = oauthConnectorSetupDescriptors.microsoft;
      expect(ms.requiresSecret).toBe(false);
      expect(ms.envClientId).toBe('MICROSOFT_CLIENT_ID');
      expect(ms.envClientSecret).toBeUndefined();
    });

    it('throws on an unknown setup connector (defence-in-depth across the IPC boundary)', () => {
      expect(() =>
        describeMissingOAuthCredentials('discourse' as unknown as SetupConnector),
      ).toThrow(/unknown setup connector/i);
    });

    it('uses a loopback redirect kind only for Google and HubSpot', () => {
      const loopback = setupConnectors.filter((c) =>
        oauthConnectorSetupDescriptors[c].redirect.kind.startsWith('loopback'),
      );
      expect(loopback.sort()).toEqual(['google', 'hubspot']);
    });

    it('marks only Plaud as non-self-serve (waitlist/beta)', () => {
      const notSelfServe = setupConnectors.filter(
        (c) => !oauthConnectorSetupDescriptors[c].selfServe,
      );
      expect(notSelfServe).toEqual(['plaud']);
    });

    it('uses public setup URLs only (no internal/mindstone links)', () => {
      for (const c of setupConnectors) {
        const url = oauthConnectorSetupDescriptors[c].setupUrl;
        expect(url).toMatch(/^https:\/\//);
        expect(url).not.toMatch(/mindstone/i);
      }
    });
  });

  describe('describeMissingOAuthCredentials', () => {
    it('returns both client id + secret env vars for secret providers', () => {
      const result = describeMissingOAuthCredentials('slack');
      expect(result.code).toBe('oauth-credentials-not-configured');
      expect(result.envVars).toEqual(['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET']);
      expect(result.displayName).toBe('Slack');
    });

    it('returns only the client id env var for Microsoft (PKCE)', () => {
      const result = describeMissingOAuthCredentials('microsoft');
      expect(result.envVars).toEqual(['MICROSOFT_CLIENT_ID']);
    });

    it('uses the worker callback (single URI, no note) for worker-topology connectors', () => {
      const result = describeMissingOAuthCredentials('slack');
      expect(result.redirectUris).toEqual(['https://rebel-auth.mindstone.com/slack/callback']);
      expect(result.redirectNote).toBeUndefined();
    });

    it('honors the per-connector redirect env override', () => {
      process.env.SLACK_REDIRECT_URI = 'https://example.test/slack/cb';
      const result = describeMissingOAuthCredentials('slack');
      expect(result.redirectUris).toEqual(['https://example.test/slack/cb']);
    });

    it('models Google as Desktop-app loopback (no URI to register, note explains it)', () => {
      const google = describeMissingOAuthCredentials('google');
      expect(google.redirectUris).toEqual([]);
      expect(google.redirectNote).toMatch(/127\.0\.0\.1/);
      expect(google.redirectNote).toMatch(/desktop app/i);
      expect(JSON.stringify(google)).not.toMatch(/rebel-auth\.mindstone\.com/);
    });

    it('lists all four fixed loopback ports for HubSpot (register all)', () => {
      const hubspot = describeMissingOAuthCredentials('hubspot');
      expect(hubspot.redirectUris).toEqual([
        'http://localhost:8081/callback',
        'http://localhost:8082/callback',
        'http://localhost:8083/callback',
        'http://localhost:8084/callback',
      ]);
      expect(hubspot.redirectNote).toMatch(/all four/i);
    });

    it('carries the self-serve flag (false for Plaud)', () => {
      expect(describeMissingOAuthCredentials('slack').selfServe).toBe(true);
      expect(describeMissingOAuthCredentials('plaud').selfServe).toBe(false);
    });

    it('produces a neutral, build-agnostic message (no .env.local)', () => {
      const result = describeMissingOAuthCredentials('hubspot');
      expect(result.message).toBe(
        'HubSpot needs OAuth client credentials before anyone can connect.',
      );
      expect(result.message).not.toMatch(/\.env/);
    });
  });

  describe('getConnectorConfigState', () => {
    it('reports every in-scope connector as unconfigured when no env/provider set', () => {
      const state = getConnectorConfigState();
      expect(state).toHaveLength(setupConnectors.length);
      expect(state.every((s) => s.configured === false)).toBe(true);
    });

    it('reflects env presence for a secret provider (needs both vars)', () => {
      process.env.SLACK_CLIENT_ID = 'id';
      let state = getConnectorConfigState();
      expect(state.find((s) => s.provider === 'slack')?.configured).toBe(false);

      process.env.SLACK_CLIENT_SECRET = 'secret';
      state = getConnectorConfigState();
      expect(state.find((s) => s.provider === 'slack')?.configured).toBe(true);
    });

    it('reflects env presence for Microsoft (client id only)', () => {
      process.env.MICROSOFT_CLIENT_ID = 'id';
      const state = getConnectorConfigState();
      expect(state.find((s) => s.provider === 'microsoft')?.configured).toBe(true);
    });

    it('reflects an injected provider when env is unset', () => {
      setOAuthCredentialsProvider({
        get: (p) =>
          p === 'github' ? { clientId: 'id', clientSecret: 'secret' } : null,
      });
      const state = getConnectorConfigState();
      expect(state.find((s) => s.provider === 'github')?.configured).toBe(true);
      expect(state.find((s) => s.provider === 'slack')?.configured).toBe(false);
    });
  });

  describe('buildConnectorConfigLogPayload (OSS startup-log payload)', () => {
    it('maps every in-scope connector to a configured/unconfigured status', () => {
      const payload = buildConnectorConfigLogPayload([
        { provider: 'slack', configured: true },
        { provider: 'google', configured: false },
        { provider: 'hubspot', configured: false },
        { provider: 'github', configured: true },
        { provider: 'microsoft', configured: false },
        { provider: 'plaud', configured: false },
        { provider: 'digitalocean', configured: false },
        { provider: 'salesforce', configured: false },
      ]);
      expect(payload.kind).toBe('oss-connector-credential-status');
      expect(payload.connectors).toEqual({
        slack: 'configured',
        google: 'unconfigured',
        hubspot: 'unconfigured',
        github: 'configured',
        microsoft: 'unconfigured',
        plaud: 'unconfigured',
        digitalocean: 'unconfigured',
        salesforce: 'unconfigured',
      });
      // Status strings only — every value is a literal status, never a credential value.
      for (const status of Object.values(payload.connectors)) {
        expect(['configured', 'unconfigured']).toContain(status);
      }
    });

    it('points at the (Stage 6) OSS connector setup guide and never leaks secrets', () => {
      setOAuthCredentialsProvider({
        // A credential value that MUST NOT appear anywhere in the payload.
        get: () => ({ clientId: 'super-secret-id', clientSecret: 'super-secret-secret' }),
      });
      const payload = buildConnectorConfigLogPayload(getConnectorConfigState());
      expect(payload.setupDocs).toBe(CONNECTOR_SETUP_DOCS_PATH);
      expect(CONNECTOR_SETUP_DOCS_PATH).toBe('docs/connectors/CONNECTOR_SETUP.md');
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toMatch(/super-secret/);
      // Defence-in-depth: no env-var NAME with an "=value" assignment sneaks through either.
      expect(serialized).not.toMatch(/CLIENT_ID=|CLIENT_SECRET=/);
    });

    it('covers exactly the in-scope connectors (full enumeration, no drift)', () => {
      const payload = buildConnectorConfigLogPayload(getConnectorConfigState());
      expect(Object.keys(payload.connectors).sort()).toEqual([...setupConnectors].sort());
    });
  });

  describe('CONNECTOR_SETUP.md docs parity (Stage 6)', () => {
    // The in-app ConnectorSetupDialog links to `${CONNECTOR_SETUP_DOCS_PATH}#<docsAnchor>`.
    // This asserts the published doc actually exists at that path and contains a heading whose
    // GitHub-style slug matches every descriptor's `docsAnchor`, so the dialog's "Setup guide"
    // links never 404 to a missing anchor.
    const docsAbsPath = path.resolve(
      __dirname,
      '../../../../',
      CONNECTOR_SETUP_DOCS_PATH,
    );
    const docSource = fs.readFileSync(docsAbsPath, 'utf8');

    // Mirror GitHub's heading-anchor slug algorithm closely enough for our headings (which are
    // single ASCII words): lowercase, strip non-word/space/hyphen chars, spaces → hyphens.
    const headingSlugs = new Set(
      docSource
        .split('\n')
        .filter((line) => /^#{1,6}\s+/.test(line))
        .map((line) =>
          line
            .replace(/^#{1,6}\s+/, '')
            .trim()
            .toLowerCase()
            .replace(/[^\w\s-]/g, '')
            .replace(/\s+/g, '-'),
        ),
    );

    it('CONNECTOR_SETUP_DOCS_PATH points at the published doc', () => {
      expect(CONNECTOR_SETUP_DOCS_PATH).toBe('docs/connectors/CONNECTOR_SETUP.md');
      expect(fs.existsSync(docsAbsPath)).toBe(true);
    });

    it('every connector docsAnchor resolves to a heading in the doc', () => {
      for (const connector of setupConnectors) {
        const anchor = oauthConnectorSetupDescriptors[connector].docsAnchor;
        expect(anchor.startsWith('#')).toBe(true);
        const slug = anchor.slice(1);
        // Parity with the renderer: ConnectorSetupDialog builds `…#${provider}`.
        expect(slug).toBe(connector);
        expect(headingSlugs.has(slug)).toBe(true);
      }
    });

    it('contains no internal employee email / @example.com PII (OSS-surface safe)', () => {
      // The worker hostname rebel-auth.mindstone.com is allowed (no `@`); an `@example.com`
      // email address is not. This mirrors the check:oss-surface forbidden-pattern intent.
      expect(docSource).not.toMatch(/@mindstone\.com\b/i);
    });
  });

  describe('OSS startup-log wiring in main bootstrap', () => {
    // Stage 4 scope guardrail: the connector-status line is OSS-only and emitted exactly once at
    // bootstrap. Asserting against the source keeps the guard honest without driving the Electron
    // main process (mirrors ossNullAuthProvider.bootstrap.test.ts's source-level assertions).
    const mainSource = fs.readFileSync(
      path.resolve(__dirname, '../../../main/index.ts'),
      'utf8',
    );

    it('emits the connector-status line only under the isOssBuild guard', () => {
      // The payload builder is invoked inside an `isOssBuild === true` guard.
      expect(mainSource).toMatch(/isOssBuild\s*===\s*true/);
      expect(mainSource).toContain('buildConnectorConfigLogPayload(getConnectorConfigState())');
      const guardIdx = mainSource.indexOf('getCachedAuthConfig()?.isOssBuild === true');
      const callIdx = mainSource.indexOf('buildConnectorConfigLogPayload(getConnectorConfigState())');
      expect(guardIdx).toBeGreaterThan(-1);
      expect(callIdx).toBeGreaterThan(guardIdx);
    });

    it('emits the connector-status line exactly once (not per connect attempt)', () => {
      const occurrences = mainSource.split('buildConnectorConfigLogPayload(').length - 1;
      expect(occurrences).toBe(1);
    });
  });
});
