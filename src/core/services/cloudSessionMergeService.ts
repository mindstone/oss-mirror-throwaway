import { createHash } from 'node:crypto';
import { createScopedLogger } from '@core/logger';
import { AGENT_SESSION_METADATA_PATCH_KEYS } from '@shared/types';
import type { AgentEvent, AgentSession, AgentSessionMetadataPatch, ImageRef, McpAppUiMeta } from '@shared/types';
import type { AgentSessionSummary } from '@shared/ipc/schemas/sessions';
import { deriveSessionUpdatedAt } from '@shared/utils/conversationState';
import type { CloudSessionSummary } from '@rebel/shared';
import { fnvHashBase36 as hashForBreadcrumb, isSessionActive, isSessionDone } from '@rebel/shared';
import {
  getKnownTurnIds,
  hasTerminalEvent,
  mergePerTurnMap,
  unionPerTurnMap,
  mergeMemoryStatusByTurn,
  deduplicateMessages,
  mergeEventsForCloudPush,
  type EventOverwritePreventedDetails,
} from '@core/services/sessionMergeUtils';
import { deriveTurnLiveness, toPersistedBusyScalars } from '@core/services/conversationState';
import { isDefaultOrFallbackTitle, resolveAutoTitleMetadata } from '@core/services/conversationTitleService';
import {
  getSessionTombstoneStore,
  type SessionDeletedBy,
  type SessionTombstone,
} from '@core/services/continuity/sessionTombstoneStore';
import { getMaxSeqFromSession, getSessionSeqIndex, stampMissingEventSeq } from '@core/services/continuity/sessionSeqIndex';
import { getServerNow, stampCloudUpdatedAt } from '@core/services/continuity/serverClock';
import { getSessionMutex } from '@core/services/sessionMutex';
import type { SessionDeleteOptions } from '@core/services/incrementalSessionStore';
import {
  getConflictDetector,
  resetConflictDetectorForTests,
  SURFACE_TIEBREAKER_RACE_WINDOW_MS,
  type ConcurrentMetadataConflictResult,
} from '@core/services/conflictDetector';
import type { DiagnosticEventEmitInput } from '@core/services/diagnosticEventsLedger';
import type { ContinuityStateMap } from '@core/services/continuity/continuityStateTypes';
import { toDiagnosticContinuityTransition } from '@shared/diagnostics/continuityTransition';
import { isBackgroundConversationSession } from '@shared/sessionKind';
import { getEventIdentity, isValidSeq, type EventIdentity } from '@shared/utils/eventIdentity';
import { sanitizeToolImagePayloadForRefs } from '@shared/utils/eventSanitization';

const sessionMergeLog = createScopedLogger({ service: 'cloudSessionMergeService' });
const sessionMutex = getSessionMutex();
const conflictDetector = getConflictDetector();

export const MAX_TOOL_EVENT_DETAIL_CHARS = 500;
export const MAX_TURN_IMAGE_BYTES = 10 * 1024 * 1024;
/**
 * @internal Test / in-file-documentation seam. The production title-merge logic
 * deliberately uses the BROADER `isDefaultOrFallbackTitle` predicate, NOT a narrow
 * `=== DEFAULT_SESSION_TITLE` check (see the title-merge comment ~L1290, the F1 fix),
 * so this constant's only real consumers are this service's tests plus that
 * explanatory comment. Tagged `@internal` so the knip production leg ignores it while
 * the default leg keeps tracking it; `@internal` not `@public` (that hatch is for API
 * consumed OUTSIDE the project glob).
 */
export const DEFAULT_SESSION_TITLE = 'New conversation';
export const CATCH_UP_DEFAULT_LIMIT = 500;
export const CATCH_UP_MAX_LIMIT = 5_000;
export const CONFLICT_TITLE_MAX_CHARS = 1_000;
export const STRUCTURED_TOOL_MAX_CHARS = 10_000;
export const SESSION_EVENTS_APPEND_IDEMPOTENCY_TTL_MS = 60_000;
export const SESSION_EVENTS_APPEND_IDEMPOTENCY_MAX_ENTRIES = 10_000;

export const CLOUD_VALID_ORIGINS: ReadonlySet<CloudSessionSummary['origin']> = new Set([
  'manual', 'automation', 'mcp-tool', 'inbound-trigger', 'plugin',
]);

/** Tool names whose detail gets a higher truncation limit — they contain structured JSON
 *  (mission goals, task lists) that clients parse with JSON.parse().
 *  Includes TaskCreate/TaskUpdate for task snapshot parsing. */
export const STRUCTURED_TOOL_NAMES: ReadonlySet<string> = new Set(['MissionSet', 'TaskList', 'TodoWrite', 'TaskCreate', 'TaskUpdate']);

export type SessionSurfaceTag = 'desktop' | 'mobile' | 'cloud' | 'cloud-untagged' | 'cli';
export type SequencedAgentEvent = AgentEvent & { seq: number; turnId: string };

export type LeanToolEvent = Pick<Extract<AgentEvent, { type: 'tool' }>,
  | 'type'
  | 'toolName'
  | 'detail'
  | 'stage'
  | 'isError'
  | 'toolUseId'
  | 'parentToolUseId'
  | 'timestamp'
  | 'mcpAppUiMeta'
  | 'toolResult'
> & {
  imageContent?: {
    type: 'image';
    data: string;
    mimeType: string;
  }[];
  imageRef?: Array<ImageRef | null>;
  /**
   * Refs for opaque-content blocks offloaded to the session-scoped ContentStore.
   * Pass-through on the lean DTO; never dropped or truncated. Producers emit
   * this alongside (not instead of) inline content until uploads succeed —
   * see docs/plans/260518_cloud_sync_reconciliation_hardening.md § B1a.
   */
  contentRef?: Array<import('@shared/types/agent').ContentRef | null>;
};

// Surface user-question events on the lean API so mobile / cloud-client can
// rehydrate the answered state across sessions (e.g. after a force-quit between
// the answer and the continuation turn completing). Payloads are small (an
// answered event is ~100 bytes, a question event ~1-2KB), so there's no size
// concern akin to tool-event truncation. See:
//   docs-private/postmortems/260420_empty_result_anomaly_askuserquestion_deny_postmortem.md
//   docs/plans/260420_user_question_cross_surface_resilience.md (Stage 7)
export type LeanUserQuestionEvent = Extract<AgentEvent, { type: 'user_question' }>;
export type LeanUserQuestionAnsweredEvent = Extract<AgentEvent, { type: 'user_question_answered' }>;
export type LeanSessionEvent = LeanToolEvent | LeanUserQuestionEvent | LeanUserQuestionAnsweredEvent;

export type CloudBroadcast =
  | { channel: 'cloud:session-changed'; payload: { sessionId: string; action: 'upserted' | 'deleted' } }
  | { channel: 'cloud:session-event'; payload: { sessionId: string; event: SequencedAgentEvent } }
  | {
      channel: 'cloud:session-conflict';
      payload: {
        sessionId: string;
        conflictType: 'stale-metadata' | 'concurrent-edit' | 'surface-tiebreaker';
        fields: string[];
        detectedAt: number;
        source: string | null;
        winnerSurface?: SessionSurfaceTag;
        loserSurface?: SessionSurfaceTag;
        raceWindowMs?: number;
        fieldName?: string;
      };
    }
  | { channel: 'cloud:session-tombstoned'; payload: SessionTombstone };

export type BreadcrumbInput = {
  category: 'continuity.conflict' | 'continuity.continuity-state' | 'continuity.session-merge';
  level: 'info' | 'warning' | 'error';
  message: string;
  data: Record<string, unknown>;
};

export interface CloudSessionEffectSink {
  emit(event: CloudBroadcast): void;
  breadcrumb(breadcrumb: BreadcrumbInput): void;
  appendDiagnosticEvent?: (event: DiagnosticEventEmitInput) => void;
}

export interface CloudSessionMergeDeps {
  getSession: (id: string) => Promise<AgentSession | null>;
  upsertSession: (session: AgentSession) => Promise<void>;
  /** Stage 3: delete intent is REQUIRED and declared at the call site. */
  deleteSession: (id: string, options: SessionDeleteOptions) => Promise<void>;
  getActiveTurnController?: (turnId: string) => AbortController | undefined;
  listSessions: () => unknown;
  readContinuityStateMap: () => Promise<ContinuityStateMap | null>;
}

export type CloudSessionPutOutcome =
  | { kind: 'persisted'; cloudUpdatedAt: number; serverSeq: number; changedFields: string[] }
  | {
      kind: 'tombstoned';
      raceDetected: boolean;
      tombstone: { sessionId: string; deletedAt: number; deletedBy: SessionDeletedBy };
      direction: string;
    };

export type TombstoneGateOutcome = Extract<CloudSessionPutOutcome, { kind: 'tombstoned' }>;

export type SessionEventsAppendEvent = AgentEvent & {
  turnId: string;
  seq?: number | null;
  clientOrdinal: number;
};

export type SessionEventsAppendArgs = {
  sessionId: string;
  baseSeq: number;
  events: SessionEventsAppendEvent[];
  messageDelta?: AgentSession['messages'];
  messageDeletes?: string[];
  _destructiveOps?: {
    truncateTurns?: string[];
    deleteEventIdentities?: string[];
  };
  idempotencyKey?: string;
  metadataPatch?: AgentSessionMetadataPatch;
  clientCloudUpdatedAt?: number;
  surface: SessionSurfaceTag;
  source: string;
  sink: CloudSessionEffectSink;
};

