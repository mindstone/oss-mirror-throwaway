// CORE-MOVE-EXEMPT: desktop-only durable outbox; tightly bound to Electron getDataPath + per-session mutex + Sentry breadcrumbs (see docs/plans/260518_cloud_sync_reconciliation_hardening.md Stage A5 chunking).
/**
 * Cloud Outbox
 *
 * Durable, disk-backed outbox for cloud session replication operations.
 * Provides reliable delivery with idempotent replay and exponential backoff.
 *
 * ## Design
 *
 * The outbox sits between the local session store and the cloud service.
 * Instead of a fire-and-forget push, session changes are written to the outbox
 * first and then drained asynchronously.
 *
 * Key properties:
 * - **Durable**: outbox is persisted to disk (`sessions/cloud-outbox.json`).
 *   Pending items survive app restarts.
 * - **Deduplicated**: multiple upserts for the same session collapse to one
 *   entry (last write wins). The latest local state is fetched at drain time,
 *   not at enqueue time.
 * - **Idempotent**: upsert = PUT (overwrite on cloud), delete = DELETE.
 *   Safe to replay any number of times.
 * - **Backoff**: failed items are retried with exponential backoff
 *   (1s → 2s → 4s → … → 10 min → 30 min cap). Entries retry indefinitely
 *   until delivered or cleared by a full migration / instance change.
 *
 * ## Integration
 *
 * `cloudRouter.ts` enqueues items via `outbox.enqueue()` and drains via
 * `outbox.drain()` on connect and app focus.
 * Status is surfaced to the renderer via the `cloud:outbox-status` IPC channel
 * and pushed in real-time via the `cloud:outbox-changed` broadcast event.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fnvHashBase36 as hashForBreadcrumb } from '@rebel/shared';
import { createScopedLogger } from '@core/logger';
import { getErrorReporter } from '@core/errorReporter';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
import { appendDiagnosticEvent } from '@core/services/diagnosticEventsLedger';
import { getSessionMutex } from '@core/services/sessionMutex';
import { getMaxSeqFromSession, stampMissingEventSeq } from '@core/services/sessionSeqIndex';
import { deduplicateMessages, mergeEventsForCloudPush } from '@core/services/sessionMergeUtils';
import { computeTurnChecksum } from '@core/services/eventCanonicalForm';
import type { SessionSingleUpsertOutcome } from '@core/services/incrementalSessionStore';
import { atomicWriteFileSync } from '@core/utils/atomicFileWrite';
import { toDiagnosticContinuityTransition } from '@shared/diagnostics/continuityTransition';
import type { AgentEvent, AgentSession, AgentSessionMetadataPatch } from '@shared/types';
import { AGENT_SESSION_METADATA_PATCH_KEYS } from '@shared/types';
import { getEventIdentity, isValidSeq } from '@shared/utils/eventIdentity';
import { getDataPath } from '../../utils/dataPaths';
import { DELTA_PUSH_RECONCILE_AGE_MS, DELTA_PUSH_RECONCILE_COUNT } from './cloudOutboxReconciliation';
import { stripConversationAnnotations } from './cloudRouterHelpers';
import type { CloudSyncOutcome } from './cloudFailureCooldown';

const log = createScopedLogger({ service: 'cloudOutbox' });
const outboxMutex = getSessionMutex();

function recordOutboxContinuityBreadcrumb(args: {
  level: 'warning';
  message: 'state-transition' | 'stuck-outbox';
  data: Record<string, unknown>;
}): void {
  getErrorReporter().addBreadcrumb({
    category: 'continuity.continuity-state',
    level: args.level,
    message: args.message,
    data: args.data,
  });
  appendDiagnosticEvent(toDiagnosticContinuityTransition({
    family: 'outbox',
    category: 'continuity.continuity-state',
    level: args.level,
    message: args.message,
    data: args.data,
  }));
}

function recordSessionDeltaPushBreadcrumb(args: {
  level?: 'info' | 'warning' | 'error';
  message:
    | 'applied'
    | 'needs-reconcile'
    | 'needs-bootstrap'
    | 'capability-missing-fallback'
    | 'drift-detected'
    | 'bootstrap-fallback'
    | 'metadata-patch-applied'
    | 'reconcile-via-patch'
    | 'reconcile-patch:generation-bumped-defer'
    | 'reconcile-patch:needs-bootstrap'
    | 'reconcile-patch:capability-missing-fallback'
    | 'reconcile-patch:needs-reconcile'
    | 'reconcile-handshake:matched'
    | 'reconcile-handshake:drift-detected'
    | 'reconcile-handshake:capability-missing-fallback'
    | 'chunked'
    | 'chunk-applied';
  data: {
    sessionIdHash: string;
    appliedCount?: number;
    serverSeq?: number;
    cloudUpdatedAt?: number;
    baseSeq?: number;
    payloadBytes?: number;
    gzipBytes?: number;
    hasMetadataPatch?: boolean;
    hasDelta?: boolean;
    expectedGeneration?: number;
    actualGeneration?: number;
    chunkIndex?: number;
    chunkCount?: number;
    totalEvents?: number;
    mismatchCount?: number;
    reconcileSinceSeq?: number;
  };
}): void {
  const diagnosticMessage = `session-delta-push:${args.message}` as const;
  getErrorReporter().addBreadcrumb({
    category: 'continuity.session-delta-push',
    level: args.level ?? 'info',
    message: args.message,
    data: args.data,
  });
  appendDiagnosticEvent(toDiagnosticContinuityTransition({
    family: 'session_delta_push',
    category: 'continuity.session-delta-push',
    level: args.level ?? 'info',
    message: diagnosticMessage,
    data: args.data,
  }));
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSIONS_DIR = 'sessions';
const OUTBOX_FILENAME = 'cloud-outbox.json';

/** Exponential backoff delays (ms). Ramps to 30 min then retries indefinitely. */
const BACKOFF_DELAYS_MS = [
  1_000,
  2_000,
  4_000,
  8_000,
  16_000,
  32_000,
  64_000,
  128_000,
  256_000,
  300_000,   // 5 min
  600_000,   // 10 min
  1_800_000, // 30 min — cap, retries forever at this interval
];

const STALL_CHECK_INTERVAL_MS = 5 * 60 * 1_000;
const STALL_THRESHOLD_MS = 10 * 60 * 1_000;
const STALL_ESCALATION_THROTTLE_MS = 60 * 60 * 1_000;
// Keep aligned with cloudServiceClient's gzip threshold so outbox_drain_size
// can report whether the transport will gzip the JSON request body.
const OUTBOX_GZIP_BODY_THRESHOLD_BYTES = 512 * 1024;
const DELTA_EVENT_FAST_PASS_BYTES = 3_000_000;
const DELTA_EVENT_GZIP_LIMIT_BYTES = 5_000_000;
const PREFLIGHT_CONCURRENCY = 4;
// Stage A5: byte-budgeted delta chunking. Each chunk's serialized body must
// stay under DELTA_CHUNK_BYTE_BUDGET. Reserve ~1MB envelope headroom so a
// chunk's full body (events + idempotency key + first-chunk metadata patch +
// transport overhead) cannot exceed the cloud body cap even on worst-case
// estimation drift.
const DELTA_CHUNK_BYTE_BUDGET = 10 * 1024 * 1024;
const DELTA_CHUNK_ENVELOPE_HEADROOM = 1024 * 1024;
const DELTA_CHUNK_EFFECTIVE_BUDGET = DELTA_CHUNK_BYTE_BUDGET - DELTA_CHUNK_ENVELOPE_HEADROOM;
// Stage A5 refinement: hard wire-body ceiling enforced at the actual JSON
// serialization point in appendSessionDelta. The planner aims for chunks
// under DELTA_CHUNK_EFFECTIVE_BUDGET (9MB), but envelope estimation drift,
// huge messageDelta/metadataPatch, or a single event whose raw size sneaks
// past the per-event gzip filter (3MB-raw / 5MB-gzipped) can still produce a
// wire body that exceeds the chunk budget. The hard limit sits slightly
// above the chunk budget (12MB vs 10MB) so normal in-budget chunks pass
// through without overhead, while any genuine overflow throws
// OversizedChunkError — a structural guarantee that no delta-push body can
// ever exceed this constant.
const DELTA_CHUNK_HARD_LIMIT = 12 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OutboxOp = 'upsert' | 'delete';
/**
 * 'pending' — entry is waiting to be (re)tried.
 * 'permanent_failure' — entry hit a non-retryable error (e.g. 413 BODY_TOO_LARGE)
 *   and will not be retried automatically. Persists across restarts so the user
 *   can see it. Cleared by clearAll, suppressTombstonedUpserts, or replacement
 *   via enqueue (e.g. if the same session is enqueued again after the user fixes
 *   the underlying issue).
 */
export type OutboxEntryStatus = 'pending' | 'permanent_failure';

/**
 * Typed classification of why an entry was parked as permanent_failure.
 * Stage A3 boot rehab matches on this value for new entries; legacy entries
 * (written before A2) fall back to regex matching on `lastError`.
 */
export type TerminalReason = 'body-too-large' | 'session-tombstoned' | 'unknown-permanent';

const TERMINAL_REASONS: ReadonlySet<TerminalReason> = new Set([
  'body-too-large',
  'session-tombstoned',
  'unknown-permanent',
]);

function isTerminalReason(value: unknown): value is TerminalReason {
  return typeof value === 'string' && TERMINAL_REASONS.has(value as TerminalReason);
}

export interface OutboxEntry {
  /** Unique entry identifier (used for idempotency). */
  id: string;
  /** Session ID this entry applies to. */
  sessionId: string;
  /** Operation to perform on the cloud. */
  op: OutboxOp;
  /** Timestamp when the entry was first enqueued. */
  enqueuedAt: number;
  /** Number of delivery attempts made. */
  attempts: number;
  /** Timestamp after which the entry may be retried. */
  nextRetryAt: number;
  /**
   * 'pending' entries retry indefinitely with backoff until delivered or
   * cleared. 'permanent_failure' entries are parked and will not be retried
   * (set when the cloud returns 413 BODY_TOO_LARGE).
   */
  status: OutboxEntryStatus;
  /** Error message from the last failed attempt. */
  lastError?: string;
  /**
   * Typed terminal classification when `status === 'permanent_failure'`.
   * Persisted alongside `lastError` so Stage A3 boot rehab can dispatch by
   * structured reason instead of regex on the free-text error string.
   */
  terminalReason?: TerminalReason;
}

export interface OutboxStatus {
  /** Number of entries awaiting delivery. */
  pending: number;
  /** Always 0 — kept for IPC schema backwards compat with older renderers. */
  failed: number;
}

/**
 * Result of a drain attempt. Distinguishes successful delivery from failure
 * so callers can update the cloud failure cooldown correctly: a drain that
 * resolves but failed every entry must NOT be treated as a success, otherwise
 * the circuit breaker never trips and stale credentials retry forever.
 *
 * See REBEL-1G8 (outbox stuck — 172 events / 10 users).
 */
export type DrainResult = CloudSyncOutcome;

export interface EnqueueOptions {
  /**
   * Force synchronous disk durability before enqueue returns.
   * Use for operations where crash windows are unacceptable (for example deletes).
   */
  durable?: boolean;
}

export interface OversizedOutboxEventRecord {
  eventIdentity: string;
  contentHash: string;
  gzipBytes: number;
}

export interface OversizedOutboxEventFingerprint {
  eventIdentity?: string;
  identity?: string;
  contentHash: string;
}

interface CloudCapabilities {
  supportsDeltaPush: boolean;
  supportsMetadataPatch: boolean;
  supportsReconcileHandshake?: boolean;
  raw?: string[];
}

interface DestructiveOps {
  truncateTurns?: string[];
  deleteEventIdentities?: string[];
}

type OutgoingDeltaEvent = Omit<AgentEvent, 'seq'> & {
  seq: null;
  turnId: string;
  clientOrdinal: number;
};
type CatchUpEvent = AgentEvent & { turnId?: string };

interface DeltaEventRef {
  turnId: string;
  eventIndex: number;
  originalSeq: number;
  event: OutgoingDeltaEvent;
}

interface DeltaPayload {
  baseSeq: number;
  events: DeltaEventRef[];
  messageDelta: AgentSession['messages'];
  messageDeletes: string[];
  metadataPatch?: AgentSessionMetadataPatch;
  metadataDigest?: string;
  destructiveOps?: DestructiveOps;
  currentMessageIds: string[];
  payloadBytes?: number;
  gzipBytes?: number;
}

interface ReconcileTurnChecksum {
  turnId: string;
  eventCount: number;
  contentChecksum: string;
}

interface ReconcileHandshakeResponse {
  serverSeq: number;
  turnChecksums: ReconcileTurnChecksum[];
}

interface ChunkedPayload {
  chunkIndex: number;
  chunkCount: number;
  baseSeq: number;
  isFirst: boolean;
  isFinal: boolean;
  events: DeltaEventRef[];
  payloadBytes: number;
}

/**
 * Thrown by appendSessionDelta when the fully serialized request body exceeds
 * DELTA_CHUNK_HARD_LIMIT. Carries enough context to let the caller decide
 * between sidelining a specific oversized event (when one event's serialized
 * bytes alone exceed DELTA_CHUNK_EFFECTIVE_BUDGET) and falling back to the
 * legacy pushFullSession path (when the envelope — messageDelta / metadataPatch
 * / destructiveOps — is responsible).
 *
 * This is the structural-invariant safety net for the A5 promise that no sync
 * request can exceed the byte budget. The planner aims for chunks under the
 * effective budget; this error fires only on envelope-estimation drift or
 * pathological payload shapes the planner cannot decompose.
 */
export class OversizedChunkError extends Error {
  readonly name = 'OversizedChunkError' as const;
  readonly sessionId: string;
  readonly wireBytes: number;
  readonly limit: number;
  readonly events: readonly DeltaEventRef[];
  readonly hasMessageDelta: boolean;
  readonly hasMessageDeletes: boolean;
  readonly hasMetadataPatch: boolean;
  readonly hasDestructiveOps: boolean;

  constructor(args: {
    sessionId: string;
    wireBytes: number;
    limit: number;
    events: readonly DeltaEventRef[];
    hasMessageDelta: boolean;
    hasMessageDeletes: boolean;
    hasMetadataPatch: boolean;
    hasDestructiveOps: boolean;
  }) {
    super(`Wire body ${args.wireBytes} bytes exceeds chunk hard limit ${args.limit} bytes`);
    this.sessionId = args.sessionId;
    this.wireBytes = args.wireBytes;
    this.limit = args.limit;
    this.events = args.events;
    this.hasMessageDelta = args.hasMessageDelta;
    this.hasMessageDeletes = args.hasMessageDeletes;
    this.hasMetadataPatch = args.hasMetadataPatch;
    this.hasDestructiveOps = args.hasDestructiveOps;
  }
}

type AppendEventsResult =
  | {
      kind: 'applied';
      appliedSeq: number[];
      serverSeq: number;
      cloudUpdatedAt: number;
    }
  | {
      kind: 'tombstoned';
      tombstone: unknown;
    };

interface CloudOutboxClient {
  get?(path: string): Promise<unknown>;
  post?(path: string, body?: unknown): Promise<unknown>;
  put(path: string, body: unknown): Promise<unknown>;
  patch?(path: string, body?: unknown): Promise<unknown>;
  delete(path: string): Promise<unknown>;
  getServerCapabilities?(): Promise<CloudCapabilities>;
  invalidateCapabilities?(): void;
  reconcileSession?(sessionId: string, clientSeq: number): Promise<ReconcileHandshakeResponse>;
  appendSessionEvents?(sessionId: string, body: {
    baseSeq: number;
    events: OutgoingDeltaEvent[];
    messageDelta?: AgentSession['messages'];
    messageDeletes?: string[];
    _destructiveOps?: DestructiveOps;
    idempotencyKey?: string;
    metadataPatch?: AgentSessionMetadataPatch;
  }): Promise<AppendEventsResult>;
  patchSession?(sessionId: string, body: {
    baseSeq: number;
    clientCloudUpdatedAt: number;
    patch: AgentSessionMetadataPatch;
  }): Promise<{ cloudUpdatedAt: number }>;
  catchUpSession?(sessionId: string, sinceSeq: number): Promise<{
    events: CatchUpEvent[];
    serverSeq: number;
    hasMore: boolean;
    messageDelta?: AgentSession['messages'];
    messageDeletes?: string[];
    destructiveOpsApplied?: {
      truncatedTurns: string[];
      deletedEventIdentities: string[];
    };
  }>;
}

/**
 * Heuristic: detect auth failure from a thrown error so the cloud router
 * can prioritise this signal (auth must trip the cooldown immediately —
 * retrying a stale token can hammer the auth endpoint).
 *
 * Detection sources (in order of preference):
 *   1. Structured `statusCode` / `status` field on the error object (most reliable).
 *   2. `HTTP <code>` / `status: <code>` / `code <code>` / `[401]` patterns in the
 *      message — the bridge client formats errors as `HTTP 401 Unauthorized`.
 *   3. Auth-specific keywords (unauthorized/forbidden/invalid token).
 *
 * Deliberately does NOT match bare "401"/"403" anywhere in the message — that
 * false-positives on session IDs, correlation IDs, and unrelated numbers
 * embedded in errors.
 */
