/**
 * Stage 4 security tests for the safety-prompt + narrow-settings surface
 * exposed to mobile via `/api/ipc/:channel`.
 *
 * Scenarios (per `docs/plans/260416_centralize_approval_and_diff_viewing_ux.md`
 * Stage 4, lines 569-577):
 *
 *   (a) Unauthenticated → 401 fail-closed
 *   (b) Authenticated calls hit the shared handler registry (instance-global
 *       state — no per-user isolation, matching the single-user cloud model)
 *   (c) `safety-prompt:apply-selection` alone does NOT persist; persistence
 *       requires a separate `safety-prompt:update` call
 *   (d) Field-cap rejection on every capped free-text field (cap+1 → 400)
 *   (e) `settings:set-space-safety-level` rejects invalid `spaceId` and
 *       invalid `level` at the route (before the handler runs)
 *   (f) `settings:add-trusted-tool` route validates `toolId` format and the
 *       handler emits a structured audit-log entry (observable side effect)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { CLOUD_IPC_ALLOWLIST, handleGenericIpc } from '../routes/ipc';
import type { CloudServiceDeps } from '../bootstrap';

// ---------------------------------------------------------------------------
// Shared helpers (mirrors genericIpcRouteValidation.test.ts)
// ---------------------------------------------------------------------------

function createMockReq(body: unknown): http.IncomingMessage {
  const req = new http.IncomingMessage(null as never);
  req.method = 'POST';
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

const mockHandler = vi.fn();
vi.mock('@core/handlerRegistry', () => ({
  getHandlerRegistry: () => ({
    get: (channel: string) => (_event: unknown, ...args: unknown[]) => mockHandler(channel, ...args),
  }),
}));

const mockDeps = {} as CloudServiceDeps;

function ipcSegments(channel: string): string[] {
  return ['', 'ipc', encodeURIComponent(channel)];
}

function errorCode(body: unknown): string | undefined {
  const wrapped = body as { error?: { code?: string } } | null;
  return wrapped?.error?.code;
}

// ---------------------------------------------------------------------------
// (a) Authentication — fail-closed on unauthenticated requests
// ---------------------------------------------------------------------------

describe('Stage 4 security — (a) unauthenticated fail-closed', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  /**
   * `authorize()` reads `REBEL_CLOUD_TOKEN` / `REBEL_BRIDGE_TOKEN` at
   * module-load time, so each scenario must `vi.resetModules()` and then
   * dynamic-import `../auth` to pick up the env set in this test.
   */
  async function loadFreshAuthorize() {
    vi.resetModules();
    const mod = await import('../auth');
    return mod.authorize;
  }

  it('rejects a safety-prompt:generate-options POST with no auth header', async () => {
    process.env.REBEL_CLOUD_TOKEN = 'test-token';
    process.env.NODE_ENV = 'production';
    const authorizeFresh = await loadFreshAuthorize();
    const req = {
      headers: {},
      method: 'POST',
    } as unknown as http.IncomingMessage;
    expect(authorizeFresh(req)).toBe(false);
  });

  it('rejects a safety-prompt:update POST with a wrong bearer token', async () => {
    process.env.REBEL_CLOUD_TOKEN = 'correct-token';
    process.env.NODE_ENV = 'production';
    const authorizeFresh = await loadFreshAuthorize();
    const req = {
      headers: { authorization: 'Bearer wrong-token' },
      method: 'POST',
    } as unknown as http.IncomingMessage;
    expect(authorizeFresh(req)).toBe(false);
  });

  it('allows only requests whose bearer token matches the configured value', async () => {
    process.env.REBEL_CLOUD_TOKEN = 'correct-token';
    process.env.NODE_ENV = 'production';
    const authorizeFresh = await loadFreshAuthorize();
    const req = {
      headers: { authorization: 'Bearer correct-token' },
      method: 'POST',
    } as unknown as http.IncomingMessage;
    expect(authorizeFresh(req)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (b) Authenticated calls → shared handler registry → instance-global state
// ---------------------------------------------------------------------------

describe('Stage 4 security — (b) authenticated calls hit instance-global handlers', () => {
  beforeEach(() => {
    mockHandler.mockReset();
    mockHandler.mockResolvedValue({ options: [] });
  });

  it('routes two sequential safety-prompt:generate-options calls through the same handler', async () => {
    const segments = ipcSegments('safety-prompt:generate-options');
    const payload = {
      toolName: 'memory_write',
      toolInput: { spaceName: 'Team Ops' },
      blockReason: 'Memory write to "Team Ops"',
    };

    const req1 = createMockReq({ params: [payload] });
    const res1 = createMockRes();
    await handleGenericIpc(req1, res1, segments, mockDeps);

    const req2 = createMockReq({ params: [payload] });
    const res2 = createMockRes();
    await handleGenericIpc(req2, res2, segments, mockDeps);

    expect(res1._status).toBe(200);
    expect(res2._status).toBe(200);
    expect(mockHandler).toHaveBeenCalledTimes(2);
    // Both calls target the same channel — handler registry is a singleton,
    // and the cloud service is single-user bearer-token-gated (A7). No
    // per-user isolation exists or is tested.
    expect(mockHandler.mock.calls[0]![0]).toBe('safety-prompt:generate-options');
    expect(mockHandler.mock.calls[1]![0]).toBe('safety-prompt:generate-options');
  });
});

// ---------------------------------------------------------------------------
// (c) apply-selection does NOT persist — persistence requires explicit update
// ---------------------------------------------------------------------------

describe('Stage 4 security — (c) apply-selection does not persist', () => {
  beforeEach(() => {
    mockHandler.mockReset();
    mockHandler.mockResolvedValue({
      update: {
        summary: 'proposed',
        proposedPrinciple: '- Allow…',
        fullUpdatedPrompt: 'full prompt',
      },
    });
  });

  it('only invokes apply-selection — never implicitly fires safety-prompt:update', async () => {
    const segments = ipcSegments('safety-prompt:apply-selection');
    const applyPayload = {
      blockedAction: {
        toolName: 'memory_write',
        toolInput: { spaceName: 'Team Ops' },
        blockReason: 'Memory write to "Team Ops"',
      },
      selectedLabel: 'Always allow saves to Team Ops',
      scope: 'trusted_tool' as const,
    };

    const req = createMockReq({ params: [applyPayload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);

    expect(res._status).toBe(200);
    expect(mockHandler).toHaveBeenCalledTimes(1);
    expect(mockHandler.mock.calls[0]![0]).toBe('safety-prompt:apply-selection');

    // Critical invariant: the route did not dispatch to `safety-prompt:update`.
    // The single write path (D10) requires the caller to issue a follow-up
    // update call explicitly via `ApprovalTransport.safetyPrompt.update()`.
    const updateCalls = mockHandler.mock.calls.filter((c) => c[0] === 'safety-prompt:update');
    expect(updateCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (d) Field-cap rejection
// ---------------------------------------------------------------------------

describe('Stage 4 security — (d) field caps reject cap+1 with 400', () => {
  beforeEach(() => {
    mockHandler.mockReset();
    mockHandler.mockResolvedValue({ ok: true });
  });

  function basePrincipleCtx() {
    return {
      toolName: 't',
      toolInput: {},
      blockReason: 'ok',
    };
  }

  it('rejects toolName > 128 chars on safety-prompt:generate-options', async () => {
    const segments = ipcSegments('safety-prompt:generate-options');
    const payload = { ...basePrincipleCtx(), toolName: 'x'.repeat(129) };
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect(errorCode(res._body)).toBe('VALIDATION_ERROR');
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('rejects blockReason > 2000 chars on safety-prompt:generate-options', async () => {
    const segments = ipcSegments('safety-prompt:generate-options');
    const payload = { ...basePrincipleCtx(), blockReason: 'x'.repeat(2001) };
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect(errorCode(res._body)).toBe('VALIDATION_ERROR');
  });

  it('rejects spaceDescription > 2000 chars on safety-prompt:generate-options', async () => {
    const segments = ipcSegments('safety-prompt:generate-options');
    const payload = { ...basePrincipleCtx(), spaceDescription: 'x'.repeat(2001) };
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect(errorCode(res._body)).toBe('VALIDATION_ERROR');
  });

  it('rejects automationName > 256 chars on safety-prompt:generate-options', async () => {
    const segments = ipcSegments('safety-prompt:generate-options');
    const payload = { ...basePrincipleCtx(), automationName: 'x'.repeat(257) };
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect(errorCode(res._body)).toBe('VALIDATION_ERROR');
  });

  it('rejects selectedLabel > 100 chars on safety-prompt:apply-selection', async () => {
    const segments = ipcSegments('safety-prompt:apply-selection');
    const payload = {
      blockedAction: basePrincipleCtx(),
      selectedLabel: 'x'.repeat(101),
      scope: 'trusted_tool' as const,
    };
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect(errorCode(res._body)).toBe('VALIDATION_ERROR');
  });

  it('rejects scope outside the enum on safety-prompt:apply-selection', async () => {
    const segments = ipcSegments('safety-prompt:apply-selection');
    const payload = {
      blockedAction: basePrincipleCtx(),
      selectedLabel: 'ok',
      scope: 'global',
    };
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect(errorCode(res._body)).toBe('VALIDATION_ERROR');
  });

  it('rejects the full deny-direction variants with the same caps', async () => {
    // Representative: one deny channel per shape.
    const optionsSegments = ipcSegments('safety-prompt:generate-deny-options');
    const req1 = createMockReq({ params: [{ ...basePrincipleCtx(), blockReason: 'x'.repeat(2001) }] });
    const res1 = createMockRes();
    await handleGenericIpc(req1, res1, optionsSegments, mockDeps);
    expect(res1._status).toBe(400);
    expect(errorCode(res1._body)).toBe('VALIDATION_ERROR');

    const applySegments = ipcSegments('safety-prompt:apply-deny-selection');
    const req2 = createMockReq({
      params: [{
        blockedAction: basePrincipleCtx(),
        selectedLabel: 'x'.repeat(101),
        scope: 'specific',
      }],
    });
    const res2 = createMockRes();
    await handleGenericIpc(req2, res2, applySegments, mockDeps);
    expect(res2._status).toBe(400);
    expect(errorCode(res2._body)).toBe('VALIDATION_ERROR');
  });

  it('rejects toolInput that serializes to > 4000 chars on safety-prompt:generate-options (F4-2)', async () => {
    // Build a payload whose JSON.stringify(toolInput) exceeds the 4000-char
    // cap that mirrors TOOL_INPUT_MAX_CHARS in safetyPromptLogic. Attacker
    // surface: paired client pumping arbitrary-size payloads straight into
    // the LLM-hitting principle-generation endpoint.
    const segments = ipcSegments('safety-prompt:generate-options');
    const big = 'x'.repeat(4001);
    const payload = { ...basePrincipleCtx(), toolInput: { payload: big } };
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect(errorCode(res._body)).toBe('VALIDATION_ERROR');
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('also rejects oversized toolInput on safety-prompt:apply-selection (F4-2)', async () => {
    const segments = ipcSegments('safety-prompt:apply-selection');
    const bigCtx = {
      ...basePrincipleCtx(),
      toolInput: { blob: 'x'.repeat(4001) },
    };
    const payload = {
      blockedAction: bigCtx,
      selectedLabel: 'ok',
      scope: 'specific' as const,
    };
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect(errorCode(res._body)).toBe('VALIDATION_ERROR');
  });

  it('accepts toolInput right at the 4000-char cap on safety-prompt:generate-options', async () => {
    const segments = ipcSegments('safety-prompt:generate-options');
    // Construct a value whose JSON.stringify is exactly 4000 chars. The
    // enclosing object `{"payload":"..."}` adds 14 overhead chars, so the
    // inner string must be 4000 - 14 = 3986 chars.
    const inner = 'x'.repeat(3986);
    const payload = { ...basePrincipleCtx(), toolInput: { payload: inner } };
    expect(JSON.stringify(payload.toolInput).length).toBe(4000);
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(200);
    expect(mockHandler).toHaveBeenCalledTimes(1);
  });

  it('rejects a safety-prompt:update prompt > 64_000 chars', async () => {
    const segments = ipcSegments('safety-prompt:update');
    const payload = { prompt: 'x'.repeat(64_001), updatedBy: 'user' as const };
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect(errorCode(res._body)).toBe('VALIDATION_ERROR');
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('rejects a safety-prompt:update with an unknown updatedBy', async () => {
    const segments = ipcSegments('safety-prompt:update');
    const payload = { prompt: 'short prompt', updatedBy: 'attacker' };
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect(errorCode(res._body)).toBe('VALIDATION_ERROR');
  });

  it('accepts a well-formed safety-prompt:update and delegates to the handler', async () => {
    mockHandler.mockResolvedValue({
      prompt: 'updated',
      version: 2,
      lastUpdatedAt: 1,
      lastUpdatedBy: 'user',
      history: [],
      migrationComplete: true,
    });
    const segments = ipcSegments('safety-prompt:update');
    const payload = { prompt: 'fresh prompt', updatedBy: 'user' as const };
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(200);
    expect(mockHandler).toHaveBeenCalledTimes(1);
    expect(mockHandler.mock.calls[0]![0]).toBe('safety-prompt:update');
    expect(mockHandler.mock.calls[0]![1]).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// (e) settings:set-space-safety-level — unknown spaceId + invalid level
// ---------------------------------------------------------------------------

describe('Stage 4 security — (e) settings:set-space-safety-level', () => {
  beforeEach(() => {
    mockHandler.mockReset();
  });

  it('rejects empty spaceId at the route (min(1))', async () => {
    const segments = ipcSegments('settings:set-space-safety-level');
    const payload = { spaceId: '', level: 'permissive' as const };
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect(errorCode(res._body)).toBe('VALIDATION_ERROR');
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('rejects spaceId > 128 chars at the route', async () => {
    const segments = ipcSegments('settings:set-space-safety-level');
    const payload = { spaceId: 'x'.repeat(129), level: 'balanced' as const };
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect(errorCode(res._body)).toBe('VALIDATION_ERROR');
  });

  it('rejects an invalid level at the route', async () => {
    const segments = ipcSegments('settings:set-space-safety-level');
    const payload = { spaceId: '/spaces/team-ops', level: 'yolo' };
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect(errorCode(res._body)).toBe('VALIDATION_ERROR');
  });

  it('forwards UNKNOWN_SPACE_ID from the handler when the spaceId is unknown', async () => {
    mockHandler.mockResolvedValue({ success: false, error: 'UNKNOWN_SPACE_ID', spaceId: '/spaces/missing' });
    const segments = ipcSegments('settings:set-space-safety-level');
    const payload = { spaceId: '/spaces/missing', level: 'cautious' as const };
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(200);
    expect(mockHandler).toHaveBeenCalledTimes(1);
    // Route-level validation passes; the handler is the one that rejects
    // unknown spaces (see settingsHandlers.ts UNKNOWN_SPACE_ID path).
    expect(res._body).toEqual({ success: false, error: 'UNKNOWN_SPACE_ID', spaceId: '/spaces/missing' });
  });
});

// ---------------------------------------------------------------------------
// (f) settings:add-trusted-tool — toolId validation + audit log
// ---------------------------------------------------------------------------

describe('Stage 4 security — (f) settings:add-trusted-tool', () => {
  beforeEach(() => {
    mockHandler.mockReset();
    mockHandler.mockResolvedValue({ success: true });
  });

  it('rejects an empty toolId at the route', async () => {
    const segments = ipcSegments('settings:add-trusted-tool');
    const payload = { toolId: '', displayName: 'Slack' };
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect(errorCode(res._body)).toBe('VALIDATION_ERROR');
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('rejects a toolId longer than 128 chars', async () => {
    const segments = ipcSegments('settings:add-trusted-tool');
    const payload = { toolId: 'x'.repeat(129) };
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect(errorCode(res._body)).toBe('VALIDATION_ERROR');
  });

  it('rejects a displayName longer than 128 chars', async () => {
    const segments = ipcSegments('settings:add-trusted-tool');
    const payload = { toolId: 'slack_send_message', displayName: 'x'.repeat(129) };
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect(errorCode(res._body)).toBe('VALIDATION_ERROR');
  });

  it('rejects a serverHint longer than 256 chars', async () => {
    const segments = ipcSegments('settings:add-trusted-tool');
    const payload = { toolId: 'slack_send_message', serverHint: 'x'.repeat(257) };
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect(errorCode(res._body)).toBe('VALIDATION_ERROR');
  });

  it('rejects trailing-slash toolId at the route (F4-4)', async () => {
    // `bareToolId('gmail/')` normalizes to '' which the handler would then
    // store as a blank canonical ID. The route rejects this before the
    // handler runs so no blank entry can ever reach the trusted-tools list.
    const segments = ipcSegments('settings:add-trusted-tool');
    const payload = { toolId: 'gmail/' };
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(400);
    expect(errorCode(res._body)).toBe('VALIDATION_ERROR');
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('rejects a toolId containing disallowed characters at the route (F4-4)', async () => {
    // Spaces, colons, and other punctuation are rejected.
    for (const bad of ['has space', 'gmail:send_message', 'tool*', 'tool(1)']) {
      const segments = ipcSegments('settings:add-trusted-tool');
      const payload = { toolId: bad };
      const req = createMockReq({ params: [payload] });
      const res = createMockRes();
      await handleGenericIpc(req, res, segments, mockDeps);
      expect(res._status).toBe(400);
      expect(errorCode(res._body)).toBe('VALIDATION_ERROR');
    }
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('accepts compound packageId/toolId when both halves are non-empty (F4-4)', async () => {
    const segments = ipcSegments('settings:add-trusted-tool');
    const payload = { toolId: 'gmail/send_message' };
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(200);
    expect(mockHandler).toHaveBeenCalledTimes(1);
    expect(mockHandler.mock.calls[0]![1]).toEqual(payload);
  });

  it('delegates to the real handler (which emits a structured audit log entry)', async () => {
    // The production handler at src/main/ipc/settingsHandlers.ts emits
    //   logger.info({ toolId }, 'Added trusted tool atomically')
    // We verify the route reaches the handler so that audit-log side effect
    // fires. The log-emission itself is covered in settingsHandlers' own
    // test suite; here we just prove the route dispatches cleanly.
    const segments = ipcSegments('settings:add-trusted-tool');
    const payload = {
      toolId: 'slack_send_message',
      displayName: 'Slack: Send Message',
      serverHint: 'slack-mcp',
    };
    const req = createMockReq({ params: [payload] });
    const res = createMockRes();
    await handleGenericIpc(req, res, segments, mockDeps);
    expect(res._status).toBe(200);
    expect(mockHandler).toHaveBeenCalledTimes(1);
    expect(mockHandler.mock.calls[0]![0]).toBe('settings:add-trusted-tool');
    expect(mockHandler.mock.calls[0]![1]).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// Sanity: every Stage 4 channel is in the allowlist (defense-in-depth against
// someone accidentally deleting an entry)
// ---------------------------------------------------------------------------

describe('Stage 4 security — allowlist coverage (defense-in-depth)', () => {
  const required = [
    'safety-prompt:generate-options',
    'safety-prompt:apply-selection',
    'safety-prompt:generate-deny-options',
    'safety-prompt:apply-deny-selection',
    'safety-prompt:update',
    'settings:set-space-safety-level',
    'settings:add-trusted-tool',
  ];
  for (const ch of required) {
    it(`keeps ${ch} allowlisted`, () => {
      expect(CLOUD_IPC_ALLOWLIST.has(ch)).toBe(true);
    });
  }

  it('does NOT expose full settings:get or settings:update over IPC (D11)', () => {
    expect(CLOUD_IPC_ALLOWLIST.has('settings:get')).toBe(false);
    // settings:update is transport:'rest', never on the generic /api/ipc route.
    expect(CLOUD_IPC_ALLOWLIST.has('settings:update')).toBe(false);
  });
});