export type SessionEventsAppendOutcome =
  | { kind: 'applied'; appliedCount: number; appliedSeq: number[]; serverSeq: number; cloudUpdatedAt: number }
  | { kind: 'needs-reconcile'; serverSeq: number; cloudUpdatedAt: number }
  | { kind: 'needs-bootstrap'; sessionId: string }
  | { kind: 'invalid-seq'; offendingEventIds: string[]; serverSeq: number }
  | {
      kind: 'invalid-envelope';
      reason: 'missing-client-ordinal' | 'duplicate-client-ordinal';
      offendingEventCount?: number;
      offendingPair?: [string, string];
    }
  | TombstoneGateOutcome;

export type CloudSessionDeleteOutcome = {
  kind: 'deleted';
  tombstone: SessionTombstone;
};

export type CatchUpEventsOutcome =
  | { kind: 'tombstoned'; tombstone: SessionTombstone }
  | { kind: 'not_found' }
  | {
      kind: 'events';
      events: SequencedAgentEvent[];
      serverSeq: number;
      hasMore: boolean;
      messageDelta?: AgentSession['messages'];
      messageDeletes?: string[];
      destructiveOpsApplied?: DestructiveOpsApplied;
    };

export type DestructiveOpsApplied = {
  truncatedTurns: string[];
  deletedEventIdentities: string[];
};

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function parseSinceSeq(value: string | null): number | null {
  if (value === null) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

export function parseCatchUpLimit(value: string | null): number | null {
  if (value === null) return CATCH_UP_DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return null;
  return Math.min(parsed, CATCH_UP_MAX_LIMIT);
}

export function parseFiniteTimestamp(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

export function parseClientSeq(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) return null;
  return value;
}

export function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 8);
}

export function sanitizeIncomingSessionPayload(payload: Record<string, unknown>, sessionId: string): AgentSession {
  const sanitized: Record<string, unknown> = {
    ...payload,
    id: sessionId,
  };
  // Preserve updatedAt from the client — it reflects when the session was last
  // meaningfully modified (message sent, turn completed). The merge function uses
  // max(incoming, existing) which is correct. Server-side ordering uses the
  // separate cloudUpdatedAt field stamped by stampCloudUpdatedAt().
  // Previously stripping updatedAt caused the server to overwrite it with
  // Date.now(), making old sessions appear recently modified after cloud sync.
  delete sanitized['cloudUpdatedAt'];
  delete sanitized['upstreamSessionId'];
  return sanitized as unknown as AgentSession;
}

export function resolveWriteSourceFromBody(incomingRaw: Record<string, unknown>): string | null {
  const updatedBy = incomingRaw['updatedBy'];
  if (typeof updatedBy === 'string' && updatedBy.trim().length > 0) {
    return updatedBy.trim().toLowerCase();
  }
  const deletedBy = incomingRaw['deletedBy'];
  if (typeof deletedBy === 'string' && deletedBy.trim().length > 0) {
    return deletedBy.trim().toLowerCase();
  }
  return null;
}

export function summarizeConflictValue(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.slice(0, CONFLICT_TITLE_MAX_CHARS);
    return hashForBreadcrumb(normalized);
  }
  if (Array.isArray(value)) {
    return `array:${value.length}`;
  }
  if (typeof value === 'object') {
    return `object:${Object.keys(value).length}`;
  }
  return String(value);
}

export function buildConflictBreadcrumb(args: {
  conflictType: 'stale-metadata' | 'concurrent-edit' | 'surface-tiebreaker';
  sessionId: string;
  fields: string[];
  serverCloudUpdatedAt?: number;
  clientCloudUpdatedAt?: number | null;
  staleBy?: 'cloudUpdatedAt' | 'seq' | null;
  previousValue?: unknown;
  newValue?: unknown;
  source?: string;
  winnerSurface?: SessionSurfaceTag;
  loserSurface?: SessionSurfaceTag;
  raceWindowMs?: number;
  fieldName?: string;
}): { breadcrumb: BreadcrumbInput; broadcast: CloudBroadcast } {
  const data: Record<string, unknown> = {
    sessionIdHash: hashSessionId(args.sessionId),
    conflictType: args.conflictType,
    fields: args.fields,
  };
  if (typeof args.serverCloudUpdatedAt === 'number') data.serverCloudUpdatedAt = args.serverCloudUpdatedAt;
  if (typeof args.clientCloudUpdatedAt === 'number') data.clientCloudUpdatedAt = args.clientCloudUpdatedAt;
  if (args.clientCloudUpdatedAt === null) data.clientCloudUpdatedAt = null;
  if (args.staleBy) data.staleBy = args.staleBy;
  if (args.source) data.source = args.source;
  if (args.previousValue !== undefined) data.previousValue = summarizeConflictValue(args.previousValue);
  if (args.newValue !== undefined) data.newValue = summarizeConflictValue(args.newValue);
  if (args.winnerSurface) data.winnerSurface = args.winnerSurface;
  if (args.loserSurface) data.loserSurface = args.loserSurface;
  if (typeof args.raceWindowMs === 'number') data.raceWindowMs = args.raceWindowMs;
  if (args.fieldName) data.fieldName = args.fieldName;

  return {
    breadcrumb: {
      category: 'continuity.conflict',
      level: 'warning',
      message: args.conflictType,
      data,
    },
    broadcast: {
      channel: 'cloud:session-conflict',
      payload: {
        sessionId: args.sessionId,
        conflictType: args.conflictType,
        fields: args.fields,
        detectedAt: Date.now(),
        source: args.source ?? null,
        ...(args.winnerSurface ? { winnerSurface: args.winnerSurface } : {}),
        ...(args.loserSurface ? { loserSurface: args.loserSurface } : {}),
        ...(typeof args.raceWindowMs === 'number' ? { raceWindowMs: args.raceWindowMs } : {}),
        ...(args.fieldName ? { fieldName: args.fieldName } : {}),
      },
    },
  };
}

export function buildContinuityStateBreadcrumb(args: {
  sessionId: string;
  reason: string;
  direction?: string;
  level?: 'info' | 'warning' | 'error';
  tombstoneCount?: number;
  lastTombstoneSyncAt?: number;
}): BreadcrumbInput {
  const data: Record<string, unknown> = {
    sessionIdHash: hashSessionId(args.sessionId),
    reason: args.reason,
  };
  if (args.direction) data.direction = args.direction;
  if (typeof args.tombstoneCount === 'number') data.tombstoneCount = args.tombstoneCount;
  if (typeof args.lastTombstoneSyncAt === 'number') data.lastTombstoneSyncAt = args.lastTombstoneSyncAt;

  return {
    category: 'continuity.continuity-state',
    level: args.level ?? 'info',
    message: args.reason,
    data,
  };
}

function emitConflictViaSink(sink: CloudSessionEffectSink, args: Parameters<typeof buildConflictBreadcrumb>[0]): void {
  const { breadcrumb, broadcast } = buildConflictBreadcrumb(args);
  emitBreadcrumbViaSink(sink, breadcrumb);
  sink.emit(broadcast);
}

function emitBreadcrumbViaSink(sink: CloudSessionEffectSink, breadcrumb: BreadcrumbInput): void {
  sink.breadcrumb(breadcrumb);
  sink.appendDiagnosticEvent?.(toDiagnosticContinuityTransition({
    family: 'merge',
    category: breadcrumb.category,
    level: breadcrumb.level,
    message: breadcrumb.message,
    data: breadcrumb.data,
  }));
}

/**
 * Stage 0.C — apply the desktop-as-tiebreaker resolver to every field involved
 * in a concurrent-edit race, emit a `surface-tiebreaker` audit breadcrumb when
 * the tiebreaker actually fires, and return the (possibly reverted) merged
 * session. Shared between `processSessionPut` (full-session PUT) and
 * `processSessionEventsAppend` (PATCH metadata + delta append) so the
 * invariant holds on every primary write path.
 *
 * The breadcrumb is emitted ONLY when `tiebreaker.reason === 'within-race-window'`.
 * Outside-window resolutions are just normal ordering; ineligible-field
 * resolutions are no-ops. Emitting in those cases would pollute diagnostics
 * with false "surface tiebreaker applied" claims.
 */
function applyDesktopSurfaceTiebreaker(args: {
  sink: CloudSessionEffectSink;
  sessionId: string;
  surface: SessionSurfaceTag;
  source: string;
  existing: AgentSession;
  merged: AgentSession;
  concurrentConflict: ConcurrentMetadataConflictResult;
  now: number;
}): AgentSession {
  const { sink, sessionId, surface, source, existing, merged, concurrentConflict, now } = args;
  if (!concurrentConflict.hasConflict) return merged;

  const mergedRecord = { ...(merged as unknown as Record<string, unknown>) };
  const existingRecord = existing as unknown as Record<string, unknown>;

  for (const fieldConflict of concurrentConflict.fieldConflicts) {
    const hasDesktopWriter = surface === 'desktop' || fieldConflict.priorSurface === 'desktop';
    const bothDesktop = surface === 'desktop' && fieldConflict.priorSurface === 'desktop';
    if (!hasDesktopWriter || bothDesktop) continue;

    const desktopIsCurrentWriter = surface === 'desktop';
    const currentValue = mergedRecord[fieldConflict.field];
    const tiebreaker = conflictDetector.resolveSurfaceTiebreaker({
      sessionId,
      field: fieldConflict.field,
      desktopWrite: desktopIsCurrentWriter
        ? { changedAt: now, value: currentValue }
        : { changedAt: fieldConflict.priorChangedAt, value: fieldConflict.previousValue },
      otherWrite: desktopIsCurrentWriter
        ? {
            surface: fieldConflict.priorSurface,
            changedAt: fieldConflict.priorChangedAt,
            value: fieldConflict.previousValue,
          }
        : {
            surface,
            changedAt: now,
            value: currentValue,
          },
      now,
    });

    if (tiebreaker.reason !== 'within-race-window') continue;

    if (tiebreaker.winner === 'desktop' && !desktopIsCurrentWriter) {
      mergedRecord[fieldConflict.field] = existingRecord[fieldConflict.field];
      conflictDetector.setRecentWriteForField({
        sessionId,
        field: fieldConflict.field,
        changedAt: fieldConflict.priorChangedAt,
        source: fieldConflict.priorSource,
        surface: fieldConflict.priorSurface,
      });
    }

    const loserSurface: SessionSurfaceTag = desktopIsCurrentWriter
      ? fieldConflict.priorSurface
      : surface;

    emitConflictViaSink(sink, {
      conflictType: 'surface-tiebreaker',
      sessionId,
      fields: [fieldConflict.field],
      winnerSurface: 'desktop',
      loserSurface,
      raceWindowMs: SURFACE_TIEBREAKER_RACE_WINDOW_MS,
      fieldName: fieldConflict.field,
      source,
    });
  }

  return mergedRecord as unknown as AgentSession;
}

