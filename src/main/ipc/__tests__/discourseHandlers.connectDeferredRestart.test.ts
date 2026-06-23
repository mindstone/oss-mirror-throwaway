/**
 * Regression (260610 API split): the Discourse connect IPC must not block on
 * the deferred Super-MCP restart.
 *
 * The restart after a config change is drain-safe: it defers (up to 30 min)
 * while agent turns are active, and its promise resolves only when the
 * restart actually EXECUTES. Awaiting it from `discourse:start-auth` pinned
 * the user-facing connect flow on that deferral — the connect leg of the
 * 260610 connector-disconnect hang class (see
 * docs-private/postmortems/260610_connector_disconnect_deferred_restart_ipc_hang_postmortem.md).
 *
 * The mocked execution-awaiting reconfigure NEVER resolves, so a revert that
 * reintroduces `await reconfigureSuperMcpWithCacheRefresh...` turns the race
 * below red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockIpcHandlers } = vi.hoisted(() => ({
  mockIpcHandlers: {} as Record<string, (...args: unknown[]) => unknown>,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      mockIpcHandlers[channel] = handler;
    },
  },
}));

vi.mock('../../services/discourseAuthService', () => ({
  startDiscourseAuth: vi.fn(() => ({
    completion: Promise.resolve({ username: 'rebel-user' }),
  })),
  cancelDiscourseAuth: vi.fn(),
}));

vi.mock('../../services/bundledMcpManager', () => ({
  buildDiscourseWritePayload: vi.fn(() => ({ name: 'DiscourseWrite' })),
}));

vi.mock('../../services/mcpConfigManager', () => ({
  upsertMcpServerEntry: vi.fn(),
}));

vi.mock('../../services/mcpService', () => ({
  resolveMcpConfigPath: vi.fn(() => '/tmp/discourse-connect-test/mcp.json'),
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

import { registerDiscourseHandlers } from '../discourseHandlers';
import { reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral } from '../../services/mcpService';

describe('discourse:start-auth under a deferred Super-MCP restart', () => {
  beforeEach(() => {
    for (const channel of Object.keys(mockIpcHandlers)) {
      delete mockIpcHandlers[channel];
    }
    vi.clearAllMocks();
    registerDiscourseHandlers();
  });

  it('resolves promptly while the Super-MCP restart is deferred', async () => {
    const handler = mockIpcHandlers['discourse:start-auth'];
    expect(handler).toBeDefined();

    const sentinel = Symbol('connect-still-pending');
    const winner = await Promise.race([
      handler(),
      // Macrotask fires only after all pending microtasks drain.
      new Promise((resolve) => setTimeout(() => resolve(sentinel), 0)),
    ]);

    expect(winner).toEqual({ success: true, username: 'rebel-user' });
    // The restart went through the resolve-on-deferral form with the exact
    // context string (renderer deferred-op matching + launchRebel gate).
    expect(reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral).toHaveBeenCalledWith(
      '/tmp/discourse-connect-test/mcp.json',
      expect.objectContaining({ context: 'discourse-connect' }),
    );
  });
});
