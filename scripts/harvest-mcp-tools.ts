#!/usr/bin/env npx tsx

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  COMMUNITY_SKIP_LIST,
  discoverBundledMcps,
  discoverCommunityMcps,
  discoverHandwrittenMcps,
  discoverRebelOssMcps,
  type BundledMcpEntry,
  type CommunityMcpEntry,
} from './mcp-discovery';

type HarvestMode = 'community' | 'bundled' | 'handwritten' | 'oauth' | 'rebel-oss' | 'all';

interface CliOptions {
  mode: HarvestMode;
  write: boolean;
  diff: boolean;
  superMcpUrl?: string;
  parallel: boolean;
  verifyAnnotations: boolean;
}

interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

interface ToolManifest {
  name: string;
  description?: string;
  annotations?: ToolAnnotations;
}

interface RawToolManifestLike {
  name?: unknown;
  description?: unknown;
  summary?: unknown;
  annotations?: unknown;
}

interface CatalogConnector {
  id: string;
  name: string;
  provider: string;
  mcpConfig?: {
    transport?: string;
    command?: string;
    oauth?: boolean;
  };
  tools?: ToolManifest[];
}

interface ConnectorCatalog {
  version: number;
  connectors: CatalogConnector[];
}

interface HarvestState {
  results: Record<string, ToolManifest[]>;
  failed: Set<string>;
  skipped: Set<string>;
  targeted: Set<string>;
  harvested: Set<string>;
}

interface ConnectorDiff {
  connectorId: string;
  added: string[];
  removed: string[];
  changedDescriptions: Array<{
    name: string;
    before?: string;
    after?: string;
  }>;
}

interface ConnectedToolPackage {
  package_id: string;
  name?: string;
}

interface McpTestConfig {
  name: string;
  serverScript?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  mockBridgeState?: boolean;
  connectTimeout?: number;
}

interface McpTestClient {
  listTools(): Promise<Array<{ name?: unknown; description?: unknown; summary?: unknown; annotations?: unknown }>>;
  close(): Promise<void>;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');
const CATALOG_PATH = join(PROJECT_ROOT, 'resources', 'connector-catalog.json');

const SUPER_MCP_CLIENT_INFO = {
  name: 'mcp-tool-harvester',
  version: '1.0.0',
};

const DEFAULT_OAUTH_TIMEOUT_MS = 30_000;

const MODE_VALUES: HarvestMode[] = ['community', 'bundled', 'handwritten', 'oauth', 'rebel-oss', 'all'];

const SAFE_ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'TMPDIR', 'TEMP', 'TMP',
  'NODE_PATH', 'NPM_CONFIG_CACHE', 'npm_config_cache',
  'VIRTUAL_ENV', 'PYTHONPATH',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'COMSPEC',
  'HOMEDRIVE', 'HOMEPATH', 'ProgramFiles', 'ProgramFiles(x86)',
];

type CreateMcpTestClientFn = (config: McpTestConfig) => Promise<McpTestClient>;

let cachedCreateMcpTestClient: CreateMcpTestClientFn | null = null;
let attemptedHarnessImport = false;

function buildMinimalEnv(): Record<string, string> {
  const minimal: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      minimal[key] = value;
    }
  }
  return minimal;
}

function createMockBridgeState(): string {
  const bridgePath = join(tmpdir(), `rebel-harvest-bridge-${process.pid}-${Date.now()}.json`);
  writeFileSync(bridgePath, JSON.stringify({ port: 1, token: 'mcp-harvester' }));
  return bridgePath;
}