/**
 * Observability for the silent multi-device "resurrection" vector: a cloud merge
 * that clears a locally-set `doneAt` (Done → Active) with no surfaced signal.
 * The surface-tiebreaker only protects a field within the 100ms race window;
 * outside it, an incoming PUT/patch carrying `doneAt: null` overwrites a local
 * Done and the conversation silently reappears in Active (260618 diagnosis
 * follow-up — see docs-private/postmortems/260618_staged_failure_notice_…).
 *
 * This does NOT change merge behaviour — a legitimate cross-device reopen MUST
 * still sync — it only makes the transition DETECTABLE (structured warn +
 * breadcrumb) so a reported "my Done conversation came back" is diagnosable
 * instead of invisible. Whether cloud should ever clear a local Done at all is a
 * separate product/semantics decision, deliberately not taken here.
 *
 * Call AFTER the tiebreaker on each primary write path, comparing the original
 * `existing` against the FINAL `merged`: a tiebreaker-reverted clear restores
 * `merged.doneAt`, so it is correctly NOT reported.
 */
function reportDoneClearedByMerge(args: {
  sink: CloudSessionEffectSink;
  sessionId: string;
  surface: SessionSurfaceTag;
  source: string;
  existing: AgentSession | null;
  merged: AgentSession;
}): void {
  const { sink, sessionId, surface, source, existing, merged } = args;
  // `existing` is null on a PUT that creates a brand-new session — no prior
  // `doneAt` to clear, so nothing to report.
  if (!existing) return;
  if (!isSessionDone(existing) || !isSessionActive(merged)) return;
  const sessionIdHash = hashForBreadcrumb(sessionId);
  sessionMergeLog.warn(
    {
      sessionIdHash,
      surface,
      source,
      clearedDoneAt: existing.doneAt,
      tiebreakerWindowMs: SURFACE_TIEBREAKER_RACE_WINDOW_MS,
    },
    'lifecycle-done-cleared-by-cloud-merge',
  );
  sink.breadcrumb({
    category: 'continuity.session-merge',
    level: 'warning',
    message: 'lifecycle-done-cleared-by-cloud-merge',
    data: { sessionIdHash, surface, source },
  });
}

type DestructiveOpsLedgerEntry =
  | { op: 'truncateTurn'; target: string; appliedAt: number }
  | { op: 'deleteEventIdentity'; target: string; appliedAt: number };

type MutableAppendSession = AgentSession & {
  _deletedMessages?: Record<string, number>;
  _destructiveOpsLedger?: DestructiveOpsLedgerEntry[];
};

type IdempotencyCacheableOutcome = Extract<
  SessionEventsAppendOutcome,
  { kind: 'applied' | 'needs-reconcile' | 'invalid-seq' }
>;

type SessionEventsAppendIdempotencyEntry = {
  payloadHash: string;
  outcome: IdempotencyCacheableOutcome;
  expiresAt: number;
};

const sessionEventsAppendIdempotencyCache = new Map<string, SessionEventsAppendIdempotencyEntry>();

let sessionEventsAppendIdempotencyCleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureSessionEventsAppendIdempotencyCleanupTimer(): void {
  if (sessionEventsAppendIdempotencyCleanupTimer) return;
  sessionEventsAppendIdempotencyCleanupTimer = setInterval(() => {
    pruneSessionEventsAppendIdempotencyCache(Date.now());
  }, 5 * 60_000);
  sessionEventsAppendIdempotencyCleanupTimer.unref?.();
}

function pruneSessionEventsAppendIdempotencyCache(now: number): void {
  for (const [key, entry] of sessionEventsAppendIdempotencyCache) {
    if (entry.expiresAt <= now) {
      sessionEventsAppendIdempotencyCache.delete(key);
    }
  }

  while (sessionEventsAppendIdempotencyCache.size > SESSION_EVENTS_APPEND_IDEMPOTENCY_MAX_ENTRIES) {
    const oldestKey = sessionEventsAppendIdempotencyCache.keys().next().value;
    if (typeof oldestKey !== 'string') return;
    sessionEventsAppendIdempotencyCache.delete(oldestKey);
  }
}

function getSessionEventsAppendIdempotencyCacheKey(sessionId: string, idempotencyKey: string): string {
  return `${sessionId}:${idempotencyKey}`;
}

function stableSerialize(value: unknown): string {
  if (value === undefined) return '"__undefined__"';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? '"__undefined__"';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableSerialize(record[key])}`
  )).join(',')}}`;
}

function hashSessionEventsAppendPayload(args: SessionEventsAppendArgs): string {
  return createHash('sha256').update(stableSerialize({
    baseSeq: args.baseSeq,
    events: args.events,
    messageDelta: args.messageDelta,
    messageDeletes: args.messageDeletes,
    _destructiveOps: args._destructiveOps,
    metadataPatch: args.metadataPatch,
    clientCloudUpdatedAt: args.clientCloudUpdatedAt,
  })).digest('hex');
}

function readSessionEventsAppendIdempotencyCache(args: {
  sessionId: string;
  idempotencyKey?: string;
  payloadHash: string;
}): IdempotencyCacheableOutcome | null {
  if (!args.idempotencyKey) return null;
  ensureSessionEventsAppendIdempotencyCleanupTimer();
  const now = Date.now();
  pruneSessionEventsAppendIdempotencyCache(now);
  const cacheKey = getSessionEventsAppendIdempotencyCacheKey(args.sessionId, args.idempotencyKey);
  const entry = sessionEventsAppendIdempotencyCache.get(cacheKey);
  if (!entry) return null;
  if (entry.payloadHash !== args.payloadHash) {
    throw Object.assign(new Error('Idempotency key reused with a different session events append payload'), {
      code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
    });
  }
  return entry.outcome;
}

function writeSessionEventsAppendIdempotencyCache(args: {
  sessionId: string;
  idempotencyKey?: string;
  payloadHash: string;
  outcome: SessionEventsAppendOutcome;
}): void {
  if (!args.idempotencyKey) return;
  if (
    args.outcome.kind !== 'applied'
    && args.outcome.kind !== 'needs-reconcile'
    && args.outcome.kind !== 'invalid-seq'
  ) return;
  ensureSessionEventsAppendIdempotencyCleanupTimer();
  sessionEventsAppendIdempotencyCache.set(
    getSessionEventsAppendIdempotencyCacheKey(args.sessionId, args.idempotencyKey),
    {
      payloadHash: args.payloadHash,
      outcome: args.outcome,
      expiresAt: Date.now() + SESSION_EVENTS_APPEND_IDEMPOTENCY_TTL_MS,
    },
  );
  pruneSessionEventsAppendIdempotencyCache(Date.now());
}

function getClientOrdinal(event: SessionEventsAppendEvent | AgentEvent): number | null {
  const clientOrdinal = (event as { clientOrdinal?: unknown }).clientOrdinal;
  return typeof clientOrdinal === 'number' && Number.isInteger(clientOrdinal) && clientOrdinal >= 0
    ? clientOrdinal
    : null;
}

function getEventFallbackIdentity(turnId: string, event: AgentEvent): EventIdentity {
  const timestamp = event.timestamp ?? '';
  const clientOrdinal = getClientOrdinal(event);
  const base = `${turnId}:type:${event.type}:ts:${timestamp}`;
  return clientOrdinal === null ? base : `${base}:ord:${clientOrdinal}`;
}

function getIncomingUnstampedIdentity(event: SessionEventsAppendEvent): EventIdentity {
  return getEventFallbackIdentity(event.turnId, event);
}

function getStoredEventIdentities(turnId: string, event: AgentEvent): EventIdentity[] {
  const primary = getEventIdentity(turnId, event);
  const fallback = getEventFallbackIdentity(turnId, event);
  return primary === fallback ? [primary] : [primary, fallback];
}

function buildExistingEventIdentityMap(session: AgentSession): Map<EventIdentity, AgentEvent> {
  const eventByIdentity = new Map<EventIdentity, AgentEvent>();
  for (const [turnId, events] of Object.entries(session.eventsByTurn ?? {})) {
    for (const event of events) {
      for (const identity of getStoredEventIdentities(turnId, event)) {
        if (!eventByIdentity.has(identity)) {
          eventByIdentity.set(identity, event);
        }
      }
    }
  }
  return eventByIdentity;
}

function validateSessionEventsAppendEvents(
  events: SessionEventsAppendEvent[],
  serverSeq: number,
): Extract<SessionEventsAppendOutcome, { kind: 'invalid-seq' | 'invalid-envelope' }> | null {
  const identities = new Map<EventIdentity, string>();
  const offendingEventIds: string[] = [];
  let missingClientOrdinalCount = 0;
  for (const event of events) {
    if (event.seq !== undefined && event.seq !== null) {
      offendingEventIds.push(getEventIdentity(event.turnId, event));
    }
    if (getClientOrdinal(event) === null) {
      missingClientOrdinalCount += 1;
      continue;
    }
    const identity = getIncomingUnstampedIdentity(event);
    const previous = identities.get(identity);
    if (previous) {
      return {
        kind: 'invalid-envelope',
        reason: 'duplicate-client-ordinal',
        offendingPair: [previous, identity],
      };
    }
    identities.set(identity, identity);
  }
  if (offendingEventIds.length > 0) {
    return { kind: 'invalid-seq', offendingEventIds, serverSeq };
  }
  if (missingClientOrdinalCount > 0) {
    return {
      kind: 'invalid-envelope',
      reason: 'missing-client-ordinal',
      offendingEventCount: missingClientOrdinalCount,
    };
  }
  return null;
}

