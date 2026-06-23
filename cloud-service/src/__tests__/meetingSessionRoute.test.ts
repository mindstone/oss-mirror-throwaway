import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { AgentSession } from '@shared/types';
import {
  handleMeetingSessionCreate,
  handleMeetingSessionChunkUpload,
  handleMeetingSessionStatus,
  handleMeetingSessionFinalize,
  handleMeetingSessionCoachActivate,
  handleMeetingSessionCoachDeactivate,
} from '../routes/meetingSession';
import { MeetingSessionIdempotencyCache } from '../services/meetingSessionIdempotencyCache';
import { createMeetingUploadSessionTestHarness, type MeetingUploadSessionTestHarness } from '../__test_helpers__/meetingUploadSessionTestHarness';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
    proc.stderr = new EventEmitter();
    process.nextTick(() => proc.emit('close', 0));
    return proc;
  }),
}));

let harness: MeetingUploadSessionTestHarness;
let server: http.Server;
let baseUrl: string;
let idempotencyCache: MeetingSessionIdempotencyCache;

function dispatch(req: http.IncomingMessage, res: http.ServerResponse): void {
  const route = (req.url || '').split('?')[0];
  const segments = route.split('/').filter(Boolean);
  void (async () => {
    if (segments[0] === 'api' && segments[1] === 'meeting' && segments[2] === 'session') {
      if (segments[3] === 'create' && segments.length === 4) return handleMeetingSessionCreate(req, res, harness.store, idempotencyCache);
      if (segments[3] && segments[4] === 'chunk' && segments.length === 5) return handleMeetingSessionChunkUpload(req, res, segments[3], harness.store);
      if (segments[3] && segments[4] === 'status' && segments.length === 5) return handleMeetingSessionStatus(req, res, segments[3], harness.store);
      if (segments[3] && segments[4] === 'finalize' && segments.length === 5) return handleMeetingSessionFinalize(req, res, segments[3], harness.store);
      if (segments[3] && segments[4] === 'coach' && segments.length === 5) {
        if (req.method === 'POST') return handleMeetingSessionCoachActivate(req, res, segments[3], harness.store);
        if (req.method === 'DELETE') return handleMeetingSessionCoachDeactivate(req, res, segments[3], harness.store);
      }
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
  })().catch((err) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'TEST_ERROR', message: err instanceof Error ? err.message : String(err) } }));
  });
}

