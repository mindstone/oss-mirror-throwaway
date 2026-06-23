/**
 * L1 — commercial OAuth credential-resolution runtime test (CI-able, no keys, no network).
 *
 * Runtime complement to the static `scripts/check-commercial-capability-parity.ts`. This is
 * the cheapest always-on catch for the OSS-scrub regression class documented in
 * docs/plans/260608_connector-live-smoke-tests/PLAN.md: Stage 7 (`1d563956e`) removed the
 * embedded credentials and nothing replaced them for the commercial build, so every OAuth
 * connector silently broke and no gate fired (type-check + unit tests + the OSS
 * broken-by-default behaviour all stayed green).
 *
 * What it asserts (sub-millisecond, no I/O):
 *  - With the REAL commercial provider (`LIVE_OAUTH_CREDENTIALS_PROVIDER` from
 *    `@private/mindstone/bootstrap`) registered and every connector env var cleared,
 *    resolution is NON-NULL for all 7 commercial connectors (google/slack/hubspot/github/
 *    microsoft(clientId)/plaud/digitalocean). This is the assertion that THE bug would have
 *    failed.
 *  - With the OSS stub provider registered (env still cleared), all resolve NULL — the
 *    broken-by-default contract, asserted so a future change can't silently grant OSS builds
 *    embedded creds.
 *
 * Env vars are cleared so the provider — not an ambient developer/CI env pair — is what's
 * being exercised. The provider is always restored to null in afterEach so no other test
 * inherits a registered provider.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIVE_OAUTH_CREDENTIALS_PROVIDER } from '@private/mindstone/bootstrap';
import { LIVE_OAUTH_CREDENTIALS_PROVIDER as OSS_STUB_OAUTH_CREDENTIALS_PROVIDER } from '../oss/private-mindstone-stub/services/oauthCredentialsProvider';
import {
  githubCredentialSource,
  googleCredentialSource,
  hubspotCredentialSource,
  microsoftCredentialSource,
  resolveDigitalOceanCredentials,
  resolveMicrosoftClientId,
  resolveOAuthCredentials,
  resolvePlaudCredentials,
  setOAuthCredentialsProvider,
  slackCredentialSource,
} from '@core/services/oauthCredentials';

// The connector env var pairs that, if set, would shadow the provider. Cleared before each
// test so resolution exercises the provider only — exactly the desktop/CI shape.
const CONNECTOR_ENV_VARS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'SLACK_CLIENT_ID',
  'SLACK_CLIENT_SECRET',
  'HUBSPOT_CLIENT_ID',
  'HUBSPOT_CLIENT_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID',
  'PLAUD_CLIENT_ID',
  'PLAUD_CLIENT_SECRET',
  'DIGITAL_OCEAN_CLIENT_ID',
  'DIGITAL_OCEAN_CLIENT_SECRET',
] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const name of CONNECTOR_ENV_VARS) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  // Always clear the provider so no other test inherits a registered provider.
  setOAuthCredentialsProvider(null);
  for (const name of CONNECTOR_ENV_VARS) {
    const value = savedEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('commercial OAuth credential resolution (L1, no keys, no network)', () => {
  describe('with the real commercial provider registered', () => {
    beforeEach(() => {
      setOAuthCredentialsProvider(LIVE_OAUTH_CREDENTIALS_PROVIDER);
    });

    it('resolves a clientId+clientSecret pair for every secret-bearing OAuth connector', () => {
      // These are the connectors whose embedded creds OSS-scrub Stage 7 dropped. A null here
      // is the exact shape of THE shipped regression.
      expect(resolveOAuthCredentials(googleCredentialSource)).not.toBeNull();
      expect(resolveOAuthCredentials(slackCredentialSource)).not.toBeNull();
      expect(resolveOAuthCredentials(hubspotCredentialSource)).not.toBeNull();
      expect(resolveOAuthCredentials(githubCredentialSource)).not.toBeNull();
      expect(resolvePlaudCredentials()).not.toBeNull();
      expect(resolveDigitalOceanCredentials()).not.toBeNull();
    });

    it('resolves the clientId for Microsoft (PKCE public client, clientId only)', () => {
      expect(resolveMicrosoftClientId(microsoftCredentialSource)).not.toBeNull();
    });

    it('returns a non-empty clientId and clientSecret (not just a truthy object)', () => {
      const slack = resolveOAuthCredentials(slackCredentialSource);
      expect(slack?.clientId?.length ?? 0).toBeGreaterThan(0);
      expect(slack?.clientSecret?.length ?? 0).toBeGreaterThan(0);
    });
  });

  describe('with the OSS stub provider registered (broken-by-default)', () => {
    beforeEach(() => {
      setOAuthCredentialsProvider(OSS_STUB_OAUTH_CREDENTIALS_PROVIDER);
    });

    it('resolves NULL for every OAuth connector (no embedded creds in OSS)', () => {
      expect(resolveOAuthCredentials(googleCredentialSource)).toBeNull();
      expect(resolveOAuthCredentials(slackCredentialSource)).toBeNull();
      expect(resolveOAuthCredentials(hubspotCredentialSource)).toBeNull();
      expect(resolveOAuthCredentials(githubCredentialSource)).toBeNull();
      expect(resolvePlaudCredentials()).toBeNull();
      expect(resolveDigitalOceanCredentials()).toBeNull();
      expect(resolveMicrosoftClientId(microsoftCredentialSource)).toBeNull();
    });
  });
});
