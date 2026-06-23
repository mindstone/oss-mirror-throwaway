import type { ErrorReporter } from '@core/errorReporter';
import { getErrorReporter } from '@core/errorReporter';
import { createScopedLogger } from '@core/logger';
import {
  HOST_TOOL_REASON_VALUES,
  type HostToolReason,
} from '@core/appBridge/installer/hostToolContracts';

export const INSTALL_FUNNEL_ACTIONS = [
  'detect-browsers',
  'extract-extension',
  'reveal-extension',
  'open-extensions-page',
] as const;

export type InstallFunnelAction = (typeof INSTALL_FUNNEL_ACTIONS)[number];

export interface InstallFunnelTags {
  browserId?: string;
  pairSessionId?: string;
  extensionIdSuffix?: string;
}

export interface InstallFunnelOutcome {
  reason?: string;
}

export interface RecentInstallBreadcrumbsQuery {
  browserId?: string;
  pairSessionId?: string;
  sinceMs: number;
}

export interface RecentInstallBreadcrumbsResult {
  count: number;
  failureCount: number;
  lastFailureReason: HostToolReason | null;
}

interface InstallFunnelStatsDeps {
  errorReporter?: ErrorReporter;
  logger?: Pick<ReturnType<typeof createScopedLogger>, 'info' | 'warn'>;
  now?: () => number;
  retentionMs?: number;
  maxBreadcrumbs?: number;
  diagnoseCooldownMs?: number;
}

interface InstallFunnelBreadcrumbEntry {
  message: string;
  browserId?: string;
  pairSessionId?: string;
  extensionIdSuffix?: string;
  reason?: HostToolReason;
  timestamp: number;
}

const RECENT_BREADCRUMB_RETENTION_MS = 5 * 60 * 1000;
const MAX_RECENT_BREADCRUMBS = 100;
const DIAGNOSE_COOLDOWN_MS = 10_000;
const HOST_TOOL_REASON_SET = new Set<string>(HOST_TOOL_REASON_VALUES);

export function createInstallFunnelStats(deps: InstallFunnelStatsDeps = {}) {
  const logger = deps.logger ?? createScopedLogger({ service: 'installFunnelStats' });
  const now = deps.now ?? Date.now;
  const retentionMs = deps.retentionMs ?? RECENT_BREADCRUMB_RETENTION_MS;
  const maxBreadcrumbs = deps.maxBreadcrumbs ?? MAX_RECENT_BREADCRUMBS;
  const diagnoseCooldownMs = deps.diagnoseCooldownMs ?? DIAGNOSE_COOLDOWN_MS;
  const recentBreadcrumbs: InstallFunnelBreadcrumbEntry[] = [];
  const diagnoseCooldowns = new Map<string, number>();

  function normalizeReason(reason?: string): HostToolReason | null {
    if (!reason) {
      return null;
    }
    if (HOST_TOOL_REASON_SET.has(reason)) {
      return reason as HostToolReason;
    }
    return reason === 'ok' ? 'ok' : 'internal-error';
  }

  function pruneRecentBreadcrumbs(currentTime = now()): void {
    const cutoff = currentTime - retentionMs;
    while (recentBreadcrumbs.length > 0 && recentBreadcrumbs[0].timestamp < cutoff) {
      recentBreadcrumbs.shift();
    }
    while (recentBreadcrumbs.length > maxBreadcrumbs) {
      recentBreadcrumbs.shift();
    }
  }

  function rememberBreadcrumb(
    message: string,
    tags: InstallFunnelTags,
    outcome?: InstallFunnelOutcome,
  ): void {
    const reason = normalizeReason(outcome?.reason);
    recentBreadcrumbs.push({
      message,
      browserId: tags.browserId,
      pairSessionId: tags.pairSessionId,
      extensionIdSuffix: tags.extensionIdSuffix,
      ...(reason ? { reason } : {}),
      timestamp: now(),
    });
    pruneRecentBreadcrumbs();
  }

  function emitMessage(
    message: string,
    tags: InstallFunnelTags,
    outcome?: InstallFunnelOutcome,
  ): void {
    rememberBreadcrumb(message, tags, outcome);

    const data = {
      browserId: tags.browserId,
      pairSessionId: tags.pairSessionId,
      extensionIdSuffix: tags.extensionIdSuffix,
      ...(outcome?.reason ? { reason: outcome.reason } : {}),
    };

    try {
      const errorReporter = deps.errorReporter ?? getErrorReporter();
      errorReporter.addBreadcrumb({
        category: 'app-bridge.install',
        level: 'info',
        message,
        data,
      });
      logger.info({ event: message, ...data }, 'App Bridge install funnel breadcrumb');
    } catch (error) {
      try {
        logger.warn(
          {
            event: message,
            error: error instanceof Error ? error.message : String(error),
          },
          'App Bridge install funnel telemetry failed',
        );
      } catch {
        // Telemetry must never break the install flow.
      }
    }
  }

  function emit(
    action: InstallFunnelAction,
    phase: 'start' | 'end',
    tags: InstallFunnelTags,
    outcome?: InstallFunnelOutcome,
  ): void {
    emitMessage(`install.${action}.${phase}`, tags, outcome);
  }

  return {
    start(action: InstallFunnelAction, tags: InstallFunnelTags): void {
      emit(action, 'start', tags);
    },
    end(
      action: InstallFunnelAction,
      tags: InstallFunnelTags,
      outcome?: InstallFunnelOutcome,
    ): void {
      emit(action, 'end', tags, outcome);
    },
    trustPersistFailed(tags: InstallFunnelTags, outcome?: InstallFunnelOutcome): void {
      emitMessage('install.trust-persist-failed', tags, outcome);
    },
    getRecentBreadcrumbs(query: RecentInstallBreadcrumbsQuery): RecentInstallBreadcrumbsResult {
      const currentTime = now();
      pruneRecentBreadcrumbs(currentTime);
      const cutoff = currentTime - query.sinceMs;
      const matches = recentBreadcrumbs.filter((entry) => {
        if (entry.timestamp < cutoff) {
          return false;
        }
        if (query.browserId && entry.browserId !== query.browserId) {
          return false;
        }
        if (query.pairSessionId && entry.pairSessionId !== query.pairSessionId) {
          return false;
        }
        return true;
      });

      const failures = matches.filter((entry) => entry.reason && entry.reason !== 'ok');

      return {
        count: matches.length,
        failureCount: failures.length,
        lastFailureReason: failures.at(-1)?.reason ?? null,
      };
    },
    consumeDiagnoseCooldown(key: string): { allowed: boolean; remainingMs: number } {
      const currentTime = now();
      const lastCallAt = diagnoseCooldowns.get(key);
      if (typeof lastCallAt === 'number') {
        const elapsedMs = currentTime - lastCallAt;
        if (elapsedMs < diagnoseCooldownMs) {
          return {
            allowed: false,
            remainingMs: diagnoseCooldownMs - elapsedMs,
          };
        }
      }

      diagnoseCooldowns.set(key, currentTime);
      return {
        allowed: true,
        remainingMs: 0,
      };
    },
    resetForTesting(): void {
      recentBreadcrumbs.length = 0;
      diagnoseCooldowns.clear();
    },
  };
}

export const installFunnelStats = createInstallFunnelStats();
