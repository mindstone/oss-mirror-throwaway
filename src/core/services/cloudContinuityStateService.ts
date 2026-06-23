import fs from 'node:fs/promises';
import path from 'node:path';
import { getErrorReporter } from '@core/errorReporter';
import { createScopedLogger } from '@core/logger';
import { appendDiagnosticEvent } from '@core/services/diagnosticEventsLedger';
import {
  getCatchUpAuxiliaryPayload,
  getSequencedEventsSince,
  hashSessionId,
  type CloudBroadcast,
  type DestructiveOpsApplied,
} from '@core/services/cloudSessionMergeService';
import { getSessionMutex, SessionMutexDeadlockError } from '@core/services/sessionMutex';
import type { SessionDeleteOptions } from '@core/services/incrementalSessionStore';
import type {
  CloudRemovalIntent,
  ContinuityStateMap,
} from '@core/services/continuity/continuityStateTypes';
import { toDiagnosticContinuityTransition } from '@shared/diagnostics/continuityTransition';
import type { AgentEvent, AgentSession } from '@shared/types';

const continuityLog = createScopedLogger({ service: 'cloudContinuityStateService' });
const sessionMutex = getSessionMutex();

export const CATCH_UP_DEFAULT_TOTAL_LIMIT = 5_000;
export const CATCH_UP_MAX_TOTAL_LIMIT = 5_000;
export const CATCH_UP_CONTINUATION_TOKEN_VERSION = 1 as const;
export const CATCH_UP_HISTORY_MAX_ENTRIES = 20;

/**
 * Grace period (ms) before a `local_only` session is deleted from cloud.
 * Protects against the race: user demotes on desktop, but mobile/web started
 * a turn moments ago. State map pushes every 60s, so 5 min is generous.
 */
export const GC_GRACE_WINDOW_MS = 5 * 60 * 1_000;

export interface CatchUpHistoryEntry {
  requestedAt: number;
  durationMs: number;
  sessionCount: number;
  returnedEventCount: number;
  limit: number;
  usedContinuationToken: boolean;
  hasMore: boolean;
}

export type CatchUpSinceSeqMap = Record<string, number>;

export interface CatchUpContinuationTokenPayload {
  v: typeof CATCH_UP_CONTINUATION_TOKEN_VERSION;
  sessionIds: string[];
  cursors: CatchUpSinceSeqMap;
}

export interface CloudContinuityStateEffectSink {
  emit(event: Extract<CloudBroadcast, { channel: 'cloud:session-changed' }>): void;
}

export interface CloudContinuityStateDeps {
  listSessions: () => unknown;
  /** Stage 3: delete intent is REQUIRED and declared at the call site. */
  deleteSession: (sessionId: string, options: SessionDeleteOptions) => Promise<void>;
  getSession: (sessionId: string) => Promise<AgentSession | null>;
}

export type StateMapPutOutcome =
  | { kind: 'persisted'; merged: ContinuityStateMap; preserved: number; refusedDemotions: number }
  | { kind: 'invalid-state'; reason: string };

export type RunStateMapGcProtectionReason =
  | 'within-grace-window'
  | 'no-removal-intent'
  | 'retention-policy-visibility-only';

export interface RunStateMapGcProtectedSession {
  sessionId: string;
  reason: RunStateMapGcProtectionReason;
}

export type RunStateMapGcOutcome = {
  kind: 'completed';
  deleted: string[];
  protected: RunStateMapGcProtectedSession[];
  remaining: number;
  gcDeleted: number;
  gcProtectedNoIntent: number;
  gcProtectedRetentionPolicy: number;
};

export interface CatchUpResponseSession {
  events: AgentEvent[];
  maxSeq: number;
  messageDelta?: AgentSession['messages'];
  messageDeletes?: string[];
  destructiveOpsApplied?: DestructiveOpsApplied;
}

export interface CatchUpResponse {
  sessions: Record<string, CatchUpResponseSession>;
  serverNow: number;
  continuationToken?: string;
}

export type ProcessCatchUpOutcome =
  | { kind: 'invalid-request'; message: string }
  | { kind: 'success'; response: CatchUpResponse; recordHistory: false }
  | { kind: 'success'; response: CatchUpResponse; recordHistory: true; historyEntry: CatchUpHistoryEntry };

export interface ProcessCatchUpParams {
  deviceScopeKey: string;
  requestedAt: number;
  limitParam: string | null;
  continuationTokenParam: string | null;
  sinceSeqParam: string | null;
  sessionIdsParam: string | null;
}

