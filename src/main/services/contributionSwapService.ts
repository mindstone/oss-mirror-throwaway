/**
 * Contribution Swap Service
 *
 * On app startup, scans all `published` contributions and silently swaps
 * their local custom MCP config entries for the catalog (npx) versions.
 *
 * This handles the gap between a contributed connector getting published
 * (PR merged + npm published + catalog synced) and the user's local config
 * still pointing at the local dev build. The swap is transparent — same
 * server name, same env vars, same identity fields.
 *
 * Precedent: `bundledMcpManager.ts` → `migrateBundledConnectorsToNpx()`
 *
 * @see docs/plans/260415_published_swap_and_hook_defensive.md
 */

import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { getPlatformConfig } from '@core/platform';
import { listContributions } from '@core/services/contributionStore';
import { findCatalogEntry } from '@core/services/connectorCatalogService';
import {
  readMcpServerDetails,
  upsertMcpServerEntry,
} from '@core/services/mcpConfigManager';
import { getSettings } from '@core/services/settingsStore';
import {
  getDeepestCommonAncestor,
  getMcpSandboxAncestorRoots,
} from '@core/services/workspace/trustedFilesystemRoots';
import type { ConnectorCatalogEntry, McpServerUpsertPayload } from '@shared/types';
import type { ConnectorContribution } from '@core/services/contributionTypes';
import { resolveEnvPlaceholders } from './bundledMcpManager';

const log = createScopedLogger({ service: 'contributionSwapService' });

function resolveContributionSwapAncestor(): string | undefined {
  try {
    const settings = getSettings();
    let homePath: string | undefined;
    try {
      homePath = getPlatformConfig().homePath;
    } catch {
      homePath = undefined;
    }
    const coreDirectory = settings.coreDirectory ?? undefined;
    const roots = getMcpSandboxAncestorRoots(settings, {
      ...(homePath ? { homePath } : {}),
      ...(coreDirectory ? { coreDirectory } : {}),
    });
    if (roots.length === 0) return undefined;
    return getDeepestCommonAncestor(roots) ?? undefined;
  } catch {
    return undefined;
  }
}

// ─── Types ──────────────────────────────────────────────────────────

