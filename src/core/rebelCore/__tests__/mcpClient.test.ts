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
    error: vi.fn(),
    debug: debugLog,
  }),
}));

import { createMcpSession, isModelVisibleMcpTool, processCallToolResult } from '../mcpClient';

async function createSession(opts?: { getLatestUrl?: () => string | null; sessionId?: string }) {
  const session = await createMcpSession('http://127.0.0.1:3100/mcp', opts);
  expect(session).not.toBeNull();
  return session!;
}

class StreamableHTTPError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'StreamableHTTPError';
  }
}

describe('mcpClient error handling', () => {
  beforeEach(() => {
    mockConnect.mockReset();
    mockListTools.mockReset();
    mockCallTool.mockReset();
    mockClose.mockReset();
    mockTerminateSession.mockReset();
    warnLog.mockReset();
    infoLog.mockReset();
    debugLog.mockReset();

    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockTerminateSession.mockResolvedValue(undefined);
  });

  it('executeTool with McpError (code + message + data) includes code, message, and data', async () => {
    const session = await createSession();
    mockCallTool.mockRejectedValueOnce(
      new McpError(-32003, 'Missing required: query. Type errors: maxResults (expected number, got string).', {
        package_id: 'GoogleWorkspace-user',
        tool_id: 'search',
      }),
    );

    const result = await session.executeTool('search', {});

    expect(result.isError).toBe(true);
    expect(result.output).toContain('MCP tool error [code=-32003]');
    expect(result.output).toContain('Missing required: query. Type errors: maxResults (expected number, got string).');
    expect(result.output).toContain('Context:');
    expect(result.output).toContain('"package_id":"GoogleWorkspace-user"');

    await session.close();
  });

  it('executeTool with McpError timeout includes tool name suffix', async () => {
    const session = await createSession();
    mockCallTool.mockRejectedValueOnce(new McpError(-32001, 'Request timed out'));

    const result = await session.executeTool('search', {});

    expect(result.isError).toBe(true);
    expect(result.output).toBe('MCP tool error [code=-32001]: Request timed out (tool: search)');
    expect(result.output).not.toContain('Data:');

    await session.close();
  });

  it('executeTool with non-timeout McpError does NOT include tool name suffix', async () => {
    const session = await createSession();
    mockCallTool.mockRejectedValueOnce(new McpError(-33001, 'Package not found: badpkg'));

    const result = await session.executeTool('some_tool', {});

    expect(result.isError).toBe(true);
    expect(result.output).toBe('MCP tool error [code=-33001]: Package not found: badpkg');
    expect(result.output).not.toContain('(tool:');

    await session.close();
  });

  it('executeTool with McpError repair_ticket includes repair ticket text', async () => {
    const session = await createSession();
    mockCallTool.mockRejectedValueOnce(
      new McpError(-32003, 'Missing required: query', {
        repair_ticket: { missing_required: ['query'] },
        package_id: 'GoogleWorkspace-user',
      }),
    );

    const result = await session.executeTool('search', {});

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Repair ticket:');
    expect(result.output).toContain('"missing_required":["query"]');

    await session.close();
  });

  it('executeTool with plain Error (ECONNREFUSED) keeps legacy output format', async () => {
    const session = await createSession();
    mockCallTool.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:3100'));

    const result = await session.executeTool('search', {});

    expect(result.isError).toBe(true);
    expect(result.output).toBe('MCP tool error: connect ECONNREFUSED 127.0.0.1:3100');

    await session.close();
  });

  it('executeTool with large data object truncates output to include ...[truncated]', async () => {
    const session = await createSession();
    mockCallTool.mockRejectedValueOnce(
      new McpError(-32003, 'validation failed', {
        payload: 'x'.repeat(2500),
      }),
    );

    const result = await session.executeTool('search', {});

    expect(result.isError).toBe(true);
    expect(result.output).toContain('...[truncated]');

    await session.close();
  });

  it('executeTool with circular data object does not throw during stringify', async () => {
    const session = await createSession();
    const circularData: Record<string, unknown> = { label: 'circular' };
    circularData.self = circularData;
    mockCallTool.mockRejectedValueOnce(new McpError(-32003, 'validation failed', circularData));

    const result = await session.executeTool('search', {});

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Context:');
    expect(result.output).toContain('[Circular]');

    await session.close();
  });

  it('executeTool truncates oversized tool output as defense-in-depth', async () => {
    const session = await createSession();
    const hugeOutput = 'x'.repeat(600_000);
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: hugeOutput }],
      isError: false,
    });

    const result = await session.executeTool('generate_image', {});

    expect(result.isError).toBe(false);
    expect(result.output.length).toBeLessThan(600_000);
    expect(result.output).toContain('Tool output truncated from');
    expect(result.output).toMatch(/500[,\s\u202F]000/);
    expect(warnLog).toHaveBeenCalledWith(
      expect.objectContaining({ originalLength: 600_000, truncatedTo: 500_000 }),
      'Tool output exceeded context size cap — truncated as defense-in-depth',
    );

    await session.close();
  });

  it('executeTool does not truncate output within size cap', async () => {
    const session = await createSession();
    const normalOutput = 'x'.repeat(100_000);
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: normalOutput }],
      isError: false,
    });

    const result = await session.executeTool('list_tools', {});

    expect(result.isError).toBe(false);
    expect(result.output).toBe(normalOutput);
    expect(result.output).not.toContain('truncated');

    await session.close();
  });

  it('executeTool extracts image blocks alongside text output', async () => {
    const session = await createSession();
    mockCallTool.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', data: 'abc123', mimeType: 'image/png' },
      ],
      isError: false,
    });

    const result = await session.executeTool('generate_image', {});

    expect(result.isError).toBe(false);
    expect(result.output).toBe('hello');
    expect(result.imageContent).toEqual([
      { type: 'image', data: 'abc123', mimeType: 'image/png' },
    ]);

    await session.close();
  });

  it('processCallToolResult preserves allowed Super-MCP passthrough _meta namespaces and structuredContent references', () => {
    const ui = {
      resourceUri: 'ui://google-workspace/compose-email',
      protocolUrl: 'mcp://google-workspace/resources/compose-email',
    };
    const superMcp = {
      packageId: 'google-workspace',
      toolId: 'compose_workspace_email',
      durationMs: 12,
    };
    const materialization = {
      status: 'materialized',
      filePath: '/tmp/tool-output.json',
    };
    const meta = {
      ui,
      superMcp,
      materialization,
    };
    const structuredContent = {
      to: ['person@example.com'],
      subject: 'Hello',
      body: 'A draft body.',
    };

    const result = processCallToolResult({
      content: [{ type: 'text', text: 'Draft ready' }],
      _meta: meta,
      structuredContent,
      isError: false,
    }, 'tu-meta');

    expect(result.meta).toEqual(meta);
    expect(result.meta?.ui).toBe(ui);
    expect(result.meta?.superMcp).toBe(superMcp);
    expect(result.meta?.materialization).toBe(materialization);
    expect(result.structuredContent).toBe(structuredContent);
    expect(result.output).toBe('Draft ready');
    expect(warnLog).not.toHaveBeenCalledWith(
      expect.anything(),
      'super-mcp passthrough _meta dropped unknown namespaces — extend allowlist if intentional',
    );
    expect(debugLog).toHaveBeenCalledWith(
      {
        toolUseId: 'tu-meta',
        hasMetaUi: true,
        hasStructuredContent: true,
      },
      'super-mcp passthrough fields propagated',
    );
  });

  it('processCallToolResult drops unknown _meta namespaces and warns', () => {
    const result = processCallToolResult({
      content: [{ type: 'text', text: 'ok' }],
      _meta: {
        somethingMalicious: { hidden: true },
      },
      isError: false,
    }, 'tu-unknown-meta');

    expect(result.meta).toBeUndefined();
    expect(warnLog).toHaveBeenCalledWith(
      {
        toolUseId: 'tu-unknown-meta',
        droppedKeys: ['somethingMalicious'],
      },
      'super-mcp passthrough _meta dropped unknown namespaces — extend allowlist if intentional',
    );
  });

  it('processCallToolResult preserves allowed _meta namespaces while dropping unknown siblings', () => {
    const ui = { resourceUri: 'ui://google-workspace/compose-email' };
    const superMcp = { packageId: 'google-workspace', toolId: 'compose_workspace_email', durationMs: 12 };

    const result = processCallToolResult({
      content: [{ type: 'text', text: 'ok' }],
      _meta: {
        ui,
        unexpected: { debug: true },
        superMcp,
      },
      isError: false,
    }, 'tu-mixed-meta');

    expect(result.meta).toEqual({ ui, superMcp });
    expect(result.meta?.ui).toBe(ui);
    expect(result.meta?.superMcp).toBe(superMcp);
    expect(result.meta).not.toHaveProperty('unexpected');
    expect(warnLog).toHaveBeenCalledWith(
      {
        toolUseId: 'tu-mixed-meta',
        droppedKeys: ['unexpected'],
      },
      'super-mcp passthrough _meta dropped unknown namespaces — extend allowlist if intentional',
    );
  });

  it('executeTool threads toolUseId into passthrough _meta diagnostics', async () => {
    const session = await createSession();
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'ok' }],
      _meta: { unexpected: true },
      isError: false,
    });

    await session.executeTool('use_tool', { package_id: 'pkg', tool_id: 'tool' }, 'tu-execute-meta');

    expect(warnLog).toHaveBeenCalledWith(
      {
        toolUseId: 'tu-execute-meta',
        droppedKeys: ['unexpected'],
      },
      'super-mcp passthrough _meta dropped unknown namespaces — extend allowlist if intentional',
    );

    await session.close();
  });

  it.each([
    ['null', null],
    ['array', []],
    ['string primitive', 'not-meta'],
    ['number primitive', 42],
  ])('processCallToolResult drops malformed _meta (%s)', (_label, malformedMeta) => {
    const result = processCallToolResult({
      content: [{ type: 'text', text: 'ok' }],
      _meta: malformedMeta,
      isError: false,
    }, 'tu-malformed');

    expect(result.meta).toBeUndefined();
    expect(warnLog).toHaveBeenCalledWith(
      expect.objectContaining({ toolUseId: 'tu-malformed' }),
      'super-mcp passthrough _meta malformed; dropping outer meta field',
    );
  });

  it('processCallToolResult leaves meta undefined when _meta is absent or explicitly undefined', () => {
    expect(processCallToolResult({ content: [{ type: 'text', text: 'ok' }] }).meta).toBeUndefined();
    expect(processCallToolResult({ content: [{ type: 'text', text: 'ok' }], _meta: undefined }).meta).toBeUndefined();
  });

  it('processCallToolResult preserves existing text and image extraction while carrying passthrough fields', () => {
    const meta = { ui: { resourceUri: 'ui://image/app' } };
    const structuredContent = { imageId: 'img-1' };

    const result = processCallToolResult({
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', data: 'abc123', mimeType: 'image/png' },
      ],
      _meta: meta,
      structuredContent,
      isError: false,
    });

    expect(result.output).toBe('hello');
    expect(result.imageContent).toEqual([
      { type: 'image', data: 'abc123', mimeType: 'image/png' },
    ]);
    expect(result.meta).toEqual(meta);
    expect(result.meta?.ui).toBe(meta.ui);
    expect(result.structuredContent).toBe(structuredContent);
  });

  it('executeTool extracts resource-wrapped image blocks alongside text output', async () => {
    const session = await createSession();
    mockCallTool.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'hello' },
        {
          type: 'resource',
          resource: {
            uri: 'file:///img.png',
            mimeType: 'image/png',
            blob: 'abc123',
          },
        },
      ],
      isError: false,
    });

    const result = await session.executeTool('generate_image', {});

    expect(result.isError).toBe(false);
    expect(result.output).toBe('hello');
    expect(result.imageContent).toEqual([
      { type: 'image', data: 'abc123', mimeType: 'image/png' },
    ]);

    await session.close();
  });

  it('executeTool with text-only content returns no imageContent', async () => {
    const session = await createSession();
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'text only' }],
      isError: false,
    });

    const result = await session.executeTool('list_tools', {});

    expect(result.isError).toBe(false);
    expect(result.output).toBe('text only');
    expect(result.imageContent).toBeUndefined();

    await session.close();
  });

  it('injects the Rebel conversation id into direct browser tool calls', async () => {
    const session = await createSession({ sessionId: 'conversation-1' });
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    });

    await session.executeTool('rebel_browser_read_page', {
      tabContext: { tabId: 42 },
    });

    expect(mockCallTool).toHaveBeenCalledWith(
      {
        name: 'rebel_browser_read_page',
        arguments: {
          tabContext: { tabId: 42 },
          __rebel_conversation_id: 'conversation-1',
        },
      },
      undefined,
      expect.any(Object),
    );

    await session.close();
  });

  it('injects the Rebel conversation id into Super-MCP use_tool browser args', async () => {
    const session = await createSession({ sessionId: 'conversation-2' });
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    });

    await session.executeTool('use_tool', {
      package_id: 'rebel-app-bridge',
      tool_id: 'rebel_browser_read_page',
      args: {
        tabContext: { tabId: 42 },
      },
    });

    expect(mockCallTool).toHaveBeenCalledWith(
      {
        name: 'use_tool',
        arguments: {
          package_id: 'rebel-app-bridge',
          tool_id: 'rebel_browser_read_page',
          args: {
            tabContext: { tabId: 42 },
            __rebel_conversation_id: 'conversation-2',
          },
        },
      },
      undefined,
      expect.any(Object),
    );

    await session.close();
  });

  it('executeTool surfaces use_tool outer isError=true at the client boundary', async () => {
    const session = await createSession();
    mockCallTool.mockResolvedValueOnce({
      isError: true,
      content: [{
        type: 'text',
        text: JSON.stringify({
          package_id: 'pkg1',
          tool_id: 'tool1',
          result: {
            isError: true,
            content: [{ type: 'text', text: 'inner failure payload' }],
          },
        }),
      }],
    });

    const result = await session.executeTool('use_tool', {
      package_id: 'pkg1',
      tool_id: 'tool1',
      args: {},
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('"isError":true');

    await session.close();
  });

  it('executeTool does not include imageContent for error results', async () => {
    const session = await createSession();
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: 'image', data: 'abc123', mimeType: 'image/png' }],
      isError: true,
    });

    const result = await session.executeTool('generate_image', {});

    expect(result.isError).toBe(true);
    expect(result.imageContent).toBeUndefined();

    await session.close();
  });

  it('listTools with McpError returns [] and logs with code metadata', async () => {
    const session = await createSession();
    mockListTools.mockRejectedValueOnce(new McpError(-32603, 'Internal error', { foo: 'bar' }));

    const result = await session.listTools();

    expect(result).toEqual([]);
    expect(warnLog).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'MCP error -32603: Internal error', code: -32603, hasData: true }),
      'Failed to list MCP tools',
    );

    await session.close();
  });

  it('listTools with plain Error returns [] and logs basic error message', async () => {
    const session = await createSession();
    mockListTools.mockRejectedValueOnce(new Error('connection lost'));

    const result = await session.listTools();

    expect(result).toEqual([]);
    expect(warnLog).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'connection lost' }),
      'Failed to list MCP tools',
    );

    await session.close();
  });

  it('executeTool with plain {code, message, data} object preserves structured info', async () => {
    const session = await createSession();
    mockCallTool.mockRejectedValueOnce({
      code: -32004,
      message: 'Package unavailable: Slack',
      data: { package_id: 'Slack-user' },
    });

    const result = await session.executeTool('send_message', {});

    expect(result.isError).toBe(true);
    expect(result.output).toContain('MCP tool error [code=-32004]');
    expect(result.output).toContain('Package unavailable: Slack');
    expect(result.output).toContain('"package_id":"Slack-user"');

    await session.close();
  });

  it('executeTool with repair_ticket does not duplicate it in Context line', async () => {
    const session = await createSession();
    mockCallTool.mockRejectedValueOnce(
      new McpError(-32003, 'Validation failed', {
        repair_ticket: { missing_required: ['query'] },
        package_id: 'GoogleWorkspace-user',
      }),
    );

    const result = await session.executeTool('search', {});

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Repair ticket:');
    // Context line should have package_id but not repair_ticket
    const contextLine = result.output.split('\n').find(l => l.startsWith('Context:'));
    expect(contextLine).toBeDefined();
    expect(contextLine).toContain('package_id');
    expect(contextLine).not.toContain('missing_required');

    await session.close();
  });

  it('executeTool total output is capped at 2000 chars', async () => {
    const session = await createSession();
    mockCallTool.mockRejectedValueOnce(
      new McpError(-32003, 'validation failed', {
        repair_ticket: { schema: 'x'.repeat(1500) },
        extra_field: 'y'.repeat(1500),
      }),
    );

    const result = await session.executeTool('search', {});

    expect(result.isError).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(2000 + '...[truncated]'.length);

    await session.close();
  });

  it('listTools with plain {code, message, data} object logs with code metadata', async () => {
    const session = await createSession();
    mockListTools.mockRejectedValueOnce({
      code: -32004,
      message: 'Package unavailable',
      data: { package_id: 'Slack' },
    });

    const result = await session.listTools();

    expect(result).toEqual([]);
    expect(warnLog).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'Package unavailable', code: -32004, hasData: true }),
      'Failed to list MCP tools',
    );

    await session.close();
  });

  it('filters app-only tools out of the model-visible listTools result', async () => {
    const session = await createSession();
    mockListTools.mockResolvedValueOnce({
      tools: [
        {
          name: 'model_visible_default',
          description: 'Default visible tool',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'app_only_tool',
          description: 'Iframe-only tool',
          inputSchema: { type: 'object', properties: {} },
          _meta: { ui: { visibility: ['app'] } },
        },
        {
          name: 'dual_visible_tool',
          description: 'Visible to model and app',
          inputSchema: { type: 'object', properties: {} },
          _meta: { ui: { visibility: ['model', 'app'] } },
        },
        {
          name: 'model_only_tool',
          description: 'Visible only to model',
          inputSchema: { type: 'object', properties: {} },
          _meta: { ui: { visibility: ['model'] } },
        },
        {
          name: 'disabled_tool',
          description: 'Visible to neither surface',
          inputSchema: { type: 'object', properties: {} },
          _meta: { ui: { visibility: [] } },
        },
      ],
    });

    const result = await session.listTools();

    expect(result.map((definition) => definition.apiToolName)).toEqual([
      'model_visible_default',
      'dual_visible_tool',
      'model_only_tool',
    ]);
    expect(infoLog).toHaveBeenCalledWith(
      expect.objectContaining({ toolCount: 3, hiddenAppOnlyToolCount: 2 }),
      'Listed MCP tools from Super-MCP',
    );

    await session.close();
  });

  it('treats malformed visibility metadata as model-visible for backwards compatibility', () => {
    expect(isModelVisibleMcpTool({ name: 'legacy' })).toBe(true);
    expect(isModelVisibleMcpTool({ name: 'malformed', _meta: { ui: { visibility: 'app' } } })).toBe(true);
    expect(isModelVisibleMcpTool({ name: 'app-only', _meta: { ui: { visibility: ['app'] } } })).toBe(false);
  });
});

