import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  SUPER_MCP_META_TOOLS,
  SUPER_MCP_READ_ONLY_META_TOOLS,
} from '../superMcpContract';

const {
  mockConnect,
  mockCallTool,
  mockClose,
  mockTerminateSession,
  warnLog,
  infoLog,
} = vi.hoisted(() => ({
  mockConnect: vi.fn(),
  mockCallTool: vi.fn(),
  mockClose: vi.fn(),
  mockTerminateSession: vi.fn(),
  warnLog: vi.fn(),
  infoLog: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = mockConnect;
    callTool = mockCallTool;
    close = mockClose;
    constructor() {
      // no-op
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    sessionId = 'session-1';
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
    debug: vi.fn(),
  }),
}));

import { createMcpSession, isReadOnlyMetaTool } from '../mcpClient';
import type { OnMcpErrorCallback } from '../types';

async function createConnectedSession() {
  const session = await createMcpSession('http://127.0.0.1:3100/mcp', {
    getLatestUrl: () => 'http://127.0.0.1:3100/mcp',
  });
  expect(session).not.toBeNull();
  return session!;
}

describe('mcpClient Super-MCP meta-tool contract', () => {
  beforeEach(() => {
    mockConnect.mockReset();
    mockCallTool.mockReset();
    mockClose.mockReset();
    mockTerminateSession.mockReset();
    warnLog.mockReset();
    infoLog.mockReset();

    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockTerminateSession.mockResolvedValue(undefined);
  });

  it('forwards exact MCP SDK call shape, timeout, and abort signal for meta-tool execution', async () => {
    const session = await createConnectedSession();
    const controller = new AbortController();
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    });

    await session.executeTool(
      SUPER_MCP_META_TOOLS.LIST_TOOLS,
      { package_id: 'google-workspace', detail: 'lite' },
      'tool-use-1',
      controller.signal,
    );

    expect(mockCallTool).toHaveBeenCalledWith(
      {
        name: SUPER_MCP_META_TOOLS.LIST_TOOLS,
        arguments: { package_id: 'google-workspace', detail: 'lite' },
      },
      undefined,
      {
        timeout: 14_400_000,
        signal: controller.signal,
      },
    );

    await session.close();
  });

  it('retries read-only meta-tools with the same call shape after session-not-found reconnect', async () => {
    const session = await createConnectedSession();
    mockCallTool
      .mockRejectedValueOnce(new McpError(-32001, 'Session not found'))
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'ok after retry' }],
        isError: false,
      });

    await session.executeTool(SUPER_MCP_META_TOOLS.GET_HELP, { topic: 'workflow' });

    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(mockCallTool).toHaveBeenNthCalledWith(
      1,
      { name: SUPER_MCP_META_TOOLS.GET_HELP, arguments: { topic: 'workflow' } },
      undefined,
      { timeout: 14_400_000 },
    );
    expect(mockCallTool).toHaveBeenNthCalledWith(
      2,
      { name: SUPER_MCP_META_TOOLS.GET_HELP, arguments: { topic: 'workflow' } },
      undefined,
      { timeout: 14_400_000 },
    );

    await session.close();
  });

  it('keeps the read-only retryable subset exactly in sync with the contract authority', () => {
    const allMetaTools = Object.values(SUPER_MCP_META_TOOLS);
    const retryable = allMetaTools.filter((toolName) => isReadOnlyMetaTool(toolName));

    expect(new Set(retryable)).toEqual(new Set(SUPER_MCP_READ_ONLY_META_TOOLS));
    for (const toolName of SUPER_MCP_READ_ONLY_META_TOOLS) {
      expect(isReadOnlyMetaTool(toolName)).toBe(true);
    }
    expect(isReadOnlyMetaTool(SUPER_MCP_META_TOOLS.USE_TOOL)).toBe(false);
    expect(isReadOnlyMetaTool(SUPER_MCP_META_TOOLS.AUTHENTICATE)).toBe(false);
    expect(isReadOnlyMetaTool(SUPER_MCP_META_TOOLS.RESTART_PACKAGE)).toBe(false);
  });
});

