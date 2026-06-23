import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let tempUserData: string;

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return tempUserData;
      return os.tmpdir();
    },
  },
  shell: {
    openExternal: mocks.openExternal,
  },
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
  }),
}));

vi.mock('../oauthTelemetry', () => ({
  trackOAuthBrowserOpened: vi.fn(),
}));

vi.mock('../oauthPrimitives', () => ({
  generateCsrfState: () => 'csrf-state',
  bringAppToForeground: vi.fn(),
}));

import {
  beginMicrosoftAuthFlow,
  cancelMicrosoftAuth,
} from '../microsoftAuthService';

async function beginAuthAndReadOpenedUrl(): Promise<URL> {
  const result = await beginMicrosoftAuthFlow('microsoft-client-id');
  result.awaitedEmail.catch(() => undefined);
  return new URL(result.authUrl);
}

describe('microsoftAuthService redirect URI resolution', () => {
  beforeEach(async () => {
    tempUserData = await fs.mkdtemp(path.join(os.tmpdir(), 'ms-redirect-uri-'));
    mocks.openExternal.mockClear();
    mocks.openExternal.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    cancelMicrosoftAuth();
    vi.unstubAllEnvs();
    await fs.rm(tempUserData, { recursive: true, force: true });
  });

  it('uses the Rebel-hosted redirect URI by default', async () => {
    const authUrl = await beginAuthAndReadOpenedUrl();

    expect(authUrl.searchParams.get('redirect_uri')).toBe(
      'https://rebel-auth.mindstone.com/microsoft/callback',
    );
  });

  it('uses MICROSOFT_REDIRECT_URI when configured', async () => {
    vi.stubEnv('MICROSOFT_REDIRECT_URI', 'https://example.test/microsoft/callback');

    const authUrl = await beginAuthAndReadOpenedUrl();

    expect(authUrl.searchParams.get('redirect_uri')).toBe(
      'https://example.test/microsoft/callback',
    );
  });
});