describe('mcpClient session reconnection', () => {
  beforeEach(() => {
    mockConnect.mockReset();
    mockListTools.mockReset();
    mockCallTool.mockReset();
    mockClose.mockReset();
    mockTerminateSession.mockReset();
    warnLog.mockReset();
    infoLog.mockReset();
    debugLog.mockReset();

    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockTerminateSession.mockResolvedValue(undefined);
  });

  it('executeTool reconnects on "Session not found" and retries successfully', async () => {
    const getLatestUrl = vi.fn().mockReturnValue('http://127.0.0.1:3200/mcp');
    const session = await createSession({ getLatestUrl });

    // First call: Session not found (stale session after restart)
    mockCallTool.mockRejectedValueOnce(
      new StreamableHTTPError(404, 'Error POSTing to endpoint: {"error":"Session not found"}'),
    );
    // Second call (after reconnect): success
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Tools listed' }],
      isError: false,
    });

    const result = await session.executeTool('list_tools', {});

    expect(result.isError).toBe(false);
    expect(result.output).toBe('Tools listed');
    // ensureReconnected triggers performReconnect which calls connectClient
    expect(mockConnect).toHaveBeenCalledTimes(2); // initial + reconnect

    await session.close();
  });

  it('non-session errors do NOT trigger reconnection', async () => {
    const getLatestUrl = vi.fn().mockReturnValue('http://127.0.0.1:3200/mcp');
    const session = await createSession({ getLatestUrl });

    mockCallTool.mockRejectedValueOnce(new McpError(-32003, 'Validation failed'));

    const result = await session.executeTool('some_tool', {});

    expect(result.isError).toBe(true);
    expect(mockConnect).toHaveBeenCalledTimes(1); // only initial connect

    await session.close();
  });

  it('reconnection failure falls through to normal error handling', async () => {
    const getLatestUrl = vi.fn().mockReturnValue('http://127.0.0.1:3200/mcp');
    const session = await createSession({ getLatestUrl });

    // First call: Session not found
    mockCallTool.mockRejectedValueOnce(
      new StreamableHTTPError(404, 'Error POSTing to endpoint: {"error":"Session not found"}'),
    );
    // Reconnect fails
    mockConnect.mockRejectedValueOnce(new Error('Connection refused'));

    const result = await session.executeTool('create_event', { title: 'Test' });

    expect(result.isError).toBe(true);
    // Original "Session not found" error surfaces after reconnect failure
    expect(result.output).toContain('Session not found');

    await session.close();
  });
});

describe('mcpClient annotation forwarding', () => {
  beforeEach(() => {
    mockConnect.mockReset();
    mockListTools.mockReset();
    mockCallTool.mockReset();
    mockClose.mockReset();
    mockTerminateSession.mockReset();
    warnLog.mockReset();
    infoLog.mockReset();
    debugLog.mockReset();

    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockTerminateSession.mockResolvedValue(undefined);
  });

  it('listTools forwards annotations when present', async () => {
    const session = await createSession();

    mockListTools.mockResolvedValueOnce({
      tools: [
        {
          name: 'list_channels',
          description: 'List Slack channels',
          inputSchema: { type: 'object', properties: {} },
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
      ],
    });

    const result = await session.listTools();

    expect(result).toHaveLength(1);
    expect(result[0].annotations).toEqual({ readOnlyHint: true, destructiveHint: false });

    await session.close();
  });

  it('listTools omits annotations when not present', async () => {
    const session = await createSession();

    mockListTools.mockResolvedValueOnce({
      tools: [
        {
          name: 'send_message',
          description: 'Send a message',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });

    const result = await session.listTools();

    expect(result).toHaveLength(1);
    expect(result[0].annotations).toBeUndefined();

    await session.close();
  });
});
