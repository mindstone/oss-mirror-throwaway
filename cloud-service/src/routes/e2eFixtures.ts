import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { extractBearerTokenFromAuthorizationHeader } from '../auth';
import { log, readBody, RouteError, sendJson, sendRouteError } from '../httpUtils';
import type { CloudE2eSeedOps, CloudServiceDeps } from '../bootstrap';
import type { AgentSession } from '@shared/types';
import { cloudEventBroadcaster } from '../cloudEventBroadcaster';
import { assertTestDataRootSafe } from '../testDataRootGuard';
import { isCloudE2eTestModeEnabled } from '../e2eTestMode';
import {
  activateE2eSession,
  DEFAULT_E2E_SESSION_ID,
  DEFAULT_E2E_TITLE,
  finiteNumber,
  FIXED_E2E_TIMESTAMP,
  isPlainRecord,
  nonEmptyString,
  normalizeSeedMessages,
} from '../e2eFixturesShared';

function getHeaderValue(req: http.IncomingMessage, name: string): string | null {
  const raw = req.headers[name.toLowerCase()];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
  return null;
}

function getE2eAuthToken(): string | null {
  return process.env.REBEL_E2E_TOKEN || process.env.REBEL_CLOUD_TOKEN || null;
}

function e2eResponse<T extends Record<string, unknown>>(body: T, runId: string | null): T & { runId: string | null } {
  return { ...body, runId };
}

function e2eRouteError(error: RouteError, runId: string | null): RouteError {
  return new RouteError(error.code, {
    status: error.status,
    message: error.message,
    details: { ...error.details, runId },
    cause: error.cause,
  });
}

export function isE2eTestModeEnabled(): boolean {
  return isCloudE2eTestModeEnabled();
}

export function assertE2eAuthorized(req: http.IncomingMessage): boolean {
  const expectedToken = getE2eAuthToken();
  if (!expectedToken) return false;

  const token = extractBearerTokenFromAuthorizationHeader(req.headers.authorization);
  if (!token) return false;
  if (token.length !== expectedToken.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expectedToken));
}

async function resetSessions(deps: CloudServiceDeps): Promise<number> {
  // Stage 3 factory-reset semantics (classification table): the deletes are
  // 'user-delete' (they tombstone), so the reset MUST then clear the
  // hard-delete ledger — otherwise reseeding DEFAULT_E2E_SESSION_ID after a
  // reset would be silently dropped (poisoned cloud E2E). Fail fast if the
  // seam is not wired: a reset that cannot clear the ledger is misconfigured.
  const clearHardDeleteLedgerForTestReset = deps.clearHardDeleteLedgerForTestReset;
  if (!clearHardDeleteLedgerForTestReset) {
    throw new RouteError('FIXTURE_MISCONFIGURATION', {
      status: 500,
      message: 'clearHardDeleteLedgerForTestReset is not wired for this cloud service',
    });
  }
  const sessions = deps.listSessions();
  let cleared = 0;
  try {
    for (const session of sessions) {
      if (typeof session.id !== 'string' || session.id.length === 0) continue;
      await deps.deleteSession(session.id, { intent: 'user-delete' });
      cloudEventBroadcaster.broadcast('cloud:session-changed', { sessionId: session.id, action: 'deleted' });
      cleared += 1;
    }
  } finally {
    // Covers the partial-failure path too — leftover partial tombstones are
    // precisely the cross-run flake this reset exists to prevent.
    clearHardDeleteLedgerForTestReset();
  }
  return cleared;
}

function getE2eSeedOps(deps: CloudServiceDeps): CloudE2eSeedOps {
  if (deps.e2eSeed) return deps.e2eSeed;
  throw new RouteError('FIXTURE_MISCONFIGURATION', {
    status: 500,
    message: 'E2E seed operations are not configured for this cloud service',
  });
}

async function readObjectBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await readBody(req);
  } catch (error) {
    throw new RouteError('INVALID_BODY', {
      status: 400,
      message: error instanceof Error ? error.message : 'Invalid request body',
    });
  }

  if (!isPlainRecord(body)) {
    throw new RouteError('INVALID_BODY', { status: 400, message: 'Body must be a JSON object' });
  }

  return body;
}

