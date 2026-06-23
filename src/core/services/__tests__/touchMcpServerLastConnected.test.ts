import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { touchMcpServerLastConnected } from '../mcpConfigManager';

describe('touchMcpServerLastConnected', () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-touch-mcp-'));
    configPath = path.join(tempDir, 'super-mcp-router.json');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('mutates only lastConnectedAt and creates a backup', async () => {
    const originalConfig = {
      configPaths: ['/external/mcp.json'],
      mcpServers: {
        Gamma: {
          name: 'Gamma',
          command: 'node',
          args: ['server.js'],
          env: { GAMMA_API_KEY: 'secret' },
          catalogId: 'bundled-gamma',
          email: 'user@example.com',
          lastConnectedAt: 111,
        },
        Slack: {
          name: 'Slack',
          command: 'node',
          args: ['slack.js'],
          lastConnectedAt: 222,
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(originalConfig, null, 2), 'utf8');

    const result = await touchMcpServerLastConnected(configPath, 'Gamma', 333);

    expect(result.backupPath).toBeTruthy();
    await expect(fs.access(result.backupPath!)).resolves.toBeUndefined();
    await expect(fs.readFile(result.backupPath!, 'utf8').then(JSON.parse)).resolves.toEqual(originalConfig);

    const updated = JSON.parse(await fs.readFile(configPath, 'utf8')) as typeof originalConfig;
    expect(updated).toEqual({
      ...originalConfig,
      mcpServers: {
        ...originalConfig.mcpServers,
        Gamma: {
          ...originalConfig.mcpServers.Gamma,
          lastConnectedAt: 333,
        },
      },
    });
  });

  it('throws when server missing', async () => {
    await fs.writeFile(configPath, JSON.stringify({
      mcpServers: {
        Slack: { name: 'Slack', command: 'node' },
      },
    }), 'utf8');

    await expect(touchMcpServerLastConnected(configPath, 'Gamma', 333))
      .rejects.toThrow('Cannot update lastConnectedAt — MCP server "Gamma" not found in configuration.');
  });

  it('defaults ts to Date.now() when omitted', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(987_654);
    await fs.writeFile(configPath, JSON.stringify({
      mcpServers: {
        Gamma: { name: 'Gamma', command: 'node' },
      },
    }), 'utf8');

    await touchMcpServerLastConnected(configPath, 'Gamma');

    const updated = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      mcpServers: { Gamma: { lastConnectedAt?: number } };
    };
    expect(updated.mcpServers.Gamma.lastConnectedAt).toBe(987_654);
  });
});
