/**
 * Unit tests for mcpDenyHook.ts
 */

import { describe, it, expect, vi } from 'vitest';

import { createMcpDenyHook } from '../mcpDenyHook';

describe('createMcpDenyHook', () => {
  const mockAbortSignal = new AbortController().signal;

  it('should deny mcp__super-mcp-router__use_tool (the real MCP tool name)', async () => {
    const hook = createMcpDenyHook();
    const result = await hook(
      {
        tool_name: 'mcp__super-mcp-router__use_tool',
        tool_input: { server: 'slack', tool: 'send_message' },
        tool_use_id: 'test-id',
      },
      'test-id',
      { signal: mockAbortSignal }
    );

    expect(result).toHaveProperty('hookSpecificOutput');
    expect((result as any).hookSpecificOutput).toHaveProperty('hookEventName', 'PreToolUse');
    expect((result as any).hookSpecificOutput).toHaveProperty('permissionDecision', 'deny');
    expect((result as any).hookSpecificOutput).toHaveProperty(
      'permissionDecisionReason',
      'MCP tools are not available during memory updates'
    );
  });

  it('should deny any mcp__ prefixed tool', async () => {
    const hook = createMcpDenyHook();
    const result = await hook(
      {
        tool_name: 'mcp__any-server__any-tool',
        tool_input: {},
        tool_use_id: 'test-id-2',
      },
      'test-id-2',
      { signal: mockAbortSignal }
    );

    expect(result).toHaveProperty('hookSpecificOutput');
    expect((result as any).hookSpecificOutput).toHaveProperty('permissionDecision', 'deny');
  });

  it('should allow Edit tool', async () => {
    const hook = createMcpDenyHook();
    const result = await hook(
      { tool_name: 'Edit', tool_input: {}, tool_use_id: 'test-id-3' },
      'test-id-3',
      { signal: mockAbortSignal }
    );

    expect(result).toEqual({});
  });

  it('should allow Read tool', async () => {
    const hook = createMcpDenyHook();
    const result = await hook(
      { tool_name: 'Read', tool_input: {}, tool_use_id: 'test-id-4' },
      'test-id-4',
      { signal: mockAbortSignal }
    );

    expect(result).toEqual({});
  });

  it('should allow Create tool', async () => {
    const hook = createMcpDenyHook();
    const result = await hook(
      { tool_name: 'Create', tool_input: {}, tool_use_id: 'test-id-5' },
      'test-id-5',
      { signal: mockAbortSignal }
    );

    expect(result).toEqual({});
  });

  it('should allow Bash tool', async () => {
    const hook = createMcpDenyHook();
    const result = await hook(
      { tool_name: 'Bash', tool_input: {}, tool_use_id: 'test-id-6' },
      'test-id-6',
      { signal: mockAbortSignal }
    );

    expect(result).toEqual({});
  });

  it('should return empty object for allowed tools', async () => {
    const hook = createMcpDenyHook();

    for (const toolName of ['Edit', 'Read', 'Create', 'Bash', 'ListDir', 'Grep']) {
      const result = await hook(
        { tool_name: toolName, tool_input: {}, tool_use_id: `test-${toolName}` },
        `test-${toolName}`,
        { signal: mockAbortSignal }
      );

      expect(result).toEqual({});
    }
  });
});
