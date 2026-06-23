import fs from 'node:fs';
import type http from 'node:http';
import { RouteError, sendJson, sendRouteError } from '../httpUtils';

const DATA_DIR = process.env.REBEL_USER_DATA || '/data';

export async function handleStorageUsage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method !== 'GET') {
    return sendRouteError(res, req, new RouteError('METHOD_NOT_ALLOWED', {
      status: 405,
      message: 'Method Not Allowed',
    })) as void;
  }

  try {
    const stats = fs.statfsSync(DATA_DIR);
    const totalBytes = stats.blocks * stats.bsize;
    const availableBytes = stats.bavail * stats.bsize;
    const usedBytes = Math.max(0, totalBytes - availableBytes);

    return sendJson(res, 200, {
      totalBytes,
      usedBytes,
      availableBytes,
      dataPath: DATA_DIR,
      generatedAt: Date.now(),
    }, req) as void;
  } catch (err) {
    return sendRouteError(res, req, new RouteError('INTERNAL_ERROR', {
      status: 500,
      message: `statfs failed: ${err instanceof Error ? err.message : String(err)}`,
    })) as void;
  }
}
