import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@core/services/toolIndex/toolIndexService', () => ({
  searchTools: vi.fn(),
  isToolIndexUsable: vi.fn(),
  getToolIndexStatus: vi.fn(),
}));

import { createSearchToolInterceptHook } from '@core/services/toolIndex/searchToolInterceptHook';
import { searchTools, isToolIndexUsable, getToolIndexStatus } from '@core/services/toolIndex/toolIndexService';

const mockSearchTools = vi.mocked(searchTools);
const mockIsToolIndexUsable = vi.mocked(isToolIndexUsable);
const mockGetToolIndexStatus = vi.mocked(getToolIndexStatus);

const TOOL_NAME = 'mcp__super-mcp-router__search_tools';

const makeHookInput = (toolName: string, toolInput: unknown) => ({
  hook_event_name: 'PreToolUse' as const,
  tool_name: toolName,
  tool_input: toolInput,
  tool_use_id: 'test-id',
});

const makeMockResult = (overrides: Partial<{
  toolId: string; serverId: string; serverName: string;
  name: string; description: string; summary: string;
  inputSchema: unknown; score: number;
}> = {}) => ({
  toolId: overrides.toolId ?? 'pkg__tool',
  serverId: overrides.serverId ?? 'pkg',
  serverName: overrides.serverName ?? 'Package',
  name: overrides.name ?? 'tool',
  description: overrides.description ?? 'A tool',
  summary: overrides.summary ?? 'Tool summary',
  inputSchema: overrides.inputSchema ?? {},
  score: overrides.score ?? 0.85,
});

