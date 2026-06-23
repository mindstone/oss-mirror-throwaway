import { existsSync, readFileSync } from 'fs';
import type { SetupField } from '../src/shared/types/mcp';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const DEFAULT_NPX_TIMEOUT_MS = 90_000;
const DEFAULT_UVX_TIMEOUT_MS = 120_000;
const DEFAULT_BUNDLED_TIMEOUT_MS = 30_000;

const REBEL_MCP_PREFIX = 'rebel-';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

const CATALOG_PATH = join(PROJECT_ROOT, 'resources', 'connector-catalog.json');
const MCP_CONFIG_PATH = join(PROJECT_ROOT, 'scripts', 'mcp-config.json');
const MCP_GENERATED_DIR = join(PROJECT_ROOT, 'resources', 'mcp-generated');
const MCP_HANDWRITTEN_DIR = join(PROJECT_ROOT, 'resources', 'mcp');

// Handwritten MCPs shipping as plain `.cjs` under resources/mcp/<name>/server.cjs.
// All require the bridge state mock and resolve their catalog id from connector-catalog.json.
// Deprecated ghosts (rebel-internal) are intentionally excluded.
const HANDWRITTEN_MCP_DIRS = [
  'rebel-inbox',
  'rebel-meetings',
  'rebel-search-and-conversations',
  'rebel-automations',
  'rebel-spaces',
  'rebel-settings',
  'rebel-mcp-connectors',
  'rebel-diagnostics',
  'rebel-canvas',
  'rebel-plugins',
  'rebel-app-bridge',
] as const;

export const COMMUNITY_SKIP_LIST: Record<string, string> = {
  'browser-mcp': 'Requires Chrome extension installed',
  'brave-search': 'Crashes on startup without valid BRAVE_API_KEY',
  'chartmogul': 'uvx package provides no executable entrypoint',
  looker: 'Requires GCP Looker instance + API credentials + Google Cloud APIs enabled',
  bigquery: 'Requires GCP project with BigQuery API enabled + Application Default Credentials',
  postgres: 'Crashes on startup without valid DATABASE_URL',
  mongodb: 'Crashes on startup without valid mongodb:// connection string',
  databricks: 'Go binary crashes on startup without valid DATABRICKS_HOST/DATABRICKS_TOKEN',
  exa: 'Crashes on startup without valid EXA_API_KEY',
};

export const MCP_TEST_OVERRIDES: Record<string, { env?: Record<string, string>; args?: string[] }> = {
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
  discourse: { args: ['--site', 'https://rebels.mindstone.com'] },
};

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
  bundledConfig?: {
    serverName?: string;
  };
  setupFields?: Array<{
    id: string;
    label: string;
    type: SetupField['type'];
    placeholder?: string;
    envVar?: string;
    default?: string;
    options?: Array<{ value: string; label?: string }>;
  }>;
}

interface CatalogFile {
  connectors?: CatalogConnector[];
}

interface McpConfigFile {
  bundledMcps?: string[];
}

export interface CommunityMcpEntry {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  runtime: 'npx' | 'uvx' | 'other';
  timeoutMs: number;
}

export interface BundledMcpEntry {
  name: string;
  connectorId?: string;
  serverScript: string;
  args?: string[];
  env?: Record<string, string>;
  mockBridgeState: boolean;
  timeoutMs: number;
}

function resolveServerScript(mcpName: string): string {
  return join(MCP_GENERATED_DIR, mcpName, 'server.cjs');
}

const readCatalog = (): CatalogConnector[] => {
  const parsed = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as CatalogFile;
  return parsed.connectors ?? [];
};

interface SelectFieldOption {
  value: string;
  label?: string;
}

