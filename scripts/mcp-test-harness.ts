/**
 * MCP Test Harness — Reusable testing infrastructure for bundled MCP servers.
 *
 * Provides:
 * - `createMcpTestClient()` — spawns an MCP server and connects via the MCP SDK Client
 * - `assertToolsRegistered()` — verifies expected tools are registered with valid schemas
 * - `assertToolReturnsError()` — verifies a tool call returns an error (protocol or app-level)
 * - `runMcpIntegrationSuite()` — declarative integration test runner
 * - `createMockApiServer()` — starts a local HTTP server with declarative route handlers and request log
 * - `createMcpTestClientWithMockApi()` — combines mock server + fetch-redirect wrapper + client creation
 *
 * Usage:
 *   import { createMcpTestClient, assertToolsRegistered } from '../scripts/mcp-test-harness';
 *
 * @see docs/plans/partway/260217_mcp_test_harness.md
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'http';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync, mkdtempSync, renameSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { tmpdir } from 'os';
import { describe, it, expect, afterAll, beforeAll } from 'vitest';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface McpTestConfig {
  /** Name for logging */
  name: string;
  /** Path to server entry (server.cjs or build/index.js). Required unless `command` is set. */
  serverScript?: string;
  /** Custom spawn command (e.g., 'npx', 'uvx'). Defaults to 'node'. */
  command?: string;
  /** CLI args to pass to the server process */
  args?: string[];
  /** Environment variables to pass to the server */
  env?: Record<string, string>;
  /** Whether to create and inject a mock bridge state file */
  mockBridgeState?: boolean;
  /** Expected tool names (pass empty array to skip tool name assertion) */
  expectedTools?: string[];
  /** Connection timeout in ms (default: 10000) */
  connectTimeout?: number;
}

