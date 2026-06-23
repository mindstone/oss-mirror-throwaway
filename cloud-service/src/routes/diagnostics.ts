/**
 * Cloud diagnostics routes.
 *
 * - GET /api/diagnostics      — coarse cloud diagnostics (legacy)
 * - GET /api/diagnostics/self — per-device continuity diagnostics snapshot
 */

import http from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sendJson, sendRouteError, RouteError } from '../httpUtils';
import { runAllCloudChecks } from '../health/checks';
import { getRecentLogs } from '@core/logBuffer';
import { createScopedLogger } from '@core/logger';
import type { CloudServiceDeps } from '../bootstrap';
import { getTokens } from '../pushStore';
import { getSessionTombstoneStore } from '@core/services/continuity/sessionTombstoneStore';
import { getOutboxStallMonitor } from '@core/services/continuity/outboxStallMonitor';
import { readContinuityStateMap, getCatchUpHistoryForDevice } from '@core/services/cloudContinuityStateService';
import {
  flushDiagnosticEventsLedger,
  getDiagnosticEventsLedgerReader,
} from '@core/services/diagnosticEventsLedger';
import {
  assembleCloudLegacyDiagnostics,
  assembleCloudSelfDiagnostics,
  normalizeSessionSummaries,
} from '@core/services/diagnostics/diagnosticBundleService';
import { getCostWaterfallByOutcome } from '@core/services/diagnostics/costWaterfall';
import { formatRecentDiagnosticEvents } from '@core/services/diagnostics/recentEventsFormatter';
import { getRecentDiagnosticContext } from '@core/services/diagnostics/recentDiagnosticContext';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
import {
  MAX_DIAGNOSTIC_EVENTS,
  MAX_DIAGNOSTIC_EVENTS_BYTES,
  CLOUD_SELF_DIAGNOSTICS_RATE_LIMIT_MAX_HITS,
  CLOUD_SELF_DIAGNOSTICS_RATE_LIMIT_WINDOW_MS,
} from '@core/services/diagnostics/manifest';
import {
  DIAGNOSTIC_SECTION_IDS,
  SectionIdSchema,
  type DiagnosticSections,
  type SectionId,
} from '@shared/diagnostics/diagnosticBundleSections';

const DATA_DIR = process.env.REBEL_USER_DATA || '/data';
const log = createScopedLogger({ service: 'cloudDiagnosticsRoutes' });
const CLOUD_LOGS_NOTE = 'Cloud has no on-disk log files; use Fly logs.';
let _lastExportTime = 0;
const MIN_EXPORT_INTERVAL_MS = 60_000;

type SessionSurface = 'desktop' | 'mobile' | 'cloud';

function getHeaderValue(req: http.IncomingMessage, name: string): string | null {
  const raw = req.headers[name];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
  return null;
}

function parseSurfaceHeader(req: http.IncomingMessage): SessionSurface {
  const value = getHeaderValue(req, 'x-rebel-surface')?.trim().toLowerCase();
  if (value === 'desktop' || value === 'mobile' || value === 'cloud') return value;
  return 'cloud';
}

function getDeviceScopeKey(req: http.IncomingMessage): string {
  const bearer = (getHeaderValue(req, 'authorization') ?? '').replace(/^Bearer\s+/i, '').trim() || 'anonymous';
  const surface = parseSurfaceHeader(req);
  const clientId = getHeaderValue(req, 'x-rebel-client-id')?.trim() || 'unknown-client';
  return `${bearer}:${surface}:${clientId}`;
}

function parseDiagnosticSectionInclude(req: http.IncomingMessage): DiagnosticSections | undefined {
  const parsedUrl = new URL(req.url ?? '/', 'http://localhost');
  if (!parsedUrl.searchParams.has('include')) return undefined;

  const requested = new Set<SectionId>();
  const raw = parsedUrl.searchParams.get('include') ?? '';
  for (const part of raw.split(',')) {
    const parsed = SectionIdSchema.safeParse(part.trim());
    if (parsed.success) requested.add(parsed.data);
  }

  return Object.fromEntries(
    DIAGNOSTIC_SECTION_IDS.map((sectionId) => [sectionId, requested.has(sectionId)]),
  ) as DiagnosticSections;
}

class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private readonly maxHits: number, private readonly windowMs: number) {
    this.cleanupTimer = setInterval(() => this.cleanup(), windowMs);
    this.cleanupTimer.unref?.();
  }

  isLimited(key: string): boolean {
    const now = Date.now();
    const timestamps = (this.hits.get(key) ?? []).filter((timestamp) => now - timestamp < this.windowMs);
    timestamps.push(now);
    this.hits.set(key, timestamps);
    return timestamps.length > this.maxHits;
  }

  reset(): void {
    this.hits.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, timestamps] of this.hits) {
      const active = timestamps.filter((timestamp) => now - timestamp < this.windowMs);
      if (active.length === 0) this.hits.delete(key);
      else this.hits.set(key, active);
    }
  }
}