function isAuthFailure(err: unknown): boolean {
  // Structured property — preferred path
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    const candidate = obj.statusCode ?? obj.status;
    if (typeof candidate === 'number' && (candidate === 401 || candidate === 403)) {
      return true;
    }
  }

  const message = err instanceof Error ? err.message : String(err ?? '');
  if (!message) return false;

  // Contextual HTTP status patterns: "HTTP 401", "status: 401", "status 403", "code 401"
  if (/(?:HTTP|status|code)[\s:=]*(?:["']?)(?:40[13])\b/i.test(message)) return true;
  // Bracketed: "[401]" / "(401)"
  if (/[\[(](?:40[13])[\])]/.test(message)) return true;

  // Auth-specific keywords (independent of any numeric code)
  return /\bunauthori[sz]ed\b|\bforbidden\b|invalid[\s-]?token|token[\s-]?expired/i.test(message);
}

/**
 * Returns true only when the error proves the session was tombstoned cloud-side.
 * Requires STRUCTURED proof:
 *   - Cloud-client SessionTombstonedError instance (matched via constructor.name
 *     to avoid a cross-package import)
 *   - error.code === 'session-tombstoned'
 *   - Normalized tombstone body { kind: 'tombstoned' } on response.body
 *   - Top-level responseBody (CloudClientError convention) with
 *     { error: 'session-tombstoned' } or { kind: 'tombstoned' }
 *
 * NOT considered tombstone proof:
 *   - Bare 410 status code (could be other resources; could be a flap)
 *   - Generic 4xx with "gone" in message
 *
 * Status-only 410 (no structured proof) stays transient (retry); operators
 * can inspect the cloud-tombstone-quarantine.json sibling if the cloud
 * accidentally tombstones a session.
 */
export function isConfirmedTombstoneError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    code?: unknown;
    status?: unknown;
    response?: unknown;
    responseBody?: unknown;
    constructor?: { name?: string };
  };
  if (e.constructor?.name === 'SessionTombstonedError') return true;
  if (typeof e.code === 'string' && e.code === 'session-tombstoned') return true;
  if (e.response && typeof e.response === 'object') {
    const body = (e.response as { body?: unknown }).body;
    if (body && typeof body === 'object' && (body as { kind?: unknown }).kind === 'tombstoned') {
      return true;
    }
  }
  if (e.responseBody && typeof e.responseBody === 'object') {
    const rb = e.responseBody as { error?: unknown; kind?: unknown; tombstone?: unknown };
    if (rb.error === 'session-tombstoned') return true;
    if (rb.kind === 'tombstoned') return true;
    if (rb.tombstone && typeof rb.tombstone === 'object') return true;
  }
  return false;
}

/**
 * Describe which structured proof shape identified the error as a confirmed
 * tombstone. Used for audit-log / Sentry observability on tombstone-applied
 * events so operators can later distinguish flap-vs-real and trace the
 * server-side response shape that triggered local convergence.
 */
export function describeTombstoneProof(err: unknown): string {
  if (!err || typeof err !== 'object') return 'unknown';
  const e = err as {
    code?: unknown;
    response?: unknown;
    responseBody?: unknown;
    constructor?: { name?: string };
  };
  if (e.constructor?.name === 'SessionTombstonedError') return 'SessionTombstonedError';
  if (typeof e.code === 'string' && e.code === 'session-tombstoned') return 'code';
  if (e.response && typeof e.response === 'object') {
    const body = (e.response as { body?: unknown }).body;
    if (body && typeof body === 'object' && (body as { kind?: unknown }).kind === 'tombstoned') {
      return 'response.body';
    }
  }
  if (e.responseBody && typeof e.responseBody === 'object') return 'responseBody';
  return 'unknown';
}

/**
 * Detect non-retryable upsert failures: 413 Payload Too Large or
 * BODY_TOO_LARGE. Sessions that exceed the cloud body limit will keep
 * exceeding it on retry, so they must be parked rather than burning
 * the outbox in a forever-loop.
 *
 * Detection sources (in order of preference):
 *   1. Structured `statusCode` / `status` === 413 on the error object
 *   2. Structured `code` === 'BODY_TOO_LARGE' on the error object
 *   3. `BODY_TOO_LARGE` literal in the error message
 */
function isPermanentFailure(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    const candidate = obj.statusCode ?? obj.status;
    if (typeof candidate === 'number' && candidate === 413) return true;
    if (typeof obj.code === 'string' && obj.code === 'BODY_TOO_LARGE') return true;
  }
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /\bBODY_TOO_LARGE\b/.test(message);
}

function errorStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const obj = err as Record<string, unknown>;
  const candidate = obj.statusCode ?? obj.status;
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
}

function errorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const obj = err as Record<string, unknown>;
  if (typeof obj.code === 'string') return obj.code;
  const responseBody = obj.responseBody;
  if (responseBody && typeof responseBody === 'object') {
    const error = (responseBody as { error?: unknown }).error;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
      return (error as { code: string }).code;
    }
  }
  return undefined;
}

function normalizeReconcileTurnChecksum(value: unknown): ReconcileTurnChecksum | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as {
    turnId?: unknown;
    eventCount?: unknown;
    contentChecksum?: unknown;
  };
  if (
    typeof candidate.turnId !== 'string'
    || typeof candidate.eventCount !== 'number'
    || !Number.isInteger(candidate.eventCount)
    || candidate.eventCount < 0
    || typeof candidate.contentChecksum !== 'string'
  ) {
    return null;
  }
  return {
    turnId: candidate.turnId,
    eventCount: candidate.eventCount,
    contentChecksum: candidate.contentChecksum,
  };
}

function normalizeReconcileHandshakeResponse(value: unknown): ReconcileHandshakeResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as {
    serverSeq?: unknown;
    turnChecksums?: unknown;
  };
  if (
    typeof candidate.serverSeq !== 'number'
    || !Number.isInteger(candidate.serverSeq)
    || candidate.serverSeq < 0
    || !Array.isArray(candidate.turnChecksums)
  ) {
    return null;
  }
  const turnChecksums: ReconcileTurnChecksum[] = [];
  for (const entry of candidate.turnChecksums) {
    const normalized = normalizeReconcileTurnChecksum(entry);
    if (!normalized) return null;
    turnChecksums.push(normalized);
  }
  return {
    serverSeq: candidate.serverSeq,
    turnChecksums,
  };
}

function createReconcileHandshakeInvalidResponseError(responseBody: unknown): Error & {
  code: 'reconcile-handshake-invalid-response';
  responseBody: unknown;
} {
  const error = new Error('reconcile-handshake-invalid-response') as Error & {
    code: 'reconcile-handshake-invalid-response';
    responseBody: unknown;
  };
  error.code = 'reconcile-handshake-invalid-response';
  error.responseBody = responseBody;
  return error;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stripSeqForHash(event: AgentEvent): Record<string, unknown> {
  const cloned = cloneJson(event) as Record<string, unknown>;
  delete cloned.seq;
  return cloned;
}

function contentHashForEvent(event: AgentEvent): string {
  return sha256(JSON.stringify(stripSeqForHash(event)));
}

function metadataPatchSubset(session: AgentSession): AgentSessionMetadataPatch {
  const patch: AgentSessionMetadataPatch = {};
  for (const key of AGENT_SESSION_METADATA_PATCH_KEYS) {
    if (Object.prototype.hasOwnProperty.call(session, key)) {
      patch[key] = session[key] as never;
    }
  }
  return patch;
}

function digestMetadataPatch(session: AgentSession): string {
  return sha256(JSON.stringify(metadataPatchSubset(session)));
}

function hasPatchKeys(patch: AgentSessionMetadataPatch): boolean {
  return Object.keys(patch).length > 0;
}

function toShellSession(session: AgentSession): AgentSession {
  const shell: AgentSession = {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    cloudUpdatedAt: session.cloudUpdatedAt,
    messages: [],
    eventsByTurn: {},
    maxSeq: 0,
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: session.resolvedAt ?? null,
    // Canonical lifecycle field (non-null = Done).
    doneAt: session.doneAt ?? null,
    starredAt: session.starredAt ?? null,
    deletedAt: session.deletedAt ?? null,
    privateMode: session.privateMode,
    draft: session.draft,
    origin: session.origin,
    finishLine: session.finishLine,
  };
  return stripConversationAnnotations(shell);
}

function extractMessageIds(messages: readonly AgentSession['messages'][number][] | undefined): string[] {
  return Array.from(new Set((messages ?? [])
    .map((message) => message.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)));
}

function normalizeDestructiveOps(input: unknown): DestructiveOps | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const raw = input as { truncateTurns?: unknown; deleteEventIdentities?: unknown };
  const truncateTurns = Array.isArray(raw.truncateTurns)
    ? raw.truncateTurns.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : undefined;
  const deleteEventIdentities = Array.isArray(raw.deleteEventIdentities)
    ? raw.deleteEventIdentities.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : undefined;
  if ((!truncateTurns || truncateTurns.length === 0) && (!deleteEventIdentities || deleteEventIdentities.length === 0)) {
    return undefined;
  }
  return {
    ...(truncateTurns && truncateTurns.length > 0 ? { truncateTurns } : {}),
    ...(deleteEventIdentities && deleteEventIdentities.length > 0 ? { deleteEventIdentities } : {}),
  };
}

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

const cursorPreflightSemaphore = new Semaphore(PREFLIGHT_CONCURRENCY);

export async function pushFullSessionWithCapabilityGate(
  client: CloudOutboxClient,
  session: AgentSession,
): Promise<{ serverSeq: number; cloudUpdatedAt: number }> {
  const { toolDetailArchive: _stripped, ...sessionWithoutDesktopOnlyFields } = session;
  const sessionToSend = stripConversationAnnotations(sessionWithoutDesktopOnlyFields as AgentSession);
  const result = await client.put(`/api/sessions/${encodeURIComponent(session.id)}`, sessionToSend);
  const response = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  const serverSeq = typeof response.serverSeq === 'number' && Number.isFinite(response.serverSeq)
    ? response.serverSeq
    : getMaxSeqFromSession(session);
  const cloudUpdatedAt = typeof response.cloudUpdatedAt === 'number' && Number.isFinite(response.cloudUpdatedAt)
    ? response.cloudUpdatedAt
    : typeof session.cloudUpdatedAt === 'number' && Number.isFinite(session.cloudUpdatedAt)
      ? session.cloudUpdatedAt
      : 0;
  return { serverSeq, cloudUpdatedAt };
}

// ---------------------------------------------------------------------------
// CloudOutbox class
// ---------------------------------------------------------------------------

export class CloudOutbox {
  /** In-memory map: sessionId → OutboxEntry (one entry per session, deduped). */
  private entries: Map<string, OutboxEntry> = new Map();
  private loaded = false;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private drainPromise: Promise<DrainResult> | null = null;
  private currentCloudUrl: string | null = null;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private lastSuccessfulDrainAt = Date.now();
  private lastStallEscalatedAt = 0;

  /**
   * In-memory tracker of the last cloudUpdatedAt stamped by the cloud for each
   * session. Injected into the session body before push so the cloud's conflict
   * detector sees the correct baseline — not the stale value that turn writes
   * may have clobbered in the local store.
   *
   * IMPORTANT: During active turns, this tracker is the canonical source for
   * cloudUpdatedAt at push time, NOT the local session store. The local store's
   * cloudUpdatedAt may lag because turn writes (which don't know about cloud
   * sync) overwrite it before the sync round-trip can propagate the cloud's
   * stamp. The tracker is populated from: (1) cloud PUT responses in
   * executeDrain, and (2) syncSessionFromCloud in cloudRouter.ts.
   *
   * Persisted alongside outbox entries in `cloud-outbox.json` as the
   * `_cloudUpdatedAtTracker` metadata key. On restart, the tracker is restored
   * from disk so the first push sends the correct baseline.
   */
  private cloudUpdatedAtTracker: Map<string, number> = new Map();
  /**
   * Stage 4 consolidated file-format addition for the upcoming delta-push
   * outbox. These keys are persisted as optional underscore-prefixed metadata
   * alongside the existing outbox entries. Older desktop builds ignore unknown
   * underscore keys, and these values are not on any critical path until Stage 5
   * starts consuming them, so upgrade→downgrade rollback is safe: the old binary
   * falls back to its existing full-PUT behaviour.
   */
  private lastPushedSeqTracker: Map<string, number> = new Map();
  private lastPushedMetadataDigest: Map<string, string> = new Map();
  private lastPushedMessageIds: Map<string, string[]> = new Map();
  private deltaCountSinceFullPut: Map<string, number> = new Map();
  private lastFullPutAt: Map<string, number> = new Map();
  private entryGeneration: Map<string, number> = new Map();

  /**
   * Upsert a session locally and report whether the write LANDED (merge graft,
   * 260612 delete-wins collision, arbitration F4): a delete-wins tombstone (or
   * read-only mode) drops the write inside the store, and outbox side effects
   * must not advance for a write that never happened. Adapted to OUR store
   * outcome vocabulary (SessionSingleUpsertOutcome); the optional probe keeps
   * minimal test mocks with only `upsertSession` working.
   */
  private async upsertLocalSessionIfWritten(
    store: {
      upsertSessionWithOutcome?: (session: AgentSession) => Promise<SessionSingleUpsertOutcome>;
      upsertSession: (session: AgentSession) => Promise<void>;
    },
    session: AgentSession,
  ): Promise<AgentSession | null> {
    if (typeof store.upsertSessionWithOutcome === 'function') {
      const outcome = await store.upsertSessionWithOutcome(session);
      return outcome === 'persisted' ? session : null;
    }

    await store.upsertSession(session);
    return session;
  }

  private oversizedEventIds: Map<string, OversizedOutboxEventRecord[]> = new Map();

  constructor() {
    this.startStallMonitor();
  }

  private get filePath(): string {
    return path.join(getDataPath(), SESSIONS_DIR, OUTBOX_FILENAME);
  }

  private getDrainLockKey(): string {
    return `outbox:${this.currentCloudUrl ?? 'desktop-outbox'}`;
  }

  private quarantineCorruptOutboxFile(parseError: unknown): void {
    const corruptPath = path.join(
      path.dirname(this.filePath),
      `cloud-outbox.corrupt.${Date.now()}.json`
    );

    try {
      fs.renameSync(this.filePath, corruptPath);
      log.error(
        { err: parseError, corruptPath },
        'Cloud outbox file was corrupt JSON, moved to quarantine and starting fresh'
      );
    } catch (renameError) {
      log.error(
        { err: parseError, renameErr: renameError, filePath: this.filePath, corruptPath },
        'Cloud outbox file was corrupt JSON and could not be quarantined'
      );
    }
  }

  private reportLoadFailure(loadError: unknown): void {
    const errorMessage = loadError instanceof Error ? loadError.message : String(loadError);
    const truncatedErrorMessage = errorMessage.slice(0, 200);
    getErrorReporter().addBreadcrumb({
      category: 'cloud-outbox-load-failed',
      message: 'cloud-outbox-load-failed-starting-fresh',
      level: 'warning',
      data: { errorMessage: truncatedErrorMessage },
    });
    getErrorReporter().captureMessage('cloud-outbox-load-failed-starting-fresh', {
      level: 'warning',
      extra: { errorMessage: truncatedErrorMessage },
    });
  }

  // ---- Persistence --------------------------------------------------------