export interface McpTestClient {
  /** List all registered tools */
  listTools(): Promise<Tool[]>;
  /** Call a tool and parse the first text content item as JSON */
  callToolJson<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
  /** Call a tool and get raw text content */
  callToolText(name: string, args?: Record<string, unknown>): Promise<string>;
  /** Call a tool and get the raw CallToolResult (for checking isError) */
  callToolRaw(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  /** Close connection and kill server process */
  close(): Promise<void>;
}

export interface ToolTest {
  /** Tool name to call */
  tool: string;
  /** Arguments to pass ($ prefixed values are replaced with extracted variables) */
  args?: Record<string, unknown>;
  /** true = expect success, false = expect error */
  expectOk?: boolean;
  /** Top-level fields that must exist in the JSON response */
  expectFields?: string[];
  /** Extract a value from the response for use in later tests */
  extractId?: { path: string; as: string };
  /** Skip this test */
  skip?: boolean;
}

export interface McpIntegrationSuiteConfig {
  /** MCP name (used for describe block and server path resolution) */
  name: string;
  /** Env var name for API key (e.g., 'HUMAANS_API_KEY') */
  envKey: string;
  /** For multi-key MCPs (e.g., access + secret key) */
  envKeys?: Record<string, string>;
  /** Override server script path; defaults to mcp-generated/<name>/server.cjs */
  serverScript?: string;
  /** CLI args for the server */
  args?: string[];
  /** Extra environment variables */
  env?: Record<string, string>;
  /** Whether to create and inject a mock bridge state file */
  mockBridgeState?: boolean;
  /** Expected tool names */
  expectedTools: string[];
  /** Tool to call for unconfigured error test */
  unconfiguredTool?: string;
  /** Declarative tool test definitions */
  toolTests: ToolTest[];
}

// ─── Tracked resources for cleanup ────────────────────────────────────────────

const activeClients: Set<McpTestClient> = new Set();
const tempFiles: Set<string> = new Set();

/** Force-close all tracked clients and clean up temp files. Called on process exit. */
function cleanupAll(): void {
  for (const client of activeClients) {
    try {
      // Fire-and-forget close — we're in a cleanup handler
      client.close();
    } catch {
      // Ignore errors during cleanup
    }
  }
  activeClients.clear();

  for (const f of tempFiles) {
    try {
      if (existsSync(f)) unlinkSync(f);
    } catch {
      // Ignore cleanup errors
    }
  }
  tempFiles.clear();
}

// Register process-level cleanup to prevent zombie processes
process.on('exit', cleanupAll);
process.on('SIGINT', () => {
  cleanupAll();
  process.exit(1);
});
process.on('SIGTERM', () => {
  cleanupAll();
  process.exit(1);
});

// ─── Bridge State Mock ────────────────────────────────────────────────────────

/**
 * Create a temporary mock bridge state file.
 * Required for rebel-* MCPs to start — they read this on init but only use it
 * for tool execution, so listTools works fine with mock values.
 */
function createMockBridgeState(): string {
  const bridgePath = join(tmpdir(), `rebel-test-bridge-${process.pid}-${Date.now()}.json`);
  writeFileSync(bridgePath, JSON.stringify({ port: 1, token: 'test-harness' }));
  tempFiles.add(bridgePath);
  return bridgePath;
}

// ─── Project paths ────────────────────────────────────────────────────────────

const PROJECT_ROOT = join(__dirname, '..');
const MCP_GENERATED_DIR = join(PROJECT_ROOT, 'resources', 'mcp-generated');

/** Resolve the default server script path for a given MCP name */
export function resolveServerScript(mcpName: string): string {
  return join(MCP_GENERATED_DIR, mcpName, 'server.cjs');
}

/**
 * `describe` for a bundled-MCP integration suite that spawns the generated
 * `resources/mcp-generated/<name>/server.cjs`.
 *
 * That artifact is gitignored and only produced by `npm run dev` / `npm run
 * build` (via `scripts/build-bundled-mcps.mjs`), so it is absent in a fresh
 * worktree or any checkout that hasn't run those. When it's missing, this
 * SKIPS the suite with a warning instead of letting `beforeAll` spawn `node`
 * against a non-existent path (which surfaces as a confusing
 * "MCP error -32000: Connection closed", because the harness's own existsSync
 * guard is bypassed whenever the suite passes an explicit `command`).
 *
 * Routing every spawn-based bundled-MCP suite through this one chokepoint makes
 * "forgot to guard the build artifact" a non-issue by construction — the same
 * skip-when-unbuilt behaviour `resources/mcp/xero/test-mcp.test.ts` does inline
 * for its own (`build/index.js`) artifact. Pure-unit `describe`s that don't
 * spawn the server should stay on plain `describe` so they keep running.
 */
export function describeBundledMcp(
  mcpName: string,
  suiteName: string,
  fn: () => void,
): void {
  const built = existsSync(resolveServerScript(mcpName));
  if (!built) {
    console.warn(
      `[mcp-test-harness] Skipping "${suiteName}" — ${mcpName} server.cjs not built. ` +
        `resources/mcp-generated/ is gitignored and only populated by predev/prebuild; ` +
        `run "node scripts/build-bundled-mcps.mjs" (or "npm run dev") to build it before testing.`,
    );
  }
  (built ? describe : describe.skip)(suiteName, fn);
}

// ─── Minimal environment for community MCPs ──────────────────────────────────

/** Environment variables safe to inherit for community (untrusted) MCP processes. */
const SAFE_ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'TMPDIR', 'TEMP', 'TMP',
  // Node/npm/Python toolchain
  'NODE_PATH', 'NPM_CONFIG_CACHE', 'npm_config_cache',
  'VIRTUAL_ENV', 'PYTHONPATH',
  // Windows essentials
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'COMSPEC',
  'HOMEDRIVE', 'HOMEPATH', 'ProgramFiles', 'ProgramFiles(x86)',
];

/**
 * Build a minimal environment for spawning community MCP processes.
 * Only inherits safe system variables, preventing developer API keys
 * and credentials from leaking to untrusted third-party packages.
 */
function buildMinimalEnv(): Record<string, string> {
  const minimal: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const val = process.env[key];
    if (val !== undefined) minimal[key] = val;
  }
  return minimal;
}

// ─── Community MCP pre-install ───────────────────────────────────────────────

interface PreInstallResult {
  /** Absolute path to the installed binary (the package's "bin" entry) */
  binPath: string;
  /** Temp directory containing the install (caller should clean up) */
  installDir: string;
}

const COMMUNITY_INSTALL_TIMEOUT_MS = 180_000;
const COMMUNITY_INSTALL_GRAPH_CHECK_TIMEOUT_MS = 15_000;

