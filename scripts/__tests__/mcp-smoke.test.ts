/**
 * MCP Smoke Tests — Automated smoke testing for bundled and community MCP servers.
 *
 * Verifies for each MCP:
 * 1. Server starts and connects via MCP SDK Client
 * 2. listTools() returns at least 1 tool
 * 3. Each tool has name, description, and inputSchema
 *
 * Also tests "unconfigured" error handling for MCPs known to return
 * graceful errors when called without credentials.
 *
 * Bundled MCPs whose server.cjs is not built are skipped with a warning (not a failure).
 * Community MCPs are pre-installed via npm into a temp directory and require network access.
 *
 * Run: npx vitest run scripts/__tests__/mcp-smoke.test.ts
 *
 * @see docs/plans/partway/260217_mcp_test_harness.md
 */

import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import {
  createMcpTestClient,
  resolveServerScript,
  assertToolReturnsError,
  preInstallCommunityPackage,
  type McpTestClient,
} from '../mcp-test-harness';

// ─── Configuration ────────────────────────────────────────────────────────────

const PROJECT_ROOT = join(__dirname, '..', '..');
const MCP_CONFIG_PATH = join(PROJECT_ROOT, 'scripts', 'mcp-config.json');

/**
 * Per-MCP overrides for environment variables and CLI args needed to start.
 * Copied from validate-mcp-bundles.ts to ensure consistent behavior.
 */
const MCP_TEST_OVERRIDES: Record<string, { env?: Record<string, string>; args?: string[] }> = {
  'microsoft-mail': { env: { MS_CONFIG_DIR: '/tmp/smoke-test', MS_CLIENT_ID: 'test-client-id' } },
  'microsoft-calendar': { env: { MS_CONFIG_DIR: '/tmp/smoke-test', MS_CLIENT_ID: 'test-client-id' } },
  'microsoft-files': { env: { MS_CONFIG_DIR: '/tmp/smoke-test', MS_CLIENT_ID: 'test-client-id' } },
  'microsoft-teams': { env: { MS_CONFIG_DIR: '/tmp/smoke-test', MS_CLIENT_ID: 'test-client-id' } },
  'microsoft-sharepoint': { env: { MS_CONFIG_DIR: '/tmp/smoke-test', MS_CLIENT_ID: 'test-client-id' } },
  'google-workspace': {
    env: {
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      ACCOUNTS_PATH: '/tmp/smoke-test/accounts.json',
      CREDENTIALS_PATH: '/tmp/smoke-test/credentials',
    },
  },
  'discourse': { args: ['--site', 'https://rebels.mindstone.com'] },
};

/**
 * rebel-* MCPs need mock bridge state to start. Currently no rebel-* MCPs are
 * in bundledMcps (they're internal MCPs registered in bundledMcpManager), but
 * the check is here for forward-compatibility if they're ever added.
 */
const REBEL_MCP_PREFIX = 'rebel-';

/**
 * MCPs known to return {ok: false} or {success: false} when called without credentials.
 * These are tested for graceful unconfigured error handling.
 */
/**
 * MCPs known to return {ok: false} when called without credentials.
 * `stripEnvKeys` ensures the spawned process doesn't inherit real API keys
 * from the developer's environment, which would defeat the test.
 */
const UNCONFIGURED_TEST_MCPS: Record<string, { tool: string; stripEnvKeys: string[]; expectedErrorSubstring?: string }> = {
};

// ─── Discover MCPs ───────────────────────────────────────────────────────────

interface McpSmokeEntry {
  name: string;
  serverScript: string;
  args?: string[];
  env?: Record<string, string>;
  mockBridgeState: boolean;
}