const catchUpHistoryByDevice = new Map<string, CatchUpHistoryEntry[]>();
let stateMapWriteLock: Promise<void> = Promise.resolve();

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// TODO(continuity-core): migrate this to a desktop-aware data-path boundary once
// desktop/mobile adopt this service. For now the cloud contract is env-per-call.
export function getStateFilePath(): string {
  return path.join(process.env.REBEL_USER_DATA || '/data', 'cloud-continuity-state.json');
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function isContinuityState(value: unknown): value is 'local_only' | 'cloud_active' {
  return value === 'local_only' || value === 'cloud_active';
}

function sanitizeCloudRemovalIntent(value: unknown): CloudRemovalIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  if (
    typeof record.requestedAt !== 'number'
    || !Number.isFinite(record.requestedAt)
    || record.requestedAt <= 0
  ) {
    return null;
  }
  if (record.requestedBy !== 'user' && record.requestedBy !== 'retention-policy') {
    return null;
  }

  const intent: CloudRemovalIntent = {
    requestedAt: record.requestedAt,
    requestedBy: record.requestedBy,
  };
  if (
    record.source === 'desktop'
    || record.source === 'mobile'
    || record.source === 'web'
    || record.source === 'cloud'
  ) {
    intent.source = record.source;
  }
  return intent;
}

export function sanitizeContinuityStateMapInput(raw: Record<string, unknown>): ContinuityStateMap {
  const sanitized: ContinuityStateMap = {};
  for (const [sessionId, candidate] of Object.entries(raw)) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) continue;

    if (typeof candidate === 'string') {
      if (!isContinuityState(candidate)) continue;
      sanitized[sessionId] = { state: candidate };
      continue;
    }
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;

    const record = candidate as Record<string, unknown>;
    if (!isContinuityState(record.state)) continue;

    const entry: ContinuityStateMap[string] = {
      state: record.state,
    };
    if (typeof record.lastCloudActivityAt === 'number' && Number.isFinite(record.lastCloudActivityAt)) {
      entry.lastCloudActivityAt = record.lastCloudActivityAt;
    }
    if (typeof record.cloudPinnedAt === 'number' && Number.isFinite(record.cloudPinnedAt)) {
      entry.cloudPinnedAt = record.cloudPinnedAt;
    }
    const cloudRemovalIntent = sanitizeCloudRemovalIntent(record.cloudRemovalIntent);
    if (cloudRemovalIntent) {
      entry.cloudRemovalIntent = cloudRemovalIntent;
    }
    if (entry.state === 'cloud_active' && entry.cloudRemovalIntent) {
      const sessionIdHash = hashSessionId(sessionId);
      continuityLog.warn(
        {
          sessionIdHash,
          state: entry.state,
          reason: 'cloud-active-with-removal-intent',
        },
        'Dropped incoherent cloudRemovalIntent on cloud_active continuity entry',
      );
      getErrorReporter().addBreadcrumb({
        category: 'continuity.sanitizer',
        level: 'warning',
        message: 'continuity-intent-incoherent',
        data: {
          sessionIdHash,
          state: entry.state,
          reason: 'cloud-active-with-removal-intent',
        },
      });
      appendDiagnosticEvent(toDiagnosticContinuityTransition({
        family: 'state',
        category: 'continuity.sanitizer',
        level: 'warning',
        message: 'continuity-intent-incoherent',
        data: {
          sessionIdHash,
          reason: 'cloud-active-with-removal-intent',
        },
      }));
      delete entry.cloudRemovalIntent;
    }
    sanitized[sessionId] = entry;
  }
  return sanitized;
}

export function parseLimit(value: string | null): number | null {
  if (value === null) return CATCH_UP_DEFAULT_TOTAL_LIMIT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return null;
  return Math.min(parsed, CATCH_UP_MAX_TOTAL_LIMIT);
}

export function parseSessionIdsParam(value: string | null): string[] | null {
  if (value === null) return [];
  const parsed = value
    .split(',')
    .map((sessionId) => sessionId.trim())
    .filter((sessionId) => sessionId.length > 0);
  return Array.from(new Set(parsed));
}

