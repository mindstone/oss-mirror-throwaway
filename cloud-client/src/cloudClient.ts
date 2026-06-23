// cloud-client/src/cloudClient.ts

/**
 * Cloud Client — Platform-agnostic HTTP/WS client for the Rebel cloud service.
 *
 * Uses fetch for HTTP and built-in WebSocket for WS (with query-param auth).
 * Includes retry with exponential backoff for network resilience.
 */

import type { IpcChannelName, IpcRequestOf, IpcResponseOf } from '@shared/ipc/contracts';
import type { AgentEvent, AgentSessionMetadataPatch, AgentTurnMessage } from '@shared/types';
import type { CloudPressureBasic } from '@shared/types/cloudHealth';
import type { DiagnosticSections, SectionId } from '@shared/diagnostics/diagnosticBundleSections';
import type { FeedbackRequest } from './types';
import { z } from 'zod';
import { createLogger } from './utils/logger';
import type { SlackRecentSender } from './types/slackRecentSender';
import {
  ClearSlackRecentSendersResponseSchema,
  ListSlackRecentSendersResponseSchema,
  RemoveSlackRecentSenderRequestSchema,
  RemoveSlackRecentSenderResponseSchema,
} from './types/slackRecentSender';
import {
  hashForBreadcrumb,
  type ContinuityTransitionEvent,
} from './observability/continuityEvents';
import { isValidAgentEventEnvelope } from './utils/eventEnvelopeValidator';

/** Maps a channel's Zod-inferred request type to ipcCall rest-arguments. */
type IpcCallArgs<C extends IpcChannelName> = IpcRequestOf<C> extends void ? [] : [IpcRequestOf<C>];

const log = createLogger('cloudClient');

function emitEnvelopeRejectedContinuityEvent(event: ContinuityTransitionEvent): void {
  log.warn(`${event.family}:${event.message}`, event.data);
}

function validateCatchUpEvents(args: {
  events: unknown[];
  sessionId: string;
  message: 'envelope-rejected' | 'envelope-rejected-on-catch-up';
}): AgentEvent[] {
  // Rejection is observable (continuity event + warn log) but the catch-up
  // cursor still advances based on validated events' max seq. Holding the
  // cursor on a permanently-rejected event would block all subsequent catch-up
  // for that session indefinitely; the explicit trade-off is to skip the
  // structurally invalid event, surface it via observability, and let later
  // valid events drive cursor advancement. This closes the original
  // bogus-high-seq hole (malformed event with seq=999 used to advance
  // appliedSeq past valid lower seqs) without introducing an indefinite-stall
  // failure mode for legitimately corrupt events.
  const validEvents: AgentEvent[] = [];
  for (const candidate of args.events) {
    const result = isValidAgentEventEnvelope(candidate);
    if (result.valid) {
      validEvents.push(result.event);
      continue;
    }

    emitEnvelopeRejectedContinuityEvent({
      family: 'session-merge',
      message: args.message,
      level: 'warning',
      data: {
        direction: 'desktop-pull',
        sessionIdHash: hashForBreadcrumb(args.sessionId),
        reason: result.reason,
      },
    });
  }
  return validEvents;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === 'object' && !Array.isArray(input);
}

function isValidAgentMessageShape(input: unknown): input is AgentTurnMessage {
  if (!isRecord(input)) return false;
  if (typeof input.id !== 'string' || input.id.length === 0) return false;
  if (typeof input.turnId !== 'string' || input.turnId.length === 0) return false;
  if (input.role !== 'user' && input.role !== 'assistant' && input.role !== 'result') return false;
  if (typeof input.text !== 'string') return false;
  if (typeof input.createdAt !== 'number' || !Number.isFinite(input.createdAt)) return false;
  return true;
}

function validateMessageDelta(input: unknown): AgentTurnMessage[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const messages: AgentTurnMessage[] = [];
  for (const candidate of input) {
    if (!isValidAgentMessageShape(candidate)) continue;
    messages.push(JSON.parse(JSON.stringify(candidate)) as AgentTurnMessage);
  }
  return messages;
}

function validateStringArray(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const strings = input.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  return strings.length === input.length ? strings : undefined;
}

export type DestructiveOpsApplied = {
  truncatedTurns: string[];
  deletedEventIdentities: string[];
};

function isValidDestructiveOpsAppliedShape(input: unknown): input is DestructiveOpsApplied {
  if (!isRecord(input)) return false;
  return Array.isArray(input.truncatedTurns)
    && input.truncatedTurns.every((entry) => typeof entry === 'string')
    && Array.isArray(input.deletedEventIdentities)
    && input.deletedEventIdentities.every((entry) => typeof entry === 'string');
}

function validateDestructiveOpsApplied(input: unknown): DestructiveOpsApplied | undefined {
  if (!isValidDestructiveOpsAppliedShape(input)) return undefined;
  return {
    truncatedTurns: [...input.truncatedTurns],
    deletedEventIdentities: [...input.deletedEventIdentities],
  };
}

function isCloudPressureState(input: unknown): input is CloudPressureBasic['state'] {
  return input === 'ok' || input === 'warning' || input === 'critical' || input === 'unknown';
}

function normalizeCloudPressureBasic(input: unknown): CloudPressureBasic | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  if (!isCloudPressureState(input.state)) {
    return undefined;
  }
  if (typeof input.oomRecent !== 'boolean' || typeof input.recentRestart !== 'boolean') {
    return undefined;
  }
  return {
    state: input.state,
    oomRecent: input.oomRecent,
    recentRestart: input.recentRestart,
  };
}

let on401Callback: (() => void) | null = null;

/** Register a callback invoked on any 401 response (e.g. to trigger re-pair). */
export function onUnauthorized(cb: () => void): void {
  on401Callback = cb;
}

/** Trigger the registered 401 handler from code paths that bypass cloudClient (e.g. direct uploads). */
export function fireUnauthorized(): void {
  on401Callback?.();
}

type CloudClientConfig = {
  cloudUrl: string;
  token: string;
  clientId?: string;
};

let config: CloudClientConfig | null = null;
let warnedMissingTombstonesServerNow = false;
let lastSeenCapabilities: string[] | null = null;

function isLocalDevelopmentCloudUrl(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
}

function isSecureCloudUrl(cloudUrl: string): boolean {
  try {
    const parsed = new URL(cloudUrl);
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && isLocalDevelopmentCloudUrl(parsed);
  } catch {
    return false;
  }
}

export function configure(cfg: CloudClientConfig): void {
  const normalizedClientId = typeof cfg.clientId === 'string' && cfg.clientId.trim().length > 0
    ? cfg.clientId.trim()
    : undefined;
  const normalizedCloudUrl = cfg.cloudUrl.replace(/\/+$/, '');
  if (!isSecureCloudUrl(normalizedCloudUrl)) {
    log.warn('Configured insecure cloudUrl; binary uploads will be blocked until this is updated', {
      cloudUrl: normalizedCloudUrl,
      reason: 'cloud-url-not-https',
    });
  }
  if (config?.cloudUrl !== normalizedCloudUrl) {
    lastSeenCapabilities = null;
  }
  config = {
    cloudUrl: normalizedCloudUrl,
    token: cfg.token,
    ...(normalizedClientId ? { clientId: normalizedClientId } : {}),
  };
}

export function isConfigured(): boolean {
  return config !== null;
}

/**
 * Snapshot of the currently-configured cloud client URL + token.
 *
 * Exposed for narrow consumers (e.g. {@link mapImageRef}) that must build
 * authenticated cloud asset URLs without taking a hard dependency on the
 * underlying module-level config variable. Returns `null` when the client has
 * not yet been configured so callers can throw a friendly error.
 */
export function getCloudClientConfig(): { cloudUrl: string; token: string; clientId?: string } | null {
  if (!config) return null;
  return { ...config };
}

