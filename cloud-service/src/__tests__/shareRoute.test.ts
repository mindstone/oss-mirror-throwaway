/**
 * Tests for share route handlers.
 *
 * Tests POST/GET/DELETE /api/sessions/:id/share (authenticated)
 * and GET /api/shared/:shareId (unauthenticated).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import type http from 'node:http';
import type { CloudServiceDeps } from '../bootstrap';
import { resetRateLimitersForTests } from '@core/services/shareLinksService';

// Set env before imports
const TEST_DATA_DIR = '/tmp/test-share-route';
process.env.REBEL_USER_DATA = TEST_DATA_DIR;

// Clean up before and after each test
beforeEach(async () => {
  try { await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }); } catch { /* ok */ }
  await fs.mkdir(TEST_DATA_DIR, { recursive: true });
  resetRateLimitersForTests();
});

afterEach(async () => {
  try { await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }); } catch { /* ok */ }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockReq(method: string, body?: unknown): http.IncomingMessage {
  const bodyBuf = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  let endFired = false;
  const req: Record<string, unknown> = {
    method,
    headers: {
      authorization: 'Bearer test-token',
      ...(bodyBuf ? { 'content-length': String(bodyBuf.length) } : {}),
    },
    socket: { remoteAddress: '127.0.0.1' },
    on(event: string, cb: (...args: unknown[]) => void) {
      (handlers[event] ??= []).push(cb);
      // Fire stream events once 'end' handler is attached (i.e. readBody is listening)
      if (event === 'end' && !endFired) {
        endFired = true;
        process.nextTick(() => {
          if (bodyBuf) handlers.data?.forEach(fn => fn(bodyBuf));
          handlers.end?.forEach(fn => fn());
        });
      }
      return req;
    },
    destroy() {},
  };
  return req as unknown as http.IncomingMessage;
}

function mockRes(): { res: http.ServerResponse; body: () => unknown; statusCode: () => number } {
  let _statusCode = 200;
  let _data = '';
  const res = {
    writeHead: vi.fn((code: number) => { _statusCode = code; }),
    end: vi.fn((data?: string) => { _data = data || ''; }),
    setHeader: vi.fn(),
  } as unknown as http.ServerResponse;
  return {
    res,
    body: () => { try { return JSON.parse(_data); } catch { return _data; } },
    statusCode: () => _statusCode,
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-session-1',
    title: 'Test Conversation',
    createdAt: 1000,
    updatedAt: 2000,
    deletedAt: undefined,
    privateMode: false,
    messages: [
      { id: 'msg-1', turnId: 'turn-1', role: 'user', text: 'Hello', createdAt: 1100, isHidden: false },
      { id: 'msg-2', turnId: 'turn-2', role: 'assistant', text: 'Hi there', createdAt: 1200, isHidden: false },
    ],
    ...overrides,
  };
}

function makeDeps(sessions: Record<string, unknown> = {}): CloudServiceDeps {
  return {
    getSession: vi.fn(async (id: string) => sessions[id] || null),
  } as unknown as CloudServiceDeps;
}

