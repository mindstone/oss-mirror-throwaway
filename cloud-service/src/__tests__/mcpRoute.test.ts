/**
 * Tests for PUT /api/mcp/config — the desktop → cloud MCP config sync
 * endpoint. The interesting case here is the post-write catalog-env
 * backfill (SF-7): cloudMigrationService strips default-only sandbox env
 * keys (RUNWAY_ALLOWED_ROOT / RUNWAY_DOWNLOAD_ROOT) before transmission so
 * the cloud surface re-resolves them with surface-coherent paths. The boot-
 * time backfill in `cloud-service/src/bootstrap.ts` only runs once, so any
 * post-boot PUT must re-run the backfill BEFORE scheduling the Super-MCP
 * restart — otherwise the restarted Super-MCP picks up a config without
 * sandbox env, falls back to tmpdir, and breaks workspace access.
 *
 * Plan: docs/plans/260520_runway_sandbox_central_trusted_roots.md (SF-7).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const { requestRestartForConfigChangeDetachedMock } = vi.hoisted(() => ({
  requestRestartForConfigChangeDetachedMock: vi.fn(),
}));
let configSnapshotAtRestartScheduling: Record<string, unknown> | null = null;

vi.mock('@core/services/superMcpHttpManager', () => ({
  superMcpHttpManager: {
    isConfigured: vi.fn(() => true),
    requestRestartForConfigChangeDetached: requestRestartForConfigChangeDetachedMock,
  },
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: () => ({}),
}));

vi.mock('@core/services/mcp/mcpConfigResolver', () => ({
  resolveMcpConfigPath: () => null,
}));

vi.mock('../services/mcp/bundledMcpCloudRegistrationBridge', () => ({
  discoverBundledOAuthMcps: vi.fn(async () => []),
}));

import { handleMcpConfig } from '../routes/mcp';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- allowlisted in scripts/check-cross-surface-imports.ts
import { configureBundledMcpManager } from '@main/services/bundledMcpManager';

interface MockResShape {
  _status: number;
  _body: unknown;
}

function createMockReq(body: unknown, method = 'PUT'): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.method = method;
  req.headers = { host: 'localhost' };
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function createMockRes(): http.ServerResponse & { _status: number; _body: unknown } {
  const res = {
    _status: 0,
    _body: null as unknown,
    writeHead(this: MockResShape, status: number) {
      this._status = status;
      return this;
    },
    end(this: MockResShape, data?: string | Buffer) {
      const str = typeof data === 'string' ? data : data ? data.toString('utf8') : undefined;
      if (str) {
        try {
          this._body = JSON.parse(str);
        } catch {
          this._body = str;
        }
      }
      return this;
    },
    setHeader() { return this; },
    getHeader() { return undefined; },
  } as unknown as http.ServerResponse & { _status: number; _body: unknown };
  return res;
}

const catalogEntries = [
  {
    id: 'bundled-runway',
    name: 'Runway',
    provider: 'rebel-oss',
    mcpConfig: {
      command: 'npx',
      args: ['-y', '@mindstone/mcp-server-runway@0.3.2'],
      env: {
        MCP_HOST_BRIDGE_STATE: '{{BRIDGE_STATE_PATH}}',
        RUNWAY_ALLOWED_ROOT: '{{ALLOWED_ROOTS_ANCESTOR}}',
        RUNWAY_DOWNLOAD_ROOT: '{{ALLOWED_ROOTS_ANCESTOR_DOWNLOADS}}',
      },
    },
  },
];

describe('PUT /api/mcp/config — post-write catalog-env backfill (SF-7)', () => {
  let tempUserData: string;
  let tempResources: string;
  let configPath: string;
  const originalUserData = process.env.REBEL_USER_DATA;

  beforeEach(async () => {
    vi.clearAllMocks();
    configSnapshotAtRestartScheduling = null;
    tempUserData = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-mcp-route-user-'));
    tempResources = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-mcp-route-resources-'));
    configPath = path.join(tempUserData, 'mcp', 'super-mcp-router.json');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      path.join(tempResources, 'connector-catalog.json'),
      JSON.stringify({ connectors: catalogEntries }, null, 2),
      'utf8',
    );
    configureBundledMcpManager({
      userDataDir: tempUserData,
      resourcesDir: tempResources,
      isPackaged: false,
    });
    process.env.REBEL_USER_DATA = tempUserData;

    // Capture the persisted config at the moment requestRestartForConfigChangeDetached
    // is invoked so we can assert ordering: backfill must have run BEFORE
    // restart was scheduled, otherwise Super-MCP picks up a config without
    // sandbox env and the spawn path falls back to tmpdir.
    requestRestartForConfigChangeDetachedMock.mockImplementation((request: { configPath: string; context: string }) => {
      try {
        const raw = require('node:fs').readFileSync(request.configPath, 'utf8');
        configSnapshotAtRestartScheduling = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        configSnapshotAtRestartScheduling = null;
      }
      return Promise.resolve();
    });
  });

  afterEach(async () => {
    if (originalUserData === undefined) {
      delete process.env.REBEL_USER_DATA;
    } else {
      process.env.REBEL_USER_DATA = originalUserData;
    }
    await fs.rm(tempUserData, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(tempResources, { recursive: true, force: true }).catch(() => undefined);
  });

  it('runs catalog-env backfill after writing config so a Runway entry missing sandbox keys gets them re-resolved before the Super-MCP restart is scheduled', async () => {
    const req = createMockReq({
      config: {
        mcpServers: {
          Runway: {
            command: 'npx',
            args: ['-y', '@mindstone/mcp-server-runway@0.3.2'],
            catalogId: 'bundled-runway',
            env: {
              MCP_HOST_BRIDGE_STATE: '/tmp/bridge.json',
              RUNWAYML_API_SECRET: 'key_test',
            },
          },
        },
      },
    });
    const res = createMockRes();

    await handleMcpConfig(req, res);

    expect(res._status).toBe(200);
    expect(requestRestartForConfigChangeDetachedMock).toHaveBeenCalledTimes(1);
    expect(requestRestartForConfigChangeDetachedMock).toHaveBeenCalledWith(expect.objectContaining({
      configPath,
      context: 'cloud-config-sync',
    }));

    const persistedRaw = await fs.readFile(configPath, 'utf8');
    const persisted = JSON.parse(persistedRaw) as {
      mcpServers: Record<string, { env: Record<string, string> }>;
    };
    const runwayEnv = persisted.mcpServers.Runway.env;
    expect(runwayEnv.RUNWAY_ALLOWED_ROOT).toBeDefined();
    expect(runwayEnv.RUNWAY_DOWNLOAD_ROOT).toBeDefined();
    expect(runwayEnv.RUNWAY_ALLOWED_ROOT).not.toContain('{{');
    expect(runwayEnv.RUNWAY_DOWNLOAD_ROOT).not.toContain('{{');
    expect(runwayEnv.RUNWAY_DOWNLOAD_ROOT).toBe(
      path.join(runwayEnv.RUNWAY_ALLOWED_ROOT, 'runway-mcp'),
    );
    expect(runwayEnv.MCP_HOST_BRIDGE_STATE).toBe('/tmp/bridge.json');
    expect(runwayEnv.RUNWAYML_API_SECRET).toBe('key_test');

    expect(configSnapshotAtRestartScheduling).not.toBeNull();
    const snapshotServers = configSnapshotAtRestartScheduling?.mcpServers as
      | Record<string, { env: Record<string, string> }>
      | undefined;
    expect(snapshotServers?.Runway?.env?.RUNWAY_ALLOWED_ROOT).toBeDefined();
    expect(snapshotServers?.Runway?.env?.RUNWAY_DOWNLOAD_ROOT).toBeDefined();
  });

  it('scrubs a stale desktop RUNWAY_ALLOWED_ROOT that survived an older migration before scheduling restart', async () => {
    const stalePath = path.join(
      os.tmpdir(),
      'rebel-cloud-route-stale-' + Date.now(),
    );
    const req = createMockReq({
      config: {
        mcpServers: {
          Runway: {
            command: 'npx',
            args: ['-y', '@mindstone/mcp-server-runway@0.3.2'],
            catalogId: 'bundled-runway',
            env: {
              RUNWAY_ALLOWED_ROOT: stalePath,
              RUNWAY_DOWNLOAD_ROOT: path.join(stalePath, 'runway-mcp'),
            },
          },
        },
      },
    });
    const res = createMockRes();

    await handleMcpConfig(req, res);

    expect(res._status).toBe(200);
    expect(requestRestartForConfigChangeDetachedMock).toHaveBeenCalledTimes(1);
    expect(requestRestartForConfigChangeDetachedMock).toHaveBeenCalledWith(expect.objectContaining({
      configPath,
      context: 'cloud-config-sync',
    }));

    const persistedRaw = await fs.readFile(configPath, 'utf8');
    const persisted = JSON.parse(persistedRaw) as {
      mcpServers: Record<string, { env: Record<string, string> }>;
    };
    const runwayEnv = persisted.mcpServers.Runway.env;
    expect(runwayEnv.RUNWAY_ALLOWED_ROOT).not.toBe(stalePath);
    expect(runwayEnv.RUNWAY_ALLOWED_ROOT).not.toContain('{{');
    expect(runwayEnv.RUNWAY_DOWNLOAD_ROOT).not.toContain('{{');
    expect(runwayEnv.RUNWAY_DOWNLOAD_ROOT).toBe(
      path.join(runwayEnv.RUNWAY_ALLOWED_ROOT, 'runway-mcp'),
    );
  });

  it('still schedules a restart even when no entries need backfill (route remains a no-op past the backfill call for clean configs)', async () => {
    const validRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-cloud-route-valid-'));
    try {
      const req = createMockReq({
        config: {
          mcpServers: {
            Runway: {
              command: 'npx',
              args: ['-y', '@mindstone/mcp-server-runway@0.3.2'],
              catalogId: 'bundled-runway',
              env: {
                RUNWAY_ALLOWED_ROOT: validRoot,
                RUNWAY_DOWNLOAD_ROOT: path.join(validRoot, 'runway-mcp'),
              },
            },
          },
        },
      });
      const res = createMockRes();

      await handleMcpConfig(req, res);

      expect(res._status).toBe(200);
      expect(requestRestartForConfigChangeDetachedMock).toHaveBeenCalledTimes(1);
      expect(requestRestartForConfigChangeDetachedMock).toHaveBeenCalledWith(expect.objectContaining({
        configPath,
        context: 'cloud-config-sync',
      }));

      const persistedRaw = await fs.readFile(configPath, 'utf8');
      const persisted = JSON.parse(persistedRaw) as {
        mcpServers: Record<string, { env: Record<string, string> }>;
      };
      expect(persisted.mcpServers.Runway.env.RUNWAY_ALLOWED_ROOT).toBe(validRoot);
      expect(persisted.mcpServers.Runway.env.RUNWAY_DOWNLOAD_ROOT).toBe(
        path.join(validRoot, 'runway-mcp'),
      );
    } finally {
      await fs.rm(validRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('writes OAuth token sync files under REBEL_USER_DATA in test context', async () => {
    const req = createMockReq({
      config: {
        mcpServers: {},
      },
      oauthTokens: [
        {
          packageId: '@mindstone/mcp-server-google-workspace',
          type: 'tokens',
          data: { access_token: 'test-token' },
        },
      ],
    });
    const res = createMockRes();

    await handleMcpConfig(req, res);

    expect(res._status).toBe(200);
    const tokenPath = path.join(
      tempUserData,
      '.super-mcp',
      'oauth-tokens',
      '_mindstone_mcp-server-google-workspace_tokens.json',
    );
    await expect(fs.readFile(tokenPath, 'utf8')).resolves.toContain('test-token');
  });
});