export function parseSinceSeqParam(value: string | null): { defaultSinceSeq: number; perSession: CatchUpSinceSeqMap } | null {
  if (value === null) {
    return {
      defaultSinceSeq: 0,
      perSession: {},
    };
  }

  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && Number.isInteger(asNumber) && asNumber >= 0) {
    return {
      defaultSinceSeq: asNumber,
      perSession: {},
    };
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const perSession: CatchUpSinceSeqMap = {};
    for (const [sessionId, seq] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isNonNegativeInteger(seq)) return null;
      perSession[sessionId] = seq;
    }
    return {
      defaultSinceSeq: 0,
      perSession,
    };
  } catch {
    return null;
  }
}

export function encodeContinuationToken(payload: CatchUpContinuationTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeContinuationToken(token: string): CatchUpContinuationTokenPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const payload = parsed as Partial<CatchUpContinuationTokenPayload>;
    if (payload.v !== CATCH_UP_CONTINUATION_TOKEN_VERSION) return null;
    if (!Array.isArray(payload.sessionIds) || payload.sessionIds.some((id) => typeof id !== 'string')) return null;
    if (!payload.cursors || typeof payload.cursors !== 'object' || Array.isArray(payload.cursors)) return null;
    const cursorEntries = Object.entries(payload.cursors as Record<string, unknown>);
    for (const [sessionId, seq] of cursorEntries) {
      if (typeof sessionId !== 'string' || !isNonNegativeInteger(seq)) return null;
    }
    return {
      v: CATCH_UP_CONTINUATION_TOKEN_VERSION,
      sessionIds: payload.sessionIds,
      cursors: payload.cursors as CatchUpSinceSeqMap,
    };
  } catch {
    return null;
  }
}

export function listSessionIdsFromSummaries(summaries: unknown): string[] {
  if (!Array.isArray(summaries)) return [];
  const sessionIds: string[] = [];
  for (const summary of summaries) {
    if (!summary || typeof summary !== 'object') continue;
    const id = (summary as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) {
      sessionIds.push(id);
    }
  }
  return Array.from(new Set(sessionIds));
}

/**
 * Merge an incoming state map with an existing one, preserving cloud_active
 * entries that the incoming map doesn't know about (e.g. mobile-created sessions).
 * Refuses cloud_active -> local_only demotion without explicit removal intent.
 */
export function mergePreservingCloudActive(
  incoming: ContinuityStateMap,
  existing: ContinuityStateMap | null,
): { merged: ContinuityStateMap; preserved: number; refused: number } {
  const merged = { ...incoming };
  let preserved = 0;
  let refused = 0;
  if (existing) {
    for (const [sessionId, existingEntry] of Object.entries(existing)) {
      if (existingEntry.state !== 'cloud_active') continue;

      const incomingEntry = merged[sessionId];
      if (!incomingEntry) {
        merged[sessionId] = existingEntry;
        preserved++;
        continue;
      }

      if (incomingEntry.state === 'local_only' && !incomingEntry.cloudRemovalIntent) {
        merged[sessionId] = existingEntry;
        refused++;
        const refusalData = {
          sessionIdHash: hashSessionId(sessionId),
          existingState: 'cloud_active' as const,
          incomingState: 'local_only' as const,
          refusal: 'no-intent' as const,
        };
        continuityLog.warn(
          refusalData,
          'Refused incoming demotion without explicit cloudRemovalIntent',
        );
        getErrorReporter().addBreadcrumb({
          category: 'continuity.merge-guard',
          level: 'warning',
          message: 'continuity-merge-refused',
          data: refusalData,
        });
        appendDiagnosticEvent(toDiagnosticContinuityTransition({
          family: 'state',
          category: 'continuity.merge-guard',
          level: 'warning',
          message: 'continuity-merge-refused',
          data: refusalData,
        }));
      }
    }

    for (const [sessionId, existingEntry] of Object.entries(existing)) {
      if (existingEntry.state !== 'local_only') continue;
      if (!existingEntry.cloudRemovalIntent) continue;

      const incomingEntry = merged[sessionId];
      if (!incomingEntry) continue;
      if (incomingEntry.state !== 'local_only') continue;
      if (incomingEntry.cloudRemovalIntent) continue;

      merged[sessionId] = {
        ...incomingEntry,
        cloudRemovalIntent: existingEntry.cloudRemovalIntent,
      };
    }
  }
  return { merged, preserved, refused };
}

/**
 * Read the stored continuity state map from disk.
 * Returns null if the file doesn't exist or is unreadable.
 */
