/**
 * Session route handlers.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { log, readBody, sendJson, sendRouteError, RouteError } from '../httpUtils';
import { cloudEventBroadcaster } from '../cloudEventBroadcaster';
import { readContinuityStateMap, markSessionAsCloudActive } from '@core/services/cloudContinuityStateService';
import type { CloudServiceDeps } from '../bootstrap';
import {
  CATCH_UP_MAX_LIMIT,
  buildContinuityStateBreadcrumb,
  getCatchUpEvents,
  hashSessionId,
  listSessionSummaries,
  parseCatchUpLimit,
  parseSinceSeq,
  processSessionEventsAppend,
  processSessionDelete,
  processSessionPut,
  projectSessionForRead,
  resetCloudSessionMergeServiceForTests,
  resolveWriteSourceFromBody,
  type CloudSessionEffectSink,
  type CloudSessionMergeDeps,
  type SessionSurfaceTag,
} from '@core/services/cloudSessionMergeService';
import { computeTurnChecksum } from '@core/services/eventCanonicalForm';
import { AGENT_SESSION_METADATA_PATCH_KEYS, type AgentSessionMetadataPatch } from '@shared/types';
import { normalizeFinishLine } from '@core/utils/finishLine';
import { getErrorReporter } from '@core/errorReporter';
import {
  getSessionTombstoneStore,
  type SessionDeletedBy,
} from '@core/services/continuity/sessionTombstoneStore';
import { SessionMutexDeadlockError } from '@core/services/sessionMutex';
import { getOutboxStallMonitor } from '@core/services/continuity/outboxStallMonitor';
import { appendDiagnosticEvent } from '@core/services/diagnosticEventsLedger';
import { toDiagnosticContinuityTransition } from '@shared/diagnostics/continuityTransition';
import { getMaxSeqFromSession } from '@core/services/continuity/sessionSeqIndex';

import { getAssetStore } from '@core/assetStore';
import { getContentStore } from '@core/contentStore';
import { createScopedLogger } from '@core/logger';
import { recordAssetResolutionFailure } from '@core/services/assetResolutionObservability';
import { getDataPath } from '@core/utils/dataPaths';
import { ALLOWED_IMAGE_MIME_TYPES } from '@shared/markdownImageAssets';
import { z } from 'zod';

const TOMBSTONES_RATE_LIMIT_WINDOW_MS = 60_000;
const TOMBSTONES_RATE_LIMIT_MAX_HITS = 1;
const TOMBSTONE_RACE_ESCALATION_WINDOW_MS = 60 * 60 * 1000;

type SessionSurface = SessionSurfaceTag;

function getHeaderValue(req: http.IncomingMessage, name: string): string | null {
  const raw = req.headers[name];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
  return null;
}

export function parseSurfaceHeader(
  req: http.IncomingMessage,
  logger: (entry: Record<string, unknown>) => void = log,
): SessionSurface {
  const rawHeader = getHeaderValue(req, 'x-rebel-surface');
  const value = rawHeader?.trim().toLowerCase();
  if (value === 'desktop' || value === 'mobile' || value === 'cloud' || value === 'cli') return value;

  logger({
    level: 'warn',
    msg: 'surface.untagged-request',
    path: req.url,
    method: req.method,
    rawHeader: rawHeader ?? undefined,
  });
  return 'cloud-untagged';
}

function normalizeCloudScopeSurface(surface: SessionSurface): 'desktop' | 'mobile' | 'cloud' {
  return surface === 'desktop' || surface === 'mobile' ? surface : 'cloud';
}

function getDeletedBy(req: http.IncomingMessage, surface = parseSurfaceHeader(req)): SessionDeletedBy {
  const scopedSurface = normalizeCloudScopeSurface(surface);
  if (scopedSurface === 'desktop' || scopedSurface === 'mobile') return scopedSurface;
  return 'cloud';
}

function getDeviceScopeKey(req: http.IncomingMessage, surface = parseSurfaceHeader(req)): string {
  const scopedSurface = normalizeCloudScopeSurface(surface);
  const bearer = (getHeaderValue(req, 'authorization') ?? '')
    .replace(/^Bearer\s+/i, '')
    .trim() || 'anonymous';
  const clientId = getHeaderValue(req, 'x-rebel-client-id')?.trim() || 'unknown-client';
  return `${bearer}:${scopedSurface}:${clientId}`;
}

class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly maxHits: number,
    private readonly windowMs: number,
  ) {
    this.cleanupTimer = setInterval(() => this.cleanup(), windowMs);
    this.cleanupTimer.unref?.();
  }

  isLimited(key: string): boolean {
    const now = Date.now();
    const timestamps = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
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
      const active = timestamps.filter((t) => now - t < this.windowMs);
      if (active.length === 0) {
        this.hits.delete(key);
      } else {
        this.hits.set(key, active);
      }
    }
  }
}

const tombstonesReadLimiter = new RateLimiter(
  TOMBSTONES_RATE_LIMIT_MAX_HITS,
  TOMBSTONES_RATE_LIMIT_WINDOW_MS,
);
const lastTombstoneRaceEscalationAt = new Map<string, number>();
const outboxStallMonitor = getOutboxStallMonitor();
const assetResolutionLog = createScopedLogger({ service: 'cloudSessionsAssetsRoute' });
const sessionsRouteLog = createScopedLogger({ service: 'cloudSessionsRoute' });
const SESSION_EVENTS_APPEND_MAX_EVENTS = 5_000;
const METADATA_PATCH_KEY_SET = new Set<string>(AGENT_SESSION_METADATA_PATCH_KEYS);
const MAX_ASSET_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_CONTENT_UPLOAD_BYTES = 10 * 1024 * 1024;
const SAFE_ASSET_ROUTE_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

const StrictContentRefSchema = z.object({
  contentId: z.string().min(1),
  mimeType: z.string().min(1),
  byteSize: z.number().finite().nonnegative(),
  summary: z.string().optional(),
  etag: z.string().optional(),
  uploadStatus: z.enum(['pending', 'uploaded', 'missing']).optional(),
}).strict();

function maybeEscalateTombstoneRace(args: {
  req: http.IncomingMessage;
  sessionId: string;
  deletedAt: number;
  deletedBy: SessionDeletedBy;
  direction: string;
  surface?: SessionSurface;
}): void {
  const surface = args.surface ?? parseSurfaceHeader(args.req);
  const deviceKey = getDeviceScopeKey(args.req, surface);
  const now = Date.now();
  const last = lastTombstoneRaceEscalationAt.get(deviceKey);
  if (last !== undefined && now - last < TOMBSTONE_RACE_ESCALATION_WINDOW_MS) return;
  lastTombstoneRaceEscalationAt.set(deviceKey, now);

  getErrorReporter().captureMessage('Continuity tombstone race detected', {
    level: 'warning',
    tags: {
      continuity_event: 'continuity-state:tombstone-race-detected',
      surface,
      direction: args.direction,
    },
    extra: {
      sessionIdHash: hashSessionId(args.sessionId),
      deletedAt: args.deletedAt,
      deletedBy: args.deletedBy,
    },
  });
}

export function _resetSessionsRouteTombstoneStateForTests(): void {
  tombstonesReadLimiter.reset();
  lastTombstoneRaceEscalationAt.clear();
  resetCloudSessionMergeServiceForTests();
  outboxStallMonitor.resetForTests();
}

function createMergeDeps(deps: CloudServiceDeps): CloudSessionMergeDeps {
  return {
    getSession: deps.getSession,
    upsertSession: deps.upsertSession,
    deleteSession: deps.deleteSession,
    getActiveTurnController: deps.getActiveTurnController,
    listSessions: deps.listSessions,
    readContinuityStateMap,
  };
}

function createEffectSink(): CloudSessionEffectSink {
  return {
    // dynamic-broadcast-reviewed: `event.channel` is statically bounded — CloudSessionEffectSink.emit
    // accepts the CLOSED CloudBroadcast union, whose 4 members are each declared in cloudEventChannel:
    // cloud:session-changed (exempt/intercepted), cloud:session-conflict (allowlisted),
    // cloud:session-tombstoned (exempt), cloud:session-event (exempt — no desktop receive path; deltas
    // converge via the intercepted cloud:session-changed). It cannot introduce an unclassified channel.
    emit: (event) => {
      cloudEventBroadcaster.broadcast(event.channel, event.payload);
    },
    breadcrumb: (breadcrumb) => {
      getErrorReporter().addBreadcrumb(breadcrumb);
    },
    appendDiagnosticEvent,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function validateMetadataPatch(value: unknown): AgentSessionMetadataPatch | undefined | null {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) return null;
  for (const key of Object.keys(value)) {
    if (!METADATA_PATCH_KEY_SET.has(key)) return null;
  }
  const patch = { ...value } as AgentSessionMetadataPatch;
  if (Object.prototype.hasOwnProperty.call(patch, 'finishLine')) {
    const raw = patch.finishLine;
    if (raw === null) {
      patch.finishLine = null;
    } else {
      const normalized = normalizeFinishLine(raw);
      patch.finishLine = normalized ?? null;
    }
  }
  return patch;
}

function validateStringArray(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return null;
  return value;
}

/**
 * Validate that any `contentRef` inside the events array satisfies the
 * structural contract (`contentId`, `mimeType`, `byteSize`). Returns the
 * first offending entry so the route can reject with a structured 400.
 *
 * Accepts `null` entries (failure markers) and missing fields entirely
 * (events without contentRef). See Stage B1a § MEDIUM #7.
 */
