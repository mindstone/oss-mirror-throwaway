/**
 * F-R3-1 — Generic IPC route-level Zod validation tests.
 *
 * Verifies that channels with ROUTE_SCHEMAS enforce payload validation:
 * - Empty params → 400 VALIDATION_ERROR (not 500 HANDLER_ERROR)
 * - Wrong-type payload → 400 VALIDATION_ERROR
 * - Multiple params → 400 VALIDATION_ERROR
 * - Valid single payload → delegates to handler
 * - Channel without schema + any params → delegates (no validation)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import { handleGenericIpc } from '../routes/ipc';
import type { CloudServiceDeps } from '../bootstrap';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal mock IncomingMessage with a JSON body. */
function createMockReq(body: unknown): http.IncomingMessage {
  const req = new http.IncomingMessage(null as never);
  req.method = 'POST';
  // Simulate readable stream with the body
  const payload = JSON.stringify(body);
  req.push(payload);
  req.push(null);
  return req;
}

type MockResShape = {
  _status: number;
  _body: unknown;
  _headers: Record<string, string | number>;
};

/** Create a mock ServerResponse that captures writes. */
function createMockRes(): http.ServerResponse & { _status: number; _body: unknown } {
  const res = {
    _status: 0,
    _body: null as unknown,
    _headers: {} as Record<string, string | number>,
    writeHead(this: MockResShape, status: number, headers?: Record<string, string | number>) {
      this._status = status;
      if (headers) Object.assign(this._headers, headers);
      return this;
    },
    end(this: MockResShape, data?: string | Buffer) {
      const str = typeof data === 'string' ? data : data ? data.toString('utf8') : undefined;
      if (str) {
        try {
          this._body = JSON.parse(str);
        } catch {
          this._body = str;
        }
      }
      return this;
    },
    setHeader() { return this; },
    getHeader() { return undefined; },
  } as unknown as http.ServerResponse & { _status: number; _body: unknown };
  return res;
}

// Mock handler registry
const mockHandler = vi.fn().mockResolvedValue({ ok: true });
vi.mock('@core/handlerRegistry', () => ({
  getHandlerRegistry: () => ({
    get: (_channel: string) => mockHandler,
  }),
}));

const mockDeps = {} as CloudServiceDeps;

