/**
 * Continuity state route handlers.
 *
 * Desktop pushes the full continuity state map here so cloud/mobile/web
 * can filter sessions to only show cloud_active ones.
 *
 * The route owns HTTP plumbing only; state-machine logic lives in
 * @core/services/cloudContinuityStateService.
 */

import http from 'node:http';
import { readBody, sendJson, log, sendRouteError, RouteError } from '../httpUtils';
import { cloudEventBroadcaster } from '../cloudEventBroadcaster';
import type { CloudServiceDeps } from '../bootstrap';
import {
  processCatchUp,
  processStateMapPut,
  readContinuityStateMap,
  runStateMapGC,
  type CloudContinuityStateEffectSink,
} from '@core/services/cloudContinuityStateService';
export type { ContinuityState, ContinuityStateMap } from '@core/services/continuity/continuityStateTypes';

type SessionSurface = 'desktop' | 'mobile' | 'cloud';

function getHeaderValue(req: http.IncomingMessage, name: string): string | null {
  const raw = req.headers[name];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
  return null;
}

function parseSurfaceHeader(req: http.IncomingMessage): SessionSurface {
  const value = getHeaderValue(req, 'x-rebel-surface')?.trim().toLowerCase();
  if (value === 'desktop' || value === 'mobile' || value === 'cloud') return value;
  return 'cloud';
}

function getDeviceScopeKey(req: http.IncomingMessage): string {
  const bearer = (getHeaderValue(req, 'authorization') ?? '')
    .replace(/^Bearer\s+/i, '')
    .trim() || 'anonymous';
  const surface = parseSurfaceHeader(req);
  const clientId = getHeaderValue(req, 'x-rebel-client-id')?.trim() || 'unknown-client';
  return `${bearer}:${surface}:${clientId}`;
}

function createContinuityEffectSink(): CloudContinuityStateEffectSink {
  return {
    // dynamic-broadcast-reviewed: `event.channel` is statically bounded — CloudContinuityStateEffectSink.emit
    // accepts ONLY Extract<CloudBroadcast, { channel: 'cloud:session-changed' }>, so this forwarder
    // can emit exactly `cloud:session-changed` (exempt/intercepted in cloudEventChannel). No other channel.
    emit: (event) => cloudEventBroadcaster.broadcast(event.channel, event.payload),
  };
}

/**
 * Handle PUT/GET /api/continuity/state and GET /api/continuity/catch-up.
 */
export async function handleContinuity(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  segments: string[],
  deps: Pick<CloudServiceDeps, 'listSessions' | 'deleteSession' | 'getSession'>,
): Promise<void> {
  const sub = segments[2];

  if (sub === 'catch-up') {
    if (req.method !== 'GET') {
      return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: `${req.method} not allowed` }));
    }

    const getSession = deps.getSession;
    if (typeof getSession !== 'function') {
      return sendRouteError(res, undefined, new RouteError('CATCH_UP_UNAVAILABLE', { status: 500, message: 'Catch-up endpoint is unavailable' }));
    }

    const urlObj = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const outcome = await processCatchUp(
      {
        listSessions: deps.listSessions,
        getSession,
      },
      {
        deviceScopeKey: getDeviceScopeKey(req),
        requestedAt: Date.now(),
        limitParam: urlObj.searchParams.get('limit'),
        continuationTokenParam: urlObj.searchParams.get('continuationToken'),
        sinceSeqParam: urlObj.searchParams.get('sinceSeq'),
        sessionIdsParam: urlObj.searchParams.get('sessionIds'),
      },
    );

    if (outcome.kind === 'invalid-request') {
      return sendRouteError(res, undefined, new RouteError('INVALID_PARAM', { status: 400, message: outcome.message }));
    }

    return sendJson(res, 200, outcome.response, req);
  }

  if (sub !== 'state') {
    return sendRouteError(res, undefined, new RouteError('NOT_FOUND', { status: 404, message: `Unknown continuity path: ${sub}` }));
  }

  if (req.method === 'PUT') {
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'Body must be a JSON object (continuity state map)' }));
    }

    const outcome = await processStateMapPut(deps, body as Record<string, unknown>);
    if (outcome.kind === 'invalid-state') {
      return sendRouteError(res, undefined, new RouteError('WRITE_FAILED', { status: 500, message: 'Failed to write continuity state map' }));
    }
    const entries = Object.keys(outcome.merged).length;

    // Respond immediately — GC runs asynchronously so desktop isn't blocked.
    sendJson(res, 200, {
      success: true,
      refusedDemotions: outcome.refusedDemotions,
      preserved: outcome.preserved,
    });

    // Fire-and-forget: garbage-collect local_only sessions from cloud.
    runStateMapGC(outcome.merged, deps, createContinuityEffectSink())
      .then((gcOutcome) => {
        log({
          level: 'info',
          msg: 'Continuity state map processed',
          entries,
          preserved: outcome.preserved,
          refusedDemotions: outcome.refusedDemotions,
          gcDeleted: gcOutcome.gcDeleted,
          gcProtectedNoIntent: gcOutcome.gcProtectedNoIntent,
          gcProtectedRetentionPolicy: gcOutcome.gcProtectedRetentionPolicy,
        });
      })
      .catch((err) => {
        log({
          level: 'error',
          msg: 'State-map GC failed',
          entries,
          preserved: outcome.preserved,
          refusedDemotions: outcome.refusedDemotions,
          error: (err as Error).message,
        });
      });
    return;
  }

  if (req.method === 'GET') {
    const stateMap = await readContinuityStateMap();
    if (!stateMap) {
      return sendJson(res, 200, null);
    }
    return sendJson(res, 200, stateMap);
  }

  return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: `${req.method} not allowed` }));
}