type NpmLsProblemNode = {
  dependencies?: Record<string, unknown>;
  missing?: unknown;
  invalid?: unknown;
  problems?: unknown;
  error?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function collectDependencyProblems(value: unknown, problems: string[] = []): string[] {
  if (!isRecord(value)) {
    if (typeof value === 'string' && value.includes('UNMET DEPENDENCY')) {
      problems.push(value);
    }
    return problems;
  }

  const node = value as NpmLsProblemNode;
  if (node.missing) problems.push(`missing: ${String(node.missing)}`);
  if (node.invalid) problems.push(`invalid: ${String(node.invalid)}`);

  if (Array.isArray(node.problems)) {
    for (const problem of node.problems) {
      if (problem !== undefined && problem !== null) {
        problems.push(String(problem));
      }
    }
  } else if (typeof node.problems === 'string') {
    problems.push(node.problems);
  }

  if (typeof node.error === 'string') {
    problems.push(node.error);
  } else if (isRecord(node.error)) {
    const summary = node.error.summary;
    const detail = node.error.detail;
    if (typeof summary === 'string') problems.push(summary);
    if (typeof detail === 'string') problems.push(detail);
  }

  if (node.dependencies && isRecord(node.dependencies)) {
    for (const dependency of Object.values(node.dependencies)) {
      collectDependencyProblems(dependency, problems);
    }
  }

  return problems;
}

export function hasDependencyProblems(npmLsJson: unknown): boolean {
  return collectDependencyProblems(npmLsJson).length > 0;
}

function summarizeDependencyProblems(npmLsJson: unknown): string {
  const problems = collectDependencyProblems(npmLsJson);
  if (problems.length === 0) return 'no dependency problems reported';
  return problems.slice(0, 5).join('; ');
}

function bufferToString(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return typeof value === 'string' ? value : '';
}

function parseNpmLsJson(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch (err) {
    throw new Error(`Failed to parse npm ls JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function verifyInstalledDependencyGraph(
  attemptDir: string,
  npmCmd: string,
  isWindows: boolean,
): { ok: true } | { ok: false; summary: string } {
  try {
    const stdout = execFileSync(npmCmd, ['ls', '--all', '--omit=dev', '--json'], {
      cwd: attemptDir,
      stdio: 'pipe',
      timeout: COMMUNITY_INSTALL_GRAPH_CHECK_TIMEOUT_MS,
      env: { ...buildMinimalEnv(), NODE_ENV: 'test' },
      shell: isWindows,
      encoding: 'utf8',
    });
    const npmLsJson = parseNpmLsJson(stdout);
    if (hasDependencyProblems(npmLsJson)) {
      return { ok: false, summary: summarizeDependencyProblems(npmLsJson) };
    }
    return { ok: true };
  } catch (err) {
    const stdout = bufferToString((err as { stdout?: unknown })?.stdout);
    if (stdout.trim()) {
      try {
        const npmLsJson = parseNpmLsJson(stdout);
        const summary = summarizeDependencyProblems(npmLsJson);
        return { ok: false, summary };
      } catch (parseErr) {
        const stderr = bufferToString((err as { stderr?: unknown })?.stderr);
        return {
          ok: false,
          summary: `${parseErr instanceof Error ? parseErr.message : String(parseErr)}${stderr ? `; ${stderr.slice(0, 200)}` : ''}`,
        };
      }
    }

    const stderr = bufferToString((err as { stderr?: unknown })?.stderr);
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, summary: stderr.slice(0, 200) || message };
  }
}

function resolveInstalledPackageBin(installDir: string, packageSpec: string): PreInstallResult {
  // Resolve the binary from the installed package's package.json
  const pkgName = packageSpec.replace(/@[^/]*$/, ''); // strip version suffix
  const pkgJsonPath = join(installDir, 'node_modules', pkgName, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    throw new Error(`Package ${pkgName} not found after install at ${pkgJsonPath}`);
  }

  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  const binEntry = typeof pkgJson.bin === 'string'
    ? pkgJson.bin
    : typeof pkgJson.bin === 'object'
      ? Object.values(pkgJson.bin)[0] as string
      : undefined;

  if (!binEntry) {
    throw new Error(`Package ${pkgName} has no "bin" field in package.json`);
  }

  const binPath = join(installDir, 'node_modules', pkgName, binEntry);
  if (!existsSync(binPath)) {
    throw new Error(`Binary not found at ${binPath}`);
  }

  return { binPath, installDir };
}

function promoteSuccessfulAttempt(baseTempDir: string, attemptDir: string): string {
  const installDir = `${baseTempDir}-install`;
  try {
    renameSync(attemptDir, installDir);
    rmSync(baseTempDir, { recursive: true, force: true });
    return installDir;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[preInstall] Failed to promote successful install directory; returning attempt dir: ${message.slice(0, 200)}`);
    return attemptDir;
  }
}

/**
 * Pre-install a community npm package into a temp directory, with retry.
 *
 * This avoids the Windows npx tar/rmdir race condition (ENOTEMPTY) by
 * separating the install step from execution and retrying on failure.
 */
export async function preInstallCommunityPackage(
  packageSpec: string,
  { maxRetries = 2 }: { maxRetries?: number } = {},
): Promise<PreInstallResult> {
  const baseTempDir = mkdtempSync(join(tmpdir(), 'mcp-test-'));

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const isWindows = process.platform === 'win32';
  let lastProblemSummary = 'no attempts completed';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const attemptDir = join(baseTempDir, `attempt-${attempt}`);
    mkdirSync(attemptDir, { recursive: true });

    // The directory to clean if this attempt fails. Starts as the attempt dir
    // and becomes the promoted install dir once `promoteSuccessfulAttempt` has
    // renamed it — so a later throw (e.g. bin resolution) cleans the dir that
    // actually exists on disk rather than leaking the promoted one.
    let cleanupTarget = attemptDir;

    try {
      writeFileSync(
        join(attemptDir, 'package.json'),
        JSON.stringify({ name: 'mcp-community-install', private: true }, null, 2) + '\n',
      );

      execFileSync(npmCmd, ['install', '--save-exact', '--no-audit', '--no-fund', packageSpec], {
        cwd: attemptDir,
        stdio: 'pipe',
        timeout: COMMUNITY_INSTALL_TIMEOUT_MS,
        env: { ...buildMinimalEnv(), NODE_ENV: 'test' },
        shell: isWindows,
      });

      const graphCheck = verifyInstalledDependencyGraph(attemptDir, npmCmd, isWindows);
      if (!graphCheck.ok) {
        lastProblemSummary = `npm ls reported dependency problems: ${graphCheck.summary}`;
        throw new Error(lastProblemSummary);
      }

      const installDir = promoteSuccessfulAttempt(baseTempDir, attemptDir);
      cleanupTarget = installDir;
      return resolveInstalledPackageBin(installDir, packageSpec);
    } catch (err) {
      const stderr = bufferToString((err as { stderr?: unknown })?.stderr);
      const message = stderr || (err instanceof Error ? err.message : String(err));
      lastProblemSummary = message.slice(0, 500);
      console.warn(`[preInstall] Attempt ${attempt}/${maxRetries} failed for ${packageSpec}: ${message.slice(0, 200)}`);
      try {
        rmSync(cleanupTarget, { recursive: true, force: true });
      } catch (cleanupErr) {
        const cleanupMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        console.warn(`[preInstall] Failed to clean attempt directory ${cleanupTarget}: ${cleanupMessage.slice(0, 200)}`);
      }
    }
  }

  try {
    rmSync(baseTempDir, { recursive: true, force: true });
  } catch (cleanupErr) {
    const cleanupMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
    console.warn(`[preInstall] Failed to clean temp directory ${baseTempDir}: ${cleanupMessage.slice(0, 200)}`);
  }
  throw new Error(`Failed to install ${packageSpec} after ${maxRetries} attempts. Last problem: ${lastProblemSummary}`);
}