function validateNestedContentRefs(events: unknown[]):
  | { reason: string; eventIndex: number }
  | null {
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (!event || typeof event !== 'object') continue;

    const topLevelRefs = (event as { contentRef?: unknown }).contentRef;
    if (topLevelRefs !== undefined) {
      if (!Array.isArray(topLevelRefs)) {
        return { reason: 'contentRef must be an array', eventIndex: i };
      }
      for (let j = 0; j < topLevelRefs.length; j += 1) {
        const reason = validateContentRefShape(topLevelRefs[j]);
        if (reason) return { reason: `top-level[${j}]: ${reason}`, eventIndex: i };
      }
    }

    const toolResult = (event as { toolResult?: unknown }).toolResult;
    if (toolResult && typeof toolResult === 'object') {
      const content = (toolResult as { content?: unknown }).content;
      if (Array.isArray(content)) {
        for (let k = 0; k < content.length; k += 1) {
          const block = content[k];
          if (!block || typeof block !== 'object') continue;
          const type = (block as { type?: unknown }).type;
          if (type !== 'content_ref') continue;
          const reason = validateContentRefShape((block as { contentRef?: unknown }).contentRef);
          if (reason) return { reason: `toolResult.content[${k}]: ${reason}`, eventIndex: i };
        }
      }
    }
  }
  return null;
}

function validateContentRefShape(value: unknown): string | null {
  if (value === null) return null;
  const parsed = StrictContentRefSchema.safeParse(value);
  return parsed.success
    ? null
    : parsed.error.issues.map((issue) => issue.message).join('; ');
}

function mapAppendOutcomeToHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionId: string,
  outcome: Awaited<ReturnType<typeof processSessionEventsAppend>>,
  surface: SessionSurface,
  metadataOnly = false,
): void | Promise<void> {
  if (outcome.kind === 'applied') {
    return sendJson(res, 200, metadataOnly
      ? { success: true, cloudUpdatedAt: outcome.cloudUpdatedAt }
      : {
          success: true,
          appliedCount: outcome.appliedCount,
          appliedSeq: outcome.appliedSeq,
          serverSeq: outcome.serverSeq,
          cloudUpdatedAt: outcome.cloudUpdatedAt,
        }, req);
  }
  if (outcome.kind === 'needs-reconcile') {
    return sendJson(res, 409, {
      error: 'NEEDS_RECONCILE',
      serverSeq: outcome.serverSeq,
      cloudUpdatedAt: outcome.cloudUpdatedAt,
    }, req);
  }
  if (outcome.kind === 'needs-bootstrap') {
    return sendJson(res, 404, { error: 'NEEDS_BOOTSTRAP', sessionId }, req);
  }
  if (outcome.kind === 'invalid-seq') {
    return sendJson(res, 409, {
      error: 'INVALID_SEQ',
      offendingEventIds: outcome.offendingEventIds,
      serverSeq: outcome.serverSeq,
    }, req);
  }
  if (outcome.kind === 'invalid-envelope') {
    return sendJson(res, 400, {
      error: 'INVALID_ENVELOPE',
      reason: outcome.reason,
      ...(outcome.offendingEventCount !== undefined ? { offendingEventCount: outcome.offendingEventCount } : {}),
      ...(outcome.offendingPair !== undefined ? { offendingPair: outcome.offendingPair } : {}),
    }, req);
  }
  if (outcome.raceDetected) {
    maybeEscalateTombstoneRace({
      req,
      sessionId,
      deletedAt: outcome.tombstone.deletedAt,
      deletedBy: outcome.tombstone.deletedBy,
      direction: outcome.direction,
      surface,
    });
  }
  return sendJson(res, 410, {
    error: 'session-tombstoned',
    tombstone: outcome.tombstone,
  }, req);
}

function emitCloudContinuityStateBreadcrumb(
  breadcrumb: ReturnType<typeof buildContinuityStateBreadcrumb>,
): void {
  getErrorReporter().addBreadcrumb(breadcrumb);
  appendDiagnosticEvent(toDiagnosticContinuityTransition({
    family: 'merge',
    category: breadcrumb.category,
    level: breadcrumb.level,
    message: breadcrumb.message,
    surface: 'cloud',
    data: breadcrumb.data,
  }));
}

function assertSafeSessionId(sessionId: string): void {
  if (!SAFE_ASSET_ROUTE_ID_REGEX.test(sessionId)) {
    throw new RouteError('INVALID_PATH', {
      status: 400,
      message: 'invalid sessionId format',
    });
  }
}

function assertSafeAssetId(assetId: string): void {
  if (!SAFE_ASSET_ROUTE_ID_REGEX.test(assetId)) {
    throw new RouteError('INVALID_PATH', {
      status: 400,
      message: 'invalid assetId format',
    });
  }
}

function assertSafeContentId(contentId: string): void {
  if (!SAFE_ASSET_ROUTE_ID_REGEX.test(contentId)) {
    throw new RouteError('INVALID_PATH', {
      status: 400,
      message: 'invalid contentId format',
    });
  }
}

async function readContentRequestBody(
  req: http.IncomingMessage,
  expectedContentLength: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  let requestAborted = false;
  const onAborted = () => {
    requestAborted = true;
  };
  req.on('aborted', onAborted);

  try {
    for await (const rawChunk of req) {
      const chunk = Buffer.isBuffer(rawChunk)
        ? rawChunk
        : Buffer.from(rawChunk as Uint8Array);
      bytesRead += chunk.length;
      if (bytesRead > MAX_CONTENT_UPLOAD_BYTES) {
        req.destroy();
        throw new RouteError('BODY_TOO_LARGE', {
          status: 413,
          message: 'Content blob exceeds size limit',
        });
      }
      chunks.push(chunk);
    }

    if (requestAborted || bytesRead !== expectedContentLength) {
      throw new RouteError('INVALID_PARAM', {
        status: 400,
        message: 'Content upload body length mismatch',
      });
    }

    return Buffer.concat(chunks, bytesRead);
  } finally {
    req.off('aborted', onAborted);
  }
}

function resolveSessionPendingUploadPath(
  sessionId: string,
  assetId: string,
): { pendingDir: string; tempPath: string } {
  const sessionDir = path.join(getDataPath(), 'sessions', `${sessionId}.assets`);
  const pendingDir = path.join(sessionDir, '_pending');
  const tempPath = path.join(
    pendingDir,
    `${assetId}.${randomUUID()}.pending`,
  );
  return { pendingDir, tempPath };
}

async function streamAssetRequestToTempFile(args: {
  req: http.IncomingMessage;
  tempPath: string;
  expectedContentLength: number;
}): Promise<number> {
  const { req, tempPath, expectedContentLength } = args;
  const writeStream = createWriteStream(tempPath, { flags: 'wx' });
  let bytesWritten = 0;
  let requestAborted = false;
  const onAborted = () => {
    requestAborted = true;
  };
  req.on('aborted', onAborted);

  try {
    for await (const rawChunk of req) {
      const chunk = Buffer.isBuffer(rawChunk)
        ? rawChunk
        : Buffer.from(rawChunk as Uint8Array);
      bytesWritten += chunk.length;
      if (bytesWritten > MAX_ASSET_UPLOAD_BYTES) {
        req.destroy();
        throw new RouteError('BODY_TOO_LARGE', {
          status: 413,
          message: 'Asset exceeds size limit',
        });
      }
      if (!writeStream.write(chunk)) {
        await once(writeStream, 'drain');
      }
    }

    await new Promise<void>((resolve, reject) => {
      writeStream.once('finish', () => resolve());
      writeStream.once('error', (err) => reject(err));
      writeStream.end();
    });

    if (requestAborted || bytesWritten !== expectedContentLength) {
      throw new RouteError('INVALID_PARAM', {
        status: 400,
        message: 'Asset upload body length mismatch',
      });
    }

    return bytesWritten;
  } catch (error) {
    writeStream.destroy();
    throw error;
  } finally {
    req.off('aborted', onAborted);
  }
}

