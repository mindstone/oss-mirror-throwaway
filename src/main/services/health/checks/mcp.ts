/**
 * MCP Health Checks
 */

import fs from 'node:fs/promises';
import type { AppSettings } from '@shared/types';
import { superMcpHttpManager } from '../../superMcpHttpManager';
import { resolveMcpConfigPath, describeMcpConfiguration, MCP_CONFIG_FS_EXHAUSTION_MESSAGE } from '../../mcpService';
import { isTooManyOpenFilesError } from '@core/utils/emfileRetry';
import type { CheckResult } from '../types';
import {
  BUNDLED_SERVER_NAMES,
  defineSafeCheckDetails,
  safeClosedSetArray,
} from '@core/services/health/safeCheckDetails';

export async function checkMcpConfigValid(settings: AppSettings): Promise<CheckResult> {
  const id = 'mcpConfigValid';
  const name = 'MCP Configuration';

  try {
    const summary = await describeMcpConfiguration(settings, true);

    if (summary.status === 'missing') {
      const superMcpState = superMcpHttpManager.getState();
      if (superMcpState.isRunning) {
        return {
          id,
          name,
          status: 'pass',
          message: 'Using Super-MCP (tools via marketplace)',
          details: { mode: 'super-mcp', port: superMcpState.port },
        };
      }
      return {
        id,
        name,
        status: 'pass',
        message: 'No MCP connectors configured yet',
        details: { mcpConfigFile: settings.mcpConfigFile },
      };
    }

    if (summary.status === 'error') {
      // A transient file-descriptor exhaustion (EMFILE) reading the MCP config
      // self-heals once FD pressure clears — classify it as `warn`, NOT a hard
      // `fail`. A hard fail here is non-transient in App.tsx's health-toast
      // aggregator, so it drives an error-level "needs attention" toast + Sentry
      // event for a blip that resolves on the next poll (REBEL-ZF). Genuine /
      // persistent config errors (read+recreate or parse+recreate failure) still
      // fail.
      if (summary.error === MCP_CONFIG_FS_EXHAUSTION_MESSAGE) {
        return {
          id,
          name,
          status: 'warn',
          message: summary.error,
          details: { path: summary.configPath },
          remediation: 'Temporary file-access pressure — usually clears on its own. If it persists, close other apps or restart.',
        };
      }
      return {
        id,
        name,
        status: 'fail',
        message: summary.error ?? 'MCP config error',
        details: { path: summary.configPath },
        remediation: 'Check the MCP config file for errors',
      };
    }

    const mode = summary.mode;
    let serverCount = summary.upstreamCount;
    if (mode === 'super-mcp' && summary.router?.upstreamServers) {
      serverCount = summary.router.upstreamServers.length;
    }

    if (mode === 'super-mcp') {
      const superMcpState = superMcpHttpManager.getState();
      if (superMcpState.isRunning) {
        const msg = serverCount > 0 
          ? `${serverCount} server(s) configured (super-mcp mode)`
          : 'Super-MCP running (tools via marketplace)';
        return {
          id,
          name,
          status: 'pass',
          message: msg,
          details: { path: summary.configPath, serverCount, mode, port: superMcpState.port },
        };
      }
    }

    if (serverCount === 0) {
      return {
        id,
        name,
        status: 'pass',
        message: 'No MCP connectors configured yet',
        details: { path: summary.configPath, mode },
      };
    }

    return {
      id,
      name,
      status: 'pass',
      message: `${serverCount} server(s) configured (${mode} mode)`,
      details: { path: summary.configPath, serverCount, mode },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    // Defensive: describeMcpConfiguration normally catches its own I/O errors,
    // but if a transient EMFILE/ENFILE propagates, treat it as `warn` (transient,
    // self-healing) rather than a hard `fail` — same rationale as the
    // fs-exhaustion branch above (REBEL-ZF).
    if (isTooManyOpenFilesError(error)) {
      return {
        id,
        name,
        status: 'warn',
        message: 'MCP config temporarily unavailable (too many open files)',
        remediation: 'Temporary file-access pressure — usually clears on its own. If it persists, close other apps or restart.',
      };
    }
    return {
      id,
      name,
      status: 'fail',
      message: `MCP config check failed: ${message}`,
      remediation: 'Check the MCP config file path and format',
    };
  }
}

export async function checkSuperMcpHealth(settings: AppSettings): Promise<CheckResult> {
  const id = 'superMcpHealth';
  const name = 'Super-MCP Server';

  if (!settings.mcpConfigFile) {
    return {
      id,
      name,
      status: 'skip',
      message: 'Skipped - no MCP config',
    };
  }

  if (settings.diagnostics?.forceDirectMcp) {
    return {
      id,
      name,
      status: 'warn',
      message: 'Bypassed - Direct MCP mode forced in settings',
      remediation: 'Disable "Force direct MCP mode" in Settings → Advanced for better stability',
    };
  }

  const state = superMcpHttpManager.getState();

  if (!state.isRunning) {
    return {
      id,
      name,
      status: 'warn',
      message: 'Super-MCP is not running - tools are unavailable until the connection is restarted',
      remediation: 'Go to Settings → Advanced and choose "Restart Super-MCP".',
    };
  }

  // Live health probe — don't trust state.isRunning alone (may be stale after sleep/crash)
  const isHealthy = await superMcpHttpManager.checkHealth();
  if (!isHealthy) {
    return {
      id,
      name,
      status: 'warn',
      message: 'Super-MCP HTTP server state says running but health probe failed — may need restart',
      remediation: 'Go to Settings → Advanced and choose "Restart Super-MCP".',
    };
  }

  return {
    id,
    name,
    status: 'pass',
    message: `Running on port ${state.port}`,
    details: {
      port: state.port,
      url: state.url,
      uptime: state.startTime ? Date.now() - state.startTime : null,
      lastHealthCheck: state.lastHealthCheck,
    },
  };
}

/**
 * The 7 split MCP servers that replaced RebelInternal (Jan 2026).
 * At minimum, RebelInbox should be present as it's most commonly used.
 */
const SPLIT_INTERNAL_SERVERS = [
  'RebelInbox',
  'RebelMeetings',
  'RebelSearchAndConversations',
  'RebelAutomations',
  'RebelSpaces',
  'RebelSettings',
  'RebelMcpConnectors',
] as const;

export async function checkBundledServers(settings: AppSettings): Promise<CheckResult> {
  const id = 'bundledServers';
  const name = 'Bundled MCP Servers';

  const configPath = resolveMcpConfigPath(settings);
  if (!configPath) {
    return {
      id,
      name,
      status: 'skip',
      message: 'Skipped - no MCP config',
    };
  }

  try {
    const content = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(content);
    const servers = config.mcpServers || {};

    // Check for the 7 split internal servers
    const presentSplitServers = SPLIT_INTERNAL_SERVERS.filter(s => s in servers);
    const missingSplitServers = SPLIT_INTERNAL_SERVERS.filter(s => !(s in servers));
    const hasDiagnostics = 'RebelDiagnostics' in servers;

    // All 7 split servers + Diagnostics = pass
    if (missingSplitServers.length === 0 && hasDiagnostics) {
      return {
        id,
        name,
        status: 'pass',
        message: 'All bundled MCP servers configured (7 internal + Diagnostics)',
        details: { 
          splitServers: presentSplitServers, 
          ...defineSafeCheckDetails('bundledServers', {
            diagnostics: hasDiagnostics,
          }),
        },
      };
    }

    // At least RebelInbox present = soft pass with warning about missing
    if (presentSplitServers.includes('RebelInbox') && hasDiagnostics) {
      const _missing = missingSplitServers.length > 0 
        ? missingSplitServers.join(', ')
        : '';
      return {
        id,
        name,
        status: 'pass',
        message: `${presentSplitServers.length}/7 internal servers configured`,
        details: { 
          ...defineSafeCheckDetails('bundledServers', {
            present: safeClosedSetArray(BUNDLED_SERVER_NAMES, presentSplitServers, 'RebelInbox'),
            missing: safeClosedSetArray(BUNDLED_SERVER_NAMES, missingSplitServers, 'RebelInbox'),
            diagnostics: hasDiagnostics,
          }),
        },
      };
    }

    // Missing critical servers
    const missing: string[] = [];
    if (!presentSplitServers.includes('RebelInbox')) missing.push('RebelInbox');
    if (!hasDiagnostics) missing.push('RebelDiagnostics');
    if (missingSplitServers.length > 0) {
      missing.push(...missingSplitServers.filter(s => s !== 'RebelInbox'));
    }

    return {
      id,
      name,
      status: 'warn',
      message: `Missing: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` (+${missing.length - 3} more)` : ''}`,
      details: { 
        ...defineSafeCheckDetails('bundledServers', {
          present: safeClosedSetArray(BUNDLED_SERVER_NAMES, presentSplitServers, 'RebelInbox'),
          missing: safeClosedSetArray(BUNDLED_SERVER_NAMES, missingSplitServers, 'RebelInbox'),
          diagnostics: hasDiagnostics,
        }),
      },
      remediation: 'Restart the app to auto-add bundled servers',
    };
  } catch (error) {
    return {
      id,
      name,
      status: 'warn',
      message: 'Could not verify bundled servers',
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

/**
 * Check for MCP servers that were skipped during startup due to validation errors.
 * This helps diagnose "tools missing" issues when Super-MCP is running but some servers failed.
 */
export function checkMcpSkippedServers(): CheckResult {
  const id = 'mcpSkippedServers';
  const name = 'MCP Server Validation';

  const state = superMcpHttpManager.getState();

  if (!state.isRunning) {
    return {
      id,
      name,
      status: 'skip',
      message: 'Skipped - Super-MCP not running',
    };
  }

  const skippedServers = superMcpHttpManager.getSkippedServers();

  if (skippedServers.length === 0) {
    return {
      id,
      name,
      status: 'pass',
      message: 'All configured MCP servers loaded successfully',
    };
  }

  const serverList = skippedServers.map(s => `${s.id}: ${s.reason}`).join('; ');

  return {
    id,
    name,
    status: 'warn',
    message: `${skippedServers.length} server(s) skipped due to validation errors`,
    details: {
      ...defineSafeCheckDetails('mcpSkippedServers', {
        skippedCount: skippedServers.length,
      }),
      servers: skippedServers,
    },
    remediation: `Fix configuration for: ${serverList}. Check Settings → Connectors for details.`,
  };
}