// ─── createMcpTestClient ─────────────────────────────────────────────────────

/**
 * Spawn an MCP server and connect via the MCP SDK Client.
 * Fails with a clear error if the server script is not found.
 */
export async function createMcpTestClient(config: McpTestConfig): Promise<McpTestClient> {
  const { name, serverScript, args = [], env = {}, mockBridgeState: needsBridge = false } = config;
  const connectTimeout = config.connectTimeout ?? 10_000;

  // Validate: either command or serverScript must be provided
  if (!config.command && !serverScript) {
    throw new Error(
      `[${name}] Either command or serverScript must be provided`,
    );
  }

  // When using node (no custom command), verify the server script exists
  if (!config.command && serverScript && !existsSync(serverScript)) {
    throw new Error(
      `[${name}] Server script not found: ${serverScript}\n` +
        'Run "node scripts/build-bundled-mcps.mjs" (or "npm run dev") to build MCP bundles before testing.',
    );
  }

  // Resolve spawn command and args
  const spawnCommand = config.command ?? 'node';
  const spawnArgs = config.command
    ? args
    : [serverScript!, ...args];

  // Build environment.
  // For custom commands (community MCPs), use a minimal env to avoid leaking
  // developer credentials to untrusted third-party packages. npx/uvx need
  // PATH, HOME, and a few platform essentials to function.
  const baseEnv = config.command
    ? buildMinimalEnv()
    : { ...(process.env as Record<string, string>) };

  const processEnv: Record<string, string> = {
    ...baseEnv,
    NODE_ENV: 'test',
    ...env,
  };

  if (needsBridge) {
    processEnv.MINDSTONE_REBEL_BRIDGE_STATE = createMockBridgeState();
  }

  const transport = new StdioClientTransport({
    command: spawnCommand,
    args: spawnArgs,
    env: processEnv,
  });

  const client = new Client({ name: `${name}-test`, version: '1.0.0' });

  // Connect with timeout — clean up transport if timeout fires
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const connectPromise = client.connect(transport);
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`[${name}] Connection timeout after ${connectTimeout}ms`)), connectTimeout);
    });

    await Promise.race([connectPromise, timeoutPromise]);
    clearTimeout(timeoutId);
  } catch (err) {
    clearTimeout(timeoutId);
    // Kill the spawned process on failed/timeout connect so it doesn't become a zombie
    try { await transport.close(); } catch { /* ignore cleanup errors */ }
    throw err;
  }

  // Build the test client wrapper
  const testClient: McpTestClient = {
    async listTools(): Promise<Tool[]> {
      const result = await client.listTools();
      return result.tools;
    },

    async callToolJson<T = unknown>(toolName: string, toolArgs?: Record<string, unknown>): Promise<T> {
      const text = await testClient.callToolText(toolName, toolArgs);
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(
          `[${name}] Tool "${toolName}" returned non-JSON response: ${text.slice(0, 200)}`,
        );
      }
    },

    async callToolText(toolName: string, toolArgs?: Record<string, unknown>): Promise<string> {
      const result = await testClient.callToolRaw(toolName, toolArgs);
      const textContent = result.content.find(
        (c): c is { type: 'text'; text: string } => c.type === 'text',
      );
      if (!textContent) {
        throw new Error(
          `[${name}] Tool "${toolName}" returned no text content. Content types: ${result.content.map((c) => c.type).join(', ')}`,
        );
      }
      return textContent.text;
    },

    async callToolRaw(toolName: string, toolArgs?: Record<string, unknown>): Promise<CallToolResult> {
      const result = await client.callTool({
        name: toolName,
        arguments: toolArgs ?? {},
      });
      return result as CallToolResult;
    },

    async close(): Promise<void> {
      activeClients.delete(testClient);
      try {
        await client.close();
      } catch {
        // Ignore close errors — process may already be dead
      }
    },
  };

  activeClients.add(testClient);
  return testClient;
}

