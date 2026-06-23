/**
 * Integration tests for Fly.io auto-provisioning.
 *
 * These tests hit the REAL Fly Machines API and create/destroy actual resources.
 * They are gated behind RUN_FLY_INTEGRATION_TESTS=1 and require a valid Fly token.
 *
 * Run: RUN_FLY_INTEGRATION_TESTS=1 npx vitest run src/core/services/__tests__/flyProvisioningService.integration.test.ts
 *
 * Token resolution order:
 *   1. FLY_API_TOKEN env var
 *   2. `flyctl auth token` (if flyctl is installed)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
/* eslint-disable no-console -- integration test diagnostic output */

const SHOULD_RUN = process.env.RUN_FLY_INTEGRATION_TESTS === '1';

const FLY_MACHINES_BASE = 'https://api.machines.dev';
const FLY_GRAPHQL_URL = 'https://api.fly.io/graphql';
const APP_NAME_PREFIX = 'rebel-test-';
const CLOUD_IMAGE = 'ghcr.io/mindstone/rebel-cloud:latest';
const SECONDS_TO_NS = 1_000_000_000;

function createWorkspaceFixture(dir: string): { expectedFiles: string[] } {
  fs.mkdirSync(path.join(dir, 'subdir'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.md'), '# Meeting Notes\nImportant stuff');
  fs.writeFileSync(path.join(dir, 'subdir/code.ts'), 'export const x = 1;');
  fs.writeFileSync(path.join(dir, '.gitignore'), '*.log\nbuild/\n');
  fs.writeFileSync(path.join(dir, 'debug.log'), 'should be excluded');
  fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'build/output.js'), 'should be excluded');
  try {
    fs.symlinkSync(path.join(dir, 'notes.md'), path.join(dir, 'alias.md'));
  } catch { /* symlinks may not be supported */ }
  return { expectedFiles: ['notes.md', 'subdir/code.ts', '.gitignore'] };
}

function makeSyncClient(baseUrl: string, token: string): { post: (endpoint: string, body: unknown) => Promise<unknown> } {
  return {
    post: async (endpoint: string, body: unknown) => {
      const resp = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
      return resp.json();
    },
  };
}

function readClaudeApiKey(): string | null {
  if (process.env.TEST_CLAUDE_API_KEY) return process.env.TEST_CLAUDE_API_KEY;
  const settingsPath = path.join(
    process.env.HOME || '',
    'Library',
    'Application Support',
    'mindstone-rebel',
    'app-settings.json',
  );
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as { claude?: { apiKey?: string } };
    // SKIP-GATE-INTENT: cloud-provisioning integration test reads the persisted Anthropic API key as a fallback only; this test casts to a minimal local shape rather than depending on @core/rebelCore/settingsAccessors and never reaches the model-resolution path the 260507 hazard guards.
    return settings?.claude?.apiKey ?? null;
  } catch {
    return null;
  }
}

function getFlyToken(): string {
  if (process.env.FLY_API_TOKEN) return process.env.FLY_API_TOKEN;
  try {
    return execSync('flyctl auth token', { encoding: 'utf-8' }).trim();
  } catch {
    throw new Error('No Fly token available. Set FLY_API_TOKEN or install flyctl.');
  }
}

async function flyFetch(token: string, path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${FLY_MACHINES_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    signal: options.signal ?? AbortSignal.timeout(30_000),
  });
}

