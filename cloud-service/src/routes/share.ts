/**
 * Share link route handlers.
 *
 * HTTP adapters for share-token management and unauthenticated read-only
 * access. Domain logic lives in @core/services/shareLinksService.
 */

import http from 'node:http';
import { createReadStream } from 'node:fs';
import type { CloudErrorCode } from '@core/services/cloudErrorCatalog';
import {
  authorizeSharedFileDownload,
  createConversationShare,
  createFileShare,
  getConversationShare,
  getFileShare,
  isValidPassword,
  isValidShareId,
  listActiveShares,
  managementLimiter,
  publicReadLimiter,
  readSharedResource,
  revokeConversationShare,
  revokeFileShare,
  unlockLimiter,
  unlockSharedResource,
  updateConversationShare,
  updateFileShare,
  type ShareLinksError,
  type ShareLinksResult,
} from '@core/services/shareLinksService';
import { sendJson, readBody, sendRouteError, RouteError } from '../httpUtils';
import type { CloudServiceDeps } from '../bootstrap';

function getBearerToken(req: http.IncomingMessage): string {
  return (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || 'unknown';
}

function getClientIp(req: http.IncomingMessage): string {
  return (req.headers['fly-client-ip'] as string) || req.socket?.remoteAddress || 'unknown';
}

function getWorkspaceDir(deps: CloudServiceDeps): string {
  return deps.getSettings?.().coreDirectory || '/data/workspace';
}

function sendShareError(
  res: http.ServerResponse,
  error: ShareLinksError,
  context: { sessionId?: string } = {},
): void {
  switch (error.kind) {
    case 'session_not_found':
      return sendRouteError(res, undefined, new RouteError('SESSION_NOT_FOUND', { status: 404, message: `Session "${context.sessionId ?? ''}" not found` }));
    case 'session_deleted':
      return sendRouteError(res, undefined, new RouteError('SESSION_DELETED', { status: 400, message: 'Cannot share a deleted conversation' }));
    case 'private_session':
      return sendRouteError(res, undefined, new RouteError('PRIVATE_SESSION', { status: 400, message: 'Cannot share a private conversation' }));
    case 'invalid_expiry':
      return sendRouteError(res, undefined, new RouteError('INVALID_EXPIRY', { status: 400, message: 'expiresIn must be one of: 24h, 7d, 30d, never' }));
    case 'invalid_password':
      return error.message
        ? sendRouteError(res, undefined, new RouteError('INVALID_PASSWORD', { status: 401, message: error.message }))
        : sendRouteError(res, undefined, new RouteError('INVALID_PASSWORD', { status: 400, message: 'Password must be 1–128 characters' }));
    case 'invalid_body':
      return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: error.message }));
    case 'invalid_path':
      return sendRouteError(res, undefined, new RouteError((error.code as CloudErrorCode), { status: error.status, message: error.message }));
    case 'no_share':
      return sendRouteError(res, undefined, new RouteError('NO_SHARE', { status: 404, message: error.resourceType === 'file'
          ? 'No share link exists for this file'
          : 'No share link exists for this conversation' }));
    case 'unauthorized':
      return sendRouteError(res, undefined, new RouteError('UNAUTHORIZED', { status: 401, message: 'Authentication required.' }));
    case 'password_required':
      return sendRouteError(res, undefined, new RouteError('PASSWORD_REQUIRED', { status: 401, message: error.resourceType === 'file'
          ? 'This content is password protected.'
          : 'This conversation is password protected.' }));
    case 'resource_unavailable':
      return sendRouteError(res, undefined, new RouteError('RESOURCE_UNAVAILABLE', { status: 404, message: 'This file is no longer available.' }));
    case 'conversation_unavailable':
      return sendRouteError(res, undefined, new RouteError('CONVERSATION_UNAVAILABLE', { status: 404, message: 'This conversation is no longer available.' }));
    case 'invalid_share_id':
      return error.resourceType === 'file'
        ? sendRouteError(res, undefined, new RouteError('RESOURCE_UNAVAILABLE', { status: 404, message: 'This file is no longer available.' }))
        : sendRouteError(res, undefined, new RouteError('CONVERSATION_UNAVAILABLE', { status: 404, message: 'This conversation is no longer available.' }));
    case 'write_failed':
      return sendRouteError(res, undefined, new RouteError('WRITE_FAILED', { status: 500, message: error.message }));
    case 'download_secret_unconfigured':
      return sendRouteError(res, undefined, new RouteError('INTERNAL_ERROR', { status: 500, message: 'Download service is not configured.' }));
  }
}

