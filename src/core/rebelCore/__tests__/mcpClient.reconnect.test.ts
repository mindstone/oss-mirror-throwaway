import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

const {
  mockConnect,
  mockListTools,
  mockCallTool,
  mockClose,
  mockTerminateSession,
  warnLog,
  infoLog,
  errorLog,
  debugLog,
} = vi.hoisted(() => ({
  mockConnect: vi.fn(),
  mockListTools: vi.fn(),
  mockCallTool: vi.fn(),
  mockClose: vi.fn(),
  mockTerminateSession: vi.fn(),
  warnLog: vi.fn(),
  infoLog: vi.fn(),
  errorLog: vi.fn(),
  debugLog: vi.fn(),
}));

 
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = mockConnect;
    listTools = mockListTools;
    callTool = mockCallTool;
    close = mockClose;
    constructor() {
      // no-op
    }
  },
}));

 
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    terminateSession = mockTerminateSession;
    constructor(_url: URL) {
      // no-op
    }
  },
}));

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: infoLog,
    warn: warnLog,
    error: errorLog,
    debug: debugLog,
  }),
}));

import { createMcpSession, isSessionNotFoundError } from '../mcpClient';

function makeSessionNotFoundError(): Error {
  const err = new Error('Streamable HTTP error: Error POSTing to endpoint: {"error":"Session not found"}');
  (err as Error & { code: number }).code = 404;
  return err;
}

function successResult(text: string) {
  return { content: [{ type: 'text', text }], isError: false };
}

describe('isSessionNotFoundError', () => {
  it('matches "Session not found" text', () => {
    expect(isSessionNotFoundError(new Error('Session not found'))).toBe(true);
  });

  it('matches session not found in StreamableHTTPError message', () => {
    expect(isSessionNotFoundError(makeSessionNotFoundError())).toBe(true);
  });

  it('matches case-insensitive session not found', () => {
    expect(isSessionNotFoundError(new Error('SESSION NOT FOUND'))).toBe(true);
  });

  it('matches MCP -32001 with session text (not timeout)', () => {
    expect(isSessionNotFoundError(new McpError(-32001, 'MCP session expired'))).toBe(true);
  });

  it('does not match timeout -32001', () => {
    expect(isSessionNotFoundError(new McpError(-32001, 'Request timed out'))).toBe(false);
  });

  it('does not match "timed out" with -32001', () => {
    expect(isSessionNotFoundError(new McpError(-32001, 'Operation timed out'))).toBe(false);
  });

  it('does not match generic errors', () => {
    expect(isSessionNotFoundError(new Error('Connection refused'))).toBe(false);
  });

  it('does not match unrelated MCP errors', () => {
    expect(isSessionNotFoundError(new McpError(-32003, 'Validation failed'))).toBe(false);
  });

  it('does not match non-session string', () => {
    expect(isSessionNotFoundError('some random error')).toBe(false);
  });
});

