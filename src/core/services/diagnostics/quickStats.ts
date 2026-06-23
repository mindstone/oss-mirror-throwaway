import type {
  CloudOutboxSnapshot,
  DiagnosticBundleParams,
  DiagnosticEventEntry,
  DiagnosticEventKind,
  DiagnosticFileEntry,
  DiagnosticPerfStats,
  DiagnosticQuickStats,
  FsExhaustionSnapshot,
  LogSummary,
  ProcessSupervisionSnapshot,
  SessionExcerpt,
  StoreBreakdownSnapshot,
  TurnLogFile,
  AutoUpdateForensics,
} from './manifest';

export interface HealthReportLike {
  status: 'healthy' | 'degraded' | 'critical';
  checks: Record<string, { status?: string }>;
}

export interface ComputeQuickStatsInput {
  healthReport: HealthReportLike | null;
  logSummary: LogSummary | null;
  sessionExcerpts: SessionExcerpt[];
  perfStats?: DiagnosticPerfStats;
  autoUpdate?: AutoUpdateForensics;
  /**
   * Diagnostic events already loaded for the bundle's events.jsonl.
   * When provided and non-empty, drives the manifest's per-kind summary
   * so triagers see counts + last-seen times without parsing NDJSON.
   */
  diagnosticEvents?: readonly DiagnosticEventEntry[];
  /** EMFILE / graceful-fs queue snapshot. Omitted from manifest when no pressure observed. */
  fsExhaustion?: FsExhaustionSnapshot;
  /** Top-level userData store-file size breakdown. */
  storeBreakdown?: StoreBreakdownSnapshot;
  /** Main-process supervision counters from clean-exit-flag store. */
  processSupervision?: ProcessSupervisionSnapshot;
  /** Cloud outbox pending count + oldest queue age. */
  cloudOutbox?: CloudOutboxSnapshot;
}

/**
 * Decide whether the fs-exhaustion snapshot is worth surfacing in the manifest.
 * Suppresses zero-pressure runs (no tag counts, idle queue) so non-incident
 * bundles stay clean.
 */
function fsExhaustionWorthIncluding(snapshot: FsExhaustionSnapshot | undefined): snapshot is FsExhaustionSnapshot {
  if (!snapshot) return false;
  if (snapshot.lastSource !== undefined) return true;
  if (snapshot.queueDepth > 0 || snapshot.queuePeak > 0) return true;
  for (const value of Object.values(snapshot.sourceCounts)) {
    if (value > 0) return true;
  }
  return false;
}

export function computeQuickStats(input: ComputeQuickStatsInput): DiagnosticQuickStats {
  const failedChecks: string[] = [];
  const warnChecks: string[] = [];
  let errorCountLast15m = 0;
  let warnCountLast15m = 0;
  if (input.healthReport) {
    for (const [checkId, result] of Object.entries(input.healthReport.checks)) {
      if (result.status === 'fail') failedChecks.push(checkId);
      else if (result.status === 'warn') warnChecks.push(checkId);
    }
  }
  if (input.logSummary) {
    for (const pattern of input.logSummary.errorPatterns) {
      if (pattern.level >= 50) errorCountLast15m += pattern.count;
      else if (pattern.level >= 40) warnCountLast15m += pattern.count;
    }
  }
  const eventSummary = summarizeDiagnosticEvents(input.diagnosticEvents);
  const includeFsExhaustion = fsExhaustionWorthIncluding(input.fsExhaustion);
  return {
    healthStatus: input.healthReport?.status || 'critical',
    failedChecks,
    warnChecks,
    errorCountLast15m,
    warnCountLast15m,
    sessionCount: input.sessionExcerpts.length,
    ...(input.perfStats && { perfStats: input.perfStats }),
    ...(input.autoUpdate && { autoUpdate: input.autoUpdate }),
    ...(eventSummary.counts && { recentDiagnosticEventCounts: eventSummary.counts }),
    ...(eventSummary.lastTimes && { lastDiagnosticEventTimes: eventSummary.lastTimes }),
    ...(eventSummary.engagedKinds.length > 0 && { diagnosticEventCapEngagedKinds: eventSummary.engagedKinds }),
    ...(includeFsExhaustion && { fsExhaustion: input.fsExhaustion }),
    ...(input.storeBreakdown && input.storeBreakdown.entries.length > 0 && { storeBreakdown: input.storeBreakdown }),
    ...(input.processSupervision && { processSupervision: input.processSupervision }),
    ...(input.cloudOutbox && { cloudOutbox: input.cloudOutbox }),
  };
}