function sendResult<T>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  result: ShareLinksResult<T>,
  context: { sessionId?: string } = {},
): boolean {
  if (!result.ok) {
    sendShareError(res, result.error, context);
    return false;
  }
  sendJson(res, 200, result.value, req);
  return true;
}

// ---------------------------------------------------------------------------
// Authenticated handler — POST/GET/DELETE /api/sessions/:id/share
// ---------------------------------------------------------------------------

export async function handleSessionShare(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionId: string,
  deps: CloudServiceDeps,
): Promise<void> {
  if (managementLimiter.isLimited(getBearerToken(req))) {
    return sendRouteError(res, undefined, new RouteError('RATE_LIMITED', { status: 429, message: 'Too many requests. Try again shortly.' }));
  }

  if (req.method === 'POST') {
    const body = (await readBody(req).catch(() => null)) as Record<string, unknown> | null;
    const result = await createConversationShare(
      sessionId,
      { expiresIn: body?.expiresIn, password: body?.password },
      { getSession: deps.getSession },
    );
    sendResult(req, res, result, { sessionId });
    return;
  }

  if (req.method === 'PUT') {
    const body = (await readBody(req).catch(() => null)) as Record<string, unknown> | null;
    if (!body) return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'Request body must be a JSON object' }));
    const result = await updateConversationShare(sessionId, body);
    sendResult(req, res, result, { sessionId });
    return;
  }

  if (req.method === 'GET') {
    const result = await getConversationShare(sessionId);
    sendResult(req, res, result, { sessionId });
    return;
  }

  if (req.method === 'DELETE') {
    const result = await revokeConversationShare(sessionId);
    sendResult(req, res, result, { sessionId });
    return;
  }

  return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: `${req.method} not allowed` }));
}

// ---------------------------------------------------------------------------
// Unauthenticated handler — GET /api/shared/:shareId
// ---------------------------------------------------------------------------

export async function handleSharedConversation(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  shareId: string,
  deps: CloudServiceDeps,
): Promise<void> {
  if (req.method !== 'GET') {
    return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: `${req.method} not allowed` }));
  }
  if (!isValidShareId(shareId)) {
    return sendShareError(res, { kind: 'invalid_share_id', resourceType: 'conversation' });
  }
  if (publicReadLimiter.isLimited(getClientIp(req))) {
    return sendRouteError(res, undefined, new RouteError('RATE_LIMITED', { status: 429, message: 'Too many requests. Try again shortly.' }));
  }

  res.setHeader('Cache-Control', 'no-store');

  const result = await readSharedResource(shareId, {
    getSession: deps.getSession,
    workspaceDir: getWorkspaceDir(deps),
  });
  if (!result.ok) return sendShareError(res, result.error);
  return sendJson(res, 200, result.value.data, req);
}

// ---------------------------------------------------------------------------
// Unauthenticated handler — POST /api/shared/:shareId/unlock
// ---------------------------------------------------------------------------

export async function handleSharedConversationUnlock(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  shareId: string,
  deps: CloudServiceDeps,
): Promise<void> {
  if (req.method !== 'POST') {
    return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: `${req.method} not allowed` }));
  }
  if (!isValidShareId(shareId)) {
    return sendShareError(res, { kind: 'invalid_share_id', resourceType: 'conversation' });
  }
  if (unlockLimiter.isLimited(`${getClientIp(req)}:${shareId}`)) {
    return sendRouteError(res, undefined, new RouteError('RATE_LIMITED', { status: 429, message: 'Too many attempts. Wait a few minutes before trying again.' }));
  }

  res.setHeader('Cache-Control', 'no-store');

  const body = (await readBody(req).catch(() => null)) as Record<string, unknown> | null;
  if (!isValidPassword(body?.password)) {
    return sendRouteError(res, undefined, new RouteError('INVALID_PASSWORD', { status: 400, message: 'Password is required.' }));
  }

  const downloadSecret = process.env.REBEL_SHARE_DOWNLOAD_SECRET;
  const result = await unlockSharedResource(shareId, body.password, {
    getSession: deps.getSession,
    workspaceDir: getWorkspaceDir(deps),
    downloadSecret,
  });
  if (!result.ok) return sendShareError(res, result.error);
  return sendJson(res, 200, result.value.data, req);
}

