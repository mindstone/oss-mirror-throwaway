/**
 * Codex IPC Handlers
 *
 * Handles codex:* IPC channels for Codex OAuth account management.
 */

import type { IpcMainInvokeEvent } from 'electron';
import { codexChannels, type CodexTokensPayload } from '@shared/ipc/channels/codex';
import type { AppSettings } from '@shared/types';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { createScopedLogger } from '@core/logger';
import { getBroadcastService } from '@core/broadcastService';
import {
  codexLogin,
  codexLogout,
  getCodexStatus,
} from '../services/codexAuthService';
import { saveCodexTokens, clearCodexTokens } from '@core/services/codexTokenStorage';
import { getSettings, updateSettings, applyCodexProviderHeal } from '../settingsStore';
import { hasManagedOpenRouterKey } from '../services/openRouterTokenStorage';
import { registerHandler } from './utils/registerHandler';
import type { AutomationScheduler } from '../services/automationScheduler';

const log = createScopedLogger({ ipc: 'codex' });

type CodexHandlersDeps = {
  getScheduler?: () => AutomationScheduler;
  /**
   * Heal a stranded `activeProvider → 'codex'` after a successful reconnect and
   * return the post-heal activeProvider. Injectable for testing; defaults to the
   * real runtime-seam implementation (`defaultHealCodexProviderAfterReconnect`).
   */
  healProviderAfterReconnect?: () => AppSettings['activeProvider'];
};

const broadcastSettingsExternalUpdate = (): void => {
  try {
    getBroadcastService().sendToAllWindows('settings:external-update');
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'codexHandlers.broadcastSettingsExternalUpdate',
      reason: 'broadcast-service-unavailable',
    });
  }
};

const triggerAutomationCatchUpSweep = (deps: CodexHandlersDeps): void => {
  try {
    deps.getScheduler?.().handleAppLaunch();
  } catch (error) {
    log.warn({ err: error }, 'Failed to trigger automation catch-up sweep after Codex credential repair');
  }
};

/**
 * FOX-3494: after a successful Codex reconnect, heal `activeProvider → 'codex'`
 * if the user is stranded on an unusable provider. The reconnect event is the
 * only signal the stuck user generates, so this is the load-bearing trigger
 * (NOT version-gated — heal every reconnect). Writes the DURABLE settings store
 * directly via `updateSettings`, bypassing the renderer `onProviderChange` path
 * (which a deep-linked reconnect may skip, and whose no-op guard can drop the
 * write). Returns the post-heal activeProvider so the sweep guard reads the
 * healed value, not the stale pre-heal one.
 */
const defaultHealCodexProviderAfterReconnect = (): AppSettings['activeProvider'] => {
  const current = getSettings();
  const { migrated, healed } = applyCodexProviderHeal(current, {
    codexConnected: getCodexStatus().connected,
    hasManagedKey: hasManagedOpenRouterKey(),
  });
  if (healed) {
    updateSettings({ activeProvider: migrated.activeProvider });
    return migrated.activeProvider;
  }
  return current.activeProvider;
};

export function registerCodexHandlers(deps: CodexHandlersDeps = {}): void {
  registerHandler(
    codexChannels['codex:login'].channel,
    async (_event: IpcMainInvokeEvent) => {
      try {
        const wasConnected = getCodexStatus().connected;
        const result = await codexLogin();
        if (result.success) {
          // Heal a stranded `activeProvider` BEFORE reading it for the sweep
          // guard — else the sweep is skipped for exactly the stuck user this
          // bug afflicts (their activeProvider is still the unusable one).
          const heal = deps.healProviderAfterReconnect ?? defaultHealCodexProviderAfterReconnect;
          const activeProvider = heal();
          broadcastSettingsExternalUpdate();
          if (!wasConnected && activeProvider === 'codex') {
            triggerAutomationCatchUpSweep(deps);
          }
        }
        return result;
      } catch (error) {
        log.error({ error }, 'Failed to start Codex OAuth');
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  );

  registerHandler(
    codexChannels['codex:logout'].channel,
    async (_event: IpcMainInvokeEvent) => {
      try {
        await codexLogout();
        broadcastSettingsExternalUpdate();
        return { success: true };
      } catch (error) {
        log.error({ error }, 'Failed to logout from Codex');
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  );

  registerHandler(
    codexChannels['codex:status'].channel,
    async (_event: IpcMainInvokeEvent) => {
      try {
        return getCodexStatus();
      } catch (error) {
        log.error({ error }, 'Failed to get Codex status');
        return { connected: false };
      }
    }
  );

  // codex:sync-tokens — desktop → cloud token sync (dual-write REST channel).
  // On cloud the REST route `/api/codex/tokens` handles this directly; this
  // local handler exists so the dual-write local-side call is a no-op success
  // (tokens are already written via saveCodexTokens during login/refresh).
  // If a remote client (e.g. future mobile-initiated cloud re-sync) ever
  // invokes this channel on desktop, we still persist the pushed tokens.
  registerHandler(
    codexChannels['codex:sync-tokens'].channel,
    async (_event: IpcMainInvokeEvent, payload: { tokens: CodexTokensPayload | null }) => {
      try {
        if (payload?.tokens === null) {
          clearCodexTokens({
            cause: 'sync_null',
            source: 'codex_sync_channel',
          });
        } else if (payload?.tokens) {
          saveCodexTokens(payload.tokens, {
            cause: 'sync_update',
            source: 'codex_sync_channel',
          });
        }
        return { ok: true };
      } catch (error) {
        log.error({ error }, 'Failed to sync Codex tokens');
        return { ok: false };
      }
    }
  );

  log.info('Codex IPC handlers registered');
}
