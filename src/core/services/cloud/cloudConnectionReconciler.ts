import type { BroadcastService } from '@core/broadcastService';
import type { ErrorReporter } from '@core/errorReporter';
import type { Logger as PinoLogger } from '@core/logger';
import type { CloudPressureBasic } from '@shared/types/cloudHealth';
import type { CloudInstanceConfig } from '@shared/types/settings';
import { categorize, type CloudErrorCategory } from './cloudErrorCategory';
import type { CloudHealthProbe } from './cloudHealthProbe';
import type { ReconcilerWriter } from './cloudConnectionReconcilerTypes';

/** Pressure observation supplied alongside a reconciler write. */
export type PressureObservation = CloudPressureBasic;

export type { ReconcilerWriter } from './cloudConnectionReconcilerTypes';

export interface CloudInstanceSettingsAdapter {
  read(): CloudInstanceConfig | undefined;
  update(merge: Partial<CloudInstanceConfig>): Promise<void>;
}

export interface CloudConnectionReconcilerDeps {
  settings: CloudInstanceSettingsAdapter;
  broadcastService: BroadcastService;
  errorReporter: ErrorReporter;
  logger: PinoLogger;
  probe: CloudHealthProbe;
  cooldown?: {
    recordFailure(context?: { writer?: ReconcilerWriter; category?: CloudErrorCategory }): void;
    recordSuccess(context?: { writer?: ReconcilerWriter; lastCategory?: CloudErrorCategory }): void;
  };
}

export interface ReconcileArgs {
  writer: ReconcilerWriter;
  cloudUrl?: string;
  timeoutMs?: number;
}

export type CloudConnectionOutcome =
  | {
      result: 'success';
      writer: ReconcilerWriter;
      timestamp: number;
      status?: number;
    }
  | {
      result: 'failure';
      writer: ReconcilerWriter;
      timestamp: number;
      category: CloudErrorCategory;
      rawError: string;
      legacyLastError?: string;
      status?: number;
    };