describe('mcpClient reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockConnect.mockReset();
    mockListTools.mockReset();
    mockCallTool.mockReset();
    mockClose.mockReset();
    mockTerminateSession.mockReset();
    warnLog.mockReset();
    infoLog.mockReset();
    errorLog.mockReset();
    debugLog.mockReset();

    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockTerminateSession.mockResolvedValue(undefined);
    // Default: listTools returns empty (skip tool comparison during reconnect)
    mockListTools.mockResolvedValue({ tools: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function createSession() {
    const session = await createMcpSession('http://127.0.0.1:3100/mcp');
    expect(session).not.toBeNull();
    return session!;
  }

  it('reconnects and retries on session-not-found error', async () => {
    const session = await createSession();

    // First call fails with session-not-found
    mockCallTool.mockRejectedValueOnce(makeSessionNotFoundError());
    // Retry succeeds
    mockCallTool.mockResolvedValueOnce(successResult('reconnected'));

    const result = await session.executeTool('list_tools', { query: 'hello' });

    expect(result.output).toBe('reconnected');
    expect(result.isError).toBe(false);
    // initial connect + reconnect
    expect(mockConnect).toHaveBeenCalledTimes(2);

    await session.close();
  });

  it('does not reconnect on non-pre-flight non-session-not-found errors', async () => {
    const session = await createSession();

    mockCallTool.mockRejectedValueOnce(new Error('Connection refused'));

    const result = await session.executeTool('test_tool', {});

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Connection refused');
    // Only initial connect — no reconnect attempted
    expect(mockConnect).toHaveBeenCalledTimes(1);

    await session.close();
  });

  it('reconnects on bare Error("Not connected") and retries the call', async () => {
    const session = await createSession();

    mockCallTool.mockRejectedValueOnce(new Error('Not connected'));
    mockCallTool.mockResolvedValueOnce(successResult('recovered after reconnect'));

    const result = await session.executeTool('search_tools', { query: 'calendar' });

    expect(result.isError).toBe(false);
    expect(result.output).toBe('recovered after reconnect');
    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(mockCallTool).toHaveBeenCalledTimes(2);

    await session.close();
  });

  it('retries non-read-only meta tools (rebel_mcp_authenticate, restart_package) on pre-flight transport disconnect, even without read-only annotations', async () => {
    const authSession = await createSession();

    mockCallTool.mockRejectedValueOnce(new Error('Not connected'));
    mockCallTool.mockResolvedValueOnce(successResult('auth started'));

    const authResult = await authSession.executeTool('rebel_mcp_authenticate', { serverId: 'Circleback' });

    expect(authResult.isError).toBe(false);
    expect(authResult.output).toBe('auth started');
    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(mockCallTool).toHaveBeenCalledTimes(2);

    await authSession.close();

    mockConnect.mockClear();
    mockCallTool.mockClear();
    mockTerminateSession.mockClear();
    mockClose.mockClear();

    const restartSession = await createSession();

    mockCallTool.mockRejectedValueOnce(new Error('Not connected'));
    mockCallTool.mockResolvedValueOnce(successResult('restart queued'));

    const restartResult = await restartSession.executeTool('restart_package', { package_id: 'RebelMcpConnectors' });

    expect(restartResult.isError).toBe(false);
    expect(restartResult.output).toBe('restart queued');
    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(mockCallTool).toHaveBeenCalledTimes(2);

    await restartSession.close();
  });

  it('does NOT auto-retry on McpError("Not connected", { code: -32xxx })', async () => {
    const session = await createSession();

    mockCallTool.mockRejectedValueOnce(new McpError(-32000, 'Not connected'));

    const result = await session.executeTool('search_tools', { query: 'calendar' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('MCP tool error [code=-32000]: Not connected');
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockCallTool).toHaveBeenCalledTimes(1);

    await session.close();
  });

  it('does NOT auto-retry on Error("Connection refused")', async () => {
    const session = await createSession();

    mockCallTool.mockRejectedValueOnce(new Error('Connection refused'));

    const result = await session.executeTool('search_tools', { query: 'calendar' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Connection refused');
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockCallTool).toHaveBeenCalledTimes(1);

    await session.close();
  });

  it('does NOT auto-retry on Error with extra properties or wrapped', async () => {
    const session = await createSession();

    const extraPropertyError = new Error('Not connected') as Error & { detail?: string };
    extraPropertyError.detail = 'transport wrapper metadata';
    const wrappedError = new Error('Wrapped: Not connected');

    mockCallTool
      .mockRejectedValueOnce(extraPropertyError)
      .mockRejectedValueOnce(wrappedError);

    const extraPropertyResult = await session.executeTool('search_tools', { query: 'calendar' });
    const wrappedResult = await session.executeTool('search_tools', { query: 'calendar' });

    expect(extraPropertyResult.isError).toBe(true);
    expect(extraPropertyResult.output).toContain('Not connected');
    expect(wrappedResult.isError).toBe(true);
    expect(wrappedResult.output).toContain('Wrapped: Not connected');
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockCallTool).toHaveBeenCalledTimes(2);

    await session.close();
  });

  it('does NOT auto-retry on Error subclass with message "Not connected"', async () => {
    const session = await createSession();

    class CustomTransportError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'CustomTransportError';
      }
    }
    const subclassError = new CustomTransportError('Not connected');

    mockCallTool.mockRejectedValueOnce(subclassError);

    const result = await session.executeTool('search_tools', { query: 'calendar' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Not connected');
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockCallTool).toHaveBeenCalledTimes(1);

    await session.close();
  });

  it('single-flights concurrent session-not-found reconnects', async () => {
    const session = await createSession();

    // All 3 parallel calls fail with session-not-found
    mockCallTool
      .mockRejectedValueOnce(makeSessionNotFoundError())
      .mockRejectedValueOnce(makeSessionNotFoundError())
      .mockRejectedValueOnce(makeSessionNotFoundError());

    // All 3 retries succeed
    mockCallTool
      .mockResolvedValueOnce(successResult('ok1'))
      .mockResolvedValueOnce(successResult('ok2'))
      .mockResolvedValueOnce(successResult('ok3'));

    const results = await Promise.all([
      session.executeTool('list_tools', {}),
      session.executeTool('search_tools', {}),
      session.executeTool('get_tool_details', {}),
    ]);

    expect(results.every(r => !r.isError)).toBe(true);
    expect(results.map(r => r.output)).toEqual(['ok1', 'ok2', 'ok3']);
    // initial + ONE reconnect (single-flight, not 3 reconnects)
    expect(mockConnect).toHaveBeenCalledTimes(2);

    await session.close();
  });

  it('returns error when reconnect fails (no infinite loop)', async () => {
    const session = await createSession();

    mockCallTool.mockRejectedValueOnce(makeSessionNotFoundError());
    // Reconnect connect() fails
    mockConnect.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await session.executeTool('test_tool', {});

    expect(result.isError).toBe(true);
    // initial connect + failed reconnect attempt
    expect(mockConnect).toHaveBeenCalledTimes(2);
    // No retry call — reconnect failed so tool call was not retried
    expect(mockCallTool).toHaveBeenCalledTimes(1);
    // Error log emitted for reconnect failure
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'ECONNREFUSED' }),
      'MCP reconnect failed',
    );

    await session.close();
  });

  it('skips reconnect when generation already advanced (another caller reconnected)', async () => {
    const session = await createSession();

    // Use a deferred promise for reconnect to control timing
    let resolveReconnect!: () => void;
    const reconnectPromise = new Promise<void>(r => { resolveReconnect = r; });

    // First parallel call triggers slow reconnect
    mockCallTool
      .mockRejectedValueOnce(makeSessionNotFoundError())
      .mockRejectedValueOnce(makeSessionNotFoundError());

    mockConnect
      .mockImplementationOnce(() => reconnectPromise); // slow reconnect

    // Retries succeed
    mockCallTool
      .mockResolvedValueOnce(successResult('ok1'))
      .mockResolvedValueOnce(successResult('ok2'));

    const p1 = session.executeTool('list_tools', {});
    const p2 = session.executeTool('search_tools', {});

    // Let both calls detect session-not-found and enter reconnect
    await vi.advanceTimersByTimeAsync(1);

    // Complete the reconnect
    resolveReconnect();

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.isError).toBe(false);
    expect(r2.isError).toBe(false);
    // Only ONE reconnect (second caller joined the in-flight promise)
    expect(mockConnect).toHaveBeenCalledTimes(2); // initial + single reconnect
    // Debug log should show the second caller joined
    expect(debugLog).toHaveBeenCalledWith(
      expect.objectContaining({ callerGeneration: 0, generation: 0 }),
      'Joining existing MCP reconnect',
    );

    await session.close();
  });

  it('normal tool calls have no reconnect overhead', async () => {
    const session = await createSession();

    mockCallTool.mockResolvedValueOnce(successResult('normal result'));

    const result = await session.executeTool('test_tool', { query: 'hello' });

    expect(result.output).toBe('normal result');
    expect(result.isError).toBe(false);
    expect(mockConnect).toHaveBeenCalledTimes(1); // only initial, no reconnect
    // No warn/error logs
    expect(warnLog).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();

    await session.close();
  });

  it('logs tool list drift after reconnect when initial tools were captured', async () => {
    const session = await createSession();

    // First listTools() call captures initial tool set
    mockListTools.mockResolvedValueOnce({
      tools: [
        { name: 'tool_a', description: 'A', inputSchema: { type: 'object', properties: {} } },
        { name: 'tool_b', description: 'B', inputSchema: { type: 'object', properties: {} } },
      ],
    });
    await session.listTools();

    // Now during reconnect, listTools returns a different set
    mockListTools.mockResolvedValueOnce({
      tools: [
        { name: 'tool_a', description: 'A', inputSchema: { type: 'object', properties: {} } },
        { name: 'tool_c', description: 'C', inputSchema: { type: 'object', properties: {} } },
      ],
    });

    mockCallTool.mockRejectedValueOnce(makeSessionNotFoundError());
    mockCallTool.mockResolvedValueOnce(successResult('ok'));

    await session.executeTool('list_tool_packages', {});

    expect(warnLog).toHaveBeenCalledWith(
      expect.objectContaining({
        added: ['tool_c'],
        removed: ['tool_b'],
        generation: 1,
      }),
      'MCP tool list changed after reconnect',
    );

    await session.close();
  });

  it('retries only once — does not infinite loop on persistent session-not-found', async () => {
    const session = await createSession();

    // First call fails with session-not-found
    mockCallTool.mockRejectedValueOnce(makeSessionNotFoundError());
    // Retry also fails with session-not-found (session is still dead)
    mockCallTool.mockRejectedValueOnce(makeSessionNotFoundError());

    const result = await session.executeTool('list_tools', {});

    expect(result.isError).toBe(true);
    // 2 connects: initial + 1 reconnect. The retry failure does NOT trigger another reconnect.
    expect(mockConnect).toHaveBeenCalledTimes(2);
    // 2 callTool: original + 1 retry
    expect(mockCallTool).toHaveBeenCalledTimes(2);

    await session.close();
  });

  it('preserves error handling behavior for non-reconnect errors', async () => {
    const session = await createSession();

    mockCallTool.mockRejectedValueOnce(
      new McpError(-32003, 'Missing required: query', { repair_ticket: { missing_required: ['query'] } }),
    );

    const result = await session.executeTool('search', {});

    expect(result.isError).toBe(true);
    expect(result.output).toContain('MCP tool error [code=-32003]');
    expect(result.output).toContain('Missing required: query');
    // No reconnect attempted
    expect(mockConnect).toHaveBeenCalledTimes(1);

    await session.close();
  });

  it('defers old client/transport cleanup after reconnect', async () => {
    const session = await createSession();

    mockCallTool.mockRejectedValueOnce(makeSessionNotFoundError());
    mockCallTool.mockResolvedValueOnce(successResult('ok'));

    await session.executeTool('health_check', {});

    // Old transport cleanup is deferred via setTimeout
    expect(mockTerminateSession).not.toHaveBeenCalled();
    expect(mockClose).not.toHaveBeenCalled();

    // Advance past the cleanup delay
    await vi.advanceTimersByTimeAsync(2500);

    // Now old transport/client should be cleaned up
    expect(mockTerminateSession).toHaveBeenCalledTimes(1);
    expect(mockClose).toHaveBeenCalledTimes(1);

    await session.close();
  });

  it('retries read-only meta-tool after reconnect', async () => {
    const session = await createSession();

    mockCallTool.mockRejectedValueOnce(makeSessionNotFoundError());
    mockCallTool.mockResolvedValueOnce(successResult('tools listed'));

    const result = await session.executeTool('search_tools', { query: 'email' });

    expect(result.output).toBe('tools listed');
    expect(result.isError).toBe(false);
    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(infoLog).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'search_tools', retryDecision: 'retry' }),
      'MCP reconnect: retrying read-only meta-tool',
    );

    await session.close();
  });

  it('skips retry for use_tool without cached annotations after reconnect', async () => {
    const session = await createSession();

    mockCallTool.mockRejectedValueOnce(makeSessionNotFoundError());

    const result = await session.executeTool('use_tool', { package_id: 'Slack', tool_id: 'send_message' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Tool connection was lost during execution of Slack/send_message');
    // Reconnect happens but retry is skipped
    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(mockCallTool).toHaveBeenCalledTimes(1); // original only, no retry
    expect(warnLog).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'use_tool', packageId: 'Slack', toolId: 'send_message', hasAnnotation: false, retryDecision: 'skip' }),
      'MCP reconnect: skipping retry for use_tool without safe connector annotation',
    );

    await session.close();
  });

  it('skips retry for authenticate after reconnect', async () => {
    const session = await createSession();

    mockCallTool.mockRejectedValueOnce(makeSessionNotFoundError());

    const result = await session.executeTool('authenticate', { package_id: 'Slack' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Tool connection was lost during execution');
    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(mockCallTool).toHaveBeenCalledTimes(1);

    await session.close();
  });

  it('advisory error message includes verification guidance for non-read-only meta-tool', async () => {
    const session = await createSession();

    mockCallTool.mockRejectedValueOnce(makeSessionNotFoundError());

    const result = await session.executeTool('restart_package', { package_id: 'Slack' });

    expect(result.isError).toBe(true);
    expect(result.output).toBe(
      'Tool connection was lost during execution. This action may have already been performed — please verify the current state before retrying manually.',
    );

    await session.close();
  });

  // --- Connector annotation cache tests (C2b) ---

  function useToolResult(packageId: string, toolId: string, annotations?: Record<string, boolean>) {
    const output: Record<string, unknown> = {
      package_id: packageId,
      tool_id: toolId,
      args_used: {},
      result: { data: 'ok' },
      telemetry: { duration_ms: 100, status: 'ok' },
    };
    if (annotations) {
      output.annotations = annotations;
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(output) }],
      isError: false,
    };
  }

  it('use_tool with cached readOnlyHint retries after reconnect', async () => {
    const session = await createSession();

    // First call succeeds — populates annotation cache with readOnlyHint: true
    mockCallTool.mockResolvedValueOnce(
      useToolResult('Slack-user', 'list_channels', { readOnlyHint: true }),
    );
    await session.executeTool('use_tool', { package_id: 'Slack-user', tool_id: 'list_channels' });

    // Second call fails with session-not-found
    mockCallTool.mockRejectedValueOnce(makeSessionNotFoundError());
    // Retry succeeds after reconnect
    mockCallTool.mockResolvedValueOnce(
      useToolResult('Slack-user', 'list_channels', { readOnlyHint: true }),
    );

    const result = await session.executeTool('use_tool', { package_id: 'Slack-user', tool_id: 'list_channels' });

    expect(result.isError).toBe(false);
    // 3 callTool calls: success + fail + retry
    expect(mockCallTool).toHaveBeenCalledTimes(3);
    expect(infoLog).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'use_tool', packageId: 'Slack-user', toolId: 'list_channels', retryDecision: 'retry' }),
      'MCP reconnect: retrying use_tool with safe connector annotation',
    );

    await session.close();
  });

  it('use_tool with cached idempotentHint retries after reconnect', async () => {
    const session = await createSession();

    // First call succeeds — populates annotation cache with idempotentHint: true
    mockCallTool.mockResolvedValueOnce(
      useToolResult('Slack-user', 'set_status', { idempotentHint: true }),
    );
    await session.executeTool('use_tool', { package_id: 'Slack-user', tool_id: 'set_status' });

    // Second call fails with session-not-found
    mockCallTool.mockRejectedValueOnce(makeSessionNotFoundError());
    // Retry succeeds
    mockCallTool.mockResolvedValueOnce(
      useToolResult('Slack-user', 'set_status', { idempotentHint: true }),
    );

    const result = await session.executeTool('use_tool', { package_id: 'Slack-user', tool_id: 'set_status' });

    expect(result.isError).toBe(false);
    expect(mockCallTool).toHaveBeenCalledTimes(3);

    await session.close();
  });

  it('use_tool without cached annotations returns advisory error', async () => {
    const session = await createSession();

    // First call succeeds WITHOUT annotations
    mockCallTool.mockResolvedValueOnce(
      useToolResult('Slack-user', 'send_message'),
    );
    await session.executeTool('use_tool', { package_id: 'Slack-user', tool_id: 'send_message' });

    // Second call fails with session-not-found
    mockCallTool.mockRejectedValueOnce(makeSessionNotFoundError());

    const result = await session.executeTool('use_tool', { package_id: 'Slack-user', tool_id: 'send_message' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Slack-user/send_message');
    expect(result.output).toContain('verify the current state');
    // 2 callTool calls: success + fail (no retry)
    expect(mockCallTool).toHaveBeenCalledTimes(2);

    await session.close();
  });

  it('use_tool with destructiveHint true does not retry', async () => {
    const session = await createSession();

    // First call succeeds with idempotentHint: true BUT destructiveHint: true
    mockCallTool.mockResolvedValueOnce(
      useToolResult('Slack-user', 'delete_channel', { idempotentHint: true, destructiveHint: true }),
    );
    await session.executeTool('use_tool', { package_id: 'Slack-user', tool_id: 'delete_channel' });

    // Second call fails with session-not-found
    mockCallTool.mockRejectedValueOnce(makeSessionNotFoundError());

    const result = await session.executeTool('use_tool', { package_id: 'Slack-user', tool_id: 'delete_channel' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Slack-user/delete_channel');
    // destructiveHint overrides idempotentHint — no retry
    expect(mockCallTool).toHaveBeenCalledTimes(2);

    await session.close();
  });

  it('use_tool caches annotations from truncated response with continuation hint suffix', async () => {
    const session = await createSession();

    // Simulate Super-MCP appending continuation hint after JSON
    const jsonOutput = JSON.stringify({
      package_id: 'Slack-user',
      tool_id: 'search_messages',
      args_used: {},
      result: { data: 'truncated' },
      telemetry: { duration_ms: 100, status: 'ok', output_truncated: true },
      annotations: { readOnlyHint: true },
    });
    const textWithSuffix = jsonOutput + '\n\n[To retrieve the full untruncated result: use_tool({ package_id: "Slack-user", tool_id: "search_messages", args: {}, result_id: "abc", output_offset: 0 })]';

    mockCallTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: textWithSuffix }],
      isError: false,
    });
    await session.executeTool('use_tool', { package_id: 'Slack-user', tool_id: 'search_messages' });

    // Second call fails with session-not-found — should still retry (cache was populated)
    mockCallTool.mockRejectedValueOnce(makeSessionNotFoundError());
    mockCallTool.mockResolvedValueOnce(
      useToolResult('Slack-user', 'search_messages', { readOnlyHint: true }),
    );

    const result = await session.executeTool('use_tool', { package_id: 'Slack-user', tool_id: 'search_messages' });

    expect(result.isError).toBe(false);
    expect(mockCallTool).toHaveBeenCalledTimes(3);

    await session.close();
  });

  it('use_tool first-call gap is fail-closed (no cached annotation)', async () => {
    const session = await createSession();

    // NO previous successful call — cache is empty
    // First call fails with session-not-found
    mockCallTool.mockRejectedValueOnce(makeSessionNotFoundError());

    const result = await session.executeTool('use_tool', { package_id: 'Slack-user', tool_id: 'list_channels' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Slack-user/list_channels');
    // Only 1 callTool call — no retry (fail-closed)
    expect(mockCallTool).toHaveBeenCalledTimes(1);
    expect(warnLog).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'use_tool', hasAnnotation: false, retryDecision: 'skip' }),
      'MCP reconnect: skipping retry for use_tool without safe connector annotation',
    );

    await session.close();
  });

  // --- Stage 5: downstream transport auto-reconnect (-33007) ---

  describe('downstream transport auto-reconnect (-33007)', () => {
    function structuredDownstreamError(): { code: number; message: string } {
      return { code: -33007, message: 'MCP error -32000: Connection closed' };
    }

    // Index in the mockCallTool sequence of the restart_package call. After a
    // successful seeding use_tool (call 0) and the failing use_tool (call 1),
    // the recovery path issues restart_package (call 2) then the retry (call 3).
    function expectRestartPackageCalled(packageId: string, restartCallIndex: number) {
      const call = mockCallTool.mock.calls[restartCallIndex];
      expect(call).toBeDefined();
      expect(call[0]).toEqual({ name: 'restart_package', arguments: { package_id: packageId } });
    }

    it('idempotent (readOnlyHint) → one restart_package then one retry, recovers silently', async () => {
      const onMcpError = vi.fn();
      const session = await createMcpSession('http://127.0.0.1:3100/mcp', { onMcpError });
      expect(session).not.toBeNull();

      // Seed annotations via a prior successful use_tool.
      mockCallTool.mockResolvedValueOnce(
        useToolResult('Brave-search', 'web_search', { readOnlyHint: true }),
      );
      await session!.executeTool('use_tool', { package_id: 'Brave-search', tool_id: 'web_search' });

      // Failing call → -33007, then restart_package resolves, then retry resolves.
      mockCallTool.mockRejectedValueOnce(structuredDownstreamError());
      mockCallTool.mockResolvedValueOnce(successResult('restart queued')); // restart_package
      mockCallTool.mockResolvedValueOnce(
        useToolResult('Brave-search', 'web_search', { readOnlyHint: true }),
      ); // retry

      const result = await session!.executeTool('use_tool', { package_id: 'Brave-search', tool_id: 'web_search' });

      expect(result.isError).toBe(false);
      // seed + fail + restart_package + retry = 4
      expect(mockCallTool).toHaveBeenCalledTimes(4);
      expectRestartPackageCalled('Brave-search', 2);
      // EXACTLY one restart_package call total.
      const restartCalls = mockCallTool.mock.calls.filter(c => (c[0] as { name: string }).name === 'restart_package');
      expect(restartCalls).toHaveLength(1);
      // Recovered call did NOT fire onMcpError.
      expect(onMcpError).not.toHaveBeenCalled();
      expect(infoLog).toHaveBeenCalledWith(
        expect.objectContaining({ retryReason: 'downstream_transport_closed', forcedRestart: true }),
        'MCP connector reconnect: forcing restart_package before single retry',
      );

      await session!.close();
    });

    it('idempotentHint (not readOnly) → also retries', async () => {
      const session = await createSession();

      mockCallTool.mockResolvedValueOnce(
        useToolResult('Notion', 'upsert_block', { idempotentHint: true }),
      );
      await session.executeTool('use_tool', { package_id: 'Notion', tool_id: 'upsert_block' });

      mockCallTool.mockRejectedValueOnce(structuredDownstreamError());
      mockCallTool.mockResolvedValueOnce(successResult('restart queued'));
      mockCallTool.mockResolvedValueOnce(
        useToolResult('Notion', 'upsert_block', { idempotentHint: true }),
      );

      const result = await session.executeTool('use_tool', { package_id: 'Notion', tool_id: 'upsert_block' });

      expect(result.isError).toBe(false);
      expect(mockCallTool).toHaveBeenCalledTimes(4);
      expectRestartPackageCalled('Notion', 2);

      await session.close();
    });

    it('destructive (destructiveHint true) → ZERO restart, ZERO retry, honest failure', async () => {
      const session = await createSession();

      mockCallTool.mockResolvedValueOnce(
        useToolResult('Slack-user', 'delete_message', { idempotentHint: true, destructiveHint: true }),
      );
      await session.executeTool('use_tool', { package_id: 'Slack-user', tool_id: 'delete_message' });

      mockCallTool.mockRejectedValueOnce(structuredDownstreamError());

      const result = await session.executeTool('use_tool', { package_id: 'Slack-user', tool_id: 'delete_message' });

      expect(result.isError).toBe(true);
      // seed + fail only — no restart, no retry
      expect(mockCallTool).toHaveBeenCalledTimes(2);
      expect(warnLog).toHaveBeenCalledWith(
        expect.objectContaining({ retryReason: 'downstream_transport_closed', skipReason: 'destructive' }),
        'MCP connector reconnect: skipping retry — connector not safe to re-run',
      );

      await session.close();
    });

    it('non-idempotent (no safe hints) → ZERO restart, ZERO retry, honest failure', async () => {
      const session = await createSession();

      mockCallTool.mockResolvedValueOnce(
        useToolResult('Slack-user', 'send_message', { readOnlyHint: false, idempotentHint: false }),
      );
      await session.executeTool('use_tool', { package_id: 'Slack-user', tool_id: 'send_message' });

      mockCallTool.mockRejectedValueOnce(structuredDownstreamError());

      const result = await session.executeTool('use_tool', { package_id: 'Slack-user', tool_id: 'send_message' });

      expect(result.isError).toBe(true);
      expect(mockCallTool).toHaveBeenCalledTimes(2);
      expect(warnLog).toHaveBeenCalledWith(
        expect.objectContaining({ retryReason: 'downstream_transport_closed', skipReason: 'not-idempotent' }),
        'MCP connector reconnect: skipping retry — connector not safe to re-run',
      );

      await session.close();
    });

    it('unknown annotations (cache empty) → ZERO retry (fail-safe)', async () => {
      const session = await createSession();

      // No seeding call — cache empty.
      mockCallTool.mockRejectedValueOnce(structuredDownstreamError());

      const result = await session.executeTool('use_tool', { package_id: 'Brave-search', tool_id: 'web_search' });

      expect(result.isError).toBe(true);
      // Only the failing call — no restart, no retry.
      expect(mockCallTool).toHaveBeenCalledTimes(1);
      expect(warnLog).toHaveBeenCalledWith(
        expect.objectContaining({ retryReason: 'downstream_transport_closed', skipReason: 'no-annotation' }),
        'MCP connector reconnect: skipping retry — connector not safe to re-run',
      );

      await session.close();
    });

    it('retry also throws -33007 → one restart + one retry, honest failure, onMcpError fired once', async () => {
      const onMcpError = vi.fn();
      const session = await createMcpSession('http://127.0.0.1:3100/mcp', { onMcpError });
      expect(session).not.toBeNull();

      mockCallTool.mockResolvedValueOnce(
        useToolResult('Brave-search', 'web_search', { readOnlyHint: true }),
      );
      await session!.executeTool('use_tool', { package_id: 'Brave-search', tool_id: 'web_search' });

      mockCallTool.mockRejectedValueOnce(structuredDownstreamError()); // fail
      mockCallTool.mockResolvedValueOnce(successResult('restart queued')); // restart_package
      mockCallTool.mockRejectedValueOnce(structuredDownstreamError()); // retry also fails

      const result = await session!.executeTool('use_tool', { package_id: 'Brave-search', tool_id: 'web_search' });

      expect(result.isError).toBe(true);
      // seed + fail + restart + retry = 4. No second retry / loop.
      expect(mockCallTool).toHaveBeenCalledTimes(4);
      expectRestartPackageCalled('Brave-search', 2);
      // Failed retry surfaces via handleToolCallError → onMcpError exactly once.
      expect(onMcpError).toHaveBeenCalledTimes(1);

      await session!.close();
    });

    it('restart_package throws → no tool retry, honest failure', async () => {
      const session = await createSession();

      mockCallTool.mockResolvedValueOnce(
        useToolResult('Brave-search', 'web_search', { readOnlyHint: true }),
      );
      await session.executeTool('use_tool', { package_id: 'Brave-search', tool_id: 'web_search' });

      mockCallTool.mockRejectedValueOnce(structuredDownstreamError()); // fail
      mockCallTool.mockRejectedValueOnce(new Error('restart_package boom')); // restart fails

      const result = await session.executeTool('use_tool', { package_id: 'Brave-search', tool_id: 'web_search' });

      expect(result.isError).toBe(true);
      // seed + fail + restart(failed) — NO tool retry against a still-dead handle.
      expect(mockCallTool).toHaveBeenCalledTimes(3);
      expectRestartPackageCalled('Brave-search', 2);
      expect(warnLog).toHaveBeenCalledWith(
        expect.objectContaining({ retryReason: 'downstream_transport_closed' }),
        'MCP connector reconnect: restart_package failed — not retrying',
      );

      await session.close();
    });

    it('restart_package returns isError:true (no throw) → no tool retry, honest failure, onMcpError fired once', async () => {
      const onMcpError = vi.fn();
      const session = await createMcpSession('http://127.0.0.1:3100/mcp', { onMcpError });
      expect(session).not.toBeNull();

      mockCallTool.mockResolvedValueOnce(
        useToolResult('Brave-search', 'web_search', { readOnlyHint: true }),
      );
      await session!.executeTool('use_tool', { package_id: 'Brave-search', tool_id: 'web_search' });

      mockCallTool.mockRejectedValueOnce(structuredDownstreamError()); // fail
      // restart_package RESOLVES (does not throw) with an isError result.
      mockCallTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'package not found' }],
        isError: true,
      });

      const result = await session!.executeTool('use_tool', { package_id: 'Brave-search', tool_id: 'web_search' });

      expect(result.isError).toBe(true);
      // seed + fail + restart(isError) — NO 2.5s-delayed tool retry against a still-dead handle.
      expect(mockCallTool).toHaveBeenCalledTimes(3);
      expectRestartPackageCalled('Brave-search', 2);
      expect(warnLog).toHaveBeenCalledWith(
        expect.objectContaining({ retryReason: 'downstream_transport_closed' }),
        'MCP connector reconnect: restart_package failed — not retrying',
      );
      // Original -33007 surfaces via handleToolCallError → onMcpError exactly once.
      expect(onMcpError).toHaveBeenCalledTimes(1);

      await session!.close();
    });

    it('cancel during delay → no retry use_tool issued, settles without hanging', async () => {
      const session = await createSession();
      const controller = new AbortController();

      mockCallTool.mockResolvedValueOnce(
        useToolResult('Brave-search', 'web_search', { readOnlyHint: true }),
      );
      await session.executeTool('use_tool', { package_id: 'Brave-search', tool_id: 'web_search' });

      mockCallTool.mockRejectedValueOnce(structuredDownstreamError()); // fail
      // restart_package resolves AND aborts the signal so the delay is cancelled.
      mockCallTool.mockImplementationOnce(async () => {
        controller.abort();
        return successResult('restart queued');
      });

      const result = await session.executeTool(
        'use_tool',
        { package_id: 'Brave-search', tool_id: 'web_search' },
        undefined,
        controller.signal,
      );

      expect(result.isError).toBe(true);
      // seed + fail + restart only — abort cancels the retry.
      expect(mockCallTool).toHaveBeenCalledTimes(3);
      expectRestartPackageCalled('Brave-search', 2);
      expect(infoLog).toHaveBeenCalledWith(
        expect.objectContaining({ retryReason: 'downstream_transport_closed' }),
        'MCP connector reconnect: aborted during delay — not retrying',
      );

      await session.close();
    });
  });
});
