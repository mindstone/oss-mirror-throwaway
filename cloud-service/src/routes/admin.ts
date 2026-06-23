/**
 * Admin routes for cloud-service self-management.
 *
 * POST /api/admin/update   -- Signal a container image update
 * POST /api/admin/dns/cleanup -- Delete this instance's DNS record (for deprovision)
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sendJson, readBody, log, sendRouteError, RouteError } from '../httpUtils';
import { deleteDnsRecord } from '@core/services/cloud/cloudflareDns';
import { getCloudHygieneSchedulerHandle } from '../services/cloudHygieneScheduler';
import { createLastKnownGoodImageTagStore } from '../services/lastKnownGoodImageTagStore';

const DATA_DIR = process.env.REBEL_USER_DATA || '/data';
const TAG_PATTERN = /^(prod|dev)-([a-f0-9]+|latest)$/;

export async function handleAdmin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  segments: string[],
): Promise<void> {
  const route = segments.slice(2).join('/');

  if (route === 'update' && req.method === 'POST') {
    return handleUpdate(req, res);
  }

  if (route === 'trigger-update' && req.method === 'POST') {
    return handleTriggerUpdate(req, res);
  }

  if (route === 'hygiene-status' && req.method === 'GET') {
    return handleHygieneStatus(res);
  }

  if (route === 'dns/cleanup' && req.method === 'POST') {
    return handleDnsCleanup(req, res);
  }

  if (route === 'lkg-image' && req.method === 'GET') {
    return handleGetLkgImage(res);
  }

  return sendRouteError(res, undefined, new RouteError('NOT_FOUND', { status: 404, message: `No admin route for ${req.method} ${route}` }));
}

function handleGetLkgImage(res: http.ServerResponse): void {
  // Stage D of docs/plans/260510_cloud_image_rollback_defense_in_depth.md:
  // expose the last-known-good record so the desktop can surface a
  // "Try previous version" affordance when the user reports their cloud is
  // misbehaving in a way the watchdog cannot detect (e.g. schema
  // corruption that boots fine but returns wrong data).
  try {
    const store = createLastKnownGoodImageTagStore({ dataPath: DATA_DIR });
    const record = store.read();
    if (!record) {
      sendJson(res, 200, { record: null });
      return;
    }
    // Strip nothing — the desktop needs imageTag, recordedAt,
    // schemaFingerprint, and the previousLastKnownGood entry to render the
    // "deployed N days ago" copy and the rollback target.
    sendJson(res, 200, { record });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log({ level: 'error', msg: 'Failed to read LKG record', error: message });
    sendRouteError(
      res,
      undefined,
      new RouteError('LKG_READ_FAILED', { status: 500, message }),
    );
  }
}

function handleHygieneStatus(
  res: http.ServerResponse,
): void {
  const handle = getCloudHygieneSchedulerHandle();
  if (!handle) {
    sendJson(res, 503, { error: 'Hygiene scheduler not initialized' });
    return;
  }

  sendJson(res, 200, {
    lastResult: handle.getLastResult() ?? null,
    nextRunAt: handle.getNextRunAt() ?? null,
  });
}

async function handleTriggerUpdate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const { triggerImmediateUpdate } = await import('../selfUpdateScheduler');

  let body: Record<string, unknown> | null = null;
  try {
    body = (await readBody(req)) as Record<string, unknown> | null;
  } catch {
    // no body is fine
  }

  const channel = (body?.channel as 'stable' | 'beta') || undefined;

  try {
    const result = await triggerImmediateUpdate(channel);
    return sendJson(res, 200, result);
  } catch (err) {
    log({ level: 'error', msg: 'trigger-update failed', error: (err as Error).message });
    return sendRouteError(res, undefined, new RouteError('UPDATE_FAILED', { status: 500, message: (err as Error).message }));
  }
}

async function handleUpdate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  let body: Record<string, unknown> | null = null;
  try {
    body = (await readBody(req)) as Record<string, unknown> | null;
  } catch {
    return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'Invalid JSON' }));
  }

  const targetTag = (body?.targetTag as string) || 'prod-latest';

  if (!TAG_PATTERN.test(targetTag)) {
    return sendRouteError(res, undefined, new RouteError('INVALID_TAG', { status: 400, message: `Tag must match pattern: prod-<hash>, dev-<hash>, prod-latest, or dev-latest` }));
  }

  const tagFile = path.join(DATA_DIR, 'rebel-cloud.tag');
  const signalFile = path.join(DATA_DIR, '.update-signal');

  try {
    await fs.writeFile(tagFile, targetTag, 'utf-8');
    await fs.writeFile(signalFile, targetTag, 'utf-8');
  } catch (err) {
    log({ level: 'error', msg: 'Failed to write update signal', error: (err as Error).message });
    return sendRouteError(res, undefined, new RouteError('WRITE_FAILED', { status: 500, message: 'Failed to write update signal' }));
  }

  log({ level: 'info', msg: 'Update signaled', targetTag });
  return sendJson(res, 200, { signaled: true, targetTag });
}

async function handleDnsCleanup(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  const apiToken = process.env.CLOUDFLARE_DNS_TOKEN;

  if (!zoneId || !apiToken) {
    return sendRouteError(res, undefined, new RouteError('DNS_NOT_CONFIGURED', { status: 500, message: 'Cloudflare credentials not available' }));
  }

  const recordIdFile = path.join(DATA_DIR, '.dns-record-id');
  let recordId: string;

  try {
    recordId = (await fs.readFile(recordIdFile, 'utf-8')).trim();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return sendJson(res, 200, { deleted: false, reason: 'no-record-id' });
    }
    log({ level: 'error', msg: 'Failed to read DNS record ID', error: (err as Error).message });
    return sendRouteError(res, undefined, new RouteError('READ_ERROR', { status: 500, message: 'Failed to read DNS record ID file' }));
  }

  if (!recordId) {
    return sendJson(res, 200, { deleted: false, reason: 'empty-record-id' });
  }

  const result = await deleteDnsRecord({ zoneId, apiToken, recordId });

  if (!result.success) {
    log({ level: 'error', msg: 'DNS cleanup failed', recordId, error: result.error });
    return sendRouteError(res, undefined, new RouteError('DNS_DELETE_FAILED', { status: 502, message: result.error ?? 'Unknown Cloudflare error' }));
  }

  try {
    await fs.unlink(recordIdFile);
  } catch {
    // Best-effort cleanup of record ID file
  }

  log({ level: 'info', msg: 'DNS record deleted', recordId });
  return sendJson(res, 200, { deleted: true, recordId });
}