export async function readContinuityStateMap(): Promise<ContinuityStateMap | null> {
  try {
    const raw = await fs.readFile(getStateFilePath(), 'utf-8');
    return JSON.parse(raw) as ContinuityStateMap;
  } catch {
    return null;
  }
}

async function withStateMapWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = stateMapWriteLock;
  let releaseLock!: () => void;
  stateMapWriteLock = new Promise<void>((resolve) => { releaseLock = resolve; });

  await previous;
  try {
    return await fn();
  } finally {
    releaseLock();
  }
}

async function writeContinuityStateMap(stateMap: ContinuityStateMap): Promise<void> {
  const stateFile = getStateFilePath();
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify(stateMap), 'utf-8');
}

/**
 * Mark a session as cloud_active in the continuity state map.
 * Used when cloud-native sessions are created (from mobile/web or agent turn WS)
 * so they appear in activeOnly queries. No-ops if the session is already tracked.
 * Serialized via mutex to prevent concurrent read-modify-write from losing entries.
 */
export async function markSessionAsCloudActive(sessionId: string): Promise<void> {
  try {
    await sessionMutex.withLock(sessionId, async () => {
      await withStateMapWriteLock(async () => {
        const stateMap = await readContinuityStateMap() ?? {};
        if (stateMap[sessionId]?.state === 'cloud_active') return;
        stateMap[sessionId] = { state: 'cloud_active', lastCloudActivityAt: Date.now() };
        await writeContinuityStateMap(stateMap);
      });
    }, { label: 'continuity.mark-cloud-active' });
  } catch (err) {
    const sessionIdHash = hashSessionId(sessionId);
    if (err instanceof SessionMutexDeadlockError) {
      continuityLog.error({ sessionIdHash, error: err.message }, 'Session mutex deadlock while marking session cloud_active');
      return;
    }
    continuityLog.warn({ sessionIdHash, error: getErrorMessage(err) }, 'Failed to mark session as cloud_active');
  }
}

export function recordCatchUpHistory(deviceScopeKey: string, entry: CatchUpHistoryEntry): void {
  const existing = catchUpHistoryByDevice.get(deviceScopeKey) ?? [];
  const next = [...existing, entry];
  if (next.length > CATCH_UP_HISTORY_MAX_ENTRIES) {
    next.splice(0, next.length - CATCH_UP_HISTORY_MAX_ENTRIES);
  }
  catchUpHistoryByDevice.set(deviceScopeKey, next);
}

export function getCatchUpHistoryForDevice(deviceScopeKey: string): CatchUpHistoryEntry[] {
  const entries = catchUpHistoryByDevice.get(deviceScopeKey);
  if (!entries) return [];
  return entries.map((entry) => ({ ...entry }));
}

export function _resetContinuityCatchUpHistoryForTests(): void {
  catchUpHistoryByDevice.clear();
}

export function resetCloudContinuityStateServiceForTests(): void {
  catchUpHistoryByDevice.clear();
  stateMapWriteLock = Promise.resolve();
}

export async function processStateMapPut(
  _deps: Pick<CloudContinuityStateDeps, 'listSessions' | 'deleteSession'>,
  body: Record<string, unknown>,
): Promise<StateMapPutOutcome> {
  const sanitizedIncoming = sanitizeContinuityStateMapInput(body);
  try {
    const result = await withStateMapWriteLock(async () => {
      const existing = await readContinuityStateMap();
      const mergedResult = mergePreservingCloudActive(sanitizedIncoming, existing);
      await writeContinuityStateMap(mergedResult.merged);
      return mergedResult;
    });
    continuityLog.info(
      {
        entries: Object.keys(result.merged).length,
        preserved: result.preserved,
        refusedDemotions: result.refused,
      },
      'Continuity state map updated',
    );
    return {
      kind: 'persisted',
      merged: result.merged,
      preserved: result.preserved,
      refusedDemotions: result.refused,
    };
  } catch (err) {
    continuityLog.error({ error: getErrorMessage(err) }, 'Failed to write continuity state map');
    return { kind: 'invalid-state', reason: 'Failed to write continuity state map' };
  }
}

/**
 * Garbage-collect cloud sessions that the desktop has declared `local_only`.
 * Deletion requires explicit user cloudRemovalIntent plus elapsed grace window.
 * Runs fire-and-forget after the state map is saved — the caller controls when
 * this starts so desktop isn't blocked by the PUT response.
 */
