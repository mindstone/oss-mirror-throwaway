/**
 * Discourse IPC Handlers
 *
 * Handles IPC calls for Discourse User API Key auth flow.
 * Owns the full lifecycle: auth → write profile → register MCP → reconfigure Super-MCP.
 * This mirrors the Microsoft/Slack pattern where the auth handler owns MCP registration
 * to avoid race conditions (profile must exist before MCP starts).
 */

import { ipcMain } from 'electron';
import { createScopedLogger } from '@core/logger';
import {
  startDiscourseAuth,
  cancelDiscourseAuth,
} from '../services/discourseAuthService';
import { buildDiscourseWritePayload } from '../services/bundledMcpManager';
import { upsertMcpServerEntry } from '../services/mcpConfigManager';
import { resolveMcpConfigPath, reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral } from '../services/mcpService';
import { MCP_RESTART_CONTEXT_DISCOURSE_CONNECT } from '@shared/utils/mcpRestartContexts';
import { getSettings } from '../settingsStore';

const log = createScopedLogger({ ipc: 'discourse' });

const REBELS_COMMUNITY_URL = 'https://rebels.mindstone.com';

export function registerDiscourseHandlers(): void {
  ipcMain.handle('discourse:start-auth', async () => {
    try {
      const { completion } = startDiscourseAuth(REBELS_COMMUNITY_URL);
      const result = await completion;

      // Auth succeeded and profile is written — now register the MCP server
      try {
        const settings = getSettings();
        const resolvedPath = resolveMcpConfigPath(settings);
        if (resolvedPath) {
          const payload = buildDiscourseWritePayload({ username: result.username });
          await upsertMcpServerEntry(resolvedPath, payload);
          log.info('Discourse write MCP registered after successful auth');

          // Resolve-on-deferral (Stage 4, 260610_gworkspace-mcp-error-disconnect-hang):
          // resolves promptly ({ queued: true }) when the restart is deferred
          // behind active agent turns; idle path still awaits the executed
          // restart. Context byte-identical (renderer deferred-op exact-match).
          try {
            const { queued } = await reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral(resolvedPath, { context: MCP_RESTART_CONTEXT_DISCOURSE_CONNECT });
            log.info({ queued }, 'Super-MCP reconfigure requested after Discourse connect');
          } catch (reconfigError) {
            log.warn({ err: reconfigError }, 'Failed to hot-reload Super-MCP (restart may be needed)');
          }
        }
      } catch (mcpError) {
        log.warn({ err: mcpError }, 'Failed to register Discourse MCP after auth');
      }

      return { success: true, username: result.username };
    } catch (error) {
      log.error({ error }, 'Failed to complete Discourse auth');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  ipcMain.handle('discourse:cancel-auth', () => {
    cancelDiscourseAuth();
  });

  log.info('Discourse IPC handlers registered');
}
