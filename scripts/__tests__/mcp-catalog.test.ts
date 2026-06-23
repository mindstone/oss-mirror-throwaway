/**
 * MCP Catalog Tests — Automated testing for non-bundled MCPs in connector-catalog.json.
 *
 * Auto-discovers community/catalog MCPs that use stdio transport and runs smoke checks:
 * 1. Server starts via npx/uvx and connects via MCP SDK Client
 * 2. listTools() returns at least 1 tool with valid schemas
 *
 * These tests are network-dependent (npx/uvx download packages) and separated from
 * bundled smoke tests. They are gated behind the RUN_MCP_CATALOG_TESTS=1 env var
 * and have generous timeouts for package installation.
 *
 * Run: npm run test:mcp:catalog
 * Or:  RUN_MCP_CATALOG_TESTS=1 npx vitest run scripts/__tests__/mcp-catalog.test.ts
 *
 * @see docs/plans/partway/260217_mcp_test_harness.md
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import {
  createMcpTestClient,
  type McpTestClient,
} from '../mcp-test-harness';
import type { SetupField } from '../../src/shared/types/mcp';

// ─── Configuration ────────────────────────────────────────────────────────────

const PROJECT_ROOT = join(__dirname, '..', '..');
const CATALOG_PATH = join(PROJECT_ROOT, 'resources', 'connector-catalog.json');

const RUN_CATALOG_TESTS = process.env.RUN_MCP_CATALOG_TESTS === '1';

/** Default timeout for npx-based MCPs (package download + startup) */
const DEFAULT_NPX_TIMEOUT_MS = 90_000;
/** Default timeout for uvx-based MCPs (package download + startup) */
const DEFAULT_UVX_TIMEOUT_MS = 120_000;
/** Configurable override via env var */
const parsedTimeout = parseInt(process.env.MCP_CATALOG_TIMEOUT_MS ?? '', 10);
const CUSTOM_TIMEOUT_MS = Number.isFinite(parsedTimeout) ? parsedTimeout : undefined;

/**
 * Community / rebel-oss MCPs to skip — interactive setup, requires external dependencies,
 * or known to be broken for automated smoke testing.
 */