async function flyGraphQL(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ data?: Record<string, unknown>; errors?: Array<{ message: string }> }> {
  const resp = await fetch(FLY_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  return resp.json() as Promise<{ data?: Record<string, unknown>; errors?: Array<{ message: string }> }>;
}

describe.skipIf(!SHOULD_RUN)('Fly Provisioning Integration Tests', () => {
  let flyToken: string;
  let testAppName: string;
  let machineId: string | undefined;
  let volumeId: string | undefined;
  const region = 'iad';
  const cloudToken = 'test-token-for-integration';
  let workspaceExpectedFiles: string[] = [];
  let sessionIdFromTurn: string | null = null;

  beforeAll(() => {
    flyToken = getFlyToken();
    const suffix = Math.random().toString(36).slice(2, 8);
    testAppName = `${APP_NAME_PREFIX}${suffix}`;
  });

  afterAll(async () => {
    // Safety: only delete apps with our test prefix — never touch production rebel-cloud-* apps
    if (testAppName && testAppName.startsWith(APP_NAME_PREFIX)) {
      try {
        await flyFetch(flyToken, `/v1/apps/${testAppName}?force=true`, { method: 'DELETE' });
      } catch { /* best effort */ }
    }
  }, 30_000);

  it('should validate the Fly API token', async () => {
    const resp = await flyFetch(flyToken, '/v1/apps?org_slug=personal');
    expect(resp.status).toBe(200);
    const body = await resp.json() as { total_apps: number };
    expect(body.total_apps).toBeGreaterThanOrEqual(0);
  }, 15_000);

  it('should create an app', async () => {
    const resp = await flyFetch(flyToken, '/v1/apps', {
      method: 'POST',
      body: JSON.stringify({ app_name: testAppName, org_slug: 'personal' }),
    });
    expect(resp.status).toBe(201);
    const body = await resp.json() as { id: string };
    expect(body.id).toBeTruthy();
  }, 15_000);

  it('should set secrets via GraphQL', async () => {
    const result = await flyGraphQL(flyToken, `
      mutation($input: SetSecretsInput!) {
        setSecrets(input: $input) {
          app { name }
        }
      }
    `, {
      input: {
        appId: testAppName,
        secrets: [{ key: 'REBEL_CLOUD_TOKEN', value: cloudToken }],
      },
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toBeTruthy();
  }, 15_000);

  it('should create a volume', async () => {
    const resp = await flyFetch(flyToken, `/v1/apps/${testAppName}/volumes`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'rebel_data',
        region,
        size_gb: 1,
        encrypted: true,
      }),
    });
    expect([200, 201]).toContain(resp.status);
    const body = await resp.json() as { id: string };
    expect(body.id).toBeTruthy();
    volumeId = body.id;
  }, 30_000);

  it('should create a machine with the cloud image', async () => {
    expect(volumeId).toBeTruthy();

    const machineConfig = {
      image: CLOUD_IMAGE,
      env: {
        PORT: '8080',
        IS_CLOUD_SERVICE: '1',
        NODE_ENV: 'production',
      },
      services: [{
        ports: [
          { port: 443, handlers: ['tls', 'http'] },
          { port: 80, handlers: ['http'] },
        ],
        protocol: 'tcp',
        internal_port: 8080,
        force_instance_key: null,
        concurrency: { type: 'connections', hard_limit: 25, soft_limit: 20 },
        auto_start_machines: true,
        auto_stop_machines: 'stop',
        min_machines_running: 0,
      }],
      mounts: [{ volume: volumeId, path: '/data' }],
      // Use modest VM for tests — cloud-service needs ~1GB+ for node_modules
      guest: { cpu_kind: 'shared', cpus: 2, memory_mb: 2048 },
      checks: {
        health: {
          type: 'http' as const,
          port: 8080,
          path: '/api/health',
          interval: 15 * SECONDS_TO_NS,
          timeout: 5 * SECONDS_TO_NS,
          grace_period: 30 * SECONDS_TO_NS,
        },
      },
    };

    const resp = await flyFetch(flyToken, `/v1/apps/${testAppName}/machines`, {
      method: 'POST',
      body: JSON.stringify({ name: 'rebel-test', region, config: machineConfig }),
    });

    expect(resp.status).toBe(200);
    const body = await resp.json() as { id: string; state: string };
    expect(body.id).toBeTruthy();
    machineId = body.id;
  }, 60_000);

  it('should wait for machine to start', async () => {
    expect(machineId).toBeTruthy();

    // 7.57GB image pull can take several minutes on first deploy
    // Poll the wait endpoint in 60s chunks up to 5 minutes total
    let started = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const resp = await flyFetch(
        flyToken,
        `/v1/apps/${testAppName}/machines/${machineId}/wait?state=started&timeout=60`,
        { signal: AbortSignal.timeout(70_000) },
      );
      console.log(`  wait attempt ${attempt}: HTTP ${resp.status}`);
      if (resp.status === 200) {
        started = true;
        break;
      }
      // 408 = timeout, try again (image still pulling)
    }
    expect(started, 'Machine did not reach started state within 5 minutes').toBe(true);
  }, 360_000);

  it('should have a running machine with services', async () => {
    expect(machineId).toBeTruthy();

    const resp = await flyFetch(flyToken, `/v1/apps/${testAppName}/machines/${machineId}`);
    expect(resp.status).toBe(200);
    const machine = await resp.json() as { state: string; config?: { services?: unknown[] }; events?: Array<{ type: string; status: string; timestamp: number }> };
    console.log(`  machine state: ${machine.state}`);
    console.log(`  services configured: ${machine.config?.services?.length ?? 0}`);
    const lastEvents = (machine.events ?? []).slice(0, 5);
    console.log(`  recent events: ${JSON.stringify(lastEvents.map(e => `${e.type}:${e.status}`))}`);
    expect(['started', 'stopping', 'stopped']).toContain(machine.state);
  }, 15_000);

  it('should allocate a shared IPv4 for routing', async () => {
    // Fly apps created via Machines API may need explicit IP allocation for .fly.dev routing
    const result = await flyGraphQL(flyToken, `
      mutation($input: AllocateIPAddressInput!) {
        allocateIpAddress(input: $input) {
          ipAddress { address type }
        }
      }
    `, {
      input: { appId: testAppName, type: 'shared_v4' },
    });
    console.log(`  IP allocation result: ${JSON.stringify(result.data ?? result.errors)}`);
    expect(result.errors).toBeUndefined();
  }, 15_000);

  it('should become healthy at /api/health', async () => {
    const cloudUrl = `https://${testAppName}.fly.dev`;
    let healthy = false;
    let lastError = '';

    // Machine boot + image pull + app startup can take 2-3 minutes
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const resp = await fetch(`${cloudUrl}/api/health`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (resp.ok) {
          const body = await resp.json() as { status?: string };
          if (body.status === 'ok') {
            healthy = true;
            break;
          }
          lastError = `status: ${JSON.stringify(body)}`;
        } else {
          lastError = `HTTP ${resp.status}`;
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      if (attempt % 10 === 0) {
        console.log(`  health poll attempt ${attempt}: ${lastError}`);
      }
      await new Promise(r => setTimeout(r, 3_000));
    }

    expect(healthy, `Health check failed after 60 attempts. Last error: ${lastError}`).toBe(true);
  }, 240_000);

  it('should be reachable with bridge token auth', async () => {
    const cloudUrl = `https://${testAppName}.fly.dev`;
    const resp = await fetch(`${cloudUrl}/api/settings`, {
      headers: { Authorization: `Bearer ${cloudToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    // 200 = auth works, not 401
    expect(resp.status).toBe(200);
  }, 15_000);

  it('should push workspace fixture files to the provisioned instance', async () => {
    const cloudUrl = `https://${testAppName}.fly.dev`;
    const syncClient = makeSyncClient(cloudUrl, cloudToken);
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-fly-workspace-'));

    try {
      const { expectedFiles } = createWorkspaceFixture(workspaceDir);
      workspaceExpectedFiles = expectedFiles;

      const filesToUpload = [...expectedFiles];
      const symlinkPath = path.join(workspaceDir, 'alias.md');
      if (fs.existsSync(symlinkPath)) {
        filesToUpload.push('alias.md');
      }

      for (const relativePath of filesToUpload) {
        const fileBuffer = fs.readFileSync(path.join(workspaceDir, relativePath));
        await syncClient.post('/api/library/upload-file', {
          path: relativePath,
          content: fileBuffer.toString('base64'),
          encoding: 'base64',
        });
      }
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('should verify workspace manifest includes expected files and excludes ignored files', async () => {
    const cloudUrl = `https://${testAppName}.fly.dev`;
    const syncClient = makeSyncClient(cloudUrl, cloudToken);

    const response = await syncClient.post('/api/library/manifest', {}) as {
      entries: Record<string, { hash: string; size: number }>;
      complete: boolean;
      reasons: string[];
    };
    expect(response.complete).toBe(true);
    const manifest = response.entries;

    const expectedFiles = workspaceExpectedFiles.length > 0
      ? workspaceExpectedFiles
      : ['notes.md', 'subdir/code.ts', '.gitignore'];

    for (const filePath of expectedFiles) {
      expect(manifest[filePath]).toBeDefined();
    }
    expect(manifest['debug.log']).toBeUndefined();
    expect(manifest['build/output.js']).toBeUndefined();
  }, 30_000);

  it('should run an agent turn via websocket', async () => {
    const claudeApiKey = readClaudeApiKey();
    if (!claudeApiKey) {
      console.log('Skipping WS agent turn test: no Claude API key found.');
      return;
    }

    const cloudUrl = `https://${testAppName}.fly.dev`;
    const settingsResp = await fetch(`${cloudUrl}/api/settings`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${cloudToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ claude: { apiKey: claudeApiKey } }),
      signal: AbortSignal.timeout(30_000),
    });
    expect(settingsResp.status).toBe(200);

    const WebSocket = require('ws');
    const ws = new WebSocket(`wss://${testAppName}.fly.dev/api/agent/turn`, {
      headers: { Authorization: `Bearer ${cloudToken}` },
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WS connect timeout')), 15_000);
      ws.on('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      ws.on('error', (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    sessionIdFromTurn = `fly-vertical-${Date.now()}`;
    const events: Array<{ type?: string; text?: string; error?: string }> = [];

    ws.send(JSON.stringify({
      sessionId: sessionIdFromTurn,
      prompt: 'Reply with exactly the word "cloud" and nothing else',
    }));

    const terminalEvent = await new Promise<{ type?: string; text?: string; error?: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error(`Turn timed out. Events: ${events.map((event) => event.type).join(', ')}`));
      }, 60_000);

      ws.on('message', (data: Buffer) => {
        const event = JSON.parse(data.toString()) as { type?: string; text?: string; error?: string };
        events.push(event);
        if (event.type === 'result' || event.type === 'error') {
          clearTimeout(timeout);
          resolve(event);
        }
      });

      ws.on('error', (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    if (ws.readyState === WebSocket.OPEN) ws.close();

    expect(terminalEvent.type).toBe('result');
    const responseText = events
      .map((event) => (typeof event.text === 'string' ? event.text : ''))
      .join(' ')
      .toLowerCase();
    expect(responseText).toContain('cloud');
  }, 90_000);

  it('should expose the new session in summaries for cross-device visibility', async () => {
    if (!sessionIdFromTurn) {
      console.log('Skipping session visibility check: agent turn did not run.');
      return;
    }

    const cloudUrl = `https://${testAppName}.fly.dev`;
    const resp = await fetch(`${cloudUrl}/api/sessions?summaries=true`, {
      headers: { Authorization: `Bearer ${cloudToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    expect(resp.status).toBe(200);

    const sessions = await resp.json() as Array<{ id: string }>;
    expect(sessions.some((session) => session.id === sessionIdFromTurn)).toBe(true);
  }, 30_000);

  it('should clean up by deleting the app', async () => {
    const resp = await flyFetch(flyToken, `/v1/apps/${testAppName}?force=true`, {
      method: 'DELETE',
    });
    expect([200, 202]).toContain(resp.status);
    // Mark as cleaned up so afterAll doesn't double-delete
    testAppName = '';
  }, 15_000);
});
