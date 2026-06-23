import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type { McpErrorInfo } from '../types';

// We capture the most-recently-assigned `client.onerror` so tests can invoke
// it synchronously to simulate a transport severance event.
const capturedOnError: { fn?: (err: unknown) => void } = {};

const {
  mockConnect,
  mockListTools,
  mockCallTool,
  mockClose,
  mockTerminateSession,
  warnLog,
  infoLog,
  debugLog,
} = vi.hoisted(() => ({
  mockConnect: vi.fn(),
  mockListTools: vi.fn(),
  mockCallTool: vi.fn(),
  mockClose: vi.fn(),
  mockTerminateSession: vi.fn(),
  warnLog: vi.fn(),
  infoLog: vi.fn(),
  debugLog: vi.fn(),
}));

 
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  class MockClient {
    connect = mockConnect;
    listTools = mockListTools;
    callTool = mockCallTool;
    close = mockClose;
    _onerror?: (err: unknown) => void;
    set onerror(fn: (err: unknown) => void) {
      this._onerror = fn;
      capturedOnError.fn = fn;
    }
    get onerror(): ((err: unknown) => void) | undefined {
      return this._onerror;
    }
  }
  return { Client: MockClient };
});

 
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    sessionId = 'mock-session-abc123';
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
    error: vi.fn(),
    debug: debugLog,
  }),
}));

import { createMcpSession } from '../mcpClient';

function makeMidFlightConnectionClosedError(): McpError {
  return new McpError(-32000, 'Connection closed');
}

beforeEach(() => {
  mockConnect.mockReset();
  mockListTools.mockReset();
  mockCallTool.mockReset();
  mockClose.mockReset();
  mockTerminateSession.mockReset();
  warnLog.mockReset();
  infoLog.mockReset();
  debugLog.mockReset();
  capturedOnError.fn = undefined;

  mockConnect.mockResolvedValue(undefined);
  mockClose.mockResolvedValue(undefined);
  mockTerminateSession.mockResolvedValue(undefined);
});