export interface CloudConnectionReconciler {
  reconcile(args: ReconcileArgs): Promise<CloudConnectionOutcome>;
  reportSuccess(args: {
    writer: ReconcilerWriter;
    cloudUrl?: string;
    pressureObservation?: PressureObservation;
  }): Promise<void>;
  reportFailure(args: {
    writer: ReconcilerWriter;
    rawError: unknown;
    cloudUrl?: string;
    category?: CloudErrorCategory;
    legacyLastError?: string;
    pressureObservation?: PressureObservation;
  }): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const CLOUD_STATUS_CHANGED_CHANNEL = 'cloud:status-changed';
const CLOUD_PRESSURE_STATE_CHANNEL = 'cloud:pressure-state';

/** Maximum number of pressure events to retain in the sliding window. */
const MAX_PRESSURE_EVENTS = 50;
/** Maximum age of pressure events to retain (7 days). */
const MAX_PRESSURE_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function errorToMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

function categoryToLegacyLastError(category: CloudErrorCategory): string {
  switch (category.kind) {
    case 'network':
      return `Cloud instance isn't responding — it may be asleep, restarting, or the URL may be wrong.`;
    case 'auth':
      if (category.subkind === 'forbidden') {
        return 'Access denied by the cloud instance. The token may have been rotated or revoked.';
      }
      return 'Authentication failed — your access token was rejected.';
    case 'cloud_down':
      if (category.subkind === 'reported_unhealthy') {
        return 'Cloud responded but reported itself as unhealthy.';
      }
      if (category.subkind === 'deprovisioning') {
        return 'Cloud is being reprovisioned. It may need a minute before it responds again.';
      }
      return 'Cloud returned a server error. It may be restarting or overloaded.';
    case 'unknown':
      return category.rawMessage || 'Unknown cloud connection error';
  }
}

function categoryFromProbeResult(result: { ok: boolean; status?: number; raw?: unknown }): CloudErrorCategory {
  if (result.status !== undefined && result.status >= 200 && result.status <= 299) {
    return { kind: 'cloud_down', subkind: 'reported_unhealthy' };
  }
  if (result.status !== undefined) {
    return categorize({ status: result.status, message: `HTTP ${result.status}` });
  }
  return categorize(result.raw ?? new Error('Cloud health check failed'));
}

function rawToMessage(raw: unknown): string {
  if (raw instanceof Error) return raw.message;
  if (typeof raw === 'string') return raw;
  try {
    return JSON.stringify(raw) ?? String(raw);
  } catch {
    return String(raw);
  }
}

function errorStringProp(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const prop = (value as Record<string, unknown>)[key];
  return typeof prop === 'string' ? prop : undefined;
}

function errorRecordProp(value: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const prop = (value as Record<string, unknown>)[key];
  return typeof prop === 'object' && prop !== null ? prop as Record<string, unknown> : undefined;
}

function getErrorCodeForLog(err: unknown): string | undefined {
  return errorStringProp(err, 'code') ?? errorStringProp(errorRecordProp(err, 'cause'), 'code');
}

function getErrorNameForLog(err: unknown): string | undefined {
  if (err instanceof Error) return err.name;
  return errorStringProp(err, 'name');
}

function logCategorizeOutcome(
  logger: PinoLogger,
  category: CloudErrorCategory,
  rawError: unknown,
): void {
  if (category.kind !== 'unknown') return;

  logger.info(
    {
      rawMessage: category.rawMessage,
      errCode: getErrorCodeForLog(rawError),
      errName: getErrorNameForLog(rawError),
    },
    'Cloud error categorizer saw novel error shape; falling back to unknown category',
  );
}

function prunePressureEvents(
  events: NonNullable<CloudInstanceConfig['recentPressureEvents']>,
  nowMs: number,
): NonNullable<CloudInstanceConfig['recentPressureEvents']> {
  const cutoff = nowMs - MAX_PRESSURE_EVENT_AGE_MS;
  const pruned = events.filter((e) => e.at >= cutoff);
  return pruned.slice(-MAX_PRESSURE_EVENTS);
}

export function createCloudConnectionReconciler(
  deps: CloudConnectionReconcilerDeps,
): CloudConnectionReconciler {
  let currentInFlight: Promise<CloudConnectionOutcome> | null = null;

  const getCloudInstance = (): CloudInstanceConfig | undefined => {
    return deps.settings.read();
  };

  const shouldBroadcast = (
    previous: CloudInstanceConfig | undefined,
    next: CloudInstanceConfig,
  ): boolean => {
    return (
      previous?.lastKnownStatus !== next.lastKnownStatus ||
      previous?.errorCategory?.kind !== next.errorCategory?.kind
    );
  };

  const shouldBroadcastPressure = (
    previous: CloudInstanceConfig | undefined,
    next: CloudInstanceConfig,
  ): boolean => {
    return previous?.lastPressureState !== next.lastPressureState;
  };

  const writeStatus = async (
    outcome: CloudConnectionOutcome,
    pressureObservation?: PressureObservation,
  ): Promise<void> => {
    const previous = getCloudInstance();

    if (!previous) {
      deps.logger.warn({ writer: outcome.writer }, 'Cloud reconciler skipped write because cloudInstance is absent');
      return;
    }

    if (previous.mode !== 'cloud') {
      deps.logger.info(
        { writer: outcome.writer, mode: previous.mode },
        'Cloud reconciler skipped status write because cloudInstance is no longer in cloud mode',
      );
      return;
    }

    try {
      if (outcome.result === 'success') {
        deps.cooldown?.recordSuccess({
          writer: outcome.writer,
          lastCategory: previous.errorCategory,
        });
      } else {
        deps.cooldown?.recordFailure({
          writer: outcome.writer,
          category: outcome.category,
        });
      }
    } catch (err) {
      deps.logger.warn({ err, writer: outcome.writer }, 'Cloud reconciler cooldown update failed');
    }

    const statusMerge: Partial<CloudInstanceConfig> =
      outcome.result === 'success'
        ? {
            lastKnownStatus: 'running',
            lastError: undefined,
            errorCategory: undefined,
            degradedSince: undefined,
            lastSyncedAt: outcome.timestamp,
            lastWriter: outcome.writer,
          }
        : {
            lastKnownStatus: 'error',
            lastError: outcome.legacyLastError ?? categoryToLegacyLastError(outcome.category),
            errorCategory: outcome.category,
            // lastSyncedAt intentionally means last successful contact; failures leave it untouched.
            lastWriter: outcome.writer,
          };

    // Build pressure merge if an observation was provided.
    let pressureMerge: Partial<CloudInstanceConfig> = {};
    if (pressureObservation) {
      const newEvent: NonNullable<CloudInstanceConfig['recentPressureEvents']>[number] = {
        state: pressureObservation.state,
        at: outcome.timestamp,
        oom: pressureObservation.oomRecent,
        recentRestart: pressureObservation.recentRestart,
      };
      const existing = previous.recentPressureEvents ?? [];
      const pruned = prunePressureEvents([...existing, newEvent], outcome.timestamp);

      pressureMerge = {
        lastPressureState: pressureObservation.state,
        lastPressureCheckedAt: outcome.timestamp,
        recentPressureEvents: pruned,
      };
    }

    const merge: Partial<CloudInstanceConfig> = { ...statusMerge, ...pressureMerge };

    // Re-check mode immediately before writing: a teardown (forget / deprovision)
    // can flip cloudInstance to local mode between the initial read above and
    // here. Because the write is a shallow merge, applying status fields onto a
    // now-local config would re-create a (milder) drift state — `mode:'local'`
    // carrying live status. Re-reading right before the synchronous update call
    // closes that TOCTOU window.
    if (getCloudInstance()?.mode !== 'cloud') {
      deps.logger.info(
        { writer: outcome.writer },
        'Cloud reconciler aborted status write — cloudInstance left cloud mode mid-reconcile',
      );
      return;
    }

    await deps.settings.update(merge);
    const next = getCloudInstance() ?? { ...previous, ...merge };

    if (shouldBroadcast(previous, next)) {
      deps.broadcastService.sendToAllWindows(CLOUD_STATUS_CHANGED_CHANNEL, {
        lastKnownStatus: next.lastKnownStatus,
        errorCategory: next.errorCategory,
        lastWriter: next.lastWriter,
        timestamp: outcome.timestamp,
      });
    }

    if (pressureObservation && shouldBroadcastPressure(previous, next)) {
      deps.broadcastService.sendToAllWindows(CLOUD_PRESSURE_STATE_CHANNEL, {
        state: pressureObservation.state,
        timestamp: outcome.timestamp,
        recentPressureEvents: next.recentPressureEvents,
      });
    }
  };

  const runReconcile = async (args: ReconcileArgs): Promise<CloudConnectionOutcome> => {
    const cloudUrl = args.cloudUrl ?? getCloudInstance()?.cloudUrl;
    const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (!cloudUrl) {
      const category: CloudErrorCategory = { kind: 'unknown', rawMessage: 'Cloud URL is not configured' };
      const outcome: CloudConnectionOutcome = {
        result: 'failure',
        writer: args.writer,
        timestamp: Date.now(),
        category,
        rawError: category.rawMessage,
      };
      await writeStatus(outcome);
      return outcome;
    }

    try {
      const result = await deps.probe.probe({ cloudUrl, timeoutMs });
      const timestamp = Date.now();
      if (result.ok) {
        const outcome: CloudConnectionOutcome = {
          result: 'success',
          writer: args.writer,
          timestamp,
          status: result.status,
        };
        await writeStatus(outcome, result.pressure);
        return outcome;
      }

      const category = categoryFromProbeResult(result);
      logCategorizeOutcome(
        deps.logger,
        category,
        result.raw ?? (result.status !== undefined ? { status: result.status, message: `HTTP ${result.status}` } : undefined),
      );
      const rawError =
        result.status !== undefined && (result.status < 200 || result.status > 299)
          ? `HTTP ${result.status}`
          : rawToMessage(result.raw ?? categoryToLegacyLastError(category));
      const outcome: CloudConnectionOutcome = {
        result: 'failure',
        writer: args.writer,
        timestamp,
        category,
        rawError,
        status: result.status,
      };
      // On a non-ok response the cloud is reachable; still record pressure if provided.
      await writeStatus(outcome, result.pressure);
      return outcome;
    } catch (err) {
      const category = categorize(err);
      logCategorizeOutcome(deps.logger, category, err);
      const outcome: CloudConnectionOutcome = {
        result: 'failure',
        writer: args.writer,
        timestamp: Date.now(),
        category,
        rawError: errorToMessage(err),
      };
      // Cloud unreachable — no pressure observation available.
      await writeStatus(outcome);
      return outcome;
    }
  };

  const reconcile = (args: ReconcileArgs): Promise<CloudConnectionOutcome> => {
    if (currentInFlight) return currentInFlight;

    const promise = runReconcile(args).finally(() => {
      if (currentInFlight === promise) {
        currentInFlight = null;
      }
    });
    currentInFlight = promise;
    return promise;
  };

  const reportSuccess = async (args: {
    writer: ReconcilerWriter;
    cloudUrl?: string;
    pressureObservation?: PressureObservation;
  }): Promise<void> => {
    const inFlight = currentInFlight;
    if (inFlight) {
      await inFlight.catch((err) => {
        deps.logger.warn({ err, writer: args.writer }, 'Cloud reconciler reportSuccess waited for failed in-flight reconcile');
      });
    }

    const outcome: CloudConnectionOutcome = {
      result: 'success',
      writer: args.writer,
      timestamp: Date.now(),
    };
    await writeStatus(outcome, args.pressureObservation);
  };

  const reportFailure = async (args: {
    writer: ReconcilerWriter;
    rawError: unknown;
    cloudUrl?: string;
    category?: CloudErrorCategory;
    legacyLastError?: string;
    pressureObservation?: PressureObservation;
  }): Promise<void> => {
    const category = args.category ?? categorize(args.rawError);
    logCategorizeOutcome(deps.logger, category, args.rawError);
    const outcome: CloudConnectionOutcome = {
      result: 'failure',
      writer: args.writer,
      timestamp: Date.now(),
      category,
      rawError: errorToMessage(args.rawError),
      legacyLastError: args.legacyLastError,
    };
    await writeStatus(outcome, args.pressureObservation);
  };

  return { reconcile, reportSuccess, reportFailure };
}