describe('searchToolInterceptHook', () => {
  let hook: ReturnType<typeof createSearchToolInterceptHook>;
  const invokeHook = (input: ReturnType<typeof makeHookInput>) => {
    return hook(input as Parameters<typeof hook>[0], input.tool_use_id, {
      signal: new AbortController().signal,
    });
  };
  const getReplaceOutput = (result: Record<string, unknown>): string => {
    const hookSpecificOutput = result.hookSpecificOutput as Record<string, unknown> | undefined;
    const replaceResult = hookSpecificOutput?.replaceResult as Record<string, unknown> | undefined;
    const output = replaceResult?.output;
    if (typeof output !== 'string') {
      throw new Error('Expected replaceResult.output to be a string');
    }
    return output;
  };
  const parseReplaceOutput = (result: Record<string, unknown>) => {
    return JSON.parse(getReplaceOutput(result)) as {
      results: Array<{ package_id: string; [key: string]: unknown }>;
      query: string;
      total_tools_searched: number;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsToolIndexUsable.mockReturnValue(true);
    mockGetToolIndexStatus.mockReturnValue({
      isInitialized: true,
      toolCount: 0,
      lastRefreshAt: null,
      etag: null,
      byServer: undefined,
    });
    mockSearchTools.mockResolvedValue([]);
    hook = createSearchToolInterceptHook();
  });

  it('intercepts search_tools and returns hybrid results', async () => {
    mockSearchTools.mockResolvedValue([
      makeMockResult({ toolId: 'Gmail__search', serverId: 'Gmail', name: 'search', score: 0.92 }),
      makeMockResult({ toolId: 'Slack__search', serverId: 'Slack', name: 'search_messages', score: 0.78 }),
    ]);

    const result = await invokeHook(makeHookInput(TOOL_NAME, { query: 'find emails' }));

    expect(result).toMatchObject({
      continue: false,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        replaceResult: {
          isError: false,
        },
      },
    });

    const output = parseReplaceOutput(result as Record<string, unknown>);
    expect(output.results).toHaveLength(2);
    expect(output.results[0].tool_id).toBe('Gmail__search');
    expect(output.results[0].relevance_score).toBe(0.92);
    expect(output.query).toBe('find emails');
  });

  it('falls through for non-search_tools calls', async () => {
    const result = await invokeHook(makeHookInput('mcp__some__other_tool', { query: 'test' }));
    expect(result).toEqual({});
    expect(mockSearchTools).not.toHaveBeenCalled();
  });

  it('falls through when tool index is stale or otherwise unusable', async () => {
    mockIsToolIndexUsable.mockReturnValue(false);
    const result = await invokeHook(makeHookInput(TOOL_NAME, { query: 'test' }));
    expect(result).toEqual({});
    expect(mockSearchTools).not.toHaveBeenCalled();
  });

  it('falls through if tool index becomes stale during search', async () => {
    mockIsToolIndexUsable
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    mockSearchTools.mockResolvedValue([
      makeMockResult({ toolId: 'Microsoft365Mail__search_emails', serverId: 'Microsoft365Mail' }),
    ]);

    const result = await invokeHook(makeHookInput(TOOL_NAME, { query: 'email' }));

    expect(result).toEqual({});
    expect(mockSearchTools).toHaveBeenCalledTimes(1);
  });

  it('falls through if tool index generation changes during search', async () => {
    mockGetToolIndexStatus
      .mockReturnValueOnce({
        isInitialized: true,
        toolCount: 42,
        lastRefreshAt: null,
        etag: null,
        byServer: undefined,
        freshnessGeneration: 1,
      })
      .mockReturnValueOnce({
        isInitialized: true,
        toolCount: 42,
        lastRefreshAt: null,
        etag: null,
        byServer: undefined,
        freshnessGeneration: 2,
      });
    mockSearchTools.mockResolvedValue([
      makeMockResult({ toolId: 'Microsoft365Mail__search_emails', serverId: 'Microsoft365Mail' }),
    ]);

    const result = await invokeHook(makeHookInput(TOOL_NAME, { query: 'email' }));

    expect(result).toEqual({});
    expect(mockSearchTools).toHaveBeenCalledTimes(1);
  });

  it('returns valid replaceResult with empty results when searchTools returns []', async () => {
    mockSearchTools.mockResolvedValue([]);

    const result = await invokeHook(makeHookInput(TOOL_NAME, { query: 'test' }));

    expect(result).toMatchObject({
      continue: false,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        replaceResult: {
          isError: false,
        },
      },
    });

    const output = parseReplaceOutput(result as Record<string, unknown>);

    expect(output).toEqual({
      results: [],
      query: 'test',
      total_tools_searched: 0,
    });
  });

  it('uses tool index status count for total_tools_searched', async () => {
    mockGetToolIndexStatus.mockReturnValue({
      isInitialized: true,
      toolCount: 42,
      lastRefreshAt: null,
      etag: null,
      byServer: undefined,
    });
    mockSearchTools.mockResolvedValue([
      makeMockResult({ toolId: 'Pkg__a' }),
      makeMockResult({ toolId: 'Pkg__b' }),
    ]);

    const result = await invokeHook(makeHookInput(TOOL_NAME, { query: 'test' }));
    const output = parseReplaceOutput(result as Record<string, unknown>);

    expect(output.total_tools_searched).toBe(42);
  });

  it('falls back to result count when tool index status is unavailable', async () => {
    mockGetToolIndexStatus.mockImplementation(() => undefined as never);
    mockSearchTools.mockResolvedValue([
      makeMockResult({ toolId: 'Pkg__a' }),
      makeMockResult({ toolId: 'Pkg__b' }),
    ]);

    const result = await invokeHook(makeHookInput(TOOL_NAME, { query: 'test' }));
    const output = parseReplaceOutput(result as Record<string, unknown>);

    expect(output.total_tools_searched).toBe(2);
  });

  it('falls through on search error', async () => {
    mockSearchTools.mockRejectedValue(new Error('LanceDB crashed'));
    const result = await invokeHook(makeHookInput(TOOL_NAME, { query: 'test' }));
    expect(result).toEqual({});
  });

  it('uses Super-MCP default limit and threshold', async () => {
    await invokeHook(makeHookInput(TOOL_NAME, { query: 'test' }));
    expect(mockSearchTools).toHaveBeenCalledWith('test', 5, 0.0);
  });

  it('respects explicit limit and threshold', async () => {
    await invokeHook(makeHookInput(TOOL_NAME, { query: 'test', limit: 10, threshold: 0.5 }));
    expect(mockSearchTools).toHaveBeenCalledWith('test', 10, 0.5);
  });

  it('filters by packages', async () => {
    mockSearchTools.mockResolvedValue([
      makeMockResult({ serverId: 'Gmail', score: 0.9 }),
      makeMockResult({ serverId: 'Slack', score: 0.8 }),
      makeMockResult({ serverId: 'Gmail', score: 0.7 }),
    ]);

    const result = await invokeHook(makeHookInput(TOOL_NAME, { query: 'test', packages: ['Gmail'] }));
    const output = parseReplaceOutput(result as Record<string, unknown>);
    expect(output.results).toHaveLength(2);
    expect(output.results.every((r) => r.package_id === 'Gmail')).toBe(true);
    // Over-fetches limit * 3 when packages specified
    expect(mockSearchTools).toHaveBeenCalledWith('test', 15, 0.0);
  });

  it('returns empty for empty query', async () => {
    const result = await invokeHook(makeHookInput(TOOL_NAME, { query: '' }));
    expect(result).toEqual({});
    expect(mockSearchTools).not.toHaveBeenCalled();
  });

  it('falls through when tool_input is undefined', async () => {
    const result = await invokeHook(makeHookInput(TOOL_NAME, undefined));
    expect(result).toEqual({});
    expect(mockSearchTools).not.toHaveBeenCalled();
  });

  it('falls through when tool_input is null', async () => {
    const result = await invokeHook(makeHookInput(TOOL_NAME, null));
    expect(result).toEqual({});
    expect(mockSearchTools).not.toHaveBeenCalled();
  });

  it('handles query with special characters', async () => {
    const query = "find 'meeting notes' with (parentheses) & special <chars>";

    const result = await invokeHook(makeHookInput(TOOL_NAME, { query }));

    expect(mockSearchTools).toHaveBeenCalledWith(query, 5, 0.0);
    expect(() => parseReplaceOutput(result as Record<string, unknown>)).not.toThrow();
    const output = parseReplaceOutput(result as Record<string, unknown>);
    expect(output.query).toBe(query);
  });

  it('formats output as SearchToolsOutput', async () => {
    mockGetToolIndexStatus.mockReturnValue({
      isInitialized: true,
      toolCount: 1,
      lastRefreshAt: null,
      etag: null,
      byServer: undefined,
    });
    mockSearchTools.mockResolvedValue([
      makeMockResult({
        toolId: 'Pkg__my_tool',
        serverId: 'Pkg',
        name: 'my_tool',
        description: 'Full desc',
        summary: 'Short summary',
        score: 0.8567,
      }),
    ]);

    const result = await invokeHook(makeHookInput(TOOL_NAME, { query: 'test' }));
    const output = parseReplaceOutput(result as Record<string, unknown>);

    expect(output).toEqual({
      results: [{
        tool_id: 'Pkg__my_tool',
        package_id: 'Pkg',
        name: 'my_tool',
        summary: 'Short summary',
        description: 'Full desc',
        relevance_score: 0.86,
      }],
      query: 'test',
      total_tools_searched: 1,
    });
  });
});