// ---------------------------------------------------------------------------
// Unauthenticated handler — GET /api/shared/:shareId/download
// ---------------------------------------------------------------------------

export async function handleSharedFileDownload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  shareId: string,
  deps: CloudServiceDeps,
): Promise<void> {
  if (req.method !== 'GET') {
    return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: `${req.method} not allowed` }));
  }
  if (!isValidShareId(shareId)) {
    return sendShareError(res, { kind: 'invalid_share_id', resourceType: 'file' });
  }
  if (publicReadLimiter.isLimited(getClientIp(req))) {
    return sendRouteError(res, undefined, new RouteError('RATE_LIMITED', { status: 429, message: 'Too many requests. Try again shortly.' }));
  }

  const url = new URL(req.url || '', 'http://localhost');
  const downloadSecret = process.env.REBEL_SHARE_DOWNLOAD_SECRET;
  const result = await authorizeSharedFileDownload(shareId, {
    sig: url.searchParams.get('sig'),
    exp: url.searchParams.get('exp'),
    downloadSecret,
    workspaceDir: getWorkspaceDir(deps),
  });
  if (!result.ok) return sendShareError(res, result.error);

  res.writeHead(200, {
    'Content-Type': result.value.mimeType,
    'Content-Length': String(result.value.size),
    'Content-Disposition': result.value.disposition,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });

  const stream = createReadStream(result.value.resolved);
  stream.on('error', () => { res.end(); });
  stream.pipe(res);
}

// ---------------------------------------------------------------------------
// Authenticated handler — GET /api/shares (list all active shares)
// ---------------------------------------------------------------------------

export async function handleSharesList(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method !== 'GET') {
    return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: `${req.method} not allowed` }));
  }
  if (managementLimiter.isLimited(getBearerToken(req))) {
    return sendRouteError(res, undefined, new RouteError('RATE_LIMITED', { status: 429, message: 'Too many requests. Try again shortly.' }));
  }

  const shares = await listActiveShares();
  return sendJson(res, 200, { shares }, req);
}

// ---------------------------------------------------------------------------
// Authenticated handler — POST/GET/PUT/DELETE /api/file-shares
// ---------------------------------------------------------------------------

export async function handleFileShare(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: CloudServiceDeps,
): Promise<void> {
  if (managementLimiter.isLimited(getBearerToken(req))) {
    return sendRouteError(res, undefined, new RouteError('RATE_LIMITED', { status: 429, message: 'Too many requests. Try again shortly.' }));
  }

  const workspaceDir = getWorkspaceDir(deps);

  if (req.method === 'POST') {
    const body = (await readBody(req).catch(() => null)) as Record<string, unknown> | null;
    if (!body) return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'Request body must be a JSON object' }));
    const result = await createFileShare(body, { workspaceDir });
    sendResult(req, res, result);
    return;
  }

  if (req.method === 'GET') {
    const url = new URL(req.url || '', 'http://localhost');
    const filePath = url.searchParams.get('filePath');
    if (!filePath) return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'filePath query parameter is required' }));

    const result = await getFileShare(filePath);
    sendResult(req, res, result);
    return;
  }

  if (req.method === 'PUT') {
    const body = (await readBody(req).catch(() => null)) as Record<string, unknown> | null;
    if (!body) return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'Request body must be a JSON object' }));

    const result = await updateFileShare(body);
    sendResult(req, res, result);
    return;
  }

  if (req.method === 'DELETE') {
    const url = new URL(req.url || '', 'http://localhost');
    const filePath = url.searchParams.get('filePath');
    if (!filePath) return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'filePath query parameter is required' }));

    const result = await revokeFileShare(filePath);
    sendResult(req, res, result);
    return;
  }

  return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: `${req.method} not allowed` }));
}