export function clearConfig(): void {
  config = null;
  warnedMissingTombstonesServerNow = false;
  lastSeenCapabilities = null;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = 1_000;
const HEALTH_CHECK_RETRIES = 2;
const HEALTH_CHECK_BACKOFF_MS = 2_500;
const CATCH_UP_SESSION_PAGE_LIMIT = 500;
const CATCH_UP_CONTINUITY_TOTAL_LIMIT = 5_000;
const DIAGNOSTIC_SECTION_IDS = [
  'provider_reachability',
  'health_timing',
  'index_health',
  'pre_turn_worker',
  'auto_update_forensics',
  'settings_drift',
  'cost_summary',
  'continuity_trail',
  'recent_events',
  'recent_logs',
] as const satisfies readonly SectionId[];

export class CloudClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly responseBody?: unknown,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'CloudClientError';
  }
}

function assertCloudUrlIsSecureForUploads(cloudUrl: string): void {
  if (isSecureCloudUrl(cloudUrl)) {
    return;
  }
  throw new CloudClientError(
    'Cloud URL must use https:// unless targeting localhost or 127.0.0.1.',
    undefined,
    undefined,
    'cloud-url-not-https',
  );
}

export type CloudCapabilities = {
  supportsDeltaPush: boolean;
  supportsMetadataPatch: boolean;
  supportsContentRefs: boolean;
  supportsReconcileHandshake: boolean;
  supportsResourcePressure: boolean;
  raw: string[];
};

export type AgentEventForPush = AgentEvent & { clientOrdinal: number };

export type AppendEventsArgs = {
  baseSeq: number;
  events: AgentEventForPush[];
  messageDelta?: AgentTurnMessage[];
  messageDeletes?: string[];
  _destructiveOps?: {
    truncateTurns?: string[];
    deleteEventIdentities?: string[];
  };
  idempotencyKey?: string;
  metadataPatch?: AgentSessionMetadataPatch;
};

export type AppendEventsResult =
  | {
      kind: 'applied';
      appliedCount: number;
      appliedSeq: number[];
      serverSeq: number;
      cloudUpdatedAt: number;
    }
  | {
      kind: 'tombstoned';
      tombstone: SessionTombstone;
    };

export type PatchSessionArgs = {
  baseSeq: number;
  clientCloudUpdatedAt: number;
  patch: AgentSessionMetadataPatch;
};

const reconcileResponseSchema = z.object({
  serverSeq: z.number(),
  turnChecksums: z.array(z.object({
    turnId: z.string(),
    eventCount: z.number(),
    contentChecksum: z.string(),
  })),
});

export type ReconcileResponse = z.infer<typeof reconcileResponseSchema>;

export class SessionNeedsReconcileError extends CloudClientError {
  constructor(
    public readonly details: {
      sessionId: string;
      serverSeq: number;
      cloudUpdatedAt?: number;
    },
  ) {
    super(`Session "${details.sessionId}" needs reconcile`, 409, details, 'NEEDS_RECONCILE');
    this.name = 'SessionNeedsReconcileError';
  }
}

export class SessionNeedsBootstrapError extends CloudClientError {
  constructor(public readonly sessionId: string) {
    super(`Session "${sessionId}" needs bootstrap`, 404, { sessionId }, 'NEEDS_BOOTSTRAP');
    this.name = 'SessionNeedsBootstrapError';
  }
}

export class SessionInvalidSeqError extends CloudClientError {
  constructor(
    public readonly details: {
      sessionId: string;
      offendingEventIds: string[];
      serverSeq?: number;
    },
  ) {
    super(`Session "${details.sessionId}" append contained pre-stamped events`, 409, details, 'INVALID_SEQ');
    this.name = 'SessionInvalidSeqError';
  }
}

export class SessionInvalidEnvelopeError extends CloudClientError {
  constructor(
    public readonly details: {
      sessionId: string;
      reason?: string;
      offendingEventCount?: number;
      offendingPair?: [string, string];
    },
  ) {
    super(`Session "${details.sessionId}" append envelope is invalid`, 400, details, 'INVALID_ENVELOPE');
    this.name = 'SessionInvalidEnvelopeError';
  }
}

export type SessionTombstone = {
  sessionId: string;
  deletedAt: number;
  deletedBy: 'desktop' | 'mobile' | 'cloud';
  ttlExpiresAt: number;
};

export class SessionTombstonedError extends Error {
  constructor(
    public readonly tombstone: SessionTombstone,
  ) {
    super(`Session "${tombstone.sessionId}" was tombstoned`);
    this.name = 'SessionTombstonedError';
  }
}

/** Returns true for HTTP status codes that indicate a transient/retryable server error. */
export function isTransientError(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 429 || statusCode === 502 || statusCode === 503 || statusCode === 504;
}

/** Network-related error message patterns that indicate transient connectivity issues. */
const NETWORK_ERROR_PATTERNS = [
  'failed to fetch',
  'network request failed',
  'load failed',
  'econnreset',
  'etimedout',
  'econnrefused',
];