export async function runStateMapGC(
  stateMap: ContinuityStateMap,
  deps: Pick<CloudContinuityStateDeps, 'listSessions' | 'deleteSession'>,
  sink: CloudContinuityStateEffectSink,
): Promise<RunStateMapGcOutcome> {
  const now = Date.now();
  const graceThreshold = now - GC_GRACE_WINDOW_MS;

  const summaries = deps.listSessions() as Array<{ id?: string; updatedAt?: number }>;
  const deleted: string[] = [];
  const protectedSessions: RunStateMapGcProtectedSession[] = [];
  let gcProtectedNoIntent = 0;
  let gcProtectedRetentionPolicy = 0;

  for (const summary of summaries) {
    if (!summary.id) continue;
    const sessionId = summary.id;

    const entry = stateMap[sessionId];
    if (!entry) continue;
    if (entry.state === 'cloud_active') continue;

    const lastActivity = summary.updatedAt ?? 0;
    if (lastActivity > graceThreshold) {
      protectedSessions.push({
        sessionId,
        reason: 'within-grace-window',
      });
      continue;
    }

    if (entry.cloudRemovalIntent?.requestedBy !== 'user') {
      const sessionIdHash = hashSessionId(sessionId);
      if (entry.cloudRemovalIntent?.requestedBy === 'retention-policy') {
        gcProtectedRetentionPolicy++;
        protectedSessions.push({
          sessionId,
          reason: 'retention-policy-visibility-only',
        });
        continuityLog.info(
          {
            sessionIdHash,
            protected: 'retention-policy-visibility-only',
          },
          'State-map GC protected local_only session',
        );
        getErrorReporter().addBreadcrumb({
          category: 'continuity.gc-guard',
          level: 'info',
          message: 'state-map-gc-protected',
          data: {
            sessionIdHash,
            protected: 'retention-policy-visibility-only',
          },
        });
        appendDiagnosticEvent(toDiagnosticContinuityTransition({
          family: 'state',
          category: 'continuity.gc-guard',
          level: 'info',
          message: 'state-map-gc-protected',
          data: {
            sessionIdHash,
            protected: 'retention-policy-visibility-only',
          },
        }));
      } else {
        gcProtectedNoIntent++;
        protectedSessions.push({
          sessionId,
          reason: 'no-removal-intent',
        });
        continuityLog.info(
          {
            sessionIdHash,
            protected: 'no-removal-intent',
          },
          'State-map GC protected local_only session',
        );
        getErrorReporter().addBreadcrumb({
          category: 'continuity.gc-guard',
          level: 'info',
          message: 'state-map-gc-protected',
          data: {
            sessionIdHash,
            protected: 'no-removal-intent',
          },
        });
        appendDiagnosticEvent(toDiagnosticContinuityTransition({
          family: 'state',
          category: 'continuity.gc-guard',
          level: 'info',
          message: 'state-map-gc-protected',
          data: {
            sessionIdHash,
            protected: 'no-removal-intent',
          },
        }));
      }
      continue;
    }

    try {
      await sessionMutex.withLock(sessionId, async () => {
        // Intent: 'hygiene' (Stage 3 classification table) — continuity GC is
        // housekeeping with no fresh user intent at this call site; the
        // explicit cloudRemovalIntent it acts on is owned by the desktop's
        // delete flow (which tombstones there). Tombstoning here would let a
        // grace-window GC permanently block a later legitimate re-sync.
        await deps.deleteSession(sessionId, { intent: 'hygiene' });
      }, { label: 'continuity.gc-delete' });
      sink.emit({ channel: 'cloud:session-changed', payload: { sessionId, action: 'deleted' } });
      deleted.push(sessionId);
    } catch (err) {
      continuityLog.warn(
        {
          sessionIdHash: hashSessionId(sessionId),
          error: getErrorMessage(err),
        },
        'GC failed to delete session',
      );
    }
  }

  if (deleted.length > 0 || protectedSessions.length > 0) {
    continuityLog.info(
      {
        deleted: deleted.length,
        protected: protectedSessions.length,
        gcProtectedNoIntent,
        gcProtectedRetentionPolicy,
      },
      'State-map GC completed',
    );
  }

  return {
    kind: 'completed',
    deleted,
    protected: protectedSessions,
    remaining: summaries.length - deleted.length,
    gcDeleted: deleted.length,
    gcProtectedNoIntent,
    gcProtectedRetentionPolicy,
  };
}

