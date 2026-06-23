import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpTestClient, type McpTestClient } from '../mcp-test-harness';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');
const serverPath = path.join(projectRoot, 'resources', 'mcp', 'electron-debug', 'server.mjs');

describe('electron-debug MCP server contract', () => {
  let client: McpTestClient | null = null;

  afterEach(async () => {
    await client?.close();
    client = null;
  });

  it('registers spawn_dev_server with a 90s readiness default', async () => {
    client = await createMcpTestClient({
      name: 'electron-debug',
      command: 'node',
      args: [serverPath],
      connectTimeout: 15_000,
    });

    const tools = await client.listTools();
    const spawnDevServer = tools.find((tool) => tool.name === 'spawn_dev_server');

    expect(spawnDevServer).toBeDefined();
    const schemaText = JSON.stringify(spawnDevServer?.inputSchema);
    expect(schemaText).toContain('waitForReadyMs');
    expect(schemaText).toContain('default: 90000');
  });
});