async function startServer(): Promise<void> {
  server = http.createServer(dispatch);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function request(method: string, urlPath: string, options: { body?: BodyInit; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: options.headers,
    body: options.body,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as any : null };
}

async function createSession(
  headers: Record<string, string> = {},
  body?: Record<string, unknown>,
  expectedStatus: number = 201,
): Promise<string> {
  const requestBody = body ? JSON.stringify(body) : undefined;
  const mergedHeaders = body
    ? { ...headers, 'content-type': 'application/json' }
    : headers;
  const created = await request('POST', '/api/meeting/session/create', { headers: mergedHeaders, body: requestBody });
  expect(created.status).toBe(expectedStatus);
  return created.body.sessionId;
}

function buildBearer(token: string): string {
  return `Bearer ${token}`;
}

async function createSessionWithIdempotency(args: {
  idempotencyKey: string;
  bearerToken: string;
  companionSessionId?: string | null;
  expectedStatus?: number;
}): Promise<{ status: number; sessionId: string; body: any }> {
  const headers: Record<string, string> = {
    authorization: buildBearer(args.bearerToken),
    'x-idempotency-key': args.idempotencyKey,
  };
  const body = args.companionSessionId === undefined
    ? undefined
    : { companionSessionId: args.companionSessionId };
  const requestBody = body ? JSON.stringify(body) : undefined;
  const mergedHeaders = body
    ? { ...headers, 'content-type': 'application/json' }
    : headers;
  const res = await request('POST', '/api/meeting/session/create', { headers: mergedHeaders, body: requestBody });
  if (args.expectedStatus !== undefined) {
    expect(res.status).toBe(args.expectedStatus);
  }
  return { status: res.status, sessionId: res.body.sessionId, body: res.body };
}

beforeEach(async () => {
  idempotencyCache = new MeetingSessionIdempotencyCache();
  harness = await createMeetingUploadSessionTestHarness();
  await startServer();
});

afterEach(async () => {
  server?.closeAllConnections?.();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  harness.store.stop();
  await fs.rm(harness.rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  vi.clearAllMocks();
});

describe('meeting session routes', () => {
  it('creates a session with 201 and a sessionId', async () => {
    const res = await request('POST', '/api/meeting/session/create');
    expect(res.status).toBe(201);
    expect(res.body.sessionId).toMatch(/.+/);
  });

  it('creates a session without X-Meeting-Title', async () => {
    const sessionId = await createSession();
    expect(harness.store.getSessionForTesting(sessionId)?.meetingTitle).toBeUndefined();
  });

  it('persists companionSessionId at create time', async () => {
    const sessionId = await createSession({}, { companionSessionId: 'companion-create-1' });
    expect(harness.store.getSessionForTesting(sessionId)?.companionSessionId).toBe('companion-create-1');
  });

  it('stores null companionSessionId when create body omits companion id', async () => {
    const sessionId = await createSession();
    expect(harness.store.getSessionForTesting(sessionId)?.companionSessionId).toBeNull();
  });

  it('replays idempotent create calls for same key + same companion id', async () => {
    const first = await createSessionWithIdempotency({
      bearerToken: 'token-a',
      idempotencyKey: 'idem-create-1',
      companionSessionId: 'companion-a',
      expectedStatus: 201,
    });
    const replay = await createSessionWithIdempotency({
      bearerToken: 'token-a',
      idempotencyKey: 'idem-create-1',
      companionSessionId: 'companion-a',
      expectedStatus: 200,
    });
    expect(replay.sessionId).toBe(first.sessionId);
  });

  it('returns 409 for same key + different companion ids', async () => {
    await createSessionWithIdempotency({
      bearerToken: 'token-a',
      idempotencyKey: 'idem-create-conflict',
      companionSessionId: 'companion-a',
      expectedStatus: 201,
    });
    const conflict = await createSessionWithIdempotency({
      bearerToken: 'token-a',
      idempotencyKey: 'idem-create-conflict',
      companionSessionId: 'companion-b',
      expectedStatus: 409,
    });
    expect(conflict.body.error.code).toBe('MEETING_SESSION_IDEMPOTENCY_CONFLICT');
  });

  it('backfills null companion ids in-place for idempotent replay', async () => {
    const first = await createSessionWithIdempotency({
      bearerToken: 'token-a',
      idempotencyKey: 'idem-create-backfill',
      companionSessionId: null,
      expectedStatus: 201,
    });
    const replay = await createSessionWithIdempotency({
      bearerToken: 'token-a',
      idempotencyKey: 'idem-create-backfill',
      companionSessionId: 'companion-b',
      expectedStatus: 200,
    });
    expect(replay.sessionId).toBe(first.sessionId);
    expect(harness.store.getSessionForTesting(first.sessionId)?.companionSessionId).toBe('companion-b');
  });

  it('returns cached session when request omits companion id after one is set', async () => {
    const first = await createSessionWithIdempotency({
      bearerToken: 'token-a',
      idempotencyKey: 'idem-create-missing-companion',
      companionSessionId: 'companion-a',
      expectedStatus: 201,
    });
    const replay = await createSessionWithIdempotency({
      bearerToken: 'token-a',
      idempotencyKey: 'idem-create-missing-companion',
      expectedStatus: 200,
    });
    expect(replay.sessionId).toBe(first.sessionId);
    expect(harness.store.getSessionForTesting(first.sessionId)?.companionSessionId).toBe('companion-a');
  });

  it('serializes concurrent same-key create requests to one session id', async () => {
    const [a, b] = await Promise.all([
      createSessionWithIdempotency({
        bearerToken: 'token-a',
        idempotencyKey: 'idem-create-race',
        companionSessionId: 'companion-race',
      }),
      createSessionWithIdempotency({
        bearerToken: 'token-a',
        idempotencyKey: 'idem-create-race',
        companionSessionId: 'companion-race',
      }),
    ]);
    expect(new Set([a.sessionId, b.sessionId]).size).toBe(1);
    expect([200, 201]).toContain(a.status);
    expect([200, 201]).toContain(b.status);
  });

  it('rejects non-string companionSessionId values on create', async () => {
    const res = await request('POST', '/api/meeting/session/create', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ companionSessionId: 123 }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BODY');
  });
  async function uploadChunk(sessionId: string, chunkIndex = 0, key = `key-${chunkIndex}`, bytes = Buffer.from(`audio-${chunkIndex}`)) {
    return request('POST', `/api/meeting/session/${sessionId}/chunk`, {
    headers: {
      'content-type': 'audio/mp4',
      'x-chunk-index': String(chunkIndex),
      'x-idempotency-key': key,
    },
    body: bytes,
  });
  }

async function finalizeSession(sessionId: string, body: Record<string, unknown> = { totalChunks: 1 }) {
  return request('POST', `/api/meeting/session/${sessionId}/finalize`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function companionSession(id: string, messages: Array<{ role: 'user' | 'assistant' | 'result'; text: string }>): AgentSession {
  return {
    id,
    title: 'Companion',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: messages.map((message, index) => ({
      id: `${id}-m-${index}`,
      turnId: `${id}-t-${index}`,
      createdAt: Date.now() + index,
      ...message,
    })),
    eventsByTurn: {},
  } as AgentSession;
}

  it('decodes X-Meeting-Title', async () => {
    const sessionId = await createSession({ 'x-meeting-title': encodeURIComponent('Weekly planning') });
    expect(harness.store.getSessionForTesting(sessionId)?.meetingTitle).toBe('Weekly planning');
  });

  it('falls back to Date.now for invalid X-Meeting-Start-Time', async () => {
    const before = Date.now();
    const sessionId = await createSession({ 'x-meeting-start-time': 'not-a-number' });
    const after = Date.now();
    const state = harness.store.getSessionForTesting(sessionId)!;
    expect(state.meetingStartTime).toBeGreaterThanOrEqual(before);
    expect(state.meetingStartTime).toBeLessThanOrEqual(after);
  });

  it('returns 405 for create with GET', async () => {
    const res = await request('GET', '/api/meeting/session/create');
    expect(res.status).toBe(405);
    expect(res.body.error.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('uploads a chunk successfully and persists bytes', async () => {
    const sessionId = await createSession();
    const res = await uploadChunk(sessionId, 0, 'a', Buffer.from('hello'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, chunkIndex: 0, totalReceived: 1 });
    await harness.store.flushDirtySessionMetadata();
    await expect(fs.readFile(harness.store.fileStorage.getChunkPath(sessionId, 0), 'utf-8')).resolves.toBe('hello');
    const meta = JSON.parse(await fs.readFile(harness.store.fileStorage.getMetaPath(sessionId), 'utf-8'));
    expect(meta.chunks[0]).toMatchObject({ index: 0, idempotencyKey: 'a', fileName: 'chunk_0.m4a', sizeBytes: 5 });
    expect(harness.calls.transcribeChunkAsync).toHaveBeenCalledWith(sessionId, 0, harness.store.fileStorage.getChunkPath(sessionId, 0));
    expect(harness.calls.ensureCoachingTimerIfActive).toHaveBeenCalledWith(sessionId);
  });

  it('returns 400 when X-Chunk-Index is missing', async () => {
    const sessionId = await createSession();
    const res = await request('POST', `/api/meeting/session/${sessionId}/chunk`, {
      headers: { 'content-type': 'audio/mp4', 'x-idempotency-key': 'a' },
      body: Buffer.from('audio'),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CHUNK_INDEX');
  });

  it('returns 400 when X-Idempotency-Key is missing', async () => {
    const sessionId = await createSession();
    const res = await request('POST', `/api/meeting/session/${sessionId}/chunk`, {
      headers: { 'content-type': 'audio/mp4', 'x-chunk-index': '0' },
      body: Buffer.from('audio'),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_IDEMPOTENCY_KEY');
  });

  it('returns 400 for non-audio content type', async () => {
    const sessionId = await createSession();
    const res = await request('POST', `/api/meeting/session/${sessionId}/chunk`, {
      headers: { 'content-type': 'text/plain', 'x-chunk-index': '0', 'x-idempotency-key': 'a' },
      body: Buffer.from('audio'),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CONTENT_TYPE');
  });

  it('returns 404 for chunk upload to unknown session', async () => {
    const res = await uploadChunk('missing');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('treats same-key chunk re-upload as idempotent', async () => {
    const sessionId = await createSession();
    expect((await uploadChunk(sessionId, 0, 'same')).status).toBe(200);
    const res = await uploadChunk(sessionId, 0, 'same', Buffer.from('different'));
    expect(res.status).toBe(200);
    expect(res.body.totalReceived).toBe(1);
    await expect(fs.readFile(harness.store.fileStorage.getChunkPath(sessionId, 0), 'utf-8')).resolves.toBe('audio-0');
  });

  it('returns 409 for same chunk index with different idempotency key', async () => {
    const sessionId = await createSession();
    expect((await uploadChunk(sessionId, 0, 'first')).status).toBe(200);
    const res = await uploadChunk(sessionId, 0, 'second');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CHUNK_CONFLICT');
  });

  it('returns 409 when uploading a new chunk after finalize starts', async () => {
    const sessionId = await createSession();
    await uploadChunk(sessionId);
    const finalize = await finalizeSession(sessionId);
    expect(finalize.status).toBe(202);
    const res = await uploadChunk(sessionId, 1, 'next');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SESSION_NOT_RECORDING');
    await harness.store.awaitFinalize(sessionId);
  });

  it('returns 413 and cleans tmp file when chunk exceeds 50 MB', async () => {
    const sessionId = await createSession();
    const req = Readable.from([Buffer.alloc(50 * 1024 * 1024 + 1)]) as http.IncomingMessage;
    req.method = 'POST';
    req.headers = { 'content-type': 'audio/mp4', 'x-chunk-index': '0', 'x-idempotency-key': 'large' };
    type MockMeetingRes = {
      writableEnded: boolean;
      status: number;
      body: string;
      writeHead(status: number): MockMeetingRes;
      end(body: string): MockMeetingRes;
    };
    const res: MockMeetingRes = {
      writableEnded: false,
      status: 0,
      body: '',
      writeHead(status) { this.status = status; return this; },
      end(body) { this.body = body; this.writableEnded = true; return this; },
    };
    await handleMeetingSessionChunkUpload(req, res as unknown as http.ServerResponse, sessionId, harness.store);
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).error.code).toBe('CHUNK_TOO_LARGE');
    await expect(fs.access(`${harness.store.fileStorage.getChunkPath(sessionId, 0)}.tmp-upload`)).rejects.toThrow();
  });

  it('returns status for an existing session', async () => {
    const sessionId = await createSession();
    await uploadChunk(sessionId);
    const res = await request('GET', `/api/meeting/session/${sessionId}/status`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sessionId, status: 'recording', chunksReceived: 1 });
  });

  it('returns 404 for status of unknown session', async () => {
    const res = await request('GET', '/api/meeting/session/missing/status');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('returns 405 for status with POST', async () => {
    const sessionId = await createSession();
    const res = await request('POST', `/api/meeting/session/${sessionId}/status`);
    expect(res.status).toBe(405);
    expect(res.body.error.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('finalizes successfully, captures companion Q&A, cleans up, and dispatches push after complete', async () => {
    const companion = companionSession('companion-1', [
      { role: 'user', text: 'What did we decide?' },
      { role: 'assistant', text: 'We decided to ship.' },
    ]);
    harness.sessions.set(companion.id, companion);
    const sessionId = await createSession({ 'x-meeting-title': 'Launch' });
    await uploadChunk(sessionId);
    const res = await finalizeSession(sessionId, { totalChunks: 1, companionSessionId: companion.id });
    expect(res.status).toBe(202);
    await harness.store.awaitFinalize(sessionId);
    expect(harness.store.getSessionForTesting(sessionId)?.status).toBe('complete');
    expect(harness.calls.runAnalysis).toHaveBeenCalledWith(expect.objectContaining({
      botId: sessionId,
      userId: 'mobile-recording',
      meetingTitle: 'Launch',
      participants: [],
      companionSessionId: companion.id,
      companionQAHistory: [{ question: 'What did we decide?', answer: 'We decided to ship.' }],
    }));
    expect(harness.calls.cleanupTranscriptionState.mock.invocationCallOrder[0]).toBeLessThan(harness.calls.getSession.mock.invocationCallOrder.at(-1)!);
    expect(harness.calls.notifyAnalysisComplete).toHaveBeenCalledWith({ sessionId, meetingTitle: 'Launch' });
  });

  it('returns 409 when finalize body tries to change an existing companion session id', async () => {
    const sessionId = await createSession({}, { companionSessionId: 'companion-a' });
    await uploadChunk(sessionId);
    const res = await finalizeSession(sessionId, {
      totalChunks: 1,
      companionSessionId: 'companion-b',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MEETING_SESSION_FINALIZE_COMPANION_MISMATCH');
  });

  it('returns 409 with missing and extra indices for non-contiguous chunks', async () => {
    const sessionId = await createSession();
    await uploadChunk(sessionId, 0, 'a');
    await uploadChunk(sessionId, 2, 'c');
    const res = await finalizeSession(sessionId, { totalChunks: 2 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: { code: 'CHUNK_RANGE_GAP', message: 'Chunk indices are not contiguous from 0 to totalChunks - 1' },
      missingIndices: [1],
      extraIndices: [2],
      expectedTotalChunks: 2,
      receivedChunkCount: 2,
    });
  });

  it('returns 202 with status when finalize is already finalizing', async () => {
    const sessionId = await createSession();
    await uploadChunk(sessionId);
    harness.calls.flushAndMarkTranscriptionComplete.mockImplementationOnce(() => new Promise(() => {}));
    expect((await finalizeSession(sessionId)).status).toBe(202);
    const res = await finalizeSession(sessionId);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true, status: 'processing' });
  });

  it('returns 202 with status when finalize is already complete', async () => {
    const sessionId = await createSession();
    await uploadChunk(sessionId);
    expect((await finalizeSession(sessionId)).status).toBe(202);
    await harness.store.awaitFinalize(sessionId);
    const res = await finalizeSession(sessionId);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true, status: 'complete' });
  });

  it('returns 400 when finalize lacks totalChunks', async () => {
    const sessionId = await createSession();
    const res = await finalizeSession(sessionId, {});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TOTAL_CHUNKS');
  });

  it('swallows companion getSession failure as non-blocking', async () => {
    harness.calls.getSession.mockRejectedValueOnce(new Error('boom'));
    const sessionId = await createSession();
    await uploadChunk(sessionId);
    expect((await finalizeSession(sessionId, { totalChunks: 1, companionSessionId: 'broken' })).status).toBe(202);
    await harness.store.awaitFinalize(sessionId);
    expect(harness.store.getSessionForTesting(sessionId)?.status).toBe('complete');
  });

  it('does not dispatch push when analysis fails', async () => {
    harness.calls.runAnalysis.mockResolvedValueOnce({ success: false, error: 'analysis failed' });
    const sessionId = await createSession();
    await uploadChunk(sessionId);
    expect((await finalizeSession(sessionId)).status).toBe(202);
    await harness.store.awaitFinalize(sessionId);
    expect(harness.store.getSessionForTesting(sessionId)).toMatchObject({ status: 'failed', error: 'analysis failed' });
    expect(harness.calls.notifyAnalysisComplete).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed finalize body', async () => {
    const sessionId = await createSession();
    const res = await request('POST', `/api/meeting/session/${sessionId}/finalize`, { body: '{nope' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BODY');
  });

  it('activates coaching for a recording session', async () => {
    const sessionId = await createSession();
    const res = await request('POST', `/api/meeting/session/${sessionId}/coach`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ skillId: 'listen', skillName: 'Listening' }),
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: true, skillId: 'listen', skillName: 'Listening', sessionId });
    expect(harness.calls.activateCoaching).toHaveBeenCalledWith(sessionId, 'listen', 'Listening');
  });

  it('returns 400 when activating coaching without skillId', async () => {
    const sessionId = await createSession();
    const res = await request('POST', `/api/meeting/session/${sessionId}/coach`, { body: JSON.stringify({}) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_SKILL_ID');
  });

  it('returns 409 when activating coaching after finalize', async () => {
    const sessionId = await createSession();
    await uploadChunk(sessionId);
    expect((await finalizeSession(sessionId)).status).toBe(202);
    const res = await request('POST', `/api/meeting/session/${sessionId}/coach`, { body: JSON.stringify({ skillId: 'x' }) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SESSION_NOT_RECORDING');
    await harness.store.awaitFinalize(sessionId);
  });

  it('deactivates coaching for an existing session', async () => {
    const sessionId = await createSession();
    const res = await request('DELETE', `/api/meeting/session/${sessionId}/coach`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false, sessionId });
    expect(harness.calls.deactivateCoaching).toHaveBeenCalledWith(sessionId);
  });

  it('returns 404 when deactivating coaching for an unknown session', async () => {
    const res = await request('DELETE', '/api/meeting/session/missing/coach');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('recovers finalizing and processing sessions to failed on restart and marks all loaded sessions dirty', async () => {
    const rootDir = harness.rootDir;
    const states = [
      { sessionId: 'recording', status: 'recording' },
      { sessionId: 'finalizing', status: 'finalizing' },
      { sessionId: 'processing', status: 'processing' },
      { sessionId: 'complete', status: 'complete' },
      { sessionId: 'failed', status: 'failed' },
    ];
    for (const state of states) {
      const dir = path.join(rootDir, state.sessionId);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({
        sessionId: state.sessionId,
        status: state.status,
        meetingStartTime: 123,
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        chunks: [],
      }, null, 2));
    }
    harness.store.stop();
    const fresh = await createMeetingUploadSessionTestHarness({ rootDir });
    expect(fresh.store.getSessionForTesting('finalizing')).toMatchObject({
      status: 'failed',
      error: 'Finalization interrupted by server restart',
    });
    expect(fresh.store.getSessionForTesting('processing')).toMatchObject({
      status: 'failed',
      error: 'Finalization interrupted by server restart',
    });
    expect(fresh.store.getDirtySessionIdsForTesting().sort()).toEqual([]);
    for (const state of states) {
      const persisted = JSON.parse(await fs.readFile(path.join(rootDir, state.sessionId, 'meta.json'), 'utf-8'));
      expect(persisted.updatedAt).toBeDefined();
    }
    fresh.store.stop();
  });

  it('keeps current concurrent chunk conflict behavior: one upload wins and the other is rejected', async () => {
    const sessionId = await createSession();
    const [a, b] = await Promise.all([
      uploadChunk(sessionId, 0, 'race-a', Buffer.from('a')),
      uploadChunk(sessionId, 0, 'race-b', Buffer.from('b')),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it('pins companion Q&A duplicate pairing for consecutive user messages', async () => {
    const companion = companionSession('companion-dup', [
      { role: 'user', text: 'Question one?' },
      { role: 'user', text: 'Question two?' },
      { role: 'assistant', text: 'Shared answer.' },
    ]);
    harness.sessions.set(companion.id, companion);
    const sessionId = await createSession();
    await uploadChunk(sessionId);
    expect((await finalizeSession(sessionId, { totalChunks: 1, companionSessionId: companion.id })).status).toBe(202);
    await harness.store.awaitFinalize(sessionId);
    expect(harness.calls.runAnalysis).toHaveBeenCalledWith(expect.objectContaining({
      companionQAHistory: [
        { question: 'Question one?', answer: 'Shared answer.' },
        { question: 'Question two?', answer: 'Shared answer.' },
      ],
    }));
  });
});