describe('createMcpSession — transport severance snapshot', () => {
  it('records a non-fatal severance snapshot when client.onerror fires', async () => {
    const onMcpError = vi.fn<(info: McpErrorInfo) => void>();
    const session = await createMcpSession('http://127.0.0.1:3100/mcp', { onMcpError });
    expect(session).not.toBeNull();
    expect(capturedOnError.fn).toBeDefined();

    // Simulate an unrelated transport error (does NOT trigger fail-closed)
    capturedOnError.fn!(new Error('Streamable HTTP error: ECONNRESET'));

    // Now fire a tool error to surface the snapshot in McpErrorInfo
    mockCallTool.mockRejectedValueOnce(makeMidFlightConnectionClosedError());
    await session!.executeTool('test_tool', {});

    expect(onMcpError).toHaveBeenCalledTimes(1);
    const info = onMcpError.mock.calls[0]![0];
    expect(info.errorKind).toBe('transport_connection_closed');
    expect(info.lastTransportSeverance).toBeDefined();
    expect(info.lastTransportSeverance!.forcedClose).toBe(false);
    expect(info.lastTransportSeverance!.reason).toContain('ECONNRESET');
    expect(info.lastTransportSeverance!.errName).toBe('Error');
    expect(info.lastTransportSeverance!.sessionGenerationAtSeverance).toBe(0);
    expect(typeof info.lastTransportSeverance!.connectionAgeMsAtSeverance).toBe('number');

    await session!.close();
  });

  it('records a fatal severance snapshot (forcedClose=true) and still fires the fail-closed client.close()', async () => {
    const onMcpError = vi.fn<(info: McpErrorInfo) => void>();
    const session = await createMcpSession('http://127.0.0.1:3100/mcp', { onMcpError });
    expect(session).not.toBeNull();

    // Snapshot mockClose call count BEFORE the severance — session creation
    // itself may have called close() (deferred old-client cleanup), so we
    // measure delta rather than absolute count.
    const closeCallsBefore = mockClose.mock.calls.length;

    capturedOnError.fn!(new Error('SSE stream disconnected: server forced close'));

    // The fail-closed `void client.close()` runs synchronously after the
    // onSeverance callback — must be observable immediately.
    expect(mockClose.mock.calls.length).toBeGreaterThan(closeCallsBefore);

    mockCallTool.mockRejectedValueOnce(makeMidFlightConnectionClosedError());
    await session!.executeTool('test_tool', {});

    const info = onMcpError.mock.calls[0]![0];
    expect(info.lastTransportSeverance).toBeDefined();
    expect(info.lastTransportSeverance!.forcedClose).toBe(true);
    expect(info.lastTransportSeverance!.reason).toContain('SSE stream disconnected');

    await session!.close();
  });

  it('reports no severance when transport never errored', async () => {
    const onMcpError = vi.fn<(info: McpErrorInfo) => void>();
    const session = await createMcpSession('http://127.0.0.1:3100/mcp', { onMcpError });

    mockCallTool.mockRejectedValueOnce(makeMidFlightConnectionClosedError());
    await session!.executeTool('test_tool', {});

    const info = onMcpError.mock.calls[0]![0];
    expect(info.lastTransportSeverance).toBeUndefined();
    expect(info.errorKind).toBe('transport_connection_closed');
    expect(info.connectionAgeMs).toBeGreaterThanOrEqual(0);

    await session!.close();
  });

  it('truncates a very long severance reason to 200 chars', async () => {
    const onMcpError = vi.fn<(info: McpErrorInfo) => void>();
    const session = await createMcpSession('http://127.0.0.1:3100/mcp', { onMcpError });

    const longMsg = 'x'.repeat(500);
    capturedOnError.fn!(new Error(longMsg));

    mockCallTool.mockRejectedValueOnce(makeMidFlightConnectionClosedError());
    await session!.executeTool('test_tool', {});

    const info = onMcpError.mock.calls[0]![0];
    expect(info.lastTransportSeverance!.reason.length).toBe(200);

    await session!.close();
  });

  it('observer callback errors do not break the SDK error path', async () => {
    const onMcpError = vi.fn<(info: McpErrorInfo) => void>();
    const session = await createMcpSession('http://127.0.0.1:3100/mcp', { onMcpError });

    // The onerror handler should swallow any internal observer error.
    // Even if recordSeverance throws (e.g. on a pathological Error subclass),
    // the SDK's existing fail-closed path must still run for forced-close cases.
    // We test the broader invariant: calling onerror with a normal error
    // does not throw to the caller.
    expect(() => {
      capturedOnError.fn!(new Error('benign transport error'));
    }).not.toThrow();

    await session!.close();
  });

  it('snapshot includes the post-reconnect generation when severance happens after reconnect', async () => {
    const onMcpError = vi.fn<(info: McpErrorInfo) => void>();
    const session = await createMcpSession('http://127.0.0.1:3100/mcp', { onMcpError });

    // Trigger reconnect via session_not_found path. Generation will advance to 1.
    // We only queue ONE rejection because test_tool is not retried after reconnect
    // (it's not a read-only meta-tool), so the second call would consume a
    // leftover mock and break the next assertion.
    mockCallTool.mockRejectedValueOnce(new Error('MCP error -32000: session not found'));
    mockListTools.mockResolvedValue({ tools: [] });
    await session!.executeTool('test_tool', {});

    // Now fire severance on the new (post-reconnect) client. The mock's onerror
    // setter captures the most recent assignment, so `capturedOnError.fn` now
    // points to the new client's handler.
    capturedOnError.fn!(new Error('Streamable HTTP error: stream ended'));

    mockCallTool.mockRejectedValueOnce(makeMidFlightConnectionClosedError());
    await session!.executeTool('test_tool', {});

    const lastCall = onMcpError.mock.calls.at(-1)!;
    const info = lastCall[0];
    expect(info.lastTransportSeverance).toBeDefined();
    expect(info.lastTransportSeverance!.sessionGenerationAtSeverance).toBe(1);
    expect(info.sessionGeneration).toBe(1);

    await session!.close();
  });

  it('does not report onMcpError when bare pre-flight Not connected recovers successfully', async () => {
    const onMcpError = vi.fn<(info: McpErrorInfo) => void>();
    const session = await createMcpSession('http://127.0.0.1:3100/mcp', { onMcpError });

    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockRejectedValueOnce(new Error('Not connected'));
    mockCallTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'recovered' }], isError: false });

    const result = await session!.executeTool('search_tools', {});

    expect(result.isError).toBe(false);
    expect(result.output).toBe('recovered');
    expect(onMcpError).not.toHaveBeenCalled();
    expect(mockConnect).toHaveBeenCalledTimes(2);

    await session!.close();
  });
});
