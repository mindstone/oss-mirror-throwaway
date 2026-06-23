/**
 * Tool Index Health Checks
 *
 * Checks for semantic tool search index health.
 */

import type { CheckResult } from '../types';
import { getToolIndexStatus } from '../../toolIndexService';
import {
  defineSafeCheckDetails,
  safeKeyedCounts,
  scrubbedTelemetryText,
} from '@core/services/health/safeCheckDetails';

function safeLastRefreshAt(value: number | string | null): number | ReturnType<typeof scrubbedTelemetryText> | null {
  if (typeof value === 'string') return scrubbedTelemetryText(value);
  return value;
}

/**
 * Check tool index health.
 * Reports if index is initialized and has tools indexed.
 */
export function checkToolIndexHealth(): CheckResult {
  const status = getToolIndexStatus();

  if (status.isStale) {
    return {
      id: 'toolIndexHealth',
      name: 'Tool Index',
      status: 'warn',
      message: 'Tool index refresh is pending after connector/config changes',
      details: {
        ...defineSafeCheckDetails('toolIndexHealth', {
          isInitialized: status.isInitialized,
          toolCount: status.toolCount,
          byServer: status.byServer === undefined ? undefined : safeKeyedCounts(status.byServer),
        }),
        staleReason: status.staleReason,
        staleSince: status.staleSince ? new Date(status.staleSince).toISOString() : null,
        staleGeneration: status.staleGeneration ?? null,
        lastRefreshError: status.lastRefreshError ?? null,
      },
      remediation: 'Wait for connector refresh to complete, then retry. If this persists, restart the app.',
    };
  }

  if (!status.isInitialized) {
    return {
      id: 'toolIndexHealth',
      name: 'Tool Index',
      status: 'warn',
      message: 'Tool index not yet initialized',
      remediation: 'Tool index initializes after Super-MCP starts. Try restarting the app.',
    };
  }

  if (status.toolCount === 0) {
    return {
      id: 'toolIndexHealth',
      name: 'Tool Index',
      status: 'warn',
      message: 'Tool index is empty (no tools indexed)',
      details: {
        ...defineSafeCheckDetails('toolIndexHealth', {
          isInitialized: status.isInitialized,
          lastRefreshAt: safeLastRefreshAt(status.lastRefreshAt),
          byServer: status.byServer === undefined ? undefined : safeKeyedCounts(status.byServer),
        }),
      },
      remediation: 'Check that MCP servers are configured and Super-MCP is running.',
    };
  }

  // Check for stale index (> 24 hours without refresh)
  const staleThresholdMs = 24 * 60 * 60 * 1000;
  const isStale = status.lastRefreshAt && Date.now() - status.lastRefreshAt > staleThresholdMs;

  if (isStale) {
    return {
      id: 'toolIndexHealth',
      name: 'Tool Index',
      status: 'warn',
      message: `Tool index is stale (${status.toolCount} tools, last refresh > 24h ago)`,
      details: {
        ...defineSafeCheckDetails('toolIndexHealth', {
          toolCount: status.toolCount,
          lastRefreshAt: safeLastRefreshAt(status.lastRefreshAt ? new Date(status.lastRefreshAt).toISOString() : null),
          byServer: status.byServer === undefined ? undefined : safeKeyedCounts(status.byServer),
        }),
      },
      remediation: 'Restart the app to refresh the tool index.',
    };
  }

  return {
    id: 'toolIndexHealth',
    name: 'Tool Index',
    status: 'pass',
    message: `${status.toolCount} tools indexed`,
    details: {
      ...defineSafeCheckDetails('toolIndexHealth', {
        toolCount: status.toolCount,
        lastRefreshAt: safeLastRefreshAt(status.lastRefreshAt ? new Date(status.lastRefreshAt).toISOString() : null),
        byServer: status.byServer === undefined ? undefined : safeKeyedCounts(status.byServer),
      }),
    },
  };
}