function groupStampedEventsByTurn(args: {
  sessionId: string;
  events: SessionEventsAppendEvent[];
  existingEventByIdentity: Map<EventIdentity, AgentEvent>;
}): { incomingEventsByTurn: Record<string, AgentEvent[]>; appliedSeq: number[] } {
  const seqIndex = getSessionSeqIndex();
  const incomingEventsByTurn: Record<string, AgentEvent[]> = {};
  const appliedSeq: number[] = [];

  for (const event of args.events) {
    const existingEvent = args.existingEventByIdentity.get(getIncomingUnstampedIdentity(event));
    const existingSeq = existingEvent && isValidSeq(existingEvent.seq) ? existingEvent.seq : null;
    if (existingSeq !== null) {
      appliedSeq.push(existingSeq);
      continue;
    }

    const { turnId, ...eventWithoutTurnId } = event;
    const seq = seqIndex.nextSeq(args.sessionId);
    // eslint-disable-next-line no-restricted-syntax -- validated SessionEventsAppendEvent envelope is AgentEvent-compatible after removing transport-only turnId/clientOrdinal and stamping seq
    const stampedEvent = {
      ...eventWithoutTurnId,
      seq,
    } as AgentEvent;
    incomingEventsByTurn[turnId] = [...(incomingEventsByTurn[turnId] ?? []), stampedEvent];
    appliedSeq.push(seq);
  }

  return { incomingEventsByTurn, appliedSeq };
}

function hasIncomingExistingCollision(session: AgentSession, events: SessionEventsAppendEvent[]): boolean {
  const existingEventByIdentity = buildExistingEventIdentityMap(session);
  return events.some((event) => existingEventByIdentity.has(getIncomingUnstampedIdentity(event)));
}

function applyDestructiveOps(args: {
  session: MutableAppendSession;
  ops: SessionEventsAppendArgs['_destructiveOps'];
  sink: CloudSessionEffectSink;
  sessionId: string;
}): void {
  if (!args.ops) return;
  const eventsByTurn = { ...(args.session.eventsByTurn ?? {}) };
  const ledger = [...(args.session._destructiveOpsLedger ?? [])];

  for (const turnId of args.ops.truncateTurns ?? []) {
    const appliedAt = getServerNow();
    eventsByTurn[turnId] = [];
    ledger.push({ op: 'truncateTurn', target: turnId, appliedAt });
    emitBreadcrumbViaSink(args.sink, {
      category: 'continuity.session-merge',
      level: 'warning',
      message: 'session-delta-push:destructive-op-applied',
      data: {
        op: 'truncateTurn',
        sessionIdHash: hashForBreadcrumb(args.sessionId),
        turnIdHash: hashForBreadcrumb(turnId),
      },
    });
  }

  for (const identity of args.ops.deleteEventIdentities ?? []) {
    const appliedAt = getServerNow();
    for (const [turnId, events] of Object.entries(eventsByTurn)) {
      eventsByTurn[turnId] = events.filter((event) => !getStoredEventIdentities(turnId, event).includes(identity));
    }
    ledger.push({ op: 'deleteEventIdentity', target: identity, appliedAt });
    emitBreadcrumbViaSink(args.sink, {
      category: 'continuity.session-merge',
      level: 'warning',
      message: 'session-delta-push:destructive-op-applied',
      data: {
        op: 'deleteEventIdentity',
        sessionIdHash: hashForBreadcrumb(args.sessionId),
        identityHash: hashForBreadcrumb(identity),
      },
    });
  }

  args.session.eventsByTurn = eventsByTurn;
  args.session._destructiveOpsLedger = ledger;
}

function applyMessageDeletes(session: MutableAppendSession, messageDeletes: string[] | undefined): void {
  if (!messageDeletes || messageDeletes.length === 0) return;
  const deletedIds = new Set(messageDeletes);
  const deletedMessages = { ...(session._deletedMessages ?? {}) };
  const deletedAt = getServerNow();
  for (const id of deletedIds) {
    deletedMessages[id] = deletedAt;
  }
  session.messages = (session.messages ?? []).filter((message) => {
    if (!deletedIds.has(message.id)) return true;
    (message as typeof message & { deletedAt?: number }).deletedAt = deletedAt;
    return false;
  });
  session._deletedMessages = deletedMessages;
}

function applyMessageDelta(args: {
  session: MutableAppendSession;
  messageDelta: AgentSession['messages'] | undefined;
  sink: CloudSessionEffectSink;
  sessionId: string;
}): void {
  if (!args.messageDelta || args.messageDelta.length === 0) return;
  args.session.messages = deduplicateMessages(args.session.messages ?? [], args.messageDelta, 'authoritative-wins');
  if (!args.session._deletedMessages) return;
  for (const message of args.messageDelta) {
    if (args.session._deletedMessages[message.id] === undefined) continue;
    delete args.session._deletedMessages[message.id];
    emitBreadcrumbViaSink(args.sink, {
      category: 'continuity.session-merge',
      level: 'info',
      message: 'session-delta-push:message-delete-rescinded',
      data: {
        sessionIdHash: hashForBreadcrumb(args.sessionId),
        messageIdHash: hashForBreadcrumb(message.id),
      },
    });
  }
}

function applyMetadataPatch(args: {
  session: AgentSession;
  patch: AgentSessionMetadataPatch | undefined;
  surface: SessionSurfaceTag;
}): AgentSession {
  if (!args.patch || Object.keys(args.patch).length === 0) return args.session;
  const allowed = new Set<string>(AGENT_SESSION_METADATA_PATCH_KEYS);
  const sanitizedPatch = Object.fromEntries(
    Object.entries(args.patch).filter(([key]) => allowed.has(key)),
  ) as AgentSessionMetadataPatch;
  const { draft, finishLine, ...patchWithoutNullables } = sanitizedPatch;
  const finishLineHasOwn = Object.prototype.hasOwnProperty.call(sanitizedPatch, 'finishLine');
  // `draft` does not yet distinguish absent-from-present-but-undefined here;
  // existing semantics are preserved pending a separate cleanup. `finishLine`
  // adopts the correct nullable-patch contract: absent = preserve, null = clear,
  // string = set.
  const normalizedPatch: Partial<Pick<
    AgentSession,
    'title' | 'doneAt' | 'starredAt' | 'deletedAt' | 'privateMode' | 'draft' | 'resolvedAt' | 'finishLine'
  >> = {
    ...patchWithoutNullables,
    ...(draft !== null ? { draft } : { draft: undefined }),
    ...(finishLineHasOwn
      ? finishLine === null
        ? { finishLine: undefined }
        : { finishLine }
      : {}),
  };
  const titleChanged = normalizedPatch.title !== undefined && normalizedPatch.title !== args.session.title;
  return {
    ...args.session,
    ...normalizedPatch,
    ...(titleChanged && args.surface !== 'desktop'
      ? { autoTitleGeneratedAt: undefined, autoTitleTurnCount: undefined }
      : {}),
  };
}

function getEventTimestampAtOrBeforeSeq(session: AgentSession, sinceSeq: number): number {
  let timestamp = 0;
  for (const events of Object.values(session.eventsByTurn ?? {})) {
    for (const event of events) {
      if (!isPositiveInteger(event.seq) || event.seq > sinceSeq) continue;
      if (typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)) {
        timestamp = Math.max(timestamp, event.timestamp);
      }
    }
  }
  return timestamp;
}

function getMessageCreatedAt(message: AgentSession['messages'][number]): number {
  return typeof message.createdAt === 'number' && Number.isFinite(message.createdAt)
    ? message.createdAt
    : 0;
}

export function getCatchUpAuxiliaryPayload(session: AgentSession, sinceSeq: number): {
  messageDelta: AgentSession['messages'];
  messageDeletes: string[];
  destructiveOpsApplied: DestructiveOpsApplied;
} {
  const serverSeq = getMaxSeqFromSession(session);
  const sinceClock = sinceSeq > 0 && sinceSeq < serverSeq
    ? getEventTimestampAtOrBeforeSeq(session, sinceSeq)
    : 0;
  const messageDelta = sinceSeq >= serverSeq
    ? []
    : (session.messages ?? []).filter((message) => getMessageCreatedAt(message) > sinceClock);
  const messageDeletes = Object.entries(session._deletedMessages ?? {})
    .filter(([, deletedAt]) => typeof deletedAt === 'number' && Number.isFinite(deletedAt) && deletedAt > sinceClock)
    .map(([id]) => id);
  const destructiveOpsApplied = (session._destructiveOpsLedger ?? [])
    .filter((entry) => entry.appliedAt > sinceClock)
    .reduce<DestructiveOpsApplied>((acc, entry) => {
      if (entry.op === 'truncateTurn') {
        acc.truncatedTurns.push(entry.target);
      } else {
        acc.deletedEventIdentities.push(entry.target);
      }
      return acc;
    }, { truncatedTurns: [], deletedEventIdentities: [] });

  return { messageDelta, messageDeletes, destructiveOpsApplied };
}

export function getSequencedEventsSince(session: AgentSession, sinceSeq: number): {
  events: SequencedAgentEvent[];
  serverSeq: number;
} {
  const events: SequencedAgentEvent[] = [];

  for (const [turnId, turnEvents] of Object.entries(session.eventsByTurn ?? {})) {
    for (const event of turnEvents) {
      if (!isPositiveInteger(event.seq)) continue;
      if (event.seq <= sinceSeq) continue;
      events.push({ ...event, turnId } as SequencedAgentEvent);
    }
  }

  events.sort((a, b) => {
    if (a.seq !== b.seq) return a.seq - b.seq;
    return a.timestamp - b.timestamp;
  });

  return {
    events,
    serverSeq: getMaxSeqFromSession(session),
  };
}

