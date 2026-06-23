/**
 * System Health IPC Handlers
 *
 * Handles system:* IPC channels for health checks and diagnostics.
 */

import { shell, type IpcMainInvokeEvent } from 'electron';
import type { AppSettings } from '@shared/types';
import type { AgentSessionSummary } from '@shared/ipc/schemas/sessions';
import { runSystemHealthCheck, generateShareableReport, runPreflightCheck } from '../services/systemHealthService';
import { generateDiagnosticBundle, generateDiagnosticZipBundle, generateMinimalDiagnosticZipBundle, type DiagnosticSessionContext } from '../services/logExportService';
import { runSafeModeDiagnostics } from '../services/safeModeStoreDiagnostics';
import { probeWorkspaceAccess } from '../services/health/checks/filesystem';
import {
  getAvailablePresets,
  startTracing,
  startPresetTrace,
  stopTracing,
  isTracingActive,
  openTraceInChrome,
  type TracePresetName,
  type TracingOptions,
} from '../services/performanceTracingService';
import { generatePerfSummary } from '../services/perfSummaryService';
import type { HeapSnapshotCaptureRequest, ValidateWorkspaceAccessRequest } from '@shared/ipc/channels/health';
import { createScopedLogger } from '@core/logger';
import { registerHandler } from './utils/registerHandler';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

const log = createScopedLogger({ service: 'systemHandlers' });
const TRACE_PRESET_NAMES = new Set<string>(getAvailablePresets());

function isTracePreset(value: string): value is TracePresetName {
  return TRACE_PRESET_NAMES.has(value);
}

export interface SystemHandlerDeps {
  getSettings: () => AppSettings;
  listSessionSummaries?: () => AgentSessionSummary[];
}

/**
 * Build session context for diagnostics from recent session summaries.
 * Extracts recent session IDs for log correlation.
 * Uses in-memory session index (zero I/O) instead of loading full sessions.
 */
function buildSessionContext(listSessionSummaries?: () => AgentSessionSummary[]): DiagnosticSessionContext | undefined {
  if (!listSessionSummaries) {
    return undefined;
  }
  try {
    const summaries = listSessionSummaries();
    // Sort by updatedAt desc and take top 5
    const recentSessions = summaries
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 5)
      .map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
      }));
    return { recentSessions };
  } catch (error) {
    log.warn({ err: error }, 'Failed to build session context for diagnostics');
    ignoreBestEffortCleanup(error, {
      operation: 'systemHandlers.buildSessionContext',
      reason: 'Diagnostics export can continue without optional recent-session context.',
    });
    return undefined;
  }
}