async function createMcpTestClientFallback(config: McpTestConfig): Promise<McpTestClient> {
  const {
    name,
    serverScript,
    command,
    args = [],
    env = {},
    mockBridgeState,
    connectTimeout = 10_000,
  } = config;

  if (!command && !serverScript) {
    throw new Error(`[${name}] Either command or serverScript must be provided`);
  }

  if (!command && serverScript && !existsSync(serverScript)) {
    throw new Error(`[${name}] Server script not found: ${serverScript}`);
  }

  const spawnCommand = command ?? 'node';
  const spawnArgs = command ? args : [serverScript!, ...args];

  const baseEnv = command
    ? buildMinimalEnv()
    : { ...(process.env as Record<string, string>) };

  const processEnv: Record<string, string> = {
    ...baseEnv,
    NODE_ENV: 'test',
    ...env,
  };

  let bridgeStatePath: string | undefined;
  if (mockBridgeState) {
    bridgeStatePath = createMockBridgeState();
    processEnv.MINDSTONE_REBEL_BRIDGE_STATE = bridgeStatePath;
  }

  const transport = new StdioClientTransport({
    command: spawnCommand,
    args: spawnArgs,
    env: processEnv,
  });

  const client = new Client({ name: `${name}-harvest`, version: '1.0.0' });

  let timeoutId: NodeJS.Timeout | undefined;
  try {
    const connectPromise = client.connect(transport);
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`[${name}] Connection timeout after ${connectTimeout}ms`)),
        connectTimeout,
      );
    });
    await Promise.race([connectPromise, timeoutPromise]);
  } catch (error) {
    try {
      await transport.close();
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }

  return {
    async listTools() {
      const result = await client.listTools();
      return result.tools;
    },

    async close() {
      try {
        await client.close();
      } catch {
        // Ignore close errors
      }

      if (bridgeStatePath) {
        try {
          unlinkSync(bridgeStatePath);
        } catch {
          // Ignore cleanup errors
        }
      }
    },
  };
}

