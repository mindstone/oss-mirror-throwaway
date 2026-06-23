#!/usr/bin/env node

import { exec, execFile } from 'node:child_process';
import type { ChildProcess, ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify, parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { register as registerTsconfigPaths } from 'tsconfig-paths';

type Mode = 'npx' | 'managed';

interface ManagedInstallContext {
  service: import('../src/main/services/managedMcpInstallService').ManagedMcpInstallService;
  installedEntryByPackageSpec: Map<string, string>;
  installMsByWarmupKey: Map<string, number>;
}
type Scenario = 'single' | 'burst5' | 'stress19';
type CacheState = 'cold' | 'warm';
type ReadySignal = 'tools-populated' | 'tools-empty' | 'timeout' | 'connect-error';

interface ConnectorCatalogTool {
  name: string;
}

interface ConnectorCatalogEntry {
  id: string;
  name: string;
  provider: string;
  tools?: ConnectorCatalogTool[];
  bundledConfig?: {
    serverName?: string;
  };
  mcpConfig?: {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  };
}

interface CliArgs {
  modes: Mode[];
  scenarios: Scenario[];
  cacheState: CacheState;
  runs: number;
  warmupDiscard: number;
  connectorIds: string[] | 'all';
  skipConnectorIds: string[];
  measureFirstCall: boolean;
  allowSystemNode: boolean;
  jsonOutPath: string;
  seed: string;
  help: boolean;
}

interface ProcessTreeSnapshot {
  pids: number[];
  rssKb: number;
  procCount: number;
}

interface ConnectorResult {
  mode: Mode;
  scenario: Scenario;
  cacheState: CacheState;
  runIdx: number;
  connectorId: string;
  packageSpec: string;
  spawnToReadyMs: number | null;
  installMs: number | null;
  toolCount: number;
  readySignal: ReadySignal;
  listToolsTimedOut: boolean;
  stderrBytes: number;
  stderrSample: string;
  exitCode: number | null;
  exitSignal: string | null;
  processTreePeak: ProcessTreeSnapshot;
  processTreeFinal: ProcessTreeSnapshot;
  firstCallToolMs: number | null;
  firstCallToolName: string | null;
  errorMessage: string | null;
}

interface BenchmarkRawResult extends ConnectorResult {
  isWarmup: boolean;
}

interface ScenarioSummary {
  p50: number | null;
  p90: number | null;
  p95: number | null;
  max: number | null;
  countOver2000ms: number;
  medianCI95: [number, number] | null;
  failuresByReadySignal: Record<ReadySignal, number>;
  installP50: number | null;
  installMax: number | null;
}

interface BenchmarkOutput {
  meta: {
    timestamp: string;
    platform: NodeJS.Platform;
    nodeVersion: string;
    nodePath: string;
    npmVersion: string;
    isBundledNode: boolean;
    args: {
      modes: Mode[];
      scenarios: Scenario[];
      cacheState: CacheState;
      runs: number;
      warmupDiscard: number;
      connectorIds: string[] | 'all';
      skipConnectorIds: string[];
      measureFirstCall: boolean;
      allowSystemNode: boolean;
      jsonOutPath: string;
    };
    seed: string;
    osInfo: {
      release: string;
      version: string;
      arch: string;
      cpus: number;
      totalMemoryBytes: number;
      hostname: string;
    };
    harnessNodePath: string;
    harnessIsBundledNode: boolean;
  };
  rawResults: BenchmarkRawResult[];
  summary: {
    byScenario: Partial<Record<Scenario, Partial<Record<Mode, ScenarioSummary>>>>;
    caveats: string[];
  };
}

interface SandboxPaths {
  root: string;
  home: string;
  npmCache: string;
  npmUserConfigPath: string;
  npmGlobalConfigPath: string;
  appData: string;
  localAppData: string;
  xdgCacheHome: string;
  mcpBaseDir: string;
  mcpConfigDir: string;
  bridgeStatePath: string;
  managedUserDataPath: string;
}

interface NodeRuntimeInfo {
  benchmarkNodePath: string;
  benchmarkNodeVersion: string;
  benchmarkNpmVersion: string;
  bundledNodePath: string | null;
  bundledNpxCliPath: string | null;
  bundledNpmCliPath: string | null;
  usesBundledNode: boolean;
  harnessNodePath: string;
  harnessIsBundledNode: boolean;
}

interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  packageSpec: string;
}

interface BenchmarkGroup {
  mode: Mode;
  scenario: Scenario;
  runIdx: number;
  connectorIds: string[];
}

interface ResultWithGroup {
  result: ConnectorResult;
  warmupKey: string;
}

type ResolveEnvPlaceholdersOpts = {
  ancestor?: string;
  ancestorDownloadsSubdir?: string;
};
type ResolveEnvPlaceholdersFn = (
  env: Record<string, string>,
  configDir: string,
  baseDir: string,
  opts: ResolveEnvPlaceholdersOpts,
) => Record<string, string>;

type PlatformModule = {
  setPlatformConfig: (config: {
    userDataPath: string;
    appPath: string;
    tempPath: string;
    logsPath: string;
    homePath: string;
    documentsPath: string;
    desktopPath: string;
    appDataPath: string;
    version: string;
    isPackaged: boolean;
    platform: NodeJS.Platform;
    totalMemoryBytes: number;
    arch: string;
    isOss: boolean;
  }) => void;
};

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');

registerTsconfigPaths({
  baseUrl: PROJECT_ROOT,
  paths: {
    '@core/*': ['./src/core/*'],
    '@main/*': ['./src/main/*'],
    '@shared/*': ['./src/shared/*'],
    '@rebel/shared': ['./packages/shared/src'],
    '@rebel/shared/*': ['./packages/shared/src/*'],
    'electron-store': ['./cloud-service/src/electronStoreShim.ts'],
  },
});

const MODES: readonly Mode[] = ['npx', 'managed'] as const;
const SCENARIOS: readonly Scenario[] = ['single', 'burst5', 'stress19'] as const;
const CACHE_STATES: readonly CacheState[] = ['cold', 'warm'] as const;
const SPAWN_THRESHOLD_MS = 2000;
const SAMPLE_INTERVAL_MS = 50;
const SAMPLE_AFTER_READY_MS = 500;
const CONNECT_TIMEOUT_MS = 30_000;
const LIST_TOOLS_TIMEOUT_MS = 10_000;
const FIRST_CALL_TIMEOUT_MS = 30_000;
const STDERR_SAMPLE_LIMIT_BYTES = 500;
const BOOTSTRAP_RESAMPLES = 1000;
const DEFAULT_WARMUP_DISCARD = 1;
const DEFAULT_SCENARIOS: Scenario[] = ['single', 'burst5'];
const DEFAULT_CONNECTOR_SUBSET = [
  'bundled-fathom',
  'bundled-freshdesk',
  'bundled-gamma',
  'bundled-quickbooks',
  'playwright',
];
const BENCH_STUB_CREDENTIAL = 'bench-stub-credential';
const CAVEATS = [
  'Benchmark is single-hop (direct SDK transport); production adds flat Super-MCP HTTP hop overhead — relative deltas preserved, absolute reduced',
  'Playwright first-use dominated by ~200MB browser download, not spawn',
  'First run on freshly-installed bundled node may include macOS Gatekeeper / Windows SmartScreen one-time costs',
];