/** Helper: create a share link via POST and return the shareId. */
async function createShareLink(sessionId: string, deps: CloudServiceDeps): Promise<string> {
  const { handleSessionShare } = await import('../routes/share');
  const { res, body } = mockRes();
  await handleSessionShare(mockReq('POST'), res, sessionId, deps);
  return (body() as { shareId: string }).shareId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('share routes', () => {
  describe('handleSessionShare', () => {
    describe('POST (create)', () => {
      it('creates a new share link and returns shareId', async () => {
        const { handleSessionShare } = await import('../routes/share');
        const session = makeSession();
        const deps = makeDeps({ 'test-session-1': session });
        const { res, body, statusCode } = mockRes();

        await handleSessionShare(mockReq('POST'), res, 'test-session-1', deps);

        expect(statusCode()).toBe(200);
        const data = body() as { shareId: string };
        expect(data.shareId).toBeDefined();
        expect(typeof data.shareId).toBe('string');
        expect(data.shareId.length).toBeGreaterThan(0);
      });

      it('returns existing share link if already shared (idempotent)', async () => {
        const { handleSessionShare } = await import('../routes/share');
        const session = makeSession();
        const deps = makeDeps({ 'test-session-1': session });

        // First call
        const { res: res1, body: body1 } = mockRes();
        await handleSessionShare(mockReq('POST'), res1, 'test-session-1', deps);
        const shareId1 = (body1() as { shareId: string }).shareId;

        // Second call — should return same shareId
        const { res: res2, body: body2 } = mockRes();
        await handleSessionShare(mockReq('POST'), res2, 'test-session-1', deps);
        const shareId2 = (body2() as { shareId: string }).shareId;

        expect(shareId1).toBe(shareId2);
      });

      it('rejects if session not found', async () => {
        const { handleSessionShare } = await import('../routes/share');
        const deps = makeDeps({});
        const { res, body, statusCode } = mockRes();

        await handleSessionShare(mockReq('POST'), res, 'nonexistent', deps);

        expect(statusCode()).toBe(404);
        const data = body() as { error: { code: string } };
        expect(data.error.code).toBe('SESSION_NOT_FOUND');
      });

      it('rejects if session is deleted (deletedAt set)', async () => {
        const { handleSessionShare } = await import('../routes/share');
        const session = makeSession({ deletedAt: Date.now() });
        const deps = makeDeps({ 'test-session-1': session });
        const { res, body, statusCode } = mockRes();

        await handleSessionShare(mockReq('POST'), res, 'test-session-1', deps);

        expect(statusCode()).toBe(400);
        const data = body() as { error: { code: string } };
        expect(data.error.code).toBe('SESSION_DELETED');
      });

      it('rejects if session is private (privateMode)', async () => {
        const { handleSessionShare } = await import('../routes/share');
        const session = makeSession({ privateMode: true });
        const deps = makeDeps({ 'test-session-1': session });
        const { res, body, statusCode } = mockRes();

        await handleSessionShare(mockReq('POST'), res, 'test-session-1', deps);

        expect(statusCode()).toBe(400);
        const data = body() as { error: { code: string } };
        expect(data.error.code).toBe('PRIVATE_SESSION');
      });
    });

    describe('GET (status)', () => {
      it('returns shareId when share exists', async () => {
        const { handleSessionShare } = await import('../routes/share');
        const session = makeSession();
        const deps = makeDeps({ 'test-session-1': session });

        // Create a share first
        const expectedShareId = await createShareLink('test-session-1', deps);

        // GET status
        const { res, body, statusCode } = mockRes();
        await handleSessionShare(mockReq('GET'), res, 'test-session-1', deps);

        expect(statusCode()).toBe(200);
        const data = body() as { shareId: string };
        expect(data.shareId).toBe(expectedShareId);
      });

      it('returns 404 when no share exists', async () => {
        const { handleSessionShare } = await import('../routes/share');
        const deps = makeDeps({});
        const { res, body, statusCode } = mockRes();

        await handleSessionShare(mockReq('GET'), res, 'no-share-session', deps);

        expect(statusCode()).toBe(404);
        const data = body() as { error: { code: string } };
        expect(data.error.code).toBe('NO_SHARE');
      });
    });

    describe('DELETE (revoke)', () => {
      it('revokes an existing share link', async () => {
        const { handleSessionShare } = await import('../routes/share');
        const session = makeSession();
        const deps = makeDeps({ 'test-session-1': session });

        // Create a share first
        await createShareLink('test-session-1', deps);

        // DELETE
        const { res, body, statusCode } = mockRes();
        await handleSessionShare(mockReq('DELETE'), res, 'test-session-1', deps);

        expect(statusCode()).toBe(200);
        const data = body() as { success: boolean };
        expect(data.success).toBe(true);

        // Verify it's gone — GET should return 404
        const { res: getRes, statusCode: getSc } = mockRes();
        await handleSessionShare(mockReq('GET'), getRes, 'test-session-1', deps);
        expect(getSc()).toBe(404);
      });

      it('succeeds even if no share exists (idempotent)', async () => {
        const { handleSessionShare } = await import('../routes/share');
        const deps = makeDeps({});
        const { res, body, statusCode } = mockRes();

        await handleSessionShare(mockReq('DELETE'), res, 'no-share-session', deps);

        expect(statusCode()).toBe(200);
        const data = body() as { success: boolean };
        expect(data.success).toBe(true);
      });
    });
  });

  describe('handleSharedConversation', () => {
    it('returns sanitized session for valid shareId', async () => {
      const { handleSharedConversation } = await import('../routes/share');
      const session = makeSession();
      const deps = makeDeps({ 'test-session-1': session });
      const shareId = await createShareLink('test-session-1', deps);

      const { res, body, statusCode } = mockRes();
      await handleSharedConversation(mockReq('GET'), res, shareId, deps);

      expect(statusCode()).toBe(200);
      const data = body() as { title: string; createdAt: number; updatedAt: number; messages: unknown[] };
      expect(data.title).toBe('Test Conversation');
      expect(data.createdAt).toBe(1000);
      expect(data.updatedAt).toBe(2000);
      expect(data.messages).toHaveLength(2);
    });

    it('returns 404 for unknown shareId', async () => {
      const { handleSharedConversation } = await import('../routes/share');
      const deps = makeDeps({});
      const { res, body, statusCode } = mockRes();

      await handleSharedConversation(mockReq('GET'), res, 'nonexistent_share_id', deps);

      expect(statusCode()).toBe(404);
      const data = body() as { error: { code: string; message: string } };
      expect(data.error.code).toBe('CONVERSATION_UNAVAILABLE');
    });

    it('returns 404 if session was deleted after sharing', async () => {
      const { handleSharedConversation } = await import('../routes/share');
      const validSession = makeSession();
      const createDeps = makeDeps({ 'test-session-1': validSession });
      const shareId = await createShareLink('test-session-1', createDeps);

      // Session is now deleted
      const deletedSession = makeSession({ deletedAt: Date.now() });
      const readDeps = makeDeps({ 'test-session-1': deletedSession });

      const { res, body, statusCode } = mockRes();
      await handleSharedConversation(mockReq('GET'), res, shareId, readDeps);

      expect(statusCode()).toBe(404);
      const data = body() as { error: { code: string } };
      expect(data.error.code).toBe('CONVERSATION_UNAVAILABLE');
    });

    it('returns 404 if session became private after sharing', async () => {
      const { handleSharedConversation } = await import('../routes/share');
      const validSession = makeSession();
      const createDeps = makeDeps({ 'test-session-1': validSession });
      const shareId = await createShareLink('test-session-1', createDeps);

      // Session is now private
      const privateSession = makeSession({ privateMode: true });
      const readDeps = makeDeps({ 'test-session-1': privateSession });

      const { res, body, statusCode } = mockRes();
      await handleSharedConversation(mockReq('GET'), res, shareId, readDeps);

      expect(statusCode()).toBe(404);
      const data = body() as { error: { code: string } };
      expect(data.error.code).toBe('CONVERSATION_UNAVAILABLE');
    });

    it('filters hidden messages from response', async () => {
      const { handleSharedConversation } = await import('../routes/share');
      const session = makeSession({
        messages: [
          { id: 'msg-1', turnId: 'turn-1', role: 'user', text: 'Hello', createdAt: 1100, isHidden: false },
          { id: 'msg-2', turnId: 'turn-2', role: 'assistant', text: 'Secret', createdAt: 1200, isHidden: true },
          { id: 'msg-3', turnId: 'turn-3', role: 'assistant', text: 'Visible', createdAt: 1300, isHidden: false },
        ],
      });
      const deps = makeDeps({ 'test-session-1': session });
      const shareId = await createShareLink('test-session-1', deps);

      const { res, body, statusCode } = mockRes();
      await handleSharedConversation(mockReq('GET'), res, shareId, deps);

      expect(statusCode()).toBe(200);
      const data = body() as { messages: Array<{ id: string; text: string }> };
      expect(data.messages).toHaveLength(2);
      expect(data.messages.map((m) => m.id)).toEqual(['msg-1', 'msg-3']);
      expect(data.messages.find((m) => m.text === 'Secret')).toBeUndefined();
    });

    it('strips turnId and sensitive fields from messages', async () => {
      const { handleSharedConversation } = await import('../routes/share');
      const session = makeSession({
        messages: [
          {
            id: 'msg-1',
            turnId: 'turn-1',
            role: 'user',
            text: 'Hello',
            createdAt: 1100,
            isHidden: false,
            attachments: [{ name: 'file.txt' }],
            attachmentTexts: ['file content'],
          },
        ],
      });
      const deps = makeDeps({ 'test-session-1': session });
      const shareId = await createShareLink('test-session-1', deps);

      const { res, body, statusCode } = mockRes();
      await handleSharedConversation(mockReq('GET'), res, shareId, deps);

      expect(statusCode()).toBe(200);
      const data = body() as { messages: Array<Record<string, unknown>> };
      const msg = data.messages[0];
      // Safe fields present
      expect(msg.id).toBe('msg-1');
      expect(msg.role).toBe('user');
      expect(msg.text).toBe('Hello');
      expect(msg.createdAt).toBe(1100);
      // Sensitive fields stripped
      expect(msg.turnId).toBeUndefined();
      expect(msg.attachments).toBeUndefined();
      expect(msg.attachmentTexts).toBeUndefined();
      expect(msg.isHidden).toBeUndefined();
    });

    it('only includes safe fields (title, createdAt, updatedAt, messages)', async () => {
      const { handleSharedConversation } = await import('../routes/share');
      const session = makeSession({
        activeTurnId: 'turn-1',
        isBusy: true,
        lastError: 'some error',
        eventsByTurn: { 'turn-1': [] },
        settings: { apiKey: 'fake-secret' },
      });
      const deps = makeDeps({ 'test-session-1': session });
      const shareId = await createShareLink('test-session-1', deps);

      const { res, body, statusCode } = mockRes();
      await handleSharedConversation(mockReq('GET'), res, shareId, deps);

      expect(statusCode()).toBe(200);
      const data = body() as Record<string, unknown>;
      // Only safe fields present
      expect(Object.keys(data).sort()).toEqual(['createdAt', 'messages', 'title', 'updatedAt']);
      // Unsafe fields NOT present
      expect(data.id).toBeUndefined();
      expect(data.activeTurnId).toBeUndefined();
      expect(data.isBusy).toBeUndefined();
      expect(data.lastError).toBeUndefined();
      expect(data.eventsByTurn).toBeUndefined();
      expect(data.settings).toBeUndefined();
    });

    it('always re-validates session on every request (no stale cache)', async () => {
      const { handleSharedConversation } = await import('../routes/share');
      const session = makeSession();
      const getSessionSpy = vi.fn(async (id: string) => id === 'test-session-1' ? session : null);
      const deps = { getSession: getSessionSpy } as unknown as CloudServiceDeps;
      const shareId = await createShareLink('test-session-1', deps);

      const callsAfterCreate = getSessionSpy.mock.calls.length;

      // First call
      const { res: res1, statusCode: sc1 } = mockRes();
      await handleSharedConversation(mockReq('GET'), res1, shareId, deps);
      expect(sc1()).toBe(200);
      expect(getSessionSpy.mock.calls.length).toBe(callsAfterCreate + 1);

      // Second call — should call getSession again (no cache)
      const { res: res2, statusCode: sc2 } = mockRes();
      await handleSharedConversation(mockReq('GET'), res2, shareId, deps);
      expect(sc2()).toBe(200);
      expect(getSessionSpy.mock.calls.length).toBe(callsAfterCreate + 2);
    });

    it('rejects non-GET methods', async () => {
      const { handleSharedConversation } = await import('../routes/share');
      const deps = makeDeps({});

      for (const method of ['POST', 'DELETE', 'PUT', 'PATCH']) {
        const { res, body, statusCode } = mockRes();
        await handleSharedConversation(mockReq(method), res, 'any-share-id', deps);

        expect(statusCode()).toBe(405);
        const data = body() as { error: { code: string } };
        expect(data.error.code).toBe('METHOD_NOT_ALLOWED');
      }
    });

    it('rejects invalid shareId format', async () => {
      const { handleSharedConversation } = await import('../routes/share');
      const deps = makeDeps({});
      const { res, statusCode, body } = mockRes();
      await handleSharedConversation(mockReq('GET'), res, '../etc/passwd', deps);
      expect(statusCode()).toBe(404);
      expect((body() as { error: { code: string } }).error.code).toBe('CONVERSATION_UNAVAILABLE');
    });

    it('returns PASSWORD_REQUIRED for password-protected shares', async () => {
      const { handleSessionShare, handleSharedConversation } = await import('../routes/share');
      const session = makeSession();
      const deps = makeDeps({ 'pw-session': session });

      // Create share with password
      const { res: r1, body: b1 } = mockRes();
      await handleSessionShare(mockReq('POST', { password: 'secret123' }), r1, 'pw-session', deps);
      const shareId = (b1() as { shareId: string }).shareId;

      // Public read should return 401 PASSWORD_REQUIRED
      const { res: r2, statusCode: sc2, body: b2 } = mockRes();
      await handleSharedConversation(mockReq('GET'), r2, shareId, deps);
      expect(sc2()).toBe(401);
      expect((b2() as { error: { code: string } }).error.code).toBe('PASSWORD_REQUIRED');
    });
  });

  describe('handleSharedConversationUnlock', () => {
    it('returns session data with correct password', async () => {
      const { handleSessionShare, handleSharedConversationUnlock } = await import('../routes/share');
      const session = makeSession({ title: 'Secret Chat' });
      const deps = makeDeps({ 'pw-session': session });

      const { res: r1, body: b1 } = mockRes();
      await handleSessionShare(mockReq('POST', { password: 'correct' }), r1, 'pw-session', deps);
      const shareId = (b1() as { shareId: string }).shareId;

      const { res: r2, statusCode: sc2, body: b2 } = mockRes();
      await handleSharedConversationUnlock(mockReq('POST', { password: 'correct' }), r2, shareId, deps);
      expect(sc2()).toBe(200);
      expect((b2() as { title: string }).title).toBe('Secret Chat');
    });

    it('returns 401 for wrong password', async () => {
      const { handleSessionShare, handleSharedConversationUnlock } = await import('../routes/share');
      const session = makeSession();
      const deps = makeDeps({ 'pw-session': session });

      const { res: r1, body: b1 } = mockRes();
      await handleSessionShare(mockReq('POST', { password: 'correct' }), r1, 'pw-session', deps);
      const shareId = (b1() as { shareId: string }).shareId;

      const { res: r2, statusCode: sc2, body: b2 } = mockRes();
      await handleSharedConversationUnlock(mockReq('POST', { password: 'wrong' }), r2, shareId, deps);
      expect(sc2()).toBe(401);
      expect((b2() as { error: { code: string } }).error.code).toBe('INVALID_PASSWORD');
    });

    it('rejects invalid shareId format', async () => {
      const { handleSharedConversationUnlock } = await import('../routes/share');
      const deps = makeDeps({});
      const { res, statusCode } = mockRes();
      await handleSharedConversationUnlock(mockReq('POST', { password: 'x' }), res, 'bad!id', deps);
      expect(statusCode()).toBe(404);
    });
  });

  describe('handleSessionShare PUT (update)', () => {
    it('updates expiry on existing share', async () => {
      const { handleSessionShare } = await import('../routes/share');
      const session = makeSession();
      const deps = makeDeps({ 'up-session': session });

      // Create share
      const { res: r1 } = mockRes();
      await handleSessionShare(mockReq('POST'), r1, 'up-session', deps);

      // Update expiry
      const { res: r2, statusCode: sc2, body: b2 } = mockRes();
      await handleSessionShare(mockReq('PUT', { expiresIn: '24h' }), r2, 'up-session', deps);
      expect(sc2()).toBe(200);
      const data = b2() as { expiresAt?: number; hasPassword: boolean };
      expect(data.expiresAt).toBeDefined();
      expect(typeof data.expiresAt).toBe('number');
      expect(data.hasPassword).toBe(false);
    });

    it('adds password to existing share', async () => {
      const { handleSessionShare } = await import('../routes/share');
      const session = makeSession();
      const deps = makeDeps({ 'pw-up-session': session });

      const { res: r1 } = mockRes();
      await handleSessionShare(mockReq('POST'), r1, 'pw-up-session', deps);

      const { res: r2, statusCode: sc2, body: b2 } = mockRes();
      await handleSessionShare(mockReq('PUT', { password: 'newpass' }), r2, 'pw-up-session', deps);
      expect(sc2()).toBe(200);
      expect((b2() as { hasPassword: boolean }).hasPassword).toBe(true);
    });

    it('removes password by passing null', async () => {
      const { handleSessionShare } = await import('../routes/share');
      const session = makeSession();
      const deps = makeDeps({ 'rm-pw-session': session });

      const { res: r1 } = mockRes();
      await handleSessionShare(mockReq('POST', { password: 'initial' }), r1, 'rm-pw-session', deps);

      const { res: r2, statusCode: sc2, body: b2 } = mockRes();
      await handleSessionShare(mockReq('PUT', { password: null }), r2, 'rm-pw-session', deps);
      expect(sc2()).toBe(200);
      expect((b2() as { hasPassword: boolean }).hasPassword).toBe(false);
    });

    it('returns 404 if no share exists', async () => {
      const { handleSessionShare } = await import('../routes/share');
      const deps = makeDeps({});
      const { res, statusCode } = mockRes();
      await handleSessionShare(mockReq('PUT', { expiresIn: '7d' }), res, 'no-share', deps);
      expect(statusCode()).toBe(404);
    });
  });

  describe('handleSharesList', () => {
    it('returns all non-expired shares', async () => {
      const { handleSessionShare, handleSharesList } = await import('../routes/share');
      const session = makeSession({ title: 'Listed Chat' });
      const deps = makeDeps({ 'list-session': session });

      // Create a share
      const { res: r1 } = mockRes();
      await handleSessionShare(mockReq('POST'), r1, 'list-session', deps);

      // List shares
      const { res: r2, statusCode: sc2, body: b2 } = mockRes();
      await handleSharesList(mockReq('GET'), r2);
      expect(sc2()).toBe(200);
      const data = b2() as { shares: Array<{ sessionId: string; title?: string }> };
      expect(data.shares.length).toBe(1);
      expect(data.shares[0].sessionId).toBe('list-session');
      expect(data.shares[0].title).toBe('Listed Chat');
    });

    it('returns empty array when no shares exist', async () => {
      const { handleSharesList } = await import('../routes/share');
      const { res, statusCode, body } = mockRes();
      await handleSharesList(mockReq('GET'), res);
      expect(statusCode()).toBe(200);
      expect((body() as { shares: unknown[] }).shares).toEqual([]);
    });
  });

  describe('expiry', () => {
    it('creates share with expiry and includes expiresAt in response', async () => {
      const { handleSessionShare } = await import('../routes/share');
      const session = makeSession();
      const deps = makeDeps({ 'exp-session': session });

      const { res, statusCode, body } = mockRes();
      await handleSessionShare(mockReq('POST', { expiresIn: '7d' }), res, 'exp-session', deps);
      expect(statusCode()).toBe(200);
      const data = body() as { shareId: string; expiresAt: number; hasPassword: boolean };
      expect(data.expiresAt).toBeDefined();
      expect(data.expiresAt).toBeGreaterThan(Date.now());
      expect(data.hasPassword).toBe(false);
    });

    it('GET status includes expiresAt and hasPassword', async () => {
      const { handleSessionShare } = await import('../routes/share');
      const session = makeSession();
      const deps = makeDeps({ 'exp-get': session });

      const { res: r1 } = mockRes();
      await handleSessionShare(mockReq('POST', { expiresIn: '24h' }), r1, 'exp-get', deps);

      const { res: r2, statusCode: sc2, body: b2 } = mockRes();
      await handleSessionShare(mockReq('GET'), r2, 'exp-get', deps);
      expect(sc2()).toBe(200);
      const data = b2() as { shareId: string; expiresAt: number; hasPassword: boolean };
      expect(data.expiresAt).toBeDefined();
      expect(data.hasPassword).toBe(false);
    });

    it('rejects invalid expiresIn option', async () => {
      const { handleSessionShare } = await import('../routes/share');
      const session = makeSession();
      const deps = makeDeps({ 'bad-exp': session });

      const { res, statusCode, body } = mockRes();
      await handleSessionShare(mockReq('POST', { expiresIn: '1y' }), res, 'bad-exp', deps);
      expect(statusCode()).toBe(400);
      expect((body() as { error: { code: string } }).error.code).toBe('INVALID_EXPIRY');
    });
  });

  describe('backward compatibility', () => {
    it('POST without body still creates a share (no expiry, no password)', async () => {
      const { handleSessionShare } = await import('../routes/share');
      const session = makeSession();
      const deps = makeDeps({ 'compat-session': session });

      const { res, statusCode, body } = mockRes();
      await handleSessionShare(mockReq('POST'), res, 'compat-session', deps);
      expect(statusCode()).toBe(200);
      const data = body() as { shareId: string; expiresAt?: number; hasPassword: boolean };
      expect(data.shareId).toBeDefined();
      expect(data.expiresAt).toBeUndefined();
      expect(data.hasPassword).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// File share routes
// ---------------------------------------------------------------------------

const TEST_WORKSPACE_DIR = path.join(TEST_DATA_DIR, 'workspace');

describe('file share routes', () => {
  // On macOS, /tmp is a symlink to /private/tmp. The production code uses
  // fs.realpath() for symlink protection, so we must pass the real path
  // to deps.getSettings().coreDirectory to avoid a mismatch.
  let realWorkspaceDir: string;

  // Create workspace with test files before each test
  beforeEach(async () => {
    await fs.mkdir(TEST_WORKSPACE_DIR, { recursive: true });
    realWorkspaceDir = await fs.realpath(TEST_WORKSPACE_DIR);
    await fs.mkdir(path.join(realWorkspaceDir, 'subdir'), { recursive: true });
    await fs.writeFile(
      path.join(realWorkspaceDir, 'test-doc.md'),
      '# Hello World\n\nThis is a test document.',
    );
    await fs.writeFile(
      path.join(realWorkspaceDir, 'test-image.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    await fs.writeFile(
      path.join(realWorkspaceDir, 'subdir', 'nested.txt'),
      'Nested file content',
    );
  });

  afterEach(() => {
    delete process.env.REBEL_SHARE_DOWNLOAD_SECRET;
  });

  // -- Helpers ---------------------------------------------------------------

  function mockReqWithUrl(method: string, url: string, body?: unknown): http.IncomingMessage {
    const req = mockReq(method, body) as unknown as Record<string, unknown>;
    req.url = url;
    return req as unknown as http.IncomingMessage;
  }

  function makeFileDeps(sessions: Record<string, unknown> = {}): CloudServiceDeps {
    return {
      getSession: vi.fn(async (id: string) => sessions[id] || null),
      getSettings: vi.fn(() => ({ coreDirectory: realWorkspaceDir })),
    } as unknown as CloudServiceDeps;
  }

  async function createFileShareLink(
    filePath: string,
    deps: CloudServiceDeps,
    opts?: Record<string, unknown>,
  ): Promise<string> {
    const { handleFileShare } = await import('../routes/share');
    const { res, body } = mockRes();
    await handleFileShare(
      mockReqWithUrl('POST', '/api/file-shares', { filePath, ...opts }),
      res,
      deps,
    );
    return (body() as { shareId: string }).shareId;
  }

  function mockStreamRes(): {
    res: http.ServerResponse;
    statusCode: () => number;
    headers: () => Record<string, string>;
    data: () => Buffer;
    waitForEnd: () => Promise<void>;
  } {
    let _statusCode = 200;
    const _headers: Record<string, string> = {};
    const chunks: Buffer[] = [];
    const stream = new PassThrough();

    stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));

    let endResolve: () => void;
    const endPromise = new Promise<void>((resolve) => {
      endResolve = resolve;
    });
    stream.on('finish', () => endResolve());

    (stream as unknown as Record<string, unknown>).writeHead = vi.fn(
      (code: number, hdrs?: Record<string, string>) => {
        _statusCode = code;
        if (hdrs) Object.assign(_headers, hdrs);
      },
    );
    (stream as unknown as Record<string, unknown>).setHeader = vi.fn();

    return {
      res: stream as unknown as http.ServerResponse,
      statusCode: () => _statusCode,
      headers: () => _headers,
      data: () => Buffer.concat(chunks),
      waitForEnd: () => endPromise,
    };
  }

  // -- File share CRUD (authenticated) ---------------------------------------

  describe('handleFileShare', () => {
    describe('POST (create)', () => {
      it('creates a file share and returns shareId', async () => {
        const { handleFileShare } = await import('../routes/share');
        const deps = makeFileDeps();
        const { res, body, statusCode } = mockRes();

        await handleFileShare(
          mockReqWithUrl('POST', '/api/file-shares', { filePath: 'test-doc.md' }),
          res,
          deps,
        );

        expect(statusCode()).toBe(200);
        const data = body() as { shareId: string; hasPassword: boolean };
        expect(data.shareId).toBeDefined();
        expect(typeof data.shareId).toBe('string');
        expect(data.shareId.length).toBeGreaterThan(0);
        expect(data.hasPassword).toBe(false);
      });

      it('rejects non-existent file (404)', async () => {
        const { handleFileShare } = await import('../routes/share');
        const deps = makeFileDeps();
        const { res, body, statusCode } = mockRes();

        await handleFileShare(
          mockReqWithUrl('POST', '/api/file-shares', { filePath: 'nonexistent.md' }),
          res,
          deps,
        );

        expect(statusCode()).toBe(404);
        expect((body() as { error: { code: string } }).error.code).toBe('FILE_NOT_FOUND');
      });

      it('rejects path traversal attempt (../secret.txt)', async () => {
        const { handleFileShare } = await import('../routes/share');
        const deps = makeFileDeps();
        const { res, body, statusCode } = mockRes();

        await handleFileShare(
          mockReqWithUrl('POST', '/api/file-shares', { filePath: '../secret.txt' }),
          res,
          deps,
        );

        expect(statusCode()).toBe(400);
        expect((body() as { error: { code: string } }).error.code).toBe('INVALID_PATH');
      });

      it('rejects encoded path traversal (%2e%2e/) as nonexistent', async () => {
        const { handleFileShare } = await import('../routes/share');
        const deps = makeFileDeps();
        const { res, statusCode } = mockRes();

        // In JSON body, %2e%2e is a literal string — path.resolve treats it as a filename
        await handleFileShare(
          mockReqWithUrl('POST', '/api/file-shares', { filePath: '%2e%2e/secret.txt' }),
          res,
          deps,
        );

        // Should error (literal path doesn't exist)
        expect(statusCode()).not.toBe(200);
      });

      it('rejects directory path', async () => {
        const { handleFileShare } = await import('../routes/share');
        const deps = makeFileDeps();
        const { res, body, statusCode } = mockRes();

        await handleFileShare(
          mockReqWithUrl('POST', '/api/file-shares', { filePath: 'subdir' }),
          res,
          deps,
        );

        expect(statusCode()).toBe(400);
        expect((body() as { error: { code: string } }).error.code).toBe('INVALID_PATH');
      });

      it('returns existing share if already shared (idempotent)', async () => {
        const { handleFileShare } = await import('../routes/share');
        const deps = makeFileDeps();

        const { res: r1, body: b1 } = mockRes();
        await handleFileShare(
          mockReqWithUrl('POST', '/api/file-shares', { filePath: 'test-doc.md' }),
          r1,
          deps,
        );
        const shareId1 = (b1() as { shareId: string }).shareId;

        const { res: r2, body: b2 } = mockRes();
        await handleFileShare(
          mockReqWithUrl('POST', '/api/file-shares', { filePath: 'test-doc.md' }),
          r2,
          deps,
        );
        const shareId2 = (b2() as { shareId: string }).shareId;

        expect(shareId1).toBe(shareId2);
      });

      it('creates share with password', async () => {
        const { handleFileShare } = await import('../routes/share');
        const deps = makeFileDeps();
        const { res, body, statusCode } = mockRes();

        await handleFileShare(
          mockReqWithUrl('POST', '/api/file-shares', {
            filePath: 'test-doc.md',
            password: 'secret123',
          }),
          res,
          deps,
        );

        expect(statusCode()).toBe(200);
        expect((body() as { hasPassword: boolean }).hasPassword).toBe(true);
      });

      it('creates share with expiry', async () => {
        const { handleFileShare } = await import('../routes/share');
        const deps = makeFileDeps();
        const { res, body, statusCode } = mockRes();

        await handleFileShare(
          mockReqWithUrl('POST', '/api/file-shares', {
            filePath: 'test-doc.md',
            expiresIn: '7d',
          }),
          res,
          deps,
        );

        expect(statusCode()).toBe(200);
        const data = body() as { expiresAt: number };
        expect(data.expiresAt).toBeDefined();
        expect(data.expiresAt).toBeGreaterThan(Date.now());
      });
    });

    describe('GET (status)', () => {
      it('returns share info for shared file', async () => {
        const deps = makeFileDeps();
        const shareId = await createFileShareLink('test-doc.md', deps);

        const { handleFileShare } = await import('../routes/share');
        const { res, body, statusCode } = mockRes();
        await handleFileShare(
          mockReqWithUrl('GET', '/api/file-shares?filePath=test-doc.md'),
          res,
          deps,
        );

        expect(statusCode()).toBe(200);
        expect((body() as { shareId: string }).shareId).toBe(shareId);
      });

      it('returns 404 when no share exists', async () => {
        const { handleFileShare } = await import('../routes/share');
        const deps = makeFileDeps();
        const { res, body, statusCode } = mockRes();

        await handleFileShare(
          mockReqWithUrl('GET', '/api/file-shares?filePath=test-doc.md'),
          res,
          deps,
        );

        expect(statusCode()).toBe(404);
        expect((body() as { error: { code: string } }).error.code).toBe('NO_SHARE');
      });
    });

    describe('PUT (update)', () => {
      it('updates expiry on existing file share', async () => {
        const deps = makeFileDeps();
        await createFileShareLink('test-doc.md', deps);

        const { handleFileShare } = await import('../routes/share');
        const { res, body, statusCode } = mockRes();
        await handleFileShare(
          mockReqWithUrl('PUT', '/api/file-shares', {
            filePath: 'test-doc.md',
            expiresIn: '24h',
          }),
          res,
          deps,
        );

        expect(statusCode()).toBe(200);
        const data = body() as { expiresAt: number; hasPassword: boolean };
        expect(data.expiresAt).toBeDefined();
        expect(data.hasPassword).toBe(false);
      });

      it('adds password to existing file share', async () => {
        const deps = makeFileDeps();
        await createFileShareLink('test-doc.md', deps);

        const { handleFileShare } = await import('../routes/share');
        const { res, body, statusCode } = mockRes();
        await handleFileShare(
          mockReqWithUrl('PUT', '/api/file-shares', {
            filePath: 'test-doc.md',
            password: 'newpass',
          }),
          res,
          deps,
        );

        expect(statusCode()).toBe(200);
        expect((body() as { hasPassword: boolean }).hasPassword).toBe(true);
      });

      it('removes password by passing null', async () => {
        const deps = makeFileDeps();
        await createFileShareLink('test-doc.md', deps, { password: 'initial' });

        const { handleFileShare } = await import('../routes/share');
        const { res, body, statusCode } = mockRes();
        await handleFileShare(
          mockReqWithUrl('PUT', '/api/file-shares', {
            filePath: 'test-doc.md',
            password: null,
          }),
          res,
          deps,
        );

        expect(statusCode()).toBe(200);
        expect((body() as { hasPassword: boolean }).hasPassword).toBe(false);
      });

      it('returns 404 if no file share exists', async () => {
        const { handleFileShare } = await import('../routes/share');
        const deps = makeFileDeps();
        const { res, statusCode } = mockRes();

        await handleFileShare(
          mockReqWithUrl('PUT', '/api/file-shares', {
            filePath: 'test-doc.md',
            expiresIn: '7d',
          }),
          res,
          deps,
        );

        expect(statusCode()).toBe(404);
      });
    });

    describe('DELETE (revoke)', () => {
      it('revokes file share and subsequent access fails', async () => {
        const deps = makeFileDeps();
        const shareId = await createFileShareLink('test-doc.md', deps);

        const { handleFileShare, handleSharedConversation } = await import('../routes/share');

        // Delete
        const { res: dr, statusCode: dsc } = mockRes();
        await handleFileShare(
          mockReqWithUrl('DELETE', '/api/file-shares?filePath=test-doc.md'),
          dr,
          deps,
        );
        expect(dsc()).toBe(200);

        // Verify public access fails
        const { res: pr, statusCode: psc } = mockRes();
        await handleSharedConversation(mockReq('GET'), pr, shareId, deps);
        expect(psc()).toBe(404);
      });

      it('succeeds even when no share exists (idempotent)', async () => {
        const { handleFileShare } = await import('../routes/share');
        const deps = makeFileDeps();
        const { res, body, statusCode } = mockRes();

        await handleFileShare(
          mockReqWithUrl('DELETE', '/api/file-shares?filePath=test-doc.md'),
          res,
          deps,
        );

        expect(statusCode()).toBe(200);
        expect((body() as { success: boolean }).success).toBe(true);
      });
    });
  });

  // -- Public file access (unauthenticated) ----------------------------------

  describe('public file access (handleSharedConversation file branch)', () => {
    it('GET shared markdown file returns content + metadata (no filePath)', async () => {
      const deps = makeFileDeps();
      const shareId = await createFileShareLink('test-doc.md', deps);

      const { handleSharedConversation } = await import('../routes/share');
      const { res, body, statusCode } = mockRes();
      await handleSharedConversation(mockReq('GET'), res, shareId, deps);

      expect(statusCode()).toBe(200);
      const data = body() as Record<string, unknown>;
      expect(data.resourceType).toBe('file');
      expect(data.fileName).toBe('test-doc.md');
      expect(data.mimeType).toBe('text/markdown');
      expect(typeof data.size).toBe('number');
      expect(typeof data.content).toBe('string');
      expect(data.content).toContain('# Hello World');
      expect(data.downloadUrl).toBeDefined();
      expect(data.updatedAt).toBeDefined();
      // filePath must NOT be in the public response
      expect(data.filePath).toBeUndefined();
    });

    it('GET shared binary file returns metadata + downloadUrl (no content)', async () => {
      const deps = makeFileDeps();
      const shareId = await createFileShareLink('test-image.png', deps);

      const { handleSharedConversation } = await import('../routes/share');
      const { res, body, statusCode } = mockRes();
      await handleSharedConversation(mockReq('GET'), res, shareId, deps);

      expect(statusCode()).toBe(200);
      const data = body() as Record<string, unknown>;
      expect(data.resourceType).toBe('file');
      expect(data.fileName).toBe('test-image.png');
      expect(data.mimeType).toBe('image/png');
      expect(data.downloadUrl).toContain(`/api/shared/${shareId}/download`);
      // Binary files should NOT have inline content
      expect(data.content).toBeUndefined();
    });

    it('GET shared file for deleted file returns 404', async () => {
      const deps = makeFileDeps();
      const shareId = await createFileShareLink('test-doc.md', deps);

      // Delete the file after sharing
      await fs.rm(path.join(TEST_WORKSPACE_DIR, 'test-doc.md'));

      const { handleSharedConversation } = await import('../routes/share');
      const { res, body, statusCode } = mockRes();
      await handleSharedConversation(mockReq('GET'), res, shareId, deps);

      expect(statusCode()).toBe(404);
      expect((body() as { error: { code: string } }).error.code).toBe('RESOURCE_UNAVAILABLE');
    });

    it('expired file share returns 404', async () => {
      const deps = makeFileDeps();
      const shareId = await createFileShareLink('test-doc.md', deps, {
        expiresIn: '24h',
      });

      // Expire the share by manipulating the store
      const shareFile = path.join(TEST_DATA_DIR, 'share-links.json');
      const raw = JSON.parse(await fs.readFile(shareFile, 'utf-8'));
      for (const key of Object.keys(raw)) {
        if (raw[key].shareId === shareId) {
          raw[key].expiresAt = Date.now() - 1000; // already expired
        }
      }
      await fs.writeFile(shareFile, JSON.stringify(raw));

      const { handleSharedConversation } = await import('../routes/share');
      const { res, statusCode } = mockRes();
      await handleSharedConversation(mockReq('GET'), res, shareId, deps);

      expect(statusCode()).toBe(404);
    });
  });

  // -- Download endpoint -----------------------------------------------------

  describe('handleSharedFileDownload', () => {
    it('streams file with correct Content-Type', async () => {
      const deps = makeFileDeps();
      const shareId = await createFileShareLink('test-doc.md', deps);

      const { handleSharedFileDownload } = await import('../routes/share');
      const sRes = mockStreamRes();
      await handleSharedFileDownload(
        mockReqWithUrl('GET', `/api/shared/${shareId}/download`),
        sRes.res,
        shareId,
        deps,
      );
      await sRes.waitForEnd();

      expect(sRes.statusCode()).toBe(200);
      expect(sRes.headers()['Content-Type']).toBe('text/markdown');
      expect(sRes.data().toString()).toContain('# Hello World');
    });

    it('includes Content-Disposition with sanitized filename', async () => {
      const deps = makeFileDeps();
      const shareId = await createFileShareLink('test-doc.md', deps);

      const { handleSharedFileDownload } = await import('../routes/share');
      const sRes = mockStreamRes();
      await handleSharedFileDownload(
        mockReqWithUrl('GET', `/api/shared/${shareId}/download`),
        sRes.res,
        shareId,
        deps,
      );
      await sRes.waitForEnd();

      expect(sRes.headers()['Content-Disposition']).toContain('test-doc.md');
      expect(sRes.headers()['Content-Disposition']).toContain('attachment');
    });

    it('includes X-Content-Type-Options: nosniff', async () => {
      const deps = makeFileDeps();
      const shareId = await createFileShareLink('test-doc.md', deps);

      const { handleSharedFileDownload } = await import('../routes/share');
      const sRes = mockStreamRes();
      await handleSharedFileDownload(
        mockReqWithUrl('GET', `/api/shared/${shareId}/download`),
        sRes.res,
        shareId,
        deps,
      );
      await sRes.waitForEnd();

      expect(sRes.headers()['X-Content-Type-Options']).toBe('nosniff');
    });

    it('returns 404 for non-file share (conversation share)', async () => {
      // Create a conversation share, then try to download it
      const session = makeSession();
      const convDeps = {
        getSession: vi.fn(async () => session),
        getSettings: vi.fn(() => ({ coreDirectory: TEST_WORKSPACE_DIR })),
      } as unknown as CloudServiceDeps;
      const convShareId = await createShareLink('test-session-1', convDeps);

      const { handleSharedFileDownload } = await import('../routes/share');
      const sRes = mockStreamRes();
      await handleSharedFileDownload(
        mockReqWithUrl('GET', `/api/shared/${convShareId}/download`),
        sRes.res,
        convShareId,
        convDeps,
      );
      await sRes.waitForEnd();

      expect(sRes.statusCode()).toBe(404);
    });

    it('returns 404 for expired file share', async () => {
      const deps = makeFileDeps();
      const shareId = await createFileShareLink('test-doc.md', deps, {
        expiresIn: '24h',
      });

      // Expire the share
      const shareFile = path.join(TEST_DATA_DIR, 'share-links.json');
      const raw = JSON.parse(await fs.readFile(shareFile, 'utf-8'));
      for (const key of Object.keys(raw)) {
        if (raw[key].shareId === shareId) {
          raw[key].expiresAt = Date.now() - 1000;
        }
      }
      await fs.writeFile(shareFile, JSON.stringify(raw));

      const { handleSharedFileDownload } = await import('../routes/share');
      const sRes = mockStreamRes();
      await handleSharedFileDownload(
        mockReqWithUrl('GET', `/api/shared/${shareId}/download`),
        sRes.res,
        shareId,
        deps,
      );
      await sRes.waitForEnd();

      expect(sRes.statusCode()).toBe(404);
    });
  });

  // -- Password-protected files ----------------------------------------------

  describe('password-protected files', () => {
    it('GET password-protected file returns 401 PASSWORD_REQUIRED', async () => {
      const deps = makeFileDeps();
      const shareId = await createFileShareLink('test-doc.md', deps, {
        password: 'secret',
      });

      const { handleSharedConversation } = await import('../routes/share');
      const { res, body, statusCode } = mockRes();
      await handleSharedConversation(mockReq('GET'), res, shareId, deps);

      expect(statusCode()).toBe(401);
      expect((body() as { error: { code: string } }).error.code).toBe('PASSWORD_REQUIRED');
    });

    it('unlock with correct password returns metadata + signed downloadUrl', async () => {
      process.env.REBEL_SHARE_DOWNLOAD_SECRET = 'test-secret-key';
      const deps = makeFileDeps();
      const shareId = await createFileShareLink('test-doc.md', deps, {
        password: 'correct',
      });

      const { handleSharedConversationUnlock } = await import('../routes/share');
      const { res, body, statusCode } = mockRes();
      await handleSharedConversationUnlock(
        mockReq('POST', { password: 'correct' }),
        res,
        shareId,
        deps,
      );

      expect(statusCode()).toBe(200);
      const data = body() as Record<string, unknown>;
      expect(data.resourceType).toBe('file');
      expect(data.fileName).toBe('test-doc.md');
      expect(data.content).toContain('# Hello World');
      // Download URL should have HMAC signature
      expect(data.downloadUrl).toContain('sig=');
      expect(data.downloadUrl).toContain('exp=');
    });

    it('unlock with wrong password returns 401', async () => {
      const deps = makeFileDeps();
      const shareId = await createFileShareLink('test-doc.md', deps, {
        password: 'correct',
      });

      const { handleSharedConversationUnlock } = await import('../routes/share');
      const { res, body, statusCode } = mockRes();
      await handleSharedConversationUnlock(
        mockReq('POST', { password: 'wrong' }),
        res,
        shareId,
        deps,
      );

      expect(statusCode()).toBe(401);
      expect((body() as { error: { code: string } }).error.code).toBe('INVALID_PASSWORD');
    });

    it('download with valid HMAC signature streams file', async () => {
      process.env.REBEL_SHARE_DOWNLOAD_SECRET = 'test-secret-key';
      const deps = makeFileDeps();
      const shareId = await createFileShareLink('test-doc.md', deps, {
        password: 'correct',
      });

      // Get a signed URL via unlock
      const { handleSharedConversationUnlock, handleSharedFileDownload } =
        await import('../routes/share');
      const { res: ur, body: ub } = mockRes();
      await handleSharedConversationUnlock(
        mockReq('POST', { password: 'correct' }),
        ur,
        shareId,
        deps,
      );
      const downloadUrl = (ub() as Record<string, unknown>).downloadUrl as string;

      // Download using the signed URL
      const sRes = mockStreamRes();
      await handleSharedFileDownload(
        mockReqWithUrl('GET', downloadUrl),
        sRes.res,
        shareId,
        deps,
      );
      await sRes.waitForEnd();

      expect(sRes.statusCode()).toBe(200);
      expect(sRes.data().toString()).toContain('# Hello World');
    });

    it('download with tampered signature returns 401', async () => {
      process.env.REBEL_SHARE_DOWNLOAD_SECRET = 'test-secret-key';
      const deps = makeFileDeps();
      const shareId = await createFileShareLink('test-doc.md', deps, {
        password: 'correct',
      });

      // Generate a tampered signature
      const exp = Date.now() + 300_000;
      const tamperedSig = 'a'.repeat(64); // invalid hex signature

      const { handleSharedFileDownload } = await import('../routes/share');
      const sRes = mockStreamRes();
      await handleSharedFileDownload(
        mockReqWithUrl(
          'GET',
          `/api/shared/${shareId}/download?sig=${tamperedSig}&exp=${exp}`,
        ),
        sRes.res,
        shareId,
        deps,
      );
      await sRes.waitForEnd();

      expect(sRes.statusCode()).toBe(401);
    });

    it('download with expired signature returns 401', async () => {
      process.env.REBEL_SHARE_DOWNLOAD_SECRET = 'test-secret-key';
      const deps = makeFileDeps();
      const shareId = await createFileShareLink('test-doc.md', deps, {
        password: 'correct',
      });

      // Compute a valid signature for an already-expired timestamp
      const exp = Date.now() - 1000;
      const sig = crypto
        .createHmac('sha256', 'test-secret-key')
        .update(`${shareId}:${exp}`)
        .digest('hex');

      const { handleSharedFileDownload } = await import('../routes/share');
      const sRes = mockStreamRes();
      await handleSharedFileDownload(
        mockReqWithUrl(
          'GET',
          `/api/shared/${shareId}/download?sig=${sig}&exp=${exp}`,
        ),
        sRes.res,
        shareId,
        deps,
      );
      await sRes.waitForEnd();

      expect(sRes.statusCode()).toBe(401);
    });

    it('download password-protected file without signature returns 401', async () => {
      process.env.REBEL_SHARE_DOWNLOAD_SECRET = 'test-secret-key';
      const deps = makeFileDeps();
      const shareId = await createFileShareLink('test-doc.md', deps, {
        password: 'correct',
      });

      const { handleSharedFileDownload } = await import('../routes/share');
      const sRes = mockStreamRes();
      await handleSharedFileDownload(
        mockReqWithUrl('GET', `/api/shared/${shareId}/download`),
        sRes.res,
        shareId,
        deps,
      );
      await sRes.waitForEnd();

      expect(sRes.statusCode()).toBe(401);
    });
  });

  // -- Backward compatibility ------------------------------------------------

  describe('backward compatibility', () => {
    it('existing conversation shares still work unchanged (regression)', async () => {
      const {
        handleSessionShare,
        handleSharedConversation,
      } = await import('../routes/share');
      const session = makeSession({ title: 'Regression Test' });
      const deps = {
        getSession: vi.fn(async () => session),
        getSettings: vi.fn(() => ({ coreDirectory: TEST_WORKSPACE_DIR })),
      } as unknown as CloudServiceDeps;

      // Create conversation share
      const { res: cr, body: cb } = mockRes();
      await handleSessionShare(mockReq('POST'), cr, 'regression-session', deps);
      const shareId = (cb() as { shareId: string }).shareId;

      // Public read should return conversation data
      const { res: pr, body: pb, statusCode: psc } = mockRes();
      await handleSharedConversation(mockReq('GET'), pr, shareId, deps);
      expect(psc()).toBe(200);
      expect((pb() as { title: string }).title).toBe('Regression Test');
      expect((pb() as { messages: unknown[] }).messages).toHaveLength(2);
    });

    it('old share entries without resourceType still work as conversations', async () => {
      // Write a legacy share entry (no resourceType field)
      const legacyShareId = crypto.randomBytes(16).toString('base64url');
      const shareFile = path.join(TEST_DATA_DIR, 'share-links.json');
      await fs.writeFile(
        shareFile,
        JSON.stringify({
          'legacy-session': {
            shareId: legacyShareId,
            createdAt: Date.now(),
            title: 'Legacy Share',
          },
        }),
      );

      const session = makeSession({ title: 'Legacy Share' });
      const deps = {
        getSession: vi.fn(async () => session),
        getSettings: vi.fn(() => ({ coreDirectory: TEST_WORKSPACE_DIR })),
      } as unknown as CloudServiceDeps;

      const { handleSharedConversation } = await import('../routes/share');
      const { res, body, statusCode } = mockRes();
      await handleSharedConversation(mockReq('GET'), res, legacyShareId, deps);

      expect(statusCode()).toBe(200);
      expect((body() as { title: string }).title).toBe('Legacy Share');
    });

    it('handleSharesList returns mixed types correctly', async () => {
      const session = makeSession({ title: 'Chat Share' });
      const deps = {
        getSession: vi.fn(async () => session),
        getSettings: vi.fn(() => ({ coreDirectory: TEST_WORKSPACE_DIR })),
      } as unknown as CloudServiceDeps;

      // Create a conversation share
      const { handleSessionShare, handleSharesList } =
        await import('../routes/share');
      const { res: cr } = mockRes();
      await handleSessionShare(mockReq('POST'), cr, 'mixed-session', deps);

      // Create a file share
      await createFileShareLink('test-doc.md', deps);

      // List should include both
      const { res: lr, body: lb, statusCode: lsc } = mockRes();
      await handleSharesList(mockReq('GET'), lr);
      expect(lsc()).toBe(200);

      const shares = (
        lb() as {
          shares: Array<{
            resourceType: string;
            sessionId?: string;
            filePath?: string;
          }>;
        }
      ).shares;
      expect(shares.length).toBe(2);

      const convShare = shares.find((s) => s.resourceType === 'conversation');
      const fileShare = shares.find((s) => s.resourceType === 'file');
      expect(convShare).toBeDefined();
      expect(convShare!.sessionId).toBe('mixed-session');
      expect(fileShare).toBeDefined();
      expect(fileShare!.filePath).toBe('test-doc.md');
    });
  });

  // -- Write mutex -----------------------------------------------------------

  describe('write mutex', () => {
    it('parallel creates on different keys both survive', async () => {
      const { handleFileShare, handleSharesList } =
        await import('../routes/share');
      const deps = makeFileDeps();

      const { res: r1, body: b1, statusCode: sc1 } = mockRes();
      const { res: r2, body: b2, statusCode: sc2 } = mockRes();

      await Promise.all([
        handleFileShare(
          mockReqWithUrl('POST', '/api/file-shares', {
            filePath: 'test-doc.md',
          }),
          r1,
          deps,
        ),
        handleFileShare(
          mockReqWithUrl('POST', '/api/file-shares', {
            filePath: 'subdir/nested.txt',
          }),
          r2,
          deps,
        ),
      ]);

      expect(sc1()).toBe(200);
      expect(sc2()).toBe(200);
      const id1 = (b1() as { shareId: string }).shareId;
      const id2 = (b2() as { shareId: string }).shareId;
      expect(id1).toBeDefined();
      expect(id2).toBeDefined();
      expect(id1).not.toBe(id2);

      // Verify both exist
      const { res: lr, body: lb } = mockRes();
      await handleSharesList(mockReq('GET'), lr);
      const shares = (lb() as { shares: Array<{ shareId: string }> }).shares;
      expect(shares.length).toBe(2);
    });

    it('parallel create + revoke causes no data loss', async () => {
      const deps = makeFileDeps();
      await createFileShareLink('test-doc.md', deps);

      const { handleFileShare, handleSharesList } =
        await import('../routes/share');

      const { res: r1, body: b1, statusCode: sc1 } = mockRes();
      const { res: r2, statusCode: sc2 } = mockRes();

      await Promise.all([
        handleFileShare(
          mockReqWithUrl('POST', '/api/file-shares', {
            filePath: 'subdir/nested.txt',
          }),
          r1,
          deps,
        ),
        handleFileShare(
          mockReqWithUrl('DELETE', '/api/file-shares?filePath=test-doc.md'),
          r2,
          deps,
        ),
      ]);

      expect(sc1()).toBe(200);
      expect(sc2()).toBe(200);

      // Verify: new share exists, old share is gone
      const { res: lr, body: lb } = mockRes();
      await handleSharesList(mockReq('GET'), lr);
      const shares = (lb() as { shares: Array<{ shareId: string }> }).shares;
      expect(shares.length).toBe(1);
      expect(shares[0].shareId).toBe(
        (b1() as { shareId: string }).shareId,
      );
    });
  });

  // -- readShareLinks hardening ----------------------------------------------

  describe('readShareLinks hardening', () => {
    it('corrupt JSON rejects (not silent empty)', async () => {
      await fs.writeFile(
        path.join(TEST_DATA_DIR, 'share-links.json'),
        '{{{invalid json!!!',
      );

      const { handleSharesList } = await import('../routes/share');
      const { res } = mockRes();
      await expect(handleSharesList(mockReq('GET'), res)).rejects.toThrow(
        'share-links.json is corrupt',
      );
    });

    it('missing file (ENOENT) returns empty store', async () => {
      // Don't create share-links.json — the top-level beforeEach already
      // cleaned TEST_DATA_DIR, so the file doesn't exist
      const { handleSharesList } = await import('../routes/share');
      const { res, statusCode, body } = mockRes();
      await handleSharesList(mockReq('GET'), res);

      expect(statusCode()).toBe(200);
      expect((body() as { shares: unknown[] }).shares).toEqual([]);
    });

    it.skipIf(
      typeof process.getuid === 'function' && process.getuid() === 0,
    )('permission error rejects (not silent empty)', async () => {
      const filePath = path.join(TEST_DATA_DIR, 'share-links.json');
      await fs.writeFile(filePath, '{}');
      await fs.chmod(filePath, 0o000);

      const { handleSharesList } = await import('../routes/share');
      const { res } = mockRes();
      try {
        await expect(
          handleSharesList(mockReq('GET'), res),
        ).rejects.toThrow();
      } finally {
        await fs.chmod(filePath, 0o644);
      }
    });
  });
});