describe('mcpClient — downstream-tool-name-as-top-level-call recovery (REBEL-61S)', () => {
  beforeEach(() => {
    mockConnect.mockReset();
    mockCallTool.mockReset();
    mockClose.mockReset();
    mockTerminateSession.mockReset();
    warnLog.mockReset();
    infoLog.mockReset();
    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockTerminateSession.mockResolvedValue(undefined);
  });

  async function createSessionWithMcpErrorSpy(onMcpError: OnMcpErrorCallback) {
    const session = await createMcpSession('http://127.0.0.1:3100/mcp', {
      getLatestUrl: () => 'http://127.0.0.1:3100/mcp',
      onMcpError,
    });
    expect(session).not.toBeNull();
    return session!;
  }

  it('returns actionable use_tool guidance (not a Sentry-captured error) for a bare downstream tool name', async () => {
    const onMcpError = vi.fn<OnMcpErrorCallback>();
    const session = await createSessionWithMcpErrorSpy(onMcpError);
    mockCallTool.mockRejectedValueOnce(new McpError(-32602, 'Unknown tool: rebel_inbox_list'));

    const result = await session.executeTool('rebel_inbox_list', { archived: false });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('use_tool');
    expect(result.output).toContain('rebel_inbox_list');
    // bare name → point the model at discovery tools to find the package
    expect(result.output).toMatch(/search_tools|list_tools/);
    // Route via get_tool_details first (consistent with the get-details-before-use_tool gate)
    expect(result.output).toContain('get_tool_details');
    // This is handled, recoverable model behaviour — it must NOT be reported to
    // Sentry as an MCP error event (that is what kept REBEL-61S noisy).
    expect(onMcpError).not.toHaveBeenCalled();

    await session.close();
  });

  it('parses the catalog Package__tool form into an exact use_tool example', async () => {
    const onMcpError = vi.fn<OnMcpErrorCallback>();
    const session = await createSessionWithMcpErrorSpy(onMcpError);
    mockCallTool.mockRejectedValueOnce(new McpError(-32602, 'Unknown tool: RebelInbox__rebel_inbox_list'));

    const result = await session.executeTool('RebelInbox__rebel_inbox_list', { archived: false });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('"package_id": "RebelInbox"');
    expect(result.output).toContain('"tool_id": "rebel_inbox_list"');
    // Route via get_tool_details first (consistent with the get-details-before-use_tool gate)
    expect(result.output).toContain('get_tool_details');
    expect(onMcpError).not.toHaveBeenCalled();

    await session.close();
  });

  it('does NOT swallow a genuine -32602 (bad params to a real meta-tool) — still reports it', async () => {
    const onMcpError = vi.fn<OnMcpErrorCallback>();
    const session = await createSessionWithMcpErrorSpy(onMcpError);
    // Same code, different message shape → must take the normal error path.
    mockCallTool.mockRejectedValueOnce(new McpError(-32602, 'Invalid arguments for use_tool: package_id is required'));

    const result = await session.executeTool(SUPER_MCP_META_TOOLS.USE_TOOL, { tool_id: 'x' });

    expect(result.isError).toBe(true);
    expect(result.output).not.toContain('is not a directly callable tool');
    expect(onMcpError).toHaveBeenCalledTimes(1);

    await session.close();
  });

  it('does NOT swallow "Unknown tool" for a real meta-tool — that is a super-mcp contract regression, must surface (F1)', async () => {
    const onMcpError = vi.fn<OnMcpErrorCallback>();
    const session = await createSessionWithMcpErrorSpy(onMcpError);
    // super-mcp reporting its OWN meta-tool as unknown = contract drift/outage,
    // NOT a model mistake. Must take the normal telemetry path, not the shim.
    mockCallTool.mockRejectedValueOnce(new McpError(-32602, 'Unknown tool: use_tool'));

    const result = await session.executeTool(SUPER_MCP_META_TOOLS.USE_TOOL, { package_id: 'X', tool_id: 'y' });

    expect(result.isError).toBe(true);
    expect(result.output).not.toContain('is not a directly callable tool');
    expect(onMcpError).toHaveBeenCalledTimes(1);

    await session.close();
  });
});