/** Returns true for errors caused by network connectivity issues (not programming bugs). */
export function isNetworkError(err: unknown): boolean {
  if (err != null && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'AbortError') {
    return true;
  }
  if (err instanceof TypeError) {
    const msg = err.message.toLowerCase();
    return NETWORK_ERROR_PATTERNS.some(pattern => msg.includes(pattern));
  }
  return false;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function tryParseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function parseCapabilitiesHeaderValue(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((capability) => capability.trim())
    .filter((capability) => capability.length > 0);
}

function replaceLastSeenCapabilities(capabilities: readonly string[]): void {
  lastSeenCapabilities = [...capabilities];
}

function replaceLastSeenCapabilitiesFromResponse(res: Response): void {
  // F15: this is deliberately replace-not-merge. If the cloud rolls back and
  // stops advertising a capability, one successful response reverts the client.
  replaceLastSeenCapabilities(parseCapabilitiesHeaderValue(res.headers?.get?.('X-Rebel-Capabilities')));
}

function toCloudCapabilities(raw: readonly string[]): CloudCapabilities {
  return {
    supportsDeltaPush: raw.includes('session-event-delta-push'),
    supportsMetadataPatch: raw.includes('session-metadata-patch'),
    supportsContentRefs: raw.includes('session-content-refs'),
    supportsReconcileHandshake: raw.includes('session-reconcile-handshake'),
    supportsResourcePressure: raw.includes('cloud-resource-pressure'),
    raw: [...raw],
  };
}

/**
 * Compute the capability fingerprint header value that goes on every
 * cloud-bound write once Stage B1a ships. Format: 16 lowercase hex
 * characters derived from `sorted(capabilities)` via a bounded synchronous
 * non-cryptographic 64-bit-style mixing hash. Collision resistance is not
 * security-critical here, only drift detection, and the cloud computes the
 * same hash to compare.
 *
 * The cloud uses this to detect mixed-fleet drift — a client carrying a
 * fingerprint computed from a stale capability list signals that producer
 * code and server code are out of step. The header is always sent (not
 * gated by any feature flag); legacy servers ignore unknown headers.
 *
 * See docs/plans/260518_cloud_sync_reconciliation_hardening.md § B1a —
 * Capability Fingerprint Header.
 */
export function computeCapabilityFingerprint(capabilities: readonly string[]): string {
  const sorted = [...capabilities].sort();
  const joined = sorted.join(',');
  // Avoid importing node:crypto to keep cloud-client RN-compatible. Use a
  // bounded synchronous two-lane integer mixer; collision resistance isn't
  // security critical — only drift detection — and the cloud computes the
  // same thing.
  let h1 = 0xdeadbeef ^ joined.length;
  let h2 = 0x41c6ce57 ^ joined.length;
  for (let i = 0; i < joined.length; i += 1) {
    const ch = joined.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const part1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const part2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return `${part1}${part2}`.slice(0, 16);
}

function getCapabilityFingerprintHeader(): Record<string, string> {
  // Always emit the header for observability. When capabilities have not yet
  // been negotiated (`lastSeenCapabilities === null`), compute the fingerprint
  // over an empty capability list. This keeps the wire shape stable without
  // inventing a non-fingerprint sentinel value.
  // See Stage B1a § MEDIUM #2.
  return {
    'X-Rebel-Capability-Fingerprint': computeCapabilityFingerprint(lastSeenCapabilities ?? []),
  };
}

/**
 * Synchronous snapshot of the last-seen server capabilities. Returns `null`
 * when no server response has been observed yet (i.e. capabilities have not
 * been negotiated). Producers consult this to gate optional features such
 * as content-ref offloading; callers must treat `null` as "feature
 * unavailable" rather than crashing.
 *
 * See Stage B1a § HIGH #5 — capability gating in producer.
 */
export function peekCloudCapabilities(): readonly string[] | null {
  if (lastSeenCapabilities === null) return null;
  return [...lastSeenCapabilities];
}

function extractErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as { error?: unknown };
  if (typeof record.error === 'string' && record.error.trim().length > 0) {
    return record.error.trim();
  }
  if (
    record.error
    && typeof record.error === 'object'
    && typeof (record.error as { message?: unknown }).message === 'string'
  ) {
    const message = (record.error as { message: string }).message.trim();
    return message.length > 0 ? message : null;
  }
  return null;
}

function extractErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

function normalizeSessionTombstone(
  raw: unknown,
  fallbackSessionId?: string,
): SessionTombstone | null {
  if (!raw || typeof raw !== 'object') return null;

  const maybeTombstone = 'tombstone' in raw
    ? (raw as { tombstone?: unknown }).tombstone
    : raw;

  if (!maybeTombstone || typeof maybeTombstone !== 'object') return null;

  const record = maybeTombstone as Record<string, unknown>;
  const sessionId = typeof record.sessionId === 'string'
    ? record.sessionId
    : typeof record.id === 'string'
      ? record.id
      : fallbackSessionId;
  const deletedAt = typeof record.deletedAt === 'number' && Number.isFinite(record.deletedAt)
    ? record.deletedAt
    : null;
  const deletedBy = record.deletedBy ?? record.reason;
  const ttlExpiresAt = typeof record.ttlExpiresAt === 'number' && Number.isFinite(record.ttlExpiresAt)
    ? record.ttlExpiresAt
    : deletedAt;

  if (
    !sessionId
    || deletedAt === null
    || ttlExpiresAt === null
    || (deletedBy !== 'desktop' && deletedBy !== 'mobile' && deletedBy !== 'cloud')
  ) {
    return null;
  }

  return {
    sessionId,
    deletedAt,
    deletedBy,
    ttlExpiresAt,
  };
}

/** Options for {@link fetchWithRetry}. */
export interface FetchWithRetryOptions {
  /** Timeout in ms for each individual attempt. */
  timeoutMs: number;
  /** Maximum number of retries (0 = no retry). */
  maxRetries: number;
  /** Base backoff in ms between retries. */
  backoffMs: number;
  /** External abort signal (e.g. caller-provided cancellation). */
  signal?: AbortSignal;
  /** Callback invoked on 401 responses before throwing. */
  on401?: () => void;
  /** Random function for jitter (default: Math.random). Inject for deterministic tests. */
  random?: () => number;
  /** Human-readable request label for retry telemetry (e.g. "GET /api/sessions"). */
  requestLabel?: string;
  /** Structured path used by retry observability. */
  urlPath?: string;
}

/**
 * Fetch with retry, timeout, and error classification.
 *
 * Encapsulates: AbortController timeout, retry loop with exponential backoff
 * and jitter, transient/network error classification, and 401 interception.
 *
 * @param fetchFn - Called with an AbortSignal for each attempt. Must return a Response.
 * @param options - Retry and timeout configuration.
 * @returns The successful Response (res.ok === true).
 * @throws CloudClientError for all failure cases.
 *
 * @internal Exported for testability; prefer using higher-level API functions.
 */
export async function fetchWithRetry(
  fetchFn: (signal: AbortSignal) => Promise<Response>,
  options: FetchWithRetryOptions,
): Promise<Response> {
  const {
    timeoutMs,
    maxRetries,
    backoffMs,
    signal: externalSignal,
    on401,
    random = Math.random,
    requestLabel = 'unlabeled-request',
    urlPath = requestLabel,
  } = options;

  let lastError: Error | null = null;
  const requestStartedAt = Date.now();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const attemptNumber = attempt + 1;
    const attemptStartedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    // Forward external signal to per-attempt controller
    if (externalSignal) {
      if (externalSignal.aborted) { clearTimeout(timeout); controller.abort(); }
      else externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const res = await fetchFn(controller.signal);

      if (res.status === 401) {
        on401?.();
        throw new CloudClientError('Unauthorized — re-pair required', 401);
      }
      if (isTransientError(res.status) && attempt < maxRetries) {
        const retryDelayMs = Math.round(backoffMs * (attempt + 1) * (0.75 + random() * 0.5));
        const latencyMs = Math.max(0, Date.now() - attemptStartedAt);
        log.info('http_retry_attempt', {
          attempt: attemptNumber,
          latencyMs,
          urlPath,
          statusCode: res.status,
          retryDelayMs,
        });
        await res.text().catch(() => {}); // consume body to release connection
        await abortableSleep(retryDelayMs, externalSignal);
        continue;
      }
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        const parsedErrorBody = tryParseJson(errBody);
        const errorMessage = extractErrorMessage(parsedErrorBody)
          ?? errBody
          ?? `HTTP ${res.status}`;
        const responseBody = parsedErrorBody ?? (errBody || undefined);
        throw new CloudClientError(`HTTP ${res.status}: ${errorMessage}`, res.status, responseBody, extractErrorCode(responseBody));
      }

      if (attempt > 0) {
        log.info('Cloud request succeeded after retries', {
          requestLabel,
          attempts: attemptNumber,
          totalLatencyMs: Math.max(0, Date.now() - requestStartedAt),
        });
      }
      return res;
    } catch (err) {
      lastError = err as Error;
      if (err instanceof CloudClientError && err.statusCode === 401) throw err;

      // Don't retry if caller cancelled
      if (externalSignal?.aborted) throw err;

      const retryable = isNetworkError(err) ||
        (err instanceof CloudClientError && err.statusCode !== undefined && isTransientError(err.statusCode));

      if (retryable && attempt < maxRetries) {
        const retryDelayMs = Math.round(backoffMs * (attempt + 1) * (0.75 + random() * 0.5));
        const latencyMs = Math.max(0, Date.now() - attemptStartedAt);
        const statusCode = err instanceof CloudClientError ? err.statusCode : undefined;
        log.info('http_retry_attempt', {
          attempt: attemptNumber,
          latencyMs,
          urlPath,
          statusCode,
          retryDelayMs,
          error: err instanceof Error ? err.message : String(err),
        });
        await abortableSleep(retryDelayMs, externalSignal);
        continue;
      }

      const statusCode = err instanceof CloudClientError ? err.statusCode : undefined;
      log.warn('Cloud request failed', {
        requestLabel,
        attempts: attemptNumber,
        statusCode,
        retryable,
        totalLatencyMs: Math.max(0, Date.now() - requestStartedAt),
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new CloudClientError('Request failed');
}

export async function request<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  extraHeaders?: Record<string, string>,
  signal?: AbortSignal,
  // Override the internal retry budget. Defaults to MAX_RETRIES. Pass 0 when the
  // CALLER owns retry/backoff (e.g. the mobile offline queue consumer, which must
  // see the raw HTTP status on the first attempt to classify permanent vs transient
  // — letting the queue, not this inner loop, decide whether to retry).
  maxRetries: number = MAX_RETRIES,
): Promise<T> {
  if (!config) throw new CloudClientError('Cloud client not configured');
  const { cloudUrl, token, clientId } = config;

  const url = `${cloudUrl}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(clientId ? { 'X-Rebel-Client-Id': clientId } : {}),
    // Stage B1a § MEDIUM #6: every JSON request carries the capability
    // fingerprint so the server can detect drift on any route. Callers may
    // still override via `extraHeaders` (e.g. tests).
    ...getCapabilityFingerprintHeader(),
    ...(extraHeaders ?? {}),
  };

  const res = await fetchWithRetry(
    (signal) => fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    }),
    {
      timeoutMs,
      maxRetries,
      backoffMs: RETRY_BACKOFF_MS,
      signal,
      on401: on401Callback ?? undefined,
      requestLabel: `${method.toUpperCase()} ${path}`,
      urlPath: path,
    },
  );

  replaceLastSeenCapabilitiesFromResponse(res);

  if (res.status === 204) {
    return undefined as T;
  }

  return (await res.json()) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  if (!signal) return sleep(ms);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal!.reason ?? new DOMException('Aborted', 'AbortError'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// --- Public API ---

export async function checkHealth(): Promise<{
  status: string;
  version: string;
  capabilities?: string[];
  pressure?: CloudPressureBasic;
}> {
  // Health check doesn't require auth — has its own retry for cold-start tolerance
  if (!config) throw new CloudClientError('Cloud client not configured');

  let lastError: Error | null = null;
  const startedAt = Date.now();
  for (let attempt = 0; attempt <= HEALTH_CHECK_RETRIES; attempt++) {
    const attemptNumber = attempt + 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const healthHeaders = config.clientId ? { 'X-Rebel-Client-Id': config.clientId } : undefined;
      const res = await fetch(`${config.cloudUrl}/api/health`, {
        signal: controller.signal,
        ...(healthHeaders ? { headers: healthHeaders } : {}),
      });
      if (isTransientError(res.status) && attempt < HEALTH_CHECK_RETRIES) {
        const retryDelayMs = Math.round(HEALTH_CHECK_BACKOFF_MS * (attempt + 1) * (0.75 + Math.random() * 0.5));
        log.warn('Health check retrying after transient status', {
          attempt: attemptNumber,
          statusCode: res.status,
          retryDelayMs,
        });
        await sleep(retryDelayMs);
        continue;
      }
      if (!res.ok) throw new CloudClientError(`Health check failed: HTTP ${res.status}`);
      replaceLastSeenCapabilitiesFromResponse(res);
      if (attempt > 0) {
        log.info('Health check succeeded after retries', {
          attempts: attemptNumber,
          totalLatencyMs: Math.max(0, Date.now() - startedAt),
        });
      }
      const body = await res.json() as {
        status: string;
        version: string;
        capabilities?: string[];
        pressure?: unknown;
        [key: string]: unknown;
      };
      const pressure = normalizeCloudPressureBasic(body.pressure);
      if (pressure) {
        return {
          ...body,
          pressure,
        };
      }
      const { pressure: _ignoredPressure, ...withoutPressure } = body;
      return withoutPressure as {
        status: string;
        version: string;
        capabilities?: string[];
        pressure?: CloudPressureBasic;
      };
    } catch (err) {
      lastError = err as Error;
      if (isNetworkError(err) && attempt < HEALTH_CHECK_RETRIES) {
        const retryDelayMs = Math.round(HEALTH_CHECK_BACKOFF_MS * (attempt + 1) * (0.75 + Math.random() * 0.5));
        log.warn('Health check retrying after network error', {
          attempt: attemptNumber,
          retryDelayMs,
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(retryDelayMs);
        continue;
      }
      log.warn('Health check failed', {
        attempts: attemptNumber,
        totalLatencyMs: Math.max(0, Date.now() - startedAt),
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new CloudClientError('Health check failed');
}

export async function getSessions(options?: { activeOnly?: boolean; modifiedSince?: number }): Promise<{ sessions: unknown[]; totalCount: number }> {
  const params = new URLSearchParams({ summaries: 'true' });
  if (options?.activeOnly) {
    params.set('activeOnly', 'true');
  }
  if (options?.modifiedSince != null) {
    params.set('modifiedSince', String(options.modifiedSince));
  }
  const response = await request('GET', `/api/sessions?${params.toString()}`);
  if (Array.isArray(response)) {
    return { sessions: response, totalCount: response.length };
  }
  return response as { sessions: unknown[]; totalCount: number };
}

export async function getContinuityMap(): Promise<Record<string, { state: string; lastCloudActivityAt?: number; cloudPinnedAt?: number }> | null> {
  return request('GET', '/api/continuity/state');
}

export async function getSelfDiagnostics(opts?: { include?: DiagnosticSections }): Promise<Record<string, unknown>> {
  const params = new URLSearchParams();
  if (opts?.include) {
    const included = DIAGNOSTIC_SECTION_IDS.filter((sectionId) => opts.include?.[sectionId] === true);
    params.set('include', included.join(','));
  }
  const query = params.toString();
  return request(
    'GET',
    `/api/diagnostics/self${query ? `?${query}` : ''}`,
    undefined,
    DEFAULT_TIMEOUT_MS,
    { 'X-Rebel-Surface': 'mobile' },
  );
}

export async function getSession(id: string): Promise<unknown> {
  return request('GET', `/api/sessions/${encodeURIComponent(id)}?lean=true&toolEvents=true`);
}

export async function getSessionFull(id: string): Promise<unknown> {
  return request('GET', `/api/sessions/${encodeURIComponent(id)}`);
}

export async function uploadAsset(
  sessionId: string,
  assetId: string,
  bytes: Uint8Array,
  mimeType: string,
): Promise<void> {
  if (!config) throw new CloudClientError('Cloud client not configured');
  assertCloudUrlIsSecureForUploads(config.cloudUrl);
  const url = `${config.cloudUrl}/api/sessions/${encodeURIComponent(sessionId)}/assets/${encodeURIComponent(assetId)}`;
  const headers = {
    Authorization: `Bearer ${config.token}`,
    'Content-Type': 'application/octet-stream',
    'X-Asset-Mime-Type': mimeType,
    ...(config.clientId ? { 'X-Rebel-Client-Id': config.clientId } : {}),
    ...getCapabilityFingerprintHeader(),
  };

  const res = await fetchWithRetry(
    (signal) => fetch(url, {
      method: 'POST',
      headers,
      body: bytes as unknown as RequestInit['body'],
      signal,
    }),
    {
      timeoutMs: 30_000,
      maxRetries: MAX_RETRIES,
      backoffMs: RETRY_BACKOFF_MS,
      on401: on401Callback ?? undefined,
      requestLabel: `POST /api/sessions/:id/assets/:assetId`,
      urlPath: `/api/sessions/:id/assets/:assetId`,
    },
  );

  replaceLastSeenCapabilitiesFromResponse(res);
}

/**
 * Upload a session-scoped opaque-content payload (typically large tool-output
 * text offloaded by `materializeContentRefsForEvent`) to the cloud content
 * store. Mirrors {@link uploadAsset} for the non-image dimension.
 *
 * Carries `X-Rebel-Capability-Fingerprint` so the cloud can detect mixed-fleet
 * drift; legacy servers without the route reject with 404 and the caller
 * leaves the outbox entry queued for retry.
 *
 * See docs/plans/260518_cloud_sync_reconciliation_hardening.md § B1a.
 */
export async function uploadContent(
  sessionId: string,
  contentId: string,
  bytes: Uint8Array,
  mimeType: string,
): Promise<void> {
  if (!config) throw new CloudClientError('Cloud client not configured');
  assertCloudUrlIsSecureForUploads(config.cloudUrl);
  const url = `${config.cloudUrl}/api/sessions/${encodeURIComponent(sessionId)}/content/${encodeURIComponent(contentId)}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.token}`,
    'Content-Type': 'application/octet-stream',
    'X-Content-Mime-Type': mimeType,
    ...(config.clientId ? { 'X-Rebel-Client-Id': config.clientId } : {}),
    ...getCapabilityFingerprintHeader(),
  };

  const res = await fetchWithRetry(
    (signal) => fetch(url, {
      method: 'POST',
      headers,
      body: bytes as unknown as RequestInit['body'],
      signal,
    }),
    {
      timeoutMs: 30_000,
      maxRetries: MAX_RETRIES,
      backoffMs: RETRY_BACKOFF_MS,
      on401: on401Callback ?? undefined,
      requestLabel: `POST /api/sessions/:id/content/:contentId`,
      urlPath: `/api/sessions/:id/content/:contentId`,
    },
  );

  replaceLastSeenCapabilitiesFromResponse(res);
}

/**
 * Download a session-scoped opaque-content payload uploaded by
 * {@link uploadContent}. Mirrors `GET /api/sessions/:id/assets/:assetId` for
 * the non-image dimension. Used by the renderer hydration hook on mobile /
 * cloud surfaces (desktop renders via local IPC against {@link ContentStore}).
 *
 * Discriminated result mirrors `ContentStoreReadResult` so callers don't
 * have to interpret HTTP status codes — `'not-found'` → `'missing'` so the
 * caller can choose to retry against the local store, etc.
 *
 * See docs/plans/260518_cloud_sync_reconciliation_hardening.md § B1b.
 */
export async function downloadContent(
  sessionId: string,
  contentId: string,
  options?: { signal?: AbortSignal },
): Promise<
  | { reason: 'ok'; bytes: Uint8Array; mimeType: string }
  | { reason: 'missing' | 'permission-denied' | 'corrupt' | 'fetch-failed' | 'unknown' }
> {
  if (!config) throw new CloudClientError('Cloud client not configured');
  const url = `${config.cloudUrl}/api/sessions/${encodeURIComponent(sessionId)}/content/${encodeURIComponent(contentId)}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.token}`,
    ...(config.clientId ? { 'X-Rebel-Client-Id': config.clientId } : {}),
    ...getCapabilityFingerprintHeader(),
  };

  try {
    const res = await fetchWithRetry(
      (signal) => fetch(url, {
        method: 'GET',
        headers,
        signal,
      }),
      {
        timeoutMs: 30_000,
        maxRetries: MAX_RETRIES,
        backoffMs: RETRY_BACKOFF_MS,
        on401: on401Callback ?? undefined,
        signal: options?.signal,
        requestLabel: `GET /api/sessions/:id/content/:contentId`,
        urlPath: `/api/sessions/:id/content/:contentId`,
      },
    );

    replaceLastSeenCapabilitiesFromResponse(res);

    if (res.status === 200) {
      const buffer = await res.arrayBuffer();
      const mimeType = res.headers.get('Content-Type') ?? 'application/octet-stream';
      return { reason: 'ok', bytes: new Uint8Array(buffer), mimeType };
    }
    if (res.status === 404) return { reason: 'missing' };
    if (res.status === 403) return { reason: 'permission-denied' };
    if (res.status === 415) return { reason: 'corrupt' };
    return { reason: 'unknown' };
  } catch (err) {
    if (err instanceof CloudClientError) {
      const status = err.statusCode;
      if (status === 404) return { reason: 'missing' };
      if (status === 403) return { reason: 'permission-denied' };
      if (status === 415) return { reason: 'corrupt' };
    }
    return { reason: 'fetch-failed' };
  }
}

function getBodyError(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const error = (body as { error?: unknown }).error;
  return typeof error === 'string' ? error : undefined;
}

function mapSessionWriteError(err: unknown, sessionId: string): never {
  if (!(err instanceof CloudClientError)) throw err;

  const body = err.responseBody;
  const error = getBodyError(body);
  if (err.statusCode === 409 && error === 'NEEDS_RECONCILE') {
    const payload = body as { serverSeq?: unknown; cloudUpdatedAt?: unknown };
    throw new SessionNeedsReconcileError({
      sessionId,
      serverSeq: typeof payload.serverSeq === 'number' ? payload.serverSeq : 0,
      cloudUpdatedAt: typeof payload.cloudUpdatedAt === 'number' ? payload.cloudUpdatedAt : undefined,
    });
  }
  if (err.statusCode === 409 && error === 'INVALID_SEQ') {
    const payload = body as { offendingEventIds?: unknown; serverSeq?: unknown };
    throw new SessionInvalidSeqError({
      sessionId,
      offendingEventIds: Array.isArray(payload.offendingEventIds)
        ? payload.offendingEventIds.filter((entry): entry is string => typeof entry === 'string')
        : [],
      serverSeq: typeof payload.serverSeq === 'number' ? payload.serverSeq : undefined,
    });
  }
  if (err.statusCode === 400 && error === 'INVALID_ENVELOPE') {
    const payload = body as {
      reason?: unknown;
      offendingEventCount?: unknown;
      offendingPair?: unknown;
    };
    const offendingPair = (
      Array.isArray(payload.offendingPair)
      && payload.offendingPair.length === 2
      && payload.offendingPair.every((entry) => typeof entry === 'string')
    )
      ? payload.offendingPair as [string, string]
      : undefined;
    throw new SessionInvalidEnvelopeError({
      sessionId,
      reason: typeof payload.reason === 'string' ? payload.reason : undefined,
      offendingEventCount: typeof payload.offendingEventCount === 'number' ? payload.offendingEventCount : undefined,
      offendingPair,
    });
  }
  if (err.statusCode === 404 && error === 'NEEDS_BOOTSTRAP') {
    throw new SessionNeedsBootstrapError(sessionId);
  }
  if (err.statusCode === 404 || err.statusCode === 405) {
    throw new CloudClientError('CAPABILITY_MISSING_FALLBACK', err.statusCode, err.responseBody, 'CAPABILITY_MISSING_FALLBACK');
  }

  throw err;
}

export async function appendSessionEvents(
  sessionId: string,
  args: AppendEventsArgs,
): Promise<AppendEventsResult> {
  try {
    const response = await request<unknown>(
      'POST',
      `/api/sessions/${encodeURIComponent(sessionId)}/events`,
      args,
    );
    const payload = response && typeof response === 'object'
      ? response as {
          appliedCount?: unknown;
          appliedSeq?: unknown;
          serverSeq?: unknown;
          cloudUpdatedAt?: unknown;
        }
      : {};
    return {
      kind: 'applied',
      appliedCount: typeof payload.appliedCount === 'number' ? payload.appliedCount : 0,
      appliedSeq: Array.isArray(payload.appliedSeq)
        ? payload.appliedSeq.filter((seq): seq is number => typeof seq === 'number' && Number.isInteger(seq))
        : [],
      serverSeq: typeof payload.serverSeq === 'number' ? payload.serverSeq : 0,
      cloudUpdatedAt: typeof payload.cloudUpdatedAt === 'number' ? payload.cloudUpdatedAt : 0,
    };
  } catch (err) {
    if (err instanceof CloudClientError && err.statusCode === 410) {
      const tombstone = normalizeSessionTombstone(err.responseBody, sessionId);
      if (tombstone) return { kind: 'tombstoned', tombstone };
    }
    mapSessionWriteError(err, sessionId);
  }
}

export async function patchSession(
  sessionId: string,
  args: PatchSessionArgs,
): Promise<{ cloudUpdatedAt: number }> {
  try {
    const response = await request<unknown>(
      'PATCH',
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      args,
    );
    const payload = response && typeof response === 'object'
      ? response as { cloudUpdatedAt?: unknown }
      : {};
    return {
      cloudUpdatedAt: typeof payload.cloudUpdatedAt === 'number' ? payload.cloudUpdatedAt : 0,
    };
  } catch (err) {
    if (err instanceof CloudClientError && err.statusCode === 410) {
      const tombstone = normalizeSessionTombstone(err.responseBody, sessionId);
      if (tombstone) throw new SessionTombstonedError(tombstone);
    }
    mapSessionWriteError(err, sessionId);
  }
}

export async function reconcileSession(
  sessionId: string,
  clientSeq: number,
): Promise<ReconcileResponse> {
  const normalizedSeq = Number.isFinite(clientSeq) && clientSeq > 0
    ? Math.floor(clientSeq)
    : 0;
  const query = new URLSearchParams({ clientSeq: String(normalizedSeq) });
  const response = await request<unknown>(
    'GET',
    `/api/sessions/${encodeURIComponent(sessionId)}/reconcile?${query.toString()}`,
  );
  const parsed = reconcileResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new CloudClientError(
      'reconcile-handshake-invalid-response',
      undefined,
      response,
      'reconcile-handshake-invalid-response',
    );
  }
  return parsed.data;
}

export async function getServerCapabilities(): Promise<CloudCapabilities> {
  if (!config) throw new CloudClientError('Cloud client not configured');
  if (lastSeenCapabilities !== null) {
    return toCloudCapabilities(lastSeenCapabilities);
  }

  const health = await checkHealth();
  if (Array.isArray(health.capabilities)) {
    replaceLastSeenCapabilities(health.capabilities.filter((entry): entry is string => typeof entry === 'string'));
  } else if (lastSeenCapabilities === null) {
    replaceLastSeenCapabilities([]);
  }
  return toCloudCapabilities(lastSeenCapabilities ?? []);
}

export async function catchUpSession(
  sessionId: string,
  sinceSeq: number,
): Promise<{
  events: AgentEvent[];
  serverSeq: number;
  hasMore: boolean;
  messageDelta?: AgentTurnMessage[];
  messageDeletes?: string[];
  destructiveOpsApplied?: DestructiveOpsApplied;
}> {
  const normalizedSinceSeq = Number.isFinite(sinceSeq) && sinceSeq > 0 ? Math.floor(sinceSeq) : 0;
  let cursor = normalizedSinceSeq;
  let serverSeq = normalizedSinceSeq;
  let hasMore = false;
  const events: AgentEvent[] = [];
  let messageDelta: AgentTurnMessage[] | undefined;
  let messageDeletes: string[] | undefined;
  let destructiveOpsApplied: DestructiveOpsApplied | undefined;
  let pageCount = 0;

  do {
    pageCount += 1;
    const query = new URLSearchParams({
      sinceSeq: String(cursor),
      limit: String(CATCH_UP_SESSION_PAGE_LIMIT),
    });
    let response: unknown;
    try {
      response = await request<unknown>(
        'GET',
        `/api/sessions/${encodeURIComponent(sessionId)}/events?${query.toString()}`,
      );
    } catch (err) {
      if (
        err instanceof CloudClientError
        && (err.statusCode === 404 || err.statusCode === 410)
      ) {
        const tombstone = normalizeSessionTombstone(err.responseBody, sessionId);
        if (tombstone) {
          throw new SessionTombstonedError(tombstone);
        }
      }
      throw err;
    }

    const payload = response && typeof response === 'object'
      ? response as { events?: unknown[]; serverSeq?: unknown; hasMore?: unknown }
      : {};
    const pageEvents = validateCatchUpEvents({
      events: Array.isArray(payload.events) ? payload.events : [],
      sessionId,
      message: 'envelope-rejected',
    });
    const pageServerSeq = isPositiveInteger(payload.serverSeq) ? payload.serverSeq : 0;
    hasMore = payload.hasMore === true;

    if (!hasMore) {
      const finalPayload = payload as {
        messageDelta?: unknown;
        messageDeletes?: unknown;
        destructiveOpsApplied?: unknown;
      };
      messageDelta = validateMessageDelta(finalPayload.messageDelta);
      messageDeletes = validateStringArray(finalPayload.messageDeletes);
      destructiveOpsApplied = validateDestructiveOpsApplied(finalPayload.destructiveOpsApplied);
    }

    if (pageEvents.length > 0) {
      events.push(...pageEvents);
      const pageMaxSeq = pageEvents.reduce((maxSeq, event) => {
        if (!isPositiveInteger(event.seq)) return maxSeq;
        return Math.max(maxSeq, event.seq);
      }, cursor);
      cursor = Math.max(cursor, pageMaxSeq);
    }

    serverSeq = Math.max(serverSeq, pageServerSeq, cursor);

    // Safety guard for malformed responses: avoid infinite loops if hasMore=true
    // but no events are returned (or sequence cursor doesn't advance).
    if (hasMore && pageEvents.length === 0) {
      break;
    }
  } while (hasMore && pageCount < 50);

  return {
    events,
    serverSeq,
    hasMore,
    ...(messageDelta !== undefined ? { messageDelta } : {}),
    ...(messageDeletes !== undefined ? { messageDeletes } : {}),
    ...(destructiveOpsApplied !== undefined ? { destructiveOpsApplied } : {}),
  };
}

export async function catchUpContinuity(params: {
  sinceSeq: Record<string, number>;
  sessionIds?: string[];
}): Promise<{
  sessions: Record<string, {
    events: AgentEvent[];
    maxSeq: number;
    messageDelta?: AgentTurnMessage[];
    messageDeletes?: string[];
    destructiveOpsApplied?: DestructiveOpsApplied;
  }>;
  serverNow: number;
  continuationToken?: string;
}> {
  const mergedSessions: Record<string, {
    events: AgentEvent[];
    maxSeq: number;
    messageDelta?: AgentTurnMessage[];
    messageDeletes?: string[];
    destructiveOpsApplied?: DestructiveOpsApplied;
  }> = {};
  let continuationToken: string | undefined;
  let serverNow = Date.now();
  const seenContinuationTokens = new Set<string>();
  let pageCount = 0;

  do {
    pageCount += 1;
    const query = new URLSearchParams();
    query.set('limit', String(CATCH_UP_CONTINUITY_TOTAL_LIMIT));

    if (continuationToken) {
      query.set('continuationToken', continuationToken);
    } else {
      query.set('sinceSeq', JSON.stringify(params.sinceSeq ?? {}));
      if (params.sessionIds && params.sessionIds.length > 0) {
        query.set('sessionIds', params.sessionIds.join(','));
      }
    }

    const response = await request<unknown>('GET', `/api/continuity/catch-up?${query.toString()}`);
    const payload = response && typeof response === 'object'
      ? response as {
          sessions?: Record<string, {
            events?: unknown[];
            maxSeq?: unknown;
            messageDelta?: unknown;
            messageDeletes?: unknown;
            destructiveOpsApplied?: unknown;
          }>;
          serverNow?: unknown;
          continuationToken?: unknown;
        }
      : {};

    const nextToken = typeof payload.continuationToken === 'string' && payload.continuationToken.length > 0
      ? payload.continuationToken
      : undefined;
    const isFinalPage = !nextToken;

    if (payload.sessions && typeof payload.sessions === 'object') {
      for (const [sessionId, sessionPayload] of Object.entries(payload.sessions)) {
        const current = mergedSessions[sessionId] ?? { events: [], maxSeq: 0 };
        const pageEvents = validateCatchUpEvents({
          events: Array.isArray(sessionPayload?.events) ? sessionPayload.events : [],
          sessionId,
          message: 'envelope-rejected-on-catch-up',
        });
        const pageMaxSeq = isPositiveInteger(sessionPayload?.maxSeq) ? sessionPayload.maxSeq : 0;
        current.events.push(...pageEvents);
        current.maxSeq = Math.max(current.maxSeq, pageMaxSeq);
        if (isFinalPage) {
          const messageDelta = validateMessageDelta(sessionPayload?.messageDelta);
          const messageDeletes = validateStringArray(sessionPayload?.messageDeletes);
          const destructiveOpsApplied = validateDestructiveOpsApplied(sessionPayload?.destructiveOpsApplied);
          if (messageDelta !== undefined) current.messageDelta = messageDelta;
          if (messageDeletes !== undefined) current.messageDeletes = messageDeletes;
          if (destructiveOpsApplied !== undefined) current.destructiveOpsApplied = destructiveOpsApplied;
        }
        mergedSessions[sessionId] = current;
      }
    }

    if (typeof payload.serverNow === 'number' && Number.isFinite(payload.serverNow)) {
      serverNow = payload.serverNow;
    }

    if (!nextToken) {
      continuationToken = undefined;
      break;
    }

    if (seenContinuationTokens.has(nextToken) || pageCount >= 50) {
      continuationToken = nextToken;
      break;
    }

    seenContinuationTokens.add(nextToken);
    continuationToken = nextToken;
  } while (continuationToken);

  return {
    sessions: mergedSessions,
    serverNow,
    ...(continuationToken ? { continuationToken } : {}),
  };
}

export async function getTombstones(
  since?: number,
): Promise<{ tombstones: SessionTombstone[]; serverNow?: number }> {
  const params = new URLSearchParams();
  if (since != null) {
    params.set('since', String(since));
  }

  const query = params.toString();
  const response = await request<unknown>('GET', `/api/sessions/tombstones${query ? `?${query}` : ''}`);

  const warnMissingServerNow = () => {
    if (warnedMissingTombstonesServerNow) return;
    warnedMissingTombstonesServerNow = true;
    log.warn('Tombstones endpoint missing serverNow; using client clock', {
      reason: 'tombstones-no-servernow',
    });
  };

  if (Array.isArray(response)) {
    warnMissingServerNow();
    return { tombstones: response as SessionTombstone[] };
  }
  if (response && typeof response === 'object') {
    const tombstones = Array.isArray((response as { tombstones?: unknown[] }).tombstones)
      ? (response as { tombstones: SessionTombstone[] }).tombstones
      : [];
    const serverNow = (
      typeof (response as { serverNow?: unknown }).serverNow === 'number'
      && Number.isFinite((response as { serverNow?: number }).serverNow)
    )
      ? (response as { serverNow: number }).serverNow
      : undefined;

    if (serverNow === undefined) {
      warnMissingServerNow();
    }

    return serverNow === undefined
      ? { tombstones }
      : { tombstones, serverNow };
  }

  warnMissingServerNow();
  return { tombstones: [] };
}

function sanitizeSessionMetadataPatch(patch: Record<string, unknown>): AgentSessionMetadataPatch {
  const { updatedAt: _updatedAt, lastError: _lastError, ...allowed } = patch;
  return allowed as AgentSessionMetadataPatch;
}

function readNumericSessionField(session: unknown, field: 'maxSeq' | 'cloudUpdatedAt'): number {
  if (!isRecord(session)) return 0;
  const value = session[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export async function updateSession(id: string, patch: Record<string, unknown>): Promise<void> {
  const allowedPatch = sanitizeSessionMetadataPatch(patch);
  const capabilities = await getServerCapabilities();

  if (capabilities.supportsMetadataPatch) {
    try {
      const baseline = await getSession(id);
      await patchSession(id, {
        baseSeq: readNumericSessionField(baseline, 'maxSeq'),
        clientCloudUpdatedAt: readNumericSessionField(baseline, 'cloudUpdatedAt'),
        patch: allowedPatch,
      });
      return;
    } catch (err) {
      if (!(err instanceof CloudClientError && err.code === 'CAPABILITY_MISSING_FALLBACK')) {
        throw err;
      }
    }
  }

  const full = await getSessionFull(id);
  const merged = {
    ...(isRecord(full) ? full : {}),
    ...allowedPatch,
    id,
  };
  /* direct-session-put -- legacy server fallback for metadata patch capability */
  await request('PUT', `/api/sessions/${encodeURIComponent(id)}`, merged);
}

export async function deleteSession(
  id: string,
  surface?: 'mobile' | 'desktop' | 'cli',
): Promise<{ success: boolean; tombstone?: SessionTombstone; serverNow?: number }> {
  const headers = surface ? { 'X-Rebel-Surface': surface } : undefined;
  const response = await request<unknown>(
    'DELETE',
    `/api/sessions/${encodeURIComponent(id)}`,
    undefined,
    DEFAULT_TIMEOUT_MS,
    headers,
  );

  if (!response || typeof response !== 'object') {
    return { success: true };
  }

  const payload = response as {
    success?: unknown;
    tombstone?: unknown;
    serverNow?: unknown;
  };
  const tombstone = normalizeSessionTombstone(payload.tombstone, id);
  const serverNow = typeof payload.serverNow === 'number' && Number.isFinite(payload.serverNow)
    ? payload.serverNow
    : undefined;

  return {
    success: payload.success !== false,
    ...(tombstone ? { tombstone } : {}),
    ...(serverNow !== undefined ? { serverNow } : {}),
  };
}

export async function getSettings(): Promise<unknown> {
  return request('GET', '/api/settings?strip-secrets=1');
}

export async function listSlackRecentSenders(): Promise<SlackRecentSender[]> {
  const payload = await request<unknown>('GET', '/api/slack/recent-senders');
  const parsed = ListSlackRecentSendersResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new CloudClientError(
      'Slack recent senders response did not match the expected shape',
      undefined,
      payload,
      'SLACK_RECENT_SENDERS_INVALID_RESPONSE',
    );
  }
  return parsed.data.senders;
}

export async function removeSlackRecentSender(principalKey: string): Promise<void> {
  const parsedRequest = RemoveSlackRecentSenderRequestSchema.safeParse({ principalKey });
  if (!parsedRequest.success) {
    throw new CloudClientError(
      'Slack recent sender principalKey is required',
      400,
      parsedRequest.error.flatten(),
      'INVALID_SLACK_RECENT_SENDER_PRINCIPAL_KEY',
    );
  }

  const payload = await request<unknown>('DELETE', '/api/slack/recent-senders', parsedRequest.data);
  const parsed = RemoveSlackRecentSenderResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new CloudClientError(
      'Slack recent sender delete response did not match the expected shape',
      undefined,
      payload,
      'SLACK_RECENT_SENDERS_INVALID_DELETE_RESPONSE',
    );
  }
}

export async function clearSlackRecentSenders(): Promise<{ cleared: number }> {
  const payload = await request<unknown>('POST', '/api/slack/recent-senders/clear-all');
  const parsed = ClearSlackRecentSendersResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new CloudClientError(
      'Slack recent senders clear response did not match the expected shape',
      undefined,
      payload,
      'SLACK_RECENT_SENDERS_INVALID_CLEAR_RESPONSE',
    );
  }
  return { cleared: parsed.data.cleared };
}

export async function stopTurn(turnId: string): Promise<void> {
  await request('POST', '/api/agent/stop', { turnId });
}

export async function submitFeedback(feedback: FeedbackRequest): Promise<{ success: boolean }> {
  // Goes through the default `request()` path, which retries `isTransientError`
  // statuses (408/429/502/503/504) up to MAX_RETRIES. The /api/feedback route is
  // aware of this (see cloud-service/src/routes/feedback.ts): a KNOWN-PERMANENT
  // "reporting unavailable" (Sentry unconfigured) returns 422 — NON-transient, so
  // it surfaces immediately here without burning the route's per-token rate limit
  // on pointless retries — while a possibly-transient flush timeout returns 503 and
  // is allowed its normal retry budget. A non-2xx throws CloudClientError, which
  // both consumers (mobile help.tsx, web-companion HelpScreen) treat as failure.
  return request('POST', '/api/feedback', feedback);
}

/**
 * Submit feedback exactly ONCE (no internal retry), surfacing the raw HTTP
 * status on failure. Used by the mobile offline feedback queue consumer, where
 * the QUEUE owns retry/backoff: it must see the first-attempt status to classify
 * permanent (422) vs transient (503/429/5xx) vs auth (401/403) and decide
 * whether to retry — an inner retry loop here would double-retry and mask the
 * status. On a non-2xx this throws `CloudClientError` carrying `.statusCode`
 * (which the consumer feeds to `classifyUploadFailureCategory`); a network
 * failure throws without a `statusCode` (classified `network`).
 */
export async function submitFeedbackOnce(
  feedback: FeedbackRequest,
  signal?: AbortSignal,
): Promise<{ success: boolean }> {
  return request('POST', '/api/feedback', feedback, DEFAULT_TIMEOUT_MS, undefined, signal, 0);
}

export async function readWorkspaceFile(path: string): Promise<{ content: string }> {
  return request('POST', '/api/library/read', { path });
}

/** Typed overload — provides compile-time safety for known IPC channels. */
export function ipcCall<C extends IpcChannelName>(channel: C, ...args: IpcCallArgs<C>): Promise<IpcResponseOf<C>>;
/** Untyped fallback — accepts any channel string for backwards compatibility. */
export function ipcCall<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
export async function ipcCall(channel: string, ...args: unknown[]): Promise<unknown> {
  return request('POST', `/api/ipc/${encodeURIComponent(channel)}`, { params: args });
}

export async function transcribe(audioBlob: Blob, sessionId?: string): Promise<string> {
  if (!config) throw new CloudClientError('Cloud client not configured');
  const { cloudUrl, token, clientId } = config;

  const url = new URL(`${cloudUrl}/api/voice/transcribe`);
  if (sessionId) {
    url.searchParams.set('sessionId', sessionId);
  }

  const res = await fetchWithRetry(
    (signal) => fetch(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': audioBlob.type,
        ...(clientId ? { 'X-Rebel-Client-Id': clientId } : {}),
      },
      body: audioBlob,
      signal,
    }),
    {
      timeoutMs: 60_000,
      maxRetries: MAX_RETRIES,
      backoffMs: RETRY_BACKOFF_MS,
      on401: on401Callback ?? undefined,
      requestLabel: 'POST /api/voice/transcribe',
      urlPath: '/api/voice/transcribe',
    },
  );

  const data = await res.json();
  return data.transcript;
}

/**
 * Convert text to speech audio via the cloud TTS endpoint.
 * Returns base64-encoded audio string (audio/mpeg).
 * Accepts an optional AbortSignal for cancellation (e.g. barge-in).
 */
export async function textToSpeech(text: string, signal?: AbortSignal): Promise<string> {
  if (!config) throw new CloudClientError('Cloud client not configured');
  const { cloudUrl, token, clientId } = config;

  let res: Response;
  try {
    res = await fetchWithRetry(
      (fetchSignal) => fetch(`${cloudUrl}/api/voice/tts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(clientId ? { 'X-Rebel-Client-Id': clientId } : {}),
        },
        body: JSON.stringify({ text }),
        signal: fetchSignal,
      }),
      {
        timeoutMs: 30_000,
        maxRetries: MAX_RETRIES,
        backoffMs: RETRY_BACKOFF_MS,
        signal,
        on401: on401Callback ?? undefined,
        requestLabel: 'POST /api/voice/tts',
        urlPath: '/api/voice/tts',
      },
    );
  } catch (err) {
    if (err instanceof CloudClientError && err.statusCode === 401) throw err;
    throw new CloudClientError('Text-to-speech failed', err instanceof CloudClientError ? err.statusCode : undefined);
  }

  const body = await res.json();
  return body.audioBase64;
}

