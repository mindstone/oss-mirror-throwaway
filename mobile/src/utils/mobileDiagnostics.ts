/**
 * Mobile Diagnostics Gatherer
 *
 * Collects device info and privacy-filtered recent logs for inclusion
 * in mobile feedback/bug reports. This is the mobile counterpart of
 * the desktop's bugReportDiagnosticService.ts.
 *
 * IMPORTANT: This must be callable from plain async code — do NOT use React hooks.
 */

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { hashForBreadcrumb, useOfflineQueueStore, useSessionStore } from '@rebel/cloud-client';
import type { QueueItem } from '@rebel/cloud-client';
import { resolveDiagnosticSection, type DiagnosticSections } from '@shared/diagnostics/diagnosticBundleSections';
import { readRecentLogs } from './fileLogSink';
import { filterLogEntries } from './logFilter';
import {
  flushMobileDiagnosticEvents,
  readRecentMobileDiagnosticEvents,
  type MobileDiagnosticBufferEvent,
} from '../storage/diagnosticEventBufferStorage';

// =============================================================================
// Types
// =============================================================================

export interface MobileDiagnosticBundle {
  deviceInfo: Record<string, string>;
  filteredLogs: string;
  logLineCount: number;
  queueSnapshot?: MobileQueueSnapshot;
  continuityState?: MobileContinuityStateSummary;
  catchUpHistory?: MobileCatchUpHistoryEntry[];
  /**
   * Mobile-local diagnostic events from the on-device buffer (oldest-first).
   * Loaded only when the `recent_events` section is enabled by the user's
   * diagnostic toggles. Mobile-only — never uploaded to cloud.
   *
   * `undefined` (vs. empty array) signals "the buffer was not consulted" so
   * `assembleMobileBundle` can route the section state to `'unavailable'`
   * rather than `'empty'`.
   */
  recentEvents?: MobileDiagnosticBufferEvent[];
}

export interface MobileQueueSnapshot {
  pendingCount: number;
  processingCount: number;
  countsByType: Record<string, number>;
  countsByErrorCategory: Record<string, number>;
  maxAttempts: number;
  oldestAgeMs: number | null;
  queueFull: boolean;
  limitedConnectivity: boolean;
  authExpired: boolean;
}

export interface MobileContinuityStateSummary {
  connectionState: 'connected' | 'reconnecting' | 'disconnected';
  knownSessionCount: number;
  appliedSeqSessionCount: number;
  lastTombstoneSyncAt: number | null;
  queueBoundCloudUrlHash?: string;
}

