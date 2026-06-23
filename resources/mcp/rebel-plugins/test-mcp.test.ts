/**
 * RebelPlugins MCP Server Smoke Test
 *
 * Headless test that verifies the RebelPlugins MCP server:
 * 1. Starts successfully with mock bridge state
 * 2. Registers all expected plugin tools with correct names
 * 3. Each tool has a description and valid input schema
 *
 * This catches:
 * - Server startup failures (missing deps, syntax errors)
 * - Tool registration regressions (tools renamed or removed)
 * - Schema validation issues (missing/invalid inputSchema)
 *
 * Run: npx vitest run resources/mcp/rebel-plugins/test-mcp.test.ts
 */

import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'path';
import { createMcpTestClient, type McpTestClient } from '../../../scripts/mcp-test-harness';

const SERVER_SCRIPT = join(__dirname, 'server.cjs');

const EXPECTED_TOOLS = [
  'rebel_plugins_create',
  'rebel_plugins_list',
  'rebel_plugins_get_source',
  'rebel_plugins_delete',
  'rebel_plugins_open',
  'rebel_plugins_fork',
  'rebel_plugins_archive',
  'rebel_plugins_restore',
  'rebel_plugins_copy_to_space',
  'rebel_plugins_move_to_space',
];

describe('RebelPlugins MCP Server', () => {
  let client: McpTestClient | null = null;

  afterAll(async () => {
    await client?.close();
  });

  it('starts and registers all expected tools', async () => {
    client = await createMcpTestClient({
      name: 'rebel-plugins',
      serverScript: SERVER_SCRIPT,
      mockBridgeState: true,
      connectTimeout: 15_000,
    });

    const tools = await client.listTools();
    const toolNames = tools.map(t => t.name);

    // All expected tools are registered
    for (const expected of EXPECTED_TOOLS) {
      expect(toolNames, `Missing tool: ${expected}`).toContain(expected);
    }

    // No unexpected tools (catches accidental additions)
    expect(toolNames.sort()).toEqual(EXPECTED_TOOLS.sort());
  });

  it('each tool has description and valid input schema', async () => {
    if (!client) {
      client = await createMcpTestClient({
        name: 'rebel-plugins',
        serverScript: SERVER_SCRIPT,
        mockBridgeState: true,
        connectTimeout: 15_000,
      });
    }

    const tools = await client.listTools();

    for (const tool of tools) {
      expect(tool.description, `Tool "${tool.name}" missing description`).toBeTruthy();
      expect(tool.inputSchema, `Tool "${tool.name}" missing inputSchema`).toBeDefined();
      expect(tool.inputSchema.type, `Tool "${tool.name}" inputSchema.type should be "object"`).toBe('object');
    }
  });

  it('rebel_plugins_create requires id, name, and source', async () => {
    if (!client) {
      client = await createMcpTestClient({
        name: 'rebel-plugins',
        serverScript: SERVER_SCRIPT,
        mockBridgeState: true,
        connectTimeout: 15_000,
      });
    }

    const tools = await client.listTools();
    const createTool = tools.find(t => t.name === 'rebel_plugins_create');
    expect(createTool).toBeDefined();

    const required = createTool!.inputSchema.required as string[] | undefined;
    expect(required).toContain('id');
    expect(required).toContain('name');
    expect(required).toContain('source');
  });
});