const COMMUNITY_SKIP_LIST: Record<string, string> = {
  'browser-mcp': 'Requires Chrome extension installed',
  'chartmogul': 'uvx package provides no executable entrypoint',
  'looker': 'Requires GCP Looker instance + API credentials + Google Cloud APIs enabled',
  'bigquery': 'Requires GCP project with BigQuery API enabled + Application Default Credentials',
  'postgres': 'Crashes on startup without valid DATABASE_URL',
  'mongodb': 'Crashes on startup without valid mongodb:// connection string',
  'databricks': 'Go binary crashes on startup without valid DATABRICKS_HOST/DATABRICKS_TOKEN',
  'exa': 'Crashes on startup without valid EXA_API_KEY',
  'shopify': 'Upstream package omits tool descriptions in server.tool() registration (GeLi2001/shopify-mcp)',
  'bundled-google-analytics': 'Crashes on startup without a valid GOOGLE_APPLICATION_CREDENTIALS file (Google ADC); CI provides only a dummy path',
  'bundled-office': 'Requires Microsoft Office desktop apps installed locally (Word/Excel/PowerPoint); not available in CI runners',
  'bundled-quickbooks': 'Other QB credentials (clientId, clientSecret, refreshToken, realmId) are dummy values that the QB MCP rejects; the QUICKBOOKS_ENVIRONMENT select-field portion of this skip reason is now resolved by dummyValueForField select handling, but the credential blockers remain.',
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface CatalogConnector {
  id: string;
  name: string;
  provider: string;
  mcpConfig?: {
    transport: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  };
  setupFields?: Array<{
    id: string;
    label: string;
    type: string;
    placeholder?: string;
    envVar?: string;
    default?: string;
    options?: Array<{ value: string; label?: string }>;
  }>;
}

interface CommunityMcpEntry {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  runtime: 'npx' | 'uvx' | 'other';
  timeoutMs: number;
}

// ─── Discovery ────────────────────────────────────────────────────────────────

/**
 * Generate a dummy value for a setup field based on its type and placeholder.
 *
 * When a field has a `placeholder`, it often contains a realistic default value
 * (e.g., port numbers like "993", booleans like "true", URLs). We prefer the
 * placeholder over a generic dummy when it looks like a usable value — this
 * prevents crashes in MCPs that parse env vars as integers or booleans.
 */
function dummyValueForField(field: {
  type: SetupField['type'];
  placeholder?: string;
  default?: string;
  options?: Array<{ value: string; label?: string }>;
}): string {
  if (field.placeholder) {
    if (/^\d+$/.test(field.placeholder)) return field.placeholder;
    if (field.placeholder === 'true' || field.placeholder === 'false') return field.placeholder;
    if (field.placeholder.startsWith('http')) return field.placeholder;
  }

  switch (field.type) {
    case 'url':
      return 'http://localhost:9999';
    case 'select': {
      if (typeof field.default === 'string' && field.default.length > 0) return field.default;
      const firstOption = field.options?.[0];
      if (firstOption && typeof firstOption.value === 'string' && firstOption.value.length > 0) {
        return firstOption.value;
      }
      return 'smoke-test-dummy';
    }
    case 'password':
    case 'text':
    case 'boolean':
      return 'smoke-test-dummy';
    default: {
      const _exhaustive: never = field.type;
      throw new Error(`Unhandled SetupField type: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Determine runtime type from command string.
 */
function classifyRuntime(command: string): 'npx' | 'uvx' | 'other' {
  if (command === 'npx') return 'npx';
  if (command === 'uvx') return 'uvx';
  return 'other';
}

/**
 * Auto-discover eligible community and rebel-oss MCPs from connector-catalog.json.
 *
 * Filters:
 * 1. provider === "community" or "rebel-oss"
 * 2. mcpConfig.transport === "stdio"
 * 3. mcpConfig.command exists
 * 4. NOT in skip list
 */
function discoverCommunityMcps(): CommunityMcpEntry[] {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  const connectors: CatalogConnector[] = catalog.connectors ?? [];
  const entries: CommunityMcpEntry[] = [];

  for (const connector of connectors) {
    // Filter: community or rebel-oss provider with stdio transport and a command
    if (connector.provider !== 'community' && connector.provider !== 'rebel-oss') continue;
    if (!connector.mcpConfig) continue;
    if (connector.mcpConfig.transport !== 'stdio') continue;
    if (!connector.mcpConfig.command) continue;

    // Skip list
    if (connector.id in COMMUNITY_SKIP_LIST) {
      console.warn(
        `[community-smoke] Skipping ${connector.id}: ${COMMUNITY_SKIP_LIST[connector.id]}`,
      );
      continue;
    }

    const runtime = classifyRuntime(connector.mcpConfig.command);

    // Build env vars: merge mcpConfig.env + dummy values from setupFields
    const env: Record<string, string> = {};

    // Merge mcpConfig.env (e.g., MongoDB read-only flags)
    if (connector.mcpConfig.env) {
      Object.assign(env, connector.mcpConfig.env);
    }

    // Resolve rebel-oss env placeholders ({{MCP_CONFIG_DIR}}, {{MCP_BASE_DIR}})
    if (connector.provider === 'rebel-oss') {
      const tempBase = mkdtempSync(join(tmpdir(), 'mcp-catalog-test-'));
      const serverName = connector.bundledConfig?.serverName ?? connector.name;
      const configDir = join(tempBase, serverName.toLowerCase());
      for (const [key, val] of Object.entries(env)) {
        env[key] = val
          .replace(/\{\{MCP_CONFIG_DIR\}\}/g, configDir)
          .replace(/\{\{MCP_BASE_DIR\}\}/g, tempBase);
      }
    }

    // Set dummy values for setupFields that have envVar
    if (connector.setupFields) {
      for (const field of connector.setupFields) {
        if (field.envVar) {
          env[field.envVar] = dummyValueForField({
            type: field.type,
            placeholder: field.placeholder,
            default: field.default,
            options: field.options,
          });
        }
      }
    }

    // Determine timeout
    const timeoutMs = CUSTOM_TIMEOUT_MS
      ?? (runtime === 'uvx' ? DEFAULT_UVX_TIMEOUT_MS : DEFAULT_NPX_TIMEOUT_MS);

    entries.push({
      id: connector.id,
      name: connector.name,
      command: connector.mcpConfig.command,
      args: connector.mcpConfig.args ?? [],
      env,
      runtime,
      timeoutMs,
    });
  }

  return entries;
}

// ─── Preflight Checks ────────────────────────────────────────────────────────

/**
 * Check if a command is available on the system PATH.
 * Uses platform-appropriate command (which on Unix, where on Windows).
 */
function isCommandAvailable(command: string): boolean {
  try {
    const check = process.platform === 'win32' ? 'where' : 'which';
    execSync(`${check} ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ─── Rebel-OSS Catalog Entry Tests (always run) ─────────────────────────────

interface RebelOssConnector {
  id: string;
  name: string;
  provider: string;
  mcpConfig?: {
    transport?: string;
    command?: string;
    args?: string[];
  };
  verifiedSource?: string;
  icon?: string;
  maturity?: string;
  requiresSetup?: boolean;
}

function discoverRebelOssConnectors(): RebelOssConnector[] {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  const connectors: RebelOssConnector[] = catalog.connectors ?? [];
  return connectors.filter((c) => c.provider === 'rebel-oss');
}

describe('rebel-oss catalog entries', () => {
  const rebelOssConnectors = discoverRebelOssConnectors();

  it('should have at least one rebel-oss connector in catalog', () => {
    expect(rebelOssConnectors.length).toBeGreaterThan(0);
  });

  for (const connector of rebelOssConnectors) {
    describe(connector.id, () => {
      it('should use stdio transport with npx command', () => {
        expect(connector.mcpConfig).toBeDefined();
        expect(connector.mcpConfig!.transport).toBe('stdio');
        expect(connector.mcpConfig!.command).toBe('npx');
        expect(connector.mcpConfig!.args).toBeDefined();
        expect(connector.mcpConfig!.args!.length).toBeGreaterThan(0);
      });

      it('should have a verified source URL', () => {
        expect(connector.verifiedSource).toBeDefined();
        expect(connector.verifiedSource).toMatch(/^https?:\/\//);
      });

      it('should have required metadata fields', () => {
        expect(connector.name).toBeTruthy();
        expect(connector.icon).toBeTruthy();
      });
    });
  }
});

// ─── Email-IMAP bridge connectors ────────────────────────────────────────────
//
// `bundled-icloud-mail`, `bundled-yahoo-mail`, `bundled-custom-email` all wrap
// `@mindstone/mcp-server-email-imap` (with different EMAIL_IMAP_PROVIDER env
// values). Their catalog `tools[]` arrays must mirror the upstream package's
// registered tool list, so the Settings UI tool count and the runtime tool
// list agree without a startup discovery call.
//
// If the upstream package adds/removes a tool, this test fails and forces an
// update of `EMAIL_IMAP_TOOL_NAMES` (sourced from the package's
// `dist/tools/*.js` registerTool() calls).

const EMAIL_IMAP_TOOL_NAMES = [
  'configure_email_imap',
  'email_list_mailboxes',
  'email_get_mailbox_status',
  'email_search_messages',
  'email_get_message',
  'email_move_messages',
  'email_set_flags',
  'email_send',
  'email_save_draft',
] as const;

const EMAIL_IMAP_BRIDGE_IDS = ['bundled-icloud-mail', 'bundled-yahoo-mail', 'bundled-custom-email'];

describe('email-imap bridge connectors', () => {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as { connectors: RebelOssConnector[] };

  for (const id of EMAIL_IMAP_BRIDGE_IDS) {
    const connector = catalog.connectors.find((c) => c.id === id);

    describe(id, () => {
      it('exists in the catalog', () => {
        expect(connector, `connector ${id} not found in catalog`).toBeDefined();
      });

      it(`tools[] mirrors @mindstone/mcp-server-email-imap (${EMAIL_IMAP_TOOL_NAMES.length} tools)`, () => {
        if (!connector) return;
        const tools = (connector as RebelOssConnector & { tools?: Array<{ name: string }> }).tools ?? [];
        const names = tools.map((t) => t.name).sort();
        expect(names).toEqual([...EMAIL_IMAP_TOOL_NAMES].sort());
      });
    });
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe.skipIf(!RUN_CATALOG_TESTS)('MCP Catalog Tests', () => {
  const entries = discoverCommunityMcps();
  let currentClient: McpTestClient | null = null;

  afterEach(async () => {
    if (currentClient) {
      await currentClient.close();
      currentClient = null;
    }
  });

  if (entries.length === 0) {
    it.skip('no eligible community MCPs found in connector-catalog.json', () => {});
    return;
  }

  // Preflight: check which runtimes are available
  const runtimesNeeded = new Set(entries.map((e) => e.runtime));
  const runtimeAvailability: Record<string, boolean> = {};
  for (const runtime of runtimesNeeded) {
    if (runtime === 'other') continue;
    runtimeAvailability[runtime] = isCommandAvailable(runtime);
    if (!runtimeAvailability[runtime]) {
      console.warn(
        `[community-smoke] Runtime "${runtime}" not found on PATH — MCPs requiring it will be skipped`,
      );
    }
  }

  for (const entry of entries) {
    describe(entry.id, () => {
      // Skip if runtime is not available
      if (entry.runtime !== 'other' && !runtimeAvailability[entry.runtime]) {
        it.skip(`skipped — ${entry.runtime} not available on PATH`, () => {});
        return;
      }

      it(
        'should start and register tools',
        async () => {
          const client = await createMcpTestClient({
            name: entry.id,
            command: entry.command,
            args: entry.args,
            env: entry.env,
            connectTimeout: entry.timeoutMs,
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
        },
        entry.timeoutMs,
      );
    });
  }
});
