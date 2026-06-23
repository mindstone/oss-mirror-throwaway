/**
 * Regression test for REBEL-12M: GitHub OAuth token not persisting between sessions.
 *
 * Root cause: writeClientFile() was not including client_secret in the persisted
 * GitHub_client.json, which prevented Super-MCP's SDK from refreshing tokens on restart.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

let testTokensDir: string;

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../oauthTelemetry', () => ({
  trackOAuthBrowserOpened: vi.fn(),
}));

vi.mock('../oauthPrimitives', () => ({
  bringAppToForeground: vi.fn(),
  generateCsrfState: () => 'test-state',
}));

vi.mock('../../utils/testIsolation', () => ({
  getSuperMcpOAuthTokensDir: () => testTokensDir,
}));

describe('githubAuthService client secret persistence (REBEL-12M)', () => {
  beforeEach(async () => {
    testTokensDir = path.join(os.tmpdir(), `rebel-test-github-${Date.now()}`);
    await fs.mkdir(testTokensDir, { recursive: true });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(testTokensDir, { recursive: true, force: true });
  });

  it('writeClientFile includes client_secret from env credentials', async () => {
    vi.stubEnv('GITHUB_CLIENT_ID', 'github-client-id');
    vi.stubEnv('GITHUB_CLIENT_SECRET', 'github-client-secret');
    vi.resetModules();
    const mod = await import('../githubAuthService');

    await mod._testOnly.writeClientFile();

    const clientPath = path.join(testTokensDir, 'GitHub_client.json');
    const clientContent = await fs.readFile(clientPath, 'utf-8');
    const clientJson = JSON.parse(clientContent);

    expect(clientJson.client_id).toBe('github-client-id');
    expect(clientJson.redirect_uris).toEqual(['https://rebel-auth.mindstone.com/github/callback']);
    expect(clientJson.client_secret).toBe('github-client-secret');
  });

  it('writeClientFile uses GITHUB_REDIRECT_URI when configured', async () => {
    vi.stubEnv('GITHUB_CLIENT_ID', 'github-client-id');
    vi.stubEnv('GITHUB_CLIENT_SECRET', 'github-client-secret');
    vi.stubEnv('GITHUB_REDIRECT_URI', 'https://example.test/github/callback');
    vi.resetModules();
    const mod = await import('../githubAuthService');

    await mod._testOnly.writeClientFile();

    const clientPath = path.join(testTokensDir, 'GitHub_client.json');
    const clientContent = await fs.readFile(clientPath, 'utf-8');
    const clientJson = JSON.parse(clientContent);

    expect(clientJson.redirect_uris).toEqual(['https://example.test/github/callback']);
  });
});