export interface SwapResult {
  contributionId: string;
  connectorName: string;
  swapped: boolean;
  reason?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Check if an MCP config entry already points to an npx/catalog command
 * (i.e., the swap has already happened).
 */
function isAlreadySwapped(
  command: string | null,
  catalogId: string | null,
): boolean {
  if (catalogId) return true;
  if (command === 'npx') return true;
  return false;
}

/**
 * Find a rebel-oss catalog entry matching a connector name.
 * Returns undefined if no match or match is not a rebel-oss entry with valid mcpConfig.
 */
function findRebelOssCatalogEntry(
  connectorName: string,
): ConnectorCatalogEntry | undefined {
  const entry = findCatalogEntry(connectorName);
  if (!entry) return undefined;
  if (entry.provider !== 'rebel-oss') return undefined;
  if (!entry.mcpConfig?.command || !entry.mcpConfig?.args?.length) return undefined;
  // Belt-and-braces against a `hidden: true` entry (used to gate a connector
  // while its npm package is awaiting publish — its `mcpConfig.args` may still
  // contain a placeholder version like `@TODO_VERSION`). Swapping into that
  // config would silently break the user's connector. The schema test in
  // `scripts/__tests__/mcp-catalog-schema.test.ts` enforces placeholder-free
  // args on non-hidden entries; this runtime check closes the loop for the
  // hidden case.
  if (entry.hidden === true) return undefined;
  return entry;
}

/**
 * Merge environment variables with UNION strategy.
 * User values win over catalog defaults for overlapping keys.
 */
function mergeEnvVars(
  existingEnv: Record<string, string> | null,
  catalogEnv: Record<string, string>,
): Record<string, string> | null {
  if (!existingEnv && Object.keys(catalogEnv).length === 0) return null;

  const merged: Record<string, string> = {};

  // Start with catalog env (resolved placeholders)
  for (const [key, value] of Object.entries(catalogEnv)) {
    merged[key] = value;
  }

  // Overlay existing user env — user values win
  if (existingEnv) {
    for (const [key, value] of Object.entries(existingEnv)) {
      merged[key] = value;
    }
  }

  return Object.keys(merged).length > 0 ? merged : null;
}

// ─── Core Logic ─────────────────────────────────────────────────────

/**
 * Attempt to swap a single published contribution's local MCP config
 * entry for the catalog (npx) version.
 */
export async function trySwapSingleContribution(
  contribution: ConnectorContribution,
  configPath: string,
): Promise<SwapResult> {
  const { id: contributionId, connectorName, localServerPath } = contribution;
  const base: Pick<SwapResult, 'contributionId' | 'connectorName'> = {
    contributionId,
    connectorName,
  };

  // Guard: must have connectorName and localServerPath
  if (!connectorName || !localServerPath) {
    return { ...base, swapped: false, reason: 'missing_connector_info' };
  }

  // Read existing MCP config entry
  let existingConfig;
  try {
    existingConfig = await readMcpServerDetails(configPath, connectorName);
  } catch {
    // No config entry — user already removed it
    return { ...base, swapped: false, reason: 'no_config_entry' };
  }

  // Check if already swapped
  if (isAlreadySwapped(existingConfig.command, existingConfig.catalogId ?? null)) {
    return { ...base, swapped: false, reason: 'already_swapped' };
  }

  // Look up catalog entry
  const catalogEntry = findRebelOssCatalogEntry(connectorName);
  if (!catalogEntry || !catalogEntry.mcpConfig) {
    return { ...base, swapped: false, reason: 'no_catalog_match' };
  }

  // Log old config for backup/debugging
  log.info(
    {
      contributionId,
      connectorName,
      oldCommand: existingConfig.command,
      oldArgs: existingConfig.args,
    },
    'Swapping published contribution from local to catalog config',
  );

  // Resolve catalog env var placeholders.
  // Note: this site uses `mergeEnvVars` (defined L81) where user always wins,
  // so the F-1 default-only-sandbox-keys hazard does NOT apply here. The
  // ancestor resolution still runs so {{ALLOWED_ROOTS_ANCESTOR}} resolves to a
  // real path rather than leaking through to the spawned subprocess.
  const mcpBaseDir = path.dirname(configPath);
  const serverName = catalogEntry.bundledConfig?.serverName ?? catalogEntry.name;
  const configDir = path.join(mcpBaseDir, serverName.toLowerCase());
  const swapAncestor = resolveContributionSwapAncestor();
  const resolvedCatalogEnv = resolveEnvPlaceholders(
    catalogEntry.mcpConfig.env ?? {},
    configDir,
    mcpBaseDir,
    { ...(swapAncestor ? { ancestor: swapAncestor } : {}) },
  );

  // Merge env vars: user values win over catalog defaults
  const mergedEnv = mergeEnvVars(existingConfig.env, resolvedCatalogEnv);

  // Build the new payload preserving identity fields from existing config
  const payload: McpServerUpsertPayload = {
    name: connectorName, // preserve existing server name as key
    transport: catalogEntry.mcpConfig.transport ?? 'stdio',
    command: catalogEntry.mcpConfig.command,
    args: catalogEntry.mcpConfig.args,
    env: mergedEnv,
    headers: existingConfig.headers,
    description: existingConfig.description,
    catalogId: catalogEntry.id,
    email: existingConfig.email,
    workspace: existingConfig.workspace,
    lastConnectedAt: existingConfig.lastConnectedAt,
  };

  // Upsert the new entry
  await upsertMcpServerEntry(configPath, payload);

  log.info(
    { contributionId, connectorName, catalogId: catalogEntry.id },
    'Successfully swapped contribution to catalog config',
  );

  return { ...base, swapped: true };
}

/**
 * Sweep all published contributions and swap any that still point
 * to local dev builds for their catalog (npx) versions.
 *
 * Called on app startup after existing migrations.
 */
export async function sweepPublishedContributions(
  configPath: string,
): Promise<SwapResult[]> {
  const contributions = listContributions();
  const published = contributions.filter((c) => c.status === 'published');

  if (published.length === 0) {
    return [];
  }

  log.info(
    { count: published.length },
    'Sweeping published contributions for swap',
  );

  const results: SwapResult[] = [];

  for (const contribution of published) {
    try {
      const result = await trySwapSingleContribution(contribution, configPath);
      results.push(result);
    } catch (err) {
      log.warn(
        {
          contributionId: contribution.id,
          connectorName: contribution.connectorName,
          err: err instanceof Error ? err.message : String(err),
        },
        'Failed to swap contribution, will retry on next startup',
      );
      results.push({
        contributionId: contribution.id,
        connectorName: contribution.connectorName,
        swapped: false,
        reason: 'error',
      });
    }
  }

  const swapped = results.filter((r) => r.swapped);
  if (swapped.length > 0) {
    log.info(
      { swappedCount: swapped.length, totalCount: results.length },
      'Published contribution swap sweep complete',
    );
  }

  return results;
}