export async function processCatchUp(
  deps: Pick<CloudContinuityStateDeps, 'getSession' | 'listSessions'>,
  params: ProcessCatchUpParams,
): Promise<ProcessCatchUpOutcome> {
  const limit = parseLimit(params.limitParam);
  if (limit === null) {
    return { kind: 'invalid-request', message: `limit must be a positive integer (max ${CATCH_UP_MAX_TOTAL_LIMIT})` };
  }

  let sessionIds: string[];
  let cursors: CatchUpSinceSeqMap;

  if (params.continuationTokenParam) {
    const decoded = decodeContinuationToken(params.continuationTokenParam);
    if (!decoded) {
      return { kind: 'invalid-request', message: 'continuationToken is invalid' };
    }
    sessionIds = decoded.sessionIds;
    cursors = decoded.cursors;
  } else {
    const parsedSinceSeq = parseSinceSeqParam(params.sinceSeqParam);
    if (!parsedSinceSeq) {
      return { kind: 'invalid-request', message: 'sinceSeq must be a non-negative integer or JSON object map' };
    }

    const parsedSessionIds = parseSessionIdsParam(params.sessionIdsParam);
    if (parsedSessionIds === null) {
      return { kind: 'invalid-request', message: 'sessionIds must be a comma-separated list' };
    }

    sessionIds = parsedSessionIds.length > 0
      ? parsedSessionIds
      : listSessionIdsFromSummaries(deps.listSessions());
    cursors = {};
    for (const sessionId of sessionIds) {
      cursors[sessionId] = parsedSinceSeq.perSession[sessionId] ?? parsedSinceSeq.defaultSinceSeq;
    }
  }

  sessionIds = Array.from(new Set(sessionIds.filter((id) => typeof id === 'string' && id.length > 0)));
  if (sessionIds.length === 0) {
    return {
      kind: 'success',
      response: {
        sessions: {},
        serverNow: Date.now(),
      },
      recordHistory: false,
    };
  }

  const sessions: Record<string, CatchUpResponseSession> = {};
  const nextCursors: CatchUpSinceSeqMap = { ...cursors };
  let remaining = limit;
  let hasMore = false;

  for (const sessionId of sessionIds) {
    const sinceSeq = cursors[sessionId] ?? 0;
    const session = await deps.getSession(sessionId);

    if (!session) {
      sessions[sessionId] = { events: [], maxSeq: 0 };
      nextCursors[sessionId] = sinceSeq;
      continue;
    }

    const { events, serverSeq } = getSequencedEventsSince(session, sinceSeq);
    const takeCount = remaining > 0 ? Math.min(remaining, events.length) : 0;
    const pagedEvents = takeCount > 0 ? events.slice(0, takeCount) : [];
    sessions[sessionId] = {
      events: pagedEvents,
      maxSeq: serverSeq,
    };

    const lastPagedEvent = pagedEvents.at(-1);
    if (lastPagedEvent !== undefined) {
      nextCursors[sessionId] = lastPagedEvent.seq;
      remaining -= pagedEvents.length;
    } else {
      nextCursors[sessionId] = sinceSeq;
    }

    if (events.length > pagedEvents.length) {
      hasMore = true;
    }
  }

  const response: CatchUpResponse = {
    sessions,
    serverNow: Date.now(),
  };

  if (hasMore) {
    response.continuationToken = encodeContinuationToken({
      v: CATCH_UP_CONTINUATION_TOKEN_VERSION,
      sessionIds,
      cursors: nextCursors,
    });
  } else {
    for (const sessionId of sessionIds) {
      const session = await deps.getSession(sessionId);
      if (!session) continue;
      Object.assign(sessions[sessionId], getCatchUpAuxiliaryPayload(session, cursors[sessionId] ?? 0));
    }
  }

  const returnedEventCount = Object.values(sessions).reduce(
    (total, session) => total + session.events.length,
    0,
  );

  const historyEntry: CatchUpHistoryEntry = {
    requestedAt: params.requestedAt,
    durationMs: Math.max(0, Date.now() - params.requestedAt),
    sessionCount: sessionIds.length,
    returnedEventCount,
    limit,
    usedContinuationToken: Boolean(params.continuationTokenParam),
    hasMore,
  };
  recordCatchUpHistory(params.deviceScopeKey, historyEntry);

  return {
    kind: 'success',
    response,
    recordHistory: true,
    historyEntry,
  };
}