function printHelp(): void {
  console.log(
    [
      'Usage:',
      '  scripts/benchmark-mcp-spawn.ts \\',
      '    --mode npx|managed[,managed] \\',
      '    --scenarios single,burst5[,stress19] \\',
      '    --cache-state cold|warm \\',
      '    --runs <number> --warmup-discard <number> \\',
      '    --connectors <id1,id2,...>|all \\',
      '    --measure-first-call \\',
      '    --skip-connectors <id1,id2,...> \\',
      '    --allow-system-node \\',
      '    --seed <seed> \\',
      '    --json-out tmp/benchmarks/<name>.json',
      '',
      'Notes:',
      '  - Run via bundled node for production fidelity:',
      process.platform === 'win32'
        ? '      resources\\node-bundle\\node.exe .\\node_modules\\tsx\\dist\\cli.mjs scripts\\benchmark-mcp-spawn.ts ...'
        : '      resources/node-bundle/bin/node ./node_modules/tsx/dist/cli.mjs scripts/benchmark-mcp-spawn.ts ...',
      '  - `--connectors all` benchmarks every rebel-oss connector whose catalog command is `npx`.',
      `  - Default connectors: ${DEFAULT_CONNECTOR_SUBSET.join(', ')}`,
      '  - `managed` mode installs each pinned package once to a sandbox-isolated directory, then spawns node <entry>.',
      '  - `installMs` per result is the time spent on the first install for that (mode, cacheState, connector); idempotent reuses report small values.',
    ].join('\n'),
  );
}

function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function asModeList(value: string | undefined): Mode[] {
  const modes = parseCsv(value);
  if (modes.length === 0) {
    return ['npx'];
  }
  for (const mode of modes) {
    if (!MODES.includes(mode as Mode)) {
      throw new Error(`Invalid --mode value "${mode}". Expected one of: ${MODES.join(', ')}`);
    }
  }
  return modes as Mode[];
}

function asScenarioList(value: string | undefined): Scenario[] {
  const scenarios = parseCsv(value);
  if (scenarios.length === 0) {
    return [...DEFAULT_SCENARIOS];
  }
  for (const scenario of scenarios) {
    if (!SCENARIOS.includes(scenario as Scenario)) {
      throw new Error(`Invalid --scenarios value "${scenario}". Expected one of: ${SCENARIOS.join(', ')}`);
    }
  }
  return scenarios as Scenario[];
}

function asCacheState(value: string | undefined): CacheState {
  const cacheState = value?.trim() ?? 'warm';
  if (!CACHE_STATES.includes(cacheState as CacheState)) {
    throw new Error(`Invalid --cache-state value "${cacheState}". Expected one of: ${CACHE_STATES.join(', ')}`);
  }
  return cacheState as CacheState;
}