describe('Generic IPC route — schema-carrying channels', () => {
  beforeEach(() => {
    mockHandler.mockClear();
    mockHandler.mockResolvedValue({ ok: true });
  });

  // Use settings:set-space-safety-level as a representative schema channel
  const schemaChannel = 'settings:set-space-safety-level';
  const segments = ['', 'ipc', encodeURIComponent(schemaChannel)];

  it('rejects empty params with 400 VALIDATION_ERROR', async () => {
    const req = createMockReq({ params: [] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    // sendError wraps as { error: { code, message } }
    expect((res._body as Record<string, Record<string, string>>).error.code).toBe('VALIDATION_ERROR');
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('rejects missing params (undefined) with 400 VALIDATION_ERROR', async () => {
    const req = createMockReq({});
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect((res._body as Record<string, Record<string, string>>).error.code).toBe('VALIDATION_ERROR');
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('rejects wrong-type payload with 400 VALIDATION_ERROR', async () => {
    const req = createMockReq({ params: ['not-an-object'] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect((res._body as Record<string, Record<string, string>>).error.code).toBe('VALIDATION_ERROR');
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('rejects multiple params with 400 VALIDATION_ERROR', async () => {
    const req = createMockReq({ params: [
      { spaceId: 'space_1', level: 'cautious' },
      { spaceId: 'space_2', level: 'balanced' },
    ]});
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect((res._body as Record<string, Record<string, string>>).error.code).toBe('VALIDATION_ERROR');
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('delegates to handler with valid single payload', async () => {
    const validPayload = { spaceId: 'space_1', level: 'cautious' };
    const req = createMockReq({ params: [validPayload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(200);
    expect(mockHandler).toHaveBeenCalledOnce();
    // args[0] should be the Zod-parsed payload (stripped/coerced)
    expect(mockHandler.mock.calls[0]![1]).toEqual(validPayload);
  });
});

describe('Generic IPC route — channels without schema', () => {
  beforeEach(() => {
    mockHandler.mockClear();
    mockHandler.mockResolvedValue({ items: [] });
  });

  // inbox:load has no route schema
  const noSchemaChannel = 'inbox:load';
  const segments = ['', 'ipc', encodeURIComponent(noSchemaChannel)];

  it('delegates to handler with any params (no validation)', async () => {
    const req = createMockReq({ params: [{ limit: 10 }] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(200);
    expect(mockHandler).toHaveBeenCalledOnce();
  });

  it('delegates to handler with empty params (no validation)', async () => {
    const req = createMockReq({ params: [] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(200);
    expect(mockHandler).toHaveBeenCalledOnce();
  });
});

// F-B-R2-6: Stage B capability-token endpoints must reject oversize and
// malformed payloads at the route layer, BEFORE handler dispatch. The
// shared IPC schemas already cap these, but mobile/web can POST the
// cloud endpoint directly, bypassing the shared schema; the route-level
// check is the single enforcement point for cloud requests.
describe('Generic IPC route — memory:staging-mint-conflict-capability', () => {
  beforeEach(() => {
    mockHandler.mockClear();
    mockHandler.mockResolvedValue({ success: true, token: 'tok.sig', expiresAt: 0 });
  });

  const segments = ['', 'ipc', encodeURIComponent('memory:staging-mint-conflict-capability')];

  it('accepts a well-formed stagedFileId', async () => {
    const req = createMockReq({ params: [{ stagedFileId: 'stg_ok' }] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(200);
    expect(mockHandler).toHaveBeenCalledOnce();
    expect(mockHandler.mock.calls[0]![1]).toEqual({ stagedFileId: 'stg_ok' });
  });

  it('rejects empty stagedFileId with 400 VALIDATION_ERROR', async () => {
    const req = createMockReq({ params: [{ stagedFileId: '' }] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect((res._body as Record<string, Record<string, string>>).error.code).toBe('VALIDATION_ERROR');
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('rejects oversize stagedFileId (> 256 chars) with 400 VALIDATION_ERROR', async () => {
    const oversize = 'a'.repeat(257);
    const req = createMockReq({ params: [{ stagedFileId: oversize }] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect((res._body as Record<string, Record<string, string>>).error.code).toBe('VALIDATION_ERROR');
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('rejects missing stagedFileId with 400 VALIDATION_ERROR', async () => {
    const req = createMockReq({ params: [{}] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect((res._body as Record<string, Record<string, string>>).error.code).toBe('VALIDATION_ERROR');
    expect(mockHandler).not.toHaveBeenCalled();
  });
});

describe('Generic IPC route — memory:staging-resolve-conflict', () => {
  beforeEach(() => {
    mockHandler.mockClear();
    mockHandler.mockResolvedValue({ status: 'success' });
  });

  const segments = ['', 'ipc', encodeURIComponent('memory:staging-resolve-conflict')];

  it('accepts a well-formed resolve payload', async () => {
    const payload = { id: 'stg_ok', resolution: 'keep-staged', capabilityToken: 'tok.sig' };
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(200);
    expect(mockHandler).toHaveBeenCalledOnce();
    expect(mockHandler.mock.calls[0]![1]).toEqual(payload);
  });

  it('rejects oversize id (> 256 chars) with 400 VALIDATION_ERROR', async () => {
    const payload = {
      id: 'a'.repeat(257),
      resolution: 'keep-staged',
      capabilityToken: 'tok.sig',
    };
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect((res._body as Record<string, Record<string, string>>).error.code).toBe('VALIDATION_ERROR');
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('rejects oversize capabilityToken (> 2048 chars) with 400 VALIDATION_ERROR', async () => {
    const payload = {
      id: 'stg_ok',
      resolution: 'keep-staged',
      capabilityToken: 'a'.repeat(2049),
    };
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect((res._body as Record<string, Record<string, string>>).error.code).toBe('VALIDATION_ERROR');
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('rejects empty capabilityToken with 400 VALIDATION_ERROR', async () => {
    const payload = { id: 'stg_ok', resolution: 'keep-staged', capabilityToken: '' };
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect((res._body as Record<string, Record<string, string>>).error.code).toBe('VALIDATION_ERROR');
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('rejects unsupported resolution with 400 VALIDATION_ERROR', async () => {
    const payload = { id: 'stg_ok', resolution: 'merge', capabilityToken: 'tok.sig' };
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect((res._body as Record<string, Record<string, string>>).error.code).toBe('VALIDATION_ERROR');
    expect(mockHandler).not.toHaveBeenCalled();
  });

  // Stage C (260417_approval_consolidation_closeout): the optional
  // `clientDedupKey` field MUST survive route-level Zod validation so
  // the handler can read it. Without an explicit entry in the
  // `ResolveConflictRouteSchema`, Zod's default strict() parsing would
  // strip the unknown property before it reaches the handler.
  it('accepts a valid clientDedupKey UUID alongside resolve payload', async () => {
    const payload = {
      id: 'stg_ok',
      resolution: 'keep-staged',
      capabilityToken: 'tok.sig',
      clientDedupKey: '11111111-1111-4111-8111-111111111111',
    };
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(200);
    expect(mockHandler).toHaveBeenCalledOnce();
    // Field must reach the handler — otherwise the cache never records
    // the dedup key for future retries.
    expect(mockHandler.mock.calls[0]![1]).toEqual(payload);
  });

  it('rejects a malformed clientDedupKey (not a UUID) with 400 VALIDATION_ERROR', async () => {
    const payload = {
      id: 'stg_ok',
      resolution: 'keep-staged',
      capabilityToken: 'tok.sig',
      clientDedupKey: 'not-a-uuid',
    };
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect((res._body as Record<string, Record<string, string>>).error.code).toBe('VALIDATION_ERROR');
    expect(mockHandler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Stage 6 hardening — agent:user-question-response route schema validation.
// See docs/plans/260420_user_question_cross_surface_resilience.md
// ---------------------------------------------------------------------------

describe('Generic IPC route — agent:user-question-response schema', () => {
  const channel = 'agent:user-question-response';
  const segments = ['', 'ipc', encodeURIComponent(channel)];

  beforeEach(() => {
    mockHandler.mockClear();
    mockHandler.mockResolvedValue({ success: true, continuationMessage: 'ok' });
  });

  const validPayload = {
    batchId: 'b-1',
    answers: [{ questionId: 'q1', selectedOptionIds: ['q1-opt1'] }],
    sessionId: 'sess-1',
    turnId: 'turn-1',
    toolUseId: 'tu-1',
    questions: [
      {
        id: 'q1',
        question: 'Which format?',
        options: [{ id: 'q1-opt1', label: 'A' }],
      },
    ],
  };

  it('accepts a valid single-batch payload and forwards to the handler', async () => {
    const req = createMockReq({ params: [validPayload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(200);
    expect(mockHandler).toHaveBeenCalledOnce();
  });

  it('rejects missing required context (sessionId) with 400 VALIDATION_ERROR', async () => {
    const bad = { ...validPayload } as Record<string, unknown>;
    delete bad.sessionId;
    const req = createMockReq({ params: [bad] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect((res._body as Record<string, Record<string, string>>).error.code).toBe('VALIDATION_ERROR');
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('rejects free-text answers over the per-field cap with 400 VALIDATION_ERROR', async () => {
    const tooLong = 'x'.repeat(4001);
    const bad = {
      ...validPayload,
      answers: [{ questionId: 'q1', selectedOptionIds: [], freeText: tooLong }],
    };
    const req = createMockReq({ params: [bad] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('rejects too many queuedBatches with 400 VALIDATION_ERROR', async () => {
    const batch = {
      batchId: 'q-x',
      answers: [],
      questions: validPayload.questions,
    };
    const bad = {
      ...validPayload,
      queuedBatches: Array(9).fill(batch),
    };
    const req = createMockReq({ params: [bad] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect(mockHandler).not.toHaveBeenCalled();
  });

  // Route-level Zod parsing must preserve `questions[].purpose` so the
  // platform-agnostic handler and clients keep approval-clarification display
  // semantics without turning the answer into execution permission.
  it('preserves questions[].purpose=approval_clarification through route validation', async () => {
    const payloadWithPurpose = {
      ...validPayload,
      questions: [
        {
          id: 'q1',
          question: 'Which calendar should this go on?',
          options: [{ id: 'q1-opt1', label: 'Work' }],
          purpose: 'approval_clarification',
        },
      ],
    };
    const req = createMockReq({ params: [payloadWithPurpose] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(200);
    expect(mockHandler).toHaveBeenCalledOnce();
    const forwarded = mockHandler.mock.calls[0]?.[1];
    expect(forwarded?.questions?.[0]?.purpose).toBe('approval_clarification');
  });

  it('rejects unknown purpose values with 400 VALIDATION_ERROR', async () => {
    const bad = {
      ...validPayload,
      questions: [
        {
          id: 'q1',
          question: 'Which?',
          options: [{ id: 'q1-opt1', label: 'A' }],
          purpose: 'something_else',
        },
      ],
    };
    const req = createMockReq({ params: [bad] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect(mockHandler).not.toHaveBeenCalled();
  });

});