export function toCloudSummary(summary: AgentSessionSummary): CloudSessionSummary {
  const origin = CLOUD_VALID_ORIGINS.has(summary.origin as CloudSessionSummary['origin'])
    ? (summary.origin as CloudSessionSummary['origin'])
    : 'manual';

  return {
    id: summary.id,
    title: summary.title,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    ...(typeof summary.cloudUpdatedAt === 'number' ? { cloudUpdatedAt: summary.cloudUpdatedAt } : {}),
    resolvedAt: summary.resolvedAt,
    // Canonical lifecycle field carried onto the cross-surface DTO.
    doneAt: summary.doneAt ?? null,
    starredAt: summary.starredAt ?? null,
    deletedAt: summary.deletedAt ?? null,
    origin,
    isCorrupted: summary.isCorrupted,
    privateMode: summary.privateMode,
    interruptedTurnId: summary.interruptedTurnId,
    preview: summary.preview,
    firstMessagePreview: summary.firstMessagePreview,
    lastMessagePreview: summary.lastMessagePreview,
    messageCount: summary.messageCount,
    hasDraft: summary.hasDraft,
    draftPreview: summary.draftPreview,
    draftUpdatedAt: summary.draftUpdatedAt,
    usage: {
      costUsd: summary.usage.costUsd,
      inputTokens: summary.usage.inputTokens,
      outputTokens: summary.usage.outputTokens,
      turnCount: summary.usage.turnCount,
    },
    activeTurnId: summary.activeTurnId,
    isBusy: summary.isBusy,
    ...(summary.lastActivityAt === undefined ? {} : { lastActivityAt: summary.lastActivityAt }),
    lastError: summary.lastError,
    ...(typeof summary.maxSeq === 'number' ? { maxSeq: summary.maxSeq } : {}),
    meetingCompanion: summary.meetingCompanion,
  };
}

export function getSessionOrderTimestamp(summary: { updatedAt?: number; cloudUpdatedAt?: number }): number {
  return typeof summary.cloudUpdatedAt === 'number' && Number.isFinite(summary.cloudUpdatedAt)
    ? summary.cloudUpdatedAt
    : (summary.updatedAt ?? 0);
}

export function truncateToolDetail(detail: string): string {
  if (detail.length <= MAX_TOOL_EVENT_DETAIL_CHARS) return detail;
  return detail.slice(0, MAX_TOOL_EVENT_DETAIL_CHARS);
}

function truncateForLeanMcpAppUiMeta(args: {
  meta: McpAppUiMeta;
  turnId: string;
  toolUseId?: string;
  toolName: string;
}): McpAppUiMeta {
  let nextMeta = args.meta;
  let truncated = false;
  const truncatedFields: string[] = [];
  let originalLength: number | undefined;
  let truncatedLength: number | undefined;
  const kind = nextMeta.structuredFallback?.kind;

  if (
    typeof nextMeta.viewSummary === 'string' &&
    nextMeta.viewSummary.length > STRUCTURED_TOOL_MAX_CHARS
  ) {
    originalLength = nextMeta.viewSummary.length;
    const truncatedViewSummary = nextMeta.viewSummary.slice(0, STRUCTURED_TOOL_MAX_CHARS);
    nextMeta = {
      ...nextMeta,
      viewSummary: truncatedViewSummary,
    };
    truncatedLength = truncatedViewSummary.length;
    truncated = true;
    truncatedFields.push('viewSummary');
  }

  if (
    nextMeta.structuredFallback?.kind === 'email-draft' &&
    nextMeta.structuredFallback.payload.body.length > STRUCTURED_TOOL_MAX_CHARS
  ) {
    originalLength = nextMeta.structuredFallback.payload.body.length;
    const truncatedBody = nextMeta.structuredFallback.payload.body.slice(0, STRUCTURED_TOOL_MAX_CHARS);
    nextMeta = {
      ...nextMeta,
      structuredFallback: {
        ...nextMeta.structuredFallback,
        payload: {
          ...nextMeta.structuredFallback.payload,
          body: truncatedBody,
        },
      },
    };
    truncatedLength = truncatedBody.length;
    truncated = true;
    truncatedFields.push('structuredFallback.payload.body');
  }

  if (truncated) {
    sessionMergeLog.debug(
      {
        turnId: args.turnId,
        toolName: args.toolName,
        toolUseId: args.toolUseId,
        maxChars: STRUCTURED_TOOL_MAX_CHARS,
        truncatedFields,
        originalLength,
        truncatedLength,
        kind,
      },
      'Truncated MCP App UI metadata for lean cloud session DTO'
    );
  }

  return nextMeta;
}

export function filterLeanEventsByTurn(eventsByTurn: Record<string, AgentEvent[]> | undefined): Record<string, LeanSessionEvent[]> {
  if (!eventsByTurn) return {};

  const filtered: Record<string, LeanSessionEvent[]> = {};

  for (const [turnId, events] of Object.entries(eventsByTurn)) {
    const leanEvents: LeanSessionEvent[] = [];
    const toolEvents = events
      .filter((event): event is Extract<AgentEvent, { type: 'tool' }> => event.type === 'tool')
      .map((event) => {
        const rawDetail = typeof event.detail === 'string' ? event.detail : '';
        const detail = STRUCTURED_TOOL_NAMES.has(event.toolName)
          ? rawDetail.slice(0, STRUCTURED_TOOL_MAX_CHARS)
          : truncateToolDetail(rawDetail);

        const leanEvent: LeanToolEvent = {
          type: 'tool' as const,
          toolName: event.toolName,
          detail,
          stage: event.stage,
          isError: event.isError,
          toolUseId: event.toolUseId,
          parentToolUseId: event.parentToolUseId,
          timestamp: event.timestamp,
        };

        if (event.mcpAppUiMeta) {
          leanEvent.mcpAppUiMeta = truncateForLeanMcpAppUiMeta({
            meta: event.mcpAppUiMeta,
            turnId,
            toolName: event.toolName,
            toolUseId: event.toolUseId,
          });
        }

        if (Array.isArray(event.imageRef) && event.imageRef.length > 0) {
          leanEvent.imageRef = event.imageRef;
        }

        if (Array.isArray(event.contentRef) && event.contentRef.length > 0) {
          leanEvent.contentRef = event.contentRef as LeanToolEvent['contentRef'];
        }

        if (Array.isArray(event.imageContent) && event.imageContent.length > 0) {
          const imageContent = event.imageContent
            .filter((block): block is { type: 'image'; data: string; mimeType: string } => (
              block.type === 'image'
              && typeof block.data === 'string'
              && typeof block.mimeType === 'string'
            ))
            .map((block) => ({
              type: 'image' as const,
              data: block.data,
              mimeType: block.mimeType,
            }));

          if (imageContent.length > 0) {
            leanEvent.imageContent = imageContent;
          }
        }

        if (event.toolResult) {
          leanEvent.toolResult = event.toolResult;
        }

        return sanitizeToolImagePayloadForRefs(leanEvent);
      });

    const totalImageBytes = toolEvents.reduce((sum, event) => {
      if (!event.imageContent) return sum;
      return sum + event.imageContent.reduce((imageSum, image) => imageSum + image.data.length, 0);
    }, 0);

    if (totalImageBytes > MAX_TURN_IMAGE_BYTES) {
      const toolNames = Array.from(new Set(
        toolEvents
          .filter((event) => event.imageContent && event.imageContent.length > 0)
          .map((event) => event.toolName),
      ));

      // TODO(continuity-core): switch this moved warning to createScopedLogger;
      // keep the [sessions] prefix for existing log-grep tooling until that audit lands.
      console.warn(
        `[sessions] Dropping imageContent for turn ${turnId}: ${totalImageBytes} bytes exceeds ${MAX_TURN_IMAGE_BYTES} bytes (tools: ${toolNames.join(', ') || 'unknown'})`,
      );

      leanEvents.push(...toolEvents.map(({ imageContent: _imageContent, ...event }) => event));
    } else {
      leanEvents.push(...toolEvents);
    }

    // Pass user-question events through unchanged — they are small, have no
    // imageContent, and are required client-side to rehydrate the answered
    // state after a force-quit (Stage 7 cross-session rehydration).
    for (const event of events) {
      if (event.type === 'user_question' || event.type === 'user_question_answered') {
        leanEvents.push(event);
      }
    }

    if (leanEvents.length > 0) {
      filtered[turnId] = leanEvents;
    }
  }

  return filtered;
}

export function projectSessionForRead(
  session: AgentSession,
  options: { lean: boolean; toolEvents: boolean },
): AgentSession | (Omit<AgentSession, 'eventsByTurn'> & { eventsByTurn?: Record<string, LeanSessionEvent[]> }) {
  if (!options.lean) return session;
  if (options.toolEvents) {
    const { eventsByTurn, ...lean } = session;
    return {
      ...lean,
      eventsByTurn: filterLeanEventsByTurn(eventsByTurn),
    };
  }
  const { eventsByTurn: _eventsByTurn, ...lean } = session;
  return lean;
}

// ---------------------------------------------------------------------------
// Desktop → Cloud session merge
// ---------------------------------------------------------------------------

/**
 * Merge an incoming desktop push into the existing cloud session.
 *
 * Direction-specific: desktop is authoritative for metadata and turns it owns.
 * Cloud-only turns (from mobile/web) are preserved. In-progress cloud turns
 * are protected from overwrite.
 */
