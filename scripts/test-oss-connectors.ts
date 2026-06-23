#!/usr/bin/env -S npx tsx
/**
 * OSS Connector Real-API Test Runner
 *
 * Walks every `provider: "rebel-oss"` connector in
 * `resources/connector-catalog.json`, spawns the real published npm package
 * via `npx` using the exact args from `mcpConfig.args` (no fork between what
 * users get and what we test), hits the real third-party API where credentials
 * are available, and prints a pass/fail report.
 *
 * Serves the mandatory pre-publish live-API verification (Phase C5) documented
 * in `docs/project/MCP_BUNDLED_TO_OSS_MIGRATION.md`. Also useful as an ongoing
 * health monitor for already-published connectors.
 *
 * USAGE
 *   npx tsx scripts/test-oss-connectors.ts [options]
 *
 *   --connector <id>     Run only this connector id (repeatable)
 *   --skip <id>          Skip this connector (repeatable)
 *   --list-only          Just connect + listTools, skip smoke probes
 *   --no-smoke           Same as --list-only (alias)
 *   --require-all        Treat missing credentials as failure instead of skip
 *   --concurrency <n>    Parallel connectors (default: 3)
 *   --timeout <ms>       Per-connector spawn timeout (default: 90000)
 *   --json <path>        Write machine-readable report to file
 *   --env-file <path>    Load extra env vars from a dotenv-style file
 *   --generate-env-example  Regenerate .env.oss-test.example from the catalog
 *   -h, --help           Show this help
 *
 * CREDENTIALS
 *   For each connector with `setupFields`, the runner reads credentials from
 *   env vars in this order:
 *     1. OSS_TEST_<CONNECTOR_ID_UPPER_SNAKE>__<FIELD_ID_UPPER_SNAKE>
 *        e.g. OSS_TEST_BUNDLED_FATHOM__API_KEY
 *     2. The catalog's setupFields[].envVar (legacy compat)
 *        e.g. FATHOM_API_KEY
 *   Missing required fields → skip (or fail, with --require-all).
 *   Values are never logged. See `.env.oss-test.example` for the full list.
 *
 * EXIT CODE
 *   0 if every non-skipped connector passed.
 *   1 if any connector failed.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import { spawnMcpStdioClient, type SpawnedMcpClient } from './lib/mcpStdioClient';
import {
  OSS_CONNECTOR_SMOKE_PROBES,
  OSS_CONNECTORS_WITHOUT_SMOKE_PROBE,
  type OssConnectorSmokeProbe,
} from './lib/ossConnectorSmokeTests';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SetupField {
  id: string;
  label?: string;
  type?: string;
  required?: boolean;
  envVar?: string;
}

interface McpConfigBlock {
  transport?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

interface CatalogEntry {
  id: string;
  name: string;
  provider: string;
  mcpConfig?: McpConfigBlock;
  setupFields?: SetupField[];
  bundledConfig?: { authType?: string };
}

interface Catalog {
  connectors: CatalogEntry[];
}

interface CliArgs {
  connectors: string[];
  skip: string[];
  listOnly: boolean;
  requireAll: boolean;
  concurrency: number;
  timeoutMs: number;
  jsonPath: string | null;
  envFile: string | null;
  generateEnvExample: boolean;
  help: boolean;
}

interface ConnectorResult {
  id: string;
  name: string;
  package: string;
  status: 'pass' | 'fail' | 'skip';
  durationMs: number;
  toolsCount?: number;
  smoke?: {
    tool: string;
    mode: 'ok' | 'error-allowed';
    passed: boolean;
  };
  smokeAvailability: 'tested' | 'registry-none' | 'list-only';
  missingEnv?: string[];
  error?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(__dirname, '..');
const CATALOG_PATH = join(PROJECT_ROOT, 'resources', 'connector-catalog.json');
const ENV_EXAMPLE_PATH = join(PROJECT_ROOT, '.env.oss-test.example');

// ─── Argument parsing ─────────────────────────────────────────────────────────

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    connectors: [],
    skip: [],
    listOnly: false,
    requireAll: false,
    concurrency: 3,
    timeoutMs: 90_000,
    jsonPath: null,
    envFile: null,
    generateEnvExample: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Flag ${flag} requires a value`);
      return v;
    };
    switch (flag) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--connector':
        args.connectors.push(next());
        break;
      case '--skip':
        args.skip.push(next());
        break;
      case '--list-only':
      case '--no-smoke':
        args.listOnly = true;
        break;
      case '--smoke':
        // explicit on — default; kept for symmetry with --no-smoke
        args.listOnly = false;
        break;
      case '--require-all':
        args.requireAll = true;
        break;
      case '--concurrency': {
        const n = Number.parseInt(next(), 10);
        if (!Number.isFinite(n) || n < 1) throw new Error(`--concurrency must be a positive integer`);
        args.concurrency = n;
        break;
      }
      case '--timeout': {
        const n = Number.parseInt(next(), 10);
        if (!Number.isFinite(n) || n < 1) throw new Error(`--timeout must be a positive integer (ms)`);
        args.timeoutMs = n;
        break;
      }
      case '--json':
        args.jsonPath = next();
        break;
      case '--env-file':
        args.envFile = next();
        break;
      case '--generate-env-example':
        args.generateEnvExample = true;
        break;
      default:
        throw new Error(`Unknown flag: ${flag}`);
    }
  }
  return args;
}

function printHelp(): void {
  const lines = readFileSync(__filename, 'utf8').split('\n');
  for (const line of lines) {
    if (line.startsWith(' */')) break;
    if (line.startsWith('#!')) continue;
    if (line.startsWith('/**')) {
      console.log(line.replace(/^\/\*\*\s?/, ''));
      continue;
    }
    if (line.startsWith(' * ') || line.startsWith(' *')) {
      console.log(line.replace(/^ \*\s?/, ''));
      continue;
    }
    break;
  }
}

