//
// Startup migration to clean up legacy Klavis configurations.
//
// Runs during app startup, after store migrations, before Super-MCP launch.
// Idempotent and safe to run multiple times.
//
// Slimmed to a data-loss-prevention core. Earlier revisions also scrubbed
// memory files (Chief-of-Staff/*.md) and the tool-usage store, and set a
// `klavisMigrationPending` flag for an in-app banner — those are gone now;
// kept here are only the runtime-safety guarantees that a long-tail user
// jumping from a pre-Klavis-removal build to current main still needs:
//
//   1. Archive `userData/mcp/klavis.json` (with non-Klavis server preservation).
//   2. Strip Klavis URLs / names from `super-mcp-router.json` and
//      `claude_desktop_config.json` so super-mcp doesn't load dead URLs.
//   3. Rewrite `settings.mcpConfigFile` from the legacy `klavis.json` pointer.
//   4. Strip `klavis.json` references from `configPaths`.
//
// Plus: never throw at startup, idempotent, write-failure preservation.
//
// See `src/main/startup/__tests__/klavisMigration.test.ts` for the
// behavioural-contract tests that lock in each guarantee.

import { app } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createScopedLogger } from '@core/logger';
import { getSettings, settingsStore } from '../settingsStore';

const log = createScopedLogger({ service: 'klavisMigration' });

/**
 * Result of running the Klavis migration. Surfaced for diagnostics only —
 * the call site in `src/main/index.ts` discards the return value.
 */
export interface KlavisMigrationResult {
  hadChanges: boolean;
  archivedKlavisJson: boolean;
  serversRemoved: string[];
  configPathsRemoved: string[];
  /** Non-Klavis servers that were migrated from klavis.json to the router config */
  serversMigratedToRouter: string[];
  /** Whether mcpConfigFile setting was updated from klavis.json to router */
  settingsPointerUpdated: boolean;
}

const KLAVIS_URL_PATTERNS = [
  /strata\.klavis\.ai/i,
  /klavis\.ai\/mcp/i,
];

const KLAVIS_SERVER_NAME_PATTERNS = [
  /^klavis-strata$/i,
  /^klavis$/i,
  /^Klavis$/,
  /^Toolbox$/,
];

function isKlavisUrl(url: string | undefined | null): boolean {
  if (!url || typeof url !== 'string') return false;
  return KLAVIS_URL_PATTERNS.some((pattern) => pattern.test(url));
}

function isKlavisServerName(name: string | undefined | null): boolean {
  if (!name || typeof name !== 'string') return false;
  return KLAVIS_SERVER_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

function isKlavisConfigPath(configPath: string | undefined | null): boolean {
  if (!configPath || typeof configPath !== 'string') return false;
  const basename = path.basename(configPath).toLowerCase();
  return basename === 'klavis.json';
}

/**
 * Check if a config path is the legacy klavis.json inside userData/mcp.
 * More restrictive than isKlavisConfigPath - only matches the specific legacy location.
 */
function isLegacyKlavisConfigPath(configPath: string | undefined | null): boolean {
  if (!configPath || typeof configPath !== 'string') return false;

  let normalizedPath = configPath;
  if (normalizedPath.startsWith('~')) {
    normalizedPath = path.join(app.getPath('home'), normalizedPath.slice(1));
  }
  normalizedPath = path.resolve(normalizedPath);

  const userData = app.getPath('userData');
  const legacyKlavisPath = path.resolve(path.join(userData, 'mcp', 'klavis.json'));

  return normalizedPath === legacyKlavisPath;
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    log.warn({ err: error, filePath }, 'Failed to read JSON file');
    return null;
  }
}