function asPositiveInteger(value: string | undefined, flagName: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${flagName} value "${value}". Expected a non-negative integer.`);
  }
  return parsed;
}

function defaultRunsFor(cacheState: CacheState): number {
  if (cacheState === 'cold') {
    return 5;
  }
  return process.platform === 'win32' ? 15 : 8;
}

function parseCliArgs(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      mode: { type: 'string' },
      scenarios: { type: 'string' },
      'cache-state': { type: 'string' },
      runs: { type: 'string' },
      'warmup-discard': { type: 'string' },
      connectors: { type: 'string' },
      'skip-connectors': { type: 'string' },
      'measure-first-call': { type: 'boolean' },
      'allow-system-node': { type: 'boolean' },
      'json-out': { type: 'string' },
      seed: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });

  const help = values.help ?? false;
  const cacheState = asCacheState(values['cache-state']);
  const runId = randomUUID().slice(0, 8);
  const timestampSlug = new Date().toISOString().replace(/[:.]/g, '-');

  return {
    modes: asModeList(values.mode),
    scenarios: asScenarioList(values.scenarios),
    cacheState,
    runs: asPositiveInteger(values.runs, '--runs', defaultRunsFor(cacheState)),
    warmupDiscard: asPositiveInteger(values['warmup-discard'], '--warmup-discard', DEFAULT_WARMUP_DISCARD),
    connectorIds: values.connectors?.trim() === 'all'
      ? 'all'
      : (() => {
          const ids = parseCsv(values.connectors);
          return ids.length > 0 ? ids : [...DEFAULT_CONNECTOR_SUBSET];
        })(),
    skipConnectorIds: parseCsv(values['skip-connectors']),
    measureFirstCall: values['measure-first-call'] ?? false,
    allowSystemNode: values['allow-system-node'] ?? false,
    jsonOutPath: path.resolve(
      process.cwd(),
      values['json-out']?.trim() ?? path.join('tmp', 'benchmarks', `mcp-spawn-${timestampSlug}-${runId}.json`),
    ),
    seed: values.seed?.trim() ?? `${Date.now()}`,
    help,
  };
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createRng(seed: string): () => number {
  let state = hashSeed(seed);
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(items: T[], rng: () => number): void {
  for (let index = items.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
}

function toPercentile(values: number[], percentile: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const position = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1));
  return Math.round(sorted[position]);
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function bootstrapMedianCI(values: number[], seed: string): [number, number] | null {
  if (values.length === 0) {
    return null;
  }
  const rng = createRng(`bootstrap:${seed}:${values.join(',')}`);
  const medians: number[] = [];
  for (let sampleIdx = 0; sampleIdx < BOOTSTRAP_RESAMPLES; sampleIdx++) {
    const sample: number[] = [];
    for (let itemIdx = 0; itemIdx < values.length; itemIdx++) {
      const randomIndex = Math.floor(rng() * values.length);
      sample.push(values[randomIndex]);
    }
    const sampleMedian = median(sample);
    if (sampleMedian !== null) {
      medians.push(sampleMedian);
    }
  }
  medians.sort((left, right) => left - right);
  const lowerIndex = Math.floor((medians.length - 1) * 0.025);
  const upperIndex = Math.floor((medians.length - 1) * 0.975);
  return [Math.round(medians[lowerIndex]), Math.round(medians[upperIndex])];
}

function emptyProcessSnapshot(): ProcessTreeSnapshot {
  return { pids: [], rssKb: 0, procCount: 0 };
}

function choosePeakSnapshot(currentPeak: ProcessTreeSnapshot, candidate: ProcessTreeSnapshot): ProcessTreeSnapshot {
  if (candidate.procCount > currentPeak.procCount) {
    return candidate;
  }
  if (candidate.procCount < currentPeak.procCount) {
    return currentPeak;
  }
  return candidate.rssKb > currentPeak.rssKb ? candidate : currentPeak;
}

function isBundledNodePath(candidatePath: string, bundledNodePath: string | null): boolean {
  if (!bundledNodePath) {
    return false;
  }
  return path.resolve(candidatePath) === path.resolve(bundledNodePath);
}

function resolveBundledNodePaths(projectRoot: string): {
  bundledNodePath: string | null;
  bundledNpmCliPath: string | null;
  bundledNpxCliPath: string | null;
} {
  const bundleDir = path.join(projectRoot, 'resources', 'node-bundle');
  const bundledNodePath = process.platform === 'win32'
    ? path.join(bundleDir, 'node.exe')
    : path.join(bundleDir, 'bin', 'node');

  if (!existsSync(bundledNodePath)) {
    return {
      bundledNodePath: null,
      bundledNpmCliPath: null,
      bundledNpxCliPath: null,
    };
  }

  const bundledNpmCliPath = process.platform === 'win32'
    ? path.join(bundleDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : path.join(bundleDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const bundledNpxCliPath = process.platform === 'win32'
    ? path.join(bundleDir, 'node_modules', 'npm', 'bin', 'npx-cli.js')
    : path.join(bundleDir, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js');

  return {
    bundledNodePath,
    bundledNpmCliPath: existsSync(bundledNpmCliPath) ? bundledNpmCliPath : null,
    bundledNpxCliPath: existsSync(bundledNpxCliPath) ? bundledNpxCliPath : null,
  };
}

async function getCommandVersion(command: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { timeout: 30_000 });
  return stdout.trim();
}

async function resolveNodeRuntimeInfo(args: CliArgs, projectRoot: string): Promise<NodeRuntimeInfo> {
  const { bundledNodePath, bundledNpmCliPath, bundledNpxCliPath } = resolveBundledNodePaths(projectRoot);
  const harnessNodePath = process.execPath;
  const harnessIsBundledNode = isBundledNodePath(harnessNodePath, bundledNodePath);

  if (bundledNodePath && !args.allowSystemNode && !harnessIsBundledNode) {
    throw new Error(
      [
        'Bundled node is available but the benchmark harness is not running under it.',
        'Re-run with the bundled runtime for production fidelity:',
        process.platform === 'win32'
          ? '  resources\\node-bundle\\node.exe .\\node_modules\\tsx\\dist\\cli.mjs scripts\\benchmark-mcp-spawn.ts ...'
          : '  resources/node-bundle/bin/node ./node_modules/tsx/dist/cli.mjs scripts/benchmark-mcp-spawn.ts ...',
        'If you intentionally want to use the system runtime for the harness, add --allow-system-node.',
      ].join('\n'),
    );
  }

  if (!bundledNodePath && !args.allowSystemNode) {
    throw new Error(
      'Bundled node was not found under resources/node-bundle. Add --allow-system-node to benchmark with the system runtime.',
    );
  }

  if (args.allowSystemNode && !harnessIsBundledNode) {
    console.warn(
      [
        'WARNING: --allow-system-node enabled.',
        `Harness runtime: ${harnessNodePath}`,
        bundledNodePath
          ? `Connector child runtime still uses bundled node: ${bundledNodePath}`
          : 'Bundled node not found, so both harness and child processes use the system runtime.',
      ].join('\n'),
    );
  }

  const benchmarkNodePath = bundledNodePath ?? harnessNodePath;
  const benchmarkNodeVersion = await getCommandVersion(benchmarkNodePath, ['--version']);
  const benchmarkNpmVersion = bundledNodePath && bundledNpmCliPath
    ? await getCommandVersion(benchmarkNodePath, [bundledNpmCliPath, '--version'])
    : await getCommandVersion(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version']);

  return {
    benchmarkNodePath,
    benchmarkNodeVersion,
    benchmarkNpmVersion,
    bundledNodePath,
    bundledNpmCliPath,
    bundledNpxCliPath,
    usesBundledNode: bundledNodePath !== null,
    harnessNodePath,
    harnessIsBundledNode,
  };
}

async function initializePlatformConfig(projectRoot: string, benchmarkRoot: string): Promise<void> {
  const platformModule = require('../src/core/platform.ts') as PlatformModule;
  platformModule.setPlatformConfig({
    userDataPath: benchmarkRoot,
    appPath: projectRoot,
    tempPath: os.tmpdir(),
    logsPath: path.join(benchmarkRoot, 'logs'),
    homePath: os.homedir(),
    documentsPath: path.join(os.homedir(), 'Documents'),
    desktopPath: path.join(os.homedir(), 'Desktop'),
    appDataPath: path.join(os.homedir(), '.config'),
    version: '0.0.0-benchmark',
    isPackaged: false,
    platform: process.platform,
    totalMemoryBytes: os.totalmem(),
    arch: process.arch,
    isOss: false,
  });
}

async function loadResolveEnvPlaceholders(): Promise<ResolveEnvPlaceholdersFn> {
  const bundledMcpManagerModule = require('../src/main/services/bundledMcpManager.ts') as {
    resolveEnvPlaceholders: ResolveEnvPlaceholdersFn;
  };
  return bundledMcpManagerModule.resolveEnvPlaceholders;
}

async function readConnectorCatalog(projectRoot: string): Promise<ConnectorCatalogEntry[]> {
  const catalogPath = path.join(projectRoot, 'resources', 'connector-catalog.json');
  const raw = await fs.readFile(catalogPath, 'utf8');
  const parsed = JSON.parse(raw) as { connectors?: ConnectorCatalogEntry[] };
  return parsed.connectors ?? [];
}

function filterEligibleConnectors(catalog: ConnectorCatalogEntry[]): ConnectorCatalogEntry[] {
  return catalog.filter((entry) => entry.provider === 'rebel-oss' && entry.mcpConfig?.command === 'npx');
}

function resolveRequestedConnectors(
  eligibleEntries: ConnectorCatalogEntry[],
  requestedIds: string[] | 'all',
  skipIds: string[],
): ConnectorCatalogEntry[] {
  const eligibleById = new Map(eligibleEntries.map((entry) => [entry.id, entry]));

  let selected = requestedIds === 'all'
    ? [...eligibleEntries]
    : requestedIds.map((connectorId) => {
        const connector = eligibleById.get(connectorId);
        if (!connector) {
          throw new Error(`Unknown or ineligible connector "${connectorId}".`);
        }
        return connector;
      });

  if (skipIds.length > 0) {
    const skipSet = new Set(skipIds);
    selected = selected.filter((entry) => !skipSet.has(entry.id));
  }

  const deduped = new Map<string, ConnectorCatalogEntry>();
  for (const entry of selected) {
    deduped.set(entry.id, entry);
  }

  const connectors = [...deduped.values()];
  if (connectors.length === 0) {
    throw new Error('No connectors selected after applying --connectors / --skip-connectors.');
  }
  return connectors;
}

function validateScenarioCoverage(scenarios: Scenario[], connectorCount: number): void {
  for (const scenario of scenarios) {
    if (scenario === 'single' && connectorCount < 1) {
      throw new Error('Scenario "single" requires at least 1 connector.');
    }
    if (scenario === 'burst5' && connectorCount < 5) {
      throw new Error('Scenario "burst5" requires at least 5 connectors.');
    }
    if (scenario === 'stress19' && connectorCount < 19) {
      throw new Error('Scenario "stress19" requires at least 19 connectors.');
    }
  }
}

function selectRoundRobinWindow<T>(items: T[], startIndex: number, count: number): T[] {
  const selected: T[] = [];
  for (let offset = 0; offset < count; offset++) {
    selected.push(items[(startIndex + offset) % items.length]);
  }
  return selected;
}

function buildBenchmarkGroups(args: CliArgs, connectorIds: string[]): BenchmarkGroup[] {
  const groups: BenchmarkGroup[] = [];
  for (const mode of args.modes) {
    for (const scenario of args.scenarios) {
      for (let runIdx = 0; runIdx < args.runs; runIdx++) {
        let scenarioConnectorIds: string[];
        if (scenario === 'single') {
          scenarioConnectorIds = [connectorIds[runIdx % connectorIds.length]];
        } else if (scenario === 'burst5') {
          scenarioConnectorIds = selectRoundRobinWindow(connectorIds, runIdx * 5, 5);
        } else {
          scenarioConnectorIds = selectRoundRobinWindow(connectorIds, runIdx * 19, 19);
        }
        groups.push({
          mode,
          scenario,
          runIdx: runIdx + 1,
          connectorIds: scenarioConnectorIds,
        });
      }
    }
  }
  return groups;
}

async function ensureDirectory(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureDirectory(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

async function createSandboxPaths(rootDir: string): Promise<SandboxPaths> {
  const sandboxRoot = path.join(rootDir, 'sandbox');
  const home = path.join(sandboxRoot, 'home');
  const npmCache = path.join(home, '.npm');
  const npmUserConfigPath = path.join(home, '.npmrc-user-bench');
  const npmGlobalConfigPath = path.join(home, '.npmrc-global-bench');
  const appData = path.join(home, 'AppData');
  const localAppData = path.join(appData, 'Local');
  const xdgCacheHome = path.join(home, '.cache');
  const mcpBaseDir = path.join(sandboxRoot, 'mcp-base');
  const mcpConfigDir = path.join(sandboxRoot, 'mcp-config');
  const bridgeStatePath = path.join(mcpBaseDir, 'rebel-inbox-bridge.json');
  const managedUserDataPath = path.join(sandboxRoot, 'managed-userdata');

  await Promise.all([
    ensureDirectory(npmCache),
    ensureDirectory(appData),
    ensureDirectory(localAppData),
    ensureDirectory(xdgCacheHome),
    ensureDirectory(mcpBaseDir),
    ensureDirectory(mcpConfigDir),
    ensureDirectory(managedUserDataPath),
  ]);
  await Promise.all([
    fs.writeFile(npmUserConfigPath, ''),
    fs.writeFile(npmGlobalConfigPath, ''),
  ]);
  await fs.writeFile(bridgeStatePath, '{}');

  return {
    root: sandboxRoot,
    home,
    npmCache,
    npmUserConfigPath,
    npmGlobalConfigPath,
    appData,
    localAppData,
    xdgCacheHome,
    mcpBaseDir,
    mcpConfigDir,
    bridgeStatePath,
    managedUserDataPath,
  };
}

async function resetSandbox(paths: SandboxPaths, cacheState: CacheState): Promise<void> {
  if (!existsSync(paths.root)) {
    await createSandboxPaths(path.dirname(paths.root));
    return;
  }

  if (cacheState === 'cold') {
    await fs.rm(paths.root, { recursive: true, force: true });
    await createSandboxPaths(path.dirname(paths.root));
    return;
  }

  const preservedNpmCache = paths.npmCache;
  const tempNpmCache = path.join(path.dirname(paths.root), `.npm-cache-preserve-${randomUUID().slice(0, 8)}`);
  const preservedManagedRoot = paths.managedUserDataPath;
  const tempManagedRoot = path.join(path.dirname(paths.root), `.managed-preserve-${randomUUID().slice(0, 8)}`);

  await ensureDirectory(path.dirname(tempNpmCache));
  if (existsSync(preservedNpmCache)) {
    await fs.rename(preservedNpmCache, tempNpmCache);
  }
  if (existsSync(preservedManagedRoot)) {
    await fs.rename(preservedManagedRoot, tempManagedRoot);
  }

  await fs.rm(paths.root, { recursive: true, force: true });
  await createSandboxPaths(path.dirname(paths.root));

  if (existsSync(tempNpmCache)) {
    await fs.rm(paths.npmCache, { recursive: true, force: true });
    await fs.rename(tempNpmCache, paths.npmCache);
  }
  if (existsSync(tempManagedRoot)) {
    await fs.rm(paths.managedUserDataPath, { recursive: true, force: true });
    await fs.rename(tempManagedRoot, paths.managedUserDataPath);
  }
}

function createSandboxBaseEnv(paths: SandboxPaths, nodeRuntime: NodeRuntimeInfo): Record<string, string> {
  const inheritedPath = process.env.PATH ?? '';
  const bundledNodeDir = nodeRuntime.bundledNodePath ? path.dirname(nodeRuntime.bundledNodePath) : '';
  const pathParts = bundledNodeDir ? [bundledNodeDir, inheritedPath] : [inheritedPath];
  const safePath = pathParts.filter((entry) => entry.length > 0).join(path.delimiter);

  const env: Record<string, string> = {
    ...Object.fromEntries(
      [
        'PATH',
        'SystemRoot',
        'ComSpec',
        'PATHEXT',
        'TMP',
        'TEMP',
        'SHELL',
        'LANG',
        'LC_ALL',
        'LC_CTYPE',
      ]
        .map((key) => [key, process.env[key]])
        .filter(([, value]): value is string => typeof value === 'string' && value.length > 0),
    ),
    PATH: safePath,
    HOME: paths.home,
    USERPROFILE: paths.home,
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
    XDG_CACHE_HOME: paths.xdgCacheHome,
    npm_config_cache: paths.npmCache,
    npm_config_userconfig: paths.npmUserConfigPath,
    npm_config_globalconfig: paths.npmGlobalConfigPath,
    PLAYWRIGHT_BROWSERS_PATH: '0',
  };

  if (process.platform === 'win32') {
    env.TMP = process.env.TMP ?? os.tmpdir();
    env.TEMP = process.env.TEMP ?? os.tmpdir();
  }

  return env;
}

function resolvePlaceholderValue(placeholderName: string, sandbox: SandboxPaths): string {
  if (placeholderName === 'MCP_CONFIG_DIR') {
    return sandbox.mcpConfigDir;
  }
  if (placeholderName === 'MCP_BASE_DIR') {
    return sandbox.mcpBaseDir;
  }
  if (placeholderName === 'BRIDGE_STATE_PATH') {
    return sandbox.bridgeStatePath;
  }
  if (
    /(?:API_KEY|TOKEN|PASSWORD|SECRET|CLIENT_ID|CLIENT_SECRET|REFRESH_TOKEN|ACCESS_KEY)$/i.test(placeholderName)
  ) {
    return BENCH_STUB_CREDENTIAL;
  }
  return BENCH_STUB_CREDENTIAL;
}

function resolveBenchmarkEnv(
  rawEnv: Record<string, string> | undefined,
  sandbox: SandboxPaths,
  resolveEnvPlaceholders: ResolveEnvPlaceholdersFn,
): Record<string, string> {
  // Benchmark contexts have no settings/Spaces in scope; passing `{}` is the
  // correct semantic — placeholders fall back to os.tmpdir(), matching the
  // connector's intrinsic default. Sandbox-bound benchmarks don't exercise
  // workspace-path acceptance so the fallback is harmless here.
  const env = resolveEnvPlaceholders(rawEnv ?? {}, sandbox.mcpConfigDir, sandbox.mcpBaseDir, {});
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    resolved[key] = value.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, placeholderName: string) =>
      resolvePlaceholderValue(placeholderName, sandbox),
    );
  }
  return resolved;
}

function extractPackageSpec(args: string[]): string {
  for (const arg of args) {
    if (!arg.startsWith('-')) {
      return arg;
    }
  }
  throw new Error(`Unable to determine package spec from npx args: ${args.join(' ')}`);
}

function buildLaunchSpec(
  connector: ConnectorCatalogEntry,
  sandbox: SandboxPaths,
  nodeRuntime: NodeRuntimeInfo,
  resolveEnvPlaceholders: ResolveEnvPlaceholdersFn,
  mode: Mode,
  managedEntryPath: string | null,
): LaunchSpec {
  const originalArgs = connector.mcpConfig?.args ?? [];
  const packageSpec = extractPackageSpec(originalArgs);
  const env = {
    ...createSandboxBaseEnv(sandbox, nodeRuntime),
    ...resolveBenchmarkEnv(connector.mcpConfig?.env, sandbox, resolveEnvPlaceholders),
  };

  if (mode === 'managed') {
    if (!nodeRuntime.bundledNodePath) {
      throw new Error('managed mode requires the bundled node runtime (resources/node-bundle)');
    }
    if (!managedEntryPath) {
      throw new Error(`managed mode requires an installed entry path for package ${packageSpec}`);
    }
    return {
      command: nodeRuntime.bundledNodePath,
      args: [managedEntryPath],
      env,
      cwd: sandbox.home,
      packageSpec,
    };
  }

  if (nodeRuntime.bundledNodePath && nodeRuntime.bundledNpxCliPath) {
    return {
      command: nodeRuntime.bundledNodePath,
      args: [nodeRuntime.bundledNpxCliPath, ...originalArgs],
      env,
      cwd: sandbox.home,
      packageSpec,
    };
  }

  return {
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: [...originalArgs],
    env,
    cwd: sandbox.home,
    packageSpec,
  };
}

function buildWarmupKey(mode: Mode, cacheState: CacheState, connectorId: string): string {
  return `${mode}:${cacheState}:${connectorId}`;
}

function createTimeoutError(label: string, timeoutMs: number): Error {
  return new Error(`${label} timed out after ${timeoutMs}ms`);
}

async function withTimeout<T>(
  label: string,
  timeoutMs: number,
  factory: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; timedOut: boolean; error: Error }> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const operationPromise = factory();
  operationPromise.catch(() => {
    // Avoid unhandled rejection noise after Promise.race settles.
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(createTimeoutError(label, timeoutMs)), timeoutMs);
  });

  try {
    const value = await Promise.race([operationPromise, timeoutPromise]);
    return { ok: true, value: value as T };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      ok: false,
      timedOut: err.message.includes('timed out'),
      error: err,
    };
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function mapWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const executing = new Set<Promise<void>>();

  for (let index = 0; index < items.length; index++) {
    const promise = fn(items[index])
      .then((result) => {
        results[index] = result;
      })
      .finally(() => {
        executing.delete(promise);
      });
    executing.add(promise);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

async function listUnixProcesses(): Promise<Array<{ pid: number; ppid: number; rssKb: number }>> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,rss=,comm='], { timeout: 10_000 });
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split(/\s+/, 4);
      return {
        pid: Number.parseInt(parts[0] ?? '', 10),
        ppid: Number.parseInt(parts[1] ?? '', 10),
        rssKb: Number.parseInt(parts[2] ?? '', 10),
      };
    })
    .filter((entry) => Number.isFinite(entry.pid) && Number.isFinite(entry.ppid) && Number.isFinite(entry.rssKb));
}

async function listWindowsProcesses(): Promise<Array<{ pid: number; ppid: number; rssKb: number }>> {
  const { stdout } = await execFileAsync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress',
    ],
    { timeout: 20_000 },
  );
  const parsed = JSON.parse(stdout) as
    | { ProcessId: number; ParentProcessId: number; WorkingSetSize: number | string }
    | Array<{ ProcessId: number; ParentProcessId: number; WorkingSetSize: number | string }>;
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries
    .map((entry) => ({
      pid: Number.parseInt(String(entry.ProcessId), 10),
      ppid: Number.parseInt(String(entry.ParentProcessId), 10),
      rssKb: Math.round(Number.parseInt(String(entry.WorkingSetSize), 10) / 1024),
    }))
    .filter((entry) => Number.isFinite(entry.pid) && Number.isFinite(entry.ppid) && Number.isFinite(entry.rssKb));
}

async function sampleProcessTree(rootPid: number): Promise<ProcessTreeSnapshot> {
  try {
    const processes = process.platform === 'win32'
      ? await listWindowsProcesses()
      : await listUnixProcesses();
    const childrenByParent = new Map<number, number[]>();
    const rssByPid = new Map<number, number>();

    for (const processEntry of processes) {
      const existingChildren = childrenByParent.get(processEntry.ppid) ?? [];
      existingChildren.push(processEntry.pid);
      childrenByParent.set(processEntry.ppid, existingChildren);
      rssByPid.set(processEntry.pid, processEntry.rssKb);
    }

    if (!rssByPid.has(rootPid)) {
      return emptyProcessSnapshot();
    }

    const descendantPids: number[] = [];
    const queue = [rootPid];
    while (queue.length > 0) {
      const currentPid = queue.shift();
      if (currentPid === undefined) {
        continue;
      }
      descendantPids.push(currentPid);
      const childPids = childrenByParent.get(currentPid) ?? [];
      queue.push(...childPids);
    }

    const totalRssKb = descendantPids.reduce((sum, pid) => sum + (rssByPid.get(pid) ?? 0), 0);
    return {
      pids: descendantPids.sort((left, right) => left - right),
      rssKb: totalRssKb,
      procCount: descendantPids.length,
    };
  } catch {
    return emptyProcessSnapshot();
  }
}

class ProcessTreeSampler {
  private stopped = false;

  private inFlight = false;

  private timer: NodeJS.Timeout | null = null;

  private peak = emptyProcessSnapshot();

  private latest = emptyProcessSnapshot();

  constructor(private readonly rootPid: number) {}

  private scheduleNext(): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.captureOnce();
    }, SAMPLE_INTERVAL_MS);
  }

  private async captureOnce(): Promise<void> {
    if (this.stopped || this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      const snapshot = await sampleProcessTree(this.rootPid);
      this.latest = snapshot;
      this.peak = choosePeakSnapshot(this.peak, snapshot);
    } finally {
      this.inFlight = false;
      this.scheduleNext();
    }
  }

  async start(): Promise<void> {
    await this.captureOnce();
  }

  async stop(): Promise<{ peak: ProcessTreeSnapshot; final: ProcessTreeSnapshot }> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.inFlight) {
      this.latest = await sampleProcessTree(this.rootPid);
      this.peak = choosePeakSnapshot(this.peak, this.latest);
    }
    return {
      peak: this.peak,
      final: this.latest,
    };
  }
}

async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      exec(`taskkill /pid ${pid} /t /f`, () => resolve());
    });
    return;
  }

  const getAllDescendants = async (parentPid: number, depth = 0): Promise<number[]> => {
    if (depth > 20) {
      return [];
    }
    try {
      const { stdout } = await execAsync(`pgrep -P ${parentPid} 2>/dev/null`);
      const directChildren = stdout
        .trim()
        .split('\n')
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isFinite(value));
      const descendantLists = await Promise.all(
        directChildren.map((childPid) => getAllDescendants(childPid, depth + 1)),
      );
      return [...descendantLists.flat(), ...directChildren];
    } catch {
      return [];
    }
  };

  const descendants = await getAllDescendants(pid);
  for (const descendant of descendants) {
    try {
      process.kill(descendant, 'SIGKILL');
    } catch {
      // Ignore cleanup failures.
    }
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Ignore cleanup failures.
  }
}

function attachStderrCollector(transport: StdioClientTransport): {
  stderrBytesRef: { value: number };
  stderrSampleRef: { value: Buffer };
} {
  const stderrBytesRef = { value: 0 };
  const stderrSampleRef = { value: Buffer.alloc(0) };
  const stderrStream = transport.stderr;
  if (stderrStream) {
    stderrStream.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytesRef.value += buffer.byteLength;
      if (stderrSampleRef.value.byteLength < STDERR_SAMPLE_LIMIT_BYTES) {
        const remaining = STDERR_SAMPLE_LIMIT_BYTES - stderrSampleRef.value.byteLength;
        stderrSampleRef.value = Buffer.concat([
          stderrSampleRef.value,
          buffer.subarray(0, remaining),
        ]);
      }
    });
  }
  return { stderrBytesRef, stderrSampleRef };
}

function getTransportChildProcess(transport: StdioClientTransport): ChildProcess | undefined {
  return (transport as unknown as { _process?: ChildProcess })._process;
}

function pickFirstCallToolName(registeredTools: Tool[], connector: ConnectorCatalogEntry): string | null {
  const preferredTool = registeredTools.find(
    (tool) => !/^(configure_|authenticate_|disconnect_|remove_)/.test(tool.name),
  );
  if (preferredTool) {
    return preferredTool.name;
  }

  if (registeredTools[0]) {
    return registeredTools[0].name;
  }

  const catalogTool = connector.tools?.find(
    (tool) => !/^(configure_|authenticate_|disconnect_|remove_)/.test(tool.name),
  );
  return catalogTool?.name ?? connector.tools?.[0]?.name ?? null;
}

async function waitForTransportPid(transport: StdioClientTransport): Promise<number | null> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const pid = transport.pid;
    if (typeof pid === 'number') {
      return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

async function benchmarkConnector(
  connector: ConnectorCatalogEntry,
  group: BenchmarkGroup,
  cacheState: CacheState,
  launchSpec: LaunchSpec,
  measureFirstCall: boolean,
  installMs: number | null,
): Promise<ResultWithGroup> {
  const startTime = Date.now();
  const client = new Client({ name: `benchmark-${connector.id}`, version: '1.0.0' });

  const needsWindowsHideFix = process.platform === 'win32' && !('type' in process);
  if (needsWindowsHideFix) {
    (process as NodeJS.Process & { type?: string }).type = 'utility';
  }

  const transport = new StdioClientTransport({
    command: launchSpec.command,
    args: launchSpec.args,
    env: launchSpec.env,
    cwd: launchSpec.cwd,
    stderr: 'pipe',
  });

  const { stderrBytesRef, stderrSampleRef } = attachStderrCollector(transport);
  let exitCode: number | null = null;
  let exitSignal: string | null = null;

  let sampler: ProcessTreeSampler | null = null;
  let processTreePeak = emptyProcessSnapshot();
  let processTreeFinal = emptyProcessSnapshot();
  let readySignal: ReadySignal = 'connect-error';
  let listToolsTimedOut = false;
  let spawnToReadyMs: number | null = null;
  let toolCount = 0;
  let firstCallToolMs: number | null = null;
  let firstCallToolName: string | null = null;
  let errorMessage: string | null = null;
  let rootPid: number | null = null;

  try {
    const connectPromise = client.connect(transport);
    rootPid = await waitForTransportPid(transport);
    if (rootPid !== null) {
      const transportProcess = getTransportChildProcess(transport);
      exitCode = transportProcess?.exitCode ?? null;
      exitSignal = transportProcess?.signalCode ?? null;
      transportProcess?.once('exit', (code, signal) => {
        exitCode = code;
        exitSignal = signal;
      });
      sampler = new ProcessTreeSampler(rootPid);
      await sampler.start();
    }

    const connectResult = await withTimeout('connect', CONNECT_TIMEOUT_MS, () => connectPromise);
    if (!connectResult.ok) {
      readySignal = 'connect-error';
      errorMessage = connectResult.error.message;
    } else {
      const listToolsResult = await withTimeout('listTools', LIST_TOOLS_TIMEOUT_MS, () => client.listTools());
      if (!listToolsResult.ok) {
        readySignal = listToolsResult.timedOut ? 'timeout' : 'connect-error';
        listToolsTimedOut = listToolsResult.timedOut;
        errorMessage = listToolsResult.error.message;
      } else {
        const registeredTools = listToolsResult.value.tools;
        toolCount = registeredTools.length;
        spawnToReadyMs = Date.now() - startTime;
        readySignal = registeredTools.length > 0 ? 'tools-populated' : 'tools-empty';
        errorMessage = registeredTools.length > 0 ? null : 'listTools returned zero tools';

        if (measureFirstCall && registeredTools.length > 0) {
          firstCallToolName = pickFirstCallToolName(registeredTools, connector);
          if (firstCallToolName) {
            const callStart = Date.now();
            const callResult = await withTimeout('firstCallTool', FIRST_CALL_TIMEOUT_MS, () =>
              client.callTool({ name: firstCallToolName as string, arguments: {} }),
            );
            if (callResult.ok) {
              firstCallToolMs = Date.now() - callStart;
            } else if (!callResult.timedOut) {
              firstCallToolMs = Date.now() - callStart;
            } else if (!errorMessage) {
              errorMessage = callResult.error.message;
            }
          }
        }
      }
    }

    if (readySignal === 'tools-populated' || readySignal === 'tools-empty') {
      await new Promise((resolve) => setTimeout(resolve, SAMPLE_AFTER_READY_MS));
    }

    if (sampler) {
      const sampling = await sampler.stop();
      processTreePeak = sampling.peak;
      processTreeFinal = sampling.final;
    }

    return {
      result: {
        mode: group.mode,
        scenario: group.scenario,
        cacheState,
        runIdx: group.runIdx,
        connectorId: connector.id,
        packageSpec: launchSpec.packageSpec,
        spawnToReadyMs,
        installMs,
        toolCount,
        readySignal,
        listToolsTimedOut,
        stderrBytes: stderrBytesRef.value,
        stderrSample: stderrSampleRef.value.toString('utf8'),
        exitCode,
        exitSignal,
        processTreePeak,
        processTreeFinal,
        firstCallToolMs,
        firstCallToolName,
        errorMessage,
      },
      warmupKey: buildWarmupKey(group.mode, cacheState, connector.id),
    };
  } finally {
    try {
      if (rootPid !== null) {
        await killProcessTree(rootPid);
      }
    } catch {
      // Best effort cleanup.
    }
    try {
      await client.close();
    } catch {
      // Best effort cleanup.
    }
    if (needsWindowsHideFix) {
      delete (process as NodeJS.Process & { type?: string }).type;
    }
  }
}

function createManagedInstallContextFactory(
  sandbox: SandboxPaths,
  nodeRuntime: NodeRuntimeInfo,
): () => Promise<ManagedInstallContext> {
  return async (): Promise<ManagedInstallContext> => {
    const { createManagedMcpInstallService } = await import(
      '../src/main/services/managedMcpInstallService'
    );

    if (!nodeRuntime.bundledNodePath || !nodeRuntime.bundledNpmCliPath) {
      throw new Error(
        'managed mode requires bundled node + bundled npm CLI under resources/node-bundle',
      );
    }

    const bundledNodePath = nodeRuntime.bundledNodePath;
    const bundledNpmCliPath = nodeRuntime.bundledNpmCliPath;

    const wrappedExecFile: typeof execFile = ((
      file: string,
      argsOrOptions?: readonly string[] | ExecFileOptionsWithStringEncoding,
      optionsOrCallback?: ExecFileOptionsWithStringEncoding | ((error: Error | null, stdout: string, stderr: string) => void),
      maybeCallback?: (error: Error | null, stdout: string, stderr: string) => void,
    ): ChildProcess => {
      const normalizedArgs = Array.isArray(argsOrOptions) ? [...argsOrOptions] : [];
      const normalizedOptions = (typeof argsOrOptions === 'object' && !Array.isArray(argsOrOptions)
        ? argsOrOptions
        : typeof optionsOrCallback === 'object'
          ? optionsOrCallback
          : undefined) as ExecFileOptionsWithStringEncoding | undefined;
      const callback = (typeof optionsOrCallback === 'function'
        ? optionsOrCallback
        : maybeCallback) as ((error: Error | null, stdout: string, stderr: string) => void) | undefined;

      const baseName = path.basename(file).toLowerCase();
      const isNpm = baseName === 'npm' || baseName === 'npm.cmd';
      const finalCommand = isNpm ? bundledNodePath : file;
      const finalArgs = isNpm ? [bundledNpmCliPath, ...normalizedArgs] : normalizedArgs;

      const resolvedOptions: ExecFileOptionsWithStringEncoding = {
        encoding: 'utf8',
        ...(normalizedOptions ?? {}),
        env: {
          ...(normalizedOptions?.env ?? process.env),
          npm_config_cache: sandbox.npmCache,
          npm_config_userconfig: sandbox.npmUserConfigPath,
          npm_config_globalconfig: sandbox.npmGlobalConfigPath,
          HOME: sandbox.home,
          USERPROFILE: sandbox.home,
          APPDATA: sandbox.appData,
          LOCALAPPDATA: sandbox.localAppData,
        },
      };

      if (callback) {
        return execFile(finalCommand, finalArgs, resolvedOptions, callback);
      }
      return execFile(finalCommand, finalArgs, resolvedOptions);
    }) as typeof execFile;

    const service = createManagedMcpInstallService({
      userDataPath: sandbox.managedUserDataPath,
      npmPath: 'npm',
      execFile: wrappedExecFile,
    });

    return {
      service,
      installedEntryByPackageSpec: new Map<string, string>(),
      installMsByWarmupKey: new Map<string, number>(),
    };
  };
}

async function ensureManagedInstall(
  context: ManagedInstallContext,
  packageSpec: string,
  warmupKey: string,
): Promise<{ entryPath: string; installMs: number }> {
  const startedAt = Date.now();
  const metadata = await context.service.install({ packageSpec });
  const installMs = Date.now() - startedAt;
  context.installedEntryByPackageSpec.set(packageSpec, metadata.entryPath);
  context.installMsByWarmupKey.set(warmupKey, installMs);
  return { entryPath: metadata.entryPath, installMs };
}

async function executeGroup(
  group: BenchmarkGroup,
  cacheState: CacheState,
  connectorsById: Map<string, ConnectorCatalogEntry>,
  sandbox: SandboxPaths,
  nodeRuntime: NodeRuntimeInfo,
  resolveEnvPlaceholders: ResolveEnvPlaceholdersFn,
  measureFirstCall: boolean,
  managedContext: ManagedInstallContext | null,
): Promise<ResultWithGroup[]> {
  await resetSandbox(sandbox, cacheState);

  const entries = group.connectorIds.map((connectorId) => {
    const connector = connectorsById.get(connectorId);
    if (!connector) {
      throw new Error(`Connector "${connectorId}" disappeared during execution.`);
    }
    return connector;
  });

  const runConnector = async (connector: ConnectorCatalogEntry): Promise<ResultWithGroup> => {
    let managedEntryPath: string | null = null;
    let installMs: number | null = null;

    if (group.mode === 'managed') {
      if (!managedContext) {
        throw new Error('managed mode requires a managed install context');
      }
      const packageSpec = extractPackageSpec(connector.mcpConfig?.args ?? []);
      const warmupKey = buildWarmupKey(group.mode, cacheState, connector.id);
      const installed = await ensureManagedInstall(managedContext, packageSpec, warmupKey);
      managedEntryPath = installed.entryPath;
      installMs = installed.installMs;
    }

    const launchSpec = buildLaunchSpec(
      connector,
      sandbox,
      nodeRuntime,
      resolveEnvPlaceholders,
      group.mode,
      managedEntryPath,
    );
    return benchmarkConnector(connector, group, cacheState, launchSpec, measureFirstCall, installMs);
  };

  if (group.scenario === 'single') {
    return [await runConnector(entries[0])];
  }
  if (group.scenario === 'burst5') {
    return mapWithConcurrencyLimit(entries, 5, runConnector);
  }
  return Promise.all(entries.map(runConnector));
}

function markWarmups(results: ResultWithGroup[], warmupDiscard: number): BenchmarkRawResult[] {
  const warmupCounts = new Map<string, number>();
  return results.map(({ result, warmupKey }) => {
    const nextCount = (warmupCounts.get(warmupKey) ?? 0) + 1;
    warmupCounts.set(warmupKey, nextCount);
    return {
      ...result,
      isWarmup: nextCount <= warmupDiscard,
    };
  });
}

function summarizeResults(rawResults: BenchmarkRawResult[], seed: string): BenchmarkOutput['summary'] {
  const byScenario: Partial<Record<Scenario, Partial<Record<Mode, ScenarioSummary>>>> = {};

  for (const scenario of SCENARIOS) {
    const scenarioResults = rawResults.filter((result) => result.scenario === scenario && !result.isWarmup);
    if (scenarioResults.length === 0) {
      continue;
    }

    byScenario[scenario] = {};
    for (const mode of MODES) {
      const modeResults = scenarioResults.filter((result) => result.mode === mode);
      if (modeResults.length === 0) {
        continue;
      }

      const successfulDurations = modeResults
        .filter((result) => result.readySignal === 'tools-populated' && result.spawnToReadyMs !== null)
        .map((result) => result.spawnToReadyMs as number);

      const installDurations = modeResults
        .filter((result) => result.installMs !== null)
        .map((result) => result.installMs as number);

      const failuresByReadySignal: Record<ReadySignal, number> = {
        'tools-populated': 0,
        'tools-empty': 0,
        timeout: 0,
        'connect-error': 0,
      };

      for (const result of modeResults) {
        failuresByReadySignal[result.readySignal] += 1;
      }

      byScenario[scenario]![mode] = {
        p50: toPercentile(successfulDurations, 50),
        p90: toPercentile(successfulDurations, 90),
        p95: toPercentile(successfulDurations, 95),
        max: successfulDurations.length > 0 ? Math.max(...successfulDurations) : null,
        countOver2000ms: successfulDurations.filter((duration) => duration > SPAWN_THRESHOLD_MS).length,
        medianCI95: bootstrapMedianCI(successfulDurations, `${seed}:${scenario}:${mode}`),
        failuresByReadySignal,
        installP50: toPercentile(installDurations, 50),
        installMax: installDurations.length > 0 ? Math.max(...installDurations) : null,
      };
    }
  }

  return {
    byScenario,
    caveats: [...CAVEATS],
  };
}

function printSummary(summary: BenchmarkOutput['summary'], cacheState: CacheState): void {
  for (const mode of MODES) {
    const rows = SCENARIOS
      .map((scenario) => {
        const scenarioSummary = summary.byScenario[scenario]?.[mode];
        if (!scenarioSummary) {
          return null;
        }
        const failureCount = scenarioSummary.failuresByReadySignal['tools-empty']
          + scenarioSummary.failuresByReadySignal.timeout
          + scenarioSummary.failuresByReadySignal['connect-error'];

        return [
          scenario.padEnd(10),
          String(scenarioSummary.p50 ?? '-').padEnd(6),
          String(scenarioSummary.p90 ?? '-').padEnd(6),
          String(scenarioSummary.p95 ?? '-').padEnd(6),
          String(scenarioSummary.max ?? '-').padEnd(6),
          String(scenarioSummary.countOver2000ms).padEnd(9),
          String(failureCount).padEnd(8),
          String(scenarioSummary.installP50 ?? '-').padEnd(9),
          String(scenarioSummary.installMax ?? '-').padEnd(8),
        ].join('  ');
      })
      .filter((row): row is string => row !== null);

    if (rows.length === 0) {
      continue;
    }

    console.log(`MODE=${mode} CACHE=${cacheState}`);
    console.log('scenario    p50    p90    p95    max    slow>2s  failures  installP50 installMax');
    for (const row of rows) {
      console.log(row);
    }
    console.log('');
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const projectRoot = PROJECT_ROOT;
  const benchmarkRoot = path.join(
    projectRoot,
    'tmp',
    'benchmarks',
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
  );

  await initializePlatformConfig(projectRoot, benchmarkRoot);
  const resolveEnvPlaceholders = await loadResolveEnvPlaceholders();
  const nodeRuntime = await resolveNodeRuntimeInfo(args, projectRoot);
  const catalog = await readConnectorCatalog(projectRoot);
  const eligibleConnectors = filterEligibleConnectors(catalog);
  const selectedConnectors = resolveRequestedConnectors(eligibleConnectors, args.connectorIds, args.skipConnectorIds);
  validateScenarioCoverage(args.scenarios, selectedConnectors.length);

  const connectorsById = new Map(selectedConnectors.map((connector) => [connector.id, connector]));
  const connectorIds = selectedConnectors.map((connector) => connector.id);
  const rng = createRng(args.seed);
  const groups = buildBenchmarkGroups(args, connectorIds);
  shuffleInPlace(groups, rng);

  await ensureDirectory(benchmarkRoot);
  const sandbox = await createSandboxPaths(benchmarkRoot);

  const createManagedContext = createManagedInstallContextFactory(sandbox, nodeRuntime);
  const needsManagedContext = args.modes.includes('managed');
  const managedContext: ManagedInstallContext | null = needsManagedContext
    ? await createManagedContext()
    : null;

  const rawResultsWithGrouping: ResultWithGroup[] = [];
  for (const group of groups) {
    const groupResults = await executeGroup(
      group,
      args.cacheState,
      connectorsById,
      sandbox,
      nodeRuntime,
      resolveEnvPlaceholders,
      args.measureFirstCall,
      managedContext,
    );
    rawResultsWithGrouping.push(...groupResults);
  }

  const rawResults = markWarmups(rawResultsWithGrouping, args.warmupDiscard);
  const output: BenchmarkOutput = {
    meta: {
      timestamp: new Date().toISOString(),
      platform: process.platform,
      nodeVersion: nodeRuntime.benchmarkNodeVersion,
      nodePath: nodeRuntime.benchmarkNodePath,
      npmVersion: nodeRuntime.benchmarkNpmVersion,
      isBundledNode: nodeRuntime.usesBundledNode,
      args: {
        modes: args.modes,
        scenarios: args.scenarios,
        cacheState: args.cacheState,
        runs: args.runs,
        warmupDiscard: args.warmupDiscard,
        connectorIds: args.connectorIds,
        skipConnectorIds: args.skipConnectorIds,
        measureFirstCall: args.measureFirstCall,
        allowSystemNode: args.allowSystemNode,
        jsonOutPath: args.jsonOutPath,
      },
      seed: args.seed,
      osInfo: {
        release: os.release(),
        version: os.version(),
        arch: process.arch,
        cpus: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
        hostname: os.hostname(),
      },
      harnessNodePath: nodeRuntime.harnessNodePath,
      harnessIsBundledNode: nodeRuntime.harnessIsBundledNode,
    },
    rawResults,
    summary: summarizeResults(rawResults, args.seed),
  };

  await writeJsonFile(args.jsonOutPath, output);
  printSummary(output.summary, args.cacheState);
  console.log(`Wrote benchmark JSON to ${args.jsonOutPath}`);
}

void (async () => {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
})();
