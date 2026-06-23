import { getErrorReporter, type ErrorReporter } from '@core/errorReporter';
import { createScopedLogger } from '@core/logger';
import { getScheduler, type Scheduler, type SchedulerTimerHandle } from '@core/scheduler';
import type { ToolCatalogResponse } from '@core/services/toolIndex/toolIndexService';

const DEFAULT_IDLE_TRIGGER_MS = 60_000;
const DEFAULT_WATCHDOG_DELAY_MS = 65_000;
const FAILED_RETRY_DELAY_MS = 30_000;
const MAX_FAILED_ATTEMPTS = 3;
const MAX_RECENT_TRAFFIC_EVENTS = 10;

type WarmupTrigger = 'first-request' | 'idle-timer';
type WarmupState = 'not_scheduled' | 'scheduled' | 'running' | 'succeeded' | 'failed';

type ToolIndexRefreshResult = {
  success: boolean;
  added: number;
  updated: number;
  removed: number;
  total: number;
};

type ToolIndexServiceModule = {
  initializeToolIndex: () => Promise<void>;
  refreshToolIndex: () => Promise<ToolIndexRefreshResult>;
  refreshToolIndexFromCatalogData?: (
    catalogData: ToolCatalogResponse,
    options?: {
      packageHashes?: ReadonlyMap<string, string>;
      configHash?: string;
      securityHash?: string;
      updateAliasesFromCatalog?: boolean;
      etag?: string;
    },
  ) => Promise<ToolIndexRefreshResult>;
};

type WarmupScheduler = Pick<Scheduler, 'registerTimeout' | 'clear' | 'now'>;

type WarmupLogger = Pick<ReturnType<typeof createScopedLogger>, 'info' | 'warn' | 'error'>;

type WarmupTelemetryEvent =
  | 'cloud.bootstrap.completed'
  | 'cloud.warmup.tool_index.scheduled'
  | 'cloud.warmup.tool_index.running'
  | 'cloud.warmup.tool_index.succeeded'
  | 'cloud.warmup.tool_index.failed'
  | 'cloud.warmup.tool_index.skipped'
  | 'cloud.warmup.watchdog.late';

type WarmupTelemetryLevel = 'info' | 'warning' | 'error';

type WarmupTrafficEvent = {
  method: string;
  path: string;
  observedAt: number;
  isHealthRoute: boolean;
};

type TrafficSnapshot = {
  count: number;
  lastPath: string | null;
  lastMethod: string | null;
  lastObservedAt: number | null;
  sample: Array<{ method: string; path: string; observedAt: number }>;
};

type WarmupOutcome = {
  toolCount: number;
};

/**
 * Cloud warmup orchestration for deferred super-mcp/tool-index startup.
 *
 * Env controls:
 * - `REBEL_CLOUD_WARMUP_EAGER=1`: run warmup immediately after bootstrap scheduling.
 * - `REBEL_SUPPRESS_WARMUP_WATCHDOG=1`: suppress watchdog Sentry capture (breadcrumb/log still emitted).
 */
export type CloudBootstrapWarmupDeps = {
  scheduler?: WarmupScheduler;
  logger?: WarmupLogger;
  errorReporter?: ErrorReporter;
  fetchImpl?: typeof fetch;
  loadToolIndexService?: () => Promise<ToolIndexServiceModule>;
  isEagerOverrideEnabled?: () => boolean;
};

class CloudBootstrapWarmupService {
  private readonly scheduler: WarmupScheduler;
  private readonly log: WarmupLogger;
  private readonly errorReporter: ErrorReporter;
  private readonly fetchImpl: typeof fetch;
  private readonly loadToolIndexService: () => Promise<ToolIndexServiceModule>;
  private readonly isEagerOverrideEnabled: () => boolean;

  private state: WarmupState = 'not_scheduled';
  private superMcpUrl: string | null = null;
  private idleTriggerMs = DEFAULT_IDLE_TRIGGER_MS;
  private watchdogDelayMs = DEFAULT_WATCHDOG_DELAY_MS;
  private bootstrapCompletedAt: number | null = null;
  private recentTraffic: WarmupTrafficEvent[] = [];
  private idleTimer: SchedulerTimerHandle | null = null;
  private watchdogTimer: SchedulerTimerHandle | null = null;
  private warmupPromise: Promise<void> | null = null;
  private firstWarmupTrigger: WarmupTrigger | null = null;
  private firstNonHealthRequestSeen = false;
  private failedAttempts = 0;
  private lastFailedAt: number | null = null;
  private terminalFailureReported = false;
  private stateChangedAt: number | null = null;
  // Super-MCP-unavailable is an EXPECTED upstream condition (its genuine
  // startup failure is captured once at the bootstrap layer). The ensureWarm
  // guard can be hit on every request, so we report the skip at most once per
  // process and short-circuit subsequent hits to avoid telemetry/log spam.
  private superMcpUnavailableReported = false;

