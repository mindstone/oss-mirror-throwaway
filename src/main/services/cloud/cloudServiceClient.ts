/**
 * Cloud Service Client
 *
 * HTTP/WS client that talks to the rebel cloud service on Fly Machines.
 * Used by the CloudRouter to forward IPC calls to the cloud instance.
 *
 * - HTTP: stateless requests (sessions, settings, library, health)
 * - WebSocket: agent turn streaming (one WS per turn, streams AgentEvent objects)
 *
 * @see cloud-service/src/routes/ for the cloud service API
 */

import WebSocket from 'ws';
import dns from 'node:dns/promises';
import { randomUUID } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { createScopedLogger } from '@core/logger';
import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import type { AgentEvent, AgentSessionMetadataPatch, AgentTurnRequest } from '@shared/types';
import { AgentEventSchemaFromManifest } from '@shared/contracts/agentEventManifest';
import { CloudTurnControlMessageSchema } from './cloudTurnControlMessageSchema';
import { recordTurnPersistenceAckStatus } from './cloudContinuityMetadata';
import {
  cloudIngressRejectionCounter,
  truncateRawMessageForLog,
} from './cloudIngressMetrics';
import {
  parseNdjsonResponse,
  type NdjsonProgressEvent,
  type NdjsonChunkSource,
} from './ndjsonResponseParser';

const gzipAsync = promisify(gzip);
const log = createScopedLogger({ service: 'cloudServiceClient' });

const DEFAULT_TIMEOUT_MS = 30_000;
const GZIP_BODY_THRESHOLD_BYTES = 512 * 1024; // gzip bodies larger than 512KB
const AGENT_TURN_TIMEOUT_MS = 5 * 60_000; // 5 minutes — agent turns can be long
const SURFACE_HEADER_NAME = 'X-Rebel-Surface';
const SURFACE_HEADER_VALUE = 'desktop';
const CLIENT_ID_HEADER_NAME = 'X-Rebel-Client-Id';
const PAYLOAD_HISTOGRAM_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface PayloadHistogramSnapshot {
  payloadBytesP50: number;
  payloadBytesP95: number;
  payloadBytesMax: number;
  windowStart: string;
  windowEnd: string;
  sampleCount: number;
}

interface PayloadHistogramSample {
  ts: number;
  payloadBytes: number;
}

const payloadHistogramSamples: PayloadHistogramSample[] = [];