async function seedConversation(req: http.IncomingMessage, deps: CloudServiceDeps): Promise<string> {
  const body = await readObjectBody(req);

  const id = nonEmptyString(body.id) ?? DEFAULT_E2E_SESSION_ID;
  const createdAt = finiteNumber(body.createdAt) ?? FIXED_E2E_TIMESTAMP;
  const updatedAt = finiteNumber(body.updatedAt) ?? createdAt;
  const session: AgentSession = {
    id,
    title: nonEmptyString(body.title) ?? DEFAULT_E2E_TITLE,
    createdAt,
    updatedAt,
    messages: normalizeSeedMessages(body.messages, id),
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    // Canonical lifecycle field; null = Active (default for seeded fixtures).
    doneAt: finiteNumber(body.doneAt) ?? null,
    // Favourite field (independent of lifecycle); null = not starred (default).
    // Lets Star-bug QA seed a pre-favourited conversation to assert the row
    // star icon reflects starredAt (not the lifecycle field).
    starredAt: finiteNumber(body.starredAt) ?? null,
    origin: 'manual',
  };

  await deps.upsertSession(session);
  await activateE2eSession(id);
  return id;
}

export async function handleE2eFixtures(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  segments: string[],
  deps: CloudServiceDeps,
): Promise<void> {
  const runId = getHeaderValue(req, 'x-rebel-e2e-run-id');
  const route = `/${segments.join('/')}`;

  // Defense in depth: fail closed even if a future caller mounts this handler
  // without the server.ts precheck. These endpoints must NEVER mutate state
  // outside an explicitly-enabled test environment.
  if (!isE2eTestModeEnabled()) {
    sendRouteError(res, req, new RouteError('NOT_FOUND', { status: 404, message: 'Not found' }));
    return;
  }
  assertTestDataRootSafe(process.env.REBEL_USER_DATA, { label: 'e2e fixture REBEL_USER_DATA' });

  if (!assertE2eAuthorized(req)) {
    log({ level: 'warn', msg: 'e2e_fixture_unauthorized', route, runId });
    sendRouteError(res, req, new RouteError('UNAUTHORIZED', {
      status: 401,
      message: 'Invalid or missing bearer token',
      details: { runId },
    }));
    return;
  }

  log({ level: 'info', msg: 'e2e_fixture_request', method: req.method, route, runId });

  try {
    const fixturePath = segments.slice(1).join('/');
    if (req.method === 'GET' && fixturePath === 'health') {
      sendJson(res, 200, e2eResponse({ ok: true, testMode: true }, runId), req);
      return;
    }

    if (req.method === 'POST' && fixturePath === 'reset') {
      const cleared = await resetSessions(deps);
      const safety = await getE2eSeedOps(deps).resetSafetyFixtures();
      log({ level: 'info', msg: 'e2e_fixture_reset', cleared, ...safety, runId });
      sendJson(res, 200, e2eResponse({ ok: true, cleared, ...safety }, runId), req);
      return;
    }

    if (req.method === 'POST' && fixturePath === 'seed/conversation') {
      const id = await seedConversation(req, deps);
      log({ level: 'info', msg: 'e2e_fixture_seed_conversation', id, runId });
      sendJson(res, 200, e2eResponse({ ok: true, id }, runId), req);
      return;
    }

    if (req.method === 'POST' && fixturePath === 'seed/tool-approval') {
      const body = await readObjectBody(req);
      const seeded = await getE2eSeedOps(deps).seedToolApproval(body);
      log({ level: 'info', msg: 'e2e_fixture_seed_tool_approval', ...seeded, runId });
      sendJson(res, 200, e2eResponse({ ok: true, ...seeded }, runId), req);
      return;
    }

    if (req.method === 'POST' && fixturePath === 'seed/staged-file-conflict') {
      const body = await readObjectBody(req);
      const seeded = await getE2eSeedOps(deps).seedStagedFileConflict(body);
      log({ level: 'info', msg: 'e2e_fixture_seed_staged_file_conflict', ...seeded, runId });
      sendJson(res, 200, e2eResponse({ ok: true, ...seeded }, runId), req);
      return;
    }

    if (
      fixturePath === 'health'
      || fixturePath === 'reset'
      || fixturePath === 'seed/conversation'
      || fixturePath === 'seed/tool-approval'
      || fixturePath === 'seed/staged-file-conflict'
    ) {
      throw new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: `${req.method} not allowed` });
    }

    throw new RouteError('NOT_FOUND', { status: 404, message: 'Not found' });
  } catch (error) {
    if (error instanceof RouteError) {
      // A RouteError is intentional control flow (validation → HTTP response),
      // not a swallowed failure; surface it to the client directly.
      return sendRouteError(res, req, e2eRouteError(error, runId));
    }
    log({
      level: 'error',
      msg: 'e2e_fixture_error',
      method: req.method,
      route,
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    sendRouteError(res, req, new RouteError('INTERNAL_ERROR', {
      status: 500,
      message: 'An unexpected error occurred',
      details: { runId },
    }));
  }
}
