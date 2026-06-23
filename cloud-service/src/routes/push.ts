/**
 * Push notification token registration route handlers.
 *
 * POST /api/push/register   — register a device token
 * DELETE /api/push/unregister — unregister a device token
 */

import http from 'node:http';
import { readBody, sendJson, sendRouteError, RouteError } from '../httpUtils';
import { registerToken, unregisterToken } from '../pushStore';

const VALID_PLATFORMS = new Set(['ios', 'android']);

export async function handlePush(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  segments: string[],
): Promise<void> {
  const action = segments[2]; // api/push/<action>

  if (action === 'register' && req.method === 'POST') {
    const body = await readBody(req) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'Body must be a JSON object' }));
    }
    const { deviceToken, platform } = body;
    if (typeof deviceToken !== 'string' || !deviceToken.trim()) {
      return sendRouteError(res, undefined, new RouteError('INVALID_TOKEN', { status: 400, message: 'deviceToken must be a non-empty string' }));
    }
    if (typeof platform !== 'string' || !VALID_PLATFORMS.has(platform)) {
      return sendRouteError(res, undefined, new RouteError('INVALID_PLATFORM', { status: 400, message: 'platform must be "ios" or "android"' }));
    }
    registerToken(deviceToken, platform as 'ios' | 'android');
    return sendJson(res, 200, { success: true });
  }

  if (action === 'unregister' && req.method === 'DELETE') {
    const body = await readBody(req) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'Body must be a JSON object' }));
    }
    const { deviceToken } = body;
    if (typeof deviceToken !== 'string' || !deviceToken.trim()) {
      return sendRouteError(res, undefined, new RouteError('INVALID_TOKEN', { status: 400, message: 'deviceToken must be a non-empty string' }));
    }
    unregisterToken(deviceToken);
    return sendJson(res, 200, { success: true });
  }

  return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: `${req.method} /${segments.join('/')} not allowed` }));
}
