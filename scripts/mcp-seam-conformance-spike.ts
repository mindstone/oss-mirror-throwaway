#!/usr/bin/env -S node --import tsx
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { z } from 'zod';
import {
  SUPER_MCP_REST_ENDPOINTS,
  SuperMcpSkippedServersResponseProducerSchema,
  SuperMcpToolCatalogResponseProducerSchema,
  SuperMcpToolConfigHashResponseSchema,
  SuperMcpToolManifestResponseSchema,
} from '@core/rebelCore/superMcpContract';

const RUN_FLAG = 'RUN_REAL_SUPER_MCP_CONFORMANCE';
const DEFAULT_TIMEOUT_MS = 15_000;

interface CheckResult {
  endpoint: string;
  status: 'ok';
}

async function main(): Promise<void> {
  if (process.env[RUN_FLAG] !== '1') {
    console.log(`${RUN_FLAG}=1 not set; real Super-MCP conformance spike skipped.`);
    console.log(
      `Run: ${RUN_FLAG}=1 node --import tsx scripts/mcp-seam-conformance-spike.ts`,
    );
    return;
  }

  const cliPath = path.join(process.cwd(), 'super-mcp', 'dist', 'cli.js');
  if (!existsSync(cliPath)) {
    throw new Error(`Missing ${cliPath}. Build first with: cd super-mcp && npm run build`);
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-super-mcp-conformance-'));
  const configPath = path.join(tempDir, 'super-mcp-config.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      $schema: 'https://raw.githubusercontent.com/mindstone/Super-MCP/main/super-mcp-config.schema.json',
      mcpServers: {},
    }, null, 2),
    'utf8',
  );

  const port = await findOpenPort();
  const child = spawn(process.execPath, [
    cliPath,
    '--transport',
    'http',
    '--port',
    String(port),
    '--config',
    configPath,
    '--log-level',
    'warn',
  ], {
    cwd: path.join(process.cwd(), 'super-mcp'),
    env: {
      ...process.env,
      HOME: tempDir,
      USERPROFILE: tempDir,
      SUPER_MCP_DATA_DIR: tempDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    stderr += String(chunk);
  });

  try {
    await waitForHttp(port, child, DEFAULT_TIMEOUT_MS);
    const baseUrl = `http://127.0.0.1:${port}`;
    const checks: CheckResult[] = [];

    checks.push(await validateEndpoint(
      baseUrl,
      SUPER_MCP_REST_ENDPOINTS.TOOLS,
      SuperMcpToolCatalogResponseProducerSchema,
    ));
    checks.push(await validateEndpoint(
      baseUrl,
      SUPER_MCP_REST_ENDPOINTS.TOOLS_SELECTED_PACKAGES,
      SuperMcpToolCatalogResponseProducerSchema,
    ));
    checks.push(await validateEndpoint(
      baseUrl,
      SUPER_MCP_REST_ENDPOINTS.TOOLS_CONFIG_HASH,
      SuperMcpToolConfigHashResponseSchema,
    ));
    checks.push(await validateEndpoint(
      baseUrl,
      SUPER_MCP_REST_ENDPOINTS.TOOLS_MANIFEST,
      SuperMcpToolManifestResponseSchema,
    ));
    checks.push(await validateEndpoint(
      baseUrl,
      SUPER_MCP_REST_ENDPOINTS.SKIPPED_SERVERS,
      SuperMcpSkippedServersResponseProducerSchema,
    ));

    const statsPayload = await fetchJson(baseUrl, SUPER_MCP_REST_ENDPOINTS.STATS);
    if (!isRecord(statsPayload)) {
      throw new Error(`${SUPER_MCP_REST_ENDPOINTS.STATS} returned non-object JSON`);
    }
    checks.push({ endpoint: SUPER_MCP_REST_ENDPOINTS.STATS, status: 'ok' });

    console.log(JSON.stringify({
      status: 'ok',
      port,
      checks,
      note: 'Real use_tool output is not driven by this empty-config HTTP spike; validate via npm run cli for connector-backed tool output.',
    }, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}${stderr.trim() ? `\nSuper-MCP stderr:\n${stderr.trim()}` : ''}`);
  } finally {
    await stopChild(child);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function validateEndpoint<T extends z.ZodTypeAny>(
  baseUrl: string,
  endpoint: string,
  schema: T,
): Promise<CheckResult> {
  const payload = await fetchJson(baseUrl, endpoint);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 10)
      .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`${endpoint} failed producer-strict schema validation: ${issues}`);
  }
  return { endpoint, status: 'ok' };
}

async function fetchJson(baseUrl: string, endpoint: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}${endpoint}`);
  if (!response.ok) {
    throw new Error(`${endpoint} returned HTTP ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

async function waitForHttp(
  port: number,
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`Super-MCP exited early with code ${child.exitCode}`);
    }
    try {
      await fetchJson(`http://127.0.0.1:${port}`, SUPER_MCP_REST_ENDPOINTS.TOOLS_CONFIG_HASH);
      return;
    } catch {
      await delay(200);
    }
  }
  throw new Error(`Timed out waiting for Super-MCP HTTP on port ${port}`);
}

async function findOpenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to allocate TCP port')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>(resolve => child.once('exit', () => resolve())),
    delay(2_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }),
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