const selfDiagnosticsLimiter = new RateLimiter(
  CLOUD_SELF_DIAGNOSTICS_RATE_LIMIT_MAX_HITS,
  CLOUD_SELF_DIAGNOSTICS_RATE_LIMIT_WINDOW_MS,
);

export async function handleDiagnostics(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps?: Pick<CloudServiceDeps, 'listSessions'>,
): Promise<void> {
  if (req.method !== 'GET') return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Only GET' }));

  const now = Date.now();
  if (now - _lastExportTime < MIN_EXPORT_INTERVAL_MS) {
    return sendRouteError(res, undefined, new RouteError('RATE_LIMITED', { status: 429, message: 'Diagnostic export limited to once per minute' }));
  }
  _lastExportTime = now;

  const checks = await runAllCloudChecks();
  const bundle = await assembleCloudLegacyDiagnostics({
    checks,
    dataDir: DATA_DIR,
    appInfo: {
      version: process.env.REBEL_VERSION || (typeof __REBEL_VERSION__ !== 'undefined' ? __REBEL_VERSION__ : 'unknown'),
      uptime: process.uptime(),
      platform: process.platform,
      nodeVersion: process.version,
    },
    collectors: {
      getRecentLogs: () => getRecentLogs(60_000),
      countSessions: () => countSessions(deps),
      getDiskInfo,
      getPushTokenCount: () => getTokens().length,
    },
  });

  return sendJson(res, 200, bundle);
}

export async function handleDiagnosticsSelf(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: Pick<CloudServiceDeps, 'listSessions'>,
): Promise<void> {
  if (req.method !== 'GET') return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Only GET' }));

  const deviceScopeKey = getDeviceScopeKey(req);
  if (selfDiagnosticsLimiter.isLimited(deviceScopeKey)) {
    return sendRouteError(res, undefined, new RouteError('RATE_LIMITED', { status: 429, message: 'Self diagnostics export limited to once per minute per device' }));
  }

  const checks = await runAllCloudChecks();
  const response = await assembleCloudSelfDiagnostics({
    deviceScopeKey,
    checks,
    sessions: normalizeSessionSummaries(deps.listSessions()),
    appInfo: {
      version: process.env.REBEL_VERSION || (typeof __REBEL_VERSION__ !== 'undefined' ? __REBEL_VERSION__ : 'unknown'),
      platform: process.platform,
      nodeVersion: process.version,
      uptimeSec: process.uptime(),
    },
    options: {
      diagnosticSections: parseDiagnosticSectionInclude(req),
    },
    collectors: {
      readContinuityStateMap,
      listTombstones: () => getSessionTombstoneStore().listTombstones(),
      getOutboxSnapshot: (key) => getOutboxStallMonitor().getSnapshot(key),
      getCatchUpHistoryForDevice,
      getRecentLogs: () => getRecentLogs(60_000),
      getRecentDiagnosticEvents: readRecentDiagnosticEvents,
      getCostWaterfallByOutcome: (opts) => getCostWaterfallByOutcome(opts),
    },
  });
  return sendJson(res, 200, response, req);
}

export async function handleDiagnosticsRecentEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method !== 'GET') return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Only GET' }));

  const endpoint = '/diagnostics/recent-events';
  try {
    const parsedUrl = new URL(req.url ?? '/', 'http://localhost');
    const limit = parseOptionalNumberParam(parsedUrl.searchParams.get('limit'));
    const windowHours = parseOptionalNumberParam(parsedUrl.searchParams.get('windowHours'));
    const ctx = await getRecentDiagnosticContext({ limit, windowHours });
    const { markdown, entryCount } = formatRecentDiagnosticEvents(ctx);
    const bytesReturned = Buffer.byteLength(markdown, 'utf8');
    const lines = markdown.split('\n').length;
    log.info({
      endpoint,
      status: 200,
      lines,
      bytesReturned,
      eventCount: entryCount,
      readerAvailable: ctx.readerAvailable,
      bearerHashPrefix: hashBearerPrefix(req.headers.authorization),
    }, 'Cloud diagnostic-events read access');
    return sendJson(res, 200, {
      success: true,
      markdown,
      eventCount: entryCount,
      readerAvailable: ctx.readerAvailable,
    }, req);
  } catch (err) {
    log.error({ err, endpoint }, 'Cloud diagnostic-events endpoint failed');
    captureKnownCondition(
      'bridge_recent_events_failure',
      { endpoint, surface: 'cloud' },
      err instanceof Error ? err : new Error(String(err)),
    );
    log.info({
      endpoint,
      status: 500,
      bearerHashPrefix: hashBearerPrefix(req.headers.authorization),
    }, 'Cloud diagnostic-events read access (failed)');
    return sendJson(res, 500, { success: false, error: 'Failed to read diagnostic events.' }, req);
  }
}

