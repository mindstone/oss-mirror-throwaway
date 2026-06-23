/**
 * Meeting session routes — chunked mobile meeting upload lifecycle.
 *
 * Endpoints:
 * - POST /api/meeting/session/create
 * - POST /api/meeting/session/:id/chunk
 * - GET  /api/meeting/session/:id/status
 * - POST /api/meeting/session/:id/finalize
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { sendJson, readBody, log, sendRouteError, RouteError } from '../httpUtils';
import { getBearerTokenHash } from '../auth';
import { MeetingSessionIdempotencyCache } from '../services/meetingSessionIdempotencyCache';
import type {
  MeetingUploadSessionError,
  MeetingUploadSessionStore,
} from '@core/services/meetings/meetingUploadSessionService';

const MAX_CHUNK_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB safety cap per chunk
const meetingSessionIdempotencyCache = new MeetingSessionIdempotencyCache();

interface CreateRequestBody {
  companionSessionId?: unknown;
}

interface FinalizeRequestBody {
  totalChunks?: unknown;
  companionSessionId?: unknown;
}

interface CoachRequestBody {
  skillId?: unknown;
  skillName?: unknown;
}

function decodeHeaderValue(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function routeErrorForMeetingError(error: MeetingUploadSessionError): RouteError {
  switch (error.kind) {
    case 'session_not_found':
      return new RouteError('SESSION_NOT_FOUND', { status: 404, message: 'Meeting session not found' });
    case 'session_not_recording':
      return new RouteError('SESSION_NOT_RECORDING', {
        status: 409,
        message: error.context === 'coach'
          ? `Session is in "${error.status}" state — coaching requires an active recording`
          : `Session is in "${error.status}" state and no longer accepts new chunks`,
      });
    case 'chunk_conflict':
      return new RouteError('CHUNK_CONFLICT', { status: 409, message: `Chunk index ${error.chunkIndex} already exists with a different idempotency key` });
    case 'chunk_range_gap':
      return new RouteError('CHUNK_RANGE_GAP', {
        status: 409,
        message: 'Chunk indices are not contiguous from 0 to totalChunks - 1',
        details: {
          missingIndices: error.missing,
          extraIndices: error.extras,
          expectedTotalChunks: error.expected,
          receivedChunkCount: error.received,
        },
      });
    case 'invalid_total_chunks':
      return new RouteError('INVALID_TOTAL_CHUNKS', { status: 400, message: 'Body must include a positive integer `totalChunks`' });
    case 'missing_skill_id':
      return new RouteError('MISSING_SKILL_ID', { status: 400, message: 'Body must include a non-empty `skillId`' });
    case 'companion_session_mismatch':
      return new RouteError('MEETING_SESSION_FINALIZE_COMPANION_MISMATCH', {
        status: 409,
        message: 'Companion session id cannot change once the meeting session is bound',
      });
  }
}

function normalizeCompanionSessionId(value: unknown): string | null | 'invalid' {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return 'invalid';
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hashCompanionSessionId(companionSessionId: string | null): string | null {
  if (!companionSessionId) return null;
  return createHash('sha256').update(companionSessionId).digest('hex').slice(0, 12);
}

function hashForLog(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export async function handleMeetingSessionCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: MeetingUploadSessionStore,
  idempotencyCache: MeetingSessionIdempotencyCache = meetingSessionIdempotencyCache,
): Promise<void> {
  if (req.method !== 'POST') {
    return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Only POST is allowed' }));
  }

  await store.ready();

  let body: CreateRequestBody | null;
  try {
    body = await readBody(req) as CreateRequestBody | null;
  } catch (err) {
    return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: err instanceof Error ? err.message : 'Invalid create request body' }));
  }

  const normalizedCompanionSessionId = normalizeCompanionSessionId(body?.companionSessionId);
  if (normalizedCompanionSessionId === 'invalid') {
    return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'companionSessionId must be a string or null when provided' }));
  }

  const meetingTitle = decodeHeaderValue(req.headers['x-meeting-title']);
  const rawStart = decodeHeaderValue(req.headers['x-meeting-start-time']);
  const parsedStart = rawStart ? parseInt(rawStart, 10) : NaN;
  const meetingStartTime = Number.isFinite(parsedStart) && parsedStart > 0
    ? parsedStart
    : Date.now();

  const idempotencyKey = decodeHeaderValue(req.headers['x-idempotency-key']);
  if (!idempotencyKey) {
    const { sessionId } = await store.createSession({
      meetingTitle,
      meetingStartTime,
      companionSessionId: normalizedCompanionSessionId,
    });
    return sendJson(res, 201, { sessionId });
  }

  const bearerTokenHash = getBearerTokenHash(req) ?? 'missing-bearer-token';
  const createResult = await idempotencyCache.withAtomicKey(
    { bearerTokenHash, idempotencyKey },
    async () => {
      const replayResolution = idempotencyCache.evaluateReplay({
        bearerTokenHash,
        idempotencyKey,
        companionSessionId: normalizedCompanionSessionId,
      });

      switch (replayResolution.kind) {
        case 'hit': {
          if (replayResolution.reason === 'request-missing-companion' && replayResolution.record.companionSessionId) {
            log({
              level: 'warn',
              msg: 'meeting-session-idempotency-hit-with-missing-companion-id-request',
              bearerTokenHash,
              idempotencyKeyHash: hashForLog(idempotencyKey),
              companionSessionIdHash: hashCompanionSessionId(replayResolution.record.companionSessionId),
            });
          }
          log({
            level: 'info',
            msg: 'meeting-session-idempotency-hit',
            bearerTokenHash,
            idempotencyKeyHash: hashForLog(idempotencyKey),
            cloudSessionIdHash: hashForLog(replayResolution.record.cloudSessionId),
          });
          return {
            status: 200,
            sessionId: replayResolution.record.cloudSessionId,
          };
        }

        case 'conflict':
          return {
            status: 409 as const,
            existingCompanionSessionIdHash: hashCompanionSessionId(replayResolution.record.companionSessionId),
            nextCompanionSessionIdHash: hashCompanionSessionId(normalizedCompanionSessionId),
            sessionId: replayResolution.record.cloudSessionId,
          };

        case 'backfill': {
          if (!normalizedCompanionSessionId) {
            return {
              status: 200,
              sessionId: replayResolution.record.cloudSessionId,
            };
          }

          const setCompanionResult = await store.setCompanionSessionId({
            sessionId: replayResolution.record.cloudSessionId,
            companionSessionId: normalizedCompanionSessionId,
          });
          if (!setCompanionResult.ok) {
            return {
              status: 409 as const,
              existingCompanionSessionIdHash: hashCompanionSessionId(replayResolution.record.companionSessionId),
              nextCompanionSessionIdHash: hashCompanionSessionId(normalizedCompanionSessionId),
              sessionId: replayResolution.record.cloudSessionId,
            };
          }

          idempotencyCache.backfillCompanionSessionId({
            bearerTokenHash,
            idempotencyKey,
            companionSessionId: normalizedCompanionSessionId,
          });
          log({
            level: 'info',
            msg: 'meeting-session-idempotency-companion-id-backfilled',
            bearerTokenHash,
            idempotencyKeyHash: hashForLog(idempotencyKey),
            cloudSessionIdHash: hashForLog(replayResolution.record.cloudSessionId),
            companionSessionIdHash: hashCompanionSessionId(normalizedCompanionSessionId),
          });
          return {
            status: 200,
            sessionId: replayResolution.record.cloudSessionId,
          };
        }

        case 'miss': {
          const { sessionId } = await store.createSession({
            meetingTitle,
            meetingStartTime,
            companionSessionId: normalizedCompanionSessionId,
          });
          idempotencyCache.upsert({
            bearerTokenHash,
            idempotencyKey,
            cloudSessionId: sessionId,
            companionSessionId: normalizedCompanionSessionId,
          });
          return { status: 201, sessionId };
        }
      }
    },
  );

  if (createResult.status === 409) {
    log({
      level: 'warn',
      msg: 'meeting-session-idempotency-conflict',
      bearerTokenHash,
      idempotencyKeyHash: hashForLog(idempotencyKey),
      existingCompanionSessionIdHash: createResult.existingCompanionSessionIdHash,
      nextCompanionSessionIdHash: createResult.nextCompanionSessionIdHash,
      cloudSessionIdHash: hashForLog(createResult.sessionId),
    });
    return sendRouteError(res, undefined, new RouteError('MEETING_SESSION_IDEMPOTENCY_CONFLICT', {
      status: 409,
      message: 'Idempotency key was already used for a different companion session',
    }));
  }

  return sendJson(res, createResult.status, { sessionId: createResult.sessionId });
}

export async function handleMeetingSessionChunkUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionId: string,
  store: MeetingUploadSessionStore,
): Promise<void> {
  if (req.method !== 'POST') {
    return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Only POST is allowed' }));
  }

  await store.ready();

  const state = store.getSession(sessionId);
  if (!state) {
    return sendRouteError(res, undefined, new RouteError('SESSION_NOT_FOUND', { status: 404, message: 'Meeting session not found' }));
  }

  const rawChunkIndex = decodeHeaderValue(req.headers['x-chunk-index']);
  const chunkIndex = rawChunkIndex ? parseInt(rawChunkIndex, 10) : NaN;
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    return sendRouteError(res, undefined, new RouteError('INVALID_CHUNK_INDEX', { status: 400, message: 'X-Chunk-Index must be a non-negative integer' }));
  }

  const idempotencyKey = decodeHeaderValue(req.headers['x-idempotency-key']);
  if (!idempotencyKey) {
    return sendRouteError(res, undefined, new RouteError('MISSING_IDEMPOTENCY_KEY', { status: 400, message: 'X-Idempotency-Key header is required' }));
  }

  const contentType = req.headers['content-type'];
  if (!contentType || !contentType.startsWith('audio/')) {
    return sendRouteError(res, undefined, new RouteError('INVALID_CONTENT_TYPE', { status: 400, message: 'Content-Type must be an audio mime type' }));
  }

  const uploadValidation = store.validateChunkUpload({ sessionId, chunkIndex, idempotencyKey });
  if (!uploadValidation.ok) {
    return sendRouteError(res, undefined, routeErrorForMeetingError(uploadValidation.error));
  }
  if (uploadValidation.idempotent) {
    return sendJson(res, 200, {
      received: true,
      chunkIndex,
      totalReceived: uploadValidation.totalReceived,
    });
  }

  await store.fileStorage.ensureSessionDir(sessionId);

  const finalChunkPath = store.fileStorage.getChunkPath(sessionId, chunkIndex);
  const tempChunkPath = `${finalChunkPath}.tmp-upload`;

  const fileHandle = await fs.open(tempChunkPath, 'w');
  const writeStream = fileHandle.createWriteStream();
  const hash = createHash('sha256');
  let totalBytes = 0;
  let uploadExceededSizeLimit = false;

  try {
    await new Promise<void>((resolve, reject) => {
      req.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_CHUNK_UPLOAD_BYTES) {
          uploadExceededSizeLimit = true;
          writeStream.destroy();
          req.destroy();
          reject(new Error('Chunk exceeds max upload size'));
          return;
        }
        hash.update(chunk);
      });

      req.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      req.on('error', reject);
    });

    await fs.rename(tempChunkPath, finalChunkPath);
  } catch (err) {
    await fileHandle.close().catch(() => {});
    await fs.unlink(tempChunkPath).catch(() => {});

    if (uploadExceededSizeLimit) {
      if (!res.writableEnded) {
        return sendRouteError(res, undefined, new RouteError('CHUNK_TOO_LARGE', { status: 413, message: `Chunk exceeds maximum allowed size of ${MAX_CHUNK_UPLOAD_BYTES / (1024 * 1024)}MB` }));
      }
      return;
    }

    const postFailureValidation = store.validateChunkUpload({ sessionId, chunkIndex, idempotencyKey });
    if (!postFailureValidation.ok && postFailureValidation.error.kind === 'chunk_conflict') {
      return sendRouteError(res, undefined, routeErrorForMeetingError(postFailureValidation.error));
    }

    log({
      level: 'error',
      msg: 'Failed to persist meeting chunk upload',
      sessionId,
      chunkIndex,
      error: err instanceof Error ? err.message : String(err),
    });

    return sendRouteError(res, undefined, new RouteError('CHUNK_UPLOAD_FAILED', { status: 500, message: 'Failed to persist uploaded chunk' }));
  }

  const recordResult = store.recordChunk({
    sessionId,
    chunkIndex,
    idempotencyKey,
    hash: hash.digest('hex'),
    finalChunkPath,
    sizeBytes: totalBytes,
  });
  if (!recordResult.ok) {
    return sendRouteError(res, undefined, routeErrorForMeetingError(recordResult.error));
  }

  return sendJson(res, 200, {
    received: true,
    chunkIndex,
    totalReceived: recordResult.totalReceived,
  });
}

export async function handleMeetingSessionStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionId: string,
  store: MeetingUploadSessionStore,
): Promise<void> {
  if (req.method !== 'GET') {
    return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Only GET is allowed' }));
  }

  await store.ready();

  const status = store.getStatus(sessionId);
  if (!status) {
    return sendRouteError(res, undefined, new RouteError('SESSION_NOT_FOUND', { status: 404, message: 'Meeting session not found' }));
  }

  return sendJson(res, 200, status);
}

export async function handleMeetingSessionFinalize(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionId: string,
  store: MeetingUploadSessionStore,
): Promise<void> {
  if (req.method !== 'POST') {
    return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Only POST is allowed' }));
  }

  await store.ready();

  if (!store.getSession(sessionId)) {
    return sendRouteError(res, undefined, new RouteError('SESSION_NOT_FOUND', { status: 404, message: 'Meeting session not found' }));
  }

  let body: FinalizeRequestBody | null;
  try {
    body = await readBody(req) as FinalizeRequestBody | null;
  } catch (err) {
    return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: err instanceof Error ? err.message : 'Invalid finalize request body' }));
  }

  const totalChunks = typeof body?.totalChunks === 'number'
    ? body.totalChunks
    : Number.NaN;

  const result = await store.requestFinalize({
    sessionId,
    totalChunks,
    companionSessionId: typeof body?.companionSessionId === 'string' && body.companionSessionId ? body.companionSessionId : undefined,
  });

  if (!result.ok) {
    if (result.error.kind === 'companion_session_mismatch') {
      log({
        level: 'warn',
        msg: 'meeting-session-finalize-companion-mismatch',
        sessionIdHash: hashForLog(sessionId),
        existingCompanionSessionIdHash: hashCompanionSessionId(result.error.existingCompanionSessionId),
        nextCompanionSessionIdHash: hashCompanionSessionId(result.error.nextCompanionSessionId),
      });
    }
    return sendRouteError(res, undefined, routeErrorForMeetingError(result.error));
  }

  if (result.kind === 'already_in_progress') {
    return sendJson(res, 202, {
      accepted: true,
      status: result.status,
    });
  }

  return sendJson(res, 202, { accepted: true });
}

export async function handleMeetingSessionCoachActivate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionId: string,
  store: MeetingUploadSessionStore,
): Promise<void> {
  if (req.method !== 'POST') {
    return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Only POST is allowed' }));
  }

  await store.ready();

  if (!store.getSession(sessionId)) {
    return sendRouteError(res, undefined, new RouteError('SESSION_NOT_FOUND', { status: 404, message: 'Meeting session not found' }));
  }

  let body: CoachRequestBody | null;
  try {
    body = await readBody(req) as CoachRequestBody | null;
  } catch (err) {
    return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: err instanceof Error ? err.message : 'Invalid coach request body' }));
  }

  const skillId = typeof body?.skillId === 'string' ? body.skillId : '';
  const skillName = typeof body?.skillName === 'string' ? body.skillName : 'Coaching';
  const result = store.activateCoaching(sessionId, { skillId, skillName });

  if (!result.ok) {
    return sendRouteError(res, undefined, routeErrorForMeetingError(result.error));
  }

  return sendJson(res, 200, result.value);
}

export async function handleMeetingSessionCoachDeactivate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionId: string,
  store: MeetingUploadSessionStore,
): Promise<void> {
  if (req.method !== 'DELETE') {
    return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Only DELETE is allowed' }));
  }

  await store.ready();

  const result = store.deactivateCoaching(sessionId);
  if (!result.ok) {
    return sendRouteError(res, undefined, routeErrorForMeetingError(result.error));
  }

  return sendJson(res, 200, result.value);
}
