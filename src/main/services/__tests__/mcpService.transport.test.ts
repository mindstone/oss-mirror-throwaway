import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import type { AppSettings } from '@shared/types';
import { DEFAULT_VOICE_ACTIVATION_HOTKEY, DEFAULT_VOICE_ACTIVATION_VOICE_MODE } from '@shared/types';
import { resolveMcpServers, setMcpDisabled } from '../mcpService';
import { superMcpHttpManager } from '../superMcpHttpManager';

const baseSettings: AppSettings = {
  coreDirectory: null,
  mcpConfigFile: null,
  onboardingCompleted: false,
  userEmail: null,
  onboardingFirstCompletedAt: null,
  voice: {
    provider: 'openai-whisper',
    openaiApiKey: null,
    elevenlabsApiKey: null,
    model: 'whisper-1',
    ttsVoice: null,
    activationHotkey: DEFAULT_VOICE_ACTIVATION_HOTKEY,
    activationHotkeyVoiceMode: DEFAULT_VOICE_ACTIVATION_VOICE_MODE
  },
  models: {
    apiKey: 'test-key',
    oauthToken: null,
    authMethod: 'api-key',
    model: 'claude-sonnet-4-5',
    permissionMode: 'bypassPermissions',
    executablePath: null,
    planMode: true,
    extendedContext: true,
    thinkingEffort: 'high'
  },
  diagnostics: {
    debugBreadcrumbsUntil: null
  }
};

describe('resolveMcpServers transport inference', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-transport-test-'));
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  // These tests require direct mode to test transport inference on individual servers
  // Since Super-MCP is now the default, we force direct mode for these specific tests
  beforeEach(() => {
    process.env['MINDSTONE_FORCE_DIRECT_MCP'] = '1';
  });

  afterEach(() => {
    delete process.env['MINDSTONE_FORCE_DIRECT_MCP'];
    setMcpDisabled(false);
    vi.restoreAllMocks();
  });

  const writeConfig = async (data: unknown): Promise<string> => {
    const filePath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    return filePath;
  };

  const buildSettings = (configPath: string): AppSettings => ({
    ...baseSettings,
    mcpConfigFile: configPath
  });

  it('defaults to HTTP for generic remote URLs', async () => {
    const configPath = await writeConfig({
      mcpServers: {
        generic: {
          url: 'https://example.com/mcp'
        }
      }
    });

    const resolved = await resolveMcpServers(buildSettings(configPath));
    expect(resolved.mode).toBe('direct');
    expect(resolved.servers?.generic?.type).toBe('http');
  });

  it('infers SSE when headers explicitly request event streams', async () => {
    const configPath = await writeConfig({
      mcpServers: {
        stream: {
          url: 'https://example.com/event-stream',
          headers: {
            Accept: 'text/event-stream'
          }
        }
      }
    });

    const resolved = await resolveMcpServers(buildSettings(configPath));
    expect(resolved.mode).toBe('direct');
    expect(resolved.servers?.stream?.type).toBe('sse');
  });

  it('falls back to HTTP when SSE probe fails for hinted URLs', async () => {
    // Start local HTTP server that returns JSON (not SSE)
    await new Promise<void>((resolve, reject) => {
      const server = http.createServer((_, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });

      server.listen(0, async () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close();
          reject(new Error('Unable to determine server address'));
          return;
        }
        const url = `http://127.0.0.1:${address.port}/event-stream`;
        try {
          const configPath = await writeConfig({
            mcpServers: {
              probe: {
                url
              }
            }
          });

          const resolved = await resolveMcpServers(buildSettings(configPath));
          expect(resolved.mode).toBe('direct');
          expect(resolved.servers?.probe?.type).toBe('http');
          server.close();
          resolve();
        } catch (error) {
          server.close();
          reject(error);
        }
      });
    });
  });

  it('recreates a missing MCP config and degrades without throwing', async () => {
    const configPath = path.join(tempDir, 'missing-mcp.json');

    const resolved = await resolveMcpServers(buildSettings(configPath));

    expect(resolved).toEqual({
      servers: undefined,
      mode: 'none',
      upstreamCount: 0,
      configPath,
    });
    await expect(fs.readFile(configPath, 'utf8')).resolves.toContain('"mcpServers": {}');
  });

  it('backs up and recreates malformed MCP config instead of throwing', async () => {
    const configPath = path.join(tempDir, 'malformed-mcp.json');
    await fs.writeFile(configPath, '{not json', 'utf8');

    const resolved = await resolveMcpServers(buildSettings(configPath));

    expect(resolved.mode).toBe('none');
    await expect(fs.readFile(configPath, 'utf8')).resolves.toContain('"mcpServers": {}');
    const entries = await fs.readdir(tempDir);
    expect(entries.some((entry) => entry.startsWith('malformed-mcp.json.corrupt-'))).toBe(true);
  });

  it('returns mode none without lazy Super-MCP recovery when MCP is disabled', async () => {
    delete process.env['MINDSTONE_FORCE_DIRECT_MCP'];
    const configPath = await writeConfig({
      mcpServers: {
        generic: {
          type: 'stdio',
          command: 'node',
          args: ['server.js'],
        },
      },
    });
    const startWithRetries = vi.spyOn(superMcpHttpManager, 'startWithRetries');

    setMcpDisabled(true);
    const resolved = await resolveMcpServers(buildSettings(configPath));

    expect(resolved).toEqual({
      servers: undefined,
      mode: 'none',
      upstreamCount: 0,
      configPath,
    });
    expect(startWithRetries).not.toHaveBeenCalled();
  });
});