function discoverMcps(): McpSmokeEntry[] {
  if (!existsSync(MCP_CONFIG_PATH)) {
    console.warn(`[mcp-smoke] mcp-config.json not found at ${MCP_CONFIG_PATH}, skipping all`);
    return [];
  }

  const config = JSON.parse(readFileSync(MCP_CONFIG_PATH, 'utf8'));
  const bundledMcps: string[] = config.bundledMcps ?? [];
  const entries: McpSmokeEntry[] = [];

  for (const name of bundledMcps) {
    const serverScript = resolveServerScript(name);

    if (!existsSync(serverScript)) {
      console.warn(`[mcp-smoke] Skipping ${name}: server.cjs not found at ${serverScript}`);
      continue;
    }

    const overrides = MCP_TEST_OVERRIDES[name];
    entries.push({
      name,
      serverScript,
      args: overrides?.args,
      env: overrides?.env,
      mockBridgeState: name.startsWith(REBEL_MCP_PREFIX),
    });
  }

  return entries;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const mcpEntries = discoverMcps();

describe('MCP Smoke Tests', () => {
  // Track client for cleanup in afterEach
  let currentClient: McpTestClient | null = null;

  afterEach(async () => {
    if (currentClient) {
      await currentClient.close();
      currentClient = null;
    }
  });

  if (mcpEntries.length === 0) {
    it.skip('no built MCPs found — run "node scripts/build-bundled-mcps.mjs" first', () => {});
    return;
  }

  for (const entry of mcpEntries) {
    describe(entry.name, () => {
      it('should start and register tools', async () => {
        const client = await createMcpTestClient({
          name: entry.name,
          serverScript: entry.serverScript,
          args: entry.args,
          env: entry.env,
          mockBridgeState: entry.mockBridgeState,
          connectTimeout: 15_000,
        });
        currentClient = client;

        const tools = await client.listTools();

        // Server started and returned tools
        expect(tools.length).toBeGreaterThan(0);

        // Each tool has required schema fields
        for (const tool of tools) {
          expect(tool.name, `Tool missing name`).toBeTruthy();
          expect(tool.description, `Tool "${tool.name}" missing description`).toBeTruthy();
          expect(tool.inputSchema, `Tool "${tool.name}" missing inputSchema`).toBeDefined();
          expect(
            tool.inputSchema.type,
            `Tool "${tool.name}" inputSchema.type should be "object"`,
          ).toBe('object');
        }
      });
    });
  }
});

// ─── Unconfigured Error Tests ─────────────────────────────────────────────────

describe('MCP Unconfigured Error Tests', () => {
  let currentClient: McpTestClient | null = null;

  afterEach(async () => {
    if (currentClient) {
      await currentClient.close();
      currentClient = null;
    }
  });

  // All previously-bundled MCPs that returned unconfigured errors have been
  // migrated to rebel-oss (npx-based) and are tested via Community MCP Smoke
  // Tests below. Keep this block + skipped placeholder so future bundled MCPs
  // that need unconfigured-error coverage can plug in via UNCONFIGURED_TEST_MCPS
  // without re-introducing the empty-describe failure mode.
  if (Object.keys(UNCONFIGURED_TEST_MCPS).length === 0) {
    it.skip('no bundled MCPs require unconfigured-error coverage', () => {});
    return;
  }

  for (const [mcpName, { tool, stripEnvKeys, expectedErrorSubstring }] of Object.entries(UNCONFIGURED_TEST_MCPS)) {
    const serverScript = resolveServerScript(mcpName);

    if (!existsSync(serverScript)) {
      describe(mcpName, () => {
        it.skip(`skipped — server.cjs not built`, () => {});
      });
      continue;
    }

    const overrides = MCP_TEST_OVERRIDES[mcpName];

    // Build env that explicitly strips API keys so dev's local keys don't
    // leak into the spawned process and defeat the unconfigured test
    const strippedEnv: Record<string, string> = { ...overrides?.env };
    for (const key of stripEnvKeys) {
      strippedEnv[key] = '';
    }

    describe(mcpName, () => {
      it(`should return error when calling "${tool}" without API key`, async () => {
        const client = await createMcpTestClient({
          name: `${mcpName}-unconfigured`,
          serverScript,
          args: overrides?.args,
          env: strippedEnv,
          mockBridgeState: mcpName.startsWith(REBEL_MCP_PREFIX),
          connectTimeout: 15_000,
        });
        currentClient = client;

        // Calling a tool without credentials should return a helpful error
        await assertToolReturnsError(client, tool, undefined, {
          expectedErrorSubstring: expectedErrorSubstring ?? 'not configured',
        });
      });

      it(`should not crash after unconfigured tool call`, async () => {
        const client = await createMcpTestClient({
          name: `${mcpName}-unconfigured-stability`,
          serverScript,
          args: overrides?.args,
          env: strippedEnv,
          mockBridgeState: mcpName.startsWith(REBEL_MCP_PREFIX),
          connectTimeout: 15_000,
        });
        currentClient = client;

        // Call the tool (expect error)
        await assertToolReturnsError(client, tool);

        // Server should still be responsive — listTools should still work
        const tools = await client.listTools();
        expect(tools.length).toBeGreaterThan(0);
      });
    });
  }
});

// ─── Community MCP Smoke Tests ────────────────────────────────────────────────

/**
 * Community MCPs spawned via npx. These are tested separately from bundled MCPs
 * because they don't have local server.cjs files — they're fetched from npm.
 *
 * Each entry defines the npx command, required env vars, expected core tools,
 * and an error test to verify auth failure handling.
 */
interface CommunityMcpEntry {
  /** Display name for test output */
  name: string;
  /** npx package specifier (version-pinned) */
  package: string;
  /** Environment variables to pass to the server */
  env: Record<string, string>;
  /** Core tools that should be registered (subset check) */
  expectedTools: string[];
  /** Tool to call for unconfigured/auth error test */
  errorTestTool: string;
  /** Expected substring in error message */
  expectedErrorSubstring: string;
  /** Whether the MCP throws McpError (true) or returns {ok: false} (false) */
  throwsOnError: boolean;
}

const COMMUNITY_MCPS: CommunityMcpEntry[] = [
  {
    name: 'gitlab',
    package: '@zereight/mcp-gitlab@2.0.30',
    env: {
      GITLAB_PERSONAL_ACCESS_TOKEN: 'test-invalid-token',
      GITLAB_API_URL: 'https://gitlab.com',
    },
    expectedTools: ['list_issues', 'list_merge_requests', 'get_project', 'create_issue'],
    errorTestTool: 'list_projects',
    expectedErrorSubstring: '401',
    throwsOnError: true,
  },
  {
    name: 'playwright',
    package: '@playwright/mcp@0.0.68',
    env: {},
    expectedTools: ['browser_navigate', 'browser_click', 'browser_type', 'browser_snapshot', 'browser_take_screenshot'],
    errorTestTool: 'browser_navigate',
    expectedErrorSubstring: 'browser',
    throwsOnError: true,
  },
  {
    name: 'google-maps',
    package: '@modelcontextprotocol/server-google-maps@0.6.2',
    env: {
      GOOGLE_MAPS_API_KEY: 'test-invalid-key',
    },
    expectedTools: ['maps_geocode', 'maps_reverse_geocode', 'maps_search_places', 'maps_place_details', 'maps_distance_matrix', 'maps_elevation', 'maps_directions'],
    errorTestTool: 'maps_geocode',
    expectedErrorSubstring: 'api key is invalid',
    throwsOnError: false,
  },
];

const isWindows = process.platform === 'win32';

// Community MCPs use npx which has known tar/rmdir race conditions on Windows CI
// (ENOTEMPTY errors during package extraction). Skip on Windows.
describe.skipIf(isWindows)('Community MCP Smoke Tests', () => {
  let currentClient: McpTestClient | null = null;

  afterEach(async () => {
    if (currentClient) {
      await currentClient.close();
      currentClient = null;
    }
  });

  for (const entry of COMMUNITY_MCPS) {
    describe(entry.name, () => {
      let binPath: string;
      let installDir: string;

      // Pre-install the package once per community MCP (with retry for Windows npx flakiness)
      beforeAll(async () => {
        const result = await preInstallCommunityPackage(entry.package);
        binPath = result.binPath;
        installDir = result.installDir;
      }, 420_000);

      afterAll(() => {
        try { rmSync(installDir, { recursive: true, force: true }); } catch { /* ignore */ }
      });

      it('should start and register tools', async () => {
        const client = await createMcpTestClient({
          name: `community-${entry.name}`,
          command: 'node',
          args: [binPath],
          env: entry.env,
          connectTimeout: 15_000,
        });
        currentClient = client;

        const tools = await client.listTools();
        expect(tools.length).toBeGreaterThan(0);

        // Verify core tools are present
        const toolNames = tools.map((t) => t.name);
        for (const expected of entry.expectedTools) {
          expect(toolNames, `Missing expected tool: ${expected}`).toContain(expected);
        }

        // Each tool has required schema fields
        for (const tool of tools) {
          expect(tool.name, `Tool missing name`).toBeTruthy();
          expect(tool.description, `Tool "${tool.name}" missing description`).toBeTruthy();
          expect(tool.inputSchema, `Tool "${tool.name}" missing inputSchema`).toBeDefined();
          expect(
            tool.inputSchema.type,
            `Tool "${tool.name}" inputSchema.type should be "object"`,
          ).toBe('object');
        }
      }, 30_000);

      it(`should return error when calling "${entry.errorTestTool}" with invalid credentials`, async () => {
        const client = await createMcpTestClient({
          name: `community-${entry.name}-error`,
          command: 'node',
          args: [binPath],
          env: entry.env,
          connectTimeout: 15_000,
        });
        currentClient = client;

        if (entry.throwsOnError) {
          try {
            await client.callToolRaw(entry.errorTestTool, {});
            expect.unreachable(`Expected MCP error for ${entry.errorTestTool} with invalid credentials`);
          } catch (error: unknown) {
            const msg = String(error).toLowerCase();
            expect(
              msg.includes(entry.expectedErrorSubstring.toLowerCase()),
              `Error should contain "${entry.expectedErrorSubstring}", got: ${String(error).substring(0, 200)}`,
            ).toBe(true);
          }
        } else {
          await assertToolReturnsError(client, entry.errorTestTool, undefined, {
            expectedErrorSubstring: entry.expectedErrorSubstring,
          });
        }
      }, 30_000);

      it('should not crash after error and still respond to listTools', async () => {
        const client = await createMcpTestClient({
          name: `community-${entry.name}-stability`,
          command: 'node',
          args: [binPath],
          env: entry.env,
          connectTimeout: 15_000,
        });
        currentClient = client;

        // Trigger an error
        try {
          await client.callToolRaw(entry.errorTestTool, {});
        } catch {
          // Expected — some MCPs throw
        }

        // Server should still be responsive
        const tools = await client.listTools();
        expect(tools.length).toBeGreaterThan(0);
      }, 30_000);
    });
  }
});