export async function createShareLink(sessionId: string): Promise<{ shareId: string }> {
  return request('POST', `/api/sessions/${encodeURIComponent(sessionId)}/share`);
}

export async function revokeShareLink(sessionId: string): Promise<void> {
  await request('DELETE', `/api/sessions/${encodeURIComponent(sessionId)}/share`);
}

export async function getShareStatus(sessionId: string): Promise<{ shareId: string } | null> {
  try {
    return await request('GET', `/api/sessions/${encodeURIComponent(sessionId)}/share`);
  } catch (err) {
    if (err instanceof CloudClientError && err.statusCode === 404) return null;
    throw err;
  }
}

export async function fetchSharedSession(cloudUrl: string, shareId: string): Promise<import('./types').SharedSession> {
  const url = `${cloudUrl.replace(/\/+$/, '')}/api/shared/${encodeURIComponent(shareId)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new CloudClientError(`HTTP ${res.status}: ${errBody}`, res.status);
    }
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function unlockSharedSession(cloudUrl: string, shareId: string, password: string): Promise<import('./types').SharedSession> {
  const url = `${cloudUrl.replace(/\/+$/, '')}/api/shared/${encodeURIComponent(shareId)}/unlock`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const body = JSON.stringify({ password });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(new TextEncoder().encode(body).length) },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new CloudClientError(`HTTP ${res.status}: ${errBody}`, res.status);
    }
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch a shared resource (conversation or file) by share ID.
 *
 * Uses the same endpoint as {@link fetchSharedSession} but returns a
 * {@link SharedResource} discriminated union. Missing `resourceType` in the
 * response is treated as `'conversation'` for backward compatibility.
 */
export async function fetchSharedResource(cloudUrl: string, shareId: string): Promise<import('./types').SharedResource> {
  const url = `${cloudUrl.replace(/\/+$/, '')}/api/shared/${encodeURIComponent(shareId)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new CloudClientError(`HTTP ${res.status}: ${errBody}`, res.status);
    }
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Unlock a password-protected shared resource (conversation or file).
 *
 * Uses the same endpoint as {@link unlockSharedSession} but returns a
 * {@link SharedResource} discriminated union. For file shares, the response
 * includes an HMAC-signed `downloadUrl` for binary files.
 */
export async function unlockSharedResource(cloudUrl: string, shareId: string, password: string): Promise<import('./types').SharedResource> {
  const url = `${cloudUrl.replace(/\/+$/, '')}/api/shared/${encodeURIComponent(shareId)}/unlock`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const body = JSON.stringify({ password });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(new TextEncoder().encode(body).length) },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new CloudClientError(`HTTP ${res.status}: ${errBody}`, res.status);
    }
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Build the download URL for a shared file.
 *
 * For non-password-protected files this URL can be used directly.
 * For password-protected files, use the HMAC-signed `downloadUrl` returned
 * from {@link unlockSharedResource} instead.
 */