  constructor(deps: CloudBootstrapWarmupDeps = {}) {
    this.scheduler = deps.scheduler ?? this.resolveScheduler();
    this.log = deps.logger ?? createScopedLogger({ service: 'cloud-bootstrap-warmup' });
    this.errorReporter = deps.errorReporter ?? getErrorReporter();
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.loadToolIndexService = deps.loadToolIndexService ?? (async () => (
      await import('@core/services/toolIndex/toolIndexService')
    ));
    this.isEagerOverrideEnabled = deps.isEagerOverrideEnabled
      ?? (() => process.env.REBEL_CLOUD_WARMUP_EAGER === '1');
    this.stateChangedAt = this.scheduler.now();
  }

  private resolveScheduler(): WarmupScheduler {
    try {
      return getScheduler();
    } catch {
      return {
        registerTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
        clear: (timer) => clearTimeout(timer),
        now: () => Date.now(),
      };
    }
  }

  configure(options: {
    superMcpUrl?: string | null;
    idleTriggerMs?: number;
    watchdogDelayMs?: number;
  }): void {
    this.cleanupTimers();
    this.setState('not_scheduled');
    this.superMcpUrl = options.superMcpUrl ?? null;
    this.idleTriggerMs = Math.max(0, options.idleTriggerMs ?? DEFAULT_IDLE_TRIGGER_MS);
    this.watchdogDelayMs = Math.max(0, options.watchdogDelayMs ?? DEFAULT_WATCHDOG_DELAY_MS);
    this.bootstrapCompletedAt = null;
    this.recentTraffic = [];
    this.warmupPromise = null;
    this.firstWarmupTrigger = null;
    this.firstNonHealthRequestSeen = false;
    this.failedAttempts = 0;
    this.lastFailedAt = null;
    this.terminalFailureReported = false;
    this.superMcpUnavailableReported = false;
  }

  scheduleIdleTimerAndWatchdog(bootstrapDurationMs: number): void {
    this.bootstrapCompletedAt = this.scheduler.now();
    this.emitTelemetry('cloud.bootstrap.completed', {
      durationMs: Math.max(0, bootstrapDurationMs),
    }, 'info');

    if (this.isDisabledForTestProcess()) {
      this.log.info('Cloud bootstrap warmup disabled for test process');
      return;
    }

    if (!this.superMcpUrl) {
      this.markSkipped('scheduling');
      return;
    }

    if (this.isEagerOverrideEnabled()) {
      this.triggerWarmup('idle-timer');
      return;
    }

    this.idleTimer = this.scheduler.registerTimeout(() => {
      this.idleTimer = null;
      this.triggerWarmup('idle-timer');
    }, this.idleTriggerMs);
    this.unrefTimer(this.idleTimer);

    this.watchdogTimer = this.scheduler.registerTimeout(() => {
      this.watchdogTimer = null;
      this.runLateWatchdog();
    }, this.watchdogDelayMs);
    this.unrefTimer(this.watchdogTimer);
  }

  observeRequest(method: string, path: string, isHealthRoute: boolean): void {
    const observedAt = this.scheduler.now();
    this.recentTraffic.push({ method, path, isHealthRoute, observedAt });
    if (this.recentTraffic.length > MAX_RECENT_TRAFFIC_EVENTS) {
      this.recentTraffic.splice(0, this.recentTraffic.length - MAX_RECENT_TRAFFIC_EVENTS);
    }

    if (this.isDisabledForTestProcess()) {
      return;
    }

    if (isHealthRoute || this.firstNonHealthRequestSeen) {
      return;
    }
    this.firstNonHealthRequestSeen = true;
    this.triggerWarmup('first-request');
  }