export function mergeDesktopPushIntoCloud(
  existing: AgentSession,
  incoming: AgentSession,
  isTurnActive?: (turnId: string) => boolean,
  options: {
    sessionIdHash?: string;
    onEventOverwritePrevented?: (details: EventOverwritePreventedDetails) => void;
  } = {},
): AgentSession {
  const existingEvents = existing.eventsByTurn ?? {};
  const incomingEvents = incoming.eventsByTurn ?? {};
  const incomingTurnIds = getKnownTurnIds(incoming);

  // Events: append-only by identity; cloud wins collisions, incoming-only appends.
  const mergedEvents: Record<string, AgentEvent[]> = mergeEventsForCloudPush(existingEvents, incomingEvents, options);

  // Projection-owned scalar reconciliation. We may preserve an in-flight cloud
  // turn's event stream, but the busy scalars are always derived from events.
  let mergedDeclaredActiveTurnId = incoming.activeTurnId;
  const controllerTurnActive = existing.activeTurnId && isTurnActive
    ? isTurnActive(existing.activeTurnId)
    : undefined;
  // If no controller signal is available (reloaded/crashed/cross-surface), we
  // fall back to the event-heartbeat stale window in deriveTurnLiveness().

  if (existing.isBusy && existing.activeTurnId) {
    const turnEvents = existingEvents[existing.activeTurnId];
    const hasProjectionLiveTurn = Boolean(turnEvents) && !hasTerminalEvent(turnEvents);
    const controllerAllowsPreserve = controllerTurnActive ?? true;

    if (hasProjectionLiveTurn && controllerAllowsPreserve) {
      // Preserve cloud-only active-turn events as reconciliation input.
      mergedDeclaredActiveTurnId = existing.activeTurnId;
      mergedEvents[existing.activeTurnId] = turnEvents;
      sessionMergeLog.info({
        sessionId: incoming.id,
        activeTurnId: existing.activeTurnId,
      }, 'Preserved in-progress cloud turn during desktop push merge');
    }
  }

  const mergedLiveness = deriveTurnLiveness(mergedEvents, Date.now(), {
    declaredActiveTurnId: mergedDeclaredActiveTurnId,
  });
  let mergedScalars = toPersistedBusyScalars(mergedLiveness);

  const canSuppressStaleInterruptedWithController = controllerTurnActive === true &&
    existing.activeTurnId != null &&
    !hasTerminalEvent(mergedEvents[existing.activeTurnId]);
  if (canSuppressStaleInterruptedWithController && existing.activeTurnId) {
    // Direct controller liveness beats the 5-minute stale heuristic. A live turn
    // can legitimately go event-silent while waiting on long tool/model latency.
    mergedScalars = {
      isBusy: true,
      activeTurnId: existing.activeTurnId,
    };
  }

  if (
    controllerTurnActive === false &&
    incoming.activeTurnId == null &&
    mergedScalars.activeTurnId === existing.activeTurnId
  ) {
    mergedScalars = { isBusy: false, activeTurnId: null };
  }

  // Messages: dedup by id, incoming wins collisions, sort by createdAt.
  const mergedMessages = deduplicateMessages(existing.messages ?? [], incoming.messages ?? [], 'secondary-wins');

  // Title: incoming (desktop push) wins unless it's auto-overwritable and the
  // cloud (`existing`) has a real, non-fallback title.
  //
  // Use the SAME broad predicate (`isDefaultOrFallbackTitle`) that auto-title
  // *generation* eligibility uses — not the narrow exact-string `=== DEFAULT_SESSION_TITLE`
  // check, which only caught 'New conversation' and let a stale desktop push of
  // 'New Agent Run' / 'Conversation N' / a first-message fallback clobber a real
  // cloud-generated title (F1). A manual local rename (incoming is a real,
  // non-fallback title) still wins, as before.
  //
  // The auto-title metadata (autoTitleGeneratedAt/autoTitleTurnCount) always
  // travels WITH the winning title — keep cloud's when keeping cloud's title,
  // adopt incoming's when adopting incoming's. The `...incoming` spread below
  // would otherwise strand the cloud metadata even when the cloud title is kept,
  // breaking future auto-retitle.
  const incomingTitleAutoOverwritable = isDefaultOrFallbackTitle(
    incoming.title ?? '',
    incoming.messages ?? [],
  );
  const existingTitleIsReal =
    typeof existing.title === 'string' &&
    !isDefaultOrFallbackTitle(existing.title, existing.messages ?? []);
  const keepExistingTitle = incomingTitleAutoOverwritable && existingTitleIsReal;

  // Auto-title metadata travels with the winning title as ONE unit. When the two
  // title STRINGS are equal but only one side carries the metadata (e.g. the
  // renderer applied the cloud title to current-session state without the
  // metadata, then pushed), the title-policy winner alone would strand it. The
  // shared `resolveAutoTitleMetadata` rule repairs that: equal titles → take
  // whichever side has the metadata.
  const winningTitleSide = keepExistingTitle ? existing : incoming;
  const losingTitleSide = keepExistingTitle ? incoming : existing;
  const resolvedAutoTitleMetadata = resolveAutoTitleMetadata(winningTitleSide, losingTitleSide);

  // Log preserved cloud-only turns (diagnostic).
  const cloudOnlyTurnIds = Array.from(getKnownTurnIds(existing)).filter((t) => !incomingTurnIds.has(t));
  if (cloudOnlyTurnIds.length > 0) {
    sessionMergeLog.info({
      sessionId: incoming.id,
      turnIds: cloudOnlyTurnIds,
    }, 'Preserved cloud-only turns during desktop push merge');
  }

  return {
    ...incoming,
    messages: mergedMessages,
    eventsByTurn: mergedEvents,
    isBusy: mergedScalars.isBusy,
    activeTurnId: mergedScalars.activeTurnId,
    title: keepExistingTitle ? existing.title : incoming.title,
    // Auto-title metadata travels WITH the winning title as ONE unit (see
    // `resolveAutoTitleMetadata` above). The `...incoming` spread already carried
    // incoming's metadata; this overwrites it with the resolved metadata so the
    // cloud's is not stranded when the cloud title is kept, and an equal-title
    // merge never strands metadata that only one side has.
    autoTitleGeneratedAt: resolvedAutoTitleMetadata.autoTitleGeneratedAt,
    autoTitleTurnCount: resolvedAutoTitleMetadata.autoTitleTurnCount,
    updatedAt: deriveSessionUpdatedAt({
      messages: mergedMessages,
      createdAt: incoming.createdAt ?? existing.createdAt ?? 0,
      draft: incoming.draft,
      isBusy: mergedScalars.isBusy,
      updatedAt: Math.max(incoming.updatedAt ?? 0, existing.updatedAt ?? 0),
    }),
    cloudUpdatedAt: existing.cloudUpdatedAt,
    // Memory-update status (260619): async/sparse and produced on cloud-executed
    // turns, so a desktop push that lacks a turn's key must NOT drop the cloud's
    // (`existing`) status under mergePerTurnMap's authoritative-absence semantic.
    // Union with terminal-beats-running instead (stateful object values). Mirrors
    // the pull side (cloudRouterHelpers mergeMemoryStatusByTurn).
    memoryUpdateStatusByTurn: mergeMemoryStatusByTurn(
      incoming.memoryUpdateStatusByTurn,
      existing.memoryUpdateStatusByTurn,
    ),
    // Time-saved status stays primary-authoritative: desktop-only producer (not
    // wired in cloud-service), so the cloud never holds a value the incoming push
    // lacks for a shared turn.
    timeSavedStatusByTurn: mergePerTurnMap(
      incoming.timeSavedStatusByTurn,
      existing.timeSavedStatusByTurn,
      incomingTurnIds,
    ),
    // Per-turn AI activity summaries (260618 show-more-activity) are an ASYNC,
    // SPARSE artifact — unlike the sibling status maps above, "incoming knows
    // the turn but lacks this key" means "summary not generated/seen on the
    // pushing desktop yet", NOT "no summary". A shared turn where the cloud
    // (`existing`) generated the summary and the incoming desktop push lacks
    // that key would lose the cloud sentence under mergePerTurnMap's
    // authoritative-absence semantic (Failure Mode F2). Union by key instead: a
    // turn's summary survives if either side has it; incoming wins same-turn
    // conflicts.
    activitySummaryByTurn: unionPerTurnMap(
      incoming.activitySummaryByTurn,
      existing.activitySummaryByTurn,
    ),
    compactionBoundaries: incoming.compactionBoundaries,
    // Inbound-trigger sessions originate on the cloud surface; the desktop
    // push will not carry the externalContext so we must preserve the
    // cloud-side context across merges. Incoming wins only when it explicitly
    // sets a context (desktop adopting a new external link).
    externalContext: incoming.externalContext ?? existing.externalContext,
    // Origin: same reasoning. Desktop pushes default to `'manual'` for sessions
    // they don't recognise; that would flatten cloud-originated `inbound-trigger`
    // sessions back to manual. Prefer the incoming origin only when it's a
    // meaningful, non-default value, otherwise keep what the cloud already has.
    origin: incoming.origin && incoming.origin !== 'manual'
      ? incoming.origin
      : existing.origin ?? incoming.origin ?? 'manual',
  };
}

/**
 * Filter sessions for the `activeOnly` query parameter.
 * 1. Only active, non-deleted, non-background sessions (matches desktop's "Active" section)
 * 2. If a state map exists, only sessions explicitly marked cloud_active
 *
 * Exported for testing.
 */