function prunePayloadHistogram(now: number): void {
  const cutoff = now - PAYLOAD_HISTOGRAM_WINDOW_MS;
  for (let index = payloadHistogramSamples.length - 1; index >= 0; index -= 1) {
    if (payloadHistogramSamples[index].ts < cutoff) payloadHistogramSamples.splice(index, 1);
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function recordPayloadHistogramSample(payloadBytes: number, now: number = Date.now()): void {
  if (!Number.isFinite(payloadBytes) || payloadBytes <= 0) return;
  payloadHistogramSamples.push({ ts: now, payloadBytes: Math.floor(payloadBytes) });
  prunePayloadHistogram(now);
}

export function getPayloadHistogramSnapshot(now: number = Date.now()): PayloadHistogramSnapshot {
  prunePayloadHistogram(now);
  const payloadBytes = payloadHistogramSamples.map((sample) => sample.payloadBytes).sort((a, b) => a - b);
  return {
    payloadBytesP50: percentile(payloadBytes, 50),
    payloadBytesP95: percentile(payloadBytes, 95),
    payloadBytesMax: payloadBytes.length > 0 ? payloadBytes[payloadBytes.length - 1] : 0,
    windowStart: new Date(now - PAYLOAD_HISTOGRAM_WINDOW_MS).toISOString(),
    windowEnd: new Date(now).toISOString(),
    sampleCount: payloadBytes.length,
  };
}

export function resetPayloadHistogramForTests(): void {
  payloadHistogramSamples.length = 0;
}

export function recordPayloadHistogramSampleForTests(payloadBytes: number, now?: number): void {
  recordPayloadHistogramSample(payloadBytes, now);
}

export function sanitizeRouteForLog(rawPath: string): string {
  // Strip query string and rewrite known id-bearing path segments to `:id`
  // to keep raw session/turn ids out of structured logs.
  const queryIdx = rawPath.indexOf('?');
  const pathOnly = queryIdx === -1 ? rawPath : rawPath.slice(0, queryIdx);
  return pathOnly
    .replace(/\/api\/sessions\/[^/]+/g, '/api/sessions/:id')
    .replace(/\/api\/turns\/[^/]+/g, '/api/turns/:id')
    .replace(/\/api\/cloud-mcps\/[^/]+/g, '/api/cloud-mcps/:id')
    .replace(/\/api\/library\/[^/]+/g, '/api/library/:id')
    .replace(/\/api\/continuity\/[^/]+/g, '/api/continuity/:id');
}

function safeLog(fn: () => void): void {
  // Best-effort logging: never let a logger failure perturb request flow.
  try {
    fn();
  } catch {
    // Silently swallow logger errors — log emission is observability, not behavior.
  }
}

// 503 retry: Fly Machine waking or service booting — wait and retry
const MAX_503_RETRIES = 3;
const INITIAL_503_BACKOFF_MS = 2_000; // 2s, 4s, 8s

interface CloudServiceClientIdStoreState extends Record<string, unknown> {
  desktopClientId: string | null;
}

let _clientIdStore: KeyValueStore<CloudServiceClientIdStoreState> | null | undefined;
let _fallbackDesktopClientId: string | null = null;
let _warnedClientIdStoreUnavailable = false;

function generateDesktopClientId(): string {
  return `desktop-${randomUUID()}`;
}

function getClientIdStore(): KeyValueStore<CloudServiceClientIdStoreState> | null {
  if (_clientIdStore !== undefined) return _clientIdStore;
  try {
    _clientIdStore = createStore<CloudServiceClientIdStoreState>({
      name: 'cloud-service-client-id',
      defaults: { desktopClientId: null },
    });
  } catch (err) {
    _clientIdStore = null;
    if (!_warnedClientIdStoreUnavailable) {
      _warnedClientIdStoreUnavailable = true;
      log.warn({ err }, 'Cloud client-id store unavailable; using ephemeral desktop client id');
    }
  }
  return _clientIdStore;
}

function getOrCreateDesktopClientId(): string {
  const store = getClientIdStore();
  if (store) {
    const existing = store.get('desktopClientId');
    if (typeof existing === 'string' && existing.trim().length > 0) {
      return existing.trim();
    }

    const generated = generateDesktopClientId();
    store.set('desktopClientId', generated);
    return generated;
  }

  if (!_fallbackDesktopClientId) {
    _fallbackDesktopClientId = generateDesktopClientId();
  }
  return _fallbackDesktopClientId;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class CloudServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'CloudServiceError';
  }
}

/**
 * Options bag for `CloudServiceClient.postStream`. Replaces the pre-Stage-6
 * positional `timeoutMs` argument (still supported for back-compat).
 *
 * When `onProgress` is set, the client opts into NDJSON response parsing
 * (see `ndjsonResponseParser.ts`). When absent, the legacy single-JSON
 * response path is used — preserving backward compat with older cloud
 * deployments.
 */
export interface PostStreamOptions {
  /** Request timeout in milliseconds. Default: 2 hours. */
  timeoutMs?: number;
  /**
   * Callback fired once per NDJSON progress event emitted by the server.
   * Also triggers the `Accept: application/x-ndjson` request header so the
   * server knows to use the chunked response path.
   */
  onProgress?: (evt: NdjsonProgressEvent) => void;
  /**
   * Total uncompressed bytes the server can expect to process. Sent as
   * `X-Migration-Bytes-Total`, which the server echoes back in NDJSON
   * progress events so the renderer can render a ratio.
   */
  bytesTotal?: number;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class CloudServiceClient {
  private cloudUrl: string;
  private bearerToken: string;
  private clientId: string;
  private activeWebSocket: WebSocket | null = null;

  /** Last seen cloud version from X-Rebel-Cloud-Version header. */
  lastSeenCloudVersion: string | null = null;
  private lastSeenCapabilities: string[] | null = null;

  constructor(cloudUrl: string, bearerToken: string) {
    // Normalise: strip trailing slash
    this.cloudUrl = cloudUrl.replace(/\/+$/, '');
    this.bearerToken = bearerToken;
    this.clientId = getOrCreateDesktopClientId();
  }

  private buildDefaultHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.bearerToken}`,
      [SURFACE_HEADER_NAME]: SURFACE_HEADER_VALUE,
      [CLIENT_ID_HEADER_NAME]: this.clientId,
    };
  }

  // ---- HTTP methods -------------------------------------------------------

  async get(path: string): Promise<unknown> {
    return this.httpRequest('GET', path);
  }

  async post(path: string, body?: unknown): Promise<unknown> {
    return this.httpRequest('POST', path, body);
  }

  async put(path: string, body?: unknown): Promise<unknown> {
    return this.httpRequest('PUT', path, body);
  }

  async getServerCapabilities(): Promise<{ supportsDeltaPush: boolean; supportsMetadataPatch: boolean; raw: string[] }> {
    if (this.lastSeenCapabilities === null) {
      const health = await this.get('/api/health');
      const capabilities = health && typeof health === 'object' && Array.isArray((health as { capabilities?: unknown }).capabilities)
        ? (health as { capabilities: unknown[] }).capabilities.filter((entry): entry is string => typeof entry === 'string')
        : [];
      this.lastSeenCapabilities = capabilities;
    }
    const raw = this.lastSeenCapabilities ?? [];
    return {
      supportsDeltaPush: raw.includes('session-event-delta-push'),
      supportsMetadataPatch: raw.includes('session-metadata-patch'),
      raw: [...raw],
    };
  }

  invalidateCapabilities(): void {
    this.lastSeenCapabilities = null;
  }

  async appendSessionEvents(
    sessionId: string,
    body: {
      baseSeq: number;
      events: Array<Omit<AgentEvent, 'seq'> & { turnId: string; clientOrdinal: number; seq: null }>;
      messageDelta?: unknown[];
      messageDeletes?: string[];
      _destructiveOps?: { truncateTurns?: string[]; deleteEventIdentities?: string[] };
      idempotencyKey?: string;
      metadataPatch?: AgentSessionMetadataPatch;
    },
  ): Promise<
    | { kind: 'applied'; appliedSeq: number[]; serverSeq: number; cloudUpdatedAt: number }
    | { kind: 'tombstoned'; tombstone: unknown }
  > {
    try {
      const response = await this.post(`/api/sessions/${encodeURIComponent(sessionId)}/events`, body);
      const payload = response && typeof response === 'object' ? response as Record<string, unknown> : {};
      return {
        kind: 'applied',
        appliedSeq: Array.isArray(payload.appliedSeq)
          ? payload.appliedSeq.filter((seq): seq is number => typeof seq === 'number' && Number.isInteger(seq))
          : [],
        serverSeq: typeof payload.serverSeq === 'number' ? payload.serverSeq : 0,
        cloudUpdatedAt: typeof payload.cloudUpdatedAt === 'number' ? payload.cloudUpdatedAt : 0,
      };
    } catch (err) {
      if (err instanceof CloudServiceError) {
        if (
          (err.statusCode === 404 && err.code === 'CLOUD_HTTP_ERROR')
          || err.statusCode === 405
        ) {
          throw new CloudServiceError(err.message, 'CAPABILITY_MISSING_FALLBACK', err.statusCode);
        }
      }
      throw err;
    }
  }

  async patchSession(
    sessionId: string,
    body: { baseSeq: number; clientCloudUpdatedAt: number; patch: AgentSessionMetadataPatch },
  ): Promise<{ cloudUpdatedAt: number }> {
    const response = await this.patch(`/api/sessions/${encodeURIComponent(sessionId)}`, body);
    const payload = response && typeof response === 'object' ? response as Record<string, unknown> : {};
    return {
      cloudUpdatedAt: typeof payload.cloudUpdatedAt === 'number' ? payload.cloudUpdatedAt : 0,
    };
  }

  async postBinary(path: string, buffer: Buffer, contentType: string): Promise<unknown> {
    const url = `${this.cloudUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000); // 5 min for large uploads

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          ...this.buildDefaultHeaders(),
          'Content-Type': contentType,
        },
        body: buffer as unknown as BodyInit,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        let errorBody: { code?: string; message?: string } = {};
        try { errorBody = await res.json() as { code?: string; message?: string }; } catch { /* ignore */ }
        throw new CloudServiceError(
          errorBody.message ?? `Binary upload failed: ${res.status} ${res.statusText}`,
          errorBody.code ?? 'CLOUD_HTTP_ERROR',
          res.status,
        );
      }
      if (res.status === 204) return undefined;
      return await res.json();
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof CloudServiceError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new CloudServiceError(`Binary upload timed out: ${path}`, 'TIMEOUT');
      }
      throw new CloudServiceError(
        `Binary upload network error: ${err instanceof Error ? err.message : String(err)}`,
        'CLOUD_UNREACHABLE',
      );
    }
  }

  /**
   * POST a Node.js Readable stream as the request body.
   * Used for streaming large tar.gz archives without buffering in memory.
   *
   * **Response shape (Stage 6 cloud-service)**:
   * - If `onProgress` is provided, we set `Accept: application/x-ndjson` and
   *   parse the chunked NDJSON body (one `{type:'progress',...}` line per
   *   ~500ms, terminal `{type:'result',...}`). On success, this method
   *   returns an object shaped like the legacy single-JSON body
   *   (`{success, fileCount, archiveSize}`) so callers that don't care
   *   about the transport see no difference.
   * - If `onProgress` is absent, the legacy single-JSON body is awaited and
   *   returned unchanged (old cloud-service versions continue to work).
   *
   * @param path - API path (e.g. '/api/data/upload-archive?target=workspace')
   * @param stream - A Node.js Readable stream (e.g. from tar.create().pipe(gzip))
   * @param options - Optional configuration:
   *   - `timeoutMs` (default 2 hours) — request timeout for large workspaces.
   *   - `onProgress` — callback fired for each NDJSON progress event. Opts
   *     the client into NDJSON response mode.
   *   - `bytesTotal` — optional total uncompressed byte count passed to the
   *     server via `X-Migration-Bytes-Total`. Lets the server populate
   *     `bytesTotal` in progress events so the UI can render a ratio.
   *
   * Legacy positional-timeoutMs callers (pre-Stage 6) are still supported
   * via a `number` argument in place of the options object.
   */
  async postStream(
    path: string,
    stream: import('node:stream').Readable,
    optionsOrTimeoutMs: number | PostStreamOptions = 2 * 60 * 60 * 1000,
  ): Promise<unknown> {
    const options: PostStreamOptions =
      typeof optionsOrTimeoutMs === 'number'
        ? { timeoutMs: optionsOrTimeoutMs }
        : optionsOrTimeoutMs;

    const timeoutMs = options.timeoutMs ?? 2 * 60 * 60 * 1000;
    const url = `${this.cloudUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = {
      ...this.buildDefaultHeaders(),
      'Content-Type': 'application/gzip',
    };
    if (options.onProgress) {
      headers['Accept'] = 'application/x-ndjson';
    }
    if (typeof options.bytesTotal === 'number' && options.bytesTotal > 0) {
      headers['X-Migration-Bytes-Total'] = String(Math.floor(options.bytesTotal));
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: stream as unknown as BodyInit,
        signal: controller.signal,
        // @ts-expect-error -- Node.js fetch supports duplex for streaming uploads
        duplex: 'half',
      });
      clearTimeout(timeout);

      if (!res.ok) {
        let errorBody: { code?: string; message?: string } = {};
        try { errorBody = await res.json() as { code?: string; message?: string }; } catch { /* ignore */ }
        throw new CloudServiceError(
          errorBody.message ?? `Stream upload failed: ${res.status} ${res.statusText}`,
          errorBody.code ?? 'CLOUD_HTTP_ERROR',
          res.status,
        );
      }
      if (res.status === 204) return undefined;

      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      const isNdjson = contentType.includes('application/x-ndjson');

      if (isNdjson) {
        if (!res.body) {
          throw new CloudServiceError('NDJSON response had no body', 'CLOUD_HTTP_ERROR', res.status);
        }
        const parsed = await parseNdjsonResponse(
          res.body as unknown as NdjsonChunkSource,
          options.onProgress,
        );
        if (parsed.error || !parsed.result) {
          throw new CloudServiceError(
            parsed.error ?? 'NDJSON stream ended without result event',
            'CLOUD_HTTP_ERROR',
            res.status,
          );
        }
        const r = parsed.result;
        if (!r.success) {
          throw new CloudServiceError(
            r.error ?? 'Cloud extract reported failure',
            'CLOUD_HTTP_ERROR',
            res.status,
          );
        }
        // Return a legacy-compatible shape so callers that don't care about
        // NDJSON see no change.
        return {
          success: true,
          fileCount: r.fileCount,
          archiveSize: r.archiveSize,
        };
      }

      return await res.json();
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof CloudServiceError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new CloudServiceError(`Stream upload timed out: ${path}`, 'TIMEOUT');
      }
      throw new CloudServiceError(
        `Stream upload network error: ${err instanceof Error ? err.message : String(err)}`,
        'CLOUD_UNREACHABLE',
      );
    }
  }

  async patch(path: string, body?: unknown): Promise<unknown> {
    return this.httpRequest('PATCH', path, body);
  }

  async delete(path: string): Promise<unknown> {
    return this.httpRequest('DELETE', path);
  }

  // ---- Agent turn streaming -----------------------------------------------

  /**
   * Open a WebSocket to the cloud service for agent turn streaming.
   *
   * Flow:
   * 1. Opens WS to /api/agent/turn
   * 2. Sends the AgentTurnRequest as JSON
   * 3. Receives { type: 'turn_started', turnId, clientTurnId? } first
   * 4. Streams AgentEvent objects via onEvent callback
   * 5. WS closes after terminal event (result/error)
   *
   * Returns { turnId } once the cloud service confirms the turn started.
   */
  async startAgentTurn(
    request: AgentTurnRequest,
    onEvent: (event: AgentEvent) => void,
    onClose?: (code: number, reason: string) => void,
  ): Promise<{ turnId: string }> {
    const wsUrl = this.cloudUrl.replace(/^http/, 'ws') + '/api/agent/turn';

    return new Promise<{ turnId: string }>((resolve, reject) => {
      let turnId: string | null = null;

      const ws = new WebSocket(wsUrl, {
        headers: this.buildDefaultHeaders(),
        handshakeTimeout: DEFAULT_TIMEOUT_MS,
      });

      const timeout = setTimeout(() => {
        ws.close();
        reject(new CloudServiceError(
          'Agent turn timed out waiting for turn_started',
          'TIMEOUT',
        ));
      }, AGENT_TURN_TIMEOUT_MS);

      this.activeWebSocket = ws;

      ws.on('open', () => {
        log.debug({ wsUrl }, 'Agent turn WebSocket opened');
        ws.send(JSON.stringify(request));
      });

      ws.on('message', (data: WebSocket.Data) => {
        // R2 Stage 3a-D1 (260502 plan): manifest-validated ingress with
        // control-frame / AgentEvent split. See `cloudTurnControlMessageSchema.ts`
        // for the schema-collision (Phase-2 P0-1) explanation: every control-frame
        // schema member uses `.strict()` so AgentEvent `error` events (which share
        // the `{ type: 'error', error: string }` prefix) fail control-frame
        // parsing on their envelope fields and route to the AgentEvent branch.
        let msg: unknown;
        try {
          msg = JSON.parse(data.toString('utf-8'));
        } catch {
          log.warn(
            { rawPreview: truncateRawMessageForLog(data.toString('utf-8')) },
            '[cloud-ingress] received non-JSON message on agent turn WS',
          );
          cloudIngressRejectionCounter.inc({ reason: 'json-parse-failed' });
          return;
        }

        // 1. Try control-frame schema FIRST (these gate turnId lifecycle).
        const controlResult = CloudTurnControlMessageSchema.safeParse(msg);
        if (controlResult.success) {
          const ctrl = controlResult.data;
          if (ctrl.type === 'turn_started') {
            turnId = ctrl.turnId;
            recordTurnPersistenceAckStatus(request.sessionId, ctrl.turnId, 'in_flight');
            clearTimeout(timeout);
            resolve({ turnId });
            return;
          }
          if (ctrl.type === 'error' && !turnId) {
            // Error before turn_started — reject the promise.
            clearTimeout(timeout);
            reject(new CloudServiceError(
              ctrl.error || 'Agent turn failed to start',
              'TURN_START_FAILED',
            ));
            return;
          }
          if (ctrl.type === 'turn_in_flight' || ctrl.type === 'turn_persisted') {
            // Phase-2 P1 turnId-mismatch guard: if the cloud control frame
            // declares a turnId that doesn't match the consumer's recorded
            // turnId, log + count + drop (do NOT silently ignore).
            if (turnId && ctrl.turnId !== undefined && ctrl.turnId !== turnId) {
              log.warn(
                {
                  rawPreview: truncateRawMessageForLog(msg),
                  expectedTurnId: turnId,
                  receivedTurnId: ctrl.turnId,
                  frameType: ctrl.type,
                },
                '[cloud-ingress] control-frame turnId mismatch',
              );
              cloudIngressRejectionCounter.inc({ reason: 'turnid-mismatch' });
              return;
            }

            const ackTurnId = ctrl.turnId ?? turnId;
            if (ackTurnId) {
              recordTurnPersistenceAckStatus(
                request.sessionId,
                ackTurnId,
                ctrl.type === 'turn_persisted' ? 'persisted' : 'in_flight',
              );
            }

            log.debug(
              { frameType: ctrl.type, turnId: ackTurnId ?? turnId },
              '[cloud-ingress] processed persistence control frame',
            );
            return;
          }
          // Post-turnId control-frame `error`: with `.strict()` schemas,
          // real AgentEvent errors do NOT reach this branch (their envelope
          // fields cause control-frame parse failure → AgentEvent branch).
          // A post-turnId control-frame `error` here is anomalous; log at
          // debug level + count + drop.
          if (ctrl.type === 'error') {
            log.debug(
              { rawPreview: truncateRawMessageForLog(msg), turnId },
              '[cloud-ingress] post-turnId control-frame error (anomalous)',
            );
            cloudIngressRejectionCounter.inc({ reason: 'post-turnstarted-control-error' });
            return;
          }
          return;
        }

        // 2. Not a control frame. Must be an AgentEvent (only valid post-turnId).
        if (!turnId) {
          log.warn(
            {
              rawPreview: truncateRawMessageForLog(msg),
              controlIssues: controlResult.error.issues.slice(0, 5),
            },
            '[cloud-ingress] non-control frame received before turn_started',
          );
          cloudIngressRejectionCounter.inc({ reason: 'pre-turnstarted-non-control' });
          return;
        }

        // 3. Manifest-validate the AgentEvent and dispatch.
        const eventResult = AgentEventSchemaFromManifest.safeParse(msg);
        if (!eventResult.success) {
          log.warn(
            {
              rawPreview: truncateRawMessageForLog(msg),
              issues: eventResult.error.issues.slice(0, 5),
              turnId,
            },
            '[cloud-ingress] manifest-rejected agent event',
          );
          cloudIngressRejectionCounter.inc({ reason: 'manifest-reject' });
          return;
        }
        try {
          // R2 Stage 3a-D1: `eventResult.data` is `AgentEventFromManifest` (the
          // discriminatedUnion-from-manifest inferred type); `onEvent` consumers
          // expect `AgentEvent` from @shared/types. The two unions are derived
          // from the same source-of-truth schema (manifest is the truth post
          // R2 Stage 2 cutover), so this cast is structurally safe and
          // type-narrowing-equivalent. The cast satisfies the no-restricted-
          // syntax R2 guard because parsing happened FIRST via
          // AgentEventSchemaFromManifest.safeParse — i.e. this is not an
          // unvalidated cast like the pre-cutover `msg as unknown as AgentEvent`.
          // eslint-disable-next-line no-restricted-syntax -- post-validation cast: parsed via AgentEventSchemaFromManifest above
          onEvent(eventResult.data as AgentEvent);
        } catch (err) {
          log.error({ err, turnId, eventType: eventResult.data.type }, 'onEvent callback threw');
        }
      });

      ws.on('error', (err: Error) => {
        log.error({ err, wsUrl }, 'Agent turn WebSocket error');
        clearTimeout(timeout);
        if (!turnId) {
          reject(new CloudServiceError(
            `WebSocket connection failed: ${err.message}`,
            'WS_CONNECTION_FAILED',
          ));
        }
      });

      ws.on('close', (code: number, reason: Buffer) => {
        clearTimeout(timeout);
        this.activeWebSocket = null;
        const reasonStr = reason.toString('utf-8');
        log.debug({ code, reason: reasonStr, turnId }, 'Agent turn WebSocket closed');
        if (!turnId) {
          reject(new CloudServiceError(
            'WebSocket closed before turn started',
            'WS_CLOSED_EARLY',
          ));
        } else {
          onClose?.(code, reasonStr);
        }
      });
    });
  }

  // ---- Health check -------------------------------------------------------

  /**
   * Check if the cloud service is reachable.
   * Health endpoint is unauthenticated (for load balancers/Fly health checks).
   */
  async healthCheck(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);

      const res = await fetch(`${this.cloudUrl}/api/health`, {
        signal: controller.signal,
        headers: {
          [CLIENT_ID_HEADER_NAME]: this.clientId,
        },
      });
      clearTimeout(timeout);

      return res.ok;
    } catch {
      return false;
    }
  }

  // ---- Lifecycle ----------------------------------------------------------

  /**
   * Disconnect: close any active WebSocket.
   * HTTP connections are stateless and don't need explicit cleanup.
   */
  disconnect(): void {
    if (this.activeWebSocket) {
      try {
        this.activeWebSocket.close(1000, 'Client disconnecting');
      } catch {
        // Socket may already be closed
      }
      this.activeWebSocket = null;
    }
  }

  // ---- Internal -----------------------------------------------------------

  private async httpRequest(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    let lastError: CloudServiceError | undefined;

    for (let attempt = 0; attempt <= MAX_503_RETRIES; attempt++) {
      const url = `${this.cloudUrl}${path}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

      try {
        const headers: Record<string, string> = this.buildDefaultHeaders();
        let rawBytes = 0;
        let gzipBytes: number | undefined;

        const init: RequestInit = {
          method,
          headers,
          signal: controller.signal,
        };

        if (body !== undefined) {
          const jsonBody = JSON.stringify(body);
          const jsonBytes = Buffer.byteLength(jsonBody, 'utf-8');
          rawBytes = jsonBytes;
          headers['Content-Type'] = 'application/json';

          if (jsonBytes >= GZIP_BODY_THRESHOLD_BYTES) {
            const compressed = await gzipAsync(Buffer.from(jsonBody));
            gzipBytes = compressed.byteLength;
            headers['Content-Encoding'] = 'gzip';
            init.body = compressed as unknown as BodyInit;
            safeLog(() => log.debug({ method, route: sanitizeRouteForLog(path), rawBytes: jsonBytes, gzipBytes: compressed.byteLength }, 'Compressing large request body'));
          } else {
            init.body = jsonBody;
          }
        }

        safeLog(() => log.debug({
          method,
          route: sanitizeRouteForLog(path),
          rawBytes,
          ...(gzipBytes !== undefined ? { gzipBytes } : {}),
          surface: 'desktop',
        }, 'payload_size'));
        recordPayloadHistogramSample(rawBytes);

        const res = await fetch(url, init);
        clearTimeout(timeout);

        // 503 = Fly Machine waking or service booting — retry with backoff
        if (res.status === 503 && attempt < MAX_503_RETRIES) {
          const backoff = INITIAL_503_BACKOFF_MS * Math.pow(2, attempt);
          log.info({ method, path, attempt: attempt + 1, backoffMs: backoff }, '503 received, retrying');
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }

        if (!res.ok) {
          let errorBody: { code?: string; message?: string; error?: unknown } = {};
          try {
            errorBody = await res.json() as { code?: string; message?: string; error?: unknown };
          } catch {
            // Response body may not be JSON
          }
          const structuredError = errorBody.error;
          const structuredErrorCode = typeof structuredError === 'string'
            ? structuredError
            : structuredError && typeof structuredError === 'object' && typeof (structuredError as { code?: unknown }).code === 'string'
              ? (structuredError as { code: string }).code
              : undefined;
          const structuredErrorMessage = structuredError && typeof structuredError === 'object' && typeof (structuredError as { message?: unknown }).message === 'string'
            ? (structuredError as { message: string }).message
            : undefined;

          throw new CloudServiceError(
            errorBody.message ?? structuredErrorMessage ?? `Cloud request failed: ${res.status} ${res.statusText}`,
            errorBody.code ?? structuredErrorCode ?? 'CLOUD_HTTP_ERROR',
            res.status,
          );
        }

        // Track cloud version from response header (for update detection)
        const cloudVersion = res.headers.get('x-rebel-cloud-version');
        if (cloudVersion) {
          this.lastSeenCloudVersion = cloudVersion;
        }
        const capabilitiesHeader = res.headers.get('x-rebel-capabilities');
        if (capabilitiesHeader !== null) {
          this.lastSeenCapabilities = capabilitiesHeader
            .split(',')
            .map((capability) => capability.trim())
            .filter((capability) => capability.length > 0);
        }

        // 204 No Content
        if (res.status === 204) return undefined;

        return await res.json();
      } catch (err) {
        clearTimeout(timeout);

        if (err instanceof CloudServiceError) {
          lastError = err;
          if (err.statusCode === 503 && attempt < MAX_503_RETRIES) {
            const backoff = INITIAL_503_BACKOFF_MS * Math.pow(2, attempt);
            log.info({ method, path, attempt: attempt + 1, backoffMs: backoff }, '503 error, retrying');
            await new Promise((r) => setTimeout(r, backoff));
            continue;
          }
          throw err;
        }

        // AbortError = timeout
        if (err instanceof Error && err.name === 'AbortError') {
          throw new CloudServiceError(
            `Cloud request timed out: ${method} ${path}`,
            'TIMEOUT',
          );
        }

        // Network errors (ECONNREFUSED, ENOTFOUND, etc.)
        const hostname = new URL(this.cloudUrl).hostname;
        const errorCode = await classifyNetworkError(err, hostname);
        const errorMessage = errorCode === 'DNS_CACHE_STALE'
          ? `DNS lookup failed for ${hostname} but upstream records exist. Your local DNS cache may be stale — wait a few minutes or flush your DNS cache.`
          : errorCode === 'DNS_NOT_PROPAGATED'
            ? `No DNS records found for ${hostname}. If this instance was just created, DNS may take a few minutes to propagate.`
            : `Cloud unreachable (${hostname}): ${(err as Error).message}`;
        throw new CloudServiceError(errorMessage, errorCode);
      }
    }

    throw lastError ?? new CloudServiceError('Max retries exceeded', 'CLOUD_HTTP_ERROR', 503);
  }
}