  async ensureWarm(trigger: WarmupTrigger): Promise<void> {
    if (this.isDisabledForTestProcess()) {
      return;
    }

    if (this.state === 'succeeded') {
      return;
    }

    if (this.warmupPromise) {
      return this.warmupPromise;
    }

    const retryingAfterFailure = this.state === 'failed';
    if (retryingAfterFailure) {
      const retryDecision = this.canRetryFailedWarmup(this.scheduler.now());
      if (!retryDecision.allowed) {
        return;
      }
      this.setState('not_scheduled');
    }

    if (!this.superMcpUrl) {
      this.markSkipped('trigger', trigger);
      return;
    }

    if (this.state === 'not_scheduled') {
      this.setState('scheduled');
      this.firstWarmupTrigger = trigger;
      this.emitTelemetry(
        'cloud.warmup.tool_index.scheduled',
        {
          trigger,
          retryingAfterFailure,
          failedAttempts: this.failedAttempts,
        },
        'info',
      );
    }

    this.cleanupTimers();
    const startedAt = this.scheduler.now();

    this.warmupPromise = Promise.resolve()
      .then(async () => {
        this.setState('running');
        this.emitTelemetry('cloud.warmup.tool_index.running', { startedAt }, 'info');
        const outcome = await this.runWarmupSequence(this.superMcpUrl as string);
        const durationMs = Math.max(0, this.scheduler.now() - startedAt);
        this.setState('succeeded');
        this.failedAttempts = 0;
        this.lastFailedAt = null;
        this.terminalFailureReported = false;
        this.emitTelemetry('cloud.warmup.tool_index.succeeded', {
          durationMs,
          toolCount: outcome.toolCount,
        }, 'info');
      })
      .catch((error: unknown) => {
        const durationMs = Math.max(0, this.scheduler.now() - startedAt);
        this.markFailed(error, durationMs);
      })
      .finally(() => {
        this.warmupPromise = null;
      });

    return this.warmupPromise;
  }

  getState(): WarmupState {
    return this.state;
  }

  getHealthSnapshot(): {
    state: WarmupState;
    failedAttempts: number;
    stateChangedAtMs: number | null;
  } {
    return {
      state: this.state,
      failedAttempts: this.failedAttempts,
      stateChangedAtMs: this.stateChangedAt,
    };
  }

  cleanup(): void {
    this.cleanupTimers();
  }

  resetForTests(): void {
    this.configure({ superMcpUrl: null });
  }

  private triggerWarmup(trigger: WarmupTrigger): void {
    this.ensureWarm(trigger).catch((error) => {
      this.log.error({
        err: this.toErrorText(error),
        trigger,
      }, 'Cloud bootstrap warmup rejected unexpectedly');
    });
  }