export function getSharedFileDownloadUrl(cloudUrl: string, shareId: string): string {
  return `${cloudUrl.replace(/\/+$/, '')}/api/shared/${encodeURIComponent(shareId)}/download`;
}

export function createEventSocket(
  onEvent: (channel: string, args: unknown[]) => void,
  onError?: (err: Error) => void,
  onClose?: () => void,
  onOpen?: () => void,
): { close: () => void } {
  if (!config) throw new CloudClientError('Cloud client not configured');

  const wsUrl =
    config.cloudUrl.replace(/^http/, 'ws') +
    `/api/events?token=${encodeURIComponent(config.token)}`;

  const ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    onOpen?.();
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data as string);
      if (data.channel && data.args) {
        onEvent(data.channel, data.args);
      } else if (data.channel && data.payload !== undefined) {
        onEvent(data.channel, [data.payload]);
      }
    } catch {
      /* ignore malformed messages */
    }
  };

  ws.onerror = () => {
    onError?.(new Error('Event channel WebSocket error'));
  };

  ws.onclose = () => {
    onClose?.();
  };

  return {
    close: () => {
      // Null out handlers first to prevent callbacks after close intent
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1000, 'Client disconnect');
        }
      } catch {
        // Ignore — native WebSocket may already be invalidated
      }
    },
  };
}

