/**
 * Regression (260610 API split): the Google Workspace connect IPC must not
 * block on the deferred Super-MCP restart.
 *
 * The restart after a config change is drain-safe: it defers (up to 30 min)
 * while agent turns are active, and its promise resolves only when the
 * restart actually EXECUTES. Awaiting it from `google-workspace:start-auth`
 * pinned the user-facing connect flow on that deferral — the connect leg of
 * the 260610 connector-disconnect hang class (see
 * docs-private/postmortems/260610_connector_disconnect_deferred_restart_ipc_hang_postmortem.md).
 *
 * The mocked execution-awaiting reconfigure NEVER resolves, so a revert that
 * reintroduces `await reconfigureSuperMcpWithCacheRefresh...` turns the race
 * below red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const { registeredHandlers } = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('../utils/registerHandler', () => ({
  registerHandler: (
    channel: string,
    handler: (event: unknown, ...args: unknown[]) => Promise<unknown>,
  ) => {
    registeredHandlers.set(channel, handler);
  },
}));

// userData points at a per-run temp dir so copyCredentialsToInstanceDir runs
// for real against staged fixture files (no fs mocking).
const { userDataDirRef } = vi.hoisted(() => ({ userDataDirRef: { current: '' } }));
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`unexpected app.getPath(${name})`);
      return userDataDirRef.current;
    },
  },
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../../services/googleWorkspaceAuthService', () => ({
  startGoogleAuth: vi.fn(async () => 'alice@example.com'),
  removeGoogleAccount: vi.fn(),
  cancelGoogleAuth: vi.fn(),
  revokeGoogleToken: vi.fn(),
}));

vi.mock('../../services/oauthCredentials', () => ({
  resolveOAuthCredentials: vi.fn(() => ({ clientId: 'google-client-id', clientSecret: 'google-client-secret' })),
  googleCredentialSource: {},
}));

vi.mock('../../services/mcpConfigManager', () => ({
  upsertMcpServerEntry: vi.fn(),
  removeMcpServerEntry: vi.fn(),
  getMcpServerNames: vi.fn(async () => []),
}));

vi.mock('../../services/mcpServerRemovalService', () => ({
  removeMcpServerWithCleanup: vi.fn(),
}));

vi.mock('../../services/bundledMcpManager', () => ({
  generateInstanceId: (base: string, email: string) => `${base}-${email.replace(/[^a-zA-Z0-9]/g, '-')}`,
  buildGoogleWorkspaceInstancePayload: vi.fn(() => ({ name: 'GoogleWorkspace-alice-example-com' })),
}));

vi.mock('../../services/mcpService', () => ({
  resolveMcpConfigPath: vi.fn(() => '/tmp/google-connect-test/mcp.json'),
  // Merge synthesis: connect sites use the resolve-on-deferral form, NOT
  // Detached — the deferred path resolves { queued: true } promptly while the
  // idle path preserves "connect succeeded => tools usable".
  reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral: vi.fn(async () => ({ queued: true })),
  // Never resolves: simulates the restart deferred behind active agent turns.
  reconfigureSuperMcpWithCacheRefreshAndAwaitExecution: vi.fn(() => new Promise<never>(() => {})),
}));

vi.mock('../../settingsStore', () => ({
  getSettings: vi.fn(() => ({})),
}));

import { registerGoogleWorkspaceHandlers } from '../googleWorkspaceHandlers';
import { reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral } from '../../services/mcpService';

describe('google-workspace:start-auth under a deferred Super-MCP restart', () => {
  beforeEach(async () => {
    registeredHandlers.clear();
    userDataDirRef.current = await fs.mkdtemp(path.join(os.tmpdir(), 'gw-connect-test-'));
    // Stage the token file the auth service would have written for the account.
    const credentialsDir = path.join(userDataDirRef.current, 'google-workspace-mcp', 'credentials');
    await fs.mkdir(credentialsDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(credentialsDir, 'alice-example-com.token.json'),
      JSON.stringify({ access_token: 'test-access-token' }),
      { mode: 0o600 },
    );
    registerGoogleWorkspaceHandlers();
  });

  afterEach(async () => {
    await fs.rm(userDataDirRef.current, { recursive: true, force: true });
  });

  it('resolves promptly while the Super-MCP restart is deferred', async () => {
    const handler = registeredHandlers.get('google-workspace:start-auth');
    expect(handler).toBeDefined();

    // The handler does real (temp-dir) fs staging, so resolution spans a few
    // macrotasks — a 0ms-sentinel race would be a false red. The deferral
    // discriminator is the never-resolving execution-awaiting mock: if a
    // revert reintroduces `await reconfigure...AndAwaitExecution`, this await
    // never settles and the test fails on timeout.
    const winner = await handler?.(null);

    expect(winner).toEqual({ success: true, email: 'alice@example.com' });
    // The restart went through the resolve-on-deferral form with the exact
    // context string (renderer deferred-op matching + launchRebel gate).
    expect(reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral).toHaveBeenCalledWith(
      '/tmp/google-connect-test/mcp.json',
      expect.objectContaining({ context: 'google-workspace-connect' }),
    );
  });
});
