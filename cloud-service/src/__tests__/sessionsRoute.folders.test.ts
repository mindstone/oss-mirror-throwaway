// RED until Stage 3 (cloud-service `/api/sessions/folders` route + storage).
//
// Bug Mode red→green: `sessionId = segments[2]`, so `/api/sessions/folders`
// parses `folders` AS A SESSION ID today (A3 — route ordering is the only
// collision guard; SAFE_ASSET_ROUTE_ID_REGEX ACCEPTS the literal `folders`).
// There is no folders branch, so:
//   - PUT /api/sessions/folders is dispatched to the positional sessionId PUT
//     branch (processSessionPut → upsertSession with id `folders`).
//   - GET /api/sessions/folders is dispatched to the positional sessionId GET
//     branch (getSession('folders') → 404).
// The assertions below require the folders branch to win FIRST and to
// persist/return the folders document — neither exists yet, so they fail for
// the RIGHT reason.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type http from 'node:http';
import { EventEmitter } from 'node:events';
import type { CloudServiceDeps } from '../bootstrap';
import {
  handleSessions,
  _resetSessionsRouteTombstoneStateForTests,
} from '../routes/sessions';
import { _resetCloudFoldersCacheForTests } from '../services/cloudFolderStorage';
import { resetSessionTombstoneStoreForTests } from '@core/services/continuity/sessionTombstoneStore';
import { setErrorReporter } from '@core/errorReporter';
import type { FolderStoreData } from '@shared/ipc/schemas/folders';

function createMockRes(): {
  res: http.ServerResponse;
  statusCode: () => number;
  body: <T = unknown>() => T;
} {
  let capturedStatus = 200;
  let capturedBody = '';
  const res = {
    writeHead: vi.fn((status: number) => { capturedStatus = status; }),
    end: vi.fn((body?: string) => { capturedBody = body || ''; }),
  } as unknown as http.ServerResponse;
  return {
    res,
    statusCode: () => capturedStatus,
    body: <T = unknown>() => JSON.parse(capturedBody) as T,
  };
}

function createGetReq(url: string): http.IncomingMessage {
  return { method: 'GET', url, headers: { host: 'localhost' } } as http.IncomingMessage;
}

function createPutReq(url: string, body: unknown): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.method = 'PUT';
  req.url = url;
  req.headers = { host: 'localhost' };
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function createPopulatedFolders(): FolderStoreData {
  return {
    version: 1,
    folders: [
      { id: 'fldr_house', name: 'house', createdAt: 1000, updatedAt: 2000 },
      { id: 'fldr_empty', name: 'Empty', createdAt: 1700, updatedAt: 1700 },
    ],
    membership: { s1: 'fldr_house' },
  };
}

beforeEach(async () => {
  await _resetCloudFoldersCacheForTests();
  setErrorReporter({
    captureException: () => {},
    captureMessage: () => {},
    addBreadcrumb: () => {},
  });
});

afterEach(async () => {
  await _resetCloudFoldersCacheForTests();
  resetSessionTombstoneStoreForTests();
  _resetSessionsRouteTombstoneStateForTests();
  setErrorReporter({
    captureException: () => {},
    captureMessage: () => {},
    addBreadcrumb: () => {},
  });
});

describe('sessions route — /api/sessions/folders (RED until Stage 3)', () => {
  it('does NOT dispatch /api/sessions/folders to the positional sessionId branch', async () => {
    // Spies that MUST NOT fire if a dedicated folders branch handles the route.
    const getSession = vi.fn(async () => null);
    const upsertSession = vi.fn(async () => {});
    const deleteSession = vi.fn(async () => {});
    const deps = { getSession, upsertSession, deleteSession } as unknown as CloudServiceDeps;

    const putRes = createMockRes();
    await handleSessions(
      createPutReq('/api/sessions/folders', createPopulatedFolders()),
      putRes.res,
      ['api', 'sessions', 'folders'],
      deps,
    );

    // RED: today the PUT is treated as sessionId="folders" → processSessionPut
    // calls getSession('folders') and upsertSession. A folders branch would
    // bypass both.
    expect(getSession).not.toHaveBeenCalledWith('folders');
    expect(upsertSession).not.toHaveBeenCalled();
  });

  it('PUT persists the folders document and GET returns it', async () => {
    const deps = {
      getSession: vi.fn(async () => null),
      upsertSession: vi.fn(async () => {}),
      deleteSession: vi.fn(async () => {}),
    } as unknown as CloudServiceDeps;
    const folders = createPopulatedFolders();

    const putRes = createMockRes();
    await handleSessions(
      createPutReq('/api/sessions/folders', folders),
      putRes.res,
      ['api', 'sessions', 'folders'],
      deps,
    );
    // RED: a folders PUT should 200 with success; today it routes through the
    // session PUT branch (different response shape) or errors.
    expect(putRes.statusCode()).toBe(200);
    expect(putRes.body()).toMatchObject({ success: true });

    const getRes = createMockRes();
    await handleSessions(
      createGetReq('/api/sessions/folders'),
      getRes.res,
      ['api', 'sessions', 'folders'],
      deps,
    );

    // RED: today GET /api/sessions/folders → getSession('folders') → 404
    // (SESSION_NOT_FOUND), not the persisted folders document.
    expect(getRes.statusCode()).toBe(200);
    const got = getRes.body<FolderStoreData>();
    expect(got.version).toBe(1);
    expect(got.folders.map((f) => f.id)).toEqual(['fldr_house', 'fldr_empty']);
    expect(got.membership).toEqual({ s1: 'fldr_house' });
  });

  it('GET returns an empty default document when none has been stored', async () => {
    const deps = {
      getSession: vi.fn(async () => null),
    } as unknown as CloudServiceDeps;

    const getRes = createMockRes();
    await handleSessions(
      createGetReq('/api/sessions/folders'),
      getRes.res,
      ['api', 'sessions', 'folders'],
      deps,
    );

    // RED: today this is a 404 session-not-found, not an empty folders default.
    expect(getRes.statusCode()).toBe(200);
    expect(getRes.body()).toEqual({ version: 1, folders: [], membership: {} });
  });
});