export async function handleSessions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  segments: string[],
  deps: CloudServiceDeps,
): Promise<void> {
  const tombstoneStore = getSessionTombstoneStore();
  const sessionId = segments[2] || null;
  const subRoute = segments[3] || null;

  // Folders carrier: GET/PUT /api/sessions/folders
  //
  // CRITICAL ORDERING (Amendment A3): this branch MUST precede the positional
  // `sessionId` GET/PUT branches AND the `tombstones` branch.
  // `SAFE_ASSET_ROUTE_ID_REGEX` ACCEPTS the literal `folders`, so without this
  // guard `/api/sessions/folders` would parse `folders` as a sessionId and be
  // dispatched to the session GET (→ 404) / PUT (→ upsertSession) handlers.
  // Route ordering is the ONLY collision guard. See PLAN.md F10.
  if (sessionId === 'folders' && !subRoute) {
    const { readCloudFolders, writeCloudFolders } = await import('../services/cloudFolderStorage');
    const { parseFolderStoreData } = await import('@shared/ipc/schemas/folders');

    if (req.method === 'GET') {
      const doc = await readCloudFolders();
      return sendJson(res, 200, doc, req);
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      const parsed = parseFolderStoreData(body);
      if (!parsed) {
        return sendRouteError(res, undefined, new RouteError('INVALID_BODY', {
          status: 400,
          message: 'Body must be a valid folders document (version 1)',
        }));
      }
      await writeCloudFolders(parsed);
      return sendJson(res, 200, { success: true }, req);
    }
    return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', {
      status: 405,
      message: `${req.method} not allowed`,
    }));
  }

  // Share sub-route: /api/sessions/:id/share
  if (sessionId && subRoute === 'share') {
    const { handleSessionShare } = await import('./share');
    return handleSessionShare(req, res, sessionId, deps);
  }

  // Asset upload endpoint: POST /api/sessions/:id/assets/:assetId
  if (req.method === 'POST' && sessionId && subRoute === 'assets' && segments[4]) {
    const assetId = segments[4];

    try {
      assertSafeSessionId(sessionId);
      assertSafeAssetId(assetId);
    } catch (error) {
      if (error instanceof RouteError) {
        return sendRouteError(res, undefined, error);
      }
      throw error;
    }

    const contentLengthHeader = getHeaderValue(req, 'content-length');
    if (!contentLengthHeader) {
      return sendRouteError(res, undefined, new RouteError('INVALID_PARAM', {
        status: 411,
        message: 'Content-Length header is required',
      }));
    }
    if (!/^\d+$/.test(contentLengthHeader.trim())) {
      return sendRouteError(res, undefined, new RouteError('INVALID_PARAM', {
        status: 400,
        message: 'Invalid Content-Length header',
      }));
    }
    const parsedContentLength = Number.parseInt(contentLengthHeader, 10);
    if (parsedContentLength > MAX_ASSET_UPLOAD_BYTES) {
      recordAssetResolutionFailure({
        sessionId,
        assetId,
        reason: 'oversized',
        context: 'upload',
        metadata: { parsedContentLength, maxBytes: MAX_ASSET_UPLOAD_BYTES },
        log: assetResolutionLog,
      });
      return sendRouteError(res, undefined, new RouteError('BODY_TOO_LARGE', {
        status: 413,
        message: 'Asset exceeds size limit',
      }));
    }

    const mimeType = getHeaderValue(req, 'x-asset-mime-type');
    if (!mimeType) {
      return sendRouteError(res, undefined, new RouteError('INVALID_PARAM', { status: 400, message: 'Missing x-asset-mime-type header' }));
    }

    // Cloud-service is per-user-per-instance (see MOBILE_PAIRING_AND_AUTH.md).
    // The bearer token authenticates the sole user. Session-existence check
    // prevents uploads to unknown sessions; no per-user ownership check is
    // needed in this architecture.
    const session = await deps.getSession(sessionId);
    if (!session) {
      return sendRouteError(res, undefined, new RouteError('SESSION_NOT_FOUND', {
        status: 403,
        message: 'Session not found',
      }));
    }

    const { pendingDir, tempPath } = resolveSessionPendingUploadPath(sessionId, assetId);
    try {
      await fsp.mkdir(pendingDir, { recursive: true });
      await streamAssetRequestToTempFile({
        req,
        tempPath,
        expectedContentLength: parsedContentLength,
      });

      const assetStore = getAssetStore();
      const writeResult = assetStore.writeAssetFromTempFile
        ? await assetStore.writeAssetFromTempFile({
          sessionId,
          assetId,
          tempPath,
          mimeType,
        })
        : await (async () => {
          const bytes = await fsp.readFile(tempPath);
          return assetStore.writeAsset({
            sessionId,
            assetId,
            bytes,
            mimeType,
          });
        })();

      const statusCode = writeResult.status === 'duplicate' ? 200 : 201;
      return sendJson(res, statusCode, { success: true }, req);
    } catch (err: unknown) {
      if (err instanceof RouteError) {
        return sendRouteError(res, undefined, err);
      }
      const code = (err as { code?: unknown }).code;
      if (code === 'conflict') {
        recordAssetResolutionFailure({
          sessionId,
          assetId,
          reason: 'upload-failed',
          context: 'upload',
          metadata: { code },
          log: assetResolutionLog,
        });
        return sendRouteError(res, undefined, new RouteError('CHUNK_CONFLICT', { status: 409, message: 'Asset exists with different content' }));
      }
      if (code === 'mime-rejected' || code === 'magic-byte-mismatch') {
        recordAssetResolutionFailure({
          sessionId,
          assetId,
          reason: code === 'mime-rejected' ? 'mime-rejected' : 'corrupt',
          context: 'upload',
          metadata: { code },
          log: assetResolutionLog,
        });
        return sendRouteError(res, undefined, new RouteError('INVALID_PARAM', {
          status: 400,
          message: (err as Error).message,
        }));
      }
      if (code === 'path-traversal') {
        recordAssetResolutionFailure({
          sessionId,
          assetId,
          reason: 'permission-denied',
          context: 'upload',
          metadata: { code },
          log: assetResolutionLog,
        });
        return sendRouteError(res, undefined, new RouteError('INVALID_PATH', {
          status: 400,
          message: 'invalid sessionId or assetId format',
        }));
      }
      recordAssetResolutionFailure({
        sessionId,
        assetId,
        reason: 'unknown',
        context: 'upload',
        metadata: {
          err: err instanceof Error ? err.message : String(err),
        },
        log: assetResolutionLog,
      });
      throw err; // will be caught by 500 handler
    } finally {
      await fsp.unlink(tempPath).catch(() => {});
    }
  }

  // Asset download endpoint: GET /api/sessions/:id/assets/:assetId[?thumb=1]
  if (req.method === 'GET' && sessionId && subRoute === 'assets' && segments[4]) {
    const assetId = segments[4];

    try {
      assertSafeSessionId(sessionId);
      assertSafeAssetId(assetId);
    } catch (error) {
      if (error instanceof RouteError) {
        return sendRouteError(res, undefined, error);
      }
      throw error;
    }

    const session = await deps.getSession(sessionId);
    if (!session) {
      return sendRouteError(res, undefined, new RouteError('SESSION_NOT_FOUND', {
        status: 403,
        message: 'Session not found',
      }));
    }

    const urlObj = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const isThumb = urlObj.searchParams.get('thumb') === '1';
    const targetAssetId = isThumb ? `${assetId}_thumb` : assetId;

    const assetStore = getAssetStore();
    let result = await assetStore.readAsset({ sessionId, assetId: targetAssetId });

    if (isThumb && result.reason === 'not-found') {
      result = await assetStore.readAsset({ sessionId, assetId });
    }

    if (result.reason === 'ok') {
      if (!ALLOWED_IMAGE_MIME_TYPES.includes(result.mimeType as (typeof ALLOWED_IMAGE_MIME_TYPES)[number])) {
        recordAssetResolutionFailure({
          sessionId,
          assetId,
          reason: 'mime-rejected',
          context: 'cloud-get',
          metadata: {
            mimeType: result.mimeType,
            thumb: isThumb,
            sessionIdHash: hashSessionId(sessionId),
            assetIdSuffix: assetId.slice(-8),
          },
          log: assetResolutionLog,
        });
        res.writeHead(415, {
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline';",
          'Content-Length': '0',
        });
        res.end();
        return;
      }

      const etag = isThumb ? `"${assetId}-thumb"` : `"${assetId}"`;
      const ifNoneMatch = getHeaderValue(req, 'if-none-match');
      if (ifNoneMatch && ifNoneMatch.trim() === etag) {
        res.writeHead(304, {
          ETag: etag,
          'Cache-Control': 'private, max-age=86400',
        });
        res.end();
        return;
      }

      res.writeHead(200, {
        'Content-Type': result.mimeType,
        'Content-Length': String(result.byteSize),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline';",
        'Cache-Control': 'private, max-age=86400',
        ETag: etag,
      });
      res.end(result.bytes);
      return;
    }

    recordAssetResolutionFailure({
      sessionId,
      assetId,
      reason: result.reason,
      context: 'cloud-get',
      metadata: {
        thumb: isThumb,
        sessionIdHash: hashSessionId(sessionId),
        assetIdSuffix: assetId.slice(-8),
      },
      log: assetResolutionLog,
    });

    const headers: Record<string, string> = {
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline';",
      'Content-Length': '0',
    };

    let status = 500;
    if (result.reason === 'not-found') status = 404;
    else if (result.reason === 'permission-denied') status = 403;
    else if (result.reason === 'mime-rejected' || result.reason === 'corrupt') status = 415;
    else if (result.reason === 'oversized') status = 413;

    res.writeHead(status, headers);
    res.end();
    return;
  }

  // Content upload endpoint: POST /api/sessions/:id/content/:contentId
  // Stage B1a — mirrors the asset upload route for opaque non-image blobs.
  if (req.method === 'POST' && sessionId && subRoute === 'content' && segments[4]) {
    const contentId = segments[4];

    try {
      assertSafeSessionId(sessionId);
      assertSafeContentId(contentId);
    } catch (error) {
      if (error instanceof RouteError) {
        return sendRouteError(res, undefined, error);
      }
      throw error;
    }

    const contentLengthHeader = getHeaderValue(req, 'content-length');
    if (!contentLengthHeader) {
      return sendRouteError(res, undefined, new RouteError('INVALID_PARAM', {
        status: 411,
        message: 'Content-Length header is required',
      }));
    }
    if (!/^\d+$/.test(contentLengthHeader.trim())) {
      return sendRouteError(res, undefined, new RouteError('INVALID_PARAM', {
        status: 400,
        message: 'Invalid Content-Length header',
      }));
    }
    const parsedContentLength = Number.parseInt(contentLengthHeader, 10);
    if (parsedContentLength > MAX_CONTENT_UPLOAD_BYTES) {
      return sendRouteError(res, undefined, new RouteError('BODY_TOO_LARGE', {
        status: 413,
        message: 'Content blob exceeds size limit',
      }));
    }

    const mimeTypeHeader = getHeaderValue(req, 'x-content-mime-type');
    const mimeType = mimeTypeHeader && mimeTypeHeader.trim().length > 0
      ? mimeTypeHeader.trim()
      : 'application/octet-stream';

    // Cloud-service is per-user-per-instance — bearer auth gates the user.
    // Session-existence check rejects uploads for unknown sessions.
    const session = await deps.getSession(sessionId);
    if (!session) {
      return sendRouteError(res, undefined, new RouteError('SESSION_NOT_FOUND', {
        status: 403,
        message: 'Session not found',
      }));
    }

    let bytes: Buffer;
    try {
      bytes = await readContentRequestBody(req, parsedContentLength);
    } catch (err) {
      if (err instanceof RouteError) {
        return sendRouteError(res, undefined, err);
      }
      throw err;
    }

    try {
      const contentStore = getContentStore();
      const writeResult = await contentStore.writeContent({
        sessionId,
        contentId,
        bytes,
        mimeType,
      });
      const statusCode = writeResult.status === 'duplicate' ? 200 : 201;
      return sendJson(res, statusCode, {
        etag: writeResult.ref.etag ?? contentId,
        status: writeResult.status ?? 'created',
      }, req);
    } catch (err: unknown) {
      if (err instanceof RouteError) {
        return sendRouteError(res, undefined, err);
      }
      const code = (err as { code?: unknown }).code;
      if (code === 'conflict') {
        return sendRouteError(res, undefined, new RouteError('CHUNK_CONFLICT', {
          status: 409,
          message: 'Content already exists with different bytes',
        }));
      }
      if (code === 'path-traversal') {
        return sendRouteError(res, undefined, new RouteError('INVALID_PATH', {
          status: 400,
          message: 'invalid sessionId or contentId format',
        }));
      }
      if (code === 'storage-full') {
        return sendRouteError(res, undefined, new RouteError('INTERNAL_ERROR', {
          status: 507,
          message: 'Insufficient storage',
        }));
      }
      throw err;
    }
  }

  // Content download endpoint: GET /api/sessions/:id/content/:contentId
  if (req.method === 'GET' && sessionId && subRoute === 'content' && segments[4]) {
    const contentId = segments[4];

    try {
      assertSafeSessionId(sessionId);
      assertSafeContentId(contentId);
    } catch (error) {
      if (error instanceof RouteError) {
        return sendRouteError(res, undefined, error);
      }
      throw error;
    }

    const session = await deps.getSession(sessionId);
    if (!session) {
      return sendRouteError(res, undefined, new RouteError('SESSION_NOT_FOUND', {
        status: 403,
        message: 'Session not found',
      }));
    }

    const contentStore = getContentStore();
    const result = await contentStore.readContent({ sessionId, contentId });

    if (result.reason === 'ok') {
      const etag = `"${contentId}"`;
      const ifNoneMatch = getHeaderValue(req, 'if-none-match');
      if (ifNoneMatch && ifNoneMatch.trim() === etag) {
        res.writeHead(304, {
          ETag: etag,
          'Cache-Control': 'private, max-age=86400',
        });
        res.end();
        return;
      }

      res.writeHead(200, {
        'Content-Type': result.mimeType,
        'Content-Length': String(result.byteSize),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=86400',
        ETag: etag,
      });
      res.end(result.bytes);
      return;
    }

    const headers: Record<string, string> = {
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': '0',
    };
    let status = 500;
    if (result.reason === 'not-found') status = 404;
    else if (result.reason === 'permission-denied') status = 403;
    else if (result.reason === 'corrupt') status = 415;

    res.writeHead(status, headers);
    res.end();
    return;
  }

  // Delta append endpoint: POST /api/sessions/:id/events
  if (req.method === 'POST' && sessionId && subRoute === 'events') {
    const body = await readBody(req);
    if (!isPlainRecord(body)) {
      return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'Body must be a JSON object' }));
    }
    if (!isNonNegativeInteger(body.baseSeq)) {
      return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'baseSeq must be a non-negative integer' }));
    }
    if (!Array.isArray(body.events)) {
      return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'events must be an array' }));
    }
    if (body.events.length > SESSION_EVENTS_APPEND_MAX_EVENTS) {
      return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: `events must contain at most ${SESSION_EVENTS_APPEND_MAX_EVENTS} entries` }));
    }
    const messageDelta = body.messageDelta;
    if (messageDelta !== undefined && !Array.isArray(messageDelta)) {
      return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'messageDelta must be an array when provided' }));
    }
    const messageDeletes = validateStringArray(body.messageDeletes);
    if (messageDeletes === null) {
      return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'messageDeletes must be an array of strings' }));
    }
    const metadataPatch = validateMetadataPatch(body.metadataPatch);
    if (metadataPatch === null) {
      return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'metadataPatch contains unsupported keys' }));
    }
    const destructiveOps = body._destructiveOps;
    if (destructiveOps !== undefined && !isPlainRecord(destructiveOps)) {
      return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: '_destructiveOps must be an object when provided' }));
    }
    const truncateTurns = destructiveOps ? validateStringArray(destructiveOps.truncateTurns) : undefined;
    const deleteEventIdentities = destructiveOps ? validateStringArray(destructiveOps.deleteEventIdentities) : undefined;
    if (truncateTurns === null || deleteEventIdentities === null) {
      return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: '_destructiveOps arrays must contain strings' }));
    }
    // Stage B1a § MEDIUM #7: validate nested contentRef shape so producers
    // cannot inject malformed refs (e.g. negative byteSize, missing mime)
    // into stored events. We accept `null` entries (materialization
    // failure markers) but reject objects that do not satisfy the
    // structural contract.
    const contentRefRejection = validateNestedContentRefs(body.events);
    if (contentRefRejection) {
      sessionsRouteLog.warn(
        {
          sessionId,
          reason: contentRefRejection.reason,
          eventIndex: contentRefRejection.eventIndex,
        },
        'Rejected events append: malformed nested contentRef',
      );
      return sendRouteError(res, undefined, new RouteError('INVALID_BODY', {
        status: 400,
        message: `Invalid contentRef in events[${contentRefRejection.eventIndex}]: ${contentRefRejection.reason}`,
      }));
    }

    const surface = parseSurfaceHeader(req);
    const deviceScopeKey = getDeviceScopeKey(req, surface);
    outboxStallMonitor.recordDrainStarted(deviceScopeKey);
    try {
      const outcome = await processSessionEventsAppend(createMergeDeps(deps), {
        sessionId,
        baseSeq: body.baseSeq,
        events: body.events as Parameters<typeof processSessionEventsAppend>[1]['events'],
        messageDelta: messageDelta as Parameters<typeof processSessionEventsAppend>[1]['messageDelta'],
        messageDeletes,
        _destructiveOps: destructiveOps ? { truncateTurns, deleteEventIdentities } : undefined,
        idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
        metadataPatch,
        surface,
        source: surface,
        sink: createEffectSink(),
      });
      outboxStallMonitor.recordDrainCompleted(deviceScopeKey, outcome.kind === 'applied' ? outcome.appliedCount : 0);
      return mapAppendOutcomeToHttp(req, res, sessionId, outcome, surface);
    } catch (error) {
      if (error instanceof SessionMutexDeadlockError) {
        return sendRouteError(res, undefined, new RouteError('SESSION_MUTEX_DEADLOCK', { status: 503, message: error.message }));
      }
      throw error;
    }
  }

  // Catch-up events endpoint: /api/sessions/:id/events?sinceSeq=<n>&limit=<n>
  if (req.method === 'GET' && sessionId && subRoute === 'events') {
    const urlObj = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const sinceSeq = parseSinceSeq(urlObj.searchParams.get('sinceSeq'));
    if (sinceSeq === null) {
      return sendRouteError(res, undefined, new RouteError('INVALID_PARAM', { status: 400, message: 'sinceSeq must be a non-negative integer' }));
    }

    const limit = parseCatchUpLimit(urlObj.searchParams.get('limit'));
    if (limit === null) {
      return sendRouteError(res, undefined, new RouteError('INVALID_PARAM', { status: 400, message: `limit must be a positive integer (max ${CATCH_UP_MAX_LIMIT})` }));
    }

    const outcome = await getCatchUpEvents(createMergeDeps(deps), { sessionId, sinceSeq, limit });
    if (outcome.kind === 'tombstoned') {
      return sendJson(res, 410, {
        error: 'session-tombstoned',
        tombstone: {
          sessionId: outcome.tombstone.sessionId,
          deletedAt: outcome.tombstone.deletedAt,
          deletedBy: outcome.tombstone.deletedBy,
          reason: outcome.tombstone.deletedBy,
          ttlExpiresAt: outcome.tombstone.ttlExpiresAt,
        },
      }, req);
    }
    if (outcome.kind === 'not_found') {
      return sendRouteError(res, undefined, new RouteError('SESSION_NOT_FOUND', { status: 404, message: `Session "${sessionId}" not found` }));
    }

    return sendJson(res, 200, {
      events: outcome.events,
      serverSeq: outcome.serverSeq,
      hasMore: outcome.hasMore,
      messageDelta: outcome.messageDelta,
      messageDeletes: outcome.messageDeletes,
      destructiveOpsApplied: outcome.destructiveOpsApplied,
    }, req);
  }

  // Reconcile handshake endpoint: GET /api/sessions/:id/reconcile?clientSeq=<n>
  if (req.method === 'GET' && sessionId && subRoute === 'reconcile') {
    const urlObj = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const clientSeq = parseSinceSeq(urlObj.searchParams.get('clientSeq'));
    if (clientSeq === null) {
      return sendRouteError(res, undefined, new RouteError('INVALID_PARAM', {
        status: 400,
        message: 'clientSeq must be a non-negative integer',
      }));
    }

    if (tombstoneStore.hasTombstone(sessionId)) {
      return sendRouteError(res, undefined, new RouteError('SESSION_NOT_FOUND', {
        status: 404,
        message: `Session "${sessionId}" not found`,
      }));
    }

    const session = await deps.getSession(sessionId);
    if (!session) {
      return sendRouteError(res, undefined, new RouteError('SESSION_NOT_FOUND', {
        status: 404,
        message: `Session "${sessionId}" not found`,
      }));
    }

    const turnChecksums = Object.entries(session.eventsByTurn ?? {})
      .map(([turnId, events]) => ({
        turnId,
        eventCount: events.length,
        contentChecksum: computeTurnChecksum(events),
      }))
      .sort((a, b) => a.turnId.localeCompare(b.turnId));

    return sendJson(res, 200, {
      serverSeq: getMaxSeqFromSession(session),
      turnChecksums,
    }, req);
  }

  // Tombstone list: /api/sessions/tombstones?since=<epoch-ms>
  if (req.method === 'GET' && sessionId === 'tombstones' && !subRoute) {
    const deviceScopeKey = getDeviceScopeKey(req);
    if (tombstonesReadLimiter.isLimited(deviceScopeKey)) {
      return sendRouteError(res, undefined, new RouteError('RATE_LIMITED', { status: 429, message: 'Tombstone sync is limited to 1 request per minute per device' }));
    }

    const urlObj = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const sinceParam = urlObj.searchParams.get('since');
    let since: number | undefined;
    if (sinceParam !== null) {
      since = Number(sinceParam);
      if (!Number.isFinite(since)) {
        return sendRouteError(res, undefined, new RouteError('INVALID_PARAM', { status: 400, message: 'since must be a valid number (epoch ms)' }));
      }
    }

    const tombstones = tombstoneStore.listTombstones(since);
    const serverNow = Date.now();
    return sendJson(res, 200, { tombstones, serverNow }, req);
  }

  if (req.method === 'GET' && !sessionId) {
    const urlObj = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    if (urlObj.searchParams.get('summaries') === 'true') {
      const modifiedSinceParam = urlObj.searchParams.get('modifiedSince');
      let modifiedSince: number | null = null;
      if (modifiedSinceParam) {
        const since = Number(modifiedSinceParam);
        if (!Number.isFinite(since)) {
          return sendRouteError(res, undefined, new RouteError('INVALID_PARAM', { status: 400, message: 'modifiedSince must be a valid number (epoch ms)' }));
        }
        modifiedSince = since;
      }

      const { sessions, totalCount } = await listSessionSummaries(createMergeDeps(deps), {
        activeOnly: urlObj.searchParams.get('activeOnly') === 'true',
        modifiedSince,
      });
      return sendJson(res, 200, { sessions, totalCount }, req);
    }
    const sessions = (await deps.loadSessions())
      .filter((session) => !tombstoneStore.hasTombstone(session.id));
    return sendJson(res, 200, sessions, req);
  }

  if (req.method === 'GET' && sessionId) {
    if (tombstoneStore.hasTombstone(sessionId)) {
      return sendRouteError(res, undefined, new RouteError('SESSION_NOT_FOUND', { status: 404, message: `Session "${sessionId}" not found` }));
    }

    const session = await deps.getSession(sessionId);
    if (!session) return sendRouteError(res, undefined, new RouteError('SESSION_NOT_FOUND', { status: 404, message: `Session "${sessionId}" not found` }));
    const urlObj = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    return sendJson(res, 200, projectSessionForRead(session, {
      lean: urlObj.searchParams.get('lean') === 'true',
      toolEvents: urlObj.searchParams.get('toolEvents') === 'true',
    }), req);
  }

  if (req.method === 'PATCH' && sessionId) {
    const body = await readBody(req);
    if (!isPlainRecord(body)) {
      return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'Body must be a JSON object' }));
    }
    if (!isNonNegativeInteger(body.baseSeq)) {
      return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'baseSeq must be a non-negative integer' }));
    }
    if (typeof body.clientCloudUpdatedAt !== 'number' || !Number.isFinite(body.clientCloudUpdatedAt)) {
      return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'clientCloudUpdatedAt must be a finite number' }));
    }
    const patch = validateMetadataPatch(body.patch);
    if (!patch) {
      return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'patch must be an object containing only supported metadata keys' }));
    }

    const surface = parseSurfaceHeader(req);
    const deviceScopeKey = getDeviceScopeKey(req, surface);
    outboxStallMonitor.recordDrainStarted(deviceScopeKey);
    try {
      const outcome = await processSessionEventsAppend(createMergeDeps(deps), {
        sessionId,
        baseSeq: body.baseSeq,
        events: [],
        metadataPatch: patch,
        clientCloudUpdatedAt: body.clientCloudUpdatedAt,
        surface,
        source: surface,
        sink: createEffectSink(),
      });
      outboxStallMonitor.recordDrainCompleted(deviceScopeKey, 0);
      return mapAppendOutcomeToHttp(req, res, sessionId, outcome, surface, true);
    } catch (error) {
      if (error instanceof SessionMutexDeadlockError) {
        return sendRouteError(res, undefined, new RouteError('SESSION_MUTEX_DEADLOCK', { status: 503, message: error.message }));
      }
      throw error;
    }
  }

  if (req.method === 'PUT' && sessionId) {
    const body = await readBody(req) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'Body must be a JSON session object' }));
    const incomingRaw: Record<string, unknown> = {
      ...body,
      id: sessionId,
    };
    const surface = parseSurfaceHeader(req);
    const source = resolveWriteSourceFromBody(incomingRaw) ?? surface;
    const deviceScopeKey = getDeviceScopeKey(req, surface);
    outboxStallMonitor.recordDrainStarted(deviceScopeKey);

    try {
      const outcome = await processSessionPut(createMergeDeps(deps), {
        sessionId,
        incomingRaw,
        source,
        surface,
        sink: createEffectSink(),
      });
      outboxStallMonitor.recordDrainCompleted(deviceScopeKey, 1);

      if (outcome.kind === 'persisted') {
        // Mark as cloud_active so it appears in activeOnly queries (cloud-native session).
        await markSessionAsCloudActive(sessionId);
        cloudEventBroadcaster.broadcast('cloud:session-changed', { sessionId, action: 'upserted' });
        return sendJson(res, 200, {
          success: true,
          tombstoned: false,
          cloudUpdatedAt: outcome.cloudUpdatedAt,
          serverSeq: outcome.serverSeq,
        }, req);
      }

      if (outcome.raceDetected) {
        maybeEscalateTombstoneRace({
          req,
          sessionId,
          deletedAt: outcome.tombstone.deletedAt,
          deletedBy: outcome.tombstone.deletedBy,
          direction: outcome.direction,
          surface,
        });
      }
      return sendJson(res, 200, { success: true, tombstoned: true }, req);
    } catch (error) {
      if (error instanceof SessionMutexDeadlockError) {
        return sendRouteError(res, undefined, new RouteError('SESSION_MUTEX_DEADLOCK', { status: 503, message: error.message }));
      }
      throw error;
    }
  }

  if (req.method === 'DELETE' && sessionId) {
    const surface = parseSurfaceHeader(req);
    const deviceScopeKey = getDeviceScopeKey(req, surface);
    outboxStallMonitor.recordDrainStarted(deviceScopeKey);
    let outcome: Awaited<ReturnType<typeof processSessionDelete>>;
    try {
      outcome = await processSessionDelete(createMergeDeps(deps), {
        sessionId,
        deletedBy: getDeletedBy(req, surface),
      });
    } catch (error) {
      if (error instanceof SessionMutexDeadlockError) {
        return sendRouteError(res, undefined, new RouteError('SESSION_MUTEX_DEADLOCK', { status: 503, message: error.message }));
      }
      throw error;
    }
    outboxStallMonitor.recordDrainCompleted(deviceScopeKey, 1);

    emitCloudContinuityStateBreadcrumb(buildContinuityStateBreadcrumb({
      sessionId,
      reason: 'tombstone-added',
      direction: `${outcome.tombstone.deletedBy}-delete`,
    }));
    cloudEventBroadcaster.broadcast('cloud:session-changed', { sessionId, action: 'deleted' });
    cloudEventBroadcaster.broadcast('cloud:session-tombstoned', outcome.tombstone);
    return sendJson(res, 200, { success: true, tombstone: outcome.tombstone }, req);
  }

  return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: `${req.method} not allowed` }));
}
