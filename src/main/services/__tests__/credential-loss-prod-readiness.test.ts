// Production-readiness regression test for the BRIDGE_STATE_PATH credential loss bug.
// Simulates a v0.4.35 user upgrading to current dev: verifies credential preservation,
// {{BRIDGE_STATE_PATH}} resolution, MINDSTONE_REBEL_BRIDGE_STATE → MCP_HOST_BRIDGE_STATE
// rename reconciliation, Salesforce REBEL-13Y backfill, and stranded literal repair.
//
// Owned by the developer's local sanity check before promoting dev → main.
// Lives alongside the existing migration test suite to share path-alias config.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  configureBundledMcpManager,
  migrateBundledConnectorsToNpx,
  repairBridgeStatePathLiterals,
  resolveConnectorCatalogPath,
} from '../bundledMcpManager';
import { backfillCatalogIds } from '@core/services/mcpConfigManager';

let tempUserData: string;
let realResourcesDir: string;
let expectedBridgePath: string;

beforeAll(async () => {
  tempUserData = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-cred-prod-'));
  // Configs live under tempUserData/mcp/ (mimicking production layout where
  // super-mcp-router.json sits at userData/mcp/). MCP_BASE_DIR resolves to
  // path.dirname(configPath), so this makes {{MCP_BASE_DIR}} match {{BRIDGE_STATE_PATH}}.
  await fs.mkdir(path.join(tempUserData, 'mcp'), { recursive: true });
  // Point at the REAL resources/ directory so we exercise the actual production catalog,
  // not a synthetic fixture (gap flagged in 260504 Salesforce postmortem).
  realResourcesDir = path.resolve(__dirname, '..', '..', '..', '..', 'resources');
  expectedBridgePath = path.join(tempUserData, 'mcp', 'rebel-inbox-bridge.json');
  configureBundledMcpManager({
    userDataDir: tempUserData,
    resourcesDir: realResourcesDir,
    isPackaged: false,
  });
  // Sanity: verify the real catalog is loadable from this path.
  const catalogPath = resolveConnectorCatalogPath();
  await fs.access(catalogPath);
});

afterAll(async () => {
  await fs.rm(tempUserData, { recursive: true, force: true }).catch(() => undefined);
});

async function writeFixture(name: string, content: unknown): Promise<string> {
  const p = path.join(tempUserData, 'mcp', name);
  await fs.writeFile(p, JSON.stringify(content, null, 2), 'utf8');
  return p;
}

