import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/rebel-plaud-test'),
  },
  shell: {
    openExternal: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../oauthTelemetry', () => ({
  trackOAuthBrowserOpened: vi.fn(),
}));

vi.mock('../../oauthPrimitives', () => ({
  bringAppToForeground: vi.fn(),
}));

import { cancelPlaudAuth, startPlaudAuth } from '../plaudAuthService';

function startAuthUrl(): URL {
  const result = startPlaudAuth('plaud-client-id', 'plaud-client-secret', { autoOpen: false });
  result.completion.catch(() => undefined);
  return new URL(result.authUrl);
}

describe('plaudAuthService redirect URI resolution', () => {
  afterEach(() => {
    cancelPlaudAuth();
    vi.unstubAllEnvs();
  });

  it('uses the Rebel-hosted redirect URI by default', () => {
    const authUrl = startAuthUrl();

    expect(authUrl.searchParams.get('redirect_uri')).toBe(
      'https://rebel-auth.mindstone.com/plaud/callback',
    );
  });

  it('uses PLAUD_REDIRECT_URI when configured', () => {
    vi.stubEnv('PLAUD_REDIRECT_URI', 'https://example.test/plaud/callback');

    const authUrl = startAuthUrl();

    expect(authUrl.searchParams.get('redirect_uri')).toBe('https://example.test/plaud/callback');
  });
});
