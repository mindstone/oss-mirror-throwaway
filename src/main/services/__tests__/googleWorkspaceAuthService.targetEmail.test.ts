/**
 * Stage 3 [GPT-F2] (260611_calendar-cache-attention): target-scoped OAuth.
 *
 * Pins the auth-service behavior the new per-account Reconnect CTA depends on:
 * when `startGoogleAuth` is called with `targetEmail`, an OAuth callback that
 * authenticates a DIFFERENT account is rejected ("did not match the requested
 * account") — and a matching account (case-insensitive) resolves normally.
 *
 * Exercises the REAL loopback callback server: we capture the redirect URI
 * from the (mocked) OAuth2Client constructor and hit /callback over HTTP.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const shellOpenExternalMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => process.env.__GOOGLE_TARGET_TEST_USER_DATA__ ?? os.tmpdir()),
  },
  shell: { openExternal: shellOpenExternalMock },
}));

const oauthState = vi.hoisted(() => ({
  instances: [] as Array<{ redirectUri: string; getTokenInfo: ReturnType<typeof vi.fn> }>,
  tokenInfoEmail: 'someone@example.com',
}));

vi.mock('google-auth-library', () => ({
  OAuth2Client: class MockOAuth2Client {
    redirectUri: string;
    generateAuthUrl: ReturnType<typeof vi.fn>;
    getToken: ReturnType<typeof vi.fn>;
    setCredentials: ReturnType<typeof vi.fn>;
    getTokenInfo: ReturnType<typeof vi.fn>;

    constructor(_clientId: string, _clientSecret: string, redirectUri: string) {
      this.redirectUri = redirectUri;
      this.generateAuthUrl = vi.fn(
        (params: { state: string }) => `https://accounts.google.com/o/oauth2/auth?state=${params.state}`,
      );
      this.getToken = vi.fn(async () => ({
        tokens: {
          access_token: 'at',
          refresh_token: 'rt',
          scope: 'scope',
          token_type: 'Bearer',
          expiry_date: Date.now() + 3_600_000,
        },
      }));
      this.setCredentials = vi.fn();
      this.getTokenInfo = vi.fn(async () => ({ email: oauthState.tokenInfoEmail }));
      oauthState.instances.push(this);
    }
  },
}));

vi.mock('../oauthTelemetry', () => ({
  trackOAuthBrowserOpened: vi.fn(),
  trackOAuthCallbackReceived: vi.fn(),
}));

vi.mock('../oauthPrimitives', () => ({
  generateCsrfState: vi.fn(() => 'test-csrf-state'),
  fetchWithTimeoutBestEffort: vi.fn(async () => undefined),
  bringAppToForeground: vi.fn(),
}));

import { startGoogleAuth } from '../googleWorkspaceAuthService';

async function hitCallback(redirectUri: string, query: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${redirectUri}?${query}`, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
  });
}

async function waitForBrowserOpen(): Promise<void> {
  await vi.waitFor(() => {
    expect(shellOpenExternalMock).toHaveBeenCalled();
  });
}

describe('startGoogleAuth — targetEmail scoping (Stage 3 [GPT-F2] dependency)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    oauthState.instances.length = 0;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'google-ws-target-email-'));
    process.env.__GOOGLE_TARGET_TEST_USER_DATA__ = tmpDir;
  });

  afterEach(async () => {
    delete process.env.__GOOGLE_TARGET_TEST_USER_DATA__;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects the callback when the authenticated account does not match targetEmail', async () => {
    oauthState.tokenInfoEmail = 'wrong.account@example.com';

    const authPromise = startGoogleAuth('cid', 'cs', { targetEmail: '[external-email]' });
    // Surface rejection handling immediately so the later assertion can't race.
    const outcome = authPromise.then(
      () => ({ resolved: true as const }),
      (error: unknown) => ({ resolved: false as const, error }),
    );
    await waitForBrowserOpen();

    const status = await hitCallback(oauthState.instances[0].redirectUri, 'code=abc&state=test-csrf-state');
    expect(status).toBe(500);

    const result = await outcome;
    expect(result.resolved).toBe(false);
    expect((result as { error: Error }).error.message).toContain(
      'did not match the requested account',
    );
  });

  it('resolves when the authenticated account matches targetEmail case-insensitively', async () => {
    oauthState.tokenInfoEmail = '[external-email]';

    const authPromise = startGoogleAuth('cid', 'cs', { targetEmail: '[external-email]' });
    await waitForBrowserOpen();

    const status = await hitCallback(oauthState.instances[0].redirectUri, 'code=abc&state=test-csrf-state');
    expect(status).toBe(200);

    await expect(authPromise).resolves.toBe('[external-email]');
  });

  it('resolves without any target check when targetEmail is omitted (back-compat)', async () => {
    oauthState.tokenInfoEmail = 'brand.new@example.com';

    const authPromise = startGoogleAuth('cid', 'cs');
    await waitForBrowserOpen();

    const status = await hitCallback(oauthState.instances[0].redirectUri, 'code=abc&state=test-csrf-state');
    expect(status).toBe(200);

    await expect(authPromise).resolves.toBe('brand.new@example.com');
  });
});