export function filterActiveOnlySessions<T extends { id?: string; [key: string]: unknown }>(
  sessions: T[],
  stateMap: ContinuityStateMap | null,
): T[] {
  // Only active, non-deleted, non-background sessions — matches desktop's "Active" sidebar section.
  // Read lifecycle via the shared predicate (doneAt-based), never raw pinnedAt truthiness.
  let filtered = sessions.filter(
    (s) =>
      !s.deletedAt &&
      isSessionActive(s as { doneAt?: number | null }) &&
      !isBackgroundConversationSession(s.id ?? ''),
  );

  // Explicitly marked cloud_active in the continuity state map
  if (stateMap) {
    filtered = filtered.filter((s) => {
      const entry = s.id ? stateMap[s.id] : undefined;
      if (!entry) return false;
      return entry.state === 'cloud_active';
    });
  }

  return filtered;
}

export async function runUnderSessionMutexWithTombstoneGate<T>(
  sessionId: string,
  args: {
    surface: SessionSurfaceTag;
    sink: CloudSessionEffectSink;
    label: string;
  },
  fn: () => Promise<T>,
): Promise<T | TombstoneGateOutcome> {
  return sessionMutex.withLock(sessionId, async () => {
    const tombstoneStore = getSessionTombstoneStore();
    const tombstone = tombstoneStore.getTombstone(sessionId);
    if (tombstone) {
      const direction = args.surface === 'desktop' ? 'desktop-push-rejected' : `${args.surface}-write-rejected`;
      emitBreadcrumbViaSink(args.sink, buildContinuityStateBreadcrumb({
        sessionId,
        reason: 'tombstone-applied',
        direction,
      }));
      emitBreadcrumbViaSink(args.sink, buildContinuityStateBreadcrumb({
        sessionId,
        reason: 'tombstone-race-detected',
        direction,
        level: 'warning',
      }));
      return {
        kind: 'tombstoned' as const,
        raceDetected: true,
        tombstone: {
          sessionId: tombstone.sessionId,
          deletedAt: tombstone.deletedAt,
          deletedBy: tombstone.deletedBy,
        },
        direction,
      };
    }

    return fn();
  }, { label: args.label });
}

export async function commitMergedSession(
  deps: Pick<CloudSessionMergeDeps, 'upsertSession'>,
  args: { session: AgentSession },
): Promise<AgentSession & { cloudUpdatedAt: number }> {
  // Use the merge result's updatedAt (max of incoming and existing).
  // For new sessions without updatedAt, fall back to now.
  // Server-side ordering uses cloudUpdatedAt (stamped below), NOT updatedAt.
  // Previously overwriting updatedAt with Date.now() caused desktop sessions
  // to appear recently modified after cloud sync round-trips, jumping to the
  // top of the sidebar and triggering false "Edited elsewhere" badges.
  const mergedUpdatedAt = (typeof args.session.updatedAt === 'number' && args.session.updatedAt > 0)
    ? args.session.updatedAt
    : Date.now();
  const { cloudUpdatedAt: _clientCloudUpdatedAt, ...mergedWithoutCloudUpdatedAt } = args.session;
  const sessionForStamp = {
    ...mergedWithoutCloudUpdatedAt,
    updatedAt: mergedUpdatedAt,
  } as AgentSession;
  const stampedSession = stampCloudUpdatedAt(stampMissingEventSeq(sessionForStamp));

  // Atomicity note: cloud writes flow through deps.upsertSession() →
  // IncrementalSessionStore.upsertSession(), which uses atomically
  // write-to-temp + rename. The mutex guarantees per-session
  // read-modify-write serialization; store writes are crash-safe.
  await deps.upsertSession(stampedSession);
  return stampedSession;
}

export async function processSessionPut(
  deps: CloudSessionMergeDeps,
  args: {
    sessionId: string;
    incomingRaw: Record<string, unknown>;
    source: string;
    surface: SessionSurfaceTag;
    sink: CloudSessionEffectSink;
  },
): Promise<CloudSessionPutOutcome> {
  const clientCloudUpdatedAt = parseFiniteTimestamp(args.incomingRaw.cloudUpdatedAt);
  const incoming = sanitizeIncomingSessionPayload(args.incomingRaw, args.sessionId);
  const derivedClientSeq = getMaxSeqFromSession(incoming);
  const clientSeq = parseClientSeq(args.incomingRaw.maxSeq) ?? (derivedClientSeq > 0 ? derivedClientSeq : null);

  return runUnderSessionMutexWithTombstoneGate(args.sessionId, {
    surface: args.surface,
    sink: args.sink,
    label: 'sessions.put',
  }, async () => {
    const existing = await deps.getSession(args.sessionId);
    const isTurnActive = (turnId: string) => deps.getActiveTurnController?.(turnId) !== undefined;
    let merged = existing ? mergeDesktopPushIntoCloud(existing, incoming, isTurnActive, {
      sessionIdHash: hashForBreadcrumb(args.sessionId),
      onEventOverwritePrevented: (details) => {
        args.sink.breadcrumb({
          category: 'continuity.session-merge',
          level: 'warning',
          message: 'event-overwrite-prevented',
          data: {
            direction: 'cloud-push',
            sessionIdHash: hashForBreadcrumb(args.sessionId),
            turnIdHash: hashForBreadcrumb(details.turnId),
            identityHash: hashForBreadcrumb(details.identity),
            changedFields: details.diff.map((entry) => entry.field),
          },
        });
      },
    }) : incoming;
    let changedFields: string[] = [];

    if (existing) {
      const staleConflict = conflictDetector.detectStaleMetadataConflict({
        existing,
        incoming,
        clientCloudUpdatedAt,
        clientSeq,
        serverSeq: getMaxSeqFromSession(existing),
      });

      if (staleConflict.stale) {
        changedFields = staleConflict.changedFields;
        merged = conflictDetector.preserveStaleMetadataFields({
          merged,
          existing,
          changedFields: staleConflict.changedFields,
        });
        emitConflictViaSink(args.sink, {
          conflictType: 'stale-metadata',
          sessionId: args.sessionId,
          fields: staleConflict.reportedFields,
          serverCloudUpdatedAt: parseFiniteTimestamp(existing.cloudUpdatedAt) ?? undefined,
          clientCloudUpdatedAt,
          staleBy: staleConflict.staleBy,
          source: args.source,
        });
      } else {
        const changedMetadata = conflictDetector.getChangedMetadataFields(existing, merged);
        changedFields = changedMetadata.changedFields;
        const now = Date.now();
        const concurrentConflict = conflictDetector.recordWriteAndDetectConcurrentConflict({
          sessionId: args.sessionId,
          source: args.source,
          surface: args.surface,
          changedFields: changedMetadata.changedFields,
          previous: existing,
          next: merged,
          now,
        });
        if (concurrentConflict.hasConflict) {
          merged = applyDesktopSurfaceTiebreaker({
            sink: args.sink,
            sessionId: args.sessionId,
            surface: args.surface,
            source: args.source,
            existing,
            merged,
            concurrentConflict,
            now,
          });
          changedFields = conflictDetector.getChangedMetadataFields(existing, merged).changedFields;

          const firstField = concurrentConflict.fieldConflicts[0];
          emitConflictViaSink(args.sink, {
            conflictType: 'concurrent-edit',
            sessionId: args.sessionId,
            fields: concurrentConflict.reportedFields,
            previousValue: firstField?.previousValue,
            newValue: firstField?.newValue,
            source: args.source,
          });
        }
      }

      // Mobile/web manual renames use the sessions PUT API. Treat non-desktop
      // title edits as manual and clear auto-title metadata so future
      // auto-retitling does not overwrite user intent.
      const titleChanged = merged.title !== existing.title;
      if (titleChanged && args.surface !== 'desktop') {
        merged = {
          ...merged,
          autoTitleGeneratedAt: undefined,
          autoTitleTurnCount: undefined,
        };
      }
    }

    reportDoneClearedByMerge({
      sink: args.sink,
      sessionId: args.sessionId,
      surface: args.surface,
      source: args.source,
      existing,
      merged,
    });

    const stampedSession = await commitMergedSession(deps, { session: merged });
    return {
      kind: 'persisted' as const,
      cloudUpdatedAt: stampedSession.cloudUpdatedAt,
      serverSeq: getMaxSeqFromSession(stampedSession),
      changedFields,
    };
  });
}