// ─── Assertion helpers ────────────────────────────────────────────────────────

/**
 * Assert all expected tools are registered with valid schemas.
 * Verifies each tool has name, description, and inputSchema.
 */
export async function assertToolsRegistered(
  client: McpTestClient,
  expectedTools: string[],
): Promise<void> {
  const tools = await client.listTools();

  // Verify tool count
  expect(tools.length).toBeGreaterThan(0);

  // Verify expected tools are present
  const toolNames = tools.map((t) => t.name);
  for (const expected of expectedTools) {
    expect(toolNames).toContain(expected);
  }

  // Verify each tool has required schema fields
  for (const tool of tools) {
    expect(tool.name).toBeTruthy();
    expect(tool.description).toBeTruthy();
    expect(tool.inputSchema).toBeDefined();
    expect(tool.inputSchema.type).toBe('object');
  }
}

/**
 * Assert a tool call returns an error.
 * Checks BOTH:
 * - MCP protocol level: `isError: true` on the result
 * - Application level: response JSON has `ok: false` or `success: false`
 *
 * Either indicates an error. The assertion passes if at least one is true.
 * Optionally checks that the error message contains a given substring.
 */
export async function assertToolReturnsError(
  client: McpTestClient,
  toolName: string,
  args?: Record<string, unknown>,
  options?: { expectedErrorSubstring?: string },
): Promise<void> {
  const rawResult = await client.callToolRaw(toolName, args);

  // Check protocol-level error
  const isProtocolError = rawResult.isError === true;

  // Check application-level error patterns in text content
  let isAppError = false;
  const textContent = rawResult.content.find(
    (c): c is { type: 'text'; text: string } => c.type === 'text',
  );

  if (textContent) {
    try {
      const parsed = JSON.parse(textContent.text);
      if (parsed.ok === false || parsed.success === false) {
        isAppError = true;
      }
    } catch {
      // Non-JSON text response — not a structured error
    }
  }

  // At least one error indicator must be present
  expect(
    isProtocolError || isAppError,
  ).toBe(true);

  // Optionally check error message content
  if (options?.expectedErrorSubstring) {
    const fullText = textContent?.text ?? '';
    expect(fullText.toLowerCase()).toContain(options.expectedErrorSubstring.toLowerCase());
  }
}

// ─── Variable substitution for declarative tests ──────────────────────────────

/**
 * Replace $-prefixed variable references in tool args with previously extracted values.
 * E.g., { person_id: '$personId' } → { person_id: 'actual-id-123' }
 */