async function readConfig(p: string): Promise<{ mcpServers: Record<string, any> }> {
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

describe('production-readiness: credential preservation across migrations', () => {
  it('Scenario 1 — preserves credentials for the original 9 BRIDGE_STATE_PATH connectors', async () => {
    const configPath = await writeFixture('scenario-1.json', {
      mcpServers: {
        Runway: {
          command: 'node',
          args: ['/path/to/resources/mcp/runway/build/index.js'],
          catalogId: 'bundled-runway',
          email: 'preserve@example.com',
          lastConnectedAt: 1234567890,
          env: {
            RUNWAYML_API_SECRET: 'fake-runway-secret-must-survive',
            MINDSTONE_REBEL_BRIDGE_STATE: '{{BRIDGE_STATE_PATH}}',
          },
        },
        Workday: {
          command: 'node',
          args: ['/path/to/resources/mcp/workday/build/index.js'],
          catalogId: 'bundled-workday',
          env: {
            WORKDAY_HOST: 'fake-host.workday.com',
            WORKDAY_TENANT: 'fake-tenant',
            WORKDAY_CLIENT_ID: 'fake-client-id',
            WORKDAY_CLIENT_SECRET: 'fake-client-secret',
            WORKDAY_REFRESH_TOKEN: 'fake-refresh-token',
            MINDSTONE_REBEL_BRIDGE_STATE: '{{BRIDGE_STATE_PATH}}',
          },
        },
        Gamma: {
          command: 'node',
          args: ['/path/to/resources/mcp/gamma/build/index.js'],
          catalogId: 'bundled-gamma',
          env: {
            GAMMA_API_KEY: 'fake-gamma-key-must-survive',
            MINDSTONE_REBEL_BRIDGE_STATE: '{{BRIDGE_STATE_PATH}}',
          },
        },
        ElevenLabs: {
          command: 'node',
          args: ['/path/to/resources/mcp/elevenlabs/build/index.js'],
          catalogId: 'bundled-elevenlabs',
          env: {
            ELEVENLABS_API_KEY: 'fake-elevenlabs-key',
            MINDSTONE_REBEL_BRIDGE_STATE: '{{BRIDGE_STATE_PATH}}',
          },
        },
        NanoBanana: {
          command: 'node',
          args: ['/path/to/resources/mcp/nano-banana/build/index.js'],
          catalogId: 'bundled-nano-banana',
          env: {
            GEMINI_API_KEY: 'fake-gemini-key',
            MINDSTONE_REBEL_BRIDGE_STATE: '{{BRIDGE_STATE_PATH}}',
          },
        },
      },
    });

    await migrateBundledConnectorsToNpx(configPath);
    await repairBridgeStatePathLiterals(configPath);

    const { mcpServers } = await readConfig(configPath);

    // The migration renames entries to the catalog `name` field (which differs from
    // the previous bundled `serverName` for some connectors). This is a real
    // user-visible behavior, separate from the credential-loss bug.
    const runway = mcpServers['Runway ML'];
    const nanoBanana = mcpServers['Nano Banana'];

    expect(runway).toBeDefined();
    expect(runway.env.RUNWAYML_API_SECRET).toBe('fake-runway-secret-must-survive');
    expect(runway.email).toBe('preserve@example.com');
    expect(runway.lastConnectedAt).toBe(1234567890);
    expect(runway.env.MCP_HOST_BRIDGE_STATE).toBe(expectedBridgePath);
    expect(runway.command).toBe('npx');
    const runwayLegacy = runway.env.MINDSTONE_REBEL_BRIDGE_STATE;
    expect(runwayLegacy === undefined || runwayLegacy === expectedBridgePath).toBe(true);

    expect(mcpServers.Workday.env.WORKDAY_HOST).toBe('fake-host.workday.com');
    expect(mcpServers.Workday.env.WORKDAY_TENANT).toBe('fake-tenant');
    expect(mcpServers.Workday.env.WORKDAY_CLIENT_ID).toBe('fake-client-id');
    expect(mcpServers.Workday.env.WORKDAY_CLIENT_SECRET).toBe('fake-client-secret');
    expect(mcpServers.Workday.env.WORKDAY_REFRESH_TOKEN).toBe('fake-refresh-token');

    expect(mcpServers.Gamma.env.GAMMA_API_KEY).toBe('fake-gamma-key-must-survive');
    expect(mcpServers.Gamma.env.MCP_HOST_BRIDGE_STATE).toBe(expectedBridgePath);

    expect(mcpServers.ElevenLabs.env.ELEVENLABS_API_KEY).toBe('fake-elevenlabs-key');
    expect(nanoBanana).toBeDefined();
    expect(nanoBanana.env.GEMINI_API_KEY).toBe('fake-gemini-key');

    const serialized = JSON.stringify(mcpServers);
    expect(serialized).not.toContain('{{BRIDGE_STATE_PATH}}');
    expect(serialized).not.toContain('{{MCP_BASE_DIR}}');
  });

  it('Scenario 2 — connectors using the older {{MCP_BASE_DIR}} pattern survive the rename', async () => {
    const configPath = await writeFixture('scenario-2.json', {
      mcpServers: {
        Fathom: {
          command: 'node',
          args: ['/path/to/resources/mcp/fathom/build/index.js'],
          catalogId: 'bundled-fathom',
          env: {
            FATHOM_API_KEY: 'fake-fathom-api-key',
            MINDSTONE_REBEL_BRIDGE_STATE: '/old/stale/path.json',
          },
        },
        Zendesk: {
          command: 'node',
          args: ['/path/to/resources/mcp/zendesk/build/index.js'],
          catalogId: 'bundled-zendesk',
          email: 'user@example.com',
          env: {
            ZENDESK_OAUTH_TOKEN: 'fake-zendesk-token',
          },
        },
        PandaDoc: {
          command: 'node',
          args: ['/path/to/resources/mcp/pandadoc/build/index.js'],
          catalogId: 'bundled-pandadoc',
          env: {
            PANDADOC_API_KEY: 'fake-pandadoc-key',
          },
        },
      },
    });

    await migrateBundledConnectorsToNpx(configPath);
    await repairBridgeStatePathLiterals(configPath);

    const { mcpServers } = await readConfig(configPath);

    expect(mcpServers.Fathom.env.FATHOM_API_KEY).toBe('fake-fathom-api-key');
    expect(mcpServers.Fathom.env.MCP_HOST_BRIDGE_STATE).toBe(expectedBridgePath);

    expect(mcpServers.Zendesk.env.ZENDESK_OAUTH_TOKEN).toBe('fake-zendesk-token');
    expect(mcpServers.Zendesk.email).toBe('user@example.com');

    expect(mcpServers.PandaDoc.env.PANDADOC_API_KEY).toBe('fake-pandadoc-key');
  });

  it('Scenario 3 — Salesforce REBEL-13Y backfill converges legacy entries with env union', async () => {
    // Note: requires `configPaths` array for backfillCatalogIds safety check
    // (only mutates "router" configs identified by configPaths array).
    const configPath = await writeFixture('scenario-3.json', {
      configPaths: [],
      mcpServers: {
        Salesforce: {
          command: 'node',
          args: ['/Applications/Mindstone Rebel.app/Contents/Resources/mcp-generated/salesforce/server.cjs'],
          env: {
            SALESFORCE_CLIENT_ID: 'fake-old-client-id',
            SALESFORCE_CLIENT_SECRET: 'fake-old-client-secret',
          },
        },
        'Salesforce-user@example.com': {
          command: 'node',
          args: ['/Applications/Mindstone Rebel.app/Contents/Resources/mcp-generated/salesforce/server.cjs'],
          email: 'user@example.com',
          lastConnectedAt: 9999999999,
          env: {
            SALESFORCE_REFRESH_TOKEN: 'fake-newer-refresh-token',
          },
        },
      },
    });

    // backfillCatalogIds runs FIRST at startup — May 4 fix (35f3b593c) restored
    // the missing `Salesforce` and `Salesforce-` entries to the lookup tables.
    const backfillResult = await backfillCatalogIds(configPath, tempUserData);
    // Then migration runs — converges both legacy entries to a single npx Salesforce.
    await migrateBundledConnectorsToNpx(configPath);

    const { mcpServers } = await readConfig(configPath);

    expect(backfillResult.updated).toBe(2);
    expect(mcpServers.Salesforce).toBeDefined();
    expect(mcpServers['Salesforce-user@example.com']).toBeUndefined();
    expect(mcpServers.Salesforce.command).toBe('npx');
    expect(mcpServers.Salesforce.env.SALESFORCE_CLIENT_ID).toBe('fake-old-client-id');
    expect(mcpServers.Salesforce.env.SALESFORCE_CLIENT_SECRET).toBe('fake-old-client-secret');
    expect(mcpServers.Salesforce.env.SALESFORCE_REFRESH_TOKEN).toBe('fake-newer-refresh-token');
    expect(mcpServers.Salesforce.email).toBe('user@example.com');
    expect(mcpServers.Salesforce.lastConnectedAt).toBe(9999999999);
  });

  it('Scenario 4 — repairBridgeStatePathLiterals fixes stranded literals on already-migrated entries', async () => {
    const configPath = await writeFixture('scenario-4.json', {
      mcpServers: {
        Runway: {
          command: 'npx',
          args: ['-y', '@mindstone-engineering/mcp-server-runway@0.3.1'],
          catalogId: 'bundled-runway',
          env: {
            RUNWAYML_API_SECRET: 'fake-already-set-key',
            MCP_HOST_BRIDGE_STATE: '{{BRIDGE_STATE_PATH}}',
            MINDSTONE_REBEL_BRIDGE_STATE: '{{BRIDGE_STATE_PATH}}',
          },
        },
      },
    });

    const repairResult = await repairBridgeStatePathLiterals(configPath);

    const { mcpServers } = await readConfig(configPath);

    expect(mcpServers.Runway.env.RUNWAYML_API_SECRET).toBe('fake-already-set-key');
    expect(mcpServers.Runway.env.MCP_HOST_BRIDGE_STATE).toBe(expectedBridgePath);
    expect(mcpServers.Runway.env.MINDSTONE_REBEL_BRIDGE_STATE).toBe(expectedBridgePath);
    expect(repairResult.repaired.length).toBeGreaterThan(0);
  });
});