export async function processSessionEventsAppend(
  deps: CloudSessionMergeDeps,
  args: SessionEventsAppendArgs,
): Promise<SessionEventsAppendOutcome> {
  const payloadHash = hashSessionEventsAppendPayload(args);

  return runUnderSessionMutexWithTombstoneGate(args.sessionId, {
    surface: args.surface,
    sink: args.sink,
    label: 'sessions.events.append',
  }, async () => {
    const cachedOutcome = readSessionEventsAppendIdempotencyCache({
      sessionId: args.sessionId,
      idempotencyKey: args.idempotencyKey,
      payloadHash,
    });
    if (cachedOutcome) return cachedOutcome;

    const existing = await deps.getSession(args.sessionId);
    if (!existing) {
      return { kind: 'needs-bootstrap' as const, sessionId: args.sessionId };
    }

    const currentServerSeq = getMaxSeqFromSession(existing);
    getSessionSeqIndex().setSeqFromStorage(args.sessionId, currentServerSeq);

    const validationOutcome = validateSessionEventsAppendEvents(args.events, currentServerSeq);
    if (validationOutcome) {
      writeSessionEventsAppendIdempotencyCache({
        sessionId: args.sessionId,
        idempotencyKey: args.idempotencyKey,
        payloadHash,
        outcome: validationOutcome,
      });
      return validationOutcome;
    }

    const existingCloudUpdatedAt = parseFiniteTimestamp(existing.cloudUpdatedAt) ?? 0;
    if (
      args.baseSeq > currentServerSeq
      || (args.metadataPatch && args.baseSeq !== currentServerSeq)
      || (
        args.metadataPatch
        && args.clientCloudUpdatedAt !== undefined
        && args.clientCloudUpdatedAt < existingCloudUpdatedAt
      )
      || (args.baseSeq < currentServerSeq && hasIncomingExistingCollision(existing, args.events))
    ) {
      const outcome = {
        kind: 'needs-reconcile' as const,
        serverSeq: currentServerSeq,
        cloudUpdatedAt: existingCloudUpdatedAt,
      };
      writeSessionEventsAppendIdempotencyCache({
        sessionId: args.sessionId,
        idempotencyKey: args.idempotencyKey,
        payloadHash,
        outcome,
      });
      return outcome;
    }

    let merged = {
      ...existing,
      eventsByTurn: { ...(existing.eventsByTurn ?? {}) },
      messages: [...(existing.messages ?? [])],
      maxSeq: currentServerSeq > 0 ? currentServerSeq : existing.maxSeq,
    } as MutableAppendSession;

    applyDestructiveOps({
      session: merged,
      ops: args._destructiveOps,
      sink: args.sink,
      sessionId: args.sessionId,
    });
    applyMessageDeletes(merged, args.messageDeletes);
    applyMessageDelta({
      session: merged,
      messageDelta: args.messageDelta,
      sink: args.sink,
      sessionId: args.sessionId,
    });

    const existingEventByIdentity = buildExistingEventIdentityMap(merged);
    const { incomingEventsByTurn, appliedSeq } = groupStampedEventsByTurn({
      sessionId: args.sessionId,
      events: args.events,
      existingEventByIdentity,
    });

    merged = {
      ...applyMetadataPatch({
        session: merged,
        patch: args.metadataPatch,
        surface: args.surface,
      }),
      eventsByTurn: mergeEventsForCloudPush(merged.eventsByTurn ?? {}, incomingEventsByTurn, {
        sessionIdHash: hashForBreadcrumb(args.sessionId),
        onEventOverwritePrevented: (details) => {
          args.sink.breadcrumb({
            category: 'continuity.session-merge',
            level: 'warning',
            message: 'event-overwrite-prevented',
            data: {
              direction: 'session-events-append',
              sessionIdHash: hashForBreadcrumb(args.sessionId),
              turnIdHash: hashForBreadcrumb(details.turnId),
              identityHash: hashForBreadcrumb(details.identity),
              changedFields: details.diff.map((entry) => entry.field),
            },
          });
        },
      }),
    } as MutableAppendSession;

    // Stage 0.C — desktop-as-tiebreaker on the PATCH/metadata path. The previous
    // implementation only wired the tiebreaker into processSessionPut, leaving
    // the primary delta-sync metadata write path bypassing surface arbitration.
    // We detect changed metadata, record the write, run the tiebreaker, and
    // (if desktop wins inside the 100ms window) revert the field. The
    // surface-tiebreaker breadcrumb is emitted only when the tiebreaker
    // actually fires (within-race-window).
    if (args.metadataPatch) {
      const changedMetadata = conflictDetector.getChangedMetadataFields(existing, merged);
      if (changedMetadata.changedFields.length > 0) {
        const now = Date.now();
        const concurrentConflict = conflictDetector.recordWriteAndDetectConcurrentConflict({
          sessionId: args.sessionId,
          source: args.source,
          surface: args.surface,
          changedFields: changedMetadata.changedFields,
          previous: existing,
          next: merged,
          now,
        });
        if (concurrentConflict.hasConflict) {
          merged = applyDesktopSurfaceTiebreaker({
            sink: args.sink,
            sessionId: args.sessionId,
            surface: args.surface,
            source: args.source,
            existing,
            merged,
            concurrentConflict,
            now,
          }) as MutableAppendSession;

          const firstField = concurrentConflict.fieldConflicts[0];
          emitConflictViaSink(args.sink, {
            conflictType: 'concurrent-edit',
            sessionId: args.sessionId,
            fields: concurrentConflict.reportedFields,
            previousValue: firstField?.previousValue,
            newValue: firstField?.newValue,
            source: args.source,
          });
        }
      }
    }

    reportDoneClearedByMerge({
      sink: args.sink,
      sessionId: args.sessionId,
      surface: args.surface,
      source: args.source,
      existing,
      merged,
    });

    const stampedSession = await commitMergedSession(deps, { session: merged });
    const outcome = {
      kind: 'applied' as const,
      appliedCount: args.events.length,
      appliedSeq,
      serverSeq: getMaxSeqFromSession(stampedSession),
      cloudUpdatedAt: stampedSession.cloudUpdatedAt,
    };

    emitBreadcrumbViaSink(args.sink, {
      category: 'continuity.session-merge',
      level: 'info',
      message: 'session-delta-push:applied',
      data: {
        appliedCount: outcome.appliedCount,
        serverSeq: outcome.serverSeq,
        sessionIdHash: hashForBreadcrumb(args.sessionId),
        source: args.source,
      },
    });
    args.sink.emit({
      channel: 'cloud:session-changed',
      payload: { sessionId: args.sessionId, action: 'upserted' },
    });
    const broadcastEvents = Object.entries(incomingEventsByTurn)
      .flatMap(([turnId, events]) => events.map((event) => ({ ...event, turnId } as SequencedAgentEvent)))
      .sort((a, b) => a.seq - b.seq);
    for (const event of broadcastEvents) {
      args.sink.emit({
        channel: 'cloud:session-event',
        payload: { sessionId: args.sessionId, event },
      });
    }

    writeSessionEventsAppendIdempotencyCache({
      sessionId: args.sessionId,
      idempotencyKey: args.idempotencyKey,
      payloadHash,
      outcome,
    });

    return outcome;
  });
}

export async function processSessionDelete(
  deps: CloudSessionMergeDeps,
  args: { sessionId: string; deletedBy: SessionDeletedBy },
): Promise<CloudSessionDeleteOutcome> {
  const tombstone = await sessionMutex.withLock(args.sessionId, async () => {
    // Intent: 'user-delete' (Stage 3 classification table) — cross-device
    // delete-wins is the point: the deleting user's intent must hold on this
    // surface too. (The SessionTombstoneStore call below owns the cloud SYNC
    // tombstone; the store's hard-delete ledger owns DISK write protection.)
    await deps.deleteSession(args.sessionId, { intent: 'user-delete' });
    return getSessionTombstoneStore().addTombstone(args.sessionId, args.deletedBy);
  }, { label: 'sessions.delete' });

  return { kind: 'deleted', tombstone };
}

export async function getCatchUpEvents(
  deps: CloudSessionMergeDeps,
  args: { sessionId: string; sinceSeq: number; limit: number },
): Promise<CatchUpEventsOutcome> {
  const tombstone = getSessionTombstoneStore().getTombstone(args.sessionId);
  if (tombstone) {
    return { kind: 'tombstoned', tombstone };
  }

  const session = await deps.getSession(args.sessionId);
  if (!session) {
    return { kind: 'not_found' };
  }

  const { events, serverSeq } = getSequencedEventsSince(session, args.sinceSeq);
  const pagedEvents = events.slice(0, args.limit);
  const hasMore = events.length > pagedEvents.length;
  const auxiliaryPayload = hasMore ? undefined : getCatchUpAuxiliaryPayload(session, args.sinceSeq);
  return {
    kind: 'events',
    events: pagedEvents,
    serverSeq,
    hasMore,
    ...(auxiliaryPayload ?? {}),
  };
}

export async function listSessionSummaries(
  deps: CloudSessionMergeDeps,
  args: { activeOnly: boolean; modifiedSince: number | null },
): Promise<{ sessions: Array<{ id?: string; updatedAt?: number; cloudUpdatedAt?: number; [key: string]: unknown }>; totalCount: number }> {
  const tombstoneStore = getSessionTombstoneStore();
  const mapped = (deps.listSessions() as AgentSessionSummary[]).map(toCloudSummary);
  // F4 (260617): DROP rows with a non-string/empty id rather than preserving
  // them. The previous `!summary.id || …` filter explicitly KEPT no-id rows,
  // which let a malformed summary propagate to consumers that call
  // `classifySessionKind(summary.id)` (crash) or `getSession(summary.id)`. A
  // no-id row is not a usable session — surface a count instead of swallowing.
  const beforeCount = mapped.length;
  let summaries = (
    mapped
      .filter((summary) => typeof summary.id === 'string' && summary.id.length > 0)
      .filter((summary) => !tombstoneStore.hasTombstone(summary.id as string))
  ) as unknown as Array<{ id?: string; updatedAt?: number; cloudUpdatedAt?: number; [key: string]: unknown }>;
  const droppedNoId = beforeCount - mapped.filter((s) => typeof s.id === 'string' && (s.id as string).length > 0).length;
  if (droppedNoId > 0) {
    sessionMergeLog.warn(
      { droppedNoId },
      'listSessionSummaries dropped session summaries with a missing/non-string id (not propagated to cloud consumers)',
    );
  }

  // activeOnly filtering: when true, only return sessions that are:
  // 1. Active on desktop (doneAt is null/absent) — matches the desktop "Active" section
  // 2. Not a background (app-initiated) kind — automation / meeting-analysis /
  //    use-case-discovery are excluded from Active by construction (see
  //    EXCLUDED_FROM_ACTIVE_KINDS in src/shared/sessionKind.ts), matching desktop
  // 3. Not soft-deleted (deletedAt is null/undefined/0)
  // 4. Explicitly marked cloud_active in the continuity state map
  if (args.activeOnly) {
    const stateMap = await deps.readContinuityStateMap();
    summaries = filterActiveOnlySessions(summaries, stateMap);
  }

  // totalCount reflects the full filtered set (before modifiedSince)
  // so clients can detect stale local sessions after incremental merges.
  const totalCount = summaries.length;

  if (args.modifiedSince !== null) {
    const modifiedSince = args.modifiedSince;
    summaries = summaries.filter((s) => getSessionOrderTimestamp(s) >= modifiedSince);
  }

  return { sessions: summaries, totalCount };
}

export function resetCloudSessionMergeServiceForTests(): void {
  resetConflictDetectorForTests();
  sessionEventsAppendIdempotencyCache.clear();
}