function substituteVars(
  args: Record<string, unknown>,
  vars: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value.startsWith('$')) {
      const varName = value.slice(1);
      if (!(varName in vars)) {
        throw new Error(
          `Variable "${value}" referenced in args but not yet extracted. ` +
            `Available: ${Object.keys(vars).join(', ') || '(none)'}`,
        );
      }
      result[key] = vars[varName];
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Extract a value from a nested object using a dot/bracket path.
 * E.g., 'data[0].id' extracts obj.data[0].id
 */
function extractByPath(obj: unknown, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// ─── Declarative Integration Suite Runner ─────────────────────────────────────

/**
 * Run a full declarative integration test suite for an MCP.
 *
 * Generates Vitest describe/it blocks automatically from config.
 * Integration tests are skipped when the required API key env var is not set.
 *
 * Usage:
 * ```typescript
 * import { runMcpIntegrationSuite } from '../../../scripts/mcp-test-harness';
 *
 * runMcpIntegrationSuite({
 *   name: 'humaans',
 *   envKey: 'HUMAANS_API_KEY',
 *   expectedTools: ['get_humaans_me', ...],
 *   toolTests: [
 *     { tool: 'get_humaans_me', expectOk: true, expectFields: ['id'] },
 *   ],
 * });
 * ```
 */
export function runMcpIntegrationSuite(config: McpIntegrationSuiteConfig): void {
  const {
    name,
    envKey,
    envKeys,
    expectedTools,
    unconfiguredTool,
    toolTests,
    args,
    env,
    mockBridgeState: needsBridge,
  } = config;

  const serverScript = config.serverScript ?? resolveServerScript(name);
  const hasApiKey = !!process.env[envKey] || (envKeys && Object.values(envKeys).every((k) => !!process.env[k]));

  describe(`${name} MCP integration`, () => {
    // ─── Unconfigured tests (always run) ────────────────────────────
    if (unconfiguredTool) {
      describe('unconfigured (no API key)', () => {
        let client: McpTestClient;

        beforeAll(async () => {
          // Strip API key env vars so developer's local keys don't leak in
          const strippedEnv: Record<string, string> = { ...env };
          strippedEnv[envKey] = '';
          if (envKeys) {
            for (const k of Object.values(envKeys)) {
              strippedEnv[k] = '';
            }
          }

          client = await createMcpTestClient({
            name: `${name}-unconfigured`,
            serverScript,
            args,
            env: strippedEnv,
            mockBridgeState: needsBridge,
          });
        });

        afterAll(async () => {
          await client?.close();
        });

        it('should return error when calling tool without credentials', async () => {
          await assertToolReturnsError(client, unconfiguredTool);
        });
      });
    }

    // ─── Configured integration tests (skip without API key) ────────
    const describeConfigured = hasApiKey ? describe : describe.skip;

    describeConfigured('configured (with API key)', () => {
      let client: McpTestClient;
      const extractedVars: Record<string, unknown> = {};

      beforeAll(async () => {
        // Build env with API key(s)
        const clientEnv: Record<string, string> = { ...env };
        if (envKeys) {
          for (const [envVar, envKeyName] of Object.entries(envKeys)) {
            const val = process.env[envKeyName];
            if (val) clientEnv[envVar] = val;
          }
        } else {
          const val = process.env[envKey];
          if (val) clientEnv[envKey] = val;
        }

        client = await createMcpTestClient({
          name: `${name}-configured`,
          serverScript,
          args,
          env: clientEnv,
          mockBridgeState: needsBridge,
        });
      });

      afterAll(async () => {
        await client?.close();
      });

      it('should have all expected tools registered', async () => {
        await assertToolsRegistered(client, expectedTools);
      });

      // Generate a test for each tool test definition
      for (const test of toolTests) {
        const testFn = test.skip ? it.skip : it;
        const label = test.expectOk === false
          ? `${test.tool} should return error`
          : `${test.tool} should succeed`;

        testFn(label, async () => {
          // Substitute variables in args
          const resolvedArgs = test.args ? substituteVars(test.args, extractedVars) : undefined;

          if (test.expectOk === false) {
            await assertToolReturnsError(client, test.tool, resolvedArgs);
            return;
          }

          // Call tool and expect success
          const result = await client.callToolRaw(test.tool, resolvedArgs);
          expect(result.isError).not.toBe(true);

          // Parse JSON response if we need to check fields or extract IDs
          if (test.expectFields || test.extractId) {
            const textContent = result.content.find(
              (c): c is { type: 'text'; text: string } => c.type === 'text',
            );
            expect(textContent).toBeDefined();

            const parsed = JSON.parse(textContent!.text);

            // Check expected fields
            if (test.expectFields) {
              for (const field of test.expectFields) {
                expect(parsed).toHaveProperty(field);
              }
            }

            // Extract ID for chaining
            if (test.extractId) {
              const value = extractByPath(parsed, test.extractId.path);
              expect(value).toBeDefined();
              extractedVars[test.extractId.as] = value;
            }
          }
        });
      }
    });
  });
}

// ─── Mock API Types ───────────────────────────────────────────────────────────

export interface MockRoute {
  /** HTTP method (default: 'GET') */
  method?: string;
  /** URL pathname to match, e.g. '/api/v2/search.json' */
  path: string;
  /** Route handler — static response object or dynamic handler function */
  handler: MockRouteHandler;
}

/** Static response object or async handler function */
export type MockRouteHandler =
  | { status?: number; body: unknown }
  | ((req: MockRequest) => MockRouteResponse | Promise<MockRouteResponse>);

export interface MockRouteResponse {
  /** HTTP status code (default: 200) */
  status?: number;
  /** Response body (will be JSON-stringified unless rawBody is set) */
  body: unknown;
  /** Custom response headers (overrides default Content-Type: application/json) */
  headers?: Record<string, string>;
  /** Raw body string (skips JSON.stringify; useful for non-JSON responses like HTML) */
  rawBody?: string;
}

export interface MockRequest {
  /** HTTP method */
  method: string;
  /** Full URL string */
  url: string;
  /** URL pathname */
  pathname: string;
  /** Parsed query parameters */
  searchParams: URLSearchParams;
  /** Request headers (lowercased keys) */
  headers: Record<string, string>;
  /** Parsed JSON body for POST/PUT/PATCH (null for other methods) */
  body: unknown;
}

export interface MockApiServer {
  /** Port the mock server is listening on */
  port: number;
  /** Log of all received requests */
  requestLog: MockRequest[];
  /** Gracefully close the mock server */
  close(): Promise<void>;
  /** Clear the request log */
  clearLog(): void;
}

export interface MockApiTestConfig extends Omit<McpTestConfig, 'command' | 'args'> {
  /** Path to the MCP server script. Defaults to resolveServerScript(name). */
  serverScript?: string;
  /** Domains to intercept and redirect to the mock server, e.g. ['app.humaans.io'] */
  interceptDomains: string[];
  /** Declarative route definitions for the mock API server */
  routes: MockRoute[];
  /** Temporary config directory (test creates it, harness registers for cleanup) */
  configDir?: string;
}

// ─── Mock API Server ──────────────────────────────────────────────────────────

/**
 * Build a route key from method and pathname for route matching.
 * Format: "GET /api/v2/search.json"
 */
function routeKey(method: string, pathname: string): string {
  return `${method.toUpperCase()} ${pathname}`;
}

/**
 * Read the full request body from an IncomingMessage stream.
 * Returns the raw string body.
 */
function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/**
 * Start a local HTTP server with declarative route handlers and a request log.
 *
 * Routes are matched by `(METHOD, pathname)` tuple. If no route matches,
 * a 404 response is returned. All incoming requests are logged to `requestLog`.
 *
 * @param routes - Array of route definitions
 * @returns A MockApiServer with port, request log, and cleanup handle
 */
export async function createMockApiServer(routes: MockRoute[]): Promise<MockApiServer> {
  // Build route map keyed by "METHOD /path"
  const routeMap = new Map<string, MockRouteHandler>();
  for (const route of routes) {
    const method = (route.method ?? 'GET').toUpperCase();
    const key = routeKey(method, route.path);
    routeMap.set(key, route.handler);
  }

  const requestLog: MockRequest[] = [];

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const method = (req.method || 'GET').toUpperCase();

    // Parse request body for methods that typically have a body
    const hasBody = ['POST', 'PUT', 'PATCH'].includes(method);
    let parsedBody: unknown = null;
    if (hasBody) {
      try {
        const rawBody = await readRequestBody(req);
        if (rawBody.length > 0) {
          parsedBody = JSON.parse(rawBody);
        }
      } catch {
        // Body is not valid JSON or empty — store null
        parsedBody = null;
      }
    }

    // Build and log the mock request
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) {
        headers[key] = Array.isArray(value) ? value.join(', ') : value;
      }
    }

    const mockRequest: MockRequest = {
      method,
      url: req.url || '/',
      pathname: url.pathname,
      searchParams: url.searchParams,
      headers,
      body: parsedBody,
    };
    requestLog.push(mockRequest);

    // Match route
    const key = routeKey(method, url.pathname);
    const handler = routeMap.get(key);

    if (!handler) {
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found', path: url.pathname, method }));
      return;
    }

    try {
      let response: MockRouteResponse;
      if (typeof handler === 'function') {
        response = await handler(mockRequest);
      } else {
        // Static response object
        response = { status: handler.status, body: handler.body };
      }

      res.statusCode = response.status ?? 200;

      if (response.headers) {
        for (const [k, v] of Object.entries(response.headers)) {
          res.setHeader(k, v);
        }
      } else {
        res.setHeader('Content-Type', 'application/json');
      }

      if (response.rawBody !== undefined) {
        res.end(response.rawBody);
      } else {
        res.end(JSON.stringify(response.body));
      }
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({
        error: 'Mock handler error',
        message: err instanceof Error ? err.message : String(err),
      }));
    }
  });

  // Start the server on a random port
  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get mock server address'));
        return;
      }
      resolve(addr.port);
    });
  });

  const mockApi: MockApiServer = {
    port,
    requestLog,
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    clearLog(): void {
      requestLog.length = 0;
    },
  };

  // Track for process-exit cleanup (fire-and-forget close)
  const cleanupClient: McpTestClient = {
    async listTools() { return []; },
    async callToolJson() { return undefined as never; },
    async callToolText() { return ''; },
    async callToolRaw() { return { content: [] } as never; },
    async close() {
      try { server.close(); } catch { /* ignore */ }
      activeClients.delete(cleanupClient);
    },
  };
  activeClients.add(cleanupClient);

  return mockApi;
}

