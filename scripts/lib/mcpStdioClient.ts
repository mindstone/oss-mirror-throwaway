/**
 * Standalone MCP stdio client spawner.
 *
 * A tiny, non-vitest counterpart to `scripts/mcp-test-harness.ts` —
 * usable from plain `tsx` scripts. Spawns an MCP server, connects via the
 * MCP SDK stdio transport, and returns a small client wrapper.
 *
 * The harness uses `import { describe, it, expect } from 'vitest'` at module
 * load, so it can only run inside a vitest process. This file deliberately
 * imports nothing from vitest, so CLI runners (e.g.
 * `scripts/test-oss-connectors.ts`) can use it.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export interface SpawnedMcpClient {
  listTools(): Promise<Tool[]>;
  callToolRaw(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

export interface SpawnMcpOptions {
  /** Friendly name for log/error messages */
  name: string;
  /** Spawn command (e.g., 'npx', 'node') */
  command: string;
  /** CLI args to pass to the command */
  args: string[];
  /** Extra env vars for the spawned process (merged onto a minimal base env) */
  env?: Record<string, string>;
  /** Write a mock bridge-state JSON file and set MINDSTONE_REBEL_BRIDGE_STATE to it. */
  mockBridgeState?: boolean;
  /** Connect timeout in ms (default: 30000) */
  connectTimeoutMs?: number;
}

const SAFE_ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'TMPDIR', 'TEMP', 'TMP',
  'NODE_PATH', 'NPM_CONFIG_CACHE', 'npm_config_cache',
  'VIRTUAL_ENV', 'PYTHONPATH',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'COMSPEC',
  'HOMEDRIVE', 'HOMEPATH', 'ProgramFiles', 'ProgramFiles(x86)',
];

function buildMinimalEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SAFE_ENV_KEYS) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function createMockBridgeStateFile(): string {
  const p = join(tmpdir(), `oss-test-bridge-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(p, JSON.stringify({ port: 1, token: 'oss-test-client' }));
  return p;
}

/**
 * Spawn an MCP server via stdio and connect.
 *
 * Always uses a minimal env (no developer credentials inherited).
 * Caller is responsible for calling `close()` to release the process.
 */
export async function spawnMcpStdioClient(opts: SpawnMcpOptions): Promise<SpawnedMcpClient> {
  const connectTimeoutMs = opts.connectTimeoutMs ?? 30_000;
  const env: Record<string, string> = {
    ...buildMinimalEnv(),
    NODE_ENV: 'test',
    ...(opts.env ?? {}),
  };

  let bridgeFile: string | undefined;
  if (opts.mockBridgeState) {
    bridgeFile = createMockBridgeStateFile();
    env.MINDSTONE_REBEL_BRIDGE_STATE = bridgeFile;
  }

  const transport = new StdioClientTransport({
    command: opts.command,
    args: opts.args,
    env,
  });

  const client = new Client({ name: `${opts.name}-oss-test`, version: '1.0.0' });
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const connectPromise = client.connect(transport);
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`[${opts.name}] Connect timeout after ${connectTimeoutMs}ms`)),
        connectTimeoutMs,
      );
    });
    await Promise.race([connectPromise, timeoutPromise]);
    clearTimeout(timeoutId);
  } catch (err) {
    clearTimeout(timeoutId);
    try { await transport.close(); } catch { /* ignore */ }
    if (bridgeFile && existsSync(bridgeFile)) {
      try { unlinkSync(bridgeFile); } catch { /* ignore */ }
    }
    throw err;
  }

  return {
    async listTools(): Promise<Tool[]> {
      const r = await client.listTools();
      return r.tools;
    },
    async callToolRaw(name, args): Promise<CallToolResult> {
      const r = await client.callTool({ name, arguments: args ?? {} });
      return r as CallToolResult;
    },
    async close(): Promise<void> {
      try { await client.close(); } catch { /* ignore */ }
      if (bridgeFile && existsSync(bridgeFile)) {
        try { unlinkSync(bridgeFile); } catch { /* ignore */ }
      }
    },
  };
}