// ---------------------------------------------------------------------------
// DNS error classification
// ---------------------------------------------------------------------------

function isEnotfound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Node fetch wraps the real error in cause
  const cause = (err as Error & { cause?: Error }).cause;
  if (cause && 'code' in cause && (cause as NodeJS.ErrnoException).code === 'ENOTFOUND') return true;
  // Fallback: check message and code on the error itself
  if ('code' in err && (err as NodeJS.ErrnoException).code === 'ENOTFOUND') return true;
  if (err.message?.includes('ENOTFOUND')) return true;
  return false;
}

/**
 * Classify a network error as DNS-related or generic unreachable.
 * Uses dns.resolve() (c-ares, generally bypasses OS resolver cache) to
 * distinguish "upstream DNS exists but local cache is stale" from
 * "DNS not yet propagated." Classification is best-effort.
 */
async function classifyNetworkError(
  err: unknown,
  hostname: string,
): Promise<'DNS_CACHE_STALE' | 'DNS_NOT_PROPAGATED' | 'CLOUD_UNREACHABLE'> {
  if (!isEnotfound(err)) return 'CLOUD_UNREACHABLE';

  try {
    const records = await dns.resolve(hostname, 'A');
    if (records.length > 0) {
      return 'DNS_CACHE_STALE';
    }
    return 'DNS_NOT_PROPAGATED';
  } catch {
    return 'DNS_NOT_PROPAGATED';
  }
}