// ─── Mock API Test Client ─────────────────────────────────────────────────────

/**
 * Generate a temporary wrapper script that patches `globalThis.fetch` to redirect
 * requests matching specified domains to the local mock server, then imports
 * the actual MCP server script.
 *
 * @param serverScriptPath - Absolute path to the MCP server entry point
 * @param mockPort - Port of the local mock API server
 * @param interceptDomains - Domains to intercept (e.g. ['app.humaans.io'])
 * @returns Path to the generated wrapper .mjs file
 */
function generateFetchRedirectWrapper(
  serverScriptPath: string,
  mockPort: number,
  interceptDomains: string[],
): string {
  const wrapperPath = join(tmpdir(), `mcp-mock-wrapper-${process.pid}-${Date.now()}.mjs`);

  // Use pathToFileURL for cross-platform path handling
  const serverFileUrl = pathToFileURL(serverScriptPath).href;

  const domainsJson = JSON.stringify(interceptDomains);
  const wrapperCode = [
    `const MOCK_PORT = ${mockPort};`,
    `const DOMAINS = ${domainsJson};`,
    `const _fetch = globalThis.fetch;`,
    `globalThis.fetch = async (input, opts) => {`,
    `  const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);`,
    `  if (DOMAINS.some(d => url.includes(d))) {`,
    `    const u = new URL(url);`,
    `    const newUrl = 'http://127.0.0.1:' + MOCK_PORT + u.pathname + u.search;`,
    `    if (typeof input === 'object' && !(input instanceof URL)) {`,
    `      return _fetch(new Request(newUrl, input), opts);`,
    `    }`,
    `    return _fetch(newUrl, opts);`,
    `  }`,
    `  return _fetch(input, opts);`,
    `};`,
    `await import('${serverFileUrl}');`,
  ].join('\n');

  writeFileSync(wrapperPath, wrapperCode, 'utf-8');
  tempFiles.add(wrapperPath);

  return wrapperPath;
}