// ─── .env file loader (dotenv-lite) ───────────────────────────────────────────

function loadEnvFile(path: string): void {
  if (!existsSync(path)) {
    throw new Error(`--env-file path does not exist: ${path}`);
  }
  const content = readFileSync(path, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

// ─── Catalog loader ───────────────────────────────────────────────────────────

function loadCatalog(): CatalogEntry[] {
  const raw = readFileSync(CATALOG_PATH, 'utf8');
  const catalog = JSON.parse(raw) as Catalog;
  return catalog.connectors.filter((c) => c.provider === 'rebel-oss');
}

// ─── Credential resolution ────────────────────────────────────────────────────

function toUpperSnake(s: string): string {
  return s.replace(/[-\s]/g, '_').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

interface CredentialResolution {
  injectedEnv: Record<string, string>;
  missingRequired: string[];
  /**
   * Required fields with no `envVar` in the catalog. These cannot be injected
   * via env, so the runner cannot test them with real credentials — typically
   * file-based credential connectors (Zendesk, Freshdesk) or OAuth.
   */
  uninjectableRequired: string[];
}

function resolveCredentials(entry: CatalogEntry): CredentialResolution {
  const injectedEnv: Record<string, string> = {};
  const missingRequired: string[] = [];
  const uninjectableRequired: string[] = [];

  const setupFields = entry.setupFields ?? [];
  for (const field of setupFields) {
    const required = field.required !== false;
    if (!field.envVar) {
      if (required) uninjectableRequired.push(field.id);
      continue;
    }
    const ossTestKey = `OSS_TEST_${toUpperSnake(entry.id)}__${toUpperSnake(field.id)}`;
    const value = process.env[ossTestKey] ?? process.env[field.envVar];
    if (value && value.length > 0) {
      injectedEnv[field.envVar] = value;
    } else if (required) {
      missingRequired.push(ossTestKey);
    }
  }
  return { injectedEnv, missingRequired, uninjectableRequired };
}

// ─── Env-block placeholder resolution ─────────────────────────────────────────

function resolvePlaceholders(
  envBlock: Record<string, string> | undefined,
  mcpBaseDir: string,
  bridgeStatePath: string,
): Record<string, string> {
  if (!envBlock) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(envBlock)) {
    out[k] = v
      .replace(/\{\{MCP_BASE_DIR\}\}/g, mcpBaseDir)
      .replace(/\{\{MCP_CONFIG_DIR\}\}/g, mcpBaseDir)
      .replace(/\{\{BRIDGE_STATE_PATH\}\}/g, bridgeStatePath);
  }
  return out;
}

interface BaseDirSetup {
  baseDir: string;
  bridgeStatePath: string;
}

function setupMcpBaseDir(connectorId: string): BaseDirSetup {
  const baseDir = join(tmpdir(), `oss-test-${connectorId}-${process.pid}-${Date.now()}`);
  mkdirSync(baseDir, { recursive: true });
  const bridgeStatePath = join(baseDir, 'rebel-inbox-bridge.json');
  writeFileSync(bridgeStatePath, JSON.stringify({ port: 1, token: 'oss-test-harness' }));
  return { baseDir, bridgeStatePath };
}

function buildConnectorSmokeHarnessEnv(
  entry: CatalogEntry,
  mcpBaseDir: string,
): Record<string, string> {
  if (entry.id !== 'bundled-google') {
    return {};
  }

  const credentialsPath =
    process.env.OSS_TEST_BUNDLED_GOOGLE__CREDENTIALS_PATH ??
    process.env.CREDENTIALS_PATH ??
    join(mcpBaseDir, 'google-workspace-credentials');
  const accountsPath =
    process.env.OSS_TEST_BUNDLED_GOOGLE__ACCOUNTS_PATH ??
    process.env.ACCOUNTS_PATH ??
    join(mcpBaseDir, 'google-workspace-accounts.json');

  mkdirSync(credentialsPath, { recursive: true });
  if (!existsSync(accountsPath)) {
    writeFileSync(accountsPath, JSON.stringify({ accounts: [] }));
  }

  return {
    GOOGLE_CLIENT_ID:
      process.env.OSS_TEST_BUNDLED_GOOGLE__GOOGLE_CLIENT_ID ??
      process.env.GOOGLE_CLIENT_ID ??
      'oss-test-client-id',
    GOOGLE_CLIENT_SECRET:
      process.env.OSS_TEST_BUNDLED_GOOGLE__GOOGLE_CLIENT_SECRET ??
      process.env.GOOGLE_CLIENT_SECRET ??
      'oss-test-client-secret',
    ACCOUNTS_PATH: accountsPath,
    CREDENTIALS_PATH: credentialsPath,
  };
}

/**
 * Scrub any injected credential values from an arbitrary error/text payload.
 * Spawned connectors can echo env values into their stdout/stderr — we must
 * never propagate those into our logs or JSON reports.
 */
function scrubCredentials(text: string, injectedValues: string[]): string {
  let out = text;
  for (const v of injectedValues) {
    if (!v || v.length < 4) continue;
    out = out.split(v).join('***');
  }
  return out;
}

// ─── Single-connector runner ──────────────────────────────────────────────────

async function runConnector(
  entry: CatalogEntry,
  args: CliArgs,
): Promise<ConnectorResult> {
  const started = performance.now();
  const packageSpec = entry.mcpConfig?.args?.find((a) => a.startsWith('@')) ?? '(unknown)';

  // Pre-check command shape
  if (!entry.mcpConfig?.command || !entry.mcpConfig.args || entry.mcpConfig.args.length === 0) {
    return {
      id: entry.id,
      name: entry.name,
      package: packageSpec,
      status: 'fail',
      durationMs: 0,
      smokeAvailability: 'list-only',
      error: 'Catalog entry has no usable mcpConfig.command/args',
    };
  }

  // Credential resolution
  const { injectedEnv, missingRequired, uninjectableRequired } = resolveCredentials(entry);
  const missingDescriptors = [...missingRequired];
  if (uninjectableRequired.length > 0) {
    missingDescriptors.push(
      ...uninjectableRequired.map(
        (id) => `<setup-field "${id}" has no envVar — runner cannot inject>`,
      ),
    );
  }
  if (missingDescriptors.length > 0) {
    return {
      id: entry.id,
      name: entry.name,
      package: packageSpec,
      status: args.requireAll ? 'fail' : 'skip',
      durationMs: Math.round(performance.now() - started),
      smokeAvailability: 'list-only',
      missingEnv: missingDescriptors,
      error: args.requireAll
        ? `--require-all set, but credentials are unavailable: ${missingDescriptors.join(', ')}`
        : undefined,
    };
  }

  // Bridge state + env-placeholder resolution
  const { baseDir: mcpBaseDir, bridgeStatePath } = setupMcpBaseDir(entry.id);
  const resolvedCatalogEnv = resolvePlaceholders(entry.mcpConfig.env, mcpBaseDir, bridgeStatePath);
  const smokeHarnessEnv = buildConnectorSmokeHarnessEnv(entry, mcpBaseDir);
  const injectedValues = Object.values({ ...smokeHarnessEnv, ...injectedEnv });

  const finish = (
    status: ConnectorResult['status'],
    extras: Partial<ConnectorResult>,
  ): ConnectorResult => ({
    id: entry.id,
    name: entry.name,
    package: packageSpec,
    status,
    durationMs: Math.round(performance.now() - started),
    smokeAvailability: 'list-only',
    ...extras,
  });

  let client: SpawnedMcpClient | undefined;
  try {
    client = await spawnMcpStdioClient({
      name: entry.id,
      command: entry.mcpConfig.command,
      args: entry.mcpConfig.args,
      env: {
        ...resolvedCatalogEnv,
        ...smokeHarnessEnv,
        ...injectedEnv,
      },
      mockBridgeState: true,
      connectTimeoutMs: args.timeoutMs,
    });

    const tools = await client.listTools();
    if (tools.length === 0) {
      return finish('fail', { error: 'listTools returned 0 tools' });
    }
    const toolsCount = tools.length;

    const probe: OssConnectorSmokeProbe | undefined = OSS_CONNECTOR_SMOKE_PROBES[entry.id];
    let smokeAvailability: ConnectorResult['smokeAvailability'];
    let smoke: ConnectorResult['smoke'];

    if (args.listOnly) {
      smokeAvailability = 'list-only';
    } else if (!probe) {
      if (!OSS_CONNECTORS_WITHOUT_SMOKE_PROBE.has(entry.id)) {
        console.warn(
          `[${entry.id}] No smoke probe registered. Consider adding one in scripts/lib/ossConnectorSmokeTests.ts.`,
        );
      }
      smokeAvailability = 'registry-none';
    } else {
      const toolNames = new Set(tools.map((t) => t.name));
      if (!toolNames.has(probe.tool)) {
        return finish('fail', {
          toolsCount,
          error: `Smoke probe references tool "${probe.tool}" which is not registered by the server.`,
        });
      }
      const probeResult = await client.callToolRaw(probe.tool, probe.args);
      const isError = probeResult.isError === true;
      const passed = probe.mode === 'ok' ? !isError : probeResult.content.length > 0;
      smokeAvailability = 'tested';
      smoke = { tool: probe.tool, mode: probe.mode, passed };
      if (!passed) {
        return finish('fail', {
          toolsCount,
          smoke,
          smokeAvailability,
          error: scrubCredentials(
            `Smoke probe failed in mode=${probe.mode}: ${truncate(probeResult)}`,
            injectedValues,
          ),
        });
      }
    }

    return finish('pass', { toolsCount, smoke, smokeAvailability });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return finish('fail', {
      error: scrubCredentials(message, injectedValues),
    });
  } finally {
    try { await client?.close(); } catch { /* ignore */ }
    try { rmSync(mcpBaseDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function truncate(result: { content: Array<{ type: string; text?: string }> }): string {
  const text = result.content.map((c) => c.text ?? '').join(' ').slice(0, 200);
  return text || '(no text content)';
}

// ─── Concurrency-limited mapper ───────────────────────────────────────────────

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ─── Reporter ─────────────────────────────────────────────────────────────────

function statusBadge(status: ConnectorResult['status']): string {
  switch (status) {
    case 'pass': return '[PASS]';
    case 'fail': return '[FAIL]';
    case 'skip': return '[SKIP]';
  }
}

function printReport(results: ConnectorResult[], totalMs: number): void {
  console.log('');
  console.log('OSS Connector Test Report');
  console.log('─────────────────────────');
  const pad = Math.max(...results.map((r) => r.id.length));
  for (const r of results) {
    const idCol = r.id.padEnd(pad + 2);
    if (r.status === 'skip') {
      const env = (r.missingEnv ?? []).slice(0, 3).join(', ') + (r.missingEnv && r.missingEnv.length > 3 ? ', …' : '');
      console.log(`${statusBadge(r.status)}   ${idCol} missing env: ${env}`);
      continue;
    }
    const timing = `(${(r.durationMs / 1000).toFixed(1)}s)`;
    if (r.status === 'fail') {
      console.log(`${statusBadge(r.status)}   ${idCol} ${r.error ?? 'unknown error'} ${timing}`);
      continue;
    }
    const smokeBit =
      r.smokeAvailability === 'tested' && r.smoke
        ? `smoke=${r.smoke.tool}`
        : r.smokeAvailability === 'registry-none'
        ? 'smoke=none'
        : 'list-only';
    console.log(`${statusBadge(r.status)}   ${idCol} ${smokeBit} ${timing}`);
  }
  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  const skip = results.filter((r) => r.status === 'skip').length;
  console.log('');
  console.log(
    `${results.length} connectors: ${pass} pass, ${skip} skip, ${fail} fail (${(totalMs / 1000).toFixed(1)}s)`,
  );
}

// ─── .env.oss-test.example generator ──────────────────────────────────────────

function generateEnvExample(connectors: CatalogEntry[]): string {
  const lines: string[] = [
    '# .env.oss-test.example — credentials for scripts/test-oss-connectors.ts',
    '# Generated from resources/connector-catalog.json. Regenerate with:',
    '#   npx tsx scripts/test-oss-connectors.ts --generate-env-example',
    '#',
    '# Copy to .env.oss-test (gitignored) and fill in real values. Then run:',
    '#   npm run test:oss-connectors -- --env-file .env.oss-test',
    '#',
    '# Naming convention: OSS_TEST_<connector_id_upper_snake>__<field_id_upper_snake>',
    '# The runner ALSO honours the legacy envVar (e.g., FATHOM_API_KEY) as fallback.',
    '',
  ];
  for (const entry of connectors) {
    const fields = entry.setupFields ?? [];
    const requiredFields = fields.filter((f) => f.envVar && f.required !== false);
    if (requiredFields.length === 0 && fields.length === 0) {
      lines.push(`# ${entry.id} — ${entry.name}: OAuth or host-only, no env credentials.`);
      lines.push('');
      continue;
    }
    lines.push(`# ${entry.id} — ${entry.name}`);
    for (const f of fields) {
      if (!f.envVar) continue;
      const ossKey = `OSS_TEST_${toUpperSnake(entry.id)}__${toUpperSnake(f.id)}`;
      const label = f.label ?? f.id;
      const optional = f.required === false ? ' (optional)' : '';
      lines.push(`# ${label}${optional} — legacy envVar: ${f.envVar}`);
      lines.push(`${ossKey}=`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let cli: CliArgs;
  try {
    cli = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  if (cli.help) {
    printHelp();
    return;
  }
  if (cli.envFile) {
    loadEnvFile(cli.envFile);
  }

  const allConnectors = loadCatalog();

  if (cli.generateEnvExample) {
    const content = generateEnvExample(allConnectors);
    writeFileSync(ENV_EXAMPLE_PATH, content);
    console.log(`Wrote ${ENV_EXAMPLE_PATH} (${allConnectors.length} connectors)`);
    return;
  }

  let selected = allConnectors;
  if (cli.connectors.length > 0) {
    const wanted = new Set(cli.connectors);
    selected = selected.filter((c) => wanted.has(c.id));
    const missing = [...wanted].filter((id) => !selected.some((c) => c.id === id));
    if (missing.length > 0) {
      console.error(`Unknown connector id(s): ${missing.join(', ')}`);
      process.exit(2);
    }
  }
  if (cli.skip.length > 0) {
    const skip = new Set(cli.skip);
    selected = selected.filter((c) => !skip.has(c.id));
  }

  if (selected.length === 0) {
    console.log('No connectors selected.');
    return;
  }

  console.log(`Running ${selected.length} rebel-oss connector(s) with concurrency ${cli.concurrency}...`);
  const startedAll = performance.now();
  const results = await mapWithConcurrency(selected, cli.concurrency, (entry) =>
    runConnector(entry, cli),
  );
  const totalMs = performance.now() - startedAll;

  printReport(results, totalMs);

  if (cli.jsonPath) {
    writeFileSync(
      cli.jsonPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          totalMs: Math.round(totalMs),
          results,
        },
        null,
        2,
      ),
    );
    console.log(`Wrote machine-readable report: ${cli.jsonPath}`);
  }

  const failed = results.filter((r) => r.status === 'fail').length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