export function registerSystemHandlers(deps: SystemHandlerDeps): void {
  const { getSettings } = deps;

  // Validate workspace access - lightweight check for onboarding/runtime recovery.
  // Retry is enabled to absorb transient cloud-sync interference and the libuv
  // thread-pool saturation that happens during heavy startup (workspace manifest
  // load, watcher subscription, MCP spawning). Without retry a single delayed
  // fs.stat surfaces as "Library folder not accessible / Path is unreachable",
  // which is misleading when the folder is healthy.
  registerHandler(
    'system:validate-workspace-access',
    async (_event: IpcMainInvokeEvent, request: ValidateWorkspaceAccessRequest) => {
      log.info({ path: request.path, createIfMissing: request.createIfMissing }, 'Validating workspace access');
      try {
        const result = await probeWorkspaceAccess(request.path, {
          createIfMissing: request.createIfMissing,
          retry: { enabled: true },
        });
        return result;
      } catch (error) {
        log.error({ err: error, path: request.path }, 'Workspace access validation failed');
        return {
          accessible: false,
          code: 'HANDLER_ERROR',
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  );

  // Pre-flight check for onboarding
  registerHandler('system:preflight-check', async (_event: IpcMainInvokeEvent) => {
    log.info('Running pre-flight check');
    try {
      const result = await runPreflightCheck();
      return result;
    } catch (error) {
      log.error({ err: error }, 'Pre-flight check failed');
      throw error;
    }
  });

  // Helper to open a path in the system file explorer
  registerHandler('system:preflight-open-path', async (_event: IpcMainInvokeEvent, folderPath: string) => {
    log.info({ folderPath }, 'Opening folder in explorer');
    try {
      await shell.openPath(folderPath);
      return { success: true };
    } catch (error) {
      log.error({ err: error, folderPath }, 'Failed to open folder');
      return { success: false, error: (error as Error).message };
    }
  });

  registerHandler(
    'system:health-check',
    async (_event: IpcMainInvokeEvent, options?: { tier?: 'quick' | 'full' }) => {
      log.info({ tier: options?.tier ?? 'full' }, 'Running system health check');
      try {
        const settings = getSettings();
        const report = await runSystemHealthCheck(settings, options);
        return report;
      } catch (error) {
        log.error({ err: error }, 'System health check failed');
        throw error;
      }
    }
  );

  registerHandler('system:health-export', async (_event: IpcMainInvokeEvent) => {
    log.info('Generating shareable health report');
    try {
      const settings = getSettings();
      const report = await runSystemHealthCheck(settings, { tier: 'full' });
      const markdown = generateShareableReport(report);
      return { markdown };
    } catch (error) {
      log.error({ err: error }, 'Failed to generate health report');
      throw error;
    }
  });

  registerHandler(
    'system:health-export-with-logs',
    async (_event: IpcMainInvokeEvent, options?: { logWindowMinutes?: number }) => {
      log.info({ logWindowMinutes: options?.logWindowMinutes ?? 15 }, 'Generating diagnostic bundle with logs');
      try {
        const settings = getSettings();
        const sessionContext = buildSessionContext(deps.listSessionSummaries);
        const result = await generateDiagnosticBundle(
          settings,
          { logWindowMinutes: options?.logWindowMinutes ?? 15 },
          sessionContext
        );
        return result;
      } catch (error) {
        log.error({ err: error }, 'Failed to generate diagnostic bundle');
        throw error;
      }
    }
  );

  registerHandler(
    'system:health-export-zip',
    async (_event: IpcMainInvokeEvent, options?: { logWindowMinutes?: number }) => {
      log.info({ logWindowMinutes: options?.logWindowMinutes ?? 15 }, 'Generating diagnostic ZIP bundle');
      const toArrayBuffer = (buffer: Buffer): ArrayBuffer =>
        buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
      try {
        const settings = getSettings();
        const result = await generateDiagnosticZipBundle(settings, {
          logWindowMinutes: options?.logWindowMinutes ?? 15,
        });
        return {
          success: true,
          data: toArrayBuffer(result.buffer),
          filename: result.filename,
          ...(result.partial ? { partial: true } : {}),
          ...(result.unavailableSections && result.unavailableSections.length > 0
            ? { unavailableSections: result.unavailableSections }
            : {}),
        };
      } catch (error) {
        // The full bundle is already deadline-bounded (it cannot hang), so this
        // catch is for an unexpected throw. Fall back to the minimal
        // always-succeeds bundle so the user still gets *something* out rather
        // than a bare failure toast.
        log.error({ err: error }, 'Full diagnostic ZIP bundle failed; attempting minimal fallback');
        try {
          const minimal = await generateMinimalDiagnosticZipBundle();
          return {
            success: true,
            data: toArrayBuffer(minimal.buffer),
            filename: minimal.filename,
            partial: true,
          };
        } catch (fallbackError) {
          log.error({ err: fallbackError }, 'Minimal diagnostic ZIP fallback also failed');
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          };
        }
      }
    }
  );

  // Safe Mode diagnostic check - works even when MCP is disabled
  // This is a read-only check of electron-store files
  registerHandler('system:safe-mode-diagnostics', async (_event: IpcMainInvokeEvent) => {
    log.info('Running Safe Mode diagnostics');
    try {
      const result = await runSafeModeDiagnostics();
      return result;
    } catch (error) {
      log.error({ err: error }, 'Safe Mode diagnostics failed');
      // Return a failed result rather than throwing - diagnostics should never crash
      return {
        status: 'check_failed' as const,
        timestamp: new Date().toISOString(),
        userDataPath: '',
        checks: {
          settingsStore: { exists: false, readable: false, validJson: false, sizeBytes: 0, error: 'Check failed' },
          sessionIndex: { exists: false, readable: false, validJson: false, sizeBytes: 0, error: 'Check failed' },
          inboxStore: { exists: false, readable: false, validJson: false, sizeBytes: 0, error: 'Check failed' },
          mcpRouterConfig: { exists: false, readable: false, validJson: false, sizeBytes: 0, error: 'Check failed' },
          logsAccessible: false,
        },
        issues: [{
          severity: 'error' as const,
          code: 'HANDLER_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        }],
        suggestedActions: ['Try exporting a diagnostic bundle for support'],
        recentLogErrors: [],
      };
    }
  });

  // Performance tracing handlers
  registerHandler('system:perf-tracing-start', async (_event: IpcMainInvokeEvent, options?: TracingOptions & { preset?: string }) => {
    log.info({ options }, 'Starting performance tracing');

    const preset = options?.preset;
    if (preset && isTracePreset(preset)) {
      if (process.env.REBEL_PERF_MODE !== '1') {
        log.warn({ preset }, 'Trace presets require REBEL_PERF_MODE=1');
        throw new Error('Trace presets require dev performance mode (REBEL_PERF_MODE=1).');
      }
      const success = await startPresetTrace(preset, options?.durationMs);
      return { success, isActive: isTracingActive() };
    }

    const startOptions: TracingOptions | undefined = options
      ? {
        categories: options.categories,
        durationMs: options.durationMs,
        preset: options.preset === 'full' || options.preset === 'lightweight' ? options.preset : undefined,
      }
      : undefined;

    const success = await startTracing(startOptions);
    return { success, isActive: isTracingActive() };
  });

  registerHandler('system:perf-tracing-stop', async (_event: IpcMainInvokeEvent) => {
    log.info('Stopping performance tracing');
    const tracePath = await stopTracing();
    if (tracePath) {
      try {
        await openTraceInChrome(tracePath);
      } catch (err) {
        log.warn({ error: err }, 'Failed to open trace location');
      }
    }
    return { success: !!tracePath, tracePath };
  });

  registerHandler('system:perf-tracing-status', async (_event: IpcMainInvokeEvent) => {
    return { isActive: isTracingActive() };
  });

  registerHandler('system:perf-renderer-profile', async (_event: IpcMainInvokeEvent, options?: { durationMs?: number }) => {
    if (process.env.REBEL_PERF_MODE !== '1') {
      return { status: 'failed' as const, error: 'Renderer profiling requires REBEL_PERF_MODE=1' };
    }
    const { captureRendererProfile } = await import('../services/rendererProfilerService');
    return captureRendererProfile(options?.durationMs);
  });

  registerHandler('system:heap-snapshot-capture', async (
    _event: IpcMainInvokeEvent,
    request: HeapSnapshotCaptureRequest,
  ) => {
    if (process.env.REBEL_PERF_MODE !== '1') {
      log.warn(
        { trigger: request.trigger, label: request.label },
        'Renderer heap snapshot requested outside REBEL_PERF_MODE',
      );
      return {
        status: 'failed' as const,
        error: 'Renderer heap snapshots require REBEL_PERF_MODE=1.',
      };
    }
    const { captureRendererHeapSnapshot } = await import('../services/rendererHeapSnapshotService');
    return captureRendererHeapSnapshot(request);
  });

  registerHandler('system:perf-summary', async (_event: IpcMainInvokeEvent) => {
    if (process.env.REBEL_PERF_MODE !== '1') {
      log.warn({ profilerChannel: 'perf-summary' }, 'Perf summary requested outside REBEL_PERF_MODE');
      return {
        success: false,
        summaryPath: null,
        error: 'Perf summary requires dev performance mode (REBEL_PERF_MODE=1).',
      };
    }

    const summaryPath = await generatePerfSummary();
    if (!summaryPath) {
      return {
        success: false,
        summaryPath: null,
        error: 'Failed to generate performance summary.',
      };
    }

    return {
      success: true,
      summaryPath,
    };
  });

  log.debug('System health handlers registered');
}
