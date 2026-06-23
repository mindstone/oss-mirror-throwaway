/**
 * MCP Runtime Health Check
 *
 * Reports on the Super-MCP MANAGER's health (the Rebel-side router/manager
 * process that fronts all MCP servers). When the manager has hit
 * `consecutiveStartupFailures >= 3`, this check warns so the HelpMenu glow
 * lights and a calmly-worded toast offers a deep-link to Settings → Tools.
 *
 * SCOPE NOTE: This is MANAGER-level health — not per-server. The
 * `mcp_transition.serverIdHash` field is documented but not yet populated by
 * the manager (see plan doc section "MCP runtime scope"). Per-server emit
 * work is a documented follow-on plan.
 *
 * Recovery: the manager resets `consecutiveStartupFailures` on successful
 * start; check returns to `pass` at the next poll once recovery happens.
 */

import { createScopedLogger } from '@core/logger';
import type { CheckResult } from '../types';
import { superMcpHttpManager } from '../../superMcpHttpManager';
import { defineSafeCheckDetails } from '@core/services/health/safeCheckDetails';

const log = createScopedLogger({ service: 'mcpRuntimeHealth' });

const FAILURE_THRESHOLD = 3;

// Module-scoped transition memo for log-on-engagement / log-on-clear (not per poll).
let lastReportedState: 'pass' | 'warn' = 'pass';

export function checkMcpRuntimeHealth(): CheckResult {
  let consecutiveFailures = 0;

  try {
    if (!superMcpHttpManager) {
      return {
        id: 'mcpRuntimeHealth',
        name: 'Tool Server',
        status: 'skip',
        message: 'Super-MCP manager not initialized',
      };
    }

    const snapshot = superMcpHttpManager.getStartupHealthSnapshot();
    consecutiveFailures = snapshot.consecutiveFailures ?? 0;
  } catch (error) {
    log.warn({ err: error }, 'Failed to read Super-MCP manager state');
    return {
      id: 'mcpRuntimeHealth',
      name: 'Tool Server',
      status: 'skip',
      message: 'Tool server status unknown',
    };
  }

  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    if (lastReportedState === 'pass') {
      log.info({ consecutiveFailures }, 'mcpRuntimeHealth threshold engaged');
      lastReportedState = 'warn';
    }

    return {
      id: 'mcpRuntimeHealth',
      name: 'Tool Server',
      status: 'warn',
      message: 'Tool server is having trouble starting',
      remediation: 'One of your tools keeps failing to start. Open Settings to check it.',
      details: defineSafeCheckDetails('mcpRuntimeHealth', { consecutiveFailures }),
    };
  }

  if (lastReportedState === 'warn') {
    log.info({ consecutiveFailures }, 'mcpRuntimeHealth threshold cleared');
    lastReportedState = 'pass';
  }

  return {
    id: 'mcpRuntimeHealth',
    name: 'Tool Server',
    status: 'pass',
    message: 'Tool server is healthy',
  };
}