/**
 * Create an MCP test client with a mock API server.
 *
 * Combines three steps into one call:
 * 1. Starts a local mock API server with the provided routes
 * 2. Generates a wrapper script that patches `globalThis.fetch` to redirect matching domains
 * 3. Creates an MCP test client that spawns the server via the wrapper
 *
 * @param config - Mock API test configuration
 * @returns Object with `client` (MCP test client) and `mockApi` (mock server handle)
 */
export async function createMcpTestClientWithMockApi(
  config: MockApiTestConfig,
): Promise<{ client: McpTestClient; mockApi: MockApiServer }> {
  const {
    name,
    interceptDomains,
    routes,
    env = {},
    configDir,
    ...restConfig
  } = config;

  const serverScript = config.serverScript ?? resolveServerScript(name);

  // 1. Start mock API server
  const mockApi = await createMockApiServer(routes);

  // 2. Generate wrapper script
  const wrapperPath = generateFetchRedirectWrapper(
    serverScript,
    mockApi.port,
    interceptDomains,
  );

  // 3. Register config dir contents for cleanup if provided
  if (configDir) {
    tempFiles.add(configDir);
  }

  // 4. Create MCP test client using the wrapper
  const client = await createMcpTestClient({
    ...restConfig,
    name,
    command: 'node',
    args: [wrapperPath],
    env,
  });

  return { client, mockApi };
}