  private restoreNumberMap(rawValue: unknown, target: Map<string, number>): void {
    if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) return;
    for (const [key, value] of Object.entries(rawValue as Record<string, unknown>)) {
      if (typeof key === 'string' && key.length > 0 && typeof value === 'number' && Number.isFinite(value)) {
        target.set(key, value);
      }
    }
  }

  private restoreStringMap(rawValue: unknown, target: Map<string, string>): void {
    if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) return;
    for (const [key, value] of Object.entries(rawValue as Record<string, unknown>)) {
      if (typeof key === 'string' && key.length > 0 && typeof value === 'string') {
        target.set(key, value);
      }
    }
  }

  private restoreStringArrayMap(rawValue: unknown, target: Map<string, string[]>): void {
    if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) return;
    for (const [key, value] of Object.entries(rawValue as Record<string, unknown>)) {
      if (typeof key !== 'string' || key.length === 0 || !Array.isArray(value)) continue;
      const ids = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
      target.set(key, Array.from(new Set(ids)));
    }
  }

  private restoreOversizedEventsMap(rawValue: unknown): void {
    if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) return;
    for (const [sessionId, value] of Object.entries(rawValue as Record<string, unknown>)) {
      if (typeof sessionId !== 'string' || sessionId.length === 0 || !Array.isArray(value)) continue;
      const records: OversizedOutboxEventRecord[] = [];
      for (const item of value) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const raw = item as Record<string, unknown>;
        if (
          typeof raw.eventIdentity === 'string'
          && raw.eventIdentity.length > 0
          && typeof raw.contentHash === 'string'
          && raw.contentHash.length > 0
          && typeof raw.gzipBytes === 'number'
          && Number.isFinite(raw.gzipBytes)
        ) {
          records.push({
            eventIdentity: raw.eventIdentity,
            contentHash: raw.contentHash,
            gzipBytes: raw.gzipBytes,
          });
        }
      }
      if (records.length > 0) {
        this.oversizedEventIds.set(sessionId, records);
      }
    }
  }

  load(): void {
    if (this.loaded) return;
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(raw) as Record<string, unknown>;
        } catch (parseError) {
          this.quarantineCorruptOutboxFile(parseError);
          this.entries = new Map();
          this.currentCloudUrl = null;
          // SAFETY: load failure means we may resurrect cloud sessions that were locally deleted before the crash.
          // Surfaces to Sentry for observability per silent-failure-is-a-bug policy.
          this.reportLoadFailure(parseError);
          this.loaded = true;
          return;
        }
        // Read persisted cloud URL (written alongside entries)
        if (typeof parsed._cloudUrl === 'string') {
          this.currentCloudUrl = parsed._cloudUrl;
        }
        // Restore persisted metadata trackers. Missing keys are expected for
        // pre-Stage-4 files and intentionally default to empty maps.
        this.restoreNumberMap(parsed._cloudUpdatedAtTracker, this.cloudUpdatedAtTracker);
        this.restoreNumberMap(parsed._lastPushedSeqTracker, this.lastPushedSeqTracker);
        this.restoreStringMap(parsed._lastPushedMetadataDigest, this.lastPushedMetadataDigest);
        this.restoreStringArrayMap(parsed._lastPushedMessageIds, this.lastPushedMessageIds);
        this.restoreNumberMap(parsed._deltaCountSinceFullPut, this.deltaCountSinceFullPut);
        this.restoreNumberMap(parsed._lastFullPutAt, this.lastFullPutAt);
        this.restoreNumberMap(parsed._entryGeneration, this.entryGeneration);
        this.restoreOversizedEventsMap(parsed._oversizedEventIds);
        // Load entries (filter out metadata keys starting with _)
        for (const [key, value] of Object.entries(parsed)) {
          if (key.startsWith('_')) continue;
          const entry = value as OutboxEntry;
          if (entry && typeof entry.sessionId === 'string') {
            // Normalize legacy 'failed' entries from before indefinite-retry change
            if ((entry.status as string) === 'failed') {
              entry.status = 'pending';
              entry.nextRetryAt = Date.now();
            }
            if (entry.terminalReason !== undefined && !isTerminalReason(entry.terminalReason)) {
              delete entry.terminalReason;
            }
            this.entries.set(key, entry);
            if (
              !this.lastFullPutAt.has(entry.sessionId)
              && typeof entry.enqueuedAt === 'number'
              && Number.isFinite(entry.enqueuedAt)
            ) {
              this.lastFullPutAt.set(entry.sessionId, entry.enqueuedAt);
            }
          }
        }
        // Safety: if entries exist but no URL provenance, clear them.
        // This handles legacy outbox files from before instance scoping was added.
        if (this.entries.size > 0 && !this.currentCloudUrl) {
          log.warn(
            { count: this.entries.size },
            'Clearing legacy outbox entries with unknown instance provenance',
          );
          this.entries = new Map();
          this.writeToDisk();
        } else if (this.entries.size > 0) {
          this.lastSuccessfulDrainAt = Math.min(
            ...Array.from(this.entries.values()).map((entry) => entry.enqueuedAt || Date.now()),
          );
        }
        log.info({ count: this.entries.size }, 'Loaded cloud outbox');
      }
    } catch (err) {
      log.warn({ err }, 'Failed to load cloud outbox, starting fresh');
      this.entries = new Map();
      // SAFETY: load failure means we may resurrect cloud sessions that were locally deleted before the crash.
      // Surfaces to Sentry for observability per silent-failure-is-a-bug policy.
      this.reportLoadFailure(err);
    }
    this.loaded = true;
    this.rehabilitateLegacyPermanentFailures();
  }

  /**
   * Stage A3 boot rehab: re-enqueue permanent_failure entries parked by the
   * old age-reconcile PUT-413 bug (fixed in A1) or stale tombstone-
   * misclassifications (fixed in A2). Matches 'body-too-large' on the typed
   * reason (new entries) or a legacy lastError regex (entries written before
   * A2). Tombstones and 'unknown-permanent' stay terminal. Idempotent: rehabbed
   * entries flip to 'pending' and are skipped on any subsequent scan.
   */
  private rehabilitateLegacyPermanentFailures(): { rehabilitated: number; skipped: number } {
    let rehabilitated = 0;
    let skipped = 0;

    for (const entry of this.entries.values()) {
      if (entry.status !== 'permanent_failure') continue;

      if (entry.terminalReason === 'session-tombstoned') {
        skipped++;
        continue;
      }

      const isBodyTooLarge =
        entry.terminalReason === 'body-too-large'
        || (entry.terminalReason === undefined
          && typeof entry.lastError === 'string'
          && /body|too large|exceeds|413/i.test(entry.lastError));

      if (!isBodyTooLarge) {
        skipped++;
        continue;
      }

      log.info(
        {
          entryId: entry.id,
          sessionIdHash: hashForBreadcrumb(entry.sessionId),
          previousError: entry.lastError,
          previousReason: entry.terminalReason ?? 'legacy',
        },
        'cloud-sync:boot-rehab-reenqueue',
      );

      entry.status = 'pending';
      entry.attempts = 0;
      entry.lastError = undefined;
      entry.terminalReason = undefined;
      entry.nextRetryAt = Date.now();
      rehabilitated++;
    }

    if (rehabilitated > 0) {
      // Ledger-only telemetry (registry sink policy) — was a raw info
      // captureMessage; see 260610 improve-sentry-noise Stage 5.
      captureKnownCondition(
        'cloud_sync_boot_rehab_summary',
        { extra: { rehabilitated, skipped } },
        new Error('cloud-sync:boot-rehab-summary'),
      );
      this.scheduleDiskWrite();
    }

    return { rehabilitated, skipped };
  }

  private scheduleDiskWrite(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      try {
        this.writeToDisk();
      } catch (err) {
        log.warn({ err }, 'Failed to write cloud outbox');
      }
    }, 500); // Short debounce for outbox writes
  }

  private writeToDisk(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const data: Record<string, unknown> = Object.fromEntries(this.entries);
    // Persist cloud URL alongside entries so it survives restarts
    if (this.currentCloudUrl) {
      data._cloudUrl = this.currentCloudUrl;
    }
    // Persist cloudUpdatedAt tracker so restarts don't produce stale baselines
    if (this.cloudUpdatedAtTracker.size > 0) {
      data._cloudUpdatedAtTracker = Object.fromEntries(this.cloudUpdatedAtTracker);
    }
    if (this.lastPushedSeqTracker.size > 0) {
      data._lastPushedSeqTracker = Object.fromEntries(this.lastPushedSeqTracker);
    }
    if (this.lastPushedMetadataDigest.size > 0) {
      data._lastPushedMetadataDigest = Object.fromEntries(this.lastPushedMetadataDigest);
    }
    if (this.lastPushedMessageIds.size > 0) {
      data._lastPushedMessageIds = Object.fromEntries(this.lastPushedMessageIds);
    }
    if (this.deltaCountSinceFullPut.size > 0) {
      data._deltaCountSinceFullPut = Object.fromEntries(this.deltaCountSinceFullPut);
    }
    if (this.lastFullPutAt.size > 0) {
      data._lastFullPutAt = Object.fromEntries(this.lastFullPutAt);
    }
    if (this.entryGeneration.size > 0) {
      data._entryGeneration = Object.fromEntries(this.entryGeneration);
    }
    if (this.oversizedEventIds.size > 0) {
      data._oversizedEventIds = Object.fromEntries(this.oversizedEventIds);
    }
    const result = atomicWriteFileSync(this.filePath, JSON.stringify(data));
    if (!result.durable) {
      log.warn(
        { error: result.error, errorCode: result.errorCode },
        'Failed to write cloud outbox'
      );
      throw new Error(
        `Cloud outbox write not durable: ${result.error ?? 'unknown'} (code: ${result.errorCode ?? 'none'})`,
      );
    }
  }

  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (this.loaded) this.writeToDisk();
  }

  // ---- Core API -----------------------------------------------------------

  /**
   * Enqueue a cloud replication operation.
   *
   * Upsert entries for the same session are deduplicated: the existing entry
   * is reset (attempts cleared, nextRetryAt = now, status = pending) so the
   * latest local state is fetched when the outbox is next drained.
   *
   * Delete entries always replace any pending upsert for the same session.
   *
   * Pass `{ durable: true }` to force a synchronous flush so the enqueued
   * operation survives immediate process crashes.
   */
  enqueue(sessionId: string, op: OutboxOp, options: EnqueueOptions = {}): void {
    this.load();
    const wasEmpty = this.entries.size === 0;
    const existing = this.entries.get(sessionId);

    if (existing && existing.op === op && existing.status === 'pending') {
      // Same op already pending — reset retry timer to pick up latest state
      existing.nextRetryAt = Date.now();
      existing.attempts = 0;
      existing.lastError = undefined;
      this.bumpEntryGeneration(existing.id);
      this.scheduleDiskWrite();
      if (options.durable) this.flush();
      return;
    }

    const entry: OutboxEntry = {
      id: `${sessionId}:${op}:${Date.now()}`,
      sessionId,
      op,
      enqueuedAt: Date.now(),
      attempts: 0,
      nextRetryAt: Date.now(),
      status: 'pending',
    };
    if (existing) {
      this.entryGeneration.delete(existing.id);
    }
    this.entries.set(sessionId, entry);
    this.bumpEntryGeneration(entry.id);
    if (wasEmpty) {
      this.lastSuccessfulDrainAt = Date.now();
    }
    this.scheduleDiskWrite();
    if (options.durable) this.flush();
  }

  /**
   * Get all entries that are due for retry.
   */
  getDueEntries(): OutboxEntry[] {
    this.load();
    const now = Date.now();
    return Array.from(this.entries.values()).filter(
      (e) => e.status === 'pending' && e.nextRetryAt <= now,
    );
  }

  /**
   * Mark an entry as successfully delivered and remove it from the outbox.
   */
  markSucceeded(sessionId: string, expectedEntryGeneration?: number): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    if (
      typeof expectedEntryGeneration === 'number'
      && Number.isFinite(expectedEntryGeneration)
      && this.getEntryGeneration(entry.id) !== expectedEntryGeneration
    ) {
      this.lastSuccessfulDrainAt = Date.now();
      this.scheduleDiskWrite();
      return;
    }
    this.entries.delete(sessionId);
    this.entryGeneration.delete(entry.id);
    this.lastSuccessfulDrainAt = Date.now();
    this.scheduleDiskWrite();
  }

  /**
   * Mark an entry as permanently failed. Used for non-retryable errors like
   * 413 BODY_TOO_LARGE — sessions that exceed the cloud body limit will keep
   * exceeding it, so retrying forever just wastes cycles. The entry persists
   * across restarts (it's in the outbox store) so the user can see it.
   *
   * `terminalReason` is a typed classification persisted alongside the
   * free-text `error` so Stage A3 boot rehab can dispatch by structured
   * reason. Defaults to 'unknown-permanent' when not provided.
   */
  markPermanentlyFailed(
    sessionId: string,
    error: string,
    terminalReason: TerminalReason = 'unknown-permanent',
  ): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;

    entry.attempts += 1;
    entry.lastError = error;
    entry.status = 'permanent_failure';
    entry.nextRetryAt = Number.MAX_SAFE_INTEGER;
    entry.terminalReason = terminalReason;
    log.warn(
      { sessionId, op: entry.op, attempts: entry.attempts, error, terminalReason },
      'Outbox entry marked permanent failure — will not retry',
    );
    this.scheduleDiskWrite();
  }

  /**
   * Record a failed delivery attempt. Applies exponential backoff (caps at 30 min).
   * Entries retry indefinitely — only success or clearAll removes them.
   */
  markAttemptFailed(sessionId: string, error: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;

    entry.attempts += 1;
    entry.lastError = error;

    const delayMs = BACKOFF_DELAYS_MS[Math.min(entry.attempts - 1, BACKOFF_DELAYS_MS.length - 1)];
    entry.nextRetryAt = Date.now() + delayMs;

    if (entry.attempts >= 20) {
      log.warn(
        { sessionId, attempts: entry.attempts, error },
        'Outbox entry may be stuck — retrying indefinitely',
      );
    } else {
      log.info(
        { sessionId, attempt: entry.attempts, nextRetryAt: entry.nextRetryAt, delayMs },
        'Outbox entry will be retried',
      );
    }
    this.scheduleDiskWrite();
  }

  /**
   * Record the latest cloudUpdatedAt stamped by the cloud for a session.
   * Called after a successful push (from the PUT response) and from
   * syncSessionFromCloud (when the cloud session is fetched but the local
   * upsert is skipped because the local version is newer).
   *
   * The tracked value is injected into session bodies before push so the
   * cloud's stale-metadata conflict detector sees the correct baseline.
   */
  recordCloudUpdatedAt(sessionId: string, cloudUpdatedAt: number): void {
    if (!sessionId || typeof cloudUpdatedAt !== 'number' || !Number.isFinite(cloudUpdatedAt)) return;
    const existing = this.cloudUpdatedAtTracker.get(sessionId);
    if (existing === undefined || cloudUpdatedAt > existing) {
      this.cloudUpdatedAtTracker.set(sessionId, cloudUpdatedAt);
      this.scheduleDiskWrite();
    }
  }

  recordLastPushedSeq(sessionId: string, seq: number | undefined): void {
    if (!sessionId) return;
    if (seq === undefined) {
      if (this.lastPushedSeqTracker.delete(sessionId)) this.scheduleDiskWrite();
      return;
    }
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return;
    this.lastPushedSeqTracker.set(sessionId, seq);
    this.scheduleDiskWrite();
  }

  getLastPushedSeq(sessionId: string): number | undefined {
    this.load();
    return this.lastPushedSeqTracker.get(sessionId);
  }

  recordLastPushedMetadataDigest(sessionId: string, digest: string | undefined): void {
    if (!sessionId) return;
    if (digest === undefined) {
      if (this.lastPushedMetadataDigest.delete(sessionId)) this.scheduleDiskWrite();
      return;
    }
    this.lastPushedMetadataDigest.set(sessionId, digest);
    this.scheduleDiskWrite();
  }

  getLastPushedMetadataDigest(sessionId: string): string | undefined {
    this.load();
    return this.lastPushedMetadataDigest.get(sessionId);
  }

  recordLastPushedMessageIds(sessionId: string, messageIds: readonly string[]): void {
    if (!sessionId) return;
    this.lastPushedMessageIds.set(
      sessionId,
      Array.from(new Set(messageIds.filter((id) => typeof id === 'string' && id.length > 0))),
    );
    this.scheduleDiskWrite();
  }

  getLastPushedMessageIds(sessionId: string): readonly string[] {
    this.load();
    return [...(this.lastPushedMessageIds.get(sessionId) ?? [])];
  }

  bumpEntryGeneration(entryId: string): number {
    if (!entryId) return 0;
    const nextGeneration = (this.entryGeneration.get(entryId) ?? 0) + 1;
    this.entryGeneration.set(entryId, nextGeneration);
    this.scheduleDiskWrite();
    return nextGeneration;
  }

  getEntryGeneration(entryId: string): number {
    this.load();
    return this.entryGeneration.get(entryId) ?? 0;
  }

  recordFullPut(sessionId: string, now: number = Date.now()): void {
    if (!sessionId || typeof now !== 'number' || !Number.isFinite(now)) return;
    this.lastFullPutAt.set(sessionId, now);
    this.deltaCountSinceFullPut.set(sessionId, 0);
    this.scheduleDiskWrite();
  }

  incrementDeltaCount(sessionId: string): number {
    if (!sessionId) return 0;
    const nextCount = this.getDeltaCount(sessionId) + 1;
    this.deltaCountSinceFullPut.set(sessionId, nextCount);
    this.scheduleDiskWrite();
    return nextCount;
  }

  resetDeltaCount(sessionId: string): void {
    if (!sessionId) return;
    this.deltaCountSinceFullPut.set(sessionId, 0);
    this.scheduleDiskWrite();
  }

  getDeltaCount(sessionId: string): number {
    this.load();
    return this.deltaCountSinceFullPut.get(sessionId) ?? 0;
  }

  getLastFullPutAt(sessionId: string): number | undefined {
    this.load();
    return this.lastFullPutAt.get(sessionId);
  }

  recordOversizedEvent(
    sessionId: string,
    eventIdentity: string,
    contentHash: string,
    gzipBytes: number,
  ): void {
    if (
      !sessionId
      || !eventIdentity
      || !contentHash
      || typeof gzipBytes !== 'number'
      || !Number.isFinite(gzipBytes)
    ) {
      return;
    }
    const existing = this.oversizedEventIds.get(sessionId) ?? [];
    const withoutIdentity = existing.filter((record) => record.eventIdentity !== eventIdentity);
    this.oversizedEventIds.set(sessionId, [
      ...withoutIdentity,
      { eventIdentity, contentHash, gzipBytes },
    ]);
    this.scheduleDiskWrite();
  }

  getOversizedEvents(sessionId: string): readonly OversizedOutboxEventRecord[] {
    this.load();
    return [...(this.oversizedEventIds.get(sessionId) ?? [])];
  }

  clearOversizedEventsByContentChange(
    sessionId: string,
    currentEventIdentitiesAndHashes: readonly OversizedOutboxEventFingerprint[],
  ): void {
    if (!sessionId) return;
    const existing = this.oversizedEventIds.get(sessionId);
    if (!existing || existing.length === 0) return;

    const currentHashesByIdentity = new Map<string, string>();
    for (const item of currentEventIdentitiesAndHashes) {
      const identity = item.eventIdentity ?? item.identity;
      if (identity && item.contentHash) {
        currentHashesByIdentity.set(identity, item.contentHash);
      }
    }

    const unchanged = existing.filter(
      (record) => currentHashesByIdentity.get(record.eventIdentity) === record.contentHash,
    );
    if (unchanged.length === existing.length) return;
    if (unchanged.length > 0) {
      this.oversizedEventIds.set(sessionId, unchanged);
    } else {
      this.oversizedEventIds.delete(sessionId);
    }
    this.scheduleDiskWrite();
  }

  clearOversizedEventsByDestructiveOps(sessionId: string, ops: DestructiveOps | undefined): number {
    if (!sessionId || !ops) return 0;
    const existing = this.oversizedEventIds.get(sessionId);
    if (!existing || existing.length === 0) return 0;

    const truncatedTurns = new Set(ops.truncateTurns ?? []);
    const deletedIdentities = new Set(ops.deleteEventIdentities ?? []);
    const kept = existing.filter((record) => {
      const turnId = record.eventIdentity.split(':')[0];
      return !truncatedTurns.has(turnId) && !deletedIdentities.has(record.eventIdentity);
    });
    const removedCount = existing.length - kept.length;
    if (removedCount === 0) return 0;

    if (kept.length > 0) {
      this.oversizedEventIds.set(sessionId, kept);
    } else {
      this.oversizedEventIds.delete(sessionId);
    }
    this.scheduleDiskWrite();
    getErrorReporter().addBreadcrumb({
      category: 'cloud-sync',
      level: 'info',
      message: 'session-delta-push:oversized-skipset-cleared',
      data: {
        sessionIdHash: hashForBreadcrumb(sessionId),
        removedCount,
        source: 'destructive-ops',
      },
    });
    return removedCount;
  }

  private clearSessionTrackers(sessionId: string): void {
    this.cloudUpdatedAtTracker.delete(sessionId);
    this.lastPushedSeqTracker.delete(sessionId);
    this.lastPushedMetadataDigest.delete(sessionId);
    this.lastPushedMessageIds.delete(sessionId);
    this.deltaCountSinceFullPut.delete(sessionId);
    this.lastFullPutAt.delete(sessionId);
    this.oversizedEventIds.delete(sessionId);
  }

  /**
   * Snapshot the current per-session trackers to
   * `sessions/cloud-tombstone-quarantine.json` (LRU-kept at 30 entries) just
   * before clearing them via `clearSessionTrackers`. The file is a local
   * recovery breadcrumb: if the cloud accidentally tombstones a live session,
   * the operator can reconstruct lastPushedSeq / cloudUpdatedAt / digest from
   * here and re-bootstrap from the local session JSON.
   *
   * Best-effort. Never throws — disk failures here must not perturb the
   * outbox's primary tombstone-clear workflow.
   */
  private async snapshotToTombstoneQuarantine(sessionId: string): Promise<void> {
    try {
      const sessionsDir = path.join(getDataPath(), SESSIONS_DIR);
      const quarantinePath = path.join(sessionsDir, 'cloud-tombstone-quarantine.json');

      let existing: Array<{
        sessionId: string;
        lastPushedSeq?: number;
        cloudUpdatedAt?: number;
        metadataDigest?: string;
        tombstonedAt: number;
      }> = [];

      try {
        const raw = await fs.promises.readFile(quarantinePath, 'utf-8');
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          existing = parsed as typeof existing;
        }
      } catch {
        // File doesn't exist or is unreadable — start fresh.
      }

      const snapshot = {
        sessionId,
        lastPushedSeq: this.getLastPushedSeq(sessionId),
        cloudUpdatedAt: this.cloudUpdatedAtTracker.get(sessionId),
        metadataDigest: this.lastPushedMetadataDigest.get(sessionId),
        tombstonedAt: Date.now(),
      };

      const filtered = existing.filter((e) => e.sessionId !== sessionId);
      filtered.unshift(snapshot);
      const truncated = filtered.slice(0, 30);

      await fs.promises.mkdir(sessionsDir, { recursive: true });
      await fs.promises.writeFile(
        quarantinePath,
        JSON.stringify(truncated, null, 2),
        'utf-8',
      );
    } catch (err) {
      log.warn({ err }, 'cloud-sync:tombstone-quarantine-write-failed');
    }
  }

  /**
   * Centralized tombstone application: structured audit log, Sentry breadcrumb
   * with proof shape, quarantine snapshot, then generation-guarded
   * `markSucceeded` and tracker clear. Used by every confirmed-tombstone path:
   *
   *   - Drain catch (executeDrain) when `appendSessionEvents` throws a
   *     confirmed tombstone error.
   *   - Preflight (`seedCursorFromCloudIfPossible`) when the lean GET returns
   *     a confirmed tombstone.
   *   - Append-result tombstone (`executeDeltaUpsert`) when the cloud SDK
   *     returns `{ kind: 'tombstoned' }` instead of throwing.
   *
   * Generation guard: if `expectedGeneration` is provided and a concurrent
   * in-process enqueue has bumped the entry's generation during the
   * round-trip, the entry is preserved (not deleted) and trackers are
   * preserved so the next drain can push the bumped enqueue. The cloud
   * already accepted the tombstone, so the cloud side is unchanged — the
   * preservation only affects whether the local entry survives this tick.
   *
   * Returns: `true` if the entry was deleted (generation matched OR no entry
   * existed); `false` if the entry was preserved (generation mismatch).
   */
  private async applyConfirmedTombstone(
    sessionId: string,
    expectedGeneration: number | undefined,
    proofDescriptor: string,
  ): Promise<boolean> {
    log.info(
      {
        sessionIdHash: hashForBreadcrumb(sessionId),
        proof: proofDescriptor,
        lastPushedSeq: this.getLastPushedSeq(sessionId),
      },
      'cloud-sync:tombstone-applied',
    );
    // Ledger-only audit telemetry (registry sink policy) — was a raw info
    // captureMessage; see 260610 improve-sentry-noise Stage 5.
    captureKnownCondition(
      'cloud_sync_tombstone_applied',
      {
        extra: {
          sessionIdHash: hashForBreadcrumb(sessionId),
          proof: proofDescriptor,
          lastPushedSeq: this.getLastPushedSeq(sessionId),
          cloudUpdatedAt: this.cloudUpdatedAtTracker.get(sessionId),
        },
      },
      new Error('cloud-sync:tombstone-applied'),
    );

    try {
      await this.snapshotToTombstoneQuarantine(sessionId);
    } catch (quarantineErr) {
      log.warn(
        {
          sessionIdHash: hashForBreadcrumb(sessionId),
          err: quarantineErr,
        },
        'cloud-sync:tombstone-quarantine-snapshot-failed',
      );
    }

    const entry = this.entries.get(sessionId);
    if (!entry) {
      // No outbox entry → nothing to mark; just clear trackers so a future
      // pull / preflight doesn't see stale baseline state for a tombstoned
      // session.
      this.clearSessionTrackers(sessionId);
      return true;
    }

    if (expectedGeneration !== undefined) {
      const liveGeneration = this.getEntryGeneration(entry.id);
      if (liveGeneration !== expectedGeneration) {
        recordSessionDeltaPushBreadcrumb({
          level: 'info',
          message: 'reconcile-patch:generation-bumped-defer',
          data: {
            sessionIdHash: hashForBreadcrumb(sessionId),
            expectedGeneration,
            actualGeneration: liveGeneration,
          },
        });
        return false;
      }
    }

    this.markSucceeded(sessionId, expectedGeneration);
    this.clearSessionTrackers(sessionId);
    return true;
  }

  /**
   * Get current outbox status counts.
   * `pending` excludes permanent failures (they're not awaiting delivery).
   * `failed` is always 0 for IPC schema backwards compat with older renderers.
   */
  getStatus(): OutboxStatus {
    this.load();
    let pending = 0;
    for (const entry of this.entries.values()) {
      if (entry.status === 'pending') pending++;
    }
    return { pending, failed: 0 };
  }

  /**
   * Get all entries (for diagnostics/tests).
   */
  getAll(): OutboxEntry[] {
    this.load();
    return Array.from(this.entries.values());
  }

  /**
   * Returns whether a session currently has a pending delete entry.
   * Used to suppress cloud pull resurrection while a local delete is in-flight.
   */
  hasPendingDelete(sessionId: string): boolean {
    this.load();
    const entry = this.entries.get(sessionId);
    return entry?.op === 'delete' && entry.status === 'pending';
  }

  private async getCapabilities(client: CloudOutboxClient): Promise<CloudCapabilities> {
    if (client.getServerCapabilities) {
      const capabilities = await client.getServerCapabilities();
      const raw = Array.isArray(capabilities.raw) ? capabilities.raw : [];
      return {
        ...capabilities,
        supportsReconcileHandshake: capabilities.supportsReconcileHandshake === true
          || raw.includes('session-reconcile-handshake'),
        raw,
      };
    }
    if (!client.get) {
      return {
        supportsDeltaPush: false,
        supportsMetadataPatch: false,
        supportsReconcileHandshake: false,
        raw: [],
      };
    }
    const health = await client.get('/api/health');
    const capabilities = health && typeof health === 'object' && Array.isArray((health as { capabilities?: unknown }).capabilities)
      ? (health as { capabilities: unknown[] }).capabilities.filter((entry): entry is string => typeof entry === 'string')
      : [];
    return {
      supportsDeltaPush: capabilities.includes('session-event-delta-push'),
      supportsMetadataPatch: capabilities.includes('session-metadata-patch'),
      supportsReconcileHandshake: capabilities.includes('session-reconcile-handshake'),
      raw: capabilities,
    };
  }

  private async reconcileSessionHandshake(
    client: CloudOutboxClient,
    sessionId: string,
    clientSeq: number,
  ): Promise<ReconcileHandshakeResponse> {
    const normalizedClientSeq = Number.isFinite(clientSeq) && clientSeq > 0
      ? Math.floor(clientSeq)
      : 0;

    const response = client.reconcileSession
      ? await client.reconcileSession(sessionId, normalizedClientSeq)
      : await (async () => {
          if (!client.get) {
            throw new Error('Reconcile handshake unavailable: client.reconcileSession and client.get missing');
          }
          const query = new URLSearchParams({ clientSeq: String(normalizedClientSeq) });
          return client.get(`/api/sessions/${encodeURIComponent(sessionId)}/reconcile?${query.toString()}`);
        })();

    const normalized = normalizeReconcileHandshakeResponse(response);
    if (!normalized) {
      throw createReconcileHandshakeInvalidResponseError(response);
    }
    return normalized;
  }

  private getTurnBaseSeq(events: readonly AgentEvent[]): number {
    let minSeq = Number.POSITIVE_INFINITY;
    for (const event of events) {
      if (!isValidSeq(event.seq)) continue;
      if (event.seq < minSeq) {
        minSeq = event.seq;
      }
    }
    if (!Number.isFinite(minSeq)) return 0;
    return Math.max(0, minSeq - 1);
  }

  private getReconcileHandshakeDrift(args: {
    session: AgentSession;
    turnChecksums: ReconcileTurnChecksum[];
  }): { mismatchedTurnIds: string[]; sinceSeq: number } {
    const mismatchedTurnIds = new Set<string>();
    const sinceSeqCandidates: number[] = [];
    const serverTurnById = new Map(args.turnChecksums.map((turn) => [turn.turnId, turn]));

    for (const turn of args.turnChecksums) {
      const localEvents = args.session.eventsByTurn?.[turn.turnId] ?? [];
      const localChecksum = computeTurnChecksum(localEvents);
      if (localEvents.length === turn.eventCount && localChecksum === turn.contentChecksum) {
        continue;
      }
      mismatchedTurnIds.add(turn.turnId);
      sinceSeqCandidates.push(this.getTurnBaseSeq(localEvents));
    }

    for (const [turnId, localEvents] of Object.entries(args.session.eventsByTurn ?? {})) {
      if (serverTurnById.has(turnId)) continue;
      if (localEvents.length === 0) continue;
      mismatchedTurnIds.add(turnId);
      sinceSeqCandidates.push(this.getTurnBaseSeq(localEvents));
    }

    const sinceSeq = sinceSeqCandidates.length > 0
      ? Math.max(0, Math.min(...sinceSeqCandidates))
      : 0;

    return {
      mismatchedTurnIds: [...mismatchedTurnIds].sort(),
      sinceSeq,
    };
  }

  private async seedCursorFromCloudIfPossible(
    client: CloudOutboxClient,
    session: AgentSession,
  ): Promise<'seeded' | 'bootstrap-created' | 'tombstoned'> {
    if (!client.get) {
      return 'seeded';
    }
    const get = client.get.bind(client);

    return cursorPreflightSemaphore.withSlot(async () => {
      try {
        const pulled = await get(`/api/sessions/${encodeURIComponent(session.id)}?lean=true`) as Partial<AgentSession> | null;
        if (!pulled) {
          await this.executeBootstrapCreateThenAppend(client, session);
          return 'bootstrap-created';
        }
        const pulledMaxSeq = typeof pulled.maxSeq === 'number' && Number.isFinite(pulled.maxSeq)
          ? pulled.maxSeq
          : 0;
        this.recordLastPushedSeq(session.id, pulledMaxSeq);
        this.recordLastPushedMessageIds(session.id, extractMessageIds(pulled.messages));
        if (typeof pulled.cloudUpdatedAt === 'number' && Number.isFinite(pulled.cloudUpdatedAt)) {
          this.recordCloudUpdatedAt(session.id, pulled.cloudUpdatedAt);
        }

        if (Array.isArray(pulled.messages) && pulled.messages.length > 0) {
          const { getIncrementalSessionStore } = await import('../incrementalSessionStore');
          const store = getIncrementalSessionStore();
          const latest = await store.getSession(session.id);
          if (latest) {
            await this.upsertLocalSessionIfWritten(store, {
              ...latest,
              messages: deduplicateMessages(latest.messages ?? [], pulled.messages, 'secondary-wins'),
            });
          }
        }
        return 'seeded';
      } catch (err) {
        const statusCode = errorStatusCode(err);
        if (statusCode === 404) {
          await this.executeBootstrapCreateThenAppend(client, session);
          return 'bootstrap-created';
        }
        if (isConfirmedTombstoneError(err)) {
          // Structured proof (SessionTombstonedError / code / response.body.kind
          // / responseBody) — converge locally via the centralized handler so
          // quarantine snapshot and audit-log machinery run on every path.
          // Status-only 410 with no normalizable body falls through to the
          // re-throw below so the outer drain treats it as a transient failure.
          // Preflight has no captured generation (it runs outside the drain
          // loop's expectedGeneration capture), so pass `undefined` — the
          // helper skips the generation guard and unconditionally deletes the
          // entry.
          await this.applyConfirmedTombstone(session.id, undefined, describeTombstoneProof(err));
          return 'tombstoned';
        }
        throw err;
      }
    });
  }

  private async executeBootstrapCreateThenAppend(
    client: CloudOutboxClient,
    session: AgentSession,
  ): Promise<void> {
    const shell = toShellSession(session);
    /* direct-session-put -- shell bootstrap before delta append */
    await client.put(`/api/sessions/${encodeURIComponent(session.id)}`, shell);
    this.recordFullPut(session.id);
    this.recordLastPushedSeq(session.id, 0);
    this.recordLastPushedMessageIds(session.id, []);
    recordSessionDeltaPushBreadcrumb({
      message: 'bootstrap-fallback',
      data: { sessionIdHash: hashForBreadcrumb(session.id), baseSeq: 0 },
    });
  }

  private computeDeltaPayload(session: AgentSession, entry: OutboxEntry): DeltaPayload {
    const baseSeq = this.getLastPushedSeq(session.id) ?? 0;
    const lastPushedMessageIds = new Set(this.getLastPushedMessageIds(session.id));
    const currentMessageIds = extractMessageIds(session.messages);
    const currentMessageIdSet = new Set(currentMessageIds);
    const currentFingerprints: OversizedOutboxEventFingerprint[] = [];

    for (const [turnId, events] of Object.entries(session.eventsByTurn ?? {})) {
      for (const event of events) {
        currentFingerprints.push({
          eventIdentity: getEventIdentity(turnId, event),
          contentHash: contentHashForEvent(event),
        });
      }
    }
    this.clearOversizedEventsByContentChange(session.id, currentFingerprints);
    const oversizedIdentities = new Set(this.getOversizedEvents(session.id).map((record) => record.eventIdentity));

    const eventRefs: DeltaEventRef[] = [];
    for (const [turnId, events] of Object.entries(session.eventsByTurn ?? {})) {
      for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
        const event = events[eventIndex];
        if (!isValidSeq(event.seq) || event.seq <= baseSeq) continue;
        const eventIdentity = getEventIdentity(turnId, event);
        if (oversizedIdentities.has(eventIdentity)) continue;

        const json = JSON.stringify(event);
        const rawBytes = Buffer.byteLength(json, 'utf8');
        let gzipBytes = rawBytes;
        if (rawBytes >= DELTA_EVENT_FAST_PASS_BYTES) {
          gzipBytes = gzipSync(Buffer.from(json)).byteLength;
          if (gzipBytes > DELTA_EVENT_GZIP_LIMIT_BYTES) {
            const contentHash = contentHashForEvent(event);
            this.recordOversizedEvent(session.id, eventIdentity, contentHash, gzipBytes);
            log.warn(
              {
                sessionId: hashForBreadcrumb(session.id),
                eventIdentityHash: hashForBreadcrumb(eventIdentity),
                eventType: event.type,
                rawBytes,
                gzipBytes,
              },
              'session-delta-push:event-too-large',
            );
            getErrorReporter().addBreadcrumb({
              category: 'cloud-sync',
              level: 'warning',
              message: 'session-delta-push:event-too-large',
              data: {
                sessionIdHash: hashForBreadcrumb(session.id),
                eventIdentityHash: hashForBreadcrumb(eventIdentity),
                eventType: event.type,
                rawBytes,
                gzipBytes,
              },
            });
            continue;
          }
        }

        eventRefs.push({
          turnId,
          eventIndex,
          originalSeq: event.seq,
          event: {
            ...(cloneJson(event) as Omit<AgentEvent, 'seq'>),
            turnId,
            seq: null,
            clientOrdinal: 0,
          },
        });
      }
    }

    eventRefs.sort((a, b) => {
      if (a.originalSeq !== b.originalSeq) return a.originalSeq - b.originalSeq;
      return (a.event.timestamp ?? 0) - (b.event.timestamp ?? 0);
    });
    const nextOrdinalByTurn = new Map<string, number>();
    for (const ref of eventRefs) {
      const nextOrdinal = nextOrdinalByTurn.get(ref.turnId) ?? 0;
      ref.event.clientOrdinal = nextOrdinal;
      nextOrdinalByTurn.set(ref.turnId, nextOrdinal + 1);
    }

    const messageDelta = (session.messages ?? []).filter((message) => !lastPushedMessageIds.has(message.id));
    const messageDeletes = [...lastPushedMessageIds].filter((id) => !currentMessageIdSet.has(id));
    const metadataDigest = digestMetadataPatch(session);
    const previousMetadataDigest = this.getLastPushedMetadataDigest(session.id);
    const metadataPatch = previousMetadataDigest !== metadataDigest ? metadataPatchSubset(session) : undefined;
    const destructiveOps = normalizeDestructiveOps((entry as OutboxEntry & { _destructiveOps?: unknown })._destructiveOps);

    return {
      baseSeq,
      events: eventRefs,
      messageDelta,
      messageDeletes,
      ...(metadataPatch && hasPatchKeys(metadataPatch) ? { metadataPatch, metadataDigest } : { metadataDigest }),
      ...(destructiveOps ? { destructiveOps } : {}),
      currentMessageIds,
    };
  }

  private buildIdempotencyKey(sessionId: string, entry: OutboxEntry, payload: DeltaPayload): string {
    const generation = this.getEntryGeneration(entry.id);
    // REBEL-68C: the server dedups by comparing a hash of the FULL append body
    // (hashSessionEventsAppendPayload in cloudSessionMergeService: baseSeq, full event
    // bodies, full messageDelta bodies, messageDeletes, _destructiveOps, metadataPatch).
    // The outbox recomputes the payload live on every drain (computeDeltaPayload) and a
    // transient failure does NOT bump the entry generation, so any of those fields
    // drifting between attempts reuses this key with a body the server hashes
    // differently → 500 IDEMPOTENCY_PAYLOAD_MISMATCH. Real drift seen in the wild:
    // session metadata changing (metadataPatch), lastPushedSeq advancing (baseSeq), a
    // message finalizing (messageDelta body), or a tool event's contentRef uploadStatus
    // flipping pending→uploaded after the upload outbox runs (event body — same event
    // identity, different body). So fingerprint the SAME field set the server hashes,
    // full bodies, in the order they are sent (computeDeltaPayload orders events by
    // seq/timestamp; messageDelta/messageDeletes follow stable session order) — the key
    // then varies iff the hashed wire body varies. A genuinely-changed body becomes a
    // fresh request (server seq-dedup + needs-reconcile keep that safe); true
    // network-retries of an identical body still dedup. `clientCloudUpdatedAt` is
    // intentionally omitted: it is never sent on the events route. The server-side hash
    // check remains as defense-in-depth against a buggy/forked/older client.
    const fingerprint = sha256(JSON.stringify({
      baseSeq: payload.baseSeq,
      events: payload.events.map((ref) => ref.event),
      messageDelta: payload.messageDelta,
      messageDeletes: payload.messageDeletes,
      destructiveOps: payload.destructiveOps ?? null,
      metadataPatch: payload.metadataPatch ?? null,
    }));
    return `${sessionId}:${generation}:${fingerprint}`;
  }

  private async appendSessionDelta(
    client: CloudOutboxClient,
    sessionId: string,
    entry: OutboxEntry,
    payload: DeltaPayload,
  ): Promise<AppendEventsResult> {
    const body = {
      baseSeq: payload.baseSeq,
      events: payload.events.map((ref) => ref.event),
      ...(payload.messageDelta.length > 0 ? { messageDelta: payload.messageDelta } : {}),
      ...(payload.messageDeletes.length > 0 ? { messageDeletes: payload.messageDeletes } : {}),
      ...(payload.destructiveOps ? { _destructiveOps: payload.destructiveOps } : {}),
      idempotencyKey: this.buildIdempotencyKey(sessionId, entry, payload),
      ...(payload.metadataPatch ? { metadataPatch: payload.metadataPatch } : {}),
    };
    const jsonBody = JSON.stringify(body);
    const rawBytes = Buffer.byteLength(jsonBody, 'utf8');
    payload.payloadBytes = rawBytes;
    // Stage A5 refinement: hard wire-body invariant. The planner aims for
    // chunks under DELTA_CHUNK_EFFECTIVE_BUDGET, but envelope-estimation drift,
    // huge messageDelta/metadataPatch, or an event whose raw size sneaks past
    // the per-event filter can still produce an over-budget body. Catching it
    // here — at the actual JSON serialization point, before any network I/O —
    // makes "no sync request exceeds the budget" a structural guarantee rather
    // than a hope. The caller decides whether to sideline a specific event or
    // fall back to pushFullSession via the OversizedChunkError context.
    if (rawBytes > DELTA_CHUNK_HARD_LIMIT) {
      throw new OversizedChunkError({
        sessionId,
        wireBytes: rawBytes,
        limit: DELTA_CHUNK_HARD_LIMIT,
        events: payload.events,
        hasMessageDelta: payload.messageDelta.length > 0,
        hasMessageDeletes: payload.messageDeletes.length > 0,
        hasMetadataPatch: Boolean(payload.metadataPatch),
        hasDestructiveOps: Boolean(payload.destructiveOps),
      });
    }
    if (rawBytes >= OUTBOX_GZIP_BODY_THRESHOLD_BYTES) {
      payload.gzipBytes = gzipSync(Buffer.from(jsonBody)).byteLength;
    }

    if (client.appendSessionEvents) {
      return client.appendSessionEvents(sessionId, body);
    }
    if (!client.post) {
      throw new Error('Delta push unavailable: client.post missing');
    }
    const response = await client.post(`/api/sessions/${encodeURIComponent(sessionId)}/events`, body);
    const payloadResponse = response && typeof response === 'object' ? response as Record<string, unknown> : {};
    return {
      kind: 'applied',
      appliedSeq: Array.isArray(payloadResponse.appliedSeq)
        ? payloadResponse.appliedSeq.filter((seq): seq is number => typeof seq === 'number' && Number.isInteger(seq))
        : [],
      serverSeq: typeof payloadResponse.serverSeq === 'number' ? payloadResponse.serverSeq : 0,
      cloudUpdatedAt: typeof payloadResponse.cloudUpdatedAt === 'number' ? payloadResponse.cloudUpdatedAt : 0,
    };
  }

  private async patchMetadataOnly(
    client: CloudOutboxClient,
    session: AgentSession,
    payload: DeltaPayload,
  ): Promise<void> {
    if (!payload.metadataPatch) return;
    const clientCloudUpdatedAt = this.cloudUpdatedAtTracker.get(session.id) ?? session.cloudUpdatedAt ?? 0;
    if (client.patchSession) {
      const result = await client.patchSession(session.id, {
        baseSeq: payload.baseSeq,
        clientCloudUpdatedAt,
        patch: payload.metadataPatch,
      });
      this.recordCloudUpdatedAt(session.id, result.cloudUpdatedAt);
    } else {
      if (!client.patch) throw new Error('Metadata patch unavailable: client.patch missing');
      const result = await client.patch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        baseSeq: payload.baseSeq,
        clientCloudUpdatedAt,
        patch: payload.metadataPatch,
      });
      const cloudUpdatedAt = result && typeof result === 'object'
        ? (result as { cloudUpdatedAt?: unknown }).cloudUpdatedAt
        : undefined;
      if (typeof cloudUpdatedAt === 'number' && Number.isFinite(cloudUpdatedAt)) {
        this.recordCloudUpdatedAt(session.id, cloudUpdatedAt);
      }
    }
    if (payload.metadataDigest) {
      this.recordLastPushedMetadataDigest(session.id, payload.metadataDigest);
    }
    recordSessionDeltaPushBreadcrumb({
      message: 'metadata-patch-applied',
      data: {
        sessionIdHash: hashForBreadcrumb(session.id),
        baseSeq: payload.baseSeq,
        cloudUpdatedAt: this.cloudUpdatedAtTracker.get(session.id) ?? session.cloudUpdatedAt ?? 0,
      },
    });
  }

  private async applyAppendSuccess(
    session: AgentSession,
    entry: OutboxEntry,
    payload: DeltaPayload,
    result: Extract<AppendEventsResult, { kind: 'applied' }>,
    expectedGeneration: number,
  ): Promise<void> {
    const { getIncrementalSessionStore } = await import('../incrementalSessionStore');
    const store = getIncrementalSessionStore();
    const latest = await store.getSession(session.id);
    if (latest && payload.events.length > 0 && result.appliedSeq.length > 0) {
      const nextEventsByTurn: Record<string, AgentEvent[]> = { ...(latest.eventsByTurn ?? {}) };
      const clonedTurns = new Set<string>();
      for (let index = 0; index < payload.events.length; index += 1) {
        const seq = result.appliedSeq[index];
        const ref = payload.events[index];
        if (!isValidSeq(seq)) continue;
        const turnEvents = nextEventsByTurn[ref.turnId];
        if (!turnEvents?.[ref.eventIndex]) continue;
        if (!clonedTurns.has(ref.turnId)) {
          nextEventsByTurn[ref.turnId] = [...turnEvents];
          clonedTurns.add(ref.turnId);
        }
        nextEventsByTurn[ref.turnId][ref.eventIndex] = {
          ...nextEventsByTurn[ref.turnId][ref.eventIndex],
          seq,
        };
      }
      const writtenSession = await this.upsertLocalSessionIfWritten(store, {
        ...latest,
        eventsByTurn: nextEventsByTurn,
        maxSeq: Math.max(result.serverSeq, getMaxSeqFromSession({ ...latest, eventsByTurn: nextEventsByTurn })),
      });
      if (!writtenSession) return;
    }

    this.recordLastPushedSeq(session.id, result.serverSeq);
    this.recordCloudUpdatedAt(session.id, result.cloudUpdatedAt);
    this.recordLastPushedMessageIds(session.id, payload.currentMessageIds);
    if (payload.metadataDigest) this.recordLastPushedMetadataDigest(session.id, payload.metadataDigest);
    if (payload.destructiveOps) this.clearOversizedEventsByDestructiveOps(session.id, payload.destructiveOps);
    this.incrementDeltaCount(session.id);
    this.markSucceeded(session.id, expectedGeneration);
    recordSessionDeltaPushBreadcrumb({
      message: 'applied',
      data: {
        sessionIdHash: hashForBreadcrumb(session.id),
        appliedCount: result.appliedSeq.length,
        serverSeq: result.serverSeq,
        cloudUpdatedAt: result.cloudUpdatedAt,
        baseSeq: payload.baseSeq,
        ...(payload.payloadBytes !== undefined ? { payloadBytes: payload.payloadBytes } : {}),
        ...(payload.gzipBytes !== undefined ? { gzipBytes: payload.gzipBytes } : {}),
      },
    });
  }

  // Stage A5: byte-budgeted delta chunking.
  //
  // planDeltaChunks splits a DeltaPayload into ordered ChunkedPayload[] so no
  // single POST body exceeds DELTA_CHUNK_BYTE_BUDGET. The first chunk carries
  // messageDelta / messageDeletes / destructiveOps / metadataPatch; subsequent
  // chunks carry events only. Final-chunk bookkeeping (metadata digest, message
  // ids, deltaCount, oversized cleanup, markSucceeded) is funnelled back through
  // applyAppendSuccess by reconstituting the missing tracking fields into a
  // separate "final-payload" — the wire body the cloud sees never re-includes
  // first-chunk fields.
  private planDeltaChunks(payload: DeltaPayload, sessionId: string): ChunkedPayload[] {
    const eventBytes = payload.events.map(
      (ref) => Buffer.byteLength(JSON.stringify(ref.event), 'utf8') + 1,
    );
    const headerBytesFirst = this.estimateChunkOverhead(payload, sessionId, true);
    const headerBytesSubsequent = this.estimateChunkOverhead(payload, sessionId, false);
    const totalEventBytes = eventBytes.reduce((sum, b) => sum + b, 0);

    if (headerBytesFirst + totalEventBytes <= DELTA_CHUNK_EFFECTIVE_BUDGET) {
      return [{
        chunkIndex: 0,
        chunkCount: 1,
        baseSeq: payload.baseSeq,
        isFirst: true,
        isFinal: true,
        events: payload.events,
        payloadBytes: headerBytesFirst + totalEventBytes,
      }];
    }

    const chunks: ChunkedPayload[] = [];
    let currentEvents: DeltaEventRef[] = [];
    let currentEventsBytes = 0;
    let isFirstAccumulator = true;
    let currentHeaderBytes = headerBytesFirst;

    const flushCurrent = (): void => {
      chunks.push({
        chunkIndex: chunks.length,
        chunkCount: 0,
        baseSeq: 0,
        isFirst: isFirstAccumulator,
        isFinal: false,
        events: currentEvents,
        payloadBytes: currentHeaderBytes + currentEventsBytes,
      });
      isFirstAccumulator = false;
      currentHeaderBytes = headerBytesSubsequent;
      currentEvents = [];
      currentEventsBytes = 0;
    };

    for (let i = 0; i < payload.events.length; i += 1) {
      const ref = payload.events[i];
      const eBytes = eventBytes[i];

      if (currentEvents.length === 0 && currentHeaderBytes + eBytes > DELTA_CHUNK_EFFECTIVE_BUDGET) {
        log.error(
          {
            sessionId: hashForBreadcrumb(sessionId),
            eventBytes: eBytes,
            budget: DELTA_CHUNK_EFFECTIVE_BUDGET,
          },
          'session-delta-push:oversized-event',
        );
        getErrorReporter().addBreadcrumb({
          category: 'cloud-sync',
          level: 'warning',
          message: 'session-delta-push:oversized-event',
          data: {
            sessionIdHash: hashForBreadcrumb(sessionId),
            eventBytes: eBytes,
            budget: DELTA_CHUNK_EFFECTIVE_BUDGET,
          },
        });
        currentEvents = [ref];
        currentEventsBytes = eBytes;
        flushCurrent();
        continue;
      }

      if (currentHeaderBytes + currentEventsBytes + eBytes > DELTA_CHUNK_EFFECTIVE_BUDGET) {
        flushCurrent();
        currentEvents = [ref];
        currentEventsBytes = eBytes;
      } else {
        currentEvents.push(ref);
        currentEventsBytes += eBytes;
      }
    }

    if (currentEvents.length > 0) {
      flushCurrent();
    }

    const total = chunks.length;
    for (const chunk of chunks) {
      chunk.chunkCount = total;
    }
    if (total > 0) chunks[total - 1].isFinal = true;

    log.info(
      {
        sessionId: hashForBreadcrumb(sessionId),
        chunkCount: total,
        totalEvents: payload.events.length,
        firstHeaderBytes: headerBytesFirst,
        subsequentHeaderBytes: headerBytesSubsequent,
      },
      'session-delta-push:chunked',
    );
    recordSessionDeltaPushBreadcrumb({
      message: 'chunked',
      data: {
        sessionIdHash: hashForBreadcrumb(sessionId),
        chunkCount: total,
        totalEvents: payload.events.length,
      },
    });

    return chunks;
  }

  // estimateChunkOverhead measures the envelope cost (idempotency key, baseSeq,
  // empty events array, plus first-chunk-only fields) so the chunk planner can
  // compute remaining event budget. A representative idempotency key is used
  // because the real key is derived from event identities (which differ per
  // chunk), but the length is bounded by (sessionId + ":" + generation + ":" +
  // 64-hex-fingerprint) so a placeholder string of the same shape gives a
  // tight upper-bound estimate.
  private estimateChunkOverhead(payload: DeltaPayload, sessionId: string, isFirst: boolean): number {
    const idempotencyKeyPlaceholder = `${sessionId}:0:${'a'.repeat(64)}`;
    const body = {
      baseSeq: payload.baseSeq,
      events: [] as unknown[],
      ...(isFirst && payload.messageDelta.length > 0 ? { messageDelta: payload.messageDelta } : {}),
      ...(isFirst && payload.messageDeletes.length > 0 ? { messageDeletes: payload.messageDeletes } : {}),
      ...(isFirst && payload.destructiveOps ? { _destructiveOps: payload.destructiveOps } : {}),
      idempotencyKey: idempotencyKeyPlaceholder,
      ...(isFirst && payload.metadataPatch ? { metadataPatch: payload.metadataPatch } : {}),
    };
    return Buffer.byteLength(JSON.stringify(body), 'utf8');
  }

  // chunkToWirePayload constructs the per-chunk DeltaPayload that appendSessionDelta
  // serializes onto the wire. First-chunk-only fields are present only on the
  // first chunk; subsequent chunks carry events alone (plus the always-included
  // tracking fields the success/applyChunkResult handlers need).
  private chunkToWirePayload(chunk: ChunkedPayload, original: DeltaPayload): DeltaPayload {
    return {
      baseSeq: chunk.baseSeq,
      events: chunk.events,
      messageDelta: chunk.isFirst ? original.messageDelta : [],
      messageDeletes: chunk.isFirst ? original.messageDeletes : [],
      ...(chunk.isFirst && original.destructiveOps ? { destructiveOps: original.destructiveOps } : {}),
      ...(chunk.isFirst && original.metadataPatch ? { metadataPatch: original.metadataPatch } : {}),
      ...(chunk.isFirst && original.metadataDigest ? { metadataDigest: original.metadataDigest } : {}),
      currentMessageIds: original.currentMessageIds,
    };
  }

  // applyChunkResult does partial bookkeeping for intermediate chunks:
  // it stamps the chunk's events with their assigned seqs and advances the
  // cursor + cloudUpdatedAt — but does NOT update message ids, metadata digest,
  // oversized-event tracking, deltaCount, or call markSucceeded. Those happen
  // exactly once on the final chunk via applyAppendSuccess.
  private async applyChunkResult(
    session: AgentSession,
    chunk: ChunkedPayload,
    payload: DeltaPayload,
    result: Extract<AppendEventsResult, { kind: 'applied' }>,
  ): Promise<void> {
    const { getIncrementalSessionStore } = await import('../incrementalSessionStore');
    const store = getIncrementalSessionStore();
    const latest = await store.getSession(session.id);
    if (latest && payload.events.length > 0 && result.appliedSeq.length > 0) {
      const nextEventsByTurn: Record<string, AgentEvent[]> = { ...(latest.eventsByTurn ?? {}) };
      const clonedTurns = new Set<string>();
      for (let index = 0; index < payload.events.length; index += 1) {
        const seq = result.appliedSeq[index];
        const ref = payload.events[index];
        if (!isValidSeq(seq)) continue;
        const turnEvents = nextEventsByTurn[ref.turnId];
        if (!turnEvents?.[ref.eventIndex]) continue;
        if (!clonedTurns.has(ref.turnId)) {
          nextEventsByTurn[ref.turnId] = [...turnEvents];
          clonedTurns.add(ref.turnId);
        }
        nextEventsByTurn[ref.turnId][ref.eventIndex] = {
          ...nextEventsByTurn[ref.turnId][ref.eventIndex],
          seq,
        };
      }
      const writtenSession = await this.upsertLocalSessionIfWritten(store, {
        ...latest,
        eventsByTurn: nextEventsByTurn,
        maxSeq: Math.max(result.serverSeq, getMaxSeqFromSession({ ...latest, eventsByTurn: nextEventsByTurn })),
      });
      if (!writtenSession) return;
    }

    this.recordLastPushedSeq(session.id, result.serverSeq);
    this.recordCloudUpdatedAt(session.id, result.cloudUpdatedAt);

    recordSessionDeltaPushBreadcrumb({
      message: 'chunk-applied',
      data: {
        sessionIdHash: hashForBreadcrumb(session.id),
        chunkIndex: chunk.chunkIndex,
        chunkCount: chunk.chunkCount,
        appliedCount: result.appliedSeq.length,
        serverSeq: result.serverSeq,
        cloudUpdatedAt: result.cloudUpdatedAt,
        baseSeq: chunk.baseSeq,
        payloadBytes: chunk.payloadBytes,
      },
    });
  }

  // Stage A5 refinement: sideline any events in `err.events` whose individual
  // serialized JSON bytes exceed DELTA_CHUNK_EFFECTIVE_BUDGET. Returns true
  // when at least one event was sidelined (caller should re-throw so the
  // outer drain markAttemptFailed retries); returns false when no single
  // event is responsible (caller should fall back to pushFullSession).
  //
  // Identity/hash must be computed against the ORIGINAL AgentEvent (with
  // valid seq, no `clientOrdinal`/`turnId` envelope fields) so the recorded
  // identity matches the form computeDeltaPayload uses to populate
  // currentFingerprints on the next drain — otherwise
  // clearOversizedEventsByContentChange would never invalidate the entry.
  private sidelineOversizedEventsFromChunk(
    session: AgentSession,
    entry: OutboxEntry,
    err: OversizedChunkError,
  ): boolean {
    const sessionId = session.id;
    let sidelined = 0;
    for (const ref of err.events) {
      const eventBytes = Buffer.byteLength(JSON.stringify(ref.event), 'utf8');
      if (eventBytes <= DELTA_CHUNK_EFFECTIVE_BUDGET) continue;
      const originalEvent = session.eventsByTurn?.[ref.turnId]?.[ref.eventIndex];
      if (!originalEvent) continue;
      const eventIdentity = getEventIdentity(ref.turnId, originalEvent);
      const contentHash = contentHashForEvent(originalEvent);
      this.recordOversizedEvent(sessionId, eventIdentity, contentHash, eventBytes);
      log.warn(
        {
          sessionId: hashForBreadcrumb(sessionId),
          eventIdentityHash: hashForBreadcrumb(eventIdentity),
          eventType: originalEvent.type,
          eventBytes,
          wireBytes: err.wireBytes,
          limit: err.limit,
        },
        'session-delta-push:event-oversized-sidelined',
      );
      getErrorReporter().addBreadcrumb({
        category: 'cloud-sync',
        level: 'warning',
        message: 'session-delta-push:event-oversized-sidelined',
        data: {
          sessionIdHash: hashForBreadcrumb(sessionId),
          eventIdentityHash: hashForBreadcrumb(eventIdentity),
          eventType: originalEvent.type,
          eventBytes,
          wireBytes: err.wireBytes,
          limit: err.limit,
        },
      });
      sidelined += 1;
    }
    if (sidelined > 0) {
      // Bump generation so any in-flight payload using the prior generation
      // is invalidated; the next drain re-derives a fresh payload without
      // the sidelined event(s) under the new generation.
      this.bumpEntryGeneration(entry.id);
    }
    return sidelined > 0;
  }

  // appendSessionDeltaChunked is the Stage A5 entry point that replaces a
  // direct appendSessionDelta + applyAppendSuccess call sequence. Single-chunk
  // payloads go through the existing fast path unchanged. Multi-chunk payloads
  // POST chunks sequentially: each chunk's baseSeq is the prior chunk's
  // serverSeq response; intermediate chunks run applyChunkResult; the final
  // chunk runs applyAppendSuccess with the original payload's tracking fields
  // (metadataDigest / destructiveOps / currentMessageIds) reconstituted into a
  // synthesized final-payload, so messageIds, deltaCount, oversized cleanup,
  // and markSucceeded all fire exactly once per chunked transmission.
  private async appendSessionDeltaChunked(
    client: CloudOutboxClient,
    session: AgentSession,
    entry: OutboxEntry,
    payload: DeltaPayload,
    expectedGeneration: number,
  ): Promise<void> {
    const chunks = this.planDeltaChunks(payload, session.id);

    if (chunks.length <= 1) {
      const result = await this.appendSessionDelta(client, session.id, entry, payload);
      if (result.kind === 'tombstoned') {
        await this.applyConfirmedTombstone(session.id, expectedGeneration, 'response.body');
        return;
      }
      await this.applyAppendSuccess(session, entry, payload, result, expectedGeneration);
      return;
    }

    let currentBaseSeq = payload.baseSeq;
    for (const chunk of chunks) {
      chunk.baseSeq = currentBaseSeq;
      const wirePayload = this.chunkToWirePayload(chunk, payload);
      const result = await this.appendSessionDelta(client, session.id, entry, wirePayload);
      if (result.kind === 'tombstoned') {
        await this.applyConfirmedTombstone(session.id, expectedGeneration, 'response.body');
        return;
      }

      if (chunk.isFinal) {
        const finalPayload: DeltaPayload = {
          ...wirePayload,
          destructiveOps: payload.destructiveOps,
          metadataDigest: payload.metadataDigest,
          currentMessageIds: payload.currentMessageIds,
          payloadBytes: chunk.payloadBytes,
        };
        await this.applyAppendSuccess(session, entry, finalPayload, result, expectedGeneration);
      } else {
        await this.applyChunkResult(session, chunk, wirePayload, result);
      }
      currentBaseSeq = result.serverSeq;
    }
  }

  private applyDestructiveOpsToSession(session: AgentSession, ops?: {
    truncatedTurns: string[];
    deletedEventIdentities: string[];
  }): AgentSession {
    if (!ops) return session;
    const nextEventsByTurn: Record<string, AgentEvent[]> = { ...(session.eventsByTurn ?? {}) };
    let changed = false;

    for (const turnId of ops.truncatedTurns ?? []) {
      nextEventsByTurn[turnId] = [];
      changed = true;
      getErrorReporter().addBreadcrumb({
        category: 'cloud-sync',
        level: 'info',
        message: 'session-catch-up:destructive-op-applied',
        data: { sessionIdHash: hashForBreadcrumb(session.id), op: 'truncateTurn', turnIdHash: hashForBreadcrumb(turnId) },
      });
    }

    const deletedIdentities = new Set(ops.deletedEventIdentities ?? []);
    if (deletedIdentities.size > 0) {
      for (const [turnId, events] of Object.entries(nextEventsByTurn)) {
        const filtered = events.filter((event) => !deletedIdentities.has(getEventIdentity(turnId, event)));
        if (filtered.length !== events.length) {
          nextEventsByTurn[turnId] = filtered;
          changed = true;
        }
      }
    }

    return changed ? { ...session, eventsByTurn: nextEventsByTurn } : session;
  }

  private async catchUpSessionForRecovery(
    client: CloudOutboxClient,
    sessionId: string,
    sinceSeq: number,
  ): Promise<{
    serverSeq: number;
    pulledIdentities: Set<string>;
    appliedLocally: boolean;
  }> {
    if (client.catchUpSession) {
      const result = await client.catchUpSession(sessionId, sinceSeq);
      const appliedLocally = await this.applyCatchUpResult(sessionId, result);
      return {
        serverSeq: result.serverSeq,
        pulledIdentities: new Set(result.events.map((event) => getEventIdentity(event.turnId ?? '', event))),
        appliedLocally,
      };
    }

    if (!client.get) {
      throw new Error('Reconcile catch-up unavailable: client.get missing');
    }
    const get = client.get.bind(client);

    let cursor = sinceSeq;
    let serverSeq = sinceSeq;
    let hasMore = false;
    const allEvents: CatchUpEvent[] = [];
    let finalMessageDelta: AgentSession['messages'] | undefined;
    let finalMessageDeletes: string[] | undefined;
    let finalDestructiveOps: { truncatedTurns: string[]; deletedEventIdentities: string[] } | undefined;
    do {
      const query = new URLSearchParams({ sinceSeq: String(cursor), limit: '500' });
      const page = await get(`/api/sessions/${encodeURIComponent(sessionId)}/events?${query.toString()}`);
      const payload = page && typeof page === 'object' ? page as Record<string, unknown> : {};
      const pageEvents = Array.isArray(payload.events)
        ? payload.events.filter((event): event is CatchUpEvent => !!event && typeof event === 'object' && !Array.isArray(event))
        : [];
      hasMore = payload.hasMore === true;
      const pageServerSeq = typeof payload.serverSeq === 'number' && Number.isFinite(payload.serverSeq) ? payload.serverSeq : cursor;
      serverSeq = Math.max(serverSeq, pageServerSeq);
      allEvents.push(...pageEvents);
      const maxPageSeq = pageEvents.reduce((maxSeq, event) => isValidSeq(event.seq) ? Math.max(maxSeq, event.seq) : maxSeq, cursor);
      cursor = Math.max(cursor, maxPageSeq);
      if (!hasMore) {
        finalMessageDelta = Array.isArray(payload.messageDelta)
          ? payload.messageDelta.filter((message): message is AgentSession['messages'][number] => !!message && typeof message === 'object' && !Array.isArray(message) && typeof (message as { id?: unknown }).id === 'string')
          : undefined;
        finalMessageDeletes = Array.isArray(payload.messageDeletes)
          ? payload.messageDeletes.filter((id): id is string => typeof id === 'string' && id.length > 0)
          : undefined;
        const rawOps = payload.destructiveOpsApplied;
        if (rawOps && typeof rawOps === 'object' && !Array.isArray(rawOps)) {
          finalDestructiveOps = {
            truncatedTurns: Array.isArray((rawOps as { truncatedTurns?: unknown }).truncatedTurns)
              ? (rawOps as { truncatedTurns: unknown[] }).truncatedTurns.filter((id): id is string => typeof id === 'string')
              : [],
            deletedEventIdentities: Array.isArray((rawOps as { deletedEventIdentities?: unknown }).deletedEventIdentities)
              ? (rawOps as { deletedEventIdentities: unknown[] }).deletedEventIdentities.filter((id): id is string => typeof id === 'string')
              : [],
          };
        }
      }
    } while (hasMore);

    const appliedLocally = await this.applyCatchUpResult(sessionId, {
      events: allEvents,
      serverSeq,
      messageDelta: finalMessageDelta,
      messageDeletes: finalMessageDeletes,
      destructiveOpsApplied: finalDestructiveOps,
    });
    return {
      serverSeq,
      pulledIdentities: new Set(allEvents.map((event) => getEventIdentity(event.turnId ?? '', event))),
      appliedLocally,
    };
  }

  private async applyCatchUpResult(
    sessionId: string,
    result: {
      events: CatchUpEvent[];
      serverSeq: number;
      messageDelta?: AgentSession['messages'];
      messageDeletes?: string[];
      destructiveOpsApplied?: { truncatedTurns: string[]; deletedEventIdentities: string[] };
    },
  ): Promise<boolean> {
    const { getIncrementalSessionStore } = await import('../incrementalSessionStore');
    const store = getIncrementalSessionStore();
    const current = await store.getSession(sessionId);
    if (!current) return false;

    let nextSession = this.applyDestructiveOpsToSession(current, result.destructiveOpsApplied);
    const incomingByTurn: Record<string, AgentEvent[]> = {};
    for (const event of result.events) {
      const turnId = event.turnId;
      if (!turnId) continue;
      incomingByTurn[turnId] = [...(incomingByTurn[turnId] ?? []), event];
    }
    nextSession = {
      ...nextSession,
      eventsByTurn: mergeEventsForCloudPush(nextSession.eventsByTurn ?? {}, incomingByTurn),
      messages: result.messageDeletes && result.messageDeletes.length > 0
        ? (nextSession.messages ?? []).filter((message) => !(result.messageDeletes ?? []).includes(message.id))
        : nextSession.messages,
      maxSeq: Math.max(result.serverSeq, getMaxSeqFromSession(nextSession)),
    };
    if (result.messageDelta && result.messageDelta.length > 0) {
      nextSession = {
        ...nextSession,
        messages: deduplicateMessages(nextSession.messages ?? [], result.messageDelta, 'secondary-wins'),
      };
    }
    return (await this.upsertLocalSessionIfWritten(store, nextSession)) !== null;
  }

  private async restampLocalOnlyEventsAboveSeq(
    sessionId: string,
    ceilingSeq: number,
    pulledIdentities: Set<string>,
  ): Promise<AgentSession | null> {
    const { getIncrementalSessionStore } = await import('../incrementalSessionStore');
    const store = getIncrementalSessionStore();
    const session = await store.getSession(sessionId);
    if (!session) return null;

    let changed = false;
    const nextEventsByTurn: Record<string, AgentEvent[]> = { ...(session.eventsByTurn ?? {}) };
    for (const [turnId, events] of Object.entries(session.eventsByTurn ?? {})) {
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        if (!isValidSeq(event.seq) || event.seq > ceilingSeq) continue;
        if (pulledIdentities.has(getEventIdentity(turnId, event))) continue;
        if (!Array.isArray(nextEventsByTurn[turnId])) continue;
        if (nextEventsByTurn[turnId] === events) {
          nextEventsByTurn[turnId] = [...events];
        }
        const cloned = { ...event };
        delete cloned.seq;
        nextEventsByTurn[turnId][index] = cloned;
        changed = true;
      }
    }

    if (!changed) return session;
    const restamped = stampMissingEventSeq({ ...session, eventsByTurn: nextEventsByTurn, maxSeq: ceilingSeq });
    return this.upsertLocalSessionIfWritten(store, restamped);
  }

  private async pushFullSession(
    client: CloudOutboxClient,
    session: AgentSession,
  ): Promise<void> {
    const trackedCloudUpdatedAt = this.cloudUpdatedAtTracker.get(session.id);
    const localCloudUpdatedAt = typeof session.cloudUpdatedAt === 'number' && Number.isFinite(session.cloudUpdatedAt)
      ? session.cloudUpdatedAt
      : 0;
    const sessionWithCloudUpdatedAt = (
      trackedCloudUpdatedAt !== undefined
      && trackedCloudUpdatedAt > localCloudUpdatedAt
    )
      ? { ...session, cloudUpdatedAt: trackedCloudUpdatedAt }
      : session;
    const result = await pushFullSessionWithCapabilityGate(client, sessionWithCloudUpdatedAt);
    if (result.cloudUpdatedAt > 0) this.recordCloudUpdatedAt(session.id, result.cloudUpdatedAt);
    this.recordLastPushedSeq(session.id, result.serverSeq);
    this.recordLastPushedMessageIds(session.id, extractMessageIds(session.messages));
    this.recordLastPushedMetadataDigest(session.id, digestMetadataPatch(session));
    this.recordFullPut(session.id);
  }

  private getReconcileReason(sessionId: string, entry: OutboxEntry, now: number = Date.now()): 'count' | 'age' | null {
    if (this.getDeltaCount(sessionId) >= DELTA_PUSH_RECONCILE_COUNT) {
      return 'count';
    }

    const lastFullPutAt = this.getLastFullPutAt(sessionId) ?? entry.enqueuedAt;
    if (
      typeof lastFullPutAt === 'number'
      && Number.isFinite(lastFullPutAt)
      && now - lastFullPutAt > DELTA_PUSH_RECONCILE_AGE_MS
    ) {
      return 'age';
    }

    return null;
  }

  private async executeReconcileMetadataPatch(
    client: CloudOutboxClient,
    entry: OutboxEntry,
    latest: AgentSession,
    payload: DeltaPayload,
    hasDelta: boolean,
    depth: number,
    capabilities: CloudCapabilities,
    drainExpectedGeneration?: number,
  ): Promise<{ handledByRecursion: boolean; usedMetadataPatch: boolean }> {
    if (capabilities.supportsReconcileHandshake === true) {
      let reconcile: ReconcileHandshakeResponse;
      try {
        reconcile = await this.reconcileSessionHandshake(
          client,
          latest.id,
          this.getLastPushedSeq(latest.id) ?? 0,
        );
      } catch (err) {
        if (errorCode(err) === 'reconcile-handshake-invalid-response') {
          getErrorReporter().addBreadcrumb({
            category: 'cloud-sync',
            level: 'warning',
            message: 'session-reconcile-handshake:invalid-response',
            data: {
              sessionIdHash: hashForBreadcrumb(latest.id),
              baseSeq: payload.baseSeq,
            },
          });
        }
        throw err;
      }

      const drift = this.getReconcileHandshakeDrift({
        session: latest,
        turnChecksums: reconcile.turnChecksums,
      });
      if (drift.mismatchedTurnIds.length > 0) {
        recordSessionDeltaPushBreadcrumb({
          level: 'warning',
          message: 'reconcile-handshake:drift-detected',
          data: {
            sessionIdHash: hashForBreadcrumb(latest.id),
            mismatchCount: drift.mismatchedTurnIds.length,
            reconcileSinceSeq: drift.sinceSeq,
          },
        });
        const catchUp = await this.catchUpSessionForRecovery(client, latest.id, drift.sinceSeq);
        if (!catchUp.appliedLocally) {
          return { handledByRecursion: true, usedMetadataPatch: true };
        }
        this.recordLastPushedSeq(latest.id, catchUp.serverSeq);
        this.recordFullPut(latest.id);
        const { getIncrementalSessionStore } = await import('../incrementalSessionStore');
        const store = getIncrementalSessionStore();
        const latestAfterCatchUp = await store.getSession(latest.id);
        if (latestAfterCatchUp) {
          this.recordLastPushedMetadataDigest(latest.id, digestMetadataPatch(latestAfterCatchUp));
        }
        await this.executeDeltaUpsert(
          client,
          entry,
          latestAfterCatchUp ?? latest,
          depth + 1,
          drainExpectedGeneration,
        );
        return { handledByRecursion: true, usedMetadataPatch: false };
      }

      this.recordLastPushedSeq(latest.id, reconcile.serverSeq);
      this.recordFullPut(latest.id);
      recordSessionDeltaPushBreadcrumb({
        message: 'reconcile-handshake:matched',
        data: {
          sessionIdHash: hashForBreadcrumb(latest.id),
          serverSeq: reconcile.serverSeq,
          baseSeq: payload.baseSeq,
          hasDelta,
        },
      });
      return { handledByRecursion: false, usedMetadataPatch: false };
    }

    recordSessionDeltaPushBreadcrumb({
      message: 'reconcile-handshake:capability-missing-fallback',
      data: {
        sessionIdHash: hashForBreadcrumb(latest.id),
        baseSeq: payload.baseSeq,
      },
    });

    log.info(
      {
        sessionId: hashForBreadcrumb(latest.id),
        reason: 'capability-missing-fallback',
        deltaCountSinceFullPut: this.getDeltaCount(latest.id),
        lastFullPutAt: this.getLastFullPutAt(latest.id) ?? entry.enqueuedAt,
        hasMetadataPatch: Boolean(payload.metadataPatch),
        hasDelta,
      },
      'session-delta-push:reconcile-via-patch',
    );
    recordSessionDeltaPushBreadcrumb({
      message: 'reconcile-via-patch',
      data: {
        sessionIdHash: hashForBreadcrumb(latest.id),
        baseSeq: payload.baseSeq,
        hasMetadataPatch: Boolean(payload.metadataPatch),
        hasDelta,
      },
    });

    try {
      await this.patchMetadataOnly(client, latest, payload);
    } catch (err) {
      const recoveryHandled = await this.handleReconcilePatchFailure(
        err,
        client,
        entry,
        latest,
        payload,
        depth,
        drainExpectedGeneration,
      );
      if (recoveryHandled) {
        return { handledByRecursion: true, usedMetadataPatch: true };
      }
      throw err;
    }

    this.recordFullPut(latest.id);
    return { handledByRecursion: false, usedMetadataPatch: true };
  }

  /**
   * Recover from a failed reconcile-branch metadata PATCH. Without these
   * branches a 404/405/409 from PATCH propagates to the outer drain and
   * retries forever (the legacy pushFullSession path implicitly handled
   * these via PUT; the new metadata-patch path must handle them
   * explicitly).
   *
   * Returns true when recovery succeeded and the caller should return.
   * Returns false when the error is not recognized — caller re-throws so
   * the outer drain handles it as a transient failure with backoff.
   */
  private async handleReconcilePatchFailure(
    err: unknown,
    client: CloudOutboxClient,
    entry: OutboxEntry,
    latest: AgentSession,
    payload: DeltaPayload,
    depth: number,
    drainExpectedGeneration?: number,
  ): Promise<boolean> {
    const code = errorCode(err);
    const statusCode = errorStatusCode(err);

    // 405 (legacy server with no PATCH support) → fall back to the legacy
    // full-PUT path. We discriminate on 405 specifically before checking
    // 404, because cloud-client maps both to CAPABILITY_MISSING_FALLBACK
    // and we only want the legacy fallback when the HTTP verb truly isn't
    // supported.
    if (statusCode === 405 || (code === 'CAPABILITY_MISSING_FALLBACK' && statusCode !== 404)) {
      client.invalidateCapabilities?.();
      recordSessionDeltaPushBreadcrumb({
        message: 'reconcile-patch:capability-missing-fallback',
        data: { sessionIdHash: hashForBreadcrumb(latest.id), baseSeq: payload.baseSeq },
      });
      await this.pushFullSession(client, latest);
      return true;
    }

    // 404 (cloud lost the session) → bootstrap via shell PUT, then recurse
    // through executeDeltaUpsert so the delta append re-runs on the fresh
    // baseline. Depth-bounded to prevent runaway recursion.
    if (code === 'NEEDS_BOOTSTRAP' || statusCode === 404) {
      recordSessionDeltaPushBreadcrumb({
        message: 'reconcile-patch:needs-bootstrap',
        data: { sessionIdHash: hashForBreadcrumb(latest.id), baseSeq: payload.baseSeq },
      });
      await this.executeBootstrapCreateThenAppend(client, latest);
      if (depth < 1) {
        await this.executeDeltaUpsert(client, entry, latest, depth + 1, drainExpectedGeneration);
        return true;
      }
      // Depth-bounded: bootstrap completed (shell only), but the delta
      // events were NOT pushed. Returning true here would tell the outer
      // drain to markSucceeded → entry deleted → events permanently lost.
      // Return false so the original error propagates and the entry stays
      // pending for the next drain to retry against the fresh baseline.
      return false;
    }

    // 409 NEEDS_RECONCILE (response-loss retry sending stale
    // clientCloudUpdatedAt) → catch up from cloud, then recurse so the
    // delta append re-runs against the fresh server seq. Depth-bounded;
    // the existing executeDeltaUpsert NEEDS_RECONCILE branch already
    // handles depth ≥ 2 via pushFullSession fallback.
    if (code === 'NEEDS_RECONCILE' || (statusCode === 409 && err instanceof Error && /reconcile/i.test(err.message))) {
      recordSessionDeltaPushBreadcrumb({
        level: 'warning',
        message: 'reconcile-patch:needs-reconcile',
        data: { sessionIdHash: hashForBreadcrumb(latest.id), baseSeq: payload.baseSeq },
      });
      if (depth >= 2) {
        await this.pushFullSession(client, latest);
        return true;
      }
      const catchUp = await this.catchUpSessionForRecovery(client, latest.id, payload.baseSeq);
      if (!catchUp.appliedLocally) {
        return true;
      }
      this.recordLastPushedSeq(latest.id, catchUp.serverSeq);
      const restamped = await this.restampLocalOnlyEventsAboveSeq(latest.id, catchUp.serverSeq, catchUp.pulledIdentities);
      this.bumpEntryGeneration(entry.id);
      // bumpEntryGeneration deliberately invalidates the captured value so
      // the recursive call recaptures a fresh generation locally; threading
      // the stale drainExpectedGeneration would defeat that intent and force
      // an unnecessary extra drain tick to converge.
      await this.executeDeltaUpsert(client, entry, restamped ?? latest, depth + 1);
      return true;
    }

    return false;
  }

  private async executeDeltaUpsert(
    client: CloudOutboxClient,
    entry: OutboxEntry,
    session: AgentSession,
    depth = 0,
    drainExpectedGeneration?: number,
  ): Promise<void> {
    // Capture BEFORE any await. The outer drain captures pre-await for the
    // initial call (drainExpectedGeneration). Recursive callers (NEEDS_RECONCILE
    // / NEEDS_BOOTSTRAP retries) intentionally start fresh and rely on this
    // pre-await capture to close the same race window.
    const expectedGeneration = drainExpectedGeneration ?? this.getEntryGeneration(entry.id);

    const localMaxSeq = getMaxSeqFromSession(session);
    const cursor = this.getLastPushedSeq(session.id);
    if (cursor !== undefined && cursor > localMaxSeq) {
      this.recordLastPushedSeq(session.id, undefined);
      log.warn(
        { sessionId: hashForBreadcrumb(session.id), cursor, localMaxSeq },
        'session-delta-push:lying-cursor-detected',
      );
      getErrorReporter().addBreadcrumb({
        category: 'cloud-sync',
        level: 'warning',
        message: 'session-delta-push:lying-cursor-detected',
        data: { sessionIdHash: hashForBreadcrumb(session.id), cursor, localMaxSeq },
      });
    }

    const capabilities = await this.getCapabilities(client);
    if (capabilities.supportsDeltaPush !== true) {
      recordSessionDeltaPushBreadcrumb({
        message: 'capability-missing-fallback',
        data: { sessionIdHash: hashForBreadcrumb(session.id), baseSeq: this.getLastPushedSeq(session.id) ?? 0 },
      });
      await this.pushFullSession(client, session);
      return;
    }

    if (this.getLastPushedSeq(session.id) === undefined) {
      const seedResult = await this.seedCursorFromCloudIfPossible(client, session);
      if (seedResult === 'tombstoned') return;
    }

    const { getIncrementalSessionStore } = await import('../incrementalSessionStore');
    const store = getIncrementalSessionStore();
    const latest = await store.getSession(session.id);
    if (!latest) {
      this.markSucceeded(session.id);
      this.clearSessionTrackers(session.id);
      return;
    }

    const payload = this.computeDeltaPayload(latest, entry);
    const hasDelta = payload.events.length > 0
      || payload.messageDelta.length > 0
      || payload.messageDeletes.length > 0
      || Boolean(payload.destructiveOps);

    const reconcileReason = this.getReconcileReason(latest.id, entry);
    if (reconcileReason) {
      // Force a metadata-patch round-trip even when the digest matches the
      // last push: the reconcile cadence's job is to detect drift between
      // local and cloud baselines, which requires real wire traffic. Skipping
      // the metadata-path machinery because nothing-changed defeats periodic
      // drift detection (legacy servers use PATCH fallback; handshake-capable
      // servers use per-turn checksums).
      if (!payload.metadataPatch) {
        payload.metadataPatch = metadataPatchSubset(latest);
        payload.metadataDigest = digestMetadataPatch(latest);
      }

      const reconcileResult = await this.executeReconcileMetadataPatch(
        client,
        entry,
        latest,
        payload,
        hasDelta,
        depth,
        capabilities,
        drainExpectedGeneration,
      );
      if (reconcileResult.handledByRecursion) return;

      if (this.getEntryGeneration(entry.id) !== expectedGeneration) {
        recordSessionDeltaPushBreadcrumb({
          level: 'info',
          message: 'reconcile-patch:generation-bumped-defer',
          data: {
            sessionIdHash: hashForBreadcrumb(latest.id),
            expectedGeneration,
            actualGeneration: this.getEntryGeneration(entry.id),
          },
        });
        return;
      }

      if (reconcileResult.usedMetadataPatch) {
        // patchMetadataOnly already recorded the metadata digest. Strip
        // metadataPatch from the delta payload so the subsequent
        // appendSessionDelta POST does not resend the same metadata (which
        // would waste bytes). Note: since REBEL-68C the idempotency key
        // fingerprints metadataPatch too, so this strip is now purely a
        // byte-saving optimization — it no longer guards against the
        // idempotency-mismatch 500 (buildIdempotencyKey handles that).
        payload.metadataPatch = undefined;
      }

      if (!hasDelta) {
        this.markSucceeded(latest.id, expectedGeneration);
        return;
      }
      // Fall through to the normal delta-append path on the same tick.
    }

    if (!hasDelta) {
      await this.patchMetadataOnly(client, latest, payload);
      return;
    }

    try {
      // Stage A5: chunk the payload into one-or-more POSTs whose serialized
      // body each stay under DELTA_CHUNK_BYTE_BUDGET. Single-chunk payloads
      // (the steady-state case) route through the same fast path as before;
      // multi-chunk payloads sequence chunks under the per-session mutex with
      // tombstone-aware error handling and final-chunk applyAppendSuccess
      // bookkeeping. Errors from any chunk propagate to the existing catch
      // block below — chunks already POSTed have advanced the cursor, so the
      // next drain re-derives the payload from current state.
      await this.appendSessionDeltaChunked(client, latest, entry, payload, expectedGeneration);
    } catch (err) {
      if (err instanceof OversizedChunkError) {
        // Two paths:
        //   1. Sideline-and-retry — one or more events in the failed chunk
        //      are individually over the effective budget. Record them in
        //      oversizedEventIds, bump entry generation, and re-throw. The
        //      outer drain calls markAttemptFailed; the next drain re-derives
        //      the payload without the sidelined events and converges.
        //   2. Envelope fallback — no single event is oversized; the body
        //      bloat comes from messageDelta / metadataPatch / destructiveOps.
        //      Fall back to the legacy pushFullSession path (bounded by A4's
        //      100MB cap). If pushFullSession ALSO exceeds the cap, A2's
        //      body-too-large terminal classification kicks in via the cloud
        //      413 response — documented residual.
        if (this.sidelineOversizedEventsFromChunk(latest, entry, err)) {
          throw err;
        }
        log.warn(
          {
            sessionId: hashForBreadcrumb(latest.id),
            wireBytes: err.wireBytes,
            limit: err.limit,
            hasMessageDelta: err.hasMessageDelta,
            hasMessageDeletes: err.hasMessageDeletes,
            hasMetadataPatch: err.hasMetadataPatch,
            hasDestructiveOps: err.hasDestructiveOps,
            eventCount: err.events.length,
          },
          'session-delta-push:envelope-oversized-fallback-fullput',
        );
        getErrorReporter().addBreadcrumb({
          category: 'cloud-sync',
          level: 'warning',
          message: 'session-delta-push:envelope-oversized-fallback-fullput',
          data: {
            sessionIdHash: hashForBreadcrumb(latest.id),
            wireBytes: err.wireBytes,
            limit: err.limit,
            hasMessageDelta: err.hasMessageDelta,
            hasMetadataPatch: err.hasMetadataPatch,
          },
        });
        await this.pushFullSession(client, latest);
        return;
      }

      const code = errorCode(err);
      const statusCode = errorStatusCode(err);

      if (code === 'CAPABILITY_MISSING_FALLBACK' || statusCode === 405) {
        client.invalidateCapabilities?.();
        recordSessionDeltaPushBreadcrumb({
          message: 'capability-missing-fallback',
          data: { sessionIdHash: hashForBreadcrumb(latest.id), baseSeq: payload.baseSeq },
        });
        await this.pushFullSession(client, latest);
        return;
      }

      if (code === 'NEEDS_BOOTSTRAP' || statusCode === 404) {
        recordSessionDeltaPushBreadcrumb({
          message: 'needs-bootstrap',
          data: { sessionIdHash: hashForBreadcrumb(latest.id), baseSeq: payload.baseSeq },
        });
        await this.executeBootstrapCreateThenAppend(client, latest);
        if (depth < 1) {
          await this.executeDeltaUpsert(client, entry, latest, depth + 1);
          return;
        }
      }

      if (code === 'NEEDS_RECONCILE' || (statusCode === 409 && err instanceof Error && /reconcile/i.test(err.message))) {
        if (depth >= 2) {
          getErrorReporter().addBreadcrumb({
            category: 'cloud-sync',
            level: 'warning',
            message: 'session-delta-push:reconcile-fallback-fullput',
            data: { sessionIdHash: hashForBreadcrumb(latest.id) },
          });
          await this.pushFullSession(client, latest);
          return;
        }
        getErrorReporter().addBreadcrumb({
          category: 'cloud-sync',
          level: 'warning',
          message: 'session-delta-push:needs-reconcile',
          data: { sessionIdHash: hashForBreadcrumb(latest.id), baseSeq: payload.baseSeq },
        });
        recordSessionDeltaPushBreadcrumb({
          level: 'warning',
          message: 'needs-reconcile',
          data: { sessionIdHash: hashForBreadcrumb(latest.id), baseSeq: payload.baseSeq },
        });
        const catchUp = await this.catchUpSessionForRecovery(client, latest.id, payload.baseSeq);
        if (!catchUp.appliedLocally) {
          return;
        }
        this.recordLastPushedSeq(latest.id, catchUp.serverSeq);
        const restamped = await this.restampLocalOnlyEventsAboveSeq(latest.id, catchUp.serverSeq, catchUp.pulledIdentities);
        this.bumpEntryGeneration(entry.id);
        await this.executeDeltaUpsert(client, entry, restamped ?? latest, depth + 1);
        return;
      }

      if (code === 'INVALID_SEQ') {
        getErrorReporter().captureMessage('session-delta-push:invalid-seq', {
          level: 'error',
          extra: { sessionIdHash: hashForBreadcrumb(latest.id) },
        });
        this.markPermanentlyFailed(
          latest.id,
          err instanceof Error ? err.message : 'INVALID_SEQ',
          'unknown-permanent',
        );
        return;
      }

      if (code === 'INVALID_ENVELOPE') {
        getErrorReporter().addBreadcrumb({
          category: 'cloud-sync',
          level: 'error',
          message: 'session-delta-push:invalid-envelope',
          data: { sessionIdHash: hashForBreadcrumb(latest.id) },
        });
        getErrorReporter().captureMessage('session-delta-push:invalid-envelope', {
          level: 'error',
          extra: { sessionIdHash: hashForBreadcrumb(latest.id) },
        });
        this.markPermanentlyFailed(
          latest.id,
          err instanceof Error ? err.message : 'INVALID_ENVELOPE',
          'unknown-permanent',
        );
        return;
      }

      throw err;
    }
  }

  /**
   * Returns all session IDs with pending delete entries.
   * Used by pull sync to suppress bulk upserts for sessions pending local delete delivery.
   */
  getPendingDeleteSessionIds(): Set<string> {
    this.load();
    const ids = new Set<string>();
    for (const entry of this.entries.values()) {
      if (entry.op === 'delete' && entry.status === 'pending') {
        ids.add(entry.sessionId);
      }
    }
    return ids;
  }

  /**
   * Drop pending upserts that are known to be tombstoned on cloud.
   * Used by cloud continuity pull to avoid resurrecting deleted sessions.
   *
   * @returns Session IDs that were suppressed.
   */
  suppressTombstonedUpserts(isTombstoned: (sessionId: string) => boolean): string[] {
    this.load();
    const suppressed: string[] = [];
    for (const [sessionId, entry] of this.entries) {
      if (entry.op !== 'upsert' || entry.status !== 'pending') continue;
      if (!isTombstoned(sessionId)) continue;
      this.entries.delete(sessionId);
      this.entryGeneration.delete(entry.id);
      this.clearSessionTrackers(sessionId);
      suppressed.push(sessionId);
    }
    if (suppressed.length > 0) {
      this.scheduleDiskWrite();
      log.info({ suppressed: suppressed.length }, 'Suppressed tombstoned outbox upserts');
    }
    return suppressed;
  }

  /**
   * Drain the outbox: deliver all due entries to the cloud service.
   * Protected by a mutex: concurrent callers await the in-progress drain
   * and return an empty outcome (they didn't do the work themselves).
   *
   * @param client - The cloud bridge HTTP client
   * @param onStatusChange - Optional callback fired after each delivery (for push events)
   * @returns DrainResult with ok/failed/authFailures counts. Callers MUST pass
   *   the verdict to CloudFailureCooldown.recordCooldownVerdict() — drain()
   *   resolving does NOT mean delivery succeeded.
   */
  async drain(
    client: CloudOutboxClient,
    onStatusChange?: (status: OutboxStatus) => void,
  ): Promise<DrainResult> {
    // If a drain is already in progress, wait for it instead of silently skipping.
    // This ensures cloud:destroy's "final drain" isn't lost when focus-triggered drain is running.
    if (this.drainPromise) {
      const waitStartedAt = Date.now();
      log.info('Outbox drain already in progress, awaiting');
      await this.drainPromise;
      const waitedMs = Math.max(0, Date.now() - waitStartedAt);
      recordOutboxContinuityBreadcrumb({
        level: 'warning',
        message: 'state-transition',
        data: {
          sessionIdHash: hashForBreadcrumb(this.currentCloudUrl ?? 'desktop-outbox'),
          from: 'cloud_active',
          to: 'cloud_active',
          reason: 'session-mutex-contention',
          kind: 'session-mutex-contention',
          waitedMs,
          label: 'cloudOutbox.drain',
        },
      });
      return { ok: 0, failed: 0, authFailures: 0 };
    }

    this.drainPromise = outboxMutex.withLock(
      this.getDrainLockKey(),
      () => this.executeDrain(client, onStatusChange),
      { label: 'cloudOutbox.drain' },
    );
    try {
      return await this.drainPromise;
    } finally {
      this.drainPromise = null;
    }
  }

  /**
   * Internal drain implementation.
   *
   * Each entry is replayed idempotently:
   * - upsert: reads current session state from the local store, then PUTs to cloud.
   *   If the session no longer exists locally (deleted after enqueue), skip it.
   * - delete: sends a DELETE to the cloud.
   */
  private async executeDrain(
    client: CloudOutboxClient,
    onStatusChange?: (status: OutboxStatus) => void,
  ): Promise<DrainResult> {
    const startedAt = Date.now();
    const due = this.getDueEntries();
    if (due.length === 0) return { ok: 0, failed: 0, authFailures: 0 };

    let ok = 0;
    let failed = 0;
    let authFailures = 0;
    let sampleError: unknown;

    for (const entry of due) {
      let entryRawBytes = 0;
      let entryGzipped = false;
      // Captured at the TOP of the iteration, before ANY await for this entry.
      // A concurrent enqueue during downstream awaits (store.getSession,
      // getCapabilities, etc.) can bump generation between the start of work
      // and the local capture inside executeDeltaUpsert; if we instead
      // captured later, the captured-value-from-after-bump would compare
      // equal to the live value, defeating the generation guard. The captured
      // value is threaded into executeDeltaUpsert so the inner success path
      // uses the same contract as the outer drain.
      const drainExpectedGeneration = this.getEntryGeneration(entry.id);
      try {
        if (entry.op === 'upsert') {
          // Fetch current session state at drain time (not stale snapshot)
          const { getIncrementalSessionStore } = await import('../incrementalSessionStore');
          const store = getIncrementalSessionStore();
          const session = await store.getSession(entry.sessionId);

          if (!session) {
            // Session was deleted locally after enqueue — skip the upsert
            log.info(
              { sessionId: entry.sessionId },
              'Outbox upsert skipped: session no longer exists locally',
            );
            this.markSucceeded(entry.sessionId);
            this.clearSessionTrackers(entry.sessionId);
            ok++;
            try {
              log.debug(
                {
                  sessionId: hashForBreadcrumb(entry.sessionId),
                  op: entry.op,
                  rawBytes: 0,
                  gzipped: false,
                  success: true,
                  skipped: 'local-session-deleted',
                },
                'outbox_drain_size',
              );
            } catch {
              // Logger failures must not perturb drain accounting.
            }
            continue;
          }

          entryRawBytes = Buffer.byteLength(JSON.stringify(session), 'utf-8');
          entryGzipped = entryRawBytes >= OUTBOX_GZIP_BODY_THRESHOLD_BYTES;
          await this.executeDeltaUpsert(client, entry, session, 0, drainExpectedGeneration);
        } else {
          await client.delete(`/api/sessions/${encodeURIComponent(entry.sessionId)}`);
          // Session is gone on cloud — no future pushes, so evict tracker entry.
          this.clearSessionTrackers(entry.sessionId);
        }

        const liveEntry = this.entries.get(entry.sessionId);
        if (liveEntry?.status === 'permanent_failure') {
          failed += 1;
          if (sampleError === undefined) sampleError = liveEntry.lastError;
          onStatusChange?.(this.getStatus());
          continue;
        }

        this.markSucceeded(entry.sessionId, drainExpectedGeneration);
        ok++;
        onStatusChange?.(this.getStatus());
        try {
          log.debug(
            {
              sessionId: hashForBreadcrumb(entry.sessionId),
              op: entry.op,
              rawBytes: entryRawBytes,
              gzipped: entryGzipped,
              success: true,
            },
            'outbox_drain_size',
          );
        } catch {
          // Logger failures must not perturb drain accounting.
        }
        log.info(
          { sessionId: entry.sessionId, op: entry.op },
          'Outbox entry delivered successfully',
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        if (isConfirmedTombstoneError(err)) {
          // Cloud has structured proof the session is tombstoned. Route through
          // the centralized handler so quarantine snapshot, audit log, Sentry
          // capture (with proof shape), generation guard, and tracker clear all
          // run from a single point. The cloud already holds the terminal state
          // so when the generation matches this is structurally a "delivered"
          // outcome; if a concurrent enqueue bumped the generation the entry is
          // preserved for the next drain and we do NOT count it delivered.
          const wasDeleted = await this.applyConfirmedTombstone(
            entry.sessionId,
            drainExpectedGeneration,
            describeTombstoneProof(err),
          );
          if (wasDeleted) {
            ok++;
          }
          onStatusChange?.(this.getStatus());
          try {
            log.debug(
              {
                sessionId: hashForBreadcrumb(entry.sessionId),
                op: entry.op,
                rawBytes: entryRawBytes,
                gzipped: entryGzipped,
                success: wasDeleted,
                skipped: 'session-tombstoned',
                generationBumped: !wasDeleted,
              },
              'outbox_drain_size',
            );
          } catch {
            // Logger failures must not perturb drain accounting.
          }
          continue;
        }

        if (isPermanentFailure(err)) {
          const statusCode = errorStatusCode(err);
          const code = errorCode(err);
          const terminalReason: TerminalReason = (
            statusCode === 413
            || code === 'BODY_TOO_LARGE'
            || /\bBODY_TOO_LARGE\b/.test(message)
          )
            ? 'body-too-large'
            : 'unknown-permanent';
          this.markPermanentlyFailed(entry.sessionId, message, terminalReason);
        } else {
          this.markAttemptFailed(entry.sessionId, message);
        }
        failed += 1;
        if (isAuthFailure(err)) authFailures += 1;
        if (sampleError === undefined) sampleError = message;
        onStatusChange?.(this.getStatus());
        try {
          log.debug(
            {
              sessionId: hashForBreadcrumb(entry.sessionId),
              op: entry.op,
              rawBytes: entryRawBytes,
              gzipped: entryGzipped,
              success: false,
            },
            'outbox_drain_size',
          );
        } catch {
          // Logger failures must not perturb drain accounting.
        }
        log.warn(
          { sessionId: entry.sessionId, op: entry.op, err: message },
          'Outbox entry delivery failed',
        );
      }
    }

    const durationMs = Math.max(0, Date.now() - startedAt);
    const ratePerSec = durationMs > 0 ? ok / (durationMs / 1000) : ok;
    log.info(
      {
        dueCount: due.length,
        delivered: ok,
        failed,
        authFailures,
        durationMs,
        ratePerSec: Number(ratePerSec.toFixed(2)),
      },
      'Outbox drain summary',
    );

    const result: DrainResult = { ok, failed, authFailures };
    if (sampleError !== undefined) result.sampleError = sampleError;
    return result;
  }

  // ---- Instance scoping ---------------------------------------------------

  /**
   * Notify the outbox that the cloud connection target has changed.
   * If the URL differs from the previous connection, all pending entries are
   * cleared — they belong to a different cloud instance and must not be replayed.
   */
  onConnectionChanged(cloudUrl: string): void {
    // Ensure persisted URL and entries are loaded before comparing
    this.load();
    if (this.currentCloudUrl !== null && this.currentCloudUrl !== cloudUrl) {
      log.warn(
        { oldUrl: this.currentCloudUrl, newUrl: cloudUrl },
        'Cloud URL changed — clearing outbox entries from previous instance',
      );
      this.clearAll();
    }
    this.currentCloudUrl = cloudUrl;
    // Persist the URL so it survives restarts
    this.scheduleDiskWrite();
  }

  /**
   * Remove all entries from the outbox and write empty state to disk immediately.
   */
  clearAll(): void {
    const count = this.entries.size;
    if (count > 0) {
      log.info({ count }, 'Clearing all outbox entries');
    }
    this.entries = new Map();
    this.cloudUpdatedAtTracker = new Map();
    this.lastPushedSeqTracker = new Map();
    this.lastPushedMetadataDigest = new Map();
    this.lastPushedMessageIds = new Map();
    this.deltaCountSinceFullPut = new Map();
    this.lastFullPutAt = new Map();
    this.entryGeneration = new Map();
    this.oversizedEventIds = new Map();
    this.loaded = true;
    this.lastSuccessfulDrainAt = Date.now();
    // Write immediately (not debounced) to ensure stale entries don't survive a crash
    this.writeToDisk();
  }

  private startStallMonitor(): void {
    if (this.stallTimer) return;
    this.stallTimer = setInterval(() => this.checkForStalledOutbox(), STALL_CHECK_INTERVAL_MS);
    this.stallTimer.unref?.();
  }

  private stopStallMonitor(): void {
    if (!this.stallTimer) return;
    clearInterval(this.stallTimer);
    this.stallTimer = null;
  }

  private checkForStalledOutbox(): void {
    let pendingDepth = 0;
    for (const entry of this.entries.values()) {
      if (entry.status === 'pending') pendingDepth++;
    }
    if (pendingDepth <= 0) return;

    const now = Date.now();
    const ageMs = now - this.lastSuccessfulDrainAt;
    if (ageMs < STALL_THRESHOLD_MS) return;
    if (now - this.lastStallEscalatedAt < STALL_ESCALATION_THROTTLE_MS) return;
    this.lastStallEscalatedAt = now;

    const data = {
      reason: 'stuck-outbox',
      deviceIdHash: hashForBreadcrumb(this.currentCloudUrl ?? 'desktop-outbox'),
      depth: pendingDepth,
      lastDrainAt: this.lastSuccessfulDrainAt,
      ageMs,
    };

    recordOutboxContinuityBreadcrumb({
      level: 'warning',
      message: 'stuck-outbox',
      data,
    });
    getErrorReporter().captureMessage('Desktop outbox appears stuck', {
      level: 'warning',
      tags: {
        continuity_event: 'continuity-state:stuck-outbox',
        surface: 'desktop',
      },
      extra: data,
    });
  }

  // ---- Testing ------------------------------------------------------------

  /**
   * Reset in-memory state (for tests only).
   */
  _resetForTesting(): void {
    this.entries = new Map();
    this.cloudUpdatedAtTracker = new Map();
    this.lastPushedSeqTracker = new Map();
    this.lastPushedMetadataDigest = new Map();
    this.lastPushedMessageIds = new Map();
    this.deltaCountSinceFullPut = new Map();
    this.lastFullPutAt = new Map();
    this.entryGeneration = new Map();
    this.oversizedEventIds = new Map();
    this.loaded = false;
    this.drainPromise = null;
    this.currentCloudUrl = null;
    this.lastSuccessfulDrainAt = Date.now();
    this.lastStallEscalatedAt = 0;
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.stopStallMonitor();
    this.startStallMonitor();
  }

  _checkForStuckOutboxForTesting(): void {
    this.checkForStalledOutbox();
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const cloudOutbox = new CloudOutbox();