export function createAgentTurnSocket(
  request: { sessionId: string; prompt: string; [key: string]: unknown },
  onEvent: (event: unknown) => void,
  onError?: (err: Error) => void,
  onClose?: (code: number, reason: string) => void,
): { close: () => void } {
  if (!config) throw new CloudClientError('Cloud client not configured');

  const wsUrl =
    config.cloudUrl.replace(/^http/, 'ws') +
    `/api/agent/turn?token=${encodeURIComponent(config.token)}`;

  log.info('AgentTurn WS connecting', { sessionId: request.sessionId, url: wsUrl.replace(/token=[^&]+/, 'token=***') });
  const ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    log.info('AgentTurn WS open, sending request', { sessionId: request.sessionId });
    ws.send(JSON.stringify(request));
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data as string);
      const evType = (data as { type?: string }).type;
      if (evType !== 'assistant_delta' && evType !== 'thinking_delta') {
        log.debug('AgentTurn WS event', { type: evType, sessionId: request.sessionId });
      }
      onEvent(data);
    } catch {
      /* ignore */
    }
  };

  ws.onerror = (e) => {
    log.error('AgentTurn WS error', { sessionId: request.sessionId, message: (e as { message?: string }).message });
    onError?.(new Error('Agent turn WebSocket error'));
  };

  ws.onclose = (e) => {
    const code = (e as { code?: number }).code ?? 1006;
    const reason = (e as { reason?: string }).reason ?? '';
    log.info('AgentTurn WS closed', { sessionId: request.sessionId, code, reason });
    onClose?.(code, reason);
  };

  return {
    close: () => {
      // Null out all handlers to prevent callbacks after close intent
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        // try-catch guards against JS-side invalid-state errors; native
        // TurboModule exceptions are mitigated by callers deferring close
        // via queueMicrotask (see useAgentTurn/useEventChannel).
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1000, 'Client disconnect');
        }
      } catch {
        // Ignore — native WebSocket may already be invalidated
      }
    },
  };
}
