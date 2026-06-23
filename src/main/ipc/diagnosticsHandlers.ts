import type { HandlerInvokeEvent } from '@core/handlerRegistry';
import { registerHandler } from './utils/registerHandler';
import { diagnosticsChannels } from '@shared/ipc/channels/diagnostics';
import { createScopedLogger } from '@core/logger';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
import { getRecentDiagnosticContext } from '@core/services/diagnostics/recentDiagnosticContext';
import {
  getProviderReachabilitySnapshot,
  refreshProviderReachabilityCache,
} from '@core/services/diagnostics/providerReachabilitySnapshot';

const log = createScopedLogger({ service: 'diagnosticsHandlers' });

const EMPTY_LIMIT = 5;
const EMPTY_WINDOW_HOURS = 24;

function emptyShape(windowHours = EMPTY_WINDOW_HOURS, limit = EMPTY_LIMIT) {
  return {
    windowHours,
    limit,
    nowMs: Date.now(),
    counts: null,
    lastTimes: null,
    entriesByKind: {},
    totalEvents: 0,
    readerAvailable: false,
  } as const;
}

export function registerDiagnosticsHandlers(): void {
  const channelDef = diagnosticsChannels['diagnostics:get-recent-context'];

  registerHandler(channelDef.channel, async (_event: HandlerInvokeEvent, request: unknown) => {
    const parseResult = channelDef.request.safeParse(request ?? undefined);
    if (!parseResult.success) {
      log.warn(
        { err: parseResult.error },
        'diagnostics:get-recent-context: malformed request; returning empty shape per never-throws contract',
      );
      captureKnownCondition(
        'bridge_recent_events_failure',
        { phase: 'ipc_request_parse' },
        parseResult.error,
      );
      return emptyShape();
    }
    const parsed = parseResult.data;
    try {
      return await getRecentDiagnosticContext(parsed);
    } catch (err) {
      log.warn(
        { err },
        'diagnostics:get-recent-context: helper threw despite never-throws contract; returning empty shape',
      );
      captureKnownCondition(
        'bridge_recent_events_failure',
        { phase: 'ipc_handler_catch' },
        err instanceof Error ? err : new Error(String(err)),
      );
      return emptyShape(parsed.windowHours ?? EMPTY_WINDOW_HOURS, parsed.limit ?? EMPTY_LIMIT);
    }
  });

  const providerSnapshotChannel = diagnosticsChannels['diagnostics:get-provider-reachability-snapshot'];

  registerHandler(providerSnapshotChannel.channel, async () => {
    try {
      return getProviderReachabilitySnapshot();
    } catch (err) {
      log.warn({ err }, 'diagnostics:get-provider-reachability-snapshot failed');
      throw err;
    }
  });

  const refreshProviderSnapshotChannel = diagnosticsChannels['diagnostics:refresh-provider-reachability-cache'];

  registerHandler(refreshProviderSnapshotChannel.channel, async () => {
    try {
      return await refreshProviderReachabilityCache();
    } catch (err) {
      log.warn({ err }, 'diagnostics:refresh-provider-reachability-cache failed');
      throw err;
    }
  });
}