/**
 * Tally diagnostic events by kind and capture the most recent timestamp per kind.
 * Also returns the event kinds whose process-local per-kind cap engaged within
 * the read window.
 * Returns `null` slots when the input is empty/missing so the caller can omit
 * the optional manifest fields entirely (rather than emitting empty objects).
 */
export function summarizeDiagnosticEvents(
  events: readonly DiagnosticEventEntry[] | undefined,
): {
  counts: Partial<Record<DiagnosticEventKind, number>> | null;
  lastTimes: Partial<Record<DiagnosticEventKind, number>> | null;
  engagedKinds: DiagnosticEventKind[];
} {
  if (!events || events.length === 0) {
    return { counts: null, lastTimes: null, engagedKinds: [] };
  }
  const counts: Partial<Record<DiagnosticEventKind, number>> = {};
  const lastTimes: Partial<Record<DiagnosticEventKind, number>> = {};
  const seenHealthCheckIds = new Set<string>();
  const engagedKinds = new Set<DiagnosticEventKind>();
  
  for (const evt of events) {
    const kind = evt.kind;
    
    if (kind === 'health_check_timing') {
      const hash = (evt as Extract<DiagnosticEventEntry, { kind: 'health_check_timing' }>).data.checkIdHash;
      if (seenHealthCheckIds.has(hash)) continue;
      seenHealthCheckIds.add(hash);
    }
    
    counts[kind] = (counts[kind] ?? 0) + 1;
    const prev = lastTimes[kind];
    if (prev === undefined || evt.ts > prev) {
      lastTimes[kind] = evt.ts;
    }
    if (evt.kind === 'events_per_kind_cap_engaged') {
      engagedKinds.add(evt.data.kind);
    }
  }
  return { counts, lastTimes, engagedKinds: [...engagedKinds].sort() };
}

export function computeBundleParams(options: {
  logWindowMinutes: number;
  maxTurnLogs: number;
  maxRecentSessions: number;
  truncated: boolean;
}): DiagnosticBundleParams {
  return { ...options };
}

export function computeCapabilities(input: {
  contents: Record<string, DiagnosticFileEntry>;
  healthReport: HealthReportLike | null;
  turnLogs: TurnLogFile[];
  sessionExcerpts: SessionExcerpt[];
}): string[] {
  const capabilities: string[] = [];
  const { contents } = input;
  if (input.healthReport) capabilities.push('health');
  if (contents['settings.json']) capabilities.push('config');
  if (contents['logs/main.ndjson']) capabilities.push('logs');
  if (contents['logs/errors.ndjson']) capabilities.push('errors-log');
  if (input.turnLogs.length > 0) capabilities.push('turn-logs');
  if (input.sessionExcerpts.length > 0) capabilities.push('sessions');
  if (contents['sentry-scope.json']) capabilities.push('sentry');
  if (contents['rebel-system/README.md']) capabilities.push('chief-of-staff');
  if (contents['tool-usage.json']) capabilities.push('tool-usage');
  if (contents['cost-ledger.jsonl']) capabilities.push('cost-ledger');
  if (contents['automations.json']) capabilities.push('automations');
  if (contents['pending-tool-approvals.json']) capabilities.push('pending-approvals');
  if (contents['meeting-bot-pending.json']) capabilities.push('meeting-bot');
  if (contents['physical-recording-pending.json']) capabilities.push('physical-recordings');
  if (contents['continuity/outbox-state.json'] || contents['continuity/workspace-sync-history.json'] || contents['continuity/state-machine-transitions.json']) {
    capabilities.push('continuity');
  }
  return capabilities;
}