async function writeJsonFile(filePath: string, data: Record<string, unknown>): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function getTimestamp(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const MM = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const HH = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${yy}${MM}${dd}_${HH}${mm}`;
}

interface MigrationAttemptResult {
  migratedServers: string[];
  count: number;
  /** false signals "do NOT archive klavis.json" — preserves data for retry. */
  success: boolean;
  error?: string;
}

/**
 * Migrate non-Klavis servers from klavis.json to the router config before archiving.
 *
 * This prevents data loss when klavis.json contains OAuth MCPs (Google Workspace,
 * Slack, etc.) or custom user MCPs that were stored there during the Klavis era.
 *
 * Returns success=false on a write error so the caller refuses to archive
 * klavis.json, preserving the user's data for the next startup retry.
 */
async function migrateNonKlavisServersToRouter(
  mcpDir: string,
  klavisConfig: Record<string, unknown>,
): Promise<MigrationAttemptResult> {
  const mcpServers = klavisConfig.mcpServers;
  if (!mcpServers || typeof mcpServers !== 'object') {
    return { migratedServers: [], count: 0, success: true };
  }

  const { filtered: nonKlavisServers } = filterKlavisServers(mcpServers as Record<string, unknown>);
  const serverNames = Object.keys(nonKlavisServers);

  if (serverNames.length === 0) {
    return { migratedServers: [], count: 0, success: true };
  }

  const routerPath = path.join(mcpDir, 'super-mcp-router.json');
  let routerConfig = await readJsonFile(routerPath);

  if (!routerConfig) {
    routerConfig = { configPaths: [], mcpServers: {} };
  }

  if (!routerConfig.mcpServers || typeof routerConfig.mcpServers !== 'object') {
    routerConfig.mcpServers = {};
  }

  const routerServers = routerConfig.mcpServers as Record<string, unknown>;
  const migratedServers: string[] = [];

  for (const [serverName, serverConfig] of Object.entries(nonKlavisServers)) {
    if (routerServers[serverName]) {
      log.debug({ serverName }, 'Server already exists in router, skipping migration');
      continue;
    }
    routerServers[serverName] = serverConfig;
    migratedServers.push(serverName);
  }

  if (migratedServers.length > 0) {
    try {
      await writeJsonFile(routerPath, routerConfig);
      log.info(
        { migratedServers, routerPath },
        'Migrated non-Klavis servers from klavis.json to router config',
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error({ err: error, routerPath }, 'Failed to write router config during migration');
      return { migratedServers: [], count: 0, success: false, error: errorMessage };
    }
  }

  return { migratedServers, count: migratedServers.length, success: true };
}

/**
 * Archive the legacy klavis.json file if it exists.
 *
 * Migrates any non-Klavis servers (Google Workspace, Slack, custom MCPs) to the
 * router config first; only archives after successful migration. Renames to
 * `klavis.json.deprecated_yyMMdd_HHmm` to preserve for reference.
 */
async function archiveKlavisJsonFile(mcpDir: string): Promise<{
  archived: boolean;
  migratedServers: string[];
}> {
  const klavisPath = path.join(mcpDir, 'klavis.json');
  const timestamp = getTimestamp();
  const archivedPath = path.join(mcpDir, `klavis.json.deprecated_${timestamp}`);

  try {
    const klavisConfig = await readJsonFile(klavisPath);
    if (!klavisConfig) {
      return { archived: false, migratedServers: [] };
    }

    const migrationResult = await migrateNonKlavisServersToRouter(mcpDir, klavisConfig);

    if (!migrationResult.success) {
      log.error(
        { error: migrationResult.error },
        'Aborting klavis.json archive - migration failed, preserving file to prevent data loss',
      );
      return { archived: false, migratedServers: [] };
    }

    if (migrationResult.count > 0) {
      log.info(
        { migratedCount: migrationResult.count, servers: migrationResult.migratedServers },
        'Preserved non-Klavis servers before archiving klavis.json',
      );
    }

    await fs.rename(klavisPath, archivedPath);
    log.info({ from: klavisPath, to: archivedPath }, 'Archived legacy klavis.json file');

    return { archived: true, migratedServers: migrationResult.migratedServers };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { archived: false, migratedServers: [] };
    }
    log.warn({ err: error, path: klavisPath }, 'Failed to archive klavis.json file');
    return { archived: false, migratedServers: [] };
  }
}

function filterKlavisConfigPaths(configPaths: unknown[]): { filtered: string[]; removed: string[] } {
  const removed: string[] = [];
  const filtered: string[] = [];

  for (const p of configPaths) {
    if (typeof p !== 'string') continue;
    if (isKlavisConfigPath(p)) {
      removed.push(p);
    } else {
      filtered.push(p);
    }
  }

  return { filtered, removed };
}

function filterKlavisServers(
  mcpServers: Record<string, unknown>,
): { filtered: Record<string, unknown>; removed: string[] } {
  const removed: string[] = [];
  const filtered: Record<string, unknown> = {};

  for (const [name, config] of Object.entries(mcpServers)) {
    if (isKlavisServerName(name)) {
      removed.push(name);
      continue;
    }

    const serverConfig = config as Record<string, unknown> | null;
    if (serverConfig && typeof serverConfig === 'object') {
      const url = serverConfig.url as string | undefined;
      if (isKlavisUrl(url)) {
        removed.push(name);
        continue;
      }
    }

    filtered[name] = config;
  }

  return { filtered, removed };
}

async function cleanRouterConfig(configPath: string): Promise<{
  configPathsRemoved: string[];
  serversRemoved: string[];
}> {
  const result = {
    configPathsRemoved: [] as string[],
    serversRemoved: [] as string[],
  };

  const config = await readJsonFile(configPath);
  if (!config) {
    return result;
  }

  let modified = false;

  if (Array.isArray(config.configPaths)) {
    const { filtered, removed } = filterKlavisConfigPaths(config.configPaths);
    if (removed.length > 0) {
      config.configPaths = filtered;
      result.configPathsRemoved = removed;
      modified = true;
    }
  }

  if (config.mcpServers && typeof config.mcpServers === 'object') {
    const { filtered, removed } = filterKlavisServers(config.mcpServers as Record<string, unknown>);
    if (removed.length > 0) {
      config.mcpServers = filtered;
      result.serversRemoved = removed;
      modified = true;
    }
  }

  if (modified) {
    try {
      await writeJsonFile(configPath, config);
      log.info(
        {
          configPath,
          configPathsRemoved: result.configPathsRemoved,
          serversRemoved: result.serversRemoved,
        },
        'Cleaned Klavis references from router config',
      );
    } catch (error) {
      log.warn({ err: error, configPath }, 'Failed to write cleaned router config');
    }
  }

  return result;
}

/**
 * Run the Klavis migration.
 *
 * Errors are logged but never thrown — the call site is in the startup hot path
 * and a throw would block app boot.
 */
export async function runKlavisMigration(): Promise<KlavisMigrationResult> {
  const startTime = Date.now();
  log.info('Starting Klavis migration');

  const result: KlavisMigrationResult = {
    hadChanges: false,
    archivedKlavisJson: false,
    serversRemoved: [],
    configPathsRemoved: [],
    serversMigratedToRouter: [],
    settingsPointerUpdated: false,
  };

  try {
    const userData = app.getPath('userData');
    const mcpDir = path.join(userData, 'mcp');

    // 1. Archive klavis.json (after migrating any non-Klavis servers to the router).
    const archiveResult = await archiveKlavisJsonFile(mcpDir);
    result.archivedKlavisJson = archiveResult.archived;
    result.serversMigratedToRouter = archiveResult.migratedServers;

    // 2. Rewrite mcpConfigFile setting if it still points to the legacy klavis.json.
    //    Done regardless of whether we archived (the pointer can be stale from a prior run).
    const settings = getSettings();
    if (isLegacyKlavisConfigPath(settings.mcpConfigFile)) {
      const routerPath = path.join(mcpDir, 'super-mcp-router.json');

      const routerExists = await fs.access(routerPath).then(() => true).catch(() => false);
      if (!routerExists) {
        await writeJsonFile(routerPath, { configPaths: [], mcpServers: {} });
        log.info({ routerPath }, 'Created router config file for settings migration');
      }

      settingsStore.set('mcpConfigFile', routerPath);
      log.info(
        { from: settings.mcpConfigFile, to: routerPath },
        'Updated mcpConfigFile setting from legacy klavis.json to router config',
      );
      result.settingsPointerUpdated = true;
      result.hadChanges = true;
    }

    // 3. Strip Klavis URLs / names / configPaths from router and Claude configs.
    const routerConfigPath = path.join(mcpDir, 'super-mcp-router.json');
    const routerResult = await cleanRouterConfig(routerConfigPath);

    const claudeConfigPath = path.join(mcpDir, 'claude_desktop_config.json');
    const claudeResult = await cleanRouterConfig(claudeConfigPath);

    result.serversRemoved = [
      ...routerResult.serversRemoved,
      ...claudeResult.serversRemoved,
    ];
    result.configPathsRemoved = [
      ...routerResult.configPathsRemoved,
      ...claudeResult.configPathsRemoved,
    ];

    const elapsed = Date.now() - startTime;
    const totalChanges =
      (result.archivedKlavisJson ? 1 : 0) +
      result.configPathsRemoved.length +
      result.serversRemoved.length;

    result.hadChanges = result.hadChanges || totalChanges > 0;

    if (result.hadChanges) {
      log.info(
        {
          elapsedMs: elapsed,
          archivedKlavisJson: result.archivedKlavisJson,
          serversMigratedToRouter: result.serversMigratedToRouter,
          settingsPointerUpdated: result.settingsPointerUpdated,
          routerConfigPathsRemoved: routerResult.configPathsRemoved.length,
          routerServersRemoved: routerResult.serversRemoved.length,
          claudeConfigPathsRemoved: claudeResult.configPathsRemoved.length,
          claudeServersRemoved: claudeResult.serversRemoved.length,
        },
        'Klavis migration completed with changes',
      );
    } else {
      log.debug({ elapsedMs: elapsed }, 'Klavis migration completed (no changes needed)');
    }
  } catch (error) {
    log.error({ err: error }, 'Klavis migration failed - continuing startup');
  }

  return result;
}