  private cleanupTimers(): void {
    if (this.idleTimer) {
      this.scheduler.clear(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.watchdogTimer) {
      this.scheduler.clear(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private runLateWatchdog(): void {
    if (this.state !== 'not_scheduled') {
      return;
    }

    const secondsSinceBootstrap = this.bootstrapCompletedAt === null
      ? null
      : Math.max(0, Math.round((this.scheduler.now() - this.bootstrapCompletedAt) / 1000));
    const recentTraffic = this.buildTrafficSnapshot();
    const payload = {
      stateAtFire: this.state,
      secondsSinceBootstrap,
      reason: 'warmup-never-scheduled',
      recentTraffic,
    };

    const suppressionReason = this.getWatchdogSuppressionReason();
    if (suppressionReason) {
      this.emitTelemetry(
        'cloud.warmup.watchdog.late',
        {
          ...payload,
          sentrySuppressed: true,
          suppressionReason,
        },
        'warning',
      );
      return;
    }

    this.emitTelemetry('cloud.warmup.watchdog.late', payload, 'error');
    try {
      this.errorReporter.captureMessage('cloud.warmup.watchdog.late', {
        level: 'error',
        tags: { event: 'cloud.warmup.watchdog.late' },
        extra: payload,
      });
    } catch (captureError) {
      this.log.warn({ err: captureError }, 'Failed to report cloud warmup watchdog event');
    }
  }

  private buildTrafficSnapshot(): TrafficSnapshot {
    const last = this.recentTraffic[this.recentTraffic.length - 1];
    return {
      count: this.recentTraffic.length,
      lastPath: last?.path ?? null,
      lastMethod: last?.method ?? null,
      lastObservedAt: last?.observedAt ?? null,
      sample: this.recentTraffic.map((entry) => ({
        method: entry.method,
        path: entry.path,
        observedAt: entry.observedAt,
      })),
    };
  }

  /**
   * Non-exception downgrade for the EXPECTED "Super-MCP URL unavailable"
   * condition (REBEL-5ZR). The genuine Super-MCP startup failure is captured
   * once at the bootstrap layer with a distinct fingerprint, so here we only
   * emit a logged/breadcrumb skip — never a `captureException`. State is left
   * as `not_scheduled` (there is no `skipped` enum). The skip is reported at
   * most once per process; subsequent hits short-circuit quietly to avoid spam
   * on the ensureWarm path, which can fire on many requests.
   */
  private markSkipped(phase: 'scheduling' | 'trigger', trigger?: WarmupTrigger): void {
    if (this.superMcpUnavailableReported) {
      return;
    }
    this.superMcpUnavailableReported = true;
    this.emitTelemetry(
      'cloud.warmup.tool_index.skipped',
      {
        reason: 'super-mcp-unavailable',
        phase,
        ...(trigger ? { trigger } : {}),
        failedAttempts: this.failedAttempts,
        superMcpUrlPresent: false,
      },
      'warning',
    );
  }

  private markFailed(error: unknown, durationMs: number): void {
    const errorText = this.toErrorText(error);
    this.setState('failed');
    this.failedAttempts += 1;
    this.lastFailedAt = this.scheduler.now();
    this.emitTelemetry('cloud.warmup.tool_index.failed', {
      durationMs: Math.max(0, durationMs),
      error: errorText,
      failedAttempts: this.failedAttempts,
    }, 'error');

    try {
      this.errorReporter.captureException(error instanceof Error ? error : new Error(errorText), {
        level: 'error',
        tags: { event: 'cloud.warmup.tool_index.failed' },
        extra: {
          durationMs: Math.max(0, durationMs),
          trigger: this.firstWarmupTrigger ?? 'unknown',
          error: errorText,
        },
      });
    } catch (captureError) {
      this.log.warn({ err: captureError }, 'Failed to report cloud warmup failure');
    }

    if (this.failedAttempts >= MAX_FAILED_ATTEMPTS && !this.terminalFailureReported) {
      this.terminalFailureReported = true;
      try {
        this.errorReporter.captureMessage('cloud.warmup.tool_index.failed.terminal', {
          level: 'error',
          tags: { event: 'cloud.warmup.tool_index.failed.terminal' },
          extra: {
            failedAttempts: this.failedAttempts,
            trigger: this.firstWarmupTrigger ?? 'unknown',
            error: errorText,
          },
        });
      } catch (captureError) {
        this.log.warn({ err: captureError }, 'Failed to report terminal cloud warmup failure');
      }
    }
  }

  private canRetryFailedWarmup(now: number): { allowed: boolean } {
    if (this.failedAttempts >= MAX_FAILED_ATTEMPTS) {
      return { allowed: false };
    }
    if (this.lastFailedAt === null) {
      return { allowed: true };
    }
    return { allowed: now - this.lastFailedAt >= FAILED_RETRY_DELAY_MS };
  }

  private setState(state: WarmupState): void {
    this.state = state;
    this.stateChangedAt = this.scheduler.now();
  }

  private async runWarmupSequence(superMcpUrl: string): Promise<WarmupOutcome> {
    const warmupStart = this.scheduler.now();
    const toolsApiUrl = `${superMcpUrl.replace(/\/mcp$/, '')}/api/tools`;
    let warmupToolData: unknown | null = null;

    try {
      const response = await this.fetchImpl(toolsApiUrl);
      const warmupMs = Math.max(0, this.scheduler.now() - warmupStart);
      const warmupStatus = response.ok ? 'ok' : `http_${response.status}`;
      const warmupFields = {
        'tools.warmup.ms': warmupMs,
        'tools.warmup.status': warmupStatus,
      };

      if (response.ok) {
        try {
          warmupToolData = await response.json();
          console.log('[bootstrap] super-mcp tool warmup completed', warmupFields);
        } catch (error: unknown) {
          console.warn('[bootstrap] super-mcp tool warmup response parse failed (will rebuild on first search)', {
            err: this.toErrorText(error),
            ...warmupFields,
          });
        }
      } else {
        console.warn('[bootstrap] super-mcp tool warmup non-2xx (will rebuild on first search)', warmupFields);
      }
    } catch (error: unknown) {
      console.warn('[bootstrap] super-mcp tool warmup failed (will rebuild on first search)', {
        err: this.toErrorText(error),
        'tools.warmup.ms': Math.max(0, this.scheduler.now() - warmupStart),
        'tools.warmup.status': 'error',
      });
    }

    try {
      const {
        initializeToolIndex,
        refreshToolIndex,
        refreshToolIndexFromCatalogData,
      } = await this.loadToolIndexService();

      await initializeToolIndex();

      let result: ToolIndexRefreshResult;
      if (warmupToolData && typeof refreshToolIndexFromCatalogData === 'function') {
        const rawHashes = (warmupToolData as { package_hashes?: Record<string, string> }).package_hashes;
        const serverPackageHashes = rawHashes && Object.keys(rawHashes).length > 0
          ? new Map(Object.entries(rawHashes))
          : undefined;
        const warmupEtag = (warmupToolData as { etag?: unknown }).etag;

        result = await refreshToolIndexFromCatalogData(
          warmupToolData as ToolCatalogResponse,
          {
            packageHashes: serverPackageHashes,
            updateAliasesFromCatalog: true,
            etag: typeof warmupEtag === 'string' ? warmupEtag : undefined,
          },
        );
      } else {
        result = await refreshToolIndex();
      }

      if (!result.success) {
        console.warn('[bootstrap] Tool index refresh returned unsuccessful');
        throw new Error('Tool index refresh returned unsuccessful');
      }

      console.log('[bootstrap] Tool index refreshed', { added: result.added });
      return { toolCount: result.total };
    } catch (error) {
      console.warn('[bootstrap] Tool index init/refresh failed (BM25 fallback active):', error);
      throw error;
    }
  }

  private emitTelemetry(
    event: WarmupTelemetryEvent,
    data: Record<string, unknown>,
    level: WarmupTelemetryLevel,
  ): void {
    this.errorReporter.addBreadcrumb({
      category: 'cloud.warmup',
      message: event,
      level,
      data,
    });

    if (level === 'error') {
      this.log.error({ event, ...data }, event);
      return;
    }
    if (level === 'warning') {
      this.log.warn({ event, ...data }, event);
      return;
    }
    this.log.info({ event, ...data }, event);
  }

  private toErrorText(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  private getWatchdogSuppressionReason(): 'env' | 'node_env_test' | null {
    if (process.env.REBEL_SUPPRESS_WARMUP_WATCHDOG === '1') {
      return 'env';
    }
    if (process.env.NODE_ENV === 'test') {
      return 'node_env_test';
    }
    return null;
  }

  private isDisabledForTestProcess(): boolean {
    return process.env.REBEL_CLOUD_DISABLE_BOOTSTRAP_WARMUP === '1';
  }

  private unrefTimer(timer: SchedulerTimerHandle | null): void {
    if (!timer) return;
    const maybeUnref = timer as { unref?: () => void };
    if (typeof maybeUnref.unref === 'function') {
      maybeUnref.unref();
    }
  }
}

export const cloudBootstrapWarmup = new CloudBootstrapWarmupService();

export function createCloudBootstrapWarmupServiceForTests(
  deps: CloudBootstrapWarmupDeps,
): {
  configure: (options: { superMcpUrl?: string | null; idleTriggerMs?: number; watchdogDelayMs?: number }) => void;
  scheduleIdleTimerAndWatchdog: (bootstrapDurationMs: number) => void;
  observeRequest: (method: string, path: string, isHealthRoute: boolean) => void;
  ensureWarm: (trigger: WarmupTrigger) => Promise<void>;
  getState: () => WarmupState;
  getHealthSnapshot: () => { state: WarmupState; failedAttempts: number; stateChangedAtMs: number | null };
  cleanup: () => void;
  resetForTests: () => void;
} {
  const service = new CloudBootstrapWarmupService(deps);
  return {
    configure: service.configure.bind(service),
    scheduleIdleTimerAndWatchdog: service.scheduleIdleTimerAndWatchdog.bind(service),
    observeRequest: service.observeRequest.bind(service),
    ensureWarm: service.ensureWarm.bind(service),
    getState: service.getState.bind(service),
    getHealthSnapshot: service.getHealthSnapshot.bind(service),
    cleanup: service.cleanup.bind(service),
    resetForTests: service.resetForTests.bind(service),
  };
}