export async function handleDiagnosticsRecentLogs(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method !== 'GET') return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Only GET' }));

  const endpoint = '/diagnostics/recent-logs';
  try {
    const payload = {
      success: true,
      content: '',
      lines: 0,
      bytesReturned: 0,
      bytesAvailable: 0,
      truncated: false,
      filesRead: [],
      errors: [],
      surface: 'cloud',
      note: CLOUD_LOGS_NOTE,
    };
    log.info({
      endpoint,
      status: 200,
      lines: payload.lines,
      bytesReturned: payload.bytesReturned,
      bytesAvailable: payload.bytesAvailable,
      truncated: payload.truncated,
      bearerHashPrefix: hashBearerPrefix(req.headers.authorization),
    }, 'Cloud raw-log read access');
    return sendJson(res, 200, payload, req);
  } catch (err) {
    log.error({ err, endpoint }, 'Cloud recent-logs endpoint failed');
    captureKnownCondition(
      'bridge_recent_logs_failure',
      { endpoint, surface: 'cloud' },
      err instanceof Error ? err : new Error(String(err)),
    );
    log.info({
      endpoint,
      status: 500,
      bearerHashPrefix: hashBearerPrefix(req.headers.authorization),
    }, 'Cloud raw-log read access (failed)');
    return sendJson(res, 500, { success: false, error: 'Failed to read recent log lines.' }, req);
  }
}

export async function handleDiagnosticsLogFilePaths(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method !== 'GET') return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Only GET' }));

  const endpoint = '/diagnostics/log-file-paths';
  try {
    const payload = {
      success: true,
      logDir: '',
      files: [],
      totalBytes: 0,
      errors: [],
      surface: 'cloud',
      note: CLOUD_LOGS_NOTE,
    };
    log.info({
      endpoint,
      status: 200,
      filesCount: payload.files.length,
      totalBytes: payload.totalBytes,
      bearerHashPrefix: hashBearerPrefix(req.headers.authorization),
    }, 'Cloud log-file-paths read access');
    return sendJson(res, 200, payload, req);
  } catch (err) {
    log.error({ err, endpoint }, 'Cloud log-file-paths endpoint failed');
    captureKnownCondition(
      'bridge_log_file_paths_failure',
      { endpoint, surface: 'cloud' },
      err instanceof Error ? err : new Error(String(err)),
    );
    log.info({
      endpoint,
      status: 500,
      bearerHashPrefix: hashBearerPrefix(req.headers.authorization),
    }, 'Cloud log-file-paths read access (failed)');
    return sendJson(res, 500, { success: false, error: 'Failed to read log file metadata.' }, req);
  }
}

export function _resetDiagnosticsRouteStateForTests(): void {
  _lastExportTime = 0;
  selfDiagnosticsLimiter.reset();
}

async function readRecentDiagnosticEvents(): Promise<readonly Record<string, unknown>[]> {
  await flushDiagnosticEventsLedger();
  const reader = getDiagnosticEventsLedgerReader();
  if (!reader) return [];
  const events = await reader.readRecent({
    limit: MAX_DIAGNOSTIC_EVENTS,
    maxBytes: MAX_DIAGNOSTIC_EVENTS_BYTES,
  });
  return events as unknown as readonly Record<string, unknown>[];
}

function parseOptionalNumberParam(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function hashBearerPrefix(authHeader: string | string[] | undefined): string {
  const raw = Array.isArray(authHeader) ? authHeader[0] ?? '' : authHeader ?? '';
  const token = raw.replace(/^Bearer\s+/i, '').trim();
  return createHash('sha256').update(token).digest('hex').slice(0, 8);
}

async function countSessions(deps?: Pick<CloudServiceDeps, 'listSessions'>): Promise<number> {
  if (deps?.listSessions) {
    try {
      const sessions = deps.listSessions();
      return Array.isArray(sessions) ? sessions.length : -1;
    } catch {
      // Fall through to filesystem count.
    }
  }
  try {
    const sessionsDir = path.join(DATA_DIR, 'sessions');
    const files = fs.readdirSync(sessionsDir);
    return files.filter((file) => file.endsWith('.json')).length;
  } catch {
    return -1;
  }
}

async function getDiskInfo(): Promise<{ diskAvailableMB?: number; diskTotalMB?: number }> {
  try {
    const stats = fs.statfsSync(DATA_DIR);
    return {
      diskAvailableMB: Math.round((stats.bavail * stats.bsize) / (1024 * 1024)),
      diskTotalMB: Math.round((stats.blocks * stats.bsize) / (1024 * 1024)),
    };
  } catch {
    return {};
  }
}