export interface MobileCatchUpHistoryEntry {
  sessionIdHash: string;
  appliedSeq: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Maximum time to spend gathering diagnostics before giving up. */
const GATHER_TIMEOUT_MS = 5000;

/** Maximum character length for filtered logs (must fit within cloud-service's 100KB Zod cap). */
const MAX_FILTERED_LOGS_LENGTH = 95_000;

function buildQueueSnapshot(
  items: QueueItem[],
  stateFlags: {
    queueFullAt: number | null;
    limitedConnectivityAt: number | null;
    authExpiredAt: number | null;
  },
): MobileQueueSnapshot {
  const countsByType: Record<string, number> = {};
  const countsByErrorCategory: Record<string, number> = {};
  let pendingCount = 0;
  let processingCount = 0;
  let maxAttempts = 0;
  let oldestEnqueuedAt = Infinity;

  for (const item of items) {
    countsByType[item.type] = (countsByType[item.type] ?? 0) + 1;

    if (item.status === 'pending') pendingCount += 1;
    if (item.status === 'processing') processingCount += 1;

    if (typeof item.attempts === 'number' && item.attempts > maxAttempts) {
      maxAttempts = item.attempts;
    }

    if (item.errorCategory) {
      const key = String(item.errorCategory);
      countsByErrorCategory[key] = (countsByErrorCategory[key] ?? 0) + 1;
    }

    if (typeof item.enqueuedAt === 'number' && Number.isFinite(item.enqueuedAt) && item.enqueuedAt < oldestEnqueuedAt) {
      oldestEnqueuedAt = item.enqueuedAt;
    }
  }

  return {
    pendingCount,
    processingCount,
    countsByType,
    countsByErrorCategory,
    maxAttempts,
    oldestAgeMs: oldestEnqueuedAt === Infinity ? null : Math.max(0, Date.now() - oldestEnqueuedAt),
    queueFull: stateFlags.queueFullAt !== null,
    limitedConnectivity: stateFlags.limitedConnectivityAt !== null,
    authExpired: stateFlags.authExpiredAt !== null,
  };
}

function gatherContinuitySections(): Pick<MobileDiagnosticBundle, 'queueSnapshot' | 'continuityState' | 'catchUpHistory'> {
  const sessionState = useSessionStore.getState();
  const appliedSeqEntries = Object.entries(sessionState.appliedSeq ?? {})
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  const catchUpHistory: MobileCatchUpHistoryEntry[] = appliedSeqEntries.map(([sessionId, appliedSeq]) => ({
    sessionIdHash: hashForBreadcrumb(sessionId),
    appliedSeq,
  }));

  const continuityState: MobileContinuityStateSummary = {
    connectionState: sessionState.connectionState,
    knownSessionCount: Array.isArray(sessionState.sessions) ? sessionState.sessions.length : 0,
    appliedSeqSessionCount: Object.keys(sessionState.appliedSeq ?? {}).length,
    lastTombstoneSyncAt: sessionState.lastTombstoneSyncAt ?? null,
  };

  try {
    const queueState = useOfflineQueueStore.getState();
    const items = Array.isArray(queueState.items) ? queueState.items : [];
    const queueSnapshot = buildQueueSnapshot(items, {
      queueFullAt: queueState.queueFullAt,
      limitedConnectivityAt: queueState.limitedConnectivityAt,
      authExpiredAt: queueState.authExpiredAt,
    });
    if (queueState.boundCloudUrl) {
      continuityState.queueBoundCloudUrlHash = hashForBreadcrumb(queueState.boundCloudUrl);
    }
    return {
      queueSnapshot,
      continuityState,
      ...(catchUpHistory.length > 0 ? { catchUpHistory } : {}),
    };
  } catch {
    // Queue store may not be initialized yet; still return session continuity context.
    return {
      continuityState,
      ...(catchUpHistory.length > 0 ? { catchUpHistory } : {}),
    };
  }
}

/**
 * Resolve runtimeVersion to a display string.
 * Expo's runtimeVersion can be a string ("1.0.0") or an object ({ policy: "appVersion" }).
 * When it's a policy object, resolve it to the actual app version.
 */
function resolveRuntimeVersion(): string {
  const rv = Constants.expoConfig?.runtimeVersion;
  if (rv == null) return 'unknown';
  if (typeof rv === 'string') return rv;
  if (typeof rv === 'object' && 'policy' in rv && rv.policy === 'appVersion') {
    return Constants.expoConfig?.version ?? 'unknown';
  }
  return JSON.stringify(rv);
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Gather mobile diagnostics: device info + privacy-filtered recent logs.
 *
 * Returns null if gathering fails or times out — never throws.
 * Callers should submit feedback without diagnostics if this returns null.
 */
export async function gatherMobileDiagnostics(options?: { diagnosticSections?: DiagnosticSections }): Promise<MobileDiagnosticBundle | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      gatherDiagnosticsCore(options),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), GATHER_TIMEOUT_MS);
      }),
    ]);
    return result;
  } catch (err) {
    const continuitySections = resolveDiagnosticSection(options, 'continuity_trail').enabled
      ? gatherContinuitySections()
      : {};
    // Never throw — return diagnostics with an error note if log reading fails
    return {
      deviceInfo: {
        platform: Platform.OS,
        platformVersion: String(Platform.Version),
        appVersion: Constants.expoConfig?.version ?? 'unknown',
        runtimeVersion: resolveRuntimeVersion(),
      },
      filteredLogs: resolveDiagnosticSection(options, 'recent_logs').enabled
        ? `[Diagnostics error: ${err instanceof Error ? err.message : String(err)}]`
        : '',
      logLineCount: 0,
      ...continuitySections,
      // recentEvents intentionally omitted in the failure path — the bundle
      // assembler will mark the section 'unavailable' rather than 'empty'.
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function gatherDiagnosticsCore(options?: { diagnosticSections?: DiagnosticSections }): Promise<MobileDiagnosticBundle> {
  // Collect device info
  const deviceInfo: Record<string, string> = {
    platform: Platform.OS,
    platformVersion: String(Platform.Version),
    appVersion: Constants.expoConfig?.version ?? 'unknown',
    runtimeVersion: resolveRuntimeVersion(),
  };

  let filteredLogs = '';
  if (resolveDiagnosticSection(options, 'recent_logs').enabled) {
    // Read and filter recent logs
    const rawLogs = await readRecentLogs();
    filteredLogs = filterLogEntries(rawLogs);

    // Truncate to stay within cloud-service's Zod validation cap
    if (filteredLogs.length > MAX_FILTERED_LOGS_LENGTH) {
      // Keep the most recent logs (end of string) by finding the next newline after the cut point
      const cutPoint = filteredLogs.length - MAX_FILTERED_LOGS_LENGTH;
      const nextNewline = filteredLogs.indexOf('\n', cutPoint);
      filteredLogs = nextNewline >= 0 ? filteredLogs.slice(nextNewline + 1) : filteredLogs.slice(cutPoint);
    }
  }

  const logLineCount = filteredLogs ? filteredLogs.split('\n').filter(Boolean).length : 0;
  const continuitySections = resolveDiagnosticSection(options, 'continuity_trail').enabled
    ? gatherContinuitySections()
    : {};

  let recentEvents: MobileDiagnosticBufferEvent[] | undefined;
  if (resolveDiagnosticSection(options, 'recent_events').enabled) {
    try {
      // Flush in-memory tail to disk so the bundle reflects the freshest
      // events, then read with conservative caps (defaults inside the buffer).
      await flushMobileDiagnosticEvents();
      recentEvents = await readRecentMobileDiagnosticEvents();
    } catch {
      // Reader failure is observable downstream as section state
      // 'unavailable' (we leave recentEvents undefined). Never throw.
      recentEvents = undefined;
    }
  }

  return {
    deviceInfo,
    filteredLogs,
    logLineCount,
    ...continuitySections,
    ...(recentEvents !== undefined ? { recentEvents } : {}),
  };
}