async function getCreateMcpTestClient(): Promise<CreateMcpTestClientFn> {
  if (cachedCreateMcpTestClient) {
    return cachedCreateMcpTestClient;
  }

  if (!attemptedHarnessImport) {
    attemptedHarnessImport = true;
    try {
      const harness = await import('./mcp-test-harness');
      if (typeof harness.createMcpTestClient === 'function') {
        cachedCreateMcpTestClient = harness.createMcpTestClient as CreateMcpTestClientFn;
        return cachedCreateMcpTestClient;
      }
    } catch (error) {
      console.warn(
        `[harvest] Falling back to local MCP client factory because scripts/mcp-test-harness.ts could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  cachedCreateMcpTestClient = createMcpTestClientFallback;
  return cachedCreateMcpTestClient;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    mode: 'all',
    write: false,
    diff: false,
    parallel: false,
    verifyAnnotations: false,
  };

  for (const arg of argv) {
    if (arg.startsWith('--mode=')) {
      const value = arg.slice('--mode='.length) as HarvestMode;
      if (!MODE_VALUES.includes(value)) {
        throw new Error(`Invalid --mode value "${value}". Expected one of: ${MODE_VALUES.join(', ')}`);
      }
      options.mode = value;
      continue;
    }

    if (arg === '--write') {
      options.write = true;
      continue;
    }

    if (arg === '--diff') {
      options.diff = true;
      continue;
    }

    if (arg.startsWith('--super-mcp-url=')) {
      const value = arg.slice('--super-mcp-url='.length).trim();
      if (!value) {
        throw new Error('--super-mcp-url must be a non-empty URL');
      }
      options.superMcpUrl = value;
      continue;
    }

    if (arg === '--parallel') {
      options.parallel = true;
      continue;
    }

    if (arg === '--verify-annotations') {
      options.verifyAnnotations = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function readCatalog(): ConnectorCatalog {
  return JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as ConnectorCatalog;
}

function trimOptional(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractAnnotations(raw: unknown): ToolAnnotations | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;

  const ann = raw as Record<string, unknown>;
  const result: ToolAnnotations = {};
  let hasValue = false;

  if (typeof ann.title === 'string') { result.title = ann.title; hasValue = true; }
  if (typeof ann.readOnlyHint === 'boolean') { result.readOnlyHint = ann.readOnlyHint; hasValue = true; }
  if (typeof ann.destructiveHint === 'boolean') { result.destructiveHint = ann.destructiveHint; hasValue = true; }
  if (typeof ann.idempotentHint === 'boolean') { result.idempotentHint = ann.idempotentHint; hasValue = true; }
  if (typeof ann.openWorldHint === 'boolean') { result.openWorldHint = ann.openWorldHint; hasValue = true; }

  return hasValue ? result : undefined;
}

function normalizeToolManifests(tools: ReadonlyArray<RawToolManifestLike>): ToolManifest[] {
  const byName = new Map<string, ToolManifest>();

  for (const tool of tools) {
    const name = trimOptional(tool.name);
    if (!name) continue;

    const description = trimOptional(tool.description) ?? trimOptional(tool.summary);
    const annotations = extractAnnotations(tool.annotations);
    const existing = byName.get(name);

    if (!existing) {
      const manifest: ToolManifest = { name };
      if (description) manifest.description = description;
      if (annotations) manifest.annotations = annotations;
      byName.set(name, manifest);
      continue;
    }

    if (!existing.description && description) {
      existing.description = description;
    }
    if (!existing.annotations && annotations) {
      existing.annotations = annotations;
    }
  }

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function mergeToolManifests(existing: ToolManifest[] | undefined, incoming: ToolManifest[]): ToolManifest[] {
  const merged = new Map<string, ToolManifest>();

  for (const tool of existing ?? []) {
    merged.set(tool.name, { ...tool });
  }

  for (const tool of incoming) {
    const current = merged.get(tool.name);
    if (!current) {
      merged.set(tool.name, { ...tool });
      continue;
    }

    if (!current.description && tool.description) {
      current.description = tool.description;
    }
    if (!current.annotations && tool.annotations) {
      current.annotations = tool.annotations;
    }
  }

  return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function sortedUnique(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function buildModes(mode: HarvestMode): Array<'community' | 'bundled' | 'handwritten' | 'oauth' | 'rebel-oss'> {
  if (mode === 'all') return ['community', 'bundled', 'handwritten', 'oauth', 'rebel-oss'];
  return [mode];
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  }) as Promise<T>;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = new Array(Math.max(1, concurrency)).fill(null).map(async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) return;
      await worker(item);
    }
  });

  await Promise.all(workers);
}

function extractTextContent(result: unknown, toolName: string): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    throw new Error(`No response from ${toolName}`);
  }

  const textBlock = content.find(
    (entry) =>
      typeof entry === 'object'
      && entry !== null
      && (entry as { type?: string }).type === 'text'
      && typeof (entry as { text?: string }).text === 'string',
  ) as { text: string } | undefined;

  if (!textBlock) {
    throw new Error(`No text response from ${toolName}`);
  }

  return textBlock.text;
}

async function harvestCommunity(
  catalog: ConnectorCatalog,
  state: HarvestState,
  concurrency: number,
): Promise<void> {
  const createMcpTestClient = await getCreateMcpTestClient();

  const eligible = catalog.connectors.filter(
    (connector) => connector.provider === 'community'
      && connector.mcpConfig?.transport === 'stdio'
      && typeof connector.mcpConfig.command === 'string',
  );

  for (const connector of eligible) {
    state.targeted.add(connector.id);
    if (connector.id in COMMUNITY_SKIP_LIST) {
      state.skipped.add(connector.id);
    }
  }

  const entries = discoverCommunityMcps();

  await runWithConcurrency(entries, concurrency, async (entry: CommunityMcpEntry) => {
    let client: McpTestClient | null = null;

    try {
      client = await createMcpTestClient({
        name: `harvest-community-${entry.id}`,
        command: entry.command,
        args: entry.args,
        env: entry.env,
        connectTimeout: entry.timeoutMs,
      });

      const tools = await withTimeout(
        client.listTools(),
        entry.timeoutMs,
        `[community:${entry.id}] tools/list timed out after ${entry.timeoutMs}ms`,
      );

      const manifests = normalizeToolManifests(tools);
      if (manifests.length === 0) {
        console.warn(`[harvest:community] ${entry.id} returned 0 tools`);
      }

      state.results[entry.id] = manifests;
      state.harvested.add(entry.id);
      state.failed.delete(entry.id);
    } catch (error) {
      console.warn(
        `[harvest:community] Failed ${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      state.failed.add(entry.id);
    } finally {
      if (client) {
        try {
          await client.close();
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  });
}

async function harvestBundled(
  state: HarvestState,
  concurrency: number,
): Promise<void> {
  const createMcpTestClient = await getCreateMcpTestClient();

  const entries = discoverBundledMcps();

  for (const entry of entries) {
    if (entry.connectorId) {
      state.targeted.add(entry.connectorId);
    } else {
      state.targeted.add(entry.name);
    }
  }

  await runWithConcurrency(entries, concurrency, async (entry: BundledMcpEntry) => {
    if (!entry.connectorId) {
      console.warn(
        `[harvest:bundled] Could not map bundled MCP "${entry.name}" to a connector-catalog id`,
      );
      state.skipped.add(entry.name);
      return;
    }

    let client: McpTestClient | null = null;
    try {
      client = await createMcpTestClient({
        name: `harvest-bundled-${entry.name}`,
        serverScript: entry.serverScript,
        args: entry.args,
        env: entry.env,
        mockBridgeState: entry.mockBridgeState,
        connectTimeout: entry.timeoutMs,
      });

      const tools = await withTimeout(
        client.listTools(),
        entry.timeoutMs,
        `[bundled:${entry.name}] tools/list timed out after ${entry.timeoutMs}ms`,
      );

      const manifests = normalizeToolManifests(tools);
      if (manifests.length === 0) {
        console.warn(`[harvest:bundled] ${entry.connectorId} returned 0 tools`);
      }

      state.results[entry.connectorId] = manifests;
      state.harvested.add(entry.connectorId);
      state.failed.delete(entry.connectorId);
    } catch (error) {
      console.warn(
        `[harvest:bundled] Failed ${entry.connectorId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      state.failed.add(entry.connectorId);
    } finally {
      if (client) {
        try {
          await client.close();
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  });
}

async function harvestHandwritten(
  state: HarvestState,
  concurrency: number,
): Promise<void> {
  const createMcpTestClient = await getCreateMcpTestClient();

  const entries = discoverHandwrittenMcps();

  for (const entry of entries) {
    if (entry.connectorId) {
      state.targeted.add(entry.connectorId);
    } else {
      state.targeted.add(entry.name);
    }
  }

  await runWithConcurrency(entries, concurrency, async (entry: BundledMcpEntry) => {
    if (!entry.connectorId) {
      console.warn(
        `[harvest:handwritten] Could not map handwritten MCP "${entry.name}" to a connector-catalog id`,
      );
      state.skipped.add(entry.name);
      return;
    }

    let client: McpTestClient | null = null;
    try {
      client = await createMcpTestClient({
        name: `harvest-handwritten-${entry.name}`,
        serverScript: entry.serverScript,
        args: entry.args,
        env: entry.env,
        mockBridgeState: entry.mockBridgeState,
        connectTimeout: entry.timeoutMs,
      });

      const tools = await withTimeout(
        client.listTools(),
        entry.timeoutMs,
        `[handwritten:${entry.name}] tools/list timed out after ${entry.timeoutMs}ms`,
      );

      const manifests = normalizeToolManifests(tools);
      if (manifests.length === 0) {
        console.warn(`[harvest:handwritten] ${entry.connectorId} returned 0 tools`);
      }

      state.results[entry.connectorId] = manifests;
      state.harvested.add(entry.connectorId);
      state.failed.delete(entry.connectorId);
    } catch (error) {
      console.warn(
        `[harvest:handwritten] Failed ${entry.connectorId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      state.failed.add(entry.connectorId);
    } finally {
      if (client) {
        try {
          await client.close();
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  });
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function scoreDirectMatch(
  connector: CatalogConnector,
  packageId: string,
  packageName?: string,
): number {
  const connectorIdLower = connector.id.toLowerCase();
  const connectorNameLower = connector.name.toLowerCase();
  const packageIdLower = packageId.toLowerCase();
  const packageNameLower = packageName?.toLowerCase();

  if (packageIdLower === connectorIdLower) return 100;
  if (packageIdLower.startsWith(`${connectorIdLower}-`)) return 95;

  const withoutDirect = connectorIdLower.endsWith('-direct')
    ? connectorIdLower.slice(0, -'-direct'.length)
    : connectorIdLower;
  if (packageIdLower === withoutDirect) return 94;
  if (packageIdLower.startsWith(`${withoutDirect}-`)) return 93;

  if (packageNameLower && packageNameLower === connectorNameLower) return 92;

  const normalizedPackageId = normalizeToken(packageId);
  const normalizedPackageName = packageName ? normalizeToken(packageName) : undefined;
  const normalizedConnectorId = normalizeToken(connector.id);
  const normalizedConnectorName = normalizeToken(connector.name);

  if (normalizedPackageId === normalizedConnectorId) return 90;
  if (normalizedPackageId === normalizeToken(withoutDirect)) return 89;
  if (normalizedPackageName && normalizedPackageName === normalizedConnectorName) return 88;
  if (normalizedPackageId === normalizedConnectorName) return 87;
  if (normalizedPackageId.startsWith(normalizedConnectorName)) return 80;
  if (normalizedPackageId.startsWith(normalizedConnectorId)) return 79;

  return 0;
}

function matchDirectConnector(
  directConnectors: CatalogConnector[],
  packageInfo: ConnectedToolPackage,
): CatalogConnector | null {
  let bestConnector: CatalogConnector | null = null;
  let bestScore = 0;

  for (const connector of directConnectors) {
    const score = scoreDirectMatch(connector, packageInfo.package_id, packageInfo.name);
    if (score > bestScore) {
      bestScore = score;
      bestConnector = connector;
    }
  }

  return bestScore > 0 ? bestConnector : null;
}

async function listConnectedToolPackages(superMcpUrl: string): Promise<ConnectedToolPackage[]> {
  const client = new Client(SUPER_MCP_CLIENT_INFO);
  const transport = new StreamableHTTPClientTransport(new URL(superMcpUrl));

  try {
    await client.connect(transport);
    const result = await withTimeout(
      client.callTool({
        name: 'list_tool_packages',
        arguments: {
          safe_only: false,
          include_health: false,
        },
      }, undefined, { timeout: DEFAULT_OAUTH_TIMEOUT_MS }),
      DEFAULT_OAUTH_TIMEOUT_MS,
      `list_tool_packages timed out after ${DEFAULT_OAUTH_TIMEOUT_MS}ms`,
    );

    const text = extractTextContent(result, 'list_tool_packages');
    const parsed = JSON.parse(text) as { packages?: ConnectedToolPackage[] };
    if (!Array.isArray(parsed.packages)) {
      throw new Error('Invalid response from list_tool_packages: missing packages array');
    }

    return parsed.packages.filter((pkg) => typeof pkg.package_id === 'string' && pkg.package_id.length > 0);
  } finally {
    try {
      await client.close();
    } catch {
      // Ignore cleanup errors
    }
  }
}

async function listOauthPackageTools(
  superMcpUrl: string,
  packageId: string,
): Promise<ToolManifest[]> {
  const client = new Client(SUPER_MCP_CLIENT_INFO);
  const transport = new StreamableHTTPClientTransport(new URL(superMcpUrl));

  try {
    await client.connect(transport);

    const result = await withTimeout(
      client.callTool({
        name: 'list_tools',
        arguments: {
          package_id: packageId,
          summarize: true,
          include_schemas: false,
        },
      }, undefined, { timeout: DEFAULT_OAUTH_TIMEOUT_MS }),
      DEFAULT_OAUTH_TIMEOUT_MS,
      `[oauth:${packageId}] list_tools timed out after ${DEFAULT_OAUTH_TIMEOUT_MS}ms`,
    );

    const text = extractTextContent(result, 'list_tools');
    const parsed = JSON.parse(text) as {
      tools?: Array<{
        tool_id?: unknown;
        name?: unknown;
        description?: unknown;
        summary?: unknown;
        annotations?: unknown;
      }>;
    };

    if (!Array.isArray(parsed.tools)) {
      throw new Error('Invalid response from list_tools: missing tools array');
    }

    // Super-MCP returns tool_id like "PackageName-account__actual-tool-name".
    // Strip the package prefix (everything before and including "__") to get the
    // canonical tool name as exposed by the upstream MCP server.
    const mapped = parsed.tools.map((tool) => {
      let rawName = String(tool.tool_id ?? tool.name ?? '');
      const separatorIdx = rawName.indexOf('__');
      if (separatorIdx !== -1) {
        rawName = rawName.substring(separatorIdx + 2);
      }
      return {
        name: rawName,
        description: tool.summary ?? tool.description,
        annotations: tool.annotations,
      };
    });

    return normalizeToolManifests(mapped);
  } finally {
    try {
      await client.close();
    } catch {
      // Ignore cleanup errors
    }
  }
}

async function harvestRebelOss(
  catalog: ConnectorCatalog,
  state: HarvestState,
  concurrency: number,
): Promise<void> {
  const createMcpTestClient = await getCreateMcpTestClient();

  const eligible = catalog.connectors.filter(
    (connector) => connector.provider === 'rebel-oss'
      && connector.mcpConfig?.transport === 'stdio'
      && typeof connector.mcpConfig.command === 'string',
  );

  for (const connector of eligible) {
    state.targeted.add(connector.id);
  }

  const entries = discoverRebelOssMcps();

  await runWithConcurrency(entries, concurrency, async (entry: CommunityMcpEntry) => {
    let client: McpTestClient | null = null;

    try {
      client = await createMcpTestClient({
        name: `harvest-rebel-oss-${entry.id}`,
        command: entry.command,
        args: entry.args,
        env: entry.env,
        connectTimeout: entry.timeoutMs,
      });

      const tools = await withTimeout(
        client.listTools(),
        entry.timeoutMs,
        `[rebel-oss:${entry.id}] tools/list timed out after ${entry.timeoutMs}ms`,
      );

      const manifests = normalizeToolManifests(tools);
      if (manifests.length === 0) {
        console.warn(`[harvest:rebel-oss] ${entry.id} returned 0 tools`);
      }

      state.results[entry.id] = manifests;
      state.harvested.add(entry.id);
      state.failed.delete(entry.id);
    } catch (error) {
      console.warn(
        `[harvest:rebel-oss] Failed ${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      state.failed.add(entry.id);
    } finally {
      if (client) {
        try {
          await client.close();
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  });
}

async function harvestOauth(
  options: CliOptions,
  catalog: ConnectorCatalog,
  state: HarvestState,
  concurrency: number,
): Promise<void> {
  if (!options.superMcpUrl) {
    throw new Error('--super-mcp-url is required when using --mode=oauth');
  }

  const directConnectors = catalog.connectors.filter((connector) => connector.provider === 'direct');
  for (const connector of directConnectors) {
    state.targeted.add(connector.id);
  }

  let packages: ConnectedToolPackage[];
  try {
    packages = await listConnectedToolPackages(options.superMcpUrl);
  } catch (error) {
    throw new Error(
      `Unable to connect to Super-MCP at ${options.superMcpUrl}. ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const tasks: Array<{ connectorId: string; packageId: string }> = [];
  for (const pkg of packages) {
    const connector = matchDirectConnector(directConnectors, pkg);
    if (!connector) continue;
    tasks.push({ connectorId: connector.id, packageId: pkg.package_id });
  }

  const successfulConnectors = new Set<string>();
  const failedConnectors = new Set<string>();

  await runWithConcurrency(tasks, concurrency, async (task) => {
    try {
      const manifests = await listOauthPackageTools(options.superMcpUrl!, task.packageId);
      if (manifests.length === 0) {
        console.warn(`[harvest:oauth] ${task.packageId} returned 0 tools`);
      }

      state.results[task.connectorId] = mergeToolManifests(state.results[task.connectorId], manifests);
      successfulConnectors.add(task.connectorId);
    } catch (error) {
      console.warn(
        `[harvest:oauth] Failed ${task.packageId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      failedConnectors.add(task.connectorId);
    }
  });

  for (const connectorId of successfulConnectors) {
    state.harvested.add(connectorId);
    state.failed.delete(connectorId);
  }

  for (const connectorId of failedConnectors) {
    if (!successfulConnectors.has(connectorId)) {
      state.failed.add(connectorId);
    }
  }

  const unavailable = directConnectors
    .map((connector) => connector.id)
    .filter((connectorId) => !successfulConnectors.has(connectorId) && !state.failed.has(connectorId));

  if (unavailable.length > 0) {
    for (const connectorId of unavailable) {
      console.warn(`[harvest:oauth] Not available from Super-MCP: ${connectorId}`);
    }
  }
}

function normalizeExistingTools(tools: ToolManifest[] | undefined): ToolManifest[] {
  if (!Array.isArray(tools)) return [];
  return normalizeToolManifests(tools);
}

function computeDiffs(catalog: ConnectorCatalog, harvestedResults: Record<string, ToolManifest[]>): ConnectorDiff[] {
  const diffs: ConnectorDiff[] = [];

  for (const [connectorId, harvestedTools] of Object.entries(harvestedResults)) {
    const connector = catalog.connectors.find((entry) => entry.id === connectorId);
    if (!connector) continue;

    const existingTools = normalizeExistingTools(connector.tools);

    const existingByName = new Map(existingTools.map((tool) => [tool.name.trim(), trimOptional(tool.description)]));
    const harvestedByName = new Map(harvestedTools.map((tool) => [tool.name.trim(), trimOptional(tool.description)]));

    const added = Array.from(harvestedByName.keys())
      .filter((name) => !existingByName.has(name))
      .sort((a, b) => a.localeCompare(b));

    const removed = Array.from(existingByName.keys())
      .filter((name) => !harvestedByName.has(name))
      .sort((a, b) => a.localeCompare(b));

    const changedDescriptions = Array.from(harvestedByName.keys())
      .filter((name) => existingByName.has(name))
      .map((name) => {
        const before = existingByName.get(name);
        const after = harvestedByName.get(name);
        return { name, before, after };
      })
      .filter(({ before, after }) => before !== after)
      .sort((a, b) => a.name.localeCompare(b.name));

    if (added.length > 0 || removed.length > 0 || changedDescriptions.length > 0) {
      diffs.push({
        connectorId,
        added,
        removed,
        changedDescriptions,
      });
    }
  }

  return diffs.sort((a, b) => a.connectorId.localeCompare(b.connectorId));
}

function formatDiffReport(diffs: ConnectorDiff[]): string {
  if (diffs.length === 0) {
    return 'No tool manifest drift detected.';
  }

  const lines: string[] = ['Tool manifest drift detected:'];
  for (const diff of diffs) {
    lines.push(`\n${diff.connectorId}`);

    for (const added of diff.added) {
      lines.push(`  + ${added}`);
    }

    for (const removed of diff.removed) {
      lines.push(`  - ${removed}`);
    }

    for (const changed of diff.changedDescriptions) {
      const before = changed.before ?? '(none)';
      const after = changed.after ?? '(none)';
      lines.push(`  ~ ${changed.name}`);
      lines.push(`    before: ${before}`);
      lines.push(`    after:  ${after}`);
    }
  }

  return lines.join('\n');
}

function applyWrite(
  catalog: ConnectorCatalog,
  harvestedResults: Record<string, ToolManifest[]>,
): { changedConnectors: string[]; updatedCatalog: ConnectorCatalog } {
  const changedConnectors: string[] = [];

  for (const connector of catalog.connectors) {
    if (!(connector.id in harvestedResults)) continue;

    const nextTools = normalizeToolManifests(harvestedResults[connector.id]);
    const currentTools = normalizeExistingTools(connector.tools);

    const currentJson = JSON.stringify(currentTools);
    const nextJson = JSON.stringify(nextTools);
    if (currentJson === nextJson) continue;

    connector.tools = nextTools;
    changedConnectors.push(connector.id);
  }

  return {
    changedConnectors: changedConnectors.sort((a, b) => a.localeCompare(b)),
    updatedCatalog: catalog,
  };
}

function buildSummary(state: HarvestState): {
  total: number;
  harvested: number;
  failed: number;
  skipped: number;
  missing: number;
} {
  const targeted = Array.from(state.targeted);
  const failedTargeted = targeted.filter((id) => state.failed.has(id));
  const skippedTargeted = targeted.filter((id) => state.skipped.has(id));
  const harvestedTargeted = targeted.filter((id) => state.harvested.has(id));
  const missingTargeted = targeted.filter(
    (id) => !state.harvested.has(id) && !state.failed.has(id) && !state.skipped.has(id),
  );

  return {
    total: targeted.length,
    harvested: harvestedTargeted.length,
    failed: failedTargeted.length,
    skipped: skippedTargeted.length,
    missing: missingTargeted.length,
  };
}

function verifyAnnotations(results: Record<string, ToolManifest[]>): { report: string; missingCount: number } {
  const lines: string[] = [];
  let totalMissing = 0;

  const sortedConnectorIds = Object.keys(results).sort((a, b) => a.localeCompare(b));

  for (const connectorId of sortedConnectorIds) {
    const tools = results[connectorId];
    const missing = tools.filter((tool) => !tool.annotations);
    if (missing.length === 0) continue;

    totalMissing += missing.length;
    lines.push(`\n${connectorId} (${missing.length}/${tools.length} tools missing annotations):`);
    for (const tool of missing) {
      lines.push(`  - ${tool.name}`);
    }
  }

  if (lines.length === 0) {
    return { report: 'All harvested tools have annotations.', missingCount: 0 };
  }

  const header = `Tools missing annotations: ${totalMissing} tool(s) across ${lines.filter((l) => l.startsWith('\n')).length} connector(s)`;
  return { report: `${header}${lines.join('\n')}`, missingCount: totalMissing };
}

function sortResults(results: Record<string, ToolManifest[]>): Record<string, ToolManifest[]> {
  const sortedKeys = Object.keys(results).sort((a, b) => a.localeCompare(b));
  const output: Record<string, ToolManifest[]> = {};
  for (const key of sortedKeys) {
    output[key] = normalizeToolManifests(results[key]);
  }
  return output;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const modes = buildModes(options.mode);
  const concurrency = options.parallel ? 5 : 1;
  const catalog = readCatalog();

  const state: HarvestState = {
    results: {},
    failed: new Set<string>(),
    skipped: new Set<string>(),
    targeted: new Set<string>(),
    harvested: new Set<string>(),
  };

  for (const mode of modes) {
    if (mode === 'community') {
      await harvestCommunity(catalog, state, concurrency);
      continue;
    }

    if (mode === 'bundled') {
      await harvestBundled(state, concurrency);
      continue;
    }

    if (mode === 'handwritten') {
      await harvestHandwritten(state, concurrency);
      continue;
    }

    if (mode === 'oauth') {
      await harvestOauth(options, catalog, state, concurrency);
      continue;
    }

    if (mode === 'rebel-oss') {
      await harvestRebelOss(catalog, state, concurrency);
      continue;
    }
  }

  const sortedResults = sortResults(state.results);
  const sortedFailed = sortedUnique(state.failed);
  const sortedSkipped = sortedUnique(state.skipped);

  const diffs = options.diff ? computeDiffs(catalog, sortedResults) : [];
  const driftDetected = diffs.length > 0;

  if (options.write) {
    const { changedConnectors, updatedCatalog } = applyWrite(catalog, sortedResults);
    if (changedConnectors.length > 0) {
      writeFileSync(CATALOG_PATH, `${JSON.stringify(updatedCatalog, null, 2)}\n`);
      console.error(`Updated connector-catalog.json for ${changedConnectors.length} connector(s):`);
      for (const connectorId of changedConnectors) {
        console.error(`  - ${connectorId}`);
      }
    } else {
      console.error('No connector-catalog.json changes were required.');
    }
  }

  if (options.diff) {
    console.log(formatDiffReport(diffs));
  } else {
    console.log(
      JSON.stringify(
        {
          results: sortedResults,
          failed: sortedFailed,
          skipped: sortedSkipped,
          summary: buildSummary(state),
        },
        null,
        2,
      ),
    );
  }

  if (options.verifyAnnotations) {
    const { report, missingCount } = verifyAnnotations(sortedResults);
    console.error(`\n[verify-annotations] ${report}`);
    if (missingCount > 0) {
      console.error(`\n[verify-annotations] ${missingCount} tool(s) missing annotations — add ToolAnnotations to these tools.`);
    }
  }

  const hasHarvestErrors = sortedFailed.length > 0;
  if (hasHarvestErrors || driftDetected) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