export function dummyValueForField(field: {
  type: SetupField['type'];
  placeholder?: string;
  default?: string;
  options?: SelectFieldOption[];
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

function classifyRuntime(command: string): 'npx' | 'uvx' | 'other' {
  if (command === 'npx') return 'npx';
  if (command === 'uvx') return 'uvx';
  return 'other';
}

const normalizeForLookup = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

function resolveBundledConnectorId(mcpName: string, connectors: CatalogConnector[]): string | undefined {
  const bundledConnectors = connectors.filter((connector) => connector.provider === 'bundled');
  const directId = bundledConnectors.find((connector) => connector.id === mcpName);
  if (directId) return directId.id;

  const prefixedId = bundledConnectors.find((connector) => connector.id === `bundled-${mcpName}`);
  if (prefixedId) return prefixedId.id;

  const normalizedTarget = normalizeForLookup(mcpName);
  for (const connector of bundledConnectors) {
    const candidates = [
      connector.id,
      connector.id.replace(/^bundled-/, ''),
      connector.name,
      connector.bundledConfig?.serverName,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);

    if (candidates.some((candidate) => normalizeForLookup(candidate) === normalizedTarget)) {
      return connector.id;
    }
  }

  return undefined;
}

/**
 * Auto-discovers community MCPs from connector-catalog.json.
 * Includes only community providers with stdio transport and a command.
 */
export function discoverCommunityMcps(): CommunityMcpEntry[] {
  const connectors = readCatalog();
  const entries: CommunityMcpEntry[] = [];

  for (const connector of connectors) {
    if (connector.provider !== 'community') continue;
    if (!connector.mcpConfig) continue;
    if (connector.mcpConfig.transport !== 'stdio') continue;
    if (!connector.mcpConfig.command) continue;

    if (connector.id in COMMUNITY_SKIP_LIST) {
      console.warn(
        `[community-discovery] Skipping ${connector.id}: ${COMMUNITY_SKIP_LIST[connector.id]}`,
      );
      continue;
    }

    const runtime = classifyRuntime(connector.mcpConfig.command);

    const env: Record<string, string> = {};
    if (connector.mcpConfig.env) {
      Object.assign(env, connector.mcpConfig.env);
    }

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

    entries.push({
      id: connector.id,
      name: connector.name,
      command: connector.mcpConfig.command,
      args: connector.mcpConfig.args ?? [],
      env,
      runtime,
      timeoutMs: runtime === 'uvx' ? DEFAULT_UVX_TIMEOUT_MS : DEFAULT_NPX_TIMEOUT_MS,
    });
  }

  return entries;
}

/**
 * Auto-discovers rebel-oss MCPs from connector-catalog.json.
 * Includes only rebel-oss providers with stdio transport and a command.
 * Resolves env var placeholders ({{MCP_CONFIG_DIR}}, {{MCP_BASE_DIR}}).
 */
export function discoverRebelOssMcps(): CommunityMcpEntry[] {
  const connectors = readCatalog();
  const entries: CommunityMcpEntry[] = [];

  for (const connector of connectors) {
    if (connector.provider !== 'rebel-oss') continue;
    if (!connector.mcpConfig) continue;
    if (connector.mcpConfig.transport !== 'stdio') continue;
    if (!connector.mcpConfig.command) continue;

    const runtime = classifyRuntime(connector.mcpConfig.command);

    const env: Record<string, string> = {};
    if (connector.mcpConfig.env) {
      Object.assign(env, connector.mcpConfig.env);
    }

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

    entries.push({
      id: connector.id,
      name: connector.name,
      command: connector.mcpConfig.command,
      args: connector.mcpConfig.args ?? [],
      env,
      runtime,
      timeoutMs: runtime === 'uvx' ? DEFAULT_UVX_TIMEOUT_MS : DEFAULT_NPX_TIMEOUT_MS,
    });
  }

  return entries;
}

/**
 * Auto-discovers bundled MCPs from scripts/mcp-config.json.
 */
export function discoverBundledMcps(): BundledMcpEntry[] {
  if (!existsSync(MCP_CONFIG_PATH)) {
    console.warn(`[bundled-discovery] mcp-config.json not found at ${MCP_CONFIG_PATH}, skipping all`);
    return [];
  }

  const config = JSON.parse(readFileSync(MCP_CONFIG_PATH, 'utf8')) as McpConfigFile;
  const bundledMcps = config.bundledMcps ?? [];
  const connectors = readCatalog();
  const entries: BundledMcpEntry[] = [];

  for (const name of bundledMcps) {
    const serverScript = resolveServerScript(name);
    if (!existsSync(serverScript)) {
      console.warn(`[bundled-discovery] Skipping ${name}: server.cjs not found at ${serverScript}`);
      continue;
    }

    const overrides = MCP_TEST_OVERRIDES[name];
    entries.push({
      name,
      connectorId: resolveBundledConnectorId(name, connectors),
      serverScript,
      args: overrides?.args,
      env: overrides?.env,
      mockBridgeState: name.startsWith(REBEL_MCP_PREFIX),
      timeoutMs: DEFAULT_BUNDLED_TIMEOUT_MS,
    });
  }

  return entries;
}

const HANDWRITTEN_MCP_TO_CONNECTOR_ID: Record<string, string> = {
  'rebel-app-bridge': 'bundled-app-bridge',
};

function resolveHandwrittenConnectorId(mcpDirName: string): string {
  return HANDWRITTEN_MCP_TO_CONNECTOR_ID[mcpDirName] ?? mcpDirName;
}

export function discoverHandwrittenMcps(): BundledMcpEntry[] {
  const entries: BundledMcpEntry[] = [];

  for (const mcpDirName of HANDWRITTEN_MCP_DIRS) {
    const serverScript = join(MCP_HANDWRITTEN_DIR, mcpDirName, 'server.cjs');
    if (!existsSync(serverScript)) {
      console.warn(`[handwritten-discovery] Skipping ${mcpDirName}: server.cjs not found at ${serverScript}`);
      continue;
    }

    entries.push({
      name: mcpDirName,
      connectorId: resolveHandwrittenConnectorId(mcpDirName),
      serverScript,
      mockBridgeState: true,
      timeoutMs: DEFAULT_BUNDLED_TIMEOUT_MS,
    });
  }

  return entries;
}
